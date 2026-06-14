// ============================================================
//  DeliveryWorker.ts — Concurrent execution engine
//
//  Each tick the worker:
//  1. Claims `concurrency` pending items from QueueManager
//  2. Reconstructs the WebhookEvent from the stored payload
//  3. Calls the registered handler with a timeout guard
//  4. On success  → marks delivered
//  5. On failure  → asks RetryEngine: retry or dead-letter?
// ============================================================

import type { WebhookEvent, AttemptResult } from '../types/webhook.types.js';
import type { QueueItem } from '../types/webhook.types.js';
import { WebhookRegistry } from './WebhookRegistry.js';
import { QueueManager } from './QueueManager.js';
import type { DeadLetterQueue } from '../dead-letter/DeadLetterQueue.js';
import { createLogger } from '../utils/logger.js';
import { createPollingLoop, withTimeout } from '../utils/scheduler.js';
import { HandlerTimeout } from '../errors/HandlerTimeout.js';

const log = createLogger('DeliveryWorker');

export interface DeliveryWorkerOptions {
  registry: WebhookRegistry;
  queue: QueueManager;
  dlq: DeadLetterQueue;
  /** Maximum concurrent deliveries. @default 10 */
  concurrency?: number;
  /** Per-handler execution timeout in milliseconds. @default 30_000 */
  timeout?: number;
}

export class DeliveryWorker {
  private readonly registry: WebhookRegistry;
  private readonly queue: QueueManager;
  private readonly dlq: DeadLetterQueue;
  private readonly concurrency: number;
  private readonly timeout: number;

  private stopHandle: { stop: () => void } | null = null;
  private activeJobs = 0;

  constructor(opts: DeliveryWorkerOptions) {
    this.registry = opts.registry;
    this.queue = opts.queue;
    this.dlq = opts.dlq;
    this.concurrency = opts.concurrency ?? 10;
    this.timeout = opts.timeout ?? 30_000;
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /**
   * Start the polling loop. Each tick picks up work if capacity allows.
   */
  start(pollIntervalMs = 1_000): void {
    if (this.stopHandle) {
      log.warn('Worker already running');
      return;
    }

    log.info(
      { concurrency: this.concurrency, pollIntervalMs },
      'DeliveryWorker started 🚀'
    );

    this.stopHandle = createPollingLoop(
      () => this.tick(),
      pollIntervalMs
    );
  }

  /** Stop the polling loop gracefully. */
  stop(): void {
    if (!this.stopHandle) return;
    this.stopHandle.stop();
    this.stopHandle = null;
    log.info('DeliveryWorker stopped');
  }

  // ─── Tick ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const available = this.concurrency - this.activeJobs;
    if (available <= 0) return;

    const items = await this.queue.dequeue(available);
    if (items.length === 0) return;

    log.debug({ claimed: items.length }, 'Tick: items claimed');

    // Fire all jobs in parallel, no awaiting — the loop moves on
    for (const item of items) {
      this.activeJobs++;
      this.executeItem(item).finally(() => {
        this.activeJobs--;
      });
    }
  }

  // ─── Execution ─────────────────────────────────────────────

  /**
   * Execute a single queued item end-to-end.
   * This method never throws; all errors are handled internally.
   */
  private async executeItem(item: QueueItem): Promise<void> {
    const handlers = this.registry.getHandlers(item.eventType);
    const handler = handlers.find((h) => h.name === item.handlerName);

    if (!handler) {
      log.warn(
        { eventType: item.eventType, handlerName: item.handlerName },
        'No matching handler found — discarding item'
      );
      await this.queue.markDead(item.deliveryId, 1, 'Handler not found');
      return;
    }

    const event: WebhookEvent = {
      id: item.eventId,
      type: item.eventType,
      payload: JSON.parse(item.payload) as Record<string, unknown>,
      createdAt: item.scheduledAt,
    };

    const delivery = await this.queue.getDelivery(item.deliveryId);
    if (!delivery) {
      log.warn({ deliveryId: item.deliveryId }, 'Delivery record not found');
      return;
    }

    const start = Date.now();
    let result: AttemptResult;

    try {
      const handlerResult = await withTimeout(
        Promise.resolve(handler.handler(event)),
        this.timeout
      );

      const duration = Date.now() - start;

      // Treat void / undefined as success
      const success =
        handlerResult === undefined ||
        handlerResult === null ||
        (typeof handlerResult === 'object' && handlerResult.success !== false);

      result = {
        success,
        duration,
        timestamp: new Date(),
        ...(success
          ? {}
          : { error: (handlerResult as { message?: string })?.message ?? 'Handler returned failure' }),
      };
    } catch (err) {
      const duration = Date.now() - start;
      const error =
        err instanceof HandlerTimeout
          ? err.message
          : err instanceof Error
          ? err.message
          : String(err);

      result = { success: false, error, duration, timestamp: new Date() };
    }

    const newAttempts = delivery.attempts + 1;

    if (result.success) {
      await this.queue.markDelivered(item.deliveryId, result.duration);

      log.info(
        {
          deliveryId: item.deliveryId,
          eventType: item.eventType,
          attempts: newAttempts,
          durationMs: result.duration,
        },
        'Delivery succeeded ✅'
      );
      return;
    }

    // ── Failure path ─────────────────────────────────────────
    const engine = handler.retryEngine;
    const shouldRetry = engine.shouldRetry(newAttempts, result);

    if (shouldRetry) {
      const nextTime = engine.getNextAttemptTime(newAttempts);
      const delaySec = (nextTime.getTime() - Date.now()) / 1000;

      engine.notifyRetry(newAttempts, result.error ?? 'unknown error', delaySec);

      await this.queue.scheduleRetry(
        item.deliveryId,
        newAttempts,
        nextTime,
        result.error ?? 'Unknown error',
        result.statusCode,
        result.duration
      );

      log.warn(
        {
          deliveryId: item.deliveryId,
          attempt: newAttempts,
          nextAttempt: nextTime,
          error: result.error,
        },
        'Delivery failed — retry scheduled 🔄'
      );
    } else {
      // Permanent failure
      await this.queue.markDead(
        item.deliveryId,
        newAttempts,
        result.error ?? 'Unknown error'
      );

      if (engine.usesDeadLetter) {
        await this.dlq.push(delivery, event, result.error ?? 'Unknown error');
        await engine.notifyDeadLetter(event, newAttempts);
      }

      log.error(
        {
          deliveryId: item.deliveryId,
          eventType: item.eventType,
          attempts: newAttempts,
          error: result.error,
        },
        'Delivery permanently failed 💀'
      );
    }
  }

  // ─── Direct execution (for testing / sync mode) ────────────

  /**
   * Process a single event synchronously without the queue.
   * Useful in tests and for debugging specific events.
   */
  async processEvent(event: WebhookEvent): Promise<void> {
    const handlers = this.registry.getHandlers(event.type);

    if (handlers.length === 0) {
      log.warn({ eventType: event.type }, 'No handlers registered for event type');
      return;
    }

    for (const handler of handlers) {
      const start = Date.now();
      try {
        await withTimeout(
          Promise.resolve(handler.handler(event)),
          this.timeout
        );
        log.info(
          { handlerName: handler.name, durationMs: Date.now() - start },
          'Sync delivery succeeded ✅'
        );
      } catch (err) {
        log.error(
          { handlerName: handler.name, err },
          'Sync delivery failed ❌'
        );
        throw err;
      }
    }
  }

  /** Current number of in-flight deliveries. */
  get activeCount(): number {
    return this.activeJobs;
  }

  /** Whether the worker is currently running. */
  get isRunning(): boolean {
    return this.stopHandle !== null;
  }
}
