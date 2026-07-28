import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { validateAccessToken } from '@/middleware/authenticate.js';
import { UnauthorizedError, TokenExpiredError } from '@/types/errors.js';
import { ok, err } from '@/types/result.js';
import type { JwtAccessTokenClaims } from '@/types/index.js';

vi.mock('@/services/token.service.js', () => ({
  verifyAccessToken: vi.fn(),
}));

const { verifyAccessToken } = await import('@/services/token.service.js');

function makeRequest(authorization?: string): Request {
  return { headers: { authorization } } as unknown as Request;
}

const claims: JwtAccessTokenClaims = {
  sub: 'user-1',
  email: 'user@example.com',
  roles: ['viewer'],
  auth_method: 'password',
  tenant_id: null,
  scope: 'api:read',
  iat: 0,
  exp: 900,
  nbf: 0,
  iss: 'http://localhost:3000',
  aud: 'platform',
  jti: 'jti-1',
};

describe('validateAccessToken (required)', () => {
  it('calls next with UnauthorizedError when no Authorization header is present', async () => {
    const req = makeRequest();
    const next = vi.fn();

    await validateAccessToken()(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('calls next with UnauthorizedError for a malformed header (no Bearer prefix)', async () => {
    const req = makeRequest('Basic abc123');
    const next = vi.fn();

    await validateAccessToken()(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });

  it('attaches req.auth and calls next() with no error on success', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(ok(claims));
    const req = makeRequest('Bearer valid-token');
    const next = vi.fn();

    await validateAccessToken()(req, {} as Response, next);

    expect(req.auth).toEqual(claims);
    expect(next).toHaveBeenCalledWith();
  });

  it('propagates the service error and does not attach req.auth on failure', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(err(new TokenExpiredError()));
    const req = makeRequest('Bearer expired-token');
    const next = vi.fn();

    await validateAccessToken()(req, {} as Response, next);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith(expect.any(TokenExpiredError));
  });
});

describe('validateAccessToken({ optional: true })', () => {
  it('proceeds unauthenticated when no header is present', async () => {
    const req = makeRequest();
    const next = vi.fn();

    await validateAccessToken({ optional: true })(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toBeUndefined();
  });

  it('still validates and attaches req.auth when a header IS present', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue(ok(claims));
    const req = makeRequest('Bearer valid-token');
    const next = vi.fn();

    await validateAccessToken({ optional: true })(req, {} as Response, next);

    expect(req.auth).toEqual(claims);
    expect(next).toHaveBeenCalledWith();
  });
});
