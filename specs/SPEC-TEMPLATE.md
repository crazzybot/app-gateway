# Feature: [Feature Name]

<!-- GUIDANCE: Replace [Feature Name] with the canonical name used in the ticket tracker.
     Keep it short and noun-phrase: "Refresh Token Reuse Alerting", "SAML SSO Login".
     This filename should be: [kebab-case-name].spec.md -->

**Ticket:** [TICKET-ID or TBD]
**Status:** `Draft` <!-- Change to: Draft → In Review → Approved → Implemented -->
**Author:** [Name, Role]
**Reviewers:** [Reviewer names]
**Created:** YYYY-MM-DD
**Last Updated:** YYYY-MM-DD

---

## Overview

<!-- GUIDANCE: One paragraph (3–6 sentences) that answers three questions:
     1. What is this feature?
     2. Why does it exist — what business or user problem does it solve?
     3. Which parts of the gateway does it touch at a high level (auth, SSO, OAuth,
        proxy, rate limiting)?
     Do NOT list requirements here. This is a plain-English summary for any
     team member who needs quick context, including non-engineers. -->

[Write a concise paragraph describing the feature, its business value, and the
areas of the gateway it involves. Assume the reader knows the product but may not
know the detail of this feature.]

---

## Functional Requirements

<!-- GUIDANCE: List discrete, verifiable behaviours the system must exhibit.
     - Use FR-N numbering so acceptance criteria and tests can reference them.
     - Write each requirement as a SHALL statement from the system's perspective.
     - One requirement per line — avoid compound sentences with "and".
     - Do NOT include implementation detail here (not "use jose to verify", but
       "verify the token signature").
     - Flag dependencies between requirements with (→ FR-N). -->

- **FR-1:** The system SHALL [behaviour].
- **FR-2:** The system SHALL [behaviour].
- **FR-3:** The system SHALL [behaviour]. *(Depends on → FR-2)*
- **FR-4:** [Continue as needed — there is no minimum or maximum count.]

---

## Non-Functional Requirements

<!-- GUIDANCE: Measurable quality attributes the implementation must satisfy.
     Each NFR should be independently verifiable — include concrete numbers.
     Cover relevant categories: Performance, Security, Scalability, Availability,
     Compliance. Omit categories that genuinely do not apply — do not include
     boilerplate NFRs. -->

- **NFR-1 — Performance:** [e.g., "The P95 response time for [endpoint] SHALL be ≤ 300 ms under a load of 500 concurrent users."]
- **NFR-2 — Security:** [e.g., "All tokens SHALL expire after [duration] and SHALL be invalidated on logout / revocation."]
- **NFR-3 — Scalability:** [e.g., "The implementation SHALL support [N] concurrent sessions without a Redis capacity change."]
- **NFR-4 — Availability:** [e.g., "The feature SHALL degrade gracefully if Redis is unavailable, returning [fallback behaviour]."]
- **NFR-5 — Compliance:** [e.g., "PII fields SHALL be encrypted at rest per `ENCRYPTION_KEY` conventions in `src/utils/crypto.ts`."]

---

## Architecture Impact

<!-- GUIDANCE: This section drives migration planning and route/service design.
     "None" is a valid entry for any sub-section if it is truly unaffected. -->

### Areas Affected

<!-- GUIDANCE: This service is a single Express application — list which internal
     areas change rather than separate tiers. -->

| Area | Impact |
|------|--------|
| Routes (`src/routes/`) | [e.g., New `/v1/auth/...` route; modified request/response shape] |
| Services (`src/services/`) | [e.g., New service method; changed token issuance logic] |
| Middleware (`src/middleware/`) | [e.g., New validation middleware; auth guard change] |
| Database (`src/db/schema.ts`) | [e.g., New table; new column; new index] |
| Redis / cache | [e.g., New key pattern; new TTL policy] |

### API Changes

<!-- GUIDANCE: List every new, modified, or deprecated endpoint.
     NEVER change an API endpoint without first updating `specs/openapi.yaml`. -->

| Method | Path | Change Type | Notes |
|--------|------|-------------|-------|
| `POST` | `/v1/[resource]` | New | [Brief description] |
| `GET` | `/v1/[resource]/{id}` | Modified | [What changes — add field, change type] |
| `DELETE` | `/v1/[resource]/{id}` | Deprecated | [Replacement endpoint] |

### Data Model Changes

<!-- GUIDANCE: Describe schema additions or modifications in Drizzle terms.
     Include table name, new columns, indexes, and foreign key constraints.
     A reversible migration MUST be generated (`npm run db:generate`) before any
     schema.ts changes are considered final. -->

```
Table: [table_name]
  + [new_column]     [drizzle type]   [NULLABLE?]  [DEFAULT]   -- reason
  ~ [modified_col]   [old TYPE] → [new TYPE]                    -- reason
  + INDEX [idx_name] ON ([columns])                             -- query that requires it
```

### Zod Schema Changes

<!-- GUIDANCE: Request/response validation schemas in `src/schemas/` are hand-written
     (not generated) and must be kept in sync with `specs/openapi.yaml` manually.
     List new or changed schemas so implementation and review both check for drift. -->

- `[SchemaName]` — New schema for [purpose], in `src/schemas/[file].schemas.ts`
- `[ExistingSchema]` — Add field `[fieldName]: [zod type]`

---

## Out of Scope

<!-- GUIDANCE: Explicitly state what this feature does NOT include.
     This is as important as what it does include — it prevents scope creep
     during implementation and review. Be specific, not generic. -->

- **[Item 1]:** [One-sentence explanation of why it is excluded, or when it will be addressed.]
- **[Item 2]:** [e.g., "Admin UI for this feature — out of scope; this service has no UI tier."]
- **[Item 3]:** [e.g., "Support for [edge case] — deferred until usage data is available."]

---

## Acceptance Criteria

<!-- GUIDANCE: Acceptance criteria are the machine-verifiable definition of done.
     - Use Given/When/Then (GWT) format for behavioural criteria.
     - Number them AC-N so they can be directly referenced in tests and PR review.
     - Reference the FR they verify in brackets (→ FR-N).
     - Each AC must be independently testable — no compound criteria.
     - The /review skill will check each AC against the implementation. -->

- **AC-1 (→ FR-1):** Given [precondition], when [action], then [expected observable outcome].
- **AC-2 (→ FR-2):** Given [precondition], when [action], then [expected observable outcome].
- **AC-3 (→ FR-2):** Given [failure precondition], when [action], then [expected error handling].
- **AC-4 (→ FR-3):** Given [precondition], when [action], then [expected outcome with measurable threshold].
- **AC-5 (→ NFR-1):** Given [load condition], when [N concurrent requests are made], then [performance assertion].

<!-- Add as many ACs as needed. Err on the side of specificity.
     "The feature works" is not an acceptance criterion. -->

---

## Testing Strategy

<!-- GUIDANCE: Define what is tested at each layer. Claude generates tests from
     this strategy — the more specific you are here, the higher the test quality.
     Reference the nearest existing test file as a pattern baseline.
     Minimum coverage: ≥80% on new code (unit + branch). Every AC must have
     ≥1 integration test. -->

### Unit Tests

<!-- What logic units require isolated testing (mock ioredis / pg per project convention)? -->

- **[Service]:** Happy path, [error condition 1], [error condition 2], [edge case].

### Integration Tests

<!-- Which endpoints must be tested end-to-end through real Postgres + Redis
     (Testcontainers, per project convention)? Reference ACs. -->

- `[METHOD] /v1/[path]` — covers AC-1, AC-3. Test setup: [required fixtures/seed data].
- `[METHOD] /v1/[path]` — covers AC-2. Verify [side effect in DB, Redis, or audit log].

### Manual / Exploratory Testing Notes

<!-- GUIDANCE: Aspects that are hard to automate but must be verified by a human.
     Examples: real IdP SAML round-trip, real OAuth provider callback. -->

- [e.g., "Verify SAML redirect loop does not occur when the IdP session has expired."]

---

## Open Questions

<!-- GUIDANCE: List unresolved questions that MUST be answered before implementation begins.
     Assign an owner and a target resolution date. Remove this section when all questions
     are resolved — do not leave it populated in an Approved spec. -->

| # | Question | Owner | Due | Resolution |
|---|----------|-------|-----|------------|
| 1 | [Question] | [Name] | YYYY-MM-DD | *Pending* |
| 2 | [Question] | [Name] | YYYY-MM-DD | *Pending* |

---

## Implementation Notes

<!-- GUIDANCE: Optional. Use for important constraints, known gotchas, or
     references to prior art the implementer should read before starting.
     Keep this short — detailed implementation guidance belongs in the plan, not the spec. -->

- [e.g., "Follow the JWKS dual-key rotation pattern already used for JWT_KID / JWT_PREVIOUS_KID."]
- [e.g., "See `specs/app-gateway-auth.spec.md` for the existing token/session model this builds on."]

---

*Spec status transitions: **Draft** (author) → **In Review** (reviewers) → **Approved** (sign-off) → **Implemented** (post-merge)*
*For the implementation plan derived from this spec, see: `plans/[feature-name].plan.md`*
