import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { OrderStatus, PaymentStatus } from '../src/domain/enums';
import { generateOrderId } from '../src/domain/order-id';
import {
  getDatabaseUrl,
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

const TEST_SKU = 'KEY-CS2-PRIME';

describe('T5 — webhook before order (e2e)', () => {
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

  it('buffers paid webhook, applies once on POST /orders with matching id, no duplicate issue', async () => {
    const orderId = generateOrderId();
    const eventId = `evt_t5_${Date.now()}`;
    const prisma = new PrismaClient({
      datasources: { db: { url: getDatabaseUrl() } },
    });

    try {
      const webhookRes = await fetch(`${baseUrl}/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: eventId,
          order_id: orderId,
          status: PaymentStatus.paid,
          amount: 1290,
          currency: 'RUB',
          created_at: new Date().toISOString(),
        }),
      });
      expect(webhookRes.status).toBe(200);
      const webhookBody = (await webhookRes.json()) as { duplicate: boolean };
      expect(webhookBody.duplicate).toBe(false);

      const missingOrder = await prisma.order.findUnique({
        where: { id: orderId },
      });
      expect(missingOrder).toBeNull();

      const buffered = await prisma.paymentEvent.findUnique({
        where: { eventId },
      });
      expect(buffered).not.toBeNull();
      expect(buffered!.orderId).toBe(orderId);
      expect(buffered!.processedAt).toBeNull();
      expect(buffered!.status).toBe(PaymentStatus.paid);

      const createRes = await fetch(`${baseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: TEST_SKU, id: orderId }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: string;
        status: string;
        code: string | null;
      };
      expect(created.id).toBe(orderId);
      expect([
        OrderStatus.paid,
        OrderStatus.delivering,
        OrderStatus.delivered,
      ]).toContain(created.status);

      const orderRes = await fetch(`${baseUrl}/orders/${orderId}`);
      expect(orderRes.status).toBe(200);
      const order = (await orderRes.json()) as {
        status: string;
        code: string | null;
      };
      expect(order.status).toBe(OrderStatus.delivered);
      expect(order.code).toEqual(expect.any(String));
      expect(order.code!.length).toBeGreaterThan(0);

      const applied = await prisma.paymentEvent.findUnique({
        where: { eventId },
      });
      expect(applied).not.toBeNull();
      expect(applied!.processedAt).not.toBeNull();

      const assignedKeys = await prisma.inventoryKey.findMany({
        where: { orderId },
      });
      expect(assignedKeys).toHaveLength(1);
      expect(assignedKeys[0]!.code).toBe(order.code);

      const providerRequests = await prisma.providerRequest.findMany({
        where: { orderId, outcome: 'ok' },
      });
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]!.code).toBe(order.code);

      const dupRes = await fetch(`${baseUrl}/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: eventId,
          order_id: orderId,
          status: PaymentStatus.paid,
          amount: 1290,
          currency: 'RUB',
          created_at: new Date().toISOString(),
        }),
      });
      expect(dupRes.status).toBe(200);
      const dupBody = (await dupRes.json()) as { duplicate: boolean };
      expect(dupBody.duplicate).toBe(true);

      const afterDupRes = await fetch(`${baseUrl}/orders/${orderId}`);
      expect(afterDupRes.status).toBe(200);
      const afterDup = (await afterDupRes.json()) as {
        status: string;
        code: string | null;
      };
      expect(afterDup.status).toBe(OrderStatus.delivered);
      expect(afterDup.code).toBe(order.code);

      const keysAfterDup = await prisma.inventoryKey.count({
        where: { orderId },
      });
      expect(keysAfterDup).toBe(1);

      const okRequestsAfterDup = await prisma.providerRequest.count({
        where: { orderId, outcome: 'ok' },
      });
      expect(okRequestsAfterDup).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
