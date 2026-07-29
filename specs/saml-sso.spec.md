# Feature: SAML 2.0 Enterprise SSO

**Ticket:** AGW-001-SAML (split from AGW-001)
**Status:** `Approved`
**Author:** Platform Architecture Team
**Reviewers:** Security Engineering, Backend Platform, QA Lead
**Created:** 2026-07-01
**Last Updated:** 2026-07-28

---

## Overview

This feature lets tenant organizations authenticate their users through their own SAML 2.0 Identity Provider (Okta, Azure Active Directory, or Google Workspace) instead of the gateway's own password store. It covers SP metadata publication, both SP-initiated and IdP-initiated login flows, assertion validation and account provisioning/linking, and Single Logout (SLO). On successful authentication the gateway issues the same JWT access/refresh token pair described in `core-jwt-authentication.spec.md`, so downstream proxy and audit behavior is unchanged — only the credential-verification step differs. It touches `src/services/saml.service.ts`, the `saml_configurations` table, and the SAML-related fields on `users`.

---

## Functional Requirements

- **FR-6 — Service Provider Metadata Publication:** The system SHALL generate and serve a valid SAML 2.0 Service Provider metadata XML document at `GET /v1/auth/saml/{tenant}/metadata` for each tenant that has an active `saml_configurations` record. The metadata SHALL include the SP entity ID (formatted as `{gatewayBaseUrl}/saml/{tenant}`), the Assertion Consumer Service URL (`POST /v1/auth/saml/{tenant}/callback`), the Single Logout Service URL (`POST /v1/auth/saml/{tenant}/logout`), the SP's X.509 certificate for assertion encryption and signature verification, and a `NameIDFormat` of `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`. The `Content-Type` response header SHALL be `application/xml`. Metadata SHALL be re-generated on each request (not statically cached) to reflect current certificate rotations.
- **FR-7 — IdP-Initiated & SP-Initiated SSO Flow:** The system SHALL support SP-initiated SSO by accepting `GET /v1/auth/saml/{tenant}/initiate`, constructing a signed SAML `AuthnRequest` using the tenant's IdP configuration from `saml_configurations`, encoding it as a URL-encoded base64 DEFLATE string (HTTP-Redirect binding), and returning a `302 Found` redirect to the IdP's SSO URL. The `RelayState` parameter SHALL carry a short-lived (5-minute), HMAC-SHA256-signed opaque state token encoding the original requested resource URL so that users can be redirected post-authentication. The system SHALL also support IdP-initiated flows where the IdP POSTs an assertion without a prior `AuthnRequest`; in this case `RelayState` processing SHALL be skipped.
- **FR-8 — SAML Assertion Consumption & Account Linking:** The system SHALL accept `POST /v1/auth/saml/{tenant}/callback`, validate the received SAML Response using `passport-saml` including: XML signature verification against the IdP's X.509 certificate stored in `saml_configurations.idp_certificate`, `Conditions` element `NotBefore`/`NotOnOrAfter` time validation (tolerance ≤ 30 s), `AudienceRestriction` check against the SP entity ID, and `InResponseTo` correlation when the flow is SP-initiated. Upon successful validation the system SHALL extract `nameID` (email) and mapped attribute claims (first name, last name, groups/roles per tenant attribute mapping). The system SHALL look up the `users` table by `email`; if no record exists it SHALL auto-provision a new user record with `auth_source = 'saml'` and `tenant_id` set. The system SHALL then issue a standard JWT access token + refresh token pair (→ FR-1, `core-jwt-authentication.spec.md`) and either redirect to the `RelayState` URL (SP-initiated) or to the platform default landing URL (IdP-initiated), passing the tokens as short-lived secure HttpOnly cookies or as query parameters depending on the client type indicated in `RelayState`.
- **FR-9 — SAML Account Linking:** The system SHALL support linking an existing password-authenticated user account to a SAML identity. When a SAML assertion is received for an email that already exists in `users` with `auth_source = 'password'`, the system SHALL set `users.saml_name_id` and `users.tenant_id` on the existing record without creating a duplicate user, and SHALL record the link event in `audit_log`. Subsequent logins via that SAML IdP SHALL resolve to the same `users` record. The system SHALL NOT allow linking a SAML identity to an account already linked to a different SAML `nameID` unless the previous `saml_name_id` is explicitly unlinked by an administrator via a separate admin API (out of scope for this spec).
- **FR-10 — SAML Single Logout (SLO):** The system SHALL accept `POST /v1/auth/saml/{tenant}/logout` and process SAML `LogoutRequest` messages received from the IdP. The system SHALL revoke all active refresh tokens for the resolved user, add all outstanding access token `jti`s associated with that user's active sessions to the Redis revocation set (→ FR-23), and return a valid SAML `LogoutResponse` to the IdP. The system SHALL also support SP-initiated logout by constructing and sending a SAML `LogoutRequest` to the IdP's SLO endpoint when a user with an active SAML session calls `POST /v1/auth/logout`.

---

## Non-Functional Requirements

- **NFR-5 — Security (partial, cryptographic failures — OWASP A02):** SAML assertions SHALL be rejected unconditionally if unsigned or if signature verification against the IdP's X.509 certificate fails.
- **NFR-1 — Performance (partial):** SAML metadata and initiate endpoints are excluded from the strict auth-endpoint latency budget (they involve external IdP round trips) but SHALL still respond within the gateway's own processing time in line with the general `/v1/auth/*` P95 ≤ 150 ms target for gateway-local work only.

---

## Architecture Impact

### Areas Affected

| Area | Impact |
|------|--------|
| Routes (`src/routes/auth.router.ts`) | New SAML sub-routes: metadata, initiate, callback, logout |
| Services (`src/services/saml.service.ts`) | `[not yet implemented]` — SAML assertion parsing, session/account linking, metadata generation |
| Services (`src/services/user.service.ts`) | Auto-provisioning and account-linking lookups by email |
| Services (`src/services/audit.service.ts`) | Writes `saml.sso_initiated`, `saml.assertion_received`, `saml.sso_failed`, `saml.slo_received`, `saml.account_linked` events |
| Database (`src/db/schema.ts`) | New table `saml_configurations`; consumes existing `users.saml_name_id`, `users.tenant_id`, `users.auth_source` (added in `core-jwt-authentication.spec.md`) |
| Auth dependency | Passport + `passport-saml` strategy registration |

### API Changes

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| `GET` | `/v1/auth/saml/:tenant/initiate` | New | Begin SP-initiated SAML SSO; redirects to IdP |
| `POST` | `/v1/auth/saml/:tenant/callback` | New | Consume SAML assertion; issue JWT pair |
| `GET` | `/v1/auth/saml/:tenant/metadata` | New | Serve SP SAML metadata XML |
| `POST` | `/v1/auth/saml/:tenant/logout` | New | Process SAML SLO request/response |

### Data Model Changes

```
Table: saml_configurations (NEW)
  id                UUID PK DEFAULT gen_random_uuid()
  tenant_id         UUID NOT NULL UNIQUE
  tenant_slug       TEXT NOT NULL UNIQUE      -- URL-safe slug used in /saml/{tenant}/*
  idp_entity_id     TEXT NOT NULL
  idp_sso_url       TEXT NOT NULL
  idp_slo_url       TEXT
  idp_certificate   TEXT NOT NULL             -- PEM-encoded X.509 cert
  sp_certificate    TEXT NOT NULL             -- PEM-encoded X.509 cert
  sp_private_key    TEXT NOT NULL             -- PEM-encoded private key (encrypted at rest)
  attribute_mapping JSONB NOT NULL DEFAULT '{}'   -- maps IdP attributes to platform fields
  auto_provision    BOOLEAN NOT NULL DEFAULT TRUE
  is_active         BOOLEAN NOT NULL DEFAULT TRUE
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  + INDEX idx_saml_config_tenant_slug ON (tenant_slug)

Table: users (existing, defined in core-jwt-authentication.spec.md)
  -- consumed here: saml_name_id, tenant_id, auth_source
  + INDEX idx_users_tenant_saml ON (tenant_id, saml_name_id)   -- already defined; used by FR-8/FR-9 lookups
```

### Zod Schema Changes

- `SamlInitiateQuerySchema` — `{ redirect_to?: string (url) }`, new file `src/schemas/saml.schemas.ts`
- `SamlCallbackBodySchema` — raw SAML Response passthrough validated by `passport-saml`, not hand-validated by Zod (external IdP payload); tenant param validated via `SamlTenantParamSchema`
- `SamlTenantParamSchema` — `{ tenant: string (slug) }`, new file `src/schemas/saml.schemas.ts`

---

## Out of Scope

- **Admin API to unlink a SAML identity:** Referenced in FR-9 as a prerequisite for re-linking a conflicting `nameID`; not implemented in this spec.
- **Certificate Rotation Automation:** Admins must manually update SAML SP/IdP certificates in `saml_configurations`. Automated rotation is out of scope.
- **OpenID Connect (OIDC) Provider:** Not a substitute for or alternative to this SAML flow; planned separately for AGW-003.

---

## Acceptance Criteria

- **AC-10 (→ FR-6):** Given a tenant with an active `saml_configurations` record with slug `"acme"`, when a GET request is sent to `/v1/auth/saml/acme/metadata`, then the response SHALL be `200 OK` with `Content-Type: application/xml`; the body SHALL be valid SAML 2.0 SP metadata XML containing the SP entity ID, ACS URL, SLO URL, and X.509 certificate.
- **AC-11 (→ FR-6):** Given a tenant slug that does not exist in `saml_configurations`, when a GET request is sent to `/v1/auth/saml/nonexistent/metadata`, then the response SHALL be `404 Not Found` with `{"error": "tenant_not_found"}`.
- **AC-12 (→ FR-7):** Given a tenant with an active SAML configuration, when a GET request is sent to `/v1/auth/saml/acme/initiate` with an optional `redirect_to` query parameter, then the response SHALL be `302 Found` redirecting to the IdP's SSO URL with valid `SAMLRequest` (URL-encoded DEFLATE) and `RelayState` query parameters; the `RelayState` SHALL be an HMAC-signed state token.
- **AC-13 (→ FR-8):** Given a valid SAML Response posted to `/v1/auth/saml/acme/callback` by a trusted IdP, when the assertion passes all validation checks (signature, conditions, audience, timing), then the system SHALL issue a JWT access token and refresh token; if the user email does not exist in `users` a new record SHALL be created; an `audit_log` entry with `event_type: "saml.assertion_received"` and `outcome: "success"` SHALL be written.
- **AC-14 (→ FR-8):** Given a SAML Response with an invalid signature, when it is posted to `/v1/auth/saml/acme/callback`, then the response SHALL be `401 Unauthorized`; an `audit_log` entry with `event_type: "saml.sso_failed"` and `outcome: "failure"` SHALL be written; no user account SHALL be created or modified.
- **AC-15 (→ FR-9):** Given an existing user authenticated via password (`auth_source = "password"`), when that user's email is received in a valid SAML assertion for tenant "acme", then the existing `users` record SHALL be updated with `saml_name_id` and `tenant_id`; no duplicate user record SHALL be created; an `audit_log` entry with `event_type: "saml.account_linked"` SHALL be written.
- **AC-16 (→ FR-10):** Given a user with an active SAML session, when the IdP sends a SAML `LogoutRequest` to `/v1/auth/saml/acme/logout`, then all active refresh tokens for that user SHALL be revoked; outstanding JTIs SHALL be added to the Redis revocation set; a valid SAML `LogoutResponse` SHALL be returned to the IdP.

---

## Testing Strategy

### Unit Tests

| Test Suite | File Path | Key Scenarios |
|---|---|---|
| `SamlService` | `src/services/__tests__/saml.service.test.ts` | Build SP metadata XML; generate `AuthnRequest` redirect URL; validate well-formed SAML assertion; reject assertion with bad signature; reject expired assertion (`NotOnOrAfter`); auto-provision new user; link SAML to existing user; handle SLO request and revoke sessions |

### Integration Tests

- `GET /v1/auth/saml/:tenant/metadata` — covers AC-10, AC-11 (valid tenant, missing tenant).
- `GET /v1/auth/saml/:tenant/initiate` — covers AC-12 (redirect, `RelayState`).
- `POST /v1/auth/saml/:tenant/callback` — covers AC-13, AC-14 (valid assertion mock, invalid signature).
- `POST /v1/auth/saml/:tenant/logout` — covers AC-16.
- File path: `src/__tests__/integration/saml.test.ts`

### Manual / Exploratory Testing Notes

These tests MUST be executed manually against real Identity Provider sandboxes before production deployment. Results SHALL be documented in a test evidence log.

| Test Case | IdP | Steps | Expected Outcome |
|---|---|---|---|
| Okta SP-Initiated SSO | Okta Developer | Configure SAML app in Okta; set ACS URL; trigger login from gateway; complete Okta MFA; observe redirect | JWT tokens issued; user provisioned in DB; audit log entry present |
| Azure AD SP-Initiated SSO | Azure AD Free Tenant | Register enterprise app; configure SAML; add test user; trigger SP-initiated flow | JWT tokens issued; roles mapped from Azure AD groups attribute |
| Google Workspace SSO | Google Workspace | Configure custom SAML app; set attributes (email, firstName, lastName); initiate SSO | JWT tokens issued; name attributes mapped correctly |
| Okta IdP-Initiated SSO | Okta Developer | Assign SAML app to user; click app tile in Okta dashboard (IdP-initiated); observe POST to callback URL | JWT tokens issued without `RelayState`; user redirected to default platform URL |
| SAML SLO from IdP | Okta Developer | Log in via Okta; log out from Okta dashboard; verify SLO request received by gateway | All active sessions for user revoked; `LogoutResponse` sent to Okta |
| Expired IdP Certificate | Any | Configure an expired X.509 certificate in `saml_configurations`; attempt SSO | Login fails with 401; audit log entry with `saml.sso_failed`; no user created |
| Clock Skew Test | Any | Manually craft SAML assertion with `NotBefore` 25 seconds in the future | Assertion accepted (within 30s tolerance); assertion 40s in future → rejected |

E2E automation counterpart: **SAML SSO Full Flow** — a test IdP (`saml-idp` npm package or Wiremock SAML stub) posts a valid assertion to `/v1/auth/saml/test-tenant/callback`; gateway issues JWT pair; tokens are used to call a proxy route; upstream stub receives correct identity headers (`src/__tests__/e2e/`).

---

## Open Questions

| # | Question | Owner | Due | Resolution |
|---|----------|-------|-----|------------|
| 1 | What is the expected maximum number of concurrent SAML tenants? Affects whether `saml_configurations` lookup should be cached in Redis or served directly from Postgres. | Platform Architecture | Sprint 1 | *Pending* |

---

## Implementation Notes

- Token issuance on successful assertion validation reuses `TokenService` from `core-jwt-authentication.spec.md` (FR-1) unchanged — SAML only supplies the `sub`/`email`/`roles`/`auth_method: "saml"` inputs.
- See `specs/app-gateway-auth.spec.md` for the original, unsplit specification this document was derived from.

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/saml-sso.plan.md`*
