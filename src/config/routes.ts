/**
 * Route configuration loader (FR-16).
 *
 * Reads `UPSTREAM_SERVICES_CONFIG_PATH`, validates every entry with
 * `routeConfigListSchema`, and exits the process with a descriptive error on
 * any failure — same fail-fast contract as `config/env.ts`.
 *
 * Real per-environment route entries are populated by Backend Platform via
 * the mounted config file/ConfigMap (Open Question 1 resolution); this repo
 * ships only the illustrative example at `upstream-services.json` for local
 * dev and tests.
 */

import { readFileSync } from 'node:fs';
import { env } from './env.js';
import { routeConfigListSchema } from '../schemas/route.schemas.js';
import type { RouteConfig } from '../types/index.js';

function loadRouteConfig(): RouteConfig[] {
  try {
    const raw = readFileSync(env.UPSTREAM_SERVICES_CONFIG_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    const result = routeConfigListSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues
        .map((i) => `  [${i.path.join('.')}] ${i.message}`)
        .join('\n');
      throw new Error(`Route configuration failed validation:\n${details}`);
    }

    return result.data;
  } catch (error) {
    // Use console.error here — logger.ts itself imports env.ts, and this can
    // run before the logger is safe to use; same rationale as env.ts.
    // eslint-disable-next-line no-console
    console.error(
      `\n❌  Failed to load route configuration from ` +
        `${env.UPSTREAM_SERVICES_CONFIG_PATH}:\n${(error as Error).message}\n\n` +
        'Fix the configuration and restart the service.\n',
    );
    return process.exit(1);
  }
}

export const routeConfig: RouteConfig[] = loadRouteConfig();
