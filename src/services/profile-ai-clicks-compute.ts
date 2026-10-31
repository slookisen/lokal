// ─── «Klikk fra AI-svar»: reads over profile_ai_clicks ──────────────────────
// dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 2 (storage). How
// many people came to a profile page from an AI assistant's answer (ChatGPT,
// Claude …), per UTC day and AI. The rows are written in batches by
// profile-ai-clicks.ts. Pure: no database/init import, so it can run in the
// stats workers. No route or UI reads it yet (later display slices).

import type Database from "better-sqlite3";

type Db = Database.Database;

export const AI_CLICK_VENDORS = ["chatgpt", "claude", "perplexity", "gemini", "copilot", "other"] as const;
export type AiClickVendor = (typeof AI_CLICK_VENDORS)[number];

/** Window of the later display (days, today included). */
export const AI_CLICK_WINDOW_DAYS = 60;

export interface AiClickSums {
  total: number;
  byVendor: Record<AiClickVendor, number>;
}

export interface ProfileAiClicks {
  last60d: AiClickSums;
  allTime: AiClickSums;
  /** First stored day ('YYYY-MM-DD', UTC) for the profile, or null when nothing is stored. */
  countingSince: string | null;
}

export interface AiClickTopProfile {
  profileId: string;
  total: number;
}

export interface PlatformAiClicks {
  last60d: AiClickSums;
  allTime: AiClickSums;
  /** First stored day for the vertical, or null. */
  countingSince: string | null;
  /** The profiles with the most clicks in the last 60 days. */
  topProfiles60d: AiClickTopProfile[];
}

/** UTC day 'YYYY-MM-DD' of an epoch-ms instant (the table's `day`). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyAiClickSums(): AiClickSums {
  return { total: 0, byVendor: { chatgpt: 0, claude: 0, perplexity: 0, gemini: 0, copilot: 0, other: 0 } };
}

function tableExists(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_ai_clicks'").get();
}

/** First day of a window of `windowDays` days ending today (UTC). */
function windowStart(windowDays: number, nowMs: number): string {
  return utcDay(nowMs - (windowDays - 1) * 24 * 60 * 60 * 1000);
}

function sums(db: Db, vertical: string, profileId: string | undefined, sinceDay: string | null): AiClickSums {
  const out = emptyAiClickSums();
  const where = ["vertical_id = ?"];
  const params: string[] = [vertical];
  if (profileId !== undefined) { where.push("profile_id = ?"); params.push(profileId); }
  if (sinceDay !== null) { where.push("day >= ?"); params.push(sinceDay); }
  const rows = db.prepare(`
    SELECT ai_vendor, SUM(count) AS n FROM profile_ai_clicks
    WHERE ${where.join(" AND ")}
    GROUP BY ai_vendor
  `).all(...params) as Array<{ ai_vendor: string; n: number }>;
  for (const r of rows) {
    const vendor = (AI_CLICK_VENDORS as readonly string[]).includes(r.ai_vendor) ? r.ai_vendor as AiClickVendor : "other";
    out.byVendor[vendor] += r.n;
    out.total += r.n;
  }
  return out;
}

function firstStoredDay(db: Db, vertical: string, profileId: string | undefined): string | null {
  const params: string[] = [vertical];
  let sql = "SELECT MIN(day) AS d FROM profile_ai_clicks WHERE vertical_id = ?";
  if (profileId !== undefined) { sql += " AND profile_id = ?"; params.push(profileId); }
  const row = db.prepare(sql).get(...params) as { d: string | null } | undefined;
  return row?.d ?? null;
}

/** Clicks from AI answers to one profile: last 60 days, all time, and the first stored day. */
export function getProfileAiClicks(db: Db, vertical: string, profileId: string, nowMs: number): ProfileAiClicks {
  if (!tableExists(db)) return { last60d: emptyAiClickSums(), allTime: emptyAiClickSums(), countingSince: null };
  return {
    last60d: sums(db, vertical, profileId, windowStart(AI_CLICK_WINDOW_DAYS, nowMs)),
    allTime: sums(db, vertical, profileId, null),
    countingSince: firstStoredDay(db, vertical, profileId),
  };
}

/** Clicks from AI answers to a whole vertical, plus the top `limit` profiles of the last 60 days. */
export function getPlatformAiClicks(db: Db, vertical: string, nowMs: number, limit = 10): PlatformAiClicks {
  if (!tableExists(db)) return { last60d: emptyAiClickSums(), allTime: emptyAiClickSums(), countingSince: null, topProfiles60d: [] };
  const since = windowStart(AI_CLICK_WINDOW_DAYS, nowMs);
  const topProfiles60d = db.prepare(`
    SELECT profile_id AS profileId, SUM(count) AS total FROM profile_ai_clicks
    WHERE vertical_id = ? AND day >= ?
    GROUP BY profile_id
    ORDER BY total DESC, profile_id
    LIMIT ?
  `).all(vertical, since, Math.max(0, Math.floor(limit))) as AiClickTopProfile[];
  return {
    last60d: sums(db, vertical, undefined, since),
    allTime: sums(db, vertical, undefined, null),
    countingSince: firstStoredDay(db, vertical, undefined),
    topProfiles60d,
  };
}
