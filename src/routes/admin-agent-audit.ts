import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

// ─────────────────────────────────────────────────────────────────
// ADMIN AGENT AUDIT: Phase 5.4a Backend (M1)
// ─────────────────────────────────────────────────────────────────
// Daniel-only endpoint for viewing agent profile update audit trail.
// Requires X-Admin-Key header matching ADMIN_KEY env var.

// ─────────────────────────────────────────────────────────────────
// Helper: Verify admin key
// ─────────────────────────────────────────────────────────────────

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response, next: any): void {
  const key = req.headers["x-admin-key"] as string;
  const adminKey = getAdminKey();

  if (!key || key !== adminKey) {
    console.log(`[admin-agent-audit] Unauthorized access attempt`);
    res.status(401).json({
      success: false,
      error: "unauthorized",
      message: "Admin key required.",
    });
    return;
  }

  next();
}

// ─────────────────────────────────────────────────────────────────
// GET /admin/agent-audit?agent_id=<id>&limit=50&since_hours=24
// ─────────────────────────────────────────────────────────────────
// Returns audit log for a specific agent's profile changes.
// Admin-only (Daniel).

router.get("/", requireAdmin, (req: Request, res: Response) => {
  try {
    const { agent_id, limit = "50", since_hours = "24" } = req.query;

    console.log(
      `[admin-agent-audit] Audit query for agent=${agent_id}, limit=${limit}, since_hours=${since_hours}`
    );

    if (!agent_id || typeof agent_id !== "string") {
      return res.status(400).json({
        success: false,
        error: "missing_agent_id",
        message: "agent_id parameter is required.",
      });
    }

    const limitNum = Math.min(parseInt(String(limit)) || 50, 1000);
    const hoursNum = parseInt(String(since_hours)) || 24;

    const db = getDb();

    // Query audit records for this agent
    const audits = db
      .prepare(
        `SELECT * FROM agent_knowledge_audit
         WHERE agent_id = ? AND changed_at >= datetime('now', '-' || ? || ' hours')
         ORDER BY changed_at DESC
         LIMIT ?`
      )
      .all(agent_id, hoursNum, limitNum) as any[];

    console.log(
      `[admin-agent-audit] Found ${audits.length} audit records for ${agent_id}`
    );

    // Parse old/new values if they're JSON
    const auditsWithParsing = audits.map((audit) => {
      try {
        return {
          ...audit,
          old_value_parsed: audit.old_value ? JSON.parse(audit.old_value) : null,
          new_value_parsed: audit.new_value ? JSON.parse(audit.new_value) : null,
        };
      } catch {
        // If parse fails, keep original strings
        return audit;
      }
    });

    return res.json({
      success: true,
      count: audits.length,
      agent_id,
      since_hours: hoursNum,
      audits: auditsWithParsing,
    });
  } catch (error) {
    console.error("[admin-agent-audit] Error:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "An error occurred.",
    });
  }
});

export default router;
