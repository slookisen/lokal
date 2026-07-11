// ─── Admin: Agents Listing Endpoint (PR-93) ─────────────────────
//
// HTTP surface for browsing agents by status + recent update window:
//   GET /admin/agents
//
// Why this endpoint: the lokal-agent-verifier had been stuck on an
// 8-day SKIPPED-streak because it had no cheap way to ask "which
// agents changed in the last 24h, filtered by status?". The marketplace
// search endpoints are public/geo-shaped and don't expose internal
// status; admin-agent-audit reaches individual rows but not lists.
// This route fills that gap with a single, paginated, admin-gated GET.
//
// Schema note (read the report): the `agents` table does *not* have
// `updated_at` or `status` columns. We map:
//   - query.updated_since → filter on `last_seen_at`   (the only timestamp
//                                                       the table tracks
//                                                       per-write; created_at
//                                                       is immutable)
//   - query.status        → mapped onto (is_active, is_verified):
//        "active"   → is_active=1
//        "inactive" → is_active=0
//        "pending"  → is_active=1 AND is_verified=0
//   - response.status     → derived string mirror of above
//   - response.vertical   → `vertical_id` column (added in Phase 4.6a)
//   - response.updated_at → `last_seen_at`
//
// Auth: X-Admin-Key, mirrors the pattern from admin-runs.ts.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { slugify } from "../utils/slug";
import { verifyOrgNumber, type BrregVerifyResult } from "../services/brreg-client";

const router = Router();

// ─── Slice 2 of dev-request 2026-06-30-brreg-verification-gate ─────────
// Wires verifyOrgNumber() (services/brreg-client.ts, Slice 1) into
// POST /admin/agents/register for the "rfb" and "experiences" verticals
// only — "dental" stays Legelisten-primary and is never Brreg-verified
// here (brreg_* columns stay at their DB defaults for dental rows).
//
// Feature flag: BRREG_VERIFY_ON_REGISTER — same `=== "true"` truthy-check
// convention as the sibling BRREG_NACE_DISCOVERY_ENABLED flag in
// scheduled-agents/brreg-nace-discovery.md (which defaults OFF/dry-run
// until Daniel flips it after a verified dry-run). We follow that same
// conservative default here: unset/falsy → skip verification entirely,
// so registration behaves exactly as it did before this slice. This is
// deliberately the rollback lever — Brreg outages or bad NACE data can
// be neutralised instantly by unsetting the env var, with zero code change.
function brregVerifyEnabled(): boolean {
  return process.env.BRREG_VERIFY_ON_REGISTER === "true";
}

// Per-vertical NACE allow-lists — identical to the lists already used by
// scheduled-agents/brreg-nace-discovery.md's own registration step, so a
// candidate that discovery already accepted is not silently rejected here.
const BRREG_NACE_ALLOWLIST: Record<string, readonly string[]> = {
  rfb: [
    "01.410", "01.450", "01.460", "01.490", "01.500",
    "10.110", "10.130", "10.510", "10.710", "11.020",
    "47.220", "47.270",
  ],
  experiences: [
    "93.291", "93.292", "79.121", "79.901", "79.902",
    "96.230", "55.200", "55.300",
  ],
};

// runBrregVerifyForRegister — computes (brreg_verified, brreg_flag,
// brreg_checked_at) for a register-time org-nr check. Never throws — any
// unexpected error (verifyOrgNumber itself already never throws, but we
// wrap defensively anyway: a Brreg outage must never break registration)
// resolves to the "unverified, unchecked" tuple.  brreg_checked_at is only
// stamped once the whole check has completed without error.
// Exported (not just used by /register) so the backlog sweep below
// (GET/POST /admin/agents/brreg-catalog-sweep, Slice 3) reuses the exact
// same classification rules rather than forking a second copy.
export async function runBrregVerifyForRegister(
  verticalId: string,
  orgNr: string,
): Promise<{ brreg_verified: number; brreg_flag: string | null; brreg_checked_at: string | null }> {
  try {
    const result: BrregVerifyResult = await verifyOrgNumber(orgNr);

    if (result.flag === "dissolved" || result.flag === "bankrupt") {
      return { brreg_verified: 0, brreg_flag: result.flag, brreg_checked_at: new Date().toISOString() };
    }
    if (!result.exists) {
      // Per verifyOrgNumber's SAFE_DEFAULT_VERIFY_RESULT contract, both the
      // not-found (404) and network/parse-error paths resolve with
      // flag: "no_orgnr" — we mirror that faithfully rather than assume.
      return { brreg_verified: 0, brreg_flag: "no_orgnr", brreg_checked_at: new Date().toISOString() };
    }
    if (result.active && result.flag === null) {
      const allowList = BRREG_NACE_ALLOWLIST[verticalId] ?? [];
      const overlap = result.nace.some((code) => allowList.includes(code));
      return {
        brreg_verified: overlap ? 1 : 0,
        brreg_flag: overlap ? null : "wrong_nace",
        brreg_checked_at: new Date().toISOString(),
      };
    }
    // Exists, not flagged dissolved/bankrupt, but not (active && flag===null)
    // either — e.g. underAvvikling/underTvangsavviklingEllerTvangsopplosning
    // with no slettedato/konkurs. Not explicitly specced; treated as
    // inconclusive rather than invented into one of the named flags.
    return { brreg_verified: 0, brreg_flag: null, brreg_checked_at: new Date().toISOString() };
  } catch (err) {
    console.warn(
      "[admin-agents] brreg verify failed unexpectedly (registration proceeds regardless):",
      err instanceof Error ? err.message : err,
    );
    return { brreg_verified: 0, brreg_flag: null, brreg_checked_at: null };
  }
}

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

// ─── GET /admin/agents ────────────────────────────────────────
// List agents filtered by status + updated_since, paginated.
//
// Query params:
//   status         active | inactive | pending  (optional, default: all)
//   updated_since  ISO timestamp                 (optional, default: 24h ago)
//   limit          1..500                        (optional, default 50)
//   offset         >=0                           (optional, default 0)
//
// Response:
//   { success: true, count: <total before pagination>,
//     agents: [{ id, name, updated_at, status, vertical }] }
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── Parse + validate query params ─────────────────────────
  const rawStatus = (req.query.status as string) || "";
  const status = rawStatus.toLowerCase();
  if (status && !["active", "inactive", "pending"].includes(status)) {
    res.status(400).json({
      error: "invalid status",
      detail: "status must be one of: active, inactive, pending",
    });
    return;
  }

  // updated_since: default = 24h ago. Accept ISO 8601.
  let updatedSince = (req.query.updated_since as string) || "";
  if (!updatedSince) {
    updatedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } else {
    const parsed = Date.parse(updatedSince);
    if (Number.isNaN(parsed)) {
      res.status(400).json({
        error: "invalid updated_since",
        detail: "must be an ISO 8601 timestamp",
      });
      return;
    }
    // Normalise to ISO so SQLite's lexicographic compare works correctly
    // against the `datetime('now')`-style stamps the table uses.
    updatedSince = new Date(parsed).toISOString();
  }

  // limit: default 50, max 500
  let limit = 50;
  if (req.query.limit !== undefined) {
    const n = parseInt(req.query.limit as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      res.status(400).json({ error: "invalid limit", detail: "limit must be >= 1" });
      return;
    }
    limit = Math.min(n, 500);
  }

  // offset: default 0
  let offset = 0;
  if (req.query.offset !== undefined) {
    const n = parseInt(req.query.offset as string, 10);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "invalid offset", detail: "offset must be >= 0" });
      return;
    }
    offset = n;
  }

  // ── Build WHERE clause ────────────────────────────────────
  // Parameterised — never concatenate user input into SQL.
  const where: string[] = ["last_seen_at >= ?"];
  const params: (string | number)[] = [updatedSince];

  if (status === "active") {
    where.push("is_active = 1");
  } else if (status === "inactive") {
    where.push("is_active = 0");
  } else if (status === "pending") {
    // "pending" = active but not yet verified. This matches the verifier's
    // mental model: rows it still needs to look at.
    where.push("is_active = 1");
    where.push("is_verified = 0");
  }

  const whereSql = where.join(" AND ");

  try {
    const db = getDb();

    // Total count BEFORE pagination — required for the verifier to
    // know whether to paginate further.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${whereSql}`)
      .get(...params) as { n: number };
    const total = countRow?.n ?? 0;

    const rows = db
      .prepare(
        `SELECT id, name, last_seen_at, is_active, is_verified, vertical_id
         FROM agents
         WHERE ${whereSql}
         ORDER BY last_seen_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
        id: string;
        name: string;
        last_seen_at: string;
        is_active: number;
        is_verified: number;
        vertical_id: string | null;
      }>;

    const agents = rows.map((r) => ({
      id: r.id,
      name: r.name,
      updated_at: r.last_seen_at,
      status:
        r.is_active === 0
          ? "inactive"
          : r.is_verified === 0
            ? "pending"
            : "active",
      vertical: r.vertical_id ?? "rfb",
    }));

    res.json({ success: true, count: total, agents });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

// ─── POST /admin/agents/register ─────────────────────────────
// Register a net-new agent discovered by the brreg NACE discovery agent.
//
// Auth: X-Admin-Key header (same requireAdmin as above).
//
// Dedup logic (in order):
//   1. org_nr tag match  → { success: false, duplicate: true, existing_id }
//   2. name+city match   → { success: false, duplicate: true, existing_id }
//   3. Insert new agent with trust_score 0.3 (lower than owner-claimed 0.5)
//
// Columns: only those confirmed present in agents table are written.
//   vertical_id  → confirmed via ALTER TABLE (Phase 4.6a)
//   data_source  → on agent_knowledge, NOT agents — excluded
//   auto_sources → on agent_knowledge, NOT agents — excluded
router.post("/register", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── Validate required fields ───────────────────────────────
  const {
    name,
    url,
    city,
    vertical_id,
    org_nr,
    source,
    nace_code,
    categories,
    tags: extraTags,
    phone: _phone,       // reserved; stored in agent_knowledge, not agents
    description,
    lat,
    lng,
  } = req.body as {
    name?: string;
    url?: string;
    city?: string;
    vertical_id?: string;
    org_nr?: string;
    source?: string;
    nace_code?: string;
    categories?: string[];
    tags?: string[];
    phone?: string;
    description?: string;
    lat?: number;
    lng?: number;
  };

  if (!name || !url || !city || !vertical_id || !org_nr || !source) {
    res.status(400).json({
      error: "Missing required fields",
      detail: "name, url, city, vertical_id, org_nr, source are all required",
    });
    return;
  }

  const VALID_VERTICALS = ["rfb", "dental", "experiences"] as const;
  if (!VALID_VERTICALS.includes(vertical_id as typeof VALID_VERTICALS[number])) {
    res.status(400).json({
      error: "Invalid vertical_id",
      detail: "vertical_id must be one of: rfb, dental, experiences",
    });
    return;
  }

  try {
    const db = getDb();

    // ── Dedup 1: org_nr tag match ────────────────────────────
    // Tags are stored as a JSON array. We search for the literal
    // string "org_nr:<value>" inside the TEXT column.
    const orgNrTag = `org_nr:${org_nr}`;
    const byOrgNr = db
      .prepare(
        `SELECT id FROM agents WHERE tags LIKE ? LIMIT 1`
      )
      .get(`%"${orgNrTag}"%`) as { id: string } | undefined;

    if (byOrgNr) {
      res.json({
        success: false,
        duplicate: true,
        existing_id: byOrgNr.id,
        message: "Agent with this org_nr already exists",
      });
      return;
    }

    // ── Dedup 2: name + city match (case-insensitive) ────────
    const byNameCity = db
      .prepare(
        `SELECT id FROM agents WHERE LOWER(name) = LOWER(?) AND LOWER(city) = LOWER(?) LIMIT 1`
      )
      .get(name, city) as { id: string } | undefined;

    if (byNameCity) {
      res.json({
        success: false,
        duplicate: true,
        existing_id: byNameCity.id,
        message: "Agent with this name+city already exists",
      });
      return;
    }

    // ── Build tags array ─────────────────────────────────────
    const builtTags: string[] = [`org_nr:${org_nr}`, `source:${source}`];
    if (nace_code) builtTags.push(`nace:${nace_code}`);
    if (extraTags && Array.isArray(extraTags)) builtTags.push(...extraTags);

    // ── Slice 2 of dev-request 2026-06-30-brreg-verification-gate ────
    // rfb + experiences only — dental stays Legelisten-primary, brreg_*
    // columns stay at their DB defaults (0 / null / null) for dental and
    // for any registration where the flag is off. Never blocks the
    // registration itself, regardless of outcome.
    let brreg_verified = 0;
    let brreg_flag: string | null = null;
    let brreg_checked_at: string | null = null;

    if (
      brregVerifyEnabled() &&
      (vertical_id === "rfb" || vertical_id === "experiences") &&
      org_nr
    ) {
      const verifyOutcome = await runBrregVerifyForRegister(vertical_id, org_nr);
      brreg_verified = verifyOutcome.brreg_verified;
      brreg_flag = verifyOutcome.brreg_flag;
      brreg_checked_at = verifyOutcome.brreg_checked_at;
    }

    // ── Insert ───────────────────────────────────────────────
    // vertical_id is confirmed present (Phase 4.6a ALTER TABLE).
    // data_source + auto_sources live on agent_knowledge, not agents — excluded.
    const id = require("crypto").randomUUID();
    const api_key = `brreg_${require("crypto").randomBytes(20).toString("hex")}`;
    const agentDescription = (description ?? "").trim() || "Oppdaget via Brreg NACE-søk";

    db.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url,
        role, api_key,
        city, lat, lng,
        categories, tags,
        trust_score, is_active, is_verified,
        vertical_id,
        org_nr, brreg_verified, brreg_flag, brreg_checked_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        'producer', ?,
        ?, ?, ?,
        ?, ?,
        0.3, 1, 0,
        ?,
        ?, ?, ?, ?
      )`
    ).run(
      id,
      name,
      agentDescription,
      name,                           // provider = business name
      "kontakt@rettfrabonden.com",    // placeholder; updated when agent claims profile
      url,
      api_key,
      city,
      lat ?? null,
      lng ?? null,
      JSON.stringify(categories && Array.isArray(categories) ? categories : []),
      JSON.stringify(builtTags),
      vertical_id,
      org_nr,
      brreg_verified,
      brreg_flag,
      brreg_checked_at,
    );

    res.status(201).json({
      success: true,
      agent_id: id,
      slug: slugify(name),
      message: "Agent registered",
    });
  } catch (err: any) {
    res.status(500).json({ error: "Registration failed", detail: err.message });
  }
});

// ─── GET/POST /admin/agents/brreg-catalog-sweep (Slice 3 of dev-request ──────
//     2026-06-30-brreg-verification-gate) ──────────────────────────────────
//
// WHY: BRREG_VERIFY_ON_REGISTER (Slice 2, above) is unset in prod today, so
// almost no pre-existing `agents` row has `brreg_verified=1` yet even where
// registration-time wiring would have caught something. This is the one-time
// backfill sweep for that backlog — mirrors GET/POST /admin/description-
// truncation-sweep's dry-run-by-default convention (routes/admin-knowledge.ts)
// closely: read-only GET diagnostic, POST with a STRICT-FALSE dry_run parse,
// real writes scoped to exactly the columns this feature owns.
//
// Candidate set: agents rows with a non-null/non-empty org_nr that have
// NEVER been checked (brreg_checked_at IS NULL) — rows already checked
// (by registration-time wiring or a prior sweep run) are excluded, so
// re-running this sweep is naturally idempotent without a separate
// staleness/re-check window (out of scope for this slice, see dev-request).
//
// Vertical scoping judgment call: `agents` DOES carry a per-row vertical_id
// column (Phase 4.6a — see GET / above, `vertical: r.vertical_id ?? "rfb"`),
// so we use it rather than inventing a new signal or hardcoding "rfb" for
// every row. But we mirror POST /register's own gating (above) exactly:
// only "rfb" and "experiences" rows are ever verified — "dental" stays
// Legelisten-primary and is intentionally excluded from the candidate set,
// same as it's excluded from the registration-time verify call. A NULL
// vertical_id defaults to "rfb", matching the GET / listing endpoint's
// existing convention.
//
// Classification is NOT re-derived here — every row's outcome comes from
// runBrregVerifyForRegister() (exported above), the exact same function
// POST /register already uses, so a sweep-verified row and a
// registration-verified row are always classified identically.
//
// Hard batch cap: a single GET/POST call only ever scans/verifies up to
// BRREG_SWEEP_BATCH_CAP rows (oldest-registered-first, by created_at then
// id for a deterministic order), and reports remaining_count so a caller
// knows there's more backlog left — this endpoint NEVER walks the full
// backlog synchronously in one request (see the table-sizes / tasks-prune
// event-loop-blocking incidents this repo has already hit once).
//
// Writes: ONLY `UPDATE agents SET brreg_verified=?, brreg_flag=?,
// brreg_checked_at=? WHERE id=?`, one row at a time, for rows in the capped
// batch on a real (dry_run:false) run. NEVER DELETE, NEVER touches
// is_active or any other column — dissolved/bankrupt agents are only ever
// flagged, exactly like Slice 2. No filesystem writes; the `flagged_for_review`
// bucket is returned in the response only (a later slice's concern, not this
// one's, per the dev-request).
const BRREG_SWEEP_BATCH_CAP = 50;

// Only these two verticals are ever Brreg-verified (mirrors POST /register's
// own gating above) — "dental" rows are excluded from the candidate set
// entirely, never scanned/verified by this sweep.
const BRREG_SWEEP_ELIGIBLE_VERTICALS = ["rfb", "experiences"] as const;

// Outcomes that belong in the "review list" the dev-request asks for.
// "no_orgnr" and the inconclusive null case are deliberately NOT review-list
// material — they're either "nothing to check" or "not a named flag".
const BRREG_SWEEP_REVIEW_FLAGS = new Set(["dissolved", "bankrupt", "wrong_nace"]);

interface BrregSweepCandidateRow {
  id: string;
  name: string;
  org_nr: string;
  vertical_id: string | null;
}

interface BrregSweepRowResult {
  id: string;
  name: string;
  org_nr: string;
  vertical: string;
  brreg_verified: number;
  brreg_flag: string | null;
}

// Shared WHERE clause for both the count and the capped batch query, so the
// two can never drift out of sync with each other.
function brregSweepCandidateWhereSql(): string {
  return `org_nr IS NOT NULL AND TRIM(org_nr) != '' AND brreg_checked_at IS NULL
    AND COALESCE(vertical_id, 'rfb') IN ('${BRREG_SWEEP_ELIGIBLE_VERTICALS.join("','")}')`;
}

function countBrregSweepCandidates(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${brregSweepCandidateWhereSql()}`)
    .get() as { n: number };
  return row?.n ?? 0;
}

// Deterministic, oldest-registered-first ordering (created_at, then id as a
// tiebreaker) — a hard LIMIT means only up to BRREG_SWEEP_BATCH_CAP rows are
// ever scanned/verified per invocation; the rest of the backlog is reported
// via remaining_count, never processed synchronously in the same request.
function fetchBrregSweepBatch(db: ReturnType<typeof getDb>, cap: number): BrregSweepCandidateRow[] {
  return db
    .prepare(
      `SELECT id, name, org_nr, vertical_id FROM agents
       WHERE ${brregSweepCandidateWhereSql()}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(cap) as BrregSweepCandidateRow[];
}

// Computes (never writes) what runBrregVerifyForRegister would set for a
// candidate row — reused identically by the GET diagnostic and the POST
// dry-run preview, so both always agree.
async function computeBrregSweepRowResult(row: BrregSweepCandidateRow): Promise<BrregSweepRowResult> {
  const vertical = row.vertical_id ?? "rfb";
  const outcome = await runBrregVerifyForRegister(vertical, row.org_nr);
  return {
    id: row.id,
    name: row.name,
    org_nr: row.org_nr,
    vertical,
    brreg_verified: outcome.brreg_verified,
    brreg_flag: outcome.brreg_flag,
  };
}

// Atomically claims-and-writes a single candidate row's Brreg outcome.
//
// WHY this exists (race fix): runBrregVerifyForRegister() above is awaited
// — it's a real network call to the Brreg API — so any amount of time can
// pass between "we last knew this row was unchecked" and "we're ready to
// write its outcome". A SELECT-then-UPDATE re-check done BEFORE that await
// (or even done after the await but as two separate statements) still
// leaves a window: two concurrent callers (a second sweep run, or
// registration-time wiring) can both observe brreg_checked_at IS NULL,
// both make their own Brreg fetch for the same org_nr, and both believe
// they "won" the write.
//
// The fix folds the re-check into the UPDATE's WHERE clause so the claim
// and the write are a single atomic SQLite statement: only a caller whose
// UPDATE actually matched a still-NULL row gets `changes === 1`. A second
// caller racing against the first is guaranteed `changes === 0` once the
// first caller's UPDATE has committed — there is no read-then-write gap
// left to race.
export function applyBrregSweepRowUpdate(
  db: ReturnType<typeof getDb>,
  id: string,
  outcome: { brreg_verified: number; brreg_flag: string | null; brreg_checked_at: string | null },
): boolean {
  const result = db
    .prepare(
      "UPDATE agents SET brreg_verified = ?, brreg_flag = ?, brreg_checked_at = ? WHERE id = ? AND brreg_checked_at IS NULL",
    )
    .run(outcome.brreg_verified, outcome.brreg_flag, outcome.brreg_checked_at, id);
  return result.changes === 1;
}

function toFlaggedForReview(
  r: BrregSweepRowResult,
): { id: string; name: string; org_nr: string; brreg_flag: string } | null {
  if (r.brreg_flag && BRREG_SWEEP_REVIEW_FLAGS.has(r.brreg_flag)) {
    return { id: r.id, name: r.name, org_nr: r.org_nr, brreg_flag: r.brreg_flag };
  }
  return null;
}

router.get("/brreg-catalog-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const candidateCount = countBrregSweepCandidates(db);
    const batchRows = fetchBrregSweepBatch(db, BRREG_SWEEP_BATCH_CAP);

    const results: BrregSweepRowResult[] = [];
    for (const row of batchRows) {
      results.push(await computeBrregSweepRowResult(row));
    }
    const flaggedForReview = results
      .map(toFlaggedForReview)
      .filter((x): x is NonNullable<typeof x> => x !== null);

    res.json({
      success: true,
      dry_run: true,
      candidate_count: candidateCount,
      batch_size: results.length,
      remaining_count: Math.max(0, candidateCount - results.length),
      rows: results,
      flagged_for_review: flaggedForReview,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Sweep diagnostic failed", detail: err.message });
  }
});

router.post("/brreg-catalog-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // STRICT-FALSE parse — identical convention to POST /admin/
  // description-truncation-sweep: null / "false" / 0 / "" / undefined all
  // mean dry-run; only the literal JSON boolean `false` triggers real writes.
  const body = (req.body ?? {}) as { dry_run?: unknown };
  const dryRun = body.dry_run !== false;

  try {
    const db = getDb();
    const candidateCount = countBrregSweepCandidates(db);
    const batchRows = fetchBrregSweepBatch(db, BRREG_SWEEP_BATCH_CAP);

    if (dryRun) {
      const results: BrregSweepRowResult[] = [];
      for (const row of batchRows) {
        results.push(await computeBrregSweepRowResult(row));
      }
      const flaggedForReview = results
        .map(toFlaggedForReview)
        .filter((x): x is NonNullable<typeof x> => x !== null);

      res.json({
        success: true,
        dry_run: true,
        candidate_count: candidateCount,
        batch_size: results.length,
        remaining_count: Math.max(0, candidateCount - results.length),
        would_update_count: results.length,
        would_update: results,
        flagged_for_review: flaggedForReview,
      });
      return;
    }

    // Real run — write ONLY the three brreg_* columns for each row, and
    // ONLY if the row is still unclaimed (brreg_checked_at IS NULL) at
    // write time. The claim check and the write are a single atomic
    // conditional UPDATE (see applyBrregSweepRowUpdate above) — NOT a
    // separate pre-write SELECT — so a row that got checked by something
    // else (registration-time wiring or a concurrent sweep run) since the
    // scan above can never be clobbered, even though runBrregVerifyForRegister
    // below is an awaited network call.
    const updated: Array<{
      id: string; name: string; org_nr: string; vertical: string;
      brreg_verified: number; brreg_flag: string | null; brreg_checked_at: string | null;
    }> = [];
    const flaggedForReview: Array<{ id: string; name: string; org_nr: string; brreg_flag: string }> = [];
    const skippedAlreadyCheckedIds: string[] = [];

    for (const row of batchRows) {
      const vertical = row.vertical_id ?? "rfb";
      const outcome = await runBrregVerifyForRegister(vertical, row.org_nr);
      const wrote = applyBrregSweepRowUpdate(db, row.id, outcome);
      if (!wrote) {
        skippedAlreadyCheckedIds.push(row.id);
        continue;
      }
      updated.push({
        id: row.id,
        name: row.name,
        org_nr: row.org_nr,
        vertical,
        brreg_verified: outcome.brreg_verified,
        brreg_flag: outcome.brreg_flag,
        brreg_checked_at: outcome.brreg_checked_at,
      });
      if (outcome.brreg_flag && BRREG_SWEEP_REVIEW_FLAGS.has(outcome.brreg_flag)) {
        flaggedForReview.push({ id: row.id, name: row.name, org_nr: row.org_nr, brreg_flag: outcome.brreg_flag });
      }
    }

    res.json({
      success: true,
      dry_run: false,
      candidate_count: candidateCount,
      batch_size: batchRows.length,
      remaining_count: Math.max(0, candidateCount - batchRows.length),
      updated_count: updated.length,
      updated,
      skipped_already_checked_count: skippedAlreadyCheckedIds.length,
      skipped_already_checked_ids: skippedAlreadyCheckedIds,
      flagged_for_review: flaggedForReview,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Sweep failed", detail: err.message });
  }
});

export default router;
