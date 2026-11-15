/**
 * rfb-for-produsenter-demo.test.ts — the clickable «Mine valg» demo in
 * #mine-valg on /for-produsenter (A2A dev-request 2026-10-22-rfb-for-
 * produsenter-faq-side, slice F2c-2, AC5).
 *
 *   a-*  a fixture registry entry with `sellerFaq` shows up in the demo (live
 *        row and «Planlagt» box) through the render's registry seam, without
 *        any change to page code; the demo is not in the FAQPage JSON-LD.
 *   b-*  every RFB entry that is not a live choice stands in the «Planlagt»
 *        box with a disabled button and no toggle.
 *   c-*  no write calls: no form / action / method, no fetch / XHR / beacon /
 *        socket / storage / cookie in the markup or its script; the script,
 *        run against a minimal fake DOM with no network or storage globals,
 *        only flips the DOM (aria-pressed, button text, state, locked rows).
 *   d-*  FOR_PRODUSENTER_DEMO_ENABLED off (default): the page is byte-
 *        identical to a render where no entry has sellerFaq and has no demo
 *        markup or CSS; the route's HTML too.
 *   e-*  EN renders (EN copy, /en/for-produsenter links, «Read more»).
 *   f-*  same component as «Mine valg»: the NO state words equal page.ts
 *        formatOwnerFeatureValue; «I pilot» badges follow today-facts.
 *   g-*  mobile / keyboard: buttons with aria-pressed, rows wrap, no fixed
 *        widths ≥ 100px in the demo CSS.
 *
 * Pure renders take an explicit env; only the d-route block sets
 * process.env (both flags), restored in `finally`. No module-cache swaps.
 * Standalone: npx tsx src/routes/rfb-for-produsenter-demo.test.ts — wired
 * into tests/test.ts.
 */

import vm from "vm";
import type { OwnerFeatureEntry } from "../owner-features/registry";
import type { ForProdusenterFacts } from "../owner-features/today-facts";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PAGE_FLAG = "FOR_PRODUSENTER_PAGE_ENABLED";
const DEMO_FLAG = "FOR_PRODUSENTER_DEMO_ENABLED";

function invokeGet(router: any, routePath: string, lang: "no" | "en"): string {
  const layer = (router.stack as any[]).find((l: any) => l.route && l.route.methods?.get &&
    (Array.isArray(l.route.path) ? l.route.path.includes(routePath) : l.route.path === routePath));
  if (!layer) return "";
  let body = "";
  const res: any = {
    status() { return this; }, send(b: unknown) { body = String(b); return this; },
    setHeader() { return this; }, header() { return this; }, redirect() { return this; },
  };
  const req: any = { lang, path: routePath, params: {}, query: {}, headers: {}, get() { return undefined; } };
  layer.route.stack[layer.route.stack.length - 1].handle(req, res, () => { /* next */ });
  return body;
}

function demoOf(html: string): string {
  const i = html.indexOf('<div class="fp-demo"');
  if (i < 0) return "";
  const end = html.indexOf("</script>", i);
  return end < 0 ? html.slice(i) : html.slice(i, end + "</script>".length);
}

// ── a minimal fake DOM for the demo script (c-*) ──────────────────────────
class FakeEl {
  attrs: Record<string, string>;
  classes: Set<string>;
  textContent: string;
  disabled: boolean;
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  tag: string;
  listeners: Record<string, Array<(e: any) => void>> = {};
  constructor(tag: string, attrs: Record<string, string> = {}, text = "") {
    this.tag = tag; this.attrs = { ...attrs }; this.textContent = text;
    this.classes = new Set((attrs.class || "").split(/\s+/).filter(Boolean));
    this.disabled = "disabled" in attrs;
  }
  add(c: FakeEl): FakeEl { c.parent = this; this.children.push(c); return c; }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n: string, v: string) { this.attrs[n] = v; }
  get classList() {
    return { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c), contains: (c: string) => this.classes.has(c) };
  }
  addEventListener(t: string, fn: (e: any) => void) { (this.listeners[t] ||= []).push(fn); }
  private all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  private matches(sel: string): boolean {
    if (sel === "button[data-demo-toggle]") return this.tag === "button" && "data-demo-toggle" in this.attrs;
    if (sel === "[data-demo-key]") return "data-demo-key" in this.attrs;
    if (sel === "[data-demo-locked-when]") return "data-demo-locked-when" in this.attrs;
    if (sel === ".fp-demo-state") return this.classes.has("fp-demo-state");
    throw new Error("fake DOM: unsupported selector " + sel);
  }
  closest(sel: string): FakeEl | null { let e: FakeEl | null = this; while (e) { if (e.matches(sel)) return e; e = e.parent; } return null; }
  querySelector(sel: string): FakeEl | null { return this.all().find((e) => e.matches(sel)) ?? null; }
  querySelectorAll(sel: string): FakeEl[] { return this.all().filter((e) => e.matches(sel)); }
}

/** Builds the fake tree from the demo markup (rows, state spans, buttons only). */
function fakeDemo(html: string): { root: FakeEl; rows: Map<string, FakeEl> } {
  const rootAttrs: Record<string, string> = {};
  const head = html.slice(0, html.indexOf(">"));
  for (const m of head.matchAll(/([a-z-]+)="([^"]*)"/g)) rootAttrs[m[1]] = m[2];
  const root = new FakeEl("div", rootAttrs);
  const rows = new Map<string, FakeEl>();
  for (const m of html.matchAll(/<li class="fp-demo-item"([^>]*)>([\s\S]*?)<\/li>/g)) {
    const attrs: Record<string, string> = { class: "fp-demo-item" };
    for (const a of m[1].matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const li = root.add(new FakeEl("li", attrs));
    const st = m[2].match(/<span class="fp-demo-state">([^<]*)<\/span>/);
    if (st) li.add(new FakeEl("span", { class: "fp-demo-state" }, st[1]));
    const b = m[2].match(/<button ([^>]*)>([^<]*)<\/button>/);
    if (b) {
      const ba: Record<string, string> = {};
      for (const a of b[1].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) ba[a[1]] = a[2] ?? "";
      li.add(new FakeEl("button", ba, b[2]));
    }
    if (attrs["data-demo-key"]) rows.set(attrs["data-demo-key"], li);
  }
  return { root, rows };
}

export async function runRfbForProdusenterDemoTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.info(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.info(`  ✗ ${name}`); }
  };

  const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
  const fp = require("./rfb-for-produsenter") as typeof import("./rfb-for-produsenter");
  const pg = require("../owner-features/page") as typeof import("../owner-features/page");
  const { faqPairsFromJsonLd } = require("../services/faq-section") as typeof import("../services/faq-section");

  const ON = { [DEMO_FLAG]: "1" } as NodeJS.ProcessEnv;
  const OFF = {} as NodeJS.ProcessEnv;
  const base = fp.currentForProdusenterFacts();
  const withPilot = (s: Partial<ForProdusenterFacts["pilot"]>): ForProdusenterFacts => ({ ...base, pilot: { ...base.pilot, ...s } });
  const forAlle = withPilot({ mine_valg: "for_alle", varer: "for_alle", kanseller: "for_alle", lagerpaminnelse: "for_alle", myk_utlop: "for_alle" });
  const url = (lang: "no" | "en") => `https://x${lang === "en" ? "/en" : ""}/for-produsenter`;
  const page = (lang: "no" | "en", facts: ForProdusenterFacts, env: NodeJS.ProcessEnv, registry?: OwnerFeatureEntry[]) =>
    fp.renderForProdusenterPage(lang, url(lang), facts, { env, ...(registry ? { registry } : {}) });

  // ── fixture registry: one live and one planned entry with sellerFaq, plus
  //    sellerFaq on an existing live entry. Copies only; the real registry is
  //    never mutated.
  const SF_LIVE = { no: "FIXTURE-SF-LIVE-NO forklaring for selgere", en: "FIXTURE-SF-LIVE-EN explanation for sellers" };
  const SF_PLAN = { no: "FIXTURE-SF-PLAN-NO", en: "FIXTURE-SF-PLAN-EN" };
  const SF_REAL = { no: "FIXTURE-SF-REAL-NO", en: "FIXTURE-SF-REAL-EN" };
  const fixtureLive: OwnerFeatureEntry = {
    key: "fixture.demo_live", group: "stats", type: "switch",
    label: { no: "Fixture-valg", en: "Fixture choice" }, description: { no: "FIXTURE-DESC-NO", en: "FIXTURE-DESC-EN" },
    default: { owner: false, unclaimed: false }, requires: [], status: "live", consent: false, outward: false, advanced: false,
    verticals: ["rfb"], since: "2026-11-15", devRequest: "fixture", surfaces: [], faqAnchor: "statistikk", sellerFaq: SF_LIVE,
  };
  const fixturePlanned: OwnerFeatureEntry = { ...fixtureLive, key: "fixture.demo_planned", status: "coming_soon", label: { no: "Fixture-planlagt", en: "Fixture planned" }, faqAnchor: undefined, sellerFaq: SF_PLAN };
  const fixtureGs: OwnerFeatureEntry = { ...fixtureLive, key: "fixture.demo_gs", verticals: ["gardssalg"], label: { no: "Fixture-gårdssalg", en: "Fixture gardssalg" } };
  const fixtureRegistry: OwnerFeatureEntry[] = [
    ...reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === "visibility.profile" ? { ...e, sellerFaq: SF_REAL } : { ...e })),
    fixtureLive, fixturePlanned, fixtureGs,
  ];
  const stripSellerFaq = (r: OwnerFeatureEntry[]) => r.map((e) => { const { sellerFaq: _drop, ...rest } = e; return rest as OwnerFeatureEntry; });

  try {
    ok(reg.OWNER_FEATURE_REGISTRY.every((e) => !e.key.startsWith("fixture.")), "setup: the real registry has no fixture entries");

    // ── a: sellerFaq from the registry seam ──────────────────────────────
    const fxNo = page("no", forAlle, ON, fixtureRegistry);
    const demoNo = demoOf(fxNo.content);
    ok(demoNo.length > 0, "a-00: flag on: the demo renders");
    const mineValg = fxNo.content.slice(fxNo.content.indexOf('<section class="fp-sec" id="mine-valg"'), fxNo.content.indexOf('<section class="fp-sec" id="bestillinger"'));
    ok(mineValg.includes('<div class="fp-demo" id="fpDemo"'), "a-01: the demo stands inside #mine-valg");
    const rowOf = (html: string, key: string) => {
      const i = html.indexOf(`data-demo-key="${key}"`);
      return i < 0 ? "" : html.slice(i, html.indexOf("</li>", i));
    };
    const plannedOf = (html: string, key: string) => {
      const i = html.indexOf(`data-demo-planned-key="${key}"`);
      return i < 0 ? "" : html.slice(i, html.indexOf("</li>", i));
    };
    const liveRow = rowOf(demoNo, "fixture.demo_live");
    ok(liveRow.includes(`<p class="fp-demo-desc" data-seller-faq="1">${SF_LIVE.no}</p>`), "a-02: the fixture's sellerFaq is the live row's text");
    ok(!liveRow.includes("FIXTURE-DESC-NO"), "a-03: sellerFaq replaces description in the row");
    ok(liveRow.includes('<a href="/for-produsenter#statistikk" data-faq-anchor="statistikk">Les mer</a>'), "a-04: the fixture's faqAnchor gives «Les mer»");
    ok(liveRow.includes("data-demo-toggle") && liveRow.includes('aria-pressed="false"'), "a-05: the live switch fixture is interactive, off by its default");
    ok(plannedOf(demoNo, "fixture.demo_planned").includes(SF_PLAN.no), "a-06: the planned fixture's sellerFaq is in the «Planlagt» box");
    ok(rowOf(demoNo, "visibility.profile").includes(SF_REAL.no), "a-07: sellerFaq on an existing entry shows in its row");
    ok(!demoNo.includes("Fixture-gårdssalg"), "a-08: gårdssalg entries are not in the RFB demo");
    ok(demoOf(page("no", forAlle, ON).content).length > 0 && !demoOf(page("no", forAlle, ON).content).includes("data-seller-faq"),
      "a-09: real registry: no entry has sellerFaq yet, rows show the «Mine valg» description");
    const ld = JSON.stringify(fxNo.jsonLd);
    ok(![SF_LIVE.no, SF_PLAN.no, SF_REAL.no, "Eksempelgård", "fpDemo"].some((s) => ld.includes(s)), "a-10: the demo is not in the FAQPage JSON-LD");
    ok(JSON.stringify(fxNo.jsonLd) === JSON.stringify(page("no", forAlle, OFF, fixtureRegistry).jsonLd), "a-11: the JSON-LD is the same with the demo flag on and off");
    const visible = [...fxNo.content.matchAll(/<details class="fp-qa"><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].length;
    ok(visible === faqPairsFromJsonLd(fxNo.jsonLd).length, "a-12: visible Q/A count equals the JSON-LD (demo adds no Q/A)");

    // ── b: coming_soon / not-live entries render disabled ────────────────
    const rfb = fixtureRegistry.filter((e) => e.verticals.includes("rfb"));
    const liveKeys = new Set(fp.liveRfbOwnerChoices(forAlle, rfb).map((e) => e.key));
    const planned = rfb.filter((e) => !liveKeys.has(e.key));
    ok(planned.some((e) => reg.ownerFeatureStatus(e) === "coming_soon"), "b-00: there are coming_soon entries to check");
    ok(demoNo.includes(`<summary>Planlagt (${planned.length})</summary>`), "b-01: the «Planlagt» box counts every non-live RFB entry");
    for (const e of planned) {
      const row = plannedOf(demoNo, e.key);
      ok(row.includes('<button type="button" class="fp-btn" disabled aria-disabled="true">') && !row.includes("data-demo-toggle") && !rowOf(demoNo, e.key),
        `b-02: ${e.key}: planned, button disabled, no toggle`);
    }
    for (const e of rfb.filter((x) => reg.ownerFeatureStatus(x) === "coming_soon")) ok(!rowOf(demoNo, e.key), `b-03: coming_soon ${e.key} is never a live row`);
    const stockPlanned = demoOf(page("no", withPilot({ lagerpaminnelse: "planlagt" }), ON).content);
    ok(!rowOf(stockPlanned, "products.stock_check") && plannedOf(stockPlanned, "products.stock_check").includes("disabled"),
      "b-04: products.stock_check is planned while the stock-check reminder is «planlagt» (as the page's list)");

    // ── c: no write calls ────────────────────────────────────────────────
    for (const [lang, html] of [["no", demoNo], ["en", demoOf(page("en", forAlle, ON, fixtureRegistry).content)]] as const) {
      ok(!/<form\b|\baction=|\bmethod=|formaction/i.test(html), `c-00: ${lang}: no form, action or method`);
      ok(!/fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.|\.submit\s*\(|import\s*\(/.test(html), `c-01: ${lang}: no fetch / XHR / beacon / socket / submit`);
      ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./.test(html), `c-02: ${lang}: no storage or cookies`);
      ok(!/\/api\/|\/selger\/|\/eier\//.test(html), `c-03: ${lang}: no API or owner endpoints`);
      ok(!/\son[a-z]+=/.test(html), `c-04: ${lang}: no inline event handlers (CSP)`);
      const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
      ok(buttons.length > 0 && buttons.every((b) => b.includes('type="button"')), `c-05: ${lang}: every button is type="button" (never submits)`);
    }
    const script = (demoNo.match(/<script>([\s\S]*?)<\/script>/) || ["", ""])[1];
    ok(script.length > 0, "c-06: the demo has its script");
    const { root, rows } = fakeDemo(demoNo);
    const sandbox: any = { document: { getElementById: (id: string) => (id === "fpDemo" ? root : null) } };
    vm.runInNewContext(script, sandbox); // no fetch / XMLHttpRequest / localStorage defined: touching them would throw
    const click = (b: FakeEl) => (root.listeners.click || []).forEach((fn) => fn({ target: b }));
    const orders = rows.get("orders.enabled")!;
    const ordersBtn = orders.children.find((c) => c.tag === "button")!;
    const lockedState = () => rows.get("orders.reminder")!.querySelector(".fp-demo-state")!.textContent;
    ok(ordersBtn.getAttribute("aria-pressed") === "false" && lockedState() === "Av", "c-07: start: orders off, the locked reminder «Av»");
    click(ordersBtn);
    ok(ordersBtn.getAttribute("aria-pressed") === "true" && ordersBtn.textContent === "Slå av" && orders.querySelector(".fp-demo-state")!.textContent === "På" && !ordersBtn.classes.has("fp-btn-primary"),
      "c-08: toggle on: aria-pressed, button text and state flip in the DOM");
    ok(lockedState() === "Låst på" && rows.get("notify.order_email")!.querySelector(".fp-demo-state")!.textContent === "Låst på", "c-09: rows locked to orders.enabled show «Låst på»");
    click(ordersBtn);
    ok(ordersBtn.getAttribute("aria-pressed") === "false" && ordersBtn.textContent === "Slå på" && lockedState() === "Av" && ordersBtn.classes.has("fp-btn-primary"), "c-10: toggle off again: back to the start");
    const plannedBtn = new FakeEl("button", { type: "button", disabled: "" }, "Slå på");
    click(plannedBtn);
    ok(plannedBtn.textContent === "Slå på" && plannedBtn.getAttribute("aria-pressed") === null, "c-11: a disabled (planned) button does nothing");
    ok(Object.keys(sandbox).every((k) => k === "document"), "c-12: the script sets no globals");

    // ── d: flag off ⇒ byte-identical ─────────────────────────────────────
    for (const lang of ["no", "en"] as const) {
      for (const [name, facts] of [["for_alle", forAlle], ["i_pilot", withPilot({ mine_valg: "i_pilot", lagerpaminnelse: "i_pilot" })], ["planlagt", withPilot({ mine_valg: "planlagt" })]] as const) {
        const off = page(lang, facts, OFF, fixtureRegistry);
        ok(JSON.stringify(off) === JSON.stringify(page(lang, facts, OFF, stripSellerFaq(fixtureRegistry))), `d-00: ${lang}/${name}: flag off: identical to a registry without sellerFaq`);
        ok(!off.content.includes("fp-demo") && !off.content.includes("fpDemo"), `d-01: ${lang}/${name}: flag off: no demo markup`);
        ok(JSON.stringify(page(lang, facts, OFF)) === JSON.stringify(fp.renderForProdusenterPage(lang, url(lang), facts)) || process.env[DEMO_FLAG] !== undefined,
          `d-02: ${lang}/${name}: default call (no options) equals the explicit flag-off render`);
      }
    }
    for (const v of ["", "0", "false", "yes", "on"]) ok(!fp.isForProdusenterDemoEnabled({ [DEMO_FLAG]: v } as NodeJS.ProcessEnv), `d-03: «${v}» = off`);
    for (const v of ["1", "true", " TRUE "]) ok(fp.isForProdusenterDemoEnabled({ [DEMO_FLAG]: v } as NodeJS.ProcessEnv), `d-04: «${v}» = on`);
    ok(fp.forProdusenterPageCss(OFF) === fp.FOR_PRODUSENTER_CSS, "d-05: flag off: the page CSS is FOR_PRODUSENTER_CSS unchanged");
    ok(fp.forProdusenterPageCss(ON) === fp.FOR_PRODUSENTER_CSS + fp.FOR_PRODUSENTER_DEMO_CSS, "d-06: flag on: the demo CSS is appended");

    const prevPage = process.env[PAGE_FLAG];
    const prevDemo = process.env[DEMO_FLAG];
    try {
      try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }
      const seoRouter = (require("./seo") as any).default;
      process.env[PAGE_FLAG] = "1";
      delete process.env[DEMO_FLAG];
      const offNo = invokeGet(seoRouter, fp.FOR_PRODUSENTER_PATH, "no");
      const offEn = invokeGet(seoRouter, fp.FOR_PRODUSENTER_PATH, "en");
      ok(offNo.includes('id="mine-valg"') && !offNo.includes("fp-demo") && !offEn.includes("fp-demo"), "d-07: route, demo flag off: no demo markup or CSS (NO + EN)");
      process.env[DEMO_FLAG] = "1";
      const onNo = invokeGet(seoRouter, fp.FOR_PRODUSENTER_PATH, "no");
      ok(onNo.includes('<div class="fp-demo" id="fpDemo"') && onNo.includes(".fp-demo-item {"), "d-08: route, demo flag on: demo markup and its CSS");
      delete process.env[DEMO_FLAG];
      ok(invokeGet(seoRouter, fp.FOR_PRODUSENTER_PATH, "no") === offNo, "d-09: route, flag off again: byte-identical to the first flag-off answer");
    } finally {
      if (prevPage === undefined) delete process.env[PAGE_FLAG]; else process.env[PAGE_FLAG] = prevPage;
      if (prevDemo === undefined) delete process.env[DEMO_FLAG]; else process.env[DEMO_FLAG] = prevDemo;
    }

    // ── e: EN ────────────────────────────────────────────────────────────
    const demoEn = demoOf(page("en", forAlle, ON, fixtureRegistry).content);
    ok(demoEn.includes("Try «Mine valg» (My choices)") && demoEn.includes("Example farm") && demoEn.includes("This is a demo. Nothing is saved."), "e-00: EN demo copy");
    ok(rowOf(demoEn, "fixture.demo_live").includes(SF_LIVE.en) && rowOf(demoEn, "fixture.demo_live").includes("Fixture choice"), "e-01: EN: sellerFaq.en and label.en");
    ok(rowOf(demoEn, "fixture.demo_live").includes('<a href="/en/for-produsenter#statistikk" data-faq-anchor="statistikk">Read more</a>'), "e-02: EN: «Read more» → /en/for-produsenter#…");
    ok(demoEn.includes('data-t-switch-on="Switch on"') && demoEn.includes("<summary>Planned ("), "e-03: EN state words and «Planned»");
    ok(!/Slå på|Eksempelgård|Les mer/.test(demoEn), "e-04: EN demo has no NO UI words");

    // ── f: same component as «Mine valg», pilot badges ───────────────────
    const c = fp.FOR_PRODUSENTER_DEMO_COPY.no;
    const sw = reg.OWNER_FEATURE_REGISTRY.find((e) => e.type === "switch")!;
    const lk = reg.OWNER_FEATURE_REGISTRY.find((e) => e.type === "locked")!;
    const gu = reg.OWNER_FEATURE_REGISTRY.find((e) => e.type === "guarantee")!;
    const em = reg.OWNER_FEATURE_REGISTRY.find((e) => e.type === "email")!;
    ok(pg.formatOwnerFeatureValue(sw, true) === c.on && pg.formatOwnerFeatureValue(sw, false) === c.off && pg.formatOwnerFeatureValue(lk, true) === c.lockedOn
      && pg.formatOwnerFeatureValue(gu, true) === c.always && pg.formatOwnerFeatureValue(em, null) === c.profileEmail && pg.formatOwnerFeatureValue(sw, null) === c.notChosen,
      "f-00: NO state words are the «Mine valg» ones (formatOwnerFeatureValue)");
    ok(rowOf(demoNo, "auto.guarantee").includes('<span class="fp-demo-state">Alltid</span>') && !rowOf(demoNo, "auto.guarantee").includes("<button"), "f-01: a guarantee row shows «Alltid», no button");
    const pilotDemo = demoOf(page("no", withPilot({ mine_valg: "i_pilot", lagerpaminnelse: "i_pilot" }), ON).content);
    ok(/<h3 id="fp-h-demo">Prøv «Mine valg» <span class="fp-badge">I pilot<\/span><\/h3>/.test(pilotDemo), "f-02: «Mine valg» i_pilot → the «I pilot» badge on the demo heading");
    ok(rowOf(pilotDemo, "products.stock_check").includes('<span class="fp-badge">I pilot</span>'), "f-03: stock-check reminder i_pilot → «I pilot» on its row");
    ok(!demoNo.includes("fp-badge"), "f-04: everything for_alle → no «I pilot» badge in the demo");

    // ── g: mobile / keyboard ─────────────────────────────────────────────
    const css = fp.FOR_PRODUSENTER_DEMO_CSS;
    ok(!/(?:^|[^-])width:\s*\d{3,}px/.test(css), "g-00: demo CSS: no fixed pixel widths ≥100px (no horizontal scroll at 375px)");
    ok(/\.fp-demo-item \{[^}]*flex-wrap: wrap/.test(css) && /\.fp-demo-ctl \{[^}]*flex-wrap: wrap/.test(css) && /\.fp-demo-text \{[^}]*min-width: 0/.test(css), "g-01: demo rows and controls wrap");
    const toggles = [...demoNo.matchAll(/<button [^>]*data-demo-toggle[^>]*>/g)].map((m) => m[0]);
    ok(toggles.length > 0 && toggles.every((b) => /aria-pressed="(true|false)"/.test(b) && /aria-describedby="fp-demo-l-[a-z0-9-]+"/.test(b)), "g-02: toggles are buttons with aria-pressed, described by their label");
    for (const b of toggles) {
      const id = (b.match(/aria-describedby="([^"]+)"/) || ["", ""])[1];
      ok(demoNo.includes(`<strong id="${id}">`), `g-03: ${id} names a row label`);
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbForProdusenterDemoTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) { for (const f of r.failures) console.info("  - " + f); process.exit(1); }
    process.exit(0);
  });
}
