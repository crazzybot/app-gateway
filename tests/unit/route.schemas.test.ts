import { describe, expect, it } from 'vitest';
import { routeConfigListSchema, routeConfigSchema } from '@/schemas/route.schemas.js';

function validRoute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: '/api/users/*rest',
    upstream: 'http://users-service:4001',
    auth_required: true,
    required_scope: null,
    allowed_roles: null,
    rate_limit_override: null,
    strip_prefix: false,
    timeout_ms: 30_000,
    audit_allowed_requests: false,
    ...overrides,
  };
}

describe('routeConfigSchema', () => {
  it('accepts a fully-specified valid route entry', () => {
    const result = routeConfigSchema.safeParse(validRoute());
    expect(result.success).toBe(true);
  });

  it('defaults audit_allowed_requests to false when omitted', () => {
    const input = validRoute();
    delete input['audit_allowed_requests'];
    const result = routeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audit_allowed_requests).toBe(false);
    }
  });

  it('defaults timeout_ms to 30000 when omitted', () => {
    const input = validRoute();
    delete input['timeout_ms'];
    const result = routeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_ms).toBe(30_000);
    }
  });

  it.each([
    ['path', undefined],
    ['upstream', undefined],
    ['auth_required', undefined],
    ['strip_prefix', undefined],
  ])('rejects a route entry missing required field %s', (field) => {
    const input = validRoute();
    delete input[field];
    const result = routeConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL upstream', () => {
    const result = routeConfigSchema.safeParse(validRoute({ upstream: 'not-a-url' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty path', () => {
    const result = routeConfigSchema.safeParse(validRoute({ path: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects required_scope of the wrong type (must be string or null)', () => {
    const result = routeConfigSchema.safeParse(validRoute({ required_scope: 123 }));
    expect(result.success).toBe(false);
  });

  it('accepts required_scope explicitly set to null', () => {
    const result = routeConfigSchema.safeParse(validRoute({ required_scope: 'api:read' }));
    expect(result.success).toBe(true);
  });

  it('rejects allowed_roles containing non-string entries', () => {
    const result = routeConfigSchema.safeParse(validRoute({ allowed_roles: ['admin', 42] }));
    expect(result.success).toBe(false);
  });

  it('rejects a negative or zero rate_limit_override', () => {
    expect(routeConfigSchema.safeParse(validRoute({ rate_limit_override: 0 })).success).toBe(false);
    expect(routeConfigSchema.safeParse(validRoute({ rate_limit_override: -1 })).success).toBe(false);
  });

  it('rejects a rate_limit_override above the sanity ceiling', () => {
    expect(routeConfigSchema.safeParse(validRoute({ rate_limit_override: 100_001 })).success).toBe(false);
  });

  it('accepts a positive rate_limit_override', () => {
    const result = routeConfigSchema.safeParse(validRoute({ rate_limit_override: 20 }));
    expect(result.success).toBe(true);
  });
});

describe('routeConfigListSchema', () => {
  it('accepts an array of valid route entries', () => {
    const result = routeConfigListSchema.safeParse([validRoute(), validRoute({ path: '/api/public/*rest' })]);
    expect(result.success).toBe(true);
  });

  it('rejects the array if any single entry is malformed', () => {
    const result = routeConfigListSchema.safeParse([validRoute(), { path: '/api/broken' }]);
    expect(result.success).toBe(false);
  });

  it('accepts an empty array', () => {
    const result = routeConfigListSchema.safeParse([]);
    expect(result.success).toBe(true);
  });
});
