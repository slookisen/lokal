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
  findDuplicateStreetAddresses,
  type FieldName,
  type ProvenanceRecord,
} from "../services/cross-source-validator";
import { planAutoFix, type AutoFixResult } from "../services/auto-fix-service";

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

// Decide verification_status from gate result + flags + cross-source check.
// cross_source_passes=true means all 3 critical fields have >=2 agreeing sources
// (or owner-curated). Only agents that pass BOTH the basic gate AND cross-source
// are promoted to "verified". Pure function.
export function deriveVerificationStatus(
  passes: boolean,
  flags: string[],
  cross_source_passes?: boolean
): "verified" | "review_required" | "pending_verify" {
  if (!passes) {
    // Basic gate failed — reviewable if NACE/Brreg issues, otherwise retry
    if (flags.some((f) => f.startsWith("nace_blacklist") || f === "brreg_konkurs" || f === "brreg_inactive")) {
      return "review_required";
    }
    return "pending_verify";
  }
  // Basic gate passed — now check cross-source
  if (cross_source_passes === false) {
    // Basic gate passed but cross-source failed → needs human review
    return "review_required";
  }
  return "verified";
}

// Main loop. Caller (Fly Machine job, test, or manual) provides a
// brregLookup function (or null to skip Brreg).
export async function runVerifierBatch(opts: {
  batchSize?: number;
  brregLookup?: BrregFn | null;
  db?: any;
  headProbe?: ((url: string, timeoutMs?: number) => Promise<number | null>) | null;
  // WO-26: when true, after the basic verifier pass we call planAutoFix on
  // every result with status 'review_required'. If the plan has confidence
  // 'high' AND manual_review_recommended is false, we apply it and bump the
  // status to 'auto_fixed'. Default: false (opt-in only).
  autoFixOnReviewRequired?: boolean;
}): Promise<{
  run_id: string;
  started_at: string;
  finished_at: string;
  results: VerifierResult[];
  auto_fix?: {
    attempted: number;
    applied: number;
    flagged_for_review: number;
  };
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
    const crossSourceResults: Record<string, unknown> = {};
    let cross_source_passes = true;

    for (const field of csFields) {
      const result = crossSourceAgreement(fieldProv, field);
      crossSourceResults[field] = result;
      if (!result.agree) cross_source_passes = false;
    }

    if (gate.passes && !cross_source_passes) {
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) passed basic gate but failed cross-source: ` +
        csFields
          .filter((f) => !(crossSourceResults[f] as { agree: boolean }).agree)
          .map((f) => {
            const r = crossSourceResults[f] as { agree: boolean; sources_used?: string[] };
            return `${f}(sources=${(r.sources_used ?? []).join(",") || "none"})`;
          })
          .join(", ")
      );
    }

    const newVerification = deriveVerificationStatus(gate.passes, gate.flags, cross_source_passes);
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

  // ── WO-26: optional auto-fix pass on review_required results ────────────
  let autoFixSummary: { attempted: number; applied: number; flagged_for_review: number } | undefined;
  if (opts.autoFixOnReviewRequired) {
    autoFixSummary = { attempted: 0, applied: 0, flagged_for_review: 0 };
    const dupGroups = findDuplicateStreetAddresses(db);
    const finishedAtIso = new Date().toISOString();

    for (const r of results) {
      if (r.new_verification_status !== "review_required") continue;
      autoFixSummary.attempted++;

      // Re-read agent record so the planner sees fresh fields
      const row = db
        .prepare(
          `SELECT a.id AS agent_id, a.name, a.url,
                  k.address, k.postal_code, a.city,
                  k.website, k.phone, k.email,
                  k.verification_status, k.outreach_eligible_at
             FROM agents a
       INNER JOIN agent_knowledge k ON k.agent_id = a.id
            WHERE a.id = ?`
        )
        .get(r.agent_id) as any;
      if (!row) continue;

      let plan: AutoFixResult;
      try {
        plan = await planAutoFix({
          agent_id: r.agent_id,
          current_knowledge: {
            agent_id: r.agent_id,
            name: row.name,
            address: row.address,
            postal_code: row.postal_code,
            city: row.city,
            website: row.website,
            phone: row.phone,
            email: row.email,
            url: row.url,
            verification_status: row.verification_status,
            outreach_eligible_at: row.outreach_eligible_at,
          },
          brregLookup: opts.brregLookup ?? null,
          duplicateStreetAddresses: dupGroups,
        });
      } catch (err) {
        console.error(`[verifier auto-fix] planAutoFix crashed for ${r.agent_id}:`, err);
        continue;
      }

      const safeToApply =
        plan.actions.length > 0 &&
        plan.confidence === "high" &&
        plan.manual_review_recommended === false;

      if (!safeToApply) {
        if (plan.actions.length > 0) autoFixSummary.flagged_for_review++;
        continue;
      }

      // Apply: write set_field actions to agent_knowledge, set_status to verification_status,
      // log everything to auto_fix_log. Mirrors admin-auto-fix route's applyActions logic.
      try {
        const tx = db.transaction(() => {
          for (const action of plan.actions) {
            if (action.type === "flag_review") continue;
            if (action.type === "set_status") {
              db.prepare(
                "UPDATE agent_knowledge SET verification_status = ? WHERE agent_id = ?"
              ).run(action.new_status, r.agent_id);
              db.prepare(
                `INSERT INTO auto_fix_log (agent_id, applied_at, fix_category, field, old_value, new_value, source, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                r.agent_id, finishedAtIso, plan.fix_categories[0] ?? "set_status",
                "verification_status", action.old_status, action.new_status,
                "auto-fix:verifier", action.reason
              );
              continue;
            }
            // set_field — agents owns: name, city, url. Knowledge owns the rest.
            const AGENT_FIELDS = new Set(["url", "city", "name"]);
            const isAgentField = AGENT_FIELDS.has(action.field);
            const table = isAgentField ? "agents" : "agent_knowledge";
            const fkCol = isAgentField ? "id" : "agent_id";
            db.prepare(`UPDATE ${table} SET ${action.field} = ? WHERE ${fkCol} = ?`).run(
              action.new_value as any, r.agent_id
            );
            db.prepare(
              `INSERT INTO auto_fix_log (agent_id, applied_at, fix_category, field, old_value, new_value, source, reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              r.agent_id, finishedAtIso, plan.fix_categories[0] ?? "set_field",
              action.field,
              action.old_value === null || action.old_value === undefined ? null : String(action.old_value),
              action.new_value === null || action.new_value === undefined ? null : String(action.new_value),
              action.source, action.reason
            );
          }
          // Mark as auto_fixed (unless a status action already set it elsewhere)
          const stillReview = db.prepare(
            "SELECT verification_status AS s FROM agent_knowledge WHERE agent_id = ?"
          ).get(r.agent_id) as { s: string } | undefined;
          if (stillReview?.s === "review_required") {
            db.prepare(
              "UPDATE agent_knowledge SET verification_status = 'auto_fixed' WHERE agent_id = ?"
            ).run(r.agent_id);
            r.new_verification_status = "auto_fixed";
          } else if (stillReview) {
            r.new_verification_status = stillReview.s;
          }
        });
        tx();
        autoFixSummary.applied++;
      } catch (err) {
        console.error(`[verifier auto-fix] apply crashed for ${r.agent_id}:`, err);
      }
    }
  }

  return {
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results,
    ...(autoFixSummary ? { auto_fix: autoFixSummary } : {}),
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
  auto_fix?: { attempted: number; applied: number; flagged_for_review: number };
}): Record<string, unknown> {
  const r = input.results;
  const verified = r.filter((x) => x.new_verification_status === "verified").length;
  const review = r.filter((x) => x.new_verification_status === "review_required").length;
  const pending = r.filter((x) => x.new_verification_status === "pending_verify").length;
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
      ...(input.auto_fix
        ? [
            { type: "db_state_change", value: input.auto_fix.applied, meta: { kind: "auto_fix_applied" } },
            { type: "db_state_change", value: input.auto_fix.flagged_for_review, meta: { kind: "auto_fix_flag_review" } },
          ]
        : []),
    ],
    next_suggested: ["platform-verifier"],
    notes: `Verified ${r.length} agents, ${verified} passed kvalitets-gate, ${newlyEligible} added to outreach_ready_pool`,
  };
}
