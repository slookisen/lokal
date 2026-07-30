// ─── Admin: GET /admin/contact-write-guard-audit ────────────────────────────
//
// dev-request 2026-07-28-rfb-kontaktekstraksjon-orgnr-som-telefon, criterion 5
// (slookisen/A2A). The write-time contact guard added in PR #409
// (validatePhoneForWrite / stripTrailingContactLabel, wired into
// KnowledgeService.upsertKnowledge — see contact-normalizer.ts) only protects
// FUTURE writes. Nothing has ever measured how many EXISTING rows in
// `agent_knowledge` already violate those same rules, so there was no way to
// know the size of the problem or to later verify a cleanup worked. This
// endpoint is that missing read-only measurement tool.
//
// ── THIS IS A DETECTION TOOL, NOT A CORRECTION TOOL ─────────────────────────
// Read-only. There is no `apply` mode and this handler issues ZERO writes to
// any table — it only runs SELECTs, exactly like its sibling
// admin-wrong-entity-retro-sweep.ts.
//
// Scope: unlike admin-domain-coherence.ts / admin-wrong-entity-retro-sweep.ts
// (which restrict to a cohort — umbrella-excluded, is_active=1, or
// verification_status='review_required' — for THEIR purposes), this sweep
// scans the FULL `agent_knowledge` table joined to `agents`, across every
// vertical (rfb/dental/experiences share these tables), with no cohort
// filter at all. The point of a measurement tool is to measure the whole
// problem, not a slice of it.
//
// Rules audited (1:1 with the write-guard's rules — see
// services/contact-normalizer.ts's classifyPhoneForWrite/
// validatePhoneForWrite/stripTrailingContactLabel, which this route calls
// directly and does not reimplement):
//   1. phone_shape_violations   — phone does not reduce to exactly 8
//      Norwegian national digits (classifyPhoneForWrite rule "shape").
//   2. phone_org_nr_collision   — phone equals the agent's own org_nr, full
//      digit-string or last-8-digit reduced form (classifyPhoneForWrite rule
//      "org_nr_collision").
//   3. phone_date_shape         — phone reduces to 8 digits that parse as a
//      plausible YYYYMMDD date (classifyPhoneForWrite rule "date_shape").
//   4. address_trailing_label   — address has a trailing standalone
//      contact-field label that stripTrailingContactLabel would strip
//      (i.e. stripTrailingContactLabel(address) !== address).
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { classifyPhoneForWrite, stripTrailingContactLabel } from "../services/contact-normalizer";

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

interface KnowledgeRow {
  agent_id: string;
  vertical_id: string;
  org_nr: string | null;
  phone: string | null;
  address: string | null;
}

interface ViolationEntry {
  agent_id: string;
  vertical_id: string;
  value: string;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  // ── READ-ONLY / DRY-RUN ONLY ──────────────────────────────────────────
  // Every statement below is a SELECT. This handler must never contain an
  // INSERT/UPDATE/DELETE — it is a measurement tool, not a correction tool.
  try {
    const db = getDb();

    const total_rows_scanned = (
      db.prepare(`SELECT COUNT(*) AS c FROM agent_knowledge`).get() as { c: number }
    ).c;

    // Full-table scan — NO cohort filter (no umbrella exclusion, no
    // is_active filter, no verification_status filter). This is a full
    // measurement across every row and every vertical.
    const rows = db
      .prepare(
        `SELECT k.agent_id AS agent_id,
                a.vertical_id AS vertical_id,
                a.org_nr AS org_nr,
                k.phone AS phone,
                k.address AS address
           FROM agent_knowledge k
           JOIN agents a ON a.id = k.agent_id
       ORDER BY k.agent_id`
      )
      .all() as KnowledgeRow[];

    const phone_shape_violations: ViolationEntry[] = [];
    const phone_org_nr_collision: ViolationEntry[] = [];
    const phone_date_shape: ViolationEntry[] = [];
    const address_trailing_label: ViolationEntry[] = [];

    // vertical -> rule -> count
    const by_vertical: Record<string, Record<string, number>> = {};
    function bump(vertical: string, rule: string): void {
      const v = by_vertical[vertical] ?? (by_vertical[vertical] = {
        phone_shape_violations: 0,
        phone_org_nr_collision: 0,
        phone_date_shape: 0,
        address_trailing_label: 0,
      });
      v[rule] = (v[rule] ?? 0) + 1;
    }

    for (const row of rows) {
      const vertical = row.vertical_id || "rfb";

      if (row.phone && row.phone.trim() !== "") {
        const { failedRules } = classifyPhoneForWrite(row.phone, row.org_nr);
        if (failedRules.includes("shape")) {
          phone_shape_violations.push({ agent_id: row.agent_id, vertical_id: vertical, value: row.phone });
          bump(vertical, "phone_shape_violations");
        }
        if (failedRules.includes("org_nr_collision")) {
          phone_org_nr_collision.push({ agent_id: row.agent_id, vertical_id: vertical, value: row.phone });
          bump(vertical, "phone_org_nr_collision");
        }
        if (failedRules.includes("date_shape")) {
          phone_date_shape.push({ agent_id: row.agent_id, vertical_id: vertical, value: row.phone });
          bump(vertical, "phone_date_shape");
        }
      }

      if (row.address && row.address.trim() !== "") {
        if (stripTrailingContactLabel(row.address) !== row.address) {
          address_trailing_label.push({ agent_id: row.agent_id, vertical_id: vertical, value: row.address });
          bump(vertical, "address_trailing_label");
        }
      }
    }

    res.json({
      success: true,
      total_rows_scanned,
      phone_shape_violations: {
        count: phone_shape_violations.length,
        rows: phone_shape_violations,
      },
      phone_org_nr_collision: {
        count: phone_org_nr_collision.length,
        rows: phone_org_nr_collision,
      },
      phone_date_shape: {
        count: phone_date_shape.length,
        rows: phone_date_shape,
      },
      address_trailing_label: {
        count: address_trailing_label.length,
        rows: address_trailing_label,
      },
      by_vertical,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
