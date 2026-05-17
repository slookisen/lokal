// ─── Admin: BM event-participants scraper endpoint (PR-71) ──────
//
// POST /admin/bm-events/scrape-participants
//   X-Admin-Key gated. Synchronously (or async via ?async=1) runs the
//   BM event-participant scraper and returns a
//   BmParticipantsScrapeResult. Mounted at /admin/bm-events in
//   src/index.ts (mirrors the existing admin-bm-events.ts pattern —
//   both routers share the /admin/bm-events prefix so the scraper and
//   participant-scraper sit side-by-side).
//
// Body shape (all optional):
//   {
//     event_ids?:    number[]   // explicit event id list
//     all_upcoming?: boolean    // process every upcoming event, no stale filter
//     dry_run?:      boolean    // skip writes; report counts only
//     async?:        boolean    // fire-and-forget via job-tracker
//     stale_days?:   number     // default 7; only used when neither
//                               // event_ids nor all_upcoming are set
//     max_events?:   number     // hard cap, default 500
//   }
//
// Default mode (no flags): process events where start_at >= now AND
// last_participants_scraped_at IS NULL OR < 7 days ago.

import { Router, Request, Response } from "express";
import { runBmEventParticipantsScraper } from "../services/bm-event-participants-scraper";
import { startJob } from "../services/job-tracker";

const router = Router();

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

router.post("/scrape-participants", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body || {}) as {
    event_ids?: number[];
    all_upcoming?: boolean;
    dry_run?: boolean;
    async?: boolean;
    stale_days?: number;
    max_events?: number;
  };

  // ── Body-shape validation ──
  // Type-checks first so a typo can't silently degrade to defaults.
  // Mirrors the PR-68 admin-hanen.ts batch-import validation pattern.
  if (body.event_ids !== undefined) {
    if (!Array.isArray(body.event_ids)
        || !body.event_ids.every(n => typeof n === "number" && Number.isFinite(n))) {
      res.status(400).json({
        success: false,
        error: "event_ids must be an array of numbers",
      });
      return;
    }
  }
  if (body.all_upcoming !== undefined && typeof body.all_upcoming !== "boolean") {
    res.status(400).json({
      success: false,
      error: "all_upcoming must be a boolean",
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
  if (body.async !== undefined && typeof body.async !== "boolean") {
    res.status(400).json({
      success: false,
      error: "async must be a boolean",
    });
    return;
  }
  if (body.stale_days !== undefined
      && (typeof body.stale_days !== "number" || !Number.isFinite(body.stale_days))) {
    res.status(400).json({
      success: false,
      error: "stale_days must be a finite number",
    });
    return;
  }
  if (body.max_events !== undefined
      && (typeof body.max_events !== "number" || !Number.isFinite(body.max_events))) {
    res.status(400).json({
      success: false,
      error: "max_events must be a finite number",
    });
    return;
  }

  const wantAsync = body.async === true || req.query.async === "1" || req.query.async === "true";

  const scraperOpts = {
    eventIds: body.event_ids,
    allUpcoming: body.all_upcoming,
    dryRun: body.dry_run,
    staleDays: body.stale_days,
    maxEvents: body.max_events,
  };

  if (wantAsync) {
    const dedupeKey = `eids=${(body.event_ids || []).join(",")};all=${!!body.all_upcoming};stale=${body.stale_days ?? 7}`;
    const job = startJob("bm-participants-scrape", async () => {
      return await runBmEventParticipantsScraper(scraperOpts);
    }, { dedupeKey });
    res.status(202).json({
      job_id: job.job_id,
      status: job.status,
      started_at: job.started_at,
      endpoint: job.endpoint,
      poll_url: `/admin/jobs/${job.job_id}`,
    });
    return;
  }

  try {
    const result = await runBmEventParticipantsScraper(scraperOpts);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      events_processed: 0,
      events_skipped: 0,
      participants_found: 0,
      affiliations_created: 0,
      affiliations_updated: 0,
      unmatched_logged: 0,
      errors: ["Scrape failed: " + (err?.message || String(err))],
    });
  }
});

export default router;
