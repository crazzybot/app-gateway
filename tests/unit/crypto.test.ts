import { describe, expect, it } from 'vitest';
import {
  decryptEmail,
  encryptEmail,
  hashEmail,
  loadSigningKeys,
} from '@/utils/crypto.js';

describe('encryptEmail / decryptEmail', () => {
  it('round-trips plaintext', () => {
    const plaintext = 'user@example.com';
    const ciphertext = encryptEmail(plaintext);
    expect(decryptEmail(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext each time (random nonce)', () => {
    const plaintext = 'user@example.com';
    const first = encryptEmail(plaintext);
    const second = encryptEmail(plaintext);
    expect(first).not.toBe(second);
    expect(decryptEmail(first)).toBe(plaintext);
    expect(decryptEmail(second)).toBe(plaintext);
  });

  it('throws when the ciphertext has been tampered with', () => {
    const ciphertext = encryptEmail('user@example.com');
    const raw = Buffer.from(ciphertext, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1]! ^ 0xff) & 0xff; // flip last byte
    const tampered = raw.toString('base64');

    expect(() => decryptEmail(tampered)).toThrow();
  });
});

describe('hashEmail', () => {
  it('is deterministic for the same input', () => {
    expect(hashEmail('user@example.com')).toBe(hashEmail('user@example.com'));
  });

  it('normalizes case and surrounding whitespace before hashing', () => {
    expect(hashEmail('User@Example.com')).toBe(hashEmail('  user@example.com  '));
  });

  it('produces different hashes for different emails', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'));
  });

  it('never reveals the plaintext (fixed-length hex digest)', () => {
    const hash = hashEmail('user@example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadSigningKeys', () => {
  it('loads the active keypair with the configured kid', async () => {
    const keys = await loadSigningKeys();
    expect(keys.kid).toBe('11111111-1111-4111-8111-111111111111');
    expect(keys.privateKey).toBeDefined();
    expect(keys.publicKey).toBeDefined();
  });

  it('caches the result across calls', async () => {
    const first = await loadSigningKeys();
    const second = await loadSigningKeys();
    expect(first).toBe(second);
  });
});
