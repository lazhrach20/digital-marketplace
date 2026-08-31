/**
 * F11 — duplicate event_id webhook (second call is a no-op).
 *
 * Usage: tsx scripts/dup-event.ts
 * Env:   API_URL (default http://localhost:3000), SKU (default KEY-CS2-PRIME)
 */

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WEBHOOK_URL = `${API_URL}/api/webhooks/payment`;
const ORDERS_URL = `${API_URL}/api/orders`;
const DEFAULT_SKU = process.env.SKU ?? 'KEY-CS2-PRIME';

type PaymentWebhookBody = {
  event_id: string;
  order_id: string;
  status: 'paid' | 'failed';
  amount?: number;
  currency?: string;
  created_at?: string;
};

type WebhookResponse = {
  duplicate?: boolean;
};

type OrderResponse = {
  id: string;
  status: string;
};

async function createOrder(sku: string): Promise<OrderResponse> {
  const response = await fetch(ORDERS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku }),
  });

  if (!response.ok) {
    throw new Error(
      `POST /api/orders failed: ${response.status} ${await response.text()}`,
    );
  }

  return response.json() as Promise<OrderResponse>;
}

async function getOrder(orderId: string): Promise<OrderResponse> {
  const response = await fetch(`${ORDERS_URL}/${encodeURIComponent(orderId)}`);
  if (!response.ok) {
    throw new Error(
      `GET /api/orders/${orderId} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<OrderResponse>;
}

async function postWebhook(
  body: PaymentWebhookBody,
): Promise<{ status: number; body: WebhookResponse }> {
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: WebhookResponse = {};
  try {
    parsed = JSON.parse(text) as WebhookResponse;
  } catch {
    throw new Error(`Webhook response is not JSON (${response.status}): ${text}`);
  }

  return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
  const order = await createOrder(DEFAULT_SKU);
  console.log(`Created order ${order.id} (status=${order.status})`);

  const eventId = `evt_dup_${Date.now()}`;
  const payload: PaymentWebhookBody = {
    event_id: eventId,
    order_id: order.id,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  };

  const first = await postWebhook(payload);
  console.log(`First webhook:  HTTP ${first.status}, duplicate=${first.body.duplicate ?? false}`);

  const afterFirst = await getOrder(order.id);
  console.log(`Order after first: status=${afterFirst.status}`);

  const second = await postWebhook(payload);
  console.log(
    `Second webhook: HTTP ${second.status}, duplicate=${second.body.duplicate ?? false}`,
  );

  const afterSecond = await getOrder(order.id);
  console.log(`Order after second: status=${afterSecond.status}`);

  if (first.status !== 200 || second.status !== 200) {
    throw new Error('Both webhook calls must return HTTP 200');
  }

  if (first.body.duplicate === true) {
    throw new Error('First webhook must not be marked duplicate');
  }

  if (second.body.duplicate !== true) {
    throw new Error('Second webhook with same event_id must be duplicate');
  }

  if (afterFirst.status !== afterSecond.status) {
    throw new Error(
      `Duplicate event_id changed order status: ${afterFirst.status} → ${afterSecond.status}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
