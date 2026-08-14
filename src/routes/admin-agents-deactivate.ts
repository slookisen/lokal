// ─── Admin: POST /admin/agents/deactivate ────────────────────────────────
//
// A new admin write-lever that fills a real gap between two existing ones:
//   * POST /admin/agents/duplicate-merge requires a PAIR (survivor + dup).
//   * DELETE /admin/agents/:id refuses any row that has history.
// Neither can handle "this one STANDALONE row is bad on its own" — wrong
// entity, a permanently closed business, a catalog mistake with no merge
// partner. This route is that lever: it deactivates (never deletes) one or
// more agents rows identified as catalog-hygiene problems, given an
// explicit caller-supplied {id, reason, evidence} decision per row. It
// NEVER detects bad rows itself — it only executes a decision someone else
// already made, evidence in hand. Mirrors the write/lock/audit discipline
// of admin-agents-duplicate-merge.ts:
//
//   * dry-run by DEFAULT. `apply` must be an explicit truthy form.
//   * Both `reason` AND `evidence` are REQUIRED non-empty strings per item —
//     this is evidence-based hygiene, not guesswork. Missing/blank either
//     one rejects that item (rejected_invalid_item), never the whole batch.
//   * Row-level lock, NO override flag (deliberately narrower than
//     duplicate-merge's per-field curated lock — this is a blunter,
//     higher-blast-radius write, so v1 keeps it simple and un-bypassable):
//       - `agents.claimed_at` set              -> skipped_claimed
//       - ANY truthy key in agent_knowledge.curated_fields -> skipped_curated
//     A curated/owner-touched row is not what this lever is for; if one
//     genuinely needs deactivating, that's a human decision via a different
//     path, not a param bypass here.
//   * Both locks are re-read from a FRESH snapshot immediately before the
//     write, inside that write's own transaction (same anti-race discipline
//     as applyMergePair in duplicate-merge — a row locked/claimed between
//     the outer scan and this write is left alone).
//   * Already-inactive (`is_active = 0` already) -> skipped_already_inactive,
//     a no-op, not an error. Batches are safe to re-run (idempotent).
//   * Write (apply path only): `UPDATE agents SET is_active = 0 WHERE id = ?`
//     — does NOT touch `merged_into` (that column means "merged into this
//     other agent", which is not what's happening here; it stays NULL/as-is).
//   * One `agent_knowledge_audit` row per deactivated item:
//       field_name = 'is_active', old_value = '1', new_value = '0',
//       changed_by = 'system', notes = '<batch_tag>: <reason> | evidence: <evidence>'
//     The old_value/new_value pair on `is_active` is exactly what makes this
//     reversible:
//       ROLLBACK RECIPE: UPDATE agents SET is_active = 1 WHERE id = ?
//       (per audited row, e.g. from the batch_tag surfaced in the response.)
//   * Every item is processed in its OWN transaction — one item's failure
//     never aborts the batch or half-writes another.
//   * Same-id reused twice in one request -> second occurrence rejected
//     (rejected_invalid_item, detail id_already_used_in_batch).
//   * Unknown id -> not_found.
//   * Batch capped at AGENT_DEACTIVATE_MAX_ITEMS (25) per call — deliberately
//     smaller than duplicate-merge's 50: this is a newer, higher-blast-radius
//     lever (irreversible-looking to every live-facing surface at once,
//     unlike a fill-only field merge).

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";

const router = Router();

// ── Injectable DB seam (tests only) ─────────────────────────────────────────
// Same seam convention as admin-agents-duplicate-merge.ts
// (__setDuplicateMergeDbForTesting) — production code never calls the setter.
let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;

/** Test-only. Pass null to clear. Never called by production code. */
export function __setAgentDeactivateDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}

function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

// Copied (not shared) — same convention as every sibling admin-agents-*
// write route (duplicate-merge, contact-email-write, url-write) each keep
// their own copy of getAdminKey/requireAdmin rather than importing a shared
// util; there is no shared util for this in the codebase.
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

/** Hard cap per call — smaller than DUPLICATE_MERGE_MAX_PAIRS (50) on purpose. */
export const AGENT_DEACTIVATE_MAX_ITEMS = 25;

/**
 * True iff the parsed curated_fields JSON has ANY truthy key at all — this
 * route locks on the row being curated/owner-touched in ANY respect, unlike
 * duplicate-merge's per-field curated lock (which only cares about the one
 * field it's about to fill). Tolerates malformed/missing JSON as "not
 * curated" (same defensive convention as isFieldCurated in
 * admin-agents-duplicate-merge.ts).
 */
export function hasAnyCuratedField(curatedFieldsJson: string | null | undefined): boolean {
  if (!curatedFieldsJson) return false;
  try {
    const parsed = JSON.parse(curatedFieldsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.values(parsed as Record<string, unknown>).some((v) => !!v);
  } catch {
    return false;
  }
}

// ── Row snapshot ─────────────────────────────────────────────────────────
interface AgentSnapshot {
  id: string;
  claimedAt: string | null;
  isActive: boolean;
  curatedFields: string | null;
}

/**
 * LEFT JOIN, not INNER: an agent may legitimately have no agent_knowledge
 * row at all (same reasoning as duplicate-merge's readAgentSnapshot) — an
 * INNER JOIN here would silently make such rows un-deactivatable.
 */
function readAgentSnapshot(db: ReturnType<typeof getDb>, id: string): AgentSnapshot | null {
  const row = db
    .prepare(
      `SELECT a.id AS a_id, a.claimed_at AS a_claimed_at, a.is_active AS a_is_active,
              k.curated_fields AS k_curated_fields
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(id) as Record<string, string | number | null> | undefined;

  if (!row) return null;
  return {
    id: row.a_id as string,
    claimedAt: row.a_claimed_at as string | null,
    // agents.is_active is SQLite INTEGER DEFAULT 1 — 0 is false, anything
    // else (including NULL, defensively) is truthy/active, same convention
    // as duplicate-merge's readAgentSnapshot.
    isActive: row.a_is_active !== 0,
    curatedFields: row.k_curated_fields as string | null,
  };
}

type ItemOutcome =
  | "would_deactivate"
  | "deactivated"
  | "skipped_claimed"
  | "skipped_curated"
  | "skipped_already_inactive"
  | "not_found"
  | "rejected_invalid_item"
  | "error";

interface ItemResult {
  outcome: ItemOutcome;
  detail?: string;
}

/**
 * Shared lock/state decision, given a fresh snapshot. Used identically by
 * both the dry-run preview and the apply-time re-check immediately before
 * writing, so the two paths can never disagree about what would happen.
 */
function decideOutcome(snapshot: AgentSnapshot | null): ItemResult {
  if (!snapshot) return { outcome: "not_found" };
  if (!snapshot.isActive) return { outcome: "skipped_already_inactive" };
  if (snapshot.claimedAt) return { outcome: "skipped_claimed" };
  if (hasAnyCuratedField(snapshot.curatedFields)) return { outcome: "skipped_curated" };
  return { outcome: "would_deactivate" };
}

/** Dry-run preview: reads once, writes nothing. */
function planDeactivate(db: ReturnType<typeof getDb>, id: string): ItemResult {
  return decideOutcome(readAgentSnapshot(db, id));
}

/**
 * Apply one item inside its own transaction. Re-reads claimed_at +
 * curated_fields (via a fresh readAgentSnapshot) immediately before writing,
 * inside this same transaction — a row locked/claimed/inactivated between
 * the outer scan and this write is left alone. One item's failure (caught
 * below) never aborts the batch.
 */
function applyDeactivate(
  db: ReturnType<typeof getDb>,
  id: string,
  reason: string,
  evidence: string,
  batchTag: string,
): ItemResult {
  try {
    const tx = db.transaction((): ItemResult => {
      const snapshot = readAgentSnapshot(db, id);
      const decision = decideOutcome(snapshot);
      if (decision.outcome !== "would_deactivate") {
        // Map the dry-run label onto the terminal (no-write) outcome set.
        return decision;
      }

      db.prepare(`UPDATE agents SET is_active = 0 WHERE id = ?`).run(id);
      db.prepare(
        `INSERT INTO agent_knowledge_audit
           (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
         VALUES (?, ?, 'is_active', '1', '0', 'system', NULL, datetime('now'), ?)`,
      ).run(randomUUID(), id, `${batchTag}: ${reason} | evidence: ${evidence}`);

      return { outcome: "deactivated" };
    });
    return tx();
  } catch (e: any) {
    return { outcome: "error", detail: e?.message ?? String(e) };
  }
}

interface ResultItem {
  id: string;
  outcome: ItemOutcome;
  detail?: string;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { items?: unknown; apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const dryRun = !apply;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    res
      .status(400)
      .json({ error: "Body must contain a non-empty 'items' array of {id, reason, evidence}" });
    return;
  }
  if (body.items.length > AGENT_DEACTIVATE_MAX_ITEMS) {
    res.status(400).json({ error: `Too many items (max ${AGENT_DEACTIVATE_MAX_ITEMS} per call)` });
    return;
  }

  const batchTag = `deactivate-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const db = resolveDb();
  const results: ResultItem[] = [];
  // Every id that has already appeared in an earlier, structurally-valid
  // item within THIS request — deactivating the same row twice in one call
  // is not supported (mirrors duplicate-merge's usedIds discipline).
  const usedIds = new Set<string>();

  for (const raw of body.items as unknown[]) {
    const it = (raw ?? {}) as { id?: unknown; reason?: unknown; evidence?: unknown };
    const id = typeof it.id === "string" ? it.id.trim() : "";
    const reason = typeof it.reason === "string" ? it.reason.trim() : "";
    const evidence = typeof it.evidence === "string" ? it.evidence.trim() : "";

    if (!id || !reason || !evidence) {
      results.push({
        id: id || "(missing)",
        outcome: "rejected_invalid_item",
        detail: "id, reason, and evidence are all required",
      });
      continue;
    }

    if (usedIds.has(id)) {
      results.push({ id, outcome: "rejected_invalid_item", detail: "id_already_used_in_batch" });
      continue;
    }
    usedIds.add(id);

    if (dryRun) {
      const plan = planDeactivate(db, id);
      results.push({ id, outcome: plan.outcome, ...(plan.detail ? { detail: plan.detail } : {}) });
      continue;
    }

    const applied = applyDeactivate(db, id, reason, evidence, batchTag);
    results.push({ id, outcome: applied.outcome, ...(applied.detail ? { detail: applied.detail } : {}) });
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    dry_run: dryRun,
    batch_tag: batchTag,
    scanned: (body.items as unknown[]).length,
    counts,
    results,
  });
});

export default router;
