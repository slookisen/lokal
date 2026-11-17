// ─── Bondens Marked producers we have no profile for (dev-request 2026-11-15-rfb-nattjobb-hull-kontaktuttrekk-bm-og-koer, slice B2) ──
//
// The nightly enrichment job's Bondens Marked step (GET /admin/bm-producer-
// harvest?dry_run=false, routes/admin-bm-producer-harvest.ts) used to drop
// every producer page it could not match to one of our profiles
// (`outcome: "unmatched"`). This module keeps them as candidates instead:
// name, place and the Bondens Marked page, with `first_seen` / `last_seen`.
//
// Nothing is registered here. The list is read by discovery
// (dev-request 2026-11-15-discovery-nettsidesok-sammenslaaing-og-maaltall)
// via GET /admin/bm-producer-harvest/unmatched-candidates.
//
// A page whose name is a known producer under another spelling (another legal
// suffix, «Gård»/«Gard», punctuation, a different city on the BM page) is NOT
// a candidate: the strict matcher in services/bm-producer-harvest.ts needs a
// city anchor as well, so a name variant can come back `unmatched` there while
// the producer is already ours. `findKnownBmProducerVariant` catches that case
// with the name alone, over all producer profiles (active or not).
//
// A candidate whose slug later matches a profile is stamped `matched_agent_id`
// / `matched_at` / `matched_via` (no delete) and drops out of the default list.
// A page suppressed as a known name variant is kept too, already stamped
// (`matched_via = 'name_variant'`), so it is never on the default list but
// stays auditable with `include_matched=1` (review B1/N1 on lokal#1590).

import { getDb } from "../database/init";
import { normaliseNamePruned } from "./brreg-client";
import { diceCoefficient } from "./debio-cross-check";
import type { BmProducerRecord } from "./bm-producer-harvest";

type Db = ReturnType<typeof getDb>;

/** Same threshold as the strict matcher's name half (BM_MATCH_NAME_THRESHOLD). */
export const BM_KNOWN_VARIANT_NAME_THRESHOLD = 0.85;

/** Hard cap for the list endpoint. */
export const BM_CANDIDATES_MAX_LIMIT = 500;

/** Idempotent. Also created at boot in database/init.ts. */
export function ensureBmUnmatchedCandidatesTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bm_unmatched_candidates (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT,
      source_url TEXT NOT NULL,
      website TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      matched_agent_id TEXT,
      matched_at TEXT,
      matched_via TEXT
    );
  `);
}

/** Lowercase, æøå folded, punctuation and a trailing legal suffix (AS, ANS, DA, …) removed, spaces dropped. */
export function bmCompactName(name: string): string {
  return normaliseNamePruned(name).replace(/\s+/g, "");
}

export interface BmKnownVariant {
  agentId: string;
  agentName: string;
  nameScore: number;
}

/**
 * READ-ONLY. The producer profile (any `is_active`) whose name is the same
 * producer under another spelling: equal compact name, or a pruned-name Dice
 * score ≥ BM_KNOWN_VARIANT_NAME_THRESHOLD. No city check. Best score wins;
 * null when none.
 */
export function findKnownBmProducerVariant(db: Db, name: string): BmKnownVariant | null {
  const compact = bmCompactName(name);
  if (!compact) return null;
  const pruned = normaliseNamePruned(name);
  const rows = db
    .prepare(`SELECT id, name FROM agents WHERE role = 'producer'`)
    .all() as Array<{ id: string; name: string | null }>;
  let best: BmKnownVariant | null = null;
  for (const r of rows) {
    if (!r.name) continue;
    const score = bmCompactName(r.name) === compact ? 1 : diceCoefficient(pruned, normaliseNamePruned(r.name));
    if (score >= BM_KNOWN_VARIANT_NAME_THRESHOLD && (!best || score > best.nameScore)) {
      best = { agentId: r.id, agentName: r.name, nameScore: score };
    }
  }
  return best;
}

export type BmCandidateOutcome = "candidate_stored" | "candidate_known_variant" | "candidate_error";

export interface BmCandidateResult {
  outcome: BmCandidateOutcome;
  agentId?: string;
  detail?: string;
}

/**
 * For an `unmatched` record: insert the page, or refresh name/city/page/
 * website and `last_seen` (+1 `seen_count`) when the slug is already there.
 *   - known name variant → the row is stamped matched (`matched_via =
 *     'name_variant'`, first stamp kept), so it is not on the default list —
 *     also when it was listed on an earlier night (review B1).
 *   - otherwise → listed; a stamp from an earlier night is cleared.
 * Never throws.
 */
export function recordBmUnmatchedCandidate(db: Db, record: BmProducerRecord, nowIso: string): BmCandidateResult {
  try {
    const variant = findKnownBmProducerVariant(db, record.name);
    ensureBmUnmatchedCandidatesTable(db);
    if (variant) {
      db.prepare(
        `INSERT INTO bm_unmatched_candidates
           (slug, name, city, source_url, website, first_seen, last_seen, seen_count, matched_agent_id, matched_at, matched_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'name_variant')
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           city = excluded.city,
           source_url = excluded.source_url,
           website = excluded.website,
           last_seen = excluded.last_seen,
           seen_count = bm_unmatched_candidates.seen_count + 1,
           matched_via = CASE WHEN bm_unmatched_candidates.matched_agent_id IS NULL THEN excluded.matched_via ELSE bm_unmatched_candidates.matched_via END,
           matched_at = CASE WHEN bm_unmatched_candidates.matched_agent_id IS NULL THEN excluded.matched_at ELSE bm_unmatched_candidates.matched_at END,
           matched_agent_id = COALESCE(bm_unmatched_candidates.matched_agent_id, excluded.matched_agent_id)`,
      ).run(record.slug, record.name, record.city, record.sourceUrl, record.website, nowIso, nowIso, variant.agentId, nowIso);
      return { outcome: "candidate_known_variant", agentId: variant.agentId };
    }
    db.prepare(
      `INSERT INTO bm_unmatched_candidates (slug, name, city, source_url, website, first_seen, last_seen, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         city = excluded.city,
         source_url = excluded.source_url,
         website = excluded.website,
         last_seen = excluded.last_seen,
         seen_count = bm_unmatched_candidates.seen_count + 1,
         matched_agent_id = NULL,
         matched_at = NULL,
         matched_via = NULL`,
    ).run(record.slug, record.name, record.city, record.sourceUrl, record.website, nowIso, nowIso);
    return { outcome: "candidate_stored" };
  } catch (e: any) {
    return { outcome: "candidate_error", detail: e?.message ?? String(e) };
  }
}

/**
 * A slug the strict matcher now matches leaves the list (stamped
 * `matched_via = 'profile'`, not deleted; the first stamp is kept). No-op when
 * not listed. Bookkeeping on the candidate table only — no profile is written,
 * so it also runs for a matched agent outside the caller's scope (review N4).
 * Never throws. The table exists at boot (database/init.ts); no DDL here.
 */
export function markBmCandidateMatched(db: Db, slug: string, agentId: string, nowIso: string): void {
  try {
    db.prepare(
      `UPDATE bm_unmatched_candidates SET matched_agent_id = ?, matched_at = ?, matched_via = 'profile' WHERE slug = ? AND matched_agent_id IS NULL`,
    ).run(agentId, nowIso, slug);
  } catch {
    /* the harvest result does not depend on this bookkeeping */
  }
}

export interface BmCandidateRow {
  slug: string;
  name: string;
  city: string | null;
  source_url: string;
  website: string | null;
  first_seen: string;
  last_seen: string;
  seen_count: number;
  matched_agent_id: string | null;
  matched_at: string | null;
  matched_via: string | null;
}

/** READ-ONLY list, newest `last_seen` first. `includeMatched` adds the stamped rows. */
export function listBmUnmatchedCandidates(
  db: Db,
  opts: { limit: number; includeMatched: boolean },
): { total: number; candidates: BmCandidateRow[] } {
  ensureBmUnmatchedCandidatesTable(db);
  const where = opts.includeMatched ? "" : "WHERE matched_agent_id IS NULL";
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM bm_unmatched_candidates ${where}`).get() as { c: number }).c;
  const candidates = db
    .prepare(
      `SELECT slug, name, city, source_url, website, first_seen, last_seen, seen_count, matched_agent_id, matched_at, matched_via
       FROM bm_unmatched_candidates ${where}
       ORDER BY last_seen DESC, slug ASC
       LIMIT ?`,
    )
    .all(opts.limit) as BmCandidateRow[];
  return { total, candidates };
}
