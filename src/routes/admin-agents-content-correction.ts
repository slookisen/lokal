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
// Body: { apply?: boolean, reason: string, items: [ItemSpec] }, ItemSpec one of
//   { agent_id, field: "description"|"about", text }
//   { agent_id, field: "product_name", old_name, text }  — renames the ONE
//       agent_knowledge.products entry whose name === old_name (0 or >1
//       matches -> invalid_item); every other product field kept. If `text`
//       already names another product: would_merge / merged — the entry with
//       more populated fields is kept (tie: the one already named `text`),
//       named `text`, the other dropped; reported in `merge` + audit notes.
//   { agent_id, field: "products_organic_flag" }  — organic=false on every
//       product with a truthy organic.
//   { agent_id, field: "specialties"|"certifications"|"tags", remove: string[] }
//       — removes exact-match elements (agent_knowledge.specialties /
//       .certifications, agents.tags); absent ones listed in
//       not_found_elements. Never adds.
// Same locks for all: owner lock -> skipped_claimed; curated_fields key
// (products / the list name) -> skipped_curated; nothing to change ->
// skipped_unchanged (no audit). One audit row per applied change, field_name
// = the stored column, full old/new JSON value. The `products` catalog table
// is NOT touched here: the catalog sync upserts the new name from
// agent_knowledge.products but never deletes the old-name catalog row.
// Max 50 items per call — this is a targeted lever, not a sweep.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { hasInternalNote, looksLikeCodeArtifact, looksLikeThemeSpam } from "../services/description-quality";
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

type TextField = "description" | "about";
type ListField = "specialties" | "certifications" | "tags";
type Field = TextField | "product_name" | "products_organic_flag" | ListField;

const LIST_FIELDS: readonly ListField[] = ["specialties", "certifications", "tags"];
export const CONTENT_CORRECTION_MAX_PRODUCT_NAME = 200;
export const CONTENT_CORRECTION_MAX_REMOVE = 100;

type ItemOutcome =
  | "would_write"
  | "written"
  | "would_merge"
  | "merged"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_unchanged"
  | "skipped_malformed_json"
  | "refused_junk_text"
  | "invalid_item"
  | "not_found"
  | "error";

/** product_name merge record: which product row was kept, which dropped. */
interface MergeInfo {
  kept: "renamed_row" | "existing_row";
  kept_product: unknown;
  dropped_product: unknown;
}

interface ResultItem {
  agent_id: string;
  field?: Field;
  name?: string;
  outcome: ItemOutcome;
  old_value_preview?: string;
  new_value_preview?: string;
  detail?: string;
  merge?: MergeInfo;
  removed?: string[];
  not_found_elements?: string[];
  changed_count?: number;
}

interface LockSnapshot {
  name: string;
  claimed_at: string | null;
  description: string;
  about: string | null;
  products: string | null;
  specialties: string | null;
  certifications: string | null;
  tags: string | null;
  curated_fields: string | null;
  verified_claims: number;
  has_knowledge_row: number;
}

const LOCK_SNAPSHOT_SQL = `
  SELECT a.name         AS name,
         a.claimed_at   AS claimed_at,
         a.description  AS description,
         a.tags         AS tags,
         k.about        AS about,
         k.products     AS products,
         k.specialties  AS specialties,
         k.certifications AS certifications,
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

function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: string): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    return !!(parsed as Record<string, unknown>)[fieldName];
  } catch {
    return false;
  }
}

/**
 * The stored column a field writes to — also the audit field_name and the
 * curated_fields key that locks it (owner-portal keys curated_fields by
 * column name). Lists: specialties/certifications are agent_knowledge JSON
 * columns, tags is the agents.tags JSON column.
 */
function storageColumn(field: Field): TextField | "products" | ListField {
  if (field === "product_name" || field === "products_organic_flag") return "products";
  return field;
}

type ValidItem =
  | { agent_id: string; field: TextField; text: string }
  | { agent_id: string; field: "product_name"; old_name: string; text: string }
  | { agent_id: string; field: "products_organic_flag" }
  | { agent_id: string; field: ListField; remove: string[] };

type Invalid = { ok: false; outcome: ItemOutcome; detail: string; agent_id: string };

/** The same content gates as every other description/about door. */
function junkGate(text: string, agentId: string): Invalid | null {
  if (looksLikeCodeArtifact(text)) return { ok: false, outcome: "refused_junk_text", detail: "text looks like a code artifact", agent_id: agentId };
  if (hasInternalNote(text)) return { ok: false, outcome: "refused_junk_text", detail: "text contains an internal pipeline note", agent_id: agentId };
  // dev-request 2026-09-16-kaprede-produsentdomener-kasino-spam-i-beskrivelser.
  if (looksLikeThemeSpam(text)) return { ok: false, outcome: "refused_junk_text", detail: "text looks like gambling/theme spam (hijacked domain)", agent_id: agentId };
  return null;
}

/** Shape + content validation of one caller-supplied item. */
function validateItem(raw: unknown): { ok: true; item: ValidItem } | Invalid {
  const r = (raw ?? {}) as Record<string, unknown>;
  const agentId = typeof r.agent_id === "string" ? r.agent_id.trim() : "";
  if (!agentId) return { ok: false, outcome: "invalid_item", detail: "agent_id required", agent_id: "" };
  const f = r.field;

  if (f === "description" || f === "about") {
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) return { ok: false, outcome: "invalid_item", detail: "text required (non-empty)", agent_id: agentId };
    if (text.length > CONTENT_CORRECTION_MAX_TEXT) {
      return { ok: false, outcome: "invalid_item", detail: `text exceeds ${CONTENT_CORRECTION_MAX_TEXT} chars`, agent_id: agentId };
    }
    // A correction is never the way junk gets back in.
    const junk = junkGate(text, agentId);
    if (junk) return junk;
    return { ok: true, item: { agent_id: agentId, field: f, text } };
  }

  if (f === "product_name") {
    // old_name is matched EXACTLY against the stored name — not trimmed.
    const oldName = typeof r.old_name === "string" ? r.old_name : "";
    if (!oldName) return { ok: false, outcome: "invalid_item", detail: "old_name required (non-empty)", agent_id: agentId };
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) return { ok: false, outcome: "invalid_item", detail: "text required (non-empty)", agent_id: agentId };
    if (text.length > CONTENT_CORRECTION_MAX_PRODUCT_NAME) {
      return { ok: false, outcome: "invalid_item", detail: `text exceeds ${CONTENT_CORRECTION_MAX_PRODUCT_NAME} chars`, agent_id: agentId };
    }
    const junk = junkGate(text, agentId);
    if (junk) return junk;
    return { ok: true, item: { agent_id: agentId, field: "product_name", old_name: oldName, text } };
  }

  if (f === "products_organic_flag") {
    return { ok: true, item: { agent_id: agentId, field: "products_organic_flag" } };
  }

  if (typeof f === "string" && (LIST_FIELDS as readonly string[]).includes(f)) {
    const remove = r.remove;
    if (!Array.isArray(remove) || remove.length === 0) {
      return { ok: false, outcome: "invalid_item", detail: "remove[] required (non-empty array of strings)", agent_id: agentId };
    }
    if (remove.length > CONTENT_CORRECTION_MAX_REMOVE) {
      return { ok: false, outcome: "invalid_item", detail: `remove[] exceeds ${CONTENT_CORRECTION_MAX_REMOVE} elements`, agent_id: agentId };
    }
    if (!remove.every((e) => typeof e === "string" && e.length > 0)) {
      return { ok: false, outcome: "invalid_item", detail: "remove[] elements must be non-empty strings", agent_id: agentId };
    }
    return { ok: true, item: { agent_id: agentId, field: f as ListField, remove: [...new Set(remove as string[])] } };
  }

  return {
    ok: false,
    outcome: "invalid_item",
    detail: "field must be description|about|product_name|products_organic_flag|specialties|certifications|tags",
    agent_id: agentId,
  };
}

/** Parse a stored JSON-array column. null/'' -> []; non-array or bad JSON -> null (malformed). */
function parseJsonArray(stored: string | null | undefined): unknown[] | null {
  if (stored == null || stored === "") return [];
  try {
    const v = JSON.parse(stored);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function isProductObj(p: unknown): p is Record<string, unknown> {
  return !!p && typeof p === "object" && !Array.isArray(p);
}

/** How many fields besides `name` carry a value — the merge tie-breaker. */
function populatedFieldCount(p: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (k === "name") continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n++;
  }
  return n;
}

/**
 * The change one item would make, computed against a lock snapshot. Pure —
 * shared by the dry-run and by the apply's fresh in-transaction re-check, so
 * both always agree on the outcome. `newValue` is the full new column value.
 */
interface Plan {
  outcome: ItemOutcome;
  column?: TextField | "products" | ListField;
  oldValue?: string | null;
  newValue?: string;
  oldPreview?: string | null;
  newPreview?: string | null;
  detail?: string;
  merge?: MergeInfo;
  removed?: string[];
  not_found_elements?: string[];
  changed_count?: number;
}

function plan(cur: LockSnapshot | undefined, item: ValidItem): Plan {
  if (!cur) return { outcome: "not_found" };
  const column = storageColumn(item.field);

  if (item.field === "description" || item.field === "about") {
    const oldValue = item.field === "description" ? cur.description : cur.about;
    const base = { column, oldValue, oldPreview: oldValue, newPreview: item.text };
    if (isOwnerLocked(cur)) return { ...base, outcome: "skipped_claimed" };
    if (isFieldCurated(cur.curated_fields, item.field)) return { ...base, outcome: "skipped_curated" };
    if ((oldValue ?? "") === item.text) return { ...base, outcome: "skipped_unchanged" };
    return { ...base, outcome: "would_write", newValue: item.text };
  }

  const oldValue = (cur as unknown as Record<string, string | null>)[column] ?? null;
  const base: Plan = { outcome: "would_write", column, oldValue };
  if (isOwnerLocked(cur)) return { ...base, outcome: "skipped_claimed" };
  if (isFieldCurated(cur.curated_fields, column)) return { ...base, outcome: "skipped_curated" };
  const arr = parseJsonArray(oldValue);
  if (!arr) return { ...base, outcome: "skipped_malformed_json", detail: `stored ${column} is not a JSON array` };

  if (item.field === "product_name") {
    const sel = { ...base, oldPreview: item.old_name, newPreview: item.text };
    const matches = arr.map((p, i) => (isProductObj(p) && p.name === item.old_name ? i : -1)).filter((i) => i >= 0);
    if (matches.length !== 1) {
      return { ...sel, outcome: "invalid_item", detail: `old_name matches ${matches.length} products (need exactly 1)` };
    }
    const idx = matches[0];
    if (item.old_name === item.text) return { ...sel, outcome: "skipped_unchanged" };
    const dupes = arr.map((p, i) => (i !== idx && isProductObj(p) && p.name === item.text ? i : -1)).filter((i) => i >= 0);
    if (dupes.length > 1) {
      return { ...sel, outcome: "invalid_item", detail: `text already names ${dupes.length} products — ambiguous merge` };
    }
    const renamed = arr[idx] as Record<string, unknown>;
    if (dupes.length === 0) {
      // Spread keeps key order and every other field; only `name` changes.
      const next = arr.slice();
      next[idx] = { ...renamed, name: item.text };
      return { ...sel, outcome: "would_write", newValue: JSON.stringify(next) };
    }
    // Merge: keep the row with the most populated fields; tie -> the row
    // that already carries `text`. Kept row ends up named `text`, the other
    // is dropped; the kept row stays at its own position.
    const dupIdx = dupes[0];
    const existing = arr[dupIdx] as Record<string, unknown>;
    const keepRenamed = populatedFieldCount(renamed) > populatedFieldCount(existing);
    const keptProduct = keepRenamed ? { ...renamed, name: item.text } : existing;
    const droppedIdx = keepRenamed ? dupIdx : idx;
    const keptIdx = keepRenamed ? idx : dupIdx;
    const next: unknown[] = [];
    arr.forEach((p, i) => {
      if (i === droppedIdx) return;
      next.push(i === keptIdx ? keptProduct : p);
    });
    return {
      ...sel,
      outcome: "would_merge",
      newValue: JSON.stringify(next),
      merge: {
        kept: keepRenamed ? "renamed_row" : "existing_row",
        kept_product: keptProduct,
        dropped_product: arr[droppedIdx],
      },
    };
  }

  if (item.field === "products_organic_flag") {
    let changed = 0;
    const next = arr.map((p) => {
      if (isProductObj(p) && p.organic) {
        changed++;
        return { ...p, organic: false };
      }
      return p;
    });
    if (changed === 0) return { ...base, outcome: "skipped_unchanged", changed_count: 0 };
    return { ...base, outcome: "would_write", newValue: JSON.stringify(next), changed_count: changed };
  }

  // List removal — exact string equality, never adds.
  if (!("remove" in item)) return { outcome: "error", detail: "unreachable: unhandled field" };
  const toRemove = new Set(item.remove);
  const present = new Set(arr.filter((e): e is string => typeof e === "string"));
  const removed = item.remove.filter((e) => present.has(e));
  const notFound = item.remove.filter((e) => !present.has(e));
  const out = { ...base, removed, not_found_elements: notFound };
  if (removed.length === 0) return { ...out, outcome: "skipped_unchanged" };
  const next = arr.filter((e) => !(typeof e === "string" && toRemove.has(e)));
  return { ...out, outcome: "would_write", newValue: JSON.stringify(next) };
}

type ApplyResult = Plan & { name?: string };

/** Write ONE correction — fresh lock re-read inside its own transaction. */
function applyCorrection(item: ValidItem, reason: string, batchTag: string): ApplyResult {
  const db = db_();
  try {
    const tx = db.transaction((): ApplyResult => {
      const cur = db.prepare(LOCK_SNAPSHOT_SQL).get(item.agent_id) as LockSnapshot | undefined;
      const p = plan(cur, item);
      if (p.outcome !== "would_write" && p.outcome !== "would_merge") return { ...p, name: cur?.name };

      const nowIso = new Date().toISOString();
      const col = p.column!;
      const newValue = p.newValue!;
      if (col === "description") {
        db.prepare(`UPDATE agents SET description = ? WHERE id = ?`).run(newValue, item.agent_id);
      } else if (col === "tags") {
        db.prepare(`UPDATE agents SET tags = ? WHERE id = ?`).run(newValue, item.agent_id);
      } else if (col === "about" && !cur!.has_knowledge_row) {
        db.prepare(`INSERT INTO agent_knowledge (agent_id, about, updated_at) VALUES (?, ?, ?)`).run(item.agent_id, newValue, nowIso);
      } else {
        // about / products / specialties / certifications — a list change is
        // only ever planned against an existing row (no row -> [] -> nothing to change).
        db.prepare(`UPDATE agent_knowledge SET ${col} = ?, updated_at = ? WHERE agent_id = ?`).run(newValue, nowIso, item.agent_id);
      }
      let notes = `${batchTag}: ${reason}`;
      if (p.merge) {
        notes += ` [merge: kept ${p.merge.kept} ${JSON.stringify(p.merge.kept_product)}; dropped ${JSON.stringify(p.merge.dropped_product)}]`;
      }
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, 'admin', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), item.agent_id, col, p.oldValue ?? null, newValue, notes);
      return { ...p, outcome: p.outcome === "would_merge" ? "merged" : "written", name: cur!.name };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

function toResult(item: ValidItem, p: ApplyResult): ResultItem {
  const r: ResultItem = {
    agent_id: item.agent_id,
    field: item.field,
    name: p.name,
    outcome: p.outcome,
    old_value_preview: previewValue(p.oldPreview !== undefined ? p.oldPreview : p.oldValue),
    new_value_preview: previewValue(
      p.newPreview !== undefined ? p.newPreview : p.newValue !== undefined ? p.newValue : "text" in item ? item.text : undefined,
    ),
  };
  if (p.detail) r.detail = p.detail;
  if (p.merge) r.merge = p.merge;
  if (p.removed) r.removed = p.removed;
  if (p.not_found_elements) r.not_found_elements = p.not_found_elements;
  if (p.changed_count !== undefined) r.changed_count = p.changed_count;
  return r;
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
      results.push(toResult(item, { ...plan(cur, item), name: cur?.name }));
    } else {
      results.push(toResult(item, applyCorrection(item, reason, batchTag)));
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc), {});
  res.json({ success: true, dry_run: dryRun, batch_tag: batchTag, reason, counts, results });
});

export default router;
