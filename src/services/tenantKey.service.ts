/**
 * Per-tenant DEK envelope encryption for `users.email` (NFR-6, Open
 * Question 1). Each `tenant_id` gets its own AES-256 data-encryption key
 * (DEK), generated here and wrapped by the KMS-managed key-encrypting key
 * (KEK) in `src/utils/crypto.ts`. Only the wrapped DEK is ever persisted, in
 * `tenant_encryption_keys`.
 *
 * Rotation (`rotateTenantKey`) never re-encrypts existing rows: it retires
 * the current active row and inserts a new one at `key_version + 1`. Rows
 * already encrypted under the retired version stay decryptable because
 * `tenant_encryption_keys` keeps one row per (tenant_id, key_version) — see
 * the schema comment in `src/db/schema.ts` and Risk Register R-1 in
 * `plans/core-jwt-authentication.plan.md`.
 *
 * Unwrapped DEKs are cached in an in-process, bounded LRU keyed by
 * `${tenantId}:${keyVersion}` — never Redis or any external store (spec
 * Implementation Notes) — since that's what keeps decrypt latency within
 * NFR-1 without a KMS call on every request. A cache entry's value never
 * goes stale (a given key_version's DEK never changes), so no invalidation
 * is needed beyond ordinary LRU eviction.
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantEncryptionKeys } from '../db/schema.js';
import { unwrapDek, wrapDek } from '../utils/crypto.js';

/**
 * Sentinel tenant_id for the shared default DEK bucket (users with
 * `tenant_id IS NULL`, AC-12). `tenant_id` is part of the table's primary
 * key and cannot itself be NULL, so this fixed, well-known UUID stands in
 * for "no tenant" — never a real tenant's ID.
 */
export const DEFAULT_TENANT_KEY_ID = '00000000-0000-0000-0000-000000000000';

const DEK_LENGTH_BYTES = 32; // AES-256

// ---------------------------------------------------------------------------
// Bounded in-process LRU — no `lru-cache` dependency in package.json; a
// small hand-rolled Map-based cache covers the bounded-eviction requirement
// without adding one (plan Task 2.1).
// ---------------------------------------------------------------------------

class BoundedLru<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: delete + re-insert moves the entry to the end of
    // Map's iteration order, which we treat as "most recently used".
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value as K;
      this.store.delete(oldestKey);
    }
  }
}

const MAX_CACHED_DEKS = 500;
const dekCache = new BoundedLru<string, Buffer>(MAX_CACHED_DEKS);
// Which key_version is currently active per tenant — lets a warm getActiveDek
// call skip the Postgres round trip entirely, not just the KMS-unwrap step.
// Kept as a separate bounded cache (not folded into dekCache) since it maps
// tenantKeyId -> version, a different key shape than dekCache's
// "tenantKeyId:version" -> DEK.
const activeVersionCache = new BoundedLru<string, number>(MAX_CACHED_DEKS);

function cacheKey(tenantKeyId: string, keyVersion: number): string {
  return `${tenantKeyId}:${keyVersion}`;
}

function resolveTenantKeyId(tenantId: string | null): string {
  return tenantId ?? DEFAULT_TENANT_KEY_ID;
}

// ---------------------------------------------------------------------------
// DEK resolution
// ---------------------------------------------------------------------------

export interface ResolvedDek {
  dek: Buffer;
  keyVersion: number;
}

async function provisionActiveKey(tenantKeyId: string): Promise<ResolvedDek> {
  const rawDek = randomBytes(DEK_LENGTH_BYTES);
  const wrappedDek = wrapDek(rawDek);

  const inserted = await db
    .insert(tenantEncryptionKeys)
    .values({
      tenantId: tenantKeyId,
      keyVersion: 1,
      wrappedDek,
      status: 'active',
    })
    .onConflictDoNothing({
      target: [tenantEncryptionKeys.tenantId, tenantEncryptionKeys.keyVersion],
    })
    .returning();

  if (inserted[0]) {
    dekCache.set(cacheKey(tenantKeyId, 1), rawDek);
    activeVersionCache.set(tenantKeyId, 1);
    return { dek: rawDek, keyVersion: 1 };
  }

  // Lost the provisioning race — another request/instance already inserted
  // the row. Fall through to the normal lookup path.
  const existing = await findActiveRow(tenantKeyId);
  if (!existing) {
    throw new Error(
      `Failed to provision or resolve an active DEK for tenant key "${tenantKeyId}"`,
    );
  }
  activeVersionCache.set(tenantKeyId, existing.keyVersion);
  return unwrapAndCache(tenantKeyId, existing.keyVersion, existing.wrappedDek);
}

async function findActiveRow(
  tenantKeyId: string,
): Promise<{ keyVersion: number; wrappedDek: string } | undefined> {
  const rows = await db
    .select({
      keyVersion: tenantEncryptionKeys.keyVersion,
      wrappedDek: tenantEncryptionKeys.wrappedDek,
    })
    .from(tenantEncryptionKeys)
    .where(
      and(
        eq(tenantEncryptionKeys.tenantId, tenantKeyId),
        eq(tenantEncryptionKeys.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

function unwrapAndCache(
  tenantKeyId: string,
  keyVersion: number,
  wrappedDek: string,
): ResolvedDek {
  const key = cacheKey(tenantKeyId, keyVersion);
  const cached = dekCache.get(key);
  if (cached) return { dek: cached, keyVersion };

  const dek = unwrapDek(wrappedDek);
  dekCache.set(key, dek);
  return { dek, keyVersion };
}

/**
 * Resolves the tenant's (or the default bucket's) currently active DEK,
 * auto-provisioning one on first use. Used for encryption of new values.
 */
export async function getActiveDek(tenantId: string | null): Promise<ResolvedDek> {
  const tenantKeyId = resolveTenantKeyId(tenantId);

  // Fully warm path: skip the Postgres round trip entirely, not just the
  // KMS-unwrap step, when both the active-version pointer and its DEK are
  // still cached.
  const cachedVersion = activeVersionCache.get(tenantKeyId);
  if (cachedVersion !== undefined) {
    const cachedDek = dekCache.get(cacheKey(tenantKeyId, cachedVersion));
    if (cachedDek) {
      return { dek: cachedDek, keyVersion: cachedVersion };
    }
  }

  const active = await findActiveRow(tenantKeyId);
  if (!active) {
    return provisionActiveKey(tenantKeyId);
  }
  activeVersionCache.set(tenantKeyId, active.keyVersion);
  return unwrapAndCache(tenantKeyId, active.keyVersion, active.wrappedDek);
}

/**
 * Resolves a specific (tenant, key_version) DEK — active or retired. Used
 * for decryption, where the ciphertext's embedded key_version pins exactly
 * which DEK was used, regardless of whether that version is still active.
 */
export async function getDekForVersion(
  tenantId: string | null,
  keyVersion: number,
): Promise<Buffer> {
  const tenantKeyId = resolveTenantKeyId(tenantId);
  const cached = dekCache.get(cacheKey(tenantKeyId, keyVersion));
  if (cached) return cached;

  const rows = await db
    .select({ wrappedDek: tenantEncryptionKeys.wrappedDek })
    .from(tenantEncryptionKeys)
    .where(
      and(
        eq(tenantEncryptionKeys.tenantId, tenantKeyId),
        eq(tenantEncryptionKeys.keyVersion, keyVersion),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `No tenant_encryption_keys row for tenant "${tenantKeyId}" at key_version ${keyVersion}`,
    );
  }

  return unwrapAndCache(tenantKeyId, keyVersion, row.wrappedDek).dek;
}

/**
 * Rotates a tenant's (or the default bucket's) DEK: retires the current
 * active row and inserts a new one at `key_version + 1`. Does NOT
 * re-encrypt any existing `users.email` rows — those stay decryptable via
 * {@link getDekForVersion} against the now-retired version. No caller in
 * this plan invokes this yet (no rotation trigger/endpoint is in scope —
 * plan Task 2.1); it exists so the retire/rotate schema shape is exercised
 * and tested ahead of that future work.
 */
export async function rotateTenantKey(tenantId: string | null): Promise<ResolvedDek> {
  const tenantKeyId = resolveTenantKeyId(tenantId);

  return db.transaction(async (tx) => {
    const activeRows = await tx
      .select({ keyVersion: tenantEncryptionKeys.keyVersion })
      .from(tenantEncryptionKeys)
      .where(
        and(
          eq(tenantEncryptionKeys.tenantId, tenantKeyId),
          eq(tenantEncryptionKeys.status, 'active'),
        ),
      )
      .orderBy(desc(tenantEncryptionKeys.keyVersion))
      .limit(1);
    const active = activeRows[0];
    const nextVersion = (active?.keyVersion ?? 0) + 1;

    if (active) {
      await tx
        .update(tenantEncryptionKeys)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(
          and(
            eq(tenantEncryptionKeys.tenantId, tenantKeyId),
            eq(tenantEncryptionKeys.keyVersion, active.keyVersion),
          ),
        );
    }

    const rawDek = randomBytes(DEK_LENGTH_BYTES);
    const wrappedDek = wrapDek(rawDek);
    await tx.insert(tenantEncryptionKeys).values({
      tenantId: tenantKeyId,
      keyVersion: nextVersion,
      wrappedDek,
      status: 'active',
    });

    dekCache.set(cacheKey(tenantKeyId, nextVersion), rawDek);
    activeVersionCache.set(tenantKeyId, nextVersion);
    return { dek: rawDek, keyVersion: nextVersion };
  });
}
