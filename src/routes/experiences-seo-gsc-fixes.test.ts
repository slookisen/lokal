/**
 * experiences-seo-gsc-fixes.test.ts — tests for the opplevagent.no GSC
 * indekseringsfiks (dev-request 2026-07-19-opplevagent-gsc-indekseringsfikser),
 * porting the rettfrabonden.com crawl-budget-bleed fix (PR #302) to
 * src/routes/experiences-seo.ts.
 *
 * Covers:
 *   (a) robots.txt: GARDSSALG_ROBOTS_DISALLOWS is present in EVERY
 *       user-agent group — the exact bug class PR #302 fixed for rfb was
 *       Googlebot/Bingbot being silently exempted because "Allow: /" was
 *       their only rule and the Disallow lines only lived under "User-agent:
 *       *" (a crawler matching its own named group ignores "*" entirely).
 *       Also asserts genuinely-public paths (produsent profile, the booking
 *       FORM, /sok) are NOT disallowed.
 *   (b) sitemap.xml lastmod honesty: category/gårdssalg-category/produsent
 *       lastmod reflects real underlying data (MAX(updated_at) / per-row
 *       updated_at), not a blanket "today" stamped on every request.
 *
 * Exported runExperiencesSeoGscFixesTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/experiences-seo-gsc-fixes.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runExperiencesSeoGscFixesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  // Invokes a GET layer on an Express router directly (sync mock req/res) —
  // same pattern tests/test.ts uses for this router (orch19-06/sq-detail).
  function invokeGet(
    router: any,
    routePath: string,
    params: Record<string, string> = {},
    reqPath?: string
  ): { status: number; body: string; headers: Record<string, string> } {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === routePath && l.route.methods?.get
    );
    assertTrue(!!layer, `gsc-fixes: router has a GET ${routePath} layer`);
    let status = 200;
    let body = "";
    let nexted = false;
    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = String(v); },
      header: (k: string, v: string) => { headers[k.toLowerCase()] = String(v); return res; },
      status: (c: number) => { status = c; res.statusCode = c; return res; },
      send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
      json: (o: unknown) => { body = JSON.stringify(o); return res; },
    };
    const req: any = { path: reqPath ?? routePath, hostname: "opplevagent.no", params, query: {} };
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    handler(req, res, () => { nexted = true; });
    if (nexted) status = 404;
    return { status, body, headers };
  }

  // Extracts the "User-agent: <name>" stanza body up to the next blank line.
  function stanzaFor(robotsBody: string, uaName: string): string {
    const re = new RegExp(`User-agent: ${uaName}\\n([\\s\\S]*?)(?:\\n\\n|$)`);
    const m = robotsBody.match(re);
    return m ? m[1] : "";
  }

  const EXPECTED_DISALLOWS = [
    "Disallow: /kategori/gardssalg/eier/",
    "Disallow: /kategori/gardssalg/book/*/confirm/",
    "Disallow: /kategori/gardssalg/bekreft/",
    "Disallow: /kategori/gardssalg/svar/",
    "Disallow: /kategori/gardssalg/gjestesvar/",
    "Disallow: /kategori/gardssalg/status/",
    "Disallow: /admin/",
  ];

  // ── (a) robots.txt ──────────────────────────────────────────────────────
  {
    const expSeo = require("./experiences-seo") as typeof import("./experiences-seo");
    const router = expSeo.default as any;
    const robots = invokeGet(router, "/robots.txt");
    assertEq(robots.status, 200, "gsc-a-00: GET /robots.txt -> 200");

    // The exact bug class: Googlebot and Bingbot must carry the FULL
    // Disallow list, not just "Allow: /" (PR #302's root cause for rfb).
    for (const ua of ["Googlebot", "Bingbot"]) {
      const stanza = stanzaFor(robots.body, ua);
      assertTrue(stanza.length > 0, `gsc-a-01: robots.txt has a User-agent: ${ua} stanza`);
      for (const line of EXPECTED_DISALLOWS) {
        assertTrue(stanza.includes(line), `gsc-a-02: ${ua} stanza includes "${line}"`);
      }
      assertTrue(stanza.includes("Allow: /"), `gsc-a-03: ${ua} stanza still carries "Allow: /"`);
    }

    // Every other user-agent group in this file's robots.txt must ALSO carry
    // the full list — no group is exempted this time (that was the bug).
    for (const ua of ["*", "GPTBot", "OAI-SearchBot", "ClaudeBot", "anthropic-ai", "PerplexityBot", "Google-Extended"]) {
      const stanza = stanzaFor(robots.body, ua.replace("*", "\\*"));
      assertTrue(stanza.length > 0, `gsc-a-04: robots.txt has a User-agent: ${ua} stanza`);
      for (const line of EXPECTED_DISALLOWS) {
        assertTrue(stanza.includes(line), `gsc-a-05: ${ua} stanza includes "${line}"`);
      }
    }

    // Genuinely public / already-handled-via-meta-tag paths must NOT be
    // Disallow-blocked (dev-request's own risk analysis / guardrail).
    assertTrue(!robots.body.includes("Disallow: /kategori/gardssalg/produsent"),
      "gsc-a-06: producer profile pages (/kategori/gardssalg/produsent/) are NOT disallowed");
    assertTrue(!robots.body.includes("Disallow: /sok"),
      "gsc-a-07: /sok is NOT disallowed (already noindex,follow via meta tag)");
    // The booking FORM itself (no /confirm/) must stay crawlable — only the
    // wildcarded .../book/*/confirm/ sub-path is disallowed. A bare
    // "Disallow: /kategori/gardssalg/book/" (no wildcard/suffix) would also
    // block the form, so assert that exact bare line is absent.
    assertTrue(!/Disallow: \/kategori\/gardssalg\/book\/\s*$/m.test(robots.body),
      "gsc-a-08: the booking form path (no /confirm/) is NOT bare-disallowed");
    assertTrue(robots.body.includes("Disallow: /kategori/gardssalg/book/*/confirm/"),
      "gsc-a-09: only the wildcarded .../book/*/confirm/ sub-path is disallowed");
  }

  // ── (b) sitemap.xml lastmod honesty ─────────────────────────────────────
  {
    const prevPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const expSeoPath = require.resolve("./experiences-seo");
    for (const p of [dbFactoryPath, expStorePath, expSeoPath]) delete require.cache[p];

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
    const router = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

    try {
      const db = dbFactory.getDb("experiences") as any;

      // ── category lastmod: MAX(updated_at) of the underlying rows ─────────
      const provId = expStore.createProvider({
        navn: "Sauda Skisenter AS", org_nr: "999000111",
        fylke: "Rogaland", kommune: "Sauda", hjemmeside: "https://example-sauda.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const olderExpId = expStore.createExperience({
        title: "Alpint i Svandalen", provider_id: provId, provider_match_status: "matched",
        category: "vinter_sno", fylke: "Rogaland", kommune: "Sauda", indoor_outdoor: "outdoor",
        confidence: "high", verification_status: "verified",
      });
      const newerExpId = expStore.createExperience({
        title: "Langrenn i Svandalen", provider_id: provId, provider_match_status: "matched",
        category: "vinter_sno", fylke: "Rogaland", kommune: "Sauda", indoor_outdoor: "outdoor",
        confidence: "high", verification_status: "verified",
      });
      db.prepare("UPDATE experiences SET updated_at = ? WHERE id = ?").run("2020-01-05 10:00:00", olderExpId);
      db.prepare("UPDATE experiences SET updated_at = ? WHERE id = ?").run("2021-06-15 08:30:00", newerExpId);

      const today = new Date().toISOString().slice(0, 10);
      const sm1 = invokeGet(router, "/sitemap.xml");
      assertEq(sm1.status, 200, "gsc-b-00: GET /sitemap.xml -> 200");
      const catMatch = sm1.body.match(/<url><loc>[^<]*\/kategori\/vinter_sno<\/loc>[\s\S]*?<lastmod>([^<]+)<\/lastmod><\/url>/);
      assertTrue(!!catMatch, "gsc-b-01: sitemap has a /kategori/vinter_sno entry");
      if (catMatch) {
        assertEq(catMatch[1], "2021-06-15", "gsc-b-02: category lastmod = MAX(updated_at) of its published experiences");
        assertTrue(catMatch[1] !== today, "gsc-b-03: category lastmod is NOT today's date (no blanket 'today')");
      }

      // /opplevelse/<slug> lastmod must still be the row's own updated_at
      // (pre-existing, correct behavior — regression guard, not re-fixing it).
      const newerSlug = (expStore.getExperienceById(newerExpId) as any).slug as string;
      const detailMatch = sm1.body.match(new RegExp(`<url><loc>[^<]*/opplevelse/${newerSlug}</loc>[\\s\\S]*?<lastmod>([^<]+)</lastmod></url>`));
      assertTrue(!!detailMatch, "gsc-b-04: sitemap has the detail-page entry for the newer experience");
      if (detailMatch) assertEq(detailMatch[1], "2021-06-15", "gsc-b-05: detail-page lastmod is still the row's own updated_at");

      // ── gårdssalg category + produsent lastmod ────────────────────────────
      // Seed >= GARDSSALG_VISIBILITY_THRESHOLD (5) providers with producer_type
      // set (the WHERE clause listGardssalgProviders()/gardssalgVisible() use),
      // each stamped with a distinct updated_at, to exercise both the
      // aggregate MAX (category page) and the per-row value (produsent page).
      // producer_type (drink-producer-specific column, ALTER-added — distinct
      // from the generic provider_type column) is what countGardssalgProviders()
      // / listGardssalgProviders() actually gate on; createProvider()'s schema
      // doesn't expose it, so it's stamped via raw UPDATE like updated_at.
      const gsDates = ["2019-03-01 00:00:00", "2019-04-01 00:00:00", "2019-05-01 00:00:00", "2019-06-01 00:00:00"];
      for (let i = 0; i < gsDates.length; i++) {
        const id = expStore.createProvider({
          navn: `Gårdsprodusent ${i}`, org_nr: `90000000${i}`,
          fylke: "Vestland", kommune: "Voss",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        db.prepare("UPDATE experience_providers SET producer_type = 'cideri', updated_at = ? WHERE id = ?").run(gsDates[i], id);
      }
      // The 5th (freshest) provider — distinct, most-recent date, used to
      // assert BOTH the category-page MAX and this provider's own produsent
      // lastmod.
      const freshProvId = expStore.createProvider({
        navn: "Fjordly Sider og Gårdsbutikk", org_nr: "900000099",
        fylke: "Vestland", kommune: "Voss",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const freshDate = "2022-11-20 12:00:00";
      db.prepare("UPDATE experience_providers SET producer_type = 'cideri', updated_at = ? WHERE id = ?").run(freshDate, freshProvId);

      assertTrue(expStore.countGardssalgProviders() >= 5, "gsc-b-06: seeded >= GARDSSALG_VISIBILITY_THRESHOLD gårdssalg providers");

      const sm2 = invokeGet(router, "/sitemap.xml");
      assertEq(sm2.status, 200, "gsc-b-07: GET /sitemap.xml -> 200 (after gårdssalg seed)");

      const gsCatMatch = sm2.body.match(/<url><loc>[^<]*\/kategori\/gardssalg<\/loc>[\s\S]*?<lastmod>([^<]+)<\/lastmod><\/url>/);
      assertTrue(!!gsCatMatch, "gsc-b-08: sitemap has a /kategori/gardssalg entry");
      if (gsCatMatch) {
        assertEq(gsCatMatch[1], "2022-11-20", "gsc-b-09: /kategori/gardssalg lastmod = MAX(updated_at) across gårdssalg providers");
        assertTrue(gsCatMatch[1] !== today, "gsc-b-10: /kategori/gardssalg lastmod is NOT today's date");
      }

      const freshSlug = (expStore.listGardssalgProviders(50, 0).find((p) => p.id === freshProvId) || {}).slug as string | undefined;
      assertTrue(!!freshSlug, "gsc-b-11: the freshest provider got a slug (backfillProviderSlugs ran)");
      if (freshSlug) {
        const prodMatch = sm2.body.match(new RegExp(`<url><loc>[^<]*/kategori/gardssalg/produsent/${freshSlug}</loc>[\\s\\S]*?<lastmod>([^<]+)</lastmod></url>`));
        assertTrue(!!prodMatch, "gsc-b-12: sitemap has a produsent entry for the freshest provider");
        if (prodMatch) {
          assertEq(prodMatch[1], "2022-11-20", "gsc-b-13: produsent lastmod = that provider's own updated_at (real per-row date)");
          assertTrue(prodMatch[1] !== today, "gsc-b-14: produsent lastmod is NOT today's date");
        }
      }
    } finally {
      if (prevPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevPath;
      dbFactory.__resetDbFactoryForTesting();
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runExperiencesSeoGscFixesTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
