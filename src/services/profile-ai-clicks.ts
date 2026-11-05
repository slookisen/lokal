/**
 * «Klikk fra AI-svar» — counting people who come to a profile from an AI answer.
 *
 * dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 2 (storage only;
 * no display, no link marking, no beacon). One click = a person (classifyUA
 * 'human') opening a profile page (rfb producer, dental clinic, experiences
 * provider / experience) that answered 2xx or 304, not our own or internal
 * traffic, where classifyAiClickSource (human-referrals.ts, slice 1) names an
 * AI from the referrer or our utm marks. AI fetchers (ChatGPT-User …),
 * crawlers, search engines and scripts count nothing here.
 *
 * Same buffering as profile-ai-deliveries.ts: counted in memory, written as
 * daily sums (upsert per vertical x profile x day x AI) every minute and on
 * shutdown, never a write on the request path. The same visitor on the same
 * profile counts once per AI_CLICK_DEDUP_MS; the visitor key is a hash of IP +
 * user agent + vertical + profile, kept in memory only and never stored.
 */

import crypto from "crypto";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { isOwnerRequest, type VerticalId } from "./analytics-service";
import { buildRequestMeta, isInternalTraffic } from "./conversation-service";
import { classifyUA } from "./traffic-classifier";
import { classifyAiClickSource } from "./human-referrals";
import { utcDay, type AiClickVendor } from "./profile-ai-clicks-compute";

export const AI_CLICK_DEDUP_MS = 30 * 60 * 1000;
export const AI_CLICK_FLUSH_MS = 60 * 1000;
/** Upper bound on remembered visitor keys; expired ones go first. */
const MAX_DEDUP_KEYS = 200_000;

const KEY_SEP = "\t";
// vertical \t profile \t day \t vendor -> count not yet written
const pending = new Map<string, number>();
// visitor key -> epoch ms until which a repeat is not counted
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

export interface AiClickInput {
  vertical: VerticalId;
  profileId: string;
  vendor: AiClickVendor;
  /** In-memory identity of the visitor (IP + UA); hashed with vertical + profile, never stored. */
  ip: string;
  userAgent: string;
  nowMs?: number;
}

/** Buffers one click; returns 1 when counted, 0 for a repeat inside the window. */
export function recordAiClick(input: AiClickInput): number {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.profileId) return 0;
  const dedupKey = shortHash([input.ip, input.userAgent, input.vertical, input.profileId].join("\n"));
  const until = seen.get(dedupKey);
  if (until !== undefined && until > nowMs) return 0;
  seen.delete(dedupKey); // re-inserted last, so the oldest keys stay first
  seen.set(dedupKey, nowMs + AI_CLICK_DEDUP_MS);
  const key = [input.vertical, input.profileId, utcDay(nowMs), input.vendor].join(KEY_SEP);
  pending.set(key, (pending.get(key) ?? 0) + 1);
  if (seen.size >= MAX_DEDUP_KEYS) pruneSeen(nowMs);
  return 1;
}

/** Writes the buffered sums (one transaction of upserts). Returns the rows written. */
export function flushAiClicks(db: Database.Database = getDb()): number {
  if (pending.size === 0) return 0;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    const upsert = db.prepare(`
      INSERT INTO profile_ai_clicks (vertical_id, profile_id, day, ai_vendor, count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (vertical_id, profile_id, day, ai_vendor) DO UPDATE SET count = count + excluded.count
    `);
    db.transaction(() => {
      for (const [key, n] of batch) {
        const [vertical, profileId, day, vendor] = key.split(KEY_SEP);
        upsert.run(vertical, profileId, day, vendor, n);
      }
    })();
    return batch.length;
  } catch (err) {
    // Keep the counts for the next flush.
    for (const [key, n] of batch) pending.set(key, (pending.get(key) ?? 0) + n);
    console.error("[profile-ai-clicks] flush failed:", err);
    return 0;
  }
}

let flushTimer: NodeJS.Timeout | null = null;

/** Starts the minute flush (index.ts). The shutdown handlers call flushAiClicks once more. */
export function startAiClicksFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushAiClicks(); }, AI_CLICK_FLUSH_MS);
  flushTimer.unref?.();
}

/** Test-only: forget buffered counts and visitor keys. */
export function __resetAiClicksForTesting(): void {
  pending.clear();
  seen.clear();
}

function isCountedStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304;
}

type QueryValue = string | string[] | null | undefined;

function queryValue(v: unknown): QueryValue {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return undefined;
}

/**
 * Profile pages: counts a person who came from an AI answer once the response
 * finishes 2xx/304. Anything else (AI fetchers, crawlers, search engines,
 * scripts, our own traffic, a click not from an AI) is a no-op. Never throws.
 * Call before res.send.
 */
export function recordAiProfileClick(req: Request, res: Response, profileId: string, vertical: VerticalId = "rfb"): void {
  try {
    if (!profileId) return;
    const ua = req.headers?.["user-agent"];
    const userAgent = typeof ua === "string" ? ua : "";
    if (classifyUA(userAgent) !== "human") return;
    if (isOwnerRequest(req) || isInternalTraffic(buildRequestMeta(req))) return;
    const referer = typeof req.get === "function" ? req.get("referer") : undefined;
    const q = (req.query || {}) as Record<string, unknown>;
    const vendor = classifyAiClickSource({
      referrer: referer ?? null,
      utm_source: queryValue(q.utm_source),
      utm_campaign: queryValue(q.utm_campaign),
    });
    if (!vendor) return;
    const ip = req.ip || "unknown";
    const id = String(profileId);
    res.once("finish", () => {
      try {
        if (!isCountedStatus(res.statusCode)) return;
        recordAiClick({ vertical, profileId: id, vendor, ip, userAgent });
      } catch (err) {
        console.error("[profile-ai-clicks] click failed:", err);
      }
    });
  } catch (err) {
    console.error("[profile-ai-clicks] click failed:", err);
  }
}
