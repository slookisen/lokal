/**
 * bing-webmaster-fetch.test.ts — A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c.
 *
 * The Bing Webmaster client against a fetch stub passed as fetchImpl (no network): request shape, GetUserSites
 * parsing (verification codes dropped), site matching, error classification, /Date(…)/ parsing
 * and the weekly sums. The job around it is tested in search-console-fetch.test.ts.
 */
import {
  BING_API_BASE,
  checkBing,
  fetchBingWeek,
  matchBingSite,
  parseBingDate,
  parseBingUserSites,
  readBingApiKey,
} from "./bing-webmaster-fetch";
import { SEARCH_CONSOLE_DOMAINS } from "../config/search-consoles";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const API_KEY = "0123456789abcdef0123456789abcdef";
const AUTH_CODE = "258CAD36B9EEE22F1CFDEB4C239D26BB";
const DNS_CODE = "258cad36b9eee22f1cfdeb4c239d26bb.example.com";

type Reply = { status: number; body?: unknown; raw?: string } | Error;
interface Call { url: URL; init: any }

/** fetch stub: `reply` decides per request; every request is recorded. */
function stubFetch(reply: (url: URL, init: any) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const r = await reply(url, init);
    if (r instanceof Error) throw r;
    const text = r.raw !== undefined ? r.raw : r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const site = (url: string, verified = true) => ({
  __type: "Site:#Microsoft.Bing.Webmaster.Api",
  AuthenticationCode: AUTH_CODE,
  DnsVerificationCode: DNS_CODE,
  IsVerified: verified,
  Url: url,
});

/** Midnight Pacific (PDT, -0700) of a 2026-10 day, in Bing's JSON date format. */
const bingDay = (day: number) => `/Date(${Date.UTC(2026, 9, day, 7, 0, 0)}-0700)/`;

export async function runBingWebmasterFetchTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const t = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };

  try {
    // ── key ──
    t(readBingApiKey({}) === null && readBingApiKey({ BING_WEBMASTER_API_KEY: "  " }) === null, "K1: no / blank key -> null");
    t(readBingApiKey({ BING_WEBMASTER_API_KEY: ` ${API_KEY}\n` }) === API_KEY, "K2: key is trimmed");

    // ── GetUserSites parsing ──
    const parsed = parseBingUserSites([site("https://rettfrabonden.com/"), site("http://x.no/", false), { Url: 5 }, null]);
    t(JSON.stringify(parsed) === JSON.stringify([{ url: "https://rettfrabonden.com/", verified: true }, { url: "http://x.no/", verified: false }]),
      "P1: only Url and IsVerified are kept, malformed entries dropped");
    t(!JSON.stringify(parsed).includes(AUTH_CODE) && !JSON.stringify(parsed).includes(DNS_CODE.slice(0, 20)),
      "P2: AuthenticationCode and DnsVerificationCode are not kept");
    t(parseBingUserSites(null)?.length === 0 && parseBingUserSites({}) === null && parseBingUserSites("x") === null,
      "P3: d null -> no sites; a non-list -> null");

    // ── matching ──
    const sites = [
      { url: "http://rettfrabonden.com/", verified: true },
      { url: "https://www.rettfrabonden.com/", verified: true },
      { url: "https://rettfrabonden.com/", verified: true },
      { url: "https://opplevagent.no/blog/", verified: true },
      { url: "https://opplevagent.no.evil.com/", verified: true },
      { url: "https://finn-tannlege.com/", verified: false },
      { url: "https://www.finn-tannlege.com/", verified: true },
      { url: "not a url", verified: true },
    ];
    t(matchBingSite("rettfrabonden.com", sites)?.url === "https://rettfrabonden.com/", "M1: https bare host wins over http and www");
    t(matchBingSite("opplevagent.no", sites) === null, "M2: a sub-path site or a look-alike host is not the domain's site");
    t(matchBingSite("finn-tannlege.com", sites)?.url === "https://www.finn-tannlege.com/", "M3: a verified www site wins over an unverified bare one");
    t(matchBingSite("RETTFRABONDEN.COM", [{ url: "https://RettFraBonden.com/", verified: true }]) !== null, "M4: host match ignores case");

    // ── checkBing ──
    const allThree = stubFetch(() => ({
      status: 200,
      body: { d: [site("https://rettfrabonden.com/"), site("https://opplevagent.no/"), site("https://www.finn-tannlege.com/"), site("https://other.no/")] },
    }));
    const c1 = await checkBing(API_KEY, { fetchImpl: allThree.fetchImpl });
    t(c1.ok && c1.status === "ok" && c1.sites === 3, "C1: all three domains verified -> ok, sites 3");
    const req = allThree.calls[0];
    t(allThree.calls.length === 1 && req.init.method === "GET" && req.url.origin === "https://ssl.bing.com" &&
      req.url.pathname === "/webmaster/api.svc/json/GetUserSites" && req.url.searchParams.get("apikey") === API_KEY &&
      `${req.url.origin}${req.url.pathname}`.startsWith(BING_API_BASE),
      "C2: one GET to ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=…");
    t(req.init.signal instanceof AbortSignal, "C3: the request has a timeout signal");
    t(c1.ok && !JSON.stringify(c1).includes(AUTH_CODE), "C4: the check result carries no verification code");

    const partial = stubFetch(() => ({ status: 200, body: { d: [site("https://rettfrabonden.com/"), site("https://opplevagent.no/", false)] } }));
    const c2 = await checkBing(API_KEY, { fetchImpl: partial.fetchImpl });
    t(c2.ok && c2.status === "no_access" && c2.sites === 1 && c2.matches["opplevagent.no"]?.verified === false &&
      c2.matches["finn-tannlege.com"] === null, "C5: an unverified site does not count; a missing one is null -> no_access, sites 1");
    const none = await checkBing(API_KEY, { fetchImpl: stubFetch(() => ({ status: 200, body: { d: [] } })).fetchImpl });
    t(none.ok && none.status === "no_access" && none.sites === 0, "C6: no sites -> no_access, sites 0");

    // ── errors ──
    const failOf = async (reply: Reply) => {
      const r = await checkBing(API_KEY, { fetchImpl: stubFetch(() => reply).fetchImpl });
      return r.ok ? null : r.failure;
    };
    const e1 = await failOf({ status: 400, body: { ErrorCode: 3, Message: "InvalidApiKey" } });
    t(e1?.status === "auth_failed" && e1.reason === "bing_InvalidApiKey", "E1: 400 ErrorCode 3 -> auth_failed bing_InvalidApiKey");
    const e2 = await failOf({ status: 400, body: { ErrorCode: 14, Message: "NotAuthorized" } });
    t(e2?.status === "auth_failed" && e2.reason === "bing_NotAuthorized", "E2: ErrorCode 14 -> auth_failed bing_NotAuthorized");
    const e3 = await failOf({ status: 400, body: { ErrorCode: 4, Message: "ThrottleUser" } });
    t(e3?.status === "error" && e3.reason === "bing_ThrottleUser", "E3: ErrorCode 4 -> error bing_ThrottleUser");
    const e4 = await failOf({ status: 401, raw: "" });
    const e4b = await failOf({ status: 403, raw: "<html>" });
    t(e4?.status === "auth_failed" && e4.reason === "http_401" && e4b?.status === "auth_failed" && e4b.reason === "http_403",
      "E4: 401 / 403 -> auth_failed");
    const e5 = await failOf({ status: 500, raw: "oops" });
    t(e5?.status === "error" && e5.reason === "http_500", "E5: 500 -> error http_500");
    const e6 = await failOf({ status: 400, body: { ErrorCode: 99 } });
    t(e6?.status === "error" && e6.reason === "http_400", "E6: unknown ErrorCode -> error http_400");
    const e7 = await failOf({ status: 200, raw: "{not json" });
    t(e7?.status === "error" && e7.reason === "invalid_json", "E7: 200 with invalid JSON -> error invalid_json");
    const e8 = await failOf({ status: 200, body: { x: 1 } });
    const e8b = await failOf({ status: 200, body: { d: "x" } });
    t(e8?.reason === "unexpected_response" && e8b?.reason === "unexpected_response", "E8: no d / d not a list -> unexpected_response");
    const e9 = await failOf(new TypeError(`fetch failed for ${BING_API_BASE}GetUserSites?apikey=${API_KEY}`));
    t(e9?.status === "error" && e9.reason === "network", "E9: a network error -> error network");
    t(!JSON.stringify(e9).includes(API_KEY), "E10: the failure never carries the exception message (it held the key)");
    const e11 = await failOf(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    t(e11?.status === "error" && e11.reason === "timeout", "E11: a timeout -> error timeout");

    // ── dates ──
    t(parseBingDate("/Date(1316156400000-0700)/") === "2011-09-16", "D1: the documented sample is 2011-09-16 (its -07:00 day)");
    t(parseBingDate("/Date(1316156400000)/") === "2011-09-16" && parseBingDate("/Date(1316196000000+0200)/") === "2011-09-16",
      "D2: no offset = UTC; a positive offset shifts the other way");
    t(parseBingDate("2011-09-16") === null && parseBingDate(null) === null && parseBingDate("/Date(x)/") === null, "D3: anything else -> null");
    t(parseBingDate(bingDay(5)) === "2026-10-05" && parseBingDate(bingDay(11)) === "2026-10-11", "D4: the fixture days parse to themselves");

    // ── weekly numbers ──
    const week = { start: "2026-10-05", end: "2026-10-11" };
    const weekly = stubFetch((url) => {
      const method = url.pathname.split("/").pop();
      if (method === "GetRankAndTrafficStats") {
        return {
          status: 200,
          body: {
            d: [
              { Date: bingDay(4), Clicks: 1000, Impressions: 1000 }, // Sunday before: outside
              { Date: bingDay(5), Clicks: 3, Impressions: 40 },
              { Date: bingDay(9), Clicks: 2, Impressions: 60 },
              { Date: bingDay(11), Clicks: 1, Impressions: 0 },
              { Date: bingDay(12), Clicks: 1000, Impressions: 1000 }, // Monday after: outside
              { Date: "junk", Clicks: 1000, Impressions: 1000 },
            ],
          },
        };
      }
      if (method === "GetFeeds") return { status: 200, body: { d: [{ Url: "https://rettfrabonden.com/sitemap.xml", UrlCount: 1200 }, { Url: "https://rettfrabonden.com/s2.xml", UrlCount: 30 }] } };
      return { status: 404, raw: "" };
    });
    const w1 = await fetchBingWeek(API_KEY, "https://rettfrabonden.com/", week, { fetchImpl: weekly.fetchImpl });
    const val = (m: string) => (w1.ok ? w1.rows.find((r) => r.metric === m && r.dimension === "total")?.value : undefined);
    t(w1.ok && val("clicks") === 6 && val("impressions") === 100, "W1: clicks/impressions summed over Monday–Sunday only");
    t(val("sitemaps") === 2 && val("sitemap_urls") === 1230, "W2: sitemaps = top-level feeds, sitemap_urls = their UrlCount");
    t(weekly.calls.length === 2 && weekly.calls.every((c) => c.url.searchParams.get("siteUrl") === "https://rettfrabonden.com/" &&
      c.url.searchParams.get("apikey") === API_KEY), "W3: both calls carry siteUrl as Bing lists it, and the key");

    const empty = stubFetch(() => ({ status: 200, body: { d: null } }));
    const w2 = await fetchBingWeek(API_KEY, "https://finn-tannlege.com/", week, { fetchImpl: empty.fetchImpl });
    t(w2.ok && w2.rows.length === 4 && w2.rows.every((r) => r.value === 0),
      "W4: no traffic and no sitemaps -> clicks, impressions, sitemaps, sitemap_urls all 0 (sitemap count 0 is a real answer)");
    const feedsDown = stubFetch((url) => url.pathname.endsWith("GetFeeds") ? { status: 500, raw: "" } : { status: 200, body: { d: [] } });
    const w3 = await fetchBingWeek(API_KEY, "https://finn-tannlege.com/", week, { fetchImpl: feedsDown.fetchImpl });
    t(!w3.ok && w3.failure.reason === "http_500", "W5: a failing GetFeeds fails the week (nothing half-stored)");
    const badTraffic = await fetchBingWeek(API_KEY, "https://x.no/", week, { fetchImpl: stubFetch(() => ({ status: 200, body: { d: {} } })).fetchImpl });
    t(!badTraffic.ok && badTraffic.failure.reason === "unexpected_response", "W6: traffic d not a list -> unexpected_response");

    t(SEARCH_CONSOLE_DOMAINS.length === 3, "W7: three domains are checked by default");
  } catch (err: any) {
    failed++;
    failures.push("bing-webmaster-fetch: unexpected error: " + String(err?.stack || err?.message || err));
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBingWebmasterFetchTests({ log: true }).then((r) => {
    console.log(`\nbing-webmaster-fetch: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
