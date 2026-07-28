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
import type { ErrorResponse } from '../types/index.js';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    // Operational errors — expected, no stack trace needed at warn level.
    logger.warn(err.message, {
      requestId,
      code: err.code,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    });

    const body: ErrorResponse = {
      error: err.code,
      error_description: err.message,
      request_id: requestId,
    };

    res.status(err.statusCode).json(body);
    return;
  }

  // Unexpected / programming errors — log with full stack.
  logger.error('Unhandled error', {
    requestId,
    path: req.path,
    method: req.method,
    err,
  });

  const body: ErrorResponse = {
    error: 'internal_server_error',
    error_description: 'An unexpected error occurred. Please try again later.',
    request_id: requestId,
  };

  res.status(500).json(body);
}
