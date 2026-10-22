/**
 * statistikk-s0-store-before-prune.test.ts — dev-request
 * 2026-10-22-statistikk-samme-tall-12-mnd, S0 («Lagre før det slettes»).
 *
 * Covers:
 *   (a) traffic_history day, week and month rows carry the AI lookups over
 *       MCP/A2A (computeAiLookups' rule) per site and for "all";
 *   (b) the version bump makes every stored row whose raw days still exist be
 *       recomputed with the lookups (backfill), while rows whose raw days are
 *       already pruned are kept exactly as they were (no zero overwrite);
 *   (c) a range whose raw MCP/A2A calls are not (all) stored gets
 *       aiLookups = null, never 0;
 *   (d) the nightly prune keeps each deleted day's lookups in the history,
 *       and still deletes the raw calls after the window;
 *   (e) rollupAndPruneAgentViews keeps AI-assistant profile views (ai_search)
 *       per profile per day in agent_ai_view_daily, next to the unchanged
 *       human bucket in agent_view_daily, and still deletes the raw rows.
 *
 * Exported runStatistikkS0Tests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/services/statistikk-s0-store-before-prune.test.ts
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import * as initMod from "../database/init";
import {
  computeHistorySummary,
  planHistoryItems,
  TRAFFIC_HISTORY_VERSION,
  type HistorySummary,
} from "./traffic-history-compute";
import { ensureTrafficHistoryForDaySync, readStoredHistoryRows, runTrafficHistoryJob } from "./traffic-history";
import { computeAiLookups } from "./search-stats-compute";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const D = 86_400_000;
const H = 3600_000;

function ts(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

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
    VALUES (?, NULL, ?, 0, 200, ?, ?, NULL)
  `);
  const call = db.prepare(`
    INSERT INTO analytics_mcp_calls (protocol, vertical_id, tool_name, client_name, user_agent, is_owner, status_code, countable, created_at)
    VALUES (?, ?, ?, NULL, 'Mozilla/5.0', ?, ?, ?, ?)
  `);
  const av = db.prepare(`
    INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at, is_owner, traffic_category)
    VALUES (?, ?, 'Oslo', 'seo', ?, ?, ?)
  `);
  return {
    view: (atMs: number, vertical = "rfb") => pv.run("/", "ipA:desktop:aaaa", vertical, ts(atMs)),
    mcp: (tool: string, atMs: number, vertical = "rfb", o: { owner?: number; status?: number } = {}) =>
      call.run("mcp", vertical, tool, o.owner ?? 0, o.status ?? 200, null, ts(atMs)),
    a2a: (method: string, atMs: number, vertical = "rfb", countable = 1) => call.run("a2a", vertical, method, 0, 200, countable, ts(atMs)),
    agentView: (agentId: string, atMs: number, cls: string | null, owner = 0) => av.run(agentId, agentId, ts(atMs), owner, cls),
  };
}

function readRow(db: Database.Database, period: string, start: string, vertical: string): { version: number; summary: string } | undefined {
  return db.prepare("SELECT version, summary FROM traffic_history WHERE period = ? AND period_start = ? AND vertical = ?")
    .get(period, start, vertical) as { version: number; summary: string } | undefined;
}

function lookupsOf(db: Database.Database, period: string, start: string, vertical: string): unknown {
  const r = readRow(db, period, start, vertical);
  if (!r) return "missing-row";
  const s = JSON.parse(r.summary) as HistorySummary;
  return "aiLookups" in s ? s.aiLookups : "absent";
}

export async function runStatistikkS0Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── (a)–(c) on fixed dates ─────────────────────────────────────────
  // now = Thu 2026-10-22 12:00 UTC. Raw page views every day from Tue
  // 2026-09-01 to Oct 21. Raw MCP/A2A calls from Thu 2026-09-03 only (as if
  // their earlier days had already been pruned).
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);
  try {
    const db = freshDb();
    const s = seeder(db);
    for (let t = Date.UTC(2026, 8, 1); t < Date.UTC(2026, 9, 22); t += D) s.view(t + 10 * H);
    const sep3 = Date.UTC(2026, 8, 3);
    // Counted: rfb 2 × lokal_search + lokal_info + a resources/read; dental tannlege_search; experiences one countable A2A request.
    s.mcp("lokal_search", sep3 + 9 * H);
    s.mcp("lokal_search", sep3 + 10 * H);
    s.mcp("lokal_info", sep3 + 11 * H);
    s.mcp("resources/read", sep3 + 11 * H + 30 * 60_000);
    s.mcp("tannlege_search", sep3 + 12 * H, "dental");
    s.a2a("message/send", sep3 + 13 * H, "experiences");
    // Not counted: an action tool, our own call, a 429, an uncountable A2A request, a handshake.
    s.mcp("lokal_cart_create", sep3 + 14 * H);
    s.mcp("lokal_search", sep3 + 15 * H, "rfb", { owner: 1 });
    s.mcp("lokal_search", sep3 + 16 * H, "rfb", { status: 429 });
    s.a2a("message/send", sep3 + 17 * H, "experiences", 0);
    s.mcp("initialize", sep3 + 18 * H);
    // Sep 20 (Sunday, same ISO week as Sep 14): one more rfb lookup.
    s.mcp("lokal_discover", Date.UTC(2026, 8, 20, 9));

    // (a) one summary per period
    const day = (vertical: "all" | "rfb" | "dental" | "experiences") =>
      computeHistorySummary(db as any, { period: "day", start: "2026-09-03", end: "2026-09-04", vertical }, now).aiLookups;
    ok(eq(day("rfb"), { mcp: 4, a2a: 0, total: 4 }) && eq(day("dental"), { mcp: 1, a2a: 0, total: 1 }) &&
       eq(day("experiences"), { mcp: 0, a2a: 1, total: 1 }) && eq(day("all"), { mcp: 5, a2a: 1, total: 6 }),
      "a1: a day row carries the AI lookups per site and for all (MCP data tools + countable A2A; actions, own calls, 4xx and handshakes left out)",
      { rfb: day("rfb"), dental: day("dental"), experiences: day("experiences"), all: day("all") });
    const ref = computeAiLookups(db as any, 0, "rfb", now, { fromMs: sep3, toMs: sep3 + D });
    ok(eq(day("rfb"), ref), "a2: the stored day equals computeAiLookups over that UTC day (one rule, the public AI-søk one)", { stored: day("rfb"), ref });
    const week = computeHistorySummary(db as any, { period: "week", start: "2026-09-14", end: "2026-09-21", vertical: "rfb" }, now).aiLookups;
    // A month whose calls are all stored: a second database with calls from Sep 1.
    const full = freshDb();
    const f = seeder(full);
    for (let t = Date.UTC(2026, 8, 1); t < Date.UTC(2026, 9, 22); t += D) f.view(t + 10 * H);
    f.mcp("lokal_search", Date.UTC(2026, 8, 1, 0, 0, 0));
    f.mcp("tannlege_info", Date.UTC(2026, 8, 15, 12), "dental");
    f.a2a("tasks/send", Date.UTC(2026, 8, 30, 23, 59, 59), "rfb");
    f.mcp("lokal_search", Date.UTC(2026, 9, 1, 0, 0, 0));
    const fullMonth = computeHistorySummary(full as any, { period: "month", start: "2026-09-01", end: "2026-10-01", vertical: "all" }, now).aiLookups;
    const fullMonthRfb = computeHistorySummary(full as any, { period: "month", start: "2026-09-01", end: "2026-10-01", vertical: "rfb" }, now).aiLookups;
    full.close();
    const month = computeHistorySummary(db as any, { period: "month", start: "2026-09-01", end: "2026-10-01", vertical: "all" }, now).aiLookups;
    ok(eq(week, { mcp: 1, a2a: 0, total: 1 }) && eq(fullMonth, { mcp: 2, a2a: 1, total: 3 }) && eq(fullMonthRfb, { mcp: 1, a2a: 1, total: 2 }),
      "a3: week and month rows carry the lookups of the whole period (first to last second, not the next month's)", { week, fullMonth, fullMonthRfb });
    ok(month === null, "a4: a month whose first days' calls are gone is null, not the sum of the days left", month);

    // (c) the calls of Sep 1–2 are not stored (pruned): unknown, never zero.
    const sep1 = computeHistorySummary(db as any, { period: "day", start: "2026-09-01", end: "2026-09-02", vertical: "all" }, now);
    const sep4 = computeHistorySummary(db as any, { period: "day", start: "2026-09-04", end: "2026-09-05", vertical: "all" }, now);
    const weekAug31 = computeHistorySummary(db as any, { period: "week", start: "2026-08-31", end: "2026-09-07", vertical: "all" }, now);
    ok(sep1.aiLookups === null && sep1.totals.views === 1 && eq(sep4.aiLookups, { mcp: 0, a2a: 0, total: 0 }) && weekAug31.aiLookups === null,
      "c1: a range whose raw MCP/A2A calls are gone is null, a day after the first stored one with no calls is a real 0",
      { sep1: sep1.aiLookups, sep4: sep4.aiLookups, weekAug31: weekAug31.aiLookups });
    const live = computeHistorySummary(db as any, { period: "day", start: "2026-09-02", end: "2026-09-03", vertical: "rfb" }, now, { wholePeriod: true });
    ok(live.aiLookups === null, "c2: also for the prune's whole-period summary when the day's calls are not stored", live.aiLookups);
    const empty = freshDb();
    seeder(empty).view(Date.UTC(2026, 8, 10, 10));
    ok(computeHistorySummary(empty as any, { period: "day", start: "2026-09-10", end: "2026-09-11", vertical: "all" }, now).aiLookups === null,
      "c3: no MCP/A2A rows at all (cannot be told from pruned ones) is null, not 0");
    empty.close();

    // (b) backfill on deploy: rows stored by version 3 (no aiLookups).
    ok(TRAFFIC_HISTORY_VERSION >= 4, "b1: TRAFFIC_HISTORY_VERSION is bumped past 3, so rows stored before S0 are recomputed", TRAFFIC_HISTORY_VERSION);
    await runTrafficHistoryJob({ db: db as any, nowMs: now, compute: async (item, n) => computeHistorySummary(db as any, item, n) });
    const v3 = (sum: string) => { const o = JSON.parse(sum); delete o.aiLookups; o.version = 3; return JSON.stringify(o); };
    for (const r of db.prepare("SELECT period, period_start, vertical, summary FROM traffic_history").all() as Array<{ period: string; period_start: string; vertical: string; summary: string }>) {
      db.prepare("UPDATE traffic_history SET version = 3, summary = ? WHERE period = ? AND period_start = ? AND vertical = ?")
        .run(v3(r.summary), r.period, r.period_start, r.vertical);
    }
    // Rows for days whose raw rows were pruned before this run (S3 stored them from Aug 14).
    const keepSummary = JSON.stringify({ period: "day", start: "2026-08-20", end: "2026-08-21", vertical: "all", version: 3, partialFrom: null, totals: { views: 777, visits: 70, visitors: 7 } });
    db.prepare("INSERT INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary) VALUES ('day', '2026-08-20', '2026-08-21', 'all', 3, NULL, ?)").run(keepSummary);
    const keepWeek = JSON.stringify({ period: "week", start: "2026-08-31", end: "2026-09-07", vertical: "all", version: 3, partialFrom: null, totals: { views: 555, visits: 50, visitors: 5 } });
    db.prepare("INSERT OR REPLACE INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary) VALUES ('week', '2026-08-31', '2026-09-07', 'all', 3, NULL, ?)").run(keepWeek);
    const keepMonthSummary = JSON.stringify({ period: "month", start: "2026-08-01", end: "2026-09-01", vertical: "all", version: 3, partialFrom: "2026-08-14", totals: { views: 999, visits: 90, visitors: 9 } });
    db.prepare("INSERT OR REPLACE INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary) VALUES ('month', '2026-08-01', '2026-09-01', 'all', 3, '2026-08-14', ?)").run(keepMonthSummary);
    const keepMonth = readRow(db, "month", "2026-08-01", "all");

    const plan = planHistoryItems(db as any, readStoredHistoryRows(db as any), now);
    const planned = (p: string, st: string, v = "all") => plan.some((i) => i.period === p && i.start === st && i.vertical === v);
    ok(planned("day", "2026-09-01") && planned("day", "2026-09-03", "rfb") && planned("day", "2026-10-21") && planned("week", "2026-09-14") && planned("month", "2026-09-01") &&
       !planned("day", "2026-08-20") && !planned("week", "2026-08-31") && !planned("month", "2026-08-01"),
      "b2: every version-3 row whose raw days are still stored is planned again; rows of pruned days are not", plan.length);
    const redo = await runTrafficHistoryJob({ db: db as any, nowMs: now, compute: async (item, n) => computeHistorySummary(db as any, item, n) });
    ok(redo.failed === 0 && redo.computed === plan.length, "b3: the backfill run stores every planned row", redo);
    ok(eq(lookupsOf(db, "day", "2026-09-03", "rfb"), { mcp: 4, a2a: 0, total: 4 }) && eq(lookupsOf(db, "day", "2026-09-03", "all"), { mcp: 5, a2a: 1, total: 6 }) &&
       eq(lookupsOf(db, "week", "2026-09-14", "rfb"), { mcp: 1, a2a: 0, total: 1 }) && lookupsOf(db, "month", "2026-09-01", "all") === null && eq(lookupsOf(db, "week", "2026-09-07", "all"), { mcp: 0, a2a: 0, total: 0 }) &&
       readRow(db, "day", "2026-09-03", "rfb")?.version === TRAFFIC_HISTORY_VERSION,
      "b4: days, weeks and months with raw calls are backfilled with their lookups", {
        day: lookupsOf(db, "day", "2026-09-03", "rfb"), week: lookupsOf(db, "week", "2026-09-14", "rfb"), month: lookupsOf(db, "month", "2026-09-01", "all"), week7: lookupsOf(db, "week", "2026-09-07", "all"),
      });
    ok(lookupsOf(db, "day", "2026-09-01", "all") === null && lookupsOf(db, "day", "2026-09-02", "rfb") === null,
      "b5: backfilled days whose calls were already pruned say null, not 0");
    const keptDay = readRow(db, "day", "2026-08-20", "all");
    const keptWeek = readRow(db, "week", "2026-08-31", "all");
    const keptMonth = readRow(db, "month", "2026-08-01", "all");
    ok(keptDay?.summary === keepSummary && keptDay?.version === 3 && keptWeek?.summary === keepWeek && keptWeek?.version === 3 &&
       !!keepMonth && keptMonth?.summary === keepMonth.summary && keptMonth?.version === 3 && lookupsOf(db, "day", "2026-08-20", "all") === "absent",
      "b6: rows of days already pruned keep their stored values (no recompute, no zeros, no aiLookups field)", { keptDay, keptWeek: keptWeek?.version });
    const second = planHistoryItems(db as any, readStoredHistoryRows(db as any), now);
    ok(second.length === 0, "b7: after the backfill nothing is planned again", second.slice(0, 3));
    db.close();
  } catch (e) {
    ok(false, "a–c threw", (e as Error).stack);
  }

  // ── (d) the nightly prune keeps each deleted day's lookups ─────────
  {
    const prevDb = initMod.getDb();
    const db = freshDb();
    try {
      initMod.__setDbForTesting(db as any);
      const s = seeder(db);
      const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
      for (let k = 66; k >= 1; k--) {
        s.view(today - k * D + 9 * H);
        s.mcp("lokal_search", today - k * D + 10 * H);
        if (k % 2 === 0) s.a2a("message/send", today - k * D + 11 * H, "experiences");
      }
      const oldest = ts(today - 66 * D).slice(0, 10);
      // A version-3 day row (stored before S0) for a day the prune is about to delete.
      ensureTrafficHistoryForDaySync(db as any, oldest);
      const r0 = readRow(db, "day", oldest, "all")!;
      const o = JSON.parse(r0.summary); delete o.aiLookups;
      db.prepare("UPDATE traffic_history SET version = 3, summary = ? WHERE period = 'day' AND period_start = ?").run(JSON.stringify(o), oldest);
      const { rollupAndPrunePageViews, pruneAnalyticsMcpCalls } = require("./retention-service") as typeof import("./retention-service");
      quiet(() => rollupAndPrunePageViews(60, 7));
      const mcpDeleted = pruneAnalyticsMcpCalls(60, false).rowsDeleted;
      const rawLeft = (db.prepare("SELECT COUNT(*) AS n FROM analytics_mcp_calls WHERE created_at < ?").get(ts(today - 60 * D)) as { n: number }).n;
      ok(mcpDeleted > 0 && rawLeft === 0, "d1: raw MCP/A2A calls are still deleted after the 60-day window", { mcpDeleted, rawLeft });
      const prunedDays = (db.prepare("SELECT period_start AS d, summary FROM traffic_history WHERE period = 'day' AND vertical = 'all' AND period_start < ?").all(ts(today - 60 * D).slice(0, 10)) as Array<{ d: string; summary: string }>);
      const total = prunedDays.reduce((a, r) => a + ((JSON.parse(r.summary) as HistorySummary).aiLookups?.total ?? 0), 0);
      // Days 66…61 ago: 6 MCP lookups + 3 A2A (even k: 66, 64, 62).
      ok(prunedDays.length >= 6 && total === 9 && prunedDays.every((r) => (JSON.parse(r.summary) as HistorySummary).aiLookups !== null),
        "d2: every day the prune deleted keeps its lookups in the history (the version-3 row recomputed before deletion)", { days: prunedDays.length, total });
      ok(eq(lookupsOf(db, "day", oldest, "experiences"), { mcp: 0, a2a: 1, total: 1 }) && readRow(db, "day", oldest, "all")?.version === TRAFFIC_HISTORY_VERSION,
        "d3: the pre-S0 row of the first pruned day got its lookups per site", lookupsOf(db, "day", oldest, "experiences"));
    } catch (e) {
      ok(false, "d: prune tests threw", (e as Error).stack);
    } finally {
      initMod.__setDbForTesting(prevDb);
      db.close();
    }
  }

  // ── (e) AI-assistant profile views survive the prune ───────────────
  {
    const prevDb = initMod.getDb();
    const db = freshDb();
    try {
      initMod.__setDbForTesting(db as any);
      const s = seeder(db);
      const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
      const old = today - 70 * D + 9 * H;
      const old2 = today - 69 * D + 9 * H;
      const oldDay = ts(old).slice(0, 10);
      const oldDay2 = ts(old2).slice(0, 10);
      // p1, 70 days ago: 3 people, 2 AI assistants, 1 AI crawler, 1 own AI-assistant view, 1 bot, 1 legacy (no class).
      for (let i = 0; i < 3; i++) s.agentView("p1", old + i * 60_000, "human");
      for (let i = 0; i < 2; i++) s.agentView("p1", old + (10 + i) * 60_000, "ai_search");
      s.agentView("p1", old + 20 * 60_000, "ai_crawler");
      s.agentView("p1", old + 21 * 60_000, "ai_search", 1);
      s.agentView("p1", old + 22 * 60_000, "other_bot");
      s.agentView("p1", old + 23 * 60_000, null);
      // p2: one AI-assistant view 70 days ago, one 69 days ago, two people 69 days ago.
      s.agentView("p2", old + 30 * 60_000, "ai_search");
      s.agentView("p2", old2, "ai_search");
      s.agentView("p2", old2 + 60_000, "human");
      s.agentView("p2", old2 + 120_000, "human");
      // Inside the window: kept raw, not rolled up.
      s.agentView("p1", today - 10 * D + 9 * H, "ai_search");
      s.agentView("p1", today - 10 * D + 10 * H, "human");

      const cols = (db.prepare("PRAGMA table_info(agent_ai_view_daily)").all() as Array<{ name: string }>).map((c) => c.name);
      ok(eq(cols, ["day", "agent_id", "view_count"]), "e1: agent_ai_view_daily schema (day, agent_id, view_count) matches the rollup's INSERT", cols);

      const { rollupAndPruneAgentViews, rollupAndPruneAgentViewsAsync } = require("./retention-service") as typeof import("./retention-service");
      quiet(() => rollupAndPruneAgentViews(60, 7));
      const ai = db.prepare("SELECT day, agent_id, view_count FROM agent_ai_view_daily ORDER BY day, agent_id").all();
      ok(eq(ai, [{ day: oldDay, agent_id: "p1", view_count: 2 }, { day: oldDay, agent_id: "p2", view_count: 1 }, { day: oldDay2, agent_id: "p2", view_count: 1 }]),
        "e2: AI-assistant views are kept per profile per day (no crawler, bot, own or legacy view; nothing inside the window)", ai);
      const human = db.prepare("SELECT day, agent_id, view_source, SUM(view_count) AS n FROM agent_view_daily GROUP BY day, agent_id, view_source ORDER BY day, agent_id, view_source").all();
      ok(eq(human, [
        { day: oldDay, agent_id: "p1", view_source: "legacy_unclassified", n: 1 },
        { day: oldDay, agent_id: "p1", view_source: "seo", n: 3 },
        { day: oldDay2, agent_id: "p2", view_source: "seo", n: 2 },
      ]), "e3: the human bucket is unchanged: people only, no AI-assistant view added", human);
      const rawOld = (db.prepare("SELECT COUNT(*) AS n FROM analytics_agent_views WHERE created_at < ?").get(ts(today - 60 * D)) as { n: number }).n;
      const rawNew = (db.prepare("SELECT COUNT(*) AS n FROM analytics_agent_views").get() as { n: number }).n;
      ok(rawOld === 0 && rawNew === 2, "e4: the raw profile views are still deleted after the window (all classes), newer ones kept", { rawOld, rawNew });
      quiet(() => rollupAndPruneAgentViews(60, 7));
      ok(eq(db.prepare("SELECT SUM(view_count) AS n FROM agent_ai_view_daily").get(), { n: 4 }), "e5: a second prune does not count anything twice");

      // The async (nightly) variant rolls up the same bucket.
      s.agentView("p3", today - 65 * D + 9 * H, "ai_search");
      s.agentView("p3", today - 65 * D + 10 * H, "ai_search");
      await rollupAndPruneAgentViewsAsync(60, 7);
      ok(eq(db.prepare("SELECT view_count AS n FROM agent_ai_view_daily WHERE agent_id = 'p3'").get(), { n: 2 }), "e6: the nightly (async) prune keeps the AI bucket too");
    } catch (e) {
      ok(false, "e: agent-view prune tests threw", (e as Error).stack);
    } finally {
      initMod.__setDbForTesting(prevDb);
      db.close();
    }

    // An older hand-rolled schema without the bucket still prunes (human rollup only).
    const legacyPrev = initMod.getDb();
    const legacy = new Database(":memory:");
    try {
      legacy.exec(`
        CREATE TABLE analytics_agent_views (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, city TEXT,
          view_source TEXT DEFAULT 'unknown', created_at TEXT, is_owner INTEGER DEFAULT 0, traffic_category TEXT);
        CREATE TABLE agent_view_daily (day TEXT NOT NULL, agent_id TEXT NOT NULL, view_source TEXT NOT NULL DEFAULT 'unknown', city TEXT NOT NULL DEFAULT '',
          view_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, agent_id, view_source, city));
        CREATE TABLE boot_job_state (job TEXT PRIMARY KEY, last_completed_at TEXT NOT NULL);
      `);
      legacy.prepare("INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at, traffic_category) VALUES ('p1', 'p1', '', 'seo', ?, 'human')")
        .run(ts(Date.now() - 70 * D));
      initMod.__setDbForTesting(legacy as any);
      const { rollupAndPruneAgentViews } = require("./retention-service") as typeof import("./retention-service");
      const r = quiet(() => rollupAndPruneAgentViews(60, 7));
      ok(r.rowsDeleted === 1 && eq(legacy.prepare("SELECT SUM(view_count) AS n FROM agent_view_daily").get(), { n: 1 }),
        "e7: a schema without agent_ai_view_daily keeps the human-only rollup", r);
    } catch (e) {
      ok(false, "e7 threw", (e as Error).stack);
    } finally {
      initMod.__setDbForTesting(legacyPrev);
      legacy.close();
    }
  }

  // The opt-out deletion (DELETE /admin/agents/:id) clears the AI bucket with the human one.
  const marketplaceSrc = fs.readFileSync(path.join(__dirname, "..", "routes", "marketplace.ts"), "utf8");
  ok(/DELETE FROM agent_view_daily WHERE agent_id = \?[\s\S]{0,400}DELETE FROM agent_ai_view_daily WHERE agent_id = \?/.test(marketplaceSrc),
    "e8: an agent opt-out deletes its agent_ai_view_daily rows too");

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/statistikk-s0-store-before-prune.test.ts`
if (require.main === module) {
  runStatistikkS0Tests({ log: true }).then((summary) => {
    for (const f of summary.failures) console.log(f);
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
