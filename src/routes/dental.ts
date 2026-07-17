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
  normalizeOpeningHours,
  // enrichment-metode slice 1 (2026-07-16): dead-homepage parking
  recordDentalHomepageFetchResult,
  // dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
  // item 2a (2026-07-17): dead-extraction parking
  recordDentalExtractionResult,
  DENTAL_AGENT_WRITABLE_FIELDS,
} from "../services/dental-store";
import { getDb } from "../database/db-factory";
import { isDisplayablePhone } from "../services/contact-normalizer";
import { mergeFieldProvenance } from "./admin-knowledge";
import {
  placesPeriodsToOpeningHours,
  isConfidentPlaceMatch,
  normalizePlacePhone,
  isValidHttpUrl,
  shouldUseEnterpriseFieldMask,
  type PlacesPlace,
} from "../services/dental-places";
import { nameSimilarity } from "../services/name-matcher";
import { logPlacesCall, getPlacesUsageThisMonth } from "../services/places-usage-tracker";
import { findOrgnumberByName } from "../services/brreg-client";

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
//   ?enrichment_state=raw|enriched|thin_site
//   ?limit=50&offset=0
//
// PR-120: enrichment_state is now extracted from query params (was silently
// dropped before). Unknown enum values (for forward-compat) are silently
// ignored via safeParse — we strip failing fields and re-parse rather than
// returning 400, keeping the endpoint backward-compatible.
router.get("/agents", (req: Request, res: Response) => {
  try {
    // Build raw input from all supported query params (PR-120 adds enrichment_state).
    const rawFilter = {
      fylke: req.query.fylke as string | undefined,
      chain_brand: req.query.chain_brand as string | undefined,
      specialty: req.query.specialty as string | undefined,
      verification_status: req.query.verification_status as string | undefined,
      enrichment_state: req.query.enrichment_state as string | undefined,
      q: req.query.q as string | undefined,
      helfo_agreement: req.query.helfo_agreement as string | undefined,
      poststed: req.query.poststed as string | undefined,
      // acute_vakt: parse to number so z.literal(0|1) validates correctly
      acute_vakt: req.query.acute_vakt !== undefined
        ? (parseInt(req.query.acute_vakt as string, 10) as 0 | 1)
        : undefined,
    };
    // safeParse first; if enum fields hold unknown values strip them and
    // retry so the endpoint never 400s on unknown-but-harmless query values.
    let filterResult = ListFilterSchema.safeParse(rawFilter);
    if (!filterResult.success) {
      const badKeys = new Set(
        filterResult.error.issues
          .filter((i) => i.code === "invalid_value")
          .map((i) => i.path[0] as string)
      );
      if (badKeys.size > 0) {
        const stripped = Object.fromEntries(
          Object.entries(rawFilter).filter(([k]) => !badKeys.has(k))
        );
        filterResult = ListFilterSchema.safeParse(stripped);
      }
    }
    if (!filterResult.success) {
      // Remaining errors are genuinely invalid (e.g. type mismatches).
      res.status(400).json({ error: "Invalid query", details: filterResult.error.issues });
      return;
    }
    const filter = filterResult.data;
    const limit = Math.min(
      500,
      Math.max(1, parseInt((req.query.limit as string) || "50", 10) || 50)
    );
    const offset = Math.max(
      0,
      parseInt((req.query.offset as string) || "0", 10) || 0
    );

    // enrichment-metode slice 1: ?exclude_parked=1 skips clinics parked by 3
    // consecutive homepage-fetch failures (30d backoff) — the enrichment
    // routine's candidate listing. Absent param = unchanged behavior.
    const excludeParked = req.query.exclude_parked === "1" || req.query.exclude_parked === "true";
    const agents = listDentalAgents(filter, limit, offset, { excludeParked }).map((a) => ({
      ...a,
      telefon: isDisplayablePhone(a.telefon) ? a.telefon : null,
      mobil: isDisplayablePhone(a.mobil) ? a.mobil : null,
    }));
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
  res.json({
    agent: {
      ...agent,
      telefon: isDisplayablePhone(agent.telefon) ? agent.telefon : null,
      mobil: isDisplayablePhone(agent.mobil) ? agent.mobil : null,
    },
  });
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
    const body: Record<string, unknown> =
      req.body && typeof req.body === "object" ? { ...(req.body as Record<string, unknown>) } : {};

    // PR-127: pre-normalize opening_hours (messy real-world hours) before
    // validation so a sloppy entry no longer 400s the whole record.
    let openingHoursDropped = 0;
    if ("opening_hours" in body && body.opening_hours != null) {
      const norm = normalizeOpeningHours(body.opening_hours);
      openingHoursDropped = norm.dropped;
      if (norm.value && norm.value.length) body.opening_hours = norm.value;
      else delete body.opening_hours; // nothing salvageable — don't fail the PUT
    }

    // PR-127: tolerant parse — strip any still-invalid top-level fields and
    // re-parse, mirroring the list-endpoint philosophy (never 400 a whole
    // enrichment PUT over one bad field). 422 only if NOTHING is valid.
    const strippedFields: string[] = [];
    let result = PartialSchema.safeParse(body);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && key in body) {
          delete body[key];
          if (!strippedFields.includes(key)) strippedFields.push(key);
        }
      }
      result = PartialSchema.safeParse(body);
    }
    if (!result.success) {
      res.status(422).json({ error: "No valid fields in body", details: result.error.issues });
      return;
    }
    if (Object.keys(result.data).length === 0) {
      res.status(422).json({ error: "No valid fields in body", stripped_fields: strippedFields });
      return;
    }

    const ok = updateDentalAgent(id, result.data);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({
      id,
      updated: true,
      // enrichment-metode slice 1: the fields this PUT actually wrote — lets
      // the enrichment routine count agents_enriched truthfully (>=1 field).
      // Intersected with the store's allow-list (review fix): a schema-valid
      // key updateDentalAgent skips (id, available_specialties) is NOT written
      // and must not be counted.
      fields_updated: Object.keys(result.data).filter((k) => DENTAL_AGENT_WRITABLE_FIELDS.includes(k)),
      ...(strippedFields.length ? { stripped_fields: strippedFields } : {}),
      ...(openingHoursDropped ? { opening_hours_dropped: openingHoursDropped } : {}),
    });
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

// ─── PR-104: Multi-worker record-claim endpoints ────────────────────
// Mounted under /api/tannlege/admin/* (tannlege router is mounted at
// /api/tannlege in src/index.ts). So full paths become:
//   POST /api/tannlege/admin/claim-batch
//   POST /api/tannlege/admin/release-batch
//   GET  /api/tannlege/admin/claim-status

// POST /api/tannlege/admin/claim-batch
// Body: { worker_id: string, size: number, filter: {...} }
// Returns: { claimed: ClaimedRecord[], count: number }
router.post("/admin/claim-batch", requireAdmin, (req: Request, res: Response) => {
  try {
    const { claimBatch } = require("../services/dental-claim-service") as typeof import("../services/dental-claim-service");
    const { worker_id, size, filter } = req.body ?? {};
    if (typeof worker_id !== "string" || typeof size !== "number" || typeof filter !== "object") {
      res.status(400).json({ error: "Invalid body: need {worker_id, size, filter}" });
      return;
    }
    const claimed = claimBatch(worker_id, size, filter ?? {});
    res.json({ claimed, count: claimed.length });
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? "Internal error" });
  }
});

// POST /api/tannlege/admin/homepage-fetch-result
// Body: { agentId: string, ok: boolean }
// enrichment-metode slice 1 (2026-07-16): the dental enrichment routine fetches
// clinic homepages itself and REPORTS each outcome here; the server owns the
// strike counting (3 consecutive failures → parked 30d, success → full reset —
// PR #248 semantics). Parked clinics drop out of GET /agents?exclude_parked=1.
router.post("/admin/homepage-fetch-result", requireAdmin, (req: Request, res: Response) => {
  try {
    const { agentId, ok } = (req.body ?? {}) as { agentId?: unknown; ok?: unknown };
    if (typeof agentId !== "string" || !agentId.trim() || typeof ok !== "boolean") {
      res.status(400).json({ error: "Invalid body: need {agentId: string, ok: boolean}" });
      return;
    }
    const r = recordDentalHomepageFetchResult(agentId.trim(), ok);
    if (!r.found) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ agent_id: agentId.trim(), attempts: r.attempts, parked: r.parked, parked_now: r.parked_now });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Internal error" });
  }
});

// POST /api/tannlege/admin/extraction-result
// Body: { agentId: string, ok: boolean, reason?: string }
// dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
// item 2a: mirrors POST /admin/homepage-fetch-result above but for
// extraction/enrichment failures instead of homepage-fetch failures — the
// daily claim-batch worker was repeatedly re-claiming dead records (thin
// directory-listing sites, non-clinic entities) because there was no
// attempts-counter/parking mechanism for extraction failures. The dental
// enrichment routine REPORTS each extraction outcome here; the server owns
// the strike counting (3 consecutive failures → parked 30d, success → full
// reset). Parked clinics drop out of the claim-batch pool via
// dental-claim-service.ts's buildWhereClause() excludeParkedExtraction
// option (opt-in). `reason` is optional and used for observability only
// (logged on failure) — it is not persisted.
router.post("/admin/extraction-result", requireAdmin, (req: Request, res: Response) => {
  try {
    const { agentId, ok, reason } = (req.body ?? {}) as { agentId?: unknown; ok?: unknown; reason?: unknown };
    if (typeof agentId !== "string" || !agentId.trim() || typeof ok !== "boolean") {
      res.status(400).json({ error: "Invalid body: need {agentId: string, ok: boolean}" });
      return;
    }
    const reasonStr = typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
    const r = recordDentalExtractionResult(agentId.trim(), ok, reasonStr);
    if (!r.found) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ agent_id: agentId.trim(), attempts: r.attempts, parked: r.parked, parked_now: r.parked_now });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Internal error" });
  }
});

// POST /api/tannlege/admin/release-batch
// Body: { worker_id: string, ids: string[] }
router.post("/admin/release-batch", requireAdmin, (req: Request, res: Response) => {
  try {
    const { releaseBatch } = require("../services/dental-claim-service") as typeof import("../services/dental-claim-service");
    const { worker_id, ids } = req.body ?? {};
    if (typeof worker_id !== "string" || !Array.isArray(ids)) {
      res.status(400).json({ error: "Invalid body: need {worker_id, ids[]}" });
      return;
    }
    const released = releaseBatch(worker_id, ids);
    res.json({ released });
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? "Internal error" });
  }
});

// GET /api/tannlege/admin/claim-status
router.get("/admin/claim-status", requireAdmin, (_req: Request, res: Response) => {
  try {
    const { claimStatus } = require("../services/dental-claim-service") as typeof import("../services/dental-claim-service");
    res.json({ workers: claimStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Internal error" });
  }
});

// ─── GET /api/tannlege/admin/geocode-status (admin) — PR-103 ────────
// Returns work-queue counts for the backend dental geocoding worker.
//   pending        : rows still to be processed (lat IS NULL AND
//                    geocode_confidence IS NULL AND non-empty address)
//   high/medium/low: rows already geocoded at each confidence level
//   no_match       : rows the ladder gave up on (we don't retry these)
//   total          : all rows in dental_agents (sanity / denominator)
//
// Mount path: /api/tannlege/admin/geocode-status (this router is
// mounted at /api/tannlege/ in src/index.ts). The route belongs here
// (rather than a separate file) so it lives next to the other
// /tannlege admin endpoints (exclusions, bulk-import).
router.get(
  "/admin/geocode-status",
  requireAdmin,
  (_req: Request, res: Response) => {
    try {
      // Lazy require so this file's top doesn't depend on db-factory
      // (it goes via dental-store like the other handlers do today).
      const { getDb } = require("../database/db-factory") as typeof import("../database/db-factory");
      const db = getDb("dental");

      // SQLite supports `COUNT(*) FILTER (WHERE ...)` since 3.30 — well
      // inside our better-sqlite3 12.x dependency. Single query, single
      // table scan, sub-millisecond on 2k rows.
      const counts = db
        .prepare(
          `SELECT
            COUNT(*) FILTER (
              WHERE lat IS NULL
                AND geocode_confidence IS NULL
                AND adresse IS NOT NULL
                AND adresse <> ''
                AND postnummer IS NOT NULL
                AND postnummer <> ''
            ) AS pending,
            COUNT(*) FILTER (WHERE geocode_confidence = 'high')     AS high,
            COUNT(*) FILTER (WHERE geocode_confidence = 'medium')   AS medium,
            COUNT(*) FILTER (WHERE geocode_confidence = 'low')      AS low,
            COUNT(*) FILTER (WHERE geocode_confidence = 'no_match') AS no_match,
            COUNT(*) AS total
          FROM dental_agents`
        )
        .get() as {
          pending: number;
          high: number;
          medium: number;
          low: number;
          no_match: number;
          total: number;
        };
      res.json({ ok: true, ...counts });
    } catch (err) {
      console.error("[tannlege] geocode-status failed", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

// ─── GET /api/tannlege/admin/agents/recently-enriched ────────────────
// Slice 5 of dev-request 2026-07-13-enrichment-metode-maldrevet-evidens:
// mirrors marketplace.ts's GET /admin/agents/recently-enriched for the
// dental vertical — a random sample of recently-enriched clinics for the
// platform-verifier's weekly homepage spot-check. Serves the sample
// only; the spot-check logic (re-fetch + compare + escalate) lives in a
// separate SKILL.
//
// Query params:
//   ?since=<ISO-8601>  — default: 7 days before now (also the fallback
//                        for an unparseable value)
//   ?limit=<int>       — default 10, clamped to [1, 50]
//
// dental_agents has no is_active column (unlike rfb's agents table), so
// there is no activity filter here — just the last_enriched_at window.
//
// Auth: requireAdmin (same X-Admin-Key convention as the rest of this file).
// Returns: 200 { success, count, agents: [{ id, name, website,
//   last_enriched_at, field_provenance }] }
router.get("/admin/agents/recently-enriched", requireAdmin, (req: Request, res: Response) => {
  try {
    const db = getDb("dental");

    const DEFAULT_SINCE_DAYS = 7;
    let since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sinceParam = req.query.since;
    if (typeof sinceParam === "string" && sinceParam.trim()) {
      const parsed = new Date(sinceParam);
      if (!isNaN(parsed.getTime())) {
        since = parsed.toISOString();
      }
    }

    let limit = parseInt((req.query.limit as string) || "10", 10);
    if (!Number.isFinite(limit)) limit = 10;
    limit = Math.min(50, Math.max(1, limit));

    const rows = db
      .prepare(
        `SELECT id, navn, hjemmeside, last_enriched_at, field_provenance
           FROM dental_agents
          WHERE last_enriched_at >= ?
          ORDER BY RANDOM()
          LIMIT ?`
      )
      .all(since, limit) as Array<{
        id: string;
        navn: string;
        hjemmeside: string | null;
        last_enriched_at: string | null;
        field_provenance: string | null;
      }>;

    const agents = rows.map((r) => {
      let fieldProvenance: Record<string, unknown> = {};
      if (r.field_provenance) {
        try {
          const parsed = JSON.parse(r.field_provenance);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            fieldProvenance = parsed;
          }
        } catch { /* malformed → empty */ }
      }
      return {
        id: r.id,
        name: r.navn,
        website: r.hjemmeside,
        last_enriched_at: r.last_enriched_at,
        field_provenance: fieldProvenance,
      };
    });

    res.json({ success: true, count: agents.length, agents });
  } catch (err: any) {
    console.error("[tannlege] agents/recently-enriched failed", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/tannlege/admin/google-places-batch (admin) — PR-128 ──────
//
// Dental Google-Places enrichment batch. THE KEY UNLOCK: backfill missing
// `hjemmeside` (homepage) so thin_site records re-enter the homepage-crawl
// pool, plus opportunistic fill of adresse / telefon / opening_hours.
//
// Mirrors the rfb google-rating-batch Places call pattern
// (places:searchText, X-Goog-Api-Key, X-Goog-FieldMask, body
// {textQuery,languageCode:"no"}) BUT fixes that endpoint's data-quality
// flaw: it blindly took data.places[0] with NO match validation, risking
// pulling a DIFFERENT clinic's data. Here every place must pass
// isConfidentPlaceMatch (name-similarity >= 0.55 AND a postnummer/poststed
// location cross-check) before we write anything.
//
// Write policy: FILL-ONLY. We never overwrite a non-empty column
// (Brreg-wins on adresse/telefon). field_provenance gets a google_places
// (Tier-A) entry for EVERY real value we got — even when the column was
// already populated — so the cross-source-validator can reach
// source_count>=2 (same rationale as the rfb endpoint's provenance merge).
//
// Body (all optional): { agentIds?: string[], limit?: number, write?: boolean }
//   write defaults to true; write=false → dry-run (lookup + decision, no DB write).
//
// Auth: requireAdmin.
const GooglePlacesBatchBodySchema = z.object({
  agentIds: z.array(z.string()).optional(),
  limit: z.number().int().positive().optional(),
  write: z.boolean().optional(),
});

// Local validation schema mirroring the dental-store opening_hours schema
// (kept private to dental-store, so re-declared here for the post-convert
// safety check before we write the column).
const OpeningHoursArraySchema = z.array(
  z.object({
    day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
    open: z.string().regex(/^\d{2}:\d{2}$/),
    close: z.string().regex(/^\d{2}:\d{2}$/),
  })
);

// ─── dev-request 2026-07-03-places-api-cost-reduction, measure 2 ───────────
// SKU field-splitting: Places API (New) Text Search bills the ENTIRE call at
// Enterprise-tier pricing (1,000 free calls/mo) the moment ANY Enterprise-tier
// field (rating, userRatingCount, websiteUri, internationalPhoneNumber)
// appears in the FieldMask — regardless of how many Essentials/Pro fields
// ride along. This endpoint requests websiteUri (→ hjemmeside) and
// internationalPhoneNumber (→ telefon), both Enterprise-tier, on every call —
// including for clinics that already have both columns filled, where a
// fill-only write policy means those two fields are looked up only to be
// thrown away.
//
// Fix: request the Enterprise-tier fields only while a clinic still has an
// empty hjemmeside OR telefon (there is something to gain from them). Once
// both are filled, use a Pro-tier-only mask (formattedAddress,
// regularOpeningHours, businessStatus, addressComponents — no websiteUri, no
// internationalPhoneNumber) for that clinic's request instead. No new column
// needed: fill-only semantics mean "already filled" IS the durable marker,
// unlike the RFB rating-batch (measure 2, RFB slice) where a rating can
// legitimately not exist yet at all.
const PLACES_ENTERPRISE_FIELD_MASK =
  "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.businessStatus,places.addressComponents";
const PLACES_PRO_FIELD_MASK =
  "places.displayName,places.formattedAddress,places.regularOpeningHours,places.businessStatus,places.addressComponents";

interface PlacesAgentRow {
  id: string;
  navn: string;
  postnummer: string | null;
  poststed: string | null;
  adresse: string | null;
  telefon: string | null;
  hjemmeside: string | null;
  opening_hours: string | null;
  field_provenance: string | null;
  enrichment_state: string | null;
}

function isEmptyCol(v: string | null | undefined): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

// ─── dev-request 2026-07-03-places-api-cost-reduction, measure 1 ───────────
// No-retry window for the auto-select pool: a record that already got a real
// Places lookup (matched OR confidently no-matched) is excluded from
// auto-select for this many days. A transport failure (api_error) never sets
// the marker, so it stays eligible next cycle — only a genuine Google answer
// starves the retry clock.
const PLACES_NO_RETRY_DAYS = 90;

router.post(
  "/admin/google-places-batch",
  requireAdmin,
  async (req: Request, res: Response) => {
    const placesKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!placesKey) {
      res
        .status(503)
        .json({ success: false, error: "GOOGLE_PLACES_API_KEY not configured" });
      return;
    }

    let body: z.infer<typeof GooglePlacesBatchBodySchema>;
    try {
      body = GooglePlacesBatchBodySchema.parse(req.body ?? {});
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid body", details: err.issues });
        return;
      }
      throw err;
    }

    const write = body.write !== false; // default true
    // dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
    // item 1: raise the homepage-backfill default/cap 20/50 -> 100/cycle (the
    // universe-growth lever — at 20/day a full sweep of the ~5,670 homepage-
    // less records takes 283 days, at 100/day ~2 months). Paired with the
    // monthly Enterprise-tier hard-stop below so the higher ceiling can never
    // push the platform over the shared 1,000-call/mo free cap.
    const HARD_CAP = 100;
    const limit = Math.max(
      1,
      Math.min(HARD_CAP, body.limit ?? 100)
    );

    const db = getDb("dental");

    // ── Monthly Enterprise-tier hard-stop (safety pair for the raised limit
    // above) — this dev-request's own acceptance requirement: cap Places
    // spend so a bigger per-cycle limit can't push the account over the
    // free tier. Mirrors marketplace.ts's /admin/places-usage combined
    // rfb+dental count; leaves a buffer below the 1,000 free cap for rfb's
    // own same-day usage.
    //
    // Fail-CLOSED on a read failure (unlike places-usage-tracker.ts's own
    // internal reads, which are best-effort/observability-only and fail
    // toward 0 by design): this read now GATES real spend, so a DB-open or
    // query failure here must not silently look like "0 calls made this
    // month" — that would let a full HARD_CAP-sized run of Enterprise calls
    // through on exactly the failure path a cost hard-stop should be most
    // defensive about (independent-review finding, PR #272). Treat an
    // unreadable count as already at the hard stop instead.
    const ENTERPRISE_MONTHLY_HARD_STOP = 950;
    let enterpriseCallsThisMonth = ENTERPRISE_MONTHLY_HARD_STOP;
    try {
      const usage = [
        ...getPlacesUsageThisMonth(getDb("rfb"), "rfb"),
        ...getPlacesUsageThisMonth(db, "dental"),
      ];
      enterpriseCallsThisMonth = usage
        .filter((r) => r.sku === "text_search_enterprise")
        .reduce((sum, r) => sum + r.calls_this_month, 0);
    } catch {
      // read failed — enterpriseCallsThisMonth stays at ENTERPRISE_MONTHLY_HARD_STOP
      // (fail closed: this run makes zero Enterprise-tier calls, Pro-tier only)
    }
    let enterpriseCapped = false;

    // Marks a row as having had a real Places attempt (matched or a
    // confident no-match) — starts its 90-day no-retry window. Callers MUST
    // NOT call this for a transport failure (api_error): only a genuine
    // Google answer should starve the retry clock, per the dev-request's
    // safety note.
    function markPlacesAttempt(id: string, status: "matched" | "no_match"): void {
      if (!write) return; // dry-run: decision-only, no DB write
      db.prepare(
        `UPDATE dental_agents SET places_attempted_at = ?, places_match_status = ? WHERE id = ?`
      ).run(new Date().toISOString(), status, id);
    }

    // ── Selection ──────────────────────────────────────────────────────
    let rows: PlacesAgentRow[];
    if (Array.isArray(body.agentIds) && body.agentIds.length > 0) {
      const ids = body.agentIds.slice(0, limit);
      const placeholders = ids.map(() => "?").join(",");
      rows = db
        .prepare(
          `SELECT id, navn, postnummer, poststed, adresse, telefon, hjemmeside,
                  opening_hours, field_provenance, enrichment_state
             FROM dental_agents
            WHERE id IN (${placeholders})`
        )
        .all(...ids) as PlacesAgentRow[];
    } else {
      // Auto-select rows that NEED Places help. Priority: missing homepage
      // first (the key unlock), then missing addr/phone/opening_hours.
      // Restricted to the enrichment states that can still benefit and
      // never rejected.
      rows = db
        .prepare(
          `SELECT id, navn, postnummer, poststed, adresse, telefon, hjemmeside,
                  opening_hours, field_provenance, enrichment_state
             FROM dental_agents
            WHERE enrichment_state IN ('raw','thin_site','enriched')
              AND verification_status != 'rejected'
              AND (
                    hjemmeside IS NULL OR hjemmeside = ''
                 OR adresse    IS NULL OR adresse    = ''
                 OR telefon    IS NULL OR telefon    = ''
                 OR opening_hours IS NULL OR opening_hours = ''
              )
              AND (
                    places_attempted_at IS NULL
                 OR places_attempted_at < datetime('now', '-${PLACES_NO_RETRY_DAYS} days')
              )
            ORDER BY
              CASE WHEN hjemmeside IS NULL OR hjemmeside = '' THEN 0 ELSE 1 END ASC,
              CASE WHEN (adresse IS NULL OR adresse = '')
                     OR (telefon IS NULL OR telefon = '')
                     OR (opening_hours IS NULL OR opening_hours = '') THEN 0 ELSE 1 END ASC,
              navn ASC
            LIMIT ?`
        )
        .all(limit) as PlacesAgentRow[];
    }

    // Pool-empty short-circuit (auto-select mode only): every eligible record
    // has already had a real Places attempt within the no-retry window — skip
    // the Google call entirely rather than re-querying nothing-new.
    if (rows.length === 0) {
      res.json({
        success: true,
        data: {
          processed: 0,
          matched: 0,
          no_match: 0,
          homepages_backfilled: 0,
          by_field: { hjemmeside: 0, adresse: 0, telefon: 0, opening_hours: 0 },
          write,
          results: [],
          pool_empty: true,
          places_api_calls: 0,
          enterprise_calls: 0,
          pro_calls: 0,
          places_calls: 0,
          enterprise_calls_this_month_before_run: enterpriseCallsThisMonth,
          enterprise_monthly_hard_stop: ENTERPRISE_MONTHLY_HARD_STOP,
          enterprise_capped: false,
        },
      });
      return;
    }

    const results: Array<{
      agentId: string;
      navn: string;
      status: "matched" | "no_confident_match" | "no_place" | "api_error";
      nameSim: number;
      fields_written: string[];
      homepage_backfilled: boolean;
      place?: string;
    }> = [];

    let processed = 0;
    let matched = 0;
    let no_match = 0;
    let homepages_backfilled = 0;
    let placesCallsThisRun = 0;
    const by_field = { hjemmeside: 0, adresse: 0, telefon: 0, opening_hours: 0 };
    let enterpriseCalls = 0; // calls made with the Enterprise-tier mask
    let proCalls = 0;        // calls made with the Essentials/Pro-only mask

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      processed++;

      // Rate-limit politely between Places calls (~150ms), not before first.
      if (i > 0) await new Promise((r) => setTimeout(r, 150));

      const query = `${row.navn} ${row.poststed ?? ""} Norway`
        .replace(/\s*[—–-]\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Measure 2: only pay for Enterprise-tier fields while there's a
      // fill-only gain to be had from them (hjemmeside/telefon still empty).
      // Item 1 (this dev-request): gate that want on the monthly hard-stop
      // budget too — a row that wants Enterprise fields but the platform
      // has hit ENTERPRISE_MONTHLY_HARD_STOP this month still gets looked
      // up, just with the cheaper Pro-tier mask (see shouldUseEnterpriseFieldMask).
      const wantsEnterprise = isEmptyCol(row.hjemmeside) || isEmptyCol(row.telefon);
      const needsEnterprise = shouldUseEnterpriseFieldMask(
        wantsEnterprise,
        enterpriseCallsThisMonth + enterpriseCalls,
        ENTERPRISE_MONTHLY_HARD_STOP
      );
      if (wantsEnterprise && !needsEnterprise) enterpriseCapped = true;
      const fieldMask = needsEnterprise
        ? PLACES_ENTERPRISE_FIELD_MASK
        : PLACES_PRO_FIELD_MASK;
      if (needsEnterprise) enterpriseCalls++; else proCalls++;

      // ── measure 3 of dev-request 2026-07-03-places-api-cost-reduction ──
      // BRREG-first: consult the free Brreg registry for this clinic's
      // address BEFORE relying on Google's (paid) answer, extending the
      // existing Brreg-wins fill-only policy below into an actual "ask
      // Brreg first" ordering. Only attempted when adresse is still empty
      // — a column that's already filled stays fill-only regardless of
      // source, unchanged from before. Phone is NOT looked up here: Brreg's
      // Enhetsregisteret API has no phone-number field, so telefon stays
      // Google-only exactly as before.
      let brregAddr: string | null = null;
      if (isEmptyCol(row.adresse)) {
        try {
          const brregHit = await findOrgnumberByName(row.navn, row.postnummer);
          if (brregHit?.address) brregAddr = brregHit.address;
        } catch {
          // Brreg lookup failure is non-fatal — fall through to Google's answer.
        }
      }

      let place: PlacesPlace | undefined;
      try {
        placesCallsThisRun++;
        // measure 2 (dental slice, lokal#130): log the SKU tier actually
        // requested, not always "enterprise" — needsEnterprise/fieldMask
        // above already decide which mask this specific call uses.
        logPlacesCall(
          db,
          "dental",
          "google-places-batch",
          needsEnterprise ? "text_search_enterprise" : "text_search_pro"
        );
        const resp = await fetch(
          "https://places.googleapis.com/v1/places:searchText",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": placesKey,
              "X-Goog-FieldMask": fieldMask,
            },
            body: JSON.stringify({ textQuery: query, languageCode: "no" }),
          }
        );
        if (!resp.ok) {
          results.push({
            agentId: row.id,
            navn: row.navn,
            status: "api_error",
            nameSim: 0,
            fields_written: [],
            homepage_backfilled: false,
          });
          continue;
        }
        const data = (await resp.json()) as { places?: PlacesPlace[] };
        place = (data.places || [])[0];
      } catch {
        results.push({
          agentId: row.id,
          navn: row.navn,
          status: "api_error",
          nameSim: 0,
          fields_written: [],
          homepage_backfilled: false,
        });
        continue;
      }

      if (!place) {
        markPlacesAttempt(row.id, "no_match");
        results.push({
          agentId: row.id,
          navn: row.navn,
          status: "no_place",
          nameSim: 0,
          fields_written: [],
          homepage_backfilled: false,
        });
        continue;
      }

      const nameSim = nameSimilarity(row.navn, place.displayName?.text ?? "");

      // ── MATCH VALIDATION (mandatory data-quality guard) ──────────────
      const confident = isConfidentPlaceMatch(
        { navn: row.navn, postnummer: row.postnummer, poststed: row.poststed },
        place
      );
      if (!confident) {
        no_match++;
        markPlacesAttempt(row.id, "no_match");
        results.push({
          agentId: row.id,
          navn: row.navn,
          status: "no_confident_match",
          nameSim,
          fields_written: [],
          homepage_backfilled: false,
          place: place.displayName?.text,
        });
        continue;
      }

      // ── Confident match — compute FILL-ONLY column writes ────────────
      matched++;
      markPlacesAttempt(row.id, "matched");
      const nowIso = new Date().toISOString();
      const patch: Record<string, unknown> = {};
      const fields_written: string[] = [];
      let homepage_backfilled = false;

      // Real values from Places (for provenance, regardless of column write).
      // measure 3: prefer the BRREG address looked up above when we have
      // one — Google's formattedAddress is only used as the fallback when
      // BRREG had nothing usable for this clinic.
      const placesAddr =
        typeof place.formattedAddress === "string"
          ? place.formattedAddress.trim()
          : "";
      const gAddr = brregAddr || placesAddr;
      const gAddrSource: "brreg" | "google_places" = brregAddr ? "brreg" : "google_places";
      const gPhone = normalizePlacePhone(place.internationalPhoneNumber);
      const gWebsite =
        typeof place.websiteUri === "string" ? place.websiteUri.trim() : "";
      const gWebsiteValid = isValidHttpUrl(gWebsite);
      const ohConverted = placesPeriodsToOpeningHours(
        place.regularOpeningHours?.periods
      );
      let ohValid = false;
      if (ohConverted.length > 0) {
        ohValid = OpeningHoursArraySchema.safeParse(ohConverted).success;
      }

      // hjemmeside — fill only, and re-pool thin_site on backfill.
      if (isEmptyCol(row.hjemmeside) && gWebsiteValid) {
        patch.hjemmeside = gWebsite;
        fields_written.push("hjemmeside");
        by_field.hjemmeside++;
        homepage_backfilled = true;
        homepages_backfilled++;
        if ((row.enrichment_state ?? "") === "thin_site") {
          patch.enrichment_state = "raw";
        }
      }

      // adresse — fill only (Brreg-wins). gAddr is BRREG's address when the
      // measure-3 lookup above found one, else Google's formattedAddress.
      if (isEmptyCol(row.adresse) && gAddr) {
        patch.adresse = gAddr;
        fields_written.push("adresse");
        by_field.adresse++;
      }

      // telefon — fill only (Brreg-wins), normalized.
      if (isEmptyCol(row.telefon) && gPhone) {
        patch.telefon = gPhone;
        fields_written.push("telefon");
        by_field.telefon++;
      }

      // opening_hours — fill only, must pass our schema.
      if (isEmptyCol(row.opening_hours) && ohValid) {
        patch.opening_hours = ohConverted;
        fields_written.push("opening_hours");
        by_field.opening_hours++;
      }

      // ── field_provenance — google_places (Tier-A) for every real value ──
      // (address provenance uses gAddrSource — "brreg" when measure 3's
      // BRREG-first lookup supplied the value, "google_places" otherwise.)
      const incomingProv: Record<
        string,
        { sources: Array<{ source_type: string; value: string; fetched_at: string }> }
      > = {};
      if (gAddr) {
        incomingProv.address = {
          sources: [{ source_type: gAddrSource, value: gAddr, fetched_at: nowIso }],
        };
      }
      if (gPhone) {
        incomingProv.phone = {
          sources: [{ source_type: "google_places", value: gPhone, fetched_at: nowIso }],
        };
      }
      if (gWebsiteValid) {
        incomingProv.website = {
          sources: [{ source_type: "google_places", value: gWebsite, fetched_at: nowIso }],
        };
      }
      if (ohValid) {
        incomingProv.opening_hours = {
          sources: [
            {
              source_type: "google_places",
              value: JSON.stringify(ohConverted),
              fetched_at: nowIso,
            },
          ],
        };
      }

      if (Object.keys(incomingProv).length > 0) {
        let existingProv: Record<string, unknown> = {};
        if (row.field_provenance) {
          try {
            const parsed = JSON.parse(row.field_provenance);
            if (parsed && typeof parsed === "object") {
              existingProv = parsed as Record<string, unknown>;
            }
          } catch {
            /* tolerate junk */
          }
        }
        patch.field_provenance = mergeFieldProvenance(existingProv, incomingProv);
      }

      // ── Apply (single updateDentalAgent call) unless dry-run ─────────
      if (write && Object.keys(patch).length > 0) {
        updateDentalAgent(row.id, patch as any);
      }

      results.push({
        agentId: row.id,
        navn: row.navn,
        status: "matched",
        nameSim,
        fields_written,
        homepage_backfilled,
        place: place.displayName?.text,
      });
    }

    res.json({
      success: true,
      data: {
        processed,
        matched,
        no_match,
        homepages_backfilled,
        by_field,
        write,
        results,
        places_api_calls: enterpriseCalls + proCalls,
        enterprise_calls: enterpriseCalls,
        pro_calls: proCalls,
        places_calls: placesCallsThisRun,
        enterprise_calls_this_month_before_run: enterpriseCallsThisMonth,
        enterprise_monthly_hard_stop: ENTERPRISE_MONTHLY_HARD_STOP,
        enterprise_capped: enterpriseCapped,
      },
    });
  }
);

export default router;
