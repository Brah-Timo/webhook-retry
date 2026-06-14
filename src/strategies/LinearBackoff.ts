// ============================================================
//  LinearBackoff.ts
//
//  Formula: delay = initialDelay × (attempt + 1)
//
//  Example (initialDelay=2):
//  attempt 0 → 2s, 1 → 4s, 2 → 6s, 3 → 8s …
// ============================================================

export class LinearBackoff {
  constructor(
    private readonly initialDelay: number = 1,
    private readonly maxDelay: number = 3600,
    private readonly useJitter: boolean = false
  ) {}

  calculate(attempt: number): number {
    const base = Math.min(this.maxDelay, this.initialDelay * (attempt + 1));
    return this.useJitter ? Math.random() * base : base;
  }
}
