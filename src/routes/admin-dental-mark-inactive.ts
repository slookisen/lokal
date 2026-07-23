// ─── POST /admin/dental/mark-inactive ───────────────────────────────────────
// dev-request 2026-07-16-dental-hjemmeside-url-vask, item 2 (nedlagt-flagging).
//
// WHY: there is no live fylkeskommune "-stengt" page scraper/detector today
// (separate future follow-up) -- confirmed-closed clinics are gathered
// manually via research and applied here BY EXPLICIT ID (not a table sweep):
// the caller supplies the exact `id`s to flag, unlike every other admin sweep
// in this codebase (admin-dental-hjemmeside-cleanup.ts, admin-domain-
// coherence.ts, ...) which scan a candidate query. Marking is PERMANENT and
// additive -- nothing is deleted, is_inactive/inactive_reason/inactive_since
// (see init-dental.ts) are set and the row is thereafter excluded from every
// public search/stats path (src/services/dental-store.ts) and the enrichment
// claim-batch pool (src/services/dental-claim-service.ts), unconditionally,
// mirroring the existing verification_status='rejected' exclusion precedent.
//
// dry_run (STRICT-FALSE parse, same convention as every other admin sweep in
// this codebase, e.g. admin-dental-hjemmeside-cleanup.ts): body.dry_run !==
// false -- only the literal JSON boolean `false` triggers a real write;
// null/"false"/0/""/undefined all mean dry-run.
//
// Idempotent per-row: a row already is_inactive=1 is reported as
// "already_inactive" and is NEVER re-written -- the original
// inactive_reason/inactive_since are preserved verbatim on a repeat call, so
// re-running the same batch (e.g. after a partial failure) is always safe.
//
// Hard per-call cap: entries.length > 100 -> 400. This endpoint operates on
// caller-supplied ids, not a table sweep, so there is no "backlog" concept
// (contrast HJEMMESIDE_CLEANUP_BATCH_CAP, which caps a candidate SCAN) --
// the cap here simply bounds a single request's payload size.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route file in this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";

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

// Hard per-call cap on how many entries may be submitted in a single POST --
// this endpoint operates on caller-supplied ids (no candidate sweep), so the
// cap simply bounds request-payload size, not a backlog.
export const MARK_INACTIVE_ENTRIES_CAP = 100;

export interface MarkInactiveEntry {
  id: string;
  reason: string;
}

// Parse dental_agents.field_provenance (JSON string, possibly null/malformed)
// into a plain object -- malformed/non-object/array JSON is treated as empty
// so a corrupted existing blob never blocks a mark-inactive write (mirrors
// parseFieldProvenance in admin-dental-hjemmeside-cleanup.ts /
// admin-domain-coherence.ts).
function parseFieldProvenance(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface InactiveProvenanceEntry {
  reason: string;
  marked_inactive_at: string;
}

/**
 * Merges a single "inactive" provenance entry into an existing
 * field_provenance blob, preserving every OTHER field's provenance
 * untouched -- only the "inactive" key is set/overwritten. Pure -- exported
 * for unit-testing.
 */
export function mergeInactiveProvenance(
  existingRaw: string | null | undefined,
  entry: InactiveProvenanceEntry,
): string {
  const existing = parseFieldProvenance(existingRaw);
  return JSON.stringify({ ...existing, inactive: entry });
}

interface AgentRow {
  id: string;
  navn: string;
  is_inactive: number | null;
  inactive_reason: string | null;
  inactive_since: string | null;
  field_provenance: string | null;
}

type EntryResult =
  | { id: string; status: "not_found" }
  | { id: string; status: "already_inactive"; inactive_reason: string | null; inactive_since: string | null }
  | { id: string; navn: string; status: "would_mark"; reason: string }
  | { id: string; navn: string; status: "marked_inactive"; reason: string };

const router = Router();

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { dry_run?: unknown; entries?: unknown };

  // Validate entries: must be a non-empty array; each entry needs a
  // non-empty string `id` and non-empty string `reason`.
  if (!Array.isArray(body.entries) || body.entries.length === 0) {
    res.status(400).json({ error: "entries must be a non-empty array" });
    return;
  }
  if (body.entries.length > MARK_INACTIVE_ENTRIES_CAP) {
    res.status(400).json({
      error: `entries exceeds the max of ${MARK_INACTIVE_ENTRIES_CAP} per call`,
    });
    return;
  }
  const entries: MarkInactiveEntry[] = [];
  for (const raw of body.entries) {
    const e = raw as Record<string, unknown>;
    const id = typeof e?.id === "string" ? e.id.trim() : "";
    const reason = typeof e?.reason === "string" ? e.reason.trim() : "";
    if (!id || !reason) {
      res.status(400).json({ error: "each entry requires a non-empty string id and reason" });
      return;
    }
    entries.push({ id, reason });
  }

  // STRICT-FALSE parse -- identical convention to every other admin sweep in
  // this codebase (admin-dental-hjemmeside-cleanup.ts, ...): writes execute
  // ONLY on the literal JSON boolean false.
  const dryRun = body.dry_run !== false;

  try {
    const db = getDb("dental");
    const getRow = db.prepare(
      "SELECT id, navn, is_inactive, inactive_reason, inactive_since, field_provenance FROM dental_agents WHERE id = ?",
    );

    const results: EntryResult[] = [];
    const nowIso = new Date().toISOString();

    const run = () => {
      for (const entry of entries) {
        const row = getRow.get(entry.id) as AgentRow | undefined;
        if (!row) {
          results.push({ id: entry.id, status: "not_found" });
          continue;
        }
        if (row.is_inactive === 1) {
          // Idempotent no-op -- never overwrite an existing reason/timestamp.
          results.push({
            id: entry.id,
            status: "already_inactive",
            inactive_reason: row.inactive_reason,
            inactive_since: row.inactive_since,
          });
          continue;
        }
        if (dryRun) {
          results.push({ id: entry.id, navn: row.navn, status: "would_mark", reason: entry.reason });
          continue;
        }
        const mergedProvenance = mergeInactiveProvenance(row.field_provenance, {
          reason: entry.reason,
          marked_inactive_at: nowIso,
        });
        db.prepare(
          `UPDATE dental_agents
              SET is_inactive = 1, inactive_reason = ?, inactive_since = ?,
                  field_provenance = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(entry.reason, nowIso, mergedProvenance, entry.id);
        results.push({ id: entry.id, navn: row.navn, status: "marked_inactive", reason: entry.reason });
      }
    };

    if (dryRun) {
      run();
    } else {
      const tx = db.transaction(run);
      tx();
    }

    res.json({
      success: true,
      dry_run: dryRun,
      requested: entries.length,
      results,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Mark-inactive failed", detail: err?.message ?? String(err) });
  }
});

export default router;
