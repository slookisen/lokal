/**
 * experiences-seo-pwa.test.ts — route-level tests for the opplevagent.no PWA
 * (dev-request 2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering,
 * extending the already-shipped rfb-only PWA rollout, dev-request
 * 2026-07-04-app-strategi-pwa / PRs #225/#245, to opplevagent.no).
 *
 * Covers:
 *   (a) GET /favicon-192.png and /favicon-512.png return 200 with
 *       Content-Type image/png (the pre-placed constellation-mark PNGs).
 *   (b) GET /manifest.json returns 200, valid JSON, and the required PWA
 *       fields: name, short_name (<=12 chars), start_url "/", display
 *       "standalone", an icons array with BOTH /favicon-192.png (192x192)
 *       and /favicon-512.png (512x512), each type "image/png".
 *   (c) GET /sw.js, /install-prompt.js, /offline.html all return 200 (the
 *       new opplevagent-branded static files served via res.sendFile()-style
 *       reads from src/public/opplevagent-*).
 *   (d) The regression guard: pwaHeadTags() actually landed on a sample of
 *       page-shell templates — homepage ("/"), a kategori page
 *       (/kategori/gardssalg), the opplevelse-detail page
 *       (/opplevelse/:slug), and the produsent-profil page
 *       (/tilbyder/:slug) — each renders `rel="manifest"` + the
 *       /sw.js registration script + the two new favicon-*.png <link
 *       rel="icon"> tags + the install-prompt.js <script> tag. A future page
 *       template that forgets to call pwaHeadTags() would be caught here,
 *       not discovered live.
 *
 * Same synthetic router.handle() harness + in-memory-DB pattern as
 * experiences-seo-site-chrome.test.ts / experiences-seo-kategorifarger.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-pwa.test.ts
 *   2. Wired into the gate: tests/test.ts imports runExperiencesSeoPwaTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling experiences-seo
// test files — extended to also capture response headers (setHeader calls),
// since (a)/(b)/(c) need to assert Content-Type.
function callRoute(
  router: any,
  url: string,
  lang: "no" | "en" = "no"
): Promise<{ handled: boolean; status: number; body: string; headers: Record<string, string> }> {
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
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = String(value);
      },
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body), headers });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "", headers });
    });
  });
}

// One published experience (+ its verified provider) — same shape as
// experiences-seo-site-chrome.test.ts's seedPublishedExperience(), plus an
// explicit slug for predictable /opplevelse/:slug + /tilbyder/:slug URLs.
function seedPublishedExperience(
  store: any,
  opts: { slug: string; title: string; fylke?: string; kommune?: string; category?: string }
): { providerId: string; experienceSlug: string } {
  const providerId = store.createProvider({
    navn: `${opts.title} AS`,
    fylke: opts.fylke ?? "Vestland",
    kommune: opts.kommune ?? "Bergen",
    brreg_verified: 1,
    brreg_active: 1,
    verification_status: "verified",
  });
  store.createExperience({
    title: opts.title,
    slug: opts.slug,
    provider_id: providerId,
    provider_match_status: "matched",
    kommune: opts.kommune ?? "Bergen",
    fylke: opts.fylke ?? "Vestland",
    category: opts.category ?? "natur_friluft",
    verification_status: "verified",
    confidence: "high",
  });
  return { providerId, experienceSlug: opts.slug };
}

// (d)'s 4-marker PWA-tag probe, shared across all sampled page shells.
function assertPwaHeadTags(body: string, pageLabel: string, assertTrue: (cond: boolean, label: string) => void): void {
  assertTrue(body.includes('<link rel="icon" href="/favicon-192.png" sizes="192x192" type="image/png">'), `${pageLabel}: has <link rel="icon"> for favicon-192.png`);
  assertTrue(body.includes('<link rel="icon" href="/favicon-512.png" sizes="512x512" type="image/png">'), `${pageLabel}: has <link rel="icon"> for favicon-512.png`);
  assertTrue(body.includes('<link rel="manifest" href="/manifest.json">'), `${pageLabel}: has <link rel="manifest">`);
  assertTrue(body.includes("navigator.serviceWorker.register('/sw.js')"), `${pageLabel}: registers /sw.js`);
  assertTrue(body.includes('<script defer src="/install-prompt.js"></script>'), `${pageLabel}: loads install-prompt.js`);
}

export function runExperiencesSeoPwaTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      const { providerId, experienceSlug } = seedPublishedExperience(store, {
        slug: "pwa-test-opplevelse",
        title: "PWA-testtur (regresjonsfixtur)",
      });
      store.backfillProviderSlugs();
      const providerSlug = store.getProviderById(providerId)?.slug as string | undefined;

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (a) favicon PNG routes ─────────────────────────────────────────
      const fav192 = await callRoute(seoRouter, "/favicon-192.png");
      assertTrue(fav192.handled && fav192.status === 200, `a1: GET /favicon-192.png renders 200 (got ${fav192.status})`);
      assertTrue(fav192.headers["content-type"] === "image/png", `a2: GET /favicon-192.png Content-Type is image/png (got ${fav192.headers["content-type"]})`);
      assertTrue(fav192.body.length > 0, "a3: GET /favicon-192.png returns a non-empty body");

      const fav512 = await callRoute(seoRouter, "/favicon-512.png");
      assertTrue(fav512.handled && fav512.status === 200, `a4: GET /favicon-512.png renders 200 (got ${fav512.status})`);
      assertTrue(fav512.headers["content-type"] === "image/png", `a5: GET /favicon-512.png Content-Type is image/png (got ${fav512.headers["content-type"]})`);
      assertTrue(fav512.body.length > 0, "a6: GET /favicon-512.png returns a non-empty body");

      // ── (b) manifest.json ───────────────────────────────────────────────
      const manifest = await callRoute(seoRouter, "/manifest.json");
      assertTrue(manifest.handled && manifest.status === 200, `b1: GET /manifest.json renders 200 (got ${manifest.status})`);
      assertTrue(
        (manifest.headers["content-type"] || "").includes("application/json"),
        `b2: GET /manifest.json Content-Type is application/json (got ${manifest.headers["content-type"]})`
      );
      let parsedManifest: any = null;
      try {
        parsedManifest = JSON.parse(manifest.body);
        assertTrue(true, "b3: manifest.json body is valid JSON");
      } catch (err) {
        assertTrue(false, `b3: manifest.json body is valid JSON (parse error: ${err instanceof Error ? err.message : String(err)})`);
      }
      if (parsedManifest) {
        assertTrue(typeof parsedManifest.name === "string" && parsedManifest.name.length > 0, "b4: manifest.name is a non-empty string");
        assertTrue(
          typeof parsedManifest.short_name === "string" && parsedManifest.short_name.length > 0 && parsedManifest.short_name.length <= 12,
          `b5: manifest.short_name is a non-empty string <=12 chars (got "${parsedManifest.short_name}", length ${String(parsedManifest.short_name || "").length})`
        );
        assertTrue(parsedManifest.start_url === "/", "b6: manifest.start_url is '/'");
        assertTrue(parsedManifest.display === "standalone", "b7: manifest.display is 'standalone'");
        assertTrue(Array.isArray(parsedManifest.icons) && parsedManifest.icons.length >= 2, "b8: manifest.icons has at least 2 entries");
        const icons = Array.isArray(parsedManifest.icons) ? parsedManifest.icons : [];
        const icon192 = icons.find((i: any) => i.src === "/favicon-192.png");
        const icon512 = icons.find((i: any) => i.src === "/favicon-512.png");
        assertTrue(!!icon192 && icon192.sizes === "192x192" && icon192.type === "image/png", "b9: manifest.icons includes /favicon-192.png at 192x192, type image/png");
        assertTrue(!!icon512 && icon512.sizes === "512x512" && icon512.type === "image/png", "b10: manifest.icons includes /favicon-512.png at 512x512, type image/png");
      }

      // ── (c) sw.js / install-prompt.js / offline.html ───────────────────
      const sw = await callRoute(seoRouter, "/sw.js");
      assertTrue(sw.handled && sw.status === 200, `c1: GET /sw.js renders 200 (got ${sw.status})`);
      assertTrue(sw.body.includes("opplevagent-pwa-v1"), "c2: served sw.js body carries the opplevagent CACHE_VERSION");

      const ip = await callRoute(seoRouter, "/install-prompt.js");
      assertTrue(ip.handled && ip.status === 200, `c3: GET /install-prompt.js renders 200 (got ${ip.status})`);
      assertTrue(ip.body.includes("beforeinstallprompt"), "c4: served install-prompt.js wires up beforeinstallprompt");

      const offline = await callRoute(seoRouter, "/offline.html");
      assertTrue(offline.handled && offline.status === 200, `c5: GET /offline.html renders 200 (got ${offline.status})`);
      assertTrue(offline.body.includes("Du er offline"), "c6: served offline.html contains the 'Du er offline' message");

      // ── (d) page-shell regression guard ─────────────────────────────────
      const home = await callRoute(seoRouter, "/");
      assertTrue(home.handled && home.status === 200, `d1: GET / renders 200 (got ${home.status})`);
      assertPwaHeadTags(home.body, "d-home", assertTrue);

      const kategori = await callRoute(seoRouter, "/kategori/gardssalg");
      assertTrue(kategori.handled && kategori.status === 200, `d2: GET /kategori/gardssalg renders 200 (got ${kategori.status})`);
      assertPwaHeadTags(kategori.body, "d-kategori", assertTrue);

      const detail = await callRoute(seoRouter, `/opplevelse/${experienceSlug}`);
      assertTrue(detail.handled && detail.status === 200, `d3: GET /opplevelse/${experienceSlug} renders 200 (got ${detail.status})`);
      assertPwaHeadTags(detail.body, "d-opplevelse-detail", assertTrue);

      if (providerSlug) {
        const produsent = await callRoute(seoRouter, `/tilbyder/${providerSlug}`);
        assertTrue(produsent.handled && produsent.status === 200, `d4: GET /tilbyder/${providerSlug} renders 200 (got ${produsent.status})`);
        assertPwaHeadTags(produsent.body, "d-produsent-profil", assertTrue);
      } else {
        assertTrue(false, "d4: could not resolve a provider slug to exercise /tilbyder/:slug");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-pwa: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoPwaTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
