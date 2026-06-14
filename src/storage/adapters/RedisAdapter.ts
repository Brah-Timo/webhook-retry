// ============================================================
//  RedisAdapter.ts — Redis-backed storage adapter (ioredis)
//
//  Ideal for:
//  - Distributed / multi-server deployments
//  - High-throughput production systems
//
//  Key design decisions:
//  - Deliveries stored as Redis hashes (HSET / HGETALL)
//  - Pending/retrying index stored as a sorted set (ZADD / ZRANGEBYSCORE)
//    where the score is the `nextAttemptAt` unix timestamp.
//  - claimPendingDeliveries uses a Lua script for atomic claim.
//  - DLQ & idempotency keys stored as simple hashes + TTL.
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
import { createLogger } from '../../utils/logger.js';

const log = createLogger('RedisAdapter');

// Lazy import so ioredis remains optional
type Redis = import('ioredis').Redis;

const KEYS = {
  delivery:       (id: string) => `wr:delivery:${id}`,
  pendingIndex:   'wr:pending',       // sorted set: score = nextAttemptAt unix ms
  allDeliveries:  'wr:deliveries',    // set of all delivery IDs
  dlq:            (id: string) => `wr:dlq:${id}`,
  dlqIndex:       'wr:dlq:index',     // sorted set: score = movedToDLQAt unix ms
  idempotency:    (id: string) => `wr:idem:${id}`,
};

export class RedisAdapter implements StorageInterface {
  private redis!: Redis;

  constructor(private readonly url: string = 'redis://localhost:6379') {}

  async init(): Promise<void> {
    const { default: Redis } = await import('ioredis') as unknown as {
      default: new (url: string) => Redis;
    };
    this.redis = new Redis(this.url);
    await this.redis.ping();
    log.info({ url: this.url }, 'RedisAdapter connected');
  }

  async close(): Promise<void> {
    await this.redis.quit();
    log.info('RedisAdapter closed');
  }

  // ─── Delivery records ──────────────────────────────────────

  async saveDelivery(r: DeliveryRecord): Promise<void> {
    const pipe = this.redis.pipeline();

    pipe.hset(KEYS.delivery(r.id), this.deliveryToHash(r));
    pipe.sadd(KEYS.allDeliveries, r.id);

    if (r.status === 'pending' || r.status === 'retrying') {
      pipe.zadd(KEYS.pendingIndex, r.nextAttemptAt.getTime(), r.id);
    }

    await pipe.exec();
  }

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    const hash = await this.redis.hgetall(KEYS.delivery(id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return this.hashToDelivery(hash);
  }

  async updateDelivery(
    id: string,
    partial: Partial<Omit<DeliveryRecord, 'id' | 'createdAt'>>
  ): Promise<void> {
    const updates: Record<string, string> = {};

    if (partial.status !== undefined)       updates['status'] = partial.status;
    if (partial.attempts !== undefined)     updates['attempts'] = String(partial.attempts);
    if ('lastAttemptAt' in partial)         updates['lastAttemptAt'] = partial.lastAttemptAt?.toISOString() ?? '';
    if (partial.nextAttemptAt !== undefined)updates['nextAttemptAt'] = partial.nextAttemptAt.toISOString();
    if ('lastError' in partial)             updates['lastError'] = partial.lastError ?? '';
    if ('lastStatusCode' in partial)        updates['lastStatusCode'] = String(partial.lastStatusCode ?? '');
    if ('duration' in partial)              updates['duration'] = String(partial.duration ?? '');
    if (partial.updatedAt !== undefined)    updates['updatedAt'] = partial.updatedAt.toISOString();

    if (Object.keys(updates).length === 0) return;

    const pipe = this.redis.pipeline();
    pipe.hset(KEYS.delivery(id), updates);

    // Manage pending sorted-set membership
    if (partial.status === 'pending' || partial.status === 'retrying') {
      const at = partial.nextAttemptAt ?? new Date();
      pipe.zadd(KEYS.pendingIndex, at.getTime(), id);
    } else if (partial.status && !['pending', 'retrying'].includes(partial.status)) {
      pipe.zrem(KEYS.pendingIndex, id);
    }

    await pipe.exec();
  }

  async listDeliveries(opts: DeliveryListOptions): Promise<PaginatedResult<DeliveryRecord>> {
    const allIds = await this.redis.smembers(KEYS.allDeliveries);
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;

    const all: DeliveryRecord[] = [];
    for (const id of allIds) {
      const r = await this.getDelivery(id);
      if (!r) continue;
      if (opts.status    && r.status    !== opts.status)    continue;
      if (opts.eventType && r.eventType !== opts.eventType) continue;
      all.push(r);
    }

    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = all.length;
    const records = all.slice((page - 1) * limit, page * limit);

    return { records, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async claimPendingDeliveries(limit: number): Promise<QueueItem[]> {
    const now = Date.now();

    // Lua script: atomically get + remove from sorted set + mark processing
    const script = `
      local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
      if #ids == 0 then return {} end
      redis.call('ZREM', KEYS[1], unpack(ids))
      for _, id in ipairs(ids) do
        redis.call('HSET', 'wr:delivery:' .. id, 'status', 'processing')
      end
      return ids
    `;

    const ids = await this.redis.eval(
      script,
      1,
      KEYS.pendingIndex,
      String(now),
      String(limit)
    ) as string[];

    if (!Array.isArray(ids) || ids.length === 0) return [];

    const items: QueueItem[] = [];
    for (const id of ids) {
      const r = await this.getDelivery(id);
      if (!r) continue;
      items.push({
        deliveryId: r.id,
        eventId: r.eventId,
        eventType: r.eventType,
        handlerName: r.handlerName,
        payload: r.payload,
        scheduledAt: r.nextAttemptAt,
        priority: 0,
      });
    }

    return items;
  }

  async countPendingDeliveries(): Promise<number> {
    return this.redis.zcount(KEYS.pendingIndex, '-inf', '+inf');
  }

  // ─── DLQ ───────────────────────────────────────────────────

  async saveDLQRecord(r: DLQRecord): Promise<void> {
    const pipe = this.redis.pipeline();
    pipe.hset(KEYS.dlq(r.id), this.dlqToHash(r));
    pipe.zadd(KEYS.dlqIndex, r.movedToDLQAt.getTime(), r.id);
    await pipe.exec();
  }

  async getDLQRecord(id: string): Promise<DLQRecord | null> {
    const hash = await this.redis.hgetall(KEYS.dlq(id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return this.hashToDLQ(hash);
  }

  async updateDLQRecord(
    id: string,
    partial: Partial<Omit<DLQRecord, 'id' | 'movedToDLQAt'>>
  ): Promise<void> {
    const updates: Record<string, string> = {};
    if (partial.reviewed !== undefined)  updates['reviewed']  = String(partial.reviewed ? 1 : 0);
    if (partial.replayed !== undefined)  updates['replayed']  = String(partial.replayed ? 1 : 0);
    if (partial.replayedAt !== undefined)updates['replayedAt'] = partial.replayedAt?.toISOString() ?? '';
    if (partial.notes !== undefined)     updates['notes']     = partial.notes ?? '';
    if (Object.keys(updates).length > 0) {
      await this.redis.hset(KEYS.dlq(id), updates);
    }
  }

  async listDLQRecords(opts: DLQListOptions): Promise<PaginatedResult<DLQRecord>> {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;

    const allIds = await this.redis.zrevrange(KEYS.dlqIndex, 0, -1);
    const all: DLQRecord[] = [];

    for (const id of allIds) {
      const r = await this.getDLQRecord(id);
      if (!r) continue;
      if (opts.reviewed !== undefined && r.reviewed !== opts.reviewed) continue;
      if (opts.eventType && r.eventType !== opts.eventType) continue;
      all.push(r);
    }

    const total = all.length;
    const records = all.slice((page - 1) * limit, page * limit);
    return { records, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getDLQStats(): Promise<DLQStats> {
    const allIds = await this.redis.zrange(KEYS.dlqIndex, 0, -1);
    const all: DLQRecord[] = [];
    for (const id of allIds) {
      const r = await this.getDLQRecord(id);
      if (r) all.push(r);
    }

    const byEventType: Record<string, number> = {};
    const reasonMap = new Map<string, number>();

    for (const r of all) {
      byEventType[r.eventType] = (byEventType[r.eventType] ?? 0) + 1;
      reasonMap.set(r.failureReason, (reasonMap.get(r.failureReason) ?? 0) + 1);
    }

    return {
      total: all.length,
      unreviewed: all.filter((r) => !r.reviewed).length,
      byEventType,
      topFailureReasons: Array.from(reasonMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
    };
  }

  // ─── Idempotency ───────────────────────────────────────────

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return (await this.redis.exists(KEYS.idempotency(eventId))) === 1;
  }

  async saveProcessedEvent(eventId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(KEYS.idempotency(eventId), '1', 'EX', ttlSeconds);
  }

  async cleanupExpiredEvents(): Promise<number> {
    // Redis handles TTL cleanup automatically; nothing to do here.
    return 0;
  }

  // ─── Metrics ───────────────────────────────────────────────

  async getDeliveryStats(): Promise<DeliveryStats> {
    const allIds = await this.redis.smembers(KEYS.allDeliveries);
    const records: DeliveryRecord[] = [];
    for (const id of allIds) {
      const r = await this.getDelivery(id);
      if (r) records.push(r);
    }

    const delivered = records.filter((r) => r.status === 'delivered');
    const total = records.length;

    return {
      total,
      delivered: delivered.length,
      retrying: records.filter((r) => r.status === 'retrying').length,
      failed:   records.filter((r) => r.status === 'failed').length,
      dead:     records.filter((r) => r.status === 'dead').length,
      successRate: total > 0 ? Math.round((delivered.length / total) * 100) : 0,
      avgAttempts: delivered.length > 0
        ? delivered.reduce((s, r) => s + r.attempts, 0) / delivered.length : 0,
      avgDurationMs: delivered.length > 0
        ? delivered.reduce((s, r) => s + (r.duration ?? 0), 0) / delivered.length : 0,
    };
  }

  // ─── Hash serialisers ──────────────────────────────────────

  private deliveryToHash(r: DeliveryRecord): Record<string, string> {
    return {
      id: r.id, eventId: r.eventId, eventType: r.eventType,
      handlerName: r.handlerName, payload: r.payload,
      status: r.status, attempts: String(r.attempts),
      maxAttempts: String(r.maxAttempts),
      lastAttemptAt: r.lastAttemptAt?.toISOString() ?? '',
      nextAttemptAt: r.nextAttemptAt.toISOString(),
      lastError: r.lastError ?? '', lastStatusCode: String(r.lastStatusCode ?? ''),
      duration: String(r.duration ?? ''),
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  }

  private hashToDelivery(h: Record<string, string>): DeliveryRecord {
    return {
      id: h['id']!, eventId: h['eventId']!, eventType: h['eventType']!,
      handlerName: h['handlerName']!, payload: h['payload']!,
      status: h['status'] as DeliveryRecord['status'],
      attempts: parseInt(h['attempts'] ?? '0', 10),
      maxAttempts: parseInt(h['maxAttempts'] ?? '5', 10),
      lastAttemptAt: h['lastAttemptAt'] ? new Date(h['lastAttemptAt']) : null,
      nextAttemptAt: new Date(h['nextAttemptAt']!),
      lastError: h['lastError'] || null,
      lastStatusCode: h['lastStatusCode'] ? parseInt(h['lastStatusCode'], 10) : null,
      duration: h['duration'] ? parseInt(h['duration'], 10) : null,
      createdAt: new Date(h['createdAt']!), updatedAt: new Date(h['updatedAt']!),
    };
  }

  private dlqToHash(r: DLQRecord): Record<string, string> {
    return {
      id: r.id, originalEventId: r.originalEventId, eventType: r.eventType,
      payload: r.payload, failureReason: r.failureReason,
      totalAttempts: String(r.totalAttempts),
      firstAttemptAt: r.firstAttemptAt.toISOString(),
      lastAttemptAt: r.lastAttemptAt.toISOString(),
      movedToDLQAt: r.movedToDLQAt.toISOString(),
      reviewed: String(r.reviewed ? 1 : 0), replayed: String(r.replayed ? 1 : 0),
      replayedAt: r.replayedAt?.toISOString() ?? '',
      notes: r.notes ?? '',
    };
  }

  private hashToDLQ(h: Record<string, string>): DLQRecord {
    return {
      id: h['id']!, originalEventId: h['originalEventId']!,
      eventType: h['eventType']!, payload: h['payload']!,
      failureReason: h['failureReason']!,
      totalAttempts: parseInt(h['totalAttempts'] ?? '0', 10),
      firstAttemptAt: new Date(h['firstAttemptAt']!),
      lastAttemptAt: new Date(h['lastAttemptAt']!),
      movedToDLQAt: new Date(h['movedToDLQAt']!),
      reviewed: h['reviewed'] === '1', replayed: h['replayed'] === '1',
      ...(h['replayedAt'] ? { replayedAt: new Date(h['replayedAt']) } : {}),
      ...(h['notes'] ? { notes: h['notes'] } : {}),
    };
  }
}
