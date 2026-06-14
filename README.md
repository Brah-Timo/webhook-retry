# webhook-retry 🔄

> **Ultra-pro smart webhook retry engine** — exponential backoff, dead letter queues, circuit breaker, idempotency, real-time dashboard.

[![npm version](https://badge.fury.io/js/webhook-retry.svg)](https://badge.fury.io/js/webhook-retry)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

Github : https://github.com/Brah-Timo/webhook-retry

---

## The Problem

Stripe sends `payment_intent.succeeded`. Your server was mid-deploy.  
The event is **gone**. The invoice is **lost**. The customer never got access.

## The Solution

```ts
webhook.on('payment_intent.succeeded', handlePayment, {
  retry:      'exponential',  // 1s → 2s → 4s → 8s …
  maxRetries: 10,
  deadLetter: true,           // save failures for manual review
  onDeadLetter: (event) => slack.alert(`💀 DLQ: ${event.id}`),
});
```

---

## Install

```bash
npm install webhook-retry
```

---

## Quick Start

```ts
import { WebhookRetry } from 'webhook-retry';

const webhook = new WebhookRetry({
  storage:     'sqlite',        // or 'redis' | 'postgres' | 'memory'
  storageUrl:  './webhooks.db',
  concurrency: 10,
});

webhook.on('payment_intent.succeeded', async (event) => {
  await activateSubscription(event.payload.customerId);
  return { success: true };
}, {
  retry:        'exponential',
  maxRetries:   10,
  initialDelay: 1,
  maxDelay:     3600,
  jitter:       true,
  deadLetter:   true,
});

await webhook.start();

// In your HTTP route (Express / Next.js / Hono / Fastify):
app.post('/webhooks/stripe', async (req, res) => {
  await webhook.process({
    id:        req.headers['x-webhook-id'] || crypto.randomUUID(),
    type:      req.body.type,
    payload:   req.body,
    createdAt: new Date(),
  });
  res.json({ received: true });
});
```

---

## Framework Middleware (ready-made)

### Express
```ts
import { webhookMiddleware } from 'webhook-retry/middleware/express';

app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  webhookMiddleware({ webhook, secret: process.env.STRIPE_SECRET, source: 'stripe' })
);
```

### Next.js App Router
```ts
// app/api/webhooks/stripe/route.ts
import { createAppRouteHandler } from 'webhook-retry/middleware/nextjs';
export const POST = createAppRouteHandler({ webhook, secret: process.env.STRIPE_SECRET, source: 'stripe' });
```

### Fastify
```ts
import { webhookPlugin } from 'webhook-retry/middleware/fastify';
fastify.register(webhookPlugin, { webhook, path: '/webhooks/stripe', secret, source: 'stripe' });
```

### Hono (Cloudflare Workers, Bun, Deno)
```ts
import { webhookHandler } from 'webhook-retry/middleware/hono';
app.post('/webhooks/stripe', webhookHandler({ webhook, secret, source: 'stripe' }));
```

---

## Retry Strategies

| Strategy    | Formula                          | Best For                   |
|-------------|----------------------------------|----------------------------|
| exponential | `delay = random(0, init×factor^n)` | Default – most use cases  |
| linear      | `delay = init × (n + 1)`         | Predictable schedules      |
| fixed       | `delay = init` (constant)        | Rate-limited APIs          |
| custom      | `(attempt) => number`            | Fibonacci, step, anything  |

```ts
// Fibonacci delays: 1s, 1s, 2s, 3s, 5s, 8s …
const fibonacci = (n: number) => {
  if (n <= 1) return 1;
  let a = 1, b = 1;
  for (let i = 2; i <= n; i++) [a, b] = [b, a + b];
  return b;
};

webhook.on('data.sync', handler, { retry: fibonacci, maxRetries: 8 });
```

---

## Dead Letter Queue

Events that exhaust all retries are moved to the DLQ instead of silently disappearing:

```ts
// List DLQ records
const { records, total } = await webhook.deadLetterQueue.list({ reviewed: false });

// Replay a specific record
await webhook.replay(records[0].id);

// Replay everything in one shot
const count = await webhook.replayAll();

// Add an operator note
await webhook.deadLetterQueue.review(records[0].id, 'DB was down — safe to replay');
```

---

## Circuit Breaker [PRO]

Automatically stops hammering a failing downstream service:

```ts
import { CircuitBreaker } from 'webhook-retry';

const cb = new CircuitBreaker('stripe-api', {
  failureThreshold: 5,     // open after 5 consecutive failures
  resetTimeout:     60_000, // try again after 60s
});

webhook.on('payment.success', async (event) => {
  await cb.execute(() => stripeAPI.activate(event.payload.customerId));
});
```

---

## Idempotency Guard

Stripe sends the same event twice? No problem:

```ts
import { DuplicateDetector, IdempotencyStore, MemoryAdapter } from 'webhook-retry';

const store = new IdempotencyStore(adapter, 86_400); // 24h TTL
const detector = new DuplicateDetector(store);

const result = await detector.withIdempotency(event.id, async () => {
  await activateSubscription(event.payload.customerId);
});
// result === null  →  duplicate, already handled
```

---

## Dashboard [PRO]

```ts
import { DashboardServer, MetricsCollector, ReplayController } from 'webhook-retry/dashboard';

const dashboard = new DashboardServer({
  metrics, replay, dlq, analyzer,
  port:   3001,
  apiKey: process.env.DASHBOARD_KEY,
});

await dashboard.start();
// Open http://localhost:3001
```

Endpoints:
- `GET  /api/stats`                         — overview metrics
- `GET  /api/events`                        — delivery list (paginated)
- `GET  /api/dead-letter`                   — DLQ records
- `POST /api/dead-letter/:id/replay`        — replay one record
- `POST /api/dead-letter/replay-all`        — replay all
- `PATCH /api/dead-letter/:id/review`       — add operator note
- `WS  /ws`                                 — real-time event stream

---

## Storage Adapters

| Adapter         | Best For                             | Dependency      |
|-----------------|--------------------------------------|-----------------|
| `SQLiteAdapter` | Local / small scale (default)        | `better-sqlite3`|
| `RedisAdapter`  | Distributed / high throughput        | `ioredis`       |
| `PostgresAdapter`| Enterprise / analytics              | `pg`            |
| `MemoryAdapter` | Testing (no persistence)             | none            |

```ts
// Redis
const webhook = new WebhookRetry({ storage: 'redis', storageUrl: process.env.REDIS_URL });

// PostgreSQL
const webhook = new WebhookRetry({ storage: 'postgres', storageUrl: process.env.DATABASE_URL });
```

---

## Signature Verification

```ts
import { SignatureVerifier } from 'webhook-retry';

const verifier = new SignatureVerifier(process.env.STRIPE_SECRET!, 'stripe');
// or: 'github' | 'generic'

const valid = verifier.isValid({ rawBody, signature: req.headers['stripe-signature'] });
```

---

## Pricing

| Feature                     | Free (MIT) | Pro ($22/mo) |
|-----------------------------|:----------:|:------------:|
| Exponential / Linear / Fixed| ✅         | ✅           |
| Custom retry strategy       | ✅         | ✅           |
| Dead Letter Queue           | ✅         | ✅           |
| SQLite + Redis storage      | ✅         | ✅           |
| Express/Next.js/Hono/Fastify| ✅         | ✅           |
| Signature verification      | ✅         | ✅           |
| TypeScript types            | ✅         | ✅           |
| Dashboard UI                | ❌         | ✅           |
| Real-time WebSocket feed    | ❌         | ✅           |
| Circuit Breaker             | ❌         | ✅           |
| DLQ Analyzer                | ❌         | ✅           |
| Priority support            | ❌         | ✅           |

---

## API Reference

### `new WebhookRetry(options)`
| Option         | Type       | Default              | Description                        |
|----------------|------------|----------------------|------------------------------------|
| storage        | string     | `'sqlite'`           | Backend adapter                    |
| storageUrl     | string     | `'./webhook-retry.db'`| Connection string / file path     |
| concurrency    | number     | `10`                 | Max concurrent deliveries          |
| timeout        | number     | `30_000`             | Handler timeout (ms)               |
| pollInterval   | number     | `1_000`              | Queue poll interval (ms)           |
| idempotencyTtl | number     | `86_400`             | Idempotency key TTL (seconds)      |

### `webhook.on(eventType, handler, config)`
| Config field        | Type                | Default    | Description                      |
|---------------------|---------------------|------------|----------------------------------|
| retry               | string \| function  | exponential| Retry strategy                   |
| maxRetries          | number              | 5          | Max attempts                     |
| initialDelay        | number              | 1          | First retry delay (seconds)      |
| maxDelay            | number              | 3600       | Max delay cap (seconds)          |
| factor              | number              | 2          | Backoff multiplier               |
| jitter              | boolean             | true       | Apply Full Jitter                |
| deadLetter          | boolean             | true       | Move failures to DLQ             |
| retryableStatuses   | number[]            | [408,429,500,502,503,504] | HTTP codes to retry |
| onRetry             | function            | —          | Called on each failed attempt    |
| onDeadLetter        | function            | —          | Called when event moves to DLQ   |

---

## Project Structure

```
webhook-retry/
├── src/
│   ├── core/          RetryEngine, WebhookRegistry, QueueManager, DeliveryWorker
│   ├── strategies/    ExponentialBackoff, LinearBackoff, FixedDelay, CustomStrategy
│   ├── storage/       StorageInterface + SQLite, Redis, Postgres, Memory adapters
│   ├── dead-letter/   DeadLetterQueue, DLQReplay, DLQAnalyzer
│   ├── dashboard/     DashboardServer, MetricsCollector, WebSocketStream
│   ├── middleware/    Express, Fastify, Next.js, Hono
│   ├── idempotency/   IdempotencyStore, DuplicateDetector
│   ├── circuit-breaker/ CircuitBreaker
│   ├── types/         All TypeScript types
│   ├── errors/        Typed error classes
│   ├── utils/         logger, crypto, scheduler
│   └── index.ts       Public API
├── dashboard-ui/      React + Tailwind dashboard SPA
├── tests/             unit / integration / e2e (vitest)
├── examples/          stripe, github, custom-strategy, redis
└── README.md
```

---

## License

MIT © TIMSoftDZ webhook-retry contributors
