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
  duplicate: boolean;
};

type OrderResponse = {
  id: string;
  status: OrderStatus;
  code: string | null;
};

async function createNestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

function listenBaseUrl(app: INestApplication): string {
  const server = app.getHttpServer();
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  expect(address.port).not.toBe(3000);
  return `http://127.0.0.1:${address.port}`;
}

async function createOrder(baseUrl: string, sku: string): Promise<OrderResponse> {
  const response = await fetch(`${baseUrl}/api/orders`, {
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

async function getOrder(baseUrl: string, orderId: string): Promise<OrderResponse> {
  const response = await fetch(
    `${baseUrl}/api/orders/${encodeURIComponent(orderId)}`,
  );
  if (!response.ok) {
    throw new Error(
      `GET /api/orders/${orderId} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<OrderResponse>;
}

async function postWebhook(
  baseUrl: string,
  body: PaymentWebhookBody,
): Promise<{ status: number; body: WebhookResponse }> {
  const response = await fetch(`${baseUrl}/api/webhooks/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: WebhookResponse;
  try {
    parsed = JSON.parse(text) as WebhookResponse;
  } catch {
    throw new Error(`Webhook response is not JSON (${response.status}): ${text}`);
  }

  return { status: response.status, body: parsed };
}

describe('T3 — 50 parallel paid webhooks (e2e)', () => {
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
    app = await createNestApp();
    await app.listen(0);
    baseUrl = listenBaseUrl(app);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('50 parallel paid events on one order consume exactly one InventoryKey', async () => {
    const order = await createOrder(baseUrl, TEST_SKU);
    expect(order.status).toBe(OrderStatus.created);
    expect(order.code).toBeNull();

    const now = new Date().toISOString();
    const eventIds = Array.from(
      { length: PARALLEL_COUNT },
      (_, index) =>
        `evt_t3_${String(index + 1).padStart(3, '0')}_${Date.now()}_${index}`,
    );
    expect(new Set(eventIds).size).toBe(PARALLEL_COUNT);

    const results = await Promise.all(
      eventIds.map((eventId) =>
        postWebhook(baseUrl, {
          event_id: eventId,
          order_id: order.id,
          status: PaymentStatus.paid,
          amount: 1290,
          currency: 'RUB',
          created_at: now,
        }),
      ),
    );

    expect(results).toHaveLength(PARALLEL_COUNT);
    for (const result of results) {
      expect(result.status).toBe(200);
    }

    const delivered = await getOrder(baseUrl, order.id);
    expect(delivered.status).toBe(OrderStatus.delivered);
    expect(delivered.code).toEqual(expect.any(String));
    expect(delivered.code!.length).toBeGreaterThan(0);

    const prisma = new PrismaClient({
      datasources: { db: { url: getDatabaseUrl() } },
    });
    try {
      const assignedKeys = await prisma.inventoryKey.findMany({
        where: { orderId: order.id },
      });
      expect(assignedKeys).toHaveLength(1);
      expect(assignedKeys[0]!.code).toBe(delivered.code);

      const boundKeys = await prisma.inventoryKey.count({
        where: { orderId: { not: null } },
      });
      expect(boundKeys).toBe(1);

      const storedEvents = await prisma.paymentEvent.findMany({
        where: { orderId: order.id },
      });
      expect(storedEvents).toHaveLength(PARALLEL_COUNT);
      expect(new Set(storedEvents.map((event) => event.eventId)).size).toBe(
        PARALLEL_COUNT,
      );

      const providerRequests = await prisma.providerRequest.findMany({
        where: { orderId: order.id, outcome: 'ok' },
      });
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]!.code).toBe(delivered.code);
    } finally {
      await prisma.$disconnect();
    }
  });
});
