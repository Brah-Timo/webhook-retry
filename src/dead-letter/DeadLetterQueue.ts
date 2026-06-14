// ============================================================
//  DeadLetterQueue.ts
//
//  Philosophy: no event is ever silently discarded.
//  If all retry attempts fail, the event lands here where
//  an operator can review it and trigger a replay at any time.
// ============================================================

import type { WebhookEvent, DeliveryRecord } from '../types/webhook.types.js';
import type { DLQRecord, DLQListOptions, PaginatedResult, DLQStats } from '../types/storage.types.js';
import type { StorageInterface } from '../storage/StorageInterface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DeadLetterQueue');

export class DeadLetterQueue {
  constructor(private readonly storage: StorageInterface) {}

  // ─── Write ─────────────────────────────────────────────────

  /**
   * Move a permanently-failed delivery into the DLQ.
   *
   * @param record         The delivery record (for metadata)
   * @param event          The original webhook event (for replay)
   * @param failureReason  Last error message
   * @returns              The saved DLQ record
   */
  async push(
    record: DeliveryRecord,
    event: WebhookEvent,
    failureReason: string
  ): Promise<DLQRecord> {
    const dlqRecord: DLQRecord = {
      id:              crypto.randomUUID(),
      originalEventId: event.id,
      eventType:       event.type,
      payload:         JSON.stringify(event.payload),
      failureReason,
      totalAttempts:   record.attempts,
      firstAttemptAt:  record.createdAt,
      lastAttemptAt:   new Date(),
      movedToDLQAt:    new Date(),
      reviewed:        false,
      replayed:        false,
    };

    await this.storage.saveDLQRecord(dlqRecord);

    log.error(
      {
        dlqId:     dlqRecord.id,
        eventId:   event.id,
        eventType: event.type,
        attempts:  record.attempts,
        reason:    failureReason,
      },
      '💀 Event moved to Dead Letter Queue'
    );

    return dlqRecord;
  }

  // ─── Read ──────────────────────────────────────────────────

  /** Fetch a single DLQ record by its ID. */
  async get(dlqId: string): Promise<DLQRecord | null> {
    return this.storage.getDLQRecord(dlqId);
  }

  /**
   * List DLQ records with optional filtering and pagination.
   *
   * @example
   * const { records, total } = await dlq.list({ reviewed: false, limit: 20 });
   */
  async list(opts: DLQListOptions = {}): Promise<PaginatedResult<DLQRecord>> {
    return this.storage.listDLQRecords(opts);
  }

  /** Aggregate statistics about the DLQ contents. */
  async getStats(): Promise<DLQStats> {
    return this.storage.getDLQStats();
  }

  // ─── Review & annotation ───────────────────────────────────

  /**
   * Mark a DLQ record as reviewed and optionally attach a note.
   * Useful for tracking operator investigations in the dashboard.
   */
  async review(dlqId: string, notes?: string): Promise<void> {
    await this.storage.updateDLQRecord(dlqId, {
      reviewed: true,
      ...(notes !== undefined ? { notes } : {}),
    });
    log.info({ dlqId }, 'DLQ record reviewed');
  }

  /** Add or update the operator note on a DLQ record. */
  async addNote(dlqId: string, notes: string): Promise<void> {
    await this.storage.updateDLQRecord(dlqId, { reviewed: true, notes });
    log.debug({ dlqId }, 'Note added to DLQ record');
  }

  // ─── Mark replayed ─────────────────────────────────────────

  /** Internal: called by DLQReplay after a successful re-enqueue. */
  async markReplayed(dlqId: string): Promise<void> {
    await this.storage.updateDLQRecord(dlqId, {
      replayed:   true,
      replayedAt: new Date(),
    });
    log.info({ dlqId }, 'DLQ record marked as replayed ♻️');
  }
}
