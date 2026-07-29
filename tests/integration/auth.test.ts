import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '@/index.js';
import { db } from '@/db/client.js';
import { refreshTokens, tenantEncryptionKeys } from '@/db/schema.js';
import { hashRefreshToken } from '@/services/refreshToken.service.js';
import { DEFAULT_TENANT_KEY_ID } from '@/services/tenantKey.service.js';
import type { ErrorResponse, TokenResponse, UserProfile } from '@/types/index.js';
import { closeConnections } from './helpers/closeConnections.js';

// Imported dynamically (after globalSetup has set env vars) via the seed
// helper's own module graph; safe as a static import here because this test
// file only ever runs under vitest.integration.config.ts, whose globalSetup
// has already populated process.env before this file's imports execute.
import { seedUser } from '../helpers/seedUser.js';

function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

// supertest types `res.body` as `any` (it can't know the route's response
// shape) — cast once per call site instead of triggering
// @typescript-eslint/no-unsafe-member-access on every field access below.
function body<T>(res: Response): T {
  return res.body as T;
}

afterAll(async () => {
  await closeConnections();
});

describe('POST /v1/auth/login (AC-1, AC-2)', () => {
  it('issues an access + refresh token pair for correct credentials', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'correct-horse-battery', roles: ['viewer'] });

    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email, password: 'correct-horse-battery' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
    });
    const loginBody = body<TokenResponse>(res);
    expect(typeof loginBody.access_token).toBe('string');
    expect(typeof loginBody.refresh_token).toBe('string');
    expect(typeof loginBody.scope).toBe('string');
    expect(loginBody.scope.length).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(loginBody.refresh_token as string)));
    expect(rows).toHaveLength(1);
  });

  it('rejects the wrong password with 401 invalid_credentials', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'correct-password' });

    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email, password: 'wrong-password' });

    expect(res.status).toBe(401);
    const errorBody = body<ErrorResponse & { access_token?: string }>(res);
    expect(errorBody.error).toBe('invalid_credentials');
    expect(errorBody.access_token).toBeUndefined();
  });

  it('rejects an unknown email with 401 invalid_credentials', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: uniqueEmail(), password: 'whatever' });

    expect(res.status).toBe(401);
    expect(body<ErrorResponse>(res).error).toBe('invalid_credentials');
  });

  it('rejects a missing password with a validation error', async () => {
    const res = await request(app).post('/v1/auth/login').send({ email: uniqueEmail() });
    expect(res.status).toBe(400);
    expect(body<ErrorResponse>(res).error).toBe('VALIDATION_ERROR');
  });
});

describe('POST /v1/auth/refresh (AC-7, AC-8)', () => {
  it('rotates the refresh token and revokes the old one', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'p@ssword1' });
    const login = body<TokenResponse>(
      await request(app).post('/v1/auth/login').send({ email, password: 'p@ssword1' }),
    );

    const refreshRes = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.refresh_token });

    expect(refreshRes.status).toBe(200);
    const refreshBody = body<TokenResponse>(refreshRes);
    expect(refreshBody.refresh_token).not.toBe(login.refresh_token);
    expect(refreshBody.access_token).not.toBe(login.access_token);

    const oldRow = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(login.refresh_token as string)));
    expect(oldRow[0]?.revokedAt).not.toBeNull();
    expect(oldRow[0]?.revocationReason).toBe('rotation');
  });

  it('detects replay of an already-rotated token and revokes the whole family', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'p@ssword2' });
    const login = body<TokenResponse>(
      await request(app).post('/v1/auth/login').send({ email, password: 'p@ssword2' }),
    );
    const originalRefreshToken = login.refresh_token as string;

    // Rotate once (legitimate use).
    const rotated = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: originalRefreshToken });
    expect(rotated.status).toBe(200);
    const rotatedBody = body<TokenResponse>(rotated);

    // Replay the original (now-revoked) token — reuse detected.
    const replay = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: originalRefreshToken });

    expect(replay.status).toBe(401);
    expect(body<ErrorResponse>(replay).error).toBe('token_reuse_detected');

    // The token issued by the legitimate rotation is now revoked too.
    const rotatedRow = await db
      .select()
      .from(refreshTokens)
      .where(
        eq(refreshTokens.tokenHash, hashRefreshToken(rotatedBody.refresh_token as string)),
      );
    expect(rotatedRow[0]?.revokedAt).not.toBeNull();
    expect(rotatedRow[0]?.revocationReason).toBe('reuse_detected');
  });
});

describe('POST /v1/auth/refresh — idempotency_key (AC-10)', () => {
  it('returns the identical token pair on a duplicate idempotency_key within the 30s window', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'p@ssword-idem-1' });
    const login = body<TokenResponse>(
      await request(app).post('/v1/auth/login').send({ email, password: 'p@ssword-idem-1' }),
    );

    const idempotencyKey = randomUUID();
    const first = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.refresh_token, idempotency_key: idempotencyKey });
    expect(first.status).toBe(200);
    const firstBody = body<TokenResponse>(first);

    // Retry with the same (now-rotated-away) refresh_token and idempotency_key.
    const retry = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: login.refresh_token, idempotency_key: idempotencyKey });
    expect(retry.status).toBe(200);
    const retryBody = body<TokenResponse>(retry);

    expect(retryBody.access_token).toBe(firstBody.access_token);
    expect(retryBody.refresh_token).toBe(firstBody.refresh_token);

    // No additional refresh_tokens row was inserted or revoked for the retry.
    const rows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(firstBody.refresh_token as string)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it('does not revoke the session family when two truly concurrent requests share the same idempotency_key', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'p@ssword-idem-concurrent' });
    const login = body<TokenResponse>(
      await request(app)
        .post('/v1/auth/login')
        .send({ email, password: 'p@ssword-idem-concurrent' }),
    );

    const idempotencyKey = randomUUID();
    // Fire both requests without awaiting between them — this is the race
    // the Redis claim step (token.service.ts claimIdempotencyKey) exists to
    // close: without it, both could miss the cache and both call
    // rotateRefreshToken, tripping session-family-wide reuse detection.
    const [first, second] = await Promise.all([
      request(app)
        .post('/v1/auth/refresh')
        .send({ refresh_token: login.refresh_token, idempotency_key: idempotencyKey }),
      request(app)
        .post('/v1/auth/refresh')
        .send({ refresh_token: login.refresh_token, idempotency_key: idempotencyKey }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = body<TokenResponse>(first);
    const secondBody = body<TokenResponse>(second);
    expect(secondBody.access_token).toBe(firstBody.access_token);
    expect(secondBody.refresh_token).toBe(firstBody.refresh_token);

    // The session family must still be usable — a false-positive reuse
    // detection would have revoked every token in it.
    const familyRows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(firstBody.refresh_token as string)));
    expect(familyRows).toHaveLength(1);
    expect(familyRows[0]?.revokedAt).toBeNull();
    expect(familyRows[0]?.revocationReason).toBeNull();
  });

  it('does not return a cached pair when the presented refresh_token does not match the one that produced it', async () => {
    const emailA = uniqueEmail();
    const emailB = uniqueEmail();
    await seedUser({ email: emailA, password: 'p@ssword-idem-mismatch-a' });
    await seedUser({ email: emailB, password: 'p@ssword-idem-mismatch-b' });
    const loginA = body<TokenResponse>(
      await request(app)
        .post('/v1/auth/login')
        .send({ email: emailA, password: 'p@ssword-idem-mismatch-a' }),
    );
    const loginB = body<TokenResponse>(
      await request(app)
        .post('/v1/auth/login')
        .send({ email: emailB, password: 'p@ssword-idem-mismatch-b' }),
    );

    const idempotencyKey = randomUUID();
    const first = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: loginA.refresh_token, idempotency_key: idempotencyKey });
    expect(first.status).toBe(200);
    const firstBody = body<TokenResponse>(first);

    // Reuses the SAME idempotency_key but presents a different (still valid,
    // unrelated) refresh_token — must be treated as a fresh rotation for
    // user B, not a cache hit returning user A's pair.
    const second = await request(app)
      .post('/v1/auth/refresh')
      .send({ refresh_token: loginB.refresh_token, idempotency_key: idempotencyKey });
    expect(second.status).toBe(200);
    const secondBody = body<TokenResponse>(second);

    expect(secondBody.access_token).not.toBe(firstBody.access_token);
    expect(secondBody.refresh_token).not.toBe(firstBody.refresh_token);
  });

  it(
    'falls back to normal reuse detection once the idempotency cache window expires',
    async () => {
      const email = uniqueEmail();
      await seedUser({ email, password: 'p@ssword-idem-2' });
      const login = body<TokenResponse>(
        await request(app).post('/v1/auth/login').send({ email, password: 'p@ssword-idem-2' }),
      );

      const idempotencyKey = randomUUID();
      const first = await request(app)
        .post('/v1/auth/refresh')
        .send({ refresh_token: login.refresh_token, idempotency_key: idempotencyKey });
      expect(first.status).toBe(200);

      // Wait past the 30s idempotency cache TTL.
      await new Promise((resolve) => setTimeout(resolve, 31_000));

      // The same (now-rotated-away) refresh_token is presented again with a
      // stale idempotency_key — the cache has expired, so this must fall
      // back to normal reuse detection instead of returning the cached pair.
      const afterExpiry = await request(app)
        .post('/v1/auth/refresh')
        .send({ refresh_token: login.refresh_token, idempotency_key: idempotencyKey });

      expect(afterExpiry.status).toBe(401);
      expect(body<ErrorResponse>(afterExpiry).error).toBe('token_reuse_detected');
    },
    40_000,
  );
});

describe('Per-tenant email encryption (AC-11, AC-12)', () => {
  it("encrypts two tenants' emails under distinct wrapped DEKs", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const emailA = uniqueEmail();
    const emailB = uniqueEmail();

    await seedUser({ email: emailA, password: 'p@ssword-tenant-a', tenantId: tenantA });
    await seedUser({ email: emailB, password: 'p@ssword-tenant-b', tenantId: tenantB });

    const keyRows = await db
      .select()
      .from(tenantEncryptionKeys)
      .where(inArray(tenantEncryptionKeys.tenantId, [tenantA, tenantB]));

    expect(keyRows).toHaveLength(2);
    const wrappedDeks = new Set(keyRows.map((r) => r.wrappedDek));
    expect(wrappedDeks.size).toBe(2); // distinct wrapped DEKs per tenant

    // Each tenant's user still round-trips correctly under its own DEK.
    const loginA = body<TokenResponse>(
      await request(app)
        .post('/v1/auth/login')
        .send({ email: emailA, password: 'p@ssword-tenant-a' }),
    );
    const meA = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${loginA.access_token}`);
    expect(body<UserProfile>(meA).email).toBe(emailA);
  });

  it('shares a single default DEK for tenant_id IS NULL users', async () => {
    const email1 = uniqueEmail();
    const email2 = uniqueEmail();
    await seedUser({ email: email1, password: 'p@ssword-default-1', tenantId: null });
    await seedUser({ email: email2, password: 'p@ssword-default-2', tenantId: null });

    const keyRows = await db
      .select()
      .from(tenantEncryptionKeys)
      .where(eq(tenantEncryptionKeys.tenantId, DEFAULT_TENANT_KEY_ID));

    // Exactly one row for the default bucket, no matter how many
    // tenant_id-IS-NULL users share it (AC-12).
    expect(keyRows).toHaveLength(1);
  });
});

describe('POST /v1/auth/logout and GET /v1/auth/me (AC-9)', () => {
  it('logout revokes both tokens; the access token can no longer be used', async () => {
    const email = uniqueEmail();
    await seedUser({ email, password: 'p@ssword3' });
    const login = body<TokenResponse>(
      await request(app).post('/v1/auth/login').send({ email, password: 'p@ssword3' }),
    );

    const meBefore = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${login.access_token}`);
    expect(meBefore.status).toBe(200);
    expect(body<UserProfile>(meBefore).email).toBe(email);

    const logoutRes = await request(app)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${login.access_token}`)
      .send({});
    expect(logoutRes.status).toBe(204);

    const meAfter = await request(app)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${login.access_token}`);
    expect(meAfter.status).toBe(401);
    expect(body<ErrorResponse>(meAfter).error).toBe('token_revoked');

    const refreshRow = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(login.refresh_token as string)));
    expect(refreshRow[0]?.revokedAt).not.toBeNull();
  });

  it('GET /me returns 401 with no Authorization header', async () => {
    const res = await request(app).get('/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /me returns 401 for a malformed token', async () => {
    const res = await request(app).get('/v1/auth/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
