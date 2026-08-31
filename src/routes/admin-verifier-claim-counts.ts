// ─── Admin: verifier claim-count endpoints ────────────────────
//
// dev-request 2026-08-29-verifier-claim-kind-katalog-gap: read-only admin
// surface so the platform-verifier routine can actually verify claim kinds
// that today are silently unverifiable (no query behind them at all).
//
//   GET /admin/verifier/claim-counts?kind=<kind>&since=<ISO-8601>&until=<ISO-8601>
//   GET /admin/verifier/claim-counts?kind=<kind>&mode=snapshot
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
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
