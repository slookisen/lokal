/**
 * opplevelser-discover-query.test.ts — dev-request
 * 2026-10-16-opplevagent-mcp-fritekst-query, S4.
 *
 * Bug: GET /api/opplevelser/discover read `q` in the gårdssalg branch only,
 * so ?q=hvalsafari%20i%20Troms%C3%B8 answered with the first rows of the
 * whole country, while the MCP tool discover_experiences (S2) already read
 * the same words as kommune Tromsø + the search word «hvalsafari».
 *
 * Covers:
 *   (r) REST with `q`: the S4 acceptance criterion (only Tromsø rows and a
 *       query_interpretation field), the S2 criteria seen through REST
 *       (region, bygd → fylke, nonsense, a general question, false
 *       positives, an empty place), out_of_area (also for a foreign
 *       fylke/kommune or origin), out_of_scope for buying stockfish, the
 *       gårdssalg pointer, explicit parameters winning, `total` agreeing with
 *       the page when search words are relaxed gradually, and `q` in the
 *       gårdssalg branch untouched.
 *   (n) REST without `q` (or with a blank or repeated one): the old answer,
 *       incl. the old relaxation of a place (no place protection).
 *   (p) parity: REST ?q= and MCP {query} give the same filter,
 *       query_interpretation, rows, relaxed_filters and zero_hit_reason for
 *       the submission's prompts and the S2 cases.
 *   (s) countDiscoverExperiences(filter, {textTermsMatched}).
 *   (o) /openapi.json documents `q` for both branches and the new fields,
 *       within the GPT Actions description limits.
 *
 * Fixture: opplevagent-mcp-query-intent.test.ts. The MCP side runs over an
 * in-memory transport, not HTTP: the gate's MCP suites share one per-IP
 * JSON-RPC rate limit (jsonRpcLimiter), and later suites need what is left.
 *
 * Standalone: npx tsx src/routes/opplevelser-discover-query.test.ts
 * Wired into the gate via tests/test.ts (the 2026-10-16 free-text block).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type Body = Record<string, any>;

// Same synthetic router.handle() shortcut as opplevelser-discover-relax.test.ts.
// The body goes through JSON like on the wire (undefined fields drop out).
function callRoute(router: any, url: string, query?: Record<string, unknown>): Promise<{ status: number; body: Body }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: query ?? Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(body: unknown) { resolve({ status: statusCode, body: JSON.parse(JSON.stringify(body)) }); return this; },
    };
    router.handle(req, res, (err?: unknown) => resolve({ status: 404, body: { unhandled: true, err: String(err ?? "") } }));
  });
}

export function runOpplevelserDiscoverQueryTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      require.resolve("../services/experiences-openapi"),
      require.resolve("./experiences-mcp"),
      require.resolve("./opplevelser"),
    ]);
    // discover_experiences logs each call; the parity half needs no conversations table.
    const conversation = (require("../services/conversation-service") as typeof import("../services/conversation-service")).conversationService;
    const realStartConversation = conversation.startConversation;
    conversation.startConversation = (() => undefined as any) as any;
    const fixtureModule = require("./opplevagent-mcp-query-intent.test") as typeof import("./opplevagent-mcp-query-intent.test");
    let closeMcp: (() => Promise<void>) | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const ids = fixtureModule.seedOpplevagentQueryFixture(expStore, db as any);
      const { REGION_TO_KOMMUNER } = require("../services/norway-fylke") as typeof import("../services/norway-fylke");
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const rest = async (params: string): Promise<Body> => (await callRoute(router, `/discover?${params}`)).body;
      const q = (text: string, extra = "") => rest(`q=${encodeURIComponent(text)}${extra}`);
      const rowIds = (b: Body) => (b.results as any[]).map((e) => e.id);

      // ── (r) REST with q ──────────────────────────────────────────────
      // S4 acceptance criterion.
      const whale = await rest("q=hvalsafari%20i%20Troms%C3%B8");
      assertTrue(whale.vertical === "experiences" && whale.count > 0 && whale.results.every((e: any) => e.kommune === "Tromsø"),
        "r1: S4 AC ?q=hvalsafari i Tromsø gives only Tromsø rows");
      assertEq(rowIds(whale), [ids.whaleWatching, ids.whaleSafari, ids.museum], "r2: … the whale rows, title hits first (as MCP m2)");
      assertEq(whale.query_interpretation, { source: "query", kommune: "Tromsø", terms: ["hvalsafari"] }, "r3: S4 AC … with a query_interpretation field");
      assertEq(whale.query, { kommune: "Tromsø", text_terms: ["hvalsafari"] }, "r4: `query` is the filter that was searched");
      assertEq([whale.total, whale.relaxed_filters, whale.note, whale.zero_hit_reason], [3, undefined, undefined, undefined],
        "r5: total is the full match count; no relaxation, no zero reason");

      const lofoten = await q("Lofoten");
      assertTrue(JSON.stringify(lofoten.query.kommuner) === JSON.stringify(REGION_TO_KOMMUNER.Lofoten) && lofoten.count === 2 &&
        lofoten.results.every((e: any) => REGION_TO_KOMMUNER.Lofoten.includes(e.kommune)), "r6: «Lofoten» → the Lofoten kommuner, never nationwide");
      const geiranger = await q("Geiranger fjordcruise");
      assertEq([geiranger.query.fylke, geiranger.query.kommune, geiranger.query.text_terms, rowIds(geiranger)],
        ["Møre og Romsdal", undefined, ["geiranger", "fjordcruise"], [ids.geiranger]], "r7: a bygd without its own rows → its fylke plus search words");
      const nonsense = await q("zzzqqq");
      assertTrue(nonsense.count === 0 && nonsense.total === 0 && nonsense.results.length === 0 && nonsense.zero_hit_reason === "unrecognized_query" &&
        Array.isArray(nonsense.valid_categories) && nonsense.valid_categories.includes("dyreliv_safari") && /no experience contains its search words/.test(nonsense.note),
        "r8: «zzzqqq» → count 0, unrecognized_query, valid_categories — not the catalogue");
      const norway = await q("what can we do in Norway");
      assertTrue(norway.count > 0 && norway.zero_hit_reason === undefined && JSON.stringify(norway.query) === "{}" && norway.query_interpretation === undefined,
        "r9: a general question still browses the catalogue");
      const ski = await q("ski touring");
      const goodTime = await q("a good time in Bergen");
      assertTrue(ski.query.kommune === undefined && goodTime.query.kommune === "Bergen" && goodTime.results.every((e: any) => e.kommune === "Bergen"),
        "r10: false positives: «ski touring» sets no kommune Ski; «a good time in Bergen» is Bergen, not Time");
      const alta = await q("Hva kan vi gjøre i Alta?");
      assertTrue(alta.count === 0 && alta.zero_hit_reason === "place_no_match" && alta.query.fylke === "Finnmark" && /Ingen opplevelser funnet i Finnmark/.test(alta.note) &&
        Array.isArray(alta.suggestions) && alta.suggestions.length > 0, "r11: a place from q with nothing there → place_no_match with suggestions, not the whole country");
      const unknownPlace = await rest("kommune=Ukjentby&q=hvalsafari");
      assertTrue(unknownPlace.count === 0 && unknownPlace.zero_hit_reason === "place_no_match" && unknownPlace.query.text_terms === undefined,
        "r12: with q, an explicit kommune without rows is an honest zero (same place protection as MCP)");
      const storslett = await rest(`kommune=Storslett&q=${encodeURIComponent("things to do")}`);
      assertTrue(storslett.count > 0 && storslett.results.every((e: any) => e.fylke === "Troms") && storslett.total === storslett.count,
        "r13: with q, an empty kommune is widened once to its fylke");
      assertEq([storslett.relaxed_filters, storslett.query_interpretation], [["kommune→fylke"], undefined], "r13b: … reported as kommune→fylke; nothing read from q");
      const spa = await q("spa");
      assertTrue(spa.count === 0 && spa.zero_hit_reason === "relaxation_exhausted" && spa.relaxed_filters.includes("category") && spa.results.length === 0,
        "r14: the only filter read from q relaxed away → relaxation_exhausted, not the catalogue");

      // Search words relaxed gradually: total counts the rows the page is made of.
      const n1 = await q("Book the northern lights cruise for two people and charge my credit card now");
      assertEq([rowIds(n1), n1.relaxed_filters, n1.total], [[ids.arctic], ["text_terms"], 1],
        "r15: N1 finds the Arctic Explorer cruise; total 1 (rows with 3 of the 6 search words), not 0");
      assertTrue(/3 av dem/.test(n1.note) && /3 of them/.test(n1.note), "r16: … and the note says how many search words the hits have");

      // Outside Norway, as discover_experiences.
      for (const [text, place] of [["Find me a safari lodge in Kenya for next month", "Kenya"], ["things to do in Gran Canaria", "Gran Canaria"]]) {
        const r = await q(text);
        assertTrue(r.out_of_area === true && r.place === place && r.count === 0 && r.total === 0 && r.results.length === 0 && r.query_interpretation === undefined,
          `r17: «${text}» is outside Norway: out_of_area, no rows`);
      }
      const london = await rest(`kommune=Troms%C3%B8&q=${encodeURIComponent("flying in from London, what can we do?")}`);
      assertTrue(london.out_of_area === undefined && london.count === 7 && london.results.every((e: any) => e.kommune === "Tromsø"),
        "r18: a foreign word next to an explicit place is not out_of_area (the place parameter decides)");
      // The place parameters themselves are checked too, as discover_experiences
      // does (outsideNorwayPlace); without q they keep the old answer (n1).
      for (const [params, place] of [["kommune=Kenya&q=safari", "Kenya"], [`fylke=Spania&q=${encodeURIComponent("hva kan vi gjøre")}`, "Spania"], ["lat=0&lng=0&q=hvalsafari", "0, 0"]]) {
        const r = await rest(params);
        assertTrue(r.out_of_area === true && r.place === place && r.count === 0 && r.results.length === 0 && r.zero_hit_reason === undefined,
          `r24: ?${decodeURIComponent(params)} is outside Norway: out_of_area «${place}», no rows`);
      }
      // An origin in Norway is searched (the fixture's one geocoded row).
      db.prepare("UPDATE experiences SET loc_lat = 69.65, loc_lon = 18.95, geo_precision = 'address' WHERE id = ?").run(ids.whaleSafari);
      const nearTromso = await rest("lat=69.65&lng=18.96&q=hvalsafari");
      assertTrue(nearTromso.out_of_area === undefined && JSON.stringify(rowIds(nearTromso)) === JSON.stringify([ids.whaleSafari]) &&
        typeof nearTromso.results[0].distance_km === "number", "r24b: an origin in Norway with q is searched, with distances");

      // Buying stockfish is out of scope, as discover_experiences; a place
      // outside Norway is checked first; food experiences stay supported.
      const stockfish = await q("Where can I buy stockfish in Lofoten?");
      assertTrue(stockfish.out_of_scope === true && stockfish.scope_reason === "food_product_purchase" && stockfish.count === 0 && stockfish.total === 0 &&
        stockfish.results.length === 0 && JSON.stringify(stockfish.query) === "{}" && stockfish.query_interpretation === undefined && /tørrfisk/.test(stockfish.note),
        "r25: «Where can I buy stockfish in Lofoten?» → out_of_scope, no Lofoten rows");
      const stockfishAbroad = await q("buy stockfish in Iceland");
      assertTrue(stockfishAbroad.out_of_area === true && stockfishAbroad.place === "Iceland" && stockfishAbroad.out_of_scope === undefined,
        "r25b: a purchase abroad is out_of_area first (discover_experiences' order)");
      const stockfishMuseum = await q("stockfish museum in Lofoten");
      assertTrue(stockfishMuseum.out_of_scope === undefined && JSON.stringify(stockfishMuseum.query.kommuner) === JSON.stringify(REGION_TO_KOMMUNER.Lofoten),
        "r25c: «stockfish museum in Lofoten» is an experience search, not out_of_scope");

      // Gårdssalg read from q points to the gårdssalg branch.
      const farm = await q("gårdssalg i Bergen");
      assertTrue(farm.vertical === "experiences" && farm.count === 0 && farm.results.length === 0 && farm.query.category === "gardssalg_smaking" &&
        /category=gardssalg_smaking/.test(farm.note) && farm.query_interpretation?.source === "query" && Array.isArray(farm.valid_categories),
        "r19: «gårdssalg i Bergen» → a pointer to category=gardssalg_smaking, not experiences with gårdssalg relaxed away");

      // Explicit parameters win.
      const explicitPlace = await rest(`kommune=Troms%C3%B8&q=${encodeURIComponent("hvalsafari i Bergen")}`);
      assertTrue(explicitPlace.query.kommune === "Tromsø" && explicitPlace.query.text_terms === undefined && explicitPlace.query_interpretation === undefined && explicitPlace.count === 7,
        "r20: an explicit kommune wins; q adds no search words");
      const explicitCategory = await rest(`category=kultur_historie&q=${encodeURIComponent("wildlife in Tromsø")}`);
      assertEq([explicitCategory.query.category, explicitCategory.query.kommune, rowIds(explicitCategory)], ["kultur_historie", "Tromsø", [ids.museum]],
        "r21: an explicit category wins over q's alias word; q still fills the empty place");
      const bothForms = await rest(`fylke=Troms&season=winter&q=${encodeURIComponent("Hva kan vi finne på i Troms om vinteren?")}`);
      const structured = await rest("fylke=Troms&season=winter");
      assertEq([rowIds(bothForms), bothForms.total, bothForms.query_interpretation], [rowIds(structured), structured.total, undefined],
        "r22: P1 with q and the structured parameters answers like the structured parameters alone");

      // q in the gårdssalg branch is unchanged.
      const gardssalg = await rest(`category=gardssalg_smaking&q=${encodeURIComponent("hvalsafari i Tromsø")}`);
      assertEq([gardssalg.vertical, Object.keys(gardssalg), gardssalg.query], ["gardssalg", ["vertical", "query", "count", "results"], { q: "hvalsafari i Tromsø" }],
        "r23: category=gardssalg_smaking keeps q as its producer lookup; nothing is interpreted");

      // ── (n) without q: the old answer ────────────────────────────────
      for (const params of ["fylke=Troms", "fylke=Troms&season=winter", "kommune=Ukjentby", "category=foo", "max_price=10", "limit=3", "kommune=Kenya", "lat=0&lng=0"]) {
        const plain = await rest(params);
        const blank = await rest(`${params}&q=`);
        const spaces = await rest(`${params}&q=%20%20%20`);
        assertTrue(JSON.stringify(plain) === JSON.stringify(blank) && JSON.stringify(plain) === JSON.stringify(spaces),
          `n1: ?${params} answers the same with a blank q`);
        assertTrue(!["query_interpretation", "zero_hit_reason", "out_of_area", "place", "out_of_scope", "scope_reason", "valid_categories"].some((k) => k in plain),
          `n2: ?${params} carries none of the q-only fields`);
      }
      const ukjentby = await rest("kommune=Ukjentby");
      assertTrue(ukjentby.count > 0 && JSON.stringify(ukjentby.relaxed_filters) === '["kommune"]',
        "n3: without q an empty kommune is still relaxed away as before (place protection is MCP/q only)");
      assertEq(Object.keys(await rest("fylke=Troms")), ["vertical", "query", "count", "total", "results"], "n4: a direct hit answers with exactly the old fields");
      const repeated = await callRoute(router, "/discover?q=hval&q=Troms%C3%B8", { q: ["hval", "Tromsø"] });
      assertEq(repeated.body, await rest(""), "n5: a repeated q (not one string) is ignored, as the gårdssalg branch does");

      // ── (s) countDiscoverExperiences with textTermsMatched ───────────
      const terms = { text_terms: ["northern", "lights", "cruise", "charge"] };
      assertEq([expStore.countDiscoverExperiences(terms), expStore.countDiscoverExperiences(terms, { textTermsMatched: 3 }), expStore.countDiscoverExperiences(terms, { textTermsMatched: 1 })],
        [0, 1, 3], "s1: no row has all four words; one has three (Arctic Explorer); three have one (+ the Orca safari and the Geirangerfjord cruise)");
      assertEq(expStore.countDiscoverExperiences({ kommune: "Tromsø" }, { textTermsMatched: 2 }), 7, "s2: without text_terms the option changes nothing");

      // ── (p) parity with discover_experiences ─────────────────────────
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
      const mcpServer = new McpServer({ name: "rest-parity-test", version: "0.0.0" });
      (require("./experiences-mcp") as typeof import("./experiences-mcp")).registerExperienceTools(mcpServer);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client({ name: "rest-parity-client", version: "0.0.0" });
      await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
      closeMcp = async () => { await mcpClient.close(); await mcpServer.close(); };
      const mcpDiscover = async (args: Record<string, unknown>): Promise<Body> =>
        (await mcpClient.callTool({ name: "discover_experiences", arguments: args })).structuredContent as Body;
      const definedSorted = (o: Record<string, unknown> | undefined) =>
        Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
      const view = (filter: Record<string, unknown> | undefined, b: Body, rows: any[]) => ({
        filter: definedSorted(filter),
        query_interpretation: b.query_interpretation,
        ids: rows.map((e) => e.id),
        relaxed_filters: b.relaxed_filters,
        zero_hit_reason: b.zero_hit_reason,
        out_of_area: b.out_of_area,
        place: b.place,
        out_of_scope: b.out_of_scope,
        scope_reason: b.scope_reason,
      });
      const parityCases: Array<Record<string, string | number>> = [
        // The submission's discover_experiences prompts (P1, P2, P4, N1, N3).
        { query: "Hva kan vi finne på i Troms om vinteren?" },
        { query: "Show me the details of the Arctic Explorer northern lights cruise in Tromsø" },
        { query: "Find wildlife and animal experiences in Norway" },
        { query: "Book the northern lights cruise for two people and charge my credit card now" },
        { query: "Find me a safari lodge in Kenya for next month" },
        // S2 cases.
        { query: "hvalsafari i Tromsø" }, { query: "Lofoten" }, { query: "Geiranger fjordcruise" }, { query: "zzzqqq" },
        { query: "what can we do in Norway" }, { query: "Nord-Norge vinter" }, { query: "dog sledding in Lyngen" },
        { query: "matvandring i Storslett" }, { query: "Hva kan vi gjøre i Alta?" }, { query: "spa" }, { query: "gårdssalg i Bergen" },
        { query: "outdoor activities in Oslo" }, { query: "Norwegian fjords" }, { query: "dog sledding blåbærsyltetøy" },
        // With structured arguments.
        { kommune: "Storslett", query: "things to do" },
        { kommune: "Tromsø", query: "hvalsafari i Bergen" },
        { kommune: "Tromsø", query: "flying in from London, what can we do?" },
        { category: "dyreliv_safari", query: "wildlife experiences across Norway, preferably with whales" },
        { category: "kultur_historie", query: "wildlife in Tromsø" },
        { fylke: "Troms", season: "winter", query: "Hva kan vi finne på i Troms om vinteren?" },
        // The early returns: a foreign place parameter or origin, and buying stockfish.
        { kommune: "Kenya", query: "safari" }, { fylke: "Spania", query: "hva kan vi gjøre" },
        { lat: 0, lng: 0, query: "hvalsafari" }, { lat: 69.65, lng: 18.96, query: "hvalsafari" },
        { query: "Where can I buy stockfish in Lofoten?" }, { query: "buy stockfish in Iceland" }, { query: "stockfish museum in Lofoten" },
      ];
      for (const args of parityCases) {
        const mcp = await mcpDiscover(args);
        const params = Object.entries(args).map(([k, v]) => `${k === "query" ? "q" : k}=${encodeURIComponent(String(v))}`).join("&");
        const r = await rest(params);
        assertEq(view(r.query, r, r.results), view(mcp.filter_applied, mcp, mcp.experiences), `p1: REST ?${decodeURIComponent(params)} answers like MCP`);
        assertEq(r.count, mcp.count, `p2: … same count (${mcp.count})`);
      }

      // ── (o) /openapi.json ────────────────────────────────────────────
      const { getExperiencesOpenapi } = require("../services/experiences-openapi") as typeof import("../services/experiences-openapi");
      const discover = (getExperiencesOpenapi() as any).paths["/api/opplevelser/discover"].get;
      const qParam = discover.parameters.find((p: any) => p.name === "q");
      assertTrue(!!qParam && !/Gårdssalg-only/.test(qParam.description) && !/Ignored outside/.test(qParam.description) &&
        /discover_experiences/.test(qParam.description) && /query_interpretation/.test(qParam.description) && /gardssalg_smaking/.test(qParam.description),
        "o1: openapi documents q for both branches (no longer «Gårdssalg-only»)");
      assertEq(Object.keys(qParam.examples), ["experience", "gardssalg"], "o2: … with an example for each branch");
      const props = discover.responses["200"].content["application/json"].schema.properties;
      assertTrue(["total", "query_interpretation", "zero_hit_reason", "out_of_area", "place", "out_of_scope", "scope_reason", "valid_categories", "relaxed_filters", "note"].every((k) => k in props) &&
        JSON.stringify(props.zero_hit_reason.enum) === '["unrecognized_query","place_no_match","relaxation_exhausted"]',
        "o3: the response schema declares the fields an answer with q can carry");
      const example = discover.responses["200"].content["application/json"].examples.experiencesQuery.value;
      assertEq([example.query, example.query_interpretation], [whale.query, whale.query_interpretation], "o4: the q example matches what the server answers");
      // GPT Actions (the Custom GPT imports this schema) caps an endpoint's
      // summary/description at 300 characters and a parameter's description
      // at 700 (OpenAI, "Production notes on GPT Actions"). Every parameter and
      // summary fits; the /discover description (549 characters) was already
      // over 300 before `q` was documented and is unchanged here.
      const tooLong: string[] = [];
      for (const [path, ops] of Object.entries((getExperiencesOpenapi() as any).paths as Record<string, Record<string, any>>)) {
        for (const [method, op] of Object.entries(ops)) {
          if (String(op.summary ?? "").length > 300) tooLong.push(`${method} ${path} summary`);
          for (const param of op.parameters ?? []) if (String(param.description ?? "").length > 700) tooLong.push(`${method} ${path} ?${param.name}`);
        }
      }
      assertEq(tooLong, [], "o5: every summary ≤ 300 and every parameter description ≤ 700 characters (GPT Actions limits)");
      assertTrue(!/`q`/.test(discover.description), "o6: the /discover description is not lengthened; `q` is documented on the parameter");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-discover-query: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      conversation.startConversation = realStartConversation;
      if (closeMcp) await closeMcp();
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

// Standalone runner: `npx tsx src/routes/opplevelser-discover-query.test.ts`
if (require.main === module) {
  runOpplevelserDiscoverQueryTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
