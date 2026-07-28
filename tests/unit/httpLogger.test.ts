import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { httpLogger } from '@/middleware/httpLogger.js';
import { logger } from '@/config/logger.js';

function makeResponse(): { res: Response; fireFinish: () => void } {
  let finishHandler: (() => void) | undefined;
  const res = {
    statusCode: 200,
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'finish') finishHandler = handler;
    }),
  } as unknown as Response;
  return { res, fireFinish: () => finishHandler?.() };
}

describe('httpLogger middleware', () => {
  it('logs method/path/status/latencyMs/requestId once the response finishes', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const req = { path: '/v1/auth/login', method: 'POST', requestId: 'req-1' } as unknown as Request;
    const { res, fireFinish } = makeResponse();
    const next = vi.fn() as unknown as NextFunction;

    httpLogger(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(infoSpy).not.toHaveBeenCalled(); // not logged until 'finish'

    fireFinish();

    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP request',
      expect.objectContaining({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/auth/login',
        status: 200,
      }),
    );
    infoSpy.mockRestore();
  });

  it('does not attach a finish listener for /health', () => {
    const req = { path: '/health', method: 'GET', requestId: 'req-2' } as unknown as Request;
    const { res } = makeResponse();
    const next = vi.fn() as unknown as NextFunction;

    httpLogger(req, res, next);

    expect(res.on).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('does not attach a finish listener for /ready', () => {
    const req = { path: '/ready', method: 'GET', requestId: 'req-3' } as unknown as Request;
    const { res } = makeResponse();
    const next = vi.fn() as unknown as NextFunction;

    httpLogger(req, res, next);

    expect(res.on).not.toHaveBeenCalled();
  });
});
