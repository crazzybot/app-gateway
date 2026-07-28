/**
 * Token service — JWT issuance, verification, and revocation via Redis.
 *
 * Key responsibilities:
 *   - Sign access tokens (short TTL) using jose, embedding the full FR-3
 *     claim set.
 *   - Verify and decode tokens against the in-process JWK set (local — the
 *     gateway verifies tokens it issued itself, never a remote fetch).
 *   - Publish the JWKS document (FR-21), including a previous key during a
 *     manual rotation window.
 *   - Revoke access tokens (by jti) and refresh tokens (by hash) in Redis
 *     until their natural expiry (FR-23).
 *
 * Security rules enforced here:
 *   - Access tokens and refresh tokens are NEVER logged — only jti/hash is.
 *   - Revocation list entries expire from Redis at token expiry time.
 */

import { randomUUID } from 'node:crypto';
// Named import, not default — ioredis's CJS/ESM dual-format .d.ts resolves
// ambiguously as a default import under `moduleResolution: NodeNext`.
import { Redis } from 'ioredis';
import {
  SignJWT,
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { loadSigningKeys, type SigningKeys } from '../utils/crypto.js';
import { ttlSecondsUntil } from '../utils/time.js';
import {
  TokenExpiredError,
  TokenRevokedError,
  UnauthorizedError,
  type AppError,
} from '../types/errors.js';
import { err, ok, type Result } from '../types/result.js';
import type { JwtAccessTokenClaims } from '../types/index.js';

// ---------------------------------------------------------------------------
// Redis client singleton (exported for graceful shutdown in src/index.ts)
// ---------------------------------------------------------------------------

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err_: Error) => logger.error('Redis error', { err: err_ }));

// ---------------------------------------------------------------------------
// Token revocation helpers (FR-23)
// ---------------------------------------------------------------------------

const REVOKED_JTI_PREFIX = 'revoked:jti:';
const REVOKED_REFRESH_PREFIX = 'revoked:refresh:';

/** Mark an access token jti as revoked. The key expires at the token's natural exp. */
export async function revokeToken(jti: string, expiresAt: Date): Promise<void> {
  const ttlSeconds = ttlSecondsUntil(expiresAt);
  if (ttlSeconds <= 0) return; // already expired — nothing to do
  await redis.set(`${REVOKED_JTI_PREFIX}${jti}`, '1', 'EX', ttlSeconds);
  logger.info('Token revoked', { jti });
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  const val = await redis.get(`${REVOKED_JTI_PREFIX}${jti}`);
  return val !== null;
}

/**
 * Populates the Redis-cached mirror of a refresh-token revocation (FR-23).
 * Postgres (`refresh_tokens.revoked_at`) remains the source of truth that
 * refreshToken.service.ts actually checks — this cache exists for future
 * O(1) revocation lookups without a DB round trip; nothing reads it yet.
 */
export async function cacheRefreshTokenRevocation(
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  const ttlSeconds = ttlSecondsUntil(expiresAt);
  if (ttlSeconds <= 0) return;
  await redis.set(`${REVOKED_REFRESH_PREFIX}${tokenHash}`, '1', 'EX', ttlSeconds);
}

// ---------------------------------------------------------------------------
// JWKS document (FR-21)
// ---------------------------------------------------------------------------

type JwkWithKid = JWK & { kid: string; use: 'sig'; alg: string };

async function buildJwksDocument(
  keys: SigningKeys,
): Promise<{ keys: JwkWithKid[] }> {
  const activeJwk: JwkWithKid = {
    ...(await exportJWK(keys.publicKey)),
    kid: keys.kid,
    use: 'sig',
    alg: env.JWT_ALGORITHM,
  };

  const entries = [activeJwk];

  if (keys.previousKid && keys.previousPublicKey) {
    entries.push({
      ...(await exportJWK(keys.previousPublicKey)),
      kid: keys.previousKid,
      use: 'sig',
      alg: env.JWT_ALGORITHM,
    });
  }

  return { keys: entries };
}

let cachedJwksDocument: Promise<{ keys: JwkWithKid[] }> | undefined;

async function getJwksDocument(): Promise<{ keys: JwkWithKid[] }> {
  cachedJwksDocument ??= loadSigningKeys().then(buildJwksDocument);
  return cachedJwksDocument;
}

let cachedVerifyKeySet: Promise<JWTVerifyGetKey> | undefined;

function getVerifyKeySet(): Promise<JWTVerifyGetKey> {
  cachedVerifyKeySet ??= getJwksDocument().then((doc) => createLocalJWKSet(doc));
  return cachedVerifyKeySet;
}

/** RFC 7517 JWK Set — public keys only, safe to publish at GET /v1/auth/.well-known/jwks.json. */
export async function getJwks(): Promise<{ keys: JwkWithKid[] }> {
  return getJwksDocument();
}

// ---------------------------------------------------------------------------
// Access token issuance (FR-1, FR-3)
// ---------------------------------------------------------------------------

export interface AccessTokenSubject {
  sub: string;
  email: string;
  roles: string[];
  authMethod: JwtAccessTokenClaims['auth_method'];
  tenantId: string | null;
  scope: string;
  audience?: string;
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

export async function signAccessToken(
  subject: AccessTokenSubject,
): Promise<SignedAccessToken> {
  const keys = await loadSigningKeys();
  const jti = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const expSeconds = nowSeconds + env.ACCESS_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({
    email: subject.email,
    roles: subject.roles,
    auth_method: subject.authMethod,
    tenant_id: subject.tenantId,
    scope: subject.scope,
  })
    .setProtectedHeader({ alg: env.JWT_ALGORITHM, kid: keys.kid })
    .setSubject(subject.sub)
    .setIssuedAt(nowSeconds)
    .setNotBefore(nowSeconds)
    .setExpirationTime(expSeconds)
    .setIssuer(env.GATEWAY_BASE_URL)
    .setAudience(subject.audience ?? 'platform')
    .setJti(jti)
    .sign(keys.privateKey);

  return { token, jti, expiresAt: new Date(expSeconds * 1_000) };
}

// ---------------------------------------------------------------------------
// Access token verification (FR-2)
// ---------------------------------------------------------------------------

export async function verifyAccessToken(
  token: string,
): Promise<Result<JwtAccessTokenClaims, AppError>> {
  const keySet = await getVerifyKeySet();

  let payload: JwtAccessTokenClaims;
  try {
    const result = await jwtVerify<JwtAccessTokenClaims>(token, keySet, {
      issuer: env.GATEWAY_BASE_URL,
      // Only password logins issue tokens in Phase 1, always aud: "platform".
      audience: 'platform',
      clockTolerance: 30, // FR-2: clock skew tolerance SHALL be <= 30 seconds
    });
    payload = result.payload;
  } catch (caught) {
    if (caught instanceof joseErrors.JWTExpired) {
      return err(new TokenExpiredError());
    }
    logger.warn('Access token verification failed', { err: caught });
    return err(new UnauthorizedError('Token is invalid'));
  }

  if (await isTokenRevoked(payload.jti)) {
    return err(new TokenRevokedError());
  }

  return ok(payload);
}
