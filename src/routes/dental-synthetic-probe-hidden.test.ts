/**
 * dental-synthetic-probe-hidden.test.ts — dev-request
 * 2026-10-01-dental-testrad-ut-av-offentlig-visning.
 *
 * The enrichment routine's schema-probe row (persistence-probe-pr100b,
 * DENTAL_SYNTHETIC_PROBE_IDS in services/dental-contamination.ts) was public
 * on finn-tannlege.com: /klinikk/id/persistence-probe-pr100b -> 200, the
 * sitemap listed /klinikk/pr-100b-persistence-probe--999999999 and /sted/test,
 * and /api/stats' cities included "TEST". Every read surface now skips it via
 * DENTAL_NOT_SYNTHETIC_PROBE_SQL / isDentalSyntheticProbeId(); the probe's
 * own write path (PUT /api/tannlege/agents/:id) and by-id read-back stay
 * unchanged (AC3).
 *
 * Seeds the probe row with its production shape (org_nr 999999999,
 * poststed/fylke "TEST", verification_status needs_review, fingerprint
 * om_oss/specialists) next to one ordinary, complete clinic, then checks:
 *   A  dental-store list/count/search/stats/poststed/sitemap/specialty reads
 *      skip the probe; the ordinary clinic is still returned by each one.
 *   B  dental-seo routes: probe profile 404 (by id and by slug), /sted/test
 *      404, sitemap has no probe/TEST entry, /sok?q=probe empty; the ordinary
 *      clinic's profile, /sted/oslo, sitemap entry and search hit are intact.
 *   C  /api/tannlege routes: GET /agents, ?q=probe and /discover skip the
 *      probe; org_nr lookup 404s; by-id GET and the fingerprint PUT on the
 *      probe id still work (AC3).
 *   D  dental A2A message/send: org_nr lookup, search and stats skip it.
 *   E  admin counts: GET /admin/dental/parking-stats and the dental
 *      verifier's candidate cohort (pickDentalVerifierBatch) skip it.
 *
 * Same harness as dental-seo.test.ts / dental.test.ts: in-memory dental DB
 * via DENTAL_DB_PATH=":memory:" + db-factory reset, fresh requires, routers
 * driven through router.handle() with a minimal req/res mock.
 *
 * Standalone: npx tsx src/routes/dental-synthetic-probe-hidden.test.ts
 * Wired into tests/test.ts via runDentalSyntheticProbeHiddenTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  text: string;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "GET",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: opts.query || {},
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
      setHeader() {
        return this;
      },
      send(payload: any) {
        const text = String(payload ?? "");
        resolve({ status: this.statusCode, body: text, text });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, text: JSON.stringify(payload) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: String(err), text: String(err) });
      else resolve({ status: 404, body: "unhandled", text: "unhandled" });
    });
  });
}

const PROBE_ID = "persistence-probe-pr100b";
const PROBE_ORGNR = "999999999";
const CLINIC_ORGNR = "918800002";

export async function runDentalSyntheticProbeHiddenTests(
  opts: { log?: boolean } = {}
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const testKey = process.env.ADMIN_KEY || "dental-synthetic-probe-hidden-test-key";
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-verifier"),
    require.resolve("./dental-seo"),
    require.resolve("./dental"),
    require.resolve("./dental-a2a"),
    require.resolve("./admin-dental-catalog-class"),
  ];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const verifier = require("../services/dental-verifier") as typeof import("../services/dental-verifier");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const dentalSeoRouter = dentalSeo.default as any;
    const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;
    const dentalA2a = require("./dental-a2a") as typeof import("./dental-a2a");
    const adminCatalogClassRouter = (require("./admin-dental-catalog-class") as typeof import("./admin-dental-catalog-class")).default as any;

    // ── Seed: the probe row, shaped like production (_probe_get.json) ─────
    db.prepare(
      `INSERT INTO dental_agents
         (id, org_nr, navn, postnummer, poststed, fylke, adresse, helfo_agreement,
          verification_status, enrichment_state, om_oss, specialists, opening_hours)
       VALUES (@id, @org_nr, @navn, '0000', 'TEST', 'TEST', 'Volume Test 1', 'true',
               'needs_review', 'raw', 'test probe', @specialists, @opening_hours)`
    ).run({
      id: PROBE_ID,
      org_nr: PROBE_ORGNR,
      navn: "PR-100b Persistence Probe",
      specialists: JSON.stringify([{ name: "Test", title: "Tannlege" }]),
      opening_hours: JSON.stringify([{ day: "mon", open: "09:00", close: "17:00" }]),
    });

    // ── Seed: one ordinary, complete clinic (must be unaffected everywhere) ─
    const clinicId = store.createDentalAgent({
      navn: "Sentrum Tannklinikk AS",
      org_nr: CLINIC_ORGNR,
      poststed: "OSLO",
      fylke: "Oslo",
      adresse: "Storgata 1",
      telefon: "22110099",
      hjemmeside: "https://sentrumtannklinikk.example.no",
      helfo_agreement: "true",
    } as any);
    db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', specialists = ? WHERE id = ?").run(
      JSON.stringify([{ name: "Kari Nordmann", title: "Spesialist i periodonti" }]), clinicId
    );

    const probeSlug = dentalSeo.slugifyClinic("PR-100b Persistence Probe", PROBE_ORGNR);
    const clinicSlug = dentalSeo.slugifyClinic("Sentrum Tannklinikk AS", CLINIC_ORGNR);
    assertEq(probeSlug, "pr-100b-persistence-probe--999999999", "setup: probe slug matches the one seen in the prod sitemap");

    // ── A. dental-store read surfaces ────────────────────────────────────
    {
      const listed = store.listPublicDentalAgents({}, 50, 0).map((a) => a.id);
      assertTrue(!listed.includes(PROBE_ID), "A1: listPublicDentalAgents skips the probe");
      assertTrue(listed.includes(clinicId), "A2: listPublicDentalAgents still lists the ordinary clinic");
      assertEq(store.countPublicDentalAgents({}), 1, "A3: countPublicDentalAgents counts only the ordinary clinic");

      assertEq(store.listPublicDentalAgents({ q: "probe" }, 50, 0).length, 0, "A4: public search q=probe finds nothing");
      assertEq(store.countPublicDentalAgents({ q: "probe" }), 0, "A5: public search count q=probe is 0");
      assertEq(store.countPublicDentalAgents({ q: "test" }), 0, "A6: public search q=test (the probe's poststed) is 0");
      assertEq(store.countPublicDentalAgents({ q: "sentrum" }), 1, "A7: public search still finds the ordinary clinic");

      const raw = store.listDentalAgents({}, 50, 0).map((a) => a.id);
      assertTrue(!raw.includes(PROBE_ID), "A8: listDentalAgents (GET /agents, /discover) skips the probe");
      assertTrue(raw.includes(clinicId), "A9: listDentalAgents still lists the ordinary clinic");
      assertEq(store.countDentalAgents({}), 1, "A10: countDentalAgents counts only the ordinary clinic");

      const stats = store.getDentalStats();
      assertEq(stats.total, 1, "A11: getDentalStats().total (front-page count) excludes the probe");
      assertEq(stats.helfo_count, 1, "A12: getDentalStats().helfo_count excludes the probe (its helfo_agreement is 'true')");
      assertTrue(!stats.per_fylke.some((f) => f.fylke === "TEST"), "A13: getDentalStats().per_fylke has no TEST fylke");

      const mstats = store.getDentalMarketplaceStats();
      assertEq(mstats.totalAgents, 1, "A14: /api/stats totalAgents excludes the probe");
      assertEq(mstats.activeProducers, 1, "A15: /api/stats activeProducers excludes the probe");
      assertEq(mstats.cities, ["OSLO"], "A16: /api/stats cities has no 'TEST'");

      const steder = store.listPoststeder(1).map((p) => p.poststed);
      assertTrue(!steder.includes("TEST"), "A17: listPoststeder (city lists, /sted) has no TEST");
      assertTrue(steder.includes("OSLO"), "A18: listPoststeder still has OSLO");

      const sitemapOrgNrs = store.getDentalAgentsForSitemap().map((r) => r.org_nr);
      assertTrue(!sitemapOrgNrs.includes(PROBE_ORGNR), "A19: getDentalAgentsForSitemap skips the probe");
      assertTrue(sitemapOrgNrs.includes(CLINIC_ORGNR), "A20: getDentalAgentsForSitemap still lists the ordinary clinic");

      // Only the probe's specialists title contains "tannlege"; only the
      // ordinary clinic's contains "periodonti".
      assertEq(store.getAvailableSpecialties(["tannlege"]), [], "A21: getAvailableSpecialties ignores a specialty only the probe has");
      assertEq(store.getAvailableSpecialties(["periodonti"]), ["periodonti"], "A22: getAvailableSpecialties still sees the ordinary clinic's specialty");

      const clinic = store.getDentalAgentById(clinicId)!;
      db.prepare("UPDATE dental_agents SET poststed = 'OSLO' WHERE id = ?").run(PROBE_ID);
      const related = store.listRelatedClinics({ ...clinic, poststed: "OSLO" }, 6).map((a) => a.id);
      assertTrue(!related.includes(PROBE_ID), "A23: listRelatedClinics never offers the probe as a related clinic");
      db.prepare("UPDATE dental_agents SET poststed = 'TEST' WHERE id = ?").run(PROBE_ID);

      assertEq(store.getDentalAgentById(PROBE_ID)?.id, PROBE_ID, "A24: getDentalAgentById still returns the probe row (write path depends on it)");
    }

    // ── B. dental-seo routes (finn-tannlege.com) ─────────────────────────
    {
      const byId = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${PROBE_ID}` });
      assertEq(byId.status, 404, "B1: GET /klinikk/id/persistence-probe-pr100b -> 404");
      assertTrue(!byId.text.includes("test probe"), "B2: probe 404 page does not render the probe's content");

      const bySlug = await callRoute(dentalSeoRouter, { path: `/klinikk/${probeSlug}` });
      assertEq(bySlug.status, 404, "B3: GET /klinikk/pr-100b-persistence-probe--999999999 -> 404");

      const clinicById = await callRoute(dentalSeoRouter, { path: `/klinikk/id/${clinicId}` });
      assertEq(clinicById.status, 200, "B4: ordinary clinic GET /klinikk/id/:id -> 200");
      const clinicBySlug = await callRoute(dentalSeoRouter, { path: `/klinikk/${clinicSlug}` });
      assertEq(clinicBySlug.status, 200, "B5: ordinary clinic GET /klinikk/:slug -> 200");

      const stedTest = await callRoute(dentalSeoRouter, { path: "/sted/test" });
      assertEq(stedTest.status, 404, "B6: GET /sted/test (a city backed only by the probe) -> 404");
      const stedOslo = await callRoute(dentalSeoRouter, { path: "/sted/oslo" });
      assertEq(stedOslo.status, 200, "B7: GET /sted/oslo -> 200");
      assertTrue(stedOslo.text.includes("Sentrum Tannklinikk AS"), "B8: /sted/oslo still lists the ordinary clinic");

      const sitemap = await callRoute(dentalSeoRouter, { path: "/sitemap.xml" });
      assertEq(sitemap.status, 200, "B9: GET /sitemap.xml -> 200");
      assertTrue(!sitemap.text.includes("persistence-probe"), "B10: sitemap.xml contains no 'persistence-probe'");
      assertTrue(!sitemap.text.includes("/sted/test<"), "B11: sitemap.xml contains no /sted/test");
      assertTrue(sitemap.text.includes(`/klinikk/${clinicSlug}<`), "B12: sitemap.xml still lists the ordinary clinic");
      assertTrue(sitemap.text.includes("/sted/oslo<"), "B13: sitemap.xml still lists /sted/oslo");

      const sokProbe = await callRoute(dentalSeoRouter, { path: "/sok", query: { q: "probe" } });
      assertEq(sokProbe.status, 200, "B14: GET /sok?q=probe -> 200");
      assertTrue(!sokProbe.text.includes("Persistence Probe"), "B15: /sok?q=probe does not show the probe");
      const sokSentrum = await callRoute(dentalSeoRouter, { path: "/sok", query: { q: "sentrum" } });
      assertTrue(sokSentrum.text.includes("Sentrum Tannklinikk AS"), "B16: /sok?q=sentrum still shows the ordinary clinic");
    }

    // ── C. /api/tannlege routes ──────────────────────────────────────────
    {
      const list = await callRoute(dentalRouter, { path: "/agents" });
      const listIds = (list.body?.agents ?? []).map((a: any) => a.id);
      assertTrue(!listIds.includes(PROBE_ID), "C1: GET /api/tannlege/agents skips the probe");
      assertTrue(listIds.includes(clinicId), "C2: GET /api/tannlege/agents still lists the ordinary clinic");

      const search = await callRoute(dentalRouter, { path: "/agents", query: { q: "probe" } });
      assertEq(search.body?.count, 0, "C3: GET /api/tannlege/agents?q=probe -> 0 results");

      const discover = await callRoute(dentalRouter, { path: "/discover" });
      const discoverIds = (discover.body?.results ?? []).map((r: any) => r.id);
      assertTrue(!discoverIds.includes(PROBE_ID), "C4: GET /api/tannlege/discover skips the probe");
      assertTrue(discoverIds.includes(clinicId), "C5: GET /api/tannlege/discover still lists the ordinary clinic");

      const byOrgnr = await callRoute(dentalRouter, { path: `/agents/${PROBE_ORGNR}` });
      assertEq(byOrgnr.status, 404, "C6: GET /api/tannlege/agents/999999999 (org_nr lookup) -> 404");
      const clinicByOrgnr = await callRoute(dentalRouter, { path: `/agents/${CLINIC_ORGNR}` });
      assertEq(clinicByOrgnr.body?.agent?.id, clinicId, "C7: org_nr lookup still resolves the ordinary clinic");

      // AC3: the probe's write path and by-id read-back are unchanged.
      const put = await callRoute(dentalRouter, {
        method: "PUT",
        path: `/agents/${PROBE_ID}`,
        headers: { "x-admin-key": testKey },
        body: {
          om_oss: "test probe",
          online_booking_url: "https://example.com/booking",
          social_media: { facebook: "https://facebook.com/x" },
        },
      });
      assertEq(put.status, 200, "C8: AC3 fingerprint PUT on the probe id -> 200");
      assertEq(put.body?.updated, true, "C9: AC3 fingerprint PUT reports updated: true");
      const readBack = await callRoute(dentalRouter, { path: `/agents/${PROBE_ID}` });
      assertEq(readBack.status, 200, "C10: AC3 by-id GET of the probe -> 200 (read-back unchanged)");
      assertEq(readBack.body?.agent?.online_booking_url, "https://example.com/booking", "C11: AC3 probe payload round-trips");
    }

    // ── D. dental A2A (message/send) ─────────────────────────────────────
    {
      const dataOf = (r: any) => r?.result?.artifacts?.flatMap((a: any) => a.parts ?? []) ?? [];

      const probeLookup = dentalA2a.handleDentalMessageSend({ message: { text: `Finn klinikk ${PROBE_ORGNR}` } }, 1) as any;
      const probeParts = dataOf(probeLookup);
      assertTrue(
        probeParts.some((p: any) => p.kind === "text" && String(p.text).startsWith("Ingen klinikk funnet")),
        "D1: A2A org_nr lookup of 999999999 -> 'Ingen klinikk funnet'"
      );
      assertTrue(!JSON.stringify(probeLookup).includes(PROBE_ID), "D2: A2A org_nr lookup does not leak the probe row");

      const clinicLookup = dentalA2a.handleDentalMessageSend({ message: { text: `Finn klinikk ${CLINIC_ORGNR}` } }, 2) as any;
      assertTrue(
        dataOf(clinicLookup).some((p: any) => p.kind === "data" && p.data?.id === clinicId),
        "D3: A2A org_nr lookup still resolves the ordinary clinic"
      );

      const search = dentalA2a.handleDentalMessageSend({ message: { text: "persistence probe" } }, 3) as any;
      const searchData = dataOf(search).find((p: any) => p.kind === "data")?.data;
      assertEq(searchData?.count, 0, "D4: A2A free-text search 'persistence probe' -> 0 clinics");

      const stats = dentalA2a.handleDentalMessageSend({ message: { text: "statistikk" } }, 4) as any;
      assertEq(dataOf(stats).find((p: any) => p.kind === "data")?.data?.total, 1, "D5: A2A stats total excludes the probe");
    }

    // ── E. admin counts the reports use ──────────────────────────────────
    {
      const ps = await callRoute(adminCatalogClassRouter, {
        path: "/parking-stats",
        headers: { "x-admin-key": testKey },
      });
      assertEq(ps.status, 200, "E1: GET /admin/dental/parking-stats -> 200");
      assertEq(ps.body?.data?.total, 1, "E2: parking-stats total excludes the probe");
      assertEq(ps.body?.data?.parking?.needs_review, 0, "E3: parking-stats needs_review no longer counts the probe");
      assertTrue(
        ps.body?.data?.by_verification_status?.needs_review === undefined,
        "E4: parking-stats by_verification_status has no needs_review bucket from the probe"
      );
      assertEq(ps.body?.data?.pool?.missing_lat, 1, "E5: parking-stats pool counts still see the ordinary clinic");

      const cohort = verifier.pickDentalVerifierBatch(db, 500).map((c) => c.id);
      assertTrue(!cohort.includes(PROBE_ID), "E6: pickDentalVerifierBatch (verifier cohort) skips the probe");
      assertTrue(cohort.includes(clinicId), "E7: pickDentalVerifierBatch still picks the ordinary clinic");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental synthetic probe hidden: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalSyntheticProbeHiddenTests({ log: true }).then((r) => {
    console.log(`\ndental synthetic probe hidden: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
