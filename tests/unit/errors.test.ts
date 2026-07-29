import { describe, expect, it } from 'vitest';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  InsufficientScopeError,
  InvalidCredentialsError,
  InvalidTokenError,
  NotFoundError,
  RouteNotFoundError,
  TokenExpiredError,
  TokenReuseDetectedError,
  TokenRevokedError,
  TooManyRequestsError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
} from '@/types/errors.js';

describe('AppError', () => {
  it('is an Error with code/statusCode/details attached', () => {
    const error = new AppError('some_code', 'Some message', 418, { extra: true });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('some_code');
    expect(error.message).toBe('Some message');
    expect(error.statusCode).toBe(418);
    expect(error.details).toEqual({ extra: true });
  });
});

describe('spec-exact lowercase error codes (AC-2, AC-4, AC-5, AC-8, AC-24, AC-25, AC-32)', () => {
  it.each([
    [new UnauthorizedError(), 'unauthorized', 401],
    [new InvalidCredentialsError(), 'invalid_credentials', 401],
    [new TokenExpiredError(), 'token_expired', 401],
    [new TokenRevokedError(), 'token_revoked', 401],
    [new TokenReuseDetectedError(), 'token_reuse_detected', 401],
    [new InsufficientScopeError('api:write'), 'insufficient_scope', 403],
    [new ForbiddenError('Insufficient role'), 'forbidden', 403],
    [new RouteNotFoundError('/api/unknown/path'), 'route_not_found', 404],
    [new UpstreamError('users', 'unreachable'), 'bad_gateway', 502],
    [new GatewayTimeoutError('users'), 'gateway_timeout', 504],
    [new TooManyRequestsError(), 'rate_limit_exceeded', 429],
  ])('%#: %s', (error, code, statusCode) => {
    expect(error.code).toBe(code);
    expect(error.statusCode).toBe(statusCode);
    expect(error).toBeInstanceOf(AppError);
  });
});

describe('other AppError subclasses map to the correct HTTP status', () => {
  it.each([
    [new ValidationError('bad input'), 400],
    [new BadRequestError('bad request'), 400],
    [new InvalidTokenError(), 401],
    [new ForbiddenError(), 403],
    [new NotFoundError('User'), 404],
    [new ConflictError('duplicate'), 409],
    [new UpstreamError('billing-service', 'timeout'), 502],
  ])('%#: statusCode %i', (error, statusCode) => {
    expect(error.statusCode).toBe(statusCode);
  });

  it('NotFoundError builds a "<resource> not found" message', () => {
    expect(new NotFoundError('User').message).toBe('User not found');
  });

  it('UpstreamError names the failing service and cause', () => {
    expect(new UpstreamError('billing-service', 'timeout').message).toContain('billing-service');
    expect(new UpstreamError('billing-service', 'timeout').message).toContain('timeout');
  });

  it('RouteNotFoundError names the unmatched path', () => {
    expect(new RouteNotFoundError('/api/unknown/path').message).toContain('/api/unknown/path');
  });

  it('GatewayTimeoutError names the timed-out service', () => {
    expect(new GatewayTimeoutError('users').message).toContain('users');
  });
});
