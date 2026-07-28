# App Gateway Authentication & Routing Service — Feature Specification

---

| Field        | Value                                                      |
|--------------|------------------------------------------------------------|
| Ticket       | AGW-001                                                    |
| Status       | **APPROVED**                                               |
| Author       | Platform Architecture Team                                 |
| Reviewers    | Security Engineering, Backend Platform, DevOps, QA Lead    |
| Created      | 2026-07-01                                                 |
| Last Updated | 2026-07-27                                                 |
| Version      | 1.0.0                                                      |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Functional Requirements](#2-functional-requirements)
3. [Non-Functional Requirements](#3-non-functional-requirements)
4. [Architecture Impact](#4-architecture-impact)
5. [Out of Scope](#5-out-of-scope)
6. [Acceptance Criteria](#6-acceptance-criteria)
7. [Testing Strategy](#7-testing-strategy)
8. [Open Questions](#8-open-questions)

---

## 1. Overview

The App Gateway Service is a unified authentication and request-routing gateway that sits at the edge of the multi-app platform. Every client request — whether from a web browser, mobile application, or machine-to-machine integration — enters the platform through this single ingress point, receives an authentication decision, and is proxied to the appropriate upstream backend service only when authorization is confirmed. Users authenticate once and receive a short-lived JWT access token paired with a rotating refresh token; these credentials are honored across all web and mobile clients without requiring re-authentication until the refresh token expires or is explicitly revoked.

The gateway supports enterprise single sign-on via SAML 2.0 (compatible with Okta, Azure Active Directory, and Google Workspace as Identity Providers), enabling tenant organizations to enforce their own IdP policies while the platform manages the downstream session lifecycle. Programmatic API access is handled through an OAuth 2.0 authorization server embedded within the gateway, exposing `authorization_code` (with mandatory PKCE) and `client_credentials` flows. Identity context — user ID, email, roles, and authentication method — is forwarded to upstream services exclusively through signed, tamper-evident request headers so that no backend service need perform its own token validation. Operational concerns including per-client rate limiting, Redis-backed token revocation, JWKS key publication, structured audit logging, and health/readiness probes are first-class features of the service.

---

## 2. Functional Requirements

### 2.1 Core JWT Authentication (FR-1 – FR-5)

**FR-1 — User Login & Token Issuance**
The system SHALL accept HTTP POST requests to `POST /v1/auth/login` containing a valid email address and password, validate credentials against the `users` table (bcrypt comparison, minimum cost factor 12), and — upon successful validation — issue a signed JWT access token and a cryptographically random refresh token, returning both in the response body alongside `token_type`, `expires_in`, and granted `scope`. The access token SHALL be signed using RS256 with the gateway's active RSA-2048 private key. The refresh token SHALL be a 256-bit URL-safe random string stored in the `refresh_tokens` table alongside its SHA-256 hash, the owning user ID, client metadata (IP, user-agent), issued-at timestamp, expiry timestamp, and revocation status. The plaintext refresh token SHALL never be persisted; only its hash SHALL be stored.

**FR-2 — Access Token Validation**
The system SHALL expose token validation logic as an internal Express middleware (`validateAccessToken`) that parses the `Authorization: Bearer <token>` header, verifies the JWT signature against the JWKS key set, validates `iss`, `aud`, `exp`, and `nbf` claims, checks the token ID (`jti`) against the Redis revocation set, and — if all checks pass — attaches the decoded claims to `req.auth`. On any failure the middleware SHALL respond with `401 Unauthorized` and a structured `ErrorResponse` body; it SHALL NOT pass the request to the next handler. Clock skew tolerance SHALL be ≤ 30 seconds.

**FR-3 — Access Token Contents**
The system SHALL embed the following claims in every issued JWT access token: `sub` (user UUID), `email`, `roles` (string array), `auth_method` (one of `"password"`, `"saml"`, `"oauth"`), `tenant_id` (nullable), `scope` (space-separated string), `iat`, `exp`, `nbf`, `iss` (gateway base URL), `aud` (requesting client ID or `"platform"`), and `jti` (UUID v4). The token payload SHALL NOT include the user's password hash, full PII beyond email, or any secret values.

**FR-4 — Refresh Token Rotation**
The system SHALL accept `POST /v1/auth/refresh` with a valid plaintext refresh token, locate the matching record by SHA-256 hash in the `refresh_tokens` table, verify the token is not expired or revoked, issue a new access token and a new refresh token, mark the consumed refresh token as revoked in the database, persist the new refresh token record, and return the new token pair. The system SHALL detect refresh token reuse (replay attack) by checking whether the presented token's record is already revoked; upon detecting reuse it SHALL immediately revoke **all** active refresh tokens for the same `session_family` UUID to force full re-authentication. Refresh tokens SHALL expire 7 days after issuance and SHALL rotate on every successful use.

**FR-5 — Logout & Token Revocation**
The system SHALL accept `POST /v1/auth/logout` authenticated with a valid Bearer access token. The endpoint SHALL atomically: (a) add the access token's `jti` to the Redis revocation set with a TTL equal to the token's remaining lifetime, (b) mark the matching `refresh_tokens` record as revoked in PostgreSQL, and (c) optionally accept a `refresh_token` body parameter to revoke a specific refresh token rather than the most-recently-issued one for the session. The system SHALL return `204 No Content` on success. Redis revocation entries SHALL be keyed as `revoked:jti:<jti>` and SHALL expire automatically when the access token's natural expiry passes to avoid unbounded key growth.

---

### 2.2 SAML 2.0 Enterprise SSO (FR-6 – FR-10)

**FR-6 — Service Provider Metadata Publication**
The system SHALL generate and serve a valid SAML 2.0 Service Provider metadata XML document at `GET /v1/auth/saml/{tenant}/metadata` for each tenant that has an active `saml_configurations` record. The metadata SHALL include the SP entity ID (formatted as `{gatewayBaseUrl}/saml/{tenant}`), the Assertion Consumer Service URL (`POST /v1/auth/saml/{tenant}/callback`), the Single Logout Service URL (`POST /v1/auth/saml/{tenant}/logout`), the SP's X.509 certificate for assertion encryption and signature verification, and a `NameIDFormat` of `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`. The `Content-Type` response header SHALL be `application/xml`. Metadata SHALL be re-generated on each request (not statically cached) to reflect current certificate rotations.

**FR-7 — IdP-Initiated & SP-Initiated SSO Flow**
The system SHALL support SP-initiated SSO by accepting `GET /v1/auth/saml/{tenant}/initiate`, constructing a signed SAML `AuthnRequest` using the tenant's IdP configuration from `saml_configurations`, encoding it as a URL-encoded base64 DEFLATE string (HTTP-Redirect binding), and returning a `302 Found` redirect to the IdP's SSO URL. The `RelayState` parameter SHALL carry a short-lived (5-minute), HMAC-SHA256-signed opaque state token encoding the original requested resource URL so that users can be redirected post-authentication. The system SHALL also support IdP-initiated flows where the IdP POSTs an assertion without a prior `AuthnRequest`; in this case `RelayState` processing SHALL be skipped.

**FR-8 — SAML Assertion Consumption & Account Linking**
The system SHALL accept `POST /v1/auth/saml/{tenant}/callback`, validate the received SAML Response using `passport-saml` including: XML signature verification against the IdP's X.509 certificate stored in `saml_configurations.idp_certificate`, `Conditions` element `NotBefore`/`NotOnOrAfter` time validation (tolerance ≤ 30 s), `AudienceRestriction` check against the SP entity ID, and `InResponseTo` correlation when the flow is SP-initiated. Upon successful validation the system SHALL extract `nameID` (email), and mapped attribute claims (first name, last name, groups/roles per tenant attribute mapping). The system SHALL look up the `users` table by `email`; if no record exists it SHALL auto-provision a new user record with `auth_source = 'saml'` and `tenant_id` set. The system SHALL then issue a standard JWT access token + refresh token pair and either redirect to the `RelayState` URL (SP-initiated) or to the platform default landing URL (IdP-initiated), passing the tokens as short-lived secure HttpOnly cookies or as query parameters depending on the client type indicated in `RelayState`.

**FR-9 — SAML Account Linking**
The system SHALL support linking an existing password-authenticated user account to a SAML identity. When a SAML assertion is received for an email that already exists in `users` with `auth_source = 'password'`, the system SHALL set `users.saml_name_id` and `users.tenant_id` on the existing record without creating a duplicate user, and SHALL record the link event in `audit_log`. Subsequent logins via that SAML IdP SHALL resolve to the same `users` record. The system SHALL NOT allow linking a SAML identity to an account already linked to a different SAML `nameID` unless the previous `saml_name_id` is explicitly unlinked by an administrator via a separate admin API (out of scope for this spec).

**FR-10 — SAML Single Logout (SLO)**
The system SHALL accept `POST /v1/auth/saml/{tenant}/logout` and process SAML `LogoutRequest` messages received from the IdP. The system SHALL revoke all active refresh tokens for the resolved user, add all outstanding access token `jti`s associated with that user's active sessions to the Redis revocation set, and return a valid SAML `LogoutResponse` to the IdP. The system SHALL also support SP-initiated logout by constructing and sending a SAML `LogoutRequest` to the IdP's SLO endpoint when a user with an active SAML session calls `POST /v1/auth/logout`.

---

### 2.3 OAuth 2.0 Authorization Server (FR-11 – FR-15)

**FR-11 — Authorization Code Flow with PKCE**
The system SHALL implement the OAuth 2.0 `authorization_code` flow as specified in RFC 6749 and RFC 7636 (PKCE). The `GET /v1/oauth/authorize` endpoint SHALL accept `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, and `code_challenge_method=S256` parameters. PKCE `code_challenge` SHALL be mandatory for all public clients; confidential clients SHOULD provide it. The system SHALL validate: `client_id` exists and is active in `oauth_clients`, `redirect_uri` exactly matches a registered URI for that client, requested `scope` is a subset of the client's allowed scopes, and `code_challenge_method` is `S256`. Upon user authentication and consent (consent screen out of scope — auto-consent for first-party clients), the system SHALL issue an `authorization_code` stored in `oauth_authorization_codes` (TTL 10 minutes), and redirect to `redirect_uri` with `code` and `state` parameters.

**FR-12 — Client Credentials Flow**
The system SHALL implement the OAuth 2.0 `client_credentials` grant at `POST /v1/oauth/token` with `grant_type=client_credentials`. The endpoint SHALL authenticate the client via HTTP Basic Auth (`client_id:client_secret`, bcrypt-compared) or `client_id`/`client_secret` body parameters (Basic Auth preferred). Only clients with `client_type = 'confidential'` and `grant_types` including `'client_credentials'` in `oauth_clients` SHALL be permitted. The system SHALL issue a JWT access token with the client's registered scopes and `sub = client_id`; no refresh token SHALL be issued for this grant. The issued token SHALL be recorded in `oauth_access_tokens`.

**FR-13 — Token Introspection**
The system SHALL implement RFC 7662 token introspection at `POST /v1/oauth/introspect`. The endpoint SHALL require HTTP Basic Auth with valid `client_id` and `client_secret`. Given a presented `token` parameter the system SHALL: verify the JWT signature, check the `jti` against the Redis revocation set, check the `exp` claim, and — if the token is active — return a JSON object with `active: true` plus `scope`, `client_id`, `username`, `token_type`, `exp`, `iat`, `nbf`, `sub`, `aud`, `iss`, and `jti`. If the token is invalid, expired, or revoked the system SHALL return `{"active": false}` (NOT a 4xx error, per RFC 7662). The introspection endpoint SHALL be rate-limited independently from user-facing auth endpoints.

**FR-14 — OAuth Client Registration (Admin)**
The system SHALL expose `POST /v1/oauth/clients` (admin-authenticated via a separate admin API key scoped to `admin:oauth`) to register new OAuth clients. The request body SHALL include `client_name`, `client_type` (`public` | `confidential`), `redirect_uris` (array), `grant_types` (array), `allowed_scopes` (array), and optional `logo_uri`, `contacts`. The system SHALL generate a `client_id` (UUID v4) and — for confidential clients — a `client_secret` (256-bit random, stored as bcrypt hash in `oauth_clients.client_secret_hash`; the plaintext SHALL be returned only in the registration response and never again). The system SHALL validate that all `redirect_uris` use HTTPS (except `localhost` for development) and that `grant_types` are a subset of supported values.

**FR-15 — Scope Enforcement**
The system SHALL define and enforce a platform scope vocabulary. The proxy middleware (FR-17) SHALL, for OAuth-authenticated requests, verify that the access token's `scope` claim contains the scope required by the target route as configured in route definitions. If the required scope is absent the system SHALL respond `403 Forbidden` with `error: "insufficient_scope"` and `scope` indicating the required scope. Supported platform scopes SHALL include at minimum: `openid`, `profile`, `email`, `offline_access`, `api:read`, `api:write`, `admin:oauth`, `admin:routes`. Scope strings SHALL follow the format `<resource>:<action>`.

---

### 2.4 Request Proxy & Authorization (FR-16 – FR-20)

**FR-16 — Route Configuration**
The system SHALL support a route configuration model stored in a `routes` JSON configuration file (loaded at startup) and optionally overridable via environment variables for Kubernetes ConfigMap injection. Each route entry SHALL specify: `path` (Express-compatible pattern, e.g., `/api/users/:path*`), `upstream` (full base URL of the backend service), `auth_required` (boolean), `required_scope` (nullable string), `allowed_roles` (nullable string array), `rate_limit_override` (nullable integer), `strip_prefix` (boolean), and `timeout_ms` (default 30000). The system SHALL load and validate all route configurations at startup using Zod; invalid configurations SHALL cause the process to exit with a non-zero code and a descriptive error message.

**FR-17 — JWT Validation on Proxied Requests**
The system SHALL apply the `validateAccessToken` middleware (FR-2) to all proxy routes where `auth_required = true`. For routes where `auth_required = false`, the middleware SHALL run in optional mode: if an `Authorization` header is present it SHALL be validated and claims attached; if absent the request SHALL proceed unauthenticated. The system SHALL reject any request that carries a custom `X-User-Id`, `X-User-Email`, `X-User-Roles`, or `X-Auth-Method` header set by the client — these headers SHALL be stripped unconditionally before upstream forwarding to prevent identity spoofing.

**FR-18 — Identity Header Injection**
The system SHALL, for every proxied request that has been successfully authenticated (regardless of `auth_required` setting), inject the following headers before forwarding to the upstream service: `X-User-Id` (user UUID from `sub` claim), `X-User-Email` (email claim), `X-User-Roles` (comma-separated roles array), `X-Auth-Method` (auth_method claim: `password` | `saml` | `oauth`), `X-Tenant-Id` (tenant_id claim, or omitted if null), and `X-Request-Id` (UUID v4 generated per-request for distributed tracing). For unauthenticated requests on public routes these headers SHALL be omitted entirely. The system SHALL also forward the original `X-Forwarded-For` header, appending the gateway's own IP if not already present.

**FR-19 — Authorization Policy Enforcement**
The system SHALL enforce authorization policies before proxying each request: (a) if `auth_required = true` and no valid token is present, respond `401 Unauthorized`; (b) if `allowed_roles` is non-empty and the authenticated user's roles do not intersect with `allowed_roles`, respond `403 Forbidden`; (c) if `required_scope` is set and the token's `scope` does not include the required scope, respond `403 Forbidden` with `error: "insufficient_scope"`; (d) if the rate limit for the client is exceeded, respond `429 Too Many Requests` with `Retry-After` header. All authorization failures SHALL be recorded in `audit_log` with outcome `"denied"`.

**FR-20 — Audit Logging**
The system SHALL write a structured audit log entry to the `audit_log` PostgreSQL table for every authentication event (login, logout, refresh, SSO callback, OAuth token issuance) and every authorization decision (allowed or denied). Each entry SHALL include: `id` (UUID), `timestamp` (timestamptz), `event_type` (enumerated string), `user_id` (nullable UUID), `client_id` (nullable string), `ip_address` (inet), `user_agent` (text), `resource` (path being accessed), `outcome` (`"success"` | `"failure"` | `"denied"`), `failure_reason` (nullable text), `metadata` (JSONB for extensible context). The system SHALL NOT log plaintext tokens, passwords, or full authorization codes in any audit entry. Audit log entries SHALL be append-only; no UPDATE or DELETE operations SHALL be performed by the gateway on this table. Entries older than 90 days SHALL be eligible for archival by a scheduled external job (outside this service's scope).

---

### 2.5 Infrastructure & Operations (FR-21 – FR-25)

**FR-21 — JWKS Endpoint**
The system SHALL expose `GET /v1/auth/.well-known/jwks.json` returning a JSON Web Key Set containing all currently active and recently-rotated public keys in JWK format (RFC 7517). Each key object SHALL include: `kty`, `use`, `kid`, `alg`, `n`, `e` fields. The gateway SHALL support at least two simultaneous active key IDs to allow zero-downtime key rotation (new key signs new tokens; old key remains in JWKS until all tokens signed with it have naturally expired). JWKS responses SHALL be cached with `Cache-Control: public, max-age=3600` and SHALL respond within 50 ms (served from in-process memory, not database). The endpoint SHALL require no authentication.

**FR-22 — Per-Client Rate Limiting**
The system SHALL implement rate limiting using a Redis sliding-window counter. The default rate limit for all authentication endpoints (`/v1/auth/*`, `/v1/oauth/*`) SHALL be 100 requests per minute per source IP address. Individual OAuth clients SHALL have configurable rate limits stored in `oauth_clients.rate_limit_rpm`. Rate limit state SHALL be stored in Redis with keys formatted as `ratelimit:{ip}:{window_start_minute}` or `ratelimit:client:{client_id}:{window_start_minute}`. When the limit is exceeded the system SHALL return `429 Too Many Requests` with headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix epoch of window reset), and `Retry-After` (seconds until reset). Proxy route rate limits SHALL be configurable per-route via `rate_limit_override`.

**FR-23 — Token Revocation via Redis**
The system SHALL maintain a Redis set of revoked JWT `jti` values. Revocation entries SHALL use the key pattern `revoked:jti:<jti>` with a Redis TTL equal to the token's remaining lifetime (computed as `exp - now()`). The `validateAccessToken` middleware SHALL check this set on every request using a Redis `EXISTS` command (O(1)) before attaching claims to the request context. The system SHALL also support bulk revocation: when a SAML SLO event is received or when an admin calls a (future) admin revoke-all API, the system SHALL iterate the user's active sessions and revoke each `jti`. Refresh token revocation SHALL be persisted in PostgreSQL (`refresh_tokens.revoked_at`) with Redis caching for fast lookup (`revoked:refresh:<sha256_hash>`).

**FR-24 — Health & Readiness Endpoints**
The system SHALL expose `GET /health` (liveness probe) and `GET /ready` (readiness probe). The liveness endpoint SHALL return `200 OK` with `{"status": "ok", "uptime": <seconds>}` as long as the Node.js process is running and the event loop is not blocked. The readiness endpoint SHALL perform dependency checks: PostgreSQL connectivity (SELECT 1), Redis connectivity (PING), and route configuration load status; it SHALL return `200 OK` with a per-dependency status map when all dependencies are healthy, or `503 Service Unavailable` with the failing dependency identified when any check fails. Both endpoints SHALL respond within 200 ms and SHALL NOT require authentication. These endpoints SHALL be excluded from rate limiting and audit logging.

**FR-25 — Structured Logging**
The system SHALL emit structured JSON log entries to stdout for all significant events. Each log entry SHALL include: `timestamp` (ISO 8601), `level` (`debug` | `info` | `warn` | `error`), `requestId`, `service` (`"app-gateway"`), `event`, and a `context` object with relevant metadata. HTTP request logs SHALL include method, path, status code, latency (ms), and `X-Request-Id`. The system SHALL NOT log sensitive values (passwords, raw tokens, private keys) at any log level. Log level SHALL be configurable via the `LOG_LEVEL` environment variable (default `info`). In production the system SHALL support log shipping to an external aggregator via stdout capture; no file-based logging is required.

---

## 3. Non-Functional Requirements

**NFR-1 — Latency**
P95 response latency for all authentication endpoints (`/v1/auth/*`, `/v1/oauth/*`) SHALL be ≤ 150 ms under a load of 1,000 concurrent users generating sustained requests. P99 latency SHALL be ≤ 300 ms. Proxy pass-through latency overhead (time added by the gateway beyond the upstream service's own latency) SHALL be ≤ 10 ms at P95. Measurements SHALL be taken with a warm Redis and PostgreSQL connection pool.

**NFR-2 — Token Lifetimes**
JWT access tokens SHALL expire exactly 15 minutes (900 seconds) after issuance (`exp = iat + 900`). Refresh tokens SHALL expire 7 days (604,800 seconds) after issuance and SHALL be rotated (replaced) on every successful use. Authorization codes (OAuth) SHALL expire 10 minutes after issuance. Client credentials access tokens SHALL expire 1 hour after issuance.

**NFR-3 — Rate Limiting**
Authentication and OAuth endpoints SHALL enforce a maximum of 100 requests per minute per source IP address by default. This limit SHALL be enforced via Redis sliding-window algorithm to prevent burst exploitation at window boundaries. IP-based limits SHALL be adjustable per deployment via environment variable `AUTH_RATE_LIMIT_RPM`.

**NFR-4 — Availability**
The service SHALL achieve 99.9% uptime (≤ 8.76 hours downtime per year) as measured over a rolling 30-day window. The service SHALL be stateless (all session state in Redis/PostgreSQL) to support horizontal scaling behind a load balancer. A minimum of 2 replicas SHALL be deployed in production.

**NFR-5 — Security — OWASP Compliance**
The gateway SHALL be compliant with the OWASP Top 10 (2021) applicable to its attack surface. Specifically: injection prevention via Zod input validation on all endpoints (A03); broken authentication mitigated via bcrypt cost ≥ 12, token rotation, and revocation (A07); security misconfiguration prevented via strict Helmet.js headers and no default credentials (A05); cryptographic failures prevented via RSA-2048 minimum for JWT signing and AES-256-GCM for PII encryption at rest (A02).

**NFR-6 — PII Encryption at Rest**
The `users.email` field and any other PII stored in the database SHALL be encrypted at the application layer using AES-256-GCM with a key derived from a KMS-managed master key (AWS KMS or HashiCorp Vault in production; environment variable `ENCRYPTION_KEY` for local development). The `audit_log.ip_address` field SHALL be stored as a hashed (HMAC-SHA256) value after 30 days to comply with GDPR data minimization requirements (handled by external archival job).

**NFR-7 — GDPR — Audit Log Retention**
Audit log entries SHALL be retained for a minimum of 90 days to satisfy security audit requirements. Entries SHALL be eligible for automated archival (move to cold storage) after 90 days. The gateway SHALL NOT store any information enabling reconstruction of a user's full browsing history beyond the fields defined in FR-20.

**NFR-8 — Scalability**
The service SHALL support horizontal scaling to at least 10 replicas without any per-instance state beyond in-process JWKS key cache (refreshed every 60 minutes). Database connection pooling SHALL be configured with a maximum of 20 connections per replica (Drizzle + `pg` pool). Redis connection SHALL use a single connection per replica with automatic reconnection.

**NFR-9 — Observability**
The service SHALL expose a `/metrics` endpoint (Prometheus format) with at minimum: `http_requests_total` (by method, path, status), `http_request_duration_seconds` (histogram), `auth_token_issued_total` (by auth_method), `auth_token_revoked_total`, `rate_limit_exceeded_total` (by endpoint), and `upstream_proxy_duration_seconds` (by service). This endpoint SHALL be excluded from authentication requirements.

**NFR-10 — Dependency Versions**
The following dependency versions SHALL be used: Node.js 20 LTS, TypeScript 5.x, Express 5.x, PostgreSQL 16, Drizzle ORM (latest stable), Redis 7.x, `jose` 5.x, `passport-saml` 4.x, `zod` 3.x, Vitest 2.x, Supertest 6.x. All production dependencies SHALL be pinned to exact versions in `package.json`. `npm audit` SHALL report zero high or critical vulnerabilities at time of release.

---

## 4. Architecture Impact

### 4.1 System Tiers

| Tier              | Component                    | Technology                          | Notes                                                                 |
|-------------------|------------------------------|-------------------------------------|-----------------------------------------------------------------------|
| Edge / Gateway    | App Gateway Service          | Node.js 20, Express 5, TypeScript 5 | Single ingress; horizontally scalable; stateless                      |
| Auth Store        | PostgreSQL 16                | Drizzle ORM                         | Users, tokens, SAML config, OAuth clients, audit log                 |
| Session Cache     | Redis 7                      | `ioredis`                           | JWT revocation set, refresh token cache, rate limit counters          |
| Identity Provider | Okta / Azure AD / Google WS  | SAML 2.0 (passport-saml)           | External; configured per tenant in `saml_configurations`             |
| Backend Services  | Upstream APIs                | Any (language-agnostic)             | Receive identity via X-User-* headers; no auth logic required        |
| Local Dev         | Docker Compose               | postgres:16, redis:7 images        | `docker-compose.yml` at project root; seeded with test fixtures       |

### 4.2 API Changes

| Method   | Path                                   | Auth Required        | Description                                          | Breaking Change |
|----------|----------------------------------------|----------------------|------------------------------------------------------|-----------------|
| POST     | /v1/auth/login                         | None                 | Credential login; issues access + refresh token      | New             |
| POST     | /v1/auth/refresh                       | None (refresh token) | Rotate refresh token; issues new token pair          | New             |
| POST     | /v1/auth/logout                        | Bearer (access)      | Revoke access + refresh token                        | New             |
| GET      | /v1/auth/me                            | Bearer (access)      | Return authenticated user profile                    | New             |
| GET      | /v1/auth/.well-known/jwks.json         | None                 | Publish JWKS public keys                             | New             |
| GET      | /v1/auth/saml/:tenant/initiate         | None                 | Begin SP-initiated SAML SSO; redirects to IdP        | New             |
| POST     | /v1/auth/saml/:tenant/callback         | None (SAML POST)     | Consume SAML assertion; issue JWT pair               | New             |
| GET      | /v1/auth/saml/:tenant/metadata         | None                 | Serve SP SAML metadata XML                           | New             |
| POST     | /v1/auth/saml/:tenant/logout           | None (SAML POST)     | Process SAML SLO request/response                    | New             |
| GET      | /v1/oauth/authorize                    | None (user session)  | OAuth 2.0 authorization endpoint; issues auth code   | New             |
| POST     | /v1/oauth/token                        | Basic / None         | Exchange code or credentials for token               | New             |
| POST     | /v1/oauth/introspect                   | Basic (client)       | Introspect a token per RFC 7662                      | New             |
| POST     | /v1/oauth/revoke                       | Basic (client)       | Revoke an access or refresh token per RFC 7009       | New             |
| POST     | /v1/oauth/clients                      | ApiKey (admin)       | Register a new OAuth client                          | New             |
| ALL      | /api/:service/:path*                   | Configurable         | Proxy request to upstream; inject identity headers   | New             |
| GET      | /health                                | None                 | Liveness probe                                       | New             |
| GET      | /ready                                 | None                 | Readiness probe (checks DB + Redis)                  | New             |

### 4.3 Data Model

#### Table: `users`

```sql
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,          -- AES-256-GCM encrypted at app layer
  email_hash       TEXT NOT NULL UNIQUE,          -- HMAC-SHA256 of plaintext email for lookups
  password_hash    TEXT,                          -- bcrypt, cost 12; NULL for SAML-only users
  first_name       TEXT,
  last_name        TEXT,
  roles            TEXT[]    NOT NULL DEFAULT '{}',
  auth_source      TEXT      NOT NULL DEFAULT 'password', -- 'password' | 'saml' | 'oauth'
  saml_name_id     TEXT,                          -- SAML NameID, unique per tenant
  tenant_id        UUID,                          -- FK to tenants table (future)
  is_active        BOOLEAN   NOT NULL DEFAULT TRUE,
  email_verified   BOOLEAN   NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at    TIMESTAMPTZ
);
CREATE INDEX idx_users_email_hash ON users(email_hash);
CREATE INDEX idx_users_tenant_saml ON users(tenant_id, saml_name_id);
```

#### Table: `refresh_tokens`

```sql
CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,           -- SHA-256 of plaintext token
  session_family  UUID NOT NULL,                  -- Groups tokens for reuse detection
  client_id       TEXT,                           -- OAuth client_id if applicable
  ip_address      INET,
  user_agent      TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revocation_reason TEXT                          -- 'logout' | 'rotation' | 'slo' | 'reuse_detected'
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(session_family);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;
```

#### Table: `saml_configurations`

```sql
CREATE TABLE saml_configurations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL UNIQUE,
  tenant_slug       TEXT NOT NULL UNIQUE,         -- URL-safe slug used in /saml/{tenant}/*
  idp_entity_id     TEXT NOT NULL,
  idp_sso_url       TEXT NOT NULL,
  idp_slo_url       TEXT,
  idp_certificate   TEXT NOT NULL,                -- PEM-encoded X.509 cert
  sp_certificate    TEXT NOT NULL,                -- PEM-encoded X.509 cert
  sp_private_key    TEXT NOT NULL,                -- PEM-encoded private key (encrypted at rest)
  attribute_mapping JSONB NOT NULL DEFAULT '{}',  -- Maps IdP attributes to platform fields
  auto_provision    BOOLEAN NOT NULL DEFAULT TRUE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_saml_config_tenant_slug ON saml_configurations(tenant_slug);
```

#### Table: `oauth_clients`

```sql
CREATE TABLE oauth_clients (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           TEXT NOT NULL UNIQUE,       -- UUID v4 string
  client_name         TEXT NOT NULL,
  client_type         TEXT NOT NULL,              -- 'public' | 'confidential'
  client_secret_hash  TEXT,                       -- bcrypt; NULL for public clients
  redirect_uris       TEXT[] NOT NULL DEFAULT '{}',
  grant_types         TEXT[] NOT NULL DEFAULT '{}',
  allowed_scopes      TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_rpm      INTEGER NOT NULL DEFAULT 100,
  logo_uri            TEXT,
  contacts            TEXT[],
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_oauth_clients_client_id ON oauth_clients(client_id);
```

#### Table: `oauth_authorization_codes`

```sql
CREATE TABLE oauth_authorization_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT NOT NULL UNIQUE,         -- opaque 256-bit random string
  client_id         TEXT NOT NULL,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri      TEXT NOT NULL,
  scope             TEXT NOT NULL,
  code_challenge    TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_oauth_codes_expires ON oauth_authorization_codes(expires_at) WHERE used_at IS NULL;
```

#### Table: `oauth_access_tokens`

```sql
CREATE TABLE oauth_access_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jti          TEXT NOT NULL UNIQUE,              -- JWT ID claim
  client_id    TEXT NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL for client_credentials
  scope        TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_oauth_tokens_jti ON oauth_access_tokens(jti);
CREATE INDEX idx_oauth_tokens_user ON oauth_access_tokens(user_id) WHERE revoked_at IS NULL;
```

#### Table: `audit_log`

```sql
CREATE TABLE audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type       TEXT NOT NULL,  -- see Event Type enum below
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id        TEXT,
  ip_address       INET,
  user_agent       TEXT,
  resource         TEXT,
  outcome          TEXT NOT NULL,  -- 'success' | 'failure' | 'denied'
  failure_reason   TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type, timestamp DESC);
-- Partition by month for large deployments (recommended but not required in v1)
```

**Audit Event Types (enum):**
`auth.login`, `auth.login_failed`, `auth.logout`, `auth.token_refresh`, `auth.token_refresh_failed`,
`auth.token_revoked`, `saml.sso_initiated`, `saml.assertion_received`, `saml.sso_failed`,
`saml.slo_received`, `saml.account_linked`, `oauth.code_issued`, `oauth.token_issued`,
`oauth.token_introspected`, `oauth.client_registered`, `proxy.request_allowed`,
`proxy.request_denied`, `proxy.upstream_error`

### 4.4 Shared TypeScript Types

The following types SHALL be exported from `src/types/index.ts` and used throughout the codebase:

```typescript
// src/types/index.ts

export interface JwtAccessTokenClaims {
  sub: string;           // user UUID
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

// Augment Express Request
declare global {
  namespace Express {
    interface Request {
      auth?: JwtAccessTokenClaims;
      requestId: string;
    }
  }
}
```

---

## 5. Out of Scope

The following items are explicitly excluded from this specification and SHALL NOT be implemented as part of AGW-001:

1. **Multi-factor Authentication (MFA/TOTP)** — Planned for AGW-002. SAML assertions from IdPs that enforce MFA are supported transitively, but the gateway itself does not manage MFA enrollment or challenges.
2. **User Registration & Email Verification** — User accounts are pre-provisioned by administrators or auto-provisioned via SAML (FR-8). Self-service registration is a separate service concern.
3. **Admin UI / Dashboard** — No front-end management interface. Configuration is via database records and environment variables.
4. **OpenID Connect (OIDC) Provider** — The gateway issues opaque JWTs for platform use; it does NOT implement a full OIDC discovery endpoint (`/.well-known/openid-configuration`), `id_token` issuance, or `userinfo` endpoint. These are planned for AGW-003.
5. **Dynamic Route Management API** — Routes are loaded from a static configuration file at startup. A CRUD API for routes is planned for AGW-004.
6. **Audit Log Archival Job** — The archival/anonymization scheduled job is a separate operational concern outside this service.
7. **OAuth Consent Screen** — For v1, first-party clients auto-consent. A consent UI is deferred.
8. **Certificate Rotation Automation** — Admins must manually update SAML SP/IdP certificates in the `saml_configurations` table. Automated rotation is out of scope.
9. **WebSocket Proxying** — Only HTTP/1.1 request-response proxying is in scope. WebSocket upgrade support is deferred.
10. **IP Allowlisting / Geo-blocking** — Not implemented in this service; handled at the infrastructure (WAF) layer.

---

## 6. Acceptance Criteria

> Notation: Each criterion follows Given/When/Then format. FR reference indicates which functional requirement is being validated.

---

**AC-1** *(FR-1)*
**Given** a registered user with a valid email and correct password,
**When** a POST request is sent to `/v1/auth/login` with `{"email": "user@example.com", "password": "correct"}`,
**Then** the response SHALL be `200 OK` with a JSON body containing `access_token` (a valid RS256-signed JWT), `refresh_token` (a 256-bit URL-safe string), `token_type: "Bearer"`, `expires_in: 900`, and a non-empty `scope`; and the `refresh_tokens` table SHALL contain a new record with the SHA-256 hash of the returned `refresh_token`.

**AC-2** *(FR-1)*
**Given** a registered user with a correct email but incorrect password,
**When** a POST request is sent to `/v1/auth/login` with the wrong password,
**Then** the response SHALL be `401 Unauthorized` with `{"error": "invalid_credentials"}`, and no tokens SHALL be issued; an `audit_log` entry with `event_type: "auth.login_failed"` SHALL be written.

**AC-3** *(FR-2)*
**Given** a valid JWT access token issued by the gateway,
**When** a request is sent to any auth-required proxy route with `Authorization: Bearer <token>`,
**Then** the gateway SHALL attach decoded claims to the request context and forward the request to the upstream service.

**AC-4** *(FR-2)*
**Given** a JWT access token that has expired,
**When** a request is made to an auth-required endpoint using that token,
**Then** the response SHALL be `401 Unauthorized` with `{"error": "token_expired"}`.

**AC-5** *(FR-2, FR-23)*
**Given** a valid JWT access token whose `jti` has been added to the Redis revocation set,
**When** a request is made using that token,
**Then** the response SHALL be `401 Unauthorized` with `{"error": "token_revoked"}`, even if the token has not yet reached its `exp` time.

**AC-6** *(FR-3)*
**Given** a user who logs in via password authentication,
**When** the returned access token is decoded,
**Then** the payload SHALL contain all of: `sub`, `email`, `roles`, `auth_method: "password"`, `scope`, `iat`, `exp`, `nbf`, `iss`, `aud`, and `jti`; and `exp - iat` SHALL equal 900.

**AC-7** *(FR-4)*
**Given** a valid refresh token,
**When** a POST request is sent to `/v1/auth/refresh` with `{"refresh_token": "<token>"}`,
**Then** the response SHALL be `200 OK` with a new `access_token` and a new `refresh_token`; the previous refresh token record SHALL have `revoked_at` set in the database; and the new refresh token SHALL have a new `session_family` lineage entry.

**AC-8** *(FR-4)*
**Given** a refresh token that has already been used once (consumed),
**When** the same plaintext refresh token is presented again to `/v1/auth/refresh`,
**Then** the response SHALL be `401 Unauthorized` with `{"error": "token_reuse_detected"}`; AND all refresh tokens in the same `session_family` SHALL be revoked in the database, forcing the user to re-authenticate.

**AC-9** *(FR-5)*
**Given** an authenticated user with a valid access token and an active refresh token,
**When** a POST request is sent to `/v1/auth/logout` with the Bearer token,
**Then** the response SHALL be `204 No Content`; the access token's `jti` SHALL be present in Redis with a TTL ≤ 900 seconds; the associated refresh token record SHALL have `revoked_at` set; and a subsequent request using the same access token SHALL return `401 Unauthorized`.

**AC-10** *(FR-6)*
**Given** a tenant with an active `saml_configurations` record with slug `"acme"`,
**When** a GET request is sent to `/v1/auth/saml/acme/metadata`,
**Then** the response SHALL be `200 OK` with `Content-Type: application/xml`; the body SHALL be valid SAML 2.0 SP metadata XML containing the SP entity ID, ACS URL, SLO URL, and X.509 certificate.

**AC-11** *(FR-6)*
**Given** a tenant slug that does not exist in `saml_configurations`,
**When** a GET request is sent to `/v1/auth/saml/nonexistent/metadata`,
**Then** the response SHALL be `404 Not Found` with `{"error": "tenant_not_found"}`.

**AC-12** *(FR-7)*
**Given** a tenant with an active SAML configuration,
**When** a GET request is sent to `/v1/auth/saml/acme/initiate` with an optional `redirect_to` query parameter,
**Then** the response SHALL be `302 Found` redirecting to the IdP's SSO URL with valid `SAMLRequest` (URL-encoded DEFLATE) and `RelayState` query parameters; the `RelayState` SHALL be an HMAC-signed state token.

**AC-13** *(FR-8)*
**Given** a valid SAML Response posted to `/v1/auth/saml/acme/callback` by a trusted IdP,
**When** the assertion passes all validation checks (signature, conditions, audience, timing),
**Then** the system SHALL issue a JWT access token and refresh token; if the user email does not exist in `users` a new record SHALL be created; an `audit_log` entry with `event_type: "saml.assertion_received"` and `outcome: "success"` SHALL be written.

**AC-14** *(FR-8)*
**Given** a SAML Response with an invalid signature,
**When** it is posted to `/v1/auth/saml/acme/callback`,
**Then** the response SHALL be `401 Unauthorized`; an `audit_log` entry with `event_type: "saml.sso_failed"` and `outcome: "failure"` SHALL be written; no user account SHALL be created or modified.

**AC-15** *(FR-9)*
**Given** an existing user authenticated via password (`auth_source = "password"`),
**When** that user's email is received in a valid SAML assertion for tenant "acme",
**Then** the existing `users` record SHALL be updated with `saml_name_id` and `tenant_id`; no duplicate user record SHALL be created; an `audit_log` entry with `event_type: "saml.account_linked"` SHALL be written.

**AC-16** *(FR-10)*
**Given** a user with an active SAML session,
**When** the IdP sends a SAML `LogoutRequest` to `/v1/auth/saml/acme/logout`,
**Then** all active refresh tokens for that user SHALL be revoked; outstanding JTIs SHALL be added to the Redis revocation set; a valid SAML `LogoutResponse` SHALL be returned to the IdP.

**AC-17** *(FR-11)*
**Given** a registered OAuth public client with `grant_types: ["authorization_code"]`,
**When** a GET request is made to `/v1/oauth/authorize` with valid `response_type=code`, `client_id`, `redirect_uri`, `scope=api:read`, `state`, `code_challenge`, and `code_challenge_method=S256`,
**Then** the response SHALL be `302 Found` redirecting to `redirect_uri` with `code` and `state` parameters; an `oauth_authorization_codes` record SHALL exist for the issued code.

**AC-18** *(FR-11)*
**Given** an authorization code and the original PKCE `code_verifier`,
**When** a POST request is made to `/v1/oauth/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and `code_verifier`,
**Then** the response SHALL be `200 OK` with a valid `access_token`; the `oauth_authorization_codes` record SHALL have `used_at` set; a second use of the same code SHALL return `400 Bad Request` with `{"error": "invalid_grant"}`.

**AC-19** *(FR-11)*
**Given** an authorization code request without `code_challenge`,
**When** the client is a public client,
**Then** the response SHALL be `400 Bad Request` with `{"error": "invalid_request", "error_description": "code_challenge required for public clients"}`.

**AC-20** *(FR-12)*
**Given** a registered confidential OAuth client with `grant_types: ["client_credentials"]`,
**When** a POST request is made to `/v1/oauth/token` with `grant_type=client_credentials` and valid HTTP Basic Auth,
**Then** the response SHALL be `200 OK` with a valid `access_token`, `token_type: "Bearer"`, `expires_in: 3600`, and no `refresh_token`.

**AC-21** *(FR-13)*
**Given** a valid, unexpired, non-revoked access token,
**When** a POST request is made to `/v1/oauth/introspect` with valid client Basic Auth and `token=<access_token>`,
**Then** the response SHALL be `200 OK` with `{"active": true, "sub": "...", "scope": "...", "exp": ..., ...}`.

**AC-22** *(FR-13)*
**Given** an expired or revoked access token,
**When** it is submitted to `/v1/oauth/introspect`,
**Then** the response SHALL be `200 OK` with `{"active": false}` (NOT a 4xx error).

**AC-23** *(FR-14)*
**Given** a request with a valid admin API key in `X-Admin-Api-Key` header,
**When** a POST request is made to `/v1/oauth/clients` with a valid client registration body,
**Then** the response SHALL be `201 Created` with the registered client's details including `client_id` and — for confidential clients — `client_secret` (shown once only); a record SHALL exist in `oauth_clients`.

**AC-24** *(FR-15)*
**Given** an authenticated user with an access token scoped to `api:read` only,
**When** a request is proxied to a route requiring `api:write` scope,
**Then** the response SHALL be `403 Forbidden` with `{"error": "insufficient_scope", "scope": "api:write"}`; an `audit_log` entry with `event_type: "proxy.request_denied"` SHALL be written.

**AC-25** *(FR-16, FR-17)*
**Given** a route configuration with `auth_required: true` for `/api/users/*` pointing to upstream `http://user-service:3001`,
**When** an unauthenticated request is made to `/api/users/profile`,
**Then** the response SHALL be `401 Unauthorized`; the upstream service SHALL NOT receive the request.

**AC-26** *(FR-18)*
**Given** an authenticated user with `id: "abc-123"`, `email: "user@example.com"`, `roles: ["viewer"]`, `auth_method: "password"`,
**When** a request is successfully proxied to an upstream service,
**Then** the upstream SHALL receive headers `X-User-Id: abc-123`, `X-User-Email: user@example.com`, `X-User-Roles: viewer`, `X-Auth-Method: password`, and `X-Request-Id: <uuid>`.

**AC-27** *(FR-18)*
**Given** an incoming request that includes a spoofed `X-User-Id: attacker` header set by the client,
**When** the request is proxied (even if authenticated as a different user),
**Then** the upstream SHALL receive `X-User-Id` set to the gateway-derived value from the JWT, NOT the client-supplied value; the client-supplied header SHALL be stripped.

**AC-28** *(FR-22)*
**Given** a source IP address that has sent 100 requests to `/v1/auth/login` within the current 60-second window,
**When** the 101st request is received from the same IP,
**Then** the response SHALL be `429 Too Many Requests` with `Retry-After`, `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` headers.

**AC-29** *(FR-24)*
**Given** the gateway process is running with healthy PostgreSQL and Redis connections,
**When** a GET request is sent to `/ready`,
**Then** the response SHALL be `200 OK` with a JSON body indicating `{"status": "ready", "checks": {"postgres": "ok", "redis": "ok", "routes": "ok"}}`.

**AC-30** *(FR-24)*
**Given** the Redis connection is unavailable,
**When** a GET request is sent to `/ready`,
**Then** the response SHALL be `503 Service Unavailable` with `{"status": "unavailable", "checks": {"postgres": "ok", "redis": "error", "routes": "ok"}}`.

**AC-31** *(FR-21)*
**Given** the gateway has issued tokens with two different key IDs (e.g., after a key rotation),
**When** a GET request is sent to `/v1/auth/.well-known/jwks.json`,
**Then** the response SHALL contain both public keys in the `keys` array; the `Cache-Control` header SHALL be `public, max-age=3600`.

**AC-32** *(FR-19)*
**Given** an authenticated user whose role is `"viewer"` attempting to access a route with `allowed_roles: ["admin"]`,
**When** the request is received by the proxy,
**Then** the response SHALL be `403 Forbidden` with `{"error": "forbidden", "error_description": "Insufficient role"}`; an `audit_log` entry with `event_type: "proxy.request_denied"` and `outcome: "denied"` SHALL be written.

**AC-33** *(FR-20)*
**Given** a successful login event,
**When** the audit log is queried for entries with `event_type: "auth.login"`,
**Then** the record SHALL contain `user_id`, `ip_address`, `user_agent`, `outcome: "success"`, and `timestamp`; it SHALL NOT contain any plaintext password or token value.

**AC-34** *(FR-25)*
**Given** the gateway is running with `LOG_LEVEL=info`,
**When** any HTTP request is processed,
**Then** a JSON log line SHALL be emitted to stdout containing `timestamp`, `level`, `requestId`, `service: "app-gateway"`, `method`, `path`, `status`, and `latencyMs`; no sensitive values SHALL appear in the log output.

**AC-35** *(NFR-1)*
**Given** 1,000 concurrent users each sending requests to `/v1/auth/login`,
**When** the load test runs for 60 seconds against a warm gateway instance,
**Then** P95 response latency SHALL be ≤ 150 ms and P99 SHALL be ≤ 300 ms as measured by the load testing tool (k6 or Artillery).

---

## 7. Testing Strategy

### 7.1 Unit Tests (Vitest)

Unit tests SHALL cover all service-layer classes and utility functions in isolation with dependencies mocked. Minimum coverage thresholds: **80% line coverage** across the codebase; **95% line coverage** for `TokenService`, `SamlService`, `OAuthService`.

| Test Suite          | File Path                                  | Key Scenarios                                                                                                                                                                         |
|---------------------|--------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `TokenService`      | `src/services/__tests__/token.service.test.ts`   | Issue access token with correct claims; verify expiry = 900s; verify RS256 signature; validate a valid token; reject expired token; reject tampered signature; detect revoked JTI in Redis; rotate refresh token; detect refresh token reuse and revoke family |
| `SamlService`       | `src/services/__tests__/saml.service.test.ts`    | Build SP metadata XML; generate AuthnRequest redirect URL; validate well-formed SAML assertion; reject assertion with bad signature; reject expired assertion (NotOnOrAfter); auto-provision new user; link SAML to existing user; handle SLO request and revoke sessions |
| `OAuthService`      | `src/services/__tests__/oauth.service.test.ts`   | Validate authorization request params; reject missing code_challenge for public client; issue authorization code; exchange code for token with valid PKCE verifier; reject invalid PKCE verifier; issue client_credentials token; introspect active token; introspect expired token returns `active: false` |
| `ProxyService`      | `src/services/__tests__/proxy.service.test.ts`   | Resolve route by path; strip X-User-* headers from incoming request; inject correct identity headers; handle upstream timeout; handle upstream 5xx and return 502; route with `auth_required: false` passes unauthenticated |
| `RateLimiter`       | `src/middleware/__tests__/rate-limiter.test.ts`  | First N requests within limit return 200; (N+1)th request returns 429 with correct headers; sliding window resets correctly; per-client override respected; Redis failure falls back gracefully |
| `AuditService`      | `src/services/__tests__/audit.service.test.ts`   | Login success writes correct event; login failure writes failure reason; no plaintext token in metadata; logout writes revocation event |
| `EncryptionUtils`   | `src/utils/__tests__/encryption.test.ts`         | Encrypt/decrypt roundtrip; different plaintexts produce different ciphertexts; tampered ciphertext throws; HMAC hash is deterministic |
| `ValidationSchemas` | `src/schemas/__tests__/validation.test.ts`       | Login schema rejects missing fields; OAuth authorize rejects invalid response_type; client registration rejects non-HTTPS redirect URIs (except localhost) |

### 7.2 Integration Tests (Vitest + Supertest)

Integration tests SHALL run against a real PostgreSQL 16 and Redis 7 instance (via Docker Compose test profile) with the full Express application mounted. A test database SHALL be seeded with fixture data before each test suite. Transactions SHALL be rolled back after each test.

| Test Suite                    | File Path                                                     | Endpoints Covered                                                                                                           |
|-------------------------------|---------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| Auth Endpoints                | `src/__tests__/integration/auth.test.ts`                      | POST /v1/auth/login (success, bad password, unknown user, missing fields); POST /v1/auth/refresh (success, reuse, expired); POST /v1/auth/logout (success, already-revoked token); GET /v1/auth/me (valid, invalid, missing token) |
| JWKS Endpoint                 | `src/__tests__/integration/jwks.test.ts`                      | GET /v1/auth/.well-known/jwks.json (structure, Cache-Control, key fields)                                                   |
| SAML Endpoints                | `src/__tests__/integration/saml.test.ts`                      | GET /v1/auth/saml/:tenant/metadata (valid tenant, missing tenant); GET /v1/auth/saml/:tenant/initiate (redirect, RelayState); POST /v1/auth/saml/:tenant/callback (valid assertion mock, invalid signature); POST /v1/auth/saml/:tenant/logout |
| OAuth Endpoints               | `src/__tests__/integration/oauth.test.ts`                     | GET /v1/oauth/authorize (valid, missing challenge, bad client); POST /v1/oauth/token (auth_code exchange, client_credentials, invalid grant, code replay); POST /v1/oauth/introspect (active, expired, invalid); POST /v1/oauth/revoke; POST /v1/oauth/clients (valid, duplicate, non-HTTPS redirect) |
| Proxy Middleware              | `src/__tests__/integration/proxy.test.ts`                     | ALL /api/:service/* (authenticated pass-through with header injection, unauthenticated on public route, unauthenticated on private route → 401, insufficient role → 403, insufficient scope → 403, rate limit → 429, upstream timeout → 504, header stripping) |
| Health/Readiness              | `src/__tests__/integration/health.test.ts`                    | GET /health (200 + uptime); GET /ready (all healthy → 200; Redis down → 503; Postgres down → 503)                          |
| Rate Limiting                 | `src/__tests__/integration/rate-limit.test.ts`                | Sequential requests up to limit; burst over limit; window reset; per-client limit                                           |

### 7.3 End-to-End Tests

E2E tests SHALL simulate complete user journeys across the full stack using Docker Compose with real upstream stub services (implemented as simple Express apps that echo received headers).

| Scenario                         | Description                                                                                                                                                                                                     |
|----------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Full Password Login → Proxy**  | Client logs in via POST /v1/auth/login; receives tokens; calls /api/stub/echo with Bearer token; stub returns received headers; test asserts X-User-Id, X-User-Email, X-User-Roles, X-Auth-Method are present and correct. |
| **Token Refresh Cycle**          | Client logs in; waits for (mock) access token expiry via time-forwarding; sends expired token → gets 401; uses refresh token to get new pair; retries with new access token → 200.                               |
| **Logout & Revocation**          | Client logs in; calls logout; retries with revoked access token → 401; retries with revoked refresh token → 401.                                                                                                |
| **SAML SSO Full Flow**           | Test IdP (configured with `saml-idp` npm package or Wiremock SAML stub) posts a valid assertion to /v1/auth/saml/test-tenant/callback; gateway issues JWT pair; tokens are used to call proxy route; upstream receives correct identity headers. |
| **OAuth Authorization Code + PKCE** | Client generates PKCE pair; calls /v1/oauth/authorize; follows redirect; exchanges code at /v1/oauth/token; uses issued token to call proxy; verifies headers at upstream stub.                              |
| **Rate Limit Enforcement**       | Automated script sends 110 requests/min to /v1/auth/login from same IP; first 100 succeed; remaining 10 return 429; after window reset subsequent requests succeed.                                              |
| **Refresh Token Reuse Attack**   | Client logs in; rotates refresh token once; replays original refresh token; gateway detects reuse; all family tokens are revoked; subsequent use of both old and new refresh tokens returns 401.                  |

### 7.4 Manual / IdP Integration Tests

These tests MUST be executed manually against real Identity Provider sandboxes before production deployment. Results SHALL be documented in a test evidence log.

| Test Case                        | IdP                  | Steps                                                                                                                           | Expected Outcome                                                                  |
|----------------------------------|----------------------|---------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| Okta SP-Initiated SSO            | Okta Developer       | Configure SAML app in Okta; set ACS URL; trigger login from gateway; complete Okta MFA; observe redirect                        | JWT tokens issued; user provisioned in DB; audit log entry present                |
| Azure AD SP-Initiated SSO        | Azure AD Free Tenant | Register enterprise app; configure SAML; add test user; trigger SP-initiated flow                                              | JWT tokens issued; roles mapped from Azure AD groups attribute                    |
| Google Workspace SSO             | Google Workspace     | Configure custom SAML app; set attributes (email, firstName, lastName); initiate SSO                                           | JWT tokens issued; name attributes mapped correctly                               |
| Okta IdP-Initiated SSO           | Okta Developer       | Assign SAML app to user; click app tile in Okta dashboard (IdP-initiated); observe POST to callback URL                        | JWT tokens issued without RelayState; user redirected to default platform URL     |
| SAML SLO from IdP                | Okta Developer       | Log in via Okta; log out from Okta dashboard; verify SLO request received by gateway                                           | All active sessions for user revoked; LogoutResponse sent to Okta                 |
| Expired IdP Certificate          | Any                  | Configure an expired X.509 certificate in `saml_configurations`; attempt SSO                                                   | Login fails with 401; audit log entry with `saml.sso_failed`; no user created     |
| Clock Skew Test                  | Any                  | Manually craft SAML assertion with `NotBefore` 25 seconds in the future                                                        | Assertion accepted (within 30s tolerance); assertion 40s in future → rejected     |

---

## 8. Open Questions

| # | Question                                                                                                             | Owner                  | Resolution Target | Status  |
|---|----------------------------------------------------------------------------------------------------------------------|------------------------|-------------------|---------|
| 1 | Should the JWKS private key be generated at startup (stored in DB/KMS) or loaded from a static file mount? KMS integration adds operational complexity but is more secure for key material. | Security Engineering   | Sprint 1          | Open    |
| 2 | What is the expected maximum number of concurrent SAML tenants? Affects whether `saml_configurations` lookup should be cached in Redis or served directly from Postgres. | Platform Architecture  | Sprint 1          | Open    |
| 3 | For the OAuth authorization code flow, should the consent screen be skipped only for first-party clients identified by a flag, or for all clients in v1? A UI-less auto-consent may be insufficient for third-party OAuth clients. | Product                | Sprint 2          | Open    |
| 4 | The `users.email` encryption scheme requires application-layer key management. Should we use envelope encryption (per-row DEK wrapped with a KMS-managed KEK) or a single AES key for all rows? Per-row DEK is more resilient to key compromise but adds latency and complexity. | Security Engineering   | Sprint 1          | Open    |
| 5 | What upstream services should be included in the initial route configuration for the first deployment? The proxy spec is generic, but real route entries depend on the platform service registry. | Backend Platform       | Sprint 2          | Open    |
| 6 | Should `audit_log` entries for `proxy.request_allowed` be written for every single proxied request, or only for sensitive routes? High-traffic proxies may generate audit log volumes that overwhelm the PostgreSQL write capacity. Consider sampling or async write via Redis queue. | DevOps / Platform      | Sprint 2          | Open    |
| 7 | Is there a requirement for the gateway to support mutual TLS (mTLS) for upstream service communication, or is internal network trust sufficient for the initial deployment? | Security Engineering   | Sprint 1          | Open    |
| 8 | The refresh token family revocation on reuse detection (FR-4) will force all sessions for a user to re-authenticate. Is this acceptable UX for mobile clients where background token refresh is common and network errors could cause accidental replay? Consider a single-retry grace window. | Product / Mobile Team  | Sprint 1          | Open    |
