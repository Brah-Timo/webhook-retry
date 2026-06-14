// ============================================================
//  ReplayController.ts — Dashboard-facing replay actions
// ============================================================

import type { DeadLetterQueue } from '../dead-letter/DeadLetterQueue.js';
import type { DLQReplay } from '../dead-letter/DLQReplay.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ReplayController');

export class ReplayController {
  private readonly _dlq: DeadLetterQueue;
  private readonly _dlqReplay: DLQReplay;

  constructor(dlq: DeadLetterQueue, dlqReplay: DLQReplay) {
    this._dlq = dlq;
    this._dlqReplay = dlqReplay;
  }

  /**
   * Replay a single DLQ record by its ID.
   */
  async replay(dlqId: string): Promise<string[]> {
    log.info({ dlqId }, 'Dashboard triggered single replay');
    return this._dlqReplay.replay(dlqId);
  }

  /**
   * Replay all unreviewed DLQ records.
   * Returns the count of records replayed.
   */
  async replayAll(): Promise<number> {
    log.info('Dashboard triggered bulk replay');
    return this._dlqReplay.replayAll();
  }

  /**
   * Replay DLQ records for a specific event type.
   */
  async replayByType(eventType: string): Promise<number> {
    log.info({ eventType }, 'Dashboard triggered event-type replay');
    return this._dlqReplay.replayAll({ eventType });
  }

  /**
   * Mark a DLQ record as reviewed with an optional note.
   */
  async reviewRecord(dlqId: string, notes?: string): Promise<void> {
    await this._dlq.review(dlqId, notes);
    log.info({ dlqId }, 'Dashboard marked DLQ record as reviewed');
  }
}
