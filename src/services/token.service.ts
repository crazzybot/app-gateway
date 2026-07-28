/**
 * Token service — JWT issuance, verification, and revocation via Redis.
 *
 * Key responsibilities:
 *   - Sign access tokens (short TTL) and refresh tokens (long TTL) using jose.
 *   - Verify and decode tokens, checking the JWKS for the matching key ID.
 *   - Revoke refresh tokens by storing their JTI in Redis until expiry.
 *   - Support zero-downtime key rotation by serving two keys from JWKS.
 *
 * Security rules enforced here:
 *   - Access tokens and refresh tokens are NEVER logged — only JTI is logged.
 *   - Revocation list entries expire from Redis at token expiry time.
 */

import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// ---------------------------------------------------------------------------
// Redis client singleton (exported for graceful shutdown in src/index.ts)
// ---------------------------------------------------------------------------

export const redis = new IORedis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error({ err }, 'Redis error'));

// ---------------------------------------------------------------------------
// Token revocation helpers
// ---------------------------------------------------------------------------

const REVOKED_KEY_PREFIX = 'revoked:jti:';

/**
 * Mark a refresh token JTI as revoked in Redis.
 * The key automatically expires when the token would have expired anyway.
 */
export async function revokeToken(
  jti: string,
  expiresAt: Date,
): Promise<void> {
  const ttlSeconds = Math.ceil(
    (expiresAt.getTime() - Date.now()) / 1_000,
  );

  if (ttlSeconds <= 0) {
    // Already expired — nothing to do.
    return;
  }

  await redis.set(`${REVOKED_KEY_PREFIX}${jti}`, '1', 'EX', ttlSeconds);
  logger.info({ jti }, 'Token revoked');
}

/**
 * Returns true if the given JTI has been revoked.
 */
export async function isTokenRevoked(jti: string): Promise<boolean> {
  const val = await redis.get(`${REVOKED_KEY_PREFIX}${jti}`);
  return val !== null;
}

// TODO: implement signAccessToken, signRefreshToken, verifyToken using jose
//       and the key material at env.JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH.
