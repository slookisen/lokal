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
 *
 * Own in-memory / temp-file DBs, injected clocks, no timers except B's one
 * short unref'd timer (stopped). The DB-accessor failure hook and the
 * installed-instance slot are reset at the end.
 *
 * Standalone: npx tsx src/services/client-ip-shadow-store.test.ts
 */

import Database from "better-sqlite3";
import express from "express";
import fs from "fs";
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
  __resetInstalledClientIpForTesting,
  type ClientIpAc2,
  type ClientIpConfig,
  type ClientIpCounters,
  type ClientIpCumulative,
  type ClientIpOpsSnapshot,
} from "../middleware/client-ip";
import { MCP_RATE_LIMIT_PROFILES } from "../middleware/mcp-rate-limit";
import { __setDbAccessorFailureForTesting } from "../database/init";
import {
  CLIENT_IP_WINDOW_RETENTION_DAYS,
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
];
const NO_NONZERO_WINDOWS = { top_overflow: { windows: 0, last: null }, invalid_non_public: { windows: 0, last: null } };
const CRITERIA = [
  "hours_covered", "requests", "fallback_beyond_health_checks", "invalid_non_public", "agree_fci_edge",
  "agree_legacy_eq_fci", "would_trip", "fanin_limit_ratio", "top_overflow",
];

function loadDdl(): string {
  const src = fs.readFileSync(path.join(__dirname, "..", "database", "init.ts"), "utf8");
  const m = src.match(/CREATE TABLE IF NOT EXISTS client_ip_shadow_windows \([\s\S]*?\);\s*CREATE INDEX IF NOT EXISTS idx_client_ip_shadow_windows_start[^;]*;/);
  if (!m) throw new Error("client_ip_shadow_windows DDL not found in database/init.ts");
  return m[0];
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(loadDdl());
  return db;
}

/** Every counter a distinct value (times k), so a swapped or dropped column shows. */
function counters(k = 1): ClientIpCounters {
  return {
    n: 1000 * k,
    fci_valid: 900 * k,
    fallback: { missing: 11 * k, invalid: 2 * k, non_public: 3 * k },
    fallback_hc: 10 * k,
    errors: 4 * k,
    xff_client_supplied: 5 * k,
    agree_fci_edge: { n: 800 * k, agree: 799 * k },
    agree_legacy_eq_fci: { n: 700 * k, agree: 698 * k },
    would_trip: 6 * k,
    top_overflow: 7 * k,
  };
}

const rec = (windowStart: number, k = 1, fanIn: ClientIpWindowRecord["fanIn"] = null): ClientIpWindowRecord => ({
  windowStart,
  mode: "shadow",
  counters: counters(k),
  fanIn,
});

/** A request object as the middleware sees it. */
function fakeReq(o: { fci?: unknown; xff?: unknown; ip?: string; path?: string; ua?: string }): any {
  const headers: Record<string, unknown> = {};
  if (o.fci !== undefined) headers["fly-client-ip"] = o.fci;
  if (o.xff !== undefined) headers["x-forwarded-for"] = o.xff;
  if (o.ua !== undefined) headers["user-agent"] = o.ua;
  return { headers, path: o.path ?? "/api/x", ip: o.ip };
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
  function rig(cfg: ClientIpConfig, store: ClientIpShadowStore | null, onRequest?: (inRequest: boolean) => void) {
    let clock = T0;
    const lines: string[] = [];
    const mw = createClientIpMiddleware(cfg, { now: () => clock, log: (l) => lines.push(l), logError: () => {}, store });
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
      db.exec(loadDdl());
      assertEq(cols.length, COLUMNS.length, "A: the migration is idempotent (re-run without error)");
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
        [2, 2, 1, iso(T0), iso(T0 + W), counters(3), { ratio: 0.25, class: "a2a", fanIn: 3, ua: "ai_search:claude", window_start: iso(T0 + W) }],
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
        n: line.n, fci_valid: line.fci_valid, fallback: line.fallback, fallback_hc: line.fallback_hc, errors: line.errors,
        xff_client_supplied: line.xff_client_supplied, agree_fci_edge: line.agree_fci_edge, agree_legacy_eq_fci: line.agree_legacy_eq_fci,
        would_trip: line.would_trip, top_overflow: line.top_overflow,
      };
      const leaves = (o: any): number[] => (typeof o === "number" ? [o] : Object.values(o ?? {}).flatMap(leaves));
      assertTrue(r.lines.length === 1 && leaves(fromLine).every((v) => v > 0), "C2: (setup) the logged window has every counter non-zero");
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
      dbA.exec(loadDdl());
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
      dbB.exec(loadDdl());
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
      // C7: the per-window fanIn ratio — a top key with fanIn > 1, its requests per limiter over the 15-min top list / that limit.
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
          [iso(T0 + 3 * W), 0.466667, "general", 2, "ai_search:chatgpt"],
          [iso(T0 + 4 * W), 0.3, "mcp", 2, "ai_search:chatgpt"],
          [iso(T0 + 5 * W), null, null, null, null],
        ],
        "C7: per window, the 15-min top list's largest requests/limit of a fanIn > 1 key (/api 100 → 240 → 240 of 300, 140 as the first window leaves, then /mcp 60 of 200); a fanIn 1 key (290 /api) is never rated"
      );
      const snap = r.mw.opsSnapshot();
      assertEq(cum(snap).fanin_max, { ratio: 0.8, class: "general", fanIn: 2, ua: "ai_search:chatgpt", window_start: iso(T0 + 2 * W) }, "C7: cumulative.fanin_max is the largest stored (newest on a tie), with its class, fanIn and UA family");
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
          "/a2a", "/en/a2a", "/mcp", "/mcp/x", "/health", "/", "/produsent/x",
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
          ["/a2a", ["a2a", "dental"]], ["/en/a2a", ["a2a", "dental"]], ["/mcp", ["mcp"]], ["/mcp/x", ["mcp"]], ["/health", []], ["/", []], ["/produsent/x", []],
        ],
        "C7: ac2LimitersFor mirrors the mounts (segment-wise, case-insensitive, after the /en and /sv strip): search is also general; /api/tannlege* is not general (generalLimiter's case-sensitive skip) but dental; /a2a counts against jsonRpcLimiter and dentalLimiter"
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
        counters: { n: 0, fci_valid: 0, fallback: { missing: 0, invalid: 0, non_public: 0 }, fallback_hc: 0, errors: 0, xff_client_supplied: 0, agree_fci_edge: { n: 0, agree: 0 }, agree_legacy_eq_fci: { n: 0, agree: 0 }, would_trip: 0, top_overflow: 0 },
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
          [200, 1, counters(1), false, CRITERIA],
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
      assertEq(
        [AC2_FANIN_LIMITS, ceiling("generalLimiter"), flat("searchLimiter"), ceiling("jsonRpcLimiter"), flat("dentalLimiter"), Math.min(...mcp.map((p) => p.anonymousMax)), mcp.every((p) => p.windowMs === 15 * 60_000)],
        [{ general: 300, search: 150, a2a: 200, dental: 1000, mcp: 200 }, 300, 150, 200, 1000, 200, true],
        "H: AC2_FANIN_LIMITS = generalLimiter / searchLimiter / jsonRpcLimiter / dentalLimiter / the smallest MCP primary ceiling, all per 15 min"
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
          'routes/gardssalg-claim.ts: router.post("/api/opplevelser/gardssalg-claim/:providerId/update-profile", generalLimiter, express.json(), (req: Request, res: Response) => {',
          'routes/gardssalg-claim.ts: router.post("/kategori/gardssalg/eier/:providerSlug/logout", generalLimiter, (req: Request, res: Response) => {',
          'routes/seo.ts: router.get("/sok", generalLimiter, async (req: Request, res: Response) => {',
          // POST /kategori/gardssalg/book/:providerSlug (experiences-seo.ts) and POST
          // /kategori/gardssalg/eier/:providerId/request and …/:providerSlug/save (gardssalg-claim.ts) carry
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
