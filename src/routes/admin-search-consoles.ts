// ─── Admin: GSC and Bing weekly numbers (read-only) ─────────────────────────
//
// GET /admin/analytics/search-consoles[?week=YYYY-MM-DD]
//
// A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c. One week's rows per
// domain from Google Search Console and Bing Webmaster Tools, as the weekly
// job in services/search-console-fetch.ts stored them in search_console_weekly,
// or an explicit `unavailable` reason per domain and source (and `ui_only`
// for the AI numbers only the console UI has); plus bing.sitemaps per domain
// and the same connection and fetch status /health shows.
// `week` is any day of the wanted Monday–Sunday week (default: the latest
// complete week). The visibility routine
// (A2A scheduled-agents/rfb-ai-visibility-growth.md, S6d) reads it.
//
// Read-only, no network: one indexed SELECT plus the in-memory status. Its own
// router (not routes/analytics.ts) so it does not collide with open work there;
// mounted in src/index.ts before /admin/analytics with adminLimiter. Auth
// follows the analytics routes: X-Admin-Key against ADMIN_KEY (falling back to
// ANALYTICS_ADMIN_KEY), 503 when neither is set, 401 on a wrong key.

import { Router, Request, Response } from "express";
import { getSearchConsoleWeekView } from "../services/search-console-fetch";
import { isDay } from "../services/traffic-history-compute";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Analytics not configured: ANALYTICS_ADMIN_KEY not set" });
    return false;
  }
  if (req.headers["x-admin-key"] !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = req.query.week;
  if (raw !== undefined && (typeof raw !== "string" || !isDay(raw))) {
    res.status(400).json({ error: "week must be a date YYYY-MM-DD (any day of the week; its Monday is used)" });
    return;
  }
  try {
    res.json(getSearchConsoleWeekView({ week: raw as string | undefined }));
  } catch (err: any) {
    console.error("[search-consoles] admin view failed:", err?.name ?? "Error");
    res.status(500).json({ error: "search console view failed" });
  }
});

export default router;
