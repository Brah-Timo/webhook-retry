import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../src/circuit-breaker/CircuitBreaker.js';
import { CircuitOpenError } from '../../src/errors/CircuitOpenError.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker('test-cb', {
      failureThreshold: 3,
      resetTimeout:     1000, // 1s for fast tests
      successThreshold: 2,
    });
  });

  it('starts in CLOSED state', () => {
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.isOpen).toBe(false);
  });

  it('transitions to OPEN after threshold failures', async () => {
    const fail = () => Promise.reject(new Error('boom'));

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fail)).rejects.toThrow('boom');
    }

    expect(cb.currentState).toBe('OPEN');
    expect(cb.isOpen).toBe(true);
  });

  it('throws CircuitOpenError when OPEN', async () => {
    for (let i = 0; i < 3; i++) {
      cb.recordFailure();
    }

    await expect(
      cb.execute(() => Promise.resolve('ok'))
    ).rejects.toThrow(CircuitOpenError);
  });

  it('transitions to HALF_OPEN after resetTimeout', async () => {
    // Open the circuit
    for (let i = 0; i < 3; i++) cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');

    // Wait for resetTimeout
    await new Promise((r) => setTimeout(r, 1100));

    // Next call should be allowed (HALF_OPEN probe)
    let called = false;
    await cb.execute(async () => { called = true; });
    expect(called).toBe(true);
  });

  it('closes after successThreshold successes in HALF_OPEN', async () => {
    for (let i = 0; i < 3; i++) cb.recordFailure();
    await new Promise((r) => setTimeout(r, 1100));

    // 2 successes needed
    await cb.execute(() => Promise.resolve());
    await cb.execute(() => Promise.resolve());

    expect(cb.currentState).toBe('CLOSED');
  });

  it('goes back to OPEN if probe fails in HALF_OPEN', async () => {
    for (let i = 0; i < 3; i++) cb.recordFailure();
    await new Promise((r) => setTimeout(r, 1100));

    await expect(
      cb.execute(() => Promise.reject(new Error('still failing')))
    ).rejects.toThrow();

    expect(cb.currentState).toBe('OPEN');
  });

  it('reset() forces CLOSED state', () => {
    for (let i = 0; i < 3; i++) cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');

    cb.reset();
    expect(cb.currentState).toBe('CLOSED');
  });

  it('fires onStateChange callback', () => {
    const onChange = vi.fn();
    const cb2 = new CircuitBreaker('cb2', {
      failureThreshold: 2,
      resetTimeout: 5000,
      onStateChange: onChange,
    });

    cb2.recordFailure();
    cb2.recordFailure();

    expect(onChange).toHaveBeenCalledWith('CLOSED', 'OPEN');
  });

  it('getStats returns correct counts', async () => {
    await cb.execute(() => Promise.resolve());
    await expect(
      cb.execute(() => Promise.reject(new Error('x')))
    ).rejects.toThrow();

    const stats = cb.getStats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalSuccesses).toBe(1);
    expect(stats.totalFailures).toBe(1);
  });
});
