// ─── Admin: domain-incoherent reconciliation (dev-request 2026-07-12-rfb-
// enrichment-pool-refill-and-waste-reduction, item 3, 2026-07-13) ──────────
//
// The daily PR-97 sweep (POST /admin/run-verifier?reprocess_review_queue=1,
// pickReviewQueueBatch in lokal-agent-verifier.ts) re-runs domainCoherenceCheck
// over the ~84-agent review_required/data_insufficient cohort every day and
// only ever re-flags them back to review_required — it never proposes or
// writes a fix, so it is a wasted daily re-drain over the same rows. These two
// endpoints systematize the manual 2026-07-05 fix into a repeatable pass:
//
//   GET  /admin/domain-reconciliation-audit  — read-only classification,
//        ZERO writes. Reports circular_scramble_detected /
//        stale_knowledge_website / manual_review_needed per agent + counts.
//   POST /admin/domain-reconciliation-sweep  — applies the classifier's
//        proposed fixes for the two high-confidence shapes (dry_run=true by
//        default; pass dry_run=false to write) and stamps
//        review_required_last_audited_at on every other visited row so
//        pickReviewQueueBatch's 21-day backoff can exclude it.
//
// All classification/write logic lives in services/domain-reconciliation.ts
// (kept there so it's independently unit-testable and shared between the two
// routes below without duplication).
//
// Auth: X-Admin-Key (same pattern as admin-outreach-pool / admin-knowledge).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  classifyReconciliationCohort,
  recheckProposedFix,
  applyReconciliationFix,
  stampReviewRequiredAudited,
  type ReconciliationAgentResult,
} from "../services/domain-reconciliation";

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

function summarize(results: ReconciliationAgentResult[]): Record<string, number> {
  return {
    circular_scramble_detected: results.filter((r) => r.classification === "circular_scramble_detected").length,
    stale_knowledge_website: results.filter((r) => r.classification === "stale_knowledge_website").length,
    manual_review_needed: results.filter((r) => r.classification === "manual_review_needed").length,
  };
}

// GET /admin/domain-reconciliation-audit
// Read-only. Runs domainCoherenceCheck + the circular/stale classifier over
// every review_required/data_insufficient agent. Never writes to the DB.
router.get("/domain-reconciliation-audit", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const results = classifyReconciliationCohort(db);
    res.json({
      success: true,
      count: results.length,
      summary: summarize(results),
      agents: results,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// Parse a query/body flag that accepts 1/0/true/false, defaulting to `def`
// when absent or unrecognised. Mirrors admin-verifier-review-queue.ts.
function parseBoolFlag(raw: unknown, def: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return def;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return def;
}

// POST /admin/domain-reconciliation-sweep
// dry_run defaults true — must pass dry_run=false (query or body) explicitly
// to write, mirroring the HOMEPAGE_PARKING_DISABLED rollback pattern from
// PR #248. On a real run (dry_run=false):
//   - circular_scramble_detected / stale_knowledge_website rows whose
//     proposed fix still passes a fresh domainCoherenceCheck re-check get the
//     atomic write (agents.url or agent_knowledge.website + field_provenance
//     + verification_status -> 'pending_verify', never straight to
//     'verified').
//   - every OTHER visited row (manual_review_needed, or a proposed fix that
//     FAILED the re-check) gets review_required_last_audited_at stamped to
//     now — always overwritten, never a conditional "only if null" write
//     (see database/init.ts migration comment for why that matters).
router.post("/domain-reconciliation-sweep", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const dryRunRaw =
      req.body && req.body.dry_run !== undefined ? req.body.dry_run : req.query.dry_run;
    const dryRun = parseBoolFlag(dryRunRaw, true);

    const nowIso = new Date().toISOString();
    const results = classifyReconciliationCohort(db);

    const applied: Array<{
      agent_id: string;
      classification: ReconciliationAgentResult["classification"];
      fix: ReconciliationAgentResult["proposed_fix"];
      related_agent_ids: string[];
    }> = [];
    const failedRecheck: string[] = [];
    const stampedNoFix: string[] = [];

    const run = () => {
      for (const r of results) {
        const isCorrectable =
          (r.classification === "circular_scramble_detected" ||
            r.classification === "stale_knowledge_website") &&
          !!r.proposed_fix;

        if (isCorrectable) {
          const fix = r.proposed_fix!;
          const recheckOk = recheckProposedFix(r, fix);
          if (!recheckOk) {
            failedRecheck.push(r.agent_id);
            if (!dryRun) stampReviewRequiredAudited(db, r.agent_id, nowIso);
            continue;
          }
          if (!dryRun) applyReconciliationFix(db, r, nowIso);
          applied.push({
            agent_id: r.agent_id,
            classification: r.classification,
            fix,
            related_agent_ids: r.related_agent_ids,
          });
        } else {
          // manual_review_needed (or a correctable classification whose
          // proposed_fix somehow came back null) — audited, no fix.
          stampedNoFix.push(r.agent_id);
          if (!dryRun) stampReviewRequiredAudited(db, r.agent_id, nowIso);
        }
      }
    };

    // Whole-sweep atomicity: either every write in this pass lands, or none
    // does (a mid-pass exception cannot leave a partially-applied cohort).
    if (dryRun) {
      run();
    } else {
      db.transaction(run)();
    }

    res.json({
      success: true,
      dry_run: dryRun,
      run_at: nowIso,
      visited: results.length,
      applied_count: applied.length,
      failed_recheck_count: failedRecheck.length,
      stamped_no_fix_count: stampedNoFix.length + failedRecheck.length,
      classification_counts: summarize(results),
      applied,
      failed_recheck: failedRecheck,
      stamped_no_fix: [...stampedNoFix, ...failedRecheck],
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
