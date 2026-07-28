import { describe, expect, it } from 'vitest';
import { loginSchema, logoutSchema, refreshSchema } from '@/schemas/auth.schemas.js';

describe('loginSchema', () => {
  it('accepts a valid email/password body', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com', password: 'hunter2' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing email', () => {
    const result = loginSchema.safeParse({ password: 'hunter2' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing password', () => {
    const result = loginSchema.safeParse({ email: 'user@example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed email', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'hunter2' });
    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace from email', () => {
    const result = loginSchema.safeParse({ email: '  user@example.com  ', password: 'x' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('user@example.com');
  });
});

describe('refreshSchema', () => {
  it('requires a non-empty refresh_token', () => {
    expect(refreshSchema.safeParse({ refresh_token: 'abc' }).success).toBe(true);
    expect(refreshSchema.safeParse({ refresh_token: '' }).success).toBe(false);
    expect(refreshSchema.safeParse({}).success).toBe(false);
  });
});

describe('logoutSchema', () => {
  it('allows an empty body (refresh_token is optional)', () => {
    expect(logoutSchema.safeParse({}).success).toBe(true);
  });

  it('accepts an explicit refresh_token', () => {
    const result = logoutSchema.safeParse({ refresh_token: 'abc' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.refresh_token).toBe('abc');
  });
});
