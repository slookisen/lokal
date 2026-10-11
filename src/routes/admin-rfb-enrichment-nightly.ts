// ─── Admin: the nightly RFB enrichment job (R6) ─────────────────────────────
//
// dev-request 2026-10-10-rfb-berikelse-nattjobb. Admin surfaces of
// services/rfb-enrichment-nightly.ts, mounted at /admin/rfb-enrichment-nightly
// in src/index.ts:
//
//   GET  /preview — what every step WOULD take tonight (ids + counts), the
//                   cohort's exclusion counts, caps, the BM cursor, whether
//                   the verifier tick lock is held right now. Read-only: no
//                   fetch, no write, no lock, no envelope. Works with the
//                   flag off (the spec's AC2 dry run).
//   POST /run     — {apply?: boolean}. Absent/false = the same dry run.
//                   apply:true runs the job once, now, behind the same guards
//                   as the night tick (flag, never 08:00–08:59Z, the verifier
//                   tick lock, caps, LLM cap, max runtime) — only the night
//                   slot is not required. A run can take up to the max
//                   runtime, so the call waits a short while: a skip (flag
//                   off, lock held, forbidden hour, already running) answers
//                   200 with the report; a run that is under way answers 202
//                   and its report lands in the run-ledger and in GET /last.
//                   A manual apply counts as that day's run (the next night
//                   tick waits 20 h), so the per-night caps hold.
//   GET  /last    — the last apply report this process produced (in memory).
//
// Same X-Admin-Key check (403) as admin-rfb-marketing.ts.

import { Router, Request, Response, NextFunction } from "express";
import { getDb } from "../database/init";
import {
  buildRfbEnrichmentPreview,
  runRfbEnrichmentNightly,
  type RfbEnrichmentNightlyReport,
} from "../services/rfb-enrichment-nightly";

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = getAdminKey();
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (!expected || !provided || provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return;
  }
  next();
}

/** How long POST /run apply waits for a quick answer before replying 202. */
const RUN_ROUTE_WAIT_MS_DEFAULT = 2_000;
let runRouteWaitMs = RUN_ROUTE_WAIT_MS_DEFAULT;
/** Test-only. Pass null to restore the default. */
export function __setRfbEnrichmentRunRouteWaitMsForTesting(ms: number | null): void {
  runRouteWaitMs = ms ?? RUN_ROUTE_WAIT_MS_DEFAULT;
}

let lastApplyReport: RfbEnrichmentNightlyReport | null = null;

export const rfbEnrichmentNightlyRouter = Router();

rfbEnrichmentNightlyRouter.get("/preview", requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json(await buildRfbEnrichmentPreview(getDb(), new Date()));
  } catch (err) {
    console.error("[rfb-enrichment-nightly] preview failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

rfbEnrichmentNightlyRouter.get("/last", requireAdmin, (_req: Request, res: Response) => {
  res.json({ report: lastApplyReport });
});

rfbEnrichmentNightlyRouter.post("/run", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { apply?: unknown };
  const apply = body.apply === true;
  try {
    if (!apply) {
      res.json(await runRfbEnrichmentNightly({ apply: false, trigger: "manual" }));
      return;
    }
    const run = runRfbEnrichmentNightly({ apply: true, trigger: "manual" }).then((r) => {
      lastApplyReport = r;
      return r;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), runRouteWaitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (waited) {
      res.json(waited);
      return;
    }
    run.catch((err) => console.error("[rfb-enrichment-nightly] manual run failed:", err));
    res.status(202).json({
      started: true,
      apply: true,
      note: "Kjøringen pågår. Rapporten kommer i run-ledger (agent rfb-enrichment-nightly) og i GET /admin/rfb-enrichment-nightly/last.",
    });
  } catch (err) {
    console.error("[rfb-enrichment-nightly] run failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
