import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrderStatus, PaymentStatus } from '../domain/enums';
import { ORDER_STATUS_CHANGED } from '../domain/log-events';
import { generateOrderId, isValidOrderId } from '../domain/order-id';
import { applyPaymentEvent } from '../domain/payment-policy';
import { canRetryDelivery } from '../domain/state-machine';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { PrismaService } from '../prisma/prisma.service';

export type CreatedOrder = {
  id: string;
  sku: string;
  status: OrderStatus;
  amount: number;
  currency: string;
  code: null;
};

export type OrderDetail = {
  id: string;
  sku: string;
  status: OrderStatus;
  amount: number;
  currency: string;
  code: string | null;
};

type CreateOrderDtoLike = {
  sku: string;
  id?: string;
};

type BufferedApplyState = {
  status: OrderStatus;
  startFulfillment: boolean;
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentService: FulfillmentService,
  ) {}

  async create(dto: CreateOrderDtoLike): Promise<CreatedOrder> {
    const product = await this.prisma.product.findUnique({
      where: { sku: dto.sku },
    });
    if (!product) {
      throw new NotFoundException(`Unknown sku ${dto.sku}`);
    }

    const orderId = this.resolveOrderId(dto.id);

    let created: CreatedOrder;
    let startFulfillment = false;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: orderId } });
        if (existing) {
          throw new ConflictException(`Order ${orderId} already exists`);
        }

        const order = await tx.order.create({
          data: {
            id: orderId,
            sku: product.sku,
            amount: product.price,
            currency: product.currency,
            status: OrderStatus.created,
          },
        });

        const applied = await this.applyBufferedPaymentEvents(tx, order.id);

        const createdOrder: CreatedOrder = {
          id: order.id,
          sku: order.sku,
          status: applied.status,
          amount: order.amount,
          currency: order.currency,
          code: null,
        };

        return {
          order: createdOrder,
          startFulfillment: applied.startFulfillment,
        };
      });

      created = result.order;
      startFulfillment = result.startFulfillment;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Order ${orderId} already exists`);
      }
      throw error;
    }

    if (startFulfillment) {
      await this.tryStartFulfillment(created.id);
    }

    return created;
  }

  async findById(id: string): Promise<OrderDetail> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return this.toOrderDetail(order);
  }

  /**
   * F12: idempotent re-issue from out_of_stock / delivery_failed / stuck delivering.
   * Already-delivered orders return the same code and skip fulfillment.
   */
  async retryDelivery(id: string): Promise<OrderDetail> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    const status = order.status as OrderStatus;

    if (status === OrderStatus.delivered) {
      return this.toOrderDetail(order);
    }

    if (!canRetryDelivery(status)) {
      throw new ConflictException(
        `Order ${id} cannot retry delivery from status ${status}`,
      );
    }

    await this.tryRetryDelivery(id);
    return this.findById(id);
  }

  private resolveOrderId(id: string | undefined): string {
    if (id === undefined || id === '') {
      return generateOrderId();
    }
    if (!isValidOrderId(id)) {
      throw new BadRequestException(`Invalid order id ${id}`);
    }
    return id;
  }

  private async applyBufferedPaymentEvents(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<BufferedApplyState> {
    const pending = await tx.paymentEvent.findMany({
      where: { orderId, processedAt: null },
      orderBy: { eventId: 'asc' },
    });

    let status = OrderStatus.created;
    let startFulfillment = false;
    const processedEventIds = new Set<string>();

    for (const event of pending) {
      const paymentStatus = this.parsePaymentStatus(event.status);
      if (paymentStatus === null) {
        continue;
      }

      const result = applyPaymentEvent({
        event: {
          eventId: event.eventId,
          orderId: event.orderId ?? orderId,
          status: paymentStatus,
        },
        order: { status },
        processedEventIds,
      });

      processedEventIds.add(event.eventId);

      if (result.kind === 'apply') {
        status = result.to;
        await tx.order.update({
          where: { id: orderId },
          data: { status },
        });
        this.logger.log({
          event: ORDER_STATUS_CHANGED,
          orderId,
          from: result.from,
          to: result.to,
        });
        if (result.startFulfillment) {
          startFulfillment = true;
        }
      }

      if (result.kind !== 'buffer') {
        await tx.paymentEvent.update({
          where: { eventId: event.eventId },
          data: { processedAt: new Date() },
        });
      }
    }

    return { status, startFulfillment };
  }

  private parsePaymentStatus(value: string): PaymentStatus | null {
    if (value === PaymentStatus.paid || value === PaymentStatus.failed) {
      return value;
    }
    return null;
  }

  private toOrderDetail(order: {
    id: string;
    sku: string;
    status: string;
    amount: number;
    currency: string;
    code: string | null;
  }): OrderDetail {
    const status = order.status as OrderStatus;
    return {
      id: order.id,
      sku: order.sku,
      status,
      amount: order.amount,
      currency: order.currency,
      code: status === OrderStatus.delivered ? order.code : null,
    };
  }

  /**
   * Persist `paid` first; fulfillment is best-effort until task-030.
   * The stub throws NotImplemented — do not roll back the paid order.
   */
  private async tryStartFulfillment(orderId: string): Promise<void> {
    try {
      await this.fulfillmentService.startForPaidOrder(orderId);
    } catch (error) {
      if (error instanceof NotImplementedException) {
        this.logger.warn({
          event: 'fulfillment.deferred',
          orderId,
          reason: 'startForPaidOrder is not implemented yet',
        });
        return;
      }
      this.logger.error({
        event: 'fulfillment.start_failed',
        orderId,
        error: String(error),
      });
    }
  }

  /**
   * Retry is best-effort until fulfillment is wired.
   * The stub throws NotImplemented — do not fail the HTTP request.
   */
  private async tryRetryDelivery(orderId: string): Promise<void> {
    try {
      await this.fulfillmentService.retryDelivery(orderId);
    } catch (error) {
      if (error instanceof NotImplementedException) {
        this.logger.warn({
          event: 'fulfillment.deferred',
          orderId,
          reason: 'retryDelivery is not implemented yet',
        });
        return;
      }
      this.logger.error({
        event: 'fulfillment.retry_failed',
        orderId,
        error: String(error),
      });
    }
  }
}
