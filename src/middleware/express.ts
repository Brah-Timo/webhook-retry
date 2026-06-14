// ============================================================
//  middleware/express.ts — Express.js webhook middleware
//
//  Usage:
//    import express from 'express';
//    import { WebhookRetry } from 'webhook-retry';
//    import { webhookMiddleware } from 'webhook-retry/middleware/express';
//
//    const app = express();
//    const webhook = new WebhookRetry();
//
//    app.post(
//      '/webhooks/stripe',
//      express.raw({ type: 'application/json' }),   // ← required for sig verify
//      webhookMiddleware({
//        webhook,
//        secret: process.env.STRIPE_WEBHOOK_SECRET!,
//        source: 'stripe',
//      })
//    );
//
//  The middleware:
//  1. Verifies the HMAC signature (if `secret` provided)
//  2. Extracts the event ID from common header names
//  3. Checks the idempotency store (if configured)
//  4. Enqueues the event
//  5. Responds immediately with 200 (prevents timeout at source)
// ============================================================

// Use local minimal types instead of importing from 'express' (peer dep)
type Request = {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  body: unknown;
};
type Response = {
  status: (code: number) => Response;
  json: (data: unknown) => void;
};
type NextFunction = (err?: unknown) => void;

import type { WebhookRetry } from '../index.js';
import { SignatureVerifier, type WebhookSource } from '../core/SignatureVerifier.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('express-middleware');

export interface ExpressMiddlewareOptions {
  /** The WebhookRetry instance to route events to. */
  webhook: WebhookRetry;
  /**
   * HMAC signing secret. When provided, every request must carry
   * a valid signature header.
   */
  secret?: string;
  /** Webhook provider — controls which signature format is expected. */
  source?: WebhookSource;
  /**
   * How to extract the `event.type` from the request body.
   * Defaults to `body.type ?? body.event ?? body.event_type ?? 'unknown'`.
   */
  extractType?: (body: unknown, req: Request) => string;
  /**
   * How to extract the idempotency key from the request.
   * Defaults to common header names then a UUID.
   */
  extractId?: (body: unknown, req: Request) => string;
  /**
   * Custom HTTP status code to respond with on signature failure.
   * @default 401
   */
  signatureFailureStatus?: number;
}

/**
 * Build an Express middleware for receiving webhook events.
 */
export function webhookMiddleware(options: ExpressMiddlewareOptions) {
  const verifier = options.secret
    ? new SignatureVerifier(options.secret, options.source ?? 'generic')
    : null;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // ── 1. Signature verification ───────────────────────────
      if (verifier) {
        const rawBody =
          req.rawBody ??
          Buffer.from(JSON.stringify(req.body));

        const sig =
          (req.headers['stripe-signature']       as string | undefined) ??
          (req.headers['x-hub-signature-256']    as string | undefined) ??
          (req.headers['x-webhook-signature']    as string | undefined) ??
          (req.headers['x-signature']            as string | undefined) ??
          '';

        const valid = verifier.isValid({ rawBody, signature: sig });
        if (!valid) {
          const status = options.signatureFailureStatus ?? 401;
          res.status(status).json({ error: 'Invalid webhook signature' });
          return;
        }
      }

      // ── 2. Extract event fields ─────────────────────────────
      const body = req.body as Record<string, unknown>;

      const eventId = options.extractId
        ? options.extractId(body, req)
        : extractEventId(req);

      const eventType = options.extractType
        ? options.extractType(body, req)
        : extractEventType(body);

      // ── 3. Enqueue ──────────────────────────────────────────
      await options.webhook.process({
        id:        eventId,
        type:      eventType,
        payload:   body,
        headers:   req.headers as Record<string, string>,
        createdAt: new Date(),
        ...(options.source ? { source: options.source } : {}),
      });

      log.debug({ eventId, eventType }, 'Event accepted via Express middleware');

      // ── 4. Respond immediately ──────────────────────────────
      res.status(200).json({ received: true, eventId });
    } catch (err) {
      next(err);
    }
  };
}

// ─── Helpers ───────────────────────────────────────────────

function extractEventId(req: Request): string {
  const h = req.headers;
  return (
    (h['x-webhook-id']          as string | undefined) ??
    (h['x-event-id']            as string | undefined) ??
    (h['x-request-id']          as string | undefined) ??
    crypto.randomUUID()
  );
}

function extractEventType(body: Record<string, unknown>): string {
  return (
    (body['type']        as string | undefined) ??
    (body['event']       as string | undefined) ??
    (body['event_type']  as string | undefined) ??
    (body['eventType']   as string | undefined) ??
    'unknown'
  );
}
