import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { mergeFieldProvenance } from "./admin-knowledge";

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

// Shared "legacy wrapped shape" detector — a field's stored value is a
// non-array object with an array `.sources` property. This is the exact
// same check mergeFieldProvenance() (src/routes/admin-knowledge.ts) uses to
// decide "unwrap" vs "treat as a single malformed record and drop". Hoisted
// to module scope (was previously local to the GET handler below) so the
// POST normalize endpoint further down can use the identical check —
// behaviorally unchanged for the GET handler.
function isWrappedLegacyShape(val: unknown): val is { sources: unknown[] } {
  return (
    val !== null &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    Array.isArray((val as { sources?: unknown }).sources)
  );
}

router.get("/field-provenance-legacy-shape", requireAdmin, (req: Request, res: Response) => {
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

// ─────────────────────────────────────────────────────────────────
// POST /admin/agent-audit/field-provenance-legacy-shape-normalize
// ─────────────────────────────────────────────────────────────────
// dev-request 2026-07-27-field-provenance-legacy-shape-normalization: the
// writer companion to the GET audit endpoint above. The GET audit found 202
// dental_agents rows (315 fields) still holding the legacy wrapped
// `{ sources: [...] }` shape (zero in agent_knowledge as of that scan) —
// this endpoint normalizes those rows in place.
//
// For every dental_agents row with >=1 field still in the wrapped shape
// (same isWrappedLegacyShape() check as the GET audit, above), this
// computes what mergeFieldProvenance() (src/routes/admin-knowledge.ts,
// reused unmodified — see PR #298 / the module-level comment above) would
// produce for that field's existing value merged against an EMPTY incoming
// payload. Because the incoming payload is empty, mergeFieldProvenance
// only unwraps the wrapper and drops individually-malformed nested records
// (missing value/source_type) — it never adds anything new. Only
// dental_agents is scanned/written; agent_knowledge (rfb) had zero wrapped
// rows per the GET audit, so there is nothing to normalize there (if that
// ever changes, re-run the GET audit and extend this endpoint rather than
// assuming continued silence).
//
// Dry-run by default (report only, no writes). apply=1 (query string or
// JSON body) performs the writes. Only fields that actually needed
// reshaping are rewritten — already-bare fields on a row are left
// byte-for-byte untouched, and rows with no wrapped fields are skipped
// entirely (no-op, not even a write of the same JSON).
//
// Every wrapped field is reported as exactly one of:
//   - "reshaped": the wrapper is unwrapped to a bare array and >=1
//     well-formed record survives — survivors' value/source_type/
//     source_url/fetched_at are carried over unchanged.
//   - "dropped": every nested record inside the wrapper was malformed, so
//     none survive and the field becomes an empty array.
// Regardless of the field-level status, every individually-malformed
// record that gets removed is ALSO listed in that field's dropped_records
// (with a human-readable reason) — so a "reshaped" field that partially
// drops a bad record still surfaces that drop distinctly from the
// (unrelated) records it kept, and a human can tell the two categories
// apart before deciding to apply=1.
//
// Response (dry-run and apply share this shape; rows_updated is 0 in
// dry-run):
//   { success: true, apply: <bool>,
//     scanned: <dental_agents row count>,
//     rows_examined: <rows with non-trivial field_provenance>,
//     rows_with_wrapped_fields: <n>,
//     fields_reshaped: <n>, fields_dropped: <n>, records_dropped: <n>,
//     rows_updated: <n>,
//     results: [{ table: "dental_agents", id,
//                  fields: [{ field, status, original_count, kept_count,
//                             dropped_records: [{ reason, record }] }] }] }
router.post(
  "/field-provenance-legacy-shape-normalize",
  requireAdmin,
  (req: Request, res: Response) => {
    // apply: dry-run by default. apply=1 / "1" / true (body) or ?apply=1
    // (mirrors the dry-run/apply convention used by
    // homepageContentRefreshRouter in admin-knowledge.ts).
    const body = (req.body ?? {}) as { apply?: unknown };
    const apply =
      req.query?.apply === "1" ||
      req.query?.apply === "true" ||
      body.apply === 1 ||
      body.apply === "1" ||
      body.apply === true ||
      body.apply === "true";

    // Human-readable reason for a dropped record — purely descriptive for
    // the dry-run report. The actual drop DECISION comes from
    // mergeFieldProvenance()'s own (unmodified, reused) isWellFormedRecord
    // filtering below, not from this function — this just explains it.
    function reasonForMalformed(rec: unknown): string {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "not_an_object";
      const o = rec as Record<string, unknown>;
      const badType = typeof o.source_type !== "string" || o.source_type.trim().length === 0;
      const badValue = typeof o.value !== "string" || o.value.trim().length === 0;
      if (badType && badValue) return "missing_source_type_and_value";
      if (badType) return "missing_source_type";
      if (badValue) return "missing_value";
      return "malformed";
    }

    type FieldReport = {
      field: string;
      status: "reshaped" | "dropped";
      original_count: number;
      kept_count: number;
      dropped_records: Array<{ reason: string; record: unknown }>;
    };
    type RowReport = { table: "dental_agents"; id: string; fields: FieldReport[] };

    try {
      const db = getVerticalDb("dental");

      const scanned = (
        db.prepare(`SELECT COUNT(*) AS c FROM dental_agents`).get() as { c: number }
      ).c;

      const rows = db
        .prepare(
          `SELECT id, field_provenance FROM dental_agents
           WHERE field_provenance IS NOT NULL AND field_provenance NOT IN ('', '{}', '[]')`,
        )
        .all() as Array<{ id: string; field_provenance: string }>;

      const results: RowReport[] = [];
      let fieldsReshaped = 0;
      let fieldsDropped = 0;
      let recordsDropped = 0;
      let rowsUpdated = 0;

      const updateStmt = db.prepare(`UPDATE dental_agents SET field_provenance = ? WHERE id = ?`);

      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.field_provenance);
        } catch {
          console.warn(
            `[admin-agent-audit] field-provenance-legacy-shape-normalize: unparseable field_provenance on dental_agents/${row.id}, skipping`,
          );
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

        const provObj = parsed as Record<string, unknown>;
        // Shallow copy — fields that don't need reshaping are carried over
        // as-is (same reference, same on-disk JSON encoding for them).
        const newProv: Record<string, unknown> = { ...provObj };
        const fieldReports: FieldReport[] = [];

        for (const [field, val] of Object.entries(provObj)) {
          if (!isWrappedLegacyShape(val)) continue;

          const originalSources = val.sources.slice();
          // Reuse mergeFieldProvenance() exactly as PR #298 shipped it:
          // existing={field: val}, incoming={} — this unwraps the
          // { sources: [...] } wrapper and drops malformed nested records
          // via its own internal isWellFormedRecord filter, adding
          // nothing new since the incoming payload is empty.
          const merged = mergeFieldProvenance({ [field]: val }, {});
          const keptArr = merged[field] ?? [];
          const keptSet = new Set<unknown>(keptArr);
          const droppedRecords = originalSources
            .filter((r) => !keptSet.has(r))
            .map((r) => ({ reason: reasonForMalformed(r), record: r }));

          newProv[field] = keptArr;

          const status: "reshaped" | "dropped" = keptArr.length > 0 ? "reshaped" : "dropped";
          if (status === "reshaped") fieldsReshaped++;
          else fieldsDropped++;
          recordsDropped += droppedRecords.length;

          fieldReports.push({
            field,
            status,
            original_count: originalSources.length,
            kept_count: keptArr.length,
            dropped_records: droppedRecords,
          });
        }

        if (fieldReports.length === 0) continue; // row has no wrapped fields — untouched, unreported

        results.push({ table: "dental_agents", id: row.id, fields: fieldReports });

        if (apply) {
          updateStmt.run(JSON.stringify(newProv), row.id);
          rowsUpdated++;
        }
      }

      return res.json({
        success: true,
        apply,
        scanned,
        rows_examined: rows.length,
        rows_with_wrapped_fields: results.length,
        fields_reshaped: fieldsReshaped,
        fields_dropped: fieldsDropped,
        records_dropped: recordsDropped,
        rows_updated: apply ? rowsUpdated : 0,
        results,
      });
    } catch (error) {
      console.error(
        "[admin-agent-audit] field-provenance-legacy-shape-normalize error:",
        error,
      );
      return res.status(500).json({
        success: false,
        error: "internal_error",
        message: "An error occurred.",
      });
    }
  },
);

export default router;
