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
  domainCoherenceCheck,
  factualFieldsWithOnlyInference,
  FREE_MAIL_DOMAINS,
  type FieldName,
  type ProvenanceRecord,
  type CrossSourceResult,
  type CrossSourceVerdict,
  type DomainCoherenceResult,
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
  // PR-21 / WO-19: link-freshness probe outcome
  url_last_probed: string | null;
  url_last_status: number | null;
  url_demoted: boolean;
  // orch-PR-20260512-33: domain-coherence override (Eidsmo fix)
  domain_incoherent: boolean;
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

// ─── PR-21 / WO-19 (2026-05-10): link-freshness probe ─────────────
//
// Richer companion to headProbe(). Whereas headProbe is used by the
// kvalitets-gate (any 200-399 ≈ ok), probeAgentUrl is the dedicated
// freshness check that records the result on agent_knowledge so the
// outreach_ready_pool VIEW can drop agents with broken URLs.
//
// Behaviour:
//   - Try HEAD with 8s timeout.
//   - If HEAD returns 405 (method-not-allowed), fall back to GET with
//     a 0-1023 byte-range header so we don't pull the full body.
//   - On network failure / abort: status=0, ok=false.
//   - 200-399  → ok=true   (redirects are fine, URL is reachable).
//   - 400-599  → ok=false  (broken or blocked — 403 is a "block", which
//                            we still treat as broken-for-marketing-purposes
//                            because outbound emails would link to a wall).
//
// Pure-ish: the only side-effect is the network call; deterministic given
// the network response. The fetcher is injectable for tests.
export interface ProbeResult {
  status: number;
  ok: boolean;
  durationMs: number;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string>; redirect?: "follow" | "manual" | "error" }
) => Promise<{ status: number }>;

export async function probeAgentUrl(
  url: string,
  opts?: { timeoutMs?: number; fetchImpl?: FetchLike }
): Promise<ProbeResult> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const fetchImpl: FetchLike = (opts?.fetchImpl ?? (fetch as unknown as FetchLike));
  const start = Date.now();

  // Helper: one fetch attempt with its own AbortController + timeout.
  async function attempt(method: "HEAD" | "GET"): Promise<{ status: number } | { status: 0 }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (method === "GET") headers["Range"] = "bytes=0-1023";
      const r = await fetchImpl(url, { method, signal: ctrl.signal, redirect: "follow", headers });
      return { status: r.status };
    } catch {
      return { status: 0 };
    } finally {
      clearTimeout(t);
    }
  }

  // 1) HEAD first.
  let res = await attempt("HEAD");
  // 2) If HEAD said "405 method-not-allowed" (or 0 = aborted/network),
  //    retry with byte-ranged GET. We do NOT retry on 4xx/5xx other
  //    than 405 — those are real responses from a real server.
  if (res.status === 405 || res.status === 0) {
    res = await attempt("GET");
  }

  const durationMs = Date.now() - start;
  const ok = res.status >= 200 && res.status < 400;
  return { status: res.status, ok, durationMs };
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
  //
  // Free-mail/ISP exemption (orch-pr-20260614-4):
  // Small Norwegian producers commonly use personal email addresses (gmail.com,
  // online.no, etc.) that share no domain with their website. This is a normal
  // operating pattern — not a data-quality failure. The domain-coherence layer
  // already treats free-mail hosts as neutral (FREE_MAIL_DOMAINS in
  // cross-source-validator.ts); we mirror that logic here so the kvalitets-gate
  // doesn't block producers solely because they use a personal mailbox.
  //
  // Behaviour:
  //   - emailMatchesSite: the existing host-match test (unchanged).
  //   - isFreeMail: eDom is a known free-mail/ISP provider.
  //   - email_own_domain = emailMatchesSite OR isFreeMail.
  //   - email_domain_mismatch flag only when a real (non-free-mail) address
  //     genuinely disagrees with the website host.
  //   - No-email case unchanged: email=null → email_own_domain=false (gate
  //     still requires an email; this fix only exempts free-mail addresses).
  const websiteHost = hostnameFromUrl(input.website);
  const eDom = emailDomain(input.email);
  const emailMatchesSite = !!(websiteHost && eDom && (eDom === websiteHost || eDom.endsWith("." + websiteHost) || websiteHost.endsWith("." + eDom)));
  const isFreeMail = !!(eDom && FREE_MAIL_DOMAINS.includes(eDom));
  const email_own_domain = emailMatchesSite || isFreeMail;
  if (input.email && !emailMatchesSite && !isFreeMail) flags.push("email_domain_mismatch");

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
      `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city,
              k.email, k.phone, k.address,
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

// PR-27: Re-process review_required + data_insufficient agents first.
// After PR-25 backfill + PR-26 aggregateVerdict fix, many of these
// now have proper provenance and can be moved to `verified`. Default
// pickBatch order (oldest last_verified_at) would re-process them last
// because their last_verified_at is recent. This variant scopes the
// pool to just those rows, oldest-first, so the caller can drain the
// review queue quickly.
export function pickReviewQueueBatch(db: any, limit = 30): any[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status IN ('review_required', 'data_insufficient')
     ORDER BY COALESCE(k.last_verified_at, '1970-01-01') ASC
        LIMIT ?`
    )
    .all(limit);
}


// ─── orch-pr-20260614-2: bulk pending_verify picker ────────────────────────
//
// Dedicated picker for the bulk-sweep job (src/services/verifier-sweep.ts).
// Unlike pickBatchBiased (70/30 split), this scopes EXCLUSIVELY to
// `pending_verify` agents so the sweep makes monotone progress draining
// the backlog without interleaving other status buckets.
//
// Order: oldest COALESCE(sweep_processed_at, last_verified_at, '1970-01-01')
// first — ensures agents that haven't been touched by any sweep run come first,
// then falls back to last_verified_at for agents that were verified once but
// slipped back to pending.
//
// opt_out is explicitly excluded even though pending_verify and opt_out are
// mutually exclusive in practice — defensive filter matches all other pickers.
export function pickPendingVerifyBatch(db: any, limit = 50): any[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status = 'pending_verify'
          AND k.verification_status NOT IN ('opt_out')
     ORDER BY COALESCE(k.sweep_processed_at, k.last_verified_at, '1970-01-01') ASC
        LIMIT ?`
    )
    .all(limit);
}

// Count remaining pending_verify agents. Used by the sweep endpoints to
// report how much backlog is left after each API call.
export function countPendingVerify(db: any): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_knowledge
        WHERE verification_status = 'pending_verify'`
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

// orch-pr-87: 70/30 growth-biased picker. Default behaviour for
// /admin/run-verifier going forward — keeps the systematic-sweep
// guarantee for already-`verified` agents while biasing capacity
// toward the growth-reservoir buckets (pending_verify, review_required,
// data_insufficient) where actual pool-growth is unlocked.
//
// Split semantics:
//   - growthCount = Math.floor(limit * growthRatio)   (default 21 of 30)
//   - verifiedCount = limit - growthCount             (default 9 of 30)
//   - growth sub-query: WHERE verification_status IN
//       ('pending_verify','review_required','data_insufficient')
//   - verified sub-query: WHERE verification_status = 'verified'
//   - both ordered HTTP-failed-first then oldest last_verified_at first
//     (matches pickBatch's existing front-bump behaviour).
//
// Fall-back: if one sub-query returns fewer rows than its target,
// the deficit is filled from the other bucket so the caller always
// gets up to `limit` candidates when any exist.
//
// opt_out agents are always excluded (matches pickBatch).
export function pickBatchBiased(
  db: any,
  limit = 30,
  growthRatio = 0.7
): any[] {
  const growthTarget = Math.floor(limit * growthRatio);
  const verifiedTarget = limit - growthTarget;

  const SELECT_COLS = `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id`;

  const ORDER = `ORDER BY CASE WHEN k.last_http_status >= 400 THEN 0 ELSE 1 END,
              COALESCE(k.last_verified_at, '1970-01-01') ASC`;

  const growthRows = growthTarget > 0
    ? db.prepare(
        `${SELECT_COLS}
          WHERE k.verification_status IN ('pending_verify', 'review_required', 'data_insufficient')
          ${ORDER}
          LIMIT ?`
      ).all(growthTarget)
    : [];

  const verifiedRows = verifiedTarget > 0
    ? db.prepare(
        `${SELECT_COLS}
          WHERE k.verification_status = 'verified'
          ${ORDER}
          LIMIT ?`
      ).all(verifiedTarget)
    : [];

  // Fall-back: backfill from the other bucket if one came up short.
  const growthDeficit = growthTarget - growthRows.length;
  const verifiedDeficit = verifiedTarget - verifiedRows.length;

  let extraVerified: any[] = [];
  if (growthDeficit > 0) {
    extraVerified = db.prepare(
      `${SELECT_COLS}
        WHERE k.verification_status = 'verified'
        ${ORDER}
        LIMIT ?`
    ).all(verifiedTarget + growthDeficit);
    // Strip the rows we already have to avoid duplicates and cap total.
    const haveIds = new Set(verifiedRows.map((r: any) => r.id));
    extraVerified = extraVerified.filter((r: any) => !haveIds.has(r.id)).slice(0, growthDeficit);
  }

  let extraGrowth: any[] = [];
  if (verifiedDeficit > 0) {
    extraGrowth = db.prepare(
      `${SELECT_COLS}
        WHERE k.verification_status IN ('pending_verify', 'review_required', 'data_insufficient')
        ${ORDER}
        LIMIT ?`
    ).all(growthTarget + verifiedDeficit);
    const haveIds = new Set(growthRows.map((r: any) => r.id));
    extraGrowth = extraGrowth.filter((r: any) => !haveIds.has(r.id)).slice(0, verifiedDeficit);
  }

  return [...growthRows, ...extraGrowth, ...verifiedRows, ...extraVerified].slice(0, limit);
}

// orch-pr-87: sweep-round observability. Returns aggregate counters
// derived from agent_knowledge.sweep_processed_at. v1 keeps
// `current_round = 0` (a TODO — round numbering is a nice-to-have we
// can derive later from a sweep-history table); the useful signal
// today is the processed/remaining split within the current window.
export interface SweepStatus {
  current_round: number;
  round_started_at: string | null;
  agents_processed_this_round: number;
  agents_total: number;
  remaining_this_round: number;
  oldest_processed_at: string | null;
  newest_processed_at: string | null;
}

export function getSweepStatus(db: any): SweepStatus {
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_knowledge
        WHERE verification_status NOT IN ('opt_out')`
    )
    .get() as { n: number } | undefined;
  const agentsTotal = totalRow?.n ?? 0;

  const boundsRow = db
    .prepare(
      `SELECT MIN(sweep_processed_at) AS oldest,
              MAX(sweep_processed_at) AS newest
         FROM agent_knowledge
        WHERE verification_status NOT IN ('opt_out')
          AND sweep_processed_at IS NOT NULL`
    )
    .get() as { oldest: string | null; newest: string | null } | undefined;

  const roundStartedAt = boundsRow?.oldest ?? null;
  const newest = boundsRow?.newest ?? null;

  let agentsProcessedThisRound = 0;
  if (roundStartedAt !== null) {
    const procRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_knowledge
          WHERE verification_status NOT IN ('opt_out')
            AND sweep_processed_at IS NOT NULL
            AND sweep_processed_at > ?`
      )
      .get(roundStartedAt) as { n: number } | undefined;
    agentsProcessedThisRound = procRow?.n ?? 0;
  }

  const remaining = Math.max(0, agentsTotal - agentsProcessedThisRound);

  return {
    // TODO(orch-pr-87): derive round number from sweep-history. v1
    // exposes 0 so dashboards can render without crashing; the useful
    // observability today is the processed/remaining split below.
    current_round: 0,
    round_started_at: roundStartedAt,
    agents_processed_this_round: agentsProcessedThisRound,
    agents_total: agentsTotal,
    remaining_this_round: remaining,
    oldest_processed_at: roundStartedAt,
    newest_processed_at: newest,
  };
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
    // PR-21 / WO-19: optional probe outcome (when omitted, columns
    // are left untouched so the existing test-suite is not broken).
    url_last_probed?: string | null;
    url_last_status?: number | null;
  }
): void {
  if (outcome.url_last_probed !== undefined || outcome.url_last_status !== undefined) {
    db.prepare(
      `UPDATE agent_knowledge SET
         verification_status         = ?,
         enrichment_status           = ?,
         last_verified_at            = ?,
         last_http_check_at          = ?,
         last_http_status            = ?,
         outreach_eligible_at        = COALESCE(?, outreach_eligible_at),
         verification_review_reason  = ?,
         url_last_probed             = COALESCE(?, url_last_probed),
         url_last_status             = COALESCE(?, url_last_status)
       WHERE agent_id = ?`
    ).run(
      outcome.new_verification_status,
      outcome.new_enrichment_status,
      outcome.runStartedAt,
      outcome.runStartedAt,
      outcome.http_status,
      outcome.eligibleAt,
      JSON.stringify(outcome.cross_source_reason ?? {}),
      outcome.url_last_probed ?? null,
      outcome.url_last_status ?? null,
      agentId
    );
  } else {
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

  // orch-pr-87 (iter 2): sweep-round tracking. Runs unconditionally
  // for BOTH branches above — iter 1 placed this after the fallthrough
  // UPDATE only, which made it dead code in production (the prod
  // caller `runVerifierBatch` always populates url_last_probed/_status,
  // so the first branch always fires and used to `return` early).
  // Best-effort — the column was added by an idempotent ALTER (see
  // src/database/init.ts); in test harnesses that build a minimal
  // agent_knowledge schema without running init(), the column may be
  // missing. Wrap in try/catch so those tests continue to pass.
  try {
    db.prepare(
      `UPDATE agent_knowledge SET sweep_processed_at = ? WHERE agent_id = ?`
    ).run(outcome.runStartedAt, agentId);
  } catch {
    // sweep_processed_at column not present in this DB — skip.
  }
}

// ─── PR-21 / WO-19 (2026-05-10): standalone url_last_probe writer ──
// Used by the boot-time backfill path. Updates ONLY url_last_probed +
// url_last_status, and (if the probe failed) demotes a 'rich' enrichment
// to 'partial' so the agent is dropped from the outreach pool until the
// next successful probe. Idempotent for re-runs.
export function applyUrlProbeResult(
  db: any,
  agentId: string,
  probe: { status: number; ok: boolean; probedAt: string }
): { demoted: boolean } {
  // Read current enrichment_status so we know whether to demote.
  const row = db
    .prepare(`SELECT enrichment_status FROM agent_knowledge WHERE agent_id = ?`)
    .get(agentId) as { enrichment_status: string } | undefined;
  if (!row) return { demoted: false };

  let newEnrichment = row.enrichment_status;
  let demoted = false;
  if (!probe.ok && row.enrichment_status === "rich") {
    newEnrichment = "partial";
    demoted = true;
  }

  db.prepare(
    `UPDATE agent_knowledge SET
       url_last_probed   = ?,
       url_last_status   = ?,
       enrichment_status = ?
     WHERE agent_id = ?`
  ).run(probe.probedAt, probe.status, newEnrichment, agentId);
  return { demoted };
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
  // PR-27: Optional override for the candidate-picker. Defaults to
  // pickBatch. Pass pickReviewQueueBatch to drain the review queue.
  pickFn?: (db: any, limit?: number) => any[];
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

  const pickFn = opts.pickFn ?? pickBatch;
  const candidates = pickFn(db, limit);
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

    // ── Guard #2: inference-source deny-list for factual fields (orch-pr-16) ──
    // A factual field (products / address / phone) sourced SOLELY from AI
    // inference (category_inference, seasonal_knowledge, name_analysis,
    // web_search, …) is a fabricated guess, not evidence. Real failure
    // (2026-06-15): Bærsentralen got product "jordbær" from seasonal_knowledge
    // / category_inference; they actually do *multer*. We raise an advisory
    // `inference_only_field:<field>` flag and quarantine the agent from the
    // pool (review_required) so it is re-enriched rather than promoted. This is
    // factual-fields only — it never touches how (free-mail) emails are handled.
    const inferenceOnlyFields = factualFieldsWithOnlyInference(fieldProv);
    for (const f of inferenceOnlyFields) {
      gate.flags.push(`inference_only_field:${f}`);
    }

    // ── Guard #1 (verifier side): website-ownership marker (orch-pr-16) ───────
    // The homepage-provenance crawl stamps field_provenance.website_ownership =
    // { status: "unverified", ... } when the fetched site did not mention the
    // producer (the Grette/grettegaard wrong-entity case). Such an agent must
    // not sit in the pool on the strength of a mis-anchored site. Raise an
    // advisory flag and quarantine (review_required) so the site is re-checked.
    // Omitting the homepage Tier-A source already prevents NEW promotions; this
    // also actively pulls back an agent that was verified before the mismatch
    // was detected. Advisory only — never deletes the producer.
    let websiteOwnershipUnverified = false;
    {
      const wo = (fieldProv as Record<string, unknown>)?.website_ownership;
      if (wo && typeof wo === "object" && (wo as Record<string, unknown>).status === "unverified") {
        websiteOwnershipUnverified = true;
        gate.flags.push("website_ownership_unverified");
      }
    }

    // ── Domain-coherence check (orch-PR-20260512-33 / Eidsmo fix) ──────────
    // Even when per-field cross-source agreement passes, if the homepage
    // URL discovered for the agent disagrees with the website/email stored
    // by enrichment, those signals are pointing at a DIFFERENT legal entity
    // (e.g. two companies sharing an address). Force review_required so a
    // human can pick which signals are correct before outreach fires.
    const coherence: DomainCoherenceResult = domainCoherenceCheck(
      agent.agent_url,
      agent.website,
      agent.email,
    );
    let newVerification = deriveVerificationStatus(gate.passes, gate.flags, agentVerdict);
    if (inferenceOnlyFields.length > 0) {
      // Quarantine: a factual field has only inference sources. Never promote
      // to the pool; downgrade `verified`/`pool_eligible` to review_required so
      // it is re-enriched. (Leaves already-worse statuses untouched.)
      if (newVerification === "verified") newVerification = "review_required";
      (crossSourceResults as Record<string, unknown>).inference_only_fields = inferenceOnlyFields;
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) inference-only factual field(s): ${inferenceOnlyFields.join(", ")} — quarantined from pool`,
      );
    }
    if (websiteOwnershipUnverified) {
      // Quarantine: the producer's site could not be confirmed as theirs.
      if (newVerification === "verified") newVerification = "review_required";
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) website_ownership=unverified — quarantined from pool`,
      );
    }
    if (!coherence.coherent) {
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) domain-incoherent: ${coherence.reason}`,
      );
      newVerification = "review_required";
      // Surface the reason on the persisted cross_source_reason JSON so
      // the review-queue UI / admin tooling can see why.
      (crossSourceResults as Record<string, unknown>).domain_coherence = coherence;
    }
    let newEnrichment = computeEnrichmentStatus({
      about: agent.about,
      products,
      address: agent.address,
    });

    // ─── PR-21 / WO-19 (2026-05-10): link-freshness probe (Phase 2D) ────
    // Runs AFTER the description-quality gate (computeEnrichmentStatus)
    // and BEFORE the agent_knowledge write. If the URL is broken (4xx/5xx
    // or network failure) and we computed 'rich', demote to 'partial' so
    // the outreach pool drops the agent until its URL is fixed.
    let probeResult: { status: number; ok: boolean; durationMs: number } | null = null;
    let urlDemoted = false;
    if (agent.website) {
      probeResult = await probeAgentUrl(agent.website);
      if (!probeResult.ok) {
        console.log(
          `[enrichment] URL probe failed for agent ${agent.id}: status=${probeResult.status}`
        );
        if (newEnrichment === "rich") {
          newEnrichment = "partial";
          urlDemoted = true;
        }
      }
    }

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
      url_last_probed: probeResult ? startedAt : null,
      url_last_status: probeResult ? probeResult.status : null,
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
      url_last_probed: probeResult ? startedAt : null,
      url_last_status: probeResult ? probeResult.status : null,
      url_demoted: urlDemoted,
      domain_incoherent: !coherence.coherent,
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
  // orch-PR-20260512-33 (Eidsmo fix): track domain-coherence overrides so
  // operators can see at a glance how many agents this hourly run pulled
  // out of pool eligibility for mismatched website/email hosts.
  const domainIncoherent = r.filter((x) => x.domain_incoherent).length;

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
      { type: "db_state_change", value: domainIncoherent, meta: { kind: "agents_domain_incoherent" } },
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

// ─── PR-21 / WO-19 (2026-05-10): boot-time URL freshness backfill ─────
//
// Probes every agent currently in the outreach pool and writes the result
// to url_last_probed + url_last_status. Demotes any 4xx/5xx-URL agent with
// enrichment_status='rich' to 'partial', which removes them from the
// outreach_ready_pool VIEW.
//
// Designed to be called from src/index.ts AFTER app.listen so the boot
// itself is non-blocking. Worst case: 8s × 129 agents ≈ 17 min, run
// sequentially. Logs progress every 10 agents so operators can watch.
export async function runUrlBackfill(opts?: {
  db?: any;
  fetchImpl?: FetchLike;
  onProgress?: (done: number, total: number) => void;
  logEveryN?: number;
}): Promise<{ scanned: number; ok: number; broken: number; demoted: number; durationMs: number }> {
  const db = opts?.db ?? getDb();
  const start = Date.now();
  const logEveryN = opts?.logEveryN ?? 10;

  // Pull every agent currently meeting the (pre-freshness) pool gate, so
  // the backfill doesn't re-probe agents that are already filtered out by
  // verification_status / enrichment_status / email rules.
  const candidates = db.prepare(
    `SELECT a.id AS agent_id, k.website
       FROM agents a
       INNER JOIN agent_knowledge k ON k.agent_id = a.id
      WHERE k.email IS NOT NULL
        AND k.email != ''
        AND k.verification_status = 'verified'
        AND k.enrichment_status IN ('partial', 'rich')
        AND k.website IS NOT NULL
        AND k.website != ''`
  ).all() as Array<{ agent_id: string; website: string }>;

  let okCount = 0;
  let brokenCount = 0;
  let demoted = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const probedAt = new Date().toISOString();
    let probe: { status: number; ok: boolean; durationMs: number };
    try {
      probe = await probeAgentUrl(c.website, { fetchImpl: opts?.fetchImpl });
    } catch {
      probe = { status: 0, ok: false, durationMs: 0 };
    }
    if (probe.ok) okCount++;
    else {
      brokenCount++;
      console.log(`[enrichment] URL probe failed for agent ${c.agent_id}: status=${probe.status}`);
    }
    const r = applyUrlProbeResult(db, c.agent_id, { status: probe.status, ok: probe.ok, probedAt });
    if (r.demoted) demoted++;
    if ((i + 1) % logEveryN === 0) {
      console.log(`[enrichment-backfill] progress ${i + 1}/${candidates.length} (ok=${okCount} broken=${brokenCount} demoted=${demoted})`);
    }
    if (opts?.onProgress) opts.onProgress(i + 1, candidates.length);
  }

  const durationMs = Date.now() - start;
  console.log(
    `[enrichment-backfill] complete: scanned=${candidates.length} ok=${okCount} broken=${brokenCount} demoted=${demoted} took=${Math.round(durationMs / 1000)}s`
  );
  return { scanned: candidates.length, ok: okCount, broken: brokenCount, demoted, durationMs };
}
