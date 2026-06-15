// ─── Experiences Brreg-verifier — Phase 7 (Skjer) ───────────────────
//
// SERVER-SIDE port of code-updates/experiences-harvest/brreg-verify.mjs.
// Resolves a harvested provider_name (+ optional kommune) to a Brreg
// org_nr and an active/inactive verdict. Brreg is the VERIFIER here, not
// the discovery source. This runs inside the lokal app (which CAN reach
// data.brreg.no) rather than the harvest sandbox (which cannot).
//
// CRITICAL LESSON (sample run 2026-06-14, ported verbatim): the Brreg
// `navn` search is fuzzy and returns NOISE (e.g. "Go Fjords"→FJORDS AS
// film co). So we NEVER blind-accept the top hit — a candidate passes
// only a name-similarity gate AND a NACE-plausibility gate (kommune is a
// tiebreaker). Names that fail fall through to `unverified` (website-
// fallback / manual review) rather than being force-matched.
//
// ZERO coupling to rfb/dental. Uses global fetch (Node 18+); tests inject
// a stub via __setBrregFetchForTesting (no real network in the suite).

// ── Injectable fetch (test seam, mirrors init.__setDbForTesting) ─────
type FetchLike = (url: string, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

let _injectedFetch: FetchLike | null = null;

/** Test-only: override the fetch used for Brreg calls. Pass null to clear. */
export function __setBrregFetchForTesting(fn: FetchLike | null): void {
  _injectedFetch = fn;
}
function resolveFetch(override?: FetchLike): FetchLike {
  if (override) return override;
  if (_injectedFetch) return _injectedFetch;
  // Global fetch (Node 18+ / the lokal runtime). Cast: the DOM lib's
  // Response is structurally compatible with the slice we use.
  return ((globalThis as unknown as { fetch: FetchLike }).fetch) as FetchLike;
}

const BRREG = "https://data.brreg.no/enhetsregisteret/api/enheter";
const UA = "SkjerBot/0.1 (+https://skjer.org/bot; Brreg-verifier)";

// Experience-plausible NACE prefixes (SN2025) — ported from brreg-verify.mjs.
const NACE_ALLOW = [
  "50.10",
  "55.20", "55.30",
  "77.21",
  "79.11", "79.12",
  "90.0",
  "91.21",
  "93.11", "93.13", "93.19", "93.21",
  "93.29",
  "49.34",
  "49.39",
];

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const norm = (s: string): string =>
  (s || "")
    .toLowerCase()
    .replace(/\b(as|asa|enk|ans|sa|da)\b/g, "")
    .replace(/[^a-z0-9æøå ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function nameSimilarity(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size); // token-overlap (containment)
}

const naceOk = (kode?: string): boolean =>
  !!kode && NACE_ALLOW.some((p) => kode.startsWith(p));

// Active = not bankrupt, not under liquidation/compulsory dissolution and
// not deleted. (brreg-verify.mjs used the first three flags; `slettedato`
// set ⇒ deleted ⇒ inactive, also handled here per the task's Glaciertour
// exclusion requirement.)
interface BrregEntity {
  organisasjonsnummer?: string;
  navn?: string;
  konkurs?: boolean;
  underAvvikling?: boolean;
  underTvangsavviklingEllerTvangsopplosning?: boolean;
  slettedato?: string | null;
  naeringskode1?: { kode?: string };
  forretningsadresse?: { kommune?: string };
}
const isActive = (e: BrregEntity): boolean =>
  !e.konkurs &&
  !e.underAvvikling &&
  !e.underTvangsavviklingEllerTvangsopplosning &&
  !e.slettedato;

async function brregByName(name: string, fetchImpl: FetchLike): Promise<BrregEntity[]> {
  const url = `${BRREG}?navn=${encodeURIComponent(name)}&size=5`;
  const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) return [];
  const j = (await res.json()) as { _embedded?: { enheter?: BrregEntity[] } } | null;
  return j?._embedded?.enheter ?? [];
}

// ── Classification ───────────────────────────────────────────────────
export type BrregClass = "verified_active" | "inactive" | "unverified";

export interface ProviderInput {
  name: string;
  kommune?: string | null;
}

export interface BrregVerdict {
  provider_name: string;
  classification: BrregClass;
  org_nr: string | null;
  brreg_verified: 0 | 1;
  brreg_active: 0 | 1 | null;
  matched_navn?: string | null;
  naeringskode?: string | null;
  match_confidence?: "high" | "medium" | null;
  reason: string;
}

/**
 * Resolve ONE provider → a Brreg verdict. Ported from brreg-verify.mjs's
 * `verify()` (the name-search + dual-gate path; the website-orgnr fallback
 * in the .mjs was truncated, so a no-confident-match here yields
 * `unverified` for website-fallback / manual review downstream).
 *
 * Classes:
 *   - verified_active : confident Brreg match AND entity active
 *   - inactive        : confident Brreg match BUT slettet / konkurs / avvikling
 *   - unverified      : no confident name match (brreg_verified=0)
 */
export async function classifyProvider(
  provider: ProviderInput,
  opts: { fetchImpl?: FetchLike } = {}
): Promise<BrregVerdict> {
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const candidates = await brregByName(provider.name, fetchImpl);

  let best: { e: BrregEntity; sim: number; nace?: string; kommuneOk: boolean } | null = null;
  let bestScore = 0;
  for (const e of candidates) {
    const sim = nameSimilarity(provider.name, e.navn || "");
    const nace = e.naeringskode1?.kode;
    const kommuneOk =
      !provider.kommune ||
      !e.forretningsadresse?.kommune ||
      norm(provider.kommune) === norm(e.forretningsadresse.kommune);
    // Accept gate: strong name match AND plausible NACE (kommune is a tiebreaker).
    const score = (sim >= 0.6 ? sim : 0) * (naceOk(nace) ? 1 : 0.2) * (kommuneOk ? 1 : 0.7);
    if (score > bestScore) {
      bestScore = score;
      best = { e, sim, nace, kommuneOk };
    }
  }

  if (best && best.sim >= 0.6 && naceOk(best.nace)) {
    const active = isActive(best.e);
    return {
      provider_name: provider.name,
      classification: active ? "verified_active" : "inactive",
      org_nr: best.e.organisasjonsnummer ?? null,
      brreg_verified: 1,
      brreg_active: active ? 1 : 0,
      matched_navn: best.e.navn ?? null,
      naeringskode: best.nace ?? null,
      match_confidence: best.sim >= 0.85 && best.kommuneOk ? "high" : "medium",
      reason: active ? "ok" : "matched_but_inactive",
    };
  }

  // No plausible name match → unverified (website-fallback / manual review).
  return {
    provider_name: provider.name,
    classification: "unverified",
    org_nr: null,
    brreg_verified: 0,
    brreg_active: null,
    matched_navn: null,
    naeringskode: null,
    match_confidence: null,
    reason: "no_confident_brreg_match",
  };
}
