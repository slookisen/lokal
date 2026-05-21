// ─── Admin: Bondens Marked Address Cleanup Endpoint ─────────────
//
// POST /admin/bm-address-cleanup
//
// One-shot endpoint that strips the bogus `Berrvellene 7, 6817 NAUSTDAL`
// smear from 21 Bondens Marked venue agents. See
// src/services/bm-address-cleanup.ts for the full backstory.
//
// Defaults to dry_run=1 — only actually writes when invoked with
// `?dry_run=0`. This mirrors the cautious posture of the other
// destructive admin endpoints (provenance cleanup, runs deletion).
//
// Auth: X-Admin-Key (uses the existing helper pattern from
// src/routes/admin-runs.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { cleanBmAddressBug } from "../services/bm-address-cleanup";

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

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // Default to dry-run for safety. Only an explicit `?dry_run=0`
  // actually writes to the DB.
  const dryRunParam = String(req.query.dry_run ?? "1");
  const dryRun = dryRunParam !== "0";

  try {
    const db = getDb();
    const result = cleanBmAddressBug({ db, dryRun });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res
      .status(500)
      .json({ error: "Cleanup failed", detail: err?.message ?? String(err) });
  }
});

export default router;
