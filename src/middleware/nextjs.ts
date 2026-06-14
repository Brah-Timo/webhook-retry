// ============================================================
//  middleware/nextjs.ts — Next.js App Router + Pages Router
//
//  App Router usage:
//    // app/api/webhooks/stripe/route.ts
//    import { createAppRouteHandler } from 'webhook-retry/middleware/nextjs';
//    import { webhook } from '@/lib/webhook';
//
//    export const POST = createAppRouteHandler({
//      webhook,
//      secret: process.env.STRIPE_WEBHOOK_SECRET!,
//      source: 'stripe',
//    });
//
//  Pages Router usage:
//    // pages/api/webhooks/stripe.ts
//    import { createPagesApiHandler } from 'webhook-retry/middleware/nextjs';
//    import { webhook } from '@/lib/webhook';
//
//    export default createPagesApiHandler({ webhook });
//    export const config = { api: { bodyParser: false } }; // required!
// ============================================================

import { SignatureVerifier, type WebhookSource } from '../core/SignatureVerifier.js';
import type { WebhookRetry } from '../index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('nextjs-handler');

export interface NextJSHandlerOptions {
  webhook: WebhookRetry;
  secret?: string;
  source?: WebhookSource;
  extractType?: (body: unknown) => string;
}

// ─────────────────────────────────────────────
//  App Router (Next.js 13+ / 14+)
// ─────────────────────────────────────────────

/**
 * Creates a Next.js App Router route handler (for `route.ts` files).
 *
 * @example
 * // app/api/webhooks/stripe/route.ts
 * export const POST = createAppRouteHandler({ webhook, secret });
 */
export function createAppRouteHandler(options: NextJSHandlerOptions) {
  const verifier = options.secret
    ? new SignatureVerifier(options.secret, options.source ?? 'generic')
    : null;

  return async function POST(req: Request): Promise<Response> {
    const rawBodyBuffer = await req.arrayBuffer();
    const rawBody = Buffer.from(rawBodyBuffer);
    let body: Record<string, unknown>;

    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Signature ────────────────────────────────────────────
    if (verifier) {
      const sig =
        req.headers.get('stripe-signature')    ??
        req.headers.get('x-hub-signature-256') ??
        req.headers.get('x-webhook-signature') ??
        '';

      const valid = verifier.isValid({ rawBody, signature: sig });
      if (!valid) {
        return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const eventType = options.extractType
      ? options.extractType(body)
      : String(body['type'] ?? body['event'] ?? 'unknown');

    const eventId =
      req.headers.get('x-webhook-id') ??
      req.headers.get('x-event-id')   ??
      crypto.randomUUID();

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });

    await options.webhook.process({
      id:        eventId,
      type:      eventType,
      payload:   body,
      headers,
      createdAt: new Date(),
      ...(options.source ? { source: options.source } : {}),
    });

    log.debug({ eventId, eventType }, 'Event accepted via Next.js App Router');

    return new Response(JSON.stringify({ received: true, eventId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ─────────────────────────────────────────────
//  Pages Router (Next.js 12 and below, or legacy)
// ─────────────────────────────────────────────

type NextApiRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

type NextApiResponse = {
  status: (code: number) => NextApiResponse;
  json: (data: unknown) => void;
  end: () => void;
};

/**
 * Creates a Next.js Pages Router API handler.
 *
 * Remember to disable body parsing:
 * ```ts
 * export const config = { api: { bodyParser: false } };
 * ```
 *
 * @example
 * // pages/api/webhooks/stripe.ts
 * export default createPagesApiHandler({ webhook, secret });
 * export const config = { api: { bodyParser: false } };
 */
export function createPagesApiHandler(options: NextJSHandlerOptions) {
  const verifier = options.secret
    ? new SignatureVerifier(options.secret, options.source ?? 'generic')
    : null;

  return async function handler(
    req: NextApiRequest,
    res: NextApiResponse
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const body = req.body as Record<string, unknown>;

    if (verifier) {
      // body-parser is disabled, so `body` should be a Buffer
      const rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(JSON.stringify(body));

      const sig =
        String(req.headers['stripe-signature']    ?? '') ||
        String(req.headers['x-hub-signature-256'] ?? '') ||
        String(req.headers['x-webhook-signature'] ?? '');

      const valid = verifier.isValid({ rawBody, signature: sig });
      if (!valid) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    }

    const parsedBody = Buffer.isBuffer(body)
      ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>)
      : body;

    const eventType = options.extractType
      ? options.extractType(parsedBody)
      : String(parsedBody['type'] ?? parsedBody['event'] ?? 'unknown');

    const eventId =
      String(req.headers['x-webhook-id'] ?? '') ||
      String(req.headers['x-event-id']   ?? '') ||
      crypto.randomUUID();

    await options.webhook.process({
      id:        eventId,
      type:      eventType,
      payload:   parsedBody,
      headers:   req.headers as Record<string, string>,
      createdAt: new Date(),
      ...(options.source ? { source: options.source } : {}),
    });

    log.debug({ eventId, eventType }, 'Event accepted via Next.js Pages Router');

    res.status(200).json({ received: true, eventId });
  };
}
