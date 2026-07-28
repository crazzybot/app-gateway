/**
 * Refresh token service — issuance, rotation, and reuse detection (FR-4).
 *
 * Every refresh token belongs to a `session_family`: the UUID shared by a
 * login's original token and every token it rotates into. Presenting an
 * already-revoked token (replay) revokes the *entire* family, forcing
 * re-authentication — this is what stops a stolen refresh token from being
 * used after the legitimate client has already rotated past it.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { refreshTokens } from '../db/schema.js';
import { env } from '../config/env.js';
import { secondsFromNow } from '../utils/time.js';
import { cacheRefreshTokenRevocation } from './token.service.js';
import { writeAuditEvent } from './audit.service.js';
import {
  TokenReuseDetectedError,
  UnauthorizedError,
  type AppError,
} from '../types/errors.js';
import { err, ok, type Result } from '../types/result.js';

export interface RefreshTokenMetadata {
  ipAddress?: string;
  userAgent?: string;
  clientId?: string;
}

export interface IssuedRefreshToken {
  plaintext: string;
  tokenHash: string;
  sessionFamily: string;
  expiresAt: Date;
}

/** 256-bit, URL-safe random string (FR-1) — the plaintext is never persisted. */
function generatePlaintext(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function issueRefreshToken(
  userId: string,
  meta: RefreshTokenMetadata,
  sessionFamily: string = randomUUID(),
): Promise<IssuedRefreshToken> {
  const plaintext = generatePlaintext();
  const tokenHash = hashRefreshToken(plaintext);
  const expiresAt = secondsFromNow(env.REFRESH_TOKEN_TTL_SECONDS);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash,
    sessionFamily,
    clientId: meta.clientId ?? null,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
    expiresAt,
  });

  return { plaintext, tokenHash, sessionFamily, expiresAt };
}

/** Revokes every still-active token in a session family (reuse detection / SLO). */
async function revokeSessionFamily(
  sessionFamily: string,
  reason: string,
): Promise<void> {
  const activeRows = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.sessionFamily, sessionFamily),
        isNull(refreshTokens.revokedAt),
      ),
    );

  if (activeRows.length === 0) return;

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revocationReason: reason })
    .where(
      and(
        eq(refreshTokens.sessionFamily, sessionFamily),
        isNull(refreshTokens.revokedAt),
      ),
    );

  await Promise.all(
    activeRows.map((row) =>
      cacheRefreshTokenRevocation(row.tokenHash, row.expiresAt),
    ),
  );
}

export interface RotationResult {
  userId: string;
  issued: IssuedRefreshToken;
}

/**
 * Validates a presented refresh token and rotates it: the old row is marked
 * revoked (`rotation`), a new one is inserted in the same `session_family`.
 * If the presented token's row is already revoked, this is a replay — the
 * whole family is revoked instead and `TokenReuseDetectedError` is returned.
 */
export async function rotateRefreshToken(
  plaintextToken: string,
  meta: RefreshTokenMetadata,
): Promise<Result<RotationResult, AppError>> {
  const tokenHash = hashRefreshToken(plaintextToken);

  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];

  if (!row) {
    return err(new UnauthorizedError('Refresh token is invalid'));
  }

  if (row.revokedAt) {
    await revokeSessionFamily(row.sessionFamily, 'reuse_detected');
    await writeAuditEvent({
      event_type: 'auth.token_refresh_failed',
      user_id: row.userId,
      outcome: 'denied',
      failure_reason: 'token_reuse_detected',
      metadata: { session_family: row.sessionFamily },
    });
    return err(new TokenReuseDetectedError());
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return err(new UnauthorizedError('Refresh token has expired'));
  }

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revocationReason: 'rotation' })
    .where(eq(refreshTokens.id, row.id));
  await cacheRefreshTokenRevocation(tokenHash, row.expiresAt);

  const issued = await issueRefreshToken(row.userId, meta, row.sessionFamily);

  return ok({ userId: row.userId, issued });
}

/** Revokes one refresh token by its plaintext-derived hash (logout, explicit token param). */
export async function revokeRefreshTokenByHash(
  tokenHash: string,
  reason: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return;

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revocationReason: reason })
    .where(eq(refreshTokens.id, row.id));
  await cacheRefreshTokenRevocation(tokenHash, row.expiresAt);
}

/**
 * Revokes the most recently issued, still-active refresh token for a user —
 * used by logout when no explicit `refresh_token` body param is given (FR-5:
 * "rather than the most-recently-issued one for the session").
 */
export async function revokeMostRecentRefreshTokenForUser(
  userId: string,
  reason: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    )
    .orderBy(desc(refreshTokens.issuedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return;

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revocationReason: reason })
    .where(eq(refreshTokens.id, row.id));
  await cacheRefreshTokenRevocation(row.tokenHash, row.expiresAt);
}
