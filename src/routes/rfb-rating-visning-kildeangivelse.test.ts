/**
 * rfb-rating-visning-kildeangivelse.test.ts — dev-request
 * 2026-10-16-rfb-strukturerte-data-tredjepartsrating-og-places-treffvakt, S2
 * and S4-A1a.
 *
 * The stored rating is Google's. Every place rettfrabonden.com shows it — the
 * producer profile stat, the ultra-rich homepage card (positions 1-3) and the
 * medium-rich homepage card (positions 4-11) — renders it through
 * formatRatingDisplay (src/services/structured-data-policy.ts):
 *   - the source is named: «… på Google» / «… on Google»;
 *   - the count is shown only when known: no «0 anmeldelser» (the profile used
 *     to print `googleReviewCount || 0`);
 *   - RATING_DISPLAY_MODE 'hidden' leaves no rating text on any of them.
 * Matrix: 3 places × no/en × count known/unknown × both modes, plus a
 * producer without a rating (nothing shown).
 *
 * Since S4-A1a (Daniel's decision 2=A) 'hidden' is the default, so that part
 * runs without an override and checks what production renders; 'attributed'
 * (S2) is set with __setRatingDisplayModeForTesting (restored in finally).
 *
 * Same harness as rfb-verifisert-av-eier-badge-rename.test.ts: own
 * `Database(":memory:")`, claimed + verified high-trust producers so the
 * homepage renders the rich cards, the real seo.ts handlers off the route
 * stack.
 *
 * Exported runRfbRatingVisningKildeangivelseTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-rating-visning-kildeangivelse.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runRfbRatingVisningKildeangivelseTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const policy = require("../services/structured-data-policy") as typeof import("../services/structured-data-policy");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedClaimedProducer(id: string, name: string, trust: number, rating: number | null, count: number | null): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]', 'Oslo', 59.91, 10.75,
        ?, 1, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(id, name, "En beskrivelse", name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`, trust);
    testDb.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
       VALUES (?, ?, 'Test Eier', ?, 'verified', datetime('now'))`,
    ).run(`claim-${id}`, id, `${id}-owner@example.no`);
    testDb.prepare(
      `INSERT INTO agent_knowledge (agent_id, google_rating, google_review_count) VALUES (?, ?, ?)`,
    ).run(id, rating, count);
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }

    // Positions 0-2 -> ultra-rich card; 3-4 -> medium-rich card.
    seedClaimedProducer("ultra-count", "Ultra Kjent Gaard", 0.95, 4.6, 236);
    seedClaimedProducer("ultra-nocount", "Ultra Ukjent Gaard", 0.94, 4.6, null);
    seedClaimedProducer("ultra-norating", "Ultra Uvurdert Gaard", 0.93, null, null);
    seedClaimedProducer("medium-count", "Medium Kjent Gaard", 0.80, 4.2, 18);
    seedClaimedProducer("medium-nocount", "Medium Ukjent Gaard", 0.79, 4.2, 0);
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const seoRoutePath = require.resolve("./seo");
    delete require.cache[seoRoutePath];
    const seoRouter = require("./seo").default as any;
    function invoke(routePath: string, req: any): { status: number; body: string } {
      const layer = (seoRouter.stack as any[]).find((l: any) => l.route?.path === routePath && l.route.methods?.get);
      assertTrue(!!layer, `setup: GET ${routePath} layer is registered`);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: (_c: number, _l: string) => { status = 301; return res; },
      };
      handler(req, res, () => {});
      return { status, body };
    }
    function card(body: string, slug: string, lang: "no" | "en", tier: "ultra" | "medium"): string {
      const href = `${lang === "en" ? "/en" : ""}/produsent/${slug}`;
      const m = new RegExp(`<a href="${href}" class="pc pc-${tier}">([\\s\\S]*?)</a>`).exec(body);
      assertTrue(!!m, `setup: ${tier} card for ${slug} (${lang}) is on the homepage`);
      return m ? m[1] : "";
    }
    const ratingSpans = (html: string): string[] => [...html.matchAll(/<span class="pc-rating">([^<]*)<\/span>/g)].map((m) => m[1]);
    // Page-wide: no "0 anmeldelser"/"0 reviews". (A bare "(0)" is a category chip count.)
    const ZERO_COUNT = /\b0 (anmeldelser|reviews)\b/;
    const RATING_STAT = /<div class="pf-stat"><div class="pf-stat-icon r">/;

    // ══════════════════════════════════════════════════════════════
    // Mode 'attributed' (S2; set by the test since S4-A1a)
    // ══════════════════════════════════════════════════════════════
    policy.__setRatingDisplayModeForTesting("attributed");
    const expected = {
      no: { ultraCount: "★ 4.6 · 236 anmeldelser på Google", ultraNo: "★ 4.6 på Google", medCount: "★ 4.2 · 18 anmeldelser på Google", medNo: "★ 4.2 på Google",
        statCount: "<strong>4.6 / 5</strong><small>236 anmeldelser på Google</small>", statNo: "<strong>4.6 / 5</strong><small>på Google</small>" },
      en: { ultraCount: "★ 4.6 · 236 reviews on Google", ultraNo: "★ 4.6 on Google", medCount: "★ 4.2 · 18 reviews on Google", medNo: "★ 4.2 on Google",
        statCount: "<strong>4.6 / 5</strong><small>236 reviews on Google</small>", statNo: "<strong>4.6 / 5</strong><small>on Google</small>" },
    } as const;
    for (const lang of ["no", "en"] as const) {
      const e = expected[lang];
      const home = invoke("/", { lang, query: {} });
      assertTrue(home.status === 200, `attributed ${lang}: homepage renders 200`);
      assertTrue(ratingSpans(card(home.body, "ultra-kjent-gaard", lang, "ultra")).join("|") === e.ultraCount,
        `attributed ${lang}: ultra card, count known -> "${e.ultraCount}"`);
      assertTrue(ratingSpans(card(home.body, "ultra-ukjent-gaard", lang, "ultra")).join("|") === e.ultraNo,
        `attributed ${lang}: ultra card, count unknown -> "${e.ultraNo}" (no number)`);
      assertTrue(ratingSpans(card(home.body, "ultra-uvurdert-gaard", lang, "ultra")).length === 0,
        `attributed ${lang}: ultra card without a rating shows no rating`);
      assertTrue(ratingSpans(card(home.body, "medium-kjent-gaard", lang, "medium")).join("|") === e.medCount,
        `attributed ${lang}: medium card, count known -> "${e.medCount}"`);
      assertTrue(ratingSpans(card(home.body, "medium-ukjent-gaard", lang, "medium")).join("|") === e.medNo,
        `attributed ${lang}: medium card, count 0 -> "${e.medNo}" (never 0)`);
      const spans = ratingSpans(home.body);
      assertTrue(spans.length === 4 && spans.every((s) => s.includes("Google")), `attributed ${lang}: every rating on the homepage names Google (${spans.length})`);
      assertTrue(spans.every((s) => !/\(\d+\)|\b0\b/.test(s)), `attributed ${lang}: no card rating carries a bare "(n)" or a 0 count`);
      assertTrue(!ZERO_COUNT.test(home.body), `attributed ${lang}: homepage never shows a zero review count`);

      const pCount = invoke("/produsent/:slug", { params: { slug: "ultra-kjent-gaard" }, lang, ip: "127.0.0.1" });
      assertTrue(pCount.status === 200 && pCount.body.includes(e.statCount), `attributed ${lang}: profile stat, count known -> ${e.statCount}`);
      const pNo = invoke("/produsent/:slug", { params: { slug: "ultra-ukjent-gaard" }, lang, ip: "127.0.0.1" });
      assertTrue(pNo.status === 200 && pNo.body.includes(e.statNo), `attributed ${lang}: profile stat, count unknown -> ${e.statNo}`);
      assertTrue(!ZERO_COUNT.test(pNo.body), `attributed ${lang}: profile without a count never shows "0 ${lang === "en" ? "reviews" : "anmeldelser"}"`);
      const pNone = invoke("/produsent/:slug", { params: { slug: "ultra-uvurdert-gaard" }, lang, ip: "127.0.0.1" });
      assertTrue(pNone.status === 200 && !RATING_STAT.test(pNone.body), `attributed ${lang}: profile without a rating has no rating stat`);
    }

    // ══════════════════════════════════════════════════════════════
    // Mode 'hidden': the default since S4-A1a, so no override
    // ══════════════════════════════════════════════════════════════
    policy.__setRatingDisplayModeForTesting(null);
    assertTrue(policy.RATING_DISPLAY_MODE === "hidden", "hidden: RATING_DISPLAY_MODE is 'hidden' without an override (S4-A1a)");
    for (const lang of ["no", "en"] as const) {
      const noRatingText = (html: string): boolean =>
        !html.includes('class="pc-rating"') && !RATING_STAT.test(html) && !/★ \d\.\d/.test(html)
        && !/\d\.\d \/ 5/.test(html) && !/(anmeldelser?|reviews?) (på|on) Google/.test(html) && !/<small>(på|on) Google<\/small>/.test(html);
      const home = invoke("/", { lang, query: {} });
      assertTrue(home.status === 200 && home.body.includes("Ultra Kjent Gaard") && home.body.includes("Medium Kjent Gaard"),
        `hidden ${lang}: homepage still renders the rich cards`);
      assertTrue(noRatingText(home.body), `hidden ${lang}: no rating text anywhere on the homepage (both card tiers)`);
      for (const slug of ["ultra-kjent-gaard", "ultra-ukjent-gaard"]) {
        const p = invoke("/produsent/:slug", { params: { slug }, lang, ip: "127.0.0.1" });
        assertTrue(p.status === 200 && noRatingText(p.body), `hidden ${lang}: no rating text anywhere on /produsent/${slug}`);
      }
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-rating-visning-kildeangivelse: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    policy.__setRatingDisplayModeForTesting(null);
    if (prevDb) __setDbForTesting(prevDb);
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

// Standalone runner: `npx tsx src/routes/rfb-rating-visning-kildeangivelse.test.ts`
if (require.main === module) {
  console.log("── RFB visible rating with source attribution (dev-request 2026-10-16 S2) ──");
  runRfbRatingVisningKildeangivelseTests({ log: true }).then((r) => {
    console.log(`\nrfb-rating-visning-kildeangivelse: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
