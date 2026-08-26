// ─── Experience Provider Canonicalize — non-gårdssalg PROVIDER dedup audit ──
//
// dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
// spec-punkt 2. Root-cause probe: Vitensenteret (Trondheim), Ringve
// (Trondheim), Brosundet (Ålesund) and Hunderfossen (Lillehammer) each
// persist as 2-3 duplicate rows in the catalog even after the EXISTING
// experience-row dedup pass (services/experience-dedup.ts, runDedupPass())
// has already run repeatedly. That pass buckets EXPERIENCE rows by
// (provider-identity, kommune, fuzzy title) — where provider-identity is
// org_nr when known, else provider_id (experience-dedup.ts's
// providerIdentityKey()). It never fires here because the harvester created
// a SEPARATE experience_providers ROW on every repeat harvest (three
// different ids for "Vitensenteret i Trondheim" / "Vitensenteret Trondheim" /
// "Vitensenteret", confirmed live via GET .../admin/gardssalg-provider-lookup
// on 2026-08-26 — none carries an org_nr, so providerIdentityKey() sees three
// unrelated pid: keys and never even considers them for the same bucket,
// regardless of how similar their titles are).
//
// This is exactly the shape services/gardssalg-provider-merge.ts already
// solved for the gårdssalg vertical (dev-request 2026-07-31-gardssalg-
// provider-dubletter-på-tvers-av-seeds) — duplicate PROVIDER rows for the
// same real business, fixed by a provider-level canonicalization step
// upstream of the experience-row dedup. That module's WRITE side
// (previewGardssalgProviderMergePair/applyGardssalgProviderMergePair) is
// already fully generic over `experience_providers` — it has no producer_type
// or rfb_seed_source condition anywhere in its guards or fill-field list, so
// it is reused UNCHANGED here (wired directly into the new route in
// routes/opplevelser.ts) rather than duplicated. What's missing is only the
// DETECTION half: GET /admin/gardssalg-provider-dedup-audit's own SQL scope
// is `WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')` —
// museums/attractions/venues have neither, so that audit's WHERE clause
// excludes them from ever being scanned in the first place. This module is
// that audit's mirror image: scoped to the COMPLEMENT (producer_type IS NULL
// AND rfb_seed_source IS NOT 'rfb-seed'), keyed on kommune/fylke (this
// vertical's location granularity — attractions don't reliably carry a
// postnummer the way gårdssalg producers do) instead of postnummer.
//
// Signals (same identity-vs-hint split as the gårdssalg audit, same
// dev-request 2026-08-18-gardssalg-dedup-org-nr-override lesson: a shared
// first name-token + shared kommune is NOT enough alone to call "high" — two
// distinct venues in the same town routinely share one word, e.g. a
// hypothetical "Ringve Café" would share "ringve" with "Ringve Museum"
// without being the same real place):
//   - org_nr (both sides set, equal)                         -> high
//   - registrable website domain (both sides set, equal)      -> high
//   - name_exact (normaliseNamePruned-equal, via scoreNameMatch's own
//     score===1.0 rule, brreg-client.ts)                       -> high
//   - name_first_token + same kommune (score 0.95)             -> low (hint)
//   - name_first_token only (score 0.80)                       -> low (hint)
// org_nr conflict (both sides set, DIFFERENT) overrides any other signal for
// THAT PAIR to never count toward "high" — same fail-closed rule as the
// gårdssalg audit and as evaluatePair()'s write-side guard
// (gardssalg-provider-merge.ts), positive proof of two separate companies.
//
// Read-only: this module only SELECTs and computes in memory. No table is
// written here — the write lever is the existing, unmodified
// applyGardssalgProviderMergePair()/previewGardssalgProviderMergePair().

import type Database from "better-sqlite3";
import { normaliseName, scoreNameMatch } from "./brreg-client";
import { homepageRegistrableDomain, gardssalgSearchName } from "./experience-store";
import {
  previewGardssalgProviderMergePair,
  applyGardssalgProviderMergePair,
  type GardssalgProviderMergeResultItem,
} from "./gardssalg-provider-merge";

export interface ExperienceProviderCandidateRow {
  id: string;
  navn: string;
  org_nr: string | null;
  hjemmeside: string | null;
  kommune: string | null;
  fylke: string | null;
  content_source: string | null;
}

// Only the identity-bearing signal drives "high" — mirrors GS_DEDUP_HIGH_CONF_NAME_TIERS
// (routes/opplevelser.ts) and the same false-positive lesson it encodes.
type ProviderNameTier = "name_exact" | "name_first_token_kommune" | "name_first_token";
const HIGH_CONF_NAME_TIERS: ReadonlySet<ProviderNameTier> = new Set(["name_exact"]);

function nameTierForScore(score: number): ProviderNameTier | null {
  if (score >= 1.0) return "name_exact";
  if (score >= 0.95) return "name_first_token_kommune";
  if (score >= 0.8) return "name_first_token";
  return null;
}

/**
 * Best (highest-tier) name-match between two provider rows, trying both the
 * raw navn and the dash-suffix-stripped gardssalgSearchName() variant (some
 * harvested attraction names carry a "— Sted" suffix the same way gårdssalg
 * producer names do) — pure, exported for tests. kommune stands in for
 * gårdssalg's postnummer as the corroborating location signal at the 0.95
 * tier; scoreNameMatch() itself is location-agnostic (it just string-compares
 * whatever is passed as the 3rd/4th args), so this is a direct, unmodified
 * reuse of that scorer.
 */
export function providerBestNameTier(
  a: { navn: string; kommune: string | null },
  b: { navn: string; kommune: string | null },
): ProviderNameTier | null {
  const raw = scoreNameMatch(a.navn, b.navn, a.kommune, b.kommune);
  const stripped = scoreNameMatch(
    gardssalgSearchName(a.navn),
    gardssalgSearchName(b.navn),
    a.kommune,
    b.kommune,
  );
  return nameTierForScore(Math.max(raw, stripped));
}

export interface ExperienceProviderDedupRowOut {
  id: string;
  navn: string;
  org_nr: string | null;
  kommune: string | null;
  fylke: string | null;
  content_source: string | null;
  has_website: boolean;
}

export interface ExperienceProviderDedupGroup {
  signals: string[];
  confidence: "high" | "low";
  confidence_signals: string[];
  org_nr_conflict: boolean;
  rows: ExperienceProviderDedupRowOut[];
}

// Minimal union-find, scoped to this module.
class DedupUnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

const present = (v: string | null): boolean => v !== null && v.trim() !== "";

/**
 * Pure grouping over an already-loaded candidate-row set (no DB access) —
 * exported for direct unit testing without a DB round-trip, mirrored by the
 * DB-touching wrapper below. O(n^2) worst case within each first-name-token
 * bucket, same bounding strategy as the gårdssalg audit
 * (routes/opplevelser.ts) — buckets are small in practice (dozens of rows at
 * most sharing one first token), never the whole scanned set.
 */
export function groupExperienceProviderCandidates(
  rows: ExperienceProviderCandidateRow[],
): ExperienceProviderDedupGroup[] {
  const uf = new DedupUnionFind(rows.length);

  // Signal 1: org_nr (both sides set, equal).
  const orgNrBuckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const v = r.org_nr && r.org_nr.trim();
    if (!v) return;
    const list = orgNrBuckets.get(v) ?? [];
    list.push(i);
    orgNrBuckets.set(v, list);
  });
  for (const idxs of orgNrBuckets.values()) {
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  }

  // Signal 2: registrable website domain (both sides set, equal).
  const domainBuckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const d = homepageRegistrableDomain(r.hjemmeside);
    if (!d) return;
    const list = domainBuckets.get(d) ?? [];
    list.push(i);
    domainBuckets.set(d, list);
  });
  for (const idxs of domainBuckets.values()) {
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  }

  // Signal 3: name (bucketed by first-token, then scored pairwise).
  const nameBuckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const key = normaliseName(gardssalgSearchName(r.navn)).split(" ")[0] ?? "";
    if (!key) return;
    const list = nameBuckets.get(key) ?? [];
    list.push(i);
    nameBuckets.set(key, list);
  });
  for (const idxs of nameBuckets.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        if (providerBestNameTier(rows[idxs[x]], rows[idxs[y]])) uf.union(idxs[x], idxs[y]);
      }
    }
  }

  const componentsByRoot = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const root = uf.find(i);
    const list = componentsByRoot.get(root) ?? [];
    list.push(i);
    componentsByRoot.set(root, list);
  });

  const toRowOut = (r: ExperienceProviderCandidateRow): ExperienceProviderDedupRowOut => ({
    id: r.id,
    navn: r.navn,
    org_nr: r.org_nr,
    kommune: r.kommune,
    fylke: r.fylke,
    content_source: r.content_source,
    has_website: present(r.hjemmeside),
  });

  const groups: ExperienceProviderDedupGroup[] = [];
  for (const idxs of componentsByRoot.values()) {
    if (idxs.length < 2) continue;

    const signals = new Set<string>();
    const confidenceSignals = new Set<string>();
    let highConfidence = false;
    let orgNrConflict = false;

    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = rows[idxs[x]];
        const b = rows[idxs[y]];
        const orgA = a.org_nr && a.org_nr.trim();
        const orgB = b.org_nr && b.org_nr.trim();
        const orgMatch = !!(orgA && orgB && orgA === orgB);
        // Positive proof of two separate companies for THIS pair — overrides
        // any other matching signal below for this pair (dev-request
        // 2026-08-18-gardssalg-dedup-org-nr-override's rule, reused).
        const orgConflictThisPair = !!(orgA && orgB && orgA !== orgB);
        if (orgConflictThisPair) orgNrConflict = true;

        const domA = homepageRegistrableDomain(a.hjemmeside);
        const domB = homepageRegistrableDomain(b.hjemmeside);
        const domMatch = !!(domA && domB && domA === domB);
        if (domMatch) signals.add("domain");

        const tier = providerBestNameTier(a, b);
        if (tier) signals.add(tier);

        if (orgConflictThisPair) continue; // never contributes to high for this pair

        if (orgMatch) {
          signals.add("org_nr");
          highConfidence = true;
          confidenceSignals.add("org_nr");
        }
        if (domMatch) {
          highConfidence = true;
          confidenceSignals.add("domain");
        }
        if (tier && HIGH_CONF_NAME_TIERS.has(tier)) {
          highConfidence = true;
          confidenceSignals.add(tier);
        }
      }
    }

    groups.push({
      signals: Array.from(signals),
      confidence: highConfidence ? "high" : "low",
      confidence_signals: Array.from(confidenceSignals),
      org_nr_conflict: orgNrConflict,
      rows: idxs.map((i) => toRowOut(rows[i])),
    });
  }
  return groups;
}

/**
 * SQL scope for this audit — the COMPLEMENT of GET /admin/gardssalg-provider-
 * dedup-audit's own scope (routes/opplevelser.ts):
 * `producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed'`. This is what
 * closes the actual gap — Vitensenteret/Ringve/Brosundet/Hunderfossen have
 * neither, so the gårdssalg audit's WHERE clause never even considers them.
 * Also excludes rows already marked `merged_into` (a resolved duplicate
 * doesn't need to keep re-surfacing as a candidate) and catalog_hidden rows
 * (same convention as GET /admin/providers/all's PROVIDERS_ALL_WHERE).
 */
export const EXPERIENCE_PROVIDER_DEDUP_SCOPE_WHERE = `
  WHERE producer_type IS NULL
    AND (rfb_seed_source IS NULL OR rfb_seed_source != 'rfb-seed')
    AND merged_into IS NULL
    AND (catalog_hidden IS NULL OR catalog_hidden != 1)
`;

/** DB-touching wrapper: loads the scoped candidate rows and groups them. */
export function auditExperienceProviderDuplicates(db: Database.Database): {
  totalProvidersScanned: number;
  groups: ExperienceProviderDedupGroup[];
} {
  const rows = db
    .prepare(
      `SELECT id, navn, org_nr, hjemmeside, kommune, fylke, content_source
         FROM experience_providers
         ${EXPERIENCE_PROVIDER_DEDUP_SCOPE_WHERE}`,
    )
    .all() as ExperienceProviderCandidateRow[];
  const groups = groupExperienceProviderCandidates(rows);
  return { totalProvidersScanned: rows.length, groups };
}

// ─── Merge lever — provider merge (reused unchanged) + child-experience
//     repoint (the genuinely new piece) ─────────────────────────────────────
//
// applyGardssalgProviderMergePair()/previewGardssalgProviderMergePair()
// (gardssalg-provider-merge.ts, reused unmodified above) mark the removed
// PROVIDER row (`merged_into`) — but merging the provider record alone does
// NOT, by itself, close the gap this dev-request exists to fix. The
// experience-row dedup pass (runDedupPass, experience-dedup.ts) buckets
// EXPERIENCE rows by their OWN `provider_id` (via providerIdentityKey()) —
// it never walks a provider's `merged_into` pointer. So a duplicate
// business's separately-harvested EXPERIENCE rows (e.g. three "Omvisning på
// Vitensenteret" activity cards, one per duplicate provider id) would keep
// pointing at three DIFFERENT provider_id values even after the provider
// records themselves are merged — runDedupPass would still never bucket
// them together, and a visitor browsing the catalog would still see three
// activity cards. This is exactly why the task frames the fix as "canonicalize
// experience rows under one provider id" — repointing is the mechanism that
// makes the ALREADY-EXISTING, ALREADY-TESTED runDedupPass able to finish the
// job on a subsequent run, without a second title-matcher being written here.
//
// repointExperiencesToProvider() repoints every STILL-LIVE (`canonical_id IS
// NULL` — an already-merged-away experience row has no live provider_id
// consumer left to matter) experience row from the removed provider onto the
// surviving one. Only ever called after a REAL "merged" outcome — never
// touches a row when the provider merge itself was dry-run, rejected, or
// errored.

/** Count of still-live experience rows currently pointing at `providerId` — used for the dry-run preview's `experiences_repointed` figure. */
function countLiveExperiencesForProvider(db: Database.Database, providerId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM experiences WHERE provider_id = ? AND canonical_id IS NULL`)
      .get(providerId) as { n: number }
  ).n;
}

/** Repoints every still-live experience row from `removeId` onto `keepId`. Returns the number of rows actually repointed. */
function repointExperiencesToProvider(db: Database.Database, removeId: string, keepId: string): number {
  const info = db
    .prepare(
      `UPDATE experiences SET provider_id = @keepId, updated_at = datetime('now')
        WHERE provider_id = @removeId AND canonical_id IS NULL`,
    )
    .run({ keepId, removeId });
  return info.changes;
}

export interface ExperienceProviderMergeWithRepointResult extends GardssalgProviderMergeResultItem {
  // Apply: the number of still-live experience rows actually repointed onto
  // `keep_id` — non-zero on a real "merged" outcome, and ALSO non-zero on an
  // "allerede_fjernet_i_tidligere_slaaing" rejection when `remove_id` was
  // already merged into THIS SAME `keep_id` (see the "already-merged,
  // still-repoint" note below) — 0 for every other outcome. Dry-run: the
  // number that WOULD be repointed under the same two conditions. Same
  // "dry-run/apply share one response shape" convention the reused merge
  // functions already use, so this field never needs a would-be-prefixed
  // twin.
  experiences_repointed: number;
}

/**
 * True when `removeId` is ALREADY merged into `keepId` specifically (not
 * merely "already merged into something") — the one case where a rejected
 * ("allerede_fjernet_i_tidligere_slaaing") outcome from the reused evaluator
 * still means the repoint is safe and correct to (re-)run: the provider side
 * of this exact pair was already applied by an earlier call (e.g. through
 * the plain gårdssalg twin, before this repoint step existed, or a prior
 * call to this same function that crashed between its two writes — see the
 * apply function's own doc comment), so it is this function's job to finish
 * the job rather than silently leaving the child experiences behind.
 */
function isAlreadyMergedIntoThisKeep(db: Database.Database, removeId: string, keepId: string): boolean {
  const row = db.prepare(`SELECT merged_into FROM experience_providers WHERE id = ?`).get(removeId) as
    | { merged_into: string | null }
    | undefined;
  return row?.merged_into === keepId;
}

/** Dry-run preview: reused merge preview + a repoint COUNT (zero writes either way). */
export function previewExperienceProviderMergeWithRepoint(
  db: Database.Database,
  removeId: string,
  keepId: string,
): ExperienceProviderMergeWithRepointResult {
  const preview = previewGardssalgProviderMergePair(db, removeId, keepId);
  const eligible =
    preview.outcome === "would_merge" ||
    (preview.outcome === "rejected" &&
      preview.reason === "allerede_fjernet_i_tidligere_slaaing" &&
      isAlreadyMergedIntoThisKeep(db, removeId, keepId));
  const wouldRepoint = eligible ? countLiveExperiencesForProvider(db, removeId) : 0;
  return { ...preview, experiences_repointed: wouldRepoint };
}

/**
 * Apply: reused merge apply, THEN the repoint — on a real "merged" outcome,
 * OR (idempotent "finish the job" case) when the pair was already merged
 * into this SAME keep_id by an earlier call, so repeated calls for a pair
 * this route already merged keep completing the repoint instead of silently
 * no-op'ing forever. repointExperiencesToProvider() is itself naturally
 * idempotent (its WHERE clause only ever matches rows still pointing at
 * `remove_id`, so re-running it against an already-repointed set updates
 * zero rows). Each half is its own synchronous, non-yielding statement
 * (better-sqlite3 blocks the single Node event loop for the duration of each
 * call), so no other request's JS can interleave between them within one
 * process — the same "no explicit BEGIN needed" reasoning this file's
 * sibling admin routes already rely on elsewhere. A crash between the two
 * (an unmodified-process kill mid-request) would leave the provider merge
 * applied without its repoint; the idempotent re-run above is exactly what
 * closes that residual on the NEXT call for the same pair.
 */
export function applyExperienceProviderMergeWithRepoint(
  db: Database.Database,
  removeId: string,
  keepId: string,
  note: string | null,
  batchId: string,
): ExperienceProviderMergeWithRepointResult {
  const merge = applyGardssalgProviderMergePair(db, removeId, keepId, note, batchId);
  const eligible =
    merge.outcome === "merged" ||
    (merge.outcome === "rejected" &&
      merge.reason === "allerede_fjernet_i_tidligere_slaaing" &&
      isAlreadyMergedIntoThisKeep(db, removeId, keepId));
  const repointed = eligible ? repointExperiencesToProvider(db, removeId, keepId) : 0;
  return { ...merge, experiences_repointed: repointed };
}
