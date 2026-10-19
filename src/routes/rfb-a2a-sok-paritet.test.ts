/**
 * rfb-a2a-sok-paritet.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-AA (integration test round
 * 3, measured live 2026-10-19 on c9be20ea: RFB-M-01 P1, RFB-M-02 and R3-RS-01
 * P2, and FUNN rfb-ukjente-ord-web-rest from I-W). A2A message/send
 * (routes/a2a.ts, Mode 1) and GET /sok (routes/seo.ts) read a search as MCP
 * lokal_search does (services/rfb-search-reading.ts):
 *
 *   P   acceptance 1. «honning Trondheim», «Which farms in Innlandet sell
 *       lamb?», «Where can I buy reindeer meat in Finnmark?» and «Finnes det
 *       kransekake» give lokal_search's top three on A2A and /sok: the same
 *       three producers, in the order discover() gives lokal_search (the same
 *       query reaches it). lokal_search's text puts a match resting on a
 *       category label after the explicit ones (slice I-N); routes/mcp.ts is
 *       frozen, so A2A and /sok keep discover()'s order there (the PR says
 *       so). On main A2A gave honey and meat producers anywhere in Norway and
 *       nothing for kransekake (main_names in the fixture). «cheese in
 *       Stockholm» and «Find me a good pizza restaurant in Rome» give
 *       lokal_search's outside-Norway text, no producer and no geocoder call.
 *   N   acceptance 2. /sok shows an honest null text where no product name
 *       matches the words («mandelbunn», «zzzqqx»), in Norwegian and English,
 *       not the standard list main showed (main_names). Near a place, a page of
 *       producers that match nothing is no result: the ladder widens to all of
 *       Norway («kransekake i Trondheim» finds Grini), and those producers are
 *       not counted as discovered.
 *   A   A2A: the words the parser cannot read are a search (hasDiscoveryIntent),
 *       but pings («ping», «test») are not, and the place is looked up only for
 *       a text that asks for something («hei», «Oslo» stay no search, as on
 *       main, so they start no conversations). No match: no producers, with
 *       lokal_search's null text, or an area text near a place; nothing counted.
 *       Spam and probe clients are read as on main: their unknown words are no
 *       search and no place is looked up (review of lokal#1193, B1).
 *   R   the reading is lokal_search's: readSearchText/geocodeSearchPlace give
 *       parseNaturalQuery + enrichParsedWithGeo's query, discoveryQueryOf
 *       keeps the parser's words, and the texts are lokal_search's word for
 *       word (routes/mcp.ts keeps its own copies; this pins them together).
 *   C   discover() counts a page of producers that match none of the unknown
 *       words only when the caller shows it (countUnmatched).
 *   B1  acceptance 3. /sok's pages for the control searches (no unknown word,
 *       no place abroad) and lokal_search's texts for every search here are
 *       main's, byte for byte: tests/fixtures/rfb-a2a-sok-paritet-main.json,
 *       captured with paritetMainCapture() below on main c9be20ea (--print).
 *       The MCP contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Data: I-W's fixtures (rfb-sok-ukjente-ord-bakeri-sted.test.ts) plus
 * I_AA_SEEDS, so Trondheim, Innlandet and Finnmark have three matches each,
 * as live (the /sok ladder widens below three). In-memory DB with the
 * production schema (restored in finally). Kartverket is a stub that knows
 * «finnes» (the live point, I-W4) and «hei»; every other name is a 404. No
 * network. MCP tools through a duck-typed server, the A2A router through
 * router.handle(), /sok through its route handler.
 *
 * Exported runRfbA2aSokParitetTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-a2a-sok-paritet.test.ts
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { __clearGeocodeCacheForTesting, __setGeocodingFetchForTesting } from "../services/geocoding-service";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { I_W_SEEDS, B1_QUERIES, BAKERY_QUERIES, enterFixtures, captureTools, textOf, namesIn } from "./rfb-sok-ukjente-ord-bakeri-sted.test";
import { LIVE_PLACES } from "./rfb-sok-fyllord-ikke-sted.test";
import { stable, routeHandler } from "./fritekst-lengdetak-alle-plattformer.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const id = (n: number) => `1f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// I-W's ids that the expectations name
const GRINI = id(1), BAERUMNAVN = id(2), BYBAKST = id(3), TRD_BAKERY = id(10), TRD_BREAD = id(11), TRD_HONEY = id(12), TRD_LABEL = id(13);
// Two more honey, lamb and reindeer producers, and a meat producer without the product, in each area
const BYNESET = id(181), VALDRES_LAM = id(182), HEDMARK_LAM = id(183), LOTEN = id(184);
const KARASJOK = id(185), PORSANGER = id(186), ALTA = id(187);

/** A producer whose knowledge products and catalog rows are the same names (and prices). */
function seed(n: string, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: n, name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

/** With I-W's Tirslaug, Hevd Etikett, Sygard Grytting and Finnmark Kjøtt: three matches in each area, and one producer without the product. */
export const I_AA_SEEDS: Seed[] = [
  // Trondheim (geocoding-service 63.4305, 10.3951, 30 km)
  seed(BYNESET, "Byneset Birøkt Fixture", 63.39, 10.25, "Trondheim", ["honey"], [{ name: "Sommerhonning", priceNok: 140 }]),
  // Innlandet (61.5, 11.0, 120 km)
  seed(VALDRES_LAM, "Valdres Lam Fixture", 60.98, 9.23, "Fagernes", ["meat"], [{ name: "Lammelår", priceNok: 280 }]),
  seed(HEDMARK_LAM, "Hedmark Sau og Lam Fixture", 61.25, 11.6, "Rena", ["meat"], [{ name: "Lammeskank", priceNok: 240 }]),
  seed(LOTEN, "Løten Kjøtt Fixture", 60.82, 11.35, "Løten", ["meat"], [{ name: "Storfekjøtt", priceNok: 300 }]),
  // Finnmark (70.0, 25.0, 120 km)
  seed(KARASJOK, "Karasjok Rein Fixture", 69.47, 25.51, "Karasjok", ["meat"], [{ name: "Tørket reinkjøtt", priceNok: 420 }]),
  seed(PORSANGER, "Porsanger Rein Fixture", 70.05, 24.95, "Lakselv", ["meat"], [{ name: "Reinsdyrfilet", priceNok: 520 }]),
  seed(ALTA, "Alta Kjøtt Fixture", 69.97, 23.27, "Alta", ["meat"], [{ name: "Elgkjøtt", priceNok: 350 }]),
];
const SEEDS: readonly Seed[] = [...I_W_SEEDS, ...I_AA_SEEDS];

/** The searches of acceptance criterion 1 that have producers. */
export const PARITY_QUERIES: readonly string[] = [
  "honning Trondheim", "Which farms in Innlandet sell lamb?", "Where can I buy reindeer meat in Finnmark?", "Finnes det kransekake",
];
/** Searches that name a place outside Norway. */
export const ABROAD_QUERIES: readonly string[] = ["cheese in Stockholm", "Find me a good pizza restaurant in Rome"];
/** Searches whose words match no product name, nationwide and near a place. */
export const NULL_QUERIES: readonly string[] = ["mandelbunn", "zzzqqx", "kransekake i Trondheim", "zzzqqx i Bærum"];
/**
 * /sok's control searches: no word the parser cannot read and no place
 * abroad, so the page is main's (acceptance criterion 3). I-W's B1 searches
 * (the test sets of both submission files and the Norwegian searches of I-N,
 * I-S and I-V) and its bakery searches.
 */
export const SOK_CONTROL_QUERIES: readonly string[] = [...B1_QUERIES.filter((q) => !q.endsWith("in Rome")), ...BAKERY_QUERIES, "honning Trondheim", "egg i Bergen"];
/** /sok's control searches by position: the visitor's position, and «hele Norge». */
const SOK_CONTROL_PARAMS: ReadonlyArray<Record<string, string>> = [
  { lat: "63.4305", lng: "10.3951", radius: "30" },
  { q: "honning", lat: "63.4305", lng: "10.3951", radius: "30" },
  { q: "honning Trondheim", heleNorge: "true" },
];

const MAIN_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-a2a-sok-paritet-main.json");

// ─── Kartverket stub ──────────────────────────────────────────────────────

/** Kartverket's Stedsnavn as a stub: «finnes» (the live point, I-W4) and «hei» are places, everything else a 404. Pushes each name asked. */
function kartverketStub(asked: string[]): typeof fetch {
  const places: Record<string, readonly [string, number, number]> = { finnes: LIVE_PLACES.finnes, hei: ["Grend", 59.4, 9.1] };
  return (async (url: unknown) => {
    const params = new URL(String(url)).searchParams;
    const sok = params.get("sok");
    asked.push((sok ?? params.get("knavn") ?? "").toLowerCase());
    const place = sok === null ? undefined : places[sok.toLowerCase()];
    if (!place) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const [type, nord, øst] = place;
    return {
      ok: true, status: 200,
      json: async () => ({ navn: [{ navneobjekttype: type, representasjonspunkt: { nord, øst }, stedsnavn: [{ skrivemåte: sok, navnestatus: "hovednavn" }], kommuner: [] }] }),
    } as Response;
  }) as typeof fetch;
}

// ─── Route drivers ────────────────────────────────────────────────────────

let ipSeq = 0;
/** A fresh client address per call, so the per-IP caps never decide an answer here. */
function nextIp(): string {
  ipSeq++;
  return `10.127.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

/** A response object for the handlers; settles on json/send/redirect. An EventEmitter: recordA2aDelivery waits for "finish", never sent. */
function mockRes(settle: (status: number, body: unknown, locals: Record<string, unknown>) => void): any {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    locals: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; }, getHeader() { return undefined; }, header() { return this; }, set() { return this; },
    vary() { return this; }, type() { return this; }, append() { return this; },
    json(payload: unknown) { settle(this.statusCode, payload, this.locals); return this; },
    send(payload: unknown) { settle(this.statusCode, payload, this.locals); return this; },
    redirect(a: number | string, b?: string) { settle(typeof a === "number" ? a : 302, { redirect: typeof a === "number" ? b : a }, this.locals); return this; },
  });
}

interface A2aAnswer {
  status: number;
  body: any;
  /** res.locals.a2aCountable: the «AI-søk» verdict mcp-usage-logger.ts stores. */
  countable: unknown;
}

/** POST /a2a message/send with `params` through router.handle(). */
function sendA2a(router: any, params: unknown, ua = "curl/8.5.0"): Promise<A2aAnswer> {
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": ua };
    const req: any = {
      method: "POST", url: "/a2a", originalUrl: "/a2a", path: "/a2a", query: {}, headers,
      body: { jsonrpc: "2.0", method: "message/send", params, id: "i-aa" },
      ip, socket: { remoteAddress: ip },
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    const res = mockRes((status, body, locals) => resolve({ status, body, countable: locals.a2aCountable }));
    router.handle(req, res, (err?: unknown) => resolve({ status: err ? 500 : 404, body: String(err ?? "no route"), countable: undefined }));
  });
}
const textMessage = (text: string) => ({ message: { role: "user", parts: [{ kind: "text", text }] } });
/** The search artifact's data of an A2A answer. */
const a2aData = (r: A2aAnswer) => r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
const a2aNames = (r: A2aAnswer): string[] => (a2aData(r)?.agents ?? []).map((x: any) => x.agent.name);

/** GET /sok through its route handler (past generalLimiter); the page as text. */
function getSok(handler: Function, query: Record<string, string>, opts: { lang?: "no" | "en"; ua?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "user-agent": opts.ua ?? "curl/8.5.0", host: "rettfrabonden.com" };
    const req: any = {
      method: "GET", url: "/sok", path: "/sok", originalUrl: "/sok", params: {}, query, headers, ip,
      socket: { remoteAddress: ip }, lang: opts.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    let settled = false;
    const done = (status: number, body: unknown) => { if (!settled) { settled = true; resolve({ status, body: typeof body === "string" ? body : JSON.stringify(body) }); } };
    const res = mockRes((status, body) => done(status, body));
    const p = handler(req, res, (err?: unknown) => done(err ? 500 : 404, String(err ?? "next")));
    if (p && typeof p.catch === "function") p.catch((err: unknown) => done(500, String(err)));
  });
}
const unescapeHtml = (s: string) => s.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The producer cards of a /sok page, in order. */
const sokNames = (page: string): string[] => [...page.matchAll(/<div class="pc-name" translate="no">([^<]*)<\/div>/g)].map((m) => unescapeHtml(m[1]));
/** The text of a /sok page's null note (id searchNullNote), or null. */
const sokNullNote = (page: string): string | null => {
  const m = page.match(/<p id="searchNullNote"[^>]*>([^<]*)<\/p>/);
  return m ? unescapeHtml(m[1]) : null;
};

/** What the fixtures drive: lokal_search, the A2A router and /sok, with the Kartverket stub's log. */
interface Surfaces {
  search: (q: string) => Promise<string>;
  a2a: any;
  sok: Function;
  asked: string[];
  db: import("better-sqlite3").Database;
  restore: () => void;
}

/** Fresh fixtures (I-W's and I_AA_SEEDS) with the Kartverket stub; the three surfaces. Uses only what main has. */
function enterSurfaces(): Surfaces {
  const fixtures = enterFixtures(SEEDS);
  const asked: string[] = [];
  __setGeocodingFetchForTesting(kartverketStub(asked));
  __clearGeocodeCacheForTesting();
  try {
    // /sok's page shell reads the vertical config, as at boot (I-Y's enterRfb does the same).
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const { a2aConversationCap } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
    a2aConversationCap.reset();
    const tools = captureTools();
    return {
      search: async (q: string) => textOf(await tools.get("lokal_search")!({ query: q, limit: 10 })),
      a2a: (require("./a2a") as any).default,
      sok: routeHandler((require("./seo") as any).default, "/sok"),
      asked,
      db: fixtures.db,
      restore: () => { a2aConversationCap.reset(); fixtures.restore(); },
    };
  } catch (err) {
    fixtures.restore();
    throw err;
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface MainCapture {
  /** /sok's masked page (stable()) for each control search, by its query string. */
  sok: Record<string, string>;
  /** lokal_search's text for every search of this test. */
  lokal_search: Record<string, string>;
  /** The producers A2A and /sok answer the searches of P, N and the abroad searches with. */
  names: { a2a: Record<string, string[]>; sok: Record<string, string[]> };
}

/** The key of a /sok query in the fixture. */
const sokKey = (query: Record<string, string>) => new URLSearchParams(query).toString();

/**
 * Each surface's answers on fresh fixtures: /sok's pages for the control
 * searches (sha256 of stable()), lokal_search's texts (sha256), and the
 * names A2A and /sok give for the searches this slice changes. Uses only
 * what main has, so main's answers are captured with it (--print).
 */
export async function paritetMainCapture(): Promise<MainCapture> {
  const out: MainCapture = { sok: {}, lokal_search: {}, names: { a2a: {}, sok: {} } };
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  const s = enterSurfaces();
  try {
    for (const query of [...SOK_CONTROL_QUERIES.map((q) => ({ q })), ...SOK_CONTROL_PARAMS]) {
      out.sok[sokKey(query)] = sha(stable((await getSok(s.sok, query)).body));
    }
    for (const q of [...SOK_CONTROL_QUERIES, ...PARITY_QUERIES, ...ABROAD_QUERIES, ...NULL_QUERIES]) {
      out.lokal_search[q] = sha(await s.search(q));
    }
    for (const q of [...PARITY_QUERIES, ...ABROAD_QUERIES, ...NULL_QUERIES]) {
      out.names.a2a[q] = a2aNames(await sendA2a(s.a2a, textMessage(q)));
      out.names.sok[q] = sokNames((await getSok(s.sok, { q })).body);
    }
    return out;
  } finally {
    s.restore();
    console.log = prevLog;
  }
}

export async function runRfbA2aSokParitetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  // B1 first: paritetMainCapture opens (and closes) its own fixtures.
  const main = JSON.parse(fs.readFileSync(MAIN_FIXTURE, "utf8")) as MainCapture;
  const now = await paritetMainCapture();

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };
  let s: Surfaces | null = null;
  try {
    const reading = require("../services/rfb-search-reading") as typeof import("../services/rfb-search-reading");
    const { readSearchText, geocodeSearchPlace, discoveryQueryOf, outsideNorwayText, noProductMatchText, PARSED_SEARCH_TERMS } = reading;
    const { hasDiscoveryIntent } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
    const { foreignPlaceIn } = require("../services/outside-norway") as typeof import("../services/outside-norway");

    // ══ B1  acceptance criterion 3: main's answers, byte for byte ════════════
    {
      for (const [key, want] of Object.entries(main.sok)) {
        assertTrue(now.sok[key] === want, `B1 /sok?${key}: the page is main's`);
      }
      for (const [q, want] of Object.entries(main.lokal_search)) {
        assertTrue(now.lokal_search[q] === want, `B1 lokal_search «${q}»: the text is main's (routes/mcp.ts unchanged)`);
      }
      assertEq([Object.keys(main.sok).length, Object.keys(main.lokal_search).length],
        [SOK_CONTROL_QUERIES.length + SOK_CONTROL_PARAMS.length, new Set([...SOK_CONTROL_QUERIES, ...PARITY_QUERIES, ...ABROAD_QUERIES, ...NULL_QUERIES]).size],
        "B1 the fixture holds every control search of /sok and every search of lokal_search here");
      assertTrue(Object.values(main.names.sok).some((n) => n.length > 0) && SOK_CONTROL_QUERIES.length >= 20,
        "B1 setup: the control searches are the test sets and earlier slices' searches, and main's pages had producers");
    }

    s = enterSurfaces();
    const surfaces = s;
    {
      const parsedWords = (q: string) => (readSearchText(q).parsed as any)._unknownTerms as string[] | undefined;
      assertEq(SOK_CONTROL_QUERIES.filter((q) => parsedWords(q) || foreignPlaceIn(q)), [],
        "B1 setup: no control search has a word the parser cannot read or a place abroad (what this slice changes on /sok)");
    }
    const discovered = (agentId: string) => (surfaces.db.prepare("SELECT discovery_count AS c FROM agents WHERE id = ?").get(agentId) as { c: number }).c;
    const askA2a = (q: string) => sendA2a(surfaces.a2a, textMessage(q));
    /** Pages whose null text stands over producer cards (none may). */
    const nullOverCards: string[] = [];
    const askSok = async (q: string, opts: { lang?: "no" | "en"; ua?: string } = {}) => {
      const page = (await getSok(surfaces.sok, { q }, opts)).body;
      if (sokNullNote(page) !== null && sokNames(page).length > 0) nullOverCards.push(q);
      return page;
    };
    /** discover()'s order as lokal_search runs it (parseNaturalQuery, enrichParsedWithGeo, the parsed query itself). */
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const { enrichParsedWithGeo } = require("./mcp") as typeof import("./mcp");
    const lokalSearchOrder = async (q: string) => {
      const parsed = marketplaceRegistry.parseNaturalQuery(q);
      await enrichParsedWithGeo(parsed, q);
      return marketplaceRegistry.discover({ ...parsed, limit: 10, offset: 0 } as any, {}, { trackDiscovery: false }).map((r) => r.agent.name);
    };
    const top3 = (names: string[]) => names.slice(0, 3);
    const sorted = (names: string[]) => [...names].sort();

    // ══ P  acceptance criterion 1 ═════════════════════════════════════════
    for (const q of PARITY_QUERIES) {
      const mcpText = await surfaces.search(q);
      const mcp = top3(namesIn(mcpText));
      const order = top3(await lokalSearchOrder(q));
      const a2a = top3(a2aNames(await askA2a(q)));
      const sok = top3(sokNames(await askSok(q)));
      assertTrue(mcp.length === 3, `P «${q}»: lokal_search has three producers here (got ${JSON.stringify(mcp)})`);
      assertEq([sorted(a2a), sorted(sok)], [sorted(mcp), sorted(mcp)], `P «${q}»: A2A and /sok give lokal_search's top three producers`);
      assertEq([a2a, sok], [order, order], `P «${q}»: …in the order discover() gives lokal_search`);
      const labelled = [...mcpText.matchAll(/^\*\*[123]\. .+$/gm)].some((m) => m[0].includes("Kategoritreff"));
      if (!labelled) assertEq([a2a, sok], [mcp, mcp], `P «${q}»: …which is lokal_search's own order (no category match in its top three)`);
      assertTrue(JSON.stringify(top3(main.names.a2a[q] ?? [])) !== JSON.stringify(mcp),
        `P «${q}» (repro): on main A2A did not (main ${JSON.stringify(top3(main.names.a2a[q] ?? []))})`);
    }
    {
      // The two Trondheim cases the PR names: lokal_search moves the label match last, discover() ranks it by distance.
      const mcp = namesIn(await surfaces.search("honning Trondheim"));
      assertEq(mcp, ["Tirslaug Birøkt Fixture", "Byneset Birøkt Fixture", "Hevd Etikett Fixture"],
        "P «honning Trondheim»: lokal_search lists the two beekeepers, then the label-only match (slice I-N)");
      assertEq(a2aNames(await askA2a("honning Trondheim")), ["Hevd Etikett Fixture", "Tirslaug Birøkt Fixture", "Byneset Birøkt Fixture"],
        "P «honning Trondheim»: A2A gives the same three in discover()'s order (the label-only match is nearest)");
      assertTrue((main.names.a2a["honning Trondheim"] ?? []).includes("TønsbergBier Fixture"),
        `P «honning Trondheim» (repro): on main A2A listed honey producers outside Trondheim (${JSON.stringify(main.names.a2a["honning Trondheim"])})`);
      assertEq(main.names.a2a["Finnes det kransekake"], [], "P «Finnes det kransekake» (repro): on main A2A gave nothing");
      const parsed = a2aData(await askA2a("honning Trondheim"))?.parsedQuery;
      assertEq([parsed?.location, parsed?.maxDistanceKm, parsed?._productTerms], [{ lat: 63.4305, lng: 10.3951 }, 30, ["honning"]],
        "P «honning Trondheim»: A2A's parsedQuery shows the place and the product word it searched with");
    }
    for (const q of ABROAD_QUERIES) {
      const place = foreignPlaceIn(q)!;
      const mcpText = await surfaces.search(q);
      surfaces.asked.length = 0;
      const a2a = await askA2a(q);
      const a2aAsked = [...surfaces.asked];
      surfaces.asked.length = 0;
      const page = await askSok(q);
      const sokAsked = [...surfaces.asked];
      assertEq(mcpText, outsideNorwayText(place), `P «${q}»: lokal_search's text is outsideNorwayText («${place}»)`);
      assertEq([a2aData(a2a)?.count, a2aData(a2a)?.agents, a2aData(a2a)?.conversations, a2aData(a2a)?.note], [0, [], [], outsideNorwayText(place)],
        `P «${q}»: A2A gives no producer and lokal_search's text`);
      assertEq([sokNames(page), sokNullNote(page)], [[], outsideNorwayText(place, "no")], `P «${q}»: /sok shows no producer and the Norwegian half of that text`);
      assertEq([a2aAsked, sokAsked], [[], []], `P «${q}»: neither looks a place up`);
      assertTrue((main.names.sok[q] ?? []).length > 0, `P «${q}» (repro): on main /sok listed Norwegian producers (${(main.names.sok[q] ?? []).length})`);
    }
    {
      const page = await askSok("cheese in Stockholm", { lang: "en" });
      assertEq(sokNullNote(page), outsideNorwayText("stockholm", "en"), "P «cheese in Stockholm»: the English page shows the English half");
      assertTrue((main.names.a2a["cheese in Stockholm"] ?? []).includes("Ostegården — Krokeide"),
        `P «cheese in Stockholm» (repro): on main A2A listed Norwegian dairies (${JSON.stringify(main.names.a2a["cheese in Stockholm"])})`);
    }

    // ══ N  acceptance criterion 2: /sok's honest null ═════════════════════
    for (const q of ["mandelbunn", "zzzqqx"]) {
      const page = await askSok(q);
      assertEq([sokNames(page), sokNullNote(page)], [[], noProductMatchText([q], "no")], `N /sok «${q}»: no producer, and the null text naming the word`);
      assertTrue((main.names.sok[q] ?? []).length >= 20, `N /sok «${q}» (repro): on main the standard list (${(main.names.sok[q] ?? []).length} producers)`);
      assertEq(sokNullNote(await askSok(q, { lang: "en" })), noProductMatchText([q], "en"), `N /sok «${q}»: in English on the English page`);
      assertTrue(page.includes("Prøv et annet søk"), `N /sok «${q}»: …with the link to a new search`);
    }
    assertEq(main.names.sok["mandelbunn"], main.names.sok["zzzqqx"], "N (repro): on main «mandelbunn» showed the same producers as nonsense");
    {
      const page = await askSok("kransekake");
      assertEq(sokNames(page), namesIn(await surfaces.search("kransekake")), "N /sok «kransekake»: lokal_search's kransekake producers, Grini first");
      assertEq(sokNullNote(page), null, "N /sok «kransekake»: no null text");
    }
    {
      // Near a place: the area's producers match nothing, so the ladder goes on to all of Norway.
      const browser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0";
      const before = [TRD_BAKERY, TRD_BREAD, TRD_HONEY, TRD_LABEL, BYNESET].map(discovered);
      const grini = discovered(GRINI);
      const page = await askSok("kransekake i Trondheim", { ua: browser });
      const counted = { trondheim: [TRD_BAKERY, TRD_BREAD, TRD_HONEY, TRD_LABEL, BYNESET].map(discovered), grini: discovered(GRINI) - grini };
      assertEq(top3(sokNames(page)), top3(namesIn(await surfaces.search("kransekake"))),
        "N /sok «kransekake i Trondheim»: no producer in Trondheim has it, so the page widens to all of Norway: Grini first");
      assertTrue(page.includes('id="geoRelaxedNote"') && page.includes("utvidet til hele Norge"), "N /sok «kransekake i Trondheim»: …and says so");
      assertEq(counted.trondheim, before,
        "N /sok «kransekake i Trondheim»: the Trondheim producers, which match nothing, are not counted as discovered");
      assertEq(counted.grini, 1, "N /sok «kransekake i Trondheim»: Grini, shown, is counted");
      const baerum = [GRINI, BAERUMNAVN, BYBAKST].map(discovered);
      const nothing = await askSok("zzzqqx i Bærum", { ua: browser });
      assertEq([sokNames(nothing), sokNullNote(nothing)], [[], noProductMatchText(["zzzqqx"], "no")],
        "N /sok «zzzqqx i Bærum»: no producer anywhere: the null text, not the producers in Bærum");
      assertEq([GRINI, BAERUMNAVN, BYBAKST].map(discovered), baerum, "N /sok «zzzqqx i Bærum»: …and none of them is counted");
      assertTrue((main.names.sok["zzzqqx i Bærum"] ?? []).includes("Grini Hjemmebakeri Fixture"),
        `N /sok «zzzqqx i Bærum» (repro): on main the producers in Bærum as results (${JSON.stringify(main.names.sok["zzzqqx i Bærum"])})`);
    }
    {
      const q = "Which bakeries make kransekake";
      assertEq(top3(sokNames(await askSok(q))), top3(namesIn(await surfaces.search(q))),
        `N /sok «${q}»: a category word with an unknown word ranks the bakeries with kransekake first, as lokal_search does`);
    }

    assertEq(nullOverCards, [], "N /sok: on no page above does the null text stand over producer cards");

    // ══ A  A2A ════════════════════════════════════════════════════════════
    {
      assertEq([hasDiscoveryIntent({ _unknownTerms: ["kransekake"] }), hasDiscoveryIntent({ _unknownTerms: ["kransekake"] }, { structured: true })],
        [true, false], "A hasDiscoveryIntent: the words the parser cannot read are a search in a text, not in structured data (discover() never reads them there)");
      assertEq([["ping"], ["test", "ping"], ["Status"], [], [" "], [5]].map((t) => hasDiscoveryIntent({ _unknownTerms: t })),
        [false, false, false, false, false, false], "A hasDiscoveryIntent: pings and fillers (NO_INTENT_TERMS), empty and non-text words are no search");
      assertEq(hasDiscoveryIntent({ _unknownTerms: ["test", "kransekake"] }), true, "A hasDiscoveryIntent: …but one real word among them is");
      assertEq([hasDiscoveryIntent({ _unknownTerms: ["kransekake"] }, { unknownTerms: false }), hasDiscoveryIntent({ _productTerms: ["honning"] }, { unknownTerms: false })],
        [false, true], "A hasDiscoveryIntent: unknownTerms: false (spam and probe traffic) makes only those words no search");
      assertEq([hasDiscoveryIntent({ categories: ["honey"] }), hasDiscoveryIntent({ role: "producer" })], [true, false],
        "A hasDiscoveryIntent: the other rules are as before");

      const krans = await askA2a("Finnes det kransekake");
      assertEq([top3(a2aNames(krans)), krans.countable, a2aData(krans)?.conversations?.length],
        [top3(namesIn(await surfaces.search("Finnes det kransekake"))), true, 3],
        "A «Finnes det kransekake»: the kransekake producers, counted as an AI lookup, with conversations for the top three");

      const before = { grini: discovered(GRINI), baerum: [GRINI, BAERUMNAVN, BYBAKST].map(discovered) };
      const nothing = await askA2a("zzzqqx");
      assertEq([a2aData(nothing)?.count, a2aData(nothing)?.note, nothing.countable, a2aData(nothing)?.conversations],
        [0, await surfaces.search("zzzqqx"), false, []], "A «zzzqqx»: no producer, and lokal_search's null text word for word");
      assertEq(a2aData(nothing)?.note, noProductMatchText(["zzzqqx"]), "A «zzzqqx»: …which is noProductMatchText");
      const area = await askA2a("zzzqqx i Bærum");
      assertEq([a2aData(area)?.count, a2aData(area)?.agents, area.countable, a2aData(area)?.conversations, a2aData(area)?.relaxed_filters],
        [0, [], false, [], undefined], "A «zzzqqx i Bærum»: no producer (the ones in Bærum match nothing), no conversation");
      assertTrue(String(a2aData(area)?.note).startsWith("🔎 Ingen produsent i området har «zzzqqx» i produktlista")
        && String(a2aData(area)?.note).includes("Search without a place to cover all of Norway."),
        `A «zzzqqx i Bærum»: …with a note that says so and how to search all of Norway (got ${JSON.stringify(a2aData(area)?.note)})`);
      assertEq([GRINI, BAERUMNAVN, BYBAKST].map(discovered), before.baerum, "A «zzzqqx i Bærum»: …and nobody is counted as discovered");
      assertEq(namesIn(await surfaces.search("zzzqqx i Bærum")).length, 3, "A «zzzqqx i Bærum»: lokal_search still lists the three, marked as no matches (unchanged)");
      const grini = await askA2a("kransekake i Bærum");
      assertEq(a2aNames(grini), ["Grini Hjemmebakeri Fixture"], "A «kransekake i Bærum»: Grini, the one in Bærum with kransekake");

      for (const q of ["ping", "test", "hei", "Oslo", "hello there"]) {
        surfaces.asked.length = 0;
        const r = await askA2a(q);
        assertEq([a2aData(r)?.count, /Fant ingen matforespørsel/.test(a2aData(r)?.note ?? ""), r.countable, surfaces.asked],
          [0, true, false, []], `A «${q}»: no search, as on main: no place is looked up (Kartverket knows «hei»), nothing counted`);
      }
      surfaces.asked.length = 0;
      await surfaces.search("hei");
      assertTrue(surfaces.asked.includes("hei"), "A setup: lokal_search does look «hei» up (the stub knows it), so the A2A check above is not vacuous");

      // Review of lokal#1193 (B1): a probe or spam client is read as on main.
      surfaces.asked.length = 0;
      const probe = await sendA2a(surfaces.a2a, textMessage("Finnes det kransekake"), "agentprobe/0.1.0 (+https://agentprobe.org/methodology; read-only)");
      assertEq([a2aData(probe)?.count, /Fant ingen matforespørsel/.test(a2aData(probe)?.note ?? ""), probe.countable, surfaces.asked],
        [0, true, false, []], "A «Finnes det kransekake» from a probe client: its unknown word is no search, and nothing is looked up");
      const probeHoney = await sendA2a(surfaces.a2a, textMessage("honning Trondheim"), "a2a-probe/1.0 (research)");
      assertEq([a2aData(probeHoney)?.parsedQuery?.location, a2aData(probeHoney)?.count > 0, probeHoney.countable, surfaces.asked], [undefined, true, false, []],
        "A «honning Trondheim» from a probe client: a nationwide honey search, as on main, with no place looked up");
      const spam = await askA2a("honning Trondheim WALLET RECOVERY");
      assertEq([a2aData(spam)?.parsedQuery?.location, a2aData(spam)?.conversations, surfaces.asked], [undefined, [], []],
        "A spam with a food word and a place: no place looked up, no conversation");

      const structured = await sendA2a(surfaces.a2a, { message: { data: { _unknownTerms: ["kransekake"] } } });
      assertEq([a2aData(structured)?.count, /Fant ingen matforespørsel/.test(a2aData(structured)?.note ?? "")], [0, true],
        "A structured data with only _unknownTerms: no search, as before");
      // The handler is async now: a failure before its own try (the parser on
      // a `text` that is no string, a client bug) still gets the generic answer.
      const odd = await sendA2a(surfaces.a2a, { message: { text: 5 } });
      assertEq([odd.status, odd.body?.error, odd.body?.id], [200, { code: -32603, message: "Internal error" }, "i-aa"],
        "A a text that is no string: JSON-RPC's generic internal error, as before (no detail, no unhandled rejection)");
    }

    // ══ R  the reading is lokal_search's ════════════════════════════════════
    {
      const texts = [...SOK_CONTROL_QUERIES, ...PARITY_QUERIES, ...ABROAD_QUERIES, ...NULL_QUERIES, "Finnes", "i Finnes", "hei", "nær meg", ""];
      const diffs: string[] = [];
      for (const t of texts) {
        const read = readSearchText(t);
        if (JSON.stringify(read.parsed) !== JSON.stringify(marketplaceRegistry.parseNaturalQuery(t))) diffs.push(`${t}: parsed`);
        if (read.outsideNorway !== foreignPlaceIn(t)) diffs.push(`${t}: outsideNorway`);
        const theirs = marketplaceRegistry.parseNaturalQuery(t);
        await enrichParsedWithGeo(theirs, t);
        const place = await geocodeSearchPlace(read.parsed, t);
        if (JSON.stringify(read.parsed) !== JSON.stringify(theirs)) diffs.push(`${t}: geocoded`);
        if (!!place !== !!theirs.location) diffs.push(`${t}: place`);
      }
      assertEq(diffs, [], `R readSearchText + geocodeSearchPlace read ${texts.length} searches as parseNaturalQuery + enrichParsedWithGeo (lokal_search's steps)`);

      const { geocodingService } = require("../services/geocoding-service") as typeof import("../services/geocoding-service");
      const extract = geocodingService.extractAndGeocode;
      geocodingService.extractAndGeocode = async () => { throw new Error("geocoder down"); };
      try {
        const down = readSearchText("honning i Trondheim").parsed;
        assertEq([await geocodeSearchPlace(down, "honning i Trondheim"), down.location], [null, undefined],
          "R geocodeSearchPlace: a geocoder that throws leaves the search nationwide, as enrichParsedWithGeo does");
      } finally {
        geocodingService.extractAndGeocode = extract;
      }
      const placed = { ...readSearchText("honning Trondheim").parsed, location: { lat: 1, lng: 2 } };
      surfaces.asked.length = 0;
      assertEq([await geocodeSearchPlace(placed, "honning Trondheim i Finnes"), placed.location, surfaces.asked], [null, { lat: 1, lng: 2 }, []],
        "R geocodeSearchPlace: a location already there is kept, and nothing is looked up");

      const parsed = readSearchText("Finnes det kransekake").parsed as any;
      const q = discoveryQueryOf(parsed, { limit: 30, offset: 0 }) as any;
      assertEq([q._unknownTerms, q._productTerms, q._nameQuery, q.limit, q.role], [["kransekake"], undefined, undefined, 30, "producer"],
        "R discoveryQueryOf: the parser's unknown words are put back after the parse, unset words stay unset");
      const lamb = readSearchText("Which farms in Innlandet sell lamb?").parsed as any;
      const named = { ...readSearchText("honning").parsed, _nameQuery: "Grini", _unknownTerms: ["x"] } as any;
      assertEq([(discoveryQueryOf(lamb, { limit: 5, offset: 0 }) as any)._productTerms, (discoveryQueryOf(named, { limit: 5, offset: 0 }, ["_productTerms", "_unknownTerms"]) as any)._nameQuery,
        (discoveryQueryOf(named, { limit: 5, offset: 0 }, ["_productTerms", "_unknownTerms"]) as any)._unknownTerms],
      [["lam", "lammekjøtt"], undefined, ["x"]], "R discoveryQueryOf: product words kept; only the words asked for are put back");
      assertEq([...PARSED_SEARCH_TERMS], ["_productTerms", "_nameQuery", "_unknownTerms"], "R the words discover() reads that the schema drops");
      const viaSchema = discoveryQueryOf(lamb, { maxDistanceKm: 50, limit: 30, offset: 0, location: undefined });
      assertEq([viaSchema.maxDistanceKm, viaSchema.location, viaSchema.categories], [50, undefined, ["meat"]], "R discoveryQueryOf: the fields given win over the parsed ones");

      // The texts, word for word with lokal_search's (routes/mcp.ts keeps its own copies).
      for (const qa of ABROAD_QUERIES) {
        const place = foreignPlaceIn(qa)!;
        assertEq(outsideNorwayText(place), await surfaces.search(qa), `R outsideNorwayText(«${place}») is lokal_search's text`);
        assertEq(outsideNorwayText(place), `${outsideNorwayText(place, "no")} / ${outsideNorwayText(place, "en")}`, `R outsideNorwayText(«${place}»): Norwegian / English`);
      }
      assertEq(noProductMatchText(["zzzqqx", "qqqzzx"]), await surfaces.search("zzzqqx qqqzzx"), "R noProductMatchText for two words is lokal_search's text");
      assertEq(noProductMatchText(["zzzqqx"]), `🔎 ${noProductMatchText(["zzzqqx"], "no")} / ${noProductMatchText(["zzzqqx"], "en")}`,
        "R noProductMatchText: «🔎 » Norwegian / English; one language without the mark, for the web page");
    }

    // ══ C  counting a page of no matches ══════════════════════════════════
    {
      const area = { ...marketplaceRegistry.parseNaturalQuery("zzzqqx"), location: { lat: 59.8901, lng: 10.5267 }, maxDistanceKm: 25, limit: 20, offset: 0 } as any;
      const counts = () => [GRINI, BAERUMNAVN, BYBAKST].map(discovered);
      const c0 = counts();
      const shown: any = {};
      const page = marketplaceRegistry.discover(area, shown);
      const c1 = counts();
      assertEq([page.length, shown.unmatchedTerms, c1.map((c, i) => c - c0[i])], [3, ["zzzqqx"], [1, 1, 1]],
        "C by default a page of producers that match nothing is counted (lokal_search lists it), as before");
      const hidden: any = {};
      marketplaceRegistry.discover(area, hidden, { countUnmatched: false });
      assertEq([hidden.unmatchedTerms, counts()], [["zzzqqx"], c1], "C countUnmatched: false counts nobody for it");
      const matched = { ...marketplaceRegistry.parseNaturalQuery("kransekake"), location: { lat: 59.8901, lng: 10.5267 }, maxDistanceKm: 25, limit: 20, offset: 0 } as any;
      const g = discovered(GRINI);
      marketplaceRegistry.discover(matched, {}, { countUnmatched: false });
      assertEq(discovered(GRINI) - g, 1, "C countUnmatched: false still counts a page of matches");
      const off = discovered(GRINI);
      marketplaceRegistry.discover(matched, {}, { trackDiscovery: false, countUnmatched: true });
      assertEq(discovered(GRINI), off, "C trackDiscovery: false counts nothing, as before");
    }
  } catch (err: any) {
    failed++;
    failures.push("rfb-a2a-sok-paritet: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    s?.restore();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  if (process.argv.includes("--print")) {
    // main's answers for the fixture (see the header).
    paritetMainCapture().then((answers) => {
      console.log(JSON.stringify({
        _source: "Captured with paritetMainCapture() in src/routes/rfb-a2a-sok-paritet.test.ts (npx tsx src/routes/rfb-a2a-sok-paritet.test.ts --print)",
        ...answers,
      }, null, 1));
      process.exit(0);
    }).catch((err) => { console.error(err); process.exit(1); });
  } else {
    runRfbA2aSokParitetTests({ log: true }).then((s) => {
      console.log(`\n${s.passed} passed, ${s.failed} failed`);
      for (const f of s.failures) console.log(f);
      // Explicit exit: requiring the route modules leaves background timers open.
      process.exit(s.failed > 0 ? 1 : 0);
    });
  }
}
