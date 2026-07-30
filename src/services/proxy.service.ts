/**
 * Proxy service — the reverse-proxy core (FR-16–FR-20).
 *
 * Route resolution and header handling take `routes: RouteConfig[]` as an
 * explicit parameter rather than reading `config/routes.ts`'s module-level
 * export directly — keeps every function here a pure, independently
 * testable unit (per CLAUDE.md testing conventions) instead of depending on
 * process-wide startup state. `src/routes/proxy.router.ts` is the only
 * caller and supplies the loaded `routeConfig` array.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  createProxyMiddleware,
  type RequestHandler as ProxyRequestHandler,
} from 'http-proxy-middleware';
import { match, type MatchFunction, type ParamData } from 'path-to-regexp';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { writeAuditEvent } from './audit.service.js';
import {
  ForbiddenError,
  GatewayTimeoutError,
  InsufficientScopeError,
  UpstreamError,
  type AppError,
} from '../types/errors.js';
import type { AuditLogEntry, JwtAccessTokenClaims, RouteConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Route resolution (FR-16)
// ---------------------------------------------------------------------------

export interface ResolvedRoute {
  route: RouteConfig;
  /** The path to forward upstream — original, or with the matched static prefix stripped. */
  forwardPath: string;
}

const routeMatcherCache = new WeakMap<RouteConfig, MatchFunction<ParamData>>();

function getMatcher(route: RouteConfig): MatchFunction<ParamData> {
  let matcher = routeMatcherCache.get(route);
  if (!matcher) {
    matcher = match(route.path);
    routeMatcherCache.set(route, matcher);
  }
  return matcher;
}

/**
 * The literal path segment before the first path-to-regexp token
 * (`:name`, `*name`, `{`) in a route pattern — e.g. `/api/users` for
 * `/api/users/*rest`. Used to compute the `strip_prefix` forward path
 * without depending on a specific wildcard parameter name convention.
 */
function staticPrefixOf(pattern: string): string {
  const idx = pattern.search(/[:*{]/);
  const prefix = idx === -1 ? pattern : pattern.slice(0, idx);
  return prefix.endsWith('/') && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
}

export function resolveRoute(path: string, routes: RouteConfig[]): ResolvedRoute | null {
  for (const route of routes) {
    if (getMatcher(route)(path) !== false) {
      const forwardPath = route.strip_prefix
        ? path.slice(staticPrefixOf(route.path).length) || '/'
        : path;
      return { route, forwardPath };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Header stripping / injection (FR-17, FR-18)
// ---------------------------------------------------------------------------

/**
 * Client-supplied identity headers that must never reach the upstream
 * verbatim. FR-17 names only the first four; `x-tenant-id` is included too
 * (security review finding, confirmed by spec R-4) — `buildIdentityHeaders`
 * injects it exactly like the others when `claims.tenant_id` is set, and an
 * unauthenticated caller or a null-tenant user would otherwise be able to
 * forge it unopposed.
 */
const SPOOFABLE_IDENTITY_HEADERS = [
  'x-user-id',
  'x-user-email',
  'x-user-roles',
  'x-auth-method',
  'x-tenant-id',
] as const;

/** Mutates `headers` in place — Node lowercases incoming header names, so this is case-safe. */
export function stripSpoofedHeaders(headers: Record<string, unknown>): void {
  for (const name of SPOOFABLE_IDENTITY_HEADERS) {
    delete headers[name];
  }
}

/**
 * Builds the identity headers injected for an authenticated proxied request.
 * `requestId` reuses the id already assigned by `middleware/requestId.ts`
 * (attached globally before this router runs) rather than minting a second
 * UUID, so the value tracing a request upstream matches the gateway's own
 * `X-Request-ID` response header.
 */
export function buildIdentityHeaders(
  claims: JwtAccessTokenClaims,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-user-id': claims.sub,
    'x-user-email': claims.email,
    'x-user-roles': claims.roles.join(','),
    'x-auth-method': claims.auth_method,
    'x-request-id': requestId,
  };
  if (claims.tenant_id) {
    headers['x-tenant-id'] = claims.tenant_id;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Authorization policy enforcement + denial audit (FR-19)
// ---------------------------------------------------------------------------

function resourcePath(req: Request): string {
  return req.originalUrl.split('?')[0] ?? req.originalUrl;
}

function requestAuditFields(
  req: Request,
  claims: JwtAccessTokenClaims | undefined,
): Pick<AuditLogEntry, 'user_id' | 'ip_address' | 'user_agent' | 'resource'> {
  const userAgent = req.headers['user-agent'];
  return {
    resource: resourcePath(req),
    ...(claims ? { user_id: claims.sub } : {}),
    ...(req.ip ? { ip_address: req.ip } : {}),
    ...(typeof userAgent === 'string' ? { user_agent: userAgent } : {}),
  };
}

/**
 * Writes the `proxy.request_denied` audit entry FR-19 requires for every
 * authorization failure — (a) 401, (b) 403 role, (c) 403 scope, (d) 429
 * rate limit alike. Exported because the (a) 401 case is decided by the
 * router's own `validateAccessToken` call, not by `enforceAuthorization`
 * below, but still needs this same audit write.
 */
export async function auditDenial(
  req: Request,
  claims: JwtAccessTokenClaims | undefined,
  error: AppError,
): Promise<void> {
  await writeAuditEvent({
    event_type: 'proxy.request_denied',
    outcome: 'denied',
    failure_reason: error.code,
    ...requestAuditFields(req, claims),
  });
}

const rateLimiterCache = new WeakMap<RouteConfig, ReturnType<typeof rateLimiter>>();

function getRateLimiter(route: RouteConfig): ReturnType<typeof rateLimiter> {
  let middleware = rateLimiterCache.get(route);
  if (!middleware) {
    middleware = rateLimiter({
      maxRequests: route.rate_limit_override ?? undefined,
      // Keyed by route.path (not just the client IP) so one route's quota
      // can't be exhausted by, or silently share a counter with, traffic to
      // a different proxy route from the same IP in the same window.
      keyPrefix: `ratelimit:proxy:${route.path}`,
    });
    rateLimiterCache.set(route, middleware);
  }
  return middleware;
}

/** Runs the Redis-backed rate limiter middleware imperatively for the resolved route. */
function runRateLimiter(route: RouteConfig, req: Request, res: Response): Promise<AppError | null> {
  return new Promise((resolve) => {
    const middleware = getRateLimiter(route);
    void middleware(req, res, ((err?: unknown) => {
      resolve(err ? (err as AppError) : null);
    }) as NextFunction);
  });
}

/**
 * Enforces FR-19(b)-(d) for the resolved route, writing a
 * `proxy.request_denied` audit entry on any denial. Returns the AppError to
 * respond with, or `null` if the request is authorized to proceed.
 *
 * FR-19(a) (401 when `auth_required` and no valid token) is decided entirely
 * by the router's `validateAccessToken({ optional: !route.auth_required })`
 * call before this ever runs — by the time it's invoked, `auth_required:
 * true` already implies `claims` is set, so re-checking it here would be
 * validating an invariant that can't be false. The router audits that case
 * itself via the exported `auditDenial` above, since this function never
 * sees it.
 */
export async function enforceAuthorization(
  route: RouteConfig,
  claims: JwtAccessTokenClaims | undefined,
  req: Request,
  res: Response,
): Promise<AppError | null> {
  if (route.allowed_roles && route.allowed_roles.length > 0) {
    const allowedRoles = route.allowed_roles;
    const hasAllowedRole = claims?.roles.some((role) => allowedRoles.includes(role)) ?? false;
    if (!hasAllowedRole) {
      const error = new ForbiddenError('Insufficient role');
      await auditDenial(req, claims, error);
      return error;
    }
  }

  if (route.required_scope) {
    const grantedScopes = claims?.scope.split(' ') ?? [];
    if (!grantedScopes.includes(route.required_scope)) {
      const error = new InsufficientScopeError(route.required_scope);
      await auditDenial(req, claims, error);
      return error;
    }
  }

  const rateLimitError = await runRateLimiter(route, req, res);
  if (rateLimitError) {
    await auditDenial(req, claims, rateLimitError);
    return rateLimitError;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Upstream dispatch + gated allow-audit (FR-16, FR-20)
// ---------------------------------------------------------------------------

/** Writes `proxy.request_allowed` only when the route opted in (Open Question 2 resolution). */
export async function auditAllowedIfFlagged(
  route: RouteConfig,
  req: Request,
  claims: JwtAccessTokenClaims | undefined,
): Promise<void> {
  if (!route.audit_allowed_requests) {
    return;
  }
  await writeAuditEvent({
    event_type: 'proxy.request_allowed',
    outcome: 'success',
    ...requestAuditFields(req, claims),
  });
}

const proxyMiddlewareCache = new WeakMap<RouteConfig, ProxyRequestHandler>();
// Correlates an in-flight request's `res` object back to the promise
// dispatchToUpstream is waiting on — createProxyMiddleware's `on.error`
// callback is registered once per route (not per request), so this is how
// a given request's async connection error finds its way back to the right
// pending rejection instead of every in-flight request on that route.
const pendingUpstreamErrors = new WeakMap<Response, (err: NodeJS.ErrnoException) => void>();

function isServerResponse(res: unknown): res is Response {
  return typeof res === 'object' && res !== null && typeof (res as Response).setHeader === 'function';
}

function getProxyMiddleware(route: RouteConfig): ProxyRequestHandler {
  let middleware = proxyMiddlewareCache.get(route);
  if (middleware) {
    return middleware;
  }

  middleware = createProxyMiddleware({
    target: route.upstream,
    changeOrigin: true,
    xfwd: true,
    // `proxyTimeout` bounds the outbound request to `route.upstream` — the
    // thing FR-16's `timeout_ms` actually governs. The `timeout` option
    // instead sets a read timeout on the *inbound* client socket, which is a
    // different concern (stalled client uploads) and, left at the same
    // value, closes the client connection out from under a slow-but-healthy
    // upstream response.
    proxyTimeout: route.timeout_ms,
    on: {
      error: (err, _req, res) => {
        if (!isServerResponse(res)) {
          return;
        }
        pendingUpstreamErrors.get(res)?.(err as NodeJS.ErrnoException);
      },
    },
  });
  proxyMiddlewareCache.set(route, middleware);
  return middleware;
}

/**
 * `ECONNRESET` covers both a genuine upstream reset and this gateway's own
 * `proxyTimeout`-triggered abort (node-http-proxy aborts the outbound
 * request on timeout, which surfaces as ECONNRESET) — both are correctly
 * modeled as a gateway timeout. `ECONNREFUSED`/`ENOTFOUND` mean no
 * connection was ever established, i.e. the upstream is unreachable.
 *
 * Identifies the failing route by `route.path` rather than `route.upstream`
 * in the client-facing error body — the latter would leak the internal
 * upstream hostname/port to callers.
 */
function mapUpstreamError(route: RouteConfig, err: NodeJS.ErrnoException): AppError {
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    return new GatewayTimeoutError(route.path);
  }
  return new UpstreamError(route.path, err.message);
}

/** Proxies the request to `route.upstream`, forwarding `forwardPath` instead of the original URL. */
export async function dispatchToUpstream(
  route: RouteConfig,
  forwardPath: string,
  req: Request,
  res: Response,
): Promise<void> {
  const originalUrl = req.url;
  req.url = forwardPath;
  const proxy = getProxyMiddleware(route);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      pendingUpstreamErrors.set(res, (err) => {
        if (settled) return;
        settled = true;
        pendingUpstreamErrors.delete(res);
        reject(mapUpstreamError(route, err));
      });

      res.once('finish', () => {
        if (settled) return;
        settled = true;
        pendingUpstreamErrors.delete(res);
        resolve();
      });

      // A client that disconnects mid-request fires 'close' without ever
      // firing 'finish'. Without this, the promise (and this handler's
      // WeakMap entry) would hang forever on an aborted request — not a
      // gateway-attributable error, so resolve rather than reject.
      res.once('close', () => {
        if (settled) return;
        settled = true;
        pendingUpstreamErrors.delete(res);
        resolve();
      });

      void proxy(req, res, ((err?: unknown) => {
        if (settled || !err) return;
        settled = true;
        pendingUpstreamErrors.delete(res);
        reject(err instanceof Error ? err : new Error(String(err)));
      }) as NextFunction);
    });
  } finally {
    req.url = originalUrl;
  }
}
