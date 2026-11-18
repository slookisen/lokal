// ─── Admin: verifier claim-count endpoints ────────────────────
//
// dev-request 2026-08-29-verifier-claim-kind-katalog-gap: read-only admin
// surface so the platform-verifier routine can actually verify claim kinds
// that today are silently unverifiable (no query behind them at all).
//
//   GET /admin/verifier/claim-counts?kind=<kind>&since=<ISO-8601>&until=<ISO-8601>
//   GET /admin/verifier/claim-counts?kind=<kind>&mode=snapshot
//   GET /admin/verifier/claim-counts?kind=<queue kind>&mode=snapshot&drift_since=<ISO-8601>
//
// `kind` is a TYPED ALLOWLIST (switch statement below), never passthrough
// SQL built from the query string. Unknown kind -> 400.
//
// `mode` (optional, default "delta"):
//   - "delta" (default, omitted == this): unchanged from the original
//     endpoint — since/until are REQUIRED and every kind's WHERE fragment
//     filters on its timestamp column being inside [since, until], via
//     `datetime(col) BETWEEN datetime(?) AND datetime(?)`. This is the
//     original behavior verbatim; nothing about it changed for this mode.
//   - "snapshot": counts agents CURRENTLY in the given state — no time
//     filter at all. since/until are not required and, if supplied
//     anyway, are ignored (not parsed, not bound, not echoed). Added by
//     dev-request 2026-08-31-lokal-agent-verifier-claim-counts-snapshot-
//     delta-mismatch (see A2A repo): for most kinds, "claimed" values the
//     lokal-agent-verifier routine reports are CURRENT-STATE snapshots,
//     but the old delta-only endpoint filtered on a last-write timestamp
//     that predates the routine's narrow run window, so it returned 0 even
//     when the true current count was nonzero. See KIND_SPEC below — the
//     same `condition` fragment backs both modes; snapshot mode just
//     drops the time filter.
//   - any other value -> 400.
//
// Auth: X-Admin-Key, same convention as every other admin-*.ts file in this
// codebase — inline getAdminKey()/requireAdmin(), duplicated per file by
// convention rather than imported from a shared helper (see
// admin-outreach-pool.ts).
//
// Timestamp footgun (see admin-domain-coherence.ts's stampParking() comment
// for the original incident this mirrors): the timestamp columns this route
// reads are NOT written consistently. Only domain_reconciliation_checked_at
// (via stampParking() in admin-domain-coherence.ts) is actually written via
// SQLite's own datetime('now') (space-separated "YYYY-MM-DD HH:MM:SS", no
// 'T', no ms, no 'Z'). The others are written as full JS ISO-8601 strings
// (new Date().toISOString(), 'T'-separated, with milliseconds and a 'Z') at
// most of their call sites — last_verified_at (lokal-agent-verifier.ts),
// homepage_unreachable_since (admin-knowledge.ts, marketplace.ts) — and
// updated_at is WORSE: mixed, depending on which code path last touched the
// row (some sites use JS-ISO, others literal datetime('now')), so a given
// row's format can't be assumed from its column alone.
//
// A raw string BETWEEN comparing two different formats is unsafe: SQLite's
// default collation sorts 'T' (0x54) above ' ' (0x20), so a JS-ISO value
// compared against a space-separated bound silently sorts as "later than it
// should be" and can be excluded from a same-day window. Rather than track
// which format each column/row is in, both sides of every BETWEEN below are
// wrapped in SQLite's own datetime(...) function (`datetime(col) BETWEEN
// datetime(?) AND datetime(?)`), which parses both the space-separated and
// 'T'/ms/'Z' ISO-8601 forms and normalizes each to the same canonical
// "YYYY-MM-DD HH:MM:SS" text before comparing — so the comparison is correct
// regardless of which format any given row (or the incoming since/until)
// happens to be in. Verified against this repo's actual better-sqlite3
// engine in admin-verifier-claim-counts.test.ts, including a same-day/
// same-hour JS-ISO fixture that reproduces the original bug.
//
// Known, documented imprecision — NOT a bug to "fix" here: kinds 2-4
// (agents_review_required / agents_pending_verify / agents_data_insufficient)
// and brreg_inactive_flagged key off agent_knowledge.updated_at, a general
// last-write column, not a per-status-transition timestamp. A row touched
// for an unrelated reason (e.g. a different field edited) while it happens
// to sit in that status can overcount. Real and bounded, called out inline
// on each affected case below.
//
// agents_verified, delta mode — event-based (dev-request 2026-11-11-verifier-
// ny-verifisering-og-delta-ledd, slice B): the lokal-agent-verifier's
// `agents_verified` claim is "results THIS run set to verified". The original
// delta query (current verification_status='verified' AND current
// last_verified_at inside the window) measured "still verified with this exact
// stamp" instead: applyVerifierOutcome overwrites last_verified_at (and the
// status) every time a later hourly run, review-queue run or bulk sweep
// re-processes the row, so the older a run, the fewer of its rows still
// matched (observed: claimed 8-9 per run, probed 0-9). A tolerance would only
// hide that, so instead applyVerifierOutcome now appends one row per verified
// outcome to verifier_verified_events (agent_id, run_started_at), and delta
// mode for this one kind counts those events whose run_started_at is inside
// [since, until] — one per (agent_id, run_started_at) pair, i.e. per agent
// per run, which is exactly what the claim sums. The events are historical
// facts, so they are NOT filtered on the agent's current is_active (a later
// deactivation must not shrink what a past run did). Sample rows come from the
// same events (LEFT JOIN agents for the name). Response shape is unchanged.
//
// Fallback: windows that start before the first event ever recorded (i.e.
// runs from before this table was deployed, or an empty/absent table) use the
// original current-state query unchanged — see agentsVerifiedUsesEvents().
// A run that verified >=1 agent always has an event stamped at exactly its
// own started_at (== since), so any post-deploy run with a non-zero claim is
// always probed via events. Snapshot mode and every other kind are untouched.
//
// Snapshot drift (dev-request 2026-10-26-lokal-agent-verifier-snapshot-
// drift-toleranse, slices 4 + 5): the lokal-agent-verifier reads the queue
// counts (agents_pending_verify / agents_review_required /
// agents_data_insufficient) at run time and posts the read time as claim
// meta.read_at; platform-verifier probes 10-12 h later, and real writes move
// the queues by 3-6 in between. A fixed +-N is the wrong shape (the drift
// follows the number of writes, not time). Since slice 4 every change to queue
// membership is logged in agent_queue_state_events (trigger-fed, see init.ts),
// so mode=snapshot takes an optional `drift_since=<ISO>` (the claim's read_at)
// and then also returns:
//   - `count_at_read` (slice 5): the queue count rebuilt as of drift_since.
//     Start from count_now, take out every agent with a logged change at/after
//     drift_since that is in the queue now, and add back every such agent
//     whose EARLIEST change at/after drift_since (MIN(id)) has its old side in
//     the queue (old_status = <status> AND old_active = 1, the snapshot
//     count's own predicate; an INSERT has old_status NULL, i.e. not in the
//     queue). Agents without a
//     logged change since drift_since are in the queue now iff they were then.
//     The probe compares the claim to this with +-2 (the +-2 absorbs a write
//     committed by another connection across the read).
//   - `drift_bound` (slice 4, kept as diagnostics): distinct agents that
//     entered or left the queue at/after drift_since. It is a GROSS bound (A
//     out + B in = net 0 but bound 2) and only the fallback when count_at_read
//     is null.
// See snapshotDriftDecision() for the rule. drift_since is normalized to the
// exact text format the triggers write ("YYYY-MM-DD HH:MM:SS.SSS", UTC, ms
// kept) and compared as a raw string, so the changed_at index is used and no
// event from before the read leaks in through rounding. Events older than
// DRIFT_LOG_RETENTION_DAYS are pruned at boot (init.ts); a drift_since older
// than that returns count_at_read and drift_bound null, and so does an
// unreadable log — the caller then keeps the fixed +-2 rule. It is a separate
// parameter, not `since`, because mode=snapshot has always ignored a supplied
// since/until and that contract (and every response without drift_since) is
// unchanged. Only the kinds in QUEUE_STATUS_FOR_KIND (the three queues, plus
// agents_verified, which no probe uses) are supported; any other kind with
// drift_since -> 400. In delta mode drift_since is ignored, even when invalid.
//
// Non-goals (out of scope for this slice — dev-request 2026-08-29-verifier-
// claim-kind-katalog-gap): outreach_pool_added, lokal_prs_conflict_rebased,
// active_escalations have no endpoint here — don't invent one.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ success: false, error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ success: false, error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// Normalizes an incoming since/until query value to a canonical
// space-separated, no-ms, no-Z, UTC "YYYY-MM-DD HH:MM:SS" form for the JSON
// response echo (see the response payload below) and as the value bound
// into the query. The DB-side comparison itself does not depend on this
// normalization being exact — every delta-mode BETWEEN built in buildQuery()
// wraps both sides in SQLite's datetime(...), which re-parses this string the same way
// it parses each column's own value (space-separated or JS-ISO), so both
// sides land in the same canonical form before comparing regardless. See the
// file-header footgun comment. Returns null for missing/non-string/
// unparseable input, which the route turns into a 400.
function parseSinceUntil(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// drift_since: same parse, but kept to the millisecond and in the exact text
// format agent_queue_state_events.changed_at is written in
// (strftime('%Y-%m-%d %H:%M:%f','now') -> "YYYY-MM-DD HH:MM:SS.SSS"), so a
// raw string `changed_at >= ?` is a correct comparison and uses the index.
function parseDriftSince(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace("T", " ");
}

const KNOWN_KINDS = [
  "agents_verified",
  "agents_review_required",
  "agents_pending_verify",
  "agents_data_insufficient",
  "http_unreachable",
  "brreg_inactive_flagged",
  "agents_domain_incoherent",
] as const;
type ClaimKind = (typeof KNOWN_KINDS)[number];

const KNOWN_MODES = ["delta", "snapshot"] as const;
type ClaimMode = (typeof KNOWN_MODES)[number];

// Typed allowlist: each kind maps to ITS OWN fixed status/condition
// fragment plus the timestamp column its delta-mode window filters on,
// against agent_knowledge (aliased k, joined to agents aliased a). `kind`
// only ever selects one of these literal entries via KIND_SPEC[kind] —
// nothing derived from the query string reaches SQL.
//
// `condition` is the state-only part of the WHERE clause (no time filter)
// — this is exactly what mode=snapshot uses standalone ("currently in this
// state"). mode=delta additionally ANDs a datetime(...) BETWEEN over
// `timeColumn`, taking exactly two `?` placeholders (since, until, in that
// order) — see buildQuery() below. Every BETWEEN wraps BOTH the column and
// the bound placeholder in SQLite's datetime(...) — see the file-header
// footgun comment for why: it lets the comparison work uniformly whether
// the column's actual value is space-separated (datetime('now')) or
// JS-ISO ('T'/ms/'Z'), without needing to know which format any given row
// is in.
const KIND_SPEC: Record<ClaimKind, { condition: string; timeColumn: string }> = {
  agents_verified: {
    condition: `k.verification_status = 'verified'`,
    timeColumn: `k.last_verified_at`,
  },
  agents_review_required: {
    // updated_at imprecision — see file-header comment. Not a bug.
    condition: `k.verification_status = 'review_required'`,
    timeColumn: `k.updated_at`,
  },
  agents_pending_verify: {
    // updated_at imprecision — see file-header comment. Not a bug.
    condition: `k.verification_status = 'pending_verify'`,
    timeColumn: `k.updated_at`,
  },
  agents_data_insufficient: {
    // updated_at imprecision — see file-header comment. Not a bug.
    condition: `k.verification_status = 'data_insufficient'`,
    timeColumn: `k.updated_at`,
  },
  http_unreachable: {
    // NULL means "currently reachable" (cleared on a successful fetch —
    // see admin-knowledge.ts / marketplace.ts); IS NOT NULL is the
    // "currently in this state" condition mode=snapshot needs. Harmless
    // in mode=delta too: datetime(NULL) BETWEEN ... is already NULL
    // (falsy), so ANDing this in changes no delta-mode result — same rows
    // matched before this fragment existed.
    condition: `k.homepage_unreachable_since IS NOT NULL`,
    timeColumn: `k.homepage_unreachable_since`,
  },
  brreg_inactive_flagged: {
    // updated_at imprecision — see file-header comment. Not a bug.
    condition: `json_extract(k.verification_review_reason,'$.terminal_reason') = 'brreg_inactive'`,
    timeColumn: `k.updated_at`,
  },
  agents_domain_incoherent: {
    // Real enum values written by stampParking() in admin-domain-coherence.ts
    // — confirmed by reading that file, not invented.
    condition: `k.domain_reconciliation_outcome IN ('circular_scramble_candidate','manual_review_needed')`,
    timeColumn: `k.domain_reconciliation_checked_at`,
  },
};

// Builds the WHERE fragment (state condition, plus a delta-mode time
// filter) AND the exact bind-params array to spread into `.get(...params)`/
// `.all(...params)` — snapshot-mode fragments take 0 placeholders,
// delta-mode fragments take 2 (since, until), so the params array must
// match whatever fragment is actually returned.
function buildQuery(
  kind: ClaimKind,
  mode: ClaimMode,
  since: string | null,
  until: string | null,
): { where: string; params: unknown[] } {
  const spec = KIND_SPEC[kind];
  if (mode === "snapshot") {
    return { where: spec.condition, params: [] };
  }
  return {
    where: `${spec.condition} AND datetime(${spec.timeColumn}) BETWEEN datetime(?) AND datetime(?)`,
    params: [since, until],
  };
}

// Snapshot kinds whose count is `a.is_active = 1 AND k.verification_status =
// <status>`, i.e. fully determined by the two columns the
// agent_queue_state_events triggers log. Only these support drift_since.
// Fixed literals; the status is bound as a parameter, never interpolated.
const QUEUE_STATUS_FOR_KIND: Partial<Record<ClaimKind, string>> = {
  agents_verified: "verified",
  agents_review_required: "review_required",
  agents_pending_verify: "pending_verify",
  agents_data_insufficient: "data_insufficient",
};

// Events older than this are pruned at boot (init.ts). A drift_since older
// than the horizon may miss pruned events, so both derived values are null.
export const DRIFT_LOG_RETENTION_DAYS = 14;
export function driftSinceWithinRetention(driftSince: string, nowMs: number = Date.now()): boolean {
  const t = new Date(driftSince.replace(" ", "T") + "Z").getTime();
  return !Number.isNaN(t) && t >= nowMs - DRIFT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

// Distinct agents with a logged change at/after drift_since where either side
// of the change was (possibly) in the queue. A NULL is_active means "agent row
// not visible to the trigger" (e.g. FK cascade order) and is treated as active,
// which can only widen the bound. drift_since is in changed_at's own text
// format (parseDriftSince), so the raw comparison uses the changed_at index.
const DRIFT_BOUND_SQL = `SELECT COUNT(DISTINCT agent_id) AS c
       FROM agent_queue_state_events
      WHERE changed_at >= ?
        AND ((old_status = ? AND COALESCE(old_active, 1) = 1)
          OR (new_status = ? AND COALESCE(new_active, 1) = 1))`;

export function getSnapshotDriftBound(db: any, status: string, driftSince: string): number | null {
  try {
    const row = db.prepare(DRIFT_BOUND_SQL).get(driftSince, status, status) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return null;
  }
}

// count_at_read pieces (see file-header comment):
//   in_now  = agents with >=1 event at/after drift_since that are in the queue
//             now — the exact membership predicate of the snapshot count
//             (agent_knowledge JOIN agents, a.is_active = 1, status);
//   in_then = agents whose earliest event at/after drift_since (MIN(id)) had
//             its old side in the queue: old_status = <status> AND
//             old_active = 1 — the same predicate as the snapshot count
//             (a NULL is_active or a missing agents row is not counted there).
//             Unlike DRIFT_BOUND_SQL (which may over-count), no COALESCE: an
//             agent delete logs the real is_active first (trg_aqse_agents_del
//             is BEFORE DELETE), so a NULL old_active as the EARLIEST event
//             only comes from a knowledge row with no agents row (an orphan,
//             FK off), which the snapshot count never included.
const COUNT_AT_READ_SQL = `SELECT
       (SELECT COUNT(*)
          FROM agent_knowledge k
          INNER JOIN agents a ON a.id = k.agent_id
         WHERE a.is_active = 1 AND k.verification_status = ?
           AND k.agent_id IN (SELECT agent_id FROM agent_queue_state_events WHERE changed_at >= ?)) AS in_now,
       (SELECT COUNT(*)
          FROM agent_queue_state_events e
         WHERE e.id IN (SELECT MIN(id) FROM agent_queue_state_events
                         WHERE changed_at >= ? GROUP BY agent_id)
           AND e.old_status = ? AND e.old_active = 1) AS in_then`;

export function getSnapshotCountAtRead(
  db: any,
  status: string,
  driftSince: string,
  countNow: number,
): number | null {
  try {
    const row = db.prepare(COUNT_AT_READ_SQL).get(status, driftSince, driftSince, status) as
      | { in_now: number; in_then: number }
      | undefined;
    if (!row) return null;
    return countNow - row.in_now + row.in_then;
  } catch {
    return null;
  }
}

// The probe's decision rule for the three queue snapshot kinds, as a pure
// function so it can be tested against the observed failure shape:
//   1. count_at_read numeric -> |count_at_read - claim| <= 2 (exact rebuild;
//      a wide drift_bound can no longer hide a real mismatch);
//   2. else drift_bound numeric -> |count - claim| <= max(2, drift_bound);
//   3. else (older envelopes without meta.read_at, log unreadable, or
//      drift_since past the retention horizon) the slice-1 fixed +-2 rule.
export const SNAPSHOT_DRIFT_MIN_TOLERANCE = 2;
export function snapshotDriftDecision(
  claimValue: number,
  count: number,
  driftBound: number | null | undefined,
  countAtRead?: number | null,
): { matched: boolean; diff: number; tolerance: number } {
  if (typeof countAtRead === "number") {
    const diff = Math.abs(countAtRead - claimValue);
    return { matched: diff <= SNAPSHOT_DRIFT_MIN_TOLERANCE, diff, tolerance: SNAPSHOT_DRIFT_MIN_TOLERANCE };
  }
  const diff = Math.abs(count - claimValue);
  const tolerance =
    typeof driftBound === "number" && driftBound > SNAPSHOT_DRIFT_MIN_TOLERANCE
      ? driftBound
      : SNAPSHOT_DRIFT_MIN_TOLERANCE;
  return { matched: diff <= tolerance, diff, tolerance };
}

function driftFields(db: any, status: string, driftSince: string, countNow: number) {
  if (!driftSinceWithinRetention(driftSince)) {
    return { drift_since: driftSince, drift_bound: null, count_at_read: null };
  }
  return {
    drift_since: driftSince,
    drift_bound: getSnapshotDriftBound(db, status, driftSince),
    count_at_read: getSnapshotCountAtRead(db, status, driftSince, countNow),
  };
}

// agents_verified delta mode (see file-header comment): count/sample from the
// append-only verifier_verified_events log, one per (agent_id, run_started_at)
// pair whose run_started_at lies inside [since, until]. Fixed SQL, two bound
// placeholders — nothing from the query string reaches SQL.
const VERIFIED_EVENTS_IN_WINDOW = `SELECT DISTINCT agent_id, run_started_at
       FROM verifier_verified_events
      WHERE datetime(run_started_at) BETWEEN datetime(?) AND datetime(?)`;

// True when the events log covers the window: at least one event exists and
// the earliest one is at or before `since`. Otherwise (table absent, empty, or
// the window predates the first recorded event — i.e. pre-deploy runs) the
// caller falls back to the original current-state delta query.
function agentsVerifiedUsesEvents(db: any, since: string): boolean {
  try {
    const row = db
      .prepare(`SELECT MIN(datetime(run_started_at)) AS m, datetime(?) AS s FROM verifier_verified_events`)
      .get(since) as { m: string | null; s: string | null } | undefined;
    return !!row && row.m !== null && row.s !== null && row.m <= row.s;
  } catch {
    return false;
  }
}

// dev-request 2026-10-09-lokal-agent-verifier-batch-claim-vs-snapshot-probe-
// mismatch: current-state (mode=snapshot) counts for the snapshot-semantic
// claim kinds, computed with the SAME condition + is_active filter the
// endpoint uses, so a run-envelope claim built from these is comparable to
// platform-verifier's `claim-counts?mode=snapshot` probe by construction.
// `agents_verified` is deliberately absent: it is a per-run delta claim.
export const SNAPSHOT_CLAIM_KINDS = [
  "agents_review_required",
  "agents_pending_verify",
  "agents_data_insufficient",
  "http_unreachable",
  "brreg_inactive_flagged",
  "agents_domain_incoherent",
] as const;
export type SnapshotClaimKind = (typeof SNAPSHOT_CLAIM_KINDS)[number];

export function getSnapshotClaimCounts(db: any): Partial<Record<SnapshotClaimKind, number>> {
  const out: Partial<Record<SnapshotClaimKind, number>> = {};
  for (const kind of SNAPSHOT_CLAIM_KINDS) {
    const { where, params } = buildQuery(kind, "snapshot", null, null);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM agent_knowledge k
           INNER JOIN agents a ON a.id = k.agent_id
          WHERE a.is_active = 1 AND ${where}`
      )
      .get(...params) as { c: number } | undefined;
    out[kind] = row?.c ?? 0;
  }
  return out;
}

// GET /admin/verifier/claim-counts?kind=<kind>&since=<ISO-8601>&until=<ISO-8601>[&mode=delta|snapshot]
//
// mode=delta (default/omitted): returns the count of agents matching `kind`
// within [since, until] (inclusive both ends — plain SQL BETWEEN
// semantics). mode=snapshot: returns the count of agents CURRENTLY
// matching `kind`, no time window (since/until in the response are null).
// Either way, up to 5 sample rows come back for the verifier to spot-check
// evidence against. Only agents.is_active = 1 rows are counted, matching
// the /api/marketplace/admin/agents/dump convention in marketplace.ts.
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const kindRaw = String(req.query.kind ?? "");
  if (!(KNOWN_KINDS as readonly string[]).includes(kindRaw)) {
    res.status(400).json({ success: false, error: `unknown kind: ${kindRaw}` });
    return;
  }
  const kind = kindRaw as ClaimKind;

  // mode: optional, defaults to "delta" (== the original, unchanged
  // behavior) when omitted from the query string entirely. Any other
  // value (not "delta", not "snapshot") -> 400, same pattern as the
  // unknown-kind 400 above.
  const modeRaw = req.query.mode === undefined ? "delta" : String(req.query.mode);
  if (!(KNOWN_MODES as readonly string[]).includes(modeRaw)) {
    res.status(400).json({ success: false, error: `unknown mode: ${modeRaw}` });
    return;
  }
  const mode = modeRaw as ClaimMode;

  // mode=delta (default): since/until are REQUIRED, exactly as before this
  // change — this branch is untouched from the original endpoint so every
  // pre-existing 400 test for missing/malformed since/until still hits it.
  // mode=snapshot: since/until are NOT parsed or required at all; any
  // caller-supplied values are ignored (see buildQuery()/response below).
  let since: string | null = null;
  let until: string | null = null;
  // drift_since (snapshot mode only, optional): see file-header comment.
  // Absent -> nothing about the snapshot response changes.
  let driftSince: string | null = null;
  let driftStatus: string | null = null;
  if (mode === "snapshot" && req.query.drift_since !== undefined) {
    driftStatus = QUEUE_STATUS_FOR_KIND[kind] ?? null;
    if (driftStatus === null) {
      res.status(400).json({ success: false, error: `drift_since is not supported for kind: ${kind}` });
      return;
    }
    driftSince = parseDriftSince(req.query.drift_since);
    if (driftSince === null) {
      res.status(400).json({ success: false, error: "drift_since must be a parseable ISO-8601 timestamp" });
      return;
    }
  }
  if (mode === "delta") {
    since = parseSinceUntil(req.query.since);
    if (since === null) {
      res.status(400).json({ success: false, error: "since is required and must be a parseable ISO-8601 timestamp" });
      return;
    }
    until = parseSinceUntil(req.query.until);
    if (until === null) {
      res.status(400).json({ success: false, error: "until is required and must be a parseable ISO-8601 timestamp" });
      return;
    }
  }

  try {
    const db = getDb();

    if (kind === "agents_verified" && mode === "delta" && agentsVerifiedUsesEvents(db, since as string)) {
      const evCount = db
        .prepare(`SELECT COUNT(*) AS c FROM (${VERIFIED_EVENTS_IN_WINDOW})`)
        .get(since, until) as { c: number } | undefined;
      const evSample = db
        .prepare(
          `SELECT ev.agent_id AS id, a.name AS name
             FROM (SELECT DISTINCT agent_id FROM (${VERIFIED_EVENTS_IN_WINDOW})) ev
             LEFT JOIN agents a ON a.id = ev.agent_id
            ORDER BY ev.agent_id
            LIMIT 5`
        )
        .all(since, until) as Array<{ id: string; name: string }>;
      res.json({
        success: true,
        kind,
        mode,
        count: evCount?.c ?? 0,
        since,
        until,
        sample: evSample,
      });
      return;
    }

    const { where, params } = buildQuery(kind, mode, since, until);

    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM agent_knowledge k
           INNER JOIN agents a ON a.id = k.agent_id
          WHERE a.is_active = 1 AND ${where}`
      )
      .get(...params) as { c: number } | undefined;

    const sampleRows = db
      .prepare(
        `SELECT a.id AS id, a.name AS name
           FROM agent_knowledge k
           INNER JOIN agents a ON a.id = k.agent_id
          WHERE a.is_active = 1 AND ${where}
          ORDER BY a.id
          LIMIT 5`
      )
      .all(...params) as Array<{ id: string; name: string }>;

    res.json({
      success: true,
      kind,
      mode,
      count: countRow?.c ?? 0,
      // Echo the NORMALIZED (DB-comparable) since/until actually used in the
      // BETWEEN clause, not the raw query string — this is what the count
      // and sample above were computed against, so a verifier reading this
      // response back can't be misled by a raw ISO string that looks
      // different from what the SQL actually compared. In mode=snapshot no
      // window was used at all, so these are null rather than an invented
      // or misleadingly-echoed value.
      since,
      until,
      sample: sampleRows,
      ...(driftSince !== null && driftStatus !== null
        ? driftFields(db, driftStatus, driftSince, countRow?.c ?? 0)
        : {}),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
