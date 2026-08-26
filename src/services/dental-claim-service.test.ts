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
  // ── slice3-01..05: default flipped to ON (dev-request 2026-07-29-blacklist-
  // backfill-og-berikelsestriage, slice 3, 2026-07-30) -- measured against six
  // consecutive daily reports that the completion-mode claim call (the only
  // mode running every day) never set excludeParkedExtraction, so clinics
  // parked by 3 consecutive extraction failures (e.g. "Jasleen Kaur Kainth" /
  // Sunntannhelse.no, re-flagged 5 separate days; "Spongdal Tannklinikk" and
  // "Leksvik Tannklinikk", explicitly logged as their 8th/6th attempt) kept
  // recirculating through the pool indefinitely. ─────────────────────────────
  {
    // omitted is now APPLIED (default-on) -- was a no-op pre-slice-3.
    const filterOmitted: ClaimFilter = { enrichment_state: "raw", has_hjemmeside: true };
    const { clause: clauseOmitted } = buildWhereClause(filterOmitted, NOW);
    assertTrue(
      norm(clauseOmitted).includes(
        "(extraction_unreachable_since IS NULL OR extraction_unreachable_since <= datetime('now','-30 days'))"
      ),
      "slice3-01: omitted excludeParkedExtraction now applies the 30d backoff exclusion by default"
    );
  }
  {
    // explicit false remains a no-op (opt-out escape hatch preserved).
    const filterFalse: ClaimFilter = { excludeParkedExtraction: false };
    const { clause: clauseFalse } = buildWhereClause(filterFalse, NOW);
    assertTrue(
      !norm(clauseFalse).includes("extraction_unreachable_since"),
      "slice3-02: excludeParkedExtraction=false remains a no-op (opt-out escape hatch)"
    );
  }
  {
    // env rollback flag disables the default-on behavior globally.
    const prev = process.env.DENTAL_EXTRACTION_PARKING_DISABLED;
    process.env.DENTAL_EXTRACTION_PARKING_DISABLED = "true";
    try {
      const { clause } = buildWhereClause({}, NOW);
      assertTrue(
        !norm(clause).includes("extraction_unreachable_since"),
        "slice3-03: DENTAL_EXTRACTION_PARKING_DISABLED=true reverts to no exclusion, even with the filter omitted"
      );
      const { clause: clauseExplicitTrue } = buildWhereClause({ excludeParkedExtraction: true }, NOW);
      assertTrue(
        !norm(clauseExplicitTrue).includes("extraction_unreachable_since"),
        "slice3-04: env rollback flag wins even when the caller explicitly requests excludeParkedExtraction:true"
      );
    } finally {
      if (prev === undefined) delete process.env.DENTAL_EXTRACTION_PARKING_DISABLED;
      else process.env.DENTAL_EXTRACTION_PARKING_DISABLED = prev;
    }
  }
  {
    // explicit true is unchanged (still applies, same as pre-slice-3).
    const filter: ClaimFilter = { excludeParkedExtraction: true };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes("extraction_unreachable_since"),
      "slice3-05: excludeParkedExtraction=true still applies the clause (regression pin, unchanged)"
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

  // ── dev-request 2026-07-16-dental-hjemmeside-url-vask, item 2 (nedlagt-
  // flagging): is_inactive exclusion is ALWAYS applied -- unlike
  // excludeParkedExtraction above, there is no opt-in filter flag; no caller
  // can opt out. ─────────────────────────────────────────────────────────
  {
    const filter: ClaimFilter = {};
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes("(is_inactive IS NULL OR is_inactive = 0)"),
      "nedlagt-01: is_inactive exclusion present with no filter at all (unconditional)"
    );
  }
  {
    // Present alongside every other filter combination -- no flag suppresses it.
    const filter: ClaimFilter = {
      enrichment_state: "enriched",
      verification_status: "verified",
      excludeParkedExtraction: true,
    };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes("(is_inactive IS NULL OR is_inactive = 0)"),
      "nedlagt-02: is_inactive exclusion present alongside every other filter (unconditional, no opt-out)"
    );
  }
  {
    // Even when the caller explicitly requests thin_site / needs_review /
    // rejected (which suppress the OTHER always-on exclusions above), the
    // is_inactive exclusion still applies -- it has no suppression condition.
    const filter: ClaimFilter = { enrichment_state: "thin_site", verification_status: "rejected" };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes("(is_inactive IS NULL OR is_inactive = 0)"),
      "nedlagt-03: is_inactive exclusion still applies even when thin_site/rejected are explicitly requested"
    );
  }

  // ── dev-request 2026-08-26-dental-dead-homepage-no-strike-counter
  // (2026-08-26): wiring the pre-existing (2026-07-16) homepage_unreachable_
  // since / homepage_fetch_attempts parking stamp (recordDentalHomepageFetch
  // Result(), dental-store.ts) onto this SAME excludeParkedExtraction flag --
  // see the ClaimFilter.excludeParkedExtraction doc comment and the inline
  // comment above the exclusion block in dental-claim-service.ts for the full
  // rationale. Mirrors the item2a (extraction) / wrong_entity clause checks
  // above at the buildWhereClause level first. ────────────────────────────
  {
    const filter: ClaimFilter = { excludeParkedExtraction: true };
    const { clause } = buildWhereClause(filter, NOW);
    assertTrue(
      norm(clause).includes(
        "(homepage_unreachable_since IS NULL OR homepage_unreachable_since <= datetime('now','-30 days'))"
      ),
      "hp-clause-01: excludeParkedExtraction=true adds the homepage 30d backoff exclusion clause"
    );
  }
  {
    // omitted is default-on -- same flag gates the homepage stamp too.
    const { clause } = buildWhereClause({ enrichment_state: "raw", has_hjemmeside: true }, NOW);
    assertTrue(
      norm(clause).includes("homepage_unreachable_since"),
      "hp-clause-02: omitted excludeParkedExtraction applies the homepage exclusion by default"
    );
  }
  {
    // explicit false remains a no-op (opt-out escape hatch preserved) for the homepage stamp too.
    const { clause } = buildWhereClause({ excludeParkedExtraction: false }, NOW);
    assertTrue(
      !norm(clause).includes("homepage_unreachable_since"),
      "hp-clause-03: excludeParkedExtraction=false remains a no-op for the homepage exclusion too"
    );
  }
  {
    // env rollback flag disables the homepage exclusion globally too (same var, no new flag).
    const prev = process.env.DENTAL_EXTRACTION_PARKING_DISABLED;
    process.env.DENTAL_EXTRACTION_PARKING_DISABLED = "true";
    try {
      const { clause } = buildWhereClause({}, NOW);
      assertTrue(
        !norm(clause).includes("homepage_unreachable_since"),
        "hp-clause-04: DENTAL_EXTRACTION_PARKING_DISABLED=true also reverts the homepage exclusion, even with the filter omitted"
      );
    } finally {
      if (prev === undefined) delete process.env.DENTAL_EXTRACTION_PARKING_DISABLED;
      else process.env.DENTAL_EXTRACTION_PARKING_DISABLED = prev;
    }
  }
  {
    // composition with an existing filter (has_hjemmeside) -- both clauses present
    const { clause } = buildWhereClause({ excludeParkedExtraction: true, has_hjemmeside: true }, NOW);
    const c = norm(clause);
    assertTrue(c.includes("homepage_unreachable_since"), "hp-clause-05: homepage exclusion present alongside has_hjemmeside");
    assertTrue(
      c.includes("hjemmeside IS NOT NULL AND hjemmeside <> ''"),
      "hp-clause-06: has_hjemmeside=true clause still present alongside the homepage exclusion"
    );
  }

  // ── same dev-request: end-to-end proof against real DB rows via
  // claimBatch() -- a clause-substring check alone doesn't prove a row
  // stamped "now" is actually excluded and a row stamped >30 days ago is
  // actually still claimable, so this exercises the real claim pool.
  // Follows the exact isolated-DB setup/teardown idiom used elsewhere for
  // this same claim pool (tests/test.ts's "item2a" block and
  // dental-wrong-entity-streak.test.ts): DENTAL_DB_PATH=":memory:",
  // require-cache-busted fresh dental-store/dental-claim-service, and
  // __resetDbFactoryForTesting() in a try/finally. ─────────────────────────
  {
    const prevPath = process.env.DENTAL_DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";

    const dbFacPathHp = require.resolve("../database/db-factory");
    const dentalStorePathHp = require.resolve("./dental-store");
    const dentalClaimPathHp = require.resolve("./dental-claim-service");
    delete require.cache[dbFacPathHp];
    delete require.cache[dentalStorePathHp];
    delete require.cache[dentalClaimPathHp];

    const dbFacHp = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFacHp.__resetDbFactoryForTesting();
    const dstoreHp = require("./dental-store") as typeof import("./dental-store");
    const { claimBatch: claimBatchHp, releaseBatch: releaseBatchHp } =
      require("./dental-claim-service") as typeof import("./dental-claim-service");

    try {
      const dentalDbHp = dbFacHp.getDb("dental");

      const idParked = dstoreHp.createDentalAgent({ navn: "Dod Hjemmeside AS", org_nr: "911500111" } as any);
      const idExpired = dstoreHp.createDentalAgent({ navn: "Utlopt Hjemmeside-Parkering AS", org_nr: "911500222" } as any);
      const idClean = dstoreHp.createDentalAgent({ navn: "Frisk Hjemmeside AS", org_nr: "911500333" } as any);

      // idParked: 3 strikes, stamped right now -- actively parked.
      dentalDbHp
        .prepare("UPDATE dental_agents SET homepage_fetch_attempts = 3, homepage_unreachable_since = ? WHERE id = ?")
        .run(new Date().toISOString(), idParked);
      // idExpired: 3 strikes, but the stamp is >30 days old -- backoff expired.
      dentalDbHp
        .prepare("UPDATE dental_agents SET homepage_fetch_attempts = 3, homepage_unreachable_since = ? WHERE id = ?")
        .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), idExpired);

      const claimedHp = claimBatchHp("hp-worker1", 10, { excludeParkedExtraction: true }).map((c: any) => c.id);
      assertTrue(!claimedHp.includes(idParked), "hp-db-01: homepage_unreachable_since=now excluded by excludeParkedExtraction:true");
      assertTrue(claimedHp.includes(idExpired), "hp-db-02: homepage_unreachable_since >30 days ago still claimable");
      assertTrue(claimedHp.includes(idClean), "hp-db-03: never-parked row included");
      releaseBatchHp("hp-worker1", [idParked, idExpired, idClean]);

      // omitted (default-on) also applies -- same flag gates the homepage stamp too.
      const claimedHpDefault = claimBatchHp("hp-worker2", 10, {}).map((c: any) => c.id);
      assertTrue(
        !claimedHpDefault.includes(idParked),
        "hp-db-04: omitted excludeParkedExtraction excludes the homepage-parked row by default"
      );
      releaseBatchHp("hp-worker2", [idParked, idExpired, idClean]);

      // explicit opt-out still works for the homepage stamp too.
      const claimedHpOptOut = claimBatchHp("hp-worker3", 10, { excludeParkedExtraction: false }).map((c: any) => c.id);
      assertTrue(
        claimedHpOptOut.includes(idParked),
        "hp-db-05: excludeParkedExtraction:false opts out of the homepage exclusion too"
      );
      releaseBatchHp("hp-worker3", [idParked, idExpired, idClean]);
    } catch (err) {
      failed++;
      failures.push(
        `homepage-parking claim-pool exclusion: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`
      );
    } finally {
      if (prevPath === undefined) delete process.env.DENTAL_DB_PATH;
      else process.env.DENTAL_DB_PATH = prevPath;
      dbFacHp.__resetDbFactoryForTesting();
      delete require.cache[dbFacPathHp];
      delete require.cache[dentalStorePathHp];
      delete require.cache[dentalClaimPathHp];
    }
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
