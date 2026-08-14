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
// exclusion → verification_status='verified' → enrichment_status='rich' →
// email present → URL probed fresh (30d) AND healthy (2xx/3xx). The VIEW's
// outreach_sent_log/cooldown exclusions are approximated here by the CRM
// contacted_at join (same derivation as /admin/agents/dump) and reported as
// `already_contacted` — in_pool is always the VIEW's own verdict.
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
import { getDb } from "../database/init";

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

  const stmt = db.prepare(`
    SELECT a.id AS id, a.name AS name, a.umbrella_type AS umbrella_type,
           a.is_active AS is_active, a.url AS a_url, a.contact_email AS contact_email,
           a.claimed_at AS claimed_at,
           k.website AS k_website, k.verification_status AS verification_status,
           k.enrichment_status AS enrichment_status, k.email AS k_email,
           k.phone AS k_phone, k.address AS k_address, k.about AS about,
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

    // ── Funnel A: outreach-ready pool legs (admin-outreach-pool.ts order) ──
    const poolBlockers: string[] = [];
    if (row.umbrella_type) poolBlockers.push("umbrella_agent");
    if (row.is_active !== 1) poolBlockers.push("inactive");
    if (row.verification_status !== "verified") {
      poolBlockers.push(`verification_status_not_verified (=${row.verification_status ?? "NULL"})`);
    }
    if (row.enrichment_status !== "rich") {
      poolBlockers.push(`enrichment_status_not_rich (=${row.enrichment_status ?? "NULL"})`);
    }
    if (!email) poolBlockers.push("no_email");
    if (!homepage) poolBlockers.push("no_homepage_url_in_either_column");
    else {
      if (!urlFresh) poolBlockers.push("url_probe_missing_or_stale_30d");
      else if (!urlHealthy) poolBlockers.push(`url_unhealthy (last_status=${row.url_last_status ?? "NULL"})`);
    }
    if (row.contacted_at) poolBlockers.push("already_contacted");

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
    agents,
  });
});

export default router;
