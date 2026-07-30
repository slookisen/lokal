/**
 * opplevelser-admin-providers-content-triage.test.ts — unit tests for the
 * berikelsestriage route on src/routes/opplevelser.ts:
 *
 *   - GET /api/opplevelser/admin/providers/content-triage
 *
 * dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2:
 * enumerates the full catalog (same keyset `after`/`next_after` pagination
 * contract as GET /admin/providers/all, for the identical delete-race reason
 * — see that route's own doc comment / opplevelser-admin-providers-all.test.ts)
 * and additionally classifies every provider into exactly one of
 * enrichable/done/waiting via `classifyProviderContentBucket` — the SAME
 * shared function `selectProvidersForContentRefresh` (the live selector)
 * calls, so this endpoint's buckets can never independently drift from what
 * the live selector actually does.
 *
 * Setup mirrors opplevelser-admin-providers-all.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle().
 *
 * Covers:
 *   (1) unauthenticated request -> 403 (requireAdmin)
 *   (2) bucket-sum invariant: enrichable + done + waiting == catalog size
 *       (acceptance criterion 1 — no row unsorted)
 *   (3) waiting: a provider with no hjemmeside and no experience evidence_url
 *   (4) enrichable: a provider with hjemmeside + a blank live experience
 *   (5) enrichable: a provider with hjemmeside + an AGGREGATOR-sourced
 *       non-blank experience (acceptance criterion 3 — the per-field
 *       provenance screen, not a naive "non-blank -> done" check)
 *   (5b) enrichable: a provider whose experience was created the way the
 *       LIVE /admin/bulk-load new-experience branch actually does it —
 *       straight `createExperience({ category: ..., evidence_url: ...,
 *       discovery_source: "bulk-load", ... })`, never touched by
 *       applyExperienceContent afterward. This is the exact fix-up
 *       regression case (independent review, round after slice 2's initial
 *       approval): createExperience() never wrote content_field_evidence at
 *       insert time, so this provider's category, sourced straight from a
 *       harvest row, was silently classified `done` under the old
 *       "no evidence entry -> unknown, keep as homepage-sourced" default —
 *       identical to the pre-slice-2 bug, just relocated from the UPDATE
 *       path to the INSERT path.
 *   (6) done: a provider with hjemmeside + a genuinely homepage-sourced
 *       experience
 *   (7) done: a provider with hjemmeside + zero live experiences
 *   (8) a catalog_hidden=1 row never appears, never counts toward total
 *   (9) keyset pagination across pages (mirrors opplevelser-admin-providers-
 *       all.test.ts's own pagination coverage)
 *  (10) response shape: each row carries exactly id/navn/hjemmeside/bucket
 *  (11) idempotency: calling the route twice with an unchanged DB yields the
 *       identical bucket for every provider
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

export function runOpplevelserAdminProvidersContentTriageTests(
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
    const testKey = "admin-providers-content-triage-test-key";
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
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── (3) waiting: no hjemmeside, no experience at all ────────────────
      const provWaiting = expStore.createProvider({
        navn: "Venter Gard AS", org_nr: "900001001",
        fylke: "Vestland", kommune: "Bergen",
        brreg_verified: 0, verification_status: "pending_verify",
      });

      // ── (4) enrichable: hjemmeside + a blank live experience ────────────
      const provEnrichableBlank = expStore.createProvider({
        navn: "Blank Gard AS", org_nr: "900001002",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.blankgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Blank opplevelse", provider_id: provEnrichableBlank, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });

      // ── (5) enrichable: hjemmeside + AGGREGATOR-sourced non-blank content ──
      const provEnrichableAgg = expStore.createProvider({
        navn: "Aggregert Gard AS", org_nr: "900001003",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.aggregertgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expAggId = expStore.createExperience({
        title: "Aggregert opplevelse", provider_id: provEnrichableAgg, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });
      expStore.applyExperienceContent(
        expAggId,
        { description: "Aggregert tekst.", category: "mat_drikke" },
        "https://visitnorway.com/found-here",
      );

      // ── (5b) enrichable: hjemmeside + a NEW-EXPERIENCE-BRANCH bulk-load
      // insert whose DESCRIPTION is later filled from the REAL homepage —
      // reproduces EXACTLY the fix-up regression the reviewer described,
      // not just a superficial variant of it. `category` is set the way
      // POST /admin/bulk-load's live new-experience branch actually does it
      // (opplevelser.ts): a straight createExperience() call with category
      // from a harvested row, evidence_url pointing at the third-party
      // listing, discovery_source: "bulk-load" — crucially with NO
      // applyExperienceContent() call at all (unlike (5) above), so under
      // the old code content_field_evidence stayed NULL for `category`
      // forever. `description` is deliberately BLANK at insert (bulk-load's
      // BulkRowSchema carries no description field at all — ground-truthed
      // against the real schema) and is filled AFTERWARD by an ordinary,
      // later content-refresh pass via a GENUINE homepage sourceUrl. That
      // second step is required to reproduce the bug at all: with
      // description left NULL, isExperienceContentGenuinelyThin's
      // description check alone already forces `enrichable` regardless of
      // category's provenance, masking the defect. Once description is
      // genuinely homepage-sourced, applyExperienceContent's fill-only-blank
      // gate skips category (it is already non-blank from the bulk-load
      // insert), so category's provenance is decided ENTIRELY by whatever
      // createExperience() stamped at insert time — exactly the code path
      // this fix-up changes.
      const provEnrichableBulkLoad = expStore.createProvider({
        navn: "Bulklastet Gard AS", org_nr: "900001007",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.bulklastetgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expBulkLoadId = expStore.createExperience({
        title: "Bulklastet opplevelse", provider_id: provEnrichableBulkLoad, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "needs_review",
        category: "mat_drikke", evidence_url: "https://visitnorway.com/bulk-harvest-row",
        discovery_source: "bulk-load",
      });
      expStore.applyExperienceContent(
        expBulkLoadId,
        { description: "Ekte beskrivelse hentet fra gårdens egen hjemmeside." },
        "https://www.bulklastetgard.no/om-oss",
      );

      // ── (6) done: hjemmeside + genuinely homepage-sourced content ───────
      const provDone = expStore.createProvider({
        navn: "Ferdig Gard AS", org_nr: "900001004",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.ferdiggard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expDoneId = expStore.createExperience({
        title: "Ferdig opplevelse", provider_id: provDone, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });
      expStore.applyExperienceContent(
        expDoneId,
        { description: "Ekte tekst fra egen side.", category: "mat_drikke" },
        "https://www.ferdiggard.no/om-oss",
      );

      // ── (7) done: hjemmeside + zero live experiences ─────────────────────
      const provDoneEmpty = expStore.createProvider({
        navn: "Tom Gard AS", org_nr: "900001005",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.tomgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // ── (8) catalog_hidden=1 row must never appear/count ─────────────────
      const provHidden = expStore.createProvider({
        navn: "Skjult Gard AS", org_nr: "900001006",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.skjultgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expDb.prepare("UPDATE experience_providers SET catalog_hidden = 1 WHERE id = ?").run(provHidden);

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (1) 403 without X-Admin-Key ──────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { path: "/admin/providers/content-triage" });
      assertEq(noKey.status, 403, "1: without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "2: no-key response carries no providers payload");

      // ── fetch everything in one page (test catalog is small) ────────────
      const all = await callRoute(opplevelserRouter, {
        path: "/admin/providers/content-triage",
        headers: { "x-admin-key": testKey },
        query: { limit: "1000", after: "" },
      });
      assertEq(all.status, 200, "3: 200 with a valid key");
      assertEq(all.body.success, true, "4: success:true");

      const byId: Record<string, any> = {};
      for (const p of all.body.providers as any[]) byId[p.id] = p;

      // ── (8) hidden row excluded ───────────────────────────────────────────
      assertTrue(!byId[provHidden], "5: catalog_hidden=1 row never appears");
      assertEq(all.body.total, 6, "6: total excludes the catalog_hidden=1 row (6 visible providers)");
      assertEq(all.body.count, 6, "7: count == total for a single full-window fetch");

      // ── (3)/(4)/(5)/(5b)/(6)/(7) per-provider bucket assertions ──────────
      assertEq(byId[provWaiting].bucket, "waiting", "8: no hjemmeside, no experiences -> waiting");
      assertEq(byId[provEnrichableBlank].bucket, "enrichable", "9: hjemmeside + blank experience -> enrichable");
      assertEq(
        byId[provEnrichableAgg].bucket,
        "enrichable",
        "10: hjemmeside + AGGREGATOR-sourced non-blank content -> STILL enrichable (acceptance criterion 3 — the core fix)",
      );
      assertEq(byId[provDone].bucket, "done", "11: hjemmeside + genuinely homepage-sourced content -> done");
      assertEq(byId[provDoneEmpty].bucket, "done", "12: hjemmeside + zero live experiences -> done (documented edge case)");
      assertEq(
        byId[provEnrichableBulkLoad].bucket,
        "enrichable",
        "12b: hjemmeside + a provider whose only experience came through createExperience()'s bulk-load-shaped new-row branch (category from a harvest row, evidence_url set, content_field_evidence never stamped by applyExperienceContent) -> STILL enrichable, NOT done — the fix-up regression case",
      );

      // ── (2) bucket-sum invariant: acceptance criterion 1 ─────────────────
      const buckets = { enrichable: 0, done: 0, waiting: 0 } as Record<string, number>;
      for (const p of all.body.providers as any[]) {
        assertTrue(
          p.bucket === "enrichable" || p.bucket === "done" || p.bucket === "waiting",
          `13/${p.id}: bucket is one of the three defined values (got ${p.bucket})`,
        );
        buckets[p.bucket] = (buckets[p.bucket] || 0) + 1;
      }
      const sum = buckets.enrichable + buckets.done + buckets.waiting;
      assertEq(sum, all.body.total, "14: sum(enrichable, done, waiting) == catalog total — no row unsorted");
      assertEq(sum, (all.body.providers as any[]).length, "15: sum(buckets) == number of rows served this page");

      // ── (10) response shape ───────────────────────────────────────────────
      assertEq(
        Object.keys(byId[provWaiting]).sort(),
        ["bucket", "hjemmeside", "id", "navn"].sort(),
        "16: each row carries exactly id/navn/hjemmeside/bucket",
      );
      assertEq(
        Object.keys(all.body).sort(),
        ["count", "limit", "next_after", "providers", "success", "total"].sort(),
        "17: top-level response shape matches GET /admin/providers/all's own contract",
      );

      // ── (9) keyset pagination across pages ────────────────────────────────
      const page1 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/content-triage",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", after: "" },
      });
      assertEq(page1.body.count, 2, "18: page1 respects limit=2");
      const page2 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/content-triage",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", after: page1.body.next_after },
      });
      const page3 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/content-triage",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", after: page2.body.next_after },
      });
      const page4 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/content-triage",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", after: page3.body.next_after },
      });
      const stitched = [...page1.body.providers, ...page2.body.providers, ...page3.body.providers, ...page4.body.providers];
      assertEq(stitched.length, 6, "19: pagination across 3 non-empty pages (2+2+2) stitches to exactly 6 rows");
      assertEq(page4.body.count, 0, "20: the page after exhaustion is empty");
      assertEq(page4.body.next_after, null, "21: next_after is null once exhausted");
      // Bucket assigned to a given id must be IDENTICAL whether read from the
      // single full-window fetch or from the paginated walk.
      const stitchedById: Record<string, any> = {};
      for (const p of stitched) stitchedById[p.id] = p;
      for (const id of Object.keys(byId)) {
        assertEq(stitchedById[id]?.bucket, byId[id].bucket, `22/${id}: bucket identical across full-fetch vs. paginated walk`);
      }

      // ── (11) idempotency: unchanged DB -> identical buckets on re-fetch ──
      const again = await callRoute(opplevelserRouter, {
        path: "/admin/providers/content-triage",
        headers: { "x-admin-key": testKey },
        query: { limit: "1000", after: "" },
      });
      const againById: Record<string, any> = {};
      for (const p of again.body.providers as any[]) againById[p.id] = p;
      for (const id of Object.keys(byId)) {
        assertEq(againById[id]?.bucket, byId[id].bucket, `23/${id}: idempotent — identical bucket on a second, unchanged-DB fetch`);
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-admin-providers-content-triage: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-admin-providers-content-triage.test.ts`
if (require.main === module) {
  runOpplevelserAdminProvidersContentTriageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
