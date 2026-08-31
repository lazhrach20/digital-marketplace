import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { FulfillmentOutcome, OrderStatus, PaymentStatus, ProviderId } from '../src/domain/enums';
import { requestIdFor } from '../src/domain/fulfillment-policy';
import {
  getDatabaseUrl,
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

const TEST_SKU = 'KEY-CS2-PRIME';
const ENV_ALWAYS_DOWN = 'PROVIDER_A_ALWAYS_DOWN';
const ENV_TIMEOUT_THEN_OK = 'PROVIDER_A_FORCE_TIMEOUT_THEN_OK';

type OrderResponse = {
  id: string;
  sku: string;
  status: string;
  amount: number;
  currency: string;
  code: string | null;
};

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

describe('T7 A-to-B fallback (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let previousAlwaysDown: string | undefined;
  let previousTimeoutThenOk: string | undefined;

  beforeAll(async () => {
    previousAlwaysDown = process.env[ENV_ALWAYS_DOWN];
    previousTimeoutThenOk = process.env[ENV_TIMEOUT_THEN_OK];
    process.env[ENV_ALWAYS_DOWN] = '1';
    delete process.env[ENV_TIMEOUT_THEN_OK];
    await setupPostgresSuite();
  });

  afterAll(async () => {
    restoreEnv(ENV_ALWAYS_DOWN, previousAlwaysDown);
    restoreEnv(ENV_TIMEOUT_THEN_OK, previousTimeoutThenOk);
    await teardownPostgresSuite();
  });

  beforeEach(async () => {
    process.env[ENV_ALWAYS_DOWN] = '1';
    delete process.env[ENV_TIMEOUT_THEN_OK];
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

  it('A unavailable/5xx → fallback B → exactly one delivery', async () => {
    const createRes = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: TEST_SKU }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as OrderResponse;
    expect(created.status).toBe(OrderStatus.created);
    expect(created.code).toBeNull();

    const webhookRes = await fetch(`${baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: `evt_t7_${Date.now()}`,
        order_id: created.id,
        status: PaymentStatus.paid,
      }),
    });
    expect(webhookRes.status).toBe(200);
    const webhookBody = (await webhookRes.json()) as { duplicate: boolean };
    expect(webhookBody.duplicate).toBe(false);

    const orderRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(orderRes.status).toBe(200);
    const delivered = (await orderRes.json()) as OrderResponse;
    expect(delivered.status).toBe(OrderStatus.delivered);
    expect(delivered.code).toEqual(expect.any(String));
    expect(delivered.code!.length).toBeGreaterThan(0);

    const againRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(againRes.status).toBe(200);
    const again = (await againRes.json()) as OrderResponse;
    expect(again.status).toBe(OrderStatus.delivered);
    expect(again.code).toBe(delivered.code);

    const prisma = new PrismaClient({
      datasources: { db: { url: getDatabaseUrl() } },
    });
    try {
      const boundKeys = await prisma.inventoryKey.findMany({
        where: { orderId: created.id },
      });
      expect(boundKeys).toHaveLength(1);
      expect(boundKeys[0].code).toBe(delivered.code);

      const bRequest = await prisma.providerRequest.findUnique({
        where: { requestId: requestIdFor(created.id, ProviderId.B) },
      });
      expect(bRequest).not.toBeNull();
      expect(bRequest!.provider).toBe(ProviderId.B);
      expect(bRequest!.outcome).toBe(FulfillmentOutcome.ok);
      expect(bRequest!.code).toBe(delivered.code);

      const aOkCount = await prisma.providerRequest.count({
        where: {
          orderId: created.id,
          provider: ProviderId.A,
          outcome: FulfillmentOutcome.ok,
        },
      });
      expect(aOkCount).toBe(0);

      const okRequests = await prisma.providerRequest.count({
        where: { orderId: created.id, outcome: FulfillmentOutcome.ok },
      });
      expect(okRequests).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });
});
