import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import {
  resetPostgresData,
  setupPostgresSuite,
  teardownPostgresSuite,
} from './helpers/postgres';

describe('PostgreSQL test harness (e2e)', () => {
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
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('boots Nest in-process against PostgreSQL with seeded catalog', async () => {
    const prisma = new PrismaClient();
    const productCount = await prisma.product.count();
    await prisma.$disconnect();

    expect(app).toBeDefined();
    expect(productCount).toBeGreaterThan(0);
  });

  it('listens on a random port, not :3000', async () => {
    await app.listen(0);
    const server = app.getHttpServer();
    const address = server.address();

    expect(typeof address).toBe('object');
    expect(address).not.toBeNull();
    if (address && typeof address === 'object' && 'port' in address) {
      expect(address.port).not.toBe(3000);
      expect(address.port).toBeGreaterThan(0);
    }
  });
});
