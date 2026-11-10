/**
 * email-reveal-guard.ts — dev-request
 * 2026-09-09-epost-eksponering-skjerming-mot-masseinnhosting, slice 1
 * (S-A1 limit per IP, S-A3 CCBot, S-A5 shared counter; Daniel 2026-10-19,
 * spm. 22 and 27).
 *
 * No client may collect the e-mail addresses of many profiles in one go,
 * while a human (or an AI reader) looking at one profile at a time still
 * gets the address. Each client IP gets e-mail for at most
 * EMAIL_REVEAL_PER_IP_PER_HOUR (default 30) distinct profiles per sliding
 * hour, per host. Over the limit the caller leaves the e-mail out exactly as
 * for a profile that has none (no new field). A User-Agent with «CCBot» in
 * it never gets e-mail (S-A3): matching on the User-Agent is enough, because
 * the rule only hides.
 *
 * Switch per host, default OFF: EMAIL_REVEAL_GUARD_DENTAL,
 * EMAIL_REVEAL_GUARD_RFB, EMAIL_REVEAL_GUARD_EXPERIENCES ("on", "1" or
 * "true", any case). Read per call, so `fly secrets set …` (a restart) flips
 * it. Off → revealEmailFor returns null and the caller changes nothing: every
 * answer is byte-identical to main. Slice 1 wires only dental (REST
 * /api/tannlege/agents[/:id] and A2A message/send).
 *
 * One counter per host and client, shared by every surface of that host
 * (pages and APIs alike in later slices), so a client does not get the limit
 * once per surface. A repeat view of a profile already counted in the window
 * is free. In a list each profile with an e-mail counts on its own; once the
 * limit is reached the rest of that list gets no e-mail.
 *
 * Client IP: `req.ip`, the app's one trusted source (middleware/client-ip.ts
 * — Fly-Client-IP in enforce mode; that file pins that nothing else reads
 * X-Forwarded-For or Fly-Client-IP). Until client-ip runs in enforce mode,
 * req.ip is the left-most X-Forwarded-For entry, which a client can set, so
 * the limit is only as strong as client-ip's mode; it needs no change here
 * when that mode flips. No usable req.ip (empty) → fail closed: no e-mail for
 * that request, and it is logged with reason "no_ip". Off Fly and in tests
 * Express always has a socket address, so this branch only guards a broken
 * proxy chain.
 *
 * Store: in memory, per process. **The counter is per instance**: with N
 * machines a client whose requests are spread across them can get up to
 * limit × N profiles per hour (the dev-request allows this when documented).
 * Keys are salted hashes of the ipKeyGenerator-normalized IP (createStatsKey
 * from client-ip.ts, random salt per process; IPv6 grouped per /56 as the
 * rate limiters do), never the raw IP. Memory is bounded: at most
 * MAX_CLIENTS clients per host (expired ones pruned first, else the least
 * recently seen is evicted — that resets its count, which only a client
 * already rotating many IPs could exploit), and per client only the ids it
 * was given e-mail for (≤ limit), each cut to MAX_PROFILE_ID_LEN chars.
 *
 * Logs: one JSON line when a request has e-mail withheld, with the host, the
 * reason, the counts and at most five profile ids. Never an e-mail address,
 * never an IP.
 *
 * Slice 2 wires the finn-tannlege.com clinic profile pages (/klinikk/:slug,
 * /klinikk/id/:id: mailto: line and JSON-LD `email`) and their «Vis e-post»
 * endpoint GET /klinikk/id/:id/epost (routes/dental-seo.ts) to the same
 * dental counter.
 *
 * Slice 3 wires the rettfrabonden.com producer profile page /produsent/:slug
 * (mailto: line on the producer and umbrella contact card, JSON-LD `email`)
 * and its «Vis e-post» endpoint GET /produsent/:slug/epost (routes/seo.ts)
 * to the rfb counter, which the RFB REST/A2A/MCP answers of S-A5 will share.
 *
 * Slice 4 wires the opplevagent.no gårdssalg producer profile page
 * /kategori/gardssalg/produsent/:providerSlug («E-post» fact row mailto: and
 * JSON-LD `email`, on top of the AC4 under-review gate) and its «Vis e-post»
 * endpoint GET /kategori/gardssalg/produsent/:providerSlug/epost
 * (routes/experiences-seo.ts) to the experiences counter. The Opplevagent
 * MCP/REST/A2A answers give no producer e-mail (S-A0), so nothing else there.
 *
 * Slice 6 (S-A5, RFB REST + A2A) wires the rettfrabonden.com API answers to
 * the same rfb counter via emailWithheldIds: GET /api/marketplace/agents/:id
 * /card, /info and /vcard, the contact blocks of POST /discover and GET
 * /search, contact_handoffs of POST /cart/:id/submit (routes/marketplace.ts,
 * routes/marketplace-cart.ts), and the A2A per-producer card (x-knowledge) and
 * agent/info (routes/a2a.ts). The RFB MCP answers are not wired yet.
 *
 * S-A2 (verified AI readers): emailRevealLimitFor gives a known AI reader /
 * search fetcher whose origin is verified (forward-confirmed reverse DNS for
 * Google / Bing / Apple, the operator's published IP list for OpenAI,
 * Anthropic and Perplexity) the higher EMAIL_REVEAL_AI_READER_PER_HOUR
 * (default 300) instead of the base limit. The User-Agent only picks the operator to verify against; it
 * never raises the limit by itself. Registry, accepted domains per operator
 * the IP-list sources and the cache: services/email-reveal-ai-readers.ts.
 * Never blocks on DNS or on a list fetch: a cache miss (or a list not loaded
 * yet) gets the base limit for that request and starts one background
 * lookup / fetch; later requests use the result. Counting is unchanged (same store, key and window);
 * only the limit differs. CCBot (S-A3) is checked first and never gets
 * e-mail. Switch off for the host → nothing of this runs (no DNS lookup, no
 * list fetch). One log line `email_reveal_ai_reader_verified` (operator,
 * host, hashed client — never the IP) per successful verification, and one
 * `email_reveal_ai_reader_ip_list` (list id, outcome, prefix count or failure
 * reason — never an IP) per list fetch.
 *
 * Both limits are capped at EMAIL_REVEAL_MAX_LIMIT (1000): a larger whole
 * number is cut to the cap (per-client memory grows with the limit).
 *
 * S-A4 (trap address): a client that fetches the trap path (served by
 * services/email-reveal-trap.ts on all three hosts, disallowed for every
 * robot in robots.txt) is recorded here with recordEmailRevealTrapHit and
 * gets NO e-mail for EMAIL_REVEAL_TRAP_BLOCK_MS (24 h) on that host:
 * revealEmailFor withholds every id exactly as over the limit (reason
 * "trap_blocked" in the log line), so every surface already wired to
 * revealEmailFor / emailWithheldIds honours the block with no change of its
 * own. Pages render as normal otherwise (shared IPs are not locked out). The
 * block is keyed like the counter (same salted hash, IPv6 per /56), per host,
 * per process (with N machines a client is blocked only on the machine that
 * served its trap hit), at most EMAIL_REVEAL_TRAP_MAX_BLOCKED keys per host
 * (expired ones pruned first, else the oldest block is dropped). Nobody is
 * exempt — verified AI readers included: a hit means robots.txt was ignored.
 * Switch off for the host → nothing is recorded and nothing changes.
 *
 * Not yet: S-D (contact form) and the RFB MCP answers (S-A5).
 */

import crypto from "crypto";
import type { Request, Response } from "express";
import { createStatsKey } from "../middleware/client-ip";
import { AiReaderVerifier, aiReaderEntryOf, type AiReaderVerifierOptions } from "./email-reveal-ai-readers";

export type EmailRevealHost = "dental" | "rfb" | "experiences";

export const EMAIL_REVEAL_SWITCH_ENV: Readonly<Record<EmailRevealHost, string>> = {
  dental: "EMAIL_REVEAL_GUARD_DENTAL",
  rfb: "EMAIL_REVEAL_GUARD_RFB",
  experiences: "EMAIL_REVEAL_GUARD_EXPERIENCES",
};

export const EMAIL_REVEAL_LIMIT_ENV = "EMAIL_REVEAL_PER_IP_PER_HOUR";
export const EMAIL_REVEAL_DEFAULT_LIMIT = 30;
export const EMAIL_REVEAL_AI_READER_LIMIT_ENV = "EMAIL_REVEAL_AI_READER_PER_HOUR";
export const EMAIL_REVEAL_AI_READER_DEFAULT_LIMIT = 300;
/** Upper bound for both limits (a larger configured value is cut to this). */
export const EMAIL_REVEAL_MAX_LIMIT = 1000;
export const EMAIL_REVEAL_WINDOW_MS = 60 * 60_000;
/** Clients kept per host before the least recently seen is evicted. */
export const EMAIL_REVEAL_MAX_CLIENTS = 20_000;
/** S-A4: how long a trap hit withholds e-mail from that client (24 h). */
export const EMAIL_REVEAL_TRAP_BLOCK_MS = 24 * 60 * 60_000;
/** S-A4: blocked clients kept per host before the oldest block is dropped. */
export const EMAIL_REVEAL_TRAP_MAX_BLOCKED = 20_000;
const MAX_PROFILE_ID_LEN = 64;
const LOGGED_IDS = 5;

type Env = Record<string, string | undefined>;

/** Whether the guard is on for `host` (default off). */
export function emailRevealGuardEnabled(host: EmailRevealHost, env: Env = process.env): boolean {
  const raw = (env[EMAIL_REVEAL_SWITCH_ENV[host]] ?? "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

/** A whole number ≥ 0 (at most six digits), cut to EMAIL_REVEAL_MAX_LIMIT; anything else → `fallback`. */
function parseLimit(raw: string | undefined, fallback: number): number {
  const v = (raw ?? "").trim();
  if (!/^\d{1,6}$/.test(v)) return fallback;
  return Math.min(Number(v), EMAIL_REVEAL_MAX_LIMIT);
}

/** EMAIL_REVEAL_PER_IP_PER_HOUR as a whole number ≥ 0, at most 1000; anything else → the default (30). */
export function emailRevealBaseLimit(env: Env = process.env): number {
  return parseLimit(env[EMAIL_REVEAL_LIMIT_ENV], EMAIL_REVEAL_DEFAULT_LIMIT);
}

/** EMAIL_REVEAL_AI_READER_PER_HOUR as a whole number ≥ 0, at most 1000; anything else → the default (300). */
export function emailRevealAiReaderLimit(env: Env = process.env): number {
  return parseLimit(env[EMAIL_REVEAL_AI_READER_LIMIT_ENV], EMAIL_REVEAL_AI_READER_DEFAULT_LIMIT);
}

/** Whether a User-Agent is Common Crawl's (S-A3): «CCBot» anywhere, any case. */
export function isCcBotUserAgent(ua: string | undefined | null): boolean {
  return typeof ua === "string" && /ccbot/i.test(ua);
}

let aiReaders: AiReaderVerifier | null = null;
let aiReaderOpts: AiReaderVerifierOptions = {};
let logLine: (line: string) => void = (line) => console.log(line);

/** Created on first use, so nothing (not even a resolver) exists while every switch is off. */
function aiReaderVerifier(): AiReaderVerifier {
  if (!aiReaders) {
    aiReaders = new AiReaderVerifier({
      ...aiReaderOpts,
      onVerified: (entry, context) => {
        logLine(JSON.stringify({ evt: "email_reveal_ai_reader_verified", operator: entry.operator, token: entry.token, ...context }));
      },
      onIpListEvent: (event) => {
        logLine(JSON.stringify({ evt: "email_reveal_ai_reader_ip_list", ...event }));
      },
    });
  }
  return aiReaders;
}

/**
 * The per-hour limit for this request (S-A2). A User-Agent from the AI-reader
 * registry whose IP is verified (forward-confirmed reverse DNS, cached; or in
 * the operator's published IP list for that fetcher) gets
 * max(baseLimit, EMAIL_REVEAL_AI_READER_PER_HOUR); everyone else — unknown
 * UA, a cache miss (verification then starts in the background), a list not
 * loaded yet, an IP outside the list, a failed or timed-out lookup — gets
 * baseLimit. Synchronous; never waits for DNS or a list fetch. CCBot is never raised (and revealEmailFor
 * checks it before calling this). `client` is the hashed client id for the
 * verification log line.
 */
export function emailRevealLimitFor(req: Request, host: EmailRevealHost, baseLimit: number, client?: string): number {
  const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  if (isCcBotUserAgent(ua)) return baseLimit;
  const entry = aiReaderEntryOf(ua);
  if (!entry || (entry.method === "ip_list" && !entry.ipList)) return baseLimit;
  const aiLimit = emailRevealAiReaderLimit();
  if (aiLimit <= baseLimit) return baseLimit; // nothing to gain: no lookup
  if (typeof req.ip !== "string" || req.ip.trim() === "") return baseLimit;
  const context: Record<string, string> = client ? { host, client } : { host };
  return aiReaderVerifier().isVerified(req.ip, entry, context) ? aiLimit : baseLimit;
}

// ─── Store ──────────────────────────────────────────────────────────────

export interface EmailRevealStoreOptions {
  now?: () => number;
  windowMs?: number;
  maxClients?: number;
  salt?: Buffer;
}

interface ClientEntry {
  /** profile id → when it was first given e-mail in the current window. */
  revealed: Map<string, number>;
}

export class EmailRevealStore {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxClients: number;
  private readonly keyOf: (ip: string) => string;
  private readonly hosts = new Map<EmailRevealHost, Map<string, ClientEntry>>();
  private lastSweep = 0;

  constructor(opts: EmailRevealStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? EMAIL_REVEAL_WINDOW_MS;
    this.maxClients = Math.max(1, opts.maxClients ?? EMAIL_REVEAL_MAX_CLIENTS);
    this.keyOf = createStatsKey(opts.salt ?? crypto.randomBytes(16));
  }

  /** The hashed client key for an IP (exported for the log line and tests). */
  clientKey(ip: string): string {
    return this.keyOf(ip);
  }

  /**
   * Which of `profileIds` (in order; duplicates count once) this client may
   * get e-mail for, counting the new ones against `limit`. Ids already given
   * in the window are always allowed and cost nothing.
   */
  reveal(host: EmailRevealHost, clientKey: string, profileIds: readonly string[], limit: number): Set<string> {
    const now = this.now();
    const clients = this.clientsOf(host);
    this.sweep(now);
    let entry = clients.get(clientKey);
    if (entry) {
      clients.delete(clientKey); // re-insert below: Map order = least recently seen first
      for (const [id, at] of entry.revealed) if (now - at >= this.windowMs) entry.revealed.delete(id);
    } else {
      entry = { revealed: new Map() };
      while (clients.size >= this.maxClients) {
        const oldest = clients.keys().next().value as string;
        clients.delete(oldest);
      }
    }
    const allowed = new Set<string>();
    for (const rawId of profileIds) {
      const id = rawId.slice(0, MAX_PROFILE_ID_LEN);
      if (entry.revealed.has(id)) { allowed.add(rawId); continue; }
      if (entry.revealed.size >= limit) continue;
      entry.revealed.set(id, now);
      allowed.add(rawId);
    }
    if (entry.revealed.size > 0) clients.set(clientKey, entry);
    return allowed;
  }

  /** Clients held for a host (tests: the memory bound). */
  size(host: EmailRevealHost): number {
    return this.hosts.get(host)?.size ?? 0;
  }

  private clientsOf(host: EmailRevealHost): Map<string, ClientEntry> {
    let clients = this.hosts.get(host);
    if (!clients) { clients = new Map(); this.hosts.set(host, clients); }
    return clients;
  }

  /** Drops every client whose last id has left the window; at most once a minute. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const clients of this.hosts.values()) {
      for (const [key, entry] of clients) {
        let live = false;
        for (const at of entry.revealed.values()) if (now - at < this.windowMs) { live = true; break; }
        if (!live) clients.delete(key);
      }
    }
  }
}

// ─── Trap blocks (S-A4) ─────────────────────────────────────────────────

export interface EmailRevealTrapStoreOptions {
  now?: () => number;
  blockMs?: number;
  maxBlocked?: number;
}

/**
 * Clients blocked by a trap hit, per host: hashed client key → when the
 * block ends. In memory, per process, bounded by maxBlocked per host.
 */
export class EmailRevealTrapStore {
  private readonly now: () => number;
  private readonly blockMs: number;
  private readonly maxBlocked: number;
  private readonly hosts = new Map<EmailRevealHost, Map<string, number>>();
  private lastSweep = 0;

  constructor(opts: EmailRevealTrapStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.blockMs = opts.blockMs ?? EMAIL_REVEAL_TRAP_BLOCK_MS;
    this.maxBlocked = Math.max(1, opts.maxBlocked ?? EMAIL_REVEAL_TRAP_MAX_BLOCKED);
  }

  /** Blocks `clientKey` on `host` from now for blockMs (a new hit renews it). Returns whether it was already blocked. */
  block(host: EmailRevealHost, clientKey: string): boolean {
    const now = this.now();
    const blocked = this.blockedOf(host);
    this.sweep(now);
    const until = blocked.get(clientKey);
    const wasBlocked = until !== undefined && until > now;
    blocked.delete(clientKey); // re-insert below: Map order = oldest block first
    if (blocked.size >= this.maxBlocked) {
      for (const [key, end] of blocked) if (end <= now) blocked.delete(key);
      while (blocked.size >= this.maxBlocked) blocked.delete(blocked.keys().next().value as string);
    }
    blocked.set(clientKey, now + this.blockMs);
    return wasBlocked;
  }

  /** Whether `clientKey` is blocked on `host` right now. */
  isBlocked(host: EmailRevealHost, clientKey: string): boolean {
    const blocked = this.hosts.get(host);
    const until = blocked?.get(clientKey);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    blocked!.delete(clientKey);
    return false;
  }

  /** Blocked clients held for a host (tests: the memory bound). */
  size(host: EmailRevealHost): number {
    return this.hosts.get(host)?.size ?? 0;
  }

  private blockedOf(host: EmailRevealHost): Map<string, number> {
    let blocked = this.hosts.get(host);
    if (!blocked) { blocked = new Map(); this.hosts.set(host, blocked); }
    return blocked;
  }

  /** Drops every expired block; at most once a minute. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const blocked of this.hosts.values()) {
      for (const [key, end] of blocked) if (end <= now) blocked.delete(key);
    }
  }
}

let store = new EmailRevealStore();
let trapStore = new EmailRevealTrapStore();

/** The short hashed client id used in log lines (never the IP). */
function logClientId(key: string): string {
  return Buffer.from(key, "base64url").toString("hex", 0, 6);
}

/**
 * S-A4: records a hit on the trap path for this request's client on `host`.
 * "off" = the switch for `host` is off (nothing recorded, no log); "no_ip" =
 * no usable req.ip (nothing recorded); "blocked" = blocked for 24 h from now
 * ("renewed" when it already was). One JSON log line per recorded hit, with
 * the host and the hashed client id — never the IP.
 */
export function recordEmailRevealTrapHit(req: Request, host: EmailRevealHost): "off" | "no_ip" | "blocked" | "renewed" {
  if (!emailRevealGuardEnabled(host)) return "off";
  if (typeof req.ip !== "string" || req.ip.trim() === "") return "no_ip";
  const key = store.clientKey(req.ip);
  const renewed = trapStore.block(host, key);
  logLine(JSON.stringify({ evt: "email_reveal_trap_hit", host, reason: "trap_hit", client: logClientId(key), renewed }));
  return renewed ? "renewed" : "blocked";
}

/**
 * The ids in `profileIds` (each a profile that HAS an e-mail in this answer)
 * that this request may get the e-mail for. null when the switch for `host`
 * is off: the caller then changes nothing.
 */
export function revealEmailFor(req: Request, host: EmailRevealHost, profileIds: readonly string[]): ReadonlySet<string> | null {
  if (!emailRevealGuardEnabled(host)) return null;
  if (profileIds.length === 0) return new Set();
  const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  let reason: "ccbot" | "no_ip" | "trap_blocked" | "limit";
  let allowed: Set<string>;
  let client: string | undefined;
  if (isCcBotUserAgent(ua)) {
    reason = "ccbot";
    allowed = new Set();
  } else if (typeof req.ip !== "string" || req.ip.trim() === "") {
    reason = "no_ip";
    allowed = new Set();
  } else {
    const key = store.clientKey(req.ip);
    client = logClientId(key);
    if (trapStore.isBlocked(host, key)) {
      // S-A4: a trap hit within the last 24 h → no e-mail, as over the limit.
      reason = "trap_blocked";
      allowed = new Set();
    } else {
      reason = "limit";
      allowed = store.reveal(host, key, profileIds, emailRevealLimitFor(req, host, emailRevealBaseLimit(), client));
    }
  }
  const withheld = profileIds.filter((id) => !allowed.has(id));
  if (withheld.length > 0) {
    logLine(JSON.stringify({
      evt: "email_reveal_withheld",
      host,
      reason,
      ...(client ? { client } : {}),
      revealed: profileIds.length - withheld.length,
      withheld: withheld.length,
      profile_ids: withheld.slice(0, LOGGED_IDS),
    }));
  }
  return allowed;
}

/**
 * For an API answer: the ids among `idsWithEmail` (each a profile that HAS an
 * e-mail in this answer) whose e-mail this request may NOT get. null when the
 * switch for `host` is off: the caller then changes nothing (headers
 * included). With the switch on the answer depends on the client, so it is
 * Cache-Control: private — also when `idsWithEmail` is empty.
 */
export function emailWithheldIds(req: Request, res: Response, host: EmailRevealHost, idsWithEmail: readonly string[]): ReadonlySet<string> | null {
  if (!emailRevealGuardEnabled(host)) return null;
  res.set("Cache-Control", "private");
  const allowed = revealEmailFor(req, host, idsWithEmail);
  if (allowed === null) return null;
  return new Set(idsWithEmail.filter((id) => !allowed.has(id)));
}

/**
 * An RFB getAgentInfo()-shaped answer with knowledge.email null: what a
 * producer with no stored e-mail reads (agent_knowledge.email NULL), so the
 * shape is unchanged (S-A5, REST /info and A2A agent/info).
 */
export function withKnowledgeEmailNull<T extends { knowledge: { email?: string | null } }>(info: T): T {
  return { ...info, knowledge: { ...info.knowledge, email: null } };
}

/**
 * Test-only: a fresh store and trap store (optionally with an injected clock;
 * `trap` sets the trap store's bounds) and log sink,
 * and a fresh AI-reader verifier (S-A2) with `aiReaders` options (injected
 * resolver, IP-list fetcher, clock, timeout, bounds). Without
 * `aiReaders.resolver` / `aiReaders.ipListFetcher` the real DNS resolver /
 * global fetch would be used, so tests that reach a verification pass them.
 */
export function __resetEmailRevealGuardForTesting(
  opts: EmailRevealStoreOptions & { log?: (line: string) => void; aiReaders?: Omit<AiReaderVerifierOptions, "onVerified" | "onIpListEvent">; trap?: Omit<EmailRevealTrapStoreOptions, "now"> } = {}
): void {
  store = new EmailRevealStore(opts);
  trapStore = new EmailRevealTrapStore({ ...(opts.trap ?? {}), ...(opts.now ? { now: opts.now } : {}) });
  logLine = opts.log ?? ((line) => console.log(line));
  aiReaders = null;
  aiReaderOpts = opts.aiReaders ?? {};
}

/** Test-only: resolves when every background AI-reader verification has finished. */
export async function __emailRevealAiReadersSettledForTesting(): Promise<void> {
  if (aiReaders) await aiReaders.settled();
}
