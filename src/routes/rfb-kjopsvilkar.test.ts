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
  assertTrue(no.body.includes("varer som forringes eller raskt går ut på dato (bokstav b)") && no.body.includes("(bokstav g)"), "NO: § 22 exceptions use the statute's wording and letters b and g");
  assertTrue(no.body.includes('id="angreskjema"') && no.body.includes("Jeg/vi underretter herved om at jeg/vi ønsker å gå fra min/vår avtale"), "NO: the standard angreskjema is on the page (§ 8 h)");
  assertTrue(en.body.includes('id="cancellation-form"') && en.body.includes("I/we hereby give notice"), "EN: the standard cancellation form is on the page");
  assertTrue(no.body.includes("forbrukerkjøpsloven § 41") && no.body.includes("kan da ikke kreve betaling for varene") && en.body.includes("Consumer Purchases Act section 41"), "both: cancellation before pickup follows forbrukerkjøpsloven § 41 (compensation, not the price)");
  assertTrue(!/avgjør om en avbestilling kan godtas|decides whether a cancellation can be accepted/.test(no.body + en.body), "both: no wording that lets the producer refuse a cancellation before pickup");
  assertTrue(no.body.includes("holde tilbake betalingen") && en.body.includes("withhold payment"), "both: § 26 remedies include withholding payment");
  assertTrue(no.body.includes("med mindre du og produsenten uttrykkelig avtaler noe annet, og uten gebyr") && en.body.includes("unless you and the producer expressly agree otherwise, and without any fee"), "both: refund uses the same payment method and no fee (angrerettloven § 24)");
  assertTrue(no.body.includes("Ingen produsent betaler for plassering") && en.body.includes("No producer pays for placement"), "both: ranking parameters disclosed (angrerettloven § 9 a a)");
  assertTrue(no.body.includes("ikke innhentet en erklæring") && no.body.includes("kjøpsloven") && en.body.includes("Sale of Goods Act"), "both: trader status and its consequence disclosed (§ 9 a b and c)");
  assertTrue(no.body.includes("Produsentens navn står i bestillingen") && en.body.includes("The producer's name is shown in your order"), "both: the order is only promised to show the producer's name (OrderSummary carries no contact details)");
  assertTrue(no.body.includes("bestillinger du har bedt assistenten sende") && en.body.includes("orders you have asked the assistant to send"), "both: AI-assistant clause limited to orders the buyer asked for");
  assertTrue(/14 dagers angrerett/.test(no.body) && /14-day right of cancellation/.test(en.body), "both: 14-day right of cancellation");
  assertTrue(/to måneder/.test(no.body) && /two months/.test(en.body), "both: two-month complaint rule (forbrukerkjøpsloven § 27)");
  assertTrue(no.body.includes("Forbrukerrådet") && no.body.includes("Forbrukerklageutvalget"), "NO: dispute bodies named (Forbrukerrådet, Forbrukerklageutvalget)");
  assertTrue(!/\bODR\b|ec\.europa\.eu\/consumers\/odr/.test(no.body + en.body), "both: no reference to the closed EU ODR platform");

  for (const [lang, body] of [["NO", no.body], ["EN", en.body]] as const) {
    assertTrue(body.includes(COMPANY_INFO.legalName) && body.includes(COMPANY_INFO.orgNrDisplay), `${lang}: operator legal name + org.nr. from company-info.ts`);
    assertTrue(!new RegExp(`${COMPANY_INFO.orgNrDisplay}\\s*MVA`).test(body), `${lang}: no «MVA» after the org.nr. (company not VAT-registered)`);
    assertTrue(body.includes("kontakt@rettfrabonden.com"), `${lang}: site contact e-mail present`);
  }
  assertTrue(no.body.includes('href="/personvern"') && no.body.includes('href="/kontakt"'), "NO: links /personvern and /kontakt");
  assertTrue(en.body.includes('href="/en/personvern"') && en.body.includes('href="/en/kontakt"'), "EN: links /en/personvern and /en/kontakt");
  assertTrue(no.body.includes("Sist oppdatert: 10. oktober 2026") && en.body.includes("Last updated: 10 October 2026"), "both: last-updated date");
  assertTrue(/rel="canonical" href="[^"]*\/kjopsvilkar"/.test(no.body) && !/rel="canonical" href="[^"]*\/en\/kjopsvilkar"/.test(no.body), "NO: canonical points at /kjopsvilkar");
  assertTrue(/rel="canonical" href="[^"]*\/en\/kjopsvilkar"/.test(en.body), "EN: canonical points at /en/kjopsvilkar");
  assertTrue(no.body.includes(`drives av ${COMPANY_INFO.legalName}`) && en.body.includes(`is run by ${COMPANY_INFO.legalName}`), "both: operator sentence reads «drives av / is run by <legal name>» (no leftover «Operatør:» prefix)");

  // ── 3. Truth pins against the code ──────────────────────────────────────
  const cartSvc = read("services/cart-service.ts");
  assertTrue(/'pending', 'pickup'/.test(cartSvc), "truth: submitCart() creates pickup orders only (fulfilment 'pickup')");
  assertTrue(no.body.includes("Vi tilbyr ikke levering") && en.body.includes("We do not offer delivery"), "truth: page says pickup only, no delivery");

  const cartRoutes = read("routes/marketplace-cart.ts");
  const cartRouterPaths = (cartRoutes.match(/cartRouter\.(get|post|put|patch|delete)\("([^"]+)"/g) || []).join("\n");
  assertTrue(cartRouterPaths.length > 0 && !/cancel/i.test(cartRouterPaths), "truth: no buyer-side cancel endpoint on cartRouter");
  assertTrue(no.body.includes("kontakter du produsenten direkte") && en.body.includes("contact the producer directly"), "truth: page sends cancellation to the producer");

  const readers = walkTs(SRC).filter((f) => !f.endsWith("rfb-kjopsvilkar.ts") && /PAYMENTS_ENABLED/.test(fs.readFileSync(f, "utf8")));
  assertTrue(readers.length === 0,
    `truth: no payment through the platform yet (nothing reads PAYMENTS_ENABLED). If this fails, prepayment code has landed: check whether PAYMENTS_ENABLED is on in prod; once it is, update §4 «Betaling» (and the «når forhåndsbetaling er tilgjengelig» qualifiers) in rfb-kjopsvilkar.ts, then this pin. Readers: ${readers.map((f) => path.relative(SRC, f)).join(", ")}`);
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
