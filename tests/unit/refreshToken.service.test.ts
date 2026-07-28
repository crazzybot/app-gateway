import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asMockedDb, createChainableResult } from './helpers/mockDb.js';

vi.mock('ioredis', async () => {
  const { FakeRedis } = await import('./helpers/fakeRedis.js');
  return { Redis: FakeRedis };
});

vi.mock('@/db/client.js', () => ({
  db: {
    select: vi.fn(() => createChainableResult([])),
    insert: vi.fn(() => createChainableResult([])),
    update: vi.fn(() => createChainableResult([])),
  },
}));

const db = asMockedDb((await import('@/db/client.js')).db);
const {
  hashRefreshToken,
  issueRefreshToken,
  revokeMostRecentRefreshTokenForUser,
  revokeRefreshTokenByHash,
  rotateRefreshToken,
} = await import('@/services/refreshToken.service.js');

const userId = 'b6f8a3c2-1d4e-4a5b-9c6d-7e8f9a0b1c2d';

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-id-1',
    userId,
    tokenHash: hashRefreshToken('some-plaintext-token'),
    sessionFamily: 'family-1',
    clientId: null,
    ipAddress: null,
    userAgent: null,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 604_800_000),
    revokedAt: null,
    revocationReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(db.select).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.insert).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.update).mockReset().mockReturnValue(createChainableResult([]));
});

describe('issueRefreshToken', () => {
  it('generates a 256-bit URL-safe plaintext and inserts its SHA-256 hash', async () => {
    const issued = await issueRefreshToken(userId, {});

    expect(issued.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url(32 bytes)
    expect(issued.tokenHash).toBe(hashRefreshToken(issued.plaintext));
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it('reuses the given session_family, or mints a new one', async () => {
    const first = await issueRefreshToken(userId, {});
    const second = await issueRefreshToken(userId, {}, first.sessionFamily);

    expect(second.sessionFamily).toBe(first.sessionFamily);
  });
});

describe('rotateRefreshToken', () => {
  it('rejects a token with no matching row', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([]));

    const result = await rotateRefreshToken('unknown-token', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.statusCode).toBe(401);
  });

  it('rotates an active token: marks it revoked and issues a new one in the same family', async () => {
    const plaintext = 'valid-plaintext-token';
    const row = activeRow({ tokenHash: hashRefreshToken(plaintext) });
    vi.mocked(db.select).mockReturnValue(createChainableResult([row]));

    const result = await rotateRefreshToken(plaintext, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe(userId);
      expect(result.value.issued.sessionFamily).toBe(row.sessionFamily);
    }
    expect(db.update).toHaveBeenCalled(); // old row marked revoked
    expect(db.insert).toHaveBeenCalled(); // new row inserted
  });

  it('rejects an expired token', async () => {
    const plaintext = 'expired-plaintext-token';
    const row = activeRow({
      tokenHash: hashRefreshToken(plaintext),
      expiresAt: new Date(Date.now() - 1_000),
    });
    vi.mocked(db.select).mockReturnValue(createChainableResult([row]));

    const result = await rotateRefreshToken(plaintext, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.statusCode).toBe(401);
  });

  it('detects reuse (already-revoked row) and returns token_reuse_detected', async () => {
    const plaintext = 'reused-plaintext-token';
    const row = activeRow({
      tokenHash: hashRefreshToken(plaintext),
      revokedAt: new Date(),
      revocationReason: 'rotation',
    });

    // First select: locate the presented (already-revoked) row.
    // Second select: revokeSessionFamily's lookup of active family members.
    vi.mocked(db.select)
      .mockReturnValueOnce(createChainableResult([row]))
      .mockReturnValueOnce(createChainableResult([row]));

    const result = await rotateRefreshToken(plaintext, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('token_reuse_detected');
      expect(result.error.statusCode).toBe(401);
    }
    // The whole family gets revoked, not just the presented token.
    expect(db.update).toHaveBeenCalled();
  });
});

describe('revokeRefreshTokenByHash / revokeMostRecentRefreshTokenForUser', () => {
  it('revokeRefreshTokenByHash is a no-op when no matching row exists', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([]));
    await revokeRefreshTokenByHash('nonexistent-hash', 'logout');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('revokeRefreshTokenByHash revokes the matching row', async () => {
    const row = activeRow();
    vi.mocked(db.select).mockReturnValue(createChainableResult([row]));
    await revokeRefreshTokenByHash(row.tokenHash, 'logout');
    expect(db.update).toHaveBeenCalledOnce();
  });

  it('revokeMostRecentRefreshTokenForUser is a no-op with no active tokens', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([]));
    await revokeMostRecentRefreshTokenForUser(userId, 'logout');
    expect(db.update).not.toHaveBeenCalled();
  });
});
