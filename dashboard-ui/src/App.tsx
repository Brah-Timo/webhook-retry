import { useState, useEffect, useCallback } from 'react';

// ─── Types ──────────────────────────────────────────────────

interface Stats {
  deliveries: {
    total: number;
    delivered: number;
    retrying: number;
    failed: number;
    dead: number;
    successRate: number;
    avgAttempts: number;
    avgDurationMs: number;
  };
  dlqSize: number;
  queueDepth: number;
  uptime: number;
  generatedAt: string;
}

interface DLQRecord {
  id: string;
  eventType: string;
  failureReason: string;
  totalAttempts: number;
  movedToDLQAt: string;
  reviewed: boolean;
  replayed: boolean;
}

interface DeliveryRecord {
  id: string;
  eventType: string;
  handlerName: string;
  status: string;
  attempts: number;
  duration: number | null;
  createdAt: string;
  lastError: string | null;
}

// ─── Status badge ───────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  delivered:  'bg-green-900  text-green-300',
  pending:    'bg-blue-900   text-blue-300',
  processing: 'bg-yellow-900 text-yellow-300',
  retrying:   'bg-orange-900 text-orange-300',
  failed:     'bg-red-900    text-red-300',
  dead:       'bg-red-950    text-red-400',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? 'bg-gray-800 text-gray-300';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ─── Stats card ─────────────────────────────────────────────

function StatCard({
  label,
  value,
  color = 'text-white',
  suffix = '',
}: {
  label: string;
  value: number | string;
  color?: string;
  suffix?: string;
}) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
      <p className="text-gray-400 text-xs uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>
        {value}
        {suffix && <span className="text-lg ml-1 text-gray-500">{suffix}</span>}
      </p>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────

export default function App() {
  const [stats, setStats]             = useState<Stats | null>(null);
  const [dlqRecords, setDlqRecords]   = useState<DLQRecord[]>([]);
  const [events, setEvents]           = useState<DeliveryRecord[]>([]);
  const [wsStatus, setWsStatus]       = useState<'connecting' | 'live' | 'disconnected'>('connecting');
  const [liveFeed, setLiveFeed]       = useState<string[]>([]);
  const [activeTab, setActiveTab]     = useState<'overview' | 'events' | 'dlq'>('overview');
  const [loading, setLoading]         = useState(false);

  const BASE = window.location.origin;

  // ── Data fetchers ─────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    const r = await fetch(`${BASE}/api/stats`);
    const d = await r.json() as Stats;
    setStats(d);
  }, [BASE]);

  const fetchDLQ = useCallback(async () => {
    const r = await fetch(`${BASE}/api/dead-letter?limit=50`);
    const d = await r.json() as { records: DLQRecord[] };
    setDlqRecords(d.records ?? []);
  }, [BASE]);

  const fetchEvents = useCallback(async () => {
    const r = await fetch(`${BASE}/api/events?limit=50`);
    const d = await r.json() as { records: DeliveryRecord[] };
    setEvents(d.records ?? []);
  }, [BASE]);

  const addFeed = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLiveFeed((prev) => [`${ts}  ${msg}`, ...prev].slice(0, 50));
  };

  // ── Actions ───────────────────────────────────────────────

  const replaySingle = async (id: string) => {
    setLoading(true);
    try {
      await fetch(`${BASE}/api/dead-letter/${id}/replay`, { method: 'POST' });
      addFeed(`♻️ Replayed: ${id.slice(0, 8)}…`);
      await fetchDLQ();
    } finally {
      setLoading(false);
    }
  };

  const replayAll = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/dead-letter/replay-all`, { method: 'POST' });
      const d = await r.json() as { replayed: number };
      addFeed(`♻️ Replayed ${d.replayed} records`);
      await fetchDLQ();
    } finally {
      setLoading(false);
    }
  };

  // ── WebSocket ─────────────────────────────────────────────

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen  = () => setWsStatus('live');
    ws.onclose = () => setWsStatus('disconnected');

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; data?: unknown };
      if (msg.type === 'EVENT_PROCESSED') {
        const d = msg.data as { eventType: string; durationMs: number };
        addFeed(`✅ ${d.eventType} (${d.durationMs}ms)`);
      } else if (msg.type === 'DEAD_LETTER') {
        const d = msg.data as { eventType: string; attempts: number };
        addFeed(`💀 ${d.eventType} → DLQ after ${d.attempts} attempts`);
        void fetchDLQ();
      } else if (msg.type === 'STATS_UPDATE') {
        setStats(msg.data as Stats);
      }
    };

    return () => ws.close();
  }, [fetchDLQ]);

  // ── Initial load ──────────────────────────────────────────

  useEffect(() => {
    void fetchStats();
    void fetchDLQ();
    void fetchEvents();
    const id = setInterval(() => { void fetchStats(); }, 10_000);
    return () => clearInterval(id);
  }, [fetchStats, fetchDLQ, fetchEvents]);

  // ─── Render ───────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <header className="flex items-center gap-4 mb-8">
          <span className="text-4xl">🔄</span>
          <div>
            <h1 className="text-2xl font-bold text-white">webhook-retry</h1>
            <p className="text-gray-400 text-sm">Delivery Dashboard</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span
              className={`px-3 py-1 rounded-full text-xs font-medium
                ${wsStatus === 'live'
                  ? 'bg-green-900 text-green-300'
                  : wsStatus === 'connecting'
                  ? 'bg-yellow-900 text-yellow-300'
                  : 'bg-red-900 text-red-300'
                }`}
            >
              {wsStatus === 'live' ? '● Live' : wsStatus === 'connecting' ? '○ Connecting…' : '● Disconnected'}
            </span>
            {stats && (
              <span className="text-xs text-gray-500">
                Uptime: {Math.floor(stats.uptime / 60)}m {stats.uptime % 60}s
              </span>
            )}
          </div>
        </header>

        {/* Stats grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4 mb-8">
          <StatCard label="Total"       value={stats?.deliveries.total     ?? '–'} />
          <StatCard label="Delivered"   value={stats?.deliveries.delivered ?? '–'} color="text-green-400" />
          <StatCard label="Retrying"    value={stats?.deliveries.retrying  ?? '–'} color="text-yellow-400" />
          <StatCard label="Failed"      value={stats?.deliveries.failed    ?? '–'} color="text-orange-400" />
          <StatCard label="Dead Letter" value={stats?.dlqSize              ?? '–'} color="text-red-400" />
          <StatCard label="Success Rate" value={stats?.deliveries.successRate ?? '–'} suffix="%" color="text-blue-400" />
        </div>

        {/* Tabs */}
        <nav className="flex gap-1 border-b border-gray-800 mb-6">
          {(['overview', 'events', 'dlq'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm capitalize transition
                ${activeTab === tab
                  ? 'border-b-2 border-blue-500 text-blue-400'
                  : 'text-gray-500 hover:text-gray-300'
                }`}
            >
              {tab === 'dlq' ? 'Dead Letter Queue' : tab}
            </button>
          ))}
        </nav>

        {/* Tab: Overview (live feed) */}
        {activeTab === 'overview' && (
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h2 className="font-bold mb-4">Live Event Feed</h2>
            {liveFeed.length === 0
              ? <p className="text-gray-500 italic text-sm">Waiting for events…</p>
              : (
                <ul className="space-y-0.5 max-h-96 overflow-y-auto text-sm font-mono text-gray-300">
                  {liveFeed.map((msg, i) => (
                    <li key={i} className="border-b border-gray-800/50 py-1">{msg}</li>
                  ))}
                </ul>
              )
            }
          </div>
        )}

        {/* Tab: Events */}
        {activeTab === 'events' && (
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 overflow-x-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold">Recent Deliveries</h2>
              <button
                onClick={() => void fetchEvents()}
                className="text-xs text-gray-400 hover:text-white"
              >
                ↻ Refresh
              </button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Event Type</th>
                  <th className="pb-2 pr-4">Handler</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Attempts</th>
                  <th className="pb-2 pr-4">Duration</th>
                  <th className="pb-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition">
                    <td className="py-2 pr-4 text-yellow-300">{e.eventType}</td>
                    <td className="py-2 pr-4 text-gray-400 text-xs">{e.handlerName}</td>
                    <td className="py-2 pr-4"><StatusBadge status={e.status} /></td>
                    <td className="py-2 pr-4">{e.attempts}</td>
                    <td className="py-2 pr-4 text-gray-400">{e.duration ? `${e.duration}ms` : '–'}</td>
                    <td className="py-2 text-gray-500 text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-gray-500 italic">
                      No deliveries yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab: DLQ */}
        {activeTab === 'dlq' && (
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 overflow-x-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold">
                Dead Letter Queue
                {dlqRecords.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 bg-red-900 text-red-300 rounded text-xs">
                    {dlqRecords.filter((r) => !r.reviewed).length} unreviewed
                  </span>
                )}
              </h2>
              <button
                onClick={replayAll}
                disabled={loading || dlqRecords.length === 0}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm transition"
              >
                ♻️ Replay All
              </button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Event Type</th>
                  <th className="pb-2 pr-4">Attempts</th>
                  <th className="pb-2 pr-4">Failure Reason</th>
                  <th className="pb-2 pr-4">Moved to DLQ</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {dlqRecords.map((r) => (
                  <tr key={r.id} className={`border-b border-gray-800/50 transition
                    ${r.replayed ? 'opacity-50' : 'hover:bg-gray-800/40'}`}>
                    <td className="py-2 pr-4 text-yellow-300">{r.eventType}</td>
                    <td className="py-2 pr-4">{r.totalAttempts}</td>
                    <td className="py-2 pr-4 text-red-400 max-w-xs truncate" title={r.failureReason}>
                      {r.failureReason.slice(0, 80)}
                    </td>
                    <td className="py-2 pr-4 text-gray-500 text-xs">
                      {new Date(r.movedToDLQAt).toLocaleString()}
                    </td>
                    <td className="py-2">
                      {r.replayed
                        ? <span className="text-xs text-green-600">replayed ✓</span>
                        : (
                          <button
                            onClick={() => void replaySingle(r.id)}
                            disabled={loading}
                            className="px-3 py-1 bg-blue-800 hover:bg-blue-600 disabled:opacity-50 rounded text-xs transition"
                          >
                            ♻️ Replay
                          </button>
                        )
                      }
                    </td>
                  </tr>
                ))}
                {dlqRecords.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-gray-500 italic">
                      🎉 Dead Letter Queue is empty!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
}
