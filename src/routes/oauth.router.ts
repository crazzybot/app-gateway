/**
 * OAuth 2.0 router — /v1/oauth
 *
 * Implements RFC 6749 Authorization Code flow with PKCE (RFC 7636),
 * Client Credentials flow, and token introspection (RFC 7662). Not
 * implemented this phase — see docs/kb for the current status.
 *
 * Routes:
 *   GET  /v1/oauth/authorize    — authorization endpoint (redirects to IdP or consent)
 *   POST /v1/oauth/token        — token endpoint (code exchange, client_credentials, refresh)
 *   POST /v1/oauth/introspect   — token introspection (RFC 7662)
 *   POST /v1/oauth/revoke       — token revocation (RFC 7009)
 *
 * JWKS (RFC 7517) is published at GET /v1/auth/.well-known/jwks.json (FR-21,
 * spec API table 4.2) — NOT under /v1/oauth. An earlier placeholder here at
 * /v1/oauth/jwks didn't match any route the spec defines and has been
 * removed.
 */

import { Router } from 'express';

export const oauthRouter = Router();

// Placeholder handlers — replace with real implementations.

oauthRouter.get('/authorize', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'GET /v1/oauth/authorize is not yet implemented' });
});

oauthRouter.post('/token', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/oauth/token is not yet implemented' });
});

oauthRouter.post('/introspect', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/oauth/introspect is not yet implemented' });
});

oauthRouter.post('/revoke', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/oauth/revoke is not yet implemented' });
});
