/**
 * Closes the per-test-file Postgres pool and Redis connection so the vitest
 * worker process can exit cleanly. Each integration test file gets its own
 * isolated module graph (vitest's default `isolate: true`), so this only
 * ever closes that file's own connections — never a sibling file's.
 */

import { db } from '@/db/client.js';
import { redis } from '@/services/token.service.js';

export async function closeConnections(): Promise<void> {
  // Drizzle wraps pg.Pool — same internal-access pattern as src/index.ts's
  // graceful shutdown.
  const withClient = db as unknown as { $client?: { end?: () => Promise<void> } };
  await withClient.$client?.end?.();
  await redis.quit();
}
