/**
 * search-console-fetch.test.ts — A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c and the
 * 2026-10-17 amendment (connectivity check, /health status, kill switch).
 *
 * No network: every call passes a fetch stub (fetchImpl) that answers as Google / Bing and fails
 * on anything else, and the service-account key is an RSA key generated here with node:crypto. Covers the GSC client (JWT,
 * token exchange, sites.list, Search Analytics), the job (status transitions, weekly upsert,
 * kill switch, missing secrets), /health (synchronous, additive), the scheduler (boot delay,
 * exclusive gate), GET /admin/analytics/search-consoles, the init.ts table, and that no secret
 * reaches a log line, an error, /health or the admin JSON.
 */
import Database from "better-sqlite3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  GSC_API_BASE,
  GSC_SCOPE,
  GSC_TOKEN_URL,
  SEARCH_CONSOLE_WEEKLY_DDL,
  SEARCH_CONSOLE_WEEKLY_INDEX_DDL,
  __resetSearchConsolesForTesting,
  buildGscJwt,
  checkGsc,
  ensureSearchConsoleWeeklyTable,
  exchangeGscToken,
  fetchGscWeek,
  getSearchConsoleWeekView,
  getSearchConsolesHealth,
  gscHasAccess,
  isSearchConsoleFetchEnabled,
  matchGscProperty,
  parseGscSites,
  readGscCredentials,
  redactSecrets,
  runSearchConsoleJob,
  searchConsoleWeekRange,
  startSearchConsoleScheduler,
  targetSearchConsoleWeek,
  upsertSearchConsoleRows,
  type GscCredentials,
} from "./search-console-fetch";
import { runExclusiveBootJob, SEARCH_CONSOLE_BOOT_DELAY_MS, DENTAL_GEOCODE_BOOT_DELAY_MS, TRAFFIC_PREWARM_BOOT_DELAY_MS } from "./boot-job-gate";
import { SEARCH_CONSOLE_CHECK_INTERVAL_MS, SEARCH_CONSOLE_DOMAINS, SEARCH_CONSOLE_STATUSES, GSC_BREAKDOWNS, GSC_METRICS } from "../config/search-consoles";

export interface TestSummary { passed: number; failed: number; failures: string[] }

// ── Fixtures ──────────────────────────────────────────────────────────

const { privateKey: PRIV_PEM, publicKey: PUB_PEM } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CLIENT_EMAIL = "gsc-reader@rfb-test-proj.iam.gserviceaccount.com";
const KEY_ID = "0123456789abcdef0123456789abcdef01234567";
const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "rfb-test-proj",
  private_key_id: KEY_ID,
  private_key: PRIV_PEM,
  client_email: CLIENT_EMAIL,
  client_id: "100000000000000000001",
  token_uri: GSC_TOKEN_URL,
});
const BING_KEY = "fedcba9876543210fedcba9876543210";
const ACCESS_TOKEN = "ya29.c.test-access-token-0123456789-abcdefghijklmnop";
const AUTH_CODE = "258CAD36B9EEE22F1CFDEB4C239D26BB";
const DNS_CODE = "258cad36b9eee22f1cfdeb4c239d26bb.finn-tannlege.com";
const PEM_LINE = PRIV_PEM.split("\n")[5]; // a line of the key body

/** Every string that must never leave the module. */
const SECRET_MARKERS = [SA_JSON, PRIV_PEM, PEM_LINE, CLIENT_EMAIL, BING_KEY, ACCESS_TOKEN, AUTH_CODE, DNS_CODE, KEY_ID];

const ENV_BOTH = { GSC_SERVICE_ACCOUNT_JSON: SA_JSON, BING_WEBMASTER_API_KEY: BING_KEY } as NodeJS.ProcessEnv;
// Saturday 2026-10-17: the latest complete week (Sunday ≥ 4 days old) is Mon 2026-10-05 .. Sun 2026-10-11.
const NOW = new Date("2026-10-17T12:00:00.000Z");
const WEEK = "2026-10-05";

type Reply = { status: number; body?: unknown; raw?: string } | Error;
interface Call { url: URL; init: any }

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

const GSC_SITES_ALL = [
  { siteUrl: "https://rettfrabonden.com/", permissionLevel: "siteRestrictedUser" }, // URL-prefix property
  { siteUrl: "sc-domain:opplevagent.no", permissionLevel: "siteRestrictedUser" }, // Domain property
  { siteUrl: "sc-domain:finn-tannlege.com", permissionLevel: "siteFullUser" },
  { siteUrl: "https://example.org/", permissionLevel: "siteOwner" },
];
const bingSite = (url: string, verified = true) => ({ __type: "Site:#Microsoft.Bing.Webmaster.Api", AuthenticationCode: AUTH_CODE, DnsVerificationCode: DNS_CODE, IsVerified: verified, Url: url });
const BING_SITES_ALL = [bingSite("https://rettfrabonden.com/"), bingSite("https://opplevagent.no/"), bingSite("https://finn-tannlege.com/")];
const bingDay = (day: number) => `/Date(${Date.UTC(2026, 9, day, 7, 0, 0)}-0700)/`;

/** Google + Bing as one stub; `over` replaces a single endpoint's reply. */
interface Scenario {
  token?: (init: any) => Reply;
  sites?: () => Reply;
  query?: (siteUrl: string, body: any) => Reply;
  bingSites?: () => Reply;
  bingTraffic?: (siteUrl: string) => Reply;
  bingFeeds?: (siteUrl: string) => Reply;
}
function fakeApis(scn: Scenario = {}) {
  return stubFetch((url, init) => {
    if (url.href === GSC_TOKEN_URL) return scn.token ? scn.token(init) : { status: 200, body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" } };
    if (url.href === `${GSC_API_BASE}sites`) {
      if (init.headers?.Authorization !== `Bearer ${ACCESS_TOKEN}`) return { status: 401, body: { error: { code: 401 } } };
      return scn.sites ? scn.sites() : { status: 200, body: { siteEntry: GSC_SITES_ALL } };
    }
    const m = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url.pathname);
    if (url.origin === "https://www.googleapis.com" && m) {
      const siteUrl = decodeURIComponent(m[1]);
      const body = JSON.parse(init.body);
      if (scn.query) return scn.query(siteUrl, body);
      const nor = !!body.dimensionFilterGroups;
      return { status: 200, body: { rows: [{ clicks: nor ? 8 : 10, impressions: nor ? 150 : 200, ctr: nor ? 0.0533 : 0.05, position: nor ? 6.5 : 7.5 }], responseAggregationType: "byProperty" } };
    }
    if (url.host === "ssl.bing.com") {
      const method = url.pathname.split("/").pop();
      const siteUrl = url.searchParams.get("siteUrl") || "";
      if (url.searchParams.get("apikey") !== BING_KEY) return { status: 400, body: { ErrorCode: 3, Message: "InvalidApiKey" } };
      if (method === "GetUserSites") return scn.bingSites ? scn.bingSites() : { status: 200, body: { d: BING_SITES_ALL } };
      if (method === "GetRankAndTrafficStats") {
        return scn.bingTraffic ? scn.bingTraffic(siteUrl) : { status: 200, body: { d: [{ Date: bingDay(6), Clicks: 4, Impressions: 90 }, { Date: bingDay(8), Clicks: 1, Impressions: 10 }] } };
      }
      if (method === "GetFeeds") {
        if (scn.bingFeeds) return scn.bingFeeds(siteUrl);
        // finn-tannlege.com has no sitemap in Bing (the 2026-07-04 import showed «Sitemaps Count: 0»).
        return { status: 200, body: { d: siteUrl.includes("finn-tannlege") ? [] : [{ Url: `${siteUrl}sitemap.xml`, UrlCount: 500, Status: "Success" }] } };
      }
    }
    return new Error(`unexpected request ${url.origin}${url.pathname}`);
  });
}

/** Calls an Express router directly (same seam as offsite-backup.test.ts / admin-db-backup.test.ts). */
function callRoute(router: any, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const query: Record<string, string> = {};
    const qi = url.indexOf("?");
    if (qi !== -1) for (const pair of url.slice(qi + 1).split("&")) { const [k, v] = pair.split("="); query[k] = decodeURIComponent(v ?? ""); }
    const req: any = { method: "GET", url, query, headers };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: { error: String(err ?? "no route") } }));
  });
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export async function runSearchConsoleFetchTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const t = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };

  // Everything the module could print or return is collected here and checked for secrets at the end.
  const emitted: string[] = [];
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); emitted.push(m); };
  const realConsoleError = console.error;
  const dbs: Database.Database[] = [];
  const newDb = () => { const d = new Database(":memory:"); dbs.push(d); return d; };
  const job = (db: Database.Database, f: ReturnType<typeof fakeApis>, env: NodeJS.ProcessEnv = ENV_BOTH, now = NOW) =>
    runSearchConsoleJob({ env, db, fetchImpl: f.fetchImpl, now: () => now, log }).then((s) => { emitted.push(JSON.stringify(s)); return s; });
  const health = (env: NodeJS.ProcessEnv = ENV_BOTH) => { const h = getSearchConsolesHealth({ env }); emitted.push(JSON.stringify(h)); return h; };

  try {
    __resetSearchConsolesForTesting();

    // ── config ──
    t(SEARCH_CONSOLE_DOMAINS.map((d) => d.domain).join(",") === "rettfrabonden.com,opplevagent.no,finn-tannlege.com",
      "CF1: the three domains come from brand-entities.ts");
    t(GSC_METRICS.join(",") === "clicks,impressions,ctr,position" && GSC_BREAKDOWNS.map((b) => b.dimension).join(",") === "total,country:nor",
      "CF2: GSC metrics and breakdowns are config");
    t(SEARCH_CONSOLE_STATUSES.join(",") === "ok,unconfigured,pending,auth_failed,no_access,error", "CF3: the six status codes");

    // ── credentials ──
    t(readGscCredentials({}) === null && readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: "  " }) === null, "K1: unset / blank secret -> null");
    const cr = readGscCredentials(ENV_BOTH);
    t(!!cr && cr.ok && cr.creds.clientEmail === CLIENT_EMAIL && cr.creds.keyId === KEY_ID && cr.creds.privateKey.asymmetricKeyType === "rsa",
      "K2: the downloaded JSON key is read (email, key id, RSA key)");
    const b64 = readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: Buffer.from(SA_JSON).toString("base64") });
    t(!!b64 && b64.ok, "K3: base64 of the JSON key is accepted");
    const escaped = readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: SA_JSON.replace(/\\n/g, "\\\\n") });
    t(!!escaped && escaped.ok, "K4: a private_key whose newlines arrived as literal \\n is repaired");
    const garbage = readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: `{"private_key": "${PEM_LINE}", oops` });
    t(!!garbage && !garbage.ok && garbage.failure.status === "auth_failed" && garbage.failure.reason === "invalid_key_json" &&
      !JSON.stringify(garbage).includes(PEM_LINE), "K5: unparsable JSON -> auth_failed invalid_key_json, nothing of the input in the result");
    const noEmail = readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ private_key: PRIV_PEM }) });
    t(!!noEmail && !noEmail.ok && noEmail.failure.reason === "invalid_key_json", "K6: no client_email -> invalid_key_json");
    const badPem = readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: CLIENT_EMAIL, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }) });
    t(!!badPem && !badPem.ok && badPem.failure.reason === "invalid_private_key", "K7: an unreadable key -> invalid_private_key");
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const ecRes = readGscCredentials({ GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: CLIENT_EMAIL, private_key: ec.privateKey }) });
    t(!!ecRes && !ecRes.ok && ecRes.failure.reason === "invalid_private_key", "K8: a non-RSA key -> invalid_private_key (RS256 only)");
    const creds = (cr as { ok: true; creds: GscCredentials }).creds;

    // ── JWT ──
    const jwt = buildGscJwt(creds, NOW);
    const parts = jwt.split(".");
    const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    t(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)), "J1: three base64url parts, no padding");
    const hdr = dec(parts[0]);
    const cl = dec(parts[1]);
    t(hdr.alg === "RS256" && hdr.typ === "JWT" && hdr.kid === KEY_ID, "J2: header alg RS256, typ JWT, kid = private_key_id");
    const iat = Math.floor(NOW.getTime() / 1000);
    t(cl.iss === CLIENT_EMAIL && cl.scope === GSC_SCOPE && cl.aud === GSC_TOKEN_URL && cl.iat === iat && cl.exp === iat + 3600 &&
      Object.keys(cl).sort().join(",") === "aud,exp,iat,iss,scope",
      "J3: claims iss, scope webmasters.readonly, aud token URL, iat, exp = iat + 1 h (no sub)");
    t(GSC_SCOPE === "https://www.googleapis.com/auth/webmasters.readonly", "J4: the scope is read-only");
    const sigOk = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), PUB_PEM, Buffer.from(parts[2], "base64url"));
    t(sigOk, "J5: the signature verifies with the public key (RSASSA-PKCS1-v1_5 SHA-256)");
    const tampered = Buffer.from(JSON.stringify({ ...cl, scope: "https://www.googleapis.com/auth/webmasters" })).toString("base64url");
    t(!crypto.verify("sha256", Buffer.from(`${parts[0]}.${tampered}`), PUB_PEM, Buffer.from(parts[2], "base64url")), "J6: a changed claim does not verify");

    // ── token exchange ──
    const tf = fakeApis();
    const tok = await exchangeGscToken(creds, { fetchImpl: tf.fetchImpl, now: () => NOW });
    const treq = tf.calls[0];
    const form = new URLSearchParams(treq.init.body);
    t(tok.ok && tok.accessToken === ACCESS_TOKEN && tf.calls.length === 1, "T1: the token endpoint answer gives the access token");
    t(treq.url.href === "https://oauth2.googleapis.com/token" && treq.init.method === "POST" &&
      treq.init.headers["Content-Type"] === "application/x-www-form-urlencoded",
      "T2: POST to https://oauth2.googleapis.com/token, form-encoded");
    t(form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && [...form.keys()].sort().join(",") === "assertion,grant_type",
      "T3: body is grant_type=jwt-bearer and assertion only");
    const a = String(form.get("assertion")).split(".");
    t(crypto.verify("sha256", Buffer.from(`${a[0]}.${a[1]}`), PUB_PEM, Buffer.from(a[2], "base64url")) && dec(a[1]).iss === CLIENT_EMAIL,
      "T4: the assertion is the signed JWT");
    const tokFail = async (reply: Reply) => {
      const r = await exchangeGscToken(creds, { fetchImpl: fakeApis({ token: () => reply }).fetchImpl, now: () => NOW });
      return r.ok ? null : r.failure;
    };
    const f1 = await tokFail({ status: 400, body: { error: "invalid_grant", error_description: `Invalid JWT Signature. ${CLIENT_EMAIL}` } });
    t(f1?.status === "auth_failed" && f1.reason === "invalid_grant" && !JSON.stringify(f1).includes(CLIENT_EMAIL),
      "T5: 400 invalid_grant -> auth_failed invalid_grant (error_description not passed on)");
    const f2 = await tokFail({ status: 401, body: { error: "invalid_client" } });
    t(f2?.status === "auth_failed" && f2.reason === "invalid_client", "T6: 401 invalid_client -> auth_failed");
    const f3 = await tokFail({ status: 400, body: { error: "invalid_scope" } });
    t(f3?.status === "error" && f3.reason === "invalid_scope", "T7: invalid_scope -> error (not the key's fault)");
    const f4 = await tokFail({ status: 503, raw: "<html>busy</html>" });
    t(f4?.status === "error" && f4.reason === "http_503", "T8: 5xx -> error http_503");
    const f5 = await tokFail({ status: 200, body: { token_type: "Bearer" } });
    t(f5?.status === "error" && f5.reason === "unexpected_response", "T9: 200 without access_token -> unexpected_response");
    const f6 = await tokFail({ status: 400, body: { error: "something_new" } });
    t(f6?.status === "error" && f6.reason === "http_400", "T10: an unknown OAuth error is http_400, never the server's string");

    // ── properties ──
    const entries = parseGscSites({
      siteEntry: [
        { siteUrl: "http://rettfrabonden.com/", permissionLevel: "siteOwner" },
        { siteUrl: "https://rettfrabonden.com/", permissionLevel: "siteRestrictedUser" },
        { siteUrl: "https://www.rettfrabonden.com/", permissionLevel: "siteRestrictedUser" },
        { siteUrl: "https://rettfrabonden.com/blog/", permissionLevel: "siteOwner" },
        { siteUrl: "sc-domain:opplevagent.no", permissionLevel: "siteUnverifiedUser" },
        { siteUrl: "https://opplevagent.no/", permissionLevel: "siteRestrictedUser" },
        { siteUrl: "sc-domain:finn-tannlege.com", permissionLevel: "siteRestrictedUser" },
        { siteUrl: "https://finn-tannlege.com/", permissionLevel: "siteOwner" },
        { siteUrl: "sc-domain:finn-tannlege.com.evil.no", permissionLevel: "siteOwner" },
        { permissionLevel: "siteOwner" },
      ],
    });
    t(entries?.length === 9, "S1: sites.list entries parsed (an entry without siteUrl is dropped)");
    t(matchGscProperty("rettfrabonden.com", entries!)?.siteUrl === "https://rettfrabonden.com/" &&
      matchGscProperty("rettfrabonden.com", entries!.filter((e) => e.siteUrl !== "https://rettfrabonden.com/"))?.siteUrl === "https://www.rettfrabonden.com/" &&
      matchGscProperty("rettfrabonden.com", [entries![3]]) === null,
      "S2: URL-prefix root properties match (https bare > https www > http); a sub-path property never matches");
    t(matchGscProperty("opplevagent.no", entries!)?.siteUrl === "https://opplevagent.no/",
      "S3: a readable URL-prefix property wins over an unverified Domain property");
    t(matchGscProperty("finn-tannlege.com", entries!)?.siteUrl === "sc-domain:finn-tannlege.com",
      "S4: a Domain property (sc-domain:) wins over a URL-prefix one at equal access; look-alike hosts never match");
    t(gscHasAccess({ siteUrl: "x", permissionLevel: "siteRestrictedUser" }) && gscHasAccess({ siteUrl: "x", permissionLevel: "siteFullUser" }) &&
      gscHasAccess({ siteUrl: "x", permissionLevel: "siteOwner" }) && !gscHasAccess({ siteUrl: "x", permissionLevel: "siteUnverifiedUser" }) &&
      !gscHasAccess(null), "S5: siteRestrictedUser counts as access; siteUnverifiedUser does not");
    t(parseGscSites({})?.length === 0 && parseGscSites({ siteEntry: "x" }) === null && parseGscSites(null) === null,
      "S6: no siteEntry = no sites; a malformed body -> null");
    t(matchGscProperty("rettfrabonden.com", [{ siteUrl: "https://rettfrabonden.com/", permissionLevel: "siteUnverifiedUser" }])?.permissionLevel === "siteUnverifiedUser",
      "S7: an unreadable property is still reported (so the admin view can say which level it has)");

    const cf = fakeApis();
    const chk = await checkGsc(creds, { fetchImpl: cf.fetchImpl, now: () => NOW });
    t(chk.ok && chk.status === "ok" && chk.properties === 3, "S8: checkGsc: all three readable (restricted / full) -> ok, 3");
    t(chk.ok && chk.matches["rettfrabonden.com"]?.siteUrl === "https://rettfrabonden.com/" && chk.matches["opplevagent.no"]?.siteUrl === "sc-domain:opplevagent.no",
      "S9: URL-prefix and Domain properties both resolved from the list (nothing hardcoded)");
    t(cf.calls.length === 2 && cf.calls[1].init.method === "GET" && cf.calls[1].url.href === "https://www.googleapis.com/webmasters/v3/sites" &&
      cf.calls[1].init.headers.Authorization === `Bearer ${ACCESS_TOKEN}`, "S10: token, then GET …/webmasters/v3/sites with the bearer token");
    const siteFail = async (reply: Reply) => {
      const r = await checkGsc(creds, { fetchImpl: fakeApis({ sites: () => reply }).fetchImpl, now: () => NOW });
      return r.ok ? null : r.failure;
    };
    const s403 = await siteFail({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }] } } });
    t(s403?.status === "auth_failed" && s403.reason === "api_disabled", "S11: 403 accessNotConfigured -> auth_failed api_disabled (API not enabled in the project)");
    const s403b = await siteFail({ status: 403, body: { error: { code: 403, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }] } } });
    t(s403b?.reason === "api_disabled", "S12: 403 SERVICE_DISABLED -> api_disabled");
    const s401 = await siteFail({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } });
    t(s401?.status === "auth_failed" && s401.reason === "http_401", "S13: 401 -> auth_failed http_401");
    const sNet = await siteFail(new TypeError("fetch failed"));
    t(sNet?.status === "error" && sNet.reason === "network", "S14: network error -> error network");
    const sTo = await siteFail(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    t(sTo?.status === "error" && sTo.reason === "timeout", "S15: timeout -> error timeout");
    const sBad = await siteFail({ status: 200, raw: "<html>" });
    t(sBad?.status === "error" && sBad.reason === "invalid_json", "S16: 200 non-JSON -> error invalid_json");

    // ── Search Analytics ──
    const qf = fakeApis();
    const wk = await fetchGscWeek(ACCESS_TOKEN, "sc-domain:opplevagent.no", searchConsoleWeekRange(WEEK), { fetchImpl: qf.fetchImpl });
    const q0 = JSON.parse(qf.calls[0].init.body);
    const q1 = JSON.parse(qf.calls[1].init.body);
    t(qf.calls.length === 2 && qf.calls.every((c) => c.init.method === "POST" && c.url.href ===
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aopplevagent.no/searchAnalytics/query" &&
      c.init.headers.Authorization === `Bearer ${ACCESS_TOKEN}`), "Q1: one POST per breakdown to …/sites/{encoded siteUrl}/searchAnalytics/query");
    t(q0.startDate === "2026-10-05" && q0.endDate === "2026-10-11" && q0.type === "web" && q0.dataState === "final" && !q0.dimensionFilterGroups && !q0.dimensions,
      "Q2: Monday–Sunday, type web, final data, no dimensions (one aggregated row)");
    t(JSON.stringify(q1.dimensionFilterGroups) === JSON.stringify([{ groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "nor" }] }]),
      "Q3: the country:nor breakdown filters country equals nor");
    const v = (m: string, d: string) => (wk.ok ? wk.rows.find((r) => r.metric === m && r.dimension === d)?.value : undefined);
    t(wk.ok && wk.rows.length === 8 && v("clicks", "total") === 10 && v("impressions", "total") === 200 && v("ctr", "total") === 0.05 &&
      v("position", "total") === 7.5 && v("clicks", "country:nor") === 8, "Q4: four metrics per breakdown stored as returned");
    const ef = fakeApis({ query: () => ({ status: 200, body: { responseAggregationType: "byProperty" } }) });
    const ew = await fetchGscWeek(ACCESS_TOKEN, "https://rettfrabonden.com/", searchConsoleWeekRange(WEEK), { fetchImpl: ef.fetchImpl });
    t(ew.ok && ew.rows.length === 4 && ew.rows.every((r) => (r.metric === "clicks" || r.metric === "impressions") && r.value === 0) &&
      ef.calls[0].url.pathname.endsWith("/sites/https%3A%2F%2Frettfrabonden.com%2F/searchAnalytics/query"),
      "Q5: no rows = 0 clicks and 0 impressions, no ctr/position; a URL-prefix siteUrl is path-encoded");
    const qFail = await fetchGscWeek(ACCESS_TOKEN, "x", searchConsoleWeekRange(WEEK), { fetchImpl: fakeApis({ query: () => ({ status: 429, raw: "" }) }).fetchImpl });
    t(!qFail.ok && qFail.failure.reason === "http_429", "Q6: a failing query fails the week");

    // ── week, kill switch, redaction ──
    t(targetSearchConsoleWeek(NOW) === WEEK, "W1: Saturday 2026-10-17 -> week of Monday 2026-10-05");
    t(targetSearchConsoleWeek(new Date("2026-10-15T00:00:00Z")) === "2026-10-05" && targetSearchConsoleWeek(new Date("2026-10-14T23:59:59Z")) === "2026-09-28",
      "W2: a week is due once its Sunday is 4 days old (Thursday), not before");
    t(targetSearchConsoleWeek(new Date("2026-01-03T12:00:00Z")) === "2025-12-22", "W3: across New Year");
    t(JSON.stringify(searchConsoleWeekRange(WEEK)) === JSON.stringify({ start: "2026-10-05", end: "2026-10-11" }), "W4: range Monday..Sunday");
    t(isSearchConsoleFetchEnabled({}) && isSearchConsoleFetchEnabled({ SEARCH_CONSOLE_FETCH_ENABLED: "1" }) && isSearchConsoleFetchEnabled({ SEARCH_CONSOLE_FETCH_ENABLED: "" }),
      "W5: on by default (unset, 1, empty)");
    t(["0", "false", " OFF ", "no"].every((x) => !isSearchConsoleFetchEnabled({ SEARCH_CONSOLE_FETCH_ENABLED: x })), "W6: 0 / false / off / no turn it off");
    t(redactSecrets(`a ${BING_KEY} b ${PRIV_PEM} c`, [BING_KEY]) === "a [redacted] b [redacted]\n c" && redactSecrets("short x", ["x"]) === "short x",
      "W7: redactSecrets removes given values (8+ chars) and PEM blocks");

    // ── job: missing secrets, kill switch ──
    {
      const f = fakeApis();
      const s = await job(newDb(), f, {});
      t(s.skipped === "unconfigured" && f.calls.length === 0, "R1: no secrets -> skipped, 0 calls");
      const h = health({});
      t(h.gsc.status === "unconfigured" && h.bing.status === "unconfigured" && h.gsc.properties === null && h.bing.sites === null && h.enabled,
        "R2: /health: both unconfigured");
      const off = fakeApis();
      const s2 = await job(newDb(), off, { ...ENV_BOTH, SEARCH_CONSOLE_FETCH_ENABLED: "0" });
      t(s2.skipped === "disabled" && off.calls.length === 0, "R3: kill switch -> skipped disabled, 0 calls (check and fetch)");
      t(health({ ...ENV_BOTH, SEARCH_CONSOLE_FETCH_ENABLED: "0" }).enabled === false, "R4: /health shows enabled:false under the kill switch");
    }

    // ── job: the happy path, status transitions, idempotent weekly upsert ──
    {
      __resetSearchConsolesForTesting();
      const db = newDb();
      const h0 = health();
      t(h0.gsc.status === "pending" && h0.bing.status === "pending" && h0.gsc.checkedAt === null, "R5: secrets set, nothing run yet -> pending");

      // A run in flight: /health stays synchronous, makes no call and still says pending.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const base = fakeApis();
      const slow = stubFetch(async (url, init) => {
        await gate;
        const r = await base.fetchImpl(url, init);
        return { status: r.status, raw: await r.text() };
      });
      const inflight = runSearchConsoleJob({ env: ENV_BOTH, db, fetchImpl: slow.fetchImpl, now: () => NOW, log });
      await tick();
      const callsBefore = slow.calls.length;
      const hMid = getSearchConsolesHealth({ env: ENV_BOTH });
      t(!(hMid as any)?.then && hMid.gsc.status === "pending" && slow.calls.length === callsBefore,
        "R6: /health during a run: synchronous, no network call, still pending");
      const again = await runSearchConsoleJob({ env: ENV_BOTH, db, fetchImpl: slow.fetchImpl, now: () => NOW, log });
      t(again.skipped === "already_running", "R7: a second run while one is in flight is skipped");
      release();
      const s1 = await inflight;
      emitted.push(JSON.stringify(s1));
      t(s1.week === WEEK && s1.gsc?.status === "ok" && s1.gsc.count === 3 && s1.gsc.fetched === 3 && s1.gsc.rows === 24,
        "R8: gsc ok, 3 properties, 3 domains × 2 breakdowns × 4 metrics = 24 rows");
      t(s1.bing?.status === "ok" && s1.bing.count === 3 && s1.bing.fetched === 3 && s1.bing.rows === 12, "R9: bing ok, 3 sites, 3 × 4 rows");
      const h1 = health();
      t(h1.gsc.status === "ok" && h1.gsc.properties === 3 && h1.gsc.checkedAt === NOW.toISOString() && h1.gsc.reason === null &&
        h1.bing.status === "ok" && h1.bing.sites === 3 && h1.bing.checkedAt === NOW.toISOString(), "R10: /health after the run: ok, counts, checkedAt");
      t(Object.keys(h1).join(",") === "enabled,gsc,bing" && Object.keys(h1.gsc).join(",") === "status,properties,checkedAt,reason" &&
        Object.keys(h1.bing).join(",") === "status,sites,checkedAt,reason", "R11: /health field shape {enabled, gsc{status,properties,checkedAt,reason}, bing{status,sites,checkedAt,reason}}");
      const count = () => (db.prepare("SELECT COUNT(*) AS c FROM search_console_weekly").get() as { c: number }).c;
      t(count() === 36, "R12: 36 rows stored for the week");
      const row = db.prepare("SELECT * FROM search_console_weekly WHERE domain = 'finn-tannlege.com' AND source = 'bing' AND metric = 'sitemaps'").get() as any;
      t(row && row.week === WEEK && row.dimension === "total" && row.value === 0 && row.fetched_at === NOW.toISOString(),
        "R13: Bing sitemap count 0 for finn-tannlege.com stored with its date");
      t(logs.some((l) => /^\[search-consoles\] week=2026-10-05 gsc=ok properties=3 fetched=3 rows=24 bing=ok sites=3 fetched=3 rows=12$/.test(l)),
        "R14: one summary log line per run");

      // Next day: the check runs again, the stored week is not fetched again.
      const f2 = fakeApis();
      const later = new Date("2026-10-18T12:00:00.000Z");
      const s2 = await job(db, f2, ENV_BOTH, later);
      const queries = f2.calls.filter((c) => c.url.pathname.endsWith("/searchAnalytics/query") || /GetRankAndTrafficStats|GetFeeds/.test(c.url.pathname));
      t(s2.gsc?.fetched === 0 && s2.bing?.fetched === 0 && queries.length === 0 && f2.calls.length === 3 && count() === 36,
        "R15: next run: only the 3 check calls; the stored week is not refetched; still 36 rows");
      t(health().gsc.checkedAt === later.toISOString(), "R16: checkedAt moves with every check");

      // Upsert is idempotent and updates in place.
      const at2 = "2026-10-18T13:00:00.000Z";
      upsertSearchConsoleRows(db, "gsc", "rettfrabonden.com", WEEK, [{ metric: "clicks", dimension: "total", value: 11 }], at2);
      upsertSearchConsoleRows(db, "gsc", "rettfrabonden.com", WEEK, [{ metric: "clicks", dimension: "total", value: 11 }], at2);
      const r2 = db.prepare("SELECT value, fetched_at FROM search_console_weekly WHERE domain = 'rettfrabonden.com' AND source = 'gsc' AND metric = 'clicks' AND dimension = 'total' AND week = ?").get(WEEK) as any;
      t(count() === 36 && r2.value === 11 && r2.fetched_at === at2, "R17: upsert twice -> same row count, value and fetched_at updated");
      ensureSearchConsoleWeeklyTable(db);
      t(count() === 36, "R18: ensuring the table again keeps the rows");

      // The admin view for that week.
      const view = getSearchConsoleWeekView({ db, week: "2026-10-08", env: ENV_BOTH, now: NOW });
      emitted.push(JSON.stringify(view));
      t(view.week === WEEK && view.weekEnd === "2026-10-11" && view.latestCompleteWeek === WEEK, "R19: ?week=Thursday -> its Monday");
      t(view.domains.length === 3 && view.domains.every((d) => d.gsc.rows.length === 8 && d.bing.rows.length === 4 && d.gsc.unavailable === null && d.bing.unavailable === null),
        "R20 (AC2): rows for all three domains from both sources");
      const ft = view.bing.sitemaps["finn-tannlege.com"];
      t(ft.count === 0 && typeof ft.checkedAt === "string" && ft.checkedAt.length > 0 && view.bing.sitemaps["rettfrabonden.com"].count === 1 &&
        view.bing.sitemaps["rettfrabonden.com"].urls === 500, "R21 (AC4): bing.sitemaps for finn-tannlege.com: count ≥ 0 and a date");
      t(view.domains[0].gsc.property === "https://rettfrabonden.com/" && view.domains[0].gsc.permissionLevel === "siteRestrictedUser" &&
        view.domains[1].gsc.property === "sc-domain:opplevagent.no" && view.domains[2].bing.site === "https://finn-tannlege.com/" && view.domains[2].bing.verified === true,
        "R22: the view names each property and its access level");
      t(JSON.stringify(view.storedWeeks) === JSON.stringify([WEEK]) && view.status.gsc.status === "ok", "R23: stored weeks and the /health status are included");
      const future = getSearchConsoleWeekView({ db, week: "2026-10-12", env: ENV_BOTH, now: NOW });
      t(future.domains.every((d) => d.gsc.unavailable === "week_not_complete" && d.bing.unavailable === "week_not_complete") &&
        future.bing.sitemaps["finn-tannlege.com"].unavailable === "week_not_complete", "R24: a week that is not complete -> week_not_complete");
      const older = getSearchConsoleWeekView({ db, week: "2026-09-28", env: ENV_BOTH, now: NOW });
      t(older.domains.every((d) => d.gsc.unavailable === "not_fetched"), "R25: an older week that was never fetched -> not_fetched");
    }

    // ── job: no_access, auth_failed, error, fetch failure and retry ──
    {
      __resetSearchConsolesForTesting();
      const db = newDb();
      const f = fakeApis({
        sites: () => ({ status: 200, body: { siteEntry: [GSC_SITES_ALL[0], GSC_SITES_ALL[1], { siteUrl: "sc-domain:finn-tannlege.com", permissionLevel: "siteUnverifiedUser" }] } }),
        bingSites: () => ({ status: 200, body: { d: [BING_SITES_ALL[0], bingSite("https://opplevagent.no/", false)] } }),
      });
      const s = await job(db, f);
      t(s.gsc?.status === "no_access" && s.gsc.count === 2 && s.gsc.fetched === 2 && s.bing?.status === "no_access" && s.bing.count === 1 && s.bing.fetched === 1,
        "N1: fewer than 3 readable -> no_access with the count; only readable domains are fetched");
      t(!f.calls.some((c) => decodeURIComponent(c.url.pathname).includes("finn-tannlege")) &&
        !f.calls.some((c) => (c.url.searchParams.get("siteUrl") || "").includes("opplevagent")), "N2: no query for a domain without access");
      const h = health();
      t(h.gsc.status === "no_access" && h.gsc.properties === 2 && h.bing.status === "no_access" && h.bing.sites === 1, "N3: /health: no_access with counts");
      const view = getSearchConsoleWeekView({ db, week: WEEK, env: ENV_BOTH, now: NOW });
      emitted.push(JSON.stringify(view));
      const ft = view.domains.find((d) => d.domain === "finn-tannlege.com")!;
      t(ft.gsc.unavailable === "no_access" && ft.gsc.permissionLevel === "siteUnverifiedUser" && ft.bing.unavailable === "no_access" && ft.bing.site === null,
        "N4: the view says no_access per domain and source");
      t(view.bing.sitemaps["finn-tannlege.com"].count === null && view.bing.sitemaps["finn-tannlege.com"].unavailable === "no_access",
        "N5: bing.sitemaps without access -> count null with the reason");
    }
    {
      __resetSearchConsolesForTesting();
      const db = newDb();
      const f = fakeApis({
        token: () => ({ status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } }),
        bingSites: () => ({ status: 400, body: { ErrorCode: 3, Message: "InvalidApiKey" } }),
      });
      const s = await job(db, f);
      t(s.gsc?.status === "auth_failed" && s.gsc.reason === "invalid_grant" && s.gsc.count === null && s.bing?.status === "auth_failed" &&
        s.bing.reason === "bing_InvalidApiKey" && f.calls.length === 2, "A1: rejected key -> auth_failed (invalid_grant / bing_InvalidApiKey), no further calls");
      const h = health();
      t(h.gsc.status === "auth_failed" && h.gsc.reason === "invalid_grant" && h.gsc.properties === null && h.bing.reason === "bing_InvalidApiKey",
        "A2: /health: auth_failed with the code");
      const view = getSearchConsoleWeekView({ db, week: WEEK, env: ENV_BOTH, now: NOW });
      emitted.push(JSON.stringify(view));
      t(view.domains.every((d) => d.gsc.unavailable === "auth_failed" && d.gsc.detail === "invalid_grant" && d.bing.unavailable === "auth_failed"),
        "A3: the view gives auth_failed per domain");
      t(logs.some((l) => l.includes("gsc=auth_failed(invalid_grant) properties=-")), "A4: the log line carries the code only");

      const badKey = await job(newDb(), fakeApis(), { GSC_SERVICE_ACCOUNT_JSON: `{"private_key":"${PEM_LINE}",` });
      t(badKey.gsc?.status === "auth_failed" && badKey.gsc.reason === "invalid_key_json" && badKey.bing === undefined,
        "A5: an unreadable key -> auth_failed invalid_key_json without any call; bing unconfigured");
      t(logs[logs.length - 1].includes("bing=unconfigured"), "A6: the log line says which source is unconfigured");
      const h2 = health({ GSC_SERVICE_ACCOUNT_JSON: "x" });
      t(h2.bing.status === "unconfigured" && h2.gsc.status === "auth_failed", "A7: only one secret set -> the other source is unconfigured");
    }
    {
      __resetSearchConsolesForTesting();
      const db = newDb();
      const s = await job(db, fakeApis({ sites: () => new TypeError("fetch failed"), bingSites: () => ({ status: 502, raw: "" }) }));
      t(s.gsc?.status === "error" && s.gsc.reason === "network" && s.bing?.status === "error" && s.bing.reason === "http_502",
        "E1: network / 5xx -> error with the code");

      __resetSearchConsolesForTesting();
      let failOpp = true;
      const flaky = () => fakeApis({
        query: (siteUrl, body) => failOpp && siteUrl === "sc-domain:opplevagent.no"
          ? { status: 500, raw: "" }
          : { status: 200, body: { rows: [{ clicks: 1, impressions: 2, ctr: 0.5, position: 3 }] } },
      });
      const fl = flaky();
      const s2 = await job(db, fl);
      t(s2.gsc?.status === "error" && s2.gsc.reason === "fetch_http_500" && s2.gsc.count === 3 && s2.gsc.fetched === 2,
        "E2: one domain's fetch fails -> status error (fetch_http_500), the other two stored");
      const view = getSearchConsoleWeekView({ db, week: WEEK, env: ENV_BOTH, now: NOW });
      const opp = view.domains.find((d) => d.domain === "opplevagent.no")!;
      t(opp.gsc.unavailable === "fetch_failed" && opp.gsc.detail === "http_500", "E3: the view: fetch_failed with the code");
      failOpp = false;
      const fl2 = flaky();
      const s3 = await job(db, fl2);
      const queried = fl2.calls.filter((c) => c.url.pathname.endsWith("/searchAnalytics/query")).map((c) => decodeURIComponent(c.url.pathname.split("/")[4]));
      t(s3.gsc?.status === "ok" && s3.gsc.fetched === 1 && queried.length === 2 && queried.every((q) => q === "sc-domain:opplevagent.no"),
        "E4: next run retries only the failed domain, then ok");
    }

    // ── scheduler ──
    {
      __resetSearchConsolesForTesting();
      const timers: Array<{ kind: string; fn: () => void; ms: number }> = [];
      const fakeSet = (kind: string) => (fn: () => void, ms: number) => { timers.push({ kind, fn, ms }); return { unref() {} }; };
      const slogs: string[] = [];
      const sOff = startSearchConsoleScheduler({ getDb: newDb, env: { ...ENV_BOTH, SEARCH_CONSOLE_FETCH_ENABLED: "0" }, log: (m) => slogs.push(m), setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i") });
      t(!sOff.started && timers.length === 0 && slogs.length === 1 && slogs[0].includes("SEARCH_CONSOLE_FETCH_ENABLED=0"), "SC1: kill switch -> one log line, nothing scheduled");
      const sNone = startSearchConsoleScheduler({ getDb: newDb, env: {}, log: (m) => slogs.push(m), setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i") });
      t(!sNone.started && timers.length === 0 && slogs.length === 2 && /skipped: GSC_SERVICE_ACCOUNT_JSON and BING_WEBMASTER_API_KEY are not set/.test(slogs[1]),
        "SC2: no secrets -> one log line, nothing scheduled");
      const f = fakeApis();
      const db = newDb();
      const sOn = startSearchConsoleScheduler({
        getDb: () => db, env: ENV_BOTH, log, setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i"), run: { fetchImpl: f.fetchImpl, now: () => NOW },
      });
      t(sOn.started && timers.length === 2 && timers[0].kind === "t" && timers[0].ms === SEARCH_CONSOLE_BOOT_DELAY_MS &&
        timers[1].kind === "i" && timers[1].ms === SEARCH_CONSOLE_CHECK_INTERVAL_MS && f.calls.length === 0,
        "SC3: keys set -> first run after the boot delay, then every 24 h; nothing at once");
      t(SEARCH_CONSOLE_BOOT_DELAY_MS === 2 * 60_000 && SEARCH_CONSOLE_BOOT_DELAY_MS > TRAFFIC_PREWARM_BOOT_DELAY_MS && SEARCH_CONSOLE_BOOT_DELAY_MS < DENTAL_GEOCODE_BOOT_DELAY_MS &&
        SEARCH_CONSOLE_CHECK_INTERVAL_MS === 24 * 3600_000, "SC4: 2 min, in the free slot between the prewarm (1 min) and the geocode (3 min)");
      // The run waits for a boot job that already holds the exclusive gate.
      let releaseBlocker!: () => void;
      const blocker = runExclusiveBootJob(() => new Promise<void>((r) => { releaseBlocker = r; }));
      timers[0].fn();
      await tick(); await tick();
      t(f.calls.length === 0, "SC5: the run queues behind a boot job holding the gate");
      releaseBlocker();
      await blocker;
      await runExclusiveBootJob(() => undefined);
      t(f.calls.length === 15 && health().gsc.status === "ok", "SC6: once the gate is free the run checks and fetches (8 Google + 7 Bing calls)");
      sOn.stop();
      // A failing run is logged without secrets (console.error captured for this step only).
      const errOutLines: string[] = [];
      const sErr = startSearchConsoleScheduler({
        getDb: () => { throw new Error(`db unavailable ${BING_KEY} ${PRIV_PEM}`); }, env: ENV_BOTH, log, setTimeoutFn: fakeSet("t"), setIntervalFn: fakeSet("i"),
      });
      console.error = ((...a: unknown[]) => { errOutLines.push(a.map(String).join(" ")); }) as any;
      try {
        timers[timers.length - 2].fn();
        await runExclusiveBootJob(() => undefined);
        await tick();
      } finally {
        console.error = realConsoleError;
      }
      emitted.push(...errOutLines);
      const errOut = errOutLines.join("\n");
      t(/\[search-consoles\] run failed \(non-fatal\): Error: db unavailable \[redacted\] \[redacted\]/.test(errOut), "SC7: a failed run is logged, secrets redacted");
      sErr.stop();
    }

    // ── admin route ──
    {
      __resetSearchConsolesForTesting();
      const initMod = require("../database/init") as typeof import("../database/init");
      const restoreDb = initMod.__pinInMemoryDbForTesting();
      const rdb = initMod.getDb();
      const prevEnv = { a: process.env.ADMIN_KEY, b: process.env.ANALYTICS_ADMIN_KEY };
      try {
        await job(rdb, fakeApis());
        const router = (require("../routes/admin-search-consoles") as typeof import("../routes/admin-search-consoles")).default;
        delete process.env.ADMIN_KEY;
        delete process.env.ANALYTICS_ADMIN_KEY;
        const r503 = await callRoute(router, `/?week=${WEEK}`, { "x-admin-key": "k" });
        t(r503.status === 503, "AD1: no admin key configured -> 503");
        process.env.ADMIN_KEY = "test-admin-key-1234";
        const r401 = await callRoute(router, `/?week=${WEEK}`, { "x-admin-key": "wrong" });
        const r401b = await callRoute(router, `/?week=${WEEK}`);
        t(r401.status === 401 && r401b.status === 401, "AD2: wrong / missing X-Admin-Key -> 401");
        const ok = await callRoute(router, `/?week=${WEEK}`, { "x-admin-key": "test-admin-key-1234" });
        emitted.push(JSON.stringify(ok.body));
        t(ok.status === 200 && ok.body.week === WEEK && ok.body.domains.length === 3 &&
          ok.body.domains.every((d: any) => d.gsc.rows.length > 0 && d.bing.rows.length > 0) && ok.body.bing.sitemaps["finn-tannlege.com"].count === 0,
          "AD3 (AC2/AC4): 200 with rows for all three domains from both sources and bing.sitemaps");
        const def = await callRoute(router, "/", { "x-admin-key": "test-admin-key-1234" });
        t(def.status === 200 && def.body.week === targetSearchConsoleWeek(new Date()), "AD4: no week -> the latest complete week");
        const bad = await Promise.all(["/?week=2026-13-01", "/?week=abc", "/?week=2026-W41"].map((u) => callRoute(router, u, { "x-admin-key": "test-admin-key-1234" })));
        t(bad.every((b) => b.status === 400), "AD5: a week that is not YYYY-MM-DD -> 400");
      } finally {
        if (prevEnv.a === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevEnv.a;
        if (prevEnv.b === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevEnv.b;
        restoreDb();
      }
    }

    // ── init.ts creates the same table ──
    {
      const initMod = require("../database/init") as typeof import("../database/init");
      const viaInit = newDb();
      initMod.__initSchemaForTesting(viaInit);
      const viaModule = newDb();
      viaModule.exec(SEARCH_CONSOLE_WEEKLY_DDL);
      viaModule.exec(SEARCH_CONSOLE_WEEKLY_INDEX_DDL);
      const shape = (d: Database.Database) => JSON.stringify({
        cols: d.prepare("PRAGMA table_info(search_console_weekly)").all(),
        idx: (d.prepare("PRAGMA index_list(search_console_weekly)").all() as any[]).map((i) => ({
          unique: i.unique, cols: (d.prepare(`PRAGMA index_info('${i.name}')`).all() as any[]).map((c) => c.name),
          name: i.origin === "c" ? i.name : "(auto)",
        })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      });
      t(shape(viaInit) === shape(viaModule) && shape(viaInit).includes('"week"'), "DB1: init.ts and the module create the same table, unique key and week index");
    }

    // ── wiring in src/index.ts ──
    {
      const idx = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
      const start = idx.indexOf('app.get("/health"');
      const end = idx.indexOf("responseMs,\n    });", start);
      const healthBlock = start >= 0 && end > start ? idx.slice(start, end) : "";
      t(/\n\s+searchConsoles: getSearchConsolesHealth\(\),\n/.test(healthBlock), "IX1: /health returns searchConsoles: getSearchConsolesHealth()");
      t(["eventLoop: getEventLoopSummary(),", "catalog: getHealthCatalog(),", "writePath,", "offsiteBackup: getOffsiteBackupHealth(),"].every((f) => healthBlock.includes(f)),
        "IX2: the existing /health fields are all still there (the field is additive)");
      t(getSearchConsolesHealth.constructor.name !== "AsyncFunction" && !/await[^\n]*getSearchConsolesHealth/.test(healthBlock),
        "IX3: /health does not await it (it is synchronous)");
      const mount = idx.indexOf('app.use("/admin/analytics/search-consoles", adminLimiter, adminSearchConsolesRoutes);');
      t(mount > 0 && mount < idx.indexOf('app.use("/admin/analytics", analyticsRoutes);'), "IX4: the admin route is mounted (with adminLimiter) before /admin/analytics");
      t(/startSearchConsoleScheduler\(\{ getDb: \(\) => getDb\(\) \}\);/.test(idx), "IX5: index.ts starts the scheduler");
    }

    // ── no secret anywhere ──
    const out = emitted.join("\n");
    const leaked = SECRET_MARKERS.filter((s) => out.includes(s));
    t(emitted.length > 20 && leaked.length === 0,
      `SEC1: no key, key line, e-mail, token, key id or verification code in ${emitted.length} captured logs / errors / /health / admin JSON` +
      (leaked.length ? ` (leaked: ${leaked.map((s) => s.slice(0, 12)).join(", ")})` : ""));
    t(!/BEGIN [A-Z ]*PRIVATE KEY/.test(out) && !out.includes("iam.gserviceaccount.com"), "SEC2: no PEM header and no service-account address in any output");
  } catch (err: any) {
    failed++;
    failures.push("search-console-fetch: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.error = realConsoleError;
    __resetSearchConsolesForTesting();
    for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSearchConsoleFetchTests({ log: true }).then((r) => {
    console.log(`\nsearch-console-fetch: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
