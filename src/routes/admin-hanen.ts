// ─── Admin + public Hanen endpoints (Phase 5.11 C.2, 2026-05-16) ────
//
// Two routers exported from one file because both surfaces are small
// and share helper functions / type shapes:
//
//   adminRouter (default export)
//     POST /scrape  — X-Admin-Key gated. Synchronously runs
//                     runHanenScraper() and returns a HanenScrapeResult.
//                     Mounted at /admin/hanen in src/index.ts.
//                     Same response shape as /admin/bm-events/scrape:
//                     {success, fetched, parsed, matched, unmatched,
//                      upserted, errors[]}.
//
//   publicRouter (named export)
//     GET /members  — Public read of Hanen-affiliated producer agents.
//                     No auth (same access tier as the rest of
//                     /api/marketplace). Returns only ACTIVE-status
//                     affiliations so pending_confirmation rows are
//                     hidden until the producer accepts. Mounted at
//                     /api/marketplace/hanen in src/index.ts.
//
// Idempotency + safety: see hanen-scraper.ts header.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { runHanenScraper, reclassifyHanenAffiliations, HANEN_MAX_PAGES_DEFAULT, HANEN_MAX_PAGES_HARD_CAP, HANEN_MAX_START_PAGE } from "../services/hanen-scraper";
import { startJob } from "../services/job-tracker";
import { slugify } from "../utils/slug";
import crypto from "crypto";

const adminRouter = Router();
const publicRouter = Router();

// ─── auth (matches admin-bm-events.ts / admin-affiliations.ts) ──
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

// ─── POST /admin/hanen/scrape ──────────────────────────────────
// Query params:
//   ?max_pages=N       — override the default page cap. Hard ceiling of
//                        HANEN_MAX_PAGES_HARD_CAP enforced server-side
//                        (20 today). Default HANEN_MAX_PAGES_DEFAULT (5).
//   ?start_page=N      — (PR-65) start crawling from page N. Default 1.
//                        Clamped at HANEN_MAX_START_PAGE (100). Use
//                        together with ?max_pages to chunk a full sweep:
//                        ?start_page=1&max_pages=5, then 6&5, 11&5, ...
//                        Page 1 is still fetched silently when
//                        startPage > 1 so the pagination-presence sniff
//                        keeps working.
//   ?async=1           — (PR-65) fire-and-forget: returns 202 + {job_id}
//                        immediately. Poll GET /admin/jobs/<job_id> for
//                        progress. Use this for any sweep larger than
//                        ~2 pages (Fly proxy timeout is ~120s).
//
// Why the cap rationale: Fly's HTTP proxy times the response out at
// 120s. One Hanen render takes ~60s (cold-start through the
// render-worker behind Cloudflare). So ~2 pages is "interactive"
// territory; everything above that should use ?async=1 OR be chunked
// via ?start_page=N&max_pages=N from a polling caller. The 20-page
// hard cap covers the full ~590-member Hanen corpus (~12 pages @
// ~50/page) with safety margin for re-renders.
//
// Body form (legacy, still supported): {maxPages: N} POST JSON body.
// Query form takes precedence when both are present.
adminRouter.post("/scrape", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // PR-67: ?re_classify_only=1 → skip the render-worker fetch and
  // re-run the v3 matcher against existing review_required rows.
  // Used for promoting MEDIUM affiliations to HIGH after the matcher
  // gains new signals; no Hanen pages are re-fetched.
  if (req.query.re_classify_only === "1" || req.query.re_classify_only === "true") {
    try {
      const r = reclassifyHanenAffiliations();
      res.json({
        mode: "re_classify_only",
        rows_examined: r.rows_examined,
        promoted: r.promoted,
        still_pending: r.still_pending,
        errors: r.errors,
      });
    } catch (err: any) {
      res.status(500).json({
        mode: "re_classify_only",
        rows_examined: 0,
        promoted: 0,
        still_pending: 0,
        errors: ["Re-classify failed: " + (err?.message || String(err))],
      });
    }
    return;
  }

  const body = (req.body || {}) as { maxPages?: number };
  // Query takes precedence over body. Accept both ?max_pages=N (snake)
  // and ?maxPages=N (camel) since admins from Postman/curl tend to mix.
  const qpRaw =
    (req.query.max_pages as string | undefined) ||
    (req.query.maxPages as string | undefined);
  const qpNum = qpRaw !== undefined ? parseInt(qpRaw, 10) : NaN;
  const requested =
    Number.isFinite(qpNum) && qpNum > 0
      ? qpNum
      : typeof body.maxPages === "number" && body.maxPages > 0
        ? body.maxPages
        : HANEN_MAX_PAGES_DEFAULT;
  const maxPages = Math.min(Math.max(1, Math.floor(requested)), HANEN_MAX_PAGES_HARD_CAP);

  // PR-65: ?start_page=N offset (default 1, clamped at HANEN_MAX_START_PAGE).
  const spRaw =
    (req.query.start_page as string | undefined) ||
    (req.query.startPage as string | undefined);
  const spNum = spRaw !== undefined ? parseInt(spRaw, 10) : NaN;
  const startPage = Math.min(
    Math.max(1, Number.isFinite(spNum) && spNum > 0 ? spNum : 1),
    HANEN_MAX_START_PAGE,
  );

  // PR-65: ?async=1 → fire-and-forget via the in-memory job tracker.
  const wantAsync = req.query.async === "1" || req.query.async === "true";

  const opts = { maxPages, startPage };

  if (wantAsync) {
    const dedupeKey = `start=${startPage}:max=${maxPages}`;
    const job = startJob("hanen-scrape", async () => {
      return await runHanenScraper(opts);
    }, { dedupeKey });
    return res.status(202).json({
      job_id: job.job_id,
      status: job.status,
      started_at: job.started_at,
      endpoint: job.endpoint,
      requested_max_pages: maxPages,
      start_page: startPage,
      hard_cap_max_pages: HANEN_MAX_PAGES_HARD_CAP,
      poll_url: `/admin/jobs/${job.job_id}`,
    });
  }

  try {
    const result = await runHanenScraper(opts);
    res.json({
      ...result,
      requested_max_pages: maxPages,
      start_page: startPage,
      hard_cap_max_pages: HANEN_MAX_PAGES_HARD_CAP,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      fetched: 0,
      parsed: 0,
      matched: 0,
      matched_high: 0,
      review_required: 0,
      rejected_location_mismatch: 0,
      unmatched: 0,
      upserted: 0,
      errors: ["Scrape failed: " + (err?.message || String(err))],
    });
  }
});

// ─── POST /admin/hanen/batch-import-unmatched ─────────────────
// Phase 5.11 B.2 (PR-68, 2026-05-17). Promotes rows from
// `hanen_unmatched_members` (Hanen-scrape rows that didn't fuzzy-match
// any existing producer) into brand-new `agents` rows so the standard
// `pending_verify` → enrichment → `verified` pipeline can pick them up.
//
// Conservative: default batch_size=10, hard cap 50. Highest-quality
// first (best_match_score DESC, created_at DESC). Idempotent — rows
// with `imported_agent_id` set are skipped.
//
// Body: { batch_size?: number, dry_run?: boolean }
// Returns: { success, imported, skipped, errors[], imported_agents[] }
//
// We KNOW these rows are Hanen members (they came from the Hanen
// scraper) so we auto-create an agent_affiliations row linking the new
// producer to the Hanen umbrella with status='active', source='scraped'.
// That short-circuits the owner-confirmation step which the
// Bondens-marked flow uses (where membership is less certain).
const HANEN_BATCH_DEFAULT = 10;
const HANEN_BATCH_MAX = 50;

adminRouter.post("/batch-import-unmatched", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body || {}) as { batch_size?: number; dry_run?: boolean };

  // Validate body shape — reject malformed types with 400 so a typo
  // doesn't silently degrade to defaults.
  if (body.batch_size !== undefined && (typeof body.batch_size !== "number" || !Number.isFinite(body.batch_size))) {
    res.status(400).json({
      success: false,
      error: "batch_size must be a finite number",
    });
    return;
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
    res.status(400).json({
      success: false,
      error: "dry_run must be a boolean",
    });
    return;
  }

  const requested = typeof body.batch_size === "number" ? Math.floor(body.batch_size) : HANEN_BATCH_DEFAULT;
  const batchSize = Math.min(Math.max(1, requested), HANEN_BATCH_MAX);
  const dryRun = body.dry_run === true;

  const db = getDb();

  // Hanen umbrella lookup mirrors hanen-scraper.ts. We do not hard-code
  // the UUID because seed scripts assign a fresh one per environment.
  let umbrella: { id: string } | undefined;
  try {
    umbrella = db.prepare(
      "SELECT id FROM agents WHERE (LOWER(name) LIKE 'hanen%' OR LOWER(name) = 'hanen') AND umbrella_type IS NOT NULL LIMIT 1"
    ).get() as { id: string } | undefined;
    if (!umbrella) {
      umbrella = db.prepare(
        "SELECT id FROM agents WHERE LOWER(name) LIKE 'hanen%' LIMIT 1"
      ).get() as { id: string } | undefined;
    }
  } catch (e) {
    res.status(503).json({
      success: false,
      error: "Hanen umbrella lookup failed: " + (e instanceof Error ? e.message : String(e)),
    });
    return;
  }
  if (!umbrella) {
    res.status(503).json({
      success: false,
      error: "Hanen umbrella agent not found — seed required",
    });
    return;
  }

  // SELECT candidates. imported_agent_id IS NULL guarantees we never
  // re-import a row, so this endpoint is safe to re-run.
  let candidates: Array<{
    id: number;
    parsed_name: string;
    parsed_website: string | null;
    parsed_location: string | null;
    best_match_score: number | null;
  }>;
  try {
    candidates = db.prepare(
      `SELECT id, parsed_name, parsed_website, parsed_location, best_match_score
         FROM hanen_unmatched_members
        WHERE imported_agent_id IS NULL
     ORDER BY COALESCE(best_match_score, 0) DESC, COALESCE(first_seen_at, '1970-01-01') DESC
        LIMIT ?`
    ).all(batchSize) as Array<{
      id: number;
      parsed_name: string;
      parsed_website: string | null;
      parsed_location: string | null;
      best_match_score: number | null;
    }>;
  } catch (e) {
    res.status(500).json({
      success: false,
      error: "Candidate SELECT failed: " + (e instanceof Error ? e.message : String(e)),
    });
    return;
  }

  const imported: Array<{ unmatched_id: number; agent_id: string; name: string; website: string | null }> = [];
  const errors: Array<{ unmatched_id: number; parsed_name: string; error: string }> = [];
  let skipped = 0;

  // Prepared statements — built once, run per row inside a transaction
  // so partial failure rolls back. SQLite better-sqlite3 transactions
  // are sync, which matches the request handler shape.
  const insertAgent = db.prepare(`
    INSERT INTO agents (
      id, name, description, provider, contact_email, url,
      role, api_key,
      is_active, is_verified, trust_score,
      created_at, last_seen_at
    ) VALUES (
      ?, ?, ?, 'hanen-import', '', ?,
      'producer', ?,
      1, 0, 0.5,
      datetime('now'), datetime('now')
    )
  `);
  const insertKnowledge = db.prepare(`
    INSERT INTO agent_knowledge (agent_id, website, verification_status, enrichment_status)
    VALUES (?, ?, 'pending_verify', 'thin')
  `);
  const insertAffiliation = db.prepare(`
    INSERT INTO agent_affiliations (
      producer_id, umbrella_id, status, source, notes, created_at, updated_at
    ) VALUES (
      ?, ?, 'active', 'scraped', ?, datetime('now'), datetime('now')
    )
  `);
  const markImported = db.prepare(
    `UPDATE hanen_unmatched_members SET imported_agent_id = ? WHERE id = ? AND imported_agent_id IS NULL`
  );

  const processOne = (row: typeof candidates[number]): { agent_id: string } | { error: string } => {
    // Duplicate-name guard — Hanen contains a few near-duplicates from
    // bad parses; do NOT create a second agent with the exact same name.
    const existing = db.prepare(
      "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) LIMIT 1"
    ).get(row.parsed_name) as { id: string } | undefined;
    if (existing) {
      return { error: `agent already exists with name="${row.parsed_name}" (id=${existing.id})` };
    }

    const agentId = crypto.randomUUID();
    const apiKey = `hnn_${crypto.randomBytes(24).toString("hex")}`;
    const website = row.parsed_website || "";
    const description = "Importert fra Hanen-medlemslisten — venter på verifisering";

    insertAgent.run(agentId, row.parsed_name, description, website, apiKey);
    insertKnowledge.run(agentId, row.parsed_website || null);
    insertAffiliation.run(
      agentId,
      umbrella!.id,
      JSON.stringify({
        imported_from: "hanen_unmatched_members",
        unmatched_id: row.id,
        best_match_score: row.best_match_score,
        parsed_location: row.parsed_location,
      })
    );
    markImported.run(agentId, row.id);
    return { agent_id: agentId };
  };

  if (dryRun) {
    // Same selection logic, no writes. Surface what WOULD happen.
    for (const row of candidates) {
      const existing = db.prepare(
        "SELECT id FROM agents WHERE LOWER(name) = LOWER(?) LIMIT 1"
      ).get(row.parsed_name) as { id: string } | undefined;
      if (existing) {
        skipped++;
        errors.push({
          unmatched_id: row.id,
          parsed_name: row.parsed_name,
          error: `would-skip: agent already exists (id=${existing.id})`,
        });
        continue;
      }
      imported.push({
        unmatched_id: row.id,
        agent_id: "(dry-run — would generate UUID)",
        name: row.parsed_name,
        website: row.parsed_website || null,
      });
    }
    res.json({
      success: true,
      dry_run: true,
      batch_size: batchSize,
      candidates: candidates.length,
      imported: imported.length,
      skipped,
      errors,
      imported_agents: imported,
    });
    return;
  }

  // Real run: wrap each row in its own transaction. Per-row rollback is
  // more useful than batch rollback because one bad parsed_name
  // shouldn't block the other 9 rows in the same batch.
  for (const row of candidates) {
    try {
      const tx = db.transaction(() => processOne(row));
      const result = tx();
      if ("error" in result) {
        skipped++;
        errors.push({ unmatched_id: row.id, parsed_name: row.parsed_name, error: result.error });
        continue;
      }
      imported.push({
        unmatched_id: row.id,
        agent_id: result.agent_id,
        name: row.parsed_name,
        website: row.parsed_website || null,
      });
    } catch (e) {
      errors.push({
        unmatched_id: row.id,
        parsed_name: row.parsed_name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  res.json({
    success: true,
    dry_run: false,
    batch_size: batchSize,
    candidates: candidates.length,
    imported: imported.length,
    skipped,
    errors,
    imported_agents: imported,
  });
});

// ─── GET /api/marketplace/hanen/members ────────────────────────
// Lists Hanen-confirmed members for client use. "Confirmed" means
// status='active' — i.e. the producer has accepted the umbrella tag
// via the owner-portal OR an admin promoted the inferred match. We
// intentionally hide status='pending_confirmation' so the public
// member list never claims a producer is in Hanen without consent.
publicRouter.get("/members", (req: Request, res: Response) => {
  try {
    const limitParam = parseInt((req.query.limit as string) || "50", 10);
    const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200);

    const db = getDb();

    // Look up Hanen umbrella once. Same name-based query as the scraper.
    const umbrella = db.prepare(
      "SELECT id, name FROM agents WHERE (LOWER(name) LIKE 'hanen%' OR LOWER(name) = 'hanen') LIMIT 1"
    ).get() as { id: string; name: string } | undefined;

    if (!umbrella) {
      // 200 with empty list (not 404) so the client UI can render
      // "no members yet" gracefully without treating this as an error.
      res.json({ count: 0, umbrella_slug: "hanen", members: [] });
      return;
    }

    const rows = db.prepare(`
      SELECT a.id, a.name, a.city, a.url,
             af.status, af.source, af.evidence_json, af.updated_at
      FROM agent_affiliations af
      INNER JOIN agents a ON a.id = af.producer_id
      WHERE af.umbrella_id = ?
        AND af.status = 'active'
        AND a.is_active = 1
      ORDER BY a.name ASC
      LIMIT ?
    `).all(umbrella.id, limit) as Array<{
      id: string;
      name: string;
      city: string | null;
      url: string | null;
      status: string;
      source: string;
      evidence_json: string | null;
      updated_at: string;
    }>;

    const members = rows.map((r) => {
      let parsedLocation: string | null = null;
      let parsedCategory: string | null = null;
      if (r.evidence_json) {
        try {
          const ev = JSON.parse(r.evidence_json);
          if (typeof ev.parsed_location === "string") parsedLocation = ev.parsed_location;
          if (typeof ev.parsed_category === "string") parsedCategory = ev.parsed_category;
        } catch { /* tolerate malformed evidence */ }
      }
      return {
        agent_id: r.id,
        name: r.name,
        slug: slugify(r.name),
        city: r.city,
        url: r.url,
        category: parsedCategory,
        location: parsedLocation,
        source: r.source,
        confirmed_at: r.updated_at,
      };
    });

    res.json({
      count: members.length,
      umbrella_slug: "hanen",
      umbrella_name: umbrella.name,
      members,
    });
  } catch (err: any) {
    // 503 (not 500) — mirrors /api/marketplace/bm-events: distinguish
    // "data layer not ready" from a coding bug.
    res.status(503).json({
      error: "hanen-members query failed",
      detail: err?.message || String(err),
    });
  }
});

export { publicRouter };
export default adminRouter;
