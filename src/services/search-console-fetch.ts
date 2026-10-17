// ─── Google Search Console fetch, and the shared GSC/Bing job ───────────────
// A2A dev-request 2026-10-16-gsc-bing-ai-rapporter, S6c, with the 2026-10-17
// amendment «tilkoblingssjekk og offentlig status».
//
// What it does, read-only towards Google and Bing:
//   - Connectivity check, 2 min after boot (boot-job-gate) and then every 24 h:
//       GSC:  RS256 JWT (node:crypto) -> access token (scope webmasters.readonly)
//             -> sites.list -> how many of the three domains are readable, and how;
//       Bing: GetUserSites (bing-webmaster-fetch.ts) -> how many are verified.
//   - Weekly fetch in the same run: the latest complete Monday–Sunday week
//     (once its Sunday is SEARCH_CONSOLE_WEEK_LAG_DAYS old) for every readable
//     domain that has no rows for it yet, upserted into search_console_weekly.
//     A failed domain is simply tried again on the next run.
//   - Status per source in memory, for /health (getSearchConsolesHealth: counts
//     and fixed codes only, no network) and GET /admin/analytics/search-consoles
//     (getSearchConsoleWeekView).
// It runs whenever a key is set. SEARCH_CONSOLE_FETCH_ENABLED=0 turns the check
// and the fetch off. Without keys the scheduler logs one line and does nothing.
//
// Google endpoints (developers.google.com, read 2026-10-17):
//   POST https://oauth2.googleapis.com/token  (identity/protocols/oauth2/service-account, HTTP/REST)
//   GET  https://www.googleapis.com/webmasters/v3/sites  (webmaster-tools/v1/sites/list)
//   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
// permissionLevel siteOwner, siteFullUser and siteRestrictedUser can read a
// property; siteUnverifiedUser cannot. A property is a Domain property
// ("sc-domain:opplevagent.no") or a URL prefix ("https://rettfrabonden.com/");
// both forms are matched, so nothing is hardcoded per site.
//
// Secrets (GSC_SERVICE_ACCOUNT_JSON, BING_WEBMASTER_API_KEY) are read from the
// environment when a run starts and are never logged, stored or returned. The
// access token lives only inside one run. Failures carry fixed reason codes
// (SearchConsoleFailure), never response text or exception messages, and every
// log line also goes through redactSecrets().

import * as crypto from "crypto";
import type Database from "better-sqlite3";
import {
  GSC_BREAKDOWNS,
  GSC_METRICS,
  SEARCH_CONSOLE_CHECK_INTERVAL_MS,
  SEARCH_CONSOLE_DOMAINS,
  SEARCH_CONSOLE_REQUEST_TIMEOUT_MS,
  SEARCH_CONSOLE_WEEK_LAG_DAYS,
  type SearchConsoleDomain,
  type SearchConsoleFailure,
  type SearchConsoleMetricRow,
  type SearchConsoleSource,
  type SearchConsoleStatus,
  type SearchConsoleWeekRange,
} from "../config/search-consoles";
import { addDays, dayOf, weekStartOf } from "./traffic-history-compute";
import { runExclusiveBootJob, SEARCH_CONSOLE_BOOT_DELAY_MS } from "./boot-job-gate";
import { trackJob } from "./event-loop-monitor";
import { checkBing, fetchBingWeek, readBingApiKey } from "./bing-webmaster-fetch";

type Db = Database.Database;

function fail(status: SearchConsoleFailure["status"], reason: string): { ok: false; failure: SearchConsoleFailure } {
  return { ok: false, failure: { status, reason } };
}

// ── GSC credentials and token ─────────────────────────────────────────

export const GSC_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3/";

export interface GscDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export interface GscCredentials {
  clientEmail: string;
  privateKey: crypto.KeyObject;
  keyId: string | null;
}

/** True when the GSC secret is set. Presence only, so /health stays cheap. */
export function hasGscSecret(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GSC_SERVICE_ACCOUNT_JSON || "").trim() !== "";
}

export type GscCredentialsResult = { ok: true; creds: GscCredentials } | { ok: false; failure: SearchConsoleFailure };

/**
 * The service-account key from GSC_SERVICE_ACCOUNT_JSON: the downloaded JSON key as is, or
 * base64 of it. A private_key whose newlines arrived as literal "\n" is repaired. null when the
 * secret is unset. A key that cannot be used is auth_failed with a code only: JSON.parse's
 * message quotes the input, so it is never passed on.
 */
export function readGscCredentials(env: NodeJS.ProcessEnv = process.env): GscCredentialsResult | null {
  const raw = (env.GSC_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  let json: any;
  try {
    json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return fail("auth_failed", "invalid_key_json");
  }
  const clientEmail = typeof json?.client_email === "string" ? json.client_email.trim() : "";
  const pem = typeof json?.private_key === "string" ? json.private_key.replace(/\\n/g, "\n") : "";
  if (!clientEmail.includes("@") || !pem) return fail("auth_failed", "invalid_key_json");
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(pem);
  } catch {
    return fail("auth_failed", "invalid_private_key");
  }
  if (privateKey.asymmetricKeyType !== "rsa") return fail("auth_failed", "invalid_private_key");
  const keyId = typeof json.private_key_id === "string" && /^[0-9a-f]{1,128}$/i.test(json.private_key_id) ? json.private_key_id : null;
  return { ok: true, creds: { clientEmail, privateKey, keyId } };
}

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The signed assertion for the token endpoint: RS256, aud = token URL, valid for one hour. */
export function buildGscJwt(creds: GscCredentials, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(creds.keyId ? { kid: creds.keyId } : {}) };
  const claims = { iss: creds.clientEmail, scope: GSC_SCOPE, aud: GSC_TOKEN_URL, iat, exp: iat + 3600 };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${input}.${base64url(crypto.sign("sha256", Buffer.from(input), creds.privateKey))}`;
}

// OAuth token-endpoint errors (RFC 6749 §5.2) that mean the key itself is not accepted.
const OAUTH_AUTH_ERRORS: ReadonlySet<string> = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"]);
const OAUTH_OTHER_ERRORS: ReadonlySet<string> = new Set(["invalid_request", "invalid_scope", "unsupported_grant_type"]);

/** 403 because the Search Console API is not enabled in the service account's Cloud project. */
function isApiDisabled(body: any): boolean {
  const e = body?.error;
  if (!e || typeof e !== "object") return false;
  const reasons = [
    ...(Array.isArray(e.errors) ? e.errors.map((x: any) => x?.reason) : []),
    ...(Array.isArray(e.details) ? e.details.map((x: any) => x?.reason) : []),
  ];
  return reasons.includes("accessNotConfigured") || reasons.includes("SERVICE_DISABLED");
}

type GoogleResult = { ok: true; body: any } | { ok: false; failure: SearchConsoleFailure };

/** One request to Google (token endpoint or Search Console API). Never throws. */
async function googleRequest(url: string, init: RequestInit, deps: GscDeps): Promise<GoogleResult> {
  let status: number;
  let text: string;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(deps.timeoutMs ?? SEARCH_CONSOLE_REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (err: any) {
    return fail("error", err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network");
  }
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = undefined;
  }
  if (status < 200 || status >= 300) {
    const oauthError = typeof body?.error === "string" ? body.error : null;
    if (oauthError && OAUTH_AUTH_ERRORS.has(oauthError)) return fail("auth_failed", oauthError);
    if (status === 403 && isApiDisabled(body)) return fail("auth_failed", "api_disabled");
    if (status === 401 || status === 403) return fail("auth_failed", `http_${status}`);
    if (oauthError && OAUTH_OTHER_ERRORS.has(oauthError)) return fail("error", oauthError);
    return fail("error", `http_${status}`);
  }
  if (body === undefined) return fail("error", "invalid_json");
  return { ok: true, body };
}

/** JWT -> access token (grant_type jwt-bearer). */
export async function exchangeGscToken(
  creds: GscCredentials,
  deps: GscDeps = {},
): Promise<{ ok: true; accessToken: string } | { ok: false; failure: SearchConsoleFailure }> {
  const assertion = buildGscJwt(creds, (deps.now ?? (() => new Date()))());
  const r = await googleRequest(
    GSC_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    },
    deps,
  );
  if (!r.ok) return r;
  const accessToken = typeof r.body?.access_token === "string" ? r.body.access_token : "";
  return accessToken ? { ok: true, accessToken } : fail("error", "unexpected_response");
}

// ── GSC properties ────────────────────────────────────────────────────

/** permissionLevel values that can read a property's data. */
export const GSC_ACCESS_LEVELS: ReadonlySet<string> = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

/** sites.list body -> entries; null when it is not the documented shape (no siteEntry = no sites). */
export function parseGscSites(body: unknown): GscSiteEntry[] | null {
  if (!body || typeof body !== "object") return null;
  const list = (body as any).siteEntry;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  return list
    .filter((e: any) => e && typeof e.siteUrl === "string")
    .map((e: any) => ({ siteUrl: e.siteUrl, permissionLevel: typeof e.permissionLevel === "string" ? e.permissionLevel : "" }));
}

export function gscHasAccess(entry: GscSiteEntry | null | undefined): boolean {
  return !!entry && GSC_ACCESS_LEVELS.has(entry.permissionLevel);
}

/**
 * The property for `domain`: its Domain property, or a root URL-prefix property of the host or
 * www.host. Readable first, then Domain over URL prefix, https over http, bare host over www.
 */
export function matchGscProperty(domain: string, entries: readonly GscSiteEntry[]): GscSiteEntry | null {
  const want = domain.toLowerCase();
  let best: { entry: GscSiteEntry; score: number } | null = null;
  for (const entry of entries) {
    let score: number;
    if (entry.siteUrl.toLowerCase() === `sc-domain:${want}`) {
      score = 8;
    } else {
      let u: URL;
      try {
        u = new URL(entry.siteUrl);
      } catch {
        continue;
      }
      const host = u.hostname.toLowerCase();
      if ((host !== want && host !== `www.${want}`) || u.pathname !== "/") continue;
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      score = (u.protocol === "https:" ? 2 : 0) + (host === want ? 1 : 0);
    }
    if (gscHasAccess(entry)) score += 16;
    if (!best || score > best.score) best = { entry, score };
  }
  return best ? best.entry : null;
}

export type GscCheckResult =
  | { ok: true; status: "ok" | "no_access"; properties: number; matches: Record<string, GscSiteEntry | null>; accessToken: string }
  | { ok: false; failure: SearchConsoleFailure };

/**
 * Connectivity check: token, then sites.list, then how many of the domains have a readable
 * property. "ok" only when all of them do; otherwise "no_access" with the count.
 */
export async function checkGsc(
  creds: GscCredentials,
  deps: GscDeps = {},
  domains: readonly SearchConsoleDomain[] = SEARCH_CONSOLE_DOMAINS,
): Promise<GscCheckResult> {
  const token = await exchangeGscToken(creds, deps);
  if (!token.ok) return token;
  const r = await googleRequest(
    `${GSC_API_BASE}sites`,
    { method: "GET", headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" } },
    deps,
  );
  if (!r.ok) return r;
  const entries = parseGscSites(r.body);
  if (!entries) return fail("error", "unexpected_response");
  const matches: Record<string, GscSiteEntry | null> = {};
  let readable = 0;
  for (const { domain } of domains) {
    const m = matchGscProperty(domain, entries);
    matches[domain] = m;
    if (gscHasAccess(m)) readable++;
  }
  return {
    ok: true,
    status: readable === domains.length ? "ok" : "no_access",
    properties: readable,
    matches,
    accessToken: token.accessToken,
  };
}

// No row back means no impressions that week: these are 0, ctr and position have no value.
const GSC_ZERO_WHEN_EMPTY: ReadonlySet<string> = new Set(["clicks", "impressions"]);

/** One property's week: one Search Analytics query per GSC_BREAKDOWNS entry (type web, final data). */
export async function fetchGscWeek(
  accessToken: string,
  siteUrl: string,
  week: SearchConsoleWeekRange,
  deps: GscDeps = {},
): Promise<{ ok: true; rows: SearchConsoleMetricRow[] } | { ok: false; failure: SearchConsoleFailure }> {
  const rows: SearchConsoleMetricRow[] = [];
  for (const b of GSC_BREAKDOWNS) {
    const query: Record<string, unknown> = { startDate: week.start, endDate: week.end, type: "web", dataState: "final", rowLimit: 1 };
    if (b.filter) {
      query.dimensionFilterGroups = [
        { groupType: "and", filters: [{ dimension: b.filter.dimension, operator: "equals", expression: b.filter.expression }] },
      ];
    }
    const r = await googleRequest(
      `${GSC_API_BASE}sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(query),
      },
      deps,
    );
    if (!r.ok) return r;
    const list = r.body?.rows;
    if (list !== undefined && !Array.isArray(list)) return fail("error", "unexpected_response");
    const row = list?.[0];
    for (const metric of GSC_METRICS) {
      const v = row ? row[metric] : GSC_ZERO_WHEN_EMPTY.has(metric) ? 0 : undefined;
      if (typeof v === "number" && Number.isFinite(v)) rows.push({ metric, dimension: b.dimension, value: v });
    }
  }
  return { ok: true, rows };
}

// ── Storage ───────────────────────────────────────────────────────────

/** Same DDL as database/init.ts (kept identical; a test compares them), so either path is enough. */
export const SEARCH_CONSOLE_WEEKLY_DDL = `CREATE TABLE IF NOT EXISTS search_console_weekly (
        domain TEXT NOT NULL,
        source TEXT NOT NULL,
        week TEXT NOT NULL,
        metric TEXT NOT NULL,
        dimension TEXT NOT NULL,
        value REAL NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE (domain, source, week, metric, dimension)
      )`;
export const SEARCH_CONSOLE_WEEKLY_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_search_console_weekly_week ON search_console_weekly(week)`;

const ensuredDbs = new WeakSet<object>();

export function ensureSearchConsoleWeeklyTable(db: Db): void {
  if (ensuredDbs.has(db)) return;
  db.exec(SEARCH_CONSOLE_WEEKLY_DDL);
  db.exec(SEARCH_CONSOLE_WEEKLY_INDEX_DDL);
  ensuredDbs.add(db);
}

/** Insert or update one domain's week for one source in a transaction (idempotent). */
export function upsertSearchConsoleRows(
  db: Db,
  source: SearchConsoleSource,
  domain: string,
  week: string,
  rows: readonly SearchConsoleMetricRow[],
  fetchedAt: string,
): void {
  ensureSearchConsoleWeeklyTable(db);
  const stmt = db.prepare(
    `INSERT INTO search_console_weekly (domain, source, week, metric, dimension, value, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain, source, week, metric, dimension)
     DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`,
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(domain, source, week, r.metric, r.dimension, r.value, fetchedAt);
  })();
}

function hasStoredWeek(db: Db, source: SearchConsoleSource, domain: string, week: string): boolean {
  return !!db.prepare("SELECT 1 FROM search_console_weekly WHERE domain = ? AND source = ? AND week = ? LIMIT 1").get(domain, source, week);
}

// ── Week, kill switch, redaction ──────────────────────────────────────

/** Monday of the latest Monday–Sunday week whose Sunday is at least `lagDays` old. */
export function targetSearchConsoleWeek(now: Date, lagDays = SEARCH_CONSOLE_WEEK_LAG_DAYS): string {
  const day = dayOf(now.getTime() - lagDays * 86_400_000);
  return addDays(weekStartOf(addDays(day, 1)), -7);
}

export function searchConsoleWeekRange(weekStart: string): SearchConsoleWeekRange {
  return { start: weekStart, end: addDays(weekStart, 6) };
}

/** On unless SEARCH_CONSOLE_FETCH_ENABLED is 0 / false / off / no. */
export function isSearchConsoleFetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SEARCH_CONSOLE_FETCH_ENABLED ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

const PEM_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Replace PEM private-key blocks and the given secret values (8+ chars) with "[redacted]". */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text.replace(PEM_BLOCK_RE, "[redacted]");
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  return [readBingApiKey(env), (env.GSC_SERVICE_ACCOUNT_JSON || "").trim()].filter((s): s is string => !!s);
}

// ── Run state ─────────────────────────────────────────────────────────

/** What the last successful check saw for one domain (property URL as the console lists it). */
interface DomainState {
  property: string | null;
  permissionLevel: string | null;
  access: boolean;
}

interface SourceState {
  status: SearchConsoleStatus;
  count: number | null;
  checkedAt: string;
  reason: string | null;
  /** False when the check itself failed: `domains` is then empty and status/reason say why. */
  checkOk: boolean;
  domains: Record<string, DomainState>;
}

interface FetchNote {
  week: string;
  ok: boolean;
  reason: string | null;
  at: string;
}

let sourceState: Record<SearchConsoleSource, SourceState | null> = { gsc: null, bing: null };
let lastFetch: Record<SearchConsoleSource, Record<string, FetchNote>> = { gsc: {}, bing: {} };
let running = false;

type SourceCheck =
  | {
      ok: true;
      status: "ok" | "no_access";
      count: number;
      domains: Record<string, DomainState>;
      fetchWeek: (property: string, range: SearchConsoleWeekRange) => Promise<{ ok: true; rows: SearchConsoleMetricRow[] } | { ok: false; failure: SearchConsoleFailure }>;
    }
  | { ok: false; failure: SearchConsoleFailure };

export interface SourceRunSummary {
  status: SearchConsoleStatus;
  count: number | null;
  reason: string | null;
  /** Domains whose week was fetched and stored in this run. */
  fetched: number;
  rows: number;
}

export interface SearchConsoleRunSummary {
  skipped?: "disabled" | "unconfigured" | "already_running";
  week?: string;
  gsc?: SourceRunSummary;
  bing?: SourceRunSummary;
}

export interface SearchConsoleRunOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to the main DB (database/init.ts getDb()). */
  db?: Db;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
  timeoutMs?: number;
  domains?: readonly SearchConsoleDomain[];
}

function defaultDb(): Db {
  // Lazy: keeps this module loadable in tests without opening the prod DB.
  const init = require("../database/init") as typeof import("../database/init");
  return init.getDb();
}

/** Check one source, then fetch the target week for each readable domain that has no rows yet. */
async function runSource(
  source: SearchConsoleSource,
  check: () => Promise<SourceCheck>,
  ctx: { db: Db; week: string; domains: readonly SearchConsoleDomain[]; at: () => string },
): Promise<SourceRunSummary> {
  const c = await check();
  if (!c.ok) {
    sourceState[source] = { status: c.failure.status, count: null, checkedAt: ctx.at(), reason: c.failure.reason, checkOk: false, domains: {} };
    return { status: c.failure.status, count: null, reason: c.failure.reason, fetched: 0, rows: 0 };
  }
  let status: SearchConsoleStatus = c.status;
  let reason: string | null = null;
  let fetched = 0;
  let rows = 0;
  const range = searchConsoleWeekRange(ctx.week);
  for (const { domain } of ctx.domains) {
    const d = c.domains[domain];
    if (!d?.access || !d.property || hasStoredWeek(ctx.db, source, domain, ctx.week)) continue;
    const r = await c.fetchWeek(d.property, range);
    const at = ctx.at();
    if (!r.ok) {
      lastFetch[source][domain] = { week: ctx.week, ok: false, reason: r.failure.reason, at };
      if (reason === null) {
        status = r.failure.status;
        reason = `fetch_${r.failure.reason}`;
      }
      continue;
    }
    upsertSearchConsoleRows(ctx.db, source, domain, ctx.week, r.rows, at);
    lastFetch[source][domain] = { week: ctx.week, ok: true, reason: null, at };
    fetched++;
    rows += r.rows.length;
  }
  sourceState[source] = { status, count: c.count, checkedAt: ctx.at(), reason, checkOk: true, domains: c.domains };
  return { status, count: c.count, reason, fetched, rows };
}

function gscCheck(creds: GscCredentialsResult, deps: GscDeps, domains: readonly SearchConsoleDomain[]): () => Promise<SourceCheck> {
  return async () => {
    if (!creds.ok) return creds;
    const r = await checkGsc(creds.creds, deps, domains);
    if (!r.ok) return r;
    const out: Record<string, DomainState> = {};
    for (const [domain, m] of Object.entries(r.matches)) {
      out[domain] = { property: m?.siteUrl ?? null, permissionLevel: m?.permissionLevel ?? null, access: gscHasAccess(m) };
    }
    const token = r.accessToken;
    return { ok: true, status: r.status, count: r.properties, domains: out, fetchWeek: (p, w) => fetchGscWeek(token, p, w, deps) };
  };
}

function bingCheck(apiKey: string, deps: GscDeps, domains: readonly SearchConsoleDomain[]): () => Promise<SourceCheck> {
  return async () => {
    const r = await checkBing(apiKey, deps, domains);
    if (!r.ok) return r;
    const out: Record<string, DomainState> = {};
    for (const [domain, m] of Object.entries(r.matches)) {
      out[domain] = { property: m?.url ?? null, permissionLevel: null, access: !!m?.verified };
    }
    return { ok: true, status: r.status, count: r.sites, domains: out, fetchWeek: (p, w) => fetchBingWeek(apiKey, p, w, deps) };
  };
}

function formatRunLine(s: SearchConsoleRunSummary): string {
  const part = (name: string, countLabel: string, r: SourceRunSummary | undefined) =>
    r
      ? `${name}=${r.status}${r.reason ? `(${r.reason})` : ""} ${countLabel}=${r.count ?? "-"} fetched=${r.fetched} rows=${r.rows}`
      : `${name}=unconfigured`;
  return `[search-consoles] week=${s.week} ${part("gsc", "properties", s.gsc)} ${part("bing", "sites", s.bing)}`;
}

/**
 * One run: check each configured source, then fetch the target week where it is missing.
 * Logs one line. Never makes a call when the kill switch is off or no key is set.
 */
export async function runSearchConsoleJob(opts: SearchConsoleRunOptions = {}): Promise<SearchConsoleRunSummary> {
  const env = opts.env ?? process.env;
  if (!isSearchConsoleFetchEnabled(env)) return { skipped: "disabled" };
  const gscCreds = readGscCredentials(env);
  const bingKey = readBingApiKey(env);
  if (!gscCreds && !bingKey) return { skipped: "unconfigured" };
  if (running) return { skipped: "already_running" };
  running = true;
  try {
    const now = opts.now ?? (() => new Date());
    const db = opts.db ?? defaultDb();
    ensureSearchConsoleWeeklyTable(db);
    const deps: GscDeps = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, now };
    const domains = opts.domains ?? SEARCH_CONSOLE_DOMAINS;
    const ctx = { db, week: targetSearchConsoleWeek(now()), domains, at: () => now().toISOString() };
    const summary: SearchConsoleRunSummary = { week: ctx.week };
    if (gscCreds) summary.gsc = await runSource("gsc", gscCheck(gscCreds, deps, domains), ctx);
    if (bingKey) summary.bing = await runSource("bing", bingCheck(bingKey, deps, domains), ctx);
    (opts.log ?? ((m: string) => console.log(m)))(redactSecrets(formatRunLine(summary), secretValues(env)));
    return summary;
  } finally {
    running = false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────

/**
 * Called once from src/index.ts. With the kill switch off or no key set it logs one line and
 * schedules nothing. Otherwise: first run after SEARCH_CONSOLE_BOOT_DELAY_MS, then every
 * SEARCH_CONSOLE_CHECK_INTERVAL_MS, each inside the exclusive boot-job gate.
 */
export function startSearchConsoleScheduler(opts: {
  getDb: () => Db;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  bootDelayMs?: number;
  intervalMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => any;
  setIntervalFn?: (fn: () => void, ms: number) => any;
  /** Tests: fetchImpl, now, timeoutMs, domains. */
  run?: Omit<SearchConsoleRunOptions, "db" | "env" | "log">;
}): { started: boolean; stop: () => void } {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!isSearchConsoleFetchEnabled(env)) {
    log("[search-consoles] disabled (SEARCH_CONSOLE_FETCH_ENABLED=0): no check, no fetch");
    return { started: false, stop: () => {} };
  }
  if (!hasGscSecret(env) && !readBingApiKey(env)) {
    log("[search-consoles] skipped: GSC_SERVICE_ACCOUNT_JSON and BING_WEBMASTER_API_KEY are not set");
    return { started: false, stop: () => {} };
  }
  const tick = () => {
    runExclusiveBootJob(trackJob("search-consoles", () => runSearchConsoleJob({ ...opts.run, db: opts.getDb(), env, log }))).catch(
      (err: any) => {
        console.error(
          `[search-consoles] run failed (non-fatal): ${err?.name ?? "Error"}: ${redactSecrets(String(err?.message ?? err), secretValues(env))}`,
        );
      },
    );
  };
  const boot = (opts.setTimeoutFn ?? setTimeout)(tick, opts.bootDelayMs ?? SEARCH_CONSOLE_BOOT_DELAY_MS);
  const interval = (opts.setIntervalFn ?? setInterval)(tick, opts.intervalMs ?? SEARCH_CONSOLE_CHECK_INTERVAL_MS);
  boot?.unref?.();
  interval?.unref?.();
  return {
    started: true,
    stop: () => {
      clearTimeout(boot);
      clearInterval(interval);
    },
  };
}

// ── Status for /health and the admin GET ──────────────────────────────

interface SourceView {
  status: SearchConsoleStatus;
  count: number | null;
  checkedAt: string | null;
  reason: string | null;
}

function sourceView(source: SearchConsoleSource, configured: boolean): SourceView {
  if (!configured) return { status: "unconfigured", count: null, checkedAt: null, reason: null };
  const s = sourceState[source];
  if (!s) return { status: "pending", count: null, checkedAt: null, reason: null };
  return { status: s.status, count: s.count, checkedAt: s.checkedAt, reason: s.reason };
}

/**
 * The public /health field. Synchronous and network-free: it reads the in-memory result of the
 * last run and whether each secret is set. Counts and fixed codes only: no key, e-mail, token,
 * property URL or search data.
 */
export function getSearchConsolesHealth(opts: { env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  const gsc = sourceView("gsc", hasGscSecret(env));
  const bing = sourceView("bing", readBingApiKey(env) !== null);
  return {
    enabled: isSearchConsoleFetchEnabled(env),
    gsc: { status: gsc.status, properties: gsc.count, checkedAt: gsc.checkedAt, reason: gsc.reason },
    bing: { status: bing.status, sites: bing.count, checkedAt: bing.checkedAt, reason: bing.reason },
  };
}

interface StoredRow {
  domain: string;
  source: string;
  metric: string;
  dimension: string;
  value: number;
  fetched_at: string;
}

/**
 * GET /admin/analytics/search-consoles: one week's rows per domain and source, or why there are
 * none (`unavailable`: disabled, unconfigured, pending, auth_failed, error, no_access,
 * week_not_complete, fetch_failed (+ detail) or not_fetched), plus bing.sitemaps per domain.
 * `week` is any YYYY-MM-DD in the week (Monday is used); default: the latest complete week.
 */
export function getSearchConsoleWeekView(opts: {
  db?: Db;
  week?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  domains?: readonly SearchConsoleDomain[];
} = {}) {
  const db = opts.db ?? defaultDb();
  ensureSearchConsoleWeeklyTable(db);
  const latest = targetSearchConsoleWeek(opts.now ?? new Date());
  const week = opts.week ? weekStartOf(opts.week) : latest;
  const health = getSearchConsolesHealth({ env: opts.env });
  const stored = db
    .prepare(
      `SELECT domain, source, metric, dimension, value, fetched_at FROM search_console_weekly
       WHERE week = ? ORDER BY domain, source, metric, dimension`,
    )
    .all(week) as StoredRow[];
  const storedWeeks = (db.prepare("SELECT DISTINCT week FROM search_console_weekly ORDER BY week DESC LIMIT 12").all() as { week: string }[])
    .map((r) => r.week);

  const unavailable = (source: SearchConsoleSource, domain: string): { unavailable: string; detail: string | null } => {
    const h = health[source];
    if (!health.enabled) return { unavailable: "disabled", detail: null };
    if (h.status === "unconfigured" || h.status === "pending") return { unavailable: h.status, detail: null };
    const s = sourceState[source];
    if (s && !s.checkOk) return { unavailable: s.status, detail: s.reason };
    const d = s?.domains[domain];
    if (!d?.access) return { unavailable: "no_access", detail: null };
    if (week > latest) return { unavailable: "week_not_complete", detail: null };
    const note = lastFetch[source][domain];
    if (note && note.week === week && !note.ok) return { unavailable: "fetch_failed", detail: note.reason };
    return { unavailable: "not_fetched", detail: null };
  };

  const perSource = (source: SearchConsoleSource, domain: string) => {
    const mine = stored.filter((r) => r.source === source && r.domain === domain);
    const d = sourceState[source]?.domains[domain];
    const where =
      source === "gsc"
        ? { property: d?.property ?? null, permissionLevel: d?.permissionLevel ?? null }
        : { site: d?.property ?? null, verified: d ? d.access : null };
    if (mine.length > 0) {
      return {
        ...where,
        rows: mine.map((r) => ({ metric: r.metric, dimension: r.dimension, value: r.value })),
        fetchedAt: mine.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), mine[0].fetched_at),
        unavailable: null,
        detail: null,
      };
    }
    return { ...where, rows: [], fetchedAt: null, ...unavailable(source, domain) };
  };

  const domains = (opts.domains ?? SEARCH_CONSOLE_DOMAINS).map(({ brand, domain }) => ({
    domain,
    brand,
    gsc: perSource("gsc", domain),
    bing: perSource("bing", domain),
  }));

  const sitemaps: Record<string, { count: number | null; urls: number | null; checkedAt: string | null; unavailable: string | null }> = {};
  for (const d of domains) {
    const count = d.bing.rows.find((r) => r.metric === "sitemaps" && r.dimension === "total");
    const urls = d.bing.rows.find((r) => r.metric === "sitemap_urls" && r.dimension === "total");
    sitemaps[d.domain] = count
      ? { count: count.value, urls: urls ? urls.value : null, checkedAt: d.bing.fetchedAt, unavailable: null }
      : { count: null, urls: null, checkedAt: null, unavailable: d.bing.unavailable ?? "not_fetched" };
  }

  return {
    week,
    weekEnd: addDays(week, 6),
    latestCompleteWeek: latest,
    enabled: health.enabled,
    status: { gsc: health.gsc, bing: health.bing },
    domains,
    bing: { sitemaps },
    storedWeeks,
  };
}

/** Test-only: reset module state. */
export function __resetSearchConsolesForTesting(): void {
  sourceState = { gsc: null, bing: null };
  lastFetch = { gsc: {}, bing: {} };
  running = false;
}
