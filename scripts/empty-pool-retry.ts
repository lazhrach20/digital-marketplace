/**
 * T8 / T10 / F12 — Empty inventory pool → out_of_stock; restock → retry-delivery
 * delivers exactly one key; a second retry-delivery is idempotent.
 *
 * Usage: npx tsx scripts/empty-pool-retry.ts
 * Env: API_URL (default http://localhost:3000), DATABASE_URL, SKU, SCRIPT_TIMEOUT_MS
 */

import { PrismaClient } from '@prisma/client';
import {
  API_URL,
  createOrder,
  getOrder,
  makeEventId,
  retryDelivery,
  sendPaymentWebhook,
  waitForOrder,
} from './lib/http';

const RESTOCK_CODES = ['RETRY-KEY1-AAAA', 'RETRY-KEY2-BBBB'] as const;

async function emptyFreePool(prisma: PrismaClient): Promise<number> {
  const result = await prisma.inventoryKey.deleteMany({
    where: { orderId: null },
  });
  return result.count;
}

async function restockPool(prisma: PrismaClient): Promise<number> {
  const result = await prisma.inventoryKey.createMany({
    data: RESTOCK_CODES.map((code) => ({ code, sku: null, orderId: null })),
    skipDuplicates: true,
  });
  return result.count;
}

async function assertSingleBoundKey(
  prisma: PrismaClient,
  orderId: string,
): Promise<string> {
  const keys = await prisma.inventoryKey.findMany({ where: { orderId } });
  if (keys.length !== 1 || !keys[0]?.code) {
    throw new Error(`Expected exactly one bound key for ${orderId}`);
  }
  return keys[0].code;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for empty-pool-retry.ts');
  }

  console.log('T8/T10: empty pool then retry-delivery after restock');
  console.log(`API: ${API_URL}`);

  const prisma = new PrismaClient();
  try {
    const removed = await emptyFreePool(prisma);
    console.log(`Removed ${removed} free inventory keys`);

    const order = await createOrder();
    console.log(`Created order ${order.id} status=${order.status}`);

    await sendPaymentWebhook({
      event_id: makeEventId('evt_t8'),
      order_id: order.id,
      status: 'paid',
    });
    console.log('Sent paid webhook');

    const exhausted = await waitForOrder(
      order.id,
      (o) => o.status === 'out_of_stock',
    );
    console.log(`Order reached out_of_stock (code=${exhausted.code ?? 'null'})`);

    const added = await restockPool(prisma);
    console.log(`Restocked ${added} new keys (${RESTOCK_CODES.join(', ')})`);

    const firstRetry = await retryDelivery(order.id);
    if (firstRetry.status !== 'delivered' || !firstRetry.code) {
      throw new Error(
        `Expected delivered after retry-delivery, got ${firstRetry.status}`,
      );
    }
    console.log(`First retry delivered code=${firstRetry.code}`);

    const boundCode = await assertSingleBoundKey(prisma, order.id);
    if (boundCode !== firstRetry.code) {
      throw new Error('Bound inventory key does not match order code');
    }

    const secondRetry = await retryDelivery(order.id);
    if (secondRetry.status !== 'delivered' || secondRetry.code !== firstRetry.code) {
      throw new Error('Second retry-delivery must return the same code');
    }

    const final = await getOrder(order.id);
    if (final.code !== firstRetry.code) {
      throw new Error('GET order code differs after idempotent retry');
    }

    console.log(`OK: one key issued (${firstRetry.code}), retry is idempotent`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
