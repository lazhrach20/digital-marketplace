/**
 * F11 — webhook arrives before the order exists (buffered, applied on create).
 *
 * Usage: tsx scripts/webhook-before-order.ts
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

function newOrderId(): string {
  return `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function createOrder(sku: string, id: string): Promise<OrderResponse> {
  const response = await fetch(ORDERS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku, id }),
  });

  if (!response.ok) {
    throw new Error(
      `POST /api/orders failed: ${response.status} ${await response.text()}`,
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
  const orderId = newOrderId();
  const eventId = `evt_before_${Date.now()}`;

  console.log(`Pre-allocating order_id=${orderId} (order does not exist yet)`);

  const webhook = await postWebhook({
    event_id: eventId,
    order_id: orderId,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });

  console.log(
    `Webhook before order: HTTP ${webhook.status}, duplicate=${webhook.body.duplicate ?? false}`,
  );

  if (webhook.status !== 200) {
    throw new Error(`Webhook must return HTTP 200, got ${webhook.status}`);
  }

  if (webhook.body.duplicate === true) {
    throw new Error('Buffered webhook must not be treated as duplicate');
  }

  const order = await createOrder(DEFAULT_SKU, orderId);
  console.log(`Created order ${order.id} (status=${order.status}, sku=${DEFAULT_SKU})`);

  if (order.status !== 'paid' && order.status !== 'delivering' && order.status !== 'delivered') {
    throw new Error(
      `Expected buffered paid webhook to apply on create; got status=${order.status}`,
    );
  }

  console.log('Buffered webhook applied successfully on order creation');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
