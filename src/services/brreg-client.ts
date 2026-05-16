// ─── Brønnøysund Enhetsregisteret — name → orgnumber lookup (C.1-A, 2026-05-16) ──
//
// Used by Phase 5.11 C.1-A Debio cross-check (debio-cross-check.ts) to
// reverse-look-up the 9-digit orgnumber for a TRACES NT operator name,
// since TRACES exposes only name + address (no Norwegian orgnumber).
//
//   Base:   https://data.brreg.no/enhetsregisteret/api
//   Search: GET /enheter?navn={name}&size=5
//             → { "_embedded": { "enheter": [{ organisasjonsnummer, navn, ... }] } }
//
//   Open data, NLOD-licensed, ~60 req/s allowed. No auth required.
//
// Confidence rubric (must be ≥ 0.9 to return a match):
//   1.00 — normalised(name) == normalised(hit.navn)            (exact)
//   0.95 — first token matches AND postal code matches
//   0.80 — first token matches alone
//   < 0.90 → return null (caller falls through to fuzzy-match on agents)
//
// Per-process cache (Map<key,result>) keeps repeated lookups within a
// single run cheap. Cache key is "<normalisedName>|<postalCode|-->" so
// asking with vs without a postal code keeps separate entries.

export const BRREG_BASE_URL = "https://data.brreg.no/enhetsregisteret/api";
export const BRREG_SEARCH_PATH = "/enheter";
const REQUEST_TIMEOUT_MS = 15000;

export type BrregHit = {
  orgnumber: string;
  name: string;
  confidence: number;
  brreg_postal?: string | null;
};

type RawEnhet = {
  organisasjonsnummer: string;
  navn: string;
  forretningsadresse?: { postnummer?: string | null } | null;
  postadresse?: { postnummer?: string | null } | null;
};

// ─── Normalisation ─────────────────────────────────────────────────────
// Lowercase + diacritic fold (æ→ae, ø→o, å→a) + drop punctuation +
// strip common organisation-form suffixes that appear inconsistently in
// TRACES vs Brreg (e.g. "AS", "DA", "ANS", "ENK", "SA"). We keep these
// when computing the first-word match but apply them when computing
// the exact-match comparison.
const ORG_SUFFIXES = new Set([
  "as", "asa", "da", "ans", "enk", "sa", "ba", "ks", "nuf", "stif", "stiftelse",
]);

export function normaliseName(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseNamePruned(s: string): string {
  const tokens = normaliseName(s).split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && ORG_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

function firstToken(s: string): string {
  const t = normaliseName(s).split(/\s+/).filter(Boolean);
  return t[0] || "";
}

// ─── Confidence-scorer (pure; exported for tests) ──────────────────────
//   Returns 1.0 / 0.95 / 0.80 / 0.0 per the rubric.
export function scoreNameMatch(
  query: string,
  hitName: string,
  queryPostal: string | null,
  hitPostal: string | null,
): number {
  const a = normaliseNamePruned(query);
  const b = normaliseNamePruned(hitName);
  if (a.length > 0 && a === b) return 1.0;

  const qf = firstToken(query);
  const hf = firstToken(hitName);
  if (qf.length > 0 && qf === hf) {
    if (queryPostal && hitPostal && queryPostal.trim() === hitPostal.trim()) {
      return 0.95;
    }
    return 0.80;
  }
  return 0.0;
}

// ─── Per-process cache ─────────────────────────────────────────────────
const lookupCache: Map<string, BrregHit | null> = new Map();

export function __clearBrregCacheForTesting(): void {
  lookupCache.clear();
}

export function brregCacheSize(): number {
  return lookupCache.size;
}

// ─── Polite fetch with timeout ─────────────────────────────────────────
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
        "User-Agent": "rettfrabonden.com-orchestrator (orchestrator@rettfrabonden.com)",
        "Accept": "application/json",
      },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// ─── Main entry ────────────────────────────────────────────────────────
//   findOrgnumberByName(name, postal?)
//   → top-confidence hit if score ≥ 0.9, else null.
//   Hits are cached per-process keyed by (normalised name, postal).
export async function findOrgnumberByName(
  name: string,
  postalCode?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<BrregHit | null> {
  const cleanName = (name || "").trim();
  if (!cleanName) return null;

  const cacheKey = `${normaliseName(cleanName)}|${postalCode || "-"}`;
  if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey) ?? null;

  // Brreg's search expects `navn` URL-encoded; size=5 limits hits.
  const url = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}?navn=${encodeURIComponent(cleanName)}&size=5`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn("[brreg-client] fetch failed:", err instanceof Error ? err.message : err);
    lookupCache.set(cacheKey, null);
    return null;
  }
  if (!res.ok) {
    lookupCache.set(cacheKey, null);
    return null;
  }
  let json: any;
  try { json = await res.json(); } catch { lookupCache.set(cacheKey, null); return null; }

  const enheter: RawEnhet[] =
    (json && json._embedded && Array.isArray(json._embedded.enheter))
      ? json._embedded.enheter as RawEnhet[]
      : [];

  let best: BrregHit | null = null;
  for (const h of enheter) {
    if (!h || typeof h.organisasjonsnummer !== "string" || typeof h.navn !== "string") continue;
    const hitPostal = h.forretningsadresse?.postnummer ?? h.postadresse?.postnummer ?? null;
    const score = scoreNameMatch(cleanName, h.navn, postalCode ?? null, hitPostal);
    if (!best || score > best.confidence) {
      best = {
        orgnumber: h.organisasjonsnummer,
        name: h.navn,
        confidence: score,
        brreg_postal: hitPostal,
      };
    }
  }

  // Threshold: only return matches at confidence ≥ 0.9.
  const result: BrregHit | null = (best && best.confidence >= 0.9) ? best : null;
  lookupCache.set(cacheKey, result);
  return result;
}
