/**
 * OAuth 2.0 router — /v1/oauth
 *
 * Implements RFC 6749 Authorization Code flow with PKCE (RFC 7636),
 * Client Credentials flow, token introspection (RFC 7662), and JWKS
 * (RFC 7517) for public key discovery.
 *
 * Routes:
 *   GET  /v1/oauth/authorize    — authorization endpoint (redirects to IdP or consent)
 *   POST /v1/oauth/token        — token endpoint (code exchange, client_credentials, refresh)
 *   POST /v1/oauth/introspect   — token introspection (RFC 7662)
 *   POST /v1/oauth/revoke       — token revocation (RFC 7009)
 *   GET  /v1/oauth/jwks         — JSON Web Key Set (public keys)
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

oauthRouter.get('/jwks', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'GET /v1/oauth/jwks is not yet implemented' });
});
