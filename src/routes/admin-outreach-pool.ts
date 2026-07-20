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
