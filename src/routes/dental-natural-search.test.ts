/**
 * dental-natural-search.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S3).
 *
 * The shared parser wired into the three search surfaces, against an
 * in-memory fixture DB:
 *   M   MCP tannlege_search over a real McpServer + client (tools/call):
 *       natural queries, tolkning, explicit arguments win, fallback flag,
 *       rollback switch, and the server card's natural-language claim;
 *       oversized input (1 MB, a 150-character word) answers fast, no error.
 *   U   never fewer hits: for every query in a list of clinic names, places
 *       and sentences, with and without explicit arguments, the clinics the
 *       old search found are all still found, and listed first: MCP and /sok
 *       (old: the whole text as q) and A2A (old: its keyword parser, the
 *       switch-off path). The store test proves the old fields themselves
 *       match as before. A2A's one exception: an old reading with no filter.
 *   W   /sok: «tannlege i Bergen» shows clinics + «Tolket som», raw q is
 *       still what logWebSearch gets, form fields win, rollback switch.
 *   A   A2A message/send: the four agent-card examples find clinics;
 *       metadata.filter/tolkning; parseIntent still exported (pr113-03);
 *       total (D3c): every clinic found, as MCP counts it, next to count
 *       (the clinics in the answer); parseIntent typed as the store filter;
 *       the keyword parser takes a fylke only as whole words (D3c2,
 *       dev-request 2026-10-17-dental-d3-rettelser): «Tromsø» is no longer
 *       fylke Troms, «Nord-Troms» still is.
 *   G   the gazetteer cache runs listPoststeder(1) once per TTL for all three.
 *   T   /sok answers well under the 1 s stall limit on a 3,000-row fixture.
 *
 * Standalone: npx tsx src/routes/dental-natural-search.test.ts
 * Wired into tests/test.ts via runDentalNaturalSearchTests().
 */

import type { DentalSearchParams } from "./dental-a2a";

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
    // Clinic names that contain place, specialty and trigger words, placed
    // so that the parsed reading and the old whole-text search disagree.
    // F2-S6: a Helfo row gets the source its claim needs (resolveHelfoClaim).
    const HELFO_PROV = JSON.stringify({ helfo_agreement: [{ value: "true", source_type: "homepage", source_url: "https://example.test/helfo", fetched_at: "2026-05-01T10:00:00Z" }] });
    const add = (row: Record<string, unknown>, given: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ telefon: "22000000", ...row } as any);
      const extra = row.helfo_agreement === "true" && given.field_provenance === undefined ? { ...given, field_provenance: HELFO_PROV } : given;
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
    add({ navn: "Bergen Akutten Tannklinikk", poststed: "BERGEN", fylke: "Vestland", postnummer: "5007" });
    add({ navn: "Fana Tannhelse", poststed: "BERGEN", fylke: "Vestland", postnummer: "5008" });
    add({ navn: "Bergen Tannhelse", poststed: "NESTTUN", fylke: "Vestland", postnummer: "5221" });
    add({ navn: "Helfotannlegen Bergen", poststed: "LAKSEVÅG", fylke: "Vestland", postnummer: "5160" });
    add({ navn: "Oslo Helfo Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0150", helfo_agreement: "true" });
    add({ navn: "Majorstua Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0151" });
    add({ navn: "Akuttklinikken Oslo", poststed: "OSLO", fylke: "Oslo", postnummer: "0152" });
    const lysaker = add({ navn: "Oslo Tannlegesenter", poststed: "LYSAKER", fylke: "Akershus", postnummer: "1366" });
    const sandvika = add({ navn: "Sandvika Tann", poststed: "SANDVIKA", fylke: "Akershus", postnummer: "1337" });
    const stabekk = add({ navn: "Stabekk Tann", poststed: "Baerum", fylke: "Akershus", postnummer: "1368" });
    add({ navn: "Lillestrøm Tann", poststed: "LILLESTRØM", fylke: "Akershus", postnummer: "2000" });
    // A sourced emergency duty: since S2b a public akutt search lists only
    // clinics whose card shows the akutt claim (dental-acute-filter.test.ts).
    add({ navn: "Stavanger Akuttvakt", poststed: "STAVANGER", fylke: "Rogaland", postnummer: "4006" },
      { acute_vakt: 1, field_provenance: JSON.stringify({ acute_vakt: [{ source_type: "homepage", value: 1 }] }) });
    add({ navn: "Trondheim Regulering", poststed: "TRONDHEIM", fylke: "Trøndelag", postnummer: "7010" }, kjeveTitle("Kjeveortoped"));
    const tromsoNamed = add({ navn: "Tannregulering Tromsø", poststed: "TROMSØ", fylke: "Troms", postnummer: "9008" });
    const tromsoKjeve = add({ navn: "Tromsø Kjeveortopedi", poststed: "TROMSØ", fylke: "Troms", postnummer: "9010", available_specialties: ["kjeveortopedi"] });
    const harstad = add({ navn: "Harstad Tann", poststed: "HARSTAD", fylke: "Troms", postnummer: "9405" });
    add({ navn: "Bodø Tannregulering", poststed: "BODØ", fylke: "Nordland", postnummer: "8006" });
    const aas = add({ navn: "Ås Tannhelse", poststed: "ÅS", fylke: "Akershus", postnummer: "1430" });
    const total = 23;
    const bergenPoststed = 7;
    // S3b: «Bergen» is also a kommune, so the place reads as poststed Bergen
    // OR Bergen kommune's postnumre: + Bergen Tannhelse (Nesttun) and
    // Helfotannlegen Bergen (Laksevåg).
    const bergenKommune = bergenPoststed + 2;

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
    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "tannlege_search", arguments: args })) as any;
    const search = async (args: Record<string, unknown>) => JSON.parse((await call(args)).content[0].text);
    const names = (r: any): string[] => r.klinikker.map((k: any) => k.navn);
    const oldNames = (q: string) => store.listPublicDentalAgents({ q } as any, 500, 0).map((a) => a.navn);

    {
      const r = await search({ query: "tannlege i Bergen" });
      assertEq(r.count, bergenKommune, "M1: «tannlege i Bergen» finds every clinic with poststed Bergen (both stored spellings) or in Bergen kommune (it used to find 0)");
      assertEq(r.tolkning?.tolket_som, ["sted: Bergen (poststed + kommune)"], "M2: tolkning says what was used");
      assertEq(r.tolkning?.fallback, false, "M3: no fallback");
      const bergen = await search({ query: "Bergen", limit: 25 });
      assertEq([bergen.count, names(bergen).sort()], [oldNames("Bergen").length, oldNames("Bergen").sort()], "M4: «Bergen» alone keeps every old whole-text hit (Bergen Tannhelse in Nesttun, Helfotannlegen Bergen in Laksevåg)");
    }
    assertEq((await search({ query: "kjeveortoped Bergen" })).count, 3, "M5: «kjeveortoped Bergen» -> the 3 orthodontists (title stem, title, structured)");
    assertTrue((await search({ query: "dentist in Oslo" })).count > 0, "M6: «dentist in Oslo» > 0");
    assertEq((await search({ fylke: "vestland" })).count, (await search({ fylke: "Vestland" })).count, "M7: fylke «vestland» == «Vestland»");
    {
      const r = await search({ query: "tannlege i Bærum" });
      assertEq(names(r).sort(), ["Oslo Tannlegesenter", "Sandvika Tann", "Stabekk Tann"], "M8: «tannlege i Bærum» finds Bærum's clinics by postnummer (not Lillestrøm, elsewhere in Akershus)");
      assertTrue(JSON.stringify(r.tolkning).includes("Bærum"), "M9: tolkning mentions Bærum");
    }
    assertEq((await search({ query: "helfo tannlege Oslo", helfo: false })).count, 3, "M10: helfo:false overrides «helfo» in the text");
    {
      const r = await search({ query: "Hordaland", fylke: "Rogaland" });
      assertEq(names(r), ["Stavanger Akuttvakt"], "M11: an explicit fylke wins over the parsed one");
      assertTrue(r.tolkning.tolket_som.some((t: string) => t.includes("ligger ikke i Rogaland")), "M11b: ... and tolkning says the place in the text was not used");
    }
    assertEq((await search({ query: "Bergen", spesialitet: "kjeveortopedi" })).count, 3, "M12: explicit spesialitet combines with the parsed place");
    assertEq((await search({ spesialitet: "oral-kirurgi-og-oral-medisin" })).count, 0, "M13: a slug is read as the stored name (no rows here, no error)");
    {
      const r = await search({ query: "Bergen Tannhelse" });
      assertEq(names(r), ["Bergen Tannhelse", "Fana Tannhelse"], "M14: «Bergen Tannhelse»: the clinic of that name first, then the parsed match");
      assertEq(r.tolkning?.fallback, false, "M15: tolkning.fallback is false (the parsed reading found Fana Tannhelse)");
    }
    {
      const r = await search({ query: "Bodø Tannregulering" });
      assertEq([names(r), r.tolkning?.fallback], [["Bodø Tannregulering"], true], "M15b: no orthodontist in Bodø -> the old whole-text hit, tolkning.fallback true");
    }
    {
      const r = await search({ query: "tannlege" });
      assertEq(r.count, total, "M16: «tannlege» alone lists every clinic");
      assertEq(r.tolkning?.tolket_som, ["merknad: fant ikke sted, spesialitet eller navneord i teksten"], "M17: ... and tolkning says nothing was read");
    }
    {
      const r = await search({ limit: 5 });
      assertTrue(r.count === total && r.tolkning === undefined, "M18: no query -> no tolkning key (response unchanged)");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      const r = await search({ query: "tannlege i Bergen" });
      assertTrue(r.count === 0 && r.tolkning === undefined, "M19: DENTAL_QUERY_PARSER_DISABLED=1 -> the old whole-text search (0) and no tolkning");
      assertEq((await search({ query: "Bergen" })).count, 9, "M20: switched off, «Bergen» still matches as before");
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
    {
      const kjeve = (await search({ spesialitet: "kjeveortopedi" })).count;
      assertEq([(await search({ spesialitet: "kjeveortoped" })).count, (await search({ spesialitet: "orthodontist" })).count], [kjeve, kjeve], "M24: an explicit spesialitet synonym (kjeveortoped, orthodontist) is read as the stored name");
    }
    {
      const r = await search({ query: "tannlege i Bergen", fylke: "Rogaland" });
      assertEq(names(r), ["Stavanger Akuttvakt"], "M25: «tannlege i Bergen» + fylke Rogaland searches Rogaland (Bergen is not there), not 0");
    }
    assertEq(names(await search({ query: "tannlege i Viken" })).sort(), ["Lillestrøm Tann", "Oslo Tannlegesenter", "Sandvika Tann", "Stabekk Tann", "Ås Tannhelse"], "M26: «Viken» -> the fylker it covered");
    {
      const t = Date.now();
      const r = await call({ query: "tannlege i Bergen " + "x".repeat(1024 * 1024) });
      const ms = Date.now() - t;
      // Slice I-Y (utils/free-text.ts): the handler cuts the text to 2000
      // characters at a word boundary, so the 1 MB word is dropped whole and
      // the search is «tannlege i Bergen» (main read a 256-character piece of
      // it as a name and found 0).
      assertTrue(!r.isError && JSON.parse(r.content[0].text).count === bergenKommune,
        "M27: a 1 MB query answers without an error, as the words before the cap («tannlege i Bergen»)");
      assertTrue(ms < 1000, "M28: ... in well under a second");
      const long = await call({ query: "tannlege i Bergen " + "x".repeat(150) });
      assertTrue(!long.isError && !String(long.content[0].text).includes("Søkefeil"), "M29: a word over 100 characters is no Zod error");
    }

    // ── U: never fewer hits than the old search ──────────────────────────
    const queries = [
      "Bergen", "Oslo", "Bergen Tannhelse", "Akuttklinikken Oslo", "Helfotannlegen Bergen", "Tannregulering Tromsø",
      "Bergen Akutten", "tannlege i Bergen", "kjeveortoped Bergen", "Fana", "Sandvika Tann", "Stabekk", "Bodø Tannregulering",
      "Majorstua", "Tann", "dentist in Oslo", "Oslo Tannlegesenter", "Lillestrøm", "Trondheim Regulering",
      "Stavanger Akuttvakt", "Oslo Helfo Tann", "tannlege Time", "50%", "regulering", "x".repeat(300),
      "tannlege i Tromsø", "kjeveortopedi i Oslo", "oral kirurgi Bergen", "akutt tannlege Vestland", "helfo Oslo", "Rogaland", "Ås",
    ];
    const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
    const label = (q: string) => (q.length > 40 ? `${q.slice(0, 12)}… (${q.length} chars)` : q);
    // Every old hit is found, and the old hits come first.
    const keeps = (before: string[], after: string[]) =>
      before.every((n) => after.includes(n)) && after.slice(0, before.length).sort().join("|") === [...before].sort().join("|");
    // MCP arguments and the store filter the old handler built from them.
    const argSets: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{}, {}], [{ fylke: "Vestland" }, { fylke: "Vestland" }], [{ fylke: "akershus" }, { fylke: "akershus" }],
      [{ spesialitet: "kjeveortoped" }, { specialty: "kjeveortoped" }], [{ helfo: true }, { helfo_agreement: "true" }],
      [{ akutt: true }, { acute_vakt: 1 }], [{ helfo: false }, {}],
    ];
    for (const q of queries) {
      for (const [args, old] of argSets) {
        const before = store.listPublicDentalAgents({ ...old, q: q.slice(0, 256) } as any, 500, 0).map((a) => a.navn);
        const after = names(await search({ ...args, query: q, limit: 25 }));
        assertTrue(keeps(before, after), `U1: MCP «${label(q)}» ${JSON.stringify(args)}: every old hit is still found, first`);
      }
      const before = oldNames(q.slice(0, 256));
      const page = await callRoute(seoRouter, "/sok", { q });
      const pos = (n: string) => page.text.indexOf(`>${n}<`);
      const shown = names(await search({ query: q, limit: 25 })).filter((n) => pos(n) >= 0).sort((a, b) => pos(a) - pos(b));
      assertTrue(keeps(before, shown), `U2: /sok «${label(q)}»: every old hit is shown, before the new ones`);
    }
    {
      const page = await callRoute(seoRouter, "/sok", { q: "Bergen", fylke: "Vestland", helfo: "1" });
      const old = store.listPublicDentalAgents({ q: "Bergen", fylke: "Vestland", helfo_agreement: "true" } as any, 500, 0).map((a) => a.navn);
      assertTrue(old.length > 0 && old.every((n) => page.text.includes(`>${n}<`)), "U3: /sok with form fields keeps every old hit");
    }
    {
      // A2A: the old keyword parser (the switch-off path) is the baseline.
      const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
      const ask = (text: string) => {
        const resp = a2a.handleDentalMessageSend({ message: { text } }, "u") as any;
        return { ids: (resp.result.artifacts[1].parts[0].data.clinics as any[]).map((c) => c.id) as string[], metadata: resp.result.metadata };
      };
      const old = (text: string) => {
        process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
        try { return ask(text); } finally { delete process.env.DENTAL_QUERY_PARSER_DISABLED; }
      };
      for (const q of queries) {
        const before = old(q);
        // An old reading with no filter listed the first clinics; that is no answer (see U7).
        if (Object.keys(before.metadata.filter).length === 0) continue;
        assertTrue(keeps(before.ids, ask(q).ids), `U4: A2A «${label(q)}»: every old hit is still found, first`);
      }
      // D3c2: the old A2A parser read «Tromsø» as fylke Troms («troms» is a
      // substring of «tromsø»). It now takes a fylke only when its words stand
      // whole in the text, so «Tromsø» is its q, and the whole of Troms
      // (Harstad here) is no longer added to a Tromsø answer.
      assertEq(old("tannlege i Tromsø").metadata.filter, { q: "tromsø" }, "U5: the old A2A parser reads «Tromsø» as q «tromsø», no longer as fylke Troms (D3c2: a fylke only as whole words)");
      {
        const now = ask("tannlege i Tromsø");
        assertEq([...now.ids].sort(), [tromsoNamed, tromsoKjeve].sort(), "U6: A2A «tannlege i Tromsø» finds Tromsø's clinics and not Harstad, elsewhere in Troms (D3c2: the old reading no longer adds the whole fylke)");
        assertEq(now.metadata.tolkning.tolket_som, ["sted: Tromsø (poststed + kommune)"], "U6b: ... and tolkning says the text reads as Tromsø");
      }
      assertEq([old("tannlege i Ås").metadata.filter, old("tannlege i Ås").ids.length], [{}, 20], "U7: the old A2A parser had no filter for «tannlege i Ås» (two-letter words dropped): the first 20 clinics");
      assertEq([ask("tannlege i Ås").ids, ask("tannlege i Ås").metadata.filter.poststed_or_postnummer?.poststed_in], [[aas], ["ÅS"]], "U7b: now the parsed place (poststed Ås or Ås kommune) replaces that non-answer");
    }

    // ── W: /sok ───────────────────────────────────────────────────────────
    {
      logged.length = 0;
      const r = await callRoute(seoRouter, "/sok", { q: "tannlege i Bergen" });
      assertEq(r.status, 200, "W1: /sok?q=tannlege+i+Bergen -> 200");
      assertTrue(!r.text.includes("Ingen klinikker funnet") && r.text.includes("Bergen Sentrum Tannlege"), "W2: shows clinic cards (it used to show «0 klinikker funnet»)");
      assertTrue(r.text.includes(`${bergenKommune} klinikker funnet`), "W3: the count line uses the parsed result");
      assertTrue(r.text.includes("Tolket som: sted: Bergen (poststed + kommune)"), "W4: «Tolket som …» line");
      assertEq(logged, [{ query: "tannlege i Bergen", resultCount: bergenKommune }], "W5: logWebSearch still gets the raw q");
      assertTrue(r.text.includes('value="tannlege i Bergen"'), "W6: the search box keeps the raw q");
    }
    {
      const r = await callRoute(seoRouter, "/sok", { q: "tannlege", fylke: "Rogaland" });
      assertTrue(r.text.includes("1 klinikker funnet") && r.text.includes("Stavanger Akuttvakt"), "W7: the form's fylke combines with the text");
    }
    {
      const r = await callRoute(seoRouter, "/sok", { q: "Bodø Tannregulering" });
      assertTrue(r.text.includes("Bodø Tannregulering") && r.text.includes("viser treff på hele søketeksten"), "W8: fallback is shown");
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
    {
      const t = Date.now();
      const r = await callRoute(seoRouter, "/sok", { q: "tannlege i Bergen " + "x".repeat(1024 * 1024) });
      assertTrue(r.status === 200 && Date.now() - t < 1000, "W11: /sok with a 1 MB q answers 200 in well under a second");
    }

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
      assertEq(ids, [lysaker, sandvika, stabekk].sort(), "A4: «tannlege i Bærum» via A2A");
      assertEq(a2a.dentalAnswerProfileIds(resp).sort(), ids, "A5: dentalAnswerProfileIds reads the same clinics");
    }
    {
      const resp = a2a.handleDentalMessageSend({ message: { data: { fylke: "Rogaland" } } }, "a2a-d") as any;
      assertEq(resp.result.metadata.filter, { fylke: "Rogaland" }, "A6: structured message.data is used as before");
      assertTrue(resp.result.metadata.tolkning === undefined, "A7: ... without tolkning");
    }
    for (const text of ["tannlege", "hi"]) {
      const resp = a2a.handleDentalMessageSend({ message: { text } }, "a2a-n") as any;
      assertTrue(
        JSON.stringify(resp.result.metadata.filter) === "{}" && !a2a.dentalAskedSomething(resp) && resp.result.artifacts[1].parts[0].data.count === 20,
        `A7b: «${text}» via A2A lists the first clinics with filter {} and is not counted as a question (as before)`
      );
    }
    assertEq(a2a.parseIntent("finn tannlege i Vestland").fylke, "Vestland", "A8: parseIntent (pr113-03a) still finds Vestland");
    assertEq(a2a.parseIntent("kjeveortopedi Trondheim").specialty, "kjeveortopedi", "A9: parseIntent (pr113-03d) still finds kjeveortopedi");
    assertEq(a2a.parseIntent("tannlege i Tromsø").fylke, undefined, "A10: «Tromsø» no longer becomes fylke Troms");
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      assertEq(a2a.parseIntent("kjeveortoped Bergen"), { q: "kjeveortoped bergen" }, "A10b: switched off -> the old keyword parser");
      const resp = a2a.handleDentalMessageSend({ message: { text: "kjeveortoped Bergen" } }, "a2a-off") as any;
      assertTrue(resp.result.metadata.tolkning === undefined, "A10c: switched off -> no tolkning");
    }
    delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    {
      // D3c: count is the clinics in the answer (at most 20), total every
      // clinic that matches; the text names the total when it is the larger.
      const answer = (message: Record<string, unknown>) => {
        const resp = a2a.handleDentalMessageSend({ message }, "a2a-total") as any;
        const data = resp.result.artifacts[1].parts[0].data;
        return { resp, count: data.count, total: data.total, clinics: data.clinics.length, text: resp.result.artifacts[0].parts[0].text };
      };
      const all = answer({ text: "tannlege" });
      assertEq(
        [all.count, all.total, all.clinics, all.text],
        [20, total, 20, `Fant ${total} tannlegeklinikk(er), viser de 20 første. / Found ${total} dental clinic(s), showing the first 20.`],
        `A11: filter {} -> count 20, total ${total} and «Fant ${total} …, viser de 20 første»`
      );
      const bergen = answer({ text: "tannlege i Bergen" });
      assertEq(
        [bergen.count, bergen.total, bergen.text],
        [bergenKommune, bergenKommune, `Fant ${bergenKommune} tannlegeklinikk(er). / Found ${bergenKommune} dental clinic(s).`],
        "A12: all found on one page (Bergen) -> count = total and the old text"
      );
      const structured = answer({ data: {} });
      assertEq([structured.count, structured.total, structured.text], [all.count, all.total, all.text], "A13: structured message.data {} counts its total too");
      const vestland = answer({ data: { fylke: "Vestland" } });
      assertEq([vestland.count, vestland.total], [bergenKommune, (await search({ fylke: "Vestland" })).count], "A13b: structured message.data {fylke} -> total = MCP tannlege_search count for the same fylke");
      for (const ex of examples) {
        assertEq(answer({ text: ex }).total, (await search({ query: ex })).count, `A14: agent-card example «${ex}»: A2A total = MCP tannlege_search count`);
      }
      const none = answer({ text: "tannlege i Hamar" });
      const { a2aResultHasData } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
      assertEq(
        [none.count, none.total, none.text, a2aResultHasData(none.resp)],
        [0, 0, "Ingen tannlegeklinikker funnet med de angitte filtrene. / No dental clinics found matching the given filters.", false],
        "A15: no hits -> count 0, total 0, the old text, and the answer has no data (a2aResultHasData false)"
      );
    }
    {
      // DentalSearchParams is the store's ListFilter: the fields the parser
      // sets are read here without a cast.
      const bergen: DentalSearchParams["poststed_or_postnummer"] = a2a.parseIntent("tannlege i Bergen").poststed_or_postnummer;
      const viken: DentalSearchParams["fylke_in"] = a2a.parseIntent("tannlege i Viken").fylke_in;
      const tromso: DentalSearchParams = a2a.parseIntent("tannlege i Tromsø");
      assertEq([bergen?.poststed_in, bergen?.postnummer_in.length], [["BERGEN", "Bergen"], 144], "A16: parseIntent «Bergen» has poststed_or_postnummer (both spellings, Bergen kommune's 144 postnumre)");
      assertEq(viken, ["Viken", "Akershus", "Buskerud", "Østfold"], "A16b: parseIntent «Viken» has fylke_in");
      assertTrue(tromso.fylke_in === undefined && tromso.fylke === undefined && tromso.poststed_or_postnummer !== undefined, "A16c: parseIntent «Tromsø» has no fylke_in (nor fylke), but the poststed + kommune");
      process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
      try {
        const off = ["tannlege i Bergen", "tannlege i Viken"].map((t) => a2a.parseIntent(t));
        assertTrue(off.every((f) => f.poststed_or_postnummer === undefined && f.fylke_in === undefined), "A16d: switched off -> neither field (the old keyword parser)");
      } finally {
        delete process.env.DENTAL_QUERY_PARSER_DISABLED;
      }
    }
    {
      // D3c2: the keyword parser (the rollback path, and the old reading A2A
      // keeps next to the parsed one) takes a fylke only when its words stand
      // whole in the text. «troms» inside «Tromsø», «Tromso» or «Tromsdalen»
      // made all of Troms an answer to a Tromsø question; those words are now
      // the q they are. (A \b regex would still match: JS's \b doesn't count
      // ø as a word character; a word-prefix match would still take «Tromsdalen».)
      process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
      try {
        for (const [text, q] of [["tannlege i Tromsø", "tromsø"], ["tannlege i Tromso", "tromso"], ["tannlege i Tromsdalen", "tromsdalen"]]) {
          assertEq(a2a.parseIntent(text), { q }, `A17: switched off, «${text}» has no fylke (Troms) but q «${q}»`);
        }
        const kept: Array<[text: string, fylke: string]> = [
          ["Troms", "Troms"], ["Troms og Finnmark", "Troms"], ["Nord-Troms", "Troms"], ["Vest-Agder tannlege", "Agder"],
          ["kjeveortoped møre og romsdal", "Møre og romsdal"], ["finn tannlege i Vestland", "Vestland"], ["tannlege i Oslo.", "Oslo"],
        ];
        for (const [text, fylke] of kept) {
          assertEq(a2a.parseIntent(text).fylke, fylke, `A17b: switched off, «${text}» still reads fylke ${fylke} (its words stand whole, hyphen and full stop split)`);
        }
        // The accepted cost (dev-request risk): a fylke name inside a longer
        // word is no fylke for the old reading; the word goes to q instead.
        for (const [text, q] of [["tannlege Vestlands", "vestlands"], ["Rogalandsklinikken", "rogalandsklinikken"]]) {
          assertEq(a2a.parseIntent(text), { q }, `A17c: switched off, «${text}» (genitive / compound) is q «${q}», not a fylke`);
        }
      } finally {
        delete process.env.DENTAL_QUERY_PARSER_DISABLED;
      }
    }
    {
      // D3c2: a TROMSDALEN clinic (9020, in Tromsø kommune). Before, A2A read
      // «Tromsdalen» as fylke Troms and answered with Harstad and the Tromsø
      // clinics too; now its old reading is q «tromsdalen», as MCP finds it.
      const tromsdalen = add({ navn: "Tromsdalen Tannklinikk", poststed: "TROMSDALEN", fylke: "Troms", postnummer: "9020" });
      gaz.__resetDentalSearchGazetteerForTesting();
      const answer = (text: string) => {
        const resp = a2a.handleDentalMessageSend({ message: { text } }, "a2a-d3c2") as any;
        const data = resp.result.artifacts[1].parts[0].data;
        return { ids: (data.clinics as any[]).map((c) => c.id).sort() as string[], total: data.total, metadata: resp.result.metadata };
      };
      const dalen = answer("tannlege i Tromsdalen");
      assertEq(
        [dalen.ids, dalen.metadata.filter.natural?.legacy],
        [[tromsdalen], { q: "tromsdalen" }],
        "A18: A2A «tannlege i Tromsdalen» -> only the Tromsdalen clinic (not Harstad or Tromsø); its old reading is q «tromsdalen»"
      );
      assertEq(dalen.total, (await search({ query: "tannlege i Tromsdalen" })).count, "A18b: ... total = MCP tannlege_search count for the same text");
      const tromso = [tromsoNamed, tromsoKjeve, tromsdalen].sort();
      for (const [text, q, shown] of [["tannlege i Tromsø", "tromsø", "Tromsø"], ["tannlege i Tromso", "tromso", "Tromso"]]) {
        const r = answer(text);
        assertEq(
          [r.ids, r.metadata.filter.natural?.legacy, r.metadata.tolkning?.tolket_som],
          [tromso, { q }, [`sted: ${shown} (poststed + kommune)`]],
          `A18c: A2A «${text}» -> Tromsø kommune (Tromsdalen too), not Harstad; old reading q «${q}»; tolket_som as before`
        );
      }
      const troms = answer("tannlege i Troms");
      assertEq(
        [troms.metadata.filter.natural?.legacy, troms.metadata.filter.natural?.parsed?.fylke],
        [{ fylke: "Troms" }, "Troms"],
        "A18d: negative: «tannlege i Troms» still reads fylke Troms, in the old reading and the parsed one"
      );
      assertEq(troms.ids, [...tromso, harstad].sort(), "A18e: ... and finds every clinic in Troms, Harstad too");
    }

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
      assertEq(gaz.DENTAL_STATS_TTL_MS, 60_000, "G5: the 60 s TTL ...");
      const seoSource = require("fs").readFileSync(require.resolve("./dental-seo").replace(/\.js$/, ".ts"), "utf-8") as string;
      assertTrue(!/const DENTAL_STATS_TTL_MS\s*=/.test(seoSource) && /import \{[^}]*DENTAL_STATS_TTL_MS[^}]*\} from "\.\.\/services\/dental-search-gazetteer"/.test(seoSource), "G5b: ... is the one constant the stats cache in dental-seo.ts also imports");
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
      for (const q of ["tannlege i Bergen", "kjeveortoped Bergen", "akuttvakt tannlege Stavanger", "Bergen Tannhelse", "tannlege i Bærum", "tannlege"]) {
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const t = Date.now();
          await callRoute(seoRouter, "/sok", { q });
          best = Math.min(best, Date.now() - t);
        }
        worst = Math.max(worst, best);
      }
      if (log) console.log(`    /sok worst (best of 3): ${worst} ms`);
      // Stable label (no measured numbers): the CI determinism gate compares failure texts across runs.
      // Half the 1 s stall limit from the dev-request, so a loaded CI runner has room.
      assertTrue(worst < 500, "T1: /sok answers in < 500 ms on 3,000 rows (best of 3)");
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
