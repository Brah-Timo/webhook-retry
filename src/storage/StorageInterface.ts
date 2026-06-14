// ============================================================
//  StorageInterface.ts — Unified contract for all adapters
// ============================================================

import type {
  DeliveryRecord,
  QueueItem,
} from '../types/webhook.types.js';
import type {
  DLQRecord,
  DeliveryListOptions,
  DLQListOptions,
  PaginatedResult,
  DeliveryStats,
  DLQStats,
  ProcessedEventRecord,
} from '../types/storage.types.js';

/**
 * Every storage adapter must implement this interface.
 * This keeps the business logic completely decoupled from the
 * persistence mechanism.
 *
 * Available adapters:
 * - `SQLiteAdapter`  — local / small-scale (default)
 * - `RedisAdapter`   — production / distributed
 * - `PostgresAdapter`— enterprise
 * - `MemoryAdapter`  — testing only (no persistence)
 */
export interface StorageInterface {
  // ─── Lifecycle ─────────────────────────────────────────────

  /** Initialise the adapter (create tables, indexes, connections). */
  init(): Promise<void>;

  /** Gracefully close connections. */
  close(): Promise<void>;

  // ─── Delivery records ──────────────────────────────────────

  saveDelivery(record: DeliveryRecord): Promise<void>;

  getDelivery(id: string): Promise<DeliveryRecord | null>;

  /**
   * Apply a partial update to a delivery record.
   * Only the provided fields are written; others remain unchanged.
   */
  updateDelivery(
    id: string,
    partial: Partial<Omit<DeliveryRecord, 'id' | 'createdAt'>>
  ): Promise<void>;

  listDeliveries(
    options: DeliveryListOptions
  ): Promise<PaginatedResult<DeliveryRecord>>;

  /**
   * Atomically claim up to `limit` pending/retrying deliveries
   * whose `nextAttemptAt` ≤ now, setting their status to
   * `processing`.
   *
   * Atomicity ensures no two workers pick up the same item.
   */
  claimPendingDeliveries(limit: number): Promise<QueueItem[]>;

  /** Count deliveries in `pending` or `retrying` state. */
  countPendingDeliveries(): Promise<number>;

  // ─── Dead Letter Queue ─────────────────────────────────────

  saveDLQRecord(record: DLQRecord): Promise<void>;

  getDLQRecord(id: string): Promise<DLQRecord | null>;

  updateDLQRecord(
    id: string,
    partial: Partial<Omit<DLQRecord, 'id' | 'movedToDLQAt'>>
  ): Promise<void>;

  listDLQRecords(options: DLQListOptions): Promise<PaginatedResult<DLQRecord>>;

  getDLQStats(): Promise<DLQStats>;

  // ─── Idempotency ───────────────────────────────────────────

  /** Return `true` if an event with this ID has already been processed. */
  hasProcessedEvent(eventId: string): Promise<boolean>;

  /**
   * Record that `eventId` has been successfully processed.
   * The record expires after `ttlSeconds`.
   */
  saveProcessedEvent(
    eventId: string,
    ttlSeconds: number
  ): Promise<void>;

  /** Delete all expired idempotency keys. Returns the count deleted. */
  cleanupExpiredEvents(): Promise<number>;

  // ─── Metrics ───────────────────────────────────────────────

  getDeliveryStats(): Promise<DeliveryStats>;
}
