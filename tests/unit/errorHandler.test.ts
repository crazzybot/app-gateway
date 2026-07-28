import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { errorHandler } from '@/middleware/errorHandler.js';
import { InvalidCredentialsError } from '@/types/errors.js';

function makeResponse(): { res: Response; getBody: () => unknown; getStatus: () => number } {
  let status = 0;
  let body: unknown;
  const res = {
    status: vi.fn((code: number) => {
      status = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
  } as unknown as Response;
  return { res, getBody: () => body, getStatus: () => status };
}

describe('errorHandler', () => {
  it('maps an AppError to its statusCode and the spec ErrorResponse shape', () => {
    const req = { requestId: 'req-1', path: '/v1/auth/login', method: 'POST' } as unknown as Request;
    const { res, getBody, getStatus } = makeResponse();

    errorHandler(new InvalidCredentialsError(), req, res);

    expect(getStatus()).toBe(401);
    expect(getBody()).toEqual({
      error: 'invalid_credentials',
      error_description: 'Email or password is incorrect',
      request_id: 'req-1',
    });
  });

  it('maps an unknown error to a generic 500 without leaking internals', () => {
    const req = { requestId: 'req-2', path: '/v1/auth/login', method: 'POST' } as unknown as Request;
    const { res, getBody, getStatus } = makeResponse();

    errorHandler(new Error('some internal secret detail'), req, res);

    expect(getStatus()).toBe(500);
    const body = getBody() as { error: string; error_description: string };
    expect(body.error).toBe('internal_server_error');
    expect(body.error_description).not.toContain('some internal secret detail');
  });
});
