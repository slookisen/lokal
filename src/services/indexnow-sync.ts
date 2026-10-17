// ─── IndexNow sitemap-diff sync (dev-request 2026-10-16-indexnow-alle-verter, S2) ───
// State-based job: per enabled host, read the sitemap (the ONLY source — never agents /
// experiences / dental_agents directly, so an unpublished row cannot slip through), diff it
// against indexnow_submissions and submit new / advanced-lastmod / removed entity URLs via
// submitIndexNow, with a daily cap and persisted backoff. Default OFF (INDEXNOW_SYNC_ENABLED).
// First run per host stores a baseline and sends 0.

import { getDb } from "../database/init";
import { INDEXNOW_HOSTS, type IndexNowHost } from "./indexnow-hosts";
import { getJobLastCompletedAt, markJobCompleted, shouldSkipRecentRun } from "./boot-job-gate";

export const INDEXNOW_SYNC_JOB = "indexnow-sync";
/** First tick at boot + 10 min (after the geocode ticks at +3/+6 min). */
export const INDEXNOW_SYNC_BOOT_DELAY_MS = 10 * 60 * 1000;
export const INDEXNOW_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_HOURS = 0.5;
const REPEAT_AFTER_MS = 7 * 24 * 3600_000;
const CHUNK = 1000;

export interface SyncSitemapEntry { loc: string; lastmod: string | null }

export interface IndexNowSyncOptions {
  db?: any;
  now?: Date;
  fetchImpl?: typeof fetch;
  hosts?: IndexNowHost[];
  dailyCap?: number;
  buildWindowUtc?: string; // "HH-HH", default env INDEXNOW_BUILD_WINDOW_UTC or "01-05"
  backoffHours?: number; // 429 backoff, default 6
}

export interface HostSyncResult {
  host: string;
  skipped?: string; // disabled | cold_cache | backoff | empty_sitemap | error
  baseline?: number;
  submitted: number;
  pending?: number; // wanted but held back (cap / failed)
  status?: number;
}

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** O(n) regex parse of <url> blocks (no XML library). Duplicate <loc> keep the first. */
export function parseSitemapEntries(xml: string): SyncSitemapEntry[] {
  const out: SyncSitemapEntry[] = [];
  const seen = new Set<string>();
  const blockRe = /<url>([\s\S]*?)<\/url>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1]!;
    const loc = /<loc>\s*([^<]*?)\s*<\/loc>/.exec(block);
    if (!loc || !loc[1]) continue;
    const url = xmlDecode(loc[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    const lm = /<lastmod>\s*([^<]*?)\s*<\/lastmod>/.exec(block);
    out.push({ loc: url, lastmod: lm && lm[1] ? lm[1] : null });
  }
  return out;
}

function pathOf(url: string, baseUrl: string): string {
  return url.startsWith(baseUrl) ? url.slice(baseUrl.length) || "/" : url;
}

function lastmodAdvanced(prev: string | null, next: string | null): boolean {
  if (!next) return false;
  if (!prev) return true;
  const a = Date.parse(prev), b = Date.parse(next);
  if (Number.isNaN(a) || Number.isNaN(b)) return next > prev;
  return b > a;
}

/** "01-05" -> true when the UTC hour is in [1,5). Wraps midnight ("22-02"). Junk -> default 01-05. */
export function inBuildWindow(now: Date, raw: string | undefined): boolean {
  const mt = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw ?? "");
  let from = 1, to = 5;
  if (mt && +mt[1]! <= 24 && +mt[2]! <= 24) { from = +mt[1]!; to = +mt[2]!; }
  const h = now.getUTCHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** Tick is skipped 06:30-09:30 UTC (keeps the job away from deploy/send windows). */
export function inSendBlackout(now: Date): boolean {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 6 * 60 + 30 && mins < 9 * 60 + 30;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function nextUtcMidnight(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() + 24 * 3600_000);
}

interface Row { url: string; lastmod: string | null; last_submitted_at: string | null; removed_at: string | null }

type Plan = { url: string; kind: "new" | "changed" | "removed"; lastmod: string | null };

async function syncHost(h: IndexNowHost, o: Required<Pick<IndexNowSyncOptions, "db" | "now">> & IndexNowSyncOptions, cap: number, windowRaw: string | undefined, backoffH: number): Promise<HostSyncResult> {
  const { db, now } = o;
  const nowIso = now.toISOString();
  const res: HostSyncResult = { host: h.host, submitted: 0 };
  if (!h.enabled()) return { ...res, skipped: "disabled" };

  const state = db.prepare("SELECT baseline_at, backoff_until FROM indexnow_host_state WHERE host = ?").get(h.host) as
    | { baseline_at: string | null; backoff_until: string | null } | undefined;
  if (state?.backoff_until && state.backoff_until > nowIso) return { ...res, skipped: "backoff" };

  // 1. XML: peek first; a cold dental/OA cache is only built inside the build window.
  let xml: string;
  if (h.peekSitemapXml) {
    const peeked = h.peekSitemapXml();
    if (peeked) xml = peeked.xml;
    else if (inBuildWindow(now, windowRaw)) xml = h.getSitemapXml();
    else {
      console.log(`[indexnow-sync] host=${h.host} skipped=cold_cache`);
      return { ...res, skipped: "cold_cache" };
    }
  } else {
    xml = h.getSitemapXml();
  }

  // 2. parse
  const entries = parseSitemapEntries(xml).filter((e) => e.loc === h.baseUrl || e.loc.startsWith(h.baseUrl + "/"));
  if (entries.length === 0) {
    console.log(`[indexnow-sync] host=${h.host} skipped=empty_sitemap`);
    return { ...res, skipped: "empty_sitemap" };
  }

  const existing = new Map<string, Row>();
  for (const r of db.prepare("SELECT url, lastmod, last_submitted_at, removed_at FROM indexnow_submissions WHERE host = ?").all(h.host) as Row[]) {
    existing.set(r.url, r);
  }

  // 3. baseline: store everything, send 0
  if (!state?.baseline_at) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO indexnow_submissions (host, url, lastmod, first_seen_at, last_submitted_at, last_status, removed_at)
       VALUES (?, ?, ?, ?, NULL, 'baseline', NULL)`);
    db.transaction(() => {
      for (const e of entries) ins.run(h.host, e.loc, e.lastmod, nowIso);
      db.prepare(
        `INSERT INTO indexnow_host_state (host, baseline_at, backoff_until, last_error) VALUES (?, ?, NULL, NULL)
         ON CONFLICT(host) DO UPDATE SET baseline_at = excluded.baseline_at`).run(h.host, nowIso);
    })();
    console.log(`[indexnow-sync] host=${h.host} baseline=${entries.length}`);
    return { ...res, baseline: entries.length };
  }

  // 4. diff
  const isEntity = (u: string) => {
    const p = pathOf(u, h.baseUrl);
    return h.entityPathPrefixes.some((pre) => p.startsWith(pre));
  };
  const news: Plan[] = [], changed: Plan[] = [], removed: Plan[] = [];
  const inSitemap = new Set<string>();
  for (const e of entries) {
    inSitemap.add(e.loc);
    const row = existing.get(e.loc);
    if (!row || row.removed_at) { news.push({ url: e.loc, kind: "new", lastmod: e.lastmod }); continue; }
    if (!isEntity(e.loc)) continue; // hubs (incl. lastmod=today) never go on lastmod alone
    if (!lastmodAdvanced(row.lastmod, e.lastmod)) continue;
    const prev = row.last_submitted_at ? Date.parse(row.last_submitted_at) : NaN;
    if (!Number.isNaN(prev) && now.getTime() - prev < REPEAT_AFTER_MS) continue;
    changed.push({ url: e.loc, kind: "changed", lastmod: e.lastmod });
  }
  for (const [url, row] of existing) {
    if (!row.removed_at && !inSitemap.has(url)) removed.push({ url, kind: "removed", lastmod: row.lastmod });
  }
  const wanted = [...news, ...removed, ...changed];

  // 5. daily cap per host (UTC day)
  const used = (db.prepare(
    "SELECT COUNT(*) AS n FROM indexnow_submissions WHERE host = ? AND last_submitted_at >= ? AND last_status = 'ok'",
  ).get(h.host, startOfUtcDay(now).toISOString()) as { n: number }).n;
  const room = Math.max(0, cap - used);
  const plan = wanted.slice(0, room);
  res.pending = wanted.length - plan.length;
  if (plan.length === 0) {
    if (wanted.length > 0) console.log(`[indexnow-sync] host=${h.host} submitted=0 pending=${wanted.length} cap=${cap}`);
    return res;
  }

  // 6. submit in chunks; stop the host on the first non-ok chunk
  const upsert = db.prepare(
    `INSERT INTO indexnow_submissions (host, url, lastmod, first_seen_at, last_submitted_at, last_status, removed_at)
     VALUES (?, ?, ?, ?, ?, 'ok', ?)
     ON CONFLICT(host, url) DO UPDATE SET lastmod = excluded.lastmod, last_submitted_at = excluded.last_submitted_at,
       last_status = 'ok', removed_at = excluded.removed_at`);
  const setState = db.prepare(
    `INSERT INTO indexnow_host_state (host, baseline_at, backoff_until, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET backoff_until = excluded.backoff_until, last_error = excluded.last_error`);
  const svc = require("./indexnow-service") as typeof import("./indexnow-service");
  for (let i = 0; i < plan.length; i += CHUNK) {
    const slice = plan.slice(i, i + CHUNK);
    const r = await svc.submitIndexNow(h.host, slice.map((p) => p.url), { fetchImpl: o.fetchImpl, chunkSize: CHUNK, baseUrl: h.baseUrl });
    const c = r.chunks[0];
    if (c && c.result === "ok") {
      db.transaction(() => {
        for (const p of slice) {
          upsert.run(h.host, p.url, p.lastmod, nowIso, nowIso, p.kind === "removed" ? nowIso : null);
        }
      })();
      res.submitted += slice.length;
      res.status = c.status;
      continue;
    }
    const status = c ? c.status : 0;
    const result = c ? c.result : "network_error";
    res.status = status;
    if (result === "rate_limited") {
      setState.run(h.host, state.baseline_at, new Date(now.getTime() + backoffH * 3600_000).toISOString(), "429");
      console.warn(`[indexnow-sync] host=${h.host} status=429 backoff_hours=${backoffH}`);
    } else if (result === "key_invalid" || result === "host_mismatch") {
      setState.run(h.host, state.baseline_at, nextUtcMidnight(now).toISOString(), String(status));
      console.error(`[indexnow-sync] ALERT host=${h.host} status=${status}`);
    } else {
      setState.run(h.host, state.baseline_at, state.backoff_until ?? null, `${result}:${status}`);
      console.warn(`[indexnow-sync] host=${h.host} status=${status} result=${result}`);
    }
    break;
  }
  res.pending = wanted.length - res.submitted;
  console.log(`[indexnow-sync] host=${h.host} submitted=${res.submitted}${res.status ? ` status=${res.status}` : ""} pending=${res.pending}`);
  return res;
}

/** One pass over all enabled hosts. Never throws; a failing host does not stop the others. */
export async function runIndexNowSync(opts: IndexNowSyncOptions = {}): Promise<HostSyncResult[]> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const capRaw = opts.dailyCap ?? Number(process.env.INDEXNOW_DAILY_CAP ?? "");
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 2000;
  const windowRaw = opts.buildWindowUtc ?? process.env.INDEXNOW_BUILD_WINDOW_UTC ?? "01-05";
  const backoffH = opts.backoffHours ?? 6;
  const out: HostSyncResult[] = [];
  for (const h of opts.hosts ?? INDEXNOW_HOSTS) {
    try {
      out.push(await syncHost(h, { ...opts, db, now }, cap, windowRaw, backoffH));
    } catch (err) {
      console.error(`[indexnow-sync] host=${h.host} failed:`, err instanceof Error ? err.message : err);
      out.push({ host: h.host, submitted: 0, skipped: "error" });
    }
  }
  return out;
}

/** The scheduled tick: send-window blackout + recent-run skip + completion stamp. */
export async function indexNowSyncTick(opts: IndexNowSyncOptions = {}): Promise<HostSyncResult[] | null> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  if (inSendBlackout(now)) return null;
  if (shouldSkipRecentRun({ lastCompletedAt: getJobLastCompletedAt(db, INDEXNOW_SYNC_JOB), now, minIntervalHours: MIN_INTERVAL_HOURS })) return null;
  const r = await runIndexNowSync({ ...opts, db, now });
  markJobCompleted(db, INDEXNOW_SYNC_JOB, now);
  return r;
}
