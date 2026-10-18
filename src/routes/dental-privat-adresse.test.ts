/**
 * dental-privat-adresse.test.ts — dev-request
 * 2026-10-18-dental-privat-adresse-skjules (Daniel's question 13).
 *
 * A sole proprietorship (organisasjonsform ENK) whose stored address has
 * «c/o» as a word of its own or «Bruksenhetsnummer» is registered at its
 * owner's home: Finn-tannlege shows that address on no public surface.
 * Postnummer and place stay. The rule sits in the A4-D funnel
 * (dental-places-display.ts) and does not depend on the Places switch.
 * Nothing stored changes. Fixture (in-memory dental DB, all in Oslo, every
 * name and address made up):
 *   E1  ENK, «c/o …, Bruksenhetsnummer …, <street>», a phone: hidden, indexable
 *   E2  ENK, «C/O …, <street>», nothing else: hidden, so thin (noindex)
 *   E3  ENK as « enk », «<street>, bruksenhetsnummer …» with a phone: hidden
 *   N1  ENK with an ordinary address: as stored
 *   N2  AS with a «c/o» address: as stored (only ENK is in Daniel's answer)
 *   N3  no organisasjonsform, «c/o …, Bruksenhetsnummer …»: as stored
 *   G   ENK, «c/o» address that only Google Places gives: hidden by both
 *       rules, and still hidden with the Places rule off
 *
 *   U   the rule (isPrivateEnkAddress): «c/o» as a word, «Bruksenhetsnummer»,
 *       any case; ENK only; words that only contain «c/o» do not count.
 *   D   the funnel: shownDentalAgent / shownDentalFieldProvenance (address
 *       and its provenance entries gone, the rest as stored, same object when
 *       nothing is hidden, the stored row unchanged, the Places verdicts as
 *       before, the Places switch off).
 *   H   the clinic page /klinikk/:slug: the visible address, Dentist
 *       description and PostalAddress.streetAddress; postnummer and place stay
 *       («Postnummer og sted»); E2 is thin (noindex + CTA).
 *   W   the web lists /sted, /fylke and /sok.
 *   M   MCP tannlege_search and tannlege_info.
 *   A   A2A message/send (org.nr and search).
 *   R   public REST /agents and /agents/:id (by id and org.nr); with
 *       X-Admin-Key the stored values and field_provenance.
 *   P   the provenance summary on public /agents/:id names no source of the
 *       hidden address; with X-Admin-Key as stored.
 *   S   the sitemap: E2 is left out, the other six stay.
 *   K   the Places switch off: every surface still hides the private
 *       address; public REST keeps field_provenance less its entries; the
 *       REST answers that show such a clinic are Cache-Control: private,
 *       Vary: Origin, X-Admin-Key, and the others as on main.
 *   N   no DB write: the stored rows are unchanged after every surface.
 *
 * Harness as dental-places-visning.test.ts (in-memory dental DB, MCP over a
 * real McpServer + client, routes through router.handle(), the REST headers
 * over HTTP behind the CORS layer).
 *
 * Standalone: npx tsx src/routes/dental-privat-adresse.test.ts
 * Wired into tests/test.ts via runDentalPrivatAdresseTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
  body: any;
}

function callRoute(
  router: any,
  path: string,
  opts: { query?: Record<string, string>; headers?: Record<string, string>; params?: Record<string, string> } = {}
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: path,
      originalUrl: path,
      path,
      params: opts.params ?? {},
      query: opts.query ?? {},
      headers: opts.headers ?? {},
      ip: "127.0.0.1",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      set() { return this; },
      vary() { return this; },
      once() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? ""), body: null }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload), body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled"), body: null }));
  });
}

const src = (source_type: string, value: string) => ({ source_type, value, fetched_at: "2026-09-02T10:00:00.000Z" });

function jsonLdNodes(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const v = JSON.parse(m[1]!);
    return Array.isArray(v) ? v : [v];
  });
}

/** GET over HTTP; the status and the two cache headers of the answer. */
function headersOf(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; cacheControl?: string; vary?: string }> {
  const http = require("http") as typeof import("http");
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers: { origin: "https://claude.ai", ...headers } }, (r) => {
      r.resume();
      r.on("end", () => resolve({ status: r.statusCode ?? 0, cacheControl: r.headers["cache-control"], vary: r.headers.vary }));
    }).on("error", reject);
  });
}

/** A clinic page without its «Flere tannleger i …» list (other clinics' cards). */
const ownPart = (html: string) => (html.includes("Flere tannleger i") ? html.slice(0, html.indexOf("Flere tannleger i")) : html);

export async function runDentalPrivatAdresseTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevAdminKey = process.env.ADMIN_KEY;
  process.env.DENTAL_DB_PATH = ":memory:";
  const adminKey = process.env.ADMIN_KEY || "dental-privat-adresse-test-key";
  process.env.ADMIN_KEY = adminKey;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("../services/dental-clinic-card"),
    require.resolve("./dental-seo"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental-a2a"),
    require.resolve("./dental"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const policy = require("../services/places-display-policy") as typeof import("../services/places-display-policy");
  const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
  const realLogWebSearch = analyticsService.logWebSearch;
  (analyticsService as any).logWebSearch = () => {};
  let closeMcp: (() => Promise<void>) | null = null;
  let closeHttp: (() => Promise<void>) | null = null;

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    (require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer")).__resetDentalSearchGazetteerForTesting();
    const display = require("../services/dental-places-display") as typeof import("../services/dental-places-display");
    const seo = require("./dental-seo") as typeof import("./dental-seo");
    const seoRouter = seo.default as any;
    const restRouter = (require("./dental") as typeof import("./dental")).default as any;
    const a2a = require("./dental-a2a") as typeof import("./dental-a2a");

    // ── U: the rule ───────────────────────────────────────────────────────
    {
      const enk = (adresse: string | null) => display.isPrivateEnkAddress({ organisasjonsform: "ENK", adresse });
      for (const adresse of [
        "c/o Ola Testmann, Prøvegata 1",
        "C/O OLA TESTMANN, PRØVEGATA 1",
        "Prøvegata 1 (c/o Ola Testmann)",
        "Prøvegata 1, c/o: Ola Testmann",
        "c/o",
        "Bruksenhetsnummer H0101, Prøvegata 1",
        "Prøvegata 1, BRUKSENHETSNUMMER h0101",
        "prøvegata 1 bruksenhetsnummer h0101",
      ]) {
        ok(enk(adresse), `U1: ENK, ${JSON.stringify(adresse)} -> private`);
      }
      for (const adresse of ["Prøvegata 1", "Abc/o-gata 1", "c/oslo 1", "Prøvegata 1 c/0 Ola", "co Ola Testmann, Prøvegata 1", "Bruksenhet H0101, Prøvegata 1", "", null]) {
        ok(!enk(adresse), `U2: ENK, ${JSON.stringify(adresse)} -> not private (no «c/o» word, no «Bruksenhetsnummer»)`);
      }
      const coAddress = "c/o Ola Testmann, Bruksenhetsnummer H0101, Prøvegata 1";
      for (const organisasjonsform of ["ENK", "enk", " ENK "]) {
        ok(display.isPrivateEnkAddress({ organisasjonsform, adresse: coAddress }), `U3: organisasjonsform ${JSON.stringify(organisasjonsform)} is ENK`);
      }
      for (const organisasjonsform of ["AS", "NUF", "ANS", "ENKX", "", null, undefined]) {
        ok(!display.isPrivateEnkAddress({ organisasjonsform, adresse: coAddress }), `U4: organisasjonsform ${JSON.stringify(organisasjonsform)} -> not private`);
      }
    }

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (row: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
      const id = store.createDentalAgent({ poststed: "OSLO", fylke: "Oslo", postnummer: "0150", ...row } as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", ...extra };
      const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
        .run({ ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, json(v)])), id });
      return id;
    };
    const E1 = {
      navn: "Tannlege Eksempelsen", org_nr: "918770001", organisasjonsform: "ENK", telefon: "+4722330011",
      adresse: "c/o Ola Testmann, Bruksenhetsnummer H0101, Prøvegata 11",
    };
    const provE1 = { address: [src("brreg", E1.adresse)], phone: [src("own_homepage", E1.telefon)] };
    const idE1 = add(E1, { field_provenance: provE1 });
    const E2 = { navn: "Tannlege Demosen", org_nr: "918770002", organisasjonsform: "ENK", adresse: "C/O KARI NORDTEST, Eksempelveien 22" };
    const idE2 = add(E2, { field_provenance: { adresse: [src("brreg", E2.adresse)] } });
    const E3 = { navn: "Tannlege Prøvesen", org_nr: "918770003", organisasjonsform: " enk ", telefon: "+4722330033", adresse: "Demoveien 33, bruksenhetsnummer h0302" };
    const idE3 = add(E3);
    const N1 = { navn: "Tannlege Vanligsen", org_nr: "918770004", organisasjonsform: "ENK", telefon: "+4722330044", adresse: "Vanliggata 44" };
    const idN1 = add(N1, { field_provenance: { address: [src("brreg", N1.adresse)] } });
    const N2 = { navn: "Testklinikken AS", org_nr: "918770005", organisasjonsform: "AS", telefon: "+4722330055", adresse: "c/o Regnskapstest AS, Kirkeveien 55" };
    const idN2 = add(N2, { field_provenance: { address: [src("brreg", N2.adresse)] } });
    const N3 = { navn: "Uformet Tann", org_nr: "918770006", telefon: "+4722330066", adresse: "c/o Per Prøvemann, Bruksenhetsnummer H0103, Ukjentveien 66" };
    const idN3 = add(N3);
    const G = { navn: "Tannlege Placesen", org_nr: "918770007", organisasjonsform: "ENK", telefon: "+4722330077", adresse: "c/o Liv Testdatter, Placesveien 77" };
    const idG = add(G, {
      field_provenance: {
        address: [{ source_type: "google_places", value: G.adresse, fetched_at: "2026-09-01T10:00:00.000Z" }],
        phone: [src("brreg", G.telefon)],
      },
    });
    const ids = [idE1, idE2, idE3, idN1, idN2, idN3, idG];
    const hiddenClinics = [E1, E2, E3, G];
    /** Words of the four private addresses (street, care-of name, unit). */
    const privateWords = ["Testmann", "H0101", "Prøvegata", "NORDTEST", "Eksempelveien", "Demoveien", "h0302", "Testdatter", "Placesveien"];
    const leaked = (text: string) => privateWords.filter((w) => text.includes(w));
    const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM dental_agents ORDER BY id").all());
    const before = snapshot();
    const row = (id: string) => store.getDentalAgentById(id)!;
    const profilePath = (c: { navn: string; org_nr: string }) => `/klinikk/${seo.slugifyClinic(c.navn, c.org_nr)}`;
    const page = async (c: { navn: string; org_nr: string }) => (await callRoute(seoRouter, profilePath(c))).text;
    const dentist = (html: string) => jsonLdNodes(html).find((n) => n["@type"] === "Dentist") ?? {};

    // ── D: the funnel ─────────────────────────────────────────────────────
    {
      const stored = row(idE1);
      const copy = JSON.stringify(stored);
      const shown = display.shownDentalAgent(stored);
      ok(shown !== stored && JSON.stringify(stored) === copy, "D1: E1 — shownDentalAgent copies; the stored row is not changed");
      eq([shown.adresse, shown.telefon, shown.postnummer, shown.poststed, shown.organisasjonsform], [null, E1.telefon, "0150", "OSLO", "ENK"],
        "D2: E1 — the address null; phone, postnummer, place and organisasjonsform as stored");
      eq(Object.keys(shown), Object.keys(stored), "D2b: ... the same keys in the same order");
      eq(display.dentalPlacesVerdicts(stored), { adresse: "shown", telefon: "shown", opening_hours: "shown", hjemmeside: "shown" },
        "D3: E1 — the Places verdicts are unchanged (a Brreg address is no Places value)");
      eq([display.shownDentalAgent(row(idE2)).adresse, display.shownDentalAgent(row(idE3)).adresse], [null, null], "D4: E2 and E3 — the address null");
      for (const [label, id] of [["N1", idN1], ["N2", idN2], ["N3", idN3]] as const) {
        const r = row(id);
        ok(display.shownDentalAgent(r) === r, `D5 ${label}: nothing hidden -> the same row object`);
        ok(display.shownDentalFieldProvenance(r) === r.field_provenance, `D5b ${label}: ... and field_provenance as stored`);
      }
      eq(display.shownDentalAgent(stored, false).adresse, null, "D6: the Places switch off -> E1's address is still hidden");
      eq(display.shownDentalFieldProvenance(stored), { phone: provE1.phone }, "D7: E1 — the address entries go, the phone's stay");
      eq(display.shownDentalFieldProvenance(stored, false), { phone: provE1.phone }, "D7b: ... with the Places switch off too");
      eq(stored.field_provenance, provE1, "D7c: ... and the stored value is not changed");
      eq(display.shownDentalFieldProvenance(row(idE2)), {}, "D7d: E2 — its column-named adresse entry goes too");
      const g = row(idG);
      eq(display.dentalPlacesVerdicts(g).adresse, "places_only", "D8: G — the Places rule hides its address");
      eq([display.shownDentalAgent(g).adresse, display.shownDentalAgent(g, false).adresse], [null, null],
        "D8b: G — hidden with the Places rule on, and still hidden with it off");
      eq(Object.keys(display.shownDentalFieldProvenance(g, false)!), ["phone"], "D8c: G — with the Places rule off its address entries go");
      const n2 = row(idN2);
      ok(display.shownDentalAgent(n2, false) === n2, "D9: N2 (AS, «c/o») with the Places switch off -> the same row object");
    }

    // ── H: the clinic page ────────────────────────────────────────────────
    const html = Object.fromEntries(await Promise.all([E1, E2, E3, N1, N2, N3, G].map(async (c) => [c.navn, await page(c)] as const)));
    {
      for (const c of hiddenClinics) {
        const h = html[c.navn]!;
        const own = ownPart(h);
        eq(leaked(h), [], `H1 ${c.navn}: no word of a private address anywhere on the page`);
        ok(!/c\/o/i.test(h) && !/bruksenhetsnummer/i.test(h), `H2 ${c.navn}: neither «c/o» nor «Bruksenhetsnummer» anywhere on the page`);
        ok(!own.includes('<div class="info-label">Adresse</div>'), `H3 ${c.navn}: no Adresse line`);
        ok(own.includes('<div class="info-label">Postnummer og sted</div><div class="info-value">0150 OSLO</div>'),
          `H4 ${c.navn}: «Postnummer og sted: 0150 OSLO» in Nøkkelinformasjon`);
        const ld = dentist(h);
        ok(!("streetAddress" in (ld.address ?? {})), `H5 ${c.navn}: no PostalAddress.streetAddress`);
        eq([ld.address?.postalCode, ld.address?.addressLocality], ["0150", "Oslo"], `H6 ${c.navn}: postalCode and addressLocality stay`);
        ok(typeof ld.description === "string" && !ld.description.includes("Adresse:"), `H7 ${c.navn}: Dentist.description has no Adresse sentence`);
      }
      for (const c of [E1, E3, G]) {
        ok(!html[c.navn]!.includes('content="noindex'), `H8 ${c.navn}: a phone is left -> still indexable`);
      }
      ok(html[E2.navn]!.includes('content="noindex,follow"') && html[E2.navn]!.includes("Ufullstendig oppføring"),
        "H9 E2: nothing left of address, phone, website and hours -> thin: noindex and the CTA");
      for (const c of [N1, N2, N3]) {
        const h = html[c.navn]!;
        const ld = dentist(h);
        ok(h.includes(`<div class="info-label">Adresse</div><div class="info-value">${c.adresse}, 0150 OSLO</div>`), `H10 ${c.navn}: the stored address on the Adresse line`);
        eq(ld.address?.streetAddress, c.adresse, `H11 ${c.navn}: PostalAddress.streetAddress as stored`);
        ok(String(ld.description).includes(`Adresse: ${c.adresse}, 0150 Oslo.`), `H12 ${c.navn}: Dentist.description has the address`);
        ok(!h.includes("Postnummer og sted") && !h.includes('content="noindex'), `H13 ${c.navn}: no «Postnummer og sted» line, indexable`);
      }
    }

    // ── W: web lists ──────────────────────────────────────────────────────
    for (const [path, query] of [["/sted/oslo"], ["/fylke/Oslo"], ["/sok", { q: "tann" }]] as Array<[string, Record<string, string>?]>) {
      const list = (await callRoute(seoRouter, path, { query })).text;
      ok(hiddenClinics.every((c) => list.includes(`>${c.navn}<`)), `W1 ${path}: the four clinics are listed`);
      eq(leaked(list), [], `W2 ${path}: no word of a private address on the page`);
    }

    // ── M: MCP ────────────────────────────────────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-privat-adresse-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-privat-adresse-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const tool = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
    const mcpSurfaces = async () => ({
      search: (await tool("tannlege_search", { fylke: "Oslo", limit: 25 })).klinikker as any[],
      info: Object.fromEntries(await Promise.all([E1, E2, E3, N1, N2, N3, G].map(async (c) => [c.navn, await tool("tannlege_info", { org_nr: c.org_nr })]))),
    });
    const mcpCheck = (m: { search: any[]; info: Record<string, any> }, tag: string) => {
      const byName = (navn: string) => m.search.find((k) => k.navn === navn) ?? {};
      for (const c of hiddenClinics) {
        const s = byName(c.navn);
        eq([s.adresse, s.postnummer, s.poststed], [null, "0150", "OSLO"], `M1${tag} tannlege_search ${c.navn}: address null, postnummer and place stay`);
        eq([m.info[c.navn].adresse, m.info[c.navn].postnummer], [null, "0150"], `M2${tag} tannlege_info ${c.navn}: address null, postnummer stays`);
      }
      eq(byName(E1.navn).telefon, E1.telefon, `M3${tag} tannlege_search E1: its phone stays`);
      for (const c of [N1, N2, N3]) {
        eq([byName(c.navn).adresse, m.info[c.navn].adresse], [c.adresse, c.adresse], `M4${tag} ${c.navn}: the stored address in both tools`);
      }
      eq(leaked(JSON.stringify(m)), [], `M5${tag}: no word of a private address in any MCP answer`);
    };
    const m = await mcpSurfaces();
    mcpCheck(m, "");

    // ── A: A2A ────────────────────────────────────────────────────────────
    const a2aSurfaces = () => {
      const info = (orgNr: string) =>
        (a2a.handleDentalMessageSend({ message: { text: `info om ${orgNr}` } }, "privat") as any).result.artifacts[0].parts[0].data;
      const list = (a2a.handleDentalMessageSend({ message: { data: { fylke: "Oslo" } } }, "privat") as any).result.artifacts[1].parts[0].data.clinics as any[];
      return { info: Object.fromEntries([E1, E2, E3, N1, N2, N3, G].map((c) => [c.navn, info(c.org_nr)])), list };
    };
    const a2aCheck = (a: { info: Record<string, any>; list: any[] }, tag: string) => {
      for (const c of hiddenClinics) {
        const fromList = a.list.find((x) => x.navn === c.navn) ?? {};
        eq([a.info[c.navn].adresse, fromList.adresse], [null, null], `A1${tag} ${c.navn}: address null (org.nr and search)`);
        eq([a.info[c.navn].postnummer, a.info[c.navn].poststed], ["0150", "OSLO"], `A2${tag} ${c.navn}: postnummer and place stay`);
      }
      eq(["field_provenance" in a.info[E1.navn], a.info[E1.navn].telefon], [false, E1.telefon], `A3${tag} E1: no field_provenance, its phone stays`);
      for (const c of [N1, N2, N3]) {
        eq([a.info[c.navn].adresse, a.list.find((x) => x.navn === c.navn)?.adresse], [c.adresse, c.adresse], `A4${tag} ${c.navn}: the stored address`);
      }
      eq(leaked(JSON.stringify(a)), [], `A5${tag}: no word of a private address in any A2A answer`);
    };
    a2aCheck(a2aSurfaces(), "");

    // ── R: REST ───────────────────────────────────────────────────────────
    const restSurfaces = async (headers?: Record<string, string>) => ({
      list: (await callRoute(restRouter, "/agents", { query: { fylke: "Oslo", limit: "50" }, headers })).body.agents as any[],
      one: Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await callRoute(restRouter, `/agents/${id}`, { params: { id }, headers })).body.agent]))),
      byOrgnr: (await callRoute(restRouter, `/agents/${E1.org_nr}`, { params: { id: E1.org_nr }, headers })).body.agent,
    });
    const restCheck = (r: { list: any[]; one: Record<string, any>; byOrgnr: any }, tag: string) => {
      for (const [label, list] of [["/agents", r.list], ["/agents/:id", Object.values(r.one)]] as const) {
        for (const [c, id] of [[E1, idE1], [E2, idE2], [E3, idE3], [G, idG]] as const) {
          const x = list.find((y: any) => y.id === id);
          eq([x.adresse, x.postnummer, x.poststed, x.organisasjonsform], [null, "0150", "OSLO", c.organisasjonsform], `R1${tag} ${label} ${c.navn}: address null, the rest as stored`);
        }
        for (const [c, id] of [[N1, idN1], [N2, idN2], [N3, idN3]] as const) {
          eq(list.find((y: any) => y.id === id).adresse, c.adresse, `R2${tag} ${label} ${c.navn}: the stored address`);
        }
        eq(leaked(JSON.stringify(list)), [], `R3${tag} ${label}: no word of a private address in the answer (field_provenance included)`);
      }
      ok(r.byOrgnr.id === idE1 && r.byOrgnr.adresse === null, `R4${tag}: /agents/<org.nr> E1 — address null`);
    };
    const restPublic = await restSurfaces();
    restCheck(restPublic, "");
    const restAdmin = await restSurfaces({ "x-admin-key": adminKey });
    {
      for (const [c, id] of [[E1, idE1], [E2, idE2], [G, idG]] as const) {
        eq(restAdmin.one[id].adresse, c.adresse, `R5: X-Admin-Key — ${c.navn}'s stored address`);
        eq(restAdmin.one[id].field_provenance, row(id).field_provenance, `R6: X-Admin-Key — ${c.navn}'s field_provenance as stored`);
      }
      eq(restAdmin.list.find((x: any) => x.id === idE3).adresse, E3.adresse, "R7: X-Admin-Key — /agents lists E3's stored address");
      const wrongKey = (await callRoute(restRouter, `/agents/${idE1}`, { params: { id: idE1 }, headers: { "x-admin-key": "wrong" } })).body.agent;
      eq(wrongKey.adresse, null, "R8: a wrong X-Admin-Key gets the public answer");
    }

    // ── P: the provenance summary on /agents/:id ──────────────────────────
    // Keyed by clinic, not id, so a failure reads the same on every run.
    const summaries = async (headers?: Record<string, string>) => Object.fromEntries(await Promise.all([["E1", idE1], ["N2", idN2]].map(async ([label, id]) => {
      const agent = (await callRoute(restRouter, `/agents/${id}`, { params: { id }, headers })).body.agent;
      return [label, "provenance" in agent ? agent.provenance.sources : "none"];
    })));
    const verified = new Map(ids.map((id) => [id, (db.prepare("SELECT last_verified_at FROM dental_agents WHERE id = ?").get(id) as any).last_verified_at]));
    for (const id of ids) db.prepare("UPDATE dental_agents SET last_verified_at = ? WHERE id = ?").run("2026-10-01T08:00:00.000Z", id);
    try {
      const pub = await summaries();
      const admin = await summaries({ "x-admin-key": adminKey });
      eq(admin.E1, ["brreg", "own_homepage"], "P1: X-Admin-Key — E1's summary as stored (its address from Brreg, its phone from its site)");
      eq(pub.E1, ["own_homepage"], "P2: public — E1's summary names only its shown phone's source");
      eq(pub.N2, admin.N2, "P3: public — N2 (AS) as stored");
      policy.__setPlacesDisplayPolicyForTesting(false);
      const off = await summaries();
      policy.__setPlacesDisplayPolicyForTesting(null);
      eq(off, pub, "P4: the Places switch off -> the same public summaries");
    } finally {
      policy.__setPlacesDisplayPolicyForTesting(null);
      for (const id of ids) db.prepare("UPDATE dental_agents SET last_verified_at = ? WHERE id = ?").run(verified.get(id), id);
    }

    // ── S: sitemap ────────────────────────────────────────────────────────
    const sitemapOrgnrs = () => store.getDentalAgentsForSitemap().map((r) => r.org_nr).sort();
    const allButE2 = [E1, E3, N1, N2, N3, G].map((c) => c.org_nr).sort();
    eq(sitemapOrgnrs(), allButE2, "S1: E2 (thin on the values it shows, noindex) is left out of the sitemap; the others stay");
    seo.__resetDentalSitemapCacheForTesting();
    {
      const xml = seo.getDentalSitemapXml();
      ok(!xml.includes(seo.slugifyClinic(E2.navn, E2.org_nr)) && xml.includes(seo.slugifyClinic(E1.navn, E1.org_nr)), "S2: sitemap.xml lists E1, not E2");
    }

    // The REST headers over HTTP, behind the CORS layer as in index.ts.
    const express = require("express") as typeof import("express");
    const cors = require("cors") as typeof import("cors");
    const { corsOptions } = require("../middleware/security") as typeof import("../middleware/security");
    const app = express();
    app.use(cors(corsOptions));
    app.use("/api/tannlege", restRouter);
    const httpServer = (require("http") as typeof import("http")).createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    closeHttp = () => new Promise<void>((resolve) => { httpServer.closeAllConnections?.(); httpServer.close(() => resolve()); });
    const port = (httpServer.address() as import("net").AddressInfo).port;
    const restHeaders = async (paths: Record<string, string>) => {
      const out: Record<string, unknown> = {};
      for (const [label, path] of Object.entries(paths)) {
        for (const [who, headers] of [["no key", {}], ["valid key", { "x-admin-key": adminKey }]] as const) {
          out[`${label}, ${who}`] = await headersOf(port, path, headers);
        }
      }
      return out;
    };
    const privateHeaders = { status: 200, cacheControl: "private", vary: "Origin, X-Admin-Key" };
    const withPrivate = {
      "/agents/:id E1": `/api/tannlege/agents/${idE1}`,
      "/agents/<org.nr> E1": `/api/tannlege/agents/${E1.org_nr}`,
      "/agents?fylke=Oslo": "/api/tannlege/agents?fylke=Oslo",
    };
    const withoutPrivate = { "/agents/:id N2": `/api/tannlege/agents/${idN2}`, "/agents?fylke=Viken (no clinic)": "/api/tannlege/agents?fylke=Viken" };
    for (const [label, h] of Object.entries(await restHeaders({ ...withPrivate, ...withoutPrivate }))) {
      eq(h, privateHeaders, `R9 ${label}: Places rule on -> Cache-Control: private, Vary: Origin, X-Admin-Key (as A4-S)`);
    }

    // ── K: the Places switch off ──────────────────────────────────────────
    policy.__setPlacesDisplayPolicyForTesting(false);
    try {
      for (const c of hiddenClinics) {
        const h = await page(c);
        eq(leaked(h), [], `K1 ${c.navn}: switch off -> still no word of a private address on the page`);
        ok(!("streetAddress" in (dentist(h).address ?? {})) && ownPart(h).includes('<div class="info-label">Postnummer og sted</div>'),
          `K2 ${c.navn}: ... no streetAddress, «Postnummer og sted» stays`);
      }
      ok((await page(N2)).includes(`<div class="info-value">${N2.adresse}, 0150 OSLO</div>`), "K3 N2: switch off -> the stored address as before");
      mcpCheck(await mcpSurfaces(), " (switch off)");
      a2aCheck(a2aSurfaces(), " (switch off)");
      const offPublic = await restSurfaces();
      restCheck(offPublic, " (switch off)");
      const offAdmin = await restSurfaces({ "x-admin-key": adminKey });
      eq(offPublic.one[idE1].field_provenance, { phone: provE1.phone }, "K4: switch off -> public E1 keeps field_provenance, less its address entries");
      eq(offPublic.one[idG].field_provenance, { phone: [src("brreg", G.telefon)] }, "K4b: ... G too (its Places address entry goes)");
      // Compared without printing the rows (their ids differ per run).
      const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
      for (const [label, id] of [["N1", idN1], ["N2", idN2], ["N3", idN3]] as const) {
        ok(same(offPublic.one[id], offAdmin.one[id]), `K5 ${label}: switch off -> the public answer is the stored one (as on main)`);
      }
      const others = (list: any[]) => list.filter((x) => ![idE1, idE2, idE3, idG].includes(x.id));
      ok(others(offPublic.list).length === 3 && same(others(offPublic.list), others(offAdmin.list)), "K5b: switch off -> /agents: every other clinic as stored");
      eq(sitemapOrgnrs(), allButE2, "K6: switch off -> E2 is still out of the sitemap");
      // The answer depends on X-Admin-Key only where it shows such a clinic.
      for (const [label, h] of Object.entries(await restHeaders(withPrivate))) {
        eq(h, privateHeaders, `K7 ${label}: switch off, a private address in the answer -> Cache-Control: private, Vary: Origin, X-Admin-Key`);
      }
      for (const [label, h] of Object.entries(await restHeaders(withoutPrivate))) {
        eq(h, { status: 200, vary: "Origin" }, `K8 ${label}: switch off, none in the answer -> no Cache-Control, Vary: Origin only (as on main)`);
      }
    } finally {
      policy.__setPlacesDisplayPolicyForTesting(null);
    }

    // ── N: no DB write ────────────────────────────────────────────────────
    eq(snapshot() === before, true, "N1: every stored row is unchanged after all surfaces were read");
  } catch (err: any) {
    failed++;
    failures.push("dental privat adresse: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    policy.__setPlacesDisplayPolicyForTesting(null);
    (analyticsService as any).logWebSearch = realLogWebSearch;
    if (closeMcp) await closeMcp().catch(() => {});
    if (closeHttp) await closeHttp().catch(() => {});
    try {
      (require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries")).__resetAiDeliveriesForTesting();
    } catch {
      // best-effort cleanup
    }
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
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
  console.log("── dental privat adresse (dev-request 2026-10-18-dental-privat-adresse-skjules) ──");
  runDentalPrivatAdresseTests({ log: true }).then((r) => {
    console.log(`\ndental privat adresse: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    // The /sok rate limiter keeps a timer; exit as the sibling suites do.
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
