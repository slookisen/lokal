/**
 * admin-agents-brreg-sweep.test.ts — unit/integration tests for the
 * POST /admin/agents/brreg-sweep endpoint (Slice 3 of dev-request
 * 2026-06-30-brreg-verification-gate, "catalog sweep + badge").
 *
 * Mirrors the conventions established by admin-agents.test.ts (Slice 2):
 *   - Brreg I/O is stubbed via a monkey-patched global.fetch — ZERO real
 *     network calls.
 *   - A fresh :memory: SQLite DB is spun up via __initSchemaForTesting so
 *     the org_nr/brreg_* columns + their defaults are exercised exactly as
 *     in production.
 *   - The route handler is grabbed straight off the router's internal
 *     stack and invoked directly (no real HTTP socket), for the same
 *     process.env.ADMIN_KEY race-avoidance reason documented in
 *     admin-agents.test.ts.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-agents-brreg-sweep.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminAgentsBrregSweepTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type BrregFixture = {
  status: number;
  body?: Record<string, unknown>;
};

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminAgentsBrregSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "admin-agents-brreg-sweep-test-key";

  const fixtures: Map<string, BrregFixture> = new Map();
  let fetchCallCount = 0;
  const fetchedUrls: string[] = [];

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = String(url);
      fetchedUrls.push(urlStr);
      const orgNr = urlStr.split("/").pop() || "";
      const fixture = fixtures.get(orgNr);
      if (!fixture) {
        return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
      }
      return {
        status: fixture.status,
        ok: fixture.status >= 200 && fixture.status < 300,
        json: async () => fixture.body ?? {},
      } as unknown as Response;
    }) as typeof fetch;
  }

  function activeAgentBody(orgNr: string, name: string, nace1: string): Record<string, unknown> {
    return {
      organisasjonsnummer: orgNr,
      navn: name,
      konkurs: false,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
      slettedato: null,
      registreringsdatoEnhetsregisteret: "2015-03-01",
      naeringskode1: { kode: nace1 },
    };
  }

  function dissolvedAgentBody(orgNr: string, name: string): Record<string, unknown> {
    return {
      organisasjonsnummer: orgNr,
      navn: name,
      konkurs: false,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
      slettedato: "2022-01-15",
      registreringsdatoEnhetsregisteret: "2010-05-01",
      naeringskode1: { kode: "01.410" },
    };
  }

  function bankruptAgentBody(orgNr: string, name: string): Record<string, unknown> {
    return {
      organisasjonsnummer: orgNr,
      navn: name,
      konkurs: true,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
      slettedato: null,
      registreringsdatoEnhetsregisteret: "2012-01-01",
      naeringskode1: { kode: "01.410" },
    };
  }

  const noSleep = async (_ms: number): Promise<void> => { /* no-op — avoids real delays in tests */ };

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    const adminAgentsModule = require("../routes/admin-agents") as
      typeof import("../routes/admin-agents");
    const routerModule = adminAgentsModule.default as any;
    const layer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/brreg-sweep" && l.route.methods && l.route.methods.post,
    );
    assertTrue(!!layer, "setup: POST /brreg-sweep handler is registered on the router");
    const handler = layer.route.stack[0].handle;
    const { runBrregCatalogSweep } = adminAgentsModule;

    // ── Helper: insert an agent row directly (bypasses /register so we can
    // freely control org_nr / vertical_id / brreg_checked_at combinations
    // that the sweep's WHERE clause needs to be tested against). ──────────
    let seq = 0;
    function insertAgent(fields: {
      name: string;
      vertical_id: string;
      org_nr: string | null;
      brreg_checked_at: string | null;
      brreg_verified?: number;
    }): string {
      seq++;
      const id = `sweep-test-agent-${seq}`;
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          is_active, is_verified, vertical_id, org_nr, brreg_verified, brreg_flag, brreg_checked_at
        ) VALUES (?, ?, 'test', 'test', 'test@example.com', 'https://example.com', 'producer', ?, 1, 0, ?, ?, ?, NULL, ?)`
      ).run(
        id,
        fields.name,
        `apikey-${id}`,
        fields.vertical_id,
        fields.org_nr,
        fields.brreg_verified ?? 0,
        fields.brreg_checked_at,
      );
      return id;
    }

    function readRow(id: string): {
      brreg_verified: number;
      brreg_flag: string | null;
      brreg_checked_at: string | null;
    } | undefined {
      return testDb
        .prepare("SELECT brreg_verified, brreg_flag, brreg_checked_at FROM agents WHERE id = ?")
        .get(id) as any;
    }

    const now = Date.now();
    const isoDaysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    // ── Fixtures set up BEFORE the sweep call ───────────────────────────
    // 1. never-checked rfb agent, active + allow-listed NACE → verified
    const orgNr1 = "920000001";
    fixtures.set(orgNr1, { status: 200, body: activeAgentBody(orgNr1, "Sweep Gård Ett AS", "47.220") });
    const agent1 = insertAgent({ name: "Sweep Gård Ett", vertical_id: "rfb", org_nr: orgNr1, brreg_checked_at: null });

    // 2. never-checked experiences agent, dissolved → flagged
    const orgNr2 = "920000002";
    fixtures.set(orgNr2, { status: 200, body: dissolvedAgentBody(orgNr2, "Nedlagt Opplevelse AS") });
    const agent2 = insertAgent({ name: "Nedlagt Opplevelse", vertical_id: "experiences", org_nr: orgNr2, brreg_checked_at: null });

    // 3. stale-checked (40 days ago) rfb agent, bankrupt → flagged, re-swept
    const orgNr3 = "920000003";
    fixtures.set(orgNr3, { status: 200, body: bankruptAgentBody(orgNr3, "Konkurs Gård AS") });
    const agent3 = insertAgent({
      name: "Konkurs Gård", vertical_id: "rfb", org_nr: orgNr3, brreg_checked_at: isoDaysAgo(40),
    });

    // 4. FRESH-checked (5 days ago) rfb agent — must be SKIPPED (not stale)
    const orgNr4 = "920000004";
    fixtures.set(orgNr4, { status: 200, body: activeAgentBody(orgNr4, "Frisk Sjekk AS", "47.220") });
    const agent4 = insertAgent({
      name: "Frisk Sjekk", vertical_id: "rfb", org_nr: orgNr4, brreg_checked_at: isoDaysAgo(5), brreg_verified: 1,
    });

    // 5. dental agent with org_nr set — must NEVER be swept (dental excluded)
    const orgNr5 = "920000005";
    fixtures.set(orgNr5, { status: 200, body: activeAgentBody(orgNr5, "Tannlege Sweep AS", "47.220") });
    const agent5 = insertAgent({ name: "Tannlege Sweep", vertical_id: "dental", org_nr: orgNr5, brreg_checked_at: null });

    // 6. rfb agent with NO org_nr — must never be swept (nothing to verify)
    const agent6 = insertAgent({ name: "Ingen Orgnr", vertical_id: "rfb", org_nr: null, brreg_checked_at: null });

    // 7. never-checked rfb agent, active but wrong NACE → flagged_wrong_nace
    const orgNr7 = "920000007";
    fixtures.set(orgNr7, { status: 200, body: activeAgentBody(orgNr7, "Feil Bransje Sweep AS", "62.010") });
    const agent7 = insertAgent({ name: "Feil Bransje Sweep", vertical_id: "experiences", org_nr: orgNr7, brreg_checked_at: null });

    // ── Direct call to runBrregCatalogSweep (bypasses the route/auth layer,
    // exercises the core sweep logic + injected no-op sleep) ─────────────
    globalThis.fetch = stubFetch();
    const callsBeforeDirect = fetchCallCount;
    const directResult = await runBrregCatalogSweep({ limit: 100, offset: 0, sleepFn: noSleep });

    assertEq(directResult.swept, 4, "direct: swept=4 (agent1+agent2+agent7 never-checked, agent3 stale — agent4 fresh-skipped, agent5 dental-skipped, agent6 no-org-nr-skipped)");
    assertEq(directResult.verified, 1, "direct: verified=1 (only agent1)");
    assertEq(directResult.flagged_dissolved, 1, "direct: flagged_dissolved=1 (agent2)");
    assertEq(directResult.flagged_bankrupt, 1, "direct: flagged_bankrupt=1 (agent3)");
    assertEq(directResult.flagged_wrong_nace, 1, "direct: flagged_wrong_nace=1 (agent7)");
    assertEq(directResult.errors, 0, "direct: errors=0");
    assertEq(fetchCallCount - callsBeforeDirect, 4, "direct: exactly 4 Brreg calls made (agent4/5/6 never call fetch)");

    const row1 = readRow(agent1);
    assertEq(row1?.brreg_verified, 1, "agent1: brreg_verified=1 after sweep");
    assertEq(row1?.brreg_flag, null, "agent1: brreg_flag=null after sweep");
    assertTrue(typeof row1?.brreg_checked_at === "string" && row1!.brreg_checked_at!.length > 0,
      "agent1: brreg_checked_at stamped after sweep");

    const row2 = readRow(agent2);
    assertEq(row2?.brreg_verified, 0, "agent2: brreg_verified=0 (dissolved)");
    assertEq(row2?.brreg_flag, "dissolved", "agent2: brreg_flag='dissolved'");

    const row3 = readRow(agent3);
    assertEq(row3?.brreg_verified, 0, "agent3: brreg_verified=0 (bankrupt)");
    assertEq(row3?.brreg_flag, "bankrupt", "agent3: brreg_flag='bankrupt'");
    assertTrue((row3?.brreg_checked_at || "") > isoDaysAgo(40), "agent3: brreg_checked_at refreshed (re-swept, not left stale)");

    const row4 = readRow(agent4);
    assertEq(row4?.brreg_verified, 1, "agent4: untouched — still brreg_verified=1 from fixture (fresh, not re-swept)");

    const row5 = readRow(agent5);
    assertEq(row5?.brreg_checked_at, null, "agent5: dental agent never swept, brreg_checked_at stays null");

    const row6 = readRow(agent6);
    assertEq(row6?.brreg_checked_at, null, "agent6: no-org-nr agent never swept, brreg_checked_at stays null");

    const row7 = readRow(agent7);
    assertEq(row7?.brreg_verified, 0, "agent7: brreg_verified=0 (wrong NACE)");
    assertEq(row7?.brreg_flag, "wrong_nace", "agent7: brreg_flag='wrong_nace'");

    const flaggedIds = directResult.flagged.map((f) => f.id).sort();
    assertEq(
      JSON.stringify(flaggedIds),
      JSON.stringify([agent2, agent3, agent7].sort()),
      "direct: flagged[] lists exactly agent2/agent3/agent7 by id",
    );
    const flaggedAgent2 = directResult.flagged.find((f) => f.id === agent2);
    assertEq(flaggedAgent2?.name, "Nedlagt Opplevelse", "direct: flagged[] entry carries name");
    assertEq(flaggedAgent2?.org_nr, orgNr2, "direct: flagged[] entry carries org_nr");
    assertEq(flaggedAgent2?.flag, "dissolved", "direct: flagged[] entry carries flag");

    // ── Re-running the sweep now finds nothing left to do (all freshly
    // stamped, nothing stale/never-checked remains among rfb+experiences
    // with an org_nr) ─────────────────────────────────────────────────────
    const secondResult = await runBrregCatalogSweep({ limit: 100, offset: 0, sleepFn: noSleep });
    assertEq(secondResult.swept, 0, "second run: swept=0 (nothing left stale/unchecked)");
    assertEq(secondResult.has_more, false, "second run: has_more=false (0 rows returned, fewer than limit)");

    // ── "Pagination": because every call here WRITES brreg_checked_at, a
    // swept row falls OUT of the matching set immediately — so the
    // always-correct way to page the full catalog across multiple calls is
    // to call again with the SAME limit and offset=0 (default), NOT to
    // increment offset (see the caveat in the route's doc-comment; mirrors
    // admin-knowledge.ts's prune-dead-urls sweep, which forbids offset+apply
    // together for the identical reason). Verify that repeat-with-offset=0
    // drains the queue correctly. ─────────────────────────────────────────
    globalThis.fetch = stubFetch();
    const orgNrP1 = "920000101";
    const orgNrP2 = "920000102";
    fixtures.set(orgNrP1, { status: 200, body: activeAgentBody(orgNrP1, "Page Ett AS", "47.220") });
    fixtures.set(orgNrP2, { status: 200, body: activeAgentBody(orgNrP2, "Page To AS", "47.220") });
    insertAgent({ name: "Page Ett", vertical_id: "rfb", org_nr: orgNrP1, brreg_checked_at: null });
    insertAgent({ name: "Page To", vertical_id: "rfb", org_nr: orgNrP2, brreg_checked_at: null });

    const page1 = await runBrregCatalogSweep({ limit: 1, offset: 0, sleepFn: noSleep });
    assertEq(page1.swept, 1, "pagination: page1 swept=1 (limit=1)");
    assertTrue(page1.has_more === true, "pagination: page1 has_more=true (full page → more rows likely remain)");

    // Call again with offset=0 (NOT offset=1) — the row page1 just swept
    // has already dropped out of the WHERE filter, so this correctly picks
    // up the next unswept row.
    const page2 = await runBrregCatalogSweep({ limit: 1, offset: 0, sleepFn: noSleep });
    assertEq(page2.swept, 1, "pagination: page2 (offset still 0) swept=1 — drains the queue without needing offset");

    const page3 = await runBrregCatalogSweep({ limit: 1, offset: 0, sleepFn: noSleep });
    assertEq(page3.swept, 0, "pagination: page3 swept=0 — queue fully drained after 2 rows");
    assertEq(page3.has_more, false, "pagination: page3 has_more=false");

    // ── limit clamping: request above the hard cap gets clamped, not erred ──
    const clamped = await runBrregCatalogSweep({ limit: 100000, offset: 0, sleepFn: noSleep });
    assertEq(clamped.limit, 500, "pagination: limit clamps to the 500 hard cap");

    // ── Route-level: auth + query-param validation (mirrors admin-agents.test.ts) ──
    async function callSweepRoute(headers: Record<string, string>, query: Record<string, string>): Promise<{ status: number; body: any }> {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      globalThis.fetch = stubFetch();
      const res = fakeRes();
      await handler({ headers, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    const unauth = await callSweepRoute({}, {});
    assertEq(unauth.status, 403, "route: missing X-Admin-Key -> 403");

    const badLimit = await callSweepRoute({ "x-admin-key": ADMIN_KEY }, { limit: "0" });
    assertEq(badLimit.status, 400, "route: limit=0 -> 400 invalid limit");

    const badOffset = await callSweepRoute({ "x-admin-key": ADMIN_KEY }, { offset: "-1" });
    assertEq(badOffset.status, 400, "route: offset=-1 -> 400 invalid offset");

    const okCall = await callSweepRoute({ "x-admin-key": ADMIN_KEY }, { limit: "5" });
    assertEq(okCall.status, 200, "route: valid call -> 200");
    assertEq(okCall.body?.success, true, "route: response has success:true");
    assertTrue(typeof okCall.body?.swept === "number", "route: response has numeric swept count");
    assertTrue(Array.isArray(okCall.body?.flagged), "route: response has flagged[] array");
  } catch (err) {
    failed++;
    failures.push(`admin-agents-brreg-sweep: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-brreg-sweep.test.ts`
if (require.main === module) {
  console.log("── admin-agents-brreg-sweep (POST /admin/agents/brreg-sweep) unit tests ──");
  runAdminAgentsBrregSweepTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-brreg-sweep: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
