import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { validate } from '@/middleware/validate.js';
import { ValidationError } from '@/types/errors.js';

const bodySchema = z.object({ email: z.string().email() });

describe('validate middleware', () => {
  it('replaces req.body with the parsed/coerced data on success', () => {
    const req = { body: { email: 'user@example.com' } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    validate(bodySchema)(req, {} as Response, next);

    expect(req.body).toEqual({ email: 'user@example.com' });
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next with a ValidationError on a failed body parse', () => {
    const req = { body: { email: 'not-an-email' } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    validate(bodySchema)(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('mutates req.query in place rather than reassigning it', () => {
    const querySchema = z.object({ redirect_to: z.string().default('/') });
    const query: Record<string, unknown> = {};
    const req = { query } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    validate(querySchema, 'query')(req, {} as Response, next);

    expect(req.query).toBe(query); // same object reference — mutated, not replaced
    expect(query['redirect_to']).toBe('/');
    expect(next).toHaveBeenCalledWith();
  });
});
