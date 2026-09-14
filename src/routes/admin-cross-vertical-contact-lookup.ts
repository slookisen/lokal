// ─── Admin: Cross-Vertical Contact Lookup (read-only) ───────────────
//
// GET /cross-vertical-contact-lookup (mounted at bare /admin, see index.ts)
//
// dev-requests/2026-09-13-fjern-svar-kobles-ikke-paa-tvers-av-vertikaler.md
//
// Building block for the customer-service "fjern" (opt-out/removal) flow:
// given a contact email and the vertical it was just found/removed on,
// answers whether that SAME exact email has an active entry on one of the
// OTHER verticals (rfb / dental / experiences each run their own sqlite DB
// file with their own producer/agent table — there is no cross-vertical
// identity layer today). EXACT email match only — see
// services/cross-vertical-contact-lookup.ts for why fuzzy name/org matching
// is never used here.
//
// Strictly read-only: no INSERT/UPDATE/DELETE/ALTER anywhere in this file.
// Three small indexed-by-nothing-special point queries — no caching/de-dup
// machinery needed (unlike admin-db-table-sizes.ts's heavy dbstat scan).
//
// Auth follows the same convention as admin-db-table-sizes.ts: X-Admin-Key
// header, checked against ADMIN_KEY (falling back to ANALYTICS_ADMIN_KEY).

import { Router, Request, Response } from "express";
import { isCrmVertical } from "../services/crm-service";
import { findCrossVerticalEntriesByEmail } from "../services/cross-vertical-contact-lookup";

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

// ─── GET /cross-vertical-contact-lookup ──────────────────────────────
router.get("/cross-vertical-contact-lookup", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const email = typeof req.query.email === "string" ? req.query.email : "";
  if (!email.trim()) {
    res.status(400).json({ error: "Query param 'email' is required" });
    return;
  }

  const excludeVerticalRaw = req.query.exclude_vertical;
  if (!isCrmVertical(excludeVerticalRaw)) {
    res.status(400).json({
      error: "Query param 'exclude_vertical' must be one of rfb|dental|experiences",
    });
    return;
  }
  const excludeVertical = excludeVerticalRaw;

  try {
    const hits = findCrossVerticalEntriesByEmail(email, excludeVertical);
    res.json({
      success: true,
      email,
      exclude_vertical: excludeVertical,
      hits,
      hit_count: hits.length,
    });
  } catch (err: any) {
    res.status(500).json({
      error: "Cross-vertical lookup failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;
