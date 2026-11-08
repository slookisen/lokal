// ─── Admin «Klikk fra AI-svar» (dev-request 2026-10-14-klikk-fra-ai-svar-per-profil, slice 5c) ───
// The admin dashboard's view of profile_ai_clicks per vertical: platform sum
// (60 days and since counting started, per AI), the click rate (clicks per
// 100 «Sendt til AI» deliveries over the same days) and the top profiles of
// the 60-day window. Read-only: daily sums from profile_ai_clicks
// (getPlatformAiClicks) and profile_ai_deliveries (computeAiDeliveries), plus
// one single-row name lookup per top profile.
//
// Display rule (as the public tile and the owner funnel, Daniel 2026-10-15):
// never «60 d» or 0 for a counting younger than the window. At 0 inside the
// first window the period reads «Fra <dato>» and no number is shown; with
// clicks it reads «siden <dato>» until a whole window has passed, then «60 d».
// A vertical with no stored click yet has no counting start: display null.

import type Database from "better-sqlite3";
import {
  AI_CLICK_WINDOW_DAYS, getPlatformAiClicks, getPlatformAiClicksSince, utcDay,
  type AiClickVendor,
} from "./profile-ai-clicks-compute";
import { aiDeliveriesCountingSince, computeAiDeliveries } from "./profile-ai-deliveries-compute";
import { slugify } from "../utils/slug";

type Db = Database.Database;

const DAY_MS = 24 * 60 * 60 * 1000;

export const ADMIN_AI_CLICK_VERTICALS = ["rfb", "dental", "experiences"] as const;
export type AdminAiClickVertical = (typeof ADMIN_AI_CLICK_VERTICALS)[number];

/** How a count is shown: the number (or not) and the period words. */
export interface AiClicksDisplay {
  /** false at 0 inside the first window (and for the whole period at 0): only «Fra <dato>» is shown. */
  showNumber: boolean;
  /** «60 d», «siden <dato>» or «Fra <dato>». */
  period: string;
}

export interface AdminAiClicksSums {
  total: number;
  byVendor: Record<AiClickVendor, number>;
  /** null when the vertical has no stored click yet (no counting start to show). */
  display: AiClicksDisplay | null;
}

export interface AdminAiClickRate {
  /** First day of the rate's period ('YYYY-MM-DD'): the latest of the window start and both counting starts. */
  sinceDay: string | null;
  days: number;
  clicks: number;
  /** «Sendt til AI» deliveries over the same days. */
  deliveries: number;
  /** Clicks per 100 deliveries, two decimals; null when deliveries are 0 or no click counting exists yet. */
  per100: number | null;
}

export interface AdminAiClickTopProfile {
  profileId: string;
  total: number;
  name: string | null;
  url: string | null;
}

export interface AdminAiClicksVertical {
  vertical: AdminAiClickVertical;
  /** First stored click day for the vertical, or null. */
  countingSince: string | null;
  /** True once a whole 60-day window has passed since countingSince. */
  windowFull: boolean;
  last60d: AdminAiClicksSums;
  allTime: AdminAiClicksSums;
  rate: AdminAiClickRate;
  top: AdminAiClickTopProfile[];
}

export interface AdminAiClicks {
  windowDays: number;
  verticals: AdminAiClicksVertical[];
}

export type AiClickProfileResolver = (vertical: AdminAiClickVertical, profileId: string) => { name: string | null; url: string | null };

/** Clicks per 100 deliveries, rounded to two decimals; null (shown as «–») when there is nothing to divide by. */
export function aiClickRatePer100(clicks: number, deliveries: number): number | null {
  if (!Number.isFinite(deliveries) || deliveries <= 0) return null;
  if (!Number.isFinite(clicks) || clicks < 0) return null;
  return Math.round((clicks * 10000) / deliveries) / 100;
}

function dateLabel(day: string): string {
  return new Date(Date.parse(day + "T00:00:00Z"))
    .toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** True while the counting started inside the window (same cut as aiClicksTileView / aiDeliveriesPeriodLabel). */
export function aiClicksWindowPartial(countingSince: string, windowDays: number, nowMs: number): boolean {
  const sinceMs = Date.parse(countingSince + "T00:00:00Z");
  return Number.isNaN(sinceMs) || nowMs - sinceMs < (windowDays - 1) * DAY_MS;
}

/**
 * The words for a count: windowDays = null for the whole period. Never «60 d»
 * for a counting younger than the window and never a bare 0 inside it.
 */
export function aiClicksDisplay(total: number, countingSince: string | null, windowDays: number | null, nowMs: number): AiClicksDisplay | null {
  if (!countingSince || Number.isNaN(Date.parse(countingSince + "T00:00:00Z"))) return null;
  const date = dateLabel(countingSince);
  const partial = windowDays === null || aiClicksWindowPartial(countingSince, windowDays, nowMs);
  if (!partial) return { showNumber: true, period: `${windowDays} d` };
  if (total > 0) return { showNumber: true, period: `siden ${date}` };
  return { showNumber: false, period: `Fra ${date}` };
}

function laterDay(a: string, b: string | null): string {
  return b !== null && b > a ? b : a;
}

/**
 * Name and public profile link for a top profile, read with one single-row
 * lookup in the vertical's own store. Any failure gives nulls (the id is shown).
 */
export function defaultAiClickProfileResolver(db: Db): AiClickProfileResolver {
  return (vertical, profileId) => {
    try {
      if (vertical === "rfb") {
        const row = db.prepare("SELECT name FROM agents WHERE id = ?").get(profileId) as { name: string } | undefined;
        if (!row?.name) return { name: null, url: null };
        const base = (process.env.BASE_URL || "https://rettfrabonden.com").replace(/\/$/, "");
        const slug = slugify(row.name);
        return { name: row.name, url: slug ? `${base}/produsent/${encodeURIComponent(slug)}` : null };
      }
      if (vertical === "dental") {
        const { getDentalAgentById } = require("./dental-store") as typeof import("./dental-store");
        const agent = getDentalAgentById(profileId);
        if (!agent) return { name: null, url: null };
        const { clinicProfileUrl } = require("../routes/dental-seo") as typeof import("../routes/dental-seo");
        return { name: agent.navn ?? null, url: clinicProfileUrl(agent) };
      }
      // experiences: an experience page or a gårdssalg provider page (both counted under «experiences»).
      const base = (process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no").replace(/\/$/, "");
      const store = require("./experience-store") as typeof import("./experience-store");
      const exp = store.getExperienceById(profileId);
      if (exp) {
        const slug = (exp as { slug?: string | null }).slug;
        return { name: exp.title ?? null, url: slug ? `${base}/opplevelse/${encodeURIComponent(slug)}` : null };
      }
      const provider = store.getProviderById(profileId);
      if (provider) {
        const name = typeof provider.navn === "string" ? provider.navn : null;
        const slug = typeof provider.slug === "string" && provider.slug ? provider.slug : null;
        return { name, url: slug ? `${base}/kategori/gardssalg/produsent/${encodeURIComponent(slug)}` : null };
      }
      return { name: null, url: null };
    } catch {
      return { name: null, url: null };
    }
  };
}

/** One vertical's admin numbers. */
export function computeAdminAiClicksVertical(
  db: Db, vertical: AdminAiClickVertical, nowMs: number, limit: number, resolve: AiClickProfileResolver,
): AdminAiClicksVertical {
  const p = getPlatformAiClicks(db, vertical, nowMs, limit);
  const since = p.countingSince;
  const windowFull = since !== null && !aiClicksWindowPartial(since, AI_CLICK_WINDOW_DAYS, nowMs);

  // The rate's days: inside the 60-day window, and only days both counts existed.
  const today = utcDay(nowMs);
  const windowStart = utcDay(nowMs - (AI_CLICK_WINDOW_DAYS - 1) * DAY_MS);
  let rate: AdminAiClickRate;
  if (since === null) {
    const deliveries = computeAiDeliveries(db, vertical, undefined, AI_CLICK_WINDOW_DAYS, nowMs).total;
    rate = { sinceDay: null, days: 0, clicks: 0, deliveries, per100: null };
  } else {
    const start = laterDay(laterDay(windowStart, since), aiDeliveriesCountingSince());
    const days = start > today ? 0 : Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY_MS) + 1;
    const clicks = days > 0 ? getPlatformAiClicksSince(db, vertical, start).total : 0;
    const deliveries = days > 0 ? computeAiDeliveries(db, vertical, undefined, days, nowMs).total : 0;
    rate = { sinceDay: start, days, clicks, deliveries, per100: aiClickRatePer100(clicks, deliveries) };
  }

  return {
    vertical,
    countingSince: since,
    windowFull,
    last60d: { ...p.last60d, display: aiClicksDisplay(p.last60d.total, since, AI_CLICK_WINDOW_DAYS, nowMs) },
    allTime: { ...p.allTime, display: aiClicksDisplay(p.allTime.total, since, null, nowMs) },
    rate,
    top: p.topProfiles60d.map((t) => ({ profileId: t.profileId, total: t.total, ...resolve(vertical, t.profileId) })),
  };
}

/** The admin «Klikk fra AI-svar» numbers for the given verticals (all three when none is chosen). */
export function computeAdminAiClicks(
  db: Db, verticals: readonly AdminAiClickVertical[], nowMs: number, limit = 10,
  resolve: AiClickProfileResolver = defaultAiClickProfileResolver(db),
): AdminAiClicks {
  return {
    windowDays: AI_CLICK_WINDOW_DAYS,
    verticals: verticals.map((v) => computeAdminAiClicksVertical(db, v, nowMs, limit, resolve)),
  };
}
