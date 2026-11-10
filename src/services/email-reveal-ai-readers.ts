/**
 * email-reveal-ai-readers.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, S-A2.
 *
 * A known AI reader / search fetcher whose ORIGIN is verified gets a higher
 * per-hour e-mail limit (EMAIL_REVEAL_AI_READER_PER_HOUR, see
 * email-reveal-guard.ts). The User-Agent alone never raises the limit: it
 * only picks which operator to verify against. Verification is
 * forward-confirmed reverse DNS (FCrDNS):
 *
 *   1. PTR of the client IP → hostnames; keep those that end in one of the
 *      operator's documented domains (".googlebot.com", …; a bare domain
 *      itself does not count);
 *   2. forward A (IPv4) / AAAA (IPv6) lookup of such a hostname must contain
 *      the same IP.
 *
 * Operators that publish only IP lists (OpenAI, Anthropic, Perplexity) have
 * method "ip_list": the client IP counts as verified only when it lies in a
 * CIDR range of the list that operator publishes for that UA's fetcher
 * (AI_READER_IP_LISTS; GPTBot is checked against gptbot.json, never against
 * chatgpt-user.json). Anthropic publishes one list for all its bots
 * (ClaudeBot, Claude-User, Claude-SearchBot), so those three share it. The
 * lists are fetched in the background, never on the request path:
 * isVerified() stays synchronous and answers "not verified" (→ base limit)
 * until a list is loaded. A list is fetched only when a request with one of
 * its UAs needs it (so only while an e-mail guard switch is on; switch off →
 * not one outbound fetch), at most once per IP_LIST_REFRESH_MS (24 h) after a
 * good load and once per IP_LIST_RETRY_MS (1 h) after a failed one, with a
 * timeout (IP_LIST_TIMEOUT_MS), a size cap (IP_LIST_MAX_BYTES), no
 * redirects, and strict JSON/CIDR validation: one malformed or too-broad
 * prefix rejects the whole response. A rejected or failed fetch keeps the
 * previous good list; with none, nothing is verified. A good list older than
 * IP_LIST_MAX_AGE_MS (7 days, i.e. refreshes kept failing) is no longer used.
 * Fail-closed: a malformed IP, an IPv6 client address in the IPv4-mapped
 * range written in hex (::ffff:102:304) and a v4/v6 family mismatch never
 * match. No per-IP state beyond the salted-hash cache (used here only so the
 * verification log line is written once per IP and operator per 24 h).
 *
 * Never blocks a request on DNS: emailRevealAiReaderVerified() is
 * synchronous. On a cache miss it answers "not verified" (→ base limit for
 * this request) and starts one background lookup (deduplicated per IP and
 * operator, errors swallowed, overall timeout VERIFY_TIMEOUT_MS, at most
 * MAX_IN_FLIGHT at once). Later requests read the cached result: positive
 * POSITIVE_TTL_MS (24 h), negative NEGATIVE_TTL_MS (1 h), error/timeout
 * ERROR_TTL_MS (10 min). The cache is bounded (MAX_CACHE entries, oldest
 * evicted first) and keyed by a salted hash of the exact IP + operator, never
 * the raw IP; the raw IP lives only in the closure of the running lookup.
 *
 * Tokens reuse the UA names of services/traffic-classifier.ts
 * (AI_AGENT_REGISTRY / SEARCH_ENGINE_PATTERNS); a test pins that every token
 * here is one of those. NOT here on purpose: Google-Extended and
 * Applebot-Extended are robots.txt control tokens, not fetchers; CCBot never
 * gets e-mail at all (S-A3, checked before this module is consulted).
 */

import crypto from "crypto";
import { promises as dnsPromises } from "dns";

export type AiReaderOperator = "google" | "microsoft" | "apple" | "openai" | "anthropic" | "perplexity";
export type AiReaderVerifyMethod = "fcrdns" | "ip_list";

export interface AiReaderEntry {
  /** UA token, as in traffic-classifier.ts. */
  token: string;
  /** Matches the token in a User-Agent (excludes look-alike control tokens). */
  pattern: RegExp;
  operator: AiReaderOperator;
  method: AiReaderVerifyMethod;
  /**
   * fcrdns: the PTR hostname must end in "." + one of these (operator's
   * documented reverse-DNS domains). ip_list: empty.
   */
  domains: readonly string[];
  /** ip_list: the operator's published list for this fetcher (AI_READER_IP_LISTS); fcrdns: null. */
  ipList: AiReaderIpListId | null;
}

export type AiReaderIpListId =
  | "openai-gptbot"
  | "openai-searchbot"
  | "openai-chatgpt-user"
  | "anthropic-bots"
  | "perplexity-bot"
  | "perplexity-user";

/**
 * The operators' published IP lists, one per fetcher where the operator
 * publishes per-fetcher lists. Every URL serves
 * {"creationTime": …, "prefixes": [{"ipv4Prefix": "a.b.c.d/n"} | {"ipv6Prefix": "x::/n"}]}.
 *   openai      platform.openai.com/docs/bots ("Overview of OpenAI Crawlers"):
 *               GPTBot → gptbot.json, OAI-SearchBot → searchbot.json,
 *               ChatGPT-User → chatgpt-user.json
 *   perplexity  docs.perplexity.ai/guides/bots ("Perplexity Crawlers"):
 *               PerplexityBot → perplexitybot.json, Perplexity-User → perplexity-user.json
 *   anthropic   support.claude.com/en/articles/8896518 ("Does Anthropic crawl
 *               data from the web, and how can site owners block the
 *               crawler?"): "If a crawler has a source IP address on this
 *               list, it indicates that the crawler is coming from
 *               Anthropic" → claude.com/crawling/bots.json (one list for
 *               ClaudeBot, Claude-User and Claude-SearchBot). Not the API
 *               outbound ranges of platform.claude.com/docs/en/api/ip-addresses,
 *               which are for API tool calls, not the web crawlers.
 */
export const AI_READER_IP_LISTS: Readonly<Record<AiReaderIpListId, { operator: AiReaderOperator; url: string }>> = {
  "openai-gptbot": { operator: "openai", url: "https://openai.com/gptbot.json" },
  "openai-searchbot": { operator: "openai", url: "https://openai.com/searchbot.json" },
  "openai-chatgpt-user": { operator: "openai", url: "https://openai.com/chatgpt-user.json" },
  "anthropic-bots": { operator: "anthropic", url: "https://claude.com/crawling/bots.json" },
  "perplexity-bot": { operator: "perplexity", url: "https://www.perplexity.ai/perplexitybot.json" },
  "perplexity-user": { operator: "perplexity", url: "https://www.perplexity.ai/perplexity-user.json" },
};

/**
 * The configured AI readers. Domains per operator documentation:
 *   google     developers.google.com/search/docs/crawling-indexing/verifying-googlebot
 *              (crawlers: googlebot.com, google.com)
 *   microsoft  bing.com/webmasters/help/how-to-verify-bingbot (search.msn.com)
 *   apple      support.apple.com/119829 (applebot.apple.com)
 *   openai, anthropic, perplexity: IP lists only (AI_READER_IP_LISTS)
 * Order: *-User / specific tokens before their family prefix.
 */
export const AI_READER_REGISTRY: readonly AiReaderEntry[] = [
  { token: "Googlebot", pattern: /Googlebot/, operator: "google", method: "fcrdns", domains: ["googlebot.com", "google.com"], ipList: null },
  { token: "bingbot", pattern: /bingbot/i, operator: "microsoft", method: "fcrdns", domains: ["search.msn.com"], ipList: null },
  { token: "Applebot", pattern: /Applebot(?!-Extended)/, operator: "apple", method: "fcrdns", domains: ["applebot.apple.com"], ipList: null },
  { token: "ChatGPT-User", pattern: /ChatGPT-User/, operator: "openai", method: "ip_list", domains: [], ipList: "openai-chatgpt-user" },
  { token: "OAI-SearchBot", pattern: /OAI-SearchBot/, operator: "openai", method: "ip_list", domains: [], ipList: "openai-searchbot" },
  { token: "GPTBot", pattern: /GPTBot/, operator: "openai", method: "ip_list", domains: [], ipList: "openai-gptbot" },
  { token: "Claude-User", pattern: /Claude-User/, operator: "anthropic", method: "ip_list", domains: [], ipList: "anthropic-bots" },
  { token: "Claude-SearchBot", pattern: /Claude-SearchBot/, operator: "anthropic", method: "ip_list", domains: [], ipList: "anthropic-bots" },
  { token: "ClaudeBot", pattern: /ClaudeBot/, operator: "anthropic", method: "ip_list", domains: [], ipList: "anthropic-bots" },
  { token: "Perplexity-User", pattern: /Perplexity-User/, operator: "perplexity", method: "ip_list", domains: [], ipList: "perplexity-user" },
  { token: "PerplexityBot", pattern: /PerplexityBot/, operator: "perplexity", method: "ip_list", domains: [], ipList: "perplexity-bot" },
];

/** The first registry entry whose token occurs in the User-Agent, else null. */
export function aiReaderEntryOf(ua: string | undefined | null): AiReaderEntry | null {
  if (typeof ua !== "string" || ua === "") return null;
  return AI_READER_REGISTRY.find((e) => e.pattern.test(ua)) ?? null;
}

// ─── Resolver ───────────────────────────────────────────────────────────

/** The DNS calls FCrDNS needs; injectable so tests make no network calls. */
export interface AiReaderResolver {
  reverse(ip: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export const VERIFY_TIMEOUT_MS = 2_000;
export const POSITIVE_TTL_MS = 24 * 60 * 60_000;
export const NEGATIVE_TTL_MS = 60 * 60_000;
export const ERROR_TTL_MS = 10 * 60_000;
export const MAX_CACHE = 10_000;
/**
 * Background verifications running at once. Each slot can issue up to ~4
 * c-ares queries (1 PTR + up to MAX_PTR_NAMES = 3 forward A/AAAA), each with
 * its own resolver timeout (VERIFY_TIMEOUT_MS), so real concurrent DNS work
 * is bounded at about 4 × MAX_IN_FLIGHT queries; the overall per-slot
 * timeout frees the slot after VERIFY_TIMEOUT_MS even if queries linger.
 */
export const MAX_IN_FLIGHT = 50;
/** PTR hostnames forward-checked per IP (counted among the names inside the operator's domains). */
const MAX_PTR_NAMES = 3;

/** The real resolver: c-ares (non-blocking, no libuv threadpool), one try per query. */
export function createDefaultAiReaderResolver(timeoutMs = VERIFY_TIMEOUT_MS): AiReaderResolver {
  const r = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    reverse: (ip) => r.reverse(ip),
    resolve4: (h) => r.resolve4(h),
    resolve6: (h) => r.resolve6(h),
  };
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; IPv6 to its canonical compressed lower-case form; else null. */
export function normalizeIp(raw: string): { ip: string; family: 4 | 6 } | null {
  let ip = raw.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((p) => Number(p) <= 255) ? { ip, family: 4 } : null;
  }
  if (!ip.includes(":") || ip.includes("%")) return null;
  try {
    return { ip: new URL(`http://[${ip}]/`).hostname.slice(1, -1), family: 6 };
  } catch {
    return null;
  }
}

/** A PTR name lower-cased, without the trailing root dot. */
function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function hostMatches(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host.endsWith("." + d));
}

/**
 * FCrDNS for one IP and entry. Resolves true only when a PTR name in the
 * operator's domains forward-resolves to the same IP. Rejects on DNS errors.
 */
export async function forwardConfirmedReverseDns(resolver: AiReaderResolver, rawIp: string, entry: AiReaderEntry): Promise<boolean> {
  if (entry.method !== "fcrdns" || entry.domains.length === 0) return false;
  const n = normalizeIp(rawIp);
  if (!n) return false;
  let ptr: string[];
  try {
    ptr = await resolver.reverse(n.ip);
  } catch (err: any) {
    // No PTR record is an answer (not verified), not a failure.
    if (err?.code === "ENOTFOUND" || err?.code === "ENODATA") return false;
    throw err;
  }
  const names = ptr.map(normalizeHost).filter((h) => hostMatches(h, entry.domains)).slice(0, MAX_PTR_NAMES);
  for (const name of names) {
    let addrs: string[];
    try {
      addrs = n.family === 4 ? await resolver.resolve4(name) : await resolver.resolve6(name);
    } catch {
      continue; // this name does not resolve; try the next
    }
    if (addrs.some((a) => normalizeIp(a)?.ip === n.ip)) return true;
  }
  return false;
}

// ─── IP lists (method "ip_list") ────────────────────────────────────────

/** A successfully loaded list is refreshed at most this often (24 h). */
export const IP_LIST_REFRESH_MS = 24 * 60 * 60_000;
/** After a failed or rejected fetch, the next try for that list (1 h). */
export const IP_LIST_RETRY_MS = 60 * 60_000;
/** A list whose last good load is older than this is not used (fail closed). */
export const IP_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Whole fetch (headers + body) timeout. */
export const IP_LIST_TIMEOUT_MS = 5_000;
/** Response bodies larger than this are rejected. */
export const IP_LIST_MAX_BYTES = 1024 * 1024;
/** More prefixes than this in one list → the response is rejected. */
export const IP_LIST_MAX_PREFIXES = 10_000;
/**
 * Broadest prefix accepted (a broader one rejects the whole response): no
 * crawler list legitimately covers a /0../11 IPv4 or /0../23 IPv6 range.
 * Today's broadest published prefix is an IPv4 /16 (chatgpt-user.json).
 */
export const IP_LIST_MIN_PREFIX_V4 = 12;
export const IP_LIST_MIN_PREFIX_V6 = 24;

/** One CIDR range; `base` has no host bits set. */
export interface Cidr { family: 4 | 6; base: bigint; len: number }

const V4_ADDR = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A normalized address (normalizeIp output) as a 32/128-bit integer, else null. */
function ipToBigInt(ip: string, family: 4 | 6): bigint | null {
  if (family === 4) {
    if (!V4_ADDR.test(ip)) return null;
    return ip.split(".").reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
  }
  if (!/^[0-9a-f:]+$/.test(ip)) return null; // canonical form only (no dotted tail, no zone)
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

/** True for an IPv6 integer in ::ffff:0:0/96 (IPv4-mapped). */
function isV4Mapped(v: bigint): boolean {
  return v >> 32n === 0xffffn;
}

/**
 * A prefix string from a list ("a.b.c.d/n" for ipv4Prefix, "x::/n" for
 * ipv6Prefix) → Cidr, or null when malformed: wrong family, leading zeros,
 * length out of range or broader than IP_LIST_MIN_PREFIX_V4/_V6, host bits
 * set, an IPv4-mapped or dotted IPv6 prefix.
 */
export function parseCidr(prefix: unknown, family: 4 | 6): Cidr | null {
  if (typeof prefix !== "string" || prefix.length > 64) return null;
  const m = /^([^/\s]+)\/(0|[1-9]\d{0,2})$/.exec(prefix);
  if (!m) return null;
  const len = Number(m[2]);
  const bits = family === 4 ? 32 : 128;
  if (len > bits || len < (family === 4 ? IP_LIST_MIN_PREFIX_V4 : IP_LIST_MIN_PREFIX_V6)) return null;
  let base: bigint | null;
  if (family === 4) {
    base = ipToBigInt(m[1]!, 4);
  } else {
    if (!m[1]!.includes(":") || m[1]!.includes(".")) return null;
    const n = normalizeIp(m[1]!);
    if (!n || n.family !== 6) return null;
    base = ipToBigInt(n.ip, 6);
    if (base !== null && isV4Mapped(base)) return null;
  }
  if (base === null) return null;
  const hostBits = BigInt(bits - len);
  if (base & ((1n << hostBits) - 1n)) return null;
  return { family, base, len };
}

/** Whether a normalized client address lies in `c` (families must match). */
export function cidrContains(c: Cidr, ip: string, family: 4 | 6): boolean {
  if (c.family !== family) return false;
  const v = ipToBigInt(ip, family);
  if (v === null) return false;
  const shift = BigInt((family === 4 ? 32 : 128) - c.len);
  return v >> shift === c.base >> shift;
}

/**
 * A list response body → its prefixes, or null when it is not exactly the
 * published format: a JSON object whose "prefixes" is a non-empty array (at
 * most IP_LIST_MAX_PREFIXES) of objects with exactly one of "ipv4Prefix" /
 * "ipv6Prefix", every one a valid prefix (parseCidr). One bad entry rejects
 * the whole body.
 */
export function parseIpList(body: string): Cidr[] | null {
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return null; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const prefixes = (doc as { prefixes?: unknown }).prefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.length > IP_LIST_MAX_PREFIXES) return null;
  const out: Cidr[] = [];
  for (const p of prefixes) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const has4 = Object.prototype.hasOwnProperty.call(p, "ipv4Prefix");
    const has6 = Object.prototype.hasOwnProperty.call(p, "ipv6Prefix");
    if (has4 === has6) return null;
    const c = has4 ? parseCidr((p as any).ipv4Prefix, 4) : parseCidr((p as any).ipv6Prefix, 6);
    if (!c) return null;
    out.push(c);
  }
  return out;
}

/** The part of a fetch Response the loader uses. */
export interface IpListResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** Fetches one list URL; injectable so tests make no network calls. */
export type AiReaderIpListFetcher = (
  url: string,
  init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> },
) => Promise<IpListResponse>;

/** The real fetcher: Node's global fetch (Node ≥ 18). */
export const defaultAiReaderIpListFetcher: AiReaderIpListFetcher = (url, init) => {
  if (typeof globalThis.fetch !== "function") return Promise.reject(new Error("fetch unavailable"));
  return globalThis.fetch(url, init) as unknown as Promise<IpListResponse>;
};

export type IpListFailure = "timeout" | "http_status" | "too_large" | "malformed" | "network";

/** One list fetch outcome, for a log line (never an IP or a prefix). */
export type IpListEvent =
  | { list: AiReaderIpListId; outcome: "loaded"; prefixes: number }
  | { list: AiReaderIpListId; outcome: "failed"; reason: IpListFailure; kept_previous: boolean };

class IpListError extends Error {
  constructor(readonly reason: IpListFailure) { super(reason); }
}

export interface AiReaderIpListsOptions {
  fetcher?: AiReaderIpListFetcher;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  onEvent?: (event: IpListEvent) => void;
}

interface ListState {
  prefixes: readonly Cidr[] | null;
  loadedAt: number;
  nextAttemptAt: number;
  inFlight: Promise<void> | null;
}

/**
 * The loaded IP lists. contains() is synchronous and reads only what is
 * already loaded; when a list is due it starts one background fetch for it.
 * Nothing is fetched until contains() is first asked about a list.
 */
export class AiReaderIpLists {
  private readonly fetcher: AiReaderIpListFetcher;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly onEvent?: (event: IpListEvent) => void;
  private readonly lists = new Map<AiReaderIpListId, ListState>();

  constructor(opts: AiReaderIpListsOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultAiReaderIpListFetcher;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? IP_LIST_TIMEOUT_MS;
    this.maxBytes = Math.max(1, opts.maxBytes ?? IP_LIST_MAX_BYTES);
    this.onEvent = opts.onEvent;
  }

  /** Whether `rawIp` lies in list `id` as loaded now (false when not loaded or stale). */
  contains(id: AiReaderIpListId, rawIp: string): boolean {
    this.refreshIfDue(id);
    const n = normalizeIp(rawIp);
    if (!n) return false;
    const st = this.lists.get(id);
    if (!st || !st.prefixes || this.now() - st.loadedAt > IP_LIST_MAX_AGE_MS) return false;
    if (n.family === 6) {
      const v = ipToBigInt(n.ip, 6);
      if (v === null || isV4Mapped(v)) return false; // hex-written mapped form: never matched
    }
    return st.prefixes.some((c) => cidrContains(c, n.ip, n.family));
  }

  private refreshIfDue(id: AiReaderIpListId): void {
    let st = this.lists.get(id);
    if (!st) {
      st = { prefixes: null, loadedAt: 0, nextAttemptAt: 0, inFlight: null };
      this.lists.set(id, st);
    }
    if (st.inFlight || this.now() < st.nextAttemptAt) return;
    const state = st;
    state.inFlight = this.load(id)
      .then((prefixes) => {
        state.prefixes = prefixes;
        state.loadedAt = this.now();
        state.nextAttemptAt = state.loadedAt + IP_LIST_REFRESH_MS;
        this.emit({ list: id, outcome: "loaded", prefixes: prefixes.length });
      }, (err: unknown) => {
        state.nextAttemptAt = this.now() + IP_LIST_RETRY_MS;
        const reason: IpListFailure = err instanceof IpListError ? err.reason : "network";
        this.emit({ list: id, outcome: "failed", reason, kept_previous: state.prefixes !== null });
      })
      .finally(() => { state.inFlight = null; });
  }

  private emit(event: IpListEvent): void {
    if (!this.onEvent) return;
    try { this.onEvent(event); } catch { /* logging must never throw */ }
  }

  /** Fetches and validates one list; rejects with an IpListError (or a network error). */
  private async load(id: AiReaderIpListId): Promise<Cidr[]> {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new IpListError("timeout")); }, this.timeoutMs);
    });
    try {
      const body = await Promise.race([this.fetchBody(AI_READER_IP_LISTS[id].url, ctrl), timeout]);
      const prefixes = parseIpList(body);
      if (!prefixes) throw new IpListError("malformed");
      return prefixes;
    } finally {
      if (timer) clearTimeout(timer);
      // Make sure nothing keeps reading after a timeout or a rejection.
      if (!ctrl.signal.aborted) ctrl.abort();
    }
  }

  private async fetchBody(url: string, ctrl: AbortController): Promise<string> {
    const res = await this.fetcher(url, { signal: ctrl.signal, redirect: "error", headers: { accept: "application/json" } });
    if (!res.ok) throw new IpListError("http_status");
    const declared = res.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > this.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new IpListError("too_large");
    }
    if (!res.body) throw new IpListError("malformed");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new IpListError("too_large");
      }
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new IpListError("malformed");
    }
  }

  /** Test-only: resolves when every running fetch has finished. */
  async settled(): Promise<void> {
    for (;;) {
      const running = [...this.lists.values()].map((s) => s.inFlight).filter((p): p is Promise<void> => p !== null);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /** Test-only: prefixes held for a list (null when none loaded). */
  loadedCount(id: AiReaderIpListId): number | null {
    return this.lists.get(id)?.prefixes?.length ?? null;
  }
}

// ─── Cache + background verification ────────────────────────────────────

export interface AiReaderVerifierOptions {
  resolver?: AiReaderResolver;
  now?: () => number;
  timeoutMs?: number;
  maxCache?: number;
  maxInFlight?: number;
  salt?: Buffer;
  /**
   * Called once per successful (non-cached) verification; for ip_list
   * entries once per IP and operator per POSITIVE_TTL_MS.
   */
  onVerified?: (entry: AiReaderEntry, context: Readonly<Record<string, string>> | undefined) => void;
  /** ip_list: the list fetcher (default: global fetch). */
  ipListFetcher?: AiReaderIpListFetcher;
  /** ip_list: whole-fetch timeout (default IP_LIST_TIMEOUT_MS). */
  ipListTimeoutMs?: number;
  /** ip_list: response size cap (default IP_LIST_MAX_BYTES). */
  ipListMaxBytes?: number;
  /** ip_list: one call per list fetch outcome (no IPs). */
  onIpListEvent?: (event: IpListEvent) => void;
}

interface CacheEntry { verified: boolean; until: number }

export class AiReaderVerifier {
  private readonly resolver: AiReaderResolver;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxCache: number;
  private readonly maxInFlight: number;
  private readonly salt: Buffer;
  private readonly onVerified?: (entry: AiReaderEntry, context: Readonly<Record<string, string>> | undefined) => void;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly ipLists: AiReaderIpLists;

  constructor(opts: AiReaderVerifierOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    this.resolver = opts.resolver ?? createDefaultAiReaderResolver(this.timeoutMs);
    this.now = opts.now ?? Date.now;
    this.maxCache = Math.max(1, opts.maxCache ?? MAX_CACHE);
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? MAX_IN_FLIGHT);
    this.salt = opts.salt ?? crypto.randomBytes(16);
    this.onVerified = opts.onVerified;
    // Holds no list and fetches nothing until an ip_list entry is first checked.
    this.ipLists = new AiReaderIpLists({
      fetcher: opts.ipListFetcher,
      now: this.now,
      timeoutMs: opts.ipListTimeoutMs,
      maxBytes: opts.ipListMaxBytes,
      onEvent: opts.onIpListEvent,
    });
  }

  private keyOf(ip: string, operator: AiReaderOperator): string {
    return crypto.createHash("sha256").update(this.salt).update(operator + "|" + ip, "utf8").digest().toString("base64url", 0, 12);
  }

  /**
   * Whether (ip, entry's operator) is verified per the cache, synchronously.
   * On a miss (or expired entry) starts a background verification and answers
   * false. ip_list entries: whether the IP is in the operator's list for
   * that fetcher as loaded now (a list not loaded yet → false, and its fetch
   * starts in the background). `context` (log fields, never the IP) is
   * passed to onVerified.
   */
  isVerified(rawIp: string, entry: AiReaderEntry, context?: Readonly<Record<string, string>>): boolean {
    if (entry.method === "ip_list") return this.isListed(rawIp, entry, context);
    if (entry.method !== "fcrdns") return false;
    const n = normalizeIp(rawIp);
    if (!n) return false;
    const key = this.keyOf(n.ip, entry.operator);
    const hit = this.cache.get(key);
    const now = this.now();
    if (hit && hit.until > now) return hit.verified;
    if (hit) this.cache.delete(key);
    this.start(key, n.ip, entry, context);
    return false;
  }

  private isListed(rawIp: string, entry: AiReaderEntry, context: Readonly<Record<string, string>> | undefined): boolean {
    if (!entry.ipList) return false;
    const n = normalizeIp(rawIp);
    if (!n) return false;
    if (!this.ipLists.contains(entry.ipList, n.ip)) return false;
    // Listed. The salted-hash cache only dedups the log line here; the
    // answer always comes from the list as loaded now.
    const key = this.keyOf(n.ip, entry.operator);
    const hit = this.cache.get(key);
    if (!(hit && hit.verified && hit.until > this.now())) {
      this.put(key, { verified: true, until: this.now() + POSITIVE_TTL_MS });
      if (this.onVerified) {
        try { this.onVerified(entry, context); } catch { /* logging must never throw */ }
      }
    }
    return true;
  }

  private start(key: string, ip: string, entry: AiReaderEntry, context: Readonly<Record<string, string>> | undefined): void {
    if (this.inFlight.has(key) || this.inFlight.size >= this.maxInFlight) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // Not unref'd: it is short-lived and cleared as soon as the lookup ends.
      timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs);
    });
    const job = (async () => {
      let result: CacheEntry;
      try {
        const ok = await Promise.race([forwardConfirmedReverseDns(this.resolver, ip, entry), timeout]);
        result = { verified: ok, until: this.now() + (ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) };
      } catch {
        result = { verified: false, until: this.now() + ERROR_TTL_MS };
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.put(key, result);
      if (result.verified && this.onVerified) {
        try { this.onVerified(entry, context); } catch { /* logging must never throw */ }
      }
    })().finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, job);
  }

  private put(key: string, value: CacheEntry): void {
    this.cache.delete(key);
    while (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  /** Test-only: resolves when every running verification has finished. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
    await this.ipLists.settled();
  }

  /** Test-only: prefixes held for a list (null when none loaded). */
  ipListLoadedCount(id: AiReaderIpListId): number | null { return this.ipLists.loadedCount(id); }

  /** Cache entries / running lookups held (tests: the bounds). */
  cacheSize(): number { return this.cache.size; }
  inFlightSize(): number { return this.inFlight.size; }
}
