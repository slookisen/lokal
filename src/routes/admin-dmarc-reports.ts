// ─── GET /admin/dmarc-reports/summary ─────────────────────────────────────
// dev-request 2026-11-26-innsyn-i-levering-dmarc-leveringsstatus-og-kontrollkopier,
// point 1 (AK2): the stored DMARC aggregate reports for rettfrabonden.com and
// opplevagent.no, summed per day (UTC date of the report period's start) and
// per submitter (reporter org), per platform domain. Read-only. No e-mail
// address appears in the output (none is stored; the reporter is an org name).
//
//   ?days=N   window in days, 1–366 (default 30), counted back from today (UTC)
//
// Auth: X-Admin-Key via admin-pool-blocker-explain's requireAdmin (same check
// as every admin route). Mounted under adminLimiter in index.ts.

import { Router, Request, Response } from "express";
import { requireAdmin } from "./admin-pool-blocker-explain";
import { summarizeDmarcReports } from "../services/dmarc-reports";

const router = Router();

export const DMARC_SUMMARY_DEFAULT_DAYS = 30;
export const DMARC_SUMMARY_MAX_DAYS = 366;

router.get("/summary", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = req.query.days;
  let days = DMARC_SUMMARY_DEFAULT_DAYS;
  if (raw !== undefined) {
    const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > DMARC_SUMMARY_MAX_DAYS) {
      res.status(400).json({ error: `days must be an integer 1–${DMARC_SUMMARY_MAX_DAYS}` });
      return;
    }
    days = n;
  }
  try {
    res.json({ ok: true, ...summarizeDmarcReports(days) });
  } catch (err: any) {
    console.error("[admin/dmarc-reports] summary failed:", err);
    res.status(500).json({ error: "summary failed" });
  }
});

export default router;
