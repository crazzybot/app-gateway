import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '@/index.js';
import { db } from '@/db/client.js';
import { refreshTokens } from '@/db/schema.js';
import { hashRefreshToken } from '@/services/refreshToken.service.js';
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
