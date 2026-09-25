// ─── Event-loop stall monitor ───────────────────────────────────────
// dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).
//
// THE PROBLEM
// ───────────
// Since 2026-09-17 Glama's hourly MCP health check has marked finn-tannlege
// "unhealthy" dozens of times WITHOUT a deploy or restart in the window. Live
// probes caught the cause from outside: every route on all three hosts (HTML,
// /health, /.well-known/*, /mcp) stops answering for 10–30 s at a time, then
// recovers on its own — TCP connect stays <1 ms, the whole delay is time-to-
// first-byte. One Node process serves everything and better-sqlite3 is
// synchronous, so a single long synchronous piece of work (a query, a sweep,
// a batch) blocks every request at once. What we could NOT see from outside
// is WHICH work that is: the app records nothing about its own event loop.
//
// WHAT THIS ADDS (observability only — no request is changed or refused)
// ──────────────────────────────────────────────────────────────────────
// 1. A heartbeat timer (every `heartbeatMs`). When it fires late by more than
//    `stallMs`, the loop was blocked; we record the stall together with a
//    snapshot of the requests in flight and the background jobs running at
//    that moment — the blocker is almost always among them.
// 2. `requestTrackerMiddleware` — keeps the in-flight request set and logs any
//    request slower than `slowRequestMs`.
// 3. `trackJob(name, fn)` — wraps scheduler callbacks so a stall can name the
//    background job that was running, and logs jobs slower than `slowJobMs`.
// 4. `monitorEventLoopDelay` percentiles, exposed compactly in /health and in
//    full (with the stall/slow ring buffers) at GET /admin/analytics/ops/event-loop.
//
// Every stall / slow request / slow job is also written as ONE log line
// ([event-loop-stall] / [slow-request] / [slow-job]) so it lands in `fly logs`.
//
// Kill switch: EVENT_LOOP_MONITOR_DISABLED=1 stops the heartbeat + histogram.
// Request/job tracking is two Map operations per request/job and stays on.

import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";

export interface EventLoopMonitorConfig {
  /** How often the heartbeat timer is scheduled. */
  heartbeatMs: number;
  /** A heartbeat this many ms late counts as a stall. */
  stallMs: number;
  /** Requests at least this slow are recorded + logged. */
  slowRequestMs: number;
  /** Tracked jobs at least this slow are recorded + logged. */
  slowJobMs: number;
  /** Max entries kept in each ring buffer. */
  ringSize: number;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = parseInt(process.env[name] || "", 10);
  return Number.isFinite(raw) && raw >= min ? raw : fallback;
}

export function defaultEventLoopMonitorConfig(): EventLoopMonitorConfig {
  return {
    heartbeatMs: envInt("EVENT_LOOP_HEARTBEAT_MS", 500, 10),
    stallMs: envInt("EVENT_LOOP_STALL_MS", 1000, 50),
    slowRequestMs: envInt("SLOW_REQUEST_MS", 2000, 1),
    slowJobMs: envInt("SLOW_JOB_MS", 2000, 1),
    ringSize: envInt("EVENT_LOOP_RING_SIZE", 200, 1),
  };
}

/** Longest paths/lists kept per record — bounds memory and log-line length. */
const MAX_PATH_CHARS = 200;
const MAX_SNAPSHOT_ENTRIES = 20;

interface InflightRequest {
  method: string;
  host: string;
  path: string;
  startedAt: number;
}

interface ActiveJob {
  name: string;
  startedAt: number;
}

export interface StallRecord {
  detectedAt: string;
  lagMs: number;
  /**
   * Requests that were already in flight when the loop blocked (age ≥ lag),
   * MOST RECENT FIRST: the blocker started shortly before the stall, while
   * long-lived streams (MCP SSE GETs open for hours) sort last instead of
   * crowding it out of the MAX_SNAPSHOT_ENTRIES cap.
   */
  inflight: Array<{ method: string; host: string; path: string; ageMs: number }>;
  /** Total in flight at detection, including ones cut by the cap or that arrived after the block. */
  inflightTotal: number;
  activeJobs: Array<{ name: string; ageMs: number }>;
}

export interface SlowRequestRecord {
  at: string;
  method: string;
  host: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface SlowJobRecord {
  at: string;
  name: string;
  durationMs: number;
  ok: boolean;
}

export interface EventLoopSummary {
  monitoring: boolean;
  /** monitorEventLoopDelay percentiles since the monitor started (ms). */
  delayP50Ms: number | null;
  delayP99Ms: number | null;
  delayMaxMs: number | null;
  stallsLast60m: number;
  maxStallLast60mMs: number;
  lastStallAt: string | null;
  lastStallLagMs: number | null;
  inflightNow: number;
  activeJobsNow: number;
}

interface MonitorDeps {
  now: () => number;
  log: (line: string) => void;
}

let cfg: EventLoopMonitorConfig = defaultEventLoopMonitorConfig();
let deps: MonitorDeps = { now: () => Date.now(), log: (l) => console.warn(l) };

let seq = 0;
const inflight = new Map<number, InflightRequest>();
const activeJobs = new Map<number, ActiveJob>();
const stalls: StallRecord[] = [];
const slowRequests: SlowRequestRecord[] = [];
const slowJobs: SlowJobRecord[] = [];

let histogram: IntervalHistogram | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastBeatAt = 0;

function pushCapped<T>(buf: T[], item: T): void {
  buf.push(item);
  if (buf.length > cfg.ringSize) buf.splice(0, buf.length - cfg.ringSize);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Everything in flight now, oldest first (spots hung requests) — admin report. */
function snapshotInflight(at: number): StallRecord["inflight"] {
  return [...inflight.values()]
    .map((r) => ({ method: r.method, host: r.host, path: r.path, ageMs: at - r.startedAt }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, MAX_SNAPSHOT_ENTRIES);
}

/**
 * Stall snapshot: only requests that started before the block (age ≥ lag —
 * nothing can register while the loop is blocked, so younger entries arrived
 * after it), most recent first, so the likely blocker leads the list.
 */
function snapshotInflightForStall(at: number, lagMs: number): StallRecord["inflight"] {
  return [...inflight.values()]
    .map((r) => ({ method: r.method, host: r.host, path: r.path, ageMs: at - r.startedAt }))
    .filter((r) => r.ageMs >= lagMs)
    .sort((a, b) => a.ageMs - b.ageMs)
    .slice(0, MAX_SNAPSHOT_ENTRIES);
}

function snapshotJobs(at: number): StallRecord["activeJobs"] {
  return [...activeJobs.values()]
    .map((j) => ({ name: j.name, ageMs: at - j.startedAt }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, MAX_SNAPSHOT_ENTRIES);
}

function beat(): void {
  const at = deps.now();
  const lagMs = at - lastBeatAt - cfg.heartbeatMs;
  lastBeatAt = at;
  if (lagMs < cfg.stallMs) return;

  const record: StallRecord = {
    detectedAt: iso(at),
    lagMs,
    inflight: snapshotInflightForStall(at, lagMs),
    inflightTotal: inflight.size,
    activeJobs: snapshotJobs(at),
  };
  pushCapped(stalls, record);
  const reqs = record.inflight.map((r) => `${r.method} ${r.host}${r.path} (${r.ageMs}ms)`).join(", ") || "none";
  const jobs = record.activeJobs.map((j) => `${j.name} (${j.ageMs}ms)`).join(", ") || "none";
  deps.log(`[event-loop-stall] lag=${lagMs}ms inflight=[${reqs}] jobs=[${jobs}]`);
}

/**
 * Start the heartbeat + delay histogram. Idempotent. Returns false when the
 * kill switch is set (EVENT_LOOP_MONITOR_DISABLED=1) and nothing was started.
 */
export function startEventLoopMonitor(
  overrides: Partial<EventLoopMonitorConfig> = {},
  depOverrides: Partial<MonitorDeps> = {}
): boolean {
  if (process.env.EVENT_LOOP_MONITOR_DISABLED === "1") return false;
  if (heartbeat) return true;
  cfg = { ...defaultEventLoopMonitorConfig(), ...overrides };
  deps = { ...deps, ...depOverrides };
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  lastBeatAt = deps.now();
  heartbeat = setInterval(beat, cfg.heartbeatMs);
  // Never keep the process (or a test run) alive just for this timer.
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();
  return true;
}

export function stopEventLoopMonitor(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (histogram) histogram.disable();
  histogram = null;
}

/**
 * Express middleware: registers the request as in flight until the response
 * finishes (or the socket closes), and records it if it was slow. Path only —
 * the query string is dropped so nothing user-supplied beyond the route lands
 * in logs or in the admin report.
 */
export function requestTrackerMiddleware(req: any, res: any, next: () => void): void {
  const id = ++seq;
  const rawUrl = String(req.originalUrl || req.url || "");
  const entry: InflightRequest = {
    method: String(req.method || "?"),
    host: String(req.hostname || (req.headers && req.headers.host) || ""),
    path: rawUrl.split("?")[0].slice(0, MAX_PATH_CHARS),
    startedAt: deps.now(),
  };
  inflight.set(id, entry);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inflight.delete(id);
    const durationMs = deps.now() - entry.startedAt;
    if (durationMs < cfg.slowRequestMs) return;
    const status = Number(res.statusCode) || 0;
    pushCapped(slowRequests, {
      at: iso(entry.startedAt),
      method: entry.method,
      host: entry.host,
      path: entry.path,
      status,
      durationMs,
    });
    deps.log(`[slow-request] ${entry.method} ${entry.host}${entry.path} ${status} ${durationMs}ms`);
  };
  if (typeof res.once === "function") {
    res.once("finish", finish);
    res.once("close", finish);
  }
  next();
}

/**
 * Wrap a (sync or async) job so it is visible in stall snapshots while it
 * runs and recorded when it is slow. The wrapper returns exactly what `fn`
 * returns and rethrows exactly what it throws — behaviour is unchanged.
 */
export function trackJob<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const id = ++seq;
    const startedAt = deps.now();
    activeJobs.set(id, { name, startedAt });
    const settle = (ok: boolean) => {
      activeJobs.delete(id);
      const durationMs = deps.now() - startedAt;
      if (durationMs < cfg.slowJobMs) return;
      pushCapped(slowJobs, { at: iso(startedAt), name, durationMs, ok });
      deps.log(`[slow-job] ${name} ${durationMs}ms ok=${ok}`);
    };

    let result: R;
    try {
      result = fn(...args);
    } catch (err) {
      settle(false);
      throw err;
    }
    if (result && typeof (result as any).then === "function") {
      // Observe settlement on a side branch; the caller still gets (and must
      // still handle) the original promise, so rejections are not swallowed.
      (result as any).then(
        () => settle(true),
        () => settle(false)
      );
    } else {
      settle(true);
    }
    return result;
  };
}

function nsToMs(ns: number): number | null {
  return Number.isFinite(ns) && ns > 0 ? round1(ns / 1e6) : null;
}

export function getEventLoopSummary(): EventLoopSummary {
  const at = deps.now();
  const since = at - 60 * 60_000;
  const recent = stalls.filter((s) => Date.parse(s.detectedAt) >= since);
  const last = stalls.length ? stalls[stalls.length - 1] : null;
  return {
    monitoring: heartbeat !== null,
    delayP50Ms: histogram ? nsToMs(histogram.percentile(50)) : null,
    delayP99Ms: histogram ? nsToMs(histogram.percentile(99)) : null,
    delayMaxMs: histogram ? nsToMs(histogram.max) : null,
    stallsLast60m: recent.length,
    maxStallLast60mMs: recent.reduce((m, s) => Math.max(m, s.lagMs), 0),
    lastStallAt: last ? last.detectedAt : null,
    lastStallLagMs: last ? last.lagMs : null,
    inflightNow: inflight.size,
    activeJobsNow: activeJobs.size,
  };
}

/** Full detail for the admin endpoint (never for public /health). */
export function getEventLoopReport() {
  const at = deps.now();
  return {
    summary: getEventLoopSummary(),
    config: { ...cfg },
    stalls: [...stalls].reverse(),
    slowRequests: [...slowRequests].reverse(),
    slowJobs: [...slowJobs].reverse(),
    inflightNow: snapshotInflight(at),
    activeJobsNow: snapshotJobs(at),
  };
}

export function __resetEventLoopMonitorForTesting(): void {
  stopEventLoopMonitor();
  cfg = defaultEventLoopMonitorConfig();
  deps = { now: () => Date.now(), log: (l) => console.warn(l) };
  inflight.clear();
  activeJobs.clear();
  stalls.length = 0;
  slowRequests.length = 0;
  slowJobs.length = 0;
  lastBeatAt = 0;
}

/** Test hook: override thresholds/deps WITHOUT starting the heartbeat. */
export function __configureEventLoopMonitorForTesting(
  overrides: Partial<EventLoopMonitorConfig> = {},
  depOverrides: Partial<MonitorDeps> = {}
): void {
  cfg = { ...cfg, ...overrides };
  deps = { ...deps, ...depOverrides };
  lastBeatAt = deps.now();
}

/** Test hook: run one heartbeat now (deterministic stall detection with an injected clock). */
export function __heartbeatForTesting(): void {
  beat();
}
