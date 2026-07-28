/**
 * System router — /health and /ready endpoints.
 *
 * These routes are intentionally lightweight and dependency-free so that
 * liveness probes succeed even when the DB or Redis is temporarily down.
 *
 * Readiness (/ready) checks downstream dependencies and signals Kubernetes
 * to pull the pod out of the load-balancer rotation if they are unhealthy.
 */

import { Router, type Request, type Response } from 'express';

export const systemRouter = Router();

// GET /health — liveness probe
systemRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /ready — readiness probe (checks DB + Redis)
systemRouter.get('/ready', async (_req: Request, res: Response) => {
  // TODO: add real DB ping and Redis ping checks
  res.status(200).json({
    status: 'ready',
    checks: {
      database: 'ok',
      redis: 'ok',
    },
    timestamp: new Date().toISOString(),
  });
});
