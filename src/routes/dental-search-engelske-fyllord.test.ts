/**
 * dental-search-engelske-fyllord.test.ts — dev-request
 * 2026-10-16-tannlege-sok-naturlig-sprak, slice S-EN (FUNN
 * dental-sok-engelske-restord-som-navn, review of lokal#1179).
 *
 * English time and filler words in a request passed on by ChatGPT or Claude
 * (and what a contraction leaves: «don't» -> «don», «t») are stopwords
 * (DENTAL_SEARCH_VOCABULARY.stopwords), not a clinic name:
 * «I need emergency dental care in Rogaland tonight» gave 0 in prod, read as
 * the name «care, tonight», while «I need an emergency dentist in Rogaland»
 * gave 33.
 *   E   parser: the example reads as the control (Rogaland + akutt, no
 *       words left); more English requests read as their Norwegian
 *       control; each new word is dropped next to a place and alone; the
 *       words left out on purpose (Norwegian words, words in clinic names)
 *       are still name words.
 *   N   the list: every new word is a stopword, lower case and one token;
 *       none is a place in the register (so no place reading changes) or a
 *       specialty, trigger, negation or kommune word.
 *   B   B1: every Norwegian query (every poststed, kommune, fylke, region
 *       and area of the register, alone, with «tannlege i» and «kommune»,
 *       plus the control searches and acceptance queries of the search
 *       dev-requests) parses byte-identically with the list as on main.
 *   X   MCP, /sok and A2A on one fixture DB: the example finds the clinics
 *       the control finds, with the same tolkning and no name words (the old
 *       reading found none); a clinic whose name holds «care» or
 *       «dentistry» is still found first by its name on all three.
 *   R   DENTAL_QUERY_PARSER_DISABLED=1 still gives the old search (MCP's
 *       whole text, A2A's own keyword reading, its list unchanged).
 *
 * Same harness as dental-search-regionord.test.ts (in-memory dental DB, MCP
 * over a real McpServer + client, /sok through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-search-engelske-fyllord.test.ts
 * Wired into tests/test.ts via runDentalSearchEngelskeFyllordTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// The words S-EN added to DENTAL_SEARCH_VOCABULARY.stopwords. The list
// without them is the list as on main (B1 compares the two).
export const S_EN_STOPWORDS: readonly string[] = [
  "care", "dentistry", "treatment", "services", "office", "practice",
  "tonight", "tomorrow", "morning", "evening", "afternoon", "night", "day", "days", "week", "next",
  "weekend", "weekends", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "soon", "possible", "immediately", "currently", "right", "after", "before", "within", "out", "hours",
  "hour", "pm", "opening", "during", "until", "early", "already", "availability",
  "how", "when", "why", "they", "them", "their", "ll", "don", "doesn", "didn", "isn", "aren",
  "someone", "somebody", "anyone", "anybody", "something", "place", "places", "know", "look",
  "searching", "seeking", "go", "going", "got", "needs", "needed", "choose", "visit", "see", "able",
  "was", "were", "been", "should", "might", "also", "only", "really", "very", "if", "but", "then",
  "than", "here", "located", "based", "local", "closest", "top", "rated", "highly", "great",
  "urgently", "quickly", "maybe", "perhaps", "kindly", "hello", "hey", "thanks", "thank",
];

// Left out on purpose: words that are also Norwegian words, and words that
// stand as a whole word in a clinic's name (dump 2026-10-18: «AM
// SPESIALISTTANNLEGE AS», «TANNLEGE SAID GHASEMI», «FAST TANN AS», «TANNLEGE
// EVEN G JOKSTAD», «HEMA ONE AS», «DENTAL SERVICE SCARBARTH AS» …).
const LEFT_OUT = [
  "be", "so", "hi", "ve", "re", "just", "like", "late", "later", "must", "same",
  "am", "may", "asap", "walk", "fast", "even", "one", "said", "service",
];

const EXAMPLE = "I need emergency dental care in Rogaland tonight";
const CONTROL = "I need an emergency dentist in Rogaland";

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

export async function runDentalSearchEngelskeFyllordTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const { DENTAL_SEARCH_VOCABULARY: VOCAB } = require("../config/dental-search-vocabulary") as typeof import("../config/dental-search-vocabulary");
    const { NORWEGIAN_SEARCH_AREAS: AREAS } = require("../config/norway-search-areas") as typeof import("../config/norway-search-areas");

    // The register as the dental gazetteer reads it (every official poststed, with the areas).
    const official = [...pn.officialPoststedFylker().keys()];
    const full = nq.buildNorwegianGazetteer(official, AREAS);
    const parse = (q: string) => parser.parseDentalQuery(q, full);
    // The list as on main: today's list without the S-EN words.
    const added = new Set(S_EN_STOPWORDS);
    const onMain = { ...VOCAB, stopwords: new Set([...VOCAB.stopwords].filter((w) => !added.has(w))) };
    const parseOnMain = (q: string) => parser.parseDentalQuery(q, full, { vocabulary: onMain });

    // ── E: parser ─────────────────────────────────────────────────────────
    {
      const ex = parse(EXAMPLE);
      const ctl = parse(CONTROL);
      assertEq([ex.filter, ex.residual_terms], [{ acute_vakt: 1, fylke: "Rogaland" }, []], `E1: «${EXAMPLE}» -> Rogaland + akutt, no words left`);
      assertEq([ex.filter, ex.interpretation], [ctl.filter, ctl.interpretation], `E2: ... the same filter and tolkning as «${CONTROL}»`);
      assertEq(parseOnMain(EXAMPLE).filter.name_terms, ["care", "tonight"], "E3 (control): with the list as on main the example reads «care, tonight» as a name (the prod bug)");
    }
    {
      const pairs: Array<[english: string, control: string]> = [
        ["Is there a dentist open this weekend in Bergen?", "tannlege i Bergen"],
        ["Where can I go for urgent dental care tomorrow morning in Tromsø?", "akutt tannlege i Tromsø"],
        ["top rated orthodontist in Oslo", "kjeveortoped Oslo"],
        ["dental office open after hours near Trondheim", "tannlege Trondheim"],
        ["I'm looking for someone who can see me as soon as possible in Bodø", "tannlege i Bodø"],
        ["Hello! Can you find a dentist accepting new patients in Bærum, thanks", "tannlege i Bærum"],
        ["Emergency dental treatment on Sunday night in Stavanger", "akutt tannlege Stavanger"],
        ["Which dental practice in Kristiansand has Helfo direct billing?", "helfo tannlege Kristiansand"],
        ["Can someone recommend a highly rated endodontist for a root canal in Bergen? Available tomorrow or Monday", "endodontist Bergen"],
        ["dentist located in Ålesund that is currently available, opening hours until Friday", "tannlege i Ålesund"],
        ["a great local dentist on Vestlandet, also open on Saturday", "tannlege på Vestlandet"],
        // question words, pronouns and contractions (the apostrophe splits «don't» into «don», «t»)
        ["How can I find an emergency dentist in Oslo?", "akutt tannlege i Oslo"],
        ["When is the dentist open in Bergen? Which of them doesn't need an appointment before 5 pm", "tannlege i Bergen"],
        ["I don't know which dentist to choose in Trondheim", "tannlege i Trondheim"],
        ["I'll need a dentist in Stavanger tomorrow, can they help?", "tannlege i Stavanger"],
        ["Why isn't there a dentist in Bodø that is able to see me within an hour?", "tannlege i Bodø"],
        ["Aren't there dentists in Oslo? I didn't find any", "tannlege i Oslo"],
        ["My kid needs a dentist in Ålesund, show them to me with their opening hours", "tannlege i Ålesund"],
        ["I'm going to Bergen next week and needed a dentist, maybe perhaps someone already has availability?", "tannlege i Bergen"],
        // «urgently» is no akutt trigger («urgent» is): a filler word, so the place still applies
        ["I urgently need a dentist in Tromsø, could you kindly find it quickly", "tannlege i Tromsø"],
        ["Do they accept Helfo? I got to find a dentist in Drammen", "helfo tannlege Drammen"],
      ];
      for (const [english, control] of pairs) {
        const e = parse(english);
        const c = parse(control);
        assertEq([e.filter, e.interpretation, e.residual_terms], [c.filter, c.interpretation, []], `E4: «${english}» reads as «${control}», no words left`);
      }
    }
    {
      const bergen = parse("tannlege i Bergen");
      const kept = S_EN_STOPWORDS.filter((w) => {
        const r = parse(`tannlege i Bergen ${w}`);
        return JSON.stringify([r.filter, r.interpretation, r.residual_terms]) !== JSON.stringify([bergen.filter, bergen.interpretation, []]);
      });
      assertEq(kept, [], `E5: each of the ${S_EN_STOPWORDS.length} words after a place is dropped (the place's own reading, no name word)`);
      const alone = S_EN_STOPWORDS.filter((w) => {
        const r = parse(w);
        return Object.keys(r.filter).length > 0 || r.residual_terms.length > 0;
      });
      assertEq(alone, [], "E6: ... and alone gives no filter and no word left (tolkning says nothing was found)");
    }
    {
      const named = LEFT_OUT.filter((w) => JSON.stringify(parse(`tannlege i Oslo ${w}`).filter.name_terms) !== JSON.stringify([w]));
      assertEq(named, [], `E7: the words left out on purpose are still name words (${LEFT_OUT.join(", ")})`);
      assertEq(parse("Fast Tann").filter, { name_terms: ["fast", "tann"] }, "E8: a clinic name with a Norwegian word («Fast Tann») is read as before");
    }

    // ── N: the list ───────────────────────────────────────────────────────
    assertEq(S_EN_STOPWORDS.filter((w) => !VOCAB.stopwords.has(w)), [], "N1: every S-EN word is a stopword");
    assertEq(
      [S_EN_STOPWORDS.filter((w, i) => S_EN_STOPWORDS.indexOf(w) !== i), S_EN_STOPWORDS.filter((w) => JSON.stringify(nq.tokenize(w)) !== JSON.stringify([w]))],
      [[], []],
      "N2: each word once, lower case and one token as tokenize() gives it"
    );
    assertEq(onMain.stopwords.size, VOCAB.stopwords.size - S_EN_STOPWORDS.length, "N3: the list as on main is today's minus exactly these words");
    {
      const kinds = ["poststeder", "kommuner", "regioner", "fylker", "landsdeler", "byomrader"] as const;
      const places = S_EN_STOPWORDS.filter((w) => kinds.some((k) => (full[k] as ReadonlyMap<string, unknown>).has(nq.placeKey(w))));
      assertEq(places, [], "N4: no word is the key of a poststed, kommune, region, fylke, landsdel or byområde in the register (unlike «time», Time kommune)");
      assertEq(LEFT_OUT.filter((w) => VOCAB.stopwords.has(w)), [], "N5: none of the words left out on purpose is a stopword");
    }
    {
      const used = new Set<string>([
        ...VOCAB.specialties.flatMap((s) => [s.canonical, s.slug, ...s.synonyms].flatMap((w) => nq.tokenize(w))),
        ...[...VOCAB.akutt, ...VOCAB.helfo].flatMap((w) => nq.tokenize(w)),
        ...VOCAB.negations,
        ...VOCAB.kommuneWords,
      ]);
      assertEq(S_EN_STOPWORDS.filter((w) => used.has(w)), [], "N6: no word is part of a specialty, akutt or Helfo phrase, a negation or a kommune word");
    }

    // ── B: B1, Norwegian queries parse as on main ─────────────────────────
    {
      const names = new Set<string>(official);
      for (const k of pn.kommuner2024()) names.add(k.kommune);
      for (const f of nf.__FYLKE_INTERNAL.CANONICAL_FYLKER) for (const e of nf.fylkeEquivalents(f)) names.add(e);
      for (const r of nf.NON_KOMMUNE_REGION_LABELS) names.add(r);
      for (const r of Object.keys(nf.REGION_TO_KOMMUNER)) names.add(r);
      for (const c of Object.keys(nf.__FYLKE_INTERNAL.CITY_TO_FYLKE_RAW)) names.add(c);
      for (const a of [...AREAS.landsdeler, ...AREAS.byomrader]) for (const n of [a.name, ...a.aliases]) names.add(n);
      // The control searches of the post-deploy checks and the acceptance
      // queries of the search dev-requests (S1–S3, S3b, D3), and Norwegian
      // requests with time and filler words.
      const queries = new Set<string>([
        "tannlege i Bergen", "Bergen", "kjeveortoped Bergen", "dentist in Oslo", "tannlege i Bærum", "tannlege i Oslo",
        "finn tannlege med helfo-avtale i Oslo", "akuttvakt tannlege Stavanger", "find orthodontist in Bergen", "kjeveortoped Trondheim",
        "tannlege i Bergen kommune", "tannlege i Nesttun", "Fyllingsdalen", "tannlege i Trondheim", "tannlege i Stavanger",
        "tannlege i Tromsø", "tannlege i Drammen", "tannlege i Kristiansand", "tannlege i Viken", "tannlege i Kvam kommune",
        "Kvam kommunen", "dentist in Kvam municipality", "Sula kommune", "Åmot kommune", "Os kommune", "Hemnes kommune",
        "tannlege i Kvam", "Lund kommune", "Osen kommune", "tannlege i Tromso", "tannlege i Tromsdalen", "tannlege i Troms",
        "Troms og Finnmark", "Nord-Troms", "Vest-Agder tannlege", "kjeveortoped møre og romsdal", "finn tannlege i Vestland",
        "tannlege i Ål", "tannlege i Alvdal", "Hole kommune", "tannlege i Vestland", "tannlege Lofoten", "Herøy", "Hordaland",
        "Sør-Trøndelag", "Mo i Rana", "tannlege i Ås", "Bergen Tannhelse", "Bodø Tannregulering", "emergency dentist Tromso",
        "tannlege Vestlands", "Rogalandsklinikken", "tannlege", "helfo tannlege Oslo", "tannlege Time", "uten helfo Bergen",
        "tannlege nord i Norge", "dentist in Norway", "tannlege på Vestlandet", "tannlege i Osloområdet", "Tromsøya",
        "en time hos tannlege i Oslo", "tannlege for barn i Oslo", "tannlege Bergen sentrum", "tannlege bauge", "50%_x",
        "jeg trenger akutt tannlege i Bergen i kveld", "tannlegevakt Oslo i helgen", "åpen tannlege på lørdag i Bergen",
        "finn en god tannlege i nærheten av Trondheim", "kan du anbefale en tannlege som tar imot nye pasienter i Tromsø",
        "rotbehandling Tromsø i morgen", "tannlege med ledig time i dag i Stavanger", "barnetannlege Kristiansand",
        "Fast Tann", "Akuttklinikken Oslo", "Helfotannlegen Bergen", "tannlege uten helfo i Oslo", "Oslo kommune",
      ]);
      for (const n of names) { queries.add(n); queries.add(`tannlege i ${n}`); queries.add(`${n} kommune`); }
      const changed = [...queries].filter((q) => JSON.stringify(parse(q)) !== JSON.stringify(parseOnMain(q)));
      assertEq(changed, [], `B1: all ${queries.size} Norwegian queries (every poststed, kommune, fylke, region and area, with «tannlege i» and «kommune», and the control and acceptance queries) parse byte-identically with the list as on main`);
    }

    // ── fixture DB ────────────────────────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const gaz = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    gaz.__resetDentalSearchGazetteerForTesting();
    const add = (navn: string, poststed: string, fylke: string, postnummer: string, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ navn, poststed, fylke, postnummer, telefon: "22000000" } as any);
      const cols = Object.keys(extra);
      if (cols.length) db.prepare(`UPDATE dental_agents SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...extra, id });
      return id;
    };
    // An emergency duty with a source, and a clinic that takes emergency patients (S2b's two akutt claims).
    const vakt = { acute_vakt: 1, field_provenance: JSON.stringify({ acute_vakt: [{ source_type: "homepage", value: 1 }] }) };
    add("Stavanger Akuttvakt", "STAVANGER", "Rogaland", "4006", vakt);
    add("Sandnes Tannhelse", "SANDNES", "Rogaland", "4306", { patient_focus: JSON.stringify(["Tar imot akuttpasienter"]) });
    add("Bryne Tann", "BRYNE", "Rogaland", "4340");
    add("Bergen Akuttvakt", "BERGEN", "Vestland", "5003", vakt);
    add("Fjord Dentistry", "BERGEN", "Vestland", "5004");
    add("Nordisk Dental Care", "OSLO", "Oslo", "0150");
    add("Majorstua Tann", "OSLO", "Oslo", "0151");
    const ROGALAND_AKUTT = sorted(["Stavanger Akuttvakt", "Sandnes Tannhelse"]);

    // ── X: the three surfaces ─────────────────────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-search-engelske-fyllord-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-search-engelske-fyllord-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const search = async (args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: "tannlege_search", arguments: { limit: 25, ...args } })) as any).content[0].text);
    const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
    const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
    const nameOf = new Map(store.listPublicDentalAgents({}, 500, 0).map((a) => [a.id, a.navn]));
    const ask = (text: string) => {
      const resp = a2a.handleDentalMessageSend({ message: { text } }, "s-en") as any;
      const data = resp.result.artifacts[1].parts[0].data;
      const ids = (data.clinics as any[]).map((c) => nameOf.get(c.id)!);
      return { first: ids[0], names: sorted(ids), total: data.total as number, metadata: resp.result.metadata };
    };
    const surfaces = async (q: string) => {
      const mcp = await search({ query: q });
      const page = await callRoute(seoRouter, "/sok", { q });
      const shown = [...nameOf.values()].filter((n) => page.text.includes(`>${n}<`));
      const order = shown.map((n) => [page.text.indexOf(`>${n}<`), n] as const).sort((a, b) => a[0] - b[0]).map(([, n]) => n);
      return { mcp, mcpNames: sorted(mcp.klinikker.map((k: any) => k.navn)), page, shown: sorted(shown), pageFirst: order[0], a2a: ask(q) };
    };

    {
      // The old reading of the example (main's list) finds nothing here, as in prod.
      const old = parseOnMain(EXAMPLE).filter;
      assertEq([store.countPublicDentalAgents(old as any), store.countPublicDentalAgents(parse(CONTROL).filter as any)], [0, 2], "X0 (control): the fixture reproduces the bug: the old reading finds 0, the control 2");
    }
    {
      const ex = await surfaces(EXAMPLE);
      const ctl = await surfaces(CONTROL);
      assertEq([ex.mcp.count, ex.mcpNames], [2, ROGALAND_AKUTT], `X1: MCP «${EXAMPLE}» -> the 2 Rogaland clinics with an akutt claim`);
      assertEq([ex.mcp.count, ex.mcpNames, ex.mcp.tolkning?.tolket_som, ex.mcp.tolkning?.fallback], [ctl.mcp.count, ctl.mcpNames, ctl.mcp.tolkning?.tolket_som, false], "X2: ... the same clinics, count and tolkning as the control, no fallback");
      assertEq(ex.mcp.tolkning?.filter?.natural?.parsed, { acute_vakt: 1, fylke: "Rogaland" }, "X3: ... tolkning's parsed filter has no name words");
      assertTrue(
        ex.page.text.includes("2 klinikker funnet") && ex.page.text.includes("Tolket som: sted: Rogaland (fylke) · akutt: ja") && JSON.stringify(ex.shown) === JSON.stringify(ROGALAND_AKUTT),
        "X4: /sok -> the same 2 clinics, «Tolket som: sted: Rogaland (fylke) · akutt: ja»"
      );
      assertEq([ex.a2a.total, ex.a2a.names], [2, ROGALAND_AKUTT], "X5: A2A message/send -> the same clinics and total");
      assertEq(
        [ex.a2a.metadata.tolkning?.tolket_som, ex.a2a.metadata.tolkning?.filter?.natural?.parsed],
        [ex.mcp.tolkning?.tolket_som, ex.mcp.tolkning?.filter?.natural?.parsed],
        "X6: A2A reads the text with the same list as MCP (tolkning, parsed filter)"
      );
    }
    {
      const en = await surfaces("Is there a dentist open this weekend in Bergen?");
      const no = await surfaces("tannlege i Bergen");
      const bergen = sorted(["Bergen Akuttvakt", "Fjord Dentistry"]);
      assertEq(
        [en.mcp.count, en.mcpNames, en.shown, en.a2a.names, en.mcp.tolkning?.tolket_som],
        [2, bergen, bergen, bergen, no.mcp.tolkning?.tolket_som],
        "X7: «Is there a dentist open this weekend in Bergen?» -> the Bergen clinics on all three, read as «tannlege i Bergen»"
      );
    }
    for (const [q, clinic] of [["Nordisk Dental Care", "Nordisk Dental Care"], ["dental care", "Nordisk Dental Care"], ["Fjord Dentistry", "Fjord Dentistry"]] as const) {
      // «care» and «dentistry» stand in a clinic name: the name search still finds that clinic first.
      const s = await surfaces(q);
      assertTrue(s.mcp.count >= 1 && s.mcp.klinikker[0]?.navn === clinic, `X8: MCP «${q}» -> «${clinic}» first (${s.mcp.klinikker.map((k: any) => k.navn).join(", ")})`);
      assertTrue(s.pageFirst === clinic, `X9: /sok «${q}» -> «${clinic}» first`);
      assertTrue(s.a2a.first === clinic, `X10: A2A «${q}» -> «${clinic}» first`);
    }

    // ── R: rollback switch ────────────────────────────────────────────────
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    try {
      const r = await search({ query: EXAMPLE });
      assertTrue(r.count === 0 && r.tolkning === undefined, "R1: switched off -> MCP's old whole-text search (0), no tolkning");
      const old = ask(EXAMPLE);
      assertEq([old.names, old.metadata.tolkning], [ROGALAND_AKUTT, undefined], "R2: ... A2A's own keyword reading as before (fylke Rogaland + akutt), no tolkning");
      assertEq(a2a.parseIntent(EXAMPLE), { fylke: "Rogaland", acute_vakt: 1 }, "R3: ... its old reading of the example, its own list unchanged");
    } finally {
      delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    }
  } catch (err: any) {
    failed++;
    failures.push("dental search engelske fyllord: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalSearchEngelskeFyllordTests({ log: true }).then((r) => {
    console.log(`\ndental search engelske fyllord: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
