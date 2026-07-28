/**
 * Audit service — append-only writes to `audit_log` (FR-20).
 *
 * The gateway never UPDATEs or DELETEs audit_log rows. Callers must never
 * pass plaintext tokens, passwords, or full authorization codes in
 * `metadata` — this service does not attempt to scrub them.
 */

import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { logger } from '../config/logger.js';
import type { AuditLogEntry } from '../types/index.js';

/**
 * Writes one audit event. On persistence failure, logs at `error` level with
 * full context and returns — a broken audit write must never break the auth
 * flow it's observing (this is explicit degraded-mode handling, not a
 * silent swallow: the failure is always logged).
 */
export async function writeAuditEvent(entry: AuditLogEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      eventType: entry.event_type,
      userId: entry.user_id ?? null,
      clientId: entry.client_id ?? null,
      ipAddress: entry.ip_address ?? null,
      userAgent: entry.user_agent ?? null,
      resource: entry.resource ?? null,
      outcome: entry.outcome,
      failureReason: entry.failure_reason ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (error) {
    logger.error('Failed to write audit log entry', {
      err: error,
      eventType: entry.event_type,
      outcome: entry.outcome,
    });
  }
}
