/**
 * experiences-seo-en-translation-gate.test.ts — dev-request
 * 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E3-S1: no translated
 * body text while OPPLEVAGENT_LANG_SWITCHER_ENABLED is off.
 *
 * With the switcher off, /en/opplevelse/<slug> and
 * /en/kategori/gardssalg/produsent/<slug> render lang="nb" with the NO
 * canonical (K16). Before E3-S1 both pages still fetched the published EN
 * translations and swapped them into the body, so English text sat under
 * lang="nb". Now the translations are fetched only with the switcher on, so EN
 * stays hidden throughout until Daniel flips it.
 *
 * Covers, with PROFILE_TRANSLATIONS_SERVE_ENABLED="true" and a published EN
 * title/description/meeting_point (experience) and about_text (producer):
 *   (a) switcher off, req.lang "en": Norwegian description, meeting point and
 *       about text; the H1 is the untranslated title (tnr-4d's rule: on /en
 *       the H1 is never title_no); <html lang="nb">; NO canonical; no
 *       hreflang. No English text anywhere in the page.
 *   (b) switcher on, req.lang "en": the translated text, lang="en", the /en
 *       canonical — the translations still flow once the switch is flipped.
 *   (c) switcher on, serve flag off: Norwegian text (serve flag still gates).
 *   (d) req.lang "no" is unchanged either way.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-en-translation-gate.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callHtmlRoute(router: any, url: string, lang: "no" | "en"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: {},
      headers: {},
      // i18n/middleware.ts strips "/en" and sets req.lang before the router
      // runs; set directly here, as the sibling route tests do.
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() {},
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

const NO = {
  title: "Kajakktur i Lysefjorden",
  description: "Guidet kajakktur i Lysefjorden med erfarne guider og alt utstyr inkludert.",
  meeting: "Oppmøte ved kaia i Forsand",
  about: "Vi lager eplemost og sider av egne epler på gården i Hardanger.",
};
const EN = {
  title: "Kayak tour on the Lysefjord",
  description: "Guided kayak tour on the Lysefjord with experienced guides and all equipment included.",
  meeting: "Meet at the pier in Forsand",
  about: "We make apple juice and cider from our own apples on the farm in Hardanger.",
};

export function runExperiencesSeoEnTranslationGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevSwitcher = process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    const prevServe = process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
    process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = "true";

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;

      const provId = expStore.createProvider({
        navn: "Lysefjorden Padling AS", org_nr: "912345670",
        fylke: "Rogaland", kommune: "Strand", hjemmeside: "https://padling.example.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expId = expStore.createExperience({
        title: NO.title, provider_id: provId, provider_match_status: "matched",
        category: "natur_friluft", fylke: "Rogaland", kommune: "Strand", indoor_outdoor: "outdoor",
        description: NO.description, meeting_point: NO.meeting,
        confidence: "high", verification_status: "verified",
      });
      const slug = (expStore.getExperienceById(expId) as any).slug as string;
      db.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, fylke, kommune, poststed, producer_type, slug, about_text,
           enrichment_state, verification_status, source, confidence)
         VALUES ('e3-cider', 'Hardanger Sideri', 'experiences', 'Vestland', 'Ullensvang', 'Lofthus', 'cideri', 'hardanger-sideri', @about,
           'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run({ about: NO.about });

      // Published EN translations — the shape getPublishedProfileTranslations() serves.
      const insTr = db.prepare(
        `INSERT INTO profile_translations (platform, entity_type, entity_id, field, lang, source_text, source_hash, translated_text, status, published_at)
         VALUES ('opplevagent', @type, @id, @field, 'en', @src, 'h', @text, 'published', datetime('now'))`,
      );
      insTr.run({ type: "experience", id: expId, field: "title", src: NO.title, text: EN.title });
      insTr.run({ type: "experience", id: expId, field: "description", src: NO.description, text: EN.description });
      insTr.run({ type: "experience", id: expId, field: "meeting_point", src: NO.meeting, text: EN.meeting });
      insTr.run({ type: "provider", id: "e3-cider", field: "about_text", src: NO.about, text: EN.about });

      const router = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const detailPath = `/opplevelse/${slug}`;
      const producerPath = "/kategori/gardssalg/produsent/hardanger-sideri";

      // ── (a) switcher off, /en: everything Norwegian, nothing English ───────
      {
        const r = await callHtmlRoute(router, detailPath, "en");
        assertTrue(r.handled && r.status === 200, `e3-a1: /en${detailPath} renders 200 with the switcher off (got ${r.status})`);
        assertTrue(r.body.includes('<html lang="nb">'), "e3-a2: detail is lang=\"nb\"");
        assertTrue(r.body.includes(`<link rel="canonical" href="https://opplevagent.no${detailPath}">`), "e3-a3: detail canonical is the NO path");
        assertTrue(!r.body.includes("hreflang="), "e3-a4: detail has no hreflang links");
        assertTrue(r.body.includes(`<p class="lede">${NO.description}</p>`), "e3-a5: detail shows the Norwegian description");
        assertTrue(r.body.includes(`<h1>${NO.title}</h1>`), "e3-a6: detail H1 is the untranslated title");
        assertTrue(r.body.includes(NO.meeting), "e3-a7: detail shows the Norwegian meeting point");
        for (const [field, text] of Object.entries({ title: EN.title, description: EN.description, meeting_point: EN.meeting })) {
          assertTrue(!r.body.includes(text), `e3-a8: no translated ${field} anywhere on the lang="nb" detail page`);
        }
      }
      {
        const r = await callHtmlRoute(router, producerPath, "en");
        assertTrue(r.handled && r.status === 200, `e3-a9: /en${producerPath} renders 200 with the switcher off (got ${r.status})`);
        assertTrue(r.body.includes('<html lang="nb">'), "e3-a10: producer profile is lang=\"nb\"");
        assertTrue(r.body.includes(`<link rel="canonical" href="https://opplevagent.no${producerPath}">`), "e3-a11: producer canonical is the NO path");
        assertTrue(r.body.includes(`<p>${NO.about}</p>`), "e3-a12: producer profile shows the Norwegian about text");
        assertTrue(!r.body.includes(EN.about), "e3-a13: no translated about text on the lang=\"nb\" producer profile");
      }

      // ── (b) switcher on, /en: the translations flow ───────────────────────
      process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = "true";
      {
        const r = await callHtmlRoute(router, detailPath, "en");
        assertTrue(r.body.includes('<html lang="en">'), "e3-b1: switcher on → detail is lang=\"en\"");
        assertTrue(r.body.includes(`<link rel="canonical" href="https://opplevagent.no/en${detailPath}">`), "e3-b2: switcher on → /en canonical");
        assertTrue(r.body.includes(`<p class="lede">${EN.description}</p>`), "e3-b3: switcher on → translated description");
        assertTrue(r.body.includes(`<h1>${EN.title}</h1>`), "e3-b4: switcher on → translated H1");
        assertTrue(r.body.includes(EN.meeting), "e3-b5: switcher on → translated meeting point");
      }
      {
        const r = await callHtmlRoute(router, producerPath, "en");
        assertTrue(r.body.includes('<html lang="en">') && r.body.includes(`<p>${EN.about}</p>`),
          "e3-b6: switcher on → producer profile is lang=\"en\" with the translated about text");
      }

      // ── (c) switcher on, serve flag off: still Norwegian ──────────────────
      delete process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED;
      {
        const r = await callHtmlRoute(router, detailPath, "en");
        assertTrue(r.body.includes(`<p class="lede">${NO.description}</p>`) && !r.body.includes(EN.description),
          "e3-c1: serve flag off → no translated description even with the switcher on");
        const p = await callHtmlRoute(router, producerPath, "en");
        assertTrue(p.body.includes(`<p>${NO.about}</p>`) && !p.body.includes(EN.about),
          "e3-c2: serve flag off → no translated about text even with the switcher on");
      }
      process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = "true";

      // ── (d) /no is unchanged, switcher on or off ──────────────────────────
      for (const switcher of ["true", undefined]) {
        if (switcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED;
        else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = switcher;
        const r = await callHtmlRoute(router, detailPath, "no");
        assertTrue(r.body.includes('<html lang="nb">') && r.body.includes(`<p class="lede">${NO.description}</p>`) && !r.body.includes(EN.description),
          `e3-d1: /no detail is Norwegian (switcher ${switcher ?? "off"})`);
        const p = await callHtmlRoute(router, producerPath, "no");
        assertTrue(p.body.includes(`<p>${NO.about}</p>`) && !p.body.includes(EN.about),
          `e3-d2: /no producer profile is Norwegian (switcher ${switcher ?? "off"})`);
      }

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevSwitcher === undefined) delete process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED; else process.env.OPPLEVAGENT_LANG_SWITCHER_ENABLED = prevSwitcher;
      if (prevServe === undefined) delete process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED; else process.env.PROFILE_TRANSLATIONS_SERVE_ENABLED = prevServe;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoEnTranslationGateTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
