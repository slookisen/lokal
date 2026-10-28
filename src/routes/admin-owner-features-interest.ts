// ─── Admin: GET /admin/owner-features/interest ───────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2e (v2 principle
// 2): «Interessetall per nøkkel kan leses av admin». Read-only: how many
// owners pressed «Gi meg beskjed» per planned («Planlagt») registry key, with
// the first and latest time. Counts only — no subject ids, no e-mail
// addresses. ?vertical= (default rfb). Same X-Admin-Key check as the sibling
// admin routes (copied, not shared — routes/admin-test-producer.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { ownerFeatureInterestCounts } from "../owner-features/interest";
import { OWNER_FEATURE_VERTICALS } from "../owner-features/resolve";

const router = Router();

// Copied (not shared) — same convention as every sibling admin-agents-* route.
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

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const raw = typeof req.query.vertical === "string" ? req.query.vertical : "rfb";
    if (!(OWNER_FEATURE_VERTICALS as readonly string[]).includes(raw)) {
      return res.status(400).json({ success: false, error: "unknown_vertical" });
    }
    const keys = ownerFeatureInterestCounts(raw, { db: getDb() });
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      success: true,
      vertical: raw,
      total: keys.reduce((n, k) => n + k.count, 0),
      keys,
    });
  } catch (e: any) {
    console.error("[admin-owner-features-interest] GET failed:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
});

export default router;
