// ─── POST /admin/dental/catalog-class-backfill + GET /admin/dental/parking-stats
//
// dev-request 2026-09-02-dental-catalog-class-triage (steg 0 + steg 1 of the
// 2026-09-02 dental pipeline review).
//
// catalog-class-backfill: applies the pure rule classifier in
// src/services/dental-catalog-class.ts to dental_agents rows and stores the
// result in the additive catalog_class / catalog_class_source /
// catalog_class_at columns (init-dental.ts). Dry-run by default (write:false)
// — the response then reports what WOULD be written, per class, with a
// sample per class, so the first real run can be eyeballed. Fill-only
// unless overwrite:true: a row that already has a catalog_class (e.g. set
// by hand or by a later Sonnet pass) is never re-stamped by the rules.
//
// parking-stats: read-only counts of every parking / exclusion signal the
// claim pool honours (dental-claim-service.ts buildWhereClause) — the three
// 30-day strike stamps, thin_site, needs_review/rejected, is_inactive — plus
// the catalog_class and enrichment/verification breakdown. Until now the
// three strike columns were invisible outside the DB file; the enrichment
// routine reports this each cycle so the "blacklist" growth becomes a daily
// curve instead of an anecdote.
//
// Both endpoints are X-Admin-Key gated (same requireAdmin idiom as
// admin-dental-mark-inactive.ts) and never touch any other column.

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import {
  classifyDentalCatalogEntry,
  DENTAL_CATALOG_CLASSES,
  type DentalCatalogClass,
} from "../services/dental-catalog-class";

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

export const CATALOG_CLASS_BACKFILL_CAP = 10_000;
export const CATALOG_CLASS_SOURCE_RULES = "rules_v1";

interface BackfillRow {
  id: string;
  navn: string;
  naeringskode: string | null;
  organisasjonsform: string | null;
  hjemmeside: string | null;
  catalog_class: string | null;
}

export interface BackfillPlanEntry {
  id: string;
  navn: string;
  catalog_class: DentalCatalogClass;
  rule: string;
}

// Pure planning step — exported for tests. Given candidate rows, returns
// the per-row classification (never writes).
export function planCatalogClassBackfill(rows: BackfillRow[]): BackfillPlanEntry[] {
  return rows.map((r) => {
    const c = classifyDentalCatalogEntry({
      navn: r.navn,
      naeringskode: r.naeringskode,
      organisasjonsform: r.organisasjonsform,
      hjemmeside: r.hjemmeside,
    });
    return { id: r.id, navn: r.navn, catalog_class: c.catalog_class, rule: c.rule };
  });
}

function emptyCounts(): Record<DentalCatalogClass, number> {
  const o = {} as Record<DentalCatalogClass, number>;
  for (const c of DENTAL_CATALOG_CLASSES) o[c] = 0;
  return o;
}

const router = Router();

// POST /admin/dental/catalog-class-backfill
// Body: { write?: boolean (default false), overwrite?: boolean (default false),
//         limit?: number (default 10000, cap 10000) }
router.post("/catalog-class-backfill", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as { write?: unknown; overwrite?: unknown; limit?: unknown };
    const write = body.write === true;
    const overwrite = body.overwrite === true;
    const limitRaw = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : CATALOG_CLASS_BACKFILL_CAP;
    const limit = Math.max(1, Math.min(CATALOG_CLASS_BACKFILL_CAP, limitRaw));

    const db = getDb("dental");
    const where = overwrite ? "1=1" : "catalog_class IS NULL";
    const rows = db
      .prepare(
        `SELECT id, navn, naeringskode, organisasjonsform, hjemmeside, catalog_class
           FROM dental_agents WHERE ${where} ORDER BY navn ASC, id ASC LIMIT ?`,
      )
      .all(limit) as BackfillRow[];
    const remaining = (db
      .prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${where}`)
      .get() as { n: number }).n;

    const plan = planCatalogClassBackfill(rows);
    const counts = emptyCounts();
    const by_rule: Record<string, number> = {};
    const sample: Record<DentalCatalogClass, Array<{ navn: string; rule: string }>> = {} as any;
    for (const c of DENTAL_CATALOG_CLASSES) sample[c] = [];
    for (const p of plan) {
      counts[p.catalog_class]++;
      by_rule[p.rule] = (by_rule[p.rule] ?? 0) + 1;
      if (sample[p.catalog_class].length < 8) sample[p.catalog_class].push({ navn: p.navn, rule: p.rule });
    }

    let written = 0;
    if (write && plan.length > 0) {
      const nowIso = new Date().toISOString();
      const stmt = db.prepare(
        `UPDATE dental_agents
            SET catalog_class = ?, catalog_class_source = ?, catalog_class_at = ?
          WHERE id = ? AND (? = 1 OR catalog_class IS NULL)`,
      );
      const tx = db.transaction((entries: BackfillPlanEntry[]) => {
        for (const p of entries) {
          const r = stmt.run(p.catalog_class, `${CATALOG_CLASS_SOURCE_RULES}:${p.rule}`, nowIso, p.id, overwrite ? 1 : 0);
          written += r.changes;
        }
      });
      tx(plan);
    }

    res.json({
      success: true,
      data: {
        dry_run: !write,
        overwrite,
        scanned: plan.length,
        written,
        remaining_before: remaining,
        remaining_after: write ? Math.max(0, remaining - written) : remaining,
        counts,
        by_rule,
        sample,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

// GET /admin/dental/parking-stats
router.get("/parking-stats", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb("dental");
    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const grouped = (col: string): Record<string, number> => {
      const out: Record<string, number> = {};
      const rows = db
        .prepare(`SELECT COALESCE(${col}, '(null)') AS k, COUNT(*) AS n FROM dental_agents GROUP BY k ORDER BY n DESC`)
        .all() as Array<{ k: string; n: number }>;
      for (const r of rows) out[r.k] = r.n;
      return out;
    };
    const total = one("SELECT COUNT(*) AS n FROM dental_agents");
    const parking = {
      extraction_parked_active: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE extraction_unreachable_since IS NOT NULL AND extraction_unreachable_since > datetime('now','-30 days')",
      ),
      extraction_parked_expired: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE extraction_unreachable_since IS NOT NULL AND extraction_unreachable_since <= datetime('now','-30 days')",
      ),
      wrong_entity_parked_active: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE wrong_entity_unreachable_since IS NOT NULL AND wrong_entity_unreachable_since > datetime('now','-30 days')",
      ),
      wrong_entity_parked_expired: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE wrong_entity_unreachable_since IS NOT NULL AND wrong_entity_unreachable_since <= datetime('now','-30 days')",
      ),
      wrong_entity_streak_1plus: one("SELECT COUNT(*) AS n FROM dental_agents WHERE wrong_entity_streak >= 1"),
      homepage_parked_active: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE homepage_unreachable_since IS NOT NULL AND homepage_unreachable_since > datetime('now','-30 days')",
      ),
      homepage_parked_expired: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE homepage_unreachable_since IS NOT NULL AND homepage_unreachable_since <= datetime('now','-30 days')",
      ),
      thin_site: one("SELECT COUNT(*) AS n FROM dental_agents WHERE enrichment_state = 'thin_site'"),
      needs_review: one("SELECT COUNT(*) AS n FROM dental_agents WHERE verification_status = 'needs_review'"),
      rejected: one("SELECT COUNT(*) AS n FROM dental_agents WHERE verification_status = 'rejected'"),
      is_inactive: one("SELECT COUNT(*) AS n FROM dental_agents WHERE is_inactive = 1"),
      directory_url_moved: one("SELECT COUNT(*) AS n FROM dental_agents WHERE directory_url IS NOT NULL"),
      currently_claimed: one("SELECT COUNT(*) AS n FROM dental_agents WHERE worker_id IS NOT NULL"),
    };
    const pool = {
      raw_with_hjemmeside_total: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE enrichment_state = 'raw' AND hjemmeside IS NOT NULL AND hjemmeside <> ''",
      ),
      raw_with_hjemmeside_claimable: one(
        `SELECT COUNT(*) AS n FROM dental_agents
          WHERE enrichment_state = 'raw' AND hjemmeside IS NOT NULL AND hjemmeside <> ''
            AND (verification_status IS NULL OR verification_status NOT IN ('needs_review','rejected'))
            AND (is_inactive IS NULL OR is_inactive = 0)
            AND (extraction_unreachable_since IS NULL OR extraction_unreachable_since <= datetime('now','-30 days'))
            AND (wrong_entity_unreachable_since IS NULL OR wrong_entity_unreachable_since <= datetime('now','-30 days'))
            AND (homepage_unreachable_since IS NULL OR homepage_unreachable_since <= datetime('now','-30 days'))
            AND (catalog_class IS NULL OR catalog_class IN ('klinikk','offentlig_klinikk','ukjent'))`,
      ),
      raw_without_hjemmeside: one(
        "SELECT COUNT(*) AS n FROM dental_agents WHERE enrichment_state = 'raw' AND (hjemmeside IS NULL OR hjemmeside = '')",
      ),
      missing_adresse: one("SELECT COUNT(*) AS n FROM dental_agents WHERE adresse IS NULL OR adresse = ''"),
      missing_lat: one("SELECT COUNT(*) AS n FROM dental_agents WHERE lat IS NULL"),
    };
    res.json({
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        total,
        parking,
        pool,
        by_enrichment_state: grouped("enrichment_state"),
        by_verification_status: grouped("verification_status"),
        by_catalog_class: grouped("catalog_class"),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

export default router;
