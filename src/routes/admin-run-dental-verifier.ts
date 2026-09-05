// ─── Admin: Trigger the dental verifier in small ("canary") batches ───────
//
// dental-verifier.ts (runDentalVerifierBatch, PR #795) was already built,
// reviewed and shipped, but has no way to be triggered in production except
// a standalone script gated behind an unset env var — nothing calls it.
// This route adds a small, admin-key-gated HTTP trigger so it can be run
// manually in small batches, mirroring the sibling RFB verifier's own
// admin-run-verifier.ts route (same requireAdmin/getAdminKey idiom, same
// general style). Deliberately does NOT mirror that route's window-hour
// gate, `force`, `skip_tick_lock`, `reprocess_review_queue` or
// `bias_growth` logic — those are RFB-specific and out of scope here; this
// route is for explicit, supervised calls only, with a much smaller batch
// cap (50, vs the RFB route's 100 / the service's own unrelated
// DEFAULT_DENTAL_VERIFIER_BATCH_SIZE=200 default for a future always-on
// scheduler).
//
// All endpoints require X-Admin-Key.

import { Router, Request, Response } from "express";
import { runDentalVerifierBatch as realRunDentalVerifierBatch } from "../services/dental-verifier";

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

// runDentalVerifierBatchImpl — mutable reference to the batch entrypoint,
// defaulting to the real, imported runDentalVerifierBatch. Test seam:
// __setRunDentalVerifierBatchForTesting lets this route's own test swap in
// a stub so the route's clamping/aggregation/auth logic can be exercised
// with no real DB/network — mirrors this codebase's existing convention of
// an injectable module-level seam (e.g. admin-dental-hjemmeside-
// discovery.ts's __setDentalWdFetchForTesting, admin-agents.ts's
// __setAgentsOrgNrBackfillFetchForTesting) rather than monkey-patching the
// required service module's exports object directly.
let runDentalVerifierBatchImpl: typeof realRunDentalVerifierBatch = realRunDentalVerifierBatch;

export function __setRunDentalVerifierBatchForTesting(fn?: typeof realRunDentalVerifierBatch): void {
  runDentalVerifierBatchImpl = fn ?? realRunDentalVerifierBatch;
}

// POST /admin/run-dental-verifier
//   Optional body: { batchSize?: number }
//   Optional query: ?batchSize=N
//   batchSize is clamped to [1, 50], defaulting to 20 when absent/unparseable
//   — a small, explicit canary cap, independent of the service's own
//   DEFAULT_DENTAL_VERIFIER_BATCH_SIZE (200).
//   Returns: { success, run_id, processed, by_new_verification_status,
//              website_ownership_summary, brreg_status_summary,
//              newly_inactive_count, review_reason_summary }
router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const batchSizeRaw = (req.body && req.body.batchSize) ?? req.query.batchSize;
    const batchSize = Math.min(Math.max(parseInt(String(batchSizeRaw), 10) || 20, 1), 50);

    const result = await runDentalVerifierBatchImpl({ batchSize });
    const results = result.results;

    const by_new_verification_status: Record<string, number> = {};
    const website_ownership_summary: Record<string, number> = {};
    const brreg_status_summary: Record<string, number> = {};
    const review_reason_summary: Record<string, number> = {};
    let newly_inactive_count = 0;

    for (const r of results) {
      by_new_verification_status[r.new_verification_status] =
        (by_new_verification_status[r.new_verification_status] ?? 0) + 1;

      const ownershipKey = r.website_ownership === null ? "null" : r.website_ownership;
      website_ownership_summary[ownershipKey] = (website_ownership_summary[ownershipKey] ?? 0) + 1;

      const brregKey = r.brreg_status === null ? "null" : r.brreg_status;
      brreg_status_summary[brregKey] = (brreg_status_summary[brregKey] ?? 0) + 1;

      if (r.new_is_inactive === true) newly_inactive_count++;

      if (r.verifier_review_reason !== null) {
        review_reason_summary[r.verifier_review_reason] =
          (review_reason_summary[r.verifier_review_reason] ?? 0) + 1;
      }
    }

    res.json({
      success: true,
      run_id: result.run_id,
      processed: results.length,
      by_new_verification_status,
      website_ownership_summary,
      brreg_status_summary,
      newly_inactive_count,
      review_reason_summary,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// GET /admin/run-dental-verifier — sanity check the endpoint is wired up
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json({ success: true, endpoint: "POST /admin/run-dental-verifier" });
});

export default router;
