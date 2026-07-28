import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One shared Postgres/Redis container pair for the whole run, started
    // before any test file's imports execute (env.ts reads DATABASE_URL/
    // REDIS_URL from process.env at module load time).
    globalSetup: ['./tests/integration/globalSetup.ts'],
    // Testcontainers spins up shared Postgres/Redis containers per file; running
    // files in parallel worker processes just multiplies container startup cost
    // without any isolation benefit, so run them sequentially in one process.
    fileParallelism: false,
  },
});
