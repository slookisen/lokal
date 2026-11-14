/**
 * rfb-for-produsenter-innlenker.test.ts — «For produsenter» F3, inbound links
 * (A2A dev-request 2026-10-22-rfb-for-produsenter-faq-side, AC7).
 *
 * Proves, for NO and EN:
 *   Flag on (FOR_PRODUSENTER_PAGE_ENABLED=1):
 *     - /teknologi ends with the «Er du produsent?» / «Are you a producer?» box
 *       linking to /for-produsenter (EN /en/for-produsenter), and nothing else
 *       on the page moved (flag-on page minus the box == flag-off page);
 *     - the «Eier denne butikken?» banner on an unclaimed /produsent/<slug>
 *       links to /for-produsenter#eierskap (EN /en/for-produsenter#eierskap),
 *       and the claim button is still there, unchanged;
 *     - the #synlighet section on /for-produsenter links to /teknologi
 *       (EN /en/teknologi).
 *   Flag off: /teknologi has no box and no /for-produsenter link; the banner
 *     has no #eierskap link.
 *
 * Calls the GET handlers directly, no HTTP; RFB DB in memory (swapped in and
 * restored). Restores FOR_PRODUSENTER_PAGE_ENABLED in finally.
 * Standalone: npx tsx src/routes/rfb-for-produsenter-innlenker.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type Lang = "no" | "en";

function findGet(router: any, p: string): Function {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const rp = l.route.path;
    return Array.isArray(rp) ? rp.includes(p) : rp === p;
  });
  if (!layer) throw new Error(`route not found: GET ${p}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler: Function, o: { lang: Lang; path: string; params?: Record<string, string> }): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let status = 200;
    let settled = false;
    const settle = (b: unknown) => { if (!settled) { settled = true; resolve({ status, body: typeof b === "string" ? b : JSON.stringify(b ?? "") }); } };
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    const req: any = {
      method: "GET", url: o.path, path: o.path, originalUrl: o.path,
      params: o.params || {}, body: {}, query: {}, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang, protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(c: number) { status = c; return res; },
      json(p: unknown) { settle(p); return res; },
      send(p: unknown) { settle(p); return res; },
      redirect(c: number) { status = c; settle(""); return res; },
      end() { settle(""); return res; },
      header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; }, setHeader() { return res; },
    };
    try {
      const r = handler(req, res, () => settle("__next__"));
      if (r && typeof r.catch === "function") r.catch((e: any) => settle(`__error__ ${String(e)}`));
    } catch (e) {
      settle(`__error__ ${String(e)}`);
    }
  });
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

function claimHero(html: string): string {
  return (html.match(/<div class="claim-hero">[\s\S]*?<\/div>\s*<a [^>]*class="claim-hero-btn"[^>]*>[^<]*<\/a>\s*<\/div>/) || [""])[0];
}

/** /teknologi page body: from the hero to the footer (the header/footer carry other flag-driven links). */
function mainOf(html: string): string {
  const i = html.indexOf('<section class="tech-hero">');
  const j = html.indexOf("<footer", i);
  return i < 0 || j < 0 ? "" : html.slice(i, j);
}

function synlighetSection(html: string): string {
  const i = html.indexOf('id="synlighet"');
  if (i < 0) return "";
  const j = html.indexOf('id="eierskap"', i);
  return j < 0 ? html.slice(i) : html.slice(i, j);
}

export async function runRfbForProdusenterInnlenkerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const FLAG = "FOR_PRODUSENTER_PAGE_ENABLED";
  const prevFlag = process.env[FLAG];
  const setFlag = (v: string | undefined) => { if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v; };

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded elsewhere */ }
    } catch { /* routes fall back to defaults */ }
    const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    const clearRegistryCaches = () => {
      marketplaceRegistry._agentsCache = null;
      marketplaceRegistry._statsCache = null;
      marketplaceRegistry._agentsCacheTime = 0;
      marketplaceRegistry._statsCacheTime = 0;
    };
    const seo = require("./seo") as typeof import("./seo");
    const seoRouter = (seo as any).default;
    const { slugify } = require("../utils/slug") as typeof import("../utils/slug");

    // One unclaimed producer (no claimed_at, no verified claim) → banner shown.
    const P_ID = "f3-innlenker-p1";
    const P_NAME = "Innlenkergården";
    db.prepare(
      `INSERT INTO agents
         (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
          categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden)
       VALUES (?, ?, 'Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0)`,
    ).run(P_ID, P_NAME, `post@${P_ID}.example.no`, `https://${P_ID}.example.no`, `key-${P_ID}`);
    db.prepare(
      `INSERT INTO agent_knowledge
         (agent_id, email, website, phone, about, products, verification_status, enrichment_status, last_verified_at)
       VALUES (?, ?, ?, '+47 912 34 567', 'Vi er en liten familiegård som dyrker poteter.', ?, 'verified', 'rich', '2026-01-01T00:00:00.000Z')`,
    ).run(P_ID, `post@${P_ID}.example.no`, `https://${P_ID}.example.no`, JSON.stringify([{ name: "Listepoteter", category: "vegetables" }]));

    const H = {
      tek: findGet(seoRouter, "/teknologi"),
      fp: findGet(seoRouter, "/for-produsenter"),
      prof: findGet(seoRouter, "/produsent/:slug"),
    };
    const tek = async (lang: Lang) => (await invoke(H.tek, { lang, path: "/teknologi" })).body;
    const fp = async (lang: Lang) => invoke(H.fp, { lang, path: "/for-produsenter" });
    const prof = async (lang: Lang) => { clearRegistryCaches(); return (await invoke(H.prof, { lang, path: `/produsent/${slugify(P_NAME)}`, params: { slug: slugify(P_NAME) } })).body; };

    const T = {
      no: { fp: "/for-produsenter", tech: "/teknologi", heading: "Er du produsent?", link: "Les hvordan Rett fra Bonden fungerer for produsenter", more: "Les hvordan det fungerer", btn: ">Ta eierskap her</a>", banner: "Eier denne butikken?" },
      en: { fp: "/en/for-produsenter", tech: "/en/teknologi", heading: "Are you a producer?", link: "Read how Rett fra Bonden works for producers", more: "Read how it works", btn: ">Take ownership here</a>", banner: "Do you own this shop?" },
    } as const;

    for (const lang of ["no", "en"] as const) {
      const L = T[lang];

      // ── flag off ───────────────────────────────────────────────────────
      setFlag(undefined);
      const tekOff = await tek(lang);
      assertTrue(tekOff.includes("tech-hero"), `${lang} setup: /teknologi renders`);
      assertTrue(!tekOff.includes(L.heading) && !tekOff.includes(L.link), `${lang} flag off: /teknologi has no producer box`);
      assertTrue(!tekOff.includes(`href="${L.fp}"`), `${lang} flag off: /teknologi has no link to ${L.fp}`);
      assertTrue(seo.renderTeknologiProducerBox(lang) === "" && seo.claimHeroHowItWorksLink(lang) === "", `${lang} flag off: helpers return ""`);
      const profOff = await prof(lang);
      const heroOff = claimHero(profOff);
      assertTrue(heroOff.includes(L.banner), `${lang} setup: unclaimed profile shows the «${L.banner}» banner`);
      assertTrue(!heroOff.includes("#eierskap") && !profOff.includes(`${L.fp}#eierskap`), `${lang} flag off: banner has no #eierskap link`);
      assertTrue(!heroOff.includes("claim-hero-more"), `${lang} flag off: banner has no extra link line`);

      // ── flag on ────────────────────────────────────────────────────────
      setFlag("1");
      const tekOn = await tek(lang);
      const box = seo.renderTeknologiProducerBox(lang);
      assertTrue(box.length > 0 && count(tekOn, box) === 1, `${lang} flag on: /teknologi contains the producer box once`);
      assertTrue(box.includes(`<h3>${L.heading}</h3>`), `${lang} flag on: box heading «${L.heading}»`);
      assertTrue(box.includes(`<a href="${L.fp}">${L.link}</a>`), `${lang} flag on: box links to ${L.fp} with «${L.link}»`);
      assertTrue(count(box, "<a ") === 1, `${lang} flag on: box has exactly one link`);
      // Header/footer links follow the same flag elsewhere (F2b, front-page FAQ), so compare the page body only.
      assertTrue(mainOf(tekOn.replace(box, () => "")) === mainOf(tekOff) && mainOf(tekOff).length > 0, `${lang} flag on: /teknologi body minus the box is byte-identical to flag off`);

      const profOn = await prof(lang);
      const heroOn = claimHero(profOn);
      assertTrue(heroOn.includes(`<a href="${L.fp}#eierskap">${L.more}</a>`), `${lang} flag on: banner links to ${L.fp}#eierskap with «${L.more}»`);
      assertTrue(heroOn.includes(`class="claim-hero-btn">${L.btn.slice(1)}`) && heroOn.includes(`/selger?agent=${encodeURIComponent(P_ID)}`), `${lang} flag on: claim button unchanged`);
      assertTrue(heroOn.replace(seo.claimHeroHowItWorksLink(lang), () => "") === heroOff, `${lang} flag on: banner minus the new line is byte-identical to flag off`);

      const page = await fp(lang);
      assertTrue(page.status === 200, `${lang} flag on: /for-produsenter renders`);
      const syn = synlighetSection(page.body);
      assertTrue(syn.length > 0 && syn.includes(`href="${L.tech}"`), `${lang} flag on: #synlighet links to ${L.tech}`);
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    setFlag(prevFlag);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbForProdusenterInnlenkerTests({ log: true }).then((r) => {
    console.info(`\nrfb-for-produsenter-innlenker: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
