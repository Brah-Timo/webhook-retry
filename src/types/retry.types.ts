// ============================================================
//  retry.types.ts — Retry configuration & strategy contracts
// ============================================================

import type { WebhookEvent } from './webhook.types.js';

// ─────────────────────────────────────────────
//  Strategy
// ─────────────────────────────────────────────

/**
 * Built-in retry strategy names.
 *
 * | Name          | Formula                                 |
 * |---------------|-----------------------------------------|
 * | exponential   | `initialDelay × factor^attempt`         |
 * | linear        | `initialDelay × (attempt + 1)`          |
 * | fixed         | `initialDelay` (constant)               |
 * | custom        | user-supplied `RetryStrategyFn`         |
 */
export type RetryStrategyName =
  | 'exponential'
  | 'linear'
  | 'fixed'
  | 'custom';

/**
 * A user-supplied function that receives the attempt index (0-based)
 * and returns the desired delay **in seconds** before the next attempt.
 *
 * @example
 * // Fibonacci delays: 1s, 1s, 2s, 3s, 5s, 8s …
 * const fibonacci: RetryStrategyFn = (attempt) => {
 *   if (attempt <= 1) return 1;
 *   let a = 1, b = 1;
 *   for (let i = 2; i <= attempt; i++) [a, b] = [b, a + b];
 *   return b;
 * };
 */
export type RetryStrategyFn = (attempt: number) => number;

// ─────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────

/**
 * Full retry configuration accepted by `webhook.on()`.
 *
 * All fields are optional; sensible defaults are applied.
 */
export interface RetryConfig {
  /**
   * Which back-off strategy to use.
   * Pass a `RetryStrategyFn` for fully custom behaviour.
   * @default 'exponential'
   */
  retry?: RetryStrategyName | RetryStrategyFn;

  /**
   * Maximum number of delivery attempts **including the first one**.
   * After this the event is either discarded or moved to the DLQ.
   * @default 5
   */
  maxRetries?: number;

  /**
   * Delay for the first retry in seconds.
   * @default 1
   */
  initialDelay?: number;

  /**
   * Hard cap on any calculated delay (seconds).
   * Prevents waits of hours when the formula grows large.
   * @default 3600
   */
  maxDelay?: number;

  /**
   * Multiplier for the exponential strategy.
   * @default 2
   */
  factor?: number;

  /**
   * Apply full-jitter randomisation on top of the calculated delay.
   * Prevents the "thundering herd" problem in high-volume systems.
   * Formula: `delay = random(0, baseDelay)`  (AWS recommendation)
   * @default true
   */
  jitter?: boolean;

  /**
   * Move permanently-failing events to the Dead Letter Queue
   * instead of silently discarding them.
   * @default true
   */
  deadLetter?: boolean;

  /**
   * HTTP status codes that are considered transient failures
   * and therefore worth retrying.
   * Non-listed codes (e.g. 400, 401, 403) abort immediately.
   * @default [408, 429, 500, 502, 503, 504]
   */
  retryableStatuses?: number[];

  /**
   * Invoked each time a delivery attempt fails and a retry is scheduled.
   *
   * @param attempt   - Current attempt index (1-based for readability)
   * @param error     - Error message or HTTP status description
   * @param nextDelay - Seconds until the next attempt
   */
  onRetry?: (attempt: number, error: string, nextDelay: number) => void;

  /**
   * Invoked when an event exhausts all retries and is moved to the DLQ.
   *
   * @param event    - The original webhook event
   * @param attempts - Total number of attempts that were made
   */
  onDeadLetter?: (event: WebhookEvent, attempts: number) => void | Promise<void>;
}

// ─────────────────────────────────────────────
//  Retry schedule entry (observability)
// ─────────────────────────────────────────────

/**
 * A single slot in the projected retry schedule.
 * Returned by `RetryEngine.getRetrySchedule()` for dashboard display.
 */
export interface RetryScheduleEntry {
  /** 1-based attempt number. */
  attempt: number;
  /** Calculated delay in seconds (without jitter, for display). */
  delaySeconds: number;
  /** Absolute timestamp when this attempt will be executed. */
  scheduledAt: Date;
}
