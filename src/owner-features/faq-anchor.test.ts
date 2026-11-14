/**
 * faq-anchor.test.ts — «Les mer» from RFB «Mine valg» to /for-produsenter
 * (A2A dev-request 2026-10-22-rfb-for-produsenter-faq-side, slice F2c-1, AC6).
 *
 *   a-*  every RFB registry entry with consent or confirmOn/confirmOff has a
 *        faqAnchor; gårdssalg entries have none (their FAQ is different).
 *   b-*  every faqAnchor is a section id actually rendered on /for-produsenter
 *        (NO and EN, page rendered with FOR_PRODUSENTER_PAGE_ENABLED on), and
 *        the rendered sections are exactly FOR_PRODUSENTER_ANCHORS.
 *   c-*  flag on → the RFB «Mine valg» row links «Les mer» to
 *        /for-produsenter#<faqAnchor> (same tab); flag off → no link and the
 *        page is byte-identical to a render without any faqAnchor; the
 *        gårdssalg «Mine valg» page → no link.
 *
 * The env flag and the DB swap are restored in `finally`. Standalone:
 * npx tsx src/owner-features/faq-anchor.test.ts — wired into tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "FOR_PRODUSENTER_PAGE_ENABLED";

export async function runFaqAnchorTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const log = opts.log !== false;
  const ok = (cond: boolean, name: string) => {
    if (cond) { passed++; if (log) console.info(`  ✓ ${name}`); }
    else { failed++; failures.push(name); if (log) console.info(`  ✗ ${name}`); }
  };

  const prevFlag = process.env[FLAG];
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  try {
    const reg = require("./registry") as typeof import("./registry");
    const anchors = require("../routes/rfb-for-produsenter-anchors") as typeof import("../routes/rfb-for-produsenter-anchors");
    const fp = require("../routes/rfb-for-produsenter") as typeof import("../routes/rfb-for-produsenter");

    // ── a: consent / confirm entries shown on RFB carry a faqAnchor ─────────
    const needs = (e: import("./registry").OwnerFeatureEntry) => e.consent === true || !!e.confirmOn || !!e.confirmOff;
    const rfbEntries = reg.OWNER_FEATURE_REGISTRY.filter((e) => e.verticals.includes("rfb"));
    const needing = rfbEntries.filter(needs);
    ok(needing.length > 0, "a-00: the RFB registry has consent/confirm entries to check");
    for (const e of needing) ok(!!e.faqAnchor, `a-01: ${e.key} (consent/confirm, RFB) has a faqAnchor`);
    for (const e of reg.GARDSSALG_OWNER_FEATURE_REGISTRY) ok(!e.faqAnchor, `a-02: gårdssalg ${e.key} has no faqAnchor (RFB FAQ only)`);

    // ── b: every faqAnchor is a rendered section id (flag on, NO + EN) ──────
    process.env[FLAG] = "1";
    ok(fp.isForProdusenterPageEnabled(), "b-00: flag on for the render");
    ok(fp.FOR_PRODUSENTER_ANCHORS === anchors.FOR_PRODUSENTER_ANCHORS && fp.FOR_PRODUSENTER_PATH === anchors.FOR_PRODUSENTER_PATH,
      "b-01: the route re-exports the shared anchors and path");
    const pages = {
      no: fp.renderForProdusenterPage("no", "https://x/for-produsenter").content,
      en: fp.renderForProdusenterPage("en", "https://x/en/for-produsenter").content,
    };
    for (const [lang, html] of Object.entries(pages)) {
      const ids = [...html.matchAll(/<section class="fp-sec" id="([^"]+)"/g)].map((m) => m[1]);
      ok(JSON.stringify(ids) === JSON.stringify([...anchors.FOR_PRODUSENTER_ANCHORS]), `b-02: ${lang}: rendered sections are exactly FOR_PRODUSENTER_ANCHORS, in order`);
      for (const e of reg.OWNER_FEATURE_REGISTRY.filter((x) => x.faqAnchor)) {
        ok(html.includes(`id="${e.faqAnchor}"`), `b-03: ${lang}: ${e.key} faqAnchor «${e.faqAnchor}» is an id on /for-produsenter`);
      }
    }

    // ── c: the «Les mer» link on «Mine valg» ────────────────────────────────
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const pg = require("./page") as typeof import("./page");
    const rs = require("./resolve") as typeof import("./resolve");
    const rfbModel = (registry?: import("./registry").OwnerFeatureEntry[]) => ({
      agent: { id: "faq-ag", name: "Gård FAQ" }, resolved: rs.resolveOwnerFeatures("rfb", "faq-ag", { db }), level: null, showIntro: false,
      notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
      ...(registry ? { registry } : {}),
    });
    const rowOf = (html: string, key: string) => {
      const i = html.indexOf(`<li class="mv-item" id="valg-${key}"`);
      return i < 0 ? "" : html.slice(i, html.indexOf("</li>", i));
    };
    const KEY = "visibility.profile";
    const entry = reg.OWNER_FEATURE_REGISTRY.find((e) => e.key === KEY)!;
    ok(entry?.faqAnchor === "personvern", "c-00: visibility.profile → #personvern");

    const on = pg.renderOwnerFeaturesPageBody(rfbModel() as any);
    const onRow = rowOf(on, KEY);
    ok(onRow.length > 0, "c-01: flag on: the visibility.profile row renders on the RFB page");
    ok(onRow.includes(`<a href="/for-produsenter#personvern" data-faq-anchor="personvern">Les mer</a>`), "c-02: flag on: the row links «Les mer» → /for-produsenter#personvern");
    ok(!/target=/.test(onRow.slice(onRow.indexOf("data-faq-anchor"))), "c-03: the link opens in the same tab (no target)");
    const links = [...on.matchAll(/<a href="\/for-produsenter#([^"]+)" data-faq-anchor="([^"]+)">Les mer<\/a>/g)];
    ok(links.length > 0 && links.every((m) => m[1] === m[2] && (anchors.FOR_PRODUSENTER_ANCHORS as readonly string[]).includes(m[1])),
      "c-04: flag on: every «Les mer» link points at a real section");
    ok(pg.ownerFaqReadMoreHtml({}, entry, "en") === `<p class="mv-desc"><a href="/en/for-produsenter#personvern" data-faq-anchor="personvern">Read more</a></p>`,
      "c-05: EN: «Read more» → /en/for-produsenter#personvern");

    delete process.env[FLAG];
    const off = pg.renderOwnerFeaturesPageBody(rfbModel() as any);
    ok(!off.includes("data-faq-anchor") && !off.includes("/for-produsenter"), "c-06: flag off: no «Les mer» link to /for-produsenter");
    const stripped = reg.OWNER_FEATURE_REGISTRY.map((e) => { const { faqAnchor: _drop, ...rest } = e; return rest as typeof e; });
    ok(off === pg.renderOwnerFeaturesPageBody(rfbModel(stripped) as any), "c-07: flag off: the page is byte-identical to a render without faqAnchor");

    process.env[FLAG] = "1";
    const gsModel = {
      // Resolved against the in-memory RFB DB with the gårdssalg catalog (the
      // page only reads byKey), so no experiences.db is opened.
      agent: { id: "faq-gs", name: "Gårdssalg FAQ" }, resolved: rs.resolveOwnerFeatures("rfb", "faq-gs", { db, registry: reg.GARDSSALG_OWNER_FEATURE_REGISTRY }), level: null, showIntro: false,
      notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
      registry: reg.GARDSSALG_OWNER_FEATURE_REGISTRY,
      variant: {
        vertical: "gardssalg" as const, platformName: "Opplevagent", csEmail: "kontakt@opplevagent.no",
        pagePath: (tail: string) => `/kategori/gardssalg/eier/faq-gs/valg${tail}`, backHref: "/kategori/gardssalg/eier/faq-gs",
        groups: reg.GARDSSALG_OWNER_FEATURE_GROUPS, levels: (require("./changes") as typeof import("./changes")).GARDSSALG_OWNER_LEVELS,
        statusKeys: ["visibility.profile", "booking.enabled", "booking.pause"], revealKey: "booking.enabled", pauseResumeDate: false,
      },
    };
    const gs = pg.renderOwnerFeaturesPageBody(gsModel as any);
    ok(rowOf(gs, KEY).length > 0, "c-08: the gårdssalg page renders its visibility.profile row");
    ok(!gs.includes("data-faq-anchor") && !gs.includes("/for-produsenter"), "c-09: flag on: gårdssalg «Mine valg» has no «Les mer» to /for-produsenter");
    const gsWithRfbCatalog = pg.renderOwnerFeaturesPageBody({ ...gsModel, resolved: rs.resolveOwnerFeatures("rfb", "faq-gs", { db }), registry: reg.OWNER_FEATURE_REGISTRY } as any);
    ok(rowOf(gsWithRfbCatalog, KEY).length > 0 && !gsWithRfbCatalog.includes("data-faq-anchor"), "c-10: gårdssalg variant: no link even for RFB entries with faqAnchor");
    ok(pg.ownerFaqReadMoreHtml({}, { ...entry, faqAnchor: undefined }) === "", "c-11: no faqAnchor → no link");
  } finally {
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runFaqAnchorTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed) { for (const f of r.failures) console.info("  - " + f); process.exit(1); }
  });
}
