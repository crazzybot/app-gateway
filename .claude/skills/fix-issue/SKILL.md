---
name: fix-issue
description: Fetch a Jira or Linear issue by ID, classify the work type (bug/enhancement/task), and follow the matching fix protocol (bugs get a failing test first) with every change traced back to the issue ID. Use at the start of a ticket-driven bug-fix or task session.
---

# Skill: /fix-issue — Fetch and Implement a Jira or Linear Issue

## Usage
```
/fix-issue ISSUE-ID
```

Run this command at the start of a bug-fix or task session. Pass the full issue ID including
the project prefix. The skill fetches the issue, analyses the codebase, and guides the
complete fix lifecycle from reproduction to commit-ready state.

Examples:
```
/fix-issue PROJ-1234
/fix-issue ENG-567
```

---

## What This Skill Does

This skill implements a structured, traceable fix workflow anchored to a real issue ticket.
It fetches the issue from Jira or Linear, classifies the work type, and then follows the
correct protocol for that type: bugs are reproduced with a failing test before any code is
touched; enhancements are checked against an existing spec; tasks are implemented directly.

Every code change, comment, and commit message is tied back to the originating issue ID so
that the full change history is auditable from the tracker.

It does NOT create a PR. After completing the fix, it hands off to `/review` and `/pr-create`.
It does NOT refactor unrelated code. It does NOT implement features beyond what the issue
describes. Its scope is limited to the minimum change required to close the issue.

---

## Full Workflow Prompt

Execute the following steps in order. Do not skip steps. Do not combine steps.
Announce each step before executing it.

---

### Step 1 — Parse the Issue ID and Detect the Tracker

Extract the issue ID from `$ARGUMENTS`. Trim whitespace.

**1a — Detect the issue tracker**

Inspect the issue ID prefix against known patterns:
- Jira: any `[A-Z]+-[0-9]+` prefix configured via `JIRA_PROJECT_KEYS` in `.env`, or presence of `JIRA_BASE_URL`
- Linear: three-to-four letter prefix or presence of `LINEAR_API_KEY` in `.env`

```bash
cat .env 2>/dev/null | grep -E 'ISSUE_TRACKER|JIRA_BASE_URL|JIRA_API_TOKEN|LINEAR_API_KEY' | sed 's/=.*/=***/'
```

If `ISSUE_TRACKER` is explicitly set, use that value. If environment variables for only one
tracker are present, use that tracker. If both or neither are configured, tell the user:

> ⚠️ **Tracker auto-detection inconclusive.**
> Set `ISSUE_TRACKER=jira` or `ISSUE_TRACKER=linear` in `.env`, or paste the issue
> text manually when prompted in Step 2.

Proceed with the tracker that was successfully detected, or mark tracker as `manual` if
credentials are absent. Note: this project's `.env.example` does not currently define
tracker credentials — `manual` mode (pasted issue text) is the expected default until a
tracker is configured.

**1b — Validate the issue ID format**

Confirm the ID matches the expected pattern for the detected tracker. If the format is
wrong (e.g., lowercase prefix, missing number), tell the user:

> ❌ `$ARGUMENTS` does not look like a valid issue ID.
> Expected format: `PROJ-1234` (Jira) or `ENG-567` (Linear).
> Please re-run with the correct ID.

Stop here if the ID is malformed.

---

### Step 2 — Fetch Issue Details

**2a — Fetch from Jira**

If tracker is `jira`:

```bash
curl -s -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$ARGUMENTS" \
  -H "Accept: application/json" | \
  jq '{id: .key, title: .fields.summary, type: .fields.issuetype.name,
       priority: .fields.priority.name, status: .fields.status.name,
       description: .fields.description, labels: .fields.labels,
       acceptanceCriteria: .fields.customfield_10016}'
```

**2b — Fetch from Linear**

If tracker is `linear`:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ issue(id: \\\"$ARGUMENTS\\\") { title description priority state { name } labels { nodes { name } } } }\"}"
```

**2c — Handle API failures gracefully**

If the API call returns a non-200 response, connection refused, or missing credentials:

> ⚠️ **Could not reach the issue tracker API.**
>
> Possible causes:
> - `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` not set in `.env` (Jira)
> - `LINEAR_API_KEY` not set in `.env` (Linear)
> - Network connectivity issue
>
> **Fallback:** Please paste the full issue text (title, description, acceptance criteria)
> below and I will proceed with the information you provide.

Wait for the user to paste the issue content. Parse it manually and continue.

If the issue ID is not found (404):

> ❌ Issue `$ARGUMENTS` was not found in the tracker.
> Verify the ID is correct and that your API credentials have read access to this project.
> Re-run `/fix-issue` with the correct ID, or use the fallback paste method above.

Stop and wait for the user.

**2d — Display the summary and ask for confirmation**

Once issue data is obtained, present a summary and wait for explicit approval before
touching any code:

> **Issue: `$ARGUMENTS`**
>
> **Title:** [issue title]
> **Type:** [Bug | Enhancement | Task | Chore]
> **Priority:** [Critical | High | Medium | Low]
> **Status:** [status name]
> **Labels:** [label list or none]
>
> **Description:**
> [full description text]
>
> **Acceptance Criteria / Definition of Done:**
> [extracted criteria or "Not specified — will proceed from description"]
>
> ---
> Shall I proceed with this issue? (yes / no / edit)

Wait for confirmation. If the user says "edit", ask what to override and update the local
understanding before proceeding. Do not proceed on "no".

---

### Step 3 — Classify the Issue Type

Determine the correct workflow based on the issue type field and title keywords:

| Issue type | Protocol |
|------------|----------|
| **Bug** / contains words: "error", "crash", "fails", "broken", "wrong", "incorrect", "regression" | Reproduce-first: write failing test before touching implementation |
| **Enhancement** / "improve", "add", "support", "extend" | Check for existing spec in `specs/` before coding |
| **Task** / "chore", "refactor", "update", "upgrade", "migrate" | Implement directly; no spec check required |

Announce the classification:

> **Issue classified as: [Bug | Enhancement | Task]**
> Protocol: [Reproduce-first | Spec-check | Implement directly]

If the classification is ambiguous, ask the user to confirm before proceeding.

---

### Step 4 — Bug Protocol: Write a Failing Reproduction Test

**Execute this step only for Bug issues. Skip to Step 5 for Enhancement and Task.**

Before touching any implementation code, write a test that fails in the exact way the bug
manifests. This is non-negotiable: a bug fix without a regression test is incomplete.

**4a — Understand the failing behaviour**

Read the issue description and acceptance criteria. Identify:
- The specific input or condition that triggers the bug
- The incorrect output or behaviour that currently occurs
- The correct output or behaviour that should occur after the fix

**4b — Locate the correct test file**

```bash
grep -rn "$ARGUMENTS\|[keyword from issue title]" tests/ -l 2>/dev/null
```

If an existing test file in `tests/unit/` or `tests/integration/` covers the affected area,
add the reproduction test there. If no test file exists for the affected area, note this and
proceed to Step 7 for guidance on creating it from scratch.

**4c — Write the failing test**

Write a test named `it('[behaviour] when [condition]')` (Vitest convention used in this
project) that:
1. Sets up the exact preconditions from the bug report
2. Executes the action that triggers the bug
3. Asserts the CORRECT (expected) behaviour — not the current buggy behaviour

Add a comment above the test:
```
// Regression: $ARGUMENTS — [issue title]
// This test must FAIL before the fix and PASS after.
```

**4d — Run the test and confirm it fails**

```bash
npm test -- [test file name] -t "[test name]"
```

Confirm the test fails with the expected error (not a test infrastructure error). If the
test unexpectedly passes, the bug may already be fixed or the test does not reproduce the
issue correctly. Stop and discuss with the user before proceeding.

> ✅ Reproduction test written and confirmed failing.
> Now implementing the fix...

---

### Step 5 — Locate the Affected Code

Search for the code responsible for the behaviour described in the issue.

**5a — Extract search terms from the issue**

Identify symbols, route paths, function names, error messages, or database table names
mentioned in the issue title or description.

**5b — Search the codebase**

```bash
# Search for route handlers
grep -rn "[route path or endpoint]" src/routes/ --include="*.ts" -l

# Search for service methods
grep -rn "[function or method name]" src/services/ --include="*.ts" -l

# Search by error message string
grep -rn "[exact error message from issue]" src/ --include="*.ts" -l
```

**5c — Map the call chain**

Once the primary location is found, trace the call chain from entry point (route) through
to the service layer and any Postgres/Redis calls. List the files involved:

> **Affected files identified:**
> - `[file path]` — [role: route handler | service | middleware | utility]
> - `[file path]` — [role]
>
> **Root cause location:** `[primary file:line]`

If multiple possible root causes are found, ask the user to confirm which is the correct
area before proceeding.

---

### Step 6 — Implement the Fix

**6a — Minimal scope discipline**

Implement only what is needed to close this issue. Do not:
- Refactor unrelated code in the same files
- Rename variables or functions not involved in the bug
- Add new features not described in the issue
- Change formatting in lines not being modified

If you notice a separate problem while reading the code, make a note of it for a separate
issue — do not fix it here.

**6b — Write the fix**

Implement the fix in the affected files. Add a comment on the changed line(s) or the
enclosing function referencing the issue ID:

```typescript
// Fix: $ARGUMENTS — [short description of what was wrong]
```

**6c — Check for related call sites**

After fixing the primary location, search for other places in the codebase that
call the same function or use the same pattern:

```bash
grep -rn "[fixed function name]" src/ --include="*.ts" -l
```

Verify that none of these call sites are affected by the same bug or broken by the fix.

---

### Step 7 — Verify the Fix

**7a — Run the specific reproduction test (Bug) or targeted test (Enhancement/Task)**

```bash
npm test -- [relevant test file]
```

Confirm the previously failing test now passes. If it still fails, the fix is incomplete —
do not proceed to the full test suite.

**7b — Handle missing test coverage**

If no tests exist for the affected area (identified in Step 4b or during the fix):

> ⚠️ **No tests found for the affected area.**
> Writing a basic test suite for `[affected module]` to establish coverage before this
> change ships.

Write the minimum tests needed to cover:
1. The bug scenario (for bugs) or the new behaviour (for enhancements)
2. The primary happy path for the affected unit
3. The most important error/edge case

**7c — Run the full test suite**

```bash
npm test
```

All tests must pass. If pre-existing tests fail, determine whether:
- Your fix introduced a regression (fix it)
- The pre-existing test was incorrectly testing the buggy behaviour (update the test and
  document the reasoning)

Do not suppress or skip failing tests. Report the result:

> **Test suite result:**
> - [N] tests passed
> - [N] tests failed (list them if any)
> - [N] tests skipped

---

### Step 8 — Update the Spec If Needed

Read the issue description and the fix you implemented. Determine whether the bug reveals
a gap or an inaccuracy in the documented behaviour.

```bash
ls specs/*.spec.md 2>/dev/null
```

If a spec file exists for the affected feature:
- Read the relevant acceptance criteria
- If the bug was caused by behaviour that is undocumented or incorrectly documented,
  update the spec to reflect the correct intended behaviour
- Add a note: `> Clarified: $ARGUMENTS — [what was wrong and what is now correct]`

If no spec file exists for the affected area, note it:

> ⚠️ **No spec found for the affected feature.**
> Recommend creating one retroactively with `/spec-feature "[feature name]"` to document
> the intended behaviour for future reference.

Do not create a full spec from scratch in this session — that is the job of `/spec-feature`.

---

### Step 9 — Stage Changes and Produce the Commit Message

**9a — Show the diff**

```bash
git diff --stat
git diff
```

Review the diff. Confirm:
- Only files related to the issue are changed
- No debug code, `console.log` (should be `logger.*`), or temporary scaffolding is included
- No unintended whitespace or formatting changes are included

**9b — Stage the changes**

```bash
git add [list each file individually — do not use git add .]
```

Staging files individually prevents accidentally committing unrelated working-tree changes.

**9c — Produce the conventional commit message**

Provide the commit message for the user to review before they run `git commit`:

```
fix: [issue title in sentence case] ($ARGUMENTS)

[One to three sentences explaining:
- What was wrong (the root cause)
- What the fix does
- Why this approach was chosen over alternatives, if non-obvious]

Closes $ARGUMENTS
```

Example:
```
fix: refresh token rotation allows replay within a 1s window (PROJ-1234)

The reuse check compared token hashes before the new token's Redis key was
written, allowing a concurrent request to slip through. Fixed by writing the
revocation marker before issuing the replacement token.

Closes PROJ-1234
```

Present the message and ask:
> Does this commit message look correct? (yes / edit)

Wait for approval before presenting the next steps.

---

### Step 10 — Hand Off to Review and PR

After the commit message is approved, present the next steps:

> ✅ **Fix complete for `$ARGUMENTS`.**
>
> **Summary of changes:**
> - Files modified: [list]
> - Tests added/updated: [list]
> - Spec updated: [yes — `specs/[name].spec.md` | no]
>
> **Next steps:**
> 1. Run `/review` — adversarial spec-compliance review before creating the PR
> 2. Address any findings `/review` raises
> 3. Run `/pr-create` to generate the PR description with `Closes $ARGUMENTS` linked
>
> ⚠️ Do not create the PR manually — use `/pr-create` so the description follows
> the project's PR template and includes the correct issue link.

---

## Error Handling Reference

| Situation | Action |
|-----------|--------|
| Tracker API not configured (no env vars) | Ask user to paste issue text; proceed from pasted content |
| Issue ID not found (404) | Stop; ask user to verify ID and credentials |
| Issue fetch succeeds but description is empty | Ask user to provide context; do not guess at intent |
| No tests exist for the affected area | Write baseline tests before implementing the fix (Step 7b) |
| Reproduction test does not fail as expected | Stop; discuss with user — bug may be pre-fixed or test is wrong |
| Full test suite has pre-existing failures | Report them; do not hide them; ask if they are known failures |
| Fix requires scope beyond the issue (e.g., schema migration) | Stop; flag to user; get explicit approval before expanding scope |
| More than 5 files need to change | Stop; flag as potentially too broad; discuss with user before proceeding |

---

## Constraints for This Skill

- **Reproduce before fixing.** For bugs, a failing test must exist before implementation code changes. No exceptions.
- **Minimal scope only.** Do not refactor, rename, or clean up code outside the direct fix path.
- **Reference the issue ID everywhere.** Every changed block must carry a `// Fix: $ARGUMENTS` comment. Every commit must include `Closes $ARGUMENTS`.
- **Never suppress failing tests.** If the full test suite fails after the fix, the session must stop and diagnose — not skip or ignore.
- **Do not invent acceptance criteria.** If the issue description is vague, ask the user to clarify rather than assuming.
- **Do not create a PR.** Hand off to `/review` first, always. An unreviewed fix is not a complete fix.
- **Fall back gracefully.** If the tracker API is unavailable, the skill continues with user-pasted content — it does not abort.
