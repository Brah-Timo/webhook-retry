// ============================================================
//  ExponentialBackoff.ts
//
//  Formula (Full Jitter — AWS recommended):
//    base  = min(maxDelay, initialDelay × factor^attempt)
//    delay = random(0, base)
//
//  Retry schedule example (initialDelay=1, factor=2, maxDelay=3600):
//  ┌─────────┬──────────────┬──────────────────────┐
//  │ Attempt │  Base (s)    │  Jittered range (s)  │
//  ├─────────┼──────────────┼──────────────────────┤
//  │    0    │    1         │   0.0  –   1.0       │
//  │    1    │    2         │   0.0  –   2.0       │
//  │    2    │    4         │   0.0  –   4.0       │
//  │    3    │    8         │   0.0  –   8.0       │
//  │    4    │   16         │   0.0  –  16.0       │
//  │    5    │   32         │   0.0  –  32.0       │
//  │    6    │   64         │   0.0  –  64.0       │
//  │    7    │  128         │   0.0  – 128.0       │
//  │    8    │  256         │   0.0  – 256.0       │
//  │    9    │  512         │   0.0  – 512.0       │
//  │   10    │ 1024         │   0.0  – 1024.0      │
//  │   11+   │ 3600 (cap)   │   0.0  – 3600.0      │
//  └─────────┴──────────────┴──────────────────────┘
// ============================================================

export class ExponentialBackoff {
  constructor(
    private readonly initialDelay: number = 1,
    private readonly factor: number = 2,
    private readonly maxDelay: number = 3600,
    private readonly useJitter: boolean = true
  ) {}

  /**
   * Calculate the delay in seconds for a given 0-based attempt index.
   */
  calculate(attempt: number): number {
    const base = Math.min(
      this.maxDelay,
      this.initialDelay * Math.pow(this.factor, attempt)
    );
    return this.useJitter ? Math.random() * base : base;
  }
}
