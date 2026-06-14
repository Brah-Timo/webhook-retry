// ============================================================
//  middleware/fastify.ts — Fastify plugin for webhook ingestion
//
//  Usage:
//    import Fastify from 'fastify';
//    import { WebhookRetry } from 'webhook-retry';
//    import { webhookPlugin } from 'webhook-retry/middleware/fastify';
//
//    const fastify = Fastify();
//    const webhook = new WebhookRetry();
//
//    fastify.register(webhookPlugin, {
//      webhook,
//      path: '/webhooks/stripe',
//      secret: process.env.STRIPE_WEBHOOK_SECRET,
//      source: 'stripe',
//    });
// ============================================================

// Use local minimal types instead of importing from 'fastify' (peer dep)
type FastifyRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
type FastifyReply = {
  status: (code: number) => FastifyReply;
  send: (data: unknown) => FastifyReply;
};
type FastifyInstance = {
  addContentTypeParser: (
    contentType: string,
    opts: { parseAs: string },
    fn: (req: unknown, body: unknown, done: (err: null, body: unknown) => void) => void
  ) => void;
  post: (path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => void;
};
type FastifyPluginAsync<T = Record<string, unknown>> = (
  fastify: FastifyInstance,
  opts: T
) => Promise<void>;

import type { WebhookRetry } from '../index.js';
import { SignatureVerifier, type WebhookSource } from '../core/SignatureVerifier.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('fastify-plugin');

export interface FastifyWebhookOptions {
  /** The WebhookRetry instance. */
  webhook: WebhookRetry;
  /** Route path to register. @default '/webhooks' */
  path?: string;
  /** HMAC signing secret for signature verification. */
  secret?: string;
  /** Webhook provider. @default 'generic' */
  source?: WebhookSource;
  /**
   * Override event type extraction.
   * @default body.type ?? body.event ?? 'unknown'
   */
  extractType?: (body: unknown) => string;
}

/**
 * Fastify plugin that registers a POST route for webhook ingestion.
 */
export const webhookPlugin: FastifyPluginAsync<FastifyWebhookOptions> = async (
  fastify,
  opts
) => {
  const path = opts.path ?? '/webhooks';
  const verifier = opts.secret
    ? new SignatureVerifier(opts.secret, opts.source ?? 'generic')
    : null;

  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  fastify.post(path, async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = req.body as Buffer;

    // ── Signature verification ──────────────────────────────
    if (verifier) {
      const sig =
        (req.headers['stripe-signature']    as string | undefined) ??
        (req.headers['x-hub-signature-256'] as string | undefined) ??
        (req.headers['x-webhook-signature'] as string | undefined) ??
        '';

      const valid = verifier.isValid({ rawBody, signature: sig });
      if (!valid) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }
    }

    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;

    const eventType = opts.extractType
      ? opts.extractType(body)
      : String(body['type'] ?? body['event'] ?? 'unknown');

    const eventId =
      (req.headers['x-webhook-id'] as string | undefined) ??
      (req.headers['x-event-id']   as string | undefined) ??
      crypto.randomUUID();

    await opts.webhook.process({
      id:        eventId,
      type:      eventType,
      payload:   body,
      headers:   req.headers as Record<string, string>,
      createdAt: new Date(),
      ...(opts.source ? { source: opts.source } : {}),
    });

    log.debug({ eventId, eventType }, 'Event accepted via Fastify plugin');

    return reply.status(200).send({ received: true, eventId });
  });
};

export default webhookPlugin;
