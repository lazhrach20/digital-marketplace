/**
 * T6 / F7 — Provider A times out after issuing; retry with the same request_id
 * returns the same code (no second key).
 *
 * Restart the API with:
 *   PROVIDER_A_FORCE_TIMEOUT_THEN_OK=1
 *
 * Usage: npx tsx scripts/timeout-same-request-id.ts
 * Env: API_URL (default http://localhost:3000), SKU, SCRIPT_TIMEOUT_MS
 */

import { PrismaClient } from '@prisma/client';
import {
  API_URL,
  createOrder,
  getOrder,
  makeEventId,
  sendPaymentWebhook,
  waitForOrder,
} from './lib/http';

async function assertSingleBoundKey(orderId: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return;
  }

  const prisma = new PrismaClient();
  try {
    const bound = await prisma.inventoryKey.count({ where: { orderId } });
    if (bound !== 1) {
      throw new Error(`Expected 1 inventory key for ${orderId}, found ${bound}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log('T6: timeout then same request_id');
  console.log('Requires API env: PROVIDER_A_FORCE_TIMEOUT_THEN_OK=1');
  console.log(`API: ${API_URL}`);

  const order = await createOrder();
  console.log(`Created order ${order.id} status=${order.status}`);

  await sendPaymentWebhook({
    event_id: makeEventId('evt_t6'),
    order_id: order.id,
    status: 'paid',
  });
  console.log('Sent paid webhook');

  const delivered = await waitForOrder(order.id, (o) => o.status === 'delivered');
  if (!delivered.code) {
    throw new Error('Expected delivered order with a code');
  }

  await assertSingleBoundKey(order.id);

  const again = await getOrder(order.id);
  if (again.code !== delivered.code) {
    throw new Error('Order code changed after delivery');
  }

  console.log(`OK: delivered code=${delivered.code}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
