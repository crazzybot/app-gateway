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

const emailEncryptionKey = deriveKey('app-gateway:email-encryption:aes-256-gcm');
const emailHmacKey = deriveKey('app-gateway:email-lookup:hmac-sha256');

/** Encrypts plaintext with AES-256-GCM; output is a single base64 blob (iv || authTag || ciphertext). */
export function encryptEmail(plaintext: string): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, emailEncryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Reverses {@link encryptEmail}. Throws if the ciphertext has been tampered with. */
export function decryptEmail(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, GCM_IV_LENGTH);
  const authTag = raw.subarray(
    GCM_IV_LENGTH,
    GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH,
  );
  const ciphertext = raw.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(AES_ALGORITHM, emailEncryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Deterministic HMAC-SHA256 lookup key for `users.email_hash`. Every login
 * and uniqueness check goes through this — the AES-GCM `email` column's
 * random nonce means the same plaintext never produces the same ciphertext
 * twice, so it can't be used for lookups.
 */
export function hashEmail(plaintext: string): string {
  const normalized = plaintext.trim().toLowerCase();
  return createHmac('sha256', emailHmacKey).update(normalized).digest('hex');
}
