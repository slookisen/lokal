// ─── Admin: POST /admin/agents/content-correction ──────────────────────────
//
// Daniel 2026-09-03: «fiks den byttede teksten på Epleblomsten og Nordlysmat.»
//
// The English translation run that day had three independent reviewers each
// find half of the same defect without knowing of each other: `Epleblomsten
// — Telemark` (Sauherad) carried Nordlysmat's Finnmark herbs-and-berries
// text, and `Nordlysmat Drift AS` (Alta) carried Epleblomsten's Midt-Telemark
// cider text — the two descriptions were swapped. Confirmed live in
// production the same afternoon. Two more wrong-entity rows were found in the
// same run (Nordlandtiroler, Romstad Gård).
//
// ── Why a new route instead of PUT /admin/knowledge ─────────────────────
// There was NO honest write path for a human-established content correction:
//   - PUT /admin/knowledge is the automated-enrichment door. Overwriting a
//     populated description there goes through canCorrectFactualField, which
//     is built to weigh SOURCE PROVENANCE (homepage vs google_places, Tier-A
//     counts) — a correction a person has established by reading both rows
//     has no such provenance, and the only way through would have been to
//     fabricate some. That is exactly the kind of quiet misrepresentation
//     the provenance system exists to prevent.
//   - curated_fields is only ever set by the producer in the owner portal.
// So this route IS that path: an explicit, per-row, reason-carrying,
// audited correction. It never scans or infers anything — every target row
// and every new value is named by the caller, and the reason is mandatory
// and lands in the audit row, where a later reader can see WHO decided WHAT
// and WHY. changed_by is 'admin' (a person directed this), not 'system'.
//
// Write discipline is copied from admin-agents-url-write.ts / the
// code-artifact sweep: dry-run by default; owner-lock (claimed_at OR a
// verified agent_claims row) and curated_fields-lock re-read FRESH inside
// each row's own transaction; per-row transaction so one failure never
// aborts the batch; enrichment-write-pause gate on the caller's id set,
// before the dry-run branch, fails CLOSED. The incoming text passes the
// same two content gates as every other description/about door
// (looksLikeCodeArtifact, hasInternalNote) — a correction must never be the
// way junk gets back in.
//
// Body: { apply?: boolean, reason: string,
//         items: [{ agent_id, field: "description"|"about", text }] }
// Max 50 items per call — this is a targeted lever, not a sweep.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { hasInternalNote, looksLikeCodeArtifact } from "../services/description-quality";
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

export const CONTENT_CORRECTION_MAX_ITEMS = 50;
export const CONTENT_CORRECTION_MAX_TEXT = 8000;

let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
export function __setContentCorrectionDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function db_(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

function previewValue(s: string | null | undefined, maxLen = 80): string {
  const v = s ?? "";
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen) + "…";
}

type Field = "description" | "about";

type ItemOutcome =
  | "would_write"
  | "written"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "refused_junk_text"
  | "invalid_item"
  | "not_found"
  | "error";

interface ResultItem {
  agent_id: string;
  field?: Field;
  name?: string;
  outcome: ItemOutcome;
  old_value_preview?: string;
  new_value_preview?: string;
  detail?: string;
}

interface LockSnapshot {
  name: string;
  claimed_at: string | null;
  description: string;
  about: string | null;
  curated_fields: string | null;
  verified_claims: number;
  has_knowledge_row: number;
}

const LOCK_SNAPSHOT_SQL = `
  SELECT a.name         AS name,
         a.claimed_at   AS claimed_at,
         a.description  AS description,
         k.about        AS about,
         k.curated_fields AS curated_fields,
         (SELECT COUNT(*) FROM agent_claims c
           WHERE c.agent_id = a.id AND c.status = 'verified') AS verified_claims,
         (k.agent_id IS NOT NULL) AS has_knowledge_row
    FROM agents a
    LEFT JOIN agent_knowledge k ON k.agent_id = a.id
   WHERE a.id = ?`;

function isOwnerLocked(s: { claimed_at: string | null; verified_claims: number }): boolean {
  return !!s.claimed_at || (s.verified_claims ?? 0) > 0;
}

function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: Field): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

interface ValidItem {
  agent_id: string;
  field: Field;
  text: string;
}

/** Shape + content validation of one caller-supplied item. */
function validateItem(raw: unknown): { ok: true; item: ValidItem } | { ok: false; outcome: ItemOutcome; detail: string; agent_id: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const agentId = typeof r.agent_id === "string" ? r.agent_id.trim() : "";
  if (!agentId) return { ok: false, outcome: "invalid_item", detail: "agent_id required", agent_id: "" };
  const field = r.field === "description" || r.field === "about" ? (r.field as Field) : null;
  if (!field) return { ok: false, outcome: "invalid_item", detail: "field must be description|about", agent_id: agentId };
  const text = typeof r.text === "string" ? r.text.trim() : "";
  if (!text) return { ok: false, outcome: "invalid_item", detail: "text required (non-empty)", agent_id: agentId };
  if (text.length > CONTENT_CORRECTION_MAX_TEXT) {
    return { ok: false, outcome: "invalid_item", detail: `text exceeds ${CONTENT_CORRECTION_MAX_TEXT} chars`, agent_id: agentId };
  }
  // A correction is never the way junk gets back in — same two gates as
  // every other description/about door.
  if (looksLikeCodeArtifact(text)) return { ok: false, outcome: "refused_junk_text", detail: "text looks like a code artifact", agent_id: agentId };
  if (hasInternalNote(text)) return { ok: false, outcome: "refused_junk_text", detail: "text contains an internal pipeline note", agent_id: agentId };
  return { ok: true, item: { agent_id: agentId, field, text } };
}

/** Read-only lock/state check — shared by dry-run and the apply re-check. */
function classify(cur: LockSnapshot | undefined, item: ValidItem): { outcome: ItemOutcome; oldValue?: string | null } {
  if (!cur) return { outcome: "not_found" };
  const oldValue = item.field === "description" ? cur.description : cur.about;
  if (isOwnerLocked(cur)) return { outcome: "skipped_claimed", oldValue };
  if (isFieldCurated(cur.curated_fields, item.field)) return { outcome: "skipped_curated", oldValue };
  if ((oldValue ?? "") === item.text) return { outcome: "skipped_unchanged", oldValue };
  return { outcome: "would_write", oldValue };
}

/** Write ONE correction — fresh lock re-read inside its own transaction. */
function applyCorrection(
  item: ValidItem,
  reason: string,
  batchTag: string,
): { outcome: ItemOutcome; name?: string; oldValue?: string | null; detail?: string } {
  const db = db_();
  try {
    const tx = db.transaction((): { outcome: ItemOutcome; name?: string; oldValue?: string | null; detail?: string } => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(item.agent_id) as LockSnapshot | undefined;
      const c = classify(cur, item);
      if (c.outcome !== "would_write") return { outcome: c.outcome, name: cur?.name, oldValue: c.oldValue };

      const nowIso = new Date().toISOString();
      if (item.field === "description") {
        db.prepare(`UPDATE agents SET description = ? WHERE id = ?`).run(item.text, item.agent_id);
      } else if (cur!.has_knowledge_row) {
        db.prepare(`UPDATE agent_knowledge SET about = ?, updated_at = ? WHERE agent_id = ?`).run(item.text, nowIso, item.agent_id);
      } else {
        db.prepare(`INSERT INTO agent_knowledge (agent_id, about, updated_at) VALUES (?, ?, ?)`).run(item.agent_id, item.text, nowIso);
      }
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, 'admin', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), item.agent_id, item.field, c.oldValue ?? null, item.text, `${batchTag}: ${reason}`);
      return { outcome: "written", name: cur!.name, oldValue: c.oldValue };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { apply?: unknown; reason?: unknown; items?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "reason required — every correction must say why (it lands in the audit row)" });
    return;
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    res.status(400).json({ error: "items[] required" });
    return;
  }
  if (body.items.length > CONTENT_CORRECTION_MAX_ITEMS) {
    res.status(400).json({ error: `max ${CONTENT_CORRECTION_MAX_ITEMS} items per call` });
    return;
  }

  const results: ResultItem[] = [];
  const valid: ValidItem[] = [];
  for (const raw of body.items) {
    const v = validateItem(raw);
    if (v.ok) valid.push(v.item);
    else results.push({ agent_id: v.agent_id, outcome: v.outcome, detail: v.detail });
  }

  // Enrichment write-pause gate — on the caller's id set, before dry-run,
  // fails CLOSED and blocks the WHOLE request (same as the siblings).
  {
    const pauseBlock = enrichmentWritePauseBlockForAgents(db_, valid.map((i) => i.agent_id));
    if (pauseBlock) {
      res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
      return;
    }
  }

  const apply =
    body.apply === true || body.apply === 1 || body.apply === "1" || body.apply === "true" ||
    req.query?.apply === "1" || req.query?.apply === "true";
  const dryRun = !apply;
  const batchTag = `content-correction-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;

  const db = db_();
  for (const item of valid) {
    if (dryRun) {
      // Dry-run reports the lock state too, so the caller sees what WOULD be
      // refused before spending an apply on it.
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(item.agent_id) as LockSnapshot | undefined;
      const c = classify(cur, item);
      results.push({
        agent_id: item.agent_id,
        field: item.field,
        name: cur?.name,
        outcome: c.outcome,
        old_value_preview: previewValue(c.oldValue),
        new_value_preview: previewValue(item.text),
      });
    } else {
      const w = applyCorrection(item, reason, batchTag);
      results.push({
        agent_id: item.agent_id,
        field: item.field,
        name: w.name,
        outcome: w.outcome,
        old_value_preview: previewValue(w.oldValue),
        new_value_preview: previewValue(item.text),
        ...(w.detail ? { detail: w.detail } : {}),
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {});
  res.json({ success: true, dry_run: dryRun, batch_tag: batchTag, reason, counts, results });
});

export default router;
