import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asMockedDb, createChainableResult } from './helpers/mockDb.js';

vi.mock('@/db/client.js', () => ({
  db: {
    select: vi.fn(() => createChainableResult([])),
    insert: vi.fn(() => createChainableResult([])),
    update: vi.fn(() => createChainableResult([])),
  },
}));

const db = asMockedDb((await import('@/db/client.js')).db);
const { decryptEmail, encryptEmail, hashEmail, loadSigningKeys } = await import(
  '@/utils/crypto.js'
);
const { wrapDek } = await import('@/utils/crypto.js');

const TENANT_ID = '33333333-3333-4333-8333-000000000003';

/**
 * Points db.select at a single, pre-wrapped active DEK row for the given
 * tenant key id so encryptEmail/decryptEmail exercise the "existing row"
 * path consistently — avoids re-provisioning a fresh random DEK on every
 * call, which would otherwise mask the DEK an earlier ciphertext in the
 * same test was actually encrypted under.
 */
function stubActiveDek(tenantKeyId: string) {
  const wrapped = wrapDek(randomBytes(32));
  vi.mocked(db.select).mockReturnValue(
    createChainableResult([
      { tenantId: tenantKeyId, keyVersion: 1, wrappedDek: wrapped, status: 'active' },
    ]),
  );
}

beforeEach(() => {
  vi.mocked(db.select).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.insert).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.update).mockReset().mockReturnValue(createChainableResult([]));
});

describe('encryptEmail / decryptEmail', () => {
  it('round-trips plaintext under the tenant default bucket (tenant_id null, AC-12)', async () => {
    const { DEFAULT_TENANT_KEY_ID } = await import('@/services/tenantKey.service.js');
    stubActiveDek(DEFAULT_TENANT_KEY_ID);

    const plaintext = 'user@example.com';
    const ciphertext = await encryptEmail(plaintext, null);
    expect(await decryptEmail(ciphertext, null)).toBe(plaintext);
  });

  it('round-trips plaintext under a specific tenant DEK (AC-11)', async () => {
    stubActiveDek(TENANT_ID);

    const plaintext = 'user@example.com';
    const ciphertext = await encryptEmail(plaintext, TENANT_ID);
    expect(await decryptEmail(ciphertext, TENANT_ID)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext each time (random nonce)', async () => {
    stubActiveDek(TENANT_ID);

    const plaintext = 'user@example.com';
    const first = await encryptEmail(plaintext, TENANT_ID);
    const second = await encryptEmail(plaintext, TENANT_ID);
    expect(first).not.toBe(second);
    expect(await decryptEmail(first, TENANT_ID)).toBe(plaintext);
    expect(await decryptEmail(second, TENANT_ID)).toBe(plaintext);
  });

  it("cannot decrypt tenant A's ciphertext using tenant B's DEK (AC-11)", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    vi.mocked(db.select).mockReturnValueOnce(createChainableResult([])); // tenant A: no active row
    vi.mocked(db.insert).mockReturnValueOnce(
      createChainableResult([{ tenantId: tenantA, keyVersion: 1 }]),
    );
    const ciphertext = await encryptEmail('user@example.com', tenantA);

    vi.mocked(db.select).mockReturnValueOnce(createChainableResult([])); // tenant B: no active row
    vi.mocked(db.insert).mockReturnValueOnce(
      createChainableResult([{ tenantId: tenantB, keyVersion: 1 }]),
    );
    await encryptEmail('unused@example.com', tenantB); // provisions tenant B's own DEK

    await expect(decryptEmail(ciphertext, tenantB)).rejects.toThrow();
  });

  it('throws when the ciphertext has been tampered with', async () => {
    stubActiveDek(TENANT_ID);

    const ciphertext = await encryptEmail('user@example.com', TENANT_ID);
    const raw = Buffer.from(ciphertext, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1]! ^ 0xff) & 0xff; // flip last byte
    const tampered = raw.toString('base64');

    await expect(decryptEmail(tampered, TENANT_ID)).rejects.toThrow();
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
