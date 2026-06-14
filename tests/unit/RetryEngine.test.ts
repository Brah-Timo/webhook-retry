import { describe, it, expect, vi } from 'vitest';
import { RetryEngine } from '../../src/core/RetryEngine.js';

describe('RetryEngine', () => {

  // ─── Exponential Backoff ─────────────────────────────────

  describe('exponential strategy', () => {
    it('doubles delay on each attempt (no jitter)', () => {
      const engine = new RetryEngine({
        retry: 'exponential',
        initialDelay: 1,
        factor: 2,
        jitter: false,
      });

      expect(engine.calculateDelay(0)).toBe(1);
      expect(engine.calculateDelay(1)).toBe(2);
      expect(engine.calculateDelay(2)).toBe(4);
      expect(engine.calculateDelay(3)).toBe(8);
      expect(engine.calculateDelay(4)).toBe(16);
    });

    it('never exceeds maxDelay', () => {
      const engine = new RetryEngine({
        retry: 'exponential',
        initialDelay: 1,
        factor: 2,
        maxDelay: 10,
        jitter: false,
      });

      expect(engine.calculateDelay(5)).toBe(10);
      expect(engine.calculateDelay(20)).toBe(10);
    });

    it('applies jitter (result ≤ base delay)', () => {
      const engine = new RetryEngine({
        retry: 'exponential',
        initialDelay: 1,
        factor: 2,
        jitter: true,
      });

      // With jitter, delay must be ≥ 0 and ≤ base
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = engine.calculateDelay(attempt);
        const base = Math.min(3600, Math.pow(2, attempt));
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(base + 0.001); // floating point tolerance
      }
    });
  });

  // ─── Linear ──────────────────────────────────────────────

  describe('linear strategy', () => {
    it('grows linearly', () => {
      const engine = new RetryEngine({
        retry: 'linear',
        initialDelay: 2,
        jitter: false,
      });

      expect(engine.calculateDelay(0)).toBe(2);
      expect(engine.calculateDelay(1)).toBe(4);
      expect(engine.calculateDelay(2)).toBe(6);
    });
  });

  // ─── Fixed ───────────────────────────────────────────────

  describe('fixed strategy', () => {
    it('always returns the same delay', () => {
      const engine = new RetryEngine({
        retry: 'fixed',
        initialDelay: 5,
        jitter: false,
      });

      for (let i = 0; i < 10; i++) {
        expect(engine.calculateDelay(i)).toBe(5);
      }
    });
  });

  // ─── Custom strategy ─────────────────────────────────────

  describe('custom strategy', () => {
    it('calls user-supplied function', () => {
      const fibFn = vi.fn((attempt: number): number => {
        if (attempt <= 1) return 1;
        let a = 1, b = 1;
        for (let i = 2; i <= attempt; i++) [a, b] = [b, a + b];
        return b;
      });

      const engine = new RetryEngine({ retry: fibFn, jitter: false });
      expect(engine.calculateDelay(0)).toBe(1);
      expect(engine.calculateDelay(1)).toBe(1);
      expect(engine.calculateDelay(2)).toBe(2);
      expect(engine.calculateDelay(3)).toBe(3);
      expect(engine.calculateDelay(4)).toBe(5);
      expect(engine.calculateDelay(5)).toBe(8);
    });
  });

  // ─── shouldRetry ─────────────────────────────────────────

  describe('shouldRetry', () => {
    it('returns false when attempts >= maxRetries', () => {
      const engine = new RetryEngine({ maxRetries: 3 });
      const result = { success: false, duration: 50, timestamp: new Date() };

      expect(engine.shouldRetry(3, result)).toBe(false);
      expect(engine.shouldRetry(4, result)).toBe(false);
      expect(engine.shouldRetry(2, result)).toBe(true);
    });

    it('returns false for non-retryable HTTP status codes', () => {
      const engine = new RetryEngine({ maxRetries: 10 });

      // Not retryable: 400, 401, 403
      for (const code of [400, 401, 403, 404, 422]) {
        expect(engine.shouldRetry(1, {
          success: false, statusCode: code, duration: 50, timestamp: new Date(),
        })).toBe(false);
      }

      // Retryable: 500, 502, 503, 429, 408
      for (const code of [408, 429, 500, 502, 503, 504]) {
        expect(engine.shouldRetry(1, {
          success: false, statusCode: code, duration: 50, timestamp: new Date(),
        })).toBe(true);
      }
    });

    it('retries when no status code is present', () => {
      const engine = new RetryEngine({ maxRetries: 5 });
      expect(engine.shouldRetry(1, {
        success: false, duration: 50, timestamp: new Date(),
      })).toBe(true);
    });
  });

  // ─── getRetrySchedule ────────────────────────────────────

  describe('getRetrySchedule', () => {
    it('returns correct length and deterministic delays', () => {
      const engine = new RetryEngine({
        retry: 'exponential',
        maxRetries: 5,
        initialDelay: 1,
        jitter: false,
      });

      const schedule = engine.getRetrySchedule();
      expect(schedule).toHaveLength(5);

      const expectedDelays = [1, 2, 4, 8, 16];
      schedule.forEach((entry, i) => {
        expect(entry.attempt).toBe(i + 1);
        expect(entry.delaySeconds).toBe(expectedDelays[i]);
        expect(entry.scheduledAt).toBeInstanceOf(Date);
      });
    });
  });

  // ─── Callbacks ───────────────────────────────────────────

  describe('callbacks', () => {
    it('fires onRetry callback', () => {
      const onRetry = vi.fn();
      const engine = new RetryEngine({ onRetry });
      engine.notifyRetry(1, 'connection refused', 2);
      expect(onRetry).toHaveBeenCalledWith(1, 'connection refused', 2);
    });

    it('onRetry callback error is caught silently', () => {
      const engine = new RetryEngine({
        onRetry: () => { throw new Error('boom'); },
      });
      expect(() => engine.notifyRetry(1, 'err', 1)).not.toThrow();
    });
  });
});
