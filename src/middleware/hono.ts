// ============================================================
//  middleware/hono.ts — Hono middleware for webhook ingestion
//
//  Usage:
//    import { Hono } from 'hono';
//    import { WebhookRetry } from 'webhook-retry';
//    import { webhookHandler } from 'webhook-retry/middleware/hono';
//
//    const app = new Hono();
//    const webhook = new WebhookRetry();
//
//    app.post(
//      '/webhooks/stripe',
//      webhookHandler({
//        webhook,
//        secret: process.env.STRIPE_WEBHOOK_SECRET,
//        source: 'stripe',
//      })
//    );
//
//  Works in Cloudflare Workers, Bun, Deno, and Node.js.
// ============================================================

// Use local minimal types instead of importing from 'hono' (peer dep)
type HonoRequest = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  header: (name: string) => string | undefined;
  raw: { headers: { forEach: (fn: (value: string, key: string) => void) => void } };
};
type HonoContext = {
  req: HonoRequest;
  json: (data: unknown, status?: number) => Response;
  set: (key: string, value: unknown) => void;
};
type MiddlewareHandler = (c: HonoContext, next: () => Promise<void>) => Promise<Response | void>;

import type { WebhookRetry } from '../index.js';
import { SignatureVerifier, type WebhookSource } from '../core/SignatureVerifier.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('hono-handler');

export interface HonoWebhookOptions {
  webhook: WebhookRetry;
  secret?: string;
  source?: WebhookSource;
  extractType?: (body: unknown) => string;
}

/**
 * Hono route handler for webhook ingestion.
 *
 * Use directly as a route handler (not as middleware):
 * ```ts
 * app.post('/webhooks/stripe', webhookHandler({ webhook, secret }));
 * ```
 */
export function webhookHandler(options: HonoWebhookOptions): MiddlewareHandler {
  const verifier = options.secret
    ? new SignatureVerifier(options.secret, options.source ?? 'generic')
    : null;

  return async (c: HonoContext) => {
    const rawArrayBuffer = await c.req.arrayBuffer();
    const rawBody = Buffer.from(rawArrayBuffer);
    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // ── Signature verification ──────────────────────────────
    if (verifier) {
      const sig =
        c.req.header('stripe-signature')    ??
        c.req.header('x-hub-signature-256') ??
        c.req.header('x-webhook-signature') ??
        '';

      const valid = verifier.isValid({ rawBody, signature: sig });
      if (!valid) {
        return c.json({ error: 'Invalid webhook signature' }, 401);
      }
    }

    const eventType = options.extractType
      ? options.extractType(body)
      : String(body['type'] ?? body['event'] ?? 'unknown');

    const eventId =
      c.req.header('x-webhook-id') ??
      c.req.header('x-event-id')   ??
      crypto.randomUUID();

    // Build headers map from Hono request
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value: string, key: string) => { headers[key] = value; });

    await options.webhook.process({
      id:        eventId,
      type:      eventType,
      payload:   body,
      headers,
      createdAt: new Date(),
      ...(options.source ? { source: options.source } : {}),
    });

    log.debug({ eventId, eventType }, 'Event accepted via Hono handler');

    return c.json({ received: true, eventId }, 200);
  };
}

/**
 * Hono middleware that validates webhook signatures and attaches
 * the parsed event to `c.set('webhookEvent', event)`.
 *
 * Use when you need more control over the response or want to
 * run additional logic before enqueuing.
 *
 * @example
 * app.post(
 *   '/webhooks/stripe',
 *   signatureGuard({ secret, source: 'stripe' }),
 *   async (c) => {
 *     const event = c.get('webhookEvent');
 *     await webhook.process(event);
 *     return c.json({ ok: true });
 *   }
 * );
 */
export function signatureGuard(opts: {
  secret: string;
  source?: WebhookSource;
}): MiddlewareHandler {
  const verifier = new SignatureVerifier(opts.secret, opts.source ?? 'generic');

  return async (c: HonoContext, next: () => Promise<void>) => {
    const rawArrayBuffer = await c.req.arrayBuffer();
    const rawBody = Buffer.from(rawArrayBuffer);

    const sig =
      c.req.header('stripe-signature')    ??
      c.req.header('x-hub-signature-256') ??
      c.req.header('x-webhook-signature') ??
      '';

    const valid = verifier.isValid({ rawBody, signature: sig });
    if (!valid) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const eventId = c.req.header('x-webhook-id') ?? crypto.randomUUID();

    c.set('rawBody', rawBody);
    c.set('webhookBody', body);
    c.set('webhookEventId', eventId);

    await next();
  };
}
