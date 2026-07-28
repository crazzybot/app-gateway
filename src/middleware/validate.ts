/**
 * Generic Zod request-validation middleware factory (NFR-5: validate every
 * external input boundary).
 */

import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '../types/errors.js';

type ValidationTarget = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, target: ValidationTarget = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const value: unknown =
      target === 'body' ? req.body : target === 'query' ? req.query : req.params;

    const result = schema.safeParse(value);
    if (!result.success) {
      next(
        new ValidationError('Request validation failed', result.error.flatten()),
      );
      return;
    }

    const data: unknown = result.data;

    if (target === 'body') {
      // `body` is always a plain mutable property — safe to replace outright.
      req.body = data;
    } else {
      // `query`/`params` can be read-only getters depending on Express
      // version — mutate the existing object in place instead.
      Object.assign(value as Record<string, unknown>, data);
    }

    next();
  };
}
