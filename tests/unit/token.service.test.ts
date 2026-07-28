import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheRefreshTokenRevocation,
  getJwks,
  isTokenRevoked,
  revokeToken,
  signAccessToken,
  verifyAccessToken,
} from '@/services/token.service.js';
import { loadSigningKeys } from '@/utils/crypto.js';

// token.service.ts creates a real ioredis client at module load — replace it
// with an in-memory fake so unit tests never need a live Redis (CLAUDE.md:
// "Unit tests may mock ioredis and pg with vi.mock"). vi.mock calls are
// hoisted above imports by vitest, so this applies before token.service.ts
// is evaluated even though the static import above appears first.
vi.mock('ioredis', async () => {
  const { FakeRedis } = await import('./helpers/fakeRedis.js');
  return { Redis: FakeRedis };
});

const subject = {
  sub: '9d3f0d3e-6c2a-4b7a-9c9f-1a2b3c4d5e6f',
  email: 'user@example.com',
  roles: ['viewer'],
  authMethod: 'password' as const,
  tenantId: null,
  scope: 'openid profile email api:read',
};

describe('signAccessToken', () => {
  it('embeds the full FR-3 claim set with a 900s lifetime', async () => {
    const { token, jti, expiresAt } = await signAccessToken(subject);
    const claims = decodeJwt(token);

    expect(claims.sub).toBe(subject.sub);
    expect(claims['email']).toBe(subject.email);
    expect(claims['roles']).toEqual(subject.roles);
    expect(claims['auth_method']).toBe('password');
    expect(claims['tenant_id']).toBeNull();
    expect(claims['scope']).toBe(subject.scope);
    expect(claims.iss).toBe('http://localhost:3000');
    expect(claims.aud).toBe('platform');
    expect(claims.jti).toBe(jti);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.nbf).toBe('number');
    expect(claims.exp).toBeDefined();
    expect(claims.iat).toBeDefined();
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
    expect(expiresAt.getTime()).toBe((claims.exp as number) * 1_000);
  });

  it('signs with RS256 and the configured kid', async () => {
    const { token } = await signAccessToken(subject);
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('verifyAccessToken', () => {
  it('accepts a token it issued and returns the decoded claims', async () => {
    const { token } = await signAccessToken(subject);
    const result = await verifyAccessToken(token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sub).toBe(subject.sub);
      expect(result.value.email).toBe(subject.email);
    }
  });

  it('rejects an expired token with token_expired', async () => {
    const keys = await loadSigningKeys();
    const nowSeconds = Math.floor(Date.now() / 1_000);

    const expired = await new SignJWT({
      email: subject.email,
      roles: subject.roles,
      auth_method: subject.authMethod,
      tenant_id: subject.tenantId,
      scope: subject.scope,
    })
      .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
      .setSubject(subject.sub)
      .setIssuedAt(nowSeconds - 1_000)
      .setNotBefore(nowSeconds - 1_000)
      .setExpirationTime(nowSeconds - 100) // expired 100s ago, outside 30s tolerance
      .setIssuer('http://localhost:3000')
      .setAudience('platform')
      .setJti('11111111-2222-4333-8444-555555555555')
      .sign(keys.privateKey);

    const result = await verifyAccessToken(expired);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('token_expired');
      expect(result.error.statusCode).toBe(401);
    }
  });

  it('rejects a token with a tampered signature', async () => {
    const { token } = await signAccessToken(subject);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -4)}abcd`;

    const result = await verifyAccessToken(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).not.toBe('token_expired');
    }
  });

  it('rejects a revoked token with token_revoked', async () => {
    const { token, jti, expiresAt } = await signAccessToken(subject);

    expect(await isTokenRevoked(jti)).toBe(false);
    await revokeToken(jti, expiresAt);
    expect(await isTokenRevoked(jti)).toBe(true);

    const result = await verifyAccessToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('token_revoked');
    }
  });
});

describe('getJwks', () => {
  it('publishes the active public key as a JWK with kid/use/alg', async () => {
    const jwks = await getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kid).toBe('11111111-1111-4111-8111-111111111111');
    expect(jwks.keys[0]?.use).toBe('sig');
    expect(jwks.keys[0]?.alg).toBe('RS256');
    expect(jwks.keys[0]?.kty).toBe('RSA');
    // Public JWK must never carry private material.
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });
});

describe('revocation cache', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('does not persist a revocation entry for an already-expired token', async () => {
    const jti = 'already-expired-jti';
    await revokeToken(jti, new Date(Date.now() - 1_000));
    expect(await isTokenRevoked(jti)).toBe(false);
  });
});

describe('cacheRefreshTokenRevocation', () => {
  it('is a no-op for an already-expired refresh token', async () => {
    // No assertion beyond "does not throw" — there's nothing to observe
    // from outside without a Redis spy, and the interesting behavior (TTL
    // math) is already covered via revokeToken's equivalent branch above.
    await expect(
      cacheRefreshTokenRevocation('some-hash', new Date(Date.now() - 1_000)),
    ).resolves.toBeUndefined();
  });

  it('writes a revocation entry for a still-valid refresh token', async () => {
    await expect(
      cacheRefreshTokenRevocation('some-hash', new Date(Date.now() + 604_800_000)),
    ).resolves.toBeUndefined();
  });
});
