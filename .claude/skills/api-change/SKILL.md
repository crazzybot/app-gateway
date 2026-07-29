---
name: api-change
description: Guided API-first workflow for adding or changing an endpoint — updates specs/openapi.yaml first, then the hand-written Zod schema in src/schemas/, then the route/service code, since this project has no codegen step. Use for any new or modified REST endpoint.
---

# Skill: /api-change — API-First Endpoint Workflow

## Usage
```
/api-change "description of the new or modified endpoint"
```

Examples:
```
/api-change "add POST /v1/oauth/introspect to accept a token and return its active state"
/api-change "add pagination to GET /v1/auth/sessions — currently returns all sessions"
/api-change "add revoked_at field to the RefreshToken response schema"
```

---

## What This Skill Does

This skill implements the **API-first, contract-driven** workflow mandated by this project's
`CLAUDE.md`. The OpenAPI specification at `specs/openapi.yaml` is **always updated first**
— before any route handler, service, or Zod schema code is touched.

**This project does not use codegen.** There is a single Express application with no
separate frontend or mobile client, so there is no generated client to regenerate. The
Zod schemas in `src/schemas/` are hand-written and must be kept in sync with
`specs/openapi.yaml` manually — that manual sync is exactly what this skill (and the
`api-contract-checker` agent) exists to enforce.

**Workflow order (mandatory — do not skip or reorder steps):**

```
1. Read current spec context
2. Draft and review the OpenAPI change
3. Write the OpenAPI spec change (human approves diff)
4. Add/update the matching Zod schema in src/schemas/
5. Implement the route handler and service logic
6. Write/update tests
7. Verify the contract checker passes
```

This order prevents the most common failure mode: implementing an endpoint and then writing
a spec that documents what was built rather than what was agreed.

---

## Full Workflow Prompt

Execute the following steps in order. Announce each step before executing it.

---

### Step 1 — Context Gathering (Read-Only)

Read the following files to establish context before making any changes:

1. **`specs/openapi.yaml`** — read the full spec to understand:
   - Existing endpoint patterns (method, path structure, naming conventions under `/v1/`)
   - Existing schema components in `components/schemas/`
   - Security scheme definitions (bearer JWT)
   - Standard error response envelope
   - Pagination pattern, if any existing list endpoint has one

2. **`src/routes/`** — scan the directory to understand:
   - How routers are structured (Express Router pattern, `*.router.ts` naming)
   - How `authenticate` middleware is applied
   - How `validate` middleware is applied against a Zod schema

3. **`src/services/`** — scan one representative service (e.g., `token.service.ts`) to understand:
   - The `Result<T, AppError>` return pattern
   - How the service layer interacts with Drizzle

4. **`src/middleware/errorHandler.ts`** — read to understand how `AppError` subclasses
   are mapped to HTTP status codes.

5. **Relevant spec in `specs/`** — if a feature spec exists for this API change, read it.
   The OpenAPI change must reflect the spec's intent precisely.

After reading, summarise what you found:

> **Context summary:**
> - OpenAPI version: [e.g., 3.1.0]
> - Auth scheme: [Bearer JWT in Authorization header]
> - Path prefix: [e.g., /v1/]
> - Error envelope: [e.g., `{ error: string, code: string, details?: object }`]
> - Route structure: [e.g., Express Router in src/routes/[resource].router.ts]
> - Service pattern: [Result<T, AppError> returned from service functions]

Ask the user to confirm the context is correct before proceeding.

---

### Step 2 — Draft the OpenAPI Change (Plan Only)

**Do not modify any file in this step.** Produce a draft of the OpenAPI changes and
present them for human review.

For the requested change (`$ARGUMENTS`), draft:

**2a — New/Modified Path Entry**

Show the complete YAML block that will be added or modified under `paths:`. Include:
- Operation object: `operationId`, `summary`, `description`, `tags`
- `security`: include `[{bearerAuth: []}]` unless this is a public endpoint (e.g., JWKS, health)
- `parameters`: all path, query, and header parameters with types, descriptions, required flags
- `requestBody`: with `content: application/json` schema (inline or `$ref`)
- `responses`: complete — at minimum 200/201/204 (success), 400 (validation), 401, 403, 404 (if applicable), 422 (business logic), 500
- For list endpoints: include pagination query params and paginated response envelope

**2b — New Schema Components**

Show any new entries needed under `components/schemas/`. Use `$ref` in the path entry
for any reusable schema. Follow existing schema naming conventions.

**2c — Breaking Change Assessment**

State explicitly:
- Is this a **new endpoint**? (Always non-breaking)
- Is this **adding optional fields to an existing response**? (Non-breaking)
- Is this **adding required fields to an existing request**? (**BREAKING** — flag and ask for confirmation)
- Is this **removing or renaming fields**? (**BREAKING** — require explicit approval)
- Is this **changing a field type**? (**BREAKING** — require explicit approval)

For any BREAKING change: do not proceed without explicit user confirmation. Display:
> ⚠️ **Breaking Change Detected**
> This change will break existing clients that have not been updated.
> Confirm you want to proceed. (yes/no)

**2d — Present the Draft**

Format the draft as a readable diff showing exactly what will be added/changed in `specs/openapi.yaml`.

> Here is the OpenAPI change I'll apply. Review it carefully — this becomes the contract
> that the route handler and Zod schema must implement.
>
> [Show the YAML diff]
>
> Does this accurately represent the intended API contract? (yes / adjust: [corrections])

Wait for explicit approval before Step 3.

---

### Step 3 — Apply the OpenAPI Spec Change

With user approval, write the changes to `specs/openapi.yaml`.

Be precise: add to the correct location in the file, maintain consistent indentation,
preserve all existing content. Do not reformat the entire file.

After writing, verify the change is syntactically valid:
```bash
npx @apidevtools/swagger-parser validate specs/openapi.yaml
```

If validation fails, fix the YAML syntax error before proceeding.

Report:
> ✅ `specs/openapi.yaml` updated and validated.

---

### Step 4 — Add or Update the Zod Schema

Create or update the request/response validation schema in `src/schemas/[resource].schemas.ts`
so it matches the OpenAPI schema exactly:

- Every `required` field in the OpenAPI request body → a non-optional Zod field
- Every `nullable: true` field → `.nullable()`
- String `format`/`minLength`/`maxLength`/`pattern` → the matching Zod string refinement
- `enum:` values → `z.enum([...])` with identical members

Run TypeScript compilation to verify the schema compiles cleanly:

```bash
npm run typecheck
```

Report:
> ✅ Zod schema updated in `src/schemas/[resource].schemas.ts`. TypeScript compilation: PASS.

---

### Step 5 — Implement the Route Handler

Now implement the backend. The implementation must conform to the OpenAPI spec
that was approved in Step 2 — not the other way around.

**5a — Create or update the route file**

File location: `src/routes/[resource].router.ts`

Follow the existing router pattern exactly. The route handler must:
- Apply the `authenticate` middleware (from `src/middleware/authenticate.ts`) if the endpoint requires auth
- Apply the `validate` middleware factory (from `src/middleware/validate.ts`) against the Zod schema from Step 4
- Call a service method (do not put business logic in the route handler)
- Return the response with the status code defined in the OpenAPI spec
- Unwrap the `Result<T, AppError>` returned by the service and call `next(err)` on failure —
  the global error handler (`src/middleware/errorHandler.ts`) formats the response
- Not include any fields in the response that are not in the OpenAPI spec

**5b — Create or update the service method**

File location: `src/services/[Resource]Service.ts` (or the existing service file for
this resource)

The service method must:
- Contain all business logic
- Return `Result<T, AppError>` — never throw for expected failure paths
- Be independently testable (no HTTP-level dependencies)
- Use the Drizzle query builder for persistence — no raw SQL
- Be fully typed with TypeScript — no `any`, use `X | null` not `Optional[X]`

**5c — Create or update the database query (if data model changes are needed)**

If the endpoint requires schema changes, stop and remind the user:
> ⚠️ This endpoint requires a database schema change. Run `/db-migration` to create the migration first.
> Do not implement the service layer until the migration exists and has been reviewed.

If no schema changes are needed, proceed.

**5d — Register the route**

Ensure the new router or route is registered in `src/app.ts` with the correct path prefix.

---

### Step 6 — Generate and Run Tests

**6a — Route integration tests**

Create integration tests in `tests/integration/[resource].test.ts`.

Write tests for every response code defined in the OpenAPI spec:
- Success case (200/201/204): valid request → expected response shape
- Validation error (400): missing required field, wrong type, invalid format
- Unauthenticated (401): no token, expired token
- Forbidden (403): valid token but insufficient scope (if applicable)
- Not found (404): valid request for non-existent resource (if applicable)
- Business logic rejection (422): valid format but semantically invalid (if applicable)

Each test must assert:
1. The HTTP status code
2. The response body shape (at minimum the top-level fields)
3. For error responses: the error code field matches the documented code

Use real Postgres + Redis via Testcontainers — do not mock the database or Redis here.

**6b — Service unit tests**

Create unit tests in `tests/unit/[resource].service.test.ts`.
Mock `ioredis`/`pg` per project convention. Test:
- Happy path: expected return value
- Each error condition the service can return
- Edge cases from the feature spec

**6c — Run the tests**

```bash
npm test -- [resource]
```

All tests must pass before this step is complete. Fix any failures before proceeding.

---

### Step 7 — Contract Verification

Run the API contract checker to verify the implementation matches the spec:

```
Use the @.claude/agents/api-contract-checker.md subagent to verify the API changes
for this endpoint are consistently reflected across:
1. specs/openapi.yaml (just updated)
2. src/schemas/ (just updated)
3. src/routes/ (just implemented)

Report any inconsistency.
```

If the contract checker reports any BLOCKER or WARNING findings, resolve them before
considering the workflow complete.

---

### Step 8 — Summary Report

Report the completed workflow:

> ## /api-change Complete ✅
>
> **Endpoint:** [METHOD] [path]
> **Breaking change:** [Yes — [details] | No]
>
> **Files modified:**
> - `specs/openapi.yaml` — spec updated
> - `src/schemas/[file].schemas.ts` — Zod schema [created | updated]
> - `src/routes/[file].router.ts` — route handler [created | updated]
> - `src/services/[file].ts` — service method [created | updated]
> - `tests/unit/[files]`, `tests/integration/[files]` — tests written
>
> **Tests:** N passing, 0 failing
> **Contract check:** PASS
> **TypeScript:** PASS
>
> **Next steps:**
> - Run `/review` to run the adversarial spec-compliance review
> - Run `/pr-create` when the full feature is complete

---

## Constraints for This Skill

- The OpenAPI spec is ALWAYS updated before any implementation code.
- NEVER implement an endpoint and then write the spec to match — the spec defines the contract, not the implementation.
- There is no codegen in this project — `src/schemas/` is hand-written and must be kept in sync with `specs/openapi.yaml` manually at every change.
- For breaking changes: require explicit user confirmation and warn about client impact.
- For auth changes to existing endpoints: always check with the user before adding or removing auth requirements — this is a deployment-order-sensitive breaking change.
- If database schema changes are needed, delegate to `/db-migration` rather than creating ad-hoc SQL.
