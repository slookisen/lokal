// ─── POST /admin/dental/catalog-class-sonnet-sample ─────────────────────────
//
// dev-request 2026-09-02-dental-catalog-class-triage, slice 1c ("Sonnet-
// sample over the ambiguous catalog_class cohort"). The rule classifier
// (src/services/dental-catalog-class.ts) is deliberately conservative and
// known to sometimes rule-match "klinikk" via the company_dental_nace rule
// (any AS/DA/ANS/... with dental NACE code but no dental word in the name)
// on rows that are NOT actually dental clinics — a hearing-aid lab, an
// orthopedics supplier, etc. This endpoint runs the LLM judge
// (src/services/dental-catalog-class-judge.ts) over exactly that ambiguous
// sub-cohort to catch what the rules missed.
//
// Candidate cohort (see CANDIDATE_SQL below): catalog_class = 'ukjent' OR
// (catalog_class = 'klinikk' AND catalog_class_source =
// 'rules_v1:company_dental_nace'), WITH a hjemmeside (the judge needs at
// least a URL string as context), and NOT already stamped by a prior Sonnet
// verdict (catalog_class_source NOT LIKE 'sonnet%'). That last clause makes
// the endpoint idempotent: a row this judge already ruled on is never
// re-judged (no repeat LLM cost, no silently-overwriting second verdict).
//
// Judged SEQUENTIALLY (no Promise.all) — deliberately avoids bursting the
// Anthropic API, same restraint as every other admin sweep in this codebase
// that calls an LLM judge per row.
//
// Dry-run by default (apply:false) — mirrors admin-dental-catalog-class.ts's
// write/overwrite convention: the response reports what WOULD happen, with
// a sample, before any real write.
//
// Per verdict, on apply:true:
//   not_a_clinic     -> recordExclusion(reason:"not_a_clinic") + fill-only
//                       verification_status='rejected' (never clobbers an
//                       existing needs_review/rejected status set by some
//                       other mechanism). catalog_class ITSELF is
//                       deliberately left untouched on this row — the
//                       exclusions table remains the source of truth for
//                       "not a clinic at all", not the catalog_class enum
//                       (which has no "rejected" member by design). BUT
//                       catalog_class_source/catalog_class_at ARE stamped
//                       (literal "sonnet:not_a_clinic") — this is provenance
//                       metadata this endpoint already owns, and writing it
//                       here is what makes CANDIDATE_SQL's own
//                       "catalog_class_source NOT LIKE 'sonnet%'" clause
//                       naturally exclude this row from every future scan.
//                       Without this stamp the row would never leave the
//                       candidate cohort (not_a_clinic never changes
//                       catalog_class, which the ukjent/company_dental_nace
//                       predicate keeps matching), so it would be
//                       re-selected, re-judged (repeat LLM cost) and
//                       re-excluded (a fresh duplicate dental_exclusions
//                       row) on every subsequent apply:true call — and,
//                       since selection is ORDER BY navn ASC, id ASC LIMIT
//                       ?, a stuck row sorting early could permanently
//                       starve real candidates out of the limit budget.
//   ukjent           -> no write at all. Row keeps its current class and is
//                       NOT stamped sonnet%, so it stays eligible for a
//                       future re-run.
//   one of the 5 real classes -> catalog_class/catalog_class_source='sonnet'
//                       /catalog_class_at updated. This deliberately
//                       OVERWRITES a prior rules_v1:* classification (the
//                       whole point of this slice) but can never touch a row
//                       already stamped sonnet% because of CANDIDATE_SQL's
//                       own exclusion.
//
// Same X-Admin-Key gate (requireAdmin) and mount idiom as
// admin-dental-catalog-class.ts.

import { Router, Request, Response } from "express";
import { getDb } from "../database/db-factory";
import {
  judgeDentalCatalogClass,
  type DentalSonnetVerdictClass,
} from "../services/dental-catalog-class-judge";
import { type DentalCatalogClass } from "../services/dental-catalog-class";
import { recordExclusion } from "../services/dental-store";

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

export const CATALOG_CLASS_SONNET_SAMPLE_DEFAULT_LIMIT = 20;
export const CATALOG_CLASS_SONNET_SAMPLE_LIMIT_CAP = 50;
export const CATALOG_CLASS_SONNET_SAMPLE_SOURCE = "sonnet";
// Stamped on catalog_class_source (catalog_class itself is left untouched)
// for a not_a_clinic verdict. Matches CANDIDATE_SQL's own
// "catalog_class_source NOT LIKE 'sonnet%'" clause, so a not_a_clinic row is
// naturally excluded from every future scan — see the file-header comment
// (addresses independent-review CHANGES-REQUESTED: without this stamp a
// not_a_clinic row was re-selected/re-judged/re-excluded on every
// subsequent apply:true call).
export const CATALOG_CLASS_SONNET_SAMPLE_NOT_A_CLINIC_SOURCE = "sonnet:not_a_clinic";

// Exported so tests can assert the candidate cohort directly without
// re-deriving the SQL string.
export const CATALOG_CLASS_SONNET_SAMPLE_CANDIDATE_SQL = `
  (catalog_class = 'ukjent' OR (catalog_class = 'klinikk' AND catalog_class_source = 'rules_v1:company_dental_nace'))
  AND hjemmeside IS NOT NULL AND hjemmeside <> ''
  AND (catalog_class_source IS NULL OR catalog_class_source NOT LIKE 'sonnet%')
`;

interface CandidateRow {
  id: string;
  navn: string;
  naeringskode: string | null;
  organisasjonsform: string | null;
  hjemmeside: string | null;
  catalog_class: DentalCatalogClass;
  org_nr: string | null;
}

interface SampleEntry {
  navn: string;
  currentClass: DentalCatalogClass;
  verdict_class: DentalSonnetVerdictClass;
  reason: string;
}

const REAL_CLASSES: readonly DentalCatalogClass[] = [
  "klinikk",
  "offentlig_klinikk",
  "person_enk",
  "lab_leverandor",
  "holding",
];

function isRealClass(v: DentalSonnetVerdictClass): v is DentalCatalogClass {
  return (REAL_CLASSES as readonly string[]).includes(v);
}

const router = Router();

// POST /admin/dental/catalog-class-sonnet-sample
// Body: { apply?: boolean (default false = dry-run), limit?: number (default 20, cap 50) }
router.post("/catalog-class-sonnet-sample", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = (req.body ?? {}) as { apply?: unknown; limit?: unknown };
    const apply = body.apply === true;
    const limitRaw =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.floor(body.limit)
        : CATALOG_CLASS_SONNET_SAMPLE_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(CATALOG_CLASS_SONNET_SAMPLE_LIMIT_CAP, limitRaw));

    const db = getDb("dental");
    const rows = db
      .prepare(
        `SELECT id, navn, naeringskode, organisasjonsform, hjemmeside, catalog_class, org_nr
           FROM dental_agents
          WHERE ${CATALOG_CLASS_SONNET_SAMPLE_CANDIDATE_SQL}
          ORDER BY navn ASC, id ASC
          LIMIT ?`,
      )
      .all(limit) as CandidateRow[];

    const counts_by_verdict: Record<string, number> = {};
    const sample: SampleEntry[] = [];
    let applied = 0;
    let excluded_count = 0;

    const nowIso = new Date().toISOString();
    const updateClassStmt = db.prepare(
      `UPDATE dental_agents SET catalog_class = ?, catalog_class_source = ?, catalog_class_at = ? WHERE id = ?`,
    );
    const rejectStatusStmt = db.prepare(
      `UPDATE dental_agents SET verification_status = 'rejected'
        WHERE id = ? AND (verification_status IS NULL OR verification_status NOT IN ('rejected','needs_review'))`,
    );
    // Stamps provenance ONLY — never touches catalog_class itself. This is
    // what makes CANDIDATE_SQL's existing "NOT LIKE 'sonnet%'" clause
    // naturally exclude a not_a_clinic row from all future scans.
    const stampNotAClinicSourceStmt = db.prepare(
      `UPDATE dental_agents SET catalog_class_source = ?, catalog_class_at = ? WHERE id = ?`,
    );

    // Sequential — never Promise.all — to avoid bursting the Anthropic API.
    for (const row of rows) {
      const verdict = await judgeDentalCatalogClass({
        navn: row.navn,
        naeringskode: row.naeringskode,
        organisasjonsform: row.organisasjonsform,
        hjemmeside: row.hjemmeside,
        currentClass: row.catalog_class,
      });

      counts_by_verdict[verdict.verdict_class] = (counts_by_verdict[verdict.verdict_class] ?? 0) + 1;
      if (sample.length < 10) {
        sample.push({
          navn: row.navn,
          currentClass: row.catalog_class,
          verdict_class: verdict.verdict_class,
          reason: verdict.reason,
        });
      }

      if (!apply) continue;

      if (verdict.verdict_class === "not_a_clinic") {
        recordExclusion({
          orgnr: row.org_nr ?? null,
          hjemmesideUrl: row.hjemmeside ?? null,
          reason: "not_a_clinic",
          evidence: verdict.reason,
          notes: "dental-catalog-class-sonnet-sample",
          excludedBy: "dental-catalog-class-sonnet-sample",
        });
        excluded_count++;
        rejectStatusStmt.run(row.id);
        stampNotAClinicSourceStmt.run(CATALOG_CLASS_SONNET_SAMPLE_NOT_A_CLINIC_SOURCE, nowIso, row.id);
      } else if (isRealClass(verdict.verdict_class)) {
        updateClassStmt.run(verdict.verdict_class, CATALOG_CLASS_SONNET_SAMPLE_SOURCE, nowIso, row.id);
        applied++;
      }
      // "ukjent" -> no write at all.
    }

    res.json({
      success: true,
      data: {
        dry_run: !apply,
        scanned: rows.length,
        applied,
        excluded_count,
        counts_by_verdict,
        sample,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

export default router;
