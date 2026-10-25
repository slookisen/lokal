/**
 * experiences-a2a-zero-hit.test.ts — dev-request 2026-09-06-opplevagent-
 * discovery-nulltreff-standardliste (slookisen/A2A, L2, P1).
 *
 * Bug (reproduced live against prod): POST https://opplevagent.no/a2a with
 * method message/send returned an unfiltered 20-item "standard list" when the
 * natural-language query had no real hits, instead of count:0. Nonsense text
 * ("zzzqqq ingen treff xyzzy", "kajakk Lofoten", "Ystebakken") all returned
 * byte-identical top-3 ids and count:20 — indistinguishable from a real
 * match to a calling agent. (Historical repro record only: as of dev-request
 * 2026-09-21-opplevagent-discovery-regionnavn-utenfor-kommune-fylke,
 * "Lofoten" is a curated, recognised region name — see test 2 below, which
 * now uses "Vesterålen" in its place to keep exercising a genuinely
 * unrecognised place name.)
 *
 * Two root causes in the "Default: discover" branch of
 * handleExperiencesMessageSend (src/routes/experiences-a2a.ts):
 *   1. Free text with no parseable signal (no kommune/fylke/weather/
 *      indoor_outdoor/season) -> parseExperiencesIntent() returns an EMPTY
 *      filter {} -> discoverExperiencesRelaxed({}, 20) -> the first 20
 *      published rows, unfiltered.
 *   2. A filter WITH keys where discoverExperiencesRelaxed()
 *      (src/services/experience-store.ts) relaxes EVERY key away (RELAX_ORDER
 *      exhausted) -> lands on the same unfiltered list, wearing a relaxation
 *      note.
 *
 * The fix (handler-level only — discoverExperiencesRelaxed/discoverExperiences/
 * parseExperiencesIntent are untouched, they're shared with REST /discover and
 * the MCP tools):
 *   - Case 1: non-empty messageText + Object.keys(filter).length === 0 ->
 *     return count:0 without ever querying the DB. metadata.zero_hit_reason
 *     === "unrecognized_query".
 *   - Case 2: filter had >=1 key AND relaxedKeys.length ===
 *     Object.keys(filter).length (every constraint dropped) -> return
 *     count:0. metadata.relaxed_filters === relaxedKeys,
 *     metadata.zero_hit_reason === "relaxation_exhausted",
 *     metadata.suggestions kept (computed from the fully-relaxed results —
 *     still useful "try kommune=X" hints).
 *   - Everything else (partial relaxation, the structured "browse" path with
 *     no text, categories/UUID/gårdssalg intents) is byte-identical to
 *     before.
 *
 * dev-request 2026-10-16-opplevagent-mcp-fritekst-query, S5 (section 9):
 * before case 1 answers count:0, the message's search words from the shared
 * interpreter (interpretDiscoverQuery) are tried — every word must be in the
 * row. "hvalsafari" now finds the whale safari; "zzzqqq ingen treff xyzzy"
 * and a place parseExperiencesIntent() does not know ("hvalsafari i
 * Nord-Norge") still answer count:0 / unrecognized_query. So do a place
 * outside Norway ("kongekrabbe i Russland", 9m) and a food purchase ("kjøpe
 * tørrfisk", 9n), even though a Norwegian row contains every word: the early
 * returns of discover_experiences and REST run before the interpreter.
 *
 * Follows the exact precedent of experiences-a2a.test.ts / opplevelser-
 * discover-relax.test.ts: exported runExperiencesA2aZeroHitTests(opts),
 * standalone-runnable via `npx tsx <file>`, own in-memory DB seeding via the
 * same experience-store helpers those files use.
 *
 * Run standalone: npx tsx src/routes/experiences-a2a-zero-hit.test.ts
 * Wired into the gate via tests/test.ts (next to
 * runExperiencesA2aGardssalgTests).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperiencesA2aZeroHitTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const experiencesA2aPath = require.resolve("./experiences-a2a");
    const cachePaths = [dbFactoryPath, expStorePath, experiencesA2aPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const a2a = require("./experiences-a2a") as typeof import("./experiences-a2a");
      const { handleExperiencesMessageSend } = a2a;

      // ── Fixture: a single real, verified, published Tromsø experience ──
      // Outdoor, weather_dependent:1, season:["winter"] — deliberately so a
      // weather="rain" constraint (rain -> indoor OR weather_dependent=0)
      // fails to match it directly, giving us a genuine "partial relaxation"
      // case (kommune kept, weather dropped) distinct from the "relaxation
      // exhausted" case below.
      const providerId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Nordlysjakt fra Tromsø", provider_id: providerId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        category: "natur", verification_status: "verified", confidence: "high",
        price_from: 500, duration_min: 90, indoor_outdoor: "outdoor",
        weather_dependent: 1, season: ["winter"],
      });
      // S5 (section 9): a whale safari outside Tromsø, outdoor and weather-
      // dependent like the row above, so cases 4-6 answer as before.
      expStore.createExperience({
        title: "Hvalsafari fra Andenes", provider_id: providerId,
        provider_match_status: "matched", kommune: "Andøy", fylke: "Nordland",
        category: "dyreliv_safari", verification_status: "verified", confidence: "high",
        price_from: 1300, duration_min: 240, indoor_outdoor: "outdoor",
        weather_dependent: 1, season: ["winter"],
        description: "Se spermhval og spekkhoggere fra båt.",
      });
      // S5 (9m, 9n): Norwegian rows whose text names a foreign country or
      // buying stockfish, so a search-word hit is possible for those messages.
      const borderRow = {
        provider_id: providerId, provider_match_status: "matched", kommune: "Sør-Varanger", fylke: "Finnmark",
        category: "dyreliv_safari", verification_status: "verified", confidence: "high",
        price_from: 1900, duration_min: 180, indoor_outdoor: "outdoor", weather_dependent: 1, season: ["winter"],
      } as const;
      expStore.createExperience({
        ...borderRow, title: "King Crab Safari Kirkenes",
        description: "Kongekrabbe fra Barentshavet, like ved grensen til Russland. A king crab safari by the border with Russia.",
      });
      expStore.createExperience({
        ...borderRow, title: "Husky safari Pasvik",
        description: "Hundekjøring i Pasvikdalen, mellom Finland og Russland.",
      });
      expStore.createExperience({
        ...borderRow, kommune: "Moskenes", fylke: "Nordland", category: "kultur_historie", title: "Lofoten Tørrfiskmuseum",
        description: "Om tørrfisk fra Lofoten. I butikken kan du kjøpe tørrfisk; you can buy stockfish in the shop.",
      });

      // ── 1. Nonsense text -> count:0, unrecognized_query ───────────────
      const r1: any = handleExperiencesMessageSend({ message: "zzzqqq ingen treff xyzzy" }, "z1");
      assertEq(r1.result?.metadata?.skill, "opplevelser_discover", "1a: nonsense text still routes to opplevelser_discover");
      assertEq(r1.result?.metadata?.zero_hit_reason, "unrecognized_query", "1b: zero_hit_reason is unrecognized_query");
      const dataPart1 = r1.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertEq(dataPart1?.count, 0, "1c: count is 0");
      assertEq(dataPart1?.experiences, [], "1d: experiences is an empty array");
      const summaryPart1 = r1.result?.artifacts?.[0]?.parts?.[0]?.text as string;
      assertTrue(typeof summaryPart1 === "string" && summaryPart1.length > 0, "1e: summary text is present");
      assertTrue(summaryPart1.includes("ingen treff") || summaryPart1.toLowerCase().includes("no matches"), "1f: summary reads as a genuine no-match, not a result count");

      // ── 2. "kajakk Vesterålen" — real words, no recognised place/season/
      //     weather/indoor-outdoor signal. "Vesterålen" is excluded from
      //     detectKommune via NON_KOMMUNE_REGION_LABELS, is not a FYLKER
      //     substring, and — unlike "Lofoten" as of dev-request 2026-09-21-
      //     opplevagent-discovery-regionnavn-utenfor-kommune-fylke — is also
      //     NOT in the curated REGION_TO_KOMMUNER list, so it still parses to
      //     an empty filter -> same zero-hit result as before that dev-
      //     request. (Region-list coverage itself — including that a
      //     recognised-but-no-catalog-hit region collapses into
      //     "relaxation_exhausted", not "unrecognized_query" — is covered in
      //     experiences-a2a.test.ts's dedicated region section.) ───────────
      const r2: any = handleExperiencesMessageSend({ message: "kajakk Vesterålen" }, "z2");
      assertEq(r2.result?.metadata?.zero_hit_reason, "unrecognized_query", "2a: \"kajakk Vesterålen\" is also an unrecognized query");
      const dataPart2 = r2.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertEq(dataPart2?.count, 0, "2b: count is 0");

      // ── 3. AC3 — two different nonsense strings both zero, NOT the same
      //     byte-identical 20-item standard list ────────────────────────
      const r3: any = handleExperiencesMessageSend({ message: "Ystebakken" }, "z3");
      assertEq(r3.result?.metadata?.zero_hit_reason, "unrecognized_query", "3a: a third, unrelated nonsense string is also unrecognized_query");
      const dataPart3 = r3.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertEq(dataPart3?.count, 0, "3b: count is 0 (not 20)");
      assertEq(dataPart1?.count, dataPart2?.count, "3c: both nonsense queries agree (both 0)");
      assertEq(dataPart2?.count, dataPart3?.count, "3d: all three nonsense queries agree (all 0) — no shared unfiltered standard list");

      // ── 4. Control: a seeded kommune query still returns its hits,
      //     same shape as before, no zero_hit_reason ─────────────────────
      const r4: any = handleExperiencesMessageSend({ message: "hva kan vi finne på i Tromsø om vinteren?" }, "z4");
      assertEq(r4.result?.metadata?.zero_hit_reason, undefined, "4a: a real seeded-kommune query never carries zero_hit_reason");
      const dataPart4 = r4.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertTrue((dataPart4?.count ?? 0) > 0, "4b: seeded kommune query returns count > 0");
      const titles4 = (dataPart4?.experiences as any[]).map((e) => e.title);
      assertTrue(titles4.includes("Nordlysjakt fra Tromsø"), "4c: the seeded experience is present");

      // ── 5. Partial relaxation still works: kommune that exists + a
      //     constraint no seeded row has (weather=rain) -> count > 0,
      //     relaxed_filters lists only the dropped key (weather), no
      //     zero_hit_reason ────────────────────────────────────────────────
      const r5: any = handleExperiencesMessageSend(
        { message: { data: { kommune: "Tromsø", weather: "rain" } } },
        "z5"
      );
      assertEq(r5.result?.metadata?.zero_hit_reason, undefined, "5a: partial relaxation never sets zero_hit_reason");
      assertEq(r5.result?.metadata?.relaxed_filters, ["weather"], "5b: only the dropped key (weather) is listed");
      const dataPart5 = r5.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertTrue((dataPart5?.count ?? 0) > 0, "5c: partial relaxation still surfaces the seeded kommune hit");

      // ── 6. Relaxation exhausted: a fylke with no rows + a season ->
      //     count:0, zero_hit_reason:"relaxation_exhausted", relaxed_filters
      //     has all original keys, suggestions non-empty (DB has rows) ────
      const r6: any = handleExperiencesMessageSend(
        { message: { data: { fylke: "Ikke-Eksisterende-Fylke-XYZ", season: "summer" } } },
        "z6"
      );
      assertEq(r6.result?.metadata?.zero_hit_reason, "relaxation_exhausted", "6a: exhausted relaxation sets zero_hit_reason");
      assertEq(
        (r6.result?.metadata?.relaxed_filters as any[])?.slice().sort(),
        ["fylke", "season"],
        "6b: relaxed_filters lists every original filter key"
      );
      const dataPart6 = r6.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertEq(dataPart6?.count, 0, "6c: count is 0, not the unfiltered fallback list");
      assertEq(dataPart6?.experiences, [], "6d: experiences is an empty array");
      const suggestions6 = r6.result?.metadata?.suggestions;
      assertTrue(Array.isArray(suggestions6) && suggestions6.length > 0, "6e: suggestions are kept (non-empty, DB has rows)");
      const summaryPart6 = r6.result?.artifacts?.[0]?.parts?.[0]?.text as string;
      assertTrue(
        summaryPart6.includes("heller ikke etter å ha løsnet") || summaryPart6.toLowerCase().includes("not even after relaxing"),
        "6f: summary explicitly says relaxation was exhausted"
      );

      // ── 7. Structured browse path unchanged: no text, empty data -> {}
      //     filter -> still returns the unfiltered browse list (deliberate),
      //     no zero_hit_reason ────────────────────────────────────────────
      const r7: any = handleExperiencesMessageSend({ message: { data: {} } }, "z7");
      assertEq(r7.result?.metadata?.zero_hit_reason, undefined, "7a: the structured browse path (no text) never sets zero_hit_reason");
      const dataPart7 = r7.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertTrue((dataPart7?.count ?? 0) > 0, "7b: structured browse path still returns rows");

      // ── 8. Categories intent still works (unaffected by this change) ──
      const r8: any = handleExperiencesMessageSend({ message: "vis meg kategorier" }, "z8");
      assertEq(r8.result?.metadata?.skill, "opplevelser_categories", "8a: categories intent still routes to opplevelser_categories");

      // ── 9. S5: search words before count:0 ─────────────────────────────
      const titlesOf = (r: any) => ((r.result?.artifacts?.[1]?.parts?.[0]?.data?.experiences ?? []) as any[]).map((e) => e.title);
      assertEq(a2a.parseExperiencesIntent("hvalsafari"), {}, "9a: parseExperiencesIntent finds nothing in «hvalsafari» (it is unchanged)");
      const r9: any = handleExperiencesMessageSend({ message: "hvalsafari" }, "z9");
      assertEq(titlesOf(r9), ["Hvalsafari fra Andenes"], "9b: «hvalsafari» finds the whale safari instead of count:0");
      assertEq([r9.result?.metadata?.skill, r9.result?.metadata?.filter, r9.result?.metadata?.zero_hit_reason, r9.result?.artifacts?.[1]?.parts?.[0]?.data?.count],
        ["opplevelser_discover", { text_terms: ["hvalsafari"] }, undefined, 1], "9c: … as a discover answer whose filter is the search words");
      const summary9 = r9.result?.artifacts?.[0]?.parts?.[0]?.text as string;
      assertTrue(/søkeordene \(hvalsafari\)/.test(summary9) && /search words \(hvalsafari\)/.test(summary9), "9d: … and the summary says the rows matched the search words");
      const row9 = r9.result?.artifacts?.[1]?.parts?.[0]?.data?.experiences?.[0] ?? {};
      assertTrue(!("distance_km" in row9) && !("geo_precision" in row9), "9e: … rows without distance fields (a text message has no origin)");
      assertTrue(a2a.experiencesAskedSomething(r9), "9f: … and it counts as a lookup that asked something");
      const r9sentence: any = handleExperiencesMessageSend({ message: "Hvor kan jeg se hvalsafari?" }, "z9s");
      assertEq(titlesOf(r9sentence), ["Hvalsafari fra Andenes"], "9g: question words are no search words");

      // Every word must be in the row: one word that matches nothing gives count:0.
      for (const text of ["hvalsafari zzzqqq", "zzzqqq ingen treff xyzzy"]) {
        const r: any = handleExperiencesMessageSend({ message: text }, "z9z");
        assertEq([r.result?.metadata?.zero_hit_reason, r.result?.artifacts?.[1]?.parts?.[0]?.data?.count, r.result?.metadata?.filter],
          ["unrecognized_query", 0, {}], `9h: «${text}» → count:0, unrecognized_query, metadata.filter unchanged`);
        assertTrue(!a2a.experiencesAskedSomething(r), `9i: «${text}» is not counted as a lookup`);
        assertTrue(/ingen opplevelse inneholder alle søkeordene/.test(r.result?.artifacts?.[0]?.parts?.[0]?.text ?? ""),
          `9j: «${text}»: the summary says no experience has all the search words`);
      }
      // A place only the interpreter reads: never answered with rows from the whole country.
      for (const text of ["hvalsafari i Nord-Norge", "hvalsafari i Hordaland"]) {
        const r: any = handleExperiencesMessageSend({ message: text }, "z9p");
        assertEq([r.result?.metadata?.zero_hit_reason, r.result?.artifacts?.[1]?.parts?.[0]?.data?.count], ["unrecognized_query", 0],
          `9k: «${text}» stays count:0 — the search word alone would be nationwide`);
      }
      // No search words at all: the old text.
      const r9hei: any = handleExperiencesMessageSend({ message: "hei" }, "z9h");
      assertTrue(r9hei.result?.metadata?.zero_hit_reason === "unrecognized_query" &&
        (r9hei.result?.artifacts?.[0]?.parts?.[0]?.text as string).startsWith("Fant ingen gjenkjennelige søkekriterier"),
        "9l: a greeting has no search words and keeps the old summary");

      // A place outside Norway (B1 of the PR #1093 review) and a food purchase:
      // the old count:0 answer, although a Norwegian row has every search word.
      const oldZero = (r: any) => [r.result?.metadata?.skill, r.result?.metadata?.zero_hit_reason, r.result?.artifacts?.[1]?.parts?.[0]?.data?.count,
        r.result?.metadata?.filter, (r.result?.artifacts?.[0]?.parts?.[0]?.text as string).startsWith("Fant ingen gjenkjennelige søkekriterier")];
      const guarded: Array<[string, string, string]> = [
        ["9m", "kongekrabbe i Russland", "King Crab Safari Kirkenes"],
        ["9m", "king crab safari in Russia", "King Crab Safari Kirkenes"],
        ["9m", "husky safari Finland", "Husky safari Pasvik"],
        ["9n", "kjøpe tørrfisk", "Lofoten Tørrfiskmuseum"],
        ["9n", "Where can I buy stockfish?", "Lofoten Tørrfiskmuseum"],
      ];
      const { interpretDiscoverQuery } = require("../services/experiences-query-intent") as typeof import("../services/experiences-query-intent");
      for (const [label, text, row] of guarded) {
        const terms = interpretDiscoverQuery(text).terms ?? [];
        assertTrue(Object.keys(a2a.parseExperiencesIntent(text)).length === 0 &&
          expStore.discoverExperiences({ text_terms: terms }, 20).some((e) => e.title === row),
          `${label}: «${text}» reaches the search-word step, and «${row}» has every search word (${terms.join(", ")})`);
        const r: any = handleExperiencesMessageSend({ message: text }, "z9g");
        assertEq(oldZero(r), ["opplevelser_discover", "unrecognized_query", 0, {}, true], `${label}: «${text}» → the old count:0 answer, no Norwegian rows`);
        assertTrue(!a2a.experiencesAskedSomething(r), `${label}: «${text}» is not counted as a lookup`);
      }
      // The same words without the foreign place or the purchase still find the rows.
      for (const [text, row] of [["kongekrabbe", "King Crab Safari Kirkenes"], ["husky", "Husky safari Pasvik"], ["tørrfisk", "Lofoten Tørrfiskmuseum"]]) {
        assertEq(titlesOf(handleExperiencesMessageSend({ message: text }, "z9o")), [row], `9o: «${text}» alone finds «${row}»`);
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-a2a-zero-hit: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-a2a-zero-hit.test.ts`
if (require.main === module) {
  runExperiencesA2aZeroHitTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
