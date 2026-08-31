import { OrderStatus, PaymentStatus } from './enums';

/** Provider `POST /issue` request (idempotency key = requestId). */
export interface IssueRequest {
  requestId: string;
  sku: string;
  orderId: string;
}

/** Successful issue — same requestId on retry returns the same code. */
export interface IssueOkResult {
  status: 'ok';
  requestId: string;
  code: string;
}

/** Provider error (e.g. out_of_stock, simulated 5xx). */
export interface IssueErrorResult {
  status: 'error';
  reason: string;
}

/** No response within configured timeout; retry with the same requestId. */
export interface IssueTimeoutResult {
  status: 'timeout';
}

export type IssueResult = IssueOkResult | IssueErrorResult | IssueTimeoutResult;

export interface IssueProvider {
  issue(request: IssueRequest): Promise<IssueResult>;
}

/** Order row as seen by domain/services (persistence-agnostic). */
export interface OrderRecord {
  id: string;
  sku: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  code: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrderInput {
  id: string;
  sku: string;
  amount: number;
  currency: string;
}

export interface OrderPort {
  findById(orderId: string): Promise<OrderRecord | null>;
  create(input: CreateOrderInput): Promise<OrderRecord>;
  updateStatus(orderId: string, status: OrderStatus): Promise<OrderRecord>;
  setCode(orderId: string, code: string): Promise<OrderRecord>;
  /** Race-safe transition for parallel webhooks (e.g. created → paid). */
  transitionIfStatus(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<OrderRecord | null>;
}

/** Buffered or applied payment webhook row. */
export interface PaymentEventRecord {
  eventId: string;
  orderId: string;
  status: PaymentStatus;
  payload: Record<string, unknown>;
  processedAt: Date | null;
}

export interface SavePaymentEventInput {
  eventId: string;
  orderId: string;
  status: PaymentStatus;
  payload: Record<string, unknown>;
}

export interface PaymentEventPort {
  findByEventId(eventId: string): Promise<PaymentEventRecord | null>;
  save(input: SavePaymentEventInput): Promise<PaymentEventRecord>;
  findPendingByOrderId(orderId: string): Promise<PaymentEventRecord[]>;
  markProcessed(eventId: string, processedAt?: Date): Promise<void>;
}

/** Result of allocating one key from the shared pool to an order. */
export type AllocateKeyResult =
  | { status: 'ok'; code: string }
  | { status: 'out_of_stock' };

export interface InventoryPort {
  allocateForOrder(orderId: string): Promise<AllocateKeyResult>;
}
