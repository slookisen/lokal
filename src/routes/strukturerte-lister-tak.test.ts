/**
 * strukturerte-lister-tak.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-Y3: caps on the lists of
 * the structured searches (FUNN rfb-discover-lister-uten-tak, P1), and in
 * the same class, P3: a2a-mcp-intern-feiltekst-rest and
 * rfb-a2a-strukturert-melding-totalstorrelse.
 *
 * The checks count lengths, not time: the lists and strings discover()
 * gets (a spy on marketplaceRegistry.discover), the size of the answer, the
 * issues of a 400, and the longest string bound to SQLite. Each surface then
 * has one loose time check (250 ms, best of 3; the caps bound the time).
 *
 *   H   the helper: capNameList() gives a list within the caps back as the
 *       same list, and otherwise its first MAX_NAME_LIST_ITEMS entries with
 *       each string a name cut by capName(); A2A's list cap is the same
 *       (MAX_A2A_DATA_LIST_ITEMS).
 *   L   MCP lokal_discover and POST /api/marketplace/discover: of 175 000
 *       categories or tags, discover() gets MAX_NAME_LIST_ITEMS, and of one
 *       category or tag of 1 MB its first MAX_NAME_CHARS characters (whole
 *       words); the answer is the one for those. POST /discover cuts
 *       `skills` the same way and `query` to MAX_FREE_TEXT_CHARS, its answer
 *       no longer echoes the list (3.9 MB for 175 000 categories on main),
 *       and an invalid list of 175 000 entries is a 400 with at most
 *       MAX_NAME_LIST_ITEMS issues (23 MB on main). Within the caps
 *       discover() gets the lists as sent (control).
 *   T   RFB A2A's total bound (boundedA2aQuery): a structured message that
 *       spreads 1 MB over many keys or nests it is logged, stored and echoed
 *       as the fields of it the discovery reads (at most
 *       MAX_A2A_QUERY_JSON_CHARS outside the task row, which keeps the
 *       params as sent: FUNN rfb-a2a-oppgaverad-lagrer-ra-params), and it
 *       answers as those fields do. A query within the bound is the same
 *       object.
 *   E   no internal error text in an answer: with SQLite failing (a spy on
 *       better-sqlite3 that throws an error with a marker), RFB A2A
 *       (message/send, the dispatcher, the task row through tasks/get, GET
 *       /a2a), Opplevagent A2A (each skill and the dispatcher), Opplevagent
 *       MCP and Finn-tannlege MCP (each tool) answer a generic error and log
 *       the detail; an invalid RFB query is still -32602 with Zod's issues;
 *       Opplevagent MCP still answers a closed database with «Ingen data».
 *       Then a sweep: every tool of the three MCP servers and every A2A
 *       method, with all of SQLite failing, never answers the marker.
 *   B1  real structured searches answer byte for byte as main did:
 *       tests/fixtures/strukturerte-lister-tak-i-y3-main.json holds the
 *       sha256 of each masked answer (stable() from I-Y), captured with
 *       b1Answers() below on main 7131787f: lokal_discover, POST /discover
 *       (also small invalid bodies), RFB A2A data and mode 3 messages (also
 *       extra keys within the bound and an invalid query), and the GET /a2a
 *       cards of RFB and Opplevagent. The answers of I-Y, I-Y2 and I-X are
 *       their goldens, which run unchanged. A change meant to move a row is
 *       captured again with
 *         npx tsx src/routes/strukturerte-lister-tak.test.ts --print
 *
 * Data: I-Y's fixtures (own in-memory DBs, restored in finally; geocoding
 * offline), the real handlers: MCP tools through a duck-typed server, the
 * routes' own handlers, A2A through router.handle(). No HTTP server, no
 * network. Tool metadata and the agent cards are not touched by I-Y3; their
 * freezes are rfb-mcp-contract-freeze.test.ts,
 * opplevagent-mcp-contract-freeze.test.ts, dental-mcp-instructions.test.ts
 * and services/dental-agent-card.test.ts.
 *
 * Exported runStrukturerteListerTakTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/strukturerte-lister-tak.test.ts [--print]
 */

import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PLATFORM_CATEGORIES } from "../services/search-enrich";
import { capA2aData, MAX_A2A_DATA_LIST_ITEMS } from "../utils/a2a-message";
import { capFreeText, capName, capNameList, MAX_FREE_TEXT_CHARS, MAX_NAME_CHARS, MAX_NAME_LIST_ITEMS } from "../utils/free-text";
import { textOf } from "./rfb-sok-ukjente-ord-bakeri-sted.test";
import {
  enterRfb,
  enterVerticals,
  FILLER,
  getRoute,
  ONE_MB,
  oneMegabyte,
  postA2a,
  routeHandler,
  stable,
  textMessage,
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
/** The loose time check of each surface (best of 3; see the header). */
const LOOSE_LIMIT_MS = 250;
/** The marker of the errors the SQLite spy throws (E): no answer may hold it. */
const SECRET = "SQLITE_I_Y3_INTERNAL_DETAIL";

const dataMessage = (data: unknown) => ({ message: { role: "user", parts: [{ kind: "data", data }] } });

// ─── Drivers ──────────────────────────────────────────────────────────────

let ipSeq = 0;
/** A fresh client address per call, so the per-IP caps never decide an answer here. */
function nextIp(): string {
  ipSeq++;
  return `10.126.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

/** A response object for the handlers: settles on json/send/end; an EventEmitter (recordA2aDelivery waits for "finish", never sent). */
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
    json(payload: unknown) { settle(this.statusCode, payload); return this; },
    send(payload: unknown) { settle(this.statusCode, payload); return this; },
    end() { settle(this.statusCode, undefined); return this; },
  });
}

/** POST through the last handler of a route (past the router's limiters) with `body`; the answer as { status, body }. */
function postRoute(router: any, routePath: string, body: unknown): Promise<{ status: number; body: any }> {
  const layer = (router.stack as any[]).find((l: any) => l.route?.path === routePath && l.route.methods?.post);
  if (!layer) throw new Error(`route not found: POST ${routePath}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "curl/8.5.0", host: RFB_HOST };
    const req: any = {
      method: "POST", url: routePath, path: routePath, originalUrl: routePath, params: {}, query: {}, headers, body, ip,
      socket: { remoteAddress: ip }, hostname: RFB_HOST, protocol: "https",
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    try {
      handler(req, mockRes((status, b) => resolve({ status, body: b })));
    } catch (err) {
      resolve({ status: 500, body: String(err) });
    }
  });
}

/** POST /a2a with any JSON-RPC method, through router.handle(). */
function rpc(router: any, method: string, params: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
    const req: any = {
      method: "POST", url: "/a2a", originalUrl: "/a2a", path: "/a2a", query: {}, headers,
      body: { jsonrpc: "2.0", method, params, id: "y3" },
      ip, socket: { remoteAddress: ip },
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    router.handle(req, mockRes((status, b) => resolve({ status, body: b })), (err?: unknown) =>
      resolve({ status: err ? 500 : 404, body: String(err ?? "no route") }));
  });
}

/** The query each discover() call of `call` gets (a spy on the registry's method, restored in finally). */
async function discoverQueries(call: () => Promise<unknown>): Promise<any[]> {
  const registry = (require("../services/marketplace-registry") as typeof import("../services/marketplace-registry")).marketplaceRegistry as any;
  const own = Object.prototype.hasOwnProperty.call(registry, "discover");
  const discover = registry.discover;
  const seen: any[] = [];
  registry.discover = function (this: unknown, query: unknown, ...rest: unknown[]) {
    seen.push(query);
    return discover.call(this, query, ...rest);
  };
  try {
    await call();
  } finally {
    if (own) registry.discover = discover;
    else delete registry.discover; // the prototype's method again
  }
  return seen;
}

/** [entries, longest entry] of a list discover() got, or null when it got none. */
function listShape(list: unknown): [number, number] | null {
  if (!Array.isArray(list)) return null;
  return [list.length, list.reduce((m: number, v: unknown) => Math.max(m, String(v).length), 0)];
}

/** The prototypes better-sqlite3's statements and databases share. */
function sqlitePrototypes(): { statement: Record<string, Function>; database: Record<string, Function> } {
  const scratch = new Database(":memory:");
  const statement = Object.getPrototypeOf(scratch.prepare("SELECT 1")) as Record<string, Function>;
  scratch.close();
  return { statement, database: Database.prototype as unknown as Record<string, Function> };
}

/**
 * `call` with every SQL statement that `match` matches failing: prepare()
 * and run/get/all/iterate throw an Error whose message holds SECRET, as a
 * real SQLite error holds its own text. Restored in finally.
 */
async function withFailingSql<T>(match: RegExp, call: () => Promise<T>): Promise<T> {
  const { statement, database } = sqlitePrototypes();
  const patched: Array<[Record<string, Function>, string, Function]> = [];
  const fail = (sql: string) => new Error(`${SECRET}: no such column in «${sql.slice(0, 40)}»`);
  for (const m of ["run", "get", "all", "iterate"]) {
    const original = statement[m]!;
    patched.push([statement, m, original]);
    statement[m] = function (this: { source?: unknown }, ...args: unknown[]) {
      const sql = String(this?.source ?? "");
      if (match.test(sql)) throw fail(sql);
      return original.apply(this, args);
    };
  }
  const prepare = database.prepare!;
  patched.push([database, "prepare", prepare]);
  database.prepare = function (this: unknown, sql: unknown, ...args: unknown[]) {
    if (match.test(String(sql))) throw fail(String(sql));
    return prepare.call(this, sql, ...args);
  };
  try {
    return await call();
  } finally {
    for (const [target, m, original] of patched.reverse()) target[m] = original;
  }
}

/** The task row: RFB A2A keeps the params as sent (tasks/get returns them; FUNN rfb-a2a-oppgaverad-lagrer-ra-params). */
const TASK_ROW = /^\s*(INSERT INTO|UPDATE) tasks\b/;

/** The longest string `call` binds to SQLite outside the task row (a spy on better-sqlite3, restored in finally). */
async function longestStoredString(call: () => Promise<unknown>): Promise<number> {
  const { statement } = sqlitePrototypes();
  let longest = 0;
  const note = (v: unknown, nested = false): void => {
    if (typeof v === "string") longest = Math.max(longest, v.length);
    else if (!nested && v && typeof v === "object" && !Buffer.isBuffer(v)) for (const x of Array.isArray(v) ? v : Object.values(v)) note(x, true);
  };
  const patched: Array<[string, Function]> = [];
  for (const m of ["run", "get", "all", "iterate", "bind"]) {
    const original = statement[m]!;
    patched.push([m, original]);
    statement[m] = function (this: { source?: unknown }, ...args: unknown[]) {
      if (!TASK_ROW.test(String(this?.source ?? ""))) for (const a of args) note(a);
      return original.apply(this, args);
    };
  }
  try {
    await call();
  } finally {
    for (const [m, original] of patched.reverse()) statement[m] = original;
  }
  return longest;
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

/** The RFB handlers this slice drives, in the RFB fixture. */
function rfbHandlers(fx: Fixture) {
  const marketplace = (require("./marketplace") as any).default;
  const tools = fx.tools.rfb!;
  return {
    tools,
    a2a: fx.a2a.rfb,
    lokalDiscover: async (args: Record<string, unknown>) => textOf(await tools.get("lokal_discover")!({ limit: 10, ...args })),
    postDiscover: (body: unknown) => postRoute(marketplace, "/discover", body),
    card: routeHandler(fx.a2a.rfb, "/a2a"),
  };
}

// ─── B1 ───────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "../..");
const B1_FIXTURE = path.join(ROOT, "tests/fixtures/strukturerte-lister-tak-i-y3-main.json");

/** 50 category names (MAX_NAME_LIST_ITEMS): the platform's 12 and 38 that match nothing. */
const FIFTY_CATEGORIES = [...PLATFORM_CATEGORIES, ...Array.from({ length: 38 }, (_, i) => `kategori-${i}`)];
/** A category name of MAX_NAME_CHARS characters (at the cap). */
const NAME_AT_CAP = ("honey " + "kategori ".repeat(9)).slice(0, 80);

/** Real structured searches on lokal_discover (each with limit 10 unless given). */
const DISCOVER_ASKS: ReadonlyArray<Record<string, unknown>> = [
  {}, { categories: ["honey"] }, { categories: ["honey", "eggs"] }, { categories: ["bakery"] }, { categories: ["bread"] },
  { tags: ["organic"] }, { tags: ["budget"] }, { categories: ["meat"], tags: ["organic"] },
  { categories: ["honey"], ...TRONDHEIM, maxDistanceKm: 50 }, { categories: ["beverages"], drinkSubcategory: "bryggeri" },
  { categories: [...PLATFORM_CATEGORIES] }, { categories: FIFTY_CATEGORIES }, { categories: [NAME_AT_CAP] },
  { categories: ["honey"], limit: 1 }, { categories: ["zzzqqx"] },
];

/** Bodies of POST /api/marketplace/discover: real searches, and small invalid ones (a 400 as before). */
const REST_ASKS: readonly unknown[] = [
  {}, { categories: ["honey"] }, { categories: ["honey", "eggs"], limit: 5 }, { tags: ["organic"] }, { categories: ["meat"], tags: ["organic"] },
  { categories: ["honey"], location: TRONDHEIM, maxDistanceKm: 50 }, { role: "producer", categories: ["dairy"] },
  { query: "honning", categories: ["honey"] }, { skills: ["delivery"] }, { categories: ["beverages"], drinkSubcategory: "cideri" },
  { categories: [...PLATFORM_CATEGORIES] }, { categories: FIFTY_CATEGORIES }, { categories: [NAME_AT_CAP] }, { categories: ["zzzqqx"] },
  { categories: [1] }, { categories: "honey" }, { role: "farmer" }, { location: { lat: "x", lng: 10 } }, { limit: 500 }, [],
];

/** RFB A2A structured messages: a standard DataPart, and the params themselves (mode 3). */
const A2A_ASKS: Readonly<Record<string, readonly unknown[]>> = {
  "rfb a2a data": [
    { categories: ["honey"], note: "hei" }, { categories: ["honey"], configuration: { acceptedOutputModes: ["application/json"] } },
    { categories: FIFTY_CATEGORIES }, { categories: [NAME_AT_CAP], tags: ["organic"] }, { query: "honning", categories: ["honey"], extra: { nested: true } },
    { categories: [1] }, { categories: "honey" }, { role: "farmer" }, { location: { lat: "x", lng: 10 } },
  ],
  "rfb a2a params (mode 3)": [
    { message: {}, categories: ["honey"], configuration: { blocking: true } }, { message: { role: "user" }, tags: ["organic"], metadata: { ref: "x" } },
    { message: {}, categories: [1] },
  ],
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
      for (const ask of DISCOVER_ASKS) note("rfb mcp lokal_discover", ask, stable(await h.lokalDiscover(ask)));
      for (const body of REST_ASKS) note("rfb POST /api/marketplace/discover", body, stable(await h.postDiscover(body)));
      for (const [entry, asks] of Object.entries(A2A_ASKS)) {
        for (const ask of asks) note(entry, ask, stable(await postA2a(h.a2a, entry === "rfb a2a data" ? dataMessage(ask) : ask)));
      }
      note("rfb GET /a2a", {}, stable(await getRoute(h.card, {}, RFB_HOST)));
    } finally {
      rfb.restore();
    }
    const verticals = enterVerticals();
    try {
      note("oa GET /a2a", {}, stable(await getRoute(routeHandler(verticals.a2a.oa, "/a2a"), {}, OA_HOST)));
    } finally {
      verticals.restore();
    }
    return out;
  } finally {
    console.log = prevLog;
  }
}

// ─── The suite ────────────────────────────────────────────────────────────

export async function runStrukturerteListerTakTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ══ H  the helper ════════════════════════════════════════════════════════
  {
    assertEq([MAX_NAME_LIST_ITEMS, MAX_A2A_DATA_LIST_ITEMS, MAX_NAME_CHARS, MAX_FREE_TEXT_CHARS], [50, 50, 80, 2000],
      "H1 the caps, and A2A's list cap is the shared one");
    for (const list of [[], ["honey"], [...PLATFORM_CATEGORIES], FIFTY_CATEGORIES, [NAME_AT_CAP, 7, null]]) {
      assertTrue(capNameList(list as unknown[]) === list, `H2 a list of ${list.length} entries within the caps is the same list`);
    }
    assertEq(capNameList(undefined), undefined, "H2 a list that was not sent stays undefined");
    const many = Array(175_000).fill("honey");
    assertEq(capNameList(many), many.slice(0, MAX_NAME_LIST_ITEMS), "H3 of 175 000 entries, the first MAX_NAME_LIST_ITEMS are kept");
    const big = "honey" + FILLER.repeat(ONE_MB / FILLER.length);
    assertEq(capNameList([big, "eggs", 7]), [capName(big), "eggs", 7], "H3 a long entry is cut as a name (capName), another kept as it is");
    assertTrue(capName(big).length <= MAX_NAME_CHARS && capName(big).startsWith("honey og"), "H3 …at a word boundary");
    const source = [big];
    capNameList(source);
    assertEq(source[0]!.length, big.length, "H3 the list itself is not changed (a copy is cut)");
    const data = capA2aData({ categories: many, tags: [big] }) as Record<string, unknown[]>;
    assertEq([data.categories, data.tags], [capNameList(many), capNameList([big])], "H4 A2A's data cuts its lists with the same helper");
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
        assertTrue(got?.sha256 === want.sha256, `B1 ${entry} ${key.slice(0, 120)}: the answer is main's` +
          (got?.sha256 === want.sha256 ? "" : ` (main ${want.chars} characters, now ${got?.chars})`));
      }
    }
    const expected = DISCOVER_ASKS.length + REST_ASKS.length + Object.values(A2A_ASKS).reduce((n, a) => n + a.length, 0) + 2;
    assertTrue(compared === expected, `B1 the fixture holds every ask (${compared} of ${expected} answers)`);
  }

  const prevLog = console.log;
  const prevError = console.error;
  if (!log) console.log = () => { /* silence module chatter */ };
  try {
    // ══ RFB: L, T, E ═══════════════════════════════════════════════════════
    const rfb = enterRfb();
    try {
      const h = rfbHandlers(rfb);
      const { getDb } = require("../database/init") as typeof import("../database/init");
      const many = Array(175_000).fill("honey");
      const manyTags = Array(175_000).fill("organic");
      const bigCategory = oneMegabyte("honey", "eggs");
      const bigTag = oneMegabyte("organic", "sesong");

      // ── L  lokal_discover ──────────────────────────────────────────────
      {
        let answer = "";
        const [q] = await discoverQueries(async () => { answer = await h.lokalDiscover({ categories: many, tags: manyTags }); });
        assertEq([listShape(q?.categories), listShape(q?.tags)], [[MAX_NAME_LIST_ITEMS, 5], [MAX_NAME_LIST_ITEMS, 7]],
          "L1 lokal_discover: of 175 000 categories and tags, discover() gets MAX_NAME_LIST_ITEMS of each");
        assertSameAnswer(stable(answer), stable(await h.lokalDiscover({ categories: many.slice(0, 50), tags: manyTags.slice(0, 50) })),
          "L1 …and it answers as those");
        let bigAnswer = "";
        const [qBig] = await discoverQueries(async () => { bigAnswer = await h.lokalDiscover({ categories: [bigCategory], tags: [bigTag] }); });
        assertEq([qBig?.categories, qBig?.tags], [[capName(bigCategory)], [capName(bigTag)]],
          "L2 lokal_discover: of one category and one tag of 1 MB, discover() gets the first MAX_NAME_CHARS characters (whole words)");
        assertTrue(capName(bigCategory).length <= MAX_NAME_CHARS && !capName(bigCategory).includes("eggs"), "L2 …so the last word, past the cap, is not read");
        assertSameAnswer(stable(bigAnswer), stable(await h.lokalDiscover({ categories: [capName(bigCategory)], tags: [capName(bigTag)] })),
          "L2 …and it answers as those");
        const honey = ["honey"];
        const [qHoney] = await discoverQueries(() => h.lokalDiscover({ categories: honey }));
        assertTrue(qHoney?.categories === honey, "L3 control: within the caps discover() gets the list as sent (the same list)");
        assertTrue(stable(await h.lokalDiscover({ categories: ["honey"] })) !== stable(await h.lokalDiscover({ categories: ["eggs"] })),
          "L3 control: within the caps the categories decide the answer");
        const ms = await bestOf3(() => h.lokalDiscover({ categories: many, tags: manyTags }));
        assertTrue(ms <= LOOSE_LIMIT_MS, `L4 lokal_discover with 175 000 categories and tags answers in at most ${LOOSE_LIMIT_MS} ms (${ms.toFixed(1)} ms, best of 3; 45 s on live-like data before)`);
      }

      // ── L  POST /api/marketplace/discover ──────────────────────────────
      {
        const skills = Array(175_000).fill("delivery");
        const bigQuery = oneMegabyte("honning", "egg");
        let answer: any;
        const [q] = await discoverQueries(async () => { answer = await h.postDiscover({ categories: many, tags: manyTags, skills, query: bigQuery }); });
        assertEq([listShape(q?.categories), listShape(q?.tags), listShape(q?.skills), q?.query?.length],
          [[MAX_NAME_LIST_ITEMS, 5], [MAX_NAME_LIST_ITEMS, 7], [MAX_NAME_LIST_ITEMS, 8], capFreeText(bigQuery).length],
          "L5 POST /discover: of 175 000 categories, tags and skills, discover() gets MAX_NAME_LIST_ITEMS of each, and of a 1 MB query MAX_FREE_TEXT_CHARS");
        const capped = await h.postDiscover({ categories: many.slice(0, 50), tags: manyTags.slice(0, 50), skills: skills.slice(0, 50), query: capFreeText(bigQuery) });
        assertTrue(answer?.status === 200, `L5 …it is a search answer (${answer?.status})`);
        assertSameAnswer(stable(answer), stable(capped), "L5 …and it answers as those");
        const size = JSON.stringify(answer).length;
        assertTrue(size < 64 * 1024, `L6 …and its answer no longer echoes the list (${size} characters; 3.9 MB on main for 175 000 categories)`);
        let bigAnswer: any;
        const [qBig] = await discoverQueries(async () => { bigAnswer = await h.postDiscover({ categories: [bigCategory], tags: [bigTag] }); });
        assertEq([qBig?.categories, qBig?.tags], [[capName(bigCategory)], [capName(bigTag)]],
          "L7 POST /discover: of one category and one tag of 1 MB, discover() gets the first MAX_NAME_CHARS characters (whole words)");
        assertSameAnswer(stable(bigAnswer), stable(await h.postDiscover({ categories: [capName(bigCategory)], tags: [capName(bigTag)] })),
          "L7 …and it answers as those");
        assertTrue(JSON.stringify(bigAnswer).length < 64 * 1024, `L7 …without echoing the 1 MB (${JSON.stringify(bigAnswer).length} characters)`);
        const invalid = await h.postDiscover({ categories: Array(175_000).fill(1) });
        assertTrue(invalid.status === 400 && invalid.body?.error === "Ugyldig søk" && Array.isArray(invalid.body?.details),
          `L8 an invalid list of 175 000 entries is still a 400 (${invalid.status})`);
        assertTrue(invalid.body?.details?.length === MAX_NAME_LIST_ITEMS && JSON.stringify(invalid).length < 64 * 1024,
          `L8 …with at most MAX_NAME_LIST_ITEMS issues (${invalid.body?.details?.length}; 175 000, 23 MB, on main)`);
        const honey = ["honey"];
        const [qHoney] = await discoverQueries(() => h.postDiscover({ categories: honey, tags: ["organic"] }));
        assertEq([qHoney?.categories, qHoney?.tags], [honey, ["organic"]], "L9 control: within the caps discover() gets the lists as sent");
        assertTrue(stable(await h.postDiscover({ categories: ["honey"] })) !== stable(await h.postDiscover({ categories: ["eggs"] })),
          "L9 control: within the caps the categories decide the answer");
        const ms = await bestOf3(() => h.postDiscover({ categories: many, tags: manyTags }));
        assertTrue(ms <= LOOSE_LIMIT_MS, `L10 POST /discover with 175 000 categories and tags answers in at most ${LOOSE_LIMIT_MS} ms (${ms.toFixed(1)} ms, best of 3)`);
      }

      // ── T  RFB A2A: the total bound ────────────────────────────────────
      {
        const { boundedA2aQuery, MAX_A2A_QUERY_JSON_CHARS } = require("./a2a") as typeof import("./a2a");
        assertEq(MAX_A2A_QUERY_JSON_CHARS, 16_384, "T1 the bound");
        for (const ask of [...A2A_ASKS["rfb a2a data"]!, ...A2A_ASKS["rfb a2a params (mode 3)"]!]) {
          assertTrue(boundedA2aQuery(ask) === ask, `T1 a query within the bound is the same object (${JSON.stringify(ask).slice(0, 60)})`);
        }
        // In the schema's order, which the fields past the bound come in.
        const atCaps = { query: "q".repeat(MAX_FREE_TEXT_CHARS), categories: Array(50).fill("c".repeat(80)),
          tags: Array(50).fill("t".repeat(80)), skills: Array(50).fill("s".repeat(80)), drinkSubcategory: "d".repeat(MAX_FREE_TEXT_CHARS) };
        assertTrue(JSON.stringify(atCaps).length > MAX_A2A_QUERY_JSON_CHARS && JSON.stringify(boundedA2aQuery(atCaps)) === JSON.stringify(atCaps),
          `T1 the fields a discovery reads, all at their caps (${JSON.stringify(atCaps).length} characters), keep their values`);
        const junk = Object.fromEntries(Array.from({ length: 525 }, (_, i) => [`k${i}`, FILLER.repeat(666)]));
        const spread = { ...junk, categories: ["honey"], limit: 5 };
        assertTrue(JSON.stringify(spread).length > ONE_MB, "T2 setup: a query that spreads 1 MB over 525 keys of at most MAX_FREE_TEXT_CHARS");
        assertEq(boundedA2aQuery(spread), { categories: ["honey"], limit: 5 }, "T2 past the bound: the fields the discovery reads, as sent");
        const nested = { categories: ["honey"], location: { lat: 63.43, lng: 10.4, junk: "x".repeat(ONE_MB) }, deep: { text: "y".repeat(ONE_MB) } };
        assertEq(boundedA2aQuery(nested), { categories: ["honey"], location: { lat: 63.43, lng: 10.4 } },
          "T2 …as the discovery reads them: a nested object it never reads is left out, and `location` is its lat and lng");
        assertEq(boundedA2aQuery({ ...junk, categories: [1] }), {}, "T2 a query the schema rejects (answered as invalid) is nothing");
        assertEq([boundedA2aQuery(capFreeText("x".repeat(ONE_MB))), boundedA2aQuery(null), boundedA2aQuery(undefined)], [capFreeText("x".repeat(ONE_MB)), null, undefined],
          "T2 data that is no object is as it is (a string is cut to MAX_FREE_TEXT_CHARS by capA2aData)");

        // What the call logs, stores and echoes.
        const parsedOf = (answer: any) => answer.body?.result?.artifacts?.[0]?.parts?.[0]?.data?.parsedQuery;
        const agentsOf = (answer: any) => stable(answer.body?.result?.artifacts?.[0]?.parts?.[0]?.data?.agents);
        const rows = () => (getDb().prepare("SELECT COUNT(*) AS n FROM interactions WHERE type = 'search'").get() as { n: number }).n +
          (getDb().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;
        const plain = await postA2a(h.a2a, dataMessage({ categories: ["honey"], limit: 5 }));
        for (const [label, params] of [
          ["a DataPart with 525 keys", dataMessage(spread)],
          ["mode 3 with 525 keys", { message: {}, ...spread }],
          ["mode 3 with a nested 1 MB message", { message: { junk: { text: "z".repeat(ONE_MB) } }, categories: ["honey"], limit: 5 }],
        ] as const) {
          let answer: any;
          const before = rows();
          const longest = await longestStoredString(async () => { answer = await postA2a(h.a2a, params); });
          assertTrue(rows() > before, `T3 RFB A2A ${label}: the call is logged and starts conversations (setup)`);
          assertTrue(longest <= MAX_A2A_QUERY_JSON_CHARS,
            `T3 …no string longer than MAX_A2A_QUERY_JSON_CHARS reaches the interactions log or the conversations (${longest})`);
          assertEq(parsedOf(answer), { categories: ["honey"], limit: 5 }, `T3 …the answer echoes the fields the discovery read`);
          assertTrue(JSON.stringify(answer.body).length < 64 * 1024, `T3 …in an answer of ${JSON.stringify(answer.body).length} characters`);
          assertSameAnswer(agentsOf(answer), agentsOf(plain), "T3 …and it finds what those fields find");
        }
        const extra = { categories: ["honey"], note: "hei" };
        assertEq(parsedOf(await postA2a(h.a2a, dataMessage(extra))), extra, "T4 control: within the bound the echo is the query as sent, extra keys too");
      }

      // ── E  RFB A2A: no internal error text ─────────────────────────────
      {
        const errors: string[] = [];
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
        const failedTask = () => getDb().prepare("SELECT id, error FROM tasks WHERE status = 'failed' ORDER BY rowid DESC LIMIT 1").get() as { id: string; error: string } | undefined;

        errors.length = 0;
        const send = await withFailingSql(/FROM agents/, () => postA2a(h.a2a, dataMessage({ categories: ["honey"] })));
        assertEq(send.body?.error, { code: -32603, message: "Internal error" }, "E1 RFB A2A message/send: a failure inside the search answers -32603 without data");
        assertTrue(!JSON.stringify(send.body).includes(SECRET), "E1 …the error's own message is not in the answer");
        assertTrue(errors.some((e) => e.includes("[a2a] message/send failed") && e.includes(SECRET)), `E1 …it is logged (${errors[0]?.split("\n")[0]?.slice(0, 100)})`);
        const task = failedTask();
        assertEq(task?.error, "Internal error", "E1 …and the task's error is the generic text");
        const got = await rpc(h.a2a, "tasks/get", { taskId: task?.id });
        assertTrue(got.body?.result?.task?.error === "Internal error" && !JSON.stringify(got.body).includes(SECRET), "E1 …so tasks/get does not hand it out either");

        errors.length = 0;
        const dispatch = await withFailingSql(/INSERT INTO tasks/, () => postA2a(h.a2a, dataMessage({ categories: ["honey"] })));
        assertEq(dispatch.body?.error, { code: -32603, message: "Internal error" }, "E2 RFB A2A dispatcher: a failure answers -32603 without data");
        assertTrue(!JSON.stringify(dispatch.body).includes(SECRET) && errors.some((e) => e.includes("[a2a] POST /a2a failed") && e.includes(SECRET)),
          "E2 …the detail is logged, not answered");

        const invalid = await postA2a(h.a2a, dataMessage({ categories: [1] }));
        assertTrue(invalid.body?.error?.code === -32602 && invalid.body.error.message === "Invalid discovery query" &&
          JSON.parse(invalid.body.error.data)?.[0]?.path?.join(".") === "categories.0", "E3 an invalid query is still -32602 with Zod's issues (path categories.0)");
        assertEq(failedTask()?.error, invalid.body?.error?.data, "E3 …and the task's error is those issues, as before");
        const invalidMany = await postA2a(h.a2a, dataMessage({ categories: Array(175_000).fill(1) }));
        assertEq(JSON.parse(invalidMany.body?.error?.data ?? "[]").length, MAX_A2A_DATA_LIST_ITEMS, "E3 …of at most the capped entries (capA2aData)");

        errors.length = 0;
        const card = await withFailingSql(/FROM agents/, () => getRoute(h.card, {}, RFB_HOST));
        assertEq([card.status, card.body], [500, { error: "Failed to generate agent card" }], "E4 RFB GET /a2a: a failure answers 500 without the detail");
        assertTrue(errors.some((e) => e.includes("[a2a] GET /a2a agent card failed") && e.includes(SECRET)), "E4 …which is logged");
        console.error = prevError;
      }

      // ── E  sweep: RFB MCP and A2A with all of SQLite failing ───────────
      {
        console.error = () => { /* the details are logged; E1–E4 check them */ };
        const rfbToolArgs: Record<string, Record<string, unknown>> = {
          lokal_search: { query: "honning i Trondheim", limit: 5 }, lokal_discover: { categories: ["honey"], limit: 5 },
          lokal_info: { agentId: "1a000000-0000-4000-8000-000000000004" }, lokal_stats: {}, lokal_list_umbrellas: { limit: 5 },
          lokal_get_umbrella_members: { umbrellaId: "x", limit: 5 }, lokal_get_producer_affiliations: { producerId: "x" },
          lokal_bm_next_markets: { region: "Oslo" }, lokal_geocode: { place: "Oslo" }, lokal_find_offers: { items: ["honning"], near: "Trondheim" },
          lokal_cart_create: {}, lokal_cart_add_item: { buyer_ref: "x", product_id: "x", quantity: 1 }, lokal_cart_view: { buyer_ref: "x" },
          lokal_cart_submit: { buyer_ref: "x", contact_consent: false }, lokal_order_status: { buyer_ref: "x" },
        };
        assertEq([...h.tools.keys()].sort(), Object.keys(rfbToolArgs).sort(), "E8 setup: the sweep calls every RFB MCP tool");
        const leaks: string[] = [];
        await withFailingSql(/./, async () => {
          for (const [tool, args] of Object.entries(rfbToolArgs)) {
            if (JSON.stringify(await h.tools.get(tool)!(args)).includes(SECRET)) leaks.push(`mcp ${tool}`);
          }
          for (const [method, params] of [
            ["message/send", textMessage("honning i Trondheim")], ["message/send", dataMessage({ categories: ["honey"] })],
            ["message/send", { message: {}, categories: ["honey"] }], ["tasks/get", { taskId: "x" }], ["tasks/list", {}],
            ["agent/authenticatedExtendedCard", {}], ["agent/info", { agentId: "x" }],
          ] as const) {
            if (JSON.stringify((await rpc(h.a2a, method, params)).body).includes(SECRET)) leaks.push(`a2a ${method}`);
          }
        });
        assertEq(leaks, [], "E8 RFB: no MCP tool and no A2A method answers SQLite's error text");
        console.error = prevError;
      }
    } finally {
      console.error = prevError;
      rfb.restore();
    }

    // ══ Opplevagent and Finn-tannlege: E ═══════════════════════════════════
    const verticals = enterVerticals();
    try {
      const { EXPERIENCES_MCP_INTERNAL_ERROR_TEXT } = require("./experiences-mcp") as typeof import("./experiences-mcp");
      const { DENTAL_MCP_INTERNAL_ERROR_TEXT } = require("./dental-mcp") as typeof import("./dental-mcp");
      const errors: string[] = [];
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
      const oa = verticals.a2a.oa;
      const experienceId = (require("../database/db-factory") as typeof import("../database/db-factory"))
        .getDb("experiences").prepare("SELECT id FROM experiences LIMIT 1").get() as { id: string };

      // ── E  Opplevagent A2A ─────────────────────────────────────────────
      for (const [skill, text] of [
        ["opplevelser_categories", "Hvilke kategorier finnes?"], ["opplevelser_info", `info ${experienceId.id}`],
        ["gardssalg_discover", "sidersmaking i Hardanger"], ["opplevelser_discover", "nordlys i Tromsø"],
      ] as const) {
        const ok = await postA2a(oa, textMessage(text));
        assertTrue((ok.body as any)?.result?.metadata?.skill === skill, `E5 setup: «${text}» is ${skill}`);
        errors.length = 0;
        const answer = await withFailingSql(/./, () => postA2a(oa, textMessage(text)));
        assertEq((answer.body as any)?.error, { code: -32603, message: "Internal error" }, `E5 Opplevagent A2A ${skill}: a failure answers -32603 without data`);
        assertTrue(errors.some((e) => e.includes(`[experiences-a2a] message/send (${skill}) failed`) && e.includes(SECRET)),
          `E5 …the detail is logged (${errors[0]?.split("\n")[0]?.slice(0, 100)})`);
      }
      errors.length = 0;
      const throwing = { message: { get text(): string { throw new Error(`${SECRET}: a getter`); } } };
      const dispatch = await rpc(oa, "message/send", throwing);
      assertEq(dispatch.body?.error, { code: -32603, message: "Internal error" }, "E5 Opplevagent A2A dispatcher: a failure answers -32603 without data");
      assertTrue(errors.some((e) => e.includes("[experiences-a2a] POST /a2a failed") && e.includes(SECRET)), "E5 …the detail is logged");

      // ── E  Opplevagent MCP and Finn-tannlege MCP ────────────────────────
      const toolCases: ReadonlyArray<[string, Map<string, (a: any) => Promise<any>>, string, Record<string, unknown>, string]> = [
        ["experiences-mcp", verticals.tools.oa!, "discover_experiences", { query: "nordlys", limit: 5 }, EXPERIENCES_MCP_INTERNAL_ERROR_TEXT],
        ["experiences-mcp", verticals.tools.oa!, "list_experience_categories", {}, EXPERIENCES_MCP_INTERNAL_ERROR_TEXT],
        ["experiences-mcp", verticals.tools.oa!, "get_experience", { id: experienceId.id }, EXPERIENCES_MCP_INTERNAL_ERROR_TEXT],
        ["experiences-mcp", verticals.tools.oa!, "discover_gardssalg", { fylke: "Vestland", limit: 5 }, EXPERIENCES_MCP_INTERNAL_ERROR_TEXT],
        ["experiences-mcp", verticals.tools.oa!, "book_gardssalg",
          { provider_query: "Fjordgard Bryggeri", slot_at: "2030-06-01T12:00", party_size: 2, guest_name: "Kari", guest_email: "kari@example.no" },
          EXPERIENCES_MCP_INTERNAL_ERROR_TEXT],
        ["dental-mcp", verticals.tools.dental!, "tannlege_search", { query: "tannlege i Oslo", limit: 5 }, DENTAL_MCP_INTERNAL_ERROR_TEXT],
        ["dental-mcp", verticals.tools.dental!, "tannlege_info", { org_nr: "912345678" }, DENTAL_MCP_INTERNAL_ERROR_TEXT],
        ["dental-mcp", verticals.tools.dental!, "tannlege_stats", {}, DENTAL_MCP_INTERNAL_ERROR_TEXT],
        ["dental-mcp", verticals.tools.dental!, "tannlege_akutt", { fylke: "Oslo" }, DENTAL_MCP_INTERNAL_ERROR_TEXT],
        ["dental-mcp", verticals.tools.dental!, "tannlege_kjeder", {}, DENTAL_MCP_INTERNAL_ERROR_TEXT],
      ];
      for (const [tag, tools, tool, args, text] of toolCases) {
        const ok = await tools.get(tool)!(args);
        assertTrue(!ok?.isError, `E6 setup: ${tool} answers without the failure`);
        errors.length = 0;
        const answer = await withFailingSql(/./, () => tools.get(tool)!(args));
        assertEq(answer, { content: [{ type: "text", text }], isError: true }, `E6 ${tag} ${tool}: a failure answers the generic text`);
        assertTrue(errors.some((e) => e.includes(`[${tag}] ${tool} failed`) && e.includes(SECRET)), `E6 …the detail is logged`);
      }
      assertTrue(EXPERIENCES_MCP_INTERNAL_ERROR_TEXT.includes("Opplevagent") && DENTAL_MCP_INTERNAL_ERROR_TEXT.includes("Finn-tannlege"),
        "E6 …each in the platform's own name");

      // A database that is not open is still «no data» on Opplevagent MCP (unchanged).
      const { statement } = sqlitePrototypes();
      const all = statement.all!;
      statement.all = function () { throw new TypeError("The database connection is not open"); };
      let closed: any;
      try {
        closed = await verticals.tools.oa!.get("discover_experiences")!({ query: "nordlys", limit: 5 });
      } finally {
        statement.all = all;
      }
      assertEq(closed, { content: [{ type: "text", text: "Ingen data tilgjengelig for oyeblikket. / No experience data available at this time." }] },
        "E7 Opplevagent MCP: a database that is not open still answers that no data is available");

      // ── E  sweep: Opplevagent and Finn-tannlege, MCP and A2A ───────────
      console.error = () => { /* the details are logged; E5 and E6 check them */ };
      const toolNames = (tools: Map<string, unknown>) => [...tools.keys()].sort();
      assertEq([toolNames(verticals.tools.oa!), toolNames(verticals.tools.dental!)],
        [toolCases.filter((c) => c[0] === "experiences-mcp").map((c) => c[2]).sort(), toolCases.filter((c) => c[0] === "dental-mcp").map((c) => c[2]).sort()],
        "E8 setup: the sweep calls every Opplevagent and Finn-tannlege MCP tool");
      const leaks: string[] = [];
      await withFailingSql(/./, async () => {
        for (const [, tools, tool, args] of toolCases) if (JSON.stringify(await tools.get(tool)!(args)).includes(SECRET)) leaks.push(`mcp ${tool}`);
        for (const [platform, router, params] of [
          ["oa", oa, textMessage("nordlys i Tromsø")], ["oa", oa, dataMessage({ fylke: "Troms" })], ["oa", oa, textMessage("sidersmaking")],
          ["dental", verticals.a2a.dental, textMessage("tannlege i Oslo")], ["dental", verticals.a2a.dental, textMessage("statistikk")],
          ["dental", verticals.a2a.dental, textMessage("Finn klinikk 912345678")], ["dental", verticals.a2a.dental, dataMessage({ fylke: "Oslo" })],
        ] as const) {
          if (JSON.stringify((await rpc(router, "message/send", params)).body).includes(SECRET)) leaks.push(`${platform} a2a ${JSON.stringify(params).slice(0, 60)}`);
        }
      });
      assertEq(leaks, [], "E8 Opplevagent and Finn-tannlege: no MCP tool and no A2A message answers SQLite's error text");
    } finally {
      console.error = prevError;
      verticals.restore();
    }
  } catch (err: any) {
    failed++;
    failures.push("strukturerte-lister-tak: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    console.error = prevError;
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
    runStrukturerteListerTakTests({ log: true }).then((s) => {
      console.log(`\n${s.passed} passed, ${s.failed} failed`);
      for (const f of s.failures) console.log(f);
      process.exit(s.failed > 0 ? 1 : 0);
    });
  }
}
