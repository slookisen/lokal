// ─── Admin: outreach_ready_pool endpoints (Phase 5.1, WO #7) ─────
//
// Read-only HTTP surface for the verify-first marketing pool.
// Marketing-comms agent will switch over to this in WO #9; until then
// these endpoints exist for the orchestrator + dashboard to monitor
// pool growth as lokal-agent-verifier (WO #8) lifts agents out of
// `unverified`/`thin` into `verified`/(`partial`|`rich`).
//
// All endpoints require X-Admin-Key.
//
// PR-22 / WO-20 (2026-05-10): the index endpoint now collapses email
// duplicates (e.g. agder@bondensmarked.no on 4 different pool agents)
// down to a single representative per batch — domain-reputation safe.
// Off via ?dedupe_by_email=false; defaults to true.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";
import { dedupeByEmail, DedupeCandidate } from "../services/marketing-dedupe";
import { isJunkDescription } from "../services/description-quality";
import { isJunkEmail } from "../services/gardssalg-rfb-enrich";
import {
  crossSourceAgreement,
  tierForSource,
  isInferenceSource,
  type ProvenanceRecord,
  type SourceTier,
} from "../services/cross-source-validator";

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

function parseBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return dflt;
}

// ─── blocker_breakdown helpers (dev-request 2026-07-27-outreach-blocker-diag,
// Steg 1) ─────────────────────────────────────────────────────────────────
//
// Parse the field_provenance JSON column the SAME defensive way every other
// call site in this codebase does (admin-domain-coherence.ts,
// lokal-agent-verifier.ts): string | already-parsed-object | null/missing,
// all normalized to a plain object.
function parseFieldProvenance(
  raw: string | null | undefined
): Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown> {
  if (!raw) return {};
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Mirrors the exact "valid" (evidence, non-inference) record extraction that
// crossSourceAgreement() does internally (cross-source-validator.ts) — same
// value-presence filter, same isInferenceSource() deny-list — so
// blocker_breakdown's source_count distribution can never disagree with the
// verdict the verifier itself computed for the same field.
function getValidFieldRecords(
  fieldProvenance: Record<string, ProvenanceRecord[] | ProvenanceRecord | unknown>,
  fieldName: string
): ProvenanceRecord[] {
  const raw = fieldProvenance[fieldName];
  let records: ProvenanceRecord[];
  if (!raw) {
    records = [];
  } else if (Array.isArray(raw)) {
    records = raw as ProvenanceRecord[];
  } else if (typeof raw === "object" && raw !== null) {
    records = [raw as ProvenanceRecord];
  } else {
    records = [];
  }
  const allValid = records.filter((r) => r && typeof r.value === "string" && r.value.trim() !== "");
  return allValid.filter((r) => !isInferenceSource(r.source_type));
}

// GET /admin/outreach-ready-pool/stats — pool size + breakdowns
// Defined BEFORE the index route so /stats is not eaten by /:limit-style logic.
//
// dev-request 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction (re-scoped
// item 1, per the 2026-07-12T17:5xZ premise-correction note on that file): the
// original "pool_size=2" reading was misread as an email-coverage problem. It is
// actually the `outreach_ready_pool` VIEW's five-gate funnel (email present,
// non-umbrella, verified, partial/rich, URL probed-fresh-and-OK, not already
// sent) draining almost everything at the URL-freshness gate. `pool_funnel`
// below counts the cohort surviving each gate in order so the next slice knows
// which gate to fix instead of re-measuring blind. `homepage_parking` reports
// the PR #248 parking mechanism's live split (still-backed-off vs. eligible for
// retry) — read-only, same columns/window that route already writes.
// `pending_verify_parking` reports the analogous dev-request
// 2026-07-12-rfb-enrichment-pool-refill-and-waste-reduction (item 6 follow-up)
// mechanism for the bulk pending_verify sweep (pending_verify_parked_since,
// stamped in applyVerifierOutcome) — same still-backed-off vs.
// eligible-for-retry split, read-only.
router.get("/stats", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS c FROM outreach_ready_pool`).get() as { c: number };
    const byStatus = db
      .prepare(`SELECT verification_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY verification_status`)
      .all() as Array<{ k: string; c: number }>;
    const byEnrichment = db
      .prepare(`SELECT enrichment_status AS k, COUNT(*) AS c FROM agent_knowledge GROUP BY enrichment_status`)
      .all() as Array<{ k: string; c: number }>;

    // Funnel: each step ANDs one more outreach_ready_pool gate onto the last,
    // in the same order the VIEW applies them, so the counts strictly
    // decrease and the biggest single drop identifies the bottleneck gate.
    const funnelBase = `
      FROM agents a
      INNER JOIN agent_knowledge k ON k.agent_id = a.id
      WHERE a.umbrella_type IS NULL
        AND k.verification_status = 'verified'
        AND k.enrichment_status IN ('partial', 'rich')`;
    const verifiedRichOrPartial = db.prepare(`SELECT COUNT(*) AS c ${funnelBase}`).get() as { c: number };
    const withEmail = db
      .prepare(`SELECT COUNT(*) AS c ${funnelBase} AND k.email IS NOT NULL AND k.email != ''`)
      .get() as { c: number };
    const urlFreshAndOk = db
      .prepare(
        `SELECT COUNT(*) AS c ${funnelBase} AND k.email IS NOT NULL AND k.email != ''
           AND k.url_last_status IS NOT NULL AND k.url_last_status >= 200 AND k.url_last_status < 400
           AND k.url_last_probed IS NOT NULL AND k.url_last_probed > datetime('now', '-30 days')`
      )
      .get() as { c: number };

    const parking = db
      .prepare(
        `SELECT
           SUM(CASE WHEN homepage_unreachable_since IS NOT NULL
                     AND homepage_unreachable_since > datetime('now', '-30 days') THEN 1 ELSE 0 END) AS parked_active,
           SUM(CASE WHEN homepage_unreachable_since IS NOT NULL
                     AND homepage_unreachable_since <= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS parked_expired
         FROM agent_knowledge`
      )
      .get() as { parked_active: number | null; parked_expired: number | null };

    const pendingVerifyParking = db
      .prepare(
        `SELECT
           SUM(CASE WHEN pending_verify_parked_since IS NOT NULL
                     AND pending_verify_parked_since > datetime('now', '-30 days') THEN 1 ELSE 0 END) AS parked_active,
           SUM(CASE WHEN pending_verify_parked_since IS NOT NULL
                     AND pending_verify_parked_since <= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS parked_expired
         FROM agent_knowledge`
      )
      .get() as { parked_active: number | null; parked_expired: number | null };

    // dev-request 2026-07-13-enrichment-tynne-profiler-trust-score (item 1,
    // stats slice): progress gauge for the low_quality re-enrichment cohort
    // (POST /admin/homepage-provenance-batch { select: "low_quality" }, in
    // marketplace.ts) — this route is the existing "pool_funnel"-pattern
    // stats surface for this same RFB-producer domain (agents/agent_knowledge
    // in lokal.db), so the new breakdown lands here rather than a new file.
    // Candidate gate mirrors that selector's SQL WHERE clause (non-umbrella,
    // trust_score<0.5, has a homepage to re-enrich from) but — deliberately,
    // per the dev-request's own "e.g. trust_score < 0.5 non-umbrella count"
    // framing — skips the no_yield/wrong_entity backoff and dead-homepage
    // parking exclusions: this is a "how big is the bad-profile universe"
    // gauge, not an exact "would be selected on the very next call" count.
    // Breaks the total down by which junk/thinness signal(s) fired, using
    // the SAME isJunkEmail/isJunkDescription predicates the selector ranks
    // with, so this number and the selector's behaviour can't drift apart.
    const lowQualityRows = db
      .prepare(
        `SELECT a.trust_score AS trust_score, a.description AS description,
                a.contact_email AS contact_email, k.email AS knowledge_email,
                k.about AS about, k.products AS products
           FROM agent_knowledge k
           JOIN agents a ON a.id = k.agent_id
          WHERE a.umbrella_type IS NULL
            AND a.trust_score < 0.5
            AND (k.website IS NOT NULL AND k.website != '' OR a.url IS NOT NULL AND a.url != '')`
      )
      .all() as Array<{
      trust_score: number;
      description: string | null;
      contact_email: string | null;
      knowledge_email: string | null;
      about: string | null;
      products: string | null;
    }>;
    let lqJunkEmail = 0;
    let lqJunkDescription = 0;
    let lqThin = 0;
    for (const r of lowQualityRows) {
      const email = r.knowledge_email && r.knowledge_email.trim() ? r.knowledge_email : r.contact_email;
      if (isJunkEmail(email)) lqJunkEmail++;
      if (isJunkDescription(r.description)) lqJunkDescription++;
      const aboutEmpty = !r.about || !r.about.trim();
      let productsEmpty = true;
      try {
        const arr = JSON.parse(r.products || "[]");
        productsEmpty = !Array.isArray(arr) || arr.length === 0;
      } catch {
        productsEmpty = true;
      }
      if (aboutEmpty || productsEmpty) lqThin++;
    }

    // dev-request 2026-07-27-outreach-blocker-diag (Steg 1): blocker_breakdown.
    // Read-only diagnostic explaining why the pending_verify/review_required
    // cohort (~930 agents) never reaches verified/pool. Cohort = same
    // convention as the rest of this file: non-umbrella (a.umbrella_type IS
    // NULL). Every per-field verdict below is computed with the SAME
    // crossSourceAgreement() the verifier itself calls (GATING_FIELDS =
    // address+phone in cross-source-validator.ts) — never re-implemented or
    // guessed — so these counts cannot drift from the real gate.
    const blockerCohortRows = db
      .prepare(
        `SELECT a.id AS agent_id, k.verification_status, k.verification_review_reason,
                k.field_provenance, k.email, k.enrichment_status, k.about, k.products,
                k.address, k.website, a.url AS agent_url
           FROM agents a
           INNER JOIN agent_knowledge k ON k.agent_id = a.id
          WHERE a.umbrella_type IS NULL
            AND k.verification_status IN ('pending_verify', 'review_required')`
      )
      .all() as Array<{
        agent_id: string;
        verification_status: string;
        verification_review_reason: string | null;
        field_provenance: string | null;
        email: string | null;
        enrichment_status: string | null;
        about: string | null;
        products: string | null;
        address: string | null;
        website: string | null;
        agent_url: string | null;
      }>;

    const cohortTotal = blockerCohortRows.length;
    let cohortPending = 0;
    let cohortReview = 0;

    type SourceCountDist = {
      zero: number;
      one: number;
      two_plus: number;
      one_source_tier: Record<SourceTier, number>;
    };
    const makeDist = (): SourceCountDist => ({
      zero: 0,
      one: 0,
      two_plus: 0,
      one_source_tier: { S: 0, A: 0, B: 0, C: 0 },
    });
    const gatingFieldSourceCounts: Record<"address" | "phone", SourceCountDist> = {
      address: makeDist(),
      phone: makeDist(),
    };

    let blockedAddressOnly = 0;
    let blockedPhoneOnly = 0;
    let blockedBoth = 0;
    let blockedNeither = 0;

    let bbThinTotal = 0;
    let bbThinShortAbout = 0;
    let bbThinNoProducts = 0;
    let bbThinNoAddress = 0;

    let noWebsiteAtAllCohort = 0;
    let missingEmailCohort = 0;
    let reviewRequiredEmailOwnershipUnproven = 0;

    for (const row of blockerCohortRows) {
      if (row.verification_status === "pending_verify") cohortPending++;
      else if (row.verification_status === "review_required") cohortReview++;

      const fieldProv = parseFieldProvenance(row.field_provenance);

      let addressBlocked = false;
      let phoneBlocked = false;
      for (const field of ["address", "phone"] as const) {
        const validRecords = getValidFieldRecords(fieldProv, field);
        const dist = gatingFieldSourceCounts[field];
        if (validRecords.length === 0) {
          dist.zero++;
        } else if (validRecords.length === 1) {
          dist.one++;
          dist.one_source_tier[tierForSource(validRecords[0]!.source_type)]++;
        } else {
          dist.two_plus++;
        }
        const blocked = crossSourceAgreement(fieldProv, field).verdict !== "pool_eligible";
        if (field === "address") addressBlocked = blocked;
        else phoneBlocked = blocked;
      }
      if (addressBlocked && phoneBlocked) blockedBoth++;
      else if (addressBlocked) blockedAddressOnly++;
      else if (phoneBlocked) blockedPhoneOnly++;
      else blockedNeither++;

      // enrichment_status='thin' breakdown — mirrors computeEnrichmentStatus's
      // OWN "partial" escape hatch (aboutLen>=80 OR products>=1 OR address) in
      // lokal-agent-verifier.ts: 'thin' means ALL THREE of these fail
      // simultaneously, so every sub-count below is expected to equal the
      // thin total for currently-consistent rows — reported independently
      // (rather than assumed) so any future drift between this route and
      // computeEnrichmentStatus is visible rather than silently masked.
      if (row.enrichment_status === "thin") {
        bbThinTotal++;
        const aboutLen = (row.about || "").length;
        if (aboutLen < 80) bbThinShortAbout++;
        let productsCount = 0;
        try {
          const arr = JSON.parse(row.products || "[]");
          productsCount = Array.isArray(arr) ? arr.length : 0;
        } catch {
          productsCount = 0;
        }
        if (productsCount === 0) bbThinNoProducts++;
        if (!row.address || !row.address.trim()) bbThinNoAddress++;
      }

      const hasWebsite = !!((row.website && row.website.trim()) || (row.agent_url && row.agent_url.trim()));
      if (!hasWebsite) noWebsiteAtAllCohort++;

      if (!row.email || !row.email.trim()) missingEmailCohort++;

      if (row.verification_status === "review_required") {
        let reason: Record<string, unknown> = {};
        try {
          reason = JSON.parse(row.verification_review_reason || "{}");
        } catch {
          reason = {};
        }
        if (reason.email_ownership_unproven === true) reviewRequiredEmailOwnershipUnproven++;
      }
    }

    // Item 3: split the EXISTING pool_funnel.url_fresh_and_ok gate's failure
    // count into 3 causes. Deliberately computed over the SAME cohort that
    // gate already applies to (verified + rich/partial + email present —
    // `withEmail` above), NOT the pending_verify/review_required cohort above
    // — this splits an existing number, it does not introduce a new one, and
    // the 3-way split's sum must equal (withEmail - urlFreshAndOk) unchanged.
    // Conditions mirror the funnelBase/withEmail/urlFreshAndOk SQL verbatim.
    const urlSplitBase = `${funnelBase} AND k.email IS NOT NULL AND k.email != ''`;
    const urlSplitNoWebsite = db
      .prepare(
        `SELECT COUNT(*) AS c ${urlSplitBase}
           AND (k.website IS NULL OR k.website = '')
           AND (a.url IS NULL OR a.url = '')`
      )
      .get() as { c: number };
    const urlSplitStale = db
      .prepare(
        `SELECT COUNT(*) AS c ${urlSplitBase}
           AND NOT ((k.website IS NULL OR k.website = '') AND (a.url IS NULL OR a.url = ''))
           AND (k.url_last_probed IS NULL OR k.url_last_probed <= datetime('now', '-30 days'))`
      )
      .get() as { c: number };
    const urlSplitBadStatus = db
      .prepare(
        `SELECT COUNT(*) AS c ${urlSplitBase}
           AND NOT ((k.website IS NULL OR k.website = '') AND (a.url IS NULL OR a.url = ''))
           AND k.url_last_probed IS NOT NULL AND k.url_last_probed > datetime('now', '-30 days')
           AND NOT (k.url_last_status IS NOT NULL AND k.url_last_status >= 200 AND k.url_last_status < 400)`
      )
      .get() as { c: number };

    res.json({
      success: true,
      pool_size: total?.c ?? 0,
      by_verification_status: byStatus,
      by_enrichment_status: byEnrichment,
      pool_funnel: {
        verified_and_rich_or_partial: verifiedRichOrPartial?.c ?? 0,
        with_email: withEmail?.c ?? 0,
        url_fresh_and_ok: urlFreshAndOk?.c ?? 0,
        not_yet_contacted_final: total?.c ?? 0,
      },
      homepage_parking: {
        parked_active: parking?.parked_active ?? 0,
        parked_expired_ready_for_retry: parking?.parked_expired ?? 0,
      },
      pending_verify_parking: {
        parked_active: pendingVerifyParking?.parked_active ?? 0,
        parked_expired_ready_for_retry: pendingVerifyParking?.parked_expired ?? 0,
      },
      low_quality_cohort: {
        total: lowQualityRows.length,
        junk_email: lqJunkEmail,
        junk_description: lqJunkDescription,
        thin: lqThin,
      },
      // dev-request 2026-07-27-outreach-blocker-diag (Steg 1): diagnostic-only,
      // additive. Explains WHY the pending_verify/review_required cohort
      // never reaches verified/pool. Every field/verdict count derives from
      // the SAME crossSourceAgreement() gate the verifier itself calls —
      // never guessed, never a separate re-implementation.
      blocker_breakdown: {
        cohort_total: cohortTotal,
        cohort_by_status: {
          pending_verify: cohortPending,
          review_required: cohortReview,
        },
        // Item 1: per-gating-field (address, phone) source_count distribution.
        // "one_source_tier" is the Tier (S/A/B/C — see tierForSource in
        // cross-source-validator.ts) of the single source, for the
        // source_count===1 bucket only.
        gating_field_source_counts: gatingFieldSourceCounts,
        // Item 2: address/phone cross-tab. Sums to cohort_total exactly (every
        // agent falls into exactly one bucket). "blocked_neither" = blocked by
        // something other than address/phone cross-source agreement (e.g.
        // domain-coherence, email_ownership_unproven, website_ownership:
        // unverified, or thin content) — those reasons are counted in this
        // same object below, not sub-split further here.
        address_phone_cross_tab: {
          blocked_address_only: blockedAddressOnly,
          blocked_phone_only: blockedPhoneOnly,
          blocked_both: blockedBoth,
          blocked_neither: blockedNeither,
          total: blockedAddressOnly + blockedPhoneOnly + blockedBoth + blockedNeither,
        },
        // Item 3: splits the EXISTING pool_funnel.url_fresh_and_ok gate's
        // failure count into 3 causes. NB: computed over the pool_funnel
        // `with_email` cohort (verified + rich/partial + email present) —
        // the SAME cohort that gate already applies to — NOT the
        // pending_verify/review_required cohort the rest of this object
        // uses. no_website_at_all + stale_over_30_days + bad_http_status
        // sums to exactly (with_email - url_fresh_and_ok); the split does
        // not change pool_funnel's existing totals, only explains the gap.
        url_freshness_failure_split: {
          base_cohort: "pool_funnel.with_email (verified + rich/partial + email present) — not the pending_verify/review_required cohort above",
          base_cohort_total: withEmail?.c ?? 0,
          passing: urlFreshAndOk?.c ?? 0,
          failing_total: (withEmail?.c ?? 0) - (urlFreshAndOk?.c ?? 0),
          no_website_at_all: urlSplitNoWebsite?.c ?? 0,
          stale_over_30_days: urlSplitStale?.c ?? 0,
          bad_http_status: urlSplitBadStatus?.c ?? 0,
        },
        // Item 4: enrichment_status='thin' within the pending_verify/
        // review_required cohort, and why (about<80 chars / 0 products / no
        // address — computeEnrichmentStatus requires ALL THREE to fail for
        // 'thin', so each sub-count is expected to equal `total`).
        thin_enrichment: {
          total: bbThinTotal,
          short_about: bbThinShortAbout,
          no_products: bbThinNoProducts,
          no_address: bbThinNoAddress,
        },
        // Item 5: cohort-size number only (no website/agent-url at all).
        // Feeds a future L4 decision — not acted on in this slice.
        no_website_at_all_count: noWebsiteAtAllCohort,
        // Item 6: email-first breakdown (e-post prioritized over telefon —
        // email is the send channel).
        email_first_breakdown: {
          // (a) missing k.email entirely — would not reach the pool even if
          // fully verified.
          missing_email: missingEmailCohort,
          // (b) review_required specifically with an email_ownership_unproven
          // reason recorded on verification_review_reason (set by the
          // verifier's Guard #3 — see lokal-agent-verifier.ts).
          review_required_email_ownership_unproven: reviewRequiredEmailOwnershipUnproven,
          // (c) of (a)+(b): how many have a Brreg-sourced email that would
          // resolve it. HONEST NULL: this schema does not store a Brreg
          // email anywhere (agents.brreg_verified/brreg_flag/brreg_checked_at
          // are org-status flags only, not a fetched email; there is no
          // brreg_email column and no live Brreg-lookup integration wired up
          // in this codebase — see database/init.ts's own
          // "(brreg: no column exists → skipped; needs real lookup)" note on
          // the field_provenance backfill migration). Reporting a fabricated
          // number here would be worse than reporting none — this is
          // explicitly Steg 2/3 (org_nr acquisition + a real Brreg API call),
          // not built in this slice.
          brreg_sourced_email_would_resolve: null,
          brreg_sourced_email_note:
            "No stored Brreg email field exists in this schema and no live Brreg-lookup integration is wired up here — out of scope for this slice (Steg 2/3 of the parent dev-request). Not fabricated.",
        },
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

// GET /admin/outreach-ready-pool — pool rows (capped at 500)
//
// Query params:
//   limit            integer, 1..500 (default 100)
//   dedupe_by_email  bool, default true
//
// When dedupe is on, agents sharing an email are collapsed to one winner
// (highest views_count > highest google_rating*review_count > name asc).
// Suppressed agents stay in the pool (no DB write) — they'll surface in
// a future batch once the chosen one moves into outreach_sent_log.
router.get("/", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);
    const dedupe = parseBool(req.query.dedupe_by_email, true);

    // Pull pool rows enriched with the fields dedupe needs as tiebreakers.
    // We over-fetch (cap 500) when dedupe is on so that after collapsing we
    // still have a reasonable batch — the caller's `limit` is applied AFTER
    // dedupe to honor the contract "max N outreach emails per batch".
    const overFetch = dedupe ? 500 : limit;
    const rows = db
      .prepare(
        `SELECT
            p.*,
            k.google_rating,
            k.google_review_count,
            (SELECT COUNT(*) FROM analytics_agent_views v WHERE v.agent_id = p.agent_id) AS views_count
         FROM outreach_ready_pool p
         INNER JOIN agent_knowledge k ON k.agent_id = p.agent_id
         ORDER BY COALESCE(p.outreach_eligible_at, '9999-12-31') ASC
         LIMIT ?`
      )
      .all(overFetch) as Array<DedupeCandidate & Record<string, unknown>>;

    let agents: typeof rows = rows;
    let suppressed: typeof rows = [];
    let collisions = 0;
    if (dedupe) {
      const result = dedupeByEmail(rows);
      // Re-apply the caller's limit AFTER dedupe (so requested=10 with 3
      // collisions => after_dedup<=10, suppressed counted separately).
      agents = result.selected.slice(0, limit);
      suppressed = result.suppressed;
      collisions = result.emails_with_collisions;
    } else {
      agents = rows.slice(0, limit);
    }

    if (dedupe) {
      // Observability: one log line per batch matching WO-20 spec.
      // eslint-disable-next-line no-console
      console.log(
        `[marketing] dedupe-by-email: requested=${limit}, ` +
          `after_dedup=${agents.length}, suppressed=${suppressed.length} ` +
          `(${collisions} email${collisions === 1 ? "" : "s"} had 2+ agents)`
      );
    }

    res.json({
      success: true,
      count: agents.length,
      agents,
      // Run-envelope-friendly counters (consumed by marketing-comms).
      dedupe_by_email: dedupe,
      dedupe_suppressed_count: suppressed.length,
      dedupe_email_collision_groups: collisions,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: String(err?.message || err) });
  }
});

export default router;
