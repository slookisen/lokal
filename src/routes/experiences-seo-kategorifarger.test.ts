/**
 * experiences-seo-kategorifarger.test.ts — the per-category colour system and
 * the experience-profile remake (Daniel, live sesjon 2026-08-24: «Bruk rolige
 * komfortable farger, og marker de ulike kategoriene i sin farge» +
 * «opplevelses profilene får seg en liten remake og bildene blir forbedret»).
 *
 * Covers:
 *   (a) The palette contract in services/category-palette.ts: every colour is
 *       a 6-digit hex, every colour is distinct, every LIVE category slug has
 *       one — and, the load-bearing one, every colour clears WCAG AA 4.5:1
 *       against white, because these are used as solid fills under white text
 *       (.tag-cat / .badge-cat). A future category added without checking
 *       contrast fails here instead of shipping an unreadable chip.
 *   (b) ONE source of truth: the OG-image service's per-category accent map
 *       IS the shared palette (it used to be an independent map, so a
 *       category could be one colour in a link preview and another on the
 *       page it linked to).
 *   (c) Listing cards: each card carries its own category's colour on the
 *       top edge AND on the category tag, and two different categories in the
 *       same grid render two different colours.
 *   (d) Facet chips carry a colour dot per category; fylke chips do not (a
 *       place has no category colour to claim).
 *   (e) Homepage category cards carry their category colour.
 *   (f) /kategori/:category head carries the same colour its cards do.
 *   (g) The experience profile: the old dotted "hero-placeholder" box is gone
 *       and a drawn cover renders instead (cover-art + a category-coloured
 *       cover-chip); the cover is DETERMINISTIC (same slug → byte-identical
 *       markup across renders, so no layout shuffling between requests) and
 *       category-driven (a vinter_sno cover is not a mat_drikke cover).
 *   (h) The profile is migrated to the shared S1 chrome — same 4-marker probe
 *       (hamburger toggle + full footer + llms.txt + personvern) every other
 *       chrome migration in this codebase uses.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-kategorifarger.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoKategorifargerTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling experiences-seo
// test files.
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
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() {},
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

// WCAG 2.x relative luminance + contrast ratio. Inlined (a few lines) rather
// than pulled from a dependency — the point of (a) is that the check itself is
// part of the gate.
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

// One verified experience row in a given category.
function insertExperience(
  db: any,
  e: { id: string; slug: string; title: string; category: string; kommune?: string; fylke?: string }
): void {
  db.prepare(
    `INSERT INTO experiences (id, slug, title, title_no, description, category, kommune, fylke,
       indoor_outdoor, verification_status)
     VALUES (@id, @slug, @title, @title, @description, @category, @kommune, @fylke, 'outdoor', 'verified')`
  ).run({
    id: e.id,
    slug: e.slug,
    title: e.title,
    description: `${e.title} er en ekte opplevelse med lokal guide, passende for både familier og små grupper.`,
    category: e.category,
    kommune: e.kommune ?? "Voss",
    fylke: e.fylke ?? "Vestland",
  });
}

export function runExperiencesSeoKategorifargerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

    try {
      for (const p of cachePaths) delete require.cache[p];
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = (seo as any).default;
      const palette = require("../services/category-palette") as typeof import("../services/category-palette");
      const ogImage = require("../services/experience-og-image") as typeof import("../services/experience-og-image");

      // ── (a) palette contract ────────────────────────────────────────
      const entries = Object.entries(palette.CATEGORY_COLORS);
      assertTrue(entries.length >= 9, `a1: the palette covers the live category set (${entries.length} entries)`);
      assertTrue(
        entries.every(([, hex]) => /^#[0-9a-f]{6}$/i.test(hex)),
        "a2: every colour is a full 6-digit hex (…1f/…33 alpha suffixes are appended at use time)",
      );
      assertTrue(
        new Set(entries.map(([, hex]) => hex)).size === entries.length,
        "a3: every category has a distinct colour — no two categories look alike",
      );
      const belowBar = entries.filter(([, hex]) => contrastWithWhite(hex) < 4.5);
      assertTrue(
        belowBar.length === 0,
        `a4: every colour clears WCAG AA 4.5:1 under white text${belowBar.length ? " — below bar: " + belowBar.map(([k, v]) => `${k}=${v} (${contrastWithWhite(v).toFixed(2)}:1)`).join(", ") : ""}`,
      );
      assertTrue(
        /^#[0-9a-f]{6}$/i.test(palette.CATEGORY_COLOR_FALLBACK) &&
          contrastWithWhite(palette.CATEGORY_COLOR_FALLBACK) >= 4.5,
        "a5: the unknown-category fallback holds the same contrast contract",
      );
      // Every LIVE category the site actually renders must have its own entry
      // (a live category quietly falling back to brand teal is the bug this
      // pins — it would look identical to every other unmapped one).
      for (const slug of [
        "natur_friluft", "mat_drikke", "vinter_sno", "kultur_historie", "dyreliv_safari",
        "sightseeing_transport", "adrenalin_action", "velvaere_spa", "overnatting_opplevelse",
      ]) {
        assertTrue(!!palette.CATEGORY_COLORS[slug], `a6: live category ${slug} has its own colour`);
      }

      // ── (b) one source of truth, page + OG image ────────────────────
      assertTrue(
        ogImage.CATEGORY_OG_ACCENT_COLORS === palette.CATEGORY_COLORS,
        "b1: the OG-image accent map IS the shared palette (same object, not a copy that can drift)",
      );
      assertTrue(
        ogImage.resolveOgAccentColor("vinter_sno") === palette.CATEGORY_COLORS.vinter_sno,
        "b2: a category resolves to the same colour in a link preview as on the page",
      );

      // ── fixtures: two categories, three rows ────────────────────────
      insertExperience(db, { id: "kf-1", slug: "kf-vinter-1", title: "Toppturkurs på Voss", category: "vinter_sno" });
      insertExperience(db, { id: "kf-2", slug: "kf-vinter-2", title: "Kveldsski i Myrkdalen", category: "vinter_sno" });
      insertExperience(db, { id: "kf-3", slug: "kf-mat-1", title: "Smakstur i Hardanger", category: "mat_drikke" });
      const vinter = palette.CATEGORY_COLORS.vinter_sno;
      const mat = palette.CATEGORY_COLORS.mat_drikke;

      // ── (c) listing cards ───────────────────────────────────────────
      const list = await callHtmlRoute(router, "/opplevelser");
      assertTrue(list.handled && list.status === 200, `c1: GET /opplevelser renders 200 (got ${list.status})`);
      // Scope the search to the card grid: the page's ItemList JSON-LD names
      // every row ABOVE the grid, so a plain indexOf(title) would land in the
      // structured data and slice nothing.
      function cardSliceFor(title: string, body: string): string {
        const gridStart = body.indexOf('class="grid"');
        const idx = gridStart < 0 ? -1 : body.indexOf(title, gridStart);
        if (idx < 0) return "";
        const start = body.lastIndexOf('<a class="card', idx);
        const end = body.indexOf("</a>", idx);
        return start < 0 || end < 0 ? "" : body.slice(start, end);
      }
      const vinterCard = cardSliceFor("Toppturkurs på Voss", list.body);
      const matCard = cardSliceFor("Smakstur i Hardanger", list.body);
      assertTrue(vinterCard.includes(`border-top-color:${vinter}`), "c2: a vinter_sno card's top edge is the vinter_sno colour");
      assertTrue(matCard.includes(`border-top-color:${mat}`), "c3: a mat_drikke card's top edge is the mat_drikke colour");
      assertTrue(vinter !== mat && !vinterCard.includes(mat) && !matCard.includes(vinter),
        "c4: the two categories render two different colours — the grid is scannable by colour");
      assertTrue(vinterCard.includes(`class="tag tag-cat" style="background:${vinter}`),
        "c5: the category tag itself carries the category colour (white text on it — see a4)");

      // ── (d) facet chips ─────────────────────────────────────────────
      assertTrue(list.body.includes(`<span class="chip-dot" aria-hidden="true" style="background:${vinter}"></span>`),
        "d1: the vinter_sno facet chip carries its colour dot");
      const fylkeChipsIdx = list.body.indexOf('aria-label="Fylker"');
      const fylkeChips = fylkeChipsIdx < 0 ? "" : list.body.slice(fylkeChipsIdx, list.body.indexOf("</div>", fylkeChipsIdx));
      assertTrue(fylkeChipsIdx > -1 && !fylkeChips.includes("chip-dot"),
        "d2: fylke chips stay dotless — the colour system marks categories, not places");

      // ── (e) homepage category cards ─────────────────────────────────
      const home = await callHtmlRoute(router, "/");
      assertTrue(home.handled && home.status === 200, `e1: GET / renders 200 (got ${home.status})`);
      assertTrue(home.body.includes(`<a class="cat-card" style="border-top-color:${vinter}"`),
        "e2: the homepage card for a category carries that category's colour");
      assertTrue(home.body.includes(`style="color:${vinter};background:${vinter}1f`),
        "e3: its icon tile is a derived wash of the same hex (alpha suffix, never a second hand-picked colour)");

      // ── (f) category page head ──────────────────────────────────────
      const kat = await callHtmlRoute(router, "/kategori/vinter_sno");
      assertTrue(kat.handled && kat.status === 200, `f1: GET /kategori/vinter_sno renders 200 (got ${kat.status})`);
      assertTrue(kat.body.includes(`class="head head-accent" style="border-left-color:${vinter}"`),
        "f2: the category page head carries the same colour its cards do");
      assertTrue(kat.body.includes(">Kategori</p>") || kat.body.includes("Kategori</p>"),
        "f3: …with the eyebrow that names what the colour means");

      // ── (g) the profile cover ───────────────────────────────────────
      const detail = await callHtmlRoute(router, "/opplevelse/kf-vinter-1");
      assertTrue(detail.handled && detail.status === 200, `g1: GET /opplevelse/kf-vinter-1 renders 200 (got ${detail.status})`);
      assertTrue(!detail.body.includes('class="hero-media hero-placeholder"'),
        "g2: the old dotted placeholder box is gone from the profile");
      assertTrue(detail.body.includes('class="cover-art"') && detail.body.includes("<path d="),
        "g3: a drawn cover renders in its place (real art, not an icon on a dotted background)");
      assertTrue(detail.body.includes(`class="cover-chip" style="background:${vinter}"`),
        "g4: the cover's label chip carries the category colour");
      assertTrue(detail.body.includes(`<a class="badge badge-cat" style="background:${vinter};border-color:${vinter}"`),
        "g5: so does the category badge under the title");
      const detail2 = await callHtmlRoute(router, "/opplevelse/kf-vinter-1");
      function coverOf(body: string): string {
        const i = body.indexOf('<svg class="cover-art"');
        return i < 0 ? "" : body.slice(i, body.indexOf("</svg>", i));
      }
      assertTrue(coverOf(detail.body).length > 0 && coverOf(detail.body) === coverOf(detail2.body),
        "g6: the cover is deterministic — the same experience draws the same picture on every request");
      const detailMat = await callHtmlRoute(router, "/opplevelse/kf-mat-1");
      assertTrue(coverOf(detailMat.body) !== coverOf(detail.body) && coverOf(detailMat.body).includes(mat),
        "g7: a different category draws a different cover, in its own colour");
      const detailVinter2 = await callHtmlRoute(router, "/opplevelse/kf-vinter-2");
      assertTrue(coverOf(detailVinter2.body) !== coverOf(detail.body),
        "g8: two experiences in the SAME category still differ — the catalogue isn't stamped from one mould");

      // ── (h) shared chrome on the profile ────────────────────────────
      assertTrue(detail.body.includes('id="oa-nav-toggle"'), "h1: the profile renders the shared hamburger nav toggle");
      assertTrue(detail.body.includes("nav-burger"), "h2: …with the burger control itself");
      assertTrue(detail.body.includes("/llms.txt"), "h3: …and the full site footer's llms.txt link");
      assertTrue(/personvern/i.test(detail.body), "h4: …and its personvern link");
      // The shared nav links to /#kategorier too, so the probe is the legacy
      // WRAPPER markup, not the href.
      assertTrue(!detail.body.includes('<span class="nav-links"><a href="/">Forsiden</a>'),
        "h5: the legacy two-link slim nav is gone");
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-kategorifarger: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
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
  runExperiencesSeoKategorifargerTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
