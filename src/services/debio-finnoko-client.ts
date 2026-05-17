// ─── Debio finnoko client (Phase 5.11 C.1-A / PR-70, 2026-05-17) ─────
//
// PR-70: switch Debio cross-check data source from EU TRACES NT
// (which doesn't expose a usable server-side filter for the
// Norwegian-Debio slice — PR-66's POST filter was rejected on the
// live portal, see traces-client.ts inline notes) to Debio's own
// public "Finn Økobonde" directory at:
//
//   GET https://finnoko.debio.no/api/acm/companies
//
// The endpoint returns a single JSON array (~82 records as of
// 2026-05-17) of Norwegian Debio-certified companies. Every record
// in the response is by-construction certified (the upstream ACM
// system only publishes accepted producers). No auth, no pagination,
// no rate limiting beyond ordinary politeness.
//
// Response shape (verified against the live API on 2026-05-17):
//
//   [
//     {
//       "partner_sid": 5775,                  // stable numeric id (Debio-internal)
//       "company_tags": null | string,        // free-form tag string
//       "attachments": [{ attachment, attachment_type }],
//       "sales_channels": [{ id, content }],  // e.g. "Salg på markeder (Reko, Bondens marked o.l)"
//       "display_name": "Østre Pavestad Gård" | null,
//       "description1": "...",                // public-facing blurb
//       "description2": "...",
//       "contact_name": "Petter Simonsen",
//       "contact_phone": "92011094" | null,
//       "contact_mail": "petter@pavestad.no" | null,
//       "website": "www.norskullgris.no" | null,
//       "website2": null | string,
//       "socialmedia": "..." | null,
//       "socialmedia2": null | string,
//       "socialmedia3": null | string,
//       "socialmedia4": null | string,
//       "area": 526 | null                    // declared production area, decares
//     },
//     ...
//   ]
//
// Notable: the API does NOT expose orgnumber or certification status —
// the absence of an org-number means the cross-check must fall back
// to Brreg reverse-lookup-by-name (same path as TRACES). The absence
// of a status field is fine: the directory only lists accepted
// producers, so every record is implicitly status='active'.
//
// This module is intentionally pure: takes an optional `fetchImpl`
// so the tests can stub it without mucking with globalThis.fetch.

export const FINNOKO_BASE_URL =
  "https://finnoko.debio.no/api/acm/companies";

// Polite-fetch tunables — exported so callers can patch in tests.
export const FINNOKO_TIMEOUT_MS = 20000;
export const FINNOKO_USER_AGENT =
  "rettfrabonden.com-orchestrator (orchestrator@rettfrabonden.com)";
const CACHE_TTL_MS = 60 * 60 * 1000;     // 60 min (mirrors traces-client)

// ─── Type for one raw finnoko company record ─────────────────────────
//
// Defensive: every field is optional except `partner_sid` (which we
// rely on for idempotency) and `display_name` (which we rely on for
// name-matching). Records missing either are dropped in
// fetchFinnokoCompanies(); see the filter below.
export type FinnokoAttachment = {
  attachment?: string | null;
  attachment_type?: string | null;
};

export type FinnokoSalesChannel = {
  id?: number | null;
  content?: string | null;
};

export type FinnokoCompany = {
  partner_sid: number;
  company_tags: string | null;
  attachments: FinnokoAttachment[];
  sales_channels: FinnokoSalesChannel[];
  display_name: string;          // null records filtered out
  description1: string | null;
  description2: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_mail: string | null;
  website: string | null;
  website2: string | null;
  socialmedia: string | null;
  socialmedia2: string | null;
  socialmedia3: string | null;
  socialmedia4: string | null;
  area: number | null;
};

export type FetchFinnokoOptions = {
  /** Inject a stubbed fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Skip the in-process cache (tests force a fresh fetch). */
  skipCache?: boolean;
};

// Per-process cache. Single entry — the endpoint is unparameterised.
type CacheEntry = { ts: number; results: FinnokoCompany[] };
let cache: CacheEntry | null = null;

export function __clearFinnokoCacheForTesting(): void {
  cache = null;
}

// ─── Type guard: is `raw` a usable FinnokoCompany? ────────────────────
//
// Defence-in-depth — if the upstream API ever starts mixing
// not-yet-certified or draft records in (today it doesn't), we drop
// any record that's missing the two fields the cross-check actually
// needs (partner_sid for evidence, display_name for matching).
export function isFinnokoCompany(raw: any): raw is FinnokoCompany {
  if (!raw || typeof raw !== "object") return false;
  if (typeof raw.partner_sid !== "number" || !Number.isFinite(raw.partner_sid)) return false;
  if (typeof raw.display_name !== "string" || raw.display_name.trim().length === 0) return false;
  return true;
}

// ─── Normalise one raw record into our flat shape ────────────────────
//
// The live API already returns the canonical shape; this is mostly
// defensive null-coalescing so downstream code can rely on null vs
// undefined and on arrays existing.
export function normaliseFinnokoRecord(raw: any): FinnokoCompany | null {
  if (!isFinnokoCompany(raw)) return null;
  const r = raw as any;
  return {
    partner_sid: r.partner_sid,
    company_tags: typeof r.company_tags === "string" ? r.company_tags : null,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    sales_channels: Array.isArray(r.sales_channels) ? r.sales_channels : [],
    display_name: String(r.display_name).trim(),
    description1: typeof r.description1 === "string" ? r.description1 : null,
    description2: typeof r.description2 === "string" ? r.description2 : null,
    contact_name: typeof r.contact_name === "string" ? r.contact_name : null,
    contact_phone: typeof r.contact_phone === "string" ? r.contact_phone : null,
    contact_mail: typeof r.contact_mail === "string" ? r.contact_mail : null,
    website: typeof r.website === "string" ? r.website : null,
    website2: typeof r.website2 === "string" ? r.website2 : null,
    socialmedia: typeof r.socialmedia === "string" ? r.socialmedia : null,
    socialmedia2: typeof r.socialmedia2 === "string" ? r.socialmedia2 : null,
    socialmedia3: typeof r.socialmedia3 === "string" ? r.socialmedia3 : null,
    socialmedia4: typeof r.socialmedia4 === "string" ? r.socialmedia4 : null,
    area: typeof r.area === "number" && Number.isFinite(r.area) ? r.area : null,
  };
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
        "User-Agent": FINNOKO_USER_AGENT,
        "Accept": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: ctl.signal,
    };
    return await fetchImpl(url, merged);
  } finally {
    clearTimeout(t);
  }
}

// ─── Permissive envelope parser ──────────────────────────────────────
//
// The live API returns a bare JSON array, but be permissive in case
// they ever wrap it in {results:[…]} or {data:[…]} (same defence the
// traces-client uses).
export function parseFinnokoResponse(data: unknown): any[] {
  if (Array.isArray(data)) return data as any[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.results)) return d.results as any[];
    if (Array.isArray(d.data)) return d.data as any[];
    if (Array.isArray(d.companies)) return d.companies as any[];
    if (Array.isArray(d.content)) return d.content as any[];
  }
  return [];
}

// ─── Main entry: fetch the full Norwegian-Debio operator directory ───
//
// Single round-trip — the endpoint serves all ~82 records at once.
// 60-minute in-process cache; pass `skipCache=true` to force a refresh.
export async function fetchFinnokoCompanies(
  opts: FetchFinnokoOptions = {},
): Promise<FinnokoCompany[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!opts.skipCache && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.results;
  }

  const res = await fetchWithTimeout(FINNOKO_BASE_URL, FINNOKO_TIMEOUT_MS, fetchImpl);
  if (!res.ok) {
    throw new Error(`finnoko HTTP ${res.status} @ ${FINNOKO_BASE_URL}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(
      `finnoko JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const raw = parseFinnokoResponse(data);
  const out: FinnokoCompany[] = [];
  for (const r of raw) {
    const norm = normaliseFinnokoRecord(r);
    if (norm) out.push(norm);
  }

  cache = { ts: Date.now(), results: out };
  return out;
}
