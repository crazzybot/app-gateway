/**
 * Populates required env vars before any unit test file imports app code —
 * env.ts validates and freezes `process.env` at module-load time, so this
 * must run first (wired via vitest.config.ts `test.setupFiles`).
 *
 * Unit tests never hit real Postgres/Redis (CLAUDE.md: mock `pg`/`ioredis`
 * with `vi.mock`) — DATABASE_URL/REDIS_URL just need to satisfy Zod's URL
 * shape, not point at anything reachable.
 */

process.env['NODE_ENV'] ??= 'test';
process.env['DATABASE_URL'] ??= 'postgres://gateway:gateway_secret@localhost:5432/gateway_test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_PRIVATE_KEY_PATH'] ??= './tests/fixtures/keys/private.pem';
process.env['JWT_PUBLIC_KEY_PATH'] ??= './tests/fixtures/keys/public.pem';
process.env['JWT_KID'] ??= '11111111-1111-4111-8111-111111111111';
process.env['UPSTREAM_SERVICES_CONFIG_PATH'] ??= './upstream-services.json';
process.env['ENCRYPTION_KEY'] ??= 'InQ60gtOEuiPljXTssphsMbHb7lsWU9lldsmfSx03YA=';
process.env['GATEWAY_BASE_URL'] ??= 'http://localhost:3000';
