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
// own 404 when off; "pilot" = only allowlisted agentIds start; same X-Admin-Key check):
//   POST /admin/product-import/prepare   body {agentIds[], campaign} → 202 {prepare_id, …}
//   GET  /admin/product-import/prepare/:campaign[?format=md] → read-only report
// Stages candidates in product_import_candidates only; never publishes, never sends e-mail.
//
// Skive 3b-2 (same flag, same X-Admin-Key check; both read-only):
//   GET  /admin/product-import/prepare/:campaign/links → one signed landing link per
//        recipient with ≥ 1 eligible candidate (for POST /admin/crm/compose to merge);
//        recipients with 0 candidates are listed under without_link, with no link
//   GET  /admin/product-import/prepare/:campaign/log   → per recipient: extracted,
//        opened, confirmed (count), «på lager» chosen (yes/no)

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
  productImportOutreachAdminEnabledFor,
  productImportOutreachMode,
  renderOutreachReportMd,
  startOutreachPrepare,
  validatePrepareInput,
} from "../services/product-import/outreach-prepare";
import { getOutreachLinks, getOutreachLog } from "../services/product-import/outreach-landing";

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

// Flag "pilot" (dev-request 2026-11-05-eierflagg-koblet-til-pilotlisten): the
// routes exist; POST /prepare starts only the agentIds on the pilot list
// (OWNER_FEATURES_ALLOWED_SUBJECTS `rfb:<id>`), the rest are listed under
// `rejected` with a per-id error and nothing is started for them.
function requireOutreachFlag(res: Response): boolean {
  if (productImportOutreachMode() !== "off") return true;
  res.status(404).json({ error: "Not found" });
  return false;
}

router.post("/prepare", (req: Request, res: Response) => {
  if (!requireOutreachFlag(res) || !requireAdmin(req, res)) return;
  const input = validatePrepareInput(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error, message: input.message });
  const pilot = productImportOutreachMode() === "pilot";
  // N1 (beta-for-alle S3): admin-initiated outreach is capped at the pilot
  // list and never follows a `beta` tier — a beta owner is reached only when
  // the owner started the import, never by this admin call.
  const agentIds = pilot ? input.agentIds.filter((id) => productImportOutreachAdminEnabledFor(id)) : input.agentIds;
  const rejected = pilot
    ? input.agentIds.filter((id) => !agentIds.includes(id)).map((agent_id) => ({
      agent_id,
      error: "not_in_pilot_list",
      message: "Produsenten er ikke på pilotlisten (OWNER_FEATURES_ALLOWED_SUBJECTS). Ingenting er startet for den.",
    }))
    : [];
  const pilotFields = pilot ? { flag_mode: "pilot" as const, rejected } : {};
  if (agentIds.length === 0) {
    return res.status(400).json({
      error: "no_pilot_agent_ids",
      message: "Ingen av produsentene er på pilotlisten. Ingenting er startet.",
      ...pilotFields,
    });
  }
  const active = activeOutreachPrepareId();
  if (active) return res.status(409).json({ error: "Et forhåndsuttrekk pågår allerede", prepare_id: active, ...pilotFields });
  const started = startOutreachPrepare(agentIds, input.campaign);
  return res.status(202).json({
    ...started,
    mode: "outreach_prepare",
    status: "running",
    poll: `/admin/product-import/prepare/${started.campaign}`,
    ...pilotFields,
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

router.get("/prepare/:campaign/links", (req: Request, res: Response) => {
  if (!requireOutreachFlag(res) || !requireAdmin(req, res)) return;
  const campaign = String(req.params.campaign ?? "");
  if (!OUTREACH_CAMPAIGN_RE.test(campaign)) return res.status(400).json({ error: "invalid_campaign" });
  res.setHeader("Cache-Control", "no-store");
  const r = getOutreachLinks(campaign);
  if (!r.ok) {
    if (r.error === "secret_missing") return res.status(503).json({ error: "Lenkesignering er ikke satt opp" });
    return res.status(404).json({ error: "Fant ingen forhåndsuttrekk for kampanjen" });
  }
  const { ok: _ok, ...rest } = r;
  return res.json(rest);
});

router.get("/prepare/:campaign/log", (req: Request, res: Response) => {
  if (!requireOutreachFlag(res) || !requireAdmin(req, res)) return;
  const campaign = String(req.params.campaign ?? "");
  if (!OUTREACH_CAMPAIGN_RE.test(campaign)) return res.status(400).json({ error: "invalid_campaign" });
  const log = getOutreachLog(campaign);
  if (!log) return res.status(404).json({ error: "Fant ingen forhåndsuttrekk for kampanjen" });
  return res.json(log);
});

export default router;
