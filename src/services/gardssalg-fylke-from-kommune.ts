/**
 * gardssalg-fylke-from-kommune.ts — fill an EMPTY `fylke` on gårdssalg
 * providers from their `kommune` / `kommunenummer` (dev-request
 * 2026-10-01-opplevagent-fylke-fra-kommune).
 *
 * Why: a fylke-filtered gårdssalg search (`fylke = @fylke`) cannot see a row
 * whose `fylke` is blank, even when its kommune is known.
 *
 * Rules:
 *   - FILL-ONLY: only rows whose fylke is NULL/blank are ever candidates; a
 *     set fylke is never read as a target and never changed (the stale
 *     2020-era names are the separate fylke-2024-migration lever's job).
 *   - NEVER GUESSES: the lookup is resolveFylke2024() (kommunenummer first,
 *     else normalized kommunenavn); `needs_review` (unknown/ambiguous/no data)
 *     => no write, counted and sampled in the report.
 *   - LOCK: content_source 'manual'/'claim' rows are skipped (skipped_locked),
 *     same lock as every other gårdssalg writer.
 *   - One gardssalg_content_audit row per write (field_name 'fylke',
 *     old_value NULL/blank), so POST /admin/gardssalg-content-rollback can
 *     restore it ('fylke' is in GARDSSALG_ROLLBACKABLE_FIELDS).
 *   - Dry-run is the default; apply is decided by the caller.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";
import { resolveFylke2024 } from "./fylke-2024-migration";

export const GS_FFK_SAMPLE_CAP = 20;
export const GS_FFK_BATCH_CAP = 500;

export interface GardssalgFylkeFromKommuneReport {
  dry_run: boolean;
  batch_id: string | null;
  total_candidates: number;
  resolved: number;
  needs_review: number;
  needs_review_samples: Array<{ id: string; navn: string | null; kommune: string | null; reason: string }>;
  skipped_locked: number;
  written: number;
  /** resolved rows left for a later call because the per-call write cap was hit */
  remaining_after_cap: number;
}

interface CandidateRow {
  id: string;
  navn: string | null;
  kommune: string | null;
  kommunenummer: string | null;
  content_source: string | null;
}

function isBlankFylke(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

export function runGardssalgFylkeFromKommune(opts: {
  apply: boolean;
  batchId?: string | null;
}): GardssalgFylkeFromKommuneReport {
  const db = getDb("experiences");
  const batchId = opts.batchId ?? null;
  const rows = db
    .prepare(
      `SELECT id, navn, kommune, kommunenummer, content_source
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (fylke IS NULL OR TRIM(fylke) = '')
          AND ((kommune IS NOT NULL AND TRIM(kommune) != '')
               OR (kommunenummer IS NOT NULL AND TRIM(kommunenummer) != ''))
        ORDER BY id ASC`
    )
    .all() as CandidateRow[];

  const report: GardssalgFylkeFromKommuneReport = {
    dry_run: !opts.apply,
    batch_id: batchId,
    total_candidates: rows.length,
    resolved: 0,
    needs_review: 0,
    needs_review_samples: [],
    skipped_locked: 0,
    written: 0,
    remaining_after_cap: 0,
  };

  const toWrite: Array<{ id: string; fylke: string }> = [];
  for (const row of rows) {
    if (row.content_source === "manual" || row.content_source === "claim") {
      report.skipped_locked++;
      continue;
    }
    const result = resolveFylke2024({ kommunenummer: row.kommunenummer, kommune: row.kommune });
    if ("fylke" in result && result.fylke && result.fylke.trim()) {
      report.resolved++;
      toWrite.push({ id: row.id, fylke: result.fylke });
    } else {
      report.needs_review++;
      if (report.needs_review_samples.length < GS_FFK_SAMPLE_CAP) {
        report.needs_review_samples.push({
          id: row.id,
          navn: row.navn,
          kommune: row.kommune,
          reason: "needs_review" in result ? result.needs_review : "no_fylke",
        });
      }
    }
  }

  if (!opts.apply) return report;

  const update = db.prepare(
    `UPDATE experience_providers
        SET fylke = @fylke, updated_at = datetime('now')
      WHERE id = @id
        AND (fylke IS NULL OR TRIM(fylke) = '')
        AND (content_source IS NULL OR content_source NOT IN ('manual','claim'))`
  );
  const audit = db.prepare(
    `INSERT INTO gardssalg_content_audit
       (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
     VALUES (@id, @provider_id, 'fylke', NULL, @new_value, 'internal://fylke-from-kommune', @batch_id, 'admin', datetime('now'))`
  );
  const tx = db.transaction(() => {
    for (const t of toWrite) {
      if (report.written >= GS_FFK_BATCH_CAP) {
        report.remaining_after_cap++;
        continue;
      }
      const info = update.run({ id: t.id, fylke: t.fylke });
      if (info.changes > 0) {
        audit.run({ id: uuid(), provider_id: t.id, new_value: t.fylke, batch_id: batchId });
        report.written++;
      }
    }
  });
  tx();
  return report;
}

/**
 * Write-path helper: the fylke to store for a NEW/UPDATED provider. Returns
 * the existing fylke untouched when one is set (fill-only); otherwise the
 * resolveFylke2024 result for kommune/kommunenummer; otherwise null (never
 * guessed).
 */
export function fillFylkeFromKommune(opts: {
  fylke?: string | null;
  kommune?: string | null;
  kommunenummer?: string | null;
}): string | null {
  if (!isBlankFylke(opts.fylke)) return opts.fylke as string;
  const result = resolveFylke2024({ kommunenummer: opts.kommunenummer, kommune: opts.kommune });
  return "fylke" in result && result.fylke ? result.fylke : null;
}
