import { OrderStatus, PaymentStatus } from './enums';
import { canTransition } from './state-machine';

export interface PaymentEventPayload {
  eventId: string;
  orderId: string;
  status: PaymentStatus;
}

export interface ApplyPaymentEventInput {
  event: PaymentEventPayload;
  /** `null` when the order row does not exist yet (webhook-before-order). */
  order: { status: OrderStatus } | null;
  processedEventIds: ReadonlySet<string>;
}

export type ApplyPaymentEventResult =
  | { kind: 'buffer' }
  | { kind: 'noop'; duplicate: true }
  | { kind: 'noop'; ignored: true }
  | {
      kind: 'apply';
      from: OrderStatus;
      to: OrderStatus;
      startFulfillment: boolean;
    };

function paymentOutcomeDecided(status: OrderStatus): boolean {
  return status !== OrderStatus.created;
}

/**
 * Pure payment webhook policy (F3/F5): first durable payment outcome wins,
 * duplicate `event_id` is a no-op, unknown order is buffered (not applied).
 */
export function applyPaymentEvent(
  input: ApplyPaymentEventInput,
): ApplyPaymentEventResult {
  const { event, order, processedEventIds } = input;

  if (processedEventIds.has(event.eventId)) {
    return { kind: 'noop', duplicate: true };
  }

  if (order === null) {
    return { kind: 'buffer' };
  }

  const currentStatus = order.status;

  if (paymentOutcomeDecided(currentStatus)) {
    return { kind: 'noop', ignored: true };
  }

  if (event.status === PaymentStatus.paid) {
    const to = OrderStatus.paid;
    if (!canTransition(currentStatus, to)) {
      return { kind: 'noop', ignored: true };
    }

    return {
      kind: 'apply',
      from: currentStatus,
      to,
      startFulfillment: true,
    };
  }

  const to = OrderStatus.payment_failed;
  if (!canTransition(currentStatus, to)) {
    return { kind: 'noop', ignored: true };
  }

  return {
    kind: 'apply',
    from: currentStatus,
    to,
    startFulfillment: false,
  };
}
