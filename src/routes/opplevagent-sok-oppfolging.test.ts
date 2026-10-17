/**
 * opplevagent-sok-oppfolging.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-C (Opplevagent search).
 * Evidence: reports/2026-10-17-integrasjonstest-synlighet.md (A2A repo).
 *
 * Covers:
 *   (ai2) REGION_TO_KOMMUNER (norway-fylke.ts) holds real kommuner: every
 *         name is a kommune in the vendored SSB table
 *         (src/data/kommune-fylke-2024.json) that no other kommune shares,
 *         and a region stays in one fylke; the only town is one the live
 *         catalogue files rows under (Svolvær). Lofoten and Hardanger are the
 *         dev-request's lists. «ting å gjøre i Lofoten» finds rows in Vågan
 *         and Vestvågøy (MCP and A2A); «Hardanger» finds Ullensvang and Kvam.
 *   (ai5) discover_gardssalg: a drink word in `query` («cider», «sider»,
 *         «øl») also finds producers of that kind, as producer_type does —
 *         «cider Hardanger» finds at least what producer_type "cideri" +
 *         «Hardanger» finds. Names still rank first, filter_applied is
 *         unchanged, and the booking resolver still resolves names only.
 *   (ai7) discover's tie-break: within the same text rank and confidence,
 *         rows with a price and a booking link first, then one of the two,
 *         then neither, then the title. Text rank and confidence still come
 *         first.
 *
 * Fixture: seedOpplevagentQueryFixture() from
 * opplevagent-mcp-query-intent.test.ts, plus rows of its own.
 *
 * Standalone: npx tsx src/routes/opplevagent-sok-oppfolging.test.ts
 * Wired into the gate via tests/test.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** Towns kept in a region because the live catalogue files rows under them (measured 2026-10-17). */
const CATALOGUE_TOWNS: Readonly<Record<string, readonly string[]>> = { Lofoten: ["Svolvær"] };

export function runOpplevagentSokOppfolgingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/experiences-query-intent"),
      require.resolve("../services/gardssalg-booking-resolve"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-a2a"),
    ]);
    // discover_experiences and message/send log each call; no conversations table here.
    const conversation = (require("../services/conversation-service") as typeof import("../services/conversation-service")).conversationService;
    const realStartConversation = conversation.startConversation;
    conversation.startConversation = (() => undefined as any) as any;
    let session: Awaited<ReturnType<typeof import("./opplevagent-mcp-query-intent.test").openOpplevagentMcpSession>> | undefined;

    try {
      // ── (ai2) the region table against the SSB kommune list ─────────────
      const { REGION_TO_KOMMUNER, cityToFylke } = require("../services/norway-fylke") as typeof import("../services/norway-fylke");
      const ssbRows = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/kommune-fylke-2024.json"), "utf8")) as Array<{ kommunenavn: string; fylkesnavn: string }>;
      // "Herøy (Nordland)" → "Herøy": the table's own qualifier for a shared name.
      const ssbFylker = new Map<string, string[]>();
      for (const r of ssbRows) {
        const name = r.kommunenavn.replace(/\s*\([^)]*\)\s*$/, "");
        ssbFylker.set(name, [...(ssbFylker.get(name) ?? []), r.fylkesnavn]);
      }
      assertTrue(ssbRows.length === 357 && ssbFylker.get("Herøy")?.length === 2, "ai2-0: the SSB table is the 357-kommune list, with Herøy twice");

      for (const [region, kommuner] of Object.entries(REGION_TO_KOMMUNER)) {
        const towns = CATALOGUE_TOWNS[region] ?? [];
        const notKommune = kommuner.filter((k) => !towns.includes(k) && ssbFylker.get(k)?.length !== 1);
        assertEq(notKommune, [], `ai2-1-${region}: every name is a kommune no other kommune shares, or a town with catalogue rows`);
        assertTrue(towns.every((t) => kommuner.includes(t) && !ssbFylker.has(t)), `ai2-2-${region}: the kept towns are listed, and are towns, not kommuner`);
        const fylker = new Set(kommuner.filter((k) => !towns.includes(k)).map((k) => ssbFylker.get(k)?.[0]));
        assertEq(fylker.size, 1, `ai2-3-${region}: the region stays in one fylke`);
        const gazetteerFylke = cityToFylke(region);
        assertTrue(!gazetteerFylke || fylker.has(gazetteerFylke), `ai2-4-${region}: … the fylke the gazetteer files the region under`);
        assertTrue(towns.every((t) => cityToFylke(t) === [...fylker][0]), `ai2-5-${region}: a kept town lies in the region's fylke`);
        assertEq(new Set(kommuner).size, kommuner.length, `ai2-6-${region}: no name twice`);
      }
      assertEq(REGION_TO_KOMMUNER.Lofoten, ["Vågan", "Vestvågøy", "Flakstad", "Moskenes", "Værøy", "Røst", "Svolvær"], "ai2-7: Lofoten is its six kommuner, plus the town Svolvær");
      assertEq(REGION_TO_KOMMUNER.Hardanger, ["Ullensvang", "Ulvik", "Eidfjord", "Kvam", "Kvinnherad"], "ai2-8: Hardanger is its five kommuner");
      const allListed = Object.values(REGION_TO_KOMMUNER).flat();
      const dropped = ["Leknes", "Reine", "Henningsvær", "Odda", "Jondal", "Finnsnes", "Fagernes", "Beitostølen"];
      assertEq(dropped.filter((t) => allListed.includes(t)), [], "ai2-9: regression — the towns and former kommuner without catalogue rows are gone");
      assertTrue(!allListed.includes("Herøy") && !allListed.includes("Våler"), "ai2-10: a name two kommuner share is never listed (Herøy, Våler)");

      // ── Fixture DB ────────────────────────────────────────────────────
      const { seedOpplevagentQueryFixture, openOpplevagentMcpSession } =
        require("./opplevagent-mcp-query-intent.test") as typeof import("./opplevagent-mcp-query-intent.test");
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const ids = seedOpplevagentQueryFixture(expStore, db as any);
      const providerId = expStore.createProvider({
        navn: "Oppfølging Opplevelser AS", fylke: "Nordland", kommune: "Vågan",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const add = (row: Record<string, unknown>): string => expStore.createExperience({
        provider_id: providerId, provider_match_status: "matched",
        verification_status: "verified", confidence: "high", season: ["all_year"],
        ...row,
      } as any);
      ids.svolvaer = add({ kommune: "Svolvær", fylke: "Nordland", title: "Rorbu på Svinøya", category: "overnatting_opplevelse", price_from: 1200 });
      ids.ullensvang = add({ kommune: "Ullensvang", fylke: "Vestland", title: "Fruktgard og fjord", category: "mat_drikke", price_from: 350 });
      ids.kvam = add({ kommune: "Kvam", fylke: "Vestland", title: "Fottur på Kvamskogen", category: "natur_friluft", price_from: 400 });

      const mcpModule = require("./experiences-mcp") as typeof import("./experiences-mcp");
      session = await openOpplevagentMcpSession(mcpModule);
      const { discover, call } = session;
      const kommunerOf = (r: any) => new Set((r.experiences as any[]).map((e) => e.kommune));

      // ── (ai2) MCP and A2A ─────────────────────────────────────────────
      const lofoten = await discover({ query: "ting å gjøre i Lofoten" });
      assertEq(lofoten.filter_applied.kommuner, [...REGION_TO_KOMMUNER.Lofoten], "ai2-11: «ting å gjøre i Lofoten» → the Lofoten kommuner");
      assertTrue(kommunerOf(lofoten).has("Vågan") && kommunerOf(lofoten).has("Vestvågøy"), "ai2-12: AC-C hits from Vågan and Vestvågøy");
      assertTrue(lofoten.experiences.some((e: any) => e.id === ids.svolvaer) && lofoten.experiences.every((e: any) => REGION_TO_KOMMUNER.Lofoten.includes(e.kommune)),
        "ai2-13: … the row filed under the town Svolvær too, and nothing outside Lofoten");
      const lofotenChildren = await discover({ query: "ting å gjøre i Lofoten for barn", limit: 5 });
      assertEq(lofotenChildren.experiences.map((e: any) => e.id).sort(), [ids.lofotenWalk, ids.eagle, ids.svolvaer].sort(),
        "ai2-14: the integration test's repro query («… for barn», limit 5) finds the three Lofoten rows, not one");
      const hardanger = await discover({ query: "opplevelser i Hardanger" });
      assertEq([...kommunerOf(hardanger)].sort(), ["Kvam", "Ullensvang"], "ai2-15: «Hardanger» finds the rows in Ullensvang and Kvam");
      const tromso = await discover({ query: "Tromsø" });
      assertEq([tromso.filter_applied.kommune, tromso.filter_applied.kommuner], ["Tromsø", undefined], "ai2-16: control — a kommune stays a kommune");

      const { handleExperiencesMessageSend } = require("./experiences-a2a") as typeof import("./experiences-a2a");
      const a2a: any = handleExperiencesMessageSend({ message: "ting å gjøre i Lofoten" }, "ai2-a2a");
      const a2aData = a2a.result?.artifacts?.[1]?.parts?.[0]?.data;
      const a2aKommuner = new Set(((a2aData?.experiences as any[]) ?? []).map((e) => e.kommune));
      assertTrue(a2aKommuner.has("Vågan") && a2aKommuner.has("Vestvågøy") && a2aKommuner.has("Svolvær"), "ai2-17: A2A message/send «ting å gjøre i Lofoten» finds Vågan, Vestvågøy and Svolvær too");

      // ── (ai5) drink words in discover_gardssalg's query ──────────────
      const { drinkWordProducerTypes, resolveGardssalgProducerTypeFilter } = require("../services/drink-taxonomy") as typeof import("../services/drink-taxonomy");
      const cideri = resolveGardssalgProducerTypeFilter("cideri");
      assertEq(["cider", "Cider", "sider", "sideri", "cideri", "eplesider"].map(drinkWordProducerTypes), Array(6).fill(cideri),
        "ai5-1: cider/sider words name the producer_type list producer_type 'cideri' expands to");
      assertEq([drinkWordProducerTypes("øl"), drinkWordProducerTypes("mjød")], [["bryggeri"], ["mjøderi", "mjoderi"]], "ai5-2: other kinds likewise (øl, mjød)");
      assertEq(["Hardanger", "drikke", "most", "bryggen", ""].map(drinkWordProducerTypes), [null, null, null, null, null],
        "ai5-3: a place, a generic drink word and a word that only starts like one («bryggen») name no kind");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, rfb_seed_source, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @rfb_seed_source, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      const gs = (id: string, navn: string, producer_type: string | null, place: { fylke?: string; kommune?: string; poststed?: string } = {}, rfb_seed_source: string | null = null) =>
        insertProvider.run({ id, navn, producer_type, rfb_seed_source, slug: id, fylke: place.fylke ?? null, kommune: place.kommune ?? null, poststed: place.poststed ?? null });
      // Shaped like the live Hardanger rows of 2026-10-17.
      gs("gs-alde", "Alde Sider / Ulvik Frukt & Cideri — Ulvik, Hardanger", "sideri", { fylke: "Vestland" });
      gs("gs-hcideri", "Hardanger Cideri — Ullensvang", "cideri", { fylke: "Vestland" });
      gs("gs-saft", "Hardanger Saft- og Siderfabrikk", "sideri", { fylke: "Vestland", kommune: "Ulvik" });
      gs("gs-bonden", "Hardangerbonden", "sideri", { fylke: "Vestland", poststed: "Sekse" });
      gs("gs-bryggeri", "Hardanger Bryggeri — Øystese", "bryggeri", { fylke: "Vestland" });
      gs("gs-solhoi", "Solhøi Cider", "sideri", { fylke: "Oslo", kommune: "Oslo" });
      gs("gs-vin", "Cider og Vin i Hardanger", "vingård", { fylke: "Vestland" });
      gs("gs-rfb", "Hardanger Ciderhus", null, { fylke: "Vestland" }, "rfb-seed");
      gs("gs-egge1", "Egge Gård", "cideri", { fylke: "Trøndelag", kommune: "Steinkjer" });
      gs("gs-egge2", "Egge Gård Sideri", "cideri", { fylke: "Innlandet", kommune: "Lillehammer" });
      gs("gs-fjord", "Fjordgard Bryggeri", "bryggeri", { fylke: "Vestland", kommune: "Bergen" });
      gs("gs-fjord-kafe", "Fjordgard Bryggeri Kafé", "bryggeri", { fylke: "Vestland", kommune: "Bergen" });

      const storeIds = (filter: Record<string, unknown>, expand = false) =>
        expStore.searchGardssalgProviders(filter as any, 50, { expandDrinkWords: expand }).map((r) => r.id);
      const byName = ["gs-alde", "gs-hcideri", "gs-rfb", "gs-vin"];
      assertEq(storeIds({ q: "cider Hardanger" }).sort(), byName, "ai5-4: without expandDrinkWords (the store default) «cider» is a name word only — as before");
      const expanded = storeIds({ q: "cider Hardanger" }, true);
      assertEq([...expanded].sort(), [...byName, "gs-bonden", "gs-saft"].sort(),
        "ai5-5: with it, Hardanger producers of kind cideri/sideri count too; the brewery, the Oslo cidery and no name match is lost");
      const structured = storeIds({ q: "Hardanger", producer_type: cideri });
      assertTrue(structured.length === 4 && structured.every((id) => expanded.includes(id)) && expanded.length >= structured.length,
        "ai5-6: AC-C «cider Hardanger» finds at least everything producer_type 'cideri' + «Hardanger» finds");
      assertEq(storeIds({ q: "Hardanger Cideri" }, true)[0], "gs-hcideri", "ai5-7: a producer named in the query still comes first (name rank)");
      assertEq(storeIds({ q: "Fjordgard Bryggeri" }, true), storeIds({ q: "Fjordgard Bryggeri" }), "ai5-8: regression — a name lookup with a drink word answers as before");
      assertEq(storeIds({ q: "Hardanger" }, true), storeIds({ q: "Hardanger" }), "ai5-9: a query without a drink word answers as before");
      assertEq(storeIds({ q: "most Hardanger" }, true), [], "ai5-10: a generic drink word adds no kind (no producer is named «most»)");
      assertEq(storeIds({ q: "øl Hardanger" }, true), ["gs-bryggeri"], "ai5-11: «øl Hardanger» → the Hardanger brewery, no cidery");
      assertEq(storeIds({ q: "cider Hardanger", producer_type: "bryggeri" }, true), [], "ai5-12: an explicit producer_type still narrows");

      const rankRow = { navn: "Hardangerbonden", slug: null, poststed: "Sekse", kommune: null, producer_type: "sideri" };
      assertEq([expStore.gardssalgQueryRank(rankRow, ["cider", "hardanger"]),
        expStore.gardssalgQueryRank(rankRow, ["cider", "hardanger"], [cideri as string[], null]),
        expStore.gardssalgQueryRank({ ...rankRow, producer_type: "bryggeri" }, ["cider", "hardanger"], [cideri as string[], null])],
        [null, 2, null], "ai5-13: gardssalgQueryRank accepts a kind only where it is given, and only that kind");

      const resolve = require("../services/gardssalg-booking-resolve") as typeof import("../services/gardssalg-booking-resolve");
      const egge = resolve.resolveGardssalgProviderByQuery("Egge sideri");
      assertEq(egge.kind === "one" ? egge.provider.id : egge.kind, "gs-egge2",
        "ai5-14: the booking resolver is not widened: «Egge sideri» is still the one producer named so, not every Egge cidery");

      const gsCall = async (args: Record<string, unknown>) => JSON.parse((await call("discover_gardssalg", args))?.content?.[0]?.text ?? "{}");
      const gsIds = (r: any) => (r.gardssalg_producers as any[]).map((p) => p.id);
      const free = await gsCall({ query: "gårdssalg cider Hardanger" });
      assertEq(gsIds(free).sort(), [...expanded].sort(), "ai5-15: discover_gardssalg «gårdssalg cider Hardanger» uses the kind");
      assertEq(free.filter_applied, { q: "cider Hardanger" }, "ai5-16: filter_applied is unchanged (no new key in the response)");
      const typed = await gsCall({ producer_type: "cideri", query: "Hardanger" });
      assertTrue(free.count >= typed.count && gsIds(typed).every((id: string) => gsIds(free).includes(id)),
        "ai5-17: AC-C over MCP: at least the hits of producer_type 'cideri' + «Hardanger»");
      const sider = await gsCall({ query: "sider Hardanger" });
      assertEq(gsIds(sider).sort(), [...structured].sort(),
        "ai5-18: «sider» names the same kind as «cider» (the producers named «cider» but of no cider kind are name hits for «cider» only)");
      const named = await gsCall({ query: "Fjordgard Bryggeri" });
      assertEq(gsIds(named), ["gs-fjord", "gs-fjord-kafe"], "ai5-19: the tool's own example query still puts the exact name first");

      // ── (ai7) discover's tie-break ────────────────────────────────────
      const vardo = { kommune: "Vardø", fylke: "Finnmark", category: "kultur_historie" };
      const booking = "https://example.no/book";
      ids.a = add({ ...vardo, title: "A uten pris og lenke" });
      ids.b = add({ ...vardo, title: "B bare pris", price_from: 200 });
      ids.c = add({ ...vardo, title: "C bare bookinglenke", booking_url: booking });
      ids.d = add({ ...vardo, title: "D komplett", price_from: 300, booking_url: booking });
      ids.e = add({ ...vardo, title: "E komplett og gratis", price_from: 0, booking_url: booking });
      ids.f = add({ ...vardo, title: "F tom bookinglenke", booking_url: "   " });
      ids.g = add({ ...vardo, title: "Aa komplett, medium", price_from: 100, booking_url: booking, confidence: "medium" });
      const order = (filter: Record<string, unknown>, limit = 50) => expStore.discoverExperiences(filter as any, limit).map((e) => e.id);
      assertEq(order({ kommune: "Vardø" }), [ids.d, ids.e, ids.b, ids.c, ids.a, ids.f, ids.g],
        "ai7-1: price + booking link first, then one of them, then neither; title last; a price of 0 counts, a blank link does not; confidence still first");
      assertEq(order({ kommune: "Vardø" }, 2), [ids.d, ids.e], "ai7-2: with total > limit the page holds the complete rows");
      assertEq(expStore.countDiscoverExperiences({ kommune: "Vardø" }), 7, "ai7-3: the count is untouched");

      const batsfjord = { kommune: "Båtsfjord", fylke: "Finnmark", category: "kultur_historie" };
      ids.fyrTitle = add({ ...batsfjord, title: "Fyrtårnet på neset" });
      ids.fyrDesc = add({ ...batsfjord, title: "Omvisning langs kysten", description: "Vi går til fyret.", price_from: 250, booking_url: booking });
      assertEq(order({ kommune: "Båtsfjord", text_terms: ["fyr"] }), [ids.fyrTitle, ids.fyrDesc],
        "ai7-4: text rank still comes first — a title hit without data before a complete description-only hit");

      // The integration test's repro (AI-7): «hvalsafari i Tromsø» opened
      // with a row that has neither price nor booking link.
      ids.nordlysHval = add({ kommune: "Tromsø", fylke: "Troms", title: "Nordlys- og hvalsafari fra Tromsø", category: "dyreliv_safari", season: ["winter"] });
      const whale = await discover({ query: "hvalsafari i Tromsø" });
      assertEq(whale.experiences.map((e: any) => e.id), [ids.whaleWatching, ids.whaleSafari, ids.nordlysHval, ids.museum],
        "ai7-5: the title hits with a price before the one without; the description-only hit last");
    } catch (err: any) {
      failed++;
      failures.push("opplevagent-sok-oppfolging: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      conversation.startConversation = realStartConversation;
      if (session) await session.close();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevagent-sok-oppfolging.test.ts`
if (require.main === module) {
  runOpplevagentSokOppfolgingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
