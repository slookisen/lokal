/**
 * client-ip-shadow-store.test.ts — dev-request 2026-10-16-klient-ip-fra-fly-
 * client-ip, trinn 1c: the AC2 counters survive a deploy, and the server
 * judges AC2 itself.
 *
 * Proves services/client-ip-shadow-store.ts and its use in
 * middleware/client-ip.ts:
 *   A  the table (DDL read out of database/init.ts, not copied): its columns
 *      hold counters and no IP, key or hash.
 *   B  the store: enqueue never touches the DB; one row per window, starts
 *      strictly increasing, queue capped, UNIQUE (machine, window_start);
 *      a failing DB never throws and is never retried; 14-day retention,
 *      pruned at most once an hour by the same job; the timer writes.
 *   C  through the middleware: the request path never touches the DB (only
 *      enqueue is called there); each stored row equals the logged
 *      client_ip_stats line of its window; at most 12 rows an hour whatever
 *      the clock does; a restart (new process, new DB connection) reads the
 *      old windows and keeps summing; the per-window fanIn ratio, rated per
 *      limiter the way each limiter counts (ac2LimitersFor; review B1 of PR
 *      #1130); legacy stores nothing but still reads; only shadow rows are
 *      summed (C8); the windows behind an "= 0 or explained" criterion (C9).
 *   D  evaluateClientIpAc2: every criterion at its exact threshold, each one
 *      alone flipping `ready`, nothing measured → not ready.
 *   E  end to end: 575 stored windows (47.9 h) → ac2.ready false on
 *      hours_covered alone; the 576th (48 h) → true.
 *   F  the existing GET /admin/analytics/ops/event-loop carries
 *      clientIp.cumulative / clientIp.ac2; a failing read gives
 *      { error: "read_failed" } and the rest still answers.
 *   G  installClientIp: off Fly no store (no DB at all); on Fly the main-DB
 *      store by default.
 *   H  AC2_FANIN_LIMITS pinned against the limiter sources, ac2LimitersFor
 *      against every place the four 15-min limiters are applied.
 *   I  trinn 1d, AC2 measures what enforce would do: the fanIn ratio over
 *      20 min is an upper bound for every 15-min span (two bursts 11 min
 *      apart, review S1 of PR #1130; a seeded sweep against a brute-force
 *      sliding 15-min count), top15m unchanged; /mcp with a session its
 *      router holds counts only against the brake, any other /mcp (bare, a
 *      stale or made-up id) against the primary too (review S2; B1 of PR
 *      #1151), by mcpPrimaryKey with the routers' own session check — in
 *      parity with the real MCP chains over HTTP (RateLimit-Remaining, their
 *      stores, their 429s), and through installClientIp's default
 *      (isKnownToAnMcpRouter) with the real routers, which it reads only
 *      while loaded and never loads — also in `npm test`, where earlier
 *      suites have loaded them (review S1 of PR #1151); covered_ms — a process
 *      starting mid-window covers the rest of it only, two machines in one
 *      window count it once, the migration keeps old rows as full windows;
 *      the store's timer flush runs inside trackJob.
 *   J  trinn 1e: non_public_by per range code, route and UA class is stored
 *      per row (non_public_by_json, compact) and summed in cumulative across
 *      a restart; rows from before the column (NULL) or with an untrusted
 *      breakdown read as `unknown`, counted in unknown_rows; each split sums
 *      to fallback.non_public; codes and counts only, no IP.
 *
 * Own in-memory / temp-file DBs, injected clocks, no timers except B's one
 * short unref'd timer (stopped). The DB-accessor failure hook and the
 * installed-instance slot are reset at the end.
 *
 * Standalone: npx tsx src/services/client-ip-shadow-store.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import { MemoryStore } from "express-rate-limit";
import { randomUUID } from "crypto";
import { once } from "events";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import {
  AC2_FANIN_LIMITS,
  ac2LimitersFor,
  AC2_THRESHOLDS,
  createClientIpMiddleware,
  evaluateClientIpAc2,
  getInstalledClientIpSnapshot,
  installClientIp,
  isKnownToAnMcpRouter,
  MCP_ROUTER_SESSION_CHECKS,
  mcpSessionKeyed,
  __resetInstalledClientIpForTesting,
  type ClientIpAc2,
  type ClientIpConfig,
  type ClientIpCounters,
  type ClientIpCumulative,
  type ClientIpOpsSnapshot,
} from "../middleware/client-ip";
import { createMcpRateLimiters, MCP_RATE_LIMIT_PROFILES, mcpPrimaryKey, type McpLimiterName } from "../middleware/mcp-rate-limit";
import { __setDbAccessorFailureForTesting } from "../database/init";
import { getEventLoopReport } from "./event-loop-monitor";
import {
  CLIENT_IP_WINDOW_RETENTION_DAYS,
  FLUSH_JOB_NAME,
  createClientIpShadowStore,
  type ClientIpShadowStore,
  type ClientIpShadowStoreDeps,
  type ClientIpWindowRecord,
} from "./client-ip-shadow-store";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const APP_IP = "66.241.125.60";
const flyXff = (client: string, ...clientSent: string[]): string => [...clientSent, client, APP_IP].join(", ");
const SHADOW: ClientIpConfig = { mode: "shadow", onFly: true, reason: "default" };
const ENFORCE: ClientIpConfig = { mode: "enforce", onFly: true, reason: "env" };
const LEGACY_ON_FLY: ClientIpConfig = { mode: "legacy", onFly: true, reason: "env" };
const OFF_FLY: ClientIpConfig = { mode: "legacy", onFly: false, reason: "not_on_fly" };
const CHATGPT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

// 2026-10-17T12:00:00Z, on an hour boundary.
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const W = 5 * 60_000;
const H = 3_600_000;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

const COLUMNS = [
  "id", "window_start", "machine", "mode",
  "n", "fci_valid", "fallback_missing", "fallback_invalid", "fallback_non_public", "fallback_hc", "errors",
  "xff_client_supplied", "agree_fci_edge_n", "agree_fci_edge_agree", "agree_legacy_eq_fci_n", "agree_legacy_eq_fci_agree",
  "would_trip", "top_overflow", "fanin_ratio", "fanin_class", "fanin_fan_in", "fanin_ua", "created_at",
  "covered_ms", "non_public_by_json",
];
const NO_NONZERO_WINDOWS = { top_overflow: { windows: 0, last: null }, invalid_non_public: { windows: 0, last: null } };
const CRITERIA = [
  "hours_covered", "requests", "fallback_beyond_health_checks", "invalid_non_public", "agree_fci_edge",
  "agree_legacy_eq_fci", "would_trip", "fanin_limit_ratio", "top_overflow",
];

/** The table's migration, read out of database/init.ts (not copied): trinn 1c's CREATE + index, and every later ALTER on it. */
function loadDdl(): { create: string; alters: string[] } {
  const src = fs.readFileSync(path.join(__dirname, "..", "database", "init.ts"), "utf8");
  const m = src.match(/CREATE TABLE IF NOT EXISTS client_ip_shadow_windows \([\s\S]*?\);\s*CREATE INDEX IF NOT EXISTS idx_client_ip_shadow_windows_start[^;]*;/);
  if (!m) throw new Error("client_ip_shadow_windows DDL not found in database/init.ts");
  return { create: m[0], alters: src.match(/ALTER TABLE client_ip_shadow_windows ADD COLUMN [^`]*/g) ?? [] };
}

/** What init.ts runs on boot: the CREATE, then each ALTER, a duplicate column ignored as init.ts does. */
function migrate(db: Database.Database): void {
  const ddl = loadDdl();
  db.exec(ddl.create);
  for (const stmt of ddl.alters) {
    try {
      db.exec(stmt);
    } catch (err: any) {
      if (!String(err?.message || "").includes("duplicate column name")) throw err;
    }
  }
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

/** Every counter a distinct value (times k), so a swapped or dropped column shows. */
function counters(k = 1): ClientIpCounters {
  return {
    n: 1000 * k,
    fci_valid: 900 * k,
    fallback: { missing: 11 * k, invalid: 2 * k, non_public: 3 * k },
    fallback_hc: 10 * k,
    // Trinn 1e: each split of the 3k non_public different, so a swapped or dropped split shows.
    non_public_by: {
      range: { v4_10: 0, v4_172_16: 2 * k, v4_192_168: 0, v4_cgnat: 0, v4_loopback: 0, v4_link_local: 0, v4_other: 0, v6_ula: k, v6_reserved: 0, v6_link_local: 0, v6_multicast: 0 },
      route: { api: k, a2a: 0, mcp: 2 * k, other: 0 },
      ua: { none: 2 * k, "ai_search:claude": k },
    },
    errors: 4 * k,
    xff_client_supplied: 5 * k,
    agree_fci_edge: { n: 800 * k, agree: 799 * k },
    agree_legacy_eq_fci: { n: 700 * k, agree: 698 * k },
    would_trip: 6 * k,
    top_overflow: 7 * k,
  };
}

/**
 * Trinn 1e: counters as cumulative reads them back — non_public_by with
 * `unknown` (non_public of rows without a breakdown) in range, route and ua,
 * and unknown_rows.
 */
function stored(c: ClientIpCounters, unknown = 0, unknownRows = 0): ClientIpCounters {
  const by = c.non_public_by;
  return {
    ...c,
    non_public_by: { range: { ...by.range, unknown }, route: { ...by.route, unknown }, ua: { ...by.ua, unknown }, unknown_rows: unknownRows },
  };
}

const rec = (windowStart: number, k = 1, fanIn: ClientIpWindowRecord["fanIn"] = null, coveredMs = W): ClientIpWindowRecord => ({
  windowStart,
  mode: "shadow",
  counters: counters(k),
  fanIn,
  coveredMs,
});

/** A request object as the middleware sees it. */
function fakeReq(o: { fci?: unknown; xff?: unknown; ip?: string; path?: string; ua?: string; sid?: unknown }): any {
  const headers: Record<string, unknown> = {};
  if (o.fci !== undefined) headers["fly-client-ip"] = o.fci;
  if (o.xff !== undefined) headers["x-forwarded-for"] = o.xff;
  if (o.ua !== undefined) headers["user-agent"] = o.ua;
  if (o.sid !== undefined) headers["mcp-session-id"] = o.sid;
  return { headers, path: o.path ?? "/api/x", ip: o.ip };
}

/** One request over real HTTP (Node's http client: other suites stub the global fetch); the body is drained, not kept. */
function httpRequest(
  port: number,
  method: "GET" | "POST",
  reqPath: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: { ...headers, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** An express app on an ephemeral local port. */
async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const rowCount = (db: Database.Database): number => (db.prepare("SELECT COUNT(*) AS c FROM client_ip_shadow_windows").get() as any).c;

export async function runClientIpShadowStoreTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  /** A store over db with a counted accessor and a settable clock; no timer. */
  function storeOn(db: Database.Database, extra: Partial<ClientIpShadowStoreDeps> = {}) {
    let clock = T0;
    let dbCalls = 0;
    const store = createClientIpShadowStore({
      getDb: () => {
        dbCalls++;
        return db;
      },
      machine: "m1",
      now: () => clock,
      flushEveryMs: null,
      ...extra,
    });
    return { store, setNow: (t: number) => { clock = t; }, dbCalls: () => dbCalls };
  }

  /** A middleware with a settable clock; send() is one request at the current clock. */
  function rig(
    cfg: ClientIpConfig,
    store: ClientIpShadowStore | null,
    onRequest?: (inRequest: boolean) => void,
    isKnownMcpSession?: (sessionId: string) => boolean
  ) {
    let clock = T0;
    const lines: string[] = [];
    const mw = createClientIpMiddleware(cfg, { now: () => clock, log: (l) => lines.push(l), logError: () => {}, store, isKnownMcpSession });
    const sendReq = (req: any, at?: number) => {
      if (at !== undefined) clock = at;
      onRequest?.(true);
      try {
        mw(req, {} as any, () => {});
      } finally {
        onRequest?.(false);
      }
    };
    const send = (o: Parameters<typeof fakeReq>[0], at?: number) => sendReq(fakeReq(o), at);
    /** An ordinary client (Fly appended client + app IP only): agrees on both counters, fanIn 1. */
    const ordinary = (ip: string, at?: number) => send({ fci: ip, xff: flyXff(ip), ip }, at);
    return { mw, lines, send, sendReq, ordinary, setClock: (t: number) => { clock = t; } };
  }

  /** `n` ordinary clients spread over window w. */
  function normalWindow(r: ReturnType<typeof rig>, w: number, n = 9): void {
    for (let i = 0; i < n; i++) r.ordinary(`198.51.${(w * n + i) >> 8 & 255}.${(w * n + i) & 255}`, T0 + w * W + i * 1000);
  }

  const cum = (snap: ClientIpOpsSnapshot): ClientIpCumulative => snap.cumulative as ClientIpCumulative;
  const failing = (ac2: ClientIpAc2 | null) => Object.entries(ac2?.criteria ?? {}).filter(([, c]) => !c.pass).map(([k]) => k);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cips-"));
  try {
    // ── A. The table ──
    {
      const db = freshDb();
      const cols = (db.prepare("PRAGMA table_info(client_ip_shadow_windows)").all() as any[]).map((c) => c.name);
      assertEq(cols, COLUMNS, "A: client_ip_shadow_windows has exactly the counter, fanIn, mode, machine and time columns");
      assertTrue(!cols.some((c) => /(^|_)(ip|key|hash)($|_)/.test(c)), "A: no IP, key or hash column");
      const idx = (db.prepare("PRAGMA index_list(client_ip_shadow_windows)").all() as any[]).map((i) => i.name);
      assertTrue(idx.includes("idx_client_ip_shadow_windows_start") && idx.some((i) => i.startsWith("sqlite_autoindex")), "A: window_start index + the UNIQUE (machine, window_start) index");
      migrate(db);
      assertEq(
        (db.prepare("PRAGMA table_info(client_ip_shadow_windows)").all() as any[]).map((c) => c.name),
        COLUMNS,
        "A: the migration is idempotent (re-run without error, no column added twice)"
      );
      db.close();
    }

    // ── B. The store ──
    {
      const db = freshDb();
      const s = storeOn(db);
      s.store.enqueue(rec(T0, 1));
      s.store.enqueue(rec(T0 + W, 2, { ratio: 0.25, class: "a2a", fanIn: 3, ua: "ai_search:claude" }));
      assertEq([s.dbCalls(), s.store.writerStats().queued, rowCount(db)], [0, 2, 0], "B1: enqueue only queues — the DB is not touched");
      s.setNow(T0 + 2 * W);
      assertEq(s.store.flush(), 2, "B1: flush writes the two queued windows");
      const calls = s.dbCalls();
      assertEq([s.store.flush(), s.dbCalls()], [0, calls], "B1: an empty queue with no prune due → flush returns before touching the DB");
      const rows = db.prepare("SELECT * FROM client_ip_shadow_windows ORDER BY window_start").all() as any[];
      assertEq(
        rows.map((r) => [r.window_start, r.machine, r.mode, r.n, r.fallback_invalid, r.agree_legacy_eq_fci_agree, r.top_overflow, r.fanin_ratio, r.fanin_class, r.fanin_fan_in, r.fanin_ua, r.created_at]),
        [
          [iso(T0), "m1", "shadow", 1000, 2, 698, 7, null, null, null, null, iso(T0 + 2 * W)],
          [iso(T0 + W), "m1", "shadow", 2000, 4, 1396, 14, 0.25, "a2a", 3, "ai_search:claude", iso(T0 + 2 * W)],
        ],
        "B1: one row per window: start, machine, mode, counters, fanIn (null when none), write time"
      );
      const t = s.store.totals("shadow");
      assertEq(
        [t.rows, t.windows, t.machines, t.first, t.last, t.counters, t.fanInMax],
        [2, 2, 1, iso(T0), iso(T0 + W), stored(counters(3)), { ratio: 0.25, class: "a2a", fanIn: 3, ua: "ai_search:claude", window_start: iso(T0 + W) }],
        "B2: totals sum every counter field by field (1× + 2× = 3×) and give the largest fanIn row"
      );
      assertEq(
        t.nonzero,
        { top_overflow: { windows: 2, last: iso(T0 + W) }, invalid_non_public: { windows: 2, last: iso(T0 + W) } },
        "B2: … and, for the two \"= 0 or explained\" criteria, how many rows had any and the newest one"
      );
      s.store.enqueue(rec(T0 + W));
      s.store.enqueue(rec(T0));
      assertEq([s.store.writerStats().out_of_order, s.store.writerStats().queued], [2, 0], "B3: a window start not after the previous one (same or earlier) is not queued");
      db.close();
    }
    {
      const db = freshDb();
      const s = storeOn(db);
      for (let i = 0; i < 13; i++) s.store.enqueue(rec(T0 + i * W));
      assertEq([s.store.writerStats().queued, s.store.writerStats().dropped], [12, 1], "B4: the queue holds at most 12 windows (one hour); the 13th is dropped and counted");
      assertEq([s.store.flush(), rowCount(db)], [12, 12], "B4: … and the 12 are written in one flush");
      db.close();
    }
    {
      const db = freshDb();
      const a = storeOn(db);
      const b = storeOn(db);
      const other = storeOn(db, { machine: "m2" });
      a.store.enqueue(rec(T0));
      b.store.enqueue(rec(T0, 5));
      other.store.enqueue(rec(T0, 2));
      assertEq([a.store.flush(), b.store.flush(), other.store.flush()], [1, 0, 1], "B5: UNIQUE (machine, window_start): the same machine's same window is written once");
      const t = a.store.totals("shadow");
      assertEq([t.rows, t.windows, t.machines, t.counters.n], [2, 1, 2, 3000], "B5: two machines, one window: 2 rows, 1 distinct window, 2 machines");
      assertEq([b.store.writerStats().persisted, b.store.writerStats().errors], [0, 0], "B5: the ignored duplicate is neither persisted nor an error (INSERT OR IGNORE)");
      const c = rig(SHADOW, a.store).mw.opsSnapshot().cumulative as ClientIpCumulative;
      assertEq([c.windows, c.machines, c.hours_covered], [2, 2, 5 / 60], "B5: two machines in the same 5 min cover 5 min, not 10 (hours from distinct windows)");
      db.close();
    }
    {
      let throws = true;
      const db = freshDb();
      const s = storeOn(db, { getDb: () => { if (throws) throw new Error("db down"); return db; } });
      s.store.enqueue(rec(T0));
      s.store.enqueue(rec(T0 + W));
      let threw = false;
      let written = -1;
      try { written = s.store.flush(); } catch { threw = true; }
      assertEq([threw, written, s.store.writerStats()], [false, 0, { persisted: 0, dropped: 2, out_of_order: 0, errors: 1, pruned: 0, queued: 0 }], "B6: a DB that throws: flush never throws, the batch is dropped and counted, never retried");
      throws = false;
      assertEq([s.store.flush(), rowCount(db)], [0, 0], "B6: … the next flush does not write it again");
      const noTable = new Database(":memory:");
      const n = storeOn(noTable);
      n.store.enqueue(rec(T0));
      let threw2 = false;
      try { n.store.flush(); } catch { threw2 = true; }
      assertEq([threw2, n.store.writerStats().errors >= 1, n.store.writerStats().dropped], [false, true, 1], "B6: no table (migration failed): flush never throws, counts the error");
      let totalsThrew = false;
      try { n.store.totals("shadow"); } catch { totalsThrew = true; }
      assertTrue(totalsThrew, "B6: totals() throws on a failed read (the snapshot reports it as read_failed)");
      const clockThrows = storeOn(db, { now: () => { throw new Error("clock"); } });
      clockThrows.store.enqueue(rec(T0));
      let threw3 = false;
      let written3 = -1;
      try { written3 = clockThrows.store.flush(); } catch { threw3 = true; }
      assertEq([threw3, written3, clockThrows.store.writerStats().errors], [false, 0, 1], "B6: anything else that throws inside flush (here the clock) is caught too — flush runs on a timer");
      noTable.close();
      db.close();
    }
    {
      // Retention: 14 days, pruned by the writer itself, at most once an hour.
      const db = freshDb();
      const now = T0 + 20 * DAY;
      const s = storeOn(db);
      s.setNow(now);
      const cutoff = now - CLIENT_IP_WINDOW_RETENTION_DAYS * DAY;
      s.store.enqueue(rec(cutoff - W));
      s.store.enqueue(rec(cutoff));
      s.store.enqueue(rec(now - W));
      s.store.flush();
      assertEq(
        [CLIENT_IP_WINDOW_RETENTION_DAYS, (db.prepare("SELECT window_start FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((r) => r.window_start), s.store.writerStats().pruned],
        [14, [iso(cutoff), iso(now - W)], 1],
        "B7: the first flush deletes windows older than 14 days (exactly 14 days old is kept)"
      );
      const ins = db.prepare("INSERT INTO client_ip_shadow_windows (window_start, machine, mode, n, fci_valid, fallback_missing, fallback_invalid, fallback_non_public, fallback_hc, errors, xff_client_supplied, agree_fci_edge_n, agree_fci_edge_agree, agree_legacy_eq_fci_n, agree_legacy_eq_fci_agree, would_trip, top_overflow, created_at) VALUES (?, 'm9', 'shadow', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)");
      ins.run(iso(cutoff - DAY), iso(now));
      s.setNow(now + H - 1);
      s.store.enqueue(rec(now));
      s.store.flush();
      assertEq(rowCount(db), 4, "B7: within the hour after a prune, an old row (another machine's) stays");
      s.setNow(now + H);
      s.store.flush();
      assertEq(
        [(db.prepare("SELECT window_start FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((r) => r.window_start), s.store.writerStats().pruned],
        [[iso(now - W), iso(now)], 3],
        "B7: one hour later the same job prunes again with nothing queued: the old row, and the one now past 14 days"
      );
      db.close();
    }
    {
      // The timer, started by the first enqueue, writes without any flush() call.
      const db = freshDb();
      const s = storeOn(db, { flushEveryMs: 10 });
      s.store.enqueue(rec(T0));
      for (let i = 0; i < 50 && rowCount(db) === 0; i++) await new Promise((r) => setTimeout(r, 10));
      s.store.stop();
      assertEq([rowCount(db), s.store.writerStats().persisted], [1, 1], "B8: the store's own timer writes the queued window");
      db.close();
    }

    // ── C. Through the middleware ──
    for (const cfg of [SHADOW, ENFORCE]) {
      // C1: the request path never touches the DB; only enqueue is called there.
      const db = freshDb();
      let inRequest = false;
      let dbInRequest = 0;
      const calledInRequest: string[] = [];
      const s = storeOn(db, { getDb: () => { if (inRequest) dbInRequest++; return db; } });
      const spy: ClientIpShadowStore = {
        enqueue: (r) => { if (inRequest) calledInRequest.push("enqueue"); s.store.enqueue(r); },
        flush: () => { if (inRequest) calledInRequest.push("flush"); return s.store.flush(); },
        totals: (mode) => { if (inRequest) calledInRequest.push("totals"); return s.store.totals(mode); },
        writerStats: () => { if (inRequest) calledInRequest.push("writerStats"); return s.store.writerStats(); },
        stop: () => { if (inRequest) calledInRequest.push("stop"); s.store.stop(); },
      };
      const r = rig(cfg, spy, (v) => { inRequest = v; });
      for (let w = 0; w < 30; w++) {
        normalWindow(r, w, 3);
        if (w % 5 === 4) {
          s.setNow(T0 + w * W + 4 * 60_000);
          s.store.flush();
        }
      }
      s.store.flush();
      assertEq([dbInRequest, rowCount(db)], [0, 29], `C1: ${cfg.mode} — 90 requests over 30 windows: 29 closed windows stored, zero DB access inside a request`);
      assertEq([...new Set(calledInRequest)], ["enqueue"], `C1: ${cfg.mode} — the request path calls only enqueue on the store`);
      assertEq(calledInRequest.length, 29, `C1: ${cfg.mode} — once per closed window`);
      db.close();
    }
    {
      // C2: each stored row is exactly the logged client_ip_stats line of its window (every counter ≠ 0).
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      const sendXff = (fci: string, xff: string) => r.send({ fci, xff, ip: xff.split(",")[0].trim() });
      r.setClock(T0);
      for (let i = 0; i < 80; i++) sendXff("198.51.100.7", flyXff(`203.0.113.${1 + (i % 20)}`)); // collapse shape
      r.setClock(T0 + 10_000);
      sendXff("198.51.100.7", flyXff("203.0.113.1")); // breaker evaluates → would_trip
      sendXff("198.51.100.1", flyXff("198.51.100.1", "203.0.113.9")); // client-sent XFF
      sendXff("198.51.100.2", flyXff("198.51.100.99")); // disagreement
      r.send({ path: "/health" }); // missing, health check
      r.send({ xff: flyXff("198.51.100.3"), ip: "198.51.100.3" }); // missing
      r.send({ fci: "garbage", xff: flyXff("198.51.100.4"), ip: "198.51.100.4" }); // invalid
      r.send({ fci: "10.1.2.3", xff: flyXff("198.51.100.5"), ip: "198.51.100.5" }); // non_public
      const throwingIp: any = fakeReq({ fci: "198.51.100.6", xff: flyXff("198.51.100.6") });
      Object.defineProperty(throwingIp, "ip", { get() { throw new Error("boom"); } });
      r.sendReq(throwingIp); // errors
      for (let i = 0; i < 1030; i++) r.ordinary(`198.51.${10 + (i >> 8)}.${i & 255}`); // past TOP_CAP → top_overflow
      r.ordinary("198.51.100.1", T0 + W); // closes window T0
      s.store.flush();
      const line = JSON.parse(r.lines[0] ?? "{}");
      const row = db.prepare("SELECT * FROM client_ip_shadow_windows").get() as any;
      const fromRow = s.store.totals("shadow").counters;
      const fromLine: ClientIpCounters = {
        n: line.n, fci_valid: line.fci_valid, fallback: line.fallback, fallback_hc: line.fallback_hc,
        non_public_by: stored({ non_public_by: line.non_public_by } as ClientIpCounters).non_public_by, errors: line.errors,
        xff_client_supplied: line.xff_client_supplied, agree_fci_edge: line.agree_fci_edge, agree_legacy_eq_fci: line.agree_legacy_eq_fci,
        would_trip: line.would_trip, top_overflow: line.top_overflow,
      };
      const leaves = (o: any): number[] => (typeof o === "number" ? [o] : Object.values(o ?? {}).flatMap(leaves));
      // non_public_by splits the one non_public over its keys (the rest 0; section J pins it).
      assertTrue(r.lines.length === 1 && leaves({ ...fromLine, non_public_by: undefined }).every((v) => v > 0), "C2: (setup) the logged window has every counter non-zero");
      assertEq([row?.window_start, row?.mode, fromRow], [line.window_start, "shadow", fromLine], "C2: the stored row is the logged line's window, field by field");
      db.close();
    }
    {
      // C3: at most 12 rows an hour per machine, whatever the clock does.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      for (let w = 0; w < 12; w++) {
        r.ordinary("198.51.100.1", T0 + w * W);
        if (w > 0) r.ordinary("198.51.100.1", T0 + (w - 1) * W + 1000); // the clock jumps back a window
        r.ordinary("198.51.100.1", T0 + w * W + 2000);
      }
      r.ordinary("198.51.100.1", T0 + H); // closes the hour's last window
      s.setNow(T0 + H + 1000);
      s.store.flush();
      const starts = (db.prepare("SELECT window_start FROM client_ip_shadow_windows ORDER BY id").all() as any[]).map((x) => x.window_start);
      assertEq(starts, Array.from({ length: 12 }, (_, w) => iso(T0 + w * W)), "C3: a clock jumping back and forth over one hour stores each of its 12 windows once, in order");
      assertTrue(r.lines.length > 12 && s.store.writerStats().out_of_order > 0, `C3: … although the log rotated ${r.lines.length} times (out_of_order ${s.store.writerStats().out_of_order})`);
      db.close();
    }
    {
      // C4: a restart — a new process and DB connection — reads the old windows and keeps summing.
      const file = path.join(tmp, "restart.db");
      const dbA = new Database(file);
      migrate(dbA);
      const a = storeOn(dbA);
      const ra = rig(SHADOW, a.store);
      for (let w = 0; w < 5; w++) normalWindow(ra, w); // windows 0..3 close; window 4 is open at "SIGTERM"
      a.setNow(T0 + 4 * W + 30_000);
      a.store.flush();
      const before = cum(ra.mw.opsSnapshot());
      assertEq(
        [before.since, before.until, before.windows, before.machines, before.hours_covered, before.counters.n, ra.mw.opsSnapshot().since_boot.n],
        [iso(T0), iso(T0 + 4 * W), 4, 1, (4 * 5) / 60, 36, 45],
        "C4: process A — 4 closed windows stored (36 requests); its open window (9) is only in since_boot"
      );
      dbA.close();

      const dbB = new Database(file);
      migrate(dbB);
      const b = storeOn(dbB);
      const rb = rig(SHADOW, b.store);
      const fresh = rb.mw.opsSnapshot();
      assertEq(
        [fresh.since_boot.n, cum(fresh).since, cum(fresh).windows, cum(fresh).hours_covered, cum(fresh).counters],
        [0, iso(T0), 4, (4 * 5) / 60, before.counters],
        "C4: process B, before any request: since_boot is 0 but cumulative continues from A (not from zero)"
      );
      for (let w = 6; w < 10; w++) normalWindow(rb, w); // windows 6..8 close
      b.setNow(T0 + 9 * W + 30_000);
      b.store.flush();
      const after = cum(rb.mw.opsSnapshot());
      assertEq(
        [after.since, after.until, after.windows, after.hours_covered, after.counters.n, after.counters.agree_fci_edge, rb.mw.opsSnapshot().since_boot.n],
        [iso(T0), iso(T0 + 9 * W), 7, (7 * 5) / 60, 63, { n: 63, agree: 63 }, 36],
        "C4: after B's windows: A + B summed (63), since stays A's first window; the unstored window 4 and B's open one do not count as hours"
      );
      dbB.close();
    }
    {
      // C5: cumulative is what is stored — a closed window waits in the queue until the timer writes it.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      normalWindow(r, 0);
      r.ordinary("198.51.100.200", T0 + W);
      const queued = r.mw.opsSnapshot();
      assertEq([cum(queued).windows, cum(queued).writer.queued, cum(queued).writer.persisted], [0, 1, 0], "C5: closed but not yet written → not in cumulative, visible as writer.queued");
      s.setNow(T0 + W + 30_000);
      s.store.flush();
      const written = r.mw.opsSnapshot();
      assertEq([cum(written).windows, cum(written).writer.queued, cum(written).writer.persisted], [1, 0, 1], "C5: after the timer's flush → in cumulative");
      db.close();
    }
    {
      // C6: legacy (a rollback) stores nothing, but still reads what shadow stored.
      const db = freshDb();
      const s = storeOn(db);
      const shadow = rig(SHADOW, s.store);
      normalWindow(shadow, 0);
      shadow.ordinary("198.51.100.200", T0 + W);
      s.setNow(T0 + W + 1000);
      s.store.flush();
      let enqueued = 0;
      const legacyStore: ClientIpShadowStore = { ...s.store, enqueue: () => { enqueued++; } };
      const legacy = rig(LEGACY_ON_FLY, legacyStore);
      for (let w = 2; w < 6; w++) normalWindow(legacy, w);
      const snap = legacy.mw.opsSnapshot();
      assertEq([enqueued, rowCount(db), snap.since_boot.n, cum(snap).windows, snap.ac2?.ready], [0, 1, 0, 1, false], "C6: legacy — nothing enqueued or stored; cumulative and ac2 still read the stored windows");
      db.close();
    }
    {
      // C7: the per-window fanIn ratio — a key with fanIn > 1, its requests per limiter over the window and the 3 before it (20 min, trinn 1d) / that limit.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      const k1 = (n: number, pathName: string, at: number) => {
        for (let i = 0; i < n; i++) {
          const spoof = i % 2 === 0 ? "203.0.113.1" : "203.0.113.2";
          r.send({ fci: "198.51.100.1", xff: flyXff("198.51.100.1", spoof), ip: spoof, path: pathName, ua: CHATGPT_UA }, at + i);
        }
      };
      // A heavy key with fanIn 1 is not rated, however close to a limit.
      const k2 = (n: number, at: number) => { for (let i = 0; i < n; i++) r.ordinary("198.51.100.2", at + i); };
      k1(100, "/api/products", T0);
      k2(290, T0 + 1000);
      k1(140, "/api/products", T0 + W);
      k1(60, "/mcp", T0 + 2 * W);
      k2(10, T0 + 3 * W);
      k2(1, T0 + 4 * W);
      k2(1, T0 + 5 * W);
      k2(1, T0 + 6 * W);
      s.setNow(T0 + 6 * W + 1000);
      s.store.flush();
      const rows = (db.prepare("SELECT window_start, fanin_ratio, fanin_class, fanin_fan_in, fanin_ua FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((x) => [
        x.window_start, x.fanin_ratio === null ? null : Math.round(x.fanin_ratio * 1e6) / 1e6, x.fanin_class, x.fanin_fan_in, x.fanin_ua,
      ]);
      assertEq(
        rows,
        [
          [iso(T0), 0.333333, "general", 2, "ai_search:chatgpt"],
          [iso(T0 + W), 0.8, "general", 2, "ai_search:chatgpt"],
          [iso(T0 + 2 * W), 0.8, "general", 2, "ai_search:chatgpt"],
          [iso(T0 + 3 * W), 0.8, "general", 2, "ai_search:chatgpt"],
          [iso(T0 + 4 * W), 0.466667, "general", 2, "ai_search:chatgpt"],
          [iso(T0 + 5 * W), 0.3, "mcp", 2, "ai_search:chatgpt"],
        ],
        "C7: per window, the 20-min span's largest requests/limit of a fanIn > 1 key (/api 100 → 240 of 300 while the first window is in the span, 140 once it leaves, then bare /mcp 60 of the primary's 200); a fanIn 1 key (290 /api) is never rated"
      );
      const snap = r.mw.opsSnapshot();
      assertEq(cum(snap).fanin_max, { ratio: 0.8, class: "general", fanIn: 2, ua: "ai_search:chatgpt", window_start: iso(T0 + 3 * W) }, "C7: cumulative.fanin_max is the largest stored (newest on a tie), with its class, fanIn and UA family");
      assertEq(snap.ac2?.criteria.fanin_limit_ratio, { value: 0.8, threshold: 0.8, op: "<", pass: false }, "C7: a fanIn > 1 key at 80 % of its limit fails the criterion");
      db.close();
    }
    {
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      for (let i = 0; i < 250; i++) {
        const spoof = `203.0.113.${i % 3}`;
        r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9", spoof), ip: spoof, path: i < 100 ? "/a2a" : "/mcp" }, T0 + i);
      }
      r.ordinary("198.51.100.200", T0 + W);
      s.setNow(T0 + W + 1000);
      s.store.flush();
      const row = db.prepare("SELECT fanin_ratio, fanin_class, fanin_fan_in, fanin_ua FROM client_ip_shadow_windows").get() as any;
      assertEq([row?.fanin_ratio, row?.fanin_class, row?.fanin_fan_in, row?.fanin_ua], [0.75, "mcp", 3, "none"], "C7: 100 /a2a (0.5 of jsonRpcLimiter's 200, 0.1 of dentalLimiter's 1 000) and 150 /mcp (0.75 of 200) → the largest, mcp");
      db.close();
    }
    {
      // C7 (review B1 of PR #1130): a key is rated per limiter, counted the way that limiter counts.
      assertEq(
        [
          "/api/products", "/api", "/api/", "/API/products", "/apix", "/en/api/products",
          "/api/marketplace/search", "/api/marketplace/discover/x", "/api/marketplace/searchx",
          "/api/tannlege", "/api/tannlege/klinikker", "/api/tannlegex", "/Api/Tannlege/x",
          "/ut/a1/web", "/utx", "/reise", "/en/reise", "/sv/reise", "/sok", "/sok/", "/en/sok", "/sok/x",
          "/for-tilbydere/finn", "/For-Tilbydere/Finn/", "/en/for-tilbydere/finn", "/for-tilbydere", "/for-tilbydere/finnx",
          "/kategori/gardssalg/book/gard-x", "/kategori/gardssalg/book/gard-x/", "/kategori/gardssalg/book",
          "/kategori/gardssalg/book/gard-x/confirm/R1",
          "/kategori/gardssalg/eier/gard-x", "/kategori/gardssalg/eier/magic-link-verify", "/Kategori/Gardssalg/Eier/p1/request",
          "/en/kategori/gardssalg/eier/gard-x/portal", "/kategori/gardssalg/eier", "/kategori/gardssalg/eierx", "/kategori/gardssalg",
          "/api/opplevelser/gardssalg-claim/p1/session-status",
          "/a2a", "/en/a2a", "/mcp", "/mcp/x", "/MCP", "/en/mcp", "/mcpx", "/health", "/", "/produsent/x",
        ].map((p) => [p, ac2LimitersFor(p)]),
        [
          ["/api/products", ["general"]], ["/api", ["general"]], ["/api/", ["general"]], ["/API/products", ["general"]], ["/apix", []], ["/en/api/products", ["general"]],
          ["/api/marketplace/search", ["general", "search"]], ["/api/marketplace/discover/x", ["general", "search"]], ["/api/marketplace/searchx", ["general"]],
          ["/api/tannlege", ["dental"]], ["/api/tannlege/klinikker", ["dental"]], ["/api/tannlegex", []], ["/Api/Tannlege/x", ["general", "dental"]],
          ["/ut/a1/web", ["general"]], ["/utx", []], ["/reise", ["general"]], ["/en/reise", ["general"]], ["/sv/reise", ["general"]], ["/sok", ["general"]], ["/sok/", ["general"]], ["/en/sok", ["general"]], ["/sok/x", []],
          ["/for-tilbydere/finn", ["general"]], ["/For-Tilbydere/Finn/", ["general"]], ["/en/for-tilbydere/finn", ["general"]], ["/for-tilbydere", []], ["/for-tilbydere/finnx", []],
          ["/kategori/gardssalg/book/gard-x", ["general"]], ["/kategori/gardssalg/book/gard-x/", ["general"]], ["/kategori/gardssalg/book", []],
          ["/kategori/gardssalg/book/gard-x/confirm/R1", []],
          ["/kategori/gardssalg/eier/gard-x", ["general"]], ["/kategori/gardssalg/eier/magic-link-verify", ["general"]], ["/Kategori/Gardssalg/Eier/p1/request", ["general"]],
          ["/en/kategori/gardssalg/eier/gard-x/portal", ["general"]], ["/kategori/gardssalg/eier", ["general"]], ["/kategori/gardssalg/eierx", []], ["/kategori/gardssalg", []],
          ["/api/opplevelser/gardssalg-claim/p1/session-status", ["general"]],
          ["/a2a", ["a2a", "dental"]], ["/en/a2a", ["a2a", "dental"]],
          ["/mcp", ["mcp", "mcp_brake"]], ["/mcp/x", ["mcp", "mcp_brake"]], ["/MCP", ["mcp", "mcp_brake"]], ["/en/mcp", ["mcp", "mcp_brake"]], ["/mcpx", []],
          ["/health", []], ["/", []], ["/produsent/x", []],
        ],
        "C7: ac2LimitersFor mirrors the mounts (segment-wise, case-insensitive, after the /en and /sv strip): search is also general; /api/tannlege* is not general (generalLimiter's case-sensitive skip) but dental; /a2a counts against jsonRpcLimiter and dentalLimiter; bare /mcp against the MCP primary and the brake"
      );
      // One key (fanIn 3) in one window; the fanIn ratio, its limiter, and whether the criterion passes.
      const rate = (traffic: Array<[string, number]>) => {
        const db = freshDb();
        const s = storeOn(db);
        const r = rig(SHADOW, s.store);
        let i = 0;
        for (const [p, n] of traffic) {
          for (let j = 0; j < n; j++, i++) {
            const spoof = `203.0.113.${i % 3}`;
            r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9", spoof), ip: spoof, path: p }, T0 + i);
          }
        }
        r.ordinary("198.51.100.200", T0 + W);
        s.setNow(T0 + W + 1000);
        s.store.flush();
        const snap = r.mw.opsSnapshot();
        const f = cum(snap).fanin_max;
        db.close();
        return [f === null ? null : Math.round(f.ratio * 1e6) / 1e6, f?.class ?? null, f?.fanIn ?? null, snap.ac2?.criteria.fanin_limit_ratio.pass];
      };
      assertEq(rate([["/api/marketplace/search", 130]]), [0.866667, "search", 3, false], "C7: 130 /api/marketplace/search → 130 of searchLimiter's 150 (0.867), not 130 of 300 (0.433): fails");
      assertEq(rate([["/api/products", 100], ["/reise", 200]]), [1, "general", 3, false], "C7: 100 /api + 200 /reise → one generalLimiter count, 300 of 300 (a 429 in enforce), not 0.333: fails");
      assertEq(rate([["/ut/a1/web", 250]]), [0.833333, "general", 3, false], "C7: 250 /ut → 250 of generalLimiter's 300 (0.833), not unrated: fails");
      assertEq(rate([["/en/sok", 130], ["/en/reise", 130]]), [0.866667, "general", 3, false], "C7: 130 /en/sok + 130 /en/reise → 260 of generalLimiter's 300 (the /en prefix is stripped before the limiters): fails");
      assertEq(rate([["/api/tannlege/klinikker", 200], ["/api/products", 200]]), [0.666667, "general", 3, true], "C7: 200 /api/tannlege + 200 /api → general 200 of 300 (tannlege is skipped there, not 400), dental 200 of 1 000: passes");
      assertEq(rate([["/api/tannlege/klinikker", 700], ["/a2a", 150]]), [0.85, "dental", 3, false], "C7: 700 /api/tannlege + 150 /a2a → dentalLimiter 850 of 1 000 (dental /a2a shares it), above /a2a's 150 of 200: fails");
    }
    {
      // C8 (review S2 of PR #1130): cumulative and ac2 sum shadow windows only; another mode's rows are kept, not summed.
      const db = freshDb();
      const shadowStore = storeOn(db);
      const enforceStore = storeOn(db, { machine: "m2" });
      const shadow = rig(SHADOW, shadowStore.store);
      const enforce = rig(ENFORCE, enforceStore.store);
      normalWindow(shadow, 0);
      shadow.ordinary("198.51.100.200", T0 + W);
      for (let w = 0; w < 3; w++) {
        normalWindow(enforce, w);
        // An enforce window with an invalid Fly-Client-IP and a fanIn 3 key near a limit: neither may reach the shadow verdict.
        enforce.send({ fci: "garbage", xff: flyXff("198.51.100.4"), ip: "198.51.100.4" }, T0 + w * W + 20_000);
        for (let i = 0; i < 100; i++) {
          const spoof = `203.0.113.${i % 3}`;
          enforce.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9", spoof), ip: spoof, path: "/a2a" }, T0 + w * W + 30_000 + i);
        }
      }
      enforce.ordinary("198.51.100.200", T0 + 3 * W);
      shadowStore.setNow(T0 + 3 * W + 1000);
      enforceStore.setNow(T0 + 3 * W + 1000);
      shadowStore.store.flush();
      enforceStore.store.flush();
      const modes = (db.prepare("SELECT mode, COUNT(*) AS c FROM client_ip_shadow_windows GROUP BY mode ORDER BY mode").all() as any[]).map((x) => [x.mode, x.c]);
      const snap = shadow.mw.opsSnapshot();
      assertEq(
        [modes, cum(snap).windows, cum(snap).counters.n, cum(snap).counters.fallback.invalid, cum(snap).fanin_max, failing(snap.ac2)],
        [[["enforce", 3], ["shadow", 1]], 1, 9, 0, null, ["hours_covered", "requests"]],
        "C8: 3 enforce rows and 1 shadow row stored; cumulative and ac2 see only the shadow row (no invalid, no fanIn from enforce)"
      );
      assertEq(
        [enforceStore.store.totals("enforce").rows, enforceStore.store.totals("enforce").counters.fallback.invalid, enforceStore.store.totals("enforce").fanInMax?.class],
        [3, 3, "a2a"],
        "C8: … the enforce rows are there for an enforce read"
      );
      db.close();
    }
    {
      // C9 (review S3 of PR #1130): which windows hold an "= 0 or explained" criterion at false, and the newest one.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      for (let w = 0; w < 4; w++) {
        normalWindow(r, w);
        if (w === 1) r.send({ fci: "10.1.2.3", xff: flyXff("198.51.100.5"), ip: "198.51.100.5" }, T0 + w * W + 50_000); // non_public
        if (w === 2) r.send({ fci: "garbage", xff: flyXff("198.51.100.4"), ip: "198.51.100.4" }, T0 + w * W + 50_000); // invalid
      }
      r.ordinary("198.51.100.200", T0 + 4 * W);
      s.setNow(T0 + 4 * W + 1000);
      s.store.flush();
      const snap = r.mw.opsSnapshot();
      assertEq(
        [cum(snap).nonzero_windows, snap.ac2?.criteria.invalid_non_public],
        [
          { top_overflow: { windows: 0, last: null }, invalid_non_public: { windows: 2, last: iso(T0 + 2 * W) } },
          { value: 2, threshold: 0, op: "==", pass: false },
        ],
        "C9: two stored windows with an invalid/non-public Fly-Client-IP, the newest at window 2; no overflow window"
      );
      db.close();
    }

    // ── D. evaluateClientIpAc2: thresholds ──
    {
      assertEq(
        AC2_THRESHOLDS,
        { minHours: 48, minRequests: 5000, maxFallbackBeyondHc: 0.01, minAgreeFciEdge: 0.995, minAgreeLegacyEqFci: 0.999, maxFanInRatio: 0.8 },
        "D: the thresholds are the dev-request's AC2 numbers"
      );
      const base = (): ClientIpCumulative => ({
        since: iso(T0),
        until: iso(T0 + 48 * H),
        windows: 576,
        machines: 1,
        hours_covered: (576 * 5) / 60,
        counters: {
          n: 5000,
          fci_valid: 4941,
          fallback: { missing: 59, invalid: 0, non_public: 0 },
          fallback_hc: 10,
          non_public_by: counters(0).non_public_by,
          errors: 0,
          xff_client_supplied: 3,
          agree_fci_edge: { n: 1000, agree: 995 },
          agree_legacy_eq_fci: { n: 1000, agree: 999 },
          would_trip: 0,
          top_overflow: 0,
        },
        fanin_max: { ratio: 0.7999, class: "general", fanIn: 2, ua: "browser", window_start: iso(T0) },
        nonzero_windows: NO_NONZERO_WINDOWS,
        writer: { persisted: 576, queued: 0, dropped: 0, out_of_order: 0, errors: 0, pruned: 0 },
      });
      const ok = evaluateClientIpAc2(base());
      assertEq([ok.ready, Object.keys(ok.criteria)], [true, CRITERIA], "D: every criterion at its bound → ready; the nine criteria in a fixed order");
      assertEq(
        Object.values(ok.criteria).map((c) => [c.threshold, c.op]),
        [[48, ">="], [5000, ">="], [0.01, "<="], [0, "=="], [0.995, ">="], [0.999, ">="], [0, "=="], [0.8, "<"], [0, "=="]],
        "D: each criterion carries its threshold and comparison"
      );
      assertEq(
        [ok.criteria.hours_covered.value, ok.criteria.requests.value, ok.criteria.fallback_beyond_health_checks.value, ok.criteria.agree_fci_edge.value, ok.criteria.agree_legacy_eq_fci.value, ok.criteria.fanin_limit_ratio.value],
        [48, 5000, 49 / 5000, 0.995, 0.999, 0.7999],
        "D: values (fallback beyond health checks = (missing + invalid + non_public − fallback_hc) / n)"
      );
      const flip = (label: string, criterion: string, edit: (c: ClientIpCumulative) => void) => {
        const c = base();
        edit(c);
        const a = evaluateClientIpAc2(c);
        assertEq([a.ready, failing(a)], [false, [criterion]], `D: ${label} → not ready, and only ${criterion} fails`);
      };
      flip("575 windows (47.9 h)", "hours_covered", (c) => { c.hours_covered = (575 * 5) / 60; });
      flip("4 999 requests", "requests", (c) => { c.counters.n = 4999; });
      flip("51 fallbacks beyond health checks of 5 000 (1.02 %)", "fallback_beyond_health_checks", (c) => { c.counters.fallback.missing = 61; });
      flip("one invalid Fly-Client-IP", "invalid_non_public", (c) => { c.counters.fallback.invalid = 1; });
      flip("one non-public Fly-Client-IP", "invalid_non_public", (c) => { c.counters.fallback.non_public = 1; });
      flip("agree_fci_edge 99.4 %", "agree_fci_edge", (c) => { c.counters.agree_fci_edge.agree = 994; });
      flip("agree_legacy_eq_fci 99.8 %", "agree_legacy_eq_fci", (c) => { c.counters.agree_legacy_eq_fci.agree = 998; });
      flip("agree_fci_edge never measured", "agree_fci_edge", (c) => { c.counters.agree_fci_edge = { n: 0, agree: 0 }; });
      flip("one would-trip", "would_trip", (c) => { c.counters.would_trip = 1; });
      flip("a fanIn > 1 key at exactly 80 %", "fanin_limit_ratio", (c) => { c.fanin_max!.ratio = 0.8; });
      flip("one request without a top-list entry", "top_overflow", (c) => { c.counters.top_overflow = 1; });
      const atBound = base();
      atBound.counters.fallback.missing = 60;
      assertEq(evaluateClientIpAc2(atBound).criteria.fallback_beyond_health_checks, { value: 0.01, threshold: 0.01, op: "<=", pass: true }, "D: exactly 1 % beyond health checks passes");
      const allHc = base();
      allHc.counters.fallback = { missing: 2000, invalid: 0, non_public: 0 };
      allHc.counters.fallback_hc = 1990;
      assertTrue(evaluateClientIpAc2(allHc).ready, "D: health-check fallbacks are allowed on top of the 1 %");
      const noFanIn = base();
      noFanIn.fanin_max = null;
      assertEq(evaluateClientIpAc2(noFanIn).criteria.fanin_limit_ratio, { value: 0, threshold: 0.8, op: "<", pass: true }, "D: no key ever had fanIn > 1 → 0, passes");
      const empty = evaluateClientIpAc2({
        since: null, until: null, windows: 0, machines: 0, hours_covered: 0,
        counters: { n: 0, fci_valid: 0, fallback: { missing: 0, invalid: 0, non_public: 0 }, fallback_hc: 0, non_public_by: counters(0).non_public_by, errors: 0, xff_client_supplied: 0, agree_fci_edge: { n: 0, agree: 0 }, agree_legacy_eq_fci: { n: 0, agree: 0 }, would_trip: 0, top_overflow: 0 },
        fanin_max: null,
        nonzero_windows: NO_NONZERO_WINDOWS,
        writer: { persisted: 0, queued: 0, dropped: 0, out_of_order: 0, errors: 0, pruned: 0 },
      });
      assertEq(
        [empty.ready, failing(empty), empty.criteria.fallback_beyond_health_checks.value, empty.criteria.agree_fci_edge.value],
        [false, ["hours_covered", "requests", "fallback_beyond_health_checks", "agree_fci_edge", "agree_legacy_eq_fci"], null, null],
        "D: nothing stored → not ready; unmeasured ratios are null and never pass"
      );
    }

    // ── E. End to end: ac2.ready is false before 48 h, true at 48 h ──
    {
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      for (let w = 0; w < 576; w++) {
        normalWindow(r, w); // 9 ordinary clients per window
        s.setNow(T0 + w * W + 60_000);
        s.store.flush();
      }
      const before = r.mw.opsSnapshot();
      assertEq(
        [cum(before).windows, before.ac2?.ready, failing(before.ac2), before.ac2?.criteria.hours_covered.value, before.ac2?.criteria.requests],
        [575, false, ["hours_covered"], 575 / 12, { value: 5175, threshold: 5000, op: ">=", pass: true }],
        "E: 575 stored windows (47.92 h, 5 175 requests, everything else clean) → ac2.ready false on hours_covered alone"
      );
      r.ordinary("198.51.100.250", T0 + 576 * W);
      s.setNow(T0 + 576 * W + 60_000);
      s.store.flush();
      const after = r.mw.opsSnapshot();
      assertEq(
        [cum(after).windows, cum(after).hours_covered, cum(after).counters.n, after.ac2?.ready, failing(after.ac2)],
        [576, 48, 5184, true, []],
        "E: the 576th stored window (48 h) → ac2.ready true"
      );
      const perHour = db.prepare("SELECT substr(window_start, 1, 13) AS h, COUNT(*) AS c FROM client_ip_shadow_windows GROUP BY h").all() as any[];
      assertTrue(perHour.length === 48 && perHour.every((x) => x.c === 12), "E: 48 h of traffic → exactly 12 rows in every hour");
      const json = JSON.stringify(db.prepare("SELECT * FROM client_ip_shadow_windows").all()) + JSON.stringify(after);
      assertTrue(!/198\.51\.|203\.0\.113\.|192\.0\.2\./.test(json), "E: no client IP in any stored row or in the snapshot");
      db.close();
    }

    // ── F. The existing ops route carries cumulative and ac2 ──
    {
      const analytics = require("../routes/analytics");
      const router: any = analytics.default || analytics;
      const layer = (router.stack || []).find((l: any) => l.route && l.route.path === "/ops/event-loop" && l.route.methods.get);
      assertTrue(!!layer, "F: GET /ops/event-loop is on the analytics router");
      const call = (): { code: number; body: any } => {
        let body: any = null;
        let code = 200;
        const res: any = { json(b: any) { body = b; return this; }, status(c: number) { code = c; return this; } };
        layer.route.stack[0].handle({ query: {} }, res, () => {});
        return { code, body };
      };
      if (layer) {
        const db = freshDb();
        const s = storeOn(db);
        s.store.enqueue(rec(T0));
        s.store.flush();
        installClientIp(express(), SHADOW, { now: () => T0 + W, log: () => {}, logError: () => {}, store: s.store });
        const ok = call();
        assertEq(
          [ok.code, ok.body?.clientIp?.cumulative?.windows, ok.body?.clientIp?.cumulative?.counters, ok.body?.clientIp?.ac2?.ready, Object.keys(ok.body?.clientIp?.ac2?.criteria ?? {})],
          [200, 1, stored(counters(1)), false, CRITERIA],
          "F: clientIp.cumulative and clientIp.ac2 in the existing ops response"
        );
        assertTrue(["timestamp", "summary", "stalls", "offThreadStats"].every((k) => k in (ok.body ?? {})) && "since_boot" in (ok.body?.clientIp ?? {}), "F: the existing fields (and trinn 1b's since_boot) are all still there");
        const broken = storeOn(db, { getDb: () => { throw new Error("db down"); } });
        installClientIp(express(), SHADOW, { now: () => T0, log: () => {}, logError: () => {}, store: broken.store });
        const failingRead = call();
        assertEq(
          [failingRead.code, failingRead.body?.clientIp?.cumulative, failingRead.body?.clientIp?.ac2, failingRead.body?.clientIp?.mode, typeof failingRead.body?.clientIp?.since_boot?.n],
          [200, { error: "read_failed" }, null, "shadow", "number"],
          "F: a failing DB read → cumulative { error: read_failed }, ac2 null, the rest of clientIp and the response still answer"
        );
        db.close();
      }
      __resetInstalledClientIpForTesting();
    }

    // ── G. installClientIp: which store by default ──
    {
      // getDb() itself throws while this is set: any default-store read shows as read_failed, and nothing opens a DB.
      __setDbAccessorFailureForTesting(new Error("main DB must not be opened by this test"));
      try {
        installClientIp(express(), OFF_FLY, { log: () => {}, logError: () => {} });
        const off = getInstalledClientIpSnapshot() as ClientIpOpsSnapshot;
        assertEq([off.cumulative, off.ac2], [null, null], "G: off Fly (local dev, CI, npm test) → no store, the DB is never read");
        installClientIp(express(), SHADOW, { log: () => {}, logError: () => {} });
        const on = getInstalledClientIpSnapshot() as ClientIpOpsSnapshot;
        assertEq([on.cumulative, on.ac2], [{ error: "read_failed" }, null], "G: on Fly, by default → the main-DB store (read through getDb)");
        installClientIp(express(), SHADOW, { log: () => {}, logError: () => {}, store: null });
        assertEq((getInstalledClientIpSnapshot() as ClientIpOpsSnapshot).cumulative, null, "G: on Fly with store: null → none");
      } finally {
        __setDbAccessorFailureForTesting(null);
        __resetInstalledClientIpForTesting();
      }
    }

    // ── H. AC2_FANIN_LIMITS = the limiters' anonymous ceilings, ac2LimitersFor = their mounts ──
    {
      const srcRoot = path.join(__dirname, "..");
      const sec = fs.readFileSync(path.join(srcRoot, "middleware", "security.ts"), "utf8");
      const ceiling = (name: string): number | null => {
        const m = sec.match(new RegExp(`export const ${name} = rateLimit\\(\\{\\s*windowMs: 15 \\* 60 \\* 1000,[\\s\\S]*?max: keyedMax\\((\\d+),`));
        return m ? Number(m[1]) : null;
      };
      // A flat `max: N` inside the limiter's own options (no "}" before it, so never the next limiter's).
      const flat = (name: string): number | null => {
        const m = sec.match(new RegExp(`export const ${name} = rateLimit\\(\\{\\s*windowMs: 15 \\* 60 \\* 1000,[^}]*?max: (\\d+),`));
        return m ? Number(m[1]) : null;
      };
      const mcp = Object.values(MCP_RATE_LIMIT_PROFILES).map((p) => p.primary);
      const brakes = Object.values(MCP_RATE_LIMIT_PROFILES).map((p) => p.brake);
      assertEq(
        [
          AC2_FANIN_LIMITS, ceiling("generalLimiter"), flat("searchLimiter"), ceiling("jsonRpcLimiter"), flat("dentalLimiter"),
          Math.min(...mcp.map((p) => p.anonymousMax)), mcp.every((p) => p.windowMs === 15 * 60_000),
          Math.min(...brakes.map((b) => b.max)), brakes.every((b) => b.windowMs === 15 * 60_000),
        ],
        [{ general: 300, search: 150, a2a: 200, dental: 1000, mcp: 200, mcp_brake: 3000 }, 300, 150, 200, 1000, 200, true, 3000, true],
        "H: AC2_FANIN_LIMITS = generalLimiter / searchLimiter / jsonRpcLimiter / dentalLimiter / the smallest MCP primary ceiling / the smallest MCP brake, all per 15 min"
      );
      // Trinn 1d: how every vertical's MCP chain keys — the brake on the IP for every /mcp, the primary by mcpPrimaryKey (session first).
      const mcpSrc = fs.readFileSync(path.join(srcRoot, "middleware", "mcp-rate-limit.ts"), "utf8");
      assertTrue(
        /const brake = rateLimit\(\{[^}]*?keyGenerator: mcpIpKey,\s*\}\);/.test(mcpSrc) &&
          /const primary = rateLimit\(\{[^}]*?keyGenerator: \(req\) => mcpPrimaryKey\(req, isKnownSession\),\s*\}\);/.test(mcpSrc) &&
          /chain: sideEffect \? \[brake, primary, sideEffect\] : \[brake, primary\]/.test(mcpSrc),
        "H: the MCP brake is keyed on the IP and the primary by mcpPrimaryKey, both in every vertical's chain — what ac2LimitersFor's mcp / mcp_brake mirror"
      );
      assertTrue(
        /skip: \(req\) => \{\s*const fullPath = \(req\.baseUrl \|\| ""\) \+ \(req\.path \|\| ""\);\s*return fullPath\.startsWith\("\/api\/tannlege"\);\s*\}/.test(sec),
        "H: generalLimiter's skip is still the case-sensitive startsWith(\"/api/tannlege\") ac2LimitersFor mirrors"
      );
      // Every place outside security.ts that applies one of the four limiters, as code lines (no comments, no imports).
      // A new mount fails here: add it to ac2LimitersFor (and to C7's table), then to this list.
      const usages: string[] = [];
      for (const rel of fs.readdirSync(srcRoot, { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.endsWith(".d.ts") || rel === path.join("middleware", "security.ts")) continue;
        for (const raw of fs.readFileSync(path.join(srcRoot, rel), "utf8").split("\n")) {
          const t = raw.trim();
          if (!/\b(generalLimiter|searchLimiter|jsonRpcLimiter|dentalLimiter)\b/.test(t)) continue;
          if (/^(\/\/|\*|\/\*)/.test(t) || /^import\b/.test(t) || /^\w+,$/.test(t)) continue;
          usages.push(`${rel.split(path.sep).join("/")}: ${t}`);
        }
      }
      assertEq(
        usages.sort(),
        [
          'index.ts: app.use("/a2a", jsonRpcLimiter);',
          'index.ts: app.use("/api", generalLimiter);',
          'index.ts: app.use("/api/marketplace/discover", searchLimiter);',
          'index.ts: app.use("/api/marketplace/search", searchLimiter);',
          'index.ts: app.use("/api/tannlege", dentalLimiter);',
          'index.ts: app.use("/reise", generalLimiter);',
          'index.ts: app.use("/ut", generalLimiter);',
          "routes/dental-a2a.ts: router.use(dentalLimiter);",
          'routes/dental-seo.ts: router.get("/sok", generalLimiter, (req: Request, res: Response) => {',
          'routes/experiences-a2a.ts: router.use(jsonRpcLimiter);',
          'routes/experiences-seo.ts: router.get("/for-tilbydere/finn", generalLimiter, (req: Request, res: Response) => {',
          'routes/experiences-seo.ts: router.get("/reise", generalLimiter, async (req: Request, res: Response) => {',
          'routes/experiences-seo.ts: router.get("/sok", generalLimiter, async (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.get("/api/opplevelser/gardssalg-claim/:providerId/profile", generalLimiter, (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.get("/api/opplevelser/gardssalg-claim/:providerId/session-status", generalLimiter, (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.get("/api/opplevelser/gardssalg-claim/:providerId/stats", generalLimiter, (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.get("/kategori/gardssalg/eier/:providerSlug", generalLimiter, async (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.get("/kategori/gardssalg/eier/:providerSlug/portal", generalLimiter, (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.get("/kategori/gardssalg/eier/magic-link-verify", generalLimiter, (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.post("/api/opplevelser/gardssalg-claim/:providerId/release-field", generalLimiter, express.json(), (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.post("/api/opplevelser/gardssalg-claim/:providerId/update-profile", generalLimiter, express.json(), (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.post("/kategori/gardssalg/eier/:providerSlug/logout", generalLimiter, (req: Request, res: Response) => {',
          'routes/seo.ts: router.get("/sok", generalLimiter, async (req: Request, res: Response) => {',
          // POST /kategori/gardssalg/book/:providerSlug (experiences-seo.ts) and POST
          // /kategori/gardssalg/eier/:providerId/request, …/:providerSlug/save and …/:providerSlug/release-field (gardssalg-claim.ts) carry
          // generalLimiter on a line of their own, which the import-list rule above skips;
          // host-gate-rate-limit.test.ts (a1) and gardssalg-claim-host-gate.test.ts (a1) tie every route-level
          // generalLimiter, by reference, to ac2LimitersFor.
        ],
        "H: generalLimiter, searchLimiter, jsonRpcLimiter and dentalLimiter are applied exactly where ac2LimitersFor counts them"
      );
      const idx = fs.readFileSync(path.join(srcRoot, "index.ts"), "utf8");
      const at = (s: string) => idx.indexOf(s);
      assertTrue(
        at("installClientIp(app,") >= 0 &&
          at("installClientIp(app,") < at("app.use(langMiddleware);") &&
          at("app.use(langMiddleware);") < at('app.use("/a2a", jsonRpcLimiter);') &&
          at("app.use(langMiddleware);") < at("const DENTAL_HOSTS"),
        "H: langMiddleware runs after this middleware and before the limiters and host gates, so ac2LimitersFor strips /en and /sv itself"
      );
    }

    // ── I. Trinn 1d: AC2 measures what enforce would do ──
    /** The one stored row's fanIn: the count against its limiter, the limiter, the ratio (6 decimals), the fanIn. */
    const storedFanIn = (db: Database.Database): unknown[] => {
      const rows = db.prepare("SELECT fanin_ratio, fanin_class, fanin_fan_in FROM client_ip_shadow_windows").all() as any[];
      const f = rows.length === 1 ? rows[0] : null;
      if (!f || f.fanin_ratio === null) return [null, null, null, null];
      return [Math.round(f.fanin_ratio * AC2_FANIN_LIMITS[f.fanin_class as keyof typeof AC2_FANIN_LIMITS]), f.fanin_class, Math.round(f.fanin_ratio * 1e6) / 1e6, f.fanin_fan_in];
    };
    /** Requests in time order (the rig's clock only moves forward), each at its own `at`. */
    const play = (r: ReturnType<typeof rig>, evs: Array<{ at: number; o: Parameters<typeof fakeReq>[0] }>) => {
      for (const e of [...evs].sort((a, b) => a.at - b.at)) r.send(e.o, e.at);
    };
    /** One client behind Fly-Client-IP 198.51.100.9 rotating three spoofed X-Forwarded-For values: fanIn 3. */
    let spoofSeq = 0;
    const fanIn3 = (at: number, pathName = "/api/products", sid?: unknown) => {
      const spoof = `203.0.113.${spoofSeq++ % 3}`;
      return { at, o: { fci: "198.51.100.9", xff: flyXff("198.51.100.9", spoof), ip: spoof, path: pathName, sid } };
    };
    /** Fly's health check every 30 s over [from, to), from an ordinary client (fanIn 1, never rated). */
    const healthChecks = (from: number, to: number) => {
      const out: Array<{ at: number; o: Parameters<typeof fakeReq>[0] }> = [];
      for (let t = from; t < to; t += 30_000) out.push({ at: t, o: { fci: "198.51.100.200", xff: flyXff("198.51.100.200"), ip: "198.51.100.200", path: "/health" } });
      return out;
    };
    const MIN = 60_000;
    /** An MCP session id of the shape the routers mint (crypto.randomUUID), and one of that shape no router holds. */
    const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const STALE_SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    {
      // I1 (review S1 of PR #1130): 160 + 160 /api/products from one key (fanIn 3), over 4:00–4:50 and 15:00–15:50.
      // In enforce express-rate-limit opens the key's 15-min window at its first hit (4:00) and counts both bursts in
      // it: 320 of generalLimiter's 300, 20 × 429. Over 3 windows each burst was rated alone (160/300 = 0.533, passed).
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      const evs = [...healthChecks(T0, T0 + 4 * W + 1)];
      for (const from of [T0 + 4 * MIN, T0 + 15 * MIN]) for (let i = 0; i < 160; i++) evs.push(fanIn3(from + Math.floor((i * 50_000) / 160)));
      play(r, evs);
      s.setNow(T0 + 4 * W + 1000);
      s.store.flush();
      const rows = (db.prepare("SELECT window_start, fanin_ratio, fanin_class, fanin_fan_in FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((x) => [
        x.window_start, x.fanin_ratio === null ? null : Math.round(x.fanin_ratio * 1e6) / 1e6, x.fanin_class, x.fanin_fan_in,
      ]);
      assertEq(
        rows,
        [
          [iso(T0), 0.533333, "general", 3],
          [iso(T0 + W), 0.533333, "general", 3],
          [iso(T0 + 2 * W), 0.533333, "general", 3],
          [iso(T0 + 3 * W), 1.066667, "general", 3],
        ],
        "I1: the window of the second burst is rated over the 20 min that hold both bursts: 320 of 300 (1.067), where 3 windows gave 0.533"
      );
      const snap = r.mw.opsSnapshot();
      assertEq(
        [cum(snap).fanin_max?.window_start, snap.ac2?.criteria.fanin_limit_ratio.pass],
        [iso(T0 + 3 * W), false],
        "I1: … so fanin_limit_ratio fails, as enforce would answer 20 × 429"
      );
      const line3 = JSON.parse(r.lines[3] ?? "{}");
      const top = (line3.top15m ?? []).find((t: any) => t.fanIn === 3);
      assertEq([line3.window_start, top?.n, top?.api, r.lines.length], [iso(T0 + 3 * W), 160, 160, 4], "I1: the log line's top15m is still the 15-min list (the second burst alone, 160)");
      db.close();
    }
    {
      // I1b: seeded burst patterns. The stored fanin_max is exactly the largest 4-window count / 300, and never below the
      // key's largest count in a 15-min span starting at one of its requests (where express-rate-limit opens a window).
      let seed = 0x2545f491;
      const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const bad: string[] = [];
      let missedBy3 = 0;
      for (let run = 0; run < 30; run++) {
        const times: number[] = [];
        const bursts = 2 + Math.floor(rnd() * 4);
        for (let b = 0; b < bursts; b++) {
          const start = Math.floor(rnd() * 50 * MIN);
          const size = 20 + Math.floor(rnd() * 180);
          const len = Math.floor(rnd() * 3 * MIN);
          for (let i = 0; i < size; i++) times.push(start + Math.floor((i * len) / size));
        }
        times.sort((a, b) => a - b);
        let span15 = 0;
        for (let i = 0, j = 0; i < times.length; i++) {
          while (j < times.length && times[j] < times[i] + 15 * MIN) j++;
          span15 = Math.max(span15, j - i);
        }
        const perWindow = new Map<number, number>();
        for (const t of times) perWindow.set(Math.floor(t / W), (perWindow.get(Math.floor(t / W)) ?? 0) + 1);
        const maxOver = (span: number) => {
          let best = 0;
          for (let w = 0; w <= 12; w++) {
            let sum = 0;
            for (let k = w - span + 1; k <= w; k++) sum += perWindow.get(k) ?? 0;
            best = Math.max(best, sum);
          }
          return best;
        };
        if (maxOver(3) < span15) missedBy3++;
        const db = freshDb();
        const s = storeOn(db);
        const r = rig(SHADOW, s.store);
        play(r, [...healthChecks(T0, T0 + 13 * W + 1), ...times.map((t) => fanIn3(T0 + t))]);
        s.setNow(T0 + 13 * W + 1000);
        s.store.flush();
        const f = cum(r.mw.opsSnapshot()).fanin_max;
        const count = f === null ? 0 : Math.round(f.ratio * AC2_FANIN_LIMITS.general);
        if (count !== maxOver(4) || count < span15) bad.push(`run ${run}: stored ${count}, 4-window ${maxOver(4)}, 15-min span ${span15}`);
        db.close();
      }
      assertEq(bad, [], "I1b: 30 seeded burst patterns — fanin_max is the largest 4-window count, and never below the largest 15-min span count (an upper bound in time)");
      assertTrue(missedBy3 > 0, `I1b: (the sweep has teeth) in ${missedBy3} of 30 runs the largest 3-window count was below the 15-min span count`);
    }
    {
      // I2 (review S2 of PR #1130, B1 of PR #1151): /mcp as the MCP chain keys it. The primary keys a request on its
      // session only when the router holds it (mcpPrimaryKey with the router's isKnownSession, as all three chains call
      // it — H, I6), so only /mcp it keys on the IP counts against its 200; every /mcp counts against the brake's 3 000.
      const held = new Set([SID]);
      const isHeld = (id: string) => held.has(id);
      const cases: Array<[string, unknown, boolean]> = [
        ["no header", undefined, false],
        ["a session the router holds", SID, true],
        ["a UUID-shaped id the router no longer holds (a deploy emptied its map)", STALE_SID, false],
        ["upper case (no server mints one)", SID.toUpperCase(), false],
        ["padded", ` ${SID}`, false],
        ["made up", "not-a-session", false],
        ["10 KB", "a".repeat(10_000), false],
        ["a repeated header, joined", `${SID}, ${SID}`, false],
        ["an array, the first held", [SID, "x"], true],
        ["an array, the first not held", [STALE_SID, SID], false],
        ["empty", "", false],
      ];
      const mcpReq = (sid: unknown) => fakeReq({ fci: "198.51.100.9", xff: flyXff("198.51.100.9"), ip: "198.51.100.9", path: "/mcp", sid });
      assertEq(
        cases.map(([label, sid]) => [label, mcpSessionKeyed(mcpReq(sid), isHeld), mcpPrimaryKey(mcpReq(sid), isHeld)]),
        cases.map(([label, , want]) => [label, want, want ? `sid:${SID}` : "ip:198.51.100.9"]),
        "I2: given the router's session check, mcpSessionKeyed is true exactly when the real primary's key (mcpPrimaryKey with isKnownSession) is the session, header form by header form; a stale UUID is keyed on the IP"
      );
      assertEq(
        [
          mcpSessionKeyed(mcpReq(SID)),
          (() => {
            try {
              return mcpSessionKeyed(mcpReq(SID), () => {
                throw new Error("session map unavailable");
              });
            } catch {
              return "threw";
            }
          })(),
          mcpPrimaryKey(mcpReq(STALE_SID)),
        ],
        [false, false, `sid:${STALE_SID}`],
        "I2: without the routers' check, or when it throws, never session-keyed (every /mcp counts against the primary, 1c's upper bound) — mcpPrimaryKey without the check would key a stale UUID on the session, which no chain does"
      );
      let asked = 0;
      const keyed = (v: boolean) => () => {
        asked++;
        return v;
      };
      assertEq(
        ([["/mcp", true], ["/mcp/x", true], ["/en/mcp", true], ["/mcp", false], ["/api/products", true], ["/a2a", true], ["/health", true]] as Array<[string, boolean]>).map(([p, k]) => [p, k, ac2LimitersFor(p, keyed(k))]),
        [["/mcp", true, ["mcp_brake"]], ["/mcp/x", true, ["mcp_brake"]], ["/en/mcp", true, ["mcp_brake"]], ["/mcp", false, ["mcp", "mcp_brake"]], ["/api/products", true, ["general"]], ["/a2a", true, ["a2a", "dental"]], ["/health", true, []]],
        "I2: session-keyed /mcp counts against the brake only; off /mcp the flag changes nothing"
      );
      assertEq(asked, 4, "I2: … and the session check is asked only for the 4 paths under /mcp (review S1 of PR #1151)");
      {
        // Through the middleware: the routers' check runs for /mcp with a session header, never for another path.
        const checked: string[] = [];
        const r = rig(SHADOW, null, undefined, (id) => {
          checked.push(id);
          return held.has(id);
        });
        r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9"), ip: "198.51.100.9", path: "/api/products", sid: SID });
        r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9"), ip: "198.51.100.9", path: "/mcp" });
        r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9"), ip: "198.51.100.9", path: "/mcp", sid: "not-a-session" });
        r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9"), ip: "198.51.100.9", path: "/mcp", sid: STALE_SID });
        r.send({ fci: "198.51.100.9", xff: flyXff("198.51.100.9"), ip: "198.51.100.9", path: "/mcp", sid: SID });
        assertEq([checked, r.mw.snapshot().errors], [[STALE_SID, SID], 0], "I2: the session check runs once per UUID-shaped id on /mcp, never off /mcp or for a malformed id");
      }
      const sidOf = (i: number) => `00000000-0000-4000-8000-${String(i % 30).padStart(12, "0")}`;
      const staleOf = (i: number) => `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const live = new Set(Array.from({ length: 30 }, (_, i) => sidOf(i)));
      const isLive = (id: string) => live.has(id);
      /** One key (fanIn 3) in one window: `bare` /mcp without a session, then `withSid` with sid(i) (default: 30 live sessions). */
      const rateMcp = (bare: number, withSid: number, sid: (i: number) => unknown = sidOf, isKnown: ((id: string) => boolean) | null = isLive) => {
        const db = freshDb();
        const s = storeOn(db);
        const r = rig(SHADOW, s.store, undefined, isKnown ?? undefined);
        const evs: Array<{ at: number; o: Parameters<typeof fakeReq>[0] }> = [];
        for (let i = 0; i < bare; i++) evs.push(fanIn3(T0 + i, "/mcp"));
        for (let i = 0; i < withSid; i++) evs.push(fanIn3(T0 + bare + i, "/mcp", sid(i)));
        evs.push({ at: T0 + W, o: { fci: "198.51.100.200", xff: flyXff("198.51.100.200"), ip: "198.51.100.200" } });
        play(r, evs);
        s.setNow(T0 + W + 1000);
        s.store.flush();
        const snap = r.mw.opsSnapshot();
        const f = cum(snap).fanin_max;
        db.close();
        return [f === null ? null : Math.round(f.ratio * 1e6) / 1e6, f?.class ?? null, snap.ac2?.criteria.fanin_limit_ratio.pass];
      };
      assertEq(rateMcp(0, 300), [0.1, "mcp_brake", true], "I2: 300 /mcp in 30 sessions the router holds → 300 of the brake's 3 000 (0.1), not 300 of the primary's 200 (1.5): passes");
      assertEq(rateMcp(150, 300), [0.75, "mcp", true], "I2: 150 bare (initialize) + 300 in held sessions → the primary 150 of 200 (0.75), the brake 450 of 3 000: passes");
      assertEq(rateMcp(170, 0), [0.85, "mcp", false], "I2: 170 bare /mcp → 170 of the primary's 200 (0.85): fails");
      assertEq(rateMcp(0, 2400), [0.8, "mcp_brake", false], "I2: 2 400 /mcp in held sessions → the brake at 80 % of 3 000: fails");
      assertEq(rateMcp(0, 170, () => SID.toUpperCase()), [0.85, "mcp", false], "I2: 170 /mcp with an id the primary does not key on (not UUID-shaped) → counted as bare: fails");
      assertEq(rateMcp(0, 170, staleOf), [0.85, "mcp", false], "I2: 170 /mcp on UUID-shaped ids no router holds → the primary keys them on the IP, so they count: fails");
      assertEq(rateMcp(0, 300, sidOf, null), [1.5, "mcp", false], "I2: without the routers' check (createClientIpMiddleware's default) even held sessions count against the primary: 1.5, fails early");
      assertEq(
        rateMcp(120, 120, staleOf),
        [1.2, "mcp", false],
        "I2 (review B1 of PR #1151): a fanIn-3 key reconnecting 120 sessions after a deploy (120 requests on the old ids, 120 bare initialize) is 240 of the primary's 200 on the IP, as enforce counts it (40 × 429): 1.2, fails — the first 1d round stored 0.6 and passed"
      );
    }
    {
      // I5 (review B1 of PR #1151): parity with the real MCP chains. This middleware in enforce (so the limiters key on
      // Fly-Client-IP), then a vertical's production chain (createMcpRateLimiters, on MemoryStores the test can read)
      // and a stub router; the chain and the middleware get the same session check. What AC2 counts against mcp and
      // mcp_brake is what the primary counts on the IP (its store, the last bare request's RateLimit-Remaining, its
      // 429s) and what the brake counts. (An enforce row is read as stored: cumulative sums shadow rows only, C8.)
      const FCI = "198.51.100.9";
      const heldIds = Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      const held = new Set(heldIds);
      const isHeld = (id: string) => held.has(id);
      /** `held`, `stale` (UUID-shaped, not held), `madeUp` session ids, then `bare` requests (last), from one key with fanIn 3. */
      const parity = async (profile: keyof typeof MCP_RATE_LIMIT_PROFILES, mix: { held: number; stale: number; madeUp: number; bare: number }) => {
        const db = freshDb();
        const s = storeOn(db);
        let clock = T0;
        const mw = createClientIpMiddleware(ENFORCE, { now: () => clock, log: () => {}, logError: () => {}, store: s.store, isKnownMcpSession: isHeld });
        const stores: Partial<Record<McpLimiterName, MemoryStore>> = {};
        const chain = createMcpRateLimiters({
          ...MCP_RATE_LIMIT_PROFILES[profile],
          isKnownSession: isHeld,
          createStore: (l) => (stores[l] = new MemoryStore()),
        }).chain;
        const app = express();
        app.set("trust proxy", true);
        app.use(mw);
        app.use("/mcp", chain, (_req: express.Request, res: express.Response) => {
          res.json({ ok: true });
        });
        const sids: Array<string | undefined> = [
          ...Array.from({ length: mix.held }, (_, i) => heldIds[i % heldIds.length]),
          ...Array.from({ length: mix.stale }, (_, i) => `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`),
          ...Array.from({ length: mix.madeUp }, () => "not-a-session"),
          ...Array.from({ length: mix.bare }, () => undefined),
        ];
        const statuses: number[] = [];
        let remaining = NaN;
        const srv = await listen(app);
        try {
          for (let i = 0; i < sids.length; i++) {
            const headers: Record<string, string> = { "Fly-Client-IP": FCI, "X-Forwarded-For": flyXff(FCI, `203.0.113.${i % 3}`) };
            if (sids[i] !== undefined) headers["Mcp-Session-Id"] = sids[i] as string;
            const res = await httpRequest(srv.port, "GET", "/mcp", headers);
            statuses.push(res.status);
            remaining = Number(res.headers["ratelimit-remaining"]);
          }
        } finally {
          await srv.close();
        }
        // A request in the next window closes this one; the store writes it.
        clock = T0 + W;
        mw(fakeReq({ fci: "198.51.100.200", xff: flyXff("198.51.100.200"), ip: "198.51.100.200" }), {} as any, () => {});
        s.setNow(T0 + W + 1000);
        s.store.flush();
        const f = storedFanIn(db);
        db.close();
        return [
          (await stores.primary?.get(`ip:${FCI}`))?.totalHits ?? 0,
          (await stores.brake?.get(FCI))?.totalHits ?? 0,
          remaining,
          statuses.filter((x) => x === 429).length,
          ...f,
        ];
      };
      for (const profile of ["rfb", "experiences", "dental"] as const) {
        const limit = MCP_RATE_LIMIT_PROFILES[profile].primary.anonymousMax;
        assertEq(
          await parity(profile, { held: 30, stale: 20, madeUp: 5, bare: 11 }),
          [36, 66, limit - 36, 0, 36, "mcp", 0.18, 3],
          `I5 (${profile}): 30 held + 20 stale + 5 made-up + 11 bare → the real primary counts 36 on the IP (RateLimit-Remaining ${limit - 36}), the brake 66; AC2 counted 36 against mcp`
        );
        assertEq(
          await parity(profile, { held: 40, stale: 0, madeUp: 0, bare: 1 }),
          [1, 41, limit - 1, 0, 41, "mcp_brake", 0.013667, 3],
          `I5 (${profile}): 40 held + 1 bare → the primary counts 1 on the IP, the brake 41; AC2 counted 41 against mcp_brake`
        );
      }
      assertEq(
        await parity("experiences", { held: 0, stale: 120, madeUp: 0, bare: 120 }),
        [240, 240, 0, 40, 240, "mcp", 1.2, 3],
        "I5 (review B1 of PR #1151): 120 stale ids + 120 bare initialize after a deploy → the real primary counts 240 of 200 on the IP and answers 40 × 429; AC2 stores 1.2 against mcp (I2: fanin_limit_ratio fails)"
      );
    }
    {
      // I6 (review B1 of PR #1151): installClientIp's default session check is the three routers' own, the
      // isKnownSession each vertical's primary is built with — read from router modules already loaded, never loading one.
      const srcRoot = path.join(__dirname, "..");
      const middlewareDir = path.join(srcRoot, "middleware");
      const built: Array<{ module: string; check: string }> = [];
      let calls = 0;
      for (const rel of fs.readdirSync(srcRoot, { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.endsWith(".d.ts")) continue;
        const file = path.join(srcRoot, rel);
        const src = fs.readFileSync(file, "utf8");
        calls += src
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.includes("createMcpRateLimiters(") && !/^(\/\/|\*|\/\*)/.test(l) && !l.startsWith("export function createMcpRateLimiters(")).length;
        for (const m of src.matchAll(/createMcpRateLimiters\(\{ \.\.\.MCP_RATE_LIMIT_PROFILES\.\w+, isKnownSession: (\w+) \}\)/g)) {
          // The router's own export, or (RFB's chain, built in mcp-rate-limit.ts) a function that require()s it.
          const via = src.match(new RegExp(`function ${m[1]}\\(sessionId: string\\): boolean \\{\\s*return \\(require\\("([^"]+)"\\)[^\\n]*?\\)\\.(\\w+)\\(sessionId\\);`));
          const own = new RegExp(`export function ${m[1]}\\(sessionId: string\\): boolean`).test(src);
          const target = via ? path.join(path.dirname(file), via[1]) : own ? file.replace(/\.ts$/, "") : "?";
          built.push({ module: path.relative(middlewareDir, target).split(path.sep).join("/"), check: via ? via[2] : m[1] });
        }
      }
      const byModule = (a: { module: string }, b: { module: string }) => a.module.localeCompare(b.module);
      assertEq(
        [built.sort(byModule), calls],
        [[...MCP_ROUTER_SESSION_CHECKS].map((c) => ({ module: c.module, check: c.check })).sort(byModule), 3],
        "I6: MCP_ROUTER_SESSION_CHECKS is exactly the isKnownSession of every production MCP chain (RFB's through mcp-rate-limit.ts's require of routes/mcp), and no chain is built without one"
      );
      const routerFiles = MCP_ROUTER_SESSION_CHECKS.map((c) => require.resolve(path.join(middlewareDir, c.module)));
      const loaded = () => routerFiles.map((f) => f in require.cache);
      /**
       * `ask` with no router loaded, as before a host's first /mcp (index.ts loads dental-mcp and experiences-mcp
       * then): the three are swapped out of require.cache (tests/module-cache) and put back when `ask` returns. In
       * `npm test` earlier suites have loaded all three, so "asking loads no module" held there whatever the check
       * did (review S1 of PR #1151). `ask` is synchronous, so nothing else runs while they are out. Returns what
       * `ask` returned, how many modules were loaded meanwhile and which routers are loaded after it.
       */
      const { withModulesSwappedOut } = require("../../tests/module-cache") as typeof import("../../tests/module-cache");
      const withNoRouterLoaded = <T>(ask: () => T): [T, number, boolean[]] =>
        withModulesSwappedOut(routerFiles, () => {
          const size = Object.keys(require.cache).length;
          return [ask(), Object.keys(require.cache).length - size, loaded()];
        });
      assertEq(
        withNoRouterLoaded(() => isKnownToAnMcpRouter(STALE_SID)),
        [false, 0, [false, false, false]],
        "I6: with no router loaded, a UUID is not known and asking loads no module — also in `npm test`, where earlier suites have loaded all three (review S1 of PR #1151)"
      );

      // The real routers: a session any of them minted is known, through each router's own map.
      const routers: Record<string, express.Router> = {
        rfb: (require("../routes/mcp") as { default: express.Router }).default,
        experiences: (require("../routes/experiences-mcp") as { default: express.Router }).default,
        dental: (require("../routes/dental-mcp") as { default: express.Router }).default,
      };
      const MCP_ACCEPT = "application/json, text/event-stream";
      const INIT = {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "client-ip-shadow-store-test", version: "1.0.0" } },
      };
      // Client addresses of I6's own, fixed so every run sends the same requests (review S2 of PR #1151): the routers'
      // module-level chains are shared with the rest of `npm test`, and no other suite sends TEST-NET-1 (192.0.2.0/24)
      // through them (mcp-rate-limit-verticals draws from 100.64.0.0/10, the others come from the loopback). A chain
      // keys a request on FCI behind installClientIp in enforce, and on its left-most X-Forwarded-For entry, one of
      // SPOOFED (fanIn 3), where nothing rewrites the header (minting below).
      const FCI = "192.0.2.61";
      const SPOOFED = ["192.0.2.62", "192.0.2.63", "192.0.2.64"];
      let spoof = 0;
      const hdr = (sid?: string): Record<string, string> => ({
        Accept: MCP_ACCEPT,
        "Fly-Client-IP": FCI,
        "X-Forwarded-For": flyXff(FCI, SPOOFED[spoof++ % SPOOFED.length]),
        ...(sid === undefined ? {} : { "Mcp-Session-Id": sid }),
      });
      __setDbAccessorFailureForTesting(new Error("I6: initialize, tools/list and a 404 read no DB"));
      try {
        const minted: Array<[string, boolean, boolean]> = [];
        const sids: string[] = [];
        for (const [name, router] of Object.entries(routers)) {
          const app = express();
          app.set("trust proxy", true);
          app.use(express.json());
          app.use("/mcp", router);
          const srv = await listen(app);
          try {
            const res = await httpRequest(srv.port, "POST", "/mcp", hdr(), INIT);
            const sid = String(res.headers["mcp-session-id"] ?? "");
            sids.push(sid);
            minted.push([name, res.status === 200 && /^[0-9a-f-]{36}$/.test(sid), isKnownToAnMcpRouter(sid)]);
          } finally {
            await srv.close();
          }
        }
        assertEq(
          [minted, isKnownToAnMcpRouter(randomUUID())],
          [[["rfb", true, true], ["experiences", true, true], ["dental", true, true]], false],
          "I6: a session each real router minted on initialize is known to isKnownToAnMcpRouter; a fresh UUID is not"
        );
        const knownNow = () => sids.map((sid) => isKnownToAnMcpRouter(sid));
        assertEq(
          [withNoRouterLoaded(knownNow), knownNow()],
          [[[false, false, false], 0, [false, false, false]], [true, true, true]],
          "I6: with the three routers out of require.cache, none of the sessions they minted is known and asking loads none of them back; put back, all three are known again — the check reads the routers loaded at each call (review S1 of PR #1151)"
        );

        // End to end: installClientIp's default in enforce in front of the real Opplevagent router and its own chain.
        const db = freshDb();
        const s = storeOn(db);
        let clock = T0;
        const app = express();
        const mw = installClientIp(app, ENFORCE, { now: () => clock, log: () => {}, logError: () => {}, store: s.store });
        app.use(express.json());
        app.use("/mcp", routers.experiences);
        const srv = await listen(app);
        let flow: unknown[] = [];
        try {
          const first = await httpRequest(srv.port, "POST", "/mcp", hdr(), INIT); // the IP
          const sid = String(first.headers["mcp-session-id"] ?? "");
          const statuses = [first.status, (await httpRequest(srv.port, "POST", "/mcp", hdr(sid), { jsonrpc: "2.0", method: "notifications/initialized" })).status];
          for (let i = 1; i <= 5; i++) statuses.push((await httpRequest(srv.port, "POST", "/mcp", hdr(sid), { jsonrpc: "2.0", id: i, method: "tools/list", params: {} })).status);
          for (let i = 0; i < 3; i++) statuses.push((await httpRequest(srv.port, "POST", "/mcp", hdr(randomUUID()), { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })).status); // the IP
          const last = await httpRequest(srv.port, "POST", "/mcp", hdr(), INIT); // the IP
          statuses.push(last.status);
          flow = [statuses, Number(first.headers["ratelimit-remaining"]) - Number(last.headers["ratelimit-remaining"])];
        } finally {
          await srv.close();
          __resetInstalledClientIpForTesting();
        }
        clock = T0 + W;
        mw(fakeReq({ fci: "198.51.100.200", xff: flyXff("198.51.100.200"), ip: "198.51.100.200" }), {} as any, () => {});
        s.setNow(T0 + W + 1000);
        s.store.flush();
        const f = storedFanIn(db);
        db.close();
        assertEq(
          [...flow, f[0], f[1], f[3]],
          [[200, 202, 200, 200, 200, 200, 200, 404, 404, 404, 200], 4, 5, "mcp", 3],
          "I6: through installClientIp's default and the real Opplevagent router, AC2 counts against mcp exactly the 5 requests its primary keyed on the IP (2 initialize, 3 stale ids: RateLimit-Remaining fell by 4 after the first), not the 6 in the session"
        );
      } finally {
        __setDbAccessorFailureForTesting(null);
      }
    }
    {
      // I3: covered_ms. A process starting mid-window (a deploy, first request at 12:02:37) measured 2:23 of it, not 5 min.
      // Its later windows' first requests come 7 s after their starts: they still count in full.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      play(r, healthChecks(T0 + 157_000, T0 + 3 * W + 30_000));
      s.setNow(T0 + 3 * W + 30_000);
      s.store.flush();
      assertEq(
        (db.prepare("SELECT window_start, covered_ms FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((x) => [x.window_start, x.covered_ms]),
        [[iso(T0), 143_000], [iso(T0 + W), W], [iso(T0 + 2 * W), W]],
        "I3: first request 2:37 into a window → that row covers 143 000 ms; every later one the full 300 000, though its first request came at :07"
      );
      assertEq([cum(r.mw.opsSnapshot()).windows, cum(r.mw.opsSnapshot()).hours_covered], [3, (143_000 + 2 * W) / H], "I3: … so hours_covered is 12 min 23 s over 3 windows, not 15 min");
      // The restart itself: process A's open window (3) is never stored; process B starts 3:30 into it.
      const b = storeOn(db);
      const rb = rig(SHADOW, b.store);
      play(rb, healthChecks(T0 + 3 * W + 210_000, T0 + 5 * W + 1));
      b.setNow(T0 + 5 * W + 1000);
      b.store.flush();
      assertEq(
        [(db.prepare("SELECT covered_ms FROM client_ip_shadow_windows WHERE window_start = ?").get(iso(T0 + 3 * W)) as any)?.covered_ms, cum(rb.mw.opsSnapshot()).hours_covered],
        [90_000, (143_000 + 2 * W + 90_000 + W) / H],
        "I3: after a restart 3:30 into window 3, B's first row covers 90 000 ms; hours_covered continues from A's rows"
      );
      db.close();
    }
    {
      // I3: the 48 h gate after a mid-window start: 576 stored windows are 47.96 h, so ready comes one window later.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      for (let i = 0; i < 9; i++) r.ordinary(`198.51.0.${i}`, T0 + 150_000 + i * 1000);
      for (let w = 1; w <= 576; w++) {
        normalWindow(r, w);
        s.setNow(T0 + w * W + 60_000);
        s.store.flush();
      }
      const before = r.mw.opsSnapshot();
      assertEq(
        [cum(before).windows, before.ac2?.ready, failing(before.ac2), before.ac2?.criteria.hours_covered.value],
        [576, false, ["hours_covered"], (575 * W + 150_000) / H],
        "I3: 576 stored windows, the first one partial (47.96 h) → ac2.ready false on hours_covered alone"
      );
      r.ordinary("198.51.100.250", T0 + 577 * W);
      s.setNow(T0 + 577 * W + 60_000);
      s.store.flush();
      const after = r.mw.opsSnapshot();
      assertEq([cum(after).windows, after.ac2?.ready, after.ac2?.criteria.hours_covered.value], [577, true, (576 * W + 150_000) / H], "I3: the 577th (48.04 h) → ready");
      db.close();
    }
    {
      // I3: two machines in one window measured it once: the larger covered_ms, never the sum; other modes are not summed.
      const db = freshDb();
      const a = storeOn(db);
      const b = storeOn(db, { machine: "m2" });
      const e = storeOn(db, { machine: "m3" });
      a.store.enqueue(rec(T0, 1, null, 100_000));
      b.store.enqueue(rec(T0, 1, null, 250_000));
      a.store.enqueue(rec(T0 + W, 1, null, W));
      b.store.enqueue(rec(T0 + W, 1, null, W));
      e.store.enqueue({ ...rec(T0 + 2 * W), mode: "enforce" });
      a.store.flush();
      b.store.flush();
      e.store.flush();
      const t = a.store.totals("shadow");
      assertEq([t.rows, t.windows, t.coveredMs, a.store.totals("enforce").coveredMs], [4, 2, 250_000 + W, W], "I3: per window the larger covered_ms (250 000 + 300 000), not the sum (950 000); the enforce row only in an enforce read");
      db.close();
    }
    {
      // I3: the migration on a table trinn 1c created, with rows: covered_ms is added NOT NULL DEFAULT 300 000, so a row
      // stored before 1d counts as the full window it counted as then; re-running it changes nothing.
      const ddl = loadDdl();
      assertEq(
        ddl.alters,
        [
          "ALTER TABLE client_ip_shadow_windows ADD COLUMN covered_ms INTEGER NOT NULL DEFAULT 300000",
          "ALTER TABLE client_ip_shadow_windows ADD COLUMN non_public_by_json TEXT",
        ],
        "I3: the ALTERs on the table (trinn 1d, 1e), each additive"
      );
      const db = new Database(":memory:");
      db.exec(ddl.create);
      db.prepare(
        "INSERT INTO client_ip_shadow_windows (window_start, machine, mode, n, fci_valid, fallback_missing, fallback_invalid, fallback_non_public, fallback_hc, errors, xff_client_supplied, agree_fci_edge_n, agree_fci_edge_agree, agree_legacy_eq_fci_n, agree_legacy_eq_fci_agree, would_trip, top_overflow, created_at) VALUES (?, 'm1', 'shadow', 9, 9, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9, 0, 0, ?)"
      ).run(iso(T0), iso(T0 + W));
      migrate(db);
      migrate(db);
      const col = (db.prepare("PRAGMA table_info(client_ip_shadow_windows)").all() as any[]).find((c) => c.name === "covered_ms");
      const s = storeOn(db);
      s.store.enqueue(rec(T0 + W, 1, null, 150_000));
      s.store.flush();
      assertEq(
        [col?.type, col?.notnull, col?.dflt_value, (db.prepare("SELECT covered_ms FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((x) => x.covered_ms), s.store.totals("shadow").coveredMs],
        ["INTEGER", 1, "300000", [W, 150_000], W + 150_000],
        "I3: the old row reads 300 000 (a full window, as before); a new row stores its own covered_ms"
      );
      db.close();
    }
    {
      // I4: the store's timer flush runs inside trackJob, so a stall or a [slow-job] line names it.
      const db = freshDb();
      const during: string[][] = [];
      const s = storeOn(db, { flushEveryMs: 10, getDb: () => { during.push(getEventLoopReport().activeJobsNow.map((j) => j.name)); return db; } });
      s.store.enqueue(rec(T0));
      for (let i = 0; i < 50 && rowCount(db) === 0; i++) await new Promise((res) => setTimeout(res, 10));
      s.store.stop();
      assertEq(
        [FLUSH_JOB_NAME, rowCount(db), during.length > 0 && during.every((names) => names.includes(FLUSH_JOB_NAME))],
        ["client-ip-shadow-flush", 1, true],
        "I4: while the timer's flush touches the DB it is an active job named client-ip-shadow-flush"
      );
      assertTrue(!getEventLoopReport().activeJobsNow.some((j) => j.name === FLUSH_JOB_NAME), "I4: … and no longer once it returns");
      db.close();
    }

    // ── J. Trinn 1e: non_public_by survives a deploy, and old rows read as unknown ──
    const total = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
    const splits = (c: ClientIpCounters) => [c.fallback.non_public, total(c.non_public_by.range), total(c.non_public_by.route), total(c.non_public_by.ua)];
    {
      // J1: through the middleware, two windows of non_public, flushed, then read by a new process (new store, same DB).
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      const np = (fci: string, path: string, at: number, ua?: string) => r.send({ fci, xff: flyXff("198.51.100.5"), ip: "198.51.100.5", path, ua }, at);
      np("::ffff:172.16.3.4", "/api/x", T0 + 1000);
      np("::ffff:172.16.3.5", "/api/x", T0 + 2000);
      np("fdaa:0:1::2", "/mcp", T0 + 3000, CHATGPT_UA);
      r.ordinary("198.51.100.1", T0 + 4000);
      np("fdaa::9", "/a2a", T0 + W + 1000);
      np("127.0.0.1", "/", T0 + W + 2000);
      r.ordinary("198.51.100.1", T0 + 2 * W); // closes window T0 + W
      s.store.flush();
      const json = (db.prepare("SELECT non_public_by_json AS j FROM client_ip_shadow_windows ORDER BY window_start").all() as any[]).map((x) => JSON.parse(x.j));
      assertEq(
        json,
        [
          { range: { v4_172_16: 2, v6_ula: 1 }, route: { api: 2, mcp: 1 }, ua: { none: 2, "ai_search:chatgpt": 1 } },
          { range: { v4_loopback: 1, v6_ula: 1 }, route: { a2a: 1, other: 1 }, ua: { none: 2 } },
        ],
        "J1: each row stores its window's non_public_by as compact JSON of the non-zero counts"
      );
      const fresh = rig(SHADOW, storeOn(db).store); // a restart: nothing in since_boot, everything in cumulative
      const c = cum(fresh.mw.opsSnapshot()).counters;
      const zeroRange = counters(0).non_public_by.range;
      assertEq(
        c.non_public_by,
        {
          range: { ...zeroRange, v4_172_16: 2, v4_loopback: 1, v6_ula: 2, unknown: 0 },
          route: { api: 2, a2a: 1, mcp: 1, other: 1, unknown: 0 },
          ua: { none: 4, "ai_search:chatgpt": 1, unknown: 0 },
          unknown_rows: 0,
        },
        "J1: cumulative.counters.non_public_by sums the stored rows per range, route and UA class, across a restart"
      );
      assertEq(splits(c), [5, 5, 5, 5], "J1: cumulative — range, route and ua each sum to fallback.non_public");
      assertEq(fresh.mw.opsSnapshot().since_boot.non_public_by.range, zeroRange, "J1: … while the new process's since_boot starts at 0");
      db.close();
    }
    {
      // J2: a table from before trinn 1e, with rows: the column is added nullable, old rows stay NULL and read as unknown.
      const ddl = loadDdl();
      const db = new Database(":memory:");
      db.exec(ddl.create);
      db.exec(ddl.alters[0]); // trinn 1d's covered_ms
      const old = db.prepare(
        "INSERT INTO client_ip_shadow_windows (window_start, machine, mode, n, fci_valid, fallback_missing, fallback_invalid, fallback_non_public, fallback_hc, errors, xff_client_supplied, agree_fci_edge_n, agree_fci_edge_agree, agree_legacy_eq_fci_n, agree_legacy_eq_fci_agree, would_trip, top_overflow, created_at) VALUES (?, 'm0', 'shadow', 50, 40, 0, 0, ?, 0, 0, 0, 40, 40, 40, 40, 0, 0, ?)"
      );
      old.run(iso(T0 - 3 * W), 4, iso(T0));
      old.run(iso(T0 - 2 * W), 0, iso(T0)); // nothing to explain: not an unknown row
      old.run(iso(T0 - W), 7, iso(T0));
      migrate(db);
      migrate(db);
      const col = (db.prepare("PRAGMA table_info(client_ip_shadow_windows)").all() as any[]).find((x) => x.name === "non_public_by_json");
      assertEq([col?.type, col?.notnull, col?.dflt_value], ["TEXT", 0, null], "J2: non_public_by_json is added as nullable TEXT, no default");
      const s = storeOn(db);
      s.store.enqueue(rec(T0, 1));
      s.store.flush();
      const t = s.store.totals("shadow");
      assertEq(
        [t.counters.fallback.non_public, t.counters.non_public_by],
        [11 + 3, stored(counters(1), 11, 2).non_public_by],
        "J2: old rows' non_public (4 + 7) is unknown in range, route and ua; unknown_rows = the 2 old rows with non_public > 0"
      );
      assertEq(splits(t.counters), [14, 14, 14, 14], "J2: with old rows too, each split sums to fallback.non_public");
      db.close();
    }
    {
      // J3: a breakdown that cannot be trusted reads as unknown, never surfaces: not JSON, a key that is no code
      // (an IP-shaped one included), a split not summing to the row's non_public, a negative count.
      const db = freshDb();
      const s = storeOn(db);
      for (let i = 0; i < 5; i++) s.store.enqueue(rec(T0 + i * W, 1));
      s.store.flush();
      const set = db.prepare("UPDATE client_ip_shadow_windows SET non_public_by_json = ? WHERE window_start = ?");
      set.run("not json", iso(T0));
      set.run(JSON.stringify({ range: { "10.1.2.3": 3 }, route: { api: 3 }, ua: { none: 3 } }), iso(T0 + W));
      set.run(JSON.stringify({ range: { v4_10: 2 }, route: { api: 3 }, ua: { none: 3 } }), iso(T0 + 2 * W));
      set.run(JSON.stringify({ range: { v4_10: 4, v6_ula: -1 }, route: { api: 3 }, ua: { none: 3 } }), iso(T0 + 3 * W));
      const t = s.store.totals("shadow");
      assertEq(t.counters.non_public_by, stored(counters(1), 12, 4).non_public_by, "J3: the four untrusted rows are unknown (4 × 3), only the good row is split");
      assertTrue(!JSON.stringify(t.counters.non_public_by).includes("10.1.2.3"), "J3: an IP-shaped key in a stored row never reaches cumulative");
      db.close();
    }
    {
      // J3b: a ua key that is one of Object.prototype's own names ("__proto__", "constructor") matches the UA
      // class pattern, but out["__proto__"] = n stores nothing: the row must read as unknown, not pass with its
      // ua count lost (review finding on trinn 1e).
      const db = freshDb();
      const s = storeOn(db);
      for (let i = 0; i < 3; i++) s.store.enqueue(rec(T0 + i * W, 1));
      s.store.flush();
      const good = JSON.parse((db.prepare("SELECT non_public_by_json AS j FROM client_ip_shadow_windows WHERE window_start = ?").get(iso(T0)) as any).j);
      const withUa = (key: string) => JSON.stringify({ range: good.range, route: good.route }).slice(0, -1) + `,"ua":{"${key}":3}}`;
      const set = db.prepare("UPDATE client_ip_shadow_windows SET non_public_by_json = ? WHERE window_start = ?");
      set.run(withUa("__proto__"), iso(T0));
      set.run(withUa("constructor"), iso(T0 + W));
      const t = s.store.totals("shadow");
      assertEq(t.counters.non_public_by, stored(counters(1), 6, 2).non_public_by, "J3b: rows with a __proto__ / constructor ua key are unknown (2 × 3), only the good row is split");
      assertEq(splits(t.counters), [9, 9, 9, 9], "J3b: … and each split still sums to fallback.non_public");
      db.close();
    }
    {
      // J4: codes and counts only, in the column and in cumulative: no IP-like string, hash or host name.
      const db = freshDb();
      const s = storeOn(db);
      const r = rig(SHADOW, s.store);
      const addrs = ["10.9.8.7", "::ffff:172.16.0.9", "192.168.4.4", "100.64.9.9", "169.254.169.254", "224.0.0.9", "fdaa:0:2::7", "::1", "fe80::77", "ff02::9"];
      addrs.forEach((fci, i) => r.send({ fci, xff: flyXff("198.51.100.5"), ip: "198.51.100.5", path: ["/api/x", "/a2a", "/mcp", "/"][i % 4], ua: i % 2 ? CHATGPT_UA : undefined }, T0 + i * 1000));
      r.ordinary("198.51.100.1", T0 + W);
      s.store.flush();
      const col = (db.prepare("SELECT non_public_by_json AS j FROM client_ip_shadow_windows").all() as any[]).map((x) => x.j).join("\n");
      const out = JSON.stringify(cum(r.mw.opsSnapshot()).counters.non_public_by);
      const ipLike = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|::|[0-9a-f]{1,4}:[0-9a-f]{1,4}|[0-9a-f]{12}|fdaa|fe80|ff02|\.com|\.no\b/i;
      assertTrue(col.length > 0 && !ipLike.test(col) && !ipLike.test(out), "J4: no IP-like string, hash or host name in non_public_by_json or cumulative non_public_by");
      assertEq(splits(cum(r.mw.opsSnapshot()).counters), [10, 10, 10, 10], "J4: … and each split sums to fallback.non_public");
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runClientIpShadowStoreTests({ log: true }).then((r) => {
    console.log(`\nclient-ip-shadow-store: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
