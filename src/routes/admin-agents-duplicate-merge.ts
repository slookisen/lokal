// ─── Admin: POST /admin/agents/duplicate-merge ──────────────────────────────
//
// One controlled admin lever that executes an EXPLICIT duplicate-pair merge
// decision — {survivor_id, duplicate_id, reason} — supplied by the caller.
// This route NEVER detects duplicates itself; it only carries out a decision
// someone else already made. Mirrors the write/lock/audit discipline of
// admin-agents-contact-email-write.ts exactly:
//
//   * dry-run by DEFAULT. `apply` must be an explicit truthy form.
//   * Row-level lock: if EITHER agent in the pair has `agents.claimed_at`,
//     the WHOLE PAIR is skipped (`skipped_claimed`) — neither row is touched.
//   * Per-field lock: `agent_knowledge.curated_fields` on the SURVIVOR is
//     checked before filling each field. A locked field is skipped on its
//     own (`skipped_curated_field:<name>`) — it does not abort the pair.
//   * Both locks are re-read from a FRESH snapshot immediately before the
//     write, inside that write's own transaction.
//   * Fill-only: the survivor's own value is written ONLY when it is
//     currently blank (NULL or '' — see isBlank below). The duplicate never
//     overwrites a survivor value that is already set.
//   * Provenance (`agent_knowledge.field_provenance`) is merged APPEND-ONLY:
//     the duplicate's per-field provenance entries are appended onto the
//     survivor's array for each field actually filled, never overwritten.
//     See mergeFieldProvenance() for the array-shape handling.
//   * The duplicate is deactivated (`agents.is_active = 0`,
//     `agents.merged_into = <survivor id>`) — never deleted.
//   * One `agent_knowledge_audit` row per CHANGED field (carrying the OLD
//     value, so any single field-fill is reversible), PLUS one row recording
//     the merge decision itself (`field_name = 'merge'`,
//     `old_value = duplicate_id`, `new_value = survivor_id`,
//     `notes = reason`) so the merge itself is reversible:
//       rollback = SET agents.is_active = 1, merged_into = NULL
//                  WHERE id = duplicate_id
//                  (+ undo any field fills from their audit rows' old_value)
//   * Every pair is processed in its OWN transaction — one pair's failure
//     never aborts the batch or half-writes another.
//
// ── Which fields are merged ──────────────────────────────────────────────
//   agents:          contact_email (TEXT NOT NULL — '' is "blank")
//   agent_knowledge: address, postal_code, website, phone, email, about
// JSON-array/object columns (opening_hours, products, specialties, …),
// numeric/rating columns, and data_source/auto_sources/timestamps are
// explicitly OUT OF SCOPE for this fill-only pass — see the dev-request.
//
// ── The trap this route avoids ───────────────────────────────────────────
// A naive "just UPDATE the survivor with the duplicate's values" would
// silently clobber curated/owner-set data and would leave the duplicate
// row live to keep polluting search/outreach/dedupe forever. This route
// makes both mistakes structurally impossible: fill-only + curated-lock
// checks make clobbering impossible, and the mandatory is_active/merged_into
// write on apply makes "merged but still live" impossible.

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";
import { coerceProvenanceToArrayShape } from "../services/cross-source-validator";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
// Same seam convention as admin-agents-contact-email-write.ts
// (__setContactEmailWriteDbForTesting) — see that file's header comment for
// the concrete race (orch-pr-86, PR #444) this avoids. Production code never
// calls the setter.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setDuplicateMergeDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

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

/** Hard cap per call — mirrors CONTACT_EMAIL_WRITE_MAX_ITEMS's convention. */
export const DUPLICATE_MERGE_MAX_PAIRS = 50;

/** The plain scalar text fields on agent_knowledge that this route fill-only merges. */
export const KNOWLEDGE_MERGE_FIELDS = ["address", "postal_code", "website", "phone", "email", "about"] as const;
export type KnowledgeMergeField = (typeof KNOWLEDGE_MERGE_FIELDS)[number];

/** '' and NULL both count as "blank" for every field this route touches. */
export function isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v === "";
}

/**
 * True iff the parsed curated_fields JSON locks `fieldName` on the SURVIVOR
 * row about to be written. Generalizes admin-agents-contact-email-write.ts's
 * isContactEmailCurated: "contact_email" (the `agents` column) accepts either
 * spelling ("contact_email" or "email", same dual-spelling reasoning as that
 * route), every other field name is looked up by its own agent_knowledge
 * column name directly. Tolerates malformed/missing JSON as "not locked".
 */
export function isFieldCurated(curatedFieldsJson: string | null | undefined, fieldName: string): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object") return false;
    const o = parsed as Record<string, unknown>;
    if (fieldName === "contact_email") {
      return !!(o["contact_email"] || o["email"]);
    }
    return !!o[fieldName];
  } catch {
    return false;
  }
}

/**
 * Merge two agent_knowledge.field_provenance JSON blobs APPEND-ONLY: for
 * every field in `filledFields`, the duplicate's provenance entries for that
 * field are appended onto the survivor's (creating the key if the survivor
 * had none). Fields not in `filledFields` are passed through untouched.
 *
 * field_provenance may be legacy single-object-per-field shape or (post
 * phase53_provenance_to_array_v1) array-per-field shape — coerceProvenanceToArrayShape
 * (database/init.ts's own migration helper, services/cross-source-validator.ts)
 * normalizes either into arrays before the append, so this never overwrites.
 */
export function mergeFieldProvenance(
  survivorProvenanceJson: string | null | undefined,
  duplicateProvenanceJson: string | null | undefined,
  filledFields: string[],
): string {
  let survivorRaw: Record<string, unknown> = {};
  let duplicateRaw: Record<string, unknown> = {};
  try {
    survivorRaw = survivorProvenanceJson ? JSON.parse(survivorProvenanceJson) : {};
    if (!survivorRaw || typeof survivorRaw !== "object" || Array.isArray(survivorRaw)) survivorRaw = {};
  } catch {
    survivorRaw = {};
  }
  try {
    duplicateRaw = duplicateProvenanceJson ? JSON.parse(duplicateProvenanceJson) : {};
    if (!duplicateRaw || typeof duplicateRaw !== "object" || Array.isArray(duplicateRaw)) duplicateRaw = {};
  } catch {
    duplicateRaw = {};
  }

  const survivorArr = coerceProvenanceToArrayShape(survivorRaw);
  const duplicateArr = coerceProvenanceToArrayShape(duplicateRaw);

  for (const field of filledFields) {
    const dupEntries = duplicateArr[field];
    if (!dupEntries || dupEntries.length === 0) continue;
    const existing = survivorArr[field] ?? [];
    survivorArr[field] = [...existing, ...dupEntries];
  }

  return JSON.stringify(survivorArr);
}

// ── Row snapshot ─────────────────────────────────────────────────────────
interface AgentSnapshot {
  id: string;
  claimedAt: string | null;
  contactEmail: string | null;
  isActive: boolean;
  mergedInto: string | null;
  hasKnowledgeRow: boolean;
  knowledge: Record<KnowledgeMergeField, string | null>;
  curatedFields: string | null;
  fieldProvenance: string | null;
}

/**
 * LEFT JOIN, not INNER: an agent may legitimately have no agent_knowledge
 * row at all (same reasoning as admin-agents-contact-email-write.ts's header
 * note — an INNER JOIN here would silently make such rows un-mergeable).
 * `k_agent_id IS NULL` is the join-miss signal used to set hasKnowledgeRow.
 */
function readAgentSnapshot(db: ReturnType<typeof getDb>, id: string): AgentSnapshot | null {
  const row = db
    .prepare(
      `SELECT a.id AS a_id, a.claimed_at AS a_claimed_at, a.contact_email AS a_contact_email,
              a.is_active AS a_is_active, a.merged_into AS a_merged_into,
              k.agent_id AS k_agent_id, k.address AS k_address, k.postal_code AS k_postal_code,
              k.website AS k_website, k.phone AS k_phone, k.email AS k_email, k.about AS k_about,
              k.curated_fields AS k_curated_fields, k.field_provenance AS k_field_provenance
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(id) as Record<string, string | number | null> | undefined;

  if (!row) return null;
  return {
    id: row.a_id as string,
    claimedAt: row.a_claimed_at as string | null,
    contactEmail: row.a_contact_email as string | null,
    // agents.is_active is SQLite INTEGER DEFAULT 1 — 0 is false, anything
    // else (including NULL, defensively) is truthy/active, same convention
    // as claimed_at truthiness elsewhere in this file.
    isActive: row.a_is_active !== 0,
    mergedInto: row.a_merged_into as string | null,
    hasKnowledgeRow: row.k_agent_id !== null,
    knowledge: {
      address: row.k_address as string | null,
      postal_code: row.k_postal_code as string | null,
      website: row.k_website as string | null,
      phone: row.k_phone as string | null,
      email: row.k_email as string | null,
      about: row.k_about as string | null,
    },
    curatedFields: row.k_curated_fields as string | null,
    fieldProvenance: row.k_field_provenance as string | null,
  };
}

// ── Fill plan ────────────────────────────────────────────────────────────
interface FieldFillPlan {
  field: string; // "contact_email" | KnowledgeMergeField
  table: "agents" | "agent_knowledge";
  newValue: string;
}

interface MergePlan {
  fillable: FieldFillPlan[];
  curatedSkipped: string[];
}

/**
 * Fill-only decision, field by field: the survivor's own value must be
 * blank AND the duplicate's must be non-blank for a field to be a candidate
 * — then the SURVIVOR's curated_fields lock is checked (never the
 * duplicate's — the duplicate is only ever read from here, never written to
 * except the deactivation flags). A locked field is reported in
 * curatedSkipped, not in fillable — it does not affect any other field or
 * the pair's overall outcome.
 */
function computeFillPlan(survivor: AgentSnapshot, duplicate: AgentSnapshot): MergePlan {
  const fillable: FieldFillPlan[] = [];
  const curatedSkipped: string[] = [];

  if (isBlank(survivor.contactEmail) && !isBlank(duplicate.contactEmail)) {
    if (isFieldCurated(survivor.curatedFields, "contact_email")) {
      curatedSkipped.push("contact_email");
    } else {
      fillable.push({ field: "contact_email", table: "agents", newValue: duplicate.contactEmail as string });
    }
  }

  for (const field of KNOWLEDGE_MERGE_FIELDS) {
    const survivorVal = survivor.knowledge[field];
    const dupVal = duplicate.knowledge[field];
    if (isBlank(survivorVal) && !isBlank(dupVal)) {
      if (isFieldCurated(survivor.curatedFields, field)) {
        curatedSkipped.push(field);
      } else {
        fillable.push({ field, table: "agent_knowledge", newValue: dupVal as string });
      }
    }
  }

  return { fillable, curatedSkipped };
}

function curatedDetail(curatedSkipped: string[]): string | undefined {
  return curatedSkipped.length > 0 ? curatedSkipped.map((f) => `skipped_curated_field:${f}`).join(",") : undefined;
}

/**
 * True iff this pair must be rejected as a re-merge of an already-merged/dead
 * row. Two distinct conditions, either one is fatal to the pair:
 *   - the SURVIVOR is not active (it was itself already merged away as a
 *     duplicate by some earlier pair) — writing fills onto it would bury
 *     real data on a row invisible to any live-facing query.
 *   - the DUPLICATE already has a non-null merged_into (it was already
 *     merged into some other survivor) — retargeting it here would silently
 *     redirect it away from its original survivor and re-run the
 *     fill/deactivate logic on a row that's already resolved.
 * Deliberately does NOT block on the duplicate simply being is_active=0 with
 * no merged_into (e.g. deactivated for an unrelated reason), and does NOT
 * block on the survivor having some unrelated merged_into value — only the
 * two conditions above are the defect this guards against.
 */
function isAlreadyMergedPair(survivor: AgentSnapshot, duplicate: AgentSnapshot): boolean {
  return !survivor.isActive || duplicate.mergedInto !== null;
}

// ── Writes ───────────────────────────────────────────────────────────────

/**
 * Performs the actual writes for one pair (agents.contact_email fill,
 * agent_knowledge fill/create + provenance append, audit rows, and the
 * mandatory duplicate deactivation + merge-decision audit row). Caller is
 * responsible for the surrounding transaction and the fresh claimed/curated
 * re-check.
 */
function applyMergeWrites(
  db: ReturnType<typeof getDb>,
  survivor: AgentSnapshot,
  duplicate: AgentSnapshot,
  plan: MergePlan,
  reason: string,
  batchTag: string,
): { fieldsFilled: string[] } {
  const fieldsFilled: string[] = [];

  const contactFill = plan.fillable.find((f) => f.table === "agents" && f.field === "contact_email");
  if (contactFill) {
    db.prepare(`UPDATE agents SET contact_email = ? WHERE id = ?`).run(contactFill.newValue, survivor.id);
    db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, 'contact_email', ?, ?, 'system', NULL, datetime('now'), ?)`,
    ).run(randomUUID(), survivor.id, survivor.contactEmail, contactFill.newValue, `${batchTag}: ${reason}`);
    fieldsFilled.push("contact_email");
  }

  const knowledgeFills = plan.fillable.filter((f) => f.table === "agent_knowledge");
  if (knowledgeFills.length > 0) {
    const filledFieldNames = knowledgeFills.map((f) => f.field);
    const mergedProvenance = mergeFieldProvenance(survivor.fieldProvenance, duplicate.fieldProvenance, filledFieldNames);

    if (survivor.hasKnowledgeRow) {
      const setClauses = knowledgeFills.map((f) => `${f.field} = ?`).join(", ");
      const values = knowledgeFills.map((f) => f.newValue);
      db.prepare(
        `UPDATE agent_knowledge SET ${setClauses}, field_provenance = ?, updated_at = datetime('now') WHERE agent_id = ?`,
      ).run(...values, mergedProvenance, survivor.id);
    } else {
      const columns = ["agent_id", ...knowledgeFills.map((f) => f.field), "field_provenance"];
      const placeholders = columns.map(() => "?").join(", ");
      const values = [survivor.id, ...knowledgeFills.map((f) => f.newValue), mergedProvenance];
      db.prepare(`INSERT INTO agent_knowledge (${columns.join(", ")}) VALUES (${placeholders})`).run(...values);
    }

    for (const f of knowledgeFills) {
      const oldValue = survivor.knowledge[f.field as KnowledgeMergeField];
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, ?, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), survivor.id, f.field, oldValue, f.newValue, `${batchTag}: ${reason}`);
      fieldsFilled.push(f.field);
    }

    // field_provenance itself changed on the survivor row (append-only merge
    // above) but is never one of KNOWLEDGE_MERGE_FIELDS, so the per-field
    // loop above never captures it — without this row the provenance change
    // would be un-reversible from the audit trail alone (see header comment,
    // "rollback recipe reconstructable from audit old_values").
    db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, 'field_provenance', ?, ?, 'system', NULL, datetime('now'), ?)`,
    ).run(randomUUID(), survivor.id, survivor.fieldProvenance, mergedProvenance, `${batchTag}: ${reason}`);
  }

  // Mandatory, independent of whether any field above was fillable: the
  // caller's decision to merge this pair is executed regardless.
  db.prepare(`UPDATE agents SET is_active = 0, merged_into = ? WHERE id = ?`).run(survivor.id, duplicate.id);
  db.prepare(
    `INSERT INTO agent_knowledge_audit
       (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
     VALUES (?, ?, 'merge', ?, ?, 'system', NULL, datetime('now'), ?)`,
  ).run(randomUUID(), duplicate.id, duplicate.id, survivor.id, reason);

  return { fieldsFilled };
}

type PairOutcome =
  | "would_merge"
  | "merged"
  | "skipped_claimed"
  | "skipped_already_merged"
  | "skipped_same_id"
  | "not_found"
  | "rejected_invalid_item"
  | "error";

interface PairResult {
  outcome: PairOutcome;
  fieldsFilled?: string[];
  detail?: string;
}

/** Dry-run preview: reads once, writes nothing. */
function planMergePair(db: ReturnType<typeof getDb>, survivorId: string, duplicateId: string): PairResult {
  const survivor = readAgentSnapshot(db, survivorId);
  const duplicate = readAgentSnapshot(db, duplicateId);
  if (!survivor || !duplicate) return { outcome: "not_found" };
  if (survivor.claimedAt || duplicate.claimedAt) return { outcome: "skipped_claimed" };
  if (isAlreadyMergedPair(survivor, duplicate)) return { outcome: "skipped_already_merged" };

  const plan = computeFillPlan(survivor, duplicate);
  return {
    outcome: "would_merge",
    fieldsFilled: plan.fillable.map((f) => f.field),
    detail: curatedDetail(plan.curatedSkipped),
  };
}

/**
 * Apply one pair inside its own transaction. Re-reads claimed_at +
 * curated_fields (via a fresh readAgentSnapshot) immediately before writing,
 * inside this same transaction — a row locked/claimed between the outer
 * scan and this write is left alone. One pair's failure (caught below)
 * never aborts the batch.
 */
function applyMergePair(
  db: ReturnType<typeof getDb>,
  survivorId: string,
  duplicateId: string,
  reason: string,
  batchTag: string,
): PairResult {
  try {
    const tx = db.transaction((): PairResult => {
      const survivor = readAgentSnapshot(db, survivorId);
      const duplicate = readAgentSnapshot(db, duplicateId);
      if (!survivor || !duplicate) return { outcome: "not_found" };
      if (survivor.claimedAt || duplicate.claimedAt) return { outcome: "skipped_claimed" };
      if (isAlreadyMergedPair(survivor, duplicate)) return { outcome: "skipped_already_merged" };

      const plan = computeFillPlan(survivor, duplicate);
      const { fieldsFilled } = applyMergeWrites(db, survivor, duplicate, plan, reason, batchTag);

      return { outcome: "merged", fieldsFilled, detail: curatedDetail(plan.curatedSkipped) };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

interface ResultItem {
  survivor_id: string;
  duplicate_id: string;
  outcome: PairOutcome;
  fields_filled?: string[];
  detail?: string;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { pairs?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.pairs) || body.pairs.length === 0) {
    res
      .status(400)
      .json({ error: "Body must contain a non-empty 'pairs' array of {survivor_id, duplicate_id, reason}" });
    return;
  }
  if (body.pairs.length > DUPLICATE_MERGE_MAX_PAIRS) {
    res.status(400).json({ error: `Too many pairs (max ${DUPLICATE_MERGE_MAX_PAIRS} per call)` });
    return;
  }

  const batchTag = `duplicate-merge-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const db = resolveDb();
  const results: ResultItem[] = [];
  // Every id (survivor OR duplicate role) that has already appeared in an
  // earlier, structurally-valid pair within THIS request — merging the same
  // row twice in one call is not supported (see header comment).
  const usedIds = new Set<string>();

  for (const raw of body.pairs as unknown[]) {
    const it = (raw ?? {}) as { survivor_id?: unknown; duplicate_id?: unknown; reason?: unknown };
    const survivorId = typeof it.survivor_id === "string" ? it.survivor_id.trim() : "";
    const duplicateId = typeof it.duplicate_id === "string" ? it.duplicate_id.trim() : "";
    const reason = typeof it.reason === "string" ? it.reason.trim() : "";

    if (!survivorId || !duplicateId || !reason) {
      results.push({
        survivor_id: survivorId || "(missing)",
        duplicate_id: duplicateId || "(missing)",
        outcome: "rejected_invalid_item",
        detail: "survivor_id, duplicate_id, and reason are all required",
      });
      continue;
    }

    if (usedIds.has(survivorId) || usedIds.has(duplicateId)) {
      results.push({
        survivor_id: survivorId,
        duplicate_id: duplicateId,
        outcome: "rejected_invalid_item",
        detail: "id_already_used_in_batch",
      });
      continue;
    }

    if (survivorId === duplicateId) {
      usedIds.add(survivorId);
      results.push({ survivor_id: survivorId, duplicate_id: duplicateId, outcome: "skipped_same_id" });
      continue;
    }

    usedIds.add(survivorId);
    usedIds.add(duplicateId);

    if (dryRun) {
      const plan = planMergePair(db, survivorId, duplicateId);
      results.push({
        survivor_id: survivorId,
        duplicate_id: duplicateId,
        outcome: plan.outcome,
        ...(plan.fieldsFilled ? { fields_filled: plan.fieldsFilled } : {}),
        ...(plan.detail ? { detail: plan.detail } : {}),
      });
      continue;
    }

    const applied = applyMergePair(db, survivorId, duplicateId, reason, batchTag);
    results.push({
      survivor_id: survivorId,
      duplicate_id: duplicateId,
      outcome: applied.outcome,
      ...(applied.fieldsFilled ? { fields_filled: applied.fieldsFilled } : {}),
      ...(applied.detail ? { detail: applied.detail } : {}),
    });
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: (body.pairs as unknown[]).length,
    counts,
    results,
  });
});

export default router;
