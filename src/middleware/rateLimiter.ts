/**
 * Redis-backed rate limiter (FR-22, NFR-3).
 *
 * Fixed-window counter keyed as `{prefix}:{ip}:{window_start}` — matches the
 * literal key format in FR-22 ("ratelimit:{ip}:{window_start_minute}"),
 * which despite the spec's "sliding-window" prose is a fixed-window design
 * per its own key scheme. INCR + PEXPIRE keeps this to two Redis round
 * trips per request with no read-modify-write race.
 */

import type { NextFunction, Request, Response } from 'express';
import { redis } from '../services/token.service.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { TooManyRequestsError } from '../types/errors.js';

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  keyPrefix?: string;
}

export function rateLimiter(options: RateLimiterOptions = {}) {
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests ?? env.RATE_LIMIT_MAX_REQUESTS;
  const keyPrefix = options.keyPrefix ?? 'ratelimit';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = req.ip ?? 'unknown';
    const windowStart = Math.floor(Date.now() / windowMs);
    const key = `${keyPrefix}:${identifier}:${windowStart}`;
    const windowResetAtMs = (windowStart + 1) * windowMs;

    let count: number;
    try {
      count = await redis.incr(key);
      if (count === 1) {
        await redis.pexpire(key, windowMs);
      }
    } catch (error) {
      // Fail open rather than let a Redis blip take down authentication —
      // but log loudly, since rate limiting is silently disabled meanwhile.
      logger.error('Rate limiter Redis error — failing open', { err: error });
      next();
      return;
    }

    const remaining = Math.max(0, maxRequests - count);
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(windowResetAtMs / 1_000)));

    if (count > maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowResetAtMs - Date.now()) / 1_000),
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      next(new TooManyRequestsError());
      return;
    }

    next();
  };
}
