/**
 * Proxy router — /api/**
 *
 * Authenticates the request (JWT bearer check) then forwards it to the
 * appropriate upstream micro-service based on the routing table defined in
 * UPSTREAM_SERVICES_CONFIG_PATH.
 *
 * Example upstream config (JSON):
 *   [
 *     { "prefix": "/api/users",    "target": "http://users-svc:4001" },
 *     { "prefix": "/api/billing",  "target": "http://billing-svc:4002" }
 *   ]
 *
 * Routes:
 *   ALL /api/** — authenticate → route to upstream
 */

import { Router } from 'express';

export const proxyRouter = Router();

// TODO: load upstream routing table from UPSTREAM_SERVICES_CONFIG_PATH and
//       dynamically register http-proxy-middleware instances per prefix.

// Placeholder: returns 501 until the proxy service is wired up.
// `.use()` with no path matches unconditionally — Express 5's router (on
// path-to-regexp v6+) rejects a bare '*' wildcard pattern in `.all('*', ...)`
// with "Missing parameter name at index 1", so a real route pattern isn't
// used here at all for this catch-all stub.
proxyRouter.use((_req, res) => {
  res.status(501).json({
    error: 'NOT_IMPLEMENTED',
    message: 'Proxy routing is not yet configured.',
  });
});
