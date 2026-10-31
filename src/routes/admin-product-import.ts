// ─── Admin: product import dry run (Skive 1, measurement only) ──────────────
//
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 1.
//
//   POST /admin/product-import/dry-run       body {agentIds?, sampleSize?≈100, llmCallCap?≤150}
//        → 202 {run_id, status:'running', profiles_total, poll}
//   GET  /admin/product-import/dry-run       → recent runs
//   GET  /admin/product-import/dry-run/:id   → run + summary + per-profile results
//        (?candidates=0 leaves the candidate lists out)
//
// Behind PRODUCT_IMPORT_DRYRUN_ENABLED ("1"; default off → 404, as if the
// route did not exist) and the X-Admin-Key check every admin route uses.
// Writes only product_import_runs / product_import_run_results — never
// agent_knowledge or products. Nothing is published.
//
// Skive 3b-1 (outreach pre-extraction, flag PRODUCT_IMPORT_OUTREACH_ENABLED,
// own 404 when off; same X-Admin-Key check):
//   POST /admin/product-import/prepare   body {agentIds[], campaign} → 202 {prepare_id, …}
//   GET  /admin/product-import/prepare/:campaign[?format=md] → read-only report
// Stages candidates in product_import_candidates only; never publishes, never sends e-mail.

import { Router, Request, Response } from "express";
import {
  activeDryRunId,
  getDryRun,
  listDryRuns,
  productImportDryRunEnabled,
  startProductImportDryRun,
} from "../services/product-import/dry-run";
import {
  activeOutreachPrepareId,
  getOutreachReport,
  OUTREACH_CAMPAIGN_RE,
  productImportOutreachEnabled,
  renderOutreachReportMd,
  startOutreachPrepare,
  validatePrepareInput,
} from "../services/product-import/outreach-prepare";

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

function requireFlag(res: Response): boolean {
  if (productImportDryRunEnabled()) return true;
  res.status(404).json({ error: "Not found" });
  return false;
}

router.post("/dry-run", (req: Request, res: Response) => {
  if (!requireFlag(res) || !requireAdmin(req, res)) return;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  let agentIds: string[] | undefined;
  if (body.agentIds !== undefined) {
    if (!Array.isArray(body.agentIds) || body.agentIds.some((x) => typeof x !== "string" || !x.trim())) {
      return res.status(400).json({ error: "agentIds må være en liste med tekst-id-er" });
    }
    agentIds = (body.agentIds as string[]).map((x) => x.trim());
  }
  if (body.sampleSize !== undefined && (typeof body.sampleSize !== "number" || !Number.isFinite(body.sampleSize) || body.sampleSize < 1)) {
    return res.status(400).json({ error: "sampleSize må være et positivt tall" });
  }
  if (body.llmCallCap !== undefined && (typeof body.llmCallCap !== "number" || !Number.isFinite(body.llmCallCap) || body.llmCallCap < 0)) {
    return res.status(400).json({ error: "llmCallCap må være et tall ≥ 0" });
  }

  const active = activeDryRunId();
  if (active) {
    return res.status(409).json({ error: "En målekjøring pågår allerede", run_id: active });
  }

  const started = startProductImportDryRun({
    agentIds,
    sampleSize: body.sampleSize as number | undefined,
    llmCallCap: body.llmCallCap as number | undefined,
  });
  return res.status(202).json({
    run_id: started.run_id,
    mode: "dry_run",
    status: "running",
    profiles_total: started.profiles_total,
    llm_call_cap: started.llm_call_cap,
    poll: `/admin/product-import/dry-run/${started.run_id}`,
  });
});

router.get("/dry-run", (req: Request, res: Response) => {
  if (!requireFlag(res) || !requireAdmin(req, res)) return;
  const limit = parseInt(String(req.query?.limit ?? "20"), 10);
  const runs = listDryRuns(Number.isFinite(limit) ? limit : 20);
  return res.json({ count: runs.length, runs });
});

router.get("/dry-run/:id", (req: Request, res: Response) => {
  if (!requireFlag(res) || !requireAdmin(req, res)) return;
  const run = getDryRun(String(req.params.id), { includeCandidates: String(req.query?.candidates ?? "1") !== "0" });
  if (!run) return res.status(404).json({ error: "Fant ikke kjøringen" });
  return res.json(run);
});

function requireOutreachFlag(res: Response): boolean {
  if (productImportOutreachEnabled()) return true;
  res.status(404).json({ error: "Not found" });
  return false;
}

router.post("/prepare", (req: Request, res: Response) => {
  if (!requireOutreachFlag(res) || !requireAdmin(req, res)) return;
  const input = validatePrepareInput(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error, message: input.message });
  const active = activeOutreachPrepareId();
  if (active) return res.status(409).json({ error: "Et forhåndsuttrekk pågår allerede", prepare_id: active });
  const started = startOutreachPrepare(input.agentIds, input.campaign);
  return res.status(202).json({
    ...started,
    mode: "outreach_prepare",
    status: "running",
    poll: `/admin/product-import/prepare/${started.campaign}`,
  });
});

router.get("/prepare/:campaign", (req: Request, res: Response) => {
  if (!requireOutreachFlag(res) || !requireAdmin(req, res)) return;
  const campaign = String(req.params.campaign ?? "");
  if (!OUTREACH_CAMPAIGN_RE.test(campaign)) return res.status(400).json({ error: "invalid_campaign" });
  const report = getOutreachReport(campaign);
  if (!report) return res.status(404).json({ error: "Fant ingen forhåndsuttrekk for kampanjen" });
  if (String(req.query?.format ?? "") === "md") {
    return res.type("text/markdown; charset=utf-8").send(renderOutreachReportMd(report));
  }
  return res.json(report);
});

export default router;
