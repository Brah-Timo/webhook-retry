// ============================================================
//  CircuitBreaker.ts — [PRO] Automatic fault isolation
//
//  State machine:
//
//    CLOSED ──(failures ≥ threshold)──► OPEN
//       ▲                                  │
//       │                                  │ (resetTimeout elapsed)
//       │                                  ▼
//    SUCCESS ◄──(probe succeeds)───── HALF_OPEN
//
//  CLOSED:    Normal operation. Every failure is counted.
//  OPEN:      All calls are rejected immediately.
//             Protects a downstream service that is clearly down.
//  HALF_OPEN: After `resetTimeout`, one probe call is allowed.
//             Success → CLOSED. Failure → OPEN again.
//
//  Usage:
//    const cb = new CircuitBreaker('stripe-api', {
//      failureThreshold: 5,   // open after 5 consecutive failures
//      resetTimeout: 60_000,  // try again after 60 seconds
//    });
//
//    // In your handler:
//    const result = await cb.execute(() => callStripeAPI());
// ============================================================

import { CircuitOpenError } from '../errors/CircuitOpenError.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CircuitBreaker');

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures needed to open the circuit.
   * @default 5
   */
  failureThreshold?: number;
  /**
   * How long (ms) to wait in OPEN state before transitioning to
   * HALF_OPEN for a probe call.
   * @default 60_000
   */
  resetTimeout?: number;
  /**
   * Number of consecutive successes in HALF_OPEN needed to
   * transition back to CLOSED.
   * @default 2
   */
  successThreshold?: number;
  /**
   * Callback fired whenever the state changes.
   */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: Date | null;
  nextAttemptAt: Date | null;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private lastFailureAt: Date | null = null;
  private nextAttemptAt: Date | null = null;
  private totalCalls = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;

  private readonly cfg: Required<CircuitBreakerConfig>;

  constructor(
    private readonly name: string,
    config: CircuitBreakerConfig = {}
  ) {
    this.cfg = {
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeout:     config.resetTimeout     ?? 60_000,
      successThreshold: config.successThreshold ?? 2,
      onStateChange:    config.onStateChange    ?? (() => { /* noop */ }),
    };
  }

  // ─── Main API ──────────────────────────────────────────────

  /**
   * Execute `fn` with circuit-breaker protection.
   *
   * @throws `CircuitOpenError` when the circuit is OPEN and the
   *         reset timeout has not yet elapsed.
   * @throws The original error from `fn` when it throws.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        throw new CircuitOpenError(this.name, this.nextAttemptAt!);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /**
   * Record a success event (use when not wrapping with `execute`).
   */
  recordSuccess(): void {
    this.onSuccess();
  }

  /**
   * Record a failure event (use when not wrapping with `execute`).
   */
  recordFailure(): void {
    this.onFailure();
  }

  /**
   * Manually force the circuit to CLOSED state.
   * Useful after an operator confirms the downstream is healthy.
   */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.transitionTo('CLOSED');
  }

  /**
   * Return a snapshot of internal counters and state.
   */
  getStats(): CircuitBreakerStats {
    return {
      name:          this.name,
      state:         this.state,
      failures:      this.failures,
      successes:     this.successes,
      lastFailureAt: this.lastFailureAt,
      nextAttemptAt: this.nextAttemptAt,
      totalCalls:    this.totalCalls,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  get currentState(): CircuitState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.state === 'OPEN';
  }

  // ─── State transitions ─────────────────────────────────────

  private onSuccess(): void {
    this.totalSuccesses++;
    this.failures = 0;

    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.cfg.successThreshold) {
        this.successes = 0;
        this.transitionTo('CLOSED');
      }
    }
  }

  private onFailure(): void {
    this.totalFailures++;
    this.failures++;
    this.successes = 0;
    this.lastFailureAt = new Date();

    if (
      (this.state === 'CLOSED' && this.failures >= this.cfg.failureThreshold) ||
      this.state === 'HALF_OPEN'
    ) {
      this.nextAttemptAt = new Date(Date.now() + this.cfg.resetTimeout);
      this.transitionTo('OPEN');
    }
  }

  private shouldAttemptReset(): boolean {
    return this.nextAttemptAt !== null && Date.now() >= this.nextAttemptAt.getTime();
  }

  private transitionTo(next: CircuitState): void {
    const prev = this.state;
    this.state = next;

    log.info(
      { circuit: this.name, from: prev, to: next },
      `Circuit breaker state: ${prev} → ${next}`
    );

    try {
      this.cfg.onStateChange(prev, next);
    } catch {
      /* callbacks must not crash the circuit breaker */
    }
  }
}
