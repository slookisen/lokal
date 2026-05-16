// ─── EU TRACES NT — organic-operator client (Phase 5.11 C.1-A, 2026-05-16) ──
//
// Pulls the public bulk export of organic operators from the EU TRACES NT
// portal and returns only operators whose competentAuthority.code equals
// "NO-ØKO-01" — i.e. Debio. The portal does not honour query-string
// filtering reliably so we paginate the global list and filter client-side.
//
//   Base:  https://webgate.ec.europa.eu/tracesnt/directory/publication/organic-operator
//   Count: GET /for/count                     → integer (total operators)
//   Bulk:  GET /for/query?firstResult=N&maxResults=100 → array of operators
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
};

type CacheEntry = { ts: number; results: TracesOperator[] };

// Per-process cache. Keyed by the `since` string (empty when not provided).
const cache: Map<string, CacheEntry> = new Map();

export function __clearTracesCacheForTesting(): void {
  cache.clear();
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
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": TRACES_USER_AGENT,
        "Accept": "application/json",
      },
      signal: ctl.signal,
    });
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

// GET /for/query — one page (≤100 records) of raw operators. Public; no auth.
export async function fetchTracesPage(
  firstResult: number,
  pageSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<any[]> {
  const cappedSize = Math.min(Math.max(1, pageSize), TRACES_PAGE_SIZE);
  const url = `${TRACES_BASE_URL}/for/query?firstResult=${firstResult}&maxResults=${cappedSize}`;
  const res = await fetchWithTimeout(url, TRACES_TIMEOUT_MS, fetchImpl);
  if (!res.ok) throw new Error(`TRACES page HTTP ${res.status} @ firstResult=${firstResult}`);
  const data = await res.json();
  if (!Array.isArray(data)) {
    if (data && Array.isArray((data as any).content)) return (data as any).content;
    if (data && Array.isArray((data as any).results)) return (data as any).results;
    return [];
  }
  return data as any[];
}

// Main entry: paginate the global operator list, filter NO-ØKO-01 client-
// side, and return normalised Debio operators. Honours `since` to skip
// already-known records on incremental runs.
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
      page = await fetchTracesPage(firstResult, pageSize, fetchImpl);
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
