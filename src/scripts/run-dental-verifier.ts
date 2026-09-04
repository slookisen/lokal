// ─── src/scripts/run-dental-verifier.ts — dental verifier runner ─────────
//
// Standalone entry-point for src/services/dental-verifier.ts, mirroring
// src/scripts/run-verifier.ts's shape (the RFB verifier runner) for the
// dental vertical: the library only exports functions, this runner
// imports + invokes runDentalVerifierBatch() and logs a summary.
//
// Unlike run-verifier.ts (which is scheduled by an external Fly Machine
// cron and self-gates on a UTC hour window, no env flag), the dev-request
// for THIS verifier explicitly asks for a new, dedicated env flag so the
// whole batch entrypoint can be turned on/off independently of any
// external scheduler config: DENTAL_VERIFIER_SCHEDULER_ENABLED. Mirrors
// the gating STYLE already used elsewhere in this codebase for a new
// scheduled routine (src/index.ts's own VERIFIER_SCHEDULER_ENABLED /
// PROFILE_TRANSLATIONS_WORKER_* in-process scheduler blocks: "gated OFF by
// default, read from process.env, any other value or omitting it is a
// no-op") -- applied here at the STANDALONE-SCRIPT level instead of
// inside src/index.ts, since dental_agents' verifier batch is a bounded,
// one-shot run (like run-verifier.ts itself), not a long-lived in-process
// interval.
//
// This is a NEW script -- src/scripts/run-verifier.ts (the RFB runner) is
// never modified.

import { runDentalVerifierBatch } from "../services/dental-verifier";

const BATCH_SIZE = parseInt(process.env.DENTAL_VERIFIER_BATCH_SIZE || "200", 10);

async function main(): Promise<number> {
  if (process.env.DENTAL_VERIFIER_SCHEDULER_ENABLED !== "1") {
    console.log("[dental-verifier-runner] Skipping — DENTAL_VERIFIER_SCHEDULER_ENABLED != \"1\"");
    return 0;
  }

  console.log(`[dental-verifier-runner] Starting (batch=${BATCH_SIZE})`);

  let batchResult;
  try {
    batchResult = await runDentalVerifierBatch({ batchSize: BATCH_SIZE });
    console.log(`[dental-verifier-runner] Run ID: ${batchResult.run_id}`);
    console.log(`[dental-verifier-runner] Processed ${batchResult.results.length} clinics`);
  } catch (err: any) {
    console.error(`[dental-verifier-runner] Critical error:`, err?.message || err);
    return 1;
  }

  const results = batchResult.results;
  const verified = results.filter((r) => r.new_verification_status === "verified").length;
  const needsReview = results.filter((r) => r.new_verification_status === "needs_review").length;
  const inactive = results.filter((r) => r.new_is_inactive).length;
  const websiteVerified = results.filter((r) => r.website_ownership === "verified").length;
  const websiteUnverified = results.filter((r) => r.website_ownership === "unverified").length;
  const specialistsVerified = results.filter((r) => r.specialists_verified).length;

  console.log(
    `[dental-verifier-runner] verified=${verified} needs_review=${needsReview} marked_inactive=${inactive} ` +
      `website_verified=${websiteVerified} website_unverified=${websiteUnverified} specialists_verified=${specialistsVerified}`
  );

  console.log(`[dental-verifier-runner] Done.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[dental-verifier-runner] Unhandled error:`, err);
    process.exit(2);
  });
