import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { TooManyRequestsError } from '@/types/errors.js';

vi.mock('@/services/token.service.js', () => ({
  redis: {
    incr: vi.fn(),
    pexpire: vi.fn(),
  },
}));

const { redis } = await import('@/services/token.service.js');
const { rateLimiter } = await import('@/middleware/rateLimiter.js');

function makeResponse(): Response {
  const headers = new Map<string, string>();
  return {
    setHeader: vi.fn((name: string, value: string) => headers.set(name, value)),
    _headers: headers,
  } as unknown as Response;
}

function makeRequest(ip = '203.0.113.7'): Request {
  return { ip } as unknown as Request;
}

beforeEach(() => {
  vi.mocked(redis.incr).mockReset();
  vi.mocked(redis.pexpire).mockReset().mockResolvedValue(1);
});

describe('rateLimiter', () => {
  it('allows a request within the limit and sets X-RateLimit-* headers', async () => {
    vi.mocked(redis.incr).mockResolvedValue(1);
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await rateLimiter({ maxRequests: 100 })(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '99');
  });

  it('rejects the (N+1)th request with 429 and Retry-After', async () => {
    vi.mocked(redis.incr).mockResolvedValue(101); // over the limit of 100
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await rateLimiter({ maxRequests: 100 })(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(TooManyRequestsError));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });

  it('calls pexpire only on the first request in a window', async () => {
    const next = vi.fn() as unknown as NextFunction;

    vi.mocked(redis.incr).mockResolvedValue(1);
    await rateLimiter({ maxRequests: 100 })(makeRequest(), makeResponse(), next);
    expect(redis.pexpire).toHaveBeenCalledOnce();

    vi.mocked(redis.incr).mockResolvedValue(2);
    await rateLimiter({ maxRequests: 100 })(makeRequest(), makeResponse(), next);
    expect(redis.pexpire).toHaveBeenCalledOnce(); // still 1 — not called again
  });

  it('respects a custom maxRequests override (e.g. per-client limit)', async () => {
    vi.mocked(redis.incr).mockResolvedValue(6);
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await rateLimiter({ maxRequests: 5 })(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(TooManyRequestsError));
  });

  it('fails open (allows the request) when Redis errors', async () => {
    vi.mocked(redis.incr).mockRejectedValue(new Error('ECONNREFUSED'));
    const req = makeRequest();
    const res = makeResponse();
    const next = vi.fn();

    await rateLimiter({ maxRequests: 100 })(req, res, next);

    expect(next).toHaveBeenCalledWith(); // no error passed — request proceeds
  });
});
