/**
 * dental-places-visning.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt,
 * slice A4-D (Daniel's question 21 = A, 2026-10-18T17:01Z: websites from
 * Places hidden too; map, coordinates and postnummer stay).
 *
 * Finn-tannlege shows no stored address, phone, website or opening hours that
 * only Google Places gives (an exact google_places provenance record and no
 * other source with the same value), and none that is marked wrong (a pending
 * Stage V correction of the hours), on any public surface. Nothing stored
 * changes. Fixture (in-memory dental DB, all in Oslo):
 *   A  Kun Places Tann    address, phone, website, hours: all Places only
 *   B  Delvis Places Tann phone, website, hours Places only; the address Brreg
 *                         gives (Places' own record of it differs) stays
 *   C  Bekreftet Tann     all four from Places AND another source (B1)
 *   D  Feilmerket Tann    hours from the site with a pending Stage V
 *                         correction; a Brreg-format phone Places only repeated
 *
 *   D1-D6  the dental adapter (dental-places-display.ts): verdicts, provenance
 *          key aliases, the pending map, same object / no mutation.
 *   H      the clinic page /klinikk/:slug (HTML, JSON-LD, meta description):
 *          hidden fields gone, postnummer, place, map and geo kept; A is thin
 *          (noindex + CTA).
 *   W      the web cards on /sted, /fylke, /sok and the related list.
 *   M      MCP tannlege_search, tannlege_akutt, tannlege_info.
 *   A      A2A message/send (org.nr and search), the row's own fields too.
 *   R      public REST /agents and /agents/:id (no field_provenance, no pending
 *          map); with X-Admin-Key the stored values and field_provenance.
 *   S      the sitemap: A is left out (its page is noindex).
 *   B      B1: C, and every shown field, as with the rule off.
 *   K      kill switch off: every surface as on main (= the same clinic with
 *          its google_places records removed, and REST as the admin answer).
 *   T      texts: /proveniens (no + en) and the A2A agent card.
 *   N      no DB write: the stored rows are unchanged after every surface.
 *
 * Harness as dental-clinic-card.test.ts and dental-search-regionord.test.ts
 * (in-memory dental DB, MCP over a real McpServer + client, routes through
 * router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-places-visning.test.ts
 * Wired into tests/test.ts via runDentalPlacesVisningTests().
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
      once() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? ""), body: null }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload), body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled"), body: null }));
  });
}

const gp = (value: string) => ({ source_type: "google_places", value, fetched_at: "2026-09-01T10:00:00.000Z" });
const src = (source_type: string, value: string) => ({ source_type, value, fetched_at: "2026-09-02T10:00:00.000Z" });
const MON_TUE = [{ day: "mon", open: "08:00", close: "16:00" }, { day: "tue", open: "08:00", close: "16:00" }];
const ALL_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({ day, open: "07:00", close: "21:00" }));

/** The open-now badges depend on the clock; masked where two renders are compared. */
const maskClock = (html: string) => html.replace(/<span class="badge badge-(?:open|closed)"[^>]*>[\s\S]*?<\/span>/g, "");

function jsonLdNodes(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const v = JSON.parse(m[1]!);
    return Array.isArray(v) ? v : [v];
  });
}

/** A clinic page without its «Flere tannleger i …» list (other clinics' cards). */
const ownPart = (html: string) => (html.includes("Flere tannleger i") ? html.slice(0, html.indexOf("Flere tannleger i")) : html);

/** The <article class="clinic-card"> that names `navn`, or "". */
function cardOf(html: string, navn: string): string {
  return html.split('<article class="clinic-card">').slice(1).find((c) => c.includes(`>${navn}<`)) ?? "";
}

export async function runDentalPlacesVisningTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const adminKey = process.env.ADMIN_KEY || "dental-places-visning-test-key";
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
    const { getDentalAgentCard } = require("../services/dental-agent-card") as typeof import("../services/dental-agent-card");

    // ── Fixture ───────────────────────────────────────────────────────────
    const add = (row: Record<string, unknown>, extra: Record<string, unknown>): string => {
      const id = store.createDentalAgent({ poststed: "OSLO", fylke: "Oslo", postnummer: "0150", ...row } as any);
      const cols: Record<string, unknown> = { catalog_class: "klinikk", lat: 59.9133, lng: 10.7389, geocode_source: "kartverket", ...extra };
      const json = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
      db.prepare(`UPDATE dental_agents SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
        .run({ ...Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, json(v)])), id });
      return id;
    };
    const A = {
      navn: "Kun Places Tann AS", org_nr: "918760001",
      telefon: "+4722110011", adresse: "Storgata 1, 0150 Oslo, Norge", hjemmeside: "https://www.kunplaces.example.no/",
    };
    const idA = add(A, {
      opening_hours: MON_TUE,
      field_provenance: {
        phone: [gp(A.telefon)], address: [gp(A.adresse)], website: [gp(A.hjemmeside)], opening_hours: [gp(JSON.stringify(MON_TUE))],
      },
    });
    const B = {
      navn: "Delvis Places Tann AS", org_nr: "918760002", telefon: "+4722110022", adresse: "Kirkegata 2",
      hjemmeside: "https://www.delvisplaces.example.no/", epost: "post@delvisplaces.example.no", helfo_agreement: "true",
    };
    const idB = add(B, {
      opening_hours: ALL_WEEK,
      acute_vakt: 1,
      field_provenance: {
        phone: [gp(B.telefon)],
        address: [src("brreg", "Kirkegata 2"), gp("Kirkegata 2, 0153 Oslo, Norge")],
        website: [gp(B.hjemmeside)],
        opening_hours: [gp(JSON.stringify(ALL_WEEK))],
        acute_vakt: [src("own_homepage", "1")],
      },
    });
    const C = {
      navn: "Bekreftet Tann AS", org_nr: "918760003", telefon: "+4722110033", adresse: "Torggata 3, 0181 Oslo, Norge",
      hjemmeside: "https://www.bekreftet.example.no/",
    };
    const provC = {
      phone: [gp(C.telefon), src("homepage", "22 11 00 33")],
      address: [gp(C.adresse), src("brreg", "Torggata 3")],
      website: [gp(C.hjemmeside), src("brreg_registered_website", "http://bekreftet.example.no")],
      opening_hours: [gp(JSON.stringify(MON_TUE)), src("own_homepage", JSON.stringify([...MON_TUE].reverse()))],
    };
    const idC = add(C, { opening_hours: MON_TUE, field_provenance: provC });
    const D = { navn: "Feilmerket Tann AS", org_nr: "918760004", telefon: "22 11 00 44", adresse: "Pilestredet 4" };
    const idD = add(D, {
      opening_hours: MON_TUE,
      field_provenance: { phone: [gp("+4722110044")], opening_hours: [src("own_homepage", JSON.stringify(MON_TUE))] },
      stage_v_pending_correction: { opening_hours: { value: JSON.stringify([MON_TUE[0]]), observed_at: "2026-10-10T08:00:00.000Z" } },
    });
    const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM dental_agents ORDER BY id").all());
    const before = snapshot();
    const row = (id: string) => store.getDentalAgentById(id)!;
    const profilePath = (navn: string, orgNr: string) => `/klinikk/${seo.slugifyClinic(navn, orgNr)}`;
    const page = async (c: { navn: string; org_nr: string }) => (await callRoute(seoRouter, profilePath(c.navn, c.org_nr))).text;

    // ── D: the dental adapter ─────────────────────────────────────────────
    eq(display.dentalPlacesVerdicts(row(idA)), { adresse: "places_only", telefon: "places_only", opening_hours: "places_only", hjemmeside: "places_only" },
      "D1: A — all four Places only");
    eq(display.dentalPlacesVerdicts(row(idB)), { adresse: "shown", telefon: "places_only", opening_hours: "places_only", hjemmeside: "places_only" },
      "D2: B — the Brreg address stays (Places' own, different record is no evidence)");
    eq(display.dentalPlacesVerdicts(row(idC)), { adresse: "shown", telefon: "shown", opening_hours: "shown", hjemmeside: "shown" }, "D3: C — all corroborated");
    eq(display.dentalPlacesVerdicts(row(idD)), { adresse: "shown", telefon: "shown", opening_hours: "marked_wrong", hjemmeside: "shown" },
      "D4: D — pending Stage V correction hides the hours; a Brreg-format phone Places only repeated stays");
    {
      const aliased = { ...row(idA), field_provenance: { telefon: [gp(A.telefon)], adresse: [gp(A.adresse)], hjemmeside: gp(A.hjemmeside) } };
      eq([display.dentalPlacesVerdicts(aliased).telefon, display.dentalPlacesVerdicts(aliased).adresse, display.dentalPlacesVerdicts(aliased).hjemmeside],
        ["places_only", "places_only", "places_only"], "D5: the column-named provenance keys (telefon, adresse, hjemmeside) are read too");
      const stored = row(idA);
      const copy = JSON.stringify(stored);
      const shown = display.shownDentalAgent(stored);
      ok(shown !== stored && JSON.stringify(stored) === copy, "D6: shownDentalAgent copies; the stored row is not changed");
      eq([shown.adresse, shown.telefon, shown.hjemmeside, shown.opening_hours, shown.mobil, shown.postnummer, shown.lat], [null, null, null, null, null, "0150", 59.9133],
        "D6b: ... the four hidden, postnummer and coordinates kept");
      const storedC = row(idC);
      ok(display.shownDentalAgent(storedC) === storedC, "D6c: nothing hidden -> the same row object");
      const pendingAsText = { ...row(idD), stage_v_pending_correction: JSON.stringify({ opening_hours: { value: "[]", observed_at: "x" } }) };
      eq(display.dentalPlacesVerdicts(pendingAsText).opening_hours, "marked_wrong", "D6d: the pending map as stored text is read");
      for (const pending of [null, "not json", { treatments: { value: "[]", observed_at: "x" } }, { opening_hours: null }, ["opening_hours"]]) {
        eq(display.dentalPlacesVerdicts({ ...row(idD), stage_v_pending_correction: pending }).opening_hours, "shown",
          `D6e: pending ${JSON.stringify(pending)} -> the hours stay`);
      }
    }

    // ── H: the clinic page ────────────────────────────────────────────────
    const htmlA = await page(A);
    const htmlB = await page(B);
    const htmlC = await page(C);
    const htmlD = await page(D);
    const dentist = (html: string) => jsonLdNodes(html).find((n) => n["@type"] === "Dentist") ?? {};
    const metaDescription = (html: string) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] ?? "";
    {
      for (const [label, page, c] of [["A", htmlA, A], ["B", htmlB, B]] as const) {
        // The «Flere tannleger i Oslo» cards are other clinics' (W4 checks B's card there).
        const html = ownPart(page);
        ok(!html.includes("tel:") && !page.includes(c.telefon) && !html.includes("Ring "), `H1 ${label}: no phone, no tel: link, no «Ring» button`);
        ok(!page.includes(new URL(c.hjemmeside).host), `H2 ${label}: the Places website is nowhere on the page (link, text, sameAs)`);
        ok(!html.includes("<h2>Åpningstider</h2>") && !html.includes("Åpent nå") && !html.includes("Stengt nå"), `H3 ${label}: no opening hours section or open-now badge`);
        const ld = dentist(html);
        eq(["telephone", "sameAs", "openingHoursSpecification"].filter((k) => k in ld), [], `H4 ${label}: JSON-LD Dentist has no telephone, sameAs or openingHoursSpecification`);
        eq([ld.address?.postalCode, ld.address?.addressLocality, ld.geo?.latitude, ld.geo?.longitude], ["0150", "Oslo", 59.9133, 10.7389],
          `H5 ${label}: postnummer, place and coordinates stay in JSON-LD`);
        ok(html.includes("https://www.google.com/maps/search/?api=1&query=59.9133,10.7389"), `H6 ${label}: the map link stays`);
        ok(!/Åpent \d+ dag/.test(page), `H7 ${label}: no «Åpent N dager i uken» in the descriptions`);
      }
      ok(!htmlA.includes("Storgata 1") && !ownPart(htmlA).includes(">Adresse<") && !("streetAddress" in (dentist(htmlA).address ?? {})), "H8 A: no address (page, JSON-LD, description)");
      ok(htmlA.includes('content="noindex,follow"') && htmlA.includes("Ufullstendig oppføring"), "H9 A: nothing left of the four -> thin profile: noindex and the CTA");
      ok(htmlB.includes(">Adresse<") && htmlB.includes("Kirkegata 2") && dentist(htmlB).address?.streetAddress === "Kirkegata 2", "H10 B: the Brreg address is shown (page and JSON-LD)");
      ok(metaDescription(htmlB) !== "" && !htmlB.includes('content="noindex'), "H11 B: still indexable, with a meta description");
      ok(htmlB.includes("post@delvisplaces.example.no") && htmlB.includes("Akuttvakt"), "H12 B: the other fields stay (e-mail, Akuttvakt)");
      const ldC = dentist(htmlC);
      eq([ldC.telephone, ldC.sameAs, ldC.address?.streetAddress, ldC.openingHoursSpecification?.length], [C.telefon, C.hjemmeside, C.adresse, 2],
        "H13 C: corroborated -> phone, website, address and hours in JSON-LD");
      ok(ownPart(htmlC).includes(`tel:${C.telefon}`) && htmlC.includes("<h2>Åpningstider</h2>") && htmlC.includes(">Hjemmeside<"), "H14 C: ... and on the page");
      ok(!htmlD.includes("<h2>Åpningstider</h2>") && !("openingHoursSpecification" in dentist(htmlD)) && !/Åpent \d+ dag/.test(htmlD), "H15 D: hours marked wrong are not shown");
      ok(htmlD.includes("tel:22110044") && htmlD.includes("Pilestredet 4"), "H16 D: its Brreg-format phone and its address are shown");
    }

    // ── W: web cards ──────────────────────────────────────────────────────
    {
      const lists: Array<[string, string, Record<string, string>?]> = [["/sted/oslo", "/sted/:stedSlug"], ["/fylke/Oslo", "/fylke/:fylke"], ["/sok", "/sok", { q: "tann" }]];
      for (const [path, , query] of lists) {
        const html = (await callRoute(seoRouter, path, { query })).text;
        for (const [label, c] of [["A", A], ["B", B]] as const) {
          const card = cardOf(html, c.navn);
          ok(card !== "" && !card.includes("tel:") && !card.includes("Åpent nå") && !card.includes("Stengt nå"), `W1 ${path} ${label}: the card has no phone and no open-now badge`);
        }
        const cardC = cardOf(html, C.navn);
        ok(cardC.includes(`tel:${C.telefon}`) && /badge-(?:open|closed)/.test(cardC), `W2 ${path} C: the corroborated card keeps phone and open-now badge`);
        ok(cardOf(html, D.navn).includes("tel:22110044") && !/badge-(?:open|closed)/.test(cardOf(html, D.navn)), `W3 ${path} D: phone shown, hours marked wrong have no badge`);
      }
      const related = htmlC.slice(htmlC.indexOf("Flere tannleger i"));
      ok(related.includes(B.navn) && !cardOf(related, B.navn).includes("tel:"), "W4: the related clinics on C's page: B's card has no phone");
    }

    // ── M: MCP ────────────────────────────────────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const server = new McpServer({ name: "dental-places-visning-test", version: "0.0.0" });
    (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dental-places-visning-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    closeMcp = async () => { await client.close(); await server.close(); };
    const tool = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
    const mcpSurfaces = async () => ({
      search: (await tool("tannlege_search", { fylke: "Oslo", limit: 25 })).klinikker as any[],
      akutt: (await tool("tannlege_akutt", { fylke: "Oslo" })).klinikker as any[],
      info: Object.fromEntries(await Promise.all([A, B, C, D].map(async (c) => [c.navn, await tool("tannlege_info", { org_nr: c.org_nr })]))),
    });
    const m = await mcpSurfaces();
    {
      const byName = (list: any[], navn: string) => list.find((k) => k.navn === navn) ?? {};
      const a = byName(m.search, A.navn);
      eq([a.adresse, a.telefon, a.hjemmeside, "apningstider" in a, a.postnummer, a.poststed], [null, null, null, false, "0150", "OSLO"],
        "M1: tannlege_search A — address, phone, website null, no apningstider; postnummer and place stay");
      const b = byName(m.search, B.navn);
      eq([b.adresse, b.telefon, b.hjemmeside, "apningstider" in b], ["Kirkegata 2", null, null, false], "M2: tannlege_search B — only the Brreg address");
      const ak = byName(m.akutt, B.navn);
      eq([ak.akutt, ak.telefon, ak.hjemmeside, "apningstider" in ak], ["vakt", null, null, false], "M3: tannlege_akutt B — vakt, no Places phone, website or hours");
      const c = byName(m.search, C.navn);
      eq([c.adresse, c.telefon, c.hjemmeside, c.apningstider], [C.adresse, C.telefon, C.hjemmeside, ["Man–Tir 08:00–16:00"]], "M4: tannlege_search C — all shown");
      const iA = m.info[A.navn];
      eq([iA.adresse, iA.telefon, iA.hjemmeside, iA.opening_hours, iA.postnummer], [null, null, null, null, "0150"], "M5: tannlege_info A — the four null");
      const iD = m.info[D.navn];
      eq([iD.opening_hours, iD.telefon, iD.adresse], [null, D.telefon, D.adresse], "M6: tannlege_info D — hours marked wrong null, the rest as stored");
      eq(m.info[C.navn].opening_hours, MON_TUE, "M7: tannlege_info C — corroborated hours as stored");
    }

    // ── A: A2A ────────────────────────────────────────────────────────────
    const a2aSurfaces = () => {
      const info = (orgNr: string) =>
        (a2a.handleDentalMessageSend({ message: { text: `info om ${orgNr}` } }, "a4d") as any).result.artifacts[0].parts[0].data;
      const list = (a2a.handleDentalMessageSend({ message: { data: { fylke: "Oslo" } } }, "a4d") as any).result.artifacts[1].parts[0].data.clinics as any[];
      return { info: Object.fromEntries([A, B, C, D].map((c) => [c.navn, info(c.org_nr)])), list };
    };
    const a = a2aSurfaces();
    {
      for (const [label, clinic] of [["org.nr", a.info[A.navn]], ["search", a.list.find((c) => c.navn === A.navn)]] as const) {
        eq([clinic.adresse, clinic.telefon, clinic.hjemmeside, clinic.opening_hours, "apningstider" in clinic], [null, null, null, null, false],
          `A1 ${label} A: address, phone, website and the row's opening_hours null`);
        eq([clinic.postnummer, clinic.lat, clinic.lng], ["0150", 59.9133, 10.7389], `A2 ${label} A: postnummer and coordinates stay`);
        eq(["field_provenance", "stage_v_pending_correction"].filter((k) => k in clinic), [], `A3 ${label} A: no field_provenance, no pending map`);
      }
      const b = a.info[B.navn];
      eq([b.adresse, b.telefon, b.hjemmeside, b.opening_hours], ["Kirkegata 2", null, null, null], "A4: org.nr B — only the Brreg address");
      eq([a.info[D.navn].opening_hours, a.info[D.navn].telefon], [null, D.telefon], "A5: org.nr D — hours marked wrong null, phone shown");
      eq(a.info[C.navn].opening_hours, MON_TUE, "A6: org.nr C — corroborated row hours as stored");
      eq(a.list.map((c) => "stage_v_pending_correction" in c || "field_provenance" in c), [false, false, false, false], "A7: no clinic in the search answer carries either internal column");
    }

    // ── R: REST ───────────────────────────────────────────────────────────
    const restSurfaces = async (headers?: Record<string, string>) => ({
      list: (await callRoute(restRouter, "/agents", { query: { fylke: "Oslo", limit: "50" }, headers })).body.agents as any[],
      one: Object.fromEntries(await Promise.all([idA, idB, idC, idD].map(async (id) => [id, (await callRoute(restRouter, `/agents/${id}`, { params: { id }, headers })).body.agent]))),
    });
    const restPublic = await restSurfaces();
    const restAdmin = await restSurfaces({ "x-admin-key": adminKey });
    {
      for (const [label, list] of [["/agents", restPublic.list], ["/agents/:id", Object.values(restPublic.one)]] as const) {
        const rA = list.find((x: any) => x.id === idA);
        eq([rA.adresse, rA.telefon, rA.hjemmeside, rA.opening_hours, rA.postnummer, rA.lat], [null, null, null, null, "0150", 59.9133], `R1 ${label}: A — the four null, postnummer and lat kept`);
        eq(list.filter((x: any) => "field_provenance" in x || "stage_v_pending_correction" in x).length, 0, `R2 ${label}: no public answer carries field_provenance or the pending map`);
        const rB = list.find((x: any) => x.id === idB);
        eq([rB.adresse, rB.telefon, rB.hjemmeside, rB.opening_hours], ["Kirkegata 2", null, null, null], `R3 ${label}: B — only the Brreg address`);
        eq(list.find((x: any) => x.id === idD).opening_hours, null, `R4 ${label}: D — hours marked wrong null`);
        ok(!JSON.stringify(list).includes("22110011") && !JSON.stringify(list).includes("kunplaces.example.no"), `R5 ${label}: A's Places values appear nowhere in the answer`);
      }
      const adminA = restAdmin.one[idA];
      eq([adminA.adresse, adminA.telefon, adminA.hjemmeside, adminA.opening_hours], [A.adresse, A.telefon, A.hjemmeside, MON_TUE], "R6: X-Admin-Key — A's stored values");
      eq(adminA.field_provenance, row(idA).field_provenance, "R7: X-Admin-Key — field_provenance as stored (the enrichment reads it back)");
      eq(restAdmin.list.filter((x: any) => "stage_v_pending_correction" in x).length, 0, "R8: X-Admin-Key — the pending map is not added to the answer");
      const wrongKey = (await callRoute(restRouter, `/agents/${idA}`, { params: { id: idA }, headers: { "x-admin-key": "wrong" } })).body.agent;
      eq([wrongKey.telefon, "field_provenance" in wrongKey], [null, false], "R9: a wrong X-Admin-Key gets the public answer");
      ok("provenance" in restPublic.one[idA] === false, "R10: (no last_verified_at in the fixture, so no provenance summary either way)");
    }

    // ── S: sitemap and indexing ───────────────────────────────────────────
    const sitemapOrgnrs = () => store.getDentalAgentsForSitemap().map((r) => r.org_nr).sort();
    eq(sitemapOrgnrs(), [B.org_nr, C.org_nr, D.org_nr], "S1: A (thin on the values it shows, noindex) is left out of the sitemap");
    seo.__resetDentalSitemapCacheForTesting();
    {
      const xml = seo.getDentalSitemapXml();
      ok(!xml.includes(seo.slugifyClinic(A.navn, A.org_nr)) && xml.includes(seo.slugifyClinic(B.navn, B.org_nr)), "S2: sitemap.xml lists B, not A");
    }

    // ── B: B1 — corroborated values exactly as with the rule off ──────────
    policy.__setPlacesDisplayPolicyForTesting(false);
    const offC = await page(C);
    const offM = await mcpSurfaces();
    const offA2a = a2aSurfaces();
    const offRest = await restSurfaces();
    const offRestAdmin = await restSurfaces({ "x-admin-key": adminKey });
    const offSitemap = sitemapOrgnrs();
    seo.__resetDentalSitemapCacheForTesting();
    const offXml = seo.getDentalSitemapXml();
    const offPages = { A: await page(A), B: await page(B), D: await page(D) };
    policy.__setPlacesDisplayPolicyForTesting(null);
    {
      // Up to its «Flere tannleger i Oslo» list, which shows A, B and D.
      eq(maskClock(ownPart(htmlC)), maskClock(ownPart(offC)), "B1: C's page is byte for byte the page with the rule off");
      const pick = (s: { search: any[]; akutt: any[]; info: Record<string, any> }, navn: string) => [s.search.find((k) => k.navn === navn), s.info[navn]];
      eq(pick(m, C.navn), pick(offM, C.navn), "B2: C's MCP cards as with the rule off");
      eq([a.info[C.navn], a.list.find((x) => x.navn === C.navn)], [offA2a.info[C.navn], offA2a.list.find((x) => x.navn === C.navn)], "B3: C in A2A as with the rule off");
      const { field_provenance: _p, ...offCPublic } = offRest.one[idC];
      eq(restPublic.one[idC], offCPublic, "B4: C's public REST answer is the old one less field_provenance");
      eq(restAdmin, offRestAdmin, "B5: the X-Admin-Key answers do not depend on the rule");
    }

    // ── K: kill switch off = main ─────────────────────────────────────────
    // Main ignored provenance for these four fields, so main's surfaces equal
    // the same clinic without its google_places records (and no pending map)
    // with the rule on. The REST answer equals the admin answer (main's form).
    {
      eq(offSitemap, [A.org_nr, B.org_nr, C.org_nr, D.org_nr], "K1: off -> A is in the sitemap again");
      ok(offXml.includes(seo.slugifyClinic(A.navn, A.org_nr)), "K1b: ... in sitemap.xml too");
      ok(!offPages.A.includes('content="noindex') && offPages.A.includes(`tel:${A.telefon}`), "K2: off -> A's page is indexable with its phone");
      eq(offRest, offRestAdmin, "K3: off -> the public REST answers are the stored ones with field_provenance (as on main)");
      const stripPlaces = (prov: Record<string, any[]>) =>
        Object.fromEntries(Object.entries(prov).map(([k, rs]) => [k, rs.filter((r) => r.source_type !== "google_places")]));
      const stored = new Map([idA, idB, idD].map((id) => {
        const r = db.prepare("SELECT field_provenance, stage_v_pending_correction FROM dental_agents WHERE id = ?").get(id) as any;
        return [id, r];
      }));
      for (const id of [idA, idB, idD]) {
        db.prepare("UPDATE dental_agents SET field_provenance = ?, stage_v_pending_correction = NULL WHERE id = ?")
          .run(JSON.stringify(stripPlaces(JSON.parse(stored.get(id).field_provenance))), id);
      }
      try {
        const mainPages = { A: await page(A), B: await page(B), D: await page(D) };
        for (const k of ["A", "B", "D"] as const) eq(maskClock(offPages[k]), maskClock(mainPages[k]), `K4 ${k}: off -> the page is main's page`);
        const mainM = await mcpSurfaces();
        eq(offM, mainM, "K5: off -> the MCP answers are main's");
        const mainA2a = a2aSurfaces();
        eq(offA2a, mainA2a, "K6: off -> the A2A answers are main's");
      } finally {
        for (const id of [idA, idB, idD]) {
          db.prepare("UPDATE dental_agents SET field_provenance = ?, stage_v_pending_correction = ? WHERE id = ?")
            .run(stored.get(id).field_provenance, stored.get(id).stage_v_pending_correction, id);
        }
      }
    }

    // ── T: texts ──────────────────────────────────────────────────────────
    {
      const prov = (await callRoute(seoRouter, "/proveniens")).text;
      ok(prov.includes("En adresse, et telefonnummer, åpningstider eller en nettside som bare Google Places oppgir, viser vi ikke."),
        "T1: /proveniens (no) says a value only Google Places gives is not shown");
      ok(prov.includes("An address, phone number, opening hours or website that only Google Places gives is not shown."),
        "T2: /proveniens (en) says the same");
      const skill = (getDentalAgentCard() as any).skills.find((s: any) => s.id === "tannlege_search").description as string;
      ok(/and its address, phone, website, online booking link, opening hours, specialties and chain when known\./.test(skill) &&
        !/each with its name, org\.nr, address/.test(skill), "T3: the A2A agent card lists address, phone and website «when known»");
    }

    // ── N: no DB write ────────────────────────────────────────────────────
    eq(snapshot() === before, true, "N1: every stored row is unchanged after all surfaces were read");
  } catch (err: any) {
    failed++;
    failures.push("dental places visning (A4-D): unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    policy.__setPlacesDisplayPolicyForTesting(null);
    (analyticsService as any).logWebSearch = realLogWebSearch;
    if (closeMcp) await closeMcp().catch(() => {});
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
  console.log("── dental places visning (dev-request 2026-10-16, A4-D) ──");
  runDentalPlacesVisningTests({ log: true }).then((r) => {
    console.log(`\ndental places visning (A4-D): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    // The /sok rate limiter keeps a timer; exit as the sibling suites do.
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
