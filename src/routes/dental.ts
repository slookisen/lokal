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

export default router;
