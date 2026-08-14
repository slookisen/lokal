// ─── Gårdssalg producer <-> experience conflict AUTO-TRIAGE — pure classifier ─
//
// dev-request 2026-08-14-dublett-auto-triage (DRY-RUN / REPORT ONLY — this
// slice writes nothing anywhere; see routes/opplevelser.ts's
// GET /admin/gardssalg-experience-conflict-auto-triage doc comment for the
// full non-negotiable rationale, which traces back to the 2026-08-01
// gårdssalg-steg2-apply data-corruption incident).
//
// gardssalg-experience-conflict.ts already finds CANDIDATE (producer,
// experience) pairs (name_token / host_name basis) and queues every
// undecided one for a HUMAN to confirm/reject
// (GET /admin/gardssalg-experience-conflict-queue). That queue is ~331 rows
// today — this module is the pure decision core of an auto-triage REPORT
// that fetches both sides' pages and pre-sorts the queue into
// auto_confirm / auto_reject / pending, so a human only has to look closely
// at the genuinely ambiguous middle, with evidence attached. It does NOT
// decide anything — routes/opplevelser.ts's GET route calls this, once per
// pair, and only ever WRITES a JSON response.
//
// ─── Design: what "each side's own target identity" means ──────────────────
// `experience_providers` rows carry a real registered identity (org_nr,
// navn, kommune, poststed, telefon, mobil, adresse, postnummer) —
// `experiences` rows do NOT (no org_nr column at all; see
// database/init-experiences.ts). So the two sides of a pair are NOT
// symmetric, and "that side's own target identity" is built differently for
// each (the route, not this file, does the building — this module only
// consumes the already-built per-side result):
//
//   producer side  — the candidate producer's own experience_providers row.
//                    Always has a real identity to test the page against.
//   experience side — experience_providers.org_nr is UNIQUE (see
//                    database/init-experiences.ts), so two DIFFERENT
//                    producer rows can never legitimately share one — which
//                    is exactly why the two org.nr rules below need TWO
//                    different sourcing strategies, not one:
//                      - if the experience is CURRENTLY linked to some OTHER
//                        producer (experiences.provider_id — never the SAME
//                        id as the candidate here: pairs with provider_id
//                        === candidate producer_id are match_basis
//                        "provider_link" and are never queued, see
//                        buildGardssalgExperienceConflictQueuePairs), that
//                        OTHER producer's row IS the experience's own
//                        registered identity, org_nr included — this is what
//                        makes a genuine, DB-constraint-respecting distinct-
//                        org.nr auto_reject possible (two real rows, two
//                        really-different numbers).
//                      - otherwise (the common case, provider_id
//                        null/unmatched — the experience has no registry
//                        identity of its own AT ALL), the route falls back
//                        to testing the CANDIDATE producer's OWN org.nr
//                        against the experience's page instead (navn/kommune
//                        still come from the experience's own title/kommune
//                        either way) — "is this ALSO evidence of the
//                        candidate's business" is the only org.nr question
//                        that can even be asked when the experience carries
//                        no identity of its own, and it is what makes a
//                        genuine auto_confirm-via-org.nr reachable at all
//                        (the UNIQUE constraint makes "two different rows
//                        sharing one org.nr" impossible, so a real
//                        auto_confirm can only ever come from testing the
//                        SAME number on both pages, never two coincidentally
//                        -equal ones).
//
// So "same org.nr found+matching on both sides' pages" and "both sides show
// clearly DISTINCT org.nr" are both real, reachable, DB-constraint-
// respecting conditions — just sourced differently depending on whether the
// experience is linked. Either way, a bare "the two known org numbers
// differ/match" is never enough on its own: each side's evidence.
// org_nr_found must ALSO be true, i.e. the page itself must attest to it,
// not just the DB value.
//
// The producer-name <-> experience-title prefix/token overlap ("Austmann" ⊂
// "Austmann Bryggeri") is a SEPARATE, third signal — corroborating only,
// never sufficient alone (see classifyGardssalgExperienceConflictPair's own
// doc comment) — computed directly from the pair's display names, not
// through gardssalgWebsiteEvidenceMatch at all (that function matches a
// TARGET against PAGE TEXT; this is a short-string comparison between two
// names, a different kind of check entirely).

import type { FetchPersistence } from "./fetch-page";
import type { gardssalgWebsiteEvidenceMatch } from "./experience-store";

/** The (unchanged) return shape of gardssalgWebsiteEvidenceMatch — reused as
 *  a type only, never reimplemented. */
export type GsExpTriageEvidence = ReturnType<typeof gardssalgWebsiteEvidenceMatch>;

export type GsExpTriageVerdict = "auto_confirm" | "auto_reject" | "pending";

/** One side's already-computed inputs — the route builds this (fetch +
 *  gardssalgWebsiteEvidenceMatch + domain derivation), this module never
 *  fetches or matches anything itself. */
export interface GsExpTriageSide {
  fetch_ok: boolean;
  /** null when fetch_ok is true, OR when no fetch was attempted at all
   *  (blank/missing URL on this side) — only ever a real FetchPersistence
   *  value when a fetch was attempted and failed. */
  persistence: FetchPersistence | null;
  /** This side's own known registered org.nr (see the module doc comment
   *  above for how the route sources this per side) — null when this side
   *  has no known org.nr to test for at all. */
  org_nr: string | null;
  /** Registrable domain of the URL this side actually points to (the final,
   *  post-redirect URL when a fetch succeeded; the stored URL otherwise —
   *  domain comparison does not require a successful fetch). Null when
   *  blank/unparseable. */
  domain: string | null;
  /** gardssalgWebsiteEvidenceMatch()'s output for this side's page text
   *  against this side's own target identity. Null when no page text was
   *  available to match against (fetch failed or no URL at all) — NEVER
   *  synthesized/guessed. */
  evidence: GsExpTriageEvidence | null;
}

export interface GsExpTriagePairInput {
  /** Display names for the corroborating-only name-token check — the pair's
   *  own producer_name / experience_title (NOT necessarily the same string
   *  as either side's target identity `navn`, which may come from a
   *  DIFFERENT linked producer on the experience side — see module doc
   *  comment). */
  producer_name: string;
  experience_name: string;
  producer: GsExpTriageSide;
  experience: GsExpTriageSide;
}

export interface GsExpTriageResult {
  verdict: GsExpTriageVerdict;
  /** Named reason codes for the evidence report — never prose, so a caller
   *  can group/count them. Always at least one entry. */
  reasons: string[];
  /** Simple, defensible "how much evidence do we have" count: every true
   *  evidence sub-signal on EITHER side (org_nr/name/place/phone/address/
   *  postnr/title_found) plus 1 if the name-token support signal fired.
   *  Used ONLY to sort the pending bucket best-evidence-first — never part
   *  of the verdict decision itself. */
  confidence: number;
  name_token_support: boolean;
}

// ─── Name-token support (corroborating-only) ───────────────────────────────

function normalizeForTokenCompare(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (NFKD-decomposed)
    .replace(/[^a-z0-9æøå\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_TOKEN_SUPPORT_MIN_LEN = 5;

/**
 * Prefix/token containment between a producer's registered name and an
 * experience's display title — e.g. "Austmann" ⊂ "Austmann Bryggeri". PURE.
 * Deliberately SUPPORTING ONLY (see classifyGardssalgExperienceConflictPair):
 * this alone never decides a verdict, it only (a) blocks the domain-distinct
 * auto_reject rule from firing on two names that plainly refer to the same
 * business, and (b) contributes to the pending-bucket confidence score.
 */
export function hasNameTokenSupport(producerName: string, experienceName: string): boolean {
  const p = normalizeForTokenCompare(producerName);
  const e = normalizeForTokenCompare(experienceName);
  if (!p || !e) return false;
  if (e.includes(p) || p.includes(e)) return true;
  const pTokens = p.split(" ").filter((t) => t.length >= NAME_TOKEN_SUPPORT_MIN_LEN);
  const eTokens = new Set(e.split(" ").filter((t) => t.length >= NAME_TOKEN_SUPPORT_MIN_LEN));
  return pTokens.some((t) => eTokens.has(t));
}

// ─── Confidence (pending-bucket sort key only) ─────────────────────────────

function countEvidenceSignals(e: GsExpTriageEvidence | null): number {
  if (!e) return 0;
  return [e.org_nr_found, e.name_found, e.place_found, e.phone_found, e.address_found, e.postnr_found, e.title_found].filter(
    Boolean,
  ).length;
}

function computeConfidence(input: GsExpTriagePairInput, nameTokenSupport: boolean): number {
  return countEvidenceSignals(input.producer.evidence) + countEvidenceSignals(input.experience.evidence) + (nameTokenSupport ? 1 : 0);
}

// ─── The classifier ─────────────────────────────────────────────────────────

/**
 * Classify ONE (producer, experience) candidate pair given both sides'
 * already-fetched/matched evidence. PURE — no I/O, no DB, synchronous. See
 * this module's own doc comment for how the route builds `input`.
 *
 * Decision table (dev-request spec, exact order — auto_confirm checked
 * before auto_reject, both checked before falling through to pending):
 *
 *   0. TRANSIENT OVERRIDE (non-negotiable, checked first, before anything
 *      else): a `persistence === "transient"` fetch outcome on EITHER side
 *      forces "pending", full stop. A transient fetch means we could not
 *      observe that side's page THIS RUN — it is not evidence of anything,
 *      and must never combine with a strong signal on the OTHER side to
 *      produce a confirm/reject verdict (see fetch-page.ts's persistenceOf
 *      doc comment for why "transient" specifically, not permanent/blocked,
 *      is the one class this gates on).
 *
 *   1. auto_confirm — EITHER:
 *      (a) same org.nr, found+confirmed on BOTH sides' pages: both sides
 *          have a known org.nr, both evidence.org_nr_found is true, and the
 *          two org numbers are the SAME literal string; OR
 *      (b) same registered domain on both sides (both non-null, equal).
 *
 *   2. auto_reject — EITHER:
 *      (a) both sides show clearly DISTINCT org.nr: both have a known
 *          org.nr, both evidence.org_nr_found is true (page-confirmed, not
 *          just a DB-row coincidence), and the two numbers DIFFER; OR
 *      (b) clearly distinct domain (both non-null, different) AND no
 *          meaningful name-token overlap (hasNameTokenSupport is false) —
 *          a domain mismatch alone is not enough if the names plainly look
 *          like the same business, that stays pending for a human.
 *
 *   3. pending — everything else: missing/weak/ambiguous signal on either
 *      side, a distinct domain that IS name-corroborated, etc.
 *
 * The name-token support signal (Austmann ⊂ Austmann Bryggeri) is NEVER by
 * itself a trigger for auto_confirm — only org.nr-match or domain-match can
 * (rule 1 above). It is corroborating context only: it can keep a
 * domain-distinct pair OUT of auto_reject (rule 2b), and it feeds the
 * pending-bucket confidence score.
 */
export function classifyGardssalgExperienceConflictPair(input: GsExpTriagePairInput): GsExpTriageResult {
  const nameTokenSupport = hasNameTokenSupport(input.producer_name, input.experience_name);
  const confidence = computeConfidence(input, nameTokenSupport);

  if (input.producer.persistence === "transient" || input.experience.persistence === "transient") {
    return {
      verdict: "pending",
      reasons: ["transient_fetch_forces_pending"],
      confidence,
      name_token_support: nameTokenSupport,
    };
  }

  const producerOrgNr = (input.producer.org_nr || "").trim();
  const experienceOrgNr = (input.experience.org_nr || "").trim();
  const orgNrBothPresent = producerOrgNr !== "" && experienceOrgNr !== "";
  const orgNrBothConfirmedOnPage = !!input.producer.evidence?.org_nr_found && !!input.experience.evidence?.org_nr_found;
  const orgNrMatch = orgNrBothPresent && orgNrBothConfirmedOnPage && producerOrgNr === experienceOrgNr;
  const orgNrDistinct = orgNrBothPresent && orgNrBothConfirmedOnPage && producerOrgNr !== experienceOrgNr;

  const producerDomain = input.producer.domain;
  const experienceDomain = input.experience.domain;
  const domainBothPresent = !!producerDomain && !!experienceDomain;
  const domainMatch = domainBothPresent && producerDomain === experienceDomain;
  const domainDistinct = domainBothPresent && producerDomain !== experienceDomain;

  if (orgNrMatch || domainMatch) {
    const reasons: string[] = [];
    if (orgNrMatch) reasons.push("org_nr_match_both_sides");
    if (domainMatch) reasons.push("domain_match_both_sides");
    return { verdict: "auto_confirm", reasons, confidence, name_token_support: nameTokenSupport };
  }

  const domainDistinctNoNameSupport = domainDistinct && !nameTokenSupport;
  if (orgNrDistinct || domainDistinctNoNameSupport) {
    const reasons: string[] = [];
    if (orgNrDistinct) reasons.push("org_nr_distinct_both_sides");
    if (domainDistinctNoNameSupport) reasons.push("domain_distinct_no_name_overlap");
    return { verdict: "auto_reject", reasons, confidence, name_token_support: nameTokenSupport };
  }

  return {
    verdict: "pending",
    reasons: ["weak_or_ambiguous_signal"],
    confidence,
    name_token_support: nameTokenSupport,
  };
}

/** Sort a batch of triage results (paired with their pair identifiers, via
 *  the caller-supplied key) so the PENDING bucket reads best-evidence-first
 *  — descending confidence, the sole tie-break is the caller-supplied `key`
 *  (deterministic, so repeated calls over the same data always order
 *  identically). PURE. The route filters to pending itself; this only sorts
 *  whatever list it's given. */
export function sortByConfidenceDesc<T>(rows: T[], confidenceOf: (row: T) => number, keyOf: (row: T) => string): T[] {
  return [...rows].sort((a, b) => confidenceOf(b) - confidenceOf(a) || keyOf(a).localeCompare(keyOf(b)));
}
