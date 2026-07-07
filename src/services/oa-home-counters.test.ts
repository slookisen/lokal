/**
 * oa-home-counters.test.ts — tests for the OA homepage "counter strip" stats
 * added as dev-request 2026-07-04-opplevagent-besokstall-og-forside-friskhet
 * item 1: getOaHomeCounters() (src/services/oa-home-counters.ts), the
 * countPublishedProviders()/countPublishedKommuner() catalog-count helpers
 * (src/services/experience-store.ts), and the homepage wiring in
 * src/routes/experiences-seo.ts.
 *
 * Mirrors contact-tracking.test.ts / admin-db-table-sizes.test.ts's shape:
 *   - the rfb/main DB (analytics_page_views) is injected via
 *     __setDbForTesting + __initSchemaForTesting, previous handle
 *     saved/restored so this test never leaves the module-level singleton
 *     swapped for later blocks.
 *   - the experiences catalog DB uses EXPERIENCES_DB_PATH=":memory:" +
 *     db-factory's __resetDbFactoryForTesting(), same pattern as the
 *     sq-slug / sq-detail blocks in tests/test.ts.
 *   - fresh require-cache for every module touched, so no earlier test's
 *     module state (or module-level cache) leaks in.
 *   - exported runOaHomeCountersTests({log}) -> TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/services/oa-home-counters.test.ts
 *
 * Covers:
 *   (a) Catalog-count correctness: countPublishedProviders()/
 *       countPublishedKommuner() count only PUBLISHED (verified + brreg-
 *       active-or-no-provider) rows, matching countPublishedExperiences()'s
 *       existing gate — an unverified experience and an experience whose
 *       provider is brreg-inactive are both excluded.
 *   (b) Host-scoping: getOaHomeCounters()'s traffic numbers only include
 *       analytics_page_views rows stamped vertical_id='experiences' — rows
 *       stamped 'rfb' (a different host) never leak in.
 *   (c) Fleet/internal-traffic exclusion: rows with is_owner=1 (the fleet's
 *       own UAs — Lokal-Enricher, RFB-ContactVerifier, curl, etc., per
 *       analytics-service.ts's isOwnerRequest()) are excluded from every
 *       traffic counter, not just page views.
 *   (d) Bot/AI classification: a non-owner ClaudeBot UA counts in botAndAi,
 *       not realHumans.
 *   (e) Cache behavior: a second call within the TTL returns the
 *       previously-cached catalog counts even after new data is inserted;
 *       __resetOaHomeCountersCacheForTesting() forces a fresh read.
 *   (f) Homepage wiring: GET / (experiences-seo router) renders the counter
 *       strip container with the live numbers substituted in, and contains
 *       no client-side tracking script for it (non-goal: no client JS).
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, url: string, headers: Record<string, string> = {}): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: {},
      headers,
      lang: "no",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() { return this; },
      header() { return this; },
      send(body: any) {
        resolve({ handled: true, status: statusCode, body: String(body) });
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body: JSON.stringify(body) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

export function runOaHomeCountersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // test's module-level state (esp. oa-home-counters.ts's own TTL cache
    // and traffic-stats.ts's _trafficCache) leaks in.
    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const trafficStatsPath = require.resolve("./traffic-stats");
    const oaHomeCountersPath = require.resolve("./oa-home-counters");
    const expSeoPath = require.resolve("../routes/experiences-seo");
    for (const p of [dbFactoryPath, expStorePath, trafficStatsPath, oaHomeCountersPath, expSeoPath]) {
      delete require.cache[p];
    }

    try {
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const oaHomeCounters = require("./oa-home-counters") as typeof import("./oa-home-counters");

      // Open (and schema-init) the in-memory experiences DB.
      dbFactory.getDb("experiences");

      // ── Fixtures: 2 providers, 3 published + 2 unpublished experiences ──
      const providerOsloId = expStore.createProvider({
        navn: "Fjord Opplevelser AS", fylke: "Oslo", kommune: "Oslo",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const providerTromsoId = expStore.createProvider({
        navn: "Nord Safari AS", fylke: "Troms", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      // Provider whose company is brreg-inactive — its experience must be
      // excluded from every published count (PUBLISH_GATE_SQL), including
      // the new countPublishedProviders()/countPublishedKommuner().
      const providerInactiveId = expStore.createProvider({
        navn: "Nedlagt Turer AS", fylke: "Vestland", kommune: "Bergen",
        brreg_verified: 1, brreg_active: 0, verification_status: "verified",
      });

      expStore.createExperience({
        title: "Fjordtur med kajakk", provider_id: providerOsloId,
        provider_match_status: "matched", kommune: "Oslo", fylke: "Oslo",
        verification_status: "verified", confidence: "high",
      });
      expStore.createExperience({
        title: "Byvandring i Oslo", provider_id: providerOsloId,
        provider_match_status: "matched", kommune: "Oslo", fylke: "Oslo",
        verification_status: "verified", confidence: "high",
      });
      expStore.createExperience({
        title: "Hvalsafari fra Tromsø", provider_id: providerTromsoId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms",
        verification_status: "verified", confidence: "medium",
      });
      // Unpublished: still pending_verify.
      expStore.createExperience({
        title: "Uverifisert tur", provider_id: providerTromsoId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms",
        verification_status: "pending_verify",
      });
      // Unpublished: provider is brreg-inactive.
      expStore.createExperience({
        title: "Nedlagt gårdstur", provider_id: providerInactiveId,
        provider_match_status: "matched", kommune: "Bergen", fylke: "Vestland",
        verification_status: "verified", confidence: "high",
      });

      // ── (a) Catalog-count correctness ──────────────────────────────
      assertEq(expStore.countPublishedExperiences(), 3,
        "a1: countPublishedExperiences() counts exactly the 3 published rows");
      assertEq(expStore.countPublishedProviders(), 2,
        "a2: countPublishedProviders() counts exactly the 2 providers with a published experience (excludes the brreg-inactive provider)");
      assertEq(expStore.countPublishedKommuner(), 2,
        "a3: countPublishedKommuner() counts exactly the 2 distinct kommuner (Oslo, Tromsø) with a published experience");

      // ── Fixtures: analytics_page_views (rfb main DB) ────────────────
      const insertPv = rfbDb.prepare(
        `INSERT INTO analytics_page_views (path, session_id, is_owner, vertical_id) VALUES (?, ?, ?, ?)`
      );
      // 4 real human OA page views (2 distinct sessions/UAs, one repeated).
      insertPv.run("/", "oa-human-1:Mozilla/5.0 (Macintosh) Chrome/120", 0, "experiences");
      insertPv.run("/opplevelser", "oa-human-1:Mozilla/5.0 (Macintosh) Chrome/120", 0, "experiences");
      insertPv.run("/", "oa-human-2:Mozilla/5.0 (Windows) Firefox/119", 0, "experiences");
      insertPv.run("/kategori/mat-drikke", "oa-human-2:Mozilla/5.0 (Windows) Firefox/119", 0, "experiences");
      // 2 AI/bot OA page views — non-owner, must land in botAndAi.
      insertPv.run("/", "oa-bot-1:Mozilla/5.0 (compatible; ClaudeBot/1.0)", 0, "experiences");
      insertPv.run("/", "oa-bot-2:Mozilla/5.0 (compatible; GPTBot/1.0)", 0, "experiences");
      // 1 fleet/internal OA page view — is_owner=1, must be excluded entirely.
      insertPv.run("/", "oa-owner-1:Lokal-Enricher/1.0", 1, "experiences");
      // 3 RFB page views on a DIFFERENT host/vertical — must never leak into
      // the OA counters (host-scoping).
      insertPv.run("/", "rfb-human-1:Mozilla/5.0 (Macintosh) Chrome/120", 0, "rfb");
      insertPv.run("/oslo", "rfb-human-1:Mozilla/5.0 (Macintosh) Chrome/120", 0, "rfb");
      insertPv.run("/", "rfb-human-2:Mozilla/5.0 (Windows) Firefox/119", 0, "rfb");

      const counters1 = oaHomeCounters.getOaHomeCounters();

      // ── (b) Host-scoping ─────────────────────────────────────────────
      assertEq(counters1.pageViews, 6,
        "b1: pageViews counts only the 6 non-owner OA-vertical rows (4 human + 2 bot), not the 3 rfb rows");
      assertEq(counters1.uniqueVisitors, 4,
        "b2: uniqueVisitors counts only the 4 distinct OA sessions (2 human + 2 bot), not the 2 rfb sessions");

      // ── (c) Fleet/internal-traffic exclusion ──────────────────────────
      assertEq(counters1.realHumans + counters1.botAndAi, 6,
        "c1: realHumans + botAndAi == 6 (the owner row is excluded from both, not silently counted as human)");

      // ── (d) Bot/AI classification ─────────────────────────────────────
      assertEq(counters1.realHumans, 4, "d1: realHumans == 4 (the two human sessions' page views)");
      assertEq(counters1.botAndAi, 2, "d2: botAndAi == 2 (ClaudeBot + GPTBot page views)");

      // ── Catalog numbers on the same combined result ────────────────────
      assertEq(counters1.opplevelser, 3, "a4: getOaHomeCounters().opplevelser matches countPublishedExperiences()");
      assertEq(counters1.tilbydere, 2, "a5: getOaHomeCounters().tilbydere matches countPublishedProviders()");
      assertEq(counters1.kommuner, 2, "a6: getOaHomeCounters().kommuner matches countPublishedKommuner()");

      // ── (e) Cache behavior ──────────────────────────────────────────
      // Add a brand-new published experience + page view; without a cache
      // reset the numbers must NOT move (still serving the cached snapshot).
      const providerBergenId = expStore.createProvider({
        navn: "Bergen Turer AS", fylke: "Vestland", kommune: "Bergen",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Ny opplevelse i Bergen", provider_id: providerBergenId,
        provider_match_status: "matched", kommune: "Bergen", fylke: "Vestland",
        verification_status: "verified", confidence: "high",
      });
      insertPv.run("/", "oa-human-3:Mozilla/5.0 (Linux) Chrome/121", 0, "experiences");

      const counters2 = oaHomeCounters.getOaHomeCounters();
      assertEq(counters2.opplevelser, counters1.opplevelser,
        "e1: within TTL, opplevelser is unchanged (served from cache) despite the new row");
      assertEq(counters2.pageViews, counters1.pageViews,
        "e2: within TTL, pageViews is unchanged (served from cache) despite the new row");

      oaHomeCounters.__resetOaHomeCountersCacheForTesting();
      const counters3 = oaHomeCounters.getOaHomeCounters();
      assertEq(counters3.opplevelser, 4,
        "e3: after cache reset, opplevelser reflects the newly-added published experience (4)");
      assertEq(counters3.kommuner, 3,
        "e4: after cache reset, kommuner reflects the new Bergen row (Oslo, Tromsø, Bergen = 3)");

      // ── (f) Homepage wiring ─────────────────────────────────────────
      const expSeoRouter = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;
      oaHomeCounters.__resetOaHomeCountersCacheForTesting();
      const home = await callRoute(expSeoRouter, "/");
      assertTrue(home.handled, "f1: GET / is handled by the experiences-seo router");
      assertEq(home.status, 200, "f2: GET / returns 200");
      assertTrue(home.body.includes('class="counters"'), "f3: homepage HTML includes the counter-strip container");
      assertTrue(home.body.includes(String(counters3.opplevelser)), "f4: homepage HTML includes the live opplevelser count");
      assertTrue(home.body.includes(String(counters3.tilbydere)), "f5: homepage HTML includes the live tilbydere count");
      assertTrue(home.body.includes(String(counters3.kommuner)), "f6: homepage HTML includes the live kommuner count");
      // Non-goal: no new client-side JS for the counter strip. The homepage's
      // only <script> block is the pre-existing progressive-enhancement
      // search-form fallback — assert no NEW script referencing the counters.
      assertTrue(!/counters?["'-]?(?:\.js|Strip)?\.addEventListener|fetch\(.*counter/i.test(home.body),
        "f7: no client-side JS was added to fetch/refresh the counter strip");
    } catch (err: any) {
      failed++;
      failures.push("oa-home-counters: unexpected error: " + String(err?.stack || err?.message || err));
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
      for (const p of [dbFactoryPath, expStorePath, trafficStatsPath, oaHomeCountersPath, expSeoPath]) {
        delete require.cache[p];
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/oa-home-counters.test.ts`
if (require.main === module) {
  runOaHomeCountersTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
