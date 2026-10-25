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
 * Read-out for AC2 (trinn 1b): the `client_ip_stats` log line, and the same
 * counters plus mode, breaker state and since-boot sums as `clientIp` in the
 * existing GET /admin/analytics/ops/event-loop (getInstalledClientIpSnapshot).
 * Trinn 1c: on Fly every closed window is also stored per machine
 * (services/client-ip-shadow-store.ts, written by a timer, never by the
 * request path), so `clientIp.cumulative` sums every deploy and
 * `clientIp.ac2` is the server's own verdict on each AC2 criterion
 * (evaluateClientIpAc2). Trinn 1d makes AC2 measure what enforce would do:
 * the fanIn ratio over 20 min (FANIN_WINDOWS), /mcp rated the way the MCP
 * limiters key it, with the routers' own session check (ac2LimitersFor,
 * mcpSessionKeyed), and hours_covered from the time each window was actually
 * measured (coveredMs).
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
import { stripLangPrefix } from "../i18n/t";
import { mcpPrimaryKey } from "./mcp-rate-limit";
import {
  createClientIpShadowStore,
  type ClientIpShadowStore,
  type ClientIpShadowWriterStats,
  type ClientIpStoredTotals,
} from "../services/client-ip-shadow-store";

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

  /** While open at t: when it closes again; otherwise null. */
  openUntilAt(t: number): number | null {
    return this.isOpen(t) ? this.openUntil : null;
  }

  /** Every key the ring holds (client-ip.test.ts, B1 pin). */
  retainedKeys(): string[] {
    return this.ring.flatMap((b) => (b ? [...b.fci, ...b.edge] : []));
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
// AC2's fanIn ratio spans 4 stats windows = 20 min (trinn 1d; review S1 of PR
// #1130). express-rate-limit starts a key's 15-min window at its first hit,
// not on a 5-min boundary, so one limiter window can touch 4 stats windows,
// and over 3 two bursts 11 min apart each fell in a different span (320 in
// one limiter window rated 0.533). The last of those 4 with traffic is closed
// and rated over itself and the 3 before it, so every 15-min span is inside
// some rated span: an upper bound in time, as ac2LimitersFor is one in path
// space. Steady traffic is rated at 4/3 of its 15-min count (fails early).
const FANIN_WINDOWS = 4;
const TOP_N = 5;
const TOP_CAP = 1024;
const FANIN_CAP = 8;
const DISTINCT_CAP = 4096;
// Fly's http_service check (fly.toml) and the Dockerfile HEALTHCHECK (via localhost).
const HEALTH_CHECK_PATHS: ReadonlySet<string> = new Set(["/.well-known/agent-card.json", "/health"]);

type PathClass = "api" | "a2a" | "mcp" | "other";

interface TopEntry {
  n: number;
  /** The top list's path split (log line and window). */
  paths: Record<PathClass, number>;
  /** Requests per AC2_FANIN_LIMITS limiter (ac2LimitersFor): what the fanIn criterion rates. */
  limits: Record<Ac2FanInLimiter, number>;
  legacy: Set<string>;
  ua: Map<string, number>;
}

/** A window's additive counters: what sums across windows into since-boot totals. */
interface StatsCounters {
  n: number;
  fciValid: number;
  fallback: Record<FlyClientIpFallback, number>;
  fallbackHc: number;
  errors: number;
  xffClientSupplied: number;
  agreeFciEdge: { n: number; agree: number };
  agreeLegacyEqFci: { n: number; agree: number };
  wouldTrip: number;
  topOverflow: number;
}

interface StatsWindow extends StatsCounters {
  index: number;
  /** Trinn 1d: when this process began measuring the window — its first request in its first window, else the start. */
  measuredFrom: number;
  dFci: Set<string>;
  dEdge: Set<string>;
  dLegacy: Set<string>;
  distinctCapped: boolean;
  top: Map<string, TopEntry>;
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

/** The additive counters of a stats line; since_boot (ClientIpOpsSnapshot) sums the same fields. */
export interface ClientIpCounters {
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
  /** Breaker trips (in shadow: would have tripped). */
  would_trip: number;
  /** Requests whose Fly-Client-IP got no top-list entry (TOP_CAP reached): > 0 means the top list is incomplete. */
  top_overflow: number;
}

export interface ClientIpStatsLine extends ClientIpCounters {
  evt: "client_ip_stats";
  mode: ClientIpMode;
  window_start: string;
  window_s: number;
  D_fci: number;
  D_edge: number;
  D_legacy: number;
  distinct_capped: boolean;
  /** In shadow: the simulated state enforce would be in. */
  breaker_open: boolean;
  breaker_trips_total: number;
  top15m: ClientIpTopKey[];
}

// ─── AC2, the shadow gate before trinn 2 (trinn 1c) ─────────────────────

/**
 * The limits behind AC2's fanIn criterion ("no top key with fanIn > 1 at
 * ≥ 80 % of its smallest limit"): every IP-keyed limiter with a 15-min
 * window, at its anonymous ceiling, rated over FANIN_WINDOWS (20 min). One
 * limiter instance keeps one count per key on every path it is mounted on,
 * so a key is rated per limiter, not per path (review B1 of PR #1130):
 *   general  generalLimiter 300 (security.ts): /api except /api/tannlege*,
 *            /ut and /reise (index.ts), /sok (seo.ts, experiences-seo.ts,
 *            dental-seo.ts), /reise, /for-tilbydere/finn and the gårdssalg
 *            booking form post (experiences-seo.ts; I-T of
 *            2026-10-17-integrasjonstest-oppfolging), every gårdssalg claim
 *            route, /kategori/gardssalg/eier/* and
 *            /api/opplevelser/gardssalg-claim/* (gardssalg-claim.ts; I-U).
 *   search   searchLimiter 150: /api/marketplace/search and /discover,
 *            which generalLimiter counts as well.
 *   a2a      jsonRpcLimiter 200: /a2a on rettfrabonden.com and opplevagent.no.
 *   dental   dentalLimiter 1000: /api/tannlege and /a2a on finn-tannlege.com
 *            (dental-a2a.ts).
 *   mcp      the smallest MCP primary ceiling, 200 (mcp-rate-limit.ts), per
 *            vertical. The primary keys a request on its MCP session only
 *            when the router holds that session, so only /mcp it keys on the
 *            IP counts (trinn 1d; review S2 of PR #1130, B1 of PR #1151):
 *            `initialize`, anything sent bare, and an id the router no longer
 *            holds (every deploy empties the maps; 30 min idle drops one).
 *   mcp_brake the MCP brake, 3 000 (mcp-rate-limit.ts), keyed on the IP for
 *            every /mcp request on all three verticals: what a shared egress
 *            with many sessions meets first.
 * ac2LimitersFor maps a request to them. Not rated: the limiters with another
 * window — registrationLimiter and consumerKeyIssuanceLimiter (50 an hour),
 * cartWishesLimiter and the MCP sideEffect quota (20 a minute),
 * resendWebhookLimiter (120 a minute, Svix only), adminLimiter (500 an hour,
 * admin key). A key near one of those does not fail the criterion.
 * Pinned against the limiter sources and mounts by client-ip-shadow-store.test.ts.
 */
export const AC2_FANIN_LIMITS = { general: 300, search: 150, a2a: 200, dental: 1000, mcp: 200, mcp_brake: 3000 } as const;

export type Ac2FanInLimiter = keyof typeof AC2_FANIN_LIMITS;

const AC2_FANIN_LIMITERS = Object.keys(AC2_FANIN_LIMITS) as Ac2FanInLimiter[];

/** `path` is `mount` or below it, segment-wise, as an Express mount matches. */
const under = (path: string, mount: string): boolean => path === mount || path.startsWith(mount + "/");

/**
 * The AC2_FANIN_LIMITS limiters a request to `path` (req.path here) counts
 * against, as the limiter mounts see it: after langMiddleware's /en and /sv
 * strip (it runs after this middleware; /sv is stripped here even while
 * SV_LOCALE_ENABLED is off and langMiddleware leaves it, an over-count —
 * review S5 of PR #1130), matched like Express matches a mount or a route
 * (case-insensitive, whole segments, an optional trailing slash), with
 * generalLimiter's own case-sensitive /api/tannlege skip.
 * The host gates are not mirrored (this runs before them), so a path that
 * reaches a limiter on some host counts against it on every host: /ut,
 * /reise, /sok, /for-tilbydere/finn, /kategori/gardssalg/book/<slug> and
 * everything under /kategori/gardssalg/eier as general (the booking path for
 * any method, though only its POST is limited, and the claim paths on every
 * host, though only opplevagent.no serves them — the path is all this sees),
 * /a2a against both jsonRpcLimiter and dentalLimiter, /mcp summed over the
 * verticals' own chains: against the brake always, against the primary
 * unless `sessionKeyed()` (mcpSessionKeyed: the primary keys it on a session
 * a router holds). sessionKeyed is called only for a path under /mcp
 * (review S1 of PR #1151). Each count is thus at least the key's count in
 * that limiter, never below it — save a session one vertical's router holds
 * sent to another vertical's /mcp (isKnownToAnMcpRouter is the union; this
 * runs before the host gates), which only a client mixing up its servers'
 * ids does — so the criterion may fail early, but never passes a key at 80 %
 * of a rated limiter.
 * Exported for client-ip-shadow-store.test.ts.
 */
export function ac2LimitersFor(path: string, sessionKeyed: () => boolean = () => false): Ac2FanInLimiter[] {
  const p = stripLangPrefix(path);
  const lower = p.toLowerCase();
  const out: Ac2FanInLimiter[] = [];
  if (
    (under(lower, "/api") && !p.startsWith("/api/tannlege")) ||
    under(lower, "/ut") ||
    under(lower, "/reise") ||
    lower === "/sok" ||
    lower === "/sok/" ||
    lower === "/for-tilbydere/finn" ||
    lower === "/for-tilbydere/finn/" ||
    /^\/kategori\/gardssalg\/book\/[^/]+\/?$/.test(lower) ||
    under(lower, "/kategori/gardssalg/eier")
  ) {
    out.push("general");
  }
  if (under(lower, "/api/marketplace/search") || under(lower, "/api/marketplace/discover")) out.push("search");
  if (under(lower, "/a2a")) out.push("a2a", "dental");
  else if (under(lower, "/api/tannlege")) out.push("dental");
  if (under(lower, "/mcp")) {
    if (!sessionKeyed()) out.push("mcp");
    out.push("mcp_brake");
  }
  return out;
}

/**
 * Whether the MCP primary limiter keys this request on its session rather
 * than on the IP (trinn 1d; review S2 of PR #1130, B1 of PR #1151):
 * mcpPrimaryKey itself, given the routers' own session check as the three
 * primaries are, so the two cannot drift — a UUID-shaped mcp-session-id that
 * `isKnownSession` says a router holds. An id no router holds (after a
 * deploy, or 30 min idle) or a made-up one is keyed on the IP and counts
 * against the primary. Without isKnownSession, or if it throws, false: every
 * /mcp counts against the primary too, trinn 1c's upper bound.
 * Exported for client-ip-shadow-store.test.ts.
 */
export function mcpSessionKeyed(req: Request, isKnownSession?: (sessionId: string) => boolean): boolean {
  if (!isKnownSession || req.headers["mcp-session-id"] === undefined) return false;
  try {
    return mcpPrimaryKey(req, isKnownSession).startsWith("sid:");
  } catch {
    return false;
  }
}

/**
 * The MCP routers' own "do I hold this session?" checks: what each
 * vertical's primary is given as isKnownSession (mcp-rate-limit.ts's
 * isLiveRfbMcpSession → hasMcpSession; experiences-mcp.ts; dental-mcp.ts).
 * Pinned against those three chains by client-ip-shadow-store.test.ts.
 */
export const MCP_ROUTER_SESSION_CHECKS = [
  { module: "../routes/mcp", check: "hasMcpSession" },
  { module: "../routes/experiences-mcp", check: "hasExperiencesMcpSession" },
  { module: "../routes/dental-mcp", check: "hasDentalMcpSession" },
] as const;

// MCP_ROUTER_SESSION_CHECKS' files, resolved on first use (null: not found).
let mcpRouterFiles: Array<string | null> | null = null;

/**
 * installClientIp's default isKnownMcpSession: does one of the MCP routers
 * hold this session? The union over the verticals, as this runs before the
 * host gates. Read only from a router module already loaded, never loading
 * one: index.ts loads dental-mcp and experiences-mcp on their host's first
 * /mcp, a router not loaded has minted no session, and loading it here would
 * pull its whole tool surface into the request path.
 * Exported for client-ip-shadow-store.test.ts.
 */
export function isKnownToAnMcpRouter(sessionId: string): boolean {
  if (mcpRouterFiles === null) {
    mcpRouterFiles = MCP_ROUTER_SESSION_CHECKS.map(({ module }) => {
      try {
        return require.resolve(module);
      } catch {
        return null;
      }
    });
  }
  for (let i = 0; i < MCP_ROUTER_SESSION_CHECKS.length; i++) {
    const file = mcpRouterFiles[i];
    const check = file === null ? undefined : require.cache[file]?.exports?.[MCP_ROUTER_SESSION_CHECKS[i].check];
    if (typeof check === "function" && check(sessionId) === true) return true;
  }
  return false;
}

/** AC2 in the dev-request's `## Acceptance criteria`. */
export const AC2_THRESHOLDS = {
  minHours: 48,
  minRequests: 5000,
  /** (missing + invalid + non_public − fallback_hc) / n: "fallback ≤ health-check volume + 1 %". */
  maxFallbackBeyondHc: 0.01,
  minAgreeFciEdge: 0.995,
  minAgreeLegacyEqFci: 0.999,
  /** No top key with fanIn > 1 at ≥ 80 % of its smallest limit. */
  maxFanInRatio: 0.8,
} as const;

/** A closed window's largest fanIn ratio: of the keys with fanIn > 1 over it and the 3 windows before it (20 min), the one closest to a limit. */
export interface ClientIpWindowFanIn {
  /** The key's requests counted against limiter `class` over those 20 min / AC2_FANIN_LIMITS[class]. */
  ratio: number;
  /** The limiter (AC2_FANIN_LIMITS key) it is closest to. */
  class: Ac2FanInLimiter;
  /** Distinct legacy keys behind it, capped at 8. */
  fanIn: number;
  /** Its traffic-classifier family, as ClientIpTopKey.ua: tells a known AI egress apart. */
  ua: string;
}

/**
 * `clientIp.cumulative`: every shadow window stored in the main DB, across
 * deploys (14-day retention). Windows a process stored in another mode
 * (CLIENT_IP_MODE=enforce, or after trinn 2) are kept but not summed: AC2 is
 * the shadow gate (review S2 of PR #1130).
 */
export interface ClientIpCumulative {
  /** Start of the oldest stored window; null while none is stored. */
  since: string | null;
  /** End of the newest stored window. */
  until: string | null;
  /** Stored rows: one per machine per 5-min window. */
  windows: number;
  machines: number;
  /**
   * Measured time in hours: per distinct stored window, the largest covered_ms
   * of its rows (trinn 1d: a process's first window only from its first
   * request; two machines in one window count it once). Gaps (a restart's
   * unstored window, idle time) do not count.
   */
  hours_covered: number;
  /** The stats line's additive counters summed over every stored row; n = requests. */
  counters: ClientIpCounters;
  /** The largest stored per-window fanIn ratio, with its window; null when no top key ever had fanIn > 1. */
  fanin_max: (ClientIpWindowFanIn & { window_start: string }) | null;
  /**
   * For the two "= 0" criteria a human may explain instead (AC2: "= 0 or
   * explained"; review S3 of PR #1130): the stored rows with a count > 0, and
   * the newest such window's start (null when none).
   */
  nonzero_windows: ClientIpStoredTotals["nonzero"];
  /** This process's writer: tells "nothing stored yet" from "writes failing". */
  writer: ClientIpShadowWriterStats;
}

export interface ClientIpAc2Criterion {
  /** null = nothing measured yet, which never passes. */
  value: number | null;
  threshold: number;
  op: ">=" | "<=" | "<" | "==";
  pass: boolean;
}

/** `clientIp.ac2`: every AC2 criterion over `cumulative`; ready only when each one passes. */
export interface ClientIpAc2 {
  ready: boolean;
  criteria: {
    hours_covered: ClientIpAc2Criterion;
    requests: ClientIpAc2Criterion;
    fallback_beyond_health_checks: ClientIpAc2Criterion;
    /** "= 0 or explained": explaining is a human call, so the server passes only 0. */
    invalid_non_public: ClientIpAc2Criterion;
    /** Text comparison: an IPv6 written two ways can only lower it (review S5 of PR #1102), never pass it falsely. */
    agree_fci_edge: ClientIpAc2Criterion;
    agree_legacy_eq_fci: ClientIpAc2Criterion;
    would_trip: ClientIpAc2Criterion;
    fanin_limit_ratio: ClientIpAc2Criterion;
    /** fanin_limit_ratio only sees keys that got a top-list entry (review S4 of PR #1102): it holds only with no overflow. */
    top_overflow: ClientIpAc2Criterion;
  };
}

const ratioOf = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const atLeast = (value: number | null, threshold: number): ClientIpAc2Criterion => ({ value, threshold, op: ">=", pass: value !== null && value >= threshold });
const atMost = (value: number | null, threshold: number): ClientIpAc2Criterion => ({ value, threshold, op: "<=", pass: value !== null && value <= threshold });
const below = (value: number, threshold: number): ClientIpAc2Criterion => ({ value, threshold, op: "<", pass: value < threshold });
const zero = (value: number): ClientIpAc2Criterion => ({ value, threshold: 0, op: "==", pass: value === 0 });

/** The server's AC2 verdict: each criterion with value, threshold and pass; ready when all pass. */
export function evaluateClientIpAc2(c: ClientIpCumulative): ClientIpAc2 {
  const k = c.counters;
  const fallbacks = k.fallback.missing + k.fallback.invalid + k.fallback.non_public;
  const criteria: ClientIpAc2["criteria"] = {
    hours_covered: atLeast(c.hours_covered, AC2_THRESHOLDS.minHours),
    requests: atLeast(k.n, AC2_THRESHOLDS.minRequests),
    fallback_beyond_health_checks: atMost(ratioOf(fallbacks - k.fallback_hc, k.n), AC2_THRESHOLDS.maxFallbackBeyondHc),
    invalid_non_public: zero(k.fallback.invalid + k.fallback.non_public),
    agree_fci_edge: atLeast(ratioOf(k.agree_fci_edge.agree, k.agree_fci_edge.n), AC2_THRESHOLDS.minAgreeFciEdge),
    agree_legacy_eq_fci: atLeast(ratioOf(k.agree_legacy_eq_fci.agree, k.agree_legacy_eq_fci.n), AC2_THRESHOLDS.minAgreeLegacyEqFci),
    would_trip: zero(k.would_trip),
    fanin_limit_ratio: below(c.fanin_max?.ratio ?? 0, AC2_THRESHOLDS.maxFanInRatio),
    top_overflow: zero(k.top_overflow),
  };
  return { ready: Object.values(criteria).every((x) => x.pass), criteria };
}

function cumulativeFrom(t: ClientIpStoredTotals, writer: ClientIpShadowWriterStats): ClientIpCumulative {
  return {
    since: t.first,
    until: t.last === null ? null : new Date(Date.parse(t.last) + STATS_WINDOW_MS).toISOString(),
    windows: t.rows,
    machines: t.machines,
    hours_covered: t.coveredMs / 3_600_000,
    counters: t.counters,
    fanin_max: t.fanInMax,
    nonzero_windows: t.nonzero,
    writer,
  };
}

/**
 * `clientIp` in GET /admin/analytics/ops/event-loop: the AC2 read-out for the
 * fleet. Everything but cumulative/ac2 is for one process (one Fly machine;
 * a restart starts it over).
 * Counters, the breaker state, and the open window with its top list keyed
 * by the same 12-hex hashes as the log line: never a raw IP.
 */
export interface ClientIpOpsSnapshot {
  mode: ClientIpMode;
  on_fly: boolean;
  reason: ClientIpConfig["reason"];
  /** window_start of the first window in since_boot; null before the first observed request (always in legacy). */
  since: string | null;
  /** Now, not at the last request; in shadow the simulated state enforce would be in. */
  breaker: { open: boolean; open_until: string | null; trips_total: number };
  /** Every window since `since`, the open one included. */
  since_boot: ClientIpCounters;
  /**
   * The open window, as the next client_ip_stats line will be built from it
   * (lines are written lazily: window_start tells its age; breaker_open is as
   * of now); null when there is none yet.
   */
  window: ClientIpStatsLine | null;
  /**
   * Trinn 1c: every shadow window stored in the main DB, so AC2 survives deploys.
   * null without a store (off Fly, or a test that passes none); { error } when
   * the DB read failed (the rest of the snapshot still answers).
   */
  cumulative: ClientIpCumulative | { error: "read_failed" } | null;
  /** The server's own AC2 verdict over cumulative; null when cumulative is not available. */
  ac2: ClientIpAc2 | null;
}

function newCounters(): StatsCounters {
  return {
    n: 0,
    fciValid: 0,
    fallback: { missing: 0, invalid: 0, non_public: 0 },
    fallbackHc: 0,
    errors: 0,
    xffClientSupplied: 0,
    agreeFciEdge: { n: 0, agree: 0 },
    agreeLegacyEqFci: { n: 0, agree: 0 },
    wouldTrip: 0,
    topOverflow: 0,
  };
}

function addCounters(into: StatsCounters, from: StatsCounters): void {
  into.n += from.n;
  into.fciValid += from.fciValid;
  for (const f of ["missing", "invalid", "non_public"] as const) into.fallback[f] += from.fallback[f];
  into.fallbackHc += from.fallbackHc;
  into.errors += from.errors;
  into.xffClientSupplied += from.xffClientSupplied;
  into.agreeFciEdge.n += from.agreeFciEdge.n;
  into.agreeFciEdge.agree += from.agreeFciEdge.agree;
  into.agreeLegacyEqFci.n += from.agreeLegacyEqFci.n;
  into.agreeLegacyEqFci.agree += from.agreeLegacyEqFci.agree;
  into.wouldTrip += from.wouldTrip;
  into.topOverflow += from.topOverflow;
}

/** The one mapping to the logged names, so since_boot and the log line can never drift apart. */
function countersOut(c: StatsCounters): ClientIpCounters {
  return {
    n: c.n,
    fci_valid: c.fciValid,
    fallback: { ...c.fallback },
    fallback_hc: c.fallbackHc,
    errors: c.errors,
    xff_client_supplied: c.xffClientSupplied,
    agree_fci_edge: { ...c.agreeFciEdge },
    agree_legacy_eq_fci: { ...c.agreeLegacyEqFci },
    would_trip: c.wouldTrip,
    top_overflow: c.topOverflow,
  };
}

function newWindow(index: number, measuredFrom = index * STATS_WINDOW_MS): StatsWindow {
  return {
    index,
    measuredFrom,
    ...newCounters(),
    dFci: new Set(),
    dEdge: new Set(),
    dLegacy: new Set(),
    distinctCapped: false,
    top: new Map(),
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

/** A top entry's most frequent UA family. */
function mainUa(e: TopEntry): string {
  return [...e.ua.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
}

function newTopEntry(): TopEntry {
  return {
    n: 0,
    paths: { api: 0, a2a: 0, mcp: 0, other: 0 },
    limits: { general: 0, search: 0, a2a: 0, dental: 0, mcp: 0, mcp_brake: 0 },
    legacy: new Set(),
    ua: new Map(),
  };
}

/**
 * Of the merged top keys (FANIN_WINDOWS, 20 min) with fanIn > 1, the one
 * closest to one of its limiters: its largest count / AC2_FANIN_LIMITS over
 * every limiter, so its smallest limit relative to its traffic (first wins a
 * tie); null if none.
 */
function fanInMax(merged: Map<string, TopEntry>): ClientIpWindowFanIn | null {
  let best: ClientIpWindowFanIn | null = null;
  for (const e of merged.values()) {
    if (e.legacy.size <= 1) continue;
    for (const limiter of AC2_FANIN_LIMITERS) {
      const ratio = e.limits[limiter] / AC2_FANIN_LIMITS[limiter];
      if (ratio > 0 && (best === null || ratio > best.ratio)) best = { ratio, class: limiter, fanIn: e.legacy.size, ua: mainUa(e) };
    }
  }
  return best;
}

/**
 * How much of window w this process measured, ms (trinn 1d): from
 * measuredFrom (inside the window, set by windowAt) to the window's end. A
 * restart mid-window thus covers only the rest of that window, not all of it.
 */
function coveredMs(w: StatsWindow): number {
  return (w.index + 1) * STATS_WINDOW_MS - w.measuredFrom;
}

// ─── Middleware ─────────────────────────────────────────────────────────

export interface ClientIpMiddlewareOptions {
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  /** Sink for the stats line and the boot line. Default console.log. */
  log?: (line: string) => void;
  /** Sink for breaker events. Default console.error. */
  logError?: (line: string) => void;
  /**
   * Trinn 1c: where closed windows go (enqueue only, from the request path)
   * and cumulative is read from. createClientIpMiddleware: default none.
   * installClientIp: default the main-DB store on Fly, none off Fly.
   */
  store?: ClientIpShadowStore | null;
  /**
   * Trinn 1d: the MCP routers' own session check, as their primaries get it
   * (see mcpSessionKeyed). createClientIpMiddleware: default none, so every
   * /mcp counts against the primary. installClientIp: default
   * isKnownToAnMcpRouter.
   */
  isKnownMcpSession?: (sessionId: string) => boolean;
}

export type ClientIpMiddleware = ((req: Request, res: Response, next: NextFunction) => void) & {
  readonly mode: ClientIpMode;
  /** The current, still-open stats window (what the next log line will be built from). For the tests. */
  snapshot(): ClientIpStatsLine;
  /** The AC2 read-out (see ClientIpOpsSnapshot); served through getInstalledClientIpSnapshot. */
  opsSnapshot(): ClientIpOpsSnapshot;
  /**
   * Tests only (B1 regression pin, review of PR #1102): every address key the
   * stats and the breaker hold past the request. Each must be a
   * createStatsKey key, never a client-controlled string.
   */
  __retainedKeysForTesting(): string[];
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
  const store = opts.store ?? null;
  const isKnownMcpSession = opts.isKnownMcpSession;
  const statsKey = createStatsKey(crypto.randomBytes(16));
  const breaker = new CollapseBreaker();
  let current: StatsWindow | null = null;
  // Only the top maps of the previous FANIN_WINDOWS - 1 windows are kept: for
  // top15m (the last TOP_WINDOWS - 1 of them) and the fanIn ratio (all).
  let history: Array<Pick<StatsWindow, "index" | "top">> = [];
  // Since-boot totals of every closed window (plain numbers), folded in by windowAt.
  const closed = newCounters();
  let firstIndex: number | null = null;
  let lastT = 0;

  /** The top maps of w and the windows before it within `span` windows (TOP_WINDOWS: 15 min), merged per key. */
  function mergedTop(w: StatsWindow, span: number = TOP_WINDOWS): Map<string, TopEntry> {
    const merged = new Map<string, TopEntry>();
    for (const win of [...history.filter((h) => w.index - h.index < span && h.index < w.index), w]) {
      for (const [key, e] of win.top) {
        let m = merged.get(key);
        if (!m) {
          m = newTopEntry();
          merged.set(key, m);
        }
        m.n += e.n;
        for (const p of ["api", "a2a", "mcp", "other"] as const) m.paths[p] += e.paths[p];
        for (const l of AC2_FANIN_LIMITERS) m.limits[l] += e.limits[l];
        for (const l of e.legacy) addCapped(m.legacy, l, FANIN_CAP);
        for (const [u, c] of e.ua) m.ua.set(u, (m.ua.get(u) ?? 0) + c);
      }
    }
    return merged;
  }

  function topList(merged: Map<string, TopEntry>): ClientIpTopKey[] {
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
        ua: mainUa(e),
      }));
  }

  function line(w: StatsWindow, t: number, merged: Map<string, TopEntry> = mergedTop(w)): ClientIpStatsLine {
    return {
      evt: "client_ip_stats",
      mode,
      window_start: new Date(w.index * STATS_WINDOW_MS).toISOString(),
      window_s: STATS_WINDOW_MS / 1000,
      ...countersOut(w),
      D_fci: w.dFci.size,
      D_edge: w.dEdge.size,
      D_legacy: w.dLegacy.size,
      distinct_capped: w.distinctCapped,
      breaker_open: breaker.isOpen(t),
      breaker_trips_total: breaker.tripsTotal,
      top15m: topList(merged),
    };
  }

  function opsSnapshot(): ClientIpOpsSnapshot {
    const t = now();
    const total = newCounters();
    addCounters(total, closed);
    if (current) addCounters(total, current);
    const openUntil = breaker.openUntilAt(t);
    let cumulative: ClientIpOpsSnapshot["cumulative"] = null;
    let ac2: ClientIpAc2 | null = null;
    if (store) {
      try {
        const c = cumulativeFrom(store.totals("shadow"), store.writerStats());
        cumulative = c;
        ac2 = evaluateClientIpAc2(c);
      } catch {
        cumulative = { error: "read_failed" };
      }
    }
    return {
      mode,
      on_fly: cfg.onFly,
      reason: cfg.reason,
      since: firstIndex === null ? null : new Date(firstIndex * STATS_WINDOW_MS).toISOString(),
      breaker: {
        open: openUntil !== null,
        open_until: openUntil === null ? null : new Date(openUntil).toISOString(),
        trips_total: breaker.tripsTotal,
      },
      since_boot: countersOut(total),
      window: current ? line(current, t) : null,
      cumulative,
      ac2,
    };
  }

  /**
   * Hands a closed window to the store, with its fanIn ratio over
   * FANIN_WINDOWS and the time it was measured: once per closed window, never
   * throws, no DB here (the store's timer writes).
   */
  function persist(w: StatsWindow): void {
    if (!store) return;
    try {
      store.enqueue({
        windowStart: w.index * STATS_WINDOW_MS,
        mode,
        counters: countersOut(w),
        fanIn: fanInMax(mergedTop(w, FANIN_WINDOWS)),
        coveredMs: coveredMs(w),
      });
    } catch {
      /* persistence must never fail a request or stop the rotation */
    }
  }

  /**
   * The window for time t; rotating out (and logging) the previous one.
   *
   * The stats line is written lazily, by the first request after a window
   * closes, with no timer: nothing to clear on shutdown and nothing that
   * keeps tests alive. So the window still open at SIGTERM/restart is never
   * logged, a window without requests produces no line, and an idle window
   * is logged late. Fly's health check every 30 s (fly.toml) keeps the
   * 5-min cadence in practice. A logged window is also handed to the store
   * (trinn 1c), under the same rule, so the same windows are stored.
   */
  function windowAt(t: number): StatsWindow {
    const index = Math.floor(t / STATS_WINDOW_MS);
    if (current && current.index === index) return current;
    if (current) {
      if (current.n > 0 || current.errors > 0) {
        log(JSON.stringify(line(current, t)));
        persist(current);
      }
      addCounters(closed, current);
      history = [...history, { index: current.index, top: current.top }].filter(
        (h) => index - h.index < FANIN_WINDOWS && h.index < index
      );
    }
    // Trinn 1d: the process's first window is measured from its first
    // request (a restart mid-window), every later one from its start.
    const first = firstIndex === null;
    if (first) firstIndex = index;
    current = newWindow(index, first ? t : index * STATS_WINDOW_MS);
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
        entry = newTopEntry();
        w.top.set(fciKey, entry);
      }
      if (entry) {
        entry.n++;
        const reqPath = typeof req.path === "string" ? req.path : "";
        entry.paths[pathClass(reqPath)]++;
        for (const l of ac2LimitersFor(reqPath, () => mcpSessionKeyed(req, isKnownMcpSession))) entry.limits[l]++;
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
    opsSnapshot,
    __retainedKeysForTesting: (): string[] => {
      const keys: string[] = [];
      const topKeys = (top: Map<string, TopEntry>) => {
        for (const [key, e] of top) keys.push(key, ...e.legacy);
      };
      if (current) {
        keys.push(...current.dFci, ...current.dEdge, ...current.dLegacy);
        topKeys(current.top);
      }
      for (const h of history) topKeys(h.top);
      keys.push(...breaker.retainedKeys());
      return keys;
    },
  });
}

// ─── Installed instance (AC2 read-out) ──────────────────────────────────

let installed: ClientIpMiddleware | null = null;

/**
 * `clientIp` in GET /admin/analytics/ops/event-loop: the snapshot of the
 * middleware installClientIp mounted in this process (in legacy too, so a
 * rollback or a typo in CLIENT_IP_MODE shows as mode/reason), or null when
 * installClientIp has not run (e.g. a test that mounts the analytics router
 * alone). Never throws: a failing snapshot must not take that ops response
 * down with it.
 */
export function getInstalledClientIpSnapshot(): ClientIpOpsSnapshot | { error: "snapshot_failed" } | null {
  if (!installed) return null;
  try {
    return installed.opsSnapshot();
  } catch {
    return { error: "snapshot_failed" };
  }
}

/** Tests only: forget the installed instance. */
export function __resetInstalledClientIpForTesting(): void {
  installed = null;
}

/**
 * The one call src/index.ts makes, FIRST, before anything reads req.ip /
 * req.ips / req.hostname. Sets `trust proxy` = true — trust EVERY hop, so
 * req.ip is the left-most X-Forwarded-For entry and req.protocol/req.secure
 * keep following the proxy. Never 1, 2 or a subnet (dev-request rule 1):
 * with Fly's layout (`…, <client IP>, <app IP>`) `1` and every subnet make
 * req.ip the app's own IP for every client (one bucket), and `2` rests on
 * an X-Forwarded-For layout Fly has not documented.
 * The mounted instance is what getInstalledClientIpSnapshot reads.
 * Trinn 1c: on Fly its closed windows go to the main-DB store unless
 * opts.store says otherwise; off Fly (local dev, CI, `npm test`) nothing
 * touches the DB. Trinn 1d: /mcp is rated with the routers' own session
 * check (isKnownToAnMcpRouter) unless opts.isKnownMcpSession says otherwise.
 */
export function installClientIp(app: Application, cfg: ClientIpConfig, opts: ClientIpMiddlewareOptions = {}): ClientIpMiddleware {
  app.set("trust proxy", true);
  const store = opts.store !== undefined ? opts.store : cfg.onFly ? createClientIpShadowStore() : null;
  const isKnownMcpSession = opts.isKnownMcpSession ?? isKnownToAnMcpRouter;
  const middleware = createClientIpMiddleware(cfg, { ...opts, store, isKnownMcpSession });
  app.use(middleware);
  installed = middleware;
  (opts.log ?? console.log)(`[boot] client-ip mode=${cfg.mode} onFly=${cfg.onFly} reason=${cfg.reason}`);
  return middleware;
}
