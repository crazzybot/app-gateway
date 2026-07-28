/**
 * Auth router — /v1/auth
 *
 * Handles credential-based login, SAML SSO, token refresh, and revocation.
 *
 * Routes:
 *   POST /v1/auth/login          — username/password → access + refresh tokens
 *   POST /v1/auth/logout         — revoke refresh token, clear cookie
 *   POST /v1/auth/refresh        — rotate refresh token, issue new access token
 *   GET  /v1/auth/saml/login     — redirect to IdP
 *   POST /v1/auth/saml/callback  — ACS: validate assertion, issue tokens
 */

import { Router } from 'express';

export const authRouter = Router();

// Placeholder handlers — replace with real implementations.

authRouter.post('/login', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/auth/login is not yet implemented' });
});

authRouter.post('/logout', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/auth/logout is not yet implemented' });
});

authRouter.post('/refresh', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/auth/refresh is not yet implemented' });
});

authRouter.get('/saml/login', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'GET /v1/auth/saml/login is not yet implemented' });
});

authRouter.post('/saml/callback', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/auth/saml/callback is not yet implemented' });
});
