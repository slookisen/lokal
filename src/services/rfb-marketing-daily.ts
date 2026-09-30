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
// What the job reuses unchanged:
//   • WHO: computeOutreachCandidates() — the exact function behind
//     GET /admin/outreach-candidates (routes/admin-outreach-candidates.ts),
//     mode=first first, then mode=second to fill the remaining budget, as the
//     SKILL's FILL-MODUS orders it.
//   • WHAT: renderRfbOutreachEmail() — the v2 template + 2026-09-08/09
//     addenda, verbatim (services/rfb-outreach-template.ts).
//   • HOW: executeCompose() — the exact body of POST /admin/crm/compose
//     (routes/crm.ts), called as vertical 'rfb', category 'marketing',
//     intent 'resend_send', createdBy 'claude', never force — so every
//     existing guard and cap counts it exactly like a routine send.
//
// Where the job DIFFERS from the routine's per-candidate steps (deliberate;
// each can only hold a candidate back, never add one):
//   • The SKILL's post-refresh content-quality gate, which the routine
//     applied by LLM judgment, is a deterministic check here
//     (meetsAboutQualityBar — the "durable server fix" the SKILL itself
//     names — on agents.description OR agent_knowledge.about).
//   • The profile URL is derived the way the agent card derives canonicalUrl
//     and checked with the SKILL's validate_profile_url.
//   • The SKILL's pre-send homepage-content refresh (step 2 + the
//     prebatch-homepage-refresh addendum: POST /admin/homepage-content-refresh
//     {agentIds, apply} on the candidates about to be mailed) runs in-process
//     (owner decision 2026-09-29, A2A daniel-responses/2026-09-29-live-rfb-
//     marketing-aktiveringsvalg.md: «Oppfriskning av hjemmeside før
//     utsending»): refreshHomepageContent() — the route's own per-agent body,
//     extracted verbatim (routes/admin-knowledge.ts; same SSRF-guarded fetch,
//     same curated/owner locks via canCorrectFactualField, same parking
//     bookkeeping, contact fields never touched) — once per candidate that
//     passed every cheap check and is next in line to be sent, BEFORE the
//     content check and the render, so both see the fresh content. The
//     enrichment write-pause is honoured exactly as the route honours it
//     (paused → no crawl, no write). Bounded: RFB_MARKETING_REFRESH_PER_
//     CANDIDATE_MS per candidate, RFB_MARKETING_REFRESH_TOTAL_BUDGET_MS per
//     run, at most budget + RFB_MARKETING_EXTRA_REFRESHES candidates. As in
//     the addendum («errors rows → leave existing content; still OK to
//     send»), a refresh that fails, times out, is paused or is out of budget
//     never blocks the send: the candidate goes out with the content it has
//     (still subject to the content check). Dry runs do not refresh (a
//     refresh writes). Every outcome is in the report and the envelope.
//   • EXCEPT a hijacked homepage (owner decision 2026-09-29, «2 Ja»): when
//     the refresh finds that the producer's website now reads as gambling/
//     theme spam — the route's own page-level `theme_spam_page` skip, or its
//     about/description candidate rejected as gambling/theme spam — the site
//     is no longer the producer's, and the profile we would link to may carry
//     its copy. The candidate is NOT e-mailed: outcome `hijacked`, no
//     reservation, no compose, added to held_for_reenrichment with reason
//     `hijacked_homepage` (and the refresh error as `detail`) so the
//     enrichment routine repairs the profile. Held whether or not the e-mail
//     domain equals the website domain (no domain comparison is made). Same
//     budget semantics as a content-quality hold: it spends a refresh, but
//     neither send budget nor a compose attempt. Counted separately
//     (summary.held_hijacked, refresh summary `hijacked`, envelope claim
//     rfb_marketing_held_hijacked_homepage). Only the refresh can detect it,
//     so a dry run (no refresh) or a refresh that did not fetch (write-
//     paused, out of budget, failed, timed out) does not hold. A scraped
//     code/script artifact is NOT a hijack (the site is still the
//     producer's) and does not hold; the route has no parked-domain page
//     classification (its `parked_now` is fetch-failure parking — a dead
//     domain, not someone else's site) and a failed fetch still sends.
//
// What IS new is the button being pressed by the server, once a day, behind
// these guards, in this order:
//   G1  RFB_MARKETING_PLATFORM_ENABLED === "1" (default OFF) — otherwise an
//       apply run is a no-op (no writes, no envelope). A dry run still
//       computes the list, so Daniel can review it before flipping the switch.
//   G1b apply without an injected transport requires a LIVE one
//       (emailService.isLiveTransport(): SMTP configured, not forced dry-run);
//       otherwise skip with no writes. sendRaw's DRY_RUN answer is
//       {success:true} — it must never be counted as a real send (it would
//       put producers who never got mail into the 60-day cooldown). A
//       DRY_RUN answer that still slips through stops the run and is not
//       recorded as sent.
//   G2  lane paused (rfb_marketing_lane_state, GET/POST
//       /admin/rfb-marketing-lane) → skip. DB-backed, not a file: lokal has
//       no runtime access to the A2A repo (same migration the Opplevagent
//       lane made 2026-09-05).
//   G3  a hard bounce / spam complaint (email_bounces — the table the gate
//       already reads) on an address RFB outreach mailed in the last 48h, not
//       already acknowledged → AUTO-PAUSE (apply only) + skip; and an
//       in-process /health-equivalent "critical" signal (memory, data volume)
//       → skip without pausing. No HTTP call to ourselves.
//       Feed: POST /webhooks/resend (routes/resend-webhook.ts, owner
//       decision 2026-09-29) records Resend hard bounces + complaints here
//       automatically once RESEND_WEBHOOK_SECRET is set and the webhook is
//       registered in the Resend dashboard; POST /admin/email-bounces
//       remains the manual path. Without that configuration this guard
//       still cannot fire.
//   G4  budget = RFB_MARKETING_DAILY_CAP (default 10, clamped 1–30; fly.toml
//       sets 20 — owner decision 2026-09-29 «dagskvote på 20stk») minus RFB
//       outreach already sent today, and never more than what is left of
//       OUTREACH_MAX_PER_DAY today (default 50, shared with every other
//       claude-actor resend_send). Counted from the DATABASE
//       (outreach_sent_log + this job's ledger), so a restart or a second tick
//       can never exceed it.
//
// AT MOST ONCE per address (the gårdssalg lane's send-then-log bug — which
// re-mailed six producers on 2026-09-28 after a disk-full write failure the
// day before — is NOT copied):
//   • Every recipient gets a rfb_marketing_send_ledger row (status
//     'reserved') BEFORE the e-mail is handed to the transport, inside the
//     same synchronous transaction that re-checks today's cap. If that write
//     fails nothing is sent and the loop stops.
//   • Once the transport has been invoked, only a confirmed send is 'sent';
//     a transport error is 'unknown' (the server may have accepted DATA
//     before the connection dropped), and the run stops at the FIRST such
//     failure — a broken transport is not handed the rest of the list (and
//     the run does not sit through one SMTP timeout per candidate). Only a
//     failure BEFORE the transport ('failed') is safe to retry.
//   • 'reserved' (outcome never recorded), 'sent' and 'unknown' all count
//     toward today's budget and block the address — and the agent — for the
//     cooldown window. UNIQUE(day, recipient_email) forbids a same-day retry.
//   • Compose attempts per run are capped at budget + a small margin, so a
//     streak of pre-transport refusals cannot walk the whole list.
//   • Reconciled into outreach_sent_log (review finding N-A, owner-accepted
//     2026-09-29): the ledger only blocks for the cooldown window, and only
//     this job reads it. An 'unknown' delivery (compose flips its message to
//     'failed', so no trigger row), a 'sent' whose post-send bookkeeping
//     failed, and a row left 'reserved' may all have reached the producer
//     with NO outreach_sent_log row — so after 60 days the gate would offer
//     them as a FIRST touch again, and manual compose, max-touch-vern and the
//     cross-platform cooldown never counted them. reconcileRfbLedgerRowTo-
//     SentLog() writes the missing row (vertical 'rfb', message_id
//     rfb-ledger-<id>, notes rfb-marketing-platform:<why>) — at finalize time,
//     and for anything left over (crash, DB failure) at the start of the next
//     apply run. Idempotent: a row already recorded (by that message_id, by
//     compose's trigger on the same thread, or any rfb row for the address
//     since the ledger day) is never duplicated.

import path from "path";
import { getDb } from "../database/init";
import {
  computeOutreachCandidates,
  type OutreachCandidate,
  type OutreachCandidatesResult,
} from "../routes/admin-outreach-candidates";
import { executeCompose, resolveDailyOutreachCap, type ComposeDeps, type ComposeOutcome } from "../routes/crm";
import { diskUsage } from "../routes/admin-db-backup";
import { emailService } from "./email-service";
import { recordRun } from "./run-ledger";
import { marketplaceRegistry } from "./marketplace-registry";
import { knowledgeService } from "./knowledge-service";
import { classifyAboutCheapBar, meetsAboutQualityBar } from "./search-enrich";
import { enrichmentWritePauseBlockForAgents } from "./enrichment-write-pause";
import {
  HCR_DEADLINE_EXCEEDED,
  HCR_THEME_SPAM_CANDIDATE_REASON,
  HCR_THEME_SPAM_PAGE_ERROR,
  refreshHomepageContent,
  selectHomepageContentRefreshTargetsByIds,
} from "../routes/admin-knowledge";
import { slugify } from "../utils/slug";
import {
  RFB_OUTREACH_TEMPLATE_ID,
  isValidRfbProfileUrl,
  renderRfbOutreachEmail,
  rfbOutreachSocialProofLine,
  roundProducerCountDown,
  type RfbOutreachRendered,
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
/**
 * GET /admin/outreach-candidates' own default cooldown_days. Kept at 60 by
 * owner decision 2026-09-29 («karantene 60dager», A2A daniel-responses/
 * 2026-09-29-live-rfb-marketing-aktiveringsvalg.md).
 */
export const RFB_MARKETING_GATE_COOLDOWN_DAYS_DEFAULT = 60;
/** Per-mode candidate fetch; far above any budget so held/refused rows backfill. */
export const RFB_MARKETING_CANDIDATE_FETCH_LIMIT = 100;
/**
 * Compose attempts allowed per run beyond the budget, for pre-transport
 * refusals (4xx) that do not consume the budget. A run makes at most
 * budget + this many compose calls.
 */
export const RFB_MARKETING_EXTRA_COMPOSE_ATTEMPTS = 5;
/**
 * Pre-send homepage refresh bounds. Per candidate: the whole refresh (homepage
 * + up to three same-host sub-pages; each fetch keeps its own 10s timeout
 * below this) is cut off here and writes nothing if it overruns. Per run: once
 * the total is spent, the remaining candidates go out with the content they
 * have. Count: at most budget + RFB_MARKETING_EXTRA_REFRESHES candidates are
 * refreshed (a candidate held back by the content check after its refresh
 * spends one without a send). Worst case at cap 20: 30 × 20s, capped at 3 min.
 */
export const RFB_MARKETING_REFRESH_PER_CANDIDATE_MS = 20_000;
export const RFB_MARKETING_REFRESH_TOTAL_BUDGET_MS = 180_000;
export const RFB_MARKETING_EXTRA_REFRESHES = 10;
/** Ledger statuses that mean "this address may have received the e-mail". */
const CONTACTED_LEDGER_STATUSES_SQL = "('reserved', 'sent', 'unknown')";
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

/**
 * Whether a tick's run counts as "today's run" for the tick's lastRunAt stamp
 * (src/index.ts). Two skips do not: run_in_progress (a manual run was still in
 * flight — it is not today's cron run) and health_red (a transient memory/disk
 * "critical" reading at 08:10 must not cost the whole day). Both are retried
 * on the next 10-minute tick inside the window.
 */
export function rfbMarketingRunConsumesWindow(r: { skipped_reason: string | null }): boolean {
  return r.skipped_reason !== "run_in_progress" && r.skipped_reason !== "health_red";
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
 * ledger ('reserved'/'sent'/'unknown' rows may have no sent-log row). The
 * gate never selects an already-bounced address, so a hit is a NEW bounce on
 * a recent send. Bounces with id <= ackMaxId already triggered an auto-pause
 * that a human then cleared; they are not fresh any more.
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
        WHERE status IN ${CONTACTED_LEDGER_STATUSES_SQL} AND reserved_at >= ?`,
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
 * earlier today shrinks the budget) ∪ this job's ledger rows that are 'sent',
 * 'unknown' (transport invoked, not confirmed) or still 'reserved' (outcome
 * never recorded) — all counted as sent.
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
        WHERE day = ? AND status IN ${CONTACTED_LEDGER_STATUSES_SQL}`,
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

/**
 * for_kort / boilerplate / not_norwegian: the content check (SKILL vocabulary).
 * hijacked_homepage: the pre-send refresh found the website taken over by
 * gambling/theme spam (owner decision 2026-09-29, «2 Ja»).
 */
export type RfbHeldReason = "for_kort" | "boilerplate" | "not_norwegian" | "hijacked_homepage";

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

/** Length of the longer prose block (agents.description / agent_knowledge.about), trimmed. */
function rfbProfileProseLength(db: Db, agentId: string): number {
  const row = db
    .prepare(
      `SELECT a.description AS description, k.about AS about
         FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(agentId) as { description: string | null; about: string | null } | undefined;
  return Math.max((row?.description ?? "").trim().length, (row?.about ?? "").trim().length);
}

// ─── Pre-send homepage refresh (owner decision 2026-09-29) ─────────────────

/**
 * What the pre-send refresh did for one candidate. Only "refreshed" changed
 * anything; every other outcome leaves the profile as it was and the
 * candidate is still sent (subject to the content check), as the
 * prebatch-homepage-refresh addendum prescribes for the routine.
 *   refreshed      at least one content field written from the homepage
 *   unchanged      fetched, nothing to write (already homepage-sourced,
 *                  curated/owner-locked, nothing extractable, rejected text)
 *   hijacked       the homepage reads as gambling/theme spam (the route's
 *                  `theme_spam_page` skip, or its about/description candidate
 *                  rejected as theme spam) — the ONE outcome that stops the
 *                  send: the candidate is held as `hijacked_homepage`
 *   failed         fetch failed / write failed / threw
 *   timeout        cut off at the per-candidate or run deadline (no write)
 *   write_paused   enrichment write-pause on (or unreadable → fail-closed):
 *                  no crawl, no write — exactly the route's 423
 *   no_homepage    no website on file, or an umbrella agent (the route's
 *                  own target filter)
 *   skipped_refresh_budget  run's refresh count or time budget spent
 */
export type RfbHomepageRefreshOutcome =
  | "refreshed"
  | "unchanged"
  | "hijacked"
  | "failed"
  | "timeout"
  | "write_paused"
  | "no_homepage"
  | "skipped_refresh_budget";

export interface RfbHomepageRefreshRow {
  outcome: RfbHomepageRefreshOutcome;
  /** Fields written (refreshed only). */
  fields?: string[];
  /** Candidate fields the curated/owner lock kept (the route's skipped_curated). */
  curated_locked?: string[];
  /** About/description candidate dropped (the route's skipped_unsubstantiated). */
  rejected?: string;
  error?: string;
  ms: number;
}

/** The pre-send refresh seam: one candidate, bounded by `deadlineAt`. */
export type RfbHomepageRefreshFn = (
  db: Db,
  agentId: string,
  opts: { deadlineAt: number; fetchImpl?: typeof fetch },
) => Promise<RfbHomepageRefreshRow>;

/**
 * POST /admin/homepage-content-refresh {agentIds:[agentId], apply:true}, in
 * process: the route's write-pause gate, then its explicit-id target filter,
 * then its per-agent body (refreshHomepageContent). Never throws. Waits at
 * most until `deadlineAt` (+ a small grace): the refresh itself aborts its
 * fetches at the deadline and writes nothing after it, so a run that stopped
 * waiting can never have a write land behind it.
 */
export const refreshRfbCandidateHomepage: RfbHomepageRefreshFn = async (db, agentId, opts) => {
  const t0 = Date.now();
  const done = (row: Omit<RfbHomepageRefreshRow, "ms">): RfbHomepageRefreshRow => ({ ...row, ms: Date.now() - t0 });
  try {
    // The route's own gate, same call, same fail-closed semantics.
    const pause = enrichmentWritePauseBlockForAgents(() => db, [agentId]);
    if (pause) {
      return done({ outcome: "write_paused", error: `${pause.fail_closed ? "fail_closed: " : ""}${pause.reason ?? pause.error}` });
    }
    const targets = selectHomepageContentRefreshTargetsByIds(db, [agentId], 1);
    if (targets.length === 0) return done({ outcome: "no_homepage" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), Math.max(0, opts.deadlineAt - Date.now()) + 250);
    });
    const raced = await Promise.race([
      refreshHomepageContent(db, targets, { dryRun: false, deadlineAt: opts.deadlineAt, fetchImpl: opts.fetchImpl }),
      timedOut,
    ]).finally(() => clearTimeout(timer));
    if (raced === "timed_out") return done({ outcome: "timeout", error: HCR_DEADLINE_EXCEEDED });
    const curated = raced.skipped_curated.find((c) => c.agent_id === agentId)?.fields;
    const rejected = raced.skipped_unsubstantiated.find((c) => c.agent_id === agentId)?.reason;
    const extra = { ...(curated ? { curated_locked: curated } : {}), ...(rejected ? { rejected } : {}) };
    const err = raced.errors.find((e) => e.agent_id === agentId)?.error;
    const changed = raced.changed.find((c) => c.agent_id === agentId);
    // Hijacked domain: the page-level skip (nothing written) or the
    // candidate-level rejection (other fields may still have been written).
    if (err?.startsWith(HCR_THEME_SPAM_PAGE_ERROR) || rejected === HCR_THEME_SPAM_CANDIDATE_REASON) {
      return done({
        outcome: "hijacked",
        error: err ?? rejected,
        ...(changed ? { fields: changed.fields } : {}),
        ...extra,
      });
    }
    if (err) return done({ outcome: err.startsWith(HCR_DEADLINE_EXCEEDED) ? "timeout" : "failed", error: err, ...extra });
    if (changed) return done({ outcome: "refreshed", fields: changed.fields, ...extra });
    return done({ outcome: "unchanged", ...extra });
  } catch (err) {
    return done({ outcome: "failed", error: `refresh_threw: ${errMessage(err)}` });
  }
};

export interface RfbMarketingRefreshSummary {
  /** "applied": apply run; "skipped_dry_run": a dry run never refreshes (a refresh writes). */
  mode: "applied" | "skipped_dry_run";
  per_candidate_ms: number;
  total_budget_ms: number;
  max_refreshes: number;
  attempted: number;
  refreshed: number;
  unchanged: number;
  hijacked: number;
  failed: number;
  timeout: number;
  write_paused: number;
  no_homepage: number;
  skipped_refresh_budget: number;
  by_field: Record<string, number>;
  elapsed_ms: number;
}

let refreshFetchOverrideForTesting: typeof fetch | null = null;

/**
 * Test-only: the fetch every pre-send refresh uses for runs that do not pass
 * `deps.refreshFetchImpl` (runs started through the admin route). Pass null
 * to restore the global fetch. Never call from production code.
 */
export function __setRfbMarketingRefreshFetchForTesting(fn: typeof fetch | null): void {
  refreshFetchOverrideForTesting = fn;
}

/**
 * This job's own memory of an address OR an agent: an attempt today (any
 * outcome — the UNIQUE(day, recipient) key would refuse a second one anyway),
 * or a send that went out / may have gone out ('sent'/'unknown'/'reserved')
 * inside the cooldown window — which covers a send whose outreach_sent_log row
 * was never written. Matching the agent too keeps a producer whose address
 * changed from being mailed twice within the window.
 */
function ledgerBlocksRecipient(
  db: Db,
  email: string,
  agentId: string,
  now: Date,
  cooldownDays: number,
): "already_attempted_today" | "recently_contacted_by_platform_job" | null {
  const today = db
    .prepare(
      `SELECT 1 AS hit FROM rfb_marketing_send_ledger
        WHERE day = ? AND (recipient_email = ? OR agent_id = ?) LIMIT 1`,
    )
    .get(utcDay(now), email, agentId);
  if (today) return "already_attempted_today";
  const cutoff = new Date(now.getTime() - cooldownDays * 86400_000).toISOString();
  const recent = db
    .prepare(
      `SELECT 1 AS hit FROM rfb_marketing_send_ledger
        WHERE (recipient_email = ? OR agent_id = ?)
          AND status IN ${CONTACTED_LEDGER_STATUSES_SQL} AND reserved_at >= ? LIMIT 1`,
    )
    .get(email, agentId, cutoff);
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
      .prepare(
        `SELECT 1 AS hit FROM rfb_marketing_send_ledger
          WHERE day = ? AND (recipient_email = ? OR agent_id = ?)`,
      )
      .get(utcDay(p.now), p.email, p.agentId);
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
    status: "sent" | "unknown" | "refused" | "failed";
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

// ─── N-A: the ledger's possible contacts → outreach_sent_log ───────────────

/** outreach_sent_log.notes per ledger status; readers never filter on notes. */
export const RFB_SENT_LOG_RECONCILE_NOTES = {
  unknown: "rfb-marketing-platform:unknown_delivery",
  sent: "rfb-marketing-platform:post_send_reconciled",
  reserved: "rfb-marketing-platform:reserved_outcome_unknown",
} as const;

/** The reconciled row's message_id — one per ledger row, the idempotency key. */
export function rfbLedgerSentLogMessageId(ledgerId: number): string {
  return `rfb-ledger-${ledgerId}`;
}

/** "error": the check itself failed (database) — only ever in a summary/result row, never returned. */
export type RfbSentLogReconcileResult = "inserted" | "already_present" | "no_agent" | "not_applicable" | "error";

export interface RfbSentLogReconcileRow {
  ledger_id: number;
  agent_id: string | null;
  recipient_email: string | null;
  ledger_status: string | null;
  result: RfbSentLogReconcileResult;
}

/**
 * Make sure a ledger row that may have reached the producer ('unknown',
 * 'reserved', or 'sent' — normally recorded by compose's own trigger) has an
 * outreach_sent_log row, so every reader of that table — the gate's
 * mode=first pool exclusion and mode=second cooldown, compose's email-keyed
 * cooldown (cross-platform), max-touch-vern, the bounce lookback — counts it
 * as a contact after this job's own 60-day ledger window has passed.
 *
 * The row is written the way compose's trigger writes one (routes/crm.ts →
 * trg_log_cold_outreach_on_send_confirm_v2): the agent (the ledger's, else —
 * as the trigger does — the active agent on file for that e-mail), the
 * lower-cased address, a SQLite-format sent_at (the ledger's outcome time,
 * else its reservation time), channel 'email', vertical 'rfb'; it differs
 * only in message_id (rfb-ledger-<id>) and notes. One synchronous
 * transaction: already present (that message_id; any sent-log row for a
 * crm_message on the ledger's thread; any rfb row for the address dated on
 * or after the ledger day) → nothing written. Throws on a database error.
 */
export function reconcileRfbLedgerRowToSentLog(db: Db, ledgerId: number): RfbSentLogReconcileRow {
  const tx = db.transaction((): RfbSentLogReconcileRow => {
    const row = db
      .prepare(
        `SELECT id, day, agent_id, recipient_email, status, reserved_at, updated_at, thread_id
           FROM rfb_marketing_send_ledger WHERE id = ?`,
      )
      .get(ledgerId) as
      | {
          id: number;
          day: string;
          agent_id: string;
          recipient_email: string;
          status: string;
          reserved_at: string;
          updated_at: string | null;
          thread_id: string | null;
        }
      | undefined;
    const base = {
      ledger_id: ledgerId,
      agent_id: row?.agent_id ?? null,
      recipient_email: row?.recipient_email ?? null,
      ledger_status: row?.status ?? null,
    };
    if (!row || (row.status !== "unknown" && row.status !== "sent" && row.status !== "reserved")) {
      return { ...base, result: "not_applicable" };
    }
    const email = row.recipient_email.trim().toLowerCase();
    const messageId = rfbLedgerSentLogMessageId(row.id);
    const present = db
      .prepare(
        `SELECT 1 AS hit FROM outreach_sent_log
          WHERE message_id = @messageId
             OR (@threadId IS NOT NULL AND message_id IN (SELECT id FROM crm_messages WHERE thread_id = @threadId))
             OR (recipient_email IS NOT NULL AND LOWER(recipient_email) = @email AND vertical_id = 'rfb'
                 AND substr(replace(sent_at, 'T', ' '), 1, 10) >= @day)
          LIMIT 1`,
      )
      .get({ messageId, threadId: row.thread_id, email, day: row.day });
    if (present) return { ...base, result: "already_present" };
    const agentOnFile = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(row.agent_id) as { id: string } | undefined;
    const agentId =
      agentOnFile?.id ??
      (
        db
          .prepare(
            `SELECT a.id AS id FROM agent_knowledge k JOIN agents a ON a.id = k.agent_id
              WHERE LOWER(k.email) = ? AND a.is_active = 1 LIMIT 1`,
          )
          .get(email) as { id: string } | undefined
      )?.id;
    // Same rule as the trigger: outreach_sent_log.agent_id is NOT NULL; an
    // address with no agent in the catalog is outside the pool anyway (and
    // the ledger still blocks it for the window).
    if (!agentId) return { ...base, result: "no_agent" };
    const note =
      row.status === "unknown"
        ? RFB_SENT_LOG_RECONCILE_NOTES.unknown
        : row.status === "sent"
          ? RFB_SENT_LOG_RECONCILE_NOTES.sent
          : RFB_SENT_LOG_RECONCILE_NOTES.reserved;
    db.prepare(
      `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
       VALUES (?, ?, ?, 'email', ?, ?, 'rfb')`,
    ).run(agentId, email, sqliteTimestamp(new Date(row.updated_at ?? row.reserved_at)), messageId, note);
    return { ...base, agent_id: agentId, result: "inserted" };
  });
  return tx();
}

export interface RfbSentLogReconcileSummary {
  checked: number;
  inserted: number;
  already_present: number;
  no_agent: number;
  failed: number;
  /** Rows that were inserted or could not be checked (at most 50). */
  rows: Array<RfbSentLogReconcileRow & { error?: string }>;
}

export function emptyRfbSentLogReconcileSummary(): RfbSentLogReconcileSummary {
  return { checked: 0, inserted: 0, already_present: 0, no_agent: 0, failed: 0, rows: [] };
}

function tallyReconcile(summary: RfbSentLogReconcileSummary, r: RfbSentLogReconcileRow): void {
  summary.checked += 1;
  if (r.result === "inserted") summary.inserted += 1;
  else if (r.result === "already_present") summary.already_present += 1;
  else if (r.result === "no_agent") summary.no_agent += 1;
  if (r.result === "inserted" && summary.rows.length < 50) summary.rows.push(r);
}

/**
 * The start-of-run sweep: every ledger row that may be a contact without its
 * outreach_sent_log row — 'unknown', 'reserved' (outcome never recorded:
 * crash, DB failure), and 'sent' with a recorded post-send error — whatever
 * day or run left it. Everything else ('sent' without an error is compose's
 * trigger's row; 'refused'/'failed' never reached the transport) is not
 * touched. Per-row failures are counted, never thrown.
 */
export function reconcileRfbMarketingSentLog(db: Db): RfbSentLogReconcileSummary {
  const summary = emptyRfbSentLogReconcileSummary();
  const ids = db
    .prepare(
      `SELECT id FROM rfb_marketing_send_ledger
        WHERE status IN ('unknown', 'reserved') OR (status = 'sent' AND error IS NOT NULL)
        ORDER BY id`,
    )
    .all() as Array<{ id: number }>;
  for (const { id } of ids) {
    try {
      tallyReconcile(summary, reconcileRfbLedgerRowToSentLog(db, id));
    } catch (err) {
      summary.checked += 1;
      summary.failed += 1;
      if (summary.rows.length < 50) {
        summary.rows.push({ ledger_id: id, agent_id: null, recipient_email: null, ledger_status: null, result: "error", error: errMessage(err) });
      }
    }
  }
  return summary;
}

export interface RfbMarketingLedgerSummary {
  day: string;
  reserved: number;
  sent: number;
  unknown: number;
  refused: number;
  failed: number;
}

export function summarizeRfbMarketingLedgerDay(db: Db, now: Date): RfbMarketingLedgerSummary {
  const day = utcDay(now);
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM rfb_marketing_send_ledger WHERE day = ? GROUP BY status`)
    .all(day) as Array<{ status: string; n: number }>;
  const out: RfbMarketingLedgerSummary = { day, reserved: 0, sent: 0, unknown: 0, refused: 0, failed: 0 };
  for (const r of rows) {
    if (
      r.status === "reserved" ||
      r.status === "sent" ||
      r.status === "unknown" ||
      r.status === "refused" ||
      r.status === "failed"
    ) {
      out[r.status] = r.n;
    }
  }
  return out;
}

// ─── The run ───────────────────────────────────────────────────────────────


export type RfbMarketingDailyRunSkipReason =
  | "disabled_by_env"
  | "transport_not_live"
  | "run_in_progress"
  | "paused"
  | "bounce_or_complaint_recent"
  | "health_red"
  | "daily_cap_already_sent"
  | "outreach_max_per_day_reached"
  | "social_proof_unavailable"
  | "outreach_paused"
  /** The gate returned no candidate at all. */
  | "no_candidates"
  /** The gate returned candidates, but every one was held back or blocked. */
  | "no_sendable_candidates";

/** Why the send loop stopped before the budget or the candidate list ran out. */
export type RfbMarketingStopReason =
  | "reservation_failed"
  | "ledger_update_failed"
  | "post_send_record_failed"
  | "transport_failed"
  | "transport_not_live"
  | "compose_error"
  | "render_failed"
  | "db_error"
  | "attempt_cap_reached"
  | "paused_mid_run"
  | "daily_cap_reached"
  | "outreach_max_per_day_reached"
  | "outreach_paused";

/**
 * Per-candidate outcome. "unknown": handed to the transport, not confirmed —
 * possibly delivered, so counted and blocked like a send, never retried, and
 * never claimed as sent.
 */
export type RfbMarketingResultStatus = "sent" | "unknown" | "would_send" | "skipped" | "refused" | "error";

export type RfbMarketingLedgerStatus = "reserved" | "sent" | "unknown" | "refused" | "failed";

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
  /** The ledger row's status after this candidate ('reserved' if the final write failed). */
  ledger_status?: RfbMarketingLedgerStatus;
  /** false = the post-outcome ledger write failed (row left 'reserved'). */
  ledger_recorded?: boolean;
  post_send_error?: string;
  /** Apply runs: what the pre-send homepage refresh did for this candidate. */
  homepage_refresh?: RfbHomepageRefreshRow;
  /** A possible contact reconciled into outreach_sent_log at finalize time (N-A). */
  sent_log_reconciled?: RfbSentLogReconcileResult;
  description_length?: number;
  /** Dry runs only: the exact text that would be sent. */
  preview_text?: string;
}

export interface RfbMarketingGateSummary {
  count: number;
  paused: boolean;
  suppressed_counts: unknown;
  cross_platform_cooldown: {
    count: unknown;
    by_vertical: unknown;
    unavailable: boolean;
    /** Up to 25 of the gate's named producers (the gate itself caps at 100). */
    producers: unknown[];
    truncated: boolean;
  };
  dedupe_suppressed_count: unknown;
  gate_integrity_violations: unknown;
}

export interface RfbMarketingHeldEntry {
  agent_id: string;
  name: string;
  reason: RfbHeldReason;
  description_length: number;
  /** hijacked_homepage only: the refresh's own finding (e.g. "theme_spam_page for https://…"). */
  detail?: string;
}

export interface RfbMarketingDailyRunReport {
  run_id: string;
  agent: string;
  vertical: "rfb";
  trigger: "cron" | "manual";
  apply: boolean;
  enabled_by_env: boolean;
  /** emailService.isLiveTransport() — false means sendRaw would only answer DRY_RUN. */
  transport_live: boolean;
  started_at: string;
  finished_at: string;
  skipped_reason: RfbMarketingDailyRunSkipReason | null;
  stopped_reason: RfbMarketingStopReason | null;
  daily_cap: number;
  outreach_max_per_day: number;
  outreach_reserved_today: number;
  sent_today_before: number;
  budget: number;
  compose_attempts: number;
  max_compose_attempts: number;
  lane: RfbMarketingLaneState | null;
  auto_paused: boolean;
  recent_bounces: RfbMarketingBounceHit[];
  health: RfbMarketingHealthSignal | null;
  template: string;
  social_proof: { producer_count: number; producer_count_rounded: number; line: string | null } | null;
  gate: { cooldown_days: number; first: RfbMarketingGateSummary | null; second: RfbMarketingGateSummary | null } | null;
  /** The pre-send homepage refresh (null when the run never reached selection). */
  homepage_refresh: RfbMarketingRefreshSummary | null;
  /**
   * Start-of-run N-A sweep (apply runs past G1/G1b): ledger rows that may be
   * contacts, reconciled into outreach_sent_log. Finalize-time
   * reconciliations are on the result rows (sent_log_reconciled).
   */
  sent_log_reconciliation: RfbSentLogReconcileSummary | null;
  results: RfbMarketingResultRow[];
  held_for_reenrichment: RfbMarketingHeldEntry[];
  summary: {
    sent: number;
    unknown: number;
    would_send: number;
    skipped: number;
    refused: number;
    error: number;
    total: number;
    first_touch_sent: number;
    second_touch_sent: number;
    held: number;
    /** Of `held`: candidates held because the homepage was hijacked (hijacked_homepage). */
    held_hijacked: number;
  };
  envelope_recorded: boolean;
  errors: string[];
}

export interface RfbMarketingDailyDeps {
  /** Transport seam passed through to executeCompose (tests). */
  sendRaw?: ComposeDeps["sendRaw"];
  /** Health seam (tests); defaults to probeRfbMarketingHealth. */
  healthProbe?: () => RfbMarketingHealthSignal;
  /** Pre-send refresh seam (tests); defaults to refreshRfbCandidateHomepage. */
  homepageRefresh?: RfbHomepageRefreshFn;
  /** fetch for the default refresh (tests); defaults to the global fetch. */
  refreshFetchImpl?: typeof fetch;
  /** Refresh time bounds (tests); default RFB_MARKETING_REFRESH_PER_CANDIDATE_MS / _TOTAL_BUDGET_MS. */
  refreshLimits?: { perCandidateMs?: number; totalBudgetMs?: number };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeGate(r: OutreachCandidatesResult): RfbMarketingGateSummary {
  const xp = (r.cross_platform_cooldown ?? {}) as Record<string, unknown>;
  const producers = Array.isArray(xp.producers) ? (xp.producers as unknown[]) : [];
  return {
    count: r.count,
    paused: r.paused === true,
    suppressed_counts: r.suppressed_counts ?? null,
    cross_platform_cooldown: {
      count: xp.count ?? null,
      by_vertical: xp.by_vertical ?? null,
      unavailable: xp.unavailable === true,
      producers: producers.slice(0, 25),
      truncated: producers.length > 25 || xp.truncated === true,
    },
    dedupe_suppressed_count: r.dedupe_suppressed_count ?? null,
    gate_integrity_violations: r.gate_integrity_violations ?? null,
  };
}

function summarizeResults(results: RfbMarketingResultRow[]): RfbMarketingDailyRunReport["summary"] {
  const s = {
    sent: 0,
    unknown: 0,
    would_send: 0,
    skipped: 0,
    refused: 0,
    error: 0,
    total: results.length,
    first_touch_sent: 0,
    second_touch_sent: 0,
    held: 0,
    held_hijacked: 0,
  };
  for (const r of results) {
    s[r.status] += 1;
    if (r.status === "sent") {
      if (r.touch === "second") s.second_touch_sent += 1;
      else s.first_touch_sent += 1;
    }
    if (r.status === "skipped" && r.reason?.startsWith("held_for_reenrichment:")) s.held += 1;
    if (r.status === "skipped" && r.reason === "held_for_reenrichment:hijacked_homepage") s.held_hijacked += 1;
  }
  return s;
}

let rfbMarketingRunInFlight = false;

/**
 * The daily send. `apply: false` is a full dry run: every guard evaluated and
 * the list (with the exact rendered text) computed, nothing written, no
 * e-mail, no envelope. `apply: true` sends up to today's budget and records a
 * run envelope (agent rfb-marketing-platform) whatever the outcome — except
 * when G1/G1b turned the job off or another run is still in flight. Throws
 * only if a guard's own read fails (before anything is sent); once selection
 * starts, failures are result rows / a stopped_reason and the envelope is
 * still written.
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
  const transportLive = emailService.isLiveTransport();
  const dailyCap = resolveRfbMarketingDailyCap();
  const outreachMaxPerDay = resolveDailyOutreachCap();
  const errors: string[] = [];
  let sentLogReconciliation: RfbSentLogReconcileSummary | null = null;

  const finish = (partial: {
    skipped_reason: RfbMarketingDailyRunSkipReason | null;
    stopped_reason?: RfbMarketingStopReason | null;
    sent_today_before?: number;
    outreach_reserved_today?: number;
    budget?: number;
    compose_attempts?: number;
    max_compose_attempts?: number;
    auto_paused?: boolean;
    recent_bounces?: RfbMarketingBounceHit[];
    health?: RfbMarketingHealthSignal | null;
    social_proof?: RfbMarketingDailyRunReport["social_proof"];
    gate?: RfbMarketingDailyRunReport["gate"];
    results?: RfbMarketingResultRow[];
    held?: RfbMarketingHeldEntry[];
    homepage_refresh?: RfbMarketingRefreshSummary | null;
  }): RfbMarketingDailyRunReport => {
    const results = partial.results ?? [];
    const held = partial.held ?? [];
    let lane: RfbMarketingLaneState | null = null;
    try {
      lane = getRfbMarketingLaneState(db);
    } catch (err) {
      errors.push(`lane state unreadable: ${errMessage(err)}`);
    }
    const report: RfbMarketingDailyRunReport = {
      run_id: runId,
      agent: RFB_MARKETING_DAILY_AGENT,
      vertical: "rfb",
      trigger: opts.trigger,
      apply: opts.apply,
      enabled_by_env: enabled,
      transport_live: transportLive,
      started_at: startedAt,
      finished_at: clock().toISOString(),
      skipped_reason: partial.skipped_reason,
      stopped_reason: partial.stopped_reason ?? null,
      daily_cap: dailyCap,
      outreach_max_per_day: outreachMaxPerDay,
      outreach_reserved_today: partial.outreach_reserved_today ?? 0,
      sent_today_before: partial.sent_today_before ?? 0,
      budget: partial.budget ?? 0,
      compose_attempts: partial.compose_attempts ?? 0,
      max_compose_attempts: partial.max_compose_attempts ?? 0,
      lane,
      auto_paused: partial.auto_paused ?? false,
      recent_bounces: partial.recent_bounces ?? [],
      health: partial.health ?? null,
      template: RFB_OUTREACH_TEMPLATE_ID,
      social_proof: partial.social_proof ?? null,
      gate: partial.gate ?? null,
      homepage_refresh: partial.homepage_refresh ?? null,
      sent_log_reconciliation: sentLogReconciliation,
      results,
      held_for_reenrichment: held,
      summary: summarizeResults(results),
      envelope_recorded: false,
      errors,
    };

    // Envelope: real runs only (a dry run leaves no trace), never when the
    // env switch or a non-live transport turned the job off (no writes at
    // all), never for a call that found a run in flight.
    const noTrace: Array<RfbMarketingDailyRunSkipReason | null> = ["disabled_by_env", "transport_not_live", "run_in_progress"];
    if (opts.apply && !noTrace.includes(report.skipped_reason)) {
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
      const unknownRows = results.filter((r) => r.status === "unknown");
      // A clean run is "completed". Anything that went wrong — an error or
      // unknown-delivery row, a stopped loop, a recorded error — is "partial"
      // when something was sent, else "failed".
      const troubled =
        report.summary.error > 0 || report.summary.unknown > 0 || report.stopped_reason !== null || errors.length > 0;
      const status = troubled ? (report.summary.sent > 0 ? "partial" : "failed") : "completed";
      const finalizeReconciled = results.filter((r) => r.sent_log_reconciled === "inserted").map((r) => r.agent_id);
      const reconciledCount = (sentLogReconciliation?.inserted ?? 0) + finalizeReconciled.length;
      const notes = (
        (report.skipped_reason ? `skipped: ${report.skipped_reason}. ` : "") +
        (report.stopped_reason ? `stopped: ${report.stopped_reason}. ` : "") +
        `sent=${report.summary.sent} (first=${report.summary.first_touch_sent} second=${report.summary.second_touch_sent}) ` +
        `unknown=${report.summary.unknown} refused=${report.summary.refused} errors=${report.summary.error} ` +
        `held=${report.summary.held}` +
        (report.summary.held_hijacked > 0 ? ` (hijacked=${report.summary.held_hijacked})` : "") +
        ` budget=${report.budget} daily_cap=${report.daily_cap} ` +
        `sent_today_before=${report.sent_today_before} template=${RFB_OUTREACH_TEMPLATE_ID}` +
        (report.homepage_refresh?.mode === "applied"
          ? ` refresh=${report.homepage_refresh.refreshed}/${report.homepage_refresh.attempted}` +
            (report.homepage_refresh.failed + report.homepage_refresh.timeout > 0
              ? ` (failed=${report.homepage_refresh.failed} timeout=${report.homepage_refresh.timeout})`
              : "")
          : "") +
        (reconciledCount > 0 ? ` sent_log_reconciled=${reconciledCount}` : "") +
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
            {
              type: "custom",
              value: report.summary.unknown,
              meta: { kind: "rfb_marketing_unknown_delivery", agent_ids: unknownRows.map((r) => r.agent_id) },
            },
            // What a report-only routine needs to write marketing-runs/<date>/
            // held-for-reenrichment.json (same row shape as the SKILL's file).
            {
              type: "custom",
              value: held.length,
              meta: {
                kind: "rfb_marketing_held_for_reenrichment",
                vertical: "rfb",
                held: held.slice(0, 100),
                truncated: held.length > 100,
              },
            },
            // Of those: held because the homepage was hijacked (owner
            // decision 2026-09-29 «2 Ja») — counted on their own.
            {
              type: "custom",
              value: report.summary.held_hijacked,
              meta: {
                kind: "rfb_marketing_held_hijacked_homepage",
                held: held.filter((h) => h.reason === "hijacked_homepage").slice(0, 100),
              },
            },
            // The pre-send homepage refresh (the routine logged `by_field` +
            // `changed` counts in its daily summary; same numbers here).
            {
              type: "custom",
              value: report.homepage_refresh?.refreshed ?? 0,
              meta: {
                kind: "rfb_marketing_homepage_refresh",
                summary: report.homepage_refresh,
                rows: results
                  .filter((r) => r.homepage_refresh)
                  .slice(0, 50)
                  .map((r) => ({ agent_id: r.agent_id, ...r.homepage_refresh })),
              },
            },
            // N-A: possible contacts written into outreach_sent_log this run.
            {
              type: "custom",
              value: reconciledCount,
              meta: {
                kind: "rfb_marketing_sent_log_reconciled",
                at_start: sentLogReconciliation,
                at_finalize_agent_ids: finalizeReconciled,
              },
            },
            // The gate's own suppression reporting (cross_platform_cooldown,
            // suppressed_counts …) that the SKILL requires in every run report.
            {
              type: "custom",
              value: report.gate?.first?.count ?? 0,
              meta: { kind: "rfb_marketing_gate_summary", gate: report.gate },
            },
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
      `[rfb-marketing-daily] run_id=${report.run_id} apply=${opts.apply} enabled=${enabled} transport_live=${transportLive} ` +
        `skipped=${report.skipped_reason ?? "-"} stopped=${report.stopped_reason ?? "-"} ` +
        `sent=${report.summary.sent} unknown=${report.summary.unknown} would_send=${report.summary.would_send} ` +
        `refused=${report.summary.refused} errors=${report.summary.error} held=${report.summary.held} ` +
        `held_hijacked=${report.summary.held_hijacked} ` +
        `budget=${report.budget} cap=${dailyCap} auto_paused=${report.auto_paused} envelope=${report.envelope_recorded}`,
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

  // G1b — a real run needs a real transport. sendRaw answers DRY_RUN with
  // {success: true} when SMTP is not configured; recording that as a send
  // would put producers who never got mail into the cooldown. (An injected
  // transport — tests — is the caller's responsibility.)
  if (opts.apply && !deps.sendRaw && !transportLive) {
    return finish({ skipped_reason: "transport_not_live" });
  }

  // N-A sweep — before any guard that can skip the day (a lane paused for
  // weeks must not let a possible contact age out of the ledger window
  // unrecorded). Bookkeeping only, never a send; apply runs only (a dry run
  // writes nothing). A failure is reported, never fatal: the ledger still
  // blocks those addresses for the window, and the next run retries.
  if (opts.apply) {
    try {
      sentLogReconciliation = reconcileRfbMarketingSentLog(db);
      if (sentLogReconciliation.failed > 0) {
        errors.push(`outreach_sent_log reconciliation failed for ${sentLogReconciliation.failed} ledger row(s) — retried next run`);
      }
    } catch (err) {
      sentLogReconciliation = { ...emptyRfbSentLogReconcileSummary(), failed: 1 };
      errors.push(`outreach_sent_log reconciliation unavailable: ${errMessage(err)} — retried next run`);
    }
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
        errors.push(`auto-pause write failed: ${errMessage(err)}`);
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
  const maxComposeAttempts = budget + RFB_MARKETING_EXTRA_COMPOSE_ATTEMPTS;
  const budgetInfo = {
    sent_today_before: sentToday.total,
    outreach_reserved_today: outreachReservedToday,
    budget,
    max_compose_attempts: maxComposeAttempts,
    health,
  };
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

  // From here on nothing throws out of the run: a failure becomes a result
  // row and/or a stopped_reason, and finish() still writes the envelope.
  const results: RfbMarketingResultRow[] = [];
  const held: RfbMarketingHeldEntry[] = [];
  const seenEmails = new Set<string>();
  let composeAttempts = 0;
  let committed = 0; // would_send (dry) or sent (apply) this run
  let stoppedReason: RfbMarketingStopReason | null = null;

  // Selection: the gate, unchanged. mode=first first; mode=second only for the
  // budget first-touch leaves unfilled (the SKILL's FILL-MODUS).
  const cooldownDays = resolveRfbMarketingGateCooldownDays();

  // Pre-send homepage refresh state (apply runs only — see the header).
  const refreshFn = deps.homepageRefresh ?? refreshRfbCandidateHomepage;
  const refreshFetch = deps.refreshFetchImpl ?? refreshFetchOverrideForTesting ?? undefined;
  const maxRefreshes = budget + RFB_MARKETING_EXTRA_REFRESHES;
  const perCandidateMs = deps.refreshLimits?.perCandidateMs ?? RFB_MARKETING_REFRESH_PER_CANDIDATE_MS;
  const totalBudgetMs = deps.refreshLimits?.totalBudgetMs ?? RFB_MARKETING_REFRESH_TOTAL_BUDGET_MS;
  let refreshDeadline: number | null = null; // set at the first refresh
  let refreshElapsedMs = 0;
  const refreshSummary: RfbMarketingRefreshSummary = {
    mode: opts.apply ? "applied" : "skipped_dry_run",
    per_candidate_ms: perCandidateMs,
    total_budget_ms: totalBudgetMs,
    max_refreshes: maxRefreshes,
    attempted: 0,
    refreshed: 0,
    unchanged: 0,
    hijacked: 0,
    failed: 0,
    timeout: 0,
    write_paused: 0,
    no_homepage: 0,
    skipped_refresh_budget: 0,
    by_field: {},
    elapsed_ms: 0,
  };
  // Never throws (refreshRfbCandidateHomepage catches everything; an injected
  // seam that throws is caught here) — a refresh can only ever be reported.
  const refreshCandidate = async (agentId: string): Promise<RfbHomepageRefreshRow> => {
    const nowMs = Date.now();
    if (refreshDeadline === null) refreshDeadline = nowMs + totalBudgetMs;
    let row: RfbHomepageRefreshRow;
    if (refreshSummary.attempted >= maxRefreshes || nowMs >= refreshDeadline) {
      row = { outcome: "skipped_refresh_budget", ms: 0 };
    } else {
      refreshSummary.attempted += 1;
      const deadlineAt = Math.min(nowMs + perCandidateMs, refreshDeadline);
      try {
        row = await refreshFn(db, agentId, { deadlineAt, fetchImpl: refreshFetch });
      } catch (err) {
        row = { outcome: "failed", error: `refresh_threw: ${errMessage(err)}`, ms: Date.now() - nowMs };
      }
      refreshElapsedMs += Date.now() - nowMs;
    }
    refreshSummary[row.outcome] += 1;
    for (const f of row.fields ?? []) refreshSummary.by_field[f] = (refreshSummary.by_field[f] ?? 0) + 1;
    refreshSummary.elapsed_ms = refreshElapsedMs;
    return row;
  };
  const gate: NonNullable<RfbMarketingDailyRunReport["gate"]> = { cooldown_days: cooldownDays, first: null, second: null };
  const done = (skipped: RfbMarketingDailyRunSkipReason | null) =>
    finish({
      ...budgetInfo,
      social_proof: socialProof,
      gate,
      results,
      held,
      compose_attempts: composeAttempts,
      stopped_reason: stoppedReason,
      skipped_reason: skipped,
      homepage_refresh: refreshSummary,
    });

  let firstGate: OutreachCandidatesResult;
  try {
    firstGate = computeOutreachCandidates(db, { mode: "first", cooldownDays, limit: RFB_MARKETING_CANDIDATE_FETCH_LIMIT });
  } catch (err) {
    errors.push(`gate (mode=first) failed: ${errMessage(err)}`);
    stoppedReason = "db_error";
    return done(null);
  }
  gate.first = summarizeGate(firstGate);
  if (firstGate.paused) {
    return done("outreach_paused");
  }

  type Precheck =
    | { kind: "skip"; row: RfbMarketingResultRow }
    | { kind: "ok"; row: RfbMarketingResultRow; profileUrl: string };
  type Examined =
    | { kind: "held"; row: RfbMarketingResultRow; entry: RfbMarketingHeldEntry }
    | { kind: "render_failed"; row: RfbMarketingResultRow }
    | { kind: "ready"; row: RfbMarketingResultRow; rendered: RfbOutreachRendered };

  // Read-only checks that need no fresh content — run BEFORE the refresh, so
  // only a candidate that is really next in line is crawled. A thrown error
  // here is a database problem (handled by the caller).
  const precheck = (cand: OutreachCandidate, touch: "first" | "second"): Precheck => {
    const email = String(cand.email ?? "").trim().toLowerCase();
    const row: RfbMarketingResultRow = { agent_id: cand.agent_id, name: cand.name, recipient_email: email, touch, status: "skipped" };
    if (!email || seenEmails.has(email)) return { kind: "skip", row: { ...row, reason: "duplicate_email_in_run" } };
    seenEmails.add(email);
    const ledgerBlock = ledgerBlocksRecipient(db, email, cand.agent_id, now, cooldownDays);
    if (ledgerBlock) return { kind: "skip", row: { ...row, reason: ledgerBlock } };
    const profile = resolveRfbCanonicalProfileUrl(cand.agent_id);
    if (!profile.ok) {
      return {
        kind: "skip",
        row: { ...row, reason: `profile_url_unavailable:${profile.reason}`, ...(profile.url ? { profile_url: profile.url } : {}) },
      };
    }
    row.profile_url = profile.url;
    return { kind: "ok", row, profileUrl: profile.url };
  };

  // Content check + render — AFTER the refresh, so both read what the
  // homepage says today. A thrown error is a database problem; render
  // failures come back as a value.
  const examine = (cand: OutreachCandidate, row: RfbMarketingResultRow, profileUrl: string): Examined => {
    const content = checkRfbProfileContent(db, cand.agent_id);
    if (!content.ok) {
      return {
        kind: "held",
        row: { ...row, reason: `held_for_reenrichment:${content.reason}`, description_length: content.description_length },
        entry: { agent_id: cand.agent_id, name: cand.name, reason: content.reason, description_length: content.description_length },
      };
    }
    let rendered: RfbOutreachRendered;
    try {
      rendered = renderRfbOutreachEmail({
        agentId: cand.agent_id,
        producerName: cand.name,
        profileUrl,
        producerCountTotal: producerCount,
      });
    } catch (err) {
      return { kind: "render_failed", row: { ...row, status: "error", reason: `render_failed: ${errMessage(err)}` } };
    }
    row.subject_variant = rendered.variant;
    row.subject = rendered.subject;
    return { kind: "ready", row, rendered };
  };

  // A possible contact the ledger knows about but outreach_sent_log may not
  // (N-A): reconcile now. A failure is left to the next run's sweep.
  const reconcileNow = (ledgerId: number, row: RfbMarketingResultRow, cand: OutreachCandidate): void => {
    try {
      row.sent_log_reconciled = reconcileRfbLedgerRowToSentLog(db, ledgerId).result;
    } catch (err) {
      row.sent_log_reconciled = "error";
      errors.push(`outreach_sent_log reconciliation failed for ${cand.agent_id}: ${errMessage(err)} — retried next run`);
    }
  };

  const stopOnDbError = (cand: OutreachCandidate, touch: "first" | "second", err: unknown): void => {
    const msg = errMessage(err);
    results.push({
      agent_id: cand.agent_id,
      name: cand.name,
      recipient_email: String(cand.email ?? "").trim().toLowerCase(),
      touch,
      status: "error",
      reason: `db_error: ${msg}`,
    });
    errors.push(`database error at ${cand.agent_id}: ${msg} — loop stopped`);
    stoppedReason = "db_error";
  };

  const processList = async (list: OutreachCandidate[], touch: "first" | "second"): Promise<void> => {
    for (const cand of list) {
      if (committed >= budget || stoppedReason) return;

      let pre: Precheck;
      try {
        pre = precheck(cand, touch);
      } catch (err) {
        stopOnDbError(cand, touch, err);
        return;
      }
      if (pre.kind === "skip") {
        results.push(pre.row);
        continue;
      }

      if (opts.apply) {
        // Only for a candidate that will really be attempted: the same two
        // stops the reservation path checks first are checked here too, so a
        // paused lane or a spent attempt cap never triggers a crawl.
        try {
          if (getRfbMarketingLaneState(db).paused) {
            stoppedReason = "paused_mid_run";
            return;
          }
        } catch (err) {
          stopOnDbError(cand, touch, err);
          return;
        }
        if (composeAttempts >= maxComposeAttempts) {
          stoppedReason = "attempt_cap_reached";
          return;
        }
        // Blocks only a hijacked homepage (owner decision 2026-09-29 «2 Ja»):
        // held like a content-quality hold — no reservation, no compose, no
        // send budget, no compose attempt. Every other outcome continues to
        // the content check with whatever content the profile now has.
        const refreshRow = await refreshCandidate(cand.agent_id);
        pre.row.homepage_refresh = refreshRow;
        if (refreshRow.outcome === "hijacked") {
          let length: number;
          try {
            length = rfbProfileProseLength(db, cand.agent_id);
          } catch (err) {
            stopOnDbError(cand, touch, err);
            return;
          }
          const detail = refreshRow.error ?? "theme_spam";
          results.push({ ...pre.row, reason: "held_for_reenrichment:hijacked_homepage", description_length: length });
          held.push({ agent_id: cand.agent_id, name: cand.name, reason: "hijacked_homepage", description_length: length, detail });
          continue;
        }
      }

      let exam: Examined;
      try {
        exam = examine(cand, pre.row, pre.profileUrl);
      } catch (err) {
        stopOnDbError(cand, touch, err);
        return;
      }
      if (exam.kind === "held") {
        results.push(exam.row);
        held.push(exam.entry);
        continue;
      }
      if (exam.kind === "render_failed") {
        // Nothing reserved, nothing sent — but the inputs are not what the
        // template describes; stop rather than guess.
        results.push(exam.row);
        stoppedReason = "render_failed";
        return;
      }
      const { row, rendered } = exam;

      if (!opts.apply) {
        results.push({ ...row, status: "would_send", preview_text: rendered.text });
        committed += 1;
        continue;
      }

      // Apply path. A pause set while this run is in flight takes effect
      // before the next reservation, not tomorrow.
      try {
        if (getRfbMarketingLaneState(db).paused) {
          stoppedReason = "paused_mid_run";
          return;
        }
      } catch (err) {
        stopOnDbError(cand, touch, err);
        return;
      }
      // Pre-transport refusals do not consume the budget; this bounds them.
      if (composeAttempts >= maxComposeAttempts) {
        stoppedReason = "attempt_cap_reached";
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
          email: row.recipient_email,
          touch,
          variant: rendered.variant,
        });
      } catch (err) {
        const msg = errMessage(err);
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

      composeAttempts += 1;
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
        const msg = errMessage(err);
        const threwRow: RfbMarketingResultRow = { ...row, status: "error", reason: `compose_threw: ${msg}`, ledger_status: "reserved", ledger_recorded: false };
        errors.push(`compose threw for ${cand.agent_id} (outcome unknown, ledger row left 'reserved'): ${msg}`);
        reconcileNow(reservation.ledgerId, threwRow, cand);
        results.push(threwRow);
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

      let ledgerStatus: "sent" | "unknown" | "refused" | "failed";
      if (outcome.delivery === "sent" && messageId === "DRY_RUN") {
        // Defense in depth behind G1b: the transport "sent" nothing. Not a send.
        ledgerStatus = "failed";
        row.status = "error";
        row.reason = "transport_dry_run";
        errors.push(
          `transport answered DRY_RUN for ${cand.agent_id} — nothing was delivered; run stopped ` +
            `(compose recorded it as sent, so its outreach_sent_log row holds this address in cooldown)`,
        );
        stoppedReason = "transport_not_live";
      } else if (outcome.delivery === "sent") {
        ledgerStatus = "sent";
        row.status = "sent";
        committed += 1;
        if (outcome.postSendError) {
          row.post_send_error = outcome.postSendError;
          errors.push(`post-send bookkeeping failed for ${cand.agent_id} (e-mail WAS sent): ${outcome.postSendError}`);
          stoppedReason = "post_send_record_failed";
        }
      } else if (outcome.transportAttempted) {
        // Handed to the transport and not confirmed: the server may have
        // accepted DATA before the connection dropped. AT MOST ONCE — count and
        // block it like a send, never retry it, never claim it; and stop here
        // instead of trying the next address on a transport that is failing.
        ledgerStatus = "unknown";
        row.status = "unknown";
        row.reason = `transport_failed:${composeError ?? outcome.httpStatus}`;
        errors.push(
          `transport did not confirm the send to ${cand.agent_id} (${composeError ?? outcome.httpStatus}) — ` +
            `possibly delivered: counted and blocked, never retried; loop stopped`,
        );
        stoppedReason = "transport_failed";
      } else if (outcome.httpStatus >= 400 && outcome.httpStatus < 500) {
        ledgerStatus = "refused";
        row.status = "refused";
        row.reason = `compose_refused:${composeError ?? outcome.httpStatus}`;
        if (outcome.httpStatus === 423) stoppedReason = "outreach_paused";
        else if (composeError === "daily_cap_reached") stoppedReason = "outreach_max_per_day_reached";
      } else {
        // Failed BEFORE the transport (a write inside compose): nothing was
        // sent, so a later day may retry it. The database is the likely cause.
        ledgerStatus = "failed";
        row.status = "error";
        row.reason = `compose_failed:${composeError ?? outcome.httpStatus}`;
        errors.push(`compose failed before the transport for ${cand.agent_id}: ${composeError ?? outcome.httpStatus}`);
        stoppedReason = "compose_error";
      }

      try {
        finalizeLedgerRow(db, reservation.ledgerId, {
          status: ledgerStatus,
          httpStatus: outcome.httpStatus,
          threadId,
          outboxId,
          messageId,
          error: outcome.postSendError ?? (ledgerStatus === "sent" ? null : row.reason ?? composeError),
          updatedAt: clock().toISOString(),
        });
        row.ledger_status = ledgerStatus;
        row.ledger_recorded = true;
      } catch (err) {
        // The row stays 'reserved': counted as sent, address blocked for the
        // cooldown window. Stop — the database is not accepting writes.
        const msg = errMessage(err);
        row.ledger_status = "reserved";
        row.ledger_recorded = false;
        errors.push(`ledger update failed for ${cand.agent_id} (row left 'reserved'): ${msg}`);
        if (!stoppedReason) stoppedReason = "ledger_update_failed";
      }
      // N-A at finalize time: an unknown delivery, a send whose post-send
      // bookkeeping failed, or a transport-invoked row whose outcome could
      // not be recorded. (A clean 'sent' is recorded by compose's trigger.)
      if (
        ledgerStatus === "unknown" ||
        (ledgerStatus === "sent" && outcome.postSendError) ||
        (row.ledger_recorded === false && outcome.transportAttempted)
      ) {
        reconcileNow(reservation.ledgerId, row, cand);
      }
      results.push(row);
    }
  };

  await processList(firstGate.candidates, "first");
  if (committed < budget && !stoppedReason) {
    let secondGate: OutreachCandidatesResult | null = null;
    try {
      secondGate = computeOutreachCandidates(db, {
        mode: "second",
        cooldownDays,
        limit: RFB_MARKETING_CANDIDATE_FETCH_LIMIT,
      });
    } catch (err) {
      errors.push(`gate (mode=second) failed: ${errMessage(err)}`);
      stoppedReason = "db_error";
    }
    if (secondGate) {
      gate.second = summarizeGate(secondGate);
      if (!secondGate.paused) await processList(secondGate.candidates, "second");
    }
  }

  const actionable = results.some((r) => r.status !== "skipped");
  const gateReturned = (gate.first?.count ?? 0) + (gate.second?.count ?? 0);
  return done(actionable || stoppedReason ? null : gateReturned > 0 ? "no_sendable_candidates" : "no_candidates");
}
