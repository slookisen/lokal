// ─── Admin: owner beta numbers ──────────────────────────────────────────────
// A2A dev-request 2026-11-09-rfb-eierverktoy-beta-for-alle, slice S2.
// Mounted at /admin/owner-beta.
//
//   GET /admin/owner-beta/stats
//     { mode, cap, counts: { active, interested, opted_out }, tiers: { <feature>: <tier> } }
//     mode/cap: OWNER_BETA_MODE / OWNER_BETA_CAP as the code reads them;
//     counts: owner_beta_enrollment rows (vertical rfb) per status;
//     tiers: the tier each owner feature is enforced at (OWNER_FEATURE_TIERS,
//     with OWNER_BETA_MODE=all lifting beta to ga and product_import_outreach
//     capped at beta). Counts only — no names, ids or contact info.
//
// Auth: exactly like GET /admin/orders/cap-stats (requirePilotAdmin: X-Admin-Key
// against ADMIN_KEY / ANALYTICS_ADMIN_KEY; 401 wrong/missing, 503 unconfigured).

import { Router, Request, Response } from "express";
import { requirePilotAdmin } from "./admin-orders";
import { ownerBetaCap, ownerBetaMode } from "../owner-features/beta-mode";
import { betaEnrollmentCounts, OWNER_BETA_VERTICAL } from "../owner-features/beta-enrollment";
import { OWNER_FEATURE_KEYS, ownerFeatureEffectiveTier, type OwnerFeatureKey, type OwnerFeatureTier } from "../owner-features/feature-tiers";

const router = Router();

let _testDb: any = null;
/** Test hook: pin the DB the stats read (null = getDb()). */
export function __setAdminOwnerBetaTestDb(db: any): void { _testDb = db; }

router.get("/stats", (req: Request, res: Response) => {
  if (!requirePilotAdmin(req, res)) return;
  try {
    const env = process.env;
    const tiers = {} as Record<OwnerFeatureKey, OwnerFeatureTier>;
    for (const k of OWNER_FEATURE_KEYS) tiers[k] = ownerFeatureEffectiveTier(k, env);
    const counts = betaEnrollmentCounts(OWNER_BETA_VERTICAL, _testDb ?? undefined);
    res.json({ mode: ownerBetaMode(env), cap: ownerBetaCap(env), counts, tiers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
