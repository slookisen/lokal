// ─── /admin/dental/triage ────────────────────────────────────────────────
// dev-request 2026-09-02-dental-permanent-triage-needs-review-drain, slice 3c-1.
// See src/services/dental-triage.ts for what the job decides and writes.
//
//   POST /admin/dental/triage/dry-run   body: { limit?: 1–50, ids?: string[] }
//     Computes the decisions for the candidate rows (or for the named ids that
//     are in the triage state) and returns them. Writes NOTHING, whatever
//     DENTAL_TRIAGE_JOB_ENABLED or the write-pause say. Brreg / homepage reads
//     happen (read-only).
//   POST /admin/dental/triage/run       body: { limit?: 1–50 }
//     One real pass. 503 dental_triage_disabled while the flag is off, 423
//     (standard body) while the dental enrichment write-pause is on, 409 while
//     a pass is already running.
//
// Requires X-Admin-Key (same requireAdmin idiom as the sibling dental admin
// route files).

import { Router, Request, Response } from "express";
import {
  clampDentalTriageLimit,
  computeDentalTriageDryRun,
  dentalTriageJobEnabled,
  formatDentalTriageSummary,
  isDentalTriageRunning,
  runDentalTriage,
  DENTAL_TRIAGE_MAX_BATCH,
} from "../services/dental-triage";
import { dentalEnrichmentWritePauseBlock } from "../services/dental-enrichment-write-pause";
import { ENRICHMENT_WRITE_PAUSE_HTTP_STATUS } from "../services/enrichment-write-pause";

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

// Test seam: an injected fetch for the Brreg and homepage reads, so route
// tests never touch the network. Production leaves it undefined (global fetch).
let triageFetchImpl: typeof fetch | undefined;
export function __setDentalTriageFetchForTesting(fn?: typeof fetch): void {
  triageFetchImpl = fn;
}

const router = Router();

router.post("/dry-run", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const body = (req.body ?? {}) as { limit?: unknown; ids?: unknown };

  let ids: string[] | undefined;
  if (body.ids !== undefined) {
    if (
      !Array.isArray(body.ids) ||
      body.ids.length === 0 ||
      body.ids.length > DENTAL_TRIAGE_MAX_BATCH ||
      !body.ids.every((v) => typeof v === "string" && v.trim() !== "")
    ) {
      res.status(400).json({ error: `ids must be a non-empty array of at most ${DENTAL_TRIAGE_MAX_BATCH} non-empty strings` });
      return;
    }
    ids = Array.from(new Set((body.ids as string[]).map((s) => s.trim())));
  }
  const limit = clampDentalTriageLimit(body.limit);

  try {
    const result = await computeDentalTriageDryRun({ limit, ids, fetchImpl: triageFetchImpl });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: "Dental triage dry-run failed", detail: err?.message ?? String(err) });
  }
});

router.post("/run", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  if (!dentalTriageJobEnabled()) {
    res.status(503).json({ error: "dental_triage_disabled" });
    return;
  }
  const pauseBlock = dentalEnrichmentWritePauseBlock();
  if (pauseBlock) {
    res.status(ENRICHMENT_WRITE_PAUSE_HTTP_STATUS).json(pauseBlock);
    return;
  }
  if (isDentalTriageRunning()) {
    res.status(409).json({ error: "dental_triage_already_running" });
    return;
  }
  const body = (req.body ?? {}) as { limit?: unknown };
  try {
    const summary = await runDentalTriage({ limit: clampDentalTriageLimit(body.limit), fetchImpl: triageFetchImpl });
    console.log(formatDentalTriageSummary(summary));
    res.json({ success: true, ...summary });
  } catch (err: any) {
    res.status(500).json({ error: "Dental triage run failed", detail: err?.message ?? String(err) });
  }
});

export default router;
