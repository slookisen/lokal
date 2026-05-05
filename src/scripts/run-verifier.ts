// ─── src/scripts/run-verifier.ts — Phase 5 verifier runner ─────────
//
// Standalone entry-point for lokal-agent-verifier. The library at
// src/agents/lokal-agent-verifier.ts only exports functions; this
// runner imports + invokes runVerifierBatch().
//
// Time-window: 22:00-06:00 UTC. Fly --schedule only accepts hourly,
// so this script runs 24×/day but skips 15 of those (outside window).
// Set FORCE_RUN=1 to bypass for manual ad-hoc testing.

import { runVerifierBatch, buildRunEnvelope } from "../agents/lokal-agent-verifier";

const ADMIN_KEY = process.env.ADMIN_KEY;
const BASE = process.env.BASE_URL || "http://localhost:3000";
const BATCH_SIZE = parseInt(process.env.VERIFIER_BATCH_SIZE || "30", 10);

const ALLOWED_UTC_HOURS = [22, 23, 0, 1, 2, 3, 4, 5, 6];

async function main(): Promise<number> {
  const now = new Date();
  const hourUTC = now.getUTCHours();
  const forceRun = process.env.FORCE_RUN === "1";

  if (!ALLOWED_UTC_HOURS.includes(hourUTC) && !forceRun) {
    console.log(`[verifier-runner] Skipping — UTC hour ${hourUTC} outside 22-06 window`);
    return 0;
  }

  console.log(`[verifier-runner] Starting (hour=${hourUTC}, force=${forceRun}, batch=${BATCH_SIZE})`);

  let batchResult;
  let errorCount = 0;

  try {
    batchResult = await runVerifierBatch({ batchSize: BATCH_SIZE });
    console.log(`[verifier-runner] Run ID: ${batchResult.run_id}`);
    console.log(`[verifier-runner] Processed ${batchResult.results.length} agents`);
  } catch (err: any) {
    console.error(`[verifier-runner] Critical error:`, err?.message || err);
    return 1;
  }

  const results = batchResult.results;
  const passed = results.filter((r) => r.passed).length;
  const reviewRequired = results.filter((r) => r.new_verification_status === "review_required").length;
  const pendingVerify = results.filter((r) => r.new_verification_status === "pending_verify").length;
  const httpUnreachable = results.filter((r) => r.flags.includes("website_unreachable")).length;
  const brregInactive = results.filter((r) =>
    r.flags.some((f: string) => f === "brreg_inactive" || f === "brreg_konkurs")
  ).length;
  const pooledNew = results.filter((r) => r.outreach_eligible_at !== null).length;

  console.log(`[verifier-runner] passed=${passed} review=${reviewRequired} pending=${pendingVerify} unreachable=${httpUnreachable} brreg_inactive=${brregInactive} pool_added=${pooledNew}`);

  if (ADMIN_KEY) {
    try {
      const envelope = buildRunEnvelope({
        run_id: batchResult.run_id,
        started_at: batchResult.started_at,
        finished_at: batchResult.finished_at,
        results,
      });
      const resp = await fetch(`${BASE}/admin/runs`, {
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (resp.ok) {
        console.log(`[verifier-runner] Envelope posted: ${batchResult.run_id}`);
      } else {
        console.error(`[verifier-runner] Envelope POST failed: HTTP ${resp.status}`);
        errorCount++;
      }
    } catch (err: any) {
      console.error(`[verifier-runner] Envelope POST error:`, err?.message || err);
      errorCount++;
    }
  } else {
    console.warn(`[verifier-runner] No ADMIN_KEY — skipping envelope POST`);
  }

  console.log(`[verifier-runner] Done. Exit ${errorCount > 0 ? 1 : 0}`);
  return errorCount > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[verifier-runner] Unhandled error:`, err);
    process.exit(2);
  });
