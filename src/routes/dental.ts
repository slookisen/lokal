// ─── Dental Routes — Phase 6 (PR-89) ────────────────────────────────
//
// All endpoints under /api/tannlege/*. Mirrors the shape of
// /api/marketplace/* but every query goes through dental-store
// against /data/dental.db. Zero overlap with rfb's marketplace.ts.
//
// Mounted in src/index.ts as: app.use('/api/tannlege', dentalRoutes);
// (see src/index.ts.diff for the exact 3-line patch).
//
// Admin endpoints (POST/PUT) require X-Admin-Key header. Reuses the
// same env var as rfb (ADMIN_KEY || ANALYTICS_ADMIN_KEY) so ops only
// rotates one secret.

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  createDentalAgent,
  getDentalAgentById,
  getDentalAgentByOrgnr,
  listDentalAgents,
  listSpecialistsForClinic,
  listChains,
  updateDentalAgent,
  DentalAgentSchema,
  ListFilterSchema,
  listExclusions,
  recordExclusion,
  ExclusionReason,
  bulkInsertFromMerged,
} from "../services/dental-store";

const router = Router();

// ─── Admin auth ─────────────────────────────────────────────────────
// Same shape as marketplace.ts:getAdminKey() — accept either env var
// so the enrichment pipeline can authenticate with the same key the
// dashboard uses.
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

// ─── GET /api/tannlege/agents — list with filters ───────────────────
//   ?fylke=Oslo
//   ?chain_brand=Volvat
//   ?specialty=kjeveortopedi
//   ?verification_status=verified
//   ?limit=50&offset=0
router.get("/agents", (req: Request, res: Response) => {
  try {
    const filter = ListFilterSchema.parse({
      fylke: req.query.fylke as string | undefined,
      chain_brand: req.query.chain_brand as string | undefined,
      specialty: req.query.specialty as string | undefined,
      verification_status: req.query.verification_status as
        | string
        | undefined,
    });
    const limit = Math.min(
      500,
      Math.max(1, parseInt((req.query.limit as string) || "50", 10) || 50)
    );
    const offset = Math.max(
      0,
      parseInt((req.query.offset as string) || "0", 10) || 0
    );

    const agents = listDentalAgents(filter, limit, offset);
    res.json({ count: agents.length, agents });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid query", details: err.issues });
      return;
    }
    console.error("[tannlege] /agents failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/tannlege/agents/:id — single agent ────────────────────
router.get("/agents/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  // Allow lookup by org_nr too, mirrors marketplace UX.
  const agent = /^\d{9}$/.test(id)
    ? getDentalAgentByOrgnr(id)
    : getDentalAgentById(id);
  if (!agent) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ agent });
});

// ─── GET /api/tannlege/agents/:id/specialists ───────────────────────
router.get("/agents/:id/specialists", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const agent = getDentalAgentById(id);
  if (!agent) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const specialists = listSpecialistsForClinic(id);
  res.json({ count: specialists.length, specialists });
});

// ─── GET /api/tannlege/chains ───────────────────────────────────────
router.get("/chains", (_req: Request, res: Response) => {
  const chains = listChains();
  res.json({ count: chains.length, chains });
});

// ─── POST /api/tannlege/agents (admin) ──────────────────────────────
router.post("/agents", requireAdmin, (req: Request, res: Response) => {
  try {
    const parsed = DentalAgentSchema.parse(req.body);
    // Reject duplicates on org_nr — bulk pipeline should use the
    // dental-store.bulkInsertFromMerged() entry point which uses
    // INSERT OR IGNORE; this REST endpoint is for hand-curated entries.
    if (parsed.org_nr) {
      const existing = getDentalAgentByOrgnr(parsed.org_nr);
      if (existing) {
        res
          .status(409)
          .json({ error: "Agent with this org_nr already exists", id: existing.id });
        return;
      }
    }
    const id = createDentalAgent(parsed);
    res.status(201).json({ id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid body", details: err.issues });
      return;
    }
    console.error("[tannlege] POST /agents failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── PUT /api/tannlege/agents/:id (admin) ───────────────────────────
router.put("/agents/:id", requireAdmin, (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    // Partial schema — every field optional. Casts to Partial<DentalAgent>.
    const PartialSchema = DentalAgentSchema.partial();
    const parsed = PartialSchema.parse(req.body);
    const ok = updateDentalAgent(id, parsed);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ id, updated: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid body", details: err.issues });
      return;
    }
    console.error("[tannlege] PUT /agents/:id failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/tannlege/discover — A2A-style search ──────────────────
// Lightweight discovery endpoint for AI-agent integration. Same query
// shape as listDentalAgents but the response envelope mirrors the
// marketplace discovery contract (so consumer agents have one mental
// model across verticals).
router.get("/discover", (req: Request, res: Response) => {
  try {
    const filter = ListFilterSchema.parse({
      fylke: req.query.fylke as string | undefined,
      chain_brand: req.query.chain_brand as string | undefined,
      specialty: req.query.specialty as string | undefined,
      verification_status: req.query.verification_status as
        | string
        | undefined,
    });
    const limit = Math.min(
      100,
      Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20)
    );
    const agents = listDentalAgents(filter, limit, 0);
    res.json({
      vertical: "dental",
      query: filter,
      count: agents.length,
      results: agents.map((a) => ({
        id: a.id,
        navn: a.navn,
        org_nr: a.org_nr,
        fylke: a.fylke,
        poststed: a.poststed,
        chain_brand: a.chain_brand,
        available_specialties: a.available_specialties,
        verification_status: a.verification_status,
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid query", details: err.issues });
      return;
    }
    console.error("[tannlege] /discover failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── GET /api/tannlege/exclusions (admin) — PR-90 ───────────────────
// List current anti-rediscovery exclusions. Filter by reason.
router.get("/exclusions", requireAdmin, (req: Request, res: Response) => {
  try {
    const reason = req.query.reason as ExclusionReason | undefined;
    const limit = Math.min(
      500,
      Math.max(1, parseInt((req.query.limit as string) || "100", 10) || 100)
    );
    const exclusions = listExclusions({ reason, limit });
    res.json({ count: exclusions.length, exclusions });
  } catch (err) {
    console.error("[tannlege] GET /exclusions failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/tannlege/exclusions (admin) — PR-90 ──────────────────
// Record a new exclusion. Body shape:
//   { orgnr?, hjemmesideUrl?, navnPattern?, reason, evidence?, notes?,
//     excludedBy?, reactivateAfter?, isPermanent? }
router.post("/exclusions", requireAdmin, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (!body.reason) {
      res.status(400).json({ error: "Missing required field: reason" });
      return;
    }
    if (!body.orgnr && !body.hjemmesideUrl && !body.navnPattern) {
      res
        .status(400)
        .json({ error: "Need at least one of orgnr, hjemmesideUrl, navnPattern" });
      return;
    }
    const id = recordExclusion({
      orgnr: body.orgnr,
      hjemmesideUrl: body.hjemmesideUrl,
      navnPattern: body.navnPattern,
      reason: body.reason,
      evidence: body.evidence,
      notes: body.notes,
      excludedBy: body.excludedBy || "admin-manual",
      reactivateAfter: body.reactivateAfter,
      isPermanent: !!body.isPermanent,
    });
    res.status(201).json({ id, excluded: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tannlege] POST /exclusions failed", err);
    res.status(400).json({ error: msg });
  }
});

// ─── POST /api/tannlege/agents/bulk-import (admin) — PR-90b ─────────
// Bulk-insert a large batch of agents in a single transaction. Used
// for the Phase A enrichment pipeline (6974 rows). Excluded rows are
// skipped via isExcluded(). Returns {inserted, skipped, excluded}.
//
// Body: { agents: MergedRow[] }
router.post("/agents/bulk-import", requireAdmin, (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const agents = body.agents;
    if (!Array.isArray(agents)) {
      res.status(400).json({ error: "Body must be { agents: [...] }" });
      return;
    }
    if (agents.length > 10000) {
      res.status(400).json({ error: "Max 10000 agents per call" });
      return;
    }
    const result = bulkInsertFromMerged(agents);
    res.json({ ok: true, ...result, total: agents.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tannlege] POST /agents/bulk-import failed", err);
    res.status(500).json({ error: msg });
  }
});

export default router;
