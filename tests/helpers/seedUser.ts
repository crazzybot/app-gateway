/**
 * Seeds a single user directly into Postgres — there is no registration
 * endpoint in Phase 1 (spec §5 excludes self-service registration; SAML
 * auto-provisioning, the only other path, is a later phase). Used both as
 * a standalone script (`npm run db:seed`) and as a helper imported by
 * integration tests that need a row to log in against.
 */

import 'dotenv/config';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { encryptEmail, hashEmail } from '../../src/utils/crypto.js';
import { hashPassword } from '../../src/services/user.service.js';

export interface SeedUserInput {
  email: string;
  password: string;
  roles?: string[];
  firstName?: string;
  lastName?: string;
}

export async function seedUser(input: SeedUserInput) {
  const passwordHash = await hashPassword(input.password);

  const [row] = await db
    .insert(users)
    .values({
      email: encryptEmail(input.email),
      emailHash: hashEmail(input.email),
      passwordHash,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      roles: input.roles ?? ['viewer'],
      authSource: 'password',
      isActive: true,
      emailVerified: true,
    })
    .returning();

  if (!row) {
    throw new Error('Insert returned no row');
  }
  return row;
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const email = process.env['SEED_USER_EMAIL'] ?? 'test@example.com';
  const password = process.env['SEED_USER_PASSWORD'] ?? 'ChangeMe123!';

  seedUser({ email, password, roles: ['admin'] })
    .then((row) => {
      // CLI script, not request-handling code — console output is the point.
      // eslint-disable-next-line no-console
      console.log(`Seeded user ${row.id} (${email} / ${password})`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Failed to seed user:', error);
      process.exit(1);
    });
}
