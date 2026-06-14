// ============================================================
//  MetricsCollector.ts — Aggregates real-time metrics
//                        and emits events for the dashboard
// ============================================================

import { EventEmitter } from 'events';
import type { StorageInterface } from '../storage/StorageInterface.js';
import type { DeliveryStats, DeliveryListOptions, PaginatedResult } from '../types/storage.types.js';
import type { DeliveryRecord } from '../types/webhook.types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MetricsCollector');

export interface OverviewMetrics {
  deliveries: DeliveryStats;
  queueDepth: number;
  dlqSize: number;
  uptime: number; // seconds
  generatedAt: Date;
}

export class MetricsCollector extends EventEmitter {
  private readonly startedAt = Date.now();
  private lastStatsSnapshot: OverviewMetrics | null = null;

  constructor(private readonly storage: StorageInterface) {
    super();
  }

  // ─── Overview ──────────────────────────────────────────────

  /**
   * Return a complete overview snapshot.
   * Used by the dashboard API `/api/stats`.
   */
  async getOverview(): Promise<OverviewMetrics> {
    const [deliveries, dlqStats] = await Promise.all([
      this.storage.getDeliveryStats(),
      this.storage.getDLQStats(),
    ]);

    const snapshot: OverviewMetrics = {
      deliveries,
      queueDepth: deliveries.retrying,
      dlqSize:    dlqStats.total,
      uptime:     Math.floor((Date.now() - this.startedAt) / 1000),
      generatedAt: new Date(),
    };

    this.lastStatsSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Return paginated delivery records.
   * Used by the dashboard events table.
   */
  async getEvents(
    opts: DeliveryListOptions
  ): Promise<PaginatedResult<DeliveryRecord>> {
    return this.storage.listDeliveries(opts);
  }

  // ─── Event bus ─────────────────────────────────────────────

  /**
   * Notify the dashboard that an event was delivered successfully.
   * Called by DeliveryWorker after a successful handler execution.
   */
  notifyDelivered(eventId: string, eventType: string, durationMs: number): void {
    const payload = { eventId, eventType, durationMs, timestamp: new Date() };
    this.emit('event:processed', payload);
    log.debug(payload, 'metrics: event delivered');
  }

  /**
   * Notify the dashboard that a delivery moved to the DLQ.
   */
  notifyDeadLetter(eventId: string, eventType: string, attempts: number, reason: string): void {
    const payload = { eventId, eventType, attempts, reason, timestamp: new Date() };
    this.emit('event:dead-letter', payload);
    log.warn(payload, 'metrics: event dead-lettered');
  }

  /**
   * Broadcast a fresh stats snapshot to the dashboard.
   * Should be called on a timer (e.g. every 5 seconds).
   */
  async broadcastStats(): Promise<void> {
    const snapshot = await this.getOverview();
    this.emit('stats:updated', snapshot);
  }

  get lastSnapshot(): OverviewMetrics | null {
    return this.lastStatsSnapshot;
  }
}
