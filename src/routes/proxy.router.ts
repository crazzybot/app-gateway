/**
 * Proxy router — /api/**
 *
 * The single catch-all reverse-proxy route (FR-16–FR-20). All business logic
 * lives in `proxy.service.ts`; this handler only sequences the steps:
 *
 *   resolve route → strip spoofed headers → validate JWT (optional per
 *   route) → enforce authorization → inject identity headers → dispatch →
 *   gated allow-audit
 *
 * `.use()` with no path matches unconditionally — Express 5's router (on
 * path-to-regexp v6+) rejects a bare '*' wildcard pattern in `.all('*', ...)`
 * with "Missing parameter name at index 1", so a real route pattern isn't
 * used here at all for this catch-all handler.
 */

import { Router } from 'express';
import { validateAccessToken } from '../middleware/authenticate.js';
import {
  auditAllowedIfFlagged,
  auditDenial,
  buildIdentityHeaders,
  dispatchToUpstream,
  enforceAuthorization,
  resolveRoute,
  stripSpoofedHeaders,
} from '../services/proxy.service.js';
import { routeConfig } from '../config/routes.js';
import { RouteNotFoundError, type AppError } from '../types/errors.js';

export const proxyRouter = Router();

proxyRouter.use(async (req, res, next) => {
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
  const resolved = resolveRoute(path, routeConfig);

  if (!resolved) {
    next(new RouteNotFoundError(path));
    return;
  }
  const { route, forwardPath } = resolved;

  stripSpoofedHeaders(req.headers);

  // Must NOT pass the router's own `next` directly as validateAccessToken's
  // callback: its success path calls `next()` with no arguments, which to
  // Express means "this middleware is done, advance past proxyRouter" —
  // falling through to the global 404 handler while this async function
  // keeps running in the background. A local callback captures only the
  // error case; on success it does nothing, and control simply continues
  // to the next line below.
  let authError: unknown;
  await validateAccessToken({ optional: !route.auth_required })(req, res, (err?: unknown) => {
    authError = err;
  });
  if (authError) {
    // FR-19(a) — this 401/token-invalid denial is decided here, not inside
    // enforceAuthorization, but FR-19's "All authorization failures SHALL be
    // recorded" applies to it just the same.
    await auditDenial(req, req.auth, authError as AppError);
    next(authError);
    return;
  }

  const denial = await enforceAuthorization(route, req.auth, req, res);
  if (denial) {
    next(denial);
    return;
  }

  if (req.auth) {
    Object.assign(req.headers, buildIdentityHeaders(req.auth, req.requestId));
  }

  try {
    await dispatchToUpstream(route, forwardPath, req, res);
    await auditAllowedIfFlagged(route, req, req.auth);
  } catch (error) {
    next(error);
  }
});
