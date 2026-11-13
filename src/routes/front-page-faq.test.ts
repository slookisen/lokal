/**
 * front-page-faq.test.ts — «Spørsmål og svar» on the front pages of
 * rettfrabonden.com and opplevagent.no (A2A dev-request
 * 2026-11-06-faq-fra-forsiden-begge-plattformer; src/routes/front-page-faq.ts,
 * seo.ts, experiences-seo.ts, discovery.ts, a2a.ts,
 * services/experiences-agent-card.ts).
 *
 * Proves:
 *   AC1 Flag off (unset): front pages, header, footer, llms.txt and agent
 *       cards carry nothing new, and are byte-identical to the flag set to
 *       "0" / "false". Flag on: the page with the block, the menu link, the
 *       footer link and the CSS taken out is byte-identical to the flag-off
 *       page, so nothing else moved. Flag on shows the block (two columns),
 *       the menu link and the footer link on both platforms.
 *   AC2 Every Q/A in the block is picked from the FAQPage object of the FAQ
 *       page it links to, and appears (escaped) on that FAQ page.
 *   AC3 /for-produsenter with the flag off answers the site's 404 page.
 *   Text rules: no cart / pickup-order / booking-tool text, no «Gi meg
 *       beskjed»; columns stack below 768px; every string is escaped.
 *
 * Calls the GET handlers directly, no HTTP; experiences DB in memory.
 * Restores both flags and EXPERIENCES_DB_PATH in finally.
 * Standalone: npx tsx src/routes/front-page-faq.test.ts
 */

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
    json(b: unknown) { body = JSON.stringify(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang, path: routePath, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { nextCalled = true; });
  return { found: true, status, body, nextCalled };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}
/** Remove `needle` exactly once; returns null when it is not there exactly once. */
function cutOnce(hay: string, needle: string): string | null {
  if (!needle || count(hay, needle) !== 1) return null;
  return hay.replace(needle, () => "");
}
/** llms.txt stamps the generation time; everything else must match. */
function noStamp(s: string): string {
  return s.replace(/<!-- generated-at: [^>]* -->/g, "");
}
/** The signed card carries no timestamp, but drop `signatures` in case a key is configured. */
function cardBody(s: string): string {
  try { const o = JSON.parse(s); delete o.signatures; return JSON.stringify(o); } catch { return s; }
}

export async function runFrontPageFaqTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  // DB hermeticity (tests/test.ts db-hermetic): the Opplevagent handlers open
  // the experiences DB through db-factory; use an in-memory one, never
  // /app/data/experiences.db. Restored + factory reset in finally.
  const prevExpDb = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
  dbFactory.__resetDbFactoryForTesting();

  try {
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere */ }
  } catch { /* routes fall back to defaults */ }

  const seo = require("./seo") as typeof import("./seo");
  const seoRouter = (seo as any).default;
  const exp = require("./experiences-seo") as typeof import("./experiences-seo");
  const expRouter = (exp as any).default;
  const discRouter = (require("./discovery") as any).default;
  const a2aRouter = (require("./a2a") as any).default;
  const fpf = require("./front-page-faq") as typeof import("./front-page-faq");
  const fp = require("./rfb-for-produsenter") as typeof import("./rfb-for-produsenter");
  const tf = require("./experiences-for-tilbydere-faq") as typeof import("./experiences-for-tilbydere-faq");
  const { faqPairsFromJsonLd } = require("../services/faq-section") as typeof import("../services/faq-section");

  const RFB = "FOR_PRODUSENTER_PAGE_ENABLED";
  const OA = "FOR_TILBYDERE_FAQ_ENABLED";
  const prev = { rfb: process.env[RFB], oa: process.env[OA] };
  const setFlags = (v: string | undefined) => {
    if (v === undefined) { delete process.env[RFB]; delete process.env[OA]; }
    else { process.env[RFB] = v; process.env[OA] = v; }
  };

  type Snap = Record<string, string>;
  const snap = (): Snap => ({
    rfbHomeNo: invokeGet(seoRouter, "/", "no").body,
    rfbHomeEn: invokeGet(seoRouter, "/", "en").body,
    rfbPvNo: invokeGet(seoRouter, "/personvern", "no").body,
    rfbPvEn: invokeGet(seoRouter, "/personvern", "en").body,
    oaHomeNo: invokeGet(expRouter, "/", "no").body,
    oaHomeEn: invokeGet(expRouter, "/", "en").body,
    oaKontakt: invokeGet(expRouter, "/kontakt", "no").body,
    rfbLlms: noStamp(invokeGet(discRouter, "/llms.txt").body),
    oaLlms: noStamp(invokeGet(expRouter, "/llms.txt").body),
    rfbCard: cardBody(invokeGet(a2aRouter, "/.well-known/agent-card.json").body),
    oaCard: cardBody(invokeGet(expRouter, "/.well-known/agent-card.json").body),
  });

  try {
    // ── AC1: flag off ─────────────────────────────────────────────────────
    setFlags(undefined);
    const off = snap();
    for (const [k, v] of Object.entries(off)) {
      assertTrue(v.length > 0, `setup: ${k} renders`);
      assertTrue(!v.includes(fpf.FRONT_PAGE_FAQ_ANCHOR) && !v.includes("fq-grid") && !v.includes("x-faq"), `flag off: ${k} has no block, link or x-faq key`);
    }
    assertTrue(!off.rfbLlms.includes("/for-produsenter") && !off.oaLlms.includes("## Spørsmål og svar"), "flag off: llms.txt has no FAQ links");
    for (const v of ["0", "false"]) {
      setFlags(v);
      const s = snap();
      for (const k of Object.keys(off)) {
        assertTrue(s[k] === off[k], `flag off: ${k} byte-identical with the flags unset and set to «${v}»`);
      }
    }
    assertTrue(seo.renderRfbFrontPageFaq("no") === "" && seo.rfbFrontFaqNavLink("no") === "" && seo.rfbFrontFaqFooterLink("en") === "", "flag off: RFB helpers return \"\"");
    assertTrue(exp.renderOaFrontPageFaq("no") === "" && exp.oaFrontFaqNavLink("no") === "" && exp.oaFrontFaqFooterLink("no") === "" && exp.oaFaqLlmsSection("https://x") === "", "flag off: Opplevagent helpers return \"\"");
    assertTrue(JSON.stringify(fp.rfbAgentCardFaqLinks("https://x", {} as any)) === "{}", "flag off: RFB agent-card helper adds no key");

    // AC3: /for-produsenter with the flag off → the site's 404 page
    setFlags(undefined);
    for (const lang of ["no", "en"] as const) {
      const r = invokeGet(seoRouter, "/for-produsenter", lang);
      assertTrue(!r.nextCalled && r.status === 404 && /^\s*<!doctype html>/i.test(r.body) && !r.body.includes("Cannot GET"), `AC3 (${lang}): /for-produsenter flag off → status 404 with the site's own page`);
      assertTrue(r.body.includes('<meta name="robots" content="noindex, follow">') && r.body.includes(lang === "en" ? "Page not found" : "Fant ikke siden"), `AC3 (${lang}): 404 page is noindex with a «not found» heading`);
    }

    // ── AC1: flag on ──────────────────────────────────────────────────────
    setFlags("1");
    const on = snap();
    const rfbBlockNo = seo.renderRfbFrontPageFaq("no");
    const rfbBlockEn = seo.renderRfbFrontPageFaq("en");
    const oaBlock = exp.renderOaFrontPageFaq("no");

    for (const [lang, html, block] of [["no", on.rfbHomeNo, rfbBlockNo], ["en", on.rfbHomeEn, rfbBlockEn]] as const) {
      assertTrue(block.length > 0 && count(html, block) === 1, `RFB flag on (${lang}): the block is on the front page once`);
      assertTrue(count(html, `id="${fpf.FRONT_PAGE_FAQ_ANCHOR}"`) === 1, `RFB flag on (${lang}): one #${fpf.FRONT_PAGE_FAQ_ANCHOR}`);
      assertTrue(count(block, '<div class="fq-col">') === 2, `RFB flag on (${lang}): two columns`);
      const L = lang === "en" ? fpf.FRONT_PAGE_FAQ_LABELS.rfb.en : fpf.FRONT_PAGE_FAQ_LABELS.rfb.no;
      assertTrue(block.includes(`>${esc(L.buyers)}</h3>`) && block.includes(`>${esc(L.producers)}</h3>`), `RFB flag on (${lang}): buyers and producers columns`);
      assertTrue(block.indexOf(esc(L.buyers)) < block.indexOf(esc(L.producers)), `RFB flag on (${lang}): buyers first, producers second`);
      const nav = (html.match(/<nav class="nav">[\s\S]*?<\/nav>/) || [""])[0];
      const foot = (html.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
      const href = lang === "en" ? `/en#${fpf.FRONT_PAGE_FAQ_ANCHOR}` : `/#${fpf.FRONT_PAGE_FAQ_ANCHOR}`;
      assertTrue(nav.includes(`<a href="${href}">${esc(L.nav)}</a>`), `RFB flag on (${lang}): menu link → ${href}`);
      assertTrue(foot.includes(`<a href="${href}">${esc(L.nav)}</a>`), `RFB flag on (${lang}): footer link → ${href}`);
      assertTrue(html.includes(fpf.RFB_FRONT_FAQ_CSS), `RFB flag on (${lang}): block CSS in the page`);
      assertTrue(block.includes(`href="${lang === "en" ? "/en/for-produsenter" : "/for-produsenter"}"`) && block.includes(`href="${lang === "en" ? "/en/guide-mat-ai" : "/guide-mat-ai"}"`), `RFB flag on (${lang}): links to the full FAQs`);
    }
    for (const [lang, html] of [["no", on.rfbPvNo], ["en", on.rfbPvEn]] as const) {
      const L = lang === "en" ? fpf.FRONT_PAGE_FAQ_LABELS.rfb.en : fpf.FRONT_PAGE_FAQ_LABELS.rfb.no;
      assertTrue(count(html, `>${esc(L.nav)}</a>`) === 2 && !html.includes("fq-grid"), `RFB flag on (${lang}): other pages get the menu + footer link, not the block`);
    }
    assertTrue(oaBlock.length > 0 && count(on.oaHomeNo, oaBlock) === 1, "Opplevagent flag on: the block is on the front page once");
    assertTrue(count(oaBlock, '<div class="fq-col">') === 2 && oaBlock.includes(">For gjester</h3>") && oaBlock.includes(">For tilbydere</h3>"), "Opplevagent flag on: guests and providers columns");
    for (const [name, html] of [["front page", on.oaHomeNo], ["/kontakt", on.oaKontakt]] as const) {
      const nav = (html.match(/<header class="site-nav">[\s\S]*?<\/header>/) || [""])[0];
      const foot = (html.match(/<footer class="site-footer"[\s\S]*?<\/footer>/) || [""])[0];
      assertTrue(nav.includes(`<a href="/#${fpf.FRONT_PAGE_FAQ_ANCHOR}">Spørsmål og svar</a>`), `Opplevagent flag on: menu link on ${name}`);
      assertTrue(foot.includes(`<a href="/#${fpf.FRONT_PAGE_FAQ_ANCHOR}">Spørsmål og svar</a>`), `Opplevagent flag on: footer link on ${name}`);
    }
    assertTrue(on.oaHomeNo.includes(fpf.OA_FRONT_FAQ_CSS), "Opplevagent flag on: block CSS in the page");
    assertTrue(oaBlock.includes('href="/for-tilbydere#sporsmal"') && oaBlock.includes('href="/guide-opplevelser-mcp"'), "Opplevagent flag on: links to the full FAQs");
    assertTrue(on.oaHomeEn === off.oaHomeEn, "Opplevagent flag on: the EN front page is unchanged (the FAQ sources are Norwegian)");

    // Flag on minus exactly the additions == flag off (nothing else moved).
    // The same flag already (before this change) points the header «For
    // produsenter» at /for-produsenter and adds a footer link to it (F1); those
    // two are put back to their flag-off form first.
    const stripRfb = (html: string, lang: "no" | "en", block: string): string | null => {
      const fpHref = lang === "en" ? "/en/for-produsenter" : "/for-produsenter";
      let s: string | null = html.replace(`<a href="${fpHref}" class="nav-cta">`, '<a href="/selger" class="nav-cta">');
      s = cutOnce(s, `<a href="${fpHref}">${lang === "en" ? "How it works for producers" : "Slik fungerer det"}</a>`);
      s = s && cutOnce(s, `\n\n    ${block}`);
      s = s && cutOnce(s, seo.rfbFrontFaqNavLink(lang));
      s = s && cutOnce(s, seo.rfbFrontFaqFooterLink(lang));
      s = s && cutOnce(s, fpf.RFB_FRONT_FAQ_CSS);
      return s;
    };
    assertTrue(stripRfb(on.rfbHomeNo, "no", rfbBlockNo) === off.rfbHomeNo, "RFB (no): flag-on page minus block/menu/footer/CSS is byte-identical to flag off");
    assertTrue(stripRfb(on.rfbHomeEn, "en", rfbBlockEn) === off.rfbHomeEn, "RFB (en): flag-on page minus block/menu/footer/CSS is byte-identical to flag off");
    {
      let s: string | null = cutOnce(on.oaHomeNo, `\n\n  ${oaBlock}`);
      // Header and footer links are the same string: exactly two, both cut.
      const link = exp.oaFrontFaqNavLink("no");
      assertTrue(link === exp.oaFrontFaqFooterLink("no") && s !== null && count(s, link) === 2, "Opplevagent: exactly one menu and one footer link");
      s = s && s.split(link).join("");
      s = s && cutOnce(s, fpf.OA_FRONT_FAQ_CSS);
      assertTrue(s === off.oaHomeNo, "Opplevagent: flag-on page minus block/menu/footer/CSS is byte-identical to flag off");
    }

    // llms.txt and agent cards
    assertTrue(on.rfbLlms.includes(`/#${fpf.FRONT_PAGE_FAQ_ANCHOR})`) && on.rfbLlms.includes("/for-produsenter)"), "RFB llms.txt (on): links the front-page FAQ and /for-produsenter");
    assertTrue(cutOnce(on.rfbLlms, (require("./discovery") as any).rfbFaqLlmsLines()) === off.rfbLlms, "RFB llms.txt: on minus the two lines == off");
    assertTrue(on.oaLlms.includes(`/#${fpf.FRONT_PAGE_FAQ_ANCHOR} `) && on.oaLlms.includes("/for-tilbydere#sporsmal"), "Opplevagent llms.txt (on): links the front-page FAQ and /for-tilbydere#sporsmal");
    {
      const base = (on.oaLlms.match(/(https?:\/\/[^\s/]+)\/#sporsmal-og-svar/) || ["", ""])[1];
      assertTrue(cutOnce(on.oaLlms, exp.oaFaqLlmsSection(base)) === off.oaLlms, "Opplevagent llms.txt: on minus the section == off");
    }
    const rc = JSON.parse(on.rfbCard);
    const oc = JSON.parse(on.oaCard);
    assertTrue(typeof rc["x-faq"]?.frontPage === "string" && rc["x-faq"].frontPage.endsWith(`/#${fpf.FRONT_PAGE_FAQ_ANCHOR}`) && rc["x-faq"].producers.endsWith("/for-produsenter"), "RFB agent card (on): x-faq links");
    assertTrue(oc["x-faq"]?.frontPage === "https://opplevagent.no/#sporsmal-og-svar" || (typeof oc["x-faq"]?.frontPage === "string" && oc["x-faq"].frontPage.endsWith("/#sporsmal-og-svar")), "Opplevagent agent card (on): x-faq.frontPage");
    assertTrue(typeof oc["x-faq"]?.providers === "string" && oc["x-faq"].providers.endsWith("/for-tilbydere#sporsmal"), "Opplevagent agent card (on): x-faq.providers");
    delete rc["x-faq"]; delete oc["x-faq"];
    assertTrue(JSON.stringify(rc) === off.rfbCard && JSON.stringify(oc) === off.oaCard, "agent cards: on minus x-faq == off");

    // ── AC2: same source as the FAQ pages ─────────────────────────────────
    const fpNo = invokeGet(seoRouter, "/for-produsenter", "no").body;
    const fpEn = invokeGet(seoRouter, "/for-produsenter", "en").body;
    const gmaNo = invokeGet(seoRouter, "/guide-mat-ai", "no").body;
    const gmaEn = invokeGet(seoRouter, "/guide-mat-ai", "en").body;
    const ftOa = invokeGet(expRouter, "/for-tilbydere", "no").body;
    const gomOa = invokeGet(expRouter, "/guide-opplevelser-mcp", "no").body;
    const checks: Array<[string, { pairs: { q: string; a: string }[] }, readonly string[], string, number]> = [];
    for (const lang of ["no", "en"] as const) {
      const cols = seo.rfbFrontPageFaqColumns(lang);
      const Q = fpf.RFB_FRONT_FAQ_QUESTIONS;
      checks.push([`RFB buyers (${lang})`, cols[0], lang === "en" ? Q.buyers.en : Q.buyers.no, lang === "en" ? gmaEn : gmaNo, 3]);
      checks.push([`RFB producers (${lang})`, cols[1], lang === "en" ? Q.producers.en : Q.producers.no, lang === "en" ? fpEn : fpNo, 5]);
      // The pairs are exactly the FAQ page's own FAQPage pairs.
      const fromLd = faqPairsFromJsonLd(fp.buildForProdusenterFaqLd(lang, "https://x/for-produsenter"));
      assertTrue(JSON.stringify(cols[1].pairs) === JSON.stringify(fpf.pickFaqPairs(fromLd, lang === "en" ? Q.producers.en : Q.producers.no)), `AC2 RFB producers (${lang}): pairs == pickFaqPairs(buildForProdusenterFaqLd)`);
      const gmaLd = faqPairsFromJsonLd(seo.buildMcpGuideFaqJsonLd(lang, "https://x/guide-mat-ai"));
      assertTrue(JSON.stringify(cols[0].pairs) === JSON.stringify(fpf.pickFaqPairs(gmaLd, lang === "en" ? Q.buyers.en : Q.buyers.no)), `AC2 RFB buyers (${lang}): pairs == pickFaqPairs(buildMcpGuideFaqJsonLd)`);
    }
    const oaCols = exp.oaFrontPageFaqColumns();
    checks.push(["Opplevagent guests", oaCols[0], fpf.OA_FRONT_FAQ_QUESTIONS.guests, gomOa, 2]);
    checks.push(["Opplevagent providers", oaCols[1], fpf.OA_FRONT_FAQ_QUESTIONS.providers, ftOa, 5]);
    assertTrue(JSON.stringify(oaCols[1].pairs) === JSON.stringify(fpf.pickFaqPairs(faqPairsFromJsonLd(tf.buildForTilbydereFaqLd("https://x/for-tilbydere")), fpf.OA_FRONT_FAQ_QUESTIONS.providers)), "AC2 Opplevagent providers: pairs == pickFaqPairs(buildForTilbydereFaqLd)");
    for (const [name, col, questions, page, n] of checks) {
      assertTrue(col.pairs.length === questions.length && col.pairs.length === n, `AC2 ${name}: every selected question resolves in its source (${n})`);
      assertTrue(col.pairs.length <= 5, `${name}: at most five questions`);
      assertTrue(page.length > 0 && col.pairs.every((p) => page.includes(esc(p.q)) && page.includes(esc(p.a))), `AC2 ${name}: every Q and A is on the FAQ page it links to`);
    }
    assertTrue(oaCols[1].pairs.find((p) => p.q === "Hva koster det å være på Opplevagent?")?.a === require("../owner-features/price-message").OPPLEVAGENT_PRICE_MESSAGE, "AC2 Opplevagent providers: the price answer is OPPLEVAGENT_PRICE_MESSAGE");

    // ── Text rules ────────────────────────────────────────────────────────
    for (const [name, block] of [["RFB no", rfbBlockNo], ["RFB en", rfbBlockEn], ["Opplevagent", oaBlock]] as const) {
      assertTrue(!/handlekurv|henteordre|lokal_cart|book_gardssalg|booking_url|shopping list|pickup order|Gi meg beskjed|Let me know/i.test(block), `text rules (${name}): no cart / pickup-order / booking-tool / «Gi meg beskjed» text`);
      assertTrue(!/on\w+="/i.test(block) && !block.includes("<script"), `${name}: no script, no inline handlers`);
    }
    assertTrue(!/Rett fra Bonden|rettfrabonden/i.test(oaBlock), "Opplevagent block never names Rett fra Bonden");

    // ── Layout and escaping ───────────────────────────────────────────────
    for (const css of [fpf.RFB_FRONT_FAQ_CSS, fpf.OA_FRONT_FAQ_CSS]) {
      assertTrue(/@media \(max-width: 768px\) \{ \.fq-grid \{ grid-template-columns: 1fr; \} \}/.test(css) && /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css), "CSS: two columns, stacked at <=768px (375px phones)");
    }
    const evil = fpf.renderFrontPageFaqColumns([{ id: "x\"y", title: "<b>T</b>", pairs: [{ q: "<script>q</script>", a: "a & \"b\"" }], moreHref: "/a\"onmouseover=\"x", moreLabel: "<i>m</i>" }]);
    assertTrue(!evil.includes("<script>") && !evil.includes("<b>") && !evil.includes("<i>") && evil.includes("&lt;script&gt;q&lt;/script&gt;") && evil.includes("a &amp; &quot;b&quot;") && !evil.includes('"onmouseover="'), "renderFrontPageFaqColumns escapes every string");
    assertTrue(JSON.stringify(fpf.pickFaqPairs([{ q: "a", a: "1" }, { q: "b", a: "2" }], ["b", "missing", "a"])) === JSON.stringify([{ q: "b", a: "2" }, { q: "a", a: "1" }]), "pickFaqPairs: order of the selection, missing skipped");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    if (prev.rfb === undefined) delete process.env[RFB]; else process.env[RFB] = prev.rfb;
    if (prev.oa === undefined) delete process.env[OA]; else process.env[OA] = prev.oa;
    if (prevExpDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpDb;
    dbFactory.__resetDbFactoryForTesting();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runFrontPageFaqTests({ log: true }).then((r) => {
    console.log(`\nfront-page-faq: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
