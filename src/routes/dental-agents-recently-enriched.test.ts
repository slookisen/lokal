/**
 * dental-agents-recently-enriched.test.ts — unit tests for
 * GET /api/tannlege/admin/agents/recently-enriched (src/routes/dental.ts).
 *
 * Slice 5 of dev-request 2026-07-13-enrichment-metode-maldrevet-evidens:
 * dental-vertical counterpart of admin-agents-recently-enriched.test.ts
 * (marketplace.ts). Same read-only contract, same field shape, minus an
 * is_active filter (dental_agents has no such column).
 *
 * Setup mirrors opplevelser-gardssalg-provider-lookup.test.ts: fresh
 * in-memory dental DB via DENTAL_DB_PATH=":memory:" +
 * db-factory.__resetDbFactoryForTesting() (so initDentalSchema runs the
 * real production dental schema, including the field_provenance column
 * added around init-dental.ts line ~251), fresh require of the dental
 * router per run, exercised via router.handle() directly (X-Admin-Key
 * passed via headers) rather than a real HTTP server — this repo's
 * convention. Unlike marketplace.ts's inline admin-key check, dental.ts
 * gates this route behind the requireAdmin middleware, so router.handle()
 * (not grabbing the handler function directly off route.stack) is used
 * here to exercise the full middleware chain.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) default since (7d) excludes a clinic enriched 10 days ago,
 *       includes one enriched 1 day ago
 *   (c) explicit since widens the window
 *   (d) invalid since falls back to the 7-day default (not 400/500)
 *   (e) limit default + clamping (0/negative -> 1, >50 -> 50)
 *   (f) shape of a returned row: id/name/website/last_enriched_at/
 *       field_provenance (parsed object)
 *   (g) malformed field_provenance JSON -> {}
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
      url: "/admin/agents/recently-enriched" + qs,
      originalUrl: "/admin/agents/recently-enriched" + qs,
      path: "/admin/agents/recently-enriched",
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

export function runDentalAgentsRecentlyEnrichedTests(
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
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "dental-recently-enriched-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const cachePaths = [dbFactoryPath, dentalPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, last_enriched_at, field_provenance)
         VALUES (@id, @navn, @hjemmeside, @last_enriched_at, @field_provenance)`
      );

      insertAgent.run({
        id: "clinic-recent", navn: "Nylig Tannlege AS", hjemmeside: "https://nylig-tannlege.example.no",
        last_enriched_at: daysAgoIso(1),
        field_provenance: JSON.stringify({ phone: [{ source_url: "https://nylig-tannlege.example.no", value: "12345678" }] }),
      });
      insertAgent.run({
        id: "clinic-old", navn: "Gammel Tannlege AS", hjemmeside: "https://gammel-tannlege.example.no",
        last_enriched_at: daysAgoIso(10), field_provenance: null,
      });
      insertAgent.run({
        id: "clinic-malformed", navn: "Rar Tannlege AS", hjemmeside: "https://rar-tannlege.example.no",
        last_enriched_at: daysAgoIso(2), field_provenance: "{not json",
      });
      insertAgent.run({
        id: "clinic-never-enriched", navn: "Aldri Enriched Tannlege AS", hjemmeside: "https://aldri.example.no",
        last_enriched_at: null, field_provenance: null,
      });

      const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(dentalRouter, { query: { limit: "50" } });
      assertEq(noKey.status, 403, "a1: GET /admin/agents/recently-enriched without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.agents, "a2: no-key response carries no agents payload");

      // ── (b) default since (7d) ───────────────────────────────────────────
      const dflt = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { limit: "50" },
      });
      assertEq(dflt.status, 200, "b1: default since/limit -> 200");
      {
        const ids = (dflt.body.agents as any[]).map((a) => a.id);
        assertTrue(ids.includes("clinic-recent"), "b2: default window includes 1-day-old clinic");
        assertTrue(!ids.includes("clinic-old"), "b3: default window excludes 10-day-old clinic");
        assertTrue(!ids.includes("clinic-never-enriched"), "b4: never-enriched (NULL last_enriched_at) clinic excluded");
      }

      // ── (c) explicit since widens the window ─────────────────────────────
      const wide = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      assertEq(wide.status, 200, "c1: explicit wide since -> 200");
      assertTrue(
        (wide.body.agents as any[]).map((a) => a.id).includes("clinic-old"),
        "c2: wide since includes 10-day-old clinic",
      );

      // ── (d) invalid since falls back to the 7-day default ────────────────
      const badSince = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: "not-a-date", limit: "50" },
      });
      assertEq(badSince.status, 200, "d1: invalid since -> 200 (falls back), not 400/500");
      {
        const ids = (badSince.body.agents as any[]).map((a) => a.id);
        assertTrue(ids.includes("clinic-recent"), "d2: invalid-since fallback includes 1-day-old clinic");
        assertTrue(!ids.includes("clinic-old"), "d3: invalid-since fallback excludes 10-day-old clinic");
      }

      // ── (e) limit default + clamping ──────────────────────────────────────
      const rZero = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "0" },
      });
      assertEq(rZero.body.agents.length, 1, "e1: limit=0 clamps to 1 (of >=3 eligible)");

      const rNeg = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "-5" },
      });
      assertEq(rNeg.body.agents.length, 1, "e2: negative limit clamps to 1");

      const rBig = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "500" },
      });
      assertTrue(rBig.body.agents.length <= 50, "e3: limit=500 clamps to at most 50");

      // ── (f) shape of a returned row ────────────────────────────────────────
      const shapeResp = await callRoute(dentalRouter, {
        headers: { "x-admin-key": testKey },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const row = (shapeResp.body.agents as any[]).find((a) => a.id === "clinic-recent");
      assertTrue(!!row, "f1: clinic-recent row present");
      assertEq(row.name, "Nylig Tannlege AS", "f2: row carries name (from dental_agents.navn)");
      assertEq(row.website, "https://nylig-tannlege.example.no", "f3: row carries website (from dental_agents.hjemmeside)");
      assertTrue(typeof row.last_enriched_at === "string" && row.last_enriched_at.length > 0, "f4: row carries last_enriched_at");
      assertTrue(typeof row.field_provenance === "object" && row.field_provenance !== null && !Array.isArray(row.field_provenance),
        "f5: field_provenance is a parsed object, not a JSON string");
      assertTrue(Array.isArray(row.field_provenance.phone), "f6: field_provenance.phone survives the round-trip");
      assertEq(
        Object.keys(row).sort(),
        ["field_provenance", "id", "last_enriched_at", "name", "website"].sort(),
        "f7: row has exactly the documented fields",
      );
      assertEq(shapeResp.body.success, true, "f8: response carries success:true");
      assertEq(shapeResp.body.count, shapeResp.body.agents.length, "f9: count matches agents.length");

      // ── (g) malformed field_provenance JSON -> {} ─────────────────────────
      const malformedRow = (shapeResp.body.agents as any[]).find((a) => a.id === "clinic-malformed");
      assertTrue(!!malformedRow, "g1: clinic-malformed row present");
      assertEq(malformedRow.field_provenance, {}, "g2: malformed field_provenance JSON -> {}");
    } catch (err: any) {
      failed++;
      failures.push("dental-agents-recently-enriched: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
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

// Standalone runner: `npx tsx src/routes/dental-agents-recently-enriched.test.ts`
if (require.main === module) {
  runDentalAgentsRecentlyEnrichedTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
