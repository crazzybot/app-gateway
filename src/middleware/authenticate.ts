/**
 * `validateAccessToken` — the FR-2 JWT bearer verification middleware.
 *
 * Parses `Authorization: Bearer <token>`, verifies it (signature, iss, aud,
 * exp, nbf, Redis revocation — see token.service.ts), and attaches the
 * decoded claims to `req.auth`. On any failure it calls `next(err)` with a
 * specific AppError and never falls through to the next handler.
 */

import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../services/token.service.js';
import { UnauthorizedError } from '../types/errors.js';

export interface ValidateAccessTokenOptions {
  /** If true, requests with no Authorization header proceed unauthenticated (FR-17). */
  optional?: boolean;
}

export function validateAccessToken(options: ValidateAccessTokenOptions = {}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      if (options.optional) {
        next();
        return;
      }
      next(new UnauthorizedError('Missing or malformed Authorization header'));
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    const result = await verifyAccessToken(token);

    if (!result.ok) {
      next(result.error);
      return;
    }

    req.auth = result.value;
    next();
  };
}
