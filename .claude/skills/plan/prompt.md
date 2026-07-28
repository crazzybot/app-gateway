# Skill: /plan — Structured Implementation Plan from Spec

## Usage
```
/plan
```

Examples:
```
/plan
/plan  (when specs/ contains exactly one approved *.spec.md — operates on it automatically)
/plan  (when specs/ contains multiple specs — asks the user which spec to plan against)
```

---

## What This Skill Does

This skill reads an approved feature specification from `specs/` and produces a complete,
sequenced implementation plan saved to `plans/[feature-name].plan.md`.

It does NOT write any code. It does NOT make decisions that are not already resolved in the spec.
Its sole output is a plan document that `/implement` will execute task-by-task.

**The plan enforces this project's mandatory implementation order:**

```
1. OpenAPI spec + Drizzle schema/migration   ← always first; the route and service layers
                                                depend on the agreed contract and schema
2. Service layer & route handlers            ← implements the agreed contract
3. Tests & validation                        ← automated tests verifying every AC in the spec
```

This order prevents the most common failure modes: implementing routes out of sync with the
OpenAPI contract, or writing service code before the schema/migration exists.

---

## Full Workflow Prompt

Execute the following steps in order. Announce each step before executing it.

---

### Step 1 — Discover and Confirm the Target Spec

Read the `specs/` directory and list all files matching `*.spec.md` (ignore `SPEC-TEMPLATE.md`
and any non-feature specs such as `app-gateway-auth.spec.md` unless the user is explicitly
planning against one of those).

**If exactly one candidate spec file exists:**

> I found one spec: `specs/[filename].spec.md`. I'll generate the implementation plan for this spec.
> Does that look right? (yes / no)

Wait for confirmation before proceeding.

**If multiple candidate spec files exist:**

> I found the following specs in `specs/`:
>
> 1. `specs/[file-1].spec.md`
> 2. `specs/[file-2].spec.md`
>
> Which spec should I generate an implementation plan for? (Enter the number or filename)

Wait for the user to select a spec before proceeding.

**If no candidate spec files exist:**

> ⚠️ No spec files found in `specs/`. A plan cannot be created without an approved spec.
>
> Run `/spec-feature "description of the feature"` to create one first.

Stop — do not proceed.

**If the selected spec has Status: Draft (not Approved):**

> ⚠️ The spec `specs/[filename].spec.md` has Status: **Draft**, not Approved.
> Creating a plan from an unapproved spec risks building against requirements that may change.
>
> Proceed anyway, or get the spec approved first? (proceed / stop)

Wait for the user's decision before continuing.

---

### Step 2 — Read and Analyse the Spec

Read the entire contents of the selected spec file. Identify and extract the following
sections carefully — these directly drive the task list:

1. **Functional Requirements (FR-N)** — every capability that must be built
2. **Architecture Impact → Areas Affected** — routes, services, middleware, database, Redis
3. **Architecture Impact → API Changes** — new or modified endpoints
4. **Architecture Impact → Data Model Changes** — new tables, columns, indexes
5. **Architecture Impact → Zod Schema Changes** — schemas that must stay in sync with the OpenAPI spec
6. **Acceptance Criteria (AC-N)** — the definition of done for each requirement
7. **Out of Scope** — hard boundary; do not include tasks for anything listed here
8. **Testing Strategy** — unit and integration tests required

After reading, produce an internal analysis summary (shown to user, not saved to disk):

> **Spec analysis for:** `specs/[feature-name].spec.md`
>
> - **Functional requirements found:** N (FR-1 through FR-N)
> - **Areas affected:** [list only checked areas]
> - **API changes:** [count] new/modified endpoints
> - **DB schema changes:** [yes — N new tables / columns | no]
> - **Zod schema changes:** [yes — list schema names | no]
> - **Acceptance criteria:** N
>
> I'll now decompose this into implementation tasks. Continuing...

Do not wait for confirmation here — proceed immediately to Step 3.

---

### Step 3 — Decompose Into Ordered Implementation Tasks

Group all work into the mandatory phase sequence from `plans/PLAN-TEMPLATE.md`. Only include
tasks for areas that are actually affected according to the spec's Architecture Impact section.

**Phase 1 — API Contract & Data Model**
Tasks in this phase always exist if any API or schema change is listed in the spec.
- Update `specs/openapi.yaml` with all new paths and schema components
- Update `src/db/schema.ts` and run `npm run db:generate` to produce the migration (only if
  Data Model Changes are listed)
- Add/update Zod schemas in `src/schemas/`

**Phase 2 — Service & Route Implementation**
Tasks in this phase exist for every new or modified endpoint listed in the spec.
- Service layer task: implement business logic in `src/services/[name].service.ts`
- Route handler task: implement route in `src/routes/[name].router.ts`, applying `authenticate`
  and `validate` middleware as required
- Register the router in `src/app.ts` if it is a new router

**Phase 3 — Tests & Validation**
Tasks in this phase always exist.
- Unit tests for each new/changed service method (`tests/unit/`)
- Integration tests for each new/changed route (`tests/integration/`), one task per endpoint group
- Coverage, typecheck, and lint verification

---

### Step 4 — Define Task Details

For each task identified in Step 3, produce a complete task record:

- **Task ID:** T-01, T-02, T-03... (sequential across all phases)
- **Title:** Short imperative phrase — e.g., "Add refresh-token-reuse event to openapi.yaml"
- **Phase:** 1 / 2 / 3
- **Files to create or modify:** list every file path that will be touched
- **Estimated complexity:**
  - **S (Small):** < 2 hours — single file change, straightforward logic
  - **M (Medium):** 2–6 hours — multi-file change, moderate logic, some decisions needed
  - **L (Large):** > 6 hours — consider splitting; if > 1 day, it must be split
- **Depends on:** list task IDs that must be complete before this task can start (or "—" if none)
- **Spec references:** list the FR and AC numbers this task satisfies

Tasks within the same phase may be parallelisable if they have no dependency on each other —
mark these with a `(parallel-safe)` note. Tasks across phases always run sequentially in
phase order.

If any task is estimated **L**, add a note:
> ⚠️ T-XX is estimated Large. Consider splitting before starting `/implement`.

---

### Step 5 — Present the Plan for Approval

Show the complete task list to the user in two formats:

**Format 1 — Task Table:**

```
| ID   | Title                                         | Phase | Complexity | Depends On |
|------|-----------------------------------------------|-------|------------|------------|
| T-01 | Add [X] schema components to openapi.yaml     | 1     | S          | —          |
| T-02 | Update schema.ts and generate migration       | 1     | M          | T-01       |
| T-03 | Add Zod schema for [resource]                 | 1     | S          | T-01       |
| T-04 | Implement [name]Service methods               | 2     | M          | T-02, T-03 |
| T-05 | Implement [name].router.ts route handlers     | 2     | S          | T-04       |
| ...  | ...                                           | ...   | ...        | ...        |
```

**Format 2 — ASCII Dependency Graph:**

```
Phase 1: T-01 ──> T-02 ──┐
                  T-03 ──┤
Phase 2:                  ├──> T-04 ──> T-05
Phase 3:                                    T-06 (after all Phase 2 tasks complete)
```

Then ask:

> Here is the full implementation plan. Review it carefully before I save it.
>
> - Does the task breakdown match your understanding of the work?
> - Are there any tasks that are missing, over-scoped, or should be split?
> - Are the dependency relationships correct?
> - Any tasks that should be removed because they are out of scope per the spec?
>
> Approve this plan? (yes / adjust: [corrections])

Wait for explicit approval before Step 6. Apply any corrections the user requests and
show the revised plan before asking for approval again.

---

### Step 6 — Save the Plan Document

With user approval, derive the plan file name from the spec file name:
- `specs/refresh-token-reuse-alerting.spec.md` → `plans/refresh-token-reuse-alerting.plan.md`
- `specs/oauth2-token-introspection.spec.md` → `plans/oauth2-token-introspection.plan.md`

Tell the user before writing:
> I'll save the plan to `plans/[feature-name].plan.md`. Writing now...

Write the complete plan to `plans/[feature-name].plan.md` using EXACTLY the structure in
`plans/PLAN-TEMPLATE.md` (Pre-Implementation Checklist, Phase 1–3, Risk Register, Rollback
Plan, Definition of Done), populated with the task list from Step 4.

After writing, verify the file exists and is non-empty.

Report:
> ✅ Plan saved to `plans/[feature-name].plan.md`

---

### Step 7 — Report Completion

Report back to the user with a summary:

> ## /plan Complete ✅
>
> **Spec:** `specs/[feature-name].spec.md`
> **Plan:** `plans/[feature-name].plan.md`
>
> **Task summary:**
> - Total tasks: N
> - Phase 1 (API contract & data model): N tasks
> - Phase 2 (Service & routes): N tasks
> - Phase 3 (Tests & validation): N tasks
>
> **Complexity breakdown:** S×N  M×N  L×N
>
> **Next steps:**
> 1. Review `plans/[feature-name].plan.md` and confirm task scope is correct
> 2. Ensure any Large (L) tasks are split before implementation begins
> 3. Start a **fresh Claude session** and run `/implement` to execute the plan
>
> ⚠️ Do not begin implementation in this session — start fresh so the implementation
> session loads the plan and spec without anchoring bias from this planning conversation.

---

## Constraints for This Skill

- This skill ONLY produces a plan document. It does not write any code, create any migration files, or modify any source files.
- Do not invent tasks for work not described in the spec. The spec is the authoritative source of scope.
- Do not include tasks for anything explicitly listed in the spec's Out of Scope section.
- Phase order is mandatory: 1 → 2 → 3. Do not reorder phases.
- Every task must reference at least one FR or AC from the spec. If a task cannot be traced to the spec, remove it.
- If the spec has unresolved Open Questions that affect implementation decisions, list them as blockers in the plan's Notes/Risk Register — do not silently guess the answer.
- Complexity estimate L is a warning signal: tasks over ~1 day of work must be split before `/implement` runs them.
- The plan file must be human-readable and reviewable without reading this prompt — write it for the developer who will execute it.
