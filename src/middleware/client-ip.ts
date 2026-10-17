/**
 * client-ip.ts — dev-request 2026-10-16-klient-ip-fra-fly-client-ip, trinn 1
 * (full design: A2A research-feed/2026-10-16-klient-ip-fly-research.md §4).
 *
 * ONE choke point for the client IP. Every IP-keyed limiter (security.ts,
 * mcp-rate-limit.ts, resend-webhook.ts), every IP hash (hashIP and friends)
 * and the contact form read `req.ip`; nothing else in src/ reads
 * X-Forwarded-For or Fly-Client-IP (client-ip.test.ts pins that).
 *
 * The problem: `trust proxy` is `true` — trust EVERY hop — so `req.ip` is
 * the LEFT-most X-Forwarded-For entry. Fly's proxy appends to a client-sent
 * X-Forwarded-For instead of overwriting it (observed on debug.fly.dev:
 * `<client's own value>, <client IP>, <app IP>`), so a client picks its own
 * `req.ip`, and with it a fresh bucket on every IP-keyed limiter, just by
 * rotating that header. Fly-Client-IP, by contrast, is overwritten by Fly's
 * proxy, and Fly recommends it when nothing else sits in front of Fly.
 *
 * The fix: this middleware, mounted before anything reads the IP
 * (installClientIp in src/index.ts), rewrites X-Forwarded-For to the single
 * Fly-Client-IP value in mode `enforce`. `trust proxy` stays `true`, so
 * `req.ip`, `req.ips` and every reader inherit that value with no change at
 * their call sites.
 *
 * Modes (resolveClientIpConfig):
 *   legacy   no-op: today's behaviour. Forced off Fly (no FLY_APP_NAME: local
 *            dev, CI, `npm test`) and on an invalid CLIENT_IP_MODE; also the
 *            manual rollback (`fly secrets set CLIENT_IP_MODE=legacy`).
 *   shadow   headers untouched (today's behaviour); measures what enforce
 *            would do and logs one `client_ip_stats` JSON line per process
 *            per 5-min window (written lazily, see windowAt).
 *            CLIENT_IP_MODE_DEFAULT in trinn 1.
 *   enforce  rewrites X-Forwarded-For as above. Trinn 2 flips the default,
 *            only once the shadow gate (AC2 in the dev-request) is met.
 *
 * The failure mode guarded hardest is "every client in one bucket" (a 429
 * wave on all three sites):
 *   G1  no branch sets X-Forwarded-For to a constant or deletes it. Every
 *       fallback (Fly-Client-IP missing, invalid or non-public) leaves the
 *       header untouched, i.e. today's per-client keys — never the socket
 *       address of Fly's proxy, which every client shares.
 *   G2  a private, CGNAT, loopback, link-local, ULA/6PN, multicast,
 *       unspecified or IPv4-embedding Fly-Client-IP falls back.
 *   G4  a per-process collapse breaker (CollapseBreaker below), computed only
 *       from Fly-controlled signals, puts the process back in legacy for
 *       15 min when Fly-Client-IP collapses to ≤2 values while Fly's own
 *       X-Forwarded-For entries still show ≥10 distinct clients.
 *
 * Privacy (dev-request rule 5) and memory: no raw IP is ever logged or kept
 * past the request. The stats and the breaker hold only fixed-size salted
 * hashes of ipKeyGenerator-normalized keys (createStatsKey), every set is
 * capped, and the salt is random per process and never logged, so the few
 * keys that are logged (top list) cannot be reversed or linked to analytics
 * ip_hash values or across restarts.
 *
 * A CDN or any other proxy in front of Fly breaks this design's premise:
 * Fly-Client-IP would then be the CDN's addresses (partial collapse). Revise
 * this file BEFORE any such DNS switch.
 */

import net from "net";
import crypto from "crypto";
import type { Application, NextFunction, Request, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { aiAssistantVendor, classifyUA } from "../services/traffic-classifier";

// ─── Config ─────────────────────────────────────────────────────────────

export type ClientIpMode = "legacy" | "shadow" | "enforce";

/** Trinn 1: shadow (measure only). Trinn 2 changes this one line to "enforce". */
export const CLIENT_IP_MODE_DEFAULT: ClientIpMode = "shadow";

const MODES: readonly string[] = ["legacy", "shadow", "enforce"];

export interface ClientIpConfig {
  mode: ClientIpMode;
  onFly: boolean;
  reason: "not_on_fly" | "default" | "env" | "invalid_env";
}

/**
 * Off Fly (no non-empty FLY_APP_NAME) → always legacy, whatever
 * CLIENT_IP_MODE says, so local dev, CI and `npm test` behave byte-identical
 * to before. On Fly: CLIENT_IP_MODE (case/whitespace-insensitive) overrides
 * CLIENT_IP_MODE_DEFAULT; an unknown value is a typo, and a typo must fail
 * safe (legacy), never into enforce.
 */
export function resolveClientIpConfig(
  env: Record<string, string | undefined>,
  logError: (line: string) => void = console.error
): ClientIpConfig {
  const onFly = typeof env.FLY_APP_NAME === "string" && env.FLY_APP_NAME.trim() !== "";
  if (!onFly) return { mode: "legacy", onFly: false, reason: "not_on_fly" };
  const raw = (env.CLIENT_IP_MODE ?? "").trim().toLowerCase();
  if (raw === "") return { mode: CLIENT_IP_MODE_DEFAULT, onFly, reason: "default" };
  if (MODES.includes(raw)) return { mode: raw as ClientIpMode, onFly, reason: "env" };
  logError(JSON.stringify({ evt: "client_ip_invalid_mode", value: raw.slice(0, 32), using: "legacy" }));
  return { mode: "legacy", onFly, reason: "invalid_env" };
}

// ─── Fly-Client-IP derivation ───────────────────────────────────────────

export type FlyClientIpFallback = "missing" | "invalid" | "non_public";
export type FlyClientIp = { ok: true; ip: string } | { ok: false; fallback: FlyClientIpFallback };

// Longest textual IP: an IPv6 address with an embedded IPv4 tail (45 chars).
const MAX_IP_TEXT_LEN = 45;
const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

function blockList(family: "ipv4" | "ipv6", subnets: ReadonlyArray<[string, number]>): net.BlockList {
  const list = new net.BlockList();
  for (const [address, prefix] of subnets) list.addSubnet(address, prefix, family);
  return list;
}

// One list per family, each only ever checked against its own family:
// net.BlockList also matches an IPv4 address against IPv4-mapped IPv6 rules,
// so a mixed list holding ::/8 would block every IPv4 address.
const NON_PUBLIC_V4 = blockList("ipv4", [
  ["0.0.0.0", 8], // "this network", incl. unspecified
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // where Fly's proxy socket address has been seen
  ["192.168.0.0", 16],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
]);
const NON_PUBLIC_V6 = blockList("ipv6", [
  // IETF-reserved 0000::/8: unspecified (::), loopback (::1) and every
  // IPv4-embedding form left after the dotted ::ffff: normalization below —
  // IPv4-mapped/-compatible (::ffff:0:0/96, ::/96) and NAT64 (64:ff9b::/96).
  // None is a real client source address, and ipKeyGenerator's /56 grouping
  // puts every IPv4 client written in hex in one of these forms into ONE
  // bucket (::ffff:7b7b:7b7b → "::/56", 64:ff9b::cb00:7109 → "64:ff9b::/56").
  ["::", 8],
  ["fc00::", 7], // ULA, incl. Fly's 6PN/Flycast fdaa::/16
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
]);

const INVALID: FlyClientIp = { ok: false, fallback: "invalid" };

/**
 * The client IP Fly's edge accepted the connection from, or why there is
 * none to use. Anything but `{ ok: true }` means: leave the request exactly
 * as it is today (G1).
 */
export function deriveFlyClientIp(headers: Readonly<Record<string, unknown>> | null | undefined): FlyClientIp {
  const value = headers ? headers["fly-client-ip"] : undefined;
  if (value === undefined) return { ok: false, fallback: "missing" };
  if (typeof value !== "string") return INVALID;
  let ip = value.trim();
  // "," = a list, never one client (net.isIP rejects one too; this is a
  // second guard); "%" = an IPv6 zone index, which has no meaning beyond the
  // local link and would make every key unique.
  if (ip === "" || ip.length > MAX_IP_TEXT_LEN || ip.includes(",") || ip.includes("%")) return INVALID;
  const mapped = IPV4_MAPPED_DOTTED.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (family === 0) return INVALID;
  const nonPublic = family === 4 ? NON_PUBLIC_V4.check(ip, "ipv4") : NON_PUBLIC_V6.check(ip, "ipv6");
  if (nonPublic) return { ok: false, fallback: "non_public" };
  return { ok: true, ip };
}

// ─── Stats keys ─────────────────────────────────────────────────────────

/**
 * The only form in which an address outlives the request (stats sets, top
 * list, breaker ring): the first 12 bytes of sha256(salt +
 * ipKeyGenerator(ip)) as base64url, i.e. 16 freshly allocated chars whatever
 * the input. Same limiter bucket → same key, so every distinct count is
 * still a count of buckets.
 *
 * Never ipKeyGenerator's own output: for IPv4 and non-IP values that is its
 * argument, a string the client controls (the left-most X-Forwarded-For
 * entry, up to ~16 KB of garbage) or a V8 slice that keeps the whole
 * X-Forwarded-For header alive. Count-capped sets of those held 40–60 MB in
 * one process per 5-min window from a single client (review of PR #1102);
 * with these keys the same traffic holds under 1 MB.
 *
 * Exported for client-ip.test.ts.
 */
export function createStatsKey(salt: Buffer): (ip: string) => string {
  return (ip) =>
    crypto.createHash("sha256").update(salt).update(ipKeyGenerator(ip), "utf8").digest().toString("base64url", 0, 12);
}

/** The logged form of a stats key: its first 6 bytes as 12 hex chars (= sha256(salt + ipKeyGenerator key), first 12 hex). */
function logKey(key: string): string {
  return Buffer.from(key, "base64url").toString("hex", 0, 6);
}

// ─── Collapse breaker (G4) ──────────────────────────────────────────────
// Counts only requests whose Fly-Client-IP was used. N = requests, D_fci =
// distinct Fly-Client-IP, D_edge = distinct ORIGINAL X-Forwarded-For[len-2]
// (the client IP Fly itself appended, which the client cannot set), all
// over a ring of 5 × 60 s, keys normalized with ipKeyGenerator (held as
// createStatsKey hashes), sets capped at 64. A flood from one address has
// D_edge = 1, so only a collapse of Fly-Client-IP itself (D_fci small while
// D_edge is large) can trip it.
// N ≥ 60 trips long before a collapsed bucket of the smallest common limit
// (jsonRpcLimiter, 200 per 15 min) is empty.

const BREAKER_MIN_REQUESTS = 60;
const BREAKER_MAX_DISTINCT_FCI = 2;
const BREAKER_MIN_DISTINCT_EDGE = 10;
export const BREAKER_OPEN_MS = 15 * 60_000;
const BREAKER_BUCKET_MS = 60_000;
const BREAKER_BUCKETS = 5;
const BREAKER_EVAL_EVERY_MS = 10_000;
const BREAKER_SET_CAP = 64;

interface BreakerBucket {
  minute: number;
  n: number;
  fci: Set<string>;
  edge: Set<string>;
}

interface BreakerTrip {
  N: number;
  D_fci: number;
  D_edge: number;
}

function addCapped(set: Set<string>, key: string, cap: number): boolean {
  if (set.size < cap) set.add(key);
  return set.size >= cap && !set.has(key);
}

class CollapseBreaker {
  private readonly ring: Array<BreakerBucket | null> = new Array(BREAKER_BUCKETS).fill(null);
  private lastEvalAt = -Infinity;
  private openUntil = -Infinity;
  tripsTotal = 0;

  record(t: number, fciKey: string, edgeKey: string | undefined): void {
    const minute = Math.floor(t / BREAKER_BUCKET_MS);
    const slot = ((minute % BREAKER_BUCKETS) + BREAKER_BUCKETS) % BREAKER_BUCKETS;
    let bucket = this.ring[slot];
    if (!bucket || bucket.minute !== minute) {
      bucket = { minute, n: 0, fci: new Set(), edge: new Set() };
      this.ring[slot] = bucket;
    }
    bucket.n++;
    addCapped(bucket.fci, fciKey, BREAKER_SET_CAP);
    if (edgeKey !== undefined) addCapped(bucket.edge, edgeKey, BREAKER_SET_CAP);
  }

  isOpen(t: number): boolean {
    return t < this.openUntil;
  }

  /** At most every 10 s, and not while open. Returns the trip when this evaluation opened the breaker. */
  evaluate(t: number): BreakerTrip | null {
    if (this.isOpen(t) || t - this.lastEvalAt < BREAKER_EVAL_EVERY_MS) return null;
    this.lastEvalAt = t;
    const minute = Math.floor(t / BREAKER_BUCKET_MS);
    let n = 0;
    const fci = new Set<string>();
    const edge = new Set<string>();
    for (const bucket of this.ring) {
      if (!bucket || bucket.minute > minute || minute - bucket.minute >= BREAKER_BUCKETS) continue;
      n += bucket.n;
      for (const k of bucket.fci) addCapped(fci, k, BREAKER_SET_CAP);
      for (const k of bucket.edge) addCapped(edge, k, BREAKER_SET_CAP);
    }
    if (n >= BREAKER_MIN_REQUESTS && fci.size <= BREAKER_MAX_DISTINCT_FCI && edge.size >= BREAKER_MIN_DISTINCT_EDGE) {
      this.openUntil = t + BREAKER_OPEN_MS;
      this.tripsTotal++;
      return { N: n, D_fci: fci.size, D_edge: edge.size };
    }
    return null;
  }
}

// ─── Stats (shadow gate AC2, post-enforce AC4) ──────────────────────────

const STATS_WINDOW_MS = 5 * 60_000;
const TOP_WINDOWS = 3; // top list spans 3 stats windows = 15 min, the limiters' window
const TOP_N = 5;
const TOP_CAP = 1024;
const FANIN_CAP = 8;
const DISTINCT_CAP = 4096;
// Fly's http_service check (fly.toml) and the Dockerfile HEALTHCHECK (via localhost).
const HEALTH_CHECK_PATHS: ReadonlySet<string> = new Set(["/.well-known/agent-card.json", "/health"]);

type PathClass = "api" | "a2a" | "mcp" | "other";

interface TopEntry {
  n: number;
  paths: Record<PathClass, number>;
  legacy: Set<string>;
  ua: Map<string, number>;
}

interface StatsWindow {
  index: number;
  n: number;
  fciValid: number;
  fallback: Record<FlyClientIpFallback, number>;
  fallbackHc: number;
  errors: number;
  xffClientSupplied: number;
  agreeFciEdge: { n: number; agree: number };
  agreeLegacyEqFci: { n: number; agree: number };
  dFci: Set<string>;
  dEdge: Set<string>;
  dLegacy: Set<string>;
  distinctCapped: boolean;
  wouldTrip: number;
  top: Map<string, TopEntry>;
  topOverflow: number;
}

export interface ClientIpTopKey {
  /** sha256(per-process salt + ipKeyGenerator key), first 12 hex chars. */
  key: string;
  n: number;
  api: number;
  a2a: number;
  mcp: number;
  other: number;
  /** Distinct legacy (left-most X-Forwarded-For) keys behind this one, capped at 8. */
  fanIn: number;
  /** Most frequent traffic-classifier bucket, AI buckets split by vendor. */
  ua: string;
}

export interface ClientIpStatsLine {
  evt: "client_ip_stats";
  mode: ClientIpMode;
  window_start: string;
  window_s: number;
  n: number;
  fci_valid: number;
  fallback: Record<FlyClientIpFallback, number>;
  /**
   * Of fallback.missing: requests to a health-check path (HEALTH_CHECK_PATHS).
   * AC2's "fallback ≤ health-check volume + 1 %" is
   * (missing + invalid + non_public − fallback_hc) ≤ 1 % of n.
   */
  fallback_hc: number;
  errors: number;
  /** X-Forwarded-For had ≥3 entries: the client sent its own before Fly appended two. */
  xff_client_supplied: number;
  /** Fly-Client-IP == X-Forwarded-For[len-2], among valid ones with ≥2 entries. */
  agree_fci_edge: { n: number; agree: number };
  /** Legacy req.ip byte-equal to Fly-Client-IP, among valid ones with exactly 2 entries (= hashIP continuity). */
  agree_legacy_eq_fci: { n: number; agree: number };
  D_fci: number;
  D_edge: number;
  D_legacy: number;
  distinct_capped: boolean;
  /** Breaker trips in this window (in shadow: would have tripped). */
  would_trip: number;
  /** In shadow: the simulated state enforce would be in. */
  breaker_open: boolean;
  breaker_trips_total: number;
  top15m: ClientIpTopKey[];
  top_overflow: number;
}

function newWindow(index: number): StatsWindow {
  return {
    index,
    n: 0,
    fciValid: 0,
    fallback: { missing: 0, invalid: 0, non_public: 0 },
    fallbackHc: 0,
    errors: 0,
    xffClientSupplied: 0,
    agreeFciEdge: { n: 0, agree: 0 },
    agreeLegacyEqFci: { n: 0, agree: 0 },
    dFci: new Set(),
    dEdge: new Set(),
    dLegacy: new Set(),
    distinctCapped: false,
    wouldTrip: 0,
    top: new Map(),
    topOverflow: 0,
  };
}

/** X-Forwarded-For entries, parsed like proxy-addr does (comma-separated, blanks dropped). */
function xffEntries(value: unknown): string[] {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : "";
  if (raw === "") return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function pathClass(path: string): PathClass {
  for (const p of ["api", "a2a", "mcp"] as const) {
    if (path === `/${p}` || path.startsWith(`/${p}/`)) return p;
  }
  return "other";
}

function uaFamily(ua: unknown): string {
  if (typeof ua !== "string" || ua.trim() === "") return "none";
  const category = classifyUA(ua);
  return category === "ai_search" || category === "ai_crawler" ? `${category}:${aiAssistantVendor(ua)}` : category;
}

function stripMapped(ip: string): string {
  const mapped = IPV4_MAPPED_DOTTED.exec(ip);
  return mapped ? mapped[1] : ip;
}

// ─── Middleware ─────────────────────────────────────────────────────────

export interface ClientIpMiddlewareOptions {
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  /** Sink for the stats line and the boot line. Default console.log. */
  log?: (line: string) => void;
  /** Sink for breaker events. Default console.error. */
  logError?: (line: string) => void;
}

export type ClientIpMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  readonly mode: ClientIpMode;
  /**
   * The current, still-open stats window (what the next log line will be
   * built from). For the tests, and for a possible later field in an existing
   * ops response; no production code reads it today.
   */
  snapshot(): ClientIpStatsLine;
};

/**
 * Synchronous, never throws, calls next() exactly once. Any internal error
 * leaves the request as it is today (legacy) and is counted in `errors`.
 */
export function createClientIpMiddleware(cfg: ClientIpConfig, opts: ClientIpMiddlewareOptions = {}): ClientIpMiddleware {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console.log;
  const logError = opts.logError ?? console.error;
  const mode = cfg.mode;
  const statsKey = createStatsKey(crypto.randomBytes(16));
  const breaker = new CollapseBreaker();
  let current: StatsWindow | null = null;
  // Only the top maps of the previous TOP_WINDOWS - 1 windows are kept, for top15m.
  let history: Array<Pick<StatsWindow, "index" | "top">> = [];
  let lastT = 0;

  function topList(w: StatsWindow): ClientIpTopKey[] {
    const merged = new Map<string, TopEntry>();
    for (const win of [...history.filter((h) => w.index - h.index < TOP_WINDOWS && h.index < w.index), w]) {
      for (const [key, e] of win.top) {
        let m = merged.get(key);
        if (!m) {
          m = { n: 0, paths: { api: 0, a2a: 0, mcp: 0, other: 0 }, legacy: new Set(), ua: new Map() };
          merged.set(key, m);
        }
        m.n += e.n;
        for (const p of ["api", "a2a", "mcp", "other"] as const) m.paths[p] += e.paths[p];
        for (const l of e.legacy) addCapped(m.legacy, l, FANIN_CAP);
        for (const [u, c] of e.ua) m.ua.set(u, (m.ua.get(u) ?? 0) + c);
      }
    }
    return [...merged.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, TOP_N)
      .map(([key, e]) => ({
        key: logKey(key),
        n: e.n,
        api: e.paths.api,
        a2a: e.paths.a2a,
        mcp: e.paths.mcp,
        other: e.paths.other,
        fanIn: e.legacy.size,
        ua: [...e.ua.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
      }));
  }

  function line(w: StatsWindow, t: number): ClientIpStatsLine {
    return {
      evt: "client_ip_stats",
      mode,
      window_start: new Date(w.index * STATS_WINDOW_MS).toISOString(),
      window_s: STATS_WINDOW_MS / 1000,
      n: w.n,
      fci_valid: w.fciValid,
      fallback: { ...w.fallback },
      fallback_hc: w.fallbackHc,
      errors: w.errors,
      xff_client_supplied: w.xffClientSupplied,
      agree_fci_edge: { ...w.agreeFciEdge },
      agree_legacy_eq_fci: { ...w.agreeLegacyEqFci },
      D_fci: w.dFci.size,
      D_edge: w.dEdge.size,
      D_legacy: w.dLegacy.size,
      distinct_capped: w.distinctCapped,
      would_trip: w.wouldTrip,
      breaker_open: breaker.isOpen(t),
      breaker_trips_total: breaker.tripsTotal,
      top15m: topList(w),
      top_overflow: w.topOverflow,
    };
  }

  /**
   * The window for time t; rotating out (and logging) the previous one.
   *
   * The stats line is written lazily, by the first request after a window
   * closes, with no timer: nothing to clear on shutdown and nothing that
   * keeps tests alive. So the window still open at SIGTERM/restart is never
   * logged, a window without requests produces no line, and an idle window
   * is logged late. Fly's health check every 30 s (fly.toml) keeps the
   * 5-min cadence in practice.
   */
  function windowAt(t: number): StatsWindow {
    const index = Math.floor(t / STATS_WINDOW_MS);
    if (current && current.index === index) return current;
    if (current) {
      if (current.n > 0 || current.errors > 0) log(JSON.stringify(line(current, t)));
      history = [...history, { index: current.index, top: current.top }].filter(
        (h) => index - h.index < TOP_WINDOWS && h.index < index
      );
    }
    current = newWindow(index);
    return current;
  }

  function distinct(w: StatsWindow, set: Set<string>, key: string): void {
    if (addCapped(set, key, DISTINCT_CAP)) w.distinctCapped = true;
  }

  function observe(req: Request): void {
    const t = now();
    lastT = t;
    const w = windowAt(t);
    w.n++;
    const d = deriveFlyClientIp(req.headers);
    if (!d.ok) {
      w.fallback[d.fallback]++;
      if (d.fallback === "missing" && HEALTH_CHECK_PATHS.has(req.path)) w.fallbackHc++;
    } else {
      w.fciValid++;
      const xff = xffEntries(req.headers["x-forwarded-for"]);
      if (xff.length >= 3) w.xffClientSupplied++;
      const edge = xff.length >= 2 ? xff[xff.length - 2] : undefined;
      // Read before any rewrite below: the value every reader gets today.
      const legacyIp = typeof req.ip === "string" ? req.ip : "";
      if (edge !== undefined) {
        w.agreeFciEdge.n++;
        if (stripMapped(edge) === d.ip) w.agreeFciEdge.agree++;
      }
      if (xff.length === 2) {
        w.agreeLegacyEqFci.n++;
        if (legacyIp === d.ip) w.agreeLegacyEqFci.agree++;
      }
      // Without a client-sent X-Forwarded-For, edge and legacy ARE d.ip: one hash.
      const fciKey = statsKey(d.ip);
      const edgeKey = edge === undefined ? undefined : edge === d.ip ? fciKey : statsKey(edge);
      const legacyKey = legacyIp === d.ip ? fciKey : statsKey(legacyIp);
      distinct(w, w.dFci, fciKey);
      if (edgeKey !== undefined) distinct(w, w.dEdge, edgeKey);
      distinct(w, w.dLegacy, legacyKey);

      let entry = w.top.get(fciKey);
      if (!entry && w.top.size < TOP_CAP) {
        entry = { n: 0, paths: { api: 0, a2a: 0, mcp: 0, other: 0 }, legacy: new Set(), ua: new Map() };
        w.top.set(fciKey, entry);
      }
      if (entry) {
        entry.n++;
        entry.paths[pathClass(typeof req.path === "string" ? req.path : "")]++;
        addCapped(entry.legacy, legacyKey, FANIN_CAP);
        const family = uaFamily(req.headers["user-agent"]);
        entry.ua.set(family, (entry.ua.get(family) ?? 0) + 1);
      } else {
        w.topOverflow++;
      }

      breaker.record(t, fciKey, edgeKey);
    }

    const trip = breaker.evaluate(t);
    if (trip) {
      w.wouldTrip++;
      logError(
        JSON.stringify({
          evt: mode === "enforce" ? "client_ip_breaker_open" : "client_ip_breaker_would_open",
          mode,
          ...trip,
          open_s: BREAKER_OPEN_MS / 1000,
        })
      );
    }

    if (mode === "enforce" && d.ok && !breaker.isOpen(t)) {
      req.headers["x-forwarded-for"] = d.ip;
    }
  }

  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    if (mode !== "legacy") {
      try {
        observe(req);
      } catch {
        try {
          windowAt(lastT).errors++;
        } catch {
          /* counting must never throw either */
        }
      }
    }
    next();
  };

  return Object.assign(middleware, {
    mode,
    snapshot: (): ClientIpStatsLine => line(current ?? newWindow(Math.floor(lastT / STATS_WINDOW_MS)), lastT),
  });
}

/**
 * The one call src/index.ts makes, FIRST, before anything reads req.ip /
 * req.ips / req.hostname. Sets `trust proxy` = true — trust EVERY hop, so
 * req.ip is the left-most X-Forwarded-For entry and req.protocol/req.secure
 * keep following the proxy. Never 1, 2 or a subnet (dev-request rule 1):
 * with Fly's layout (`…, <client IP>, <app IP>`) `1` and every subnet make
 * req.ip the app's own IP for every client (one bucket), and `2` rests on
 * an X-Forwarded-For layout Fly has not documented.
 */
export function installClientIp(app: Application, cfg: ClientIpConfig, opts: ClientIpMiddlewareOptions = {}): ClientIpMiddleware {
  app.set("trust proxy", true);
  const middleware = createClientIpMiddleware(cfg, opts);
  app.use(middleware);
  (opts.log ?? console.log)(`[boot] client-ip mode=${cfg.mode} onFly=${cfg.onFly} reason=${cfg.reason}`);
  return middleware;
}
