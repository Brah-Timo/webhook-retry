// ============================================================
//  storage.types.ts — Storage layer contracts & record shapes
// ============================================================

import type { DeliveryStatus } from './webhook.types.js';

// ─────────────────────────────────────────────
//  DLQ record
// ─────────────────────────────────────────────

/**
 * A record that lives permanently in the Dead Letter Queue
 * after a delivery exhausts all retry attempts.
 */
export interface DLQRecord {
  id: string;
  /** ID of the original `WebhookEvent`. */
  originalEventId: string;
  /** Original event type, e.g. `"payment_intent.succeeded"`. */
  eventType: string;
  /** JSON-serialised payload for manual replay. */
  payload: string;
  /** Last error message that caused permanent failure. */
  failureReason: string;
  /** Total number of delivery attempts that were made. */
  totalAttempts: number;
  firstAttemptAt: Date;
  lastAttemptAt: Date;
  movedToDLQAt: Date;
  /** Has an operator reviewed this record? */
  reviewed: boolean;
  /** Has this record been successfully replayed? */
  replayed: boolean;
  replayedAt?: Date;
  /** Free-text notes added by an operator via the dashboard. */
  notes?: string;
}

// ─────────────────────────────────────────────
//  Query helpers
// ─────────────────────────────────────────────

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface DeliveryListOptions extends PaginationOptions {
  status?: DeliveryStatus;
  eventType?: string;
  /** ISO date string – only records created after this timestamp. */
  since?: string;
}

export interface DLQListOptions extends PaginationOptions {
  reviewed?: boolean;
  eventType?: string;
}

export interface PaginatedResult<T> {
  records: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─────────────────────────────────────────────
//  Metrics / stats shapes
// ─────────────────────────────────────────────

export interface DeliveryStats {
  /** Total events ever processed. */
  total: number;
  delivered: number;
  retrying: number;
  failed: number;
  dead: number;
  /** Success rate as a percentage (0–100). */
  successRate: number;
  /** Average number of attempts per successful delivery. */
  avgAttempts: number;
  /** Average handler duration in milliseconds. */
  avgDurationMs: number;
}

export interface DLQStats {
  total: number;
  unreviewed: number;
  /** Count grouped by event type. */
  byEventType: Record<string, number>;
  /** Top failure reasons with occurrence counts. */
  topFailureReasons: Array<{ reason: string; count: number }>;
}

// ─────────────────────────────────────────────
//  Idempotency key
// ─────────────────────────────────────────────

export interface ProcessedEventRecord {
  eventId: string;
  processedAt: Date;
  /** Unix timestamp after which this record may be deleted. */
  expiresAt: number;
}
