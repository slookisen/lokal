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
  // ─── dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach,
  // slice 5b ───────────────────────────────────────────────────────────────
  // The hit's raw poststed (town name), read the same way brreg_postal is
  // (forretningsadresse falling back to postadresse). Exists specifically so
  // callers needing an EXACT poststed comparison (e.g.
  // gardssalgOrgnrPostalCorroborated, experience-store.ts) never have to
  // parse it back out of the formatted `address` display string below — a
  // substring test against that string is unsafe (a short poststed like
  // "Nes" or "Os" is a substring of unrelated towns like "Sandnes"/"Oslo").
  brreg_poststed?: string | null;
  // ─── slice 5b hardening (integration review, 2026-07-19) ────────────────
  // How many hits in the SAME search response scored the exact-match tier
  // (1.0). findOrgnumberByName returns only the best hit, and with a strict
  // ">" comparison "best" among several 1.0 hits is response-ORDER-dependent
  // — e.g. "SOLBAKKEN GARD" (ENK) vs "SOLBAKKEN GARD AS" both prune to the
  // same name and both score 1.0. A caller writing identity keys must treat
  // exact_ties > 1 as ambiguous and refuse to auto-write.
  exact_ties?: number;
  // ─── dev-request 2026-07-03-places-api-cost-reduction, measure 3 ───────
  // Formatted street address ("<adresse>, <postnummer> <poststed>"), when
  // Brreg's response for this hit includes a usable street line. null when
  // Brreg has no street-level address for the hit (a bare postnummer alone
  // is not "usable" — callers should fall back to Google in that case).
  // Brreg's Enhetsregisteret API has no phone-number field at all, so there
  // is no equivalent "address" companion for phone.
  address: string | null;
};

type RawBrregAddress = {
  postnummer?: string | null;
  poststed?: string | null;
  adresse?: string[] | null;
};

type RawEnhet = {
  organisasjonsnummer: string;
  navn: string;
  forretningsadresse?: RawBrregAddress | null;
  postadresse?: RawBrregAddress | null;
};

// ─── formatBrregAddress ─────────────────────────────────────────────────
// Formats a Brreg address sub-object into a single display string, e.g.
// "Storgata 1, 0155 Oslo". Returns null unless there's an actual street
// line (`adresse`) — a postnummer/poststed with no street is not a usable
// address for our purposes (measure 3: only fall back to BRREG's address
// when it has something genuinely usable).
function formatBrregAddress(addr: RawBrregAddress | null | undefined): string | null {
  if (!addr) return null;
  const street = Array.isArray(addr.adresse)
    ? addr.adresse.filter((s): s is string => typeof s === "string" && s.trim() !== "").join(", ")
    : "";
  if (!street) return null;
  const tail = [addr.postnummer, addr.poststed]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .join(" ");
  return tail ? `${street}, ${tail}` : street;
}

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

// ─── Org-nr direct verification (Slice 1 of dev-request ────────────────
//   2026-06-30-brreg-verification-gate) ──────────────────────────────────
//
// verifyOrgNumber(orgNr) does a DIRECT lookup by org-nr (not a name search)
// against GET /enheter/{orgNr}. Unlike findOrgnumberByName, there is no
// fuzzy matching here — the org-nr is already known, we just need Brreg's
// current record for it (active/inactive, registered name, NACE codes).
//
// Brreg's single-unit shape includes (per the real Enhetsregisteret API,
// same field-presence convention already used by experience-brreg.ts's
// BrregEntity): `konkurs: boolean`, `underAvvikling: boolean`,
// `underTvangsavviklingEllerTvangsopplosning: boolean`, and
// `slettedato: string | null` (presence = deleted/dissolved). There is no
// separate "konkursdato" field in the real API — bankruptcy is exposed as
// the `konkurs` boolean, which is the convention experience-brreg.ts
// already relies on, so verifyOrgNumber mirrors it for consistency.
//
// This function is intentionally NOT wired into any registration/
// enrichment endpoint yet — that's deferred to a later slice. It's purely
// additive: a reusable lookup a future caller can wire in.
export type BrregFlag = "dissolved" | "bankrupt" | "wrong_nace" | "name_mismatch" | "no_orgnr" | null;

export interface BrregVerifyResult {
  exists: boolean;
  active: boolean;           // false if konkurs / underAvvikling / underTvangsavviklingEllerTvangsopplosning / slettedato is set
  name: string | null;       // Brreg's registered name (foretaksnavn), for the caller to loosely compare
  nace: string[];            // naeringskode1..3 codes present, as an array of strings
  registrertDato: string | null;
  slettetDato: string | null;
  flag: BrregFlag;           // "dissolved" if slettetDato set, "bankrupt" if konkurs, else null when active+exists
}

type RawEnhetDetail = {
  organisasjonsnummer?: string;
  navn?: string;
  konkurs?: boolean;
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  slettedato?: string | null;
  registreringsdatoEnhetsregisteret?: string | null;
  naeringskode1?: { kode?: string } | null;
  naeringskode2?: { kode?: string } | null;
  naeringskode3?: { kode?: string } | null;
  // Additive (dev-request 2026-07-18-gardssalg-profilkvalitet-foer-outreach,
  // slice 3) — fetchBrregBusinessAddress() reads these; verifyOrgNumber()
  // never has, so their addition here is a no-op for every existing caller.
  forretningsadresse?: RawBrregAddress | null;
  postadresse?: RawBrregAddress | null;
};

const SAFE_DEFAULT_VERIFY_RESULT: BrregVerifyResult = {
  exists: false,
  active: false,
  name: null,
  nace: [],
  registrertDato: null,
  slettetDato: null,
  flag: "no_orgnr",
};

// Tiny separate per-process cache keyed by orgNr — org-nr lookups are cheap
// and direct, so this is mostly to avoid hammering Brreg on repeated calls
// for the same org-nr within one run. Not required by callers.
const verifyCache: Map<string, BrregVerifyResult> = new Map();

export function __clearBrregVerifyCacheForTesting(): void {
  verifyCache.clear();
}

export function brregVerifyCacheSize(): number {
  return verifyCache.size;
}

/**
 * verifyOrgNumber(orgNr) — direct Brreg lookup by org-nr (GET /enheter/{orgNr}).
 * A 404 means the org-nr doesn't exist in Brreg. Never throws: any
 * network/parse error or 404 resolves to the safe default result
 * (`exists: false`, `flag: "no_orgnr"`).
 *
 * Does NOT do fuzzy name matching (no query name is needed — the org-nr is
 * already known). `flag` here only ever comes back as "dissolved",
 * "bankrupt", or null (active+exists) — or "no_orgnr" via the safe default.
 * "wrong_nace" and "name_mismatch" are NOT computed here; they require
 * vertical-specific NACE allow-lists / a caller-supplied name to compare
 * against, so callers may set those themselves after inspecting the result.
 */
export async function verifyOrgNumber(
  orgNr: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrregVerifyResult> {
  const cleanOrgNr = (orgNr || "").trim();
  if (!cleanOrgNr) return { ...SAFE_DEFAULT_VERIFY_RESULT };

  if (verifyCache.has(cleanOrgNr)) return { ...(verifyCache.get(cleanOrgNr) as BrregVerifyResult) };

  const url = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(cleanOrgNr)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn("[brreg-client] verifyOrgNumber fetch failed:", err instanceof Error ? err.message : err);
    return { ...SAFE_DEFAULT_VERIFY_RESULT };
  }

  if (res.status === 404) {
    const result = { ...SAFE_DEFAULT_VERIFY_RESULT };
    verifyCache.set(cleanOrgNr, result);
    return { ...result };
  }
  if (!res.ok) {
    return { ...SAFE_DEFAULT_VERIFY_RESULT };
  }

  let json: RawEnhetDetail;
  try {
    json = (await res.json()) as RawEnhetDetail;
  } catch {
    return { ...SAFE_DEFAULT_VERIFY_RESULT };
  }
  if (!json || typeof json.organisasjonsnummer !== "string") {
    return { ...SAFE_DEFAULT_VERIFY_RESULT };
  }

  const nace = [json.naeringskode1?.kode, json.naeringskode2?.kode, json.naeringskode3?.kode]
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  const slettetDato = json.slettedato ?? null;
  const active =
    !json.konkurs &&
    !json.underAvvikling &&
    !json.underTvangsavviklingEllerTvangsopplosning &&
    !slettetDato;

  let flag: BrregFlag = null;
  if (slettetDato) flag = "dissolved";
  else if (json.konkurs) flag = "bankrupt";

  const result: BrregVerifyResult = {
    exists: true,
    active,
    name: typeof json.navn === "string" ? json.navn : null,
    nace,
    registrertDato: json.registreringsdatoEnhetsregisteret ?? null,
    slettetDato,
    flag,
  };
  verifyCache.set(cleanOrgNr, result);
  return { ...result };
}

// ─── Activity-description fallback (dev-request ────────────────────────
//     2026-06-30-open-stuck-verification-bucket) ─────────────────────────
//
// fetchBrregActivityDescription(orgNr) returns Brreg's own registered NACE
// activity-description text (naeringskode{1,2,3}.beskrivelse) for a given
// org number — used as a DESCRIPTION FALLBACK for agents whose homepage
// crawl failed during enrichment (the `http_unreachable` bucket), so they
// never got a real description. Brreg is already a trusted source
// elsewhere in this codebase (brreg-verification-gate, brreg-nace-
// discovery); this hits the SAME GET /enheter/{orgNr} endpoint
// verifyOrgNumber() already calls, but reads a field verifyOrgNumber never
// has — verifyOrgNumber only reads naeringskode{N}.kode (the numeric NACE
// code), never .beskrivelse (the human-readable activity-description text).
//
// Priority: naeringskode1's text, falling back to kode2, then kode3, if the
// higher-priority code has no non-empty beskrivelse. Returns null when none
// of the three has one.

type RawNaeringskode = { kode?: string; beskrivelse?: string | null } | null | undefined;

interface RawEnhetActivity {
  naeringskode1?: RawNaeringskode;
  naeringskode2?: RawNaeringskode;
  naeringskode3?: RawNaeringskode;
}

/**
 * Pure — picks the first non-empty `beskrivelse` from naeringskode1/2/3, in
 * that priority order. Exported for unit-testing without network I/O.
 */
export function pickBrregActivityDescription(enhet: RawEnhetActivity | null | undefined): string | null {
  if (!enhet) return null;
  for (const nk of [enhet.naeringskode1, enhet.naeringskode2, enhet.naeringskode3]) {
    const text = nk?.beskrivelse;
    if (typeof text === "string" && text.trim() !== "") return text.trim();
  }
  return null;
}

// Tiny per-process cache keyed by orgNr — mirrors verifyCache's rationale
// (avoid hammering Brreg on repeated calls for the same org-nr in one run).
const activityDescriptionCache: Map<string, string | null> = new Map();

export function __clearBrregActivityDescriptionCacheForTesting(): void {
  activityDescriptionCache.clear();
}

/**
 * fetchBrregActivityDescription(orgNr) — direct Brreg lookup by org-nr
 * (GET /enheter/{orgNr}), returning the registered NACE activity-description
 * text (see pickBrregActivityDescription). Never throws: any network/parse
 * error or 404 resolves to null — same safe-default convention as
 * verifyOrgNumber. Does not do fuzzy name matching; the org-nr is already
 * known.
 */
export async function fetchBrregActivityDescription(
  orgNr: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const cleanOrgNr = (orgNr || "").trim();
  if (!cleanOrgNr) return null;

  if (activityDescriptionCache.has(cleanOrgNr)) return activityDescriptionCache.get(cleanOrgNr) ?? null;

  const url = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(cleanOrgNr)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn(
      "[brreg-client] fetchBrregActivityDescription fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (res.status === 404) {
    activityDescriptionCache.set(cleanOrgNr, null);
    return null;
  }
  if (!res.ok) return null;

  let json: RawEnhetActivity;
  try {
    json = (await res.json()) as RawEnhetActivity;
  } catch {
    return null;
  }

  const result = pickBrregActivityDescription(json);
  activityDescriptionCache.set(cleanOrgNr, result);
  return result;
}

// ─── Business address (dev-request 2026-07-18-gardssalg-profilkvalitet- ──
//     foer-outreach, slice 3) ─────────────────────────────────────────────
//
// fetchBrregBusinessAddress(orgNr) returns Brreg's registered street address
// (forretningsadresse, falling back to postadresse when forretningsadresse
// has no usable street line) for a given org number — used to backfill
// experience_providers.adresse/postnummer/poststed for gårdssalg providers
// that never had a street address filled in (only 42 of 74 do). Hits the
// SAME GET /enheter/{orgNr} endpoint verifyOrgNumber() and
// fetchBrregActivityDescription() already call, reading yet another field
// neither of those two reads. Never throws — same safe-default discipline.
//
// "Usable" mirrors formatBrregAddress's existing convention above (used by
// findOrgnumberByName): only a non-empty `adresse` (street line) array
// counts as usable — a bare postnummer/poststed with no street line is not
// useful for our purposes, so pickBrregAddress returns null (not a partial
// object) rather than a result with adresse: null but postnummer/poststed
// filled in.

export type BrregAddress = {
  adresse: string | null;     // street line only, e.g. "Gårdsveien 12"
  postnummer: string | null;
  poststed: string | null;
};

function pickBrregAddress(
  forretningsadresse: RawBrregAddress | null | undefined,
  postadresse: RawBrregAddress | null | undefined,
): BrregAddress | null {
  for (const addr of [forretningsadresse, postadresse]) {
    if (!addr) continue;
    const street = Array.isArray(addr.adresse)
      ? addr.adresse.filter((s): s is string => typeof s === "string" && s.trim() !== "").join(", ")
      : "";
    if (!street) continue; // no usable street line on this sub-object — try the next one
    return {
      adresse: street,
      postnummer:
        typeof addr.postnummer === "string" && addr.postnummer.trim() !== "" ? addr.postnummer.trim() : null,
      poststed: typeof addr.poststed === "string" && addr.poststed.trim() !== "" ? addr.poststed.trim() : null,
    };
  }
  return null;
}

// Own small per-process cache keyed by orgNr — deliberately NOT shared with
// verifyCache/activityDescriptionCache (each of these three org-nr lookup
// functions caches independently, mirroring the file's existing convention).
const addressCache: Map<string, BrregAddress | null> = new Map();

export function __clearBrregAddressCacheForTesting(): void {
  addressCache.clear();
}

/**
 * fetchBrregBusinessAddress(orgNr) — direct Brreg lookup by org-nr
 * (GET /enheter/{orgNr}), returning the registered street address (see
 * pickBrregAddress above for the forretningsadresse -> postadresse fallback
 * and "usable street line" rule). Never throws: any network/parse error,
 * 404, or "no usable street line anywhere" resolves to null — same
 * safe-default convention as verifyOrgNumber/fetchBrregActivityDescription.
 * Does not do fuzzy name matching; the org-nr is already known.
 */
export async function fetchBrregBusinessAddress(
  orgNr: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrregAddress | null> {
  const cleanOrgNr = (orgNr || "").trim();
  if (!cleanOrgNr) return null;

  if (addressCache.has(cleanOrgNr)) return addressCache.get(cleanOrgNr) ?? null;

  const url = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(cleanOrgNr)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn(
      "[brreg-client] fetchBrregBusinessAddress fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (res.status === 404) {
    addressCache.set(cleanOrgNr, null);
    return null;
  }
  if (!res.ok) return null;

  let json: RawEnhetDetail;
  try {
    json = (await res.json()) as RawEnhetDetail;
  } catch {
    return null;
  }

  const result = pickBrregAddress(json.forretningsadresse, json.postadresse);
  addressCache.set(cleanOrgNr, result);
  return result;
}

// ─── Website (hjemmeside) lookup (dev-request 2026-07-12-experiences- ───
//     enrichment-supply-and-aggregator-hygiene, step 2, evidence-leg (b)) ──
//
// fetchBrregWebsite(orgNr) returns Brreg's own registered website field
// (`hjemmeside`) for a given org number — used as an evidence-leg for
// providers left hjemmeside-blank by step 1's aggregator-URL cleanup sweep,
// alongside leg (a)'s listing-page-link discovery. Hits the SAME
// GET /enheter/{orgNr} endpoint verifyOrgNumber()/
// fetchBrregActivityDescription()/fetchBrregBusinessAddress() already call,
// reading yet another field none of those three reads. Never throws — same
// safe-default discipline (any network/parse error or 404 resolves to
// null). Does not do fuzzy name matching; the org-nr is already known.

type RawEnhetWebsite = {
  hjemmeside?: string | null;
};

// Own small per-process cache keyed by orgNr — deliberately NOT shared with
// the other three org-nr lookup caches above (each of these functions
// caches independently, mirroring the file's existing convention).
const websiteCache: Map<string, string | null> = new Map();

export function __clearBrregWebsiteCacheForTesting(): void {
  websiteCache.clear();
}

/**
 * fetchBrregWebsite(orgNr) — direct Brreg lookup by org-nr
 * (GET /enheter/{orgNr}), returning the registered website (`hjemmeside`),
 * trimmed, with an empty string treated as null. Never throws: any
 * network/parse error, 404, or missing/blank field resolves to null — same
 * safe-default convention as verifyOrgNumber/fetchBrregActivityDescription/
 * fetchBrregBusinessAddress. Does not do fuzzy name matching; the org-nr is
 * already known.
 */
export async function fetchBrregWebsite(
  orgNr: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const cleanOrgNr = (orgNr || "").trim();
  if (!cleanOrgNr) return null;

  if (websiteCache.has(cleanOrgNr)) return websiteCache.get(cleanOrgNr) ?? null;

  const url = `${BRREG_BASE_URL}${BRREG_SEARCH_PATH}/${encodeURIComponent(cleanOrgNr)}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, fetchImpl);
  } catch (err) {
    console.warn(
      "[brreg-client] fetchBrregWebsite fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (res.status === 404) {
    websiteCache.set(cleanOrgNr, null);
    return null;
  }
  if (!res.ok) return null;

  let json: RawEnhetWebsite;
  try {
    json = (await res.json()) as RawEnhetWebsite;
  } catch {
    return null;
  }

  const result =
    typeof json.hjemmeside === "string" && json.hjemmeside.trim() !== ""
      ? json.hjemmeside.trim()
      : null;
  websiteCache.set(cleanOrgNr, result);
  return result;
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
  let exactTies = 0;
  for (const h of enheter) {
    if (!h || typeof h.organisasjonsnummer !== "string" || typeof h.navn !== "string") continue;
    const hitPostal = h.forretningsadresse?.postnummer ?? h.postadresse?.postnummer ?? null;
    const hitPoststed = h.forretningsadresse?.poststed ?? h.postadresse?.poststed ?? null;
    const score = scoreNameMatch(cleanName, h.navn, postalCode ?? null, hitPostal);
    if (score === 1.0) exactTies++;
    if (!best || score > best.confidence) {
      best = {
        orgnumber: h.organisasjonsnummer,
        name: h.navn,
        confidence: score,
        brreg_postal: hitPostal,
        brreg_poststed: hitPoststed,
        address: formatBrregAddress(h.forretningsadresse ?? h.postadresse ?? null),
      };
    }
  }
  if (best) best.exact_ties = exactTies;

  // Threshold: only return matches at confidence ≥ 0.9.
  const result: BrregHit | null = (best && best.confidence >= 0.9) ? best : null;
  lookupCache.set(cacheKey, result);
  return result;
}
