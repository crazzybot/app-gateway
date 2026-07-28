/**
 * Global error handler.
 *
 * Maps typed AppError subclasses to HTTP status codes. Unknown errors are
 * logged at `error` level and returned as 500 Internal Server Error — the
 * actual error detail is never leaked to the client in production.
 *
 * Usage in Express (4-arg signature):
 *   app.use((err, req, res, next) => errorHandler(err, req, res));
 */

import type { Request, Response } from 'express';
import { AppError } from '../types/errors.js';
import { logger } from '../config/logger.js';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
): void {
  const requestId = res.locals['requestId'] as string | undefined;

  if (err instanceof AppError) {
    // Operational errors — expected, no stack trace needed at warn level.
    logger.warn(
      {
        requestId,
        code: err.code,
        statusCode: err.statusCode,
        path: req.path,
        method: req.method,
      },
      err.message,
    );

    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  // Unexpected / programming errors — log with full stack.
  logger.error(
    {
      requestId,
      path: req.path,
      method: req.method,
      err,
    },
    'Unhandled error',
  );

  const isDev = process.env['NODE_ENV'] !== 'production';

  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred. Please try again later.',
    ...(isDev && err instanceof Error
      ? { stack: err.stack }
      : {}),
  });
}
