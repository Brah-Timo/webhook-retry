import { describe, it, expect, beforeEach } from 'vitest';
import { DeadLetterQueue } from '../../src/dead-letter/DeadLetterQueue.js';
import { DLQAnalyzer } from '../../src/dead-letter/DLQAnalyzer.js';
import { MemoryAdapter } from '../../src/storage/adapters/MemoryAdapter.js';
import type { DeliveryRecord, WebhookEvent } from '../../src/types/webhook.types.js';

function makeDelivery(): DeliveryRecord {
  const now = new Date();
  return {
    id: crypto.randomUUID(), eventId: crypto.randomUUID(),
    eventType: 'payment.success', handlerName: 'handler',
    payload: '{}', status: 'dead', attempts: 5, maxAttempts: 5,
    lastAttemptAt: now, nextAttemptAt: now, lastError: 'timeout',
    lastStatusCode: 503, duration: 30000, createdAt: now, updatedAt: now,
  };
}

function makeEvent(type = 'payment.success'): WebhookEvent {
  return {
    id: crypto.randomUUID(), type,
    payload: { amount: 100 }, createdAt: new Date(),
  };
}

describe('DeadLetterQueue', () => {
  let adapter: MemoryAdapter;
  let dlq: DeadLetterQueue;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.init();
    dlq = new DeadLetterQueue(adapter);
  });

  it('pushes a record and retrieves it', async () => {
    const record = await dlq.push(makeDelivery(), makeEvent(), 'Service unavailable');

    expect(record.id).toBeDefined();
    expect(record.reviewed).toBe(false);
    expect(record.replayed).toBe(false);
    expect(record.failureReason).toBe('Service unavailable');
  });

  it('list() returns paginated records', async () => {
    await dlq.push(makeDelivery(), makeEvent(), 'Error 1');
    await dlq.push(makeDelivery(), makeEvent(), 'Error 2');
    await dlq.push(makeDelivery(), makeEvent(), 'Error 3');

    const result = await dlq.list({ page: 1, limit: 2 });
    expect(result.records).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(2);
  });

  it('review() marks record as reviewed with notes', async () => {
    const pushed = await dlq.push(makeDelivery(), makeEvent(), 'DB timeout');
    await dlq.review(pushed.id, 'Investigated — DB was overloaded');

    const updated = await dlq.get(pushed.id);
    expect(updated?.reviewed).toBe(true);
    expect(updated?.notes).toBe('Investigated — DB was overloaded');
  });

  it('markReplayed() updates replayed flag', async () => {
    const pushed = await dlq.push(makeDelivery(), makeEvent(), 'Error');
    await dlq.markReplayed(pushed.id);

    const updated = await dlq.get(pushed.id);
    expect(updated?.replayed).toBe(true);
    expect(updated?.replayedAt).toBeInstanceOf(Date);
  });

  it('getStats() aggregates by event type', async () => {
    await dlq.push(makeDelivery(), makeEvent('payment.success'), 'Error A');
    await dlq.push(makeDelivery(), makeEvent('payment.success'), 'Error A');
    await dlq.push(makeDelivery(), makeEvent('order.created'),   'Error B');

    const stats = await dlq.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byEventType['payment.success']).toBe(2);
    expect(stats.byEventType['order.created']).toBe(1);
  });
});

describe('DLQAnalyzer', () => {
  let adapter: MemoryAdapter;
  let dlq: DeadLetterQueue;
  let analyzer: DLQAnalyzer;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.init();
    dlq = new DeadLetterQueue(adapter);
    analyzer = new DLQAnalyzer(dlq);
  });

  it('returns empty analysis for empty DLQ', async () => {
    const result = await analyzer.analyze();
    expect(result.summary.total).toBe(0);
    expect(result.byEventType).toHaveLength(0);
  });

  it('aggregates failure reasons correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await dlq.push(makeDelivery(), makeEvent(), 'Connection refused');
    }
    await dlq.push(makeDelivery(), makeEvent(), 'Timeout');

    const result = await analyzer.analyze();
    expect(result.byFailureReason[0]?.reason).toBe('Connection refused');
    expect(result.byFailureReason[0]?.count).toBe(5);
  });
});
