/**
 * dental-acute-filter.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S2b).
 *
 * The public akutt filter lists only clinics whose card shows the akutt claim
 * («Akuttvakt» with a source, or «Tar imot akuttpasienter»), never the bare
 * acute_vakt flag. Against an in-memory fixture DB, by prefix:
 *   S   the SQL twin (DENTAL_ACUTE_CLAIM_SQL) picks exactly the rows where
 *       resolveAcuteClaim() is not null, over every shape of field_provenance
 *       and patient_focus (malformed JSON, top-level arrays, objects, strings,
 *       nested and non-text elements), and malformed JSON raises no error;
 *   P   parity on the named fixture (Vakt Med Kilde, Vakt Uten Kilde,
 *       akutt-fokus, …): the public list and count are the claim rows, and
 *       getDentalStats().acute_count is that count (D3a, dev-request
 *       2026-10-17-dental-d3-rettelser), row by row;
 *   M   MCP over a real server + client: tannlege_akutt (with and without
 *       fylke) and tannlege_search (`akutt`, a parsed «akuttvakt», akutt false)
 *       give only claim cards, every one badged, `count` the claim rows;
 *       tannlege_stats' acute_count is tannlege_akutt's count;
 *   W   /sok?akutt=1 and a parsed /sok query, and the same number as stats;
 *   A   A2A message/send: parsed text, the old keyword reading (switch-off
 *       path) and structured message.data; «statistikk» gives the same number;
 *   R   GET /api/tannlege/agents and the admin list/count keep the raw flag,
 *       and acute_vakt 0 stays the raw column; no row is written;
 *   T   timing on a 10,000-row fixture with live-like provenance sizes, for the
 *       filter and for getDentalStats().
 *
 * Standalone: npx tsx src/routes/dental-acute-filter.test.ts
 * Wired into tests/test.ts via runDentalAcuteFilterTests().
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

function callRoute(router: any, path: string, query: Record<string, string> = {}): Promise<{ status: number; text: string; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query, headers: {}, ip: "127.0.0.1", get() { return undefined; } };
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

const SOURCED = { acute_vakt: [{ source_type: "homepage", value: 1 }] };

export async function runDentalAcuteFilterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  const sorted = (xs: string[]) => [...xs].sort();

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
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  (analyticsService as any).logWebSearch = () => {};
  let closeMcp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const { resolveAcuteClaim, DENTAL_ACUTE_CLAIM_SQL } = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");

    // ── S: the SQL twin against resolveAcuteClaim, every JSON shape ───────
    {
      const provenances: Array<string | null> = [
        null, "", "{bad", "[]", '"homepage"', "{acute_vakt:[1]}", "{}", '{"telefon":[{"source_type":"brreg"}]}',
        '{"acute_vakt":null}', '{"acute_vakt":"homepage"}', '{"acute_vakt":1}', '{"acute_vakt":[]}', '{"acute_vakt":[null]}',
        JSON.stringify(SOURCED), '{"acute_vakt":{}}', '{"acute_vakt":{"sources":[]}}', '{"acute_vakt":{"sources":"x"}}',
        '{"acute_vakt":{"sources":{"a":1}}}', '{"acute_vakt":{"sources":[{"source_type":"stage_v_correction"}]}}',
        '[{"acute_vakt":[1]}]', '{"acute_vakt":[[]]}',
      ];
      const focuses: Array<string | null> = [
        null, "", "{bad", "[]", '["barn"]', '["Akutt"]', '["AKUTTPASIENTER"]', '["Tar imot akuttpasienter"]',
        '"akutt"', '{"akutt":true}', '{"merknad":"akutt"}', '[{"akutt":1}]', '[["akutt"]]', '[1,"akuttbehandling"]', '[null,"Barn"]', '["akut"]',
      ];
      const flags: Array<number | null> = [1, 0, null];
      const ins = db.prepare("INSERT INTO dental_agents (id, navn, acute_vakt, field_provenance, patient_focus) VALUES (?,?,?,?,?)");
      let i = 0;
      db.transaction(() => {
        for (const fp of provenances) for (const pf of focuses) for (const flag of flags) ins.run(`par-${i}`, `Par ${i++}`, flag, fp, pf);
      })();
      let sqlIds: string[] = [];
      let threw = "";
      try {
        sqlIds = (db.prepare(`SELECT id FROM dental_agents WHERE id LIKE 'par-%' AND ${DENTAL_ACUTE_CLAIM_SQL}`).all() as Array<{ id: string }>).map((r) => r.id);
      } catch (err: any) {
        threw = String(err?.message || err);
      }
      eq(threw, "", "S1: malformed JSON in either column raises no SQL error");
      const all = (db.prepare("SELECT id FROM dental_agents WHERE id LIKE 'par-%'").all() as Array<{ id: string }>).map((r) => r.id);
      const jsIds = all.filter((id) => resolveAcuteClaim(store.getDentalAgentById(id)!) !== null);
      ok(all.length === provenances.length * focuses.length * flags.length && jsIds.length > 0 && jsIds.length < all.length,
        `S0: (the shape table has ${all.length} rows, ${jsIds.length} with a claim)`);
      eq(sorted(sqlIds), sorted(jsIds), "S2: DENTAL_ACUTE_CLAIM_SQL picks exactly the rows where resolveAcuteClaim is not null");
      eq(store.countPublicDentalAgents({ acute_vakt: 1 }), jsIds.length, "S3: the public count for acute_vakt 1 goes through the same SQL");
      db.prepare("DELETE FROM dental_agents WHERE id LIKE 'par-%'").run();
    }

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (navn: string, org: string, extra: Record<string, unknown>, row: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ navn, org_nr: org, poststed: "BERGEN", fylke: "Vestland", postnummer: "5003", telefon: "55000000", ...row } as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", ...extra };
      const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
        .run({ ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, json(v)])), id });
      return id;
    };
    const vaktMedKilde = add("Vakt Med Kilde Tannklinikk AS", "918770001", { acute_vakt: 1, field_provenance: SOURCED });
    const vaktKildeObjekt = add("Vakt Med Kildeobjekt Tannklinikk AS", "918770002", { acute_vakt: 1, field_provenance: { acute_vakt: { sources: [{ source_type: "stage_v_correction" }] } } });
    const vaktUtenKilde = add("Vakt Uten Kilde Tannklinikk AS", "918770003", { acute_vakt: 1, field_provenance: { telefon: [{ source_type: "brreg" }] } });
    const vaktUtenKildeFokus = add("Vakt Uten Kilde Med Fokus Tannklinikk AS", "918770004", { acute_vakt: 1, patient_focus: ["Akutt", "barn"] });
    const fokusUtenFlagg = add("Akuttfokus Uten Flagg Tannklinikk AS", "918770005", { acute_vakt: 0, patient_focus: ["Tar imot akuttpasienter"] });
    const fokusFlaggNull = add("Akuttfokus Flagg Null Tannklinikk AS", "918770006", { patient_focus: ["AKUTT"] });
    const kildeFlagg0 = add("Kilde Uten Flagg Tannklinikk AS", "918770007", { acute_vakt: 0, field_provenance: SOURCED });
    const vanlig = add("Vanlig Tannklinikk AS", "918770008", {});
    const avvistVakt = add("Avvist Vakt Tannklinikk AS", "918770009", { acute_vakt: 1, field_provenance: SOURCED, verification_status: "rejected" });
    const nedlagtFokus = add("Nedlagt Fokus Tannklinikk AS", "918770010", { patient_focus: ["Akutt"], is_inactive: 1 });
    const osloVakt = add("Oslo Vakt Med Kilde AS", "918770011", { acute_vakt: 1, field_provenance: SOURCED }, { poststed: "OSLO", fylke: "Oslo", postnummer: "0150" });
    const osloUtenKilde = add("Oslo Vakt Uten Kilde AS", "918770012", { acute_vakt: 1 }, { poststed: "OSLO", fylke: "Oslo", postnummer: "0151" });
    // D3a: one more bare flag, so the public raw-flag count (7) differs from the claim count (6).
    const vaktUtenKildeTo = add("Vakt Uten Kilde To Tannklinikk AS", "918770013", { acute_vakt: 1 });
    const claimVestland = [vaktMedKilde, vaktKildeObjekt, vaktUtenKildeFokus, fokusUtenFlagg, fokusFlaggNull];
    const claimAll = [...claimVestland, osloVakt];
    const rawFlag = [vaktMedKilde, vaktKildeObjekt, vaktUtenKilde, vaktUtenKildeFokus, avvistVakt, osloVakt, osloUtenKilde, vaktUtenKildeTo];
    const nameOf = new Map<string, string>(
      (db.prepare("SELECT id, navn FROM dental_agents").all() as Array<{ id: string; navn: string }>).map((r) => [r.id, r.navn])
    );
    const names = (ids: string[]) => sorted(ids.map((id) => nameOf.get(id)!));
    const columnSnapshot = () => JSON.stringify(db.prepare("SELECT id, acute_vakt, field_provenance, patient_focus FROM dental_agents ORDER BY id").all());
    const before = columnSnapshot();
    void vanlig; void kildeFlagg0; void nedlagtFokus;

    // ── P: the named fixture: the public akutt rows are the claim rows ─────
    {
      const pubIds = (f: Record<string, unknown>) => store.listPublicDentalAgents(f as any, 500, 0).map((a) => a.id);
      const publicRows = store.listPublicDentalAgents({}, 500, 0);
      eq(sorted(pubIds({ acute_vakt: 1 })), sorted(publicRows.filter((a) => resolveAcuteClaim(a) !== null).map((a) => a.id)),
        "P1: listPublicDentalAgents({acute_vakt: 1}) == the public rows where resolveAcuteClaim is not null");
      eq(sorted(pubIds({ acute_vakt: 1 })), sorted(claimAll), "P2: ... which are the sourced duties and the akutt-focus clinics, flagged or not");
      eq(store.countPublicDentalAgents({ acute_vakt: 1 }), claimAll.length, "P3: countPublicDentalAgents agrees");
      eq(sorted(pubIds({ acute_vakt: 1, fylke: "Vestland" })), sorted(claimVestland), "P4: combined with fylke");
      ok(![vaktUtenKilde, osloUtenKilde, vaktUtenKildeTo].some((id) => pubIds({ acute_vakt: 1 }).includes(id)), "P5: a flag without a source and no akutt focus is not listed");
      ok(!pubIds({ acute_vakt: 1 }).includes(avvistVakt) && !pubIds({ acute_vakt: 1 }).includes(nedlagtFokus), "P6: rejected and closed clinics stay out");
      const nat = { natural: { parsed: { acute_vakt: 1, poststed_in: ["BERGEN"] }, legacy: { acute_vakt: 1, fylke: "Vestland" } } };
      eq(sorted(pubIds(nat)), sorted(claimVestland), "P7: both branches of `natural` (parsed, and A2A's keyword reading) use the claim");
    }

    // ── P8–P9: getDentalStats().acute_count is the public akutt count (D3a) ─
    {
      const stats = store.getDentalStats();
      eq([stats.acute_count, store.countPublicDentalAgents({ acute_vakt: 1 })], [claimAll.length, claimAll.length],
        "P8: getDentalStats().acute_count === countPublicDentalAgents({acute_vakt: 1}), the claim rows");
      const publicRawFlags = (db.prepare(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE acute_vakt = 1 AND verification_status != 'rejected' AND (is_inactive IS NULL OR is_inactive = 0)"
      ).get() as { n: number }).n;
      ok(publicRawFlags !== claimAll.length,
        `P8b: (the fixture has ${publicRawFlags} public raw flags and ${claimAll.length} claims, so P8, M11, W4 and A5 tell them apart)`);
      // Each kind of row is also added on its own: the count must move by exactly what its card shows.
      const delta = (navn: string, org: string, extra: Record<string, unknown>): number => {
        const before = store.getDentalStats().acute_count;
        const id = add(navn, org, extra);
        try {
          return store.getDentalStats().acute_count - before;
        } finally {
          db.prepare("DELETE FROM dental_agents WHERE id = ?").run(id);
        }
      };
      eq(delta("Ny Vakt Uten Kilde AS", "918770101", { acute_vakt: 1 }), 0, "P9a: a flag without a source is not counted");
      eq(delta("Ny Vakt Annen Kilde AS", "918770102", { acute_vakt: 1, field_provenance: { telefon: [{ source_type: "brreg" }] } }), 0,
        "P9b: a flag whose provenance is for another field is not counted");
      eq(delta("Ny Avvist Vakt AS", "918770103", { acute_vakt: 1, field_provenance: SOURCED, verification_status: "rejected" }), 0,
        "P9c: a rejected clinic with a sourced duty is not counted");
      eq(delta("Ny Nedlagt Vakt AS", "918770104", { acute_vakt: 1, field_provenance: SOURCED, is_inactive: 1 }), 0,
        "P9d: a closed clinic with a sourced duty is not counted");
      eq(delta("Ny Lab Vakt AS", "918770105", { acute_vakt: 1, field_provenance: SOURCED, catalog_class: "lab_leverandor" }), 0,
        "P9e: a non-clinic with a sourced duty is not counted");
      eq(delta("Ny Akuttfokus Uten Flagg AS", "918770106", { acute_vakt: 0, patient_focus: ["Akutt"] }), 1,
        "P9f: akutt in patient_focus without the flag is counted («Tar imot akuttpasienter»)");
      eq(delta("Ny Vakt Med Kilde AS", "918770107", { acute_vakt: 1, field_provenance: SOURCED }), 1, "P9g: a sourced duty is counted");
      eq(store.getDentalStats().total, store.countPublicDentalAgents({}), "P9h: `total` is still the honest public count");
    }

    // ── M: MCP over a real server + client ────────────────────────────────
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-acute-filter-test", version: "0.0.0" });
    mcp.registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-acute-filter-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(String(((await client.callTool({ name, arguments: args })) as any).content[0].text));
    const cardNames = (r: any) => sorted(r.klinikker.map((k: any) => k.navn));
    const allBadged = (r: any) =>
      r.klinikker.length > 0 && r.klinikker.every((k: any) =>
        (k.akutt === "vakt" && k.badges.includes("Akuttvakt")) || (k.akutt === "accepts" && k.badges.includes("Tar imot akuttpasienter")));
    {
      const r = await call("tannlege_akutt", { fylke: "Vestland" });
      eq(cardNames(r), names(claimVestland), "M1: tannlege_akutt {fylke: Vestland} lists exactly the claim clinics");
      eq(r.count, claimVestland.length, "M2: ... and `count` is their number");
      ok(allBadged(r), "M3: every card has akutt «vakt» with the Akuttvakt badge or «accepts» with «Tar imot akuttpasienter»");
      const all = await call("tannlege_akutt", {});
      eq([cardNames(all), all.count], [names(claimAll), claimAll.length], "M4: tannlege_akutt without fylke: the claim clinics in every county");
    }
    {
      const r = await call("tannlege_search", { akutt: true, fylke: "Vestland", limit: 25 });
      eq([cardNames(r), r.count], [names(claimVestland), claimVestland.length], "M5: tannlege_search {akutt: true}: the same claim clinics");
      ok(allBadged(r), "M6: ... every one badged");
      const parsed = await call("tannlege_search", { query: "akuttvakt tannlege Bergen", limit: 25 });
      eq([cardNames(parsed), parsed.count], [names(claimVestland), claimVestland.length], "M7: a parsed «akuttvakt tannlege Bergen»: the claim clinics in Bergen");
      ok(allBadged(parsed) && parsed.tolkning.tolket_som.includes("akutt: ja"), "M8: ... badged, and tolkning says akutt");
      const off = await call("tannlege_search", { query: "akuttvakt tannlege Bergen", akutt: false, limit: 25 });
      ok(off.klinikker.some((k: any) => k.navn === "Vakt Uten Kilde Tannklinikk AS" && k.akutt === null), "M9: akutt false drops the parsed akutt filter (an unbadged clinic is listed again)");
      const plain = await call("tannlege_search", { fylke: "Vestland", limit: 25 });
      ok(plain.count > claimVestland.length, "M10: without akutt the filter does not apply");
    }
    let mcpAcuteCount = -1;
    let mcpAkuttCount = -1;
    {
      const stats = await call("tannlege_stats", {});
      const akutt = await call("tannlege_akutt", {});
      mcpAcuteCount = stats.acute_count;
      mcpAkuttCount = akutt.count;
      eq([stats.acute_count, akutt.count], [claimAll.length, claimAll.length], "M11: tannlege_stats acute_count === tannlege_akutt {}.count");
      const why = String(stats._forklaring?.acute_count ?? "");
      ok(why.includes("«Akuttvakt» (med kilde)") && why.includes("«Tar imot akuttpasienter»") && why.includes("tannlege_akutt.count") &&
        why.includes("/sok?akutt=1") && !/akuttvakt-tilbud/.test(why), `M12: _forklaring.acute_count names the claim and the shared number («${why}»)`);
    }

    // ── W: /sok ───────────────────────────────────────────────────────────
    {
      const seoRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as any;
      const shown = (html: string) => sorted([...nameOf.values()].filter((n) => html.includes(`>${n}<`)));
      const page = await callRoute(seoRouter, "/sok", { akutt: "1", fylke: "Vestland" });
      eq(shown(page.text), names(claimVestland), "W1: /sok?akutt=1&fylke=Vestland shows exactly the claim clinics");
      ok(page.text.includes(`${claimVestland.length} klinikker funnet`), "W2: ... and counts them");
      const parsed = await callRoute(seoRouter, "/sok", { q: "akutt tannlege Bergen" });
      eq(shown(parsed.text), names(claimVestland), "W3: /sok?q=akutt tannlege Bergen (parsed) shows the same clinics");
      const all = await callRoute(seoRouter, "/sok", { akutt: "1" });
      ok(mcpAcuteCount === claimAll.length && all.text.includes(`${mcpAcuteCount} klinikker funnet`),
        `W4: /sok?akutt=1 counts the same number as tannlege_stats acute_count (${mcpAcuteCount})`);
    }

    // ── A: A2A message/send ───────────────────────────────────────────────
    {
      const a2a = require("./dental-a2a") as typeof import("./dental-a2a");
      const ask = (message: Record<string, unknown>) => {
        const resp = a2a.handleDentalMessageSend({ message }, "s2b") as any;
        return sorted((resp.result.artifacts[1].parts[0].data.clinics as any[]).map((c) => c.id));
      };
      eq(ask({ text: "akuttvakt tannlege Bergen" }), sorted(claimVestland), "A1: text «akuttvakt tannlege Bergen»: the claim clinics");
      eq(ask({ data: { acute_vakt: 1, fylke: "Vestland" } }), sorted(claimVestland), "A2: structured message.data {acute_vakt: 1}: the claim clinics");
      eq(ask({ text: "akutt Vestland" }), sorted(claimVestland), "A3: «akutt Vestland» (parsed fylke, and the old keyword reading in the legacy branch)");
      process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
      try {
        eq(ask({ text: "akutt Vestland" }), sorted(claimVestland), "A4: parser switched off: the old keyword parser's akutt is the claim too");
      } finally {
        delete process.env.DENTAL_QUERY_PARSER_DISABLED;
      }
      const stats = (a2a.handleDentalMessageSend({ message: { text: "statistikk" } }, "d3a") as any).result;
      eq([stats.metadata?.skill, stats.artifacts[0].parts[0].data.acute_count], ["tannlege_stats", mcpAkuttCount],
        "A5: A2A «statistikk» gives tannlege_akutt's count as acute_count");
    }

    // ── R: the raw flag stays for admin and enrichment ────────────────────
    {
      const route = (require("./dental") as typeof import("./dental")).default as any;
      const r = await callRoute(route, "/agents", { acute_vakt: "1", limit: "500" });
      eq(sorted(r.body.agents.map((a: any) => a.id)), sorted(rawFlag), "R1: GET /api/tannlege/agents?acute_vakt=1 still lists every row with the raw flag");
      eq(sorted(store.listDentalAgents({ acute_vakt: 1 }, 500, 0).map((a) => a.id)), sorted(rawFlag), "R2: listDentalAgents (admin) keeps the raw flag");
      eq(store.countDentalAgents({ acute_vakt: 1 }), rawFlag.length, "R3: countDentalAgents (admin) keeps the raw flag");
      eq(sorted(store.listPublicDentalAgents({ acute_vakt: 0 }, 500, 0).map((a) => a.id)), sorted([fokusUtenFlagg, kildeFlagg0]),
        "R4: a public acute_vakt 0 stays the raw column");
      eq(columnSnapshot(), before, "R5: no acute_vakt, field_provenance or patient_focus value was written");
    }

    // ── T: timing on 10,000 rows ──────────────────────────────────────────
    {
      dbFactory.__resetDbFactoryForTesting();
      const big = dbFactory.getDb("dental");
      // Live-like (finn-tannlege /api/tannlege/agents, 6 974 rows, 2026-10-17): 10 % flagged
      // acute_vakt = 1, half the rows with a field_provenance (median ~110 B, p95 ~3 KB), and
      // 16 % with a patient_focus array. Here every flagged row carries a 3 KB provenance.
      const filler = "x".repeat(3000);
      const ins = big.prepare("INSERT INTO dental_agents (id, navn, poststed, fylke, acute_vakt, field_provenance, patient_focus) VALUES (?,?,?,?,?,?,?)");
      const fylker = ["Oslo", "Vestland", "Rogaland", "Trøndelag", "Troms"];
      big.transaction(() => {
        for (let i = 0; i < 10_000; i++) {
          const flagged = i % 10 === 0;
          const prov = flagged
            ? JSON.stringify({ ...(i % 20 === 0 ? SOURCED : {}), om_oss: [{ source_type: "homepage", note: filler }] })
            : i % 2 ? JSON.stringify({ telefon: [{ source_type: "brreg" }] }) : null;
          const focus = i % 6 === 0 ? JSON.stringify(i % 12 === 0 ? ["Akutt", "barn"] : ["barn", "eldre"]) : null;
          ins.run(`perf-${i}`, `Klinikk ${i} Tannhelse`, "OSLO", fylker[i % fylker.length], flagged ? 1 : 0, prov, focus);
        }
      })();
      const timed = (fn: () => unknown) => {
        let best = Infinity;
        for (let r = 0; r < 7; r++) {
          const t = process.hrtime.bigint();
          fn();
          best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
        }
        return best;
      };
      // As dental-store-search.test.ts T: 20 ms, or 3x the old whole-text q scan where the machine is slower.
      const baseline = timed(() => store.countPublicDentalAgents({ q: "solo tannlege" }));
      const budget = Math.max(20, 3 * baseline);
      for (const [label, f] of [["akutt", { acute_vakt: 1 }], ["akutt + fylke", { acute_vakt: 1, fylke: "Vestland" }]] as const) {
        const c = timed(() => store.countPublicDentalAgents(f as any));
        const l = timed(() => store.listPublicDentalAgents(f as any, 25, 0));
        if (log) console.log(`    ${label}: count ${c.toFixed(1)} ms, list ${l.toFixed(1)} ms (budget ${budget.toFixed(1)} ms)`);
        // Stable label (no measured numbers): the CI determinism gate compares failure texts across runs.
        ok(c < budget && l < budget, `T1: ${label}: count and list each within budget on 10,000 rows (best of 7)`);
      }
      // D3a: getDentalStats() reads the claim too, on the synchronous stats fill behind the 60 s cache.
      // Its six aggregates over the same rows (one of them the claim count in T1) stay within two budgets.
      const s = timed(() => store.getDentalStats());
      if (log) console.log(`    getDentalStats: ${s.toFixed(1)} ms (budget ${(2 * budget).toFixed(1)} ms)`);
      ok(s < 2 * budget, "T2: getDentalStats() within two count budgets on 10,000 rows (best of 7)");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental acute filter: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalAcuteFilterTests({ log: true }).then((r) => {
    console.log(`\ndental acute filter: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
