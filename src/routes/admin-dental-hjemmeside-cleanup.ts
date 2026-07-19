// ─── POST /admin/dental/hjemmeside-cleanup-sweep ────────────────────────────
// dev-request 2026-07-18-dental-hjemmeside-directory-portal-cleanup.
//
// WHY: dental_agents.hjemmeside is meant to be a clinic's OWN homepage, but
// many rows actually carry a directory-listing site, a booking portal, or an
// industry-association URL (legelisten.no, tannlegerinorge.no, ...) instead
// — see src/services/dental-hjemmeside-classifier.ts for the classification
// logic and its own doc comment for the full background (46% enrichment hit
// rate on dirty URLs vs 83% on real clinic homepages). This endpoint is the
// (repeatable) sweep that moves those bad values OUT of hjemmeside and INTO
// the additive directory_url column (see init-dental.ts) — additive and
// reversible: nothing is deleted, hjemmeside is simply cleared so it stops
// polluting enrichment, and the original value + why it was moved is
// preserved both in directory_url and in field_provenance.
//
// Candidate set: dental_agents rows with hjemmeside IS NOT NULL AND
// directory_url IS NULL (a row this sweep already cleaned is never
// re-scanned — directory_url IS NULL doubles as the "not yet cleaned"
// marker), ordered created_at ASC, id ASC for a deterministic, oldest-first
// batch.
//
// Hard batch cap: HJEMMESIDE_CLEANUP_BATCH_CAP rows per call — mirrors
// BRREG_SWEEP_BATCH_CAP (admin-agents.ts) / the description-truncation-sweep
// convention (admin-knowledge.ts): this endpoint never walks the full
// backlog synchronously in one request, and reports remaining_count so a
// caller knows there's more.
//
// dry_run (STRICT-FALSE parse, same convention as every other admin sweep
// in this codebase): body.dry_run !== false — only the literal JSON boolean
// `false` triggers a real write; null/"false"/0/""/undefined all mean
// dry-run.
//
// Apply path: for each row classified bad by the scan above, RE-FETCH the
// row's CURRENT hjemmeside/directory_url immediately before writing
// (re-verify pattern from admin-domain-coherence.ts's auto_fixable apply
// loop) — if hjemmeside changed since the scan, or directory_url is no
// longer NULL (already cleaned by a concurrent call), the row is skipped
// rather than clobbered. Otherwise, in one UPDATE: copy hjemmeside ->
// directory_url, set hjemmeside = NULL, and merge a provenance entry for the
// "hjemmeside" field into field_provenance (parsing whatever's already
// there so every OTHER field's provenance survives untouched). A row the
// classifier does NOT flag is never touched by this endpoint, dry-run or
// apply.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route file in this codebase).
//
// Non-goals (do not extend this endpoint to cover these — separate future
// slices per the dev-request): no nedlagt/closed-clinic flagging, no Brreg
// homepage re-discovery, no retry-list for proxy-blocked domains, no live
// URL fetching, no changes to enrichment scoring/queueing logic.

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import { classifyHjemmeside } from "../services/dental-hjemmeside-classifier";

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

// Hard per-call cap on how many candidate rows are scanned/(potentially)
// cleaned in a single POST — mirrors BRREG_SWEEP_BATCH_CAP (admin-agents.ts):
// never walk the whole backlog synchronously in one request.
export const HJEMMESIDE_CLEANUP_BATCH_CAP = 200;

// Dry-run/apply response arrays are capped to a smaller sample than the scan
// batch itself — mirrors TRUNCATION_SWEEP_RESPONSE_CAP's "counts are exact,
// listed rows are capped" convention (admin-knowledge.ts).
export const HJEMMESIDE_CLEANUP_SAMPLE_CAP = 50;

interface CandidateRow {
  id: string;
  navn: string;
  hjemmeside: string;
  field_provenance: string | null;
}

// Shared WHERE clause for both the count and the capped batch query, so the
// two can never drift out of sync with each other.
function candidateWhereSql(): string {
  return "hjemmeside IS NOT NULL AND directory_url IS NULL";
}

function countCandidates(db: ReturnType<typeof getDb>): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${candidateWhereSql()}`)
    .get() as { n: number };
  return row?.n ?? 0;
}

// Deterministic, oldest-registered-first ordering (created_at, then id as a
// tiebreaker) — a hard LIMIT means only up to HJEMMESIDE_CLEANUP_BATCH_CAP
// rows are ever scanned/cleaned per invocation.
function fetchCandidateBatch(db: ReturnType<typeof getDb>, cap: number): CandidateRow[] {
  return db
    .prepare(
      `SELECT id, navn, hjemmeside, field_provenance FROM dental_agents
       WHERE ${candidateWhereSql()}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(cap) as CandidateRow[];
}

// Parse dental_agents.field_provenance (JSON string, possibly null/malformed)
// into a plain object — malformed/non-object/array JSON is treated as empty
// so a corrupted existing blob never blocks a cleanup write (mirrors
// parseFieldProvenance in admin-domain-coherence.ts).
function parseFieldProvenance(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface HjemmesideProvenanceEntry {
  cleaned_reason: string;
  previous_value: string;
  cleaned_at: string;
}

/**
 * Merges a single hjemmeside-cleanup provenance entry into an existing
 * field_provenance blob, preserving every OTHER field's provenance
 * untouched — only the "hjemmeside" key is set/overwritten. Pure — exported
 * for unit-testing.
 */
export function mergeHjemmesideCleanupProvenance(
  existingRaw: string | null | undefined,
  entry: HjemmesideProvenanceEntry,
): string {
  const existing = parseFieldProvenance(existingRaw);
  return JSON.stringify({ ...existing, hjemmeside: entry });
}

export interface FlaggedRow {
  id: string;
  navn: string;
  hjemmeside: string;
  reason: "directory" | "business_site" | "parked";
}

// Classifies every row in a batch, keeping only the ones the classifier
// flags as bad. Pure — exported for unit-testing / reuse by the dry-run and
// apply paths so both always agree on the candidate set.
export function classifyCandidateBatch(rows: CandidateRow[]): FlaggedRow[] {
  const flagged: FlaggedRow[] = [];
  for (const row of rows) {
    const result = classifyHjemmeside(row.hjemmeside);
    if (result.isBad && result.reason) {
      flagged.push({ id: row.id, navn: row.navn, hjemmeside: row.hjemmeside, reason: result.reason });
    }
  }
  return flagged;
}

export interface ApplyCleanupOutcome {
  applied: boolean;
  previous_hjemmeside?: string;
  reason?: "directory" | "business_site" | "parked";
}

// Re-fetches a single row's CURRENT hjemmeside/directory_url/field_provenance
// and, ONLY if it's still exactly the row this `flag` was computed from (same
// hjemmeside value, still un-cleaned) AND still classifies as bad on that
// fresh read, writes the cleanup in one UPDATE. Otherwise it's a no-op skip
// — this is the re-verify-immediately-before-writing guard (mirrors
// admin-domain-coherence.ts's auto_fixable apply loop) that stops a row
// whose hjemmeside changed (or that another call already cleaned) between an
// earlier scan and this write from being clobbered. Exported standalone so
// the "changed since the scan" skip path can be unit-tested directly,
// without needing an actual concurrent request (this handler has no `await`
// in its own request-body scan-then-write path, so that race can't be
// reproduced through two ordinary sequential HTTP calls alone).
export function applyHjemmesideCleanupToRow(
  db: ReturnType<typeof getDb>,
  flag: FlaggedRow,
  nowIso: string,
): ApplyCleanupOutcome {
  const current = db
    .prepare("SELECT hjemmeside, directory_url, field_provenance FROM dental_agents WHERE id = ?")
    .get(flag.id) as
    | { hjemmeside: string | null; directory_url: string | null; field_provenance: string | null }
    | undefined;
  if (!current) return { applied: false }; // row gone since the scan — skip
  if (current.directory_url !== null) return { applied: false }; // already cleaned by something else — skip
  if (current.hjemmeside !== flag.hjemmeside) return { applied: false }; // changed since the scan — never clobber

  // Re-verify against the CURRENT value, not the earlier scan read —
  // belt-and-braces alongside the equality check just above.
  const recheck = classifyHjemmeside(current.hjemmeside);
  if (!recheck.isBad || !recheck.reason) return { applied: false };

  const mergedProvenance = mergeHjemmesideCleanupProvenance(current.field_provenance, {
    cleaned_reason: recheck.reason,
    previous_value: current.hjemmeside,
    cleaned_at: nowIso,
  });
  db.prepare(
    `UPDATE dental_agents
        SET directory_url = ?, hjemmeside = NULL, field_provenance = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(current.hjemmeside, mergedProvenance, flag.id);

  return { applied: true, previous_hjemmeside: current.hjemmeside, reason: recheck.reason };
}

const router = Router();

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // STRICT-FALSE parse — identical convention to every other admin sweep in
  // this codebase (POST /admin/description-truncation-sweep,
  // /admin/agents/brreg-catalog-sweep, ...): writes execute ONLY on the
  // literal JSON boolean false.
  const body = (req.body ?? {}) as { dry_run?: unknown };
  const dryRun = body.dry_run !== false;

  try {
    const db = getDb("dental");
    const candidateCount = countCandidates(db);
    const batchRows = fetchCandidateBatch(db, HJEMMESIDE_CLEANUP_BATCH_CAP);
    const flagged = classifyCandidateBatch(batchRows);

    if (dryRun) {
      res.json({
        success: true,
        dry_run: true,
        scanned: batchRows.length,
        would_clean_count: flagged.length,
        would_clean: flagged.slice(0, HJEMMESIDE_CLEANUP_SAMPLE_CAP).map((r) => ({
          id: r.id,
          navn: r.navn,
          hjemmeside: r.hjemmeside,
          reason: r.reason,
        })),
        remaining_count: Math.max(0, candidateCount - batchRows.length),
      });
      return;
    }

    // Apply: re-fetch + re-verify each flagged row's CURRENT state
    // immediately before writing (see applyHjemmesideCleanupToRow) — a row
    // that changed (or was already cleaned by a concurrent call) since the
    // scan above is skipped, never clobbered.
    const cleaned: Array<{ id: string; navn: string; previous_hjemmeside: string; reason: string }> = [];
    const nowIso = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const flag of flagged) {
        const outcome = applyHjemmesideCleanupToRow(db, flag, nowIso);
        if (!outcome.applied || !outcome.previous_hjemmeside || !outcome.reason) continue;
        cleaned.push({
          id: flag.id,
          navn: flag.navn,
          previous_hjemmeside: outcome.previous_hjemmeside,
          reason: outcome.reason,
        });
      }
    });
    tx();

    res.json({
      success: true,
      dry_run: false,
      scanned: batchRows.length,
      would_clean_count: flagged.length,
      cleaned_count: cleaned.length,
      cleaned: cleaned.slice(0, HJEMMESIDE_CLEANUP_SAMPLE_CAP),
      remaining_count: Math.max(0, candidateCount - batchRows.length),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Hjemmeside cleanup sweep failed", detail: err?.message ?? String(err) });
  }
});

export default router;
