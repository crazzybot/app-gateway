/**
 * Drizzle ORM client singleton.
 *
 * A single `pg.Pool` is created once and re-used across the process lifetime.
 * The pool is closed during graceful shutdown in src/index.ts.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import * as schema from './schema.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
