/**
 * opplevelser-admin-verification-status-breakdown.test.ts — unit tests for
 *
 *   GET /api/opplevelser/admin/verification-status-breakdown
 *
 * dev-request 2026-09-11-experiences-discover-filter-viser-ikke-nye-rader,
 * root-cause investigation round 2 (independent code-reviewer refuted the
 * original "count is page-capped" theory on PR #850 with arithmetic — the
 * observed counts were well below even the default page limit). This
 * read-only, admin-key-gated diagnostic endpoint was added to quantify the
 * REAL mechanism the reviewer traced by hand: the bulk-load admission gate
 * (PR #721) stamping most newly-inserted rows `needs_review` instead of
 * `verified`, so they never clear PUBLISH_GATE_SQL and never show up on
 * /discover even though the apply:true bulk-load call counted them as
 * inserted. GROUP BY verification_status only — no writes, ever.
 *
 * Setup mirrors opplevelser-admin-providers-content-triage.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle().
 *
 * Covers:
 *   (1) unauthenticated request -> 403 (requireAdmin)
 *   (2) no filter: groups the whole table across verified/needs_review/
 *       pending_verify
 *   (3) fylke filter: only rows for that fylke are counted
 *   (4) category filter: only rows for that category are counted
 *   (5) fylke + category together AND, not OR
 *   (6) a filter matching zero rows returns total 0, empty breakdown, not
 *       an error (uses a nonsense fylke name that cannot land in ANY
 *       fylke-reform equivalence class — see (7)'s comment for why a real
 *       fylke like "Finnmark" is no longer a safe zero-match example here)
 *   (7) round-3 fix-up regression (independent reviewer, round 2
 *       CHANGES-REQUESTED): the endpoint's fylke filter must bridge
 *       2020/2024 fylke-reform spellings via fylkeEquivalents() — the SAME
 *       way buildDiscoverWhere() does for /discover — not do a bare
 *       `fylke = @fylke` literal match. A row stored as the pre-2024
 *       DB spelling "Troms og Finnmark" must be counted when queried as
 *       ?fylke=Troms. (This is also why (6)'s zero-match case moved off
 *       "Finnmark": fylkeEquivalents("Finnmark") includes "Troms og
 *       Finnmark", so once this fixture row exists, ?fylke=Finnmark
 *       correctly matches it too — asserting 0 there would no longer be
 *       testing "zero matches", it'd be re-testing this same bridging.)
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const query = opts.query || {};
    const basePath = opts.path || "/";
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method,
      url: basePath + qs,
      originalUrl: basePath + qs,
      path: basePath,
      query,
      params: opts.params || {},
      headers: opts.headers || {},
      body: opts.body,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserAdminVerificationStatusBreakdownTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "admin-verification-status-breakdown-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, expStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = require("./opplevelser") as any;
      const router = opplevelserRouter.default ?? opplevelserRouter;

      // ── Rogaland / mat_drikke: 2 verified, 3 needs_review (the exact
      // shape the dev-request's live probes reported: most inserted rows
      // quarantined, only a couple actually cleared the gate) ────────────
      for (let i = 0; i < 2; i++) {
        expStore.createExperience({
          title: `Rogaland verifisert ${i}`, provider_match_status: "unmatched",
          fylke: "Rogaland", category: "mat_drikke", confidence: "high",
          verification_status: "verified",
        });
      }
      for (let i = 0; i < 3; i++) {
        expStore.createExperience({
          title: `Rogaland karantene ${i}`, provider_match_status: "unmatched",
          fylke: "Rogaland", category: "mat_drikke", confidence: "medium",
          verification_status: "needs_review",
        });
      }
      // A pending_verify Rogaland row in a DIFFERENT category — must not
      // count toward the mat_drikke-filtered numbers.
      expStore.createExperience({
        title: "Rogaland annen kategori", provider_match_status: "unmatched",
        fylke: "Rogaland", category: "overnatting", confidence: "high",
        verification_status: "pending_verify",
      });
      // A verified row in a DIFFERENT fylke — must not count toward the
      // Rogaland-filtered numbers.
      expStore.createExperience({
        title: "Vestland verifisert", provider_match_status: "unmatched",
        fylke: "Vestland", category: "mat_drikke", confidence: "high",
        verification_status: "verified",
      });
      // Round-3 fix-up regression fixture (7): stored under the pre-2024
      // merged DB spelling "Troms og Finnmark" — a ?fylke=Troms query MUST
      // still count it (fylkeEquivalents("Troms") includes "Troms og
      // Finnmark"). category is deliberately NOT mat_drikke/overnatting so
      // this fixture can't accidentally shift the Rogaland/category totals
      // the other test cases above already assert.
      expStore.createExperience({
        title: "Troms og Finnmark regresjon", provider_match_status: "unmatched",
        fylke: "Troms og Finnmark", category: "natur", confidence: "high",
        verification_status: "verified",
      });

      // ── (1) unauthenticated -> 403 ───────────────────────────────────────
      const unauth = await callRoute(router, {
        path: "/admin/verification-status-breakdown",
      });
      assertEq(unauth.status, 403, "unauthenticated request is rejected (403)");

      const authHeaders = { "x-admin-key": testKey };

      // ── (2) no filter: whole-table breakdown ─────────────────────────────
      const all = await callRoute(router, {
        path: "/admin/verification-status-breakdown", headers: authHeaders,
      });
      assertEq(all.status, 200, "no-filter request succeeds");
      assertEq(all.body.total, 8, "no-filter total counts every row");
      assertEq(all.body.breakdown.verified, 4, "no-filter verified count (2 Rogaland + 1 Vestland + 1 Troms og Finnmark)");
      assertEq(all.body.breakdown.needs_review, 3, "no-filter needs_review count");
      assertEq(all.body.breakdown.pending_verify, 1, "no-filter pending_verify count");
      assertEq(all.body.filter, { fylke: null, category: null }, "no-filter echoes null filter");

      // ── (3) fylke filter only ─────────────────────────────────────────────
      const byFylke = await callRoute(router, {
        path: "/admin/verification-status-breakdown", headers: authHeaders,
        query: { fylke: "Rogaland" },
      });
      assertEq(byFylke.status, 200, "fylke-filtered request succeeds");
      assertEq(byFylke.body.total, 6, "fylke=Rogaland total (all 6 Rogaland rows across categories)");
      assertEq(byFylke.body.breakdown.verified, 2, "fylke=Rogaland verified count");
      assertEq(byFylke.body.breakdown.needs_review, 3, "fylke=Rogaland needs_review count");
      assertEq(byFylke.body.breakdown.pending_verify, 1, "fylke=Rogaland pending_verify count");
      assertTrue(byFylke.body.breakdown.verified === undefined ? false : true, "verified key present");

      // ── (4) category filter only ──────────────────────────────────────────
      const byCategory = await callRoute(router, {
        path: "/admin/verification-status-breakdown", headers: authHeaders,
        query: { category: "mat_drikke" },
      });
      assertEq(byCategory.status, 200, "category-filtered request succeeds");
      assertEq(byCategory.body.total, 6, "category=mat_drikke total (2+3 Rogaland + 1 Vestland)");
      assertEq(byCategory.body.breakdown.verified, 3, "category=mat_drikke verified count");
      assertEq(byCategory.body.breakdown.needs_review, 3, "category=mat_drikke needs_review count");

      // ── (5) fylke + category together (AND, the exact slice the
      // dev-request quantified) ─────────────────────────────────────────────
      const both = await callRoute(router, {
        path: "/admin/verification-status-breakdown", headers: authHeaders,
        query: { fylke: "Rogaland", category: "mat_drikke" },
      });
      assertEq(both.status, 200, "fylke+category request succeeds");
      assertEq(both.body.total, 5, "fylke=Rogaland&category=mat_drikke total (excludes the other-category row)");
      assertEq(both.body.breakdown.verified, 2, "fylke=Rogaland&category=mat_drikke verified count");
      assertEq(both.body.breakdown.needs_review, 3, "fylke=Rogaland&category=mat_drikke needs_review count");
      assertEq(both.body.breakdown.pending_verify, undefined, "fylke=Rogaland&category=mat_drikke has no pending_verify row");

      // ── (6) filter matching zero rows -> total 0, empty breakdown, not
      // an error. NOTE: this used to query ?fylke=Finnmark, but "Finnmark"
      // is itself a fylke-reform-era name (fylkeEquivalents("Finnmark")
      // includes "Troms og Finnmark") — after the round-3 fix that bridges
      // reform spellings, that query would correctly start matching the
      // "Troms og Finnmark" fixture added for (7) below, so it's no longer
      // a valid "definitely zero" example. Use a nonsense fylke name
      // instead: fylkeEquivalents() falls back to literal-only matching for
      // anything it doesn't recognise, so this is guaranteed zero
      // regardless of fixture data. ─────────────────────────────────────
      const empty = await callRoute(router, {
        path: "/admin/verification-status-breakdown", headers: authHeaders,
        query: { fylke: "Ikke-En-Fylke" },
      });
      assertEq(empty.status, 200, "zero-match request still succeeds");
      assertEq(empty.body.total, 0, "zero-match total is 0");
      assertEq(empty.body.breakdown, {}, "zero-match breakdown is empty, not an error");

      // ── (7) round-3 fix-up regression: fylke-equivalence bridging.
      // ?fylke=Troms must count the row stored as "Troms og Finnmark" —
      // the exact case a bare `fylke = @fylke` literal match would miss
      // (round-2 independent-reviewer finding) ────────────────────────────
      const byTroms = await callRoute(router, {
        path: "/admin/verification-status-breakdown", headers: authHeaders,
        query: { fylke: "Troms" },
      });
      assertEq(byTroms.status, 200, "fylke=Troms request succeeds");
      assertEq(byTroms.body.total, 1, "fylke=Troms counts the 'Troms og Finnmark'-stored row");
      assertEq(byTroms.body.breakdown.verified, 1, "fylke=Troms verified count");
      assertEq(byTroms.body.filter, { fylke: "Troms", category: null }, "fylke=Troms echoes the queried (not resolved) fylke value");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-admin-verification-status-breakdown: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-admin-verification-status-breakdown.test.ts`
if (require.main === module) {
  runOpplevelserAdminVerificationStatusBreakdownTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
