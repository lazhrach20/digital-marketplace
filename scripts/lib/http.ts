export type OrderDetail = {
  id: string;
  sku: string;
  status: string;
  amount: number;
  currency: string;
  code: string | null;
};

export type CreatedOrder = OrderDetail;

export type PaymentWebhookBody = {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount?: number;
  currency?: string;
  created_at?: string;
};

export const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

export const API_BASE = `${API_URL}/api`;

export const DEFAULT_SKU = process.env.SKU ?? 'KEY-CS2-PRIME';

export const SCRIPT_TIMEOUT_MS = Number(
  process.env.SCRIPT_TIMEOUT_MS ?? 120_000,
);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeEventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, data };
}

export async function apiGet<T>(path: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API_BASE}${path}`);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, data };
}

export async function createOrder(
  sku: string = DEFAULT_SKU,
  id?: string,
): Promise<CreatedOrder> {
  const body = id === undefined ? { sku } : { sku, id };
  const { status, data } = await apiPost<CreatedOrder>('/orders', body);
  if (status !== 201 && status !== 200) {
    throw new Error(`POST /orders → ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function sendPaymentWebhook(
  body: PaymentWebhookBody,
): Promise<{ status: number; duplicate?: boolean }> {
  const { status, data } = await apiPost<{ duplicate?: boolean }>(
    '/webhooks/payment',
    body,
  );
  if (status !== 200) {
    throw new Error(
      `POST /webhooks/payment → ${status}: ${JSON.stringify(data)}`,
    );
  }
  return { status, duplicate: data.duplicate };
}

export async function getOrder(orderId: string): Promise<OrderDetail> {
  const { status, data } = await apiGet<OrderDetail>(`/orders/${orderId}`);
  if (status !== 200) {
    throw new Error(`GET /orders/${orderId} → ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function retryDelivery(orderId: string): Promise<OrderDetail> {
  const { status, data } = await apiPost<OrderDetail>(
    `/orders/${orderId}/retry-delivery`,
  );
  if (status !== 200) {
    throw new Error(
      `POST /orders/${orderId}/retry-delivery → ${status}: ${JSON.stringify(data)}`,
    );
  }
  return data;
}

export async function waitForOrder(
  orderId: string,
  predicate: (order: OrderDetail) => boolean,
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
): Promise<OrderDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: OrderDetail | undefined;

  while (Date.now() < deadline) {
    last = await getOrder(orderId);
    if (predicate(last)) {
      return last;
    }
    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for order ${orderId} (last status=${last?.status ?? 'unknown'})`,
  );
}
