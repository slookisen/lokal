// ─── Admin: Debio TRACES+Brreg cross-check (Phase 5.11 C.1-A, 2026-05-16) ──
//
// POST /admin/debio/cross-check
//   Synchronously runs the Debio cross-check pipeline. Pulls Debio-issued
//   organic operators from EU TRACES NT, reverse-looks-up the Norwegian
//   orgnumber via Brreg, matches to our existing producer agents, and
//   upserts pending-confirmation affiliations.
//
//   Returns:
//     {
//       success: boolean,
//       traces_fetched,
//       traces_filtered,
//       brreg_resolved,
//       agents_matched,
//       affiliations_upserted,
//       unmatched_persisted,
//       errors: string[],
//       since,
//       duration_ms
//     }
//
//   Query params:
//     since=YYYY-MM-DD   — only process TRACES records issued on/after this
//                          date. Defaults to 2026-01-01 (incremental).
//
// Auth: X-Admin-Key header (same key as other /admin/* endpoints).
//
// Run-time budget: a full historical run can exceed Fly's 120s proxy
// timeout. The default `since=2026-01-01` keeps incremental runs
// well below the limit. The response includes a `duration_ms` field
// so the caller can spot drift.

import { Router, Request, Response } from "express";
import { runDebioCrossCheck, DEFAULT_SINCE_ISO } from "../services/debio-cross-check";

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

// Validate `since` query param. Accepts YYYY-MM-DD or full ISO timestamp.
function parseSince(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_SINCE_ISO;
  const v = raw.trim();
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return DEFAULT_SINCE_ISO;
  return v;
}

router.post("/cross-check", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const since = parseSince(req.query.since);

  try {
    const result = await runDebioCrossCheck({ since });
    res.json({
      success: true,
      ...result,
      hint: "Re-run with ?since=YYYY-MM-DD to incrementalize; a full historical run can exceed the 120s proxy limit.",
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "Debio cross-check failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
