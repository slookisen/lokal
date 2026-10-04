// ─── Admin: the RFB marketing lane switch + the manual daily run ─────────────
//
// dev-request 2026-09-19-rfb-marketing-utsending-inn-i-plattformjobben. The
// platform-side daily RFB outreach send (services/rfb-marketing-daily.ts) has
// exactly the two admin surfaces the Opplevagent lane has
// (GET/POST /api/opplevelser/admin/gardssalg-outreach-lane and POST
// .../gardssalg-outreach-daily-run, routes/opplevelser.ts), mounted next to
// the other RFB outreach levers in src/index.ts:
//
//   GET  /admin/rfb-marketing-lane       — lane state + the knobs the job runs with
//                                          (incl. transport_live — G1b)
//   POST /admin/rfb-marketing-lane       — {paused: boolean, by?, reason?}
//   POST /admin/rfb-marketing-daily-run  — {apply?: boolean}; absent/false = dry run
//
// Anyone with the admin key may pause (routines included, e.g. on a bounce);
// clearing a pause is Daniel's call. Same X-Admin-Key check (403) as the
// reference lane routes.
//
// Lifting a pause (paused:false while the lane IS paused) acknowledges every
// hard bounce / complaint G3 would see right now (bounce_ack_max_id moves up
// to the highest such email_bounces.id). Before, only G3's own auto-pause
// wrote the ack, so a pause set by a routine or a human on a bounce — the
// Opplevagent lane's 2026-10-03 case (dev-request 2026-10-03-opplevagent-
// lane-bounce-kvittering) — was re-set by G3 on the same bounce at the next
// run. A bounce that lands after the lift still pauses; a paused:false on a
// lane that is not paused acknowledges nothing. Same rule as
// POST /api/opplevelser/admin/gardssalg-outreach-lane.

import { Router, Request, Response, NextFunction } from "express";
import { getDb } from "../database/init";
import { resolveDailyOutreachCap } from "./crm";
import { emailService } from "../services/email-service";
import {
  RFB_MARKETING_DAILY_AGENT,
  RFB_MARKETING_DAILY_WINDOW_HOUR_UTC,
  RFB_MARKETING_DAILY_WINDOW_START_MINUTE_UTC,
  countRfbMarketingSentToday,
  findRfbMarketingRecentBounces,
  getRfbMarketingLaneState,
  isRfbMarketingPlatformEnabled,
  resolveRfbMarketingDailyCap,
  runRfbMarketingDaily,
  setRfbMarketingLanePaused,
  summarizeRfbMarketingLedgerDay,
  type RfbMarketingBounceHit,
} from "../services/rfb-marketing-daily";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = getAdminKey();
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (!expected || !provided || provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  next();
}

// ─── /admin/rfb-marketing-lane ─────────────────────────────────────────────
export const rfbMarketingLaneRouter = Router();

rfbMarketingLaneRouter.get("/", requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const now = new Date();
    res.json({
      ...getRfbMarketingLaneState(db),
      enabled_by_env: isRfbMarketingPlatformEnabled(),
      // false = SMTP not configured / forced dry-run: an apply run would skip
      // with transport_not_live (G1b) instead of "sending" DRY_RUNs.
      transport_live: emailService.isLiveTransport(),
      daily_cap: resolveRfbMarketingDailyCap(),
      outreach_max_per_day: resolveDailyOutreachCap(),
      window_hour_utc: RFB_MARKETING_DAILY_WINDOW_HOUR_UTC,
      window_start_minute_utc: RFB_MARKETING_DAILY_WINDOW_START_MINUTE_UTC,
      agent: RFB_MARKETING_DAILY_AGENT,
      sent_today: countRfbMarketingSentToday(db, now).total,
      ledger_today: summarizeRfbMarketingLedgerDay(db, now),
    });
  } catch (err) {
    console.error("[rfb-marketing-lane] GET failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

rfbMarketingLaneRouter.post("/", requireAdmin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { paused?: unknown; by?: unknown; reason?: unknown };
  if (typeof body.paused !== "boolean") {
    res.status(400).json({ error: "paused must be a boolean" });
    return;
  }
  const by = typeof body.by === "string" && body.by.trim() !== "" ? body.by.trim().slice(0, 120) : "admin-api";
  const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim().slice(0, 500) : null;
  try {
    const db = getDb();
    let acknowledged: RfbMarketingBounceHit[] = [];
    if (body.paused === false && getRfbMarketingLaneState(db).paused) {
      acknowledged = findRfbMarketingRecentBounces(db, new Date(), null);
    }
    const state = setRfbMarketingLanePaused(db, {
      paused: body.paused,
      by,
      reason,
      bounceAckMaxId: acknowledged.length > 0 ? Math.max(...acknowledged.map((b) => b.bounce_id)) : null,
    });
    console.log(
      `[rfb-marketing-lane] paused=${state.paused} by=${by}${reason ? ` reason=${reason}` : ""}` +
        (acknowledged.length > 0
          ? ` acknowledged_bounces=${acknowledged.map((b) => `${b.bounce_id}:${b.recipient_email}`).join(",")}`
          : ""),
    );
    res.json(body.paused === false ? { ...state, acknowledged_bounces: acknowledged } : state);
  } catch (err) {
    console.error("[rfb-marketing-lane] POST failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── /admin/rfb-marketing-daily-run ────────────────────────────────────────
// Runs the daily job on demand. `apply` absent/falsy = dry run (the default):
// guards evaluated, list + exact e-mail text computed, nothing written or
// sent. `apply: true` behaves exactly like the 08:10Z tick — within today's
// remaining budget, and still a no-op unless RFB_MARKETING_PLATFORM_ENABLED=1.
export const rfbMarketingDailyRunRouter = Router();

rfbMarketingDailyRunRouter.post("/", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { apply?: unknown };
  try {
    const report = await runRfbMarketingDaily({ apply: body.apply === true, trigger: "manual" });
    res.json(report);
  } catch (err) {
    console.error("[rfb-marketing-daily-run] failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
