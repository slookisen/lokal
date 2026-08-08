/**
 * experiences-seo-forside-drikkested.test.ts — route-level tests for S2 of
 * dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering:
 * the illustrated SVG hero scene (heroSceneSvg "forside"/"drikke") + the
 * homepage drikkested feature section (renderDrikkestedFeatureSection) +
 * countGardssalgProvidersByType().
 *
 * Covers:
 *   (a) with ≥5 seeded gårdssalg producers the homepage renders the
 *       #drikkested section with a CTA link to /kategori/gardssalg and
 *       correct aggregated type-count chips (cideri+sideri → «Sider» etc.).
 *   (b) below the visibility threshold (gardssalgVisible() false) the
 *       section is completely absent — no wrapper, no strings.
 *   (c) the hero-scene SVG is present with aria-hidden="true" +
 *       focusable="false", the old .hero-range strip is gone, and EACH
 *       motif variant is < 50 000 chars.
 *   (d) the /en render shows the EN strings in the section (NO/EN parity).
 *   (e) the ONE steam @keyframes rule lives strictly INSIDE the
 *       @media (prefers-reduced-motion: no-preference) block — no motion
 *       definition is parsed by reduced-motion UAs.
 *   (f) /kategori/gardssalg renders the drikke motif behind its hero.
 *   (g) countGardssalgProvidersByType(): same WHERE gate as
 *       countGardssalgProviders() — catalog_hidden=1 excluded, NULL
 *       producer_type comes back as its own row, per-type counts correct.
 *   (h) S2b (Daniel's directive: the distillery identity belongs to the
 *       gardssalg surfaces ONLY): the copper pot-still + steam are REMOVED
 *       from the forside motif (landscape kept), still present in the
 *       drikke motif, the #drikkested section is untouched, and the
 *       gardssalg still sketch never leaks onto the homepage.
 *
 * Same synthetic-req/res harness + in-memory-DB pattern as
 * experiences-seo-site-chrome.test.ts (S1).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-forside-drikkested.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoForsideDrikkestedTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as experiences-seo-site-chrome.test.ts.
// `lang` mirrors what the /en rewrite middleware stamps on req in production.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang,
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

// Extract a `@media (...)` block's CONTENT via brace matching (a regex can't
// balance the nested @keyframes/{...} braces inside it).
function extractMediaBlock(css: string, mediaPrelude: string): string | null {
  const start = css.indexOf(mediaPrelude);
  if (start < 0) return null;
  const braceStart = css.indexOf("{", start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(braceStart + 1, i);
    }
  }
  return null;
}

// ALL such blocks concatenated — S2b adds a SECOND no-preference guard to
// the gardssalg page (the still-sketch timeline lives in its own guarded
// block next to the hero steam's), so "no @keyframes outside the guard"
// must be checked against the union of every guarded block, not just the
// first one.
function extractAllMediaBlocks(css: string, mediaPrelude: string): string {
  let rest = css;
  const parts: string[] = [];
  for (;;) {
    const block = extractMediaBlock(rest, mediaPrelude);
    if (block === null) break;
    parts.push(block);
    rest = rest.slice(rest.indexOf(mediaPrelude) + mediaPrelude.length);
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

// One raw-SQL provider insert, same column set as the S1 chrome test's
// fixture (there is no service-layer setter for producer_type /
// catalog_hidden / rfb_seed_source).
function insertProvider(
  db: any,
  p: {
    id: string;
    navn: string;
    producer_type: string | null;
    catalog_hidden?: number | null;
    rfb_seed_source?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden,
        rfb_seed_source, lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
     VALUES
       (?, ?, 'experiences', 'Innlandet', 'Ringsaker', 'Brumunddal', ?, NULL, ?,
        ?, 60.88, 10.94, 'high', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`
  ).run(p.id, p.navn, p.producer_type, p.catalog_hidden ?? null, p.rfb_seed_source ?? null, p.id);
}

export function runExperiencesSeoForsideDrikkestedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

    // Fresh module graph + fresh :memory: DB — called once per phase so the
    // below-threshold phase (b) can't see phase A's seeded providers.
    function freshModules(): {
      db: any;
      store: typeof import("../services/experience-store");
      seo: typeof import("./experiences-seo");
      router: any;
    } {
      for (const p of cachePaths) delete require.cache[p];
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      return { db, store, seo, router: (seo as any).default };
    }

    try {
      // ════════════════════════════════════════════════════════════════
      // Phase A — 7 visible producers (≥5 threshold) + 1 catalog_hidden.
      // Types: 2×sideri + 1×cideri (both → «Sider»), 1×bryggeri, 1×mjøderi,
      // 1×vingaard (the pipeline's ASCII å→aa transliteration, see
      // search-enrich.ts's producer-type mapping — must alias to «Fruktvin»),
      // 1×NULL-type rfb-seed row (counts toward the gate, gets NO chip);
      // the hidden sideri must never count anywhere.
      // ════════════════════════════════════════════════════════════════
      const A = freshModules();
      insertProvider(A.db, { id: "ds-sideri-1", navn: "Eplelund Sideri", producer_type: "sideri" });
      insertProvider(A.db, { id: "ds-sideri-2", navn: "Fjordbris Sideri", producer_type: "sideri" });
      insertProvider(A.db, { id: "ds-cideri-1", navn: "Hagen Cideri", producer_type: "cideri" });
      insertProvider(A.db, { id: "ds-brygg-1", navn: "Liaberg Bryggeri", producer_type: "bryggeri" });
      insertProvider(A.db, { id: "ds-mjod-1", navn: "Vollen Mjøderi", producer_type: "mjøderi" });
      insertProvider(A.db, { id: "ds-vingaard-1", navn: "Aashagen Vingaard", producer_type: "vingaard" });
      insertProvider(A.db, { id: "ds-null-1", navn: "Seterhagen Gard", producer_type: null, rfb_seed_source: "rfb-seed" });
      insertProvider(A.db, { id: "ds-hidden-1", navn: "Skjult Sideri", producer_type: "sideri", catalog_hidden: 1 });

      const home = await callHtmlRoute(A.router, "/");

      // ── (a) feature section present with CTA + aggregated chips ───────
      assertTrue(home.handled && home.status === 200, `a1: GET / renders 200 (got ${home.status})`);
      assertTrue(home.body.includes('id="drikkested"'), "a2: homepage renders the #drikkested feature section");
      assertTrue(home.body.includes("Besøk lokale drikkeprodusenter"), "a3: section title (NO) present");
      assertTrue(
        /<a class="drikkested-cta" href="\/kategori\/gardssalg">/.test(home.body),
        "a4: section CTA links to /kategori/gardssalg"
      );
      const chipsBlock = (home.body.match(/<div class="drink-chips"[^>]*>([\s\S]*?)<\/div>/) || ["", ""])[1];
      assertTrue(chipsBlock.length > 0, "a5: type-chip row present");
      assertTrue(
        /Sider <span class="n"[^>]*>3<\/span>/.test(chipsBlock),
        "a6: cideri+sideri aggregate to one «Sider» chip with count 3 (2 sideri + 1 cideri; hidden sideri excluded)"
      );
      assertTrue(/Bryggeri <span class="n"[^>]*>1<\/span>/.test(chipsBlock), "a7: «Bryggeri» chip shows count 1");
      assertTrue(/Mjød <span class="n"[^>]*>1<\/span>/.test(chipsBlock), "a8: mjøderi maps to a «Mjød» chip with count 1");
      assertTrue(
        /Fruktvin <span class="n"[^>]*>1<\/span>/.test(chipsBlock),
        "a8b: the ASCII-transliterated «vingaard» spelling aliases to the «Fruktvin» chip"
      );
      for (const absentLabel of ["Kombucha", "Destillat"]) {
        assertTrue(!chipsBlock.includes(absentLabel), `a9: no «${absentLabel}» chip when its type-count is 0`);
      }
      assertTrue(!chipsBlock.includes("Seterhagen"), "a10: the NULL-type rfb-seed row gets no chip (but still gates the section on)");
      // Placement: after the counter strip, before #kategorier.
      const iCounters = home.body.indexOf('class="counters"');
      const iDrikke = home.body.indexOf('id="drikkested"');
      const iKat = home.body.indexOf('id="kategorier"');
      assertTrue(
        iCounters >= 0 && iDrikke > iCounters && iKat > iDrikke,
        `a11: section order is counter-strip(${iCounters}) < #drikkested(${iDrikke}) < #kategorier(${iKat})`
      );

      // ── (c) hero scene SVG ────────────────────────────────────────────
      assertTrue(
        /<svg class="hero-scene hero-scene-forside"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(home.body),
        "c1: homepage hero renders the forside scene with aria-hidden + focusable=false"
      );
      assertTrue(!home.body.includes("hero-range"), "c2: the old .hero-range mountain strip is fully gone");
      const heroSceneSvg = (A.seo as any).heroSceneSvg as (m: "forside" | "drikke") => string;
      for (const motif of ["forside", "drikke"] as const) {
        const svg = heroSceneSvg(motif);
        assertTrue(
          svg.length < 50000,
          `c3-${motif}: variant stays under 50 000 chars (got ${svg.length})`
        );
        assertTrue(
          svg.includes('aria-hidden="true"') && svg.includes('focusable="false"') &&
          svg.includes('viewBox="0 0 1440 480"') && svg.includes('preserveAspectRatio="xMidYMax slice"'),
          `c3b-${motif}: variant carries aria-hidden/focusable/viewBox/preserveAspectRatio`
        );
      }

      // ── (e) @keyframes ONLY inside prefers-reduced-motion:no-preference ─
      // dev-request 2026-08-08-opplevagent-ux-loft-kategorimotiver ADDS a
      // SECOND no-preference guard to the homepage (the new #kategorier
      // still-sketch motif's own timeline, next to the hero steam's) — same
      // situation the S2b gårdssalg-page fix below already handles, so this
      // check is updated the same way: extractAllMediaBlocks (the UNION of
      // every guarded block) instead of the single first-match
      // extractMediaBlock. The invariant itself ("no @keyframes outside ANY
      // guard") is unchanged.
      const motionBlock = extractMediaBlock(home.body, REDUCED_MOTION_PRELUDE);
      assertTrue(motionBlock !== null, "e1: homepage CSS has a @media (prefers-reduced-motion: no-preference) block");
      assertTrue(
        (motionBlock || "").includes("@keyframes"),
        "e2: the steam @keyframes rule lives inside that block"
      );
      const allMotionBlocks = extractAllMediaBlocks(home.body, REDUCED_MOTION_PRELUDE);
      assertTrue(
        countOccurrences(home.body, "@keyframes") === countOccurrences(allMotionBlocks, "@keyframes"),
        "e3: NO @keyframes exists anywhere outside a reduced-motion guard (union of every guarded block)"
      );
      assertTrue(
        (motionBlock || "").includes("animation:oaSteamRise"),
        "e4: the animation binding also sits inside the guard (static steam otherwise)"
      );

      // ── (d) EN render shows the EN strings ────────────────────────────
      const homeEn = await callHtmlRoute(A.router, "/", "en");
      assertTrue(homeEn.handled && homeEn.status === 200, `d1: GET / with req.lang="en" renders 200 (got ${homeEn.status})`);
      assertTrue(homeEn.body.includes("Visit local drink producers"), "d2: EN section title rendered");
      assertTrue(homeEn.body.includes(">New</span>"), "d3: EN kicker («New») rendered");
      assertTrue(homeEn.body.includes("Explore drink stops"), "d4: EN CTA label rendered");
      assertTrue(!homeEn.body.includes("Besøk lokale drikkeprodusenter"), "d5: no NO title leaks into the EN render");

      // ── (f) /kategori/gardssalg renders the drikke motif ──────────────
      const gard = await callHtmlRoute(A.router, "/kategori/gardssalg");
      assertTrue(gard.handled && gard.status === 200, `f1: GET /kategori/gardssalg renders 200 (got ${gard.status})`);
      assertTrue(
        /<svg class="hero-scene hero-scene-drikke"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(gard.body),
        "f2: gardssalg hero renders the drikke scene with aria-hidden + focusable=false"
      );
      assertTrue(!gard.body.includes("hero-scene-forside"), "f3: gardssalg page uses the drikke motif, not the forside one");
      // f4 UPDATED for S2b: the gardssalg page now carries TWO
      // no-preference blocks (hero steam + the still-sketch timeline), so
      // the "no @keyframes outside the guard" invariant is asserted against
      // the UNION of all guarded blocks — the invariant itself is unchanged.
      const gardMotion = extractAllMediaBlocks(gard.body, REDUCED_MOTION_PRELUDE);
      assertTrue(
        gardMotion.length > 0 && countOccurrences(gard.body, "@keyframes") === countOccurrences(gardMotion, "@keyframes"),
        "f4: the reduced-motion guard holds on the gardssalg page too (every @keyframes inside a no-preference block)"
      );

      // ── (h) S2b: pot-still off the forside, kept on drikke; sketch
      //        never on the homepage ─────────────────────────────────────
      const forsideSvg = heroSceneSvg("forside");
      const drikkeSvg = heroSceneSvg("drikke");
      // The copper palette (rgba(201,138,43,…)) was ONLY ever used by the
      // forside pot-still — its absence proves the whole apparatus is gone.
      assertTrue(!forsideSvg.includes("rgba(201,138,43"), "h1: forside motif carries NO copper pot-still paths anymore");
      assertTrue(!forsideSvg.includes('class="steam"'), "h2: the pot-still's steam group is gone from the forside motif too");
      // The neutral landscape is KEPT: farm cluster + darkest depth layer.
      assertTrue(
        forsideSvg.includes('d="M660 390 L660 352 L684 332 L708 352 L708 390 Z"') &&
        forsideSvg.includes("rgba(24,19,13,.58)"),
        "h3: the fjord/farm landscape layers survive unchanged on the forside"
      );
      // The drikke motif (gardssalg hero) is untouched: kettle + steam.
      assertTrue(
        drikkeSvg.includes("rgba(201,138,43") && drikkeSvg.includes('class="steam"'),
        "h4: drikke motif keeps its copper kettle + steam (unchanged)"
      );
      // The S2b still sketch belongs to the gardssalg surfaces ONLY.
      assertTrue(!home.body.includes("oa-still-sketch"), "h5: the gardssalg still sketch never renders on the homepage");
      assertTrue(gard.body.includes('class="oa-still-sketch"'), "h6: /kategori/gardssalg renders the still-sketch layer");

      // ── (g) countGardssalgProvidersByType() unit ──────────────────────
      const rows = A.store.countGardssalgProvidersByType();
      const byType = new Map(rows.map((r) => [r.producer_type, r.count]));
      assertTrue(byType.get("sideri") === 2, `g1: sideri counts 2 — the catalog_hidden=1 sideri is EXCLUDED (got ${byType.get("sideri")})`);
      assertTrue(byType.get("cideri") === 1, `g2: cideri counts 1 (got ${byType.get("cideri")})`);
      assertTrue(byType.get("bryggeri") === 1, `g3: bryggeri counts 1 (got ${byType.get("bryggeri")})`);
      assertTrue(byType.get("mjøderi") === 1, `g4: mjøderi counts 1 (got ${byType.get("mjøderi")})`);
      assertTrue(byType.get("vingaard") === 1, `g4b: the raw «vingaard» spelling comes back VERBATIM from the store (aliasing is the renderer's job) (got ${byType.get("vingaard")})`);
      assertTrue(byType.get(null) === 1, `g5: the NULL-type rfb-seed row comes back as its OWN row with count 1 (got ${byType.get(null)})`);
      const sum = rows.reduce((acc, r) => acc + r.count, 0);
      assertTrue(sum === A.store.countGardssalgProviders(), `g6: per-type counts sum to countGardssalgProviders() (${sum} vs ${A.store.countGardssalgProviders()})`);
      assertTrue(sum === 7, `g7: total is 7 — never 8 (hidden row leaked) (got ${sum})`);

      // ════════════════════════════════════════════════════════════════
      // Phase B — below threshold (1 producer): section fully absent.
      // ════════════════════════════════════════════════════════════════
      const B = freshModules();
      insertProvider(B.db, { id: "ds-solo-1", navn: "Ensom Sideri", producer_type: "sideri" });

      const homeB = await callHtmlRoute(B.router, "/");
      assertTrue(homeB.handled && homeB.status === 200, `b1: GET / below threshold renders 200 (got ${homeB.status})`);
      assertTrue(!homeB.body.includes('id="drikkested"'), "b2: no #drikkested section below the visibility threshold");
      assertTrue(!homeB.body.includes("Besøk lokale drikkeprodusenter"), "b3: none of the section's strings render below threshold");
      // class="drink-chip" targets the MARKUP — the .drink-chip CSS rule is
      // (deliberately) always in the stylesheet, gated or not.
      assertTrue(!homeB.body.includes('class="drink-chip"'), "b4: no chip markup below threshold");
      // The hero scene is NOT gated — it must render regardless.
      assertTrue(homeB.body.includes("hero-scene-forside"), "b5: the hero scene renders regardless of the gardssalg gate");
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-forside-drikkested: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
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
  runExperiencesSeoForsideDrikkestedTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Explicit exit on success too: requiring the seo route module leaves
    // live handles (email-service/counter timers) on the event loop, so a
    // fully green standalone run would otherwise hang instead of exiting.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
