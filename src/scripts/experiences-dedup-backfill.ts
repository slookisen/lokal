// ─── src/scripts/experiences-dedup-backfill.ts — one-off dedup backfill ────
//
// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, work item 1.
//
// Runs the candidate-key dedup pass (src/services/experience-dedup.ts) once
// against the live experiences.db: groups rows by (provider identity,
// kommune, fuzzy title), picks the richest row in each group as canonical,
// stamps every other row's canonical_id, and stamps the canonical row's
// merged_from JSON array.
//
// Idempotent — safe to re-run: runDedupPass() only ever loads rows with
// canonical_id IS NULL, so a second run finds nothing left to merge in an
// already-processed group (a lone surviving canonical row) and makes zero
// writes.
//
// Usage:
//   EXPERIENCES_DB_PATH=/app/data/experiences.db npx tsx src/scripts/experiences-dedup-backfill.ts
//   (or just `npx tsx src/scripts/experiences-dedup-backfill.ts` in an env
//   where EXPERIENCES_DB_PATH / the default /app/data/experiences.db is already
//   the right target — mirrors run-verifier.ts's env-driven config style.)

import { getDb } from "../database/db-factory";
import { runDedupPass } from "../services/experience-dedup";

async function main(): Promise<number> {
  console.log("[experiences-dedup-backfill] starting");
  const db = getDb("experiences");

  const result = runDedupPass(db);

  console.log(
    `[experiences-dedup-backfill] groups_found=${result.groupsFound} rows_merged=${result.rowsMerged} canonical_rows=${result.canonicalIds.length}`
  );
  if (result.canonicalIds.length > 0) {
    console.log(`[experiences-dedup-backfill] canonical ids: ${result.canonicalIds.join(", ")}`);
  }
  console.log("[experiences-dedup-backfill] done");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[experiences-dedup-backfill] Unhandled error:", err);
    process.exit(1);
  });
