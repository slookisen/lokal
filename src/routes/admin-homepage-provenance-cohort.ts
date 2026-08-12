// ─── GET /admin/homepage-provenance-cohort ──────────────────────────────────
//
// dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype (slookisen/A2A), Skive 3
// follow-up: two prior wakes (2026-08-08, 2026-08-11) diagnosed
// `POST /admin/homepage-provenance-batch` (default auto-select) returning
// `processed:0` live and confirmed it is NOT a selector bug — the auto-select
// SQL genuinely has nothing left to pick with its own `LIMIT`. Skive 3's spec
// ("kjør homepage-provenance-batch med eksplisitte agentIds i bolker à 25 til
// kohorten er uttømt") assumed a way to enumerate that cohort exists; it
// doesn't — `pool-blocker-explain` is id-in/verdict-out only, it cannot
// discover IDs on its own, and the batch endpoint itself only ever returns
// however many rows its own `LIMIT` selects, never a total.
//
// This route closes that gap: READ-ONLY, it lists the agent IDs the default
// auto-select in `POST /admin/homepage-provenance-batch` (routes/marketplace.ts)
// would pick, using the IDENTICAL predicate (same WHERE, same parking/backoff
// exclusions, same reachable-first/attempt-order ORDER BY) — but paginated via
// limit/offset instead of a single hard `LIMIT`, so a caller can walk the
// whole cohort in batches until it is empty, and see the true total up front.
// It writes nothing and calls no external network.
//
// Auth: X-Admin-Key (same local requireAdmin convention as every other admin
// route file in this codebase — deliberately re-defined locally, none share
// it via import; see admin-pool-blocker-explain.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

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

export const COHORT_DEFAULT_LIMIT = 100;
export const COHORT_MAX_LIMIT = 1000;

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit = Math.min(
    Math.max(1, parseInt(String(limitRaw ?? COHORT_DEFAULT_LIMIT), 10) || COHORT_DEFAULT_LIMIT),
    COHORT_MAX_LIMIT
  );
  const offset = Math.max(0, parseInt(String(offsetRaw ?? "0"), 10) || 0);

  const db = getDb();

  // IDENTICAL to the default auto-select's exclusions in
  // POST /admin/homepage-provenance-batch (routes/marketplace.ts) — kept as a
  // literal copy, not a shared import, per this codebase's established
  // "re-derive locally, don't couple admin routes together" convention (see
  // admin-pool-blocker-explain.ts's own header comment). Any future change to
  // the batch selector's predicate must be mirrored here by hand; a test in
  // this file's own suite exists specifically to catch drift.
  const parkingExclusion = process.env.HOMEPAGE_PARKING_DISABLED === "true"
    ? ""
    : `AND (k.homepage_unreachable_since IS NULL OR k.homepage_unreachable_since <= datetime('now','-30 days'))`;

  const noYieldBackoffDays = Math.max(
    1,
    parseInt(String(process.env.NO_YIELD_BACKOFF_DAYS ?? "14"), 10) || 14,
  );
  const backoffExclusion =
    `AND ((k.no_yield_streak < 3 AND k.wrong_entity_streak < 3) ` +
    `OR k.last_enrichment_attempt_at IS NULL ` +
    `OR k.last_enrichment_attempt_at <= datetime('now','-${noYieldBackoffDays} days'))`;

  const whereClause = `
     FROM agent_knowledge k
     JOIN agents a ON a.id = k.agent_id
    WHERE k.verification_status IN ('data_insufficient', 'review_required', 'pending_verify')
      AND (k.website IS NOT NULL AND k.website != '' OR a.url IS NOT NULL AND a.url != '')
      AND k.about IS NOT NULL AND k.about != ''
      AND (
        k.field_provenance IS NULL
        OR k.field_provenance = '{}'
        OR k.field_provenance NOT LIKE '%"homepage"%'
      )
      ${parkingExclusion}
      ${backoffExclusion}
  `;

  // Count first (cheap relative to the page fetch — same predicate, no JOIN
  // projection, no ORDER BY). Reported so a caller can compute how many pages
  // remain without guessing from a short/empty page.
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${whereClause}`)
    .get() as { total: number };

  const rows = db
    .prepare(
      `SELECT k.agent_id AS agent_id, COALESCE(k.website, a.url) AS homepage_url
         ${whereClause}
        ORDER BY
          CASE WHEN k.url_last_status BETWEEN 200 AND 399 THEN 0 ELSE 1 END,
          (k.last_enrichment_attempt_at IS NOT NULL), k.last_enrichment_attempt_at ASC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{ agent_id: string; homepage_url: string | null }>;

  // Mirror the batch endpoint's own post-query filter: a row whose homepage
  // resolves empty/whitespace-only can't actually be processed by the batch
  // (same "wouldn't burn a slot" reasoning as processAgent's fallback) — drop
  // it here too so `returned` always reflects agents the batch would truly
  // pick up next, not a superset.
  const agentIds = rows
    .filter((r) => r.homepage_url && r.homepage_url.trim())
    .map((r) => r.agent_id);

  res.json({
    total: totalRow.total,
    limit,
    offset,
    returned: agentIds.length,
    agentIds,
  });
});

export default router;
