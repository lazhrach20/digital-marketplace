import {
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrderStatus, PaymentStatus } from '../domain/enums';
import {
  ORDER_STATUS_CHANGED,
  PAYMENT_ACCEPTED,
} from '../domain/log-events';
import { applyPaymentEvent } from '../domain/payment-policy';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentWebhookDto } from './payment-webhook.dto';

export type HandlePaymentWebhookResult = {
  duplicate: boolean;
};

type WebhookApplyOutcome = {
  duplicate: boolean;
  startFulfillment: boolean;
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillmentService: FulfillmentService,
  ) {}

  /**
   * Shared payment webhook handler (F3/F5/F10).
   * Always succeeds for accepted/duplicate/buffered/ignored events;
   * persist failures throw so the PS can retry (5xx).
   */
  async handlePaymentWebhook(
    dto: PaymentWebhookDto,
  ): Promise<HandlePaymentWebhookResult> {
    this.assertWebhookDto(dto);

    const eventId = dto.event_id;
    const orderId = dto.order_id;
    const status = dto.status;

    let outcome: WebhookApplyOutcome;
    try {
      outcome = await this.prisma.$transaction((tx) =>
        this.applyWebhookInTx(tx, dto),
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        outcome = { duplicate: true, startFulfillment: false };
      } else {
        throw error;
      }
    }

    this.logger.log({
      event: PAYMENT_ACCEPTED,
      eventId,
      orderId,
      status,
      duplicate: outcome.duplicate,
    });

    if (outcome.startFulfillment) {
      await this.tryStartFulfillment(orderId);
    }

    return { duplicate: outcome.duplicate };
  }

  private async applyWebhookInTx(
    tx: Prisma.TransactionClient,
    dto: PaymentWebhookDto,
  ): Promise<WebhookApplyOutcome> {
    const eventId = dto.event_id;
    const orderId = dto.order_id;
    const status = dto.status;

    const existing = await tx.paymentEvent.findUnique({
      where: { eventId },
    });
    if (existing) {
      return { duplicate: true, startFulfillment: false };
    }

    await tx.paymentEvent.create({
      data: {
        eventId,
        orderId,
        status,
        payload: this.toStoredPayload(dto),
        processedAt: null,
      },
    });

    // F5: serialize parallel paid/failed webhooks on the order row.
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    const orderRow = locked[0];
    const order = orderRow
      ? { status: orderRow.status as OrderStatus }
      : null;

    const result = applyPaymentEvent({
      event: { eventId, orderId, status },
      order,
      processedEventIds: new Set(),
    });

    if (result.kind === 'buffer') {
      return { duplicate: false, startFulfillment: false };
    }

    await tx.paymentEvent.update({
      where: { eventId },
      data: { processedAt: new Date() },
    });

    if (result.kind === 'noop') {
      // Already in-progress (paid/delivering) or terminal — do not start issue.
      return { duplicate: false, startFulfillment: false };
    }

    // F5: only one webhook wins `created` → paid|payment_failed.
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: OrderStatus.created },
      data: { status: result.to },
    });

    if (updated.count !== 1) {
      return { duplicate: false, startFulfillment: false };
    }

    this.logger.log({
      event: ORDER_STATUS_CHANGED,
      orderId,
      from: result.from,
      to: result.to,
    });

    return {
      duplicate: false,
      startFulfillment: result.startFulfillment,
    };
  }

  private assertWebhookDto(dto: PaymentWebhookDto): void {
    if (!dto.event_id || !dto.order_id) {
      throw new BadRequestException('event_id and order_id are required');
    }
    if (
      dto.status !== PaymentStatus.paid &&
      dto.status !== PaymentStatus.failed
    ) {
      throw new BadRequestException('Invalid payment status');
    }
  }

  /** Persist the raw webhook JSON; never read `amount` for business logic. */
  private toStoredPayload(dto: PaymentWebhookDto): Prisma.InputJsonValue {
    const payload: Record<string, unknown> = {
      event_id: dto.event_id,
      order_id: dto.order_id,
      status: dto.status,
    };
    if (dto.amount !== undefined) {
      payload.amount = dto.amount;
    }
    if (dto.currency !== undefined) {
      payload.currency = dto.currency;
    }
    if (dto.created_at !== undefined) {
      payload.created_at = dto.created_at;
    }
    return payload as Prisma.InputJsonObject;
  }

  /**
   * Persist `paid` first; fulfillment is best-effort until wired.
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
}
