// ============================================================
//  WebhookRetryError.ts — Base error class
// ============================================================

/**
 * Base class for all errors thrown by webhook-retry.
 * Extend this to create domain-specific error types.
 */
export class WebhookRetryError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WebhookRetryError';
    this.code = code;
    this.context = context;

    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
