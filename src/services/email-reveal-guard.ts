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
 * Not in this slice: S-A2 (verified AI readers via reverse DNS — hook:
 * emailRevealLimitFor), S-A4 (trap address), S-D (contact form), the
 * «Vis e-post» reveal endpoint, the profile pages and the RFB/Opplevagent
 * surfaces.
 */

import crypto from "crypto";
import type { Request } from "express";
import { createStatsKey } from "../middleware/client-ip";

export type EmailRevealHost = "dental" | "rfb" | "experiences";

export const EMAIL_REVEAL_SWITCH_ENV: Readonly<Record<EmailRevealHost, string>> = {
  dental: "EMAIL_REVEAL_GUARD_DENTAL",
  rfb: "EMAIL_REVEAL_GUARD_RFB",
  experiences: "EMAIL_REVEAL_GUARD_EXPERIENCES",
};

export const EMAIL_REVEAL_LIMIT_ENV = "EMAIL_REVEAL_PER_IP_PER_HOUR";
export const EMAIL_REVEAL_DEFAULT_LIMIT = 30;
export const EMAIL_REVEAL_WINDOW_MS = 60 * 60_000;
/** Clients kept per host before the least recently seen is evicted. */
export const EMAIL_REVEAL_MAX_CLIENTS = 20_000;
const MAX_PROFILE_ID_LEN = 64;
const LOGGED_IDS = 5;

type Env = Record<string, string | undefined>;

/** Whether the guard is on for `host` (default off). */
export function emailRevealGuardEnabled(host: EmailRevealHost, env: Env = process.env): boolean {
  const raw = (env[EMAIL_REVEAL_SWITCH_ENV[host]] ?? "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

/** EMAIL_REVEAL_PER_IP_PER_HOUR as a whole number ≥ 0; anything else → the default (30). */
export function emailRevealBaseLimit(env: Env = process.env): number {
  const raw = (env[EMAIL_REVEAL_LIMIT_ENV] ?? "").trim();
  if (!/^\d{1,6}$/.test(raw)) return EMAIL_REVEAL_DEFAULT_LIMIT;
  return Number(raw);
}

/** Whether a User-Agent is Common Crawl's (S-A3): «CCBot» anywhere, any case. */
export function isCcBotUserAgent(ua: string | undefined | null): boolean {
  return typeof ua === "string" && /ccbot/i.test(ua);
}

/**
 * The per-hour limit for this request. S-A2 plugs in here: a known AI reader
 * whose origin is verified (reverse DNS or the operator's published ranges)
 * gets a higher limit. Not built in slice 1, so every client gets the base
 * limit.
 */
export function emailRevealLimitFor(_req: Request, _host: EmailRevealHost, baseLimit: number): number {
  return baseLimit;
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

let store = new EmailRevealStore();
let logLine: (line: string) => void = (line) => console.log(line);

/**
 * The ids in `profileIds` (each a profile that HAS an e-mail in this answer)
 * that this request may get the e-mail for. null when the switch for `host`
 * is off: the caller then changes nothing.
 */
export function revealEmailFor(req: Request, host: EmailRevealHost, profileIds: readonly string[]): ReadonlySet<string> | null {
  if (!emailRevealGuardEnabled(host)) return null;
  if (profileIds.length === 0) return new Set();
  const ua = typeof req.headers?.["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  let reason: "ccbot" | "no_ip" | "limit";
  let allowed: Set<string>;
  let client: string | undefined;
  if (isCcBotUserAgent(ua)) {
    reason = "ccbot";
    allowed = new Set();
  } else if (typeof req.ip !== "string" || req.ip.trim() === "") {
    reason = "no_ip";
    allowed = new Set();
  } else {
    reason = "limit";
    const key = store.clientKey(req.ip);
    client = Buffer.from(key, "base64url").toString("hex", 0, 6);
    allowed = store.reveal(host, key, profileIds, emailRevealLimitFor(req, host, emailRevealBaseLimit()));
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

/** Test-only: a fresh store (optionally with an injected clock) and log sink. */
export function __resetEmailRevealGuardForTesting(opts: EmailRevealStoreOptions & { log?: (line: string) => void } = {}): void {
  store = new EmailRevealStore(opts);
  logLine = opts.log ?? ((line) => console.log(line));
}
