/**
 * rfb-homepage-category-chips.test.ts — dev-request
 * 2026-07-31-rfb-homepage-kategori-konsolidering.
 *
 * Covers the RFB homepage (GET / and GET /en, src/routes/seo.ts) change that:
 *   1. Merges the 4 ad-hoc hero-chips ("Grønnsaker i Oslo", "Honning i Oslo",
 *      "Økologisk kjøtt", "Gårdsbutikker") and the standalone big-card
 *      "Kategorier — Hva leter du etter?" grid into ONE compact pill row
 *      (reusing `.chip`), built from all 10 CATEGORY_MAP categories with
 *      live counts, right under the search box.
 *   2. Removes the "Populære byer"/"Popular cities" section entirely
 *      (both locales), without touching the `/:city` route itself.
 *
 * Same harness convention as produsent-role-gate.test.ts: own in-memory DB
 * via __setDbForTesting/__initSchemaForTesting, the REAL router's handlers
 * pulled off the route stack and invoked directly with a fake req/res (no
 * HTTP server, no port).
 *
 * Exported runHomepageCategoryChipsTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/rfb-homepage-category-chips.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Mirrors CATEGORY_MAP in seo.ts (kept in sync manually — a drift here would
// make this suite assert against the wrong list, not the production one).
const CATEGORY_MAP_KEYS_TO_NAMES: Record<string, string> = {
  vegetables: "Grønnsaker",
  fruit: "Frukt",
  berries: "Bær",
  dairy: "Meieri",
  eggs: "Egg",
  meat: "Kjøtt",
  fish: "Fisk",
  bread: "Brød",
  honey: "Honning",
  herbs: "Urter",
};

// 2026-09-03 (Daniel, skjermbilde av /en): the English homepage now shows
// English category labels. Hard-coded here on purpose — a real expectation,
// not a re-read of CATEGORY_MAP — so a regression to Norwegian on /en fails.
const CATEGORY_MAP_KEYS_TO_NAMES_EN: Record<string, string> = {
  vegetables: "Vegetables",
  fruit: "Fruit",
  berries: "Berries",
  dairy: "Dairy",
  eggs: "Eggs",
  meat: "Meat",
  fish: "Fish",
  bread: "Bread",
  honey: "Honey",
  herbs: "Herbs",
};

export async function runHomepageCategoryChipsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedAgent(row: {
    id: string; name: string; categories?: string[]; city?: string | null;
    lat?: number | null; lng?: number | null;
  }): void {
    // marketplace-registry.ts's rowToAgent() only surfaces `city` nested
    // under `location.city`, and `location` is only built when BOTH lat AND
    // lng are non-null — a bare `city` column with no coordinates is
    // invisible to the /:city route (which reads `a.city || a.location?.city`).
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        ?, '[]', '[]', '{}', '["no"]', ?, ?, ?,
        0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, JSON.stringify(row.categories || []),
      row.city ?? null, row.lat ?? null, row.lng ?? null,
    );
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // One producer per CATEGORY_MAP category (so every chip gets a live
    // count > 0), plus one in Oslo so /:city still resolves.
    let i = 0;
    for (const key of Object.keys(CATEGORY_MAP_KEYS_TO_NAMES)) {
      i++;
      seedAgent({
        id: `cat-${key}`, name: `Testgård ${key}`, categories: [key],
        city: i === 1 ? "Oslo" : undefined,
        lat: i === 1 ? 59.91 : undefined, lng: i === 1 ? 10.75 : undefined,
      });
    }

    // marketplaceRegistry.getActiveAgents() caches its rows for 60s
    // (module-level singleton, independent of the DB swap above) — every
    // other suite in this file that seeds fixtures and then reads through
    // getActiveAgents() resets this cache first (see e.g. the phase5.11-a4.4
    // block), otherwise a still-warm cache from an earlier suite's DB would
    // silently answer our queries instead of our fixtures.
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    // seo.ts's shell() calls getConfig(), which throws unless the vertical
    // configs were cold-loaded at boot — same best-effort load as
    // produsent-role-gate.test.ts / reise-page.test.ts.
    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }

    const seoRoutePath = require.resolve("./seo");
    delete require.cache[seoRoutePath];
    const seoRouter = require("./seo").default as any;

    function findLayer(routePath: string) {
      return (seoRouter.stack as any[]).find(
        (l: any) => l.route && l.route.path === routePath && l.route.methods?.get,
      );
    }
    function invoke(routePath: string, req: any): { status: number; body: string } {
      const layer = findLayer(routePath);
      assertTrue(!!layer, `setup: GET ${routePath} layer is registered`);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: (_c: number, _l: string) => { status = 301; return res; },
      };
      handler(req, res, (_e?: unknown) => {});
      return { status, body };
    }

    function checkHomepage(lang: "no" | "en", label: string) {
      const r = invoke("/", { lang, query: {} });
      assertEq(r.status, 200, `${label}: homepage renders 200`);

      // ── (1) exactly one category chip/pill row, all 10 categories, once each ──
      const rowMatches = [...r.body.matchAll(/<div class="hero-chips">([\s\S]*?)<\/div>/g)];
      assertEq(rowMatches.length, 1, `${label}: exactly one hero-chips pill row on the page`);
      const rowHtml = rowMatches[0]?.[1] || "";
      const chipCount = (rowHtml.match(/class="chip"/g) || []).length;
      assertEq(chipCount, 10, `${label}: pill row contains exactly 10 chips (one per CATEGORY_MAP category)`);
      // Labels follow the page language (2026-09-03): Norwegian on /, English on /en.
      const expectedNames = lang === "en" ? CATEGORY_MAP_KEYS_TO_NAMES_EN : CATEGORY_MAP_KEYS_TO_NAMES;
      for (const name of Object.values(expectedNames)) {
        const occurrences = rowHtml.split(name).length - 1;
        assertEq(occurrences, 1, `${label}: "${name}" appears exactly once in the pill row`);
      }
      // …and the other language's labels must NOT leak into this page's row.
      const otherNames = lang === "en" ? CATEGORY_MAP_KEYS_TO_NAMES : CATEGORY_MAP_KEYS_TO_NAMES_EN;
      const leaked = Object.values(otherNames).filter((n) => n !== "Egg" && rowHtml.includes(n)); // "Egg" is a substring of "Eggs"
      assertEq(leaked, [], `${label}: no ${lang === "en" ? "Norwegian" : "English"} category label leaks into the pill row`);
      // Live counts rendered compactly, e.g. "Grønnsaker (1)" / "Vegetables (1)".
      const first = lang === "en" ? "Vegetables" : "Grønnsaker";
      assertTrue(new RegExp(`${first} \\(\\d+\\)`).test(rowHtml),
        `${label}: pill row shows a live count next to a category name`);

      // ── (2) the 3 old ad-hoc duplicate chips are gone (by their old,
      //    now-orphaned href query strings — the new pills use a bare
      //    category name with no "oslo"/city suffix) ──
      assertTrue(!r.body.includes(encodeURIComponent("grønnsaker oslo")),
        `${label}: old "Grønnsaker i Oslo" chip href (q=grønnsaker+oslo) is gone`);
      assertTrue(!r.body.includes(encodeURIComponent("honning oslo")),
        `${label}: old "Honning i Oslo" chip href (q=honning+oslo) is gone`);
      assertTrue(!r.body.includes(encodeURIComponent("økologisk kjøtt")),
        `${label}: old "Økologisk kjøtt" chip href (q=økologisk+kjøtt) is gone`);
      // "Gårdsbutikker" the old ad-hoc /sok text-search chip is dropped too —
      // NOT expected to reappear as a q=gårdsbutikk search-link inside the
      // merged pill row (its own salgskanal section, if rendered, links to
      // /kategori/... instead, so this href shape is unambiguous).
      assertTrue(!r.body.includes(encodeURIComponent("gårdsbutikk") + "\" class=\"chip\""),
        `${label}: old "Gårdsbutikker" /sok text-chip is gone`);

      // ── (3) the standalone big-card "Kategorier" grid section is gone ──
      // (its heading copy is fully retired — no code path can still emit it)
      assertTrue(!r.body.includes("Hva leter du etter?"),
        `${label}: old cats-section heading "Hva leter du etter?" no longer renders`);
      assertTrue(!r.body.includes("What are you looking for?"),
        `${label}: old cats-section heading "What are you looking for?" no longer renders`);
      // The un-styled cats-section (the CATEGORY_MAP big grid) is gone; only
      // the salgskanal section (which carries a style= attribute) may remain.
      assertTrue(!r.body.includes('<section class="cats-section">'),
        `${label}: standalone (un-styled) cats-section wrapper no longer renders`);

      // ── (4) "Populære byer"/"Popular cities" section is gone ──
      assertTrue(!r.body.includes("Populære byer"),
        `${label}: "Populære byer" heading no longer renders`);
      assertTrue(!r.body.includes("Popular cities"),
        `${label}: "Popular cities" heading no longer renders`);
      assertTrue(!r.body.includes('class="cities-grid"'),
        `${label}: cities-grid section no longer renders`);
      assertTrue(!r.body.includes('class="city-card"'),
        `${label}: no city-card renders anywhere on the homepage`);

      // ── (5) other homepage sections are untouched ──
      assertTrue(r.body.includes('class="stats-bar"'), `${label}: stats-bar section still renders (untouched)`);
      assertTrue(r.body.includes('class="hero-search"'), `${label}: hero-search box still renders (untouched)`);
      assertTrue(r.body.includes('id="homeGeoBtn"'), `${label}: "Find near me" button still renders (untouched)`);
      assertTrue(r.body.includes('class="ai-assist"'), `${label}: AI-assist CTA still renders (untouched)`);
    }

    checkHomepage("no", "GET /");
    checkHomepage("en", "GET /en");

    // ── (6) /:city (e.g. /oslo) still resolves normally — city pages are
    //    not touched by this change, only the homepage link to them. ──
    {
      const r = invoke("/:city", { params: { city: "oslo" }, lang: "no", query: {} });
      assertEq(r.status, 200, "city: GET /oslo still resolves 200 (unaffected by the homepage change)");
      assertTrue(r.body.includes("Oslo"), "city: /oslo page body mentions Oslo");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-homepage-category-chips: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
    // Leave the singleton cache cold so the NEXT suite doesn't inherit our
    // throwaway fixtures either.
    try {
      const regModCleanup = require("../services/marketplace-registry");
      regModCleanup.marketplaceRegistry._agentsCache = null;
      regModCleanup.marketplaceRegistry._statsCache = null;
    } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-homepage-category-chips.test.ts`
if (require.main === module) {
  console.log("── RFB homepage category-chip consolidation (dev-request 2026-07-31-rfb-homepage-kategori-konsolidering) unit tests ──");
  runHomepageCategoryChipsTests({ log: true }).then((r) => {
    console.log(`\nrfb-homepage-category-chips: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
