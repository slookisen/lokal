// ─── RFB outreach: the follow-up's promise is kept (promise_given) ──────────
//
// dev-request 2026-11-15-rfb-utsending-loftesetning-holdes. The RFB follow-up
// text (rfb-outreach-v4-followup) ends with «Jeg skriver ikke igjen om dette.»
// An address that has received a template carrying that sentence gets no
// further cold RFB e-mail. A third RFB touch needs new text and a new choice
// by Daniel, not a change here.
//
// The rule reads the TEMPLATE NAME, never the text, from two sources:
//   1. outreach_sent_log → crm_messages.raw_metadata.template (the RFB job
//      files `template` on every compose since the v4 deploy, 2026-10-25).
//   2. rfb_marketing_send_ledger rows with touch='second' and status
//      'sent'/'unknown'. Since v4 the job renders the second touch only from
//      rfb-outreach-v4-followup, so the touch stands for that template. This
//      also covers sends whose CRM row has no template (filed before the
//      template was recorded, or not yet confirmed into outreach_sent_log):
//      such rows are counted as promise given — conservative, it can only
//      hold an address back, never admit one. 'reserved' is NOT counted: it
//      is the job's own in-flight row for the send being made right now
//      (an orphaned 'reserved' row stays covered by the 60-day cooldown).
//
// Any matching send counts, not only the latest one: once the promise was
// given, a later send would break it whatever that send's template was. This
// includes the "latest send" case the dev-request names.
//
// A reply does not lift the rule here: the gate already holds replied
// producers, and a conversation continues on its thread (/threads/:id/send),
// which this check does not touch. Read-only; no personal data in the
// reason code.

import type Database from "better-sqlite3";
import { RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID } from "./rfb-outreach-template";

export const PROMISE_GIVEN_REASON = "promise_given";

/** Template ids whose text promises not to write again. */
export const RFB_PROMISE_TEMPLATE_IDS: ReadonlySet<string> = new Set([RFB_OUTREACH_FOLLOWUP_TEMPLATE_ID]);

// The ledger is created by init.ts on every booted database; a database that
// lacks it (hand-built test schema) must not take the whole gate down, so the
// ledger leg is probed, not assumed — same reasoning as the cross-platform
// vertical_id probe in admin-outreach-candidates.ts.
function hasLedger(db: Database.Database): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rfb_marketing_send_ledger'`).get();
}

function promiseSql(emailFilter: string, withLedger: boolean): string {
  const placeholders = [...RFB_PROMISE_TEMPLATE_IDS].map(() => "?").join(", ");
  return `
    SELECT LOWER(o.recipient_email) AS email
      FROM outreach_sent_log o
      JOIN crm_messages m ON m.id = o.message_id
     WHERE o.recipient_email IS NOT NULL AND o.recipient_email != ''
       AND m.direction = 'out'
       AND (CASE WHEN json_valid(m.raw_metadata)
                 THEN json_extract(m.raw_metadata, '$.template') END) IN (${placeholders})
       ${emailFilter.replace("$COL", "o.recipient_email")}
    ${withLedger ? `UNION
    SELECT LOWER(l.recipient_email) AS email
      FROM rfb_marketing_send_ledger l
     WHERE l.touch = 'second' AND l.status IN ('sent', 'unknown')
       ${emailFilter.replace("$COL", "l.recipient_email")}` : ""}
  `;
}

/** Every address (lower-cased) that has been given the promise. One pass, for the gate. */
export function loadRfbPromiseGivenEmails(db: Database.Database): Set<string> {
  const rows = db.prepare(promiseSql("", hasLedger(db))).all(...RFB_PROMISE_TEMPLATE_IDS) as Array<{ email: string }>;
  return new Set(rows.map((r) => r.email));
}

/** Single-address form, for the send path (executeCompose). */
export function hasRfbPromiseGiven(db: Database.Database, email: string): boolean {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const filter = "AND LOWER($COL) = ?";
  const withLedger = hasLedger(db);
  const params = withLedger ? [normalized, normalized] : [normalized];
  const row = db
    .prepare(`SELECT 1 AS hit FROM (${promiseSql(filter, withLedger)}) LIMIT 1`)
    .get(...RFB_PROMISE_TEMPLATE_IDS, ...params) as { hit: number } | undefined;
  return !!row;
}
