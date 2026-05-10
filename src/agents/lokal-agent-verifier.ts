// ─── lokal-agent-verifier — Phase 5 verify-first runner (WO #8) ─────
//
// Re-verifies ~30 agents per hourly run against the kvalitets-gate
// (PHASE5-ENRICHMENT-REORG.md §8.2). Updates verification_status,
// enrichment_status, and outreach_eligible_at on agent_knowledge.
//
// Invocation: this module exposes a single async entrypoint
// `runVerifierBatch()`. It is meant to be called from a Fly Machine
// scheduled job (via `flyctl machines run --schedule "0 22 * * *" ...`)
// or invoked manually for ad-hoc runs.
//
// The gate is deterministic: HTTP status + email-domain match + Brreg
// status + content-length thresholds. No LLM call required for the
// gate itself; an Anthropic API key is reserved for future
// interpretive checks (e.g. "does this about-text describe a food
// producer?") but is OPTIONAL today.
//
// Reference: PHASE5-ENRICHMENT-REORG.md §8 + WO #8.

import { getDb } from "../database/init";
import {
  crossSourceAgreement,
  aggregateVerdict,
  type FieldName,
  type ProvenanceRecord,
  type CrossSourceResult,
  type CrossSourceVerdict,
} from "../services/cross-source-validator";

export interface VerifierResult {
  agent_id: string;
  passed: boolean;
  flags: string[];
  fields_verified: string[];
  fields_failed: string[];
  http_status: number | null;
  brreg_status: string | null;
  new_verification_status: string;
  new_enrichment_status: string;
  outreach_eligible_at: string | null;
  cross_source_reason: Record<string, unknown>;
}

export interface BrregLookupResult {
  is_active: boolean;
  is_konkurs: boolean;
  naering?: string | null;
}

// NACE-blacklist (Phase 5.5 — surfaces here as advisory flags).
// These are industries that almost certainly aren't local food
// producers. A Brreg `naering` containing any of these strings flags
// the agent as `review_required`, never `verified`.
const NACE_BLACKLIST: readonly string[] = [
  "Drift av restauranter",
  "Bedriftsrådgivning og annen administrativ rådgivning",
  "Avvirkning",
  "Grunnarbeid",
];

// Parse agent_knowledge.products which may be JSON or a plain array
function parseProducts(raw: unknown): unknown[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Extract registrable domain (e.g. "www.gard.no" → "gard.no")
function hostnameFromUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u.startsWith("http") ? u : `https://${u}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function emailDomain(e: string | null | undefined): string | null {
  if (!e || !e.includes("@")) return null;
  return e.split("@")[1].toLowerCase();
}

// HEAD-fetch with short timeout. We don't follow redirects deeply;
// a 200/301/302 all count as "reachable".
async function headProbe(url: string, timeoutMs = 5000): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { method: "HEAD", signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    return r.status;
  } catch {
    return null;
  }
}

// Brreg lookup — placeholder. Real implementation uses
// https://data.brreg.no/enhetsregisteret/api/enheter?navn=<name>
// We don't make the call from inside the verifier core today because
// Brreg rate-limits and the wired implementation belongs in
// rfb-contact-verifier — for this MVP we just consume what the caller
// hands us.
export type BrregFn = (name: string, city: string | null) => Promise<BrregLookupResult | null>;

// Compute kvalitets-gate from observed signals. Pure function for testability.
export function computeKvalitetsGate(input: {
  http_status: number | null;
  email: string | null;
  website: string | null;
  about: string | null;
  products: unknown[];
  brreg: BrregLookupResult | null;
  nace_blacklist?: readonly string[];
}): {
  passes: boolean;
  flags: string[];
  reasons: Record<string, boolean>;
} {
  const flags: string[] = [];
  const blacklist = input.nace_blacklist ?? NACE_BLACKLIST;

  // website_ok
  const website_ok = input.http_status !== null && input.http_status >= 200 && input.http_status < 400;
  if (input.http_status === null) flags.push("website_unreachable");
  else if (input.http_status >= 400) flags.push(`http_${input.http_status}`);

  // email_own_domain
  const websiteHost = hostnameFromUrl(input.website);
  const eDom = emailDomain(input.email);
  const email_own_domain = !!(websiteHost && eDom && (eDom === websiteHost || eDom.endsWith("." + websiteHost) || websiteHost.endsWith("." + eDom)));
  if (!email_own_domain && input.email) flags.push("email_domain_mismatch");

  // no_wrong_fit (NACE-blacklist)
  let no_wrong_fit = true;
  if (input.brreg?.naering) {
    for (const b of blacklist) {
      if (input.brreg.naering.includes(b)) {
        flags.push(`nace_blacklist:${b}`);
        no_wrong_fit = false;
        break;
      }
    }
  }

  // brreg_active
  let brreg_active = true;
  if (input.brreg) {
    if (input.brreg.is_konkurs) {
      flags.push("brreg_konkurs");
      brreg_active = false;
    } else if (!input.brreg.is_active) {
      flags.push("brreg_inactive");
      brreg_active = false;
    }
  }

  // content_threshold — about >= 80 chars OR products array >= 3
  const aboutLen = (input.about || "").length;
  const productsCount = input.products.length;
  const content_threshold = aboutLen >= 80 || productsCount >= 3;
  if (!content_threshold) flags.push("thin_content");

  const reasons = { website_ok, email_own_domain, no_wrong_fit, brreg_active, content_threshold };
  const passes = Object.values(reasons).every((v) => v);
  return { passes, flags, reasons };
}

// Compute enrichment_status from content depth. Pure function.
export function computeEnrichmentStatus(input: {
  about: string | null;
  products: unknown[];
  address: string | null;
}): "thin" | "partial" | "rich" {
  const aboutLen = (input.about || "").length;
  const productsCount = input.products.length;
  if (aboutLen >= 150 && productsCount >= 3 && input.address) return "rich";
  if (aboutLen >= 80 || productsCount >= 1 || input.address) return "partial";
  return "thin";
}

// Pick the next batch of agents to verify. Oldest-verified first;
// http-failures bumped to the front so we re-check broken sites.
export function pickBatch(db: any, limit = 30): any[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.city AS location_city, k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status NOT IN ('opt_out')
     ORDER BY CASE WHEN k.last_http_status >= 400 THEN 0 ELSE 1 END,
              COALESCE(k.last_verified_at, '1970-01-01') ASC
        LIMIT ?`
    )
    .all(limit);
}

// Apply verifier outcome to agent_knowledge. Pure DB write — caller
// owns the transaction.
export function applyVerifierOutcome(
  db: any,
  agentId: string,
  outcome: {
    new_verification_status: string;
    new_enrichment_status: string;
    http_status: number | null;
    runStartedAt: string;
    eligibleAt: string | null;
    cross_source_reason?: Record<string, unknown>;
  }
): void {
  db.prepare(
    `UPDATE agent_knowledge SET
       verification_status         = ?,
       enrichment_status           = ?,
       last_verified_at            = ?,
       last_http_check_at          = ?,
       last_http_status            = ?,
       outreach_eligible_at        = COALESCE(?, outreach_eligible_at),
       verification_review_reason  = ?
     WHERE agent_id = ?`
  ).run(
    outcome.new_verification_status,
    outcome.new_enrichment_status,
    outcome.runStartedAt,
    outcome.runStartedAt,
    outcome.http_status,
    outcome.eligibleAt,
    JSON.stringify(outcome.cross_source_reason ?? {}),
    agentId
  );
}

// Decide verification_status from gate result + flags + cross-source verdict.
//
// PR-19 / 2026-05-10: gate-split. The cross-source step now returns one of three
// verdicts per field; the agent-level verdict (computed via aggregateVerdict)
// flows through this function:
//   - cross_source_verdict='pool_eligible'    → "verified"  (≥2 agreeing sources)
//   - cross_source_verdict='review_required'  → "review_required"  (1 source, or
//     conflicting Tier-A/B sources — needs a human to triage)
//   - cross_source_verdict='data_insufficient'→ "data_insufficient"  (0 sources;
//     the back-catalogue case → needs more enrichment, NOT human review)
//
// Older callers still pass the boolean cross_source_passes; we accept either
// for backwards compat.
//
// Pure function.
export function deriveVerificationStatus(
  passes: boolean,
  flags: string[],
  cross_source_verdict?: CrossSourceVerdict | boolean
): "verified" | "review_required" | "pending_verify" | "data_insufficient" {
  if (!passes) {
    // Basic gate failed — reviewable if NACE/Brreg issues, otherwise retry
    if (flags.some((f) => f.startsWith("nace_blacklist") || f === "brreg_konkurs" || f === "brreg_inactive")) {
      return "review_required";
    }
    return "pending_verify";
  }
  // Basic gate passed — now check cross-source verdict
  // Accept legacy boolean (true/undefined → pool_eligible, false → review_required)
  let verdict: CrossSourceVerdict;
  if (cross_source_verdict === undefined || cross_source_verdict === true) {
    verdict = "pool_eligible";
  } else if (cross_source_verdict === false) {
    verdict = "review_required";
  } else {
    verdict = cross_source_verdict;
  }
  if (verdict === "data_insufficient") return "data_insufficient";
  if (verdict === "review_required") return "review_required";
  return "verified";
}

// Main loop. Caller (Fly Machine job, test, or manual) provides a
// brregLookup function (or null to skip Brreg).
export async function runVerifierBatch(opts: {
  batchSize?: number;
  brregLookup?: BrregFn | null;
  db?: any;
  headProbe?: ((url: string, timeoutMs?: number) => Promise<number | null>) | null;
}): Promise<{
  run_id: string;
  started_at: string;
  finished_at: string;
  results: VerifierResult[];
}> {
  const db = opts.db ?? getDb();
  const limit = opts.batchSize ?? 30;
  const startedAt = new Date().toISOString();
  const runId = `run-${startedAt.replace(/[:.]/g, "").slice(0, 15)}-lokal-agent-verifier-rfb`;

  const candidates = pickBatch(db, limit);
  const results: VerifierResult[] = [];

  for (const agent of candidates) {
    const probe = opts.headProbe ?? headProbe;
    const httpStatus = agent.website ? await probe(agent.website) : null;
    const brreg = opts.brregLookup
      ? await opts.brregLookup(agent.name, agent.location_city || null).catch(() => null)
      : null;

    const products = parseProducts(agent.products);
    const gate = computeKvalitetsGate({
      http_status: httpStatus,
      email: agent.email,
      website: agent.website,
      about: agent.about,
      products,
      brreg,
    });

    // ── Cross-source gate (Phase 5.3 / WO-16) ───────────────────────────────
    // Parse field_provenance (may be JSON string from SQLite or already an object)
    let fieldProv: Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown> = {};
    try {
      fieldProv = typeof agent.field_provenance === "string"
        ? JSON.parse(agent.field_provenance)
        : (agent.field_provenance ?? {});
    } catch {
      fieldProv = {};
    }

    const csFields: FieldName[] = ["address", "phone", "business_status"];
    const crossSourceResults: Record<string, CrossSourceResult> = {};

    for (const field of csFields) {
      crossSourceResults[field] = crossSourceAgreement(fieldProv, field);
    }

    // PR-19: aggregate the per-field verdicts into a single agent-level verdict.
    const agentVerdict = aggregateVerdict(crossSourceResults);

    if (gate.passes && agentVerdict !== "pool_eligible") {
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) passed basic gate but cross-source verdict=${agentVerdict}: ` +
        csFields
          .filter((f) => crossSourceResults[f].verdict !== "pool_eligible")
          .map((f) => {
            const r = crossSourceResults[f];
            return `${f}(verdict=${r.verdict},sources=${(r.sources_used ?? []).join(",") || "none"})`;
          })
          .join(", ")
      );
    }

    const newVerification = deriveVerificationStatus(gate.passes, gate.flags, agentVerdict);
    const newEnrichment = computeEnrichmentStatus({
      about: agent.about,
      products,
      address: agent.address,
    });

    const wasInPool = agent.verification_status === "verified";
    const nowInPool = newVerification === "verified" && newEnrichment !== "thin";
    const eligibleAt = nowInPool && !wasInPool ? startedAt : null;

    applyVerifierOutcome(db, agent.id, {
      new_verification_status: newVerification,
      new_enrichment_status: newEnrichment,
      http_status: httpStatus,
      runStartedAt: startedAt,
      eligibleAt,
      cross_source_reason: crossSourceResults,
    });

    results.push({
      agent_id: agent.id,
      passed: gate.passes,
      flags: gate.flags,
      fields_verified: Object.entries(gate.reasons).filter(([, v]) => v).map(([k]) => k),
      fields_failed: Object.entries(gate.reasons).filter(([, v]) => !v).map(([k]) => k),
      http_status: httpStatus,
      brreg_status: brreg?.is_konkurs ? "konkurs" : brreg?.is_active ? "aktiv" : null,
      new_verification_status: newVerification,
      new_enrichment_status: newEnrichment,
      outreach_eligible_at: eligibleAt,
      cross_source_reason: crossSourceResults,
    });
  }

  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results,
  };
}

// Build a run-envelope payload from verifier results, ready to POST
// to /admin/runs.
export function buildRunEnvelope(input: {
  run_id: string;
  started_at: string;
  finished_at: string;
  results: VerifierResult[];
  reportPath?: string;
}): Record<string, unknown> {
  const r = input.results;
  const verified = r.filter((x) => x.new_verification_status === "verified").length;
  const review = r.filter((x) => x.new_verification_status === "review_required").length;
  const pending = r.filter((x) => x.new_verification_status === "pending_verify").length;
  const dataInsufficient = r.filter((x) => x.new_verification_status === "data_insufficient").length;
  const httpUnreachable = r.filter((x) => x.flags.includes("website_unreachable")).length;
  const brregFlagged = r.filter((x) => x.flags.includes("brreg_inactive") || x.flags.includes("brreg_konkurs")).length;
  const newlyEligible = r.filter((x) => x.outreach_eligible_at !== null).length;

  return {
    run_id: input.run_id,
    vertical: "rfb",
    agent: "lokal-agent-verifier",
    trigger_source: "cron",
    started_at: input.started_at,
    finished_at: input.finished_at,
    status: "completed",
    claims: [
      { type: "db_state_change", value: verified, meta: { kind: "agents_verified" } },
      { type: "db_state_change", value: review, meta: { kind: "agents_review_required" } },
      { type: "db_state_change", value: pending, meta: { kind: "agents_pending_verify" } },
      { type: "db_state_change", value: dataInsufficient, meta: { kind: "agents_data_insufficient" } },
      { type: "db_state_change", value: httpUnreachable, meta: { kind: "http_unreachable" } },
      { type: "db_state_change", value: brregFlagged, meta: { kind: "brreg_inactive_flagged" } },
      {
        type: "db_state_change",
        value: newlyEligible,
        meta: { kind: "outreach_pool_added", detail: "transitioned to verified+(partial|rich)" },
      },
      ...(input.reportPath
        ? [{ type: "file_deployed", value: input.reportPath, meta: { kind: "hourly_report" } }]
        : []),
    ],
    next_suggested: ["platform-verifier"],
    notes: `Verified ${r.length} agents, ${verified} passed kvalitets-gate, ${newlyEligible} added to outreach_ready_pool`,
  };
}
