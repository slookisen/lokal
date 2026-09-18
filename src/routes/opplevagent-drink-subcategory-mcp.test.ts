/**
 * opplevagent-drink-subcategory-mcp.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 5b (OpplevAgent
 * side).
 *
 * Covers:
 *   - DiscoverGardssalgInputSchema.producer_type's own description now names
 *     all six canonical drink-taxonomy.ts subcategories, including
 *     "gårdskafé" — missing from the tool's documentation before this slice
 *     even though the six-value list is exactly what Daniel asked for.
 *   - resolveGardssalgProducerTypeFilter() (drink-taxonomy.ts), the pure
 *     function discover_gardssalg's handler calls to turn a canonical
 *     spelling into every DB alias spelling.
 *   - end to end: searchGardssalgProviders() (experience-store.ts) — the
 *     SAME function the real MCP handler calls — actually returns the
 *     'mjøderi'-spelled row when filtered with the resolved array, against a
 *     real seeded in-memory experiences DB. Before this slice,
 *     GardssalgSearchFilter.producer_type only accepted a single exact
 *     string, so this filter combination was impossible to express at all.
 *
 * Harness mirrors opplevelser-gardssalg-contact-coverage.test.ts: fresh
 * require of db-factory + experience-store per run (EXPERIENCES_DB_PATH=
 * ":memory:"), fixtures inserted with a direct SQL INSERT.
 *
 * Exported runOpplevagentDrinkSubcategoryMcpTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/opplevagent-drink-subcategory-mcp.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runOpplevagentDrinkSubcategoryMcpTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  return (async () => {
    // ── Pure-function tests (no DB) ───────────────────────────────────────
    const {
      DRINK_SUBCATEGORIES,
      resolveGardssalgProducerTypeFilter,
    } = require("../services/drink-taxonomy") as typeof import("../services/drink-taxonomy");

    assertEq(
      resolveGardssalgProducerTypeFilter("mjød"),
      ["mjøderi", "mjoderi"],
      "p1: resolveGardssalgProducerTypeFilter('mjød') expands to both DB spellings",
    );
    assertEq(
      resolveGardssalgProducerTypeFilter("vingård"),
      ["vingård", "vingard"],
      "p2: …'vingård' expands to both spellings",
    );
    assertEq(
      resolveGardssalgProducerTypeFilter("gårdskafé"),
      ["gårdskafé", "gardskafe"],
      "p3: …'gårdskafé' expands to both spellings (new — absent from the pre-slice vocabulary entirely)",
    );
    assertEq(
      resolveGardssalgProducerTypeFilter("gardsbutikk"),
      "gardsbutikk",
      "p4: a non-canonical value passes through unchanged (single string, not an array)",
    );
    assertEq(
      resolveGardssalgProducerTypeFilter("mjøderi"),
      "mjøderi",
      "p5: a DB spelling typed directly (not the canonical 'mjød') also passes through unchanged",
    );

    // Schema documentation: describe() text names all six, including
    // gårdskafé, which the pre-slice description omitted.
    const { DiscoverGardssalgInputSchema } = require("./experiences-mcp") as typeof import("./experiences-mcp");
    const producerTypeDesc = String((DiscoverGardssalgInputSchema.producer_type as any)?.description || "");
    for (const sub of DRINK_SUBCATEGORIES) {
      assertTrue(producerTypeDesc.includes(sub),
        `d1: discover_gardssalg's producer_type description mentions "${sub}"`);
    }

    // ── End to end: real DB, the exact function the MCP handler calls ────
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    for (const p of [dbFactoryPath, storePath]) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, lat, lon,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @lat, @lon,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "gs-mjoderi", navn: "Fjellmjød Gård", fylke: "Innlandet", kommune: "Lillehammer",
        producer_type: "mjøderi", lat: 61.11, lon: 10.47,
      });
      insertProvider.run({
        id: "gs-mjoderi-alt", navn: "Vidde Mjoderi", fylke: "Innlandet", kommune: "Ringebu",
        producer_type: "mjoderi", lat: 61.5, lon: 10.16,
      });
      insertProvider.run({
        id: "gs-bryggeri", navn: "Fjellbekk Bryggeri", fylke: "Innlandet", kommune: "Lillehammer",
        producer_type: "bryggeri", lat: 61.11, lon: 10.46,
      });
      insertProvider.run({
        id: "gs-gardskafe", navn: "Sørover Gårdskafé", fylke: "Vestland", kommune: "Voss",
        producer_type: "gardskafe", lat: 60.63, lon: 6.42,
      });

      const { searchGardssalgProviders } = require("../services/experience-store") as
        typeof import("../services/experience-store");

      // The bug this slice fixes: filtering by the spec's own canonical
      // spelling "mjød" through the single-string filter used to match zero
      // rows (exact string equality against 'mjøderi'/'mjoderi'). Now the
      // handler resolves it to an array first.
      const resolved = resolveGardssalgProducerTypeFilter("mjød");
      const mjodResults = searchGardssalgProviders({ producer_type: resolved }, 20);
      assertEq(
        mjodResults.map((r) => r.id).sort(),
        ["gs-mjoderi", "gs-mjoderi-alt"],
        "e1: searchGardssalgProviders({producer_type: resolved 'mjød'}) finds BOTH real DB spellings",
      );
      assertTrue(!mjodResults.some((r) => r.id === "gs-bryggeri"),
        "e2: …and never the unrelated brewery row");

      // The pre-slice single-string path (a caller/DB spelling typed
      // directly) still works unchanged.
      const bareResults = searchGardssalgProviders({ producer_type: "bryggeri" }, 20);
      assertEq(bareResults.map((r) => r.id), ["gs-bryggeri"],
        "e3: a bare single-string producer_type filter is unchanged (backward compatible)");

      // gårdskafé — a subcategory that had NO producer_type membership at
      // all before this slice (route-corridor-service.ts's DRINK_PRODUCER_TYPES
      // never included it).
      const cafeResolved = resolveGardssalgProducerTypeFilter("gårdskafé");
      const cafeResults = searchGardssalgProviders({ producer_type: cafeResolved }, 20);
      assertEq(cafeResults.map((r) => r.id), ["gs-gardskafe"],
        "e4: filtering by the canonical 'gårdskafé' now finds the gardskafe-spelled row");

      // fylke is a real column here (unlike RFB's agents table) — proves the
      // 5c coverage report's own fylke grouping has real data to group.
      const innlandetMead = mjodResults.filter((r) => r.fylke === "Innlandet");
      assertEq(innlandetMead.length, 2, "e5: both mead rows genuinely carry fylke='Innlandet'");
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      for (const p of [dbFactoryPath, storePath]) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runOpplevagentDrinkSubcategoryMcpTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log("  " + f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
