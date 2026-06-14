// ============================================================
//  CustomStrategy.ts
//
//  Wraps a user-supplied function so it behaves like the other
//  built-in strategy classes (uniform `.calculate(attempt)` API).
// ============================================================

import type { RetryStrategyFn } from '../types/retry.types.js';

export class CustomStrategy {
  constructor(private readonly fn: RetryStrategyFn) {}

  calculate(attempt: number): number {
    return this.fn(attempt);
  }
}
