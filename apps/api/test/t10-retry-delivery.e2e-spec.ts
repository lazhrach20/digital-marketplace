import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { OrderStatus, PaymentStatus } from '../src/domain/enums';
import {
  getDatabaseUrl,
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

const TEST_SKU = 'KEY-CS2-PRIME';
const RESTOCK_CODES = ['RETRY-KEY1-AAAA', 'RETRY-KEY2-BBBB'] as const;

type OrderBody = {
  id: string;
  status: string;
  code: string | null;
};

async function withPrisma<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({
    datasources: { db: { url: getDatabaseUrl() } },
  });
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function emptyFreeInventoryPool(): Promise<number> {
  return withPrisma(async (prisma) => {
    const result = await prisma.inventoryKey.deleteMany({
      where: { orderId: null },
    });
    return result.count;
  });
}

async function restockInventoryPool(): Promise<number> {
  return withPrisma(async (prisma) => {
    const result = await prisma.inventoryKey.createMany({
      data: RESTOCK_CODES.map((code) => ({ code, sku: null, orderId: null })),
      skipDuplicates: true,
    });
    return result.count;
  });
}

describe('T10 restock retry-delivery (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await setupPostgresSuite();
  });

  afterAll(async () => {
    await teardownPostgresSuite();
  });

  beforeEach(async () => {
    await resetPostgresData();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    expect(typeof address).toBe('object');
    expect(address).not.toBeNull();
    const port =
      address && typeof address === 'object' && 'port' in address
        ? address.port
        : 0;
    expect(port).not.toBe(3000);
    baseUrl = `http://127.0.0.1:${port}/api`;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('empty pool → restock → retry-delivery yields one key; second retry is same code', async () => {
    const removed = await emptyFreeInventoryPool();
    expect(removed).toBeGreaterThan(0);

    const createRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: TEST_SKU }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as OrderBody;
    expect(created.status).toBe(OrderStatus.created);
    expect(created.code).toBeNull();

    const webhookRes = await fetch(`${baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: `evt_t10_${Date.now()}`,
        order_id: created.id,
        status: PaymentStatus.paid,
      }),
    });
    expect(webhookRes.status).toBe(200);
    const webhookBody = (await webhookRes.json()) as { duplicate: boolean };
    expect(webhookBody.duplicate).toBe(false);

    const exhaustedRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(exhaustedRes.status).toBe(200);
    const exhausted = (await exhaustedRes.json()) as OrderBody;
    expect(exhausted.status).toBe(OrderStatus.out_of_stock);
    expect(exhausted.code).toBeNull();

    const added = await restockInventoryPool();
    expect(added).toBe(RESTOCK_CODES.length);

    const firstRetryRes = await fetch(
      `${baseUrl}/orders/${created.id}/retry-delivery`,
      { method: 'POST' },
    );
    expect(firstRetryRes.status).toBe(200);
    const firstRetry = (await firstRetryRes.json()) as OrderBody;
    expect(firstRetry.status).toBe(OrderStatus.delivered);
    expect(firstRetry.code).toEqual(expect.any(String));
    expect(firstRetry.code!.length).toBeGreaterThan(0);
    expect(RESTOCK_CODES).toContain(firstRetry.code);

    await withPrisma(async (prisma) => {
      const assignedKeys = await prisma.inventoryKey.findMany({
        where: { orderId: created.id },
      });
      expect(assignedKeys).toHaveLength(1);
      expect(assignedKeys[0]!.code).toBe(firstRetry.code);
    });

    const secondRetryRes = await fetch(
      `${baseUrl}/orders/${created.id}/retry-delivery`,
      { method: 'POST' },
    );
    expect(secondRetryRes.status).toBe(200);
    const secondRetry = (await secondRetryRes.json()) as OrderBody;
    expect(secondRetry.status).toBe(OrderStatus.delivered);
    expect(secondRetry.code).toBe(firstRetry.code);

    const finalRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(finalRes.status).toBe(200);
    const finalOrder = (await finalRes.json()) as OrderBody;
    expect(finalOrder.status).toBe(OrderStatus.delivered);
    expect(finalOrder.code).toBe(firstRetry.code);

    await withPrisma(async (prisma) => {
      const assignedKeys = await prisma.inventoryKey.findMany({
        where: { orderId: created.id },
      });
      expect(assignedKeys).toHaveLength(1);
      expect(assignedKeys[0]!.code).toBe(firstRetry.code);
    });
  });
});
