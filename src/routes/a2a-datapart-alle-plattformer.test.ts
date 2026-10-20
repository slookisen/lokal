/**
 * a2a-datapart-alle-plattformer.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-X (FUNN
 * dental-a2a-datapart-ignoreres, P2, and dental-a2a-orgnr-med-mellomrom, P3).
 *
 * The A2A standard sends structured data as a DataPart, message.parts:
 * [{kind: "data", data: {…}}], but RFB (a2a.ts), Opplevagent
 * (experiences-a2a.ts) and Finn-tannlege (dental-a2a.ts) read only
 * message.data: Finn-tannlege answered a DataPart {fylke: "Oslo"} with the
 * whole register, RFB used the whole params as the query (Mode 3).
 * utils/a2a-message.ts now gives each handler the first DataPart when the
 * message has no message.data.
 *
 *   H   a2aMessageData(): kind, and type for older clients; message.data
 *       first; the first DataPart whose data is an object; else
 *       message.data itself.
 *   D   Finn-tannlege: a DataPart gives message.data's answer (filter, count,
 *       total) and its AI-lookup count; message.data and text keep their
 *       precedence. «912 345 678» finds the same clinic as «912345678»;
 *       eight digits, a postnummer and three groups inside a longer spaced
 *       number («123 912 345 678») do not ask for tannlege_info.
 *   O   Opplevagent: the same for discover, and the gårdssalg origin
 *       (lat/lng) sent next to text.
 *   R   RFB: a DataPart is Mode 2 like message.data (same answer, same
 *       count); without one, Mode 3 (the whole params) as before.
 *   B1  messages with text, with message.data or with neither (and with a
 *       DataPart that loses to those) answer byte for byte as main did:
 *       tests/fixtures/a2a-datapart-i-x-main.json holds the sha256 of each
 *       answer (ids, timestamps and origins masked) and a readable summary,
 *       captured with b1Answers() below on main 58d5974e.
 *
 * Data: own in-memory DBs (main, dental, experiences; restored in finally),
 * the real routers through router.handle() (no HTTP server, no network:
 * Kartverket is a stub that knows no name, since RFB A2A looks the place of
 * a text up as of slice I-AA).
 * MCP tools and the agent cards are not touched by I-X; their freezes are
 * rfb-mcp-contract-freeze.test.ts, opplevagent-mcp-contract-freeze.test.ts,
 * dental-mcp-instructions.test.ts and dental-agent-card.test.ts.
 *
 * Exported runA2aDatapartAllePlattformerTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/a2a-datapart-alle-plattformer.test.ts
 */

import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { __pinInMemoryDbForTesting, __peekDbForTesting } from "../database/init";
import { a2aMessageData } from "../utils/a2a-message";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  /** res.locals.a2aCountable: the «AI-søk» verdict mcp-usage-logger.ts stores. */
  countable: unknown;
}

let ipSeq = 0;
/** A fresh client address per call, so the per-IP caps never decide a verdict here. */
function nextIp(): string {
  ipSeq++;
  return `10.124.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

/**
 * POST /a2a message/send through router.handle(). res is an EventEmitter:
 * recordA2aDelivery() waits for "finish", which is never sent here.
 */
function postA2a(router: any, params: unknown): Promise<RouteResult> {
  return new Promise((resolve) => {
    const ip = nextIp();
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "curl/8.5.0" };
    const req: any = {
      method: "POST",
      url: "/a2a",
      originalUrl: "/a2a",
      path: "/a2a",
      query: {},
      headers,
      body: { jsonrpc: "2.0", method: "message/send", params, id: "x" },
      ip,
      socket: { remoteAddress: ip },
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = Object.assign(new EventEmitter(), {
      statusCode: 200,
      locals: {} as Record<string, unknown>,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      header() { return this; },
      set() { return this; },
      append() { return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload, countable: this.locals.a2aCountable }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload, countable: this.locals.a2aCountable }); return this; },
    });
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: String(err ?? "no route"), countable: undefined }));
  });
}

/** The answer with what differs per run masked: ids, timestamps, Date.now() task ids, slug suffixes, origins. */
function stable(v: unknown): string {
  return JSON.stringify(v)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/-\d{13}\b/g, "-<now>")
    .replace(/--[0-9a-f]{8}"/g, '--<id8>"')
    .replace(/https?:\/\/[^/"]+/g, "<origin>");
}

const dataPart = (data: unknown) => ({ kind: "data", data });
const textPart = (text: string) => ({ kind: "text", text });

const DENTAL_ORGNR = "912345678";

type Platform = "dental" | "experiences" | "rfb";

/**
 * B1: params whose answer must not change — text, message.data, neither, and
 * a DataPart that loses to text, to message.data or is no object.
 */
export const B1_PARAMS: Readonly<Record<Platform, readonly unknown[]>> = {
  dental: [
    { message: "tannlege i Oslo" },
    { message: { text: "tannlege i Oslo" } },
    { message: { role: "user", parts: [textPart("tannlege i Bergen")] } },
    { message: { parts: [textPart("statistikk")] } },
    { message: { parts: [textPart(`Finn klinikk ${DENTAL_ORGNR}`)] } },
    { message: { parts: [textPart(`Finn klinikk ${DENTAL_ORGNR} eller 923 456 789`)] } },
    { message: { parts: [textPart("ring 22334455")] } },
    { message: { parts: [textPart("ring 22 33 44 55")] } },
    { message: { parts: [textPart("tannlege 0150 Oslo")] } },
    { message: { data: { fylke: "Oslo" } } },
    { message: { data: { helfo_agreement: "true" } } },
    { message: { data: {} } },
    { message: { data: null } },
    { message: { role: "user" } },
    { message: { parts: [] } },
    { message: { parts: [textPart("tannlege i Bergen"), dataPart({ fylke: "Oslo" })] } },
    { message: { data: { fylke: "Vestland" }, parts: [dataPart({ fylke: "Oslo" })] } },
    { message: { parts: [dataPart("Oslo")] } },
    { message: { parts: [dataPart(["Oslo"])] } },
    {},
  ],
  experiences: [
    { message: "hva kan vi finne på i Tromsø om vinteren?" },
    { message: { text: "nordlys i Tromsø" } },
    { message: { parts: [textPart("kategorier")] } },
    { message: { parts: [textPart("sidersmaking i Bergen")] } },
    { message: { text: "sidersmaking i Bergen", data: { lat: 60.39, lng: 5.32 } } },
    { message: { parts: [textPart("zzzqqq ingen treff")] } },
    { message: { data: { kommune: "Tromsø" } } },
    { message: { data: { fylke: "Vestland" } } },
    { message: { data: { lat: 69.65, lng: 18.95, sort: "distance" } } },
    { message: { data: {} } },
    { message: { data: null } },
    { message: { role: "user" } },
    { message: { parts: [] } },
    { message: { parts: [textPart("nordlys i Tromsø"), dataPart({ kommune: "Bergen" })] } },
    { message: { data: { kommune: "Bergen" }, parts: [dataPart({ kommune: "Tromsø" })] } },
    { message: { parts: [dataPart("Tromsø")] } },
  ],
  rfb: [
    { message: "honning i Oslo" },
    { message: { text: "honning i Oslo" } },
    { message: { role: "user", parts: [textPart("melk")] } },
    { message: { parts: [textPart("hello there")] } },
    { message: { data: { categories: ["honey"] } } },
    { message: { data: { categories: ["dairy"], limit: 1 } } },
    { message: { data: {} } },
    { message: { data: null } },
    { message: { role: "user" } },
    { message: { parts: [] } },
    { message: { role: "user" }, categories: ["honey"] },
    { message: { parts: [textPart("melk"), dataPart({ categories: ["honey"] })] } },
    { message: { data: { categories: ["dairy"] }, parts: [dataPart({ categories: ["honey"] })] } },
    { message: { parts: [dataPart("honey")] }, categories: ["honey"] },
  ],
};

interface Fixtures {
  dental: typeof import("./dental-a2a");
  experiences: typeof import("./experiences-a2a");
  routers: Record<Platform, any>;
  /** Oslo Sentrum Tann, org.nr 912345678. */
  osloClinicId: string;
  restore(): void;
}

/**
 * Fresh in-memory DBs for the three platforms: four clinics (two in Oslo),
 * three experiences (two in Tromsø) and a gårdssalg cideri in Bergen, three
 * RFB producers (two honey, one dairy). Same data on main and on this branch.
 */
function enterFixtures(): Fixtures {
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ["DENTAL_DB_PATH", "EXPERIENCES_DB_PATH", "DENTAL_QUERY_PARSER_DISABLED", "BOOKING_DISPATCH_ENABLED"]) prevEnv[k] = process.env[k];
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;
  delete process.env.BOOKING_DISPATCH_ENABLED;
  const restoreMainDb = __pinInMemoryDbForTesting();
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-catalog-class"),
    require.resolve("../services/dental-search-gazetteer"),
    require.resolve("./dental-a2a"),
    require.resolve("../services/experience-store"),
    require.resolve("./experiences-a2a"),
  ]);
  const { a2aConversationCap } = require("../services/a2a-traffic-classifier") as typeof import("../services/a2a-traffic-classifier");
  // Slice I-AA: RFB A2A looks up the place of «honning i Oslo». Offline, only
  // the built-in places resolve, as when Kartverket knows no such name.
  const geo = require("../services/geocoding-service") as typeof import("../services/geocoding-service");
  geo.__setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  geo.__clearGeocodeCacheForTesting();
  const restore = () => {
    a2aConversationCap.reset();
    geo.__setGeocodingFetchForTesting();
    geo.__clearGeocodeCacheForTesting();
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
    restoreMainDb();
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
    const osloClinicId = addClinic({ navn: "Oslo Sentrum Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0150", org_nr: DENTAL_ORGNR });
    addClinic({ navn: "Majorstua Tann", poststed: "OSLO", fylke: "Oslo", postnummer: "0151", helfo_agreement: "true" });
    addClinic({ navn: "Bergen Tann", poststed: "BERGEN", fylke: "Vestland", postnummer: "5003", org_nr: "923456789" });
    addClinic({ navn: "Stavanger Tann", poststed: "STAVANGER", fylke: "Rogaland", postnummer: "4006" });

    // Opplevagent
    const expDb = dbFactory.getDb("experiences");
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
    addExperience("Hundekjøring i Tromsø", "Tromsø", "Troms", { season: ["winter"], lat: 69.66, lng: 18.96 });
    addExperience("Fjordcruise fra Bergen", "Bergen", "Vestland", { season: ["summer"], lat: 60.39, lng: 5.32 });
    expDb.prepare(
      `INSERT INTO experience_providers
         (id, navn, vertical, fylke, kommune, producer_type, booking_live, lat, lon, slug,
          enrichment_state, verification_status, source, confidence)
       VALUES ('i-x-sideri', 'Bergen Sideri AS', 'experiences', 'Vestland', 'Bergen', 'cideri', 1, 60.39, 5.32, 'bergen-sideri',
          'raw', 'pending_verify', 'test-fixture', 'medium')`
    ).run();

    // RFB
    const mainDb = __peekDbForTesting()!;
    const addProducer = mainDb.prepare(`
      INSERT INTO agents
        (id, name, description, provider, contact_email, url, version, role, api_key,
         lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
         trust_score, is_active, is_verified, discovery_count, interaction_count,
         total_interactions, created_at, last_seen_at)
      VALUES (?, ?, 'Lokal produsent', 'test', ?, ?, '1.0.0', 'producer', ?, NULL, NULL, ?, NULL, ?, '[]', '[]', '{}', '["no"]',
              ?, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
    `);
    for (const [id, name, city, categories, trust] of [
      ["i-x-honning-1", "Oslo Honningbu", "Oslo", ["honey"], 0.72],
      ["i-x-honning-2", "Birøkter Hansen", "Asker", ["honey"], 0.61],
      ["i-x-meieri", "Fjellmeieriet", "Vågå", ["dairy"], 0.66],
    ] as const) {
      addProducer.run(id, name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`, city, JSON.stringify(categories), trust);
    }
    a2aConversationCap.reset();

    const dental = require("./dental-a2a") as typeof import("./dental-a2a");
    const experiences = require("./experiences-a2a") as typeof import("./experiences-a2a");
    return {
      dental,
      experiences,
      routers: { dental: dental.default, experiences: experiences.default, rfb: (require("./a2a") as any).default },
      osloClinicId,
      restore,
    };
  } catch (err) {
    restore();
    throw err;
  }
}

/** A readable line per answer, kept next to its hash in the fixture. */
function summaryOf(platform: Platform, r: RouteResult): Record<string, unknown> {
  const body = r.body;
  if (body?.error) return { error: body.error.code };
  if (platform === "rfb") {
    const d = body?.result?.artifacts?.[0]?.parts?.[0]?.data;
    return { count: d?.count, parsedQuery: d?.parsedQuery, countable: r.countable };
  }
  const md = body?.result?.metadata ?? {};
  const counted = (body?.result?.artifacts ?? []).map((a: any) => a?.parts?.[0]?.data?.count).find((c: unknown) => typeof c === "number");
  return { skill: md.skill, filter: md.filter ?? null, count: counted ?? null, countable: r.countable };
}

/**
 * B1_PARAMS through the three routers on fresh fixtures: per answer, the
 * sha256 of stable(body + countable) and summaryOf(). Uses only what main
 * has, so main's answers are captured with it.
 */
export async function b1Answers(): Promise<Record<string, { sha256: string; summary: Record<string, unknown> }>> {
  const fx = enterFixtures();
  const prevLog = console.log;
  console.log = () => { /* silence module chatter */ };
  try {
    const out: Record<string, { sha256: string; summary: Record<string, unknown> }> = {};
    for (const platform of ["dental", "experiences", "rfb"] as const) {
      for (const params of B1_PARAMS[platform]) {
        const r = await postA2a(fx.routers[platform], params);
        const sha256 = createHash("sha256").update(stable({ status: r.status, body: r.body, countable: r.countable })).digest("hex");
        out[`${platform} ${JSON.stringify(params)}`] = { sha256, summary: summaryOf(platform, r) };
      }
    }
    return out;
  } finally {
    console.log = prevLog;
    fx.restore();
  }
}

const B1_FIXTURE = path.join(__dirname, "../../tests/fixtures/a2a-datapart-i-x-main.json");

export async function runA2aDatapartAllePlattformerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  /** Two stable() answers: the same, or where they first differ. */
  function assertSameAnswer(actual: string, expected: string, label: string): void {
    if (actual === expected) return assertTrue(true, label);
    let i = 0;
    while (actual[i] === expected[i]) i++;
    assertTrue(false,
      `${label} (differs at ${i}: expected …${expected.slice(Math.max(0, i - 40), i + 80)}…, got …${actual.slice(Math.max(0, i - 40), i + 80)}…)`);
  }

  // ══ H  a2aMessageData()═════════════════════════════════════════════════
  {
    assertEq(a2aMessageData({ parts: [dataPart({ fylke: "Oslo" })] }), { fylke: "Oslo" }, "H1 kind: data → its data");
    assertEq(a2aMessageData({ parts: [{ type: "data", data: { fylke: "Oslo" } }] }), { fylke: "Oslo" }, "H2 type: data (older clients) → its data");
    assertEq(a2aMessageData({ data: { fylke: "Vestland" }, parts: [dataPart({ fylke: "Oslo" })] }), { fylke: "Vestland" },
      "H3 message.data wins over a DataPart");
    assertEq(a2aMessageData({ parts: [textPart("hei"), dataPart({ a: 1 }), dataPart({ b: 2 })] }), { a: 1 }, "H4 the first DataPart, after a text part");
    assertEq(a2aMessageData({ parts: [dataPart("Oslo"), dataPart(["Oslo"]), dataPart(null), dataPart({ c: 3 })] }), { c: 3 },
      "H5 a DataPart whose data is no object (string, array, null) is skipped");
    assertEq(a2aMessageData({ parts: [{ kind: "text", type: "data", data: { d: 4 } }] }), undefined, "H6 kind decides over type: kind text is no DataPart");
    assertEq(a2aMessageData({ parts: [{ data: { e: 5 } }] }), undefined, "H7 a part without kind or type is no DataPart");
    assertEq(a2aMessageData({ data: null, parts: [dataPart({ f: 6 })] }), { f: 6 }, "H8 message.data null: the DataPart");
    assertTrue(a2aMessageData({ data: null }) === null, "H9 message.data null and no DataPart: null, as before");
    assertTrue(a2aMessageData({ data: "" }) === "", "H10 message.data a value that is not an object: itself, as before");
    assertTrue(a2aMessageData({ role: "user", parts: "x" }) === undefined, "H11 parts not an array, no data: undefined");
    for (const m of ["tekst", 7, null, undefined]) {
      assertTrue(a2aMessageData(m) === undefined, `H12 message ${JSON.stringify(m)} (no object): undefined`);
    }
  }

  const prevLog = console.log;
  let fx: Fixtures | null = null;
  try {
    // ══ B1  main's answers, byte for byte ════════════════════════════════
    {
      const main = JSON.parse(fs.readFileSync(B1_FIXTURE, "utf8")) as { answers: Record<string, { sha256: string; summary: Record<string, unknown> }> };
      const now = await b1Answers();
      assertTrue(JSON.stringify(Object.keys(now)) === JSON.stringify(Object.keys(main.answers)),
        `B1 the fixture has every B1 message, in order (${Object.keys(main.answers).length} in the fixture, ${Object.keys(now).length} now)`);
      for (const [key, want] of Object.entries(main.answers)) {
        const same = now[key]?.sha256 === want.sha256;
        assertTrue(same, `B1 ${key}: the answer is main's` +
          (same ? "" : ` (main ${JSON.stringify(want.summary)}, now ${JSON.stringify(now[key]?.summary)})`));
      }
      const shapes = Object.values(main.answers).map((a) => a.summary);
      assertTrue(shapes.some((s) => s.skill === "tannlege_info") && shapes.some((s) => s.skill === "gardssalg_discover") &&
        shapes.some((s) => s.countable === true) && shapes.some((s) => s.countable === false),
        "B1 the messages cover the info and gårdssalg skills and both count verdicts (not a vacuous pin)");
    }

    if (!log) console.log = () => { /* silence module chatter */ };
    fx = enterFixtures();
    const { dental, experiences, routers } = fx;
    const asDental = (message: unknown) => dental.handleDentalMessageSend({ message }, "d") as any;
    const asExperiences = (message: unknown) => experiences.handleExperiencesMessageSend({ message }, "o") as any;
    const searchData = (r: any) => (r?.result?.artifacts ?? []).map((a: any) => a?.parts?.[0]?.data).find((d: any) => typeof d?.count === "number");

    // ══ D  Finn-tannlege ═════════════════════════════════════════════════
    {
      const viaData = asDental({ data: { fylke: "Oslo" } });
      const viaPart = asDental({ parts: [dataPart({ fylke: "Oslo" })] });
      assertEq(viaPart.result?.metadata?.filter, { fylke: "Oslo" }, "D1 DataPart {fylke: Oslo}: filter {fylke: Oslo} (main: {}, the whole register)");
      assertEq([searchData(viaPart)?.count, searchData(viaPart)?.total], [2, 2], "D1 …count and total are the two Oslo clinics (of 4)");
      assertEq([searchData(viaPart)?.count, searchData(viaPart)?.total], [searchData(viaData)?.count, searchData(viaData)?.total],
        "D1 …the same count and total as message.data {fylke: Oslo}");
      assertSameAnswer(stable(viaPart), stable(viaData), "D1 …the whole answer is message.data's");
      assertSameAnswer(stable(asDental({ parts: [{ type: "data", data: { fylke: "Oslo" } }] })), stable(viaData), "D2 type: data gives the same answer");
      assertSameAnswer(stable(asDental({ kind: "message", messageId: "m-1", role: "user", parts: [dataPart({ fylke: "Oslo" })] })), stable(viaData),
        "D3 a full A2A message (kind, messageId, role) with a DataPart gives the same answer");

      const vestland = asDental({ data: { fylke: "Vestland" } });
      assertSameAnswer(stable(asDental({ data: { fylke: "Vestland" }, parts: [dataPart({ fylke: "Oslo" })] })), stable(vestland),
        "D4 message.data wins over a DataPart: filter Vestland");
      const bergenText = asDental({ parts: [textPart("tannlege i Bergen")] });
      assertSameAnswer(stable(asDental({ parts: [textPart("tannlege i Bergen"), dataPart({ fylke: "Oslo" })] })), stable(bergenText),
        "D5 text wins over a DataPart, as over message.data");
      const neither = asDental({ role: "user" });
      assertEq(neither.result?.metadata?.filter, {}, "D6 no text and no data: filter {} (as before)");
      for (const m of [{ parts: [] }, { parts: [dataPart("Oslo")] }, { parts: [dataPart(["Oslo"])] }, { parts: [{ kind: "text", type: "data", data: { fylke: "Oslo" } }] }]) {
        assertSameAnswer(stable(asDental(m)), stable(neither), `D6 ${JSON.stringify(m)} answers as a message with no data`);
      }

      const countData = await postA2a(routers.dental, { message: { data: { fylke: "Oslo" } } });
      const countPart = await postA2a(routers.dental, { message: { parts: [dataPart({ fylke: "Oslo" })] } });
      assertEq([countPart.countable, countData.countable], [true, true], "D7 a DataPart search counts as an AI lookup, like message.data");
      const emptyPart = await postA2a(routers.dental, { message: { parts: [dataPart({})] } });
      const emptyData = await postA2a(routers.dental, { message: { data: {} } });
      assertEq([emptyPart.countable, emptyData.countable], [false, false], "D7 an empty DataPart does not count, like data {}");

      const plain = asDental({ parts: [textPart(`Finn klinikk ${DENTAL_ORGNR}`)] });
      const spaced = asDental({ parts: [textPart("Finn klinikk 912 345 678")] });
      assertEq(spaced.result?.metadata, { skill: "tannlege_info", org_nr: DENTAL_ORGNR }, "D8 «912 345 678» asks for tannlege_info, org_nr 912345678");
      assertEq(spaced.result?.artifacts?.[0]?.parts?.[0]?.data?.id, fx.osloClinicId, "D8 …and finds Oslo Sentrum Tann");
      assertSameAnswer(stable(spaced), stable(plain), "D8 «912 345 678» and «912345678» give the same answer");
      assertSameAnswer(stable(asDental("912 345 678")), stable(asDental(DENTAL_ORGNR)), "D8 …also with no-break spaces");
      const unknown = asDental({ parts: [textPart("org.nr 987 654 321")] });
      assertEq(unknown.result?.artifacts?.[0]?.parts?.[0]?.text, "Ingen klinikk funnet med orgnr 987654321", "D8 an unknown spaced org.nr: not found, in nine digits");
      for (const t of ["ring 22334455", "ring 22 33 44 55", "mobil 912 34 567", "tannlege 0150 Oslo", "postnummer 0150", "912 345 6789", "1912 345 678", "Telefon 22 33 44 55, postnummer 0150"]) {
        assertEq(asDental({ parts: [textPart(t)] }).result?.metadata?.skill, "tannlege_search", `D9 «${t}» is no org.nr: a search, not tannlege_info`);
      }
      assertEq(asDental({ parts: [textPart(`${DENTAL_ORGNR} eller 923 456 789`)] }).result?.metadata?.org_nr, DENTAL_ORGNR,
        "D10 nine digits in a row are read first, as before");
      for (const t of ["123 912 345 678", "912 345 678 9", "1 912 345 678", "kr 1 234 567 890", "kr 1 234 567 890"]) {
        assertEq(asDental({ parts: [textPart(t)] }).result?.metadata?.skill, "tannlege_search",
          `D11 «${t}»: three groups inside a longer spaced number are no org.nr: a search, not tannlege_info`);
      }
      for (const t of ["912 345 678", "org.nr 912 345 678", "912 345 678.", "(912 345 678)", "912 345 678"]) {
        const r = asDental({ parts: [textPart(t)] });
        assertEq([r.result?.metadata, r.result?.artifacts?.[0]?.parts?.[0]?.data?.id], [{ skill: "tannlege_info", org_nr: DENTAL_ORGNR }, fx.osloClinicId],
          `D11 «${t}» still finds Oslo Sentrum Tann`);
      }
    }

    // ══ O  Opplevagent ═══════════════════════════════════════════════════
    {
      const viaData = asExperiences({ data: { kommune: "Tromsø" } });
      const viaPart = asExperiences({ parts: [dataPart({ kommune: "Tromsø" })] });
      assertEq(viaPart.result?.metadata?.filter, { kommune: "Tromsø" }, "O1 DataPart {kommune: Tromsø}: filter {kommune: Tromsø} (main: {})");
      assertEq(searchData(viaPart)?.count, 2, "O1 …the two Tromsø experiences (of 3)");
      assertSameAnswer(stable(viaPart), stable(viaData), "O1 …the whole answer is message.data's");
      assertSameAnswer(stable(asExperiences({ parts: [{ type: "data", data: { kommune: "Tromsø" } }] })), stable(viaData), "O2 type: data gives the same answer");
      assertSameAnswer(stable(asExperiences({ data: { kommune: "Bergen" }, parts: [dataPart({ kommune: "Tromsø" })] })), stable(asExperiences({ data: { kommune: "Bergen" } })),
        "O3 message.data wins over a DataPart");
      assertSameAnswer(stable(asExperiences({ parts: [textPart("nordlys i Tromsø"), dataPart({ kommune: "Bergen" })] })), stable(asExperiences({ parts: [textPart("nordlys i Tromsø")] })),
        "O4 text wins over a DataPart, as over message.data");

      const gText = asExperiences({ parts: [textPart("sidersmaking i Bergen")] });
      const gData = asExperiences({ text: "sidersmaking i Bergen", data: { lat: 60.39, lng: 5.32 } });
      const gPart = asExperiences({ parts: [textPart("sidersmaking i Bergen"), dataPart({ lat: 60.39, lng: 5.32 })] });
      assertEq(gPart.result?.metadata?.skill, "gardssalg_discover", "O5 text + DataPart origin: the gårdssalg search");
      assertEq(searchData(gPart)?.producers?.map((p: any) => p.distance_km), [0], "O5 …measured from the DataPart's origin (main: no distance)");
      assertEq(searchData(gText)?.producers?.map((p: any) => p.distance_km), [undefined], "O5 …text alone still has no distance");
      assertSameAnswer(stable(gPart), stable(gData), "O5 …the same answer as the origin in message.data");

      const neither = asExperiences({ role: "user" });
      assertEq(neither.result?.metadata?.filter, {}, "O6 no text and no data: filter {} (as before)");
      for (const m of [{ parts: [] }, { parts: [dataPart("Tromsø")] }]) {
        assertSameAnswer(stable(asExperiences(m)), stable(neither), `O6 ${JSON.stringify(m)} answers as a message with no data`);
      }

      const countData = await postA2a(routers.experiences, { message: { data: { kommune: "Tromsø" } } });
      const countPart = await postA2a(routers.experiences, { message: { parts: [dataPart({ kommune: "Tromsø" })] } });
      assertEq([countPart.countable, countData.countable], [true, true], "O7 a DataPart discover counts as an AI lookup, like message.data");
      const emptyPart = await postA2a(routers.experiences, { message: { parts: [dataPart({})] } });
      assertEq(emptyPart.countable, false, "O7 an empty DataPart does not count, like data {}");
    }

    // ══ R  RFB ═══════════════════════════════════════════════════════════
    {
      const view = (r: RouteResult) => {
        const d = r.body?.result?.artifacts?.[0]?.parts?.[0]?.data;
        return {
          count: d?.count,
          agents: (d?.agents ?? []).map((a: any) => a?.agent?.id),
          parsedQuery: d?.parsedQuery,
          note: d?.note,
          conversations: d?.conversations?.length,
          countable: r.countable,
        };
      };
      const viaData = view(await postA2a(routers.rfb, { message: { data: { categories: ["honey"] } } }));
      const viaPart = view(await postA2a(routers.rfb, { message: { parts: [dataPart({ categories: ["honey"] })] } }));
      assertEq(viaPart.parsedQuery, { categories: ["honey"] }, "R1 DataPart: Mode 2, the DataPart is the query (main: Mode 3, the whole params)");
      assertEq(viaPart.agents, ["i-x-honning-1", "i-x-honning-2"], "R1 …the two honey producers");
      assertEq(viaPart, viaData, "R1 …the same answer and count verdict as message.data");
      assertEq(view(await postA2a(routers.rfb, { message: { parts: [{ type: "data", data: { categories: ["honey"] } }] } })), viaData,
        "R2 type: data gives the same answer");
      assertEq(view(await postA2a(routers.rfb, { message: { data: { categories: ["dairy"] }, parts: [dataPart({ categories: ["honey"] })] } })),
        view(await postA2a(routers.rfb, { message: { data: { categories: ["dairy"] } } })), "R3 message.data wins over a DataPart");
      assertEq(view(await postA2a(routers.rfb, { message: { parts: [textPart("melk"), dataPart({ categories: ["honey"] })] } })),
        view(await postA2a(routers.rfb, { message: { parts: [textPart("melk")] } })), "R4 text wins over a DataPart");
      const mode3 = { message: { role: "user" }, categories: ["honey"] };
      assertEq(view(await postA2a(routers.rfb, mode3)).parsedQuery, mode3, "R5 no text and no data: Mode 3, the whole params (as before)");
      const notObject = { message: { parts: [dataPart("honey")] }, categories: ["honey"] };
      assertEq(view(await postA2a(routers.rfb, notObject)).parsedQuery, notObject, "R5 …also with a DataPart whose data is no object");
      const emptyPart = view(await postA2a(routers.rfb, { message: { parts: [dataPart({})] } }));
      assertEq([emptyPart.count, emptyPart.countable], [0, false], "R6 an empty DataPart asks for nothing: no results, not counted (like data {})");
      assertEq(emptyPart.note, view(await postA2a(routers.rfb, { message: { data: {} } })).note, "R6 …with data {}'s note");
    }
  } catch (err: any) {
    failed++;
    failures.push("a2a-datapart-alle-plattformer: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    fx?.restore();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runA2aDatapartAllePlattformerTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
