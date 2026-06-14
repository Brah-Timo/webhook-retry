// ============================================================
//  scheduler.ts — Lightweight async sleep / tick utilities
// ============================================================

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 *
 * @example
 * await sleep(2000); // wait 2 seconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` at most once per `intervalMs`.
 * Returns a handle with a `stop()` method.
 *
 * Unlike `setInterval`, this waits for `fn` to complete before
 * scheduling the next tick, so slow callbacks never pile up.
 *
 * @example
 * const handle = createPollingLoop(async () => {
 *   await worker.tick();
 * }, 1000);
 *
 * // Later …
 * handle.stop();
 */
export function createPollingLoop(
  fn: () => Promise<void> | void,
  intervalMs: number
): { stop: () => void } {
  let running = true;

  const loop = async () => {
    while (running) {
      const start = Date.now();
      try {
        await fn();
      } catch {
        // Errors in the polling function must not crash the loop.
        // Individual modules handle their own error logging.
      }
      const elapsed = Date.now() - start;
      const remaining = intervalMs - elapsed;
      if (remaining > 0 && running) {
        await sleep(remaining);
      }
    }
  };

  loop(); // start immediately, fire-and-forget

  return {
    stop() {
      running = false;
    },
  };
}

/**
 * Wraps a Promise with a timeout.
 * If `promise` does not settle within `ms`, rejects with a
 * `TimeoutError`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Operation timed out after ${ms}ms`)),
      ms
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
