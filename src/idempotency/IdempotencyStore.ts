// ============================================================
//  IdempotencyStore.ts — Key-value TTL store for event IDs
// ============================================================

import type { StorageInterface } from '../storage/StorageInterface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('IdempotencyStore');

export class IdempotencyStore {
  constructor(
    private readonly storage: StorageInterface,
    /** How long (seconds) to remember a processed event. @default 86400 (24h) */
    private readonly ttlSeconds: number = 86_400
  ) {}

  /**
   * Check if an event ID has already been processed successfully.
   *
   * Returns `true` if the event should be **skipped** (duplicate).
   */
  async isDuplicate(eventId: string): Promise<boolean> {
    return this.storage.hasProcessedEvent(eventId);
  }

  /**
   * Mark an event ID as successfully processed.
   * Subsequent calls with the same ID will return `isDuplicate = true`
   * until the TTL expires.
   */
  async markProcessed(eventId: string): Promise<void> {
    await this.storage.saveProcessedEvent(eventId, this.ttlSeconds);
    log.debug({ eventId, ttlSeconds: this.ttlSeconds }, 'Event marked as processed');
  }

  /**
   * Remove all expired idempotency keys from the store.
   * Run periodically (e.g. daily) to prevent unbounded growth.
   *
   * @returns Number of records deleted.
   */
  async cleanup(): Promise<number> {
    const removed = await this.storage.cleanupExpiredEvents();
    log.info({ removed }, 'Idempotency key cleanup complete');
    return removed;
  }
}
