/**
 * experiences-for-tilbydere-faq.test.ts — Opplevagent «For tilbydere» with
 * sections and FAQ (dev-request O4 = G4, slice O4a), behind
 * FOR_TILBYDERE_FAQ_ENABLED.
 *
 * Covers:
 *   1. Flag values: "1"/"true" (any case, trimmed) = on; anything else = off.
 *   2. Flag off: GET /for-tilbydere serves the old page (same HTML as with the
 *      flag set to "0"; old markers present; none of the new ids, no FAQPage).
 *   3. Flag on: 200; the ten section ids once each; the top menu links each;
 *      search form + three steps inside #ta-over; FAQPage JSON-LD parseable
 *      with one Question per FAQ item and the visible accordion equal to it;
 *      price text == OPPLEVAGENT_PRICE_MESSAGE (imported, not retyped);
 *      WebPage + BreadcrumbList still present; canonical and robots unchanged;
 *      no «Rett fra Bonden» / «rettfrabonden»; no inline handlers.
 *   4. Escaping of the FAQ accordion renderer.
 *
 * Router.handle()-free: calls the GET handler directly, no DB.
 * Standalone: npx tsx src/routes/experiences-for-tilbydere-faq.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function invokeGet(router: any, routePath: string): { found: boolean; status: number; body: string; nextCalled: boolean } {
  const layer = (router.stack as any[]).find((l: any) => l.route && l.route.methods?.get && l.route.path === routePath);
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
  const req: any = { lang: "no", path: routePath, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { nextCalled = true; });
  return { found: true, status, body, nextCalled };
}

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

export async function runExperiencesForTilbydereFaqTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const seo = require("./experiences-seo") as typeof import("./experiences-seo");
  const router = (seo as any).default;
  const copy = require("./experiences-for-tilbydere-faq") as typeof import("./experiences-for-tilbydere-faq");
  const { OPPLEVAGENT_PRICE_MESSAGE } = require("../owner-features/price-message") as typeof import("../owner-features/price-message");
  const { FOR_TILBYDERE_ANCHORS, FOR_TILBYDERE_FAQ, FOR_TILBYDERE_SECTIONS } = copy;

  const FLAG = "FOR_TILBYDERE_FAQ_ENABLED";
  const prevFlag = process.env[FLAG];
  try {
    // ── 1. Flag values ────────────────────────────────────────────────────
    for (const v of ["", "0", "false", "yes", "on", "2"]) {
      assertTrue(!copy.isForTilbydereFaqEnabled({ [FLAG]: v } as any), `flag value «${v}» = off`);
    }
    assertTrue(!copy.isForTilbydereFaqEnabled({} as any), "flag unset = off");
    for (const v of ["1", "true", "TRUE", " true "]) {
      assertTrue(copy.isForTilbydereFaqEnabled({ [FLAG]: v } as any), `flag value «${v}» = on`);
    }

    // ── 2. Flag off: the old page, unchanged ──────────────────────────────
    delete process.env[FLAG];
    const off = invokeGet(router, "/for-tilbydere");
    assertTrue(off.found, "setup: GET /for-tilbydere is registered on the experiences router");
    assertTrue(off.status === 200 && !off.nextCalled && off.body.length > 0, "flag off: 200");
    process.env[FLAG] = "0";
    const offZero = invokeGet(router, "/for-tilbydere");
    assertTrue(offZero.body === off.body, "flag «0»: byte-identical to flag unset");
    delete process.env[FLAG];
    for (const marker of [
      "<h1>For tilbydere</h1>",
      'id="ft-finn-h"', 'id="ft-steg-h"', 'id="ft-rediger-h"', 'id="ft-merke-h"', 'id="ft-login-h"',
      "Slik tar du eierskap — tre steg",
      '<form action="/for-tilbydere/finn" method="GET" role="search"',
      "<title>For tilbydere — ta eierskap til profilen din | Opplevagent</title>",
      '<meta name="robots" content="index, follow">',
    ]) {
      assertTrue(off.body.includes(marker), `flag off: old marker present: ${marker}`);
    }
    for (const id of FOR_TILBYDERE_ANCHORS) {
      assertTrue(!off.body.includes(`id="${id}"`), `flag off: new id «${id}» absent`);
    }
    assertTrue(!off.body.includes("FAQPage") && !off.body.includes("ftf-") && !off.body.includes("<details"), "flag off: no FAQPage, no new classes, no accordion");

    // ── 3. Flag on ────────────────────────────────────────────────────────
    process.env[FLAG] = "1";
    const on = invokeGet(router, "/for-tilbydere");
    const b = on.body;
    assertTrue(on.status === 200 && !on.nextCalled && b.length > 0, "flag on: 200");
    assertTrue(b !== off.body, "flag on: a different page");

    // Ten sections, ids once each, menu links each
    assertTrue(FOR_TILBYDERE_ANCHORS.length === 10 && FOR_TILBYDERE_SECTIONS.length === 10, "ten sections in the copy module");
    assertTrue(JSON.stringify(FOR_TILBYDERE_SECTIONS.map((s) => s.id)) === JSON.stringify(FOR_TILBYDERE_ANCHORS), "sections are in anchor order");
    const menu = (b.match(/<nav class="ftf-menu"[\s\S]*?<\/nav>/) || [""])[0];
    for (const id of ["slik-fungerer-det", "finn-deg", "ta-over", "bestem-selv", "besok", "smaking", "statistikk", "personvern", "pris", "sporsmal"]) {
      assertTrue(count(b, `id="${id}"`) === 1, `flag on: id «${id}» present exactly once`);
      assertTrue(menu.includes(`<a href="#${id}">`), `flag on: top menu links #${id}`);
    }
    assertTrue(count(menu, '<a href="#') === 10, "flag on: top menu has exactly ten links");

    // #ta-over keeps the search form and the three steps
    const taOver = (b.match(/<section class="ft-section ftf-sec" id="ta-over"[\s\S]*?<\/section>/) || [""])[0];
    assertTrue(taOver.includes('<form action="/for-tilbydere/finn" method="GET" role="search"'), "#ta-over: search form");
    assertTrue(count(taOver, '<div class="ft-step">') === 3 && taOver.includes("Klikk «Er dette din bedrift?»"), "#ta-over: the three ownership steps");

    // JSON-LD
    const blocks = [...b.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => {
      try { return JSON.parse(m[1]); } catch { return null; }
    });
    assertTrue(blocks.every((x) => x !== null), "flag on: every JSON-LD block parses");
    const faq = blocks.find((x) => x && x["@type"] === "FAQPage");
    assertTrue(!!faq, "flag on: FAQPage JSON-LD present");
    assertTrue(Array.isArray(faq?.mainEntity) && faq.mainEntity.length === FOR_TILBYDERE_FAQ.length && FOR_TILBYDERE_FAQ.length >= 8, `FAQPage mainEntity length == ${FOR_TILBYDERE_FAQ.length} FAQ items (≥8)`);
    assertTrue(blocks.some((x) => x && x["@type"] === "WebPage"), "flag on: WebPage JSON-LD still present");
    assertTrue(blocks.some((x) => x && x["@type"] === "BreadcrumbList"), "flag on: BreadcrumbList JSON-LD still present");
    const sporsmal = (b.match(/<section class="ft-section ftf-sec" id="sporsmal"[\s\S]*?<\/section>/) || [""])[0];
    const qs = [...sporsmal.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => decode(m[1]));
    const as = [...sporsmal.matchAll(/<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => decode(m[1]));
    assertTrue(JSON.stringify(qs) === JSON.stringify((faq?.mainEntity || []).map((e: any) => e.name)), "#sporsmal: visible questions == FAQPage questions");
    assertTrue(JSON.stringify(as) === JSON.stringify((faq?.mainEntity || []).map((e: any) => e.acceptedAnswer.text)), "#sporsmal: visible answers == FAQPage answers");
    assertTrue(count(sporsmal, "<details") === FOR_TILBYDERE_FAQ.length, "#sporsmal: one <details> per FAQ item");

    // Price
    const pris = (b.match(/<section class="ft-section ftf-sec" id="pris"[\s\S]*?<\/section>/) || [""])[0];
    const priceP = (pris.match(/<p class="ftf-price" data-price-message="1">([\s\S]*?)<\/p>/) || ["", ""])[1];
    assertTrue(decode(priceP) === OPPLEVAGENT_PRICE_MESSAGE, "#pris: price text equals OPPLEVAGENT_PRICE_MESSAGE");
    const copySrc = fs.readFileSync(path.join(__dirname, "experiences-for-tilbydere-faq.ts"), "utf8");
    assertTrue(!copySrc.includes(OPPLEVAGENT_PRICE_MESSAGE) && /import \{ OPPLEVAGENT_PRICE_MESSAGE \} from "\.\.\/owner-features\/price-message"/.test(copySrc), "copy module imports the price text, never retypes it");
    assertTrue(FOR_TILBYDERE_FAQ.some((p) => p.a === OPPLEVAGENT_PRICE_MESSAGE), "FAQ «Hva koster det» answer is the price constant");

    // Canonical, robots, chrome
    const canonOff = (off.body.match(/<link rel="canonical" href="[^"]*">/) || [""])[0];
    const canonOn = (b.match(/<link rel="canonical" href="[^"]*">/) || [""])[0];
    assertTrue(canonOn !== "" && canonOn === canonOff && /\/for-tilbydere">$/.test(canonOn), "flag on: canonical unchanged");
    assertTrue(b.includes('<meta name="robots" content="index, follow">') && !/noindex/.test(b), "flag on: still indexable");
    assertTrue(b.includes('id="oa-nav-toggle"') && b.includes('<a class="skip-link" href="#main">'), "flag on: same site chrome (nav + skip link)");
    assertTrue(count(b, "<footer") === count(off.body, "<footer"), "flag on: same footer");

    // Wording rules
    assertTrue(!/Rett fra Bonden/i.test(b) && !/rettfrabonden/i.test(b), "flag on: no «Rett fra Bonden» / «rettfrabonden»");
    assertTrue(!/Rett fra Bonden|rettfrabonden/i.test(copySrc.replace(/^\s*\/\/.*$/gm, "")), "copy module: no «Rett fra Bonden» in the text");
    assertTrue(!/\son[a-z]+\s*=/i.test(b.replace(/<script[\s\S]*?<\/script>/g, "")), "flag on: no inline event handlers");
    const smaking = decode((b.match(/<section class="ft-section ftf-sec" id="smaking"[\s\S]*?<\/section>/) || [""])[0]);
    assertTrue(/forslag/.test(smaking) && /ikke vedtatt/.test(smaking), "#smaking: legal status described as a proposal, not adopted");
    const besok = decode((b.match(/<section class="ft-section ftf-sec" id="besok"[\s\S]*?<\/section>/) || [""])[0]);
    assertTrue(/aldri bekreftet av seg selv/.test(besok) && /bekrefter, avslår eller foreslår et nytt tidspunkt/.test(besok), "#besok: never auto-confirmed; confirm/decline/propose new time");
    assertTrue(/tar aldri imot betaling/.test(besok) && /betaler hos deg/.test(besok), "#besok: Opplevagent never takes payment, paid at the producer");
    assertTrue(/«Mine besøk»/.test(besok), "#besok: mentions «Mine besøk»");
    const bestem = decode((b.match(/<section class="ft-section ftf-sec" id="bestem-selv"[\s\S]*?<\/section>/) || [""])[0]);
    assertTrue(/«Bare synlig»/.test(bestem) && /«Ta imot besøk»/.test(bestem) && /«Planlagt»/.test(bestem) && /«Mine valg»/.test(bestem), "#bestem-selv: two levels, «Planlagt», «Mine valg»");
    assertTrue(!/<form|<button|<input/.test(bestem), "#bestem-selv: static (no form, button or input in O4a)");
    assertTrue(b.includes(copy.FOR_TILBYDERE_CONTACT_EMAIL) && copy.FOR_TILBYDERE_CONTACT_EMAIL === "kontakt@opplevagent.no", "contact address is the one the other Opplevagent pages use");

    // ── 4. Escaping ───────────────────────────────────────────────────────
    const hostile = seo.renderForTilbydereFaqAccordion([{ q: `<script>alert(1)</script> "q" & 'x'`, a: `<img src=x onerror=alert(1)> «a»` }]);
    assertTrue(!hostile.includes("<script>") && !hostile.includes("<img") && hostile.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; &amp; &#39;x&#39;") && hostile.includes("&lt;img src=x onerror=alert(1)&gt; «a»"), "escaping: FAQ questions and answers are HTML-escaped");
    assertTrue(seo.renderForTilbydereFaqAccordion([]) === "", "escaping: empty FAQ renders nothing");
    const ld = copy.buildForTilbydereFaqLd("https://example.test/for-tilbydere", [{ q: "</script><script>alert(1)</script>", a: "x" }]) as any;
    assertTrue(ld["@id"] === "https://example.test/for-tilbydere#sporsmal" && ld.mainEntity.length === 1, "FAQPage @id anchors #sporsmal");
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runExperiencesForTilbydereFaqTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failed) console.log(s.failures.join("\n"));
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
