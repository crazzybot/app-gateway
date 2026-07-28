import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, unwrap } from '@/types/result.js';

describe('Result<T, E> helpers', () => {
  it('ok() / isOk() narrow to the success branch', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) expect(result.value).toBe(42);
  });

  it('err() / isErr() narrow to the failure branch', () => {
    const result = err(new Error('boom'));
    expect(result.ok).toBe(false);
    expect(isErr(result)).toBe(true);
    expect(isOk(result)).toBe(false);
    if (isErr(result)) expect(result.error.message).toBe('boom');
  });

  it('unwrap() returns the value for Ok', () => {
    expect(unwrap(ok('value'))).toBe('value');
  });

  it('unwrap() throws the error for Err', () => {
    const error = new Error('boom');
    expect(() => unwrap(err(error))).toThrow(error);
  });
});
