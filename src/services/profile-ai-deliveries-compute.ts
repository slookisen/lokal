// ─── «Med i AI-søk» (was «Med i AI-svar»): reads over profile_ai_deliveries ─
// dev-request 2026-10-14-med-i-ai-svar-per-profil, S1. How many times a
// profile was sent to an AI assistant (ChatGPT, Claude …) as part of what we
// delivered: a list page or the profile page an assistant fetched for someone,
// an MCP data tool's result or a countable A2A answer. It says the profile
// reached the AI, not that anybody saw it. The rows are written in batches by
// profile-ai-deliveries.ts. Pure: no database/init import; runs in the stats
// workers.

import type Database from "better-sqlite3";

type Db = Database.Database;

export const AI_DELIVERY_CHANNELS = ["ai_page_list", "ai_page_profile", "mcp", "a2a"] as const;
export type AiDeliveryChannel = (typeof AI_DELIVERY_CHANNELS)[number];

export const AI_DELIVERY_VENDORS = ["chatgpt", "claude", "perplexity", "other", "unknown"] as const;
export type AiDeliveryVendor = (typeof AI_DELIVERY_VENDORS)[number];

/**
 * «Med i AI-søk» (dev-request 2026-10-25 statistikk, S1): the day the counting
 * restarted, when the front page's featured list stopped counting. Rows before
 * it stay in profile_ai_deliveries but are never counted or shown.
 * PROFILE_AI_DELIVERIES_COUNTING_SINCE ('YYYY-MM-DD') overrides the default.
 */
export const DEFAULT_AI_DELIVERIES_COUNTING_SINCE = "2026-10-26";

/** The configured first counted day ('YYYY-MM-DD', UTC); an invalid override falls back to the default. */
export function aiDeliveriesCountingSince(): string {
  const raw = (process.env.PROFILE_AI_DELIVERIES_COUNTING_SINCE ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw + "T00:00:00Z"))
    && new Date(raw + "T00:00:00Z").toISOString().slice(0, 10) === raw) return raw;
  return DEFAULT_AI_DELIVERIES_COUNTING_SINCE;
}

/** Window of the public tile and the API (days, today included). */
export const AI_DELIVERY_WINDOW_DAYS = 60;

/** Display name and subtitle of the count (S1, 2026-10-25), shared by the server-rendered tiles. */
export const AI_DELIVERIES_LABEL = { nb: "Med i AI-søk", en: "In AI searches" } as const;
export const AI_DELIVERIES_SUBTITLE = {
  nb: "ganger profilen var blant treffene en AI-assistent hentet",
  en: "times the profile was among the results an AI assistant fetched",
} as const;

/**
 * The period a count covers, for the subtitle: «siden <dato>» while the
 * counting is younger than the window (or for the whole period), else
 * «siste N d».
 */
export function aiDeliveriesPeriodLabel(
  countingSince: string | null, windowDays: number | null, nowMs: number, lang: "nb" | "en" = "nb",
): string {
  const sinceMs = countingSince ? Date.parse(countingSince + "T00:00:00Z") : NaN;
  const partial = windowDays === null || (!Number.isNaN(sinceMs) && nowMs - sinceMs < (windowDays - 1) * 24 * 60 * 60 * 1000);
  if (partial && !Number.isNaN(sinceMs)) {
    const d = new Date(sinceMs).toLocaleDateString(lang === "en" ? "en-GB" : "nb-NO", { day: "numeric", month: "short", timeZone: "UTC" });
    return (lang === "en" ? "since " : "siden ") + d;
  }
  if (windowDays === null) return lang === "en" ? "whole period" : "hele perioden";
  return lang === "en" ? `last ${windowDays} d` : `siste ${windowDays} d`;
}

export interface AiDeliveries {
  /** null = the whole period since the counting started. */
  windowDays: number | null;
  /**
   * First counted day ('YYYY-MM-DD', UTC): aiDeliveriesCountingSince(), the
   * same for every vertical and profile. null only when there is no table.
   * Shown as «fra/siden <dato>» so a new count is never read as a full 60
   * days, and a profile at 0 shows the date instead of 0 (Daniel 2026-10-15).
   */
  countingSince: string | null;
  total: number;
  byVendor: Record<AiDeliveryVendor, number>;
  byChannel: Record<AiDeliveryChannel, number>;
}

export interface AiDeliveryTopProfile {
  profileId: string;
  total: number;
}

/** UTC day 'YYYY-MM-DD' of an epoch-ms instant (the table's `day`). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function tableExists(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_ai_deliveries'").get();
}

/** First day inside a window of `windowDays` days ending today (UTC). */
function firstDay(windowDays: number, nowMs: number): string {
  return utcDay(nowMs - (windowDays - 1) * 24 * 60 * 60 * 1000);
}

/** First counted day: the window's first day, never before the counting started; all days since then with windowDays = null. */
function firstCountedDay(windowDays: number | null, nowMs: number): string {
  const since = aiDeliveriesCountingSince();
  if (windowDays === null) return since;
  const w = firstDay(windowDays, nowMs);
  return w > since ? w : since;
}

export function emptyAiDeliveries(windowDays: number | null): AiDeliveries {
  return {
    windowDays,
    countingSince: null,
    total: 0,
    byVendor: { chatgpt: 0, claude: 0, perplexity: 0, other: 0, unknown: 0 },
    byChannel: { ai_page_list: 0, ai_page_profile: 0, mcp: 0, a2a: 0 },
  };
}

/**
 * Sums for one profile (`profileId`), a whole vertical (no profileId) or all
 * verticals (no vertical either), over the last `windowDays` days, or all days
 * with windowDays = null.
 */
export function computeAiDeliveries(
  db: Db, vertical: string | undefined, profileId: string | undefined, windowDays: number | null, nowMs: number,
): AiDeliveries {
  const out = emptyAiDeliveries(windowDays);
  if (!tableExists(db)) return out;
  out.countingSince = aiDeliveriesCountingSince();
  const where = ["day >= ?"];
  const params: string[] = [firstCountedDay(windowDays, nowMs)];
  if (vertical !== undefined) { where.push("vertical_id = ?"); params.push(vertical); }
  if (profileId !== undefined) { where.push("profile_id = ?"); params.push(profileId); }
  const rows = db.prepare(`
    SELECT channel, ai_vendor, SUM(count) AS n FROM profile_ai_deliveries
    WHERE ${where.join(" AND ")}
    GROUP BY channel, ai_vendor
  `).all(...params) as Array<{ channel: string; ai_vendor: string; n: number }>;
  for (const r of rows) {
    const vendor = (AI_DELIVERY_VENDORS as readonly string[]).includes(r.ai_vendor) ? r.ai_vendor as AiDeliveryVendor : "unknown";
    out.byVendor[vendor] += r.n;
    if ((AI_DELIVERY_CHANNELS as readonly string[]).includes(r.channel)) out.byChannel[r.channel as AiDeliveryChannel] += r.n;
    out.total += r.n;
  }
  return out;
}

/** The profiles sent to AI assistants most often in the window. */
export function computeAiDeliveryTopProfiles(
  db: Db, vertical: string, windowDays: number | null, nowMs: number, limit = 10,
): AiDeliveryTopProfile[] {
  if (!tableExists(db)) return [];
  const params: Array<string | number> = [vertical, firstCountedDay(windowDays, nowMs), limit];
  return db.prepare(`
    SELECT profile_id AS profileId, SUM(count) AS total FROM profile_ai_deliveries
    WHERE vertical_id = ? AND day >= ?
    GROUP BY profile_id
    ORDER BY total DESC, profile_id
    LIMIT ?
  `).all(...params) as AiDeliveryTopProfile[];
}
