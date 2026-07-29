# Feature: OAuth 2.0 Authorization Server

**Ticket:** AGW-001-OAUTH (split from AGW-001)
**Status:** `Approved`
**Author:** Platform Architecture Team
**Reviewers:** Security Engineering, Backend Platform, QA Lead
**Created:** 2026-07-01
**Last Updated:** 2026-07-28

---

## Overview

This feature makes the gateway a self-contained OAuth 2.0 authorization server for programmatic and third-party API access, covering the `authorization_code` grant with mandatory PKCE, the `client_credentials` grant for machine-to-machine calls, RFC 7662 token introspection, and admin-driven client registration. Access tokens issued through either grant are the same JWTs described in `core-jwt-authentication.spec.md`, so proxy enforcement, revocation, and JWKS verification all behave identically regardless of how the token was obtained. It touches `src/services/oauth.service.ts` and the `oauth_clients`, `oauth_authorization_codes`, and `oauth_access_tokens` tables.

---

## Functional Requirements

- **FR-11 — Authorization Code Flow with PKCE:** The system SHALL implement the OAuth 2.0 `authorization_code` flow as specified in RFC 6749 and RFC 7636 (PKCE). The `GET /v1/oauth/authorize` endpoint SHALL accept `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, and `code_challenge_method=S256` parameters. PKCE `code_challenge` SHALL be mandatory for all public clients; confidential clients SHOULD provide it. The system SHALL validate: `client_id` exists and is active in `oauth_clients`, `redirect_uri` exactly matches a registered URI for that client, requested `scope` is a subset of the client's allowed scopes, and `code_challenge_method` is `S256`. Upon user authentication and consent (consent screen out of scope — auto-consent for first-party clients), the system SHALL issue an `authorization_code` stored in `oauth_authorization_codes` (TTL 10 minutes), and redirect to `redirect_uri` with `code` and `state` parameters.
- **FR-12 — Client Credentials Flow:** The system SHALL implement the OAuth 2.0 `client_credentials` grant at `POST /v1/oauth/token` with `grant_type=client_credentials`. The endpoint SHALL authenticate the client via HTTP Basic Auth (`client_id:client_secret`, bcrypt-compared) or `client_id`/`client_secret` body parameters (Basic Auth preferred). Only clients with `client_type = 'confidential'` and `grant_types` including `'client_credentials'` in `oauth_clients` SHALL be permitted. The system SHALL issue a JWT access token with the client's registered scopes and `sub = client_id`; no refresh token SHALL be issued for this grant. The issued token SHALL be recorded in `oauth_access_tokens`.
- **FR-13 — Token Introspection:** The system SHALL implement RFC 7662 token introspection at `POST /v1/oauth/introspect`. The endpoint SHALL require HTTP Basic Auth with valid `client_id` and `client_secret`. Given a presented `token` parameter the system SHALL: verify the JWT signature, check the `jti` against the Redis revocation set, check the `exp` claim, and — if the token is active — return a JSON object with `active: true` plus `scope`, `client_id`, `username`, `token_type`, `exp`, `iat`, `nbf`, `sub`, `aud`, `iss`, and `jti`. If the token is invalid, expired, or revoked the system SHALL return `{"active": false}` (NOT a 4xx error, per RFC 7662). The introspection endpoint SHALL be rate-limited independently from user-facing auth endpoints.
- **FR-14 — OAuth Client Registration (Admin):** The system SHALL expose `POST /v1/oauth/clients` (admin-authenticated via a separate admin API key scoped to `admin:oauth`) to register new OAuth clients. The request body SHALL include `client_name`, `client_type` (`public` | `confidential`), `redirect_uris` (array), `grant_types` (array), `allowed_scopes` (array), and optional `logo_uri`, `contacts`. The system SHALL generate a `client_id` (UUID v4) and — for confidential clients — a `client_secret` (256-bit random, stored as bcrypt hash in `oauth_clients.client_secret_hash`; the plaintext SHALL be returned only in the registration response and never again). The system SHALL validate that all `redirect_uris` use HTTPS (except `localhost` for development) and that `grant_types` are a subset of supported values.
- **FR-15 — Scope Enforcement:** The system SHALL define and enforce a platform scope vocabulary. The proxy middleware (→ FR-17, `request-proxy-authorization.spec.md`) SHALL, for OAuth-authenticated requests, verify that the access token's `scope` claim contains the scope required by the target route as configured in route definitions. If the required scope is absent the system SHALL respond `403 Forbidden` with `error: "insufficient_scope"` and `scope` indicating the required scope. Supported platform scopes SHALL include at minimum: `openid`, `profile`, `email`, `offline_access`, `api:read`, `api:write`, `admin:oauth`, `admin:routes`. Scope strings SHALL follow the format `<resource>:<action>`.

---

## Non-Functional Requirements

- **NFR-1 — Performance (partial):** P95 response latency for `/v1/oauth/*` endpoints SHALL be ≤ 150 ms, P99 ≤ 300 ms, under a load of 1,000 concurrent users with a warm Redis and PostgreSQL connection pool.
- **NFR-2 — Token Lifetimes (partial):** Authorization codes SHALL expire 10 minutes after issuance. Client credentials access tokens SHALL expire 1 hour after issuance.

---

## Architecture Impact

### Areas Affected

| Area | Impact |
|------|--------|
| Routes (`src/routes/oauth.router.ts`) | `GET /v1/oauth/authorize`, `POST /v1/oauth/token`, `POST /v1/oauth/introspect`, `POST /v1/oauth/clients` |
| Services (`src/services/oauth.service.ts`) | `[not yet implemented]` — authorization code issuance/exchange, PKCE verification, client_credentials issuance, introspection, client registration |
| Middleware (`src/middleware/rateLimiter.ts`) | Independent rate-limit bucket for `/v1/oauth/introspect` (→ FR-22) |
| Database (`src/db/schema.ts`) | New tables `oauth_clients`, `oauth_authorization_codes`, `oauth_access_tokens` |
| Types (`src/types/index.ts`) | Reuses existing `TokenResponse`, `JwtAccessTokenClaims`; no new shared types required |

### API Changes

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| `GET` | `/v1/oauth/authorize` | New | OAuth 2.0 authorization endpoint; issues auth code |
| `POST` | `/v1/oauth/token` | New | Exchange code (with PKCE) or client credentials for a token |
| `POST` | `/v1/oauth/introspect` | New | Introspect a token per RFC 7662 |
| `POST` | `/v1/oauth/clients` | New | Register a new OAuth client (admin) |
| `POST` | `/v1/oauth/revoke` | New | Revoke an access or refresh token per RFC 7009 — see Open Questions; no FR in the source spec explicitly covers this endpoint's behavior beyond the API table |

### Data Model Changes

```
Table: oauth_clients (NEW)
  id                  UUID PK DEFAULT gen_random_uuid()
  client_id           TEXT NOT NULL UNIQUE     -- UUID v4 string
  client_name         TEXT NOT NULL
  client_type         TEXT NOT NULL            -- 'public' | 'confidential'
  client_secret_hash  TEXT                     -- bcrypt; NULL for public clients
  redirect_uris       TEXT[] NOT NULL DEFAULT '{}'
  grant_types         TEXT[] NOT NULL DEFAULT '{}'
  allowed_scopes      TEXT[] NOT NULL DEFAULT '{}'
  rate_limit_rpm      INTEGER NOT NULL DEFAULT 100
  logo_uri            TEXT
  contacts            TEXT[]
  is_active           BOOLEAN NOT NULL DEFAULT TRUE
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  + UNIQUE INDEX idx_oauth_clients_client_id ON (client_id)

Table: oauth_authorization_codes (NEW)
  id                    UUID PK DEFAULT gen_random_uuid()
  code                  TEXT NOT NULL UNIQUE   -- opaque 256-bit random string
  client_id             TEXT NOT NULL
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  redirect_uri          TEXT NOT NULL
  scope                 TEXT NOT NULL
  code_challenge        TEXT NOT NULL
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
  expires_at            TIMESTAMPTZ NOT NULL
  used_at               TIMESTAMPTZ
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  + INDEX idx_oauth_codes_expires ON (expires_at) WHERE used_at IS NULL

Table: oauth_access_tokens (NEW)
  id           UUID PK DEFAULT gen_random_uuid()
  jti          TEXT NOT NULL UNIQUE            -- JWT ID claim
  client_id    TEXT NOT NULL
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL   -- NULL for client_credentials
  scope        TEXT NOT NULL
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  expires_at   TIMESTAMPTZ NOT NULL
  revoked_at   TIMESTAMPTZ
  + INDEX idx_oauth_tokens_jti ON (jti)
  + INDEX idx_oauth_tokens_user ON (user_id) WHERE revoked_at IS NULL
```

### Zod Schema Changes

- `AuthorizeQuerySchema` — `{ response_type: 'code', client_id, redirect_uri: string (url), scope, state, code_challenge, code_challenge_method: 'S256' }`, new file `src/schemas/oauth.schemas.ts`
- `TokenRequestSchema` — discriminated union on `grant_type` (`authorization_code` | `client_credentials`), new file `src/schemas/oauth.schemas.ts`
- `IntrospectRequestSchema` — `{ token: string }`, new file `src/schemas/oauth.schemas.ts`
- `ClientRegistrationSchema` — `{ client_name, client_type, redirect_uris: string[], grant_types: string[], allowed_scopes: string[], logo_uri?, contacts?: string[] }`, new file `src/schemas/oauth.schemas.ts`

---

## Out of Scope

- **OAuth Consent Screen:** For v1, first-party clients auto-consent. A consent UI is deferred.
- **OpenID Connect (OIDC) Provider:** The gateway issues opaque JWTs for platform use; it does NOT implement OIDC discovery, `id_token` issuance, or a `userinfo` endpoint. Planned for AGW-003.
- **Dynamic Route Management API:** Route-level `required_scope` configuration is loaded from a static file (see `request-proxy-authorization.spec.md`); a CRUD API is planned for AGW-004.

---

## Acceptance Criteria

- **AC-17 (→ FR-11):** Given a registered OAuth public client with `grant_types: ["authorization_code"]`, when a GET request is made to `/v1/oauth/authorize` with valid `response_type=code`, `client_id`, `redirect_uri`, `scope=api:read`, `state`, `code_challenge`, and `code_challenge_method=S256`, then the response SHALL be `302 Found` redirecting to `redirect_uri` with `code` and `state` parameters; an `oauth_authorization_codes` record SHALL exist for the issued code.
- **AC-18 (→ FR-11):** Given an authorization code and the original PKCE `code_verifier`, when a POST request is made to `/v1/oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and `code_verifier`, then the response SHALL be `200 OK` with a valid `access_token`; the `oauth_authorization_codes` record SHALL have `used_at` set; a second use of the same code SHALL return `400 Bad Request` with `{"error": "invalid_grant"}`.
- **AC-19 (→ FR-11):** Given an authorization code request without `code_challenge`, when the client is a public client, then the response SHALL be `400 Bad Request` with `{"error": "invalid_request", "error_description": "code_challenge required for public clients"}`.
- **AC-20 (→ FR-12):** Given a registered confidential OAuth client with `grant_types: ["client_credentials"]`, when a POST request is made to `/v1/oauth/token` with `grant_type=client_credentials` and valid HTTP Basic Auth, then the response SHALL be `200 OK` with a valid `access_token`, `token_type: "Bearer"`, `expires_in: 3600`, and no `refresh_token`.
- **AC-21 (→ FR-13):** Given a valid, unexpired, non-revoked access token, when a POST request is made to `/v1/oauth/introspect` with valid client Basic Auth and `token=<access_token>`, then the response SHALL be `200 OK` with `{"active": true, "sub": "...", "scope": "...", "exp": ..., ...}`.
- **AC-22 (→ FR-13):** Given an expired or revoked access token, when it is submitted to `/v1/oauth/introspect`, then the response SHALL be `200 OK` with `{"active": false}` (NOT a 4xx error).
- **AC-23 (→ FR-14):** Given a request with a valid admin API key in `X-Admin-Api-Key` header, when a POST request is made to `/v1/oauth/clients` with a valid client registration body, then the response SHALL be `201 Created` with the registered client's details including `client_id` and — for confidential clients — `client_secret` (shown once only); a record SHALL exist in `oauth_clients`.
- **AC-24 (→ FR-15):** Given an authenticated user with an access token scoped to `api:read` only, when a request is proxied to a route requiring `api:write` scope, then the response SHALL be `403 Forbidden` with `{"error": "insufficient_scope", "scope": "api:write"}`; an `audit_log` entry with `event_type: "proxy.request_denied"` SHALL be written.

---

## Testing Strategy

### Unit Tests

| Test Suite | File Path | Key Scenarios |
|---|---|---|
| `OAuthService` | `src/services/__tests__/oauth.service.test.ts` | Validate authorization request params; reject missing `code_challenge` for public client; issue authorization code; exchange code for token with valid PKCE verifier; reject invalid PKCE verifier; issue `client_credentials` token; introspect active token; introspect expired token returns `active: false` |
| `ValidationSchemas` (partial) | `src/schemas/__tests__/validation.test.ts` | OAuth authorize schema rejects invalid `response_type`; client registration schema rejects non-HTTPS redirect URIs (except localhost) |

### Integration Tests

- `GET /v1/oauth/authorize` — covers AC-17, AC-19 (valid, missing challenge, bad client).
- `POST /v1/oauth/token` — covers AC-18, AC-20 (auth_code exchange, client_credentials, invalid grant, code replay).
- `POST /v1/oauth/introspect` — covers AC-21, AC-22 (active, expired, invalid).
- `POST /v1/oauth/revoke` — no dedicated AC in the source spec; add coverage when FR is written (see Open Questions).
- `POST /v1/oauth/clients` — covers AC-23 (valid, duplicate, non-HTTPS redirect).
- File path: `src/__tests__/integration/oauth.test.ts`

### Manual / Exploratory Testing Notes

- None beyond automated coverage — this path has no external IdP dependency (unlike SAML).

E2E automation counterpart: **OAuth Authorization Code + PKCE** — client generates a PKCE pair, calls `/v1/oauth/authorize`, follows the redirect, exchanges the code at `/v1/oauth/token`, and uses the issued token to call a proxy route, verifying headers at the upstream stub (`src/__tests__/e2e/`).

---

## Open Questions

| # | Question | Owner | Due | Resolution |
|---|----------|-------|-----|------------|
| 1 | For the OAuth authorization code flow, should the consent screen be skipped only for first-party clients identified by a flag, or for all clients in v1? A UI-less auto-consent may be insufficient for third-party OAuth clients. | Product | Sprint 2 | *Pending* |
| 2 | `POST /v1/oauth/revoke` (RFC 7009) is listed in the API surface but has no dedicated FR or AC in the source specification. Should this spec gain an FR-15a describing revoke semantics (single token vs. token family) before implementation, or is it deferred to a follow-up ticket? | Platform Architecture | Sprint 1 | *Pending* |

---

## Implementation Notes

- Both grants issue tokens through the same `TokenService.issueAccessToken` used by `core-jwt-authentication.spec.md` (FR-1) with `auth_method: "oauth"` and `sub` set to either the user ID (authorization_code) or the client ID (client_credentials).
- Scope enforcement (FR-15) is implemented in the proxy layer, not here — see `request-proxy-authorization.spec.md` (FR-19).
- See `specs/app-gateway-auth.spec.md` for the original, unsplit specification this document was derived from.

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/oauth-authorization-server.plan.md`*
