/**
 * dental-store.test.ts — unit tests for the PUBLIC-facing read surfaces in
 * src/services/dental-store.ts (dev-request
 * 2026-09-03-dental-catalog-class-public-filter, slice 1b).
 *
 * Slice 1b adds an opt-in catalog_class exclusion (env
 * DENTAL_PUBLIC_CATALOG_CLASS_FILTER="1") to the query/count/sitemap
 * functions that back the public site (/sok, /fylke, /sted + front-page/
 * county/city counters), the MCP server's tannlege_* tools, and the
 * finn-tannlege.com sitemap: listPublicDentalAgents, countPublicDentalAgents,
 * getDentalStats, getDentalAgentsForSitemap, listRelatedClinics, and
 * listPoststeder. Same shared DENTAL_CLINIC_CLASS_SQL clause the claim-pool
 * (dental-claim-service.ts) and Places auto-select (routes/dental.ts) already
 * use — NULL/"ukjent" rows stay eligible, only positively-classified
 * person_enk/lab_leverandor/holding rows are excluded.
 *
 * Covers, for EACH of the six functions above:
 *   - flag unset/falsy -> byte-identical to pre-slice-1b behavior (all 7
 *     seeded rows visible/counted, regardless of catalog_class).
 *   - flag "1" -> the 3 positively-classified non-clinic rows (person_enk,
 *     lab_leverandor, holding) are excluded; the 4 clinic-eligible rows
 *     (catalog_class NULL, "klinikk", "offentlig_klinikk", "ukjent") stay,
 *     and every counter (countPublicDentalAgents, getDentalStats().total,
 *     listPoststeder's per-poststed count) matches the filtered listing.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-store.test.ts
 *   2. Wired into the gate: tests/test.ts imports runDentalStorePublicCatalogClassFilterTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalStorePublicCatalogClassFilterTests(
  opts: { log?: boolean } = {}
): TestSummary {
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
  const prevFlag = process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
  process.env.DENTAL_DB_PATH = ":memory:";
  delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;

  const dbFactoryPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("./dental-store");
  const catalogClassPath = require.resolve("./dental-catalog-class");
  const cachePaths = [dbFactoryPath, dentalStorePath, catalogClassPath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const store = require("./dental-store") as typeof import("./dental-store");
    const db = dbFactory.getDb("dental");

    // ── Seed: 7 rows in the same poststed, one per catalog_class outcome ──
    const ids: Record<string, string> = {};
    const seed = [
      { key: "nullClass", navn: "Uklassifisert Tannklinikk AS", org_nr: "911600001", catalog_class: null },
      { key: "klinikk", navn: "Ordinaer Tannklinikk AS", org_nr: "911600002", catalog_class: "klinikk" },
      { key: "offentlig", navn: "Kommunal Tannklinikk", org_nr: "911600003", catalog_class: "offentlig_klinikk" },
      { key: "ukjent", navn: "Ukjent Klasse AS", org_nr: "911600004", catalog_class: "ukjent" },
      { key: "personEnk", navn: "OLA NORDMANN", org_nr: "911600005", catalog_class: "person_enk" },
      { key: "lab", navn: "Nordic Dental Lab AS", org_nr: "911600006", catalog_class: "lab_leverandor" },
      { key: "holding", navn: "Tannhelse Holding AS", org_nr: "911600007", catalog_class: "holding" },
    ] as const;

    for (const row of seed) {
      const id = store.createDentalAgent({
        navn: row.navn,
        org_nr: row.org_nr,
        fylke: "OSLO",
        poststed: "OSLO",
      } as any);
      ids[row.key] = id;
      if (row.catalog_class !== null) {
        db.prepare("UPDATE dental_agents SET catalog_class = ? WHERE id = ?").run(row.catalog_class, id);
      }
    }

    const EXCLUDED_KEYS = ["personEnk", "lab", "holding"];
    const CLINIC_KEYS = ["nullClass", "klinikk", "offentlig", "ukjent"];

    // ── Flag OFF (unset): every function returns/counts all 7 rows ──────
    {
      delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;

      assertEq(store.countPublicDentalAgents({}), 7, "flag-off: countPublicDentalAgents counts all 7 rows");

      const listed = store.listPublicDentalAgents({}, 50, 0);
      assertEq(listed.length, 7, "flag-off: listPublicDentalAgents returns all 7 rows");

      const stats = store.getDentalStats();
      assertEq(stats.total, 7, "flag-off: getDentalStats().total counts all 7 rows");

      const sitemapRows = store.getDentalAgentsForSitemap();
      assertEq(sitemapRows.length, 7, "flag-off: getDentalAgentsForSitemap lists all 7 rows");

      const steder = store.listPoststeder(1);
      const oslo = steder.find((s) => s.poststed === "OSLO");
      assertEq(oslo?.count, 7, "flag-off: listPoststeder counts all 7 rows for OSLO");

      const clinicAAgent = store.getDentalAgentById(ids.nullClass)!;
      const related = store.listRelatedClinics(clinicAAgent, 20);
      assertEq(related.length, 6, "flag-off: listRelatedClinics returns all 6 OTHER rows (self excluded, nothing else)");
    }

    // ── Flag ON ("1"): person_enk/lab_leverandor/holding excluded everywhere ──
    {
      process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER = "1";

      assertEq(store.countPublicDentalAgents({}), 4, "flag-on: countPublicDentalAgents excludes the 3 non-clinic rows -> 4");

      const listed = store.listPublicDentalAgents({}, 50, 0);
      assertEq(listed.length, 4, "flag-on: listPublicDentalAgents returns 4 rows");
      const listedIds = new Set(listed.map((a) => a.id));
      for (const k of CLINIC_KEYS) {
        assertTrue(listedIds.has(ids[k]), `flag-on: listPublicDentalAgents includes clinic-eligible row '${k}'`);
      }
      for (const k of EXCLUDED_KEYS) {
        assertTrue(!listedIds.has(ids[k]), `flag-on: listPublicDentalAgents excludes non-clinic row '${k}'`);
      }

      const stats = store.getDentalStats();
      assertEq(stats.total, 4, "flag-on: getDentalStats().total matches the filtered set -> 4");
      const oslo_stat = stats.per_fylke.find((f) => f.fylke === "OSLO");
      assertEq(oslo_stat?.count, 4, "flag-on: getDentalStats().per_fylke OSLO count matches the filtered set -> 4");

      const sitemapRows = store.getDentalAgentsForSitemap();
      assertEq(sitemapRows.length, 4, "flag-on: getDentalAgentsForSitemap lists 4 rows");
      const sitemapOrgNrs = new Set(sitemapRows.map((r) => r.org_nr));
      assertTrue(!sitemapOrgNrs.has("911600005"), "flag-on: sitemap excludes the person_enk row");
      assertTrue(!sitemapOrgNrs.has("911600006"), "flag-on: sitemap excludes the lab_leverandor row");
      assertTrue(!sitemapOrgNrs.has("911600007"), "flag-on: sitemap excludes the holding row");
      assertTrue(sitemapOrgNrs.has("911600002"), "flag-on: sitemap still includes the klinikk row");

      const steder = store.listPoststeder(1);
      const osloSted = steder.find((s) => s.poststed === "OSLO");
      assertEq(osloSted?.count, 4, "flag-on: listPoststeder counts only the 4 clinic-eligible rows for OSLO");

      const clinicAAgent = store.getDentalAgentById(ids.nullClass)!;
      const related = store.listRelatedClinics(clinicAAgent, 20);
      assertEq(related.length, 3, "flag-on: listRelatedClinics returns only the 3 OTHER clinic-eligible rows");
      const relatedIds = new Set(related.map((a) => a.id));
      assertTrue(!relatedIds.has(ids.personEnk), "flag-on: listRelatedClinics excludes person_enk");
      assertTrue(!relatedIds.has(ids.lab), "flag-on: listRelatedClinics excludes lab_leverandor");
      assertTrue(!relatedIds.has(ids.holding), "flag-on: listRelatedClinics excludes holding");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental-store public catalog-class filter: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevFlag === undefined) delete process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER;
    else process.env.DENTAL_PUBLIC_CATALOG_CLASS_FILTER = prevFlag;
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
  const r = runDentalStorePublicCatalogClassFilterTests({ log: true });
  console.log(`\ndental-store public catalog-class filter: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
