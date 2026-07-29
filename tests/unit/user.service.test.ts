import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asMockedDb, createChainableResult } from './helpers/mockDb.js';

vi.mock('@/db/client.js', () => ({
  db: {
    select: vi.fn(() => createChainableResult([])),
    // Non-empty by default so the module-level tenant DEK provisioning
    // below (via encryptEmail) succeeds before any test-specific mock is set.
    insert: vi.fn(() => createChainableResult([{ tenantId: null, keyVersion: 1 }])),
    update: vi.fn(() => createChainableResult([])),
  },
}));

const db = asMockedDb((await import('@/db/client.js')).db);
const {
  findUserByEmail,
  findUserById,
  hashPassword,
  toUserProfile,
  verifyPassword,
} = await import('@/services/user.service.js');
const { encryptEmail, hashEmail } = await import('@/utils/crypto.js');

const userRow = {
  id: 'a1b2c3d4-e5f6-4789-9abc-def012345678',
  email: await encryptEmail('user@example.com', null),
  emailHash: hashEmail('user@example.com'),
  passwordHash: '$2b$12$examplehash',
  firstName: 'Ada',
  lastName: 'Lovelace',
  roles: ['viewer'],
  authSource: 'password',
  samlNameId: null,
  tenantId: null,
  isActive: true,
  emailVerified: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: null,
};

beforeEach(() => {
  vi.mocked(db.select).mockReset().mockReturnValue(createChainableResult([]));
  vi.mocked(db.update).mockReset().mockReturnValue(createChainableResult([]));
});

describe('findUserByEmail', () => {
  it('looks up by email_hash and decrypts the stored email', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([userRow]));

    const found = await findUserByEmail('user@example.com');

    expect(found).not.toBeNull();
    expect(found?.user.email).toBe('user@example.com');
    expect(found?.user.id).toBe(userRow.id);
    expect(found?.passwordHash).toBe(userRow.passwordHash);
  });

  it('returns null for an unknown email', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([]));
    const found = await findUserByEmail('nobody@example.com');
    expect(found).toBeNull();
  });

  it('is case- and whitespace-insensitive (hash lookup normalizes)', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([userRow]));
    const found = await findUserByEmail('  User@Example.com  ');
    expect(found).not.toBeNull();
  });
});

describe('findUserById', () => {
  it('returns the decrypted profile for a matching id', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([userRow]));
    const user = await findUserById(userRow.id);
    expect(user?.email).toBe('user@example.com');
  });

  it('returns null when no row matches', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([]));
    const user = await findUserById('00000000-0000-4000-8000-000000000000');
    expect(user).toBeNull();
  });
});

describe('password hashing (NFR-5: bcrypt cost >= 12)', () => {
  it('hashPassword + verifyPassword round-trip', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$2[aby]\$12\$/); // bcrypt cost-factor 12 in the hash itself
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });
});

describe('toUserProfile', () => {
  it('shapes the spec UserProfile exactly', async () => {
    vi.mocked(db.select).mockReturnValue(createChainableResult([userRow]));
    const user = await findUserById(userRow.id);
    if (!user) throw new Error('expected user');

    const profile = toUserProfile(user, 'password');
    expect(profile).toEqual({
      id: userRow.id,
      email: 'user@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      roles: ['viewer'],
      auth_method: 'password',
      tenant_id: null,
      email_verified: true,
      created_at: userRow.createdAt.toISOString(),
      last_login_at: null,
    });
  });
});
