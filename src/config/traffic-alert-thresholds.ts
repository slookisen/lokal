/**
 * Thresholds for the deterministic traffic alert (G2-S3 of dev-request
 * 2026-10-16-ai-trafikk-klassifisering-og-alarm), per vertical and traffic
 * group. A new series is config only: add an entry under its vertical.
 * Start conservative; too-sensitive thresholds cause alert fatigue.
 */

export type AlertGroup = "human" | "ai_search" | "ai_crawler";
export const ALERT_GROUPS: readonly AlertGroup[] = ["human", "ai_search", "ai_crawler"];

export interface TrafficAlertThreshold {
  /** Alert when the change vs. the baseline is at or below this (negative, -0.4 = -40%). */
  fall: number;
  /** Alert when the change vs. the baseline is at or above this (+1.5 = +150%). */
  jump: number;
  /** Minimum baseline (median of the 7 days before) in page views; below it a swing is noise. */
  minBase: number;
}

export const DEFAULT_TRAFFIC_ALERT_THRESHOLD: TrafficAlertThreshold = { fall: -0.4, jump: 1.5, minBase: 200 };

/** Overrides keyed by vertical ('all' included), then group. Unlisted series use the default. */
export const TRAFFIC_ALERT_THRESHOLDS: Record<string, Partial<Record<AlertGroup, Partial<TrafficAlertThreshold>>>> = {};

export function thresholdFor(vertical: string, group: AlertGroup): TrafficAlertThreshold {
  return { ...DEFAULT_TRAFFIC_ALERT_THRESHOLD, ...(TRAFFIC_ALERT_THRESHOLDS[vertical]?.[group] ?? {}) };
}
