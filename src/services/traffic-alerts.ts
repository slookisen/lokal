/**
 * Deterministic alert for sudden traffic falls and jumps (G2-S3 of dev-request
 * 2026-10-16-ai-trafikk-klassifisering-og-alarm). Per vertical and group
 * (human, ai_search, ai_crawler) it compares the last complete day in the
 * series with the MEDIAN of the 7 days before it. No model, no I/O in the
 * pure part; thresholds live in config/traffic-alert-thresholds.ts.
 *
 * A change in the history `version` anywhere in the compared window means the
 * numbers changed meaning (a classifier change), not the traffic: the alert is
 * then flagged classifierChange=true so the report can say so.
 */

import type Database from "better-sqlite3";
import { ALERT_GROUPS, thresholdFor, type AlertGroup } from "../config/traffic-alert-thresholds";
import { addDays, dayOf, type HistorySummary, type HistoryVertical } from "./traffic-history-compute";

export interface DailyTrafficPoint {
  /** 'YYYY-MM-DD' (UTC). */
  day: string;
  /** The stored history version of that day's summary. */
  version: number;
  views: Record<AlertGroup, number>;
}

export interface TrafficAlert {
  vertical: string;
  group: AlertGroup;
  direction: "fall" | "jump";
  severity: "high" | "medium";
  day: string;
  value: number;
  base: number;
  /** (value - base) / base, e.g. -0.757. */
  delta: number;
  classifierChange: boolean;
}

const BASELINE_DAYS = 7;
const HIGH_SEVERITY = 0.6;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Alerts for one vertical's daily series (ascending days; the last is "yesterday"). */
export function computeTrafficAlerts(vertical: string, dailySeries: DailyTrafficPoint[]): TrafficAlert[] {
  if (dailySeries.length < BASELINE_DAYS + 1) return [];
  const window = dailySeries.slice(-(BASELINE_DAYS + 1));
  // Need the 7 consecutive days before yesterday; a gap means no honest baseline.
  for (let i = 1; i < window.length; i++) if (window[i].day !== addDays(window[i - 1].day, 1)) return [];
  const last = window[window.length - 1];
  const prior = window.slice(0, -1);
  const classifierChange = window.some((p) => p.version !== last.version);
  const out: TrafficAlert[] = [];
  for (const group of ALERT_GROUPS) {
    const th = thresholdFor(vertical, group);
    const base = median(prior.map((p) => p.views[group] ?? 0));
    if (base < th.minBase) continue;
    const value = last.views[group] ?? 0;
    const delta = (value - base) / base;
    const direction = delta <= th.fall ? "fall" : delta >= th.jump ? "jump" : null;
    if (!direction) continue;
    out.push({
      vertical, group, direction,
      severity: Math.abs(delta) >= HIGH_SEVERITY ? "high" : "medium",
      day: last.day, value, base, delta: Math.round(delta * 1000) / 1000, classifierChange,
    });
  }
  return out;
}

/**
 * Alerts for /admin/analytics/history, from the stored day rows only (8 small
 * rows per vertical): the requested vertical, or for 'all' the 'all' series
 * plus each vertical's. Never throws; a missing table or bad row gives no alerts.
 */
export function computeTrafficAlertsFromDb(db: Database.Database, vertical: HistoryVertical, nowMs: number): TrafficAlert[] {
  const verticals: HistoryVertical[] = vertical === "all" ? ["all", "rfb", "dental", "experiences"] : [vertical];
  const today = dayOf(nowMs);
  const from = addDays(today, -(BASELINE_DAYS + 1));
  const out: TrafficAlert[] = [];
  try {
    const stmt = db.prepare("SELECT summary FROM traffic_history WHERE period = 'day' AND vertical = ? AND period_start >= ? AND period_start < ? ORDER BY period_start");
    for (const v of verticals) {
      const series: DailyTrafficPoint[] = [];
      for (const r of stmt.all(v, from, today) as Array<{ summary: string }>) {
        try {
          const s = JSON.parse(r.summary) as HistorySummary;
          series.push({ day: s.start, version: s.version, views: { human: s.groups.human.views, ai_search: s.groups.ai_search.views, ai_crawler: s.groups.ai_crawler.views } });
        } catch { /* skip a corrupt row */ }
      }
      out.push(...computeTrafficAlerts(v, series));
    }
  } catch { /* no traffic_history table yet */ }
  return out;
}
