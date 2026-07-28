# App Gateway Service — Claude Code Quick Reference

> **Print this card or pin it in your editor.** Everything you need for a daily
> session in one page.

---

## 1 — The 5 Workflow Steps

| # | Phase | Command | Output | Gate |
|---|-------|---------|--------|------|
| 1 | **Specify** | `/spec-feature "description"` | `specs/[feature].spec.md` | ⛔ Reviewer approves |
| 2 | **Plan** | `/plan` | `plans/[feature].plan.md` | ⛔ Reviewer approves |
| 3 | **Implement** | `/implement` | Code changes | 👁 Review diff |
| 4 | **Review** | `/review` | Review findings report | 👁 Address FAILs |
| 5 | **PR** | `/pr-create` | PR description (paste to GitHub) | 👁 Human review |

> ⛔ = Hard gate: do not proceed without written approval.
> 👁 = Human judgement required before continuing.

---

## 2 — All Custom Slash Commands

| Command | Syntax | What it does |
|---------|--------|-------------|
| `/spec-feature` | `/spec-feature "add refresh token reuse alerting"` | Structured 6-round requirements interview → writes complete spec to `specs/` |
| `/plan` | `/plan` | Reads approved spec → writes phased implementation plan to `plans/` |
| `/implement` | `/implement` | Reads approved spec + plan → implements all changes |
| `/review` | `/review` | Fresh-context adversarial review → PASS/FAIL per acceptance criterion |
| `/pr-create` | `/pr-create` | Reads diff + spec + DoD → generates complete PR description |
| `/api-change` | `/api-change "add POST /v1/oauth/introspect"` | API-first workflow: OpenAPI spec → Zod schema → route/service |
| `/db-migration` | `/db-migration "add revoked_at column to refresh_tokens"` | Guided Drizzle schema change: safety assessment → schema.ts edit → `db:generate` → validate |
| `/fix-issue` | `/fix-issue PROJ-1234` | Fetches issue context and implements fix |

---

## 3 — Context Management Commands

| Situation | Command / Action |
|-----------|-----------------|
| Starting a new unrelated task | `/clear` — mandatory fresh start |
| Context filling, task ongoing | `/compact Focus on [spec file] and files modified so far` |
| Session drifted from spec | `/rewind` to checkpoint, restate the constraint |
| Quick question, no history pollution | `/btw [question]` |
| Exploring unfamiliar code | Spin up a subagent — keeps main session clean |

**Compaction rule — always preserve these when compacting:**
- Full list of modified files
- Current spec file path
- Any failing test output
- Remaining acceptance criteria

---

## 4 — CLAUDE.md Rules You Must Never Break

```
API Contract
  ✗ Never hand-edit a generated Drizzle migration in src/db/migrations/ — fix schema.ts and regenerate
  ✗ Never change specs/openapi.yaml without review on the diff
  ✓ Keep src/schemas/ (Zod) in sync with specs/openapi.yaml by hand — there is no codegen here

Code Quality
  ✗ No @ts-ignore without a comment explaining why
  ✗ No `any` types, no `Optional[X]` (use `X | null`)
  ✗ No hardcoded secrets, tokens, or credentials anywhere in committed code

Security (blocking — see CLAUDE.md Security Rules)
  ✗ Never log access tokens, refresh tokens, client secrets, or passwords — not even partially
  ✗ Never accept an unsigned SAML assertion
  ✗ Never allow OAuth authorization_code without PKCE (S256 only)
  ✓ Cookies carrying tokens must be Secure; HttpOnly; SameSite=Strict
  ✓ JWKS must serve both the active and previous kid during a rotation window

Git
  ✗ No direct pushes to main
  ✗ No git push --force (blocked by settings.json)
  ✓ Branch from main, name: feature/[slug] (or feature/[TICKET-ID]-[slug] if a ticket exists)

Workflow
  ✗ Do not skip from planning to implementation without spec + plan approval
  ✗ Do not skip /review before opening a PR
```

---

## 5 — Key Build & Test Commands

```bash
npm install                 # Install dependencies
npm run dev                 # Start the dev server (tsx watch)
npm run build               # Production build
npm test                    # Unit tests (vitest run)
npm run test:integration    # Integration tests (real Postgres + Redis via Testcontainers)
npm run test:coverage       # Coverage — must be ≥80%
npm run typecheck           # tsc --noEmit (must be 0 errors)
npm run lint                # ESLint (must be 0 warnings, --max-warnings 0)
npm run db:generate         # Generate a Drizzle migration from schema.ts changes
npm run db:migrate          # Apply pending migrations
npm run db:studio           # Open Drizzle Studio
npm run db:seed             # Seed a dev user
```

**Default port:** `http://localhost:3000` (override with `PORT` in `.env`)

---

## 6 — Commit Message Format (Conventional Commits — enforced)

```
<type>(<scope>): <subject>

[optional body: explain WHY]
```

**Types:** `feat` | `fix` | `refactor` | `test` | `chore` | `docs` | `perf` | `build`
**Subject:** imperative, lowercase, no period, ≤72 chars

```bash
# Examples
feat: add refresh token reuse alerting to audit log
fix: correct JWKS previous-key expiry check
refactor: extract token claim validation into a shared helper
chore: bump express to 5.0.1
```

---

## 7 — Branch Naming

```
feature/short-description               ← new features
fix/short-description                   ← bug fixes
refactor/short-description              ← restructuring
chore/description                       ← tooling, deps

# If a ticket tracker is configured, prefix with the ticket ID:
feature/PROJ-123-short-description
```

---

## 8 — Definition of Done — Checklist

### Code Quality
- [ ] `npm run typecheck` — zero errors
- [ ] `npm run lint` — zero warnings
- [ ] No unjustified `@ts-ignore`, `any`, or `eslint-disable`

### Testing
- [ ] Unit tests ≥80% coverage on new code
- [ ] Integration tests cover all new/changed endpoints (real Postgres + Redis)
- [ ] Every acceptance criterion from spec has a passing test

### API Contract
- [ ] `specs/openapi.yaml` updated (if any endpoint touched)
- [ ] `src/schemas/` (Zod) updated to match — no codegen in this project, sync is manual
- [ ] No breaking changes without coordinating with callers

### Security
- [ ] No hardcoded secrets in committed code
- [ ] `security-reviewer` agent run for auth / SSO / OAuth / PII code

### Documentation
- [ ] Spec status updated to `Implemented`
- [ ] New env vars documented in `.env.example`

### Review
- [ ] `/review` run, all FAILs addressed
- [ ] PR includes "How to Test" step-by-step instructions
- [ ] Human review approved

---

## 9 — Specialist Subagents (Invoke Manually or via `/review`)

```
@.claude/agents/security-reviewer.md        ← OWASP, auth/SSO/OAuth, PII code
@.claude/agents/api-contract-checker.md     ← After any specs/openapi.yaml change
@.claude/agents/performance-reviewer.md     ← New Drizzle queries, Redis patterns, list endpoints
```

**Example invocation:**
```
Use @.claude/agents/security-reviewer.md to review src/middleware/authenticate.ts
```

---

## 10 — Blocked Operations (Always Require Human Confirmation)

```
✗ DROP TABLE / TRUNCATE / DELETE without WHERE on production
✗ Cloud resource creation / IAM policy changes
✗ Writes to .env, *.pem, *credentials*, secrets managers
✗ Major framework version upgrades (Express, jose, drizzle-orm)
✗ Removing / renaming existing API fields in specs/openapi.yaml
✗ git push --force
✗ Changes to .github/workflows/ (CI/CD pipelines)
✗ Changes to auth middleware, JWT/JWKS handling, or SAML/OAuth logic
```

---

*App Gateway Service*
*Full docs: `CLAUDE.md` · `specs/app-gateway-auth.spec.md` · `specs/openapi.yaml`*
