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
 * method "ip_list": they are listed so the UA is recognised and documented,
 * but this slice does not fetch external IP lists, so they are treated as
 * anonymous (base limit) and no DNS lookup is made for them.
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
   * documented reverse-DNS domains). ip_list: empty (not verifiable here).
   */
  domains: readonly string[];
}

/**
 * The configured AI readers. Domains per operator documentation:
 *   google     developers.google.com/search/docs/crawling-indexing/verifying-googlebot
 *              (crawlers: googlebot.com, google.com)
 *   microsoft  bing.com/webmasters/help/how-to-verify-bingbot (search.msn.com)
 *   apple      support.apple.com/119829 (applebot.apple.com)
 *   openai     platform.openai.com/docs/bots — IP lists (gptbot.json,
 *              chatgpt-user.json, searchbot.json) only
 *   anthropic  IP ranges only, no documented PTR domain
 *   perplexity docs.perplexity.ai/guides/bots — IP lists
 *              (perplexitybot.json, perplexity-user.json) only
 * Order: *-User / specific tokens before their family prefix.
 */
export const AI_READER_REGISTRY: readonly AiReaderEntry[] = [
  { token: "Googlebot", pattern: /Googlebot/, operator: "google", method: "fcrdns", domains: ["googlebot.com", "google.com"] },
  { token: "bingbot", pattern: /bingbot/i, operator: "microsoft", method: "fcrdns", domains: ["search.msn.com"] },
  { token: "Applebot", pattern: /Applebot(?!-Extended)/, operator: "apple", method: "fcrdns", domains: ["applebot.apple.com"] },
  { token: "ChatGPT-User", pattern: /ChatGPT-User/, operator: "openai", method: "ip_list", domains: [] },
  { token: "OAI-SearchBot", pattern: /OAI-SearchBot/, operator: "openai", method: "ip_list", domains: [] },
  { token: "GPTBot", pattern: /GPTBot/, operator: "openai", method: "ip_list", domains: [] },
  { token: "Claude-User", pattern: /Claude-User/, operator: "anthropic", method: "ip_list", domains: [] },
  { token: "Claude-SearchBot", pattern: /Claude-SearchBot/, operator: "anthropic", method: "ip_list", domains: [] },
  { token: "ClaudeBot", pattern: /ClaudeBot/, operator: "anthropic", method: "ip_list", domains: [] },
  { token: "Perplexity-User", pattern: /Perplexity-User/, operator: "perplexity", method: "ip_list", domains: [] },
  { token: "PerplexityBot", pattern: /PerplexityBot/, operator: "perplexity", method: "ip_list", domains: [] },
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

// ─── Cache + background verification ────────────────────────────────────

export interface AiReaderVerifierOptions {
  resolver?: AiReaderResolver;
  now?: () => number;
  timeoutMs?: number;
  maxCache?: number;
  maxInFlight?: number;
  salt?: Buffer;
  /** Called once per successful (non-cached) verification. */
  onVerified?: (entry: AiReaderEntry, context: Readonly<Record<string, string>> | undefined) => void;
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

  constructor(opts: AiReaderVerifierOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    this.resolver = opts.resolver ?? createDefaultAiReaderResolver(this.timeoutMs);
    this.now = opts.now ?? Date.now;
    this.maxCache = Math.max(1, opts.maxCache ?? MAX_CACHE);
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? MAX_IN_FLIGHT);
    this.salt = opts.salt ?? crypto.randomBytes(16);
    this.onVerified = opts.onVerified;
  }

  private keyOf(ip: string, operator: AiReaderOperator): string {
    return crypto.createHash("sha256").update(this.salt).update(operator + "|" + ip, "utf8").digest().toString("base64url", 0, 12);
  }

  /**
   * Whether (ip, entry's operator) is verified per the cache, synchronously.
   * On a miss (or expired entry) starts a background verification and answers
   * false. `context` (log fields, never the IP) is passed to onVerified.
   */
  isVerified(rawIp: string, entry: AiReaderEntry, context?: Readonly<Record<string, string>>): boolean {
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
  }

  /** Cache entries / running lookups held (tests: the bounds). */
  cacheSize(): number { return this.cache.size; }
  inFlightSize(): number { return this.inFlight.size; }
}
