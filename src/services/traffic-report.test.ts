/**
 * traffic-report.test.ts — dev-request 2026-10-13-statistikk-riktig-for-investorer, S1.
 *
 * Covers:
 *   (a) page-view-definition.ts: which paths and statuses are page views, the
 *       write-time rule, and that the SQL form agrees with the JS form.
 *   (b) traffic-report.ts on a hand-built window: groups add up to the
 *       totals; visits split on 30 minutes of inactivity; scanner (probe path
 *       or write-time class), scraper (velocity) and owner (cookie, script,
 *       legacy) handling; static files, redirects and old rows left out;
 *       entry sources and external referrers; zero-filled series; vertical
 *       filter; the totals-only mode.
 *   (c) The analytics middleware stores pages and scanner probes only, with
 *       client_class from the full UA ('dev' for our own scripts).
 *
 * Exported runTrafficReportTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/traffic-report.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as http from "http";
import type { AddressInfo } from "net";
import * as initMod from "../database/init";
import {
  isPagePath,
  isPageViewStatus,
  pageViewSql,
  shouldRecordPageView,
} from "./page-view-definition";
import { computeTrafficReport, TRAFFIC_GROUPS, VISIT_GAP_MS } from "./traffic-report";
import { computeUmbrellaTraffic, summaryFromReport } from "./admin-stats-compute";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OLD_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36";

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runTrafficReportTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── (a) What counts as a page view ─────────────────────────────────
  {
    const pages = ["/", "/sok", "/produsent/hanen", "/selger.html", "/en/", "/a2a-info", "/klinikk/x-y"];
    const notPages = [
      "/favicon.ico", "/sw.js", "/manifest.json", "/robots.txt", "/llms.txt", "/sitemap.xml", "/logo-200.png",
      "/offline.html", "/opplevagent-offline.html", "/OFFLINE.html", "/mcp", "/MCP", "/mcp/sse", "/a2a",
      "/a2a/.well-known/agent-card.json", "/selger.html?agent=abc", "/wp-admin/setup.php", "/.env", "noslash", "",
    ];
    ok(pages.every(isPagePath), "a1: pages are pages", pages.filter((p) => !isPagePath(p)));
    ok(notPages.every((p) => !isPagePath(p)), "a2: files, the offline page, /mcp, /a2a and probes are not pages", notPages.filter(isPagePath));
    ok([200, 204, 304, null, undefined].every((s) => isPageViewStatus(s as any)) &&
       [301, 302, 404, 500].every((s) => !isPageViewStatus(s)),
      "a3: 2xx and 304 are views (missing status = legacy row), redirects and errors are not");
    ok(shouldRecordPageView("/", 200, "text/html; charset=utf-8") &&
       shouldRecordPageView("/", 200, "text/markdown; charset=utf-8") &&
       shouldRecordPageView("/sok", 304, undefined) &&
       shouldRecordPageView("/produsent/x", 302, "text/html") &&
       shouldRecordPageView("/produsent/x", 301, "text/plain; charset=utf-8") &&
       shouldRecordPageView("/finnes-ikke", 404, "application/json") &&
       shouldRecordPageView("/.ENV", 404, "text/plain") &&
       shouldRecordPageView("/wp-admin/x.php", 404, "text/html") &&
       shouldRecordPageView("/.env", 404, "application/json") &&
       !shouldRecordPageView("/", 200, "application/json") &&
       !shouldRecordPageView("/logo.png", 200, "image/png") &&
       !shouldRecordPageView("/offline.html", 200, "text/html") &&
       !shouldRecordPageView("/mcp", 200, "text/html"),
      "a4: the middleware stores pages answered 3xx/4xx/5xx whatever the type, 2xx pages only as documents, and every scanner probe in any case");

    const db = new Database(":memory:");
    db.exec("CREATE TABLE analytics_page_views (path TEXT, status_code INTEGER)");
    const ins = db.prepare("INSERT INTO analytics_page_views VALUES (?, ?)");
    const corpus = [...pages, ...notPages, "/ø/å.png", "/it's", "/x.HTML", "/y.htm", "/z.Htm", "/p/", "/a.b/c"];
    for (const p of corpus) for (const s of [200, 304, 302, 404, null]) ins.run(p, s);
    const rows = db.prepare(`SELECT path, status_code, (${pageViewSql()}) AS ok FROM analytics_page_views`).all() as any[];
    const bad = rows.filter((r) => !!r.ok !== (isPagePath(r.path) && isPageViewStatus(r.status_code)));
    ok(bad.length === 0 && rows.length === corpus.length * 5, "a5: pageViewSql() agrees with isPagePath && isPageViewStatus on every case", bad.slice(0, 5));
    db.close();
  }

  // ── (b) The traffic report ─────────────────────────────────────────
  {
    const db = new Database(":memory:");
    initMod.__initSchemaForTesting(db as any);
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const H = 3600_000;
    const M = 60_000;
    const ins = db.prepare(`
      INSERT INTO analytics_page_views (path, referrer, session_id, is_owner, status_code, vertical_id, created_at, client_class)
      VALUES (@path, @referrer, @sid, @owner, @status, @vertical, @at, @cls)
    `);
    const pv = (sid: string, atMs: number, path = "/", o: { referrer?: string; owner?: number; status?: number; vertical?: string; cls?: string | null } = {}) =>
      ins.run({ path, referrer: o.referrer ?? null, sid, owner: o.owner ?? 0, status: o.status ?? 200, vertical: o.vertical ?? "rfb", at: ts(atMs), cls: o.cls ?? null });

    // Human A (desktop): visit 1 = 3 views over 20 minutes from Google, visit 2 an hour later.
    pv("ipA:desktop:aaaa", now - 5 * H, "/", { referrer: "https://www.google.com/" });
    pv("ipA:desktop:aaaa", now - 5 * H + 10 * M, "/sok");
    pv("ipA:desktop:aaaa", now - 5 * H + 20 * M, "/produsent/hanen");
    pv("ipA:desktop:aaaa", now - 1 * H, "/sok", { referrer: "https://rettfrabonden.com/sok" });
    // Its static files, a redirect and a 404 are not page views.
    pv("ipA:desktop:aaaa", now - 5 * H, "/favicon.ico");
    pv("ipA:desktop:aaaa", now - 5 * H, "/sw.js");
    pv("ipA:desktop:aaaa", now - 5 * H, "/produsent/gammel", { status: 302 });
    pv("ipA:desktop:aaaa", now - 5 * H, "/finnes-ikke", { status: 404 });
    // Human B (mobile), one view from Facebook.
    pv("ipB:mobile:bbbb", now - 2 * H, "/", { referrer: "https://m.facebook.com/" });
    // AI search (2), AI crawlers (GPTBot 3, ClaudeBot 1), a search engine (2).
    pv("ipC:Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0", now - 3 * H, "/");
    pv("ipC:Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0", now - 3 * H + M, "/sok");
    for (let i = 0; i < 3; i++) pv("ipD:Mozilla/5.0 (compatible; GPTBot/1.2)", now - 4 * H + i * M, `/produsent/g${i}`);
    pv("ipE:Mozilla/5.0 (compatible; ClaudeBot/1.0)", now - 4 * H, "/om");
    pv("ipF:Mozilla/5.0 (compatible; Googlebot/2.1)", now - 6 * H, "/");
    pv("ipF:Mozilla/5.0 (compatible; Googlebot/2.1)", now - 6 * H + M, "/om");
    // Scanner by probe path: browser UA, probes wp-admin (404), views "/".
    pv(`ipG:${CHROME}`, now - 7 * H, "/wp-admin/setup.php", { status: 404 });
    pv(`ipG:${CHROME}`, now - 7 * H + M, "/");
    // Scanner by write-time class: a legacy row of the session first, then a classified one.
    pv("ipS:desktop:ssss", now - 8 * H, "/");
    pv("ipS:desktop:ssss", now - 8 * H + M, "/om", { cls: "scanner" });
    // Scraper: a browser reading 70 distinct pages in 5 minutes.
    for (let i = 0; i < 70; i++) pv("ipK:desktop:kkkk", now - 9 * H + Math.floor((i * 5 * M) / 70), `/produsent/s${i}`);
    // Owner: cookie browser, our script, and a legacy row that cannot be told apart.
    pv("ipO:desktop:oooo", now - H, "/", { owner: 1, cls: "human" });
    pv("ipP:desktop:pppp", now - H, "/", { owner: 1, cls: "dev" });
    pv("ipQ:desktop:qqqq", now - H, "/", { owner: 1 });
    // Another vertical, and a row outside the 24-hour window.
    pv("ipZ:desktop:zzzz", now - H, "/", { vertical: "dental" });
    pv("ipY:desktop:yyyy", now - 30 * H, "/");

    const r = computeTrafficReport(db as any, 24, undefined, now);
    const sum = TRAFFIC_GROUPS.reduce((a, g) => ({
      views: a.views + r.groups[g].views, visitors: a.visitors + r.groups[g].visitors, visits: a.visits + r.groups[g].visits,
    }), { views: 0, visitors: 0, visits: 0 });
    ok(eq(sum, r.totals), "b1: the five groups add up to the totals (views, visitors, visits)", { sum, totals: r.totals });
    // "All" sites: 4 + 1 + 1 (dental) human, 2 AI search, 4 AI crawler,
    // 2 search engine, 1 + 2 scanner, 70 scraper.
    ok(r.totals.views === 87 && r.totals.visitors === 10, "b2: totals = 87 page views by 10 visitors (no files, redirects, 404s, owner or old rows)", r.totals);
    ok(eq(r.groups.human, { views: 6, visitors: 3, visits: 4 }), "b3: people: 6 views, 3 visitors, 4 visits (a gap over 30 minutes starts a new visit)", r.groups.human);
    ok(r.classes.ai_search.views === 2 && r.classes.ai_crawler.views === 4 && r.classes.search_engine.views === 2,
      "b4: AI search 2, AI crawlers 4, search engines 2", r.classes);
    ok(eq(r.classes.scanner, { views: 3, visitors: 2, visits: 2 }),
      "b5: scanners: the probing browser (its probe is not a view) and the session classified 'scanner' at write time, legacy row included", r.classes.scanner);
    ok(eq(r.classes.scraper, { views: 70, visitors: 1, visits: 1 }), "b6: 70 pages in 5 minutes from a browser is a scraper, not a person", r.classes.scraper);
    ok(eq(r.aiVendors, { chatgpt: 5, claude: 1, other: 0 }), "b7: AI views by vendor: ChatGPT-User 2 + GPTBot 3, ClaudeBot 1", r.aiVendors);
    ok(eq(r.aiAgents.chatgpt, { user: 2, search: 0, training: 3 }) && eq(r.aiAgents.claude, { user: 0, search: 0, training: 1 }),
      "b7b: aiAgents splits vendor by purpose: ChatGPT-User = user 2, GPTBot = training 3, ClaudeBot = training 1", r.aiAgents);
    ok(r.aiAgents.chatgpt.user + r.aiAgents.chatgpt.search + r.aiAgents.chatgpt.training === r.aiVendors.chatgpt
       && r.aiAgents.claude.user + r.aiAgents.claude.search + r.aiAgents.claude.training === r.aiVendors.claude
       && (["perplexity", "google", "other"] as const).reduce((a, k) => a + r.aiAgents[k].user + r.aiAgents[k].search + r.aiAgents[k].training, 0) === r.aiVendors.other,
      "b7c: the sum of aiAgents equals aiVendors (perplexity + google + other = aiVendors.other)", { aiAgents: r.aiAgents, aiVendors: r.aiVendors });
    const summ = summaryFromReport(r, { totalQueries: 0, topSearchTerms: [], byChannel: {}, botQueries: 0, ownerQueries: 0 } as any);
    ok(eq(summ.aiAgents, r.aiAgents) && eq(summ.agentTraffic, r.aiVendors), "b7d: the summary carries aiAgents next to agentTraffic", summ.aiAgents);
    ok(eq(r.owner, { views: 3, cookieViews: 1, scriptViews: 1, unknownViews: 1 }), "b8: owner traffic split into cookie, script and legacy-unknown, outside every total", r.owner);
    ok(r.human.devices.desktop.visitors === 2 && r.human.devices.mobile.visitors === 1, "b9: human devices from the session's device bucket", r.human.devices);
    const src = Object.fromEntries(r.human.entrySources.map((e) => [e.key, e.visits]));
    ok(eq(src, { direkte: 2, google: 1, sosial: 1 }),
      "b10: entry source of each human visit (a visit 'from' our own page after 30 minutes is direct)", r.human.entrySources);
    ok(eq(r.human.referrers.map((x) => x.host).sort(), ["google.com", "m.facebook.com"]), "b11: external referrer hosts only", r.human.referrers);
    ok(r.human.avgVisitSeconds === 300 && r.human.pagesPerVisit === 1.5 && r.human.bounceRate === 0.75,
      "b12: visit quality: 1200 s over 4 visits, 6/4 pages per visit, 3 of 4 visits single-page", { avg: r.human.avgVisitSeconds, ppv: r.human.pagesPerVisit, bounce: r.human.bounceRate });
    ok(r.topPages.every((p) => !/\.(ico|js|php)$/.test(p.path) && p.path !== "/finnes-ikke" && p.path !== "/produsent/gammel") &&
       r.topPages.every((p) => p.humanViews + p.aiViews + p.botViews === p.views),
      "b13: top pages hold page views only, and each page's split adds up", r.topPages.slice(0, 5));
    ok(r.series.unit === "hour" && r.series.points.length === 25 &&
       r.series.points.reduce((a, p) => a + p.views, 0) === r.totals.views &&
       r.series.points.some((p) => p.views === 0),
      "b14: 24 hours = 25 zero-filled UTC hour buckets that add up to the total", r.series.points.length);
    ok(r.recentSessions[0].lastSeen >= r.recentSessions[r.recentSessions.length - 1].lastSeen &&
       r.recentSessions.find((s) => s.name === "GPTBot")?.cls === "ai_crawler",
      "b15: recent sessions newest first, bots named", r.recentSessions.slice(0, 3));
    ok(r.human.topSessions.length === 3 && r.human.topSessions[0].views === 4 && r.human.topSessions[0].visits === 2 && r.human.topSessions[0].uniquePages === 3,
      "b16: most active people: views, visits and distinct pages", r.human.topSessions);
    ok(r.coverage.complete === true && r.coverage.oldestRow === ts(now - 30 * H), "b17: coverage: the stored rows reach past the window start", r.coverage);

    const dental = computeTrafficReport(db as any, 24, "dental", now);
    ok(dental.totals.views === 1 && dental.groups.human.visitors === 1, "b18: vertical filter", dental.totals);
    const lite = computeTrafficReport(db as any, 24, undefined, now, { detail: false });
    ok(eq(lite.totals, r.totals) && eq(lite.groups, r.groups) && lite.series.points.length === 0 && lite.topPages.length === 0,
      "b19: totals-only mode: same totals, no lists or series");
    const week = computeTrafficReport(db as any, 24 * 30, undefined, now);
    ok(week.series.unit === "day" && week.totals.views === 88 && week.coverage.complete === false,
      "b20: a 30-day window: daily buckets, includes the older row, coverage incomplete", { unit: week.series.unit, views: week.totals.views, coverage: week.coverage });
    ok(VISIT_GAP_MS === 30 * 60_000, "b21: the visit gap is 30 minutes");
    db.close();
  }

  // ── (d) Edges: thresholds, boundaries, ranges, lists ──────────────
  {
    const db = new Database(":memory:");
    initMod.__initSchemaForTesting(db as any);
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const H = 3600_000;
    const M = 60_000;
    const ins = db.prepare(`
      INSERT INTO analytics_page_views (path, session_id, is_owner, status_code, vertical_id, created_at, client_class)
      VALUES (?, ?, 0, ?, 'rfb', ?, ?)
    `);
    const pv = (sid: string, atMs: number, path = "/", status = 200, cls: string | null = null) => ins.run(path, sid, status, ts(atMs), cls);

    // 230 distinct producer pages in 57.5 minutes (one per 15 s): never 60 in
    // 10 minutes, but over 200 in an hour → scraper.
    for (let i = 0; i < 230; i++) pv("ipH:desktop:hhhh", now - 20 * H + i * 15_000, `/produsent/p${i}`);
    // Exactly 30 minutes apart continues a visit; 31 minutes starts a new one.
    pv("ipV:desktop:vvvv", now - 10 * H, "/");
    pv("ipV:desktop:vvvv", now - 10 * H + 30 * M, "/sok");
    pv("ipV:desktop:vvvv", now - 10 * H + 61 * M, "/om");
    // A visit that began before the window: only its in-window views count, as one visit.
    pv("ipW:desktop:wwww", now - 24 * H - 10 * M, "/");
    pv("ipW:desktop:wwww", now - 24 * H + 5 * M, "/sok");
    pv("ipW:desktop:wwww", now - 24 * H + 15 * M, "/om");
    // A legacy row (no class, browser bucket) then a row stored as ai_search: the stored class wins for the whole session.
    pv("ipX:desktop:xxxx", now - 5 * H, "/");
    pv("ipX:desktop:xxxx", now - 5 * H + M, "/sok", 200, "ai_search");
    // A probe in upper case is still a probe; a scanner behind a browser UA has no UA to show.
    pv("ipU:desktop:uuuu", now - 4 * H, "/.ENV", 404);
    pv("ipU:desktop:uuuu", now - 4 * H + M, "/");
    // A named bot keeps its UA.
    pv("ipB:Mozilla/5.0 (compatible; Googlebot/2.1)", now - 3 * H, "/");

    const r = computeTrafficReport(db as any, 24, undefined, now);
    ok(eq(r.classes.scraper, { views: 230, visitors: 1, visits: 1 }), "d1: over 200 producer pages in an hour is a scraper, even at 4 pages a minute", r.classes.scraper);
    const v = r.busiestSessions.find((x) => x.id === "ipV");
    ok(v?.visits === 2 && v?.views === 3, "d2: exactly 30 minutes continues the visit, 31 minutes starts a new one", v);
    const w = r.busiestSessions.find((x) => x.id === "ipW");
    ok(w?.views === 2 && w?.visits === 1, "d3: a visit begun before the window counts only its in-window views, as one visit", w);
    ok(r.classes.ai_search.visitors === 1 && r.classes.ai_search.views === 2, "d4: a stored class overrides the legacy class for the whole session", r.classes.ai_search);
    const scan = r.bots.find((b) => b.cls === "scanner");
    ok(r.classes.scanner.visitors === 1 && scan?.name === "Skanner med nettleser-UA" && scan?.sampleUa === null,
      "d5: an upper-case probe makes a scanner; a scanner behind a browser UA is named as such, with no fake UA", r.bots);
    const g = r.busiestSessions.find((x) => x.name === "Googlebot");
    ok(g?.ua === "Mozilla/5.0 (compatible; Googlebot/2.1)" && r.busiestSessions[0].views === 230 &&
       r.busiestSessions.every((x, i, a) => i === 0 || a[i - 1].views >= x.views),
      "d6: busiest sessions sorted by page views; a named bot carries its UA", r.busiestSessions.slice(0, 3));

    // A fixed range is [from, to): a row at `from` is in, a row at `to` is out.
    pv("ipR:desktop:rrrr", Date.UTC(2026, 9, 12), "/");
    pv("ipR:desktop:rrrr", Date.UTC(2026, 9, 13), "/sok");
    const day = computeTrafficReport(db as any, 24, undefined, now, { fromMs: Date.UTC(2026, 9, 12), toMs: Date.UTC(2026, 9, 13) });
    const rr = day.busiestSessions.find((x) => x.id === "ipR");
    ok(rr?.views === 1 && day.window.hours === 24 && day.window.from === "2026-10-12 00:00:00" && day.window.to === "2026-10-13 00:00:00" &&
       day.series.unit === "hour" && day.series.points.length === 24,
      "d7: a fixed range includes its start and excludes its end; 24 hourly buckets", { rr, window: day.window, n: day.series.points.length });
    // Coverage of a range: complete when its first day is stored (rows are pruned in whole days).
    const first = computeTrafficReport(db as any, 24, undefined, now, { fromMs: Date.UTC(2026, 9, 12), toMs: Date.UTC(2026, 9, 13) });
    ok(first.coverage.oldestRow === "2026-10-12 00:00:00" && first.coverage.complete === true, "d8: a range starting on the oldest stored day is complete", first.coverage);
    const before = computeTrafficReport(db as any, 24, undefined, now, { fromMs: Date.UTC(2026, 9, 11), toMs: Date.UTC(2026, 9, 12) });
    ok(before.coverage.complete === false && before.series.points.length === 24 && before.series.points[0].t === "2026-10-11 00:00",
      "d9: a range before the oldest stored day is not complete, and keeps its own 24 empty hours", { coverage: before.coverage, first: before.series.points[0]?.t });
    // An unparseable referrer is never kept as text (it can carry a path or query).
    db.prepare("INSERT INTO analytics_page_views (path, referrer, session_id, is_owner, status_code, vertical_id, created_at) VALUES ('/', ?, 'ipN:desktop:nnnn', 0, 200, 'rfb', ?)")
      .run("not a url /path?email=a@b.no", ts(now - 2 * H));
    const refs = computeTrafficReport(db as any, 24, undefined, now).human.referrers;
    ok(refs.some((x) => x.host === "ukjent") && !JSON.stringify(refs).includes("email"),
      "d9b: an unparseable referrer is listed as «ukjent», not as its text", refs);
    // "All time" starts its series at the first stored row, not ten years back.
    const all = computeTrafficReport(db as any, 87600, undefined, now);
    ok(all.series.unit === "day" && all.series.points.length === 2 && all.series.points[0].t === "2026-10-12",
      "d10: a window longer than the stored rows starts its series at the first row", all.series.points.map((p) => p.t));
    db.close();
  }

  // ── (d11) The umbrella table classifies its rows the way the report classifies their sessions ──
  {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, umbrella_type TEXT, is_active INTEGER DEFAULT 1);
      CREATE TABLE agent_affiliations (id INTEGER PRIMARY KEY AUTOINCREMENT, producer_id TEXT NOT NULL, umbrella_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE analytics_page_views (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, referrer TEXT, session_id TEXT,
        status_code INTEGER, created_at TEXT, is_owner INTEGER DEFAULT 0, vertical_id TEXT DEFAULT 'rfb', client_class TEXT);
    `);
    db.prepare("INSERT INTO agents VALUES ('U', 'Nett', 'market_network', 1)").run();
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    const H = 3600_000;
    const ins = db.prepare("INSERT INTO analytics_page_views (path, session_id, status_code, created_at, client_class) VALUES ('/produsent/nett', ?, 200, ?, ?)");
    // Sessions spanning the write-time class: two older rows with no class, then one with a non-human class.
    for (const [sid, cls] of [["ipA:desktop:aaaa", "ai_search"], ["ipD:desktop:dddd", "dev"], ["ipS:desktop:ssss", "scanner"]]) {
      ins.run(sid, ts(now - 3 * H), null);
      ins.run(sid, ts(now - 2 * H), null);
      ins.run(sid, ts(now - H), cls);
    }
    // A person, before and after the write-time class.
    ins.run("ipP:desktop:pppp", ts(now - 3 * H), null);
    ins.run("ipP:desktop:pppp", ts(now - H), "human");
    const u = computeUmbrellaTraffic(db as any, 24, now)[0];
    const page = computeTrafficReport(db as any, 24, undefined, now).topPages.find((p) => p.path === "/produsent/nett");
    ok(u?.human_pageviews_profile === 2 && u?.ai_bot_pageviews === 3 && u?.pageViews_via_profile === 11 &&
       u?.human_pageviews_profile === page?.humanViews && u?.ai_bot_pageviews === page?.aiViews,
      "d11: rows from before the write-time class take their session's class, as in the report",
      { umbrella: u && { human: u.human_pageviews_profile, ai: u.ai_bot_pageviews, all: u.pageViews_via_profile }, page });
    db.close();
  }

  // ── (c) The write path ─────────────────────────────────────────────
  {
    const prevDb = initMod.getDb();
    const memDb = new Database(":memory:");
    let server: http.Server | null = null;
    try {
      initMod.__setDbForTesting(memDb as any);
      initMod.__initSchemaForTesting(memDb as any);
      const { analyticsService } = require("./analytics-service") as typeof import("./analytics-service");
      const app = express();
      app.use(analyticsService.middleware());
      app.get("/", (_req, res) => { res.send("<html>side</html>"); });
      app.get("/logo.png", (_req, res) => { res.type("png").send(Buffer.from([0x89, 0x50])); });
      app.get("/data", (_req, res) => { res.json({ a: 1 }); });
      app.get("/wp-admin/setup.php", (_req, res) => { res.status(404).json({ error: "nei" }); });
      app.get("/stale", (_req, res) => { res.status(304).end(); });
      app.get("/produsent/gammel", (_req, res) => { res.redirect(301, "/produsent/ny"); });
      app.get("/.ENV", (_req, res) => { res.status(404).send("nei"); });
      server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const port = (server.address() as AddressInfo).port;
      const get = (p: string, ua: string, extra: Record<string, string> = {}) => new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { "User-Agent": ua, ...extra } }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", () => resolve());
        req.end();
      });
      await get("/", CHROME);
      await get("/logo.png", CHROME);
      await get("/data", CHROME);
      await get("/wp-admin/setup.php", CHROME);
      await get("/stale", CHROME);
      await get("/", "RFB-ContactVerifier/1.0 (+https://rettfrabonden.com)");
      await get("/", OLD_CHROME);
      // Redirects: Express answers text/plain unless the client asks for HTML.
      await get("/produsent/gammel", "Mozilla/5.0 (compatible; Googlebot/2.1)");
      await get("/produsent/gammel", "Mozilla/5.0 (compatible; Googlebot/2.1)", { Accept: "*/*" });
      await get("/produsent/gammel", CHROME, { Accept: "text/html" });
      await get("/.ENV", CHROME);
      await new Promise((r) => setTimeout(r, 50));
      const rows = memDb.prepare("SELECT path, status_code, is_owner, client_class FROM analytics_page_views ORDER BY id").all() as any[];
      ok(eq(rows.slice(0, 5).map((x) => x.path), ["/", "/wp-admin/setup.php", "/stale", "/", "/"]),
        "c1: stored: the page, the scanner probe and the 304; not the image or the JSON", rows.slice(0, 5));
      ok(rows[0]?.client_class === "human" && rows[0]?.is_owner === 0, "c2: a browser is stored as 'human'", rows[0]);
      ok(rows[2]?.status_code === 304, "c3: a 304 page is stored with its status", rows[2]);
      ok(rows[3]?.is_owner === 1 && rows[3]?.client_class === "dev", "c4: our own script: owner, class 'dev' (its UA has no bot marker)", rows[3]);
      ok(rows[4]?.client_class === "scanner", "c5: a fake stale Chrome is stored as 'scanner'", rows[4]);
      const redirects = rows.slice(5, 8);
      ok(redirects.length === 3 && redirects.every((x) => x.path === "/produsent/gammel" && x.status_code === 301),
        "c6: a 301 is stored whatever the client accepts (no Accept, */*, text/html), for producer-outcomes", redirects);
      ok(rows[8]?.path === "/.ENV" && rows.length === 9, "c7: an upper-case probe path is stored", rows.slice(8));
    } catch (e) {
      ok(false, "c: write-path tests threw", (e as Error).stack);
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      initMod.__setDbForTesting(prevDb);
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/traffic-report.test.ts`
if (require.main === module) {
  runTrafficReportTests({ log: true }).then((summary) => {
    for (const f of summary.failures) console.log(f);
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
