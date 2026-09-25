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
//    `stallMs`, the loop was blocked; we record the stall together with (a)
//    the requests/jobs still in flight and (b) the requests/jobs that FINISHED
//    inside the late window. A handler or job that blocks synchronously and
//    completes in the same tick is gone from (a) by the time the late
//    heartbeat runs — it shows up in (b). The blocker is in (a) ∪ (b); so are
//    its victims (everything that was waiting), so read durations/start times,
//    not list position alone.
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

/** Longest paths/hosts/lists kept per record — bounds memory and log-line length. */
const MAX_PATH_CHARS = 200;
const MAX_HOST_CHARS = 100;
const MAX_SNAPSHOT_ENTRIES = 20;

/**
 * Copy a (possibly sliced) string so a stored record never keeps the whole
 * request URL alive in V8's heap via a sliced-string parent reference.
 */
function detach(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

/**
 * Mask path segments that look like bearer tokens (≥ 20 chars of
 * [A-Za-z0-9_-] mixing letters and digits) — e.g. /produsent/ordre/:token,
 * /api/marketplace/auth/m/:token — so they never reach logs or the report.
 * Diagnosis only needs the route shape.
 */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) ? ":tok" : seg))
    .join("/");
}

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
  /**
   * Requests/jobs at least `stallMs` long that finished after the heartbeat
   * was due (i.e. inside the blocked window), longest first. A synchronous
   * blocker lands HERE, not in `inflight`/`activeJobs`: it completes (and its
   * response's 'finish' fires via nextTick) before the late heartbeat runs.
   */
  finishedDuringBlock: Array<{ kind: "request" | "job"; label: string; startedAt: string; durationMs: number }>;
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
 * Stall snapshot of requests STILL in flight: only those that started before
 * the block (age ≥ lag — nothing can register while the loop is blocked, so
 * younger entries arrived after it), most recent first, so long-lived streams
 * (hour-old SSE) sort last instead of filling the cap. A request that blocked
 * synchronously has usually finished already — see `finishedDuringBlock`.
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

/**
 * Requests/jobs at least `stallMs` long, kept briefly so the NEXT heartbeat can
 * attribute a stall to work that already completed. Bounded twice: by count
 * (RECENT_FINISH_CAP) and by being pruned to the current window on every beat.
 */
interface RecentFinish {
  kind: "request" | "job";
  label: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}
const RECENT_FINISH_CAP = 100;
const recentFinishes: RecentFinish[] = [];

function noteFinish(f: RecentFinish): void {
  if (f.durationMs < cfg.stallMs) return;
  recentFinishes.push(f);
  if (recentFinishes.length > RECENT_FINISH_CAP) recentFinishes.splice(0, recentFinishes.length - RECENT_FINISH_CAP);
}

function beat(): void {
  const at = deps.now();
  const dueAt = lastBeatAt + cfg.heartbeatMs;
  const lagMs = at - dueAt;
  lastBeatAt = at;
  // Anything that finished before this heartbeat was due can no longer
  // explain a later stall — drop it (keeps the buffer tiny in steady state).
  const inWindow = recentFinishes.filter((f) => f.finishedAt >= dueAt);
  recentFinishes.length = 0;
  if (lagMs < cfg.stallMs) return;

  const record: StallRecord = {
    detectedAt: iso(at),
    lagMs,
    inflight: snapshotInflightForStall(at, lagMs),
    inflightTotal: inflight.size,
    activeJobs: snapshotJobs(at),
    finishedDuringBlock: inWindow
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, MAX_SNAPSHOT_ENTRIES)
      .map((f) => ({ kind: f.kind, label: f.label, startedAt: iso(f.startedAt), durationMs: f.durationMs })),
  };
  pushCapped(stalls, record);
  const reqs = record.inflight.map((r) => `${r.method} ${r.host}${r.path} (${r.ageMs}ms)`).join(", ") || "none";
  const jobs = record.activeJobs.map((j) => `${j.name} (${j.ageMs}ms)`).join(", ") || "none";
  const fin = record.finishedDuringBlock.map((f) => `${f.kind === "job" ? "job " : ""}${f.label} (${f.durationMs}ms)`).join(", ") || "none";
  deps.log(`[event-loop-stall] lag=${lagMs}ms finished_during_block=[${fin}] inflight=[${reqs}] jobs=[${jobs}]`);
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
    method: detach(String(req.method || "?").slice(0, 16)),
    host: detach(String(req.hostname || (req.headers && req.headers.host) || "").slice(0, MAX_HOST_CHARS)),
    path: detach(redactPath(rawUrl.split("?")[0].slice(0, MAX_PATH_CHARS))),
    startedAt: deps.now(),
  };
  inflight.set(id, entry);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inflight.delete(id);
    const finishedAt = deps.now();
    const durationMs = finishedAt - entry.startedAt;
    noteFinish({ kind: "request", label: `${entry.method} ${entry.host}${entry.path}`, startedAt: entry.startedAt, finishedAt, durationMs });
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
 * runs and recorded when it is slow. Sync: returns what `fn` returns and
 * rethrows what it throws. Async: returns a promise that resolves/rejects
 * exactly like `fn`'s — a rejection nobody handles is still an unhandled
 * rejection (the wrapper never marks it handled), so behaviour is unchanged.
 */
export function trackJob<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const id = ++seq;
    const startedAt = deps.now();
    activeJobs.set(id, { name, startedAt });
    const settle = (ok: boolean) => {
      activeJobs.delete(id);
      const finishedAt = deps.now();
      const durationMs = finishedAt - startedAt;
      noteFinish({ kind: "job", label: name, startedAt, finishedAt, durationMs });
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
      // Return the DERIVED promise (not a side branch): it carries the same
      // value/rejection, and a rejection the caller ignores stays unhandled,
      // exactly as it would have been without the wrapper.
      return (result as any).then(
        (v: unknown) => {
          settle(true);
          return v;
        },
        (e: unknown) => {
          settle(false);
          throw e;
        }
      ) as R;
    }
    settle(true);
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
  recentFinishes.length = 0;
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
