// admin-order-daily-sums.ts — nightly frozen day sums for the admin order /
// referral dashboard (GET /admin/api/ordre/*, /admin/ordre).
//
// dev-request 2026-10-23-admin-ordre-og-henvisningsdashbord, slice S5
// (spec point 9, AC7): «en nattlig jobb skriver dagssummer uten persondata
// (plattform × metrikk × dimensjon × dag) til en egen tabell», so the
// dashboard history survives when single rows are later deleted.
//
// WHAT: for every completed UTC day (never today), every source below gets
// the same grouped rows the live dashboard query produces
// (services/admin-order-stats.ts query*Rows, oppl=dag), written to
// admin_order_daily_sums in lokal.db with INSERT OR IGNORE — a day, once
// written, is FROZEN: a later run never overwrites it, so deleting an
// underlying row afterwards cannot change that day's sum. Each source/day
// also gets a marker row ('<kilde>.rader', dimensjon '') holding the row
// count, written even for a day with zero rows. How the dashboard uses the
// sums is described at «Daily sums» in services/admin-order-stats.ts.
//
// SOURCES (all sums in lokal.db; gårdssalg reads experiences.db only when
// ENABLE_EXPERIENCES=1, like the route):
//   rfb        ordre           orders           (agent, status, test)
//   rfb        overleveringer  cart_handoffs    (test)
//   rfb        klikk           contact_clicks   (agent, kind, bot, test)
//   gardssalg  forespoersler   gardssalg_bookings (provider, status, pre_status, test)
//   opplevelser / gardssalg / tannlege  klikk  profile_link_clicks (provider, kind, bot, test)
// No personal data is read into a dimension: never buyer_* / guest_* /
// notes / delivery_note / session_id / utm / IP — only ids, statuses, the
// click type (closed vocabulary) and the bot / test flags.
//
// BACKFILL: the first run fills history back to the source's first row
// (at most DAILY_SUMS_LOOKBACK_DAYS), newest day first, so yesterday is
// always written on the first night. Per run: at most
// DAILY_SUMS_MAX_DAYS_PER_SOURCE days per source and DAILY_SUMS_MAX_ROWS_PER_RUN
// rows in all; the rest is picked up the next nights.
//
// STALL SAFETY (dev-request 2026-10-08-serverheng-hovedtraad-…): one grouped
// query per chunk of at most DAILY_SUMS_CHUNK_DAYS days per source, written
// in one transaction, then a setImmediate before the next chunk. Starts only
// in [03, 06) UTC and stops at 06 UTC (same window as privacy-retention); a
// module flag stops two runs overlapping. Called from index.ts autoPruneTick
// (the 03:00 UTC window). Never throws from the tick.
//
// SWITCH: on by default — it only adds aggregate rows without personal data
// (the same posture as the traffic-history rollup before the analytics
// prune). ADMIN_ORDER_DAILY_SUMS_DISABLED=1 turns it off.

import type Database from "better-sqlite3";
import {
  DAILY_SUMS_TABLE,
  MAX_PERIOD_DAYS,
  ORDRE_CODEC,
  OVERLEVERINGER_CODEC,
  FORESPOERSLER_CODEC,
  RFB_KLIKK_CODEC,
  PROFIL_HENVISNING_PLATTFORMER,
  profilKlikkCodec,
  dailySumMarkerMetric,
  encodeDailySumDimension,
  queryRfbOrderRows,
  queryRfbHandoffRows,
  queryGardssalgRows,
  queryRfbClickRows,
  queryProfilClickRows,
  type DailySumCodec,
} from "./admin-order-stats";

type Db = Database.Database;

export const DAILY_SUMS_START_HOUR_UTC = 3;
export const DAILY_SUMS_STOP_HOUR_UTC = 6;
/** Oldest day the job ever writes (= the longest period the dashboard accepts). */
export const DAILY_SUMS_LOOKBACK_DAYS = MAX_PERIOD_DAYS;
export const DAILY_SUMS_MAX_DAYS_PER_SOURCE = 120;
export const DAILY_SUMS_CHUNK_DAYS = 31;
export const DAILY_SUMS_MAX_ROWS_PER_RUN = 50_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dayAdd(dag: string, n: number): string {
  return isoDate(new Date(Date.parse(dag + "T00:00:00.000Z") + n * DAY_MS));
}
function sqliteDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
function tableExists(db: Db, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}
function yieldMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export function isAdminOrderDailySumsDisabled(raw: string | undefined = process.env.ADMIN_ORDER_DAILY_SUMS_DISABLED): boolean {
  return raw === "1";
}

interface Source {
  /** '<plattform>.<kilde>' — report key. */
  key: string;
  codec: DailySumCodec;
  /** First day with a row (text day of MIN(created_at)), or null when the source is empty. */
  firstDay: () => string | null;
  /** Grouped rows created in [fra, tilEksklusiv), each with `dag` and `n`. */
  rows: (fra: string, tilEksklusiv: string) => Array<Record<string, unknown> & { dag: string | null; n: number }>;
}

function minDay(db: Db, sql: string, ...args: unknown[]): string | null {
  const r = db.prepare(sql).get(...args) as { d: string | null } | undefined;
  const d = r?.d ? String(r.d).slice(0, 10) : null;
  return d && DATE_RE.test(d) ? d : null;
}

/** The sources the job can read now (a missing table or DB is simply left out). */
export function dailySumSources(rfb: Db, exp: Db | null): { sources: Source[]; skipped: string[] } {
  const sources: Source[] = [];
  const skipped: string[] = [];
  if (tableExists(rfb, "orders")) {
    sources.push({
      key: "rfb.ordre", codec: ORDRE_CODEC,
      firstDay: () => minDay(rfb, "SELECT MIN(created_at) AS d FROM orders"),
      rows: (f, t) => queryRfbOrderRows(rfb, f, t, "dag") as any,
    });
  } else skipped.push("rfb.ordre");
  if (tableExists(rfb, "cart_handoffs")) {
    sources.push({
      key: "rfb.overleveringer", codec: OVERLEVERINGER_CODEC,
      firstDay: () => minDay(rfb, "SELECT MIN(created_at) AS d FROM cart_handoffs"),
      rows: (f, t) => queryRfbHandoffRows(rfb, f, t) as any,
    });
  } else skipped.push("rfb.overleveringer");
  if (tableExists(rfb, "contact_clicks")) {
    sources.push({
      key: "rfb.klikk", codec: RFB_KLIKK_CODEC,
      firstDay: () => minDay(rfb, "SELECT MIN(created_at) AS d FROM contact_clicks"),
      rows: (f, t) => queryRfbClickRows(rfb, f, t, "dag") as any,
    });
  } else skipped.push("rfb.klikk");
  if (exp && tableExists(exp, "gardssalg_bookings") && tableExists(exp, "experience_providers")) {
    sources.push({
      key: "gardssalg.forespoersler", codec: FORESPOERSLER_CODEC,
      firstDay: () => minDay(exp, "SELECT MIN(created_at) AS d FROM gardssalg_bookings"),
      rows: (f, t) => queryGardssalgRows(exp, f, t, "dag") as any,
    });
  } else skipped.push("gardssalg.forespoersler");
  if (tableExists(rfb, "profile_link_clicks")) {
    for (const p of PROFIL_HENVISNING_PLATTFORMER) {
      sources.push({
        key: `${p}.klikk`, codec: profilKlikkCodec(p),
        firstDay: () => minDay(rfb, "SELECT MIN(created_at) AS d FROM profile_link_clicks WHERE platform = ?", p),
        rows: (f, t) => queryProfilClickRows(rfb, p, f, t, "dag") as any,
      });
    }
  } else for (const p of PROFIL_HENVISNING_PLATTFORMER) skipped.push(`${p}.klikk`);
  return { sources, skipped };
}

export interface DailySumsOptions {
  /** Clock; injectable for tests. */
  now?: () => Date;
  /** Start only in [03,06) UTC and stop at 06 UTC. Default true. */
  enforceWindow?: boolean;
  lookbackDays?: number;
  maxDaysPerSource?: number;
  chunkDays?: number;
  maxRowsPerRun?: number;
  /** Default: the ADMIN_ORDER_DAILY_SUMS_DISABLED env switch. */
  disabled?: boolean;
}

export interface DailySumsReport {
  stopped_reason: "done" | "row_cap" | "window_closed" | "outside_window" | "disabled" | "already_running" | "no_table";
  /** Days written this run per source key. */
  days_written: Record<string, number>;
  rows_written: number;
  /** Days still missing (within the lookback) after this run, per source key. */
  remaining: Record<string, number>;
  /** Sources whose table / database is not available. */
  skipped: string[];
  newest_day: string | null;
  ms: number;
}

function emptyReport(reason: DailySumsReport["stopped_reason"]): DailySumsReport {
  return { stopped_reason: reason, days_written: {}, rows_written: 0, remaining: {}, skipped: [], newest_day: null, ms: 0 };
}

function inWindow(d: Date): boolean {
  const h = d.getUTCHours();
  return h >= DAILY_SUMS_START_HOUR_UTC && h < DAILY_SUMS_STOP_HOUR_UTC;
}

let running = false;
/** Test-only. */
export function __setAdminOrderDailySumsRunningForTesting(v: boolean): void {
  running = v;
}

/** The missing days of one source, newest first (yesterday first). */
function missingDays(rfb: Db, src: Source, first: string, yesterday: string): string[] {
  const have = new Set(
    (rfb.prepare(
      `SELECT dag FROM ${DAILY_SUMS_TABLE} WHERE plattform = ? AND metrikk = ? AND dimensjon = '' AND dag >= ? AND dag <= ?`
    ).all(src.codec.plattform, dailySumMarkerMetric(src.codec), first, yesterday) as Array<{ dag: string }>).map((r) => r.dag)
  );
  const out: string[] = [];
  for (let d = yesterday; d >= first; d = dayAdd(d, -1)) if (!have.has(d)) out.push(d);
  return out;
}

/** Split days (newest first) into chunks whose span is at most `chunkDays`. */
function chunkDaysDesc(days: string[], chunkDays: number): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const d of days) {
    if (cur.length > 0 && Date.parse(cur[0]) - Date.parse(d) >= chunkDays * DAY_MS) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(d);
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * The job. Writes frozen day sums for completed UTC days only; never
 * overwrites an existing row. Not meant to throw, but a DB error inside a
 * chunk rolls back that chunk only and is rethrown to the tick.
 */
export async function runAdminOrderDailySums(rfb: Db, exp: Db | null, opts: DailySumsOptions = {}): Promise<DailySumsReport> {
  const disabled = opts.disabled ?? isAdminOrderDailySumsDisabled();
  if (disabled) return emptyReport("disabled");
  if (running) return emptyReport("already_running");
  const clock = opts.now ?? (() => new Date());
  const enforceWindow = opts.enforceWindow ?? true;
  const start = clock();
  if (enforceWindow && !inWindow(start)) return emptyReport("outside_window");
  if (!tableExists(rfb, DAILY_SUMS_TABLE)) return emptyReport("no_table");

  const lookback = Math.max(1, Math.floor(opts.lookbackDays ?? DAILY_SUMS_LOOKBACK_DAYS));
  const maxDays = Math.max(1, Math.floor(opts.maxDaysPerSource ?? DAILY_SUMS_MAX_DAYS_PER_SOURCE));
  const chunkDays = Math.max(1, Math.floor(opts.chunkDays ?? DAILY_SUMS_CHUNK_DAYS));
  const maxRows = Math.max(1, Math.floor(opts.maxRowsPerRun ?? DAILY_SUMS_MAX_ROWS_PER_RUN));

  running = true;
  try {
    const t0 = Date.now();
    const today = isoDate(start);
    const yesterday = dayAdd(today, -1);
    const oldest = dayAdd(today, -lookback);
    const { sources, skipped } = dailySumSources(rfb, exp);
    const report: DailySumsReport = { ...emptyReport("done"), skipped, newest_day: yesterday };
    const computedAt = sqliteDateTime(start);
    const insert = rfb.prepare(
      `INSERT OR IGNORE INTO ${DAILY_SUMS_TABLE} (plattform, metrikk, dimensjon, dag, verdi, computed_at) VALUES (?, ?, ?, ?, ?, ?)`
    );

    outer: for (const src of sources) {
      report.days_written[src.key] = 0;
      const firstRow = src.firstDay();
      if (firstRow === null || firstRow > yesterday) { report.remaining[src.key] = 0; continue; }
      const first = firstRow > oldest ? firstRow : oldest;
      const missing = missingDays(rfb, src, first, yesterday);
      const todo = missing.slice(0, maxDays);
      report.remaining[src.key] = missing.length;
      const marker = dailySumMarkerMetric(src.codec);
      const measures = Object.entries(src.codec.measures);

      for (const chunk of chunkDaysDesc(todo, chunkDays)) {
        if (report.rows_written >= maxRows) { report.stopped_reason = "row_cap"; break outer; }
        if (enforceWindow && !inWindow(clock())) { report.stopped_reason = "window_closed"; break outer; }
        const lo = chunk[chunk.length - 1];
        const hi = chunk[0];
        const rows = src.rows(lo, dayAdd(hi, 1));
        // dag → dimensjon → summed measures (rows that differ only in a
        // non-stored column, e.g. the bucket, fold into one dimension).
        const byDay = new Map<string, Map<string, Record<string, number>>>();
        for (const r of rows) {
          if (r.dag === null) continue;
          let dims = byDay.get(r.dag);
          if (!dims) { dims = new Map(); byDay.set(r.dag, dims); }
          const dim = encodeDailySumDimension(src.codec, r);
          let acc = dims.get(dim);
          if (!acc) { acc = {}; for (const [maal] of measures) acc[maal] = 0; dims.set(dim, acc); }
          for (const [maal, field] of measures) acc[maal] += Number(r[field] ?? 0);
        }
        let written = 0;
        rfb.transaction(() => {
          for (const dag of chunk) {
            if (dag >= today) continue; // never an incomplete day
            const dims = byDay.get(dag) ?? new Map<string, Record<string, number>>();
            let rader = 0;
            for (const [dim, acc] of dims) {
              rader += acc.antall ?? 0;
              for (const [maal] of measures) {
                written += insert.run(src.codec.plattform, `${src.codec.kilde}.${maal}`, dim, dag, acc[maal], computedAt).changes;
              }
            }
            written += insert.run(src.codec.plattform, marker, "", dag, rader, computedAt).changes;
            report.days_written[src.key]++;
          }
        })();
        report.rows_written += written;
        report.remaining[src.key] = Math.max(0, report.remaining[src.key] - chunk.length);
        await yieldMacrotask();
      }
    }
    report.ms = Date.now() - t0;
    return report;
  } finally {
    running = false;
  }
}

export function formatAdminOrderDailySumsLog(r: DailySumsReport): string {
  if (r.stopped_reason === "disabled") return "[admin-order-daily-sums] disabled (ADMIN_ORDER_DAILY_SUMS_DISABLED=1)";
  if (r.stopped_reason === "already_running") return "[admin-order-daily-sums] skipped: previous run still in progress";
  if (r.stopped_reason === "outside_window") return "[admin-order-daily-sums] skipped: outside 03–06 UTC window";
  if (r.stopped_reason === "no_table") return "[admin-order-daily-sums] skipped: table admin_order_daily_sums missing";
  return (
    `[admin-order-daily-sums] newest_day=${r.newest_day} days_written=${JSON.stringify(r.days_written)} rows_written=${r.rows_written} ` +
    `remaining=${JSON.stringify(r.remaining)} skipped=${JSON.stringify(r.skipped)} stopped=${r.stopped_reason} ms=${r.ms}`
  );
}

/** The experiences DB when ENABLE_EXPERIENCES=1 (same rule as the route), else null. */
function experiencesDbOrNull(): Db | null {
  if (process.env.ENABLE_EXPERIENCES !== "1") return null;
  try {
    const factory = require("../database/db-factory") as typeof import("../database/db-factory");
    return factory.getDb("experiences") as Db;
  } catch (err) {
    console.error(`[admin-order-daily-sums] experiences DB not available (gårdssalg skipped): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Nightly entry point (called from index.ts autoPruneTick). Never throws. */
export async function runAdminOrderDailySumsTick(rfb: Db): Promise<DailySumsReport | null> {
  try {
    const r = await runAdminOrderDailySums(rfb, experiencesDbOrNull());
    console.log(formatAdminOrderDailySumsLog(r));
    return r;
  } catch (err) {
    console.error("[admin-order-daily-sums] failed (non-fatal):", err);
    return null;
  }
}
