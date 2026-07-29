/**
 * App Gateway Service — Entry Point
 *
 * Wires up the Express application, registers all middleware and route groups,
 * then starts the HTTP server. Also installs SIGTERM/SIGINT handlers for
 * graceful shutdown (draining in-flight requests before closing DB + Redis).
 *
 * The `app` object is exported separately so integration/e2e tests can import
 * it without triggering `listen()`.
 */

import 'dotenv/config';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import { createServer, type Server } from 'node:http';

// Internal imports (use @/ alias once tsconfig paths are wired up)
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { httpLogger } from './middleware/httpLogger.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { requestId } from './middleware/requestId.js';
import { authRouter } from './routes/auth.router.js';
import { oauthRouter } from './routes/oauth.router.js';
import { proxyRouter } from './routes/proxy.router.js';
import { systemRouter } from './routes/system.router.js';

// ---------------------------------------------------------------------------
// Application factory
// ---------------------------------------------------------------------------

export function createApp(): express.Express {
  const app = express();

  // ── Security headers (applied first, before any route logic) ─────────────
  app.use(helmet());

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Configure allowed origins via env in production; keep permissive for dev.
  app.use(
    cors({
      origin: env.NODE_ENV === 'production' ? env.ALLOWED_ORIGINS : true,
      credentials: true,
    }),
  );

  // ── Request ID ────────────────────────────────────────────────────────────
  // Attaches/forwards X-Request-ID so every log line is traceable.
  app.use(requestId);

  // ── HTTP access log ────────────────────────────────────────────────────────
  // Excludes /health and /ready internally (FR-24/FR-25, AC-34).
  app.use(httpLogger);

  // ── Body parsers ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));

  // ── Cookie parser ─────────────────────────────────────────────────────────
  app.use(cookieParser());

  // ── Route groups ──────────────────────────────────────────────────────────

  // System health / readiness probes — no auth required, no rate limiting,
  // no audit logging. Mounted once, at the root — the router itself defines
  // the /health and /ready paths (previously mounted twice at those two
  // prefixes, which made GET /ready hit the liveness handler by accident).
  app.use(systemRouter);

  // Auth + OAuth endpoints share the FR-22/NFR-3 default rate limit
  // (100 req/min/IP). OAuth routes are still 501 stubs this phase but the
  // limiter applies regardless, per FR-22's blanket scope.
  app.use(['/v1/auth', '/v1/oauth'], rateLimiter());

  // Auth routes: login, logout, token refresh, JWKS, SAML ACS
  app.use('/v1/auth', authRouter);

  // OAuth 2.0: authorize, token, introspect, revoke
  app.use('/v1/oauth', oauthRouter);

  // Reverse-proxy: authenticated pass-through to upstream micro-services
  app.use('/api', proxyRouter);

  // ── 404 catch-all (must come after all routes) ────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'The requested resource does not exist on this gateway.',
    });
  });

  // ── Global error handler (must be last, 4-argument signature) ────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    errorHandler(err, req, res);
  });

  return app;
}

// Export a pre-built app instance for test imports.
export const app = createApp();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Closes the HTTP server, then tears down DB and Redis connections.
 * Called on SIGTERM and SIGINT so Kubernetes / Docker stop works cleanly.
 */
async function shutdown(server: Server, signal: string): Promise<void> {
  logger.info('Received shutdown signal — starting graceful shutdown', { signal });

  await new Promise<void>((resolve, reject) => {
    // Stop accepting new connections; wait for in-flight requests to finish.
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    // Hard-kill safety net: force exit after 10 s regardless.
    setTimeout(() => {
      logger.warn('Graceful shutdown timed out — forcing exit');
      resolve();
    }, 10_000).unref();
  });

  // Tear down downstream connections.
  try {
    const { db } = await import('./db/client.js');
    // Drizzle wraps pg.Pool — call end() on the underlying pool.
    await db.$client?.end?.();
    logger.info('Database pool closed');
  } catch (err) {
    logger.warn('Error closing database pool', { err });
  }

  try {
    const { redis } = await import('./services/token.service.js');
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.warn('Error closing Redis connection', { err });
  }

  logger.info('Shutdown complete');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Server startup (skipped when imported in tests)
// ---------------------------------------------------------------------------

if (process.env['VITEST'] === undefined) {
  const port = env.PORT;
  const server = createServer(app);

  server.listen(port, () => {
    logger.info('App Gateway Service listening', { port, nodeEnv: env.NODE_ENV });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('Port already in use', { port });
    } else {
      logger.error('HTTP server error', { err });
    }
    process.exit(1);
  });

  const handleSignal = (signal: string) => {
    shutdown(server, signal).catch((err: unknown) => {
      logger.error('Unhandled error during shutdown', { err });
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // Catch unhandled promise rejections — log and exit so the process manager
  // can restart the container rather than leaving it in a broken state.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection — exiting', { reason });
    process.exit(1);
  });
}
