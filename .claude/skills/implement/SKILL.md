---
name: implement
description: Execute an approved implementation plan from plans/[feature-name].plan.md task-by-task, cross-referencing the originating spec for every decision. Use after a plan is approved, to write the actual code.
---

# Skill: /implement — Spec-Driven Plan Execution

## Usage
```
/implement
```

Examples:
```
/implement
/implement  (when plans/ contains exactly one .plan.md file — operates on it automatically)
/implement  (when plans/ contains multiple .plan.md files — asks the user which plan to execute)
```

---

## What This Skill Does

This skill executes an approved implementation plan from `plans/[feature-name].plan.md`,
implementing every task in the dependency order specified by the plan and continuously
cross-referencing the originating spec in `specs/[feature-name].spec.md` to verify that every
decision made is grounded in agreed requirements.

**Core operating principles:**

```
1. The plan defines what to build and in what order — never deviate from it
2. The spec defines why and how — every implementation decision cites the spec
3. If the spec does not answer a question, STOP and ask — never invent requirements
4. specs/openapi.yaml and src/schemas/ are always updated before any route handler code
5. Tests run after every phase — a failing phase is never skipped
```

This skill does NOT:
- Make architectural decisions not covered by the spec
- Add features, fields, or behaviours not listed in the spec's Functional Requirements
- Skip tasks because they seem unimportant
- Proceed past a failing typecheck or failing test without resolving it

---

## Full Workflow Prompt

Execute the following steps in order. Announce each step before executing it.

---

### Step 1 — Discover and Confirm the Plan File

Read the `plans/` directory and list all files matching `*.plan.md` (ignore `PLAN-TEMPLATE.md`).

**If exactly one plan file exists:**

> I found one plan: `plans/[filename].plan.md`. I'll execute this plan.
> Does that look right? (yes / no)

Wait for confirmation before proceeding.

**If multiple plan files exist:**

> I found the following implementation plans in `plans/`:
>
> 1. `plans/[file-1].plan.md`
> 2. `plans/[file-2].plan.md`
>
> Which plan should I execute? (Enter the number or filename)

Wait for the user to select a plan before proceeding.

**If no plan files exist:**

> ⚠️ No plan files found in `plans/`. Implementation cannot begin without an approved plan.
>
> Run `/plan` to generate an implementation plan from the current spec first.

Stop — do not proceed.

**If the selected plan has Status other than Approved:**

> ⚠️ `plans/[filename].plan.md` has Status: **[status]**, not Approved.
> Executing an unapproved plan risks implementing scope that has not been agreed.
>
> Proceed anyway, or get the plan approved first? (proceed / stop)

Wait for the user's decision before continuing.

---

### Step 2 — Load Full Context: Plan and Spec

Read both files completely before writing a single line of code:

1. **`plans/[feature-name].plan.md`** — read every task record:
   - Task ID, title, phase, files to create/modify, complexity, dependencies, spec references

2. **`specs/[feature-name].spec.md`** — the originating spec. Read every section:
   - Functional Requirements (FR-N) — the intent behind each task
   - Architecture Impact — areas affected, API changes, DB schema changes, Zod schema changes
   - Acceptance Criteria (AC-N) — the testable definition of done
   - Non-Functional Requirements — performance, security, privacy constraints
   - Out of Scope — hard boundary; if code touches this, stop and flag it

After reading both, summarise the full work scope:

> **Implementation context loaded:**
>
> - **Feature:** [Human-readable feature name]
> - **Plan:** `plans/[feature-name].plan.md` — N tasks across N phases
> - **Spec:** `specs/[feature-name].spec.md` — N FRs, N ACs
> - **Phases to implement:** [list phases with task counts]
> - **Total files to create:** N
> - **Total files to modify:** N
>
> I'll implement tasks in dependency order, running typechecks and tests after each phase.
> Starting pre-flight check...

---

### Step 3 — Pre-Flight Check

Before writing any code, verify the environment is in a known-good state. A clean baseline
ensures that any failures encountered during implementation were introduced by this work, not
pre-existing.

**3a — TypeScript compilation**

```bash
npm run typecheck
```

If this fails, report:
> ⚠️ TypeScript compilation is failing before any changes have been made.
> The environment is not in a clean state. Fix pre-existing type errors before starting implementation.
> Show me the errors and I'll help resolve them, or you can fix them and re-run `/implement`.

Stop until the baseline passes.

**3b — Existing test suite**

```bash
npm test -- --passWithNoTests
```

If tests are already failing, report:
> ⚠️ Existing tests are failing before any changes have been made.
> Proceeding would make it impossible to distinguish pre-existing failures from regressions.
> Resolve the failing tests first, then re-run `/implement`.

Stop until the baseline passes.

**3c — Report baseline**

> ✅ Pre-flight check passed.
> - TypeScript: PASS
> - Existing tests: N passing, 0 failing
>
> Starting implementation...

---

### Step 4 — Execute Tasks Phase by Phase

Work through every task in the plan, strictly following the dependency order. For each phase,
complete all tasks in that phase before starting the next.

**For each individual task:**

Announce the task before starting:
> ---
> **Implementing T-XX: [Task Title]** (Phase [1/2/3] | Complexity [S/M/L])
> Spec refs: [FR-N, AC-N]
> Files: [list files to create/modify]

Then implement the task:

- **Read the files listed** before modifying them to understand the existing patterns
- **Follow existing code conventions** — naming, import style, `Result<T, AppError>` error
  handling, `logging.getLogger`/`winston` logger usage, formatting
- **Every implementation decision must be traceable to the spec.** If the spec says a field
  is required, make it required. If the spec gives an HTTP status code, use it exactly.
- **Do not add fields, parameters, or behaviour not described in the spec.** Scope creep
  starts with "while I'm in here, I'll also add..."
- For **Phase 1 tasks** (OpenAPI spec, schema, Zod schema changes): update `specs/openapi.yaml`
  first, then `src/db/schema.ts` (run `npm run db:generate` to produce the migration — never
  hand-write migration SQL for schema changes), then the matching Zod schema in `src/schemas/`
- For **Phase 2 tasks** (services and routes): put all business logic in the service layer;
  route handlers only validate input (via the `validate` middleware), call service methods,
  and return responses; apply `authenticate` middleware for any protected route; no `any` types
- For **Phase 3 tasks** (tests): mock `ioredis`/`pg` in unit tests; use real Postgres + Redis
  via Testcontainers in integration tests — never mock the database or Redis there

After completing each task, verify the file was written and TypeScript compiles:

```bash
npm run typecheck
```

If typecheck fails immediately after a task, fix the type error before moving to the next task.
Do not accumulate type errors — resolve them task by task.

Report after each task:
> ✅ T-XX complete. TypeScript: PASS.

---

### Step 5 — Phase Validation Gates

After completing all tasks within a phase, run the phase validation gate before starting
the next phase. Do not skip this step even if you are confident the code is correct.

**After Phase 1 (API Contract & Data Model):**

```bash
npm run typecheck
npx @apidevtools/swagger-parser validate specs/openapi.yaml
npm run db:migrate   # apply the generated migration to the dev database
```

Report:
> ✅ Phase 1 gate: TypeScript PASS | OpenAPI validation PASS | Migration applied
> Proceeding to Phase 2.

**After Phase 2 (Service & Route Implementation):**

```bash
npm run typecheck
npm test -- [resource-name]
```

Report:
> ✅ Phase 2 gate: TypeScript PASS | Tests: N passing, 0 failing
> Proceeding to Phase 3.

**After Phase 3 (Tests & Validation):**

```bash
npm test
npm run test:coverage
```

All tests across the project must pass, and new code must meet ≥80% coverage. Report:
> ✅ Phase 3 gate: N total tests passing, 0 failing. Coverage on new code: N%.

If any gate fails: fix the failures in the current phase before proceeding. Do not move to
the next phase with known failures.

---

### Step 6 — Spec Gap Protocol (Unresolved Decisions)

During implementation, if any task requires a decision that is not answered by the spec,
**stop immediately and ask the user.** Do not guess. Do not use a "reasonable default"
silently.

When hitting a spec gap, report:

> ⚠️ **Spec Gap — Input Required**
>
> I've reached T-XX ([Task Title]) and need a decision that the spec does not resolve:
>
> **Question:** [State the decision clearly]
>
> **Options:**
> 1. [Option A — describe the behaviour and its implications]
> 2. [Option B — describe the behaviour and its implications]
>
> **Spec reference:** [Quote the relevant section — or note "Not addressed in spec"]
>
> Which behaviour should I implement? I'll wait for your answer before continuing.

Do not continue past this point until the user provides an answer. Once answered:
- Implement the chosen behaviour
- Note the gap in the final summary report so the spec owner can update the spec

---

### Step 7 — Full Completion Verification

After all phases and all tasks are complete, run the full verification suite:

**7a — Full test suite**

```bash
npm test
```

All tests must pass. If any test is failing, resolve it now. Do not report completion with
a failing test.

**7b — Full TypeScript compilation**

```bash
npm run typecheck
```

Zero errors. No suppressed errors with `@ts-ignore` or `as any` added during this implementation
(flag any pre-existing suppressions as a warning, but do not block on them).

**7c — Lint**

```bash
npm run lint
```

Zero warnings (`--max-warnings 0` is enforced).

**7d — API contract check**

```
Use the @.claude/agents/api-contract-checker.md subagent to verify all API changes for this
feature are consistently reflected across:
1. specs/openapi.yaml
2. src/schemas/
3. src/routes/

Report any inconsistency as a BLOCKER.
```

Resolve any BLOCKER findings before reporting completion.

---

### Step 8 — Completion Report

Report the completed implementation:

> ## /implement Complete ✅
>
> **Feature:** [Human-readable feature name]
> **Plan executed:** `plans/[feature-name].plan.md`
> **Spec referenced:** `specs/[feature-name].spec.md`
>
> **Tasks completed:** N / N
>
> **Files created (N):**
> - `[path]` — T-XX
>
> **Files modified (N):**
> - `[path]` — T-XX, T-YY
>
> **Spec gaps resolved during implementation:** [N — list each question and its resolution | None]
>
> **Verification:**
> - TypeScript: PASS
> - Tests: N passing, 0 failing
> - Lint: PASS
> - API contract check: PASS
>
> **Acceptance criteria coverage:**
> - AC-1: ✅ Satisfied by T-XX [test: describe test]
> - AC-2: ✅ Satisfied by T-XX [test: describe test]
> - [Continue for all ACs in the spec]
>
> **Next steps:**
> 1. Manually smoke-test the feature end-to-end (`npm run dev`)
> 2. Run `/review` to perform the adversarial spec-compliance review
> 3. Run `/pr-create` when the feature is ready for code review
>
> ⚠️ If any spec gaps were resolved during this session, update `specs/[feature-name].spec.md`
> to record the decisions before the context is lost.

---

## Constraints for This Skill

- Implement tasks in the exact dependency order defined in the plan. Do not reorder tasks based on personal preference or assumed efficiency gains.
- Every line of code written must be traceable to a Functional Requirement, Acceptance Criterion, or Non-Functional Requirement in the spec. If it is not, do not write it.
- NEVER hand-write migration SQL for a `src/db/schema.ts` change — regenerate via `npm run db:generate` only.
- NEVER add `@ts-ignore`, `as any`, or eslint-disable comments to silence errors introduced by this implementation. Fix the error properly or ask for help.
- Phase gates are mandatory — a failing typecheck or failing test at a gate must be resolved before the next phase begins. No exceptions.
- If the spec says something is out of scope, it is out of scope. Do not implement it even if it seems trivial.
- Do not refactor code unrelated to the feature being implemented. Scope creep includes "cleaning up" nearby files. Raise a separate issue instead.
- If a task's estimated complexity turns out to be significantly larger than planned (e.g., an S task takes multiple hours), pause and report this to the user before continuing — the plan may need to be revised.
- All spec gaps encountered must be surfaced to the user immediately — never silently choose a default. The spec is the source of truth; if it is incomplete, the spec owner must resolve it.
