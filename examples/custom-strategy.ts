/**
 * Example: Custom Fibonacci retry strategy
 * Run: npx tsx examples/custom-strategy.ts
 */
import { WebhookRetry } from '../src/index.js';

// Fibonacci: 1s, 1s, 2s, 3s, 5s, 8s, 13s...
const fibonacci = (attempt: number): number => {
  if (attempt <= 1) return 1;
  let a = 1, b = 1;
  for (let i = 2; i <= attempt; i++) [a, b] = [b, a + b];
  return b;
};

const webhook = new WebhookRetry({ storage: 'memory' });

webhook.on('data.sync', async (event) => {
  console.log('Syncing:', event.payload);
}, {
  retry:      fibonacci,
  maxRetries: 8,
  jitter:     true,
  deadLetter: true,
  onRetry:    (attempt, error, delay) =>
    console.warn(`🔄 Fibonacci retry #${attempt} in ${delay.toFixed(1)}s — ${error}`),
});

webhook.start();
setTimeout(async () => {
  await webhook.processSync({
    id: 'sync_' + Date.now(), type: 'data.sync',
    payload: { table: 'users', rows: 500 }, createdAt: new Date(),
  });
  webhook.stop();
}, 200);
