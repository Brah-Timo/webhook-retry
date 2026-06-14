// ============================================================
//  RetryEngine.ts — Calculates delays & decides retry/give-up
// ============================================================

import type { RetryConfig, RetryStrategyFn, RetryScheduleEntry } from '../types/retry.types.js';
import type { AttemptResult } from '../types/webhook.types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('RetryEngine');

/** Resolved, fully-defaulted configuration. */
interface ResolvedConfig {
  retry: RetryStrategyFn;
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  factor: number;
  jitter: boolean;
  deadLetter: boolean;
  retryableStatuses: number[];
  onRetry: NonNullable<RetryConfig['onRetry']>;
  onDeadLetter: NonNullable<RetryConfig['onDeadLetter']>;
}

const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

export class RetryEngine {
  private readonly cfg: ResolvedConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    const strategyFn = this.resolveStrategyFn(config);

    this.cfg = {
      retry: strategyFn,
      maxRetries: config.maxRetries ?? 5,
      initialDelay: config.initialDelay ?? 1,
      maxDelay: config.maxDelay ?? 3600,
      factor: config.factor ?? 2,
      jitter: config.jitter ?? true,
      deadLetter: config.deadLetter ?? true,
      retryableStatuses: config.retryableStatuses ?? [...DEFAULT_RETRYABLE_STATUSES],
      onRetry: config.onRetry ?? (() => { /* noop */ }),
      onDeadLetter: config.onDeadLetter ?? (() => { /* noop */ }),
    };
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * Calculate the delay (in seconds) before the `attempt`-th retry.
   * `attempt` is 0-based (0 = first retry after initial failure).
   *
   * Applies jitter using the Full-Jitter algorithm:
   *   final = random(0, min(maxDelay, baseDelay))
   */
  calculateDelay(attempt: number): number {
    let base = this.cfg.retry(attempt);
    base = Math.min(base, this.cfg.maxDelay);
    base = Math.max(0, base);

    if (this.cfg.jitter) {
      return Math.random() * base;
    }
    return base;
  }

  /**
   * Return the absolute timestamp for the next attempt.
   */
  getNextAttemptTime(attempt: number): Date {
    const delaySec = this.calculateDelay(attempt);
    return new Date(Date.now() + delaySec * 1000);
  }

  /**
   * Decide whether a failed attempt should be retried.
   *
   * Returns `false` when:
   * - `attempts` has reached or exceeded `maxRetries`
   * - The HTTP status code is non-retryable (e.g. 400, 403)
   */
  shouldRetry(attempts: number, result: AttemptResult): boolean {
    if (attempts >= this.cfg.maxRetries) {
      log.warn(
        { attempts, maxRetries: this.cfg.maxRetries },
        'Max retries reached — giving up'
      );
      return false;
    }

    if (
      result.statusCode !== undefined &&
      !this.cfg.retryableStatuses.includes(result.statusCode)
    ) {
      log.info(
        { statusCode: result.statusCode },
        'Non-retryable HTTP status — skipping retry'
      );
      return false;
    }

    return true;
  }

  /**
   * Fire the `onRetry` callback (non-throwing).
   */
  notifyRetry(attempt: number, error: string, nextDelaySec: number): void {
    try {
      this.cfg.onRetry(attempt, error, nextDelaySec);
    } catch (err) {
      log.warn({ err }, 'onRetry callback threw an error');
    }
  }

  /**
   * Fire the `onDeadLetter` callback (non-throwing).
   */
  async notifyDeadLetter(
    event: Parameters<NonNullable<RetryConfig['onDeadLetter']>>[0],
    attempts: number
  ): Promise<void> {
    try {
      await this.cfg.onDeadLetter(event, attempts);
    } catch (err) {
      log.warn({ err }, 'onDeadLetter callback threw an error');
    }
  }

  /**
   * Return a full projected retry schedule (no jitter applied,
   * for display purposes only).
   */
  getRetrySchedule(): RetryScheduleEntry[] {
    const schedule: RetryScheduleEntry[] = [];
    let cumulativeMs = 0;

    for (let i = 0; i < this.cfg.maxRetries; i++) {
      // Use base delay without jitter for deterministic display
      const raw = this.cfg.retry(i);
      const delaySec = Math.min(raw, this.cfg.maxDelay);
      cumulativeMs += delaySec * 1000;

      schedule.push({
        attempt: i + 1,
        delaySeconds: delaySec,
        scheduledAt: new Date(Date.now() + cumulativeMs),
      });
    }

    return schedule;
  }

  get maxRetries(): number {
    return this.cfg.maxRetries;
  }

  get usesDeadLetter(): boolean {
    return this.cfg.deadLetter;
  }

  // ─── Private helpers ───────────────────────────────────────

  private resolveStrategyFn(config: Partial<RetryConfig>): RetryStrategyFn {
    const { retry, initialDelay = 1, factor = 2, maxDelay = 3600 } = config;

    if (typeof retry === 'function') return retry;

    switch (retry ?? 'exponential') {
      case 'exponential':
        return (attempt) =>
          Math.min(maxDelay, initialDelay * Math.pow(factor, attempt));

      case 'linear':
        return (attempt) =>
          Math.min(maxDelay, initialDelay * (attempt + 1));

      case 'fixed':
        return (_attempt) => initialDelay;

      default:
        throw new Error(`Unknown retry strategy: "${String(retry)}"`);
    }
  }
}
