/**
 * Typed error hierarchy for the App Gateway Service.
 *
 * All operational errors extend AppError so the global error handler can map
 * them to the correct HTTP status code without instanceof chains in routes.
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
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

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class InvalidTokenError extends AppError {
  constructor(message = 'Token is invalid or has expired') {
    super('INVALID_TOKEN', message, 401);
  }
}

// ── 403 ──────────────────────────────────────────────────────────────────────

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}

// ── 404 ──────────────────────────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`, 404);
  }
}

// ── 409 ──────────────────────────────────────────────────────────────────────

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

// ── 429 ──────────────────────────────────────────────────────────────────────

export class TooManyRequestsError extends AppError {
  constructor(message = 'Rate limit exceeded. Please slow down.') {
    super('RATE_LIMITED', message, 429);
  }
}

// ── 502 ──────────────────────────────────────────────────────────────────────

export class UpstreamError extends AppError {
  constructor(service: string, cause?: string) {
    super(
      'UPSTREAM_ERROR',
      `Upstream service "${service}" returned an error${cause ? `: ${cause}` : '.'}`,
      502,
    );
  }
}
