# Feature: Infrastructure & Operations

**Ticket:** AGW-001-INFRA (split from AGW-001)
**Status:** `Approved`
**Author:** Platform Architecture Team
**Reviewers:** Security Engineering, DevOps, QA Lead
**Created:** 2026-07-01
**Last Updated:** 2026-07-28

---

## Overview

This feature covers the operational plumbing shared by every other part of the gateway: JWKS public-key publication for external JWT verification, Redis-backed per-client and per-IP rate limiting, the JWT revocation mechanism itself, liveness/readiness health probes, and structured JSON logging. None of it is domain-specific to auth, SAML, or OAuth, but all of those specs depend on it — the JWKS endpoint is what lets `core-jwt-authentication.spec.md`'s tokens be verified, and the rate limiter is what `request-proxy-authorization.spec.md`'s policy enforcement calls into. It touches `src/routes/system.router.ts`, `src/middleware/rateLimiter.ts`, `src/config/logger.ts`, and the JWKS-serving portion of `src/services/token.service.ts`.

---

## Functional Requirements

- **FR-21 — JWKS Endpoint:** The system SHALL expose `GET /v1/auth/.well-known/jwks.json` returning a JSON Web Key Set containing all currently active and recently-rotated public keys in JWK format (RFC 7517). Each key object SHALL include: `kty`, `use`, `kid`, `alg`, `n`, `e` fields. The gateway SHALL support at least two simultaneous active key IDs to allow zero-downtime key rotation (new key signs new tokens; old key remains in JWKS until all tokens signed with it have naturally expired). JWKS responses SHALL be cached with `Cache-Control: public, max-age=3600` and SHALL respond within 50 ms (served from in-process memory, not database). The endpoint SHALL require no authentication.
- **FR-22 — Per-Client Rate Limiting:** The system SHALL implement rate limiting using a Redis sliding-window counter. The default rate limit for all authentication endpoints (`/v1/auth/*`, `/v1/oauth/*`) SHALL be 100 requests per minute per source IP address. Individual OAuth clients SHALL have configurable rate limits stored in `oauth_clients.rate_limit_rpm`. Rate limit state SHALL be stored in Redis with keys formatted as `ratelimit:{ip}:{window_start_minute}` or `ratelimit:client:{client_id}:{window_start_minute}`. When the limit is exceeded the system SHALL return `429 Too Many Requests` with headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix epoch of window reset), and `Retry-After` (seconds until reset). Proxy route rate limits SHALL be configurable per-route via `rate_limit_override` (→ FR-16, `request-proxy-authorization.spec.md`).
- **FR-23 — Token Revocation via Redis:** The system SHALL maintain a Redis set of revoked JWT `jti` values. Revocation entries SHALL use the key pattern `revoked:jti:<jti>` with a Redis TTL equal to the token's remaining lifetime (computed as `exp - now()`). The `validateAccessToken` middleware (→ FR-2, `core-jwt-authentication.spec.md`) SHALL check this set on every request using a Redis `EXISTS` command (O(1)) before attaching claims to the request context. The system SHALL also support bulk revocation: when a SAML SLO event is received (→ FR-10, `saml-sso.spec.md`) or when an admin calls a (future) admin revoke-all API, the system SHALL iterate the user's active sessions and revoke each `jti`. Refresh token revocation SHALL be persisted in PostgreSQL (`refresh_tokens.revoked_at`) with Redis caching for fast lookup (`revoked:refresh:<sha256_hash>`).
- **FR-24 — Health & Readiness Endpoints:** The system SHALL expose `GET /health` (liveness probe) and `GET /ready` (readiness probe). The liveness endpoint SHALL return `200 OK` with `{"status": "ok", "uptime": <seconds>}` as long as the Node.js process is running and the event loop is not blocked. The readiness endpoint SHALL perform dependency checks: PostgreSQL connectivity (SELECT 1), Redis connectivity (PING), and route configuration load status; it SHALL return `200 OK` with a per-dependency status map when all dependencies are healthy, or `503 Service Unavailable` with the failing dependency identified when any check fails. Both endpoints SHALL respond within 200 ms and SHALL NOT require authentication. These endpoints SHALL be excluded from rate limiting and audit logging.
- **FR-25 — Structured Logging:** The system SHALL emit structured JSON log entries to stdout for all significant events. Each log entry SHALL include: `timestamp` (ISO 8601), `level` (`debug` | `info` | `warn` | `error`), `requestId`, `service` (`"app-gateway"`), `event`, and a `context` object with relevant metadata. HTTP request logs SHALL include method, path, status code, latency (ms), and `X-Request-Id`. The system SHALL NOT log sensitive values (passwords, raw tokens, private keys) at any log level. Log level SHALL be configurable via the `LOG_LEVEL` environment variable (default `info`). In production the system SHALL support log shipping to an external aggregator via stdout capture; no file-based logging is required.

---

## Non-Functional Requirements

- **NFR-3 — Rate Limiting:** Authentication and OAuth endpoints SHALL enforce a maximum of 100 requests per minute per source IP address by default. This limit SHALL be enforced via a Redis sliding-window algorithm to prevent burst exploitation at window boundaries. IP-based limits SHALL be adjustable per deployment via environment variable `AUTH_RATE_LIMIT_RPM`.
- **NFR-4 — Availability:** The service SHALL achieve 99.9% uptime (≤ 8.76 hours downtime per year) as measured over a rolling 30-day window. The service SHALL be stateless (all session state in Redis/PostgreSQL) to support horizontal scaling behind a load balancer. A minimum of 2 replicas SHALL be deployed in production.
- **NFR-5 — Security (partial, security misconfiguration — OWASP A05):** Security misconfiguration SHALL be prevented via strict Helmet.js headers and no default credentials.
- **NFR-8 — Scalability:** The service SHALL support horizontal scaling to at least 10 replicas without any per-instance state beyond the in-process JWKS key cache (refreshed every 60 minutes). Database connection pooling SHALL be configured with a maximum of 20 connections per replica (Drizzle + `pg` pool). Redis connection SHALL use a single connection per replica with automatic reconnection.
- **NFR-9 — Observability:** The service SHALL expose a `/metrics` endpoint (Prometheus format) with at minimum: `http_requests_total` (by method, path, status), `http_request_duration_seconds` (histogram), `auth_token_issued_total` (by `auth_method`), `auth_token_revoked_total`, `rate_limit_exceeded_total` (by endpoint), and `upstream_proxy_duration_seconds` (by service). This endpoint SHALL be excluded from authentication requirements.
- **NFR-10 — Dependency Versions:** Node.js 20 LTS, TypeScript 5.x, Express 5.x, PostgreSQL 16, Drizzle ORM (latest stable), Redis 7.x, `jose` 5.x, `passport-saml` 4.x, `zod` 3.x, Vitest 2.x, Supertest 6.x. All production dependencies SHALL be pinned to exact versions in `package.json`. `npm audit` SHALL report zero high or critical vulnerabilities at time of release.

---

## Architecture Impact

### Areas Affected

| Area | Impact |
|------|--------|
| Routes (`src/routes/auth.router.ts`) | `GET /v1/auth/.well-known/jwks.json` |
| Routes (`src/routes/system.router.ts`) | `GET /health`, `GET /ready`, `GET /metrics` |
| Services (`src/services/token.service.ts`) | JWKS document generation, active/previous key management |
| Middleware (`src/middleware/rateLimiter.ts`) | Redis sliding-window limiter factory, per-IP and per-client buckets |
| Config (`src/config/logger.ts`) | Winston structured JSON logger, `LOG_LEVEL`-driven |
| Redis / cache | Key patterns `ratelimit:{ip}:{window}`, `ratelimit:client:{client_id}:{window}`, `revoked:jti:<jti>`, `revoked:refresh:<sha256_hash>` |

### API Changes

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| `GET` | `/v1/auth/.well-known/jwks.json` | New | Publish JWKS public keys |
| `GET` | `/health` | New | Liveness probe |
| `GET` | `/ready` | New | Readiness probe (checks DB + Redis) |
| `GET` | `/metrics` | New | Prometheus metrics (→ NFR-9); not listed in the source spec's API table but required by NFR-9 — add to `specs/openapi.yaml` before implementation |

### Data Model Changes

None. JWKS key material is loaded from `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` (and `JWT_PREVIOUS_PUBLIC_KEY_PATH` during rotation) and cached in-process; no new tables. Rate-limit counters and revocation entries are Redis-only (see Areas Affected).

### Zod Schema Changes

- `EnvSchema` (existing, `src/config/env.ts`) — extend as needed for any new rate-limit or logging environment variables; no request/response body schemas are introduced by this spec.

---

## Out of Scope

- **Certificate Rotation Automation:** Admins must manually update JWT signing keys and `JWT_KID`/`JWT_PREVIOUS_KID`. Automated rotation is out of scope.
- **Audit Log Archival Job:** The archival/anonymization scheduled job is a separate operational concern outside this service.
- **IP Allowlisting / Geo-blocking:** Not implemented in this service; handled at the infrastructure (WAF) layer.

---

## Acceptance Criteria

- **AC-28 (→ FR-22):** Given a source IP address that has sent 100 requests to `/v1/auth/login` within the current 60-second window, when the 101st request is received from the same IP, then the response SHALL be `429 Too Many Requests` with `Retry-After`, `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining: 0`, and `X-RateLimit-Reset` headers.
- **AC-29 (→ FR-24):** Given the gateway process is running with healthy PostgreSQL and Redis connections, when a GET request is sent to `/ready`, then the response SHALL be `200 OK` with a JSON body indicating `{"status": "ready", "checks": {"postgres": "ok", "redis": "ok", "routes": "ok"}}`.
- **AC-30 (→ FR-24):** Given the Redis connection is unavailable, when a GET request is sent to `/ready`, then the response SHALL be `503 Service Unavailable` with `{"status": "unavailable", "checks": {"postgres": "ok", "redis": "error", "routes": "ok"}}`.
- **AC-31 (→ FR-21):** Given the gateway has issued tokens with two different key IDs (e.g., after a key rotation), when a GET request is sent to `/v1/auth/.well-known/jwks.json`, then the response SHALL contain both public keys in the `keys` array; the `Cache-Control` header SHALL be `public, max-age=3600`.
- **AC-34 (→ FR-25):** Given the gateway is running with `LOG_LEVEL=info`, when any HTTP request is processed, then a JSON log line SHALL be emitted to stdout containing `timestamp`, `level`, `requestId`, `service: "app-gateway"`, `method`, `path`, `status`, and `latencyMs`; no sensitive values SHALL appear in the log output.
- **AC-35 (→ NFR-1):** Given 1,000 concurrent users each sending requests to `/v1/auth/login`, when the load test runs for 60 seconds against a warm gateway instance, then P95 response latency SHALL be ≤ 150 ms and P99 SHALL be ≤ 300 ms as measured by the load testing tool (k6 or Artillery).

---

## Testing Strategy

### Unit Tests

| Test Suite | File Path | Key Scenarios |
|---|---|---|
| `RateLimiter` | `src/middleware/__tests__/rate-limiter.test.ts` | First N requests within limit return 200; (N+1)th request returns 429 with correct headers; sliding window resets correctly; per-client override respected; Redis failure falls back gracefully |

### Integration Tests

- `GET /v1/auth/.well-known/jwks.json` — covers AC-31 (structure, `Cache-Control`, key fields). File path: `src/__tests__/integration/jwks.test.ts`.
- `GET /health`, `GET /ready` — covers AC-29, AC-30 (all healthy → 200; Redis down → 503; Postgres down → 503). File path: `src/__tests__/integration/health.test.ts`.
- Rate limiting — covers AC-28. Sequential requests up to limit; burst over limit; window reset; per-client limit. File path: `src/__tests__/integration/rate-limit.test.ts`.

### Manual / Exploratory Testing Notes

- Load test (AC-35) requires k6 or Artillery run against a warm, dedicated staging instance — not part of the standard CI pytest/vitest run.

E2E automation counterpart: **Rate Limit Enforcement** — an automated script sends 110 requests/min to `/v1/auth/login` from the same IP; the first 100 succeed, the remaining 10 return 429, and after window reset subsequent requests succeed (`src/__tests__/e2e/`).

---

## Open Questions

| # | Question | Owner | Due | Resolution |
|---|----------|-------|-----|------------|
| 1 | Should the JWKS private key be generated at startup (stored in DB/KMS) or loaded from a static file mount? KMS integration adds operational complexity but is more secure for key material. | Security Engineering | Sprint 1 | *Pending* |

---

## Implementation Notes

- Follow the JWKS dual-key rotation pattern: `JWT_KID` signs new tokens, `JWT_PREVIOUS_KID` stays verify-only in the JWKS document until all tokens signed with it expire.
- The rate limiter and revocation set defined here are consumed by every other split spec — treat this service's Redis key namespace (`ratelimit:*`, `revoked:*`) as a shared contract; do not introduce parallel key patterns elsewhere.
- See `specs/app-gateway-auth.spec.md` for the original, unsplit specification this document was derived from.

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/infrastructure-operations.plan.md`*
