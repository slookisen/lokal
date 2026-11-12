/**
 * admin-year-same-numbers.test.ts — dev-request 2026-10-22-statistikk-samme-tall-12-mnd,
 * S2 (admin part, S2b).
 *
 * Covers:
 *   (AC2) GET /admin/analytics/year?vertical=… returns exactly the `year` block
 *         of GET /api/traffic-stats and the five numbers of the site's strip,
 *         from the same snapshot (getTrafficStatsSnapshot → publicTrafficYearBlock),
 *         with the snapshot's compute time for «oppdatert kl. HH:MM». The route
 *         and the dashboard are locked to that source; one site only; host lock.
 *   (AC3) «AI-visninger» is gone from the dashboard (cards, tables, CSV header);
 *         AI-søk and AI-crawlere are separate there, in the top-pages and the
 *         markedsnettverk tables (with the split computed server-side).
 *   (AC4) «Søk (nettsider og API)»: web + api only, never mcp/a2a/ai —
 *         siteSearchCount, the summary, the stored history rows and the
 *         dashboard's own helper.
 *   (AC5) «Alle»: «unike på tvers av nettstedene, ikke summen av dem» under
 *         Besøkende and Besøk.
 *   Also: /ai-deliveries?days= for the «Med i AI-søk» card.
 *
 * Exported runAdminYearSameNumbersTests({log}) -> Promise<TestSummary>; wired
 * into tests/test.ts. Standalone: npx tsx src/services/admin-year-same-numbers.test.ts
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.4)";

function sqlTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runAdminYearSameNumbersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const root = path.resolve(__dirname, "..", "..");
  const html = fs.readFileSync(path.join(root, "src/public/admin-dashboard.html"), "utf8");
  const analyticsSrc = fs.readFileSync(path.join(root, "src/routes/analytics.ts"), "utf8");
  const script = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).pop() || "";

  /** One top-level `function name(...) {...}` from the dashboard script, as source. */
  function dashFn(name: string): string {
    const start = script.indexOf(`function ${name}(`);
    if (start < 0) return "";
    let depth = 0;
    for (let i = script.indexOf("{", start); i < script.length; i++) {
      if (script[i] === "{") depth++;
      else if (script[i] === "}" && --depth === 0) return script.slice(start, i + 1);
    }
    return "";
  }

  // ── (AC3) no «AI-visninger»; AI-søk and AI-crawlere apart ─────────────
  {
    assertTrue(!html.includes("AI-visninger"), "(AC3) the dashboard has no «AI-visninger»");
    assertTrue(!/ai_visninger/.test(html), "(AC3) no ai_visninger CSV column");
    const head = script.match(/var HISTORY_CSV_HEAD = (\[[\s\S]*?\]);/);
    const cols: string[] = head ? vm.runInNewContext(head[1]) : [];
    assertTrue(cols.includes("ai_sok") && cols.includes("ai_crawlere") && cols.includes("ai_sok_sider") && cols.includes("ai_sok_oppslag"),
      "(AC3) CSV header: ai_sok (with its parts) and ai_crawlere as separate columns");
    assertTrue(cols.includes("sok_nettsider_og_api") && !cols.includes("sok"), "(AC3/AC4) CSV searches column is the site searches");
    const table = dashFn("renderHistoryTable");
    assertTrue(table.includes(">AI-søk</th>") && table.includes(">AI-crawlere</th>") && table.includes("r.aiSearch") && table.includes("r.aiCrawlerViews") && !table.includes("aiViews"),
      "(AC3) month/week table: AI-søk and AI-crawlere columns, not aiViews");
    const compare = dashFn("renderCompareCard");
    assertTrue(compare.includes('"AI-søk"') && compare.includes('"AI-crawlere"') && !compare.includes("agentTraffic"), "(AC3) compare card: AI-søk and AI-crawlere, not the vendor sum");
    const pages = dashFn("renderTopPages");
    assertTrue(pages.includes("p.aiSearchViews") && pages.includes("p.aiCrawlerViews") && !pages.includes("p.aiViews"), "(AC3) top pages: split columns");
    const umb = dashFn("renderUmbrellaTraffic");
    assertTrue(umb.includes("u.ai_search_pageviews") && umb.includes("u.ai_crawler_pageviews") && !umb.includes("ai_bot_pageviews"), "(AC3) markedsnettverk table: split columns");
    for (const label of ["Besøk fra mennesker", "Sidevisninger fra mennesker", ">AI-søk<", ">AI-crawlere<", ">Med i AI-søk<", ">Søk (nettsider og API)<"]) {
      assertTrue(html.includes(label), `(AC3) card label ${label}`);
    }
  }

  // ── (AC4) Søk (nettsider og API) ──────────────────────────────────────
  {
    const { siteSearchCount } = require("./search-stats-compute") as typeof import("./search-stats-compute");
    const ch = { web: 3, api: 2, mcp: 5, a2a: 7, ai: 11 };
    assertEq(siteSearchCount(ch), 5, "(AC4) siteSearchCount = web + api");
    assertEq([siteSearchCount(null), siteSearchCount({ mcp: 9, a2a: 9, ai: 9 })], [0, 0], "(AC4) the AI channels never count");
    const ctx: Record<string, unknown> = {};
    vm.runInNewContext(dashFn("siteSearchesOf"), ctx);
    const siteSearchesOf = ctx.siteSearchesOf as (s: unknown) => number | null;
    assertEq(siteSearchesOf({ totalQueries: 28, searchesByChannel: ch }), 5, "(AC4) dashboard helper: web + api from the channels");
    assertEq(siteSearchesOf({ totalQueries: 28, siteSearches: 4, searchesByChannel: ch }), 4, "(AC4) dashboard helper: the server's siteSearches first");
    assertEq(siteSearchesOf({ totalQueries: 28 }), null, "(AC4) dashboard helper: never falls back to totalQueries");
    const stats = dashFn("renderStats");
    assertTrue(stats.includes("siteSearchesOf(s)") && !/statQueries"\)\.textContent = fmtNum\(s\.totalQueries/.test(stats), "(AC4) the Søk card reads siteSearchesOf, not totalQueries");
    assertTrue(!/AI-assistenter " \+ fmtNum\(\(ch\.mcp/.test(stats), "(AC4) the Søk card's subtitle no longer lists the AI channels");

    // Server side: summary + stored history rows.
    const initMod = require("../database/init") as typeof import("../database/init");
    const db = new Database(":memory:");
    initMod.__initSchemaForTesting(db as any);
    const nowMs = Date.UTC(2026, 9, 26, 12, 0, 0);
    const insQ = db.prepare("INSERT INTO analytics_queries (query, protocol, vertical_id, is_owner, created_at) VALUES (?, ?, 'rfb', 0, ?)");
    const t = sqlTs(nowMs - 3600_000);
    insQ.run("honning", "web", t); insQ.run("ost", "web", t); insQ.run("egg", "api", t); insQ.run("lam", "mcp", t); insQ.run("fisk", "a2a", t);
    const { computeAdminSummary } = require("./admin-stats-compute") as typeof import("./admin-stats-compute");
    const s = computeAdminSummary(db, 24, "rfb", nowMs);
    assertEq(s.siteSearches, siteSearchCount(s.searchesByChannel), "(AC4) summary.siteSearches = siteSearchCount(byChannel)");
    assertTrue((s.siteSearches ?? -1) === 3 && s.totalQueries === 5, `(AC4) summary: 3 site searches, mcp/a2a left out (total ${s.totalQueries}, site ${s.siteSearches})`);

    const { computeHistoryView, addDays } = require("./traffic-history-compute") as typeof import("./traffic-history-compute");
    const day = "2026-10-20";
    const zero = { views: 0, visits: 0, visitors: 0 };
    const summary = {
      period: "month", start: "2026-10-01", end: "2026-11-01", vertical: "rfb", version: 5, partialFrom: null,
      totals: { views: 100, visits: 10, visitors: 5 },
      groups: { human: { views: 40, visits: 10, visitors: 5 }, ai_search: { views: 7, visits: 1, visitors: 1 }, ai_crawler: { views: 30, visits: 1, visitors: 1 }, bot: { views: 23, visits: 1, visitors: 1 }, dev: zero },
      classes: {}, aiVendors: { chatgpt: 0, claude: 0, other: 0 }, aiAgents: {}, owner: { views: 0, cookieViews: 0, scriptViews: 0, unknownViews: 0 },
      human: { devices: {}, entrySources: [], referrers: [], visitSeconds: 0, singleViewVisits: 0 },
      topPages: [], bots: [],
      searches: { total: 26, byChannel: { web: 3, api: 2, mcp: 5, a2a: 7, ai: 9 }, botQueries: 0, ownerQueries: 0, topTerms: [] },
      aiLookups: { mcp: 4, a2a: 1, total: 5 },
    };
    const ins = db.prepare("INSERT INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary) VALUES (?, ?, ?, 'rfb', 5, NULL, ?)");
    ins.run("month", "2026-10-01", "2026-11-01", JSON.stringify(summary));
    ins.run("day", day, addDays(day, 1), JSON.stringify({ ...summary, period: "day", start: day, end: addDays(day, 1),
      topPages: [{ path: "/", views: 10, humanViews: 4, aiViews: 5, aiSearchViews: 2, aiCrawlerViews: 3, botViews: 1, visitors: 1, humanVisitors: 1 }] }));
    ins.run("day", "2026-10-19", day, JSON.stringify({ ...summary, period: "day", start: "2026-10-19", end: day, aiLookups: null,
      topPages: [{ path: "/old", views: 3, humanViews: 1, aiViews: 2, botViews: 0, visitors: 1, humanVisitors: 1 }] }));
    const view = computeHistoryView(db, 30, "rfb", nowMs);
    const m = view.months.find((r) => r.start === "2026-10-01");
    assertEq(m && [m.siteSearches, m.searches, m.aiSearchViews, m.aiLookups, m.aiSearch, m.aiCrawlerViews], [5, 26, 7, 5, 12, 30],
      "(AC4/AC3) month row: siteSearches = web + api; AI-søk = pages + lookups; AI-crawlere apart");
    assertEq(view.siteSearches, 10, "(AC4) history window: site searches over the stored days (2 × 5)");
    assertEq(view.aiLookups, { total: 5, daysWithData: 1, firstDay: day }, "(AC3) history window: lookups only from days that stored them");
    const root = view.approximate.topPages.find((p) => p.path === "/");
    const old = view.approximate.topPages.find((p) => p.path === "/old");
    assertEq(root && [root.aiSearchViews, root.aiCrawlerViews, root.aiViews], [2, 3, 5], "(AC3) history top pages: split summed");
    assertEq(old && [old.aiSearchViews, old.aiCrawlerViews], [null, null], "(AC3) history top pages: a day without the split leaves it unknown, never a guess");

    // Raw report: per-page and per-umbrella split adds up to the old sum.
    const insPv = db.prepare("INSERT INTO analytics_page_views (path, session_id, is_owner, vertical_id, created_at, status_code) VALUES (?, ?, 0, 'rfb', ?, 200)");
    insPv.run("/produsent/homme-gard", `a:${CHATGPT_USER}`, sqlTs(nowMs - 600_000));
    insPv.run("/produsent/homme-gard", `b:${GPTBOT}`, sqlTs(nowMs - 500_000));
    insPv.run("/produsent/homme-gard", `c:${GPTBOT}`, sqlTs(nowMs - 400_000));
    insPv.run("/produsent/homme-gard", `d:${CHROME}`, sqlTs(nowMs - 300_000));
    const { computeTrafficReport } = require("./traffic-report") as typeof import("./traffic-report");
    const rep = computeTrafficReport(db, 24, "rfb", nowMs);
    const pg = rep.topPages.find((p) => p.path === "/produsent/homme-gard");
    assertEq(pg && [pg.aiSearchViews, pg.aiCrawlerViews, pg.aiViews], [1, 2, 3], "(AC3) traffic report top pages: ai_search and ai_crawler apart, sum unchanged");
    db.prepare("INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type, is_active) VALUES ('u1', 'Homme Gård', 'x', 'x', 'x@example.test', 'https://example.test', 'producer', 'k-u1', 'market_network', 1)").run();
    const { computeUmbrellaTraffic } = require("./admin-stats-compute") as typeof import("./admin-stats-compute");
    const u = computeUmbrellaTraffic(db, 24, nowMs)[0];
    assertEq(u && [u.ai_search_pageviews, u.ai_crawler_pageviews, u.ai_bot_pageviews], [1, 2, 3], "(AC3) markedsnettverk: ai_search and ai_crawler apart, ai_bot_pageviews unchanged");
    db.close();
  }

  // ── (AC5) «Alle» is not a sum ─────────────────────────────────────────
  {
    const stats = dashFn("renderStats");
    assertTrue((html.match(/data-all-note/g) || []).length >= 3, "(AC5) note slots under Besøkende and Besøk");
    assertTrue(stats.includes('VERTICAL === "all" ? "unike på tvers av nettstedene, ikke summen av dem"'), "(AC5) the note is shown for «Alle» only");
    const visitorsCard = html.slice(html.indexOf('id="statVisitorsCard"'), html.indexOf('id="statHumanViews"'));
    assertEq((visitorsCard.match(/data-all-note/g) || []).length, 2, "(AC5) one note under Besøkende, one under Besøk");
  }

  // ── (AC2) admin and the strip: one source ─────────────────────────────
  {
    assertTrue(/router\.get\("\/year"[\s\S]{0,700}adminTrafficYearBody\(vertical, getTrafficStatsSnapshot\(vertical\)\)/.test(analyticsSrc),
      "(AC2) GET /admin/analytics/year reads getTrafficStatsSnapshot(vertical) through adminTrafficYearBody");
    const yearSrc = fs.readFileSync(path.join(root, "src/services/traffic-year-compute.ts"), "utf8");
    assertTrue(/export function adminTrafficYearBody[\s\S]{0,900}year: publicTrafficYearBlock\(/.test(yearSrc), "(AC2) …and builds the block with publicTrafficYearBlock, like /api/traffic-stats");
    const seoSrc = fs.readFileSync(path.join(root, "src/routes/seo.ts"), "utf8");
    assertTrue(seoSrc.includes('getTrafficStatsSnapshot("rfb")') && seoSrc.includes("year: publicTrafficYearBlock(s.year)"), "(AC2) /api/traffic-stats (rfb) reads the same snapshot and block function");
    const apply = dashFn("applyYearCards");
    for (const k of ["humanVisits", "humanViews", "aiSearch", "aiCrawlerViews", "aiDeliveries"]) {
      assertTrue(apply.includes(`y.${k}.value`), `(AC2) dashboard: card from year.${k}`);
    }
    assertTrue(apply.includes("oppdatert kl. ") && apply.includes("body.computedAt"), "(AC2) dashboard: «oppdatert kl. HH:MM» from the snapshot's compute time");
    assertTrue(script.includes('api("/year")') && dashFn("isYearMode").includes('VERTICAL !== "all" && daysParam === "365"'), "(AC2) dashboard: one site + «Siste år» reads /year");
    assertTrue(/<option value="8760">Siste år<\/option>/.test(html), "(AC2) «Siste år» is 8760 h = 365 days");

    const prevDb = (require("../database/init") as typeof import("../database/init")).__peekDbForTesting();
    const prevKey = process.env.ADMIN_KEY;
    const prevCountingSince = process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE;
    const prevPruneDays = process.env.RFB_AUTO_PRUNE_DAYS;
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevExpPath = process.env.EXPERIENCES_DB_PATH;
    const prevLog = console.log;
    const cachePaths = ["../database/db-factory", "./traffic-stats", "../routes/seo", "../routes/analytics"].map((p) => require.resolve(p));
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const initMod = require("../database/init") as typeof import("../database/init");
    try {
      if (!log) console.log = () => { /* silence registry chatter */ };
      delete process.env.RFB_AUTO_PRUNE_DAYS;
      process.env.ADMIN_KEY = "test-admin-key";
      process.env.DENTAL_DB_PATH = ":memory:";
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      const { addDays, dayOf } = require("./traffic-history-compute") as typeof import("./traffic-history-compute");
      const year = require("./traffic-year-compute") as typeof import("./traffic-year-compute");
      const nowMs = Date.now();
      const today = dayOf(nowMs);
      const histFrom = addDays(today, -40);
      const lookupFrom = addDays(today, -25);
      process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE = addDays(today, -3);

      const mainDb = new Database(":memory:");
      mainDb.pragma("journal_mode = DELETE");
      mainDb.pragma("foreign_keys = OFF");
      initMod.__setDbForTesting(mainDb as any);
      initMod.__initSchemaForTesting(mainDb as any);
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
      const insDay = mainDb.prepare("INSERT INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary) VALUES ('day', ?, ?, ?, 5, NULL, ?)");
      const dayRow = (vertical: string, d: string, k: number, lookups?: number) => insDay.run(d, addDays(d, 1), vertical, JSON.stringify({
        period: "day", start: d, end: addDays(d, 1), vertical, version: 5, partialFrom: null,
        totals: { views: 100 * k, visits: 10 * k, visitors: 1 },
        groups: { human: { views: 50 * k, visits: 9 * k, visitors: 1 }, ai_search: { views: 6 * k, visits: 0, visitors: 0 }, ai_crawler: { views: 30 * k, visits: 0, visitors: 0 }, bot: { views: 14 * k, visits: 0, visitors: 0 }, dev: { views: 0, visits: 0, visitors: 0 } },
        ...(lookups === undefined ? {} : { aiLookups: { mcp: lookups, a2a: 0, total: lookups } }),
      }));
      for (const v of ["rfb", "dental"]) {
        dayRow(v, histFrom, v === "rfb" ? 3 : 1);
        dayRow(v, lookupFrom, v === "rfb" ? 2 : 1, 17);
        mainDb.prepare("INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count) VALUES (?, 'p-1', ?, 'mcp', 'claude', ?)").run(v, today, v === "rfb" ? 4 : 2);
      }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("dental");
      dbFactory.getDb("experiences");
      const trafficStats = require("./traffic-stats") as typeof import("./traffic-stats");
      trafficStats.__resetTrafficStatsCacheForTesting();

      function invoke(router: any, url: string, opts2: { hostname?: string; adminKey?: string } = {}): Promise<{ status: number; body: string }> {
        return new Promise((resolve) => {
          const headers: Record<string, string> = { "user-agent": CHROME };
          if (opts2.adminKey) headers["x-admin-key"] = opts2.adminKey;
          const [p, qs] = url.split("?");
          const query: Record<string, string> = {};
          for (const [k, v] of new URLSearchParams(qs || "")) query[k] = v;
          const req: any = {
            method: "GET", url, originalUrl: url, path: p, hostname: opts2.hostname ?? "example.test",
            query, params: {}, headers, lang: "no", ip: "203.0.113.7",
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

      const analytics = (require("../routes/analytics") as typeof import("../routes/analytics")).default as any;
      const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
      const key = "test-admin-key";

      const pub = JSON.parse((await invoke(seoRouter, "/api/traffic-stats")).body);
      const adm = await invoke(analytics, "/year?vertical=rfb", { adminKey: key });
      const a = JSON.parse(adm.body);
      assertEq(adm.status, 200, "(AC2) GET /year?vertical=rfb → 200");
      assertTrue(pub.ready === true && a.ready === true && pub.year !== null, "(AC2) both answers are real (sync path in tests)");
      assertEq(a.year, pub.year, "(AC2) admin's block is the /api/traffic-stats block, number for number and date for date");
      const snap = trafficStats.getTrafficStatsSnapshot("rfb");
      assertEq(a.computedAt, snap.computedAt ? new Date(snap.computedAt).toISOString() : "missing", "(AC2) computedAt is the shared snapshot's compute time");
      assertEq(a.year, year.publicTrafficYearBlock(snap.stats.year), "(AC2) …which is publicTrafficYearBlock of the cached snapshot");
      assertEq([a.year.humanVisits.value, a.year.humanVisits.since, a.year.aiSearch.value, a.year.aiSearch.since, a.year.aiDeliveries.value],
        [9 * 3 + 9 * 2, histFrom, (6 * 2) + 17, lookupFrom, 4], "(AC2) the values are the stored-day sums");

      // The strip on rettfrabonden.com shows the same five values.
      const home = await invoke(seoRouter, "/");
      const a0 = home.body.indexOf('class="proof-bar"');
      const stripHtml = a0 >= 0 ? home.body.slice(a0, home.body.indexOf('class="network-strip"', a0)) : "";
      const vals = [...stripHtml.matchAll(/class="proof-val[^"]*">([^<]+)</g)].map((m) => m[1]);
      const keys = ["humanVisits", "humanViews", "aiSearch", "aiCrawlerViews", "aiDeliveries"] as const;
      assertEq(vals, keys.map((k) => (a.year[k].value as number).toLocaleString("nb-NO")), "(AC2) the five strip numbers equal admin's five cards");
      const periods = [...stripHtml.matchAll(/class="proof-period">([^<]+)</g)].map((m) => m[1]);
      const ctx: Record<string, unknown> = {};
      vm.runInNewContext(dashFn("yearPeriodLabel"), ctx);
      const dashLabel = ctx.yearPeriodLabel as (s: string | null) => string;
      assertEq(keys.map((k) => dashLabel(a.year[k].since)), periods, "(AC2) admin's period labels equal the strip's («siste 12 måneder» / «siden <dato>»)");
      assertEq([dashLabel(null), year.trafficYearPeriodLabel(null, "nb")], ["siste 12 måneder", "siste 12 måneder"], "(AC2) full window: same wording");

      // dental: its own snapshot, the same way.
      const dAdm = JSON.parse((await invoke(analytics, "/year?vertical=dental", { adminKey: key })).body);
      assertEq(dAdm.year, year.publicTrafficYearBlock(trafficStats.getTrafficStatsSnapshot("dental").stats.year), "(AC2) dental: the dental snapshot's block");
      assertTrue(dAdm.year.humanVisits.value === 18 && dAdm.year.aiDeliveries.value === 2, "(AC2) dental numbers are dental's, not rfb's");

      // One site only; host lock; auth.
      assertEq((await invoke(analytics, "/year", { adminKey: key })).status, 400, "(AC2) /year without a site → 400 (the strips are per site)");
      const locked = JSON.parse((await invoke(analytics, "/year?vertical=rfb", { adminKey: key, hostname: "finn-tannlege.com" })).body);
      assertEq(locked.vertical, "dental", "(AC2) host lock: finn-tannlege.com always gets dental");
      assertEq((await invoke(analytics, "/year?vertical=rfb")).status, 401, "(AC2) /year needs the admin key");

      // Not ready → no numbers, never zeros.
      assertEq(year.adminTrafficYearBody("rfb", { stats: { year: snap.stats.year }, ready: false }), { vertical: "rfb", ready: false, computedAt: null, year: null },
        "(AC2) a snapshot that is not ready gives year: null (the dashboard keeps the history numbers and says so)");

      // «Med i AI-søk» card: /ai-deliveries?days=
      const dl = JSON.parse((await invoke(analytics, "/ai-deliveries?vertical=rfb&limit=1&days=365", { adminKey: key })).body);
      assertEq([dl.windowDays, dl.window.total], [365, 4], "(card) /ai-deliveries?days=365 → the chosen window");
      const dl60 = JSON.parse((await invoke(analytics, "/ai-deliveries?vertical=rfb", { adminKey: key })).body);
      assertEq(dl60.windowDays, 60, "(card) /ai-deliveries default window unchanged (60)");
    } finally {
      console.log = prevLog;
      initMod.__setDbForTesting(prevDb as any);
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("ADMIN_KEY", prevKey);
      restore("PROFILE_AI_DELIVERIES_COUNTING_SINCE", prevCountingSince);
      restore("RFB_AUTO_PRUNE_DAYS", prevPruneDays);
      restore("DENTAL_DB_PATH", prevDentalPath);
      restore("EXPERIENCES_DB_PATH", prevExpPath);
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best effort */ }
      restoreModuleCache();
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminYearSameNumbersTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
