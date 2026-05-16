// ─── Admin: Bondens marked events scraper endpoint (PR-56) ──────
//
// POST /admin/bm-events/scrape
//   Synchronously runs the scraper pipeline and returns a ScrapeResult JSON.
//   Used by:
//     - Cowork scheduled-task (daily 05:00 UTC)
//     - Daniel for ad-hoc runs
//
// X-Admin-Key auth (same key as /admin/runs).

import { Router, Request, Response } from "express";
import { runBmEventsScraper } from "../services/bm-events-scraper";

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

router.post("/scrape", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body || {}) as { maxEvents?: number; useRenderWorker?: boolean };
  const maxEvents = typeof body.maxEvents === "number" && body.maxEvents > 0
    ? Math.min(body.maxEvents, 1000)
    : undefined;
  const useRenderWorker = body.useRenderWorker === true;

  try {
    const result = await runBmEventsScraper({ maxEvents, useRenderWorker });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "Scrape failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
