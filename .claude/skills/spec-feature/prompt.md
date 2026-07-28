# Skill: /spec-feature — Interview-First Feature Specification

## Usage
```
/spec-feature "description of the feature"
```

Examples:
```
/spec-feature "add refresh token reuse alerting to security audit log"
/spec-feature "implement SAML assertion signature validation for the SSO callback"
/spec-feature "add OAuth 2.0 token introspection endpoint"
```

---

## What This Skill Does

This skill runs a structured requirements interview and then produces a complete, approved-quality
feature specification document saved to `specs/[feature-name].spec.md`.

It does NOT write any code. It does NOT produce an implementation plan.
Its sole output is a specification document that a developer (or a subsequent AI session)
can use as the authoritative source of intent for implementation.

---

## Full Workflow Prompt

Execute the following steps in order. Do not skip steps. Do not combine steps.

---

### Step 1 — Announce What You Are Doing

Tell the user:

> I'm going to run a structured requirements interview for this feature. I'll ask a series of
> questions to draw out the full scope, edge cases, and non-functional requirements. After the
> interview, I'll draft the complete spec. Ready to start?
>
> Feature: **$ARGUMENTS**

Wait for confirmation before proceeding.

---

### Step 2 — Requirements Interview

Use the AskUserQuestion tool to run an in-depth interview. Ask the questions below in batches
of 2–3 at a time so the conversation remains manageable. Do not ask all questions at once.

Adapt the questions to the feature described. Skip questions that are clearly not applicable.
Add domain-specific questions when the feature makes them obvious (e.g., for a SAML feature,
ask about IdP metadata and clock skew tolerance; for an OAuth feature, ask about PKCE and
redirect URI allow-listing; for a rate-limiting feature, ask about the limiting key and window).

**Do not ask questions the user has already answered in the feature description.**

**Round 1 — Core Functionality**
- What is the primary action this feature enables, and who/what triggers it (end user, upstream service, background job)?
- What does success look like? What is the exact end state after the feature works?
- Are there multiple actor types involved (authenticated user, service-to-service client, admin)? Do they see or do different things?
- What data does this feature create, read, update, or delete? Where does that data live today (Postgres, Redis, JWT claims)?

**Round 2 — Contract and Data Impact**
- Does this require new or changed `/v1/*` endpoints? If so, sketch the high-level shape.
- Does this require a database schema change (new table, new column, new index) in `src/db/schema.ts`?
- Does this require a new or changed Redis key pattern (revocation, rate limit, session)?
- Does this touch JWT claims, JWKS publication, or key rotation (`JWT_KID` / `JWT_PREVIOUS_KID`)?

**Round 3 — Edge Cases and Error Conditions**
- What can go wrong? List the failure modes: invalid input, expired/replayed tokens, IdP unavailability, Redis outage, concurrent requests.
- What happens when the caller provides bad data? What error envelope and status code do they see?
- Are there race conditions possible (e.g., concurrent refresh token use — reuse detection)?

**Round 4 — Non-Functional Requirements**
- What request volume must this handle? (Requests/sec, concurrent sessions)
- What is the latency requirement?
- Does this feature touch authentication, authorisation, or PII? Any specific security constraint (see CLAUDE.md Security Rules)?
- Does this feature store or transmit PII? What are the retention/encryption requirements?
- Are there regulatory or compliance requirements?

**Round 5 — Scope Boundary**
- What is explicitly out of scope for this iteration?
- Are there dependencies on other in-progress work (e.g., SAML/OAuth phases currently stubbed as `501`)?
- Is there existing code or pattern that should be reused (e.g., existing JWKS rotation logic, existing audit event pattern)?
- Is there a target release or hard deadline driving scope decisions?

**Round 6 — Definition of Done**
- How will we demonstrate this feature is working? What does the acceptance demo look like?
- Who signs off that this feature is complete?
- Are there audit log or monitoring requirements (new `audit.service.ts` event types)?

After completing the interview, summarise back to the user what you have understood:

> Here is what I've captured. Please correct anything that's wrong or add anything missing
> before I write the spec.
>
> **Core purpose:** [one sentence]
> **Areas affected:** [routes / services / middleware / db / redis]
> **Key data changes:** [list]
> **Most important edge cases:** [list]
> **Non-functional constraints:** [list]
> **Out of scope:** [list]

Wait for the user to confirm or correct before proceeding to Step 3.

---

### Step 3 — Determine the Spec File Name

Derive a kebab-case file name from the feature description. Examples:
- "add refresh token reuse alerting to security audit log" → `refresh-token-reuse-alerting`
- "implement SAML assertion signature validation" → `saml-assertion-signature-validation`
- "add OAuth 2.0 token introspection endpoint" → `oauth2-token-introspection`

The full path will be: `specs/[feature-name].spec.md`

Tell the user the path before writing:
> I'll save the spec to `specs/[feature-name].spec.md`. Writing now...

---

### Step 4 — Write the Spec Document

Write the complete spec to `specs/[feature-name].spec.md` using EXACTLY the structure in
`specs/SPEC-TEMPLATE.md`. Do not abbreviate sections. Do not write placeholder content. Every
section must be fully populated from the interview. If a section genuinely does not apply,
write "N/A — [reason]" rather than omitting it.

Read `specs/SPEC-TEMPLATE.md` now and populate every section it defines: Overview, Functional
Requirements (FR-N), Non-Functional Requirements (NFR-N), Architecture Impact (Areas Affected /
API Changes / Data Model Changes / Zod Schema Changes), Out of Scope, Acceptance Criteria (AC-N),
Testing Strategy, Open Questions, Implementation Notes.

---

### Step 5 — Post-Write Checklist

After saving the spec, perform these checks:

1. Verify the file exists at `specs/[feature-name].spec.md`
2. Confirm every FR has at least one corresponding AC
3. Confirm all areas checked in Architecture Impact have corresponding content
4. Confirm the Testing Strategy covers unit and integration (or explicitly states why one is absent)
5. Count open questions — if more than 3 unresolved questions remain, warn the user that
   the spec may not be ready for approval

Report back to the user:

> ✅ Spec written to `specs/[feature-name].spec.md`
>
> **Quick stats:**
> - Functional requirements: N
> - Acceptance criteria: N
> - Areas affected: [list]
> - Open questions: N
>
> **Next steps:**
> 1. Review the spec and correct anything that's wrong
> 2. Get it approved (change Status from Draft to Approved)
> 3. Start a **fresh Claude session** and run `/plan` to generate the implementation plan
>
> ⚠️ Do not implement from this session — start fresh so the implementation session has
> clean context without anchoring bias from this planning conversation.

---

## Constraints for This Skill

- This skill ONLY produces a spec document. It does not write code, suggest implementation approaches, or produce a plan.
- Do not fill in placeholder text. Every section must contain real content from the interview.
- Do not invent requirements. Only document what was agreed in the interview.
- The spec is a living document. If the user corrects something during the review, update the spec before signing off.
- Ticket ID, author, and open question owners should be filled in by the user — leave TBD if not provided.
