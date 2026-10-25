/**
 * opplevagent-mcp-query-intent.test.ts — dev-request
 * 2026-10-16-opplevagent-mcp-fritekst-query, S2 + S3.
 *
 * Bug (live 2026-10-16): discover_experiences with only
 * {query:"hvalsafari i Tromsø"} answered filter_applied:{} and the first rows
 * of the whole country in title order — none in Tromsø, none about whales.
 *
 * Covers:
 *   (u) interpretDiscoverQuery() on its own: place / region / fylke, the
 *       ambiguous place words, season / weather / category words, stopwords,
 *       search words, explicit arguments winning.
 *   (s) experience-store: text_terms (AND, synonyms, title_no, subcategory,
 *       title hits first, LIKE escaping), RELAX_ORDER, protectKeys,
 *       widenKommuneToFylke, publishedKommuneSet().
 *   (m) the MCP tool over a real session: acceptance criteria 1-7 of S2 and
 *       the S3 criteria, explicit arguments winning, logging without the raw
 *       query, calls without `query` unchanged.
 *
 * Exports the fixture and the MCP session helper for
 * opplevagent-submission-replay.test.ts.
 *
 * Standalone: npx tsx src/routes/opplevagent-mcp-query-intent.test.ts
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type ExpStore = typeof import("../services/experience-store");

/**
 * A small catalogue shaped like the live one for the submission's test
 * cases: Tromsø winter rows incl. Arctic Explorer, whale rows (title,
 * title_no and description-only hits), summer-only rows in Troms, wildlife in
 * several counties, the Lofoten region (in its kommuner Vågan and
 * Vestvågøy), Geiranger filed under Stranda, a published kommune named Time,
 * a Rauma row whose title has "Romsdal" in it, kommuner the gazetteer lacks
 * (Lyngen, Sirdal, Rauma, Vågan, Vestvågøy) — four of them named like
 * everyday words (Gran, Strand, Øyer, Fjord) — and an unpublished row in
 * Finnsnes. No row in Finnmark, Storslett or Alta. Every row has a price,
 * so a max_price filter can find nothing.
 */
export function seedOpplevagentQueryFixture(expStore: ExpStore, db: { prepare(sql: string): { run(...a: unknown[]): unknown } }): Record<string, string> {
  const providerId = expStore.createProvider({
    navn: "Fixture Opplevelser AS", fylke: "Troms", kommune: "Tromsø",
    brreg_verified: 1, brreg_active: 1, verification_status: "verified",
  });
  const ids: Record<string, string> = {};
  const add = (key: string, row: Record<string, unknown>, titleNo?: string) => {
    ids[key] = expStore.createExperience({
      provider_id: providerId, provider_match_status: "matched",
      verification_status: "verified", confidence: "high",
      ...row,
    } as any);
    if (titleNo) db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run(titleNo, ids[key]);
  };
  const troms = { kommune: "Tromsø", fylke: "Troms" };
  add("arctic", { ...troms, title: "Arctic Explorer — Northern Lights Cruise from Tromsø", category: "sightseeing_transport", season: ["autumn", "winter", "spring"], price_from: 990, price_unit: "per_adult", description: "A four-hour evening cruise under the aurora." });
  add("aurora", { ...troms, title: "Aurora Safari Camp — Fjord Tours Tromsø", category: "natur_friluft", season: ["vinter"], price_from: 1500 });
  add("dogTromso", { ...troms, title: "Dog sledding in Tromsø", category: "vinter_sno", season: ["winter"], price_from: 1800 });
  add("whaleSafari", { ...troms, title: "Winter Whale Safari from Tromsø", category: "dyreliv_safari", season: ["winter"], price_from: 1600 }, "Vinterhvalsafari fra Tromsø");
  add("whaleWatching", { ...troms, title: "Silent Whale Watching — Brim Explorer Tromsø", category: "sightseeing_transport", season: ["winter"], price_from: 1700 });
  add("museum", { ...troms, title: "Polar Museum Tromsø", category: "kultur_historie", season: ["all_year"], price_from: 120, description: "Exhibits on Arctic hunting, including a whale skeleton." });
  add("kayakTromso", { ...troms, title: "Midnight Sun Kayak Tromsø", category: "natur_friluft", season: ["summer"], price_from: 900 });
  add("kayakSenja", { kommune: "Senja", fylke: "Troms", title: "Sea kayaking on Senja", category: "natur_friluft", season: ["summer"], price_from: 1100 });
  add("dogSenja", { kommune: "Senja", fylke: "Troms", title: "Dog sledding on Senja", category: "vinter_sno", season: ["winter"], price_from: 1900 });
  add("dogLyngen", { kommune: "Lyngen", fylke: "Troms", title: "Dog sledding in Lyngen", category: "vinter_sno", season: ["winter"], price_from: 2000 });
  add("andenes", { kommune: "Andøy", fylke: "Nordland", title: "Andenes Whale Safari", category: "dyreliv_safari", season: ["all_year"], price_from: 1300 });
  add("lofotenWalk", { kommune: "Vågan", fylke: "Nordland", title: "Lofoten Fishing Village Walk", category: "kultur_historie", season: ["all_year"], price_from: 300 });
  add("eagle", { kommune: "Vestvågøy", fylke: "Nordland", title: "Ørnesafari i Lofoten", category: "dyreliv_safari", season: ["summer"], price_from: 850 });
  add("orca", { kommune: "Nærøysund", fylke: "Trøndelag", title: "Orca safari with Northern Explorers", category: "dyreliv_safari", season: ["winter"], price_from: 1400 });
  add("aquarium", { kommune: "Ålesund", fylke: "Møre og Romsdal", title: "Atlanterhavsparken aquarium", category: "dyreliv_safari", season: ["all_year"], price_from: 300 });
  add("romsdalseggen", { kommune: "Rauma", fylke: "Møre og Romsdal", title: "Romsdalseggen ridge hike", category: "natur_friluft", season: ["summer"], price_from: 450 });
  add("geiranger", { kommune: "Stranda", fylke: "Møre og Romsdal", title: "Geirangerfjord Cruise", category: "sightseeing_transport", season: ["summer"], price_from: 600, description: "Sightseeing cruise from Geiranger." }, "Fjordcruise på Geirangerfjorden");
  add("sirdal", { kommune: "Sirdal", fylke: "Agder", title: "Dog sledding in Sirdal", category: "dyreliv_safari", season: ["winter"], price_from: 1500 });
  add("floibanen", { kommune: "Bergen", fylke: "Vestland", title: "Fløibanen funicular", category: "sightseeing_transport", season: ["all_year"], price_from: 150 });
  add("fishMarket", { kommune: "Bergen", fylke: "Vestland", title: "Bergen Fish Market food walk", category: "mat_drikke", subcategory: "matvandring", season: ["all_year"], price_from: 450 });
  add("viking", { kommune: "Oslo", fylke: "Oslo", title: "Viking Ship Museum", category: "kultur_historie", season: ["all_year"], price_from: 160 });
  add("jaermuseet", { kommune: "Time", fylke: "Rogaland", title: "Jærmuseet", category: "kultur_historie", season: ["all_year"], price_from: 200 });
  // Catalogue kommuner whose names are also words: "Gran" (Canaria), "strand", "øyer" (islands), "fjord".
  add("glassverk", { kommune: "Gran", fylke: "Innlandet", title: "Glassblowing at Hadeland Glassverk", category: "kultur_historie", season: ["all_year"], price_from: 250 });
  add("preikestolen", { kommune: "Strand", fylke: "Rogaland", title: "Preikestolen guided hike", category: "natur_friluft", season: ["summer"], price_from: 950 });
  add("hafjell", { kommune: "Øyer", fylke: "Innlandet", title: "Hafjell Alpinsenter day pass", category: "vinter_sno", season: ["winter"], price_from: 600 });
  add("valldal", { kommune: "Fjord", fylke: "Møre og Romsdal", title: "Valldal strawberry farm tour", category: "mat_drikke", season: ["summer"], price_from: 350 });
  add("unpublished", { kommune: "Finnsnes", fylke: "Troms", title: "Hidden spa", category: "velvaere_spa", season: ["all_year"], price_from: 700, verification_status: "needs_review" });
  return ids;
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

// Plain node:http POST — not globalThis.fetch, which other suites stub.
function httpPost(url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A real MCP session on the experiences router; `discover(args)` returns the tool's structuredContent. */
export async function openOpplevagentMcpSession(mcpModule: typeof import("./experiences-mcp")): Promise<{
  discover: (args: Record<string, unknown>) => Promise<any>;
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpModule.default as any)(req, res, next));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const baseHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initRes = await httpPost(url, JSON.stringify({
    jsonrpc: "2.0", method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "query-intent-test", version: "1.0.0" } },
    id: "init",
  }), baseHeaders);
  const sessionId = initRes.headers["mcp-session-id"] as string | undefined;
  let rpcId = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await httpPost(
      url,
      JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: String(++rpcId) }),
      { ...baseHeaders, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    );
    return parseJsonRpcBody(res.text, (res.headers["content-type"] as string | undefined) ?? null).result;
  };
  return {
    call,
    discover: async (args) => {
      const r = await call("discover_experiences", args);
      const text = JSON.parse(r?.content?.[0]?.text ?? "{}");
      if (JSON.stringify(text) !== JSON.stringify(r?.structuredContent)) throw new Error("structuredContent differs from the text block");
      return r?.structuredContent;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function runOpplevagentMcpQueryIntentTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/experiences-query-intent"),
      require.resolve("./experiences-mcp"),
    ]);
    const conversation = (require("../services/conversation-service") as typeof import("../services/conversation-service")).conversationService;
    const realStartConversation = conversation.startConversation;
    let session: Awaited<ReturnType<typeof openOpplevagentMcpSession>> | undefined;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as ExpStore;
      const qi = require("../services/experiences-query-intent") as typeof import("../services/experiences-query-intent");
      const { interpretDiscoverQuery } = qi;
      const { REGION_TO_KOMMUNER, __FYLKE_INTERNAL, normaliseFylke } = require("../services/norway-fylke") as typeof import("../services/norway-fylke");

      // ── (u) interpretDiscoverQuery, with a fixed published-kommune list ──
      const published = new Set(["Tromsø", "Bergen", "Oslo", "Stranda", "Time", "Svolvær", "Leknes"]);
      const read = (q: string, explicit: Record<string, unknown> = {}) => interpretDiscoverQuery(q, explicit, { publishedKommuner: published });

      assertEq(read("hvalsafari i Tromsø"), { hasContent: true, kommune: "Tromsø", terms: ["hvalsafari"] }, "u1: «hvalsafari i Tromsø» → kommune Tromsø + search word hvalsafari");
      assertEq(read("whale safari in Tromso").kommune, "Tromsø", "u2: æ/ø/å are folded for place names: «Tromso» is Tromsø");
      assertEq(read("Tromsøs beste aktiviteter").kommune, "Tromsø", "u3: a genitive -s still names the place");
      assertEq(read("Lofoten").kommuner, [...REGION_TO_KOMMUNER.Lofoten], "u4: a curated region expands to its kommune list");
      assertEq(read("Hva kan vi finne på i Troms om vinteren?"), { hasContent: true, fylke: "Troms", season: "winter" }, "u5: fylke + season, no search words, never the category vinter_sno");
      assertEq(read("Tromsø i Troms").kommune, "Tromsø", "u6: kommune wins over fylke");
      assertEq(read("Tromsø i Troms").fylke, undefined, "u6b: … and the fylke word is used up, not a second filter");
      assertEq(read("Svolvær i Lofoten").kommune, "Svolvær", "u7: kommune wins over region");
      assertEq(read("Leknes i Lofoten"), { hasContent: true, kommune: "Leknes" }, "u7b: … also when the region name is the longer one");
      assertEq(read("Geiranger fjordcruise"), { hasContent: true, fylke: "Møre og Romsdal", terms: ["geiranger", "fjordcruise"] },
        "u8: a gazetteer kommune with nothing published (Geiranger) becomes its fylke, and its name a search word");
      assertEq(interpretDiscoverQuery("Geiranger fjordcruise", {}, { publishedKommuner: null }).kommune, "Geiranger", "u8b: without the published list the gazetteer name is used as is");
      assertEq(read("kajakk i Vesterålen"), { hasContent: true, fylke: "Nordland", terms: ["kajakk", "vesterålen"] }, "u9: a district (no kommune, no region) is searched in its fylke with its name as a search word");
      // A name inside a longer matched name is part of it (fix round 1, B1).
      assertEq(read("Hva kan vi finne på i Møre og Romsdal?"), { hasContent: true, fylke: "Møre og Romsdal" },
        "u10: «Møre og Romsdal» is the fylke, not the district Romsdal plus the search word «romsdal»");
      assertEq(read("Romsdal"), { hasContent: true, fylke: "Møre og Romsdal", terms: ["romsdal"] }, "u10b: the district alone is still searched in its fylke");
      assertEq(read("Hva kan vi finne på i Troms og Finnmark?"), { hasContent: true, fylke: "Troms og Finnmark" },
        "u10c: the former county Troms og Finnmark is one fylke (both parts), not Finnmark");
      assertEq([read("Vestfold og Telemark").fylke, read("opplevelser i Viken").fylke, read("Hordaland").fylke, read("Sør-Trøndelag").fylke],
        ["Vestfold og Telemark", "Viken", "Vestland", "Trøndelag"], "u10d: former county names become the fylke normaliseFylke gives them");
      assertTrue(qi.FORMER_FYLKE_NAMES.every((name) => normaliseFylke(name) !== null), "u10e: every FORMER_FYLKE_NAMES entry is known to normaliseFylke");
      assertEq(qi.parseExperiencesIntent("Hva kan vi finne på i Troms og Finnmark?"), { fylke: "Troms" }, "u10f: parseExperiencesIntent (A2A) is unchanged");
      assertEq(read("vi skal bo i Telemark"), { hasContent: true, fylke: "Telemark" }, "u10g: «bo i Telemark» is Telemark, not the kommune Bø i Telemark (own spelling, F2)");
      assertEq(interpretDiscoverQuery("hva skjer i Bø i Telemark", {}, { publishedKommuner: null }).kommune, "Bø i Telemark", "u10h: … while «Bø i Telemark» is the kommune");
      // Equal level: the name after a place preposition, else the first named (F3).
      assertEq(interpretDiscoverQuery("Hva kan vi gjøre i Hol eller Gol?", {}, { publishedKommuner: null }).kommune, "Hol", "u10i: the first of two kommuner, not gazetteer order");
      assertEq(read("flying from Bergen, what to do in Oslo").kommune, "Oslo", "u10j: the kommune after a place preposition wins");
      assertEq(read("Oslo og Bergen").kommune, "Oslo", "u10k: no preposition: the first one named, not the longest");

      // Ambiguous place words and false positives (AC6).
      assertEq(read("ski touring"), { hasContent: true, terms: ["ski", "touring"] }, "u11: «ski touring» sets no kommune");
      assertEq(read("a good time in Bergen").kommune, "Bergen", "u12: «a good time in Bergen» → Bergen, not Time");
      assertEq(read("arrive in time for northern lights").kommune, undefined, "u13: «in time» is not the kommune Time");
      assertEq(read("Time to see the northern lights").kommune, undefined, "u14: a capital at the start of a sentence does not make Time a place");
      assertEq(read("things to do in Time").kommune, "Time", "u15: capitalised mid-sentence, Time is the kommune");
      assertEq(read("slappe av i sola i Bergen"), { hasContent: true, kommune: "Bergen", weather: "clear", terms: ["slappe"] },
        "u16: «i sola» (in the sun) is not Sola, it is sunny weather and no search word (F7)");
      assertEq(read("hva skjer i Sola").weather, undefined, "u16b: capitalised «i Sola» is the kommune, not weather");
      assertEq(read("se hvaler i Tromsø").kommune, "Tromsø", "u17: «hvaler» (whales) is not the kommune Hvaler");
      assertEq(read("opplevelser på Hvaler").kommune === undefined && read("opplevelser på Hvaler").fylke, "Østfold", "u17b: capitalised Hvaler is the place (searched in Østfold, as it has nothing published)");
      assertEq(read("i moss").fylke, "Østfold", "u18: a preposition before «moss» marks the place (Moss → Østfold, nothing published)");
      assertEq(read("moss walks").fylke, undefined, "u19: lower-case «moss» without a preposition is no place");
      assertEq(read("such as these").fylke, undefined, "u20: «as» is never Ås (own spelling only)");
      assertTrue(Object.keys(qi.AMBIGUOUS_PLACE_WORDS).every((name) => name in __FYLKE_INTERNAL.CITY_TO_FYLKE_RAW),
        "u21: every AMBIGUOUS_PLACE_WORDS entry is a gazetteer name");

      // Season and weather words: whole words only.
      assertEq(read("våre beste opplevelser i Oslo").season, undefined, "u22: «våre» is not the season vår");
      assertEq(read("hva skjer i Oslo i vår").season, "spring", "u23: «i vår» at the end of the sentence is this spring");
      assertEq(read("i vår familie").season, undefined, "u24: «i vår familie» (our family) is no season");
      assertEq(read("waterfall hike").season, undefined, "u25: «waterfall» is not autumn");
      assertEq(read("regnbue over Bergen").weather, undefined, "u26: «regnbue» is not rain");
      assertEq(read("regnværsdag i Bergen").weather, "rain", "u27: «regnværsdag» is rain");
      assertEq(read("winter activities").category, undefined, "u28: «winter» sets the season, never the category vinter_sno");

      // Category words.
      assertEq(read("Find wildlife and animal experiences in Norway"), { hasContent: true, category: "dyreliv_safari" },
        "u29: wildlife → dyreliv_safari; «animal» used up; «Norway» = the whole country");
      assertEq(read("Find wildlife and animal experiences in Norway", { category: "dyreliv_safari" }), { hasContent: true },
        "u30: with an explicit category the alias words are used up and nothing else is read");
      assertEq(read("during our stay in Bergen"), { hasContent: true, kommune: "Bergen" }, "u31: a generic alias («stay») does not set the category and is no search word");
      assertEq(read("adventure"), { hasContent: false }, "u31b: generic alias words alone are no content, so the call browses (F1)");
      assertEq(read("gårdssalg i Bergen").category, qi.GARDSSALG_CATEGORY, "u32: the gårdssalg alias is reported, for the discover_gardssalg pointer (F1)");
      assertEq(read("outdoor activities in Oslo for 4 people"), { hasContent: true, kommune: "Oslo", indoor_outdoor: "outdoor" },
        "u32b: «outdoor» sets indoor_outdoor, not a category (F1, the tool description's own example)");
      assertEq(read("innendørs i Bergen").indoor_outdoor, "indoor", "u32c: «innendørs» is indoor");
      assertEq(read("indoor fun in Bergen", { indoor_outdoor: "outdoor" }).indoor_outdoor, undefined, "u32d: an explicit indoor_outdoor wins");

      // Explicit arguments win.
      assertEq(read("hvalsafari i Bergen", { kommune: "Tromsø" }), { hasContent: true },
        "u33: with an explicit place nothing is read as place, and no search words");
      assertEq(read("wildlife in Tromsø", { category: "kultur_historie" }), { hasContent: true, kommune: "Tromsø" },
        "u34: an explicit category wins; the place is still read");
      assertEq(read("Tromsø om sommeren", { season: "winter" }).season, undefined, "u35: an explicit season wins");
      assertEq(read("wildlife experiences across Norway", { category: "dyreliv_safari" }), { hasContent: true },
        "u35b: with an explicit category the leftover words are no search words (F4)");
      assertEq(read("hvalsafari i Tromsø", { category: "dyreliv_safari" }), { hasContent: true, kommune: "Tromsø" },
        "u35c: … the place still fills the empty key");
      assertEq(read("Hva kan vi finne på i Troms om vinteren?", { fylke: "Troms", season: "winter" }), { hasContent: true },
        "u36: query + the same structured arguments reads nothing extra");
      assertEq(read("what can we do in Norway"), { hasContent: false }, "u37: a general question has no content words");
      assertEq(read("tour for 4 people").terms, undefined, "u38: numbers and stopwords are no search words");
      assertEq(read("alpha beta gamma delta epsilon zeta eta theta").terms?.length, qi.MAX_TEXT_TERMS, "u39: at most MAX_TEXT_TERMS search words");
      assertEq([qi.MAX_TEXT_TERMS, qi.MAX_TEXT_TERM_LENGTH], [expStore.MAX_TEXT_TERMS, expStore.MAX_TEXT_TERM_LENGTH], "u39b: the limits are DiscoverFilterSchema's own");
      assertEq(read("x".repeat(qi.MAX_TEXT_TERM_LENGTH + 1) + " whale").terms, ["whale"], "u39c: an over-long token is no search word (F10)");
      assertEq(read("constructor"), { hasContent: true, terms: ["constructor"] }, "u39d: a word named like an Object.prototype key is an ordinary word");

      // Kommuner only the catalogue has (F8): own spelling, after a place preposition or as the whole query.
      const withCatalogue = new Set([...published, "Lyngen", "Sirdal", "Vågan", "Fjord", "Senja", "Tromsø kommune", "Tromsø sentrum", "Indre Østfold"]);
      const readC = (q: string) => interpretDiscoverQuery(q, {}, { publishedKommuner: withCatalogue });
      assertEq(readC("dog sledding in Lyngen"), { hasContent: true, kommune: "Lyngen", terms: ["dog", "sledding"] }, "u40: «in Lyngen» is the kommune Lyngen, not a search word");
      assertEq([readC("Lyngen").kommune, readC("hundekjøring nær Sirdal").kommune, readC("i Vågan").kommune, readC("hundekjøring Sirdal").kommune],
        ["Lyngen", "Sirdal", "Vågan", undefined], "u41: the whole query, or right after a place preposition");
      assertEq(readC("Lyngen Alps skiing"), { hasContent: true, terms: ["lyngen", "alps", "skiing"] }, "u42: without a preposition the name is searched as a word");
      assertEq([readC("fjord cruise").kommune, readC("Fjord Tours i Tromsø").kommune], [undefined, "Tromsø"], "u43: a catalogue name that is an everyday word needs a preposition");
      assertEq(readC("i Vagan").kommune, undefined, "u44: catalogue-only names are not folded");
      assertEq(readC("i Senja").kommuner, [...REGION_TO_KOMMUNER.Senja], "u45: a name the gazetteer already reads keeps its gazetteer meaning (region Senja)");
      assertEq([readC("ting å gjøre i Tromsø kommune").kommune, readC("ting å gjøre i Tromsø sentrum").kommune], ["Tromsø", "Tromsø"],
        "u46: a stray catalogue value with a gazetteer kommune in it does not shadow that kommune");
      assertEq(readC("i Indre Østfold").kommune, "Indre Østfold", "u47: a catalogue kommune with a fylke name in it is that kommune");

      // Fix round 2, B1: catalogue kommuner named like everyday words rank after
      // every gazetteer place, need a capital after the preposition, and are no
      // part of a longer capitalised name.
      const everyday = new Set([...withCatalogue, "Gran", "Strand", "Øyer", "Vik", "Nes", "Sel", "Berg"]);
      const readE = (q: string) => interpretDiscoverQuery(q, {}, { publishedKommuner: everyday });
      assertEq([readE("things to do in Gran Canaria"), readE("hva kan vi gjøre på Gran Canaria")],
        [{ hasContent: true, terms: ["gran", "canaria"] }, { hasContent: true, terms: ["gran", "canaria"] }],
        "u48: «Gran Canaria» is not the kommune Gran: a capitalised word follows it");
      assertEq(readE("bading på strand i Bergen"), { hasContent: true, kommune: "Bergen", terms: ["bading", "strand"] },
        "u49: «på strand i Bergen» is Bergen, not the kommune Strand");
      assertEq(readE("hva kan vi gjøre på øyer i Lofoten"), { hasContent: true, kommuner: [...REGION_TO_KOMMUNER.Lofoten], terms: ["øyer"] },
        "u50: «på øyer i Lofoten» is the region Lofoten, not the kommune Øyer");
      assertEq(readE("kayaking in fjord landscapes near Bergen"), { hasContent: true, kommune: "Bergen", terms: ["kayaking", "fjord", "landscapes"] },
        "u51: «in fjord landscapes near Bergen» is Bergen, not the kommune Fjord");
      assertEq([readE("bading på Strand i Bergen"), readE("hva kan vi gjøre på Øyer i Lofoten").kommuner, readE("kayaking in Fjord near Bergen").kommune, readE("på Sel i Innlandet").fylke],
        [{ hasContent: true, kommune: "Bergen", terms: ["bading", "strand"] }, [...REGION_TO_KOMMUNER.Lofoten], "Bergen", "Innlandet"],
        "u52: capitalised too, a catalogue-only kommune loses to a gazetteer kommune, region or fylke, and its word stays a search word");
      assertEq([readE("alpint i Øyer"), readE("øyer").kommune, readE("dog sledding in lyngen").kommune, readE("dog sledding in Lyngen Alps").kommune],
        [{ hasContent: true, kommune: "Øyer", terms: ["alpint"] }, "Øyer", undefined, undefined],
        "u53: a catalogue-only kommune is read capitalised after a preposition, or as the whole query; not in lower case, not before another name");

      // Fix round 2, F12: landsdeler are places.
      const north = ["Nordland", "Troms", "Finnmark"];
      assertEq(read("Nord-Norge vinter"), { hasContent: true, fylker: north, season: "winter" }, "u54: «Nord-Norge» is its fylker, not the search word «nord»");
      assertEq([read("Northern Norway in winter").fylker, read("Nordnorge").fylker, read("hva skjer på Vestlandet?").fylker, read("Sørlandets strender").fylker],
        [north, north, ["Rogaland", "Vestland", "Møre og Romsdal"], ["Agder"]], "u55: English, one-word, definite and genitive landsdel names");
      assertEq([read("Tromsø i Nord-Norge"), read("Troms, Nord-Norge").fylke], [{ hasContent: true, kommune: "Tromsø" }, "Troms"],
        "u56: a kommune or fylke wins over its landsdel");
      assertEq(read("northern lights in Norway"), { hasContent: true, terms: ["northern", "lights"] }, "u57: «northern … Norway» apart is no landsdel");
      assertTrue(Object.values(qi.LANDSDEL_TO_FYLKER).every((fylker) => fylker.every((f) => normaliseFylke(f) === f)) &&
        Object.values(qi.LANDSDEL_ALIASES).every((l) => l in qi.LANDSDEL_TO_FYLKER), "u58: every landsdel fylke is a current fylke name; every alias names a landsdel");

      // Fix round 2, F15: what is left of a contraction is no search word.
      assertEq([read("I don't want a guide in Bergen").terms, read("we'll see whales, won't we? in Tromsø").terms], [["guide"], ["whales"]],
        "u59: «don», «won», «ll» and «t» are no search words");

      // ── Fixture DB ────────────────────────────────────────────────────
      const db = dbFactory.getDb("experiences");
      const ids = seedOpplevagentQueryFixture(expStore, db as any);

      // ── (s) experience-store ──────────────────────────────────────────
      const titles = (f: Record<string, unknown>) => expStore.discoverExperiences(f as any, 50).map((e) => e.title);
      assertEq(titles({ text_terms: ["whale"] }), ["Andenes Whale Safari", "Silent Whale Watching — Brim Explorer Tromsø", "Winter Whale Safari from Tromsø", "Polar Museum Tromsø"],
        "s1: text_terms match title or description; title hits rank before the description-only hit");
      assertEq(titles({ text_terms: ["hval"] }).includes("Andenes Whale Safari"), true, "s2: SEARCH_SYNONYMS expand a Norwegian word (hval → whale)");
      assertEq(titles({ text_terms: ["fjordcruise"] }), ["Geirangerfjord Cruise"], "s3: title_no is searched");
      assertEq(titles({ text_terms: ["matvandring"] }), ["Bergen Fish Market food walk"], "s4: subcategory is searched");
      assertEq(titles({ text_terms: ["whale", "andenes"] }), ["Andenes Whale Safari"], "s5: every term must match (AND)");
      assertEq(titles({ text_terms: ["ørnesafari"] }), ["Ørnesafari i Lofoten"], "s6: a lower-case ø matches a stored capital Ø");
      assertEq(titles({ text_terms: ["%"] }), [], "s7: a LIKE wildcard in a term matches literally, not everything");
      assertEq(expStore.countDiscoverExperiences({ text_terms: ["whale"] }), 4, "s8: countDiscoverExperiences applies text_terms too");
      assertEq(expStore.expandSearchTerm("hvalsafari"), ["hvalsafari", "whale"], "s9: expandSearchTerm is exported");

      const r1 = expStore.discoverExperiencesRelaxed({ kommune: "Tromsø", category: "dyreliv_safari", text_terms: ["zzz"] }, 20);
      assertEq(r1.relaxedKeys, ["text_terms"], "s10: text_terms is relaxed first, the category stays");
      const r2 = expStore.discoverExperiencesRelaxed({ fylke: "Finnmark" }, 20);
      assertTrue(r2.results.length > 0 && r2.relaxedKeys.join() === "fylke", "s11: without options a place without rows is still relaxed away (REST/A2A unchanged)");
      const r3 = expStore.discoverExperiencesRelaxed({ fylke: "Finnmark", category: "dyreliv_safari" }, 20, { protectKeys: ["fylke"] });
      assertEq([r3.results.length, r3.relaxedKeys], [0, ["category"]], "s12: a protected key is never dropped");
      const r4 = expStore.discoverExperiencesRelaxed({ kommune: "Storslett", category: "mat_drikke" }, 20, { protectKeys: ["kommune"], widenKommuneToFylke: true });
      assertTrue(r4.results.length > 0 && r4.results.every((e) => e.fylke === "Troms") && r4.appliedFilter.fylke === "Troms" && !r4.appliedFilter.kommune,
        "s13: an empty kommune is widened once to its fylke (Storslett → Troms)");
      assertEq(r4.relaxedKeys, [expStore.KOMMUNE_TO_FYLKE_STEP, "category"], "s14: … reported as kommune→fylke, then the other relaxed keys");
      const r5 = expStore.discoverExperiencesRelaxed({ kommune: "Ukjentby" }, 20, { protectKeys: ["kommune"], widenKommuneToFylke: true });
      assertEq([r5.results.length, r5.relaxedKeys], [0, []], "s15: a kommune without a known fylke stays an honest zero");
      assertEq(expStore.formatFilterLabels(["text_terms", expStore.KOMMUNE_TO_FYLKE_STEP]), "fritekst, kommune→fylke", "s16: labels for text_terms and the widening");
      assertTrue(expStore.buildNarrowingSuggestions(r1.results, r1.relaxedKeys).some((s) => s.includes("category=dyreliv_safari")),
        "s17: dropped search words suggest the categories the results have");
      const r6 = expStore.discoverExperiencesRelaxed({ text_terms: ["northern", "lights", "cruise", "charge", "credit", "card"] }, 20);
      assertEq([r6.results.map((e) => e.title), r6.relaxedKeys, r6.textTermsMatched, r6.appliedFilter.text_terms?.length],
        [["Arctic Explorer — Northern Lights Cruise from Tromsø"], ["text_terms"], 3, 6],
        "s19: no row has all six terms: the rows with the most of them (3), the terms kept in the applied filter");
      const r7 = expStore.discoverExperiencesRelaxed({ kommune: "Tromsø", text_terms: ["kayak", "whale"] }, 20);
      assertEq([r7.textTermsMatched, r7.results.map((e) => e.title)],
        [1, ["Midnight Sun Kayak Tromsø", "Silent Whale Watching — Brim Explorer Tromsø", "Winter Whale Safari from Tromsø", "Polar Museum Tromsø"]],
        "s20: terms no row has together: rows with either, title hits first, the other filters kept");
      const r8 = expStore.discoverExperiencesRelaxed({ kommune: "Tromsø", text_terms: ["zzz", "qqq"] }, 20);
      assertEq([r8.relaxedKeys, r8.textTermsMatched, r8.appliedFilter.text_terms, r8.results.length], [["text_terms"], undefined, undefined, 7],
        "s21: terms none of which match are dropped after the one-at-a-time steps");
      const r9 = expStore.discoverExperiencesRelaxed({ text_terms: ["whale", "safari", "zzz"] }, 20);
      assertEq([r9.textTermsMatched, r9.results.map((e) => e.title)], [2, ["Andenes Whale Safari", "Winter Whale Safari from Tromsø"]],
        "s22: one step at a time: all but one term before all but two");
      assertEq([expStore.DiscoverFilterSchema.safeParse({ text_terms: Array(expStore.MAX_TEXT_TERMS + 1).fill("ab") }).success,
        expStore.DiscoverFilterSchema.safeParse({ text_terms: ["x".repeat(expStore.MAX_TEXT_TERM_LENGTH + 1)] }).success,
        expStore.DiscoverFilterSchema.safeParse({ text_terms: [""] }).success],
        [false, false, false], "s23: DiscoverFilterSchema bounds text_terms (count, length, empty) (F10)");
      assertEq([expStore.expandSearchTerm("constructor"), titles({ text_terms: ["constructor"] })], [["constructor"], []],
        "s24: a term named like an Object.prototype key is searched literally (no crash)");

      // Fix round 2, F11: plural and definite forms also find the base form — in discover only.
      assertEq([expStore.textTermVariants("fjords"), expStore.textTermVariants("whales"), expStore.textTermVariants("hvalsafarier"),
        expStore.textTermVariants("nordlyset"), expStore.textTermVariants("fjordene"), expStore.textTermVariants("market")],
        [["fjords", "fjord"], ["whales", "whale"], ["hvalsafarier", "hvalsafari", "whale"],
          ["nordlyset", "aurora", "northern lights", "nordlys"], ["fjordene", "fjord"], ["market"]],
        "s25: textTermVariants strips the longest ending that leaves five letters, and expands both forms");
      assertEq([expStore.expandSearchTerm("fjords"), expStore.expandSearchTerm("nordlyset")], [["fjords"], ["nordlyset", "aurora", "northern lights"]],
        "s26: web /sok's expandSearchTerm has no stem; «nordlyset» is a SEARCH_SYNONYMS entry");
      assertEq(titles({ text_terms: ["fjords"] }), ["Aurora Safari Camp — Fjord Tours Tromsø", "Geirangerfjord Cruise"], "s27: «fjords» finds the rows that say fjord");
      assertEq(titles({ text_terms: ["hvalsafarier"] }), titles({ text_terms: ["hvalsafari"] }), "s28: «hvalsafarier» finds what «hvalsafari» finds");

      // Fix round 2, F12: fylker (a landsdel) is any of its fylker, and a place key like the others.
      assertEq(titles({ fylker: ["Nordland", "Finnmark"] }).sort(), titles({ fylke: "Nordland" }).sort(), "s29: fylker matches any of its fylker (Finnmark has none)");
      assertEq(titles({ fylker: ["Nordland", "Troms"] }).length, titles({ fylke: "Nordland" }).length + titles({ fylke: "Troms" }).length, "s30: … each with its own rows");
      assertEq(expStore.countDiscoverExperiences({ fylker: ["Nordland", "Troms"] }), titles({ fylker: ["Nordland", "Troms"] }).length, "s31: countDiscoverExperiences applies fylker too");
      assertEq([expStore.buildFylkeInClause(["Troms", "Finnmark"], "e.fylke", "fylker"), expStore.buildFylkeInClause("Troms", "e.fylke")],
        [{ sql: "e.fylke IN (@fylker0, @fylker1, @fylker2)", params: { fylker0: "Troms", fylker1: "Troms og Finnmark", fylker2: "Finnmark" } },
          { sql: "e.fylke IN (@fylke0, @fylke1)", params: { fylke0: "Troms", fylke1: "Troms og Finnmark" } }],
        "s32: buildFylkeInClause takes a list (each fylke's equivalents, once each); one fylke is unchanged");
      const r10 = expStore.discoverExperiencesRelaxed({ fylker: ["Finnmark"] }, 20, { protectKeys: ["fylker"] });
      const r11 = expStore.discoverExperiencesRelaxed({ fylker: ["Finnmark"] }, 20);
      assertEq([r10.results.length, r10.relaxedKeys, r11.relaxedKeys, expStore.formatFilterLabels(["fylker"])], [0, [], ["fylker"], "fylker"],
        "s33: a protected fylker is never dropped; unprotected it is relaxed last, labelled «fylker»");

      // Fix round 2, F14: the text_terms step is one query, not one per number of terms.
      let scans = 0;
      const realPrepare = (db as any).prepare;
      (db as any).prepare = function (this: unknown, sql: string) {
        if (/FROM experiences e[\s\S]*LIMIT @limit/.test(sql)) scans++;
        return realPrepare.call(this, sql);
      };
      let r12: ReturnType<ExpStore["discoverExperiencesRelaxed"]>;
      try {
        r12 = expStore.discoverExperiencesRelaxed({ text_terms: ["orca", "zz1", "zz2", "zz3", "zz4", "zz5"] }, 20);
      } finally {
        (db as any).prepare = realPrepare;
      }
      assertEq([scans, r12.results.map((e) => e.id), r12.textTermsMatched, r12.relaxedKeys], [2, [ids.orca], 1, ["text_terms"]],
        "s34: one word of six matches: two queries (all terms, then the most terms), not six");
      // With a radius, the rows with the most terms are picked after the radius cut.
      const setLoc = (db as any).prepare("UPDATE experiences SET loc_lat = ?, loc_lon = ?, geo_precision = ? WHERE id = ?");
      setLoc.run(69.65, 18.96, "address", ids.arctic);
      setLoc.run(70.05, 20.16, "address", ids.orca); // inside the 50 km box around Tromsø, about 64 km away
      try {
        const r13 = expStore.discoverExperiencesRelaxed({ lat: 69.65, lng: 18.96, radius_km: 50, text_terms: ["northern", "orca"] }, 20);
        assertEq([r13.results.map((e) => e.id), r13.textTermsMatched, r13.relaxedKeys], [[ids.arctic], 1, ["text_terms"]],
          "s35: the row with both terms is outside the radius: the row inside with one of them, not a dropped search");
      } finally {
        setLoc.run(null, null, null, ids.arctic);
        setLoc.run(null, null, null, ids.orca);
      }
      const kommuner = expStore.publishedKommuneSet();
      assertTrue(kommuner.has("Tromsø") && kommuner.has("Stranda") && kommuner.has("Time") && !kommuner.has("Finnsnes"),
        "s18: publishedKommuneSet holds the kommuner of published rows only");

      // ── (m) MCP tool ──────────────────────────────────────────────────
      const logged: string[] = [];
      conversation.startConversation = ((o: { queryText?: string }) => { logged.push(String(o.queryText ?? "")); return undefined as any; }) as any;
      const mcpModule = require("./experiences-mcp") as typeof import("./experiences-mcp");
      session = await openOpplevagentMcpSession(mcpModule);
      const discover = session.discover;

      // AC1
      const whale = await discover({ query: "hvalsafari i Tromsø" });
      assertTrue(whale.count > 0 && whale.experiences.every((e: any) => e.kommune === "Tromsø"), "m1: AC1 every row is in Tromsø");
      assertEq(whale.experiences.map((e: any) => e.id), [ids.whaleWatching, ids.whaleSafari, ids.museum], "m2: AC1 whale rows only, title hits first");
      assertEq([whale.filter_applied.kommune, whale.filter_applied.text_terms], ["Tromsø", ["hvalsafari"]], "m3: AC1 filter_applied.kommune is Tromsø");
      assertEq(whale.query_interpretation, { source: "query", kommune: "Tromsø", terms: ["hvalsafari"] }, "m4: AC1 query_interpretation.source is query");
      assertTrue(logged.some((l) => l.includes('"kommune":"Tromsø"') && l.includes('"text_terms_count":1')) && !logged.some((l) => /hvalsafari/i.test(l)),
        "m5: the log has the structured keys and the number of search words, never the words or the raw query");

      // AC2
      const lofoten = await discover({ query: "Lofoten" });
      assertEq(lofoten.filter_applied.kommuner, [...REGION_TO_KOMMUNER.Lofoten], "m6: AC2 filter_applied.kommuner is the Lofoten list");
      assertTrue(lofoten.count === 2 && lofoten.experiences.every((e: any) => REGION_TO_KOMMUNER.Lofoten.includes(e.kommune)), "m7: AC2 no row outside Lofoten");

      // AC3
      const geiranger = await discover({ query: "Geiranger fjordcruise" });
      assertEq([geiranger.filter_applied.fylke, geiranger.filter_applied.kommune, geiranger.filter_applied.text_terms], ["Møre og Romsdal", undefined, ["geiranger", "fjordcruise"]],
        "m8: AC3 Geiranger → fylke Møre og Romsdal plus search words, no kommune");
      assertEq(geiranger.experiences.map((e: any) => e.id), [ids.geiranger], "m9: AC3 the fjord cruise, not an unfiltered list");

      // AC4
      const nonsense = await discover({ query: "zzzqqq" });
      assertTrue(nonsense.count === 0 && nonsense.experiences.length === 0 && nonsense.zero_hit_reason === "unrecognized_query",
        "m10: AC4 «zzzqqq» → count 0, zero_hit_reason unrecognized_query");
      assertTrue(Array.isArray(nonsense.valid_categories) && nonsense.valid_categories.includes("dyreliv_safari"), "m11: AC4 … with valid_categories");
      const adventure = await discover({ query: "adventure" });
      assertTrue(adventure.count > 0 && !adventure.zero_hit_reason && JSON.stringify(adventure.filter_applied) === "{}" && adventure.query_interpretation === undefined,
        "m12: generic alias words alone browse like a general question (F1)");
      const farmSale = await discover({ query: "gårdssalg i Bergen" });
      assertTrue(farmSale.count === 0 && farmSale.experiences.length === 0 && /discover_gardssalg/.test(farmSale.summary) && farmSale.filter_applied.category === "gardssalg_smaking" && farmSale.query_interpretation?.source === "query",
        "m12b: «gårdssalg» in the query points to discover_gardssalg, like category='gardssalg' (F1)");
      const outdoor = await discover({ query: "outdoor activities in Oslo" });
      assertTrue(outdoor.filter_applied.indoor_outdoor === "outdoor" && outdoor.filter_applied.kommune === "Oslo" && outdoor.count > 0 && outdoor.experiences.every((e: any) => e.kommune === "Oslo"),
        "m12c: «outdoor activities in Oslo» → kommune Oslo + indoor_outdoor outdoor, rows in Oslo");

      // AC5
      const norway = await discover({ query: "what can we do in Norway" });
      assertTrue(norway.count > 0 && !norway.zero_hit_reason && JSON.stringify(norway.filter_applied) === "{}" && norway.query_interpretation === undefined,
        "m13: AC5 a general question still browses the catalogue");

      // AC6
      const goodTime = await discover({ query: "a good time in Bergen" });
      assertTrue(goodTime.filter_applied.kommune === "Bergen" && goodTime.experiences.every((e: any) => e.kommune === "Bergen"), "m14: AC6 «a good time in Bergen» → Bergen, not Time");
      const ski = await discover({ query: "ski touring" });
      assertTrue(ski.filter_applied.kommune === undefined && ski.count === 0, "m15: AC6 «ski touring» sets no kommune (and finds nothing)");

      // AC7 + S3: a kommune without rows, given or read from the query.
      const storslett = await discover({ kommune: "Storslett" });
      assertTrue(storslett.count > 0 && storslett.experiences.every((e: any) => e.fylke === "Troms"), "m16: S3 an empty kommune in Troms gives Troms rows");
      assertEq(storslett.relaxed_filters, ["kommune→fylke"], "m17: S3 … with relaxed_filters kommune→fylke");
      const storslettFood = await discover({ kommune: "Storslett", category: "mat_drikke" });
      assertTrue(storslettFood.experiences.every((e: any) => e.fylke === "Troms") && !(storslettFood.relaxed_filters.includes("kommune") && storslettFood.relaxed_filters.includes("fylke")),
        "m18: AC7 explicit empty kommune: never relaxed to both kommune and fylke");
      const storslettQuery = await discover({ query: "matvandring i Storslett" });
      assertTrue(storslettQuery.count > 0 && storslettQuery.experiences.every((e: any) => e.fylke === "Troms") && !storslettQuery.relaxed_filters.includes("kommune") && !storslettQuery.relaxed_filters.includes("fylke"),
        "m19: AC7 empty kommune from the query: Troms rows, place never relaxed");
      const unknownPlace = await discover({ kommune: "Ukjentby" });
      assertTrue(unknownPlace.count === 0 && unknownPlace.experiences.length === 0 && unknownPlace.zero_hit_reason === "place_no_match",
        "m20: S3 {kommune:'Ukjentby'} never gives a nationwide list");
      const finnmark = await discover({ fylke: "Finnmark" });
      assertTrue(finnmark.count === 0 && finnmark.zero_hit_reason === "place_no_match" && finnmark.relaxed_filters === undefined,
        "m21: an explicit fylke without rows is an honest zero");
      assertTrue(Array.isArray(finnmark.suggestions) && finnmark.suggestions.length > 0 && /Ingen opplevelser funnet i Finnmark/.test(finnmark.summary),
        "m22: … with suggestions and a summary that names the place");
      const alta = await discover({ query: "Hva kan vi gjøre i Alta?" });
      assertTrue(alta.count === 0 && alta.zero_hit_reason === "place_no_match" && alta.filter_applied.fylke === "Finnmark",
        "m23: a place read from the query with nothing there → place_no_match, not the whole country");

      // Relaxation of everything the query asked for.
      const spa = await discover({ query: "spa" });
      assertTrue(spa.count === 0 && spa.zero_hit_reason === "relaxation_exhausted" && spa.relaxed_filters.includes("category"),
        "m24: a query whose only filter (category) is relaxed away → relaxation_exhausted, not the catalogue");

      // Multi-word fylke names are one place (fix round 1, B1).
      const moreQuery = await discover({ query: "Hva kan vi finne på i Møre og Romsdal?" });
      const moreStructured = await discover({ fylke: "Møre og Romsdal" });
      assertEq([moreQuery.filter_applied, moreQuery.relaxed_filters, moreQuery.experiences.map((e: any) => e.id)],
        [{ fylke: "Møre og Romsdal" }, undefined, moreStructured.experiences.map((e: any) => e.id)],
        "m30: «i Møre og Romsdal» answers like {fylke:'Møre og Romsdal'} — not just the row that says Romsdal");
      assertEq(moreStructured.count, 4, "m30b: … the four Møre og Romsdal rows");
      const tfQuery = await discover({ query: "Hva kan vi finne på i Troms og Finnmark?" });
      const tfStructured = await discover({ fylke: "Troms og Finnmark" });
      assertEq([tfQuery.filter_applied.fylke, tfQuery.zero_hit_reason, tfQuery.experiences.map((e: any) => e.id)],
        ["Troms og Finnmark", undefined, tfStructured.experiences.map((e: any) => e.id)],
        "m31: «i Troms og Finnmark» answers like {fylke:'Troms og Finnmark'}, not Finnmark's honest zero");
      assertEq(tfStructured.count, 10, "m31b: … the ten published Troms rows");

      // Search words are relaxed one at a time, never all-or-nothing (fix round 1, B2).
      const n1 = await discover({ query: "Book the northern lights cruise for two people and charge my credit card now" });
      assertEq([n1.filter_applied.text_terms, n1.relaxed_filters, n1.experiences.map((e: any) => e.id)],
        [["northern", "lights", "cruise", "charge", "credit", "card"], ["text_terms"], [ids.arctic]],
        "m32: N1 query-only finds the Arctic Explorer cruise although «charge», «credit» and «card» match nothing");
      assertTrue(/3 av dem/.test(n1.summary) && /3 of them/.test(n1.summary), "m33: … and says how many of the search words the hits have");
      const noise = await discover({ query: "dog sledding blåbærsyltetøy" });
      assertEq([noise.relaxed_filters, noise.experiences.map((e: any) => e.id).sort()],
        [["text_terms"], [ids.dogTromso, ids.dogSenja, ids.dogLyngen, ids.sirdal].sort()],
        "m34: a noise word no list knows drops out; the answer stays the dog-sledding rows, not the catalogue");
      for (const q of ["northern lights tonight", "dog sledding tonight", "northern lights tour for two adults"]) {
        const r = await discover({ query: q });
        assertTrue(r.count > 0 && !r.zero_hit_reason && r.relaxed_filters === undefined, `m35: «${q}» finds rows without relaxing`);
      }
      const noMatch = await discover({ query: "zzzqqq xyzzy" });
      assertTrue(noMatch.count === 0 && noMatch.zero_hit_reason === "unrecognized_query" && /no experience contains its search words/.test(noMatch.summary) && !/No recognisable criteria/.test(noMatch.summary),
        "m36: search words that match nothing get their own text, not «no recognisable criteria»");

      // Kommuner only the catalogue has (F8).
      const lyngen = await discover({ query: "dog sledding in Lyngen" });
      assertEq([lyngen.filter_applied.kommune, lyngen.relaxed_filters, lyngen.experiences.map((e: any) => e.id)], ["Lyngen", undefined, [ids.dogLyngen]],
        "m37: «in Lyngen» is the catalogue kommune Lyngen");

      // Fix round 2, B1: catalogue kommuner named like everyday words (Gran, Strand, Øyer, Fjord).
      for (const q of ["things to do in Gran Canaria", "hva kan vi gjøre på Gran Canaria"]) {
        const r = await discover({ query: q });
        assertTrue(r.out_of_area === true && r.place === "Gran Canaria" && r.count === 0 && r.experiences.length === 0,
          `m38: «${q}» is outside Norway: no Norwegian rows, not the kommune Gran`);
      }
      for (const [q, place] of [["skiing in Alta Badia", "Alta Badia"], ["a day trip to Bergen op Zoom", "Bergen Op Zoom"]]) {
        const r = await discover({ query: q });
        assertTrue(r.out_of_area === true && r.place === place && r.count === 0, `m48: «${q}» is outside Norway, not the kommune ${place.split(" ")[0]} (F13)`);
      }
      const beach = await discover({ query: "bading på strand i Bergen" });
      assertTrue(beach.filter_applied.kommune === "Bergen" && beach.count > 0 && beach.experiences.every((e: any) => e.kommune === "Bergen"),
        "m39: «bading på strand i Bergen» → Bergen, not the kommune Strand (Preikestolen)");
      const islands = await discover({ query: "hva kan vi gjøre på øyer i Lofoten" });
      assertTrue(JSON.stringify(islands.filter_applied.kommuner) === JSON.stringify(REGION_TO_KOMMUNER.Lofoten) && islands.filter_applied.kommune === undefined &&
        islands.count > 0 && islands.experiences.every((e: any) => REGION_TO_KOMMUNER.Lofoten.includes(e.kommune)),
        "m40: «på øyer i Lofoten» → Lofoten, not the kommune Øyer (Hafjell)");
      const fjordBergen = await discover({ query: "kayaking in fjord landscapes near Bergen" });
      assertTrue(fjordBergen.filter_applied.kommune === "Bergen" && fjordBergen.count > 0 && fjordBergen.experiences.every((e: any) => e.kommune === "Bergen"),
        "m41: «kayaking in fjord landscapes near Bergen» → Bergen, not the kommune Fjord");
      const oyer = await discover({ query: "alpint i Øyer" });
      assertEq([oyer.filter_applied.kommune, oyer.experiences.map((e: any) => e.id)], ["Øyer", [ids.hafjell]],
        "m42: written as a name after a preposition, Øyer is still the catalogue kommune");

      // Fix round 2, F12: a landsdel is a protected place, never the search word «nord».
      const northWinter = await discover({ query: "Nord-Norge vinter" });
      assertTrue(JSON.stringify(northWinter.filter_applied.fylker) === '["Nordland","Troms","Finnmark"]' && northWinter.filter_applied.season === "winter" &&
        northWinter.filter_applied.text_terms === undefined && northWinter.relaxed_filters === undefined && northWinter.count > 0 &&
        northWinter.experiences.every((e: any) => ["Nordland", "Troms"].includes(e.fylke)),
        "m43: «Nord-Norge vinter» → winter rows in the northern fylker, not from Bergen, Oslo and Ålesund");
      assertEq(northWinter.query_interpretation, { source: "query", fylker: ["Nordland", "Troms", "Finnmark"], season: "winter" },
        "m44: … reported in query_interpretation");
      // Sørlandet (Agder) has one row, Sirdal; unpublished for this check.
      const setStatus = db.prepare("UPDATE experiences SET verification_status = ? WHERE id = ?");
      setStatus.run("needs_review", ids.sirdal);
      try {
        const south = await discover({ query: "hundekjøring på Sørlandet" });
        assertTrue(south.count === 0 && south.experiences.length === 0 && south.zero_hit_reason === "place_no_match" &&
          JSON.stringify(south.filter_applied.fylker) === '["Agder"]' && /Ingen opplevelser funnet i Agder/.test(south.summary),
          "m47: a landsdel with nothing published is an honest zero, never the rest of the country");
      } finally {
        setStatus.run("verified", ids.sirdal);
      }

      // Fix round 2, F11: plural and definite forms.
      const fjords = await discover({ query: "Norwegian fjords" });
      assertTrue(fjords.count === 2 && !fjords.zero_hit_reason && JSON.stringify(fjords.filter_applied.text_terms) === '["fjords"]' && fjords.relaxed_filters === undefined,
        "m45: «Norwegian fjords» finds the fjord rows, not unrecognized_query");
      const auroraTromso = await discover({ query: "nordlyset i Tromsø" });
      assertTrue(auroraTromso.filter_applied.kommune === "Tromsø" && auroraTromso.relaxed_filters === undefined && auroraTromso.experiences.some((e: any) => e.id === ids.arctic),
        "m46: «nordlyset i Tromsø» finds the northern-lights cruise without relaxing");

      // Explicit arguments win.
      const explicitPlace = await discover({ query: "hvalsafari i Bergen", kommune: "Tromsø" });
      assertTrue(explicitPlace.filter_applied.kommune === "Tromsø" && explicitPlace.filter_applied.text_terms === undefined && explicitPlace.query_interpretation === undefined && explicitPlace.count === 7,
        "m25: an explicit kommune wins; the query adds no search words");
      const explicitCategory = await discover({ query: "wildlife in Tromsø", category: "kultur_historie" });
      assertEq([explicitCategory.filter_applied.category, explicitCategory.experiences.map((e: any) => e.id)], ["kultur_historie", [ids.museum]],
        "m26: an explicit category wins over the query's alias word");
      const reworded = await discover({ category: "dyreliv_safari", query: "wildlife experiences across Norway, preferably with whales" });
      const categoryOnly = await discover({ category: "dyreliv_safari" });
      assertEq([reworded.filter_applied, reworded.relaxed_filters, reworded.experiences.map((e: any) => e.id)],
        [{ category: "dyreliv_safari" }, undefined, categoryOnly.experiences.map((e: any) => e.id)],
        "m26b: an explicit category + reworded query gains no search words and no relaxation banner (F4)");

      // Calls without `query` are unchanged.
      const noQuery = await discover({ max_price: 10 });
      assertTrue(noQuery.count > 0 && JSON.stringify(noQuery.relaxed_filters) === '["max_price"]' && !noQuery.zero_hit_reason && noQuery.query_interpretation === undefined,
        "m27: without query, the old relaxation (max_price dropped) is unchanged");
      const tromsWinter = await discover({ fylke: "Troms", season: "winter" });
      assertEq(Object.keys(tromsWinter), ["summary", "count", "filter_applied", "experiences"], "m28: a structured call answers with exactly the old fields");
    } catch (err: any) {
      failed++;
      failures.push("opplevagent-mcp-query-intent: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      conversation.startConversation = realStartConversation;
      if (session) await session.close();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevagent-mcp-query-intent.test.ts`
if (require.main === module) {
  runOpplevagentMcpQueryIntentTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
