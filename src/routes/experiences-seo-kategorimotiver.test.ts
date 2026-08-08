/**
 * experiences-seo-kategorimotiver.test.ts — route + unit tests for dev-request
 * 2026-08-08-opplevagent-ux-loft-kategorimotiver:
 *
 *   1. The S2b gårdssalg still-sketch is generalized into a motif LOOKUP
 *      (stillSketchSvg()/stillSketchCss()) — same layering/animation/crop
 *      machinery, selectable by a StillSketchMotif key — while the gårdssalg
 *      surfaces keep rendering the EXACT SAME distillation-apparatus drawing.
 *   2. /kategori/:category adopts the shared S1 chrome (oaSiteNav()/
 *      oaSiteFooter()/OA_CHROME_CSS — hamburger nav + full footer incl. "For
 *      tilbydere") instead of the old slim BROWSE_NAV/browseFooter().
 *   3. Three new category motifs — kultur_historie, sightseeing_transport,
 *      natur_friluft — each render their own distinct line-drawn backdrop.
 *   4. The homepage's #kategorier section (light background, under the hero)
 *      renders its own "hjem" motif; the hero's illustrated forside scene
 *      (fjord/farm landscape) is untouched.
 *
 * Covers:
 *   (a) stillSketchSvg()/stillSketchCss() return a DISTINCT drawing/CSS per
 *       motif key (kultur_historie / sightseeing_transport / natur_friluft /
 *       hjem / gardssalg all pairwise different).
 *   (b) stillSketchSvg("gardssalg") is IDENTICAL to gardssalgStillSketchSvg()
 *       — the lookup dispatches to the untouched S2b implementation, not a
 *       re-derived copy.
 *   (c) GET /kategori/kultur_historie, /kategori/sightseeing_transport,
 *       /kategori/natur_friluft each render 200 with the shared chrome
 *       (hamburger toggle + full footer incl. "For tilbydere" + llms.txt) —
 *       the old slim nav/mini-footer is GONE.
 *   (d) each of those three pages renders ITS OWN motif's group classes
 *       (e.g. sk-kh-kirke) and NONE of the other two motifs' classes, and
 *       NEVER the gårdssalg-only "oa-still-sketch" class/identity.
 *   (e) the still-sketch layer on those pages is aria-hidden, pointer-events
 *       none, positioned behind <main> (z-index technique), and its
 *       animation/@keyframes/dasharray live EXCLUSIVELY inside
 *       @media (prefers-reduced-motion: no-preference).
 *   (f) GET / renders the "hjem" motif's own group classes inside #kategorier
 *       — and the hero's forside scene (fjord/farm landscape path data) is
 *       byte-identical to before this slice; the homepage still never
 *       renders "oa-still-sketch" (the gårdssalg-only identity).
 *   (g) regression: /kategori/gardssalg (base catalog) is UNCHANGED —
 *       gardssalgStillSketchSvg()'s exact apparatus path data and
 *       OA_STILL_SKETCH_CSS's exact keyframe names are still present
 *       verbatim, and the page still uses "oa-still-sketch" (not
 *       "oa-motif-sketch").
 *   (h) a category with no configured motif (e.g. vinter_sno) still gets the
 *       new shared chrome, but renders NEITHER "oa-still-sketch" NOR
 *       "oa-motif-sketch" — no thin/placeholder backdrop.
 *
 * Same synthetic-req/res harness + in-memory-DB pattern as
 * experiences-seo-site-chrome.test.ts (S1) / experiences-seo-sok-boost.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-kategorimotiver.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoKategorimotiverTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-site-chrome.test.ts.
function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
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
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

// Brace-matching @media block extractor — same approach as the S2/S2b/S3
// suites (a regex can't balance nested @keyframes braces).
function extractMediaBlock(css: string, mediaPrelude: string): { block: string; rest: string } | null {
  const start = css.indexOf(mediaPrelude);
  if (start < 0) return null;
  const braceStart = css.indexOf("{", start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return { block: css.slice(braceStart + 1, i), rest: css.slice(i + 1) };
    }
  }
  return null;
}
function extractAllMediaBlocks(css: string, mediaPrelude: string): string {
  const parts: string[] = [];
  let rest = css;
  for (;;) {
    const hit = extractMediaBlock(rest, mediaPrelude);
    if (!hit) break;
    parts.push(hit.block);
    rest = hit.rest;
  }
  return parts.join("\n");
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}
const REDUCED_MOTION_PRELUDE = "@media (prefers-reduced-motion: no-preference)";

// One published experience (+ its verified provider) in the given category —
// same createProvider/createExperience shape experiences-seo-sok-boost.test.ts
// already proved renders a live /kategori/:category page.
function seedPublishedExperience(store: any, category: string, title: string): void {
  const providerId = store.createProvider({
    navn: `${title} AS`, fylke: "Vestland", kommune: "Bergen",
    brreg_verified: 1, brreg_active: 1, verification_status: "verified",
  });
  store.createExperience({
    title, provider_id: providerId, provider_match_status: "matched",
    kommune: "Bergen", fylke: "Vestland",
    category, verification_status: "verified", confidence: "high",
  });
}

export function runExperiencesSeoKategorimotiverTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    const prevLog = console.log;
    if (!log) console.log = () => { /* silence route/store chatter */ };

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      seedPublishedExperience(store, "kultur_historie", "Stavkirkevandring i Bergen");
      seedPublishedExperience(store, "sightseeing_transport", "Fjordcruise fra Bergen");
      seedPublishedExperience(store, "natur_friluft", "Fjellvandring i Bergen");
      seedPublishedExperience(store, "vinter_sno", "Skitur i Bergen");

      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = (seo as any).default;

      // ── (a) + (b): the motif lookup itself ──────────────────────────────
      const motifs = ["gardssalg", "kultur_historie", "sightseeing_transport", "natur_friluft", "hjem"] as const;
      const svgs = motifs.map((m) => (seo as any).stillSketchSvg(m));
      const csss = motifs.map((m) => (seo as any).stillSketchCss(m));
      for (let i = 0; i < motifs.length; i++) {
        assertTrue(typeof svgs[i] === "string" && svgs[i].length > 0, `a1-${motifs[i]}: stillSketchSvg() returns non-empty markup`);
        assertTrue(typeof csss[i] === "string" && csss[i].length > 0, `a2-${motifs[i]}: stillSketchCss() returns non-empty CSS`);
        assertTrue(svgs[i].length < 50_000, `a3-${motifs[i]}: stays hand-written-small (< 50 000 chars)`);
      }
      for (let i = 0; i < motifs.length; i++) {
        for (let j = i + 1; j < motifs.length; j++) {
          assertTrue(svgs[i] !== svgs[j], `a4-${motifs[i]}-vs-${motifs[j]}: distinct SVG markup`);
          assertTrue(csss[i] !== csss[j], `a5-${motifs[i]}-vs-${motifs[j]}: distinct CSS`);
        }
      }
      assertTrue(
        (seo as any).stillSketchSvg("gardssalg") === (seo as any).gardssalgStillSketchSvg(),
        "b1: stillSketchSvg('gardssalg') dispatches to the untouched gardssalgStillSketchSvg() — identical output"
      );

      // ── (c)+(d)+(e): the three new category pages ───────────────────────
      const pages: Array<{ slug: string; cls: string; label: string; others: string[] }> = [
        { slug: "kultur_historie", cls: "sk-kh-kirke", label: "Kultur & historie", others: ["sk-st-baat", "sk-nf-fjell"] },
        { slug: "sightseeing_transport", cls: "sk-st-baat", label: "Sightseeing & transport", others: ["sk-kh-kirke", "sk-nf-fjell"] },
        { slug: "natur_friluft", cls: "sk-nf-fjell", label: "Natur & friluft", others: ["sk-kh-kirke", "sk-st-baat"] },
      ];
      for (const p of pages) {
        const r = await callHtmlRoute(router, `/kategori/${p.slug}`);
        assertTrue(r.handled && r.status === 200, `c1-${p.slug}: GET /kategori/${p.slug} renders 200 (got ${r.status})`);

        // (c) shared S1 chrome present (hamburger + full footer).
        assertTrue(r.body.includes('id="oa-nav-toggle"') && r.body.includes('class="nav-burger"'),
          `c2-${p.slug}: renders the hamburger toggle + burger label`);
        assertTrue(r.body.includes('class="site-footer"') && r.body.includes('href="/llms.txt"'),
          `c3-${p.slug}: renders the FULL .site-footer (llms.txt link) — not the old mini-footer`);
        assertTrue(r.body.includes('href="/for-tilbydere"'),
          `c4-${p.slug}: nav/footer include the "For tilbydere" link`);
        assertTrue(!r.body.includes('<nav class="site-nav"><div class="nav-inner">'),
          `c5-${p.slug}: the OLD slim BROWSE_NAV markup is gone`);

        // (d) this page's own motif is present; the OTHER two motifs' group
        // classes are absent; the gårdssalg-only identity is absent too.
        assertTrue(r.body.includes('class="oa-motif-sketch"'), `d1-${p.slug}: renders the .oa-motif-sketch backdrop`);
        assertTrue(r.body.includes(`class="${p.cls}"`), `d2-${p.slug}: renders its OWN motif group (${p.cls})`);
        for (const other of p.others) {
          assertTrue(!r.body.includes(`class="${other}"`), `d3-${p.slug}: does NOT render another motif's group (${other})`);
        }
        assertTrue(!r.body.includes("oa-still-sketch"), `d4-${p.slug}: never renders the gårdssalg-only "oa-still-sketch" identity`);

        // (e) accessibility + positioning + reduced-motion discipline.
        assertTrue(/<div class="oa-motif-sketch" aria-hidden="true">/.test(r.body), `e1-${p.slug}: wrapper is aria-hidden`);
        assertTrue(
          /<svg class="sketch-wide"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(r.body) &&
          /<svg class="sketch-narrow"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(r.body),
          `e2-${p.slug}: both wide + narrow crops are aria-hidden + focusable=false`
        );
        assertTrue(
          r.body.includes(".oa-motif-sketch{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}"),
          `e3-${p.slug}: backdrop is absolute inset:0 + pointer-events:none + z-index:0 (behind content)`
        );
        assertTrue(r.body.includes(".oa-sketch-stage>main{position:relative;z-index:1}"),
          `e4-${p.slug}: <main> is z-lifted above the backdrop`);
        const guarded = extractAllMediaBlocks(r.body, REDUCED_MOTION_PRELUDE);
        assertTrue(
          guarded.length > 0 && countOccurrences(r.body, "@keyframes") === countOccurrences(guarded, "@keyframes"),
          `e5-${p.slug}: EVERY @keyframes sits inside a prefers-reduced-motion:no-preference block`
        );
        assertTrue(
          countOccurrences(r.body, ".oa-motif-sketch path{stroke-dasharray:1}") ===
          countOccurrences(guarded, ".oa-motif-sketch path{stroke-dasharray:1}"),
          `e6-${p.slug}: the draw-on dasharray only exists inside the guard (static render stays fully drawn)`
        );
      }

      // ── (f) homepage: hjem motif under the hero, hero itself untouched ──
      const home = await callHtmlRoute(router, "/");
      assertTrue(home.handled && home.status === 200, `f1: GET / renders 200 (got ${home.status})`);
      assertTrue(home.body.includes('class="oa-motif-sketch"'), "f2: homepage renders its own .oa-motif-sketch backdrop");
      assertTrue(home.body.includes('class="sk-hj-fjell"'), "f3: homepage renders the hjem motif's own group (sk-hj-fjell)");
      assertTrue(!home.body.includes("oa-still-sketch"), "f4: homepage NEVER renders the gårdssalg-only 'oa-still-sketch' identity");
      // The hero's illustrated forside scene (fjord/farm landscape) is
      // byte-identical to before this slice — same distinguishing path data
      // the S2b forside-drikkested suite pins.
      const forsideSvg = (seo as any).heroSceneSvg("forside");
      assertTrue(
        forsideSvg.includes('d="M660 390 L660 352 L684 332 L708 352 L708 390 Z"') &&
        forsideSvg.includes("rgba(24,19,13,.58)"),
        "f5: the hero's forside fjord/farm landscape layers are unchanged"
      );
      assertTrue(home.body.includes('hero-scene-forside'), "f6: homepage hero still renders the forside motif");
      // The motif sits inside #kategorier, not the hero.
      const iHero = home.body.indexOf('class="hero"');
      const iKat = home.body.indexOf('id="kategorier"');
      const iSketchInKat = home.body.indexOf('class="oa-motif-sketch"', iKat);
      assertTrue(
        iHero >= 0 && iKat > iHero && iSketchInKat > iKat,
        `f7: the hjem motif backdrop is positioned inside #kategorier, after the hero (hero=${iHero}, kategorier=${iKat}, sketch=${iSketchInKat})`
      );
      assertTrue(home.body.includes(".oa-sketch-stage>.container{position:relative;z-index:1}"),
        "f8: the #kategorier .container is z-lifted above the homepage backdrop");
      const homeGuarded = extractAllMediaBlocks(home.body, REDUCED_MOTION_PRELUDE);
      assertTrue(
        homeGuarded.length > 0 && countOccurrences(home.body, "@keyframes oaSkHj") === countOccurrences(homeGuarded, "@keyframes oaSkHj"),
        "f9: every hjem-motif @keyframes sits inside the prefers-reduced-motion:no-preference guard"
      );
      // The aurora is the ONE colored/accent pass — same idea as the
      // gårdssalg still's copper liquid — everything else stays the shared
      // discreet stroke color.
      assertTrue(home.body.includes(".oa-motif-sketch .sk-hj-nordlys path{stroke:#12a594;stroke-width:4}"),
        "f10: the aurora accent group carries its own teal stroke color");

      // ── (g) regression: /kategori/gardssalg is byte-for-byte unaffected ──
      const gard = await callHtmlRoute(router, "/kategori/gardssalg");
      assertTrue(gard.handled && gard.status === 200, `g1: GET /kategori/gardssalg renders 200 (got ${gard.status})`);
      assertTrue(gard.body.includes('class="oa-still-sketch"'), "g2: gårdssalg catalog still renders under 'oa-still-sketch' (not the new 'oa-motif-sketch' class)");
      assertTrue(!gard.body.includes('class="oa-motif-sketch"'), "g3: gårdssalg catalog does NOT pick up the new generic motif wrapper");
      assertTrue(
        gard.body.includes('<path pathLength="1" d="M132 648 C114 540 160 446 252 440 C344 446 390 540 372 648"/>'),
        "g4: the exact original kettle path data is still present, unchanged"
      );
      assertTrue(
        gard.body.includes("@keyframes oaSkKjele{0%,2%{stroke-dashoffset:1}16%,100%{stroke-dashoffset:0}}") &&
        gard.body.includes("@keyframes oaSkVaeske{0%,58%{stroke-dashoffset:1}76%,100%{stroke-dashoffset:0}}"),
        "g5: the exact original S2b keyframe timeline (kjele/vaeske) is still present, unchanged"
      );
      const sketchSvg = (seo as any).gardssalgStillSketchSvg();
      assertTrue(typeof sketchSvg === "string" && sketchSvg.length > 0, "g6: gardssalgStillSketchSvg() still returns its own drawing");

      // ── (h) a category with no configured motif gets the new chrome but
      //        NO backdrop at all (no thin/placeholder sketch layer) ───────
      const noMotif = await callHtmlRoute(router, "/kategori/vinter_sno");
      assertTrue(noMotif.handled && noMotif.status === 200, `h1: GET /kategori/vinter_sno renders 200 (got ${noMotif.status})`);
      assertTrue(noMotif.body.includes('id="oa-nav-toggle"'), "h2: still gets the shared S1 chrome");
      assertTrue(
        !noMotif.body.includes("oa-still-sketch") && !noMotif.body.includes("oa-motif-sketch"),
        "h3: renders NEITHER sketch wrapper — no motif configured for this category yet"
      );
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-kategorimotiver: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      console.log = prevLog;
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoKategorimotiverTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
