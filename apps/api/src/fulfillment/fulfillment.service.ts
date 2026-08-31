import { Injectable, Logger } from '@nestjs/common';
import {
  FulfillmentOutcome,
  OrderStatus,
  ProviderId,
} from '../domain/enums';
import {
  nextFulfillmentAction,
  requestIdFor,
} from '../domain/fulfillment-policy';
import {
  FULFILLMENT_ATTEMPT,
  ORDER_STATUS_CHANGED,
} from '../domain/log-events';
import { IssueRequest, IssueResult } from '../domain/ports';
import { canTransition } from '../domain/state-machine';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { ProviderAAdapter } from './provider-a.adapter';
import { ProviderBAdapter } from './provider-b.adapter';

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_A_RETRIES = 2;
/** Short linear backoff between A retries (F7 demo). */
const BACKOFF_BASE_MS = 100;

function parseTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return value;
}

function parseRetries(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_A_RETRIES);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_A_RETRIES;
  }
  return Math.floor(value);
}

function parseEnvFlag(raw: string | undefined): boolean {
  return raw === '1';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outcomeFromIssue(result: IssueResult): FulfillmentOutcome {
  if (result.status === 'ok') {
    return FulfillmentOutcome.ok;
  }
  if (result.status === 'timeout') {
    return FulfillmentOutcome.timeout;
  }
  if (result.reason === 'out_of_stock') {
    return FulfillmentOutcome.out_of_stock;
  }
  return FulfillmentOutcome.error;
}

/**
 * F4/F5/F7/F12 orchestrator: paid → delivering, A then B, one code per order.
 */
@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name);
  private readonly timeoutMs: number;
  private readonly aRetries: number;
  private readonly aHardDown: boolean;

  constructor(
    private readonly providerA: ProviderAAdapter,
    private readonly providerB: ProviderBAdapter,
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
  ) {
    this.timeoutMs = parseTimeoutMs(process.env.PROVIDER_TIMEOUT_MS);
    this.aRetries = parseRetries(process.env.PROVIDER_A_RETRIES);
    this.aHardDown = parseEnvFlag(process.env.PROVIDER_A_ALWAYS_DOWN);
  }

  async startForPaidOrder(orderId: string): Promise<void> {
    const order = await this.beginFulfillment(orderId, [
      OrderStatus.paid,
      OrderStatus.delivering,
    ]);
    if (!order) {
      return;
    }
    await this.runLoop(order.id, order.sku);
  }

  async retryDelivery(orderId: string): Promise<void> {
    const order = await this.beginFulfillment(orderId, [
      OrderStatus.out_of_stock,
      OrderStatus.delivery_failed,
      OrderStatus.delivering,
    ]);
    if (!order) {
      return;
    }
    await this.runLoop(order.id, order.sku);
  }

  /**
   * Race-safe paid|recoverable → delivering. Parallel callers may both
   * enter the loop; provider `request_id` + unique key bind keep one code.
   */
  private async beginFulfillment(
    orderId: string,
    fromStatuses: readonly OrderStatus[],
  ): Promise<{ id: string; sku: string } | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      return null;
    }

    const status = order.status as OrderStatus;
    if (status === OrderStatus.delivered) {
      return null;
    }
    if (status === OrderStatus.delivering) {
      return { id: order.id, sku: order.sku };
    }
    if (!fromStatuses.includes(status)) {
      return null;
    }
    if (!canTransition(status, OrderStatus.delivering)) {
      return null;
    }

    const updated = await this.prisma.order.updateMany({
      where: { id: orderId, status },
      data: { status: OrderStatus.delivering },
    });
    if (updated.count === 1) {
      this.logStatusChanged(orderId, status, OrderStatus.delivering);
      return { id: order.id, sku: order.sku };
    }

    const raced = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!raced) {
      return null;
    }
    const racedStatus = raced.status as OrderStatus;
    if (racedStatus === OrderStatus.delivered) {
      return null;
    }
    if (racedStatus === OrderStatus.delivering) {
      return { id: raced.id, sku: raced.sku };
    }
    return null;
  }

  private async runLoop(orderId: string, sku: string): Promise<void> {
    const alreadyBound = await this.prisma.inventoryKey.findUnique({
      where: { orderId },
    });
    if (alreadyBound) {
      await this.finish(orderId, OrderStatus.delivered, alreadyBound.code);
      return;
    }

    let attemptCountOnA = 0;
    let lastOutcome: FulfillmentOutcome | null = null;
    let lastCode: string | null = null;
    const maxA = this.aRetries + 1;
    const maxIterations = maxA + 4;

    for (let i = 0; i < maxIterations; i += 1) {
      const action = nextFulfillmentAction({
        attemptCountOnA,
        lastOutcome,
        aHardDown: this.aHardDown,
        timeoutMs: this.timeoutMs,
        aRetries: this.aRetries,
      });

      if (action.action === 'delivered') {
        await this.bindAndDeliver(orderId, lastCode);
        return;
      }
      if (action.action === 'out_of_stock') {
        await this.finish(orderId, OrderStatus.out_of_stock);
        return;
      }
      if (action.action === 'delivery_failed') {
        await this.finish(orderId, OrderStatus.delivery_failed);
        return;
      }

      if (action.action === 'retry_a') {
        if (attemptCountOnA > 0) {
          await sleep(BACKOFF_BASE_MS * attemptCountOnA);
        }
        const requestId = requestIdFor(orderId, ProviderId.A);
        const result = await this.issueSafe(this.providerA, {
          requestId,
          sku,
          orderId,
        });
        lastOutcome = outcomeFromIssue(result);
        this.logAttempt(orderId, requestId, ProviderId.A, lastOutcome);
        if (result.status === 'ok') {
          lastCode = result.code;
        }
        attemptCountOnA += 1;
        continue;
      }

      if (action.action === 'fallback_b') {
        const requestId = requestIdFor(orderId, ProviderId.B);
        const result = await this.issueSafe(this.providerB, {
          requestId,
          sku,
          orderId,
        });
        lastOutcome = outcomeFromIssue(result);
        this.logAttempt(orderId, requestId, ProviderId.B, lastOutcome);
        if (result.status === 'ok') {
          lastCode = result.code;
        }
        if (
          lastOutcome === FulfillmentOutcome.timeout ||
          lastOutcome === FulfillmentOutcome.error
        ) {
          attemptCountOnA = maxA + 1;
        }
      }
    }

    await this.finish(orderId, OrderStatus.delivery_failed);
  }

  private async issueSafe(
    provider: ProviderAAdapter | ProviderBAdapter,
    request: IssueRequest,
  ): Promise<IssueResult> {
    try {
      return await provider.issue(request);
    } catch {
      return { status: 'error', reason: '5xx' };
    }
  }

  /**
   * Unique bind wins: allocate (or reuse the already-bound key) then stamp
   * `Order.code`. Provider `ok` is confirmed against the shared pool.
   */
  private async bindAndDeliver(
    orderId: string,
    code: string | null,
  ): Promise<void> {
    const allocated = await this.inventory.allocateForOrder(orderId);
    if (allocated.status === 'ok') {
      await this.finish(orderId, OrderStatus.delivered, allocated.code);
      return;
    }
    if (code) {
      await this.finish(orderId, OrderStatus.delivered, code);
      return;
    }
    await this.finish(orderId, OrderStatus.out_of_stock);
  }

  private async finish(
    orderId: string,
    to: OrderStatus,
    code?: string,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) {
      return;
    }
    const from = order.status as OrderStatus;
    if (from === OrderStatus.delivered) {
      return;
    }
    if (!canTransition(from, to)) {
      return;
    }

    const data: { status: OrderStatus; code?: string } = { status: to };
    if (to === OrderStatus.delivered && code) {
      data.code = code;
    }

    const updated = await this.prisma.order.updateMany({
      where: { id: orderId, status: from },
      data,
    });
    if (updated.count === 1 && from !== to) {
      this.logStatusChanged(orderId, from, to);
    }
  }

  private logAttempt(
    orderId: string,
    requestId: string,
    provider: ProviderId,
    outcome: FulfillmentOutcome,
  ): void {
    this.logger.log({
      event: FULFILLMENT_ATTEMPT,
      orderId,
      requestId,
      provider,
      outcome,
    });
  }

  private logStatusChanged(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
  ): void {
    this.logger.log({
      event: ORDER_STATUS_CHANGED,
      orderId,
      from,
      to,
    });
  }
}
