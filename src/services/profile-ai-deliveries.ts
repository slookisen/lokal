/**
 * «Med i AI-svar» — counting each profile we send to an AI assistant.
 *
 * dev-request 2026-10-14-med-i-ai-svar-per-profil, S1 (rfb). One delivery =
 * one profile in what we handed an AI, per channel:
 *   ai_page_list     a list, search, category, city or front page an
 *                    ai_search client (ChatGPT-User, Claude-User,
 *                    Perplexity-User …) fetched, answered 2xx/304: every
 *                    profile actually rendered on it.
 *   ai_page_profile  the profile page itself, fetched by an ai_search client.
 *   mcp              the producers in an MCP data tool's result. Same rules
 *                    as computeAiLookups: no catalogue probes, no own traffic
 *                    (the tool only runs for a request that got through).
 *   a2a              the producers in an A2A answer the router marked
 *                    countable (res.locals.a2aCountable).
 * Crawlers, search engines, scrapers, scripts and people count nothing.
 *
 * Counting is in memory and written as daily sums (upsert per profile x day
 * x channel x AI) every minute and on shutdown, never one write per profile
 * on the request path. The same AI session fetching the same list again
 * within AI_DELIVERY_DEDUP_MS counts once per profile; the session key is a
 * hash of IP + user agent (MCP: the MCP session id) and is never stored.
 */

import crypto from "crypto";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { isOwnerRequest, isOwnerScriptUA, type VerticalId } from "./analytics-service";
import { buildRequestMeta, isInternalTraffic } from "./conversation-service";
import { aiAssistantVendor, classifyUA } from "./traffic-classifier";
import { AI_LOOKUP_PROBE_MARKERS } from "./search-stats-compute";
import { utcDay, type AiDeliveryChannel, type AiDeliveryVendor } from "./profile-ai-deliveries-compute";

export const AI_DELIVERY_DEDUP_MS = 30 * 60 * 1000;
export const AI_DELIVERY_FLUSH_MS = 60 * 1000;
/** Upper bound on remembered (session, list, profile) keys; expired ones go first. */
const MAX_DEDUP_KEYS = 200_000;

const KEY_SEP = "\t";
// vertical \t profile \t day \t channel \t vendor -> count not yet written
const pending = new Map<string, number>();
// dedup key -> epoch ms until which a repeat is not counted
const seen = new Map<string, number>();

function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
}

function pruneSeen(nowMs: number): void {
  for (const [k, until] of seen) if (until <= nowMs) seen.delete(k);
  // Still full: drop the oldest keys (Map keeps insertion order).
  for (const k of seen.keys()) {
    if (seen.size < MAX_DEDUP_KEYS * 0.9) break;
    seen.delete(k);
  }
}

export interface AiDeliveryInput {
  vertical: VerticalId;
  channel: AiDeliveryChannel;
  vendor: AiDeliveryVendor;
  profileIds: string[];
  /** In-memory identity of the AI session (hash of IP + UA, or the MCP session id). */
  sessionKey: string;
  /** What was fetched: the page URL, or the tool and its arguments. */
  listKey: string;
  nowMs?: number;
}

/** Buffers one delivery; returns how many profiles were counted (repeats in the window are not). */
export function recordAiDeliveries(input: AiDeliveryInput): number {
  const nowMs = input.nowMs ?? Date.now();
  const day = utcDay(nowMs);
  const listHash = shortHash(`${input.sessionKey}\n${input.channel}\n${input.listKey}`);
  let counted = 0;
  for (const profileId of new Set(input.profileIds.filter(Boolean))) {
    const dedupKey = `${listHash}|${profileId}`;
    const until = seen.get(dedupKey);
    if (until !== undefined && until > nowMs) continue;
    seen.delete(dedupKey); // re-inserted last, so the oldest keys stay first
    seen.set(dedupKey, nowMs + AI_DELIVERY_DEDUP_MS);
    const key = [input.vertical, profileId, day, input.channel, input.vendor].join(KEY_SEP);
    pending.set(key, (pending.get(key) ?? 0) + 1);
    counted++;
  }
  if (seen.size >= MAX_DEDUP_KEYS) pruneSeen(nowMs);
  return counted;
}

/** Writes the buffered sums (one transaction of upserts). Returns the rows written. */
export function flushAiDeliveries(db: Database.Database = getDb()): number {
  if (pending.size === 0) return 0;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    const upsert = db.prepare(`
      INSERT INTO profile_ai_deliveries (vertical_id, profile_id, day, channel, ai_vendor, count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (vertical_id, profile_id, day, channel, ai_vendor) DO UPDATE SET count = count + excluded.count
    `);
    db.transaction(() => {
      for (const [key, n] of batch) {
        const [vertical, profileId, day, channel, vendor] = key.split(KEY_SEP);
        upsert.run(vertical, profileId, day, channel, vendor, n);
      }
    })();
    return batch.length;
  } catch (err) {
    // Keep the counts for the next flush.
    for (const [key, n] of batch) pending.set(key, (pending.get(key) ?? 0) + n);
    console.error("[profile-ai-deliveries] flush failed:", err);
    return 0;
  }
}

let flushTimer: NodeJS.Timeout | null = null;

/** Starts the minute flush (index.ts). The shutdown handlers call flushAiDeliveries once more. */
export function startAiDeliveriesFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushAiDeliveries(); }, AI_DELIVERY_FLUSH_MS);
  flushTimer.unref?.();
}

/** Test-only: forget buffered counts and dedup keys. */
export function __resetAiDeliveriesForTesting(): void {
  pending.clear();
  seen.clear();
}

function userAgentOf(req: Request): string {
  const ua = req.headers?.["user-agent"];
  return typeof ua === "string" ? ua : "";
}

function sessionKeyFor(ip: string, userAgent: string): string {
  return shortHash(`${ip}\n${userAgent}`);
}

function isAiPageStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

/**
 * Pages (seo.ts): counts `profileIds` for an ai_search client once the
 * response finishes 2xx/304. Anything else (people, crawlers, search engines,
 * scrapers, scripts, our own traffic) is a no-op. Call before res.send.
 */
export function recordAiPageDelivery(
  req: Request, res: Response, channel: "ai_page_list" | "ai_page_profile", profileIds: string[], vertical: VerticalId = "rfb",
): void {
  try {
    const userAgent = userAgentOf(req);
    if (profileIds.length === 0 || classifyUA(userAgent) !== "ai_search") return;
    if (isOwnerRequest(req) || isInternalTraffic(buildRequestMeta(req))) return;
    // The page and its query, without tracking parameters (ChatGPT adds utm_source).
    const [pagePath, query] = (req.originalUrl || req.url || "").split("?");
    const params = new URLSearchParams(query || "");
    for (const k of [...params.keys()]) if (k.startsWith("utm_")) params.delete(k);
    params.sort();
    const listKey = `${pagePath}?${params.toString()}`;
    const sessionKey = sessionKeyFor(req.ip || "unknown", userAgent);
    const vendor = aiAssistantVendor(userAgent);
    const ids = [...profileIds];
    res.once("finish", () => {
      if (!isAiPageStatus(res.statusCode)) return;
      recordAiDeliveries({ vertical, channel, vendor, profileIds: ids, sessionKey, listKey });
    });
  } catch (err) {
    console.error("[profile-ai-deliveries] page delivery failed:", err);
  }
}

/** Vendor of an MCP / A2A caller from its client name and UA; 'unknown' when neither says. */
export function agentDeliveryVendor(clientName: string | null | undefined, userAgent: string | null | undefined): AiDeliveryVendor {
  const s = `${clientName || ""} ${userAgent || ""}`.toLowerCase();
  if (/chatgpt|openai/.test(s)) return "chatgpt";
  if (/claude|anthropic/.test(s)) return "claude";
  if (/perplexity/.test(s)) return "perplexity";
  return "unknown";
}

export interface McpDeliveryInput {
  vertical: VerticalId;
  tool: string;
  args: unknown;
  profileIds: string[];
  /** initialize.clientInfo.name of the MCP session, when known. */
  clientName?: string | null;
  /** Headers of the tools/call request (RequestHandlerExtra.requestInfo). */
  headers?: Record<string, string | string[] | undefined>;
  sessionId?: string;
}

/**
 * MCP data tools (mcp.ts): the producers in the tool's result. Catalogue
 * probes and monitors (AI_LOOKUP_PROBE_MARKERS on client name or UA) and our
 * own traffic (admin key, owner cookie, internal UA or client-name markers)
 * count nothing, as in computeAiLookups.
 */
export function recordMcpDelivery(input: McpDeliveryInput): number {
  try {
    const h = input.headers || {};
    const userAgent = typeof h["user-agent"] === "string" ? h["user-agent"] : "";
    const clientName = input.clientName || "";
    const lc = `${clientName}\n${userAgent}`.toLowerCase();
    if (AI_LOOKUP_PROBE_MARKERS.some((m) => lc.includes(m))) return 0;
    if (isInternalTraffic(buildRequestMeta({ headers: h })) || isOwnerScriptUA(userAgent) || isInternalTraffic({ userAgent: clientName })) return 0;
    return recordAiDeliveries({
      vertical: input.vertical,
      channel: "mcp",
      vendor: agentDeliveryVendor(clientName, userAgent),
      profileIds: input.profileIds,
      sessionKey: input.sessionId || sessionKeyFor("mcp", userAgent),
      listKey: `${input.tool}\n${JSON.stringify(input.args ?? null)}`,
    });
  } catch (err) {
    console.error("[profile-ai-deliveries] mcp delivery failed:", err);
    return 0;
  }
}

/**
 * A2A (a2a.ts): the producers in an answer the router marked countable
 * (res.locals.a2aCountable), once the response finishes below 400.
 */
export function recordA2aDelivery(
  req: Request, res: Response, profileIds: string[], listKey: string, vertical: VerticalId = "rfb",
): void {
  try {
    if (profileIds.length === 0 || res.locals?.a2aCountable !== true) return;
    const userAgent = userAgentOf(req);
    const sessionKey = sessionKeyFor(req.ip || "unknown", userAgent);
    const ids = [...profileIds];
    res.once("finish", () => {
      if (res.statusCode >= 400 || res.locals?.a2aCountable !== true) return;
      recordAiDeliveries({ vertical, channel: "a2a", vendor: agentDeliveryVendor(null, userAgent), profileIds: ids, sessionKey, listKey });
    });
  } catch (err) {
    console.error("[profile-ai-deliveries] a2a delivery failed:", err);
  }
}
