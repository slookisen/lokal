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
 * Connection status per source, as /health and the admin GET show it (from the connectivity
 * check only; the weekly fetch has its own `fetch` result):
 *   unconfigured — the source's secret is not set;
 *   pending      — the secret is set, the first check has not finished (reason "disabled"
 *                  under the kill switch, when it never will);
 *   ok           — authenticated, and every domain below is readable;
 *   no_access    — authenticated, but fewer than all domains are readable;
 *   auth_failed  — the key or token was rejected (401, invalid_grant, InvalidApiKey …);
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
 * "no_access" is a 403 on one site's data, or Bing's NotAuthorized: the key works, the site is
 * not readable with it.
 */
export interface SearchConsoleFailure {
  status: "auth_failed" | "no_access" | "error";
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
 * GetFeeds adds "sitemaps" (top-level sitemaps), "sitemap_urls" (their UrlCount) and, when Bing
 * gives them, "sitemap_last_submitted_ms" / "sitemap_last_crawled_ms" (latest Submitted /
 * LastCrawled over the sitemaps, epoch milliseconds) per domain.
 */
export const BING_TRAFFIC_METRICS: Readonly<Record<string, "Clicks" | "Impressions">> = Object.freeze({
  clicks: "Clicks",
  impressions: "Impressions",
});

/**
 * Numbers the reports have in the console UI but not in the API (A2A
 * protocols/gsc-bing-api-ai-data-2026-10-17.md, S6a: «AI-tall via API: nei»). The admin GET lists
 * them per domain with `unavailable: "ui_only"`, so the visibility routine (S6d) can say «kun i
 * UI, se manuell eksport» without hardcoding it. If an API ever gets one, it moves to the metrics.
 */
export const SEARCH_CONSOLE_UI_ONLY_METRICS: Readonly<Record<SearchConsoleSource, readonly string[]>> = Object.freeze({
  gsc: ["ai_impressions"],
  bing: ["citation_share"],
});

/**
 * GSC days (startDate / endDate) are Pacific Time. Weeks are timed with UTC−8 (PST) all year, so
 * a week's end is never counted early: under PDT (UTC−7) it is counted one hour late.
 */
export const SEARCH_CONSOLE_DAY_UTC_OFFSET_HOURS = -8;

/**
 * A Monday–Sunday week is fetched once it has been over (Pacific Time) for this many 24 h:
 * GSC's final data comes 2–3 days late (S6a; «minst 3 dager før kjøringen»).
 */
export const SEARCH_CONSOLE_WEEK_LAG_DAYS = 3;

/**
 * A stored week that was fetched sooner than this many 24 h after its end is fetched once more
 * after it (and is "provisional" until then), so a late GSC day or a Bing day that was missing
 * (and counted as 0) does not stay in the table. The week is still the target week then
 * (the next one is due LAG_DAYS after it ends, 7 + 3 days after this one).
 */
export const SEARCH_CONSOLE_WEEK_SETTLED_DAYS = 7;

/** The check (and the weekly fetch, when a week is due) runs this often after the first run. */
export const SEARCH_CONSOLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Per-request timeout towards Google and Bing. */
export const SEARCH_CONSOLE_REQUEST_TIMEOUT_MS = 15_000;
