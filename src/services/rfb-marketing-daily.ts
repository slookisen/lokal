// ─── RFB outreach — the platform-side daily send ──────────────────────────────
//
// dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben (Daniel
// «GO A» 2026-09-19, reconfirmed 2026-09-22; built 2026-09-28 in a live
// session). The Rett fra Bonden cold-outreach send moves out of the
// marketing-comms-agent Cloud Routine (which called POST /admin/crm/compose
// itself) and into this deterministic job inside lokal — the same model the
// Opplevagent lane has used since 2026-09-05 (runGardssalgOutreachDaily,
// routes/opplevelser.ts). The routine becomes report-only.
//
// Nothing that DECIDES what goes out is new here:
//   • WHO: computeOutreachCandidates() — the exact function behind
//     GET /admin/outreach-candidates (routes/admin-outreach-candidates.ts),
//     mode=first first, then mode=second to fill the remaining budget, as the
//     SKILL's FILL-MODUS orders it. Plus the SKILL's own post-refresh
//     content-quality backstop (meetsAboutQualityBar — the "durable server
//     fix" the SKILL itself names) and its canonical-URL rule; both can only
//     REMOVE a candidate, never add one.
//   • WHAT: renderRfbOutreachEmail() — the v2 template + 2026-09-08/09
//     addenda, verbatim (services/rfb-outreach-template.ts).
//   • HOW: executeCompose() — the exact body of POST /admin/crm/compose
//     (routes/crm.ts), called as vertical 'rfb', category 'marketing',
//     intent 'resend_send', createdBy 'claude', never force — so every
//     existing guard and cap counts it exactly like a routine send.
//
// What IS new is the button being pressed by the server, once a day, behind
// these guards, in this order:
//   G1 RFB_MARKETING_PLATFORM_ENABLED === "1"  (default OFF) — otherwise an
//      apply run is a no-op (no reads beyond the lane, no writes, no
//      envelope). A dry run still computes the list, so Daniel can review it
//      before flipping the switch.
//   G2 lane paused (rfb_marketing_lane_state, GET/POST
//      /admin/rfb-marketing-lane) → skip. DB-backed, not a file: lokal has no
//      runtime access to the A2A repo (same migration the Opplevagent lane
//      made 2026-09-05).
//   G3 a hard bounce / spam complaint (email_bounces — the table the gate
//      already reads) on an address RFB outreach mailed in the last 48h, not
//      already acknowledged → AUTO-PAUSE (apply only) + skip; and an
//      in-process /health-equivalent "critical" signal (memory, data volume)
//      → skip without pausing. No HTTP call to ourselves.
//   G4 budget = RFB_MARKETING_DAILY_CAP (default 10, clamped 1–30) minus RFB
//      outreach already sent today, and never more than what is left of
//      OUTREACH_MAX_PER_DAY today. Counted from the DATABASE (outreach_sent_log
//      + this job's ledger), so a restart or a second tick can never exceed it.
//
// Reserve before send, fail closed (the bug NOT copied from the gårdssalg
// lane, whose sender writes its sent-log AFTER the email and re-mailed six
// producers on 2026-09-28 after a disk-full write failure the day before):
// every recipient gets a rfb_marketing_send_ledger row (status 'reserved')
// BEFORE the email is handed to the transport, inside the same synchronous
// transaction that re-checks today's cap. If that write fails nothing is
// sent and the loop stops. A 'reserved' row whose outcome never gets
// recorded (crash, a failed follow-up write) counts as SENT for the budget
// and keeps that address out of every later run for the cooldown window.
// UNIQUE(day, recipient_email) makes a same-day second attempt impossible.

import path from "path";
import { getDb } from "../database/init";
import {
  computeOutreachCandidates,
  type OutreachCandidate,
  type OutreachCandidatesResult,
} from "../routes/admin-outreach-candidates";
import { executeCompose, resolveDailyOutreachCap, type ComposeDeps, type ComposeOutcome } from "../routes/crm";
import { diskUsage } from "../routes/admin-db-backup";
import { recordRun } from "./run-ledger";
import { marketplaceRegistry } from "./marketplace-registry";
import { knowledgeService } from "./knowledge-service";
import { classifyAboutCheapBar, meetsAboutQualityBar } from "./search-enrich";
import { slugify } from "../utils/slug";
import {
  RFB_OUTREACH_TEMPLATE_ID,
  isValidRfbProfileUrl,
  renderRfbOutreachEmail,
  rfbOutreachSocialProofLine,
  roundProducerCountDown,
  type RfbOutreachSubjectVariant,
} from "./rfb-outreach-template";

type Db = ReturnType<typeof getDb>;

// ─── Knobs ─────────────────────────────────────────────────────────────────

export const RFB_MARKETING_DAILY_AGENT = "rfb-marketing-platform";
export const RFB_MARKETING_DAILY_WINDOW_HOUR_UTC = 8;
/** 08:10Z — after the gårdssalg lane's own 08:00Z window has started. */
export const RFB_MARKETING_DAILY_WINDOW_START_MINUTE_UTC = 10;
export const RFB_MARKETING_DAILY_CAP_DEFAULT = 10;
export const RFB_MARKETING_DAILY_CAP_MIN = 1;
export const RFB_MARKETING_DAILY_CAP_MAX = 30;
export const RFB_MARKETING_BOUNCE_LOOKBACK_HOURS = 48;
/** GET /admin/outreach-candidates' own default cooldown_days. */
export const RFB_MARKETING_GATE_COOLDOWN_DAYS_DEFAULT = 60;
/** Per-mode candidate fetch; far above any budget so held/refused rows backfill. */
export const RFB_MARKETING_CANDIDATE_FETCH_LIMIT = 100;
/**
 * The /health "critical" thresholds (src/index.ts, GET /health: memUsedMb >
 * 420 → critical; disk.used_pct >= 95 → critical). Mirrored here because
 * /health computes them inline; a test pins that the two stay equal.
 */
export const HEALTH_CRITICAL_RSS_MB = 420;
export const HEALTH_CRITICAL_DISK_USED_PCT = 95;

export function isRfbMarketingPlatformEnabled(): boolean {
  return process.env.RFB_MARKETING_PLATFORM_ENABLED === "1";
}

/** RFB_MARKETING_DAILY_CAP → integer clamped to 1–30; unset/unparseable → 10. */
export function resolveRfbMarketingDailyCap(): number {
  const raw = parseInt(String(process.env.RFB_MARKETING_DAILY_CAP ?? ""), 10);
  if (!Number.isFinite(raw)) return RFB_MARKETING_DAILY_CAP_DEFAULT;
  return Math.min(Math.max(raw, RFB_MARKETING_DAILY_CAP_MIN), RFB_MARKETING_DAILY_CAP_MAX);
}

/**
 * cooldown_days the job asks the gate for. The routine called the gate with
 * the route default (60). The compose send path refuses anything inside
 * OUTREACH_COOLDOWN_DAYS (default 60; crm.ts documents it must be <= the
 * batch's cooldown_days), so if that env is ever set higher, ask the gate for
 * the higher value too — never looser than the routine, never selecting a
 * producer the send path would refuse.
 */
export function resolveRfbMarketingGateCooldownDays(): number {
  const sendPathCooldown = Math.max(1, parseInt(String(process.env.OUTREACH_COOLDOWN_DAYS ?? "60"), 10) || 60);
  return Math.max(RFB_MARKETING_GATE_COOLDOWN_DAYS_DEFAULT, sendPathCooldown);
}

// ─── Scheduling ────────────────────────────────────────────────────────────

/** Pure scheduling guard: inside 08:10–08:59Z, at most once per ~day per process. */
export function shouldRunRfbMarketingDaily(opts: {
  now: Date;
  lastRunAt: Date | null;
  minHoursBetween?: number;
}): boolean {
  if (opts.now.getUTCHours() !== RFB_MARKETING_DAILY_WINDOW_HOUR_UTC) return false;
  if (opts.now.getUTCMinutes() < RFB_MARKETING_DAILY_WINDOW_START_MINUTE_UTC) return false;
  if (opts.lastRunAt) {
    const minHoursBetween = opts.minHoursBetween ?? 20;
    if (opts.now.getTime() - opts.lastRunAt.getTime() < minHoursBetween * 3600_000) return false;
  }
  return true;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:MM:SS" — the comparable form of mixed ISO/SQLite timestamps. */
function sqliteTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ─── G2: the lane switch ───────────────────────────────────────────────────

export interface RfbMarketingLaneState {
  paused: boolean;
  changed_at: string | null;
  changed_by: string | null;
  reason: string | null;
  /** Highest email_bounces.id already acted on by an auto-pause (see G3). */
  bounce_ack_max_id: number | null;
}

export function getRfbMarketingLaneState(db: Db): RfbMarketingLaneState {
  const row = db
    .prepare(
      `SELECT paused, changed_at, changed_by, reason, bounce_ack_max_id
         FROM rfb_marketing_lane_state WHERE id = 1`,
    )
    .get() as
    | { paused: number; changed_at: string | null; changed_by: string | null; reason: string | null; bounce_ack_max_id: number | null }
    | undefined;
  if (!row) return { paused: false, changed_at: null, changed_by: null, reason: null, bounce_ack_max_id: null };
  return {
    paused: row.paused === 1,
    changed_at: row.changed_at,
    changed_by: row.changed_by,
    reason: row.reason,
    bounce_ack_max_id: row.bounce_ack_max_id,
  };
}

/**
 * Flip the lane. Anyone with the admin key may pause (routines included);
 * clearing a pause is Daniel's call — same rule as the Opplevagent lane.
 * `bounceAckMaxId` only ever moves UP (an auto-pause records the bounces it
 * acted on); omitted, the stored value is kept.
 */
export function setRfbMarketingLanePaused(
  db: Db,
  opts: { paused: boolean; by: string; reason: string | null; bounceAckMaxId?: number | null; now?: Date },
): RfbMarketingLaneState {
  db.prepare(
    `INSERT INTO rfb_marketing_lane_state (id, paused, changed_at, changed_by, reason, bounce_ack_max_id)
     VALUES (1, @paused, @changed_at, @changed_by, @reason, @bounce_ack_max_id)
     ON CONFLICT(id) DO UPDATE SET
       paused = excluded.paused,
       changed_at = excluded.changed_at,
       changed_by = excluded.changed_by,
       reason = excluded.reason,
       bounce_ack_max_id = CASE
         WHEN excluded.bounce_ack_max_id IS NULL THEN rfb_marketing_lane_state.bounce_ack_max_id
         ELSE MAX(excluded.bounce_ack_max_id, COALESCE(rfb_marketing_lane_state.bounce_ack_max_id, 0))
       END`,
  ).run({
    paused: opts.paused ? 1 : 0,
    changed_at: (opts.now ?? new Date()).toISOString(),
    changed_by: opts.by,
    reason: opts.reason,
    bounce_ack_max_id: opts.bounceAckMaxId ?? null,
  });
  return getRfbMarketingLaneState(db);
}

// ─── G3: bounces / complaints + the health signal ──────────────────────────

export interface RfbMarketingBounceHit {
  bounce_id: number;
  recipient_email: string;
  bounce_type: string | null;
  bounced_at: string;
}

/**
 * Hard bounces / spam complaints (email_bounces, the same table the gate's
 * is_hard_bounced reads) on addresses RFB outreach mailed in the last 48h —
 * outreach_sent_log (vertical 'rfb', whoever sent it) plus this job's own
 * ledger (a 'reserved' row may have no sent-log row yet). The gate never
 * selects an already-bounced address, so a hit is a NEW bounce on a recent
 * send. Bounces with id <= ackMaxId already triggered an auto-pause that a
 * human then cleared; they are not fresh any more.
 */
export function findRfbMarketingRecentBounces(db: Db, now: Date, ackMaxId: number | null): RfbMarketingBounceHit[] {
  const since = new Date(now.getTime() - RFB_MARKETING_BOUNCE_LOOKBACK_HOURS * 3600_000);
  const recipients = new Set<string>();
  const oslRows = db
    .prepare(
      `SELECT DISTINCT LOWER(TRIM(recipient_email)) AS email FROM outreach_sent_log
        WHERE vertical_id = 'rfb'
          AND recipient_email IS NOT NULL AND TRIM(recipient_email) != ''
          AND replace(substr(sent_at, 1, 19), 'T', ' ') >= ?`,
    )
    .all(sqliteTimestamp(since)) as Array<{ email: string }>;
  for (const r of oslRows) recipients.add(r.email);
  const ledgerRows = db
    .prepare(
      `SELECT DISTINCT recipient_email AS email FROM rfb_marketing_send_ledger
        WHERE status IN ('reserved', 'sent') AND reserved_at >= ?`,
    )
    .all(since.toISOString()) as Array<{ email: string }>;
  for (const r of ledgerRows) recipients.add(r.email);

  const lookup = db.prepare(
    `SELECT id, bounce_type, bounced_at FROM email_bounces
      WHERE LOWER(email) = ? AND bounce_type IN ('hard', 'complaint') AND id > ?
      ORDER BY id DESC LIMIT 1`,
  );
  const hits: RfbMarketingBounceHit[] = [];
  for (const email of [...recipients].sort()) {
    const b = lookup.get(email, ackMaxId ?? 0) as { id: number; bounce_type: string | null; bounced_at: string } | undefined;
    if (b) hits.push({ bounce_id: b.id, recipient_email: email, bounce_type: b.bounce_type, bounced_at: b.bounced_at });
  }
  return hits;
}

export interface RfbMarketingHealthSignal {
  red: boolean;
  reasons: string[];
  rss_mb: number | null;
  disk_used_pct: number | null;
}

/** Pure: would GET /health report "critical" for these readings? */
export function classifyRfbMarketingHealth(readings: {
  rssMb: number | null;
  diskUsedPct: number | null;
}): RfbMarketingHealthSignal {
  const reasons: string[] = [];
  if (readings.rssMb !== null && readings.rssMb > HEALTH_CRITICAL_RSS_MB) {
    reasons.push(`memory critical: ${readings.rssMb}MB rss (> ${HEALTH_CRITICAL_RSS_MB}MB)`);
  }
  if (readings.diskUsedPct !== null && readings.diskUsedPct >= HEALTH_CRITICAL_DISK_USED_PCT) {
    reasons.push(`data volume ${readings.diskUsedPct}% full (>= ${HEALTH_CRITICAL_DISK_USED_PCT}%) — SQLite writes will fail`);
  }
  return { red: reasons.length > 0, reasons, rss_mb: readings.rssMb, disk_used_pct: readings.diskUsedPct };
}

/**
 * In-process /health equivalent: the two "critical" signals /health derives
 * from local readings (process memory, data-volume fill). No HTTP call to
 * ourselves; DB latency is not re-measured (a failing DB fails this job's
 * own reads/writes loudly anyway). A reading that cannot be taken is not red.
 */
let healthProbeOverrideForTesting: (() => RfbMarketingHealthSignal) | null = null;

/**
 * Test-only: replace the default health probe for runs that do not pass
 * `deps.healthProbe` (i.e. runs started through the admin route) — a test
 * process's own memory is not a production reading. Pass null to restore.
 * Never call from production code.
 */
export function __setRfbMarketingHealthProbeForTesting(fn: (() => RfbMarketingHealthSignal) | null): void {
  healthProbeOverrideForTesting = fn;
}

export function probeRfbMarketingHealth(): RfbMarketingHealthSignal {
  let rssMb: number | null = null;
  let diskUsedPct: number | null = null;
  try {
    rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch {
    rssMb = null;
  }
  try {
    const disk = diskUsage(path.dirname(process.env.DB_PATH || "./data/lokal.db"));
    diskUsedPct = disk ? disk.used_pct : null;
  } catch {
    diskUsedPct = null;
  }
  return classifyRfbMarketingHealth({ rssMb, diskUsedPct });
}

// ─── G4: today's budget, from the database ─────────────────────────────────

/**
 * RFB outreach already sent (or possibly sent) today, UTC: distinct
 * recipients in outreach_sent_log (vertical 'rfb', any sender — a manual send
 * earlier today shrinks the budget) ∪ this job's ledger rows that are 'sent'
 * or still 'reserved' (outcome unknown → counted as sent).
 */
export function countRfbMarketingSentToday(db: Db, now: Date): {
  total: number;
  outreach_sent_log: number;
  ledger_only: number;
} {
  const day = utcDay(now);
  const oslRows = db
    .prepare(
      `SELECT LOWER(TRIM(COALESCE(recipient_email, ''))) AS email FROM outreach_sent_log
        WHERE vertical_id = 'rfb' AND substr(replace(sent_at, 'T', ' '), 1, 10) = ?`,
    )
    .all(day) as Array<{ email: string }>;
  const seen = new Set<string>();
  let anonymous = 0;
  for (const r of oslRows) {
    if (r.email) seen.add(r.email);
    else anonymous += 1;
  }
  const oslCount = seen.size + anonymous;
  const ledgerRows = db
    .prepare(
      `SELECT recipient_email AS email FROM rfb_marketing_send_ledger
        WHERE day = ? AND status IN ('reserved', 'sent')`,
    )
    .all(day) as Array<{ email: string }>;
  let ledgerOnly = 0;
  for (const r of ledgerRows) {
    if (!seen.has(r.email)) {
      seen.add(r.email);
      ledgerOnly += 1;
    }
  }
  return { total: oslCount + ledgerOnly, outreach_sent_log: oslCount, ledger_only: ledgerOnly };
}

function readOutreachReservedToday(db: Db, day: string): number {
  const row = db.prepare(`SELECT reserved_count FROM outreach_daily_send_cap WHERE day = ?`).get(day) as
    | { reserved_count: number }
    | undefined;
  return row?.reserved_count ?? 0;
}

/**
 * The social-proof number, from the same source the routine used: the sum of
 * `by_verification_status[].c` in GET /admin/outreach-ready-pool/stats
 * (routes/admin-outreach-pool.ts) — i.e. this exact GROUP BY, summed.
 */
export function countRfbProducersForSocialProof(db: Db): number {
  const rows = db
    .prepare(`SELECT verification_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY verification_status`)
    .all() as Array<{ k: string | null; c: number }>;
  return rows.reduce((sum, r) => sum + r.c, 0);
}

// ─── Per-candidate pre-send checks (read-only) ─────────────────────────────

/**
 * The canonical profile URL, derived exactly as GET /api/marketplace/agents/
 * :id/card derives `canonicalUrl` (routes/marketplace.ts): 404 for a
 * quarantined or unknown agent, then `https://rettfrabonden.com/produsent/` +
 * slugify(agent.name) from knowledgeService.getAgentInfo. Never a local
 * slugify variant (canonical-url addendum). Validated with validate_profile_url.
 */
export function resolveRfbCanonicalProfileUrl(
  agentId: string,
): { ok: true; url: string } | { ok: false; reason: "quarantined" | "agent_not_found" | "profile_url_invalid"; url?: string } {
  if (marketplaceRegistry.isQuarantinedFromPublicView(agentId)) return { ok: false, reason: "quarantined" };
  const info = knowledgeService.getAgentInfo(agentId);
  if (!info) return { ok: false, reason: "agent_not_found" };
  const url = `https://rettfrabonden.com/produsent/${slugify(String(info.agent.name ?? ""))}`;
  if (!isValidRfbProfileUrl(url)) return { ok: false, reason: "profile_url_invalid", url };
  return { ok: true, url };
}

export type RfbHeldReason = "for_kort" | "boilerplate" | "not_norwegian";

/**
 * The SKILL's post-refresh content-quality gate, deterministically: the
 * profile must carry at least one prose block (agents.description or
 * agent_knowledge.about) that passes meetsAboutQualityBar — ≥80 chars, looks
 * Norwegian, no cookie/nav boilerplate, not umbrella "our members" text. The
 * SKILL's "not recognizably Norwegian" judgment is meetsAboutQualityBar's own
 * æøå-or-Norwegian-function-word check. Reasons use the SKILL's
 * held-for-reenrichment.json vocabulary.
 */
export function checkRfbProfileContent(
  db: Db,
  agentId: string,
): { ok: true } | { ok: false; reason: RfbHeldReason; description_length: number } {
  const row = db
    .prepare(
      `SELECT a.description AS description, k.about AS about
         FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(agentId) as { description: string | null; about: string | null } | undefined;
  const description = row?.description ?? "";
  const about = row?.about ?? "";
  if (meetsAboutQualityBar(description) || meetsAboutQualityBar(about)) return { ok: true };
  const longer = about.trim().length >= description.trim().length ? about : description;
  const cls = classifyAboutCheapBar(longer);
  const reason: RfbHeldReason = cls === "too_short" ? "for_kort" : cls === "foreign" ? "not_norwegian" : "boilerplate";
  return { ok: false, reason, description_length: longer.trim().length };
}

/**
 * This job's own memory of an address: an attempt today (any outcome — the
 * UNIQUE(day, recipient) key would refuse a second one anyway), or a send
 * that went out / may have gone out ('sent'/'reserved') inside the cooldown
 * window — which covers a send whose outreach_sent_log row was never written.
 */
function ledgerBlocksRecipient(
  db: Db,
  email: string,
  now: Date,
  cooldownDays: number,
): "already_attempted_today" | "recently_contacted_by_platform_job" | null {
  const today = db
    .prepare(`SELECT 1 AS hit FROM rfb_marketing_send_ledger WHERE day = ? AND recipient_email = ? LIMIT 1`)
    .get(utcDay(now), email);
  if (today) return "already_attempted_today";
  const cutoff = new Date(now.getTime() - cooldownDays * 86400_000).toISOString();
  const recent = db
    .prepare(
      `SELECT 1 AS hit FROM rfb_marketing_send_ledger
        WHERE recipient_email = ? AND status IN ('reserved', 'sent') AND reserved_at >= ? LIMIT 1`,
    )
    .get(email, cutoff);
  return recent ? "recently_contacted_by_platform_job" : null;
}

// ─── The ledger: reserve before send ───────────────────────────────────────

type ReservationResult =
  | { kind: "reserved"; ledgerId: number }
  | { kind: "cap_reached"; used: number }
  | { kind: "already_attempted_today" };

/**
 * ONE synchronous better-sqlite3 transaction: re-count today's RFB sends from
 * the database, refuse at the cap, refuse a second attempt at the same
 * address today, else insert the 'reserved' row. No await inside, so nothing
 * can interleave between the check and the reservation. Throws if the
 * database cannot be written — the caller then sends nothing.
 */
function reserveLedgerSlot(
  db: Db,
  p: {
    now: Date;
    reservedAt: string;
    dailyCap: number;
    runId: string;
    agentId: string;
    email: string;
    touch: "first" | "second";
    variant: RfbOutreachSubjectVariant;
  },
): ReservationResult {
  const tx = db.transaction((): ReservationResult => {
    const used = countRfbMarketingSentToday(db, p.now).total;
    if (used >= p.dailyCap) return { kind: "cap_reached", used };
    const existing = db
      .prepare(`SELECT 1 AS hit FROM rfb_marketing_send_ledger WHERE day = ? AND recipient_email = ?`)
      .get(utcDay(p.now), p.email);
    if (existing) return { kind: "already_attempted_today" };
    const info = db
      .prepare(
        `INSERT INTO rfb_marketing_send_ledger
           (day, run_id, agent_id, recipient_email, touch, subject_variant, status, reserved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
      )
      .run(utcDay(p.now), p.runId, p.agentId, p.email, p.touch, p.variant, p.reservedAt);
    return { kind: "reserved", ledgerId: Number(info.lastInsertRowid) };
  });
  return tx();
}

function finalizeLedgerRow(
  db: Db,
  ledgerId: number,
  p: {
    status: "sent" | "refused" | "failed";
    httpStatus: number;
    threadId: string | null;
    outboxId: string | null;
    messageId: string | null;
    error: string | null;
    updatedAt: string;
  },
): void {
  db.prepare(
    `UPDATE rfb_marketing_send_ledger
        SET status = ?, http_status = ?, thread_id = ?, outbox_id = ?, message_id = ?, error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(p.status, p.httpStatus, p.threadId, p.outboxId, p.messageId, p.error, p.updatedAt, ledgerId);
}

export interface RfbMarketingLedgerSummary {
  day: string;
  reserved: number;
  sent: number;
  refused: number;
  failed: number;
}

export function summarizeRfbMarketingLedgerDay(db: Db, now: Date): RfbMarketingLedgerSummary {
  const day = utcDay(now);
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM rfb_marketing_send_ledger WHERE day = ? GROUP BY status`)
    .all(day) as Array<{ status: string; n: number }>;
  const out: RfbMarketingLedgerSummary = { day, reserved: 0, sent: 0, refused: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === "reserved" || r.status === "sent" || r.status === "refused" || r.status === "failed") {
      out[r.status] = r.n;
    }
  }
  return out;
}

// ─── The run ───────────────────────────────────────────────────────────────

export type RfbMarketingDailyRunSkipReason =
  | "disabled_by_env"
  | "run_in_progress"
  | "paused"
  | "bounce_or_complaint_recent"
  | "health_red"
  | "daily_cap_already_sent"
  | "outreach_max_per_day_reached"
  | "social_proof_unavailable"
  | "outreach_paused"
  | "no_candidates";

/** Why the send loop stopped before the budget or the candidate list ran out. */
export type RfbMarketingStopReason =
  | "reservation_failed"
  | "ledger_update_failed"
  | "post_send_record_failed"
  | "compose_error"
  | "render_failed"
  | "paused_mid_run"
  | "daily_cap_reached"
  | "outreach_max_per_day_reached"
  | "outreach_paused";

export type RfbMarketingResultStatus = "sent" | "would_send" | "skipped" | "refused" | "error";

export interface RfbMarketingResultRow {
  agent_id: string;
  name: string;
  recipient_email: string;
  touch: "first" | "second";
  status: RfbMarketingResultStatus;
  reason?: string;
  subject_variant?: RfbOutreachSubjectVariant;
  subject?: string;
  profile_url?: string;
  http_status?: number;
  thread_id?: string;
  outbox_id?: string;
  message_id?: string;
  /** Ledger state after this row; false = the post-outcome ledger write failed (row left 'reserved'). */
  ledger_recorded?: boolean;
  post_send_error?: string;
  description_length?: number;
  /** Dry runs only: the exact text that would be sent. */
  preview_text?: string;
}

export interface RfbMarketingGateSummary {
  count: number;
  paused: boolean;
  suppressed_counts: unknown;
  cross_platform_cooldown: { count: unknown; by_vertical: unknown; unavailable: boolean };
  dedupe_suppressed_count: unknown;
  gate_integrity_violations: unknown;
}

export interface RfbMarketingDailyRunReport {
  run_id: string;
  agent: string;
  vertical: "rfb";
  trigger: "cron" | "manual";
  apply: boolean;
  enabled_by_env: boolean;
  started_at: string;
  finished_at: string;
  skipped_reason: RfbMarketingDailyRunSkipReason | null;
  stopped_reason: RfbMarketingStopReason | null;
  daily_cap: number;
  outreach_max_per_day: number;
  outreach_reserved_today: number;
  sent_today_before: number;
  budget: number;
  lane: RfbMarketingLaneState | null;
  auto_paused: boolean;
  recent_bounces: RfbMarketingBounceHit[];
  health: RfbMarketingHealthSignal | null;
  template: string;
  social_proof: { producer_count: number; producer_count_rounded: number; line: string | null } | null;
  gate: { cooldown_days: number; first: RfbMarketingGateSummary | null; second: RfbMarketingGateSummary | null } | null;
  results: RfbMarketingResultRow[];
  held_for_reenrichment: Array<{ agent_id: string; name: string; reason: RfbHeldReason; description_length: number }>;
  summary: {
    sent: number;
    would_send: number;
    skipped: number;
    refused: number;
    error: number;
    total: number;
    first_touch_sent: number;
    second_touch_sent: number;
    held: number;
  };
  envelope_recorded: boolean;
  errors: string[];
}

export interface RfbMarketingDailyDeps {
  /** Transport seam passed through to executeCompose (tests). */
  sendRaw?: ComposeDeps["sendRaw"];
  /** Health seam (tests); defaults to probeRfbMarketingHealth. */
  healthProbe?: () => RfbMarketingHealthSignal;
}

function summarizeGate(r: OutreachCandidatesResult): RfbMarketingGateSummary {
  const xp = (r.cross_platform_cooldown ?? {}) as Record<string, unknown>;
  return {
    count: r.count,
    paused: r.paused === true,
    suppressed_counts: r.suppressed_counts ?? null,
    cross_platform_cooldown: {
      count: xp.count ?? null,
      by_vertical: xp.by_vertical ?? null,
      unavailable: xp.unavailable === true,
    },
    dedupe_suppressed_count: r.dedupe_suppressed_count ?? null,
    gate_integrity_violations: r.gate_integrity_violations ?? null,
  };
}

function summarizeResults(results: RfbMarketingResultRow[]): RfbMarketingDailyRunReport["summary"] {
  const s = { sent: 0, would_send: 0, skipped: 0, refused: 0, error: 0, total: results.length, first_touch_sent: 0, second_touch_sent: 0, held: 0 };
  for (const r of results) {
    s[r.status] += 1;
    if (r.status === "sent") {
      if (r.touch === "second") s.second_touch_sent += 1;
      else s.first_touch_sent += 1;
    }
    if (r.status === "skipped" && r.reason?.startsWith("held_for_reenrichment:")) s.held += 1;
  }
  return s;
}

let rfbMarketingRunInFlight = false;

/**
 * The daily send. `apply: false` is a full dry run: every guard evaluated and
 * the list (with the exact rendered text) computed, nothing written, no
 * e-mail, no envelope. `apply: true` sends up to today's budget and records a
 * run envelope (agent rfb-marketing-platform) whatever the outcome — except
 * when G1 turned the job off or another run is still in flight. Throws only
 * if a guard's own read or the selection fails; per-candidate failures are
 * result rows, not exceptions.
 */
export async function runRfbMarketingDaily(opts: {
  apply: boolean;
  trigger: "cron" | "manual";
  now?: Date;
  deps?: RfbMarketingDailyDeps;
}): Promise<RfbMarketingDailyRunReport> {
  if (rfbMarketingRunInFlight) {
    return runRfbMarketingDailyGuarded({ ...opts, alreadyRunning: true });
  }
  rfbMarketingRunInFlight = true;
  try {
    return await runRfbMarketingDailyGuarded({ ...opts, alreadyRunning: false });
  } finally {
    rfbMarketingRunInFlight = false;
  }
}

async function runRfbMarketingDailyGuarded(opts: {
  apply: boolean;
  trigger: "cron" | "manual";
  now?: Date;
  deps?: RfbMarketingDailyDeps;
  alreadyRunning: boolean;
}): Promise<RfbMarketingDailyRunReport> {
  const now = opts.now ?? new Date();
  const realStart = Date.now();
  // The run's logical clock: `now` plus real elapsed time. Every timestamp this
  // run writes comes from it, so a test that pins `now` gets consistent days,
  // lookbacks and ordering.
  const clock = (): Date => new Date(now.getTime() + (Date.now() - realStart));
  const startedAt = now.toISOString();
  const day = utcDay(now);
  const runId =
    opts.trigger === "cron"
      ? `run-${day}-${RFB_MARKETING_DAILY_AGENT}`
      : `run-${day}-${RFB_MARKETING_DAILY_AGENT}-manual-${startedAt.slice(11, 23).replace(/[:.]/g, "")}-${Math.random().toString(16).slice(2, 6)}`;
  const db = getDb();
  const deps = opts.deps ?? {};
  const enabled = isRfbMarketingPlatformEnabled();
  const dailyCap = resolveRfbMarketingDailyCap();
  const outreachMaxPerDay = resolveDailyOutreachCap();
  const errors: string[] = [];

  const finish = (partial: {
    skipped_reason: RfbMarketingDailyRunSkipReason | null;
    stopped_reason?: RfbMarketingStopReason | null;
    sent_today_before?: number;
    outreach_reserved_today?: number;
    budget?: number;
    auto_paused?: boolean;
    recent_bounces?: RfbMarketingBounceHit[];
    health?: RfbMarketingHealthSignal | null;
    social_proof?: RfbMarketingDailyRunReport["social_proof"];
    gate?: RfbMarketingDailyRunReport["gate"];
    results?: RfbMarketingResultRow[];
    held?: RfbMarketingDailyRunReport["held_for_reenrichment"];
  }): RfbMarketingDailyRunReport => {
    const results = partial.results ?? [];
    let lane: RfbMarketingLaneState | null = null;
    try {
      lane = getRfbMarketingLaneState(db);
    } catch (err) {
      errors.push(`lane state unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const report: RfbMarketingDailyRunReport = {
      run_id: runId,
      agent: RFB_MARKETING_DAILY_AGENT,
      vertical: "rfb",
      trigger: opts.trigger,
      apply: opts.apply,
      enabled_by_env: enabled,
      started_at: startedAt,
      finished_at: clock().toISOString(),
      skipped_reason: partial.skipped_reason,
      stopped_reason: partial.stopped_reason ?? null,
      daily_cap: dailyCap,
      outreach_max_per_day: outreachMaxPerDay,
      outreach_reserved_today: partial.outreach_reserved_today ?? 0,
      sent_today_before: partial.sent_today_before ?? 0,
      budget: partial.budget ?? 0,
      lane,
      auto_paused: partial.auto_paused ?? false,
      recent_bounces: partial.recent_bounces ?? [],
      health: partial.health ?? null,
      template: RFB_OUTREACH_TEMPLATE_ID,
      social_proof: partial.social_proof ?? null,
      gate: partial.gate ?? null,
      results,
      held_for_reenrichment: partial.held ?? [],
      summary: summarizeResults(results),
      envelope_recorded: false,
      errors,
    };

    // Envelope: real runs only (a dry run leaves no trace), never when the env
    // switch turned the job off, never for a call that found a run in flight.
    if (opts.apply && report.skipped_reason !== "disabled_by_env" && report.skipped_reason !== "run_in_progress") {
      try {
        const isTaken = db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`);
        const base = report.run_id;
        let n = 0;
        while (isTaken.get(report.run_id)) {
          n += 1;
          report.run_id = `${base}-${report.finished_at.slice(11, 23).replace(/[:.]/g, "")}${n > 1 ? `-${n}` : ""}`;
        }
      } catch {
        // ledger unavailable — recordRun below reports it
      }
      const sentRows = results.filter((r) => r.status === "sent");
      const sentIds = sentRows.map((r) => r.agent_id);
      const status =
        report.summary.error > 0 ? (report.summary.sent > 0 ? "partial" : "failed") : "completed";
      const notes = (
        (report.skipped_reason ? `skipped: ${report.skipped_reason}. ` : "") +
        (report.stopped_reason ? `stopped: ${report.stopped_reason}. ` : "") +
        `sent=${report.summary.sent} (first=${report.summary.first_touch_sent} second=${report.summary.second_touch_sent}) ` +
        `refused=${report.summary.refused} errors=${report.summary.error} held=${report.summary.held} ` +
        `budget=${report.budget} daily_cap=${report.daily_cap} sent_today_before=${report.sent_today_before} ` +
        `template=${RFB_OUTREACH_TEMPLATE_ID}` +
        (report.auto_paused ? ` AUTO-PAUSED (${report.recent_bounces.map((b) => b.recipient_email).join(", ")})` : "") +
        (report.health?.red ? ` health: ${report.health.reasons.join("; ")}` : "")
      ).slice(0, 490);
      try {
        recordRun({
          run_id: report.run_id,
          vertical: "rfb",
          agent: RFB_MARKETING_DAILY_AGENT,
          trigger_source: opts.trigger === "cron" ? "cron" : "manual",
          started_at: startedAt,
          finished_at: report.finished_at,
          status,
          claims: [
            {
              type: "emails_sent",
              value: report.summary.sent,
              meta: {
                lane: "rfb-marketing",
                channel: "resend_smtp",
                table: "rfb_marketing_send_ledger",
                template: RFB_OUTREACH_TEMPLATE_ID,
                agent_ids: sentIds,
              },
            },
            { type: "custom", value: report.summary.first_touch_sent, meta: { kind: "rfb_marketing_first_touch_sent" } },
            { type: "custom", value: report.summary.second_touch_sent, meta: { kind: "rfb_marketing_second_touch_sent" } },
          ],
          evidence: [
            {
              claim_idx: 0,
              ids: sentIds,
              meta: {
                thread_ids: sentRows.map((r) => r.thread_id ?? null),
                message_ids: sentRows.map((r) => r.message_id ?? null),
              },
            },
          ],
          errors: errors.length > 0 ? errors.map((message) => ({ message })) : undefined,
          notes,
        });
        report.envelope_recorded = true;
      } catch (err) {
        console.error("[rfb-marketing-daily] run envelope not recorded (non-fatal):", err);
      }
    }
    console.log(
      `[rfb-marketing-daily] run_id=${report.run_id} apply=${opts.apply} enabled=${enabled} ` +
        `skipped=${report.skipped_reason ?? "-"} stopped=${report.stopped_reason ?? "-"} ` +
        `sent=${report.summary.sent} would_send=${report.summary.would_send} refused=${report.summary.refused} ` +
        `errors=${report.summary.error} held=${report.summary.held} budget=${report.budget} cap=${dailyCap} ` +
        `auto_paused=${report.auto_paused} envelope=${report.envelope_recorded}`,
    );
    return report;
  };

  if (opts.alreadyRunning) {
    return finish({ skipped_reason: "run_in_progress" });
  }

  // G1 — env switch (default OFF). An apply run does nothing at all; a dry
  // run carries on read-only so the list can be reviewed before the flip.
  if (!enabled && opts.apply) {
    return finish({ skipped_reason: "disabled_by_env" });
  }

  // G2 — lane paused.
  const laneBefore = getRfbMarketingLaneState(db);
  if (laneBefore.paused) {
    return finish({ skipped_reason: "paused" });
  }

  // G3a — fresh hard bounce / complaint on a recent RFB outreach recipient → auto-pause.
  const recentBounces = findRfbMarketingRecentBounces(db, now, laneBefore.bounce_ack_max_id);
  if (recentBounces.length > 0) {
    let autoPaused = false;
    if (opts.apply) {
      try {
        setRfbMarketingLanePaused(db, {
          paused: true,
          by: RFB_MARKETING_DAILY_AGENT,
          reason:
            `auto-pause: hard bounce/complaint on ${recentBounces.length} recipient(s) contacted in the last ` +
            `${RFB_MARKETING_BOUNCE_LOOKBACK_HOURS}h (${recentBounces.map((b) => b.recipient_email).join(", ")}). ` +
            `Clearing the pause is Daniel's call: POST /admin/rfb-marketing-lane {"paused": false}.`,
          bounceAckMaxId: Math.max(...recentBounces.map((b) => b.bounce_id)),
          now: clock(),
        });
        autoPaused = true;
      } catch (err) {
        errors.push(`auto-pause write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return finish({ skipped_reason: "bounce_or_complaint_recent", auto_paused: autoPaused, recent_bounces: recentBounces });
  }

  // G3b — the in-process /health-equivalent is red → skip (transient; no pause).
  const health = (deps.healthProbe ?? healthProbeOverrideForTesting ?? probeRfbMarketingHealth)();
  if (health.red) {
    return finish({ skipped_reason: "health_red", health });
  }

  // G4 — budget left today, from the database.
  const sentToday = countRfbMarketingSentToday(db, now);
  const outreachReservedToday = readOutreachReservedToday(db, day);
  const rfbRemaining = Math.max(0, dailyCap - sentToday.total);
  const outreachRemaining = Math.max(0, outreachMaxPerDay - outreachReservedToday);
  const budget = Math.min(rfbRemaining, outreachRemaining);
  const budgetInfo = { sent_today_before: sentToday.total, outreach_reserved_today: outreachReservedToday, budget, health };
  if (budget === 0) {
    return finish({
      ...budgetInfo,
      skipped_reason: rfbRemaining === 0 ? "daily_cap_already_sent" : "outreach_max_per_day_reached",
    });
  }

  // The social-proof sentence is shared by every e-mail in the run.
  const producerCount = countRfbProducersForSocialProof(db);
  const socialProofLine = rfbOutreachSocialProofLine(producerCount);
  const socialProof = {
    producer_count: producerCount,
    producer_count_rounded: roundProducerCountDown(producerCount),
    line: socialProofLine,
  };
  if (!socialProofLine) {
    return finish({ ...budgetInfo, social_proof: socialProof, skipped_reason: "social_proof_unavailable" });
  }

  // Selection: the gate, unchanged. mode=first first; mode=second only for the
  // budget first-touch leaves unfilled (the SKILL's FILL-MODUS).
  const cooldownDays = resolveRfbMarketingGateCooldownDays();
  const gate: NonNullable<RfbMarketingDailyRunReport["gate"]> = { cooldown_days: cooldownDays, first: null, second: null };
  const firstGate = computeOutreachCandidates(db, { mode: "first", cooldownDays, limit: RFB_MARKETING_CANDIDATE_FETCH_LIMIT });
  gate.first = summarizeGate(firstGate);
  if (firstGate.paused) {
    return finish({ ...budgetInfo, social_proof: socialProof, gate, skipped_reason: "outreach_paused" });
  }

  const results: RfbMarketingResultRow[] = [];
  const held: RfbMarketingDailyRunReport["held_for_reenrichment"] = [];
  const seenEmails = new Set<string>();
  let committed = 0; // would_send (dry) or sent (apply) this run
  let stoppedReason: RfbMarketingStopReason | null = null;

  const processList = async (list: OutreachCandidate[], touch: "first" | "second"): Promise<void> => {
    for (const cand of list) {
      if (committed >= budget || stoppedReason) return;
      const email = String(cand.email ?? "").trim().toLowerCase();
      const row: RfbMarketingResultRow = {
        agent_id: cand.agent_id,
        name: cand.name,
        recipient_email: email,
        touch,
        status: "skipped",
      };
      if (!email || seenEmails.has(email)) {
        results.push({ ...row, reason: "duplicate_email_in_run" });
        continue;
      }
      seenEmails.add(email);

      const ledgerBlock = ledgerBlocksRecipient(db, email, now, cooldownDays);
      if (ledgerBlock) {
        results.push({ ...row, reason: ledgerBlock });
        continue;
      }
      const profile = resolveRfbCanonicalProfileUrl(cand.agent_id);
      if (!profile.ok) {
        results.push({ ...row, reason: `profile_url_unavailable:${profile.reason}`, ...(profile.url ? { profile_url: profile.url } : {}) });
        continue;
      }
      row.profile_url = profile.url;
      const content = checkRfbProfileContent(db, cand.agent_id);
      if (!content.ok) {
        results.push({ ...row, reason: `held_for_reenrichment:${content.reason}`, description_length: content.description_length });
        held.push({ agent_id: cand.agent_id, name: cand.name, reason: content.reason, description_length: content.description_length });
        continue;
      }

      let rendered;
      try {
        rendered = renderRfbOutreachEmail({
          agentId: cand.agent_id,
          producerName: cand.name,
          profileUrl: profile.url,
          producerCountTotal: producerCount,
        });
      } catch (err) {
        // Nothing reserved, nothing sent — but a render failure means the
        // inputs are not what the template describes; stop rather than guess.
        results.push({ ...row, status: "error", reason: `render_failed: ${err instanceof Error ? err.message : String(err)}` });
        stoppedReason = "render_failed";
        return;
      }
      row.subject_variant = rendered.variant;
      row.subject = rendered.subject;

      if (!opts.apply) {
        results.push({ ...row, status: "would_send", preview_text: rendered.text });
        committed += 1;
        continue;
      }

      // Apply path. A pause set while this run is in flight takes effect
      // before the next reservation, not tomorrow.
      if (getRfbMarketingLaneState(db).paused) {
        stoppedReason = "paused_mid_run";
        return;
      }

      // Reserve BEFORE sending. A failed write sends nothing and stops the loop.
      let reservation: ReservationResult;
      try {
        reservation = reserveLedgerSlot(db, {
          now,
          reservedAt: clock().toISOString(),
          dailyCap,
          runId,
          agentId: cand.agent_id,
          email,
          touch,
          variant: rendered.variant,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ ...row, status: "error", reason: `reservation_failed: ${msg}` });
        errors.push(`reservation write failed for ${cand.agent_id}: ${msg} — nothing sent, loop stopped`);
        stoppedReason = "reservation_failed";
        return;
      }
      if (reservation.kind === "cap_reached") {
        stoppedReason = "daily_cap_reached";
        return;
      }
      if (reservation.kind === "already_attempted_today") {
        results.push({ ...row, reason: "already_attempted_today" });
        continue;
      }

      let outcome: ComposeOutcome;
      try {
        outcome = await executeCompose(
          {
            to: cand.email,
            contactName: cand.name,
            subject: rendered.subject,
            bodyText: rendered.text,
            intent: "resend_send",
            category: "marketing",
            createdBy: "claude",
            vertical: "rfb",
          },
          { sendRaw: deps.sendRaw },
        );
      } catch (err) {
        // executeCompose catches everything itself, so this should be
        // unreachable. If it ever throws, whether the e-mail left is unknown:
        // leave the ledger row 'reserved' (counted + blocked) and stop.
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ ...row, status: "error", reason: `compose_threw: ${msg}`, ledger_recorded: false });
        errors.push(`compose threw for ${cand.agent_id} (outcome unknown, ledger row left 'reserved'): ${msg}`);
        stoppedReason = "compose_error";
        return;
      }
      const body = outcome.body as Record<string, unknown>;
      const threadId = typeof body.threadId === "string" ? body.threadId : null;
      const outboxId = typeof body.outboxId === "string" ? body.outboxId : null;
      const messageId = typeof body.messageId === "string" ? body.messageId : null;
      const composeError = typeof body.error === "string" ? body.error : null;
      row.http_status = outcome.httpStatus;
      if (threadId) row.thread_id = threadId;
      if (outboxId) row.outbox_id = outboxId;
      if (messageId) row.message_id = messageId;

      let ledgerStatus: "sent" | "refused" | "failed";
      if (outcome.delivery === "sent") {
        ledgerStatus = "sent";
        row.status = "sent";
        committed += 1;
        if (outcome.postSendError) {
          row.post_send_error = outcome.postSendError;
          errors.push(`post-send bookkeeping failed for ${cand.agent_id} (e-mail WAS sent): ${outcome.postSendError}`);
          stoppedReason = "post_send_record_failed";
        }
      } else if (outcome.httpStatus >= 400 && outcome.httpStatus < 500) {
        ledgerStatus = "refused";
        row.status = "refused";
        row.reason = `compose_refused:${composeError ?? outcome.httpStatus}`;
        if (outcome.httpStatus === 423) stoppedReason = "outreach_paused";
        else if (composeError === "daily_cap_reached") stoppedReason = "outreach_max_per_day_reached";
      } else {
        ledgerStatus = "failed";
        row.status = "error";
        row.reason = `compose_failed:${composeError ?? outcome.httpStatus}`;
        if (!outcome.transportAttempted) {
          // Failed before the transport — the database is the likely cause.
          errors.push(`compose failed before the transport for ${cand.agent_id}: ${composeError ?? outcome.httpStatus}`);
          stoppedReason = "compose_error";
        }
      }

      try {
        finalizeLedgerRow(db, reservation.ledgerId, {
          status: ledgerStatus,
          httpStatus: outcome.httpStatus,
          threadId,
          outboxId,
          messageId,
          error: outcome.postSendError ?? (ledgerStatus === "sent" ? null : composeError),
          updatedAt: clock().toISOString(),
        });
        row.ledger_recorded = true;
      } catch (err) {
        // The row stays 'reserved': counted as sent, address blocked for the
        // cooldown window. Stop — the database is not accepting writes.
        const msg = err instanceof Error ? err.message : String(err);
        row.ledger_recorded = false;
        errors.push(`ledger update failed for ${cand.agent_id} (row left 'reserved'): ${msg}`);
        if (!stoppedReason) stoppedReason = "ledger_update_failed";
      }
      results.push(row);
    }
  };

  await processList(firstGate.candidates, "first");
  if (committed < budget && !stoppedReason) {
    const secondGate = computeOutreachCandidates(db, {
      mode: "second",
      cooldownDays,
      limit: RFB_MARKETING_CANDIDATE_FETCH_LIMIT,
    });
    gate.second = summarizeGate(secondGate);
    if (!secondGate.paused) await processList(secondGate.candidates, "second");
  }

  const anyActionable = results.some((r) => r.status !== "skipped");
  return finish({
    ...budgetInfo,
    social_proof: socialProof,
    gate,
    results,
    held,
    stopped_reason: stoppedReason,
    skipped_reason: !anyActionable && !stoppedReason ? "no_candidates" : null,
  });
}
