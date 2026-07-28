/**
 * Per-request structured HTTP access log (FR-25, AC-34).
 *
 * Excludes /health and /ready — FR-24 already excludes probes from audit
 * logging; extending that to request logging avoids probe-spam on every
 * liveness/readiness poll.
 */

import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger.js';

const EXCLUDED_PATHS = new Set(['/health', '/ready']);

export function httpLogger(req: Request, res: Response, next: NextFunction): void {
  if (EXCLUDED_PATHS.has(req.path)) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info('HTTP request', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      latencyMs: Math.round(latencyMs * 100) / 100,
    });
  });

  next();
}
