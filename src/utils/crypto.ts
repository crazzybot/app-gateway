/**
 * Key loading (JWT signing/verification) and PII-at-rest encryption (NFR-6).
 *
 * Two unrelated concerns share this file only because both are "crypto
 * helpers loaded once at startup": (1) importing the gateway's RSA signing
 * keypair for jose, and (2) AES-256-GCM/HMAC-SHA256 for `users.email`.
 */

import { readFileSync } from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { importPKCS8, importSPKI, type KeyLike } from 'jose';
import { env } from '../config/env.js';
import { getActiveDek, getDekForVersion } from '../services/tenantKey.service.js';

// ---------------------------------------------------------------------------
// JWT signing keys
// ---------------------------------------------------------------------------

export interface SigningKeys {
  kid: string;
  privateKey: KeyLike;
  publicKey: KeyLike;
  /** Previous key kept in JWKS verify-only during a manual rotation window. */
  previousKid?: string;
  previousPublicKey?: KeyLike;
}

let cachedKeys: SigningKeys | undefined;

/**
 * Loads the active (and optional previous) RSA keypair from the paths in
 * env.ts. Cached after first call — key material doesn't change at runtime.
 */
export async function loadSigningKeys(): Promise<SigningKeys> {
  if (cachedKeys) return cachedKeys;

  const privateKey = await importPKCS8(
    readFileSync(env.JWT_PRIVATE_KEY_PATH, 'utf8'),
    env.JWT_ALGORITHM,
  );
  const publicKey = await importSPKI(
    readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8'),
    env.JWT_ALGORITHM,
  );

  let previousPublicKey: KeyLike | undefined;
  if (env.JWT_PREVIOUS_KID && env.JWT_PREVIOUS_PUBLIC_KEY_PATH) {
    previousPublicKey = await importSPKI(
      readFileSync(env.JWT_PREVIOUS_PUBLIC_KEY_PATH, 'utf8'),
      env.JWT_ALGORITHM,
    );
  }

  cachedKeys = {
    kid: env.JWT_KID,
    privateKey,
    publicKey,
    ...(env.JWT_PREVIOUS_KID !== undefined
      ? { previousKid: env.JWT_PREVIOUS_KID }
      : {}),
    ...(previousPublicKey !== undefined ? { previousPublicKey } : {}),
  };
  return cachedKeys;
}

// ---------------------------------------------------------------------------
// PII encryption at rest (NFR-6) — users.email
// ---------------------------------------------------------------------------
//
// Two independent subkeys are derived from ENCRYPTION_KEY via HKDF rather
// than reusing one raw key for both AES-GCM and HMAC.

const AES_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;

const masterKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');

function deriveKey(info: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32),
  );
}

const emailHmacKey = deriveKey('app-gateway:email-lookup:hmac-sha256');

/**
 * Encrypts an arbitrary buffer (used to encrypt per-tenant DEKs, and per-tenant
 * email plaintext) with AES-256-GCM under the given key. Output is a single
 * base64 blob (iv || authTag || ciphertext).
 */
function encryptWithKey(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Reverses {@link encryptWithKey}. Throws if the ciphertext has been tampered with. */
function decryptWithKey(key: Buffer, encoded: string): Buffer {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, GCM_IV_LENGTH);
  const authTag = raw.subarray(
    GCM_IV_LENGTH,
    GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH,
  );
  const ciphertext = raw.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// KMS-managed key-encrypting key (KEK) — wraps/unwraps per-tenant DEKs
// (NFR-6, Open Question 1). ENCRYPTION_KEY is the local-dev KEK substitute
// for AWS KMS / HashiCorp Vault in production.
// ---------------------------------------------------------------------------

const tenantKekKey = deriveKey('app-gateway:tenant-dek-wrap:aes-256-gcm');

/** Wraps a raw 256-bit DEK for storage in `tenant_encryption_keys.wrapped_dek`. */
export function wrapDek(rawDek: Buffer): string {
  return encryptWithKey(tenantKekKey, rawDek);
}

/** Unwraps a `tenant_encryption_keys.wrapped_dek` value back to the raw DEK. */
export function unwrapDek(wrapped: string): Buffer {
  return decryptWithKey(tenantKekKey, wrapped);
}

// ---------------------------------------------------------------------------
// Idempotent-refresh cache at-rest encryption (FR-4, AC-10, Open Question 2).
// The cached blob holds a live access+refresh token pair for its 30s Redis
// TTL — encrypting it means a disk snapshot or Redis compromise that outlives
// the logical TTL doesn't yield usable tokens directly.
// ---------------------------------------------------------------------------

const idempotencyCacheKey = deriveKey('app-gateway:idempotency-cache:aes-256-gcm');

/** Encrypts the idempotency cache's JSON blob before it is written to Redis. */
export function encryptIdempotencyCacheValue(plaintext: string): string {
  return encryptWithKey(idempotencyCacheKey, Buffer.from(plaintext, 'utf8'));
}

/** Reverses {@link encryptIdempotencyCacheValue}. */
export function decryptIdempotencyCacheValue(encoded: string): string {
  return decryptWithKey(idempotencyCacheKey, encoded).toString('utf8');
}

/**
 * Encrypts plaintext with AES-256-GCM under the given per-tenant DEK. The
 * DEK's key_version is embedded as a 2-byte big-endian prefix ahead of the
 * iv/authTag/ciphertext so {@link decryptWithDek} can resolve the same
 * version's DEK later, even after the tenant's active key has rotated.
 */
export function encryptWithDek(
  dek: Buffer,
  keyVersion: number,
  plaintext: string,
): string {
  const versionPrefix = Buffer.alloc(2);
  versionPrefix.writeUInt16BE(keyVersion);
  const body = Buffer.from(encryptWithKey(dek, Buffer.from(plaintext, 'utf8')), 'base64');
  return Buffer.concat([versionPrefix, body]).toString('base64');
}

export interface DekCiphertextEnvelope {
  keyVersion: number;
  body: string;
}

/** Parses the key_version prefix off an {@link encryptWithDek} envelope without decrypting. */
export function parseDekCiphertextEnvelope(encoded: string): DekCiphertextEnvelope {
  const raw = Buffer.from(encoded, 'base64');
  const keyVersion = raw.readUInt16BE(0);
  return { keyVersion, body: raw.subarray(2).toString('base64') };
}

/** Reverses {@link encryptWithDek}. Throws if the ciphertext has been tampered with. */
export function decryptWithDek(dek: Buffer, encoded: string): string {
  const { body } = parseDekCiphertextEnvelope(encoded);
  return decryptWithKey(dek, body).toString('utf8');
}

/**
 * Deterministic HMAC-SHA256 lookup key for `users.email_hash`. Every login
 * and uniqueness check goes through this — the AES-GCM `email` column's
 * random nonce means the same plaintext never produces the same ciphertext
 * twice, so it can't be used for lookups. Unlike email/DEK encryption, this
 * key stays global/unscoped (NFR-6) — it's a one-way digest, not reversible
 * ciphertext, and per-tenant scoping would break the global-uniqueness
 * login lookup.
 */
export function hashEmail(plaintext: string): string {
  const normalized = plaintext.trim().toLowerCase();
  return createHmac('sha256', emailHmacKey).update(normalized).digest('hex');
}

// ---------------------------------------------------------------------------
// Per-tenant email encryption (NFR-6, Open Question 1) — envelope encryption
// via TenantKeyService's per-tenant DEKs. `tenantId: null` resolves to the
// shared default DEK bucket (AC-12).
// ---------------------------------------------------------------------------

/** Encrypts a user's email under their tenant's active DEK (AC-11, AC-12). */
export async function encryptEmail(
  plaintext: string,
  tenantId: string | null,
): Promise<string> {
  const { dek, keyVersion } = await getActiveDek(tenantId);
  return encryptWithDek(dek, keyVersion, plaintext);
}

/**
 * Reverses {@link encryptEmail}. Resolves the DEK by the key_version
 * embedded in the ciphertext, so a row stays decryptable even after its
 * tenant's key has since rotated (AC-11, AC-12).
 */
export async function decryptEmail(
  encoded: string,
  tenantId: string | null,
): Promise<string> {
  const { keyVersion } = parseDekCiphertextEnvelope(encoded);
  const dek = await getDekForVersion(tenantId, keyVersion);
  return decryptWithDek(dek, encoded);
}
