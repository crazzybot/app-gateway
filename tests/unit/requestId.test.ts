import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requestId } from '@/middleware/requestId.js';

function makeResponse(): Response {
  const locals: Record<string, unknown> = {};
  return {
    locals,
    setHeader: vi.fn(),
  } as unknown as Response;
}

describe('requestId middleware', () => {
  it('generates a UUID when no X-Request-ID header is present', () => {
    const req = { headers: {} } as unknown as Request;
    const res = makeResponse();
    const next = vi.fn() as unknown as NextFunction;

    requestId(req, res, next);

    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.locals['requestId']).toBe(req.requestId);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId);
    expect(next).toHaveBeenCalledWith();
  });

  it('reuses an incoming X-Request-ID header instead of generating one', () => {
    const req = { headers: { 'x-request-id': 'client-supplied-id' } } as unknown as Request;
    const res = makeResponse();
    const next = vi.fn() as unknown as NextFunction;

    requestId(req, res, next);

    expect(req.requestId).toBe('client-supplied-id');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'client-supplied-id');
  });
});
