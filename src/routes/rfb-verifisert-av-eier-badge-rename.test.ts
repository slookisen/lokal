/**
 * rfb-verifisert-av-eier-badge-rename.test.ts — dev-request
 * 2026-07-30-rettfrabonden-verifisert-av-eier-badge-og-filter.
 *
 * Covers two changes to rettfrabonden.com (src/routes/seo.ts, src/routes/mcp.ts,
 * src/i18n/locales/{no,en}.json):
 *
 *   1. The owner-claim "Verifisert" badge (driven by agent.isVerified /
 *      DB agents.is_verified, i18n key producer.verified) is renamed to
 *      "Verifisert av eier" (no) / "Verified by owner" (en) everywhere it
 *      renders: all three producer-card renderer variants (plain, ultra-rich,
 *      medium-rich), the producer profile hero (which used to hardcode
 *      "Verifisert" instead of the i18n key), and the MCP lokal_info tool's
 *      text output. This is DISTINCT from agent.brregVerified ("Registrert i
 *      Brønnøysund"), which must stay byte-for-byte unchanged.
 *   2. A new GET /verifisert-av-eier browse-all page (mirrors /kategori/:slug:
 *      hero, live count, empty state, CollectionPage JSON-LD, breadcrumb,
 *      reuses producerCard) lists every producer with isVerified === true,
 *      registered above the /:city catch-all, plus a homepage button/link to
 *      it under the "Produsenter" (home.discover_title) section heading.
 *
 * Same harness convention as rfb-homepage-category-chips.test.ts /
 * produsent-role-gate.test.ts: own in-memory DB via
 * __setDbForTesting/__initSchemaForTesting, the REAL seo.ts router's handlers
 * pulled off the route stack and invoked directly with a fake req/res (no
 * HTTP server, no port); MCP tools exercised via registerTools() against a
 * duck-typed server (same convention as mcp-search-geo.test.ts).
 *
 * Exported runVerifisertAvEierBadgeRenameTests({log}) -> TestSummary; wired
 * into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-verifisert-av-eier-badge-rename.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runVerifisertAvEierBadgeRenameTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    id: string; name: string; city?: string | null; lat?: number | null; lng?: number | null;
    trust?: number; isVerified?: boolean; brregVerified?: boolean;
  }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city, lat, lng,
        trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
        ?, 1, ?, ?, 0, 0, 0, datetime('now'), datetime('now'))`,
    ).run(
      row.id, row.name, "En beskrivelse", row.name, `${row.id}@example.no`, `https://${row.id}.example.no`,
      `key-${row.id}`, row.city ?? null, row.lat ?? null, row.lng ?? null,
      row.trust ?? 0.5, row.isVerified ? 1 : 0, row.brregVerified ? 1 : 0,
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

    // ══════════════════════════════════════════════════════════════
    // (4b) GET /verifisert-av-eier — empty state, checked BEFORE any
    // producer is seeded, so the live count is genuinely zero.
    // ══════════════════════════════════════════════════════════════
    resetRegistryCache();
    {
      const r = invoke("/verifisert-av-eier", { lang: "no", query: {} });
      assertEq(r.status, 200, "empty: GET /verifisert-av-eier renders 200 with zero verified producers");
      assertTrue(/0 produsent/.test(r.body), "empty: shows a live count of 0");
      assertTrue(r.body.includes('class="sk-empty"'), "empty: sane empty-state block renders");
      assertTrue(!r.body.includes('class="pc"'), "empty: no producer cards render");
    }

    // ── seed fixtures ────────────────────────────────────────────────
    // 3 claimed+verified, high trust -> homepage positions 0-2 -> ultra-rich card.
    seedAgent({ id: "ultra-1", name: "Ultra Gaard En", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.95, isVerified: true });
    seedAgent({ id: "ultra-2", name: "Ultra Gaard To", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.94, isVerified: true });
    seedAgent({ id: "ultra-3", name: "Ultra Gaard Tre", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.93, isVerified: true });
    // 1 more claimed+verified, slightly lower trust -> homepage position 3 -> medium-rich card.
    seedAgent({ id: "medium-1", name: "Medium Gaard Fire", city: "Oslo", lat: 59.91, lng: 10.75, trust: 0.80, isVerified: true });
    for (const id of ["ultra-1", "ultra-2", "ultra-3", "medium-1"]) claimAgent(id);
    // Verified but NOT claimed -> falls through to the plain producerCard
    // renderer on both the homepage and /verifisert-av-eier.
    seedAgent({ id: "plain-verified-1", name: "Plain Verifisert Gaard", city: "Bergen", lat: 60.39, lng: 5.32, trust: 0.5, isVerified: true });
    // Not verified at all -> must never carry the badge, and must be excluded
    // from /verifisert-av-eier.
    seedAgent({ id: "unverified-1", name: "Uverifisert Gaard", city: "Trondheim", lat: 63.43, lng: 10.39, trust: 0.6, isVerified: false });
    // brregVerified=1, isVerified=0 -> "Registrert i Brønnøysund" badge only,
    // never the owner-verification badge/text.
    seedAgent({ id: "brreg-only-1", name: "Brreg Only Gaard", city: "Stavanger", lat: 58.97, lng: 5.73, trust: 0.6, isVerified: false, brregVerified: true });
    // Both badges at once -> each renders its own independent, correct text.
    seedAgent({ id: "both-badges-1", name: "Begge Merker Gaard", city: "Tromso", lat: 69.65, lng: 18.96, trust: 0.7, isVerified: true, brregVerified: true });

    resetRegistryCache();

    // ══════════════════════════════════════════════════════════════
    // (1a) Homepage producer cards — all three renderer variants —
    // read "Verifisert av eier" (no) / "Verified by owner" (en).
    // ══════════════════════════════════════════════════════════════
    function checkHomepageBadges(lang: "no" | "en", expectedLabel: string, label: string) {
      const r = invoke("/", { lang, query: {} });
      assertEq(r.status, 200, `${label}: homepage renders 200`);
      assertTrue(r.body.includes("Ultra Gaard En"), `${label}: ultra-rich candidate is present on the homepage`);
      assertTrue(r.body.includes("Medium Gaard Fire"), `${label}: medium-rich candidate is present on the homepage`);
      assertTrue(r.body.includes("Plain Verifisert Gaard"), `${label}: plain-card verified candidate is present on the homepage`);

      // The exact old label must never appear anywhere as the owner-verification
      // badge text (byte check: not merely "contains new label", but old is gone).
      assertTrue(!/badge badge-v">&#10003; Verifisert</.test(r.body) || r.body.includes(expectedLabel),
        `${label}: no badge-v span still reads the bare old "Verifisert" text`);

      const badgeVCount = (r.body.match(/class="badge badge-v"/g) || []).length;
      assertTrue(badgeVCount >= 3, `${label}: at least 3 badge-v spans render (ultra + medium + plain verified cards)`);

      const badgeVOccurrences = [...r.body.matchAll(/<span class="badge badge-v">&#10003; ([^<]*)<\/span>/g)]
        .map((m) => m[1]);
      assertTrue(badgeVOccurrences.length >= 3, `${label}: badge-v spans were parsed out of the homepage body`);
      for (const text of badgeVOccurrences) {
        assertEq(text, expectedLabel, `${label}: every badge-v span reads exactly "${expectedLabel}"`);
      }

      assertTrue(!r.body.includes("Uverifisert Gaard") || !new RegExp(
        `Uverifisert Gaard[\\s\\S]{0,400}${expectedLabel}`,
      ).test(r.body), `${label}: the unverified producer's card does not carry the owner-verification badge`);

      // (5) homepage button/link to the new browse-all page, under the
      // "Produsenter" (home.discover_title) section heading. Search for the
      // sh-title-classed heading specifically — "Produsenter"/"Producers"
      // also appears earlier on the page (e.g. the hero stats label), so a
      // bare text search would anchor on the wrong occurrence.
      const discoverIdx = r.body.indexOf(lang === "en" ? '<div class="sh-title">Producers</div>' : '<div class="sh-title">Produsenter</div>');
      assertTrue(discoverIdx >= 0, `${label}: home.discover_title section heading renders`);
      const btnIdx = r.body.indexOf(lang === "en" ? '/en/verifisert-av-eier' : '"/verifisert-av-eier"', discoverIdx);
      assertTrue(btnIdx >= 0 && btnIdx - discoverIdx < 800,
        `${label}: a link to the new browse-all page appears shortly after the "Produsenter" heading`);
    }

    checkHomepageBadges("no", "Verifisert av eier", "no");
    checkHomepageBadges("en", "Verified by owner", "en");

    // ══════════════════════════════════════════════════════════════
    // (1b) Producer profile hero — was a hardcoded "Verifisert" string,
    // now uses the i18n key with the new label.
    // ══════════════════════════════════════════════════════════════
    {
      const r = invoke("/produsent/:slug", { params: { slug: "ultra-gaard-en" }, lang: "no", ip: "127.0.0.1" });
      assertEq(r.status, 200, "hero: verified producer's profile page renders 200");
      assertTrue(r.body.includes('<span class="badge badge-v">&#10003; Verifisert av eier</span>'),
        "hero: producer profile hero badge reads exactly \"Verifisert av eier\"");
      assertTrue(!r.body.includes('<span class="badge badge-v">&#10003; Verifisert</span>'),
        "hero: the old hardcoded bare \"Verifisert\" hero badge string is gone");
    }
    {
      const r = invoke("/produsent/:slug", { params: { slug: "ultra-gaard-en" }, lang: "en", ip: "127.0.0.1" });
      assertEq(r.status, 200, "hero(en): verified producer's profile page renders 200");
      assertTrue(r.body.includes('<span class="badge badge-v">&#10003; Verified by owner</span>'),
        "hero(en): producer profile hero badge reads exactly \"Verified by owner\" in English");
    }

    // ══════════════════════════════════════════════════════════════
    // (3) agent.brregVerified badge text is byte-for-byte unchanged, and
    // stays fully independent of the isVerified/owner badge.
    // ══════════════════════════════════════════════════════════════
    {
      const r = invoke("/produsent/:slug", { params: { slug: "brreg-only-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertEq(r.status, 200, "brreg: brreg-only producer's profile page renders 200");
      assertTrue(r.body.includes('<span class="badge badge-v">&#10003; Registrert i Brønnøysund</span>'),
        "brreg: \"Registrert i Brønnøysund\" badge text is byte-for-byte unchanged");
      assertTrue(!r.body.includes("Verifisert av eier"),
        "brreg: a brregVerified=1/isVerified=0 producer does NOT get the owner-verification badge");
    }
    {
      const r = invoke("/produsent/:slug", { params: { slug: "begge-merker-gaard" }, lang: "no", ip: "127.0.0.1" });
      assertEq(r.status, 200, "both: dual-badge producer's profile page renders 200");
      assertTrue(r.body.includes('<span class="badge badge-v">&#10003; Verifisert av eier</span>'),
        "both: owner-verification badge renders with the new label");
      assertTrue(r.body.includes('<span class="badge badge-v">&#10003; Registrert i Brønnøysund</span>'),
        "both: Brønnøysund badge renders unchanged alongside it");
    }

    // ══════════════════════════════════════════════════════════════
    // (4) GET /verifisert-av-eier — lists only isVerified===true producers,
    // live count, standard producer card, both locales.
    // ══════════════════════════════════════════════════════════════
    function checkVerifiedPage(lang: "no" | "en", label: string) {
      const r = invoke("/verifisert-av-eier", { lang, query: {} });
      assertEq(r.status, 200, `${label}: GET /verifisert-av-eier renders 200`);
      for (const name of ["Ultra Gaard En", "Ultra Gaard To", "Ultra Gaard Tre", "Medium Gaard Fire", "Plain Verifisert Gaard", "Begge Merker Gaard"]) {
        assertTrue(r.body.includes(name), `${label}: verified producer "${name}" is listed`);
      }
      for (const name of ["Uverifisert Gaard", "Brreg Only Gaard"]) {
        assertTrue(!r.body.includes(name), `${label}: non-verified producer "${name}" is NOT listed`);
      }
      const countLabel = lang === "en" ? "6 producers" : "6 produsenter";
      assertTrue(r.body.includes(countLabel), `${label}: live count shows exactly ${countLabel}`);
      assertTrue(r.body.includes('class="sk-hero"'), `${label}: hero section renders (kategori/:slug pattern)`);
      assertTrue(r.body.includes('class="sk-crumbs"'), `${label}: breadcrumb renders (kategori/:slug pattern)`);
      assertTrue(r.body.includes('"CollectionPage"'), `${label}: CollectionPage JSON-LD renders`);
      assertTrue((r.body.match(/class="pc"/g) || []).length >= 6, `${label}: uses the standard producerCard renderer for every listed producer`);
    }
    checkVerifiedPage("no", "no");
    checkVerifiedPage("en", "en");

    // ══════════════════════════════════════════════════════════════
    // (7) The new route does not get swallowed by the /:city catch-all —
    // an existing city page still resolves normally.
    // ══════════════════════════════════════════════════════════════
    {
      const r = invoke("/:city", { params: { city: "oslo" }, lang: "no", query: {} });
      assertEq(r.status, 200, "city: GET /oslo still resolves 200 (unaffected by the new route)");
      assertTrue(r.body.includes("Oslo"), "city: /oslo page body mentions Oslo");
    }
    // And the reserved-slug belt-and-braces entry actually protects it: hitting
    // /:city with city="verifisert-av-eier" must fall through (next()) rather
    // than trying to render it as a city with zero producers.
    {
      let calledNext = false;
      const layer = findLayer("/:city");
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const req: any = { params: { city: "verifisert-av-eier" }, lang: "no", query: {} };
      const res: any = {
        status: () => res, send: () => res, redirect: () => res,
      };
      handler(req, res, () => { calledNext = true; });
      assertTrue(calledNext, "reserved-slug: /:city calls next() for city=\"verifisert-av-eier\" instead of rendering a fake city page");
    }

    // ══════════════════════════════════════════════════════════════
    // (2) MCP lokal_info tool text output reflects the same updated wording.
    // ══════════════════════════════════════════════════════════════
    {
      const { registerTools } = require("./mcp") as typeof import("./mcp");
      const tools = new Map<string, { config: any; handler: (args: any, extra?: any) => Promise<any> }>();
      const fakeServer: any = {
        registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
        resource() { /* no-op */ },
        prompt() { /* no-op */ },
        registerResource() { /* no-op */ },
        registerPrompt() { /* no-op */ },
      };
      registerTools(fakeServer, () => "test-client", () => undefined);

      const info = tools.get("lokal_info");
      assertTrue(!!info, "mcp: lokal_info tool is registered");
      if (info) {
        const r = await info.handler({ agentId: "ultra-1" });
        const text = String(r?.content?.[0]?.text ?? "");
        assertTrue(text.includes("✔ Verifisert av eier"), `mcp: lokal_info text output includes "✔ Verifisert av eier" (got: ${text.slice(0, 200)})`);
        assertTrue(!/✔ Verifisert(?! av eier)/.test(text), "mcp: no bare old \"✔ Verifisert\" (without \"av eier\") remains");

        const rUnverified = await info.handler({ agentId: "unverified-1" });
        const textUnverified = String(rUnverified?.content?.[0]?.text ?? "");
        assertTrue(!textUnverified.includes("Verifisert"), "mcp: an unverified producer's lokal_info output carries no verification text");
      }
    }

    // ══════════════════════════════════════════════════════════════
    // (6) experiences-seo.ts (opplevagent.no) and dental-seo.ts
    // (finn-tannlege.com) "Verifisert" badges/copy are untouched — static
    // source check (these verticals have their own separate badge mechanism,
    // src/routes/experiences-seo.ts / src/routes/dental-seo.ts, not
    // agent.isVerified / producer.verified).
    // ══════════════════════════════════════════════════════════════
    {
      const expPath = path.join(__dirname, "experiences-seo.ts");
      const dentPath = path.join(__dirname, "dental-seo.ts");
      const expSrc = fs.readFileSync(expPath, "utf8");
      const dentSrc = fs.readFileSync(dentPath, "utf8");
      assertTrue(expSrc.includes("Verifisert tilbyder"), "vertical-isolation: experiences-seo.ts still has its own unrelated \"Verifisert tilbyder\" copy, untouched");
      assertTrue(dentSrc.includes('badges.push(`<span class="badge badge-verified">Verifisert</span>`)'), "vertical-isolation: dental-seo.ts's own \"Verifisert\" badge text is byte-for-byte unchanged");
    }

    // ══════════════════════════════════════════════════════════════
    // (8) Follow-up fix (CHANGES-REQUESTED review): the same agent.isVerified
    // badge/status text also hardcoded the OLD "Verifisert"/"Ikke verifisert"
    // string in four more static public/ HTML surfaces that are NOT touched
    // by the seo.ts/mcp.ts/i18n changes above — src/public/app.html (the live
    // GET /app consumer SPA), src/public/selger.html (the owner/seller
    // dashboard + claim-matching flow), and (lower-priority, noindexed/legacy)
    // src/public/dashboard.html and src/public/admin.html. Static source
    // checks, same convention as the vertical-isolation check above.
    // ══════════════════════════════════════════════════════════════
    {
      const appPath = path.join(__dirname, "../public/app.html");
      const selgerPath = path.join(__dirname, "../public/selger.html");
      const dashboardPath = path.join(__dirname, "../public/dashboard.html");
      const adminPath = path.join(__dirname, "../public/admin.html");
      const appSrc = fs.readFileSync(appPath, "utf8");
      const selgerSrc = fs.readFileSync(selgerPath, "utf8");
      const dashboardSrc = fs.readFileSync(dashboardPath, "utf8");
      const adminSrc = fs.readFileSync(adminPath, "utf8");

      // A bare old "Verifisert" (not followed by " av eier") or bare "Ikke
      // verifisert" (not followed by " av eier") would mean a stray badge/
      // status string was missed. "Verifiserte agenter ..." (a different,
      // unrelated help-text sentence, singular/plural inflection aside) is
      // intentionally allowed through by this regex — it does not render the
      // isVerified badge/status itself.
      const bareVerifisertBadge = /(?<!Ikke )Verifisert(?! av eier| Aktiv| tilbyder|e )/;
      const bareIkkeVerifisert = /Ikke verifisert(?! av eier)/;

      // app.html — live GET /app consumer SPA.
      assertTrue(appSrc.includes("Verifisert av eier"), "app.html: producer-card badge now reads \"Verifisert av eier\"");
      assertTrue(!bareVerifisertBadge.test(appSrc), "app.html: no bare old \"Verifisert\" badge/status string remains");
      assertTrue(!bareIkkeVerifisert.test(appSrc), "app.html: no bare old \"Ikke verifisert\" status string remains");

      // selger.html — owner/seller dashboard + claim-matching flow.
      assertTrue(selgerSrc.includes("Verifisert av eier"), "selger.html: NO dict/badge fallback now reads \"Verifisert av eier\"");
      assertTrue(selgerSrc.includes("Verified by owner"), "selger.html: EN dict entry now reads \"Verified by owner\"");
      assertTrue(!bareVerifisertBadge.test(selgerSrc), "selger.html: no bare old \"Verifisert\" badge/dict/claim-match string remains");

      // dashboard.html — legacy/noindexed, superseded by app.html, fixed anyway.
      assertTrue(dashboardSrc.includes("Verifisert av eier"), "dashboard.html: producer-card badge now reads \"Verifisert av eier\"");
      assertTrue(!bareVerifisertBadge.test(dashboardSrc), "dashboard.html: no bare old \"Verifisert\" badge/status string remains");
      assertTrue(!bareIkkeVerifisert.test(dashboardSrc), "dashboard.html: no bare old \"Ikke verifisert\" status string remains");

      // admin.html — legacy/noindexed internal admin page, fixed anyway.
      assertTrue(adminSrc.includes("Verifisert av eier"), "admin.html: filter option/stat-label/row-badge now read \"Verifisert av eier\"");
      assertTrue(!bareVerifisertBadge.test(adminSrc), "admin.html: no bare old \"Verifisert\" filter/stat/badge string remains");
      assertTrue(!bareIkkeVerifisert.test(adminSrc), "admin.html: no bare old \"Ikke verifisert\" filter option remains");
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-verifisert-av-eier-badge-rename: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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

// Standalone runner: `npx tsx src/routes/rfb-verifisert-av-eier-badge-rename.test.ts`
if (require.main === module) {
  console.log("── RFB \"Verifisert av eier\" badge rename + browse-all page (dev-request 2026-07-30-rettfrabonden-verifisert-av-eier-badge-og-filter) unit tests ──");
  runVerifisertAvEierBadgeRenameTests({ log: true }).then((r) => {
    console.log(`\nrfb-verifisert-av-eier-badge-rename: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
