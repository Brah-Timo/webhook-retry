// ============================================================
//  WebSocketStream.ts — Real-time push to dashboard clients
// ============================================================

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WebSocketStream');

type WsLike = {
  readyState: number;
  send: (data: string) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WssLike = {
  clients: Set<WsLike>;
};

export type StreamEvent =
  | { type: 'EVENT_PROCESSED'; data: { eventId: string; eventType: string; durationMs: number; timestamp: Date } }
  | { type: 'DEAD_LETTER'; data: { eventId: string; eventType: string; attempts: number; reason: string; timestamp: Date } }
  | { type: 'STATS_UPDATE'; data: unknown }
  | { type: 'REPLAY_QUEUED'; data: { dlqId: string; newEventId: string } }
  | { type: 'PING' };

const WS_OPEN = 1;

/**
 * Bridges the MetricsCollector EventEmitter to connected
 * WebSocket clients so the dashboard updates in real time.
 *
 * @example
 * const stream = new WebSocketStream(wss, metrics);
 * stream.start();
 */
export class WebSocketStream {
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly wss: WssLike,
    private readonly emitter: EventEmitter
  ) {}

  /**
   * Wire up the EventEmitter listeners and start the ping loop.
   */
  start(): void {
    this.emitter.on('event:processed', (data) => {
      this.broadcast({ type: 'EVENT_PROCESSED', data: data as { eventId: string; eventType: string; durationMs: number; timestamp: Date } });
    });

    this.emitter.on('event:dead-letter', (data) => {
      this.broadcast({ type: 'DEAD_LETTER', data: data as { eventId: string; eventType: string; attempts: number; reason: string; timestamp: Date } });
    });

    this.emitter.on('stats:updated', (data) => {
      this.broadcast({ type: 'STATS_UPDATE', data });
    });

    // Keep connections alive
    this.pingInterval = setInterval(() => {
      this.broadcast({ type: 'PING' });
    }, 30_000);

    log.info('WebSocketStream started');
  }

  stop(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.emitter.removeAllListeners('event:processed');
    this.emitter.removeAllListeners('event:dead-letter');
    this.emitter.removeAllListeners('stats:updated');
    log.info('WebSocketStream stopped');
  }

  /**
   * Send an event to all connected dashboard clients.
   */
  broadcast(event: StreamEvent): void {
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const client of this.wss.clients) {
      if (client.readyState === WS_OPEN) {
        try {
          client.send(payload);
          sent++;
        } catch (err) {
          log.warn({ err }, 'Failed to send to WebSocket client');
        }
      }
    }
    if (sent > 0) {
      log.debug({ type: event.type, clients: sent }, 'Broadcast sent');
    }
  }

  /** Count connected clients. */
  get connectedClients(): number {
    let count = 0;
    for (const c of this.wss.clients) {
      if (c.readyState === WS_OPEN) count++;
    }
    return count;
  }
}
