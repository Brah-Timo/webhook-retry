// ============================================================
//  crypto.ts — HMAC helpers (timing-safe)
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Compute an HMAC-SHA256 digest and return it as a hex string.
 *
 * @param secret   The signing secret
 * @param payload  Raw request body (Buffer or string)
 */
export function hmacSha256(secret: string, payload: Buffer | string): string {
  return createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

/**
 * Compare two HMAC digests using a timing-safe comparison
 * to prevent timing-oracle attacks.
 *
 * Both arguments must be the same byte length; if not, returns false.
 *
 * @param a  Expected digest (hex string or Buffer)
 * @param b  Received digest (hex string or Buffer)
 */
export function safeEqual(
  a: string | Buffer,
  b: string | Buffer
): boolean {
  try {
    const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
    const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');

    if (bufA.length !== bufB.length) {
      return false;
    }

    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verify a Stripe-style `t=...,v1=...` signature header.
 *
 * @param rawBody   Raw (unparsed) request body
 * @param header    Value of the `Stripe-Signature` header
 * @param secret    Stripe webhook signing secret
 * @param tolerance Clock skew tolerance in seconds (default 300)
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string,
  secret: string,
  tolerance = 300
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const [k, v] = part.split('=');
      return [k ?? '', v ?? ''];
    })
  ) as Record<string, string>;

  const timestamp = parts['t'];
  const signature = parts['v1'];

  if (!timestamp || !signature) return false;

  // Replay-attack protection
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) return false;

  const signedPayload = `${timestamp}.${
    Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
  }`;

  const expected = hmacSha256(secret, signedPayload);
  return safeEqual(expected, signature);
}

/**
 * Verify a GitHub `sha256=<hex>` signature header.
 *
 * @param rawBody   Raw request body
 * @param header    Value of `X-Hub-Signature-256`
 * @param secret    GitHub webhook secret
 */
export function verifyGitHubSignature(
  rawBody: Buffer | string,
  header: string,
  secret: string
): boolean {
  if (!header.startsWith('sha256=')) return false;
  const received = header.slice(7);
  const expected = hmacSha256(secret, rawBody);
  return safeEqual(expected, received);
}

/**
 * Generic HMAC verification: `sha256=<hex>` format.
 */
export function verifyGenericSignature(
  rawBody: Buffer | string,
  header: string,
  secret: string
): boolean {
  const prefix = 'sha256=';
  const sig = header.startsWith(prefix) ? header.slice(prefix.length) : header;
  const expected = hmacSha256(secret, rawBody);
  return safeEqual(expected, sig);
}
