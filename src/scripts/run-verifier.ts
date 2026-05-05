// ─── src/scripts/run-verifier.ts — Phase 5 verifier runner ─────────
//
// Standalone entry-point for lokal-agent-verifier. The library at
// src/agents/lokal-agent-verifier.ts only exports functions; this
// runner imports + invokes runVerifierBatch() so it can be triggered
// via `npx tsx src/scripts/run-verifier.ts` or Fly Machines cron.
//
// Usage:
//   npx tsx src/scripts/run-verifier.ts
//
// Or on Fly:
//   flyctl ssh console --app lokal --command "npx tsx /app/src/scripts/run-verifier.ts"
//
// Env vars expected:
//   - ANTHROPIC_API_KEY (set as Fly secret 2026-05-05)
//   - ADMIN_KEY (already on lokal app)
//   - DB_PATH (already configured to /app/data/lokal.db)
//
// On completion, this script:
//   1. Logs summary to stdout (visible via `flyctl logs`)
//   2. POSTs run-envelope to /admin/runs (consumed by platform-verifier)
//   3. Exits 0 on success, 1 on critical error

import { runVerifierBatch, buildRunEnvelope } from "../agents/lokal-agent-verifier";
import { getDb } from "../database/init";

const ADMIN_KEY = process.env.ADMIN_KEY;
const BASE = process.env.BASE_URL || "http://localhost:3000";
const BATCH_SIZE = parseInt(process.env.VERIFIER_BATCH_SIZE || "30", 10);

async function main(): Promise<number> {
  const runStartedAt = new Date().toISOString();
  const runId = `run-${runStartedAt.replace(/[:.]/g, "").slice(0, 15)}-lokal-agent-verifier-rfb`;

  console.log(`[verifier-runner] Starting ${runId}`);
  console.log(`[verifier-runner] Batch size: ${BATCH_SIZE}`);

  const db = getDb();

  let results: any[] = [];
  let errorCount = 0;

  try {
    const batchResult = await runVerifierBatch({
      db,
      batchSize: BATCH_SIZE,
      runStartedAt,
    });
    results = batchResult.results || [];
    console.log(`[verifier-runner] Processed ${results.length} agents`);
  } catch (err: any) {
    console.error(`[verifier-runner] Critical error:`, err?.message || err);
    errorCount++;
  }

  const finishedAt = new Date().toISOString();

  // Aggregate stats
  const passed = results.filter((r) => r.passed).length;
  const reviewRequired = results.filter((r) => r.new_verification_status === "review_required").length;
  const pendingVerify = results.filter((r) => r.new_verification_status === "pending_verify").length;
  const httpUnreachable = results.filter((r) => r.flags?.includes("website_unreachable")).length;
  const brregInactive = results.filter((r) =>
    (r.flags || []).some((f: string) => f === "brreg_inactive" || f === "brreg_konkurs")
  ).length;
  const pooledNew = results.filter((r) => r.outreach_eligible_at).length;

  console.log(`[verifier-runner] Stats: passed=${passed}, review_required=${reviewRequired}, pending=${pendingVerify}`);
  console.log(`[verifier-runner] http_unreachable=${httpUnreachable}, brreg_inactive=${brregInactive}, pool_added=${pooledNew}`);

  // Build + POST run-envelope
  if (ADMIN_KEY) {
    try {
      const envelope = buildRunEnvelope({
        runId,
        startedAt: runStartedAt,
        finishedAt,
        results,
      });

      const resp = await fetch(`${BASE}/admin/runs`, {
        method: "POST",
        headers: {
          "X-Admin-Key": ADMIN_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
      });

      if (resp.ok) {
        console.log(`[verifier-runner] Envelope posted: ${runId}`);
      } else {
        console.error(`[verifier-runner] Envelope POST failed: HTTP ${resp.status}`);
        errorCount++;
      }
    } catch (err: any) {
      console.error(`[verifier-runner] Envelope POST error:`, err?.message || err);
      errorCount++;
    }
  } else {
    console.warn(`[verifier-runner] No ADMIN_KEY in env — skipping envelope POST`);
  }

  console.log(`[verifier-runner] Done. Exit code: ${errorCount > 0 ? 1 : 0}`);
  return errorCount > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[verifier-runner] Unhandled error:`, err);
    process.exit(2);
  });
