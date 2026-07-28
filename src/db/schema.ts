/**
 * Drizzle ORM schema definitions.
 *
 * All tables are defined here. Run `npm run db:generate` after changes to
 * produce the corresponding SQL migration files.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// drizzle-kit 0.21's SQL generator emits an empty (invalid) DEFAULT clause
// for `.array().default([])` — an explicit SQL literal default sidesteps it.
const emptyTextArray = sql`'{}'::text[]`;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
//
// `email` is AES-256-GCM encrypted at the application layer (see
// src/utils/crypto.ts) — its UNIQUE constraint is spec-mandated but not
// load-bearing, since GCM's random nonce means the same plaintext encrypts to
// different ciphertext each time. `emailHash` (deterministic HMAC-SHA256) is
// the column every lookup and uniqueness check actually goes through.

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    emailHash: text('email_hash').notNull().unique(),
    passwordHash: text('password_hash'), // null for SAML-only users
    firstName: text('first_name'),
    lastName: text('last_name'),
    roles: text('roles').array().notNull().default(emptyTextArray),
    authSource: text('auth_source').notNull().default('password'), // 'password' | 'saml' | 'oauth'
    samlNameId: text('saml_name_id').unique(),
    tenantId: uuid('tenant_id'),
    isActive: boolean('is_active').notNull().default(true),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (t) => ({
    emailHashIdx: index('users_email_hash_idx').on(t.emailHash),
    tenantSamlIdx: index('users_tenant_saml_idx').on(t.tenantId, t.samlNameId),
  }),
);

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 of plaintext token
    sessionFamily: uuid('session_family').notNull(), // groups tokens for reuse detection
    clientId: text('client_id'), // OAuth client_id if applicable
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'), // 'logout' | 'rotation' | 'slo' | 'reuse_detected'
  },
  (t) => ({
    userIdIdx: index('refresh_tokens_user_id_idx').on(t.userId),
    sessionFamilyIdx: index('refresh_tokens_family_idx').on(t.sessionFamily),
    expiresAtIdx: index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// Audit log — append-only; no UPDATE/DELETE performed by the gateway.
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    timestamp: timestamp('timestamp', { withTimezone: true })
      .notNull()
      .defaultNow(),
    eventType: text('event_type').notNull(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    clientId: text('client_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    resource: text('resource'),
    outcome: text('outcome').notNull(), // 'success' | 'failure' | 'denied'
    failureReason: text('failure_reason'),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => ({
    timestampIdx: index('audit_log_timestamp_idx').on(t.timestamp),
    userIdIdx: index('audit_log_user_id_idx').on(t.userId, t.timestamp),
    eventTypeIdx: index('audit_log_event_type_idx').on(
      t.eventType,
      t.timestamp,
    ),
  }),
);

// ---------------------------------------------------------------------------
// OAuth 2.0 clients
// ---------------------------------------------------------------------------

export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash'), // null for public clients
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull().default(emptyTextArray),
  allowedScopes: text('allowed_scopes').array().notNull().default(emptyTextArray),
  isPublic: boolean('is_public').notNull().default(false), // PKCE-only flow
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
  scopes: text('scopes').array().notNull().default(emptyTextArray),
  codeChallenge: text('code_challenge').notNull(), // PKCE S256 required
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
