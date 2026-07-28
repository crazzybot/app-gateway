/**
 * TTL / expiry helpers shared by token revocation (Redis TTL math) and
 * refresh-token rotation (Postgres expiry math).
 */

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1_000);
}

export function isPast(date: Date): boolean {
  return date.getTime() <= Date.now();
}

/** Seconds remaining until `date`, floored at 0 (never negative). */
export function ttlSecondsUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1_000));
}
