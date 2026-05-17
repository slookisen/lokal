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
