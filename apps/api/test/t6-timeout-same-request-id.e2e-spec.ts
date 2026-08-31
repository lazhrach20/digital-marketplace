import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { OrderStatus, PaymentStatus, ProviderId } from '../src/domain/enums';
import { requestIdFor } from '../src/domain/fulfillment-policy';
import {
  getDatabaseUrl,
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

const TEST_SKU = 'KEY-CS2-PRIME';

const ENV_TIMEOUT_THEN_OK = 'PROVIDER_A_FORCE_TIMEOUT_THEN_OK';
const ENV_TIMEOUT_MS = 'PROVIDER_TIMEOUT_MS';
const ENV_ALWAYS_DOWN = 'PROVIDER_A_ALWAYS_DOWN';

describe('T6 — timeout then same request_id (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let previousTimeoutThenOk: string | undefined;
  let previousTimeoutMs: string | undefined;
  let previousAlwaysDown: string | undefined;

  beforeAll(async () => {
    previousTimeoutThenOk = process.env[ENV_TIMEOUT_THEN_OK];
    previousTimeoutMs = process.env[ENV_TIMEOUT_MS];
    previousAlwaysDown = process.env[ENV_ALWAYS_DOWN];

    process.env[ENV_TIMEOUT_THEN_OK] = '1';
    process.env[ENV_TIMEOUT_MS] = '20';
    delete process.env[ENV_ALWAYS_DOWN];

    await setupPostgresSuite();
  });

  afterAll(async () => {
    restoreEnv(ENV_TIMEOUT_THEN_OK, previousTimeoutThenOk);
    restoreEnv(ENV_TIMEOUT_MS, previousTimeoutMs);
    restoreEnv(ENV_ALWAYS_DOWN, previousAlwaysDown);
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

  it('A times out after issuing; retry same request_id returns the same code, no second key', async () => {
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

    const webhookRes = await fetch(`${baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: `evt_t6_${Date.now()}`,
        order_id: created.id,
        status: PaymentStatus.paid,
      }),
    });
    expect(webhookRes.status).toBe(200);
    const webhookBody = (await webhookRes.json()) as { duplicate: boolean };
    expect(webhookBody.duplicate).toBe(false);

    const orderRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(orderRes.status).toBe(200);
    const delivered = (await orderRes.json()) as {
      status: string;
      code: string | null;
    };
    expect(delivered.status).toBe(OrderStatus.delivered);
    expect(delivered.code).toEqual(expect.any(String));
    expect(delivered.code).not.toBeNull();
    expect(delivered.code!.length).toBeGreaterThan(0);

    const againRes = await fetch(`${baseUrl}/orders/${created.id}`);
    expect(againRes.status).toBe(200);
    const again = (await againRes.json()) as { code: string | null };
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

      const boundTotal = await prisma.inventoryKey.count({
        where: { orderId: { not: null } },
      });
      expect(boundTotal).toBe(1);

      const providerRequests = await prisma.providerRequest.findMany({
        where: { orderId: created.id },
      });
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0].requestId).toBe(
        requestIdFor(created.id, ProviderId.A),
      );
      expect(providerRequests[0].provider).toBe(ProviderId.A);
      expect(providerRequests[0].code).toBe(delivered.code);
      expect(providerRequests[0].outcome).toBe('ok');
    } finally {
      await prisma.$disconnect();
    }
  });
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
