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
//     Per-pair opt-in `allow_claimed_survivor: true` (strict boolean `true`
//     only) lifts this for the SURVIVOR side alone: the pair is then not
//     skipped merely because the survivor is claimed. A claimed DUPLICATE is
//     ALWAYS `skipped_claimed`, with or without the option. Everything else
//     (fill-only, the survivor's curated_fields per-field lock, provenance
//     append, audit rows, duplicate deactivation) is unchanged — a claimed
//     survivor's owner-set values are never overwritten because fill-only
//     only writes blank fields and curated fields are skipped. The duplicate's
//     own curated_fields are never consulted (it is only read, then
//     deactivated). The option is honoured on both the dry-run plan and the
//     in-transaction re-check on apply. Any present value other than the
//     booleans true/false (e.g. "true", 1) rejects that item as
//     `rejected_invalid_item` (detail `allow_claimed_survivor_must_be_boolean`)
//     so a caller never believes it opted in when it did not. When the option
//     is true the result item echoes `allow_claimed_survivor: true`; without
//     it (absent or false) the result item is exactly as before.
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
// ── Shared core (claim-merge-approve) ────────────────────────────────────
// The per-pair core (readAgentSnapshot → computeFillPlan → applyMergeWrites)
// is exported so POST /admin/agents/claim-merge-approve (eierkrav D1,
// services/claim-merge-approve.ts) runs the SAME fill-only / curated-lock /
// append-only-provenance / audit / deactivation discipline instead of a copy.
// That caller opts in to `{ g8: true }`, which ALSO fill-only moves opening
// hours, the delivery fields the profile page shows (delivery_options,
// delivery_radius, min_order_value) and the map point (agents.lat/lng with
// its geo_precision/geocode_source/geocode_outcome). Without the option —
// this route — the plan, the writes and the outcome are exactly as above.
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
import { invalidateAgentGeocode } from "../services/agent-geocode-reset";

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

/** G8 (claim-merge-approve only): agent_knowledge columns the profile page
 *  shows for opening hours and delivery (routes/seo.ts producer page). */
export const G8_KNOWLEDGE_FIELDS = ["opening_hours", "delivery_options", "delivery_radius", "min_order_value"] as const;
export type G8KnowledgeField = (typeof G8_KNOWLEDGE_FIELDS)[number];

/** G8: the map point — agents.lat/lng and the provenance of that position
 *  (geo-precision.ts honesty rule), moved together as one unit. */
export const MAP_POINT_FIELDS = ["lat", "lng", "geo_precision", "geocode_source", "geocode_outcome"] as const;
export type MapPointField = (typeof MAP_POINT_FIELDS)[number];

type ScalarValue = string | number | null;

/** G8 blank: NULL, '' (after trim), or an empty JSON array/object — the
 *  column defaults ('[]') count as "nothing set". */
export function isBlankG8(v: ScalarValue | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return false;
  const t = v.trim();
  return t === "" || t === "[]" || t === "{}";
}

function normAddress(v: string | null): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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
export interface AgentSnapshot {
  id: string;
  claimedAt: string | null;
  contactEmail: string | null;
  isActive: boolean;
  mergedInto: string | null;
  hasKnowledgeRow: boolean;
  knowledge: Record<KnowledgeMergeField, string | null>;
  /** G8 columns — read always, used only with `{ g8: true }`. */
  g8Knowledge: Record<G8KnowledgeField, ScalarValue>;
  mapPoint: Record<MapPointField, ScalarValue>;
  curatedFields: string | null;
  fieldProvenance: string | null;
}

/**
 * LEFT JOIN, not INNER: an agent may legitimately have no agent_knowledge
 * row at all (same reasoning as admin-agents-contact-email-write.ts's header
 * note — an INNER JOIN here would silently make such rows un-mergeable).
 * `k_agent_id IS NULL` is the join-miss signal used to set hasKnowledgeRow.
 */
export function readAgentSnapshot(db: ReturnType<typeof getDb>, id: string): AgentSnapshot | null {
  const row = db
    .prepare(
      `SELECT a.id AS a_id, a.claimed_at AS a_claimed_at, a.contact_email AS a_contact_email,
              a.is_active AS a_is_active, a.merged_into AS a_merged_into,
              a.lat AS a_lat, a.lng AS a_lng, a.geo_precision AS a_geo_precision,
              a.geocode_source AS a_geocode_source, a.geocode_outcome AS a_geocode_outcome,
              k.agent_id AS k_agent_id, k.address AS k_address, k.postal_code AS k_postal_code,
              k.website AS k_website, k.phone AS k_phone, k.email AS k_email, k.about AS k_about,
              k.opening_hours AS k_opening_hours, k.delivery_options AS k_delivery_options,
              k.delivery_radius AS k_delivery_radius, k.min_order_value AS k_min_order_value,
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
    g8Knowledge: {
      opening_hours: row.k_opening_hours,
      delivery_options: row.k_delivery_options,
      delivery_radius: row.k_delivery_radius,
      min_order_value: row.k_min_order_value,
    },
    mapPoint: {
      lat: row.a_lat,
      lng: row.a_lng,
      geo_precision: row.a_geo_precision,
      geocode_source: row.a_geocode_source,
      geocode_outcome: row.a_geocode_outcome,
    },
    curatedFields: row.k_curated_fields as string | null,
    fieldProvenance: row.k_field_provenance as string | null,
  };
}

// ── Fill plan ────────────────────────────────────────────────────────────
export interface FieldFillPlan {
  field: string; // "contact_email" | KnowledgeMergeField | G8KnowledgeField | MapPointField
  table: "agents" | "agent_knowledge";
  newValue: string | number | null;
}

export interface MergePlan {
  fillable: FieldFillPlan[];
  curatedSkipped: string[];
  /** G8 only: the map point (MAP_POINT_FIELDS) is moved from the duplicate. */
  mapPointMoved?: boolean;
  /** G8 only: why a map point the survivor lacks was NOT moved. */
  mapPointSkipped?: string;
  /** G8 only: the survivor's address is filled from the duplicate while the
   *  survivor keeps its own map point → re-geocode it (invalidateAgentGeocode). */
  geocodeReset?: boolean;
}

export interface FillPlanOptions {
  /** claim-merge-approve: also fill-only move G8 fields + the map point. */
  g8?: boolean;
}

function knowledgeOldValue(survivor: AgentSnapshot, field: string): ScalarValue {
  if ((G8_KNOWLEDGE_FIELDS as readonly string[]).includes(field)) return survivor.g8Knowledge[field as G8KnowledgeField];
  return survivor.knowledge[field as KnowledgeMergeField];
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
export function computeFillPlan(survivor: AgentSnapshot, duplicate: AgentSnapshot, opts: FillPlanOptions = {}): MergePlan {
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

  if (!opts.g8) return { fillable, curatedSkipped };

  // ── G8 (claim-merge-approve only) ──────────────────────────────────────
  for (const field of G8_KNOWLEDGE_FIELDS) {
    const survivorVal = survivor.g8Knowledge[field];
    const dupVal = duplicate.g8Knowledge[field];
    if (isBlankG8(survivorVal) && !isBlankG8(dupVal)) {
      if (isFieldCurated(survivor.curatedFields, field)) {
        curatedSkipped.push(field);
      } else {
        fillable.push({ field, table: "agent_knowledge", newValue: dupVal });
      }
    }
  }

  // The address the survivor will carry after the fills above.
  const addressFilled = fillable.some((f) => f.field === "address");
  const finalAddress = addressFilled ? duplicate.knowledge.address : survivor.knowledge.address;
  const finalPostal = fillable.some((f) => f.field === "postal_code") ? duplicate.knowledge.postal_code : survivor.knowledge.postal_code;

  // Any half of a point counts as "has one" — fill-only never overwrites it.
  const survivorHasPoint = survivor.mapPoint.lat !== null || survivor.mapPoint.lng !== null;
  const duplicateHasPoint = duplicate.mapPoint.lat !== null && duplicate.mapPoint.lng !== null;
  let mapPointMoved = false;
  let mapPointSkipped: string | undefined;
  if (!survivorHasPoint && duplicateHasPoint) {
    if (isFieldCurated(survivor.curatedFields, "lat") || isFieldCurated(survivor.curatedFields, "lng")) {
      curatedSkipped.push("lat", "lng");
      mapPointSkipped = "curated";
    } else if (
      // The duplicate's point belongs to the duplicate's address. Moved only
      // when the survivor ends up at that same address (or has none) — a
      // point for another address would put the farm in the wrong place; the
      // geocode worker places the survivor's own address instead.
      !isBlank(finalAddress) &&
      (normAddress(finalAddress) !== normAddress(duplicate.knowledge.address) ||
        (!isBlank(finalPostal) && !isBlank(duplicate.knowledge.postal_code) && String(finalPostal).trim() !== String(duplicate.knowledge.postal_code).trim()))
    ) {
      mapPointSkipped = "address_differs";
    } else {
      for (const field of MAP_POINT_FIELDS) {
        if (survivor.mapPoint[field] !== duplicate.mapPoint[field]) {
          fillable.push({ field, table: "agents", newValue: duplicate.mapPoint[field] });
        }
      }
      mapPointMoved = true;
    }
  }

  // Address filled from the duplicate while the survivor keeps a point that
  // was placed without that address → re-geocode (same as geocode-reset).
  const geocodeReset = addressFilled && survivorHasPoint;

  return { fillable, curatedSkipped, mapPointMoved, ...(mapPointSkipped ? { mapPointSkipped } : {}), geocodeReset };
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
export function isAlreadyMergedPair(survivor: AgentSnapshot, duplicate: AgentSnapshot): boolean {
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
export function applyMergeWrites(
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

  // G8 map point (only present with `{ g8: true }`): other `agents` columns.
  for (const f of plan.fillable) {
    if (f.table !== "agents" || f.field === "contact_email") continue;
    if (!(MAP_POINT_FIELDS as readonly string[]).includes(f.field)) throw new Error(`unexpected agents fill: ${f.field}`);
    db.prepare(`UPDATE agents SET ${f.field} = ? WHERE id = ?`).run(f.newValue, survivor.id);
    db.prepare(
      `INSERT INTO agent_knowledge_audit
         (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, 'system', NULL, datetime('now'), ?)`,
    ).run(randomUUID(), survivor.id, f.field, survivor.mapPoint[f.field as MapPointField], f.newValue, `${batchTag}: ${reason}`);
    fieldsFilled.push(f.field);
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
      const oldValue = knowledgeOldValue(survivor, f.field);
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

  // G8: the survivor's address came from the duplicate but its map point was
  // placed without it → clear the point so the geocode worker re-places it
  // (invalidateAgentGeocode, same as POST /admin/agents/:id/geocode-reset).
  // One audit row per cleared value carries the old point.
  if (plan.geocodeReset) {
    for (const field of MAP_POINT_FIELDS) {
      const old = survivor.mapPoint[field];
      if (old === null) continue;
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, ?, ?, NULL, 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), survivor.id, field, old, `${batchTag}: geocode reset (address filled from ${duplicate.id}): ${reason}`);
    }
    invalidateAgentGeocode(db, survivor.id);
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

/**
 * Row-level claim lock. A claimed duplicate always blocks the pair; a claimed
 * survivor blocks it unless the caller opted in per pair with
 * `allow_claimed_survivor: true` (default false — every other caller keeps
 * the original "either side claimed → skip" rule).
 */
export function isClaimBlocked(survivor: AgentSnapshot, duplicate: AgentSnapshot, allowClaimedSurvivor = false): boolean {
  if (duplicate.claimedAt) return true;
  return !!survivor.claimedAt && !allowClaimedSurvivor;
}

/** Dry-run preview: reads once, writes nothing. */
function planMergePair(
  db: ReturnType<typeof getDb>,
  survivorId: string,
  duplicateId: string,
  allowClaimedSurvivor = false,
): PairResult {
  const survivor = readAgentSnapshot(db, survivorId);
  const duplicate = readAgentSnapshot(db, duplicateId);
  if (!survivor || !duplicate) return { outcome: "not_found" };
  if (isClaimBlocked(survivor, duplicate, allowClaimedSurvivor)) return { outcome: "skipped_claimed" };
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
  allowClaimedSurvivor = false,
): PairResult {
  try {
    const tx = db.transaction((): PairResult => {
      const survivor = readAgentSnapshot(db, survivorId);
      const duplicate = readAgentSnapshot(db, duplicateId);
      if (!survivor || !duplicate) return { outcome: "not_found" };
      if (isClaimBlocked(survivor, duplicate, allowClaimedSurvivor)) return { outcome: "skipped_claimed" };
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
  /** Echoed only when the caller set it to true for this pair. */
  allow_claimed_survivor?: true;
  fields_filled?: string[];
  detail?: string;
}

/** Dry-run by default: only an explicit truthy form (true, 1, "1", "true" in
 *  the body, or ?apply=1|true) applies. Shared with claim-merge-approve. */
export function isExplicitApply(bodyApply: unknown, queryApply?: unknown): boolean {
  return (
    bodyApply === true ||
    bodyApply === 1 ||
    bodyApply === "1" ||
    bodyApply === "true" ||
    queryApply === "1" ||
    queryApply === "true"
  );
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { pairs?: unknown; apply?: unknown };
  const apply = isExplicitApply(body.apply, req.query?.apply);
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
    const it = (raw ?? {}) as { survivor_id?: unknown; duplicate_id?: unknown; reason?: unknown; allow_claimed_survivor?: unknown };
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

    // Strict boolean opt-in: absent/false = original behaviour; true = opt in;
    // anything else is rejected so a "true"/1 never silently means "no".
    const allowRaw = it.allow_claimed_survivor;
    if (allowRaw !== undefined && typeof allowRaw !== "boolean") {
      results.push({
        survivor_id: survivorId,
        duplicate_id: duplicateId,
        outcome: "rejected_invalid_item",
        detail: "allow_claimed_survivor_must_be_boolean",
      });
      continue;
    }
    const allowClaimedSurvivor = allowRaw === true;
    const echo = allowClaimedSurvivor ? { allow_claimed_survivor: true as const } : {};

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
      const plan = planMergePair(db, survivorId, duplicateId, allowClaimedSurvivor);
      results.push({
        survivor_id: survivorId,
        duplicate_id: duplicateId,
        outcome: plan.outcome,
        ...echo,
        ...(plan.fieldsFilled ? { fields_filled: plan.fieldsFilled } : {}),
        ...(plan.detail ? { detail: plan.detail } : {}),
      });
      continue;
    }

    const applied = applyMergePair(db, survivorId, duplicateId, reason, batchTag, allowClaimedSurvivor);
    results.push({
      survivor_id: survivorId,
      duplicate_id: duplicateId,
      outcome: applied.outcome,
      ...echo,
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
