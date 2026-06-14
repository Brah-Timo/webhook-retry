// ============================================================
//  DLQAnalyzer.ts — Pattern detection & health insights
// ============================================================

import type { DLQRecord } from '../types/storage.types.js';
import type { DeadLetterQueue } from './DeadLetterQueue.js';

export interface DLQAnalysis {
  /** Summary counts */
  summary: {
    total: number;
    unreviewed: number;
    replayed: number;
    /** Percentage of DLQ records that came from a single event type */
    dominantEventTypeShare: number;
  };
  /** Breakdown by event type */
  byEventType: Array<{
    eventType: string;
    count: number;
    percentage: number;
  }>;
  /** Breakdown by failure reason (top 10) */
  byFailureReason: Array<{
    reason: string;
    count: number;
    percentage: number;
  }>;
  /** Most recent failures — useful for rapid triage */
  recentFailures: Array<{
    id: string;
    eventType: string;
    failureReason: string;
    movedToDLQAt: Date;
  }>;
  /** Events that failed most times before dying */
  hardestToDeliver: Array<{
    id: string;
    eventType: string;
    totalAttempts: number;
    failureReason: string;
  }>;
  /** Hourly failure trend (last 24 hours) */
  hourlyTrend: Array<{
    hour: string; // ISO "YYYY-MM-DDTHH:00"
    count: number;
  }>;
}

export class DLQAnalyzer {
  constructor(private readonly dlq: DeadLetterQueue) {}

  /**
   * Perform a full analysis of the current DLQ contents.
   * Fetches up to 5,000 records for in-memory analysis.
   */
  async analyze(): Promise<DLQAnalysis> {
    const { records } = await this.dlq.list({ limit: 5000 });
    const total = records.length;

    if (total === 0) {
      return this.emptyAnalysis();
    }

    // ── By event type ─────────────────────────────────────────
    const eventTypeMap = new Map<string, number>();
    for (const r of records) {
      eventTypeMap.set(r.eventType, (eventTypeMap.get(r.eventType) ?? 0) + 1);
    }

    const byEventType = Array.from(eventTypeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([eventType, count]) => ({
        eventType,
        count,
        percentage: Math.round((count / total) * 100),
      }));

    const dominantShare = byEventType[0]?.percentage ?? 0;

    // ── By failure reason ─────────────────────────────────────
    const reasonMap = new Map<string, number>();
    for (const r of records) {
      reasonMap.set(r.failureReason, (reasonMap.get(r.failureReason) ?? 0) + 1);
    }

    const byFailureReason = Array.from(reasonMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: Math.round((count / total) * 100),
      }));

    // ── Recent failures ───────────────────────────────────────
    const recentFailures = [...records]
      .sort((a, b) => b.movedToDLQAt.getTime() - a.movedToDLQAt.getTime())
      .slice(0, 10)
      .map((r) => ({
        id:            r.id,
        eventType:     r.eventType,
        failureReason: r.failureReason,
        movedToDLQAt:  r.movedToDLQAt,
      }));

    // ── Hardest to deliver ────────────────────────────────────
    const hardestToDeliver = [...records]
      .sort((a, b) => b.totalAttempts - a.totalAttempts)
      .slice(0, 5)
      .map((r) => ({
        id:            r.id,
        eventType:     r.eventType,
        totalAttempts: r.totalAttempts,
        failureReason: r.failureReason,
      }));

    // ── Hourly trend (last 24h) ───────────────────────────────
    const hourlyTrend = this.buildHourlyTrend(records);

    return {
      summary: {
        total,
        unreviewed: records.filter((r) => !r.reviewed).length,
        replayed:   records.filter((r) => r.replayed).length,
        dominantEventTypeShare: dominantShare,
      },
      byEventType,
      byFailureReason,
      recentFailures,
      hardestToDeliver,
      hourlyTrend,
    };
  }

  // ─── Private helpers ───────────────────────────────────────

  private buildHourlyTrend(records: DLQRecord[]): DLQAnalysis['hourlyTrend'] {
    const map = new Map<string, number>();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const r of records) {
      if (r.movedToDLQAt.getTime() < cutoff) continue;
      const hour = r.movedToDLQAt.toISOString().slice(0, 13) + ':00';
      map.set(hour, (map.get(hour) ?? 0) + 1);
    }

    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, count]) => ({ hour, count }));
  }

  private emptyAnalysis(): DLQAnalysis {
    return {
      summary: { total: 0, unreviewed: 0, replayed: 0, dominantEventTypeShare: 0 },
      byEventType: [],
      byFailureReason: [],
      recentFailures: [],
      hardestToDeliver: [],
      hourlyTrend: [],
    };
  }
}
