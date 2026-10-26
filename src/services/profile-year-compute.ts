// ─── Per-profile tiles over 12 months (statistikk S2c) ─────────────────
// dev-request 2026-10-22-statistikk-samme-tall-12-mnd, S2 «Fliser per
// profil»: the tiles on /produsent/<slug> show the last 12 months (365 UTC
// days, today included) or «siden <dato>», never «· 60d».
//
// Each number = stored daily sums for the days already pruned from the raw
// table + the raw part the 60-day tile has always counted:
//
//   humanViews  agent_view_daily (people only, legacy bucket excluded) for
//               the days before the raw floor, + the raw page views of
//               people from that floor on (agent-stats-compute.ts, same
//               classifier and velocity checks as the 60-day tile).
//   aiViews     agent_ai_view_daily (the AI-assistant bucket from S0) for the
//               days before the raw floor, + the raw AI-search page views.
//   aiDeliveries profile_ai_deliveries from countingSince (S1), 365 days.
//
// The raw floor is the first day still in analytics_agent_views
// (rollupBoundaryDateOn): a day lives either in the raw table or in its
// rollup, never both, so the two parts never overlap.
//
// Start date per number: the first day it has data for, which is the first
// stored day that can hold that number (never before the day trackAgentView
// began classifying views, AGENT_VIEW_CLASSIFIED_SINCE; older stored days only
// hold the excluded legacy bucket), else the raw floor. null = the whole
// window. Labels come from trafficYearPeriodLabel, the site strip's own.
//
// Pure: explicit DB handle and clock, no database/init import (it runs in
// the off-thread stats worker through computeAgentStats). Every read is an
// indexed point/range read: MIN(day) on the tables' day-leading keys and
// per-agent sums through their agent_id indexes.

import type Database from "better-sqlite3";
import { LEGACY_AGENT_VIEW_SOURCE } from "../database/analytics-sql";
import { isAnalyticsRollupReadEnabled } from "./analytics-rollup-boundary";
import { computeAiDeliveries, type AiDeliveries } from "./profile-ai-deliveries-compute";
import { addDays, dayOf } from "./traffic-history-compute";
import { TRAFFIC_YEAR_DAYS, trafficYearPeriodLabel, type TrafficYearCount } from "./traffic-year-compute";

type Db = Database.Database;

/**
 * The day trackAgentView began writing traffic_category (2026-10-04, see
 * database/init.ts). Rows from before it are rolled up into the legacy
 * bucket every reader excludes, so no stored day before it holds a person's
 * or an AI assistant's view.
 */
export const AGENT_VIEW_CLASSIFIED_SINCE = "2026-10-04";

export type ProfileYearKey = "humanViews" | "aiViews" | "aiDeliveries";
export const PROFILE_YEAR_KEYS: readonly ProfileYearKey[] = ["humanViews", "aiViews", "aiDeliveries"];

export interface ProfileYear {
  windowDays: number;
  /** First day of the window ('YYYY-MM-DD', UTC). */
  from: string;
  /** Last day of the window (today, UTC). */
  to: string;
  humanViews: TrafficYearCount;
  aiViews: TrafficYearCount;
  aiDeliveries: TrafficYearCount & { byVendor: AiDeliveries["byVendor"] };
  /** «siste 12 måneder» / «siden <d. mån. åååå>» per number, as on the site strip. */
  labels: { nb: Record<ProfileYearKey, string>; en: Record<ProfileYearKey, string> };
}

/** The raw part, counted by the caller from `rawFrom` (the raw floor) on. */
export interface ProfileYearRaw {
  /** First day ('YYYY-MM-DD') still in analytics_agent_views (rollupBoundaryDateOn); tomorrow when it is empty. */
  rawFrom: string;
  humanViews: number;
  aiViews: number;
}

/** First day ('YYYY-MM-DD', UTC) of the 12-month window ending today. */
export function profileYearFrom(nowMs: number): string {
  return addDays(dayOf(nowMs), -(TRAFFIC_YEAR_DAYS - 1));
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** First stored day of `table` ('agent_view_daily' | 'agent_ai_view_daily'); answered from the day-leading key. */
function firstStoredDay(db: Db, table: "agent_view_daily" | "agent_ai_view_daily"): string | null {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT MIN(day) AS d FROM ${table}`).get() as { d: string | null } | undefined;
  return row?.d ?? null;
}

/** null when `first` is on or before the window's first day, else `first`. */
function sinceOf(first: string, from: string): string | null {
  return first <= from ? null : first;
}

/**
 * First day a number has data for: the first stored day that can hold it
 * (not before AGENT_VIEW_CLASSIFIED_SINCE) when that is before the raw floor,
 * else the raw floor; never after today.
 */
function firstDataDay(storedFirst: string | null, rawFrom: string, today: string): string {
  let first = rawFrom;
  if (storedFirst !== null) {
    const usable = storedFirst > AGENT_VIEW_CLASSIFIED_SINCE ? storedFirst : AGENT_VIEW_CLASSIFIED_SINCE;
    if (usable < first) first = usable;
  }
  return first > today ? today : first;
}

/**
 * «Med i AI-søk»'s period over the 12-month window: «siden <dato>» while the
 * counting (countingSince, S1) is younger than the window, else «siste 12
 * måneder». No DB read: the start date is the same for every profile.
 */
export function aiDeliveriesYearPeriodLabel(countingSince: string | null, nowMs: number, lang: "nb" | "en" = "nb"): string {
  return trafficYearPeriodLabel(sinceOf(countingSince ?? dayOf(nowMs), profileYearFrom(nowMs)), lang);
}

function labelsFor(c: Record<ProfileYearKey, TrafficYearCount>): ProfileYear["labels"] {
  const of = (lang: "nb" | "en") => ({
    humanViews: trafficYearPeriodLabel(c.humanViews.since, lang),
    aiViews: trafficYearPeriodLabel(c.aiViews.since, lang),
    aiDeliveries: trafficYearPeriodLabel(c.aiDeliveries.since, lang),
  });
  return { nb: of("nb"), en: of("en") };
}

/**
 * The 12-month tiles for one rfb producer profile (`agentId`), given the raw
 * part the caller counted from `raw.rawFrom`. Throws on DB errors (the
 * stats reader decides the fallback, as for the rest of the payload).
 */
export function computeProfileYear(db: Db, agentId: string, raw: ProfileYearRaw, nowMs: number): ProfileYear {
  const to = dayOf(nowMs);
  const from = profileYearFrom(nowMs);
  let humanViews = raw.humanViews;
  let aiViews = raw.aiViews;
  let humanStored: string | null = null;
  let aiStored: string | null = null;

  // Stored days: only those already gone from the raw table, inside the
  // window. ANALYTICS_ROLLUP_READ=false reads raw only (the rollback switch).
  if (isAnalyticsRollupReadEnabled() && raw.rawFrom > from) {
    const storedFrom = from > AGENT_VIEW_CLASSIFIED_SINCE ? from : AGENT_VIEW_CLASSIFIED_SINCE;
    humanStored = firstStoredDay(db, "agent_view_daily");
    aiStored = firstStoredDay(db, "agent_ai_view_daily");
    if (storedFrom < raw.rawFrom) {
      if (humanStored !== null) {
        const h = db.prepare(`
          SELECT COALESCE(SUM(view_count), 0) AS n FROM agent_view_daily
          WHERE agent_id = ? AND day >= ? AND day < ? AND view_source != ?
        `).get(agentId, storedFrom, raw.rawFrom, LEGACY_AGENT_VIEW_SOURCE) as { n: number };
        humanViews += h.n;
      }
      if (aiStored !== null) {
        const a = db.prepare(`
          SELECT COALESCE(SUM(view_count), 0) AS n FROM agent_ai_view_daily
          WHERE agent_id = ? AND day >= ? AND day < ?
        `).get(agentId, storedFrom, raw.rawFrom) as { n: number };
        aiViews += a.n;
      }
    }
  }

  const deliveries = computeAiDeliveries(db, "rfb", agentId, TRAFFIC_YEAR_DAYS, nowMs);
  const counts = {
    humanViews: { value: humanViews, since: sinceOf(firstDataDay(humanStored, raw.rawFrom, to), from) },
    aiViews: { value: aiViews, since: sinceOf(firstDataDay(aiStored, raw.rawFrom, to), from) },
    aiDeliveries: { value: deliveries.total, since: sinceOf(deliveries.countingSince ?? to, from) },
  };
  return {
    windowDays: TRAFFIC_YEAR_DAYS,
    from,
    to,
    humanViews: counts.humanViews,
    aiViews: counts.aiViews,
    aiDeliveries: { ...counts.aiDeliveries, byVendor: deliveries.byVendor },
    labels: labelsFor(counts),
  };
}
