/**
 * opplevelser-dedup-backfill.test.ts — DB-integration tests for the dedup
 * pass (dev-request 2026-07-04-opplevagent-katalog-dedup, item 1).
 *
 * experience-dedup.test.ts covers the PURE matching/clustering/canonical-
 * picking logic in isolation. This file covers the parts that need a real
 * (in-memory) DB and the actual routes:
 *   (a) POST /api/opplevelser/admin/dedup-backfill requires X-Admin-Key
 *   (b) dry-run finds the cluster but writes nothing
 *   (c) apply=true merges the cluster (sets canonical_experience_id) and is
 *       idempotent on immediate re-run (0 new clusters)
 *   (d) PUBLISH-GATE EXCLUSION: after merge, the duplicate row disappears
 *       from listPublishedExperiences()/discoverExperiences()/
 *       getPublishedExperienceBySlug(), while the canonical row still shows
 *   (e) DETAIL-PAGE REDIRECT: GET /opplevelse/<merged-duplicate-slug> 301s
 *       to /opplevelse/<canonical-slug>; an unknown slug still 404s (next())
 *   (f) HARVESTER GUARD: experienceExistsForProvider() catches a fuzzy
 *       same-provider near-duplicate title, not just an exact match
 *
 * Mirrors opplevelser-discover-tags.test.ts's EXPERIENCES_DB_PATH=":memory:"
 * + require-cache-reset pattern and its router.handle(fakeReq, fakeRes)
 * callRoute() helper (both routers under test here are plain sync
 * Express handlers, so no real HTTP server is needed — see
 * experiences-llms-examples.test.ts's doc comment for when that IS needed).
 *
 * Run standalone: npx tsx src/routes/opplevelser-dedup-backfill.test.ts
 * Wired into the gate via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  handled: boolean;
  status: number;
  body: any;
  redirectedTo?: string;
}

function callRoute(
  router: any,
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: any } = {}
): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers = opts.headers || {};
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
      send(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
      setHeader() {
        return this;
      },
      redirect(codeOrUrl: number | string, maybeUrl?: string) {
        const code = typeof codeOrUrl === "number" ? codeOrUrl : 302;
        const url2 = typeof codeOrUrl === "string" ? codeOrUrl : (maybeUrl as string);
        resolve({ handled: true, status: code, body: undefined, redirectedTo: url2 });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: err ? 500 : 404, body: err ? String(err) : null });
    });
  });
}

export function runOpplevelserDedupBackfillTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = "test-admin-key";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const expDedupPath = require.resolve("../services/experience-dedup");
    const opplevelserPath = require.resolve("./opplevelser");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, expDedupPath, opplevelserPath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── Fixture: a duplicate cluster (near-dup titles, same provider,
      // same kommune) + one unrelated control row that must survive untouched. ──
      const providerId = expStore.createProvider({
        navn: "Kon-Tiki Museet AS", fylke: "Oslo", kommune: "Oslo",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      const thinId = expStore.createExperience({
        title: "Kon-Tiki Museet", provider_id: providerId, provider_match_status: "matched",
        kommune: "Oslo", fylke: "Oslo", verification_status: "verified", confidence: "high",
      });
      const richId = expStore.createExperience({
        title: "Kon-Tiki Museum", provider_id: providerId, provider_match_status: "matched",
        kommune: "Oslo", fylke: "Oslo", verification_status: "verified", confidence: "high",
        description: "Et av Norges mest besøkte museer, ved sjøkanten på Bygdøy.",
        booking_url: "https://kon-tiki.no/billetter",
        price_band: "standard", price_from: 150, duration_min: 60,
      });
      const controlId = expStore.createExperience({
        title: "Norsk Folkemuseum", provider_id: providerId, provider_match_status: "matched",
        kommune: "Oslo", fylke: "Oslo", verification_status: "verified", confidence: "high",
      });

      const thinSlug = expStore.getExperienceById(thinId)?.slug as string;
      const richSlug = expStore.getExperienceById(richId)?.slug as string;

      // ── (a) admin-key gate ──────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, "POST", "/admin/dedup-backfill", {});
      assertEq(noKey.status, 403, "a1: dedup-backfill without X-Admin-Key -> 403");

      // ── (b) dry-run finds the cluster, writes nothing ───────────────
      const dry = await callRoute(opplevelserRouter, "POST", "/admin/dedup-backfill", {
        headers: { "x-admin-key": "test-admin-key" },
      });
      assertEq(dry.status, 200, "b1: dry-run returns 200");
      assertEq(dry.body.dry_run, true, "b2: dry_run:true by default");
      assertEq(dry.body.clusters_found, 1, "b3: dry-run finds exactly the 1 Kon-Tiki cluster");
      assertEq(dry.body.rows_merged, 1, "b4: dry-run reports 1 row WOULD be merged (thin dup, not the control row)");
      assertEq(dry.body.merges[0]?.canonical_id, richId, "b5: dry-run picks the richer row as canonical");
      assertEq(dry.body.merges[0]?.duplicate_ids, [thinId], "b6: dry-run's duplicate is the thin row, not the control row");

      const stillUnmerged = expStore.getExperienceById(thinId) as any;
      assertEq(stillUnmerged.canonical_experience_id ?? null, null, "b7: dry-run wrote NOTHING to the DB (row still unmerged)");

      // ── (c) apply=true merges + is idempotent on re-run ──────────────
      const apply = await callRoute(opplevelserRouter, "POST", "/admin/dedup-backfill?apply=true", {
        headers: { "x-admin-key": "test-admin-key" },
      });
      assertEq(apply.status, 200, "c1: apply returns 200");
      assertEq(apply.body.dry_run, false, "c2: dry_run:false when apply=true");
      assertEq(apply.body.clusters_found, 1, "c3: apply finds+merges the 1 cluster");
      assertEq(apply.body.rows_merged, 1, "c4: apply reports 1 row actually merged");

      const rowAfterMerge = expStore.getExperienceById(thinId) as any;
      // getExperienceById reads raw columns, but the public Experience type
      // doesn't declare canonical_experience_id — read it back via the raw
      // row helper used by the dedup scan to assert the DB write landed.
      const rawRows = expStore.listExperiencesForDedup();
      const thinRaw = rawRows.find((r) => r.id === thinId);
      assertEq(thinRaw?.canonical_experience_id, richId, "c5: thin row's canonical_experience_id now points at the rich row");
      assertTrue(!!rowAfterMerge, "c5b: merged row itself is not deleted (soft-merge only)");

      const reapply = await callRoute(opplevelserRouter, "POST", "/admin/dedup-backfill?apply=true", {
        headers: { "x-admin-key": "test-admin-key" },
      });
      assertEq(reapply.body.clusters_found, 0, "c6: idempotent — immediate re-run finds 0 NEW clusters");
      assertEq(reapply.body.rows_merged, 0, "c7: idempotent — immediate re-run merges 0 rows");

      // ── (d) publish-gate exclusion ────────────────────────────────────
      const published = expStore.listPublishedExperiences({ kommune: "Oslo" }, 100, 0);
      const publishedTitles = published.map((p) => p.title).sort();
      assertTrue(!publishedTitles.includes("Kon-Tiki Museet"), "d1: merged duplicate title excluded from listPublishedExperiences");
      assertTrue(publishedTitles.includes("Kon-Tiki Museum"), "d2: canonical row still listed");
      assertTrue(publishedTitles.includes("Norsk Folkemuseum"), "d3: unrelated control row untouched and still listed");

      const discovered = expStore.discoverExperiencesRelaxed({ kommune: "Oslo" }, 100).results;
      const discoveredTitles = discovered.map((d) => d.title);
      assertTrue(!discoveredTitles.includes("Kon-Tiki Museet"), "d4: merged duplicate excluded from discoverExperiences too");
      assertEq(
        discoveredTitles.filter((t) => t === "Kon-Tiki Museum").length,
        1,
        "d5: canonical row appears exactly once in discover results"
      );

      assertEq(expStore.getPublishedExperienceBySlug(thinSlug), null, "d6: merged duplicate's OWN slug no longer resolves via the publish gate");
      assertTrue(!!expStore.getPublishedExperienceBySlug(richSlug), "d7: canonical row's slug still resolves via the publish gate");

      // ── (e) detail-page 301 redirect ──────────────────────────────────
      const redirectRes = await callRoute(seoRouter, "GET", `/opplevelse/${thinSlug}`);
      assertEq(redirectRes.status, 301, "e1: GET /opplevelse/<merged-duplicate-slug> -> 301");
      assertEq(redirectRes.redirectedTo, `/opplevelse/${richSlug}`, "e2: redirects to the canonical row's slug");

      // experiences-seo.ts's OWN router has a final router.use() catch-all
      // (the Norwegian 404 page) after every named route, so calling next()
      // still resolves to a 404 response on THIS router (handled:true) —
      // it just never reaches the redirect/detail-render branch. That
      // catch-all firing (status 404, no redirect) IS the "unchanged 404
      // behavior" this asserts.
      const notFoundRes = await callRoute(seoRouter, "GET", "/opplevelse/does-not-exist-at-all");
      assertEq(notFoundRes.status, 404, "e3: a slug that never existed still 404s (unchanged behavior)");
      assertTrue(!notFoundRes.redirectedTo, "e3b: no redirect issued for a genuinely unknown slug");

      const canonicalDetail = await callRoute(seoRouter, "GET", `/opplevelse/${richSlug}`);
      assertEq(canonicalDetail.status, 200, "e4: canonical row's own detail page still renders normally (200, no redirect)");

      // ── (f) harvester guard: fuzzy same-provider ingest-time dedup ────
      const provider2 = expStore.createProvider({
        navn: "Klatreverket AS", fylke: "Viken", kommune: "Bærum",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Klatreverket", provider_id: provider2, provider_match_status: "matched",
        kommune: "Bærum", fylke: "Viken", verification_status: "verified", confidence: "high",
      });
      assertTrue(
        expStore.experienceExistsForProvider(provider2, "Klatreverket"),
        "f1: exact-title match still caught (unchanged base case)"
      );
      assertTrue(
        expStore.experienceExistsForProvider(provider2, "Klatreverket Bærum"),
        "f2: fuzzy near-duplicate title (extra qualifier word) now caught by the harvester guard"
      );
      assertTrue(
        !expStore.experienceExistsForProvider(provider2, "Sommarøy Kajakkutleie"),
        "f3: a genuinely different title for the same provider is still NOT flagged as existing"
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-dedup-backfill: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
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

// Standalone runner: `npx tsx src/routes/opplevelser-dedup-backfill.test.ts`
if (require.main === module) {
  runOpplevelserDedupBackfillTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
