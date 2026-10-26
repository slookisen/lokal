// ─── Admin: read-only preview of the RFB second-line judge WITH evidence ────
//
// dev-request 2026-10-23-rfb-flere-forstehenvendelser-dommer-bevis-og-
// kontaktuttrekk (skive 1, "port A"). POST /admin/second-line-judge-preview
// with body {agentIds: string[]} (1..25). For each id it loads the SAME
// inputs runVerifierBatch uses for the second line (pickByIds row, headProbe
// → computeKvalitetsGate, resolveBrregLookup, field_provenance, affiliated
// umbrella domains), then runs computeSecondLineVerification WITH the
// own-website evidence (buildSecondLineEvidence) — regardless of
// RFB_SECOND_LINE_EVIDENCE_ENABLED — so Daniel can compare the shadow verdict
// with the stored one before the flag is ever turned on.
//
// WRITES NOTHING: no status change, no verification_review_reason, no audit
// row, no provenance, no parking change. Only SELECTs run against the DB;
// network reads are the homepage probe/fetch, Brreg lookup and the judge.
//
// Admin-key gated — same requireAdmin/getAdminKey idiom as
// admin-run-verifier.ts (mounted next to it in index.ts).

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import {
  pickByIds,
  headProbe,
  resolveBrregLookup,
  computeKvalitetsGate,
  computeSecondLineVerification,
  buildSecondLineEvidence,
  getAffiliatedUmbrellaDomains,
  parseProducts,
  type SecondLineEvidenceItem,
} from "../agents/lokal-agent-verifier";

const router = Router();

export const SECOND_LINE_PREVIEW_MAX_IDS = 25;
const EXCERPT_SHOWN_CHAR_CAP = 500;

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

export interface SecondLinePreviewDeps {
  db?: any;
  headProbe?: (url: string, timeoutMs?: number) => Promise<number | null>;
  brregLookup?: typeof resolveBrregLookup | null;
  judgeFn?: Parameters<typeof computeSecondLineVerification>[0]["judgeFn"];
  evidenceFetch?: typeof fetch;
}

// Test seam ONLY (same role as runVerifierBatch's injected opts) — lets the
// route test run with no real network / LLM. Production never sets it.
let testDeps: SecondLinePreviewDeps | null = null;
export function __setSecondLinePreviewDepsForTesting(deps: SecondLinePreviewDeps | null): void {
  testDeps = deps;
}

export interface SecondLinePreviewRow {
  agent_id: string;
  error?: "not_found";
  name?: string | null;
  verification_status?: string | null;
  stored_second_line_passes?: boolean | null;
  stored_second_line_reason?: string | null;
  stored_verified_second_line?: boolean | null;
  first_line_passes?: boolean;
  shadow_passes?: boolean;
  shadow_reasons?: Record<string, boolean>;
  shadow_sources?: string[];
  shadow_judge_reason?: string | null;
  source_url?: string | null;
  excerpt_shown?: string | null;
  evidence_sent?: boolean;
  skipped_reason?: string | null;
}

// Last persisted second-line result: runVerifierBatch stores it as
// verification_review_reason.second_line ({attempted, passes, reasons,
// sources, judge_reason}) via applyVerifierOutcome, plus the permanent
// verified_second_line marker column. SELECT only.
function readStoredSecondLine(db: any, agentId: string): {
  passes: boolean | null;
  reason: string | null;
  verified_second_line: boolean | null;
} {
  try {
    const row = db
      .prepare(`SELECT verification_review_reason, verified_second_line FROM agent_knowledge WHERE agent_id = ?`)
      .get(agentId) as { verification_review_reason: string | null; verified_second_line: number | null } | undefined;
    if (!row) return { passes: null, reason: null, verified_second_line: null };
    let sl: any = null;
    try {
      sl = JSON.parse(row.verification_review_reason || "{}")?.second_line ?? null;
    } catch {
      sl = null;
    }
    return {
      passes: sl && typeof sl.passes === "boolean" ? sl.passes : null,
      reason: sl && typeof sl.judge_reason === "string" ? sl.judge_reason : null,
      verified_second_line: row.verified_second_line == null ? null : row.verified_second_line === 1,
    };
  } catch {
    return { passes: null, reason: null, verified_second_line: null };
  }
}

function skippedReasonOf(reasons: Record<string, boolean>): string | null {
  const order = ["nace_brreg_ok", "email_present", "email_not_junk", "email_not_paraply", "has_accepted_source"];
  const failed = order.filter((k) => !reasons[k]);
  return failed.length > 0 ? `deterministic_check_failed: ${failed.join(", ")}` : null;
}

export async function previewSecondLineJudge(
  agentIds: string[],
  deps: SecondLinePreviewDeps = {},
): Promise<SecondLinePreviewRow[]> {
  const db = deps.db ?? getDb();
  const probe = deps.headProbe ?? headProbe;
  const brregLookup = deps.brregLookup === undefined ? resolveBrregLookup : deps.brregLookup;
  const rowsById = new Map<string, any>();
  for (const r of pickByIds(db, agentIds)) rowsById.set(r.id, r);

  const out: SecondLinePreviewRow[] = [];
  for (const id of agentIds) {
    const agent = rowsById.get(id);
    if (!agent) {
      out.push({ agent_id: id, error: "not_found" });
      continue;
    }
    const httpStatus = agent.website ? await probe(agent.website) : null;
    const brreg = brregLookup
      ? await brregLookup(agent.name, agent.location_city || null).catch(() => null)
      : null;
    const products = parseProducts(agent.products);
    const gate = computeKvalitetsGate({
      http_status: httpStatus,
      email: agent.email,
      website: agent.website,
      about: agent.about,
      products,
      brreg,
      field_provenance: agent.field_provenance,
    });
    let fieldProv: Record<string, unknown> = {};
    try {
      fieldProv = typeof agent.field_provenance === "string"
        ? JSON.parse(agent.field_provenance)
        : (agent.field_provenance ?? {});
    } catch {
      fieldProv = {};
    }

    let evidenceUsed: readonly SecondLineEvidenceItem[] = [];
    const secondLine = await computeSecondLineVerification({
      producer_name: agent.name ?? null,
      city: agent.location_city ?? null,
      about: agent.about,
      products,
      email: agent.email,
      field_provenance: fieldProv,
      brreg,
      gate_reasons: {
        website_ok: gate.reasons.website_ok,
        no_wrong_fit: gate.reasons.no_wrong_fit,
        brreg_active: gate.reasons.brreg_active,
      },
      affiliated_umbrella_domains: getAffiliatedUmbrellaDomains(db, agent.id),
      judgeFn: deps.judgeFn,
      evidenceFn: async (sources) => {
        evidenceUsed = await buildSecondLineEvidence(
          { sources, website: agent.website ?? null },
          { fetchImpl: deps.evidenceFetch },
        );
        return evidenceUsed;
      },
    });

    const stored = readStoredSecondLine(db, agent.id);
    const first = evidenceUsed[0];
    const reasons = secondLine.reasons as unknown as Record<string, boolean>;
    out.push({
      agent_id: agent.id,
      name: agent.name ?? null,
      verification_status: agent.verification_status ?? null,
      stored_second_line_passes: stored.passes,
      stored_second_line_reason: stored.reason,
      stored_verified_second_line: stored.verified_second_line,
      first_line_passes: gate.passes,
      shadow_passes: secondLine.passes,
      shadow_reasons: reasons,
      shadow_sources: secondLine.sources,
      shadow_judge_reason: secondLine.judge_reason ?? null,
      source_url: first ? first.source_url : null,
      excerpt_shown: first ? first.content_excerpt.slice(0, EXCERPT_SHOWN_CHAR_CAP) : null,
      evidence_sent: evidenceUsed.length > 0,
      skipped_reason: skippedReasonOf(reasons),
    });
  }
  return out;
}

router.post("/", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = req.body?.agentIds;
  const ids = Array.isArray(raw)
    ? Array.from(new Set(raw.map((v: unknown) => String(v ?? "").trim()).filter((v: string) => v.length > 0)))
    : [];
  if (ids.length < 1 || ids.length > SECOND_LINE_PREVIEW_MAX_IDS || (Array.isArray(raw) && raw.length > SECOND_LINE_PREVIEW_MAX_IDS)) {
    res.status(400).json({ error: `agentIds må være en liste med 1..${SECOND_LINE_PREVIEW_MAX_IDS} id-er` });
    return;
  }
  try {
    const rows = await previewSecondLineJudge(ids, testDeps ?? {});
    res.json({ success: true, read_only: true, count: rows.length, rows });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err).slice(0, 200) });
  }
});

export default router;
