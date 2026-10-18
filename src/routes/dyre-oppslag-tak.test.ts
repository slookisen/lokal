/**
 * dyre-oppslag-tak.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-Y2: caps on the expensive
 * lookups I-Y found (FUNN rfb-find-match-levenshtein-uten-tak P1,
 * rfb-find-offers-items-uten-antallstak P1,
 * rfb-geokoding-ordkombinasjoner-uten-tak P2, and in the same class, P3:
 * a2a-datapart-strengfelt-uten-lengdetak, strukturerte-stedsfelt-uten-lengdetak,
 * dental-a2a-intern-feiltekst-i-svar).
 *
 * The checks count work, not time: the cells of the edit distance, the
 * catalog lookups, the geocoder's outbound requests, and how much of the
 * input reaches SQLite and the answer. Each group then has one loose time
 * check (250 ms, best of 3; the caps bound the time).
 *
 *   H   the helpers: capName() cuts a name or place to MAX_NAME_CHARS at a
 *       word boundary, as capFreeText() does free text; capA2aData() gives
 *       A2A data within the caps back as the same value, and cuts its
 *       strings and lists otherwise.
 *   F   GET /api/marketplace/find-match: a 15 000 character name (within
 *       Node's 16 kB header limit) does the edit-distance work of its first
 *       MAX_NAME_CHARS characters, bounded by the cap and the producers'
 *       names (__levenshteinCellsForTesting), and answers as that name.
 *   O   MCP lokal_find_offers: of 25 items, or a 1 MB list, the first
 *       MAX_OFFER_ITEMS are looked up (one catalog query each, a spy on
 *       better-sqlite3); the JSON part is the answer for those items, and a
 *       second part says how many were left out. A list within the cap has
 *       no second part.
 *   G   the geocoder: extractAndGeocode() looks up the runs of the first
 *       MAX_GEOCODE_WORDS words only, so a 2000 character search of short
 *       unknown words makes at most 114 outbound requests (a fetch stub
 *       counts them) on lokal_search, GET /api/marketplace/search and GET
 *       /sok; geocode() looks up and caches no name longer than
 *       MAX_NAME_CHARS; geoCache keeps at most its 500 entries and evicts
 *       the least recently used, so a place in use survives a flood of
 *       misses.
 *   P   the place fields: `near` (lokal_find_offers), `place` (lokal_geocode,
 *       GET /api/marketplace/geocode), `region` (lokal_bm_next_markets),
 *       `city` (find-match), `fylke` and `kommune` (discover_experiences,
 *       discover_gardssalg, Opplevagent A2A data), `sted` (Opplevagent GET
 *       /sok) and `fylke` (tannlege_search, tannlege_akutt, Finn-tannlege
 *       A2A data). A 1 MB value answers as its first MAX_NAME_CHARS
 *       characters, no more of it reaches SQLite, the geocoder or the answer,
 *       and within the cap the field changes the answer (control).
 *   S   the other strings of A2A data: RFB `query`, `categories` and `tags`
 *       (one long name, or 175 000 entries), a `message.data` that is a
 *       string, Finn-tannlege `specialty`, Opplevagent `category`, `season`
 *       and `language`: at most MAX_FREE_TEXT_CHARS of a string, and
 *       MAX_A2A_DATA_LIST_ITEMS entries of a list, each a name of at most
 *       MAX_NAME_CHARS, are read.
 *   E   Finn-tannlege A2A: a failure inside message/send (the dental DB
 *       closed) answers JSON-RPC -32603 "Internal error" without `data`; the
 *       detail is logged.
 *   B1  real names, shopping lists, place values, structured messages and
 *       the geocoder's lookups for the searches of the test sets answer byte
 *       for byte as main did: tests/fixtures/dyre-oppslag-tak-i-y2-main.json
 *       holds the sha256 of each masked answer (stable() from I-Y), captured
 *       with b1Answers() below on main b25dfbce. B1 also runs with
 *       Date.prototype.getFullYear() a year on (Opplevagent /sok's footer).
 *       The search answers of the test sets and of I-W, I-W2 and I-X are
 *       I-Y's golden (fritekst-lengdetak-alle-plattformer.test.ts) and I-X's
 *       (a2a-datapart-alle-plattformer.test.ts), which run unchanged. A
 *       change meant to move a row is captured again with
 *         npx tsx src/routes/dyre-oppslag-tak.test.ts --print
 *
 * Data: I-Y's fixtures (own in-memory DBs, restored in finally; geocoding
 * offline), the real handlers: MCP tools through a duck-typed server, the
 * GET routes' own handlers, A2A through router.handle(). No HTTP server, no
 * network. Tool metadata and the agent cards are not touched by I-Y2; their
 * freezes are rfb-mcp-contract-freeze.test.ts,
 * opplevagent-mcp-contract-freeze.test.ts, dental-mcp-instructions.test.ts
 * and services/dental-agent-card.test.ts.
 *
 * Exported runDyreOppslagTakTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/dyre-oppslag-tak.test.ts [--print]
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  __clearGeocodeCacheForTesting,
  __peekGeoCacheForTesting,
  __setGeocodingFetchForTesting,
  geocodingService,
  MAX_GEOCODE_WORDS,
} from "../services/geocoding-service";
import { capA2aData, MAX_A2A_DATA_LIST_ITEMS } from "../utils/a2a-message";
import { capFreeText, capName, MAX_FREE_TEXT_CHARS, MAX_NAME_CHARS } from "../utils/free-text";
import { textOf } from "./rfb-sok-ukjente-ord-bakeri-sted.test";
import {
  enterRfb,
  enterVerticals,
  FILLER,
  fillerRun,
  getRoute,
  ONE_MB,
  oneMegabyte,
  postA2a,
  routeHandler,
  stable,
  textMessage,
  watchInputs,
  type Fixture,
} from "./fritekst-lengdetak-alle-plattformer.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const RFB_HOST = "rettfrabonden.com";
const OA_HOST = "opplevagent.no";
const TRONDHEIM = { lat: 63.4305, lng: 10.3951 };
/** The loose time check of each group (best of 3; see the header). */
const LOOSE_LIMIT_MS = 250;

const dataMessage = (data: unknown) => ({ message: { role: "user", parts: [{ kind: "data", data }] } });

/** The geocoder's fetch stub for the fixtures: offline, every lookup a 404. */
const offline = (async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch;

/** The URLs the geocoder requests during `call` (each answered 404). */
async function fetchedUrls(call: () => Promise<unknown>): Promise<string[]> {
  const urls: string[] = [];
  __setGeocodingFetchForTesting((async (url: unknown) => { urls.push(String(url)); return offline(""); }) as typeof fetch);
  try {
    await call();
  } finally {
    __setGeocodingFetchForTesting(offline);
  }
  return urls;
}

/** The place name a geocoder URL asks for: Stedsnavn's `sok` or Kommuneinfo's `knavn`. */
function placeAsked(url: string): string {
  const q = new URL(url).searchParams;
  return q.get("sok") ?? q.get("knavn") ?? "";
}

/** How many times `call` runs the offers' catalog query (catalog-offers.ts findOffers), through a spy on better-sqlite3. */
async function catalogLookups(call: () => Promise<unknown>): Promise<number> {
  const scratch = new Database(":memory:");
  const statement = Object.getPrototypeOf(scratch.prepare("SELECT 1")) as Record<string, Function>;
  scratch.close();
  const all = statement.all!;
  let n = 0;
  statement.all = function (this: { source?: string }, ...args: unknown[]) {
    const sql = String(this?.source ?? "");
    if (sql.includes("FROM products p") && sql.includes("INNER JOIN agent_knowledge k")) n++;
    return all.apply(this, args);
  };
  try {
    await call();
  } finally {
    statement.all = all;
  }
  return n;
}

/** Best of 3 runs of `call`, in ms. */
async function bestOf3(call: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const t0 = process.hrtime.bigint();
    await call();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

/** `n` distinct short words no lexicon knows («w0 w1 … wz w10 …»). */
const unknownWords = (n: number) => Array.from({ length: n }, (_, i) => "w" + i.toString(36)).join(" ");

/** The RFB handlers this slice drives, in the RFB fixture. */
function rfbHandlers(fx: Fixture) {
  const marketplace = (require("./marketplace") as any).default;
  return {
    tools: fx.tools.rfb!,
    a2a: fx.a2a.rfb,
    findMatch: routeHandler(marketplace, "/find-match"),
    geocode: routeHandler(marketplace, "/geocode"),
    search: routeHandler(marketplace, "/search"),
    sok: routeHandler((require("./seo") as any).default, "/sok"),
  };
}

// ─── B1 ───────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "../..");
const B1_FIXTURE = path.join(ROOT, "tests/fixtures/dyre-oppslag-tak-i-y2-main.json");

function submissionPrompts(file: string): string[] {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")) as { test_cases: Array<{ user_prompt: string }>; negative_test_cases: Array<{ user_prompt: string }> };
  return [...d.test_cases, ...d.negative_test_cases].map((t) => t.user_prompt);
}
const RFB_PROMPTS = submissionPrompts("chatgpt-app-submission.json");
const OA_PROMPTS = submissionPrompts("opplevagent-chatgpt-app-submission.json");

/** find-match: the fixture's producers by full name, part, typo and city, and the longest live names (52 and 48 characters). */
const FIND_MATCH_ASKS: ReadonlyArray<{ name: string; city?: string }> = [
  { name: "Grini Hjemmebakeri Lengdetak" }, { name: "Grini Hjemmebakeri Lengdetak", city: "Bærum" },
  { name: "Grini" }, { name: "Grinni Hjembakeri" }, { name: "Hjemmebakeri", city: "Fredrikstad" },
  { name: "Nidaros Bakehus" }, { name: "Tirslaug Birøkt" }, { name: "Asker Egg" }, { name: "Godt Fra Fjellet" },
  { name: "Ostegården" }, { name: "Ostegården — Krokeide", city: "Bergen" }, { name: "TønsbergBier" },
  { name: "Bærhagen" }, { name: "Sverdrup Reine Lengdetak", city: "Reine" }, { name: "bakeri" }, { name: "gård" },
  { name: "Alde Sider / Ulvik Frukt & Cideri — Ulvik, Hardanger" }, { name: "Smakfulle Skatter fra Dragetoppen — Kristiansand" },
  { name: "x" }, { name: "zzzqqx" },
];

/** lokal_find_offers: shopping lists of 1, 3, 10 and 20 items (MAX_OFFER_ITEMS), near a place or a position. */
const SHOPPING_ITEMS = [
  "honning", "egg", "kransekake", "lynghonning", "grovbrød", "surdeigsbrød", "lammekjøtt", "spekepølse", "reinsdyrkjøtt", "tørrfisk",
  "fanaost", "syltetøy", "bringebærsyltetøy", "poteter", "gulrøtter", "løk", "melk", "smør", "laks", "ost",
];
const OFFERS_ASKS: ReadonlyArray<Record<string, unknown>> = [
  { items: ["honning"], near: "Trondheim" },
  { items: ["honning", "egg", "kransekake"], near: "Bærum" },
  { items: SHOPPING_ITEMS.slice(0, 10), ...TRONDHEIM },
  { items: SHOPPING_ITEMS, ...TRONDHEIM, radius_km: 500 },
  { items: SHOPPING_ITEMS, near: "Oslo" },
];

/** The searches whose geocoder lookups must be main's: the test sets, I-W/I-W2's searches, and searches of 17 and 20 (MAX_GEOCODE_WORDS) words. */
const GEOCODE_TEXTS: readonly string[] = [
  ...RFB_PROMPTS, ...OA_PROMPTS,
  "kransekake i Bærum", "bakervarer i Trondheim", "Finnes det noen som lager kransekake", "Which bakeries make kransekake",
  "honning nær Trondheim", "poteter Bodø", "tomat i Nesbyen", "rakfisk fra Valdres til Oslo", "Mo i Rana honning",
  "Hei jeg skal på hyttetur og lurer på hvor jeg kan kjøpe ferske egg og honning i Hovden",
  "jeg ser etter en lokal bonde som selger lammekjøtt og spekepølse i nærheten av Lillehammer i Innlandet fylke denne helgen takk gjerne",
];

/** Place values, as written, per place field. */
const PLACE_ASKS: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {
  "rfb mcp lokal_geocode": [{ place: "Oslo" }, { place: "Røros" }, { place: "Florø" }, { place: "Setesdal" }, { place: "Mo i Rana" }, { place: "zzzqqx" }],
  "rfb GET /api/marketplace/geocode": [{ place: "Oslo" }, { place: "Bergen" }, { q: "Tromsø" }, { place: "zzzqqx" }],
  "rfb mcp lokal_bm_next_markets": [{}, { region: "Oslo" }, { region: "Bergen" }, { lokallag_slug: "bondens-marked-agder" }],
  "oa mcp discover_experiences": [{ fylke: "Troms" }, { kommune: "Tromsø" }, { fylke: "Troms", season: "winter" }, { kommune: "Bergen" }, { fylke: "Vestland", query: "nordlys" }],
  "oa mcp discover_gardssalg": [{ fylke: "Vestland" }, { kommune: "Ullensvang" }, { fylke: "Buskerud" }, { kommune: "Lier", query: "Egge" }],
  "oa GET /sok": [{ q: "nordlys", sted: "Tromsø" }, { q: "nordlys", sted: "Bergen" }, { q: "hvalsafari", sted: "zzzqqx" }],
  "dental mcp tannlege_search": [{ fylke: "Oslo" }, { fylke: "Vestland" }, { fylke: "Oslo", query: "tannlege" }],
  "dental mcp tannlege_akutt": [{}, { fylke: "Oslo" }],
};

/** Structured A2A messages (a standard DataPart) per platform. */
const DATA_ASKS: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>> = {
  "rfb a2a data": [
    { categories: ["honey"] }, { query: "honning", categories: ["honey"] }, { tags: ["organic"], categories: ["meat"] },
    { categories: ["honey", "eggs"], location: TRONDHEIM, maxDistanceKm: 50 }, { categories: ["bakery"], limit: 5 },
  ],
  "dental a2a data": [{ fylke: "Oslo" }, { specialty: "kjeveortopedi" }, { q: "Bergen" }, { fylke: "Vestland", helfo_agreement: "true" }],
  "oa a2a data": [{ fylke: "Troms" }, { kommune: "Tromsø", season: "winter" }, { category: "natur" }, { language: "en", fylke: "Troms" }],
};

type B1Answers = Record<string, Record<string, { sha256: string; chars: number }>>;

/**
 * Each entry's answers on fresh fixtures (I-Y's): the sha256 and length of
 * the masked answer, keyed by the request's JSON. Uses only what main has,
 * so main's answers are captured with it.
 */
export async function b1Answers(): Promise<B1Answers> {
  const out: B1Answers = {};
  const note = (entry: string, key: unknown, answer: string) => {
    (out[entry] ??= {})[JSON.stringify(key)] = { sha256: createHash("sha256").update(answer).digest("hex"), chars: answer.length };
  };
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  try {
    const rfb = enterRfb();
    try {
      const h = rfbHandlers(rfb);
      for (const ask of FIND_MATCH_ASKS) {
        note("rfb GET /api/marketplace/find-match", ask, stable(await getRoute(h.findMatch, { name: ask.name, city: ask.city ?? "" }, RFB_HOST)));
      }
      for (const ask of OFFERS_ASKS) note("rfb mcp lokal_find_offers", ask, stable((await h.tools.get("lokal_find_offers")!(ask)).content));
      for (const text of GEOCODE_TEXTS) {
        __clearGeocodeCacheForTesting();
        note("rfb geocoder lookups (extractAndGeocode)", text, (await fetchedUrls(() => geocodingService.extractAndGeocode(text))).join("\n"));
      }
      __clearGeocodeCacheForTesting();
      for (const ask of PLACE_ASKS["rfb mcp lokal_geocode"]!) note("rfb mcp lokal_geocode", ask, stable(textOf(await h.tools.get("lokal_geocode")!(ask))));
      for (const ask of PLACE_ASKS["rfb GET /api/marketplace/geocode"]!) {
        note("rfb GET /api/marketplace/geocode", ask, stable(await getRoute(h.geocode, ask as Record<string, string>, RFB_HOST)));
      }
      for (const ask of PLACE_ASKS["rfb mcp lokal_bm_next_markets"]!) {
        note("rfb mcp lokal_bm_next_markets", ask, stable(textOf(await h.tools.get("lokal_bm_next_markets")!(ask))));
      }
      for (const data of DATA_ASKS["rfb a2a data"]!) note("rfb a2a data", data, stable(await postA2a(h.a2a, dataMessage(data))));
    } finally {
      rfb.restore();
    }
    const verticals = enterVerticals();
    try {
      const oaSok = routeHandler((require("./experiences-seo") as any).default, "/sok");
      for (const ask of PLACE_ASKS["oa mcp discover_experiences"]!) {
        note("oa mcp discover_experiences", ask, stable(await verticals.tools.oa!.get("discover_experiences")!({ limit: 10, ...ask })));
      }
      for (const ask of PLACE_ASKS["oa mcp discover_gardssalg"]!) {
        note("oa mcp discover_gardssalg", ask, stable(await verticals.tools.oa!.get("discover_gardssalg")!({ limit: 10, ...ask })));
      }
      for (const ask of PLACE_ASKS["oa GET /sok"]!) note("oa GET /sok", ask, stable(await getRoute(oaSok, ask as Record<string, string>, OA_HOST)));
      for (const ask of PLACE_ASKS["dental mcp tannlege_search"]!) {
        note("dental mcp tannlege_search", ask, stable(await verticals.tools.dental!.get("tannlege_search")!({ limit: 10, ...ask })));
      }
      for (const ask of PLACE_ASKS["dental mcp tannlege_akutt"]!) {
        note("dental mcp tannlege_akutt", ask, stable(await verticals.tools.dental!.get("tannlege_akutt")!(ask)));
      }
      for (const data of DATA_ASKS["dental a2a data"]!) note("dental a2a data", data, stable(await postA2a(verticals.a2a.dental, dataMessage(data))));
      for (const data of DATA_ASKS["oa a2a data"]!) note("oa a2a data", data, stable(await postA2a(verticals.a2a.oa, dataMessage(data))));
    } finally {
      verticals.restore();
    }
    return out;
  } finally {
    console.log = prevLog;
  }
}

// ─── P / S: one probe per field ───────────────────────────────────────────

interface FieldProbe {
  /** The answer to the field's value, masked. */
  ask: (value: string) => Promise<string>;
  /** The field's cap: MAX_NAME_CHARS for a place, MAX_FREE_TEXT_CHARS for another string. */
  cap: number;
  /** Two values within the cap with different answers (the control), or null when the fixture cannot tell them apart. */
  control: [string, string] | null;
  /** True when the value goes to the geocoder. */
  geocoded?: boolean;
}

function rfbFieldProbes(h: ReturnType<typeof rfbHandlers>): Record<string, FieldProbe> {
  const tool = (name: string, args: (v: string) => Record<string, unknown>) =>
    async (v: string) => stable((await h.tools.get(name)!(args(v))).content);
  return {
    "P rfb mcp lokal_find_offers near": {
      ask: tool("lokal_find_offers", (v) => ({ items: ["honning"], near: v })), cap: MAX_NAME_CHARS, control: ["Trondheim", "Tønsberg"], geocoded: true,
    },
    "P rfb mcp lokal_geocode place": { ask: tool("lokal_geocode", (v) => ({ place: v })), cap: MAX_NAME_CHARS, control: ["Oslo", "Bergen"], geocoded: true },
    "P rfb GET /api/marketplace/geocode place": {
      ask: async (v) => stable(await getRoute(h.geocode, { place: v }, RFB_HOST)), cap: MAX_NAME_CHARS, control: ["Oslo", "Bergen"], geocoded: true,
    },
    "P rfb mcp lokal_bm_next_markets region": { ask: tool("lokal_bm_next_markets", (v) => ({ region: v })), cap: MAX_NAME_CHARS, control: ["Oslo", "Bergen"] },
    "P rfb GET /api/marketplace/find-match city": {
      ask: async (v) => stable(await getRoute(h.findMatch, { name: "Grini Hjemmebakeri Lengdetak", city: v }, RFB_HOST)),
      cap: MAX_NAME_CHARS, control: ["Bærum", "Oslo"],
    },
    "S rfb a2a data.query": {
      ask: async (v) => stable(await postA2a(h.a2a, dataMessage({ query: v, categories: ["honey"] }))), cap: MAX_FREE_TEXT_CHARS, control: ["honning", "egg"],
    },
    "S rfb a2a data.categories (one string)": {
      ask: async (v) => stable(await postA2a(h.a2a, dataMessage({ categories: [v] }))), cap: MAX_NAME_CHARS, control: ["honey", "eggs"],
    },
    "S rfb a2a data.tags (one string)": {
      ask: async (v) => stable(await postA2a(h.a2a, dataMessage({ tags: [v] }))), cap: MAX_NAME_CHARS, control: ["organic", "sesong"],
    },
    "S rfb a2a message.data (a string)": {
      ask: async (v) => stable(await postA2a(h.a2a, { message: { data: v } })), cap: MAX_FREE_TEXT_CHARS, control: ["honning", "egg"],
    },
  };
}

function verticalFieldProbes(fx: Fixture): Record<string, FieldProbe> {
  const oa = fx.tools.oa!;
  const dental = fx.tools.dental!;
  const oaSok = routeHandler((require("./experiences-seo") as any).default, "/sok");
  const oaData = (key: string) => async (v: string) => stable(await postA2a(fx.a2a.oa, dataMessage({ [key]: v })));
  const dentalData = (key: string) => async (v: string) => stable(await postA2a(fx.a2a.dental, dataMessage({ [key]: v })));
  return {
    "P oa mcp discover_experiences fylke": { ask: async (v) => stable(await oa.get("discover_experiences")!({ fylke: v, limit: 10 })), cap: MAX_NAME_CHARS, control: ["Troms", "Vestland"] },
    "P oa mcp discover_experiences kommune": { ask: async (v) => stable(await oa.get("discover_experiences")!({ kommune: v, limit: 10 })), cap: MAX_NAME_CHARS, control: ["Tromsø", "Bergen"] },
    "P oa mcp discover_gardssalg fylke": { ask: async (v) => stable(await oa.get("discover_gardssalg")!({ fylke: v, limit: 10 })), cap: MAX_NAME_CHARS, control: ["Vestland", "Buskerud"] },
    "P oa mcp discover_gardssalg kommune": { ask: async (v) => stable(await oa.get("discover_gardssalg")!({ kommune: v, limit: 10 })), cap: MAX_NAME_CHARS, control: ["Ullensvang", "Lier"] },
    "P oa a2a data.fylke": { ask: oaData("fylke"), cap: MAX_NAME_CHARS, control: ["Troms", "Vestland"] },
    "P oa a2a data.kommune": { ask: oaData("kommune"), cap: MAX_NAME_CHARS, control: ["Tromsø", "Bergen"] },
    "P oa GET /sok sted": {
      ask: async (v) => stable(await getRoute(oaSok, { q: "nordlys", sted: v }, OA_HOST)), cap: MAX_NAME_CHARS, control: ["Tromsø", "Bergen"], geocoded: true,
    },
    "P dental mcp tannlege_search fylke": { ask: async (v) => stable(await dental.get("tannlege_search")!({ fylke: v, limit: 10 })), cap: MAX_NAME_CHARS, control: ["Oslo", "Vestland"] },
    // The fixture has no emergency clinics, so every fylke answers alike: no control. D shows the cut.
    "P dental mcp tannlege_akutt fylke": { ask: async (v) => stable(await dental.get("tannlege_akutt")!({ fylke: v })), cap: MAX_NAME_CHARS, control: null },
    "P dental a2a data.fylke": { ask: dentalData("fylke"), cap: MAX_NAME_CHARS, control: ["Oslo", "Vestland"] },
    "S dental a2a data.specialty": { ask: dentalData("specialty"), cap: MAX_FREE_TEXT_CHARS, control: ["kjeveortopedi", "periodonti"] },
    "S oa a2a data.category": { ask: oaData("category"), cap: MAX_FREE_TEXT_CHARS, control: ["natur", "dyreliv_safari"] },
    "S oa a2a data.season": { ask: oaData("season"), cap: MAX_FREE_TEXT_CHARS, control: ["winter", "summer"] },
    // The fixture's experiences carry no language, so every language answers alike: no control.
    "S oa a2a data.language": { ask: oaData("language"), cap: MAX_FREE_TEXT_CHARS, control: null },
  };
}

// ─── The suite ────────────────────────────────────────────────────────────

export async function runDyreOppslagTakTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      `${label} (expected ${JSON.stringify(expected)?.slice(0, 300)}, got ${JSON.stringify(actual)?.slice(0, 300)})`);
  }
  /** Two answers: the same, or where they first differ. */
  function assertSameAnswer(actual: string, expected: string, label: string): void {
    if (actual === expected) return assertTrue(true, label);
    let i = 0;
    while (actual[i] === expected[i]) i++;
    assertTrue(false,
      `${label} (differs at ${i}: expected …${expected.slice(Math.max(0, i - 40), i + 80)}…, got …${actual.slice(Math.max(0, i - 40), i + 80)}…)`);
  }
  const isError = (answer: string) => /"isError":true|"error":\{"code":|"status":5\d\d\b|Søkefeil/.test(answer);

  // ══ H  the helpers ═══════════════════════════════════════════════════════
  {
    assertEq([MAX_NAME_CHARS, MAX_FREE_TEXT_CHARS, MAX_A2A_DATA_LIST_ITEMS, MAX_GEOCODE_WORDS], [80, 2000, 50, 20], "H1 the caps");
    const longestLiveName = "Alde Sider / Ulvik Frukt & Cideri — Ulvik, Hardanger";
    for (const t of ["", "Oslo", "Storfjord – Omasvuotna – Omasvuono", longestLiveName, "x".repeat(MAX_NAME_CHARS)]) {
      assertTrue(capName(t) === t, `H2 a name of ${t.length} characters (within the cap) is returned as is`);
    }
    assertEq(capName(undefined), undefined, "H2 an optional field that was not sent stays undefined");
    const words = Array.from({ length: 40 }, (_, i) => `sted${i}`).join(" "); // «sted0 … sted39»; character 80 is inside «sted13»
    assertEq(capName(words), words.slice(0, words.lastIndexOf(" ", MAX_NAME_CHARS)), "H3 a longer name keeps its whole words up to the cap");
    assertEq(capName(words).split(" ").at(-1), "sted12", "H3 …the word the cut splits («sted13») is dropped");
    assertEq(capName("x".repeat(ONE_MB)), "x".repeat(MAX_NAME_CHARS), "H3 one very long word is cut at the cap");
    assertEq(["a", "b", "c"].map(capName), ["a", "b", "c"], "H3 capName is safe as a map() callback (the index is no cap)");

    const within = { query: "honning", categories: ["honey", "eggs"], location: TRONDHEIM, limit: 5 };
    assertTrue(capA2aData(within) === within, "H4 data within the caps is the same object (so it answers as before)");
    const list = ["honey"];
    assertTrue(capA2aData(list) === list && capA2aData("honning") === "honning" && capA2aData(42) === 42 && capA2aData(null) === null,
      "H4 …so are a list, a string, a number and null within the caps");
    const big = "x".repeat(ONE_MB);
    const nested = { deep: { text: big } };
    const capped = capA2aData({ query: big, categories: [big, 7], tags: Array(175_000).fill("organic"), nested, n: 3 }) as Record<string, any>;
    assertEq([capped.query.length, capped.categories.map((c: unknown) => (typeof c === "string" ? c.length : c)), capped.tags.length, capped.n],
      [MAX_FREE_TEXT_CHARS, [MAX_NAME_CHARS, 7], MAX_A2A_DATA_LIST_ITEMS, 3],
      "H5 a long string is cut to MAX_FREE_TEXT_CHARS, a long list to MAX_A2A_DATA_LIST_ITEMS entries with its strings (names) cut to MAX_NAME_CHARS, a number kept");
    assertTrue(capped.nested === nested, "H5 …a nested object is no field the handlers read, and is kept as it is");
    assertEq([(capA2aData(big) as string).length, (capA2aData(Array(60).fill(big)) as string[]).map((s) => s.length)],
      [MAX_FREE_TEXT_CHARS, Array(MAX_A2A_DATA_LIST_ITEMS).fill(MAX_NAME_CHARS)], "H5 …and data that is a string or a list is cut the same way");
    const source = { query: big };
    capA2aData(source);
    assertEq(source.query.length, ONE_MB, "H5 the message itself is not changed (a copy is cut)");
    const proto = capA2aData(JSON.parse(`{"__proto__": ["${"x".repeat(100)}"], "query": "${"y".repeat(3000)}"}`)) as Record<string, unknown>;
    assertTrue(Object.getPrototypeOf(proto) === Object.prototype && Array.isArray(proto["__proto__"]) && (proto.query as string).length === MAX_FREE_TEXT_CHARS,
      "H5 a «__proto__» key of the JSON body stays a plain field of the copy, never its prototype");
  }

  // ══ B1  main's answers, byte for byte ════════════════════════════════════
  {
    const main = JSON.parse(fs.readFileSync(B1_FIXTURE, "utf8")) as { answers: B1Answers };
    const now = await b1Answers();
    assertEq(Object.keys(now).sort(), Object.keys(main.answers).sort(), "B1 the fixture covers every entry");
    let compared = 0;
    for (const [entry, byKey] of Object.entries(main.answers)) {
      for (const [key, want] of Object.entries(byKey)) {
        const got = now[entry]?.[key];
        compared++;
        assertTrue(got?.sha256 === want.sha256, `B1 ${entry} ${key}: the answer is main's` +
          (got?.sha256 === want.sha256 ? "" : ` (main ${want.chars} characters, now ${got?.chars})`));
      }
    }
    assertTrue(compared >= 90 && GEOCODE_TEXTS.every((t) => JSON.stringify(t) in (main.answers["rfb geocoder lookups (extractAndGeocode)"] ?? {})),
      `B1 the fixture holds the names, lists, place values, messages and the test sets' geocoder lookups (${compared} answers)`);
    const getFullYear = Date.prototype.getFullYear;
    Date.prototype.getFullYear = function (this: Date) { return getFullYear.call(this) + 1; };
    let nextYear: B1Answers;
    try {
      nextYear = await b1Answers();
    } finally {
      Date.prototype.getFullYear = getFullYear;
    }
    const moved = Object.entries(main.answers).flatMap(([entry, byKey]) =>
      Object.entries(byKey).filter(([key, want]) => nextYear[entry]?.[key]?.sha256 !== want.sha256).map(([key]) => `${entry} ${key}`));
    assertEq(moved, [], "B1 with getFullYear() a year on, every answer is still main's");
  }

  const prevLog = console.log;
  const prevError = console.error;
  if (!log) console.log = () => { /* silence module chatter */ };
  try {
    // ══ RFB: F, O, G, P, S ═════════════════════════════════════════════════
    const rfb = enterRfb();
    try {
      const h = rfbHandlers(rfb);
      const { __levenshteinCellsForTesting } = require("./marketplace") as typeof import("./marketplace");
      const { MAX_OFFER_ITEMS, offersItemsOmittedText } = require("./mcp") as typeof import("./mcp");
      const { getDb } = require("../database/init") as typeof import("../database/init");

      // ── F  find-match ──────────────────────────────────────────────────
      {
        const findMatch = async (name: string, city = "") => {
          const before = __levenshteinCellsForTesting();
          const answer = stable(await getRoute(h.findMatch, { name, city }, RFB_HOST));
          return { answer, cells: __levenshteinCellsForTesting() - before };
        };
        const names = (getDb().prepare("SELECT name FROM agents WHERE is_active = 1").all() as Array<{ name: string }>).map((r) => r.name);
        // Per producer: the whole-name distance (≤ cap × name) and the word pairs (≤ cap × the name's words, twice).
        const bound = 3 * MAX_NAME_CHARS * names.reduce((sum, n) => sum + n.length, 0);
        const long = "Grini Hjemmebakeri Lengdetak" + FILLER.repeat(5000); // 15 028 characters
        const big = await findMatch(long);
        const cut = await findMatch(capName(long));
        assertTrue(long.length > 15_000 && names.length >= 10, `F setup: a ${long.length} character name, ${names.length} producers`);
        assertEq(big.cells, cut.cells, "F1 a 15 000 character name does the edit-distance work of its first MAX_NAME_CHARS characters");
        assertTrue(big.cells > 0 && big.cells <= bound,
          `F1 …bounded by the cap and the producers' names (${big.cells} cells, bound ${bound}; the whole name alone would be ${long.length * names[0]!.length} for one producer)`);
        assertSameAnswer(big.answer, cut.answer, "F2 …and answers as that name (the echo is the name as read)");
        assertTrue(fillerRun(big.answer) <= MAX_NAME_CHARS && !isError(big.answer), "F2 …no more of it is echoed, and it is no error");
        const one = await findMatch("x".repeat(15_000));
        assertTrue(one.cells === (await findMatch("x".repeat(MAX_NAME_CHARS))).cells && one.cells <= bound, "F3 one 15 000 character word is cut at the cap");
        const a = await findMatch("Grini Hjemmebakeri Lengdetak");
        const b = await findMatch("Nidaros Bakehus Lengdetak");
        assertTrue(a.answer !== b.answer && a.cells !== b.cells, "F4 control: within the cap the name decides the answer and the work");
        const ms = await bestOf3(() => getRoute(h.findMatch, { name: long, city: "" }, RFB_HOST));
        assertTrue(ms <= LOOSE_LIMIT_MS, `F5 a 15 000 character name answers in at most ${LOOSE_LIMIT_MS} ms (${ms.toFixed(1)} ms, best of 3)`);
      }

      // ── O  lokal_find_offers' items ────────────────────────────────────
      {
        const offers = h.tools.get("lokal_find_offers")!;
        const items25 = [...SHOPPING_ITEMS, "rømme", "fløte", "brunost", "hvetemel", "rabarbra"];
        let r25: any;
        const lookups25 = await catalogLookups(async () => { r25 = await offers({ items: items25, ...TRONDHEIM }); });
        const r20 = await offers({ items: items25.slice(0, MAX_OFFER_ITEMS), ...TRONDHEIM });
        assertEq([MAX_OFFER_ITEMS, items25.length, lookups25], [20, 25, MAX_OFFER_ITEMS], "O1 of 25 items, MAX_OFFER_ITEMS are looked up (one catalog query each)");
        assertEq(JSON.parse(textOf(r25)).map((x: any) => x.term), items25.slice(0, MAX_OFFER_ITEMS), "O1 …the first ones, in order");
        assertSameAnswer(stable(textOf(r25)), stable(textOf(r20)), "O1 …and the JSON part is the answer for those items");
        assertEq(r25.content.length === 2 && r25.content[1], { type: "text", text: offersItemsOmittedText(25) }, "O2 a second part says how many were left out");
        assertEq(offersItemsOmittedText(25),
          "Bare de 20 første av 25 varene er slått opp, og 5 er utelatt. Spør etter resten i et nytt kall. / " +
          "Only the first 20 of 25 items were looked up, and 5 were left out. Ask for the rest in another call.", "O2 …in Norwegian and English");
        assertEq([r20.content.length, (await offers({ items: ["honning"], ...TRONDHEIM })).content.length], [1, 1], "O3 a list within the cap has no second part");
        const megaList = Array(175_000).fill("egg"); // its JSON is 1 MB
        let rMega: any;
        const lookupsMega = await catalogLookups(async () => { rMega = await offers({ items: megaList, near: "Trondheim" }); });
        assertTrue(JSON.stringify(megaList).length >= ONE_MB, "O4 setup: a list whose JSON is 1 MB");
        assertEq([lookupsMega, JSON.parse(textOf(rMega)).length, rMega.content[1]?.text], [MAX_OFFER_ITEMS, MAX_OFFER_ITEMS, offersItemsOmittedText(175_000)],
          "O4 a 1 MB list makes MAX_OFFER_ITEMS catalog queries and says the rest were left out");
        const ms = await bestOf3(() => offers({ items: megaList, near: "Trondheim" }));
        assertTrue(ms <= LOOSE_LIMIT_MS, `O5 a 1 MB list answers in at most ${LOOSE_LIMIT_MS} ms (${ms.toFixed(1)} ms, best of 3)`);
      }

      // ── G  the geocoder ────────────────────────────────────────────────
      {
        const perSearch = 2 * (3 * MAX_GEOCODE_WORDS - 3); // runs of 3, 2 and 1 words; Stedsnavn and Kommuneinfo each
        const text = capFreeText(unknownWords(700)); // 2000 characters of short unknown words
        const first20 = unknownWords(MAX_GEOCODE_WORDS);
        const entries: Record<string, (t: string) => Promise<unknown>> = {
          "rfb mcp lokal_search": (t) => h.tools.get("lokal_search")!({ query: t, limit: 10 }),
          "rfb GET /api/marketplace/search": (t) => getRoute(h.search, { q: t }, RFB_HOST),
          "rfb GET /sok": (t) => getRoute(h.sok, { q: t }, RFB_HOST),
        };
        for (const [entry, call] of Object.entries(entries)) {
          __clearGeocodeCacheForTesting();
          const urls = await fetchedUrls(() => call(text));
          __clearGeocodeCacheForTesting();
          const urls20 = await fetchedUrls(() => call(first20));
          assertTrue(text.length > 1990 && urls.length === perSearch,
            `G1 ${entry}: a 2000 character search of short unknown words makes ${perSearch} outbound requests (${urls.length}; about 3000 on main)`);
          assertEq(urls, urls20, `G1 ${entry}: …the requests of its first ${MAX_GEOCODE_WORDS} words`);
        }
        // extractAndGeocode() itself: the runs of the first 20 words, longest first, as before.
        const words = Array.from({ length: 30 }, (_, i) => `ord${i}`);
        __clearGeocodeCacheForTesting();
        const asked = (await fetchedUrls(() => geocodingService.extractAndGeocode(words.join(" ")))).filter((u) => u.includes("/stedsnavn/")).map(placeAsked);
        const kept = words.slice(0, MAX_GEOCODE_WORDS);
        const runs = (n: number) => kept.slice(0, kept.length - n + 1).map((_, i) => kept.slice(i, i + n).join(" "));
        assertEq(asked, [...runs(3), ...runs(2), ...runs(1)], "G2 extractAndGeocode looks up the runs of 3, 2 and 1 of the first 20 words, in that order");

        // geocode(): no lookup and no cache entry for a name past the cap.
        __clearGeocodeCacheForTesting();
        const atCap = "a".repeat(MAX_NAME_CHARS);
        const pastCap = "a".repeat(MAX_NAME_CHARS + 1);
        const urlsAt = await fetchedUrls(() => geocodingService.geocode(atCap));
        const urlsPast = await fetchedUrls(async () => { await geocodingService.geocode(pastCap); await geocodingService.geocode("x".repeat(ONE_MB)); });
        assertEq([urlsAt.length, urlsPast.length, __peekGeoCacheForTesting().keys], [2, 0, [atCap]],
          "G3 geocode() looks up a name of MAX_NAME_CHARS characters and caches it; a longer one, also 1 MB, is no lookup and no entry");

        // geoCache: at most its entries; the least recently used goes first.
        __clearGeocodeCacheForTesting();
        const { max } = __peekGeoCacheForTesting();
        let hotRequests = 0;
        await fetchedUrls(async () => {
          await geocodingService.geocode("varmt sted");
          for (let i = 0; i < max + 100; i++) {
            await geocodingService.geocode(`sted nr ${i}`);
            if (i % 50 === 0) hotRequests += (await fetchedUrls(() => geocodingService.geocode("varmt sted"))).length;
          }
        });
        const keys = __peekGeoCacheForTesting().keys;
        assertEq([max, keys.length, keys.includes("varmt sted"), hotRequests, keys.includes("sted nr 0"), keys.includes(`sted nr ${max + 99}`)],
          [500, 500, true, 0, false, true],
          "G4 geoCache keeps 500 entries; a place in use survives 600 misses (and is no request), the least recently used went first");
        assertTrue(keys.every((k) => k.length <= MAX_NAME_CHARS), "G4 …and no key is longer than MAX_NAME_CHARS");
        __clearGeocodeCacheForTesting();
        const ms = await bestOf3(async () => { __clearGeocodeCacheForTesting(); await h.tools.get("lokal_search")!({ query: text, limit: 10 }); });
        assertTrue(ms <= LOOSE_LIMIT_MS, `G5 lokal_search answers the 2000 character search in at most ${LOOSE_LIMIT_MS} ms (${ms.toFixed(1)} ms, best of 3)`);
        __clearGeocodeCacheForTesting();
      }

      // ── S  RFB: a list of 175 000 categories ───────────────────────────
      {
        const many = Array(175_000).fill("honey");
        const answer = (await postA2a(h.a2a, dataMessage({ categories: many }))) as any;
        const fifty = (await postA2a(h.a2a, dataMessage({ categories: many.slice(0, MAX_A2A_DATA_LIST_ITEMS) }))) as any;
        const parsed = answer.body?.result?.artifacts?.[0]?.parts?.[0]?.data?.parsedQuery;
        assertEq(parsed?.categories?.length, MAX_A2A_DATA_LIST_ITEMS, "S1 RFB A2A: of 175 000 categories, MAX_A2A_DATA_LIST_ITEMS are read");
        assertSameAnswer(stable(answer), stable(fifty), "S1 …and it answers as those");
        const ms = await bestOf3(() => postA2a(h.a2a, dataMessage({ categories: many })));
        assertTrue(ms <= LOOSE_LIMIT_MS, `S1 …in at most ${LOOSE_LIMIT_MS} ms (${ms.toFixed(1)} ms, best of 3)`);
      }

      await checkFieldProbes(rfbFieldProbes(h));
    } finally {
      rfb.restore();
    }

    // ══ Opplevagent and Finn-tannlege: P, S, E ═════════════════════════════
    const verticals = enterVerticals();
    try {
      await checkFieldProbes(verticalFieldProbes(verticals));

      // ── E  Finn-tannlege A2A: no internal error text in the answer ──────
      {
        const errors: string[] = [];
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.getDb("dental").close(); // every dental lookup now fails inside
        for (const [skill, text] of [["tannlege_search", "tannlege i Oslo"], ["tannlege_stats", "statistikk"], ["tannlege_info", "Finn klinikk 912345678"]]) {
          errors.length = 0;
          const answer = (await postA2a(verticals.a2a.dental, textMessage(text!))) as any;
          assertEq(answer.body?.error, { code: -32603, message: "Internal error" },
            `E1 dental A2A ${skill}: a failure inside answers -32603 "Internal error", without data`);
          assertTrue(!JSON.stringify(answer.body).includes("database"), `E1 …the error's own message is not in the answer`);
          assertTrue(errors.some((e) => e.includes(`[dental-a2a] message/send (${skill}) failed`) && e.includes("database connection is not open")),
            `E2 …the detail is logged (${errors[0]?.split("\n")[0]?.slice(0, 120)})`);
        }
      }
    } finally {
      console.error = prevError;
      verticals.restore();
    }
  } catch (err: any) {
    failed++;
    failures.push("dyre-oppslag-tak: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }

  /**
   * P and S: per field, a 1 MB value (a real value, filler, and a last value
   * far past the cap) answers as its cut value; no more of it than the cap
   * reaches SQLite, the geocoder or the answer; and within the cap the field
   * changes the answer.
   */
  async function checkFieldProbes(probes: Record<string, FieldProbe>): Promise<void> {
    for (const [label, probe] of Object.entries(probes)) {
      const [base, last] = probe.control ?? ["Oslo", "Bergen"];
      const big = oneMegabyte(base, last);
      const cut = probe.cap === MAX_NAME_CHARS ? capName(big) : capFreeText(big);
      assertTrue(cut.length <= probe.cap && !cut.includes(last), `${label}: setup, a 1 MB value whose last word «${last}» lies past the cap`);
      __clearGeocodeCacheForTesting();
      let answer = "";
      let urls: string[] = [];
      const seen = await watchInputs(async () => { urls = await fetchedUrls(async () => { answer = await probe.ask(big); }); });
      assertTrue(seen.sqlText <= probe.cap, `${label}: at most ${probe.cap} characters of it reach SQLite (${seen.sqlText})`);
      if (probe.geocoded) {
        const longest = Math.max(0, ...urls.map((u) => placeAsked(u).length));
        assertTrue(longest > 0 && longest <= probe.cap, `${label}: …and the geocoder (${longest})`);
      }
      assertTrue(fillerRun(answer) <= probe.cap && !isError(answer), `${label}: …and the answer, which is no error (${answer.slice(0, 120)})`);
      assertSameAnswer(answer, await probe.ask(cut), `${label}: a 1 MB value answers as its first ${probe.cap} characters (whole words)`);
      if (probe.control) {
        assertTrue(await probe.ask(probe.control[0]) !== await probe.ask(probe.control[1]),
          `${label}: control, within the cap «${probe.control[0]}» and «${probe.control[1]}» answer differently`);
      }
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (process.argv.includes("--print")) {
    // B1's answers for the fixture (see the header).
    b1Answers().then((answers) => {
      console.log(JSON.stringify({ answers }, null, 2));
      process.exit(0);
    }).catch((err) => { console.error(err); process.exit(1); });
  } else {
    runDyreOppslagTakTests({ log: true }).then((s) => {
      console.log(`\n${s.passed} passed, ${s.failed} failed`);
      for (const f of s.failures) console.log(f);
      process.exit(s.failed > 0 ? 1 : 0);
    });
  }
}
