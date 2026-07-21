// ─── Admin: Salgskanal auto-matcher sweep ────────────────────────────────
// (dev-request 2026-07-06-rfb-salgskanal-kategorier, datamodel+matcher slice)
//
// POST /admin/salgskanal/sync
//   Synchronously runs runSalgskanalSweep() (src/services/salgskanal-matcher.ts)
//   over the active producer corpus, auto-tagging membership in the 5
//   salgskanal categories (Selvplukk / Hjemlevering / Gårdsbutikk /
//   Gårdskafé-servering / REKO-ring) into agent_salgskanal. Idempotent —
//   re-running only refreshes 'auto' rows and removes 'auto' rows that no
//   longer match; 'manual' rows (admin overrides) are never touched.
//
//   Mirrors the shape of POST /admin/debio/sync (admin-debio-cross-check.ts):
//   synchronous, single round-trip over in-DB data (no external fetch), so
//   no async/job-tracker mode is needed here.
//
// Auth: X-Admin-Key header (same pattern as the other /admin/* endpoints).
//
// Scope note: this endpoint + the underlying sweep are the datamodel/
// auto-matcher slice (work items 1-2 of the dev-request's Spec). The public
// category landing pages (/kategori, /kategori/:slug in routes/seo.ts),
// homepage "Bla etter salgskanal" section, and the AI-discovery surface
// (GET /api/marketplace/salgskanal[/:slug] in routes/marketplace.ts + the
// lokal_salgskanal MCP tool) — work items 3-5 — shipped as a follow-up slice
// (2026-07-21) and read the same agent_salgskanal table this sweep maintains.

import { Router, Request, Response } from "express";
import { runSalgskanalSweep } from "../services/salgskanal-matcher";

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

router.post("/sync", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = runSalgskanalSweep();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: "Salgskanal sync failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
