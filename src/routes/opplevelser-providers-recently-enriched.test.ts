/**
 * opplevelser-providers-recently-enriched.test.ts — unit tests for
 * GET /api/opplevelser/admin/providers/recently-enriched
 * (src/routes/opplevelser.ts).
 *
 * Slice 5 of dev-request 2026-07-13-enrichment-metode-maldrevet-evidens:
 * experiences-vertical counterpart of admin-agents-recently-enriched.test.ts
 * (marketplace.ts) and dental-agents-recently-enriched.test.ts (dental.ts).
 * Experiences has NO field_provenance column (see the LOCK MODEL comment
 * near getProviderByName in experience-store.ts) — so this response omits
 * it in favor of `field_provenance: null, provenance_model: "none"`, and
 * instead surfaces the content fields the gårdssalg content-refresh writer
 * actually fills (about_text/visit_text/opening_hours_text/products/
 * content_source/content_evidence_url).
 *
 * Setup mirrors opplevelser-gardssalg-provider-lookup.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle()
 * (X-Admin-Key via headers) — no real HTTP server / supertest needed.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) default since (7d) excludes a provider enriched 10 days ago,
 *       includes one enriched 1 day ago
 *   (c) explicit since widens the window
 *   (d) invalid since falls back to the 7-day default (not 400/500)
 *   (e) limit default + clamping (0/negative -> 1, >50 -> 50)
 *   (f) shape of a returned row: id/name/website/last_enriched_at content
 *       fields + field_provenance:null + provenance_model:"none" — no
 *       rfb-shaped field_provenance object ever invented
 *   (g) malformed products JSON -> [] (never throws)
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
  opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method: "GET",
      url: "/admin/providers/recently-enriched" + qs,
      originalUrl: "/admin/providers/recently-enriched" + qs,
      path: "/admin/providers/recently-enriched",
      query,
      headers: opts.headers || {},
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runOpplevelserProvidersRecentlyEnrichedTests(
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
    const testKey = "providers-recently-enriched-test-key";
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
           (id, navn, vertical, hjemmeside, last_enriched_at, about_text, visit_text,
            opening_hours_text, products, content_source, content_evidence_url,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @last_enriched_at, @about_text, @visit_text,
            @opening_hours_text, @products, @content_source, @content_evidence_url,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      insertProvider.run({
        id: "prov-recent", navn: "Nylig Enriched Sideri AS", hjemmeside: "https://nylig-sideri.example.no",
        last_enriched_at: daysAgoIso(1),
        about_text: "Vi lager sider på tradisjonelt vis.", visit_text: "Åpent for besøk lørdager.",
        opening_hours_text: "Lør 10-16", products: JSON.stringify(["Eplesider", "Eplemost"]),
        content_source: "provider_site", content_evidence_url: "https://nylig-sideri.example.no/om-oss",
      });
      insertProvider.run({
        id: "prov-old", navn: "Gammel Enriched Gård AS", hjemmeside: "https://gammel-gard.example.no",
        last_enriched_at: daysAgoIso(10),
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });
      insertProvider.run({
        id: "prov-malformed-products", navn: "Rar Produkter AS", hjemmeside: "https://rar-produkter.example.no",
        last_enriched_at: daysAgoIso(2),
        about_text: null, visit_text: null, opening_hours_text: null, products: "{not json",
        content_source: null, content_evidence_url: null,
      });
      insertProvider.run({
        id: "prov-never-enriched", navn: "Aldri Enriched AS", hjemmeside: "https://aldri.example.no",
        last_enriched_at: null,
        about_text: null, visit_text: null, opening_hours_text: null, products: null,
        content_source: null, content_evidence_url: null,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { query: { limit: "50" } });
      assertEq(noKey.status, 403, "a1: GET /admin/providers/recently-enriched without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "a2: no-key response carries no providers payload");

      // ── (b) default since (7d) ───────────────────────────────────────────
      const dflt = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { limit: "50" },
      });
      assertEq(dflt.status, 200, "b1: default since/limit -> 200");
      {
        const ids = (dflt.body.providers as any[]).map((p) => p.id);
        assertTrue(ids.includes("prov-recent"), "b2: default window includes 1-day-old provider");
        assertTrue(!ids.includes("prov-old"), "b3: default window excludes 10-day-old provider");
        assertTrue(!ids.includes("prov-never-enriched"), "b4: never-enriched (NULL last_enriched_at) provider excluded");
      }

      // ── (c) explicit since widens the window ─────────────────────────────
      const wide = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      assertEq(wide.status, 200, "c1: explicit wide since -> 200");
      assertTrue(
        (wide.body.providers as any[]).map((p) => p.id).includes("prov-old"),
        "c2: wide since includes 10-day-old provider",
      );

      // ── (d) invalid since falls back to the 7-day default ────────────────
      const badSince = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: "not-a-date", limit: "50" },
      });
      assertEq(badSince.status, 200, "d1: invalid since -> 200 (falls back), not 400/500");
      {
        const ids = (badSince.body.providers as any[]).map((p) => p.id);
        assertTrue(ids.includes("prov-recent"), "d2: invalid-since fallback includes 1-day-old provider");
        assertTrue(!ids.includes("prov-old"), "d3: invalid-since fallback excludes 10-day-old provider");
      }

      // ── (e) limit default + clamping ──────────────────────────────────────
      const rZero = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "0" },
      });
      assertEq(rZero.body.providers.length, 1, "e1: limit=0 clamps to 1 (of >=3 eligible)");

      const rNeg = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "-5" },
      });
      assertEq(rNeg.body.providers.length, 1, "e2: negative limit clamps to 1");

      const rBig = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "500" },
      });
      assertTrue(rBig.body.providers.length <= 50, "e3: limit=500 clamps to at most 50");

      // ── (f) shape of a returned row ────────────────────────────────────────
      const shapeResp = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const row = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-recent");
      assertTrue(!!row, "f1: prov-recent row present");
      assertEq(row.name, "Nylig Enriched Sideri AS", "f2: row carries name (from experience_providers.navn)");
      assertEq(row.website, "https://nylig-sideri.example.no", "f3: row carries website (from experience_providers.hjemmeside)");
      assertTrue(typeof row.last_enriched_at === "string" && row.last_enriched_at.length > 0, "f4: row carries last_enriched_at");
      assertEq(row.about_text, "Vi lager sider på tradisjonelt vis.", "f5: row carries about_text");
      assertEq(row.visit_text, "Åpent for besøk lørdager.", "f6: row carries visit_text");
      assertEq(row.opening_hours_text, "Lør 10-16", "f7: row carries opening_hours_text");
      assertEq(row.products, ["Eplesider", "Eplemost"], "f8: row carries parsed products array");
      assertEq(row.content_source, "provider_site", "f9: row carries content_source");
      assertEq(row.content_evidence_url, "https://nylig-sideri.example.no/om-oss", "f10: row carries content_evidence_url");
      assertEq(row.field_provenance, null, "f11: field_provenance is explicitly null (no fake rfb-shaped object invented)");
      assertEq(row.provenance_model, "none", "f12: provenance_model:'none' marks the different lock model");
      assertEq(shapeResp.body.success, true, "f13: response carries success:true");
      assertEq(shapeResp.body.count, shapeResp.body.providers.length, "f14: count matches providers.length");
      assertTrue(!("agents" in shapeResp.body), "f15: response uses 'providers' key, not 'agents'");

      // ── (g) malformed products JSON -> [] ─────────────────────────────────
      const malformedRow = (shapeResp.body.providers as any[]).find((p) => p.id === "prov-malformed-products");
      assertTrue(!!malformedRow, "g1: prov-malformed-products row present");
      assertEq(malformedRow.products, [], "g2: malformed products JSON -> []");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-providers-recently-enriched: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-providers-recently-enriched.test.ts`
if (require.main === module) {
  runOpplevelserProvidersRecentlyEnrichedTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
