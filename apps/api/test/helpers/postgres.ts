import { execSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

const REPO_ROOT = path.resolve(__dirname, '../../../../');

let container: StartedPostgreSqlContainer | undefined;
let migrationsApplied = false;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Call setupPostgresSuite() first.');
  }
  return url;
}

function runPrismaCommand(command: string): void {
  const schemaPath = path.join(REPO_ROOT, 'prisma', 'schema.prisma');
  execSync(`npx prisma ${command} --schema="${schemaPath}"`, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: requireDatabaseUrl() },
    stdio: 'pipe',
  });
}

function runSeedScript(): void {
  execSync('npx tsx prisma/seed.ts', {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: requireDatabaseUrl() },
    stdio: 'pipe',
  });
}

/**
 * Starts PostgreSQL for tests.
 * Uses TEST_DATABASE_URL when set (dedicated test DB); otherwise Testcontainers.
 */
export async function startPostgresContainer(): Promise<string> {
  if (container) {
    return container.getConnectionUri();
  }

  const externalUrl = process.env.TEST_DATABASE_URL;
  if (externalUrl) {
    process.env.DATABASE_URL = externalUrl;
    return externalUrl;
  }

  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('marketplace')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();
  return process.env.DATABASE_URL;
}

/** Applies Prisma migrations once against the running test database. */
export function applyMigrations(): void {
  if (migrationsApplied) {
    return;
  }
  runPrismaCommand('migrate deploy');
  migrationsApplied = true;
}

/** Truncates mutable tables (orders, events, keys) while keeping catalog seedable. */
export async function truncateMutableData(): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: requireDatabaseUrl() } },
  });

  try {
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "ProviderRequest",
        "PaymentEvent",
        "InventoryKey",
        "Order",
        "Product"
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await prisma.$disconnect();
  }
}

/** Truncate + run prisma/seed.ts (catalog products + shared inventory pool). */
export async function seedDatabase(): Promise<void> {
  await truncateMutableData();
  runSeedScript();
}

/**
 * Per-suite setup: container, migrate once, fresh seed.
 * Call from test file beforeAll().
 */
export async function setupPostgresSuite(): Promise<string> {
  const databaseUrl = await startPostgresContainer();
  applyMigrations();
  await seedDatabase();
  return databaseUrl;
}

/** Reset data between tests without re-running migrations. */
export async function resetPostgresData(): Promise<void> {
  await seedDatabase();
}

/** Stop the Testcontainer. Call from test file afterAll(). */
export async function teardownPostgresSuite(): Promise<void> {
  if (container) {
    await container.stop();
    container = undefined;
  }

  migrationsApplied = false;
  delete process.env.DATABASE_URL;
}

export function getDatabaseUrl(): string {
  return requireDatabaseUrl();
}
