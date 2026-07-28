/**
 * Drizzle ORM schema definitions.
 *
 * All tables are defined here. Run `npm run db:generate` after changes to
 * produce the corresponding SQL migration files.
 */

import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    displayName: text('display_name'),
    samlNameId: text('saml_name_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: index('users_email_idx').on(t.email),
  }),
);

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    jti: uuid('jti').primaryKey(),           // JWT ID — stored in Redis AND here
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isRevoked: boolean('is_revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdIdx: index('refresh_tokens_user_id_idx').on(t.userId),
    expiresAtIdx: index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// OAuth 2.0 clients
// ---------------------------------------------------------------------------

export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash'),  // null for public clients
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull().default([]),
  allowedScopes: text('allowed_scopes').array().notNull().default([]),
  isPublic: boolean('is_public').notNull().default(false),  // PKCE-only flow
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// OAuth 2.0 authorization codes (short-lived, single-use)
// ---------------------------------------------------------------------------

export const authCodes = pgTable('auth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  codeChallenge: text('code_challenge').notNull(),    // PKCE S256 required
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
