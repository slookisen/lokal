/**
 * experiences-query-intent-parity.test.ts — dev-request
 * 2026-10-16-opplevagent-mcp-fritekst-query, S1.
 *
 * S1 moved the A2A intent parser and the MCP category aliases into
 * services/experiences-query-intent.ts without changing them. This pins that:
 *   p1/p2  the route modules re-export the very same functions;
 *   p3     parseExperiencesIntent() gives the same output as before the move,
 *          for a fixed set of queries (expected values recorded on lokal
 *          a6edc5cb, before the move — the substring quirks included, see the
 *          dev-request's FUNN a2a-parse-experiences-intent-delstrengtreff).
 *          The region lists are REGION_TO_KOMMUNER's data, re-recorded when
 *          that table moved from towns to real kommuner (dev-request
 *          2026-10-17-integrasjonstest-oppfolging, AI-2); the parser is the same;
 *   p4     normalizeExperienceCategory() likewise;
 *   p5     the module imports only norway-fylke and experience-store, never a
 *          route, so it cannot form an import cycle.
 *
 * Standalone: npx tsx src/services/experiences-query-intent-parity.test.ts
 * Wired into the gate via tests/test.ts.
 */

import * as fs from "node:fs";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const INTENTS_BEFORE_MOVE: Array<[string, Record<string, unknown>]> = [
  ["hva kan vi finne på i Tromsø om vinteren?", { kommune: "Tromsø", season: "winter" }],
  ["opplevelser i Finnmark", { fylke: "Finnmark" }],
  ["kajakkpadling i Vesterålen", {}],
  ["hvilke opplevelser finnes i Lofoten?", { kommuner: ["Vågan", "Vestvågøy", "Flakstad", "Moskenes", "Værøy", "Røst", "Svolvær"] }],
  ["opplevelser i Hardanger", { kommuner: ["Ullensvang", "Ulvik", "Eidfjord", "Kvam", "Kvinnherad"] }],
  ["Det regner i Oslo, hva gjør vi innendørs?", { kommune: "Oslo", weather: "rain", indoor_outdoor: "indoor" }],
  ["friluft i Bergen om sommeren", { kommune: "Bergen", indoor_outdoor: "outdoor", season: "summer" }],
  ["Møre og Romsdal", { fylke: "Møre og romsdal" }],
  ["Sunnmøre", { kommuner: ["Ålesund", "Volda", "Ørsta", "Stranda", "Sykkylven", "Haram", "Giske", "Sula", "Hareid", "Ulstein", "Sande", "Vanylven", "Fjord"] }],
  ["Hallingdal", {}],
  ["Molde", { kommune: "Molde" }],
  ["Tromsø", { kommune: "Tromsø" }],
  ["snø i Trøndelag", { fylke: "Trøndelag", weather: "snow" }],
  ["sol på Sola", { kommune: "Sola", weather: "clear" }],
  ["våre beste opplevelser i Oslo", { kommune: "Oslo", season: "spring" }],
  ["waterfall in autumn", { season: "autumn" }],
  ["regnbue i Bø", { kommune: "Bø", weather: "rain" }],
  ["outdoor in Os", { kommune: "Os", indoor_outdoor: "outdoor" }],
  ["en time i Ålesund", { kommune: "Ålesund" }],
  ["Senja vinter", { kommuner: ["Senja"], season: "winter" }],
  ["Nordmøre høst", { kommuner: ["Kristiansund", "Surnadal", "Averøy", "Gjemnes", "Tingvoll", "Sunndal", "Smøla", "Aure"], season: "autumn" }],
  ["Valdres", { kommuner: ["Nord-Aurdal", "Øystre Slidre", "Vestre Slidre", "Vang", "Sør-Aurdal", "Etnedal"] }],
  ["hvalsafari i Tromsø", { kommune: "Tromsø" }],
  ["zzzqqq ingen treff xyzzy", {}],
  ["Finn noe å gjøre i Mo i Rana", { kommune: "Mo i Rana" }],
  ["Bø i Telemark", { kommune: "Bø i Telemark" }],
  ["finne på noe", {}],
  ["inne eller ute?", { indoor_outdoor: "indoor" }],
  ["", {}],
  ["TROMSØ", { kommune: "Tromsø" }],
  ["clear skies in Svalbard", { fylke: "Svalbard", weather: "clear" }],
  ["spring in Vestland", { fylke: "Vestland", season: "spring" }],
  ["fint vær i Agder", { fylke: "Agder", weather: "clear" }],
  ["rain in Rogaland", { fylke: "Rogaland", weather: "rain" }],
];

// Recorded with an empty experiences catalogue, so the live-slug lookup adds
// nothing; the alias table decides every case.
const CATEGORIES_BEFORE_MOVE: Array<[string, string]> = [
  ["vinter", "vinter_sno"],
  ["Wildlife", "dyreliv_safari"],
  ["wildlife & safari", "dyreliv_safari"],
  ["wildlife_safari", "dyreliv_safari"],
  ["Food and drink", "mat_drikke"],
  ["Sightseeing & transport", "sightseeing_transport"],
  ["dyreliv_safari", "dyreliv_safari"],
  ["karaoke", "karaoke"],
  ["gårdssalg", "gardssalg_smaking"],
  [" spa ", "velvaere_spa"],
  ["kultur-og-historie", "kultur_historie"],
  ["Velvære", "velvaere_spa"],
  ["SNØ", "vinter_sno"],
  ["animals", "dyreliv_safari"],
  ["", ""],
  ["natur friluft", "natur_friluft"],
];

export function runExperiencesQueryIntentParityTests(opts: { log?: boolean } = {}): TestSummary {
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

  // Fresh copies of the shared module, both routes and an empty in-memory
  // catalogue (the state the expected values were recorded in: the live-slug
  // lookup of normalizeExperienceCategory adds nothing).
  const prevDbPath = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("./experience-store"),
    require.resolve("./experiences-query-intent"),
    require.resolve("../routes/experiences-a2a"),
    require.resolve("../routes/experiences-mcp"),
  ]);
  try {
    (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    const service = require("./experiences-query-intent") as typeof import("./experiences-query-intent");
    const a2a = require("../routes/experiences-a2a") as typeof import("../routes/experiences-a2a");
    const mcp = require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp");

    assertEq(a2a.parseExperiencesIntent === service.parseExperiencesIntent, true, "p1: experiences-a2a re-exports the shared parseExperiencesIntent");
    assertEq(mcp.normalizeExperienceCategory === service.normalizeExperienceCategory, true, "p2: experiences-mcp re-exports the shared normalizeExperienceCategory");

    for (const [query, expected] of INTENTS_BEFORE_MOVE) {
      assertEq(service.parseExperiencesIntent(query), expected, `p3: parseExperiencesIntent(${JSON.stringify(query)}) is unchanged by the move`);
    }
    for (const [category, expected] of CATEGORIES_BEFORE_MOVE) {
      assertEq(service.normalizeExperienceCategory(category), expected, `p4: normalizeExperienceCategory(${JSON.stringify(category)}) is unchanged by the move`);
    }

    const src = fs.readFileSync(require.resolve("./experiences-query-intent"), "utf8");
    const specifiers = [...src.matchAll(/(?:from\s+|require\()\s*"([^"]+)"/g)].map((m) => m[1]);
    assertEq([...new Set(specifiers)].sort(), ["./experience-store", "./norway-fylke"], "p5: the module imports only norway-fylke and experience-store");
  } catch (err: any) {
    failed++;
    failures.push("experiences-query-intent-parity: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
    if (prevDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevDbPath;
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/experiences-query-intent-parity.test.ts`
if (require.main === module) {
  const summary = runExperiencesQueryIntentParityTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  for (const f of summary.failures) console.log(f);
  process.exit(summary.failed > 0 ? 1 : 0);
}
