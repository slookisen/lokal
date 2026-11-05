/**
 * rfb-for-produsenter.test.ts — «Slik fungerer Rett fra Bonden for
 * produsenter» (A2A dev-request 2026-10-22-rfb-for-produsenter-faq-side, F1;
 * src/routes/rfb-for-produsenter.ts, route GET /for-produsenter in seo.ts).
 *
 * Proves:
 *   1. Flag off (FOR_PRODUSENTER_PAGE_ENABLED unset): the route falls through
 *      (next() → the normal 404), the header «For produsenter» still points
 *      at /selger, the footer is unchanged and the sitemap helper is empty.
 *   2. Flag on: 200 in NO and EN with canonical + hreflang, the header points
 *      at the localized /for-produsenter, the sitemap lists it, the /:city
 *      catch-all reserves the slug.
 *   3. The section menu has exactly the 11 anchors in order, each with a
 *      section; the menu scrolls horizontally inside itself (overflow-x:auto).
 *   4. AC4: the FAQPage JSON-LD equals the visible Q/A (same order, same text).
 *   5. Truth pins: price/fee wording matches /produsentvilkar §6, prepayment
 *      is «planlagt» while KJOPSVILKAR_PREPAYMENT_LIVE is false, registry
 *      statuses of what the page calls «planlagt» or available, two levels,
 *      order timings from the code.
 *
 * Standalone: npx tsx src/routes/rfb-for-produsenter.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): { found: boolean; status: number; body: string; nextCalled: boolean } {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "", nextCalled: false };
  let status = 200;
  let body = "";
  let nextCalled = false;
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang, path: routePath, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { nextCalled = true; });
  return { found: true, status, body, nextCalled };
}

function navOf(html: string): string {
  return (html.match(/<nav class="nav">[\s\S]*?<\/nav>/) || [""])[0];
}
function footerOf(html: string): string {
  return (html.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
}
function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function runRfbForProdusenterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const mod = require("./rfb-for-produsenter") as typeof import("./rfb-for-produsenter");
  const { FOR_PRODUSENTER_ANCHORS, FOR_PRODUSENTER_PATH, FOR_PRODUSENTER_CSS } = mod;
  const SRC = path.join(__dirname, "..");
  const seoSrc = fs.readFileSync(path.join(SRC, "routes/seo.ts"), "utf8");

  const FLAG = "FOR_PRODUSENTER_PAGE_ENABLED";
  const prevFlag = process.env[FLAG];
  try {
    // ── 1. Flag off ───────────────────────────────────────────────────────
    delete process.env[FLAG];
    const offNo = invokeGet(seoRouter, FOR_PRODUSENTER_PATH, "no");
    const offEn = invokeGet(seoRouter, FOR_PRODUSENTER_PATH, "en");
    assertTrue(offNo.found, "setup: GET /for-produsenter is registered on the RFB seo router");
    assertTrue(offNo.nextCalled && offNo.body === "" && offEn.nextCalled && offEn.body === "", "flag off: NO and EN fall through to next() (the normal 404), nothing sent");
    const pvOff = invokeGet(seoRouter, "/personvern", "no");
    const pvOffEn = invokeGet(seoRouter, "/personvern", "en");
    assertTrue(navOf(pvOff.body).includes('<a href="/selger" class="nav-cta">') && !pvOff.body.includes("/for-produsenter"), "flag off: header «For produsenter» still /selger, no /for-produsenter anywhere (NO)");
    assertTrue(navOf(pvOffEn.body).includes('<a href="/selger" class="nav-cta">') && !pvOffEn.body.includes("/for-produsenter"), "flag off: header «For produsenter» still /selger (EN)");
    assertTrue(footerOf(pvOff.body).includes('<h4>For produsenter</h4>\n        <a href="/selger">'), "flag off: footer «For produsenter» column unchanged");
    assertTrue(mod.forProdusenterSitemapPaths().length === 0, "flag off: no sitemap entry");
    for (const v of ["", "0", "false", "yes", "on"]) {
      assertTrue(!mod.isForProdusenterPageEnabled({ [FLAG]: v } as any), `flag value «${v}» = off`);
    }
    for (const v of ["1", "true", "TRUE", " true "]) {
      assertTrue(mod.isForProdusenterPageEnabled({ [FLAG]: v } as any), `flag value «${v}» = on`);
    }

    // ── 2. Flag on ────────────────────────────────────────────────────────
    process.env[FLAG] = "1";
    const no = invokeGet(seoRouter, FOR_PRODUSENTER_PATH, "no");
    const en = invokeGet(seoRouter, FOR_PRODUSENTER_PATH, "en");
    assertTrue(!no.nextCalled && no.status === 200 && no.body.length > 0, "flag on: NO renders 200");
    assertTrue(!en.nextCalled && en.status === 200 && en.body.length > 0, "flag on: EN renders 200");
    assertTrue(no.body.includes("<h1>Slik fungerer Rett fra Bonden for produsenter</h1>"), "NO: heading");
    assertTrue(en.body.includes("<h1>How Rett fra Bonden works for producers</h1>"), "EN: heading");
    assertTrue(/<link rel="canonical" href="[^"]*\/for-produsenter">/.test(no.body) && !/rel="canonical" href="[^"]*\/en\/for-produsenter"/.test(no.body), "NO: canonical /for-produsenter");
    assertTrue(/<link rel="canonical" href="[^"]*\/en\/for-produsenter">/.test(en.body), "EN: canonical /en/for-produsenter");
    for (const [l, b] of [["NO", no.body], ["EN", en.body]] as const) {
      assertTrue(/hreflang="nb" href="[^"]*\/for-produsenter"/.test(b) && /hreflang="en" href="[^"]*\/en\/for-produsenter"/.test(b) && /hreflang="x-default" href="[^"]*\/for-produsenter"/.test(b), `${l}: hreflang nb/en/x-default`);
    }
    assertTrue(navOf(no.body).includes('<a href="/for-produsenter" class="nav-cta">'), "flag on: header «For produsenter» → /for-produsenter (NO)");
    assertTrue(navOf(en.body).includes('<a href="/en/for-produsenter" class="nav-cta">'), "flag on: header «For produsenter» → /en/for-produsenter (EN)");
    const pvOn = invokeGet(seoRouter, "/personvern", "no");
    assertTrue(navOf(pvOn.body).includes('<a href="/for-produsenter" class="nav-cta">'), "flag on: header on other RFB pages → /for-produsenter");
    assertTrue(footerOf(pvOn.body).includes('href="/for-produsenter"'), "flag on: footer links the page");
    assertTrue(JSON.stringify(mod.forProdusenterSitemapPaths()) === JSON.stringify(["/for-produsenter"]), "flag on: sitemap helper returns /for-produsenter");
    assertTrue(/for \(const p of forProdusenterSitemapPaths\(\)\) addEntry\(p,/.test(seoSrc), "sitemap: seo.ts adds the helper's paths with addEntry (NO + EN entries)");
    assertTrue(/citySlug === "for-produsenter"/.test(seoSrc), "/:city guard reserves «for-produsenter»");
    // /selger reachable from the page's buttons (AC2)
    for (const [l, b, labels] of [["NO", no.body, ["Finn profilen din og ta den over", "Logg inn", "Registrer deg"]], ["EN", en.body, ["Find your profile and take it over", "Log in", "Sign up"]]] as const) {
      for (const label of labels) {
        assertTrue(new RegExp(`<a class="fp-btn[^"]*" href="/selger[^"]*">${label}</a>`).test(b), `${l}: button «${label}» → /selger`);
      }
    }
    assertTrue(no.body.includes('href="/teknologi"') && en.body.includes('href="/en/teknologi"'), "#synlighet links /teknologi in the page language");
    assertTrue(no.body.includes('href="/personvern"') && en.body.includes('href="/en/personvern"'), "#personvern links /personvern in the page language");
    assertTrue(no.body.includes('href="/kontakt"') && en.body.includes('href="/en/kontakt"'), "#kontakt links /kontakt in the page language");

    // ── 3. Menu and anchors ───────────────────────────────────────────────
    const expected = ["oversikt", "synlighet", "eierskap", "mine-valg", "bestillinger", "betaling", "oppdatering", "statistikk", "personvern", "pris", "kontakt"];
    assertTrue(JSON.stringify([...FOR_PRODUSENTER_ANCHORS]) === JSON.stringify(expected), "anchors: exactly the 11 spec anchors in order");
    for (const [l, b] of [["NO", no.body], ["EN", en.body]] as const) {
      const menu = (b.match(/<nav class="fp-menu"[\s\S]*?<\/nav>/) || [""])[0];
      const menuIds = [...menu.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1]);
      assertTrue(JSON.stringify(menuIds) === JSON.stringify(expected), `${l}: menu has one link per section, in order`);
      const sectionIds = [...b.matchAll(/<section class="fp-sec" id="([^"]+)"/g)].map((m) => m[1]);
      assertTrue(JSON.stringify(sectionIds) === JSON.stringify(expected), `${l}: sections carry the anchors in order`);
    }
    assertTrue(/\.fp-menu \{[^}]*position: sticky/.test(FOR_PRODUSENTER_CSS), "menu CSS: sticky");
    assertTrue(/\.fp-menu ul \{[^}]*overflow-x: auto/.test(FOR_PRODUSENTER_CSS), "menu CSS: overflow-x:auto (scrolls inside the menu, not the page)");
    assertTrue(!/(?:^|[^-])width:\s*\d{3,}px/.test(FOR_PRODUSENTER_CSS), "CSS: no fixed pixel widths ≥100px (no horizontal page scroll at 375px)");
    assertTrue(/IntersectionObserver/.test(no.body) && /aria-current/.test(no.body), "menu marks the current section (IntersectionObserver, aria-current)");

    // ── 4. AC4: FAQPage JSON-LD == visible Q/A ────────────────────────────
    for (const [l, b] of [["NO", no.body], ["EN", en.body]] as const) {
      const ldBlocks = [...b.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
      const faq = ldBlocks.filter((x) => x && x["@type"] === "FAQPage");
      assertTrue(faq.length === 1, `${l}: exactly one FAQPage JSON-LD`);
      const ldPairs = (faq[0]?.mainEntity || []).map((e: any) => ({ q: e.name, a: e.acceptedAnswer.text }));
      const visible = [...b.matchAll(/<details class="fp-qa"><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)]
        .map((m) => ({ q: decode(m[1]), a: decode(m[2]) }));
      assertTrue(ldPairs.length >= 30 && JSON.stringify(ldPairs) === JSON.stringify(visible), `${l}: FAQPage JSON-LD equals the visible Q/A (${ldPairs.length} pairs)`);
    }

    // ── 5. Truth pins ─────────────────────────────────────────────────────
    const text = no.body + en.body;
    // Price / fee: the same promise as /produsentvilkar §6.
    const pvSrc = fs.readFileSync(path.join(SRC, "routes/rfb-produsentvilkar.ts"), "utf8");
    assertTrue(pvSrc.includes("tar i dag ingen avgift for bestillinger") && pvSrc.includes("varsler vi deg minst 30 dager før, og den gjelder bare hvis du godtar den"), "truth: /produsentvilkar still says no fee today + 30 days' notice + only if accepted");
    assertTrue(no.body.includes("Det koster ingenting i dag.") && no.body.includes("varsler vi deg minst 30 dager før, og den gjelder bare hvis du godtar den"), "NO #pris: same wording as the producer terms");
    assertTrue(en.body.includes("It costs nothing today.") && en.body.includes("at least 30 days in advance, and it only applies if you accept it"), "EN #pris mirrors it");
    assertTrue(!/provisjon|commission/i.test(text), "no «provisjon»/«commission» claim on the page");
    assertTrue(!/\bgratis for alltid\b|free forever|alltid gratis|always free/i.test(text), "no «free forever» promise (contradicts the 30-day notice term)");
    const { isPlatformFeeConfigured } = require("../services/payment-service") as typeof import("../services/payment-service");
    assertTrue(!isPlatformFeeConfigured(), "truth: no platform fee configured in this environment (the page says none today)");
    // Prepayment
    const { KJOPSVILKAR_PREPAYMENT_LIVE } = require("../config/payments-terms") as typeof import("../config/payments-terms");
    assertTrue(KJOPSVILKAR_PREPAYMENT_LIVE === false, "truth: prepayment not live — update #betaling to the live wording when this flips");
    assertTrue(no.body.includes("Forhåndsbetaling med kort via Stripe er planlagt") && en.body.includes("Prepayment by card through Stripe is planned"), "#betaling: prepayment described as planned");
    // Registry: what the page calls planned is coming_soon; what it calls available is live.
    const { OWNER_FEATURE_REGISTRY } = require("../owner-features/registry") as typeof import("../owner-features/registry");
    // Run-time status (ownerFeatureStatus): auto.updates is live only with OWNER_AUTO_UPDATES_ENABLED,
    // and the page's «planlagt» sentences about it are left out only then.
    const { ownerFeatureStatus } = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const status = (k: string) => {
      const e = OWNER_FEATURE_REGISTRY.find((x) => x.key === k && x.verticals.includes("rfb"));
      return e ? ownerFeatureStatus(e) : undefined;
    };
    for (const k of ["products.import", "orders.pause", "orders.pickup_times", "notify.report", "stats.public_counts", "contact.phone", "contact.email_mode", "contact.address", "auto.updates", "payments.prepay", "orders.auto_confirm"]) {
      assertTrue(status(k) === "coming_soon", `truth: ${k} is coming_soon (page says «planlagt» / does not offer it) — rewrite the text when it goes live`);
    }
    for (const k of ["orders.enabled", "visibility.profile", "products.stock_check", "orders.reminder", "notify.order_email", "auto.guarantee", "comms.unsubscribe"]) {
      assertTrue(status(k) === "live", `truth: ${k} is live (page describes it as available)`);
    }
    const factsNow = mod.currentForProdusenterFacts();
    for (const e of mod.liveRfbOwnerChoices(factsNow)) {
      assertTrue(no.body.includes(`<strong>${e.label.no}</strong>`), `#mine-valg lists live choice «${e.label.no}»`);
    }
    // No coming_soon label in the «Dette kan du velge i dag» list.
    const todayList = (no.body.match(/Dette kan du velge i dag:<\/p>\s*<ul class="fp-list">([\s\S]*?)<\/ul>/) || ["", ""])[1];
    const todayLabels = [...todayList.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) => decode(m[1]));
    assertTrue(todayLabels.length > 0, "#mine-valg: the «i dag» list is present");
    for (const e of OWNER_FEATURE_REGISTRY.filter((x) => x.verticals.includes("rfb") && ownerFeatureStatus(x) === "coming_soon")) {
      assertTrue(!todayLabels.includes(e.label.no), `#mine-valg «i dag» list does not contain coming_soon «${e.label.no}»`);
    }
    const { OWNER_LEVELS } = require("../owner-features/changes") as typeof import("../owner-features/changes");
    assertTrue(OWNER_LEVELS.length === 2 && OWNER_LEVELS.every((l) => no.body.includes(`«${l.label.no}»`)), "#mine-valg: exactly the two levels from OWNER_LEVELS");
    assertTrue(!/Full fart|«Aktiv»/.test(no.body), "#mine-valg: no «Aktiv»/«Full fart» level");
    // Orders: timings and cap from the code; pickup only; e-mail subject.
    const facts = mod.currentForProdusenterFacts();
    assertTrue(no.body.includes(`påminnelse etter ${facts.reminderHours} timer`) && no.body.includes(`ubesvart etter ${facts.autocancelHours} timer`), "#bestillinger: reminder/cancel hours from order-followups.ts");
    assertTrue(no.body.includes(`inntil ${facts.dailyCap} bestillinger per døgn`), "#bestillinger: daily cap from orderCapNewPerDay()");
    assertTrue(no.body.includes(`gjelder i ${facts.stockValidDays} dager`), "#bestillinger: stock validity from getSupplyGraphStaleDays()");
    const notifySrc = fs.readFileSync(path.join(SRC, "services/order-notify-service.ts"), "utf8");
    assertTrue(notifySrc.includes("subject: `Ny henteordre") && no.body.includes("«Ny henteordre»"), "truth: the order e-mail subject is «Ny henteordre»");
    const cartSvc = fs.readFileSync(path.join(SRC, "services/cart-service.ts"), "utf8");
    assertTrue(/'pending', 'pickup'/.test(cartSvc) && /AND a\.is_verified = 1\s+AND a\.order_notifications_opt_in = 1/.test(cartSvc), "truth: pickup orders only, and only to owner-claimed producers with orders on");
    const autoOff = mod.renderForProdusenterPage("no", "https://x/for-produsenter", { ...facts, autocompleteOn: false }).content;
    const autoOn = mod.renderForProdusenterPage("no", "https://x/for-produsenter", { ...facts, autocompleteOn: true }).content;
    assertTrue(!autoOff.includes("avsluttes av seg selv") && autoOn.includes("avsluttes av seg selv"), "#bestillinger: automatic close only mentioned while ORDER_AUTOCOMPLETE_ENABLED");
    // Statistics
    assertTrue(no.body.includes("«Med i AI-søk»") && !no.body.includes("Med i AI-svar"), "#statistikk: «Med i AI-søk», not «Med i AI-svar»");
    assertTrue(no.body.includes(`minst ${facts.publicStatsMinViews} sidevisninger fra mennesker de siste 12 månedene`) && no.body.includes("Du ser alltid dine egne tall"), "#statistikk: public threshold from publicStatsMinViews(); owner always sees own numbers");
    assertTrue(no.body.includes("En rapport på e-post er planlagt") && !/månedsrapport/i.test(no.body), "#statistikk: no monthly report promised");
    // ── 6. Flag-dependent promises: both states ───────────────────────────
    const base = { ...facts, autocompleteOn: false, buyerReceiptsOn: false, orderabilityPortalOn: false, stockCheckEmailOn: false };
    const offAll = mod.renderForProdusenterPage("no", "https://x/for-produsenter", base).content;
    const onAll = mod.renderForProdusenterPage("no", "https://x/for-produsenter", { ...base, buyerReceiptsOn: true, orderabilityPortalOn: true, stockCheckEmailOn: true }).content;
    const offAllEn = mod.renderForProdusenterPage("en", "https://x/en/for-produsenter", base).content;
    const onAllEn = mod.renderForProdusenterPage("en", "https://x/en/for-produsenter", { ...base, buyerReceiptsOn: true, orderabilityPortalOn: true, stockCheckEmailOn: true }).content;
    // a. buyer told on cancellation only with ORDER_BUYER_RECEIPTS_ENABLED
    assertTrue(!offAll.includes("kunden får beskjed") && onAll.includes("blir den kansellert, og kunden får beskjed"), "receipts flag: NO promises the buyer notice only when on");
    assertTrue(!offAllEn.includes("customer is told") && onAllEn.includes("and the customer is told"), "receipts flag: EN mirrors it");
    const { isBuyerReceiptsEnabled } = require("../services/order-receipt-service") as typeof import("../services/order-receipt-service");
    assertTrue(facts.buyerReceiptsOn === isBuyerReceiptsEnabled(), "facts.buyerReceiptsOn reads isBuyerReceiptsEnabled()");
    // b. «eierportalen» for stock/products only with OWNER_ORDERABILITY_PORTAL_ENABLED
    assertTrue(!offAll.includes("på lager i eierportalen") && !offAll.includes("legg inn varene i eierportalen") && offAll.includes("under «Tilgjengelighet» i fanen «Produkter»"), "portal flag off: stock/products not claimed for the owner portal (NO)");
    assertTrue(onAll.includes("Merk varene som på lager i eierportalen") && onAll.includes("legg inn varene i eierportalen"), "portal flag on: owner-portal wording (NO)");
    assertTrue(!offAllEn.includes("in the owner portal. The stock") && !offAllEn.includes("add your goods in the owner portal") && onAllEn.includes("add your goods in the owner portal"), "portal flag: EN mirrors it");
    const { ownerOrderabilityPortalEnabled } = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
    assertTrue(facts.orderabilityPortalOn === ownerOrderabilityPortalEnabled(), "facts.orderabilityPortalOn reads ownerOrderabilityPortalEnabled()");
    // c. stock-check reminder listed «i dag» only with STOCK_CHECK_EMAIL_ENABLED
    const stockLabel = OWNER_FEATURE_REGISTRY.find((e) => e.key === "products.stock_check")!.label.no;
    assertTrue(!offAll.includes(`<strong>${stockLabel}</strong>`) && offAll.includes("Påminnelse på e-post om å bekrefte lagerstatus er også planlagt"), "stock-check flag off: not in the «i dag» list, called planned");
    assertTrue(onAll.includes(`<strong>${stockLabel}</strong>`) && !onAll.includes("lagerstatus er også planlagt"), "stock-check flag on: listed as available");
    assertTrue(!mod.liveRfbOwnerChoices(base).some((e) => e.key === "products.stock_check") && mod.liveRfbOwnerChoices({ ...base, stockCheckEmailOn: true }).some((e) => e.key === "products.stock_check"), "liveRfbOwnerChoices honours the stock-check flag");
    const { isStockCheckEmailEnabled } = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
    assertTrue(facts.stockCheckEmailOn === isStockCheckEmailEnabled(), "facts.stockCheckEmailOn reads isStockCheckEmailEnabled()");
    // Consent + contact is required for every real order (cart-service F2).
    assertTrue(/CONTACT_REQUIRED_ERROR/.test(cartSvc) && no.body.includes("Kunden må oppgi e-post eller telefon og godta at du får den"), "#bestillinger: buyer contact + consent is always required (CONTACT_REQUIRED_ERROR)");
    // Badge claim
    assertTrue(!/eneste merket vi viser|only badge we show/.test(text) && no.body.includes("eneste merket som viser at eieren selv har bekreftet profilen"), "#eierskap: no «only badge» claim (profiles also show Brreg/Debio badges)");

    // ── 7. Structure pins: questions per section (dropping a pair fails) ──
    const expectedCounts: Record<string, number> = { oversikt: 3, synlighet: 3, eierskap: 5, "mine-valg": 4, bestillinger: 6, betaling: 3, oppdatering: 3, statistikk: 4, personvern: 5, pris: 2, kontakt: 0 };
    const firstQ: Record<string, string> = { oversikt: "Har jeg allerede en profil?", bestillinger: "Hva skjer hvis jeg ikke svarer?", pris: "Hva koster det?", statistikk: "Hvilke tall ser jeg?" };
    for (const [l, b] of [["NO", no.body], ["EN", en.body]] as const) {
      for (const id of expected) {
        const sec = (b.match(new RegExp(`<section class="fp-sec" id="${id}"[\\s\\S]*?</section>`)) || [""])[0];
        const qs = [...sec.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => decode(m[1]));
        assertTrue(qs.length === expectedCounts[id], `${l} #${id}: ${expectedCounts[id]} questions (got ${qs.length})`);
        if (l === "NO" && firstQ[id]) assertTrue(qs[0] === firstQ[id], `NO #${id}: first question «${firstQ[id]}»`);
      }
      // menu links are real, focusable links
      const menu = (b.match(/<nav class="fp-menu"[\s\S]*?<\/nav>/) || [""])[0];
      assertTrue(!/tabindex/.test(menu) && (menu.match(/<a href="#/g) || []).length === 11, `${l}: menu links are plain focusable links (no tabindex)`);
    }

    // ── 8. Escaping ───────────────────────────────────────────────────────
    const hostile = mod.renderForProdusenterQa([{ q: `<script>alert(1)</script> "q" & 'x'`, a: `<img src=x onerror=alert(1)> «a»` }]);
    assertTrue(!hostile.includes("<script>") && !hostile.includes("<img") && hostile.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &amp; &#39;x&#39;") && hostile.includes("&lt;img src=x onerror=alert(1)&gt; «a»"), "escaping: questions and answers are HTML-escaped");

    // Not in F1
    assertTrue(!/sellerFaq|faqAnchor/.test(fs.readFileSync(path.join(SRC, "owner-features/registry.ts"), "utf8")), "scope: registry has no sellerFaq/faqAnchor fields yet (later slice)");
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbForProdusenterTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed) console.log(s.failures.join("\n"));
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
