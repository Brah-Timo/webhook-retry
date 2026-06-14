import { describe, it, expect } from 'vitest';
import { SignatureVerifier } from '../../src/core/SignatureVerifier.js';
import { SignatureInvalid } from '../../src/errors/SignatureInvalid.js';
import { hmacSha256 } from '../../src/utils/crypto.js';
import crypto from 'crypto';

describe('SignatureVerifier', () => {

  describe('generic source', () => {
    const secret = 'my-signing-secret';
    const verifier = new SignatureVerifier(secret, 'generic');

    it('accepts a valid sha256= signature', () => {
      const body = Buffer.from(JSON.stringify({ type: 'test.event' }));
      const sig = 'sha256=' + hmacSha256(secret, body);

      expect(verifier.isValid({ rawBody: body, signature: sig })).toBe(true);
    });

    it('rejects a tampered body', () => {
      const body    = Buffer.from('{"type":"real"}');
      const tampered = Buffer.from('{"type":"fake"}');
      const sig = 'sha256=' + hmacSha256(secret, body);

      expect(verifier.isValid({ rawBody: tampered, signature: sig })).toBe(false);
    });

    it('throws SignatureInvalid when throwOnFailure=true', () => {
      const body = Buffer.from('payload');
      expect(() =>
        verifier.verify({ rawBody: body, signature: 'sha256=badhex' }, true)
      ).toThrow(SignatureInvalid);
    });

    it('returns false for missing signature', () => {
      const body = Buffer.from('payload');
      expect(verifier.isValid({ rawBody: body, signature: '' })).toBe(false);
    });
  });

  describe('github source', () => {
    const secret = 'github-secret-123';
    const verifier = new SignatureVerifier(secret, 'github');

    it('accepts a valid X-Hub-Signature-256 header', () => {
      const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
      const sig = 'sha256=' + hmacSha256(secret, body);
      expect(verifier.isValid({ rawBody: body, signature: sig })).toBe(true);
    });
  });

  describe('stripe source', () => {
    const secret = 'whsec_test_secret';
    const verifier = new SignatureVerifier(secret, 'stripe');

    it('accepts a valid Stripe signature', () => {
      const body = JSON.stringify({ type: 'payment_intent.succeeded', data: {} });
      const ts = Math.floor(Date.now() / 1000).toString();
      const signed = `${ts}.${body}`;
      const sig = hmacSha256(secret, signed);
      const header = `t=${ts},v1=${sig}`;

      expect(
        verifier.isValid({ rawBody: Buffer.from(body), signature: header })
      ).toBe(true);
    });

    it('rejects replayed Stripe signature (beyond tolerance)', () => {
      const body = JSON.stringify({ type: 'payment_intent.succeeded' });
      const oldTs = (Math.floor(Date.now() / 1000) - 3600).toString(); // 1h ago
      const sig = hmacSha256(secret, `${oldTs}.${body}`);
      const header = `t=${oldTs},v1=${sig}`;

      expect(
        verifier.isValid({ rawBody: Buffer.from(body), signature: header })
      ).toBe(false);
    });
  });
});

describe('hmacSha256 utility', () => {
  it('produces consistent hex output', () => {
    const result1 = hmacSha256('secret', 'payload');
    const result2 = hmacSha256('secret', 'payload');
    expect(result1).toBe(result2);
    expect(result1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different secrets', () => {
    const a = hmacSha256('secret-a', 'payload');
    const b = hmacSha256('secret-b', 'payload');
    expect(a).not.toBe(b);
  });
});
