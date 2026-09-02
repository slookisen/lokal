// ─── POST /admin/dental/brreg-address-sweep ─────────────────────────────────
//
// dev-request 2026-09-02-dental-hjemmeside-hygiene-og-brreg-gjenfinning
// (steg 2b of the 2026-09-02 dental pipeline review).
//
// WHY: 4 522 of 6 975 dental_agents rows have no street address, because the
// Phase-A Brreg import (A2A dental-phase-a/A1-brreg-summary.csv) carried
// postnummer/poststed but no adresse column -- even though Brreg's
// Enhetsregisteret has a forretningsadresse (or postadresse) for every
// org_nr. The only two writers of adresse so far were the Places backfill
// (716 rows, paid) and homepage extraction. This sweep asks Brreg directly
// -- free, no key, the same GET /enheter/{orgNr} endpoint
// fetchBrregBusinessAddress() (services/brreg-client.ts) already wraps for
// the Places route's "Brreg first" address preference -- and FILL-ONLY
// writes adresse (and postnummer/poststed when those are empty too).
//
// Guard rails:
//   - fill-only: never overwrites a non-empty adresse; postnummer/poststed
//     only filled when empty (Brreg-wins rule is about contact fields the
//     clinic itself may have corrected on its site -- an empty column has
//     nothing to win).
//   - catalog_class-aware: only rows the classifier left as a clinic
//     (DENTAL_CLINIC_CLASS_SQL) and not is_inactive / rejected.
//   - no-retry marker brreg_address_attempted_at (init-dental.ts): a row
//     Brreg had no usable street line for is stamped and not re-asked for
//     BRREG_ADDRESS_NO_RETRY_DAYS days. A transport failure is NOT stamped.
//   - hard cap BRREG_ADDRESS_SWEEP_CAP rows per call, sequential requests
//     (brreg-client's own timeout applies), dry-run by default.
//   - field_provenance merged additively (source_type "brreg"), same shape
//     the PUT /agents/:id route and the Places route write.

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import { fetchBrregBusinessAddress } from "../services/brreg-client";
import { DENTAL_CLINIC_CLASS_SQL } from "../services/dental-catalog-class";

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

export const BRREG_ADDRESS_SWEEP_CAP = 100;
export const BRREG_ADDRESS_NO_RETRY_DAYS = 90;

interface SweepRow {
  id: string;
  navn: string;
  org_nr: string;
  postnummer: string | null;
  poststed: string | null;
  field_provenance: string | null;
}

export function candidateWhereSql(): string {
  return `org_nr IS NOT NULL AND org_nr <> ''
    AND (adresse IS NULL OR adresse = '')
    AND (is_inactive IS NULL OR is_inactive = 0)
    AND (verification_status IS NULL OR verification_status <> 'rejected')
    AND ${DENTAL_CLINIC_CLASS_SQL}
    AND (brreg_address_attempted_at IS NULL
         OR brreg_address_attempted_at < datetime('now', '-${BRREG_ADDRESS_NO_RETRY_DAYS} days'))`;
}

function parseProv(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Additive provenance merge for one field: append a {value, source_type,
// fetched_at} record to the field's array without touching other fields.
function appendProv(prov: Record<string, unknown>, field: string, value: string, nowIso: string): void {
  const existing = Array.isArray(prov[field]) ? (prov[field] as unknown[]) : [];
  prov[field] = [...existing, { value, source_type: "brreg", fetched_at: nowIso }];
}

const router = Router();

// POST /admin/dental/brreg-address-sweep
// Body: { write?: boolean (default false), limit?: number (default 25, cap 100) }
router.post("/brreg-address-sweep", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as { write?: unknown; limit?: unknown };
    const write = body.write === true;
    const limitRaw = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 25;
    const limit = Math.max(1, Math.min(BRREG_ADDRESS_SWEEP_CAP, limitRaw));

    const db = getDb("dental");
    const remaining = (db
      .prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE ${candidateWhereSql()}`)
      .get() as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT id, navn, org_nr, postnummer, poststed, field_provenance
           FROM dental_agents WHERE ${candidateWhereSql()}
          ORDER BY (hjemmeside IS NOT NULL AND hjemmeside <> '') DESC, navn ASC, id ASC
          LIMIT ?`,
      )
      .all(limit) as SweepRow[];

    const nowIso = new Date().toISOString();
    const stampAttempt = db.prepare("UPDATE dental_agents SET brreg_address_attempted_at = ? WHERE id = ?");
    const results: Array<{ id: string; navn: string; status: string; adresse?: string; fields_written?: string[] }> = [];
    let found = 0;
    let written = 0;
    let no_address = 0;
    let api_error = 0;

    for (const row of rows) {
      let addr: Awaited<ReturnType<typeof fetchBrregBusinessAddress>> = null;
      let transportOk = true;
      try {
        addr = await fetchBrregBusinessAddress(row.org_nr);
      } catch {
        transportOk = false;
      }
      if (!transportOk) {
        api_error++;
        results.push({ id: row.id, navn: row.navn, status: "api_error" });
        continue;
      }
      if (!addr || !addr.adresse) {
        no_address++;
        if (write) stampAttempt.run(nowIso, row.id);
        results.push({ id: row.id, navn: row.navn, status: "no_address" });
        continue;
      }
      found++;
      const fields: string[] = ["adresse"];
      const sets: string[] = ["adresse = @adresse"];
      const params: Record<string, unknown> = { id: row.id, adresse: addr.adresse, now: nowIso };
      const prov = parseProv(row.field_provenance);
      appendProv(prov, "address", addr.adresse, nowIso);
      if ((!row.postnummer || row.postnummer.trim() === "") && addr.postnummer) {
        sets.push("postnummer = @postnummer");
        params.postnummer = addr.postnummer;
        fields.push("postnummer");
      }
      if ((!row.poststed || row.poststed.trim() === "") && addr.poststed) {
        sets.push("poststed = @poststed");
        params.poststed = addr.poststed;
        fields.push("poststed");
      }
      if (write) {
        params.prov = JSON.stringify(prov);
        // Re-check adresse is STILL empty at write time (another writer --
        // Places batch, enrichment PUT -- may have filled it meanwhile).
        const r = db
          .prepare(
            `UPDATE dental_agents
                SET ${sets.join(", ")}, field_provenance = @prov,
                    brreg_address_attempted_at = @now, updated_at = datetime('now')
              WHERE id = @id AND (adresse IS NULL OR adresse = '')`,
          )
          .run(params);
        if (r.changes > 0) written++;
      }
      results.push({ id: row.id, navn: row.navn, status: write ? "written" : "would_write", adresse: addr.adresse, fields_written: fields });
    }

    res.json({
      success: true,
      data: {
        dry_run: !write,
        processed: rows.length,
        found,
        written,
        no_address,
        api_error,
        remaining_before: remaining,
        pool_empty: rows.length === 0,
        results,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

export default router;
