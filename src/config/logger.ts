/**
 * Winston logger singleton.
 *
 * - In production: JSON output to stdout (structured log ingestion).
 * - In development / test: colourised, human-readable output.
 *
 * Import this instance everywhere; never use console.log/warn/error in
 * application code.
 */

import winston from 'winston';
import { env } from './env.js';

const { combine, timestamp, json, errors, colorize, simple } =
  winston.format;

const productionFormat = combine(
  errors({ stack: true }),
  timestamp(),
  json(),
);

const developmentFormat = combine(
  errors({ stack: true }),
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  simple(),
);

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format:
    env.NODE_ENV === 'production' ? productionFormat : developmentFormat,
  // AC-34: every JSON log line must carry `service: "app-gateway"`.
  defaultMeta: { service: 'app-gateway' },
  transports: [new winston.transports.Console()],
  // Prevent winston from exiting on uncaught exceptions — we handle those.
  exitOnError: false,
});
