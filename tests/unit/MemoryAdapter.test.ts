import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAdapter } from '../../src/storage/adapters/MemoryAdapter.js';
import type { DeliveryRecord } from '../../src/types/webhook.types.js';
import type { DLQRecord } from '../../src/types/storage.types.js';

function makeDelivery(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const now = new Date();
  return {
    id:            crypto.randomUUID(),
    eventId:       crypto.randomUUID(),
    eventType:     'payment.success',
    handlerName:   'handlePayment',
    payload:       '{"amount":100}',
    status:        'pending',
    attempts:      0,
    maxAttempts:   5,
    lastAttemptAt: null,
    nextAttemptAt: new Date(now.getTime() - 1000), // in the past = ready now
    lastError:     null,
    lastStatusCode:null,
    duration:      null,
    createdAt:     now,
    updatedAt:     now,
    ...overrides,
  };
}

describe('MemoryAdapter', () => {
  let adapter: MemoryAdapter;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    await adapter.init();
  });

  it('saves and retrieves a delivery', async () => {
    const d = makeDelivery();
    await adapter.saveDelivery(d);
    const retrieved = await adapter.getDelivery(d.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(d.id);
  });

  it('returns null for non-existent delivery', async () => {
    expect(await adapter.getDelivery('non-existent')).toBeNull();
  });

  it('updates delivery status', async () => {
    const d = makeDelivery();
    await adapter.saveDelivery(d);
    await adapter.updateDelivery(d.id, { status: 'delivered', attempts: 1 });
    const updated = await adapter.getDelivery(d.id);
    expect(updated?.status).toBe('delivered');
    expect(updated?.attempts).toBe(1);
  });

  it('claimPendingDeliveries marks items as processing', async () => {
    const d1 = makeDelivery();
    const d2 = makeDelivery();
    await adapter.saveDelivery(d1);
    await adapter.saveDelivery(d2);

    const claimed = await adapter.claimPendingDeliveries(10);
    expect(claimed).toHaveLength(2);

    // After claiming, they should be processing
    const r1 = await adapter.getDelivery(d1.id);
    expect(r1?.status).toBe('processing');
  });

  it('does not claim items scheduled in the future', async () => {
    const future = makeDelivery({
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    await adapter.saveDelivery(future);

    const claimed = await adapter.claimPendingDeliveries(10);
    expect(claimed).toHaveLength(0);
  });

  it('listDeliveries paginates correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await adapter.saveDelivery(makeDelivery());
    }

    const page1 = await adapter.listDeliveries({ page: 1, limit: 3 });
    const page2 = await adapter.listDeliveries({ page: 2, limit: 3 });

    expect(page1.records).toHaveLength(3);
    expect(page2.records).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.totalPages).toBe(2);
  });

  it('listDeliveries filters by status', async () => {
    await adapter.saveDelivery(makeDelivery({ status: 'pending' }));
    await adapter.saveDelivery(makeDelivery({ status: 'delivered' }));
    await adapter.saveDelivery(makeDelivery({ status: 'delivered' }));

    const delivered = await adapter.listDeliveries({ status: 'delivered' });
    expect(delivered.total).toBe(2);
  });

  it('countPendingDeliveries returns correct count', async () => {
    await adapter.saveDelivery(makeDelivery({ status: 'pending' }));
    await adapter.saveDelivery(makeDelivery({ status: 'retrying' }));
    await adapter.saveDelivery(makeDelivery({ status: 'delivered' }));

    expect(await adapter.countPendingDeliveries()).toBe(2);
  });

  it('handles idempotency correctly', async () => {
    expect(await adapter.hasProcessedEvent('evt_1')).toBe(false);
    await adapter.saveProcessedEvent('evt_1', 3600);
    expect(await adapter.hasProcessedEvent('evt_1')).toBe(true);
  });

  it('idempotency TTL expires correctly', async () => {
    await adapter.saveProcessedEvent('evt_2', -1); // already expired
    expect(await adapter.hasProcessedEvent('evt_2')).toBe(false);
  });

  it('cleanupExpiredEvents removes expired records', async () => {
    await adapter.saveProcessedEvent('evt_expire', -1);
    await adapter.saveProcessedEvent('evt_keep', 3600);

    const removed = await adapter.cleanupExpiredEvents();
    expect(removed).toBe(1);
    expect(await adapter.hasProcessedEvent('evt_keep')).toBe(true);
  });

  it('getDeliveryStats aggregates correctly', async () => {
    await adapter.saveDelivery(makeDelivery({ status: 'delivered', attempts: 1, duration: 100 }));
    await adapter.saveDelivery(makeDelivery({ status: 'retrying' }));
    await adapter.saveDelivery(makeDelivery({ status: 'dead' }));

    const stats = await adapter.getDeliveryStats();
    expect(stats.total).toBe(3);
    expect(stats.delivered).toBe(1);
    expect(stats.retrying).toBe(1);
    expect(stats.dead).toBe(1);
    expect(stats.successRate).toBe(33);
  });

  it('DLQ save and retrieve', async () => {
    const now = new Date();
    const dlq: DLQRecord = {
      id: crypto.randomUUID(),
      originalEventId: crypto.randomUUID(),
      eventType: 'payment.success',
      payload: '{}',
      failureReason: 'Connection refused',
      totalAttempts: 5,
      firstAttemptAt: now,
      lastAttemptAt: now,
      movedToDLQAt: now,
      reviewed: false,
      replayed: false,
    };

    await adapter.saveDLQRecord(dlq);
    const retrieved = await adapter.getDLQRecord(dlq.id);
    expect(retrieved?.id).toBe(dlq.id);
    expect(retrieved?.failureReason).toBe('Connection refused');
  });
});
