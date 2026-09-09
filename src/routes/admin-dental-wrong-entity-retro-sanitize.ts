// ─── POST /admin/dental/wrong-entity-retro-sanitize ─────────────────────────
//
// dev-request 2026-09-09-dental-non-clinic-retro-sanitize: one-time
// retroactive sanitization batch. `dental_agents` was seeded from a Brreg
// sweep over NACE 86.230 + 86.221 + 32.500 (see the header comment in
// src/services/dental-catalog-class.ts), which pulled in non-dental
// businesses (orthopedic suppliers, aesthetic-medicine clinics, ...)
// alongside real dental clinics. A few of these non-dental rows got
// enrichment_state='enriched' by a previous enrichment cycle (before the
// 2026-08-29 fix, v1.5.8, closed the front door for NEW enrichments —
// already live, not touched here). This endpoint finds those already-
// `enriched` rows that are actually non-dental and parks them via the
// EXISTING wrong-entity parking mechanism (PR #698,
// src/services/dental-store.ts's parkDentalWrongEntity(), the same write
// path the normal per-record recordDentalExtractionResult() flow uses).
//
// Candidate SELECT: enrichment_state='enriched' AND naeringskode IN the
// three swept NACE codes AND not ACTIVELY parked already (NULL or expired
// 30-day backoff) — the last clause keeps re-runs idempotent: a row already
// parked within its 30-day backoff is never re-touched by a second run.
// Planning (which rows have no dental content signal at all) is delegated
// to the pure src/services/dental-wrong-entity-retro.ts module — see that
// file for why its word list is deliberately narrower than
// dental-catalog-class.ts's DENTAL_NAME_WORDS.
//
// Dry-run by default (write:false), same convention as the sibling
// admin-dental-catalog-class.ts's catalog-class-backfill endpoint. Write
// mode runs every planned park in a single DB transaction.
//
// X-Admin-Key gated (same requireAdmin idiom as every other admin route in
// this codebase).

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import {
  NON_DENTAL_SWEPT_NACE_CODES,
  planWrongEntityRetroSanitize,
  type WrongEntityRetroCandidateRow,
} from "../services/dental-wrong-entity-retro";
import { parkDentalWrongEntity } from "../services/dental-store";

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

export const WRONG_ENTITY_RETRO_SANITIZE_DEFAULT_LIMIT = 2000;
export const WRONG_ENTITY_RETRO_SANITIZE_LIMIT_CAP = 10_000;

const NACE_PLACEHOLDERS = NON_DENTAL_SWEPT_NACE_CODES.map(() => "?").join(",");
const CANDIDATE_WHERE = `
  enrichment_state = 'enriched'
  AND naeringskode IN (${NACE_PLACEHOLDERS})
  AND (wrong_entity_unreachable_since IS NULL OR wrong_entity_unreachable_since <= datetime('now','-30 days'))
`;

const router = Router();

// POST /admin/dental/wrong-entity-retro-sanitize
// Body: { write?: boolean (default false), limit?: number (default 2000, cap 10000) }
router.post("/wrong-entity-retro-sanitize", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as { write?: unknown; limit?: unknown };
    const write = body.write === true;
    const limitRaw =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.floor(body.limit)
        : WRONG_ENTITY_RETRO_SANITIZE_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(WRONG_ENTITY_RETRO_SANITIZE_LIMIT_CAP, limitRaw));

    const db = getDb("dental");
    const naceParams: string[] = [...NON_DENTAL_SWEPT_NACE_CODES];

    const rows = db
      .prepare(
        `SELECT id, navn, naeringskode, om_oss, treatments, wrong_entity_streak, wrong_entity_unreachable_since
           FROM dental_agents WHERE ${CANDIDATE_WHERE} ORDER BY navn ASC, id ASC LIMIT ?`,
      )
      .all(...naceParams, limit) as Array<WrongEntityRetroCandidateRow & {
        wrong_entity_streak: number;
        wrong_entity_unreachable_since: string | null;
      }>;
    const remainingBefore = (db
      .prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${CANDIDATE_WHERE}`)
      .get(...naceParams) as { n: number }).n;

    const plan = planWrongEntityRetroSanitize(rows);

    if (!write) {
      res.json({
        success: true,
        data: {
          dry_run: true,
          scanned: rows.length,
          would_flag: plan.length,
          sample: plan.slice(0, 15),
          remaining_before: remainingBefore,
        },
      });
      return;
    }

    let written = 0;
    const tx = db.transaction((entries: typeof plan) => {
      for (const entry of entries) {
        parkDentalWrongEntity(entry.id);
        written++;
      }
    });
    tx(plan);

    res.json({
      success: true,
      data: {
        dry_run: false,
        scanned: rows.length,
        would_flag: plan.length,
        sample: plan.slice(0, 15),
        remaining_before: remainingBefore,
        written,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

export default router;
