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

async function emptyFreeInventoryPool(): Promise<number> {
  const prisma = new PrismaClient({
    datasources: { db: { url: getDatabaseUrl() } },
  });
  try {
    const result = await prisma.inventoryKey.deleteMany({
      where: { orderId: null },
    });
    return result.count;
  } finally {
    await prisma.$disconnect();
  }
}

describe('T8 empty inventory pool (e2e)', () => {
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

  it('paid with empty pool → out_of_stock, process stays up', async () => {
    const removed = await emptyFreeInventoryPool();
    expect(removed).toBeGreaterThan(0);

    const createRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: TEST_SKU }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      status: string;
      code: string | null;
    };
    expect(created.status).toBe(OrderStatus.created);
    expect(created.code).toBeNull();

    const eventId = `evt_t8_${Date.now()}`;
    const webhookRes = await fetch(`${baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: eventId,
        order_id: created.id,
        status: PaymentStatus.paid,
      }),
    });
    expect(webhookRes.status).toBe(200);
    const webhookBody = (await webhookRes.json()) as { duplicate: boolean };
    expect(webhookBody.duplicate).toBe(false);

    const orderRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(orderRes.status).toBe(200);
    const order = (await orderRes.json()) as {
      status: string;
      code: string | null;
    };
    expect(order.status).toBe(OrderStatus.out_of_stock);
    expect(order.code).toBeNull();

    const prisma = new PrismaClient({
      datasources: { db: { url: getDatabaseUrl() } },
    });
    try {
      const assignedKeys = await prisma.inventoryKey.count({
        where: { orderId: created.id },
      });
      expect(assignedKeys).toBe(0);
    } finally {
      await prisma.$disconnect();
    }

    const healthRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: TEST_SKU }),
    });
    expect(healthRes.status).toBe(201);
  });
});
