// ============================================================
//  FixedDelay.ts
//
//  Formula: delay = initialDelay (constant regardless of attempt)
//
//  Best for:
//  - Rate-limited APIs that need consistent spacing
//  - Low-volume background jobs
// ============================================================

export class FixedDelay {
  constructor(private readonly delay: number = 5) {}

  calculate(_attempt: number): number {
    return this.delay;
  }
}
