/**
 * Example: GitHub webhook integration
 * Run: npx tsx examples/github-webhook.ts
 */
import { WebhookRetry } from '../src/index.js';

const webhook = new WebhookRetry({ storage: 'memory' });

webhook.on('push', async (event) => {
  const { ref, repository } = event.payload as { ref: string; repository: { full_name: string } };
  console.log(`📦 Push to ${repository.full_name} on ${ref}`);
  // await ciPipeline.trigger(repository.full_name, ref);
}, { retry: 'exponential', maxRetries: 5, deadLetter: true });

webhook.on('pull_request', async (event) => {
  const { action, number } = event.payload as { action: string; number: number };
  console.log(`🔀 PR #${number} ${action}`);
}, { retry: 'linear', maxRetries: 3 });

webhook.start();
setTimeout(async () => {
  await webhook.processSync({
    id: 'gh_' + Date.now(), type: 'push',
    payload: { ref: 'refs/heads/main', repository: { full_name: 'org/repo' } },
    source: 'github', createdAt: new Date(),
  });
  webhook.stop();
}, 200);
