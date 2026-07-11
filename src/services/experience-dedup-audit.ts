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
// appears in few titles across the whole table ("heyerdahl") is distinctive
// evidence; one that appears everywhere ("fjelltur", "rafting", "klatring")
// is generic and proves nothing. Rows whose BEST link is generic-only (or no
// signal at all) are flagged suspect for the un-merge endpoint
// (POST /admin/experiences-dedup-unmerge in src/routes/opplevelser.ts).
//
// Deliberately does NOT touch titlesMatch()/runDedupPass() — fixing the merge
// rule itself is a separate slice of the dev-request.

import type Database from "better-sqlite3";
import { levenshtein, normalizeExperienceTitle, titleTokens } from "./experience-dedup";

// Mirrors SIGNIFICANT_TOKEN_MIN_LEN in experience-dedup.ts (not exported
// there): a shared token must be at least this long to count as evidence.
const SIGNIFICANT_TOKEN_MIN_LEN = 5;

// A shared significant token is "rare" (distinctive, trustworthy evidence)
// when it appears in fewer than this many distinct titles across the corpus;
// otherwise it is "generic" and links nothing.
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
  /** Shared tokens appearing in >= this many distinct titles are generic (default 5). */
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
  // Corpus = ALL titles (canonical, merged, and unmerged alike) — generic-ness
  // of a token is a property of the whole harvested table.
  const allTitles = (db.prepare("SELECT title FROM experiences").all() as Array<{ title: string }>).map(
    (r) => r.title
  );
  const corpus = buildCorpusTokenCounts(allTitles);

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
