// ─── POST /admin/agents/pending-verify-unpark ────────────────────────────────
//
// dev-requests/2026-09-01-rfb-pending-verify-unpark-lever.md. A targeted admin
// lever to release individual `pending_verify` rows from the 30-day parking
// mechanism (`pending_verify_parked_since`, stamped in applyVerifierOutcome —
// src/agents/lokal-agent-verifier.ts:862-872 — after 3 consecutive no-progress
// re-verify sweeps, and excluded from pickPendingVerifyBatch's selection there
// at lines 460-480) BEFORE the 30-day backoff naturally expires.
//
// Problem this closes: the only existing escape from parking is the
// all-or-nothing env flag PENDING_VERIFY_PARKING_DISABLED=true, which requires
// a deploy and unparks EVERY parked row regardless of whether any of them
// received new data. That defeats the point of parking (it exists to stop the
// sweep wasting cycles on rows proven unresolvable by re-verification alone —
// see the dev-request's measured 793/962 pending_verify rows parked,
// 0 naturally expired). This route mirrors the analogous, already-shipped
// lever for the geocode worker's own parking mechanism — unparkAgentsGeocode
// (src/services/agents-geocode-worker.ts:692) and its route
// POST /admin/agents/geocode-batch's `unpark` flag (src/routes/marketplace.ts,
// ~line 7223) — same dry-run-by-default / count-then-write shape, adapted to
// this mechanism's own eligibility rule.
//
// Freshness filter (the actual point of this route, not just "unpark
// everything early"): a parked row is only unparked in COHORT mode (no
// `agentIds` — an admin-picked limit/batch) when it has demonstrably received
// NEW data since it was parked:
//   agent_knowledge.data_enriched_at > agent_knowledge.pending_verify_parked_since
// Without this filter, an early bulk unpark is just a second round of wasted
// sweep cycles on the exact same unresolvable rows parking was built to
// protect against.
//
// Why `data_enriched_at`, not `agent_knowledge.updated_at` (revised
// 2026-09-02, dev-request 2026-09-01-rfb-pending-verify-unpark-lever build
// log, Daniel Alternativ B): the original spec proposed `updated_at` as the
// freshness signal, but 3 independent code-review rounds on this route's own
// build found `updated_at` is NOT a reliable platform-wide "this row's
// content genuinely changed" signal — at least 3 separate write sites
// (marketplace.ts's google-rating-batch and homepage-provenance-batch,
// admin-search-enrich.ts) were stamping it UNCONDITIONALLY on no-op calls
// (a re-scrape that found nothing new, a repeated already-on-file value).
// A freshness filter built on that column would have falsely admitted rows
// that received zero new data — exactly the wasted-cycle problem parking
// exists to prevent. Daniel chose a dedicated, non-overloaded column instead
// of auditing/patching every current and future `updated_at` write site
// platform-wide: `data_enriched_at` is stamped ONLY by an explicit, curated
// list of write sites (admin-agents-contact-email-write.ts,
// admin-agents-url-write.ts, admin-rfb-contact-extraction.ts,
// admin-agents.ts's applyAgentBrregContact, search-enrich-sweep.ts, and the
// two genuine-write branches of marketplace.ts's google-rating-batch /
// homepage-provenance-batch) — each gated so a no-op call never touches it
// (regression-tested per site). Pre-existing rows that received real writes
// before this column existed are covered by a one-time backfill in
// src/database/init.ts (MAX(agent_knowledge_audit.changed_at) per agent_id).
//
// `agentIds` mode (explicit admin selection) OVERRIDES the freshness filter —
// the admin is being explicit, so a stale/unresolvable row named by id is
// still force-unparked — but every requested id's freshness state is still
// reported per-row (`freshnessMet: false` for a forced stale row) so the
// caller can see exactly which ones were force-unparked without fresh data
// backing the decision.
//
// Effect per unparked row (touches NO other column):
//   pending_verify_parked_since     = NULL
//   pending_verify_no_progress_count = 0
// NULL trivially satisfies pickPendingVerifyBatch's own exclusion clause
// (`k.pending_verify_parked_since IS NULL OR k.pending_verify_parked_since
// <= datetime('now','-30 days')`), so an unparked row is immediately
// selectable again by the next sweep — same effect a natural 30-day expiry
// would have produced, just early and only for rows that earned it.
//
// Eligibility gate common to both modes: a row is only ever a candidate if it
// is CURRENTLY parked (`pending_verify_parked_since IS NOT NULL`) — there is
// nothing to unpark otherwise.
//
// Response semantics: `dry_run` (apply omitted or not === true) never writes —
// `candidates`/`unparked` report what WOULD happen (mirrors
// unparkAgentsGeocode(dryRun)'s "count without writing" convention) and every
// row's `applied` is false. Under `apply: true`, the same rows are actually
// written and their `applied` flips to true. `candidates` and `unparked` are
// deliberately two different numbers: `candidates` is how many rows are
// eligible to be unparked (post freshness-filter in cohort mode; post
// currently-parked-check in agentIds mode, freshness override notwithstanding);
// `unparked` is how many rows this call actually did (or, in dry-run, would)
// write — 0 whenever dryRun is true.
//
// Auth: X-Admin-Key header, LOCAL requireAdmin() — this codebase's convention
// is every admin route file redefines this locally rather than importing a
// shared helper (verified against admin-rfb-contact-extraction.ts,
// admin-rfb-website-discovery.ts, admin-agents-contact-email-write.ts).
//
// DB access: getDb() + prepared statements only. `agentIds` are never
// interpolated into SQL text — a dynamically-built `IN (?,?,...)`
// placeholder list is used, matching admin-rfb-contact-extraction.ts's
// selectRfbCxTargetsByIds convention.
//
// Non-goals: this route does not touch verification_status, does not re-run
// verification itself, and does not change the parking mechanism's write
// site (lokal-agent-verifier.ts) or the 30-day threshold — it only clears the
// two parking columns early, on a per-row basis, for rows that earned it.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

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

// Strict boolean parse for `apply` (review fix, orch-pr-20260901-1) — same
// fail-CLOSED pattern as parseDryRunFlag in
// src/services/agents-geocode-worker.ts (added after a past incident on this
// route's sibling geocode-unpark lever, where a loose truthy check on a
// prod-mutation switch silently misinterpreted a stringified/typo'd value).
// This route's `apply` is NOT a drop-in reuse of that helper: the field name
// differs (`apply` vs `dry_run`), and — critically — the DEFAULT semantics
// are the inverse of each other (parseDryRunFlag's absent-value default is
// dryRun:false i.e. "would write"; this route's absent-value default must
// stay apply:false i.e. "dry-run", per the dev-request's own "dry-run unless
// apply === true" spec and every existing test in this file). Reusing
// parseDryRunFlag verbatim against this route's `apply` field would flip
// that default and silently turn a dry-run-by-default lever into a
// write-by-default one — so the STRICT-BOOLEAN pattern is reproduced here
// against this route's own field/default rather than importing the helper.
// Anything present but not a real boolean (a stringified "true", a "1") is
// now REJECTED (400) rather than loosely coerced, so a malformed request
// fails closed/loud instead of silently doing (or silently NOT doing) a bulk
// write.
function parseApplyFlag(raw: unknown): { ok: true; apply: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, apply: false };
  if (typeof raw === "boolean") return { ok: true, apply: raw };
  return {
    ok: false,
    error:
      `apply må være en boolsk verdi (true/false uten anførselstegn) — fikk ${JSON.stringify(raw)}. ` +
      `Avvist i stedet for tolket: en feilskrevet apply-verdi ville ellers ha blitt tolket løst.`,
  };
}

// Manual admin lever, not a background worker — bounded but generous, since
// (unlike the geocode/contact-extraction levers) this route makes no live
// network calls, only DB reads/writes.
export const PENDING_VERIFY_UNPARK_DEFAULT_LIMIT = 100;
export const PENDING_VERIFY_UNPARK_HARD_CAP = 500;

interface UnparkCandidateRow {
  agent_id: string;
  agent_name: string | null;
  was_parked: 0 | 1;
  freshness_met: 0 | 1;
}

// agentIds mode: look up EVERY requested id (whether or not it turns out to
// be parked/fresh) in one query, so the route can report a definite state for
// every id the admin named — including ones that don't exist or aren't
// currently parked at all.
function selectAgentIdsCandidates(db: ReturnType<typeof getDb>, ids: string[]): UnparkCandidateRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT a.id AS agent_id, a.name AS agent_name,
              CASE WHEN k.pending_verify_parked_since IS NOT NULL THEN 1 ELSE 0 END AS was_parked,
              CASE WHEN k.pending_verify_parked_since IS NOT NULL
                        AND k.data_enriched_at > k.pending_verify_parked_since THEN 1 ELSE 0 END AS freshness_met
         FROM agents a
         JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id IN (${placeholders})`
    )
    .all(...ids) as UnparkCandidateRow[];
}

// Cohort mode: the freshness filter is applied IN SQL (not re-derived in JS
// from the two datetime strings) — both columns are written as SQL-native
// datetime('now') text, and lokal-agent-verifier.ts's own parking-stamp
// comment (line ~853-862) documents why a JS-side Date.parse of that format
// is timezone-unsafe. Oldest-parked-first ordering mirrors
// pickPendingVerifyBatch's own oldest-first convention.
function selectCohortCandidates(db: ReturnType<typeof getDb>, limit: number): UnparkCandidateRow[] {
  return db
    .prepare(
      `SELECT a.id AS agent_id, a.name AS agent_name, 1 AS was_parked, 1 AS freshness_met
         FROM agents a
         JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.pending_verify_parked_since IS NOT NULL
          AND k.data_enriched_at > k.pending_verify_parked_since
        ORDER BY k.pending_verify_parked_since ASC
        LIMIT ?`
    )
    .all(limit) as UnparkCandidateRow[];
}

// Touches ONLY the two parking columns, on exactly the ids handed in — the
// caller has already decided (via the freshness/parked eligibility checks
// above) which ids belong here.
function unparkRows(db: ReturnType<typeof getDb>, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE agent_knowledge
        SET pending_verify_parked_since = NULL,
            pending_verify_no_progress_count = 0
      WHERE agent_id IN (${placeholders})`
  ).run(...ids);
}

interface ResultRow {
  agentId: string;
  agentName?: string | null;
  wasEligible: boolean;
  freshnessMet: boolean;
  applied: boolean;
}

const router = Router();

router.post("/agents/pending-verify-unpark", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agentIds?: unknown; limit?: unknown; apply?: unknown };

  // Strict boolean parse (see parseApplyFlag above) — dry-run is the
  // default: only an explicit boolean `apply: true` writes anything; any
  // other truthy-looking-but-not-boolean value is rejected rather than
  // guessed at.
  const parsedApply = parseApplyFlag(body.apply);
  if (!parsedApply.ok) {
    res.status(400).json({ error: parsedApply.error });
    return;
  }
  const apply = parsedApply.apply;
  const dryRun = !apply;

  const db = getDb();

  const rawIds = Array.isArray(body.agentIds)
    ? (body.agentIds as unknown[])
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim())
    : [];
  // De-duped, order-preserved — a duplicate id in the request must still
  // produce exactly one row in the response.
  const ids = Array.from(new Set(rawIds));

  let mode: "agentIds" | "cohort";
  let limit: number | undefined;
  const rows: ResultRow[] = [];

  if (ids.length > 0) {
    mode = "agentIds";
    if (ids.length > PENDING_VERIFY_UNPARK_HARD_CAP) {
      res.status(400).json({ error: `Too many agentIds (max ${PENDING_VERIFY_UNPARK_HARD_CAP} per call)` });
      return;
    }
    const found = selectAgentIdsCandidates(db, ids);
    const byId = new Map(found.map((r) => [r.agent_id, r]));
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) {
        // Unknown id (no agents row, or no agent_knowledge row) — reported,
        // never silently dropped, mirroring the sibling routes' agentIds
        // handling of ids that don't resolve to a real target.
        rows.push({ agentId: id, wasEligible: false, freshnessMet: false, applied: false });
        continue;
      }
      rows.push({
        agentId: id,
        agentName: r.agent_name,
        wasEligible: r.was_parked === 1,
        // freshnessMet is only meaningful once wasEligible — a never-parked
        // row simply reports false here rather than an undefined comparison.
        freshnessMet: r.was_parked === 1 && r.freshness_met === 1,
        applied: false,
      });
    }
  } else {
    mode = "cohort";
    const rawLimit =
      typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : PENDING_VERIFY_UNPARK_DEFAULT_LIMIT;
    limit = Math.max(1, Math.min(PENDING_VERIFY_UNPARK_HARD_CAP, rawLimit));
    const found = selectCohortCandidates(db, limit);
    for (const r of found) {
      rows.push({ agentId: r.agent_id, agentName: r.agent_name, wasEligible: true, freshnessMet: true, applied: false });
    }
  }

  // Eligible = "would be unparked": in cohort mode this is every row (the
  // query already applied the freshness filter); in agentIds mode it is
  // every currently-parked requested id, freshness override included — a
  // stale-but-explicitly-named row is still eligible, just reported with
  // freshnessMet:false.
  const eligibleIds = rows.filter((r) => r.wasEligible).map((r) => r.agentId);
  const candidates = eligibleIds.length;
  let unparked = 0;

  if (apply) {
    if (eligibleIds.length > 0) unparkRows(db, eligibleIds);
    for (const r of rows) {
      if (r.wasEligible) r.applied = true;
    }
    unparked = eligibleIds.length;
  } else {
    // Dry-run preview: reports how many WOULD be unparked, writes nothing —
    // mirrors unparkAgentsGeocode(dryRun)'s "count without writing" shape.
    unparked = candidates;
  }

  res.json({
    success: true,
    // Renamed from `dryRun` to `dry_run` (review fix, orch-pr-20260901-1) to
    // match this route's own admin-lever family — admin-rfb-contact-
    // extraction.ts and POST /admin/agents/geocode-batch (marketplace.ts)
    // both report `dry_run` (snake_case); this was the only one of the three
    // using camelCase. Purely cosmetic — request-body shape (`apply`) is
    // unchanged, only this response field's name.
    dry_run: dryRun,
    mode,
    ...(limit !== undefined ? { limit } : {}),
    candidates,
    unparked,
    rows,
  });
});

export default router;
