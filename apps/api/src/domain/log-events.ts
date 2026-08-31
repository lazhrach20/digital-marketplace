import {
  FulfillmentOutcome,
  OrderStatus,
  PaymentStatus,
  ProviderId,
} from './enums';

/**
 * Structured log event names and payload shapes (F10 — observability).
 *
 * Full issued fulfillment `code` values must never be logged.
 */

/** Payment webhook accepted or deduplicated. */
export const PAYMENT_ACCEPTED = 'payment.accepted' as const;

/**
 * Payload fields for {@link PAYMENT_ACCEPTED}.
 */
export interface PaymentAcceptedFields {
  /** Payment webhook idempotency key (`event_id`). */
  eventId: string;
  /** Order identifier (`ord_…`). */
  orderId: string;
  /** Payment outcome from the webhook. */
  status: PaymentStatus;
  /** `true` when `event_id` was already processed. */
  duplicate: boolean;
}

/** Provider issue attempt (primary or fallback). */
export const FULFILLMENT_ATTEMPT = 'fulfillment.attempt' as const;

/**
 * Payload fields for {@link FULFILLMENT_ATTEMPT}.
 */
export interface FulfillmentAttemptFields {
  /** Order identifier. */
  orderId: string;
  /** Provider idempotency key (`request_id`). */
  requestId: string;
  /** Primary (`A`) or fallback (`B`) provider. */
  provider: ProviderId;
  /** Issue result; never include the issued `code` in logs. */
  outcome: FulfillmentOutcome;
}

/** Order lifecycle transition. */
export const ORDER_STATUS_CHANGED = 'order.status_changed' as const;

/**
 * Payload fields for {@link ORDER_STATUS_CHANGED}.
 */
export interface OrderStatusChangedFields {
  /** Order identifier. */
  orderId: string;
  /** Previous order status. */
  from: OrderStatus;
  /** New order status. */
  to: OrderStatus;
}

/** All structured log event name constants. */
export const LOG_EVENTS = {
  PAYMENT_ACCEPTED,
  FULFILLMENT_ATTEMPT,
  ORDER_STATUS_CHANGED,
} as const;

export type LogEventName = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];
