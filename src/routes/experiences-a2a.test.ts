/**
 * experiences-a2a.test.ts — dev-request 2026-07-25-gardssalg-a2a-nl-routing:
 * POST /a2a message/send on opplevagent.no ALWAYS searched the generic
 * `experiences` table, never the gårdssalg (farm-sale drink producer)
 * vertical in `experience_providers` — a DISTINCT dataset with its own REST
 * endpoint + MCP tool already shipped. A Norwegian query like "hvor kan jeg
 * booke en sidersmaking i Hardanger?" got generic-experiences results (or a
 * "nothing found" relaxation message), never real gårdssalg producers.
 *
 * This covers the fix: detectGardssalgIntent() (producer-type keyword table
 * + gårdssalg-only trigger words, both word-prefix matched via
 * matchesAsWordPrefix — never a raw regex \b, since æøå aren't \w in JS) is
 * checked in handleExperiencesMessageSend BEFORE the generic "Default:
 * discover" fallback. A match routes to searchGardssalgProviders() and
 * formats each row EXACTLY like the discover_gardssalg MCP tool
 * (experiences-mcp.ts) — same field names, same isBookingPaused()-derived
 * booking object + bilingual notes, same profile_url template, same
 * hasGeo-gated distance_km.
 *
 * Covers:
 *   1. detectGardssalgIntent(): every producer-type keyword maps to the
 *      right producer_type (checked in priority order); "gårdssalg"/
 *      "gårdsbutikk" trigger with no producer_type; an unrelated query
 *      returns isGardssalg:false; "bryggeribesøk"/"sidersmaking" are caught
 *      by the producer-type table itself (no second trigger-word entry
 *      needed); a real false-positive guard ("insider" containing "sider"
 *      as a non-word-boundary substring must NOT trigger).
 *   2. handleExperiencesMessageSend end-to-end: a "sidersmaking" query +
 *      a real seeded kommune surfaces the seeded gårdssalg producer(s),
 *      correct booking shape for both a live and a paused seeded row,
 *      correct profile_url, distance_km present only when a geo origin was
 *      given, the honest zero-hit bilingual message, and — critically — an
 *      ordinary non-gårdssalg query is COMPLETELY unaffected (regression
 *      guard against the pre-existing generic-experiences NL path).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-a2a.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesA2aGardssalgTests() and folds its pass/fail counts into
 *      the `npm test` summary (see opplevelser-discover-relax.test.ts /
 *      opplevelser-gardssalg-mcp-discoverability.test.ts for the precedent
 *      this follows).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperiencesA2aGardssalgTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.BOOKING_DISPATCH_ENABLED;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const experiencesA2aPath = require.resolve("./experiences-a2a");
    const cachePaths = [dbFactoryPath, expStorePath, experiencesA2aPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const a2a = require("./experiences-a2a") as typeof import("./experiences-a2a");
      const { detectGardssalgIntent, handleExperiencesMessageSend, parseExperiencesIntent } = a2a;

      // ── 1. detectGardssalgIntent() unit coverage ──────────────────────
      const producerTypeCases: Array<[string, string]> = [
        ["bryggeri", "bryggeri"],
        ["sideri", "cideri"],
        ["cideri", "cideri"],
        ["sider", "cideri"],
        ["vingård", "vingård"],
        ["destilleri", "destilleri"],
        ["brenneri", "destilleri"],
        ["mjøderi", "mjøderi"],
        ["mjød", "mjøderi"],
        ["seltzeri", "seltzeri"],
        ["seltzer", "seltzeri"],
      ];
      for (const [keyword, expectedType] of producerTypeCases) {
        const r = detectGardssalgIntent(`vi vil besøke et ${keyword} i helgen`);
        assertTrue(r.isGardssalg, `1-${keyword}a: "${keyword}" triggers isGardssalg:true`);
        assertEq(r.producer_type, expectedType, `1-${keyword}b: "${keyword}" maps to producer_type "${expectedType}"`);
      }

      const gTrigger1 = detectGardssalgIntent("finnes det gårdssalg i nærheten?");
      assertTrue(gTrigger1.isGardssalg, "1-gardssalg-a: \"gårdssalg\" triggers isGardssalg:true");
      assertEq(gTrigger1.producer_type, undefined, "1-gardssalg-b: \"gårdssalg\" trigger word sets no producer_type");

      const gTrigger2 = detectGardssalgIntent("har dere en gårdsbutikk?");
      assertTrue(gTrigger2.isGardssalg, "1-gardsbutikk-a: \"gårdsbutikk\" triggers isGardssalg:true");
      assertEq(gTrigger2.producer_type, undefined, "1-gardsbutikk-b: \"gårdsbutikk\" trigger word sets no producer_type");

      const unrelated = detectGardssalgIntent("hva kan vi finne på i tromsø om vinteren?");
      assertEq(unrelated, { isGardssalg: false }, "1-unrelated: an ordinary experiences query returns isGardssalg:false");

      // "bryggeribesøk"/"sidersmaking" must be caught by the producer-type
      // table's own word-prefix matching — verified directly, not assumed.
      const bryggeribesok = detectGardssalgIntent("planlegger et bryggeribesøk i morgen");
      assertTrue(bryggeribesok.isGardssalg, "1-bryggeribesok-a: \"bryggeribesøk\" triggers isGardssalg:true via the producer-type table");
      assertEq(bryggeribesok.producer_type, "bryggeri", "1-bryggeribesok-b: \"bryggeribesøk\" maps to producer_type \"bryggeri\"");

      const sidersmaking = detectGardssalgIntent("hvor kan jeg booke en sidersmaking i bergen?");
      assertTrue(sidersmaking.isGardssalg, "1-sidersmaking-a: \"sidersmaking\" triggers isGardssalg:true via the producer-type table");
      assertEq(sidersmaking.producer_type, "cideri", "1-sidersmaking-b: \"sidersmaking\" maps to producer_type \"cideri\"");

      // False-positive guard: "insider" (a real word used in Norwegian
      // informal/business text) contains "sider" only as a non-word-boundary
      // substring ("in" + "sider") — matchesAsWordPrefix's own word-boundary
      // guarantee must prevent this from triggering.
      const falsePositiveGuard = detectGardssalgIntent("er du en insider i bransjen?");
      assertEq(falsePositiveGuard, { isGardssalg: false }, "1-false-positive: \"insider\" does not falsely trigger via the \"sider\" keyword (non-word-boundary substring)");

      // ── 2. handleExperiencesMessageSend end-to-end ────────────────────
      // Fixtures: two real gårdssalg producers in Bergen (a recognized
      // kommune, KOMMUNE_NAMES/detectKommune — same fixture convention as
      // opplevelser-gardssalg-mcp-discoverability.test.ts), one live for
      // booking (once BOOKING_DISPATCH_ENABLED is set), one never onboarded
      // (booking_live unset -> always paused regardless of the env flag),
      // plus a catalog_hidden=1 row that must never leak through this path
      // either (searchGardssalgProviders()'s own base WHERE clause already
      // guarantees this; re-verified here at the A2A call site).
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, booking_live, catalog_hidden, lat, lon, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @booking_live, @catalog_hidden, @lat, @lon, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`
      );
      insertProvider.run({
        id: "a2a-gm-live", navn: "Bergen Sideri AS", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 1, catalog_hidden: null, lat: 60.39, lon: 5.32, slug: "bergen-sideri",
      });
      insertProvider.run({
        id: "a2a-gm-paused", navn: "Fjordcider Gård AS", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 0, catalog_hidden: null, lat: 60.4, lon: 5.33, slug: "fjordcider-gaard",
      });
      insertProvider.run({
        id: "a2a-gm-hidden", navn: "Skjult Sideri AS", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 1, catalog_hidden: 1, lat: 60.41, lon: 5.34, slug: "skjult-sideri",
      });

      // ── 2a. "sidersmaking" + a real seeded kommune surfaces the seeded rows ──
      const r1: any = handleExperiencesMessageSend({ message: "hvor kan jeg booke en sidersmaking i Bergen?" }, "t1");
      assertTrue(r1.result !== undefined, "2a-1: gårdssalg query returns a result envelope, not an error");
      assertEq(r1.result?.metadata?.skill, "gardssalg_discover", "2a-2: metadata.skill is gardssalg_discover");
      assertTrue(String(r1.result?.taskId || "").startsWith("gardssalg-discover-"), "2a-3: taskId uses the gardssalg-discover- prefix");
      const summaryPart1 = r1.result?.artifacts?.[0]?.parts?.[0]?.text as string;
      assertTrue(typeof summaryPart1 === "string" && summaryPart1.includes("Fant 2 gårdssalg-produsent(er)"), "2a-4: summary reports 2 (hidden row excluded)");
      const dataPart1 = r1.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertEq(dataPart1?.count, 2, "2a-5: data part count is 2");
      const producers1 = dataPart1?.producers as any[];
      const names1 = producers1.map((p) => p.navn);
      assertTrue(names1.includes("Bergen Sideri AS"), "2a-6: live producer present");
      assertTrue(names1.includes("Fjordcider Gård AS"), "2a-7: paused producer present");
      assertTrue(!names1.includes("Skjult Sideri AS"), "2a-8: catalog_hidden=1 row never leaks through the A2A path");

      // ── 2b. booking shape: live vs paused (dispatch enabled) ──────────
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      const r2: any = handleExperiencesMessageSend({ message: "hvor kan jeg booke en sidersmaking i Bergen?" }, "t2");
      const dataPart2 = r2.result?.artifacts?.[1]?.parts?.[0]?.data;
      const liveRow = (dataPart2?.producers as any[]).find((p) => p.navn === "Bergen Sideri AS");
      const pausedRow = (dataPart2?.producers as any[]).find((p) => p.navn === "Fjordcider Gård AS");
      assertEq(liveRow?.booking, { live: true, mode: "request", note: "Book direkte. / Book directly." }, "2b-1: booking_live=1 + dispatch enabled -> live booking shape");
      assertEq(
        pausedRow?.booking,
        { live: false, mode: "paused", note: "Reservasjoner åpner snart; ta kontakt via profilsiden. / Bookings open soon; visit the profile page to get in touch." },
        "2b-2: booking_live not set -> paused booking shape, even with dispatch enabled globally"
      );
      assertEq(liveRow?.profile_url, "https://opplevagent.no/kategori/gardssalg/produsent/bergen-sideri", "2b-3: profile_url built from slug, same template as discover_gardssalg");
      assertEq(liveRow?.distance_km, undefined, "2b-4: distance_km absent when no geo origin was given");
      delete process.env.BOOKING_DISPATCH_ENABLED;

      // ── 2c. booking shape: dispatch OFF -> both rows report paused ────
      const r3: any = handleExperiencesMessageSend({ message: "sidersmaking i Bergen" }, "t3");
      const dataPart3 = r3.result?.artifacts?.[1]?.parts?.[0]?.data;
      const liveRowDispatchOff = (dataPart3?.producers as any[]).find((p) => p.navn === "Bergen Sideri AS");
      assertEq(liveRowDispatchOff?.booking?.live, false, "2c-1: BOOKING_DISPATCH_ENABLED unset -> booking.live:false even for a booking_live=1 provider");
      assertEq(liveRowDispatchOff?.booking?.mode, "paused", "2c-2: booking.mode is paused when the global dispatch switch is off");

      // ── 2d. distance_km present only when a geo origin was given ──────
      // Combines free text (for gårdssalg intent + producer_type detection)
      // with a structured lat/lng origin in message.data — a real
      // agent-client shape (NL intent + a known caller location).
      const r4: any = handleExperiencesMessageSend(
        { message: { text: "sidersmaking i Bergen", data: { lat: 60.39, lng: 5.32 } } },
        "t4"
      );
      const dataPart4 = r4.result?.artifacts?.[1]?.parts?.[0]?.data;
      const producers4 = dataPart4?.producers as any[];
      assertTrue(producers4.length > 0, "2d-1: geo-origin gårdssalg query still returns results");
      assertTrue(producers4.every((p) => typeof p.distance_km === "number"), "2d-2: every row carries a numeric distance_km when a geo origin was given");
      const bergenSideriRow = producers4.find((p) => p.navn === "Bergen Sideri AS");
      assertEq(bergenSideriRow?.distance_km, 0, "2d-3: the exact-origin row reports distance_km 0");

      // ── 2e. zero-hit case: honest bilingual "not found" message ───────
      const r5: any = handleExperiencesMessageSend({ message: "hvor kan jeg booke et destilleri i Kristiansand?" }, "t5");
      const summaryPart5 = r5.result?.artifacts?.[0]?.parts?.[0]?.text as string;
      assertTrue(
        summaryPart5.includes("Ingen gårdssalg-produsenter funnet med de angitte filtrene"),
        "2e-1: zero-hit gårdssalg query returns the honest bilingual 'not found' message (no relaxation into unrelated experiences)"
      );
      const dataPart5 = r5.result?.artifacts?.[1]?.parts?.[0]?.data;
      assertEq(dataPart5?.count, 0, "2e-2: zero-hit count is 0");

      // ── 2f. regression guard: an ordinary non-gårdssalg query is
      //     COMPLETELY unaffected — same code path, byte-identical output ──
      const ordinaryText = "hva kan vi finne på i Tromsø om vinteren?";
      const parsedBefore = parseExperiencesIntent(ordinaryText);
      assertEq(parsedBefore, { kommune: "Tromsø", season: "winter" }, "2f-1: parseExperiencesIntent's return value for the flagship non-gårdssalg demo query is unchanged (kommune+season only, no indoor_outdoor false-positive)");
      // The real regression guard: two independent invocations of the full
      // handler for the same ordinary query produce byte-identical output
      // (modulo the timestamp/taskId, which are inherently time-based) —
      // i.e. the new gårdssalg branch never engages and never mutates the
      // generic "Default: discover" branch's own filter/summary/artifacts.
      const ord1: any = handleExperiencesMessageSend({ message: ordinaryText }, "t6");
      const ord2: any = handleExperiencesMessageSend({ message: ordinaryText }, "t6");
      assertEq(ord1.result?.metadata?.skill, "opplevelser_discover", "2f-2: ordinary query still routes to opplevelser_discover, not gardssalg_discover");
      assertEq(ord1.result?.metadata?.filter, ord2.result?.metadata?.filter, "2f-3: parsed filter is stable/identical across repeated calls for the same ordinary query");
      assertEq(ord1.result?.artifacts?.[0]?.parts, ord2.result?.artifacts?.[0]?.parts, "2f-4: summary artifact is byte-identical across repeated calls");
      assertEq(ord1.result?.artifacts?.[1]?.parts, ord2.result?.artifacts?.[1]?.parts, "2f-5: results artifact is byte-identical across repeated calls");
    } catch (err: any) {
      failed++;
      failures.push("experiences-a2a (gardssalg): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-a2a.test.ts`
if (require.main === module) {
  runExperiencesA2aGardssalgTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
