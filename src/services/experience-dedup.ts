// ─── Experience Dedup — candidate-key matching + canonical merge ──────────
//
// dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, work item 1.
//
// Confirmed live on /fylke/Oslo (2026-07-04): the same real-world experience
// appears multiple times because it was harvested from different sources —
// same provider, near-identical (sometimes very differently worded) title,
// different DB rows (Kon-Tiki Museet 4x, KOK Oslo 3x, Astrup Fearnley 2x,
// RIB Oslo 2x, Klatreverket 2x, Teknisk Museum 2x).
//
// This module is pure candidate-key logic + the DB write pass that applies
// it — no HTTP/route concerns here. Callers:
//   - src/scripts/experiences-dedup-backfill.ts (one-off backfill against the
//     live table)
//   - src/services/experience-store.ts (re-harvest guard wired into
//     bulkInsertExperiences() + exposed as findExistingExperienceMatch() for
//     the /admin/bulk-load route)
//   - src/services/experience-store.ts's PUBLISH_GATE_SQL / discoverExperiences()
//     / listCategories() add `canonical_id IS NULL` so merged-away duplicates
//     never resurface in discover/browse/sitemap results.
//
// CANDIDATE KEY = same provider identity (provider_id, or org_nr when two
// provider RECORDS refer to the same real org) AND same kommune AND a fuzzy
// title match. Provider identity + kommune are treated as a strong prior —
// once both match, the title-similarity bar only needs to rule out two
// genuinely different experiences from the same provider in the same place,
// not prove near-identical wording (harvested titles for the same real thing
// are often worded completely differently across sources).

import type Database from "better-sqlite3";

const VERTICAL = "experiences";

// ─── Title normalization + fuzzy match (pure, no deps) ─────────────────────

// Common short filler words (English + Norwegian) stripped before token
// comparison so they never count as "shared" evidence between two titles.
// Also includes generic experience-domain nouns (museum/tur/senter/...) that
// describe a broad CATEGORY of attraction rather than a specific one — two
// unrelated museums both containing the word "museum" must never be treated
// as the same real-world experience just because they share that word.
const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "for", "and", "or", "to", "with", "by",
  "og", "en", "et", "pa", "for", "fra", "til", "med", "om", "av", "er", "som", "din", "der",
  // Generic category/domain nouns — deliberately excluded from the
  // "shared distinctive token" signal (see titlesMatch()).
  "museum", "museet", "senter", "center", "park", "opplevelse", "opplevelser",
  "aktivitet", "aktiviteter", "billetter", "tickets", "official", "site",
  "website", "hjemmeside", "tur", "tour", "omvisning", "experience", "experiences",
  // "kajakk" ("kayak") is a bare loanword noun, not a compound/derived
  // activity noun (see GENERIC_ACTIVITY_SUFFIXES below, which is what
  // catches the open-ended class this word belongs to) — it has no
  // productive suffix pattern to hook a general rule onto, so unlike
  // rafting/klatring/sykkeltur/fisketur (removed from this list in PR #209
  // review round 2 — GENERIC_ACTIVITY_SUFFIXES now catches all four
  // generically via "-ing"/"-tur"), this one stays as a small, irreducible,
  // explicit exception rather than a whack-a-mole pattern.
  "kajakk",
]);

// Generic Norwegian ACTIVITY-noun suffixes: a compound/derived noun ending in
// one of these names a CATEGORY of outdoor activity (a trip, a hike, a
// paddling/driving/climbing/sailing session, ...) rather than a specific
// bookable product or a named person/place/brand — no matter what root word
// it's built on. A token ending in one of these is therefore NEVER, on its
// own, sufficient evidence that two titles describe the same real-world
// experience (see titlesMatch() below) — this is the exact shape of every
// confirmed false-positive merge from PR #209 review rounds 1 and 2:
// "Fjelltur til Galdhøpiggen" vs "...Snøhetta" (-tur), "Brevandring på
// Nigardsbreen" vs "...Briksdalsbreen" (-ing), "Elvepadling for
// nybegynnere" vs "...viderekommet" (-ing), and the round-1 findings
// (kajakk/rafting/klatring/sykkeltur/fisketur "tur" — all -tur/-ing too).
//
// Deliberately suffix-based, NOT a per-word list: Norwegian tourism/activity
// nomenclature overwhelmingly builds new activity nouns by gluing a
// qualifier onto "-tur" (fjelltur, sykkeltur, fisketur, bretur, hundetur,
// rideturer, ...) or by nominalizing an activity verb with the "-ing" gerund
// suffix (vandring, padling, klatring, kjøring, seiling, fisking — plus
// English loanwords the harvester also produces: rafting, camping, hiking,
// cycling, diving, ...). Round 1 of this fix whack-a-moled five specific
// nouns onto TITLE_STOPWORDS and the reviewer immediately found three more
// (fjelltur/brevandring/elvepadling) that weren't on the list — this suffix
// rule catches those three AND any future Norwegian/English activity noun
// the harvester encounters, without ever needing another list update.
const GENERIC_ACTIVITY_SUFFIXES = ["tur", "ing"];

function isGenericActivityToken(token: string): boolean {
  return GENERIC_ACTIVITY_SUFFIXES.some((suffix) => token.endsWith(suffix));
}

function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip NFD combining diacritical marks
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a");
}

/**
 * Normalize a harvested title for fuzzy comparison: fold diacritics, strip
 * possessive 's, drop parenthetical/pipe-delimited site-name suffixes some
 * harvest sources glue onto titles (e.g. "... | TripAdvisor"), collapse all
 * remaining punctuation (dashes, em-dashes, ellipses, colons) to whitespace,
 * lowercase, and collapse repeated whitespace.
 */
export function normalizeExperienceTitle(raw: string): string {
  if (!raw) return "";
  let s = stripDiacritics(raw).toLowerCase();
  s = s.replace(/['’]s\b/g, ""); // "heyerdahl's" -> "heyerdahl"
  s = s.replace(/\([^)]*\)/g, " "); // drop "(...)" asides
  s = s.replace(/\|.*$/, " "); // drop "| Site Name" suffixes
  // Join ASCII-hyphenated COMPOUND words (letter-hyphen-letter, no
  // surrounding whitespace) into one token — e.g. "Kon-Tiki" -> "kontiki" —
  // so a proper-noun brand name isn't shredded into two short, individually
  // insignificant tokens ("kon", "tiki"). Must run BEFORE the generic
  // punctuation pass below, which treats em/en-dashes, ellipses, and a
  // hyphen used as a clause separator ("Rafting - Sjoa") as space.
  s = s.replace(/([a-z0-9])-([a-z0-9])/g, "$1$2");
  s = s.replace(/[^a-z0-9]+/g, " "); // remaining punctuation/dashes/ellipses -> space
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Tokenize a normalized title into comparison-worthy words: drops stopwords
 * and anything under 3 chars, and crudely stems a trailing plural/possessive
 * "s" off longer tokens (so "museums"/"museum" or "raft"/"rafts" still line
 * up) without pulling in a stemming library.
 */
export function titleTokens(raw: string): string[] {
  return normalizeExperienceTitle(raw)
    .split(" ")
    .filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

/** Plain Levenshtein edit distance (hand-rolled, no npm dependency). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// A shared token this long is distinctive enough on its own (proper nouns,
// specific activity names) to call two titles the same real-world experience
// — e.g. "Heyerdahl" shared between "Kon-Tiki Museet — Heyerdahl's Legendary
// Pacific Raft…" and "…Thor Heyerdahl Expedition Museum at Bygdøy Oslo".
const SIGNIFICANT_TOKEN_MIN_LEN = 5;

// Whole-string closeness bar for titles that don't share one long distinctive
// token but are still near-duplicate wording (typos / minor rewording from
// re-harvesting the same source).
const WHOLE_STRING_SIMILARITY_THRESHOLD = 0.6;

// Corroborating token-set overlap bar for the whole-string path (see
// titlesMatch()). Character-level Levenshtein similarity alone can score
// deceptively high for two titles that share a long common prefix/suffix
// around a DIFFERENT distinguishing qualifier — e.g. "Rafting i Sjoa -
// dagstur" vs "Rafting i Sjoa - kveldstur" (0.79 raw char similarity) or
// "Kajakk tur for nybegynnere" vs "...for viderekommet" (0.63) — even though
// those describe two distinct, independently-bookable products (confirmed
// false-positive merges from PR #209 review). A genuine re-wording of the
// SAME experience (e.g. "KOK Oslo Food Tour" vs "KOK Oslo Food Tur") keeps
// nearly all of its significant content words in common; two DIFFERENT
// variants swap out a content word for another, which drags token-set
// Jaccard overlap well below this bar even when the characters still line
// up closely.
const TOKEN_OVERLAP_THRESHOLD = 0.65;

/**
 * True when two titles are plausibly the SAME real-world experience. Intended
 * to be called only after provider-identity + kommune already matched (a
 * strong prior), so the bar here only needs to rule out two genuinely
 * different experiences from the same provider/place, not prove near-
 * identical wording.
 */
export function titlesMatch(a: string, b: string): boolean {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  // Single-shared-significant-token signal (e.g. a proper noun/brand like
  // "heyerdahl" or "kontiki") is strong enough evidence on its own to call
  // two titles the same real-world experience — but ONLY when that token
  // isn't itself a generic ACTIVITY-CATEGORY noun (see
  // GENERIC_ACTIVITY_SUFFIXES above). A generic activity noun is never
  // sufficient alone, no matter how long it is or how rare it looks lexically
  // — "Fjelltur til Galdhøpiggen"/"...Snøhetta" share only "fjelltur" (8
  // chars, well past SIGNIFICANT_TOKEN_MIN_LEN) yet are two different,
  // independently-bookable trips to two different mountains. Tokens excluded
  // here still fall through to the whole-string + token-overlap corroboration
  // path below, same as any other candidate pair — they just can't shortcut
  // straight to a match on their own.
  for (const t of setA) {
    if (t.length >= SIGNIFICANT_TOKEN_MIN_LEN && setB.has(t) && !isGenericActivityToken(t)) {
      return true;
    }
  }

  // Whole-string / reworded-duplicate path: character-level closeness must
  // be corroborated by token-set overlap (see TOKEN_OVERLAP_THRESHOLD above)
  // — either signal alone is not enough to call two titles the same
  // real-world experience.
  const na = normalizeExperienceTitle(a);
  const nb = normalizeExperienceTitle(b);
  if (levenshteinSimilarity(na, nb) < WHOLE_STRING_SIMILARITY_THRESHOLD) return false;

  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return true; // both titles reduced to nothing but stopwords/short tokens
  let overlap = 0;
  for (const t of setA) {
    if (setB.has(t)) overlap++;
  }
  return overlap / union.size >= TOKEN_OVERLAP_THRESHOLD;
}

// ─── Canonical-row scoring (richest data wins) ──────────────────────────────

/** The subset of `experiences` attribute columns used to score "richness".
 *  Accepts either the DB-row shape (JSON-string array columns) or the
 *  in-memory harvest shape (string[] array columns) — hasValue() below
 *  handles both, so the same scorer works for DedupCandidateRow (DB reads)
 *  and a plain HarvestRow (pre-insert, in the re-harvest guard). */
export interface ExperienceRichnessInput {
  description?: string | null;
  subcategory?: string | null;
  activity_tags?: string | string[] | null;
  season?: string | string[] | null;
  indoor_outdoor?: string | null;
  weather_dependent?: number | null;
  physical_intensity?: string | null;
  duration_min?: number | null;
  duration_max?: number | null;
  group_min?: number | null;
  group_max?: number | null;
  age_suitability?: string | null;
  min_age?: number | null;
  price_band?: string | null;
  price_from?: number | null;
  price_unit?: string | null;
  languages?: string | string[] | null;
  accessibility?: string | string[] | null;
  booking_url?: string | null;
  booking_type?: string | null;
  loc_lat?: number | null;
  loc_lon?: number | null;
  meeting_point?: string | null;
  evidence_url?: string | null;
  confidence?: string | null;
  verification_status?: string | null;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") {
    const t = v.trim();
    return t !== "" && t !== "[]" && t !== "null";
  }
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

const RICHNESS_FIELDS: Array<keyof ExperienceRichnessInput> = [
  "subcategory", "activity_tags", "season", "indoor_outdoor", "weather_dependent",
  "physical_intensity", "duration_min", "duration_max", "group_min", "group_max",
  "age_suitability", "min_age", "price_band", "price_from", "price_unit",
  "languages", "accessibility", "booking_url", "booking_type", "loc_lat", "loc_lon",
  "meeting_point", "evidence_url",
];

const CONFIDENCE_WEIGHT: Record<string, number> = { high: 2, medium: 1, low: 0 };

/**
 * Score a row's "richness" — how much real data it carries — for picking a
 * canonical row out of a duplicate group. One point per populated attribute
 * column, a length-proportional (capped) bonus for a longer description, a
 * flat bonus for being already verified, and a small nudge for confidence.
 * Higher is better/richer.
 */
export function scoreExperienceRichness(row: ExperienceRichnessInput): number {
  let score = 0;
  for (const f of RICHNESS_FIELDS) {
    if (hasValue(row[f])) score += 1;
  }
  const descLen = (row.description || "").trim().length;
  score += Math.min(10, Math.floor(descLen / 40));
  if (row.verification_status === "verified") score += 5;
  score += CONFIDENCE_WEIGHT[row.confidence || ""] ?? 0;
  return score;
}

/**
 * Pick the canonical row out of a duplicate group: richest data wins (per
 * scoreExperienceRichness), ties broken by earliest created_at (the
 * first-harvested row, presumably the more "established" URL/slug), then by
 * id for full determinism.
 */
export function pickCanonical<T extends { id: string; created_at?: string | null }>(
  group: T[],
  scoreFn: (row: T) => number = scoreExperienceRichness as unknown as (row: T) => number
): { canonical: T; duplicates: T[] } {
  const sorted = [...group].sort((a, b) => {
    const scoreDiff = scoreFn(b) - scoreFn(a);
    if (scoreDiff !== 0) return scoreDiff;
    const ca = a.created_at || "";
    const cb = b.created_at || "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  const [canonical, ...duplicates] = sorted;
  return { canonical: canonical as T, duplicates };
}

// ─── Candidate-key grouping ──────────────────────────────────────────────

export interface DedupCandidateRow extends ExperienceRichnessInput {
  id: string;
  provider_id: string | null;
  org_nr: string | null;
  title: string;
  kommune: string | null;
  created_at?: string | null;
}

/**
 * Provider-identity bucketing key: org_nr when known (so two DIFFERENT
 * provider records for the same real org still bucket together), else
 * provider_id. Null (no anchor at all) means "not eligible for dedup
 * grouping" — a row with no provider_id can't be safely asserted to be the
 * same real-world entity as another row.
 */
function providerIdentityKey(row: { provider_id: string | null; org_nr?: string | null }): string | null {
  if (row.org_nr && row.org_nr.trim()) return `org:${row.org_nr.trim().toLowerCase()}`;
  if (row.provider_id) return `pid:${row.provider_id}`;
  return null;
}

/**
 * Group candidate rows into duplicate clusters: bucket by (provider identity,
 * kommune), then union-find cluster within each bucket by pairwise
 * titlesMatch() (fuzzy match isn't guaranteed transitive across a long chain,
 * so clustering — not a single global equivalence check — is what makes A~B
 * and B~C fold into one group even if A~C alone wouldn't have matched).
 * Only returns groups of size >= 2 (an unmatched singleton isn't a group).
 */
export function groupDuplicateCandidates(rows: DedupCandidateRow[]): DedupCandidateRow[][] {
  const buckets = new Map<string, DedupCandidateRow[]>();
  for (const row of rows) {
    const identity = providerIdentityKey(row);
    const kommuneKey = (row.kommune || "").trim().toLowerCase();
    if (!identity || !kommuneKey) continue;
    const key = `${identity}::${kommuneKey}`;
    const arr = buckets.get(key);
    if (arr) arr.push(row);
    else buckets.set(key, [row]);
  }

  const groups: DedupCandidateRow[][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    const parent = bucket.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (titlesMatch(bucket[i].title, bucket[j].title)) {
          const ri = find(i);
          const rj = find(j);
          if (ri !== rj) parent[ri] = rj;
        }
      }
    }

    const clusters = new Map<number, DedupCandidateRow[]>();
    for (let i = 0; i < bucket.length; i++) {
      const root = find(i);
      const arr = clusters.get(root);
      if (arr) arr.push(bucket[i]);
      else clusters.set(root, [bucket[i]]);
    }
    for (const cluster of clusters.values()) {
      if (cluster.length > 1) groups.push(cluster);
    }
  }
  return groups;
}

// ─── DB-touching pass (backfill + live re-harvest guard) ──────────────────

const DEDUP_CANDIDATE_COLUMNS = `
  e.id, e.provider_id, p.org_nr AS org_nr, e.title, e.kommune,
  e.description, e.subcategory, e.activity_tags, e.season, e.indoor_outdoor,
  e.weather_dependent, e.physical_intensity, e.duration_min, e.duration_max,
  e.group_min, e.group_max, e.age_suitability, e.min_age, e.price_band,
  e.price_from, e.price_unit, e.languages, e.accessibility, e.booking_url,
  e.booking_type, e.loc_lat, e.loc_lon, e.meeting_point, e.evidence_url,
  e.confidence, e.verification_status, e.created_at
`;

/**
 * Load rows eligible for dedup grouping: not already merged away
 * (canonical_id IS NULL) and anchored to a provider (provider_id set — an
 * unmatched harvest row has no identity to key on). Joins experience_providers
 * for org_nr so duplicate PROVIDER records still bucket together.
 */
function loadDedupCandidates(db: Database.Database): DedupCandidateRow[] {
  return db
    .prepare(
      `SELECT ${DEDUP_CANDIDATE_COLUMNS}
       FROM experiences e
       LEFT JOIN experience_providers p ON p.id = e.provider_id
       WHERE e.canonical_id IS NULL AND e.provider_id IS NOT NULL`
    )
    .all() as DedupCandidateRow[];
}

export interface DedupPassResult {
  groupsFound: number;
  rowsMerged: number;
  canonicalIds: string[];
}

/**
 * Run the dedup pass against the live table: find candidate-key duplicate
 * groups among currently-unmerged rows, pick the richest row in each group as
 * canonical, stamp every OTHER row's canonical_id, and stamp the canonical
 * row's merged_from JSON array (unioned with any pre-existing merged_from, in
 * case this canonical was already the target of an earlier pass).
 *
 * Idempotent: loadDedupCandidates() only pulls canonical_id IS NULL rows, so
 * once a group has been merged, the next run only ever sees the surviving
 * canonical row for that group (a singleton — group size < 2 is skipped
 * entirely) — a second run makes zero writes.
 */
export function runDedupPass(db: Database.Database): DedupPassResult {
  const rows = loadDedupCandidates(db);
  const groups = groupDuplicateCandidates(rows);

  const updateCanonicalId = db.prepare(
    "UPDATE experiences SET canonical_id = @canonicalId, updated_at = datetime('now') WHERE id = @id"
  );
  const updateMergedFrom = db.prepare(
    "UPDATE experiences SET merged_from = @mergedFrom, updated_at = datetime('now') WHERE id = @id"
  );
  const getExistingMergedFrom = db.prepare("SELECT merged_from FROM experiences WHERE id = ?");

  let rowsMerged = 0;
  const canonicalIds: string[] = [];

  const tx = db.transaction(() => {
    for (const group of groups) {
      const { canonical, duplicates } = pickCanonical(group, scoreExperienceRichness);
      if (duplicates.length === 0) continue;

      for (const dup of duplicates) {
        updateCanonicalId.run({ canonicalId: canonical.id, id: dup.id });
        rowsMerged++;
      }

      const existingRaw = (
        getExistingMergedFrom.get(canonical.id) as { merged_from: string | null } | undefined
      )?.merged_from;
      let existingIds: string[] = [];
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw);
          if (Array.isArray(parsed)) existingIds = parsed.map(String);
        } catch {
          /* corrupt/legacy value — start fresh rather than throw */
        }
      }
      const mergedIds = Array.from(new Set([...existingIds, ...duplicates.map((d) => d.id)]));
      updateMergedFrom.run({ mergedFrom: JSON.stringify(mergedIds), id: canonical.id });
      canonicalIds.push(canonical.id);
    }
  });
  tx();

  return { groupsFound: groups.length, rowsMerged, canonicalIds };
}

/**
 * Re-harvest guard: given a candidate row about to be inserted from a harvest
 * source, find an existing (unmerged) experience it would form a duplicate
 * group with — same provider-identity + kommune + fuzzy title — so the caller
 * can skip or update-in-place instead of inserting a brand-new duplicate.
 * Returns null when there's no provider/kommune anchor (nothing to key on) or
 * no match found.
 */
export function findExistingCandidateMatch(
  db: Database.Database,
  candidate: { provider_id?: string | null; title: string; kommune?: string | null }
): DedupCandidateRow | null {
  if (!candidate.provider_id) return null;
  const kommuneKey = (candidate.kommune || "").trim().toLowerCase();
  if (!kommuneKey) return null;

  const providerRow = db
    .prepare("SELECT org_nr FROM experience_providers WHERE id = ?")
    .get(candidate.provider_id) as { org_nr: string | null } | undefined;
  const identity = providerIdentityKey({
    provider_id: candidate.provider_id,
    org_nr: providerRow?.org_nr ?? null,
  });
  if (!identity) return null;

  const rows = loadDedupCandidates(db).filter(
    (r) => providerIdentityKey(r) === identity && (r.kommune || "").trim().toLowerCase() === kommuneKey
  );
  for (const row of rows) {
    if (titlesMatch(row.title, candidate.title)) return row;
  }
  return null;
}
