/**
 * opplevelser-discover-relax.test.ts — dev-request 2026-07-04-opplevagent-nl-
 * parser-og-fylkesnormalisering, item 3: zero-hit graceful degradation.
 *
 * An agent asking a place/season/weather question must never get a bare
 * "Ingen opplevelser funnet" when the DB has publishable rows that would
 * match a less-constrained version of the same query. Covers the shared
 * store helpers (discoverExperiencesRelaxed / buildRelaxationNote /
 * buildNarrowingSuggestions), the REST GET /api/opplevelser/discover
 * wiring, and the A2A message/send wiring (handleExperiencesMessageSend is
 * exported and directly callable, same pattern as parseExperiencesIntent's
 * own unit coverage).
 *
 * Run standalone: npx tsx src/routes/opplevelser-discover-relax.test.ts
 * Wired into the gate via tests/test.ts (see opplevelser-discover-tags.test.ts
 * for the precedent this follows).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : null });
    });
  });
}

export function runOpplevelserDiscoverRelaxTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const experiencesA2aPath = require.resolve("./experiences-a2a");
    for (const p of [dbFactoryPath, expStorePath, opplevelserPath, experiencesA2aPath]) {
      delete require.cache[p];
    }

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");

      // Fixture: a real, verified Tromsø experience — a NARROW-BAND, unrelated
      // category (so a category-only "impossible" query has exactly zero direct
      // hits, forcing relaxation), price_from=500, duration_min=90.
      const providerId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Nordlysjakt fra Tromsø", provider_id: providerId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        category: "natur", verification_status: "verified", confidence: "high",
        price_from: 500, duration_min: 90, indoor_outdoor: "outdoor",
      });

      // ── 1. Store-level: numeric over-constraint relaxes duration/price, keeps location ──
      const r1 = expStore.discoverExperiencesRelaxed(
        { fylke: "Troms", max_price: 10, duration_max: 5 },
        20
      );
      assertEq(r1.results.length, 1, "1a: over-constrained price+duration relaxes to 1 hit");
      assertEq(r1.relaxedKeys, ["duration_max", "max_price"], "1b: weakest filters (duration, price) relaxed first, location kept");
      const note1 = expStore.buildRelaxationNote(r1.relaxedKeys);
      assertTrue(!!note1 && note1.includes("maks varighet") && note1.includes("maks pris"), "1c: relaxation note names the dropped filters");

      // ── 2. Store-level: direct hit needs no relaxation ──
      const r2 = expStore.discoverExperiencesRelaxed({ fylke: "Troms" }, 20);
      assertEq(r2.relaxedKeys, [], "2a: a query with results is never relaxed");
      assertEq(expStore.buildRelaxationNote(r2.relaxedKeys), null, "2b: no note when nothing was relaxed");
      assertEq(expStore.buildNarrowingSuggestions(r2.results, r2.relaxedKeys), [], "2c: no suggestions when nothing was relaxed");

      // ── 3. Store-level: category-only mismatch relaxes to the real category, suggestion reflects it ──
      const r3 = expStore.discoverExperiencesRelaxed({ fylke: "Troms", category: "kunst-og-kultur" }, 20);
      assertEq(r3.relaxedKeys, ["category"], "3a: only the wrong filter (category) is relaxed");
      const suggestions3 = expStore.buildNarrowingSuggestions(r3.results, r3.relaxedKeys);
      assertTrue(suggestions3.some((s) => s.includes("category=natur")), "3b: suggestion offers the real category found");

      // ── 4. Never a bare zero — an impossible combo still finds the DB's rows ──
      const r4 = expStore.discoverExperiencesRelaxed(
        { fylke: "Troms", kommune: "Ikke-Eksisterende-Sted", category: "ikke-en-kategori", max_price: 1, duration_max: 1 },
        20
      );
      assertTrue(r4.results.length > 0, "4a: impossible filter combo still surfaces results after full relaxation");
      assertTrue(r4.relaxedKeys.length > 0, "4b: relaxedKeys is non-empty for the impossible combo");

      // ── 5. REST GET /api/opplevelser/discover surfaces relaxation fields ──
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const res5 = await callRoute(opplevelserRouter, "/discover?fylke=Troms&max_price=10&duration_max=5");
      assertTrue(res5.handled, "5a: GET /discover is handled");
      assertEq(res5.body.count, 1, "5b: relaxed REST query finds the fixture");
      assertTrue(Array.isArray(res5.body.relaxed_filters) && res5.body.relaxed_filters.length === 2, "5c: REST response carries relaxed_filters");
      assertTrue(typeof res5.body.note === "string" && res5.body.note.length > 0, "5d: REST response carries a relaxation note");
      assertTrue(Array.isArray(res5.body.suggestions), "5e: REST response carries suggestions");

      const res6 = await callRoute(opplevelserRouter, "/discover?fylke=Troms");
      assertEq(res6.body.relaxed_filters, undefined, "6a: direct-hit REST query omits relaxed_filters");
      assertEq(res6.body.note, undefined, "6b: direct-hit REST query omits note");

      // ── 7. A2A message/send never returns a bare zero for an over-constrained NL query ──
      const { handleExperiencesMessageSend } = require("./experiences-a2a") as typeof import("./experiences-a2a");
      const a2aResult: any = handleExperiencesMessageSend(
        { message: { data: { fylke: "Troms", max_price: 10, duration_max: 5 } } },
        1
      );
      const summaryPart = a2aResult.result.artifacts[0].parts[0].text as string;
      assertTrue(summaryPart.includes("Fant 1 opplevelse"), "7a: A2A summary reports the relaxed hit count");
      assertTrue(summaryPart.includes("løsnet") || summaryPart.includes("relaxed"), "7b: A2A summary includes the relaxation note text");
      assertTrue(
        Array.isArray(a2aResult.result.metadata.relaxed_filters) && a2aResult.result.metadata.relaxed_filters.length === 2,
        "7c: A2A metadata carries relaxed_filters"
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-discover-relax: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of [dbFactoryPath, expStorePath, opplevelserPath, experiencesA2aPath]) {
        delete require.cache[p];
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-discover-relax.test.ts`
if (require.main === module) {
  runOpplevelserDiscoverRelaxTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
