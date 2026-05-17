// ─── EU TRACES NT — organic-operator client (Phase 5.11 C.1-A, 2026-05-16) ──
//
// Pulls the public bulk export of organic operators from the EU TRACES NT
// portal and returns only operators whose competentAuthority.code equals
// "NO-ØKO-01" — i.e. Debio.
//
// PR-66 (2026-05-17): switch the page-query path from a naive
// `GET /for/query?firstResult=N&maxResults=100` (sorted globally across
// ~945k operator records — Norwegian Debio rows are too sparse in the
// first 10k pages to surface within Fly's 120s proxy window) to a
// POST-body server-side filter so we only request Norwegian-Debio
// operator records.
//
// The TRACES NT publication backend is a SAP UI5 / Spring app with an
// OData-style POST filter endpoint at:
//   POST /for/query
//   body: { filter: { competentAuthority: { code: "NO-ØKO-01" } },
//           firstResult: N, maxResults: 100 }
// Response shape is the same array (or {content:[…]} envelope) as the
// GET path. If the POST endpoint responds with 405/404/501 — i.e. the
// portal doesn't expose the filter on this deployment — we fall back to
// `GET /for/query?firstResult=N&maxResults=100&country=NO&competentAuthority=NO-ØKO-01`
// and rely on client-side isDebioRecord() as a defence in depth.
//
//   Base:  https://webgate.ec.europa.eu/tracesnt/directory/publication/organic-operator
//   Count: GET /for/count                     → integer (total operators)
//   Bulk (PR-66): POST /for/query (body filter) → array of operators
//   Fallback (legacy): GET /for/query?firstResult=N&maxResults=100&country=NO
//   Max page size: 100 (hard limit enforced by the portal)
//   Auth: none — public-facing portal. We send a polite User-Agent
//         identifying rettfrabonden.com so the EC admins can find us if
//         our traffic ever becomes a problem.
//
// Polite-fetch rules:
//   - max 1 req/s (DEFAULT_DELAY_MS)
//   - request timeout = 20s
//   - skip re-paginating within a 60-minute window (in-process cache —
//     keyed by `since` so different incrementals don't share results)
//
// This module is intentionally pure: takes an optional `fetchImpl` so the
// tests can stub it without mucking with globalThis.fetch.

export const TRACES_BASE_URL =
  "https://webgate.ec.europa.eu/tracesnt/directory/publication/organic-operator";

// The competent-authority code we want to keep. NO-ØKO-01 == Debio.
export const DEBIO_AUTHORITY_CODE = "NO-ØKO-01";

// EU TRACES NT also uses ASCII-folded variants in some records.
const DEBIO_AUTHORITY_CODES = new Set([
  "NO-ØKO-01",
  "NO-OKO-01",
  "NO-Ø-01",
]);

// PR-66: ISO-3166-1 alpha-2 country filter sent on both POST body and
// GET fallback. The portal accepts either uppercase ISO codes or
// English country names; ISO is canonical.
export const TRACES_FILTER_COUNTRY = "NO";

// Polite-fetch tunables — exported so callers can patch in tests.
export const TRACES_PAGE_SIZE = 100;     // hard limit
export const TRACES_DELAY_MS = 1100;     // ≥1 req/s gap
export const TRACES_TIMEOUT_MS = 20000;
export const TRACES_USER_AGENT =
  "rettfrabonden.com-orchestrator (orchestrator@rettfrabonden.com)";
const CACHE_TTL_MS = 60 * 60 * 1000;     // 60 min

export type TracesOperator = {
  operator_name: string;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  operator_identifier: string | null;   // TRACES-internal id (numeric or hash)
  status: string | null;
  issued_on: string | null;             // ISO date or null
  expires_on: string | null;
};

export type FetchTracesOptions = {
  /** Only keep records issued on/after this ISO date. */
  since?: string;
  /** Hard cap on filtered records returned. Mostly used by tests. */
  maxFiltered?: number;
  /** Inject a stubbed fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override the polite delay between pages (tests use 0). */
  delayMs?: number;
  /** Override page size — must be ≤ 100. */
  pageSize?: number;
  /**
   * PR-65: start TRACES pagination from this 0-based page index.
   * firstResult = startTracesPage * pageSize. Default 0 = beginning.
   */
  startTracesPage?: number;
  /**
   * PR-65: max TRACES pages to fetch in this call. Default 1200
   * (backward-compat with the prior MAX_PAGES soft cap).
   */
  maxTracesPages?: number;
  /**
   * PR-66: force the GET-with-country-param fallback path even if POST
   * would have worked. Tests use this to exercise the fallback branch
   * without having to simulate a 405. Default false.
   */
  forceGetFallback?: boolean;
};

type CacheEntry = { ts: number; results: TracesOperator[] };

// Per-process cache. Keyed by the `since` string (empty when not provided).
const cache: Map<string, CacheEntry> = new Map();

export function __clearTracesCacheForTesting(): void {
  cache.clear();
  // PR-66: also reset the POST→GET fallback latch so each test starts
  // with a clean transport-preference state.
  __postUnsupported = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Best-effort JSON-Date extraction: TRACES returns assorted shapes (ISO
// strings, "YYYY-MM-DD", or numeric timestamps wrapped in objects).
function pickDateLike(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    try { return new Date(v).toISOString(); } catch { return null; }
  }
  return null;
}

function pickFirstString(o: any, keys: string[]): string | null {
  for (const k of keys) {
    if (o && typeof o[k] === "string" && o[k].length > 0) return o[k];
  }
  return null;
}

// Normalise one raw TRACES record into our flat shape. The portal is
// chatty (~40 fields) but we only persist what the cross-check needs.
export function normaliseTracesRecord(raw: any): TracesOperator | null {
  if (!raw || typeof raw !== "object") return null;

  const name = pickFirstString(raw, [
    "operatorName", "name", "businessName", "legalName",
  ]);
  if (!name) return null;

  const addr = raw.address || raw.operatorAddress || raw.mainAddress || {};
  return {
    operator_name: name,
    postal_code: pickFirstString(addr, ["postalCode", "postal_code", "zipCode", "zip"]),
    city: pickFirstString(addr, ["city", "locality", "town"]),
    country: pickFirstString(addr, ["country", "countryCode", "isoCode"])
      || pickFirstString(raw, ["country", "countryCode"]),
    operator_identifier: pickFirstString(raw, [
      "operatorId", "operator_id", "id", "publicationId", "tracesId",
    ]),
    status: pickFirstString(raw, ["status", "operatorStatus", "certificateStatus"]),
    issued_on: pickDateLike(raw.issuedOn ?? raw.issued_on ?? raw.certificateIssuedOn),
    expires_on: pickDateLike(raw.expiresOn ?? raw.expires_on ?? raw.certificateExpiresOn),
  };
}

// True iff the record's competent-authority code is Debio's NO-ØKO-01.
// TRACES exposes the field at several paths over time; we check all.
export function isDebioRecord(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  const candidates = [
    raw.competentAuthority,
    raw.issuingBody,
    raw.controlBody,
    raw.controlAuthority,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof c.code === "string") {
      if (DEBIO_AUTHORITY_CODES.has(c.code)) return true;
    }
  }
  // Some payloads flatten code onto the root.
  if (typeof raw.competentAuthorityCode === "string"
      && DEBIO_AUTHORITY_CODES.has(raw.competentAuthorityCode)) {
    return true;
  }
  return false;
}

async function fetchWithTimeout(
  url: string,
  ms: number,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const merged: RequestInit = {
      method: init?.method ?? "GET",
      headers: {
        "User-Agent": TRACES_USER_AGENT,
        "Accept": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: ctl.signal,
    };
    if (init?.body !== undefined) merged.body = init.body;
    return await fetchImpl(url, merged);
  } finally {
    clearTimeout(t);
  }
}

// GET /for/count — global operator count. Useful for progress reporting
// and as a smoke test that the portal is reachable.
export async function fetchTracesCount(
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const url = `${TRACES_BASE_URL}/for/count`;
  const res = await fetchWithTimeout(url, TRACES_TIMEOUT_MS, fetchImpl);
  if (!res.ok) throw new Error(`TRACES count HTTP ${res.status}`);
  const txt = (await res.text()).trim();
  const n = Number(txt);
  if (!Number.isFinite(n)) throw new Error(`TRACES count not a number: ${txt.slice(0, 60)}`);
  return n;
}

// PR-66: parse an arbitrary JSON envelope into an array of raw records.
// POST may return slightly different envelopes than GET (e.g. wrapped
// in {content:[…], totalElements:N} or {results:[…]}); be permissive.
export function parseTracesPageResponse(data: unknown): any[] {
  if (Array.isArray(data)) return data as any[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.content)) return d.content as any[];
    if (Array.isArray(d.results)) return d.results as any[];
    if (Array.isArray(d.data)) return d.data as any[];
    if (Array.isArray(d.operators)) return d.operators as any[];
  }
  return [];
}

// PR-66: build the POST body we send to /for/query. Filter by
// competentAuthority.code = NO-ØKO-01 AND country = NO. The portal's
// OData-style filter accepts both at the same level; sending both
// narrows the result set to the Norwegian Debio slice (~10k records,
// down from 945k globally).
export function buildTracesPostBody(firstResult: number, pageSize: number) {
  return {
    firstResult,
    maxResults: pageSize,
    filter: {
      competentAuthority: { code: DEBIO_AUTHORITY_CODE },
      country: TRACES_FILTER_COUNTRY,
    },
  };
}

// PR-66: build the GET fallback URL. Same `firstResult`/`maxResults`
// query string the legacy client used, plus best-effort country and
// competentAuthority query params. The TRACES backend may ignore them
// silently (the inline note at the top of this file says it does), in
// which case isDebioRecord() still client-side-filters the page.
export function buildTracesGetUrl(firstResult: number, pageSize: number): string {
  const params = new URLSearchParams({
    firstResult: String(firstResult),
    maxResults: String(pageSize),
    country: TRACES_FILTER_COUNTRY,
    competentAuthority: DEBIO_AUTHORITY_CODE,
  });
  return `${TRACES_BASE_URL}/for/query?${params.toString()}`;
}

// PR-66: latch — once POST returns a "filter not supported" status,
// don't keep paying the round-trip cost; fall straight through to GET
// for the rest of the run.
let __postUnsupported = false;

// PR-66 POST /for/query — one page of pre-filtered operators. We send
// the OData-style body and parse the envelope permissively. If the
// portal returns 405/404/501 we set __postUnsupported and return null
// so the caller falls back to GET.
export async function fetchTracesPagePost(
  firstResult: number,
  pageSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<any[] | null> {
  const cappedSize = Math.min(Math.max(1, pageSize), TRACES_PAGE_SIZE);
  const url = `${TRACES_BASE_URL}/for/query`;
  const body = buildTracesPostBody(firstResult, cappedSize);
  const res = await fetchWithTimeout(url, TRACES_TIMEOUT_MS, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 405 || res.status === 404 || res.status === 501) {
    console.warn(
      `[traces-client] POST /for/query returned ${res.status}; ` +
      `falling back to GET with country/competentAuthority query params.`,
    );
    __postUnsupported = true;
    return null;
  }
  if (!res.ok) {
    throw new Error(`TRACES POST page HTTP ${res.status} @ firstResult=${firstResult}`);
  }
  const data = await res.json();
  return parseTracesPageResponse(data);
}

// GET /for/query — one page (≤100 records) of raw operators. Public; no auth.
// PR-66: now also tacks on country/competentAuthority query params as a
// hint to the backend. The portal may ignore them (and historically
// did), so isDebioRecord() in the main loop is still the source of truth.
export async function fetchTracesPage(
  firstResult: number,
  pageSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<any[]> {
  const cappedSize = Math.min(Math.max(1, pageSize), TRACES_PAGE_SIZE);
  const url = buildTracesGetUrl(firstResult, cappedSize);
  const res = await fetchWithTimeout(url, TRACES_TIMEOUT_MS, fetchImpl);
  if (!res.ok) throw new Error(`TRACES page HTTP ${res.status} @ firstResult=${firstResult}`);
  const data = await res.json();
  return parseTracesPageResponse(data);
}

// PR-66: pick POST first; on the (latched) "POST unsupported" signal
// fall back to GET. Exported so tests can drive each path directly.
export async function fetchTracesPageAny(
  firstResult: number,
  pageSize: number,
  fetchImpl: typeof fetch = fetch,
  opts: { forceGetFallback?: boolean } = {},
): Promise<any[]> {
  if (!opts.forceGetFallback && !__postUnsupported) {
    try {
      const viaPost = await fetchTracesPagePost(firstResult, pageSize, fetchImpl);
      if (viaPost !== null) return viaPost;
    } catch (err) {
      // Network or non-405 HTTP errors on the POST path: log and try
      // GET as a last-ditch fallback before bubbling. We don't latch
      // __postUnsupported here because a transient 5xx shouldn't
      // permanently disable POST for the rest of the run.
      console.warn(
        `[traces-client] POST /for/query threw at firstResult=${firstResult}; ` +
        `attempting GET fallback once:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return await fetchTracesPage(firstResult, pageSize, fetchImpl);
}

// Main entry: paginate the Norwegian-Debio slice via POST-filtered pages
// (PR-66), filter NO-ØKO-01 client-side as defence in depth, and return
// normalised Debio operators. Honours `since` to skip already-known
// records on incremental runs.
export async function fetchDebioOperators(
  opts: FetchTracesOptions = {},
): Promise<TracesOperator[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayMs = opts.delayMs ?? TRACES_DELAY_MS;
  const pageSize = Math.min(opts.pageSize ?? TRACES_PAGE_SIZE, TRACES_PAGE_SIZE);
  // PR-65: cache key now includes pagination window so a partial sweep
  // (startTracesPage>0 or maxTracesPages<1200) doesn't poison the cache
  // for callers asking for a different window.
  const sinceForKey = opts.since ?? "";
  const startForKey = Math.max(
    0,
    Number.isFinite(opts.startTracesPage) ? Math.floor(opts.startTracesPage ?? 0) : 0,
  );
  const maxForKey = Math.max(
    1,
    Number.isFinite(opts.maxTracesPages) && (opts.maxTracesPages ?? 0) > 0
      ? Math.floor(opts.maxTracesPages ?? 1200)
      : 1200,
  );
  const sinceKey = `${sinceForKey}|s=${startForKey}|m=${maxForKey}`;

  const cached = cache.get(sinceKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return opts.maxFiltered ? cached.results.slice(0, opts.maxFiltered) : cached.results;
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const out: TracesOperator[] = [];
  // PR-65: pagination offset + per-call cap so callers can chunk a
  // full ~10k-record sweep across multiple admin POSTs. Defaults match
  // the prior behaviour (start at page 0, cap at 1200 pages).
  const startTracesPage = Math.max(
    0,
    Number.isFinite(opts.startTracesPage) && (opts.startTracesPage ?? 0) >= 0
      ? Math.floor(opts.startTracesPage ?? 0)
      : 0,
  );
  const maxTracesPages = Math.max(
    1,
    Number.isFinite(opts.maxTracesPages) && (opts.maxTracesPages ?? 0) > 0
      ? Math.floor(opts.maxTracesPages ?? 1200)
      : 1200,
  );
  let firstResult = startTracesPage * pageSize;

  for (let pageIdx = 0; pageIdx < maxTracesPages; pageIdx++) {
    let page: any[];
    try {
      page = await fetchTracesPageAny(firstResult, pageSize, fetchImpl, {
        forceGetFallback: opts.forceGetFallback === true,
      });
    } catch (err) {
      // Single-page failures shouldn't kill the run — log + stop.
      console.warn(`[traces-client] page fetch failed at firstResult=${firstResult}:`, err);
      break;
    }
    if (page.length === 0) break;

    for (const raw of page) {
      if (!isDebioRecord(raw)) continue;
      const rec = normaliseTracesRecord(raw);
      if (!rec) continue;
      if (Number.isFinite(sinceMs) && rec.issued_on) {
        const issuedMs = Date.parse(rec.issued_on);
        if (Number.isFinite(issuedMs) && issuedMs < sinceMs) continue;
      }
      out.push(rec);
      if (opts.maxFiltered && out.length >= opts.maxFiltered) {
        cache.set(sinceKey, { ts: Date.now(), results: out });
        return out;
      }
    }

    // Short page = last page (portal doesn't always send Link headers).
    if (page.length < pageSize) break;
    firstResult += pageSize;

    if (delayMs > 0) await sleep(delayMs);
  }

  cache.set(sinceKey, { ts: Date.now(), results: out });
  return out;
}
