/**
 * Example: Full Stripe webhook integration
 *
 * Run: npx tsx examples/stripe-payment.ts
 */

import { WebhookRetry } from '../src/index.js';

const webhook = new WebhookRetry({
  storage:     'sqlite',
  storageUrl:  './data/webhooks.db',
  concurrency: 20,
  timeout:     30_000,
});

// ── payment_intent.succeeded ───────────────────────────────
webhook.on('payment_intent.succeeded', async (event) => {
  const { customer, amount, currency } = event.payload as {
    customer: string; amount: number; currency: string;
  };

  console.log(`✅ Payment succeeded: ${customer} paid ${amount} ${currency}`);

  // await db.subscriptions.activate(customer);
  // await emailService.sendReceipt({ customer, amount, currency });
  // await analytics.track('payment_success', { amount });

  return { success: true };
}, {
  retry:        'exponential',
  maxRetries:   10,
  initialDelay: 1,
  maxDelay:     3600,
  jitter:       true,
  deadLetter:   true,
  onRetry: (attempt, error, nextDelay) => {
    console.warn(`🔄 Retry #${attempt} in ${nextDelay.toFixed(1)}s — ${error}`);
  },
  onDeadLetter: async (event, attempts) => {
    console.error(`💀 ALERT: payment event ${event.id} failed after ${attempts} attempts`);
    // await slack.alert({ text: `Payment DLQ: ${event.id}` });
  },
});

// ── payment_intent.payment_failed ─────────────────────────
webhook.on('payment_intent.payment_failed', async (event) => {
  const { customer } = event.payload as { customer: string };
  console.log(`❌ Payment failed for ${customer}`);
  // await emailService.sendPaymentFailed(customer);
}, {
  retry:        'fixed',
  maxRetries:   3,
  initialDelay: 30,
  deadLetter:   true,
});

// ── customer.subscription.deleted ─────────────────────────
webhook.on('customer.subscription.deleted', async (event) => {
  const { customer } = event.payload as { customer: string };
  console.log(`🚫 Subscription cancelled for ${customer}`);
  // await db.subscriptions.deactivate(customer);
}, {
  retry:      'linear',
  maxRetries: 5,
  deadLetter: true,
});

webhook.start();
console.log('🚀 Webhook processor running. Waiting for events…');

// ── Simulate an incoming event ─────────────────────────────
setTimeout(async () => {
  console.log('\n📨 Simulating incoming Stripe event…');
  await webhook.processSync({
    id:        'evt_test_' + Date.now(),
    type:      'payment_intent.succeeded',
    payload:   { customer: 'cus_demo123', amount: 2999, currency: 'usd' },
    source:    'stripe',
    createdAt: new Date(),
  });
  webhook.stop();
  console.log('\n✅ Done. Check ./data/webhooks.db for delivery records.');
}, 500);
