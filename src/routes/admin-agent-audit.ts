import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";

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

// ─────────────────────────────────────────────────────────────────
// GET /admin/agent-audit/field-provenance-legacy-shape
// ─────────────────────────────────────────────────────────────────
// Read-only audit (dev-request 2026-07-19-field-provenance-legacy-shape-audit,
// filed after the code-reviewer on lokal PR #298 recommended checking for
// other rows in the same legacy shape as the one #298 fixed going forward).
//
// PR #298 fixed mergeFieldProvenance() (src/routes/admin-knowledge.ts) so a
// field_provenance field already stored in the legacy wrapped
// `{ sources: [...] }` shape (as opposed to the on-disk bare-array shape) is
// unwrapped-and-preserved on the next merge instead of being silently wiped
// to `[]`. That fix only prevents FUTURE wipes — this endpoint finds rows
// that may already hold the wrapped shape from before the fix, across both
// tables that carry a field_provenance column (agent_knowledge = rfb,
// dental_agents = dental), so they can be reviewed/normalized in a
// separately-scoped follow-up. Never writes.
//
// A field's value counts as "legacy wrapped shape" using the exact same
// check mergeFieldProvenance() itself uses to decide whether to unwrap
// rather than filter-away: a non-array object with an array `.sources`
// property.
//
// Response:
//   { success: true,
//     scanned: { agent_knowledge: <total rows>, dental_agents: <total rows> },
//     wrapped_shape_count: <n>,
//     findings: [{ table, id, field }] }
router.get("/field-provenance-legacy-shape", requireAdmin, (req: Request, res: Response) => {
  function isWrappedLegacyShape(val: unknown): boolean {
    return (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      Array.isArray((val as { sources?: unknown }).sources)
    );
  }

  function scanTable(
    db: ReturnType<typeof getVerticalDb>,
    table: "agent_knowledge" | "dental_agents",
    idColumn: string,
  ): { totalRows: number; findings: Array<{ table: string; id: string; field: string }> } {
    const totalRows = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT ${idColumn} AS id, field_provenance FROM ${table}
         WHERE field_provenance IS NOT NULL AND field_provenance NOT IN ('', '{}', '[]')`,
      )
      .all() as Array<{ id: string; field_provenance: string }>;

    const findings: Array<{ table: string; id: string; field: string }> = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.field_provenance);
      } catch {
        console.warn(
          `[admin-agent-audit] field-provenance-legacy-shape: unparseable field_provenance on ${table}/${row.id}, skipping`,
        );
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

      for (const [field, val] of Object.entries(parsed as Record<string, unknown>)) {
        if (isWrappedLegacyShape(val)) {
          findings.push({ table, id: row.id, field });
        }
      }
    }
    return { totalRows, findings };
  }

  try {
    const rfbResult = scanTable(getVerticalDb("rfb"), "agent_knowledge", "agent_id");
    const dentalResult = scanTable(getVerticalDb("dental"), "dental_agents", "id");
    const findings = [...rfbResult.findings, ...dentalResult.findings];

    return res.json({
      success: true,
      scanned: {
        agent_knowledge: rfbResult.totalRows,
        dental_agents: dentalResult.totalRows,
      },
      wrapped_shape_count: findings.length,
      findings,
    });
  } catch (error) {
    console.error("[admin-agent-audit] field-provenance-legacy-shape error:", error);
    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "An error occurred.",
    });
  }
});

export default router;
