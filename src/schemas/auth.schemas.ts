/**
 * Zod schemas for /v1/auth request bodies (NFR-5: validate every external
 * input boundary; parse once at the edge, pass typed values inward).
 */

import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'email is required').email('email must be a valid address'),
  password: z.string().min(1, 'password is required'),
});
export type LoginBody = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'refresh_token is required'),
  idempotency_key: z.string().uuid('idempotency_key must be a valid UUID').optional(),
});
export type RefreshBody = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});
export type LogoutBody = z.infer<typeof logoutSchema>;
