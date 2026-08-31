import { OrderStatus } from './enums';

const ALLOWED_TRANSITIONS: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  [OrderStatus.created]: new Set([
    OrderStatus.paid,
    OrderStatus.payment_failed,
  ]),
  [OrderStatus.paid]: new Set([
    OrderStatus.delivering,
    OrderStatus.out_of_stock,
    OrderStatus.delivery_failed,
  ]),
  [OrderStatus.delivering]: new Set([
    OrderStatus.delivering,
    OrderStatus.delivered,
    OrderStatus.out_of_stock,
    OrderStatus.delivery_failed,
  ]),
  [OrderStatus.out_of_stock]: new Set([OrderStatus.delivering]),
  [OrderStatus.delivery_failed]: new Set([OrderStatus.delivering]),
  [OrderStatus.delivered]: new Set([OrderStatus.delivered]),
  [OrderStatus.payment_failed]: new Set([OrderStatus.payment_failed]),
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) {
    return true;
  }

  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal order status transition: ${from} → ${to}`,
    );
  }
}

/**
 * F12 retry-delivery: resume from recoverable or stuck `delivering`.
 * `paid` may go to `delivering` via first fulfillment, not this endpoint.
 */
export function canRetryDelivery(status: OrderStatus): boolean {
  if (status === OrderStatus.paid) {
    return false;
  }
  return canTransition(status, OrderStatus.delivering);
}
