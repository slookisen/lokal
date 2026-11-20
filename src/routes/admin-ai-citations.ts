// ─── Admin: AI citation panel (read-only) ───────────────────────────────────
//
// GET /admin/analytics/ai-citations[?week=2026-W43 | YYYY-MM-DD]
// GET /admin/analytics/ai-citations/status
//
// A2A dev-request 2026-10-16-siteringspanel, S5a/S5b. The first is one ISO
// week of the weekly panel (services/ai-citation/panel-runner.ts
// getAiCitationWeekView: per engine our citation share and top domains, per
// vertical the top cited domains, every result, cost_usd_total); `week` is an
// ISO week or any day of it (default: the current week). The second is the
// job's status (panel-job.ts getAiCitationPanelStatus: flag, active engines,
// caps, month_cost_usd, the week's progress). The visibility routine (A2A
// scheduled-agents/rfb-ai-visibility-growth.md, S5c) reads both.
//
// Read-only, no network: indexed SELECTs plus in-memory state. Its own router,
// mounted in src/index.ts before /admin/analytics with adminLimiter. Auth
// follows the analytics routes: X-Admin-Key against ADMIN_KEY (falling back to
// ANALYTICS_ADMIN_KEY), 503 when neither is set, 401 on a wrong key.

import { Router, Request, Response } from "express";
import { getAiCitationWeekView, parseAiCitationWeek } from "../services/ai-citation/panel-runner";
import { getAiCitationPanelStatus } from "../services/ai-citation/panel-job";

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

router.get("/status", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(getAiCitationPanelStatus());
  } catch (err: any) {
    console.error("[ai-citations] status view failed:", err?.name ?? "Error");
    res.status(500).json({ error: "ai citation status failed" });
  }
});

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = req.query.week;
  const week = typeof raw === "string" ? parseAiCitationWeek(raw) : null;
  if (raw !== undefined && week === null) {
    res.status(400).json({ error: "week must be an ISO week (2026-W43) or a date YYYY-MM-DD in it" });
    return;
  }
  try {
    res.json(getAiCitationWeekView({ week: week ?? undefined }));
  } catch (err: any) {
    console.error("[ai-citations] admin view failed:", err?.name ?? "Error");
    res.status(500).json({ error: "ai citation view failed" });
  }
});

export default router;
