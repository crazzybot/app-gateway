/**
 * Environment configuration — parsed and validated at startup with Zod.
 *
 * Import `env` everywhere you need a config value; never read `process.env`
 * directly in application code.
 *
 * The process will throw (and exit 1) if any required variable is absent or
 * has the wrong shape, giving an explicit error message rather than a
 * confusing runtime crash later.
 */

import { z } from 'zod';

const NodeEnvSchema = z.enum(['development', 'production', 'test']);

const EnvSchema = z.object({
  // ── Server ───────────────────────────────────────────────────────────────
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: NodeEnvSchema.default('development'),
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// URL'),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().url('REDIS_URL must be a valid redis:// URL'),

  // ── JWT signing ──────────────────────────────────────────────────────────
  JWT_PRIVATE_KEY_PATH: z
    .string()
    .min(1, 'JWT_PRIVATE_KEY_PATH is required'),
  JWT_PUBLIC_KEY_PATH: z
    .string()
    .min(1, 'JWT_PUBLIC_KEY_PATH is required'),
  JWT_ALGORITHM: z
    .enum(['RS256', 'RS384', 'ES256', 'ES384'])
    .default('RS256'),

  // ── Token lifetimes ───────────────────────────────────────────────────────
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000), // 30 days

  // ── SAML (optional — required only when SAML is enabled) ─────────────────
  SAML_SP_ENTITY_ID: z.string().optional(),
  SAML_SP_CALLBACK_URL: z.string().url().optional(),

  // ── Upstream proxy ────────────────────────────────────────────────────────
  UPSTREAM_SERVICES_CONFIG_PATH: z
    .string()
    .min(1, 'UPSTREAM_SERVICES_CONFIG_PATH is required'),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'debug'])
    .default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');

    // Use console.error here — logger hasn't been initialised yet.
    // eslint-disable-next-line no-console
    console.error(
      `\n❌  Environment configuration invalid:\n${messages}\n\n` +
        'Fix the above issues and restart the service.\n',
    );
    process.exit(1);
  }

  return result.data;
}

export const env: Env = parseEnv();
