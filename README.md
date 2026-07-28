# App Gateway Service

Unified authentication and request-routing gateway for the multi-app platform.
Every client request — web, mobile, or machine-to-machine — enters through
this single ingress point, receives an authentication decision, and (once the
proxy phase lands) is forwarded to the appropriate upstream service.

Full behavioral spec: [`specs/app-gateway-auth.spec.md`](specs/app-gateway-auth.spec.md).
API contract: [`specs/openapi.yaml`](specs/openapi.yaml).

## Implementation status

This repo implements **Phase 1: core JWT authentication + infrastructure**.
SAML SSO, OAuth 2.0, and the reverse proxy are later phases and currently
return `501 Not Implemented`.

| Area | Status |
|---|---|
| Password login, refresh rotation (with reuse-detection), logout | ✅ Implemented |
| JWT access tokens (RS256, full claim set) + JWKS publication | ✅ Implemented |
| Redis-backed token revocation & rate limiting | ✅ Implemented |
| PII-at-rest encryption (`users.email`, AES-256-GCM + HMAC lookup) | ✅ Implemented |
| Audit logging (`audit_log` table) | ✅ Implemented |
| Health / readiness probes | ✅ Implemented |
| SAML 2.0 SSO | 🚧 Stubbed (`501`) |
| OAuth 2.0 authorization server | 🚧 Stubbed (`501`) |
| Reverse proxy to upstream services | 🚧 Stubbed (`501`) |

## Tech stack

| Layer | Technology |
|---|---|
| HTTP | Express 5, TypeScript 5 (strict) |
| Auth (JWT) | `jose` — RS256, JWKS |
| Database | PostgreSQL 16 via Drizzle ORM |
| Cache / revocation / rate limiting | Redis 7 via `ioredis` |
| Validation | `zod` at every external boundary |
| Logging | `winston` (JSON in prod, pretty in dev) |
| Testing | `vitest` + `supertest` + `testcontainers` |

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# .env already points JWT key paths at the committed dev/test keypair
# (tests/fixtures/keys/) — fine for local dev, never for production.

# 3. Start Postgres + Redis
docker compose -f docker-compose.dev.yml up -d postgres redis

# 4. Apply the database schema
npm run db:migrate

# 5. Seed a test user (no self-registration endpoint exists yet — see below)
npm run db:seed

# 6. Run the dev server (hot-reload via tsx)
npm run dev
```

The service listens on `http://localhost:3000` by default.

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/v1/auth/.well-known/jwks.json

curl -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"ChangeMe123!"}'
```

(`db:seed` creates `test@example.com` / `ChangeMe123!` by default; override
with `SEED_USER_EMAIL` / `SEED_USER_PASSWORD` env vars.)

### Full stack via Docker Compose

```bash
cp .env.example .env.development
docker compose -f docker-compose.dev.yml up --build
```

## API surface (Phase 1)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/auth/login` | None | Email/password → access + refresh token pair |
| `POST` | `/v1/auth/refresh` | Refresh token | Rotate refresh token, issue new pair |
| `POST` | `/v1/auth/logout` | Bearer | Revoke access + refresh token |
| `GET` | `/v1/auth/me` | Bearer | Authenticated user profile |
| `GET` | `/v1/auth/.well-known/jwks.json` | None | Publish JWKS public keys |
| `GET` | `/health` | None | Liveness probe |
| `GET` | `/ready` | None | Readiness probe (Postgres + Redis) |

`/v1/auth/saml/*`, `/v1/oauth/*`, and `/api/**` (proxy) all currently return
`501` — see the status table above.

## Testing

```bash
npm test                 # unit tests (mocked I/O, fast)
npm run test:coverage    # unit tests with coverage (≥80% global, ≥95% token.service.ts)
npm run test:integration # integration tests — spins up real Postgres+Redis via Testcontainers
npm run typecheck
npm run lint
```

Integration tests require Docker (Testcontainers starts `postgres:16-alpine`
and `redis:7-alpine` automatically — no manual setup needed).

## Project layout

```
src/
  index.ts          — Express app factory + graceful shutdown
  routes/           — auth.router.ts (implemented), oauth/proxy routers (stubs)
  middleware/        — authenticate, validate, rateLimiter, httpLogger, errorHandler
  services/          — token, user, refreshToken, audit (implemented);
                        saml, oauth, proxy (not yet implemented)
  schemas/           — Zod request schemas
  db/                — Drizzle schema + generated migrations
  config/            — env.ts (Zod-validated), logger.ts
  types/             — shared types, AppError hierarchy, Result<T, E>
  utils/             — crypto (JWT keys + PII encryption), time helpers
tests/
  unit/              — mocked-I/O tests (tests/unit/helpers/ has shared fakes)
  integration/        — real Postgres/Redis via Testcontainers globalSetup
  helpers/seedUser.ts — only way to create a `users` row (no register endpoint yet)
  fixtures/keys/      — dev/test-only RSA keypair, never for production
```

See [`CLAUDE.md`](CLAUDE.md) for full conventions (error handling, validation,
security rules, directory structure) and
[`specs/app-gateway-auth.spec.md`](specs/app-gateway-auth.spec.md) for the
complete functional spec covering all phases.
