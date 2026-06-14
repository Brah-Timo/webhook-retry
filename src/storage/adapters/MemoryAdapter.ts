// ============================================================
//  MemoryAdapter.ts — In-memory storage (testing only)
//
//  ⚠️  All data is lost on process restart.
//  Use ONLY for unit / integration tests.
// ============================================================

import type { StorageInterface } from '../StorageInterface.js';
import type { DeliveryRecord, QueueItem } from '../../types/webhook.types.js';
import type {
  DLQRecord,
  DeliveryListOptions,
  DLQListOptions,
  PaginatedResult,
  DeliveryStats,
  DLQStats,
} from '../../types/storage.types.js';

export class MemoryAdapter implements StorageInterface {
  private deliveries  = new Map<string, DeliveryRecord>();
  private dlqRecords  = new Map<string, DLQRecord>();
  private processedEvents = new Map<string, number>(); // eventId → expiresAt (unix)

  async init(): Promise<void> { /* no-op */ }
  async close(): Promise<void> {
    this.deliveries.clear();
    this.dlqRecords.clear();
    this.processedEvents.clear();
  }

  // ─── Delivery records ──────────────────────────────────────

  async saveDelivery(r: DeliveryRecord): Promise<void> {
    this.deliveries.set(r.id, { ...r });
  }

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    return this.deliveries.get(id) ?? null;
  }

  async updateDelivery(
    id: string,
    partial: Partial<Omit<DeliveryRecord, 'id' | 'createdAt'>>
  ): Promise<void> {
    const existing = this.deliveries.get(id);
    if (!existing) return;
    this.deliveries.set(id, { ...existing, ...partial });
  }

  async listDeliveries(
    opts: DeliveryListOptions
  ): Promise<PaginatedResult<DeliveryRecord>> {
    let records = Array.from(this.deliveries.values());

    if (opts.status)    records = records.filter((r) => r.status === opts.status);
    if (opts.eventType) records = records.filter((r) => r.eventType === opts.eventType);
    if (opts.since)     records = records.filter((r) => r.createdAt >= new Date(opts.since!));

    records.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const total = records.length;
    const sliced = records.slice((page - 1) * limit, page * limit);

    return { records: sliced, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async claimPendingDeliveries(limit: number): Promise<QueueItem[]> {
    const now = new Date();
    const results: QueueItem[] = [];

    for (const [id, r] of this.deliveries) {
      if (results.length >= limit) break;
      if (
        (r.status === 'pending' || r.status === 'retrying') &&
        r.nextAttemptAt <= now
      ) {
        this.deliveries.set(id, { ...r, status: 'processing', updatedAt: now });
        results.push({
          deliveryId: r.id,
          eventId: r.eventId,
          eventType: r.eventType,
          handlerName: r.handlerName,
          payload: r.payload,
          scheduledAt: r.nextAttemptAt,
          priority: 0,
        });
      }
    }

    return results;
  }

  async countPendingDeliveries(): Promise<number> {
    let count = 0;
    for (const r of this.deliveries.values()) {
      if (r.status === 'pending' || r.status === 'retrying') count++;
    }
    return count;
  }

  // ─── DLQ ───────────────────────────────────────────────────

  async saveDLQRecord(r: DLQRecord): Promise<void> {
    this.dlqRecords.set(r.id, { ...r });
  }

  async getDLQRecord(id: string): Promise<DLQRecord | null> {
    return this.dlqRecords.get(id) ?? null;
  }

  async updateDLQRecord(
    id: string,
    partial: Partial<Omit<DLQRecord, 'id' | 'movedToDLQAt'>>
  ): Promise<void> {
    const existing = this.dlqRecords.get(id);
    if (!existing) return;
    this.dlqRecords.set(id, { ...existing, ...partial });
  }

  async listDLQRecords(opts: DLQListOptions): Promise<PaginatedResult<DLQRecord>> {
    let records = Array.from(this.dlqRecords.values());

    if (opts.reviewed !== undefined) records = records.filter((r) => r.reviewed === opts.reviewed);
    if (opts.eventType)              records = records.filter((r) => r.eventType === opts.eventType);

    records.sort((a, b) => b.movedToDLQAt.getTime() - a.movedToDLQAt.getTime());

    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const total = records.length;
    const sliced = records.slice((page - 1) * limit, page * limit);

    return { records: sliced, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getDLQStats(): Promise<DLQStats> {
    const all = Array.from(this.dlqRecords.values());
    const byEventType: Record<string, number> = {};
    const reasonMap = new Map<string, number>();

    for (const r of all) {
      byEventType[r.eventType] = (byEventType[r.eventType] ?? 0) + 1;
      reasonMap.set(r.failureReason, (reasonMap.get(r.failureReason) ?? 0) + 1);
    }

    const topFailureReasons = Array.from(reasonMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    return {
      total: all.length,
      unreviewed: all.filter((r) => !r.reviewed).length,
      byEventType,
      topFailureReasons,
    };
  }

  // ─── Idempotency ───────────────────────────────────────────

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    const exp = this.processedEvents.get(eventId);
    if (exp === undefined) return false;
    return exp > Math.floor(Date.now() / 1000);
  }

  async saveProcessedEvent(eventId: string, ttlSeconds: number): Promise<void> {
    this.processedEvents.set(eventId, Math.floor(Date.now() / 1000) + ttlSeconds);
  }

  async cleanupExpiredEvents(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    let count = 0;
    for (const [id, exp] of this.processedEvents) {
      if (exp <= now) { this.processedEvents.delete(id); count++; }
    }
    return count;
  }

  // ─── Metrics ───────────────────────────────────────────────

  async getDeliveryStats(): Promise<DeliveryStats> {
    const all = Array.from(this.deliveries.values());
    const delivered = all.filter((r) => r.status === 'delivered');

    const total      = all.length;
    const deliveredN = delivered.length;
    const retrying   = all.filter((r) => r.status === 'retrying').length;
    const failed     = all.filter((r) => r.status === 'failed').length;
    const dead       = all.filter((r) => r.status === 'dead').length;

    const avgAttempts = deliveredN > 0
      ? delivered.reduce((s, r) => s + r.attempts, 0) / deliveredN
      : 0;

    const avgDurationMs = deliveredN > 0
      ? delivered.reduce((s, r) => s + (r.duration ?? 0), 0) / deliveredN
      : 0;

    return {
      total,
      delivered: deliveredN,
      retrying,
      failed,
      dead,
      successRate: total > 0 ? Math.round((deliveredN / total) * 100) : 0,
      avgAttempts,
      avgDurationMs,
    };
  }

  // ─── Test helpers ──────────────────────────────────────────

  /** Clear all data — useful between tests. */
  clear(): void {
    this.deliveries.clear();
    this.dlqRecords.clear();
    this.processedEvents.clear();
  }

  /** Return a snapshot of all deliveries for assertions. */
  getAllDeliveries(): DeliveryRecord[] {
    return Array.from(this.deliveries.values());
  }

  /** Return a snapshot of all DLQ records. */
  getAllDLQRecords(): DLQRecord[] {
    return Array.from(this.dlqRecords.values());
  }
}
