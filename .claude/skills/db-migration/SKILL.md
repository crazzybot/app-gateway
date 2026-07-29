---
name: db-migration
description: Guided Drizzle ORM schema-change workflow — edit src/db/schema.ts, generate the migration with drizzle-kit, review the generated SQL, and assess safety/rollback. Use for any table, column, or index change.
---

# Skill: /db-migration — Guided Drizzle Migration Workflow

## Usage
```
/db-migration "description of the schema change"
```

Examples:
```
/db-migration "add revoked_at nullable timestamp column to refresh_tokens table"
/db-migration "add composite index on (user_id, created_at) to audit_log table"
/db-migration "add oauth_clients table for client-credentials flow"
/db-migration "rename column user_id to created_by on audit_log table"
```

---

## What This Skill Does

This project uses **Drizzle ORM with drizzle-kit** (`dialect: 'postgresql'`, schema at
`src/db/schema.ts`, migrations output to `src/db/migrations/`, per `drizzle.config.ts`).
Migrations are **generated from a schema diff** — you do not hand-write the SQL file the way
you would with Knex or raw SQL. The workflow is:

```
1. Edit src/db/schema.ts to describe the desired end state
2. Run `npm run db:generate` (drizzle-kit generate) — it diffs the schema against the
   last snapshot in src/db/migrations/meta/ and writes a new numbered .sql file
3. Review the generated SQL — do not hand-edit it; if it's wrong, fix schema.ts and
   regenerate
4. Apply it to the dev database with `npm run db:migrate` and validate
```

**Important Drizzle-specific facts this skill must respect:**
- `drizzle-kit generate` produces **up-only** SQL. There is no automatic `down` migration.
  Rollback requires either a hand-written compensating migration or a database restore —
  this skill documents the reverse SQL, it does not invent a `db:migrate:rollback` command
  that does not exist in this project's `package.json`.
- When a column is renamed, `drizzle-kit generate` will interactively ask "did you rename
  column X to Y, or create a new column?" — this skill must anticipate that prompt and
  tell the user how to answer it correctly, since an agent session may not be able to
  respond to an interactive CLI prompt.
- Never hand-edit a file in `src/db/migrations/*.sql` or `src/db/migrations/meta/`. If a
  generated migration is wrong, revert `schema.ts`, delete the just-generated (unapplied)
  migration file and its journal entry, fix `schema.ts`, and regenerate.

**This skill edits `schema.ts` and generates the migration only.** It does not modify
service layer code, route handlers, or Zod schemas. Those are separate implementation steps
(see `/api-change`) that follow after the migration is reviewed and approved.

---

## Full Workflow Prompt

Execute the following steps in order. Announce each step before executing it.

---

### Step 1 — Context Gathering (Read-Only)

Before editing anything, read the existing schema and migration history.

**1a — Read the current schema**
```bash
cat src/db/schema.ts
```

Identify: table naming (snake_case columns via explicit `text('column_name')` etc.),
existing index/constraint naming conventions, how nullable vs. required columns are
expressed, how timestamps are modelled (`timestamp(...).defaultNow()` etc.), how enums are
modelled if any exist.

**1b — Read existing migrations**
```bash
ls -la src/db/migrations/*.sql
cat src/db/migrations/meta/_journal.json
```

Confirm the current migration sequence and that the dev database is up to date
(`npm run db:migrate` with no pending changes reported) before starting — a dirty baseline
makes it hard to tell which SQL came from this change.

**1c — Read the relevant feature spec (if it exists)**

If a spec file exists in `specs/` for this feature, read the "Data Model Changes" section.
The schema change must implement exactly what the spec describes — not more, not less.

Summarise context:
> **Migration context:**
> - Tool: drizzle-kit (dialect: postgresql)
> - Schema file: `src/db/schema.ts`
> - Migrations dir: `src/db/migrations/`
> - Current migration count: N
> - Dev database status: [up to date | N pending migrations found — resolve before continuing]

Ask the user to confirm before proceeding.

---

### Step 2 — Migration Design (Plan Only)

**Do not edit `schema.ts` in this step.** Draft the schema change and safety assessment,
and present them for human review.

**2a — Analyse the requested change**

For the change described in `$ARGUMENTS`, classify it:

| Change Type | Lock Risk | Data Risk | Zero-Downtime Safe? |
|-------------|-----------|-----------|---------------------|
| Add new table | None | None | ✅ Yes |
| Add nullable column | Brief share lock | None | ✅ Yes |
| Add column with default | Share lock (may rewrite on older PG) | None | ⚠️ Depends on table size |
| Add NOT NULL column without default | Full table lock | None | ❌ No — requires default or backfill |
| Add index (`index(...)` in schema) | Full table lock unless `.concurrently()` | None | ⚠️ Use `CREATE INDEX CONCURRENTLY` — see 2d |
| Add foreign key | Full table lock (validates existing rows) | Validation scan | ⚠️ Consider `NOT VALID` + separate `VALIDATE` for large tables |
| Rename column | Full table lock; drizzle-kit will prompt rename-vs-recreate | None if answered correctly | ❌ No — use shadow-column pattern for zero downtime |
| Drop column | Full table lock | ⚠️ Irreversible (data loss) | ❌ Deploy in phases: stop writing → verify unused → drop |
| Drop table | Full table lock | ⚠️ Irreversible | ❌ Deploy in phases |
| Change column type | Full table lock + rewrite | ⚠️ May lose data/precision | ❌ Requires careful analysis |

For each destructive or high-lock-risk change, show the **safe deployment pattern**:

**Column rename safe pattern (3-phase deployment):**
```
Phase 1 (this migration): Add new column `revoked_by`, backfill from `user_id`, keep both
Phase 2 (application): Deploy code reading from `revoked_by`, writing to both columns
Phase 3 (next migration): Drop `user_id` after verifying no references remain
```

**2b — Draft the `schema.ts` diff**

Show the exact change to `src/db/schema.ts` — the new/modified column, index, or table
definition, following the existing conventions found in Step 1a.

**2c — Draft the manual rollback note**

Since `drizzle-kit generate` does not produce a `down` migration, write the reverse SQL by
hand for the rollback plan (even though it will not be applied automatically):

```sql
-- Manual rollback for [description] (drizzle-kit does not generate down migrations)
-- Run only if this migration must be reverted after deployment.
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS revoked_at;
```

For irreversible changes (dropped columns/tables, lossy type changes), mark clearly:
`-- IRREVERSIBLE: manual data recovery required from backup`

**2d — Note any commands that must run outside drizzle-kit**

Drizzle-kit's generated SQL runs each migration inside a transaction. If the change requires
`CREATE INDEX CONCURRENTLY` (cannot run inside a transaction), flag this explicitly:

> ⚠️ This index must be created with `CONCURRENTLY`, which cannot run inside drizzle-kit's
> transactional migration. After generating the migration, edit the generated SQL is NOT the
> answer — instead, apply this index via a one-off `psql`/admin script outside the migration
> system, and add an entry noting this in `src/db/migrations/` is skipped intentionally.
> Confirm this approach with the user before proceeding.

**2e — Safety assessment**

```
Migration Safety Assessment
════════════════════════════
Change: [description]
Table size risk: [Applies to: all | large tables only (>1M rows)]
Lock type: [None | Share | Exclusive | Note: needs CONCURRENTLY]
Data risk: [None | Irreversible column drop | Type change may truncate data]
Zero-downtime safe: [Yes | No — see deployment note]
Rollback: [Manual reverse SQL provided | Irreversible — see note]
Deployment note: [e.g., "Must deploy Phase 1 (migration) before Phase 2 (application code)"]
```

**2f — Present the draft**

> Here is the schema change I'll make. Review carefully — database migrations are difficult to undo in production.
>
> **Schema change (`src/db/schema.ts`):**
> ```typescript
> [paste draft diff]
> ```
>
> **Safety assessment:**
> [paste assessment]
>
> **Manual rollback (documented, not auto-applied):**
> ```sql
> [paste rollback SQL]
> ```
>
> Does this correctly implement the intended schema change? (yes / adjust: [corrections])

Wait for explicit approval before Step 3.

---

### Step 3 — Apply the Schema Change and Generate the Migration

**3a — Edit `src/db/schema.ts`** with the approved change from Step 2b.

**3b — Run drizzle-kit generate**

```bash
npm run db:generate
```

If drizzle-kit prompts interactively (e.g., "Is `revoked_by` renamed from `user_id`?"),
answer based on the intent confirmed in Step 2 — do not guess silently if it is ambiguous;
surface the prompt to the user and ask them to confirm the answer before proceeding.

**3c — Review the generated file**

```bash
cat src/db/migrations/[newest generated file].sql
```

Verify the generated SQL matches the intended change from Step 2. Do NOT hand-edit this
file. If it is wrong: revert the change in `schema.ts`, delete the unapplied generated
migration file and its entry in `src/db/migrations/meta/_journal.json`, fix `schema.ts`,
and regenerate.

Report:
> ✅ Migration generated: `src/db/migrations/[filename].sql`

---

### Step 4 — Apply and Validate

**4a — Apply to the dev database**

```bash
npm run db:migrate
```

**4b — Run validation queries**

Write and run queries to verify the migration applied correctly, e.g.:
```sql
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = '[table]' AND column_name = '[column]';

SELECT indexname FROM pg_indexes WHERE tablename = '[table]';
```

Report:
> ✅ Migration applied and validated:
> - `npm run db:migrate`: succeeded
> - Validation queries: all passed

If any step fails, fix `schema.ts` and regenerate (per Step 3c's revert procedure) before
proceeding — do not hand-patch the generated SQL.

---

### Step 5 — Final Report

Report the completed migration:

> ## /db-migration Complete ✅
>
> **Migration file:** `src/db/migrations/[filename].sql`
> **Change type:** [Add table | Add column | Add index | Rename | Drop | ...]
> **Safety:** [Zero-downtime safe | Requires maintenance window | Multi-phase deployment required]
> **Rollback:** [Manual reverse SQL documented above | Irreversible — see notes]
>
> **Pre-deploy checklist:**
> - [ ] Reviewer has read the generated SQL in `src/db/migrations/[filename].sql`
> - [ ] Estimated table size checked — confirm lock duration is acceptable
> - [ ] Manual rollback SQL reviewed (no automatic down migration exists for Drizzle)
> - [ ] Application code that uses the new schema has been implemented (`/api-change` if API-facing)
>
> **Next steps:**
> 1. Review the migration file: `src/db/migrations/[filename].sql`
> 2. Implement the service/route layer that uses the new schema (`/api-change` if this is API-facing)
> 3. Include this migration in your PR — reviewers must see migration + service + tests together

---

## Migration Safety Reference

Keep this reference in mind when designing schema changes. Never approve a change that:

1. **Runs a full-table rewrite on a large table without a maintenance window plan**
   - Adding a NOT NULL column without a default on a table with millions of rows will lock it for minutes
   - Adding a column with a volatile default causes a full table rewrite on older PostgreSQL versions

2. **Drops data without a confirmed backup**
   - Dropping a column/table is irreversible at the migration level
   - Always check with the user: "This will permanently delete data. Confirm a backup exists."

3. **Creates a non-concurrent index inside drizzle-kit's transactional migration on a large table**
   - PostgreSQL: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction — drizzle-kit's
     generated migrations always run in a transaction, so such an index must be created
     out-of-band (see Step 2d)

4. **Adds a foreign key without considering validation cost on a large table**
   - PostgreSQL validates all existing rows when adding a foreign key by default
   - On large tables, add `NOT VALID` manually and validate separately if drizzle-kit's
     default FK generation would lock too long (confirm with the user before deviating from
     the generated SQL)

---

## Constraints for This Skill

- This skill edits `src/db/schema.ts` and generates the migration ONLY. It does not modify service, route, or Zod schema code.
- Never hand-edit a generated file under `src/db/migrations/`. Fix `schema.ts` and regenerate instead.
- Every migration must have a documented manual rollback. If a true rollback is impossible (data deleted), document it clearly and mark `-- IRREVERSIBLE`.
- Do not modify already-applied migration files. Ever. Migrations are immutable history.
- For destructive changes, require explicit user confirmation with a specific warning about data loss.
- Do not include application logic in the schema change (no business rules, no HTTP calls).
- If `drizzle-kit generate` would prompt interactively for a rename decision, surface that decision to the user rather than guessing.
