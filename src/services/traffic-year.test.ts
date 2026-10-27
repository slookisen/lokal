/**
 * traffic-year.test.ts — dev-request 2026-10-22-statistikk-samme-tall-12-mnd, S2
 * (public part): the 12-month block of the strips and GET /api/traffic-stats.
 *
 * Covers:
 *   (a) computeTrafficYear: the block's shape; sums of the stored day rows
 *       (traffic_history, period 'day') plus the raw rows after the last
 *       stored day (today), with no double count of a stored day that still
 *       has raw rows; rows before the window are left out; start dates: a
 *       number with data for the whole window has since = null, else the
 *       first day all its parts have data (AI-søk: the later of the first
 *       traffic day and the first day with stored lookups); «Med i AI-søk»
 *       from profile_ai_deliveries starting at countingSince.
 *   (b) computeTrafficStats: the 60-day fields keep their meaning (raw rows of
 *       the window only, the stored history does not leak in) and the field
 *       list is the old one plus `year`.
 *   (c) the strips on rettfrabonden.com (nb + en), finn-tannlege.com and
 *       opplevagent.no render five numbers with the five names, each labelled
 *       «siste 12 måneder» or «siden <dato>», no «Med i AI-svar», no
 *       «AI-visninger», no 60-day label; GET /api/traffic-stats (rfb and
 *       dental) carries the `year` block next to the unchanged old fields.
 *   (d) the block is computed by the function the off-thread worker runs
 *       (runStatsTask "trafficStats"), not on the request path.
 *
 * Exported runTrafficYearTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/traffic-year.test.ts
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.4)";
const D = 86_400_000;

function sqlTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runTrafficYearTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevCountingSince = process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
  const prevPruneDays = process.env.RFB_AUTO_PRUNE_DAYS;
  delete process.env.RFB_AUTO_PRUNE_DAYS;
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  const prevLog = console.log;
  const cachePaths = [
    "../database/db-factory", "./dental-store", "./experience-store", "./traffic-stats", "./oa-home-counters",
    "../routes/seo", "../routes/dental-seo", "../routes/experiences-seo",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  const year = require("./traffic-year-compute") as typeof import("./traffic-year-compute");
  const statsCompute = require("./traffic-stats-compute") as typeof import("./traffic-stats-compute");
  const { computeTrafficReport } = require("./traffic-report") as typeof import("./traffic-report");
  const { addDays, dayOf } = require("./traffic-history-compute") as typeof import("./traffic-history-compute");

  function insertDay(db: Database.Database, vertical: string, day: string, n: { views: number; human: number; visits: number; ai: number; crawler: number; lookups?: number | null }): void {
    const summary: Record<string, unknown> = {
      period: "day", start: day, end: addDays(day, 1), vertical, version: 5, partialFrom: null,
      totals: { views: n.views, visits: n.visits, visitors: 1 },
      groups: {
        human: { views: n.human, visits: n.visits, visitors: 1 },
        ai_search: { views: n.ai, visits: 0, visitors: 0 },
        ai_crawler: { views: n.crawler, visits: 0, visitors: 0 },
        bot: { views: n.views - n.human - n.ai - n.crawler, visits: 0, visitors: 0 },
        dev: { views: 0, visits: 0, visitors: 0 },
      },
    };
    // undefined: a row stored before S0 (no aiLookups); null: unknown.
    if (n.lookups !== undefined) summary.aiLookups = n.lookups === null ? null : { mcp: n.lookups, a2a: 0, total: n.lookups };
    db.prepare("INSERT INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary) VALUES ('day', ?, ?, ?, 5, NULL, ?)")
      .run(day, addDays(day, 1), vertical, JSON.stringify(summary));
  }
  function insertPv(db: Database.Database, vertical: string, path: string, session: string, ms: number): void {
    db.prepare("INSERT INTO analytics_page_views (path, session_id, is_owner, vertical_id, created_at) VALUES (?, ?, 0, ?, ?)").run(path, session, vertical, sqlTs(ms));
  }
  function insertMcp(db: Database.Database, vertical: string, ms: number): void {
    db.prepare("INSERT INTO analytics_mcp_calls (protocol, vertical_id, tool_name, is_owner, created_at) VALUES ('mcp', ?, 'lokal_search', 0, ?)").run(vertical, sqlTs(ms));
  }
  function insertDelivery(db: Database.Database, vertical: string, day: string, count: number): void {
    db.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, 'p-1', ?, 'mcp', 'claude', ?)").run(vertical, day, count);
  }

  try {
    // ── (a) computeTrafficYear on a fixed clock ────────────────────────
    {
      const db = new Database(":memory:");
      initMod.__initSchemaForTesting(db as any);
      const nowMs = Date.UTC(2026, 9, 26, 12, 0, 0); // 2026-10-26 12:00Z
      const today = "2026-10-26";
      const windowFrom = "2025-10-27"; // 365 days, today included
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-20";

      // rfb: history from 2026-08-20; lookups stored from 2026-09-01.
      insertDay(db, "rfb", "2025-10-01", { views: 1000, human: 500, visits: 400, ai: 100, crawler: 100 }); // before the window
      insertDay(db, "rfb", "2026-08-20", { views: 50, human: 20, visits: 10, ai: 5, crawler: 7 }); // no aiLookups (pre-S0 row)
      insertDay(db, "rfb", "2026-09-01", { views: 40, human: 10, visits: 6, ai: 3, crawler: 2, lookups: 11 });
      insertDay(db, "rfb", "2026-09-02", { views: 10, human: 4, visits: 2, ai: 1, crawler: 1, lookups: null }); // unknown lookups
      insertDay(db, "rfb", "2026-10-25", { views: 30, human: 9, visits: 5, ai: 4, crawler: 3, lookups: 2 });
      // Raw rows of yesterday (already in the stored 2026-10-25 row) and of today.
      insertPv(db, "rfb", "/", `y1:${CHROME}`, Date.UTC(2026, 9, 25, 9));
      insertPv(db, "rfb", "/", `y2:${CHATGPT_USER}`, Date.UTC(2026, 9, 25, 9));
      insertPv(db, "rfb", "/", `t1:${CHROME}`, Date.UTC(2026, 9, 26, 8));
      insertPv(db, "rfb", "/sok", `t1:${CHROME}`, Date.UTC(2026, 9, 26, 8, 5));
      insertPv(db, "rfb", "/", `t2:${CHATGPT_USER}`, Date.UTC(2026, 9, 26, 9));
      insertPv(db, "rfb", "/", `t3:${GPTBOT}`, Date.UTC(2026, 9, 26, 10));
      insertMcp(db, "rfb", Date.UTC(2026, 9, 25, 10)); // in the stored row's lookups
      insertMcp(db, "rfb", Date.UTC(2026, 9, 26, 10));
      insertMcp(db, "rfb", Date.UTC(2026, 9, 26, 11));
      insertDelivery(db, "rfb", "2026-10-01", 9); // before countingSince: not counted
      insertDelivery(db, "rfb", "2026-10-21", 4);
      insertDelivery(db, "rfb", "2026-10-26", 1);

      const y = year.computeTrafficYear(db, "rfb", nowMs);
      assertEq(Object.keys(y), ["windowDays", "from", "to", "humanVisits", "humanViews", "aiSearch", "aiCrawlerViews", "aiDeliveries", "pageViews", "aiSearchViews", "otherBotViews"], "(a) block keys");
      assertEq([y.windowDays, y.from, y.to], [365, windowFrom, today], "(a) window: 365 days ending today");
      assertEq(y.humanViews, { value: 20 + 10 + 4 + 9 + 2, since: "2026-08-20" }, "(a) humanViews: stored days in the window + today's raw, since the first stored day");
      assertEq(y.humanVisits, { value: 10 + 6 + 2 + 5 + 1, since: "2026-08-20" }, "(a) humanVisits: visits add up over the days");
      assertEq(y.aiCrawlerViews, { value: 7 + 2 + 1 + 3 + 1, since: "2026-08-20" }, "(a) aiCrawlerViews");
      assertEq(y.aiSearch, { value: (3 + 1 + 4 + 1) + (11 + 0 + 2 + 2), since: "2026-09-01", pages: 3 + 1 + 4 + 1, lookups: 11 + 2 + 2 },
        "(a) aiSearch: from the later of the first traffic day and the first stored-lookup day; both parts summed from there, unknown lookups add 0");
      assertEq(y.aiDeliveries, { value: 5, since: "2026-10-20" }, "(a) aiDeliveries: profile_ai_deliveries from countingSince");
      assertEq(y.pageViews.value, 50 + 40 + 10 + 30 + 4, "(a) pageViews: all stored + today's raw page views");
      assertEq(y.pageViews.value, y.humanViews.value + y.aiSearchViews.value + y.aiCrawlerViews.value + y.otherBotViews.value, "(a) the note's identity holds");

      // dental: data on the window's first day → the whole window, no date.
      insertDay(db, "dental", windowFrom, { views: 8, human: 3, visits: 2, ai: 1, crawler: 1, lookups: 4 });
      insertDay(db, "dental", "2026-06-01", { views: 8, human: 3, visits: 2, ai: 1, crawler: 1, lookups: 1 });
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2025-01-01";
      insertDelivery(db, "dental", "2025-10-26", 50); // the day before the window
      insertDelivery(db, "dental", "2026-01-15", 6);
      const yd = year.computeTrafficYear(db, "dental", nowMs);
      assertEq([yd.humanVisits.since, yd.humanViews.since, yd.aiSearch.since, yd.aiCrawlerViews.since, yd.aiDeliveries.since], [null, null, null, null, null],
        "(a) full window: every since is null");
      assertEq(yd.aiSearch.value, 2 + 5, "(a) dental aiSearch over the whole window");
      assertEq(yd.aiDeliveries.value, 6, "(a) aiDeliveries: only the window's days");
      assertEq(year.trafficYearPeriodLabel(yd.humanViews.since, "nb"), "siste 12 måneder", "(a) full window label (nb)");
      assertEq(year.trafficYearPeriodLabel(yd.humanViews.since, "en"), "last 12 months", "(a) full window label (en)");
      assertEq(year.trafficYearPeriodLabel("2026-08-13", "nb"), "siden 13. aug. 2026", "(a) partial label (nb)");
      assertEq(year.trafficYearPeriodLabel("2026-08-13", "en"), "since 13 Aug 2026", "(a) partial label (en)");

      // A stored row just inside the window but lookups from a later day only.
      insertDay(db, "experiences", "2026-03-01", { views: 5, human: 2, visits: 1, ai: 2, crawler: 0 });
      insertDay(db, "experiences", "2026-04-01", { views: 5, human: 2, visits: 1, ai: 1, crawler: 0, lookups: 3 });
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";
      const ye = year.computeTrafficYear(db, "experiences", nowMs);
      assertEq([ye.humanViews.since, ye.aiSearch.since, ye.aiDeliveries.since], ["2026-03-01", "2026-04-01", "2026-10-26"], "(a) first common day per number");
      assertEq(ye.aiSearch.pages, 1, "(a) ai_search pages before the first lookup day are not in AI-søk");
      assertEq(ye.aiSearchViews.value, 3, "(a) …but are in the note's page-view breakdown");
      assertEq(ye.aiDeliveries, { value: 0, since: "2026-10-26" }, "(a) a count that starts today shows the date, not a bare 0 for 12 months");

      // ── (b) the 60-day fields keep their meaning ──────────────────────
      const s = statsCompute.computeTrafficStats(db, "rfb", 60, nowMs);
      const report = computeTrafficReport(db, 60 * 24, "rfb", nowMs, { detail: false });
      assertEq([s.pageViews, s.humanViews, s.aiSearchViews, s.aiCrawlerViews, s.humanVisits], [report.totals.views, report.groups.human.views, report.groups.ai_search.views, report.groups.ai_crawler.views, report.groups.human.visits],
        "(b) 60-day fields equal the raw 60-day traffic report");
      assertEq([s.pageViews, s.humanViews, s.aiSearchViews], [6, 3, 2], "(b) the stored history rows do not leak into the 60-day fields");
      assertEq(s.aiLookups, 3, "(b) aiLookups: the raw MCP calls of the 60-day window");
      assertEq(s.windowDays, 60, "(b) windowDays still 60");
      assertEq(Object.keys(s), [...Object.keys(statsCompute.emptyTrafficStats(60))], "(b) same keys as emptyTrafficStats");
      assertEq(Object.keys(s).filter((k) => k !== "year"), ["pageViews", "uniqueVisitors", "realVisitors", "humanViews", "humanVisits", "aiSearchViews", "aiCrawlerViews", "aiLookups", "aiSearchTotal", "aiDeliveries", "otherBotViews", "botViews", "windowDays", "realHumans", "botAndAi", "aiQueries"],
        "(b) the old field list is unchanged");
      assertEq(JSON.stringify(s.year), JSON.stringify(year.computeTrafficYear(db, "rfb", nowMs)), "(b) stats.year is computeTrafficYear's block");
      assertEq(statsCompute.emptyTrafficStats(60).year, null, "(b) placeholder stats carry no year block (rendered as «–», never 0)");

      // ── (d) computed by the worker's task ──────────────────────────────
      const worker = require("./offthread-stats-worker") as typeof import("./offthread-stats-worker");
      const viaWorker = worker.runStatsTask(db, { kind: "trafficStats", vertical: "rfb", windowDays: 60 }) as import("./traffic-stats-compute").TrafficStats;
      assertTrue(!!viaWorker.year && viaWorker.year.windowDays === 365 && typeof viaWorker.year.humanViews.value === "number",
        "(d) the off-thread trafficStats task returns the 12-month block");
      db.close();
    }

    // ── (c) the three strips and the API, on the real clock ────────────
    {
      if (!log) console.log = () => { /* silence registry chatter */ };
      const nowMs = Date.now();
      const today = dayOf(nowMs);
      const histFrom = addDays(today, -30);
      const lookupFrom = addDays(today, -20);
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = addDays(today, -5);
      process.env.DENTAL_DB_PATH = ":memory:";
      process.env.EXPERIENCES_DB_PATH = ":memory:";

      const mainDb = new Database(":memory:");
      mainDb.pragma("journal_mode = DELETE");
      mainDb.pragma("foreign_keys = OFF");
      initMod.__setDbForTesting(mainDb as any);
      initMod.__initSchemaForTesting(mainDb as any);
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
      for (const v of ["rfb", "dental", "experiences", "all"]) {
        insertDay(mainDb, v, histFrom, { views: 1000, human: 600, visits: 400, ai: 70, crawler: 80 });
        insertDay(mainDb, v, lookupFrom, { views: 1000, human: 600, visits: 400, ai: 70, crawler: 80, lookups: 30 });
        if (v !== "all") insertDelivery(mainDb, v, today, 2);
      }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("dental");
      dbFactory.getDb("experiences");
      const trafficStats = require("./traffic-stats") as typeof import("./traffic-stats");
      trafficStats.__resetTrafficStatsCacheForTesting();
      const oaHome = require("./oa-home-counters") as typeof import("./oa-home-counters");
      oaHome.__resetOaHomeCountersCacheForTesting();

      const nbTraffic = year.trafficYearPeriodLabel(histFrom, "nb");
      const nbAi = year.trafficYearPeriodLabel(lookupFrom, "nb");
      const nbDeliv = year.trafficYearPeriodLabel(addDays(today, -5), "nb");

      function invoke(router: any, url: string, lang = "no"): Promise<{ status: number; body: string }> {
        return new Promise((resolve) => {
          const headers: Record<string, string> = { "user-agent": CHROME };
          const req: any = {
            method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "example.test",
            query: {}, params: {}, headers, lang, ip: "203.0.113.7",
            get(h: string) { return headers[h.toLowerCase()]; },
          };
          const res: any = new EventEmitter();
          Object.assign(res, {
            statusCode: 200, locals: {},
            status(c: number) { res.statusCode = c; return res; },
            set() { return res; }, header() { return res; }, setHeader() { return res; },
            redirect() { res.statusCode = 301; res.emit("finish"); resolve({ status: 301, body: "" }); return res; },
            send(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b) }); return res; },
            json(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: JSON.stringify(b) }); return res; },
          });
          router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? String(err) : "" }));
        });
      }
      const strip = (body: string, startMarker: string, endMarker: string) => {
        const a = body.indexOf(startMarker);
        const b = a >= 0 ? body.indexOf(endMarker, a) : -1;
        return a >= 0 && b > a ? body.slice(a, b) : "";
      };
      const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1]);
      const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      function checkStrip(site: string, html: string, labelRe: RegExp, periodRe: RegExp, valRe: RegExp, names: string[], periods: string[]): void {
        assertTrue(html.length > 0, `(c) ${site}: strip found`);
        assertEq(all(labelRe, html).map(decode).slice(0, 5), names, `(c) ${site}: the five names in order`);
        assertEq(all(periodRe, html).map(decode), periods, `(c) ${site}: each number labelled with its period`);
        const vals = all(valRe, html).slice(0, 5);
        assertEq(vals.length, 5, `(c) ${site}: five numbers`);
        assertTrue(!html.includes("Med i AI-svar") && !html.includes("AI-visninger"), `(c) ${site}: no «Med i AI-svar» / «AI-visninger»`);
        assertTrue(!/\b60 ?d(ager|ays)?\b|60d/.test(html), `(c) ${site}: no 60-day label`);
      }

      // rettfrabonden.com
      const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
      const rfbHome = await invoke(seoRouter, "/");
      assertEq(rfbHome.status, 200, "(c) rfb / renders 200");
      const rfbStrip = strip(rfbHome.body, 'class="proof-bar"', 'class="network-strip"');
      const rfbNames = ["Besøk fra mennesker", "Sidevisninger fra mennesker", "AI-søk", "AI-crawlere", "Med i AI-søk"];
      checkStrip("rfb", rfbStrip, /class="proof-lbl">([^<]+)</g, /class="proof-period">([^<]+)</g, /class="proof-val[^"]*">([^<]+)</g,
        rfbNames, [nbTraffic, nbTraffic, nbAi, nbTraffic, nbDeliv]);
      assertTrue(rfbStrip.includes((600 * 2).toLocaleString("nb-NO")), "(c) rfb: human page views summed over the stored days");
      assertTrue(rfbStrip.includes(`Sidevisninger ${nbTraffic}:`) && rfbStrip.includes(`AI-søk ${nbAi} =`) && rfbStrip.includes(`Med i AI-søk ${nbDeliv}:`),
        "(c) rfb: the explanatory note uses the same periods as the numbers");
      const rfbEn = await invoke(seoRouter, "/", "en");
      const rfbEnStrip = strip(rfbEn.body, 'class="proof-bar"', 'class="network-strip"');
      const enTraffic = year.trafficYearPeriodLabel(histFrom, "en");
      checkStrip("rfb en", rfbEnStrip, /class="proof-lbl">([^<]+)</g, /class="proof-period">([^<]+)</g, /class="proof-val[^"]*">([^<]+)</g,
        ["Visits by people", "Page views by people", "AI search", "AI crawlers", "In AI searches"],
        [enTraffic, enTraffic, year.trafficYearPeriodLabel(lookupFrom, "en"), enTraffic, year.trafficYearPeriodLabel(addDays(today, -5), "en")]);

      // /api/traffic-stats (rfb): old fields + year block.
      const api = await invoke(seoRouter, "/api/traffic-stats");
      const j = JSON.parse(api.body);
      assertEq(Object.keys(j), ["ready", "pageViews", "uniqueVisitors", "realVisitors", "humanViews", "humanVisits", "aiSearchViews", "aiCrawlerViews", "aiLookups", "aiSearchTotal", "aiDeliveries", "otherBotViews", "botViews", "windowDays", "realHumans", "botAndAi", "aiQueries", "year"],
        "(c) rfb /api/traffic-stats: the old fields, then year");
      assertEq([j.windowDays, j.humanViews, j.pageViews], [60, 0, 0], "(c) rfb API: 60-day fields from the raw rows only (none here)");
      assertEq(Object.keys(j.year), ["windowDays", "from", "to", "humanVisits", "humanViews", "aiSearch", "aiCrawlerViews", "aiDeliveries"], "(c) rfb API: the year block has the five numbers");
      assertEq([j.year.humanViews.value, j.year.humanViews.since, j.year.aiSearch.since, j.year.aiDeliveries.since], [1200, histFrom, lookupFrom, addDays(today, -5)],
        "(c) rfb API: values and start dates");

      // finn-tannlege.com
      const dentalRouter = (require("../routes/dental-seo") as typeof import("../routes/dental-seo")).default as any;
      const dentalHome = await invoke(dentalRouter, "/");
      assertEq(dentalHome.status, 200, "(c) dental / renders 200");
      const dentalStrip = strip(dentalHome.body, 'class="proof-bar"', '<section');
      checkStrip("dental", dentalStrip, /class="proof-lbl">([^<]+)</g, /class="proof-period">([^<]+)</g, /class="proof-val[^"]*">([^<]+)</g,
        rfbNames, [nbTraffic, nbTraffic, nbAi, nbTraffic, nbDeliv]);
      const dApi = JSON.parse((await invoke(dentalRouter, "/api/traffic-stats")).body);
      assertEq(Object.keys(dApi), ["ready", "pageViews", "uniqueVisitors", "realVisitors", "humanViews", "humanVisits", "aiSearchViews", "aiCrawlerViews", "aiLookups", "aiSearchTotal", "otherBotViews", "botViews", "windowDays", "realHumans", "botAndAi", "aiQueries", "year"],
        "(c) dental /api/traffic-stats: the old fields, then year");
      assertEq([dApi.year.aiDeliveries.value, dApi.year.aiDeliveries.since], [2, addDays(today, -5)], "(c) dental API: «Med i AI-søk» in the year block");

      // opplevagent.no
      const expRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;
      const expHome = await invoke(expRouter, "/");
      assertEq(expHome.status, 200, "(c) experiences / renders 200");
      const expStrip = strip(expHome.body, 'class="counters"', 'class="network-strip"');
      checkStrip("experiences", expStrip, /class="counter-lbl">([^<]+)</g, /class="counter-period">([^<]+)</g, /class="counter-val[^"]*">([^<]+)</g,
        rfbNames, [nbTraffic, nbTraffic, nbAi, nbTraffic, nbDeliv]);
      assertTrue(!expStrip.includes("Tall siden"), "(c) experiences: the old raw-window «Tall siden» fragment is gone (each number has its own date)");
    }
  } catch (err: any) {
    failed++;
    failures.push("traffic-year: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    initMod.__setDbForTesting(prevDb as any);
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("PROFILE_AI_DELIVERIES_COUNTING_SINCE", prevCountingSince);
    restore("RFB_AUTO_PRUNE_DAYS", prevPruneDays);
    restore("DENTAL_DB_PATH", prevDentalPath);
    restore("EXPERIENCES_DB_PATH", prevExpPath);
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch { /* best effort */ }
    restoreModuleCache();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runTrafficYearTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
