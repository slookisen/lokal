// ─── Experience Dedup Audit — merged-group false-positive triage ───────────
//
// dev-request 2026-07-11-dedup-false-positive-remediation.
//
// titlesMatch() (experience-dedup.ts) shipped with a defect: ONE shared
// significant token (>= 5 chars, non-stopword) is sufficient to call two
// titles the same real-world experience. The prod backfill merged 418 groups
// / 1361 rows under that rule, and some are false positives — "Fjelltur til
// Galdhøpiggen" and "Fjelltur til Snøhetta" are two different mountains that
// share only the broad activity word "fjelltur".
//
// This module AUDITS the merges (read-only): it re-examines every merged row
// (canonical_id IS NOT NULL) and classifies the strongest evidence linking it
// to its group. The discriminator is corpus frequency: a shared token that
// few PROVIDERS use ("heyerdahl") is distinctive evidence; one that appears
// across many providers ("fjelltur", "rafting", "klatring") is generic and
// proves nothing. Rows whose BEST link is generic-only (or no signal at all)
// are flagged suspect for the un-merge endpoint
// (POST /admin/experiences-dedup-unmerge in src/routes/opplevelser.ts).
//
// AUDIT V2 — provider-distinct corpus counting. The first prod run counted a
// token once per distinct TITLE, and over-flagged badly (859/1361 rows
// suspect, including the confirmed-TRUE Kon-Tiki group): the duplicates
// themselves inflate title counts — "kontiki" appeared in 16 titles because
// there are 16 harvest clones of ONE museum, so the proper nouns of heavily-
// duplicated entities looked corpus-common (kontiki(16), heyerdahl(17),
// dyreparken(8), maihaugen(8), fossheim(7) all >= genericMin 5) while true
// generics sat only somewhat higher (rafting(32), hotel(274)) — no threshold
// separates them on that axis. Counting DISTINCT PROVIDERS instead is immune
// to clone inflation: "rafting" spans many providers → common; "kontiki" is
// one provider however many clone titles it has → rare.
//
// Deliberately does NOT touch titlesMatch()/runDedupPass() — fixing the merge
// rule itself is a separate slice of the dev-request.

import type Database from "better-sqlite3";
import { levenshtein, normalizeExperienceTitle, titleTokens } from "./experience-dedup";

// Mirrors SIGNIFICANT_TOKEN_MIN_LEN in experience-dedup.ts (not exported
// there): a shared token must be at least this long to count as evidence.
const SIGNIFICANT_TOKEN_MIN_LEN = 5;

// A shared significant token is "rare" (distinctive, trustworthy evidence)
// when its corpus count is below this; otherwise it is "generic" and links
// nothing. Under audit v2 the corpus count is DISTINCT PROVIDERS (see header).
// 5 stays the right default with provider-distinct counting: in both the prod
// corpus and the test fixtures, true proper nouns sit at 1–2 providers while
// genuinely broad activity words span 6+ providers even in small corpora —
// the two populations no longer overlap the way title counts did.
const DEFAULT_GENERIC_MIN = 5;

// Whole-string closeness bar for the AUDIT. Deliberately STRICTER than
// titlesMatch()'s 0.6 merge bar: the merge bar's job was "plausibly the
// same", but the audit's job is "is this evidence trustworthy?" — and the
// confirmed false-positive shapes sit ABOVE 0.6 ("Rafting i Sjoa - dagstur"
// vs "... - kveldstur" ≈ 0.79, "Klatring for barn" vs "... voksne" ≈ 0.74,
// "Brevandring på Nigardsbreen" vs "... Briksdalsbreen" ≈ 0.76) because they
// differ only in their one distinctive suffix token. 0.85 keeps genuine
// typo/minor-rewording re-harvests (>= 0.9 in practice) classified as
// whole-string while pushing the differs-only-in-the-distinctive-word shapes
// down to the token checks, where corpus frequency decides.
const DEFAULT_WHOLE_STRING_MIN = 0.85;

export type MergedPairVia = "whole-string" | "rare-token" | "generic-token-only" | "no-signal";

export interface SharedTokenInfo {
  token: string;
  corpusCount: number;
}

export interface MergedPairClassification {
  via: MergedPairVia;
  sharedTokens: SharedTokenInfo[];
  levSim: number;
}

export interface ClassifyOptions {
  /** Shared tokens with a corpus count >= this are generic (default 5).
   *  The audit path's corpus count is distinct PROVIDERS (audit v2). */
  genericMin?: number;
  /** Whole-string similarity bar (default 0.85 — see comment above). */
  wholeStringMin?: number;
}

/**
 * Classify the evidence linking two merged titles, strongest first:
 *   - 'whole-string':       near-identical wording (levSim >= wholeStringMin)
 *   - 'rare-token':         a shared significant token that is RARE in the
 *                           corpus (distinctive — e.g. "heyerdahl")
 *   - 'generic-token-only': the only shared significant token(s) are corpus-
 *                           common activity words ("fjelltur") — the exact
 *                           false-positive shape the defective titlesMatch()
 *                           merged on
 *   - 'no-signal':          nothing shared, nothing close (should not occur
 *                           for real merges, but classified defensively —
 *                           also suspect)
 */
export function classifyMergedPair(
  titleA: string,
  titleB: string,
  corpusTokenCounts: Map<string, number>,
  opts: ClassifyOptions = {}
): MergedPairClassification {
  const genericMin = opts.genericMin ?? DEFAULT_GENERIC_MIN;
  const wholeStringMin = opts.wholeStringMin ?? DEFAULT_WHOLE_STRING_MIN;

  const tokensA = new Set(titleTokens(titleA));
  const tokensB = new Set(titleTokens(titleB));
  const sharedTokens: SharedTokenInfo[] = [];
  for (const t of tokensA) {
    if (tokensB.has(t)) sharedTokens.push({ token: t, corpusCount: corpusTokenCounts.get(t) ?? 0 });
  }

  const na = normalizeExperienceTitle(titleA);
  const nb = normalizeExperienceTitle(titleB);
  const maxLen = Math.max(na.length, nb.length);
  const levSim = maxLen === 0 ? 1 : 1 - levenshtein(na, nb) / maxLen;

  const significant = sharedTokens.filter((t) => t.token.length >= SIGNIFICANT_TOKEN_MIN_LEN);

  let via: MergedPairVia;
  if (levSim >= wholeStringMin) via = "whole-string";
  else if (significant.some((t) => t.corpusCount < genericMin)) via = "rare-token";
  else if (significant.length > 0) via = "generic-token-only";
  else via = "no-signal";

  return { via, sharedTokens, levSim };
}

/**
 * Corpus token frequencies: how many DISTINCT titles each significant token
 * appears in (a token repeated within one title counts once). Stopwords and
 * short tokens never appear (titleTokens() drops them).
 *
 * NOTE: the audit path no longer uses this (title counts are inflated by the
 * duplicate clones themselves — see the audit-v2 header note) but the
 * contract is still valid for corpora without per-entity cloning; kept
 * exported for those callers.
 */
export function buildCorpusTokenCounts(titles: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const token of new Set(titleTokens(title))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Audit-v2 corpus token frequencies: how many DISTINCT PROVIDERS use each
 * significant token in any of their titles (merged or not). A provider with
 * 16 clone titles of one museum contributes exactly 1 to each of that
 * museum's tokens, so heavily-duplicated entities can't inflate their own
 * proper nouns into looking "generic". A NULL provider_id row counts as its
 * own singleton pseudo-provider (per-row fallback key) — orphan rows don't
 * collapse into one shared bucket. Token extraction is identical to
 * titleTokens() (a token counts once per provider, not per title).
 */
export function buildProviderCorpusTokenCounts(
  rows: Array<{ title: string; provider_id: string | null }>
): Map<string, number> {
  const providersByToken = new Map<string, Set<string>>();
  let orphanSeq = 0;
  for (const row of rows) {
    const providerKey = row.provider_id ?? `__orphan-row-${orphanSeq++}`;
    for (const token of new Set(titleTokens(row.title))) {
      const set = providersByToken.get(token);
      if (set) set.add(providerKey);
      else providersByToken.set(token, new Set([providerKey]));
    }
  }
  const counts = new Map<string, number>();
  for (const [token, providers] of providersByToken) {
    counts.set(token, providers.size);
  }
  return counts;
}

const VIA_RANK: Record<MergedPairVia, number> = {
  "whole-string": 3,
  "rare-token": 2,
  "generic-token-only": 1,
  "no-signal": 0,
};

export interface AuditedMergedRow {
  id: string;
  title: string;
  best_via: MergedPairVia;
  best_link_title: string | null;
  shared_tokens: SharedTokenInfo[];
  lev_sim: number;
  suspect: boolean;
}

export interface AuditedGroup {
  canonical_id: string;
  canonical_title: string;
  rows: AuditedMergedRow[];
}

export interface AuditSummary {
  groups_total: number;
  rows_total: number;
  rows_suspect: number;
  groups_with_suspects: number;
}

export interface AuditResult {
  groups: AuditedGroup[];
  summary: AuditSummary;
}

/**
 * Audit every merged group in the table (read-only, zero writes).
 *
 * For each merged row we compute its BEST link across the WHOLE group —
 * canonical row + every sibling merged row — because the merge pass clustered
 * via transitive union-find: a row may be legitimately in the group through a
 * near-identical sibling even when its link to the canonical itself is weak.
 * A row is SUSPECT when even its best link is 'generic-token-only' (the
 * defective single-common-token rule was the only thing holding it in) or
 * 'no-signal'.
 */
export function auditMergedGroups(db: Database.Database, opts: ClassifyOptions = {}): AuditResult {
  // Corpus = ALL rows (canonical, merged, and unmerged alike) — generic-ness
  // of a token is a property of the whole harvested table. Counted per
  // DISTINCT PROVIDER (audit v2), not per title, so a heavily-cloned entity's
  // own proper nouns stay rare (see header note).
  const corpusRows = db
    .prepare("SELECT title, provider_id FROM experiences")
    .all() as Array<{ title: string; provider_id: string | null }>;
  const corpus = buildProviderCorpusTokenCounts(corpusRows);

  const mergedRows = db
    .prepare("SELECT id, title, canonical_id FROM experiences WHERE canonical_id IS NOT NULL ORDER BY id")
    .all() as Array<{ id: string; title: string; canonical_id: string }>;

  const byCanonical = new Map<string, Array<{ id: string; title: string }>>();
  for (const row of mergedRows) {
    const arr = byCanonical.get(row.canonical_id);
    if (arr) arr.push(row);
    else byCanonical.set(row.canonical_id, [row]);
  }

  const getCanonical = db.prepare("SELECT title FROM experiences WHERE id = ?");

  const groups: AuditedGroup[] = [];
  let rowsTotal = 0;
  let rowsSuspect = 0;
  let groupsWithSuspects = 0;

  for (const [canonicalId, members] of byCanonical) {
    const canonicalTitle =
      (getCanonical.get(canonicalId) as { title: string } | undefined)?.title ?? "";

    const auditedRows: AuditedMergedRow[] = [];
    for (const row of members) {
      // Candidate link targets: the canonical row first, then every sibling.
      const linkTitles: string[] = [];
      if (canonicalTitle) linkTitles.push(canonicalTitle);
      for (const sibling of members) {
        if (sibling.id !== row.id) linkTitles.push(sibling.title);
      }

      let best: MergedPairClassification | null = null;
      let bestLinkTitle: string | null = null;
      for (const linkTitle of linkTitles) {
        const c = classifyMergedPair(row.title, linkTitle, corpus, opts);
        if (!best || VIA_RANK[c.via] > VIA_RANK[best.via]) {
          best = c;
          bestLinkTitle = linkTitle;
        }
      }
      // Defensive: a group with a vanished canonical and no siblings has
      // nothing to link against at all — that is suspect too.
      const resolved: MergedPairClassification = best ?? { via: "no-signal", sharedTokens: [], levSim: 0 };
      const suspect = resolved.via === "generic-token-only" || resolved.via === "no-signal";

      auditedRows.push({
        id: row.id,
        title: row.title,
        best_via: resolved.via,
        best_link_title: bestLinkTitle,
        shared_tokens: resolved.sharedTokens,
        lev_sim: resolved.levSim,
        suspect,
      });
      rowsTotal++;
      if (suspect) rowsSuspect++;
    }

    if (auditedRows.some((r) => r.suspect)) groupsWithSuspects++;
    groups.push({ canonical_id: canonicalId, canonical_title: canonicalTitle, rows: auditedRows });
  }

  return {
    groups,
    summary: {
      groups_total: groups.length,
      rows_total: rowsTotal,
      rows_suspect: rowsSuspect,
      groups_with_suspects: groupsWithSuspects,
    },
  };
}

// OPERATOR NOTE (review round 2): a row X can be kept non-suspect by a
// whole-string link to a sibling Y that is itself suspect; after Y is
// un-merged the next audit recomputes sibling links and may then flag X.
// The workflow is therefore iterative and self-healing: audit -> un-merge
// batch -> RE-AUDIT, until no new suspects appear.


