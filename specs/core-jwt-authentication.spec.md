# Feature: Core JWT Authentication

**Ticket:** AGW-001-JWT (split from AGW-001)
**Status:** `Implemented`
**Author:** Platform Architecture Team
**Reviewers:** Security Engineering, Backend Platform, QA Lead
**Created:** 2026-07-01
**Last Updated:** 2026-07-29

---

## Overview

This is the foundational identity layer of the App Gateway: password-based login, JWT access-token issuance and validation, refresh-token rotation with reuse detection, and logout/revocation. Every other authentication path in the gateway — SAML SSO (`saml-sso.spec.md`) and the OAuth 2.0 authorization server (`oauth-authorization-server.spec.md`) — terminates in this same token engine, so its correctness and security posture bound the whole service. It touches the `users` and `refresh_tokens` tables, the Redis JWT revocation set, and the `validateAccessToken` middleware that every downstream proxy route relies on.

---

## Functional Requirements

- **FR-1 — User Login & Token Issuance:** The system SHALL accept HTTP POST requests to `POST /v1/auth/login` containing a valid email address and password, validate credentials against the `users` table (bcrypt comparison, minimum cost factor 12), and — upon successful validation — issue a signed JWT access token and a cryptographically random refresh token, returning both in the response body alongside `token_type`, `expires_in`, and granted `scope`. The access token SHALL be signed using RS256 with the gateway's active RSA-2048 private key. The refresh token SHALL be a 256-bit URL-safe random string stored in the `refresh_tokens` table alongside its SHA-256 hash, the owning user ID, client metadata (IP, user-agent), issued-at timestamp, expiry timestamp, and revocation status. The plaintext refresh token SHALL never be persisted; only its hash SHALL be stored.
- **FR-2 — Access Token Validation:** The system SHALL expose token validation logic as an internal Express middleware (`validateAccessToken`) that parses the `Authorization: Bearer <token>` header, verifies the JWT signature against the JWKS key set (→ FR-21, see `infrastructure-operations.spec.md`), validates `iss`, `aud`, `exp`, and `nbf` claims, checks the token ID (`jti`) against the Redis revocation set (→ FR-23), and — if all checks pass — attaches the decoded claims to `req.auth`. On any failure the middleware SHALL respond with `401 Unauthorized` and a structured `ErrorResponse` body; it SHALL NOT pass the request to the next handler. Clock skew tolerance SHALL be ≤ 30 seconds.
- **FR-3 — Access Token Contents:** The system SHALL embed the following claims in every issued JWT access token: `sub` (user UUID), `email`, `roles` (string array), `auth_method` (one of `"password"`, `"saml"`, `"oauth"`), `tenant_id` (nullable), `scope` (space-separated string), `iat`, `exp`, `nbf`, `iss` (gateway base URL), `aud` (requesting client ID or `"platform"`), and `jti` (UUID v4). The token payload SHALL NOT include the user's password hash, full PII beyond email, or any secret values.
- **FR-4 — Refresh Token Rotation:** The system SHALL accept `POST /v1/auth/refresh` with a valid plaintext refresh token, locate the matching record by SHA-256 hash in the `refresh_tokens` table, verify the token is not expired or revoked, issue a new access token and a new refresh token, mark the consumed refresh token as revoked in the database, persist the new refresh token record, and return the new token pair. The system SHALL detect refresh token reuse (replay attack) by checking whether the presented token's record is already revoked; upon detecting reuse it SHALL immediately revoke **all** active refresh tokens for the same `session_family` UUID to force full re-authentication. Refresh tokens SHALL expire 7 days after issuance and SHALL rotate on every successful use. `POST /v1/auth/refresh` SHALL accept an optional client-generated `idempotency_key` (UUID). If a request presents an `idempotency_key` matching one seen within the last 30 seconds **and presents the same `refresh_token`** that produced the cached result, the system SHALL return the previously issued token pair unchanged rather than re-running rotation or reuse-detection logic; requests without a matching cached `idempotency_key`-and-`refresh_token` pair SHALL follow normal rotation/reuse-detection behavior. (Resolved during implementation — see Open Question 2 resolution and Implementation Notes: matching is scoped to the exact presented `refresh_token`, not merely `session_family` membership, since a family can contain other, unrelated non-active tokens and matching on the token itself is what actually prevents an `idempotency_key` collision from returning a stranger's token pair.)
- **FR-5 — Logout & Token Revocation:** The system SHALL accept `POST /v1/auth/logout` authenticated with a valid Bearer access token. The endpoint SHALL atomically: (a) add the access token's `jti` to the Redis revocation set with a TTL equal to the token's remaining lifetime, (b) mark the matching `refresh_tokens` record as revoked in PostgreSQL, and (c) optionally accept a `refresh_token` body parameter to revoke a specific refresh token rather than the most-recently-issued one for the session. The system SHALL return `204 No Content` on success. Redis revocation entries SHALL be keyed as `revoked:jti:<jti>` and SHALL expire automatically when the access token's natural expiry passes to avoid unbounded key growth.

---

## Non-Functional Requirements

- **NFR-1 — Performance (partial):** P95 response latency for `/v1/auth/login`, `/v1/auth/refresh`, and `/v1/auth/logout` SHALL be ≤ 150 ms, P99 ≤ 300 ms, under a load of 1,000 concurrent users with a warm Redis and PostgreSQL connection pool.
- **NFR-2 — Token Lifetimes:** JWT access tokens SHALL expire exactly 15 minutes (900 seconds) after issuance (`exp = iat + 900`). Refresh tokens SHALL expire 7 days (604,800 seconds) after issuance and SHALL be rotated on every successful use.
- **NFR-5 — Security (partial, broken authentication — OWASP A07):** Broken authentication SHALL be mitigated via bcrypt cost ≥ 12 for password comparison, refresh token rotation, and JWT revocation via Redis.
- **NFR-6 — PII Encryption at Rest:** The `users.email` field SHALL be encrypted at the application layer using AES-256-GCM via per-tenant envelope encryption: each `tenant_id` SHALL have its own data-encryption key (DEK), generated and wrapped by a KMS-managed key-encrypting key (KEK) (AWS KMS or HashiCorp Vault in production; `ENCRYPTION_KEY` environment variable as the local-development KEK substitute). Users with `tenant_id IS NULL` (pre-provisioned, non-SSO accounts) SHALL be encrypted under one shared default DEK. The deterministic HMAC-SHA256 lookup key used for `email_hash` SHALL remain a single global key, not tenant-scoped, since it is a one-way digest (not reversible ciphertext) and per-tenant scoping would break the global-uniqueness login lookup. See Open Question 1 resolution and Implementation Notes.

---

## Architecture Impact

### Areas Affected

| Area | Impact |
|------|--------|
| Routes (`src/routes/auth.router.ts`) | `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me` |
| Services (`src/services/token.service.ts`) | JWT sign/verify, claim construction, JWKS key selection |
| Services (`src/services/user.service.ts`) | User lookup by email hash, bcrypt password verification |
| Services (`src/services/refreshToken.service.ts`) | Issue/rotate refresh tokens, session-family reuse detection |
| Services (`src/services/audit.service.ts`) | Writes `auth.login`, `auth.login_failed`, `auth.logout`, `auth.token_refresh`, `auth.token_refresh_failed`, `auth.token_revoked` events |
| Middleware (`src/middleware/authenticate.ts`) | `validateAccessToken` — Bearer parsing, JWKS verification, Redis revocation check |
| Database (`src/db/schema.ts`) | New tables `users`, `refresh_tokens`, `tenant_encryption_keys` |
| Redis / cache | New key patterns `revoked:jti:<jti>`, `revoked:refresh:<sha256_hash>`, `idempotency:refresh:<idempotency_key>` |
| Services (`src/utils/crypto.ts`) | Per-tenant DEK unwrap/cache (in-process memory only, never Redis — see Implementation Notes) |
| Types (`src/types/index.ts`) | `JwtAccessTokenClaims`, `TokenResponse`, `UserProfile` |

### API Changes

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| `POST` | `/v1/auth/login` | New | Credential login; issues access + refresh token |
| `POST` | `/v1/auth/refresh` | New | Rotate refresh token; issues new token pair; optional `idempotency_key` for safe client retries |
| `POST` | `/v1/auth/logout` | New | Revoke access + refresh token |
| `GET` | `/v1/auth/me` | New | Return authenticated user profile |

### Data Model Changes

```
Table: users (NEW)
  id               UUID PK DEFAULT gen_random_uuid()
  email            TEXT NOT NULL UNIQUE       -- AES-256-GCM encrypted at app layer
  email_hash       TEXT NOT NULL UNIQUE       -- HMAC-SHA256 of plaintext email, used for lookups
  password_hash    TEXT                       -- bcrypt cost 12; NULL for SAML-only users
  first_name       TEXT
  last_name        TEXT
  roles            TEXT[] NOT NULL DEFAULT '{}'
  auth_source      TEXT NOT NULL DEFAULT 'password'   -- 'password' | 'saml' | 'oauth'
  saml_name_id     TEXT                       -- populated by saml-sso.spec.md (FR-8, FR-9)
  tenant_id        UUID                       -- populated by saml-sso.spec.md (FR-8)
  is_active        BOOLEAN NOT NULL DEFAULT TRUE
  email_verified   BOOLEAN NOT NULL DEFAULT FALSE
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  last_login_at    TIMESTAMPTZ
  + INDEX idx_users_email_hash ON (email_hash)                 -- login lookup
  + INDEX idx_users_tenant_saml ON (tenant_id, saml_name_id)    -- consumed by saml-sso.spec.md

Table: refresh_tokens (NEW)
  id                UUID PK DEFAULT gen_random_uuid()
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
  token_hash        TEXT NOT NULL UNIQUE      -- SHA-256 of plaintext token
  session_family    UUID NOT NULL             -- groups tokens for reuse detection
  client_id         TEXT                      -- OAuth client_id if issued via oauth-authorization-server.spec.md
  ip_address        INET
  user_agent        TEXT
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  expires_at        TIMESTAMPTZ NOT NULL
  revoked_at        TIMESTAMPTZ
  revocation_reason TEXT                      -- 'logout' | 'rotation' | 'slo' | 'reuse_detected'
  + INDEX idx_refresh_tokens_user_id ON (user_id)
  + INDEX idx_refresh_tokens_family ON (session_family)
  + INDEX idx_refresh_tokens_expires ON (expires_at) WHERE revoked_at IS NULL

Table: tenant_encryption_keys (NEW)
  tenant_id         UUID NOT NULL              -- '00000000-0000-0000-0000-000000000000' sentinel for the NULL-tenant default bucket, see Implementation Notes
  key_version       INTEGER NOT NULL DEFAULT 1
  wrapped_dek       TEXT NOT NULL              -- DEK, wrapped by the KMS-managed KEK
  status            TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'retired'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  retired_at        TIMESTAMPTZ
  PK (tenant_id, key_version)
  + UNIQUE INDEX ON (tenant_id) WHERE status = 'active'  -- at most one active key per tenant
```

> **Note (resolved during implementation, see Open Question 3):** the table shape above supersedes an earlier draft that used `tenant_id` alone as the primary key. That shape had no place to retain a DEK once it rotated out, which would have made any row still encrypted under the old key permanently undecryptable. The current shape — one row per `(tenant_id, key_version)`, with `status`/`retired_at` marking which key is current — keeps every previously-issued key resolvable by version, at the cost of `tenant_id` no longer being unique by itself.

### Zod Schema Changes

- `LoginRequestSchema` — `{ email: string (email), password: string }`, in `src/schemas/auth.schemas.ts`
- `RefreshRequestSchema` — `{ refresh_token: string, idempotency_key?: string (uuid) }`, in `src/schemas/auth.schemas.ts`
- `LogoutRequestSchema` — `{ refresh_token?: string }`, in `src/schemas/auth.schemas.ts`

---

## Out of Scope

- **Multi-factor Authentication (MFA/TOTP):** Planned for AGW-002. This spec issues a single-factor password-based session.
- **User Registration & Email Verification:** User accounts are pre-provisioned by administrators; self-service registration is a separate service concern.
- **Admin API for account management:** No CRUD endpoints for user records beyond what login/me require.

---

## Acceptance Criteria

- **AC-1 (→ FR-1):** Given a registered user with a valid email and correct password, when a POST request is sent to `/v1/auth/login` with `{"email": "user@example.com", "password": "correct"}`, then the response SHALL be `200 OK` with `access_token` (valid RS256-signed JWT), `refresh_token` (256-bit URL-safe string), `token_type: "Bearer"`, `expires_in: 900`, and a non-empty `scope`; the `refresh_tokens` table SHALL contain a new record with the SHA-256 hash of the returned `refresh_token`.
- **AC-2 (→ FR-1):** Given a registered user with a correct email but incorrect password, when a POST request is sent to `/v1/auth/login` with the wrong password, then the response SHALL be `401 Unauthorized` with `{"error": "invalid_credentials"}`, no tokens SHALL be issued, and an `audit_log` entry with `event_type: "auth.login_failed"` SHALL be written.
- **AC-3 (→ FR-2):** Given a valid JWT access token issued by the gateway, when a request is sent to any auth-required proxy route with `Authorization: Bearer <token>`, then the gateway SHALL attach decoded claims to the request context and forward the request to the upstream service.
- **AC-4 (→ FR-2):** Given a JWT access token that has expired, when a request is made to an auth-required endpoint using that token, then the response SHALL be `401 Unauthorized` with `{"error": "token_expired"}`.
- **AC-5 (→ FR-2, FR-23):** Given a valid JWT access token whose `jti` has been added to the Redis revocation set, when a request is made using that token, then the response SHALL be `401 Unauthorized` with `{"error": "token_revoked"}`, even if the token has not yet reached its `exp` time.
- **AC-6 (→ FR-3):** Given a user who logs in via password authentication, when the returned access token is decoded, then the payload SHALL contain all of: `sub`, `email`, `roles`, `auth_method: "password"`, `scope`, `iat`, `exp`, `nbf`, `iss`, `aud`, and `jti`; and `exp - iat` SHALL equal 900.
- **AC-7 (→ FR-4):** Given a valid refresh token, when a POST request is sent to `/v1/auth/refresh` with `{"refresh_token": "<token>"}`, then the response SHALL be `200 OK` with a new `access_token` and a new `refresh_token`; the previous refresh token record SHALL have `revoked_at` set; the new refresh token SHALL carry the same `session_family` lineage.
- **AC-8 (→ FR-4):** Given a refresh token that has already been used once (consumed), when the same plaintext refresh token is presented again to `/v1/auth/refresh`, then the response SHALL be `401 Unauthorized` with `{"error": "token_reuse_detected"}`; all refresh tokens in the same `session_family` SHALL be revoked, forcing re-authentication.
- **AC-9 (→ FR-5):** Given an authenticated user with a valid access token and an active refresh token, when a POST request is sent to `/v1/auth/logout` with the Bearer token, then the response SHALL be `204 No Content`; the access token's `jti` SHALL be present in Redis with a TTL ≤ 900 seconds; the associated refresh token record SHALL have `revoked_at` set; a subsequent request using the same access token SHALL return `401 Unauthorized`.
- **AC-10 (→ FR-4):** Given a successful `/v1/auth/refresh` call made with an `idempotency_key`, when the same `idempotency_key` is presented again within the 30-second caching window — even with the same, now-rotated-away `refresh_token` — then the response SHALL be `200 OK` with the identical token pair returned the first time, and no additional row SHALL be revoked or inserted in `refresh_tokens`.
- **AC-11 (→ NFR-6):** Given two users belonging to different `tenant_id` values, when their `email` values are encrypted, then each SHALL be encrypted under a distinct wrapped DEK recorded in `tenant_encryption_keys`; decrypting one tenant's DEK SHALL NOT enable decryption of another tenant's `email` ciphertext.
- **AC-12 (→ NFR-6):** Given a user with `tenant_id IS NULL`, when their `email` is encrypted, then it SHALL use the shared default DEK, and this SHALL be the only case where more than one user's row shares a DEK.

---

## Testing Strategy

### Unit Tests

| Test Suite | File Path | Key Scenarios |
|---|---|---|
| `TokenService` | `tests/unit/token.service.test.ts` | Issue access token with correct claims; verify expiry = 900s; verify RS256 signature; validate a valid token; reject expired token; reject tampered signature; detect revoked JTI in Redis; idempotency claim/complete/release, encrypted at rest |
| `EncryptionUtils` | `tests/unit/crypto.test.ts` | Encrypt/decrypt roundtrip; different plaintexts produce different ciphertexts; tampered ciphertext throws; HMAC hash is deterministic; tenant A's ciphertext is not decryptable under tenant B's DEK |
| `TenantKeyService` (new) | `tests/unit/tenantKey.service.test.ts` | Generate + wrap DEK per tenant; unwrapped-DEK cache hit/miss (bounded LRU), including the fully-warm no-DB-round-trip case; default-bucket fallback for `tenant_id IS NULL`; rotate a tenant's DEK without re-encrypting existing rows; two tenants' ciphertexts are not cross-decryptable |
| `refreshToken.service` | `tests/unit/refreshToken.service.test.ts` | Issue/rotate refresh tokens; reuse detection revokes the family |
| `ValidationSchemas` (partial) | `tests/unit/auth.schemas.test.ts` | Login schema rejects missing fields; refresh schema accepts optional `idempotency_key` as UUID and rejects a malformed one |

*(File paths above reflect this repo's actual flat `tests/unit/*.test.ts` convention — CLAUDE.md: "Test files live next to the scope they cover: `tests/unit/token.service.test.ts`, etc." — not the `src/**/__tests__/` layout an earlier draft of this section assumed.)*

### Integration Tests

- `POST /v1/auth/login` — covers AC-1, AC-2. Test setup: seeded user fixture with known bcrypt hash.
- `POST /v1/auth/refresh` — covers AC-7, AC-8, AC-10. Verify `refresh_tokens.revoked_at` and `session_family` behavior; verify duplicate `idempotency_key` submission within the window returns the identical pair, including when the two requests are genuinely concurrent (`Promise.all`), not just sequential; verify a mismatched `refresh_token` with a reused `idempotency_key` does not return another request's cached pair; verify the cache expiring after the window falls back to normal reuse detection.
- `POST /v1/auth/logout` — covers AC-9. Verify Redis `revoked:jti:<jti>` TTL and follow-up request rejection.
- `GET /v1/auth/me` — valid, invalid, missing token cases.
- Per-tenant encryption — covers AC-11, AC-12. Verify two tenants get distinct `tenant_encryption_keys` rows; verify `tenant_id IS NULL` users share exactly one default-bucket row.
- File path: `tests/integration/auth.test.ts`

### Manual / Exploratory Testing Notes

- None beyond automated coverage — this path has no external IdP dependency.

---

## Open Questions

| # | Question | Owner | Due | Resolution |
|---|----------|-------|-----|------------|
| 1 | The `users.email` encryption scheme requires application-layer key management. Should we use envelope encryption (per-row DEK wrapped with a KMS-managed KEK) or a single AES key for all rows? Per-row DEK is more resilient to key compromise but adds latency and complexity. | Security Engineering | Sprint 1 | **Resolved 2026-07-28:** Per-tenant DEK envelope encryption — one DEK per `tenant_id`, wrapped by a KMS-managed KEK and recorded in `tenant_encryption_keys`; one shared default DEK for `tenant_id IS NULL`; the HMAC `email_hash` lookup key stays global/unscoped. Chosen over per-row (KMS-call-per-decrypt cost, no safe caching story) and over a single global DEK (whole-table blast radius) as the balance point for a platform where tenant is already the natural isolation boundary. See NFR-6, Data Model Changes, AC-11/AC-12, Implementation Notes. |
| 2 | The refresh token family revocation on reuse detection (FR-4) forces all sessions for a user to re-authenticate. Is this acceptable UX for mobile clients where background token refresh is common and network errors could cause accidental replay? Consider a single-retry grace window. | Product / Mobile Team | Sprint 1 | **Resolved 2026-07-28:** Client-generated `idempotency_key` on `POST /v1/auth/refresh`. A retry carrying the same `idempotency_key` within a 30s window returns the original token pair instead of re-entering rotation/reuse-detection logic, so a lost response doesn't get misread as a replay attack — without weakening FR-4's reuse detection for a token replayed without that key. See FR-4, Zod Schema Changes, AC-10, Implementation Notes. |
| 3 | `tenant_encryption_keys` (Data Model Changes) needs to retain a DEK once a tenant's key rotates, so `users.email` rows encrypted under the old key stay decryptable — but a single-row-per-`tenant_id` table has no place to keep more than one wrapped DEK per tenant. Where does the outgoing wrapped DEK stay addressable after rotation? (Raised as Risk Register R-1 in `plans/core-jwt-authentication.plan.md`, Task 2.1.) | Engineering (implementation-time decision) | Sprint 1 | **Resolved 2026-07-29:** Keep all of a tenant's DEKs — current and retired — in `tenant_encryption_keys` itself: one row per `(tenant_id, key_version)`, a `status` column (`active`/`retired`) and `retired_at` timestamp, and a partial unique index enforcing at most one `active` row per tenant. `rotateTenantKey` inserts a new `active` row and flips the previous one to `retired` rather than overwriting it. Chosen over a separate key-history table (same information, one more join) and over a two-column "current + previous key" shape on a single row (only survives one rotation before losing the second-oldest key). Ciphertext carries its encrypting key's `key_version` as an embedded prefix so decryption always resolves the exact key used, active or retired. See Data Model Changes, `src/services/tenantKey.service.ts`. |
| 4 | The idempotency cache (Open Question 2 resolution) needed the explicit security-review sign-off this file's Implementation Notes originally flagged as outstanding: is holding a live token pair in Redis for 30s safe, and does concurrent access need additional protection beyond a plain cache? | Security Engineering (via `security-reviewer`/`performance-reviewer` subagents) | Sprint 1 | **Resolved 2026-07-29, two-part:** (a) *At-rest encryption* — the cached blob is encrypted with a dedicated AES-256-GCM key derived from `ENCRYPTION_KEY`, so a Redis persistence snapshot that outlives the 30s TTL doesn't expose usable tokens on disk. (b) *Concurrency* — a plain read-then-write cache had a race: two near-simultaneous requests carrying the same `idempotency_key` could both miss the cache and both call the rotation logic, and the second would hit the just-revoked row and trip family-wide reuse detection (found independently by both the security and performance review passes). Fixed with an atomic claim step (Redis `SET NX`) before rotation begins — only the claiming request rotates; a request that loses the claim waits up to 250ms for the claim holder's result before falling through to its own rotation attempt. This narrows the race to a sub-second window without changing FR-4's existing rotation/reuse-detection logic. See Implementation Notes, `src/services/token.service.ts` (`claimIdempotencyKey`/`completeIdempotentRefresh`/`releaseIdempotencyKey`). |

---

## Implementation Notes

- This is the token engine both `saml-sso.spec.md` (FR-8, FR-10) and `oauth-authorization-server.spec.md` (FR-11, FR-12) issue tokens through — keep `TokenService`'s public interface stable for those consumers.
- JWKS key material and rotation are owned by `infrastructure-operations.spec.md` (FR-21); this spec only consumes the active signing key.
- See `specs/app-gateway-auth.spec.md` for the original, unsplit specification this document was derived from.
- **Per-tenant DEK caching (Open Question 1):** unwrapped DEKs SHALL be cached in application memory only (a bounded LRU keyed by `tenant_id` + `key_version`), never in Redis or any other external store — this is what keeps decrypt latency within NFR-1 without a KMS call on every request. Only the wrapped (KMS-encrypted) DEK is ever persisted, in `tenant_encryption_keys`. A second, equally-bounded in-process cache tracks each tenant's currently-*active* `key_version` so a fully warm lookup also skips the Postgres round trip, not only the KMS-unwrap step.
- **Tenant re-encryption on SAML linking:** when a password-only user (`tenant_id IS NULL`) is subsequently linked to a tenant via `saml-sso.spec.md` (FR-8), their `email` row SHALL be re-encrypted from the default DEK to that tenant's DEK as part of the linking transaction. This is new surface area `saml-sso.spec.md` needs to account for and does not currently describe.
- **Tenant DEK rotation (Open Question 3):** `tenant_encryption_keys` retains every key a tenant has ever had, not just the active one — see Data Model Changes and Open Question 3's resolution. Rotating a key never re-encrypts existing `users.email` rows; they stay decryptable against their original (now `retired`) `key_version`, which is why the AES-GCM ciphertext embeds a 2-byte `key_version` prefix ahead of the iv/authTag/body.
- **Idempotency cache (Open Question 2 / Open Question 4) — security review complete:** the cache backing `idempotency_key` retries holds an issued token pair (access + refresh token) for its ~30s TTL, encrypted at rest with a dedicated AES-256-GCM key (see Open Question 4's resolution) so a Redis persistence snapshot outliving the logical TTL doesn't expose usable tokens. The cache is populated via an atomic claim (Redis `SET NX`) rather than a plain write, closing a concurrency race the security and performance reviews both independently identified — see Open Question 4.

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/core-jwt-authentication.plan.md`*
