# Runbook: JWT Signing Key Rotation (Zero-Downtime)

> Operational procedure for rotating the RS256/ES256 keypair used to sign
> access tokens. This is a **blocked operation** per `CLAUDE.md` — requires
> explicit human authorization at each deploy step, never run unattended.

## Why this procedure, not a single config swap

The gateway has no hot-reload for signing keys: `loadSigningKeys()`
(`src/utils/crypto.ts`) and the JWKS/verify-keyset caches
(`src/services/token.service.ts`) are populated once at process start and
never invalidated. Picking up a new key requires a restart of every replica.

Each replica also builds its JWKS document from its **own** local env vars —
there is no shared/centralized key store all instances read from. If you flip
`JWT_KID` to a new key and redeploy in one step, the fleet passes through a
state where some replicas sign with the new `kid` while others haven't
restarted yet and don't recognize it. A request signed by an already-rotated
replica and verified by a not-yet-rotated one gets wrongly rejected as
"unknown kid" — a spurious-401 window, not a clean rotation.

The fix is sequencing, not code: never let the *set of keys a replica knows
about* change discontinuously relative to its neighbors. The existing
active/previous two-slot mechanism (`JWT_KID` + `JWT_PREVIOUS_KID`) already
supports this if rolled out in three separate deploys.

## Preconditions

- New RSA/EC keypair generated and staged in the secrets manager / key mount
  (never write `.pem` files via Claude Code — this is a blocked operation;
  a human handles key material directly).
- New key has its own stable UUID `kid`, distinct from the current active and
  any currently-configured previous `kid`.
- Confirm no `kid` collision: check current `JWT_KID` / `JWT_PREVIOUS_KID` in
  the running environment before assigning the new one.

## Phase 1 — Pre-publish (verify-only)

Deploy with:
- `JWT_KID` / `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` — **unchanged**
  (still the current active key; it keeps signing).
- `JWT_PREVIOUS_KID` / `JWT_PREVIOUS_PUBLIC_KEY_PATH` — set to the **new**
  key (public key only; it does not sign yet).

Roll out to 100% of replicas and confirm completion before continuing —
partial rollout here is safe either way, since old signing behavior is
unchanged; the only risk is stopping before every replica has the new key
in its verify set.

**Verify:** `GET /v1/auth/.well-known/jwks.json` on every replica (or through
the LB enough times to sample all of them) returns both the current active
`kid` and the new `kid` in the `keys` array.

## Phase 2 — Cut over signing

Deploy with:
- `JWT_KID` / `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` — the **new**
  key (now active, signs new tokens).
- `JWT_PREVIOUS_KID` / `JWT_PREVIOUS_PUBLIC_KEY_PATH` — the **old** key
  (verify-only now).

Roll out to 100% of replicas. During this rollout every replica is in one of
two states — `{active: old, prev: new}` or `{active: new, prev: old}` — and
both states already know both keys, so it doesn't matter which replica
signed a given token or which replica verifies it.

**Verify:**
- JWKS still shows both keys, roles swapped (new is now primary, old is
  `JWT_PREVIOUS_KID`).
- Issue a fresh login/token and confirm its header `kid` matches the new key.
- Confirm tokens issued just before the rollout (old `kid`) still verify.

## Phase 3 — Retire the old key

Wait until every token signed with the old key is guaranteed expired:
`ACCESS_TOKEN_TTL_SECONDS` (default 900s) plus a safety margin for clock
skew and in-flight requests — 30–60 minutes is comfortable. Refresh tokens
are DB-backed rows (`refresh_tokens` table), not JWTs, so they are not
affected by signing-key rotation and need no separate handling here.

Deploy with:
- `JWT_KID` / paths — unchanged from Phase 2 (new key stays active).
- `JWT_PREVIOUS_KID` / `JWT_PREVIOUS_PUBLIC_KEY_PATH` — **unset**.

Roll out to 100% of replicas.

**Verify:** JWKS response contains only the new key. Old key material can
now be decommissioned in the secrets manager (separate, human-authorized
step — not part of this app deploy).

## Known gaps to account for

- **No automated rotation.** This is confirmed intentional —
  `specs/infrastructure-operations.spec.md` "Certificate Rotation
  Automation" explicitly scopes automated rotation out; this runbook is the
  manual substitute.
- **Spec/code drift on JWKS caching:** `specs/infrastructure-operations.spec.md`
  NFR-8 describes the in-process JWKS cache as "refreshed every 60 minutes,"
  but there is no such refresh in `src/services/token.service.ts` — the
  cache (`cachedJwksDocument`, `cachedVerifyKeySet`) is populated once and
  held for the life of the process, full stop. Do not rely on a 60-minute
  self-heal; every phase above requires an actual restart/redeploy of every
  replica to take effect. Worth reconciling the spec text with reality, or
  adding the refresh, in a separate ticket.
- **Only one previous-key slot.** You cannot pre-publish a *next* key while
  a *previous* key is still being retired — Phase 1 of a new rotation can't
  start until Phase 3 of the last one has completed. Plan rotation cadence
  accordingly.
- **Static file mount, not KMS.** `specs/infrastructure-operations.spec.md`
  Open Question 1 (key material: static file mount vs. KMS/DB-backed) is
  still marked *Pending* with Security Engineering. If that lands on KMS,
  this runbook's phase structure still applies, but "deploy with new env
  vars" becomes "deploy with a new KMS key reference."

## Rollback

If Phase 2 verification fails (e.g., new key can't sign, or clients report
verification failures), revert to the Phase 1 config (`JWT_KID` = old,
`JWT_PREVIOUS_KID` = new) and redeploy — this is safe at any point since
Phase 1 never stopped the old key from signing. Do not attempt rollback
*during* Phase 3 without re-adding the old key to `JWT_PREVIOUS_KID` first,
since tokens signed in the tail of Phase 2 may still be unexpired.
