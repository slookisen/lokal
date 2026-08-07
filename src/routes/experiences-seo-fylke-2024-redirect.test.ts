/**
 * experiences-seo-fylke-2024-redirect.test.ts — route-level tests for the
 * historical-fylke-name 301 fallback added to GET /fylke/:fylke (dev-request
 * 2026-08-07-orch-fylke-2024-migrasjon), routes/experiences-seo.ts.
 *
 * Mirrors experiences-seo-place-geo.test.ts's setup (EXPERIENCES_DB_PATH=
 * ":memory:", fresh require of db-factory + experience-store +
 * experiences-seo per run, router.handle() driven directly with a minimal
 * synthetic Request/Response — no listen()/http round-trip needed).
 *
 * Covers:
 *   1. 1:1 historical-alias case: "Hordaland" (pre-2020 name, now part of
 *      Vestland) 301s to /fylke/Vestland when Vestland currently has ≥1
 *      published row.
 *   2. Merged-class case: "Viken" (2020-2023 merged name) 301s to whichever
 *      of its post-2024 successors (Akershus/Buskerud/Østfold) currently has
 *      the HIGHEST published count — computed live, not hardcoded.
 *   3. Merged-class tie-break: when two successors have an EQUAL published
 *      count, the alphabetically-first one wins.
 *   4. Negative control: falls through to 404 (next(), no redirect) when the
 *      alias's target fylke currently has ZERO published rows — never
 *      redirects into an empty page.
 *   5. Negative control: same 404 fallthrough for the merged-class case when
 *      NONE of its successors currently have any published rows.
 *   6. Regression: a genuinely unknown fylke param (not a historical alias
 *      at all) still falls through to 404, unaffected by this addition.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HtmlRouteResult {
  handled: boolean;
  status: number;
  redirectStatus: number | null;
  redirectLocation: string | null;
  body: string;
}

// Minimal synthetic Request/Response for driving an Express Router directly
// (no listen()/http round-trip needed) — mirrors callHtmlRoute() in
// experiences-seo-place-geo.test.ts, EXTENDED to actually capture the
// redirect's (status, location) pair (that file's own version only recorded
// "a redirect happened", not where to — this file's assertions need the
// target).
function callHtmlRoute(router: any, url: string): Promise<HtmlRouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      redirect(code: number, location?: string) {
        // Express's res.redirect(url) (1-arg, defaults to 302) is never used
        // by this route — the code under test always calls the 2-arg form —
        // but handle both shapes defensively.
        const [status, loc] = typeof location === "string" ? [code, location] : [302, String(code)];
        resolve({ handled: true, status, redirectStatus: status, redirectLocation: loc, body: "" });
      },
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, redirectStatus: null, redirectLocation: null, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, redirectStatus: null, redirectLocation: null, body: err ? String(err) : "" });
    });
  });
}

export function runExperiencesSeoFylke2024RedirectTests(
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const norwayFylkePath = require.resolve("../services/norway-fylke");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath, norwayFylkePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");

      function seedPublished(fylke: string, kommune: string, titleSuffix: string): void {
        const providerId = expStore.createProvider({
          navn: `Provider ${fylke} ${titleSuffix}`, fylke, kommune,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expStore.createExperience({
          title: `Opplevelse ${fylke} ${titleSuffix}`, provider_id: providerId,
          provider_match_status: "matched", kommune, fylke,
          verification_status: "verified", confidence: "high",
        });
      }

      // ── Seed: Vestland has 1 published row (for the 1:1-alias case) ────
      seedPublished("Vestland", "Bergen", "A");

      // ── Seed: Viken's successors with UNEQUAL counts, so the merged-
      //    class pick is unambiguous — Akershus 2, Østfold 1, Buskerud 0.
      seedPublished("Akershus", "Bærum", "A");
      seedPublished("Akershus", "Asker", "B");
      seedPublished("Østfold", "Fredrikstad", "A");
      // (Buskerud deliberately has zero published rows here.)

      // ── Seed: Troms og Finnmark's successors with an EQUAL count (1 each)
      //    — for the alphabetical tie-break test. Finnmark < Troms
      //    alphabetically, so Finnmark must win.
      seedPublished("Troms", "Tromsø", "A");
      seedPublished("Finnmark", "Alta", "A");

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── 1. 1:1 historical alias: Hordaland -> Vestland (has ≥1 row) ────
      const hordalandRes = await callHtmlRoute(seoRouter, "/fylke/Hordaland");
      assertTrue(hordalandRes.handled, "1a: GET /fylke/Hordaland is handled (redirect, not a passthrough 404)");
      assertEq(hordalandRes.redirectStatus, 301, "1b: Hordaland -> 301 (permanent)");
      assertEq(hordalandRes.redirectLocation, "/fylke/Vestland", "1c: Hordaland redirects to /fylke/Vestland");

      // ── 2. Merged-class: Viken -> live-highest-count successor (Akershus,
      //    2 published rows, beats Østfold's 1 and Buskerud's 0) ─────────
      const vikenRes = await callHtmlRoute(seoRouter, "/fylke/Viken");
      assertTrue(vikenRes.handled, "2a: GET /fylke/Viken is handled (redirect)");
      assertEq(vikenRes.redirectStatus, 301, "2b: Viken -> 301");
      assertEq(vikenRes.redirectLocation, "/fylke/Akershus", "2c: Viken redirects to /fylke/Akershus (highest live published count among its successors)");

      // ── 3. Merged-class tie-break: Troms og Finnmark -> Finnmark (equal
      //    counts, alphabetically first) ───────────────────────────────
      const tfRes = await callHtmlRoute(seoRouter, "/fylke/Troms%20og%20Finnmark");
      assertTrue(tfRes.handled, "3a: GET /fylke/Troms%20og%20Finnmark is handled (redirect)");
      assertEq(tfRes.redirectStatus, 301, "3b: Troms og Finnmark -> 301");
      assertEq(tfRes.redirectLocation, "/fylke/Finnmark", "3c: tied counts (Troms=1, Finnmark=1) -> alphabetically-first successor (Finnmark) wins");

      // ── 4. Negative control: alias target has ZERO published rows -> 404
      //    "Hedmark" (pre-2020, now part of Innlandet) — Innlandet has no
      //    published rows seeded in this test DB at all. This router's
      //    next() falls through to ITS OWN catch-all Norwegian 404 renderer
      //    further down in this same file (router.use(...) 404, ~line
      //    7561) rather than propagating out of router.handle() as
      //    handled:false — so the observable assertion here is status 404
      //    (a real res.send()), not handled:false.
      const hedmarkRes = await callHtmlRoute(seoRouter, "/fylke/Hedmark");
      assertTrue(hedmarkRes.handled, "4a: GET /fylke/Hedmark is handled (falls through to this router's own 404 page, not left unhandled)");
      assertEq(hedmarkRes.status, 404, "4b: Hedmark -> 404 — Innlandet has zero published rows, never redirect into an empty page");
      assertEq(hedmarkRes.redirectLocation, null, "4c: Hedmark -> no redirect issued");

      // ── 5. Negative control: merged-class with NO successor published —
      //    Vestfold og Telemark's successors (Vestfold, Telemark) have zero
      //    published rows in this test DB.
      const vtRes = await callHtmlRoute(seoRouter, "/fylke/Vestfold%20og%20Telemark");
      assertEq(vtRes.status, 404, "5a: GET /fylke/Vestfold%20og%20Telemark -> 404 — neither successor (Vestfold, Telemark) has any published rows");
      assertEq(vtRes.redirectLocation, null, "5b: Vestfold og Telemark -> no redirect issued");

      // ── 6. Regression: a genuinely unknown fylke param still 404s ──────
      const garbageRes = await callHtmlRoute(seoRouter, "/fylke/Ikke-Et-Ekte-Fylke-Xyz");
      assertEq(garbageRes.status, 404, "6a: GET /fylke/Ikke-Et-Ekte-Fylke-Xyz (not a historical alias at all) -> 404, unaffected by this addition");
      assertEq(garbageRes.redirectLocation, null, "6c: unknown fylke -> no redirect issued");

      // ── 6b. Regression: exact-match on a LIVE fylke still works byte-
      //    identically (this addition never runs for a fylke that already
      //    resolves via the existing exact/fold-match checks) ─────────────
      const liveRes = await callHtmlRoute(seoRouter, "/fylke/Vestland");
      assertTrue(liveRes.handled && liveRes.redirectStatus === null, "6b: GET /fylke/Vestland (already-live, exact-match) renders directly, no redirect");
    } catch (err) {
      failed++;
      failures.push("experiences-seo-fylke-2024-redirect: unexpected error: " + String((err as any)?.stack || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  (async () => {
    console.log("── experiences-seo-fylke-2024-redirect route tests ──");
    const r = await runExperiencesSeoFylke2024RedirectTests({ log: true });
    console.log(`\nexperiences-seo-fylke-2024-redirect: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })();
}
