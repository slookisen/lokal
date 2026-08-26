// ─── Experience Canonical-Group Merge — explicit merge of two ALREADY-
//     ASSIGNED canonical_id groups ───────────────────────────────────────
//
// dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
// AC4 (Ringve, Trondheim). Background: PR #725 (services/experience-
// provider-canonicalize.ts) merges DUPLICATE PROVIDER rows and repoints
// every still-live `experiences.provider_id` from the removed provider onto
// the kept one — but that alone does not fold the two businesses' raw
// experience rows into one CATALOG listing, because the experience-row
// dedup pass (runDedupPass/groupDuplicateCandidates, experience-dedup.ts)
// only clusters rows that are STILL UNASSIGNED (`canonical_id IS NULL`,
// loadDedupCandidates()'s own WHERE clause) — it never revisits two groups
// that were ALREADY each assigned a canonical_id by an earlier pass, however
// similar their titles now look post-provider-merge. Confirmed live
// 2026-08-26: Ringve's rows now all share one `provider_id` (after #725) but
// remain split across two `canonical_id` groups (~3 rows / ~14 rows), because
// titlesMatch()'s fuzzy title bar didn't originally consider them similar
// enough to bucket together.
//
// This module is the explicit, opt-in fix for exactly that shape: given two
// canonical_id values a human/operator ALREADY KNOWS are the same real-world
// business (e.g. because a provider-level merge just proved it), fold the
// `remove` group into the `keep` group. NO fuzzy title matching here, NO
// change to titlesMatch()/groupDuplicateCandidates()/runDedupPass() — this
// is a separate, narrower lever than the dedup backfill, for a caller who
// already has the answer.
//
// PROVIDER-SCOPING GUARD — design choice (see this module's own PR body for
// the fuller writeup): groupDuplicateCandidates() buckets candidate rows by
// `providerIdentityKey(row) + kommune`, and providerIdentityKey() prefers
// org_nr over provider_id ("org_nr when known, else provider_id" —
// experience-dedup.ts). That means a SINGLE existing canonical_id group can
// already legitimately span MULTIPLE `provider_id` values whenever two
// different (not-yet-merged) provider rows share one org_nr. So this module
// can NOT safely assume "same provider_id" is a property either input group
// already has — requiring the two groups' OWN provider_ids to already match
// would either reject some genuinely-safe merges (two org_nr-linked groups
// with different provider_ids) or, worse, silently accept a merge on a
// group that itself already mixes provider_ids without ever checking the
// caller's actual intent. Per the task's documented fallback, the guard here
// is instead an EXPLICIT, caller-supplied `expected_provider_id`: every row
// currently live in EITHER group (the anchor row plus every row already
// pointing `canonical_id` at it) must have `provider_id === expected_provider_id`,
// or the whole call fails closed (400) before writing anything. This is
// simple, deterministic, and matches the real trigger for this tool (an
// operator who just ran the provider-merge endpoint and knows the resulting
// shared provider_id) without guessing at cross-provider org_nr scenarios
// this module was never asked to reason about.
//
// Never DELETEs a row — only ever repoints `experiences.canonical_id`
// (insert-only/no-DELETE, same convention as every sibling admin lever in
// this codebase). Idempotent: once `remove_canonical_id`'s rows have all
// been repointed onto `keep_canonical_id`, NOTHING (not even its own former
// anchor row) still has `canonical_id = remove_canonical_id` nor
// `id = remove_canonical_id AND canonical_id IS NULL`, so a second dry-run OR
// apply call for the exact same pair naturally reports zero rows to move —
// no special-cased "already done" branch needed.

import type Database from "better-sqlite3";

export interface CanonicalGroupMergeRowOut {
  id: string;
  title: string;
  provider_id: string | null;
}

/**
 * Every row currently LIVE in the group anchored at `canonicalId`: the
 * anchor row itself (`id = canonicalId`) IF it is still canonical
 * (`canonical_id IS NULL`), plus every row already merged into it
 * (`canonical_id = canonicalId`). Once `canonicalId`'s own row has been
 * repointed elsewhere (e.g. by a prior call to applyCanonicalGroupMerge()),
 * both halves of this OR naturally match nothing — this is exactly what
 * makes a repeat call see an empty group instead of needing a separate
 * "already merged" check.
 */
function loadCanonicalGroupRows(db: Database.Database, canonicalId: string): CanonicalGroupMergeRowOut[] {
  return db
    .prepare(
      `SELECT id, title, provider_id FROM experiences
        WHERE canonical_id = @canonicalId
           OR (id = @canonicalId AND canonical_id IS NULL)
        ORDER BY id`,
    )
    .all({ canonicalId }) as CanonicalGroupMergeRowOut[];
}

interface ValidationOk {
  ok: true;
  removeGroupRows: CanonicalGroupMergeRowOut[];
}
interface ValidationFail {
  ok: false;
  status: number;
  error: string;
}
type Validation = ValidationOk | ValidationFail;

/**
 * Shared preview/apply validation. Fails closed (400-shaped) on:
 *   - missing keep_canonical_id / remove_canonical_id
 *   - keep_canonical_id === remove_canonical_id
 *   - missing expected_provider_id
 *   - keep_canonical_id does not resolve to an EXISTING, currently-canonical
 *     row (`canonical_id IS NULL`) — merging INTO a row that is itself not
 *     canonical would leave the moved rows pointing at a canonical_id that
 *     is not itself surfaced by any read path (every read path only ever
 *     resolves ONE level: `canonical_id IS NULL`), silently hiding them.
 *   - remove_canonical_id does not resolve to any existing `experiences` row
 *     at all (a garbage/typo'd id — NOT required to still be canonical,
 *     since a repeat call after a prior successful merge legitimately finds
 *     remove_canonical_id no longer canonical; that is the idempotent
 *     zero-rows case, not an error)
 *   - any row currently live in EITHER group has a provider_id different
 *     from expected_provider_id (provider-scoping guard, see module header)
 */
function validate(
  db: Database.Database,
  keepId: string,
  removeId: string,
  expectedProviderId: string,
): Validation {
  if (!keepId || !removeId) {
    return { ok: false, status: 400, error: "keep_canonical_id og remove_canonical_id er begge påkrevd" };
  }
  if (keepId === removeId) {
    return { ok: false, status: 400, error: "keep_canonical_id og remove_canonical_id kan ikke være samme id" };
  }
  if (!expectedProviderId) {
    return { ok: false, status: 400, error: "expected_provider_id er påkrevd" };
  }

  const keepAnchor = db.prepare(`SELECT id, canonical_id FROM experiences WHERE id = ?`).get(keepId) as
    | { id: string; canonical_id: string | null }
    | undefined;
  if (!keepAnchor || keepAnchor.canonical_id !== null) {
    return {
      ok: false,
      status: 400,
      error: `keep_canonical_id ('${keepId}') er ikke en eksisterende canonical rad (canonical_id må være NULL)`,
    };
  }

  const removeAnchor = db.prepare(`SELECT id FROM experiences WHERE id = ?`).get(removeId) as
    | { id: string }
    | undefined;
  if (!removeAnchor) {
    return { ok: false, status: 400, error: `remove_canonical_id ('${removeId}') finnes ikke` };
  }

  const keepGroupRows = loadCanonicalGroupRows(db, keepId);
  const removeGroupRows = loadCanonicalGroupRows(db, removeId);

  const mismatched = [...keepGroupRows, ...removeGroupRows].filter(
    (r) => r.provider_id !== expectedProviderId,
  );
  if (mismatched.length > 0) {
    return {
      ok: false,
      status: 400,
      error:
        `provider_mismatch: ${mismatched.length} rad(er) har annen provider_id enn expected_provider_id ` +
        `('${expectedProviderId}'): ${mismatched.map((r) => `${r.id} (provider_id=${r.provider_id ?? "null"})`).join(", ")}`,
    };
  }

  return { ok: true, removeGroupRows };
}

export type CanonicalGroupMergeFailure = { ok: false; status: number; error: string };

export interface CanonicalGroupMergePreview {
  ok: true;
  keep_canonical_id: string;
  remove_canonical_id: string;
  rows_to_move: CanonicalGroupMergeRowOut[];
}

/** Dry-run: zero writes either way. Reports exactly the rows an apply call would move. */
export function previewCanonicalGroupMerge(
  db: Database.Database,
  keepId: string,
  removeId: string,
  expectedProviderId: string,
): CanonicalGroupMergePreview | CanonicalGroupMergeFailure {
  const validation = validate(db, keepId, removeId, expectedProviderId);
  if (!validation.ok) return validation;
  return {
    ok: true,
    keep_canonical_id: keepId,
    remove_canonical_id: removeId,
    rows_to_move: validation.removeGroupRows,
  };
}

export interface CanonicalGroupMergeApply {
  ok: true;
  keep_canonical_id: string;
  remove_canonical_id: string;
  rows_moved: CanonicalGroupMergeRowOut[];
}

/**
 * Apply: repoints every row currently live in the `remove_canonical_id`
 * group (its anchor row, if still canonical, plus every row already
 * pointing at it) onto `keep_canonical_id`, and unions their ids into
 * `keep_canonical_id`'s own `merged_from` JSON array — same convention
 * runDedupPass()/the un-merge route already use for that column. NEVER
 * deletes a row. A validation failure writes nothing. An empty
 * `rows_to_move` (already-merged pair, called again) is a true no-op — one
 * synchronous transaction either way, so no partial-write state is
 * observable by a concurrent request.
 */
export function applyCanonicalGroupMerge(
  db: Database.Database,
  keepId: string,
  removeId: string,
  expectedProviderId: string,
): CanonicalGroupMergeApply | CanonicalGroupMergeFailure {
  const validation = validate(db, keepId, removeId, expectedProviderId);
  if (!validation.ok) return validation;

  const rowsToMove = validation.removeGroupRows;
  if (rowsToMove.length === 0) {
    return { ok: true, keep_canonical_id: keepId, remove_canonical_id: removeId, rows_moved: [] };
  }

  const repoint = db.prepare(
    `UPDATE experiences SET canonical_id = @keepId, updated_at = datetime('now')
      WHERE canonical_id = @removeId OR (id = @removeId AND canonical_id IS NULL)`,
  );
  const getMergedFrom = db.prepare(`SELECT merged_from FROM experiences WHERE id = ?`);
  const setMergedFrom = db.prepare(
    `UPDATE experiences SET merged_from = @mergedFrom, updated_at = datetime('now') WHERE id = @id`,
  );

  const tx = db.transaction(() => {
    repoint.run({ keepId, removeId });

    const existingRaw = (getMergedFrom.get(keepId) as { merged_from: string | null } | undefined)
      ?.merged_from;
    let existingIds: string[] = [];
    if (existingRaw) {
      try {
        const parsed = JSON.parse(existingRaw);
        if (Array.isArray(parsed)) existingIds = parsed.map(String);
      } catch {
        /* corrupt/legacy value — start fresh rather than throw */
      }
    }
    const newIds = rowsToMove.map((r) => r.id);
    const mergedIds = Array.from(new Set([...existingIds, ...newIds]));
    setMergedFrom.run({ mergedFrom: JSON.stringify(mergedIds), id: keepId });
  });
  tx();

  return { ok: true, keep_canonical_id: keepId, remove_canonical_id: removeId, rows_moved: rowsToMove };
}
