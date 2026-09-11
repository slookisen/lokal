// ─── Experiences provider Brreg re-check backfill ────────────────────
//
// PROBLEM. classifyProvider() (experience-brreg.ts) runs ONCE per provider,
// at bulk-load insert time (routes/opplevelser.ts POST /admin/bulk-load),
// and calls setBrregVerification() (experience-store.ts) to stamp
// brreg_active ONLY when the verdict is `verified_active` (-> 1) or
// `inactive` (-> 0) — both require a confident Brreg name match. A provider
// classified `unverified` at insert time (Brreg's fuzzy name-search found no
// candidate confident enough to trust — see experience-brreg.ts's own header
// on why a marginal hit is never force-matched) is left at
// brreg_active = NULL forever: nothing else in this codebase ever revisits
// it — there is no periodic re-check, and bulk-load only classifies a given
// provider name once (a re-run only refreshes an ALREADY-brreg_verified
// provider; see the `if (verdict.brreg_verified === 1)` guards around both
// setBrregVerification() call sites in POST /admin/bulk-load).
//
// Downstream, POST /admin/experiences-content-judge-sweep's quarantine-exit
// promotion logic (routes/opplevelser.ts, dev-request 2026-09-02-experiences-
// karantene-utgang-match-til-verified) requires `provider.brreg_active === 1`
// as ONE of its three independent promotion requirements — so a provider
// stuck at brreg_active=NULL can NEVER be promoted out of `needs_review`,
// even after a fresh content-judge re-check confirms the row's content is a
// correct MATCH against a verified source. A 35-row random sample found
// 100% of needs_review rows blocked this way, including 17 rows (49%) the
// content-judge freshly re-confirmed as high-confidence MATCH.
//
// THIS FILE re-runs the EXACT SAME classifyProvider() Brreg lookup
// (experience-brreg.ts — zero second Brreg-calling code path added here) for
// providers whose brreg_active IS STILL NULL, and writes
// brreg_active/brreg_verified/org_nr via the EXACT SAME
// setBrregVerification() (experience-store.ts) ONLY when this run's fresh
// classifyProvider() call itself returns a confident verdict:
//
//   - verified_active -> brreg_active -> 1  (`resolved_active`) — this is
//     the one that unblocks the content-judge-sweep promotion gate above.
//   - inactive        -> brreg_active -> 0  (`resolved_inactive`) — a real,
//     confirmed answer (konkurs/avvikling/slettet), not a guess; distinct
//     from "we don't know" (NULL).
//   - unverified      -> `still_unresolved`. NO WRITE — brreg_active stays
//     exactly NULL, never guessed either way. The row stays eligible for the
//     next backfill run (Brreg's own registry data changes over time, e.g. a
//     provider registers under a name that later matches more cleanly).
//
// A classifyProvider() call that THROWS (network error/timeout/malformed
// response) is fail-closed identically to `unverified`: `still_unresolved`,
// zero write, plus a separate `errors` tally so a genuine Brreg outage is
// visibly distinguishable from an ordinary "no confident match" run.
//
// NON-GOALS (unchanged by this file): the content-judge-sweep promotion
// gate's `brreg_active === 1` requirement itself; the content-judge; the
// bulk-load admission gate. This file only ever feeds brreg_active a fresh,
// confirmed answer — it never relaxes what reads that column.
//
// PATTERN: mirrors services/agents-geocode-invalidate-backfill.ts — the
// sanctioned shape for "one-off/periodic batch re-check of a pre-existing
// backlog with no worker of its own": dry-run-default, admin-key-gated route
// (POST /api/opplevelser/admin/experiences-provider-brreg-recheck-backfill,
// routes/opplevelser.ts), a per-call `limit` cap, and keyset (`after`)
// pagination so a repeat call converges across the backlog instead of
// re-selecting the same head-of-queue rows forever (relevant here too: a row
// that resolves `still_unresolved` does not change state, so a bare
// `ORDER BY id LIMIT ?` would otherwise never advance past it).
//
// SELECTION. `brreg_active IS NULL` (the spec's own criterion) AND NOT
// owner-locked (`content_source NOT IN ('manual','claim')` — the SAME
// "never let an automated re-classification touch owner-provided data"
// convention selectGardssalgProvidersForOrgnrBackfill already applies to
// this SAME experience_providers table's org_nr field) AND NOT
// catalog_hidden (a hidden/removed provider is not worth spending Brreg
// budget re-checking).
//
// RATE LIMITING. Paced by BRREG_RECHECK_PACE_MS between calls — the same
// 200ms politeness window POST /admin/bulk-load's own classifyProvider loop
// already uses (routes/opplevelser.ts's BRREG_PACE_MS) — via an injectable
// `sleep` dep; tests inject a no-op (same seam agents-geocode-invalidate-
// backfill.test.ts and bulk-load's own admission-gate tests use for their
// respective pacing/timeout sleeps).

import { getDb } from "../database/db-factory";
import { classifyProvider, sleep as defaultSleep, type BrregClass } from "./experience-brreg";
import { getProviderByOrgnr, setBrregVerification } from "./experience-store";

const VERTICAL = "experiences";

/** Order-of-magnitude match to the sibling backfills (agents-geocode-invalidate-backfill's 50, experiences-content-judge-sweep's SWEEP_MAX_LIMIT 50) — Brreg name-search is the same external call bulk-load already paces at BRREG_RECHECK_PACE_MS, so a bigger cap just means a longer HTTP call, not a bigger blast radius. */
export const BRREG_RECHECK_BACKFILL_DEFAULT_LIMIT = 25;
export const BRREG_RECHECK_BACKFILL_MAX_LIMIT = 50;

/** Politeness window between Brreg calls — byte-identical value to routes/opplevelser.ts's own BRREG_PACE_MS (bulk-load's classifyProvider loop). */
export const BRREG_RECHECK_PACE_MS = 200;

export type BrregRecheckOutcome = "resolved_active" | "resolved_inactive" | "still_unresolved";

export type BrregRecheckBackfillDeps = {
  /** Report what would change; write nothing. */
  dryRun?: boolean;
  /**
   * Keyset pagination cursor — the last id the PREVIOUS call reported as
   * `next_after`. Without it, a row this call leaves `still_unresolved`
   * (brreg_active stays NULL, no state change) would be re-selected by a
   * bare `ORDER BY id LIMIT ?` at the top of every subsequent call forever.
   * Absent/undefined means "start from the beginning".
   */
  after?: string;
  /** Injectable pacing sleep — tests pass a no-op. Defaults to the real setTimeout-based sleep(). */
  sleep?: (ms: number) => Promise<void>;
};

export type BrregRecheckPlannedRow = {
  provider_id: string;
  navn: string;
  kommune: string | null;
  outcome: BrregRecheckOutcome;
  org_nr: string | null;
  classification: BrregClass;
  detail: string;
};

export type BrregRecheckBackfillResult = {
  dry_run: boolean;
  processed: number;
  /** Fresh lookup found a confident ACTIVE Brreg match — brreg_active written as 1. */
  resolved_active: number;
  /** Fresh lookup found a confident match but the entity is konkurs/avvikling/slettet — brreg_active written as 0. */
  resolved_inactive: number;
  /** No confident Brreg match this run (or the lookup itself failed) — left untouched, brreg_active stays NULL, never guessed. */
  still_unresolved: number;
  /** Subset of still_unresolved caused by classifyProvider() THROWING (network/timeout/malformed response), not a genuine "no match" answer. */
  errors: number;
  duration_ms: number;
  planned: BrregRecheckPlannedRow[];
  /** Keyset pagination cursor — id of the last row scanned this call, or null once the page came back shorter than `limit` (nothing left eligible). Pass back as `deps.after` on the next call. */
  next_after: string | null;
};

type CandidateRow = { id: string; navn: string; kommune: string | null };

/** Rows classifyProvider() has never resolved a confident verdict for, excluding owner-locked/hidden rows (see file header). */
const CANDIDATE_WHERE = `
  brreg_active IS NULL
  AND (content_source IS NULL OR content_source NOT IN ('manual', 'claim'))
  AND (catalog_hidden IS NULL OR catalog_hidden != 1)
`;

/** Denominator for the admin endpoint — how many providers this batch could still re-check. */
export function experienceBrregRecheckBackfillQueueStatus(): { eligible: number } {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE ${CANDIDATE_WHERE}`)
    .get() as { n: number } | undefined;
  return { eligible: row?.n ?? 0 };
}

function emptyResult(dryRun: boolean): BrregRecheckBackfillResult {
  return {
    dry_run: dryRun,
    processed: 0,
    resolved_active: 0,
    resolved_inactive: 0,
    still_unresolved: 0,
    errors: 0,
    duration_ms: 0,
    planned: [],
    next_after: null,
  };
}

/**
 * One pass over up to `limit` eligible providers. See this file's header for
 * the full decision rule. NEVER writes brreg_active=1 (or any brreg_*
 * field) without this SAME call's own classifyProvider() actually returning
 * a confident verdict — a `still_unresolved` row is left byte-identical.
 */
export async function experienceBrregRecheckBackfillTick(
  limit: number = BRREG_RECHECK_BACKFILL_DEFAULT_LIMIT,
  deps: BrregRecheckBackfillDeps = {}
): Promise<BrregRecheckBackfillResult> {
  const start = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb(VERTICAL);
  const sleepFn = deps.sleep ?? defaultSleep;
  const after = typeof deps.after === "string" ? deps.after : "";
  const cappedLimit = Math.max(1, Math.min(BRREG_RECHECK_BACKFILL_MAX_LIMIT, limit));
  const result = emptyResult(dryRun);

  const candidates = db
    .prepare(
      `SELECT id, navn, kommune FROM experience_providers
        WHERE ${CANDIDATE_WHERE}
          AND id > ?
        ORDER BY id ASC
        LIMIT ?`
    )
    .all(after, cappedLimit) as CandidateRow[];

  // Keyset cursor for the NEXT call — see BrregRecheckBackfillDeps.after's
  // own comment for why a plain `ORDER BY id LIMIT ?` re-selects an
  // unchanged (still_unresolved) row forever without it.
  result.next_after =
    candidates.length === cappedLimit && candidates.length > 0
      ? candidates[candidates.length - 1].id
      : null;

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    result.processed++;
    // Pace Brreg calls (skip the wait before the first call) — same
    // politeness window bulk-load's own classifyProvider loop uses.
    if (i > 0) await sleepFn(BRREG_RECHECK_PACE_MS);

    try {
      const verdict = await classifyProvider({ name: row.navn, kommune: row.kommune });

      // org_nr-collision guard (independent-review fix-up): experience_providers.org_nr
      // is UNIQUE. A fresh Brreg lookup can resolve to an org_nr ANOTHER row already
      // holds (a duplicate/near-duplicate provider) — the exact scenario bulk-load's own
      // resolve-or-create logic already guards against by resolving identity through
      // getProviderByOrgnr() BEFORE ever writing (routes/opplevelser.ts). Checking here,
      // before calling setBrregVerification(), keeps this file's own invariant intact:
      // exactly ONE `planned` entry per row, and resolved_active + resolved_inactive +
      // still_unresolved === processed, always — even for a collision. (Without this
      // guard, the write below would throw SQLITE_CONSTRAINT and the outer catch would
      // push a SECOND, contradictory planned entry for the same provider_id.)
      const orgNrHeldByAnotherRow =
        !!verdict.org_nr &&
        (() => {
          const holder = getProviderByOrgnr(verdict.org_nr as string);
          return holder !== null && (holder.id as string) !== row.id;
        })();

      if (orgNrHeldByAnotherRow) {
        result.still_unresolved++;
        result.planned.push({
          provider_id: row.id,
          navn: row.navn,
          kommune: row.kommune,
          outcome: "still_unresolved",
          org_nr: null,
          classification: verdict.classification,
          detail: `fresh Brreg lookup resolved org_nr ${verdict.org_nr} but it is already held by a different provider row — left untouched, brreg_active stays NULL (org_nr collision, not a guess)`,
        });
      } else if (verdict.classification === "verified_active" || verdict.classification === "inactive") {
        // Dedicated try/catch around JUST the write (independent-review fix-up):
        // the org_nr-collision guard above catches the known, expected collision
        // case BEFORE attempting the write, but a write can still fail for an
        // unrelated reason (e.g. a DB lock, or a race against another writer
        // between the check above and this UPDATE). Either way, counters/planned
        // must reflect the write's ACTUAL outcome exactly once — never increment
        // resolved_active/resolved_inactive (or push that planned entry) before
        // a real (non-dry-run) write has actually succeeded, and never let this
        // fall through to the outer catch, which would double-count the row.
        const active = verdict.classification === "verified_active" ? 1 : 0;
        try {
          if (!dryRun) {
            setBrregVerification(row.id, active, verdict.org_nr ?? undefined);
          }
          if (active === 1) {
            result.resolved_active++;
            result.planned.push({
              provider_id: row.id,
              navn: row.navn,
              kommune: row.kommune,
              outcome: "resolved_active",
              org_nr: verdict.org_nr,
              classification: verdict.classification,
              detail: "fresh Brreg lookup found a confident active match this run — brreg_active -> 1",
            });
          } else {
            result.resolved_inactive++;
            result.planned.push({
              provider_id: row.id,
              navn: row.navn,
              kommune: row.kommune,
              outcome: "resolved_inactive",
              org_nr: verdict.org_nr,
              classification: verdict.classification,
              detail:
                "fresh Brreg lookup found a confident match but the entity is konkurs/under avvikling/slettet — brreg_active -> 0 (a confirmed answer, not a guess)",
            });
          }
        } catch (writeErr) {
          result.errors++;
          result.still_unresolved++;
          result.planned.push({
            provider_id: row.id,
            navn: row.navn,
            kommune: row.kommune,
            outcome: "still_unresolved",
            org_nr: null,
            classification: verdict.classification,
            detail: `Brreg verdict was confident but the write failed (${writeErr instanceof Error ? writeErr.message : String(writeErr)}) — left untouched, brreg_active stays NULL, never guessed`,
          });
          console.error(`[experience-brreg-recheck-backfill] write failed for ${row.id}:`, writeErr);
        }
      } else {
        result.still_unresolved++;
        result.planned.push({
          provider_id: row.id,
          navn: row.navn,
          kommune: row.kommune,
          outcome: "still_unresolved",
          org_nr: null,
          classification: verdict.classification,
          detail: "no confident Brreg name match this run — left untouched, brreg_active stays NULL, never guessed",
        });
      }
    } catch (err) {
      // Fail-closed: a Brreg lookup that errors/times out is NEVER a
      // resolution — same isolation discipline as bulk-load's own
      // per-provider try/catch (one Brreg/DB failure never aborts the
      // batch, and never masquerades as an actual verdict).
      result.errors++;
      result.still_unresolved++;
      result.planned.push({
        provider_id: row.id,
        navn: row.navn,
        kommune: row.kommune,
        outcome: "still_unresolved",
        org_nr: null,
        classification: "unverified",
        detail: `Brreg lookup failed (${err instanceof Error ? err.message : String(err)}) — left untouched, never guessed`,
      });
      console.error(`[experience-brreg-recheck-backfill] failed for ${row.id}:`, err);
    }
  }

  result.duration_ms = Date.now() - start;
  return result;
}
