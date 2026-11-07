// admin-privacy-erasure.ts — POST /admin/privacy/erasure-by-email
//
// dev-request 2026-10-12-slettefrist-korrespondanse-og-oversettelser, slice C:
// the GDPR art. 17 admin tool. Takes ONE e-mail address and deletes the
// correspondence, send logs and webhook events we hold for it.
//
// Request (JSON body):
//   { "email": "x@y.no",                 required
//     "apply": true,                     optional — anything else = dry-run
//     "include_suppression": true,       optional — default false (keep)
//     "confirm_unsuppressed": true,      optional — see «Who gets e-mail»
//     "requested_by": "ticket/ref"       optional free-text label for the audit row }
//
// DRY-RUN IS THE DEFAULT. Only `apply: true` (or ?apply=true / "1") writes —
// the same apply convention as admin-agents-deactivate / crm-chimera-agent-
// clear. A dry-run performs SELECT COUNT(*) only, using the very same WHERE
// clauses the apply DELETEs use, so its per-table counts equal what apply
// deletes. A dry-run writes nothing at all (no audit row either), so the DB is
// byte-identical afterwards.
//
// What is matched (address normalized trim+lowercase, same as
// blocklist-service.normalizeEmail; columns compared as LOWER(TRIM(col)) so
// rows stored with stray case/whitespace are caught too):
//   crm_contacts            email
//   crm_threads             contact_id IN (those contacts)
//   crm_messages            thread_id IN (those threads)
//   crm_actions             thread_id IN threads OR contact_id IN contacts
//   crm_outbox              thread_id IN threads OR contact_id IN contacts
//   crm_retro_tagging_audit thread_id IN threads
//   crm_untriaged           from_email
//   outreach_sent_log       recipient_email
//   rfb_marketing_send_ledger recipient_email
//   resend_webhook_events   email
//   email_delivery_events   email OR crm_message_id IN (those messages)
// Children are deleted before parents, explicitly (not via FK cascade), so the
// counts are exact whether or not foreign_keys is ON.
//
// SUPPRESSION (sperreliste) IS KEPT BY DEFAULT. In this codebase the
// suppression rows for an address are:
//   email_bounces           (bounce_type hard / complaint / unsubscribe — every
//                            outreach sender reads it; avmeld-service writes
//                            its unsubscribe rows here)
//   agent_blocklist         identifier_type='email'
// They are only deleted with include_suppression: true.
//
// Who gets e-mail: outreach_sent_log / rfb_marketing_send_ledger are also the
// cooldown + touch-sequence memory. Deleting them for an address that has NO
// suppression row left afterwards could make it eligible for cold outreach
// again. Apply therefore refuses (409 not_suppressed) in that case unless the
// caller also sends confirm_unsuppressed: true. A dry-run reports the same
// `unsuppressed_after` flag.
//
// Lock/serialization discipline: same as the other admin write routes — an
// in-process in-flight guard (409 busy, like admin-profile-translations /
// switch-probe) plus ONE better-sqlite3 transaction for the whole apply
// (synchronous, so nothing else can interleave on this connection).
//
// Audit: one privacy_erasure_audit row per apply, in the same transaction:
// who (actor 'admin' + optional requested_by label), when, a keyed hash of the
// normalized address (never the address itself — an erasure log must not
// re-store what it erased), per-table counts, include_suppression.
//
// No e-mail sending, no LLM calls.

import { Router, Request, Response } from "express";
import { createHmac, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { normalizeEmail } from "../services/blocklist-service";
import { SUPPRESSING_BOUNCE_TYPES_SQL } from "../services/privacy-suppression";

const router = Router();

let dbOverrideForTesting: Database.Database | null = null;
/** Test-only seam. Never call from production code. */
export function __setPrivacyErasureDbForTesting(db: Database.Database | null): void {
  dbOverrideForTesting = db;
}
function resolveDb(): Database.Database {
  return dbOverrideForTesting ?? getDb();
}

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

// Copied (not shared) — same convention as the sibling admin write routes.
function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Keyed hash (purpose-prefixed, so the admin key is never used raw). */
export function erasureAddressHash(normalizedEmail: string): string {
  return createHmac("sha256", "privacy-erasure-audit:" + getAdminKey())
    .update(normalizedEmail, "utf8")
    .digest("hex");
}

// Sub-selects reused by several tables. Each takes the address once.
const CONTACTS = `SELECT id FROM crm_contacts WHERE LOWER(TRIM(email)) = ?`;
const THREADS = `SELECT id FROM crm_threads WHERE contact_id IN (${CONTACTS})`;
const MESSAGES = `SELECT id FROM crm_messages WHERE thread_id IN (${THREADS})`;

interface TableSpec {
  table: string;
  where: string;
  /** How many times the address parameter appears in `where`. */
  params: number;
  suppression?: boolean;
}

// Deletion order: children first, parents last.
export const ERASURE_TABLES: readonly TableSpec[] = [
  { table: "email_delivery_events", where: `LOWER(TRIM(email)) = ? OR crm_message_id IN (${MESSAGES})`, params: 2 },
  { table: "crm_outbox", where: `thread_id IN (${THREADS}) OR contact_id IN (${CONTACTS})`, params: 2 },
  { table: "crm_actions", where: `thread_id IN (${THREADS}) OR contact_id IN (${CONTACTS})`, params: 2 },
  { table: "crm_retro_tagging_audit", where: `thread_id IN (${THREADS})`, params: 1 },
  { table: "crm_messages", where: `thread_id IN (${THREADS})`, params: 1 },
  { table: "crm_threads", where: `contact_id IN (${CONTACTS})`, params: 1 },
  { table: "crm_contacts", where: `LOWER(TRIM(email)) = ?`, params: 1 },
  { table: "crm_untriaged", where: `LOWER(TRIM(from_email)) = ?`, params: 1 },
  { table: "outreach_sent_log", where: `LOWER(TRIM(recipient_email)) = ?`, params: 1 },
  { table: "rfb_marketing_send_ledger", where: `LOWER(TRIM(recipient_email)) = ?`, params: 1 },
  { table: "resend_webhook_events", where: `LOWER(TRIM(email)) = ?`, params: 1 },
  { table: "email_bounces", where: `LOWER(TRIM(email)) = ?`, params: 1, suppression: true },
  {
    table: "agent_blocklist",
    where: `identifier_type = 'email' AND LOWER(TRIM(identifier_value)) = ?`,
    params: 1,
    suppression: true,
  },
];

// What actually suppresses outreach (review B1): only the bounce types in
// SUPPRESSING_BOUNCE_TYPES (services/privacy-suppression.ts, shared with the
// nightly retention job) are read as a block by the senders; 'soft'/'unknown'/
// NULL rows written by bounce-service do NOT stop a send, so they must not
// count as «still suppressed» here. agent_blocklist email rows block via
// isBlocked().
const ACTIVE_SUPPRESSION_SQL = [
  `SELECT COUNT(*) AS c FROM email_bounces
     WHERE LOWER(TRIM(email)) = ? AND bounce_type IN ${SUPPRESSING_BOUNCE_TYPES_SQL}`,
  `SELECT COUNT(*) AS c FROM agent_blocklist
     WHERE identifier_type = 'email' AND LOWER(TRIM(identifier_value)) = ?`,
];

const SEND_HISTORY_TABLES = new Set(["outreach_sent_log", "rfb_marketing_send_ledger"]);

function args(spec: TableSpec, email: string): string[] {
  return Array.from({ length: spec.params }, () => email);
}

export interface ErasurePlan {
  counts: Record<string, number>;
  kept_suppression: Record<string, number>;
  total: number;
  suppressed_now: boolean;
  unsuppressed_after: boolean;
}

/** Read-only: per-table counts for exactly the rows apply would delete. */
export function planErasure(db: Database.Database, email: string, includeSuppression: boolean): ErasurePlan {
  const counts: Record<string, number> = {};
  const kept: Record<string, number> = {};
  let suppressionRows = 0;
  for (const spec of ERASURE_TABLES) {
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM ${spec.table} WHERE ${spec.where}`).get(...args(spec, email)) as {
      c: number;
    }).c;
    if (spec.suppression) {
      if (!includeSuppression) {
        kept[spec.table] = n;
        continue;
      }
    }
    counts[spec.table] = n;
  }
  for (const sql of ACTIVE_SUPPRESSION_SQL) {
    suppressionRows += (db.prepare(sql).get(email) as { c: number }).c;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const suppressedNow = suppressionRows > 0;
  const suppressedAfter = suppressedNow && !includeSuppression;
  const deletesSendHistory = Object.entries(counts).some(([t, n]) => SEND_HISTORY_TABLES.has(t) && n > 0);
  return {
    counts,
    kept_suppression: kept,
    total,
    suppressed_now: suppressedNow,
    unsuppressed_after: !suppressedAfter && (deletesSendHistory || (includeSuppression && suppressedNow)),
  };
}

/** One transaction: every DELETE + the audit row. Returns rows deleted per table. */
export function applyErasure(
  db: Database.Database,
  email: string,
  includeSuppression: boolean,
  requestedBy: string | null,
): { counts: Record<string, number>; total: number; audit_id: string } {
  const tx = db.transaction(() => {
    const counts: Record<string, number> = {};
    for (const spec of ERASURE_TABLES) {
      if (spec.suppression && !includeSuppression) continue;
      counts[spec.table] = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.where}`).run(...args(spec, email)).changes;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const auditId = randomUUID();
    db.prepare(
      `INSERT INTO privacy_erasure_audit
         (id, requested_at, actor, requested_by, email_hash, include_suppression, counts_json, total_rows)
       VALUES (?, ?, 'admin', ?, ?, ?, ?, ?)`,
    ).run(
      auditId,
      new Date().toISOString(),
      requestedBy,
      erasureAddressHash(email),
      includeSuppression ? 1 : 0,
      JSON.stringify(counts),
      total,
    );
    return { counts, total, audit_id: auditId };
  });
  return tx();
}

let inFlight = false;
/** Test-only. */
export function __setPrivacyErasureInFlightForTesting(v: boolean): void {
  inFlight = v;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

router.post("/erasure-by-email", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawEmail = typeof body.email === "string" ? body.email : "";
  const email = normalizeEmail(rawEmail);
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) {
    res.status(400).json({ success: false, error: "invalid_email", note: "body.email må være en gyldig e-postadresse" });
    return;
  }
  const apply = truthy(body.apply) || req.query?.apply === "1" || req.query?.apply === "true";
  const includeSuppression = truthy(body.include_suppression);
  const confirmUnsuppressed = truthy(body.confirm_unsuppressed);
  const requestedBy =
    typeof body.requested_by === "string" && body.requested_by.trim() ? body.requested_by.trim().slice(0, 200) : null;

  if (inFlight) {
    res.status(409).json({ success: false, error: "busy", note: "en annen sletting pågår — prøv igjen senere" });
    return;
  }
  inFlight = true;
  try {
    const db = resolveDb();
    const plan = planErasure(db, email, includeSuppression);
    const base = {
      email,
      include_suppression: includeSuppression,
      suppressed_now: plan.suppressed_now,
      unsuppressed_after: plan.unsuppressed_after,
      kept_suppression: plan.kept_suppression,
    };
    if (!apply) {
      res.json({ success: true, dry_run: true, ...base, counts: plan.counts, total: plan.total });
      return;
    }
    if (plan.unsuppressed_after && !confirmUnsuppressed) {
      res.status(409).json({
        success: false,
        dry_run: false,
        error: "not_suppressed",
        note:
          "adressen har ingen sperrerad etter slettingen, og utsendingsloggen ville blitt slettet — send confirm_unsuppressed: true for å fortsette",
        ...base,
        counts: plan.counts,
        total: plan.total,
      });
      return;
    }
    const result = applyErasure(db, email, includeSuppression, requestedBy);
    console.log(
      `[privacy-erasure] apply audit_id=${result.audit_id} total=${result.total} include_suppression=${includeSuppression}`,
    );
    res.json({ success: true, dry_run: false, ...base, counts: result.counts, total: result.total, audit_id: result.audit_id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  } finally {
    inFlight = false;
  }
});

export default router;
