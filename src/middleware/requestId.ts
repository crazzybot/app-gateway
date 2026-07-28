/**
 * Request ID middleware.
 *
 * Reads `X-Request-ID` from the incoming request (set by load-balancer /
 * API gateway) or generates a new UUID v4. The value is written back into
 * the response header so callers can correlate logs.
 *
 * The id is stored on `res.locals.requestId` so downstream middleware and
 * route handlers can include it in log entries without re-reading the header.
 */

import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function requestId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id =
    (req.headers['x-request-id'] as string | undefined) ?? uuidv4();

  req.requestId = id;
  res.locals['requestId'] = id;
  res.setHeader('X-Request-ID', id);

  next();
}
