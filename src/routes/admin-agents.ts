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
async function runBrregVerifyForRegister(
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

// ─── Slice 3 of dev-request 2026-06-30-brreg-verification-gate ─────────
// ("catalog sweep + badge") shares the SAME NACE-overlap computation as
// Slice 2's runBrregVerifyForRegister() above — exported here so the sweep
// endpoint below (and any future caller) never forks the logic.
export { runBrregVerifyForRegister, BRREG_NACE_ALLOWLIST };

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

// ─── Slice 3 of dev-request 2026-06-30-brreg-verification-gate ─────────
// ("catalog sweep + badge")
//
// POST /admin/agents/brreg-sweep
//   Batch RE-verifies EXISTING agents (rfb + experiences only — same
//   dental exclusion as Slice 2) that have an org_nr set but have either
//   never been Brreg-checked (brreg_checked_at IS NULL) or were last
//   checked more than BRREG_SWEEP_STALE_DAYS days ago. Reuses
//   runBrregVerifyForRegister() (Slice 2, above) for the Brreg call + the
//   per-vertical NACE-overlap computation — this sweep never forks that
//   logic, it just calls it once per candidate agent.
//
//   Unlike POST /register above, this endpoint is NOT gated by
//   BRREG_VERIFY_ON_REGISTER — that flag only controls verification at
//   registration time. The sweep is itself the opt-in mechanism: it does
//   nothing until an operator (or a future scheduled job — NOT wired up
//   in this slice, see note below) calls it.
//
//   Staleness window: 30 days. Rationale: Brreg registry state (dissolved/
//   bankrupt/NACE changes) moves slowly enough that daily/weekly re-checks
//   would be wasted load against a public rate-limited API for near-zero
//   signal; 30 days keeps the catalog reasonably fresh without hammering
//   Brreg. Not configurable via query param in this slice — a fixed,
//   documented default was judged sufficient for the first cut.
//
//   This endpoint does NOT run automatically — no cron/scheduled-agent
//   wiring is added in this slice (out of scope; see dev-request). It is
//   invoked on demand, consistent with the existing admin-sweep pattern
//   (admin-debio-cross-check.ts, admin-search-enrich.ts) elsewhere in this
//   codebase.
//
//   Query params:
//     limit    1..500, default 200 — max agents to verify in THIS call.
//              Brreg org-nr lookups are cheap/direct (unlike the TRACES
//              pagination admin-debio-cross-check.ts has to chunk), but we
//              still cap per-call work defensively against Fly's 120s
//              proxy timeout given the ~1s polite delay between calls.
//     offset   >=0, default 0 — skips N rows of the CURRENT matching set
//              (ordered deterministically by `id`). CAVEAT (same one
//              admin-knowledge.ts's prune-dead-urls sweep documents for its
//              own offset param): because every call here WRITES
//              brreg_checked_at, a swept row falls OUT of the matching set
//              immediately — so incrementing offset across successive real
//              sweep calls is NOT a safe way to page (row N gets skipped
//              because row N-1's removal shifted the set underneath it).
//              The always-correct way to sweep the full catalog across
//              multiple calls is simply: call again with the SAME limit
//              and offset=0 (default) repeatedly until `swept` comes back
//              0 — already-processed rows drop out of the WHERE filter on
//              their own, so the queue drains monotonically without needing
//              offset at all. offset is exposed mainly for ad-hoc
//              inspection (e.g. "what's the 501st-1000th stale row right
//              now, before I've swept anything").
//
//   Response:
//     { success: true, swept, verified, flagged_dissolved,
//       flagged_bankrupt, flagged_wrong_nace, errors, limit, offset,
//       has_more: boolean,  // batch was full (limit) — more matching rows
//                            // likely remain; call again with offset=0
//                            // (see the offset caveat above) until this
//                            // comes back false or `swept` is 0.
//       flagged: [{ id, name, org_nr, vertical_id, flag }] }
//
//   Never auto-deletes or de-lists anything — this endpoint only SURFACES
//   flagged agents for human review, per the dev-request spec's own
//   language: "de-list candidate", not auto-delete.
//
//   Brreg is a public, rate-limited (open data, NLOD-licensed) API, so a
//   polite ~1s delay is applied between calls (skipped before the first
//   row) — same PACE_MS convention as admin-search-enrich.ts. The delay
//   function is injectable (see runBrregCatalogSweep's `sleepFn` option)
//   so tests can run the sweep over multiple rows without incurring real
//   wall-clock delays.

const BRREG_SWEEP_DEFAULT_LIMIT = 200;
const BRREG_SWEEP_HARD_CAP = 500;
const BRREG_SWEEP_STALE_DAYS = 30;
const BRREG_SWEEP_PACE_MS = 1_000;

const defaultSweepSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface BrregSweepTargetRow {
  id: string;
  name: string;
  org_nr: string;
  vertical_id: string;
}

export interface BrregSweepFlaggedAgent {
  id: string;
  name: string;
  org_nr: string;
  vertical_id: string;
  flag: string;
}

export interface BrregSweepResult {
  swept: number;
  verified: number;
  flagged_dissolved: number;
  flagged_bankrupt: number;
  flagged_wrong_nace: number;
  errors: number;
  limit: number;
  offset: number;
  has_more: boolean;
  flagged: BrregSweepFlaggedAgent[];
}

// Core sweep — factored out of the route handler so tests can call it
// directly with an injected no-op sleepFn (avoids ~1s-per-row real delays
// slowing the test suite down), mirroring the dependency-injection style
// already used by services/search-enrich-sweep.ts for the same reason.
export async function runBrregCatalogSweep(opts: {
  limit?: number;
  offset?: number;
  sleepFn?: (ms: number) => Promise<void>;
} = {}): Promise<BrregSweepResult> {
  const limit = Math.min(
    Math.max(1, Math.floor(typeof opts.limit === "number" && Number.isFinite(opts.limit) ? opts.limit : BRREG_SWEEP_DEFAULT_LIMIT)),
    BRREG_SWEEP_HARD_CAP,
  );
  const offset = Math.max(0, Math.floor(typeof opts.offset === "number" && Number.isFinite(opts.offset) ? opts.offset : 0));
  const sleepFn = opts.sleepFn ?? defaultSweepSleep;

  const db = getDb();
  const staleBefore = new Date(Date.now() - BRREG_SWEEP_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `SELECT id, name, org_nr, vertical_id FROM agents
       WHERE vertical_id IN ('rfb', 'experiences')
         AND org_nr IS NOT NULL AND TRIM(org_nr) <> ''
         AND (brreg_checked_at IS NULL OR brreg_checked_at < ?)
       ORDER BY id ASC
       LIMIT ? OFFSET ?`
    )
    .all(staleBefore, limit, offset) as BrregSweepTargetRow[];

  const result: BrregSweepResult = {
    swept: 0,
    verified: 0,
    flagged_dissolved: 0,
    flagged_bankrupt: 0,
    flagged_wrong_nace: 0,
    errors: 0,
    limit,
    offset,
    has_more: rows.length === limit,
    flagged: [],
  };

  const updateStmt = db.prepare(
    `UPDATE agents SET brreg_verified = ?, brreg_flag = ?, brreg_checked_at = ? WHERE id = ?`
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > 0) await sleepFn(BRREG_SWEEP_PACE_MS);

    try {
      // runBrregVerifyForRegister() itself never throws (see its own
      // doc-comment above) — this try/catch is defensive against the DB
      // write below (or any future change to that contract), so a single
      // bad row can never abort the rest of the batch.
      const outcome = await runBrregVerifyForRegister(row.vertical_id, row.org_nr);
      updateStmt.run(outcome.brreg_verified, outcome.brreg_flag, outcome.brreg_checked_at, row.id);

      result.swept++;
      if (outcome.brreg_verified === 1) result.verified++;

      if (outcome.brreg_flag === "dissolved" || outcome.brreg_flag === "bankrupt" || outcome.brreg_flag === "wrong_nace") {
        if (outcome.brreg_flag === "dissolved") result.flagged_dissolved++;
        else if (outcome.brreg_flag === "bankrupt") result.flagged_bankrupt++;
        else result.flagged_wrong_nace++;
        result.flagged.push({
          id: row.id,
          name: row.name,
          org_nr: row.org_nr,
          vertical_id: row.vertical_id,
          flag: outcome.brreg_flag,
        });
      }
    } catch (err) {
      result.errors++;
      console.warn(
        "[admin-agents] brreg-sweep row failed unexpectedly (batch continues):",
        row.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}

router.post("/brreg-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const rawLimit = req.query.limit;
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const n = parseInt(rawLimit as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      res.status(400).json({ error: "invalid limit", detail: "limit must be >= 1" });
      return;
    }
    limit = n;
  }

  const rawOffset = req.query.offset;
  let offset: number | undefined;
  if (rawOffset !== undefined) {
    const n = parseInt(rawOffset as string, 10);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "invalid offset", detail: "offset must be >= 0" });
      return;
    }
    offset = n;
  }

  try {
    const result = await runBrregCatalogSweep({ limit, offset });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Brreg sweep failed", detail: err?.message || String(err) });
  }
});

export default router;
