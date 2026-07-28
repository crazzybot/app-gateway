import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup/unit-env.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/db/migrations/**',
        // Declarative Drizzle table definitions — no branch/function logic
        // of its own to unit test; exercised transitively by integration
        // tests that hit a real Postgres instance.
        'src/db/schema.ts',
        // Exercised by tests/integration/*.test.ts (real HTTP via
        // supertest), not by mocked unit tests — see docs/kb testing notes.
        'src/routes/**',
        'src/index.ts',
        'src/db/client.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        'src/services/token.service.ts': {
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95,
        },
      },
    },
  },
});
