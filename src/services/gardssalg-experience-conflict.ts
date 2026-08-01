// ─── Gårdssalg producer <-> experience/activity conflict diagnosis + remediation ─
//
// dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
// Steg 2 of 5.
//
// Gårdssalg (farm-shop) producers live in `experience_providers` as their own
// profile pages. Separately, the `experiences` catalog ("opplevelser") can
// independently contain a row describing the SAME real-world business,
// harvested from a different source, with its own (sometimes wrong)
// `booking_url`. These are two different entity TYPES in two different
// TABLES that nobody has cross-checked against each other. Confirmed concrete
// case (dev-request Funn 2): producer `atlungstad-brenneri--bbe4185d`
// (hjemmeside `atlungstadbrenneri.no`, owner/review-verified) vs an
// `experiences` row `…norway-s-oldest-distillery-tours-tastings--68220487`
// whose `booking_url` is `atlungstad.no` — a DIFFERENT real business (a
// riding school) that happens to share the place-name "Atlungstad". A guest
// who books via the experience entry is misdirected.
//
// NOT the same thing as GET /admin/gardssalg-provider-dedup-audit (lokal#440,
// routes/opplevelser.ts ~line 5975) — that endpoint dedupes
// `experience_providers` rows against EACH OTHER across seed sources
// (same-table dedup). This module is a cross-TABLE identity check: producer
// vs. experience/activity.
//
// ─── Matching design ────────────────────────────────────────────────────────
// Two independent signals decide whether a (producer, experience) pair is
// plausibly the SAME real-world business — either is sufficient on its own:
//
//   1. provider_link — experience.provider_id already equals the producer's
//      id. Strongest possible signal (an existing FK), always trusted.
//
//   2. name_token — a significant (>=5 char, post-normalization) token is
//      shared between the producer's searchable name (gardssalgSearchName()
//      strips the catalog's "— Sted" display suffix, experience-store.ts) and
//      the experience's title/title_no. Reuses titleTokens() from
//      experience-dedup.ts (the SAME tokenizer/stopword-list/diacritics-fold/
//      pluralization-stem this repo's other title-fuzzy-matching already
//      uses) rather than inventing a second one.
//
//      A bare shared token is NOT sufficient on its own — gårdssalg/drikke
//      producer names routinely share category words (the `producer_type`
//      enum vocabulary itself: bryggeri, cideri, vingård, destilleri,
//      mjøderi, gårdsbutikk, …), so two UNRELATED producers ("Nordfjord
//      Bryggeri", "Sørlandet Bryggeri") and an unrelated generic experience
//      ("Norsk Bryggeri Omvisning Sommer") would otherwise all match each
//      other purely on the word "bryggeri". Mirrors titlesMatch()'s own
//      rarity/corroboration gate (experience-dedup.ts) rather than inventing
//      a parallel heuristic: a shared token only counts alone when it is RARE
//      (isGenericNameToken() below — checked against the producer_type
//      vocabulary from route-corridor-service.ts, a curated corpus-size-
//      independent stoplist (GENERIC_FARM_PLACE_WORD_STOPLIST — round-3
//      review fix-up, see its own doc comment below), AND, the same
//      corpus-frequency method titlesMatch() uses via
//      buildProviderCorpusTokenCounts(), how many DISTINCT producers in THIS
//      scan's own producer list use it — any ONE of these three is
//      sufficient to call a token generic). A GENERIC shared token still
//      counts when corroborated by a second independent signal — also a
//      host_name match, or whole-title similarity >=
//      GENERIC_TOKEN_CORROBORATION_MIN (same threshold/method titlesMatch()
//      uses, levenshtein-based).
//      Deliberately does NOT reuse titlesMatch()'s unconditional whole-
//      string-similarity fallback branch (the "no shared token at all but
//      near-identical wording" case): that branch exists for re-harvested
//      clones of the SAME title text (experience-dedup.ts's own problem),
//      which is not this problem's shape — a company name and an unrelated-
//      looking activity title sharing zero tokens should not be treated as a
//      match just because they happen to be similarly SHORT strings.
//
//   3. host_name — the experience's booking_url resolves to a host whose
//      registrable-domain label (e.g. "atlungstad" out of "atlungstad.no")
//      exactly equals one of the producer's own significant name tokens. This
//      is what actually catches the confirmed Atlungstad case: its harvested
//      experience title is a generic marketing phrase ("Norway's Oldest
//      Distillery: Tours & Tastings") that shares no token with "Atlungstad
//      Brenneri" at all — the ONLY textual trace of the real business name is
//      in the (wrong) booking_url's host, which happens to carry the shared
//      place-name. Precisely the "en annen virksomhet med lignende navn"
//      (a different business with a similar name) shape the dev-request
//      names as the reason a naive domain-vs-name heuristic missed it before.
//
//      Round-2 review fix-up: a bare exact-token host-label match is subject
//      to the SAME genericity gate as name_token above (isGenericNameToken())
//      before being trusted — standalone as a match basis, or as
//      corroboration for an all-generic name_token set. Common words also
//      appear in producer names' domain-derived host labels (e.g. "gard" —
//      "gård"/"gard" is a normal word in this vertical's producer names, not
//      even in the producer_type enum), so an ungated host_name signal is
//      just as exploitable a false-positive path as an ungated name_token
//      one. A GENERIC host label is never accepted, either alone or as
//      corroboration — it is simply not real evidence. Atlungstad's host
//      label ("atlungstad") stays distinctive under this gate, so that case
//      is unaffected.
//
//      Round-3 review fix-up: the round-2 gate's corpus-frequency mechanism
//      is only as strong as the current scan's producer count — on a small
//      scan (or the real ~50-producer production corpus), "gard" and words
//      like it plausibly stay under SHARED_TOKEN_GENERIC_MIN and slip
//      through ungated regardless. isGenericNameToken() now also checks a
//      fixed, corpus-size-independent stoplist of common Norwegian
//      farm/place/business-generic words (GENERIC_FARM_PLACE_WORD_STOPLIST)
//      before falling back to corpus frequency, closing that gap for both
//      host_name and name_token. Compounding factor also fixed: the
//      genericity gate folds the historical "aa" digraph (foldHistoricalAa-
//      Digraph() below), so "gaard" (a real historical spelling in this
//      vertical) and "gård" count as the SAME key for both the stoplist
//      check and corpus-frequency counting instead of silently fragmenting
//      the corpus count across two spellings.
//
//      Round-4 review fix-up: that digraph fold is applied ONLY on the
//      genericity-gate path, and ONLY inside this file. It was originally
//      written into experience-dedup.ts's SHARED stripDiacritics(), which
//      also backs the pre-existing harvest-dedup title matcher — widening
//      that matcher's false-merge surface as a side effect of this PR. Two
//      reasons the fold belongs here instead, both about direction of harm:
//      on a genericity gate, over-folding is fail-SAFE (it can only make a
//      token look MORE generic, demanding MORE corroboration); on a MATCH
//      path it is fail-dangerous ("aa" is not always the digraph — "Isaac…"),
//      because collapsing two genuinely different names onto one shared
//      token manufactures a match. See foldHistoricalAaDigraph()'s own
//      comment for the full argument.
//
// Once a pair is matched (by any signal), its `status` is decided purely by
// comparing registrable domains — producer.hjemmeside is the dev-request's
// designated source of truth ("produsentens verifiserte hjemmeside er
// fasit"): "agree" (same registrable domain), "conflict" (both resolve, and
// differ), "unknown" (either side is blank/unparseable — never guessed), or
// "ambiguous" (see next paragraph).
//
// Same-experience/multiple-producer collision -> "ambiguous": because a
// single `experience_id` can legitimately match more than one producer as
// "conflict" (rare, but the genericity gate above only makes false positives
// LESS likely, not impossible — and two real producers CAN legitimately share
// a name), findGardssalgProducerExperienceMatches() reclassifies every
// "conflict"-status pair whose experience_id also conflict-matches a
// DIFFERENT producer_id to "ambiguous" before returning. This is load-bearing
// for remediation correctness: planGardssalgExperienceConflictRemediation()
// computes each pair's plan item independently from its own pre-batch SELECT,
// and applyGardssalgExperienceConflictRemediation() applies items
// sequentially with no same-batch collision check — without this
// reclassification, a second write for the same experience_id would silently
// (and non-deterministically, iteration-order-dependent) overwrite the first,
// with a stale audit old_value. Both callers key remediation off
// status==="conflict" only, so "ambiguous" pairs are automatically excluded
// from the remediation plan while still surfacing in the read-only diagnosis
// report (GsExpConflictSummary.ambiguous) for a human to resolve.
//
// catalog_hidden is NEVER used to exclude a producer from the SCAN (task
// spec): a hidden producer's conflicting duplicate is still worth knowing
// about, just noted via `producer_hidden` in the pair.

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { hostFromUrlLike, registrableDomain, isDirectoryOrAggregatorHost } from "./cross-source-validator";
import { titleTokens, normalizeExperienceTitle, levenshtein, buildProviderCorpusTokenCounts } from "./experience-dedup";
import { gardssalgSearchName, isExperienceContentLocked } from "./experience-store";
import { DRINK_PRODUCER_TYPES, NON_DRINK_PRODUCER_TYPES } from "./route-corridor-service";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GsExpProducerRow {
  id: string;
  navn: string;
  hjemmeside: string | null;
  catalog_hidden: number | null;
  fylke?: string | null;
  kommune?: string | null;
}

export interface GsExpExperienceRow {
  id: string;
  title: string;
  title_no: string | null;
  booking_url: string | null;
  provider_id: string | null;
  content_source?: string | null;
  verification_status?: string | null;
  content_field_evidence?: string | null;
}

export type GsExpMatchBasis = "provider_link" | "name_token" | "host_name";
// "ambiguous" is never assigned by the per-pair status decision itself (the
// domain-comparison block below only ever produces conflict/agree/unknown) —
// it is a POST-hoc reclassification applied to a subset of "conflict" pairs
// once the same-experience/multiple-producer collision check runs (see the
// module doc comment's "Same-experience/multiple-producer collision" section
// and findGardssalgProducerExperienceMatches()'s final pass). Mirrors the
// `provider_match_status='ambiguous'` vocabulary already used elsewhere on
// the `experiences` schema (see database/init-experiences.ts) rather than
// inventing a new status word for the same "a human must pick" concept.
export type GsExpConflictStatus = "conflict" | "agree" | "unknown" | "ambiguous";

export interface GsExpMatchedPair {
  producer_id: string;
  producer_name: string;
  producer_hidden: boolean;
  producer_hjemmeside: string | null;
  experience_id: string;
  experience_title: string;
  experience_booking_url: string | null;
  match_basis: GsExpMatchBasis;
  status: GsExpConflictStatus;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Registrable domain of any URL-like string (hjemmeside OR booking_url —
 *  the same host/registrable-domain derivation experience-store.ts's own
 *  homepageRegistrableDomain() uses, generalized to a plain param name since
 *  this file applies it to both sides). Null when blank/unparseable — never
 *  guessed. */
function urlRegistrableDomain(urlLike: string | null | undefined): string | null {
  if (!urlLike || !urlLike.trim()) return null;
  const host = hostFromUrlLike(urlLike);
  return host ? registrableDomain(host) : null;
}

// A shared token this long is distinctive enough to treat as a genuine
// name-mention rather than an incidental short word — mirrors
// experience-dedup.ts's SIGNIFICANT_TOKEN_MIN_LEN (that constant is not
// exported; the value itself, 5, is the convention being reused).
const NAME_TOKEN_MIN_LEN = 5;
// Host-label tokens are typically shorter/denser than prose tokens (bare
// domain labels, no filler words diluting them) — 4 chars is enough to avoid
// generic 3-letter false positives (e.g. "mat") without missing real short
// brand names.
const HOST_TOKEN_MIN_LEN = 4;

// ─── Generic-token gate (mirrors experience-dedup.ts's titlesMatch()) ──────
//
// A bare shared token is trustworthy alone only when it's RARE. "Rare" is
// decided by two mechanisms, either sufficient to call a token generic —
// deliberately the SAME two mechanisms this codebase already has (not a
// third, invented one):
//
//   1. producer_type vocabulary — the token is literally one of this
//      vertical's own category words (DRINK_PRODUCER_TYPES /
//      NON_DRINK_PRODUCER_TYPES, route-corridor-service.ts — the exact
//      producer_type enum values, e.g. "bryggeri", "cideri", "vingård").
//      Normalized through the same normalizeExperienceTitle() diacritics-fold
//      titleTokens() applies, so "vingård" (a token) matches the vocabulary
//      entry "vingård" the same way regardless of case/diacritics.
//
//   2. corpus frequency — how many DISTINCT producers in the CURRENT scan's
//      own producer list use the token in their name, via
//      buildProviderCorpusTokenCounts() (experience-dedup.ts) reused
//      unchanged: passing producer rows as {title: navn, provider_id: id}
//      makes its existing "count once per distinct provider" semantics do
//      exactly the right thing here. Same threshold value/convention as
//      titlesMatch()'s SHARED_TOKEN_GENERIC_MIN (that constant is not
//      exported; the value, 5, is the convention being reused, same pattern
//      as NAME_TOKEN_MIN_LEN above).
const SHARED_TOKEN_GENERIC_MIN = 5;

// Whole-string closeness required to corroborate a shared token that is
// GENERIC by either mechanism above — mirrors experience-dedup.ts's
// GENERIC_TOKEN_CORROBORATION_MIN exactly (same value, same not-exported
// convention as SHARED_TOKEN_GENERIC_MIN above).
const GENERIC_TOKEN_CORROBORATION_MIN = 0.85;

/**
 * Fold the historical Norwegian "aa" digraph — the pre-1917-spelling-reform
 * stand-in for "å", still a live spelling in real farm and place names
 * ("gaard"/"gård", "Aarhus"/"Århus") — onto the same "a" that
 * normalizeExperienceTitle()'s own diacritics pass already folds "å" to, so
 * both spellings of one word land on ONE key.
 *
 * This is deliberately applied ONLY on the genericity-gate path
 * (genericGateKey() below: stoplist membership + corpus-frequency counting)
 * and deliberately NOT to the token sets the MATCH decision is read from
 * (producerTokenSet()/experienceTokenSet()/sharedSignificantTokens()). The
 * asymmetry is the entire point, because the two paths fail in opposite
 * directions:
 *
 *   - On the genericity path, over-folding is fail-SAFE. Collapsing two
 *     unrelated spellings onto one key can only ever make a token look MORE
 *     common (corpus counts are monotonically non-decreasing under merging)
 *     or newly hit the stoplist — i.e. MORE likely to be judged generic, i.e.
 *     demanding MORE corroboration before a match is trusted. It can never
 *     manufacture a match.
 *   - On the match path it would be fail-DANGEROUS, because "aa" is not
 *     always the digraph ("Isaac…", "Haaneset" vs a genuinely distinct
 *     "Haneset"). Folding there could collapse two genuinely different names
 *     onto one shared token and manufacture a `conflict` — exactly the
 *     false-positive class rounds 1-3 of this PR's review closed, and on
 *     `apply=true` that overwrites a real business's booking_url.
 *
 * The cost of not folding on the match path is a missed duplicate (a false
 * NEGATIVE), which surfaces as a row simply not appearing in a read-only
 * diagnosis report — the fail-closed direction this dev-request already
 * mandates elsewhere.
 *
 * It also has to live here rather than in experience-dedup.ts's shared
 * stripDiacritics(): that helper backs the pre-existing harvest-dedup title
 * matcher (dev-request 2026-07-11-dedup-false-positive-remediation, which
 * exists because a defective matching rule over-merged 418 groups / 1361
 * rows in production) — a MATCH path, where per the argument above this fold
 * is precisely the wrong thing. Keeping it local means zero blast radius:
 * experience-dedup.ts stays byte-identical to pre-PR.
 */
function foldHistoricalAaDigraph(s: string): string {
  return s.replace(/aa/gi, "a");
}

/** The key a token is looked up under on the genericity-gate path — the
 *  normal title normalization plus the digraph fold above. Idempotent on
 *  already-normalized tokens, so it is safe to apply both when BUILDING the
 *  generic-word sets (whose literals still carry diacritics, e.g. "vingård")
 *  and when CHECKING a token that has already been through titleTokens(). */
function genericGateKey(token: string): string {
  return foldHistoricalAaDigraph(normalizeExperienceTitle(token));
}

const GENERIC_PRODUCER_TYPE_TOKENS = new Set(
  [...DRINK_PRODUCER_TYPES, ...NON_DRINK_PRODUCER_TYPES].map((t) => genericGateKey(t))
);

// ─── Round-3 review fix-up: a curated, corpus-SIZE-independent floor ───────
//
// Mechanism 2 above (corpus frequency) is entirely relative to how many
// producers happen to be in a given scan: with a small scan (or even the
// real production gårdssalg corpus, only ~50 producers total), an ordinary
// Norwegian farm/place/business-generic word plausibly appears on FEWER than
// SHARED_TOKEN_GENERIC_MIN producers and slips through ungated — silently
// resurrecting the exact "gard" false-positive class this file already
// fixed once (round-2), just below whatever producer count the scan happens
// to have. This list is a fixed floor that does NOT depend on scan size: a
// token in this set is generic regardless of how rare it happens to look in
// the current corpus. Keyed through the SAME genericGateKey() pipeline as
// GENERIC_PRODUCER_TYPE_TOKENS above (so the historical "aa"/"å" digraph
// fold applies here too — "gård", "gard", and "gaard" all collapse to the
// same entry), same reuse-the-pattern discipline. Not
// exhaustive by design — a deliberately small, hand-picked list of common
// farm/place/business-generic words (plus a couple of definite-form
// variants that plausibly stand alone as a farm-name component, e.g.
// "tunet"), not an attempt to enumerate every generic Norwegian word.
const GENERIC_FARM_PLACE_WORD_STOPLIST = new Set(
  [
    "gård", "gard", "gaard", // indefinite + historical "aa" spelling (folds to the same token as gård/gard anyway, kept explicit for readability)
    "tun", "tunet", // farmyard/homestead — bare + definite form (the reviewer's own repro word)
    "bruk", // "smallholding/works" — also the generic tail of countless place-compounds
    "sæter", "seter", // "sæter"/"seter" (mountain summer farm) — both spellings in real use
    "dal", // valley
    "stad", // place/site suffix
    "gods", // manor/estate
    "hus", // house
  ].map((t) => genericGateKey(t))
);

function producerTokenSet(navn: string): Set<string> {
  return new Set(titleTokens(gardssalgSearchName(navn)));
}

/** Provider-distinct corpus token counts over the producers in THIS scan
 *  (not the whole `experiences` table — this signal is about how common a
 *  word is among gårdssalg producer NAMES, the corpus the false-positive
 *  class in the module doc comment actually comes from). Reuses
 *  buildProviderCorpusTokenCounts() (experience-dedup.ts) unchanged by
 *  feeding it {title, provider_id} rows built from producer.navn/id.
 *
 *  The digraph fold is applied to the name BEFORE handing it over, so the
 *  map comes back keyed the same way genericGateKey() looks tokens up —
 *  folding here rather than post-processing the returned map keeps
 *  buildProviderCorpusTokenCounts()'s "count once per DISTINCT provider"
 *  semantics intact (merging keys afterwards would double-count a producer
 *  whose own name happens to carry both spellings). */
function buildProducerCorpusTokenCounts(producers: GsExpProducerRow[]): Map<string, number> {
  return buildProviderCorpusTokenCounts(
    producers.map((p) => ({
      title: foldHistoricalAaDigraph(gardssalgSearchName(p.navn)),
      provider_id: p.id,
    }))
  );
}

/** True when a shared token is generic (a broad category/brand word) rather
 *  than distinctive (proper-noun-like) — any ONE of three mechanisms is
 *  sufficient: the producer_type vocabulary, the curated corpus-size-
 *  independent stoplist (round-3 fix-up, see GENERIC_FARM_PLACE_WORD_STOPLIST
 *  above), or corpus frequency in the current scan.
 *
 *  All three are consulted under genericGateKey() — the digraph-folded key —
 *  so a "gaard"-spelled token is judged by the same evidence as its "gård"
 *  spelling. This is the ONLY path in this file that folds; the match path
 *  reads raw titleTokens() (see foldHistoricalAaDigraph()). */
function isGenericNameToken(token: string, producerCorpusCounts: Map<string, number>): boolean {
  const key = genericGateKey(token);
  if (GENERIC_PRODUCER_TYPE_TOKENS.has(key)) return true;
  if (GENERIC_FARM_PLACE_WORD_STOPLIST.has(key)) return true;
  return (producerCorpusCounts.get(key) ?? 0) >= SHARED_TOKEN_GENERIC_MIN;
}

/** Levenshtein-based whole-string similarity, same formula
 *  levenshteinSimilarity() (experience-dedup.ts, unexported) uses — reuses
 *  its exported levenshtein() rather than re-implementing edit distance. */
function wholeStringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Best whole-string similarity between the producer's searchable name and
 *  EITHER of the experience's title/title_no — corroboration signal for a
 *  generic-only shared token. Mirrors titlesOrTitleNoMatch()'s "try both
 *  language columns" bridge (experience-dedup.ts), adapted to a similarity
 *  score (max, not a boolean match) since it feeds a threshold comparison
 *  here rather than an early-exit boolean check there. */
function producerExperienceWholeStringSimilarity(
  producerNavn: string,
  exp: Pick<GsExpExperienceRow, "title" | "title_no">
): number {
  const pn = normalizeExperienceTitle(gardssalgSearchName(producerNavn));
  const candidates = [exp.title, exp.title_no].filter((t): t is string => !!t && !!t.trim());
  let best = 0;
  for (const c of candidates) {
    const sim = wholeStringSimilarity(pn, normalizeExperienceTitle(c));
    if (sim > best) best = sim;
  }
  return best;
}

function experienceTokenSet(title: string, titleNo: string | null | undefined): Set<string> {
  const set = new Set(titleTokens(title));
  if (titleNo && titleNo.trim()) {
    for (const t of titleTokens(titleNo)) set.add(t);
  }
  return set;
}

function sharedSignificantTokens(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const t of a) {
    if (t.length >= NAME_TOKEN_MIN_LEN && b.has(t)) shared.push(t);
  }
  return shared;
}

/**
 * True when the significant tokens shared between a producer and an
 * experience are trustworthy evidence of a name_token match. A shared token
 * is sufficient ALONE only when at least one is distinctive (not generic per
 * isGenericNameToken()). When every shared token is generic, a second
 * independent signal must corroborate it — trustworthyHostMatch (the same
 * host_name signal, computed by the caller — round-2 review fix-up: ALREADY
 * gated so a generic host label can never corroborate, see
 * hostMatchIsTrustworthy in findGardssalgProducerExperienceMatches()) or
 * whole-title similarity >=
 * GENERIC_TOKEN_CORROBORATION_MIN — mirroring titlesMatch()'s own
 * rarity/corroboration gate (experience-dedup.ts). See the module doc
 * comment's "name_token" bullet for the full false-positive scenario this
 * closes.
 */
function nameTokenMatches(
  sharedTokens: string[],
  producerCorpusCounts: Map<string, number>,
  trustworthyHostMatch: boolean,
  wholeStringSim: number
): boolean {
  if (sharedTokens.length === 0) return false;
  const hasDistinctiveToken = sharedTokens.some((t) => !isGenericNameToken(t, producerCorpusCounts));
  if (hasDistinctiveToken) return true;
  return trustworthyHostMatch || wholeStringSim >= GENERIC_TOKEN_CORROBORATION_MIN;
}

/** The normalized first label of a booking_url's registrable domain (e.g.
 *  "atlungstad" out of "https://atlungstad.no/") — null when unparseable or
 *  too short to be meaningful on its own. */
function hostLabelToken(urlLike: string | null | undefined): string | null {
  const root = urlRegistrableDomain(urlLike);
  if (!root) return null;
  const label = root.split(".")[0] || "";
  const normalized = normalizeExperienceTitle(label).replace(/\s+/g, "");
  return normalized.length >= HOST_TOKEN_MIN_LEN ? normalized : null;
}

/**
 * Core matcher — pure, no DB access. Precomputes each experience's token set
 * / host-label once (not once per producer), so this stays O(producers ×
 * experiences) in cheap Set operations rather than O(producers × experiences
 * × tokenization+Levenshtein) — the corpus size this endpoint deals with in
 * production is small (a few dozen gårdssalg producers × the `experiences`
 * catalog), but this keeps the admin endpoint responsive regardless.
 */
export function findGardssalgProducerExperienceMatches(
  producers: GsExpProducerRow[],
  experiences: GsExpExperienceRow[]
): GsExpMatchedPair[] {
  const precomputed = experiences.map((exp) => ({
    row: exp,
    tokens: experienceTokenSet(exp.title, exp.title_no),
    hostLabel: hostLabelToken(exp.booking_url),
    expDomain: urlRegistrableDomain(exp.booking_url),
  }));

  // Provider-distinct token frequencies over THIS scan's own producer names —
  // the genericity signal for the name_token gate above. Computed once
  // up-front (not per producer/pair) since it's a property of the whole
  // producer corpus, not of any one pair.
  const producerCorpusCounts = buildProducerCorpusTokenCounts(producers);

  const pairs: GsExpMatchedPair[] = [];

  for (const producer of producers) {
    const pTokens = producerTokenSet(producer.navn);
    const producerDomain = urlRegistrableDomain(producer.hjemmeside);

    for (const pc of precomputed) {
      const exp = pc.row;
      let basis: GsExpMatchBasis | null = null;
      const hostMatch = !!(pc.hostLabel && pTokens.has(pc.hostLabel));
      // Round-2 review finding: a bare hostMatch is a plain Set.has() exact-
      // token check against the producer's own name tokens — it carries no
      // genericity concept of its own, unlike name_token's shared-token gate
      // above. Without this, any experience whose booking_url registrable-
      // domain label happens to equal a generic/common word a producer's name
      // also contains (e.g. "gard" — a normal word in this vertical's
      // producer names, not even in the producer_type enum) gets an ungated
      // conflict match, and an ungated hostMatch could also wrongly
      // "corroborate" an all-generic name_token set below (resurrecting the
      // original Bryggeri-class false positive via a second path). Apply the
      // SAME genericity gate that already protects name_token
      // (isGenericNameToken() — same producer_type vocabulary + corpus-
      // frequency check, not a second heuristic): a hostMatch only counts as
      // trustworthy evidence — standalone OR as corroboration — when the host
      // label itself is distinctive, not generic.
      const hostMatchIsTrustworthy =
        hostMatch && !!pc.hostLabel && !isGenericNameToken(pc.hostLabel, producerCorpusCounts);

      if (exp.provider_id && exp.provider_id === producer.id) {
        basis = "provider_link";
      } else {
        const shared = sharedSignificantTokens(pTokens, pc.tokens);
        if (shared.length > 0) {
          // Whole-string similarity is only ever needed to corroborate an
          // all-generic shared-token set — skip the levenshtein cost
          // otherwise (same "only pay for it when needed" discipline the
          // module doc comment already calls out for titlesMatch's fallback
          // branch).
          const hasDistinctiveToken = shared.some((t) => !isGenericNameToken(t, producerCorpusCounts));
          const wholeStringSim = hasDistinctiveToken
            ? 0
            : producerExperienceWholeStringSimilarity(producer.navn, exp);
          if (nameTokenMatches(shared, producerCorpusCounts, hostMatchIsTrustworthy, wholeStringSim)) {
            basis = "name_token";
          }
        }
        if (!basis && hostMatchIsTrustworthy) {
          basis = "host_name";
        }
      }

      if (!basis) continue;

      let status: GsExpConflictStatus;
      if (!producerDomain || !pc.expDomain) status = "unknown";
      else if (producerDomain === pc.expDomain) status = "agree";
      else status = "conflict";

      pairs.push({
        producer_id: producer.id,
        producer_name: producer.navn,
        producer_hidden: producer.catalog_hidden === 1,
        producer_hjemmeside: producer.hjemmeside,
        experience_id: exp.id,
        experience_title: exp.title,
        experience_booking_url: exp.booking_url,
        match_basis: basis,
        status,
      });
    }
  }

  reclassifyAmbiguousCollisions(pairs);
  return pairs;
}

/**
 * Same-experience/multiple-producer collision guard (Finding 2 — see the
 * module doc comment's "Same-experience/multiple-producer collision"
 * section). Mutates `pairs` in place: any "conflict"-status pair whose
 * experience_id ALSO conflict-matches a DIFFERENT producer_id is reclassified
 * to "ambiguous", so downstream remediation (which only ever plans
 * status==="conflict" pairs) silently and automatically excludes it, while it
 * still surfaces in the read-only diagnosis report under its own status.
 * "agree"/"unknown" pairs are never touched by this — the collision this
 * guards against only exists on the write path, which only ever looks at
 * "conflict" pairs.
 */
function reclassifyAmbiguousCollisions(pairs: GsExpMatchedPair[]): void {
  const producersByExperience = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (p.status !== "conflict") continue;
    const producers = producersByExperience.get(p.experience_id) ?? new Set<string>();
    producers.add(p.producer_id);
    producersByExperience.set(p.experience_id, producers);
  }
  for (const p of pairs) {
    if (p.status !== "conflict") continue;
    const producers = producersByExperience.get(p.experience_id);
    if (producers && producers.size > 1) {
      p.status = "ambiguous";
    }
  }
}

export interface GsExpConflictSummary {
  matched_pairs: number;
  conflicting: number;
  agreeing: number;
  unknown: number;
  ambiguous: number;
}

export function summarizeGardssalgExperienceConflicts(pairs: GsExpMatchedPair[]): GsExpConflictSummary {
  const summary: GsExpConflictSummary = {
    matched_pairs: pairs.length,
    conflicting: 0,
    agreeing: 0,
    unknown: 0,
    ambiguous: 0,
  };
  for (const p of pairs) {
    if (p.status === "conflict") summary.conflicting++;
    else if (p.status === "agree") summary.agreeing++;
    else if (p.status === "ambiguous") summary.ambiguous++;
    else summary.unknown++;
  }
  return summary;
}

// ─── DB loaders (Part A) ────────────────────────────────────────────────────

const GARDSSALG_PROVIDER_SCOPE_SQL =
  `(producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed') AND (producer_type IS NULL OR producer_type != 'test-gardssalg')`;

/** Every gårdssalg producer — same base scoping WHERE clause as
 *  GET /admin/gardssalg-provider-dedup-audit (lokal#440) and
 *  GET /admin/gardssalg-outreach-readiness, MINUS the outreach-readiness
 *  endpoint's deliberate inclusion of catalog_hidden rows in scope — this
 *  scan intentionally does NOT filter catalog_hidden OUT (task spec: a
 *  hidden producer's conflicting duplicate is still worth surfacing), it is
 *  just noted per-row via `producer_hidden`. */
export function loadGardssalgProducersForConflictScan(db: Database.Database): GsExpProducerRow[] {
  return db
    .prepare(
      `SELECT id, navn, hjemmeside, catalog_hidden, fylke, kommune
         FROM experience_providers
        WHERE ${GARDSSALG_PROVIDER_SCOPE_SQL}`
    )
    .all() as GsExpProducerRow[];
}

/** Every LIVE experience row (canonical_id IS NULL — same "never surface a
 *  dedup-merged-away row" convention enforced everywhere else `experiences`
 *  is read: PUBLISH_GATE_SQL, listCategories, GET .../recently-enriched, the
 *  dedup candidate loader itself). Deliberately not scoped to gårdssalg in
 *  any way (category/producer_type) — the whole point is that the matching
 *  experience row was harvested independently and has no such link yet. */
export function loadExperiencesForConflictScan(db: Database.Database): GsExpExperienceRow[] {
  return db
    .prepare(
      `SELECT id, title, title_no, booking_url, provider_id, content_source,
              verification_status, content_field_evidence
         FROM experiences
        WHERE canonical_id IS NULL`
    )
    .all() as GsExpExperienceRow[];
}

/** Full Part A pass: load both sides fresh from the DB and match them. Pure
 *  read — no writes anywhere on this path. */
export function runGardssalgExperienceConflictScan(db: Database.Database): {
  pairs: GsExpMatchedPair[];
  summary: GsExpConflictSummary;
} {
  const producers = loadGardssalgProducersForConflictScan(db);
  const experiences = loadExperiencesForConflictScan(db);
  const pairs = findGardssalgProducerExperienceMatches(producers, experiences);
  return { pairs, summary: summarizeGardssalgExperienceConflicts(pairs) };
}

// ─── Remediation (Part B — write, dry-run by default) ──────────────────────
//
// For every CONFLICTING pair (never "agree"/"unknown"/"ambiguous" — those are
// never touched; "ambiguous" pairs are conflict-shaped pairs that collided
// with another producer over the same experience_id and were deliberately
// excluded, see reclassifyAmbiguousCollisions() above), the producer's
// verified hjemmeside is authoritative. The
// remediation either (a) corrects the experience's booking_url to the
// producer's hjemmeside, or (b) nulls it out when copying the producer's own
// hjemmeside would itself be unsafe — namely when that hjemmeside resolves to
// a directory/aggregator host (isDirectoryOrAggregatorHost, the SAME curated
// classifier the website-discovery/content-refresh routes already use to
// keep aggregator links out of a "verified own site" field) or is otherwise
// unparseable. Never leaves a row in conflict either way.
//
// Deliberately NOT built on applyExperienceContent() (experience-store.ts):
// that writer is fill-ONLY (isBlank(row.<field>) gate) — booking_url here is
// already non-blank and WRONG, which is exactly the case that writer refuses
// to touch by design. This is a corrective overwrite, a genuinely different
// operation, hence its own writer + its own audit table
// (experience_provider_conflict_audit, init-experiences.ts) rather than
// stretching the fill-only one to do something it was deliberately built not
// to do.

export const EXPERIENCE_CONFLICT_ROLLBACKABLE_FIELDS = new Set(["booking_url"]);
// Marker stamped on audit rows inserted by a rollback of THIS table, mirrors
// experience-store.ts's GARDSSALG_ROLLBACK_MARKER convention exactly (kept as
// its own local constant rather than importing that unexported one).
export const EXPERIENCE_CONFLICT_ROLLBACK_MARKER = "internal://rollback";

export interface GsExpConflictPlanItem {
  experience_id: string;
  producer_id: string;
  producer_name: string;
  old_value: string | null;
  new_value: string | null;
  action: "corrected" | "nulled";
}

export interface GsExpConflictSkip {
  experience_id: string;
  producer_id: string;
  reason: "locked" | "already_current" | "no_producer_hjemmeside";
}

/**
 * Plan the remediation for a set of already-diagnosed conflicting pairs
 * (callers should pass ONLY status==="conflict" pairs — see the route, which
 * filters runGardssalgExperienceConflictScan()'s fresh output rather than
 * trusting a client-supplied list). Re-reads each experience's CURRENT row
 * (never trusts the pair's snapshot) so a plan is always computed against
 * live data, same discipline as planGardssalgContentRollback.
 */
export function planGardssalgExperienceConflictRemediation(
  db: Database.Database,
  conflictingPairs: GsExpMatchedPair[]
): { applicable: GsExpConflictPlanItem[]; skipped: GsExpConflictSkip[] } {
  const applicable: GsExpConflictPlanItem[] = [];
  const skipped: GsExpConflictSkip[] = [];

  for (const pair of conflictingPairs) {
    const row = db
      .prepare(`SELECT booking_url, content_source, verification_status FROM experiences WHERE id = ?`)
      .get(pair.experience_id) as
      | { booking_url: string | null; content_source: string | null; verification_status: string | null }
      | undefined;
    if (!row) {
      skipped.push({ experience_id: pair.experience_id, producer_id: pair.producer_id, reason: "already_current" });
      continue;
    }
    if (isExperienceContentLocked(row)) {
      skipped.push({ experience_id: pair.experience_id, producer_id: pair.producer_id, reason: "locked" });
      continue;
    }
    if (!pair.producer_hjemmeside || !pair.producer_hjemmeside.trim()) {
      skipped.push({
        experience_id: pair.experience_id,
        producer_id: pair.producer_id,
        reason: "no_producer_hjemmeside",
      });
      continue;
    }

    const producerHomepage = pair.producer_hjemmeside.trim();
    const producerHost = hostFromUrlLike(producerHomepage);
    const safeToCopy = !!producerHost && !isDirectoryOrAggregatorHost(producerHost);
    const newValue = safeToCopy ? producerHomepage : null;

    if ((row.booking_url ?? null) === newValue) {
      skipped.push({ experience_id: pair.experience_id, producer_id: pair.producer_id, reason: "already_current" });
      continue;
    }

    applicable.push({
      experience_id: pair.experience_id,
      producer_id: pair.producer_id,
      producer_name: pair.producer_name,
      old_value: row.booking_url ?? null,
      new_value: newValue,
      action: safeToCopy ? "corrected" : "nulled",
    });
  }

  return { applicable, skipped };
}

/**
 * Apply a previously-planned remediation: writes experiences.booking_url,
 * merges/retracts the `booking_url` key of experiences.content_field_evidence
 * (retracted — key deleted — on a "nulled" action, since a null value makes no
 * provenance claim; set to the producer's hjemmeside on a "corrected" action,
 * the same "where did this value come from" convention applyExperienceContent
 * already uses for that column), and inserts ONE
 * experience_provider_conflict_audit row per write — the rollback lever.
 * content_source is deliberately left untouched: this write did not come from
 * a homepage fetch of the EXPERIENCE's own site, so stamping
 * content_source='provider_site' would misrepresent its provenance the exact
 * way the content_field_evidence per-field map (not a row-level column) was
 * built to prevent (see applyExperienceContent's own doc comment).
 */
export function applyGardssalgExperienceConflictRemediation(
  db: Database.Database,
  items: GsExpConflictPlanItem[],
  batchId: string | null
): Array<{ experience_id: string; producer_id: string; new_value: string | null; action: string }> {
  const applied: Array<{ experience_id: string; producer_id: string; new_value: string | null; action: string }> = [];

  const runOne = db.transaction((item: GsExpConflictPlanItem) => {
    const row = db
      .prepare(`SELECT content_field_evidence FROM experiences WHERE id = ?`)
      .get(item.experience_id) as { content_field_evidence: string | null } | undefined;

    let evidence: Record<string, string> = {};
    if (row?.content_field_evidence) {
      try {
        const parsed = JSON.parse(row.content_field_evidence);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          evidence = parsed as Record<string, string>;
        }
      } catch {
        /* malformed -> start fresh rather than throw on a remediation write */
      }
    }
    if (item.action === "corrected") {
      evidence.booking_url = `producer:${item.producer_id}`;
    } else {
      delete evidence.booking_url;
    }

    db.prepare(
      `UPDATE experiences
          SET booking_url = @booking_url,
              content_field_evidence = @content_field_evidence,
              updated_at = datetime('now')
        WHERE id = @id`
    ).run({
      id: item.experience_id,
      booking_url: item.new_value,
      content_field_evidence: JSON.stringify(evidence),
    });

    db.prepare(
      `INSERT INTO experience_provider_conflict_audit
         (id, experience_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @experience_id, 'booking_url', @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      experience_id: item.experience_id,
      old_value: item.old_value,
      new_value: item.new_value,
      source_url: `producer:${item.producer_id}`,
      batch_id: batchId,
    });
  });

  for (const item of items) {
    runOne(item);
    applied.push({
      experience_id: item.experience_id,
      producer_id: item.producer_id,
      new_value: item.new_value,
      action: item.action,
    });
  }

  return applied;
}

// ─── Rollback (wired into the EXISTING POST /admin/gardssalg-content-rollback
// endpoint via an `entity_type` switch, per the dev-request's own rollback
// section — see routes/opplevelser.ts) ──────────────────────────────────────

export type GsExpConflictRollbackTarget = { experience_id?: string; batch_id?: string };

export interface GsExpConflictRollbackPlanItem {
  experience_id: string;
  field_name: string;
  current_value: string | null;
  restore_to: string | null;
}

export interface GsExpConflictRollbackSkip {
  experience_id: string;
  field_name: string;
  reason: "no_audit_row" | "already_current" | "unknown_field" | "locked";
}

function resolveExperienceConflictRollbackTargets(
  db: Database.Database,
  opts: GsExpConflictRollbackTarget
): Array<{ experience_id: string; field_name: string }> {
  if (opts.batch_id) {
    return db
      .prepare(`SELECT DISTINCT experience_id, field_name FROM experience_provider_conflict_audit WHERE batch_id = ?`)
      .all(opts.batch_id) as Array<{ experience_id: string; field_name: string }>;
  }
  if (opts.experience_id) {
    const rows = db
      .prepare(`SELECT DISTINCT field_name FROM experience_provider_conflict_audit WHERE experience_id = ?`)
      .all(opts.experience_id) as Array<{ field_name: string }>;
    return rows.map((r) => ({ experience_id: opts.experience_id as string, field_name: r.field_name }));
  }
  return [];
}

/** Mirrors planGardssalgContentRollback's exact idempotency discipline
 *  (experience-store.ts) — same two "nothing to restore" cases (already at
 *  the restore target; latest audit row IS a previous rollback whose
 *  new_value already matches current) — adapted to this table/FK. */
export function planExperienceConflictRollback(
  db: Database.Database,
  opts: GsExpConflictRollbackTarget
): { restorable: GsExpConflictRollbackPlanItem[]; skipped: GsExpConflictRollbackSkip[] } {
  const targets = resolveExperienceConflictRollbackTargets(db, opts);
  const restorable: GsExpConflictRollbackPlanItem[] = [];
  const skipped: GsExpConflictRollbackSkip[] = [];

  for (const t of targets) {
    if (!EXPERIENCE_CONFLICT_ROLLBACKABLE_FIELDS.has(t.field_name)) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "unknown_field" });
      continue;
    }
    const latest = db
      .prepare(
        `SELECT old_value, new_value, source_url FROM experience_provider_conflict_audit
          WHERE experience_id = ? AND field_name = ?
          ORDER BY rowid DESC LIMIT 1`
      )
      .get(t.experience_id, t.field_name) as
      | { old_value: string | null; new_value: string | null; source_url: string | null }
      | undefined;
    if (!latest) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    const expRow = db
      .prepare(`SELECT ${t.field_name} AS current_value, content_source, verification_status FROM experiences WHERE id = ?`)
      .get(t.experience_id) as
      | { current_value: string | null; content_source: string | null; verification_status: string | null }
      | undefined;
    if (!expRow) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "no_audit_row" });
      continue;
    }
    if (isExperienceContentLocked(expRow)) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "locked" });
      continue;
    }
    const currentValue = expRow.current_value ?? null;
    const alreadyAtRestoreTarget = currentValue === (latest.old_value ?? null);
    const alreadyRolledBack =
      latest.source_url === EXPERIENCE_CONFLICT_ROLLBACK_MARKER && currentValue === (latest.new_value ?? null);
    if (alreadyAtRestoreTarget || alreadyRolledBack) {
      skipped.push({ experience_id: t.experience_id, field_name: t.field_name, reason: "already_current" });
      continue;
    }
    restorable.push({
      experience_id: t.experience_id,
      field_name: t.field_name,
      current_value: currentValue,
      restore_to: latest.old_value ?? null,
    });
  }

  return { restorable, skipped };
}

/** Mirrors applyGardssalgContentRollback exactly (experience-store.ts),
 *  adapted to this table/FK: restores the field, inserts a NEW audit row
 *  (never mutates/deletes existing ones) stamped with
 *  EXPERIENCE_CONFLICT_ROLLBACK_MARKER so the rollback itself is auditable
 *  and the same idempotency check above can recognize it next time. */
export function applyExperienceConflictRollback(
  db: Database.Database,
  items: GsExpConflictRollbackPlanItem[]
): Array<{ experience_id: string; field_name: string; restored_to: string | null }> {
  const restored: Array<{ experience_id: string; field_name: string; restored_to: string | null }> = [];

  const runOne = db.transaction((item: GsExpConflictRollbackPlanItem) => {
    db.prepare(`UPDATE experiences SET ${item.field_name} = @val WHERE id = @id`).run({
      val: item.restore_to,
      id: item.experience_id,
    });
    db.prepare(
      `INSERT INTO experience_provider_conflict_audit
         (id, experience_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
       VALUES (@id, @experience_id, @field_name, @old_value, @new_value, @source_url, NULL, 'system', datetime('now'))`
    ).run({
      id: uuid(),
      experience_id: item.experience_id,
      field_name: item.field_name,
      old_value: item.current_value,
      new_value: item.restore_to,
      source_url: EXPERIENCE_CONFLICT_ROLLBACK_MARKER,
    });
  });

  for (const item of items) {
    if (!EXPERIENCE_CONFLICT_ROLLBACKABLE_FIELDS.has(item.field_name)) continue;
    const expRow = db
      .prepare(`SELECT content_source, verification_status FROM experiences WHERE id = ?`)
      .get(item.experience_id) as { content_source: string | null; verification_status: string | null } | undefined;
    if (expRow && isExperienceContentLocked(expRow)) continue;
    runOne(item);
    restored.push({ experience_id: item.experience_id, field_name: item.field_name, restored_to: item.restore_to });
  }

  return restored;
}
