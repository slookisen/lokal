// ─── Admin Affiliations endpoint — PR-58 (2026-05-16) ────────────────
//
// POST /admin/affiliations/auto-create
// Specifically for the lokal-agent-enrichment SKILL when its
// organic-keyword detector (src/services/organic-keyword-detector.ts)
// finds Debio / økologisk certification keywords on a producer's
// homepage. Inserts a row in agent_affiliations with:
//   - status = 'pending_confirmation'
//   - source = 'inferred'  (NEW source value introduced in PR-58)
//   - evidence_json = JSON of detector output
//
// The producer can later accept (via owner-portal) or reject
// (via /opt-out). UI shows "antatt sertifisert via Debio (ikke
// bekreftet)" until accepted.
//
// Why a separate endpoint (not POST /admin/affiliations from PR-46):
//   - The existing /admin/affiliations endpoint accepts only the four
//     "human-curated" source values: self_claimed, scraped, admin,
//     umbrella_confirmed. Each of those carries an implicit trust
//     contract (a person reviewed the link). 'inferred' is different:
//     no human has reviewed the match, the link is a guess from
//     keyword scraping. Routing it through a dedicated endpoint
//     prevents accidental status='active' inserts and makes the
//     pending_confirmation default load-bearing in the contract.
//   - Idempotent: if a row already exists for (producer, umbrella),
//     return 200 with current row (no overwrite). This lets the SKILL
//     re-run safely on every crawl without churning rows.
//
// Auth: X-Admin-Key (same pattern as admin-knowledge.ts).
//
// Reference:
//   - src/services/organic-keyword-detector.ts — pure-function detector
//   - src/routes/marketplace.ts (POST /admin/affiliations) — the
//     human-curated path (PR-46), unchanged by this PR.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { interactionLogger } from "../services/interaction-logger";

const router = Router();

// ─── Auth helper (mirrors admin-knowledge.ts pattern) ────────────────
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

// ─── Body shape (manual validation — zod isn't used elsewhere here) ──
type EvidenceShape = {
  matched_keywords: string[];
  evidence_snippets: string[];
  confidence: "low" | "medium" | "high";
  source_url: string;
};

type AutoCreateBody = {
  agent_id?: string;     // producer agent id (called producer_id in DB)
  umbrella_id?: string;
  source_type?: string;  // must be 'inferred'
  evidence?: Partial<EvidenceShape>;
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === "string");
}

function validateEvidence(e: unknown): EvidenceShape | string {
  if (!e || typeof e !== "object") return "evidence object required";
  const ev = e as Partial<EvidenceShape>;
  if (!isStringArray(ev.matched_keywords) || ev.matched_keywords.length === 0) {
    return "evidence.matched_keywords must be a non-empty string array";
  }
  if (!isStringArray(ev.evidence_snippets)) {
    return "evidence.evidence_snippets must be a string array";
  }
  if (ev.confidence !== "low" && ev.confidence !== "medium" && ev.confidence !== "high") {
    return "evidence.confidence must be 'low', 'medium', or 'high'";
  }
  if (typeof ev.source_url !== "string" || ev.source_url.trim().length === 0) {
    return "evidence.source_url required (string)";
  }
  return {
    matched_keywords: ev.matched_keywords,
    evidence_snippets: ev.evidence_snippets,
    confidence: ev.confidence,
    source_url: ev.source_url,
  };
}

// ─── POST /admin/affiliations/auto-create ────────────────────────────
router.post("/auto-create", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const body = (req.body ?? {}) as AutoCreateBody;
    const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    const umbrellaId = typeof body.umbrella_id === "string" ? body.umbrella_id.trim() : "";
    const sourceType = typeof body.source_type === "string" ? body.source_type.trim() : "";

    if (!agentId) {
      res.status(400).json({ error: "agent_id required" });
      return;
    }
    if (!umbrellaId) {
      res.status(400).json({ error: "umbrella_id required" });
      return;
    }
    // Hard-reject anything other than 'inferred' — the human-curated
    // path is /admin/affiliations (marketplace.ts).
    if (sourceType !== "inferred") {
      res.status(400).json({
        error: "source_type must be 'inferred' on this endpoint. Use POST /admin/affiliations for human-curated sources.",
      });
      return;
    }

    const evidenceOrErr = validateEvidence(body.evidence);
    if (typeof evidenceOrErr === "string") {
      res.status(400).json({ error: evidenceOrErr });
      return;
    }
    const evidence = evidenceOrErr;

    const db = getDb();

    // Verify producer agent exists, is a producer (not an umbrella).
    const producer = db.prepare(
      "SELECT id, role, umbrella_type FROM agents WHERE id = ?"
    ).get(agentId) as { id: string; role: string; umbrella_type: string | null } | undefined;
    if (!producer) {
      res.status(404).json({ error: `agent_id ${agentId} not found` });
      return;
    }
    if (producer.umbrella_type) {
      res.status(404).json({ error: `agent_id ${agentId} is an umbrella, not a producer` });
      return;
    }
    if (producer.role && producer.role !== "producer") {
      // Defensive: tolerate role=null (legacy rows) but reject explicit non-producer.
      res.status(404).json({ error: `agent_id ${agentId} role is '${producer.role}', expected 'producer'` });
      return;
    }

    // Verify umbrella exists and IS an umbrella.
    const umbrella = db.prepare(
      "SELECT id, umbrella_type FROM agents WHERE id = ?"
    ).get(umbrellaId) as { id: string; umbrella_type: string | null } | undefined;
    if (!umbrella) {
      res.status(404).json({ error: `umbrella_id ${umbrellaId} not found` });
      return;
    }
    if (!umbrella.umbrella_type) {
      res.status(404).json({ error: `umbrella_id ${umbrellaId} is not an umbrella agent` });
      return;
    }

    // Idempotency: if a row already exists for (producer, umbrella),
    // return 200 with the current row. Do NOT overwrite — the producer
    // may have already accepted/rejected and we don't want to revert.
    const existing = db.prepare(
      "SELECT id, status FROM agent_affiliations WHERE producer_id = ? AND umbrella_id = ?"
    ).get(agentId, umbrellaId) as { id: number; status: string } | undefined;

    if (existing) {
      res.status(200).json({
        status: "already_exists",
        affiliation_id: String(existing.id),
        current_status: existing.status,
      });
      return;
    }

    // Insert new pending_confirmation row.
    const now = new Date().toISOString();
    const evidenceJson = JSON.stringify(evidence);
    const result = db.prepare(`
      INSERT INTO agent_affiliations
        (producer_id, umbrella_id, status, source, evidence_json, created_at, updated_at)
      VALUES (?, ?, 'pending_confirmation', 'inferred', ?, ?, ?)
    `).run(agentId, umbrellaId, evidenceJson, now, now);

    const affiliationId = String(result.lastInsertRowid);

    // Audit-log so the orchestrator can trace which crawl produced this.
    try {
      interactionLogger.log("affiliation_auto_created", {
        agentId: agentId,
        metadata: {
          affiliation_id: affiliationId,
          producer_id: agentId,
          umbrella_id: umbrellaId,
          confidence: evidence.confidence,
          source_url: evidence.source_url,
          matched_keywords: evidence.matched_keywords,
        },
        ipAddress: req.ip,
      });
    } catch (logErr) {
      // Audit logging is best-effort — don't fail the request on logger errors.
      console.warn("[admin/affiliations/auto-create] audit log failed:", logErr);
    }

    res.status(201).json({
      status: "created",
      affiliation_id: affiliationId,
      agent_id: agentId,
      umbrella_id: umbrellaId,
      pending_confirmation_at: now,
    });
  } catch (err: any) {
    console.error("[admin/affiliations/auto-create] Error:", err);
    res.status(500).json({ error: err?.message || "Intern feil" });
  }
});

export default router;
