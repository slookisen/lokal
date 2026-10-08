/**
 * admin-stats.test.ts — dev-request 2026-10-08-serverheng-hovedtraad-oppstart-
 * statistikk-samtaler (A2A), skive 3: the admin-dashboard statistics run in the
 * off-thread stats worker's own lane with a stale-while-revalidate cache.
 *
 *   M1–M2   createSwrCache maxEntries: least recently written key is dropped
 *   K1      adminStatsKey: stable whatever the property order; undefined dropped
 *   R1–R11  createAdminStatsReader (injected deps): sync path for in-memory /
 *           kill-switch DBs, worker path with TTL / max staleness, failure →
 *           not-ok (the routes' 503), retry back-off, DB-path change
 *   Q1–Q8   query equivalence on the full schema: /cities and /producers'
 *           grouped queries equal the old correlated-subquery SQL; the
 *           INDEXED BY queries (summary GROUP BY source, /pages) equal the
 *           un-hinted ones and use the time-window index (EXPLAIN QUERY PLAN)
 *   H1–H5   routes on a real Express app with an injected reader (app.set, no
 *           global swap): worker answer → same JSON as the sync path; worker
 *           failure → 503 + Retry-After for every moved route
 *   L1–L5   the real worker: admin tasks match the synchronous computation,
 *           run in their own lane (an admin task completes while the
 *           background lane is stuck), admin keys are never marked broken,
 *           and the worker's import graph never loads database/init
 *
 * No process.env mutation across an await and no global DB injection, so it is
 * safe next to the concurrently running blocks in tests/test.ts. Exported
 * runAdminStatsTests({log}); standalone: npx tsx src/services/admin-stats.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { __initSchemaForTesting } from "../database/init";
import { humanAgentViewSql } from "../database/analytics-sql";
import {
  createSwrCache,
  runStatsTaskOffThread,
  getOffThreadStatsState,
  OFFTHREAD_MAX_CONSECUTIVE_FAILURES,
  __resetOffThreadStatsForTesting,
  __setWorkerScriptForTesting,
} from "./offthread-stats";
import {
  createAdminStatsReader,
  adminStatsKey,
  ADMIN_STATS_READER_APP_KEY,
  type AdminStatsReaderDeps,
} from "./admin-stats";
import {
  computeAdminSummary,
  computeCityStats,
  computeTopProducers,
  computeTopPages,
  runAdminStatsQuery,
  pageViewsWindowIndexHint,
  TOP_PAGES_SCANNER_PATTERNS,
  type AdminStatsQuery,
} from "./admin-stats-compute";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const walPragma = () => "wal";
const FILE_DB = { name: "/data/lokal.db", memory: false, pragma: walPragma } as unknown as Database.Database;
const OTHER_FILE_DB = { name: "/data/other.db", memory: false, pragma: walPragma } as unknown as Database.Database;

function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeds page views, queries and agent views over the last ~40 days. */
function seedAnalytics(db: Database.Database, nowMs: number, seed: number): void {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const verticals = ["rfb", "dental", "experiences"];
  const sources = ["direct", "organic", "search", "social", "referral", "ai"];
  const paths = ["/", "/sok", "/oslo", "/bergen", "/produsent/hanen", "/produsent/gard-a", "/wp-admin/x.php", "/om"];
  const sessions = [
    "ip1:desktop:aaaa", "ip2:mobile:bbbb", "ip3:tablet:cccc",
    "ip4:Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "ip5:Mozilla/5.0 (compatible; ClaudeBot/1.0)", "ip6:desktop:dddd",
  ];
  const pv = db.prepare(
    "INSERT INTO analytics_page_views (path, source, session_id, is_owner, vertical_id, created_at, utm_source) VALUES (?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 600; i++) {
    const ageMs = Math.floor(r() * 40 * 24 * 3600_000);
    pv.run(pick(paths), pick(sources), pick(sessions), r() < 0.08 ? 1 : 0, pick(verticals), sqliteTs(nowMs - ageMs), r() < 0.1 ? "nyhetsbrev" : null);
  }
  const cities = ["Oslo", "Bergen", "Trondheim", "Tromsø", "Bodø"];
  const cats = ['["egg","melk"]', '["kjott"]', '["gronnsaker"]', '[]', '["honning"]', null];
  const q = db.prepare(
    "INSERT INTO analytics_queries (protocol, query, categories, city, agent_id, is_owner, vertical_id, created_at) VALUES ('search',?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 300; i++) {
    const ageMs = Math.floor(r() * 40 * 24 * 3600_000);
    q.run(pick(["epler", "egg", "ost", "honning", "x"]), pick(cats), r() < 0.1 ? null : pick(cities),
      pick([null, "ChatGPT", "Claude", "Perplexity"]), r() < 0.05 ? 1 : 0, pick(verticals), sqliteTs(nowMs - ageMs));
  }
  const agents = [
    ["a1", "Gård A"], ["a2", "Gård B"], ["a3", "Hanen"], ["a4", "Gård D"], ["a5", "Gård E"], ["a6", "Gård F"],
  ];
  const av = db.prepare(
    "INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, is_owner, traffic_category, vertical_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 400; i++) {
    const [id, name] = pick(agents);
    const ageMs = Math.floor(r() * 40 * 24 * 3600_000);
    av.run(id, name, r() < 0.05 ? null : pick(cities), pick(["direct", "search", "ai", "social", null]),
      r() < 0.05 ? 1 : 0, pick(["human", "human", "human", "ai_crawler", null]), pick(verticals), sqliteTs(nowMs - ageMs));
  }
}

// ── The SQL this slice replaced (kept here as the equivalence reference) ──

function oldCityRows(db: Database.Database, cutoff: string, vertical?: string): any[] {
  const V = vertical ? ` AND vertical_id = '${vertical}'` : "";
  return db.prepare(`
    SELECT
      aav.city,
      COUNT(DISTINCT aav.id) as view_count,
      (SELECT COUNT(*) FROM analytics_queries aq WHERE aq.city = aav.city AND aq.created_at > ? AND (aq.is_owner IS NULL OR aq.is_owner = 0)${V.replace(/vertical_id/g, "aq.vertical_id")}) as search_queries,
      (SELECT json_extract(aq.categories, '$[0]') FROM analytics_queries aq
       WHERE aq.city = aav.city AND aq.created_at > ? AND aq.categories IS NOT NULL AND (aq.is_owner IS NULL OR aq.is_owner = 0)${V.replace(/vertical_id/g, "aq.vertical_id")}
       GROUP BY json_extract(aq.categories, '$[0]')
       ORDER BY COUNT(*) DESC
       LIMIT 1) as top_category
    FROM analytics_agent_views aav
    WHERE aav.created_at > ? AND aav.city IS NOT NULL
      AND ${humanAgentViewSql("aav")}${V.replace(/vertical_id/g, "aav.vertical_id")}
    GROUP BY aav.city
    ORDER BY view_count DESC
  `).all(cutoff, cutoff, cutoff) as any[];
}

function oldProducerRows(db: Database.Database, cutoff: string, limit: number, vertical?: string): any[] {
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  return db.prepare(`
    SELECT
      agent_id,
      agent_name,
      city,
      COUNT(*) as view_count,
      (SELECT view_source FROM analytics_agent_views aav2
       WHERE aav2.agent_id = aav.agent_id
         AND aav2.created_at > ? AND ${humanAgentViewSql("aav2")}
       GROUP BY view_source
       ORDER BY COUNT(*) DESC
       LIMIT 1) as top_source
    FROM analytics_agent_views aav
    WHERE created_at > ? AND ${humanAgentViewSql("aav")}${V}
    GROUP BY agent_id, agent_name, city
    ORDER BY view_count DESC
    LIMIT ?
  `).all(cutoff, cutoff, ...vp, limit) as any[];
}

/** Old top-pages raw query (no INDEXED BY). */
function oldPageRows(db: Database.Database, cutoff: string, limit: number, vertical?: string): any[] {
  const V = vertical ? " AND vertical_id = ?" : "";
  const vp: string[] = vertical ? [vertical] : [];
  const excl = TOP_PAGES_SCANNER_PATTERNS.map(() => "path NOT LIKE ?").join(" AND ");
  return db.prepare(`
    SELECT path, COUNT(*) as views, COUNT(DISTINCT session_id) as visitors
    FROM analytics_page_views
    WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V} AND (${excl})
    GROUP BY path
    ORDER BY views DESC
    LIMIT ?
  `).all(cutoff, ...vp, ...TOP_PAGES_SCANNER_PATTERNS, limit) as any[];
}

/** Does the top-category / top-source / ranking have a tie the old SQL left to the engine? */
function hasTies(rows: any[], countKey: string): boolean {
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r[countKey])) return true;
    seen.add(r[countKey]);
  }
  return false;
}

/** Rows ordered by count descending, ties by `tieKey` — the order the old SQL left to the engine. */
function canonical<T>(rows: T[], count: (r: T) => number, tieKey: (r: T) => string): T[] {
  return [...rows].sort((a, b) => count(b) - count(a) || (tieKey(a) < tieKey(b) ? -1 : tieKey(a) > tieKey(b) ? 1 : 0));
}

/** Per group: the set of most common values (more than one = a tie the old SQL left to the engine). */
function winners(db: Database.Database, sql: string, ...params: unknown[]): Map<string, Set<string | null>> {
  const rows = db.prepare(sql).all(...params) as Array<{ k: string; val: string | null; n: number }>;
  const best = new Map<string, number>();
  for (const r of rows) best.set(r.k, Math.max(best.get(r.k) ?? 0, r.n));
  const out = new Map<string, Set<string | null>>();
  for (const r of rows) {
    if (r.n !== best.get(r.k)) continue;
    if (!out.has(r.k)) out.set(r.k, new Set());
    out.get(r.k)!.add(r.val);
  }
  return out;
}

export async function runAdminStatsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string, detail?: unknown): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}${detail === undefined ? "" : `\n    got: ${JSON.stringify(detail)}`}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  // ── M: createSwrCache maxEntries ─────────────────────────────────
  {
    const c = createSwrCache<number>({ ttlMs: 1_000, maxEntries: 2, refresh: () => Promise.resolve(0) });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    ok(!c.has("a") && c.has("b") && c.has("c"), "M1: past maxEntries the least recently written key is dropped");
    c.set("b", 22);
    c.set("d", 4);
    ok(c.has("b") && !c.has("c") && c.has("d"), "M2: rewriting a key makes it the most recent");
  }

  // ── K: cache key ─────────────────────────────────────────────────
  ok(
    adminStatsKey({ name: "pages", hours: 24, limit: 20, vertical: undefined }) ===
      adminStatsKey({ limit: 20, hours: 24, name: "pages" } as AdminStatsQuery) &&
      adminStatsKey({ name: "pages", hours: 24, limit: 20 }) !== adminStatsKey({ name: "pages", hours: 24, limit: 20, vertical: "rfb" }),
    "K1: the cache key ignores property order and undefined fields, and separates verticals"
  );

  // ── R: createAdminStatsReader with injected deps ─────────────────
  {
    let t = 1_000_000;
    let db: Database.Database = FILE_DB;
    let usable = true;
    let dbThrows = false;
    const offCalls: Array<{ dbPath: string; query: AdminStatsQuery; nowMs: number }> = [];
    let off = deferred<unknown>();
    const logs: string[] = [];
    const deps: AdminStatsReaderDeps = {
      getDb: () => {
        if (dbThrows) throw new Error("db not open");
        return db;
      },
      offThreadUsable: () => usable,
      runOffThread: (dbPath, query, nowMs) => {
        offCalls.push({ dbPath, query, nowMs });
        return off.promise;
      },
      now: () => t,
      ttlMs: 300_000,
      maxStaleMs: 600_000,
      retryAfterMs: 30_000,
      maxEntries: 50,
      log: (m) => logs.push(m),
    };
    const reader = createAdminStatsReader(deps);
    const Q: AdminStatsQuery = { name: "cities", hours: 720, vertical: "rfb" };
    let syncCalls = 0;
    const sync = () => {
      syncCalls++;
      return ["sync"];
    };

    usable = false;
    const s1 = await reader.read(Q, sync);
    ok(s1.ok && eq(s1.value, ["sync"]) && !s1.offThread && offCalls.length === 0 && syncCalls === 1,
      "R1: in-memory/kill-switch/non-WAL DBs keep the original synchronous path", { s1, offCalls, syncCalls });

    usable = true;
    const p2 = reader.read(Q, sync);
    await Promise.resolve();
    ok(offCalls.length === 1 && offCalls[0].dbPath === "/data/lokal.db" && adminStatsKey(offCalls[0].query) === adminStatsKey(Q) && offCalls[0].nowMs === t,
      "R2a: a first read on the worker path asks the worker (with the query and the clock)", offCalls);
    off.resolve(["w1"]);
    const r2 = await p2;
    ok(r2.ok && eq(r2.value, ["w1"]) && r2.offThread && r2.ageMs === 0 && syncCalls === 1,
      "R2b: …waits for its answer without ever running the synchronous query", { r2, syncCalls });

    t += 299_000;
    const r3 = await reader.read(Q, sync);
    ok(r3.ok && eq(r3.value, ["w1"]) && offCalls.length === 1, "R3: within the TTL the cached value is served", { r3, offCalls });

    t += 1_000;
    off = deferred<unknown>();
    const r4 = await reader.read(Q, sync);
    ok(r4.ok && eq(r4.value, ["w1"]) && r4.ageMs === 300_000 && offCalls.length === 2,
      "R4: past the TTL the stale value is served at once and one background refresh starts", { r4, offCalls });
    off.resolve(["w2"]);
    await reader.settled(Q);
    const r4b = await reader.read(Q, sync);
    ok(r4b.ok && eq(r4b.value, ["w2"]) && r4b.ageMs === 0, "R4b: the refreshed value replaces it", r4b);

    t += 600_001;
    off = deferred<unknown>();
    const p5 = reader.read(Q, sync);
    let settled5 = false;
    void p5.then(() => (settled5 = true));
    await Promise.resolve();
    await Promise.resolve();
    ok(!settled5 && offCalls.length === 3, "R5a: a value older than the max staleness is not served; the read waits for the worker", { settled5, offCalls });
    off.resolve(["w3"]);
    const r5 = await p5;
    ok(r5.ok && eq(r5.value, ["w3"]), "R5b: …and gets the fresh answer", r5);

    const Q2: AdminStatsQuery = { name: "visitors", hours: 24, limit: 50 };
    off = deferred<unknown>();
    const p6 = reader.read(Q2, sync);
    off.reject(new Error("worker crashed"));
    const r6 = await p6;
    ok(!r6.ok && /worker crashed/.test(r6.error) && syncCalls === 1 && logs.some((l) => /worker crashed/.test(l)),
      "R6: a worker failure with nothing cached is not-ok (the route's 503), never a synchronous fallback", { r6, syncCalls, logs });

    const before = offCalls.length;
    const r7 = await reader.read(Q2, sync);
    ok(!r7.ok && offCalls.length === before, "R7: inside the retry back-off a read does not ask the worker again", { r7, offCalls: offCalls.length });

    t += 30_000;
    off = deferred<unknown>();
    const p8 = reader.read(Q2, sync);
    off.resolve(["v"]);
    const r8 = await p8;
    ok(r8.ok && eq(r8.value, ["v"]) && offCalls.length === before + 1, "R8: after the back-off the worker is asked again and its answer served", { r8 });

    // R9: stale-but-servable value survives a failed refresh; too old does not.
    t += 300_000;
    off = deferred<unknown>();
    const r9 = await reader.read(Q2, sync);
    off.reject(new Error("again"));
    await reader.settled(Q2);
    const r9b = await reader.read(Q2, sync);
    t += 300_001;
    const r9c = await reader.read(Q2, sync);
    ok(r9.ok && r9b.ok && eq(r9b.value, ["v"]) && !r9c.ok,
      "R9: a failed refresh keeps serving the value until the max staleness, then answers not-ok", { r9, r9b, r9c });

    db = OTHER_FILE_DB;
    off = deferred<unknown>();
    const p10 = reader.read(Q, sync);
    await Promise.resolve();
    ok(offCalls[offCalls.length - 1].dbPath === "/data/other.db", "R10: a different DB file drops the cache and asks the worker on the new path", offCalls[offCalls.length - 1]);
    off.resolve(["other"]);
    const r10 = await p10;
    ok(r10.ok && eq(r10.value, ["other"]), "R10b: the new DB's answer is served", r10);

    dbThrows = true;
    const r11 = await reader.read(Q, sync);
    ok(r11.ok && eq(r11.value, ["sync"]) && !r11.offThread, "R11: an unavailable DB handle falls to the original synchronous path (its own error handling)", r11);
  }

  // ── Q: query equivalence on the full schema ──────────────────────
  const qdb = new Database(":memory:");
  const origLog = console.log;
  try {
    console.log = () => {};
    try {
      __initSchemaForTesting(qdb);
    } finally {
      console.log = origLog;
    }
    const nowMs = Date.UTC(2026, 9, 8, 12, 0, 0);
    seedAnalytics(qdb, nowMs, 42);

    // The old SQL's row order among equal counts (and which row a LIMIT kept
    // at a tie) varied with the query plan, and its pick among equally common
    // categories/sources was the engine's. So: rows, numbers and the ranking
    // by count must match exactly; ties are compared in a canonical order; a
    // tied top category/source must be one of the tied winners.
    let cityCases = 0;
    let cityBad: unknown = null;
    let prodCases = 0;
    let prodBad: unknown = null;
    let tiedRanks = 0;
    let tiedPicks = 0;
    for (const hours of [24, 24 * 7, 24 * 30, 24 * 365]) {
      for (const v of [undefined, "rfb", "dental", "experiences"] as const) {
        const cutoff = sqliteTs(nowMs - hours * 3600_000);
        const VQ = v ? ` AND vertical_id = '${v}'` : "";
        const catWin = winners(qdb, `SELECT city AS k, json_extract(categories, '$[0]') AS val, COUNT(*) AS n FROM analytics_queries
          WHERE created_at > ? AND categories IS NOT NULL AND (is_owner IS NULL OR is_owner = 0) AND city IS NOT NULL${VQ}
          GROUP BY city, json_extract(categories, '$[0]')`, cutoff);
        const srcWin = winners(qdb, `SELECT agent_id AS k, view_source AS val, COUNT(*) AS n FROM analytics_agent_views aav2
          WHERE created_at > ? AND ${humanAgentViewSql("aav2")} GROUP BY agent_id, view_source`, cutoff);

        const old = oldCityRows(qdb, cutoff, v).map((r) => ({ city: r.city, viewCount: r.view_count, searchQueries: r.search_queries || 0, topCategory: r.top_category }));
        const neu = computeCityStats(qdb, hours, v, nowMs);
        cityCases++;
        if (hasTies(old, "viewCount")) tiedRanks++;
        const strip = (rows: typeof neu) => canonical(rows, (r) => r.viewCount, (r) => r.city).map((r) => [r.city, r.viewCount, r.searchQueries]);
        const pickOk = neu.every((r) => {
          const w = catWin.get(r.city);
          const o = old.find((x) => x.city === r.city);
          if (!w || w.size <= 1) return r.topCategory === (o ? o.topCategory : undefined);
          tiedPicks++;
          return w.has(r.topCategory) && r.topCategory === [...w].filter((x) => x !== null).sort().pop();
        });
        if ((!eq(strip(old), strip(neu)) || !eq(neu, canonical(neu, (r) => r.viewCount, (r) => r.city)) || !pickOk) && !cityBad) cityBad = { hours, v, old, neu };

        const oldAll = oldProducerRows(qdb, cutoff, 100_000, v).map((r) => ({ agentId: r.agent_id, agentName: r.agent_name, city: r.city, viewCount: r.view_count, topSource: r.top_source || "unknown" }));
        if (hasTies(oldAll, "viewCount")) tiedRanks++;
        const tie = (r: { agentId: string; agentName: string; city?: string | null }) => `${r.agentId}\u0000${r.agentName}\u0000${r.city ?? ""}`;
        for (const limit of [3, 20, 1000]) {
          prodCases++;
          const newP = computeTopProducers(qdb, limit, hours, v, nowMs);
          const expected = canonical(oldAll, (r) => r.viewCount, tie).slice(0, limit);
          const sameRows = eq(expected.map((r) => [r.agentId, r.agentName, r.city, r.viewCount]), newP.map((r) => [r.agentId, r.agentName, r.city, r.viewCount]));
          const oldLimited = oldProducerRows(qdb, cutoff, limit, v).map((r) => r.view_count);
          const srcOk = newP.every((r) => {
            const w = srcWin.get(r.agentId);
            const o = oldAll.find((x) => x.agentId === r.agentId && x.city === r.city);
            if (!w || w.size <= 1) return r.topSource === o?.topSource;
            tiedPicks++;
            return w.has(r.topSource === "unknown" ? null : r.topSource);
          });
          if ((!sameRows || !eq(oldLimited, newP.map((r) => r.viewCount)) || !srcOk) && !prodBad) prodBad = { hours, v, limit, expected, newP };
        }
      }
    }
    ok(cityCases === 16 && cityBad === null,
      "Q1: /cities' grouped query returns the old correlated-subquery SQL's rows, numbers and ranking (16 window×vertical cases)", cityBad);
    ok(prodCases === 48 && prodBad === null,
      "Q2: /producers' grouped query returns the old SQL's rows, counts, ranking and top source, with and without LIMIT (48 cases)", prodBad);
    ok(tiedRanks > 0 && tiedPicks > 0, "Q3: the seeded data contains tied counts and tied top categories/sources, so Q1/Q2 cover the tie rules", { tiedRanks, tiedPicks });

    // Q4: summary trafficBySource with INDEXED BY equals the un-hinted query.
    {
      let bad: unknown = null;
      for (const hours of [24, 720]) {
        for (const v of [undefined, "rfb"] as const) {
          const cutoff = sqliteTs(nowMs - hours * 3600_000);
          const V = v ? " AND vertical_id = ?" : "";
          const rows = qdb.prepare(`SELECT source, COUNT(*) as count FROM analytics_page_views WHERE created_at > ? AND (is_owner IS NULL OR is_owner = 0)${V} GROUP BY source`)
            .all(cutoff, ...(v ? [v] : [])) as Array<{ source: string; count: number }>;
          const expected: Record<string, number> = {};
          for (const r of rows) expected[r.source] = r.count;
          const got = computeAdminSummary(qdb, hours, v, nowMs).trafficBySource;
          if (!eq(Object.entries(got).sort(), Object.entries(expected).sort())) bad = bad ?? { hours, v, got, expected };
        }
      }
      ok(bad === null, "Q4: summary trafficBySource (INDEXED BY the time-window index) equals the old query", bad);
    }

    // Q5: /pages with INDEXED BY equals the old query (rollup blend empty here).
    {
      let bad: unknown = null;
      for (const hours of [24, 720]) {
        for (const v of [undefined, "dental"] as const) {
          const cutoff = sqliteTs(nowMs - hours * 3600_000);
          const old = oldPageRows(qdb, cutoff, 1000, v);
          const neu = computeTopPages(qdb, hours, 1000, v, nowMs);
          const norm = (xs: any[]) => [...xs].map((x) => [x.path, x.views, x.visitors]).sort();
          if (!eq(norm(old), norm(neu)) || !eq(old.map((x) => x.views), neu.map((x: any) => x.views))) bad = bad ?? { hours, v, old, neu };
        }
      }
      ok(bad === null, "Q5: /pages (INDEXED BY the time-window index) returns the same rows and ranking as the old query", bad);
    }

    // Q5b: ties around the LIMIT cut pick the same pages as the old query (tie-breaker on path).
    {
      let bad: unknown = null;
      for (const hours of [24, 720]) {
        for (const v of [undefined, "dental"] as const) {
          for (const limit of [3, 5, 20]) {
            const cutoff = sqliteTs(nowMs - hours * 3600_000);
            const old = oldPageRows(qdb, cutoff, limit, v).map((x: any) => x.path);
            const neu = computeTopPages(qdb, hours, limit, v, nowMs).map((x: any) => x.path);
            if (!eq(old, neu)) bad = bad ?? { hours, v, limit, old, neu };
          }
        }
      }
      ok(bad === null, "Q5b: /pages with a small LIMIT returns the same pages in the same order as the old query (ties)", bad);
    }

    // Q6/Q7: EXPLAIN QUERY PLAN — the time-window index, not a full walk of source/path.
    {
      const plan = (sql: string, ...p: unknown[]) =>
        (qdb.prepare("EXPLAIN QUERY PLAN " + sql).all(...p) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      const c = sqliteTs(nowMs - 24 * 3600_000);
      const srcAll = plan(`SELECT source, COUNT(*) FROM analytics_page_views${pageViewsWindowIndexHint(qdb)} WHERE created_at > ? GROUP BY source`, c);
      const srcV = plan(`SELECT source, COUNT(*) FROM analytics_page_views${pageViewsWindowIndexHint(qdb, "rfb")} WHERE created_at > ? AND vertical_id = ? GROUP BY source`, c, "rfb");
      const pathAll = plan(`SELECT path, COUNT(*) FROM analytics_page_views${pageViewsWindowIndexHint(qdb)} WHERE created_at > ? GROUP BY path`, c);
      ok(/SEARCH analytics_page_views USING INDEX idx_analytics_page_views_created/.test(srcAll) &&
         /SEARCH analytics_page_views USING INDEX idx_analytics_page_views_created/.test(pathAll),
        "Q6: without a vertical, GROUP BY source/path search the created_at index (no full walk of _source/_path)", { srcAll, pathAll });
      ok(/USING INDEX idx_analytics_page_views_vertical \(vertical_id=\? AND created_at>\?\)/.test(srcV),
        "Q7: with a vertical, the (vertical_id, created_at) index is used", srcV);
      const bare = new Database(":memory:");
      bare.exec("CREATE TABLE analytics_page_views (id INTEGER PRIMARY KEY, created_at TEXT)");
      ok(pageViewsWindowIndexHint(bare) === "" && pageViewsWindowIndexHint(qdb) === " INDEXED BY idx_analytics_page_views_created",
        "Q8: the hint is omitted when the index does not exist (INDEXED BY a missing index is an error)");
      bare.close();
    }
  } catch (e) {
    ok(false, "Q: equivalence tests threw", (e as Error).stack);
  } finally {
    qdb.close();
  }

  // ── H: the routes, on an app with its own injected reader ─────────
  {
    const KEY = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
    let server: http.Server | null = null;
    try {
      if (!KEY) {
        ok(true, "H: skipped (no admin key configured in this process)");
      } else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const analyticsRouter = require("../routes/analytics").default;
        let mode: "ok" | "fail" = "fail";
        const seen: AdminStatsQuery[] = [];
        const answers: Record<string, unknown> = {
          summary24: {
            summary: { pageViews: 7, uniqueVisitors: 3, avgTimeOnSite: 0, totalQueries: 1, topSearchTerms: [], trafficBySource: { direct: 7 }, agentTraffic: { chatgpt: 0, claude: 0, other: 0 }, ownerStats: { pageViews: 0, queries: 0 } },
            monthlyVisits: 70,
            utm: [],
          },
          summary: { pageViews: 9, uniqueVisitors: 4, avgTimeOnSite: 0, totalQueries: 0, topSearchTerms: [], trafficBySource: {}, agentTraffic: { chatgpt: 0, claude: 0, other: 0 }, ownerStats: { pageViews: 0, queries: 0 } },
          producers: [{ agentId: "a1", agentName: "Gård A", city: "Oslo", viewCount: 5, topSource: "search" }],
          cities: [{ city: "Oslo", viewCount: 5, searchQueries: 2, topCategory: "egg" }],
          visitors: [{ ipHash: "ip1:desktop:aaaa", pageViews: 3 }],
          pages: [{ path: "/", views: 3, visitors: 2 }],
          umbrellaTraffic: [],
        };
        const reader = createAdminStatsReader({
          getDb: () => FILE_DB,
          offThreadUsable: () => true,
          runOffThread: (_p, query) => {
            seen.push(query);
            return mode === "ok" ? Promise.resolve(answers[query.name]) : Promise.reject(new Error("worker down"));
          },
          now: Date.now,
          ttlMs: 300_000,
          maxStaleMs: 600_000,
          retryAfterMs: 0,
          maxEntries: 50,
          log: () => {},
        });
        const app = express();
        app.set(ADMIN_STATS_READER_APP_KEY, reader);
        app.use("/admin/analytics", analyticsRouter);
        server = await new Promise<http.Server>((resolve) => {
          const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        const port = (server.address() as AddressInfo).port;
        const get = (p: string) =>
          new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve) => {
            const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { "X-Admin-Key": KEY } }, (res) => {
              let buf = "";
              res.on("data", (c) => (buf += c));
              res.on("end", () => {
                let body: any = buf;
                try { body = JSON.parse(buf); } catch { /* raw */ }
                resolve({ status: res.statusCode || 0, headers: res.headers, body });
              });
            });
            req.on("error", () => resolve({ status: 0, headers: {}, body: null }));
            req.end();
          });
        const routes = [
          "/admin/analytics/summary",
          "/admin/analytics/summary/720",
          "/admin/analytics/producers?hours=720",
          "/admin/analytics/cities?hours=720",
          "/admin/analytics/visitors?hours=720",
          "/admin/analytics/pages?hours=720",
          "/admin/analytics/umbrella-traffic?since_hours=720",
        ];
        const failing = await Promise.all(routes.map(get));
        ok(failing.every((r) => r.status === 503 && r.headers["retry-after"] === "30" && /temporarily unavailable/.test(r.body?.error) && /worker down/.test(r.body?.detail)),
          "H1: with the worker failing and nothing cached, all seven moved routes answer 503 + Retry-After (no synchronous fallback)",
          failing.map((r) => [r.status, r.headers["retry-after"], r.body]));

        mode = "ok";
        const good = await Promise.all(routes.map(get));
        const [sum, sumH, prod, cities, vis, pages, umb] = good.map((r) => r.body);
        ok(good.every((r) => r.status === 200), "H2: once the worker answers, every route is 200", good.map((r) => r.status));
        ok(eq(Object.keys(sum), ["timeframe", "vertical", "timestamp", "pageViews", "uniqueVisitors", "avgTimeOnSite", "totalQueries", "topSearchTerms", "trafficBySource", "agentTraffic", "ownerStats", "monthly_visits", "utm"]) &&
           sum.pageViews === 7 && sum.monthly_visits === 70 && sum.vertical === "all" && sum.timeframe === "last 24 hours",
          "H3: /summary keeps its exact JSON shape and key order", sum);
        ok(sumH.timeframe === "last 720 hours" && sumH.pageViews === 9 && !("monthly_visits" in sumH) &&
           prod.count === 1 && prod.limit === 20 && prod.producers[0].agentId === "a1" && prod.timeframe === "last 720 hours" &&
           cities.count === 1 && cities.cities[0].topCategory === "egg" &&
           eq(vis, { visitors: answers.visitors }) && eq(pages, { pages: answers.pages }) &&
           eq(umb, { success: true, since_hours: 720, umbrellas: [] }),
          "H4: /summary/:hours, /producers, /cities, /visitors, /pages and /umbrella-traffic keep their JSON shapes", { sumH, prod, cities, vis, pages, umb });
        const seenKeys = seen.map(adminStatsKey);
        ok(seenKeys.includes(adminStatsKey({ name: "producers", limit: 20, hours: 720 })) && seenKeys.includes(adminStatsKey({ name: "umbrellaTraffic", sinceHours: 720 })),
          "H5: the routes pass their parsed parameters to the worker task", seen);
      }
    } catch (e) {
      ok(false, "H: route tests threw", (e as Error).stack);
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    }
  }

  // ── L: the real worker, admin lane ───────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-stats-"));
  const dbPath = path.join(tmp, "stats.db");
  const writer = new Database(dbPath);
  try {
    __resetOffThreadStatsForTesting();
    writer.pragma("journal_mode = WAL");
    const prevLog = console.log;
    console.log = () => {};
    try {
      __initSchemaForTesting(writer);
    } finally {
      console.log = prevLog;
    }
    const nowMs = Date.now();
    seedAnalytics(writer, nowMs, 7);
    writer.exec(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, umbrella_type)
      VALUES ('u1', 'Hanen', 'x', 'x', 'x@example.com', 'https://example.com', 'producer', 'key-u1', 'network');
    `);

    const queries: AdminStatsQuery[] = [
      { name: "summary24" },
      { name: "summary24", vertical: "rfb" },
      { name: "summary", hours: 720 },
      { name: "producers", limit: 20, hours: 720 },
      { name: "cities", hours: 720, vertical: "rfb" },
      { name: "visitors", hours: 720, limit: 50 },
      { name: "pages", hours: 720, limit: 20, vertical: "dental" },
      { name: "umbrellaTraffic", sinceHours: 720 },
    ];
    let bad: unknown = null;
    for (const q of queries) {
      const expected = runAdminStatsQuery(writer, q, nowMs);
      const got = await runStatsTaskOffThread(dbPath, { kind: "adminStats", query: q, nowMs });
      if (!eq(got, expected)) bad = bad ?? { q, got, expected };
    }
    ok(bad === null, "L1: every admin query computed in the worker equals the synchronous computation", bad);
    const st1 = getOffThreadStatsState();
    ok(st1.lanes.admin.workerRunning && !st1.lanes.background.workerRunning && st1.lastRuns["adminStats:summary24"]?.ok === true,
      "L2: admin tasks run in the admin lane's own worker and report under adminStats:<name>", st1);

    // L3: an admin task completes while the background lane is stuck.
    __resetOffThreadStatsForTesting();
    const stuck = path.join(tmp, "stuck-worker.js");
    fs.writeFileSync(stuck, "const { parentPort } = require('worker_threads'); parentPort.on('message', () => {});\n");
    __setWorkerScriptForTesting(stuck, "background");
    const bg = runStatsTaskOffThread(dbPath, { kind: "pageViewCounts", nowMs }, 60_000);
    bg.catch(() => {});
    const adminRes = await runStatsTaskOffThread<any[]>(dbPath, { kind: "adminStats", query: { name: "pages", hours: 720, limit: 5 }, nowMs });
    const st3 = getOffThreadStatsState();
    ok(Array.isArray(adminRes) && st3.lanes.background.pendingTasks === 1 && st3.lanes.admin.pendingTasks === 0,
      "L3: an admin task is answered while a background task is still stuck in the other lane", { adminRes, lanes: st3.lanes });
    __resetOffThreadStatsForTesting();

    // L4: admin keys fail without ever being marked broken.
    const broken = path.join(tmp, "missing.db");
    const empty = new Database(broken);
    empty.pragma("journal_mode = WAL");
    empty.exec("CREATE TABLE t (x)");
    empty.close();
    let errs = 0;
    for (let i = 0; i < OFFTHREAD_MAX_CONSECUTIVE_FAILURES + 1; i++) {
      try {
        await runStatsTaskOffThread(broken, { kind: "adminStats", query: { name: "visitors", hours: 24, limit: 5 }, nowMs });
      } catch {
        errs++;
      }
    }
    const st4 = getOffThreadStatsState();
    ok(errs === OFFTHREAD_MAX_CONSECUTIVE_FAILURES + 1 && st4.failuresByTask["adminStats:visitors"] === errs && !st4.brokenKeys.includes("adminStats:visitors") && !st4.broken,
      "L4: failing admin tasks are counted but never trip the synchronous fallback", st4);

    // L5: the worker's import graph never loads database/init.
    const probe = path.join(tmp, "graph.ts");
    fs.writeFileSync(probe, `
      require(${JSON.stringify(path.resolve(__dirname, "offthread-stats-worker"))});
      const loaded = Object.keys(require.cache).some((k) => /[\\\\/]database[\\\\/]init\\.(ts|js)$/.test(k));
      console.log("INIT_LOADED:" + loaded);
    `);
    const { spawnSync } = await import("child_process");
    const out = spawnSync(process.execPath, [require.resolve("tsx/cli"), probe], { encoding: "utf8", timeout: 60_000 });
    ok(out.status === 0 && /INIT_LOADED:false/.test(out.stdout), "L5: the stats worker's import graph does not load database/init", { status: out.status, out: out.stdout, err: out.stderr });
  } catch (e) {
    ok(false, "L: worker tests threw", (e as Error).stack);
  } finally {
    __resetOffThreadStatsForTesting();
    writer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  process.env.OFFTHREAD_STATS_DISABLED = "1";
  if (!process.env.ADMIN_KEY) process.env.ADMIN_KEY = "standalone-admin-key";
  runAdminStatsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
