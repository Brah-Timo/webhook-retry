// ============================================================
//  SignatureVerifier.ts — Unified HMAC signature validation
// ============================================================

import {
  verifyStripeSignature,
  verifyGitHubSignature,
  verifyGenericSignature,
} from '../utils/crypto.js';
import { SignatureInvalid } from '../errors/SignatureInvalid.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SignatureVerifier');

export type WebhookSource = 'stripe' | 'github' | 'generic';

export interface VerifyOptions {
  /** Raw (unparsed) request body */
  rawBody: Buffer | string;
  /** The signature header value from the request */
  signature: string;
  /**
   * Clock-skew tolerance in seconds for providers that embed timestamps
   * (currently only Stripe). @default 300
   */
  tolerance?: number;
}

/**
 * Verifies HMAC signatures for popular webhook providers.
 *
 * Supported providers:
 * - **Stripe**: `Stripe-Signature` header (`t=<ts>,v1=<sig>`)
 * - **GitHub**: `X-Hub-Signature-256` header (`sha256=<hex>`)
 * - **Generic**: Any `sha256=<hex>` or plain hex signature
 *
 * @example
 * const verifier = new SignatureVerifier(process.env.STRIPE_SECRET, 'stripe');
 *
 * // In your route handler:
 * const valid = verifier.verify({
 *   rawBody: req.rawBody,
 *   signature: req.headers['stripe-signature'],
 * });
 * if (!valid) throw new SignatureInvalid('stripe');
 */
export class SignatureVerifier {
  constructor(
    private readonly secret: string,
    private readonly source: WebhookSource = 'generic'
  ) {}

  /**
   * Verify a webhook signature.
   *
   * @returns `true` when the signature matches
   * @throws  `SignatureInvalid` when the signature is missing or invalid
   *          and `throwOnFailure` is `true` (default)
   */
  verify(options: VerifyOptions, throwOnFailure = true): boolean {
    const { rawBody, signature, tolerance } = options;

    if (!signature) {
      if (throwOnFailure) throw new SignatureInvalid(this.source, 'Missing signature header');
      return false;
    }

    let valid = false;

    try {
      switch (this.source) {
        case 'stripe':
          valid = verifyStripeSignature(rawBody, signature, this.secret, tolerance);
          break;
        case 'github':
          valid = verifyGitHubSignature(rawBody, signature, this.secret);
          break;
        default:
          valid = verifyGenericSignature(rawBody, signature, this.secret);
      }
    } catch (err) {
      log.warn({ err, source: this.source }, 'Signature verification threw');
      valid = false;
    }

    if (!valid) {
      log.warn({ source: this.source }, 'Signature verification failed');
      if (throwOnFailure) throw new SignatureInvalid(this.source);
      return false;
    }

    return true;
  }

  /**
   * Non-throwing convenience wrapper — returns `boolean` only.
   */
  isValid(options: VerifyOptions): boolean {
    return this.verify(options, false);
  }
}
