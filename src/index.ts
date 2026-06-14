// ============================================================
//  src/index.ts — Public API surface of webhook-retry
// ============================================================

import { WebhookRegistry } from './core/WebhookRegistry.js';
import { DeliveryWorker } from './core/DeliveryWorker.js';
import { QueueManager } from './core/QueueManager.js';
import { DeadLetterQueue } from './dead-letter/DeadLetterQueue.js';
import { DLQReplay } from './dead-letter/DLQReplay.js';
import { DLQAnalyzer } from './dead-letter/DLQAnalyzer.js';
import { IdempotencyStore } from './idempotency/IdempotencyStore.js';
import { SQLiteAdapter } from './storage/adapters/SQLiteAdapter.js';
import { RedisAdapter } from './storage/adapters/RedisAdapter.js';
import { MemoryAdapter } from './storage/adapters/MemoryAdapter.js';
import type { StorageInterface } from './storage/StorageInterface.js';
import type { WebhookEvent, WebhookHandler } from './types/webhook.types.js';
import type { RetryConfig } from './types/retry.types.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('WebhookRetry');

// ─── Configuration ─────────────────────────────────────────

export type StorageType = 'sqlite' | 'redis' | 'postgres' | 'memory';

export interface WebhookRetryOptions {
  /**
   * Storage backend.
   * @default 'sqlite'
   */
  storage?: StorageType;
  /**
   * Connection string for the chosen adapter.
   * - sqlite:   path to .db file       (default: './webhook-retry.db')
   * - redis:    redis://…              (default: 'redis://localhost:6379')
   * - postgres: postgres://…
   * - memory:   ignored
   */
  storageUrl?: string;
  /**
   * Maximum number of events processed concurrently.
   * @default 10
   */
  concurrency?: number;
  /**
   * Per-handler execution timeout in milliseconds.
   * @default 30_000
   */
  timeout?: number;
  /**
   * How often the worker polls the queue (ms).
   * @default 1_000
   */
  pollInterval?: number;
  /**
   * Default TTL for idempotency keys (seconds).
   * @default 86_400 (24 hours)
   */
  idempotencyTtl?: number;
}

// ─── Main class ────────────────────────────────────────────

/**
 * The single entry-point for webhook-retry.
 *
 * @example
 * const webhook = new WebhookRetry({ storage: 'sqlite' });
 *
 * webhook.on('payment_intent.succeeded', async (event) => {
 *   await activateSubscription(event.payload.customerId);
 * }, {
 *   retry:      'exponential',
 *   maxRetries: 10,
 *   deadLetter: true,
 * });
 *
 * await webhook.start();
 *
 * // In your route handler:
 * await webhook.process(incomingEvent);
 */
export class WebhookRetry {
  private readonly registry:   WebhookRegistry;
  private readonly queue:      QueueManager;
  private readonly worker:     DeliveryWorker;
  private readonly dlq:        DeadLetterQueue;
  private readonly dlqReplay:  DLQReplay;
  private readonly dlqAnalyzer:DLQAnalyzer;
  private readonly idempotency:IdempotencyStore;
  private readonly storage:    StorageInterface;
  private readonly opts:       Required<WebhookRetryOptions>;

  constructor(options: WebhookRetryOptions = {}) {
    this.opts = {
      storage:        options.storage        ?? 'sqlite',
      storageUrl:     options.storageUrl     ?? './webhook-retry.db',
      concurrency:    options.concurrency    ?? 10,
      timeout:        options.timeout        ?? 30_000,
      pollInterval:   options.pollInterval   ?? 1_000,
      idempotencyTtl: options.idempotencyTtl ?? 86_400,
    };

    this.storage = this.createAdapter();

    this.registry    = new WebhookRegistry();
    this.queue       = new QueueManager(this.storage);
    this.dlq         = new DeadLetterQueue(this.storage);
    this.dlqReplay   = new DLQReplay(this.dlq, this.queue, this.registry);
    this.dlqAnalyzer = new DLQAnalyzer(this.dlq);
    this.idempotency = new IdempotencyStore(this.storage, this.opts.idempotencyTtl);

    this.worker = new DeliveryWorker({
      registry:    this.registry,
      queue:       this.queue,
      dlq:         this.dlq,
      concurrency: this.opts.concurrency,
      timeout:     this.opts.timeout,
    });
  }

  // ─── Registration ──────────────────────────────────────────

  /**
   * Register a handler for a webhook event type.
   * Returns `this` for fluent chaining.
   *
   * @example
   * webhook
   *   .on('payment.success', handlePayment, { retry: 'exponential', maxRetries: 10 })
   *   .on('order.created',   handleOrder,   { retry: 'linear',      maxRetries: 5  });
   */
  on<T = Record<string, unknown>>(
    eventType: string,
    handler: WebhookHandler<T>,
    config: Partial<RetryConfig> = {}
  ): this {
    this.registry.on(eventType, handler, config);
    return this;
  }

  /**
   * Register the same handler for multiple event types.
   */
  onMany<T = Record<string, unknown>>(
    eventTypes: string[],
    handler: WebhookHandler<T>,
    config: Partial<RetryConfig> = {}
  ): this {
    this.registry.onMany(eventTypes, handler, config);
    return this;
  }

  /**
   * Remove a handler registration.
   */
  off(eventType: string, handler: WebhookHandler): this {
    this.registry.off(eventType, handler);
    return this;
  }

  // ─── Processing ────────────────────────────────────────────

  /**
   * Enqueue an event for async processing.
   * Returns immediately after persisting the delivery records.
   * The worker will pick it up in the next poll cycle.
   *
   * Use this in HTTP route handlers so you respond to the
   * webhook sender before the handler runs.
   */
  async process(event: WebhookEvent): Promise<string[]> {
    const handlers = this.registry.getHandlers(event.type);
    if (handlers.length === 0) {
      log.warn({ eventType: event.type }, 'No handlers registered — event discarded');
      return [];
    }

    const maxAttempts = handlers[0]!.retryEngine.maxRetries;
    return this.queue.enqueue(event, handlers.map((h) => h.name), maxAttempts);
  }

  /**
   * Execute an event synchronously (bypasses the queue).
   * Useful in tests or when you need immediate feedback.
   *
   * @throws when the handler throws (no retry in sync mode)
   */
  async processSync(event: WebhookEvent): Promise<void> {
    return this.worker.processEvent(event);
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /**
   * Initialise the storage adapter and start the delivery worker.
   * Must be called before events can be processed via the queue.
   */
  async start(): Promise<void> {
    await this.storage.init();
    this.worker.start(this.opts.pollInterval);
    log.info({ storage: this.opts.storage }, 'WebhookRetry started ✅');
  }

  /**
   * Stop the delivery worker and close storage connections.
   */
  stop(): void {
    this.worker.stop();
    void this.storage.close();
    log.info('WebhookRetry stopped');
  }

  // ─── DLQ operations ────────────────────────────────────────

  /**
   * Replay a single DLQ record by its ID.
   */
  async replay(dlqId: string): Promise<string[]> {
    return this.dlqReplay.replay(dlqId);
  }

  /**
   * Replay all unreviewed DLQ records.
   */
  async replayAll(): Promise<number> {
    return this.dlqReplay.replayAll();
  }

  // ─── Accessors ─────────────────────────────────────────────

  /** Access the Dead Letter Queue for listing, reviewing, and stats. */
  get deadLetterQueue(): DeadLetterQueue { return this.dlq; }

  /** Access the DLQ Analyzer for health insights. */
  get analyzer(): DLQAnalyzer { return this.dlqAnalyzer; }

  /** Access the Idempotency store for manual duplicate detection. */
  get idempotencyStore(): IdempotencyStore { return this.idempotency; }

  /** Access the underlying registry (for introspection). */
  get webhookRegistry(): WebhookRegistry { return this.registry; }

  // ─── Private ───────────────────────────────────────────────

  private createAdapter(): StorageInterface {
    switch (this.opts.storage) {
      case 'redis':   return new RedisAdapter(this.opts.storageUrl);
      case 'memory':  return new MemoryAdapter();
      case 'sqlite':
      default:        return new SQLiteAdapter(this.opts.storageUrl);
    }
  }
}

// ─── Factory ───────────────────────────────────────────────

/**
 * Convenience factory — equivalent to `new WebhookRetry(options)`.
 *
 * @example
 * const webhook = createWebhookRetry({ storage: 'redis', storageUrl: process.env.REDIS_URL });
 */
export const createWebhookRetry = (options?: WebhookRetryOptions): WebhookRetry =>
  new WebhookRetry(options);

// ─── Re-exports ────────────────────────────────────────────

export type { WebhookEvent, WebhookHandler, RetryConfig };
export type { StorageInterface };
export type { DLQRecord, DeliveryStats, DLQStats } from './types/storage.types.js';
export type { RetryStrategyFn, RetryScheduleEntry } from './types/retry.types.js';
export type { DeliveryRecord, DeliveryStatus } from './types/webhook.types.js';

export { ExponentialBackoff } from './strategies/ExponentialBackoff.js';
export { LinearBackoff }      from './strategies/LinearBackoff.js';
export { FixedDelay }         from './strategies/FixedDelay.js';
export { CustomStrategy }     from './strategies/CustomStrategy.js';

export { SQLiteAdapter }    from './storage/adapters/SQLiteAdapter.js';
export { RedisAdapter }     from './storage/adapters/RedisAdapter.js';
export { MemoryAdapter }    from './storage/adapters/MemoryAdapter.js';
export { PostgresAdapter }  from './storage/adapters/PostgresAdapter.js';

export { DeadLetterQueue }  from './dead-letter/DeadLetterQueue.js';
export { DLQReplay }        from './dead-letter/DLQReplay.js';
export { DLQAnalyzer }      from './dead-letter/DLQAnalyzer.js';

export { CircuitBreaker }   from './circuit-breaker/CircuitBreaker.js';
export type { CircuitBreakerConfig, CircuitBreakerStats, CircuitState } from './circuit-breaker/CircuitBreaker.js';

export { IdempotencyStore }  from './idempotency/IdempotencyStore.js';
export { DuplicateDetector } from './idempotency/DuplicateDetector.js';
export { SignatureVerifier } from './core/SignatureVerifier.js';
export type { WebhookSource } from './core/SignatureVerifier.js';

export { WebhookRegistry }   from './core/WebhookRegistry.js';
export { RetryEngine }       from './core/RetryEngine.js';

// Error classes
export { WebhookRetryError } from './errors/WebhookRetryError.js';
export { MaxRetriesExceeded }from './errors/MaxRetriesExceeded.js';
export { SignatureInvalid }  from './errors/SignatureInvalid.js';
export { HandlerTimeout }    from './errors/HandlerTimeout.js';
export { CircuitOpenError }  from './errors/CircuitOpenError.js';
