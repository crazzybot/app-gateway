import { describe, expect, it } from 'vitest';
import { isPast, secondsFromNow, ttlSecondsUntil } from '@/utils/time.js';

describe('secondsFromNow', () => {
  it('returns a Date offset into the future by the given seconds', () => {
    const before = Date.now();
    const date = secondsFromNow(60);
    const after = Date.now();
    expect(date.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(date.getTime()).toBeLessThanOrEqual(after + 60_000);
  });
});

describe('isPast', () => {
  it('is true for a date in the past', () => {
    expect(isPast(new Date(Date.now() - 1_000))).toBe(true);
  });

  it('is false for a date in the future', () => {
    expect(isPast(new Date(Date.now() + 60_000))).toBe(false);
  });
});

describe('ttlSecondsUntil', () => {
  it('floors at 0 for a past date', () => {
    expect(ttlSecondsUntil(new Date(Date.now() - 60_000))).toBe(0);
  });

  it('rounds up to whole seconds remaining for a future date', () => {
    expect(ttlSecondsUntil(new Date(Date.now() + 30_500))).toBeGreaterThanOrEqual(31);
  });
});
