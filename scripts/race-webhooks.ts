/**
 * F11 / T3 — 50 parallel `paid` webhooks for one order (distinct event_id each).
 *
 * Unique event_ids must all persist (not treated as duplicates). Fulfillment
 * still happens exactly once. Transient 5xx / timeouts are retried with the
 * same event_id until HTTP 200.
 *
 * Usage: tsx scripts/race-webhooks.ts [order_id]
 * Env:   API_URL (default http://localhost:3000), SKU, DATABASE_URL, SCRIPT_TIMEOUT_MS
 */

import { PrismaClient } from '@prisma/client';
import {
  API_URL,
  createOrder,
  DEFAULT_SKU,
  getOrder,
  SCRIPT_TIMEOUT_MS,
  sleep,
  waitForOrder,
  type PaymentWebhookBody,
} from './lib/http';

const WEBHOOK_URL = `${API_URL}/api/webhooks/payment`;
const PARALLEL_COUNT = 50;
const POST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPT_ROUNDS = 8;

type WebhookPostResult = {
  eventId: string;
  status: number;
  duplicate?: boolean;
  error?: string;
};

function newOrderId(): string {
  return `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function makeRaceEventId(index: number): string {
  return `evt_race_${String(index + 1).padStart(3, '0')}_${Date.now()}_${index}_${crypto.randomUUID().slice(0, 8)}`;
}

async function postWebhook(
  body: PaymentWebhookBody,
): Promise<WebhookPostResult> {
  const eventId = body.event_id;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let duplicate: boolean | undefined;
    try {
      const parsed = JSON.parse(text) as { duplicate?: boolean };
      duplicate = parsed.duplicate;
    } catch {
      if (response.status === 200) {
        return {
          eventId,
          status: response.status,
          error: `Webhook response is not JSON: ${text}`,
        };
      }
    }

    return { eventId, status: response.status, duplicate };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { eventId, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function isHttp200(result: WebhookPostResult): boolean {
  return result.status === 200;
}

async function postAllUntilOk(
  payloads: PaymentWebhookBody[],
): Promise<WebhookPostResult[]> {
  const latest = new Map<string, WebhookPostResult>();
  let pending = [...payloads];
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS;

  for (let round = 1; round <= MAX_ATTEMPT_ROUNDS && pending.length > 0; round += 1) {
    if (Date.now() >= deadline) {
      break;
    }

    if (round > 1) {
      const backoffMs = Math.min(1_000, 50 * 2 ** (round - 2));
      console.log(
        `Retry round ${round}: ${pending.length} webhook(s) after ${backoffMs}ms (5xx/timeout)`,
      );
      await sleep(backoffMs);
    }

    const results = await Promise.all(pending.map((body) => postWebhook(body)));
    const stillPending: PaymentWebhookBody[] = [];

    for (let i = 0; i < results.length; i += 1) {
      const result = results[i]!;
      latest.set(result.eventId, result);
      if (!isHttp200(result)) {
        stillPending.push(pending[i]!);
      }
    }

    pending = stillPending;
  }

  return payloads.map((body) => {
    const result = latest.get(body.event_id);
    if (!result) {
      return { eventId: body.event_id, status: 0, error: 'missing result' };
    }
    return result;
  });
}

async function assertExactlyOnceFulfillment(
  orderId: string,
  eventIds: string[],
  deliveredCode: string,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('  DATABASE_URL unset — skipped InventoryKey / PaymentEvent checks');
    return;
  }

  const prisma = new PrismaClient();
  try {
    const assignedKeys = await prisma.inventoryKey.findMany({
      where: { orderId },
    });
    if (assignedKeys.length !== 1) {
      throw new Error(
        `Expected exactly 1 InventoryKey for ${orderId}, found ${assignedKeys.length}`,
      );
    }
    if (assignedKeys[0]!.code !== deliveredCode) {
      throw new Error(
        `InventoryKey code mismatch: db=${assignedKeys[0]!.code} order=${deliveredCode}`,
      );
    }

    const storedEvents = await prisma.paymentEvent.findMany({
      where: { eventId: { in: eventIds } },
    });
    if (storedEvents.length !== eventIds.length) {
      throw new Error(
        `Expected ${eventIds.length} PaymentEvent rows for distinct event_ids, found ${storedEvents.length}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const argOrderId = process.argv[2];
  let orderId = argOrderId;

  if (!orderId) {
    orderId = newOrderId();
    const created = await createOrder(DEFAULT_SKU, orderId);
    console.log(
      `Created order ${created.id} (status=${created.status}, sku=${DEFAULT_SKU})`,
    );
  } else {
    const existing = await getOrder(orderId);
    console.log(`Using existing order ${existing.id} (status=${existing.status})`);
  }

  console.log(`Sending ${PARALLEL_COUNT} parallel paid webhooks to ${WEBHOOK_URL}`);
  console.log('(distinct event_id each; retries use the same event_id)');

  const now = new Date().toISOString();
  const payloads: PaymentWebhookBody[] = Array.from(
    { length: PARALLEL_COUNT },
    (_, index) => ({
      event_id: makeRaceEventId(index),
      order_id: orderId,
      status: 'paid' as const,
      amount: 1290,
      currency: 'RUB',
      created_at: now,
    }),
  );

  const eventIds = payloads.map((p) => p.event_id);
  if (new Set(eventIds).size !== PARALLEL_COUNT) {
    throw new Error('event_id collision in race payload');
  }

  const results = await postAllUntilOk(payloads);
  const okCount = results.filter(isHttp200).length;
  const duplicateCount = results.filter((r) => r.duplicate === true).length;
  const acceptedCount = results.filter(
    (r) => r.status === 200 && r.duplicate !== true,
  ).length;
  const failed = results.filter((r) => !isHttp200(r));

  console.log('');
  console.log('Race summary');
  console.log(`  order_id:        ${orderId}`);
  console.log(`  HTTP 200:        ${okCount}/${PARALLEL_COUNT}`);
  console.log(`  accepted (new):  ${acceptedCount}`);
  console.log(`  duplicate:       ${duplicateCount}`);

  if (okCount !== PARALLEL_COUNT) {
    const sample = failed
      .slice(0, 5)
      .map((r) => `${r.eventId}: status=${r.status}${r.error ? ` ${r.error}` : ''}`)
      .join('; ');
    throw new Error(
      `Expected ${PARALLEL_COUNT} HTTP 200 after retries, got ${okCount}. ${sample}`,
    );
  }

  const delivered = await waitForOrder(
    orderId,
    (order) => order.status === 'delivered',
  );

  console.log(`  final status:    ${delivered.status}`);
  console.log(`  code:            ${delivered.code ?? 'null'}`);

  if (!delivered.code) {
    throw new Error('Expected delivered order with exactly one code');
  }

  const again = await getOrder(orderId);
  if (again.code !== delivered.code) {
    throw new Error(
      `Order code changed after delivery: ${delivered.code} → ${again.code}`,
    );
  }

  await assertExactlyOnceFulfillment(orderId, eventIds, delivered.code);

  console.log(
    `OK: ${PARALLEL_COUNT} distinct event_ids persisted, order delivered once, code=${delivered.code}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
