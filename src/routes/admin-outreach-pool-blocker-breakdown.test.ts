/**
 * admin-outreach-pool-blocker-breakdown.test.ts — tests the `blocker_breakdown`
 * diagnostic added to GET /admin/outreach-ready-pool/stats (src/routes/
 * admin-outreach-pool.ts), dev-request 2026-07-27-outreach-blocker-diag
 * (Steg 1).
 *
 * blocker_breakdown explains why the pending_verify/review_required cohort
 * never reaches verified/pool: per-gating-field (address/phone) source_count
 * distribution (incl. the Tier of the lone source in the source_count===1
 * bucket), an address/phone cross-tab, a 3-way split of the EXISTING
 * pool_funnel.url_fresh_and_ok gate's failure count, an enrichment_status=
 * 'thin' breakdown, a no-website count, and an email-first breakdown.
 *
 * Mirrors homepage-provenance-low-quality-selector.test.ts's convention:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)), no
 *     HTTP server / supertest.
 *   - exported runAdminOutreachPoolBlockerBreakdownTests({log}) -> TestSummary;
 *     wired into tests/test.ts.
 *     Standalone: npx tsx src/routes/admin-outreach-pool-blocker-breakdown.test.ts
 *
 * Fixture design (all counts hand-computed and asserted below):
 *
 *   Cohort (verification_status IN ('pending_verify','review_required'),
 *   umbrella_type IS NULL) — 7 agents, c-1..c-7:
 *     c-1  zero/zero provenance, no email, no website  -> blocked_both, zero/zero
 *     c-2  address 1-source(homepage/A), phone 1-source(brreg/B) -> blocked_both
 *     c-3  address 2 agreeing(A), phone 1-source(brreg/B) -> blocked_phone_only
 *     c-4  address 1-source(google_places/A), phone 2 agreeing(A+B) -> blocked_address_only
 *     c-5  address 2 agreeing, phone 2 agreeing, but still in cohort
 *          (simulates a non-address/phone blocker, e.g. domain-coherence)
 *          -> blocked_neither; also stamped enrichment_status='thin'
 *     c-6  zero/zero provenance, thin (short about) -> blocked_both, thin
 *     c-7  zero/zero provenance, review_required with
 *          verification_review_reason.email_ownership_unproven=true -> blocked_both
 *
 *   Excluded from the cohort (must not affect any count):
 *     x-umbrella   umbrella_type set, otherwise pending_verify
 *     (the pool_funnel url-split fixtures below are verification_status=
 *      'verified', already excluded from the pending_verify/review_required
 *      cohort by construction)
 *
 *   pool_funnel.with_email cohort (verified + rich/partial + email present)
 *   for the url_freshness_failure_split — 5 agents, u-1..u-5:
 *     u-1  fresh probe, 2xx -> passes (not in any failure bucket)
 *     u-2  no website/url at all -> no_website_at_all
 *     u-3  has website, probed 40 days ago, 2xx -> stale_over_30_days
 *     u-4  has website, never probed -> stale_over_30_days
 *     u-5  has website, freshly probed, 404 -> bad_http_status
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runAdminOutreachPoolBlockerBreakdownTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevDb = initMod.getDb();
    const testKey = process.env.ADMIN_KEY || "admin-outreach-pool-blocker-breakdown-test-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = testKey;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, trust_score, umbrella_type)
         VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 0.8, ?)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, website, email, about, products, address, field_provenance,
            verification_status, enrichment_status, verification_review_reason,
            url_last_probed, url_last_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const daysAgo = (n: number): string =>
        (db.prepare(`SELECT datetime('now', ?) AS d`).get(`-${n} days`) as { d: string }).d;

      const LONG_ABOUT = "x".repeat(90); // >=80 chars -> not thin on its own
      const CLEAN_PRODUCTS = '[{"name":"Poteter"}]';

      function addAgent(f: {
        id: string;
        umbrellaType: string | null;
        website: string | null;
        agentUrl: string | null;
        email: string | null;
        about: string | null;
        products: string;
        address: string | null;
        fieldProvenance: Record<string, unknown>;
        verificationStatus: string;
        enrichmentStatus: string;
        reviewReason?: Record<string, unknown>;
        urlLastProbedDaysAgo?: number | null;
        urlLastStatus?: number | null;
      }): void {
        // agents.contact_email is a separate NOT NULL column from
        // agent_knowledge.email (which is what blocker_breakdown's
        // missing_email check reads) — always give it a dummy non-null
        // value so f.email=null fixtures (testing missing k.email) don't
        // trip the agents-table constraint.
        insertAgent.run(f.id, f.id, `${f.id} description`, `${f.id}@dummy.invalid`, f.agentUrl, `key-${f.id}`, f.umbrellaType);
        insertKnowledge.run(
          f.id,
          f.website,
          f.email,
          f.about,
          f.products,
          f.address,
          JSON.stringify(f.fieldProvenance),
          f.verificationStatus,
          f.enrichmentStatus,
          JSON.stringify(f.reviewReason ?? {}),
          f.urlLastProbedDaysAgo == null ? null : daysAgo(f.urlLastProbedDaysAgo),
          f.urlLastStatus === undefined ? null : f.urlLastStatus,
        );
      }

      // ── Cohort fixtures (pending_verify / review_required, non-umbrella) ──
      addAgent({
        id: "c-1", umbrellaType: null, website: null, agentUrl: '', email: null,
        about: LONG_ABOUT, products: "[]", address: null,
        fieldProvenance: {},
        verificationStatus: "pending_verify", enrichmentStatus: "partial",
      });
      addAgent({
        id: "c-2", umbrellaType: null, website: "https://c2.no", agentUrl: "https://c2.no", email: "post@c2.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr 2",
        fieldProvenance: {
          address: [{ value: "Storgata 1, 0150 Oslo", source_type: "homepage", fetched_at: "2026-01-01" }],
          phone: [{ value: "91111111", source_type: "brreg", fetched_at: "2026-01-01" }],
        },
        verificationStatus: "review_required", enrichmentStatus: "partial",
      });
      addAgent({
        id: "c-3", umbrellaType: null, website: "https://c3.no", agentUrl: "https://c3.no", email: "post@c3.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr 3",
        fieldProvenance: {
          address: [
            { value: "Kirkeveien 2, 0350 Oslo", source_type: "homepage", fetched_at: "2026-01-01" },
            { value: "Kirkeveien 2, 0350 Oslo", source_type: "google_places", fetched_at: "2026-01-01" },
          ],
          phone: [{ value: "92222222", source_type: "brreg", fetched_at: "2026-01-01" }],
        },
        verificationStatus: "pending_verify", enrichmentStatus: "partial",
      });
      addAgent({
        id: "c-4", umbrellaType: null, website: "https://c4.no", agentUrl: "https://c4.no", email: "post@c4.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr 4",
        fieldProvenance: {
          address: [{ value: "Bakkegata 9, 4630 Kristiansand", source_type: "google_places", fetched_at: "2026-01-01" }],
          phone: [
            { value: "93333333", source_type: "homepage", fetched_at: "2026-01-01" },
            { value: "93333333", source_type: "facebook_official_page", fetched_at: "2026-01-01" },
          ],
        },
        verificationStatus: "review_required", enrichmentStatus: "partial",
      });
      addAgent({
        id: "c-5", umbrellaType: null, website: "https://c5.no", agentUrl: "https://c5.no", email: "post@c5.no",
        about: null, products: "[]", address: null,
        fieldProvenance: {
          address: [
            { value: "Kirkeveien 2, 0350 Oslo", source_type: "homepage", fetched_at: "2026-01-01" },
            { value: "Kirkeveien 2, 0350 Oslo", source_type: "google_places", fetched_at: "2026-01-01" },
          ],
          phone: [
            { value: "93333333", source_type: "homepage", fetched_at: "2026-01-01" },
            { value: "93333333", source_type: "facebook_official_page", fetched_at: "2026-01-01" },
          ],
        },
        verificationStatus: "review_required", enrichmentStatus: "thin",
      });
      addAgent({
        id: "c-6", umbrellaType: null, website: "https://c6.no", agentUrl: "https://c6.no", email: "post@c6.no",
        about: "short", products: "[]", address: null,
        fieldProvenance: {},
        verificationStatus: "pending_verify", enrichmentStatus: "thin",
      });
      addAgent({
        id: "c-7", umbrellaType: null, website: "https://c7.no", agentUrl: "https://c7.no", email: "post@c7.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr 7",
        fieldProvenance: {},
        verificationStatus: "review_required", enrichmentStatus: "partial",
        reviewReason: { address: { verdict: "data_insufficient" }, phone: { verdict: "data_insufficient" }, email_ownership_unproven: true },
      });

      // ── Excluded: umbrella-tagged, otherwise identical to a blocked-both
      // cohort member — must not leak into any blocker_breakdown count.
      addAgent({
        id: "x-umbrella", umbrellaType: "market_network", website: null, agentUrl: '', email: null,
        about: null, products: "[]", address: null,
        fieldProvenance: {},
        verificationStatus: "pending_verify", enrichmentStatus: "thin",
      });

      // ── pool_funnel.with_email cohort for url_freshness_failure_split ──
      // (verified + rich/partial + email present, non-umbrella) — a
      // DIFFERENT cohort from the pending_verify/review_required one above;
      // 'verified' status already excludes these from the blocker cohort.
      addAgent({
        id: "u-1", umbrellaType: null, website: "https://u1.no", agentUrl: "https://u1.no", email: "post@u1.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr U1",
        fieldProvenance: {}, verificationStatus: "verified", enrichmentStatus: "rich",
        urlLastProbedDaysAgo: 1, urlLastStatus: 200,
      });
      addAgent({
        id: "u-2", umbrellaType: null, website: null, agentUrl: '', email: "post@u2.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr U2",
        fieldProvenance: {}, verificationStatus: "verified", enrichmentStatus: "partial",
        urlLastProbedDaysAgo: null, urlLastStatus: undefined,
      });
      addAgent({
        id: "u-3", umbrellaType: null, website: "https://u3.no", agentUrl: "https://u3.no", email: "post@u3.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr U3",
        fieldProvenance: {}, verificationStatus: "verified", enrichmentStatus: "rich",
        urlLastProbedDaysAgo: 40, urlLastStatus: 200,
      });
      addAgent({
        id: "u-4", umbrellaType: null, website: "https://u4.no", agentUrl: "https://u4.no", email: "post@u4.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr U4",
        fieldProvenance: {}, verificationStatus: "verified", enrichmentStatus: "partial",
        urlLastProbedDaysAgo: null, urlLastStatus: undefined,
      });
      addAgent({
        id: "u-5", umbrellaType: null, website: "https://u5.no", agentUrl: "https://u5.no", email: "post@u5.no",
        about: LONG_ABOUT, products: CLEAN_PRODUCTS, address: "Adr U5",
        fieldProvenance: {}, verificationStatus: "verified", enrichmentStatus: "rich",
        urlLastProbedDaysAgo: 1, urlLastStatus: 404,
      });

      delete require.cache[require.resolve("./admin-outreach-pool")];
      const statsRouteMod = require("./admin-outreach-pool");
      const statsRouter = statsRouteMod.default;

      const result = await callRoute(statsRouter, {
        method: "GET",
        url: "/stats",
        headers: { "x-admin-key": testKey },
      });
      assertEq(result.status, 200, "bb-01: GET /admin/outreach-ready-pool/stats -> 200");
      assertTrue(!!result.body?.blocker_breakdown, "bb-02: response includes a blocker_breakdown object");
      const bb = result.body?.blocker_breakdown ?? {};

      // ── existing fields unchanged (still present) ───────────────────────
      assertTrue(!!result.body?.pool_funnel, "bb-03: pool_funnel is still present (existing field unchanged)");
      assertTrue(!!result.body?.low_quality_cohort, "bb-04: low_quality_cohort is still present (existing field unchanged)");

      // ── cohort_total / cohort_by_status ─────────────────────────────────
      assertEq(bb.cohort_total, 7, "bb-05: cohort_total counts exactly the 7 non-umbrella pending_verify/review_required fixtures (x-umbrella and the u-* verified fixtures excluded)");
      assertEq(bb.cohort_by_status, { pending_verify: 3, review_required: 4 },
        "bb-06: cohort_by_status splits into pending_verify (c-1,c-3,c-6) and review_required (c-2,c-4,c-5,c-7)");

      // ── gating_field_source_counts ───────────────────────────────────────
      assertEq(bb.gating_field_source_counts.address,
        { zero: 3, one: 2, two_plus: 2, one_source_tier: { S: 0, A: 2, B: 0, C: 0 } },
        "bb-07: address source_count distribution — zero: c-1,c-6,c-7; one: c-2,c-4 (both Tier A); two_plus: c-3,c-5");
      assertEq(bb.gating_field_source_counts.phone,
        { zero: 3, one: 2, two_plus: 2, one_source_tier: { S: 0, A: 0, B: 2, C: 0 } },
        "bb-08: phone source_count distribution — zero: c-1,c-6,c-7; one: c-2,c-3 (both Tier B, brreg); two_plus: c-4,c-5");

      // ── address_phone_cross_tab (must reconcile to cohort_total) ────────
      assertEq(bb.address_phone_cross_tab,
        { blocked_address_only: 1, blocked_phone_only: 1, blocked_both: 4, blocked_neither: 1, total: 7 },
        "bb-09: cross-tab — address_only: c-4; phone_only: c-3; both: c-1,c-2,c-6,c-7; neither: c-5");
      assertEq(
        bb.address_phone_cross_tab.blocked_address_only + bb.address_phone_cross_tab.blocked_phone_only +
        bb.address_phone_cross_tab.blocked_both + bb.address_phone_cross_tab.blocked_neither,
        bb.cohort_total,
        "bb-10: reconciliation — cross-tab buckets sum to cohort_total",
      );

      // ── url_freshness_failure_split (pool_funnel.with_email cohort) ─────
      assertEq(result.body.pool_funnel.with_email, 5, "bb-11: pool_funnel.with_email counts the 5 u-* fixtures");
      assertEq(result.body.pool_funnel.url_fresh_and_ok, 1, "bb-12: pool_funnel.url_fresh_and_ok — only u-1 passes");
      assertEq(bb.url_freshness_failure_split.base_cohort_total, 5, "bb-13: url_freshness_failure_split.base_cohort_total == pool_funnel.with_email");
      assertEq(bb.url_freshness_failure_split.passing, 1, "bb-14: url_freshness_failure_split.passing == pool_funnel.url_fresh_and_ok");
      assertEq(bb.url_freshness_failure_split.failing_total, 4, "bb-15: failing_total == with_email(5) - url_fresh_and_ok(1) == 4");
      assertEq(bb.url_freshness_failure_split.no_website_at_all, 1, "bb-16: no_website_at_all — only u-2");
      assertEq(bb.url_freshness_failure_split.stale_over_30_days, 2, "bb-17: stale_over_30_days — u-3 (40d-old probe) + u-4 (never probed)");
      assertEq(bb.url_freshness_failure_split.bad_http_status, 1, "bb-18: bad_http_status — only u-5 (404)");
      assertEq(
        bb.url_freshness_failure_split.no_website_at_all + bb.url_freshness_failure_split.stale_over_30_days +
        bb.url_freshness_failure_split.bad_http_status,
        bb.url_freshness_failure_split.failing_total,
        "bb-19: reconciliation — the 3-way url-freshness split sums to failing_total (splitting doesn't change the existing gate's total)",
      );

      // ── thin_enrichment ───────────────────────────────────────────────────
      assertEq(bb.thin_enrichment, { total: 2, short_about: 2, no_products: 2, no_address: 2 },
        "bb-20: thin_enrichment — c-5 and c-6 are the only enrichment_status='thin' cohort members; both fail all three sub-signals");

      // ── no_website_at_all_count ───────────────────────────────────────────
      assertEq(bb.no_website_at_all_count, 1, "bb-21: no_website_at_all_count — only c-1 has no website/agent-url at all");

      // ── email_first_breakdown ─────────────────────────────────────────────
      assertEq(bb.email_first_breakdown.missing_email, 1, "bb-22: email_first_breakdown.missing_email — only c-1 has no email");
      assertEq(bb.email_first_breakdown.review_required_email_ownership_unproven, 1,
        "bb-23: review_required_email_ownership_unproven — only c-7 is review_required with that reason flag (c-2/c-4/c-5 are review_required without it)");
      assertEq(bb.email_first_breakdown.brreg_sourced_email_would_resolve, null,
        "bb-24: brreg_sourced_email_would_resolve is honestly null — no stored Brreg-email field / live lookup exists in this schema, not fabricated");
      assertTrue(typeof bb.email_first_breakdown.brreg_sourced_email_note === "string" && bb.email_first_breakdown.brreg_sourced_email_note.length > 0,
        "bb-25: brreg_sourced_email_note explains why the sub-count is null");
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminOutreachPoolBlockerBreakdownTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
