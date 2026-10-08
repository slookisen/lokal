/**
 * dental-profile-url.test.ts -- dev-request
 * 2026-10-06-dental-profil-url-og-sitemap-uten-orgnr, skive A.
 * clinicProfileUrl: /klinikk/<slug> only for rows with an org.nr (the only
 * rows /klinikk/:slug resolves), /klinikk/id/<id> otherwise. MCP uses it.
 *
 * Standalone: npx tsx src/routes/dental-profile-url.test.ts
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runDentalProfileUrlTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => {
    if (c) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };

  const prev = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
    require.resolve("./dental-mcp"),
  ];
  for (const p of cachePaths) delete require.cache[p];

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const seo = require("./dental-seo") as typeof import("./dental-seo");
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");

    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";

    // ── pure helper ──
    const withOrg = { id: "abc-1", navn: "Æble Tannklinikk AS", org_nr: "918700001" };
    const u1 = seo.clinicProfileUrl(withOrg);
    ok(u1 === `${base}/klinikk/${seo.slugifyClinic(withOrg.navn, withOrg.org_nr)}`, "U1: org.nr row -> slug URL");
    ok(u1.endsWith("--918700001") && !u1.includes("/klinikk/id/"), "U2: slug URL carries org.nr suffix");
    const noOrg = { id: "abc-2", navn: "Ola Nordmann", org_nr: null };
    ok(seo.clinicProfileUrl(noOrg) === `${base}/klinikk/id/abc-2`, "U3: null org.nr -> id URL");
    ok(seo.clinicProfileUrl({ id: "abc-3", navn: "X", org_nr: "" }) === `${base}/klinikk/id/abc-3`, "U4: empty org.nr -> id URL");
    ok(seo.clinicProfileUrl({ id: "abc-4", navn: "X" }) === `${base}/klinikk/id/abc-4`, "U5: undefined org.nr -> id URL");
    ok(seo.clinicProfileUrl({ id: "abc-5", navn: "X", org_nr: "12345" }) === `${base}/klinikk/id/abc-5`, "U6: malformed org.nr (slug would not resolve) -> id URL");
    const odd = { id: "abc-6", navn: "Tann & Kjeve «Øst» / Vest -- 100%", org_nr: "918 700 002" };
    const u7 = seo.clinicProfileUrl(odd);
    ok(/^[^ ]+\/klinikk\/[a-z0-9-]+--918700002$/.test(u7) && seo.parseClinicSlug(u7.split("/klinikk/")[1]!)?.orgNr === "918700002", "U7: special chars + spaced org.nr -> clean slug that parseClinicSlug resolves");

    // ── MCP ──
    const mk = (navn: string, org: string | null): string => store.createDentalAgent({
      navn, org_nr: org as any, poststed: "BY", fylke: "Oslo", adresse: "Storgata 1",
      telefon: "22110099", hjemmeside: "https://example.no",
    } as any);
    const idWith = mk("Med Orgnr Tannklinikk AS", "918700010");
    const idWithout = mk("Uten Orgnr Tannklinikk", null);
    const rows = [idWith, idWithout].map((id) => store.getDentalAgentById(id)!) as any;
    const results = mcp.buildSearchResults(rows);
    const rWith = results.find((r: any) => r.navn === "Med Orgnr Tannklinikk AS")!;
    const rWithout = results.find((r: any) => r.navn === "Uten Orgnr Tannklinikk")!;
    ok(rWith.profil_url === `${base}/klinikk/${seo.slugifyClinic("Med Orgnr Tannklinikk AS", "918700010")}`, "M1: MCP row with org.nr -> slug URL");
    ok(rWithout.profil_url === `${base}/klinikk/id/${idWithout}`, "M2: MCP row without org.nr -> /klinikk/id/<id>");
    ok(!new RegExp(`/klinikk/(?!id/)`).test(rWithout.profil_url), "M3: no /klinikk/<slug> URL for row without org.nr");
  } catch (err: any) {
    failed++;
    failures.push("dental profile url: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prev === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prev;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    for (const p of cachePaths) delete require.cache[p];
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalProfileUrlTests({ log: true }).then((r) => {
    console.log(`\ndental profile url: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
