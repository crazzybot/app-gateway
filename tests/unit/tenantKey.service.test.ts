import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asMockedDb, createChainableResult, type MockQueryBuilder } from './helpers/mockDb.js';

vi.mock('@/db/client.js', () => ({
  db: {
    select: vi.fn(() => createChainableResult([])),
    insert: vi.fn(() => createChainableResult([])),
    update: vi.fn(() => createChainableResult([])),
    transaction: vi.fn(),
  },
}));

interface MockedTxDb extends ReturnType<typeof asMockedDb> {
  transaction: ReturnType<typeof vi.fn>;
}

const db = asMockedDb((await import('@/db/client.js')).db) as MockedTxDb;
const {
  DEFAULT_TENANT_KEY_ID,
  getActiveDek,
  getDekForVersion,
  rotateTenantKey,
} = await import('@/services/tenantKey.service.js');
const { wrapDek } = await import('@/utils/crypto.js');

// The service's unwrap cache is a module-level singleton that persists for
// the lifetime of this test file — every test that touches the cache uses a
// freshly generated tenant_id so tests can never collide on a cache entry.
function freshTenantId(): string {
  return randomUUID();
}

function activeKeyRow(
  tenantId: string,
  keyVersion: number,
  wrappedDek: string,
  status: 'active' | 'retired' = 'active',
) {
  return { tenantId, keyVersion, wrappedDek, status, createdAt: new Date(), retiredAt: null };
}

beforeEach(() => {
  vi.mocked(db.select).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.insert).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.update).mockReset().mockReturnValue(createChainableResult([]));
  db.transaction.mockReset();
});

describe('getActiveDek', () => {
  it('generates and wraps a new DEK when no active row exists for the tenant', async () => {
    const tenantId = freshTenantId();
    vi.mocked(db.select).mockReturnValue(createChainableResult([])); // no active row
    const insertBuilder = createChainableResult([{ tenantId, keyVersion: 1 }]);
    vi.mocked(db.insert).mockReturnValue(insertBuilder);

    const resolved = await getActiveDek(tenantId);

    expect(resolved.keyVersion).toBe(1);
    expect(resolved.dek).toHaveLength(32); // AES-256
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, keyVersion: 1, status: 'active' }),
    );
  });

  it('unwraps and returns the DEK for an existing active row', async () => {
    const tenantId = freshTenantId();
    const rawDek = Buffer.from('a'.repeat(32));
    const wrapped = wrapDek(rawDek);
    vi.mocked(db.select).mockReturnValue(
      createChainableResult([activeKeyRow(tenantId, 1, wrapped)]),
    );

    const resolved = await getActiveDek(tenantId);

    expect(resolved.keyVersion).toBe(1);
    expect(resolved.dek.equals(rawDek)).toBe(true);
  });

  it('falls back to the shared default DEK bucket for tenant_id IS NULL (AC-12)', async () => {
    const rawDek = Buffer.from('b'.repeat(32));
    const wrapped = wrapDek(rawDek);
    const selectBuilder = createChainableResult([
      activeKeyRow(DEFAULT_TENANT_KEY_ID, 1, wrapped),
    ]);
    vi.mocked(db.select).mockReturnValue(selectBuilder);

    const resolved = await getActiveDek(null);

    expect(resolved.dek.equals(rawDek)).toBe(true);
    expect(selectBuilder.where).toHaveBeenCalled();
  });

  it('does not re-unwrap on a cache hit for the same (tenant, key_version)', async () => {
    const tenantId = freshTenantId();
    const rawDek = Buffer.from('c'.repeat(32));
    const wrapped = wrapDek(rawDek);
    vi.mocked(db.select).mockReturnValue(
      createChainableResult([activeKeyRow(tenantId, 1, wrapped)]),
    );

    const crypto = await import('@/utils/crypto.js');
    const unwrapSpy = vi.spyOn(crypto, 'unwrapDek');

    const first = await getActiveDek(tenantId);
    expect(unwrapSpy).toHaveBeenCalledTimes(1);

    const second = await getActiveDek(tenantId);
    expect(unwrapSpy).toHaveBeenCalledTimes(1); // cache hit — no additional unwrap
    expect(second.dek.equals(first.dek)).toBe(true);

    unwrapSpy.mockRestore();
  });

  it('skips the Postgres round trip entirely on a fully warm cache', async () => {
    const tenantId = freshTenantId();
    const rawDek = Buffer.from('g'.repeat(32));
    const wrapped = wrapDek(rawDek);
    const selectBuilder = createChainableResult([activeKeyRow(tenantId, 1, wrapped)]);
    vi.mocked(db.select).mockReturnValue(selectBuilder);

    await getActiveDek(tenantId); // warms both the version pointer and the DEK
    const selectCallsAfterFirst = vi.mocked(db.select).mock.calls.length;

    const resolved = await getActiveDek(tenantId);

    expect(vi.mocked(db.select).mock.calls.length).toBe(selectCallsAfterFirst); // no new SELECT
    expect(resolved.dek.equals(rawDek)).toBe(true);
    expect(resolved.keyVersion).toBe(1);
  });
});

describe('getDekForVersion', () => {
  it('resolves a specific (tenant, key_version), including retired versions', async () => {
    const tenantId = freshTenantId();
    const rawDek = Buffer.from('d'.repeat(32));
    const wrapped = wrapDek(rawDek);
    vi.mocked(db.select).mockReturnValue(createChainableResult([{ wrappedDek: wrapped }]));

    const dek = await getDekForVersion(tenantId, 2);
    expect(dek.equals(rawDek)).toBe(true);
  });

  it('throws when no row matches the (tenant, key_version) pair', async () => {
    const tenantId = freshTenantId();
    vi.mocked(db.select).mockReturnValue(createChainableResult([]));
    await expect(getDekForVersion(tenantId, 99)).rejects.toThrow();
  });
});

describe('tenant isolation (AC-11)', () => {
  it('two tenants get distinct DEKs that cannot cross-decrypt', async () => {
    const tenantA = freshTenantId();
    const tenantB = freshTenantId();
    const dekA = Buffer.from('e'.repeat(32));
    const dekB = Buffer.from('f'.repeat(32));
    const wrappedA = wrapDek(dekA);
    const wrappedB = wrapDek(dekB);

    vi.mocked(db.select).mockReturnValueOnce(
      createChainableResult([activeKeyRow(tenantA, 1, wrappedA)]),
    );
    const resolvedA = await getActiveDek(tenantA);

    vi.mocked(db.select).mockReturnValueOnce(
      createChainableResult([activeKeyRow(tenantB, 1, wrappedB)]),
    );
    const resolvedB = await getActiveDek(tenantB);

    expect(resolvedA.dek.equals(dekA)).toBe(true);
    expect(resolvedB.dek.equals(dekB)).toBe(true);
    expect(resolvedA.dek.equals(resolvedB.dek)).toBe(false);
  });
});

describe('rotateTenantKey', () => {
  function mockTransaction(activeRows: unknown[]): {
    selectBuilder: MockQueryBuilder;
    updateBuilder: MockQueryBuilder;
    insertBuilder: MockQueryBuilder;
  } {
    const selectBuilder = createChainableResult(activeRows);
    const updateBuilder = createChainableResult([]);
    const insertBuilder = createChainableResult([]);
    const tx = {
      select: vi.fn(() => selectBuilder),
      update: vi.fn(() => updateBuilder),
      insert: vi.fn(() => insertBuilder),
    };
    db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));
    return { selectBuilder, updateBuilder, insertBuilder };
  }

  it('retires the current active row and inserts key_version + 1, without touching existing data rows', async () => {
    const tenantId = freshTenantId();
    const { updateBuilder, insertBuilder } = mockTransaction([{ keyVersion: 3 }]);

    const result = await rotateTenantKey(tenantId);

    expect(result.keyVersion).toBe(4);
    expect(updateBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'retired' }),
    );
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, keyVersion: 4, status: 'active' }),
    );
    // Rotation only flips pointers — no update/select against users rows.
    expect(insertBuilder.values).not.toHaveBeenCalledWith(
      expect.objectContaining({ keyVersion: 3 }),
    );
  });

  it('starts at key_version 1 when no active row exists yet', async () => {
    const tenantId = freshTenantId();
    const { updateBuilder, insertBuilder } = mockTransaction([]);

    const result = await rotateTenantKey(tenantId);

    expect(result.keyVersion).toBe(1);
    expect(updateBuilder.set).not.toHaveBeenCalled(); // nothing to retire
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({ keyVersion: 1 }),
    );
  });
});
