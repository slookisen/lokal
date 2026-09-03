// ─── Admin: POST /admin/agents/internal-note-sweep ─────────────────────────
//
// Daniel 2026-09-03: «Interne notater skal ikke vises.»
//
// Cleanup lever for EXISTING rows where an enrichment routine wrote its own
// verification-status note into customer-facing prose — `agents.description`
// or `agent_knowledge.about`. The English translation run that day read every
// RFB prose field word for word and surfaced the class; see the internal-note
// section of services/description-quality.ts for the live examples and the
// sentence-level detector (hasInternalNote / stripInternalNotes) this route
// is built on. The write-time half of the fix — refusing such text at every
// description/about door — lives in admin-knowledge.ts and marketplace.ts.
//
// Modeled PRECISELY on admin-agents-description-code-artifact-sweep.ts (the
// same full-catalog scan, dry-run/apply, owner-lock + curated_fields-lock
// re-read FRESH inside each row's own transaction, one agent_knowledge_audit
// row per change carrying the OLD value, per-row transaction so one failure
// never aborts the batch, enrichment-write-pause gate on the union of both
// batches, per-call cap). Copied, not reinvented.
//
// ── The ONE deliberate difference from that sibling: the VALUE RULE ──────
// The code-artifact sweep blanks the field, because a scraped JS blob has no
// prose worth keeping. An internal note is different: on several live rows
// it is APPENDED to real producer prose ("… Orgnr 933084353. NB: nettside
// midlertidig utilgjengelig — kontakt bør bekreftes av verifier."), and
// blanking would throw the producer's own words away. So the cleaned value
// is stripInternalNotes(old) — the note goes, the prose stays. Only when the
// value was NOTHING but a note does that collapse to the sibling's rule:
// `''` for description (TEXT NOT NULL), SQL NULL for about (nullable).
// The response therefore carries a new_value_preview alongside the old one.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { hasInternalNote, stripInternalNotes } from "../services/description-quality";
import {
  enrichmentWritePauseBlockForAgents,
  ENRICHMENT_WRITE_PAUSE_HTTP_STATUS,
} from "../services/enrichment-write-pause";

const router = Router();

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

/** Hard cap per call — same as the code-artifact sibling. */
export const INTERNAL_NOTE_SWEEP_MAX_ITEMS = 200;

/** DB seam for tests — same rationale as the sibling's own. */
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setInternalNoteSweepDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

/** Truncated preview only — the full old value lives in the audit row. */
function previewValue(s: string | null | undefined, maxLen = 80): string {
  const v = s ?? "";
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen) + "…";
}

type ItemOutcome =
  | "would_write"
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "not_found"
  | "error";

interface ResultItem {
  agent_id: string;
  name: string;
  outcome: ItemOutcome;
  old_value_preview?: string;
  new_value_preview?: string;
  detail?: string;
}

interface CandidateRow {
  id: string;
  name: string;
  description: string;
}

interface AboutCandidateRow {
  id: string;
  name: string;
  about: string | null;
}

interface LockSnapshot {
  claimed_at: string | null;
  description: string;
  about: string | null;
  curated_fields: string | null;
  verified_claims: number;
}

const LOCK_SNAPSHOT_SQL = `
  SELECT a.claimed_at   AS claimed_at,
         a.description  AS description,
         k.about        AS about,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

/** Owner lock: claimed_at OR a verified agent_claims row (both sources). */
function isOwnerLocked(s: { claimed_at: string | null; verified_claims: number }): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: "description" | "about"): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

/** Clean ONE agent's description — fresh lock re-read inside its own tx. */
function applyDescriptionSweep(
  agentId: string,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; oldValue?: string; newValue?: string; detail?: string } {
  const db = db_();
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; oldValue?: string; newValue?: string; detail?: string } => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(agentId) as LockSnapshot | undefined;
      if (!cur) return { outcome: "not_found" };
      if (isOwnerLocked(cur)) return { outcome: "skipped_claimed", oldValue: cur.description };
      if (isFieldCurated(cur.curated_fields, "description")) return { outcome: "skipped_curated", oldValue: cur.description };
      // Re-check against the FRESH value — never clobber a row a concurrent
      // writer already cleaned between scan and write.
      if (!hasInternalNote(cur.description)) return { outcome: "skipped_unchanged", oldValue: cur.description };

      const cleaned = stripInternalNotes(cur.description); // '' when note-only (NOT NULL column)
      db.prepare(`UPDATE agents SET description = ? WHERE id = ?`).run(cleaned, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'description', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.description, cleaned, `${batchTag}: ${reason}`);
      return { outcome: "written", oldValue: cur.description, newValue: cleaned };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

/** Clean ONE agent's about — same discipline; nullable column, so note-only → NULL. */
function applyAboutSweep(
  agentId: string,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; oldValue?: string | null; newValue?: string | null; detail?: string } {
  const db = db_();
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; oldValue?: string | null; newValue?: string | null; detail?: string } => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(agentId) as LockSnapshot | undefined;
      if (!cur) return { outcome: "not_found" };
      if (isOwnerLocked(cur)) return { outcome: "skipped_claimed", oldValue: cur.about };
      if (isFieldCurated(cur.curated_fields, "about")) return { outcome: "skipped_curated", oldValue: cur.about };
      if (!hasInternalNote(cur.about)) return { outcome: "skipped_unchanged", oldValue: cur.about };

      const stripped = stripInternalNotes(cur.about);
      const cleaned: string | null = stripped === "" ? null : stripped;
      db.prepare(`UPDATE agent_knowledge SET about = ? WHERE agent_id = ?`).run(cleaned, agentId);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'about', ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), agentId, cur.about, cleaned, `${batchTag}: ${reason}`);
      return { outcome: "written", oldValue: cur.about, newValue: cleaned };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const db = db_();

  // Full-catalog scan, both columns — read-only; the write set is what the
  // pause gate below needs to know, so the scan comes first (same structural
  // reason as the sibling).
  const allRows = db.prepare(`SELECT id, name, description FROM agents ORDER BY id ASC`).all() as CandidateRow[];
  const scanned = allRows.length;
  const candidates = allRows.filter((r) => hasInternalNote(r.description));
  const candidatesConsidered = candidates.length;
  const batch = candidates.slice(0, INTERNAL_NOTE_SWEEP_MAX_ITEMS);

  const allAboutRows = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, k.about AS about
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        ORDER BY a.id ASC`,
    )
    .all() as AboutCandidateRow[];
  const aboutScanned = allAboutRows.length;
  const aboutCandidates = allAboutRows.filter((r) => hasInternalNote(r.about));
  const aboutCandidatesConsidered = aboutCandidates.length;
  const aboutBatch = aboutCandidates.slice(0, INTERNAL_NOTE_SWEEP_MAX_ITEMS);

  // Enrichment write-pause gate — fails CLOSED, blocks the WHOLE request,
  // runs regardless of dry-run (same as the sibling).
  {
    const pauseBlock = enrichmentWritePauseBlockForAgents(db_, [
      ...batch.map((c) => c.id),
      ...aboutBatch.map((c) => c.id),
    ]);
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const body = (req.body ?? {}) as { apply?: unknown; reason?: unknown };
  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "internal-note-sweep";
  const batchTag = `internal-note-sweep-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const results: ResultItem[] = [];
  for (const c of batch) {
    if (dryRun) {
      results.push({
        agent_id: c.id,
        name: c.name,
        outcome: "would_write",
        old_value_preview: previewValue(c.description),
        new_value_preview: previewValue(stripInternalNotes(c.description)),
      });
    } else {
      const w = applyDescriptionSweep(c.id, reason, batchTag);
      results.push({
        agent_id: c.id,
        name: c.name,
        outcome: w.outcome,
        old_value_preview: previewValue(w.oldValue ?? c.description),
        ...(w.newValue !== undefined ? { new_value_preview: previewValue(w.newValue) } : {}),
        ...(w.detail ? { detail: w.detail } : {}),
      });
    }
  }
  const counts = results.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {});

  const aboutResults: ResultItem[] = [];
  for (const c of aboutBatch) {
    if (dryRun) {
      aboutResults.push({
        agent_id: c.id,
        name: c.name,
        outcome: "would_write",
        old_value_preview: previewValue(c.about),
        new_value_preview: previewValue(stripInternalNotes(c.about)),
      });
    } else {
      const w = applyAboutSweep(c.id, reason, batchTag);
      aboutResults.push({
        agent_id: c.id,
        name: c.name,
        outcome: w.outcome,
        old_value_preview: previewValue(w.oldValue ?? c.about),
        ...(w.newValue !== undefined ? { new_value_preview: previewValue(w.newValue) } : {}),
        ...(w.detail ? { detail: w.detail } : {}),
      });
    }
  }
  const aboutCounts = aboutResults.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned,
    candidates_considered: candidatesConsidered,
    batch_size: batch.length,
    counts,
    results,
    about_scanned: aboutScanned,
    about_candidates_considered: aboutCandidatesConsidered,
    about_batch_size: aboutBatch.length,
    about_counts: aboutCounts,
    about_results: aboutResults,
  });
});

export default router;
