// ─── Experience Dedup — matching + canonical-picking logic ──────────────
//
// dev-request 2026-07-04-opplevagent-katalog-dedup, item 1 ("dedup pass").
// The same physical venue gets harvested multiple times from different
// sources, producing multiple `experiences` rows with slightly different
// titles (verified live 2026-07-04 on /fylke/Oslo: "Kon-Tiki Museet" 4x,
// "KOK Oslo" 3x, "Astrup Fearnley" 2x, "RIB Oslo" 2x, "Klatreverket" 2x,
// "Teknisk Museum" 2x). This file is the PURE, DB-free half of the fix: it
// decides whether two rows are duplicates and which one should become
// canonical. It never touches SQLite — experience-store.ts wires it to real
// data (listExperiencesForDedup/runDedupBackfill) and does the writes.
//
// Matching rule (deliberately conservative — false positives are worse than
// false negatives, since a periodic re-run can always catch more later):
//   - Same kommune, REQUIRED. Never merge across different kommuner even if
//     titles match verbatim — this is the deliberate false-positive guard.
//   - Fuzzy-matched titles: normalize (lowercase, æ/ø/å-fold, strip
//     punctuation) then compare via Jaccard similarity over word-token sets.
//     Threshold documented at TITLE_JACCARD_THRESHOLD below.
//   - EITHER same provider_id, OR different provider_id but the same
//     evidence_url hostname (harvest picked up the same source page twice
//     under two different provider rows — see the schema-facts note about
//     missing org_nr breaking getProviderByOrgnr dedup).

// ─── Title normalization + similarity ────────────────────────────────────

/**
 * Lowercase + ascii-fold (æ/ø/å + NFD diacritics) + strip punctuation +
 * collapse whitespace. Mirrors the fold behavior of experience-store.ts's
 * foldPlaceSlug() (æ/ø/å-folding, NFD diacritic stripping) but additionally
 * strips punctuation (hyphens, parens, etc.) and keeps internal spaces,
 * since title matching needs a word-tokenizable string — unlike
 * foldPlaceSlug()'s single-slug place-name comparison use.
 *
 *   normalizeTitleForMatch("Kon-Tiki Museet")   -> "kon tiki museet"
 *   normalizeTitleForMatch("KON-TIKI MUSEUM!")  -> "kon tiki museum"
 *   normalizeTitleForMatch("Ålesund Akvarium")  -> "alesund akvarium"
 */
export function normalizeTitleForMatch(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip NFD combining diacritical marks
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .replace(/[^a-z0-9\s]+/g, " ") // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitleForMatch(title).split(" ").filter((t) => t.length > 0));
}

/**
 * Jaccard similarity (|intersection| / |union|) over the normalized-title
 * word-token sets of two titles. 1.0 = identical token sets, 0 = disjoint
 * (or either title is empty/whitespace-only). Deterministic and symmetric.
 */
export function titleJaccardSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Threshold chosen + verified against the live near-duplicate examples cited
// above (worked through in experience-dedup.test.ts):
//   "Kon-Tiki Museet"   vs "Kon-Tiki Museum"        -> 2/4 = 0.5   (match)
//   "Astrup Fearnley"   vs "Astrup Fearnley Museum" -> 2/3 = 0.667 (match)
//   "Klatreverket"      vs "Klatreverket Oslo"      -> 1/2 = 0.5   (match)
//   "KOK Oslo"          vs "KOK restaurant Oslo"    -> 2/3 = 0.667 (match)
// Negative control — two genuinely different venues in the same kommune:
//   "Kon-Tiki Museet"   vs "Norsk Folkemuseum"      -> 0/5 = 0     (no match)
//   "Oslo Skatehall"    vs "Oslo Ishall"             -> 1/3 = 0.333 (no match)
export const TITLE_JACCARD_THRESHOLD = 0.5;

// ─── Hostname extraction (for the cross-provider same-source-URL rule) ───

/**
 * Extract a lowercased, `www.`-stripped hostname from a URL-ish string.
 * Tolerates a bare scheme-less host (e.g. "example.no/foo"). Null on empty
 * input or any parse failure — callers must treat null as "no match".
 */
export function hostnameOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.trim()}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ─── Candidate-pair matching (the core, pure predicate) ──────────────────

export interface DedupCandidateFields {
  title: string;
  kommune: string | null;
  provider_id: string | null;
  evidence_url: string | null;
}

/**
 * True when two experience rows are a duplicate CANDIDATE per the matching
 * rule documented at the top of this file. Pure — takes only the four
 * fields it needs (not a whole DB row), so it's directly unit-testable
 * without any DB fixture.
 */
export function isDuplicateCandidate(a: DedupCandidateFields, b: DedupCandidateFields): boolean {
  // Required guard: never merge across different kommuner, even if
  // everything else matches. Missing kommune on either side => no match
  // (can't prove same-place without it).
  if (!a.kommune || !b.kommune) return false;
  if (a.kommune.trim().toLowerCase() !== b.kommune.trim().toLowerCase()) return false;

  if (titleJaccardSimilarity(a.title, b.title) < TITLE_JACCARD_THRESHOLD) return false;

  const sameProvider = !!a.provider_id && !!b.provider_id && a.provider_id === b.provider_id;
  if (sameProvider) return true;

  const hostA = hostnameOf(a.evidence_url);
  const hostB = hostnameOf(b.evidence_url);
  return !!hostA && !!hostB && hostA === hostB;
}

// ─── Richness scoring + canonical-row selection ───────────────────────────

/**
 * One experience row's worth of fields the dedup pass needs: the matching
 * fields (title/kommune/provider_id/evidence_url) plus every column used to
 * score "richness" for canonical-row selection, plus enough identity/slug
 * metadata to act on a cluster. All richness fields are columns that
 * ACTUALLY EXIST on `experiences` (see init-experiences.ts) — there is no
 * experience-level phone/website/image column (those live on
 * experience_providers, one level up; scored per-EXPERIENCE here since a
 * merge cluster is a set of experience rows, not provider rows).
 */
export interface DedupExperienceRow extends DedupCandidateFields {
  id: string;
  slug: string | null;
  canonical_experience_id: string | null;
  created_at: string | null;
  description: string | null;
  booking_url: string | null;
  price_band: string | null;
  price_from: number | null;
  duration_min: number | null;
  meeting_point: string | null;
  category: string | null;
  subcategory: string | null;
  activity_tags: string | null; // JSON-encoded string[] as stored in the DB
  season: string | null;        // JSON-encoded string[] as stored in the DB
  indoor_outdoor: string | null;
  loc_lat: number | null;
  loc_lon: number | null;
}

function isNonEmptyField(v: string | number | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number") return true; // 0 is a real, present value
  const s = v.trim();
  return s.length > 0 && s !== "[]" && s !== "null";
}

const RICHNESS_TEXT_FIELDS: Array<keyof DedupExperienceRow> = [
  "description", "booking_url", "price_band", "price_from", "duration_min",
  "meeting_point", "category", "subcategory", "activity_tags", "season",
  "indoor_outdoor",
];

/**
 * Count of non-empty "richness" fields on one row — used to pick which row
 * in a duplicate cluster becomes canonical (the more complete listing wins).
 * loc_lat/loc_lon count as a single combined field (both-or-nothing, since a
 * lone lat with no lon is not a usable coordinate).
 */
export function richnessScore(row: DedupExperienceRow): number {
  let score = 0;
  for (const f of RICHNESS_TEXT_FIELDS) {
    if (isNonEmptyField(row[f] as string | number | null)) score++;
  }
  if (row.loc_lat !== null && row.loc_lat !== undefined && row.loc_lon !== null && row.loc_lon !== undefined) {
    score++;
  }
  return score;
}

/**
 * Pick the canonical row from a duplicate cluster: highest richnessScore()
 * wins. Ties broken by earliest created_at (the first-harvested row is more
 * likely to already be linked-to/indexed), then by lexicographically
 * smallest id for a fully deterministic result regardless of input order.
 * Pure — never mutates input, never touches the DB (that's
 * experience-store.ts's mergeDuplicateCluster()'s job).
 */
export function pickCanonical(cluster: DedupExperienceRow[]): DedupExperienceRow {
  if (cluster.length === 0) throw new Error("pickCanonical: empty cluster");
  return [...cluster].sort((a, b) => {
    const byRichness = richnessScore(b) - richnessScore(a);
    if (byRichness !== 0) return byRichness;
    const ca = a.created_at ?? "";
    const cb = b.created_at ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0] as DedupExperienceRow;
}

// ─── Clustering (transitive grouping via union-find) ──────────────────────

class UnionFind {
  private parent = new Map<string, string>();
  private ensure(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id: string): string {
    this.ensure(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Groups a flat list of experience rows into duplicate clusters (size ≥2)
 * using isDuplicateCandidate() as the pairwise test, applied TRANSITIVELY
 * (union-find) — e.g. A~B and B~C merges A/B/C into one cluster even if A~C
 * alone wouldn't clear the threshold.
 *
 * Rows that already have canonical_experience_id set are excluded up front
 * — this is what makes a re-run idempotent: already-merged rows never
 * re-enter clustering, so re-running the backfill only ever finds NEW
 * duplicates among the still-unmerged rows.
 *
 * Perf: comparisons are bucketed by kommune first (isDuplicateCandidate()
 * would reject a cross-kommune pair anyway, so this just avoids doing the
 * O(n^2) comparison across the WHOLE catalog). Rows with no kommune are
 * dropped from clustering entirely (can never match — see
 * isDuplicateCandidate()'s guard). Fine at current catalog scale (low
 * thousands of rows); would need a real similarity index at 10-100x that.
 */
export function findDuplicateClusters(rows: DedupExperienceRow[]): DedupExperienceRow[][] {
  const candidates = rows.filter((r) => !r.canonical_experience_id);
  const byKommune = new Map<string, DedupExperienceRow[]>();
  for (const r of candidates) {
    if (!r.kommune) continue;
    const key = r.kommune.trim().toLowerCase();
    const arr = byKommune.get(key);
    if (arr) arr.push(r);
    else byKommune.set(key, [r]);
  }

  const clusters: DedupExperienceRow[][] = [];
  for (const group of byKommune.values()) {
    if (group.length < 2) continue;
    const uf = new UnionFind();
    for (const r of group) uf.find(r.id);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const ri = group[i] as DedupExperienceRow;
        const rj = group[j] as DedupExperienceRow;
        if (isDuplicateCandidate(ri, rj)) uf.union(ri.id, rj.id);
      }
    }
    const byRoot = new Map<string, DedupExperienceRow[]>();
    for (const r of group) {
      const root = uf.find(r.id);
      const arr = byRoot.get(root);
      if (arr) arr.push(r);
      else byRoot.set(root, [r]);
    }
    for (const c of byRoot.values()) {
      if (c.length >= 2) clusters.push(c);
    }
  }
  return clusters;
}

export interface DedupMergePlan {
  canonical: DedupExperienceRow;
  duplicates: DedupExperienceRow[];
}

/** Turns raw clusters into {canonical, duplicates} merge plans via
 *  pickCanonical(). Pure — no DB, no mutation. */
export function buildMergePlans(clusters: DedupExperienceRow[][]): DedupMergePlan[] {
  return clusters.map((cluster) => {
    const canonical = pickCanonical(cluster);
    const duplicates = cluster.filter((r) => r.id !== canonical.id);
    return { canonical, duplicates };
  });
}

// ─── Discover-API belt-and-suspenders invariant (item 8) ──────────────────

/**
 * Defensive, O(n) de-dup pass over an already-fetched result page, keyed on
 * (provider_id, normalized-title). Should be a no-op in practice — the
 * PUBLISH_GATE_SQL exclusion (experience-store.ts) already keeps merged-
 * duplicate rows out of every query this runs over — but the dev-request
 * explicitly asks for this invariant as a defensive safety net (e.g. against
 * a row slipping through some other path, such as two harvest-first rows
 * with NULL provider_id that haven't been through the backfill yet). Keeps
 * first-seen order, so the caller's ORDER BY ranking is preserved. No new DB
 * queries — operates purely over the rows already in memory.
 */
export function dedupeResultRows<T extends { provider_id?: string | null; title: string }>(
  rows: T[]
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = `${r.provider_id ?? ""}::${normalizeTitleForMatch(r.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
