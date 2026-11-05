/**
 * dental-search-kommune-union.test.ts — dev-request
 * 2026-10-16-tannlege-sok-naturlig-sprak, slice S3b.
 *
 * A poststed that lies in the kommune of the same name («Bergen», «Tromsø»)
 * now covers the whole kommune: the poststed's stored spellings OR the
 * kommune's postnumre (store field poststed_or_postnummer). Live 2026-10-17
 * «tannlege i Bergen» missed Nesttun and Fyllingsdalen.
 *   P   parser: the union, «Bergen kommune»; unchanged: a poststed that is
 *       not a kommune (Nesttun), Oslo (over the postnummer cap), a name
 *       several kommuner share (Herøy), a poststed in another kommune with a
 *       kommune's name (KVAM in Nord-Fron) unless the text says kommune
 *       (D3c: «Kvam kommune» is KVAM OR Kvam kommune); an explicit fylke
 *       keeps or drops the place as before; over the whole register every
 *       kommune-named poststed, with and without «kommune», gives a filter
 *       the store accepts.
 *   Z   store: OR between the two halves, AND with every other field, inside
 *       the natural branches, count/list parity, schema bounds.
 *   M   MCP tannlege_search (tools/call on a real McpServer): Nesttun,
 *       Fyllingsdalen, a postbox postnummer and a row without postnummer all
 *       count as Bergen; never fewer hits than the poststed-only reading.
 *       D3c: tolkning shows the kommune's postnumre as {kommunenummer,
 *       antall} (under 300 B), with the same count and clinics.
 *   W   /sok, and A   A2A message/send, for the same query; A2A keeps the
 *       full list in metadata.filter.
 *   R   DENTAL_QUERY_PARSER_DISABLED=1 still restores the old search.
 *
 * Standalone: npx tsx src/routes/dental-search-kommune-union.test.ts
 * Wired into tests/test.ts via runDentalSearchKommuneUnionTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, path: string, query: Record<string, string> = {}): Promise<{ status: number; text: string }> {
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
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? "") }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload) }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled") }));
  });
}

// The filter as S3 read it: the poststed half alone (for "never fewer").
// tolkning shows a kommune's postnumre as {kommunenummer, antall} (D3c), so
// a kommune read by postnummer («Askøy») gets its list back for the store.
function poststedOnly(f: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...f };
  if (out.poststed_or_postnummer) {
    out.poststed_in = out.poststed_or_postnummer.poststed_in;
    delete out.poststed_or_postnummer;
  }
  if (out.postnummer_in && !Array.isArray(out.postnummer_in)) {
    const pn = require("../services/norway-postnummer") as typeof import("../services/norway-postnummer");
    out.postnummer_in = pn.postnumreForKommune(out.postnummer_in.kommunenummer);
  }
  if (out.natural) out.natural = { parsed: poststedOnly(out.natural.parsed), legacy: out.natural.legacy };
  return out;
}

export async function runDentalSearchKommuneUnionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  (analyticsService as any).logWebSearch = () => {};
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const nq = require("../services/search-intent/norwegian-query") as typeof import("../services/search-intent/norwegian-query");
    const parser = require("../services/dental-query-parser") as typeof import("../services/dental-query-parser");
    const pn = require("../services/norway-postnummer") as typeof import("../services/norway-postnummer");
    const bergenPnr = pn.postnumreForKommune("4601");

    // ── P: parser ─────────────────────────────────────────────────────────
    const g = nq.buildNorwegianGazetteer([
      "OSLO", "BERGEN", "Bergen", "NESTTUN", "FYLLINGSDALEN", "KVAM", "HERØY", "TROMSØ", "STAVANGER", "KRISTIANSAND S", "Kristiansand",
    ]);
    const parse = (q: string, withinFylke?: string) => parser.parseDentalQuery(q, g, { withinFylke });
    const union = (poststed_in: string[], kommunenummer: string) =>
      ({ poststed_or_postnummer: { poststed_in, postnummer_in: pn.postnumreForKommune(kommunenummer) } });
    {
      const r = parse("tannlege i Bergen");
      assertEq(r.filter, union(["BERGEN", "Bergen"], "4601"), "P1: «tannlege i Bergen» -> poststed Bergen (both spellings) OR Bergen kommune's postnumre");
      assertTrue(["5221", "5147", "5160"].every((p) => bergenPnr.includes(p)), "P2: ... which include Nesttun (5221), Fyllingsdalen (5147) and Laksevåg (5160)");
      assertTrue(!bergenPnr.includes("5300"), "P3: ... and not Kleppestø (Askøy kommune)");
      assertEq(r.interpretation, ["sted: Bergen (poststed + kommune)"], "P4: tolkning says «sted: Bergen (poststed + kommune)»");
    }
    for (const q of ["tannlege i Bergen kommune", "Bergen kommunen", "dentist in Bergen municipality"]) {
      assertEq(parse(q), parse("tannlege i Bergen"), `P5: «${q}» reads as Bergen kommune (the same union)`);
    }
    assertEq(parse("Nesttun"), { filter: { poststed_in: ["NESTTUN"] }, interpretation: ["sted: Nesttun (poststed)"], residual_terms: [] }, "P6: a poststed that is not a kommune (Nesttun) is read as before");
    {
      assertTrue(pn.postnumreForKommune("0301").length > parser.MAX_POSTNUMMER_IN, "P7: (Oslo kommune has more postnumre than the store takes)");
      assertEq([parse("tannlege i Oslo").filter, parse("Oslo kommune").filter], [{ poststed_in: ["OSLO"] }, { poststed_in: ["OSLO"] }], "P8: Oslo is read as the poststed, as before");
      assertEq(parse("tannlege i Oslo").interpretation, ["sted: Oslo (poststed)"], "P9: ... with the same tolkning");
    }
    assertEq(parse("Herøy").filter, { poststed_in: ["HERØY"] }, "P10: Herøy (two kommuner share the name) -> the poststed alone");
    assertEq(
      [nq.kommunerForPoststed("Bergen"), nq.kommunerForPoststed("BERGEN"), nq.kommunerForPoststed("KVAM"), [...nq.kommunerForPoststed("Molde")].sort(), nq.kommunerForPoststed("Baerum")],
      [["4601"], ["4601"], ["3436"], ["1506", "1547"], []],
      "P10b: kommunerForPoststed reads any stored spelling (every kommune a poststed reaches; [] for a non-poststed)"
    );
    assertTrue(pn.officialPoststedKommuner() === pn.officialPoststedKommuner(), "P10c: officialPoststedKommuner is computed once");
    {
      // The poststed KVAM lies in Nord-Fron (Innlandet); Kvam kommune is in
      // Vestland. Reading it as both would give fewer hits than before with
      // fylke Vestland (the place used to be dropped there), so it stays.
      const r = parse("tannlege Kvam");
      assertEq([r.filter, r.interpretation], [{ poststed_in: ["KVAM"] }, ["sted: Kvam (poststed)"]], "P11: a poststed in another kommune than the one of its name (KVAM) is read as before");
      // D3c: a kommune word after it names Kvam kommune (Vestland, 4622):
      // the poststed KVAM OR the kommune's postnumre (NORHEIMSUND, ØYSTESE …).
      for (const q of ["tannlege i Kvam kommune", "Kvam kommunen", "dentist in Kvam municipality"]) {
        const k = parse(q);
        assertEq([k.filter, k.interpretation], [union(["KVAM"], "4622"), ["sted: Kvam (poststed + kommune)"]], `P12: «${q}» -> the poststed KVAM OR Kvam kommune's postnumre (4622)`);
      }
      assertEq([parse("tannlege i Kvam").filter, parse("Kvam tannlege").filter], [r.filter, r.filter], "P12b: without a kommune word right after it, the poststed alone, as before");
      assertEq(parse("tannlege Kvam", "Vestland").filter, {}, "P13: ... and an explicit fylke Vestland still drops it, as before");
      assertEq(parse("tannlege Kvam kommune", "Vestland").filter, {}, "P13b: «Kvam kommune» + fylke Vestland is dropped too: the union keeps the poststed's fylker (Innlandet), so the result is as before");
      assertEq(parse("tannlege Kvam", "Innlandet").filter, r.filter, "P14: ... while Innlandet keeps it");
      assertEq(parse("tannlege Kvam kommune", "Innlandet").filter, union(["KVAM"], "4622"), "P14b: ... and keeps «Kvam kommune» as the union");
      assertEq(parse("tannlege i Bergen", "Vestland").filter, union(["BERGEN", "Bergen"], "4601"), "P15: the union is kept by the fylke the poststed lies in");
    }
    assertEq(parse("tannlege i Bergen", "Rogaland").filter, {}, "P16: Bergen + explicit fylke Rogaland -> the place in the text is not used (as before)");
    assertEq(parse("emergency dentist Tromso").filter, { acute_vakt: 1, ...union(["TROMSØ"], "5501") }, "P17: the ASCII spelling «Tromso» -> Tromsø's union");
    assertEq(parse("tannlege Kristiansand").filter, { postnummer_in: pn.postnumreForKommune("4204") }, "P18: a kommune that is not a poststed (Kristiansand) is read as before");
    assertEq(parse("Kristiansand S").filter, { poststed_in: ["KRISTIANSAND S"] }, "P19: a poststed whose name is no kommune (Kristiansand S) likewise");
    {
      const r = parse("kjeveortoped Bergen eller Stavanger");
      assertEq(r.filter, { specialty: "kjeveortopedi", ...union(["BERGEN", "Bergen"], "4601") }, "P20: the first place applies, with the specialty");
      assertTrue(r.interpretation.includes("merknad: flere steder nevnt; «Stavanger» brukes ikke"), "P21: ... the second is noted as before");
    }
    {
      // Every official poststed that is also a kommune name, read against the
      // full register: the filter is one the store accepts.
      const store = require("../services/dental-store") as typeof import("../services/dental-store");
      const official = [...pn.officialPoststedFylker().keys()];
      const full = nq.buildNorwegianGazetteer(official);
      const kommuneNamed = official.filter((p) => full.kommuner.has(nq.placeKey(p)));
      const filters = kommuneNamed.map((p) => parser.parseDentalQuery(p, full).filter as Record<string, any>);
      const invalid = kommuneNamed.filter((_, i) => !store.ListFilterSchema.safeParse(filters[i]).success);
      assertEq(invalid, [], `P22: all ${kommuneNamed.length} kommune-named poststeder give a filter the store accepts`);
      const single = kommuneNamed.filter((_, i) => !filters[i].poststed_or_postnummer);
      assertEq(
        single.sort(),
        ["HEMNES", "HERØY", "KVAM", "LUND", "OS", "OSEN", "OSLO", "SULA", "ÅMOT"],
        "P23: all but Herøy (two kommuner), Oslo (over the cap) and seven poststeder in another kommune than their name's cover their kommune"
      );
      // D3c: followed by «kommune», the seven in another kommune cover their
      // name's kommune too; Herøy and Oslo stay the poststed alone.
      const named = kommuneNamed.map((p) => parser.parseDentalQuery(`${p} kommune`, full).filter as Record<string, any>);
      assertEq(kommuneNamed.filter((_, i) => !store.ListFilterSchema.safeParse(named[i]).success), [], `P22b: all ${kommuneNamed.length} kommune-named poststeder followed by «kommune» give a filter the store accepts`);
      assertEq(kommuneNamed.filter((_, i) => !named[i].poststed_or_postnummer).sort(), ["HERØY", "OSLO"], "P23b: followed by «kommune», all but Herøy (two kommuner) and Oslo (over the cap) cover their kommune");
      // The union's fylker are the poststed's own: a fylke it does not lie
      // in still drops the place, as before.
      const outside = kommuneNamed.filter((p, i) => {
        if (!filters[i].poststed_or_postnummer) return false;
        const other = nq.fylkerForPoststed(p).includes("Finnmark") ? "Agder" : "Finnmark";
        return Object.keys(parser.parseDentalQuery(p, full, { withinFylke: other }).filter).length > 0;
      });
      assertEq(outside, [], "P24: an explicit fylke the poststed does not lie in drops every union place, as before");
    }

    // ── fixture DB ────────────────────────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const gaz = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    gaz.__resetDentalSearchGazetteerForTesting();
    // F2-S6: a Helfo row gets the source its claim needs (resolveHelfoClaim).
    const HELFO_PROV = JSON.stringify({ helfo_agreement: [{ value: "true", source_type: "homepage", source_url: "https://example.test/helfo", fetched_at: "2026-05-01T10:00:00Z" }] });
    const add = (row: Record<string, unknown>, given: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ telefon: "22000000", ...row } as any);
      const extra = row.helfo_agreement === "true" && given.field_provenance === undefined ? { ...given, field_provenance: HELFO_PROV } : given;
      const cols = Object.keys(extra);
      if (cols.length) db.prepare(`UPDATE dental_agents SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...extra, id });
      return id;
    };
    const kjeve = { specialists: JSON.stringify([{ name: "Spesialist", title: "Kjeveortoped" }]) };
    const vest = { fylke: "Vestland" };
    const bergenRows: Record<string, string> = {
      "Bergen Sentrum Tann": add({ navn: "Bergen Sentrum Tann", poststed: "BERGEN", postnummer: "5003", helfo_agreement: "true", ...vest }),
      "Bryggen Tann": add({ navn: "Bryggen Tann", poststed: "Bergen", postnummer: "5004", ...vest }),
      "Fana Regulering": add({ navn: "Fana Regulering", poststed: "BERGEN", postnummer: "5006", ...vest }, kjeve),
      "Postboks Tann": add({ navn: "Postboks Tann", poststed: "BERGEN", postnummer: "5835", ...vest }),
      "Uten Postnummer Tann": add({ navn: "Uten Postnummer Tann", poststed: "BERGEN", ...vest }),
      "Nesttun Tann": add({ navn: "Nesttun Tann", poststed: "NESTTUN", postnummer: "5221", helfo_agreement: "true", ...vest }),
      "Nesttun Regulering": add({ navn: "Nesttun Regulering", poststed: "NESTTUN", postnummer: "5222", ...vest }, kjeve),
      "Fyllingsdalen Tann": add({ navn: "Fyllingsdalen Tann", poststed: "FYLLINGSDALEN", postnummer: "5147", ...vest }),
    };
    const poststedBergen = ["Bergen Sentrum Tann", "Bryggen Tann", "Fana Regulering", "Postboks Tann", "Uten Postnummer Tann"];
    add({ navn: "Askøy Tann", poststed: "KLEPPESTØ", postnummer: "5300", ...vest });
    const bergenNamedAskoy = add({ navn: "Bergen Tannhelse", poststed: "KLEPPESTØ", postnummer: "5300", ...vest });
    add({ navn: "Oslo Tann", poststed: "OSLO", postnummer: "0150", fylke: "Oslo" });
    add({ navn: "Ullevål Tann", poststed: "OSLO", postnummer: "0450", fylke: "Oslo" });
    add({ navn: "Kvam Tann", poststed: "KVAM", postnummer: "2642", fylke: "Innlandet" });
    // The kommune name stored as poststed on a Kvam kommune postnummer (as in prod).
    add({ navn: "Hardanger Tannhelse", poststed: "Kvam", postnummer: "5600", ...vest });
    add({ navn: "Norheimsund Tann", poststed: "NORHEIMSUND", postnummer: "5600", ...vest });
    add({ navn: "Øystese Tann", poststed: "ØYSTESE", postnummer: "5610", ...vest });
    add({ navn: "Herøy Tann", poststed: "HERØY", postnummer: "8850", fylke: "Nordland" });
    add({ navn: "Tromsø Tann", poststed: "TROMSØ", postnummer: "9008", fylke: "Troms" });
    add({ navn: "Tromsdalen Tann", poststed: "TROMSDALEN", postnummer: "9020", fylke: "Troms" });
    const allBergen = Object.keys(bergenRows);

    // ── Z: store ──────────────────────────────────────────────────────────
    const pubNames = (f: Record<string, unknown>) => store.listPublicDentalAgents(f as any, 500, 0).map((a) => a.navn);
    const sorted = (a: string[]) => [...a].sort();
    const BERGEN = { poststed_or_postnummer: { poststed_in: ["BERGEN", "Bergen"], postnummer_in: bergenPnr } };
    assertEq(sorted(pubNames(BERGEN)), sorted(allBergen), "Z1: poststed_or_postnummer matches a stored spelling OR a postnummer (postbox and blank postnummer by poststed, Nesttun/Fyllingsdalen by postnummer)");
    assertEq(sorted(pubNames({ poststed_in: ["BERGEN", "Bergen"], postnummer_in: bergenPnr })), sorted(["Bergen Sentrum Tann", "Bryggen Tann", "Fana Regulering"]), "Z2: (poststed_in and postnummer_in on their own still combine with AND)");
    assertEq(sorted(pubNames({ ...BERGEN, specialty: "kjeveortopedi" })), ["Fana Regulering", "Nesttun Regulering"], "Z3: the union combines with other fields by AND");
    assertEq(sorted(pubNames({ ...BERGEN, helfo_agreement: "true", name_terms: ["tann"] })), ["Bergen Sentrum Tann", "Nesttun Tann"], "Z4: ... several of them");
    {
      const f = { natural: { parsed: BERGEN, legacy: { q: "Bergen" } } };
      const names = pubNames(f);
      assertEq(sorted(names), sorted([...allBergen, "Bergen Tannhelse"]), "Z5: inside natural.parsed: union OR the old whole-text q");
      assertEq(sorted(names.slice(0, 6)), sorted([...poststedBergen, "Bergen Tannhelse"]), "Z6: ... whole-text matches still listed first");
      const both = {
        ...BERGEN,
        natural: {
          parsed: { poststed_or_postnummer: { poststed_in: ["NESTTUN"], postnummer_in: ["5147"] } },
          legacy: { poststed_or_postnummer: { poststed_in: ["Bergen"], postnummer_in: ["5003"] } },
        },
      };
      assertEq(sorted(pubNames(both)), sorted(["Nesttun Tann", "Nesttun Regulering", "Fyllingsdalen Tann", "Bryggen Tann", "Bergen Sentrum Tann"]), "Z7: the same field at the top level and in both branches is bound separately");
    }
    for (const f of [BERGEN, { ...BERGEN, specialty: "kjeveortopedi" }, { natural: { parsed: BERGEN, legacy: { q: "tann" } } }] as Array<Record<string, unknown>>) {
      assertEq(store.countPublicDentalAgents(f as any), pubNames(f).length, `Z8: public count == list length (${Object.keys(f).join(",")})`);
      assertEq(store.countDentalAgents(f as any), store.listDentalAgents(f as any, 500, 0).length, `Z9: admin count == list length (${Object.keys(f).join(",")})`);
    }
    {
      const throws = (f: unknown) => { try { store.countPublicDentalAgents({ poststed_or_postnummer: f } as any); return false; } catch { return true; } };
      assertTrue(throws({ poststed_in: ["BERGEN"] }) && throws({ postnummer_in: ["5003"] }), "Z10: both halves are required");
      assertTrue(throws({ poststed_in: [], postnummer_in: ["5003"] }) && throws({ poststed_in: ["BERGEN"], postnummer_in: [] }), "Z11: an empty half is rejected");
      assertTrue(throws({ poststed_in: ["BERGEN"], postnummer_in: ["50a3"] }), "Z12: a postnummer that is not 4 digits is rejected");
      assertTrue(throws({ poststed_in: ["BERGEN"], postnummer_in: Array.from({ length: 401 }, (_, i) => String(1000 + i)) }), "Z13: more than 400 postnumre is rejected");
      assertTrue(throws({ poststed_in: Array.from({ length: 21 }, (_, i) => `STED ${i}`), postnummer_in: ["5003"] }), "Z14: more than 20 poststed spellings is rejected");
      assertTrue(!throws({ poststed_in: ["x'); DROP TABLE dental_agents; --"], postnummer_in: ["5003"] }) && store.countDentalAgents({}) > 0, "Z15: values are bound parameters");
    }

    // ── M: MCP tannlege_search ────────────────────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-kommune-union-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-kommune-union-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const search = async (args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: "tannlege_search", arguments: { limit: 25, ...args } })) as any).content[0].text);
    const names = (r: any): string[] => r.klinikker.map((k: any) => k.navn);
    {
      const r = await search({ query: "tannlege i Bergen" });
      assertEq([r.count, sorted(names(r))], [allBergen.length, sorted(allBergen)], "M1: «tannlege i Bergen» finds poststed Bergen plus Nesttun and Fyllingsdalen (not Kleppestø)");
      assertEq(r.tolkning?.tolket_som, ["sted: Bergen (poststed + kommune)"], "M2: tolkning says «sted: Bergen (poststed + kommune)»");
      assertEq(sorted(names(await search({ query: "tannlege i Bergen kommune" }))), sorted(allBergen), "M3: «tannlege i Bergen kommune» finds the same clinics");
    }
    assertEq(sorted(names(await search({ query: "kjeveortoped Bergen" }))), ["Fana Regulering", "Nesttun Regulering"], "M4: «kjeveortoped Bergen» now finds the orthodontist in Nesttun too");
    assertEq(sorted(names(await search({ query: "Nesttun" }))), ["Nesttun Regulering", "Nesttun Tann"], "M5: «Nesttun» is unchanged");
    assertEq(sorted(names(await search({ query: "tannlege i Oslo" }))), ["Oslo Tann", "Ullevål Tann"], "M6: «tannlege i Oslo» is unchanged");
    {
      const r = await search({ query: "tannlege Kvam" });
      assertEq([sorted(names(r)), r.tolkning?.tolket_som], [["Hardanger Tannhelse", "Kvam Tann"], ["sted: Kvam (poststed)"]], "M7: «tannlege Kvam» -> the poststed KVAM (both stored spellings), as before: not Norheimsund or Øystese");
      const k = await search({ query: "tannlege i Kvam kommune" });
      assertEq(
        [sorted(names(k)), k.tolkning?.tolket_som],
        [["Hardanger Tannhelse", "Kvam Tann", "Norheimsund Tann", "Øystese Tann"], ["sted: Kvam (poststed + kommune)"]],
        "M7b: «tannlege i Kvam kommune» -> the poststed KVAM plus Kvam kommune (Norheimsund 5600, Øystese 5610)"
      );
    }
    assertEq(sorted(names(await search({ query: "tannlege Tromsø" }))), ["Tromsdalen Tann", "Tromsø Tann"], "M8: «tannlege Tromsø» -> Tromsø kommune (Tromsdalen too)");
    {
      // Never fewer: every clinic the poststed-only reading (S3) found is
      // still found, for queries with and without explicit arguments.
      const queries = [
        "Bergen", "tannlege i Bergen", "Bergen kommune", "kjeveortoped Bergen", "helfo tannlege Bergen", "Bergen Tannhelse",
        "Bergen Sentrum Tann", "Nesttun", "Fyllingsdalen Tann", "Oslo", "Kvam", "tannlege i Tromsø", "Tromso", "Herøy",
        "tannlege Bergen eller Oslo", "Askøy", "tannlege i Kvam kommune",
      ];
      const argSets: Array<Record<string, unknown>> = [{}, { fylke: "Vestland" }, { spesialitet: "kjeveortopedi" }, { helfo: true }, { helfo: false }];
      let unions = 0;
      for (const q of queries) {
        for (const args of argSets) {
          const r = await search({ ...args, query: q });
          const before = pubNames(poststedOnly(r.tolkning.filter));
          const after = names(r);
          if (JSON.stringify(r.tolkning.filter).includes("poststed_or_postnummer")) unions++;
          assertTrue(before.every((n) => after.includes(n)) && r.count >= before.length, `M9: «${q}» ${JSON.stringify(args)}: every clinic the poststed alone found is still found`);
        }
      }
      assertTrue(unions >= 40, "M10: (the check above ran the union in at least 40 of its cases)");
    }
    {
      // D3c: tolkning shows Bergen kommune's 144 postnumre as the kommune and
      // how many; the search itself still uses the list.
      const r = await search({ query: "tannlege i Bergen" });
      assertEq(
        r.tolkning?.filter?.natural?.parsed?.poststed_or_postnummer,
        { poststed_in: ["BERGEN", "Bergen"], postnummer_in: { kommunenummer: "4601", antall: bergenPnr.length } },
        "M11: tolkning.filter has Bergen kommune as {kommunenummer, antall}, not the postnummer list"
      );
      assertTrue(Buffer.byteLength(JSON.stringify(r.tolkning)) < 300, "M11b: ... so the whole tolkning is under 300 B");
      assertEq([r.count, sorted(names(r))], [allBergen.length, sorted(allBergen)], "M11c: ... with the same count and clinics as M1");
      const k = await search({ query: "tannlege i Kvam kommune" });
      assertEq(k.tolkning?.filter?.natural?.parsed?.poststed_or_postnummer?.postnummer_in, { kommunenummer: "4622", antall: pn.postnumreForKommune("4622").length }, "M12: «Kvam kommune» likewise ({kommunenummer: 4622, antall})");
      const b = await search({ query: "tannlege Askøy" });
      assertEq(b.tolkning?.filter?.natural?.parsed?.postnummer_in, { kommunenummer: "4627", antall: pn.postnumreForKommune("4627").length }, "M12b: a kommune read by postnummer (Askøy) likewise");
    }

    // ── W: /sok, A: A2A message/send ──────────────────────────────────────
    const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
    {
      const page = await callRoute(seoRouter, "/sok", { q: "tannlege i Bergen" });
      assertTrue(page.text.includes(`${allBergen.length} klinikker funnet`), "W1: /sok?q=tannlege+i+Bergen counts the whole kommune");
      assertTrue(allBergen.every((n) => page.text.includes(`>${n}<`)) && !page.text.includes(">Askøy Tann<"), "W2: ... shows Nesttun and Fyllingsdalen, not Kleppestø");
      assertTrue(page.text.includes("Tolket som: sted: Bergen (poststed + kommune)"), "W3: ... and «Tolket som: sted: Bergen (poststed + kommune)»");
    }
    {
      const page = await callRoute(seoRouter, "/sok", { q: "tannlege i Kvam kommune" });
      assertTrue(
        page.text.includes("Tolket som: sted: Kvam (poststed + kommune)") && page.text.includes("4 klinikker funnet") && page.text.includes(">Øystese Tann<"),
        "W4: /sok?q=tannlege+i+Kvam+kommune: «(poststed + kommune)» and Kvam kommune's clinics"
      );
    }
    const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
    const ask = (text: string) => a2a.handleDentalMessageSend({ message: { text } }, "s3b") as any;
    {
      const resp = ask("tannlege i Bergen");
      const ids = (resp.result.artifacts[1].parts[0].data.clinics as any[]).map((c) => c.id);
      assertEq(sorted(ids), sorted([...Object.values(bergenRows), bergenNamedAskoy]), "A1: A2A «tannlege i Bergen» finds the whole kommune (and, as before, its keyword reading «bergen» in a name)");
      assertEq(resp.result.metadata.tolkning?.tolket_som, ["sted: Bergen (poststed + kommune)"], "A2: ... metadata.tolkning says so");
      assertTrue(a2a.dentalAskedSomething(resp) && sorted(a2a.dentalAnswerProfileIds(resp)).join() === sorted(ids).join(), "A3: ... counted as a question, the same clinics delivered");
      // D3c: metadata.filter is what was searched (the full list); only
      // metadata.tolkning shows the kommune as {kommunenummer, antall}.
      const md = resp.result.metadata;
      assertEq(
        [md.filter.natural.parsed.poststed_or_postnummer.postnummer_in, md.tolkning.filter.natural.parsed.poststed_or_postnummer.postnummer_in],
        [bergenPnr, { kommunenummer: "4601", antall: bergenPnr.length }],
        "A4: A2A keeps the postnummer list in metadata.filter and shows {kommunenummer, antall} in metadata.tolkning"
      );
      assertEq(resp.result.artifacts[1].parts[0].data.total, ids.length, "A4b: ... and total is every clinic found");
    }
    {
      const resp = ask("tannlege i Kvam kommune");
      assertEq(
        [resp.result.artifacts[0].parts[0].text, resp.result.metadata.tolkning?.tolket_som],
        ["Fant 4 tannlegeklinikk(er). / Found 4 dental clinic(s).", ["sted: Kvam (poststed + kommune)"]],
        "A5: A2A «tannlege i Kvam kommune» finds Kvam kommune's clinics"
      );
    }

    // ── R: rollback switch ────────────────────────────────────────────────
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      const r = await search({ query: "tannlege i Bergen" });
      assertTrue(r.count === 0 && r.tolkning === undefined, "R1: switched off -> MCP «tannlege i Bergen» is the old whole-text search (0), no tolkning");
      assertEq(sorted(names(await search({ query: "Bergen" }))), sorted([...poststedBergen, "Bergen Tannhelse"]), "R2: ... and «Bergen» finds what the whole-text q found");
      const page = await callRoute(seoRouter, "/sok", { q: "tannlege i Bergen" });
      assertTrue(page.text.includes("Ingen klinikker funnet") && !page.text.includes("Tolket som"), "R3: ... /sok likewise");
      assertTrue(ask("tannlege i Bergen").result.metadata.tolkning === undefined, "R4: ... A2A likewise");
      const k = await search({ query: "tannlege i Kvam kommune" });
      assertTrue(k.count === 0 && k.tolkning === undefined, "R5: ... and «tannlege i Kvam kommune» is the old whole-text search (0), no tolkning");
    }
    delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  } catch (err: any) {
    failed++;
    failures.push("dental search kommune union: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalSearchKommuneUnionTests({ log: true }).then((r) => {
    console.log(`\ndental search kommune union: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
