/**
 * System router — /health and /ready endpoints (FR-24).
 *
 * Both routes are excluded from rate limiting and audit logging, and
 * require no authentication. They are mounted once, at `/`, in
 * src/index.ts — previously this router was mounted twice (at both
 * `/health` and `/ready`), which meant `GET /ready` actually hit the
 * liveness handler; defining both paths explicitly here fixes that.
 */

import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { redis } from '../services/token.service.js';
import { logger } from '../config/logger.js';

export const systemRouter = Router();

// GET /health — liveness probe. No dependency checks (FR-24: succeeds even
// when DB/Redis are temporarily down, so Kubernetes doesn't kill a pod that
// just needs its dependencies to recover).
systemRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// GET /ready — readiness probe. Checks Postgres + Redis connectivity.
systemRouter.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, 'ok' | 'error'> = {
    postgres: 'ok',
    redis: 'ok',
    // Hardcoded until the FR-16 route-config loader exists (out of scope
    // this phase) — there is no route config to fail to load yet.
    routes: 'ok',
  };

  const results = await Promise.allSettled([
    db.execute(sql`SELECT 1`),
    redis.ping(),
  ]);

  const [postgresResult, redisResult] = results;

  if (postgresResult?.status === 'rejected') {
    checks.postgres = 'error';
    const err: unknown = postgresResult.reason;
    logger.warn('Readiness check: Postgres unreachable', { err });
  }
  if (redisResult?.status === 'rejected') {
    checks.redis = 'error';
    const err: unknown = redisResult.reason;
    logger.warn('Readiness check: Redis unreachable', { err });
  }

  const healthy = Object.values(checks).every((status) => status === 'ok');

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ready' : 'unavailable',
    checks,
  });
});
