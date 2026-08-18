// ─── Gårdssalg provider dedup MERGE lever ────────────────────────────────────
//
// dev-request 2026-07-31-gardssalg-provider-dubletter-på-tvers-av-seeds,
// spec-punkt 2 (the merge lever) — the still-open half of that dev-request as
// of 2026-08-15. Slice 1 (GET /admin/gardssalg-provider-dedup-audit,
// routes/opplevelser.ts) finds CANDIDATE duplicate groups; this module is the
// human-verified EXECUTION lever — it never detects duplicates itself, it
// only carries out an explicit {remove_id, keep_id} decision a human/session
// already verified with evidence (org_nr/BRREG/domain/contact). The auto-
// detection "scope-WHERE" question (which rows the audit endpoint scans) is
// explicitly still open/undecided and OUT OF SCOPE here.
//
// ── Daniel's survivorship rule (2026-08-15, live session) ───────────────────
// «om dem ligger som duplikater kan du fjerne den som ikke er overtatt av
//  eier, eller har dårligst data. men verifiser at det er samme produsent.»
//   1. Same-producer verification is the CALLER's job (this endpoint trusts
//      the pair it's given — it does not re-derive same-producer evidence).
//   2. A row claimed/taken over by its owner (content_source 'manual' or
//      'claim') ALWAYS survives — this is a HARD, mechanical, fail-closed
//      guard here: if `remove_id`'s row is owner-claimed, the pair is
//      REJECTED outright, regardless of what the caller asked.
//   3. Otherwise the "best data" row survives — already decided by the human
//      per-pair (which id is remove vs keep); this lever does not re-judge
//      that, only carries it out.
//
// ── What "merge" means here ──────────────────────────────────────────────
//   * FILL-ONLY field migration onto `keep_id`: for each of
//     GARDSSALG_PROVIDER_MERGE_FILL_FIELDS, `remove`'s value is copied onto
//     `keep` ONLY when `keep`'s current value is blank — a non-blank `keep`
//     field is NEVER overwritten. `products` uses gardssalgProductsEligible()
//     (experience-store.ts) for its blank-check instead of a bare
//     null/''-check, since '[]' is this codebase's own established
//     "no products yet" sentinel for that JSON-array column (see that
//     function's doc comment) — a plain isBlank() would wrongly treat a '[]'
//     `keep` row as non-blank and skip a legitimate fill.
//   * org_nr is handled SEPARATELY from the fill-only fields above, because
//     experience_providers.org_nr carries a UNIQUE constraint
//     (database/init-experiences.ts): a plain copy would leave the SAME
//     org_nr on both rows and violate it. So org_nr is MOVED, not copied —
//     `keep.org_nr` is set from `remove.org_nr` AND `remove.org_nr` is
//     cleared to NULL in the same pair-transaction — matching the "flytt org
//     X til Y" language the dev-request's own verified-pairs table uses for
//     4 of its 6 pairs.
//   * The removed row is marked, never hard-deleted: `remove.merged_into` is
//     set to `keep_id`. See that column's own doc comment
//     (init-experiences.ts) for why this mirrors `experiences.canonical_id`'s
//     survivor-pointer semantic rather than inventing a new one, and why this
//     slice deliberately does NOT also flip catalog_hidden (a separate,
//     independently-audited lever already owns that toggle, and catalog_hidden
//     is an INTEGER column — mixing it into this string-typed audit/rollback
//     machinery risked a real type-affinity bug in the shared idempotency
//     check inside planGardssalgContentRollback).
//   * Every write (fill, org_nr move on both sides, merged_into stamp) lands
//     as an ordinary `gardssalg_content_audit` row — the SAME table/shape
//     every other gårdssalg content write in this codebase already uses —
//     because both `remove_id` and `keep_id` are ordinary
//     `experience_providers` ids, so that table's existing `provider_id` FK
//     already fits both sides directly. This is the reason a SECOND audit
//     table (the pattern `experience_provider_conflict_audit` used) was NOT
//     needed here — that table exists specifically because ITS entity ids
//     (experiences.id) do NOT FK to experience_providers; this lever's ids
//     always do. See POST /admin/gardssalg-content-rollback's own rollback
//     wiring note (routes/opplevelser.ts) for how this makes the EXISTING
//     rollback endpoint (default/"provider" entity_type) already sufficient.
//
// ── Guards ──────────────────────────────────────────────────────────────
//   * remove_id === keep_id -> rejected, "samme_id".
//   * either id not found -> error, "ikke_funnet" (never blocks the rest of
//     the batch — same discipline as the outreach-preflight endpoint's own
//     ikke_funnet handling).
//   * both rows have a non-blank org_nr AND the values differ -> rejected,
//     "org_nr_konflikt_ulike_org_nr". Fail-closed, dev-request 2026-08-18-
//     gardssalg-dedup-org-nr-override point 5 — two distinct, populated org
//     numbers is positive proof of two separate companies, independent of
//     whatever GET /admin/gardssalg-provider-dedup-audit graded the pair as
//     (that route's own point-3 override is a SEPARATE, best-effort read
//     gate; this is the write-side enforcement so the decision can't be
//     gotten wrong in one place while being right in the other). Checked
//     BEFORE the survivorship/content_source guard below — a genuine org_nr
//     conflict is a harder, more objective fact than ownership-claim status.
//   * remove_id row content_source in ('manual','claim') -> rejected,
//     "eier_overtatt_kan_ikke_fjernes". Hard, unconditional, checked before
//     any write.
//   * either row already carries a non-null merged_into (already a casualty
//     or already a dead survivor of an earlier merge) -> rejected,
//     "allerede_fjernet_i_tidligere_slaaing" / "kanonisk_rad_selv_fjernet" —
//     guards against re-merging an already-resolved row or silently
//     re-targeting a duplicate onto a row that is itself no longer live.
//     Deliberately does NOT block a legitimate CHAIN across pairs in one
//     batch (remove A into B, then remove B into C) — that mirrors the
//     experiences-table canonical_id machinery's own accepted A→B→C hop
//     pattern (see experience-store.ts's resolveCanonicalSlugForDuplicate
//     doc comment).
//
// apply is dry-run by DEFAULT at the route layer (mirrors every other admin
// write route in this file). previewGardssalgProviderMergePair() is a pure
// read (zero writes) computing exactly what applyGardssalgProviderMergePair()
// would do; both share the SAME evaluation logic (evaluatePair below) so a
// dry-run can never drift from what apply actually does. Each pair is applied
// in its OWN transaction, re-evaluated fresh immediately before writing
// (inside that transaction) — one pair's failure/rejection never aborts the
// batch or half-writes another.

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { gardssalgProductsEligible } from "./experience-store";

/** Hard cap per call — mirrors MAX_GARDSSALG_PREFLIGHT_BATCH's convention (routes/opplevelser.ts). */
export const GARDSSALG_PROVIDER_MERGE_MAX_PAIRS = 200;

/** source_url marker stamped on every gardssalg_content_audit row this lever inserts. */
export const GARDSSALG_PROVIDER_MERGE_MARKER = "internal://provider-merge";

/**
 * Plain scalar contact/content fields fill-only migrated from `remove` onto
 * `keep`. org_nr is handled separately (moved, not copied — see module doc
 * comment above) and is NOT in this list. All eight are already members of
 * GARDSSALG_ROLLBACKABLE_FIELDS (experience-store.ts).
 */
export const GARDSSALG_PROVIDER_MERGE_FILL_FIELDS = [
  "epost",
  "telefon",
  "mobil",
  "hjemmeside",
  "about_text",
  "visit_text",
  "opening_hours_text",
  "products",
] as const;
export type GardssalgProviderMergeFillField = (typeof GARDSSALG_PROVIDER_MERGE_FILL_FIELDS)[number];

interface GardssalgProviderMergeSnapshot {
  id: string;
  content_source: string | null;
  merged_into: string | null;
  org_nr: string | null;
  epost: string | null;
  telefon: string | null;
  mobil: string | null;
  hjemmeside: string | null;
  about_text: string | null;
  visit_text: string | null;
  opening_hours_text: string | null;
  products: string | null;
}

const SNAPSHOT_COLUMNS =
  "id, content_source, merged_into, org_nr, epost, telefon, mobil, hjemmeside, about_text, visit_text, opening_hours_text, products";

function readSnapshot(db: Database.Database, id: string): GardssalgProviderMergeSnapshot | null {
  const row = db.prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM experience_providers WHERE id = ?`).get(id) as
    | GardssalgProviderMergeSnapshot
    | undefined;
  return row ?? null;
}

/** '' and NULL both count as "blank" for the plain scalar fields. */
function isBlank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v === "";
}

/**
 * Blank-check for one fill field, matching each field's own established
 * "empty" convention: `products` defers to gardssalgProductsEligible()
 * (null/''/'[]'/parsed-empty-array all count as blank — the same rule
 * content-refresh's own products writer already uses), every other field is
 * a plain string blank-check.
 */
function isFieldBlank(field: GardssalgProviderMergeFillField, value: string | null): boolean {
  if (field === "products") return gardssalgProductsEligible(value);
  return isBlank(value);
}

export interface GardssalgProviderMergeFillPlan {
  fillableFields: GardssalgProviderMergeFillField[];
  orgNrMigrate: boolean;
}

/** Pure: computes the fill-only plan from two already-read snapshots. */
function computeFillPlan(
  keep: GardssalgProviderMergeSnapshot,
  remove: GardssalgProviderMergeSnapshot,
): GardssalgProviderMergeFillPlan {
  const fillableFields: GardssalgProviderMergeFillField[] = [];
  for (const field of GARDSSALG_PROVIDER_MERGE_FILL_FIELDS) {
    if (isFieldBlank(field, keep[field]) && !isFieldBlank(field, remove[field])) {
      fillableFields.push(field);
    }
  }
  const orgNrMigrate = isBlank(keep.org_nr) && !isBlank(remove.org_nr);
  return { fillableFields, orgNrMigrate };
}

export type GardssalgProviderMergeOutcome = "merged" | "would_merge" | "rejected" | "error";

export interface GardssalgProviderMergeResultItem {
  remove_id: string;
  keep_id: string;
  outcome: GardssalgProviderMergeOutcome;
  reason: string | null;
  fields_filled: GardssalgProviderMergeFillField[];
  org_nr_migrated: boolean;
}

type PairEvaluation =
  | { ok: true; keep: GardssalgProviderMergeSnapshot; remove: GardssalgProviderMergeSnapshot; plan: GardssalgProviderMergeFillPlan }
  | { ok: false; outcome: "rejected" | "error"; reason: string };

/**
 * Every guard this lever enforces, in order, against a FRESH read of both
 * rows. Shared by the dry-run preview and the apply path (apply re-runs this
 * again inside its own transaction immediately before writing) so the two
 * can never diverge.
 */
function evaluatePair(db: Database.Database, removeId: string, keepId: string): PairEvaluation {
  if (removeId === keepId) {
    return { ok: false, outcome: "rejected", reason: "samme_id" };
  }
  const remove = readSnapshot(db, removeId);
  const keep = readSnapshot(db, keepId);
  if (!remove || !keep) {
    return { ok: false, outcome: "error", reason: "ikke_funnet" };
  }
  // Fail-closed org_nr guard (dev-request 2026-08-18-gardssalg-dedup-org-nr-
  // override, point 5) — enforced HERE at the write route itself, not only
  // at the audit route, so this decision can't be gotten wrong in one place
  // while being right in the other. Two distinct, non-blank org_nr values is
  // positive proof of two separate companies; no caller-supplied pair can
  // override it.
  const removeOrgNr = remove.org_nr && remove.org_nr.trim() ? remove.org_nr.trim() : null;
  const keepOrgNr = keep.org_nr && keep.org_nr.trim() ? keep.org_nr.trim() : null;
  if (removeOrgNr && keepOrgNr && removeOrgNr !== keepOrgNr) {
    return { ok: false, outcome: "rejected", reason: "org_nr_konflikt_ulike_org_nr" };
  }
  // Hard, mechanical, fail-closed guard (survivorship rule §2) — checked
  // before anything else about the pair's data, and never overridable by
  // whatever the caller's `note` says.
  if (remove.content_source === "manual" || remove.content_source === "claim") {
    return { ok: false, outcome: "rejected", reason: "eier_overtatt_kan_ikke_fjernes" };
  }
  if (remove.merged_into !== null) {
    return { ok: false, outcome: "rejected", reason: "allerede_fjernet_i_tidligere_slaaing" };
  }
  if (keep.merged_into !== null) {
    return { ok: false, outcome: "rejected", reason: "kanonisk_rad_selv_fjernet" };
  }
  return { ok: true, keep, remove, plan: computeFillPlan(keep, remove) };
}

/** Dry-run preview for one pair: pure read, zero writes. */
export function previewGardssalgProviderMergePair(
  db: Database.Database,
  removeId: string,
  keepId: string,
): GardssalgProviderMergeResultItem {
  const ev = evaluatePair(db, removeId, keepId);
  if (!ev.ok) {
    return { remove_id: removeId, keep_id: keepId, outcome: ev.outcome, reason: ev.reason, fields_filled: [], org_nr_migrated: false };
  }
  return {
    remove_id: removeId,
    keep_id: keepId,
    outcome: "would_merge",
    reason: null,
    fields_filled: ev.plan.fillableFields.slice(),
    org_nr_migrated: ev.plan.orgNrMigrate,
  };
}

function insertAuditRow(
  db: Database.Database,
  args: { provider_id: string; field_name: string; old_value: string | null; new_value: string | null; batchId: string; notes: string | null },
): void {
  db.prepare(
    `INSERT INTO gardssalg_content_audit
       (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at, notes)
     VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, 'system', datetime('now'), @notes)`,
  ).run({
    id: uuid(),
    provider_id: args.provider_id,
    field_name: args.field_name,
    old_value: args.old_value,
    new_value: args.new_value,
    source_url: GARDSSALG_PROVIDER_MERGE_MARKER,
    batch_id: args.batchId,
    notes: args.notes,
  });
}

/**
 * Apply one pair inside its own transaction: re-evaluates fresh (a row
 * claimed/merged/changed between an earlier dry-run and this call is caught
 * here, not trusted from a stale caller-side read), then — if the pair still
 * passes — fill-only migrates the plan's fields onto `keep`, moves org_nr if
 * eligible, and stamps `remove.merged_into = keep_id`. One
 * gardssalg_content_audit row per field actually written (fill fields +
 * org_nr on both sides + merged_into), all sharing `batchId` so a single
 * POST /admin/gardssalg-content-rollback { batch_id } call restores the
 * entire pair. One pair's failure (caught here) never aborts the caller's
 * batch loop.
 */
export function applyGardssalgProviderMergePair(
  db: Database.Database,
  removeId: string,
  keepId: string,
  note: string | null,
  batchId: string,
): GardssalgProviderMergeResultItem {
  try {
    const tx = db.transaction((): GardssalgProviderMergeResultItem => {
      const ev = evaluatePair(db, removeId, keepId);
      if (!ev.ok) {
        return { remove_id: removeId, keep_id: keepId, outcome: ev.outcome, reason: ev.reason, fields_filled: [], org_nr_migrated: false };
      }
      const { keep, remove, plan } = ev;

      for (const field of plan.fillableFields) {
        const newValue = remove[field];
        db.prepare(`UPDATE experience_providers SET ${field} = @val, updated_at = datetime('now') WHERE id = @id`).run({
          val: newValue,
          id: keep.id,
        });
        insertAuditRow(db, { provider_id: keep.id, field_name: field, old_value: keep[field], new_value: newValue, batchId, notes: note });
      }

      if (plan.orgNrMigrate) {
        // Clear the REMOVE side FIRST: org_nr carries a UNIQUE constraint, so
        // setting keep.org_nr to remove.org_nr while remove.org_nr is still
        // populated would collide with itself (both rows briefly holding the
        // same value) and fail the constraint, even within one transaction —
        // SQLite enforces UNIQUE immediately, not deferred.
        db.prepare(`UPDATE experience_providers SET org_nr = NULL, updated_at = datetime('now') WHERE id = ?`).run(remove.id);
        insertAuditRow(db, { provider_id: remove.id, field_name: "org_nr", old_value: remove.org_nr, new_value: null, batchId, notes: note });

        db.prepare(`UPDATE experience_providers SET org_nr = ?, updated_at = datetime('now') WHERE id = ?`).run(remove.org_nr, keep.id);
        insertAuditRow(db, { provider_id: keep.id, field_name: "org_nr", old_value: keep.org_nr, new_value: remove.org_nr, batchId, notes: note });
      }

      db.prepare(`UPDATE experience_providers SET merged_into = ?, updated_at = datetime('now') WHERE id = ?`).run(keep.id, remove.id);
      insertAuditRow(db, { provider_id: remove.id, field_name: "merged_into", old_value: null, new_value: keep.id, batchId, notes: note });

      return {
        remove_id: removeId,
        keep_id: keepId,
        outcome: "merged",
        reason: null,
        fields_filled: plan.fillableFields.slice(),
        org_nr_migrated: plan.orgNrMigrate,
      };
    });
    return tx();
  } catch (e: any) {
    return {
      remove_id: removeId,
      keep_id: keepId,
      outcome: "error",
      reason: `write_failed: ${e?.message ?? String(e)}`,
      fields_filled: [],
      org_nr_migrated: false,
    };
  }
}
