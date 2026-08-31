import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { OrderStatus } from '../src/domain/enums';
import {
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

const DEFAULT_SKU = 'KEY-CS2-PRIME';

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

describe('T4 — duplicate event_id (e2e)', () => {
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

  it('returns HTTP 200 and leaves order state unchanged on duplicate event_id', async () => {
    const order = await createOrder(baseUrl, DEFAULT_SKU);
    expect(order.status).toBe(OrderStatus.created);

    const eventId = `evt_t4_dup_${Date.now()}`;
    const payload: PaymentWebhookBody = {
      event_id: eventId,
      order_id: order.id,
      status: 'paid',
      amount: 1290,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    };

    const first = await postWebhook(baseUrl, payload);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);

    const afterFirst = await getOrder(baseUrl, order.id);
    expect(afterFirst.status).toBe(OrderStatus.paid);

    const second = await postWebhook(baseUrl, payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const afterSecond = await getOrder(baseUrl, order.id);
    expect(afterSecond.status).toBe(afterFirst.status);
  });
});
