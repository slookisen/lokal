// ─── /api/opplevelser/admin/gardssalg/test-provider/reviewer-state ──────────
// dev-request 2026-11-12-f1-felles-for-ai-kanalene, slice F1-5: the hidden,
// bookable gårdssalg test producer (see services/gardssalg-test-producer-
// reviewer.ts for what the target state is and why).
//
//   GET   → DRY-RUN, always. 200 { dry_run: true, provider_id, changes:
//           [{ field, old, new }], unchanged: [field] }. Writes nothing.
//   POST  → DRY-RUN unless `apply` is explicit (body { apply: true } / "1" /
//           "true", or ?apply=1 / ?apply=true — same parse as POST
//           /admin/gardssalg/test-provider's owner_email apply). With apply,
//           the plan is written in one transaction pinned to the test row,
//           with one gardssalg_content_audit row per changed field. Running
//           it again resets the row to the same state.
//
// Admin-key gated exactly like the sibling experiences admin routes
// (X-Admin-Key, 403 «Krever X-Admin-Key header»; copied, not shared — the
// convention in this repo). Target is only KNOWN_TEST_PROVIDER_ID: missing
// → 404, not flagged is_test_provider = 1 → 409, nothing written.
// Sends no e-mail. Mounted from routes/opplevelser.ts before "/:id".

import { Router, Request, Response, NextFunction } from "express";
import { getDb as getExpDb } from "../database/db-factory";
import {
  GARDSSALG_TEST_PRODUCER_EMAIL,
  applyTestProducerReviewerState,
  planTestProducerReviewerState,
  type ReviewerStatePlan,
} from "../services/gardssalg-test-producer-reviewer";

const router = Router();

export const REVIEWER_STATE_PATH = "/admin/gardssalg/test-provider/reviewer-state";

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

function isExplicitApply(req: Request): boolean {
  const b = req.body?.apply;
  const q = req.query?.apply;
  return b === true || b === 1 || b === "1" || b === "true" || q === "1" || q === "true";
}

function sendPlan(res: Response, plan: ReviewerStatePlan, dryRun: boolean): void {
  if (plan.status === "not_found") {
    res.status(404).json({ error: "Testprodusenten finnes ikke. Ingenting er skrevet.", provider_id: plan.provider_id });
    return;
  }
  if (plan.status === "not_test_provider") {
    res.status(409).json({
      error: "Nekter: raden er ikke flagget som testprodusent (is_test_provider != 1). Ingenting er skrevet.",
      provider_id: plan.provider_id,
    });
    return;
  }
  res.json({
    success: true,
    dry_run: dryRun,
    provider_id: plan.provider_id,
    test_email: GARDSSALG_TEST_PRODUCER_EMAIL,
    changes: plan.changes,
    unchanged: plan.unchanged,
  });
}

router.get(REVIEWER_STATE_PATH, requireAdmin, (_req: Request, res: Response) => {
  try {
    sendPlan(res, planTestProducerReviewerState(getExpDb("experiences")), true);
  } catch (err) {
    console.error("[test-provider reviewer-state] dry-run failed:", err);
    res.status(500).json({ error: "Kunne ikke lese testprodusenten", details: String(err) });
  }
});

router.post(REVIEWER_STATE_PATH, requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getExpDb("experiences");
    if (!isExplicitApply(req)) {
      sendPlan(res, planTestProducerReviewerState(db), true);
      return;
    }
    const applied = applyTestProducerReviewerState(db);
    if (applied.status === "ok") {
      console.log(
        `[test-provider reviewer-state] applied ${applied.changes.length} field(s) on ${applied.provider_id}: ` +
          applied.changes.map((c) => c.field).join(", "),
      );
    }
    sendPlan(res, applied, false);
  } catch (err) {
    console.error("[test-provider reviewer-state] apply failed:", err);
    res.status(500).json({ error: "Kunne ikke oppdatere testprodusenten", details: String(err) });
  }
});

export default router;
