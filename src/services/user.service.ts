/**
 * User service — lookup, password verification, and profile shaping.
 *
 * No self-registration endpoint exists in Phase 1 (spec §5: users are
 * pre-provisioned by administrators or auto-provisioned via SAML, and SAML
 * is a later phase) — see tests/helpers/seedUser.ts for the only way a
 * `users` row gets created right now.
 */

import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { decryptEmail, hashEmail } from '../utils/crypto.js';
import type { UserProfile } from '../types/index.js';

// NFR-5: bcrypt cost factor >= 12.
export const BCRYPT_COST_FACTOR = 12;

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  roles: string[];
  authSource: string;
  tenantId: string | null;
  isActive: boolean;
  emailVerified: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

type UserRow = typeof users.$inferSelect;

function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    email: decryptEmail(row.email),
    firstName: row.firstName,
    lastName: row.lastName,
    roles: row.roles,
    authSource: row.authSource,
    tenantId: row.tenantId,
    isActive: row.isActive,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

/**
 * Looks up a user by email. Always goes through `email_hash` (deterministic
 * HMAC) — the AES-GCM `email` column can never be queried directly.
 */
export async function findUserByEmail(
  email: string,
): Promise<{ user: AuthenticatedUser; passwordHash: string | null } | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.emailHash, hashEmail(email)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return { user: toAuthenticatedUser(row), passwordHash: row.passwordHash };
}

export async function findUserById(id: string): Promise<AuthenticatedUser | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  return row ? toAuthenticatedUser(row) : null;
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST_FACTOR);
}

export async function markLastLogin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export function toUserProfile(
  user: AuthenticatedUser,
  authMethod: string,
): UserProfile {
  return {
    id: user.id,
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
    roles: user.roles,
    auth_method: authMethod,
    tenant_id: user.tenantId,
    email_verified: user.emailVerified,
    created_at: user.createdAt.toISOString(),
    last_login_at: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}
