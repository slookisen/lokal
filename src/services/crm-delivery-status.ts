// ─── CS på serveren, S3: leveringsstatus per CRM-melding ──────────────────
// dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A), skive S3.
//
// crm_messages.delivery_status says what WE did ('sent' = handed to the relay).
// Whether the mail then arrived is Resend's answer, delivered by webhook
// (services/resend-webhook.ts). This module keeps that answer per message in
// crm_message_delivery — a side table rather than new values in
// crm_messages.delivery_status, whose CHECK constraint would need a rebuild of
// crm_messages (and its triggers) to widen.
//
// Status only moves forward: soft_bounced < delivered < bounced < complained.
// A later 'delivered' never hides an earlier bounce or complaint.

import { getDb } from "../database/init";

export type FinalDelivery = "soft_bounced" | "delivered" | "bounced" | "complained";
const RANK: Record<FinalDelivery, number> = { soft_bounced: 1, delivered: 2, bounced: 3, complained: 4 };

export function isFinalDelivery(s: unknown): s is FinalDelivery {
  return typeof s === "string" && s in RANK;
}

/**
 * Record Resend's verdict for one CRM message. Returns true when the stored
 * status changed. Never throws for a missing table (pre-migration DB).
 */
export function recordMessageDelivery(input: {
  crmMessageId: string;
  status: FinalDelivery;
  eventType: string;
  detail?: string | null;
  svixId?: string | null;
  at?: string | null;
}): boolean {
  const db = getDb();
  try {
    const cur = db.prepare("SELECT status FROM crm_message_delivery WHERE crm_message_id = ?").get(input.crmMessageId) as
      | { status: string }
      | undefined;
    if (cur && isFinalDelivery(cur.status) && RANK[cur.status] > RANK[input.status]) return false;
    if (cur && cur.status === input.status) return false;
    db.prepare(
      `INSERT INTO crm_message_delivery (crm_message_id, status, event_type, detail, svix_id, event_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(crm_message_id) DO UPDATE SET
         status = excluded.status, event_type = excluded.event_type, detail = excluded.detail,
         svix_id = excluded.svix_id, event_at = excluded.event_at, updated_at = excluded.updated_at`,
    ).run(
      input.crmMessageId,
      input.status,
      input.eventType,
      input.detail ? input.detail.slice(0, 500) : null,
      input.svixId ?? null,
      input.at ?? null,
      new Date().toISOString(),
    );
    return true;
  } catch (e: any) {
    if (/no such table/i.test(String(e?.message))) return false;
    throw e;
  }
}

export interface MessageDelivery {
  status: FinalDelivery;
  detail: string | null;
  event_at: string | null;
  updated_at: string;
}

/** Delivery verdicts for a set of message ids (missing = no verdict yet). */
export function deliveryForMessages(ids: string[]): Record<string, MessageDelivery> {
  const out: Record<string, MessageDelivery> = {};
  if (ids.length === 0) return out;
  try {
    const stmt = getDb().prepare("SELECT status, detail, event_at, updated_at FROM crm_message_delivery WHERE crm_message_id = ?");
    for (const id of ids) {
      const r = stmt.get(id) as MessageDelivery | undefined;
      if (r) out[id] = r;
    }
  } catch {
    // table missing — no verdicts
  }
  return out;
}

export interface FailedDelivery {
  crm_message_id: string;
  thread_id: string;
  vertical: string | null;
  subject: string | null;
  to_emails: string | null;
  status: FinalDelivery;
  detail: string | null;
  updated_at: string;
}

/**
 * Bounced / complained REPLIES (outbound messages on a thread that has an
 * inbound message) since `sinceIso`. Cold-outreach bounces are left to the
 * existing email_bounces suppression and are not reported here.
 */
export function failedReplyDeliveries(sinceIso: string, limit = 100): FailedDelivery[] {
  try {
    return getDb()
      .prepare(
        `SELECT d.crm_message_id, m.thread_id, m.vertical_id AS vertical, m.subject, m.to_emails, d.status, d.detail, d.updated_at
           FROM crm_message_delivery d
           JOIN crm_messages m ON m.id = d.crm_message_id
          WHERE d.status IN ('bounced', 'complained')
            AND m.direction = 'out'
            AND julianday(d.updated_at) >= julianday(?)
            AND EXISTS (SELECT 1 FROM crm_messages mi WHERE mi.thread_id = m.thread_id AND mi.direction = 'in')
          ORDER BY d.updated_at ASC
          LIMIT ?`,
      )
      .all(sinceIso, limit) as FailedDelivery[];
  } catch {
    return [];
  }
}
