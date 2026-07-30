# Feature: Request Proxy & Authorization

**Ticket:** AGW-001-PROXY (split from AGW-001)
**Status:** `Approved`
**Author:** Platform Architecture Team
**Reviewers:** Security Engineering, Backend Platform, DevOps, QA Lead
**Created:** 2026-07-01
**Last Updated:** 2026-07-29

---

## Overview

This feature is the reverse-proxy core of the gateway: a configurable routing table maps incoming paths to upstream services, enforces authentication and authorization policy per route, injects tamper-evident identity headers so upstream services never need their own token validation, and writes an append-only audit trail of every authentication and authorization decision. It is the layer every authenticated request — whether the token came from password login, SAML, or OAuth — passes through on its way to a backend service. It touches `src/routes/proxy.router.ts`, `src/services/proxy.service.ts`, `src/services/audit.service.ts`, and the `audit_log` table.

---

## Functional Requirements

- **FR-16 — Route Configuration:** The system SHALL support a route configuration model stored in a `routes` JSON configuration file (loaded at startup) and optionally overridable via environment variables for Kubernetes ConfigMap injection. Each route entry SHALL specify: `path` (Express-compatible pattern, e.g., `/api/users/:path*`), `upstream` (full base URL of the backend service), `auth_required` (boolean), `required_scope` (nullable string), `allowed_roles` (nullable string array), `rate_limit_override` (nullable integer), `strip_prefix` (boolean), `timeout_ms` (default 30000), and `audit_allowed_requests` (boolean, default `false` — → FR-20). The system SHALL load and validate all route configurations at startup using Zod; invalid configurations SHALL cause the process to exit with a non-zero code and a descriptive error message. (Resolved during implementation — see Open Question 1 resolution: the actual contents of the `routes` file for a given deployment are populated per-environment by Backend Platform via the mounted config file/ConfigMap; this repo ships only an illustrative example config for local dev and tests, not real upstream entries.)
- **FR-17 — JWT Validation on Proxied Requests:** The system SHALL apply the `validateAccessToken` middleware (→ FR-2, `core-jwt-authentication.spec.md`) to all proxy routes where `auth_required = true`. For routes where `auth_required = false`, the middleware SHALL run in optional mode: if an `Authorization` header is present it SHALL be validated and claims attached; if absent the request SHALL proceed unauthenticated. The system SHALL reject any request that carries a custom `X-User-Id`, `X-User-Email`, `X-User-Roles`, or `X-Auth-Method` header set by the client — these headers SHALL be stripped unconditionally before upstream forwarding to prevent identity spoofing.
- **FR-18 — Identity Header Injection:** The system SHALL, for every proxied request that has been successfully authenticated (regardless of `auth_required` setting), inject the following headers before forwarding to the upstream service: `X-User-Id` (user UUID from `sub` claim), `X-User-Email` (email claim), `X-User-Roles` (comma-separated roles array), `X-Auth-Method` (auth_method claim: `password` | `saml` | `oauth`), `X-Tenant-Id` (tenant_id claim, or omitted if null), and `X-Request-Id` (UUID v4 generated per-request for distributed tracing). For unauthenticated requests on public routes these headers SHALL be omitted entirely. The system SHALL also forward the original `X-Forwarded-For` header, appending the gateway's own IP if not already present.
- **FR-19 — Authorization Policy Enforcement:** The system SHALL enforce authorization policies before proxying each request: (a) if `auth_required = true` and no valid token is present, respond `401 Unauthorized`; (b) if `allowed_roles` is non-empty and the authenticated user's roles do not intersect with `allowed_roles`, respond `403 Forbidden`; (c) if `required_scope` is set and the token's `scope` does not include the required scope, respond `403 Forbidden` with `error: "insufficient_scope"`; (d) if the rate limit for the client is exceeded, respond `429 Too Many Requests` with `Retry-After` header. All authorization failures SHALL be recorded in `audit_log` with outcome `"denied"`.
- **FR-20 — Audit Logging:** The system SHALL write a structured audit log entry to the `audit_log` PostgreSQL table for every authentication event (login, logout, refresh, SSO callback, OAuth token issuance) and every authorization *denial* (`proxy.request_denied`, → FR-19). For a successfully authorized proxied request, the system SHALL write a `proxy.request_allowed` audit entry only when the matched route's `audit_allowed_requests` flag (→ FR-16) is `true`; routes without the flag set SHALL NOT generate a `proxy.request_allowed` row. (Resolved during implementation — see Open Question 2 resolution: an unconditional audit write for every allowed proxy request was found to conflict with NFR-1's latency budget and the write/storage volume implied by NFR-7 at production traffic; gating `proxy.request_allowed` logging per route lets compliance-sensitive routes opt in without taxing high-volume, low-sensitivity ones. Denials and auth-lifecycle events are comparatively low-volume and security-critical, so they stay unconditional.) Each entry SHALL include: `id` (UUID), `timestamp` (timestamptz), `event_type` (enumerated string), `user_id` (nullable UUID), `client_id` (nullable string), `ip_address` (inet), `user_agent` (text), `resource` (path being accessed), `outcome` (`"success"` | `"failure"` | `"denied"`), `failure_reason` (nullable text), `metadata` (JSONB for extensible context). The system SHALL NOT log plaintext tokens, passwords, or full authorization codes in any audit entry. Audit log entries SHALL be append-only; no UPDATE or DELETE operations SHALL be performed by the gateway on this table. Entries older than 90 days SHALL be eligible for archival by a scheduled external job (outside this service's scope).

---

## Non-Functional Requirements

- **NFR-1 — Performance (partial):** Proxy pass-through latency overhead (time added by the gateway beyond the upstream service's own latency) SHALL be ≤ 10 ms at P95, measured with a warm Redis and PostgreSQL connection pool.
- **NFR-7 — GDPR — Audit Log Retention:** Audit log entries SHALL be retained for a minimum of 90 days to satisfy security audit requirements. Entries SHALL be eligible for automated archival (move to cold storage) after 90 days. The gateway SHALL NOT store any information enabling reconstruction of a user's full browsing history beyond the fields defined in FR-20.

---

## Architecture Impact

### Areas Affected

| Area | Impact |
|------|--------|
| Routes (`src/routes/proxy.router.ts`) | `ALL /api/:service/:path*` — the single catch-all proxy route |
| Services (`src/services/proxy.service.ts`) | `[not yet implemented]` — route resolution, header stripping/injection, upstream dispatch via `http-proxy-middleware` |
| Services (`src/services/audit.service.ts`) | Writes `proxy.request_allowed`, `proxy.request_denied`, `proxy.upstream_error` events |
| Middleware (`src/middleware/authenticate.ts`) | Reused in optional mode for `auth_required: false` routes |
| Database (`src/db/schema.ts`) | New table `audit_log` |
| Config | New `UPSTREAM_SERVICES_CONFIG_PATH`-driven route table, Zod-validated at startup |
| Types (`src/types/index.ts`) | `RouteConfig`, `AuditLogEntry` |

### API Changes

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| `ALL` | `/api/:service/:path*` | New | Proxy request to upstream; inject identity headers |

### Data Model Changes

```
Table: audit_log (NEW)
  id               UUID PK DEFAULT gen_random_uuid()
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  event_type       TEXT NOT NULL         -- see Audit Event Types enum below
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL
  client_id        TEXT
  ip_address       INET
  user_agent       TEXT
  resource         TEXT
  outcome          TEXT NOT NULL         -- 'success' | 'failure' | 'denied'
  failure_reason   TEXT
  metadata         JSONB NOT NULL DEFAULT '{}'
  + INDEX idx_audit_log_timestamp ON (timestamp DESC)
  + INDEX idx_audit_log_user_id ON (user_id, timestamp DESC)
  + INDEX idx_audit_log_event_type ON (event_type, timestamp DESC)
  -- Partition by month for large deployments (recommended but not required in v1)
```

**Audit Event Types (enum, full platform vocabulary — populated by all specs, not just this one):**
`auth.login`, `auth.login_failed`, `auth.logout`, `auth.token_refresh`, `auth.token_refresh_failed`,
`auth.token_revoked`, `saml.sso_initiated`, `saml.assertion_received`, `saml.sso_failed`,
`saml.slo_received`, `saml.account_linked`, `oauth.code_issued`, `oauth.token_issued`,
`oauth.token_introspected`, `oauth.client_registered`, `proxy.request_allowed`,
`proxy.request_denied`, `proxy.upstream_error`

### Zod Schema Changes

- `RouteConfigSchema` — validates each entry of the `routes` JSON file at startup: `{ path, upstream: string (url), auth_required: boolean, required_scope: string | null, allowed_roles: string[] | null, rate_limit_override: number | null, strip_prefix: boolean, timeout_ms: number, audit_allowed_requests: boolean }`, new file `src/schemas/route.schemas.ts`

---

## Out of Scope

- **Dynamic Route Management API:** Routes are loaded from a static configuration file at startup. A CRUD API for routes is planned for AGW-004.
- **Audit Log Archival Job:** The archival/anonymization scheduled job is a separate operational concern outside this service.
- **WebSocket Proxying:** Only HTTP/1.1 request-response proxying is in scope. WebSocket upgrade support is deferred.
- **IP Allowlisting / Geo-blocking:** Not implemented in this service; handled at the infrastructure (WAF) layer.

---

## Acceptance Criteria

- **AC-25 (→ FR-16, FR-17):** Given a route configuration with `auth_required: true` for `/api/users/*` pointing to upstream `http://user-service:3001`, when an unauthenticated request is made to `/api/users/profile`, then the response SHALL be `401 Unauthorized`; the upstream service SHALL NOT receive the request.
- **AC-26 (→ FR-18):** Given an authenticated user with `id: "abc-123"`, `email: "user@example.com"`, `roles: ["viewer"]`, `auth_method: "password"`, when a request is successfully proxied to an upstream service, then the upstream SHALL receive headers `X-User-Id: abc-123`, `X-User-Email: user@example.com`, `X-User-Roles: viewer`, `X-Auth-Method: password`, and `X-Request-Id: <uuid>`.
- **AC-27 (→ FR-18):** Given an incoming request that includes a spoofed `X-User-Id: attacker` header set by the client, when the request is proxied (even if authenticated as a different user), then the upstream SHALL receive `X-User-Id` set to the gateway-derived value from the JWT, NOT the client-supplied value; the client-supplied header SHALL be stripped.
- **AC-32 (→ FR-19):** Given an authenticated user whose role is `"viewer"` attempting to access a route with `allowed_roles: ["admin"]`, when the request is received by the proxy, then the response SHALL be `403 Forbidden` with `{"error": "forbidden", "error_description": "Insufficient role"}`; an `audit_log` entry with `event_type: "proxy.request_denied"` and `outcome: "denied"` SHALL be written.
- **AC-33 (→ FR-20):** Given a successful login event, when the audit log is queried for entries with `event_type: "auth.login"`, then the record SHALL contain `user_id`, `ip_address`, `user_agent`, `outcome: "success"`, and `timestamp`; it SHALL NOT contain any plaintext password or token value.
- **AC-36 (→ FR-16, FR-20):** Given two routes, one with `audit_allowed_requests: true` and one with `audit_allowed_requests: false` (or omitted), when an authenticated, authorized request is successfully proxied on each, then the flagged route SHALL produce an `audit_log` entry with `event_type: "proxy.request_allowed"` and `outcome: "success"`, and the unflagged route SHALL produce no `audit_log` entry for that request; a denied request on either route SHALL still produce a `proxy.request_denied` entry regardless of the flag (per AC-32).

> Note: scope-enforcement acceptance criterion **AC-24** (insufficient scope → 403) is tracked under `oauth-authorization-server.spec.md` (FR-15) since it depends on OAuth-issued scopes, even though the enforcement code path is this proxy layer (FR-19).

---

## Testing Strategy

### Unit Tests

| Test Suite | File Path | Key Scenarios |
|---|---|---|
| `ProxyService` | `tests/unit/proxy.service.test.ts` | Resolve route by path; strip `X-User-*` headers from incoming request; inject correct identity headers; handle upstream timeout; handle upstream 5xx and return 502; route with `auth_required: false` passes unauthenticated; `proxy.request_allowed` audit write is skipped when `audit_allowed_requests` is `false`/omitted and issued when `true` |
| `AuditService` | `tests/unit/audit.service.test.ts` | Login success writes correct event; login failure writes failure reason; no plaintext token in metadata; logout writes revocation event |
| `ValidationSchemas` (partial) | `tests/unit/route.schemas.test.ts` | Route config schema rejects malformed route entries; `audit_allowed_requests` defaults to `false` when omitted |

### Integration Tests

- `ALL /api/:service/*` — covers AC-25, AC-26, AC-27, AC-32, AC-36. Scenarios: authenticated pass-through with header injection, unauthenticated on public route, unauthenticated on private route → 401, insufficient role → 403, insufficient scope → 403, rate limit → 429, upstream timeout → 504, header stripping, `proxy.request_allowed` written only for routes with `audit_allowed_requests: true`.
- File path: `tests/integration/proxy.test.ts`
- Audit entries for AC-33 are asserted as a side effect of the auth integration suites in the other split specs, not re-tested here.

### Manual / Exploratory Testing Notes

- Verify upstream 5xx and timeout handling against a deliberately slow/broken stub service before first production deployment.

---

## Open Questions

| # | Question | Owner | Due | Resolution |
|---|----------|-------|-----|------------|
| 1 | What upstream services should be included in the initial route configuration for the first deployment? The proxy spec is generic, but real route entries depend on the platform service registry. | Backend Platform | Sprint 2 | **Resolved 2026-07-29:** Not answered in this spec — resolved architecturally instead. FR-16's `UPSTREAM_SERVICES_CONFIG_PATH`-driven, Zod-validated route loading is the resolution mechanism: real per-environment route entries are populated by Backend Platform via the mounted config file/ConfigMap, outside this repo and outside spec scope, so production topology never requires a code change or a spec update. This repo ships only an illustrative example config for local dev/tests. See FR-16. |
| 2 | Should `audit_log` entries for `proxy.request_allowed` be written for every single proxied request, or only for sensitive routes? High-traffic proxies may generate audit log volumes that overwhelm the PostgreSQL write capacity. Consider sampling or async write via Redis queue. | DevOps / Platform | Sprint 2 | **Resolved 2026-07-29:** Per-route opt-in flag, not sampling or a buffering layer — `audit_allowed_requests: boolean` (default `false`) added to `RouteConfigSchema` (FR-16). `proxy.request_denied` and all auth-lifecycle events (login, refresh, SSO, OAuth) stay unconditionally logged — comparatively low-volume and security-critical, no change from today's synchronous `writeAuditEvent`. `proxy.request_allowed` is written only for routes that opt in, so the default hot path never touches `audit_log` at all rather than every request being written and merely batched or sampled. Sampling was rejected — it silently drops rows on routes an operator *does* want fully audited, which undermines the retention guarantee. Retention for whatever is written remains 90 days per NFR-7, unchanged by this flag. See FR-16, FR-20, AC-36. |
| 3 | Is there a requirement for the gateway to support mutual TLS (mTLS) for upstream service communication, or is internal network trust sufficient for the initial deployment? | Security Engineering | Sprint 1 | **Resolved 2026-07-29:** No mTLS for v1 — internal network trust (private cluster network / Kubernetes NetworkPolicies) is the boundary for gateway↔upstream calls, consistent with FR-18's existing design: upstream services already trust gateway-injected `X-User-*` headers unconditionally, which itself assumes that link isn't interceptable. Revisit at the service-mesh layer (e.g., Istio/Linkerd sidecar mTLS) rather than app-level TLS client certs in `http-proxy-middleware` if the deployment topology ever puts the gateway and its upstreams on different trust domains (cross-cluster/cross-cloud). See FR-18, Security Rules #6. |

---

## Implementation Notes

- JWT validation reuses `validateAccessToken` from `core-jwt-authentication.spec.md` (FR-2) — do not fork a second implementation for optional-auth routes.
- Scope enforcement logic here is driven by tokens issued under `oauth-authorization-server.spec.md` (FR-15); role enforcement applies uniformly regardless of `auth_method`.
- Rate limiting referenced in FR-19(d) is defined in full in `infrastructure-operations.spec.md` (FR-22).
- See `specs/app-gateway-auth.spec.md` for the original, unsplit specification this document was derived from.
- **Route configuration ownership (Open Question 1):** the `routes` JSON file (`UPSTREAM_SERVICES_CONFIG_PATH`) is populated per-environment by Backend Platform; do not hardcode real upstream service entries in this repo. Only an illustrative example config ships here, for local dev and tests.
- **Selective allowed-request auditing (Open Question 2):** `proxy.request_allowed` audit rows are opt-in per route via `audit_allowed_requests` (FR-16) — that flag is what keeps write volume bounded, so do not additionally add a buffering/batching or sampling layer to `audit.service.ts` for this event type on top of it. `proxy.request_denied` and auth-lifecycle events keep the existing synchronous, unconditional `writeAuditEvent` call.
- **No mTLS to upstreams (Open Question 3):** internal network trust is the boundary for gateway→upstream calls in v1 — do not add TLS client-cert configuration to `proxy.service.ts` / `http-proxy-middleware` without Security Engineering explicitly revisiting this decision first.

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/request-proxy-authorization.plan.md`*
