/**
 * Lightweight Result<T, E> type for service functions.
 *
 * Service functions return Result instead of throwing so route handlers have
 * explicit, type-safe error branches without try/catch everywhere.
 *
 * Usage:
 *   function doThing(): Result<User, AppError> { ... }
 *
 *   const result = doThing();
 *   if (!result.ok) {
 *     return next(result.error);  // pass to Express error handler
 *   }
 *   res.json(result.value);
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type-guard: narrows Result<T, E> to Ok<T>. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type-guard: narrows Result<T, E> to Err<E>. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Unwrap a Result, throwing the error if it's an Err.
 * Useful in tests or top-level code where you want to assert success.
 */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
