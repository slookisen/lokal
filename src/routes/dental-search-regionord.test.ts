/**
 * dental-search-regionord.test.ts — dev-request 2026-10-17-dental-d3-rettelser,
 * slice D3f (regionord og byområder; Daniel's yes to question 9, 2026-10-18).
 *
 * A search text that names a landsdel («tannlege på Vestlandet», «Nord-Norge»)
 * or a byområde («Osloområdet», «Stor-Oslo», «Tromsøya») is read as the fylker
 * or kommuner of config/norway-search-areas.ts, by the one parser and
 * gazetteer MCP tannlege_search, /sok and A2A message/send share.
 *   C   the table: every entry has places and a source; a landsdel's places
 *       are today's fylker, a byområde's are 2024 kommuner, the city first;
 *       no name or alias twice; the landsdeler are Opplevagent's
 *       (LANDSDEL_TO_FYLKER and its aliases); over the full register every
 *       name, alias and ASCII spelling reads as its area (no real place has
 *       its key) and gives a filter the store accepts, with every kommune.
 *   P   parser: a landsdel in any form (inflected, hyphen or space, ASCII,
 *       English) -> fylke_in; a byområde -> what its kommuner each find
 *       alone (Tromsøya = «tannlege i Tromsø»); with a specialty or akutt;
 *       an explicit fylke keeps or drops it; two places as before;
 *       negatives (Vestland, Vestlands, Jæren, Bergen, Oslo, Sør-Norge).
 *   B   B1: every query without an area word parses and plans exactly as
 *       with the gazetteer without areas (the one main had), over the
 *       register and the D3 acceptance queries; the RFB gazetteer (built
 *       without areas) knows no area.
 *   X   MCP, /sok and A2A on one fixture DB: the same clinics and total for
 *       the landsdeler, the byområder and the city names (Tromsø, Bergen,
 *       Bodø, Ålesund, Kristiansand); Tromsøya and Tromsø never Harstad in
 *       MCP and /sok; A2A reads the text as MCP does and adds only what its
 *       old keyword reading finds (D3c2, lokal#1155, makes that nothing for
 *       Tromsø, Tromso and Tromsøya: tested there and in the joint test).
 *   R   DENTAL_QUERY_PARSER_DISABLED=1 still gives the old search.
 *
 * Same harness as dental-search-kommune-union.test.ts (in-memory dental DB,
 * MCP over a real McpServer + client, /sok through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-search-regionord.test.ts
 * Wired into tests/test.ts via runDentalSearchRegionordTests().
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

const sorted = (xs: readonly string[]) => [...xs].sort();

// The poststed spellings and postnumre a filter reads, at the top level.
function placeParts(f: Record<string, any>): { poststeder: string[]; postnumre: string[] } {
  const either = f.poststed_or_postnummer ?? {};
  return {
    poststeder: [...(f.poststed_in ?? []), ...(either.poststed_in ?? [])],
    postnumre: [...(f.postnummer_in ?? []), ...(either.postnummer_in ?? [])],
  };
}

export async function runDentalSearchRegionordTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const nf = require("../services/norway-fylke") as typeof import("../services/norway-fylke");
    const fm = require("../services/fylke-2024-migration") as typeof import("../services/fylke-2024-migration");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const { NORWEGIAN_SEARCH_AREAS: AREAS } = require("../config/norway-search-areas") as typeof import("../config/norway-search-areas");
    const allAreas = [...AREAS.landsdeler, ...AREAS.byomrader];

    // The full register: every official poststed as a stored spelling.
    const official = [...pn.officialPoststedFylker().keys()];
    const full = nq.buildNorwegianGazetteer(official);
    const fullAreas = nq.buildNorwegianGazetteer(official, AREAS);
    const parseFull = (q: string, withinFylke?: string) => parser.parseDentalQuery(q, fullAreas, { withinFylke });

    // ── C: the table ──────────────────────────────────────────────────────
    assertEq(
      allAreas.filter((a) => !a.name || a.places.length === 0 || a.source.trim().length < 20).map((a) => a.name),
      [],
      "C1: every landsdel and byområde has places and names its source"
    );
    assertEq(
      AREAS.landsdeler.flatMap((a) => a.places).filter((f) => !nf.__FYLKE_INTERNAL.CANONICAL_FYLKER.includes(f)),
      [],
      "C2: a landsdel's places are today's fylker (canonical 2024 names)"
    );
    assertEq(
      AREAS.byomrader.flatMap((a) => a.places).filter((k) => !("kommunenummer" in fm.resolveKommunenummerForName(k))),
      [],
      "C3: a byområde's places are 2024 kommuner, each the only one of its name"
    );
    assertEq(
      AREAS.byomrader.filter((a) => !nq.placeKey(a.name).startsWith(nq.placeKey(a.places[0]))).map((a) => a.name),
      [],
      "C4: a byområde lists its city first («Osloområdet» -> Oslo, «Tromsøya» -> Tromsø)"
    );
    {
      const keys = allAreas.flatMap((a) => [a.name, ...a.aliases]).map((n) => nq.placeKey(n));
      assertEq(keys.filter((k, i) => keys.indexOf(k) !== i), [], "C5: no name or alias is in the table twice (after placeKey folding)");
    }
    {
      // Opplevagent keeps its own copy while it is frozen; the two agree.
      const oa = require("../services/experiences-query-intent") as typeof import("../services/experiences-query-intent");
      assertEq(sorted(AREAS.landsdeler.map((a) => a.name)), sorted(Object.keys(oa.LANDSDEL_TO_FYLKER)), "C6: the same five landsdeler as Opplevagent's LANDSDEL_TO_FYLKER");
      const fylkeIn = (q: string) => parseFull(q).filter.fylke_in;
      assertEq(
        Object.entries(oa.LANDSDEL_TO_FYLKER).filter(([name, fylker]) => JSON.stringify(fylkeIn(name)) !== JSON.stringify(fylker)).map(([n]) => n),
        [],
        "C7: each landsdel reads as the fylker Opplevagent gives it"
      );
      assertEq(
        Object.entries(oa.LANDSDEL_ALIASES).filter(([alias, name]) => JSON.stringify(fylkeIn(alias)) !== JSON.stringify(oa.LANDSDEL_TO_FYLKER[name])).map(([a]) => a),
        [],
        "C8: and so does each of Opplevagent's aliases (Nordnorge, Nord-Noreg, Western Norway, Austlandet …)"
      );
    }
    {
      // No real poststed, kommune, region or fylke has an area's key, so the
      // area is never shadowed (and no place read before D3f is taken).
      const forms = allAreas.flatMap((a) => [a.name, ...a.aliases].flatMap((n) => {
        const ascii = n.replace(/æ/gi, "ae").replace(/ø/gi, "o").replace(/å/gi, "a");
        return (ascii === n ? [n] : [n, ascii]).map((form) => [form, a.name] as const);
      }));
      const misread = forms.filter(([form, name]) => {
        const hit = nq.detectPlaces(nq.tokenize(form), fullAreas);
        return hit.length !== 1 || hit[0].name !== name || (hit[0].kind !== "landsdel" && hit[0].kind !== "byomrade");
      });
      assertEq(misread, [], `C9: every name, alias and ASCII spelling (${forms.length}) reads as its own area over the full register`);
      const taken = forms.filter(([form]) => {
        const k = nq.placeKey(form);
        return full.poststeder.has(k) || full.kommuner.has(k) || full.regioner.has(k) || full.fylker.has(k);
      });
      assertEq(taken, [], "C10: ... and none of them is the key of a real poststed, kommune, region or fylke");
    }
    {
      // Within the store's caps over the full register: every kommune is in
      // the area's line, and the filter is one the store accepts.
      const bad = allAreas.filter((a) => {
        const r = parseFull(`tannlege i ${a.name}`);
        return !store.ListFilterSchema.safeParse(r.filter).success || !r.interpretation[0]?.startsWith(`sted: ${a.places.length > 1 ? `${a.places.slice(0, -1).join(", ")} og ${a.places[a.places.length - 1]}` : a.places[0]} (`);
      });
      assertEq(bad.map((a) => a.name), [], "C11: every area gives a filter the store accepts, with all its places in the line");
      const pnr = AREAS.byomrader.map((a) => placeParts(parseFull(a.name).filter).postnumre.length);
      assertTrue(pnr.every((n) => n > 0 && n <= parser.MAX_POSTNUMMER_IN), `C12: each byområde's postnumre fit the store's cap of ${parser.MAX_POSTNUMMER_IN} (${pnr.join(", ")})`);
    }

    // ── P: parser ─────────────────────────────────────────────────────────
    // Stored spellings as listPoststeder() returns them, with the ASCII and
    // mixed-case variants measured in prod.
    const g = nq.buildNorwegianGazetteer([
      "OSLO", "Oslo", "BERGEN", "Bergen", "TROMSØ", "Tromsoe", "HARSTAD", "TROMSDALEN", "ASKER", "LILLESTRØM", "SANDVIKA",
      "STAVANGER", "SANDNES", "SOLA", "TRONDHEIM", "STJØRDAL", "BODØ", "ÅLESUND", "KRISTIANSAND S", "Baerum",
    ], AREAS);
    const parse = (q: string, withinFylke?: string) => parser.parseDentalQuery(q, g, { withinFylke });
    const filterOf = (q: string) => parse(q).filter;
    const VESTLANDET = { fylke_in: ["Rogaland", "Vestland", "Møre og Romsdal"] };
    const NORD_NORGE = { fylke_in: ["Nordland", "Troms", "Finnmark"] };
    const OSTLANDET = { fylke_in: ["Oslo", "Akershus", "Østfold", "Buskerud", "Innlandet", "Vestfold", "Telemark"] };
    const MIDT_NORGE = { fylke_in: ["Trøndelag", "Møre og Romsdal"] };
    for (const q of ["tannlege på Vestlandet", "Vestlandet", "VESTLANDET", "vestlandet.", "dentist in Western Norway", "Fjord Norway"]) {
      assertEq(filterOf(q), VESTLANDET, `P1: «${q}» -> Rogaland, Vestland og Møre og Romsdal`);
    }
    for (const q of ["tannlege i Nord-Norge", "Nord Norge", "nordnorge", "Nord–Norge", "Nord-Noreg", "Northern Norway"]) {
      assertEq(filterOf(q), NORD_NORGE, `P2: «${q}» -> Nordland, Troms og Finnmark`);
    }
    for (const q of ["Sørlandet", "på Sørlandet", "Sorlandet", "SØRLANDET"]) {
      assertEq(filterOf(q), { fylke_in: ["Agder"] }, `P3: «${q}» -> Agder`);
    }
    for (const q of ["Østlandet", "Ostlandet", "Austlandet", "Eastern Norway"]) {
      assertEq(filterOf(q), OSTLANDET, `P4: «${q}» -> the seven fylker of Østlandet`);
    }
    for (const q of ["Midt-Norge", "midt norge", "Midtnorge", "Central Norway"]) {
      assertEq(filterOf(q), MIDT_NORGE, `P5: «${q}» -> Trøndelag og Møre og Romsdal`);
    }
    assertEq(parse("tannlege på Vestlandet").interpretation, ["sted: Rogaland, Vestland og Møre og Romsdal (fylker; landsdelen Vestlandet)"], "P6: tolkning names the fylker and the landsdel");
    assertEq(parse("Sorlandet").interpretation, ["sted: Agder (fylke; landsdelen Sørlandet)"], "P6b: ... in the landsdel's own spelling, one fylke in the singular");
    assertEq(filterOf("kjeveortoped på Vestlandet"), { specialty: "kjeveortopedi", ...VESTLANDET }, "P7: a specialty combines with the landsdel");
    {
      // A byområde finds what each of its kommuner finds alone.
      for (const area of AREAS.byomrader) {
        const parts = placeParts(parseFull(area.name).filter);
        const missing = area.places.filter((k) => {
          const own = placeParts(parseFull(`tannlege i ${k}`).filter);
          return !own.poststeder.every((p) => parts.poststeder.includes(p)) || !own.postnumre.every((p) => parts.postnumre.includes(p));
        });
        assertEq(missing, [], `P8: «${area.name}» covers each of its kommuner as «tannlege i X» reads it (${area.places.join(", ")})`);
      }
    }
    {
      const oslo = parse("tannlege i Osloområdet");
      const parts = placeParts(oslo.filter);
      assertEq(
        [parts.poststeder, sorted(parts.postnumre)],
        [["OSLO", "Oslo", "ASKER", "LILLESTRØM"], sorted(["3201", "3203", "3205", "3222", "3207", "3224", "3232"].flatMap((k) => pn.postnumreForKommune(k)))],
        "P9: «Osloområdet» -> poststed Oslo (its 445 postnumre do not fit, as for «tannlege i Oslo») OR the postnumre of Bærum, Asker, Lillestrøm, Lørenskog, Nordre Follo, Rælingen and Nittedal"
      );
      assertTrue(!parts.postnumre.some((p) => ["3312", "3209", "3212", "3220"].includes(String((pn.resolveKommuneFromPostnummer(p) as any).kommunenummer))), "P9b: ... and not Lier, Ullensaker, Nesodden or Enebakk");
      assertEq(oslo.interpretation, ["sted: Oslo, Bærum, Asker, Lillestrøm, Lørenskog, Nordre Follo, Rælingen og Nittedal (kommuner; Osloområdet)"], "P10: tolkning names the kommuner and the area");
      for (const q of ["Stor-Oslo", "stor oslo", "Oslo-området", "tannlege i osloomradet"]) {
        assertEq(parse(q), { ...oslo, residual_terms: [] }, `P11: «${q}» reads as Osloområdet`);
      }
    }
    {
      const tromso = parse("tannlege i Tromsø");
      for (const q of ["tannlege på Tromsøya", "Tromsoya"]) {
        const r = parse(q);
        assertEq([r.filter, r.interpretation], [tromso.filter, ["sted: Tromsø (kommune; Tromsøya)"]], `P12: «${q}» -> Tromsø kommune, the same fields as «tannlege i Tromsø»`);
      }
      assertEq(tromso.interpretation, ["sted: Tromsø (poststed + kommune)"], "P12b: «tannlege i Tromsø» is read as before (poststed + kommune), never fylke Troms");
    }
    {
      const stavanger = placeParts(filterOf("Stavangerregionen"));
      assertEq(sorted(stavanger.postnumre), sorted(["1103", "1108", "1124", "1127"].flatMap((k) => pn.postnumreForKommune(k))), "P13: «Stavangerregionen» -> Stavanger, Sandnes, Sola and Randaberg");
      assertEq([filterOf("Nord-Jæren"), filterOf("Stavangerområdet")], [filterOf("Stavangerregionen"), filterOf("Stavangerregionen")], "P13b: «Nord-Jæren» and «Stavangerområdet» likewise");
      assertEq(sorted(placeParts(filterOf("Bergensområdet")).postnumre), sorted(["4601", "4631", "4627", "4624", "4626"].flatMap((k) => pn.postnumreForKommune(k))), "P14: «Bergensområdet» -> Bergen, Alver, Askøy, Bjørnafjorden and Øygarden");
      assertEq([filterOf("Bergen-området"), filterOf("Stor-Bergen")], [filterOf("Bergensområdet"), filterOf("Bergensområdet")], "P14b: «Bergen-området» and «Stor-Bergen» likewise");
      assertEq(sorted(placeParts(filterOf("Trondheimsområdet")).postnumre), sorted(["5001", "5028", "5031", "5029", "5059", "5035"].flatMap((k) => pn.postnumreForKommune(k))), "P15: «Trondheimsområdet» -> Trondheim, Melhus, Malvik, Skaun, Orkland and Stjørdal");
    }
    assertEq(filterOf("akutt tannlege Osloområdet").acute_vakt, 1, "P16: akutt combines with a byområde");
    {
      // An explicit fylke keeps an area that reaches into it and drops one that does not.
      assertEq(parse("tannlege på Vestlandet", "Vestland").filter, VESTLANDET, "P17: Vestlandet + fylke Vestland keeps the landsdel (the store ANDs the fylke)");
      const out = parse("tannlege på Vestlandet", "Agder");
      assertEq([out.filter, out.interpretation], [{}, ["merknad: «Vestlandet» ligger ikke i Agder; stedet i teksten brukes ikke"]], "P18: Vestlandet + fylke Agder drops it, with a note");
      assertTrue(Object.keys(parse("Osloområdet", "Akershus").filter).length > 0 && Object.keys(parse("Osloområdet", "Vestland").filter).length === 0, "P19: Osloområdet + Akershus is kept, + Vestland is dropped");
    }
    {
      // Two places: the first (leftmost of the same length) applies, as before D3f.
      const a = parse("tannlege i Bergen på Vestlandet");
      assertEq([a.filter, a.interpretation[1]], [filterOf("tannlege i Bergen"), "merknad: flere steder nevnt; «Vestlandet» brukes ikke"], "P20: «Bergen på Vestlandet» -> Bergen, the landsdel noted");
      assertEq(parse("tannlege på Vestlandet i Bergen").filter, VESTLANDET, "P21: «Vestlandet i Bergen» -> the landsdel (it comes first)");
    }
    {
      // Negatives: words that are no area read as before.
      assertEq(filterOf("tannlege i Vestland"), { fylke: "Vestland" }, "P22: «Vestland» is still the fylke");
      assertEq(filterOf("tannlege Vestlands"), { name_terms: ["vestlands"] }, "P23: «Vestlands» (genitive) is no landsdel, a name word as before");
      assertEq(filterOf("tannlege Jæren"), { fylke: "Rogaland" }, "P24: «Jæren» is still the region (fylke Rogaland), only «Nord-Jæren» is the byområde");
      assertEq([filterOf("tannlege i Bergen").poststed_or_postnummer?.postnummer_in, filterOf("Oslo")], [pn.postnumreForKommune("4601"), { poststed_in: ["OSLO", "Oslo"] }], "P25: «Bergen» and «Oslo» alone are the city, not the byområde");
      assertEq(filterOf("tannlege i Sør-Norge"), { name_terms: ["sør", "norge"] }, "P26: «Sør-Norge» (extent disputed) is left out, as in Opplevagent");
      assertEq(filterOf("tannlege i Stor-Elvdal"), filterOf("Stor-Elvdal kommune"), "P27: «Stor-Elvdal» is still the kommune (no «Stor-» rule)");
    }
    {
      // tolkning compresses an area's postnummer list as any other (D3c).
      const plan = (q: string) => parser.planDentalSearch({ query: q, explicit: {}, gazetteer: () => g, count: () => 1 });
      assertEq(
        plan("tannlege på Tromsøya").tolkning?.filter.natural?.parsed?.poststed_or_postnummer?.postnummer_in,
        { kommunenummer: "5501", antall: pn.postnumreForKommune("5501").length },
        "P28: tolkning shows Tromsøya's postnumre as Tromsø kommune and how many"
      );
      const oslo = plan("Osloområdet");
      assertEq(
        [oslo.tolkning?.filter.natural?.parsed?.poststed_or_postnummer?.postnummer_in, (oslo.filter as any).natural.parsed.poststed_or_postnummer.postnummer_in.length],
        [{ antall: placeParts(filterOf("Osloområdet")).postnumre.length }, placeParts(filterOf("Osloområdet")).postnumre.length],
        "P29: ... several kommuner as {antall}, while the plan's filter keeps the list"
      );
    }

    // ── B: B1, nothing else changes ───────────────────────────────────────
    {
      const names = new Set<string>(official);
      for (const k of pn.kommuner2024()) names.add(k.kommune);
      for (const f of nf.__FYLKE_INTERNAL.CANONICAL_FYLKER) for (const e of nf.fylkeEquivalents(f)) names.add(e);
      for (const r of nf.NON_KOMMUNE_REGION_LABELS) names.add(r);
      for (const r of Object.keys(nf.REGION_TO_KOMMUNER)) names.add(r);
      for (const c of Object.keys(nf.__FYLKE_INTERNAL.CITY_TO_FYLKE_RAW)) names.add(c);
      // The D3 acceptance queries and the texts the other dental search tests use.
      const queries = new Set<string>([
        "finn tannlege med helfo-avtale i Oslo", "kjeveortoped Trondheim", "tannlege i Bergen", "tannlege i Bærum", "tannlege i Oslo",
        "tannlege i Viken", "tannlege i Kvam kommune", "Kvam kommunen", "dentist in Kvam municipality", "Sula kommune", "Åmot kommune",
        "Os kommune", "Hemnes kommune", "tannlege i Kvam", "Bergen kommune", "Lund kommune", "Osen kommune", "tannlege i Tromsø",
        "tannlege i Tromso", "tannlege i Tromsdalen", "tannlege i Troms", "Troms og Finnmark", "Nord-Troms", "Vest-Agder tannlege",
        "kjeveortoped møre og romsdal", "finn tannlege i Vestland", "tannlege i Oslo.", "tannlege i Ål", "Ål", "tannlege i Alvdal",
        "Modum", "Hole kommune", "kjeveortoped Bergen", "akuttvakt tannlege Stavanger", "tannlege i Vestland", "dentist in Oslo",
        "tannlege Lofoten", "Herøy", "Hordaland", "Sør-Trøndelag", "tannlege i Bodø", "Ålesund", "Kristiansand", "Kristiansand S",
        "Mo i Rana", "tannlege i Ås", "Bergen Tannhelse", "Bodø Tannregulering", "emergency dentist Tromso", "tannlege Vestlands",
        "Rogalandsklinikken", "tannlege", "find orthodontist in Bergen", "helfo tannlege Oslo", "tannlege Time", "uten helfo Bergen",
        "tannlege nord i Norge", "dentist in Norway", "Stor-Elvdal", "Nord-Fron", "Sør-Varanger", "tannlege Jæren", "Fjord kommune",
      ]);
      for (const n of names) { queries.add(n); queries.add(`tannlege i ${n}`); queries.add(`${n} kommune`); }
      const count = (f: Record<string, unknown>) => JSON.stringify(f).length;
      const a2aLegacy = (t: string) => ({ q: t.toLowerCase() });
      const run = (q: string, gz: typeof full) => JSON.stringify([
        parser.parseDentalQuery(q, gz),
        parser.planDentalSearch({ query: q, explicit: {}, gazetteer: () => gz, count }),
        parser.planDentalSearch({ query: q, explicit: { fylke: "Vestland" }, gazetteer: () => gz, count, legacy: a2aLegacy }),
      ]);
      const changed = [...queries].filter((q) => run(q, full) !== run(q, fullAreas));
      assertEq(changed, [], `B1: all ${queries.size} queries without an area word (every poststed, kommune, fylke and region, with «tannlege i» and «kommune», and the D3 acceptance queries) parse and plan byte-identically with and without the areas`);
    }
    {
      // RFB builds its gazetteer without areas (marketplace-registry.ts).
      const rfb = nq.buildNorwegianGazetteer(official);
      assertEq([rfb.landsdeler.size, rfb.byomrader.size], [0, 0], "B2: a gazetteer built without areas has none (the RFB one)");
      assertEq(
        ["honning på Vestlandet", "Osloområdet", "Tromsøya", "Nord-Norge"].map((q) => nq.detectPlaces(nq.tokenize(q), rfb).map((m) => m.kind)),
        [[], [], [], []],
        "B3: ... so the RFB search finds no place in a landsdel or byområde word, as before D3f"
      );
      assertEq(nq.detectPlaces(nq.tokenize("Stor-Oslo"), rfb).map((m) => [m.kind, m.name]), [["poststed", "OSLO"]], "B4: ... and «Stor-Oslo» is still the poststed Oslo there");
    }

    // ── fixture DB ────────────────────────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("dental");
    const gaz = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    gaz.__resetDentalSearchGazetteerForTesting();
    const add = (navn: string, poststed: string, fylke: string, postnummer: string): string =>
      store.createDentalAgent({ navn, poststed, fylke, postnummer, telefon: "22000000" } as any);
    add("Bergen Sentrum Tann", "BERGEN", "Vestland", "5003");
    add("Askøy Tann", "KLEPPESTØ", "Vestland", "5300");
    add("Voss Tann", "VOSS", "Vestland", "5700");
    add("Stavanger Tann", "STAVANGER", "Rogaland", "4006");
    add("Sola Tann", "SOLA", "Rogaland", "4050");
    add("Bryne Tann", "BRYNE", "Rogaland", "4340");
    add("Ålesund Tann", "ÅLESUND", "Møre og Romsdal", "6002");
    add("Sørlandet Tann", "KRISTIANSAND S", "Agder", "4611");
    add("Oslo Sentrum Tann", "OSLO", "Oslo", "0150");
    add("Majorstua Tann", "OSLO", "Oslo", "0151");
    add("Sandvika Tann", "SANDVIKA", "Akershus", "1337");
    add("Lillestrøm Tann", "LILLESTRØM", "Akershus", "2000");
    add("Asker Tann", "ASKER", "Akershus", "1384");
    add("Ski Tann", "SKI", "Akershus", "1400");
    add("Jessheim Tann", "JESSHEIM", "Akershus", "2050");
    add("Lier Tann", "LIER", "Buskerud", "3402");
    add("Drammen Tann", "DRAMMEN", "Buskerud", "3015");
    add("Hamar Tann", "HAMAR", "Innlandet", "2317");
    add("Trondheim Tann", "TRONDHEIM", "Trøndelag", "7010");
    add("Stjørdal Tann", "STJØRDAL", "Trøndelag", "7500");
    add("Steinkjer Tann", "STEINKJER", "Trøndelag", "7713");
    add("Tromsø Tann", "TROMSØ", "Troms", "9008");
    add("Tromsdalen Tann", "TROMSDALEN", "Troms", "9020");
    add("Harstad Tann", "HARSTAD", "Troms", "9405");
    add("Bodø Tann", "BODØ", "Nordland", "8006");
    add("Alta Tann", "ALTA", "Finnmark", "9510");
    assertTrue(gaz.getDentalSearchGazetteer(store.listPoststeder).landsdeler.size > 0, "X0: the dental gazetteer has the landsdeler and byområder");

    // ── X: the three surfaces ─────────────────────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-search-regionord-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-search-regionord-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const search = async (args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: "tannlege_search", arguments: { limit: 25, ...args } })) as any).content[0].text);
    const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
    const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
    const nameOf = new Map(store.listPublicDentalAgents({}, 500, 0).map((a) => [a.id, a.navn]));
    const ask = (text: string) => {
      const resp = a2a.handleDentalMessageSend({ message: { text } }, "d3f") as any;
      const data = resp.result.artifacts[1].parts[0].data;
      return { names: sorted((data.clinics as any[]).map((c) => nameOf.get(c.id)!)), total: data.total as number, metadata: resp.result.metadata };
    };
    // The clinics A2A's old keyword reading finds alone (its rollback path).
    const oldA2a = (text: string) => {
      process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
      try { return ask(text).names; } finally { delete process.env.DENTAL_QUERY_PARSER_DISABLED; }
    };
    const surfaces = async (q: string) => {
      const mcp = await search({ query: q });
      const page = await callRoute(seoRouter, "/sok", { q });
      const shown = [...nameOf.values()].filter((n) => page.text.includes(`>${n}<`));
      return { mcp, mcpNames: sorted(mcp.klinikker.map((k: any) => k.navn)), page, shown: sorted(shown), a2a: ask(q) };
    };

    const expected: Array<[query: string, clinics: string[]]> = [
      ["tannlege på Vestlandet", ["Bergen Sentrum Tann", "Askøy Tann", "Voss Tann", "Stavanger Tann", "Sola Tann", "Bryne Tann", "Ålesund Tann"]],
      ["tannlege i Nord-Norge", ["Tromsø Tann", "Tromsdalen Tann", "Harstad Tann", "Bodø Tann", "Alta Tann"]],
      ["tannlege på Sørlandet", ["Sørlandet Tann"]],
      ["tannlege på Østlandet", ["Oslo Sentrum Tann", "Majorstua Tann", "Sandvika Tann", "Lillestrøm Tann", "Asker Tann", "Ski Tann", "Jessheim Tann", "Lier Tann", "Drammen Tann", "Hamar Tann"]],
      ["tannlege i Midt-Norge", ["Trondheim Tann", "Stjørdal Tann", "Steinkjer Tann", "Ålesund Tann"]],
      ["tannlege i Osloområdet", ["Oslo Sentrum Tann", "Majorstua Tann", "Sandvika Tann", "Lillestrøm Tann", "Asker Tann", "Ski Tann"]],
      ["tannlege i Stor-Oslo", ["Oslo Sentrum Tann", "Majorstua Tann", "Sandvika Tann", "Lillestrøm Tann", "Asker Tann", "Ski Tann"]],
      ["tannlege i Bergensområdet", ["Bergen Sentrum Tann", "Askøy Tann"]],
      ["tannlege i Stavangerregionen", ["Stavanger Tann", "Sola Tann"]],
      ["tannlege i Trondheimsområdet", ["Trondheim Tann", "Stjørdal Tann"]],
      ["tannlege i Bergen", ["Bergen Sentrum Tann"]],
      ["tannlege i Bodø", ["Bodø Tann"]],
      ["tannlege i Ålesund", ["Ålesund Tann"]],
      ["tannlege i Kristiansand", ["Sørlandet Tann"]],
    ];
    for (const [q, clinics] of expected) {
      const s = await surfaces(q);
      assertEq([s.mcp.count, s.mcpNames], [clinics.length, sorted(clinics)], `X1: MCP «${q}» -> ${clinics.length} clinic(s), exactly those of the place`);
      assertTrue(s.page.text.includes(`${clinics.length} klinikker funnet`) && JSON.stringify(s.shown) === JSON.stringify(sorted(clinics)), `X2: /sok «${q}» -> the same ${clinics.length} clinic(s)`);
      assertEq([s.a2a.total, s.a2a.names], [clinics.length, sorted(clinics)], `X3: A2A «${q}» -> the same clinics and total`);
      assertEq(
        [s.a2a.metadata.tolkning?.tolket_som, s.a2a.metadata.tolkning?.filter?.natural?.parsed],
        [s.mcp.tolkning?.tolket_som, s.mcp.tolkning?.filter?.natural?.parsed],
        `X4: A2A «${q}» reads the text as MCP does (tolkning, parsed filter)`
      );
    }
    {
      const s = await surfaces("tannlege i Vestlandet");
      assertTrue(s.page.text.includes("Tolket som: sted: Rogaland, Vestland og Møre og Romsdal (fylker; landsdelen Vestlandet)"), "X5: /sok says «Tolket som: … (fylker; landsdelen Vestlandet)»");
    }
    // Tromsø, Tromso and Tromsøya: Tromsø kommune, never the whole of Troms.
    const tromso = sorted(["Tromsø Tann", "Tromsdalen Tann"]);
    for (const q of ["tannlege i Tromsø", "tannlege i Tromso", "tannlege på Tromsøya"]) {
      const s = await surfaces(q);
      assertEq([s.mcp.count, s.mcpNames, s.shown], [2, tromso, tromso], `X6: MCP and /sok «${q}» -> Tromsø kommune (Tromsdalen too), not Harstad`);
      assertEq(s.a2a.metadata.tolkning?.filter?.natural?.parsed, s.mcp.tolkning?.filter?.natural?.parsed, `X7: A2A «${q}» reads the place as MCP does (Tromsø kommune)`);
      // A2A also keeps every clinic its old keyword reading finds (B1). On
      // main that reading took «troms» inside «Tromsø» as the fylke; D3c2
      // (lokal#1155) reads a fylke only from whole words, so it adds nothing.
      assertEq(s.a2a.names, sorted([...new Set([...tromso, ...oldA2a(q)])]), `X8: A2A «${q}» -> Tromsø kommune plus only what its old keyword reading finds`);
    }

    // ── R: rollback switch ────────────────────────────────────────────────
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    try {
      const r = await search({ query: "tannlege på Vestlandet" });
      assertTrue(r.count === 0 && r.tolkning === undefined, "R1: switched off -> MCP «tannlege på Vestlandet» is the old whole-text search (0), no tolkning");
      const page = await callRoute(seoRouter, "/sok", { q: "tannlege i Osloområdet" });
      assertTrue(page.text.includes("Ingen klinikker funnet") && !page.text.includes("Tolket som"), "R2: ... /sok «tannlege i Osloområdet» likewise");
      assertTrue(ask("tannlege på Vestlandet").metadata.tolkning === undefined, "R3: ... A2A likewise (no tolkning)");
    } finally {
      delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    }
  } catch (err: any) {
    failed++;
    failures.push("dental search regionord: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalSearchRegionordTests({ log: true }).then((r) => {
    console.log(`\ndental search regionord: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
