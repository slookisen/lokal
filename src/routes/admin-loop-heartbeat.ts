// ─── Admin: loop heartbeat / watchdog ───────────────────────────
// Phase P1 (server-migration plan 2026-06-20). The autonomous control loop
// only progresses while Daniel's Cowork app is open, and nothing alerts when
// it silently stalls. This deterministic, in-app endpoint reads the run-ledger
// and reports whether the loop is alive; on demand (?alert=1) it emails an
// alert when a liveness watcher has been silent past its threshold during
// active hours. No LLM; read-only on the ledger (the only side effect is a
// best-effort alert email).
//
// Intended trigger: a thin Fly Machine cron that curls this endpoint (e.g.
// every 30 min with ?alert=1). Because the alert is gated on status==stalled,
// a healthy or paused loop sends nothing. The liveness logic lives in the pure,
// unit-tested services/loop-health.ts.
//
// All routes require X-Admin-Key.

import { Router, Request, Response } from "express";
import { listRecentRuns } from "../services/run-ledger";
import { emailService } from "../services/email-service";
import { computeLoopHealth, type LoopHealth } from "../services/loop-health";

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

function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function readHealth(req: Request): LoopHealth {
  const sinceHours = clampInt(req.query.since_hours, 6, 1, 48);
  const runs = listRecentRuns({ sinceHours, limit: 500 });
  return computeLoopHealth(runs, { nowMs: Date.now() });
}

function alertText(h: LoopHealth): string {
  const lines = h.watchers.map(
    (w) =>
      `  - ${w.agent}: ${
        w.ageMin === null ? "no run in window" : w.ageMin + " min ago"
      } (limit ${w.maxSilenceMin} min)${w.stalled ? "  ← STALLED" : ""}`,
  );
  return [
    `The RFB autonomous control loop appears STALLED as of ${h.now}.`,
    `Silent watchers: ${h.stalledAgents.join(", ") || "(none)"}.`,
    ``,
    `Watchers:`,
    ...lines,
    ``,
    `If the Cowork app / scheduler is closed, reopen it (or check the Fly spine).`,
  ].join("\n");
}

// POST /admin/loop-heartbeat?alert=1&since_hours=6
//   Computes loop health; if stalled AND ?alert=1, emails ADMIN_NOTIFICATION_EMAIL.
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const health = readHealth(req);
    const wantAlert = req.query.alert === "1" || req.query.alert === "true";
    let alerted = false;
    let alertDetail: { success: boolean; messageId?: string; error?: string } | null = null;

    if (health.status === "stalled" && wantAlert) {
      const to = process.env.ADMIN_NOTIFICATION_EMAIL || "";
      if (to) {
        const text = alertText(health);
        alertDetail = await emailService.sendEmail({
          to,
          subject: `⚠️ RFB loop-heartbeat STALLED: ${health.stalledAgents.join(", ")}`,
          htmlContent: `<pre>${text.replace(/</g, "&lt;")}</pre>`,
          textContent: text,
        });
        alerted = !!alertDetail.success && alertDetail.messageId !== "DRY_RUN";
      }
    }

    res.json({
      success: true,
      ...health,
      alert_requested: wantAlert,
      alerted,
      alert_detail: alertDetail,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// GET /admin/loop-heartbeat — read-only status (never alerts)
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ success: true, ...readHealth(req) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
