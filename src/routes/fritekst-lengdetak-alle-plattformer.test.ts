/**
 * fritekst-lengdetak-alle-plattformer.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-Y (FUNN
 * rfb-sok-fritekst-uten-lengdetak, P2).
 *
 * Free text reached the RFB parser with no length cap: MCP lokal_search,
 * A2A message/send, GET /api/marketplace/search and GET /sok. The parser and
 * better-sqlite3 are synchronous, so a 1 MB search blocked the one Node
 * process of all three platforms for about 9 s. utils/free-text.ts now holds
 * one cap (MAX_FREE_TEXT_CHARS, the 2000 the Opplevagent and Finn-tannlege
 * A2A handlers already used) and one helper, capFreeText(), which cuts at a
 * word boundary. The handlers call it before anything reads the text.
 *
 *   H   capFreeText(): text within the cap is returned as is; longer text
 *       keeps its whole words up to the cap; one very long word is cut at
 *       the cap, never inside a surrogate pair; it never rejects.
 *   T   every mapped free-text entry: a 1 MB search (a real search, filler
 *       words, and a last word far beyond the cap) answers exactly as its
 *       first MAX_FREE_TEXT_CHARS characters do, and is no error:
 *         RFB            MCP lokal_search, A2A message/send, GET
 *                        /api/marketplace/search, GET /sok, MCP
 *                        lokal_find_offers, GET /api/marketplace/catalog/offers
 *         Opplevagent    MCP discover_experiences (reads 300 characters, as
 *                        before), A2A message/send, GET /sok, GET
 *                        /for-tilbydere/finn, GET /api/opplevelser/discover
 *                        with category=gardssalg_smaking and q
 *         Finn-tannlege  MCP tannlege_search, A2A message/send (text, and
 *                        the DataPart's free-text q), GET /sok, GET
 *                        /api/tannlege/agents?q=
 *   D   the same call, deterministic: no more than MAX_FREE_TEXT_CHARS
 *       characters of the text reach SQLite (every catalog lookup and log
 *       row of the three platforms, but RFB's A2A task row, which keeps the
 *       request as sent; a spy on better-sqlite3) or RFB's parser (a spy on
 *       marketplaceRegistry.parseNaturalQuery). The Opplevagent and
 *       Finn-tannlege parsers are plain module exports, which a spy cannot
 *       replace; SQLite and T's answer are their check. Then a loose time
 *       check per platform: its slowest entry answers the 1 MB search in at
 *       most 250 ms (best of 3). The cap is what bounds the time; 250 ms only
 *       catches a regression without failing on a busy machine.
 *   C   control: within the cap the last word changes the answer, so T's
 *       «the same answer» means it was not read. Not for tannlege_search:
 *       its parser reads 256 characters (MAX_QUERY_CHARS) and its answer
 *       echoes no more of the text. R covers it instead: with the parser
 *       switched off (DENTAL_QUERY_PARSER_DISABLED=1) the whole text was a
 *       LIKE pattern, and a 1 MB one is a search error. Nor for GET
 *       /api/tannlege/agents: its q is one LIKE pattern over the whole text,
 *       which no filler text matches, and the answer echoes none of it; D
 *       and T's «no error» cover it (a 1 MB q was an HTTP 500 on main).
 *   W   the word the cut splits is dropped. RFB's parser matches whole
 *       words, so a piece of a word would be read as a word of its own:
 *       «ost» (cheese) of «ostehøvel». The Opplevagent and Finn-tannlege A2A
 *       handlers cut message text at 2000 in the middle of a word and read
 *       the piece before the cut: «Bergen» of «Bergensbanen» as the kommune,
 *       «Oslo» of «Osloveien» as the fylke.
 *   B1  searches within the cap answer byte for byte as main did: the
 *       ChatGPT test sets (chatgpt-app-submission.json for RFB,
 *       opplevagent-chatgpt-app-submission.json for Opplevagent), the
 *       acceptance searches of I-W and I-W2 on every RFB entry, the
 *       Finn-tannlege searches of I-X, and searches for the offers, the
 *       gårdssalg producers and the clinic names.
 *       tests/fixtures/fritekst-lengdetak-i-y-main.json holds the sha256 of
 *       each answer (ids, timestamps, origins and the footers' copyright
 *       year masked), captured with b1Answers() below on main ad67dba6. The
 *       answers are whole responses, so the four HTML pages (RFB, Opplevagent
 *       and Finn-tannlege /sok, Opplevagent /for-tilbydere/finn) are hashed
 *       with their head, header and footer: a later change to one of those
 *       templates moves their rows too. When such a change is meant, capture
 *       the answers again with
 *         npx tsx src/routes/fritekst-lengdetak-alle-plattformer.test.ts --print
 *       and put its `answers` into the fixture. B1 also runs once with
 *       Date.prototype.getFullYear() a year on (the footers' source), so the
 *       golden holds after New Year. The I-X messages themselves keep their
 *       own golden (a2a-datapart-alle-plattformer.test.ts).
 *
 * Not checked here: the args that lokal_search, lokal_find_offers and
 * tannlege_search hand deliver() (the cut text). They reach the delivery log
 * only inside a hash (listKey, services/profile-ai-deliveries.ts), so neither
 * D's spy nor an answer shows whether they were cut.
 *
 * Not mapped here, on purpose (each needs its own cap or slice; slice I-Y2
 * caps all but the task row, dyre-oppslag-tak.test.ts):
 *   - place fields: Opplevagent /sok's `sted`, lokal_find_offers' `near`,
 *     lokal_geocode, GET /api/marketplace/geocode and lokal_bm_next_markets'
 *     `region` (a LIKE over the event's place, echoed in an empty answer);
 *   - structured DataPart fields other than dental's free-text q (RFB
 *     data.query, dental data.fylke, Opplevagent data.*);
 *   - GET /api/marketplace/find-match?name= (an edit distance over the whole
 *     name per producer; needs a much lower cap of its own);
 *   - the number of lokal_find_offers items (each item is capped here);
 *   - RFB's A2A task row, which stores the request's params as sent.
 * Already bounded before I-Y: the Opplevagent REST and MCP experience text
 * (300 characters) and MCP discover_gardssalg's query (schema max 200).
 *
 * Data: own in-memory DBs (main, dental, experiences; restored in finally),
 * geocoding offline, the real handlers: MCP tools through a duck-typed
 * server, the GET routes' own handlers (past generalLimiter, whose bucket
 * other suites share), A2A through router.handle(). No HTTP server, no
 * network. Tool metadata and the agent cards are not touched by I-Y; their
 * freezes are rfb-mcp-contract-freeze.test.ts,
 * opplevagent-mcp-contract-freeze.test.ts, dental-mcp-instructions.test.ts
 * and services/dental-agent-card.test.ts.
 *
 * Exported runFritekstLengdetakAllePlattformerTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/fritekst-lengdetak-alle-plattformer.test.ts [--print]
 */

import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { __pinInMemoryDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import { capFreeText, MAX_FREE_TEXT_CHARS } from "../utils/free-text";
import type { Seed, CatalogRow } from "./rfb-kategorietiketter-ikke-tilbud.test";
import { enterFixtures as enterRfbDb, captureTools, textOf } from "./rfb-sok-ukjente-ord-bakeri-sted.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** An entry's answer to one text, as one string with what differs per run masked. */
type Ask = (text: string) => Promise<string>;

export const ONE_MB = 1024 * 1024;
export const FILLER = " og";

/** `base`, FILLER up to 1 MB, then ` ${last}`: the last word lies far beyond the cap. */
export function oneMegabyte(base: string, last: string): string {
  return base + FILLER.repeat(Math.ceil((ONE_MB - base.length - last.length - 1) / FILLER.length)) + " " + last;
}

/**
 * The answer with what differs per run masked: ids, timestamps, Date.now()
 * task ids, slug suffixes, origins, and the copyright year of the HTML
 * pages' footers (new Date().getFullYear() in seo.ts, experiences-seo.ts and
 * dental-seo.ts), so the golden holds after New Year.
 */
export function stable(v: unknown): string {
  return (typeof v === "string" ? v : JSON.stringify(v))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/-\d{13}\b/g, "-<now>")
    .replace(/--[0-9a-f]{8}(?![0-9a-z])/g, "--<id8>")
    .replace(/https?:\/\/[^/"'\s<>]+/g, "<origin>")
    .replace(/(©|&copy;)(\s*)\d{4}\b/g, "$1$2<year>");
}

// ─── Route drivers ────────────────────────────────────────────────────────

let ipSeq = 0;
/** A fresh client address per call, so the per-IP caps never decide an answer here. */
function nextIp(): string {
  ipSeq++;
  return `10.125.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

/** A response object for the handlers: settles on json/send/redirect/end; an EventEmitter (recordA2aDelivery waits for "finish", never sent). */
function mockRes(settle: (status: number, body: unknown) => void): any {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    locals: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    header() { return this; },
    set() { return this; },
    type() { return this; },
    append() { return this; },
    json(payload: unknown) { settle(this.statusCode, payload); return this; },
    send(payload: unknown) { settle(this.statusCode, payload); return this; },
    redirect(a: number | string, b?: string) {
      settle(typeof a === "number" ? a : 302, { redirect: typeof a === "number" ? b : a });
      return this;
    },
    end() { settle(this.statusCode, undefined); return this; },
  });
}

/** The last handler of a GET route: past generalLimiter, whose bucket other suites share. */
export function routeHandler(router: any, routePath: string): Function {
  const layer = (router.stack as any[]).find((l: any) => l.route?.path === routePath && l.route.methods?.get);
  if (!layer) throw new Error(`route not found: GET ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** GET through a route handler with `query`; the answer as { status, body }. */
export function getRoute(handler: Function, query: Record<string, string>, hostname: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "user-agent": "curl/8.5.0", host: hostname };
    const req: any = {
      method: "GET", url: "/", path: "/", originalUrl: "/", params: {}, query, headers, ip,
      socket: { remoteAddress: ip }, lang: "no", protocol: "https", hostname,
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    let settled = false;
    const res = mockRes((status, body) => { if (!settled) { settled = true; resolve({ status, body }); } });
    try {
      const p = handler(req, res, (err?: unknown) => { if (!settled) { settled = true; resolve({ status: err ? 500 : 404, body: String(err ?? "next") }); } });
      if (p && typeof p.catch === "function") p.catch((err: unknown) => { if (!settled) { settled = true; resolve({ status: 500, body: String(err) }); } });
    } catch (err) {
      if (!settled) { settled = true; resolve({ status: 500, body: String(err) }); }
    }
  });
}

/** POST /a2a message/send through router.handle(). */
export function postA2a(router: any, params: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
    const req: any = {
      method: "POST", url: "/a2a", originalUrl: "/a2a", path: "/a2a", query: {}, headers,
      body: { jsonrpc: "2.0", method: "message/send", params, id: "y" },
      ip, socket: { remoteAddress: ip },
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    const res = mockRes((status, body) => resolve({ status, body }));
    router.handle(req, res, (err?: unknown) => resolve({ status: err ? 500 : 404, body: String(err ?? "no route") }));
  });
}

export const textMessage = (text: string) => ({ message: { role: "user", parts: [{ kind: "text", text }] } });
/** A message of one standard DataPart with the free-text `q` (I-X, utils/a2a-message.ts). */
const qDataMessage = (q: string) => ({ message: { role: "user", parts: [{ kind: "data", data: { q } }] } });

export type ToolHandler = (args: any, extra?: any) => Promise<any>;
/** A tool registry's handlers, through a duck-typed server. */
export function duckTools(register: (server: any) => void): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  register({
    registerTool(name: string, _config: unknown, handler: ToolHandler) { tools.set(name, handler); },
    registerResource() {}, registerPrompt() {}, resource() {}, prompt() {},
  });
  return tools;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

const rid = (n: number) => `1a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function seed(n: number, name: string, lat: number, lng: number, city: string, categories: string[], catalog: CatalogRow[]): Seed {
  return {
    id: rid(n), name, lat, lng, city, categories,
    products: catalog.map((c) => ({ name: c.name, category: c.category ?? categories[0], ...(c.priceNok ? { price: `${c.priceNok} kr` } : {}) })),
    catalog,
  };
}

/**
 * RFB producers for the test sets and the I-W and I-W2 acceptance searches.
 * Own seeds (not I-W's), so a later slice that adds to those fixtures does
 * not move this golden.
 */
const RFB_SEEDS: Seed[] = [
  seed(1, "Grini Hjemmebakeri Lengdetak", 59.935, 10.555, "Bærum", ["bakery"],
    [{ name: "Kransekake 18 ringer boks", priceNok: 395 }, { name: "Surdeigsbrød", priceNok: 65 }]),
  seed(2, "Flatøy Hjemmebakeri Lengdetak", 59.2181, 10.9298, "Fredrikstad", ["bakery"], [{ name: "Kransekake bryllup" }]),
  seed(3, "Nidaros Bakehus Lengdetak", 63.433, 10.4, "Trondheim", ["bakery"], [{ name: "Grovbrød", priceNok: 55 }]),
  seed(4, "Tirslaug Birøkt Lengdetak", 63.46, 10.46, "Trondheim", ["honey"], [{ name: "Lynghonning", priceNok: 150 }]),
  seed(5, "Asker Egg Lengdetak", 59.84, 10.43, "Asker", ["eggs"], [{ name: "Egg", priceNok: 50 }]),
  seed(6, "Godt Fra Fjellet Lengdetak", 61.58, 9.93, "Sør-Fron", ["meat"], [{ name: "Lammekjøtt", priceNok: 300 }, { name: "Spekepølse", priceNok: 120 }]),
  seed(7, "Finnmark Kjøtt Lengdetak", 70.66, 23.68, "Hammerfest", ["meat"], [{ name: "Reinsdyrkjøtt", priceNok: 450 }]),
  seed(8, "TønsbergBier Lengdetak", 59.267, 10.408, "Tønsberg", ["honey"], [{ name: "Honning", priceNok: 150 }]),
  seed(9, "Sverdrup Reine Lengdetak", 67.93, 13.09, "Reine", ["fish"], [{ name: "Tørrfisk", priceNok: 200 }]),
  seed(10, "Ostegården — Krokeide", 60.29, 5.27, "Bergen", ["dairy"], [{ name: "Lagret Fanaost", priceNok: 190 }]),
  seed(11, "Bærhagen Lengdetak", 58.97, 5.7331, "Stavanger", ["preserves"], [{ name: "Bringebærsyltetøy", priceNok: 120 }]),
];

/** The registry's caches (agents, stats, slugs), which an earlier suite in the process may have filled. */
function clearRegistryCaches(): void {
  const registry = (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry as any;
  registry._agentsCache = null;
  registry._agentsCacheTime = 0;
  registry._statsCache = null;
  registry._statsCacheTime = 0;
  registry._slugIdMap = null;
}

/** What the fixtures drive: the entries (`asks`), the tool handlers and the A2A routers. Exported for slice I-Y2. */
export interface Fixture {
  asks: Record<string, Ask>;
  tools: Record<string, Map<string, ToolHandler>>;
  a2a: Record<string, any>;
  restore: () => void;
}

/** Fresh in-memory main DB with RFB_SEEDS, geocoding offline (I-W's enterFixtures); the RFB entries. */
export function enterRfb(): Fixture {
  const db = enterRfbDb(RFB_SEEDS);
  clearRegistryCaches();
  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    const { a2aConversationCap } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
    a2aConversationCap.reset();
    const tools = captureTools();
    const a2aRouter = (require("./a2a") as any).default;
    const search = routeHandler((require("./marketplace") as any).default, "/search");
    const sok = routeHandler((require("./seo") as any).default, "/sok");
    const offers = routeHandler((require("./marketplace-catalog") as typeof import("./marketplace-catalog")).catalogRouter, "/offers");
    const host = "rettfrabonden.com";
    const trondheim = { lat: 63.4305, lng: 10.3951 };
    const asks: Record<string, Ask> = {
      "rfb mcp lokal_search": async (t) => stable(textOf(await tools.get("lokal_search")!({ query: t, limit: 10 }))),
      "rfb a2a message/send": async (t) => stable(await postA2a(a2aRouter, textMessage(t))),
      "rfb GET /api/marketplace/search": async (t) => stable(await getRoute(search, { q: t }, host)),
      "rfb GET /sok": async (t) => stable(await getRoute(sok, { q: t }, host)),
      "rfb mcp lokal_find_offers": async (t) => stable(textOf(await tools.get("lokal_find_offers")!({ items: [t], ...trondheim }))),
      "rfb GET /api/marketplace/catalog/offers": async (t) =>
        stable(await getRoute(offers, { q: t, lat: String(trondheim.lat), lng: String(trondheim.lng), radius_km: "500" }, host)),
    };
    return {
      asks,
      tools: { rfb: tools },
      a2a: { rfb: a2aRouter },
      restore: () => {
        a2aConversationCap.reset();
        db.restore();
        clearRegistryCaches();
      },
    };
  } catch (err) {
    db.restore();
    clearRegistryCaches();
    throw err;
  }
}

/** Fresh in-memory DBs for Finn-tannlege and Opplevagent (and a pinned main DB), geocoding offline; their entries. */
export function enterVerticals(): Fixture {
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ["DENTAL_DB_PATH", "EXPERIENCES_DB_PATH", "DENTAL_QUERY_PARSER_DISABLED", "BOOKING_DISPATCH_ENABLED"]) prevEnv[k] = process.env[k];
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  delete process.env.BOOKING_DISPATCH_ENABLED;
  const restoreMainDb = __pinInMemoryDbForTesting();
  // Opplevagent's /sok tries a route («Oslo til Bergen») through the geocoder.
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental"),
    require.resolve("./dental-a2a"),
    require.resolve("./dental-mcp"),
    require.resolve("./dental-seo"),
    require.resolve("../services/experience-store"),
    require.resolve("./experiences-a2a"),
    require.resolve("./experiences-mcp"),
    require.resolve("./experiences-seo"),
    require.resolve("./opplevelser"),
  ]);
  const restore = () => {
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
    restoreMainDb();
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();

    // Finn-tannlege
    const dentalStore = require("../services/dental-store") as typeof import("../services/dental-store");
    const addClinic = (row: Record<string, unknown>) => dentalStore.createDentalAgent({ telefon: "22000000", ...row } as any);
    addClinic({ navn: "Oslo Sentrum Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0150", org_nr: "912345678" });
    addClinic({ navn: "Majorstua Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0151", helfo_agreement: "true" });
    addClinic({ navn: "Bergen Tann", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003" });
    addClinic({ navn: "Fana Regulering", poststed: "BERGEN", fylke: "Vestland", postnummer: "5004", available_specialties: ["kjeveortopedi"] });
    addClinic({ navn: "Stavanger Tann", poststed: "STAVANGER", fylke: "Rogaland", postnummer: "4006" });

    // Opplevagent
    const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
    const providerId = expStore.createProvider({
      navn: "Nordlys Opplevelser AS", fylke: "Troms", kommune: "Tromsø",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    } as any);
    const addExperience = (title: string, kommune: string, fylke: string, extra: Record<string, unknown>) =>
      expStore.createExperience({
        title, provider_id: providerId, provider_match_status: "matched", kommune, fylke, category: "natur",
        verification_status: "verified", confidence: "high", price_from: 500, duration_min: 90,
        indoor_outdoor: "outdoor", weather_dependent: 1, ...extra,
      } as any);
    addExperience("Nordlysjakt fra Tromsø", "Tromsø", "Troms", { season: ["winter"], lat: 69.65, lng: 18.95 });
    addExperience("Hvalsafari fra Tromsø", "Tromsø", "Troms", { season: ["winter"], category: "dyreliv_safari", lat: 69.66, lng: 18.96 });
    addExperience("Nordlyscruise fra Bergen", "Bergen", "Vestland", { season: ["winter"], lat: 60.39, lng: 5.32 });
    // Gårdssalg producers: createProvider() sets no producer_type or slug.
    const expDb = dbFactory.getDb("experiences");
    const addFarmShop = (navn: string, slug: string, producerType: string, kommune: string, poststed: string, fylke: string) => {
      const id = expStore.createProvider({
        navn, fylke, kommune, poststed, brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      } as any);
      expDb.prepare("UPDATE experience_providers SET producer_type = ?, slug = ? WHERE id = ?").run(producerType, slug, id);
    };
    addFarmShop("Fjordgard Bryggeri", "fjordgard-bryggeri", "bryggeri", "Ullensvang", "ODDA", "Vestland");
    addFarmShop("Hardanger Sideri", "hardanger-sideri", "sideri", "Ullensvang", "LOFTHUS", "Vestland");
    addFarmShop("Egge Gård", "egge-gard", "sideri", "Lier", "LIER", "Buskerud");

    const dentalTools = duckTools((s) => (require("./dental-mcp") as typeof import("./dental-mcp")).registerDentalTools(s));
    const oaTools = duckTools((s) => (require("./experiences-mcp") as typeof import("./experiences-mcp")).registerExperienceTools(s));
    const dentalA2a = (require("./dental-a2a") as any).default;
    const oaA2a = (require("./experiences-a2a") as any).default;
    const dentalSok = routeHandler((require("./dental-seo") as any).default, "/sok");
    const dentalAgents = routeHandler((require("./dental") as any).default, "/agents");
    const oaSeo = (require("./experiences-seo") as any).default;
    const oaSok = routeHandler(oaSeo, "/sok");
    const oaFinn = routeHandler(oaSeo, "/for-tilbydere/finn");
    const oaDiscover = routeHandler((require("./opplevelser") as any).default, "/discover");
    const oaHost = "opplevagent.no";
    const asks: Record<string, Ask> = {
      "oa mcp discover_experiences": async (t) => stable(await oaTools.get("discover_experiences")!({ query: t, limit: 10 })),
      "oa a2a message/send": async (t) => stable(await postA2a(oaA2a, textMessage(t))),
      "oa GET /sok": async (t) => stable(await getRoute(oaSok, { q: t }, oaHost)),
      "oa GET /for-tilbydere/finn": async (t) => stable(await getRoute(oaFinn, { q: t }, oaHost)),
      "oa GET /api/opplevelser/discover gardssalg": async (t) =>
        stable(await getRoute(oaDiscover, { category: "gardssalg_smaking", q: t }, oaHost)),
      "dental mcp tannlege_search": async (t) => stable(await dentalTools.get("tannlege_search")!({ query: t, limit: 10 })),
      "dental a2a message/send": async (t) => stable(await postA2a(dentalA2a, textMessage(t))),
      "dental a2a message/send data.q": async (t) => stable(await postA2a(dentalA2a, qDataMessage(t))),
      "dental GET /sok": async (t) => stable(await getRoute(dentalSok, { q: t }, "finn-tannlege.com")),
      "dental GET /api/tannlege/agents": async (t) => stable(await getRoute(dentalAgents, { q: t }, "finn-tannlege.com")),
    };
    return { asks, tools: { dental: dentalTools, oa: oaTools }, a2a: { dental: dentalA2a, oa: oaA2a }, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

// ─── B1 ───────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "../..");
/** The user prompts of a ChatGPT app submission file (test_cases and negative_test_cases). */
function submissionPrompts(file: string): string[] {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")) as { test_cases: Array<{ user_prompt: string }>; negative_test_cases: Array<{ user_prompt: string }> };
  return [...d.test_cases, ...d.negative_test_cases].map((t) => t.user_prompt);
}
const RFB_PROMPTS = submissionPrompts("chatgpt-app-submission.json");
const OA_PROMPTS = submissionPrompts("opplevagent-chatgpt-app-submission.json");

/** The acceptance searches of I-W and I-W2 (dev-request 2026-10-17-integrasjonstest-oppfolging). */
const RFB_ACCEPTANCE = [
  "kransekake", "kransekake i Bærum", "bakervarer i Trondheim", "zzzqqx",
  "Finnes", "Mellom", "Bondens", "Godt", "Norsk", "Topp",
  "Jeg ser etter kransekake", "Finnes det noen som lager kransekake", "Which bakeries make kransekake",
  "kransekake til jul", "stor kransekake", "kransekake til lunsj", "kransekake til selskap", "kransekake som gave",
  "syltetøy til frokost", "spekepølse som gave",
];
/**
 * The RFB searches for the entries other than lokal_search. «Find a farm in
 * Vestfold with raw honey» is lokal_search's only: its «farm» makes it a
 * Pass 1 search, which I-W3 rewrites, and A2A and the REST search echo the
 * parsed query.
 */
const RFB_PARSED_ECHO_TEXTS = [...RFB_PROMPTS.filter((p) => !/\bfarm\b/i.test(p)), ...RFB_ACCEPTANCE];

/** Names and places of the gårdssalg producers, as an owner or a guest types them. */
const FARM_SHOP_SEARCHES = ["Fjordgard", "Fjordgard Bryggeri", "sideri", "sideri Hardanger", "Ullensvang", "Egge gård", "zzzqqx"];
/** The Finn-tannlege searches of I-X. */
const DENTAL_SEARCHES = ["tannlege i Oslo", "tannlege i Bergen", "kjeveortoped Bergen", "Finn klinikk 912 345 678", "912345678", "tannlege 0150 Oslo", "ring 22 33 44 55"];
/** A clinic name or place as written (a LIKE over navn and poststed). */
const CLINIC_NAME_SEARCHES = ["Bergen", "BERGEN", "Oslo Sentrum Tann", "majorstua", "Stavanger Tann", "zzzqqx"];

/** Per entry, the searches whose answers must be main's. */
export const B1_PLAN: Readonly<Record<string, readonly string[]>> = {
  "rfb mcp lokal_search": [...RFB_PROMPTS, ...RFB_ACCEPTANCE],
  "rfb a2a message/send": RFB_PARSED_ECHO_TEXTS,
  "rfb GET /api/marketplace/search": RFB_PARSED_ECHO_TEXTS,
  "rfb GET /sok": RFB_PARSED_ECHO_TEXTS,
  "rfb mcp lokal_find_offers": ["honning", "kransekake", "egg", "Lynghonning", "grovbrød"],
  "rfb GET /api/marketplace/catalog/offers": ["honning", "kransekake", "egg", "Lynghonning", "grovbrød"],
  "oa mcp discover_experiences": OA_PROMPTS,
  "oa a2a message/send": OA_PROMPTS,
  "oa GET /sok": [...OA_PROMPTS, "nordlys", "hvalsafari Tromsø", "Oslo til Bergen", ...FARM_SHOP_SEARCHES],
  "oa GET /for-tilbydere/finn": FARM_SHOP_SEARCHES,
  "oa GET /api/opplevelser/discover gardssalg": FARM_SHOP_SEARCHES,
  "dental mcp tannlege_search": DENTAL_SEARCHES,
  "dental a2a message/send": DENTAL_SEARCHES,
  "dental a2a message/send data.q": CLINIC_NAME_SEARCHES,
  "dental GET /sok": DENTAL_SEARCHES,
  "dental GET /api/tannlege/agents": CLINIC_NAME_SEARCHES,
};

type B1Answers = Record<string, Record<string, { sha256: string; chars: number }>>;

/**
 * Each entry's answers to its searches (B1_PLAN, or `plan`) on fresh
 * fixtures: the sha256 and length of the masked answer. Uses only what main
 * has, so main's answers are captured with it.
 */
export async function b1Answers(plan: Readonly<Record<string, readonly string[]>> = B1_PLAN): Promise<B1Answers> {
  const out: B1Answers = {};
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  try {
    for (const enter of [enterRfb, enterVerticals]) {
      const fx = enter();
      try {
        for (const [entry, ask] of Object.entries(fx.asks)) {
          for (const text of plan[entry] ?? []) {
            const answer = await ask(text);
            (out[entry] ??= {})[text] = { sha256: createHash("sha256").update(answer).digest("hex"), chars: answer.length };
          }
        }
      } finally {
        fx.restore();
      }
    }
    return out;
  } finally {
    console.log = prevLog;
  }
}

const B1_FIXTURE = path.join(ROOT, "tests/fixtures/fritekst-lengdetak-i-y-main.json");

// ─── T / C / W ────────────────────────────────────────────────────────────

/** Per entry, a real search and a last word that changes its answer when it is read. */
const PROBES: Readonly<Record<string, { base: string; last: string; control: boolean }>> = {
  "rfb mcp lokal_search": { base: "honning", last: "egg", control: true },
  "rfb a2a message/send": { base: "honning", last: "egg", control: true },
  "rfb GET /api/marketplace/search": { base: "honning", last: "egg", control: true },
  "rfb GET /sok": { base: "honning", last: "egg", control: true },
  "rfb mcp lokal_find_offers": { base: "honning", last: "egg", control: true },
  "rfb GET /api/marketplace/catalog/offers": { base: "honning", last: "egg", control: true },
  "oa mcp discover_experiences": { base: "nordlys", last: "Tromsø", control: true },
  "oa a2a message/send": { base: "nordlys", last: "Tromsø", control: true },
  "oa GET /sok": { base: "nordlys", last: "Tromsø", control: true },
  "oa GET /for-tilbydere/finn": { base: "Fjordgard", last: "Ullensvang", control: true },
  "oa GET /api/opplevelser/discover gardssalg": { base: "sideri", last: "Ullensvang", control: true },
  // The parser reads 256 characters (MAX_QUERY_CHARS) and the answer echoes no more: no control.
  "dental mcp tannlege_search": { base: "tannlege i Bergen", last: "Oslo", control: false },
  "dental a2a message/send": { base: "tannlege i Bergen", last: "Oslo", control: true },
  "dental a2a message/send data.q": { base: "Bergen", last: "Oslo", control: true },
  "dental GET /sok": { base: "tannlege i Bergen", last: "Oslo", control: true },
  // One LIKE pattern over the whole text, which no filler text matches, and no echo: no control.
  "dental GET /api/tannlege/agents": { base: "Bergen", last: "Oslo", control: false },
};

/** D's loose time check: a platform's slowest entry, best of 3 (the cap bounds the time; see the header). */
const LOOSE_LIMIT_MS = 250;

/** The longest run of FILLER in `s`, in characters: how much of a probe's filler text `s` holds. */
export function fillerRun(s: string): number {
  let longest = 0;
  for (let i = s.indexOf(FILLER); i !== -1; ) {
    let end = i;
    while (s.startsWith(FILLER, end)) end += FILLER.length;
    longest = Math.max(longest, end - i);
    i = s.indexOf(FILLER, end);
  }
  return longest;
}

export interface SeenInputs {
  /** Strings bound to SQLite statements (or SQL texts prepared) during the call. */
  sqlStrings: number;
  /** The most of the probe's filler text (fillerRun) in any of them. */
  sqlText: number;
  /** The longest text RFB's parser (marketplaceRegistry.parseNaturalQuery) got; 0 when not called. */
  parserChars: number;
}

/**
 * The one SQLite row D leaves out: RFB's A2A task row, which keeps the
 * request's params as sent (tasks/get returns them) and which no search
 * reads. It is not free text read before parsing (FUNN in the PR).
 */
const STORED_AS_SENT = /^\s*INSERT INTO tasks \(/;

/**
 * D: what `call` hands on. A spy on better-sqlite3, which all three platforms
 * use for every catalog lookup and log row (the SQL text of each prepare(),
 * every bound value of run/get/all/iterate/bind, except STORED_AS_SENT), and
 * one on RFB's parser. Both are restored in finally.
 */
export async function watchInputs(call: () => Promise<unknown>): Promise<SeenInputs> {
  const seen: SeenInputs = { sqlStrings: 0, sqlText: 0, parserChars: 0 };
  const note = (v: unknown, nested = false): void => {
    if (typeof v === "string") {
      seen.sqlStrings++;
      seen.sqlText = Math.max(seen.sqlText, fillerRun(v));
    } else if (!nested && v && typeof v === "object" && !Buffer.isBuffer(v)) {
      for (const x of Array.isArray(v) ? v : Object.values(v)) note(x, true);
    }
  };
  const scratch = new Database(":memory:");
  const statement = Object.getPrototypeOf(scratch.prepare("SELECT 1")) as Record<string, Function>;
  scratch.close();
  const database = Database.prototype as unknown as Record<string, Function>;
  const patched: Array<[Record<string, Function>, string, Function]> = [];
  const spy = (target: Record<string, Function>, method: string) => {
    const original = target[method]!;
    patched.push([target, method, original]);
    target[method] = function (this: { source?: unknown }, ...args: unknown[]) {
      if (!STORED_AS_SENT.test(String(this?.source ?? ""))) for (const a of args) note(a);
      return original.apply(this, args);
    };
  };
  for (const m of ["run", "get", "all", "iterate", "bind"]) spy(statement, m);
  spy(database, "prepare");
  const registry = (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry as any;
  const ownParse = Object.prototype.hasOwnProperty.call(registry, "parseNaturalQuery");
  const parse = registry.parseNaturalQuery;
  registry.parseNaturalQuery = function (this: unknown, text: string) {
    seen.parserChars = Math.max(seen.parserChars, String(text).length);
    return parse.call(this, text);
  };
  try {
    await call();
  } finally {
    for (const [target, method, original] of patched.reverse()) target[method] = original;
    if (ownParse) registry.parseNaturalQuery = parse;
    else delete registry.parseNaturalQuery; // the prototype's method again
  }
  return seen;
}

export async function runFritekstLengdetakAllePlattformerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  /** Two answers: the same, or where they first differ. */
  function assertSameAnswer(actual: string, expected: string, label: string): void {
    if (actual === expected) return assertTrue(true, label);
    let i = 0;
    while (actual[i] === expected[i]) i++;
    assertTrue(false,
      `${label} (differs at ${i}: expected …${expected.slice(Math.max(0, i - 40), i + 80)}…, got …${actual.slice(Math.max(0, i - 40), i + 80)}…)`);
  }

  // ══ H  capFreeText() ═════════════════════════════════════════════════════
  {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `ord${i}`).join(" ");
    assertEq(MAX_FREE_TEXT_CHARS, 2000, "H1 the cap is 2000 characters, the value the OA and dental A2A handlers already cut at");
    for (const t of ["", "honning i Oslo", "  honning  ", "x".repeat(MAX_FREE_TEXT_CHARS), words(400).slice(0, MAX_FREE_TEXT_CHARS)]) {
      assertTrue(capFreeText(t) === t, `H2 text of ${t.length} characters (within the cap) is returned as is`);
    }
    const long = words(1000); // «ord0 ord1 … ord999», 6889 characters; character 2000 is inside «ord301»
    const cut = capFreeText(long);
    assertEq(cut, long.slice(0, long.lastIndexOf(" ", MAX_FREE_TEXT_CHARS)), "H3 longer text keeps its whole words up to the cap");
    assertEq(cut.split(" ").at(-1), "ord300", "H3 …the last word kept is whole («ord300»; «ord301», which the cut splits, is dropped)");
    const atGap = "a".repeat(MAX_FREE_TEXT_CHARS - 1) + "  b";
    assertEq(capFreeText(atGap), "a".repeat(MAX_FREE_TEXT_CHARS - 1), "H4 a cut between two words keeps the words before it, without the whitespace");
    const atWordEnd = "a ".repeat(999) + "bc d";
    assertEq(capFreeText(atWordEnd), "a ".repeat(999) + "bc", "H4 a cut right after a word keeps that word");
    const split = "a ".repeat(997) + "Bergensbanen" + FILLER.repeat(500);
    assertEq([split.slice(0, MAX_FREE_TEXT_CHARS).endsWith(" Bergen"), capFreeText(split)], [true, "a ".repeat(997).trimEnd()],
      "H5 a word the cut splits is dropped, so no fragment of it («Bergen» of «Bergensbanen») is read");
    assertEq(capFreeText("x".repeat(ONE_MB)), "x".repeat(MAX_FREE_TEXT_CHARS), "H6 one very long word is cut at the cap (never rejected, never empty)");
    assertEq(capFreeText("   " + "x".repeat(ONE_MB)), "   " + "x".repeat(MAX_FREE_TEXT_CHARS - 3), "H6 …also after leading whitespace");
    const emoji = "x".repeat(MAX_FREE_TEXT_CHARS - 1) + "🍯🍯🍯";
    assertEq(capFreeText(emoji), "x".repeat(MAX_FREE_TEXT_CHARS - 1), "H7 one long word: never cut between the halves of a surrogate pair");
    const nbsp = capFreeText("ord ".repeat(1000));
    assertEq([nbsp.length, nbsp.endsWith("ord")], [1999, true], "H8 a no-break space separates words too");
    const mb = oneMegabyte("honning", "egg");
    let bestCut = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = process.hrtime.bigint();
      capFreeText(mb);
      bestCut = Math.min(bestCut, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assertTrue(bestCut < 5, `H9 cutting 1 MB costs well under 5 ms (it reads at most the first 2000 characters; best of 3: ${bestCut.toFixed(2)} ms)`);
    const lengths = [...RFB_PROMPTS, ...OA_PROMPTS].map((p) => p.length);
    assertTrue(lengths.length >= 16 && Math.max(...lengths) * 10 < MAX_FREE_TEXT_CHARS,
      `H10 the cap covers every real search: the longest ChatGPT test prompt is ${Math.max(...lengths)} characters, under a tenth of the cap`);
  }

  // ══ B1  main's answers, byte for byte ════════════════════════════════════
  {
    const main = JSON.parse(fs.readFileSync(B1_FIXTURE, "utf8")) as { answers: B1Answers };
    const plan: Record<string, string[]> = Object.fromEntries(Object.entries(main.answers).map(([entry, byText]) => [entry, Object.keys(byText)]));
    const now = await b1Answers(plan);
    assertEq(Object.keys(main.answers).sort(), Object.keys(PROBES).sort(), "B1 the fixture covers the mapped entries (PROBES)");
    let compared = 0;
    for (const [entry, byText] of Object.entries(main.answers)) {
      for (const [text, want] of Object.entries(byText)) {
        const got = now[entry]?.[text];
        compared++;
        assertTrue(got?.sha256 === want.sha256, `B1 ${entry} «${text}»: the answer is main's` +
          (got?.sha256 === want.sha256 ? "" : ` (main ${want.chars} characters, now ${got?.chars})`));
      }
    }
    assertTrue(compared >= 200 && RFB_PROMPTS.every((p) => p in (main.answers["rfb mcp lokal_search"] ?? {}))
      && OA_PROMPTS.every((p) => p in (main.answers["oa a2a message/send"] ?? {})),
      `B1 the fixture holds the test sets of both submission files and the I-W/I-W2 searches (${compared} answers)`);

    // The HTML pages print new Date().getFullYear() in their footers. With
    // getFullYear() a year on, every answer must still be main's: stable()
    // masks the footers' year, and no other part of an answer reads it.
    assertEq([stable("Rett fra Bonden © 2026. Gjør"), stable("<span>&copy; 2026 Opplevagent"), stable("tannlege 0150 Oslo, 2026 ©")],
      ["Rett fra Bonden © <year>. Gjør", "<span>&copy; <year> Opplevagent", "tannlege 0150 Oslo, 2026 ©"],
      "B1 stable() masks the copyright year of the footers, and only that year");
    const getFullYear = Date.prototype.getFullYear;
    Date.prototype.getFullYear = function (this: Date) { return getFullYear.call(this) + 1; };
    let nextYear: B1Answers;
    try {
      nextYear = await b1Answers(plan);
    } finally {
      Date.prototype.getFullYear = getFullYear;
    }
    const moved = Object.entries(main.answers).flatMap(([entry, byText]) =>
      Object.entries(byText).filter(([text, want]) => nextYear[entry]?.[text]?.sha256 !== want.sha256).map(([text]) => `${entry} «${text}»`));
    assertEq(moved, [], "B1 with getFullYear() a year on, every answer is still main's (the golden holds after New Year)");
  }

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };
  try {
    /** Per platform (rfb, oa, dental), its slowest entry: best of 3 for the 1 MB search. */
    const slowest: Record<string, { entry: string; ms: number }> = {};
    // One fixture at a time: the vertical fixture pins its own main DB.
    for (const enter of [enterRfb, enterVerticals]) {
      const fx = enter();
      try {
        assertEq(Object.keys(fx.asks).filter((entry) => !PROBES[entry] || !B1_PLAN[entry]), [],
          "T setup: every entry driven here has a probe and B1 searches");
        // ══ T / D / C  every entry ═════════════════════════════════════════
        for (const [entry, ask] of Object.entries(fx.asks)) {
          const probe = PROBES[entry];
          const big = oneMegabyte(probe.base, probe.last);
          const capped = capFreeText(big);
          assertTrue(big.length >= ONE_MB && capped.length <= MAX_FREE_TEXT_CHARS && !capped.includes(probe.last),
            `T ${entry}: setup, a 1 MB search whose last word «${probe.last}» lies beyond the cap`);
          let answer = "";
          const seen = await watchInputs(async () => { answer = await ask(big); });
          assertTrue(seen.sqlStrings > 0 && (!entry.startsWith("rfb ") || /lokal_find_offers|catalog\/offers/.test(entry) || seen.parserChars > 0),
            `D ${entry}: setup, the spies see the call (${seen.sqlStrings} SQL strings, parser ${seen.parserChars} characters)`);
          assertTrue(seen.sqlText <= MAX_FREE_TEXT_CHARS && seen.parserChars <= MAX_FREE_TEXT_CHARS,
            `D ${entry}: at most ${MAX_FREE_TEXT_CHARS} characters of a 1 MB search reach SQLite (${seen.sqlText}) and RFB's parser (${seen.parserChars})`);
          assertTrue(!/"isError":true|"error":\{"code":|"status":5\d\d\b/.test(answer),
            `T ${entry}: a 1 MB search is no error (${answer.slice(0, 160)})`);
          assertSameAnswer(answer, await ask(capped), `T ${entry}: a 1 MB search answers as its first ${MAX_FREE_TEXT_CHARS} characters (whole words)`);
          let best = Infinity;
          for (let run = 0; run < 3; run++) {
            const t0 = process.hrtime.bigint();
            await ask(big);
            best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
          }
          const platform = entry.split(" ")[0]!;
          if (!slowest[platform] || best > slowest[platform].ms) slowest[platform] = { entry, ms: best };
          if (probe.control) {
            const near = probe.base + FILLER.repeat(50);
            assertTrue(await ask(`${near} ${probe.last}`) !== await ask(near),
              `C ${entry}: within the cap «${probe.last}» after the filler changes the answer (so T's answer did not read it)`);
          }
        }

        // ══ R  tannlege_search with the parser switched off ═════════════════
        if (fx.asks["dental mcp tannlege_search"]) {
          // The rollback path (DENTAL_QUERY_PARSER_DISABLED=1) searches the whole
          // text as a LIKE pattern, and SQLite refuses one over 50 000 bytes.
          const big = oneMegabyte(PROBES["dental mcp tannlege_search"].base, PROBES["dental mcp tannlege_search"].last);
          process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
          try {
            const answer = await fx.asks["dental mcp tannlege_search"](big);
            assertTrue(!answer.includes("Søkefeil") && !answer.includes('"isError":true'),
              `R tannlege_search, parser switched off: a 1 MB query is no search error (${answer.slice(0, 120)})`);
            assertSameAnswer(answer, await fx.asks["dental mcp tannlege_search"](capFreeText(big)), "R …it answers as its first 2000 characters");
          } finally {
            delete process.env.DENTAL_QUERY_PARSER_DISABLED;
          }
        }

        // ══ W  the word the cut splits is dropped ════════════════════════════
        /** The A2A answer to `text` and its metadata.filter (Opplevagent, Finn-tannlege) or parsedQuery (RFB). */
        const a2a = async (entry: string, text: string) => {
          const raw = await fx.asks[entry](text);
          const result = (JSON.parse(raw) as any)?.body?.result;
          return { raw, read: result?.metadata?.filter ?? result?.artifacts?.[0]?.parts?.[0]?.data?.parsedQuery ?? null };
        };
        if (fx.asks["rfb a2a message/send"]) {
          // The cap falls inside «ostehøvel»: a cut there would leave the whole word «ost» (cheese).
          const head = "honning" + FILLER.repeat(663) + " ";
          const text = head + "ostehøvel" + FILLER.repeat(20);
          const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
          assertEq([head.length, marketplaceRegistry.parseNaturalQuery(text.slice(0, MAX_FREE_TEXT_CHARS)).categories,
            marketplaceRegistry.parseNaturalQuery("honning ostehøvel").categories], [1997, ["dairy", "honey"], ["honey"]],
          "W setup (RFB): a cut at 2000 leaves «ost», which the parser reads as cheese, while «ostehøvel» itself is no cheese");
          const answer = await a2a("rfb a2a message/send", text);
          assertEq(answer.read?.categories, ["honey"], "W1 RFB A2A: the split «ostehøvel» is dropped, so the search is no cheese search");
          assertSameAnswer(answer.raw, (await a2a("rfb a2a message/send", head.trimEnd())).raw, "W1 …the answer is that of the text before the split word");
        }
        if (fx.asks["oa a2a message/send"]) {
          // The cut at 2000 falls inside «Bergensbanen»: the old cut kept «…og Bergen».
          const head = "nordlys" + FILLER.repeat(662) + " ";
          const text = head + "Bergensbanen" + FILLER.repeat(20);
          assertEq([head.length, text.slice(0, MAX_FREE_TEXT_CHARS).endsWith(" Bergen"), (await a2a("oa a2a message/send", head + "Bergen")).read],
            [1994, true, { kommune: "Bergen" }], "W setup (OA): the old cut at 2000 kept «…og Bergen», read as the kommune Bergen");
          const answer = await a2a("oa a2a message/send", text);
          assertEq(answer.read, { text_terms: ["nordlys"] }, "W2 OA A2A: the split «Bergensbanen» is dropped, so no part of it is read as the kommune");
          assertSameAnswer(answer.raw, (await a2a("oa a2a message/send", head.trimEnd())).raw, "W2 …the answer is that of the text before the split word");
        }
        if (fx.asks["dental a2a message/send"]) {
          // The cut at 2000 falls inside «Osloveien»: the old cut kept «…og Oslo».
          const head = "tannlegen" + FILLER.repeat(662) + " ";
          const text = head + "Osloveien" + FILLER.repeat(20);
          const legacyOf = (read: any) => read?.natural?.legacy;
          assertEq([head.length, text.slice(0, MAX_FREE_TEXT_CHARS).endsWith(" Oslo"), legacyOf((await a2a("dental a2a message/send", head + "Oslo")).read)],
            [1996, true, { fylke: "Oslo" }], "W setup (dental): the old cut at 2000 kept «…og Oslo», read as the fylke Oslo");
          const answer = await a2a("dental a2a message/send", text);
          assertEq(legacyOf(answer.read), { q: "tannlegen" }, "W3 dental A2A: the split «Osloveien» is dropped, so no part of it is read as the fylke");
          assertSameAnswer(answer.raw, (await a2a("dental a2a message/send", head.trimEnd())).raw, "W3 …the answer is that of the text before the split word");
        }
      } finally {
        fx.restore();
      }
    }

    // ══ D  the loose time check, per platform ═════════════════════════════
    assertEq(Object.keys(slowest).sort(), ["dental", "oa", "rfb"], "D the time check covers the three platforms");
    for (const [platform, { entry, ms }] of Object.entries(slowest)) {
      assertTrue(ms <= LOOSE_LIMIT_MS,
        `D ${platform}: its slowest entry answers a 1 MB search in at most ${LOOSE_LIMIT_MS} ms (${entry}: ${ms.toFixed(1)} ms, best of 3)`);
    }
  } catch (err: any) {
    failed++;
    failures.push("fritekst-lengdetak-alle-plattformer: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (process.argv.includes("--print")) {
    // B1's answers for the fixture (see the header).
    b1Answers().then((answers) => {
      console.log(JSON.stringify({ answers }, null, 2));
      process.exit(0);
    });
  } else {
    runFritekstLengdetakAllePlattformerTests({ log: true }).then((s) => {
      console.log(`\n${s.passed} passed, ${s.failed} failed`);
      for (const f of s.failures) console.log(f);
      process.exit(s.failed > 0 ? 1 : 0);
    });
  }
}
