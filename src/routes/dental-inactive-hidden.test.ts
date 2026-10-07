/**
 * dental-inactive-hidden.test.ts -- dev-request
 * 2026-10-06-dental-nedlagte-og-akuttpastander, skive A.
 *
 * Permanently-closed clinics (is_inactive=1) must not appear in related-clinic
 * links, poststed lists/counts or the sitemap; their profile page still
 * renders (200) but with a "Nedlagt" notice and noindex. A /sted page with 0
 * active clinics is never indexable (404 via listPoststeder, noindex fallback).
 *
 * Same harness as dental-synthetic-probe-hidden.test.ts (in-memory dental DB,
 * routers driven through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-inactive-hidden.test.ts
 * Wired into tests/test.ts via runDentalInactiveHiddenTests().
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


export async function runDentalInactiveHiddenTests(
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
  process.env.DENTAL_DB_PATH = ":memory:";

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
  ];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const router = dentalSeo.default as any;

    const mk = (navn: string, org_nr: string, poststed: string, inactive: boolean): string => {
      const id = store.createDentalAgent({
        navn, org_nr, poststed, fylke: "Oslo",
        adresse: "Storgata 1", telefon: "22110099",
        hjemmeside: "https://example.no",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', is_inactive = ? WHERE id = ?").run(inactive ? 1 : 0, id);
      return id;
    };
    const activeId = mk("Aktiv Tannklinikk AS", "918900001", "OSLO", false);
    const activeId2 = mk("Annen Aktiv Tannklinikk AS", "918900002", "OSLO", false);
    const closedId = mk("Nedlagt Tannklinikk AS", "918900003", "OSLO", true);
    const onlyClosedId = mk("Eneste Nedlagte Tannklinikk AS", "918900004", "GHOSTBY", true);

    const closedSlug = dentalSeo.slugifyClinic("Nedlagt Tannklinikk AS", "918900003");
    const activeSlug = dentalSeo.slugifyClinic("Aktiv Tannklinikk AS", "918900001");

    // ── A. dental-store ──────────────────────────────────────────────────
    {
      const closed = store.getDentalAgentById(closedId);
      assertEq(closed?.is_inactive, 1, "A1: hydrateAgent exposes is_inactive=1 for a closed clinic");
      assertEq(store.getDentalAgentById(activeId)?.is_inactive, 0, "A2: hydrateAgent exposes is_inactive=0 for an active clinic");

      const active = store.getDentalAgentById(activeId)!;
      const related = store.listRelatedClinics(active, 20).map((a) => a.id);
      assertTrue(!related.includes(closedId), "A3: listRelatedClinics never offers a closed clinic");
      assertTrue(related.includes(activeId2), "A4: listRelatedClinics still offers the other active clinic");

      const steder = store.listPoststeder(1);
      const oslo = steder.find((p) => p.poststed === "OSLO");
      assertEq(oslo?.count, 2, "A5: listPoststeder count for OSLO excludes the closed clinic");
      assertTrue(!steder.some((p) => p.poststed === "GHOSTBY"), "A6: listPoststeder drops a poststed with only closed clinics");

      const sitemap = store.getDentalAgentsForSitemap().map((r) => r.org_nr);
      assertTrue(!sitemap.includes("918900003"), "A7: sitemap excludes the closed clinic");
      assertTrue(!sitemap.includes("918900004"), "A8: sitemap excludes the only-closed-poststed clinic");
      assertTrue(sitemap.includes("918900001"), "A9: sitemap still lists an active clinic");
    }

    // ── B. routes ────────────────────────────────────────────────────────
    {
      const closedPage = await callRoute(router, { path: `/klinikk/${closedSlug}` });
      assertEq(closedPage.status, 200, "B1: closed clinic profile still renders (200)");
      assertTrue(closedPage.text.includes("Nedlagt"), "B2: closed clinic profile shows the Nedlagt notice");
      assertTrue(/<meta name="robots" content="noindex,follow">/.test(closedPage.text), "B3: closed clinic profile emits noindex");

      const closedById = await callRoute(router, { path: `/klinikk/id/${closedId}` });
      assertTrue(/<meta name="robots" content="noindex,follow">/.test(closedById.text), "B4: closed clinic by-id profile emits noindex");

      const activePage = await callRoute(router, { path: `/klinikk/${activeSlug}` });
      assertEq(activePage.status, 200, "B5: active clinic profile -> 200");
      assertTrue(!/content="noindex/.test(activePage.text), "B6: active clinic profile stays indexable");
      assertTrue(!activePage.text.includes("Nedlagt"), "B7: active clinic profile has no Nedlagt notice");
      assertTrue(!activePage.text.includes(closedSlug), "B8: active clinic profile has no related link to the closed clinic");

      const sitemap = await callRoute(router, { path: "/sitemap.xml" });
      assertEq(sitemap.status, 200, "B9: GET /sitemap.xml -> 200");
      assertTrue(!sitemap.text.includes(closedSlug), "B10: sitemap.xml has no closed clinic");
      assertTrue(!sitemap.text.includes("/sted/ghostby<"), "B11: sitemap.xml has no /sted for a poststed with only closed clinics");
      assertTrue(sitemap.text.includes(`/klinikk/${activeSlug}<`), "B12: sitemap.xml still lists the active clinic");

      const ghost = await callRoute(router, { path: "/sted/ghostby" });
      assertTrue(ghost.status === 404 || /content="noindex/.test(ghost.text), "B13: /sted with 0 active clinics is 404 or noindex");
      const oslo = await callRoute(router, { path: "/sted/oslo" });
      assertEq(oslo.status, 200, "B14: /sted/oslo -> 200");
      assertTrue(!/content="noindex/.test(oslo.text), "B15: /sted/oslo stays indexable");
      assertTrue(!oslo.text.includes(closedSlug), "B16: /sted/oslo does not list the closed clinic");
    }
    void onlyClosedId;
  } catch (err: any) {
    failed++;
    failures.push("dental inactive hidden: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
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
  runDentalInactiveHiddenTests({ log: true }).then((r) => {
    console.log(`\ndental inactive hidden: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
