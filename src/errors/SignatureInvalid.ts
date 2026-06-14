// ============================================================
//  SignatureInvalid.ts
// ============================================================

import { WebhookRetryError } from './WebhookRetryError.js';

/**
 * Thrown by `SignatureVerifier` when the HMAC signature
 * on an incoming webhook does not match the expected value.
 *
 * HTTP middleware catches this and responds with 401.
 */
export class SignatureInvalid extends WebhookRetryError {
  constructor(source: string, details?: string) {
    super(
      `Invalid webhook signature from source "${source}"${details ? `: ${details}` : ''}`,
      'SIGNATURE_INVALID',
      { source, details }
    );
    this.name = 'SignatureInvalid';
  }
}
