/**
 * Minimal thenable stand-in for a Drizzle query builder chain, used to mock
 * `@/db/client.js`'s `db` export in unit tests (CLAUDE.md: "Unit tests may
 * mock ... pg with vi.mock"). Every chain method returns the same builder;
 * awaiting the chain at any point resolves to `rows` via `.then`.
 */

import { vi, type Mock } from 'vitest';

export interface MockQueryBuilder {
  from: Mock;
  where: Mock;
  limit: Mock;
  orderBy: Mock;
  set: Mock;
  values: Mock;
  returning: Mock;
  then: (resolve: (value: unknown[]) => void) => void;
}

export function createChainableResult(rows: unknown[] = []): MockQueryBuilder {
  const builder = {} as MockQueryBuilder;
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.set = vi.fn(() => builder);
  builder.values = vi.fn(() => builder);
  builder.returning = vi.fn(() => Promise.resolve(rows));
  builder.then = (resolve) => {
    resolve(rows);
  };
  return builder;
}

/**
 * The real `db` export is typed as Drizzle's `NodePgDatabase<schema>`, whose
 * `select`/`insert`/`update` return specific PgSelectBuilder/PgInsertBuilder
 * types — `vi.mock` swaps the runtime value but not that static type, so
 * every test file that mocks `@/db/client.js` needs this one cast to treat
 * the imported `db` as the plain `vi.fn()` mock it actually is at runtime.
 */
export interface MockedDb {
  select: Mock;
  insert: Mock;
  update: Mock;
}

export function asMockedDb(db: unknown): MockedDb {
  return db as MockedDb;
}
