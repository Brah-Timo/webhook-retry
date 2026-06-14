// ============================================================
//  DashboardServer.ts — [PRO] HTTP + WebSocket dashboard
//
//  The server exposes:
//  - GET  /api/stats             — overview metrics
//  - GET  /api/events            — paginated delivery list
//  - GET  /api/dead-letter       — DLQ list
//  - POST /api/dead-letter/:id/replay  — replay one record
//  - POST /api/dead-letter/replay-all  — replay all
//  - POST /api/dead-letter/replay-type — replay by event type
//  - PATCH /api/dead-letter/:id/review — mark as reviewed
//  - GET  /api/health            — health check
//  - WS  /ws                     — real-time event stream
//  - GET  /*                     — serve React dashboard SPA
// ============================================================

import { createServer, type Server } from 'http';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import { WebSocketStream } from './WebSocketStream.js';
import type { MetricsCollector } from './MetricsCollector.js';
import type { ReplayController } from './ReplayController.js';
import type { DeadLetterQueue } from '../dead-letter/DeadLetterQueue.js';
import type { DLQAnalyzer } from '../dead-letter/DLQAnalyzer.js';
import { createPollingLoop } from '../utils/scheduler.js';

const log = createLogger('DashboardServer');

export interface DashboardServerOptions {
  metrics:  MetricsCollector;
  replay:   ReplayController;
  dlq:      DeadLetterQueue;
  analyzer: DLQAnalyzer;
  /**
   * Port to listen on. @default 3001
   */
  port?: number;
  /**
   * Secret header value required for API access.
   * If set, every request must include `X-Dashboard-Key: <apiKey>`.
   */
  apiKey?: string;
  /**
   * How often (ms) to push a fresh stats snapshot to WS clients.
   * @default 5000
   */
  broadcastInterval?: number;
  /**
   * Absolute path to the built React dashboard `dist/` folder.
   * When provided, the server serves the SPA from this path.
   */
  uiDistPath?: string;
}

export class DashboardServer {
  private readonly server: Server;
  private wsStream: WebSocketStream | null = null;
  private broadcastHandle: { stop: () => void } | null = null;

  constructor(private readonly opts: DashboardServerOptions) {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  async start(): Promise<void> {
    // Lazy-load ws to keep it optional
    const { WebSocketServer } = await import('ws') as unknown as {
      WebSocketServer: new (opts: { server: Server }) => { clients: Set<unknown> };
    };

    const wss = new WebSocketServer({ server: this.server }) as { clients: Set<{
      readyState: number;
      send: (data: string) => void;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
    }> };

    this.wsStream = new WebSocketStream(wss, this.opts.metrics as unknown as EventEmitter);
    this.wsStream.start();

    const interval = this.opts.broadcastInterval ?? 5_000;
    this.broadcastHandle = createPollingLoop(
      () => this.opts.metrics.broadcastStats(),
      interval
    );

    await new Promise<void>((resolve) => {
      this.server.listen(this.opts.port ?? 3001, () => {
        log.info({ port: this.opts.port ?? 3001 }, '📊 Dashboard running');
        resolve();
      });
    });
  }

  stop(): void {
    this.wsStream?.stop();
    this.broadcastHandle?.stop();
    this.server.close();
    log.info('DashboardServer stopped');
  }

  // ─── HTTP router (zero-dependency vanilla implementation) ──

  private async handleRequest(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;
    const method = req.method?.toUpperCase() ?? 'GET';

    // ── Auth guard ───────────────────────────────────────────
    if (this.opts.apiKey) {
      const key = req.headers['x-dashboard-key'];
      if (key !== this.opts.apiKey) {
        this.json(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    // ── CORS ─────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Dashboard-Key');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── Route dispatch ────────────────────────────────────
      if (method === 'GET' && path === '/api/health') {
        this.json(res, 200, { status: 'ok', uptime: process.uptime() });

      } else if (method === 'GET' && path === '/api/stats') {
        const stats = await this.opts.metrics.getOverview();
        this.json(res, 200, stats);

      } else if (method === 'GET' && path === '/api/stats/analysis') {
        const analysis = await this.opts.analyzer.analyze();
        this.json(res, 200, analysis);

      } else if (method === 'GET' && path === '/api/events') {
        const page  = parseInt(url.searchParams.get('page')  ?? '1', 10);
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const statusRaw  = url.searchParams.get('status');
        const eventType  = url.searchParams.get('eventType') ?? undefined;

        const result = await this.opts.metrics.getEvents({
          page, limit,
          ...(statusRaw ? { status: statusRaw as import('../types/webhook.types.js').DeliveryStatus } : {}),
          ...(eventType ? { eventType } : {}),
        });
        this.json(res, 200, result);

      } else if (method === 'GET' && path === '/api/dead-letter') {
        const page  = parseInt(url.searchParams.get('page')  ?? '1', 10);
        const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
        const reviewedRaw = url.searchParams.has('reviewed')
          ? url.searchParams.get('reviewed') === 'true'
          : undefined;

        const result = await this.opts.dlq.list({
          page, limit,
          ...(reviewedRaw !== undefined ? { reviewed: reviewedRaw } : {}),
        });
        this.json(res, 200, result);

      } else if (method === 'POST' && path === '/api/dead-letter/replay-all') {
        const count = await this.opts.replay.replayAll();
        this.json(res, 200, { success: true, replayed: count });

      } else if (method === 'POST' && path === '/api/dead-letter/replay-type') {
        const body = await this.readBody(req);
        const { eventType } = JSON.parse(body) as { eventType: string };
        const count = await this.opts.replay.replayByType(eventType);
        this.json(res, 200, { success: true, replayed: count });

      } else if (method === 'POST' && /^\/api\/dead-letter\/[^/]+\/replay$/.test(path)) {
        const dlqId = path.split('/')[3]!;
        const deliveryIds = await this.opts.replay.replay(dlqId);
        this.json(res, 200, { success: true, deliveryIds });

      } else if (method === 'PATCH' && /^\/api\/dead-letter\/[^/]+\/review$/.test(path)) {
        const dlqId = path.split('/')[3]!;
        const body = await this.readBody(req);
        const { notes } = JSON.parse(body) as { notes?: string };
        await this.opts.replay.reviewRecord(dlqId, notes);
        this.json(res, 200, { success: true });

      } else if (method === 'GET' && path === '/api/dead-letter/stats') {
        const stats = await this.opts.dlq.getStats();
        this.json(res, 200, stats);

      } else if (method === 'GET' && !path.startsWith('/api/')) {
        // Serve SPA or fallback
        this.serveSPA(res);

      } else {
        this.json(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      log.error({ err, path, method }, 'Dashboard request error');
      this.json(res, 500, { error: 'Internal server error' });
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  private json(
    res: import('http').ServerResponse,
    status: number,
    data: unknown
  ): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  private readBody(req: import('http').IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private serveSPA(res: import('http').ServerResponse): void {
    if (!this.opts.uiDistPath) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(this.getEmbeddedUI());
      return;
    }

    // When uiDistPath is set, serve index.html from that path
    import('fs').then(({ readFile }) => {
      import('path').then(({ join }) => {
        const indexPath = join(this.opts.uiDistPath!, 'index.html');
        readFile(indexPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Dashboard UI not built. Run: cd dashboard-ui && npm run build');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
          }
        });
      });
    }).catch(() => {
      res.writeHead(500);
      res.end('Failed to serve UI');
    });
  }

  /** Embedded minimal dashboard (no build step needed) */
  private getEmbeddedUI(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>webhook-retry Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔄</text></svg>">
</head>
<body class="bg-gray-950 text-gray-100 font-mono">
  <div id="app" class="p-6 max-w-6xl mx-auto">
    <!-- Header -->
    <header class="flex items-center gap-3 mb-8">
      <span class="text-3xl">🔄</span>
      <div>
        <h1 class="text-2xl font-bold text-white">webhook-retry</h1>
        <p class="text-gray-400 text-sm">Real-time delivery dashboard</p>
      </div>
      <span id="ws-status" class="ml-auto px-2 py-1 rounded text-xs bg-yellow-900 text-yellow-300">Connecting…</span>
    </header>

    <!-- Stats grid -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8" id="stats-grid">
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <p class="text-gray-400 text-xs uppercase tracking-wide">Total</p>
        <p class="text-2xl font-bold text-white" id="stat-total">–</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <p class="text-gray-400 text-xs uppercase tracking-wide">Delivered ✅</p>
        <p class="text-2xl font-bold text-green-400" id="stat-delivered">–</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <p class="text-gray-400 text-xs uppercase tracking-wide">Retrying 🔄</p>
        <p class="text-2xl font-bold text-yellow-400" id="stat-retrying">–</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-gray-800">
        <p class="text-gray-400 text-xs uppercase tracking-wide">Dead Letter 💀</p>
        <p class="text-2xl font-bold text-red-400" id="stat-dead">–</p>
      </div>
    </div>

    <!-- DLQ section -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800 mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-bold text-lg">Dead Letter Queue</h2>
        <button onclick="replayAll()"
          class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm transition">
          ♻️ Replay All
        </button>
      </div>
      <div id="dlq-table" class="text-sm text-gray-300">Loading…</div>
    </div>

    <!-- Live feed -->
    <div class="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <h2 class="font-bold text-lg mb-4">Live Event Feed</h2>
      <ul id="live-feed" class="space-y-1 text-sm max-h-64 overflow-y-auto text-gray-300"></ul>
    </div>
  </div>

<script>
  const BASE = window.location.origin;
  const MAX_FEED = 50;

  async function fetchStats() {
    const r = await fetch(BASE + '/api/stats');
    const d = await r.json();
    document.getElementById('stat-total').textContent     = d.deliveries?.total     ?? '–';
    document.getElementById('stat-delivered').textContent = d.deliveries?.delivered ?? '–';
    document.getElementById('stat-retrying').textContent  = d.deliveries?.retrying  ?? '–';
    document.getElementById('stat-dead').textContent      = d.dlqSize               ?? '–';
  }

  async function fetchDLQ() {
    const r = await fetch(BASE + '/api/dead-letter?limit=10');
    const d = await r.json();
    const el = document.getElementById('dlq-table');
    if (!d.records || d.records.length === 0) {
      el.innerHTML = '<p class="text-gray-500 italic">No records in DLQ 🎉</p>';
      return;
    }
    el.innerHTML = '<table class="w-full"><thead><tr class="text-left text-gray-500 border-b border-gray-700">' +
      '<th class="pb-2 pr-4">Event Type</th><th class="pb-2 pr-4">Attempts</th>' +
      '<th class="pb-2 pr-4">Reason</th><th class="pb-2">Action</th></tr></thead><tbody>' +
      d.records.map(r => \`<tr class="border-b border-gray-800 hover:bg-gray-800 transition">
        <td class="py-2 pr-4 text-yellow-300">\${r.eventType}</td>
        <td class="py-2 pr-4">\${r.totalAttempts}</td>
        <td class="py-2 pr-4 text-red-400 truncate max-w-xs" title="\${r.failureReason}">\${r.failureReason.slice(0,60)}</td>
        <td class="py-2"><button onclick="replay('\${r.id}')"
          class="px-2 py-1 bg-blue-800 hover:bg-blue-600 rounded text-xs transition">replay</button></td>
      </tr>\`).join('') + '</tbody></table>';
  }

  async function replay(id) {
    await fetch(BASE + '/api/dead-letter/' + id + '/replay', { method: 'POST' });
    await fetchDLQ();
    addFeedItem('♻️ Replayed DLQ record: ' + id);
  }

  async function replayAll() {
    const r = await fetch(BASE + '/api/dead-letter/replay-all', { method: 'POST' });
    const d = await r.json();
    addFeedItem('♻️ Replayed ' + d.replayed + ' records');
    await fetchDLQ();
  }

  function addFeedItem(text) {
    const ul = document.getElementById('live-feed');
    const li = document.createElement('li');
    li.className = 'border-b border-gray-800 py-1';
    li.textContent = new Date().toLocaleTimeString() + '  ' + text;
    ul.prepend(li);
    while (ul.children.length > MAX_FEED) ul.removeChild(ul.lastChild);
  }

  // WebSocket connection
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '/ws');

  ws.onopen = () => {
    document.getElementById('ws-status').textContent = '● Live';
    document.getElementById('ws-status').className = 'ml-auto px-2 py-1 rounded text-xs bg-green-900 text-green-300';
  };
  ws.onclose = () => {
    document.getElementById('ws-status').textContent = '○ Disconnected';
    document.getElementById('ws-status').className = 'ml-auto px-2 py-1 rounded text-xs bg-red-900 text-red-300';
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'EVENT_PROCESSED') {
      addFeedItem('✅ ' + msg.data.eventType + ' (' + msg.data.durationMs + 'ms)');
    } else if (msg.type === 'DEAD_LETTER') {
      addFeedItem('💀 ' + msg.data.eventType + ' → DLQ after ' + msg.data.attempts + ' attempts');
      fetchDLQ();
    } else if (msg.type === 'STATS_UPDATE') {
      fetchStats();
    }
  };

  // Initial load
  fetchStats();
  fetchDLQ();
  setInterval(fetchStats, 10000);
</script>
</body>
</html>`;
  }
}
