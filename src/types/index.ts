/**
 * Shared TypeScript types used throughout the codebase.
 *
 * Mirrors specs/app-gateway-auth.spec.md §4.4 exactly.
 */

export interface JwtAccessTokenClaims {
  sub: string; // user UUID
  email: string;
  roles: string[];
  auth_method: 'password' | 'saml' | 'oauth';
  tenant_id: string | null;
  scope: string;
  iat: number;
  exp: number;
  nbf: number;
  iss: string;
  aud: string | string[];
  jti: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export interface UserProfile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  roles: string[];
  auth_method: string;
  tenant_id: string | null;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
}

// Declared for forward-compat with the proxy phase (FR-16) — unused in Phase 1.
export interface RouteConfig {
  path: string;
  upstream: string;
  auth_required: boolean;
  required_scope: string | null;
  allowed_roles: string[] | null;
  rate_limit_override: number | null;
  strip_prefix: boolean;
  timeout_ms: number;
}

export interface AuditLogEntry {
  event_type: string;
  user_id?: string | null;
  client_id?: string | null;
  ip_address?: string;
  user_agent?: string;
  resource?: string;
  outcome: 'success' | 'failure' | 'denied';
  failure_reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
  request_id?: string;
}
