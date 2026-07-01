// ─── Brreg single-org verification (dev-request 2026-06-30-brreg-verification-gate, slice 1) ──
//
// Standalone, reusable org-number → verification-result lookup against the
// Brønnøysund Enhetsregisteret open API's single-entity endpoint:
//
//   GET https://data.brreg.no/enhetsregisteret/api/enheter/{orgNumber}
//
// This is DIFFERENT from the two existing Brreg helpers in this codebase
// (services/brreg-client.ts and services/experience-brreg.ts), which both
// call the bulk *name-search* endpoint (`?navn=...`) to reverse-resolve an
// orgnumber from a business name. This module instead takes an orgnumber
// that's ALREADY KNOWN (e.g. entered at agent registration) and confirms it
// against Brreg directly — no fuzzy name matching involved.
//
// PURE ADDITIVE UTILITY: not wired into any registration endpoint, route,
// or schema yet — that's a future slice. Verification here is a POSITIVE
// trust signal only; callers must never hard-block or auto-delete an agent
// off the back of this alone.
//
// Response shape for a known org (fields relevant to us; API returns more):
//   {
//     organisasjonsnummer: "923609016",
//     navn: "EQUINOR ASA",
//     registreringsdatoEnhetsregisteret: "1995-01-13" | undefined,
//     slettedato: "2020-01-01" | undefined,        // present ⇒ dissolved
//     konkurs: true | undefined,                    // ⇒ bankrupt
//     underAvvikling: true | undefined,
//     underTvangsavviklingEllerTvangsopplosning: true | undefined,
//     naeringskode1: { kode: "06.100", beskrivelse: "..." } | undefined,
//     naeringskode2: { kode: "...", ... } | undefined,
//     naeringskode3: { kode: "...", ... } | undefined,
//     ...
//   }
// A non-existent orgnumber returns HTTP 404 (no body worth parsing).
//
// NOTE: this file was authored without live network access to
// data.brreg.no from the implementation sandbox, so the field names above
// are taken from (a) the task spec and (b) cross-checked against the field
// names already relied on elsewhere in this codebase for the SAME API
// (services/experience-brreg.ts's BrregEntity: organisasjonsnummer, navn,
// konkurs, underAvvikling, underTvangsavviklingEllerTvangsopplosning,
// slettedato, naeringskode1.kode) — NOT independently verified live. Flag
// this for reviewer attention; confirm against a live
// `curl https://data.brreg.no/enhetsregisteret/api/enheter/923609016` when
// network access is available, before this is wired into anything live.

export interface BrregVerifyResult {
  exists: boolean;
  orgNumber: string;
  name?: string;
  status?: "active" | "dissolved" | "bankrupt" | "liquidation" | "unknown";
  nace?: string[];
  registrertDato?: string;
  slettetDato?: string;
  konkurs?: boolean;
  raw?: unknown; // raw API response, for callers who need more detail
}

// ── Injectable fetch (test seam, mirrors experience-brreg.ts's convention) ──
type FetchLike = typeof fetch;

let _injectedFetch: FetchLike | null = null;

/** Test-only: override the fetch used for Brreg calls. Pass null to clear. */
export function __setBrregVerifyFetchForTesting(fn: FetchLike | null): void {
  _injectedFetch = fn;
}

function resolveFetch(override?: FetchLike): FetchLike {
  if (override) return override;
  if (_injectedFetch) return _injectedFetch;
  return fetch;
}

const BRREG_ENHET_BASE = "https://data.brreg.no/enhetsregisteret/api/enheter";
const REQUEST_TIMEOUT_MS = 8000;
const UA = "rettfrabonden.com-orchestrator (orchestrator@rettfrabonden.com)";

// Norwegian org-numbers are exactly 9 digits. We accept spaces in the input
// (a common human-entry format, e.g. "923 609 016") and strip them before
// validating/calling.
const ORG_NUMBER_RE = /^\d{9}$/;

export function sanitizeOrgNumber(input: string): string {
  return (input || "").replace(/\s+/g, "");
}

export function isValidOrgNumber(input: string): boolean {
  return ORG_NUMBER_RE.test(sanitizeOrgNumber(input));
}

interface RawEnhet {
  organisasjonsnummer?: string;
  navn?: string;
  registreringsdatoEnhetsregisteret?: string;
  slettedato?: string | null;
  konkurs?: boolean;
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  naeringskode1?: { kode?: string } | null;
  naeringskode2?: { kode?: string } | null;
  naeringskode3?: { kode?: string } | null;
}

function extractNace(raw: RawEnhet): string[] {
  const codes = [raw.naeringskode1?.kode, raw.naeringskode2?.kode, raw.naeringskode3?.kode].filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );
  return codes;
}

function classifyStatus(raw: RawEnhet): { status: BrregVerifyResult["status"]; konkurs: boolean } {
  const konkurs = !!raw.konkurs;
  if (konkurs) return { status: "bankrupt", konkurs: true };
  if (raw.underAvvikling || raw.underTvangsavviklingEllerTvangsopplosning) {
    return { status: "liquidation", konkurs: false };
  }
  if (raw.slettedato) return { status: "dissolved", konkurs: false };
  return { status: "active", konkurs: false };
}

async function fetchWithTimeout(url: string, fetchImpl: FetchLike): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
      },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Look up a single organisation by org-number against Brreg's Enhetsregisteret
 * and return a normalised verification result.
 *
 * Never throws: network errors, timeouts, and non-2xx/404 responses all
 * resolve to a result object (never a rejected promise), so a caller's
 * registration flow can never crash because Brreg is down or unreachable.
 */
export async function brregVerify(
  orgNumber: string,
  opts: { fetchImpl?: FetchLike } = {}
): Promise<BrregVerifyResult> {
  const clean = sanitizeOrgNumber(orgNumber);

  if (!ORG_NUMBER_RE.test(clean)) {
    return { exists: false, orgNumber: clean, status: "unknown" };
  }

  const fetchImpl = resolveFetch(opts.fetchImpl);
  const url = `${BRREG_ENHET_BASE}/${clean}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, fetchImpl);
  } catch (err) {
    console.error("[brreg-verify] fetch failed:", err instanceof Error ? err.message : err);
    return { exists: false, orgNumber: clean, status: "unknown" };
  }

  if (res.status === 404) {
    return { exists: false, orgNumber: clean };
  }

  if (!res.ok) {
    console.error(`[brreg-verify] non-OK response for ${clean}: HTTP ${res.status}`);
    return { exists: false, orgNumber: clean, status: "unknown" };
  }

  let raw: RawEnhet;
  try {
    raw = (await res.json()) as RawEnhet;
  } catch (err) {
    console.error("[brreg-verify] failed to parse JSON:", err instanceof Error ? err.message : err);
    return { exists: false, orgNumber: clean, status: "unknown" };
  }

  const { status, konkurs } = classifyStatus(raw);
  const nace = extractNace(raw);

  const result: BrregVerifyResult = {
    exists: true,
    orgNumber: raw.organisasjonsnummer || clean,
    name: raw.navn,
    status,
    konkurs,
    raw,
  };
  if (nace.length > 0) result.nace = nace;
  if (raw.registreringsdatoEnhetsregisteret) result.registrertDato = raw.registreringsdatoEnhetsregisteret;
  if (raw.slettedato) result.slettetDato = raw.slettedato;

  return result;
}
