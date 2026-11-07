// privacy-retention.ts — nightly 24-month retention for e-mail correspondence
// and send logs.
//
// dev-request 2026-10-12-slettefrist-korrespondanse-og-oversettelser, slice A
// (spec «A — Nattlig opprydding», AC1 + AC4). Slices B (profile translations)
// and C (POST /admin/privacy/erasure-by-email) are separate.
//
// MODE (env PRIVACY_RETENTION_MODE): 'off' | 'dry_run' | 'apply'. Unset or any
// other value = 'dry_run', which only READS: it computes the per-table counts
// apply would delete and logs ONE `[privacy-retention]` line. Nothing is
// written in dry_run (no marker, no audit, no summary). Rollback plan in the
// dev-request: run dry_run in prod for at least one night before apply.
// Window (env PRIVACY_RETENTION_MONTHS): default 24; anything unparsable or
// < 12 falls back to 24 — a typo must never shorten the window.
//
// UNIT = one normalized address, LOWER(TRIM(email)) (the same normalization
// slice C and blocklist-service.normalizeEmail use, done in SQLite so the
// ASCII-only LOWER matches C's WHERE clauses exactly).
//
// «LAST ACTIVITY» of an address = the newest timestamp in ANY row tied to it:
//   crm_contacts             first_seen_at, last_seen_at        (email)
//   crm_threads              created_at, updated_at, last_message_at,
//                            last_inbound_at, last_outbound_at  (contact → email)
//   crm_messages             sent_at, received_at               (thread → contact)
//   crm_actions              created_at                         (thread, else contact)
//   crm_outbox               created_at, processed_at           (thread, else contact)
//   crm_retro_tagging_audit  applied_at, reverted_at            (thread)
//   crm_untriaged            created_at, resolved_at            (from_email)
//   rfb_marketing_send_ledger reserved_at, updated_at           (recipient_email)
//   resend_webhook_events    received_at                        (email)
//   email_delivery_events    delivered_at, created_at           (email)
//   email_bounces            bounced_at, created_at  — ALL rows, suppressing too
//   outreach_sent_log        sent_at                            (recipient_email)
// A timestamp is compared as 'YYYY-MM-DD HH:MM:SS' (ISO 'T…Z' and SQLite
// format both normalize to that). A non-empty value that does not start with
// YYYY-MM-DD is treated as «unknown → newest», so it KEEPS the address. An
// address with no timestamp at all is kept too. An address is EXPIRED when its
// last activity is strictly older than the cutoff (now − months, and never
// closer than the longest outreach cooldown + 1 day).
//
// DELETED (apply) for an expired address — exactly the rows planned:
//   crm_threads + their crm_messages, crm_actions, crm_outbox,
//   crm_retro_tagging_audit; crm_untriaged; rfb_marketing_send_ledger;
//   resend_webhook_events; email_delivery_events. No email_bounces row is
//   ever deleted (see «Kept»).
//
// KEPT, always:
//   agent_blocklist (never read for deletion here);
//   email_bounces — EVERY row, of every bounce_type (suppressing, soft,
//     unknown, NULL). Several readers treat any bounce as a send block:
//     gardssalg-claim.hasClaimBlockingBounce and
//     knowledge-service.resolveFarmContactEmail refuse to send a claim code to
//     an address with any non-unsubscribe bounce. Opplevagent claim candidates
//     come from experience_outreach_sent_log (experiences.db), which this job
//     cannot see, so «no RFB outreach_sent_log row» does not prove a soft
//     bounce is unused; deleting it could make the address eligible for a
//     claim code again. Deleting non-blocking bounces is deferred to a later
//     slice. Bounces still count as activity (a recent bounce keeps the whole
//     address);
//   everything for an address with any activity at/after the cutoff;
//   crm_contacts rows — status (blocked/archived = opt-out), agent_id and
//     provider_id are suppression memory read by the outreach gates. Before a
//     contact's messages are deleted, the newest inbound time and newest
//     outbound sent_at are stored on the contact
//     (retention_last_inbound_at / retention_last_outbound_at), and every
//     lifetime «ever replied» / «ever contacted» reader ORs them in, so its
//     decision is identical before and after (AC1);
//   outreach_sent_log — NOT deleted in this slice. Its lifetime, agent_id-keyed
//     «already sent» readers (the outreach_ready_pool VIEW,
//     admin-agents-business-type, admin-pool-blocker-explain,
//     rfb-enrichment-nightly, knowledge-service.resolveFarmContactEmail,
//     gardssalg-claim, rfb-marketing-daily.findRfbFirstTouch) cannot be fed by
//     an address-keyed summary without changing who is eligible, so collapsing
//     it is deferred. Because its rows stay, the max-touch counter and the
//     cooldowns read exactly what they read before;
//
// NO MAIN-THREAD FREEZE (AC4): the plan reads one table per macrotask
// (setImmediate between them); apply deletes by rowid in transactions of about
// PRIVACY_RETENTION_BATCH_ROWS rows with a setImmediate between them, and stops
// after PRIVACY_RETENTION_MAX_ROWS_PER_RUN rows a night (logs `remaining`), so
// the first run spreads over several nights. It only starts inside 03:00–05:59
// UTC and stops before 06:00 UTC — never 07–09 UTC. A module flag stops two
// runs from overlapping.
//
// RACE: rows written between the plan and the delete get a larger rowid than
// the plan's per-table snapshot; inside each address's transaction any such
// row tied to the address makes the job skip that address tonight. The check
// only sees NEW rows (rowid > snapshot), not UPDATEs of existing rows; that is
// acceptable because every real reply or send inserts a new row (a reply
// always inserts a crm_messages row), so fresh activity is never an UPDATE only.
//
// No e-mail sending, no LLM calls, no new route.

import type Database from "better-sqlite3";

export type PrivacyRetentionMode = "off" | "dry_run" | "apply";

export const PRIVACY_RETENTION_DEFAULT_MONTHS = 24;
export const PRIVACY_RETENTION_MIN_MONTHS = 12;
/** Rows per DELETE transaction (an address's rows are never split). */
export const PRIVACY_RETENTION_BATCH_ROWS = 1000;
/** Rows deleted per night at most; the rest waits for the next night. */
export const PRIVACY_RETENTION_MAX_ROWS_PER_RUN = 50_000;
/** The job may start in [START, STOP) UTC hours and stops at STOP. */
export const PRIVACY_RETENTION_START_HOUR_UTC = 3;
export const PRIVACY_RETENTION_STOP_HOUR_UTC = 6;

export function resolvePrivacyRetentionMode(raw: string | undefined = process.env.PRIVACY_RETENTION_MODE): PrivacyRetentionMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "apply") return v;
  return "dry_run";
}

/** Months to keep. Unparsable or < 12 → 24 (never a shorter window by typo). */
export function resolvePrivacyRetentionMonths(raw: string | undefined = process.env.PRIVACY_RETENTION_MONTHS): number {
  const s = (raw ?? "").trim();
  if (!/^\d+$/.test(s)) return PRIVACY_RETENTION_DEFAULT_MONTHS;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < PRIVACY_RETENTION_MIN_MONTHS) return PRIVACY_RETENTION_DEFAULT_MONTHS;
  return Math.min(n, 1200);
}

/**
 * The longest outreach cooldown any sender applies (routes/crm.ts and
 * rfb-marketing-daily read OUTREACH_COOLDOWN_DAYS, default 60; the gate uses
 * at least 60). The cutoff is never closer than this + 1 day, so no cooldown
 * window can lose a row it would have read.
 */
export function resolveLongestCooldownDays(raw: string | undefined = process.env.OUTREACH_COOLDOWN_DAYS): number {
  const n = Math.max(1, parseInt(String(raw ?? "60"), 10) || 60);
  return Math.max(60, n);
}

function sqliteTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Cutoff as 'YYYY-MM-DD HH:MM:SS' UTC: now − months, capped by the cooldown floor. */
export function computePrivacyRetentionCutoff(now: Date, months: number, longestCooldownDays: number): string {
  const c = new Date(now.getTime());
  // Subtract whole months, clamping the day to the target month's last day
  // (setUTCMonth alone would roll 2028-02-29 − 24 → 2026-03-01).
  const day = c.getUTCDate();
  c.setUTCDate(1);
  c.setUTCMonth(c.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 0)).getUTCDate();
  c.setUTCDate(Math.min(day, lastDay));
  const floor = new Date(now.getTime() - (longestCooldownDays + 1) * 86400_000);
  return sqliteTs(c.getTime() < floor.getTime() ? c : floor);
}

const UNKNOWN_TS = "9999-12-31 23:59:59";
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** Normalize a stored timestamp for comparison; null = no timestamp. */
export function normalizeRetentionTs(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return UNKNOWN_TS;
  const v = raw.trim();
  if (v === "") return null;
  if (!DATE_PREFIX.test(v)) return UNKNOWN_TS;
  return v.slice(0, 19).replace("T", " ");
}

// Deletion order: children first, parents last (explicit, so counts are exact
// whether or not foreign_keys is ON, and no ON DELETE CASCADE/SET NULL fires).
export const RETENTION_DELETE_TABLES = [
  "email_delivery_events",
  "crm_outbox",
  "crm_actions",
  "crm_retro_tagging_audit",
  "crm_messages",
  "crm_threads",
  "crm_untriaged",
  "rfb_marketing_send_ledger",
  "resend_webhook_events",
  // Never planned in this slice (rows.email_bounces stays empty), listed so
  // the report keeps an explicit email_bounces: 0.
  "email_bounces",
] as const;
export type RetentionTable = (typeof RETENTION_DELETE_TABLES)[number];

// Tables keyed directly by an address column, for the race check.
const ADDRESS_KEYED: ReadonlyArray<[string, string]> = [
  ["crm_contacts", "email"],
  ["crm_untriaged", "from_email"],
  ["rfb_marketing_send_ledger", "recipient_email"],
  ["resend_webhook_events", "email"],
  ["email_delivery_events", "email"],
  ["email_bounces", "email"],
  ["outreach_sent_log", "recipient_email"],
];

interface AddressPlan {
  last: string | null;
  rows: Record<RetentionTable, number[]>;
  contactIds: Set<string>;
  threadIds: Set<string>;
  /** contact id → newest inbound / outbound value of the messages planned for deletion. */
  markers: Map<string, { inbound: string | null; outbound: string | null }>;
}

function emptyRows(): Record<RetentionTable, number[]> {
  const r = {} as Record<RetentionTable, number[]>;
  for (const t of RETENTION_DELETE_TABLES) r[t] = [];
  return r;
}

export interface PrivacyRetentionPlan {
  cutoff: string;
  /** Expired addresses with at least one deletable row, sorted. */
  addresses: string[];
  byAddress: Map<string, AddressPlan>;
  counts: Record<RetentionTable, number>;
  total: number;
  /** Max rowid seen per table at plan time (race check). */
  snapshot: Record<string, number>;
}

function yieldMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function maxStr(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

/**
 * Read-only: which rows apply would delete. One table per macrotask.
 * Exported for tests and for dry_run.
 */
export async function planPrivacyRetention(db: Database.Database, cutoff: string): Promise<PrivacyRetentionPlan> {
  const byAddress = new Map<string, AddressPlan>();
  const snapshot: Record<string, number> = {};
  const plan = (e: string): AddressPlan => {
    let p = byAddress.get(e);
    if (!p) {
      p = {
        last: null,
        rows: emptyRows(),
        contactIds: new Set(),
        threadIds: new Set(),
        markers: new Map(),
      };
      byAddress.set(e, p);
    }
    return p;
  };
  const touch = (p: AddressPlan, ...vals: unknown[]) => {
    for (const v of vals) p.last = maxStr(p.last, normalizeRetentionTs(v));
  };
  const snap = (table: string, rid: number) => {
    if (rid > (snapshot[table] ?? 0)) snapshot[table] = rid;
  };
  const key = (raw: string | null | undefined): string | null => (raw ? raw : null);

  // crm_contacts
  const contactAddr = new Map<string, string>();
  snapshot.crm_contacts = 0;
  for (const r of db
    .prepare(`SELECT rowid AS rid, id, LOWER(TRIM(email)) AS e, first_seen_at, last_seen_at FROM crm_contacts`)
    .all() as Array<{ rid: number; id: string; e: string | null; first_seen_at: unknown; last_seen_at: unknown }>) {
    snap("crm_contacts", r.rid);
    const e = key(r.e);
    if (!e) continue;
    contactAddr.set(String(r.id), e);
    const p = plan(e);
    p.contactIds.add(String(r.id));
    touch(p, r.first_seen_at, r.last_seen_at);
  }
  await yieldMacrotask();

  // crm_threads
  const threadAddr = new Map<string, string>();
  const threadContact = new Map<string, string>();
  snapshot.crm_threads = 0;
  for (const r of db
    .prepare(
      `SELECT rowid AS rid, id, contact_id, created_at, updated_at, last_message_at, last_inbound_at, last_outbound_at
         FROM crm_threads`,
    )
    .all() as Array<Record<string, any>>) {
    snap("crm_threads", r.rid);
    const e = contactAddr.get(String(r.contact_id));
    if (!e) continue;
    threadAddr.set(String(r.id), e);
    threadContact.set(String(r.id), String(r.contact_id));
    const p = plan(e);
    p.threadIds.add(String(r.id));
    p.rows.crm_threads.push(r.rid);
    touch(p, r.created_at, r.updated_at, r.last_message_at, r.last_inbound_at, r.last_outbound_at);
  }
  await yieldMacrotask();

  // crm_messages
  snapshot.crm_messages = 0;
  for (const r of db
    .prepare(`SELECT rowid AS rid, thread_id, direction, sent_at, received_at FROM crm_messages`)
    .all() as Array<{ rid: number; thread_id: string; direction: string; sent_at: string | null; received_at: string | null }>) {
    snap("crm_messages", r.rid);
    const e = threadAddr.get(String(r.thread_id));
    if (!e) continue;
    const p = plan(e);
    p.rows.crm_messages.push(r.rid);
    touch(p, r.sent_at, r.received_at);
    const cid = threadContact.get(String(r.thread_id))!;
    const m = p.markers.get(cid) ?? { inbound: null, outbound: null };
    if (r.direction === "in") {
      // Presence is what the «ever replied» readers test; the value is kept
      // for humans. Never NULL for an inbound row.
      m.inbound = maxStr(m.inbound, r.sent_at ?? r.received_at ?? "1970-01-01 00:00:00");
    } else if (r.direction === "out" && r.sent_at !== null && r.sent_at !== undefined) {
      // Raw value: the «ever contacted» readers take MAX(m.sent_at) as stored.
      m.outbound = maxStr(m.outbound, r.sent_at);
    }
    p.markers.set(cid, m);
  }
  await yieldMacrotask();

  // crm_actions / crm_outbox: thread's address, else the contact's.
  for (const [table, cols] of [
    ["crm_actions", "created_at, NULL AS processed_at"],
    ["crm_outbox", "created_at, processed_at"],
  ] as const) {
    snapshot[table] = 0;
    for (const r of db
      .prepare(`SELECT rowid AS rid, thread_id, contact_id, ${cols} FROM ${table}`)
      .all() as Array<{ rid: number; thread_id: string | null; contact_id: string | null; created_at: unknown; processed_at: unknown }>) {
      snap(table, r.rid);
      const e =
        (r.thread_id !== null ? threadAddr.get(String(r.thread_id)) : undefined) ??
        (r.contact_id !== null ? contactAddr.get(String(r.contact_id)) : undefined);
      if (!e) continue;
      const p = plan(e);
      p.rows[table].push(r.rid);
      touch(p, r.created_at, r.processed_at);
    }
    await yieldMacrotask();
  }

  // crm_retro_tagging_audit
  snapshot.crm_retro_tagging_audit = 0;
  for (const r of db
    .prepare(`SELECT rowid AS rid, thread_id, applied_at, reverted_at FROM crm_retro_tagging_audit`)
    .all() as Array<{ rid: number; thread_id: string; applied_at: unknown; reverted_at: unknown }>) {
    snap("crm_retro_tagging_audit", r.rid);
    const e = threadAddr.get(String(r.thread_id));
    if (!e) continue;
    const p = plan(e);
    p.rows.crm_retro_tagging_audit.push(r.rid);
    touch(p, r.applied_at, r.reverted_at);
  }
  await yieldMacrotask();

  // Address-keyed tables.
  const direct: ReadonlyArray<[RetentionTable, string, readonly string[]]> = [
    ["crm_untriaged", "from_email", ["created_at", "resolved_at"]],
    ["rfb_marketing_send_ledger", "recipient_email", ["reserved_at", "updated_at"]],
    ["resend_webhook_events", "email", ["received_at"]],
    ["email_delivery_events", "email", ["delivered_at", "created_at"]],
  ];
  for (const [table, col, tsCols] of direct) {
    snapshot[table] = 0;
    for (const r of db
      .prepare(`SELECT rowid AS rid, LOWER(TRIM(${col})) AS e, ${tsCols.join(", ")} FROM ${table}`)
      .all() as Array<Record<string, any>>) {
      snap(table, r.rid);
      const e = key(r.e);
      if (!e) continue;
      const p = plan(e);
      p.rows[table].push(r.rid);
      touch(p, ...tsCols.map((c) => r[c]));
    }
    await yieldMacrotask();
  }

  // email_bounces: every row is activity; no row is ever a delete candidate
  // (rows.email_bounces stays empty — see «Kept» in the header).
  snapshot.email_bounces = 0;
  for (const r of db
    .prepare(
      `SELECT rowid AS rid, LOWER(TRIM(email)) AS e, bounced_at, created_at FROM email_bounces`,
    )
    .all() as Array<{ rid: number; e: string | null; bounced_at: unknown; created_at: unknown }>) {
    snap("email_bounces", r.rid);
    const e = key(r.e);
    if (!e) continue;
    const p = plan(e);
    touch(p, r.bounced_at, r.created_at);
  }
  await yieldMacrotask();

  // outreach_sent_log: activity only (never deleted in this slice).
  snapshot.outreach_sent_log = 0;
  for (const r of db
    .prepare(`SELECT rowid AS rid, LOWER(TRIM(recipient_email)) AS e, sent_at FROM outreach_sent_log`)
    .all() as Array<{ rid: number; e: string | null; sent_at: unknown }>) {
    snap("outreach_sent_log", r.rid);
    const e = key(r.e);
    if (!e) continue;
    const p = plan(e);
    touch(p, r.sent_at);
  }
  await yieldMacrotask();

  const counts = {} as Record<RetentionTable, number>;
  for (const t of RETENTION_DELETE_TABLES) counts[t] = 0;
  const addresses: string[] = [];
  for (const [e, p] of byAddress) {
    if (p.last === null || !(p.last < cutoff)) {
      byAddress.delete(e);
      continue;
    }
    let n = 0;
    for (const t of RETENTION_DELETE_TABLES) n += p.rows[t].length;
    if (n === 0) {
      byAddress.delete(e);
      continue;
    }
    for (const t of RETENTION_DELETE_TABLES) counts[t] += p.rows[t].length;
    addresses.push(e);
  }
  addresses.sort();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { cutoff, addresses, byAddress, counts, total, snapshot };
}

function addressRowCount(p: AddressPlan): number {
  let n = 0;
  for (const t of RETENTION_DELETE_TABLES) n += p.rows[t].length;
  return n;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

const ID_CHUNK = 500;

/** Was anything tied to this address written after the plan's snapshot? */
function changedSincePlan(db: Database.Database, e: string, p: AddressPlan, snapshot: Record<string, number>): boolean {
  for (const [table, col] of ADDRESS_KEYED) {
    const hit = db
      .prepare(`SELECT 1 FROM ${table} WHERE rowid > ? AND LOWER(TRIM(${col})) = ? LIMIT 1`)
      .get(snapshot[table] ?? 0, e);
    if (hit) return true;
  }
  const contacts = [...p.contactIds];
  const threads = [...p.threadIds];
  if (contacts.length > 0) {
    for (let i = 0; i < contacts.length; i += ID_CHUNK) {
      const c = contacts.slice(i, i + ID_CHUNK);
      const ph = placeholders(c.length);
      if (db.prepare(`SELECT 1 FROM crm_threads WHERE rowid > ? AND contact_id IN (${ph}) LIMIT 1`).get(snapshot.crm_threads ?? 0, ...c))
        return true;
      for (const table of ["crm_actions", "crm_outbox"]) {
        if (db.prepare(`SELECT 1 FROM ${table} WHERE rowid > ? AND contact_id IN (${ph}) LIMIT 1`).get(snapshot[table] ?? 0, ...c))
          return true;
      }
    }
  }
  if (threads.length > 0) {
    for (let i = 0; i < threads.length; i += ID_CHUNK) {
      const t = threads.slice(i, i + ID_CHUNK);
      const ph = placeholders(t.length);
      for (const table of ["crm_messages", "crm_actions", "crm_outbox", "crm_retro_tagging_audit"]) {
        if (db.prepare(`SELECT 1 FROM ${table} WHERE rowid > ? AND thread_id IN (${ph}) LIMIT 1`).get(snapshot[table] ?? 0, ...t))
          return true;
      }
    }
  }
  return false;
}

/** One address: markers, then every planned DELETE. Runs inside a (nested) transaction. */
function applyAddress(db: Database.Database, p: AddressPlan): Record<RetentionTable, number> {
  const deleted = {} as Record<RetentionTable, number>;
  if (p.rows.crm_messages.length > 0) {
    const mark = db.prepare(
      `UPDATE crm_contacts
          SET retention_last_inbound_at = CASE
                WHEN ? IS NULL THEN retention_last_inbound_at
                WHEN retention_last_inbound_at IS NULL OR retention_last_inbound_at < ? THEN ?
                ELSE retention_last_inbound_at END,
              retention_last_outbound_at = CASE
                WHEN ? IS NULL THEN retention_last_outbound_at
                WHEN retention_last_outbound_at IS NULL OR retention_last_outbound_at < ? THEN ?
                ELSE retention_last_outbound_at END
        WHERE id = ?`,
    );
    for (const [cid, m] of p.markers) {
      if (m.inbound === null && m.outbound === null) continue;
      mark.run(m.inbound, m.inbound, m.inbound, m.outbound, m.outbound, m.outbound, cid);
    }
  }
  for (const t of RETENTION_DELETE_TABLES) {
    const ids = p.rows[t];
    let n = 0;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      n += db.prepare(`DELETE FROM ${t} WHERE rowid IN (${placeholders(chunk.length)})`).run(...chunk).changes;
    }
    deleted[t] = n;
  }
  return deleted;
}

export interface PrivacyRetentionReport {
  mode: PrivacyRetentionMode;
  months: number;
  cutoff: string | null;
  addresses_expired: number;
  planned: Record<string, number>;
  planned_total: number;
  deleted: Record<string, number>;
  deleted_total: number;
  addresses_processed: number;
  addresses_skipped_changed: number;
  addresses_failed: number;
  contacts_marked: number;
  remaining: number;
  capped: boolean;
  stopped_reason: "done" | "row_cap" | "window_closed" | "outside_window" | "mode_off" | "already_running";
  ms: number;
}

export interface PrivacyRetentionOptions {
  mode?: PrivacyRetentionMode;
  months?: number;
  /** Clock; injectable for tests. */
  now?: () => Date;
  batchRows?: number;
  maxRowsPerRun?: number;
  /** Start only in [03,06) UTC and stop at 06 UTC. Default true. */
  enforceWindow?: boolean;
  longestCooldownDays?: number;
  /** Test-only hook, called between the plan and the first delete. */
  onPlanned?: (plan: PrivacyRetentionPlan) => void;
}

function inWindow(d: Date): boolean {
  const h = d.getUTCHours();
  return h >= PRIVACY_RETENTION_START_HOUR_UTC && h < PRIVACY_RETENTION_STOP_HOUR_UTC;
}

let running = false;
/** Test-only. */
export function __setPrivacyRetentionRunningForTesting(v: boolean): void {
  running = v;
}

function emptyReport(mode: PrivacyRetentionMode, months: number, reason: PrivacyRetentionReport["stopped_reason"]): PrivacyRetentionReport {
  return {
    mode,
    months,
    cutoff: null,
    addresses_expired: 0,
    planned: {},
    planned_total: 0,
    deleted: {},
    deleted_total: 0,
    addresses_processed: 0,
    addresses_skipped_changed: 0,
    addresses_failed: 0,
    contacts_marked: 0,
    remaining: 0,
    capped: false,
    stopped_reason: reason,
    ms: 0,
  };
}

/**
 * The job. dry_run reads only; apply deletes in batches with a macrotask
 * yield between them. Never throws for a single address (that address is
 * rolled back to its savepoint and counted in addresses_failed).
 */
export async function runPrivacyRetention(db: Database.Database, opts: PrivacyRetentionOptions = {}): Promise<PrivacyRetentionReport> {
  const mode = opts.mode ?? resolvePrivacyRetentionMode();
  const months = opts.months !== undefined ? resolvePrivacyRetentionMonths(String(opts.months)) : resolvePrivacyRetentionMonths();
  const clock = opts.now ?? (() => new Date());
  const enforceWindow = opts.enforceWindow ?? true;
  const batchRows = Math.max(1, opts.batchRows ?? PRIVACY_RETENTION_BATCH_ROWS);
  const maxRows = Math.max(1, opts.maxRowsPerRun ?? PRIVACY_RETENTION_MAX_ROWS_PER_RUN);

  if (mode === "off") return emptyReport(mode, months, "mode_off");
  if (running) return emptyReport(mode, months, "already_running");
  const start = clock();
  if (enforceWindow && !inWindow(start)) return emptyReport(mode, months, "outside_window");

  running = true;
  try {
    const t0 = Date.now();
    const cutoff = computePrivacyRetentionCutoff(start, months, opts.longestCooldownDays ?? resolveLongestCooldownDays());
    const plan = await planPrivacyRetention(db, cutoff);
    opts.onPlanned?.(plan);
    const report: PrivacyRetentionReport = {
      ...emptyReport(mode, months, "done"),
      cutoff,
      addresses_expired: plan.addresses.length,
      planned: { ...plan.counts },
      planned_total: plan.total,
    };
    if (mode === "dry_run") {
      report.remaining = plan.total;
      report.ms = Date.now() - t0;
      return report;
    }

    const deleted: Record<string, number> = {};
    for (const t of RETENTION_DELETE_TABLES) deleted[t] = 0;
    let idx = 0;
    while (idx < plan.addresses.length) {
      if (report.deleted_total >= maxRows) {
        report.capped = true;
        report.stopped_reason = "row_cap";
        break;
      }
      if (enforceWindow && !inWindow(clock())) {
        report.stopped_reason = "window_closed";
        break;
      }
      let batchCount = 0;
      const outer = db.transaction(() => {
        while (idx < plan.addresses.length && batchCount < batchRows && report.deleted_total < maxRows) {
          const e = plan.addresses[idx++];
          const p = plan.byAddress.get(e)!;
          try {
            if (changedSincePlan(db, e, p, plan.snapshot)) {
              report.addresses_skipped_changed++;
              continue;
            }
            const res = db.transaction(() => applyAddress(db, p))();
            let n = 0;
            for (const t of RETENTION_DELETE_TABLES) {
              deleted[t] += res[t];
              n += res[t];
            }
            report.deleted_total += n;
            batchCount += n;
            report.addresses_processed++;
            for (const m of p.markers.values()) if (m.inbound !== null || m.outbound !== null) report.contacts_marked++;
          } catch (err) {
            report.addresses_failed++;
            console.error(`[privacy-retention] address skipped after error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
      outer();
      await yieldMacrotask();
    }
    for (let i = idx; i < plan.addresses.length; i++) report.remaining += addressRowCount(plan.byAddress.get(plan.addresses[i])!);
    report.deleted = deleted;
    report.ms = Date.now() - t0;
    return report;
  } finally {
    running = false;
  }
}

export function formatPrivacyRetentionLog(r: PrivacyRetentionReport): string {
  if (r.stopped_reason === "mode_off") return `[privacy-retention] mode=off (set PRIVACY_RETENTION_MODE=dry_run|apply)`;
  if (r.stopped_reason === "already_running") return `[privacy-retention] mode=${r.mode} skipped: previous run still in progress`;
  if (r.stopped_reason === "outside_window") return `[privacy-retention] mode=${r.mode} skipped: outside 03–06 UTC window`;
  const base =
    `[privacy-retention] mode=${r.mode} months=${r.months} cutoff=${r.cutoff} addresses=${r.addresses_expired} ` +
    `planned=${JSON.stringify(r.planned)} planned_total=${r.planned_total}`;
  if (r.mode === "dry_run") return `${base} (dry_run: no rows modified) ms=${r.ms}`;
  return (
    `${base} deleted=${JSON.stringify(r.deleted)} deleted_total=${r.deleted_total} ` +
    `processed=${r.addresses_processed} skipped_changed=${r.addresses_skipped_changed} failed=${r.addresses_failed} ` +
    `contacts_marked=${r.contacts_marked} remaining=${r.remaining} capped=${r.capped} stopped=${r.stopped_reason} ms=${r.ms}`
  );
}

/** Nightly entry point (called from index.ts autoPruneTick). Never throws. */
export async function runPrivacyRetentionTick(db: Database.Database): Promise<PrivacyRetentionReport | null> {
  try {
    const r = await runPrivacyRetention(db);
    console.log(formatPrivacyRetentionLog(r));
    return r;
  } catch (err) {
    console.error("[privacy-retention] failed (non-fatal):", err);
    return null;
  }
}

// ─── Reader helper ─────────────────────────────────────────────────────────
// The lifetime readers OR in crm_contacts.retention_last_{inbound,outbound}_at.
// A DB built from a hand-written minimal schema (several unit tests) has no
// such columns, so readers probe once per handle; a positive result is cached.
const markerColsCache = new WeakMap<object, true>();
export function hasContactRetentionMarkers(db: Database.Database): boolean {
  if (markerColsCache.get(db)) return true;
  try {
    const cols = (db.prepare(`PRAGMA table_info(crm_contacts)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.includes("retention_last_inbound_at") && cols.includes("retention_last_outbound_at")) {
      markerColsCache.set(db, true);
      return true;
    }
  } catch {
    /* no table — no markers */
  }
  return false;
}
