// ============================================================
//  SQLiteAdapter.ts — better-sqlite3 backed storage adapter
//
//  Ideal for:
//  - Local development
//  - Small-to-medium SaaS (< 10k events/day)
//  - Single-server deployments
//
//  All writes use WAL mode for better concurrency.
//  claimPendingDeliveries uses an atomic UPDATE + SELECT
//  so it's safe even with multiple Node.js threads via
//  worker_threads.
// ============================================================

import Database, { type Database as Db } from 'better-sqlite3';
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

const log = createLogger('SQLiteAdapter');

export class SQLiteAdapter implements StorageInterface {
  private db!: Db;

  constructor(private readonly filePath: string = './webhook-retry.db') {}

  // ─── Lifecycle ─────────────────────────────────────────────

  async init(): Promise<void> {
    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.createSchema();
    log.info({ filePath: this.filePath }, 'SQLiteAdapter initialised');
  }

  async close(): Promise<void> {
    this.db?.close();
    log.info('SQLiteAdapter closed');
  }

  // ─── Schema ────────────────────────────────────────────────

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id              TEXT PRIMARY KEY,
        event_id        TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        handler_name    TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL DEFAULT 5,
        last_attempt_at TEXT,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        last_status_code INTEGER,
        duration        INTEGER,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deliveries_status_next
        ON deliveries (status, next_attempt_at);

      CREATE INDEX IF NOT EXISTS idx_deliveries_event_id
        ON deliveries (event_id);

      -- ─── Dead Letter Queue ───────────────────────────────────
      CREATE TABLE IF NOT EXISTS dlq (
        id                TEXT PRIMARY KEY,
        original_event_id TEXT NOT NULL,
        event_type        TEXT NOT NULL,
        payload           TEXT NOT NULL,
        failure_reason    TEXT NOT NULL,
        total_attempts    INTEGER NOT NULL DEFAULT 0,
        first_attempt_at  TEXT NOT NULL,
        last_attempt_at   TEXT NOT NULL,
        moved_to_dlq_at   TEXT NOT NULL,
        reviewed          INTEGER NOT NULL DEFAULT 0,
        replayed          INTEGER NOT NULL DEFAULT 0,
        replayed_at       TEXT,
        notes             TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dlq_event_type ON dlq (event_type);
      CREATE INDEX IF NOT EXISTS idx_dlq_reviewed   ON dlq (reviewed);

      -- ─── Idempotency keys ────────────────────────────────────
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id    TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL,
        expires_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pe_expires ON processed_events (expires_at);
    `);
  }

  // ─── Delivery records ──────────────────────────────────────

  async saveDelivery(r: DeliveryRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO deliveries
        (id, event_id, event_type, handler_name, payload,
         status, attempts, max_attempts, last_attempt_at,
         next_attempt_at, last_error, last_status_code,
         duration, created_at, updated_at)
      VALUES
        (@id, @event_id, @event_type, @handler_name, @payload,
         @status, @attempts, @max_attempts, @last_attempt_at,
         @next_attempt_at, @last_error, @last_status_code,
         @duration, @created_at, @updated_at)
    `).run({
      id: r.id,
      event_id: r.eventId,
      event_type: r.eventType,
      handler_name: r.handlerName,
      payload: r.payload,
      status: r.status,
      attempts: r.attempts,
      max_attempts: r.maxAttempts,
      last_attempt_at: r.lastAttemptAt?.toISOString() ?? null,
      next_attempt_at: r.nextAttemptAt.toISOString(),
      last_error: r.lastError,
      last_status_code: r.lastStatusCode,
      duration: r.duration,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    });
  }

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM deliveries WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    return row ? this.rowToDelivery(row) : null;
  }

  async updateDelivery(
    id: string,
    partial: Partial<Omit<DeliveryRecord, 'id' | 'createdAt'>>
  ): Promise<void> {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    if (partial.status !== undefined)        { fields.push('status = @status'); params['status'] = partial.status; }
    if (partial.attempts !== undefined)      { fields.push('attempts = @attempts'); params['attempts'] = partial.attempts; }
    if (partial.maxAttempts !== undefined)   { fields.push('max_attempts = @max_attempts'); params['max_attempts'] = partial.maxAttempts; }
    if ('lastAttemptAt' in partial)          { fields.push('last_attempt_at = @last_attempt_at'); params['last_attempt_at'] = partial.lastAttemptAt?.toISOString() ?? null; }
    if (partial.nextAttemptAt !== undefined) { fields.push('next_attempt_at = @next_attempt_at'); params['next_attempt_at'] = partial.nextAttemptAt.toISOString(); }
    if ('lastError' in partial)              { fields.push('last_error = @last_error'); params['last_error'] = partial.lastError ?? null; }
    if ('lastStatusCode' in partial)         { fields.push('last_status_code = @last_status_code'); params['last_status_code'] = partial.lastStatusCode ?? null; }
    if ('duration' in partial)               { fields.push('duration = @duration'); params['duration'] = partial.duration ?? null; }
    if (partial.updatedAt !== undefined)     { fields.push('updated_at = @updated_at'); params['updated_at'] = partial.updatedAt.toISOString(); }

    if (fields.length === 0) return;

    this.db.prepare(
      `UPDATE deliveries SET ${fields.join(', ')} WHERE id = @id`
    ).run(params);
  }

  async listDeliveries(
    opts: DeliveryListOptions
  ): Promise<PaginatedResult<DeliveryRecord>> {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const offset = (page - 1) * limit;

    const wheres: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.status)    { wheres.push('status = @status'); params['status'] = opts.status; }
    if (opts.eventType) { wheres.push('event_type = @event_type'); params['event_type'] = opts.eventType; }
    if (opts.since)     { wheres.push('created_at >= @since'); params['since'] = opts.since; }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM deliveries ${where}`).get(params) as { cnt: number }
    ).cnt;

    const rows = this.db.prepare(
      `SELECT * FROM deliveries ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset }) as Record<string, unknown>[];

    return {
      records: rows.map((r) => this.rowToDelivery(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async claimPendingDeliveries(limit: number): Promise<QueueItem[]> {
    const now = new Date().toISOString();

    // Atomic: fetch + mark as processing in one transaction
    const rows = this.db.transaction(() => {
      const pending = this.db.prepare(`
        SELECT id, event_id, event_type, handler_name, payload, next_attempt_at
        FROM deliveries
        WHERE status IN ('pending', 'retrying')
          AND next_attempt_at <= @now
        ORDER BY next_attempt_at ASC
        LIMIT @limit
      `).all({ now, limit }) as Array<{
        id: string;
        event_id: string;
        event_type: string;
        handler_name: string;
        payload: string;
        next_attempt_at: string;
      }>;

      if (pending.length === 0) return [];

      const ids = pending.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');

      this.db.prepare(
        `UPDATE deliveries SET status = 'processing', updated_at = ? WHERE id IN (${placeholders})`
      ).run(now, ...ids);

      return pending;
    })();

    return (rows as Array<{
      id: string;
      event_id: string;
      event_type: string;
      handler_name: string;
      payload: string;
      next_attempt_at: string;
    }>).map((r) => ({
      deliveryId: r.id,
      eventId: r.event_id,
      eventType: r.event_type,
      handlerName: r.handler_name,
      payload: r.payload,
      scheduledAt: new Date(r.next_attempt_at),
      priority: 0,
    }));
  }

  async countPendingDeliveries(): Promise<number> {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM deliveries WHERE status IN ('pending','retrying')`
    ).get() as { cnt: number };
    return row.cnt;
  }

  // ─── Dead Letter Queue ─────────────────────────────────────

  async saveDLQRecord(r: DLQRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO dlq
        (id, original_event_id, event_type, payload,
         failure_reason, total_attempts, first_attempt_at,
         last_attempt_at, moved_to_dlq_at, reviewed, replayed,
         replayed_at, notes)
      VALUES
        (@id, @original_event_id, @event_type, @payload,
         @failure_reason, @total_attempts, @first_attempt_at,
         @last_attempt_at, @moved_to_dlq_at, @reviewed, @replayed,
         @replayed_at, @notes)
    `).run({
      id: r.id,
      original_event_id: r.originalEventId,
      event_type: r.eventType,
      payload: r.payload,
      failure_reason: r.failureReason,
      total_attempts: r.totalAttempts,
      first_attempt_at: r.firstAttemptAt.toISOString(),
      last_attempt_at: r.lastAttemptAt.toISOString(),
      moved_to_dlq_at: r.movedToDLQAt.toISOString(),
      reviewed: r.reviewed ? 1 : 0,
      replayed: r.replayed ? 1 : 0,
      replayed_at: r.replayedAt?.toISOString() ?? null,
      notes: r.notes ?? null,
    });
  }

  async getDLQRecord(id: string): Promise<DLQRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM dlq WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDLQ(row) : null;
  }

  async updateDLQRecord(
    id: string,
    partial: Partial<Omit<DLQRecord, 'id' | 'movedToDLQAt'>>
  ): Promise<void> {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    if (partial.reviewed !== undefined) { fields.push('reviewed = @reviewed'); params['reviewed'] = partial.reviewed ? 1 : 0; }
    if (partial.replayed !== undefined) { fields.push('replayed = @replayed'); params['replayed'] = partial.replayed ? 1 : 0; }
    if (partial.replayedAt !== undefined){ fields.push('replayed_at = @replayed_at'); params['replayed_at'] = partial.replayedAt?.toISOString() ?? null; }
    if (partial.notes !== undefined)    { fields.push('notes = @notes'); params['notes'] = partial.notes; }

    if (fields.length === 0) return;
    this.db.prepare(`UPDATE dlq SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }

  async listDLQRecords(opts: DLQListOptions): Promise<PaginatedResult<DLQRecord>> {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const offset = (page - 1) * limit;

    const wheres: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.reviewed !== undefined) { wheres.push('reviewed = @reviewed'); params['reviewed'] = opts.reviewed ? 1 : 0; }
    if (opts.eventType)              { wheres.push('event_type = @event_type'); params['event_type'] = opts.eventType; }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const total = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM dlq ${where}`).get(params) as { cnt: number }
    ).cnt;

    const rows = this.db.prepare(
      `SELECT * FROM dlq ${where} ORDER BY moved_to_dlq_at DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset }) as Record<string, unknown>[];

    return {
      records: rows.map((r) => this.rowToDLQ(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDLQStats(): Promise<DLQStats> {
    const total      = (this.db.prepare('SELECT COUNT(*) as cnt FROM dlq').get() as { cnt: number }).cnt;
    const unreviewed = (this.db.prepare('SELECT COUNT(*) as cnt FROM dlq WHERE reviewed = 0').get() as { cnt: number }).cnt;

    const byTypeRows = this.db.prepare(
      'SELECT event_type, COUNT(*) as cnt FROM dlq GROUP BY event_type'
    ).all() as Array<{ event_type: string; cnt: number }>;

    const byEventType: Record<string, number> = {};
    for (const r of byTypeRows) byEventType[r.event_type] = r.cnt;

    const reasonRows = this.db.prepare(
      'SELECT failure_reason, COUNT(*) as cnt FROM dlq GROUP BY failure_reason ORDER BY cnt DESC LIMIT 10'
    ).all() as Array<{ failure_reason: string; cnt: number }>;

    return {
      total,
      unreviewed,
      byEventType,
      topFailureReasons: reasonRows.map((r) => ({
        reason: r.failure_reason,
        count: r.cnt,
      })),
    };
  }

  // ─── Idempotency ───────────────────────────────────────────

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(
      'SELECT 1 FROM processed_events WHERE event_id = ? AND expires_at > ?'
    ).get(eventId, now);
    return row !== undefined;
  }

  async saveProcessedEvent(eventId: string, ttlSeconds: number): Promise<void> {
    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    this.db.prepare(
      'INSERT OR REPLACE INTO processed_events (event_id, processed_at, expires_at) VALUES (?, ?, ?)'
    ).run(eventId, now, expiresAt);
  }

  async cleanupExpiredEvents(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(
      'DELETE FROM processed_events WHERE expires_at <= ?'
    ).run(now);
    return result.changes;
  }

  // ─── Metrics ───────────────────────────────────────────────

  async getDeliveryStats(): Promise<DeliveryStats> {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'retrying'  THEN 1 ELSE 0 END) as retrying,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'dead'      THEN 1 ELSE 0 END) as dead,
        AVG(CASE WHEN status = 'delivered' THEN attempts END) as avg_attempts,
        AVG(CASE WHEN status = 'delivered' THEN duration END) as avg_duration
      FROM deliveries
    `).get() as {
      total: number; delivered: number; retrying: number;
      failed: number; dead: number;
      avg_attempts: number | null; avg_duration: number | null;
    };

    const successRate = row.total > 0
      ? Math.round((row.delivered / row.total) * 100)
      : 0;

    return {
      total: row.total,
      delivered: row.delivered,
      retrying: row.retrying,
      failed: row.failed,
      dead: row.dead,
      successRate,
      avgAttempts: row.avg_attempts ?? 0,
      avgDurationMs: row.avg_duration ?? 0,
    };
  }

  // ─── Row mappers ───────────────────────────────────────────

  private rowToDelivery(r: Record<string, unknown>): DeliveryRecord {
    return {
      id:              String(r['id']),
      eventId:         String(r['event_id']),
      eventType:       String(r['event_type']),
      handlerName:     String(r['handler_name']),
      payload:         String(r['payload']),
      status:          String(r['status']) as DeliveryRecord['status'],
      attempts:        Number(r['attempts']),
      maxAttempts:     Number(r['max_attempts']),
      lastAttemptAt:   r['last_attempt_at'] ? new Date(String(r['last_attempt_at'])) : null,
      nextAttemptAt:   new Date(String(r['next_attempt_at'])),
      lastError:       r['last_error'] ? String(r['last_error']) : null,
      lastStatusCode:  r['last_status_code'] !== null ? Number(r['last_status_code']) : null,
      duration:        r['duration'] !== null ? Number(r['duration']) : null,
      createdAt:       new Date(String(r['created_at'])),
      updatedAt:       new Date(String(r['updated_at'])),
    };
  }

  private rowToDLQ(r: Record<string, unknown>): DLQRecord {
    return {
      id:              String(r['id']),
      originalEventId: String(r['original_event_id']),
      eventType:       String(r['event_type']),
      payload:         String(r['payload']),
      failureReason:   String(r['failure_reason']),
      totalAttempts:   Number(r['total_attempts']),
      firstAttemptAt:  new Date(String(r['first_attempt_at'])),
      lastAttemptAt:   new Date(String(r['last_attempt_at'])),
      movedToDLQAt:    new Date(String(r['moved_to_dlq_at'])),
      reviewed:        Number(r['reviewed']) === 1,
      replayed:        Number(r['replayed']) === 1,
      ...(r['replayed_at'] ? { replayedAt: new Date(String(r['replayed_at'])) } : {}),
      ...(r['notes'] ? { notes: String(r['notes']) } : {}),
    };
  }
}
