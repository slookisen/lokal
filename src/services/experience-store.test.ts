/**
 * experience-store.test.ts — unit tests for the PURE helpers in
 * services/experience-store.ts.
 *
 * Currently covers formatDistanceLabel() (dev-request 2026-07-04-opplevagent-
 * naer-meg-geosok, item 3: «Nær meg» on /sok) — the honesty rule that a
 * 'kommune'-precision (centroid-fallback) row must NEVER render a street-
 * level distance claim, only an 'address'-precision row may.
 *
 * No DB access — getDb() is lazy (only called inside DB-touching functions),
 * so importing this module and calling formatDistanceLabel() directly is
 * safe without any EXPERIENCES_DB_PATH/in-memory-DB setup.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experience-store.test.ts
 *   2. Wired into the gate: tests/test.ts imports runExperienceStoreTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import {
  formatDistanceLabel,
  gardssalgRewriteEligible,
  gardssalgProductsEligible,
  gardssalgReplaceableFieldAction,
} from "./experience-store";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceStoreTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── formatDistanceLabel: address precision → exact "X,X km unna" ────────
  assertEq(formatDistanceLabel(2.4, "address", "Tromsø"), "2,4 km unna", "address precision: 2.4km → '2,4 km unna'");
  assertEq(formatDistanceLabel(0, "address", "Tromsø"), "0,0 km unna", "address precision: 0km → '0,0 km unna'");
  assertEq(formatDistanceLabel(63.9, "address", null), "63,9 km unna", "address precision: no kommune needed, still shows exact distance");
  assertEq(formatDistanceLabel(2, "address", "Oslo"), "2,0 km unna", "address precision: whole-number km still shows one decimal (2,0)");

  // ── formatDistanceLabel: kommune precision → NEVER a distance, only the
  //    kommune name — this is the honesty rule from the dev-request ────────
  assertEq(formatDistanceLabel(63.9, "kommune", "Tromsø"), "i Tromsø kommune", "kommune precision: never claims a distance, even though distance_km is present");
  assertEq(formatDistanceLabel(null, "kommune", "Bergen"), "i Bergen kommune", "kommune precision: works with null distance_km too");
  assertEq(formatDistanceLabel(5, "kommune", null), "omtrentlig posisjon (kommune)", "kommune precision with no kommune name: generic approximate label, still no fabricated distance");

  // ── formatDistanceLabel: nothing honest to say → null (render nothing) ──
  assertEq(formatDistanceLabel(null, null, "Oslo"), null, "no geo_precision at all → null (never geocoded)");
  assertEq(formatDistanceLabel(2.4, null, "Oslo"), null, "distance present but no geo_precision flag → null (don't guess)");
  assertEq(formatDistanceLabel(undefined, undefined, undefined), null, "all undefined → null");
  assertEq(formatDistanceLabel(NaN, "address", "Oslo"), null, "address precision but non-finite distance → null, not 'NaN km unna'");

  // ── gardssalgRewriteEligible (dev-request 2026-07-18-gardssalg-
  //    profilkvalitet-foer-outreach, slice 5a) — the "passing-bar-but-short"
  //    cohort gardssalgReplaceableFieldAction() never touches. ──────────────
  const PASSING_BAR_SHORT_86 =
    "Familiedrevet gård på Toten som dyrker grønnsaker og bær, og selger dem i egen butikk.";
  const SUB_80_63 = "Liten gård med noen dyr og en pen have full av epletrær og bær.";
  const PASSING_BAR_LONG_215 =
    "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger dem direkte fra gårdsbutikken. Vi holder også sauer og høns, og inviterer besøkende til å oppleve gårdslivet på nært hold hele sommeren.";

  assertTrue(PASSING_BAR_SHORT_86.length >= 80 && PASSING_BAR_SHORT_86.length < 200, "sanity: PASSING_BAR_SHORT_86 is in the [80,200) window");
  assertTrue(SUB_80_63.length < 80, "sanity: SUB_80_63 is under the 80-char quality bar");
  assertTrue(PASSING_BAR_LONG_215.length >= 200, "sanity: PASSING_BAR_LONG_215 is >= 200 chars");

  assertEq(gardssalgRewriteEligible(PASSING_BAR_SHORT_86), true, "gardssalgRewriteEligible: 86-char value passing the quality bar and <200 chars → true");
  assertEq(gardssalgRewriteEligible(SUB_80_63), false, "gardssalgRewriteEligible: 63-char value (fails the 80-char quality bar) → false");
  assertEq(gardssalgRewriteEligible(PASSING_BAR_LONG_215), false, "gardssalgRewriteEligible: 215-char value (passes bar but already >=200 chars) → false, not a rewrite candidate");
  assertEq(gardssalgRewriteEligible(""), false, "gardssalgRewriteEligible: blank string → false");
  assertEq(gardssalgRewriteEligible("   "), false, "gardssalgRewriteEligible: whitespace-only string → false");
  assertEq(gardssalgRewriteEligible(null), false, "gardssalgRewriteEligible: null → false");
  assertEq(gardssalgRewriteEligible(undefined), false, "gardssalgRewriteEligible: undefined → false");

  // ── gardssalgReplaceableFieldAction's currentValueJudgedContaminated param
  //    (fix-up round, independent review's blocking finding): "current value
  //    passes the cheap bar" no longer means "never touch it" unconditionally
  //    — a cheap-bar-passing current value that the caller's LLM judge found
  //    contaminated (nav-menu chrome glued to one real sentence, the Draopar
  //    incident shape — see cal-1 in opplevelser-gardssalg-quality-judge.
  //    test.ts) must still be replaceable by a genuinely better candidate. ──
  const CAL1_CONTAMINATED =
    "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger.";
  const GOOD_LONGER_CANDIDATE =
    "Draopar Sideri held til i Hardanger og lagar sider av eigne eple frå gamle tre på garden, og tek imot gjester til smaking og omvising gjennom heile hausten.";
  assertTrue(CAL1_CONTAMINATED.length >= 80, "sanity: CAL1_CONTAMINATED clears the 80-char cheap-bar floor");
  assertTrue(GOOD_LONGER_CANDIDATE.length > CAL1_CONTAMINATED.length, "sanity: GOOD_LONGER_CANDIDATE is strictly longer than the contaminated current text");

  // Old (default/omitted third arg) behavior — UNCHANGED: a cheap-bar-passing
  // current value is never churned, regardless of the candidate.
  assertEq(
    gardssalgReplaceableFieldAction(CAL1_CONTAMINATED, GOOD_LONGER_CANDIDATE),
    null,
    "gardssalgReplaceableFieldAction: third arg omitted (defaults false) → cheap-bar-passing current is still never churned (backward-compatible)",
  );
  assertEq(
    gardssalgReplaceableFieldAction(CAL1_CONTAMINATED, GOOD_LONGER_CANDIDATE, false),
    null,
    "gardssalgReplaceableFieldAction: currentValueJudgedContaminated=false explicitly → cheap-bar-passing current still never churned",
  );

  // THE FIX: currentValueJudgedContaminated=true → the cheap-bar-passing but
  // contaminated current value IS replaced by the qualifying, longer
  // candidate (self-healing restored for already-landed contamination).
  assertEq(
    gardssalgReplaceableFieldAction(CAL1_CONTAMINATED, GOOD_LONGER_CANDIDATE, true),
    "replaced",
    "gardssalgReplaceableFieldAction: currentValueJudgedContaminated=true + qualifying longer candidate → 'replaced' (the self-healing path now works)",
  );

  // Control: a GENUINELY decent current value is still never churned even
  // when (hypothetically, by caller error) currentValueJudgedContaminated
  // were left false — proving the contamination flag is what drives the new
  // behavior, not some accidental loosening of the cheap-bar check itself.
  const GENUINELY_DECENT =
    "Gården vår har lange tradisjoner med sauehold og ullproduksjon, og vi selger garn og kjøtt direkte fra tunet.";
  assertEq(
    gardssalgReplaceableFieldAction(GENUINELY_DECENT, GOOD_LONGER_CANDIDATE, false),
    null,
    "gardssalgReplaceableFieldAction: genuinely decent current (not judged contaminated) → still never churned",
  );

  // Blank/thin-current and thin-candidate behavior is completely unaffected
  // by the new third param (it only matters when meetsAboutCheapBar(current)
  // is true) — regression-proofing the pre-existing contract.
  assertEq(
    gardssalgReplaceableFieldAction(null, GOOD_LONGER_CANDIDATE, true),
    "filled",
    "gardssalgReplaceableFieldAction: blank current + contaminated=true → still just 'filled' (blank-fill path unaffected by the new param)",
  );
  assertEq(
    gardssalgReplaceableFieldAction("Liten gård.", GOOD_LONGER_CANDIDATE, false),
    "replaced",
    "gardssalgReplaceableFieldAction: thin (cheap-bar-failing) current + contaminated=false → still 'replaced' via the pre-existing thin-content path, unaffected by the new param",
  );

  // ── gardssalgProductsEligible (dev-request 2026-07-18-gardssalg-
  //    profilkvalitet-foer-outreach, slice 5c) — fill-only gate for the
  //    "products" JSON-array column. ────────────────────────────────────────
  assertEq(gardssalgProductsEligible(null), true, "gardssalgProductsEligible: null → true (blank column, eligible)");
  assertEq(gardssalgProductsEligible(undefined), true, "gardssalgProductsEligible: undefined → true");
  assertEq(gardssalgProductsEligible(""), true, "gardssalgProductsEligible: empty string → true");
  assertEq(gardssalgProductsEligible("   "), true, "gardssalgProductsEligible: whitespace-only string → true");
  assertEq(gardssalgProductsEligible("[]"), true, "gardssalgProductsEligible: literal '[]' → true (empty array)");
  assertEq(gardssalgProductsEligible("  []  "), true, "gardssalgProductsEligible: '[]' with surrounding whitespace → true");
  assertEq(gardssalgProductsEligible(JSON.stringify([])), true, "gardssalgProductsEligible: JSON.stringify([]) round-trip → true");
  assertEq(gardssalgProductsEligible(JSON.stringify(["Eplesider"])), false, "gardssalgProductsEligible: non-empty array (one product) → false, never overwritten");
  assertEq(gardssalgProductsEligible(JSON.stringify(["Eplesider", "Eplemost"])), false, "gardssalgProductsEligible: non-empty array (two products) → false");
  assertEq(gardssalgProductsEligible("not valid json"), false, "gardssalgProductsEligible: malformed non-JSON value → false, conservative (never silently overwritten)");
  assertEq(gardssalgProductsEligible('{"not":"an array"}'), false, "gardssalgProductsEligible: valid JSON but not an array (an object) → false");
  assertEq(gardssalgProductsEligible("[1,2,3]"), false, "gardssalgProductsEligible: valid non-empty JSON array (even of non-strings) → false, only an EMPTY array is eligible");

  // ── searchGardssalgProviders (dev-request 2026-07-20-gardssalg-mcp-
  //    discoverability) — backs the new discover_gardssalg MCP tool. Unlike
  //    the pure-function tests above, this needs a real (in-memory) DB, so
  //    it self-contains the same EXPERIENCES_DB_PATH=":memory:" + require-
  //    cache-reset + restore-in-finally convention used by the other
  //    gårdssalg route test files (e.g.
  //    opplevelser-gardssalg-provider-visibility.test.ts) — dynamically
  //    re-requiring db-factory/experience-store rather than relying on this
  //    file's own top-of-file static import, which resolved before any DB
  //    env override could take effect. ────────────────────────────────────
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, booking_live, catalog_hidden, lat, lon, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @booking_live, @catalog_hidden, @lat, @lon, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      // gs-a: fully visible, booking live, geocoded near a Bergen origin.
      insertProvider.run({
        id: "gs-a", navn: "Sider A", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 1, catalog_hidden: null, lat: 60.39, lon: 5.32, slug: "sider-a",
      });
      // gs-b: fully visible, booking NOT live, different fylke/kommune/type.
      insertProvider.run({
        id: "gs-b", navn: "Bryggeri B", fylke: "Oslo", kommune: "Oslo", producer_type: "bryggeri",
        booking_live: 0, catalog_hidden: null, lat: 59.91, lon: 10.75, slug: "bryggeri-b",
      });
      // gs-c: catalog_hidden=1 — matches EVERY filter below (same fylke/
      // kommune/producer_type as gs-a, booking_live=1, geocoded right next
      // to gs-a) yet must NEVER appear in any result — the load-bearing
      // security/data-leak test.
      insertProvider.run({
        id: "gs-c", navn: "Skjult C", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 1, catalog_hidden: 1, lat: 60.40, lon: 5.33, slug: "skjult-c",
      });
      // gs-d: visible, but never geocoded (lat/lon NULL) — must be excluded
      // from any geo-filtered search, never assigned a fabricated distance.
      insertProvider.run({
        id: "gs-d", navn: "Ugeokodet D", fylke: "Vestland", kommune: "Bergen", producer_type: "vingård",
        booking_live: null, catalog_hidden: null, lat: null, lon: null, slug: "ugeokodet-d",
      });
      // 55 extra Nordland/seltzeri rows to prove the limit clamp actually
      // bites (needs >50 candidates to observe truncation at 50). A distinct
      // producer_type ('seltzeri') keeps this fixture set out of the
      // producer_type='bryggeri' assertion below.
      for (let i = 0; i < 55; i++) {
        insertProvider.run({
          id: `gs-limit-${i}`, navn: `Limitgård ${String(i).padStart(2, "0")}`, fylke: "Nordland", kommune: "Bodø",
          producer_type: "seltzeri", booking_live: 0, catalog_hidden: null, lat: null, lon: null, slug: `limitgard-${i}`,
        });
      }

      const names = (rows: Array<{ navn: string }>) => rows.map((r) => r.navn).sort();

      // ── fylke/kommune/producer_type exact-match filters ─────────────────
      assertEq(
        names(expStore.searchGardssalgProviders({ fylke: "Vestland" })),
        ["Sider A", "Ugeokodet D"],
        "sgp-1: fylke='Vestland' returns gs-a + gs-d, never the hidden gs-c, never Oslo's gs-b"
      );
      assertEq(
        names(expStore.searchGardssalgProviders({ kommune: "Bergen" })),
        ["Sider A", "Ugeokodet D"],
        "sgp-2: kommune='Bergen' returns gs-a + gs-d, never the hidden gs-c"
      );
      assertEq(
        names(expStore.searchGardssalgProviders({ producer_type: "bryggeri" }, 100)),
        ["Bryggeri B"],
        "sgp-3: producer_type='bryggeri' returns only the bryggeri row (gs-b), never the cideri/vingård/seltzeri fixtures"
      );

      // ── catalog_hidden=1 NEVER returned, under ANY filter combination ────
      const allNoFilter = expStore.searchGardssalgProviders({}, 100);
      assertTrue(!allNoFilter.some((r) => r.navn === "Skjult C"), "sgp-4: no filter at all — hidden row absent");
      const exactMatchFilter = expStore.searchGardssalgProviders(
        { fylke: "Vestland", kommune: "Bergen", producer_type: "cideri", booking_live: true }, 100
      );
      assertTrue(!exactMatchFilter.some((r) => r.navn === "Skjult C"),
        "sgp-5: filter combination matching every one of the hidden row's own columns still excludes it");
      assertTrue(exactMatchFilter.some((r) => r.navn === "Sider A"),
        "sgp-5b: sanity check — that same filter DOES return the real (non-hidden) matching row");

      // ── booking_live:true → only booking_live=1 rows ─────────────────────
      const liveOnly = expStore.searchGardssalgProviders({ booking_live: true }, 100);
      assertEq(names(liveOnly), ["Sider A"], "sgp-6: booking_live:true returns only gs-a (booking_live=1), not gs-b (0), gs-d (NULL), or the hidden gs-c (1 but catalog_hidden=1)");

      // ── geo near-me: correct distance_km for a geocoded row, exclusion of
      //    a non-geocoded row, exclusion of the hidden row even though it is
      //    geocoded right next to the origin. ──────────────────────────────
      const geoResults = expStore.searchGardssalgProviders({ lat: 60.39, lng: 5.32, radius_km: 50 }, 100);
      assertEq(names(geoResults), ["Sider A"], "sgp-7: geo search near Bergen returns only gs-a — gs-d (no lat/lon) and gs-c (hidden) excluded");
      const gsAGeo = geoResults.find((r) => r.navn === "Sider A");
      assertTrue(!!gsAGeo && typeof gsAGeo.distance_km === "number" && gsAGeo.distance_km >= 0 && gsAGeo.distance_km < 1,
        "sgp-8: gs-a queried from its own coordinates gets a real, near-zero distance_km");
      assertTrue(!geoResults.some((r) => r.navn === "Ugeokodet D"), "sgp-9: never-geocoded row excluded from a geo-filtered search (no fabricated distance)");

      // ── limit: default 20, clamp to [1,50] ───────────────────────────────
      assertEq(expStore.searchGardssalgProviders({}).length, 20, "sgp-10: default limit is 20");
      assertEq(expStore.searchGardssalgProviders({ fylke: "Nordland" }, 1000).length, 50, "sgp-11: limit above 50 clamps down to 50");
      assertEq(expStore.searchGardssalgProviders({ fylke: "Nordland" }, 0).length, 1, "sgp-12: limit of 0 clamps up to 1");
      assertEq(expStore.searchGardssalgProviders({ fylke: "Nordland" }, -5).length, 1, "sgp-13: a negative limit clamps up to 1");
    } catch (err: any) {
      failed++;
      failures.push("searchGardssalgProviders: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runExperienceStoreTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
