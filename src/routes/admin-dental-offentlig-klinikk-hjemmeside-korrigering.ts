// ─── POST /admin/dental/offentlig-klinikk-hjemmeside-korrigering ───────────
// dev-request 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning,
// slice 2d.
//
// WHY: the catalog-class backfill (slice 1, already live) correctly flags a
// row `catalog_class='offentlig_klinikk'` whenever its `hjemmeside` is a
// fylkeskommune/kommune directory host (`isPublicDentalServiceHost()`,
// services/dental-catalog-class.ts) — but classifying the row never fixes
// the underlying data: `hjemmeside` is STILL the county's directory page,
// not the clinic's own site. Nothing else in the codebase corrects this for
// rows that already carry the bad value:
//   - hjemmeside-cleanup-sweep's classifier (dental-hjemmeside-classifier.ts)
//     has no knowledge of PUBLIC_DENTAL_SERVICE_HOSTS at all — it will never
//     move a fylkeskommune-hosted hjemmeside out on its own.
//   - hjemmeside-discovery-batch/-approve (admin-dental-hjemmeside-
//     discovery.ts) only ever considers rows with a BLANK hjemmeside — a row
//     already carrying the fylkeskommune URL is invisible to it, and its
//     approve write is unconditionally fill-only (refuses to write over a
//     non-blank hjemmeside even if a candidate were somehow queued for one).
//
// This route is a ONE-TIME, safely re-runnable admin pass scoped to exactly
// that cohort: for each candidate it re-runs the SAME two-tier discovery
// mechanism the existing discovery batch route uses (Brreg-field leg, then a
// navnesøk/name-search fallback — both now shared via
// discoverDentalClinicWebsite, admin-dental-hjemmeside-discovery.ts) against
// the row's own org_nr/navn/poststed, and when (and only when) that finds a
// genuine, evidence-verified clinic site, atomically moves the OLD
// fylkeskommune URL into the additive `directory_url` column and writes the
// NEW verified URL into `hjemmeside` — provenance-stamped on both. When
// nothing verifies, the row is left completely untouched apart from a
// no-retry marker (`offentlig_klinikk_korrigering_attempted_at`, see
// init-dental.ts) so this one-off pass doesn't keep re-fetching the same
// dead end forever. Per the dev-request's own text: "ellers beholdes —
// offentlig klinikk har ingen egen [side]".
//
// A found+verified candidate is NOT queued into dental_website_review_queue
// — that table's schema/approve-path assumes fill-only semantics (see its
// own file header) this route must not reuse, since here `hjemmeside` is
// ALREADY non-blank (the fylkeskommune URL) and must be overwritten, not
// filled. This route performs its own direct, explicit write instead.
//
// Non-goals (see the dev-request's own "Non-goals" section — do not extend
// this route to cover these): no change to hjemmeside-discovery-batch/
// -approve's own candidate query or fill-only write semantics for any OTHER
// row; no change to hjemmeside-cleanup-sweep's classifier or candidate set;
// no change to catalog_class rules or the backfill endpoint; no new domain
// lists (isPublicDentalServiceHost is reused verbatim); no duplication of
// the discovery/evidence logic (see discoverDentalClinicWebsite's own doc
// comment in admin-dental-hjemmeside-discovery.ts for the extraction shape).
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route file in this codebase). dry_run (STRICT-FALSE parse, same
// convention as every other admin sweep): body.dry_run !== false — only the
// literal JSON boolean `false` triggers a real write.

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import { isPublicDentalServiceHost } from "../services/dental-catalog-class";
import {
  discoverDentalClinicWebsite,
  effectiveDentalWdSearchImpl,
  type DentalWdTargetRow,
} from "./admin-dental-hjemmeside-discovery";
// parseSweepOffset is a tiny, already-tested pure helper (non-negative
// integer, default 0) — reused verbatim rather than re-implementing the
// exact same one-liner a second time (mirrors this codebase's existing
// cross-route-file import convention, e.g. admin-rfb-brreg-selfsufficiency.ts
// importing from admin-rfb-website-discovery.ts).
import { parseSweepOffset } from "./admin-dental-hjemmeside-cleanup";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

// Hard per-call cap on how many candidate rows are actually run through
// discovery in a single POST. Deliberately mirrors DENTAL_WD_BATCH_CAP (25,
// admin-dental-hjemmeside-discovery.ts) rather than HJEMMESIDE_CLEANUP_
// BATCH_CAP (200, admin-dental-hjemmeside-cleanup.ts): like that route (and
// unlike the pure-SQL cleanup sweep), each candidate here can trigger a real
// Brreg lookup, a page fetch, and possibly a Brave search call — the same
// per-row network cost the discovery batch route already caps at 25/call
// for exactly this wall-clock reason.
export const OFFENTLIG_KLINIKK_KORRIGERING_BATCH_CAP = 25;

// Defensive upper bound on how many `catalog_class='offentlig_klinikk' AND
// hjemmeside non-blank AND not-yet-attempted` rows this route will ever pull
// from SQL in one call, BEFORE the (JS-side, not SQL-expressible without a
// long OR chain) isPublicDentalServiceHost() filter narrows that down to the
// true candidate set. The live cohort this slice targets is ~186 rows total
// (per the dev-request's own build log) — this cap exists purely so a
// future, much larger "offentlig_klinikk with a real hjemmeside" population
// can never make one call scan an unbounded number of rows into memory; it
// is not expected to ever bind in practice.
const RAW_PREFILTER_SAFETY_CAP = 5000;

interface RawCandidateRow {
  id: string;
  navn: string;
  org_nr: string | null;
  poststed: string | null;
  telefon: string | null;
  mobil: string | null;
  adresse: string | null;
  postnummer: string | null;
  hjemmeside: string;
  catalog_class: string | null;
  field_provenance: string | null;
  created_at: string | null;
}

// Cheap SQL prefilter shared by the fetch below and (for an exact count of
// the OUTER, pre-host-filter set — informational only, never used for
// pagination math) nothing else needs it standalone today, but kept as its
// own function so the WHERE clause can never drift between call sites.
function candidatePrefilterSql(): string {
  return `catalog_class = 'offentlig_klinikk'
       AND hjemmeside IS NOT NULL AND TRIM(hjemmeside) <> ''
       AND offentlig_klinikk_korrigering_attempted_at IS NULL`;
}

// Fetches every row matching the cheap SQL prefilter (bounded by
// RAW_PREFILTER_SAFETY_CAP — see its own comment), oldest-`created_at`-first
// with `id` as a deterministic tiebreaker. The `isPublicDentalServiceHost`
// host check itself happens in JS (findTrueCandidates below) — it is not
// cheaply expressible as a plain SQL predicate over PUBLIC_DENTAL_SERVICE_
// HOSTS' suffix-match semantics, and the dev-request's own byggspec
// explicitly allows either "host check in JS after a cheap SQL prefilter, or
// pure JS filter" as the implementer's call.
function fetchPrefilteredCandidateRows(db: ReturnType<typeof getDb>): RawCandidateRow[] {
  return db
    .prepare(
      `SELECT id, navn, org_nr, poststed, telefon, mobil, adresse, postnummer, hjemmeside, catalog_class, field_provenance, created_at
         FROM dental_agents
        WHERE ${candidatePrefilterSql()}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(RAW_PREFILTER_SAFETY_CAP) as RawCandidateRow[];
}

// The TRUE candidate set: the SQL-prefiltered rows above, narrowed to the
// ones whose CURRENT hjemmeside is actually a fylkeskommune/kommune host.
// Every offset/limit/remaining_count computation below operates on THIS
// list, not the raw SQL page, so `scanned`/`remaining_count` are always
// exact — never an over-count from rows that merely share catalog_class and
// a non-blank hjemmeside but already carry a genuine clinic site (those are
// never candidates at all, and are correctly never touched by this route).
function findTrueCandidates(db: ReturnType<typeof getDb>): RawCandidateRow[] {
  return fetchPrefilteredCandidateRows(db).filter((r) => isPublicDentalServiceHost(r.hjemmeside));
}

function toTargetRow(r: RawCandidateRow): DentalWdTargetRow {
  return {
    id: r.id,
    navn: r.navn,
    // discoverDentalClinicWebsite's Brreg leg (fetchBrregContact) already
    // treats an empty org_nr as "no result, no network call" — many
    // offentlig_klinikk rows in this exact cohort have NO org_nr at all
    // (county-directory import rows with no Brreg metadata, dental-catalog-
    // class.ts rule 4), and coercing null -> "" here lets those rows still
    // fall through to tier 2 (navnesøk fallback) cleanly instead of needing
    // a separate code path.
    org_nr: r.org_nr ?? "",
    poststed: r.poststed,
    telefon: r.telefon,
    mobil: r.mobil,
    adresse: r.adresse,
    postnummer: r.postnummer,
    hjemmeside: r.hjemmeside,
  };
}

// Parse dental_agents.field_provenance (JSON string, possibly null/malformed)
// into a plain object — malformed/non-object/array JSON is treated as empty
// so a corrupted existing blob never blocks this write (mirrors
// parseFieldProvenance in the sibling cleanup/discovery route files).
function parseFieldProvenance(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface OffentligKlinikkDirectoryUrlProvenanceEntry {
  moved_reason: "offentlig_klinikk_korrigering";
  previous_field: "hjemmeside";
  moved_at: string;
}

export interface OffentligKlinikkHjemmesideProvenanceEntry {
  source_type: "brreg_registered_website" | "search_verified_website";
  value: string;
  source_url: string;
  replaced_offentlig_klinikk_host: string;
  fetched_at: string;
}

/**
 * Merges BOTH the "directory_url" and "hjemmeside" field_provenance entries
 * this route's replace-path writes into an existing field_provenance blob in
 * ONE pass, preserving every OTHER field's provenance untouched — same
 * merge-not-clobber idiom as mergeHjemmesideCleanupProvenance /
 * mergeHjemmesideDiscoveryProvenance (the sibling route files), just setting
 * two keys instead of one since this route touches two columns atomically.
 * Pure — exported for unit-testing.
 */
export function mergeOffentligKlinikkKorrigeringProvenance(
  existingRaw: string | null | undefined,
  directoryUrlEntry: OffentligKlinikkDirectoryUrlProvenanceEntry,
  hjemmesideEntry: OffentligKlinikkHjemmesideProvenanceEntry,
): string {
  const existing = parseFieldProvenance(existingRaw);
  return JSON.stringify({ ...existing, directory_url: directoryUrlEntry, hjemmeside: hjemmesideEntry });
}

type SkipReason = "no_brreg_website" | "aggregator_host" | "fetch_failed" | "insufficient_evidence";

interface CandidateOutcomeFound {
  found: true;
  candidate_url: string;
  final_url: string;
  confidence: number;
  queue_reason: "brreg_field" | "navnesok_fallback";
}
interface CandidateOutcomeNotFound {
  found: false;
  reason: SkipReason;
}
type CandidateOutcome = CandidateOutcomeFound | CandidateOutcomeNotFound;

// Runs the shared discovery step for one candidate row. Never throws —
// discoverDentalClinicWebsite's own two legs already resolve every network/
// evidence outcome to a named status (see admin-dental-hjemmeside-
// discovery.ts).
async function discoverForCandidate(
  row: RawCandidateRow,
  searchImpl: ((query: string) => Promise<import("../services/search-enrich").BraveResult[]>) | null,
): Promise<CandidateOutcome> {
  const outcome = await discoverDentalClinicWebsite(toTargetRow(row), searchImpl);
  if (
    outcome.status === "queued" &&
    outcome.candidate_url &&
    outcome.final_url &&
    outcome.confidence !== undefined &&
    outcome.queue_reason
  ) {
    return {
      found: true,
      candidate_url: outcome.candidate_url,
      final_url: outcome.final_url,
      confidence: outcome.confidence,
      queue_reason: outcome.queue_reason,
    };
  }
  return { found: false, reason: outcome.status as SkipReason };
}

export type ApplyOffentligKlinikkOutcome =
  | { action: "replaced"; old_hjemmeside: string; new_hjemmeside: string }
  | { action: "kept_no_candidate"; reason: SkipReason }
  | { action: "skipped_stale" };

// Re-fetches a single row's CURRENT hjemmeside/catalog_class/
// offentlig_klinikk_korrigering_attempted_at/field_provenance and, ONLY if
// it's still exactly the row this candidate was scanned from (same
// hjemmeside, still catalog_class='offentlig_klinikk', still never
// attempted), writes the outcome — this is the re-verify-immediately-
// before-writing guard (mirrors applyHjemmesideCleanupToRow, admin-dental-
// hjemmeside-cleanup.ts): a row that changed (or was already processed by a
// concurrent call) between the scan and this write is skipped entirely,
// never clobbered and never re-stamped.
//
// - A `found` outcome performs ONE write: directory_url <- old hjemmeside,
//   hjemmeside <- new verified URL, offentlig_klinikk_korrigering_
//   attempted_at <- now, field_provenance merged for BOTH touched columns.
// - A `not found` outcome performs ONE write: ONLY offentlig_klinikk_
//   korrigering_attempted_at <- now — every other column (including
//   hjemmeside, which keeps the fylkeskommune URL) is left byte-for-byte
//   untouched. This is what "ellers beholdes" (the dev-request's own words)
//   means in code.
//
// Exported standalone so both branches — and the stale-skip guard — can be
// unit-tested directly without needing an actual concurrent request.
export function applyOffentligKlinikkKorrigeringToRow(
  db: ReturnType<typeof getDb>,
  scanned: RawCandidateRow,
  outcome: CandidateOutcome,
  nowIso: string,
): ApplyOffentligKlinikkOutcome {
  const current = db
    .prepare(
      `SELECT hjemmeside, catalog_class, offentlig_klinikk_korrigering_attempted_at, field_provenance
         FROM dental_agents WHERE id = ?`,
    )
    .get(scanned.id) as
    | {
        hjemmeside: string | null;
        catalog_class: string | null;
        offentlig_klinikk_korrigering_attempted_at: string | null;
        field_provenance: string | null;
      }
    | undefined;

  if (
    !current ||
    current.catalog_class !== "offentlig_klinikk" ||
    current.offentlig_klinikk_korrigering_attempted_at !== null ||
    current.hjemmeside !== scanned.hjemmeside
  ) {
    return { action: "skipped_stale" };
  }

  if (!outcome.found) {
    db.prepare(
      `UPDATE dental_agents SET offentlig_klinikk_korrigering_attempted_at = ? WHERE id = ?`,
    ).run(nowIso, scanned.id);
    return { action: "kept_no_candidate", reason: outcome.reason };
  }

  const sourceType: OffentligKlinikkHjemmesideProvenanceEntry["source_type"] =
    outcome.queue_reason === "navnesok_fallback" ? "search_verified_website" : "brreg_registered_website";
  const mergedProvenance = mergeOffentligKlinikkKorrigeringProvenance(
    current.field_provenance,
    {
      moved_reason: "offentlig_klinikk_korrigering",
      previous_field: "hjemmeside",
      moved_at: nowIso,
    },
    {
      source_type: sourceType,
      value: outcome.candidate_url,
      source_url: outcome.final_url,
      replaced_offentlig_klinikk_host: scanned.hjemmeside,
      fetched_at: nowIso,
    },
  );

  db.prepare(
    `UPDATE dental_agents
        SET directory_url = ?, hjemmeside = ?, field_provenance = ?,
            offentlig_klinikk_korrigering_attempted_at = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(scanned.hjemmeside, outcome.candidate_url, mergedProvenance, nowIso, scanned.id);

  return { action: "replaced", old_hjemmeside: scanned.hjemmeside, new_hjemmeside: outcome.candidate_url };
}

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { dry_run?: unknown; offset?: unknown; limit?: unknown };
  // STRICT-FALSE parse — identical convention to every other admin sweep in
  // this codebase: writes execute ONLY on the literal JSON boolean false.
  const dryRun = body.dry_run !== false;
  const offset = parseSweepOffset(body.offset);
  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.min(Math.floor(body.limit), OFFENTLIG_KLINIKK_KORRIGERING_BATCH_CAP)
      : OFFENTLIG_KLINIKK_KORRIGERING_BATCH_CAP;

  try {
    const db = getDb("dental");
    const trueCandidates = findTrueCandidates(db);
    const batch = trueCandidates.slice(offset, offset + limit);
    const lastPage = offset + batch.length >= trueCandidates.length;
    const searchImpl = effectiveDentalWdSearchImpl();

    if (dryRun) {
      const wouldReplace: Array<{ id: string; navn: string; old_hjemmeside: string; new_hjemmeside: string }> = [];
      const noCandidateFound: Array<{ id: string; navn: string; hjemmeside: string; reason: SkipReason }> = [];
      const reasonBreakdown: Record<SkipReason, number> = {
        no_brreg_website: 0,
        aggregator_host: 0,
        fetch_failed: 0,
        insufficient_evidence: 0,
      };

      for (const row of batch) {
        const outcome = await discoverForCandidate(row, searchImpl);
        if (outcome.found) {
          wouldReplace.push({
            id: row.id,
            navn: row.navn,
            old_hjemmeside: row.hjemmeside,
            new_hjemmeside: outcome.candidate_url,
          });
        } else {
          noCandidateFound.push({ id: row.id, navn: row.navn, hjemmeside: row.hjemmeside, reason: outcome.reason });
          reasonBreakdown[outcome.reason]++;
        }
      }

      res.json({
        success: true,
        dry_run: true,
        scanned: batch.length,
        would_replace_count: wouldReplace.length,
        would_replace: wouldReplace,
        kept_no_candidate_count: noCandidateFound.length,
        kept_no_candidate: noCandidateFound,
        reason_breakdown: reasonBreakdown,
        // Dry-run makes ZERO writes. An apply of THIS exact batch would stamp
        // offentlig_klinikk_korrigering_attempted_at on every scanned row
        // (found or not — see applyOffentligKlinikkKorrigeringToRow's own
        // doc comment), removing all of them from the candidate set, so this
        // arithmetic prediction is exact.
        remaining_count: Math.max(0, trueCandidates.length - offset - batch.length),
        offset,
        next_offset: lastPage ? null : offset + batch.length,
      });
      return;
    }

    // Apply: re-verify + write each candidate's outcome immediately before
    // writing (applyOffentligKlinikkKorrigeringToRow) — a row that changed
    // (or was already processed by a concurrent call) since the scan above
    // is skipped, never clobbered.
    const replaced: Array<{ id: string; navn: string; old_hjemmeside: string; new_hjemmeside: string }> = [];
    const keptNoCandidate: Array<{ id: string; navn: string; hjemmeside: string; reason: SkipReason }> = [];
    let skippedStale = 0;
    const reasonBreakdown: Record<SkipReason, number> = {
      no_brreg_website: 0,
      aggregator_host: 0,
      fetch_failed: 0,
      insufficient_evidence: 0,
    };
    const nowIso = new Date().toISOString();

    for (const row of batch) {
      const outcome = await discoverForCandidate(row, searchImpl);
      // Each row's write is its own transaction — deliberately NOT one
      // transaction wrapping the whole batch loop, since discovery's network
      // calls happen BETWEEN the scan and this write and must never run
      // inside an open db.transaction() (mirrors this codebase's existing
      // "network I/O never inside a transaction" convention).
      const applyResult = db.transaction(() =>
        applyOffentligKlinikkKorrigeringToRow(db, row, outcome, nowIso),
      )();

      if (applyResult.action === "replaced") {
        replaced.push({
          id: row.id,
          navn: row.navn,
          old_hjemmeside: applyResult.old_hjemmeside,
          new_hjemmeside: applyResult.new_hjemmeside,
        });
      } else if (applyResult.action === "kept_no_candidate") {
        keptNoCandidate.push({ id: row.id, navn: row.navn, hjemmeside: row.hjemmeside, reason: applyResult.reason });
        reasonBreakdown[applyResult.reason]++;
      } else {
        skippedStale++;
      }
    }

    // Apply DOES write, so remaining_count is the TRUE current candidate
    // count, re-queried from the DB after every row's write (both `replaced`
    // and `kept_no_candidate` rows leave the underlying attempted_at-IS-NULL
    // predicate; `skipped_stale` rows do not, by design).
    const remainingCount = findTrueCandidates(db).length;

    res.json({
      success: true,
      dry_run: false,
      scanned: batch.length,
      replaced_count: replaced.length,
      replaced,
      kept_no_candidate_count: keptNoCandidate.length,
      kept_no_candidate: keptNoCandidate,
      skipped_stale_count: skippedStale,
      reason_breakdown: reasonBreakdown,
      remaining_count: remainingCount,
      offset,
      next_offset: lastPage
        ? null
        : Math.max(0, offset + batch.length - (replaced.length + keptNoCandidate.length)),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Offentlig-klinikk hjemmeside-korrigering failed", detail: err?.message ?? String(err) });
  }
});

export default router;
