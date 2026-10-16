/**
 * dental-natural-search.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S3).
 *
 * The shared parser wired into the three search surfaces, against an
 * in-memory fixture DB:
 *   M   MCP tannlege_search over a real McpServer + client (tools/call):
 *       natural queries, tolkning, explicit arguments win, 0-hit fallback,
 *       rollback switch, and the server card's natural-language claim.
 *   W   /sok: «tannlege i Bergen» shows clinics + «Tolket som», raw q is
 *       still what logWebSearch gets, form fields win, rollback switch.
 *   A   A2A message/send: the four agent-card examples find clinics;
 *       metadata.filter/tolkning; parseIntent still exported (pr113-03).
 *   G   the gazetteer cache runs listPoststeder(1) once per TTL for all three.
 *   T   /sok answers well under a second on a 3,000-row fixture.
 *
 * Standalone: npx tsx src/routes/dental-natural-search.test.ts
 * Wired into tests/test.ts via runDentalNaturalSearchTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, path: string, query: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query, headers: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      set() { return this; },
      once() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? ""), body: payload }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload), body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled"), body: null }));
  });
}

export async function runDentalNaturalSearchTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevDisabled = process.env.DENTAL_QUERY_PARSER_DISABLED;
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental-seo"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental-a2a"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  const logged: Array<{ query: string; resultCount?: number }> = [];
  (analyticsService as any).logWebSearch = (_req: unknown, _ms: number, result: { query: string; resultCount?: number }) => { logged.push(result); };
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const gaz = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    gaz.__resetDentalSearchGazetteerForTesting();

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ telefon: "22000000", ...row } as any);
      const cols = Object.keys(extra);
      if (cols.length) db.prepare(`UPDATE dental_agents SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...extra, id });
      return id;
    };
    const kjeveTitle = (title: string) => ({ specialists: JSON.stringify([{ name: "Spesialist", title }]) });
    add({ navn: "Bergen Sentrum Tannlege", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003", helfo_agreement: "true" });
    add({ navn: "Bryggen Tann", poststed: "Bergen", fylke: "Vestland", postnummer: "5003" });
    add({ navn: "Fana Regulering", poststed: "BERGEN", fylke: "Vestland", postnummer: "5004" }, kjeveTitle("Kjeveortoped"));
    add({ navn: "Laksevåg Tannregulering", poststed: "BERGEN", fylke: "Vestland", postnummer: "5005" }, kjeveTitle("Spesialist i kjeveortopedi"));
    add({ navn: "Nordnes Spesialistklinikk", poststed: "BERGEN", fylke: "Vestland", postnummer: "5006", available_specialties: ["kjeveortopedi"] });
    const bergenAkutten = add({ navn: "Bergen Akutten Tannklinikk", poststed: "BERGEN", fylke: "Vestland", postnummer: "5007" });
    add({ navn: "Oslo Helfo Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0150", helfo_agreement: "true" });
    add({ navn: "Majorstua Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0151" });
    add({ navn: "Stavanger Akuttvakt", poststed: "STAVANGER", fylke: "Rogaland", postnummer: "4006" }, { acute_vakt: 1 });
    add({ navn: "Trondheim Regulering", poststed: "TRONDHEIM", fylke: "Trøndelag", postnummer: "7010" }, kjeveTitle("Kjeveortoped"));
    const sandvika = add({ navn: "Sandvika Tann", poststed: "SANDVIKA", fylke: "Akershus", postnummer: "1337" });
    const stabekk = add({ navn: "Stabekk Tann", poststed: "Baerum", fylke: "Akershus", postnummer: "1368" });
    const bergenTotal = 6;

    // ── M: MCP tannlege_search over a real server + client ───────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-natural-search-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-natural-search-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const search = async (args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name: "tannlege_search", arguments: args });
      return JSON.parse(r.content[0].text);
    };

    {
      const r = await search({ query: "tannlege i Bergen" });
      assertEq(r.count, bergenTotal, "M1: «tannlege i Bergen» finds every Bergen clinic (both stored spellings; it used to find 0)");
      assertEq(r.tolkning?.tolket_som, ["sted: Bergen (poststed)"], "M2: tolkning says what was used");
      assertEq(r.tolkning?.fallback, false, "M3: no fallback");
      assertEq((await search({ query: "Bergen" })).count, r.count, "M4: equals the count for «Bergen» alone");
    }
    assertEq((await search({ query: "kjeveortoped Bergen" })).count, 3, "M5: «kjeveortoped Bergen» -> the 3 orthodontists (title stem, title, structured)");
    assertTrue((await search({ query: "dentist in Oslo" })).count > 0, "M6: «dentist in Oslo» > 0");
    assertEq((await search({ fylke: "vestland" })).count, (await search({ fylke: "Vestland" })).count, "M7: fylke «vestland» == «Vestland»");
    {
      const r = await search({ query: "tannlege i Bærum" });
      assertEq(r.klinikker.map((k: any) => k.navn).sort(), ["Sandvika Tann", "Stabekk Tann"], "M8: «tannlege i Bærum» finds Bærum clinics by postnummer");
      assertTrue(JSON.stringify(r.tolkning).includes("Bærum"), "M9: tolkning mentions Bærum");
    }
    assertEq((await search({ query: "helfo tannlege Oslo", helfo: false })).count, 2, "M10: helfo:false overrides «helfo» in the text");
    assertEq((await search({ query: "Hordaland", fylke: "Rogaland" })).count, 1, "M11: an explicit fylke wins over the parsed one");
    assertEq((await search({ query: "Bergen", spesialitet: "kjeveortopedi" })).count, 3, "M12: explicit spesialitet combines with the parsed place");
    assertEq((await search({ spesialitet: "oral-kirurgi-og-oral-medisin" })).count, 0, "M13: a slug is read as the stored name (no rows here, no error)");
    {
      const r = await search({ query: "Bergen Akutten" });
      assertEq(r.klinikker.map((k: any) => k.navn), ["Bergen Akutten Tannklinikk"], "M14: 0 parsed hits (akutt in Bergen) -> the old whole-text match");
      assertEq(r.tolkning?.fallback, true, "M15: tolkning.fallback is true");
      void bergenAkutten;
    }
    {
      const r = await search({ query: "tannlege" });
      assertEq(r.count, 12, "M16: «tannlege» alone lists every clinic");
      assertEq(r.tolkning?.tolket_som, [], "M17: ... with nothing to report in tolkning");
    }
    {
      const r = await search({ limit: 5 });
      assertTrue(r.count === 12 && r.tolkning === undefined, "M18: no query -> no tolkning key (response unchanged)");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      const r = await search({ query: "tannlege i Bergen" });
      assertTrue(r.count === 0 && r.tolkning === undefined, "M19: DENTAL_QUERY_PARSER_DISABLED=1 -> the old whole-text search (0) and no tolkning");
      assertEq((await search({ query: "Bergen" })).count, 6, "M20: switched off, «Bergen» still matches as before");
    }
    delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    {
      const seo = require("./dental-seo") as typeof import("./dental-seo");
      const card = await callRoute(seo.default as any, "/.well-known/mcp/server-card.json");
      const desc = String(card.body?.description ?? "");
      assertTrue(desc.includes("natural-language queries in Norwegian and English"), "M21: the server card claims natural-language queries");
      assertTrue((await search({ query: "finn kjeveortoped i Bergen med Helfo-avtale" })).tolkning?.tolket_som.length === 3, "M22: ... a Norwegian sentence is understood (place, specialty, Helfo)");
      assertTrue((await search({ query: "find an orthodontist in Trondheim" })).count === 1, "M23: ... and an English one finds the clinic");
    }

    // ── W: /sok ───────────────────────────────────────────────────────────
    const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
    {
      logged.length = 0;
      const r = await callRoute(seoRouter, "/sok", { q: "tannlege i Bergen" });
      assertEq(r.status, 200, "W1: /sok?q=tannlege+i+Bergen -> 200");
      assertTrue(!r.text.includes("Ingen klinikker funnet") && r.text.includes("Bergen Sentrum Tannlege"), "W2: shows clinic cards (it used to show «0 klinikker funnet»)");
      assertTrue(r.text.includes(`${bergenTotal} klinikker funnet`), "W3: the count line uses the parsed result");
      assertTrue(r.text.includes("Tolket som: sted: Bergen (poststed)"), "W4: «Tolket som …» line");
      assertEq(logged, [{ query: "tannlege i Bergen", resultCount: bergenTotal }], "W5: logWebSearch still gets the raw q");
      assertTrue(r.text.includes('value="tannlege i Bergen"'), "W6: the search box keeps the raw q");
    }
    {
      const r = await callRoute(seoRouter, "/sok", { q: "tannlege", fylke: "Rogaland" });
      assertTrue(r.text.includes("1 klinikker funnet") && r.text.includes("Stavanger Akuttvakt"), "W7: the form's fylke combines with the text");
    }
    {
      const r = await callRoute(seoRouter, "/sok", { q: "Bergen Akutten" });
      assertTrue(r.text.includes("Bergen Akutten Tannklinikk") && r.text.includes("viser treff på hele søketeksten"), "W8: fallback is shown");
    }
    {
      const r = await callRoute(seoRouter, "/sok", { q: "<script>x</script> Bergen" });
      assertTrue(!r.text.includes("<script>x</script>"), "W9: the tolkning line is escaped");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      const r = await callRoute(seoRouter, "/sok", { q: "tannlege i Bergen" });
      assertTrue(r.text.includes("Ingen klinikker funnet") && !r.text.includes("Tolket som"), "W10: switched off -> the old /sok behaviour");
    }
    delete process.env.DENTAL_QUERY_PARSER_DISABLED;

    // ── A: A2A message/send ───────────────────────────────────────────────
    const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
    const { getDentalAgentCard } = require("../services/dental-agent-card") as typeof import("../services/dental-agent-card");
    const examples: string[] = (getDentalAgentCard() as any).skills.find((s: any) => s.id === "tannlege_search").examples;
    for (const ex of examples) {
      const resp = a2a.handleDentalMessageSend({ message: { text: ex } }, "a2a-ex") as any;
      const data = resp.result?.artifacts?.find((a: any) => a.name === "dental-search-results")?.parts?.[0]?.data;
      assertTrue((data?.count ?? 0) > 0, `A1: agent-card example «${ex}» finds clinics via message/send (${data?.count})`);
      assertTrue(a2a.dentalAskedSomething(resp), `A2: «${ex}» counts as a question (metadata.filter is set)`);
      assertTrue(Array.isArray(resp.result?.metadata?.tolkning?.tolket_som), `A3: «${ex}» carries metadata.tolkning`);
    }
    {
      const resp = a2a.handleDentalMessageSend({ message: { text: "tannlege i Bærum" } }, "a2a-b") as any;
      const ids = resp.result.artifacts[1].parts[0].data.clinics.map((c: any) => c.id).sort();
      assertEq(ids, [sandvika, stabekk].sort(), "A4: «tannlege i Bærum» via A2A");
      assertEq(a2a.dentalAnswerProfileIds(resp).sort(), ids, "A5: dentalAnswerProfileIds reads the same clinics");
    }
    {
      const resp = a2a.handleDentalMessageSend({ message: { data: { fylke: "Rogaland" } } }, "a2a-d") as any;
      assertEq(resp.result.metadata.filter, { fylke: "Rogaland" }, "A6: structured message.data is used as before");
      assertTrue(resp.result.metadata.tolkning === undefined, "A7: ... without tolkning");
    }
    assertEq(a2a.parseIntent("finn tannlege i Vestland").fylke, "Vestland", "A8: parseIntent (pr113-03a) still finds Vestland");
    assertEq(a2a.parseIntent("kjeveortopedi Trondheim").specialty, "kjeveortopedi", "A9: parseIntent (pr113-03d) still finds kjeveortopedi");
    assertEq(a2a.parseIntent("tannlege i Tromsø").fylke, undefined, "A10: «Tromsø» no longer becomes fylke Troms");
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      assertEq(a2a.parseIntent("kjeveortoped Bergen"), { q: "kjeveortoped bergen" }, "A11: switched off -> the old keyword parser");
      const resp = a2a.handleDentalMessageSend({ message: { text: "kjeveortoped Bergen" } }, "a2a-off") as any;
      assertTrue(resp.result.metadata.tolkning === undefined, "A12: switched off -> no tolkning");
    }
    delete process.env.DENTAL_QUERY_PARSER_DISABLED;

    // ── G: one listPoststeder(1) per TTL ──────────────────────────────────
    {
      gaz.__resetDentalSearchGazetteerForTesting();
      let calls = 0;
      const lister = (min?: number) => { calls++; return store.listPoststeder(min); };
      const g1 = gaz.getDentalSearchGazetteer(lister);
      const g2 = gaz.getDentalSearchGazetteer(lister);
      gaz.getCachedDentalPoststeder(lister);
      assertEq(calls, 1, "G1: three reads inside the TTL run listPoststeder once");
      assertTrue(g1 === g2, "G2: the gazetteer is built once per cached row set");
      assertEq(g1.poststeder.get("bergen"), ["BERGEN", "Bergen"], "G3: the gazetteer has every stored spelling");
      gaz.getDentalSearchGazetteer((min?: number) => store.listPoststeder(min));
      assertEq(calls, 1, "G4: a different lister (another store copy) rebuilds instead of reusing");
      assertEq(gaz.DENTAL_SEARCH_GAZETTEER_TTL_MS, 60_000, "G5: same 60 s TTL as the stats cache");
      const broken = () => { throw new Error("db not ready"); };
      assertEq(gaz.getCachedDentalPoststeder(broken), [], "G6: a DB error gives [] (the old getCachedPoststeder behaviour)");
    }

    // ── T: /sok timing on 3,000 rows ──────────────────────────────────────
    {
      const ins = db.prepare("INSERT INTO dental_agents (id, navn, poststed, postnummer, fylke, specialists) VALUES (?,?,?,?,?,?)");
      db.transaction(() => {
        for (let i = 0; i < 3000; i++) ins.run(`fill-${i}`, `Fyll Tann ${i}`, i % 2 ? "BERGEN" : "OSLO", "5003", "Vestland", JSON.stringify([{ name: "x", title: "Tannlege" }]));
      })();
      gaz.__resetDentalSearchGazetteerForTesting();
      await callRoute(seoRouter, "/sok", { q: "warm up" });
      let worst = 0;
      for (const q of ["tannlege i Bergen", "kjeveortoped Bergen", "akuttvakt tannlege Stavanger", "Bergen Akutten", "tannlege i Bærum"]) {
        const t = Date.now();
        await callRoute(seoRouter, "/sok", { q });
        worst = Math.max(worst, Date.now() - t);
      }
      if (log) console.log(`    /sok worst: ${worst} ms`);
      // Stable label (no measured numbers): the CI determinism gate compares failure texts across runs.
      assertTrue(worst < 250, "T1: /sok answers in < 250 ms on 3,000 rows");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental natural search: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    (analyticsService as any).logWebSearch = realLogWebSearch;
    if (closeMcp) await closeMcp().catch(() => {});
    try {
      (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch {
      // best-effort cleanup
    }
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevDisabled === undefined) delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    else process.env.DENTAL_QUERY_PARSER_DISABLED = prevDisabled;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalNaturalSearchTests({ log: true }).then((r) => {
    console.log(`\ndental natural search: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
