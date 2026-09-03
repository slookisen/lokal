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
  hasHomepageEvidence,
  hostFromUrlLike,
  registrableDomain,
  coerceProvenanceToArrayShape,
  FREE_MAIL_DOMAINS,
  type FieldName,
  type ProvenanceRecord,
  type CrossSourceResult,
  type CrossSourceVerdict,
  type DomainCoherenceResult,
} from "../services/cross-source-validator";
// Steg B fix-up (PR #524): reuse the SAME syntactic-validity / platform-owned-
// domain helpers admin-agents-contact-email-write.ts already exports for
// agents.contact_email, rather than hand-rolling new ones for
// agent_knowledge.email. See the Steg B block in runVerifierBatch for why.
import { isPlatformOwnedEmailDomain, isSyntacticallyValidEmail } from "../routes/admin-agents-contact-email-write";
// dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel: the RFB
// second verification line (Fase-1, items 1+2). classifyContactCandidateDefect
// is reused AS-IS for the second line's junk-email backstop (favicon local-
// parts / icon-extension TLDs / basic structural parsing) — see the "Guard
// #4" block in runVerifierBatch — rather than re-deriving that detection.
import { classifyContactCandidateDefect } from "../services/contact-candidate-judge";
import { judgeSecondLineProfile, type SecondLineProfileJudgeVerdict } from "../services/second-line-profile-judge";
import { scoreNameMatch, normaliseName, findOrgnumberByName, verifyOrgNumber, type BrregHit } from "../services/brreg-client";
// dev-request 2026-08-25-terminal-sweep-false-positives: the fresh-lookup
// death-check (checkFreshBrregDeathEvidence, below) reuses the SAME
// search-attempt waterfall shape admin-rfb-brreg-selfsufficiency.ts's own
// resolveOrgNrForTarget already uses for org-nr backfill (base name ->
// domain-token -> personal-name-ENK) — just these three pure candidate-
// generation helpers, never resolveOrgNrForTarget itself (that function is
// coupled to a different feature's DB writes and has different accept
// criteria — "what's its org-nr" vs. this file's "is this business dead").
// No import cycle: admin-rfb-brreg-selfsufficiency.ts and everything it
// imports are route/service modules that never import this file (verified
// 2026-08-25); requiring it here only defines its Express router (no I/O at
// module-load time — getDb()/network calls happen inside request handlers).
import {
  domainTokenCandidateName,
  pickDomainSourceForTarget,
  looksLikePersonalName,
} from "../routes/admin-rfb-brreg-selfsufficiency";
import { parseNameLocationSuffix } from "../services/location-suffix-parser";

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
  // dev-request 2026-07-15-gate-integrity-unverified-agent-bypass (slice 2):
  // free-mail/ISP email counted as ownership-proven with zero evidence — see
  // the Guard #3 block in runVerifierBatch for the full rationale.
  // email_ownership_unproven: true whenever the free-mail+no-evidence
  // condition holds (regardless of enforced-vs-report-only).
  // email_ownership_report_only: true specifically when the agent was
  // ALREADY `verified` going into this run — Daniel's explicit instruction
  // is that this check must NEVER downgrade an already-verified agent, so
  // that case is counted/reported but never changes the outcome.
  email_ownership_unproven: boolean;
  email_ownership_report_only: boolean;
  // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel: true
  // iff THIS run promoted the agent to 'verified' via the second (lower-
  // bar) line rather than first-line + cross-source. Always false when
  // RFB_SECOND_LINE_VERIFICATION_ENABLED is unset/not "true".
  verified_second_line: boolean;
  // agent display name, carried through so buildRunEnvelope can surface
  // report-only examples as {agent_id, name} without a second DB read.
  agent_name: string | null;
  // dev-request 2026-07-19-verifier-drain-persistens-og-throughput: the
  // agent's verification_status BEFORE this run wrote applyVerifierOutcome
  // (every candidate is written unconditionally — this is not an
  // evaluate-only path). Lets a caller distinguish "re-confirmed the same
  // status because nothing about the underlying evidence changed" from a
  // real transition, which `passed` (basic-gate-pass, independent of the
  // stricter cross-source/domain-coherence/email-ownership guards) cannot.
  prior_verification_status: string;
}

export interface BrregLookupResult {
  is_active: boolean;
  is_konkurs: boolean;
  naering?: string | null;
  // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel: the
  // registered Brreg name (foretaksnavn), optional and additive — existing
  // callers/tests that build a BrregLookupResult without it are unaffected
  // (computeKvalitetsGate itself never reads this field). Used ONLY by the
  // second verification line's computeSecondLineIdentitySources to detect a
  // "Brreg name-match" accepted identity source, via brreg-client.ts's
  // existing scoreNameMatch — reused, not re-implemented.
  navn?: string | null;
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

// dev-request 2026-09-02-rfb-verifier-headprobe-scheme-og-405: shared
// scheme-normalization helper. agent_knowledge.website (and similar stored
// URL columns) sometimes holds scheme-less values ("merkja.no",
// "www.qvenbrygg.no") — `new URL()` / `fetch()` both throw on those. This is
// the SAME `u.startsWith("http") ? u : https://${u}` pattern hostnameFromUrl
// already used inline; factored out here so headProbe and probeAgentUrl
// share exactly one normalization implementation instead of re-deriving it.
function withDefaultScheme(u: string): string {
  return u.startsWith("http") ? u : `https://${u}`;
}

// Extract registrable domain (e.g. "www.gard.no" → "gard.no")
//
// Exported (dev-request 2026-09-02-rfb-innhoestet-contact-email-uten-k-email):
// admin-rfb-contact-extraction.ts's backfill_from_contact_email mode needs
// the EXACT SAME domain-coherence rule computeKvalitetsGate's
// email_own_domain uses (exact/subdomain hostname equality) — not the
// registrable-domain equality cross-source-validator.ts's
// isAcceptableHomepageEmail/registrableDomain use, which can disagree on
// multi-level TLDs. Reused, not reimplemented.
export function hostnameFromUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(withDefaultScheme(u));
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function emailDomain(e: string | null | undefined): string | null {
  if (!e || !e.includes("@")) return null;
  return e.split("@")[1].toLowerCase();
}

// HEAD-fetch used by the kvalitets-gate (computeKvalitetsGate's website_ok).
//
// dev-request 2026-09-02-rfb-verifier-headprobe-scheme-og-405: this used to
// be its own raw fetch(url, {method:"HEAD"}) with no scheme normalization
// and no fallback when a server rejects HEAD — so scheme-less
// agent_knowledge.website values (fetch() throws on those → null → gate
// fails as "unreachable" even though the site is live) and HEAD-rejecting
// servers (405) both produced a false website_ok=false, even though the
// SIBLING freshness probe probeAgentUrl (below) already handled both cases
// correctly for url_last_status. headProbe now delegates to probeAgentUrl
// so there is exactly one probing implementation: same scheme
// normalization, same HEAD→GET-on-405/0 fallback, same 8s timeout. Only
// probeAgentUrl's status===0 (total network failure) is translated back to
// `null` here, to preserve headProbe's pre-existing null-on-unreachable
// contract (computeKvalitetsGate treats http_status===null as
// "website_unreachable" specifically, vs. a numeric status >=400).
//
// `fetchImpl` is an optional third param (mirrors probeAgentUrl's own
// injection point) purely so tests can exercise this function directly
// without monkey-patching globalThis.fetch — it is never passed by
// runVerifierBatch's `opts.headProbe ?? headProbe` call site, which only
// ever calls it with (url), so this is additive and does not change that
// calling convention.
export async function headProbe(url: string, timeoutMs = 8000, fetchImpl?: FetchLike): Promise<number | null> {
  const result = await probeAgentUrl(withDefaultScheme(url), { timeoutMs, fetchImpl });
  return result.status === 0 ? null : result.status;
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
  // dev-request 2026-09-02-rfb-verifier-headprobe-scheme-og-405: normalize
  // scheme-less input the same way headProbe/hostnameFromUrl do, so
  // scheme-less agent_knowledge.website rows ("merkja.no") don't hit
  // fetch() with an invalid URL and record url_last_status=0 for a
  // perfectly live site.
  url = withDefaultScheme(url);
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


// Brreg lookup. dev-request 2026-09-01-rfb-verifier-brreglookup-aldri-koblet:
// a real lookup (resolveBrregLookup, below) now runs per candidate row via
// https://data.brreg.no/enhetsregisteret/api/enheter?navn=<name> — both
// production callers (src/scripts/run-verifier.ts,
// src/routes/admin-run-verifier.ts) wire it in as the default brregLookup.
// The call is wrapped fail-closed (any error/ambiguous-hit/not-found falls
// back to null, never throws into the batch loop) and Brreg's own 15s-per-
// call timeout (REQUEST_TIMEOUT_MS in brreg-client.ts) bounds the worst case
// per row. This trades some added latency and Brreg rate-limit exposure —
// runVerifierBatch's loop below calls brregLookup unconditionally for every
// candidate row, not just ones that need it — for closing the
// brreg_name_match gap this dev-request identified. Further scoping (e.g.
// skipping the lookup for rows that already have another accepted identity
// source) is a reasonable future optimisation if batch latency becomes a
// problem in practice; not needed for this fix.
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
      `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status NOT IN ('opt_out', 'terminal_unconfirmable')
     -- dev-request 2026-08-23-terminal-unconfirmable: demonstrably
     -- unconfirmable agents (Brreg-dead, or zero identity sources on the
     -- second line) are removed from the hourly sweep permanently, same as
     -- opt_out — see deriveVerificationStatus / the second-line block above.
     -- Round-robin: same ordering rationale as pickBatchBiased's ORDER
     -- constant below (skive F) — sweep_processed_at first so every agent
     -- is processed once before any repeat, dead-URL priority as tie-break.
     ORDER BY COALESCE(k.sweep_processed_at, '1970-01-01') ASC,
              CASE WHEN k.last_http_status >= 400 THEN 0 ELSE 1 END,
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
//
// dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction
// (item 3): agents the domain-coherence sweep already looked at and could
// not confidently fix (coherent-but-review_required-for-another-reason,
// manual_review_needed, or circular_scramble_candidate) are excluded for
// 30 days — mirrors PR #248's HOMEPAGE_PARKING_DISABLED idiom in
// marketplace.ts's homepage-provenance-batch auto-select, so this daily
// drain stops re-processing the same 0-state-change cohort every run.
// The exclusion only holds while nothing has changed: if
// verification_review_reason differs from the snapshot taken at
// check-time, the agent is NOT silenced (something new happened).
// Env read at call time so the rollback flag works without a restart.
export function pickReviewQueueBatch(db: any, limit = 30): any[] {
  const parkingExclusion = process.env.DOMAIN_RECONCILIATION_PARKING_DISABLED === "true"
    ? ""
    : `AND (
         k.domain_reconciliation_checked_at IS NULL
         OR k.domain_reconciliation_checked_at <= datetime('now','-30 days')
         OR k.verification_review_reason != COALESCE(k.domain_reconciliation_reason_snapshot, '')
       )`;
  return db
    .prepare(
      `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status IN ('review_required', 'data_insufficient')
          ${parkingExclusion}
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
//
// dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction
// (item 6 follow-up): agents parked by 3 consecutive no-progress re-verify
// outcomes (pending_verify_parked_since, stamped in applyVerifierOutcome
// below) are excluded for 30 days — mirrors pickReviewQueueBatch's
// DOMAIN_RECONCILIATION_PARKING_DISABLED idiom (itself mirroring PR #248's
// HOMEPAGE_PARKING_DISABLED in marketplace.ts) so the bulk sweep stops
// re-probing a cohort proven unresolvable by re-verification alone. Env
// read at call time so the rollback flag works without a restart.
export function pickPendingVerifyBatch(db: any, limit = 50): any[] {
  const parkingExclusion = process.env.PENDING_VERIFY_PARKING_DISABLED === "true"
    ? ""
    : `AND (k.pending_verify_parked_since IS NULL OR k.pending_verify_parked_since <= datetime('now','-30 days'))`;
  return db
    .prepare(
      `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE k.verification_status = 'pending_verify'
          AND k.verification_status NOT IN ('opt_out')
          ${parkingExclusion}
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
// unverified, data_insufficient) where actual pool-growth is unlocked.
//
// Split semantics:
//   - growthCount = Math.floor(limit * growthRatio)   (default 21 of 30)
//   - verifiedCount = limit - growthCount             (default 9 of 30)
//   - verified sub-query: WHERE verification_status = 'verified'
//
// orch-pr-20260704-poolfix: 'unverified' (the agent_knowledge column
// DEFAULT for brand-new rows, see database/init.ts) added to the growth
// bucket. It was previously in neither bucket here, so newly-created
// agents were silently skipped by every run of the hourly cron once the
// legacy pending_verify backlog drained — pickBatch (the non-biased
// picker) already includes 'unverified' via its blanket
// `NOT IN ('opt_out')` filter, so this just brings pickBatchBiased back
// in line with that existing, wider population.
//
// orch-pr-20260718-gate-integrity-slice3: the growth bucket used to be
// filled by a single query pooling all 4 growth statuses behind one
// `ORDER BY ..., COALESCE(last_verified_at, '1970-01-01') ASC` clause.
// Freshly-scraped `unverified` rows have `last_verified_at IS NULL`,
// which COALESCE maps to '1970-01-01' — sorting ahead of every row that
// already carries a real (even if very stale) timestamp. Since new
// `unverified` rows keep appearing continuously from scraping, they won
// every growth slot on every run and the `pending_verify` /
// `review_required` backlogs were never reached. Fixed by giving each of
// the 4 growth statuses its own quota (a near-equal split of
// `growthTarget`, remainder slots going to the priority order
// ['pending_verify', 'review_required', 'unverified', 'data_insufficient']
// so the starved backlog cohorts get first claim on any remainder), each
// queried independently with the SAME ORDER clause. If any status's own
// query comes up short (not enough rows in that cohort), the shortfall
// is backfilled from the combined 4-status pool, excluding ids already
// picked — mirroring the existing growth/verified cross-bucket backfill
// pattern below.
//   - all growth queries ordered HTTP-failed-first then oldest
//     last_verified_at first (matches pickBatch's existing front-bump
//     behaviour).
//
// Fall-back: if the growth or verified bucket (after its own internal
// backfill, for growth) returns fewer rows than its target, the deficit
// is filled from the OTHER bucket so the caller always gets up to
// `limit` candidates when any exist. This cross-bucket fall-back is
// UNCHANGED from before.
//
// opt_out agents are always excluded (matches pickBatch).
export function pickBatchBiased(
  db: any,
  limit = 30,
  growthRatio = 0.7
): any[] {
  const growthTarget = Math.floor(limit * growthRatio);
  const verifiedTarget = limit - growthTarget;

  const SELECT_COLS = `SELECT a.id, a.name, a.url AS agent_url, a.city AS location_city, a.is_verified,
              k.email, k.phone, k.address,
              k.website, k.about, k.products, k.field_provenance,
              k.verification_status, k.enrichment_status,
              k.last_verified_at, k.last_http_check_at, k.last_http_status
         FROM agents a
   INNER JOIN agent_knowledge k ON k.agent_id = a.id`;

  // ── Round-robin ordering (dev-request 2026-08-10-verifier-portkjede-og-
  // provenansrydding, skive F — Daniel: «Unngå å kjøre gjennom de samme
  // agentene hver runde, kun prosesser hver agent en gang per runde, og
  // ikke på nytt»).
  //
  // The previous ORDER put `last_http_status >= 400` FIRST as an absolute
  // key, so the dead-website cohort occupied the head of every bucket's
  // queue on every single round. With this picker's per-status quota
  // (limit 40 → 7 pending_verify slots), a dead-URL cohort larger than the
  // quota meant healthy pending_verify agents were never reachable at all —
  // measured live 2026-08-10: 24 consecutive rounds moved pending_verify
  // only 1017→1015 while all 45 review_required rows were re-processed
  // ~3.5× each.
  //
  // `sweep_processed_at` (stamped on EVERY verifier write by
  // applyVerifierOutcome below, column added by orch-pr-87) is now the
  // PRIMARY key: never-swept agents (NULL → '1970-01-01') come first, and a
  // just-processed agent goes to the back of the queue. That is exactly
  // "each agent once per round, then the next round" — a full rotation is
  // guaranteed before any agent repeats. The dead-URL priority is preserved
  // as a TIE-BREAK among agents with equal sweep recency, so it still front-
  // loads broken sites within a round without being able to starve a round.
  const ORDER = `ORDER BY COALESCE(k.sweep_processed_at, '1970-01-01') ASC,
              CASE WHEN k.last_http_status >= 400 THEN 0 ELSE 1 END,
              COALESCE(k.last_verified_at, '1970-01-01') ASC`;

  // Priority order matters: statuses earlier in this list get the
  // "remainder" slots when growthTarget doesn't divide evenly by 4.
  // The backlog cohorts (pending_verify, review_required) get remainder
  // priority since they're the ones that were starved by the old
  // pooled-query behaviour.
  const GROWTH_STATUSES = ['pending_verify', 'review_required', 'unverified', 'data_insufficient'];

  const perStatusBase = Math.floor(growthTarget / GROWTH_STATUSES.length);
  const perStatusRemainder = growthTarget % GROWTH_STATUSES.length;

  const growthRows: any[] = [];
  const growthHaveIds = new Set<string>();
  GROWTH_STATUSES.forEach((status, idx) => {
    const quota = perStatusBase + (idx < perStatusRemainder ? 1 : 0);
    if (quota <= 0) return;
    const rows = db.prepare(
      `${SELECT_COLS}
        WHERE k.verification_status = ?
        ${ORDER}
        LIMIT ?`
    ).all(status, quota);
    for (const r of rows) {
      growthRows.push(r);
      growthHaveIds.add(r.id);
    }
  });

  // Per-status quotas can come up short (a cohort simply doesn't have
  // enough rows) — backfill the shortfall from the combined 4-status
  // pool, excluding ids already selected. Same backfill idiom as the
  // growth/verified cross-bucket fall-back further below: over-fetch to
  // (already-have + shortfall) = growthTarget, filter dupes, slice to
  // the shortfall.
  const growthQuotaShortfall = growthTarget - growthRows.length;
  if (growthQuotaShortfall > 0) {
    let growthBackfill = db.prepare(
      `${SELECT_COLS}
        WHERE k.verification_status IN ('pending_verify', 'review_required', 'unverified', 'data_insufficient')
        ${ORDER}
        LIMIT ?`
    ).all(growthTarget);
    growthBackfill = growthBackfill
      .filter((r: any) => !growthHaveIds.has(r.id))
      .slice(0, growthQuotaShortfall);
    for (const r of growthBackfill) {
      growthRows.push(r);
      growthHaveIds.add(r.id);
    }
  }

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
        WHERE k.verification_status IN ('unverified', 'pending_verify', 'review_required', 'data_insufficient')
        ${ORDER}
        LIMIT ?`
    ).all(growthTarget + verifiedDeficit);
    extraGrowth = extraGrowth.filter((r: any) => !growthHaveIds.has(r.id)).slice(0, verifiedDeficit);
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
    // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel
    // (guardrail b): when set, permanently stamps this agent as having
    // been verified via the SECOND (lower-bar) line rather than the first
    // — see the dedicated best-effort write block below. Omitted (or
    // false) on every call from the flag-off / first-line-only path, so
    // those columns are simply never touched then.
    verified_second_line?: boolean;
    second_line_sources?: string[];
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

  // dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction
  // (item 6 follow-up): pending_verify no-progress parking. Runs
  // unconditionally, for every outcome (not just pending_verify->pending_verify)
  // — real progress (any OTHER new_verification_status) must fully reset the
  // counters, mirroring recordHomepageFetchFailure's reset-on-success branch
  // in marketplace.ts. Best-effort — same as the sweep_processed_at block
  // above, the columns may be absent in minimal test-harness schemas that
  // build agent_knowledge without running full init().
  try {
    if (outcome.new_verification_status === "pending_verify") {
      db.prepare(
        `UPDATE agent_knowledge SET pending_verify_no_progress_count = pending_verify_no_progress_count + 1 WHERE agent_id = ?`
      ).run(agentId);
      // Stamp when not yet parked — or RE-STAMP when the 30-day backoff has
      // already expired and the re-probe still made no progress. Without
      // the re-stamp, the stale timestamp keeps satisfying the exclusion
      // clause's `<= now-30d` forever, so a still-unresolvable agent would
      // revert to being selected every sweep after its first backoff cycle
      // (the exact PR #248 review blocker in the homepage-parking
      // precedent — must not repeat it here).
      //
      // The eligibility check itself is done entirely in SQL (no JS
      // Date.parse/Date.now() round-trip): a JS-side re-read-then-compare
      // of the SQL-native "YYYY-MM-DD HH:MM:SS" (no timezone marker)
      // string is interpreted as LOCAL time by Date.parse per ECMA-262,
      // while the write side (datetime('now')) and pickPendingVerifyBatch's
      // read side (datetime('now','-30 days')) are both UTC-native — under
      // a UTC-behind timezone that JS-side comparison could judge a
      // SQL-already-expired row as "not yet expired" and silently skip the
      // re-stamp. Keeping the whole comparison SQL-native (matching
      // stampParking() in admin-domain-coherence.ts) avoids the mismatch.
      db.prepare(
        `UPDATE agent_knowledge
            SET pending_verify_parked_since = datetime('now')
          WHERE agent_id = ?
            AND pending_verify_no_progress_count >= 3
            AND (pending_verify_parked_since IS NULL OR pending_verify_parked_since <= datetime('now','-30 days'))`
      ).run(agentId);
    } else {
      db.prepare(
        `UPDATE agent_knowledge SET pending_verify_no_progress_count = 0, pending_verify_parked_since = NULL WHERE agent_id = ?`
      ).run(agentId);
    }
  } catch {
    // pending_verify parking columns not present in this DB — skip.
  }

  // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel
  // (guardrail b): permanent second-line provenance stamp. Only ever SETS
  // the columns (never resets them back to 0/NULL) — the marker's whole
  // purpose is to stay "permanently distinguishable from first-line
  // verified agents" even if a later run also clears first-line on its own
  // merits, so Daniel's manual-sampling process (guardrail c) can always
  // find every agent that was EVER promoted via the lower-bar line.
  // Best-effort / try-catch, same convention as the two blocks above — the
  // columns are added by an idempotent ALTER (src/database/init.ts) and
  // may be absent in minimal test-harness schemas.
  if (outcome.verified_second_line) {
    try {
      db.prepare(
        `UPDATE agent_knowledge SET
           verified_second_line       = 1,
           verified_second_line_at    = ?,
           verified_second_line_sources = ?
         WHERE agent_id = ?`
      ).run(
        outcome.runStartedAt,
        JSON.stringify(outcome.second_line_sources ?? []),
        agentId
      );
    } catch {
      // verified_second_line columns not present in this DB — skip.
    }
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
// dev-request 2026-08-23-terminal-unconfirmable: Brreg showing the business
// as deleted/bankrupt (brreg_konkurs) or inactive (brreg_inactive) is a
// PERMANENT, structural disqualifier — the second-line gate further down
// this file computes `nace_brreg_ok = gate_reasons.no_wrong_fit &&
// gate_reasons.brreg_active`, so a brreg_active:false agent can never pass
// the second line either (deterministicOk is always false there). It is
// therefore safe to terminal-mark such an agent immediately rather than
// leaving it to loop in review_required forever. Gated behind
// RFB_TERMINAL_UNCONFIRMABLE_ENABLED, read at call time (same "no restart
// needed" idiom as RFB_SECOND_LINE_VERIFICATION_ENABLED /
// PENDING_VERIFY_PARKING_DISABLED elsewhere in this file) — when the flag
// is not exactly "true", this branch never fires and behaviour is byte-
// identical to before. The nace_blacklist-only case (no brreg flag) is
// COMPLETELY UNCHANGED by this — still review_required, flag on or off.
//
// Pure function.
export function deriveVerificationStatus(
  passes: boolean,
  flags: string[],
  cross_source_verdict?: CrossSourceVerdict | boolean
):
  | "verified"
  | "review_required"
  | "pending_verify"
  | "data_insufficient"
  | "paraply_epost_mangler"
  | "terminal_unconfirmable" {
  if (!passes) {
    // Basic gate failed — reviewable if NACE/Brreg issues, otherwise retry
    const brregDead = flags.includes("brreg_konkurs") || flags.includes("brreg_inactive");
    if (brregDead && process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED === "true") {
      // Brreg-dead wins regardless of whether a nace_blacklist flag is ALSO
      // present — permanent disqualifier either way.
      return "terminal_unconfirmable";
    }
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

// ═══════════════════════════════════════════════════════════════════════
// ─── RFB second verification line (dev-request 2026-08-23-rfb-andrelinje-
//     verifisering-lav-terskel, Fase-1 items 1+2) ─────────────────────────
//
// A second, LOWER-BAR verification line, attempted ONLY when the first
// line (computeKvalitetsGate above) did NOT pass — i.e. only for producers
// who would otherwise land in pending_verify/review_required/
// data_insufficient. It exists so a producer with no live website — but a
// plausible own-domain-or-free-mail email plus at least one corroborating
// identity source — can still be verified and contacted. First-line logic,
// thresholds and behaviour are UNTOUCHED by any of this: everything below
// is a strictly ADDITIVE overlay, gated end-to-end behind the
// RFB_SECOND_LINE_VERIFICATION_ENABLED env flag (read at call time in
// runVerifierBatch — see the flag-off byte-identical contract there).
//
// Guardrail (f) — NACE-blacklist / Brreg-deleted-or-bankrupt disqualifies
// on BOTH lines, no exceptions: this is enforced by REUSING
// computeKvalitetsGate's own `gate.reasons.no_wrong_fit` /
// `gate.reasons.brreg_active` (computed once per agent either way) — never
// re-implemented here. See computeSecondLineVerification below.

/**
 * Curated umbrella/trade-association email-routing domains for RFB
 * producers (dev-request item 2, "paraply-routing"). Deliberately a
 * CURATED subset — not every KNOWN_DIRECTORY_HOSTS entry (cross-source-
 * validator.ts) is a membership/trade organisation in this sense (e.g.
 * facebook.com/tripadvisor.com are generic listing platforms, never a
 * producer's own parent org) — chosen from the RFB-relevant subset of that
 * same curated list (market-network / trade-body hosts already referenced
 * there), mirroring the sibling opplevagent-side precedent for this exact
 * policy (src/services/experience-store.ts's UMBRELLA_EMAIL_DOMAINS /
 * isUmbrellaContactEmail, "e-post til DEM, aldri til paraplyen").
 *
 * KNOWN LIMITATION (documented per the dev-request's own instruction): this
 * static list is a narrow, explicit fallback for producers with no
 * `agent_affiliations` row yet. The PRIMARY signal is schema-based — see
 * isParaplyRoutedEmail's `affiliatedUmbrellaDomains` parameter, populated
 * in runVerifierBatch from an active agent_affiliations link to an
 * umbrella agent's own domain (a genuine per-agent "this email belongs to
 * an umbrella" signal already in the schema, not invented here). This
 * static list is defence-in-depth for the (likely common, today) case
 * where no affiliation row exists yet. A future slice could grow this list
 * from confirmed incidents the way experience-store.ts's sibling list
 * documents each entry's evidence — left minimal here per the spec's
 * explicit "narrowest possible check" instruction.
 */
export const RFB_PARAPLY_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "hanen.no",
  "bondensmarked.no",
  "bondensmarkedtroms.no",
  "bondesmarked.no",
  "rekonorge.no",
  "rekoring.no",
  "reko.no",
  "mathallenoslo.no",
]);

/**
 * True when `email`'s registrable domain is a known umbrella/trade-
 * association inbox — either the curated static fallback
 * (RFB_PARAPLY_EMAIL_DOMAINS) or one of `affiliatedUmbrellaDomains` (the
 * schema-based signal: domains of umbrella agents this producer has an
 * ACTIVE agent_affiliations link to, resolved by the caller). A blank/
 * malformed email is never "paraply" (it simply is not an address — that
 * is the junk-email backstop's job, not this one's).
 */
export function isParaplyRoutedEmail(
  email: string | null | undefined,
  affiliatedUmbrellaDomains: readonly string[] = []
): boolean {
  const dom = emailDomain(email ?? null);
  if (!dom) return false;
  const matchesSet = (set: Iterable<string>) =>
    Array.from(set).some((u) => dom === u || dom.endsWith(`.${u}`));
  if (matchesSet(RFB_PARAPLY_EMAIL_DOMAINS)) return true;
  return matchesSet(affiliatedUmbrellaDomains.filter((d): d is string => !!d));
}

/**
 * getAffiliatedUmbrellaDomains — the SCHEMA-BASED half of item 2's paraply
 * signal: registrable domains of every umbrella agent this producer has an
 * ACTIVE agent_affiliations link to (Phase 5.11's producer↔umbrella model —
 * see database/init.ts's "Umbrella agents schema" migration). Resolved via
 * the umbrella agent's OWN `agents.url` — its own homepage/contact domain —
 * the same host-extraction helpers (hostFromUrlLike/registrableDomain)
 * domain-coherence already uses elsewhere in this file. Only ever called
 * when the second line is enabled (see the flag-off byte-identical
 * contract on runVerifierBatch); a throwing/missing table is swallowed so a
 * DB without Phase 5.11's schema degrades to "no affiliation-based
 * domains" rather than failing the whole verifier run.
 */
export function getAffiliatedUmbrellaDomains(db: any, producerId: string): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT au.url AS umbrella_url
           FROM agent_affiliations aff
           JOIN agents au ON au.id = aff.umbrella_id
          WHERE aff.producer_id = ?
            AND aff.status = 'active'`
      )
      .all(producerId) as Array<{ umbrella_url: string | null }>;
    const domains = new Set<string>();
    for (const r of rows) {
      if (!r.umbrella_url) continue;
      const host = hostFromUrlLike(r.umbrella_url);
      const root = host ? registrableDomain(host) : null;
      if (root) domains.add(root);
    }
    return Array.from(domains);
  } catch {
    return [];
  }
}

/**
 * computeSecondLineIdentitySources — requirement 3: at least one ACCEPTED
 * identity source must fire for the second line to even be attempted.
 * Deterministic, pure. Sources recognised:
 *   - own_website        : gate.reasons.website_ok was true (a live site
 *                          exists — just not enough on its own to clear
 *                          first line, e.g. thin content or a cross-source
 *                          miss).
 *   - facebook_official_page : any field_provenance record carries
 *                          source_type === "facebook_official_page" (the
 *                          same Tier-B source_type TIER_B/init.ts's PR23
 *                          backfill already write — see database/init.ts
 *                          ~L2333-2432).
 *   - hanen_no / bondensmarked_no / 1881_no / siderklynga_no : any
 *                          field_provenance record's source_url resolves
 *                          (via the SAME hostFromUrlLike/registrableDomain
 *                          helpers domain-coherence already uses) to
 *                          hanen.no / bondensmarked.no / 1881.no /
 *                          siderklynga.no — independent of whatever
 *                          source_type string was used to write it.
 *   - brreg_name_match    : brreg.navn (Brreg's registered name) scores
 *                          ≥0.80 against the producer's platform name via
 *                          brreg-client.ts's existing scoreNameMatch
 *                          (first-token match, reused not re-implemented).
 *
 * The "≥2 signals (name+place OR name+org-nr)" strength requirement for
 * whichever source fires is a JUDGMENT call, not a regex — deliberately
 * left to judgeSecondLineProfile's explicit identity-reasoning rubric
 * (see that module's prompt) rather than hand-rolled here, for the same
 * reason contact-candidate-judge.ts leaves "is this really evidence for
 * THIS entity" to the LLM: a deterministic version would just be
 * regex-testing for a city-name substring, which is exactly the
 * generic/wrong-entity trap the whole-profile judge exists to catch.
 */
// dev-request 2026-08-29-gs-second-line-kildeklasse-bredde (Del B): the
// gardssalg-set-contact-email/-phone admin routes store their caller-supplied
// `source` string VERBATIM into field_provenance.*.source_url — that field's
// own contract is documented free-text, "not necessarily a URL" (e.g. a
// session writes "session-kildebredde-2026-08-29 · https://www.1881.no/xyz").
// hostFromUrlLike() (cross-source-validator.ts) expects a value that already
// IS a bare host/URL and does not hunt for one embedded in a longer string,
// so such records never matched below. Deliberately a LOCAL helper here
// rather than widening hostFromUrlLike's own parsing contract — that helper
// has ~15 other call sites (domain-coherence, umbrella matching, ...) that
// already pass it clean URLs, so changing what it accepts is a much bigger
// regression surface than this slice needs (mirrors the existing narrow-fix-
// over-shared-helper pattern already used elsewhere in this codebase).
// Fallback is exactly today's behavior: no embedded URL found -> return the
// input unchanged, so hostFromUrlLike either parses it as-is (already-clean
// URL/host strings) or fails to resolve a host the same way it does today.
function extractUrlFromFreeText(raw: string): string {
  const match = raw.match(/https?:\/\/\S+/i);
  return match ? match[0] : raw;
}

export function computeSecondLineIdentitySources(input: {
  website_ok: boolean;
  field_provenance: Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown>;
  brreg: BrregLookupResult | null;
  producer_name: string | null;
}): string[] {
  const sources = new Set<string>();
  if (input.website_ok) sources.add("own_website");

  let coerced: Record<string, ProvenanceRecord[]> = {};
  try {
    coerced = coerceProvenanceToArrayShape(input.field_provenance as Record<string, unknown>);
  } catch {
    coerced = {};
  }
  for (const field of Object.keys(coerced)) {
    for (const rec of coerced[field] ?? []) {
      const r = rec as Partial<ProvenanceRecord> | null | undefined;
      if (!r || typeof r !== "object") continue;
      if (r.source_type === "facebook_official_page") sources.add("facebook_official_page");
      if (typeof r.source_url === "string" && r.source_url) {
        const host = hostFromUrlLike(extractUrlFromFreeText(r.source_url));
        const root = host ? registrableDomain(host) : null;
        if (root === "hanen.no") sources.add("hanen_no");
        if (root === "bondensmarked.no") sources.add("bondensmarked_no");
        // dev-request 2026-08-28-gardssalg-kildebredde-wiring (Grep 2 gap found
        // 2026-08-29, post-lokal#740): the spec's own AC2 names "1881-oppføring
        // m/org.nr" and bransjelister as accepted identity sources, but only
        // hanen.no/bondensmarked.no were ever wired here. Additive — same
        // registrable-domain-match pattern as the two lines above.
        if (root === "1881.no") sources.add("1881_no");
        if (root === "siderklynga.no") sources.add("siderklynga_no");
      }
    }
  }

  if (input.brreg?.navn && input.producer_name) {
    const score = scoreNameMatch(input.producer_name, input.brreg.navn, null, null);
    if (score >= 0.8) sources.add("brreg_name_match");
  }

  return Array.from(sources);
}

export interface SecondLineGateResult {
  passes: boolean;
  reasons: {
    nace_brreg_ok: boolean;
    email_present: boolean;
    email_not_junk: boolean;
    email_not_paraply: boolean;
    has_accepted_source: boolean;
    judge_approved: boolean;
  };
  sources: string[];
  judge_reason?: string;
}

/**
 * computeSecondLineVerification — the composed second-line gate. ALL of
 * the following must hold for `passes: true`:
 *   (f) gate_reasons.no_wrong_fit && gate_reasons.brreg_active — REUSED
 *       verbatim from computeKvalitetsGate's own output, never
 *       re-implemented (requirement f, binding).
 *   1. an email is present, is not junk (classifyContactCandidateDefect,
 *      reused from contact-candidate-judge.ts) and is not paraply-routed
 *      (item 2 — a paraply email can NEVER pass the second line either).
 *   3. computeSecondLineIdentitySources(...) returns ≥1 accepted source.
 *   2. judgeSecondLineProfile approves (whole-profile identity reasoning;
 *      fail-closed — see that module's own contract). The judge is ONLY
 *      ever called once the three deterministic checks above already
 *      hold, mirroring gateContactCandidates' "cheap backstop first, LLM
 *      only if it could still matter" cost-control ordering.
 *
 * `judgeFn` is injectable purely for test isolation (mirrors
 * runVerifierBatch's own opts.headProbe/opts.brregLookup injection
 * pattern) — defaults to the real judgeSecondLineProfile.
 */
export async function computeSecondLineVerification(input: {
  producer_name: string | null;
  city: string | null;
  about: string | null;
  products: unknown[];
  email: string | null;
  field_provenance: Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown>;
  brreg: BrregLookupResult | null;
  gate_reasons: { website_ok: boolean; no_wrong_fit: boolean; brreg_active: boolean };
  affiliated_umbrella_domains?: readonly string[];
  judgeFn?: (params: {
    businessName: string;
    city: string | null;
    about: string | null;
    products: unknown[];
    email: string;
    acceptedSources: readonly string[];
    brregName?: string | null;
  }) => Promise<SecondLineProfileJudgeVerdict>;
}): Promise<SecondLineGateResult> {
  const nace_brreg_ok = input.gate_reasons.no_wrong_fit && input.gate_reasons.brreg_active;

  const email = (input.email ?? "").trim() || null;
  const email_present = !!email;
  const email_not_junk = email_present && !classifyContactCandidateDefect("email", email!).defective;
  const email_not_paraply = email_present && !isParaplyRoutedEmail(email, input.affiliated_umbrella_domains ?? []);

  const sources = computeSecondLineIdentitySources({
    website_ok: input.gate_reasons.website_ok,
    field_provenance: input.field_provenance,
    brreg: input.brreg,
    producer_name: input.producer_name,
  });
  const has_accepted_source = sources.length > 0;

  const deterministicOk = nace_brreg_ok && email_present && email_not_junk && email_not_paraply && has_accepted_source;

  let judge_approved = false;
  let judge_reason: string | undefined;
  if (deterministicOk) {
    const judgeFn = input.judgeFn ?? judgeSecondLineProfile;
    const verdict = await judgeFn({
      businessName: input.producer_name || "Ukjent produsent",
      city: input.city,
      about: input.about,
      products: input.products,
      email: email!,
      acceptedSources: sources,
      brregName: input.brreg?.navn ?? null,
    });
    judge_approved = verdict.approved;
    judge_reason = verdict.reason;
  }

  return {
    passes: deterministicOk && judge_approved,
    reasons: { nace_brreg_ok, email_present, email_not_junk, email_not_paraply, has_accepted_source, judge_approved },
    sources,
    judge_reason,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ─── dev-request 2026-08-25-terminal-sweep-false-positives ──────────────
//
// Fixes a measured false-positive in the RFB second verification line's
// terminal-unconfirmable branch below: the ORIGINAL version terminal-marked
// an agent the moment the second line found ZERO identity sources — i.e. on
// the ABSENCE of data alone, never any fresh positive evidence (`brreg` in
// this whole file always comes from opts.brregLookup, which no production
// caller wires up — see the second-line branch's own comment below). A
// 10-row random production sample of already-terminal_unconfirmable rows
// found 7/10 were demonstrably live, active businesses whose anchor fields
// simply hadn't been enriched yet — exactly the thin-profile cohort
// admin-rfb-brreg-selfsufficiency.ts's self-supply engine exists to enrich,
// killed before it ever got the chance to run.
//
// The two helpers below replace that single "no sources -> terminal" test
// with a requirement for POSITIVE evidence, gathered FRESH at sweep time,
// via one of two independent routes — see the terminal branch in
// runVerifierBatch for how they're combined and the invariant they jointly
// enforce ("no confident evidence either way -> stays pending_verify,
// never terminal").
// ═══════════════════════════════════════════════════════════════════════

// A tiny, unambiguous set of Norwegian public-space words. Only ever
// consulted as the LAST token of a TWO-token name (see
// looksLikeNonProducerEntity below) — narrow on purpose: a longer name
// ending in one of these (e.g. "Nordbys Gårdsutsalg på Torget") very
// plausibly IS a producer, so it's deliberately left alone.
//
// NOTE: "plass"/"plassen" deliberately excluded (2026-08-25 review fix).
// Unlike "torg(et)", "plass" is an extremely common, centuries-old suffix
// for a smallholding/croft (a husmannsplass — e.g. "Kalvatveit Plass",
// "Myra Plass", "Nordre Plass"), not a public square. A real, currently-
// operating farm with exactly that two-token name and a thin profile would
// otherwise wrongly match this pattern and go straight to
// terminal_unconfirmable with zero Brreg evidence check — precisely the
// false-positive this dev-request exists to prevent.
const NON_PRODUCER_PLACE_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  "torg", "torget",
]);

// Curated, individually-evidenced denylist of specific names that read as a
// producer name but are structurally not a company at all. Deliberately
// tiny and append-only-with-evidence — mirrors the same curated-list
// precedent as RFB_PARAPLY_EMAIL_DOMAINS above (a short, explicit list
// beats a broad guess for exactly the false-positive-averse reason this
// dev-request exists). Matched against the FULL normalised name, never a
// substring, so it can never fire on an unrelated real producer whose name
// happens to contain one of these words.
const NON_PRODUCER_CURATED_NAMES: ReadonlySet<string> = new Set([
  // "Ringerikserter" — a Beskyttet betegnelse (Norwegian protected
  // geographical/product designation) for a pea variety historically grown
  // around Ringerike by MANY unrelated producers; it names the product/
  // designation, not any single company. Measured in the dev-request's own
  // 10-row production sample (2026-08-25).
  "ringerikserter",
]);

/**
 * looksLikeNonProducerEntity(name) — a TIGHT, explicit pattern/heuristic
 * check (per the dev-request's own instruction: prefer this over a new LLM
 * judge for this narrow slice) identifying producer names that are
 * structurally never going to be a company at all — a REKO-ring
 * distribution point, a public square, or a specific curated protected
 * designation — as distinct from a real producer whose Brreg record simply
 * isn't found by this run's fresh lookup. Deliberately conservative: false
 * positives HERE are exactly the bug this dev-request exists to fix, so
 * every rule below only fires on strong, named-pattern evidence and is
 * documented with why it can't reasonably catch a real producer. Pure —
 * exported for tests.
 *
 *   1. REKO-ring distribution point: the name's FIRST token (after
 *      diacritic/case normalisation) is exactly "reko". REKO-ring pickup
 *      points are conventionally named "REKO <sted>" (e.g. "REKO Grorud")
 *      — this codebase already treats the bare word "reko" as a non-
 *      personal/business token for the same reason (see
 *      admin-rfb-brreg-selfsufficiency.ts's RFB_BSS_PERSONAL_NAME_BLOCK_WORDS
 *      and RFB_PARAPLY_EMAIL_DOMAINS's reko.no/rekoring.no/rekonorge.no
 *      above) — a real producer's own name essentially never OPENS with
 *      that exact token.
 *   2. Public square/place: the name is EXACTLY two tokens and the second
 *      is one of NON_PRODUCER_PLACE_SUFFIX_WORDS (e.g. "Adamstuen Torg").
 *      Restricted to exactly two tokens so a longer, clearly-a-business
 *      name that happens to end in "torget" is never caught. Deliberately
 *      excludes "plass"/"plassen" — see that list's own comment.
 *   3. NON_PRODUCER_CURATED_NAMES — see that list's own comment.
 */
export function looksLikeNonProducerEntity(name: string | null | undefined): {
  match: boolean;
  pattern: "reko_distribution_point" | "public_place_name" | "curated_designation" | null;
} {
  const trimmed = (name || "").trim();
  if (!trimmed) return { match: false, pattern: null };

  const normalized = normaliseName(trimmed);
  if (NON_PRODUCER_CURATED_NAMES.has(normalized)) {
    return { match: true, pattern: "curated_designation" };
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { match: false, pattern: null };

  if (tokens[0] === "reko") return { match: true, pattern: "reko_distribution_point" };

  if (tokens.length === 2 && NON_PRODUCER_PLACE_SUFFIX_WORDS.has(tokens[1])) {
    return { match: true, pattern: "public_place_name" };
  }

  return { match: false, pattern: null };
}

/**
 * checkFreshBrregDeathEvidence — attempts a FRESH Brreg name-search at
 * sweep time (never relying on `brreg`/opts.brregLookup elsewhere in this
 * file, which is always null in production — see the dev-request comment
 * above) using the SAME search-attempt waterfall SHAPE
 * admin-rfb-brreg-selfsufficiency.ts's resolveOrgNrForTarget already uses
 * for org-nr backfill: base name (parseNameLocationSuffix's core_name, same
 * strip-the-"— Sted"-suffix step that function applies), then a
 * domain-token attempt (pickDomainSourceForTarget + domainTokenCandidateName
 * off the agent's own website/url, when it has one), then a personal-name-
 * ENK attempt (looksLikePersonalName) — each via findOrgnumberByName,
 * stopping at the FIRST attempt that returns ANY hit (findOrgnumberByName
 * itself already enforces a >=0.9 confidence floor — 1.0 exact or 0.95
 * first-token+postal — before returning non-null, so "any hit" already
 * means "confident match").
 *
 * Unlike resolveOrgNrForTarget, a hit here does NOT stop at "found a
 * candidate" — this function's whole point is asking "is this business
 * dead", so the hit's org-nr is immediately re-verified DIRECTLY via
 * verifyOrgNumber (a separate, non-fuzzy GET /enheter/{orgNr} lookup) and
 * only a dissolved/bankrupt result counts as evidence. A hit that turns out
 * to be alive is itself a meaningful, terminal-BLOCKING answer (this is the
 * "Aalan Gård turned out to have an active Brreg entity" case from the
 * dev-request's own sample) — never treated as "try the next attempt".
 *
 * No postal-code filter is applied to the fresh search: runVerifierBatch's
 * agent rows carry a free-text city, not a postal code, and
 * findOrgnumberByName's own scoreNameMatch only USES a postal code when one
 * is supplied — omitting it can only ever raise the confidence bar (an
 * exact-normalised-name match is required, since the 0.95 first-token+
 * postal tier becomes unreachable), never lower it into a false positive.
 * Documented per the spec's own "you do not need a separate hard filter
 * unless clearly required for precision" guidance.
 *
 * Returns "brreg_konkurs" (Brreg's `konkurs` flag) / "brreg_inactive"
 * (Brreg's `slettedato` flag) ONLY when a confident hit's direct
 * verifyOrgNumber() result is dissolved/bankrupt. Returns null for every
 * other outcome — no hit found by ANY attempt, a hit found but the entity
 * is still active/exists, or a network/parse failure (findOrgnumberByName /
 * verifyOrgNumber both already fail closed to their own safe defaults, and
 * are additionally wrapped here) — because absence of evidence is never
 * grounds for a terminal mark; that is the core invariant this dev-request
 * exists to enforce.
 */
export async function checkFreshBrregDeathEvidence(
  input: { producer_name: string | null; website: string | null; url: string | null },
  fetchImpl: typeof fetch,
): Promise<"brreg_konkurs" | "brreg_inactive" | null> {
  const rawName = (input.producer_name || "").trim();
  if (!rawName) return null;

  const { core_name } = parseNameLocationSuffix(rawName);
  const baseName = core_name || rawName;

  const searchNames: string[] = [baseName];

  const domainSource = pickDomainSourceForTarget({ website: input.website, url: input.url });
  const domainToken = domainSource ? domainTokenCandidateName(domainSource) : null;
  if (domainToken) searchNames.push(domainToken);

  if (looksLikePersonalName(baseName)) searchNames.push(`${baseName} ENK`);

  let hit: BrregHit | null = null;
  for (const searchName of searchNames) {
    hit = await findOrgnumberByName(searchName, null, fetchImpl).catch(() => null);
    if (hit) break;
  }
  if (!hit) return null;

  const verified = await verifyOrgNumber(hit.orgnumber, fetchImpl).catch(() => null);
  if (!verified || !verified.exists || verified.active) return null;

  if (verified.flag === "bankrupt") return "brreg_konkurs";
  if (verified.flag === "dissolved") return "brreg_inactive";
  return null;
}

/**
 * resolveBrregLookup — the real BrregFn implementation for runVerifierBatch's
 * opts.brregLookup (dev-request 2026-09-01-rfb-verifier-brreglookup-aldri-koblet:
 * no production caller ever wired this in, so `brreg` was always null and
 * brreg_name_match could never fire — see that dev-request for the full
 * incident). Mirrors checkFreshBrregDeathEvidence's own search-then-verify
 * shape: a name search via findOrgnumberByName (no postal code — this file's
 * callers only ever have a free-text city, same rationale as
 * checkFreshBrregDeathEvidence documents for itself above), then a direct
 * verifyOrgNumber on the hit's org-nr. Never throws (wrapped in try/catch);
 * any error, missing hit, or exists:false result falls back to null — i.e.
 * at least as safe as the old hardcoded null this replaces.
 *
 * Ambiguity guard (CHANGES-REQUESTED finding 1, PR #758): findOrgnumberByName's
 * own doc comment (brreg-client.ts, BrregHit.exact_ties) requires a caller
 * writing identity keys to treat `exact_ties > 1` as ambiguous and refuse to
 * auto-write — e.g. "SOLBAKKEN GARD" (ENK) vs "SOLBAKKEN GARD AS" both score
 * 1.0 exact-match, and blindly trusting `hit` in that case can resolve to the
 * WRONG entity (a dissolved ENK when the live AS was meant, or vice versa).
 * Since this result feeds computeKvalitetsGate's brreg_konkurs/brreg_inactive
 * permanent disqualifier, an ambiguous hit is treated as no confident match
 * at all — verifyOrgNumber is never called on it.
 */
export async function resolveBrregLookup(
  name: string,
  _city: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<BrregLookupResult | null> {
  try {
    const hit = await findOrgnumberByName(name, null, fetchImpl).catch(() => null);
    if (!hit) return null;
    if (hit.exact_ties && hit.exact_ties > 1) return null;
    const verified = await verifyOrgNumber(hit.orgnumber, fetchImpl).catch(() => null);
    if (!verified || !verified.exists) return null;
    return {
      is_active: verified.active,
      is_konkurs: verified.flag === "bankrupt",
      naering: verified.nace[0] ?? null,
      navn: verified.name,
    };
  } catch {
    return null;
  }
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
  // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel: test
  // seam ONLY — lets tests inject a mock judge without a real
  // ANTHROPIC_API_KEY / network call. Never used in production (production
  // always uses the real judgeSecondLineProfile).
  secondLineJudgeFn?: Parameters<typeof computeSecondLineVerification>[0]["judgeFn"];
  // dev-request 2026-08-25-terminal-sweep-false-positives: test seam ONLY —
  // the injectable-fetch impl threaded into checkFreshBrregDeathEvidence's
  // findOrgnumberByName/verifyOrgNumber calls (mirrors
  // __setRfbBrregSelfSufficiencyFetchForTesting's role for the sibling
  // route this reuses search-attempt logic from). Defaults to the real
  // global `fetch` — production always hits the live Brreg API.
  terminalDeathCheckFetch?: typeof fetch;
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

  // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel: default
  // OFF, read from process.env AT CALL TIME (mirrors the existing
  // DOMAIN_RECONCILIATION_PARKING_DISABLED / PENDING_VERIFY_PARKING_DISABLED
  // idiom in this same file — toggling never needs a restart). When this is
  // NOT exactly "true", the entire second-line + paraply-routing block
  // below is skipped in full for every agent: no extra judge calls, no
  // extra DB reads/writes, no change whatsoever to `newVerification` beyond
  // what first-line + the existing guards already compute — i.e. BYTE-
  // IDENTICAL to pre-this-PR behaviour.
  const secondLineEnabled = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED === "true";

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
      { fieldProvenance: fieldProv, knowledgePhone: agent.phone, knowledgeAddress: agent.address },
    );
    let newVerification = deriveVerificationStatus(gate.passes, gate.flags, agentVerdict);
    if (newVerification === "terminal_unconfirmable") {
      // dev-request 2026-08-23-terminal-unconfirmable: stamp WHY into the
      // persisted cross_source_reason JSON (mirrors how other flag-based
      // markers like paraply_epost_mangler are added to crossSourceResults
      // at the call site rather than inside the pure deriveVerificationStatus).
      // computeKvalitetsGate only ever sets one of these two flags
      // (is_konkurs checked before is_active — see the brreg block above),
      // so a simple includes() check is unambiguous here.
      (crossSourceResults as Record<string, unknown>).terminal_reason = gate.flags.includes("brreg_konkurs")
        ? "brreg_konkurs"
        : "brreg_inactive";
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) terminal_unconfirmable (${(crossSourceResults as Record<string, unknown>).terminal_reason}) — removed from hourly sweep`,
      );
    }
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

    // ── Guard #3 (verifier side): free-mail ownership provenance ──────────────
    // dev-request 2026-07-15-gate-integrity-unverified-agent-bypass, slice 2.
    // computeKvalitetsGate's email_own_domain exemption treats ANY free-mail/
    // ISP address (gmail.com, online.no, …) as automatically "the producer's
    // own email" with zero evidence required — that exemption is intentional
    // and UNCHANGED (small Norwegian producers commonly use a personal
    // mailbox), but it means a wrong-entity free-mail address needs no
    // evidence at all to count as ownership. Real failure (2026-07-15): an
    // outreach email went to the wrong entity because a personal free-mail
    // address (norskott@online.no) had been attached to the wrong producer
    // ("Dalheim Gårdsysteri") during enrichment.
    //
    // Evidence (either is sufficient to clear the flag):
    //   A. field_provenance.email has a "homepage" source_type record whose
    //      value matches this exact email — the homepage-provenance crawl
    //      found the address published on the producer's own site (same
    //      crawl/source_type already used for website_ownership above).
    //   B. agents.is_verified = 1 — the producer went through the manual
    //      claim/verification flow (agent_claims); a human already proved
    //      ownership of this listing, independent of the crawl.
    //
    // Daniel's explicit, binding instruction (after seeing that a naive
    // "re-check agents.is_verified" fix would collapse the verified pool from
    // 487 to single digits): "we cannot reduce the verified/outreach pool, the
    // whole point is to GROW this pool." So — unlike websiteOwnershipUnverified
    // above, which downgrades an already-verified agent on every re-verify pass
    // — this check must NEVER downgrade an agent that is ALREADY `verified`
    // going into this run. It reuses `wasInPool` (just computed above) as the
    // monotonic guard: enforced (quarantine to review_required) only when
    // `!wasInPool`; report-only (counted, zero effect on the outcome) when
    // `wasInPool`.
    const emailDomainForOwnership = emailDomain(agent.email);
    const isFreeMailForOwnership = !!(emailDomainForOwnership && FREE_MAIL_DOMAINS.includes(emailDomainForOwnership));
    // review fix-up (2026-07-18): bind the homepage-evidence rescue to THIS
    // agent's own listing (agent.agent_url's host) — same append-only-
    // provenance staleness risk as slice 3b's domain-coherence rescue. A
    // stale homepage record proving ownership of a free-mail address for a
    // DIFFERENT agent_url must not count as ownership proof for this one.
    const agentUrlHost = agent.agent_url ? hostFromUrlLike(agent.agent_url) : null;
    const agentUrlRoot = agentUrlHost ? registrableDomain(agentUrlHost) : null;
    const emailHomepageEvidence = hasHomepageEvidence(fieldProv.email, agent.email, agentUrlRoot);
    const emailManuallyVerified = agent.is_verified === 1 || agent.is_verified === true;
    const emailOwnershipUnproven = isFreeMailForOwnership && !emailHomepageEvidence && !emailManuallyVerified;
    // ── REPORT-ONLY FOR EVERY AGENT (Daniel, 2026-08-10 — binding) ──────────
    //
    //   «gmail domener og forsåvidt hotmail og andre er ok å bruke. Vi sender
    //    ikke sensitiv data, men du skal ikke lage fiktive eposter.»
    //   (daniel-responses/2026-08-10-frimeil-policy-og-ingen-fiktive-eposter.md)
    //
    // The quarantine effect is retired; the SIGNAL is kept. Rationale, in the
    // words of the decision: a free-mail DOMAIN is a perfectly normal contact
    // address for a small Norwegian producer — many have no domain mailbox at
    // all — and outreach carries no sensitive data, so the domain alone must
    // never cost an agent its place in the pool. Measured 2026-08-10: 18 rows
    // were held out of the pool by this check alone.
    //
    // What this does NOT relax: the incident that motivated the guard
    // (norskott@online.no attached to the WRONG producer, "Dalheim Gårdsysteri")
    // was a wrong-ENTITY failure, not a free-mail failure. The defences against
    // that are untouched — domain coherence, cross-source agreement, the
    // website-ownership check, and `wrong_contact_rate` as a charter hard-block.
    // The anti-fabrication rule ("aldri konstruer en adresse") lives on the
    // WRITE side (enrichment SKILL §2E + the existing junk/placeholder gates),
    // which is where an invented address would have to be born.
    //
    // The flag, the console line and the envelope counter all stay, so a rise
    // in wrong contacts remains observable — this is a policy change about the
    // CONSEQUENCE, not a decision to stop looking.
    const emailOwnershipReportOnly = emailOwnershipUnproven;
    if (emailOwnershipUnproven) {
      (crossSourceResults as Record<string, unknown>).email_ownership_unproven = true;
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) free-mail email ownership unproven (no homepage evidence, agents.is_verified=${agent.is_verified ?? 0}) — report-only per Daniel 2026-08-10, outcome unchanged`,
      );
    }

    // ── Steg B (dev-request 2026-07-31-rfb-poolgate-uten-telefon-og-
    // batchkapasitet): new gating requirement replacing phone in
    // GATING_FIELDS (cross-source-validator.ts) — a corroborated contact
    // email + a fresh, live website.
    //
    // The "fresh, live website" half needs NO new code here: computeKvalitetsGate
    // (`gate`, above) already ANDs `website_ok` — THIS run's own live probe of
    // agent.website (httpStatus, 200-399) — into `gate.passes`, and
    // deriveVerificationStatus() only ever returns 'verified' when
    // `gate.passes` is true (see its `if (!passes) return ...` branch above).
    // So by the time `newVerification` can equal 'verified' below, a fresh
    // successful probe of THIS run is already guaranteed — re-gating on it
    // here would be dead code (a condition that can never be false in the
    // branch that matters). `gate.reasons.website_ok` is still surfaced in
    // the reported object below for review-queue transparency.
    //
    // What Steg B actually ADDS is the corroborated-email leg.
    //
    // FIX-UP (independent review, PR #524, 2026-08-07): the original slice
    // (commit 845f84d) read `agents.contact_email` here and checked it
    // against `field_provenance.contact_email_dns_check`. That is the WRONG
    // column for this gate. `outreach_ready_pool` (database/init.ts, `CREATE
    // VIEW outreach_ready_pool`) requires `k.email IS NOT NULL AND k.email
    // != ''` where `k` is `agent_knowledge` — and
    // `src/routes/admin-outreach-candidates.ts`, the actual outreach
    // candidate-export/send pipeline, selects and keys everything off
    // `agent_knowledge.email`/`ak.email` throughout, NEVER
    // `agents.contact_email`. Re-verified both independently while fixing
    // this. `agents.contact_email` and `agent_knowledge.email` are not
    // synced anywhere in this codebase (contact_email is a brand-new
    // column, written/DNS-checked only by admin-rfb-contact-extraction.ts /
    // admin-agents-contact-email-write.ts /
    // admin-agents-contact-email-dns-check.ts, all landed earlier the same
    // day as this slice; agent_knowledge.email is populated separately by
    // registration (admin-agents.ts) and the ongoing search-enrich-sweep
    // crawl (search-enrich-sweep.ts, source_type `web_search:<domain>`), and
    // has no DNS-liveness stamp of its own). So the original gate checked a
    // column outreach never reads, and risked wrongly demoting an
    // already-`verified` agent whose `agents.contact_email` happened to be
    // blank/DNS-dead while its real send-address, `agent_knowledge.email`
    // (`agent.email` here — same column Guard #3 / domain-coherence above
    // already use), was perfectly good. That's not a rare edge case: EVERY
    // agent enriched before A0/A2 shipped has a populated
    // agent_knowledge.email and a still-blank agents.contact_email.
    //
    // Corrected definition of "corroborated" for `agent_knowledge.email`,
    // chosen as the most honest option buildable from existing data with no
    // new schema:
    //   1. BASELINE — non-empty, `isSyntacticallyValidEmail`, and NOT
    //      `isPlatformOwnedEmailDomain` (the same two helpers
    //      admin-agents-contact-email-write.ts already exports and uses for
    //      `agents.contact_email` — reused here for this column instead of
    //      hand-rolling new ones). There is no DNS-liveness stamp for
    //      `agent_knowledge.email` today, so "corroborated" here honestly
    //      means "present and not obviously bogus" — we don't invent
    //      evidence we don't have.
    //   2. OPTIONAL DNS VETO, applied only on top of a baseline pass, never
    //      as a substitute for it — judgment call, documented here: DNS
    //      liveness is a DOMAIN-level fact (MX/A/AAAA resolution), it does
    //      not care which literal mailbox at that domain is being asked
    //      about. So when `agent_knowledge.email`'s domain happens to be the
    //      SAME domain as this agent's `agents.contact_email`, the A0 DNS
    //      stamp (field_provenance.contact_email_dns_check) genuinely IS
    //      evidence about `agent_knowledge.email` too, not only about
    //      contact_email — reusing it there is legitimate (a domain fact,
    //      not a mailbox-specific one), not overreaching. Only withdraw
    //      corroboration when the domains match AND the stamp's own
    //      `domain` field matches that same domain AND `live === false`
    //      (strict boolean check — missing/malformed shapes, or `live` as
    //      the string `"false"`, are ignored: this fails OPEN, exactly
    //      mirroring the original slice's dead-stamp parsing, just retargeted
    //      at the right domain comparison). Any other case (domains differ,
    //      no contact_email, stamp never written, or malformed) leaves the
    //      baseline result untouched.
    //
    // Mirrors the existing guards' pattern above: only downgrades an agent
    // that would otherwise be 'verified'; an already-worse status is left
    // alone. Deliberately NOT given the wasInPool monotonic exception Guard
    // #3 has — that exception was a specific, documented Daniel instruction
    // scoped to the free-mail-ownership check; this requirement applies
    // uniformly to every determination of 'verified'. Unlike the ORIGINAL
    // (buggy) version, this is now safe to apply uniformly: gating on the
    // correct column means an already-verified agent with a good
    // agent_knowledge.email is never wrongly caught by it.
    const knowledgeEmail = (agent.email as string | null | undefined) ?? null;
    const hasKnowledgeEmail = !!(knowledgeEmail && knowledgeEmail.trim());
    const knowledgeEmailSyntacticallyValid = hasKnowledgeEmail && isSyntacticallyValidEmail(knowledgeEmail!);
    const knowledgeEmailPlatformOwned = hasKnowledgeEmail && isPlatformOwnedEmailDomain(knowledgeEmail!);
    let corroboratedEmail = hasKnowledgeEmail && knowledgeEmailSyntacticallyValid && !knowledgeEmailPlatformOwned;

    let dnsDeadDomainVeto = false;
    if (corroboratedEmail) {
      const knowledgeEmailDomain = emailDomain(knowledgeEmail);
      const contactEmailRow = db
        .prepare(`SELECT contact_email FROM agents WHERE id = ?`)
        .get(agent.id) as { contact_email: string | null } | undefined;
      const contactEmailDomain = emailDomain(contactEmailRow?.contact_email ?? null);
      const dnsCheckRaw = (fieldProv as Record<string, unknown>)?.contact_email_dns_check;
      if (
        knowledgeEmailDomain &&
        contactEmailDomain &&
        knowledgeEmailDomain === contactEmailDomain &&
        dnsCheckRaw &&
        typeof dnsCheckRaw === "object"
      ) {
        const dc = dnsCheckRaw as { domain?: unknown; live?: unknown };
        if (typeof dc.domain === "string" && dc.domain === knowledgeEmailDomain && dc.live === false) {
          dnsDeadDomainVeto = true;
          corroboratedEmail = false;
        }
      }
    }

    (crossSourceResults as Record<string, unknown>).email_website_gate = {
      corroborated_email: corroboratedEmail,
      website_ok: gate.reasons.website_ok,
      email_present: hasKnowledgeEmail,
      email_syntactically_valid: knowledgeEmailSyntacticallyValid,
      email_platform_owned_domain: knowledgeEmailPlatformOwned,
      email_dns_dead_domain_veto: dnsDeadDomainVeto,
    };
    if (!corroboratedEmail) {
      if (newVerification === "verified") newVerification = "review_required";
      gate.flags.push("corroborated_email_missing");
      console.log(
        `[verifier] ${agent.id} (${agent.name ?? "?"}) corroborated_email_missing ` +
        `(agent_knowledge.email present=${hasKnowledgeEmail}, syntactically_valid=${knowledgeEmailSyntacticallyValid}, ` +
        `platform_owned=${knowledgeEmailPlatformOwned}, dns_dead_domain_veto=${dnsDeadDomainVeto}) — quarantined from pool`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── RFB second verification line + paraply-routing guard (dev-request
    //     2026-08-23-rfb-andrelinje-verifisering-lav-terskel, Fase-1 items
    //     1+2) — strictly ADDITIVE overlay on top of everything above.
    // Skipped in FULL — zero judge calls, zero extra DB reads/writes, zero
    // change to `newVerification` beyond what first-line + the existing
    // guards already computed — whenever RFB_SECOND_LINE_VERIFICATION_ENABLED
    // is not exactly "true". This is what makes flag-off behaviour byte-
    // identical to pre-this-PR runVerifierBatch.
    // ═══════════════════════════════════════════════════════════════════
    let verifiedSecondLine = false;
    let secondLineSources: string[] = [];
    if (secondLineEnabled) {
      const affiliatedUmbrellaDomains = getAffiliatedUmbrellaDomains(db, agent.id);

      // Item 1 — second line, only attempted when first line did NOT pass
      // (gate.passes === false — the exact trigger condition the spec
      // names; an agent that cleared computeKvalitetsGate but got
      // downgraded by a LATER guard above never reaches this branch).
      if (!gate.passes) {
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
          affiliated_umbrella_domains: affiliatedUmbrellaDomains,
          judgeFn: opts.secondLineJudgeFn,
        });
        (crossSourceResults as Record<string, unknown>).second_line = {
          attempted: true,
          passes: secondLine.passes,
          reasons: secondLine.reasons,
          sources: secondLine.sources,
          judge_reason: secondLine.judge_reason,
        };
        if (secondLine.passes) {
          verifiedSecondLine = true;
          secondLineSources = secondLine.sources;
          newVerification = "verified";
          console.log(
            `[verifier] ${agent.id} (${agent.name ?? "?"}) second-line verified (sources: ${secondLine.sources.join(", ") || "none"})`,
          );
        } else if (
          process.env.RFB_TERMINAL_UNCONFIRMABLE_ENABLED === "true" &&
          !secondLine.reasons.has_accepted_source &&
          newVerification === "pending_verify"
        ) {
          // dev-request 2026-08-25-terminal-sweep-false-positives: first
          // line found no flags at all (not brreg-dead, not nace-blacklist
          // — those are already handled by deriveVerificationStatus above
          // and never reach here as 'pending_verify') AND the second line
          // found ZERO identity sources across own-website/
          // facebook_official_page/hanen.no/bondensmarked.no/Brreg-name-
          // match. The ORIGINAL version of this branch terminal-marked
          // right here, on that absence of sources ALONE — a measured
          // production sample found 7/10 rows terminal-marked that way were
          // demonstrably live, active businesses whose anchor fields simply
          // hadn't been enriched yet ("no data" is not "proof of death").
          // This branch now requires FRESH, POSITIVE evidence before a
          // terminal mark — see checkFreshBrregDeathEvidence /
          // looksLikeNonProducerEntity's own doc comments above for the two
          // independent routes and why each is safe. Neither resolving
          // (no confident Brreg match found at all, or a match found but
          // still active/exists) leaves newVerification untouched at
          // 'pending_verify' — never terminal on absence of data alone.
          const nonProducer = looksLikeNonProducerEntity(agent.name);
          const terminalReason: "non_producer_entity" | "brreg_konkurs" | "brreg_inactive" | null =
            nonProducer.match
              ? "non_producer_entity"
              : await checkFreshBrregDeathEvidence(
                  { producer_name: agent.name ?? null, website: agent.website ?? null, url: agent.agent_url ?? null },
                  opts.terminalDeathCheckFetch ?? fetch,
                );
          if (terminalReason) {
            newVerification = "terminal_unconfirmable";
            (crossSourceResults as Record<string, unknown>).terminal_reason = terminalReason;
            console.log(
              `[verifier] ${agent.id} (${agent.name ?? "?"}) terminal_unconfirmable (${terminalReason}) — removed from hourly sweep`,
            );
          } else {
            (crossSourceResults as Record<string, unknown>).terminal_check = "no_confident_death_evidence_stays_pending";
          }
        }
      }

      // Item 2 — paraply-routing guard. Applies to EITHER line's outcome —
      // a paraply-routed contact email must NEVER yield 'verified', and per
      // the dev-request's own wording ("...instead of leaving the agent at
      // whatever it would otherwise be, whenever this specific condition is
      // hit") this is an UNCONDITIONAL override, not only a downgrade of a
      // would-be 'verified': whatever newVerification currently holds
      // (pending_verify / review_required / data_insufficient / verified),
      // a paraply-routed email replaces it with the first-class
      // 'paraply_epost_mangler' status so the daily brief can surface
      // "needs a real, own contact address" as its own actionable bucket
      // rather than it being buried inside a generic pending/review count.
      if (isParaplyRoutedEmail(agent.email, affiliatedUmbrellaDomains)) {
        newVerification = "paraply_epost_mangler";
        verifiedSecondLine = false;
        secondLineSources = [];
        gate.flags.push("paraply_epost_mangler");
        (crossSourceResults as Record<string, unknown>).paraply_epost_mangler = true;
        console.log(
          `[verifier] ${agent.id} (${agent.name ?? "?"}) paraply-routed email — verification_status=paraply_epost_mangler`,
        );
      }
    }

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
      verified_second_line: verifiedSecondLine,
      second_line_sources: secondLineSources,
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
      email_ownership_unproven: emailOwnershipUnproven,
      email_ownership_report_only: emailOwnershipReportOnly,
      verified_second_line: verifiedSecondLine,
      agent_name: agent.name ?? null,
      prior_verification_status: agent.verification_status,
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
  // dev-request 2026-07-15-gate-integrity-unverified-agent-bypass (slice 2):
  // free-mail ownership-provenance guard. Two claims, mirroring the split
  // enforced-vs-report-only behaviour above:
  //   - enforced: NOT already verified going in, quarantined to review_required.
  //   - report-only: ALREADY verified going in — outcome untouched (Daniel's
  //     no-pool-reduction instruction), but surfaced with a few examples so
  //     the daily brief can call out the cohort worth a manual look.
  const emailOwnershipUnprovenEnforced = r.filter(
    (x) => x.email_ownership_unproven && !x.email_ownership_report_only
  ).length;
  const emailOwnershipReportOnlyResults = r.filter((x) => x.email_ownership_report_only);
  const emailOwnershipReportOnlyExamples = emailOwnershipReportOnlyResults
    .slice(0, 5)
    .map((x) => ({ agent_id: x.agent_id, name: x.agent_name }));
  // dev-request 2026-08-23-rfb-andrelinje-verifisering-lav-terskel: always
  // 0 when the flag is off (verified_second_line is only ever true when
  // secondLineEnabled). Lets the daily brief show the new pool growth.
  const verifiedSecondLineResults = r.filter((x) => x.verified_second_line);
  const paraplyBlocked = r.filter((x) => x.new_verification_status === "paraply_epost_mangler").length;
  // dev-request 2026-08-23-terminal-unconfirmable: always 0 when
  // RFB_TERMINAL_UNCONFIRMABLE_ENABLED is off. Lets the daily brief see how
  // many agents this run permanently removed from the hourly sweep.
  const terminalUnconfirmable = r.filter((x) => x.new_verification_status === "terminal_unconfirmable").length;

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
        value: emailOwnershipUnprovenEnforced,
        meta: { kind: "agents_email_ownership_unproven_enforced" },
      },
      {
        type: "db_state_change",
        value: emailOwnershipReportOnlyResults.length,
        meta: {
          kind: "agents_email_ownership_unproven_existing_verified_report_only",
          examples: emailOwnershipReportOnlyExamples,
        },
      },
      {
        type: "db_state_change",
        value: newlyEligible,
        meta: { kind: "outreach_pool_added", detail: "transitioned to verified+(partial|rich)" },
      },
      {
        type: "db_state_change",
        value: verifiedSecondLineResults.length,
        meta: {
          kind: "agents_verified_second_line",
          examples: verifiedSecondLineResults.slice(0, 5).map((x) => ({ agent_id: x.agent_id, name: x.agent_name })),
        },
      },
      { type: "db_state_change", value: paraplyBlocked, meta: { kind: "agents_paraply_epost_mangler" } },
      { type: "db_state_change", value: terminalUnconfirmable, meta: { kind: "agents_terminal_unconfirmable" } },
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
