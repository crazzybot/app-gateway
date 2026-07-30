/**
 * Integration tests for `ALL /api/{service}/{path}` (AC-25, AC-26, AC-27,
 * AC-32, AC-36) — real Postgres + Redis via Testcontainers (globalSetup),
 * plus a handful of real loopback HTTP servers standing in for upstream
 * services.
 *
 * Unlike the other integration test files, this one cannot use a static
 * `import { app } from '@/index.js'` at the top of the file: the route
 * configuration must point at upstream servers whose ports are only known
 * once they're listening, and `config/env.ts`/`config/routes.ts` both read
 * `process.env` exactly once, at module-evaluation time. `@/index.js` is
 * imported dynamically inside `beforeAll`, after the port numbers are known,
 * the temp routes file is written, and `UPSTREAM_SERVICES_CONFIG_PATH` is
 * overridden — the same dynamic-import-after-env-override pattern
 * `auth.test.ts` uses for `seedUser`.
 *
 * Critically, `seedUser` must ALSO be imported dynamically here (not
 * statically like `auth.test.ts` does) — its own import chain
 * (`db/client.ts` → `config/env.ts`) would otherwise evaluate `env.ts` at
 * this file's static-import time, permanently freezing
 * `env.UPSTREAM_SERVICES_CONFIG_PATH` to globalSetup's default before
 * `beforeAll` ever runs, since ESM re-imports of an already-evaluated
 * module return the same cached module, not a re-read of `process.env`.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Express } from 'express';
import { and, eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteConfig, TokenResponse } from '@/types/index.js';
import type { SeedUserInput } from '../helpers/seedUser.js';

function body<T>(res: Response): T {
  return res.body as T;
}

function uniqueEmail(): string {
  return `proxy-test-${randomUUID()}@example.com`;
}

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  url: string | undefined;
  body: string;
}

interface TestUpstream {
  server: http.Server;
  port: number;
  requests: CapturedRequest[];
}

function startEchoUpstream(): Promise<TestUpstream> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests });
    });
  });
}

function startSlowUpstream(delayMs: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('too late');
      }, delayMs);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function loginAndGetToken(roles: string[]): Promise<{ accessToken: string; userId: string; email: string }> {
  const email = uniqueEmail();
  const password = 'correct-horse-battery-staple';
  const seeded = await seedUser({ email, password, roles } satisfies SeedUserInput);

  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email, password });
  expect(res.status).toBe(200);
  const loginBody = body<TokenResponse>(res);
  return { accessToken: loginBody.access_token, userId: seeded.id, email };
}

// ---------------------------------------------------------------------------
// Fixture upstreams + route config, wired up before any app import
// ---------------------------------------------------------------------------

let privateUpstream: TestUpstream;
let publicUpstream: TestUpstream;
let adminUpstream: TestUpstream;
let scopedUpstream: TestUpstream;
let limitedUpstream: TestUpstream;
let slowUpstream: { server: http.Server; port: number };

let app: Express;
let db: typeof import('@/db/client.js')['db'];
let auditLog: typeof import('@/db/schema.js')['auditLog'];
let redis: typeof import('@/services/token.service.js')['redis'];
let seedUser: typeof import('../helpers/seedUser.js')['seedUser'];
let closeConnections: typeof import('./helpers/closeConnections.js')['closeConnections'];

const SLOW_TIMEOUT_MS = 100;
const SLOW_UPSTREAM_DELAY_MS = 1_500;

beforeAll(async () => {
  [privateUpstream, publicUpstream, adminUpstream, scopedUpstream, limitedUpstream] = await Promise.all([
    startEchoUpstream(),
    startEchoUpstream(),
    startEchoUpstream(),
    startEchoUpstream(),
    startEchoUpstream(),
  ]);
  slowUpstream = await startSlowUpstream(SLOW_UPSTREAM_DELAY_MS);

  const routes: RouteConfig[] = [
    {
      path: '/api/private/*rest',
      upstream: `http://127.0.0.1:${privateUpstream.port}`,
      auth_required: true,
      required_scope: null,
      allowed_roles: null,
      rate_limit_override: null,
      strip_prefix: false,
      timeout_ms: 30_000,
      audit_allowed_requests: true,
    },
    {
      path: '/api/public/*rest',
      upstream: `http://127.0.0.1:${publicUpstream.port}`,
      auth_required: false,
      required_scope: null,
      allowed_roles: null,
      rate_limit_override: null,
      strip_prefix: false,
      timeout_ms: 30_000,
      audit_allowed_requests: false,
    },
    {
      path: '/api/admin/*rest',
      upstream: `http://127.0.0.1:${adminUpstream.port}`,
      auth_required: true,
      required_scope: null,
      allowed_roles: ['admin'],
      rate_limit_override: null,
      strip_prefix: false,
      timeout_ms: 30_000,
      audit_allowed_requests: false,
    },
    {
      path: '/api/scoped/*rest',
      upstream: `http://127.0.0.1:${scopedUpstream.port}`,
      auth_required: true,
      required_scope: 'api:write',
      allowed_roles: null,
      rate_limit_override: null,
      strip_prefix: false,
      timeout_ms: 30_000,
      audit_allowed_requests: false,
    },
    {
      path: '/api/limited/*rest',
      upstream: `http://127.0.0.1:${limitedUpstream.port}`,
      auth_required: false,
      required_scope: null,
      allowed_roles: null,
      rate_limit_override: 1,
      strip_prefix: false,
      timeout_ms: 30_000,
      audit_allowed_requests: false,
    },
    {
      path: '/api/slow/*rest',
      upstream: `http://127.0.0.1:${slowUpstream.port}`,
      auth_required: false,
      required_scope: null,
      allowed_roles: null,
      rate_limit_override: null,
      strip_prefix: false,
      timeout_ms: SLOW_TIMEOUT_MS,
      audit_allowed_requests: false,
    },
  ];

  const dir = mkdtempSync(path.join(tmpdir(), 'proxy-routes-'));
  const routesPath = path.join(dir, 'routes.json');
  writeFileSync(routesPath, JSON.stringify(routes));

  process.env['UPSTREAM_SERVICES_CONFIG_PATH'] = routesPath;
  // Fixed regardless of the local .env's value, so `required_scope` tests
  // below don't depend on an untracked file's contents.
  process.env['DEFAULT_USER_SCOPE'] = 'openid profile email api:read';

  ({ app } = await import('@/index.js'));
  ({ db } = await import('@/db/client.js'));
  ({ auditLog } = await import('@/db/schema.js'));
  ({ redis } = await import('@/services/token.service.js'));
  ({ seedUser } = await import('../helpers/seedUser.js'));
  ({ closeConnections } = await import('./helpers/closeConnections.js'));
});

afterAll(async () => {
  await closeConnections();
  await Promise.all(
    [privateUpstream, publicUpstream, adminUpstream, scopedUpstream, limitedUpstream]
      .map((u) => stopServer(u.server))
      .concat(stopServer(slowUpstream.server)),
  );
});

// ---------------------------------------------------------------------------
// AC-25 — unauthenticated request to an auth_required route
// ---------------------------------------------------------------------------

describe('ALL /api/private/* — auth_required: true (AC-25)', () => {
  it('rejects an unauthenticated request with 401 and never reaches the upstream', async () => {
    const before = privateUpstream.requests.length;
    const res = await request(app).get('/api/private/unauthenticated-check');
    expect(res.status).toBe(401);
    expect(privateUpstream.requests.length).toBe(before);
  });

  it('writes a proxy.request_denied audit entry for the 401 (FR-19)', async () => {
    const res = await request(app).get('/api/private/audited-401-check');
    expect(res.status).toBe(401);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.eventType, 'proxy.request_denied'), eq(auditLog.resource, '/api/private/audited-401-check')),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// AC-26, AC-27 — identity header injection + spoofed header stripping
// ---------------------------------------------------------------------------

describe('ALL /api/private/* — identity headers (AC-26, AC-27)', () => {
  it('injects gateway-derived identity headers and strips client-supplied ones', async () => {
    const { accessToken, userId, email } = await loginAndGetToken(['viewer']);

    const res = await request(app)
      .get('/api/private/profile')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-User-Id', 'attacker')
      .set('X-User-Email', 'attacker@evil.example')
      .set('X-User-Roles', 'admin')
      .set('X-Auth-Method', 'oauth')
      .set('X-Tenant-Id', 'attacker-tenant');

    expect(res.status).toBe(200);

    const upstreamReq = privateUpstream.requests.at(-1);
    expect(upstreamReq).toBeDefined();
    expect(upstreamReq?.headers['x-user-id']).toBe(userId);
    expect(upstreamReq?.headers['x-user-email']).toBe(email);
    expect(upstreamReq?.headers['x-user-roles']).toBe('viewer');
    expect(upstreamReq?.headers['x-auth-method']).toBe('password');
    expect(typeof upstreamReq?.headers['x-request-id']).toBe('string');
    // This user has no tenant_id, so the header should be absent entirely —
    // not merely overwritten — proving the spoofed value was stripped, not
    // just shadowed by a later (non-existent) injection.
    expect(upstreamReq?.headers['x-tenant-id']).toBeUndefined();
  });

  it('streams a JSON POST body through to the upstream verbatim', async () => {
    const { accessToken } = await loginAndGetToken(['viewer']);

    const res = await request(app)
      .post('/api/private/create-thing')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'widget', quantity: 3 });

    expect(res.status).toBe(200);

    const upstreamReq = privateUpstream.requests.at(-1);
    expect(upstreamReq).toBeDefined();
    expect(JSON.parse(upstreamReq?.body ?? '')).toEqual({ name: 'widget', quantity: 3 });
  });
});

// ---------------------------------------------------------------------------
// Public route — unauthenticated pass-through
// ---------------------------------------------------------------------------

describe('ALL /api/public/* — auth_required: false', () => {
  it('passes an unauthenticated request through with no identity headers', async () => {
    const res = await request(app).get('/api/public/anything');
    expect(res.status).toBe(200);

    const upstreamReq = publicUpstream.requests.at(-1);
    expect(upstreamReq?.headers['x-user-id']).toBeUndefined();
    expect(upstreamReq?.headers['x-user-email']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-32 — insufficient role
// ---------------------------------------------------------------------------

describe('ALL /api/admin/* — allowed_roles: ["admin"] (AC-32)', () => {
  it('denies a viewer with 403 forbidden and writes a proxy.request_denied audit entry', async () => {
    const { accessToken } = await loginAndGetToken(['viewer']);

    const res = await request(app)
      .get('/api/admin/settings')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
    expect(body<{ error: string; error_description: string }>(res)).toEqual({
      error: 'forbidden',
      error_description: 'Insufficient role',
      request_id: expect.any(String) as unknown as string,
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.eventType, 'proxy.request_denied'), eq(auditLog.resource, '/api/admin/settings')));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)?.outcome).toBe('denied');
  });

  it('allows an admin through to the upstream', async () => {
    const { accessToken } = await loginAndGetToken(['admin']);

    const res = await request(app)
      .get('/api/admin/settings')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Insufficient scope → 403
// ---------------------------------------------------------------------------

describe('ALL /api/scoped/* — required_scope: "api:write"', () => {
  it('denies a token without the required scope with 403 insufficient_scope', async () => {
    const { accessToken } = await loginAndGetToken(['viewer']);

    const res = await request(app)
      .get('/api/scoped/thing')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
    expect(body<{ error: string }>(res).error).toBe('insufficient_scope');
  });
});

// ---------------------------------------------------------------------------
// Rate limit → 429
// ---------------------------------------------------------------------------

describe('ALL /api/limited/* — rate_limit_override: 1', () => {
  it('returns 429 with Retry-After once the per-route limit is exceeded', async () => {
    // Every proxied request shares the same IP-keyed rate-limit counter
    // (middleware/rateLimiter.ts), so start this route's counter from a
    // known-clean state rather than depending on test execution order.
    await redis.flushdb();

    const first = await request(app).get('/api/limited/one');
    expect(first.status).toBe(200);

    const second = await request(app).get('/api/limited/two');
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Upstream timeout → 504
// ---------------------------------------------------------------------------

describe('ALL /api/slow/* — timeout_ms shorter than the upstream response', () => {
  it('returns 504 gateway_timeout when the upstream exceeds timeout_ms', async () => {
    const res = await request(app).get('/api/slow/anything');
    expect(res.status).toBe(504);
    expect(body<{ error: string }>(res).error).toBe('gateway_timeout');
  }, 10_000);
});

// ---------------------------------------------------------------------------
// AC-36 — proxy.request_allowed gated by audit_allowed_requests
// ---------------------------------------------------------------------------

describe('proxy.request_allowed audit gating (AC-36)', () => {
  it('writes proxy.request_allowed only for the flagged route', async () => {
    const { accessToken } = await loginAndGetToken(['viewer']);

    const flaggedRes = await request(app)
      .get('/api/private/flagged-check')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(flaggedRes.status).toBe(200);

    const unflaggedRes = await request(app).get('/api/public/unflagged-check');
    expect(unflaggedRes.status).toBe(200);

    const flaggedRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.eventType, 'proxy.request_allowed'), eq(auditLog.resource, '/api/private/flagged-check')),
      );
    expect(flaggedRows.length).toBe(1);
    expect(flaggedRows[0]?.outcome).toBe('success');

    const unflaggedRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.eventType, 'proxy.request_allowed'), eq(auditLog.resource, '/api/public/unflagged-check')),
      );
    expect(unflaggedRows.length).toBe(0);
  });
});
