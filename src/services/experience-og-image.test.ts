/**
 * experience-og-image.test.ts — tests for the per-page branded og:image SVG
 * generator (src/services/experience-og-image.ts) and its serving route
 * (GET /og-image.svg in src/routes/experiences-seo.ts), added for dev-request
 * 2026-07-12-opplevagent-serp-innholdsberikelse, item 3: replace the
 * domain-wide favicon.svg og:image fallback with a per-page branded SVG on
 * opplevelse-detail, tilbyder-detail, and kategori/fylke/kommune-browse
 * pages.
 *
 * Mirrors oa-home-counters.test.ts's shape for exercising the
 * experiences-seo router: the rfb/main DB is injected via
 * __setDbForTesting + __initSchemaForTesting and the experiences DB uses
 * EXPERIENCES_DB_PATH=":memory:" + db-factory's __resetDbFactoryForTesting(),
 * with a fresh require-cache for every module touched. This is required even
 * though GET /og-image.svg itself never touches a DB, because
 * experience-og-image.ts imports escapeHtml() from ../routes/experiences-seo
 * (reusing the same HTML/XML escaper used everywhere else in that file
 * rather than defining a second one — see the comment atop
 * experience-og-image.ts), so requiring either module pulls in the other's
 * full module graph, which (like every other route in experiences-seo.ts)
 * expects a DB to be reachable.
 *
 *   - the router is exercised directly (no HTTP server / supertest — this
 *     repo's convention): build a minimal req/res pair and call
 *     `router.handle(req, res, next)`.
 *   - exported runExperienceOgImageTests({log}) -> TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/services/experience-og-image.test.ts
 *
 * Covers:
 *   (a) renderExperienceOgImageSvg(): deterministic 1200x630 SVG shape
 *       (dimensions, viewBox, wordmark, no raster <image> tags).
 *   (b) renderExperienceOgImageSvg(): XML-escaping — a label/sublabel
 *       containing `& < > " '` never appears unescaped in the output; the
 *       escaped entities do appear.
 *   (c) renderExperienceOgImageSvg(): determinism (same input -> byte-
 *       identical output) and graceful bounding of an absurdly long label
 *       (no throw, output stays a bounded size).
 *   (d) resolveOgAccentColor(): known category -> its mapped color; unknown/
 *       missing category -> DEFAULT_OG_ACCENT.
 *   (e) GET /og-image.svg: 200, Content-Type image/svg+xml, non-empty body,
 *       long Cache-Control (public, max-age=604800, immutable).
 *   (f) GET /og-image.svg: query-param XML injection attempt is escaped in
 *       the served body, not reflected raw.
 *   (g) GET /og-image.svg: an overlong query param does not crash the route
 *       (still 200, still valid-looking SVG, body bounded).
 *   (h) GET /og-image.svg: no query params at all still serves a fallback
 *       "Opplevagent"-labeled image (never errors on missing input).
 *   (i) Wiring regression: `${url}/favicon.svg` as og:image now appears
 *       exactly once in experiences-seo.ts (the homepage's, explicitly out
 *       of scope for this item) — the opplevelse-detail, browse, and
 *       gardssalg-produsent sites were all migrated off it.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, url: string): Promise<{ handled: boolean; status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    // router.handle() is called directly here (bypassing the full Express
    // app pipeline), so req.query is NOT auto-populated by Express's own
    // query-parser middleware the way it would be for a real request —
    // parse it ourselves from the URL so route handlers that read
    // req.query.* (like GET /og-image.svg) see the actual test params.
    const query: Record<string, string> = {};
    const qIdx = url.indexOf("?");
    if (qIdx !== -1) {
      for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) query[k] = v;
    }
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query,
      headers: {},
      lang: "no",
      get(name: string) {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      header(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      send(body: any) {
        resolve({ handled: true, status: statusCode, headers, body: String(body) });
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, headers, body: JSON.stringify(body) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, headers, body: err ? String(err) : "" });
    });
  });
}

export function runExperienceOgImageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

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
    const prevDb = initMod.getDb();
    const rfbDb = new Database(":memory:");
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    // Fresh require-cache for every module this test touches, so no earlier
    // test's module-level state leaks in (and so the experience-og-image ->
    // experiences-seo require edge resolves against a clean, DB-ready graph).
    const dbFactoryPath = require.resolve("../database/db-factory");
    const ogImagePath = require.resolve("./experience-og-image");
    const expSeoPath = require.resolve("../routes/experiences-seo");
    for (const p of [dbFactoryPath, ogImagePath, expSeoPath]) {
      delete require.cache[p];
    }

    try {
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("experiences");

      const ogImageMod = require("./experience-og-image") as typeof import("./experience-og-image");
      const expSeoRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;

      // ── (a) shape ────────────────────────────────────────────────────
      const svg1 = ogImageMod.renderExperienceOgImageSvg({ label: "Vinter i fjellet", sublabel: "Vinter & snø" });
      assertTrue(svg1.startsWith("<svg"), "a1: output starts with <svg");
      assertTrue(svg1.includes('width="1200"') && svg1.includes('height="630"'), "a2: 1200x630 dimensions present");
      assertTrue(svg1.includes('viewBox="0 0 1200 630"'), "a3: viewBox matches the OG aspect ratio");
      assertTrue(svg1.includes("opplevagent"), "a4: Opplevagent wordmark present");
      assertTrue(!/<image[\s>]/.test(svg1), "a5: no raster <image> tag — text/shape only");
      assertTrue(svg1.includes("Vinter i fjellet"), "a6: label text present");
      assertTrue(svg1.includes("Vinter &amp; sn"), "a7: sublabel text present (escaped &)");

      // ── (b) XML-escaping ────────────────────────────────────────────
      const dangerousLabel = `<script>alert("x")</script> & 'quote' <tag>`;
      const svg2 = ogImageMod.renderExperienceOgImageSvg({ label: dangerousLabel, sublabel: `<b>&"'</b>` });
      assertTrue(!svg2.includes("<script>"), "b1: raw <script> tag does not appear unescaped");
      assertTrue(!svg2.includes("<tag>"), "b2: raw <tag> does not appear unescaped");
      assertTrue(!svg2.includes("<b>"), "b3: raw <b> (from sublabel) does not appear unescaped");
      assertTrue(svg2.includes("&lt;script&gt;"), "b4: < and > are escaped to &lt;/&gt;");
      assertTrue(svg2.includes("&amp;"), "b5: & is escaped to &amp;");
      assertTrue(svg2.includes("&quot;") || svg2.includes("&#39;"), "b6: at least one of \" / ' is escaped");
      // A permissive XML parser must not choke on unbalanced/raw markup —
      // best-effort structural sanity: tag-open/close counts line up.
      const openTags = (svg2.match(/<[a-zA-Z][^>]*[^/]>/g) || []).length;
      const closeTags = (svg2.match(/<\/[a-zA-Z]+>/g) || []).length;
      assertTrue(openTags > 0 && closeTags > 0, "b7: output still contains real (non-injected) open/close tags");

      // ── (c) determinism + bounding ──────────────────────────────────
      const svgA = ogImageMod.renderExperienceOgImageSvg({ label: "Gårdsbesøk hos Nordlys Gård", sublabel: "Gårdssalg & smaking", accent: "#0e3c36" });
      const svgB = ogImageMod.renderExperienceOgImageSvg({ label: "Gårdsbesøk hos Nordlys Gård", sublabel: "Gårdssalg & smaking", accent: "#0e3c36" });
      assertEq(svgA, svgB, "c1: identical input -> byte-identical output (deterministic)");

      const veryLongLabel = "A".repeat(5000);
      let longThrew = false;
      let svgLong = "";
      try {
        svgLong = ogImageMod.renderExperienceOgImageSvg({ label: veryLongLabel, sublabel: "B".repeat(5000) });
      } catch {
        longThrew = true;
      }
      assertTrue(!longThrew, "c2: an absurdly long label/sublabel does not throw");
      assertTrue(svgLong.length > 0 && svgLong.length < 4000, "c3: output stays bounded (not proportional to a 5000-char input)");

      // ── (d) category color resolution ───────────────────────────────
      const knownColor = ogImageMod.resolveOgAccentColor("vinter_sno");
      assertEq(knownColor, ogImageMod.CATEGORY_OG_ACCENT_COLORS.vinter_sno, "d1: known category resolves to its mapped color");
      assertEq(ogImageMod.resolveOgAccentColor("not_a_real_category"), ogImageMod.DEFAULT_OG_ACCENT, "d2: unknown category falls back to DEFAULT_OG_ACCENT");
      assertEq(ogImageMod.resolveOgAccentColor(null), ogImageMod.DEFAULT_OG_ACCENT, "d3: missing category falls back to DEFAULT_OG_ACCENT");
      const distinctColors = new Set(Object.values(ogImageMod.CATEGORY_OG_ACCENT_COLORS));
      assertEq(distinctColors.size, Object.keys(ogImageMod.CATEGORY_OG_ACCENT_COLORS).length, "d4: every mapped category has a distinct color");

      // ── (e) route: basic 200 + headers ──────────────────────────────
      const r1 = await callRoute(expSeoRouter, "/og-image.svg?label=Vinter%20%26%20sn%C3%B8&sublabel=Kategori&cat=vinter_sno");
      assertTrue(r1.handled, "e1: GET /og-image.svg is handled by the experiences-seo router");
      assertEq(r1.status, 200, "e2: GET /og-image.svg -> 200");
      assertTrue((r1.headers["content-type"] || "").includes("image/svg+xml"), "e3: Content-Type is image/svg+xml");
      assertTrue(r1.body.length > 0, "e4: non-empty body");
      assertEq(r1.headers["cache-control"], "public, max-age=604800, immutable", "e5: long, immutable Cache-Control (output is deterministic from query params)");
      assertTrue(r1.body.includes("Vinter"), "e6: label text reflected in served body");

      // ── (f) route: injection attempt is escaped, not reflected raw ──
      const r2 = await callRoute(expSeoRouter, `/og-image.svg?label=${encodeURIComponent('<script>alert(1)</script>')}&sublabel=${encodeURIComponent(`"><b>x</b>`)}`);
      assertEq(r2.status, 200, "f1: injection-attempt query still -> 200");
      assertTrue(!r2.body.includes("<script>"), "f2: served body does not contain a raw <script> tag");
      assertTrue(!r2.body.includes("<b>x</b>"), "f3: served body does not contain a raw injected <b> tag");
      assertTrue(r2.body.includes("&lt;script&gt;"), "f4: the label is present, XML-escaped");

      // ── (g) route: overlong query param does not crash ──────────────
      const hugeLabel = encodeURIComponent("Z".repeat(10000));
      const r3 = await callRoute(expSeoRouter, `/og-image.svg?label=${hugeLabel}`);
      assertEq(r3.status, 200, "g1: overlong label -> still 200 (never fails closed on cosmetic input)");
      assertTrue(r3.body.length > 0 && r3.body.length < 4000, "g2: served body stays bounded despite a 10000-char query param");

      // ── (h) route: no query params -> fallback label ────────────────
      const r4 = await callRoute(expSeoRouter, "/og-image.svg");
      assertEq(r4.status, 200, "h1: no query params -> still 200");
      assertTrue(r4.body.includes("Opplevagent"), "h2: falls back to the Opplevagent wordmark/label when no label is given");

      // ── (i) wiring regression: favicon.svg og:image fallback removed ─
      const fs = require("fs");
      const expSeoSrc = fs.readFileSync(require.resolve("../routes/experiences-seo"), "utf8");
      const faviconOgImageCount = (expSeoSrc.match(/og:image" content="\$\{url\}\/favicon\.svg"/g) || []).length;
      assertEq(faviconOgImageCount, 1,
        "i1: exactly one remaining favicon.svg og:image fallback (the homepage's, explicitly out of scope) — opplevelse-detail/browse/gardssalg-produsent were migrated to /og-image.svg");
      const newRouteOgImageUsages = (expSeoSrc.match(/ogImageUrl\(url,/g) || []).length;
      assertEq(newRouteOgImageUsages, 3,
        "i2: ogImageUrl() is wired into exactly the three in-scope templates (opplevelse-detail, browse, gardssalg-produsent)");
    } catch (err: any) {
      failed++;
      failures.push("experience-og-image: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
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
      for (const p of [dbFactoryPath, ogImagePath, expSeoPath]) {
        delete require.cache[p];
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/experience-og-image.test.ts`
if (require.main === module) {
  runExperienceOgImageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
