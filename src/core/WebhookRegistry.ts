// ============================================================
//  WebhookRegistry.ts — Central registry of event handlers
// ============================================================

import type { WebhookHandler } from '../types/webhook.types.js';
import type { RetryConfig } from '../types/retry.types.js';
import { RetryEngine } from './RetryEngine.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WebhookRegistry');

/** Internal record stored for each registered handler. */
export interface RegisteredHandler {
  /** Stable name derived from `handler.name` or auto-generated. */
  name: string;
  eventType: string;
  handler: WebhookHandler;
  retryEngine: RetryEngine;
  config: Partial<RetryConfig>;
}

/**
 * WebhookRegistry is the central store for all handler registrations.
 *
 * Multiple handlers can be registered for the **same** event type;
 * they are executed concurrently by `DeliveryWorker`.
 *
 * @example
 * const registry = new WebhookRegistry();
 *
 * registry.on('payment.success', async (event) => {
 *   await activateSubscription(event.payload.customerId);
 * }, { retry: 'exponential', maxRetries: 10 });
 */
export class WebhookRegistry {
  private readonly handlers = new Map<string, RegisteredHandler[]>();

  // ─── Registration ──────────────────────────────────────────

  /**
   * Register a handler for an event type.
   *
   * @param eventType  Discriminator string, e.g. `"payment_intent.succeeded"`
   * @param handler    Async function that processes the event
   * @param config     Per-handler retry configuration (overrides global defaults)
   * @returns          The auto-generated handler name (useful for metrics)
   */
  on<T = Record<string, unknown>>(
    eventType: string,
    handler: WebhookHandler<T>,
    config: Partial<RetryConfig> = {}
  ): string {
    const existing = this.handlers.get(eventType) ?? [];

    const name =
      (handler as { name?: string }).name ||
      `${eventType}#handler_${existing.length}`;

    const registered: RegisteredHandler = {
      name,
      eventType,
      handler: handler as WebhookHandler,
      retryEngine: new RetryEngine(config),
      config,
    };

    this.handlers.set(eventType, [...existing, registered]);

    log.debug({ eventType, handlerName: name }, 'Handler registered');
    return name;
  }

  /**
   * Register a handler for **multiple** event types at once.
   *
   * @example
   * registry.onMany(
   *   ['payment.success', 'payment.updated'],
   *   handlePayment,
   *   { retry: 'exponential', maxRetries: 5 }
   * );
   */
  onMany<T = Record<string, unknown>>(
    eventTypes: string[],
    handler: WebhookHandler<T>,
    config: Partial<RetryConfig> = {}
  ): void {
    for (const eventType of eventTypes) {
      this.on(eventType, handler, config);
    }
  }

  /**
   * Remove a specific handler from an event type.
   * Useful for dynamic handler management or testing.
   */
  off(eventType: string, handler: WebhookHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    const filtered = existing.filter((h) => h.handler !== handler);
    this.handlers.set(eventType, filtered);
    log.debug({ eventType }, 'Handler deregistered');
  }

  /**
   * Remove **all** handlers for a given event type.
   */
  offAll(eventType: string): void {
    this.handlers.delete(eventType);
    log.debug({ eventType }, 'All handlers for event type cleared');
  }

  // ─── Lookup ────────────────────────────────────────────────

  /** Return all registered handlers for `eventType`. */
  getHandlers(eventType: string): RegisteredHandler[] {
    return this.handlers.get(eventType) ?? [];
  }

  /** Returns `true` when at least one handler is registered. */
  hasHandlers(eventType: string): boolean {
    const list = this.handlers.get(eventType);
    return list !== undefined && list.length > 0;
  }

  /** Return every distinct event type that has handlers. */
  getRegisteredEvents(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Return a summary of all registrations.
   * Useful for health-check / introspection endpoints.
   */
  getSummary(): Array<{ eventType: string; handlerCount: number; handlers: string[] }> {
    return Array.from(this.handlers.entries()).map(([eventType, list]) => ({
      eventType,
      handlerCount: list.length,
      handlers: list.map((h) => h.name),
    }));
  }

  /** Total number of registered handler entries across all event types. */
  get size(): number {
    let count = 0;
    for (const list of this.handlers.values()) count += list.length;
    return count;
  }
}
