/**
 * Typed error hierarchy for the App Gateway Service.
 *
 * All operational errors extend AppError so the global error handler can map
 * them to the correct HTTP status code without instanceof chains in routes.
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public override readonly message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    // Restore prototype chain (needed when targeting ES5).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── 400 ──────────────────────────────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super('BAD_REQUEST', message, 400, details);
  }
}

// ── 401 ──────────────────────────────────────────────────────────────────────

/**
 * Spec-exact lowercase code (AC-25, openapi.yaml ErrorResponse doc comment
 * and the shared Unauthorized response's `unauthorized` example) — was
 * `UNAUTHORIZED` before this reconciliation; no test asserted the old
 * literal code string, so this is a safe rename, not a breaking change to
 * any documented contract.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('unauthorized', message, 401);
  }
}

export class InvalidTokenError extends AppError {
  constructor(message = 'Token is invalid or has expired') {
    super('INVALID_TOKEN', message, 401);
  }
}

/**
 * Spec-exact lowercase error codes (AC-2, AC-4, AC-5, AC-8) — errorHandler.ts
 * emits `err.code` verbatim as the wire `error` field, so these carry the
 * literal string values acceptance criteria assert on, not the generic
 * SCREAMING_SNAKE codes above.
 */

export class InvalidCredentialsError extends AppError {
  constructor(message = 'Email or password is incorrect') {
    super('invalid_credentials', message, 401);
  }
}

export class TokenExpiredError extends AppError {
  constructor(message = 'Token has expired') {
    super('token_expired', message, 401);
  }
}

export class TokenRevokedError extends AppError {
  constructor(message = 'Token has been revoked') {
    super('token_revoked', message, 401);
  }
}

export class TokenReuseDetectedError extends AppError {
  constructor(message = 'Refresh token reuse detected; session revoked') {
    super('token_reuse_detected', message, 401);
  }
}

// ── 403 ──────────────────────────────────────────────────────────────────────

/**
 * Spec-exact lowercase code (AC-32, openapi.yaml Forbidden `insufficient_role`
 * example: `error: forbidden`) — not used by any route before this feature,
 * so aligning it to the documented wire code is a safe rename.
 */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super('forbidden', message, 403);
  }
}

export class InsufficientScopeError extends AppError {
  constructor(public readonly requiredScope: string) {
    super(
      'insufficient_scope',
      `Requires scope "${requiredScope}"`,
      403,
      { scope: requiredScope },
    );
  }
}

// ── 404 ──────────────────────────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`, 404);
  }
}

/** No proxy route configured for the requested path (FR-16, openapi.yaml). */
export class RouteNotFoundError extends AppError {
  constructor(path: string) {
    super(
      'route_not_found',
      `No upstream route is configured for '${path}'.`,
      404,
    );
  }
}

// ── 409 ──────────────────────────────────────────────────────────────────────

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

// ── 429 ──────────────────────────────────────────────────────────────────────

/**
 * Spec-exact lowercase code (FR-19(d), openapi.yaml TooManyRequests
 * response's `rate_limit_exceeded` example) — was `RATE_LIMITED` before
 * this reconciliation; no test asserted the old literal code string.
 */
export class TooManyRequestsError extends AppError {
  constructor(message = 'Rate limit exceeded. Please slow down.') {
    super('rate_limit_exceeded', message, 429);
  }
}

// ── 502 ──────────────────────────────────────────────────────────────────────

/**
 * Spec-exact lowercase code (openapi.yaml `/api/{service}/{path}` 502
 * example: `bad_gateway`) — was `UPSTREAM_ERROR` before this reconciliation
 * (R-1); no test asserted the old literal code string, so this is a safe
 * rename, not a breaking change to any documented contract.
 */
export class UpstreamError extends AppError {
  constructor(service: string, cause?: string) {
    super(
      'bad_gateway',
      `Upstream service "${service}" returned an error${cause ? `: ${cause}` : '.'}`,
      502,
    );
  }
}

// ── 504 ──────────────────────────────────────────────────────────────────────

export class GatewayTimeoutError extends AppError {
  constructor(service: string) {
    super(
      'gateway_timeout',
      `Upstream service "${service}" did not respond within the configured timeout.`,
      504,
    );
  }
}
