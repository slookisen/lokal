/**
 * dental-acute-claim.test.ts -- dev-request
 * 2026-10-06-dental-nedlagte-og-akuttpastander, skive B.
 * «Akuttvakt»/«tannlegevakt» only with field_provenance.acute_vakt; otherwise
 * «Tar imot akuttpasienter» when patient_focus mentions akutt; else nothing.
 * Covers HTML profile, list card, JSON-LD description and MCP badges/get flag.
 *
 * Standalone: npx tsx src/routes/dental-acute-claim.test.ts
 */

export interface TestSummary { passed: number; failed: number; failures: string[] }

function callRoute(router: any, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query: {}, headers: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      setHeader() { return this; },
      send(p: any) { resolve({ status: this.statusCode, text: String(p ?? "") }); return this; },
      json(p: any) { resolve({ status: this.statusCode, text: JSON.stringify(p) }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled") }));
  });
}

export async function runDentalAcuteClaimTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // ── pure helper ──
    const claim = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
    const prov = { acute_vakt: [{ source_type: "homepage", value: 1 }] };
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: prov }) === "vakt", "H1: flag + provenance -> vakt");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { sources: [{ source_type: "x" }] } } }) === "vakt", "H2: object-with-sources provenance -> vakt");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: null }) === null, "H3: flag without provenance, no focus -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [] } }) === null, "H4: empty provenance array -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { telefon: [{ a: 1 }] } }) === null, "H5: provenance for other field only -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, patient_focus: ["Akutt"] }) === "accepts", "H6: no provenance + patient_focus akutt -> accepts");
    ok(claim.resolveAcuteClaim({ acute_vakt: 0, field_provenance: prov }) === null, "H7: provenance but flag 0 -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: null, patient_focus: ["barn", "akuttpasienter"] }) === "accepts", "H8: flag null + focus akutt -> accepts");

    // ── routes / MCP ──
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const seo = require("./dental-seo") as typeof import("./dental-seo");
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const router = seo.default as any;

    const mk = (navn: string, org: string, vakt: number, fp: object | null, focus: string[] | null): { id: string; slug: string } => {
      const id = store.createDentalAgent({
        navn, org_nr: org, poststed: "BY" + org, fylke: "Oslo", adresse: "Storgata 1",
        telefon: "22110099", hjemmeside: "https://example.no",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class='klinikk', acute_vakt=?, field_provenance=?, patient_focus=? WHERE id=?")
        .run(vakt, fp ? JSON.stringify(fp) : null, focus ? JSON.stringify(focus) : null, id);
      return { id, slug: seo.slugifyClinic(navn, org) };
    };
    const A = mk("Vakt Med Kilde Tannklinikk AS", "918800001", 1, { acute_vakt: [{ source_type: "homepage", value: 1 }] }, null);
    const B = mk("Vakt Uten Kilde Tannklinikk AS", "918800002", 1, null, null);
    const C = mk("Vakt Uten Kilde Men Akutt Tannklinikk AS", "918800003", 1, null, ["Akutt"]);

    const page = async (c: { slug: string }) => (await callRoute(router, `/klinikk/${c.slug}`)).text;
    const pa = await page(A), pb = await page(B), pc = await page(C);
    ok(pa.includes(">Akuttvakt<"), "R1: sourced clinic shows Akuttvakt badge");
    ok(pa.includes("tannlegevakt"), "R2: sourced clinic JSON-LD/description says tannlegevakt");
    ok(!pb.includes(">Akuttvakt<"), "R3: unsourced clinic has no Akuttvakt badge");
    ok(!/tannlegevakt ved akutte/.test(pb), "R4: unsourced clinic has no tannlegevakt claim in description/JSON-LD");
    ok(!pb.includes("Tar imot akuttpasienter"), "R5: unsourced clinic without akutt focus shows no soft claim");
    ok(!pc.includes(">Akuttvakt<"), "R6: unsourced clinic with akutt focus has no Akuttvakt badge");
    ok(pc.includes(">Tar imot akuttpasienter<"), "R7: unsourced clinic with akutt focus shows soft claim badge");
    ok(!/tannlegevakt ved akutte/.test(pc) && pc.includes("Tar imot akuttpasienter."), "R8: description/JSON-LD uses soft claim for akutt focus");

    // list card
    const list = (await callRoute(router, "/sok")).text;
    const cardOf = (name: string) => { const i = list.indexOf(name); return i < 0 ? "" : list.slice(i, i + 1500); };
    ok(cardOf("Vakt Uten Kilde Tannklinikk AS").length > 0, "L0: list contains unsourced clinic");
    ok(!cardOf("Vakt Uten Kilde Tannklinikk AS").split("Vakt Med Kilde")[0].includes("badge-akutt"), "L1: unsourced list card has no akutt badge");

    // MCP
    const results = mcp.buildSearchResults([A, B, C].map((x) => store.getDentalAgentById(x.id)!) as any);
    const byName = (n: string) => results.find((r: any) => r.navn === n)!;
    ok(byName("Vakt Med Kilde Tannklinikk AS").badges.includes("Akuttvakt"), "M1: MCP sourced -> Akuttvakt");
    ok(!byName("Vakt Uten Kilde Tannklinikk AS").badges.some((b: string) => /akutt/i.test(b)), "M2: MCP unsourced -> no akutt badge");
    const c = byName("Vakt Uten Kilde Men Akutt Tannklinikk AS").badges;
    ok(!c.includes("Akuttvakt") && c.includes("Tar imot akuttpasienter"), "M3: MCP unsourced + akutt focus -> soft claim only");
  } catch (err: any) {
    failed++;
    failures.push("dental acute claim: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prev === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prev;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    for (const p of cachePaths) delete require.cache[p];
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalAcuteClaimTests({ log: true }).then((r) => {
    console.log(`\ndental acute claim: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
