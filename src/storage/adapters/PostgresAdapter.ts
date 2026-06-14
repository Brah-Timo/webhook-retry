// ============================================================
//  PostgresAdapter.ts — PostgreSQL storage adapter (pg)
//
//  Ideal for:
//  - Enterprise deployments
//  - Complex analytics & reporting needs
//  - Multi-tenant architectures
//
//  claimPendingDeliveries uses SELECT … FOR UPDATE SKIP LOCKED
//  which is the PostgreSQL-idiomatic way to build job queues.
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

const log = createLogger('PostgresAdapter');

type Pool = import('pg').Pool;

export class PostgresAdapter implements StorageInterface {
  private pool!: Pool;

  constructor(
    private readonly connectionString: string
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────

  async init(): Promise<void> {
    const { Pool } = await import('pg') as unknown as { Pool: new (opts: { connectionString: string }) => Pool };
    this.pool = new Pool({ connectionString: this.connectionString });
    await this.pool.query('SELECT 1'); // connection check
    await this.createSchema();
    log.info('PostgresAdapter initialised');
  }

  async close(): Promise<void> {
    await this.pool.end();
    log.info('PostgresAdapter closed');
  }

  // ─── Schema ────────────────────────────────────────────────

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS wr_deliveries (
        id               TEXT PRIMARY KEY,
        event_id         TEXT NOT NULL,
        event_type       TEXT NOT NULL,
        handler_name     TEXT NOT NULL,
        payload          TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        attempts         INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL DEFAULT 5,
        last_attempt_at  TIMESTAMPTZ,
        next_attempt_at  TIMESTAMPTZ NOT NULL,
        last_error       TEXT,
        last_status_code INTEGER,
        duration         INTEGER,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS wr_deliveries_status_next
        ON wr_deliveries (status, next_attempt_at)
        WHERE status IN ('pending', 'retrying');

      CREATE TABLE IF NOT EXISTS wr_dlq (
        id                TEXT PRIMARY KEY,
        original_event_id TEXT NOT NULL,
        event_type        TEXT NOT NULL,
        payload           TEXT NOT NULL,
        failure_reason    TEXT NOT NULL,
        total_attempts    INTEGER NOT NULL DEFAULT 0,
        first_attempt_at  TIMESTAMPTZ NOT NULL,
        last_attempt_at   TIMESTAMPTZ NOT NULL,
        moved_to_dlq_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed          BOOLEAN NOT NULL DEFAULT FALSE,
        replayed          BOOLEAN NOT NULL DEFAULT FALSE,
        replayed_at       TIMESTAMPTZ,
        notes             TEXT
      );

      CREATE TABLE IF NOT EXISTS wr_processed_events (
        event_id     TEXT PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wr_pe_expires ON wr_processed_events (expires_at);
    `);
  }

  // ─── Delivery records ──────────────────────────────────────

  async saveDelivery(r: DeliveryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO wr_deliveries
         (id, event_id, event_type, handler_name, payload,
          status, attempts, max_attempts, last_attempt_at,
          next_attempt_at, last_error, last_status_code,
          duration, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        r.id, r.eventId, r.eventType, r.handlerName, r.payload,
        r.status, r.attempts, r.maxAttempts, r.lastAttemptAt,
        r.nextAttemptAt, r.lastError, r.lastStatusCode,
        r.duration, r.createdAt, r.updatedAt,
      ]
    );
  }

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    const res = await this.pool.query(
      'SELECT * FROM wr_deliveries WHERE id = $1', [id]
    );
    return res.rows[0] ? this.rowToDelivery(res.rows[0] as Record<string, unknown>) : null;
  }

  async updateDelivery(
    id: string,
    partial: Partial<Omit<DeliveryRecord, 'id' | 'createdAt'>>
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    const add = (col: string, val: unknown) => { sets.push(`${col} = $${i++}`); vals.push(val); };

    if (partial.status !== undefined)        add('status', partial.status);
    if (partial.attempts !== undefined)      add('attempts', partial.attempts);
    if ('lastAttemptAt' in partial)          add('last_attempt_at', partial.lastAttemptAt ?? null);
    if (partial.nextAttemptAt !== undefined) add('next_attempt_at', partial.nextAttemptAt);
    if ('lastError' in partial)              add('last_error', partial.lastError ?? null);
    if ('lastStatusCode' in partial)         add('last_status_code', partial.lastStatusCode ?? null);
    if ('duration' in partial)               add('duration', partial.duration ?? null);
    if (partial.updatedAt !== undefined)     add('updated_at', partial.updatedAt);

    if (sets.length === 0) return;
    vals.push(id);
    await this.pool.query(
      `UPDATE wr_deliveries SET ${sets.join(', ')} WHERE id = $${i}`,
      vals
    );
  }

  async listDeliveries(opts: DeliveryListOptions): Promise<PaginatedResult<DeliveryRecord>> {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const offset = (page - 1) * limit;

    const wheres: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (opts.status)    { wheres.push(`status = $${i++}`);     vals.push(opts.status); }
    if (opts.eventType) { wheres.push(`event_type = $${i++}`); vals.push(opts.eventType); }
    if (opts.since)     { wheres.push(`created_at >= $${i++}`);vals.push(opts.since); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';

    const countRes = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM wr_deliveries ${where}`, vals
    );
    const total = parseInt((countRes.rows[0] as { cnt: string }).cnt, 10);

    const dataRes = await this.pool.query(
      `SELECT * FROM wr_deliveries ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...vals, limit, offset]
    );

    return {
      records: (dataRes.rows as Record<string, unknown>[]).map((r) => this.rowToDelivery(r)),
      total, page, limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async claimPendingDeliveries(limit: number): Promise<QueueItem[]> {
    // SELECT … FOR UPDATE SKIP LOCKED is the Postgres-idiomatic queue pattern
    const res = await this.pool.query(`
      WITH claimed AS (
        SELECT id FROM wr_deliveries
        WHERE status IN ('pending', 'retrying')
          AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE wr_deliveries d
      SET status = 'processing', updated_at = NOW()
      FROM claimed
      WHERE d.id = claimed.id
      RETURNING d.*
    `, [limit]);

    return (res.rows as Record<string, unknown>[]).map((r) => {
      const d = this.rowToDelivery(r);
      return {
        deliveryId:  d.id,
        eventId:     d.eventId,
        eventType:   d.eventType,
        handlerName: d.handlerName,
        payload:     d.payload,
        scheduledAt: d.nextAttemptAt,
        priority:    0,
      };
    });
  }

  async countPendingDeliveries(): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM wr_deliveries WHERE status IN ('pending','retrying')`
    );
    return parseInt((res.rows[0] as { cnt: string }).cnt, 10);
  }

  // ─── DLQ ───────────────────────────────────────────────────

  async saveDLQRecord(r: DLQRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO wr_dlq
         (id, original_event_id, event_type, payload,
          failure_reason, total_attempts, first_attempt_at,
          last_attempt_at, moved_to_dlq_at, reviewed, replayed,
          replayed_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        r.id, r.originalEventId, r.eventType, r.payload,
        r.failureReason, r.totalAttempts, r.firstAttemptAt,
        r.lastAttemptAt, r.movedToDLQAt, r.reviewed, r.replayed,
        r.replayedAt ?? null, r.notes ?? null,
      ]
    );
  }

  async getDLQRecord(id: string): Promise<DLQRecord | null> {
    const res = await this.pool.query('SELECT * FROM wr_dlq WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToDLQ(res.rows[0] as Record<string, unknown>) : null;
  }

  async updateDLQRecord(
    id: string,
    partial: Partial<Omit<DLQRecord, 'id' | 'movedToDLQAt'>>
  ): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (partial.reviewed !== undefined)   { sets.push(`reviewed = $${i++}`);   vals.push(partial.reviewed); }
    if (partial.replayed !== undefined)   { sets.push(`replayed = $${i++}`);   vals.push(partial.replayed); }
    if (partial.replayedAt !== undefined) { sets.push(`replayed_at = $${i++}`);vals.push(partial.replayedAt ?? null); }
    if (partial.notes !== undefined)      { sets.push(`notes = $${i++}`);       vals.push(partial.notes); }

    if (sets.length === 0) return;
    vals.push(id);
    await this.pool.query(`UPDATE wr_dlq SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  }

  async listDLQRecords(opts: DLQListOptions): Promise<PaginatedResult<DLQRecord>> {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 50;
    const offset = (page - 1) * limit;
    const wheres: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (opts.reviewed !== undefined) { wheres.push(`reviewed = $${i++}`);     vals.push(opts.reviewed); }
    if (opts.eventType)              { wheres.push(`event_type = $${i++}`);   vals.push(opts.eventType); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const cntRes = await this.pool.query(`SELECT COUNT(*) as cnt FROM wr_dlq ${where}`, vals);
    const total = parseInt((cntRes.rows[0] as { cnt: string }).cnt, 10);
    const dataRes = await this.pool.query(
      `SELECT * FROM wr_dlq ${where} ORDER BY moved_to_dlq_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...vals, limit, offset]
    );

    return {
      records: (dataRes.rows as Record<string, unknown>[]).map((r) => this.rowToDLQ(r)),
      total, page, limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDLQStats(): Promise<DLQStats> {
    const [totRes, unrRes, byTypeRes, byReasonRes] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as cnt FROM wr_dlq'),
      this.pool.query('SELECT COUNT(*) as cnt FROM wr_dlq WHERE reviewed = FALSE'),
      this.pool.query('SELECT event_type, COUNT(*) as cnt FROM wr_dlq GROUP BY event_type'),
      this.pool.query('SELECT failure_reason, COUNT(*) as cnt FROM wr_dlq GROUP BY failure_reason ORDER BY cnt DESC LIMIT 10'),
    ]);

    const byEventType: Record<string, number> = {};
    for (const r of byTypeRes.rows as Array<{ event_type: string; cnt: string }>) {
      byEventType[r.event_type] = parseInt(r.cnt, 10);
    }

    return {
      total: parseInt((totRes.rows[0] as { cnt: string }).cnt, 10),
      unreviewed: parseInt((unrRes.rows[0] as { cnt: string }).cnt, 10),
      byEventType,
      topFailureReasons: (byReasonRes.rows as Array<{ failure_reason: string; cnt: string }>)
        .map((r) => ({ reason: r.failure_reason, count: parseInt(r.cnt, 10) })),
    };
  }

  // ─── Idempotency ───────────────────────────────────────────

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const res = await this.pool.query(
      'SELECT 1 FROM wr_processed_events WHERE event_id = $1 AND expires_at > $2',
      [eventId, now]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async saveProcessedEvent(eventId: string, ttlSeconds: number): Promise<void> {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    await this.pool.query(
      `INSERT INTO wr_processed_events (event_id, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [eventId, expiresAt]
    );
  }

  async cleanupExpiredEvents(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const res = await this.pool.query(
      'DELETE FROM wr_processed_events WHERE expires_at <= $1', [now]
    );
    return res.rowCount ?? 0;
  }

  // ─── Metrics ───────────────────────────────────────────────

  async getDeliveryStats(): Promise<DeliveryStats> {
    const res = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'retrying'  THEN 1 ELSE 0 END) as retrying,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'dead'      THEN 1 ELSE 0 END) as dead,
        AVG(CASE WHEN status = 'delivered' THEN attempts END) as avg_attempts,
        AVG(CASE WHEN status = 'delivered' THEN duration END) as avg_duration
      FROM wr_deliveries
    `);

    const row = res.rows[0] as {
      total: string; delivered: string; retrying: string;
      failed: string; dead: string; avg_attempts: string | null; avg_duration: string | null;
    };

    const total     = parseInt(row.total, 10);
    const delivered = parseInt(row.delivered, 10);

    return {
      total, delivered,
      retrying: parseInt(row.retrying, 10),
      failed:   parseInt(row.failed, 10),
      dead:     parseInt(row.dead, 10),
      successRate: total > 0 ? Math.round((delivered / total) * 100) : 0,
      avgAttempts:   row.avg_attempts   ? parseFloat(row.avg_attempts)   : 0,
      avgDurationMs: row.avg_duration   ? parseFloat(row.avg_duration)   : 0,
    };
  }

  // ─── Row mappers ───────────────────────────────────────────

  private rowToDelivery(r: Record<string, unknown>): DeliveryRecord {
    return {
      id: String(r['id']), eventId: String(r['event_id']),
      eventType: String(r['event_type']), handlerName: String(r['handler_name']),
      payload: String(r['payload']),
      status: String(r['status']) as DeliveryRecord['status'],
      attempts: Number(r['attempts']), maxAttempts: Number(r['max_attempts']),
      lastAttemptAt: r['last_attempt_at'] ? new Date(String(r['last_attempt_at'])) : null,
      nextAttemptAt: new Date(String(r['next_attempt_at'])),
      lastError: r['last_error'] ? String(r['last_error']) : null,
      lastStatusCode: r['last_status_code'] !== null && r['last_status_code'] !== undefined ? Number(r['last_status_code']) : null,
      duration: r['duration'] !== null && r['duration'] !== undefined ? Number(r['duration']) : null,
      createdAt: new Date(String(r['created_at'])),
      updatedAt: new Date(String(r['updated_at'])),
    };
  }

  private rowToDLQ(r: Record<string, unknown>): DLQRecord {
    return {
      id: String(r['id']), originalEventId: String(r['original_event_id']),
      eventType: String(r['event_type']), payload: String(r['payload']),
      failureReason: String(r['failure_reason']),
      totalAttempts: Number(r['total_attempts']),
      firstAttemptAt: new Date(String(r['first_attempt_at'])),
      lastAttemptAt:  new Date(String(r['last_attempt_at'])),
      movedToDLQAt:   new Date(String(r['moved_to_dlq_at'])),
      reviewed: Boolean(r['reviewed']), replayed: Boolean(r['replayed']),
      ...(r['replayed_at'] ? { replayedAt: new Date(String(r['replayed_at'])) } : {}),
      ...(r['notes'] ? { notes: String(r['notes']) } : {}),
    };
  }
}
