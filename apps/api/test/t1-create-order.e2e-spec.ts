import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { OrderStatus } from '../src/domain/enums';
import {
  getDatabaseUrl,
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

describe('T1 create order (e2e)', () => {
  let app: INestApplication;

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
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('POST /api/orders returns created with amount/currency from Product, not client', async () => {
    const sku = 'STEAM-TOPUP-500';
    const prisma = new PrismaClient({
      datasources: { db: { url: getDatabaseUrl() } },
    });

    try {
      const product = await prisma.product.findUniqueOrThrow({ where: { sku } });

      const address = app.getHttpServer().address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku,
          amount: 1,
          currency: 'USD',
        }),
      });

      expect(response.status).toBe(201);

      const body = (await response.json()) as {
        id: string;
        sku: string;
        status: string;
        amount: number;
        currency: string;
        code: string | null;
      };

      expect(body.status).toBe(OrderStatus.created);
      expect(body.sku).toBe(sku);
      expect(body.amount).toBe(product.price);
      expect(body.currency).toBe(product.currency);
      expect(body.amount).not.toBe(1);
      expect(body.currency).not.toBe('USD');
      expect(body.code).toBeNull();
      expect(body.id).toMatch(/^ord_/);

      const order = await prisma.order.findUnique({ where: { id: body.id } });
      expect(order).not.toBeNull();
      expect(order!.status).toBe(OrderStatus.created);
      expect(order!.amount).toBe(product.price);
      expect(order!.currency).toBe(product.currency);
    } finally {
      await prisma.$disconnect();
    }
  });
});
