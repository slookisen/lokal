// ─── Search consoles: which sites and numbers we read from GSC and Bing ──────
// A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c (incl. the 2026-10-17
// amendment: connectivity check and non-secret status in /health).
//
// Google Search Console and Bing Webmaster Tools report how the three sites do
// in search. services/search-console-fetch.ts (GSC, and the shared job) and
// services/bing-webmaster-fetch.ts read them weekly, read-only, and store the
// numbers in search_console_weekly. This file is the one place that says WHICH
// sites and WHICH numbers:
//   - the domains come from brand-entities.ts (one brand, one site), so a new
//     vertical is one line in SEARCH_CONSOLE_BRANDS;
//   - a new number is one line in GSC_METRICS / GSC_BREAKDOWNS /
//     BING_TRAFFIC_METRICS.
// Credentials are Fly secrets (GSC_SERVICE_ACCOUNT_JSON, BING_WEBMASTER_API_KEY)
// and never appear here.

import { BRAND_ENTITIES, type BrandKey } from "./brand-entities";

export type SearchConsoleSource = "gsc" | "bing";
export const SEARCH_CONSOLE_SOURCES: readonly SearchConsoleSource[] = ["gsc", "bing"];

/**
 * Connection status per source, as /health and the admin GET show it:
 *   unconfigured — the source's secret is not set;
 *   pending      — the secret is set, the first check has not finished;
 *   ok           — authenticated, and every domain below is readable;
 *   no_access    — authenticated, but fewer than all domains are readable;
 *   auth_failed  — the key or token was rejected (401/403, invalid_grant, InvalidApiKey …);
 *   error        — anything else (network, timeout, 5xx, unexpected response).
 */
export type SearchConsoleStatus = "ok" | "unconfigured" | "pending" | "auth_failed" | "no_access" | "error";
export const SEARCH_CONSOLE_STATUSES: readonly SearchConsoleStatus[] = [
  "ok", "unconfigured", "pending", "auth_failed", "no_access", "error",
];

/**
 * Why a call to Google or Bing failed. `reason` is always one of our own fixed codes
 * (e.g. "invalid_grant", "api_disabled", "bing_InvalidApiKey", "http_500", "timeout"),
 * never response text or an exception message, so it can go into logs and /health.
 */
export interface SearchConsoleFailure {
  status: "auth_failed" | "error";
  reason: string;
}

/** One stored number: search_console_weekly.metric / .dimension / .value. */
export interface SearchConsoleMetricRow {
  metric: string;
  dimension: string;
  value: number;
}

/** A Monday–Sunday week as YYYY-MM-DD dates (GSC reads them as Pacific Time days). */
export interface SearchConsoleWeekRange {
  start: string;
  end: string;
}

/** Brands whose site is a property in both consoles (DNS-verified in GSC, imported to Bing, 2026-07-04). */
export const SEARCH_CONSOLE_BRANDS: readonly Exclude<BrandKey, "company">[] = ["rfb", "experiences", "dental"];

export interface SearchConsoleDomain {
  brand: Exclude<BrandKey, "company">;
  /** Bare host, e.g. "rettfrabonden.com". */
  domain: string;
}

export const SEARCH_CONSOLE_DOMAINS: readonly SearchConsoleDomain[] = Object.freeze(
  SEARCH_CONSOLE_BRANDS.map((brand) => Object.freeze({ brand, domain: new URL(BRAND_ENTITIES[brand].url).hostname })),
);

/** GSC Search Analytics fields stored per breakdown (the API returns all four on every row). */
export const GSC_METRICS = ["clicks", "impressions", "ctr", "position"] as const;
export type GscMetric = (typeof GSC_METRICS)[number];

export interface GscBreakdown {
  /** Stored in search_console_weekly.dimension. */
  dimension: string;
  /** Optional Search Analytics filter (dimensionFilterGroups[].filters[] with operator "equals"). */
  filter?: { dimension: "country" | "device" | "searchAppearance"; expression: string };
}

/** One Search Analytics query per breakdown per domain per week (type "web", final data). */
export const GSC_BREAKDOWNS: readonly GscBreakdown[] = [
  { dimension: "total" },
  // Norway is the market; GSC country codes are ISO 3166-1 alpha-3.
  { dimension: "country:nor", filter: { dimension: "country", expression: "nor" } },
];

/**
 * Bing GetRankAndTrafficStats fields, summed over the week's days (metric -> API field).
 * Since 2023-03-24 they include Web, Chat (Copilot), News, Images, Videos and the knowledge panel.
 * GetFeeds adds "sitemaps" (top-level sitemaps) and "sitemap_urls" (their UrlCount) per domain.
 */
export const BING_TRAFFIC_METRICS: Readonly<Record<string, "Clicks" | "Impressions">> = Object.freeze({
  clicks: "Clicks",
  impressions: "Impressions",
});

/** A week is fetched once its Sunday is this many days old, so GSC's final data (2–3 days late) is in. */
export const SEARCH_CONSOLE_WEEK_LAG_DAYS = 4;

/** The check (and the weekly fetch, when a week is due) runs this often after the first run. */
export const SEARCH_CONSOLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Per-request timeout towards Google and Bing. */
export const SEARCH_CONSOLE_REQUEST_TIMEOUT_MS = 15_000;
