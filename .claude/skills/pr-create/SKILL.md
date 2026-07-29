---
name: pr-create
description: Generate a ready-to-paste PR description from the git diff, the feature spec, the CLAUDE.md Definition of Done, and any /review findings. Use once implementation is complete and reviewed, right before opening the PR.
---

# Skill: /pr-create — Pull Request Description Generator

## Usage
```
/pr-create
```

Run this command when the feature implementation is complete and you are ready to open a PR.
No arguments required — the skill reads context from git and the specs directory.

Prerequisites:
- All code changes are staged or committed on the feature branch
- `/review` has been run (or you explicitly accept the risk of skipping it)
- Tests pass locally

---

## What This Skill Does

This skill generates a complete, structured PR description by reading:
1. The current git diff (what changed)
2. The feature spec in `specs/` (what was intended)
3. The CLAUDE.md Definition of Done (what the checklist must verify)
4. Any `/review` output from this session (AI review findings)

The output is a ready-to-paste PR description in GitHub-compatible Markdown.

---

## Full Workflow Prompt

Execute the following steps in order.

---

### Step 1 — Gather Context

Read the following to build context before generating the PR description.

**1a — Git information**
```bash
git log origin/main..HEAD --oneline
```
List the commits in this branch. Identify the feature scope from commit messages.

```bash
git diff origin/main..HEAD --stat
```
List all changed files grouped by area (routes, services, middleware, db, schemas, tests).

```bash
git diff origin/main..HEAD -- specs/openapi.yaml
```
Check if the OpenAPI spec was changed (indicates API changes).

```bash
git branch --show-current
```
Get the branch name to extract the feature slug (and ticket ID, if the branch uses one).

**1b — Feature spec**

Search `specs/` for the spec file most likely related to this feature:
```bash
ls specs/*.spec.md
```

Read the most relevant spec file. Extract:
- Feature name
- Ticket ID (if any)
- Overview paragraph
- Acceptance criteria list (AC-1, AC-2, ...)
- Areas affected
- Testing strategy

If no spec file exists for this feature: note it in the PR description as a governance gap.

**1c — Definition of Done**

Read `CLAUDE.md` and find the "Definition of Done" section. Extract all DoD items
to build the checklist.

**1d — Review findings (if available)**

Check if a `/review` has been run in this session. If so, capture the key findings.
If no review was run, note: "⚠️ /review was not run before this PR — manual review is especially important for this PR."

---

### Step 2 — Assess PR Scope

Before writing the description, classify the PR:

**Scope classification:**
- `feature` — new capability
- `fix` — bug correction
- `refactor` — internal restructuring with no behavioural change
- `chore` — dependency, tooling, configuration
- `docs` — documentation only

**Size classification:**
- `small` — ≤5 files changed, single purpose
- `medium` — 6–20 files, single feature
- `large` — >20 files or multiple concerns (flag for possible split)

If the PR is `large`, warn the user:
> ⚠️ This PR touches [N] files. Consider whether it can be split into smaller,
> independently-mergeable PRs. Large PRs are harder to review and more likely
> to introduce merge conflicts.

Proceed regardless — the user decides whether to split.

**Change breakdown:**
```
Routes:         N files
Services:       N files
Middleware:     N files
DB (schema/migrations): N files
Schemas (zod):  N files
Tests:          N files
Configuration:  N files  (package.json, CI, tooling)
```

---

### Step 3 — Generate the PR Description

Write the PR description using the template below. Populate every section from the
context gathered in Steps 1 and 2. Do not leave placeholder text — fill in real content.

---

**PR Title:**
```
[type]: [imperative description ≤72 chars]

Examples:
feat: add refresh token reuse alerting to audit log
fix: correct JWKS previous-key expiry check
refactor: extract token claim validation into a shared helper
```

---

**PR Body:**

```markdown
## Summary

[2–4 sentences describing what changed and why. Reference the spec.
Written for a reviewer who will read this before looking at the diff.]

Implements: `specs/[feature-name].spec.md`
Ticket: [TICKET-ID or "N/A"]
Branch: `[branch-name]`

---

## What Changed

### Routes / Services / Middleware
[Bullet list of changes. Be specific: endpoint names, service methods, middleware changes.]

- Added `POST /v1/auth/refresh-token/revoke-family` — revokes an entire refresh token family
- New service method: `RefreshTokenService.revokeFamily()`
- Updated `specs/openapi.yaml` — added `RevokeFamilyRequest`/`RevokeFamilyResponse` schemas
- ⚠️ **Breaking change:** [describe if any — or "No breaking changes"]

### Database
[New tables/columns/indexes, or "No database changes in this PR."]

### Tests
- [N] unit tests added for `RefreshTokenService` — coverage: [X]%
- [N] integration tests added for the new endpoint (covers all response codes)

---

## How to Test

[Step-by-step instructions a reviewer can follow to verify this feature in a local environment.
Write these for someone who has not worked on this feature. Be precise.]

**Prerequisites:**
- [ ] Checkout this branch: `git checkout [branch-name]`
- [ ] Install dependencies: `npm install`
- [ ] Run database migrations: `npm run db:migrate`
- [ ] Start the dev server: `npm run dev`

**Verify the core flow:**

1. [Step]
2. [Step]
3. Verify: [expected observable result]

**Verify error handling:**

4. [Step that triggers an error condition]
5. Verify: [expected error response]

**API testing (curl):**

```bash
curl -X POST http://localhost:3000/v1/[path] \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

---

## AI Review Summary

[Paste the output from the /review skill run, or the relevant findings.
If /review was not run, write: "⚠️ Automated review was not run. Manual review is especially important for this PR."]

Key findings from automated review:
- [CRITICAL findings that were fixed before PR creation]
- [MEDIUM findings accepted as known limitations]
- [LOW findings deferred to follow-up]

---

## Definition of Done Checklist

[Generate this checklist from the CLAUDE.md Definition of Done items.
Check off items that are confirmed complete.]

- [ ] All acceptance criteria from `specs/[feature-name].spec.md` are met
- [ ] Unit tests pass with ≥80% coverage on new code
- [ ] Integration tests cover all new/changed endpoints
- [ ] TypeScript compiles with no errors (`npm run typecheck`)
- [ ] ESLint passes with zero warnings (`npm run lint`)
- [ ] No hardcoded secrets (secret-scan hook confirmed clean)
- [ ] `specs/openapi.yaml` updated and consistent with `src/schemas/` and `src/routes/` (if API changed)
- [ ] PR description includes "How to Test" instructions (this section ✅)
- [ ] `/review` run and critical findings addressed

---

## Notes for Reviewers

[Anything a reviewer should know that is not obvious from the diff:
- Areas of heightened risk that deserve extra scrutiny
- Decisions made during implementation that deviate from the spec (and why)
- Shortcuts taken that should be revisited in a follow-up
- Database migration considerations (this migration is reversible / irreversible)]

[If nothing special: "No special reviewer notes."]
```

---

### Step 4 — Output the PR Description

Present the generated PR description to the user:

> ## PR Description Generated ✅
>
> Copy the title and body below into your GitHub PR creation form.
>
> ---
> **Title:**
> [generated title]
>
> **Body:**
> [full generated body]
> ---
>
> Before submitting the PR:
> - Verify the "How to Test" steps work in your local environment
> - Fill in any [bracketed placeholders] that could not be auto-populated
> - Confirm the Definition of Done checklist items are accurately checked

---

### Step 5 — Post-PR Actions

After generating the PR description, remind the user:

> **Post-PR checklist:**
> - [ ] Assign reviewers
> - [ ] Link the PR to the ticket, if one exists
> - [ ] Add appropriate labels: `feature` / `fix` / `needs-security-review` / `has-breaking-change`
> - [ ] If this PR includes a database migration, confirm it has been reviewed

---

## Constraints for This Skill

- Generate a real PR description, not a template with empty placeholders. Every section must contain actual content derived from the git diff, spec, and review findings.
- Do not invent features or changes not present in the git diff.
- Do not use vague language like "various improvements" or "miscellaneous fixes." Be specific about every change.
- The "How to Test" section must be executable — a reviewer must be able to follow the steps without asking the author for clarification.
- If the spec referenced in the PR does not exist, generate the PR description from the git diff alone but warn the user that the spec is missing — this is a governance gap.
- The DoD checklist must reflect the actual items from `CLAUDE.md`, not a generic template.
