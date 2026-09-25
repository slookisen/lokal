// ─── Admin: POST /admin/field-spot-check ─────────────────────────────────────
//
// dev-request 2026-09-22-telefon-css-js-identifikator-falske-positiver,
// point 2 fix-up (B3, adversarial-review CHANGES-REQUESTED finding).
// computeFieldSpotCheck() / fieldSpotCheckSubpageCandidates() (src/agents/
// lokal-agent-verifier.ts) fix the weekly field-verification spot-check's
// FETCH/MEASUREMENT method (follow up to 3 same-domain subpages before
// declaring a field "mismatch" — see that module's own header comment for
// the Vollan Gård repro this closes) — but shipped with NO production
// caller. GET /admin/agents/recently-enriched (routes/marketplace.ts) only
// ever serves the SAMPLE of recently-enriched agents; its own comment says
// the actual spot-check logic (fetch + compare + escalate) "lives in a
// separate SKILL, not here" — i.e. an external operational agent/skill is
// expected to call an HTTP endpoint to do the fetch+compare work, not an
// in-process function nothing calls. This route IS that endpoint: a thin
// HTTP wrapper so the SKILL actually has something to call.
//
// ── Parameter shape ───────────────────────────────────────────────────────
// { agent_id, field_name } — mirrors GET /admin/agents/recently-enriched's
// own output shape (that route returns field_provenance keyed by field
// name, e.g. "phone"/"about"/"address" — see cross-source-validator.ts's
// FieldName type and computeFieldSpotCheck's own Vollan Gård "about" repro).
// The CURRENT stored value for `field_name` and the agent's homepage
// (COALESCE(agent_knowledge.website, agents.url) — the SAME `homepage_url`
// concept every other call site in this codebase computes) are resolved
// server-side from agent_knowledge, so the SKILL never has to know this
// codebase's DB schema — it just names the agent and the field.
//
// FIELD_COLUMN_MAP is a deliberate WHITELIST (not an arbitrary
// `agent_knowledge[field_name]` lookup) — field_name comes straight from an
// external caller's request body, and an unvalidated column name plugged
// into SQL (even parameterized-query-adjacent code like this) is exactly
// the kind of thing that must never be trusted verbatim.
//
// Requires X-Admin-Key header (same requireAdmin pattern as every other
// admin route in this codebase, including this dev-request's own sibling
// admin-phone-context-gate-retro-scan.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { computeFieldSpotCheck } from "../agents/lokal-agent-verifier";
import { checkAboutCandidateFactSubstantiated } from "../services/about-fact-substantiation";

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

/** Whitelisted spot-checkable fields -> their agent_knowledge column. Only
 *  fields this codebase actually tracks per-field provenance for (see
 *  cross-source-validator.ts's FieldName union plus "about", the field
 *  computeFieldSpotCheck's own Vollan Gård repro exercises) are exposed —
 *  never an arbitrary caller-supplied column name. */
const FIELD_COLUMN_MAP: Readonly<Record<string, string>> = Object.freeze({
  phone: "phone",
  address: "address",
  about: "about",
});

interface AgentRow {
  url: string | null;
  name: string;
}

interface KnowledgeRow {
  website: string | null;
  phone: string | null;
  address: string | null;
  about: string | null;
}

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const body = (req.body ?? {}) as { agent_id?: unknown; field_name?: unknown };
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const fieldName = typeof body.field_name === "string" ? body.field_name.trim() : "";

  if (!agentId) {
    res.status(400).json({ success: false, error: "agent_id (string) is required" });
    return;
  }
  if (!fieldName) {
    res.status(400).json({ success: false, error: "field_name (string) is required" });
    return;
  }
  // hasOwnProperty.call (not a plain `FIELD_COLUMN_MAP[fieldName]` index)
  // so an inherited Object.prototype property name ("constructor",
  // "toString", "hasOwnProperty", "__proto__") can never pass this
  // whitelist check via prototype-chain lookup.
  const column = Object.prototype.hasOwnProperty.call(FIELD_COLUMN_MAP, fieldName)
    ? FIELD_COLUMN_MAP[fieldName]
    : undefined;
  if (!column) {
    res.status(400).json({
      success: false,
      error: `unsupported field_name "${fieldName}" — supported: ${Object.keys(FIELD_COLUMN_MAP).join(", ")}`,
    });
    return;
  }

  try {
    const db = getDb();

    const agent = db.prepare(`SELECT url AS url, name AS name FROM agents WHERE id = ?`).get(agentId) as
      | AgentRow
      | undefined;
    if (!agent) {
      res.status(404).json({ success: false, error: `agent not found: ${agentId}` });
      return;
    }

    const knowledge = db
      .prepare(`SELECT website AS website, phone AS phone, address AS address, about AS about FROM agent_knowledge WHERE agent_id = ?`)
      .get(agentId) as KnowledgeRow | undefined;

    const rootUrl = (knowledge?.website && knowledge.website.trim()) || (agent.url && agent.url.trim()) || null;
    if (!rootUrl) {
      res.status(400).json({
        success: false,
        error: "no homepage_url on file for this agent (agent_knowledge.website and agents.url both blank) — cannot spot-check",
      });
      return;
    }

    const fieldValue = (knowledge as any)?.[column] ?? null;

    // dev-request 2026-09-24-stikkproeve-undersider-og-faktanivaa-about
    // (Del B): `about` alone gets the fact-level substantiation check
    // (about-fact-substantiation.ts) — tolerant of dialectal/paraphrase
    // rewording as long as the candidate's own distinct facts (place names,
    // founder names, years) are genuinely, locally corroborated on the
    // fetched page(s). `phone`/`address` are UNCHANGED: no deps override,
    // same default (checkAboutCandidateSubstantiatedBySource) as before —
    // this fix's own scope is `about` only, per the dev-request.
    const result =
      fieldName === "about"
        ? await computeFieldSpotCheck(
            { field_value: fieldValue, root_url: rootUrl },
            { substantiate: checkAboutCandidateFactSubstantiated },
          )
        : await computeFieldSpotCheck({ field_value: fieldValue, root_url: rootUrl });

    res.json({
      success: true,
      agent_id: agentId,
      field_name: fieldName,
      field_value: fieldValue,
      root_url: rootUrl,
      status: result.status,
      checked_url: result.checked_url,
      urls_tried: result.urls_tried,
      reason: result.reason,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
