/**
 * search-tracking.test.ts — dev-request 2026-10-13-statistikk-riktig-for-investorer, S2.
 *
 * Covers:
 *   (a) search-tracking.ts helpers: which API requests are searches, the
 *       stored query text (free text, else "[filters]"), free-text detection.
 *   (b) computeQueryStats: searches per channel (web, api, mcp, a2a), bots and
 *       owner kept out of the total, legacy rows without a class counted,
 *       AI assistants counted from analytics_mcp_calls, top terms free text only.
 *   (c) The analytics middleware logs the public search API once per request,
 *       successful answers only, with the body's query for POST.
 *   (d) /sok on rettfrabonden.com and finn-tannlege.com logs a 'web' search
 *       with the client class of the full UA; a crawler's search is classed
 *       as a bot; paging is not a new search.
 *
 * Exported runSearchTrackingTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/search-tracking.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as http from "http";
import type { AddressInfo } from "net";
import * as initMod from "../database/init";
import {
  apiSearchQueryText,
  clampQueryText,
  filterQueryText,
  isApiSearchRequest,
  isFreeTextQuery,
  MAX_QUERY_TEXT,
} from "./search-tracking";
import { computeQueryStats } from "./admin-stats-compute";
import { computeTrafficStats } from "./traffic-stats-compute";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runSearchTrackingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail === undefined ? "" : `\n    ${JSON.stringify(detail)}`}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  };
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── (a) Helpers ────────────────────────────────────────────────────
  ok(isApiSearchRequest("GET", "/api/marketplace/search") && isApiSearchRequest("POST", "/api/search") &&
     isApiSearchRequest("POST", "/api/marketplace/discover") && isApiSearchRequest("GET", "/api/tannlege/discover/") &&
     isApiSearchRequest("GET", "/api/opplevelser/discover") &&
     isApiSearchRequest("GET", "/API/Marketplace/Search") && isApiSearchRequest("GET", "/api/marketplace/catalog/offers") &&
     isApiSearchRequest("GET", "/api/tannlege/agents", { q: "implantat" }) && isApiSearchRequest("GET", "/api/tannlege/agents", { fylke: "Oslo", limit: "5" }) &&
     !isApiSearchRequest("GET", "/api/tannlege/agents", {}) && !isApiSearchRequest("GET", "/api/tannlege/agents", { limit: "20", offset: "40" }) &&
     !isApiSearchRequest("POST", "/api/marketplace/search") && !isApiSearchRequest("GET", "/api/marketplace/agents"),
    "a1: the public search endpoints by method and path (any case); the clinic listing only when filtered");
  ok(apiSearchQueryText({ q: " honning " }, undefined) === "honning" &&
     apiSearchQueryText({}, { query: "egg oslo" }) === "egg oslo" &&
     apiSearchQueryText({ fylke: "Oslo", limit: "5" }, undefined) === "[fylke: Oslo]" &&
     apiSearchQueryText({}, { categories: ["egg", "melk"], location: { lat: 59.913868, lng: 10.752245 }, maxDistanceKm: 5 }) === "[categories: egg,melk; maxDistanceKm: 5]" &&
     apiSearchQueryText({}, { consumerPreferences: { id: "c1", dietary: ["vegan"], allergies: ["nøtter"] } }) === "[alle]" &&
     apiSearchQueryText({ lat: "59.91", lng: "10.75", near: "59.9,10.7" }, undefined) === "[alle]" &&
     apiSearchQueryText({}, {}) === "[alle]",
    "a2: stored text = free text when sent, else known plain filters (never a position or a consumer profile), else [alle]");
  ok(apiSearchQueryText({}, { query: "x".repeat(900_000) }).length === MAX_QUERY_TEXT && clampQueryText("y".repeat(500)).length === MAX_QUERY_TEXT,
    "a2b: a search text is cut to MAX_QUERY_TEXT characters");
  ok(filterQueryText({ akutt: true, fylke: "", kjede: undefined }) === "[akutt: true]" && filterQueryText({}) === "",
    "a3: empty filters are dropped");
  ok(isFreeTextQuery("egg") && !isFreeTextQuery("[fylke: Oslo]") && !isFreeTextQuery("e") && !isFreeTextQuery(null),
    "a4: free text vs filter text");

  // ── (b) Searches per channel ───────────────────────────────────────
  {
    const db = new Database(":memory:");
    initMod.__initSchemaForTesting(db as any);
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const q = db.prepare(`INSERT INTO analytics_queries (protocol, query, is_owner, vertical_id, created_at, client_class) VALUES (?, ?, ?, ?, ?, ?)`);
    const at = ts(now - 3600_000);
    q.run("web", "Egg", 0, "rfb", at, "human");
    q.run("web", "egg ", 0, "rfb", at, "human");
    q.run("web", "[nær meg]", 0, "rfb", at, "human");
    q.run("web", "honning", 0, "rfb", at, "search_engine"); // a crawler following a link
    q.run("web", "honning", 0, "rfb", at, "dev"); // a script on the search page
    q.run("api", "melk", 0, "rfb", at, "dev"); // a program using the API: counted
    q.run("api", "[fylke: Oslo]", 0, "dental", at, "human");
    q.run("api", "ost", 0, "rfb", at, null); // written before S2: counted as it is
    q.run("search", "smør", 0, "rfb", at, null); // legacy protocol value → api
    q.run("web", "eple", 0, "rfb", at, "ai_crawler"); // GPTBot following a /sok link: a bot
    q.run("web", "Økologisk", 0, "rfb", at, "human");
    q.run("web", "økologisk", 0, "rfb", at, "human");
    q.run("web", "rabarbra", 0, "rfb", at, "ai_search"); // ChatGPT-User fetching /sok for someone
    q.run("web", "egg", 1, "rfb", at, "human"); // owner
    q.run("web", "egg", 0, "rfb", ts(now - 30 * 3600_000), "human"); // outside 24 h
    const m = db.prepare(`INSERT INTO analytics_mcp_calls (protocol, vertical_id, tool_name, is_owner, created_at) VALUES (?, ?, ?, ?, ?)`);
    m.run("mcp", "rfb", "lokal_search", 0, at);
    m.run("mcp", "experiences", "discover_experiences", 0, at);
    m.run("mcp", "rfb", "lokal_info", 0, at); // not a search tool
    m.run("mcp", "rfb", "tools/list", 0, at);
    m.run("mcp", "rfb", "lokal_search", 1, at); // owner
    m.run("a2a", "rfb", "message/send", 0, at);
    m.run("a2a", "rfb", "SendMessage", 0, at); // A2A v1.0
    m.run("a2a", "rfb", "message/stream", 0, at); // not implemented anywhere (-32601)
    m.run("a2a", "rfb", "tasks/get", 0, at);
    db.prepare(`INSERT INTO analytics_mcp_calls (protocol, vertical_id, tool_name, is_owner, created_at, status_code) VALUES ('mcp', 'dental', 'tannlege_search', 0, ?, 429)`).run(at);

    const all = computeQueryStats(db as any, 24, undefined, now);
    ok(eq(all.byChannel, { web: 5, api: 4, mcp: 2, a2a: 2, ai: 1 }) && all.totalQueries === 14,
      "b1: web 5, api 4 (incl. a script, a filter search and two legacy rows), mcp 2 search tools (not the 429), a2a 2 (message/send, SendMessage; not message/stream), ai 1 assistant fetch", all);
    ok(all.botQueries === 3 && all.ownerQueries === 1, "b2: the crawler's, the AI crawler's and the script's /sok searches are bots; owner apart", all);
    ok(eq(all.topSearchTerms, [{ query: "egg", count: 2 }, { query: "økologisk", count: 2 }, { query: "melk", count: 1 }, { query: "ost", count: 1 }, { query: "rabarbra", count: 1 }, { query: "smør", count: 1 }]),
      "b3: top terms: free text only, case merged (Æ/Ø/Å too) and spaces trimmed, no bots, owner or filter text", all.topSearchTerms);
    const pub = computeTrafficStats(db as any, undefined, 1, now);
    ok(pub.aiQueries === 2 + 2 + 1, "b5: the public aiQueries counts AI assistants' searches only (mcp + a2a + assistant fetches), not people's", pub.aiQueries);
    const dental = computeQueryStats(db as any, 24, "dental", now);
    ok(dental.totalQueries === 1 && dental.byChannel?.api === 1, "b4: vertical filter applies to both tables", dental);
    db.close();
  }

  // ── (e) The nightly rollup keeps people's searches only ─────────────
  {
    const prev = initMod.getDb();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      const prevLog = console.log;
      console.log = () => {};
      try { initMod.__initSchemaForTesting(db as any); } finally { console.log = prevLog; }
      const old = ts(Date.now() - 70 * 86_400_000);
      const q = db.prepare(`INSERT INTO analytics_queries (protocol, query, is_owner, vertical_id, created_at, client_class) VALUES (?, 'honning', 0, 'rfb', ?, ?)`);
      for (const cls of ["search_engine", "search_engine", "ai_crawler", "human", null]) q.run("web", old, cls);
      q.run("web", old, "dev"); // a script on the search page
      q.run("api", old, "dev"); // a program using the API: kept
      const { rollupAndPruneQueries } = require("./retention-service") as typeof import("./retention-service");
      rollupAndPruneQueries(60, 7);
      const text = db.prepare("SELECT SUM(query_count) AS n FROM query_text_daily WHERE query = 'honning'").get() as { n: number };
      const daily = db.prepare("SELECT SUM(query_count) AS n FROM query_daily").get() as { n: number };
      const left = db.prepare("SELECT COUNT(*) AS n FROM analytics_queries").get() as { n: number };
      ok(text.n === 3 && daily.n === 3 && left.n === 0,
        "e1: the rollup keeps the person's, the legacy row's and the API program's searches, not the crawlers' or the page script's; raw rows deleted", { text, daily, left });
    } catch (e) {
      ok(false, "e: rollup test threw", (e as Error).stack);
    } finally {
      initMod.__setDbForTesting(prev);
      db.close();
    }
  }

  // ── (c) + (d) The write path ───────────────────────────────────────
  const prevDb = initMod.getDb();
  const memDb = new Database(":memory:");
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  let server: http.Server | null = null;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
    require.resolve("../routes/dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  try {
    initMod.__setDbForTesting(memDb as any);
    initMod.__initSchemaForTesting(memDb as any);
    process.env.DENTAL_DB_PATH = ":memory:";
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("dental");
    // The rfb search page reads the vertical config (src/index.ts loads it at boot).
    const cfgMod = require("../config/vertical-config") as typeof import("../config/vertical-config");
    cfgMod._resetConfigCacheForTests();
    cfgMod.loadConfigsAtBoot({ dir: "./verticals" });
    const { analyticsService } = require("./analytics-service") as typeof import("./analytics-service");
    const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
    const dentalSeoRouter = (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default as any;

    const app = express();
    app.use(express.json());
    app.use(analyticsService.middleware());
    app.use((req: any, _res, next) => { req.lang = "no"; next(); });
    app.get("/api/marketplace/search", (req, res) => {
      if (req.query.q === "feil") { res.status(400).json({ error: "nei" }); return; }
      res.send({ results: [] }); // object → send re-enters through json: must log once
    });
    app.post("/api/search", (_req, res) => { res.json({ results: [] }); });
    app.get("/api/tannlege/discover", (_req, res) => { res.json({ agents: [] }); });
    app.get("/api/marketplace/agents", (_req, res) => { res.json([]); });
    app.use((req, res, next) => (req.hostname.includes("finn-tannlege") ? dentalSeoRouter(req, res, next) : next()));
    app.use(seoRouter);
    server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, o: { ua?: string; host?: string; body?: unknown } = {}) => new Promise<number>((resolve) => {
      const data = o.body === undefined ? undefined : JSON.stringify(o.body);
      const req = http.request({
        host: "127.0.0.1", port, path, method,
        headers: {
          "User-Agent": o.ua ?? CHROME,
          Host: o.host ?? "rettfrabonden.com",
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode || 0)); });
      req.on("error", () => resolve(0));
      if (data) req.write(data);
      req.end();
    });

    await call("GET", "/api/marketplace/search?q=honning");
    await call("GET", "/api/marketplace/search?q=feil");
    await call("POST", "/api/search", { body: { query: "egg oslo" } });
    await call("GET", "/api/tannlege/discover?fylke=Oslo&limit=5");
    await call("GET", "/api/marketplace/agents?q=ost");
    await call("POST", "/api/search", { body: { query: "z".repeat(50_000) } });
    const sokStatus = await call("GET", "/sok?q=eple&heleNorge=true");
    await call("GET", "/sok?q=eple&heleNorge=true", { ua: GOOGLEBOT });
    await call("GET", "/sok?q=eple&heleNorge=true", { ua: GPTBOT });
    await call("GET", "/sok?q=eple&heleNorge=true", { ua: CHATGPT_USER });
    const headStatus = await call("HEAD", "/sok?q=hode&heleNorge=true");
    const dentalStatus = await call("GET", "/sok?q=implantat", { host: "finn-tannlege.com" });
    await call("GET", "/sok?q=implantat&side=2", { host: "finn-tannlege.com" });
    await call("GET", "/sok?fylke=Oslo", { host: "finn-tannlege.com" });
    await new Promise((r) => setTimeout(r, 50));

    const rows = memDb.prepare("SELECT protocol, query, vertical_id, client_class FROM analytics_queries ORDER BY id").all() as any[];
    const api = rows.filter((r) => r.protocol === "api").map((r) => r.query);
    ok(eq(api.slice(0, 3), ["honning", "egg oslo", "[fylke: Oslo]"]) && api.length === 4 && api[3] === "z".repeat(MAX_QUERY_TEXT),
      "c1: API searches logged once each, POST body query used, filters as text, a long text cut, errors and other endpoints not logged", rows.map((r) => [r.protocol, String(r.query).slice(0, 20)]));
    const web = rows.filter((r) => r.protocol === "web");
    const rfbWeb = web.filter((r) => r.vertical_id === "rfb");
    ok(sokStatus === 200 && eq(rfbWeb.map((r) => r.client_class), ["human", "search_engine", "ai_crawler", "ai_search"]) &&
       rfbWeb[0].query === "eple",
      "d1: rettfrabonden.com /sok logs a web search with the full UA's class (Googlebot search_engine, GPTBot ai_crawler, ChatGPT-User ai_search)", { sokStatus, web });
    ok(headStatus === 200 && !web.some((r) => r.query === "hode"), "d3: a HEAD of the search page is not a search", { headStatus });
    ok(dentalStatus === 200 && eq(web.filter((r) => r.vertical_id === "dental").map((r) => r.query), ["implantat", "[fylke: Oslo]"]),
      "d2: finn-tannlege.com /sok logs the first page of a query or filter, not page 2", { dentalStatus, web });
  } catch (e) {
    ok(false, "c/d: write-path tests threw", (e as Error).stack);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    initMod.__setDbForTesting(prevDb);
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/search-tracking.test.ts`
if (require.main === module) {
  runSearchTrackingTests({ log: true }).then((summary) => {
    for (const f of summary.failures) console.log(f);
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
