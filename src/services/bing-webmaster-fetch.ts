// ─── Bing Webmaster Tools API client (read-only) ────────────────────────────
// A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c. The job that calls
// this (connectivity check, weekly fetch, status) is in search-console-fetch.ts.
//
// JSON protocol, API key in the query string (Settings → API access in Bing
// Webmaster Tools; one key per user, valid for all the user's sites):
//   GET https://ssl.bing.com/webmaster/api.svc/json/<Method>?apikey=<key>[&siteUrl=<url>]
// Documented responses wrap the result in {"d": …}; errors are HTTP 400 with
// {"ErrorCode": n, "Message": "…"} (ApiErrorCode, e.g. 3 = InvalidApiKey).
// Methods used, all reads:
//   GetUserSites           -> [{Url, IsVerified, AuthenticationCode, DnsVerificationCode}]
//   GetRankAndTrafficStats -> [{Date: "/Date(ms-0700)/", Clicks, Impressions}] per day
//   GetFeeds               -> [{Url, Status, UrlCount, Submitted, LastCrawled, …}] top-level sitemaps
// Status: ErrorCode 3 InvalidApiKey (and the other key/user codes) is auth_failed;
// 14 NotAuthorized, and a 403 on one site's numbers, is no_access (S6a §6).
// Source: learn.microsoft.com/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
// (GetUserSites, GetRankAndTrafficStats, GetFeeds, ApiErrorCode), read 2026-10-17.
//
// Secrets: the API key only ever goes into the request URL. Nothing here logs,
// and failures carry fixed reason codes (SearchConsoleFailure), never the URL,
// a response body or an exception message. GetUserSites' AuthenticationCode
// and DnsVerificationCode are dropped while parsing.

import {
  BING_TRAFFIC_METRICS,
  SEARCH_CONSOLE_DOMAINS,
  SEARCH_CONSOLE_REQUEST_TIMEOUT_MS,
  type SearchConsoleDomain,
  type SearchConsoleFailure,
  type SearchConsoleMetricRow,
  type SearchConsoleWeekRange,
} from "../config/search-consoles";

export const BING_API_BASE = "https://ssl.bing.com/webmaster/api.svc/json/";

export interface BingDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The API key from the Fly secret, or null when it is not set. */
export function readBingApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = (env.BING_WEBMASTER_API_KEY || "").trim();
  return key || null;
}

// ApiErrorCode values: the ones that mean the key or user is not accepted, the one that means
// the key works but not for this site, and the rest by name.
const BING_AUTH_ERRORS: Readonly<Record<number, string>> = { 3: "InvalidApiKey", 6: "UserBlocked", 10: "UserNotFound" };
const BING_NO_ACCESS_ERRORS: Readonly<Record<number, string>> = { 14: "NotAuthorized" };
const BING_OTHER_ERRORS: Readonly<Record<number, string>> = {
  1: "InternalError", 2: "UnknownError", 4: "ThrottleUser", 5: "ThrottleHost", 7: "InvalidUrl", 8: "InvalidParameter",
  9: "TooManySites", 11: "NotFound", 12: "AlreadyExists", 13: "NotAllowed", 15: "UnexpectedState", 16: "Deprecated",
};

type BingResult = { ok: true; d: unknown } | { ok: false; failure: SearchConsoleFailure };

function fail(status: SearchConsoleFailure["status"], reason: string): { ok: false; failure: SearchConsoleFailure } {
  return { ok: false, failure: { status, reason } };
}

/** One GET against the JSON endpoint. Never throws. */
async function bingGet(method: string, params: Record<string, string>, apiKey: string, deps: BingDeps): Promise<BingResult> {
  const url = new URL(method, BING_API_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", apiKey);
  let status: number;
  let text: string;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? SEARCH_CONSOLE_REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err: any) {
    return fail("error", err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network");
  }
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = undefined;
  }
  if (status < 200 || status >= 300) {
    if (status === 401 || status === 403) return fail("auth_failed", `http_${status}`);
    const code = body && typeof body.ErrorCode === "number" ? body.ErrorCode : null;
    if (code !== null && BING_AUTH_ERRORS[code]) return fail("auth_failed", `bing_${BING_AUTH_ERRORS[code]}`);
    if (code !== null && BING_NO_ACCESS_ERRORS[code]) return fail("no_access", `bing_${BING_NO_ACCESS_ERRORS[code]}`);
    if (code !== null && BING_OTHER_ERRORS[code]) return fail("error", `bing_${BING_OTHER_ERRORS[code]}`);
    return fail("error", `http_${status}`);
  }
  if (body === undefined) return fail("error", "invalid_json");
  if (!body || typeof body !== "object" || !("d" in body)) return fail("error", "unexpected_response");
  return { ok: true, d: body.d };
}

// ── Sites ─────────────────────────────────────────────────────────────

/** A site from GetUserSites, reduced to what we use (the verification codes are not kept). */
export interface BingSite {
  url: string;
  verified: boolean;
}

/** GetUserSites' `d`; null when it is not a list. */
export function parseBingUserSites(d: unknown): BingSite[] | null {
  if (d === null) return [];
  if (!Array.isArray(d)) return null;
  const out: BingSite[] = [];
  for (const s of d) {
    if (s && typeof s === "object" && typeof (s as any).Url === "string") {
      out.push({ url: (s as any).Url, verified: (s as any).IsVerified === true });
    }
  }
  return out;
}

/** Root URL of `domain` (or its www. host) among the sites; verified, https and the bare host win. */
export function matchBingSite(domain: string, sites: readonly BingSite[]): BingSite | null {
  const want = domain.toLowerCase();
  let best: { site: BingSite; score: number } | null = null;
  for (const site of sites) {
    let u: URL;
    try {
      u = new URL(site.url);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if ((host !== want && host !== `www.${want}`) || u.pathname !== "/") continue;
    const score = (site.verified ? 4 : 0) + (u.protocol === "https:" ? 2 : 0) + (host === want ? 1 : 0);
    if (!best || score > best.score) best = { site, score };
  }
  return best ? best.site : null;
}

export type BingCheckResult =
  | { ok: true; status: "ok" | "no_access"; sites: number; matches: Record<string, BingSite | null> }
  | { ok: false; failure: SearchConsoleFailure };

/**
 * Connectivity check: GetUserSites, then how many of the domains are verified sites.
 * "ok" only when all of them are; otherwise "no_access" with the count.
 */
export async function checkBing(
  apiKey: string,
  deps: BingDeps = {},
  domains: readonly SearchConsoleDomain[] = SEARCH_CONSOLE_DOMAINS,
): Promise<BingCheckResult> {
  const r = await bingGet("GetUserSites", {}, apiKey, deps);
  if (!r.ok) return r;
  const sites = parseBingUserSites(r.d);
  if (!sites) return fail("error", "unexpected_response");
  const matches: Record<string, BingSite | null> = {};
  let verified = 0;
  for (const { domain } of domains) {
    const m = matchBingSite(domain, sites);
    matches[domain] = m;
    if (m?.verified) verified++;
  }
  return { ok: true, status: verified === domains.length ? "ok" : "no_access", sites: verified, matches };
}

// ── Weekly numbers ────────────────────────────────────────────────────

const BING_DATE_RE = /^\/Date\((-?\d+)([+-])?(\d{2})?(\d{2})?\)\/$/;

/** "/Date(1316156400000-0700)/" -> "2011-09-16": the calendar day in the offset's own time zone. */
export function parseBingDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = BING_DATE_RE.exec(raw);
  if (!m) return null;
  const offsetMin = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)) : 0;
  const ms = Number(m[1]) + offsetMin * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/**
 * "/Date(1316156400000-0700)/" -> 1316156400000: the instant (epoch ms; the offset only says
 * which zone it was shown in). null for anything else and for dates before 1970, which is how
 * .NET's DateTime.MinValue ("never") comes out.
 */
export function parseBingInstant(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = BING_DATE_RE.exec(raw);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export type BingWeekResult = { ok: true; rows: SearchConsoleMetricRow[] } | { ok: false; failure: SearchConsoleFailure };

/**
 * One site's week: clicks and impressions summed over the week's days (GetRankAndTrafficStats),
 * plus the current sitemap count, their URL count and their latest Submitted / LastCrawled
 * (GetFeeds). Days Bing leaves out count as 0; the job fetches a week once more after it has
 * settled (SEARCH_CONSOLE_WEEK_SETTLED_DAYS). A 403 means this site is not readable: no_access.
 */
export async function fetchBingWeek(
  apiKey: string,
  siteUrl: string,
  week: SearchConsoleWeekRange,
  deps: BingDeps = {},
): Promise<BingWeekResult> {
  const traffic = await bingGet("GetRankAndTrafficStats", { siteUrl }, apiKey, deps);
  if (!traffic.ok) return siteFailure(traffic.failure);
  if (traffic.d !== null && !Array.isArray(traffic.d)) return fail("error", "unexpected_response");
  const sums: Record<string, number> = Object.fromEntries(Object.keys(BING_TRAFFIC_METRICS).map((m) => [m, 0]));
  for (const day of (traffic.d ?? []) as any[]) {
    const date = parseBingDate(day?.Date);
    if (!date || date < week.start || date > week.end) continue;
    for (const [metric, field] of Object.entries(BING_TRAFFIC_METRICS)) {
      const v = Number(day[field]);
      if (Number.isFinite(v)) sums[metric] += v;
    }
  }

  const feeds = await bingGet("GetFeeds", { siteUrl }, apiKey, deps);
  if (!feeds.ok) return siteFailure(feeds.failure);
  if (feeds.d !== null && !Array.isArray(feeds.d)) return fail("error", "unexpected_response");
  const list = (feeds.d ?? []) as any[];
  const sitemapUrls = list.reduce((n, f) => n + (Number.isFinite(Number(f?.UrlCount)) ? Number(f.UrlCount) : 0), 0);
  const latest = (field: "Submitted" | "LastCrawled"): number | null =>
    list.reduce<number | null>((max, f) => {
      const at = parseBingInstant(f?.[field]);
      return at !== null && (max === null || at > max) ? at : max;
    }, null);
  const dates: SearchConsoleMetricRow[] = [];
  for (const [metric, field] of [["sitemap_last_submitted_ms", "Submitted"], ["sitemap_last_crawled_ms", "LastCrawled"]] as const) {
    const at = latest(field);
    if (at !== null) dates.push({ metric, dimension: "total", value: at });
  }

  return {
    ok: true,
    rows: [
      ...Object.entries(sums).map(([metric, value]) => ({ metric, dimension: "total", value })),
      { metric: "sitemaps", dimension: "total", value: list.length },
      { metric: "sitemap_urls", dimension: "total", value: sitemapUrls },
      ...dates,
    ],
  };
}

/** In the fetch step a 403 is about this one site, not the key (S6a §3): no_access. */
function siteFailure(failure: SearchConsoleFailure): { ok: false; failure: SearchConsoleFailure } {
  return failure.reason === "http_403" ? fail("no_access", "http_403") : { ok: false, failure };
}
