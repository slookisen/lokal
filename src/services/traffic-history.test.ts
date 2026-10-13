/**
 * traffic-history.test.ts — dev-request 2026-10-13-statistikk-riktig-for-investorer, S3.
 *
 * Covers:
 *   (a) calendar helpers: ISO weeks, months, period ends;
 *   (b) planHistoryItems: every finished day from the first complete raw day,
 *       finished weeks and months, partial periods, version bumps, the prune's
 *       delete-pending marker;
 *   (c) computeHistorySummary: equals the fixed-range traffic report; exact
 *       unique visitors per month; searches per channel; nothing that
 *       identifies a person is stored;
 *   (d) runTrafficHistoryJob + writeHistorySummary: fills the gaps once, a
 *       failed item does not stop the rest;
 *   (e) computeHistoryView: sums, zero-filled series with missing days, the
 *       month table with the current month so far, average monthly visitors
 *       over whole months only, merged lists;
 *   (f) the nightly prune: no raw day is deleted without its day summaries,
 *       and a summary that cannot be computed stops the prune before that day.
 *
 * Exported runTrafficHistoryTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/traffic-history.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import {
  addDays,
  computeHistorySummary,
  computeHistoryView,
  firstCompleteRawDay,
  monthStartOf,
  nextMonthStart,
  periodEnd,
  planHistoryItems,
  TRAFFIC_HISTORY_VERSION,
  weekStartOf,
  type HistoryItem,
} from "./traffic-history-compute";
import {
  ensureTrafficHistoryForDaySync,
  readStoredHistoryRows,
  runTrafficHistoryJob,
  writeHistorySummary,
} from "./traffic-history";
import { computeTrafficReport } from "./traffic-report";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

const D = 86_400_000;
const H = 3600_000;
const M = 60_000;

function quiet<T>(fn: () => T): T {
  const prev = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = prev; }
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  quiet(() => initMod.__initSchemaForTesting(db as any));
  return db;
}

function seeder(db: Database.Database) {
  const pv = db.prepare(`
    INSERT INTO analytics_page_views (path, referrer, session_id, is_owner, status_code, vertical_id, created_at, client_class)
    VALUES (?, ?, ?, 0, 200, ?, ?, NULL)
  `);
  const q = db.prepare(`
    INSERT INTO analytics_queries (query, protocol, is_owner, vertical_id, created_at, client_class)
    VALUES (?, ?, 0, ?, ?, ?)
  `);
  const mcp = db.prepare(`
    INSERT INTO analytics_mcp_calls (protocol, vertical_id, tool_name, is_owner, created_at)
    VALUES (?, ?, ?, 0, ?)
  `);
  return {
    view: (sid: string, atMs: number, path = "/", vertical = "rfb", referrer: string | null = null) => pv.run(path, referrer, sid, vertical, ts(atMs)),
    search: (query: string, protocol: string, atMs: number, vertical = "rfb", cls: string | null = "human") => q.run(query, protocol, vertical, ts(atMs), cls),
    tool: (tool: string, atMs: number, vertical = "rfb", protocol = "mcp") => mcp.run(protocol, vertical, tool, ts(atMs)),
  };
}

export async function runTrafficHistoryTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── (a) Calendar ───────────────────────────────────────────────────
  ok(weekStartOf("2026-10-13") === "2026-10-12" && weekStartOf("2026-10-12") === "2026-10-12" && weekStartOf("2026-10-18") === "2026-10-12" &&
     weekStartOf("2026-10-19") === "2026-10-19", "a1: ISO weeks start on Monday (UTC)");
  ok(monthStartOf("2026-02-17") === "2026-02-01" && nextMonthStart("2026-12-05") === "2027-01-01" &&
     periodEnd("month", "2026-02-01") === "2026-03-01" && periodEnd("week", "2026-10-12") === "2026-10-19" &&
     periodEnd("day", "2026-12-31") === "2027-01-01" && addDays("2026-03-28", 2) === "2026-03-30",
    "a2: month and period ends across year and DST boundaries");

  // ── (b)–(e) on one seeded month and a half ─────────────────────────
  // now = Tue 2026-10-13 12:00 UTC. Raw rows from Mon 2026-08-31 (a partial
  // August, a whole September, October so far).
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const day0 = Date.UTC(2026, 7, 31);
  {
    const db = freshDb();
    const s = seeder(db);
    // Person A on rettfrabonden: every day from Aug 31 to Oct 12, two pages 5 minutes apart.
    for (let t = day0; t < Date.UTC(2026, 9, 13); t += D) {
      s.view("ipA:desktop:aaaa", t + 10 * H, "/", "rfb", t === day0 ? "https://www.google.com/" : null);
      s.view("ipA:desktop:aaaa", t + 10 * H + 5 * M, "/sok");
    }
    // Person B on finn-tannlege: Sep 3, Sep 10 and Sep 17 (one page each).
    for (const d of [3, 10, 17]) s.view("ipB:mobile:bbbb", Date.UTC(2026, 8, d, 9), "/", "dental");
    // GPTBot on Sep 5: 3 pages.
    for (let i = 0; i < 3; i++) s.view("ipG:Mozilla/5.0 (compatible; GPTBot/1.2)", Date.UTC(2026, 8, 5, 8) + i * M, `/produsent/p${i}`);
    // Searches on Sep 3: two web searches by people, one by Googlebot, two MCP tool searches, one non-search tool.
    s.search("honning", "web", Date.UTC(2026, 8, 3, 9));
    s.search("honning", "web", Date.UTC(2026, 8, 3, 10));
    s.search("egg", "web", Date.UTC(2026, 8, 3, 11), "rfb", "search_engine");
    s.tool("lokal_search", Date.UTC(2026, 8, 3, 12));
    s.tool("lokal_discover", Date.UTC(2026, 8, 3, 13));
    s.tool("lokal_info", Date.UTC(2026, 8, 3, 14));

    ok(firstCompleteRawDay(db as any) === "2026-08-31", "b1: the first complete raw day is the oldest stored day");
    db.exec("INSERT INTO boot_job_state (job, last_completed_at) VALUES ('retention-rolled-delete-pending:analytics_page_views', '2026-08-31|2026-09-01')");
    ok(firstCompleteRawDay(db as any) === "2026-09-01", "b2: while the prune is part-way through deleting the oldest day, the next day is the first complete one");
    db.exec("DELETE FROM boot_job_state");

    const plan = planHistoryItems(db as any, [], now);
    const count = (p: string) => plan.filter((i) => i.period === p).length;
    // Days Aug 31 … Oct 12 = 43, weeks Aug 31 … Oct 5 = 6, months Aug + Sep = 2; × 4 sites.
    ok(count("day") === 43 * 4 && count("week") === 6 * 4 && count("month") === 2 * 4,
      "b3: every finished day, ISO week and month for the four sites; not today, this week or this month", { day: count("day"), week: count("week"), month: count("month") });
    ok(plan[0].period === "month" && plan[0].start === "2026-08-01" && plan.findIndex((i) => i.period === "day" && i.start === "2026-08-31") < plan.findIndex((i) => i.period === "day" && i.start === "2026-09-01"),
      "b4: oldest first (the next to be pruned)", plan.slice(0, 5));

    // ── (c) one summary
    const dayItem: HistoryItem = { period: "day", start: "2026-09-05", end: "2026-09-06", vertical: "all" };
    const sum = computeHistorySummary(db as any, dayItem, now);
    const rep = computeTrafficReport(db as any, 24, undefined, now, { fromMs: Date.UTC(2026, 8, 5), toMs: Date.UTC(2026, 8, 6) });
    ok(eq(sum.totals, rep.totals) && eq(sum.groups, rep.groups) && sum.totals.views === 5 && sum.groups.ai_crawler.views === 3 && sum.partialFrom === null,
      "c1: a day summary is the fixed-range report of that UTC day", { sum: sum.totals, rep: rep.totals });
    const sep = computeHistorySummary(db as any, { period: "month", start: "2026-09-01", end: "2026-10-01", vertical: "all" }, now);
    ok(sep.groups.human.visitors === 2 && sep.groups.human.visits === 30 + 3 && sep.groups.human.views === 60 + 3,
      "c2: a month counts each person once (A every day, B three days = 2 visitors), visits and views in full", sep.groups.human);
    const aug = computeHistorySummary(db as any, { period: "month", start: "2026-08-01", end: "2026-09-01", vertical: "all" }, now);
    ok(aug.partialFrom === "2026-08-31" && aug.groups.human.views === 2, "c3: a month whose first days were pruned covers what is stored and says from when", { partialFrom: aug.partialFrom, human: aug.groups.human });
    const sepRfb = computeHistorySummary(db as any, { period: "month", start: "2026-09-01", end: "2026-10-01", vertical: "rfb" }, now);
    ok(eq(sepRfb.searches.byChannel, { web: 2, api: 0, mcp: 2, a2a: 0, ai: 0 }) && sepRfb.searches.total === 4 && sepRfb.searches.botQueries === 1 &&
       eq(sepRfb.searches.topTerms, [{ query: "honning", count: 2 }]),
      "c4: searches per channel (MCP search tools only, the robot's search kept apart), top terms", sepRfb.searches);
    const json = JSON.stringify(sep);
    ok(!/ipA|ipB|ipG|aaaa|bbbb|GPTBot\/1\.2|google\.com\//.test(json) && /"host":"google\.com"/.test(JSON.stringify(aug)),
      "c5: no session id, IP hash, user agent or full referrer URL is stored (referrer hosts only)");
    let threw = false;
    try { computeHistorySummary(db as any, { period: "day", start: "2026-08-20", end: "2026-08-21", vertical: "all" }, now); } catch { threw = true; }
    ok(threw, "c6: a period with no stored raw day throws instead of storing zeros");

    // ── (d) the job
    const first = await runTrafficHistoryJob({ db: db as any, nowMs: now, compute: async (item, n) => computeHistorySummary(db as any, item, n) });
    const rows = readStoredHistoryRows(db as any);
    ok(first.planned === 204 && first.computed === 204 && first.failed === 0 && rows.length === 204,
      "d1: one run stores every planned summary", first);
    const again = await runTrafficHistoryJob({ db: db as any, nowMs: now });
    ok(again.planned === 0, "d2: a second run finds nothing to do", again);
    db.prepare("UPDATE traffic_history SET version = ? WHERE period = 'month'").run(TRAFFIC_HISTORY_VERSION - 1);
    const redo = planHistoryItems(db as any, readStoredHistoryRows(db as any), now);
    ok(redo.length === 4 && redo.every((i) => i.period === "month" && i.start === "2026-09-01"),
      "d3: a row of an older version is redone only while the raw rows cover the whole period (September, not the partial August)", redo);
    db.prepare("UPDATE traffic_history SET version = ?").run(TRAFFIC_HISTORY_VERSION);
    db.exec("DELETE FROM traffic_history WHERE period = 'day' AND period_start IN ('2026-09-07', '2026-09-08')");
    let calls = 0;
    const partial = await runTrafficHistoryJob({
      db: db as any, nowMs: now,
      compute: async (item, n) => {
        calls += 1;
        if (item.start === "2026-09-07" && item.vertical === "dental") throw new Error("boom");
        return computeHistorySummary(db as any, item, n);
      },
    });
    ok(partial.planned === 8 && partial.computed === 7 && partial.failed === 1 && calls === 8 && /boom/.test(partial.errors[0]),
      "d4: a failed summary is reported and the rest are still stored", partial);
    await runTrafficHistoryJob({ db: db as any, nowMs: now });

    // ── (e) the dashboard's view
    const v = computeHistoryView(db as any, null, "all", now);
    ok(v.coverage.firstDay === "2026-08-31" && v.coverage.lastDay === "2026-10-12" && v.coverage.daysWithData === 43 && v.coverage.missingDays.length === 0 &&
       v.series.points.length === 43 && v.series.points[0].t === "2026-08-31",
      "e1: 'all' = every stored day up to yesterday, one point per day", v.coverage);
    ok(v.totals.views === 43 * 2 + 3 + 3 && v.groups.human.views === 89 && v.groups.human.visits === 46 && v.groups.ai_crawler.views === 3,
      "e2: views and visits add up over the days", { totals: v.totals, human: v.groups.human });
    ok(v.searches.total === 4 && v.searches.byChannel.web === 2 && v.approximate.topTerms[0]?.query === "honning",
      "e3: searches add up over the days", v.searches);
    const months = v.months.map((m) => [m.start, m.humanVisitors, m.partialFrom, m.inProgress]);
    ok(eq(months, [["2026-08-01", 1, "2026-08-31", false], ["2026-09-01", 2, null, false], ["2026-10-01", 1, null, true]]),
      "e4: month table: partial August, whole September, October so far (live)", months);
    ok(v.monthlyHumanVisitors?.average === 2 && eq(v.monthlyHumanVisitors?.months, ["2026-09"]),
      "e5: average monthly unique people over whole months only", v.monthlyHumanVisitors);
    ok(v.weeks.length === 7 && v.weeks[v.weeks.length - 1].inProgress && v.weeks[v.weeks.length - 1].start === "2026-10-12",
      "e6: week table ends with this week so far", v.weeks.map((w) => w.start));
    ok(v.approximate.topPages[0]?.path === "/" && v.approximate.topPages[0]?.views === 46 && v.human.entrySources.some((e) => e.key === "google"),
      "e7: top pages and entry sources merged from the days", { pages: v.approximate.topPages.slice(0, 2), src: v.human.entrySources });
    const w30 = computeHistoryView(db as any, 30, "dental", now);
    ok(w30.window.from === "2026-09-13" && w30.totals.views === 1 && w30.groups.human.visits === 1,
      "e8: a 30-day window per site: only Sep 13 – Oct 12, only that site", { window: w30.window, totals: w30.totals });
    db.exec("DELETE FROM traffic_history WHERE period = 'day' AND period_start = '2026-09-20' AND vertical = 'all'");
    const gap = computeHistoryView(db as any, null, "all", now);
    ok(eq(gap.coverage.missingDays, ["2026-09-20"]) && gap.series.points.find((p) => p.t === "2026-09-20")?.views === 0,
      "e9: a missing stored day is listed and shown as zero, not hidden", gap.coverage);
    db.close();
  }

  // ── (f) the nightly prune keeps the history ───────────────────────
  {
    const prevDb = initMod.getDb();
    const db = freshDb();
    try {
      initMod.__setDbForTesting(db as any);
      const s = seeder(db);
      const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
      // Raw rows 70 … 1 days ago; the prune keeps 60 days.
      for (let k = 70; k >= 1; k--) s.view("ipA:desktop:aaaa", today - k * D + 9 * H, "/");
      const { rollupAndPrunePageViews } = require("./retention-service") as typeof import("./retention-service");
      const oldest = ts(today - 70 * D).slice(0, 10);
      const day = ensureTrafficHistoryForDaySync(db as any, oldest);
      ok(day === 4 && ensureTrafficHistoryForDaySync(db as any, oldest) === 0, "f1: the safety net writes a day's four site summaries once");
      const r = quiet(() => rollupAndPrunePageViews(60, 7));
      const stored = (db.prepare("SELECT COUNT(DISTINCT period_start) AS n FROM traffic_history WHERE period = 'day' AND vertical = 'all'").get() as { n: number }).n;
      const rawOldest = (db.prepare("SELECT substr(MIN(created_at), 1, 10) AS d FROM analytics_page_views").get() as { d: string }).d;
      ok(r.rowsDeleted >= 9 && stored === r.rowsDeleted && rawOldest > oldest,
        "f2: every raw day the prune deleted has its day summary", { r, stored, rawOldest });
      const sum = JSON.parse((db.prepare("SELECT summary FROM traffic_history WHERE period = 'day' AND period_start = ? AND vertical = 'rfb'").get(oldest) as { summary: string }).summary);
      ok(sum.groups.human.views === 1 && sum.groups.human.visitors === 1, "f3: the pruned day's numbers survive in the history", sum.groups.human);

      // A summary that cannot be computed stops the prune before that day.
      for (let k = 80; k >= 71; k--) s.view("ipA:desktop:aaaa", today - k * D + 9 * H, "/");
      db.exec("ALTER TABLE analytics_queries RENAME TO analytics_queries_off");
      let err = "";
      try { quiet(() => rollupAndPrunePageViews(60, 7)); } catch (e) { err = String((e as Error).message); }
      const left = (db.prepare("SELECT COUNT(*) AS n FROM analytics_page_views WHERE created_at < ?").get(ts(today - 70 * D)) as { n: number }).n;
      ok(/analytics_queries/.test(err) && left === 10, "f4: when a day's summary fails, the prune stops and nothing of that day is deleted", { err, left });
      db.exec("ALTER TABLE analytics_queries_off RENAME TO analytics_queries");
    } catch (e) {
      ok(false, "f: prune tests threw", (e as Error).stack);
    } finally {
      initMod.__setDbForTesting(prevDb);
      db.close();
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/traffic-history.test.ts`
if (require.main === module) {
  runTrafficHistoryTests({ log: true }).then((summary) => {
    for (const f of summary.failures) console.log(f);
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
