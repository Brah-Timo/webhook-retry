// ============================================================
//  QueueManager.ts — Enqueue / dequeue / reschedule deliveries
// ============================================================

import type { WebhookEvent, DeliveryRecord, QueueItem } from '../types/webhook.types.js';
import type { StorageInterface } from '../storage/StorageInterface.js';
import type { DeliveryListOptions, PaginatedResult } from '../types/storage.types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('QueueManager');

export class QueueManager {
  constructor(private readonly storage: StorageInterface) {}

  // ─── Enqueue ───────────────────────────────────────────────

  /**
   * Add a new event to the delivery queue.
   *
   * Creates one `DeliveryRecord` per registered handler.
   * Returns the list of delivery IDs created.
   *
   * @param event         The incoming webhook event
   * @param handlerNames  Names of handlers that should receive this event
   * @param maxAttempts   Max attempts per handler (from RetryEngine)
   */
  async enqueue(
    event: WebhookEvent,
    handlerNames: string[],
    maxAttempts: number
  ): Promise<string[]> {
    const ids: string[] = [];
    const now = new Date();

    for (const handlerName of handlerNames) {
      const record: DeliveryRecord = {
        id: crypto.randomUUID(),
        eventId: event.id,
        eventType: event.type,
        handlerName,
        payload: JSON.stringify(event.payload),
        status: 'pending',
        attempts: 0,
        maxAttempts,
        lastAttemptAt: null,
        nextAttemptAt: now,
        lastError: null,
        lastStatusCode: null,
        duration: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.storage.saveDelivery(record);
      ids.push(record.id);

      log.debug(
        { deliveryId: record.id, eventId: event.id, handlerName },
        'Event enqueued'
      );
    }

    return ids;
  }

  // ─── Dequeue ───────────────────────────────────────────────

  /**
   * Fetch the next batch of deliveries that are ready to be executed.
   * "Ready" means: `status` is `pending` or `retrying` AND
   * `nextAttemptAt` ≤ now.
   *
   * Atomically marks each returned record as `processing` to prevent
   * duplicate pickup by concurrent workers.
   */
  async dequeue(limit = 10): Promise<QueueItem[]> {
    return this.storage.claimPendingDeliveries(limit);
  }

  // ─── Lifecycle updates ─────────────────────────────────────

  /**
   * Mark a delivery as successfully completed.
   */
  async markDelivered(deliveryId: string, duration: number): Promise<void> {
    await this.storage.updateDelivery(deliveryId, {
      status: 'delivered',
      duration,
      updatedAt: new Date(),
    });
    log.info({ deliveryId }, 'Delivery marked as delivered ✅');
  }

  /**
   * Schedule a retry for a failed delivery.
   *
   * @param deliveryId   The delivery to reschedule
   * @param attempts     The new total attempt count
   * @param nextAttempt  When to next attempt delivery
   * @param error        Error message from the last attempt
   * @param statusCode   HTTP status code (if applicable)
   * @param duration     Duration of the last attempt in ms
   */
  async scheduleRetry(
    deliveryId: string,
    attempts: number,
    nextAttempt: Date,
    error: string,
    statusCode?: number,
    duration?: number
  ): Promise<void> {
    await this.storage.updateDelivery(deliveryId, {
      status: 'retrying',
      attempts,
      lastAttemptAt: new Date(),
      nextAttemptAt: nextAttempt,
      lastError: error,
      lastStatusCode: statusCode ?? null,
      duration: duration ?? null,
      updatedAt: new Date(),
    });

    log.debug({ deliveryId, attempts, nextAttempt }, 'Retry scheduled 🔄');
  }

  /**
   * Mark a delivery as permanently failed (moved to DLQ).
   */
  async markDead(
    deliveryId: string,
    attempts: number,
    error: string
  ): Promise<void> {
    await this.storage.updateDelivery(deliveryId, {
      status: 'dead',
      attempts,
      lastAttemptAt: new Date(),
      lastError: error,
      updatedAt: new Date(),
    });
    log.warn({ deliveryId }, 'Delivery moved to dead state 💀');
  }

  /**
   * Reset a delivery back to `pending` so it can be re-executed.
   * Used by the DLQ replay mechanism.
   */
  async resetForReplay(deliveryId: string): Promise<void> {
    await this.storage.updateDelivery(deliveryId, {
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    });
    log.info({ deliveryId }, 'Delivery reset for replay');
  }

  // ─── Queries ───────────────────────────────────────────────

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    return this.storage.getDelivery(id);
  }

  async listDeliveries(
    options: DeliveryListOptions
  ): Promise<PaginatedResult<DeliveryRecord>> {
    return this.storage.listDeliveries(options);
  }

  /**
   * Count how many pending/retrying items are currently in the queue.
   */
  async queueDepth(): Promise<number> {
    return this.storage.countPendingDeliveries();
  }
}
