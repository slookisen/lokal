/**
 * opplevelser-write-pause-gate.test.ts — the enrichment write-pause fence on
 * every apply:true admin write route under /api/opplevelser.
 *
 * dev-request 2026-09-02-experiences-skrivepause-catalog-hidden-og-
 * rapportspraak, del 1.
 *
 * The pause row lives on the MAIN db (`enrichment_write_pause`,
 * database/init.ts), vertical 'experiences'. Until this dev-request nothing
 * in routes/opplevelser.ts read it, so a live experiences pause was prose
 * only (see services/enrichment-write-pause.ts's header for why prose is not
 * a gate). Every gated route now calls the one shared
 * experiencesWritePauseBlock() helper AFTER parsing its apply/dry-run flag and
 * ONLY on the path that writes.
 *
 * Covers, for EVERY gated route:
 *   (a) pause set for 'experiences' + apply  -> 423 {paused:true, vertical:
 *       'experiences', fail_closed:false} and ZERO rows changed on the
 *       experiences db (SQLite total_changes() across the call), plus an
 *       explicit DB read-back on the hjemmeside-write route.
 *   (b) same pause + dry-run                 -> normal 200 (never blocked).
 *   (c) pause set for 'rfb' ONLY + apply     -> experiences routes unaffected
 *       (vertical isolation) — hjemmeside-write really writes.
 *   (d) pause cleared (explicit cleared_by)  -> apply goes through again.
 *   (e) FAIL-CLOSED: the main-db handle throws inside the guard -> 423 with
 *       fail_closed:true and no write, even with no pause set.
 *   (f) FAIL-CLOSED, accessor form: getDb() ITSELF throws when invoked
 *       (__setDbAccessorFailureForTesting) -> still 423 fail_closed:true.
 *       This is the thunk-vs-eager distinction: an eager `getRfbDb()` in the
 *       helper evaluates before the fence's try and dies as a 500 — (e)
 *       alone cannot tell the two apart (PR #765 review finding 3).
 *   (g) For the seven routine-called routes added in PR #765 review round 2
 *       (website-verification-remediation, website-discovery,
 *       listing-homepage-discovery, brreg-website-discovery,
 *       orgnr-backfill, contact-backfill, website-review-approve) the 423
 *       fires BEFORE any outbound fetch: globalThis.fetch, the Brreg stub and
 *       the gårdssalg website-search stub are counted across (a) and must
 *       all read ZERO calls.
 *
 * Harness copied from opplevelser-gardssalg-set-contact-phone.test.ts
 * (EXPERIENCES_DB_PATH=":memory:", require-cache purge, fake req/res +
 * router.handle(), restore-in-finally) plus the main-db swap used by
 * admin-enrichment-write-pause.test.ts / opplevelser-bulk-load-admission-
 * gate.test.ts (__setDbForTesting + __initSchemaForTesting on an in-memory
 * better-sqlite3 handle, restored via __peekDbForTesting in finally). Brreg
 * is stubbed (__setBrregFetchForTesting) so bulk-load's dry-run/apply paths
 * never touch the network.
 *
 * Standalone: npx tsx src/routes/opplevelser-write-pause-gate.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url;
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      app: { get() { return undefined; } },
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "unhandled" } });
    });
  });
}

/**
 * One entry per gated route: the body that WRITES and (when the route has a
 * dry-run mode) the body that does NOT. `flag` documents which apply-flag
 * idiom the route actually uses — verified against the handler source, not
 * assumed.
 */
interface GatedRoute {
  path: string;
  flag: string;
  applyBody: Record<string, unknown>;
  /** null = the route has no dry-run mode (every call writes). */
  dryRunBody: Record<string, unknown> | null;
}

const HJEMMESIDE_PROVIDER_ID = "wpg-hjemmeside-prov";

function gatedRoutes(hjemmeside: string): GatedRoute[] {
  const pairs = [{ remove_id: "wpg-nope-remove", keep_id: "wpg-nope-keep" }];
  const bulkRows = [{ title: "Pausetur", provider_name: "Pausegård Ukjent" }];
  return [
    { path: "/admin/bulk-load", flag: "apply (zod boolean, default false)", applyBody: { experiences: bulkRows, apply: true }, dryRunBody: { experiences: bulkRows } },
    { path: "/admin/content-refresh", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/gardssalg-content-refresh", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/experiences-description-enrichment", flag: "dry_run (strict-false)", applyBody: { dry_run: false, ids: ["wpg-nope"] }, dryRunBody: { ids: ["wpg-nope"] } },
    { path: "/admin/experiences-title-no-backfill", flag: "dry_run (strict-false)", applyBody: { dry_run: false }, dryRunBody: {} },
    { path: "/admin/experiences-content-judge-sweep", flag: "apply (=== true)", applyBody: { apply: true }, dryRunBody: {} },
    { path: "/admin/experiences-dedup-backfill", flag: "(none — always writes)", applyBody: {}, dryRunBody: null },
    { path: "/admin/price-freshness-check", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { experienceIds: ["wpg-nope"], apply: true }, dryRunBody: { experienceIds: ["wpg-nope"] } },
    { path: "/admin/experiences-provider-dedup-merge", flag: "apply (true/1/'1'/'true' body)", applyBody: { pairs, apply: true }, dryRunBody: { pairs } },
    { path: "/admin/gardssalg-provider-dedup-merge", flag: "apply (true/1/'1'/'true' body)", applyBody: { pairs, apply: true }, dryRunBody: { pairs } },
    { path: "/admin/providers/hjemmeside-write", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { items: [{ provider_id: HJEMMESIDE_PROVIDER_ID, hjemmeside }], apply: true }, dryRunBody: { items: [{ provider_id: HJEMMESIDE_PROVIDER_ID, hjemmeside }] } },
    // ── PR #765 review round 2: the routine-called routes that were missed ──
    // Every body below targets a provider id that does not exist, so the
    // ungated (cleared / rfb-only) apply completes as a 200 with an empty
    // target set and NO outbound fetch — and the gated apply must 423 before
    // the target lookup even runs (proven by the zero-network assertion).
    { path: "/admin/gardssalg-website-verification-remediation", flag: "apply (true/1/'1'/'true' body)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/gardssalg-website-discovery", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/listing-homepage-discovery", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/brreg-website-discovery", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/gardssalg-orgnr-backfill", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/gardssalg-contact-backfill", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { providerIds: ["wpg-nope"], apply: true }, dryRunBody: { providerIds: ["wpg-nope"] } },
    { path: "/admin/gardssalg-website-review-approve", flag: "apply (true/1/'1'/'true' body or ?apply=)", applyBody: { approvals: [{ provider_id: "wpg-nope", url: "https://wpg-nope.no" }], apply: true }, dryRunBody: { approvals: [{ provider_id: "wpg-nope", url: "https://wpg-nope.no" }] } },
  ];
}

export function runOpplevelserWritePauseGateTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "opplevelser-write-pause-gate-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const experienceBrregPath = require.resolve("../services/experience-brreg");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, experienceBrregPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    // The main-db module (database/init) is deliberately NOT purged: the
    // route's `getRfbDb` thunk and this test must share the same singleton
    // for __setDbForTesting to reach the guard.
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevMainDb = initMod.__peekDbForTesting();
    let expBrreg: typeof import("../services/experience-brreg") | null = null;
    let expStore: typeof import("../services/experience-store") | null = null;
    // Network-call counters (finding 2 / case (g)): every outbound seam the
    // seven new routes could reach — counted, never let out of the process.
    const prevGlobalFetch = globalThis.fetch;
    let fetchCalls = 0;
    let brregCalls = 0;
    let websiteSearchCalls = 0;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      expBrreg = require("../services/experience-brreg") as typeof import("../services/experience-brreg");
      expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const svc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");

      // ── Main db (pause table lives HERE, not on experiences.db) ──────────
      const BetterSqlite = require("better-sqlite3") as typeof import("better-sqlite3");
      const mainDb = new BetterSqlite(":memory:");
      mainDb.pragma("journal_mode = DELETE");
      mainDb.pragma("foreign_keys = OFF");
      initMod.__setDbForTesting(mainDb as any);
      initMod.__initSchemaForTesting(mainDb as any);
      assertTrue(
        !!mainDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='enrichment_write_pause'").get(),
        "wpg-00: enrichment_write_pause exists on the MAIN db the route's getRfbDb thunk resolves to",
      );

      // Brreg stub — every name is "unverified", so bulk-load never leaves
      // the process (no network in the suite).
      expBrreg.__setBrregFetchForTesting(async () => {
        brregCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ _embedded: { enheter: [] } }),
        } as any;
      });
      // gårdssalg website-discovery's tier-2 search seam — counted; returns
      // nothing so no candidate host is ever fetched even if reached.
      expStore.__setGardssalgWebsiteSearchForTesting(async () => {
        websiteSearchCalls++;
        return [];
      });
      // globalThis.fetch — counted, then delegated (so any block that
      // legitimately needs it elsewhere in the suite is unaffected).
      globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
        fetchCalls++;
        return prevGlobalFetch(...args);
      }) as typeof fetch;
      const networkCalls = () => fetchCalls + brregCalls + websiteSearchCalls;

      // ── Fixture on the experiences db for the real-write read-back ──────
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, enrichment_state, verification_status, source, confidence, hjemmeside, created_at)
         VALUES (?, ?, 'experiences', 'raw', 'pending_verify', 'test-fixture', 'medium', NULL, '2026-01-01 00:00:00')`,
      ).run(HJEMMESIDE_PROVIDER_ID, "Pausegård AS");
      const hjemmesideOf = () =>
        (expDb.prepare("SELECT hjemmeside FROM experience_providers WHERE id = ?").get(HJEMMESIDE_PROVIDER_ID) as { hjemmeside: string | null }).hjemmeside;
      const totalChanges = () => (expDb.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

      const auth = { "x-admin-key": testKey };
      const setPause = (vertical: "rfb" | "experiences", reason: string) =>
        svc.setEnrichmentWritePause(mainDb as any, { vertical, enabled: true, reason }, "verifier");
      const clearPause = (vertical: "rfb" | "experiences") =>
        svc.setEnrichmentWritePause(mainDb as any, { vertical, enabled: false, cleared_by: "daniel" }, "verifier");

      // ── Auth is unchanged: no key -> 403 before the gate is ever consulted
      const unauth = await callRoute(opplevelserRouter, { url: "/admin/providers/hjemmeside-write", body: { items: [], apply: true } });
      assertEq(unauth.status, 403, "wpg-01: unauthenticated apply -> 403 (requireAdmin still runs first)");

      // ══ (a) pause set for 'experiences' + apply -> 423, zero rows changed ══
      setPause("experiences", "test: experiences-pause aktiv");
      assertEq(svc.getEnrichmentWritePause(mainDb as any, "experiences").enabled, true, "wpg-a0: experiences pause is live on the main db");
      assertEq(hjemmesideOf(), null, "wpg-a0b: fixture hjemmeside starts NULL");
      for (const r of gatedRoutes("https://pausegard.no")) {
        const before = totalChanges();
        const res = await callRoute(opplevelserRouter, { url: r.path, headers: auth, body: r.applyBody });
        assertEq(res.status, 423, `wpg-a1 ${r.path} [${r.flag}]: apply under a live experiences pause -> 423`);
        assertEq(res.body?.paused, true, `wpg-a2 ${r.path}: body.paused === true`);
        assertEq(res.body?.vertical, "experiences", `wpg-a3 ${r.path}: body.vertical === 'experiences'`);
        assertEq(res.body?.fail_closed, false, `wpg-a4 ${r.path}: a real pause is NOT flagged fail_closed`);
        assertEq(res.body?.reason, "test: experiences-pause aktiv", `wpg-a5 ${r.path}: admin route keeps the full operator reason`);
        assertEq(totalChanges() - before, 0, `wpg-a6 ${r.path}: ZERO rows changed on experiences.db across the blocked call`);
      }
      assertEq(hjemmesideOf(), null, "wpg-a7: hjemmeside-write read-back — the fixture's hjemmeside is STILL NULL after the blocked apply");
      // (g) the 423 fired BEFORE any outbound call on every gated route —
      // the seven round-2 routes all do live fetches (Brreg / site crawl /
      // web search) on their apply path when given a real target.
      assertEq(networkCalls(), 0, "wpg-a8: ZERO outbound calls (globalThis.fetch + Brreg stub + website-search stub) across all blocked applies");
      assertEq({ fetchCalls, brregCalls, websiteSearchCalls }, { fetchCalls: 0, brregCalls: 0, websiteSearchCalls: 0 }, "wpg-a9: ...each seam individually untouched");

      // ══ (b) same pause + dry-run -> normal 200, never blocked ═════════════
      for (const r of gatedRoutes("https://pausegard.no")) {
        if (r.dryRunBody === null) {
          assertTrue(true, `wpg-b0 ${r.path}: has no dry-run mode (every call writes) — dry-run case not applicable`);
          continue;
        }
        const res = await callRoute(opplevelserRouter, { url: r.path, headers: auth, body: r.dryRunBody });
        assertEq(res.status, 200, `wpg-b1 ${r.path} [${r.flag}]: dry-run under a live experiences pause -> 200 (never blocked)`);
        assertTrue(res.body?.paused !== true, `wpg-b2 ${r.path}: dry-run response carries no paused flag`);
      }
      assertEq(hjemmesideOf(), null, "wpg-b3: dry-run hjemmeside-write wrote nothing (still NULL)");

      // ══ (c) pause for 'rfb' ONLY -> experiences routes unaffected ═════════
      clearPause("experiences");
      setPause("rfb", "test: rfb-pause aktiv, experiences ikke");
      assertEq(svc.getEnrichmentWritePause(mainDb as any, "rfb").enabled, true, "wpg-c0: rfb pause is live");
      assertEq(svc.getEnrichmentWritePause(mainDb as any, "experiences").enabled, false, "wpg-c0b: experiences pause is NOT live");
      for (const r of gatedRoutes("https://pausegard.no")) {
        const res = await callRoute(opplevelserRouter, { url: r.path, headers: auth, body: r.applyBody });
        assertTrue(res.status !== 423, `wpg-c1 ${r.path}: apply under an rfb-only pause is NOT 423 (vertical isolation)`);
        assertEq(res.status, 200, `wpg-c2 ${r.path}: ...and completes normally (200)`);
      }
      assertEq(hjemmesideOf(), "https://pausegard.no", "wpg-c3: hjemmeside-write REALLY wrote under an rfb-only pause (read-back)");

      // ══ (d) pause cleared (explicit cleared_by) -> apply goes through ═════
      clearPause("rfb");
      setPause("experiences", "test: settes og oppheves");
      clearPause("experiences");
      const cleared = svc.getEnrichmentWritePause(mainDb as any, "experiences");
      assertEq(cleared.enabled, false, "wpg-d0: experiences pause cleared");
      assertEq(cleared.cleared_by, "daniel", "wpg-d0b: ...with the explicit cleared_by recorded");
      for (const r of gatedRoutes("https://pausegard2.no")) {
        const res = await callRoute(opplevelserRouter, { url: r.path, headers: auth, body: r.applyBody });
        assertEq(res.status, 200, `wpg-d1 ${r.path}: apply after the pause is cleared -> 200`);
      }
      assertEq(hjemmesideOf(), "https://pausegard2.no", "wpg-d2: hjemmeside-write wrote again after the clear (read-back)");

      // ══ (e) FAIL-CLOSED: main-db handle throws inside the guard ═══════════
      // No pause is set. Point the getDb() singleton (what the route's
      // `getRfbDb` thunk resolves) at a handle whose prepare() throws — the
      // guard must answer 423 fail_closed:true, never 500, never "open".
      const throwingDb: any = {
        prepare() {
          throw new Error("simulated main-db failure inside the guard");
        },
      };
      initMod.__setDbForTesting(throwingDb);
      try {
        const before = totalChanges();
        const res = await callRoute(opplevelserRouter, {
          url: "/admin/providers/hjemmeside-write",
          headers: auth,
          body: { items: [{ provider_id: HJEMMESIDE_PROVIDER_ID, hjemmeside: "https://pausegard3.no" }], apply: true },
        });
        assertEq(res.status, 423, "wpg-e1: a throwing main-db lookup REJECTS the apply (423), even with no pause set");
        assertEq(res.body?.paused, true, "wpg-e2: ...as a paused body");
        assertEq(res.body?.fail_closed, true, "wpg-e3: ...flagged fail_closed:true so an operator can tell it from a real pause");
        assertEq(res.body?.vertical, "experiences", "wpg-e4: ...for the experiences vertical");
        assertEq(totalChanges() - before, 0, "wpg-e5: zero rows changed on experiences.db");
        assertEq(hjemmesideOf(), "https://pausegard2.no", "wpg-e6: hjemmeside unchanged by the fail-closed call (read-back)");
        const res2 = await callRoute(opplevelserRouter, { url: "/admin/content-refresh", headers: auth, body: { providerIds: ["wpg-nope"], apply: true } });
        assertEq(res2.status, 423, "wpg-e7: content-refresh fails closed on the same throwing handle");
        assertEq(res2.body?.fail_closed, true, "wpg-e8: ...and says so");
        const dry = await callRoute(opplevelserRouter, { url: "/admin/content-refresh", headers: auth, body: { providerIds: ["wpg-nope"] } });
        assertEq(dry.status, 200, "wpg-e9: a dry-run never consults the guard, so it still completes on a broken main db");
      } finally {
        initMod.__setDbForTesting(mainDb as any);
      }

      // ══ (f) FAIL-CLOSED, accessor form: getDb() ITSELF throws ═════════════
      // (e) above only makes the HANDLE's prepare() throw — by then getDb()
      // has already returned, so an eager `enrichmentWritePauseBlock(
      // getRfbDb(), …)` would pass (e) just the same. Here the ACCESSOR
      // throws when invoked: only a helper that hands the fence the THUNK
      // (`getRfbDb`, not `getRfbDb()`) can turn that into a 423 fail_closed
      // rather than an unhandled 500 (PR #765 review finding 3). Mutation
      // check: switch the helper to `getRfbDb()` — wpg-f1/f5 must fail.
      initMod.__setDbAccessorFailureForTesting(new Error("simulated: getDb() itself is unavailable"));
      try {
        const before = totalChanges();
        const res = await callRoute(opplevelserRouter, {
          url: "/admin/providers/hjemmeside-write",
          headers: auth,
          body: { items: [{ provider_id: HJEMMESIDE_PROVIDER_ID, hjemmeside: "https://pausegard4.no" }], apply: true },
        });
        assertEq(res.status, 423, "wpg-f1: a THROWING getDb() accessor REJECTS the apply as 423 (thunk reaches the fence's try), never a 500");
        assertEq(res.body?.paused, true, "wpg-f2: ...as a paused body");
        assertEq(res.body?.fail_closed, true, "wpg-f3: ...flagged fail_closed:true");
        assertEq(totalChanges() - before, 0, "wpg-f4: zero rows changed on experiences.db");
        const res2 = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-orgnr-backfill", headers: auth, body: { providerIds: ["wpg-nope"], apply: true } });
        assertEq(res2.status, 423, "wpg-f5: a round-2 route (gardssalg-orgnr-backfill) fails closed on the throwing accessor too");
        assertEq(res2.body?.fail_closed, true, "wpg-f6: ...and says so");
        const dry = await callRoute(opplevelserRouter, { url: "/admin/gardssalg-orgnr-backfill", headers: auth, body: { providerIds: ["wpg-nope"] } });
        assertEq(dry.status, 200, "wpg-f7: its dry-run never invokes the accessor, so it still completes (200)");
      } finally {
        initMod.__setDbAccessorFailureForTesting(null);
      }
      assertEq(hjemmesideOf(), "https://pausegard2.no", "wpg-f8: hjemmeside unchanged by the accessor-throw calls (read-back)");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-write-pause-gate: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      globalThis.fetch = prevGlobalFetch;
      try { expBrreg?.__setBrregFetchForTesting(null); } catch { /* best-effort */ }
      try { expStore?.__setGardssalgWebsiteSearchForTesting(null); } catch { /* best-effort */ }
      try { initMod.__setDbAccessorFailureForTesting(null); } catch { /* best-effort */ }
      // Restore UNCONDITIONALLY (prev may be null = "nothing opened yet"):
      // the singleton must never be left pointing at this test's handle.
      try { initMod.__setDbForTesting(prevMainDb as any); } catch { /* best-effort */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-write-pause-gate.test.ts`
if (require.main === module) {
  runOpplevelserWritePauseGateTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
