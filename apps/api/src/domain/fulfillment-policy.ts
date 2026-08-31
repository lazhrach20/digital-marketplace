import {
  FulfillmentOutcome,
  OrderStatus,
  ProviderId,
} from './enums';

/** Stable request_id for provider A — reused on every A retry (timeout ≠ failure). */
export function requestIdFor(orderId: string, provider: ProviderId): string {
  return `req_${orderId}-${provider}`;
}

export type FulfillmentActionKind =
  | 'retry_a'
  | 'fallback_b'
  | 'delivered'
  | 'out_of_stock'
  | 'delivery_failed';

export interface FulfillmentAction {
  action: FulfillmentActionKind;
  provider?: ProviderId;
  /** When true, caller must reuse the existing A request_id (never mix providers). */
  sameRequestId?: boolean;
  status?: OrderStatus;
}

export interface NextFulfillmentActionInput {
  attemptCountOnA: number;
  lastOutcome: FulfillmentOutcome | null;
  aHardDown: boolean;
  /** Accepted for orchestrator config; policy does not perform I/O or timing. */
  timeoutMs: number;
  /** Retry count on A after the initial attempt (see PROVIDER_A_RETRIES). */
  aRetries: number;
}

function maxAttemptsOnA(aRetries: number): number {
  return aRetries + 1;
}

function canRetryOnA(attemptCountOnA: number, aRetries: number): boolean {
  return attemptCountOnA < maxAttemptsOnA(aRetries);
}

/** Orchestrator sets attemptCountOnA above maxAttemptsOnA after a failed B attempt. */
function bAlreadyAttempted(attemptCountOnA: number, aRetries: number): boolean {
  return attemptCountOnA > maxAttemptsOnA(aRetries);
}

function isRetryableFailure(outcome: FulfillmentOutcome): boolean {
  return (
    outcome === FulfillmentOutcome.timeout ||
    outcome === FulfillmentOutcome.error
  );
}

/**
 * Pure fulfillment policy (F7): timeout ≠ failure on A (same request_id),
 * fallback B only after A retries exhausted or A hard-down (new request_id),
 * at most one successful issue per order (terminal `delivered` once on `ok`).
 */
export function nextFulfillmentAction(
  input: NextFulfillmentActionInput,
): FulfillmentAction {
  const { attemptCountOnA, lastOutcome, aHardDown, timeoutMs: _timeoutMs, aRetries } =
    input;

  if (lastOutcome === FulfillmentOutcome.ok) {
    return { action: 'delivered', status: OrderStatus.delivered };
  }

  if (lastOutcome === FulfillmentOutcome.out_of_stock) {
    return { action: 'out_of_stock', status: OrderStatus.out_of_stock };
  }

  if (lastOutcome === null) {
    if (aHardDown) {
      return {
        action: 'fallback_b',
        provider: ProviderId.B,
        sameRequestId: false,
      };
    }

    return {
      action: 'retry_a',
      provider: ProviderId.A,
      sameRequestId: true,
    };
  }

  if (isRetryableFailure(lastOutcome)) {
    if (bAlreadyAttempted(attemptCountOnA, aRetries)) {
      return {
        action: 'delivery_failed',
        status: OrderStatus.delivery_failed,
      };
    }

    if (canRetryOnA(attemptCountOnA, aRetries) && !aHardDown) {
      return {
        action: 'retry_a',
        provider: ProviderId.A,
        sameRequestId: true,
      };
    }

    return {
      action: 'fallback_b',
      provider: ProviderId.B,
      sameRequestId: false,
    };
  }

  return {
    action: 'delivery_failed',
    status: OrderStatus.delivery_failed,
  };
}
