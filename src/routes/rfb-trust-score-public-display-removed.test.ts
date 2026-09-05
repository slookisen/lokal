/**
 * rfb-trust-score-public-display-removed.test.ts — dev-request
 * 2026-09-03-rfb-trust-score-offentlig-visning (alternativ A, Daniel-GO
 * 2026-09-03 ~14:2xZ, "A på trust-score" — daniel-responses/2026-09-03-go-a-
 * trust-score-og-importer-drangedal.md).
 *
 * Covers the removal of the public "Trust Score" percentage bar
 * (`.trust-m`/`.trust-bar`/`.trust-fill`, `src/routes/seo.ts`) from:
 *   - all three producer-card renderer variants (plain, ultra-rich,
 *     medium-rich) used on the homepage and list pages, and
 *   - the producer profile page's `pf-stats` block (`GET /produsent/:slug`).
 *
 * `agent.trustScore`/`agents.trust_score` itself, and discovery's
 * `ORDER BY trust_score DESC` sort, are untouched (non-goal) — this suite
 * proves that by observing the SAME homepage tiering/ordering the sibling
 * rfb-verifisert-av-eier-badge-rename suite already exercises (ultra-1 >
 * ultra-2 > ultra-3 > medium-1 by descending trust) still holds with the
 * bar removed, rather than by re-testing trust-score-service.ts itself
 * (out of scope here, already covered by its own suite).
 *
 * Same synthetic router.handle() harness + in-memory-DB pattern as
 * rfb-verifisert-av-eier-badge-rename.test.ts (own `Database(":memory:")`,
 * `__setDbForTesting`/`__initSchemaForTesting`, the real `seo.ts` router's
 * handlers pulled directly off the route stack — no HTTP server, no port).
 *
 * Exported runTrustScorePublicDisplayRemovedTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/rfb-trust-score-public-display-removed.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runTrustScorePublicDisplayRemovedTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runTrustScorePublicDisplayRemovedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seedAgent(row: {
    id: string; name: string; city?: string | null; lat?: number | null; lng?: number | null;
    trust?: number; isVerified?: boolean;
  }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
        ?, 1, ?, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, row.city ?? null, row.lat ?? null, row.lng ?? null,
      row.trust ?? 0.5, row.isVerified ? 1 : 0,
    );
  }

  function claimAgent(agentId: string): void {
    testDb.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
       VALUES (?, ?, 'Test Eier', ?, 'verified', datetime('now'))`,
    ).run(`claim-${agentId}`, agentId, `${agentId}-owner@example.no`);
  }

  function resetRegistryCache(): void {
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

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

    // Same tiering as rfb-verifisert-av-eier-badge-rename.test.ts: 3
    // claimed+verified high-trust agents -> ultra-rich cards on the
    // homepage (positions 0-2), 1 more, slightly lower trust -> medium-rich
    // (position 3) — descending trust order, unchanged by this dev-request.
    seedAgent({ id: "ultra-1", name: "Ultra Gaard En", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.95, isVerified: true });
    seedAgent({ id: "ultra-2", name: "Ultra Gaard To", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.94, isVerified: true });
    seedAgent({ id: "ultra-3", name: "Ultra Gaard Tre", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.93, isVerified: true });
    seedAgent({ id: "medium-1", name: "Medium Gaard Fire", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.80, isVerified: true });
    for (const id of ["ultra-1", "ultra-2", "ultra-3", "medium-1"]) claimAgent(id);
    // Plain-card tier, not claimed.
    seedAgent({ id: "plain-verified-1", name: "Plain Verifisert Gaard", city: "Bergen", lat: 60.39, lng: 5.32, trust: 0.5, isVerified: true });

    resetRegistryCache();

    // ══════════════════════════════════════════════════════════════
    // (1) Homepage producer cards — all three renderer variants — no
    // longer render the trust-score bar/percentage/label anywhere.
    // ══════════════════════════════════════════════════════════════
    {
      const r = invoke("/", { lang: "no", query: {} });
      assertTrue(r.status === 200, "homepage: renders 200");
      assertTrue(r.body.includes("Ultra Gaard En"), "homepage: ultra-rich candidate is present");
      assertTrue(r.body.includes("Medium Gaard Fire"), "homepage: medium-rich candidate is present");
      assertTrue(r.body.includes("Plain Verifisert Gaard"), "homepage: plain-card candidate is present");

      assertTrue(!r.body.includes("trust-m"), "homepage: no element carries the trust-m class");
      assertTrue(!r.body.includes("trust-bar"), "homepage: no element carries the trust-bar class");
      assertTrue(!r.body.includes("trust-fill"), "homepage: no element carries the trust-fill class");
      assertTrue(!/\bTrust Score\b/.test(r.body), "homepage: the \"Trust Score\" label does not render");
      assertTrue(!/\d{1,3}%<\/div>\s*<span class="pc-link"/.test(r.body),
        "homepage: no bare percentage immediately precedes the card's \"see profile\" link (the old trust-m sibling)");

      // Discovery ordering/tiering is unaffected by removing the display —
      // same descending-trust order the sibling badge-rename suite already
      // relies on (ultra-1 > ultra-2 > ultra-3 > medium-1).
      const iU1 = r.body.indexOf("Ultra Gaard En");
      const iU2 = r.body.indexOf("Ultra Gaard To");
      const iU3 = r.body.indexOf("Ultra Gaard Tre");
      const iM1 = r.body.indexOf("Medium Gaard Fire");
      assertTrue(iU1 >= 0 && iU2 > iU1 && iU3 > iU2 && iM1 > iU3,
        "homepage: card order is still descending by trust_score (ultra-1 < ultra-2 < ultra-3 < medium-1 by position) — sort/tiering untouched");
    }
    {
      const r = invoke("/", { lang: "en", query: {} });
      assertTrue(!/\bTrust Score\b/.test(r.body), "homepage(en): the \"Trust Score\" label does not render");
      assertTrue(!r.body.includes("trust-m"), "homepage(en): no element carries the trust-m class");
    }

    // ══════════════════════════════════════════════════════════════
    // (2) Producer profile page (GET /produsent/:slug, AC1's exact route)
    // no longer renders the pf-stats Trust Score tile, for every card tier.
    // ══════════════════════════════════════════════════════════════
    for (const slug of ["ultra-gaard-en", "medium-gaard-fire", "plain-verifisert-gaard"]) {
      const r = invoke("/produsent/:slug", { params: { slug }, lang: "no", ip: "127.0.0.1" });
      assertTrue(r.status === 200, `produsent/${slug}: renders 200`);
      assertTrue(!/\bTrust Score\b/.test(r.body), `produsent/${slug}: the "Trust Score" label does not render`);
      assertTrue(!r.body.includes('pf-stat-icon t"'), `produsent/${slug}: the pf-stat trust-score tile is gone`);
      assertTrue(!r.body.includes("trust-m"), `produsent/${slug}: no element carries the trust-m class`);
      // The stats row itself, and its OTHER tiles (page-view counters), must
      // survive — this is a removal of one tile, not the whole block.
      assertTrue(r.body.includes('class="pf-stats"'), `produsent/${slug}: the pf-stats block itself still renders`);
      assertTrue(r.body.includes('data-stat="human"'), `produsent/${slug}: the human page-view tile still renders`);
      assertTrue(r.body.includes('data-stat="ai"'), `produsent/${slug}: the AI page-view tile still renders`);
    }
    {
      const r = invoke("/produsent/:slug", { params: { slug: "ultra-gaard-en" }, lang: "en", ip: "127.0.0.1" });
      assertTrue(!/\bTrust Score\b/.test(r.body), "produsent/ultra-gaard-en(en): the \"Trust Score\" label does not render");
    }

    // ══════════════════════════════════════════════════════════════
    // (3) Non-goal check: agents.trust_score itself is untouched — still
    // present, still populated, still what the (removed-from-view) cards
    // were computed from. Proves the DB column/value survives even though
    // no route renders it publicly anymore.
    // ══════════════════════════════════════════════════════════════
    {
      const row = testDb.prepare("SELECT trust_score FROM agents WHERE id = 'ultra-1'").get() as { trust_score: number };
      assertTrue(Math.abs(row.trust_score - 0.95) < 1e-9, "db: agents.trust_score for ultra-1 is unchanged (0.95), only its public rendering was removed");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-trust-score-public-display-removed: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
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

// Standalone runner: `npx tsx src/routes/rfb-trust-score-public-display-removed.test.ts`
if (require.main === module) {
  console.log("── RFB public Trust Score removal (dev-request 2026-09-03-rfb-trust-score-offentlig-visning) unit tests ──");
  runTrustScorePublicDisplayRemovedTests({ log: true }).then((r) => {
    console.log(`\nrfb-trust-score-public-display-removed: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
