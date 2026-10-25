/**
 * dental-acute-claim.test.ts -- dev-request
 * 2026-10-06-dental-nedlagte-og-akuttpastander, skive B, and A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, F1-S4c.
 * «Akuttvakt»/«tannlegevakt» only when a source in field_provenance.acute_vakt
 * stores the quote from the source page; a stamp without a quote, or akutt in
 * patient_focus, gives «Tar imot akuttpasienter»; else nothing.
 *   H   resolveAcuteClaim / hasAcuteVaktQuote: «vakt» only with a quote, in
 *       the array and the {sources} form; a stamp, an empty, blank or
 *       non-string quote, or a quote outside the sources is no vakt;
 *       acute_vakt 0 with a quote follows patient_focus; malformed input
 *       throws nothing.
 *   R/L the HTML profile (badge, description, JSON-LD) and the /sok card;
 *   M   the MCP badges.
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
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    // ── pure helper ──
    const claim = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");
    // A source as the enrichment stores it (a stamp), and the same with the quote from the page.
    const stampSource = { value: "1", source_type: "homepage", source_url: "https://example.no/akutt", fetched_at: "2026-05-01T10:00:00Z" };
    const quoteSource = { ...stampSource, quote: "Vi har akuttvakt alle kvelder og i helgene." };
    const prov = { acute_vakt: [quoteSource] };
    const stamp = { acute_vakt: [stampSource] };
    const withQuote = (quote: unknown) => ({ acute_vakt: [{ ...stampSource, quote }] });
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: prov }) === "vakt", "H1: flag + a source with a quote -> vakt");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { sources: [quoteSource] } } }) === "vakt", "H2: object-with-sources provenance with a quote -> vakt");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: null }) === null, "H3: flag without provenance, no focus -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [] } }) === null, "H4: empty provenance array -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { telefon: [{ a: 1, quote: "Akuttvakt" }] } }) === null, "H5: provenance (with a quote) for another field only -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, patient_focus: ["Akutt"] }) === "accepts", "H6: no provenance + patient_focus akutt -> accepts");
    ok(claim.resolveAcuteClaim({ acute_vakt: 0, field_provenance: prov }) === null, "H7: a quote but flag 0, no focus -> null");
    ok(claim.resolveAcuteClaim({ acute_vakt: null, patient_focus: ["barn", "akuttpasienter"] }) === "accepts", "H8: flag null + focus akutt -> accepts");
    ok(claim.resolveAcuteClaim({ acute_vakt: 0, field_provenance: prov, patient_focus: ["Akutt"] }) === "accepts", "H7b: a quote but flag 0 follows patient_focus (akutt -> accepts)");

    // F1-S4c: a stamp is provenance, not evidence of a vakt.
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: stamp }) === "accepts", "H9: flag + a stamp without a quote (array form) -> accepts");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { sources: [stampSource] } } }) === "accepts", "H10: flag + a stamp in the {sources} form -> accepts");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: withQuote("") }) === "accepts", "H11: an empty quote -> accepts");
    ok(["   ", " \n\t", "\u00a0\u2003\u3000\ufeff"].every((q) => claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: withQuote(q) }) === "accepts"),
      "H12: a quote of only whitespace (spaces, newline, tab, no-break and other Unicode spaces) -> accepts");
    ok([1, 0, true, null, ["Akuttvakt"], { text: "Akuttvakt" }].every((q) => claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: withQuote(q) }) === "accepts"),
      "H13: a quote that is not a string (number, boolean, null, array, object) -> accepts");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [stampSource, { ...stampSource, quote: " Akuttvakt hver kveld " }] } }) === "vakt" &&
      claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { sources: [stampSource, quoteSource] } } }) === "vakt",
      "H14: one source of several with a quote is enough, in either form");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { quote: "Akuttvakt", sources: [stampSource] } } }) === "accepts" &&
      claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { quote: "Akuttvakt" } } }) === null &&
      claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: { sources: [], other: { quote: "Akuttvakt" } } } }) === null,
      "H15: a quote outside the sources counts for nothing (beside a stamp -> accepts; with no source -> null)");
    ok(claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: ["Akuttvakt", ["quote", "Akuttvakt"]] } }) === "accepts" &&
      claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: { acute_vakt: [{ ...stampSource, Quote: "Akuttvakt" }] } }) === "accepts",
      "H16: a source that is a string or an array, or a key «Quote», has no quote -> accepts");
    let threw = "";
    const odd: unknown[] = ["{bad", "[]", 7, [], [{ acute_vakt: [quoteSource] }], { acute_vakt: "Akuttvakt" }, { acute_vakt: null }, { acute_vakt: [null, 1] }];
    let oddClaims: unknown[] = [];
    try {
      oddClaims = odd.map((fp) => claim.resolveAcuteClaim({ acute_vakt: 1, field_provenance: fp as any }));
    } catch (err: any) {
      threw = String(err?.message || err);
    }
    ok(threw === "" && JSON.stringify(oddClaims) === JSON.stringify([null, null, null, null, null, null, null, "accepts"]),
      `H17: malformed provenance (a string, an array, a scalar entry) throws nothing and is no vakt (${threw || JSON.stringify(oddClaims)})`);
    ok(claim.hasAcuteVaktQuote(prov) && !claim.hasAcuteVaktQuote(stamp) && claim.hasAcuteVaktProvenance(stamp) && !claim.hasAcuteVaktQuote(null) && !claim.hasAcuteVaktQuote(undefined),
      "H18: hasAcuteVaktQuote: true with a quote, false for a stamp (which hasAcuteVaktProvenance still sees), null or undefined");

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
    const A = mk("Vakt Med Kilde Tannklinikk AS", "918800001", 1, prov, null);
    const B = mk("Vakt Uten Kilde Tannklinikk AS", "918800002", 1, null, null);
    const C = mk("Vakt Uten Kilde Men Akutt Tannklinikk AS", "918800003", 1, null, ["Akutt"]);
    // F1-S4c: the stamp every live «Akuttvakt» row had (a source without a quote).
    const S = mk("Vakt Med Stempel Tannklinikk AS", "918800004", 1, stamp, null);
    const X = mk("Vakt Med Ugyldig Kilde Tannklinikk AS", "918800005", 1, null, null);
    db.prepare("UPDATE dental_agents SET field_provenance = '{bad json' WHERE id = ?").run(X.id);

    const page = async (c: { slug: string }) => (await callRoute(router, `/klinikk/${c.slug}`)).text;
    const pa = await page(A), pb = await page(B), pc = await page(C), ps = await page(S);
    ok(pa.includes(">Akuttvakt<"), "R1: sourced clinic shows Akuttvakt badge");
    ok(pa.includes("tannlegevakt"), "R2: sourced clinic JSON-LD/description says tannlegevakt");
    ok(!pb.includes(">Akuttvakt<"), "R3: unsourced clinic has no Akuttvakt badge");
    ok(!/tannlegevakt ved akutte/.test(pb), "R4: unsourced clinic has no tannlegevakt claim in description/JSON-LD");
    ok(!pb.includes("Tar imot akuttpasienter"), "R5: unsourced clinic without akutt focus shows no soft claim");
    ok(!pc.includes(">Akuttvakt<"), "R6: unsourced clinic with akutt focus has no Akuttvakt badge");
    ok(pc.includes(">Tar imot akuttpasienter<"), "R7: unsourced clinic with akutt focus shows soft claim badge");
    ok(!/tannlegevakt ved akutte/.test(pc) && pc.includes("Tar imot akuttpasienter."), "R8: description/JSON-LD uses soft claim for akutt focus");
    ok(!ps.includes(">Akuttvakt<") && ps.includes(">Tar imot akuttpasienter<"), "R9: a stamped clinic without a quote shows «Tar imot akuttpasienter», not «Akuttvakt» (F1-S4c)");
    ok(!/tannlegevakt ved akutte/.test(ps) && ps.includes("Tar imot akuttpasienter."), "R10: ... and its description/JSON-LD has the soft claim, no tannlegevakt");
    const px = await callRoute(router, `/klinikk/${X.slug}`);
    ok(px.status === 200 && !px.text.includes(">Akuttvakt<") && !px.text.includes("Tar imot akuttpasienter"), "R11: malformed provenance JSON: the profile renders, with no akutt claim");

    // list card
    const list = (await callRoute(router, "/sok")).text;
    const cardOf = (name: string) => { const i = list.indexOf(name); return i < 0 ? "" : list.slice(i, i + 1500); };
    ok(cardOf("Vakt Uten Kilde Tannklinikk AS").length > 0, "L0: list contains unsourced clinic");
    ok(!cardOf("Vakt Uten Kilde Tannklinikk AS").split("Vakt Med Kilde")[0].includes("badge-akutt"), "L1: unsourced list card has no akutt badge");
    const stampCard = cardOf("Vakt Med Stempel Tannklinikk AS").split("</article>")[0];
    ok(stampCard.includes(`<span class="badge badge-akutt">Tar imot akuttpasienter</span>`) && !stampCard.includes(">Akuttvakt<"), "L2: the stamped clinic's list card says «Tar imot akuttpasienter», not «Akuttvakt»");
    const quotedCard = cardOf("Vakt Med Kilde Tannklinikk AS").split("</article>")[0];
    ok(quotedCard.includes(`<span class="badge badge-akutt">Akuttvakt</span>`), "L3: the clinic with a quote keeps «Akuttvakt» on its list card");

    // MCP
    const results = mcp.buildSearchResults([A, B, C, S].map((x) => store.getDentalAgentById(x.id)!) as any);
    const byName = (n: string) => results.find((r: any) => r.navn === n)!;
    ok(byName("Vakt Med Kilde Tannklinikk AS").badges.includes("Akuttvakt"), "M1: MCP sourced -> Akuttvakt");
    ok(!byName("Vakt Uten Kilde Tannklinikk AS").badges.some((b: string) => /akutt/i.test(b)), "M2: MCP unsourced -> no akutt badge");
    const c = byName("Vakt Uten Kilde Men Akutt Tannklinikk AS").badges;
    ok(!c.includes("Akuttvakt") && c.includes("Tar imot akuttpasienter"), "M3: MCP unsourced + akutt focus -> soft claim only");
    const st = byName("Vakt Med Stempel Tannklinikk AS");
    ok(st.akutt === "accepts" && !st.badges.includes("Akuttvakt") && st.badges.includes("Tar imot akuttpasienter"), "M4: MCP stamp without a quote -> akutt «accepts», soft claim only");
  } catch (err: any) {
    failed++;
    failures.push("dental acute claim: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prev === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prev;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    restoreModuleCache();
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
