import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { GatewayTimeoutError, UpstreamError } from '@/types/errors.js';
import type { JwtAccessTokenClaims, RouteConfig } from '@/types/index.js';

vi.mock('@/services/audit.service.js', () => ({
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/services/token.service.js', () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(1),
  },
}));

const { writeAuditEvent } = await import('@/services/audit.service.js');
const { redis } = await import('@/services/token.service.js');
const {
  auditAllowedIfFlagged,
  buildIdentityHeaders,
  dispatchToUpstream,
  enforceAuthorization,
  resolveRoute,
  stripSpoofedHeaders,
} = await import('@/services/proxy.service.js');

function baseRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    path: '/api/users/*rest',
    upstream: 'http://127.0.0.1:1',
    auth_required: true,
    required_scope: null,
    allowed_roles: null,
    rate_limit_override: null,
    strip_prefix: false,
    timeout_ms: 1_000,
    audit_allowed_requests: false,
    ...overrides,
  };
}

const claims: JwtAccessTokenClaims = {
  sub: 'abc-123',
  email: 'user@example.com',
  roles: ['viewer'],
  auth_method: 'password',
  tenant_id: null,
  scope: 'openid profile email',
  iat: 0,
  exp: 0,
  nbf: 0,
  iss: 'gateway',
  aud: 'gateway',
  jti: 'jti-1',
};

function makeReqRes(overrides: { ip?: string; userAgent?: string } = {}): { req: Request; res: Response } {
  const headers: Record<string, string> = {};
  if (overrides.userAgent) headers['user-agent'] = overrides.userAgent;
  const req = {
    ip: overrides.ip ?? '203.0.113.7',
    headers,
    originalUrl: '/api/users/profile',
  } as unknown as Request;
  const res = {
    setHeader: vi.fn(),
  } as unknown as Response;
  return { req, res };
}

beforeEach(() => {
  vi.mocked(writeAuditEvent).mockClear();
  vi.mocked(redis.incr).mockReset().mockResolvedValue(1);
  vi.mocked(redis.pexpire).mockReset().mockResolvedValue(1);
});

describe('resolveRoute', () => {
  const routes = [
    baseRoute({ path: '/api/users/*rest' }),
    baseRoute({ path: '/api/public/*rest', auth_required: false }),
  ];

  it('resolves a route by matching path', () => {
    const resolved = resolveRoute('/api/users/profile', routes);
    expect(resolved?.route.path).toBe('/api/users/*rest');
  });

  it('returns null when no route matches', () => {
    expect(resolveRoute('/api/unknown/thing', routes)).toBeNull();
  });

  it('forwards the full original path when strip_prefix is false', () => {
    const resolved = resolveRoute('/api/users/profile/settings', routes);
    expect(resolved?.forwardPath).toBe('/api/users/profile/settings');
  });

  it('strips the static prefix when strip_prefix is true', () => {
    const stripped = [baseRoute({ path: '/api/admin/*rest', strip_prefix: true })];
    const resolved = resolveRoute('/api/admin/settings/general', stripped);
    expect(resolved?.forwardPath).toBe('/settings/general');
  });

  it('forwards "/" when strip_prefix leaves nothing after the prefix', () => {
    // An exact-literal pattern (no wildcard) that matches the request path
    // verbatim is the only way for the post-strip remainder to be empty.
    const stripped = [baseRoute({ path: '/api/status', strip_prefix: true })];
    const resolved = resolveRoute('/api/status', stripped);
    expect(resolved?.forwardPath).toBe('/');
  });
});

describe('stripSpoofedHeaders', () => {
  it('strips client-supplied X-User-*, X-Auth-Method, and X-Tenant-Id headers', () => {
    const headers: Record<string, unknown> = {
      'x-user-id': 'attacker',
      'x-user-email': 'attacker@evil.example',
      'x-user-roles': 'admin',
      'x-auth-method': 'password',
      'x-tenant-id': 'attacker-tenant',
      'content-type': 'application/json',
    };
    stripSpoofedHeaders(headers);
    expect(headers['x-user-id']).toBeUndefined();
    expect(headers['x-user-email']).toBeUndefined();
    expect(headers['x-user-roles']).toBeUndefined();
    expect(headers['x-auth-method']).toBeUndefined();
    expect(headers['x-tenant-id']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('buildIdentityHeaders', () => {
  it('injects the correct identity headers from claims (AC-26)', () => {
    const headers = buildIdentityHeaders(claims, 'req-uuid-1');
    expect(headers).toEqual({
      'x-user-id': 'abc-123',
      'x-user-email': 'user@example.com',
      'x-user-roles': 'viewer',
      'x-auth-method': 'password',
      'x-request-id': 'req-uuid-1',
    });
  });

  it('includes x-tenant-id only when tenant_id is non-null', () => {
    const withTenant = buildIdentityHeaders({ ...claims, tenant_id: 'tenant-9' }, 'req-uuid-2');
    expect(withTenant['x-tenant-id']).toBe('tenant-9');

    const withoutTenant = buildIdentityHeaders(claims, 'req-uuid-3');
    expect(withoutTenant['x-tenant-id']).toBeUndefined();
  });

  it('comma-joins multiple roles', () => {
    const headers = buildIdentityHeaders({ ...claims, roles: ['viewer', 'editor'] }, 'req-uuid-4');
    expect(headers['x-user-roles']).toBe('viewer,editor');
  });
});

describe('enforceAuthorization', () => {
  it('allows a request with no role/scope restrictions and writes no denial audit', async () => {
    const { req, res } = makeReqRes();
    const route = baseRoute();
    const result = await enforceAuthorization(route, claims, req, res);
    expect(result).toBeNull();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('passes an auth_required: false route through unauthenticated (no claims)', async () => {
    const { req, res } = makeReqRes();
    const route = baseRoute({ auth_required: false });
    const result = await enforceAuthorization(route, undefined, req, res);
    expect(result).toBeNull();
  });

  it('denies with 403 forbidden when the user role is not in allowed_roles (AC-32)', async () => {
    const { req, res } = makeReqRes();
    const route = baseRoute({ allowed_roles: ['admin'] });
    const result = await enforceAuthorization(route, claims, req, res);
    expect(result?.statusCode).toBe(403);
    expect(result?.code).toBe('forbidden');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'proxy.request_denied', outcome: 'denied', user_id: 'abc-123' }),
    );
  });

  it('allows when the user role intersects allowed_roles', async () => {
    const { req, res } = makeReqRes();
    const route = baseRoute({ allowed_roles: ['admin', 'viewer'] });
    const result = await enforceAuthorization(route, claims, req, res);
    expect(result).toBeNull();
  });

  it('denies with 403 insufficient_scope when required_scope is not granted', async () => {
    const { req, res } = makeReqRes();
    const route = baseRoute({ required_scope: 'api:write' });
    const result = await enforceAuthorization(route, claims, req, res);
    expect(result?.statusCode).toBe(403);
    expect(result?.code).toBe('insufficient_scope');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'proxy.request_denied', outcome: 'denied' }),
    );
  });

  it('allows when required_scope is present in the token scope', async () => {
    const { req, res } = makeReqRes();
    const route = baseRoute({ required_scope: 'api:read' });
    const result = await enforceAuthorization({ ...route }, { ...claims, scope: 'openid api:read' }, req, res);
    expect(result).toBeNull();
  });

  it('denies with 429 and writes a denial audit when the rate limit is exceeded', async () => {
    vi.mocked(redis.incr).mockResolvedValue(999);
    const { req, res } = makeReqRes();
    const route = baseRoute({ rate_limit_override: 1 });
    const result = await enforceAuthorization(route, claims, req, res);
    expect(result?.statusCode).toBe(429);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'proxy.request_denied', outcome: 'denied' }),
    );
  });
});

describe('auditAllowedIfFlagged', () => {
  const { req } = makeReqRes();

  it('skips the audit write when audit_allowed_requests is false', async () => {
    await auditAllowedIfFlagged(baseRoute({ audit_allowed_requests: false }), req, claims);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('skips the audit write when audit_allowed_requests is omitted-default (false)', async () => {
    await auditAllowedIfFlagged(baseRoute(), req, claims);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('writes proxy.request_allowed when audit_allowed_requests is true (AC-36)', async () => {
    await auditAllowedIfFlagged(baseRoute({ audit_allowed_requests: true }), req, claims);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'proxy.request_allowed', outcome: 'success', user_id: 'abc-123' }),
    );
  });
});

// ---------------------------------------------------------------------------
// dispatchToUpstream — exercises real (loopback, no Docker) TCP servers,
// since http-proxy-middleware pipes real streams; there is no meaningful way
// to mock the network layer here without reimplementing it.
// ---------------------------------------------------------------------------

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('dispatchToUpstream', () => {
  it('proxies the request through to the upstream and resolves on completion', async () => {
    const { server: upstream, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const route = baseRoute({ upstream: `http://127.0.0.1:${port}` });
    const { server: gateway, port: gatewayPort } = await startServer((req, res) => {
      void dispatchToUpstream(route, '/profile', req as unknown as Request, res as unknown as Response);
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/anything`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await closeServer(gateway);
    await closeServer(upstream);
  });

  it('passes an upstream 5xx response through verbatim (not translated to 502)', async () => {
    const { server: upstream, port } = await startServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    });

    const route = baseRoute({ upstream: `http://127.0.0.1:${port}` });
    const { server: gateway, port: gatewayPort } = await startServer((req, res) => {
      void dispatchToUpstream(route, '/x', req as unknown as Request, res as unknown as Response);
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/anything`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'upstream_unavailable' });

    await closeServer(gateway);
    await closeServer(upstream);
  });

  it('maps a connection failure to a 502 UpstreamError (bad_gateway)', async () => {
    // Bind then release a port so nothing is listening on it.
    const probe = await startServer(() => undefined);
    await closeServer(probe.server);

    const route = baseRoute({ upstream: `http://127.0.0.1:${probe.port}`, timeout_ms: 2_000 });
    const { server: gateway, port: gatewayPort } = await startServer((req, res) => {
      dispatchToUpstream(route, '/x', req as unknown as Request, res as unknown as Response).catch(
        (error: UpstreamError) => {
          res.writeHead(error.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error.code }));
        },
      );
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/anything`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'bad_gateway' });

    await closeServer(gateway);
  });

  it('maps an upstream timeout to a 504 GatewayTimeoutError (gateway_timeout)', async () => {
    const { server: upstream, port } = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('too late');
      }, 500);
    });

    const route = baseRoute({ upstream: `http://127.0.0.1:${port}`, timeout_ms: 50 });
    const { server: gateway, port: gatewayPort } = await startServer((req, res) => {
      dispatchToUpstream(route, '/x', req as unknown as Request, res as unknown as Response).catch(
        (error: GatewayTimeoutError) => {
          res.writeHead(error.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: error.code }));
        },
      );
    });

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/anything`);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'gateway_timeout' });

    await closeServer(gateway);
    await closeServer(upstream);
  }, 10_000);

  it('settles (does not hang) when the client disconnects mid-request', async () => {
    const { server: upstream, port } = await startServer(() => {
      // Deliberately never responds — the client disconnects before this matters.
    });

    const route = baseRoute({ upstream: `http://127.0.0.1:${port}`, timeout_ms: 5_000 });
    let settled = false;
    let settledWithError: unknown;
    let handlerInvoked = false;

    const { server: gateway, port: gatewayPort } = await startServer((req, res) => {
      handlerInvoked = true;
      dispatchToUpstream(route, '/x', req as unknown as Request, res as unknown as Response).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          settledWithError = error;
        },
      );
    });

    // Raw http.request + an abrupt .destroy() on the client socket — more
    // reliable than aborting a fetch() for forcing an immediate server-side
    // 'close' (undici's connection pooling can otherwise delay it).
    const clientReq = http.request({ host: '127.0.0.1', port: gatewayPort, path: '/anything' });
    clientReq.on('error', () => undefined); // destroy() below deliberately triggers ECONNRESET on this end
    clientReq.end();

    for (let attempt = 0; attempt < 50 && !handlerInvoked; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(handlerInvoked).toBe(true);

    clientReq.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(settled).toBe(true);
    expect(settledWithError).toBeUndefined();

    // Force-close rather than the graceful `closeServer` helper: the
    // never-responding upstream may still have a lingering outbound
    // connection from the gateway that a graceful close would wait on.
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await closeServer(gateway);
    await closeServer(upstream);
  });
});
