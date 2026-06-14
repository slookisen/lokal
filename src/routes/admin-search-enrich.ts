// ─── POST /admin/search-enrich (orchestrator-pr-10, 2026-06-14) ──────────────
//
// Per-producer web-search → crawl → confirm → producer-email extraction.
//
// For producers (agents) that are missing an email but DO have a phone number
// (the cross-check key), this endpoint:
//   1. SEARCHES the web for the producer's name (+ city) via the Brave API,
//   2. ranks candidate result URLs by name-stem overlap,
//   3. CRAWLS the top ≤2 candidate pages (plus /kontakt and /om-oss on the same
//      host) and extracts emails + phones,
//   4. CONFIRMS the page really belongs to the producer (hard key match on
//      phone/orgnr = strong; ≥2 soft signals = medium),
//   5. picks the producer's OWN email, rejecting directory/coordinator addresses
//      (post@hanen.no et al.) and refusing to guess when ambiguous.
//
// DRY-RUN BY DEFAULT. Writes happen only when apply is truthy AND the row is
// `write`-tier: strength === 'strong' (key-confirmed) AND an unambiguous
// producer email was picked. Anything weaker is reported as `queue`/`none` for
// human review — never auto-written. We NEVER overwrite a non-empty value.
//
// Auth: X-Admin-Key (same pattern as admin-knowledge / prune-dead-urls).
//
// The decision logic lives in services/search-enrich.ts (pure + unit-tested);
// this route is the orchestration + I/O shell.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  applyEnrichWrite,
  startSearchEnrichSweep,
  getSearchEnrichSweepJob,
  ensureFindingsTable,
  applyFindings,
} from "../services/search-enrich-sweep";
import {
  braveSearch,
  nameStems,
  buildPageEvidence,
  registrableHostFromUrl,
  enrichOneAgent,
  type StoredProducer,
  type EnrichDeps,
} from "../services/search-enrich";

const router = Router();

// ─── Auth (mirrors admin-knowledge.ts) ────────────────────────────────────────
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

// ─── Tunables ─────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 25;
const HARD_CAP = 50;
const PACE_MS = 1_100; // ~1.1s between agents → respect Brave's ~1 req/sec free tier

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Crawl helpers (fetchHtml / extract* / isSafeFetchUrl / buildPageEvidence /
// registrableHostFromUrl) moved to services/search-enrich.ts (orchestrator-pr-12)
// so the route + sweep share an identical default crawl path. Imported above.
type Tier = "write" | "queue" | "none";

interface ResultRow {
  agent_id: string;
  name: string;
  query: string;
  chosen_url: string | null;
  confirm: { confirmed: boolean; strength: string; signals: string[] };
  candidate_email: string | null;
  email_reason: string;
  tier: Tier;
}

interface TargetAgent {
  agent_id: string;
  name: string;
  city: string | null;
  url: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  postcode: string | null;
  address: string | null;
}

// ─── route ─────────────────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const braveKey = process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || "";
  if (!braveKey) {
    res.status(503).json({ error: "BRAVE_API_KEY not configured" });
    return;
  }

  // ── params (query or JSON body) ──
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawLimit = req.query["limit"] ?? body["limit"];
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined && !isNaN(Number(rawLimit)) && Number(rawLimit) > 0) {
    limit = Math.min(Math.floor(Number(rawLimit)), HARD_CAP);
  }

  const applyFromQuery = req.query["apply"] === "1" || req.query["apply"] === "true";
  const bodyApply = body["apply"];
  const applyFromBody =
    bodyApply === true || bodyApply === "1" || bodyApply === "true";
  const apply = applyFromQuery || applyFromBody;
  const dryRun = !apply;

  let agentIds: string[] | null = null;
  const rawIds = body["agentIds"] ?? req.query["agentIds"];
  if (Array.isArray(rawIds)) {
    agentIds = rawIds.map((x) => String(x)).filter(Boolean);
  } else if (typeof rawIds === "string" && rawIds.trim()) {
    agentIds = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const db = getDb();

  // ── optional skip-tracking column (idempotent guarded ALTER) ──
  let hasLastSearchAt = true;
  try {
    db.exec("ALTER TABLE agent_knowledge ADD COLUMN last_search_at TEXT");
  } catch {
    /* column already exists — expected after first run */
  }
  // Confirm it's really there (in case the catch masked a different failure).
  try {
    const cols = db.prepare("PRAGMA table_info(agent_knowledge)").all() as Array<{ name: string }>;
    hasLastSearchAt = cols.some((c) => c.name === "last_search_at");
  } catch {
    hasLastSearchAt = false;
  }

  // ── target selection ──
  let targets: TargetAgent[];
  const selectCols = `
    a.id   AS agent_id,
    a.name AS name,
    a.city AS city,
    a.url  AS url,
    k.phone   AS phone,
    k.website AS website,
    k.email   AS email,
    k.postal_code AS postcode,
    k.address AS address
  `;
  if (agentIds && agentIds.length > 0) {
    const capped = agentIds.slice(0, HARD_CAP);
    const placeholders = capped.map(() => "?").join(",");
    targets = db
      .prepare(
        `SELECT ${selectCols}
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
         WHERE a.id IN (${placeholders})`,
      )
      .all(...capped) as TargetAgent[];
  } else {
    // email missing/null AND phone present; exclude opt-out / customer / CRM-blocked.
    const orderClause = hasLastSearchAt
      ? "ORDER BY k.last_search_at ASC NULLS LAST, a.created_at ASC"
      : "ORDER BY a.created_at ASC";
    targets = db
      .prepare(
        `SELECT ${selectCols}
         FROM agents a
         INNER JOIN agent_knowledge k ON k.agent_id = a.id
         WHERE (k.email IS NULL OR trim(k.email) = '')
           AND k.phone IS NOT NULL AND trim(k.phone) != ''
           AND (k.verification_status IS NULL OR k.verification_status != 'opt_out')
           AND a.claimed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM crm_contacts cc
             WHERE cc.agent_id = a.id AND cc.status != 'active'
           )
         ${orderClause}
         LIMIT ?`,
      )
      .all(limit) as TargetAgent[];
  }

  const rows: ResultRow[] = [];
  const now = new Date().toISOString();

  const stampSearchStmt = hasLastSearchAt
    ? db.prepare("UPDATE agent_knowledge SET last_search_at = ?, updated_at = ? WHERE agent_id = ?")
    : null;

  // Real deps for enrichOneAgent: Brave search (env key) + same-host crawler.
  const deps: EnrichDeps = {
    search: (q) => braveSearch(q, braveKey, 5),
    crawl: (url) => buildPageEvidence(url),
  };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const geo = (t.city ?? "").trim();
    const query = `"${t.name}" ${geo}`.trim();
    let row: ResultRow = {
      agent_id: t.agent_id,
      name: t.name,
      query,
      chosen_url: null,
      confirm: { confirmed: false, strength: "none", signals: [] },
      candidate_email: null,
      email_reason: "not_processed",
      tier: "none",
    };

    try {
      // pace between agents (skip the wait before the first one)
      if (i > 0) await sleep(PACE_MS);

      const siteRoot = t.website ? registrableHostFromUrl(t.website) : null;
      const stored: StoredProducer & { agent_id: string; name: string; query: string } = {
        agent_id: t.agent_id,
        name: t.name,
        query,
        phone: t.phone,
        postcode: t.postcode,
        street: t.address,
        orgnr: null, // no orgnr column on agents/agent_knowledge in this schema
        siteRoot,
      };

      // Shared per-agent processing (search→crawl→confirm→pick→tier).
      row = await enrichOneAgent(stored, deps);

      // ── apply writes (write-tier only) ──
      if (apply && row.tier === "write" && row.candidate_email) {
        try {
          applyWrite(db, t, row.candidate_email, row.chosen_url, now);
        } catch (writeErr: any) {
          // surface write failure in the row but don't abort the batch
          row.email_reason = `${row.email_reason};write_failed:${writeErr?.message ?? String(writeErr)}`;
        }
      }
    } catch (agentErr: any) {
      // One agent failing must not abort the batch — record it as a 'none'
      // row with the error reason and move on. finalCounts (computed from
      // `rows` after the loop) is the single source of truth for the tallies.
      row.email_reason = `error:${agentErr?.message ?? String(agentErr)}`;
      row.tier = "none";
    } finally {
      // skip-tracking: stamp every processed agent (best-effort)
      if (apply && stampSearchStmt) {
        try {
          stampSearchStmt.run(now, now, t.agent_id);
        } catch {
          /* non-fatal */
        }
      }
      rows.push(row);
    }
  }

  // Tally tiers from the final rows (single source of truth — robust to
  // per-agent errors that reassign a row's tier to 'none').
  const finalCounts = { write: 0, queue: 0, none: 0 };
  for (const r of rows) finalCounts[r.tier]++;

  res.json({
    dry_run: dryRun,
    brave_key: "present",
    scanned: targets.length,
    counts: finalCounts,
    rows,
  });
});

// ─── Background full-cohort sweep + findings review + gated apply (orch-pr-12) ─
//
// POST /admin/search-enrich/sweep   { apply?: boolean }  (default dry-run)
//   Fire-and-forget sweep over the WHOLE missing-email cohort (~700 agents).
//   Dry-run records every finding to search_enrich_findings and writes NOTHING
//   to contact data. apply=true additionally writes ONLY write-tier rows
//   (fill-empty-only). 503 if no Brave key; 409 if a sweep is already running.
// GET  /admin/search-enrich/sweep            → job status + counts + processed/total
// GET  /admin/search-enrich/findings         → page the findings table for review
// POST /admin/search-enrich/apply-findings   → write ONLY write-tier findings (gated)

router.post("/sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const applyRaw = body["apply"] ?? req.query["apply"];
  const apply =
    applyRaw === true || applyRaw === "1" || applyRaw === "true";

  const result = startSearchEnrichSweep({ apply, db: getDb() });

  if (!result.started) {
    if (result.reason === "no_brave_key") {
      res.status(503).json({ error: "BRAVE_API_KEY not configured" });
      return;
    }
    // already_running → 409 with the current job for observability.
    res.status(409).json({
      error: "search-enrich sweep already running",
      reason: result.reason,
      job: getSearchEnrichSweepJob(),
    });
    return;
  }

  res.json({
    run_id: result.run_id,
    total: result.total,
    status: result.status,
    apply,
    note: "Sweep running in background. Poll GET /admin/search-enrich/sweep for progress.",
  });
});

router.get("/sweep", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ job: getSearchEnrichSweepJob() });
});

router.get("/findings", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  ensureFindingsTable(db);

  const tierRaw = String(req.query["tier"] ?? "").toLowerCase();
  const tier =
    tierRaw === "write" || tierRaw === "queue" || tierRaw === "none" ? tierRaw : null;

  const FINDINGS_DEFAULT_LIMIT = 100;
  const FINDINGS_MAX_LIMIT = 500;
  let limit = FINDINGS_DEFAULT_LIMIT;
  const rawLimit = req.query["limit"];
  if (rawLimit !== undefined && !isNaN(Number(rawLimit)) && Number(rawLimit) > 0) {
    limit = Math.min(Math.floor(Number(rawLimit)), FINDINGS_MAX_LIMIT);
  }
  let offset = 0;
  const rawOffset = req.query["offset"];
  if (rawOffset !== undefined && !isNaN(Number(rawOffset)) && Number(rawOffset) >= 0) {
    offset = Math.floor(Number(rawOffset));
  }

  const where = tier ? "WHERE tier = ?" : "";
  const rows = db
    .prepare(
      `SELECT agent_id, name, query, tier, candidate_email, source_url,
              confirm_strength, signals, email_reason, run_id, created_at
         FROM search_enrich_findings
         ${where}
         ORDER BY created_at DESC, agent_id ASC
         LIMIT ? OFFSET ?`,
    )
    .all(...(tier ? [tier, limit, offset] : [limit, offset])) as Array<Record<string, unknown>>;

  // Parse signals JSON for the caller's convenience.
  const parsed = rows.map((r) => {
    let signals: unknown = [];
    try {
      signals = JSON.parse(String(r["signals"] ?? "[]"));
    } catch {
      signals = [];
    }
    return { ...r, signals };
  });

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM search_enrich_findings ${where}`)
      .get(...(tier ? [tier] : [])) as { n: number }
  ).n;

  // Per-tier totals for the review dashboard.
  const byTierRows = db
    .prepare(`SELECT tier, COUNT(*) AS n FROM search_enrich_findings GROUP BY tier`)
    .all() as Array<{ tier: string; n: number }>;
  const totals_by_tier: Record<string, number> = { write: 0, queue: 0, none: 0 };
  for (const r of byTierRows) totals_by_tier[r.tier] = r.n;

  res.json({
    tier: tier ?? "all",
    limit,
    offset,
    total,
    totals_by_tier,
    rows: parsed,
  });
});

router.post("/apply-findings", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const result = applyFindings(db);
  res.json(result);
});

// ─── provenance write (mirrors PR-7 homepage-provenance + admin-knowledge) ────
//
// Writes the producer email (and website=chosen_url when website is empty) using
// the SAME field_provenance merge path the enrichment SKILL uses. NEVER
// overwrites a non-empty existing value. source_type = `web_search:<domain>`.
function applyWrite(
  db: ReturnType<typeof getDb>,
  t: TargetAgent,
  email: string,
  chosenUrl: string | null,
  nowIso: string,
): void {
  // Delegates to the shared fill-empty-only + provenance write path used by the
  // sweep and apply-findings, so there is a single source of truth for writes.
  applyEnrichWrite(db, t.agent_id, email, chosenUrl, nowIso);
}

export default router;

// Re-export pure helpers used by tests / callers that import from the route.
export { nameStems };
