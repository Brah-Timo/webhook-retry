// ============================================================
//  DLQReplay.ts — Re-enqueue DLQ records for processing
// ============================================================

import type { DeadLetterQueue } from './DeadLetterQueue.js';
import type { QueueManager } from '../core/QueueManager.js';
import type { WebhookRegistry } from '../core/WebhookRegistry.js';
import type { WebhookEvent } from '../types/webhook.types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DLQReplay');

export interface ReplayOptions {
  /** Re-use original event ID (may be blocked by idempotency guard). @default false */
  keepOriginalId?: boolean;
  /** Filter: only replay records of this event type. */
  eventType?: string;
}

export class DLQReplay {
  constructor(
    private readonly dlq: DeadLetterQueue,
    private readonly queue: QueueManager,
    private readonly registry: WebhookRegistry
  ) {}

  /**
   * Replay a single DLQ record by its ID.
   *
   * Creates a fresh delivery with a new event ID (by default) so that
   * the idempotency guard does not block it.
   *
   * @throws Error if the DLQ record is not found.
   */
  async replay(dlqId: string, opts: ReplayOptions = {}): Promise<string[]> {
    const record = await this.dlq.get(dlqId);
    if (!record) {
      throw new Error(`DLQ record not found: ${dlqId}`);
    }

    const event: WebhookEvent = {
      id: opts.keepOriginalId
        ? record.originalEventId
        : crypto.randomUUID(),
      type:      record.eventType,
      payload:   JSON.parse(record.payload) as Record<string, unknown>,
      createdAt: new Date(),
      metadata: {
        replayedFrom: record.id,
        originalEventId: record.originalEventId,
      },
    };

    const handlers = this.registry.getHandlers(event.type);
    if (handlers.length === 0) {
      log.warn({ eventType: event.type }, 'No handlers found for replayed event type');
    }

    const maxAttempts = handlers[0]?.retryEngine.maxRetries ?? 5;
    const deliveryIds = await this.queue.enqueue(event, handlers.map((h) => h.name), maxAttempts);

    await this.dlq.markReplayed(dlqId);

    log.info(
      { dlqId, newEventId: event.id, deliveryIds },
      'DLQ record replayed ♻️'
    );

    return deliveryIds;
  }

  /**
   * Replay all unreviewed (or all) DLQ records.
   *
   * @param opts.eventType  If set, only replay records for this event type.
   * @returns               Count of records successfully replayed.
   */
  async replayAll(opts: ReplayOptions = {}): Promise<number> {
    const { records } = await this.dlq.list({
      reviewed: false,
      ...(opts.eventType ? { eventType: opts.eventType } : {}),
      limit: 1000,
    });

    let count = 0;
    for (const rec of records) {
      try {
        await this.replay(rec.id, opts);
        count++;
      } catch (err) {
        log.warn({ dlqId: rec.id, err }, 'Failed to replay DLQ record — skipping');
      }
    }

    log.info({ replayed: count }, 'Bulk DLQ replay complete');
    return count;
  }

  /**
   * Replay DLQ records that match a custom predicate.
   *
   * @example
   * // Replay only events from the last 24 hours
   * const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
   * await replay.replayWhere((r) => r.movedToDLQAt > cutoff);
   */
  async replayWhere(
    predicate: (record: import('../types/storage.types.js').DLQRecord) => boolean,
    opts: ReplayOptions = {}
  ): Promise<number> {
    const { records } = await this.dlq.list({ limit: 5000 });
    const matching = records.filter(predicate);

    let count = 0;
    for (const rec of matching) {
      try {
        await this.replay(rec.id, opts);
        count++;
      } catch {
        /* skip individual failures */
      }
    }

    return count;
  }
}
