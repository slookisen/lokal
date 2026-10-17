/**
 * experiences-seo-produktby-gate.test.ts — dev-request
 * 2026-10-16-opplevagent-stedssider-kvalitet, E4-S1: one configurable combo
 * gate (isProduktByCellIndexable() in services/experience-indexability.ts)
 * decides whether /kategori/:category/:kommune is served, whether it is in
 * sitemap.xml and whether /kommune/:kommune links it.
 *
 * Covers:
 *   (a) the predicate: PRODUKT_BY_MIN_EXPERIENCES is 2; the env override
 *       OPPLEVAGENT_COMBO_MIN_EXPERIENCES takes a whole number ≥ 1 and falls
 *       back to the default otherwise, read per call; the ≥2-real-facts rule
 *       still applies at every threshold (a stated price ≥ 0 is a fact, a
 *       negative one is not); a cell the gate lets through always gets the
 *       produkt×by FAQ and answer-first opening, a cell below 2 facts never.
 *   (b) default threshold (2): the sitemap lists exactly the cells with ≥2
 *       experiences (AC1) and every listed combo page shows ≥2 experiences
 *       (AC2); a former single-experience cell answers 301 to /kommune/<k>
 *       with a short Cache-Control, and that page lists the experience (AC3);
 *       ≥2 experiences without a second fact also 301; an empty cell stays
 *       404; /kommune/<k> links exactly the cells that pass, largest first,
 *       and a kommune with none renders no category chips (AC4).
 *   (c) thresholds 1, 2 and 3 (plus invalid env values = default): route and
 *       sitemap agree on every candidate cell — listed ⇔ 200, not listed ⇔
 *       301 to /kommune — and the /kommune chips link exactly the listed
 *       cells, each of which answers 200. Threshold 1 is the pre-E4-S1
 *       behaviour (the fact rule alone).
 *   (d) the rest of the sitemap is untouched: category, fylke and kommune
 *       pages stay listed at every threshold.
 *   (e) one predicate: experiences-seo.ts calls isProduktByCellIndexable()
 *       from the route, the sitemap and the chips, and the sitemap's inline
 *       copy of the fact rule is gone.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-produktby-gate.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type RouteResult = {
  handled: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
  location: string | null;
};

// Same synthetic router.handle() shortcut as experiences-seo-indexability.test.ts,
// plus the redirect target.
function callHtmlRoute(router: any, url: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: "", headers, location: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body), headers, location: null }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "", headers, location: null });
    });
  });
}

/** "<category>/<kommune>" for every combo page listed in a sitemap body
 *  (gårdssalg type pages share the URL shape and are left out). */
function sitemapCombos(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>[^<]*\/kategori\/([^/<]+)\/([^/<]+)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const cat = decodeURIComponent(m[1]);
    if (cat === "gardssalg") continue;
    out.push(`${cat}/${decodeURIComponent(m[2])}`);
  }
  return out.sort();
}

/** "<category>/<kommune>" for every combo page an HTML page links to, in
 *  page order. */
function linkedCombos(html: string): string[] {
  const out: string[] = [];
  const re = /href="\/kategori\/([^"/]+)\/([^"/]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cat = decodeURIComponent(m[1]);
    if (cat === "gardssalg") continue;
    out.push(`${cat}/${decodeURIComponent(m[2])}`);
  }
  return out;
}

function comboUrl(combo: string): string {
  const [cat, kommune] = combo.split("/");
  return `/kategori/${encodeURIComponent(cat)}/${encodeURIComponent(kommune)}`;
}

function kommuneUrl(kommune: string): string {
  return `/kommune/${encodeURIComponent(kommune)}`;
}

function cardCount(html: string): number {
  return (html.match(/class="card card-cat"/g) || []).length;
}

const sameSet = (a: string[], b: string[]): boolean =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function runExperiencesSeoProduktByGateTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  const ENV = "OPPLEVAGENT_COMBO_MIN_EXPERIENCES";
  const setThreshold = (value: string | undefined): void => {
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
  };

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevThreshold = process.env[ENV];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env[ENV];

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      // ── (a) the predicate ──────────────────────────────────────────────────
      const ix = require("../services/experience-indexability") as typeof import("../services/experience-indexability");
      assertTrue(ix.PRODUKT_BY_MIN_EXPERIENCES === 2, "pb-a1: PRODUKT_BY_MIN_EXPERIENCES defaults to 2");
      const envCases: Array<[string | undefined, number]> = [
        [undefined, 2], ["", 2], ["1", 1], ["3", 3], [" 3 ", 3], ["10", 10],
        ["0", 2], ["-1", 2], ["2.5", 2], ["abc", 2], ["1e1", 2], ["99999999999999999999", 2],
      ];
      for (const [value, expected] of envCases) {
        setThreshold(value);
        assertTrue(ix.produktByMinExperiences() === expected,
          `pb-a2: ${ENV}=${JSON.stringify(value)} → threshold ${expected} (got ${ix.produktByMinExperiences()})`);
      }
      setThreshold(undefined);

      // Every experience indexable here; a cell with placeholders is covered
      // by experiences-seo-indeks-tekst.test.ts (IDX-1).
      const one = { total: 1, indexableTotal: 1, providerCount: 1, minPriceFrom: null };
      const two = { total: 2, indexableTotal: 2, providerCount: 2, minPriceFrom: null };
      const three = { total: 3, indexableTotal: 3, providerCount: 1, minPriceFrom: 250 };
      const matrix: Array<[string | undefined, [boolean, boolean, boolean]]> = [
        ["1", [true, true, true]],
        [undefined, [false, true, true]],
        ["3", [false, false, true]],
      ];
      for (const [value, [e1, e2, e3]] of matrix) {
        setThreshold(value);
        const t = ix.produktByMinExperiences();
        assertTrue(ix.isProduktByCellIndexable(one) === e1, `pb-a3: threshold ${t}: 1 experience + 1 provider → ${e1 ? "indexable" : "not indexable"}`);
        assertTrue(ix.isProduktByCellIndexable(two) === e2, `pb-a3: threshold ${t}: 2 experiences + 2 providers → ${e2 ? "indexable" : "not indexable"}`);
        assertTrue(ix.isProduktByCellIndexable(three) === e3, `pb-a3: threshold ${t}: 3 experiences + provider + price → ${e3 ? "indexable" : "not indexable"}`);
      }
      // Read per call: the same process flips with the env, no restart.
      setThreshold("3");
      const beforeFlip = ix.isProduktByCellIndexable(two);
      setThreshold(undefined);
      assertTrue(beforeFlip === false && ix.isProduktByCellIndexable(two) === true,
        "pb-a4: the threshold is read per call (3 → not indexable, unset → indexable, same process)");
      // The fact rule applies at every threshold.
      for (const value of ["1", undefined, "3"]) {
        setThreshold(value);
        const t = ix.produktByMinExperiences();
        assertTrue(!ix.isProduktByCellIndexable({ total: 5, indexableTotal: 5, providerCount: 0, minPriceFrom: null }),
          `pb-a5: threshold ${t}: 5 experiences with no provider and no price (1 fact) → not indexable`);
        assertTrue(!ix.isProduktByCellIndexable({ total: 0, indexableTotal: 0, providerCount: 1, minPriceFrom: 100 }),
          `pb-a6: threshold ${t}: an empty cell is never indexable`);
      }
      setThreshold(undefined);
      assertTrue(ix.isProduktByCellIndexable({ total: 2, indexableTotal: 2, providerCount: 0, minPriceFrom: 0 }),
        "pb-a7: a stated price of 0 kr is a real fact (2 experiences + price 0 → indexable)");
      assertTrue(!ix.isProduktByCellIndexable({ total: 2, indexableTotal: 2, providerCount: 0, minPriceFrom: -1 }),
        "pb-a8: a negative price is not a fact, as in the FAQ builders (2 experiences + price -1 → not indexable)");
      assertTrue(ix.countProduktByRealFacts({ total: 2, providerCount: 1, minPriceFrom: 0 }) === 3
        && ix.countProduktByRealFacts({ total: 0, providerCount: 0, minPriceFrom: null }) === 0
        && ix.countProduktByRealFacts({ total: 1, providerCount: 0, minPriceFrom: -5 }) === 1,
        "pb-a9: countProduktByRealFacts counts experiences, providers and a price ≥ 0");

      // ── fixtures ───────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = seo.default as any;

      // No drift with the produkt×by FAQ builders: the fact count is theirs
      // (≥2 facts ⇔ FAQ and answer-first opening exist), so every cell the
      // gate lets through gets both, at the loosest threshold too.
      {
        setThreshold("1");
        let checked = 0;
        let factDrift = 0;
        let gateDrift = 0;
        for (const total of [0, 1, 2, 4]) {
          for (const providerCount of [0, 1, 2]) {
            for (const minPriceFrom of [null, -1, 0, 300]) {
              const stats = { total, providerCount, minPriceFrom };
              const params = { categoryLabel: "Natur & friluft", kommune: "Bergen", fylke: "Vestland", ...stats };
              const faq = seo.buildProduktByFaqJsonLd({ ...params, url: "https://opplevagent.no/kategori/natur_friluft/Bergen" });
              const opening = seo.buildProduktByAnswerFirstOpening(params);
              checked++;
              const builders = faq !== null && opening !== null;
              const neither = faq === null && opening === null;
              if (ix.countProduktByRealFacts(stats) >= 2 ? !builders : !neither) factDrift++;
              if (ix.isProduktByCellIndexable({ ...stats, indexableTotal: total }) && !builders) gateDrift++;
            }
          }
        }
        setThreshold(undefined);
        assertTrue(checked === 48 && factDrift === 0,
          `pb-a10: countProduktByRealFacts() ≥ 2 exactly when the FAQ and answer-first builders return content (${checked} combinations, drift in ${factDrift})`);
        assertTrue(gateDrift === 0,
          `pb-a11: every cell the gate lets through gets an FAQ and an answer-first opening (drift in ${gateDrift})`);
      }

      const mkProvider = (navn: string, fylke: string, kommune: string): string =>
        expStore.createProvider({
          navn, fylke, kommune,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
      const mkExp = (o: { title: string; category: string; fylke: string; kommune: string; providerId: string | null; price?: number }): string => {
        const id = expStore.createExperience({
          title: o.title,
          provider_id: o.providerId,
          provider_match_status: o.providerId ? "matched" : "unmatched",
          category: o.category, fylke: o.fylke, kommune: o.kommune,
          ...(o.price !== undefined ? { price_from: o.price } : {}),
          description: `${o.title} — guidet opplevelse med lokal tilbyder.`,
          confidence: "high", verification_status: "verified",
        });
        return (expStore.getExperienceById(id) as any).slug as string;
      };
      const provA = mkProvider("Bergen Fjellguide AS", "Vestland", "Bergen");
      const provB = mkProvider("Fløyen Friluft AS", "Vestland", "Bergen");
      const provC = mkProvider("Bryggen Smak AS", "Vestland", "Bergen");
      const provD = mkProvider("Tromsø Hvalsafari AS", "Troms", "Tromsø");
      // Bergen: natur_friluft 2 (2 providers), mat_drikke 3 (1 provider, a
      // price), kultur_historie 1 (1 provider — the single-experience cell).
      mkExp({ title: "Ulriken på tvers", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provA });
      mkExp({ title: "Fløyen ved solnedgang", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provB });
      mkExp({ title: "Fiskemarkedet smakstur", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provC, price: 450 });
      mkExp({ title: "Bryggen ølsmaking", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provC });
      mkExp({ title: "Lokal matkurs i Bergen", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provC });
      const singleSlug = mkExp({ title: "Byvandring på Bryggen", category: "kultur_historie", fylke: "Vestland", kommune: "Bergen", providerId: provA });
      // Tromsø: dyreliv_safari 1 (1 provider) — single cell with an ø in the kommune.
      mkExp({ title: "Hvalsafari fra Tromsø", category: "dyreliv_safari", fylke: "Troms", kommune: "Tromsø", providerId: provD });
      // Bodø: sightseeing_transport 2, no provider and no price — 1 fact only.
      mkExp({ title: "Saltstraumen rundtur", category: "sightseeing_transport", fylke: "Nordland", kommune: "Bodø", providerId: null });
      mkExp({ title: "Kystbåt til Kjerringøy", category: "sightseeing_transport", fylke: "Nordland", kommune: "Bodø", providerId: null });

      const allCombos = expStore.listProduktByCombos().map((r) => `${r.category}/${r.kommune}`).sort();
      assertTrue(sameSet(allCombos, [
        "natur_friluft/Bergen", "mat_drikke/Bergen", "kultur_historie/Bergen", "dyreliv_safari/Tromsø", "sightseeing_transport/Bodø",
      ]), `pb-fx: listProduktByCombos() returns the 5 fixture cells (got ${JSON.stringify(allCombos)})`);

      const buildSitemap = async (): Promise<string> => {
        seo.__resetExperiencesSitemapCacheForTesting();
        const r = await callHtmlRoute(router, "/sitemap.xml");
        return r.status === 200 ? r.body : "";
      };

      // ── (b) default threshold: AC1–AC4 in code ─────────────────────────────
      {
        const sm = await buildSitemap();
        const listed = sitemapCombos(sm);
        assertTrue(sameSet(listed, ["natur_friluft/Bergen", "mat_drikke/Bergen"]),
          `pb-b1 (AC1): the sitemap lists exactly the cells with ≥2 experiences and 2 facts (got ${JSON.stringify(listed)})`);
        for (const combo of listed) {
          const r = await callHtmlRoute(router, comboUrl(combo));
          assertTrue(r.handled && r.status === 200 && cardCount(r.body) >= 2,
            `pb-b2 (AC2): listed ${combo} answers 200 and shows ≥2 experiences (got ${r.status}, ${cardCount(r.body)} cards)`);
        }

        const single = await callHtmlRoute(router, comboUrl("kultur_historie/Bergen"));
        assertTrue(single.handled && single.status === 301 && single.location === "/kommune/Bergen",
          `pb-b3 (AC3): the single-experience cell kultur_historie/Bergen answers 301 to /kommune/Bergen (got ${single.status} ${single.location})`);
        assertTrue(single.headers["cache-control"] === "public, max-age=300",
          `pb-b4: the 301 carries Cache-Control: public, max-age=300, so a threshold change is not pinned in browsers (got ${JSON.stringify(single.headers["cache-control"])})`);
        const target = await callHtmlRoute(router, single.location || "");
        assertTrue(target.handled && target.status === 200 && target.body.includes(`href="/opplevelse/${singleSlug}"`),
          "pb-b5: the redirect target /kommune/Bergen answers 200 and lists the single experience");

        const tromso = await callHtmlRoute(router, comboUrl("dyreliv_safari/Tromsø"));
        assertTrue(tromso.status === 301 && tromso.location === kommuneUrl("Tromsø") && tromso.location === "/kommune/Troms%C3%B8",
          `pb-b6: a kommune with ø is URL-encoded in the redirect (got ${tromso.status} ${tromso.location})`);
        const bodo = await callHtmlRoute(router, comboUrl("sightseeing_transport/Bodø"));
        assertTrue(bodo.status === 301 && bodo.location === kommuneUrl("Bodø"),
          `pb-b7: 2 experiences with only 1 fact (no provider, no price) are below the gate too → 301 (got ${bodo.status} ${bodo.location})`);
        assertTrue(!bodo.body.includes("FAQPage") && !single.body.includes("FAQPage"), "pb-b8: a redirected cell renders no HTML");

        // next() falls through to the router's own catch-all 404 page.
        const emptyCell = await callHtmlRoute(router, comboUrl("velvaere_spa/Bergen"));
        assertTrue(emptyCell.status === 404 && emptyCell.location === null,
          `pb-b9: an empty cell in a live kommune (velvaere_spa/Bergen, total=0) stays 404, no redirect (got ${emptyCell.status} ${emptyCell.location})`);
        const unknown = await callHtmlRoute(router, comboUrl("mat_drikke/Nowhereville"));
        assertTrue(unknown.status === 404 && unknown.location === null,
          `pb-b10: an unknown kommune stays 404, no redirect (got ${unknown.status} ${unknown.location})`);

        const bergen = await callHtmlRoute(router, kommuneUrl("Bergen"));
        const bergenLinks = linkedCombos(bergen.body);
        assertTrue(bergen.status === 200 && JSON.stringify(bergenLinks) === JSON.stringify(["mat_drikke/Bergen", "natur_friluft/Bergen"]),
          `pb-b11 (AC4): /kommune/Bergen links exactly the passing combo pages, largest first (got ${JSON.stringify(bergenLinks)})`);
        assertTrue(!bergenLinks.includes("kultur_historie/Bergen"), "pb-b12: /kommune/Bergen does not link the cell below the gate");
        assertTrue(bergen.body.includes('<div class="chips" role="list" aria-label="Kategorier i Bergen">'),
          "pb-b13: the links are a labelled chip row");
        assertTrue(bergen.body.includes('href="/kategori/mat_drikke/Bergen"><span class="chip-dot"')
          && bergen.body.includes('Mat &amp; drikke <span class="n">3</span></a>')
          && bergen.body.includes('Natur &amp; friluft <span class="n">2</span></a>'),
          "pb-b14: each chip carries the category's colour dot, its escaped label and the real count");
        for (const k of ["Tromsø", "Bodø"]) {
          const r = await callHtmlRoute(router, kommuneUrl(k));
          assertTrue(r.status === 200 && linkedCombos(r.body).length === 0 && !r.body.includes('aria-label="Kategorier i '),
            `pb-b15: /kommune/${k} has no passing combo → no category chip row and no combo link`);
        }
      }

      // ── (c) thresholds 1, 2, 3: route, sitemap and chips agree ─────────────
      const expectations: Array<[string | undefined, string, string[]]> = [
        ["1", "1", ["natur_friluft/Bergen", "mat_drikke/Bergen", "kultur_historie/Bergen", "dyreliv_safari/Tromsø"]],
        [undefined, "2 (default)", ["natur_friluft/Bergen", "mat_drikke/Bergen"]],
        ["3", "3", ["mat_drikke/Bergen"]],
        ["0", "invalid \"0\" → 2", ["natur_friluft/Bergen", "mat_drikke/Bergen"]],
        ["to", "invalid \"to\" → 2", ["natur_friluft/Bergen", "mat_drikke/Bergen"]],
      ];
      for (const [value, name, expected] of expectations) {
        setThreshold(value);
        const sm = await buildSitemap();
        const listed = sitemapCombos(sm);
        assertTrue(sameSet(listed, expected),
          `pb-c1: threshold ${name}: the sitemap lists ${JSON.stringify([...expected].sort())} (got ${JSON.stringify(listed)})`);
        let agree = 0;
        for (const combo of allCombos) {
          const r = await callHtmlRoute(router, comboUrl(combo));
          const kommune = combo.split("/")[1];
          const ok = listed.includes(combo)
            ? r.handled && r.status === 200
            : r.handled && r.status === 301 && r.location === kommuneUrl(kommune);
          if (ok) agree++;
          else assertTrue(false, `pb-c2: threshold ${name}: ${combo} — sitemap says ${listed.includes(combo) ? "listed" : "not listed"}, route answered ${r.status} ${r.location ?? ""}`);
        }
        assertTrue(agree === allCombos.length,
          `pb-c3: threshold ${name}: route and sitemap agree on all ${allCombos.length} cells (listed ⇔ 200, else 301 to /kommune)`);
        const chipLinks: string[] = [];
        for (const kommune of ["Bergen", "Tromsø", "Bodø"]) {
          const r = await callHtmlRoute(router, kommuneUrl(kommune));
          chipLinks.push(...linkedCombos(r.body));
        }
        assertTrue(sameSet(chipLinks, listed),
          `pb-c4: threshold ${name}: the /kommune pages link exactly the listed cells (got ${JSON.stringify(chipLinks.sort())})`);
        let served = 0;
        for (const combo of chipLinks) {
          const r = await callHtmlRoute(router, comboUrl(combo));
          if (r.handled && r.status === 200) served++;
        }
        assertTrue(served === chipLinks.length, `pb-c5: threshold ${name}: every chip links a page that answers 200 (${served}/${chipLinks.length})`);

        // ── (d) the rest of the sitemap is untouched ──
        const others = [
          "/kategori/natur_friluft<", "/kategori/mat_drikke<", "/kategori/kultur_historie<", "/kategori/dyreliv_safari<",
          "/fylke/Vestland<", "/fylke/Troms<", "/fylke/Nordland<",
          "/kommune/Bergen<", "/kommune/Troms%C3%B8<", "/kommune/Bod%C3%B8<",
        ];
        const missing = others.filter((o) => !sm.includes(o));
        assertTrue(missing.length === 0, `pb-d1: threshold ${name}: category, fylke and kommune pages stay listed (missing ${JSON.stringify(missing)})`);
      }
      setThreshold(undefined);

      // ── (e) one predicate, no inline copy ──────────────────────────────────
      {
        const fs = require("fs") as typeof import("fs");
        const path = require("path") as typeof import("path");
        const src = fs.readFileSync(path.join(__dirname, "experiences-seo.ts"), "utf8");
        const calls = (src.match(/isProduktByCellIndexable\(/g) || []).length;
        assertTrue(calls >= 3, `pb-e1: experiences-seo.ts calls isProduktByCellIndexable() from the route, the sitemap and the chips (${calls} calls)`);
        assertTrue(!src.includes("(row.providerCount > 0 ? 1 : 0)") && !src.includes("(stats.providerCount > 0 ? 1 : 0)"),
          "pb-e2: the route's and the sitemap's inline copies of the fact rule are gone");
      }

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevThreshold === undefined) delete process.env[ENV]; else process.env[ENV] = prevThreshold;
      try {
        (require("./experiences-seo") as typeof import("./experiences-seo")).__resetExperiencesSitemapCacheForTesting();
      } catch { /* best-effort */ }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoProduktByGateTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
