// ============================================================
//  logger.ts — Structured logger built on pino
// ============================================================

import pino from 'pino';

const isDev =
  process.env['NODE_ENV'] !== 'production' &&
  process.env['NODE_ENV'] !== 'test';

const isSilent = process.env['NODE_ENV'] === 'test';

/**
 * The shared logger instance used across the entire package.
 *
 * In development:  pretty-printed, colorised output
 * In production:   compact JSON (structured logging for log aggregators)
 * In test:         silent (no output)
 *
 * Override the log level via the `WEBHOOK_RETRY_LOG_LEVEL` env variable.
 */
export const logger = isDev && !isSilent
  ? pino({
      name: 'webhook-retry',
      level: process.env['WEBHOOK_RETRY_LOG_LEVEL'] ?? 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    })
  : pino({
      name: 'webhook-retry',
      level: process.env['WEBHOOK_RETRY_LOG_LEVEL'] ?? (isSilent ? 'silent' : 'info'),
    });

/**
 * Create a child logger with a fixed `component` label.
 * Use this in each module for better log filtering.
 *
 * @example
 * const log = createLogger('RetryEngine');
 * log.info({ attempt: 3 }, 'Scheduling retry');
 */
export function createLogger(component: string): pino.Logger {
  return logger.child({ component });
}
