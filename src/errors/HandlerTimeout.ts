// ============================================================
//  HandlerTimeout.ts
// ============================================================

import { WebhookRetryError } from './WebhookRetryError.js';

/**
 * Thrown when a handler exceeds the configured timeout.
 * Treated as a retryable failure by the DeliveryWorker.
 */
export class HandlerTimeout extends WebhookRetryError {
  constructor(handlerName: string, timeoutMs: number) {
    super(
      `Handler "${handlerName}" exceeded timeout of ${timeoutMs}ms`,
      'HANDLER_TIMEOUT',
      { handlerName, timeoutMs }
    );
    this.name = 'HandlerTimeout';
  }
}
