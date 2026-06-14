// ============================================================
//  webhook.types.ts — Core domain types for webhook-retry
// ============================================================

/**
 * A webhook event arriving from any external provider
 * (Stripe, GitHub, Shopify, custom …)
 *
 * @template T  shape of the payload object
 */
export interface WebhookEvent<T = Record<string, unknown>> {
  /**
   * Globally unique event identifier.
   * Used by the idempotency layer to detect duplicates.
   * For Stripe events this is `evt_xxx`; for GitHub it is the
   * value in the `X-GitHub-Delivery` header.
   */
  id: string;

  /**
   * Human-readable event discriminator, e.g.
   * `"payment_intent.succeeded"` or `"push"`.
   */
  type: string;

  /** The actual data sent by the remote provider. */
  payload: T;

  /**
   * Logical source tag – lets you route events to different
   * handler pipelines without inspecting the payload.
   */
  source?: string;

  /** When the event was originally generated at the source. */
  createdAt: Date;

  /** Raw HTTP headers received with the event. */
  headers?: Record<string, string>;

  /**
   * Arbitrary key/value pairs you can attach at ingestion time
   * (e.g. tenant ID, correlation ID, replay flag).
   */
  metadata?: Record<string, string>;
}

// ─────────────────────────────────────────────
//  Handler
// ─────────────────────────────────────────────

/**
 * The return value a handler can produce.
 * Returning `void` is also accepted and treated as success.
 */
export interface HandlerResult {
  success: boolean;
  /** Optional human-readable message stored in the delivery record. */
  message?: string;
  /** Any additional data to persist alongside the delivery record. */
  data?: unknown;
}

/**
 * A handler function registered via `webhook.on()`.
 *
 * @template T  Matches the `payload` type of the expected event.
 *
 * @example
 * const handlePayment: WebhookHandler<StripePaymentIntent> = async (event) => {
 *   await db.activateSubscription(event.payload.customer);
 *   return { success: true };
 * };
 */
export type WebhookHandler<T = Record<string, unknown>> = (
  event: WebhookEvent<T>
) => Promise<HandlerResult> | Promise<void> | HandlerResult | void;

// ─────────────────────────────────────────────
//  Delivery lifecycle
// ─────────────────────────────────────────────

/**
 * All possible states a delivery attempt can be in.
 *
 * ```
 * pending ──► processing ──► delivered  ✅
 *                │
 *                └──► retrying ──► processing  (loop)
 *                          │
 *                          └──► failed ──► dead  💀
 * ```
 */
export type DeliveryStatus =
  | 'pending'     // waiting to be picked up by a worker
  | 'processing'  // a worker is executing the handler right now
  | 'delivered'   // handler succeeded
  | 'retrying'    // handler failed – scheduled for a future attempt
  | 'failed'      // handler failed on the last allowed attempt
  | 'dead';       // moved permanently to the Dead Letter Queue

/**
 * Persistent record of a single delivery lifecycle stored in the
 * chosen storage adapter.
 */
export interface DeliveryRecord {
  id: string;
  eventId: string;
  eventType: string;
  /** Name of the registered handler (function.name or auto-generated). */
  handlerName: string;
  /** JSON-serialised payload for re-execution during retries. */
  payload: string;
  status: DeliveryStatus;
  /** Number of execution attempts so far (starts at 0). */
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date;
  /** Last error message for observability. */
  lastError: string | null;
  /** Last HTTP status code returned by the handler (if applicable). */
  lastStatusCode: number | null;
  /** How long (ms) the last attempt took. */
  duration: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The result of a single execution attempt, used by RetryEngine
 * to decide whether to retry or give up.
 */
export interface AttemptResult {
  success: boolean;
  error?: string;
  statusCode?: number;
  /** Wall-clock duration in milliseconds. */
  duration: number;
  timestamp: Date;
}

// ─────────────────────────────────────────────
//  Queue item (internal)
// ─────────────────────────────────────────────

/**
 * An item sitting in the queue waiting to be processed.
 * Wraps a `DeliveryRecord` with scheduling metadata.
 */
export interface QueueItem {
  deliveryId: string;
  eventId: string;
  eventType: string;
  handlerName: string;
  payload: string;
  scheduledAt: Date;
  priority: number; // lower = higher priority
}
