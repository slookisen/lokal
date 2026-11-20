// ─── Cross-platform "has replied" index (dev-request 2026-11-20-opplevagent-
// utsending-hele-sperrelista-og-rfb-svar, spec point 2) ─────────────────────
//
// One read per run: every normalized (LOWER(TRIM())) e-mail address that has
// an inbound CRM message — on ANY vertical, and whether or not the contact is
// linked to an RFB agent or an Opplevagent provider — mapped to the verticals
// the reply was filed under. Same pattern as admin-outreach-candidates.ts's
// loadRfbRepliedContactEmails (inbound message through crm_threads, or the
// 24-month retention marker retention_last_inbound_at), minus its same-vertical
// filter: a producer that answered «fjern» in an RFB thread must not get cold
// Opplevagent mail from the same address.
//
// Both the contact's address and the inbound message's own from_email count
// (a reply from the address is a reply, whichever contact row it was filed
// on). Read-only; this can only ever hold MORE recipients back.

import type Database from "better-sqlite3";
import { hasContactRetentionMarkers } from "./privacy-retention";

function crmContactsHasVerticalColumn(db: Database.Database): boolean {
  try {
    const cols = (db.prepare(`PRAGMA table_info(crm_contacts)`).all() as Array<{ name: string }>).map((c) => c.name);
    return cols.includes("vertical_id");
  } catch {
    return false;
  }
}

/** Normalized e-mail -> sorted list of verticals the inbound reply was filed under. */
export function loadCrmRepliedEmailVerticals(db: Database.Database): Map<string, string[]> {
  const acc = new Map<string, Set<string>>();
  const add = (email: string | null, vertical: string | null) => {
    if (!email) return;
    const v = vertical || "rfb";
    let set = acc.get(email);
    if (!set) acc.set(email, (set = new Set()));
    set.add(v);
  };
  // Rows from before the vertical_id migration are RFB (same default the schema uses).
  const verticalExpr = crmContactsHasVerticalColumn(db) ? "COALESCE(c.vertical_id, 'rfb')" : "'rfb'";
  for (const r of db
    .prepare(
      `SELECT DISTINCT LOWER(TRIM(c.email)) AS contact_email, LOWER(TRIM(m.from_email)) AS from_email, ${verticalExpr} AS vertical
         FROM crm_messages m
         JOIN crm_threads t ON t.id = m.thread_id
         JOIN crm_contacts c ON c.id = t.contact_id
        WHERE m.direction = 'in'`,
    )
    .all() as Array<{ contact_email: string | null; from_email: string | null; vertical: string | null }>) {
    add(r.contact_email, r.vertical);
    add(r.from_email, r.vertical);
  }
  if (hasContactRetentionMarkers(db)) {
    for (const r of db
      .prepare(
        `SELECT DISTINCT LOWER(TRIM(c.email)) AS contact_email, ${verticalExpr} AS vertical
           FROM crm_contacts c
          WHERE c.retention_last_inbound_at IS NOT NULL`,
      )
      .all() as Array<{ contact_email: string | null; vertical: string | null }>) {
      add(r.contact_email, r.vertical);
    }
  }
  const out = new Map<string, string[]>();
  for (const [email, set] of acc) out.set(email, Array.from(set).sort());
  return out;
}
