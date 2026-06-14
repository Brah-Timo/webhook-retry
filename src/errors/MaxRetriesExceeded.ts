// ============================================================
//  MaxRetriesExceeded.ts
// ============================================================

import { WebhookRetryError } from './WebhookRetryError.js';

/**
 * Thrown internally when a delivery exhausts all allowed retries.
 * Caught by `DeliveryWorker` to trigger the DLQ transition.
 */
export class MaxRetriesExceeded extends WebhookRetryError {
  constructor(
    eventId: string,
    eventType: string,
    attempts: number,
    lastError: string
  ) {
    super(
      `Event "${eventType}" (${eventId}) failed after ${attempts} attempt(s): ${lastError}`,
      'MAX_RETRIES_EXCEEDED',
      { eventId, eventType, attempts, lastError }
    );
    this.name = 'MaxRetriesExceeded';
  }
}
