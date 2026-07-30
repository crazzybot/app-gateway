/**
 * Zod schema for the `routes` JSON configuration file (FR-16) — validates
 * every entry at startup before the proxy accepts traffic.
 *
 * `path` is matched with the same path-to-regexp version Express 5 already
 * depends on (v8+), which does not accept the Express-4-style `:name*`
 * wildcard syntax — use `*name` (e.g. `/api/users/*rest`) instead.
 */

import { z } from 'zod';

export const routeConfigSchema = z.object({
  path: z.string().min(1, 'path is required'),
  upstream: z.string().url('upstream must be a valid URL'),
  auth_required: z.boolean(),
  required_scope: z.string().nullable(),
  allowed_roles: z.array(z.string()).nullable(),
  // Upper bound is a sanity ceiling, not a spec'd limit — guards against a
  // config typo (e.g. an extra zero) silently disabling rate limiting for
  // a route rather than a real intended throughput target.
  rate_limit_override: z.number().int().positive().max(100_000).nullable(),
  strip_prefix: z.boolean(),
  timeout_ms: z.number().int().positive().optional().default(30_000),
  audit_allowed_requests: z.boolean().optional().default(false),
});
export type RouteConfigInput = z.infer<typeof routeConfigSchema>;

export const routeConfigListSchema = z.array(routeConfigSchema);
