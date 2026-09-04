/**
 * dental.test.ts — regression tests for PUT /api/tannlege/agents/:id
 * (src/routes/dental.ts), specifically the test-fingerprint guard.
 *
 * Incident (2026-07-21, dev-requests/2026-07-21-dental-schema-probe-writepath-fix.md):
 * two real production dental_agents rows got fake/test data written onto
 * them by two different actors. One path (the hourly enrichment worker's
 * own schema probe) was already correctly isolated to a reserved id
 * (persistence-probe-pr100b) — no code change needed there. The other path
 * (the platform-orchestrator's ad-hoc post-deploy smoke tests) had no
 * code-level guard stopping a test payload from landing on a real clinic
 * row via PUT /api/tannlege/agents/:id.
 *
 * This adds a defense-in-depth guard: any PUT whose body matches the known
 * contamination fingerprint is rejected (400) unless the target id is on
 * an explicit allow-list of synthetic/sandboxed probe ids
 * (DENTAL_SYNTHETIC_PROBE_IDS, dental.ts).
 *
 * Setup mirrors dental-agent-put-field-provenance.test.ts (this repo's
 * convention for testing dental.ts routes): fresh in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting() (so
 * the real production dental schema is created), fresh require of the
 * dental router per run, exercised via router.handle() directly (so the
 * requireAdmin middleware chain runs for real) rather than a live HTTP
 * server.
 *
 * Covers:
 *   (a) PUT to a normal real-looking id with a test-fingerprint body
 *       (specialists: [{name: "Test", title: "Tannlege"}]) -> 400, and the
 *       target row's data is verified NOT modified via a follow-up GET.
 *   (b) PUT to a normal real-looking id with genuinely normal data that
 *       reuses the SAME field names/shapes as the fingerprint but with
 *       different values (a real specialist NOT named "Test", a real
 *       om_oss value that isn't exactly "test probe") -> normal 200
 *       success (no false positive).
 *   (c) PUT to persistence-probe-pr100b (the allow-listed synthetic probe
 *       id) with the EXACT fingerprint payload -> normal 200 success (the
 *       hourly worker's own schema probe must keep round-tripping).
 *   (d) Each of the other three fingerprint triggers in isolation
 *       (online_booking_url, social_media.facebook, field_provenance key)
 *       -> 400 on a non-synthetic id, proving "any ONE field is enough".
 *
 * 2026-08-25 dental price_band enum guard (production data audit):
 * DentalAgentSchema.price_band was a bare z.string(), so PUT /agents/:id
 * (the enrichment worker's actual write path) would persist any string,
 * which is how off-spec values like "medium"/"high" reached the DB. Fixed
 * by making price_band a z.enum of the canonical rimelig|standard|premium|
 * ukjent values (dental-specific.yaml), reusing the same PRICE_BAND_ENUM
 * constant already enforced by updateDentalPriceBand() (dead code, no
 * route calls it). Covers:
 *   (e) PUT with a valid enum value ("standard") -> 200, written for real.
 *   (f) PUT with an off-enum value ("medium") -> tolerant-strip path kicks
 *       in (same as any other invalid field): 200, price_band listed in
 *       stripped_fields, NOT in fields_updated, and the row's price_band
 *       stays unchanged (untouched, not garbage) on a follow-up GET.
 *   (g) PUT with price_band: null -> 200, clears a previously-set value
 *       (nullable() is preserved; the enum guard doesn't disallow clearing).
 *
 * dev-request 2026-09-03-dental-catalog-class-public-filter (slice 1b):
 * GET /discover reuses listDentalAgents's excludeNonClinic opt, gated by
 * DENTAL_PUBLIC_CATALOG_CLASS_FILTER="1". Covers:
 *   (h) flag unset -> /discover returns all rows including catalog_class
 *       person_enk/lab_leverandor/holding (unchanged behavior).
 *   (i) flag="1" -> /discover excludes those 3 non-clinic rows but still
 *       returns the catalog_class NULL/klinikk/offentlig_klinikk/ukjent rows.
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
    path: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "GET",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: {},
      headers: opts.headers || {},
      body: opts.body,
      get() {
        return undefined;
      },
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

export function runDentalTests(
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
    const prevPublicCatalogClassFilter = process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
    const testKey = process.env.ADMIN_KEY || "dental-fingerprint-guard-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;
    delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const dentalStorePath = require.resolve("../services/dental-store");
    // See dental-agent-put-field-provenance.test.ts for why dental-store
    // must also be cleared: it holds its own getDb binding, resolved at ITS
    // require time, which would otherwise stay bound to a stale :memory:
    // connection from an earlier test block in the shared `npm test` run.
    const cachePaths = [dbFactoryPath, dentalPath, dentalStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, om_oss, specialists)
         VALUES (@id, @navn, @hjemmeside, @telefon, @om_oss, @specialists)`,
      );

      // (a) subject: a normal real clinic row — must stay untouched by a
      // rejected test-fingerprint PUT.
      insertAgent.run({
        id: "clinic-real-001",
        navn: "Real Tannlegeklinikk AS",
        hjemmeside: "https://real-klinikk.example.no",
        telefon: "22334455",
        om_oss: "En etablert klinikk i sentrum.",
        specialists: null,
      });

      // (b) subject: a normal real clinic row — must accept normal data
      // that reuses the same field shapes as the fingerprint.
      insertAgent.run({
        id: "clinic-real-002",
        navn: "Annen Tannlegeklinikk AS",
        hjemmeside: "https://annen-klinikk.example.no",
        telefon: "99887766",
        om_oss: null,
        specialists: null,
      });

      // (d) subjects: three more normal rows, one per remaining fingerprint
      // trigger, each tested in isolation.
      insertAgent.run({
        id: "clinic-real-003",
        navn: "Tredje Tannlegeklinikk AS",
        hjemmeside: "https://tredje-klinikk.example.no",
        telefon: "11223344",
        om_oss: null,
        specialists: null,
      });
      insertAgent.run({
        id: "clinic-real-004",
        navn: "Fjerde Tannlegeklinikk AS",
        hjemmeside: "https://fjerde-klinikk.example.no",
        telefon: "55667788",
        om_oss: null,
        specialists: null,
      });
      insertAgent.run({
        id: "clinic-real-005",
        navn: "Femte Tannlegeklinikk AS",
        hjemmeside: "https://femte-klinikk.example.no",
        telefon: "66778899",
        om_oss: null,
        specialists: null,
      });

      // (c) subject: the allow-listed synthetic probe row the hourly
      // enrichment worker's own schema probe targets.
      insertAgent.run({
        id: "persistence-probe-pr100b",
        navn: "Persistence Probe",
        hjemmeside: null,
        telefon: null,
        om_oss: null,
        specialists: null,
      });

      // (e)-(g) subjects: price_band enum guard (2026-08-25).
      const insertAgentWithPriceBand = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, om_oss, specialists, price_band)
         VALUES (@id, @navn, @hjemmeside, @telefon, @om_oss, @specialists, @price_band)`,
      );
      // (e) subject: no price_band yet — PUT a valid enum value onto it.
      insertAgentWithPriceBand.run({
        id: "clinic-real-006",
        navn: "Sjette Tannlegeklinikk AS",
        hjemmeside: null,
        telefon: null,
        om_oss: null,
        specialists: null,
        price_band: null,
      });
      // (f) subject: already has a valid price_band — an off-enum PUT must
      // leave it untouched (tolerant-strip), not overwrite it with garbage.
      insertAgentWithPriceBand.run({
        id: "clinic-real-007",
        navn: "Syvende Tannlegeklinikk AS",
        hjemmeside: null,
        telefon: null,
        om_oss: null,
        specialists: null,
        price_band: "standard",
      });
      // (g) subject: already has a valid price_band — PUT price_band: null
      // must still be allowed to clear it (enum guard doesn't touch
      // nullable()).
      insertAgentWithPriceBand.run({
        id: "clinic-real-008",
        navn: "Attende Tannlegeklinikk AS",
        hjemmeside: null,
        telefon: null,
        om_oss: null,
        specialists: null,
        price_band: "premium",
      });

      // (h)-(i) subjects: dev-request 2026-09-03-dental-catalog-class-public-filter
      // (slice 1b) — GET /discover's catalog_class filter. One row per
      // catalog_class outcome, catalog_class set via a raw UPDATE since
      // insertAgent's column list (mirrors createDentalAgent) doesn't write it.
      const insertDiscoverAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, om_oss, specialists)
         VALUES (@id, @navn, @hjemmeside, @telefon, @om_oss, @specialists)`,
      );
      const setCatalogClass = dentalDb.prepare(`UPDATE dental_agents SET catalog_class = ? WHERE id = ?`);
      const discoverSeed: Array<{ id: string; navn: string; catalog_class: string | null }> = [
        { id: "discover-klinikk", navn: "Discover Klinikk AS", catalog_class: "klinikk" },
        { id: "discover-offentlig", navn: "Discover Offentlig Klinikk", catalog_class: "offentlig_klinikk" },
        { id: "discover-ukjent", navn: "Discover Ukjent AS", catalog_class: "ukjent" },
        { id: "discover-null", navn: "Discover Uklassifisert AS", catalog_class: null },
        { id: "discover-person-enk", navn: "KARI DISCOVER", catalog_class: "person_enk" },
        { id: "discover-lab", navn: "Discover Dental Lab AS", catalog_class: "lab_leverandor" },
        { id: "discover-holding", navn: "Discover Holding AS", catalog_class: "holding" },
      ];
      for (const row of discoverSeed) {
        insertDiscoverAgent.run({ id: row.id, navn: row.navn, hjemmeside: null, telefon: null, om_oss: null, specialists: null });
        if (row.catalog_class !== null) setCatalogClass.run(row.catalog_class, row.id);
      }

      const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;

      // ── (a) test-fingerprint payload on a real id -> 400, row untouched ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-001",
          headers: { "x-admin-key": testKey },
          body: { specialists: [{ name: "Test", title: "Tannlege" }] },
        });
        assertEq(resp.status, 400, "a1: test-fingerprint PUT on a real id -> 400");
        assertTrue(
          typeof resp.body?.error === "string" && resp.body.error.length > 0,
          "a2: 400 response includes an error message",
        );

        const getResp = await callRoute(dentalRouter, {
          method: "GET",
          path: "/agents/clinic-real-001",
          headers: {},
        });
        assertEq(getResp.status, 200, "a3: GET after rejected PUT still 200 (row exists)");
        assertEq(
          getResp.body?.agent?.specialists,
          null,
          "a4: row's specialists field was NOT modified by the rejected PUT",
        );
      }

      // ── (b) normal data reusing the fingerprint's field shapes -> 200 ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-002",
          headers: { "x-admin-key": testKey },
          body: {
            specialists: [{ name: "Kari Nordmann", title: "Tannlege" }],
            om_oss: "Vi er en familievennlig klinikk med lang erfaring.",
          },
        });
        assertEq(resp.status, 200, "b1: normal PUT reusing fingerprint field shapes -> 200 (no false positive)");
        assertEq(resp.body?.updated, true, "b2: normal PUT reports updated: true");

        const getResp = await callRoute(dentalRouter, {
          method: "GET",
          path: "/agents/clinic-real-002",
          headers: {},
        });
        assertEq(
          getResp.body?.agent?.specialists,
          [{ name: "Kari Nordmann", title: "Tannlege" }],
          "b3: the real specialist data was actually written",
        );
        assertEq(
          getResp.body?.agent?.om_oss,
          "Vi er en familievennlig klinikk med lang erfaring.",
          "b4: the real om_oss data was actually written",
        );
      }

      // ── (c) exact fingerprint payload on the allow-listed probe id -> 200 ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/persistence-probe-pr100b",
          headers: { "x-admin-key": testKey },
          body: {
            specialists: [{ name: "Test", title: "Tannlege" }],
            online_booking_url: "https://example.com/booking",
            social_media: { facebook: "https://facebook.com/x" },
            om_oss: "test probe",
            field_provenance: { _smoke_test_provenance_probe: { sources: [] } },
          },
        });
        assertEq(resp.status, 200, "c1: exact fingerprint payload on allow-listed probe id -> 200 (still round-trips)");
        assertEq(resp.body?.updated, true, "c2: allow-listed probe PUT reports updated: true");

        const getResp = await callRoute(dentalRouter, {
          method: "GET",
          path: "/agents/persistence-probe-pr100b",
          headers: {},
        });
        assertEq(
          getResp.body?.agent?.om_oss,
          "test probe",
          "c3: the probe's fingerprint payload actually round-tripped",
        );
      }

      // ── (d) each remaining trigger, in isolation, on a real id -> 400 ──
      {
        const resp1 = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-003",
          headers: { "x-admin-key": testKey },
          body: { online_booking_url: "https://example.com/booking" },
        });
        assertEq(resp1.status, 400, "d1: online_booking_url fingerprint alone -> 400");

        const resp2 = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-004",
          headers: { "x-admin-key": testKey },
          body: { social_media: { facebook: "https://facebook.com/x" } },
        });
        assertEq(resp2.status, 400, "d2: social_media.facebook fingerprint alone -> 400");

        const resp3 = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-005",
          headers: { "x-admin-key": testKey },
          body: { field_provenance: { _smoke_test_provenance_probe: { sources: [] } } },
        });
        assertEq(resp3.status, 400, "d3: field_provenance _smoke_test key fingerprint alone -> 400");
      }

      // ── (e) valid price_band enum value -> 200, actually written ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-006",
          headers: { "x-admin-key": testKey },
          body: { price_band: "standard" },
        });
        assertEq(resp.status, 200, "e1: valid price_band enum value -> 200");
        assertEq(resp.body?.updated, true, "e2: valid price_band PUT reports updated: true");
        assertTrue(
          Array.isArray(resp.body?.fields_updated) && resp.body.fields_updated.includes("price_band"),
          "e3: fields_updated includes price_band",
        );
        assertTrue(
          resp.body?.stripped_fields === undefined,
          "e4: no stripped_fields for a valid enum value",
        );

        const getResp = await callRoute(dentalRouter, {
          method: "GET",
          path: "/agents/clinic-real-006",
          headers: {},
        });
        assertEq(
          getResp.body?.agent?.price_band,
          "standard",
          "e5: the valid price_band value was actually written",
        );
      }

      // ── (f) off-enum price_band value -> tolerant-strip, NOT written ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-007",
          headers: { "x-admin-key": testKey },
          // "medium" is off-spec (not in rimelig|standard|premium|ukjent) —
          // paired with a valid companion field so the PUT as a whole still
          // succeeds per the tolerant-strip philosophy (one bad field must
          // not 400/422 the whole enrichment write).
          body: { price_band: "medium", telefon: "87654321" },
        });
        assertEq(resp.status, 200, "f1: off-enum price_band alongside a valid field -> 200 (tolerant-strip)");
        assertEq(resp.body?.updated, true, "f2: tolerant-strip PUT still reports updated: true");
        assertTrue(
          Array.isArray(resp.body?.stripped_fields) && resp.body.stripped_fields.includes("price_band"),
          "f3: stripped_fields includes price_band",
        );
        assertTrue(
          Array.isArray(resp.body?.fields_updated) && !resp.body.fields_updated.includes("price_band"),
          "f4: fields_updated does NOT include price_band",
        );
        assertTrue(
          Array.isArray(resp.body?.fields_updated) && resp.body.fields_updated.includes("telefon"),
          "f5: the valid companion field (telefon) was still written",
        );

        const getResp = await callRoute(dentalRouter, {
          method: "GET",
          path: "/agents/clinic-real-007",
          headers: {},
        });
        assertEq(
          getResp.body?.agent?.price_band,
          "standard",
          "f6: price_band is UNCHANGED (still the pre-existing valid value, not \"medium\")",
        );
        assertEq(
          getResp.body?.agent?.telefon,
          "87654321",
          "f7: the valid companion field was actually written",
        );
      }

      // ── (g) price_band: null -> still allowed, clears the field ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-real-008",
          headers: { "x-admin-key": testKey },
          body: { price_band: null },
        });
        assertEq(resp.status, 200, "g1: price_band: null -> 200 (nullable() preserved by the enum guard)");
        assertEq(resp.body?.updated, true, "g2: null-clearing PUT reports updated: true");
        assertTrue(
          Array.isArray(resp.body?.fields_updated) && resp.body.fields_updated.includes("price_band"),
          "g3: fields_updated includes price_band",
        );

        const getResp = await callRoute(dentalRouter, {
          method: "GET",
          path: "/agents/clinic-real-008",
          headers: {},
        });
        assertEq(
          getResp.body?.agent?.price_band,
          null,
          "g4: price_band was actually cleared to null",
        );
      }

      // ── (h) GET /discover, flag unset -> unchanged (all 7 seeded rows) ──
      {
        delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
        const resp = await callRoute(dentalRouter, { method: "GET", path: "/discover?limit=100", headers: {} });
        assertEq(resp.status, 200, "h1: GET /discover -> 200");
        const navnSet = new Set((resp.body?.results ?? []).map((r: any) => r.navn));
        assertTrue(navnSet.has("KARI DISCOVER"), "h2: flag unset -- /discover includes the person_enk row (unchanged behavior)");
        assertTrue(navnSet.has("Discover Dental Lab AS"), "h3: flag unset -- /discover includes the lab_leverandor row");
        assertTrue(navnSet.has("Discover Holding AS"), "h4: flag unset -- /discover includes the holding row");
        assertTrue(navnSet.has("Discover Klinikk AS"), "h5: flag unset -- /discover includes the klinikk row");
      }

      // ── (i) GET /discover, flag="1" -> non-clinic rows excluded ──────────
      {
        process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER = "1";
        const resp = await callRoute(dentalRouter, { method: "GET", path: "/discover?limit=100", headers: {} });
        assertEq(resp.status, 200, "i1: GET /discover with flag=1 -> 200");
        const navnSet = new Set((resp.body?.results ?? []).map((r: any) => r.navn));
        assertTrue(!navnSet.has("KARI DISCOVER"), "i2: flag=1 -- /discover excludes the person_enk row");
        assertTrue(!navnSet.has("Discover Dental Lab AS"), "i3: flag=1 -- /discover excludes the lab_leverandor row");
        assertTrue(!navnSet.has("Discover Holding AS"), "i4: flag=1 -- /discover excludes the holding row");
        assertTrue(navnSet.has("Discover Klinikk AS"), "i5: flag=1 -- /discover still includes the klinikk row");
        assertTrue(navnSet.has("Discover Offentlig Klinikk"), "i6: flag=1 -- /discover still includes the offentlig_klinikk row");
        assertTrue(navnSet.has("Discover Ukjent AS"), "i7: flag=1 -- /discover still includes the explicit ukjent row");
        assertTrue(navnSet.has("Discover Uklassifisert AS"), "i8: flag=1 -- /discover still includes the catalog_class NULL row");
        delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
      }
    } catch (err: any) {
      failed++;
      failures.push("dental: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      if (prevPublicCatalogClassFilter === undefined) delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER; else process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER = prevPublicCatalogClassFilter;
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

// Standalone runner: `npx tsx src/routes/dental.test.ts`
if (require.main === module) {
  runDentalTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
