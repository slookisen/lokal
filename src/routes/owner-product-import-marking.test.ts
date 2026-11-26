/**
 * owner-product-import-marking.test.ts — vareopphenting punkt 3 + 5:
 * «Sjekk prisen» on LLM-read rows (+ explanation only when ≥1 row marked) and the
 * reason text of the «found nothing» view by outcome. Pure rendering, no DB, no network.
 * Standalone: npx tsx src/routes/owner-product-import-marking.test.ts
 */
export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runOwnerProductImportMarkingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => { if (cond) passed++; else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.info(`✗ ${label}`); } };
  try {
    const m = require("./owner-product-import") as typeof import("./owner-product-import");
    const cand = (id: string, name: string, llm: boolean): any => ({
      id, name, price_nok: 100, price_text: "100 kr", unit: "stk", price_is_from: false, price_excl_vat: false, pack_size: null,
      tier: llm ? "llm" : "shopify", llm, source_url: null, fetched_at: "2026-11-25 10:00:00", rules: [], status: "pending",
      price_missing_on_site: false, price_missing_text: null, publish_blocked: null, publish_blocked_text: null,
    });
    const preview = (over: any): any => ({
      run_id: "run-1", status: "completed", outcome: "ok", tier: null, website: "https://gard.no/", created_at: "2026-11-25 10:00:00", finished_at: null,
      excluded: [], message: null, counts: { new: 0, changed: 0, unchanged: 0, not_found: 0, published: 0, rejected: 0 },
      new: [], changed: [], unchanged: [], not_found: [], published: [], rejected: [], ...over,
    });
    const withCounts = (p: any) => ({ ...p, counts: { ...p.counts, new: p.new.length, changed: p.changed.length } });
    const EXPLAIN = "Noen av varene har vi lest fra vanlig tekst på nettsiden din, ikke fra en nettbutikk. De er merket «Sjekk prisen». Se over navn, pris og enhet før du publiserer.";

    const mixed = m.renderImportPreviewPage("a1", withCounts(preview({ new: [cand("c1", "Egg", true), cand("c2", "Honning", false)] })));
    ok(mixed.includes(EXPLAIN), "explanation shown verbatim when a row is marked");
    ok((mixed.match(/data-llm-badge="1"/g) ?? []).length === 1 && mixed.includes("<strong>Sjekk prisen</strong>"), "exactly the LLM row has the badge");
    const structured = m.renderImportPreviewPage("a1", withCounts(preview({ new: [cand("c2", "Honning", false)] })));
    ok(!structured.includes("Sjekk prisen") && !structured.includes("data-llm-explain"), "structured-only: no badge, no explanation");
    const changedLlm = m.renderImportPreviewPage("a1", withCounts(preview({ changed: [{ ...cand("c3", "Ost", true), old: { price_nok: 90, unit: "stk", price: "90 kr" } }] })));
    ok(changedLlm.includes(EXPLAIN) && changedLlm.includes("data-llm-badge"), "changed LLM row is marked too");

    const zero = (outcome: string, website: string) =>
      m.renderImportPreviewPage("a1", preview({ status: outcome === "failed" ? "failed" : "completed", outcome, website }));
    const NOPRICE = "Vi fant ingen varer med pris på gard.no. Det ser ut til at nettsiden ikke viser priser. Du kan legge inn varene selv her, eller legge prisene på nettsiden og prøve igjen.";
    const NOOPEN = "Vi fikk ikke åpnet gard.no. Sjekk at adressen under «Nettside» er riktig, og prøv igjen.";
    const NOREAD = "Vi klarte ikke å lese varene på gard.no, fordi siden lastes på en måte vi ikke kan lese ennå. Du kan legge inn varene selv her.";
    ok(zero("no_products_found", "https://gard.no/").includes(NOPRICE), "no prices text verbatim");
    ok(zero("fetch_failed:dns", "https://gard.no/").includes(NOOPEN), "fetch_failed text verbatim");
    ok(zero("fetch_failed:http_404", "https://www.gard.no/x").includes("Vi fikk ikke åpnet www.gard.no."), "fetch_failed (non-2xx) uses hostname only");
    ok(zero("js_unreadable", "https://gard.no").includes(NOREAD), "js_unreadable text verbatim");
    const unknown = zero("grounding_rejected_all", "https://gard.no/");
    ok(unknown.includes("Det vi fant, sto ikke ordrett på nettsiden, så vi tok det ikke med.") && !unknown.includes("Vi fant ingen varer med pris på"), "unknown outcome keeps today's text");
    const robots = zero("robots_blocked", "https://gard.no/");
    ok(robots.includes("robots.txt") && !robots.includes("Vi fikk ikke åpnet"), "robots_blocked keeps today's text");
    ok(m.importNothingFoundReasonHtml("ok", "https://gard.no") === null && m.importNothingFoundReasonHtml(null, "https://gard.no") === null, "ok / null → null");
    const evil = m.importNothingFoundReasonHtml("fetch_failed:dns", "<b>x&y") ?? "";
    ok(!evil.includes("<b>") && evil.includes("&lt;b&gt;") && evil.includes("&amp;y"), "unparseable site text is HTML-escaped");
    // N1: only say «nettsiden viser ikke priser» when it is true
    ok(m.importNothingFoundReasonHtml("no_products_found", "https://gard.no", { excluded: 2 }) === null, "N1: excluded>0 → null");
    for (const st of ["infra_failure", "invalid_json", "not_array", "budget_exhausted"])
      ok(m.importNothingFoundReasonHtml("no_products_found", "https://gard.no", { llmStatus: st }) === null, `N1: llm ${st} → null`);
    ok(m.importNothingFoundReasonHtml("no_products_found", "https://gard.no", { excluded: 0, llmStatus: "sentinel" }) === NOPRICE, "N1: genuine no-products keeps text");
    ok(m.importNothingFoundReasonHtml("no_products_found", "https://gard.no", { excluded: 0, llmStatus: "not_needed" }) === NOPRICE, "N1: not_needed keeps text");
    ok(m.importNothingFoundReasonHtml("fetch_failed:dns", "https://gard.no", { excluded: 3, llmStatus: "infra_failure" }) === NOOPEN, "N1: other outcomes unaffected");
    // N2: Unicode domain, still escaped
    const uni = m.importNothingFoundReasonHtml("fetch_failed:dns", "https://xn--grdsbutikk-15a.no/") ?? "";
    ok(uni.includes("gårdsbutikk.no") && !uni.includes("xn--"), "N2: punycode shown as Unicode");
    ok((require("../services/product-import/owner-import") as typeof import("../services/product-import/owner-import")).siteDomain("https://xn--gr-yia.no") === "går.no", "N2: siteDomain returns Unicode");
    // N3: no derivable domain → null
    for (const w of ["", "   ", null, undefined, "https://"])
      ok(m.importNothingFoundReasonHtml("no_products_found", w as string | null) === null && m.importNothingFoundReasonHtml("fetch_failed:dns", w as string | null) === null, `N3: empty website ${JSON.stringify(w)} → null`);
    for (const o of ["no_products_found", "fetch_failed:dns", "js_unreadable", "ok"]) {
      ok(!zero(o, "https://gard.no/").includes("uten pris"), `no «uten pris» text in zero view (${o})`);
      ok(!zero(o, "https://gard.no/").includes("Varer funnet, men"), `no unapproved «Varer funnet, men…» (${o})`);
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerProductImportMarkingTests({ log: true }).then((r) => {
    console.info(`${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
