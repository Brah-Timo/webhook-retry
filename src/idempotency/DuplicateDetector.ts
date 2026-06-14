// ============================================================
//  DuplicateDetector.ts — Guards handler execution against
//                         at-least-once delivery duplicates
//
//  Problem:
//    Stripe, GitHub, and most webhook providers guarantee
//    "at-least-once" delivery, meaning they may send the same
//    event more than once (especially after timeouts or network
//    hiccups on their side).
//
//  Solution:
//    Before executing a handler, check the IdempotencyStore.
//    After successful execution, record the event ID.
//    Duplicate calls short-circuit immediately.
//
//  Example:
//    Stripe sends `payment_intent.succeeded` twice.
//    First time: processed → subscription activated.
//    Second time: DuplicateDetector sees the ID → skip → no
//                 double-activation, no double-email.
// ============================================================

import { IdempotencyStore } from './IdempotencyStore.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DuplicateDetector');

export class DuplicateDetector {
  private readonly store: IdempotencyStore;

  constructor(
    store: IdempotencyStore,
  ) {
    this.store = store;
  }

  /**
   * Check if `eventId` is a duplicate.
   *
   * @returns `true` if the event has already been processed and
   *          the handler should be **skipped**.
   */
  async check(eventId: string): Promise<boolean> {
    const duplicate = await this.store.isDuplicate(eventId);
    if (duplicate) {
      log.debug({ eventId }, 'Duplicate event detected — skipping');
    }
    return duplicate;
  }

  /**
   * Record that `eventId` was handled successfully.
   * Call this **after** the handler completes without throwing.
   */
  async commit(eventId: string): Promise<void> {
    await this.store.markProcessed(eventId);
  }

  /**
   * Convenience: check-then-execute pattern.
   *
   * If the event is a duplicate, `fn` is never called and the method
   * returns `null`.  Otherwise calls `fn` and, on success, commits
   * the event ID.
   *
   * @example
   * const result = await detector.withIdempotency(event.id, async () => {
   *   await activateSubscription(event.payload.customerId);
   *   return { subscriptionId: '...' };
   * });
   * if (result === null) {
   *   console.log('Duplicate — already handled');
   * }
   */
  async withIdempotency<T>(
    eventId: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    if (await this.check(eventId)) {
      return null;
    }

    const result = await fn();
    await this.commit(eventId);
    return result;
  }
}
