// ─── Admin: Agents Listing Endpoint (PR-93) ─────────────────────
//
// HTTP surface for browsing agents by status + recent update window:
//   GET /admin/agents
//
// Why this endpoint: the lokal-agent-verifier had been stuck on an
// 8-day SKIPPED-streak because it had no cheap way to ask "which
// agents changed in the last 24h, filtered by status?". The marketplace
// search endpoints are public/geo-shaped and don't expose internal
// status; admin-agent-audit reaches individual rows but not lists.
// This route fills that gap with a single, paginated, admin-gated GET.
//
// Schema note (read the report): the `agents` table does *not* have
// `updated_at` or `status` columns. We map:
//   - query.updated_since → filter on `last_seen_at`   (the only timestamp
//                                                       the table tracks
//                                                       per-write; created_at
//                                                       is immutable)
//   - query.status        → mapped onto (is_active, is_verified):
//        "active"   → is_active=1
//        "inactive" → is_active=0
//        "pending"  → is_active=1 AND is_verified=0
//   - response.status     → derived string mirror of above
//   - response.vertical   → `vertical_id` column (added in Phase 4.6a)
//   - response.updated_at → `last_seen_at`
//
// Auth: X-Admin-Key, mirrors the pattern from admin-runs.ts.

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

// ─── GET /admin/agents ────────────────────────────────────────
// List agents filtered by status + updated_since, paginated.
//
// Query params:
//   status         active | inactive | pending  (optional, default: all)
//   updated_since  ISO timestamp                 (optional, default: 24h ago)
//   limit          1..500                        (optional, default 50)
//   offset         >=0                           (optional, default 0)
//
// Response:
//   { success: true, count: <total before pagination>,
//     agents: [{ id, name, updated_at, status, vertical }] }
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── Parse + validate query params ─────────────────────────
  const rawStatus = (req.query.status as string) || "";
  const status = rawStatus.toLowerCase();
  if (status && !["active", "inactive", "pending"].includes(status)) {
    res.status(400).json({
      error: "invalid status",
      detail: "status must be one of: active, inactive, pending",
    });
    return;
  }

  // updated_since: default = 24h ago. Accept ISO 8601.
  let updatedSince = (req.query.updated_since as string) || "";
  if (!updatedSince) {
    updatedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } else {
    const parsed = Date.parse(updatedSince);
    if (Number.isNaN(parsed)) {
      res.status(400).json({
        error: "invalid updated_since",
        detail: "must be an ISO 8601 timestamp",
      });
      return;
    }
    // Normalise to ISO so SQLite's lexicographic compare works correctly
    // against the `datetime('now')`-style stamps the table uses.
    updatedSince = new Date(parsed).toISOString();
  }

  // limit: default 50, max 500
  let limit = 50;
  if (req.query.limit !== undefined) {
    const n = parseInt(req.query.limit as string, 10);
    if (!Number.isFinite(n) || n < 1) {
      res.status(400).json({ error: "invalid limit", detail: "limit must be >= 1" });
      return;
    }
    limit = Math.min(n, 500);
  }

  // offset: default 0
  let offset = 0;
  if (req.query.offset !== undefined) {
    const n = parseInt(req.query.offset as string, 10);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "invalid offset", detail: "offset must be >= 0" });
      return;
    }
    offset = n;
  }

  // ── Build WHERE clause ────────────────────────────────────
  // Parameterised — never concatenate user input into SQL.
  const where: string[] = ["last_seen_at >= ?"];
  const params: (string | number)[] = [updatedSince];

  if (status === "active") {
    where.push("is_active = 1");
  } else if (status === "inactive") {
    where.push("is_active = 0");
  } else if (status === "pending") {
    // "pending" = active but not yet verified. This matches the verifier's
    // mental model: rows it still needs to look at.
    where.push("is_active = 1");
    where.push("is_verified = 0");
  }

  const whereSql = where.join(" AND ");

  try {
    const db = getDb();

    // Total count BEFORE pagination — required for the verifier to
    // know whether to paginate further.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS n FROM agents WHERE ${whereSql}`)
      .get(...params) as { n: number };
    const total = countRow?.n ?? 0;

    const rows = db
      .prepare(
        `SELECT id, name, last_seen_at, is_active, is_verified, vertical_id
         FROM agents
         WHERE ${whereSql}
         ORDER BY last_seen_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
        id: string;
        name: string;
        last_seen_at: string;
        is_active: number;
        is_verified: number;
        vertical_id: string | null;
      }>;

    const agents = rows.map((r) => ({
      id: r.id,
      name: r.name,
      updated_at: r.last_seen_at,
      status:
        r.is_active === 0
          ? "inactive"
          : r.is_verified === 0
            ? "pending"
            : "active",
      vertical: r.vertical_id ?? "rfb",
    }));

    res.json({ success: true, count: total, agents });
  } catch (err: any) {
    res.status(500).json({ error: "List failed", detail: err.message });
  }
});

export default router;
