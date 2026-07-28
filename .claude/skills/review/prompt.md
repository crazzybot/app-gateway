# Skill: /review — Adversarial Spec-Compliance Review

## Usage
```
/review
```

Run this command when implementation is complete, before creating a PR. No arguments required.
The skill identifies the relevant spec automatically from the current branch and changed files.

This skill intentionally uses an adversarial posture: it assumes the implementation is
wrong until it finds evidence that it is correct. It does not accept "this looks right"
— it requires verifiable evidence for every acceptance criterion.

---

## What This Skill Does

This skill spawns a review subagent that:
1. Reads the feature spec from `specs/` independently (without the writer's reasoning chain)
2. Examines the implementation diff against every acceptance criterion
3. Checks the Definition of Done from `CLAUDE.md`
4. Produces a structured review report with PASS/FAIL/UNTESTABLE for each item
5. Runs the specialist subagents (security, performance, API contract) as needed

The review is conducted in a **fresh reasoning context**. The review subagent does not
inherit the implementation reasoning that led to the current code — it evaluates the
output against the specification as a neutral auditor.

---

## Full Workflow Prompt

Execute the following steps in order. Announce each step before executing it.

---

### Step 1 — Orient the Review

Gather context to scope the review correctly.

**1a — Identify the feature and spec**

```bash
git branch --show-current
```

Extract the feature name from the branch name (e.g., `feature/refresh-token-reuse-alerting`,
or `feature/TICKET-ID-description` if a ticket prefix is used).

```bash
ls specs/*.spec.md
```

Find and read the spec file for this feature (ignore `SPEC-TEMPLATE.md` and, unless the change
is explicitly about the base auth design, `app-gateway-auth.spec.md`). If multiple specs exist,
identify the most relevant one from the feature name. If no spec file exists:

> ⚠️ **No spec found for this feature.**
> Proceeding with a structural review only — without a spec, acceptance criteria cannot be verified.
> This is a governance gap: every feature should have a spec before implementation.
> Recommend creating the spec retroactively with `/spec-feature`.

**1b — Get the diff scope**

```bash
git diff origin/main..HEAD --stat
```

List all changed files. Identify what the primary changed components are (routes, services,
middleware, schema, tests). This defines the review scope.

```bash
git diff origin/main..HEAD
```

Read the full diff. This is the implementation being reviewed.

**1c — Read the Definition of Done**

Read `CLAUDE.md` and extract the Definition of Done checklist. Every item in the DoD
will be evaluated in Step 4.

Announce the review scope:
> **Review scope:**
> - Spec: `specs/[feature-name].spec.md`
> - Functional requirements: N
> - Acceptance criteria: N
> - Files changed: N (Routes: N | Services: N | Middleware: N | DB: N | Tests: N)
> - DoD items: N
> - Specialist reviews needed: [list which subagents will be invoked]

---

### Step 2 — Acceptance Criteria Verification

This is the core of the review. For each acceptance criterion in the spec (AC-1, AC-2, ...),
verify whether the implementation satisfies it.

**For each AC, find VERIFIABLE EVIDENCE in one of:**
- Source code implementing the behaviour
- A test that asserts the behaviour
- A migration or config change that enables the behaviour

**Do not accept circumstantial reasoning** ("the service method probably handles this").
Find the specific code or test that implements each criterion or mark it FAIL.

**Verdict options:**
- **✅ PASS** — Found specific code or test that implements this criterion. Cite it.
- **❌ FAIL** — No implementation found. Or implementation contradicts the criterion.
- **⚠️ PARTIAL** — Implementation exists but is incomplete or missing an edge case.
- **🔍 UNTESTABLE** — Cannot determine from source code alone (requires runtime or manual verification).

Present results as a table:

```
Acceptance Criteria Verification
══════════════════════════════════════════════════════════════════════════
AC    Criterion (abbreviated)                    Verdict   Evidence
──────────────────────────────────────────────────────────────────────────
AC-1  Reused refresh token triggers revocation…  ✅ PASS   refreshToken.service.ts:L88, test: tests/integration/refreshToken.test.ts:L42
AC-2  Reuse event recorded in audit log…         ✅ PASS   audit.service.ts:L30, test: tests/integration/refreshToken.test.ts:L67
AC-3  Reuse response includes no token data…     ⚠️ PARTIAL  Response omits access token, but still includes refresh token family id
AC-4  Unauthenticated request returns 401…       ✅ PASS   authenticate middleware applied at router level (auth.router.ts:L12)
──────────────────────────────────────────────────────────────────────────
Result: 3 PASS, 0 FAIL, 1 PARTIAL, 0 UNTESTABLE
```

For every FAIL and PARTIAL, add a Finding entry (see Step 5 output format).

---

### Step 3 — Scope Conformance Check

Verify that the implementation is scoped correctly — no more, no less.

**3a — Scope creep detection**

Review the git diff for changes to files NOT mentioned in the spec's "Areas Affected"
section or "Architecture Impact" section. Changes outside the declared scope must be
explicitly justified.

For each out-of-scope file changed:
- Is this a legitimate dependency of the spec'd change? (ACCEPT)
- Is this an unrelated improvement bundled into this PR? (FLAG — should be a separate PR)
- Is this a regression/bug fix discovered during implementation? (ACCEPT but note it)

**3b — Missing implementation detection**

Cross-reference the spec's "Areas Affected" against the actual changed files. If the spec
says the database is affected but `src/db/schema.ts` did not change, flag as potentially
incomplete.

**3c — Out-of-scope check**

Read the spec's "Out of Scope" section. Verify that none of the excluded items were
accidentally implemented. If they were, flag them — out-of-scope code is un-spec'd code
that may not have been designed, reviewed, or tested to the same standard.

---

### Step 4 — Definition of Done Audit

Check each DoD item from `CLAUDE.md`. Provide verifiable evidence for each.

```
Definition of Done Audit
════════════════════════════════════════════════════════════════════════
#   DoD Item                                      Status    Evidence / Gap
────────────────────────────────────────────────────────────────────────
1   All ACs from spec are met                     ❌ FAIL   AC-3 partial (see Step 2)
2   Unit tests ≥80% coverage on new code           🔍 UNVER  Coverage report not run yet
3   Integration tests cover all new endpoints      ✅ PASS   2 integration tests found in tests/integration/
4   TypeScript compiles with no errors             ✅ PASS   Run: npm run typecheck → 0 errors
5   ESLint passes with zero warnings               ⚠️ WARN   1 ESLint warning in refreshToken.service.ts (missing return type)
6   No hardcoded secrets                           ✅ PASS   Pre-tool-use secret scan hook ran clean
7   specs/openapi.yaml updated (API changed)       ✅ PASS   specs/openapi.yaml changed in diff
8   PR description includes How to Test            🔍 UNVER  PR not yet created
────────────────────────────────────────────────────────────────────────
```

Run the following to produce live verification where possible:

```bash
npm run typecheck 2>&1 | tail -5
npm run lint 2>&1 | tail -10
```

Report actual output, not assumptions.

---

### Step 5 — Specialist Subagent Reviews

Based on the diff content, invoke the relevant specialist subagents.

**5a — Security review (mandatory for these change types)**

Invoke if the diff touches ANY of:
- Authentication, SSO, or OAuth logic (`src/routes/auth.router.ts`, `src/routes/oauth.router.ts`)
- Route handlers receiving user-supplied input
- Token issuance, verification, or revocation (`src/services/token.service.ts`, `src/services/refreshToken.service.ts`)
- PII storage or transmission (`src/utils/crypto.ts`, `users.email`)
- Third-party integrations (SAML IdP, OAuth callbacks)

Invoke the security reviewer:
```
Use @.claude/agents/security-reviewer.md to review the changed files in this diff.
Focus on: auth gaps, input validation, injection vulnerabilities, data exposure, hardcoded secrets.
Changed files: [list from git diff --stat]
Reference auth pattern: src/middleware/authenticate.ts
```

**5b — Performance review (invoke when)**

Invoke if the diff touches:
- New Drizzle queries or a new/changed index in `src/db/schema.ts`
- New Redis access patterns
- New API endpoints returning collections

```
Use @.claude/agents/performance-reviewer.md to review the changed files in this diff.
Focus on: N+1 queries, unbounded queries, missing pagination, missing indexes, Redis hot paths.
Changed files: [list from git diff --stat]
```

**5c — API contract check (invoke when)**

Invoke if `specs/openapi.yaml` is in the diff:
```
Use @.claude/agents/api-contract-checker.md to verify the API changes in this diff
are consistently reflected across specs/openapi.yaml, src/schemas/, and src/routes/.
```

Present each subagent's output in its own section of the review report.

---

### Step 6 — Code Quality Assessment

Beyond spec compliance, assess general code quality. Flag only real issues — not stylistic preferences.

**6a — Pattern conformance**

Read `CLAUDE.md` for documented patterns. Check:
- Service layer pattern followed (no business logic in route handlers)
- `Result<T, AppError>` error handling pattern followed
- Zod validation applied at every external boundary
- No anti-patterns listed in CLAUDE.md's "Do not" section used in the new code

**6b — Test quality**

Review the new test files:
- Tests are independent (no shared mutable state between tests)
- Tests cover unhappy paths (not just happy path)
- Integration tests use real Postgres/Redis (Testcontainers), not mocks
- Mocks are used appropriately in unit tests (`ioredis`/`pg` mocked, no live API calls)

**6c — Type safety**

Check for TypeScript weaknesses in the new code:
- `any` type usage
- `Optional[X]`-style patterns instead of `X | null`
- Missing return type annotations on public functions
- `!` non-null assertions without guards

---

### Step 7 — Compile the Review Report

Produce a single, structured review report.

```markdown
# /review — Adversarial Spec-Compliance Report

**Feature:** [name from spec]
**Branch:** [branch-name]
**Spec:** specs/[feature-name].spec.md
**Review date:** [YYYY-MM-DD]
**Reviewer:** Claude Code (subagent, independent context)

---

## Verdict

| Dimension | Status | Blockers |
|-----------|--------|----------|
| Acceptance criteria | [PASS / FAIL / PARTIAL] | N failing |
| Scope conformance | [PASS / WARN] | N out-of-scope changes |
| Definition of Done | [PASS / FAIL] | N items incomplete |
| Security review | [PASS / FAIL / SKIPPED] | N critical findings |
| Performance review | [PASS / FAIL / SKIPPED] | N high findings |
| API contract check | [PASS / FAIL / SKIPPED] | N blocker findings |

**Overall recommendation:** [APPROVE TO PR | FIX BEFORE PR | DISCUSS FURTHER]

---

## Findings

[List all FAIL and PARTIAL items, specialist subagent findings, and DoD gaps as structured findings]

### [SEVERITY] Finding N — [Short title]
- **Source:** [AC-X | DoD item N | Security | Performance | Contract]
- **Location:** `path/to/file.ts` line XX
- **Description:** [What is wrong and why it matters]
- **Evidence:** [Specific code snippet or absence of expected code]
- **Required fix:** [Specific change needed to pass this criterion]
- **Blocking:** [Yes — must fix before PR | No — can defer with justification]

---

## Passing Items

[List all items that passed with one-line evidence to confirm they were checked]

- ✅ AC-1: Reuse detection → refreshToken.service.ts:L88
- ✅ AC-4: Auth guard → authenticate middleware applied at router level
- ✅ specs/openapi.yaml updated and validated
- ✅ TypeScript compiles clean

---

## Deferred Items

[Items flagged as UNTESTABLE or that require manual verification]

- 🔍 Unit test coverage: run `npm run test:coverage` to verify ≥80% on new code

---

## Recommended Actions Before PR

[Ordered list of required fixes, most critical first]

1. **[BLOCKER]** Fix AC-3: strip refresh token family id from the reuse-detection response body
2. **[REQUIRED]** Fix ESLint warning in `refreshToken.service.ts`
3. **[OPTIONAL]** Remove unused `logger.debug` calls (noise in production logs)
```

---

### Step 8 — Post-Review Guidance

After presenting the report, give the user clear next steps:

**If APPROVE TO PR:**
> ✅ The implementation passes the adversarial review. No blockers found.
> Recommended next step: `/pr-create` to generate the PR description.

**If FIX BEFORE PR:**
> ❌ [N] blocker(s) must be resolved before this PR is ready.
> Address the findings above, then re-run `/review` to confirm fixes before creating the PR.
>
> Blockers:
> 1. [summary of each blocking finding]

**If DISCUSS FURTHER:**
> ⚠️ Findings were identified that require a judgement call beyond automated review.
> Schedule a review conversation before proceeding.
>
> Discussion points:
> 1. [summary of each judgement-call finding]

---

## Constraints for This Skill

- **Never rubber-stamp.** If evidence for an AC cannot be found, mark it FAIL — not PASS with a caveat.
- **Do not invent requirements.** Only verify against criteria in the spec. Do not add new criteria that the spec does not contain.
- **Do not suggest scope creep.** The review checks what was spec'd, not what would be nice to have.
- **Flag style separately from correctness.** ESLint warnings are DoD items but do not block a PASS verdict on an AC. Separate findings clearly.
- **Report with specificity.** "This might be a problem" is not a finding. A finding requires a specific file, line number, and description of the failure.
- **Be adversarial but fair.** Assume the implementation is wrong until evidence proves it right. But when evidence is found, accept it — do not demand perfection beyond the spec's requirements.
- **Never modify implementation code during review.** This skill reads and reports. It does not fix. The developer implements fixes; then `/review` can be re-run to confirm.
