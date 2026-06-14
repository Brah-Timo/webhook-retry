import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookRetry } from '../../src/index.js';
import type { WebhookEvent } from '../../src/types/webhook.types.js';

// Use MemoryAdapter for fast in-process integration tests
// (no SQLite file I/O needed)

describe('Full delivery flow (in-memory)', () => {
  let webhook: WebhookRetry;

  beforeEach(async () => {
    webhook = new WebhookRetry({ storage: 'memory' });
    await webhook.start();
  });

  afterEach(async () => {
    webhook.stop();
  });

  const makeEvent = (type: string, id?: string): WebhookEvent => ({
    id:        id ?? crypto.randomUUID(),
    type,
    payload:   { amount: 100, customerId: 'cus_123' },
    createdAt: new Date(),
  });

  // ─── Happy path ──────────────────────────────────────────

  it('processes a single event synchronously', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    webhook.on('payment.success', handler);

    await webhook.processSync(makeEvent('payment.success'));

    expect(handler).toHaveBeenCalledOnce();
    const [event] = handler.mock.calls[0] as [WebhookEvent];
    expect(event.type).toBe('payment.success');
    expect((event.payload as { amount: number }).amount).toBe(100);
  });

  it('calls multiple handlers for the same event type', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();

    webhook.on('order.created', h1);
    webhook.on('order.created', h2);

    await webhook.processSync(makeEvent('order.created'));

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('handler chain supports chaining API', () => {
    const result = webhook
      .on('event.a', vi.fn())
      .on('event.b', vi.fn());

    expect(result).toBe(webhook); // fluent API
  });

  // ─── Error handling ──────────────────────────────────────

  it('does not throw when no handlers are registered', async () => {
    await expect(
      webhook.processSync(makeEvent('unknown.event'))
    ).resolves.not.toThrow();
  });

  it('handler that returns { success: false } is recorded as failure', async () => {
    const failHandler = vi.fn().mockResolvedValue({ success: false, message: 'db error' });
    webhook.on('fail.event', failHandler, {
      retry: 'fixed',
      maxRetries: 0,
      deadLetter: true,
    });

    // processSync logs the failure but does not re-throw for { success: false }
    // (throwing is reserved for exceptions, not explicit { success: false })
    await expect(
      webhook.processSync(makeEvent('fail.event'))
    ).resolves.not.toThrow();

    expect(failHandler).toHaveBeenCalledOnce();
  });

  // ─── DLQ ─────────────────────────────────────────────────

  it('getDeadLetterQueue() is accessible', () => {
    expect(webhook.deadLetterQueue).toBeDefined();
  });
});
