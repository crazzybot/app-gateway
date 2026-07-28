/**
 * Vitest globalSetup for integration tests (CLAUDE.md: "Integration tests
 * use real services... via Testcontainers... Never mock the database or
 * Redis in integration tests").
 *
 * Runs once, before any integration test file is loaded. Starts real
 * Postgres 16 and Redis 7 containers, points DATABASE_URL/REDIS_URL (and
 * every other required env var) at them via process.env, then applies the
 * Drizzle migrations directly — env.ts and db/client.ts both read
 * process.env at *module* load time, so this must all happen here, before
 * any test file's imports execute.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const postgres = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: 'gateway_test',
      POSTGRES_USER: 'gateway',
      POSTGRES_PASSWORD: 'gateway_secret',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const databaseUrl = `postgres://gateway:gateway_secret@${postgres.getHost()}:${postgres.getMappedPort(5432)}/gateway_test`;
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['REDIS_URL'] = redisUrl;
  process.env['JWT_PRIVATE_KEY_PATH'] = './tests/fixtures/keys/private.pem';
  process.env['JWT_PUBLIC_KEY_PATH'] = './tests/fixtures/keys/public.pem';
  process.env['JWT_KID'] = '11111111-1111-4111-8111-111111111111';
  process.env['UPSTREAM_SERVICES_CONFIG_PATH'] = './upstream-services.json';
  process.env['ENCRYPTION_KEY'] = 'InQ60gtOEuiPljXTssphsMbHb7lsWU9lldsmfSx03YA=';
  process.env['GATEWAY_BASE_URL'] = 'http://localhost:3000';

  const migrationPool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(migrationPool), { migrationsFolder: './src/db/migrations' });
  await migrationPool.end();

  return async () => {
    await redis.stop();
    await postgres.stop();
  };
}
