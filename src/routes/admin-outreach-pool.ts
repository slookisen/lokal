// ─── Admin: outreach_ready_pool endpoints (Phase 5.1, WO #7) ─────
//
// Read-only HTTP surface for the verify-first marketing pool.
// Marketing-comms agent will switch over to this in WO #9; until then
// these endpoints exist for the orchestrator + dashboard to monitor
// pool growth as lokal-agent-verifier (WO #8) lifts agents out of
// `unverified`/`thin` into `verified`/(`partial`|`rich`).
//
// All endpoints require X-Admin-Key.
//
// PR-22 / WO-20 (2026-05-10): the index endpoint now collapses email
// duplicates (e.g. agder@bondensmarked.no on 4 different pool agents)
// down to a single representative per batch — domain-reputation safe.
// Off via ?dedupe_by_email=false; defaults to true.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { dedupeByEmail, DedupeCandidate } from "../services/marketing-dedupe";

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

function parseBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return dflt;
}

// GET /admin/outreach-ready-pool/stats — pool size + breakdowns
// Defined BEFORE the index route so /stats is not eaten by /:limit-style logic.
router.get("/stats", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS c FROM outreach_ready_pool`).get() as { c: number };
    const byStatus = db
      .prepare(`SELECT verification_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY verification_status`)
      .all() as Array<{ k: string; c: number }>;
    const byEnrichment = db
      .prepare(`SELECT enrichment_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY enrichment_status`)
      .all() as Array<{ k: string; c: number }>;
    res.json({
      success: true,
      pool_size: total?.c ?? 0,
      by_verification_status: byStatus,
      by_enrichment_status: byEnrichment,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// GET /admin/outreach-ready-pool — pool rows (capped at 500)
//
// Query params:
//   limit            integer, 1..500 (default 100)
//   dedupe_by_email  bool, default true
//
// When dedupe is on, agents sharing an email are collapsed to one winner
// (highest views_count > highest google_rating*review_count > name asc).
// Suppressed agents stay in the pool (no DB write) — they'll surface in
// a future batch once the chosen one moves into outreach_sent_log.
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
    const dedupe = parseBool(req.query.dedupe_by_email, true);

    // Pull pool rows enriched with the fields dedupe needs as tiebreakers.
    // We over-fetch (cap 500) when dedupe is on so that after collapsing we
    // still have a reasonable batch — the caller's `limit` is applied AFTER
    // dedupe to honor the contract "max N outreach emails per batch".
    const overFetch = dedupe ? 500 : limit;
    const rows = db
      .prepare(
        `SELECT
            p.*,
            k.google_rating,
            k.google_review_count,
            (SELECT COUNT(*) FROM analytics_agent_views v WHERE v.agent_id = p.agent_id) AS views_count
         FROM outreach_ready_pool p
         INNER JOIN agent_knowledge k ON k.agent_id = p.agent_id
         ORDER BY COALESCE(p.outreach_eligible_at, '9999-12-31') ASC
         LIMIT ?`
      )
      .all(overFetch) as Array<DedupeCandidate & Record<string, unknown>>;

    let agents: typeof rows = rows;
    let suppressed: typeof rows = [];
    let collisions = 0;
    if (dedupe) {
      const result = dedupeByEmail(rows);
      // Re-apply the caller's limit AFTER dedupe (so requested=10 with 3
      // collisions => after_dedup<=10, suppressed counted separately).
      agents = result.selected.slice(0, limit);
      suppressed = result.suppressed;
      collisions = result.emails_with_collisions;
    } else {
      agents = rows.slice(0, limit);
    }

    if (dedupe) {
      // Observability: one log line per batch matching WO-20 spec.
      // eslint-disable-next-line no-console
      console.log(
        `[marketing] dedupe-by-email: requested=${limit}, ` +
          `after_dedup=${agents.length}, suppressed=${suppressed.length} ` +
          `(${collisions} email${collisions === 1 ? "" : "s"} had 2+ agents)`
      );
    }

    res.json({
      success: true,
      count: agents.length,
      agents,
      // Run-envelope-friendly counters (consumed by marketing-comms).
      dedupe_by_email: dedupe,
      dedupe_suppressed_count: suppressed.length,
      dedupe_email_collision_groups: collisions,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
