/**
 * F11 — 50 parallel `paid` webhooks for one order (different event_id each).
 *
 * Usage: tsx scripts/race-webhooks.ts [order_id]
 * Env:   API_URL (default http://localhost:3000), SKU (default KEY-CS2-PRIME)
 */

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WEBHOOK_URL = `${API_URL}/api/webhooks/payment`;
const ORDERS_URL = `${API_URL}/api/orders`;
const DEFAULT_SKU = process.env.SKU ?? 'KEY-CS2-PRIME';
const PARALLEL_COUNT = 50;

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

async function createOrder(sku: string, id?: string): Promise<OrderResponse> {
  const body: Record<string, string> = { sku };
  if (id) {
    body.id = id;
  }

  const response = await fetch(ORDERS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const argOrderId = process.argv[2];
  let orderId = argOrderId;

  if (!orderId) {
    orderId = newOrderId();
    const created = await createOrder(DEFAULT_SKU, orderId);
    console.log(`Created order ${created.id} (status=${created.status}, sku=${DEFAULT_SKU})`);
  } else {
    const existing = await getOrder(orderId);
    console.log(`Using existing order ${existing.id} (status=${existing.status})`);
  }

  console.log(`Sending ${PARALLEL_COUNT} parallel paid webhooks to ${WEBHOOK_URL}`);

  const now = new Date().toISOString();
  const requests = Array.from({ length: PARALLEL_COUNT }, (_, index) => {
    const eventId = `evt_race_${String(index + 1).padStart(3, '0')}_${Date.now()}`;
    return postWebhook({
      event_id: eventId,
      order_id: orderId,
      status: 'paid',
      amount: 1290,
      currency: 'RUB',
      created_at: now,
    });
  });

  const results = await Promise.all(requests);
  const okCount = results.filter((r) => r.status === 200).length;
  const duplicateCount = results.filter((r) => r.body.duplicate === true).length;
  const acceptedCount = results.filter(
    (r) => r.status === 200 && r.body.duplicate !== true,
  ).length;

  const finalOrder = await getOrder(orderId);

  console.log('');
  console.log('Race summary');
  console.log(`  order_id:        ${orderId}`);
  console.log(`  HTTP 200:        ${okCount}/${PARALLEL_COUNT}`);
  console.log(`  accepted (new):  ${acceptedCount}`);
  console.log(`  duplicate:       ${duplicateCount}`);
  console.log(`  final status:    ${finalOrder.status}`);

  if (okCount !== PARALLEL_COUNT) {
    throw new Error(`Expected ${PARALLEL_COUNT} HTTP 200 responses, got ${okCount}`);
  }

  if (acceptedCount !== 1) {
    throw new Error(`Expected exactly 1 accepted webhook, got ${acceptedCount}`);
  }

  if (finalOrder.status !== 'paid' && finalOrder.status !== 'delivering' && finalOrder.status !== 'delivered') {
    throw new Error(`Expected order to reach paid/delivering/delivered, got ${finalOrder.status}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
