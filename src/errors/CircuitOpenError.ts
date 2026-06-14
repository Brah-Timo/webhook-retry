// ============================================================
//  CircuitOpenError.ts
// ============================================================

import { WebhookRetryError } from './WebhookRetryError.js';

/**
 * Thrown by `CircuitBreaker` when it is in the OPEN state,
 * meaning calls are being blocked to protect a failing dependency.
 */
export class CircuitOpenError extends WebhookRetryError {
  constructor(name: string, nextAttemptAt: Date) {
    super(
      `Circuit "${name}" is OPEN. Calls blocked until ${nextAttemptAt.toISOString()}`,
      'CIRCUIT_OPEN',
      { name, nextAttemptAt: nextAttemptAt.toISOString() }
    );
    this.name = 'CircuitOpenError';
  }
}
