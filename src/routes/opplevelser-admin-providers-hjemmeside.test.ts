/**
 * opplevelser-admin-providers-hjemmeside.test.ts — unit tests for the
 * hjemmeside (homepage URL) correction pair on src/routes/opplevelser.ts:
 *
 *   - GET   /api/opplevelser/admin/providers/by-hjemmeside
 *   - PATCH /api/opplevelser/admin/providers/:id/hjemmeside
 *
 * dev-request 2026-07-12-experiences-enrichment-supply-and-aggregator-
 * hygiene: the enrichment pipeline is supply-starved partly because there
 * was no write path to correct a provider's hjemmeside once bad data was in
 * (e.g. an aggregator/DMO domain like visitnorway.com that leaked in during
 * harvest, in place of the provider's own site), and no way to FIND the
 * ~13 known-bad rows to begin with. GET is the read-only lookup half, PATCH
 * is the write half — this file covers both.
 *
 * Setup mirrors opplevelser-gardssalg-provider-lookup.test.ts /
 * opplevelser-providers-recently-enriched.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle()
 * (X-Admin-Key via headers, JSON body passed as req.body directly since
 * calling the router bypasses the app-level express.json() middleware) —
 * no real HTTP server / supertest needed.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key on BOTH routes
 *   (b) PATCH happy path: existing provider, response reports
 *       previous_hjemmeside + new_hjemmeside, and the DB row actually changed
 *   (c) PATCH on a nonexistent id -> 404
 *   (d) PATCH with the 'hjemmeside' field missing entirely from the body -> 400
 *   (e) PATCH with an empty-string value normalizes to null (both in the
 *       response and in the DB)
 *   (f) PATCH with a non-string, non-null value (number) -> 400
 *   (g) PATCH with a whitespace-only value normalizes to null (trim first)
 *   (h) GET with a matching pattern returns expected rows, each carrying
 *       ONLY id/navn/hjemmeside/vertical
 *   (i) GET with no 'pattern' -> 400
 *   (j) GET respects 'limit' (including clamping to the [1, 500] range)
 *   (k) GET pattern match is case-insensitive and excludes non-matching rows
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

export function runOpplevelserAdminProvidersHjemmesideTests(
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
    const testKey = "admin-providers-hjemmeside-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, updated_at,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @updated_at,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "prov-aggregator-leak", navn: "Fjelltur Opplevelser AS",
        hjemmeside: "https://www.visitnorway.com/listings/fjelltur-opplevelser",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-clean", navn: "Ren Gård AS",
        hjemmeside: "https://ren-gard.example.no",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-another-aggregator", navn: "Kystvandring DA",
        hjemmeside: "https://VisitNorway.com/listings/kystvandring",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-no-website", navn: "Uten Hjemmeside AS",
        hjemmeside: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      insertProvider.run({
        id: "prov-clean-2", navn: "Bærekraftig Bygd AS",
        hjemmeside: "https://baerekraftig-bygd.example.no",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function getRow(id: string): { hjemmeside: string | null; updated_at: string } | undefined {
        return expDb.prepare("SELECT hjemmeside, updated_at FROM experience_providers WHERE id = ?").get(id) as any;
      }

      // ── (a) 403 without X-Admin-Key on BOTH routes ──────────────────────
      const patchNoKey = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        body: { hjemmeside: "https://new.example.no" },
      });
      assertEq(patchNoKey.status, 403, "a1: PATCH .../hjemmeside without X-Admin-Key -> 403");
      assertEq(getRow("prov-clean")?.hjemmeside, "https://ren-gard.example.no", "a2: no-key PATCH does not modify the row");

      const getNoKey = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        query: { pattern: "visitnorway" },
      });
      assertEq(getNoKey.status, 403, "a3: GET .../by-hjemmeside without X-Admin-Key -> 403");
      assertTrue(!getNoKey.body?.providers, "a4: no-key GET response carries no providers payload");

      // ── (b) PATCH happy path ─────────────────────────────────────────────
      const happy = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-aggregator-leak/hjemmeside",
        params: { id: "prov-aggregator-leak" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: "https://fjellturopplevelser.no" },
      });
      assertEq(happy.status, 200, "b1: PATCH existing provider -> 200");
      assertEq(happy.body.success, true, "b2: response carries success:true");
      assertEq(happy.body.id, "prov-aggregator-leak", "b3: response echoes the provider id");
      assertEq(
        happy.body.previous_hjemmeside,
        "https://www.visitnorway.com/listings/fjelltur-opplevelser",
        "b4: response reports the previous (bad) hjemmeside value",
      );
      assertEq(happy.body.new_hjemmeside, "https://fjellturopplevelser.no", "b5: response reports the new hjemmeside value");
      const rowAfterHappy = getRow("prov-aggregator-leak");
      assertEq(rowAfterHappy?.hjemmeside, "https://fjellturopplevelser.no", "b6: DB row actually updated");
      assertTrue(
        !!rowAfterHappy && rowAfterHappy.updated_at !== "2026-01-01T00:00:00.000Z",
        "b7: updated_at was refreshed by the write",
      );

      // ── (c) PATCH on a nonexistent id -> 404 ────────────────────────────
      const notFound = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/does-not-exist/hjemmeside",
        params: { id: "does-not-exist" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: "https://whatever.no" },
      });
      assertEq(notFound.status, 404, "c1: PATCH nonexistent id -> 404");
      assertEq(notFound.body?.id, "does-not-exist", "c2: 404 body echoes the requested id");

      // ── (d) PATCH with 'hjemmeside' missing entirely -> 400 ─────────────
      const missingField = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        headers: { "x-admin-key": testKey },
        body: {},
      });
      assertEq(missingField.status, 400, "d1: PATCH with missing 'hjemmeside' field -> 400");
      assertTrue(typeof missingField.body?.error === "string" && missingField.body.error.length > 0, "d2: 400 body carries a clear error message");
      assertEq(getRow("prov-clean")?.hjemmeside, "https://ren-gard.example.no", "d3: row untouched when field is missing");

      // ── (e) PATCH with empty-string value normalizes to null ────────────
      const emptyString = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: "" },
      });
      assertEq(emptyString.status, 200, "e1: PATCH with empty-string value -> 200");
      assertEq(emptyString.body.previous_hjemmeside, "https://ren-gard.example.no", "e2: previous value reported before clearing");
      assertEq(emptyString.body.new_hjemmeside, null, "e3: empty-string value normalizes to null in the response");
      assertEq(getRow("prov-clean")?.hjemmeside, null, "e4: DB row's hjemmeside is actually NULL after empty-string PATCH");

      // reseed prov-clean for the remaining cases
      expDb.prepare("UPDATE experience_providers SET hjemmeside = ? WHERE id = ?").run("https://ren-gard.example.no", "prov-clean");

      // ── (f) PATCH with a non-string, non-null value -> 400 ──────────────
      const badType = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: 12345 },
      });
      assertEq(badType.status, 400, "f1: PATCH with a numeric 'hjemmeside' value -> 400");
      assertEq(getRow("prov-clean")?.hjemmeside, "https://ren-gard.example.no", "f2: row untouched when value has the wrong type");

      // explicit null is a VALID input (distinct from a missing field) — clears the value.
      const explicitNull = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: null },
      });
      assertEq(explicitNull.status, 200, "f3: PATCH with an explicit null value -> 200 (valid, not 400)");
      assertEq(explicitNull.body.new_hjemmeside, null, "f4: explicit null -> new_hjemmeside is null");
      // reseed again
      expDb.prepare("UPDATE experience_providers SET hjemmeside = ? WHERE id = ?").run("https://ren-gard.example.no", "prov-clean");

      // ── (g) whitespace-only value normalizes to null (trim first) ───────
      const whitespaceOnly = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: "   " },
      });
      assertEq(whitespaceOnly.status, 200, "g1: PATCH with whitespace-only value -> 200");
      assertEq(whitespaceOnly.body.new_hjemmeside, null, "g2: whitespace-only value normalizes to null (trim first, then empty check)");
      assertEq(getRow("prov-clean")?.hjemmeside, null, "g3: DB row cleared by whitespace-only PATCH");
      // trimmed non-empty value is also stored trimmed
      const trimmed = await callRoute(opplevelserRouter, {
        method: "PATCH",
        path: "/admin/providers/prov-clean/hjemmeside",
        params: { id: "prov-clean" },
        headers: { "x-admin-key": testKey },
        body: { hjemmeside: "  https://ren-gard.example.no  " },
      });
      assertEq(trimmed.body.new_hjemmeside, "https://ren-gard.example.no", "g4: surrounding whitespace is trimmed before writing");
      assertEq(getRow("prov-clean")?.hjemmeside, "https://ren-gard.example.no", "g5: DB row stores the trimmed value");

      // ── (h) GET matching pattern -> expected rows, minimal fields only ──
      const matchAggregator = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
        query: { pattern: "visitnorway" },
      });
      assertEq(matchAggregator.status, 200, "h1: GET by-hjemmeside with a matching pattern -> 200");
      assertEq(matchAggregator.body.success, true, "h2: response carries success:true");
      const matchedIds = (matchAggregator.body.providers as any[]).map((p) => p.id).sort();
      assertEq(matchedIds, ["prov-another-aggregator"], "h3: only the still-visitnorway provider matches (prov-aggregator-leak was corrected in case b)");
      assertEq(matchAggregator.body.count, matchAggregator.body.providers.length, "h4: count matches providers.length");
      assertEq(
        Object.keys(matchAggregator.body.providers[0]).sort(),
        ["hjemmeside", "id", "navn", "vertical"].sort(),
        "h5: each row carries ONLY id/navn/hjemmeside/vertical — no telefon/epost/adresse",
      );
      assertEq(matchAggregator.body.providers[0].vertical, "experiences", "h6: vertical field is populated");

      // ── (i) GET with no 'pattern' -> 400 ─────────────────────────────────
      const noPattern = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
      });
      assertEq(noPattern.status, 400, "i1: GET by-hjemmeside without 'pattern' -> 400");

      const blankPattern = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
        query: { pattern: "   " },
      });
      assertEq(blankPattern.status, 400, "i2: GET by-hjemmeside with a blank (whitespace-only) 'pattern' -> 400");

      // ── (j) GET respects 'limit' ──────────────────────────────────────────
      const wideMatch = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
        query: { pattern: "example.no" },
      });
      assertTrue(wideMatch.body.providers.length >= 2, "j1: broad pattern matches multiple providers (setup sanity check)");

      const limited = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
        query: { pattern: "example.no", limit: "1" },
      });
      assertEq(limited.body.providers.length, 1, "j2: limit=1 returns exactly 1 row");

      const overLimit = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
        query: { pattern: "example.no", limit: "5000" },
      });
      assertTrue(overLimit.body.providers.length <= 500, "j3: limit above the max (500) is clamped, never returns more than 500");

      // ── (k) case-insensitive match, non-matching rows excluded ──────────
      const caseInsensitive = await callRoute(opplevelserRouter, {
        path: "/admin/providers/by-hjemmeside",
        headers: { "x-admin-key": testKey },
        query: { pattern: "REN-GARD" },
      });
      assertEq(caseInsensitive.status, 200, "k1: uppercase pattern still matches (case-insensitive LIKE) -> 200");
      assertTrue(
        (caseInsensitive.body.providers as any[]).some((p) => p.id === "prov-clean"),
        "k2: uppercase pattern matches the lowercase-URL row",
      );
      assertTrue(
        !(caseInsensitive.body.providers as any[]).some((p) => p.id === "prov-no-website"),
        "k3: provider with NULL hjemmeside never matches any pattern",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-admin-providers-hjemmeside: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-admin-providers-hjemmeside.test.ts`
if (require.main === module) {
  runOpplevelserAdminProvidersHjemmesideTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
