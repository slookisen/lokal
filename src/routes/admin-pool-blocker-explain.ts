// ─── GET /admin/pool-blocker-explain ────────────────────────────────────────
//
// dev-request 2026-08-10-rfb-hjemmesidejakt-full-loype (slookisen/A2A), punkt
// 2: the enrichment routine's own reports show homepage-provenance-batch
// processing 0 candidates while ~350 agents sit with agent_knowledge.website
// SET, about SET, and field_provenance EMPTY (the 2026-08-10 20-profile pilot,
// enrichment-reports/2026-08-10-hjemmesidejakt-pilot-20-rfb.md, finding F1).
// Nobody could say WHICH gate was dropping them — status value outside the
// selector's IN-list? parking? no-yield backoff? — so every diagnosis so far
// has been a guess. This route ends the guessing: READ-ONLY, per-agent, it
// re-evaluates each gate along the two relevant funnels with the SAME
// predicates the production code uses and names exactly which leg(s) fail.
//
// Funnel A — "outreach-ready pool" (mirrors the outreach_ready_pool VIEW's
// own WHERE, database/init.ts — the REAL membership gate, deliberately
// stricter than admin-outreach-pool.ts's pool_funnel stats legs): umbrella
// exclusion → verification_status='verified' → enrichment_status IN
// ('rich','partial') with 'partial' additionally gated on
// POOL_CONTENT_THRESHOLD_SQL (about>=80 OR products>=3, via the shared
// isContentQualified() mirror) → email present → URL probed fresh (30d) AND
// healthy (2xx/3xx) → not already sent. The VIEW's outreach_sent_log
// exclusion is re-derived 1:1 here (same vertical_id='rfb' + agent_id-or-
// recipient_email predicate) and reported as `already_sent`; a separate,
// narrower CRM contacted_at join (same derivation as /admin/agents/dump) is
// also reported as `already_contacted` for observability, but only
// `already_sent` mirrors the VIEW's actual exclusion — in_pool is always the
// VIEW's own verdict (dev-request 2026-09-06-rfb-pool-blocker-explain-
// usendt-blocker-og-innholdsterskel-etikett).
//
// Funnel B — "homepage-provenance-batch default auto-select" (mirrors the
// selector SQL in routes/marketplace.ts POST /admin/homepage-provenance-batch
// 1:1): status IN ('data_insufficient','review_required','pending_verify')
// → homepage present (COALESCE(k.website, a.url)) → about non-empty →
// field_provenance lacks a "homepage" source → not parked
// (homepage_unreachable_since < 30d ago) → not in no-yield/wrong-entity
// backoff (streak >= 3 AND last attempt inside NO_YIELD_BACKOFF_DAYS).
//
// This route NEVER writes anything — it is a diagnosis surface only. Auth:
// X-Admin-Key (same local requireAdmin convention as every other admin route
// file in this codebase — deliberately re-defined locally, none share it via
// import).

import { Router, Request, Response } from "express";
import { getDb, isContentQualified } from "../database/init";
import { isBlocked } from "../services/blocklist-service";
import { getRecentlyEmailedAddresses, getCrossPlatformSuppressors } from "../services/outreach-suppression-signals";

const router = Router();

// dev-request 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-gate-
// felt: same default cooldown window GET /admin/outreach-candidates uses
// when its own `?cooldown_days=` is left unset (see that route's own
// default). The `gate` block below reuses the REAL gate's own suppression
// helpers (isBlocked, getRecentlyEmailedAddresses, getCrossPlatformSuppressors)
// so this diagnosis surface never drifts from what the real gate would do —
// see this route's own header comment for why re-implementing gate logic
// here is exactly the failure mode this route exists to prevent.
const POOL_BLOCKER_EXPLAIN_DEFAULT_COOLDOWN_DAYS = 60;

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

export const POOL_EXPLAIN_MAX_AGENTS = 100;

// Same env-read convention as the homepage-provenance-batch selector
// (routes/marketplace.ts): default 14, parsed defensively, floor 1.
function noYieldBackoffDays(): number {
  return Math.max(1, parseInt(String(process.env.NO_YIELD_BACKOFF_DAYS ?? "14"), 10) || 14);
}

interface ExplainRow {
  id: string;
  name: string | null;
  umbrella_type: string | null;
  is_active: number | null;
  a_url: string | null;
  contact_email: string | null;
  claimed_at: string | null;
  k_website: string | null;
  verification_status: string | null;
  enrichment_status: string | null;
  k_email: string | null;
  k_phone: string | null;
  k_address: string | null;
  about: string | null;
  products: string | null;
  field_provenance: string | null;
  verification_review_reason: string | null;
  last_verified_at: string | null;
  curated_fields: string | null;
  url_last_status: number | null;
  url_last_probed: string | null;
  homepage_unreachable_since: string | null;
  pending_verify_parked_since: string | null;
  no_yield_streak: number | null;
  wrong_entity_streak: number | null;
  last_enrichment_attempt_at: string | null;
  contacted_at: string | null;
  already_sent: number;
  in_pool: number;
}

// Parse field_provenance and count sources per field. Tolerant of every
// historical shape mergeFieldProvenance (admin-knowledge.ts) accepts:
// array-of-records, {sources:[...]} wrapper, legacy single record.
function provenanceSourceCounts(raw: string | null): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [field, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(val)) out[field] = val.length;
    else if (val && typeof val === "object" && Array.isArray((val as { sources?: unknown }).sources)) {
      out[field] = (val as { sources: unknown[] }).sources.length;
    } else if (val && typeof val === "object") out[field] = 1;
    else out[field] = 0;
  }
  return out;
}

// ── Guards 3 and 4, read from the verifier's own stored verdict ────────────
//
// dev-request 2026-08-10-verifier-portkjede-og-provenansrydding, skive A.
// The pool gate is a chain of FOUR independent guards, but this route's
// first version modelled only two (the pool-VIEW columns and the
// cross-source field verdicts). Measured live 2026-08-10: of 45
// review_required rows, 19 had BOTH gating fields `pool_eligible` and were
// blocked solely by guard 3 (domain coherence — the Eidsmo wrong-entity
// check) or guard 4 (email-ownership proof: free-mail/ISP address with no
// corroborating evidence). Reporting those rows as "no blockers" was a real
// defect in this diagnosis surface.
//
// These two guards live in the verifier's own evaluation
// (cross-source-validator.ts, applied in runVerifierBatch), not in any
// column this route can re-derive cheaply — so rather than re-implement
// (and risk drifting from) that logic, this reads the verdict the verifier
// already persisted in `agent_knowledge.verification_review_reason`. That
// makes the reported blocker exactly what the verifier concluded on its
// last pass, with `stale_as_of` so a caller can see how fresh it is.
interface VerifierStoredVerdict {
  domain_coherence?: { coherent?: boolean; reason?: string } | null;
  email_ownership_unproven?: boolean | null;
  // dev-request 2026-09-17-rfb-review-required-poolblokker-uten-forklaring-
  // og-uten-reevaluering, punkt 1 — the additional shapes
  // lokal-agent-verifier.ts's crossSourceResults can carry, read here so
  // quarantineReasons() below can name the real quarantine reason instead
  // of the route's old generic verification_status_not_verified(=…).
  inference_only_fields?: unknown;
  website_ownership_unverified?: boolean | null;
  corroborated_email_missing?: boolean | null;
  email_website_gate?: { corroborated_email?: boolean } | null;
  [key: string]: unknown;
}

function parseReviewReason(raw: string | null): VerifierStoredVerdict | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as VerifierStoredVerdict;
    }
  } catch {
    /* malformed → treat as absent, same tolerance as the provenance parser */
  }
  return null;
}

function withinDays(iso: string | null, days: number, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return false;
  return nowMs - t < days * 24 * 60 * 60 * 1000;
}

// ── Quarantine-reason mapping (dev-request 2026-09-17-rfb-review-required-
//    poolblokker-uten-forklaring-og-uten-reevaluering, punkt 1) ────────────
//
// This route used to report ONLY the generic
// `verification_status_not_verified (=review_required)` blocker for a
// review_required row — the ACTUAL reason the verifier quarantined it
// (inference-only field, unverified site ownership, domain incoherence,
// missing corroborated email) was computed and, for most of these, already
// persisted in the verifier's own stored verdict
// (`agent_knowledge.verification_review_reason`, the same JSON the
// verifier calls `cross_source_reason` — see lokal-agent-verifier.ts) but
// never surfaced here. A census (2026-09-17) found 35 of ~74 stuck
// review_required rows already satisfying every VISIBLE requirement while
// staying quarantined for exactly this class of invisible reason.
//
// Naming (per spec): one `quarantine:<reason>` element per ACTUAL reason
// found, never a silent empty list —
//   quarantine:inference_only_fields(<field>)   — one per field
//   quarantine:website_ownership_unverified
//   quarantine:domain_incoherent(<reason>)
//   quarantine:corroborated_email_missing
//   quarantine:reason_missing                   — explicit fallback when
//                                                  none of the above match
//
// READ-ONLY: this only parses data already stored on the row
// (verification_review_reason + field_provenance) — it writes nothing.
//
// website_ownership_unverified is read from field_provenance DIRECTLY
// (mirroring the exact check lokal-agent-verifier.ts's Guard #1 makes:
// `field_provenance.website_ownership.status === "unverified"`), not only
// from the stored verdict: until this same dev-request, the verifier
// computed this flag but only ever pushed it to its in-memory gate.flags,
// never persisted it onto the stored verdict JSON — so historical
// review_required rows quarantined for this reason (before the verifier
// fix above) have no trace of it in verification_review_reason at all,
// only in field_provenance (which the crawl always wrote). Re-deriving it
// here from field_provenance covers both those historical rows and any
// future ones. corroborated_email_missing is likewise read from the
// PRE-EXISTING, always-persisted `email_website_gate.corroborated_email`
// object (unconditionally stamped by the verifier for every row it
// processes) in addition to the new explicit top-level flag, for the same
// historical-coverage reason.
function quarantineReasons(
  fieldProvenanceRaw: string | null,
  storedVerdict: VerifierStoredVerdict | null,
): string[] {
  const reasons: string[] = [];

  const inferenceFields = storedVerdict?.inference_only_fields;
  if (Array.isArray(inferenceFields)) {
    for (const f of inferenceFields) {
      if (typeof f === "string" && f) {
        reasons.push(`quarantine:inference_only_fields(${f})`);
      }
    }
  }

  let websiteOwnershipUnverified = storedVerdict?.website_ownership_unverified === true;
  if (!websiteOwnershipUnverified && fieldProvenanceRaw) {
    try {
      const fieldProv = JSON.parse(fieldProvenanceRaw);
      const wo = fieldProv && typeof fieldProv === "object" ? (fieldProv as Record<string, unknown>).website_ownership : null;
      if (wo && typeof wo === "object" && (wo as Record<string, unknown>).status === "unverified") {
        websiteOwnershipUnverified = true;
      }
    } catch {
      /* malformed field_provenance → not a website-ownership signal */
    }
  }
  if (websiteOwnershipUnverified) {
    reasons.push("quarantine:website_ownership_unverified");
  }

  const domainCoherence = storedVerdict?.domain_coherence;
  if (domainCoherence && domainCoherence.coherent === false) {
    reasons.push(`quarantine:domain_incoherent(${domainCoherence.reason ?? "unknown"})`);
  }

  const corroboratedEmailMissing =
    storedVerdict?.corroborated_email_missing === true ||
    storedVerdict?.email_website_gate?.corroborated_email === false;
  if (corroboratedEmailMissing) {
    reasons.push("quarantine:corroborated_email_missing");
  }

  if (reasons.length === 0) {
    reasons.push("quarantine:reason_missing");
  }
  return reasons;
}

router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const rawIds = String(req.query.agentIds ?? req.query.agentId ?? "").trim();
  if (!rawIds) {
    res.status(400).json({
      error: `Angi ?agentId=<id> eller ?agentIds=<id1,id2,...> (maks ${POOL_EXPLAIN_MAX_AGENTS})`,
    });
    return;
  }
  const ids = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.length > POOL_EXPLAIN_MAX_AGENTS) {
    res.status(400).json({ error: `Mellom 1 og ${POOL_EXPLAIN_MAX_AGENTS} agent-IDer per kall` });
    return;
  }

  const db = getDb();
  const nowMs = Date.now();
  const backoffDays = noYieldBackoffDays();

  // dev-request 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-
  // gate-felt: same optional override the real gate exposes
  // (?cooldown_days=), defaulting to the same 60 days, so a caller diagnosing
  // a specific outreach-candidates call can match its cooldown window exactly.
  const cooldownDaysRaw = parseInt(String(req.query.cooldown_days ?? ""), 10);
  const cooldownDays = Number.isFinite(cooldownDaysRaw) && cooldownDaysRaw > 0
    ? cooldownDaysRaw
    : POOL_BLOCKER_EXPLAIN_DEFAULT_COOLDOWN_DAYS;

  // Computed once (not per-agent) — same helpers the real gate
  // (GET /admin/outreach-candidates?mode=first) uses, see
  // outreach-suppression-signals.ts.
  const recentlyEmailedAddresses = getRecentlyEmailedAddresses(db, cooldownDays);
  const crossPlatformSuppressors = getCrossPlatformSuppressors(db, cooldownDays);

  const stmt = db.prepare(`
    SELECT a.id AS id, a.name AS name, a.umbrella_type AS umbrella_type,
           a.is_active AS is_active, a.url AS a_url, a.contact_email AS contact_email,
           a.claimed_at AS claimed_at,
           k.website AS k_website, k.verification_status AS verification_status,
           k.enrichment_status AS enrichment_status, k.email AS k_email,
           k.phone AS k_phone, k.address AS k_address, k.about AS about,
           k.products AS products,
           k.field_provenance AS field_provenance,
           k.verification_review_reason AS verification_review_reason,
           k.last_verified_at AS last_verified_at,
           k.curated_fields AS curated_fields,
           k.url_last_status AS url_last_status, k.url_last_probed AS url_last_probed,
           k.homepage_unreachable_since AS homepage_unreachable_since,
           k.pending_verify_parked_since AS pending_verify_parked_since,
           k.no_yield_streak AS no_yield_streak, k.wrong_entity_streak AS wrong_entity_streak,
           k.last_enrichment_attempt_at AS last_enrichment_attempt_at,
           (
             SELECT MAX(m.sent_at)
             FROM crm_messages m
             JOIN crm_threads t ON t.id = m.thread_id
             JOIN crm_contacts c ON c.id = t.contact_id
             WHERE m.direction = 'out'
               AND a.contact_email IS NOT NULL AND a.contact_email != ''
               AND LOWER(c.email) = LOWER(a.contact_email)
           ) AS contacted_at,
           EXISTS(
             SELECT 1 FROM outreach_sent_log o
             WHERE o.vertical_id = 'rfb'
               AND (o.agent_id = a.id
                    OR (o.recipient_email IS NOT NULL AND o.recipient_email = LOWER(k.email)))
           ) AS already_sent,
           EXISTS(SELECT 1 FROM outreach_ready_pool p WHERE p.agent_id = a.id) AS in_pool
      FROM agents a
      LEFT JOIN agent_knowledge k ON k.agent_id = a.id
     WHERE a.id = ?
  `);

  const agents = ids.map((id) => {
    const row = stmt.get(id) as ExplainRow | undefined;
    if (!row) {
      return { agent_id: id, found: false as const };
    }

    const kWebsite = (row.k_website ?? "").trim();
    const aUrl = (row.a_url ?? "").trim();
    const homepage = kWebsite || aUrl || null;
    const about = (row.about ?? "").trim();
    const email = (row.k_email ?? "").trim();
    const provCounts = provenanceSourceCounts(row.field_provenance);
    const provHasHomepage = (row.field_provenance ?? "").includes('"homepage"');
    const noYield = row.no_yield_streak ?? 0;
    const wrongEntity = row.wrong_entity_streak ?? 0;
    const parkedNow = withinDays(row.homepage_unreachable_since, 30, nowMs);
    const attemptRecent = withinDays(row.last_enrichment_attempt_at, backoffDays, nowMs);
    const backoffActive = (noYield >= 3 || wrongEntity >= 3) && row.last_enrichment_attempt_at !== null && attemptRecent;
    const urlFresh = withinDays(row.url_last_probed, 30, nowMs);
    const urlHealthy = row.url_last_status !== null && row.url_last_status >= 200 && row.url_last_status < 400;

    // ── `gate` — the SAME suppression checks the real gate
    // (GET /admin/outreach-candidates?mode=first) applies, via the SAME
    // helpers (isBlocked, getRecentlyEmailedAddresses,
    // getCrossPlatformSuppressors) — never a parallel reimplementation. Only
    // the 3 checks that are cheap/meaningful to re-derive per-agent outside
    // that route's own candidate loop; the rest of that gate's suppression
    // reasons (replied/opted-out/customer/hard-bounced/etc.) are already
    // covered by this route's existing pool_blockers/signals above.
    const emailLower = email.toLowerCase();
    const gate = {
      blocklisted: isBlocked({
        agentId: row.id,
        name: row.name ?? undefined,
        email: email || undefined,
        website: kWebsite || undefined,
      }).blocked,
      recent_crm_send_email_match: email.length > 0 && recentlyEmailedAddresses.has(emailLower),
      cross_platform_cooldown: email.length > 0 && crossPlatformSuppressors.has(emailLower),
    };

    // ── Funnel A: outreach-ready pool legs (admin-outreach-pool.ts order) ──
    const poolBlockers: string[] = [];
    if (row.umbrella_type) poolBlockers.push("umbrella_agent");
    if (row.is_active !== 1) poolBlockers.push("inactive");
    if (row.verification_status !== "verified") {
      poolBlockers.push(`verification_status_not_verified (=${row.verification_status ?? "NULL"})`);
    }
    if (row.enrichment_status === "partial") {
      if (!isContentQualified({ about: row.about, products: row.products })) {
        poolBlockers.push("content_threshold_not_met (partial: about <80 chars and <3 products)");
      }
    } else if (row.enrichment_status !== "rich") {
      poolBlockers.push(`enrichment_status_not_rich (=${row.enrichment_status ?? "NULL"})`);
    }
    if (!email) poolBlockers.push("no_email");
    if (!homepage) poolBlockers.push("no_homepage_url_in_either_column");
    else {
      if (!urlFresh) poolBlockers.push("url_probe_missing_or_stale_30d");
      else if (!urlHealthy) poolBlockers.push(`url_unhealthy (last_status=${row.url_last_status ?? "NULL"})`);
    }
    if (row.contacted_at) poolBlockers.push("already_contacted");
    if (row.already_sent === 1) poolBlockers.push("already_sent (outreach_sent_log)");

    // Guards 3 + 4 (skive A) — the verifier's own stored verdict. These block
    // promotion to `verified` even when every column leg above is clean, so
    // they belong in the same list rather than in a separate section.
    const storedVerdict = parseReviewReason(row.verification_review_reason);
    const domainCoherence = storedVerdict?.domain_coherence ?? null;
    const domainIncoherent = !!domainCoherence && domainCoherence.coherent === false;
    const emailOwnershipUnproven = storedVerdict?.email_ownership_unproven === true;
    if (domainIncoherent) {
      poolBlockers.push(
        `domain_incoherent (${domainCoherence?.reason ?? "agents.url vs knowledge.website/email host mismatch"})`,
      );
    }
    // NB: `email_ownership_unproven` is deliberately NOT a pool blocker.
    // Daniel, 2026-08-10: «gmail domener og forsåvidt hotmail og andre er ok
    // å bruke» — the verifier's guard was changed to report-only in the same
    // decision (lokal#568), so a free-mail address no longer costs an agent
    // its pool place. This route listed it as a blocker for one deploy cycle
    // and was, in that window, reporting a non-blocker as the reason an agent
    // was held back (observed live on Eimealt). The signal stays available as
    // `signals.email_ownership_unproven` for anyone watching wrong contacts —
    // it is just no longer an answer to "what is blocking this agent".

    // dev-request 2026-09-17-rfb-review-required-poolblokker-uten-forklaring-
    // og-uten-reevaluering, punkt 1: name the ACTUAL quarantine reason(s) for
    // a review_required row instead of leaving the generic
    // verification_status_not_verified(=review_required) blocker above as
    // the only signal. See quarantineReasons()'s own doc comment.
    if (row.verification_status === "review_required") {
      poolBlockers.push(...quarantineReasons(row.field_provenance, storedVerdict));
    }

    // ── Funnel B: homepage-provenance-batch default auto-select legs
    //    (routes/marketplace.ts selector, same order) ─────────────────────
    const crawlBlockers: string[] = [];
    const statusInList =
      row.verification_status === "data_insufficient" ||
      row.verification_status === "review_required" ||
      row.verification_status === "pending_verify";
    if (!statusInList) {
      crawlBlockers.push(`status_not_in_selector_list (=${row.verification_status ?? "NULL"})`);
    }
    if (!homepage) crawlBlockers.push("no_homepage_url_in_either_column");
    if (!about) crawlBlockers.push("about_empty");
    if (provHasHomepage) crawlBlockers.push("already_has_homepage_provenance");
    if (parkedNow) crawlBlockers.push(`parked_homepage_unreachable (since=${row.homepage_unreachable_since})`);
    if (backoffActive) {
      crawlBlockers.push(
        `no_yield_or_wrong_entity_backoff (no_yield=${noYield}, wrong_entity=${wrongEntity}, last_attempt=${row.last_enrichment_attempt_at})`,
      );
    }

    return {
      agent_id: row.id,
      found: true as const,
      name: row.name,
      in_pool: row.in_pool === 1,
      // dev-request 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-
      // gate-felt: see the `gate` computation above — same helpers the real
      // gate uses, never a parallel reimplementation.
      gate,
      signals: {
        umbrella_type: row.umbrella_type,
        is_active: row.is_active === 1,
        verification_status: row.verification_status,
        enrichment_status: row.enrichment_status,
        a_url: aUrl || null,
        k_website: kWebsite || null,
        homepage_url: homepage,
        about_present: about.length > 0,
        email_present: email.length > 0,
        phone_present: (row.k_phone ?? "").trim().length > 0,
        address_present: (row.k_address ?? "").trim().length > 0,
        provenance_source_counts: provCounts,
        provenance_has_homepage_source: provHasHomepage,
        url_last_status: row.url_last_status,
        url_last_probed: row.url_last_probed,
        url_probe_fresh_30d: urlFresh,
        homepage_unreachable_since: row.homepage_unreachable_since,
        pending_verify_parked_since: row.pending_verify_parked_since,
        no_yield_streak: noYield,
        wrong_entity_streak: wrongEntity,
        last_enrichment_attempt_at: row.last_enrichment_attempt_at,
        backoff_active: backoffActive,
        claimed: row.claimed_at !== null,
        contacted_at: row.contacted_at,
        already_sent: row.already_sent === 1,
        // Guards 3+4 as raw signals alongside the blocker strings, so a
        // caller can act on them without string-parsing.
        domain_coherence: domainCoherence,
        email_ownership_unproven: emailOwnershipUnproven,
        // The verifier's verdict is only as fresh as its last pass over this
        // agent — surfaced so a stale verdict is never mistaken for a live one.
        verifier_verdict_as_of: row.last_verified_at,
      },
      pool_blockers: poolBlockers,
      crawl_auto_select: {
        eligible: crawlBlockers.length === 0,
        blockers: crawlBlockers,
      },
    };
  });

  res.json({
    success: true,
    count: agents.length,
    no_yield_backoff_days: backoffDays,
    // dev-request 2026-09-16-run-verifier-agentids-og-pool-blocker-explain-
    // gate-felt: the cooldown window `gate.recent_crm_send_email_match` /
    // `gate.cross_platform_cooldown` were computed with, same pattern as
    // `no_yield_backoff_days` above.
    cooldown_days_used: cooldownDays,
    agents,
  });
});

export default router;
