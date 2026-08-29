// ─── Admin: verifier claim-count endpoints ────────────────────
//
// dev-request 2026-08-29-verifier-claim-kind-katalog-gap: read-only admin
// surface so the platform-verifier routine can actually verify claim kinds
// that today are silently unverifiable (no query behind them at all).
//
//   GET /admin/verifier/claim-counts?kind=<kind>&since=<ISO-8601>&until=<ISO-8601>
//
// `kind` is a TYPED ALLOWLIST (switch statement below), never passthrough
// SQL built from the query string. Unknown kind -> 400.
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
// normalization being exact — every BETWEEN in whereForKind() wraps both
// sides in SQLite's datetime(...), which re-parses this string the same way
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

// Typed allowlist: each kind maps to ITS OWN fixed WHERE fragment against
// agent_knowledge (aliased k, joined to agents aliased a). `kind` only ever
// selects one of these literal strings via switch — nothing derived from
// the query string reaches SQL. Each fragment takes exactly two `?`
// placeholders (since, until, in that order).
//
// Every BETWEEN wraps BOTH the column and the bound placeholder in SQLite's
// datetime(...) — see the file-header footgun comment for why: it lets the
// comparison work uniformly whether the column's actual value is
// space-separated (datetime('now')) or JS-ISO ('T'/ms/'Z'), without needing
// to know which format any given row is in.
function whereForKind(kind: ClaimKind): string {
  switch (kind) {
    case "agents_verified":
      return `k.verification_status = 'verified' AND datetime(k.last_verified_at) BETWEEN datetime(?) AND datetime(?)`;
    case "agents_review_required":
      // updated_at imprecision — see file-header comment. Not a bug.
      return `k.verification_status = 'review_required' AND datetime(k.updated_at) BETWEEN datetime(?) AND datetime(?)`;
    case "agents_pending_verify":
      // updated_at imprecision — see file-header comment. Not a bug.
      return `k.verification_status = 'pending_verify' AND datetime(k.updated_at) BETWEEN datetime(?) AND datetime(?)`;
    case "agents_data_insufficient":
      // updated_at imprecision — see file-header comment. Not a bug.
      return `k.verification_status = 'data_insufficient' AND datetime(k.updated_at) BETWEEN datetime(?) AND datetime(?)`;
    case "http_unreachable":
      return `datetime(k.homepage_unreachable_since) BETWEEN datetime(?) AND datetime(?)`;
    case "brreg_inactive_flagged":
      // updated_at imprecision — see file-header comment. Not a bug.
      return `json_extract(k.verification_review_reason,'$.terminal_reason') = 'brreg_inactive' AND datetime(k.updated_at) BETWEEN datetime(?) AND datetime(?)`;
    case "agents_domain_incoherent":
      // Real enum values written by stampParking() in admin-domain-coherence.ts
      // — confirmed by reading that file, not invented.
      return `k.domain_reconciliation_outcome IN ('circular_scramble_candidate','manual_review_needed') AND datetime(k.domain_reconciliation_checked_at) BETWEEN datetime(?) AND datetime(?)`;
  }
}

// GET /admin/verifier/claim-counts?kind=<kind>&since=<ISO-8601>&until=<ISO-8601>
//
// Returns the count of agents matching `kind` within [since, until]
// (inclusive both ends — plain SQL BETWEEN semantics), plus up to 5 sample
// rows for the verifier to spot-check evidence against. Only agents.is_active
// = 1 rows are counted, matching the /api/marketplace/admin/agents/dump
// convention in marketplace.ts.
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const kindRaw = String(req.query.kind ?? "");
  if (!(KNOWN_KINDS as readonly string[]).includes(kindRaw)) {
    res.status(400).json({ success: false, error: `unknown kind: ${kindRaw}` });
    return;
  }
  const kind = kindRaw as ClaimKind;

  const since = parseSinceUntil(req.query.since);
  if (since === null) {
    res.status(400).json({ success: false, error: "since is required and must be a parseable ISO-8601 timestamp" });
    return;
  }
  const until = parseSinceUntil(req.query.until);
  if (until === null) {
    res.status(400).json({ success: false, error: "until is required and must be a parseable ISO-8601 timestamp" });
    return;
  }

  try {
    const db = getDb();
    const where = whereForKind(kind);

    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM agent_knowledge k
           INNER JOIN agents a ON a.id = k.agent_id
          WHERE a.is_active = 1 AND ${where}`
      )
      .get(since, until) as { c: number } | undefined;

    const sampleRows = db
      .prepare(
        `SELECT a.id AS id, a.name AS name
           FROM agent_knowledge k
           INNER JOIN agents a ON a.id = k.agent_id
          WHERE a.is_active = 1 AND ${where}
          ORDER BY a.id
          LIMIT 5`
      )
      .all(since, until) as Array<{ id: string; name: string }>;

    res.json({
      success: true,
      kind,
      count: countRow?.c ?? 0,
      // Echo the NORMALIZED (DB-comparable) since/until actually used in the
      // BETWEEN clause, not the raw query string — this is what the count
      // and sample above were computed against, so a verifier reading this
      // response back can't be misled by a raw ISO string that looks
      // different from what the SQL actually compared.
      since,
      until,
      sample: sampleRows,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
