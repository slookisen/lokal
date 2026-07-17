/**
 * dental-claim-service.test.ts — unit tests for buildWhereClause()
 * (src/services/dental-claim-service.ts).
 *
 * PR-131 (2026-07-01): completion-mode already-complete exclusion.
 * Pins the fix for the "completion-mode pool stuck on head-of-list" bug
 * (supervisor-inbox/2026-07-01-headsup-dental-claim-batch-completion-mode-stuck.md):
 * when filter.enrichment_state === "enriched", rows already fully populated
 * on om_oss/treatments/opening_hours/specialists must be excluded from the
 * claim pool, while rows missing even one of those fields must remain
 * claimable. Also pins the pre-existing PR-108 (junk-exclusion), PR-120
 * (thin_site parking exclusion), and base raw+has_hjemmeside behaviour so
 * this change doesn't regress them.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-claim-service.test.ts
 *   2. Wired into the gate: tests/test.ts imports runDentalClaimServiceTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import { buildWhereClause, type ClaimFilter } from "./dental-claim-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalClaimServiceTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  // Normalise whitespace so we can assert on clause substrings regardless
  // of the template-literal indentation used in buildWhereClause().
  function norm(s: string): string {
    return s.replace(/\s+/g, " ").trim();
  }

  const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms for deterministic tests

  // ── PR-131: completion-mode already-complete exclusion ──────────────────
  {
    const filter: ClaimFilter = { enrichment_state: "enriched" };
    const { clause, params } = buildWhereClause(filter, NOW);
    const c = norm(clause);

    assertTrue(
      c.includes("NOT ( om_oss IS NOT NULL AND om_oss <> ''"),
      "PR-131: enrichment_state=enriched clause includes om_oss completeness check"
    );
    assertTrue(
      c.includes("treatments IS NOT NULL AND treatments <> '' AND treatments <> '[]'"),
      "PR-131: enrichment_state=enriched clause includes treatments completeness check ('' and '[]')"
    );
    assertTrue(
      c.includes(
        "opening_hours IS NOT NULL AND opening_hours <> '' AND opening_hours <> '[]' AND opening_hours <> '{}'"
      ),
      "PR-131: enrichment_state=enriched clause includes opening_hours completeness check ('', '[]', '{}')"
    );
    assertTrue(
      c.includes("specialists IS NOT NULL AND specialists <> '' AND specialists <> '[]'"),
      "PR-131: enrichment_state=enriched clause includes specialists completeness check ('' and '[]')"
    );
    assertTrue(params.includes("enriched"), "PR-131: params still include the enrichment_state bind value");
  }

  // ── PR-131: exclusion is gated -- only applies when enrichment_state === "enriched" ──
  {
    const rawFilter: ClaimFilter = { enrichment_state: "raw" };
    const { clause: rawClause } = buildWhereClause(rawFilter, NOW);
    assertTrue(
      !norm(rawClause).includes("om_oss IS NOT NULL"),
      "PR-131: enrichment_state=raw clause does NOT include the completion-mode completeness exclusion"
    );

    const thinFilter: ClaimFilter = { enrichment_state: "thin_site" };
    const { clause: thinClause } = buildWhereClause(thinFilter, NOW);
    assertTrue(
      !norm(thinClause).includes("om_oss IS NOT NULL"),
      "PR-131: enrichment_state=thin_site clause does NOT include the completion-mode completeness exclusion"
    );

    const noStateFilter: ClaimFilter = {};
    const { clause: noStateClause } = buildWhereClause(noStateFilter, NOW);
    assertTrue(
      !norm(noStateClause).includes("om_oss IS NOT NULL"),
      "PR-131: no enrichment_state filter does NOT include the completion-mode completeness exclusion"
    );
  }

  // ── PR-131: composes correctly with has_hjemmeside (completion-mode's real call shape) ──
  {
    const filter: ClaimFilter = { enrichment_state: "enriched", has_hjemmeside: true };
    const { clause } = buildWhereClause(filter, NOW);
    const c = norm(clause);
    assertTrue(c.includes("om_oss IS NOT NULL"), "PR-131: completeness exclusion present alongside has_hjemmeside");
    assertTrue(
      c.includes("hjemmeside IS NOT NULL AND hjemmeside <> ''"),
      "PR-131: has_hjemmeside=true clause still present alongside completeness exclusion"
    );
    assertTrue(c.includes("enrichment_state = ?"), "PR-131: enrichment_state = ? clause still present");
  }

  // ── Pre-existing PR-108: junk-exclusion unaffected ───────────────────────
  {
    const filter: ClaimFilter = { enrichment_state: "enriched" };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes(
        "(verification_status IS NULL OR verification_status NOT IN ('needs_review','rejected'))"
      ),
      "PR-108: junk-exclusion clause still present when verification_status filter is not supplied"
    );

    const filterWithStatus: ClaimFilter = {
      enrichment_state: "enriched",
      verification_status: "needs_review",
    };
    const { clause: clauseWithStatus } = buildWhereClause(filterWithStatus, NOW);
    assertTrue(
      !norm(clauseWithStatus).includes("verification_status NOT IN"),
      "PR-108: junk-exclusion suppressed when caller explicitly filters verification_status"
    );
  }

  // ── Pre-existing PR-120: thin_site parking exclusion unaffected ──────────
  {
    const filter: ClaimFilter = { enrichment_state: "enriched" };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes("(enrichment_state IS NULL OR enrichment_state != 'thin_site')"),
      "PR-120: thin_site parking exclusion still present for enrichment_state=enriched"
    );

    const thinFilter: ClaimFilter = { enrichment_state: "thin_site" };
    const { clause: thinClause } = buildWhereClause(thinFilter, NOW);
    assertTrue(
      !norm(thinClause).includes("enrichment_state != 'thin_site'"),
      "PR-120: thin_site parking exclusion suppressed when caller explicitly requests thin_site"
    );
  }

  // ── Base filter: raw + has_hjemmeside (unmodified) ───────────────────────
  {
    const filter: ClaimFilter = { enrichment_state: "raw", has_hjemmeside: true };
    const { clause, params } = buildWhereClause(filter, NOW);
    const c = norm(clause);
    assertTrue(c.includes("(worker_id IS NULL OR claimed_at < ?)"), "base: claim-availability clause present");
    assertTrue(c.includes("enrichment_state = ?"), "base: enrichment_state = ? clause present");
    assertTrue(
      c.includes("hjemmeside IS NOT NULL AND hjemmeside <> ''"),
      "base: has_hjemmeside=true clause present"
    );
    assertTrue(
      !c.includes("om_oss IS NOT NULL"),
      "base: raw filter does not pull in the completion-mode completeness exclusion"
    );
    assertTrue(params[0] === NOW - 30 * 60 * 1000, "base: claim-timeout param computed correctly");
    assertTrue(params.includes("raw"), "base: enrichment_state bind value present");
  }

  // ── item 2a: excludeParkedExtraction (dev-request 2026-07-12-dental-
  // enrichment-universe-growth-and-queue-hygiene) ──────────────────────────
  {
    const filter: ClaimFilter = { excludeParkedExtraction: true };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes(
        "(extraction_unreachable_since IS NULL OR extraction_unreachable_since <= datetime('now','-30 days'))"
      ),
      "item2a-01: excludeParkedExtraction=true adds the 30d backoff exclusion clause"
    );
  }
  {
    // default/omitted is a strict no-op
    const filterOmitted: ClaimFilter = { enrichment_state: "raw", has_hjemmeside: true };
    const { clause: clauseOmitted } = buildWhereClause(filterOmitted, NOW);
    assertTrue(
      !norm(clauseOmitted).includes("extraction_unreachable_since"),
      "item2a-02: omitted excludeParkedExtraction is a no-op (no extraction_unreachable_since clause)"
    );

    const filterFalse: ClaimFilter = { excludeParkedExtraction: false };
    const { clause: clauseFalse } = buildWhereClause(filterFalse, NOW);
    assertTrue(
      !norm(clauseFalse).includes("extraction_unreachable_since"),
      "item2a-03: excludeParkedExtraction=false is a no-op (regression pin)"
    );
  }
  {
    // composition with an existing filter (has_hjemmeside) -- both clauses present
    const filter: ClaimFilter = { excludeParkedExtraction: true, has_hjemmeside: true };
    const { clause } = buildWhereClause(filter, NOW);
    const c = norm(clause);
    assertTrue(c.includes("extraction_unreachable_since"), "item2a-04: excludeParkedExtraction present alongside has_hjemmeside");
    assertTrue(
      c.includes("hjemmeside IS NOT NULL AND hjemmeside <> ''"),
      "item2a-05: has_hjemmeside=true clause still present alongside excludeParkedExtraction"
    );
  }
  {
    // composition with the homepage-parking-analogous other filters (enrichment_state, verification_status)
    // still work unaffected when excludeParkedExtraction is also set.
    const filter: ClaimFilter = {
      excludeParkedExtraction: true,
      enrichment_state: "enriched",
      verification_status: "verified",
    };
    const { clause } = buildWhereClause(filter, NOW);
    const c = norm(clause);
    assertTrue(c.includes("extraction_unreachable_since"), "item2a-06: excludeParkedExtraction present alongside enrichment_state+verification_status");
    assertTrue(c.includes("enrichment_state = ?"), "item2a-07: enrichment_state = ? clause still present");
    assertTrue(c.includes("verification_status = ?"), "item2a-08: verification_status = ? clause still present");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/dental-claim-service.test.ts`
if (require.main === module) {
  console.log("── dental-claim-service unit tests ──");
  const r = runDentalClaimServiceTests({ log: true });
  console.log(`\ndental-claim-service: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
