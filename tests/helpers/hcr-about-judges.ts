/**
 * Stub about judges for refreshHomepageContent (routes/admin-knowledge.ts,
 * dev-request 2026-10-28-rfb-uttrekk-adresse-og-hjemmeside-forverring,
 * skive B). Suites written before the judges existed test OTHER guards
 * (substantiation, organic claims, categories, parity, the morning send) and
 * expect an about candidate that clears those guards to be written; they run
 * with judges that approve everything, so their expectations stay as they
 * were. The judges' own behaviour is tested in
 * src/routes/homepage-content-refresh-about-judges.test.ts.
 */

import type { HcrAboutJudges } from "../../src/routes/admin-knowledge";

/** Quality GODKJENN, facts SUPPORTED, comparison BEDRE — no network. */
export const APPROVE_ALL_ABOUT_JUDGES: HcrAboutJudges = {
  quality: async () => ({ approved: true, reasoning: "stub: godkjent" }),
  facts: async () => ({ ok: true, supported: true, unsupportedClaims: [], bestPage: 0, reason: "stub: støttet" }),
  comparison: async () => ({ ok: true, better: true, verdict: "BEDRE", reasoning: "stub: bedre" }),
  timeoutMs: 1,
};

/** Install APPROVE_ALL_ABOUT_JUDGES for every caller; returns the restore function. */
export function useApproveAllAboutJudges(): () => void {
  // Lazy: the suites pin their in-memory DB before loading the route module.
  const mod = require("../../src/routes/admin-knowledge") as typeof import("../../src/routes/admin-knowledge");
  mod.__setHcrAboutJudgesForTesting(APPROVE_ALL_ABOUT_JUDGES);
  return () => mod.__setHcrAboutJudgesForTesting(null);
}
