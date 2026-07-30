# Feature: Vault Transit KEK Migration

**Ticket:** TBD
**Status:** `Approved`
**Author:** Alexei Pogrebtsov
**Reviewers:** TBD
**Created:** 2026-07-30
**Last Updated:** 2026-07-30

---

## Overview

The gateway encrypts PII (`users.email`) at rest using per-tenant data-encryption keys (DEKs),
which are themselves wrapped by a single key-encrypting key (KEK) before being persisted in
`tenant_encryption_keys.wrapped_dek`. Today that KEK is derived from a static `ENCRYPTION_KEY`
environment variable — explicitly documented in `src/utils/crypto.ts` as a local-dev substitute
for a real KMS. This feature migrates the KEK's backing store to HashiCorp Vault's Transit
secrets engine, running as shared infrastructure in the same Kubernetes cluster as app-gateway.
App-gateway authenticates to Vault via its own Kubernetes ServiceAccount (Vault's `kubernetes`
auth method) and calls Transit's `encrypt`/`decrypt` operations against a Transit key dedicated
to app-gateway, instead of performing AES-256-GCM locally. The per-tenant DEK model — generation,
the `key_version` envelope scheme, and the in-process DEK LRU cache in
`src/services/tenantKey.service.ts` — is entirely unchanged; only where the KEK operation
executes and what backs it changes. A `KEK_BACKEND` config switch keeps the existing local-AES
path available for environments without Vault (local dev/test), defaulting to Vault in
staging/production.

---

## Functional Requirements

- **FR-1:** The system SHALL support two KEK backend implementations — `local` (existing AES-256-GCM
  under `ENCRYPTION_KEY`) and `vault` (HashiCorp Vault Transit) — selected by a `KEK_BACKEND`
  config value.
- **FR-2:** When `KEK_BACKEND=vault`, `wrapDek` SHALL call Vault Transit's `encrypt` operation
  against a single named Transit key acting as the KEK, and return Vault's ciphertext string
  unmodified for storage in `tenant_encryption_keys.wrapped_dek`.
- **FR-3:** When `KEK_BACKEND=vault`, `unwrapDek` SHALL call Vault Transit's `decrypt` operation
  against the same Transit key and return the raw DEK bytes. *(Depends on → FR-2)*
- **FR-4:** The system SHALL authenticate to Vault using the Kubernetes auth method, presenting
  app-gateway's own projected ServiceAccount token to Vault's `auth/kubernetes/login` endpoint to
  obtain a Vault client token.
- **FR-5:** The system SHALL cache the Vault client token in-process and proactively renew it
  before its lease expires, rather than re-authenticating on every Transit call. *(Depends on → FR-4)*
- **FR-6:** The system SHALL retry a failed Vault Transit call (network error or 5xx response)
  with bounded exponential backoff before surfacing failure to the caller.
- **FR-7:** When a Vault Transit call exhausts its retries, the system SHALL raise a specific
  `AppError` subclass (e.g. `KeyManagementError`) that propagates through the existing
  `Result<T, AppError>` convention to `provisionActiveKey`, `unwrapAndCache`, and
  `rotateTenantKey` in `tenantKey.service.ts`. *(Depends on → FR-6)*
- **FR-8:** The system SHALL emit a structured audit event (`kek_operation_failed`) via
  `audit.service.ts` when a Vault wrap/unwrap call exhausts retries, referencing `tenantKeyId`
  and `keyVersion` only — never the DEK or any plaintext. *(Depends on → FR-7)*
- **FR-9:** The per-tenant DEK generation, `key_version` envelope format
  (`encryptWithDek`/`decryptWithDek`/`parseDekCiphertextEnvelope`), and the in-process
  `BoundedLru` DEK cache in `tenantKey.service.ts` SHALL remain functionally unchanged by this
  migration.
- **FR-10:** KEK rotation (rotating the Vault Transit key itself) SHALL rely on Vault Transit's
  native key versioning (`vault write -f transit/keys/<key>/rotate`) rather than any new
  application-level bookkeeping; this is independent of the existing per-tenant
  `tenant_encryption_keys.key_version` column.

---

## Non-Functional Requirements

- **NFR-1 — Performance:** No new hard latency budget is set for the Vault round-trip itself.
  The existing in-process DEK LRU cache (`tenantKey.service.ts`) absorbs steady-state request
  latency — Vault is only called on a DEK cache miss, first provisioning, or rotation, not on
  every encrypt/decrypt of PII.
- **NFR-2 — Security:** The Vault client token SHALL never be logged, even partially. Vault
  Transit ciphertext strings are not secret-equivalent to plaintext DEKs and may appear in
  `tenant_encryption_keys.wrapped_dek` as today, but raw DEK bytes and the Vault client token
  SHALL never be logged (per CLAUDE.md Security Rule 1, extended to this new secret type).
- **NFR-3 — Availability:** If Vault is unreachable, already-cached DEKs (per `BoundedLru`)
  SHALL continue to serve encrypt/decrypt operations unaffected. Only DEK cache misses, new
  tenant provisioning, and explicit rotation SHALL fail (as `KeyManagementError`) while Vault is
  down.
- **NFR-4 — Compliance:** The at-rest encryption guarantee for `users.email` (NFR-6 of the prior
  spec) is unchanged in strength or scope — this migration changes KEK custody (from a static env
  var to Vault-managed, audit-logged, HSM-backable key storage) without altering what is
  encrypted or how.

---

## Architecture Impact

### Areas Affected

| Area | Impact |
|------|--------|
| Utils (`src/utils/crypto.ts`) | `wrapDek`/`unwrapDek` become backend-dispatching (branch on `KEK_BACKEND`); both become `async` where they are not already |
| Services (`src/services/`) | New `src/services/vaultTransit.service.ts` — Kubernetes-auth login, token cache/renewal, Transit encrypt/decrypt calls with retry/backoff |
| Services (`src/services/tenantKey.service.ts`) | `await` ripple only at existing `wrapDek`/`unwrapDek` call sites in `provisionActiveKey`, `unwrapAndCache`, `rotateTenantKey` — no logic change |
| Services (`src/services/audit.service.ts`) | New `kek_operation_failed` event type |
| Config (`src/config/env.ts`) | New Zod-validated vars: `KEK_BACKEND`, `VAULT_ADDR`, `VAULT_TRANSIT_KEY_NAME`, `VAULT_K8S_AUTH_ROLE` |
| Middleware (`src/middleware/`) | None |
| Routes (`src/routes/`) | None — no new/changed endpoints |
| Database (`src/db/schema.ts`) | None — `tenant_encryption_keys.wrapped_dek` keeps its existing `text` shape; it stores a Vault ciphertext string instead of a local-AES blob when `KEK_BACKEND=vault` |
| Redis / cache | None — the DEK cache remains in-process only, per existing design; no Redis involvement introduced |

### API Changes

None. This feature has no `/v1/*` route surface.

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| N/A | N/A | N/A | No API changes — internal KEK backend swap only |

### Data Model Changes

None.

```
Table: tenant_encryption_keys
  (no column/type/index changes — wrapped_dek's stored value format changes
   from a local-AES blob to a Vault Transit ciphertext string when
   KEK_BACKEND=vault, but the column remains `text`)
```

### Zod Schema Changes

- `envSchema` (in `src/config/env.ts`) — add:
  - `KEK_BACKEND: z.enum(['local', 'vault'])`, default `'local'` in dev/test, required explicit
    `'vault'` in production per deployment config
  - `VAULT_ADDR: z.string().url()` — required when `KEK_BACKEND === 'vault'`
  - `VAULT_TRANSIT_KEY_NAME: z.string()` — required when `KEK_BACKEND === 'vault'`
  - `VAULT_K8S_AUTH_ROLE: z.string()` — required when `KEK_BACKEND === 'vault'`
  - Conditional requirement enforced via `.superRefine` (mirroring the existing
    `JWT_PREVIOUS_KID`/`JWT_PREVIOUS_PUBLIC_KEY_PATH` pairing pattern already in `env.ts`)

---

## Out of Scope

- **Vault HA/multi-node deployment:** This spec assumes a single-node (or externally managed)
  Vault instance is already running in the cluster. Raft clustering, auto-unseal, and
  multi-region Vault topology are not addressed.
- **Vault init/unseal automation:** The initial `vault operator init`/`unseal` ceremony is a
  manual, documented operational step — not automated as part of this feature.
- **Re-wrapping existing DEKs:** Rows in `tenant_encryption_keys` already wrapped under the local
  AES KEK are NOT re-wrapped under the Vault KEK by this feature. A backfill/re-wrap migration is
  a separate future effort if the local-KEK-wrapped rows need to move to Vault.
- **Vault Agent sidecar / auto-auth injector:** This feature uses direct Vault HTTP API calls
  with a hand-rolled Kubernetes-auth login, not the Vault Agent injector or its auto-auth
  templating.
- **Granting other services access to Vault or tenant DEKs:** This migration is scoped entirely
  to app-gateway's own KEK. Any future work letting upstream/other services read tenant DEKs or
  call Vault directly is a separate, unscoped effort.
- **KEK rotation triggering/scheduling:** Vault Transit's native versioning makes rotation
  possible, but no automated rotation schedule or trigger endpoint is added by this feature.

---

## Acceptance Criteria

- **AC-1 (→ FR-1):** Given `KEK_BACKEND=local` in the environment, when the gateway starts and a
  tenant DEK is provisioned, then `wrapDek`/`unwrapDek` execute local AES-256-GCM exactly as
  today, with no Vault calls made.
- **AC-2 (→ FR-2, FR-3):** Given `KEK_BACKEND=vault` and a reachable Vault instance, when a new
  tenant's DEK is provisioned via `getActiveDek`, then `wrapDek` calls Vault Transit `encrypt`
  and the returned ciphertext is persisted in `tenant_encryption_keys.wrapped_dek`, and a
  subsequent `unwrapDek` call via Vault Transit `decrypt` returns the original raw DEK bytes
  byte-for-byte.
- **AC-3 (→ FR-4, FR-5):** Given the gateway pod has a valid Kubernetes ServiceAccount token,
  when the first Vault Transit call is made, then the gateway successfully authenticates via
  `auth/kubernetes/login` and caches the returned client token; a second Transit call made before
  the token's lease expires SHALL NOT trigger a second login call.
- **AC-4 (→ FR-5):** Given a cached Vault client token nearing lease expiry (within the renewal
  buffer), when a Transit call is made, then the gateway re-authenticates and refreshes the
  cached token before making the Transit call.
- **AC-5 (→ FR-6, FR-7):** Given Vault is unreachable, when `wrapDek` or `unwrapDek` is called
  under `KEK_BACKEND=vault`, then the system retries with bounded exponential backoff and, after
  exhausting retries, rejects with `KeyManagementError` (or equivalent `AppError` subclass).
- **AC-6 (→ NFR-3):** Given a DEK is already present in the in-process `BoundedLru` cache, when
  Vault becomes unreachable, then `encryptEmail`/`decryptEmail` for that tenant/key_version
  continue to succeed without any Vault call.
- **AC-7 (→ FR-8):** Given a Vault Transit call exhausts retries, when the failure is raised, then
  a `kek_operation_failed` audit event is recorded via `audit.service.ts` containing
  `tenantKeyId` and `keyVersion`, and containing neither the DEK nor any plaintext.
- **AC-8 (→ FR-9):** Given `KEK_BACKEND` is switched from `local` to `vault` (or vice versa),
  when `encryptWithDek`/`decryptWithDek`/`parseDekCiphertextEnvelope` are exercised, then their
  behavior and the `key_version`-prefixed envelope format are unchanged — only `wrapDek`/`unwrapDek`
  differ.
- **AC-9 (→ NFR-2):** Given any Vault Transit call (successful or failed) is logged, when log
  output is inspected, then the Vault client token and raw DEK bytes never appear, even partially.

---

## Testing Strategy

### Unit Tests

- **`vaultTransit.service.ts`:** Happy path (login → cache token → encrypt/decrypt succeed),
  token renewal before expiry, retry-then-succeed on transient failure, retry exhaustion raising
  `KeyManagementError`, token never appearing in thrown errors or logs. Mock `fetch` (or the HTTP
  client used) directly — no real network calls, matching the project's `vi.mock` convention for
  external I/O.
- **`crypto.ts` (`wrapDek`/`unwrapDek`):** Backend dispatch on `KEK_BACKEND` — `local` path
  exercises existing AES-256-GCM logic unchanged; `vault` path delegates to a mocked
  `vaultTransit.service.ts`.
- **`tenantKey.service.ts`:** Existing test suite re-run unchanged (per FR-9) plus new cases:
  `provisionActiveKey`/`rotateTenantKey`/`unwrapAndCache` propagate `KeyManagementError` when the
  (mocked) KEK backend rejects.
- **`env.ts`:** Conditional validation — `KEK_BACKEND=vault` without `VAULT_ADDR`/
  `VAULT_TRANSIT_KEY_NAME`/`VAULT_K8S_AUTH_ROLE` fails startup validation with a clear error;
  `KEK_BACKEND=local` does not require those vars.

### Integration Tests

- **Vault wrap/unwrap round-trip** — covers AC-2, AC-8. Test setup: real Vault dev-mode container
  via Testcontainers (`vault` image), Transit engine enabled, a test Transit key created; verify
  a DEK wrapped and unwrapped through the real Vault API matches the original bytes, and the
  `key_version` envelope produced by `encryptWithDek` is unaffected by which KEK backend wrapped
  the DEK.
- **Kubernetes-auth login flow** — covers AC-3, AC-4. Test setup: Vault Testcontainer with
  Kubernetes auth method enabled and a test role configured against a stubbed/test JWT; verify
  token caching avoids redundant logins and renews correctly near expiry.
- **Vault unreachable / retry exhaustion** — covers AC-5, AC-6, AC-7. Test setup: point
  `VAULT_ADDR` at an unreachable address (or stop the Testcontainer mid-test); verify
  retry-then-fail behavior, that a warm DEK cache entry still serves encrypt/decrypt, and that
  the `kek_operation_failed` audit event is recorded with the expected fields and no
  plaintext/DEK content.

### Manual / Exploratory Testing Notes

- Deploy to the local Kubernetes cluster with `KEK_BACKEND=vault`; provision a tenant DEK; restart
  the app-gateway pod; confirm a subsequent decrypt of that tenant's `users.email` still succeeds
  (proves the wrapped DEK persisted correctly and the pod can re-authenticate to Vault after
  restart).
- Manually rotate the Vault Transit key (`vault write -f transit/keys/<key>/rotate`) and confirm
  DEKs wrapped before the rotation still unwrap successfully (Vault serves old key versions for
  decrypt automatically).

---

## Open Questions

*None — all decisions were resolved during the requirements interview.*

---

## Implementation Notes

- `ENCRYPTION_KEY`'s role as the local KEK substitute (documented in the header comment of
  `src/utils/crypto.ts`) becomes the `KEK_BACKEND=local` path — do not remove it, only branch
  around it.
- Vault Transit ciphertext strings already embed Vault's own key version (`vault:v1:...`) — do
  not introduce a second, redundant version prefix for the Vault path; the existing
  `key_version` column/prefix in `tenant_encryption_keys` and `encryptWithDek`'s envelope refer
  to the per-tenant DEK's version, which is orthogonal to Vault's internal Transit key version.
- Follow the existing conditional-env-var pairing pattern already used for
  `JWT_PREVIOUS_KID`/`JWT_PREVIOUS_PUBLIC_KEY_PATH` in `env.ts` when adding the Vault-conditional
  vars.
- This touches `src/utils/crypto.ts` and `src/services/tenantKey.service.ts`, both PII/crypto
  code — the `security-reviewer` subagent must review before merge, per CLAUDE.md.

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/vault-transit-kek-migration.plan.md`*
