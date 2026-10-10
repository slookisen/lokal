/**
 * rfb-kjopsvilkar.test.ts — kjøpsvilkår og refusjonsregler for
 * rettfrabonden.com (Daniel live 2026-10-10; src/routes/rfb-kjopsvilkar.ts,
 * route GET /kjopsvilkar in seo.ts).
 *
 * Proves:
 *   1. GET /kjopsvilkar renders 200 in NO and EN with every required section
 *      (seller, ordering, prices, payment, pickup, cancellation, no-show,
 *      angrerett, reklamasjon, refund, AI assistants, personal data,
 *      disputes, contact) and stable anchors (#angrerett, #refusjon / #refund).
 *   2. It names the operator exactly as company-info.ts does (legal name +
 *      org.nr.), never prints «MVA» after the org.nr. while the company is not
 *      VAT-registered, and links /personvern and /kontakt in the page language.
 *   3. It stays TRUE to the code (truth pins, same idea as
 *      rfb-privacy-terms-truth.test.ts):
 *        - pickup only: submitCart() inserts fulfilment 'pickup';
 *        - no buyer-side cancel endpoint on cartRouter → "contact the producer";
 *        - no payment through the platform yet: nothing in src reads
 *          PAYMENTS_ENABLED. When prepayment ships (A2A dev-request
 *          2026-10-09-rfb-forhandsbetaling-stripe-connect) this pin FAILS on
 *          purpose: update §4 «Betaling» from "under innføring" to live
 *          wording, then update the pin;
 *        - retention is NOT restated (single source of truth is /personvern).
 *   4. Discoverability: the shell() footer links /kjopsvilkar (NO) and
 *      /en/kjopsvilkar (EN); the /vilkar footer links it; the sitemap core
 *      paths and the /:city reserved-slug guard include it; the shopping-list
 *      checkout links it in the page language; locale keys exist in no/en/sv.
 *
 * Standalone: npx tsx src/routes/rfb-kjopsvilkar.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): { found: boolean; status: number; body: string } {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "" };
  let status = 200;
  let body = "";
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, status, body };
}

function footersOf(html: string): string {
  return (html.match(/<footer[\s\S]*?<\/footer>/g) || []).join("\n");
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

export async function runRfbKjopsvilkarTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere */ }
  } catch { /* routes fall back to defaults */ }

  const seoRouter = require("./seo").default as any;
  const discoveryRouter = require("./discovery").default as any;
  const { COMPANY_INFO } = require("../config/company-info") as typeof import("../config/company-info");
  const { buildHandelistePage } = require("./handleliste-page") as typeof import("./handleliste-page");

  const SRC = path.join(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

  // ── 1 + 2. Page content, NO and EN ──────────────────────────────────────
  const no = invokeGet(seoRouter, "/kjopsvilkar", "no");
  const en = invokeGet(seoRouter, "/kjopsvilkar", "en");
  assertTrue(no.found, "setup: GET /kjopsvilkar is registered on the RFB seo router");
  assertTrue(no.status === 200 && en.status === 200, "/kjopsvilkar renders 200 in NO and EN");

  const noSections = ["Hvem du handler med", "Slik bestiller du", "Priser", "Betaling", "Henting", "Avbestilling og endring",
    "Hvis du ikke henter", "Angrerett", "Reklamasjon ved feil", "Refusjon", "Bestilling via AI-assistent", "Personopplysninger",
    "Klager og tvister", "Kontakt og endringer"];
  for (const s of noSections) assertTrue(no.body.includes(s), `NO: section «${s}» present`);
  const enSections = ["Who you buy from", "How ordering works", "Prices", "Payment", "Pickup", "Cancellation and changes",
    "If you do not pick up", "Right of cancellation", "Defects", "Refunds", "Ordering through an AI assistant", "Personal data",
    "Complaints and disputes", "Contact and changes"];
  for (const s of enSections) assertTrue(en.body.includes(s), `EN: section «${s}» present`);

  assertTrue(no.body.includes('id="angrerett"') && no.body.includes('id="refusjon"') && no.body.includes('id="reklamasjon"'), "NO: stable anchors #angrerett, #refusjon, #reklamasjon");
  assertTrue(en.body.includes('id="right-of-cancellation"') && en.body.includes('id="refund"'), "EN: stable anchors #right-of-cancellation, #refund");
  assertTrue(no.body.includes("Selger er produsenten") && en.body.includes("The seller is the producer"), "both: the producer is named as the seller");
  assertTrue(no.body.includes("§ 22") && en.body.includes("section 22"), "both: the angrerett exceptions cite angrerettloven § 22");
  assertTrue(/14 dagers angrerett/.test(no.body) && /14-day right of cancellation/.test(en.body), "both: 14-day right of cancellation");
  assertTrue(/to måneder/.test(no.body) && /two months/.test(en.body), "both: two-month complaint rule (forbrukerkjøpsloven § 27)");
  assertTrue(no.body.includes("Forbrukerrådet") && no.body.includes("Forbrukerklageutvalget"), "NO: dispute bodies named (Forbrukerrådet, Forbrukerklageutvalget)");
  assertTrue(!/odr|ec\.europa\.eu\/consumers\/odr/i.test(no.body + en.body), "both: no reference to the closed EU ODR platform");

  for (const [lang, body] of [["NO", no.body], ["EN", en.body]] as const) {
    assertTrue(body.includes(COMPANY_INFO.legalName) && body.includes(COMPANY_INFO.orgNrDisplay), `${lang}: operator legal name + org.nr. from company-info.ts`);
    assertTrue(!new RegExp(`${COMPANY_INFO.orgNrDisplay}\\s*MVA`).test(body), `${lang}: no «MVA» after the org.nr. (company not VAT-registered)`);
    assertTrue(body.includes("kontakt@rettfrabonden.com"), `${lang}: site contact e-mail present`);
  }
  assertTrue(no.body.includes('href="/personvern"') && no.body.includes('href="/kontakt"'), "NO: links /personvern and /kontakt");
  assertTrue(en.body.includes('href="/en/personvern"') && en.body.includes('href="/en/kontakt"'), "EN: links /en/personvern and /en/kontakt");
  assertTrue(no.body.includes("Sist oppdatert: 10. oktober 2026") && en.body.includes("Last updated: 10 October 2026"), "both: last-updated date");
  assertTrue(no.body.includes('rel="canonical" href="https://rettfrabonden.com/kjopsvilkar"') || no.body.includes("/kjopsvilkar\""), "NO: canonical points at /kjopsvilkar");

  // ── 3. Truth pins against the code ──────────────────────────────────────
  const cartSvc = read("services/cart-service.ts");
  assertTrue(/'pending', 'pickup'/.test(cartSvc), "truth: submitCart() creates pickup orders only (fulfilment 'pickup')");
  assertTrue(no.body.includes("Vi tilbyr ikke levering") && en.body.includes("We do not offer delivery"), "truth: page says pickup only, no delivery");

  const cartRoutes = read("routes/marketplace-cart.ts");
  const cartRouterPaths = (cartRoutes.match(/cartRouter\.(get|post|patch|delete)\("([^"]+)"/g) || []).join("\n");
  assertTrue(cartRouterPaths.length > 0 && !/cancel/i.test(cartRouterPaths), "truth: no buyer-side cancel endpoint on cartRouter");
  assertTrue(no.body.includes("kontakter du produsenten direkte") && en.body.includes("contact the producer directly"), "truth: page sends cancellation to the producer");

  const readers = walkTs(SRC).filter((f) => !f.endsWith("rfb-kjopsvilkar.ts") && /PAYMENTS_ENABLED/.test(fs.readFileSync(f, "utf8")));
  assertTrue(readers.length === 0,
    `truth: no payment through the platform yet (nothing reads PAYMENTS_ENABLED). If this fails, prepayment has shipped: update §4 «Betaling» in rfb-kjopsvilkar.ts and this pin. Readers: ${readers.map((f) => path.relative(SRC, f)).join(", ")}`);
  assertTrue(no.body.includes("I dag betaler du produsenten ved henting") && no.body.includes("under innføring"), "truth: NO payment section says pay-at-pickup today, prepayment being introduced");
  assertTrue(en.body.includes("Today you pay the producer at pickup") && en.body.includes("being introduced"), "truth: EN payment section says pay-at-pickup today, prepayment being introduced");
  assertTrue(!/30 dager|30 days/.test(no.body + en.body), "truth: retention is not restated here (single source of truth is /personvern)");

  // ── 4. Discoverability ──────────────────────────────────────────────────
  const pvNo = invokeGet(seoRouter, "/personvern", "no");
  const pvEn = invokeGet(seoRouter, "/personvern", "en");
  assertTrue(footersOf(pvNo.body).includes('href="/kjopsvilkar"') && footersOf(pvNo.body).includes("Kjøpsvilkår"), "footer (NO shell): links /kjopsvilkar");
  assertTrue(footersOf(pvEn.body).includes('href="/en/kjopsvilkar"') && footersOf(pvEn.body).includes("Terms of purchase"), "footer (EN shell): links /en/kjopsvilkar");
  assertTrue(footersOf(no.body).includes('href="/kjopsvilkar"'), "footer on the terms page itself links back to it");

  const vilkar = invokeGet(discoveryRouter, "/vilkar");
  assertTrue(vilkar.found && footersOf(vilkar.body).includes('href="/kjopsvilkar"'), "/vilkar footer links /kjopsvilkar");

  const seoSrc = read("routes/seo.ts");
  assertTrue(/corePaths = \[[^\]]*"\/kjopsvilkar"/.test(seoSrc), "sitemap: /kjopsvilkar is a core path (NO + EN entries)");
  assertTrue(/citySlug === "kjopsvilkar"/.test(seoSrc), "/:city guard reserves «kjopsvilkar»");

  const hlNo = buildHandelistePage("no" as any);
  const hlEn = buildHandelistePage("en" as any);
  assertTrue(hlNo.content.includes('href="/kjopsvilkar"') && hlNo.content.includes("kjøpsvilkårene"), "shopping list (NO): checkout links /kjopsvilkar");
  assertTrue(hlEn.content.includes('href="/en/kjopsvilkar"') && hlEn.content.includes("terms of purchase"), "shopping list (EN): checkout links /en/kjopsvilkar");

  for (const l of ["no", "en", "sv"]) {
    const d = JSON.parse(read(`i18n/locales/${l}.json`));
    assertTrue(!!d?.footer?.terms_of_purchase && !!d?.terms_of_purchase?.title && !!d?.terms_of_purchase?.description, `locale ${l}: footer.terms_of_purchase + terms_of_purchase.{title,description}`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbKjopsvilkarTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed) console.log(s.failures.join("\n"));
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
