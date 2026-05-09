// ─── Admin: Auto-fix pipeline (WO-26) ───────────────────────────────────────
//
// Three endpoints behind X-Admin-Key:
//
//   POST /admin/auto-fix-batch
//        Body: { batchSize?, dry_run?, only_categories?: string[] }
//        Default dry_run=true (Daniel: "kvalitetssikres" — never silently mutate).
//
//   POST /admin/auto-fix/:agent_id
//        Single-agent dry-run-by-default. Useful for spot-fixing.
//
//   GET  /admin/auto-fix-status
//        Summary stats: totals, today's auto-fix activity, queue stats.
//
// Each apply records to auto_fix_log so we can revert mistakes.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  planAutoFix,
  findDuplicateStreetAddresses,
  type AutoFixAction,
  type AutoFixResult,
} from "../services/auto-fix-service";

const router = Router();

const MAX_BATCH = 200;
const DEFAULT_BATCH = 50;

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

// Parse a positive int with bounds.
function parseBatchSize(raw: unknown): number {
  const n = parseInt(String(raw ?? DEFAULT_BATCH), 10);
  if (!Number.isFinite(n)) return DEFAULT_BATCH;
  return Math.min(Math.max(n, 1), MAX_BATCH);
}

// Parse a boolean from body/query that defaults to true unless explicitly false.
function parseDryRunDefaultTrue(raw: unknown): boolean {
  if (raw === false || raw === "false" || raw === 0 || raw === "0") return false;
  return true;
}

// ─── Apply one action set (writes auto_fix_log + agent_knowledge) ───────────
//
// Returns true if any DB rows were updated. Caller is responsible for the
// transaction.

function applyActions(
  db: any,
  agentId: string,
  result: AutoFixResult,
  appliedAt: string
): { applied: number } {
  let applied = 0;

  for (const action of result.actions) {
    if (action.type === "flag_review") {
      // flag_review is informational — log but do not mutate fields.
      db.prepare(
        `INSERT INTO auto_fix_log (agent_id, applied_at, fix_category, field, old_value, new_value, source, reason)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
      ).run(
        agentId,
        appliedAt,
        result.fix_categories[0] ?? "flag_review",
        action.field,
        "auto-fix:flag_review",
        action.reason
      );
      applied++;
      continue;
    }

    if (action.type === "set_status") {
      // Status changes go to verification_status on agent_knowledge AND, when
      // wrong_fit, also clear outreach_eligible_at if not already cleared.
      const before = db
        .prepare("SELECT verification_status FROM agent_knowledge WHERE agent_id = ?")
        .get(agentId) as { verification_status?: string } | undefined;
      const oldStatus = before?.verification_status ?? action.old_status;
      db.prepare(
        "UPDATE agent_knowledge SET verification_status = ? WHERE agent_id = ?"
      ).run(action.new_status, agentId);

      db.prepare(
        `INSERT INTO auto_fix_log (agent_id, applied_at, fix_category, field, old_value, new_value, source, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        agentId,
        appliedAt,
        result.fix_categories[0] ?? "set_status",
        "verification_status",
        oldStatus,
        action.new_status,
        "auto-fix",
        action.reason
      );
      applied++;
      continue;
    }

    // set_field — table depends on which field. agents owns: name, city, url.
    // agent_knowledge owns: address, postal_code, website, phone, email,
    // outreach_eligible_at, verification_status, etc.
    const AGENT_FIELDS = new Set(["url", "city", "name"]);
    const isAgentField = AGENT_FIELDS.has(action.field);
    const table = isAgentField ? "agents" : "agent_knowledge";
    const fkCol = isAgentField ? "id" : "agent_id";

    // Read the current value first (so we log the actual prior, not the planned one).
    const beforeRow = db
      .prepare(`SELECT ${action.field} AS v FROM ${table} WHERE ${fkCol} = ?`)
      .get(agentId) as { v?: unknown } | undefined;
    const beforeVal = beforeRow?.v ?? action.old_value;

    db.prepare(`UPDATE ${table} SET ${action.field} = ? WHERE ${fkCol} = ?`).run(
      action.new_value as any,
      agentId
    );

    db.prepare(
      `INSERT INTO auto_fix_log (agent_id, applied_at, fix_category, field, old_value, new_value, source, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agentId,
      appliedAt,
      result.fix_categories[0] ?? "set_field",
      action.field,
      beforeVal === null || beforeVal === undefined ? null : String(beforeVal),
      action.new_value === null || action.new_value === undefined
        ? null
        : String(action.new_value),
      action.source,
      action.reason
    );
    applied++;
  }

  return { applied };
}

// ─── POST /admin/auto-fix-batch ─────────────────────────────────────────────

router.post("/auto-fix-batch", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const batchSize = parseBatchSize(
    (req.body && req.body.batchSize) ?? req.query.batchSize
  );
  const dryRun = parseDryRunDefaultTrue(
    (req.body && req.body.dry_run) ?? req.query.dry_run
  );
  const onlyCategoriesRaw =
    (req.body && req.body.only_categories) ?? req.query.only_categories;
  const onlyCategories: string[] | null = Array.isArray(onlyCategoriesRaw)
    ? onlyCategoriesRaw.map(String)
    : null;

  try {
    const db = getDb();
    const candidates = db
      .prepare(
        `SELECT a.id AS agent_id, a.name, a.url,
                k.address, k.postal_code, a.city,
                k.website, k.phone, k.email,
                k.verification_status, k.outreach_eligible_at
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE k.verification_status IN ('verified', 'review_required')
            AND k.address IS NOT NULL
       ORDER BY k.last_verified_at ASC NULLS FIRST,
                a.id ASC
          LIMIT ?`
      )
      .all(batchSize) as any[];

    const duplicateGroups = findDuplicateStreetAddresses(db);

    const appliedAt = new Date().toISOString();
    const plans: AutoFixResult[] = [];
    let totalApplied = 0;
    let mutatedAgents = 0;
    const categoryCounts: Record<string, number> = {};

    for (const row of candidates) {
      const plan = await planAutoFix({
        agent_id: row.agent_id,
        current_knowledge: {
          agent_id: row.agent_id,
          name: row.name,
          address: row.address,
          postal_code: row.postal_code,
          city: row.city,
          website: row.website,
          phone: row.phone,
          email: row.email,
          url: row.url,
          verification_status: row.verification_status,
          outreach_eligible_at: row.outreach_eligible_at,
        },
        duplicateStreetAddresses: duplicateGroups,
      });

      // Filter by only_categories if provided
      if (onlyCategories && onlyCategories.length > 0) {
        if (!plan.fix_categories.some((c) => onlyCategories.includes(c))) {
          continue;
        }
      }
      if (plan.actions.length === 0) continue;
      plans.push(plan);

      for (const cat of plan.fix_categories) {
        categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
      }

      if (!dryRun) {
        const tx = db.transaction(() => {
          const r = applyActions(db, row.agent_id, plan, appliedAt);
          totalApplied += r.applied;
          if (r.applied > 0) mutatedAgents++;
        });
        tx();
      }
    }

    res.json({
      success: true,
      dry_run: dryRun,
      processed: candidates.length,
      plans_with_actions: plans.length,
      mutated_agents: dryRun ? 0 : mutatedAgents,
      total_actions_applied: dryRun ? 0 : totalApplied,
      actions_by_category: categoryCounts,
      plans: dryRun ? plans : plans.map((p) => ({
        agent_id: p.agent_id,
        fix_categories: p.fix_categories,
        confidence: p.confidence,
        action_count: p.actions.length,
      })),
      duplicate_groups: duplicateGroups.length,
    });
  } catch (err: any) {
    console.error("[admin/auto-fix-batch] failed:", err);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// ─── POST /admin/auto-fix/:agent_id ─────────────────────────────────────────

router.post("/auto-fix/:agent_id", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const agentId = String(req.params.agent_id || "");
  if (!agentId) {
    res.status(400).json({ error: "agent_id required" });
    return;
  }
  const dryRun = parseDryRunDefaultTrue(
    (req.body && req.body.dry_run) ?? req.query.dry_run
  );

  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT a.id AS agent_id, a.name, a.url,
                k.address, k.postal_code, a.city,
                k.website, k.phone, k.email,
                k.verification_status, k.outreach_eligible_at
           FROM agents a
     INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.id = ?`
      )
      .get(agentId) as any;
    if (!row) {
      res.status(404).json({ error: `agent ${agentId} not found` });
      return;
    }

    const duplicateGroups = findDuplicateStreetAddresses(db);
    const plan = await planAutoFix({
      agent_id: agentId,
      current_knowledge: {
        agent_id: agentId,
        name: row.name,
        address: row.address,
        postal_code: row.postal_code,
        city: row.city,
        website: row.website,
        phone: row.phone,
        email: row.email,
        url: row.url,
        verification_status: row.verification_status,
        outreach_eligible_at: row.outreach_eligible_at,
      },
      duplicateStreetAddresses: duplicateGroups,
    });

    let applied = 0;
    if (!dryRun && plan.actions.length > 0) {
      const appliedAt = new Date().toISOString();
      const tx = db.transaction(() => {
        const r = applyActions(db, agentId, plan, appliedAt);
        applied = r.applied;
      });
      tx();
    }

    res.json({
      success: true,
      agent_id: agentId,
      dry_run: dryRun,
      applied,
      plan,
    });
  } catch (err: any) {
    console.error("[admin/auto-fix/:agent_id] failed:", err);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// ─── GET /admin/auto-fix-status ─────────────────────────────────────────────

router.get("/auto-fix-status", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const db = getDb();

    // Status totals across agent_knowledge.verification_status
    const statusRows = db
      .prepare(
        `SELECT verification_status, COUNT(*) AS c
           FROM agent_knowledge
          GROUP BY verification_status`
      )
      .all() as { verification_status: string; c: number }[];

    const totals: Record<string, number> = {
      verified: 0,
      review_required: 0,
      auto_fixed: 0,
      wrong_fit: 0,
      unverified: 0,
      pending_verify: 0,
    };
    for (const r of statusRows) {
      totals[r.verification_status] = r.c;
    }

    // Today's activity (UTC midnight)
    const todayPrefix = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const todayRows = db
      .prepare(
        `SELECT fix_category, COUNT(*) AS c
           FROM auto_fix_log
          WHERE applied_at LIKE ? || '%'
          GROUP BY fix_category`
      )
      .all(todayPrefix) as { fix_category: string; c: number }[];

    const actionsByCategory: Record<string, number> = {};
    let autoFixedCount = 0;
    let wrongFitFlagged = 0;
    for (const r of todayRows) {
      actionsByCategory[r.fix_category] = r.c;
      if (r.fix_category === "wrong_fit") wrongFitFlagged += r.c;
      else autoFixedCount += r.c;
    }

    // Queue stats
    const poolSize = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_knowledge
          WHERE verification_status = 'verified'
            AND outreach_eligible_at IS NOT NULL`
      )
      .get() as { c: number }).c;
    const reviewQueueSize = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_knowledge
          WHERE verification_status = 'review_required'`
      )
      .get() as { c: number }).c;
    const dupGroups = findDuplicateStreetAddresses(db).length;

    res.json({
      success: true,
      totals,
      today: {
        auto_fixed_count: autoFixedCount,
        wrong_fit_flagged: wrongFitFlagged,
        actions_by_category: actionsByCategory,
      },
      queue_stats: {
        pool_size: poolSize,
        review_queue_size: reviewQueueSize,
        duplicate_streetAddress_groups: dupGroups,
      },
    });
  } catch (err: any) {
    console.error("[admin/auto-fix-status] failed:", err);
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
