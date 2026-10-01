// ─── Admin: POST /admin/agents/claim-backfill ────────────────────────────
// dev-request 2026-10-01-rfb-eierkrav-utelates-fra-outreach (spec item 3).
//
// One-shot backfill: every agent with a VERIFIED agent_claims row but
// agents.claimed_at IS NULL gets claimed_at = earliest verified_at of its
// verified claims (fallback created_at, then now) and claimed_via = 'claim'
// (only when NULL). verifyClaim now stamps this on new claims; this route
// covers the claims verified before that fix.
//
//   * dry-run by DEFAULT. Writes only with an explicit `apply` (true/1/"1"/
//     "true" in body, or ?apply=1|true).
//   * Response lists {id, name, claimed_at(planned/applied), claim_id}
//     for every affected agent — store the dry-run list in A2A BEFORE apply.
//   * apply writes inside ONE transaction; the UPDATE is guarded by
//     `claimed_at IS NULL`, so a row set meanwhile is never overwritten and a
//     second apply is a no-op (idempotent).
//   * One agent_knowledge_audit row per changed agent:
//       field_name='claimed_at', old_value=NULL, new_value=<date>,
//       changed_by='system', notes='<batch_tag>: claim-backfill ...'
//   ROLLBACK RECIPE: for each audit row with notes LIKE '<batch_tag>%':
//     UPDATE agents SET claimed_at = NULL, claimed_via = NULL WHERE id = <agent_id>
//   (claimed_via is also NULL-restored: it was only stamped when NULL, and an
//   agent with claimed_at NULL had no claim stamp before this route.)

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { getDb } from "../database/init";

const router = Router();

let dbOverrideForTesting: ReturnType<typeof getDb> | null = null;
/** Test-only. Pass null to clear. */
export function __setClaimBackfillDbForTesting(db: ReturnType<typeof getDb> | null): void {
  dbOverrideForTesting = db;
}
function resolveDb(): ReturnType<typeof getDb> {
  return dbOverrideForTesting ?? getDb();
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  if (((req.headers["x-admin-key"] as string) || "") !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

export interface ClaimBackfillItem {
  id: string;
  name: string;
  claimed_at: string;
  claim_id: string;
  claimant_email: string | null;
}

/** Agents with a verified claim and NULL claimed_at (read-only). */
export function selectClaimBackfillItems(db: ReturnType<typeof getDb>, nowIso: string): ClaimBackfillItem[] {
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.name AS name,
              (SELECT c.id FROM agent_claims c
                WHERE c.agent_id = a.id AND c.status = 'verified'
                ORDER BY COALESCE(c.verified_at, c.created_at) ASC, c.id ASC LIMIT 1) AS claim_id,
              (SELECT c.claimant_email FROM agent_claims c
                WHERE c.agent_id = a.id AND c.status = 'verified'
                ORDER BY COALESCE(c.verified_at, c.created_at) ASC, c.id ASC LIMIT 1) AS claimant_email,
              (SELECT MIN(COALESCE(c.verified_at, c.created_at)) FROM agent_claims c
                WHERE c.agent_id = a.id AND c.status = 'verified') AS claim_date
         FROM agents a
        WHERE a.claimed_at IS NULL
          AND EXISTS (SELECT 1 FROM agent_claims c WHERE c.agent_id = a.id AND c.status = 'verified')
        ORDER BY a.id`,
    )
    .all() as Array<{ id: string; name: string; claim_id: string; claimant_email: string | null; claim_date: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    claimed_at: r.claim_date || nowIso,
    claim_id: r.claim_id,
    claimant_email: r.claimant_email,
  }));
}

/** Apply in one transaction; returns the items actually changed. */
export function applyClaimBackfill(
  db: ReturnType<typeof getDb>,
  items: ClaimBackfillItem[],
  batchTag: string,
): ClaimBackfillItem[] {
  const upd = db.prepare(
    `UPDATE agents SET claimed_at = ?, claimed_via = COALESCE(claimed_via, 'claim')
      WHERE id = ? AND claimed_at IS NULL`,
  );
  const audit = db.prepare(
    `INSERT INTO agent_knowledge_audit (id, agent_id, field_name, old_value, new_value, changed_by, notes)
     VALUES (?, ?, 'claimed_at', NULL, ?, 'system', ?)`,
  );
  const changed: ClaimBackfillItem[] = [];
  db.transaction(() => {
    for (const it of items) {
      const r = upd.run(it.claimed_at, it.id);
      if (r.changes === 1) {
        audit.run(randomUUID(), it.id, it.claimed_at, `${batchTag}: claim-backfill (verified claim ${it.claim_id})`);
        changed.push(it);
      }
    }
  })();
  return changed;
}

router.post("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as { apply?: unknown };
  const apply =
    body.apply === true ||
    body.apply === 1 ||
    body.apply === "1" ||
    body.apply === "true" ||
    req.query?.apply === "1" ||
    req.query?.apply === "true";
  const db = resolveDb();
  const now = new Date().toISOString();
  const batchTag = `claim-backfill-${now.replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  const planned = selectClaimBackfillItems(db, now);
  if (!apply) {
    res.json({ success: true, dry_run: true, batch_tag: batchTag, count: planned.length, items: planned });
    return;
  }
  try {
    const changed = applyClaimBackfill(db, planned, batchTag);
    res.json({ success: true, dry_run: false, batch_tag: batchTag, count: changed.length, items: changed });
  } catch (err) {
    console.error("[claim-backfill] apply failed:", err);
    res.status(500).json({ success: false, error: "apply_failed", detail: String((err as Error)?.message || err) });
  }
});

export default router;
