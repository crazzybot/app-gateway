/**
 * Auth router — /v1/auth
 *
 * Handles credential-based login, token refresh, revocation, profile
 * lookup, and JWKS publication. SAML SSO (FR-6–10) is a later phase — those
 * two routes stay as 501 placeholders below.
 *
 * Routes:
 *   POST /v1/auth/login                  — email/password -> access + refresh tokens
 *   POST /v1/auth/logout                 — revoke access + refresh token
 *   POST /v1/auth/refresh                — rotate refresh token, issue new pair
 *   GET  /v1/auth/me                     — authenticated user profile
 *   GET  /v1/auth/.well-known/jwks.json  — publish JWKS public keys
 *   GET  /v1/auth/saml/login             — [not implemented this phase]
 *   POST /v1/auth/saml/callback          — [not implemented this phase]
 */

import { Router, type Request } from 'express';
import { env } from '../config/env.js';
import { validateAccessToken } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, logoutSchema, refreshSchema } from '../schemas/auth.schemas.js';
import { writeAuditEvent } from '../services/audit.service.js';
import {
  hashRefreshToken,
  issueRefreshToken,
  revokeMostRecentRefreshTokenForUser,
  revokeRefreshTokenByHash,
  rotateRefreshToken,
  type RefreshTokenMetadata,
} from '../services/refreshToken.service.js';
import { getJwks, revokeToken, signAccessToken } from '../services/token.service.js';
import {
  findUserById,
  findUserByEmail,
  markLastLogin,
  toUserProfile,
  verifyPassword,
} from '../services/user.service.js';
import { InvalidCredentialsError, UnauthorizedError } from '../types/errors.js';
import type { AuditLogEntry, TokenResponse } from '../types/index.js';

export const authRouter = Router();

function requestMeta(req: Request): RefreshTokenMetadata {
  const userAgent = req.headers['user-agent'];
  return {
    ...(req.ip ? { ipAddress: req.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}

function auditMeta(
  meta: RefreshTokenMetadata,
): Pick<AuditLogEntry, 'ip_address' | 'user_agent'> {
  return {
    ...(meta.ipAddress ? { ip_address: meta.ipAddress } : {}),
    ...(meta.userAgent ? { user_agent: meta.userAgent } : {}),
  };
}

// ---------------------------------------------------------------------------
// POST /login (FR-1)
// ---------------------------------------------------------------------------

authRouter.post('/login', validate(loginSchema), async (req, res, next) => {
  const { email, password } = req.body as { email: string; password: string };
  const meta = requestMeta(req);

  const found = await findUserByEmail(email);

  if (!found || !found.user.isActive || !found.passwordHash) {
    await writeAuditEvent({
      event_type: 'auth.login_failed',
      resource: '/v1/auth/login',
      outcome: 'failure',
      failure_reason: 'invalid_credentials',
      ...auditMeta(meta),
    });
    next(new InvalidCredentialsError());
    return;
  }

  const passwordValid = await verifyPassword(password, found.passwordHash);
  if (!passwordValid) {
    await writeAuditEvent({
      event_type: 'auth.login_failed',
      user_id: found.user.id,
      resource: '/v1/auth/login',
      outcome: 'failure',
      failure_reason: 'invalid_credentials',
      ...auditMeta(meta),
    });
    next(new InvalidCredentialsError());
    return;
  }

  const scope = env.DEFAULT_USER_SCOPE;
  const signed = await signAccessToken({
    sub: found.user.id,
    email: found.user.email,
    roles: found.user.roles,
    authMethod: 'password',
    tenantId: found.user.tenantId,
    scope,
  });
  const refresh = await issueRefreshToken(found.user.id, meta);

  await markLastLogin(found.user.id);
  await writeAuditEvent({
    event_type: 'auth.login',
    user_id: found.user.id,
    resource: '/v1/auth/login',
    outcome: 'success',
    ...auditMeta(meta),
  });

  const body: TokenResponse = {
    access_token: signed.token,
    refresh_token: refresh.plaintext,
    token_type: 'Bearer',
    expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };
  res.status(200).json(body);
});

// ---------------------------------------------------------------------------
// POST /refresh (FR-4)
// ---------------------------------------------------------------------------

authRouter.post('/refresh', validate(refreshSchema), async (req, res, next) => {
  const { refresh_token: refreshToken } = req.body as { refresh_token: string };
  const meta = requestMeta(req);

  const rotation = await rotateRefreshToken(refreshToken, meta);
  if (!rotation.ok) {
    // Reuse detection already audits itself inside the service (it needs to
    // fire regardless of caller); only log the generic failure case here.
    if (rotation.error.code !== 'token_reuse_detected') {
      await writeAuditEvent({
        event_type: 'auth.token_refresh_failed',
        resource: '/v1/auth/refresh',
        outcome: 'denied',
        failure_reason: rotation.error.code,
      });
    }
    next(rotation.error);
    return;
  }

  const user = await findUserById(rotation.value.userId);
  if (!user) {
    next(new UnauthorizedError('User no longer exists'));
    return;
  }

  const scope = env.DEFAULT_USER_SCOPE;
  const signed = await signAccessToken({
    sub: user.id,
    email: user.email,
    roles: user.roles,
    authMethod: 'password',
    tenantId: user.tenantId,
    scope,
  });

  await writeAuditEvent({
    event_type: 'auth.token_refresh',
    user_id: user.id,
    resource: '/v1/auth/refresh',
    outcome: 'success',
  });

  const body: TokenResponse = {
    access_token: signed.token,
    refresh_token: rotation.value.issued.plaintext,
    token_type: 'Bearer',
    expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };
  res.status(200).json(body);
});

// ---------------------------------------------------------------------------
// POST /logout (FR-5)
// ---------------------------------------------------------------------------

authRouter.post(
  '/logout',
  validateAccessToken(),
  validate(logoutSchema),
  async (req, res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError());
      return;
    }
    const auth = req.auth;
    const { refresh_token: refreshToken } = req.body as { refresh_token?: string };

    await revokeToken(auth.jti, new Date(auth.exp * 1_000));

    if (refreshToken) {
      await revokeRefreshTokenByHash(hashRefreshToken(refreshToken), 'logout');
    } else {
      await revokeMostRecentRefreshTokenForUser(auth.sub, 'logout');
    }

    await writeAuditEvent({
      event_type: 'auth.logout',
      user_id: auth.sub,
      resource: '/v1/auth/logout',
      outcome: 'success',
    });

    res.status(204).send();
  },
);

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

authRouter.get('/me', validateAccessToken(), async (req, res, next) => {
  if (!req.auth) {
    next(new UnauthorizedError());
    return;
  }

  const user = await findUserById(req.auth.sub);
  if (!user) {
    next(new UnauthorizedError('User no longer exists'));
    return;
  }

  res.status(200).json(toUserProfile(user, req.auth.auth_method));
});

// ---------------------------------------------------------------------------
// GET /.well-known/jwks.json (FR-21)
// ---------------------------------------------------------------------------

authRouter.get('/.well-known/jwks.json', async (_req, res) => {
  const jwks = await getJwks();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json(jwks);
});

// ---------------------------------------------------------------------------
// SAML SSO — not implemented this phase (FR-6–10)
// ---------------------------------------------------------------------------

authRouter.get('/saml/login', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'GET /v1/auth/saml/login is not yet implemented' });
});

authRouter.post('/saml/callback', (_req, res) => {
  res.status(501).json({ error: 'NOT_IMPLEMENTED', message: 'POST /v1/auth/saml/callback is not yet implemented' });
});
