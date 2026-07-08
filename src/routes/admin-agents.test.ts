/**
 * admin-agents.test.ts — unit/integration tests for routes/admin-agents.ts,
 * focused on Slice 2 of dev-request 2026-06-30-brreg-verification-gate:
 * wiring verifyOrgNumber() into POST /admin/agents/register for the "rfb"
 * and "experiences" verticals only ("dental" stays Legelisten-primary and
 * is never Brreg-verified here).
 *
 * All Brreg I/O is stubbed via a monkey-patched global.fetch (verifyOrgNumber
 * defaults its fetchImpl param to the global `fetch` identifier) — ZERO real
 * network calls. The DB is a fresh in-memory SQLite spun up via the real
 * production schema (__initSchemaForTesting), so the org_nr/brreg_* columns
 * and their defaults are exercised exactly as in production.
 *
 * No real HTTP server / socket round-trip: tests/test.ts runs ~40 largely
 * independent async blocks, several of which stomp on the SAME
 * process.env.ADMIN_KEY concurrently (see the "AUTH: route requireAdmin
 * rejects missing / zero key" block in tests/test.ts for the established
 * pattern this mirrors). Going over a real socket leaves a window between
 * "set env var" and "server processes the request" for a peer block to win
 * that race. Instead we grab the POST "/register" handler straight off the
 * router's internal stack and invoke it directly with fake req/res objects
 * — env var + handler call happen in the same synchronous turn, so no peer
 * block can interleave before requireAdmin() reads it.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-agents.test.ts
 *   2. Wired into the gate: tests/test.ts imports runAdminAgentsRegisterTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Brreg-shaped fixtures, keyed by org-nr, served by the fetch stub below.
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

export async function runAdminAgentsRegisterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevBrregFlag = process.env.BRREG_VERIFY_ON_REGISTER;
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "admin-agents-test-key";

  // fetchByOrgNr — org-nr → BrregFixture. verifyOrgNumber() hits
  // GET /enheter/{orgNr}; we key fixtures off the trailing path segment.
  const fixtures: Map<string, BrregFixture> = new Map();
  let fetchCallCount = 0;

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = String(url);
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

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Re-require the route module fresh (mirrors the pv-auth pattern in
    // tests/test.ts) and grab the POST "/register" handler straight off the
    // router's internal stack, so we can invoke it directly.
    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    const routerModule = require("../routes/admin-agents").default;
    const layer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/register" && l.route.methods && l.route.methods.post,
    );
    assertTrue(!!layer, "setup: POST /register handler is registered on the router");
    const handler = layer.route.stack[0].handle;

    function readRow(orgNr: string): {
      org_nr: string | null;
      brreg_verified: number;
      brreg_flag: string | null;
      brreg_checked_at: string | null;
    } | undefined {
      return testDb
        .prepare(
          "SELECT org_nr, brreg_verified, brreg_flag, brreg_checked_at FROM agents WHERE org_nr = ?"
        )
        .get(orgNr) as any;
    }

    async function callRegister(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
      // Set env + fetch stub and invoke the handler in the SAME synchronous
      // turn — no await, no socket — so no peer test block sharing
      // process.env.ADMIN_KEY can interleave before requireAdmin() reads it.
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      globalThis.fetch = stubFetch();
      const res = fakeRes();
      await handler({ headers: { "x-admin-key": ADMIN_KEY }, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── Case 1: flag ON, rfb, active + allow-listed NACE → verified+badge ──
    {
      process.env.BRREG_VERIFY_ON_REGISTER = "true";
      const orgNr = "910000001";
      fixtures.set(orgNr, { status: 200, body: activeAgentBody(orgNr, "Gårdsbutikken Ett AS", "47.220") });

      const r = await callRegister({
        name: "Gårdsbutikken Ett",
        url: "https://gardsbutikken-ett.no",
        city: "Oslo",
        vertical_id: "rfb",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case1: rfb active+allow-listed NACE → 201 registered");
      const row = readRow(orgNr);
      assertEq(row?.org_nr, orgNr, "case1: org_nr column written");
      assertEq(row?.brreg_verified, 1, "case1: brreg_verified=1 (badge-eligible)");
      assertEq(row?.brreg_flag, null, "case1: brreg_flag=null");
      assertTrue(typeof row?.brreg_checked_at === "string" && row!.brreg_checked_at!.length > 0,
        "case1: brreg_checked_at stamped");
    }

    // ── Case 2: flag ON, rfb, dissolved org-nr → flagged, NOT blocked ───────
    {
      process.env.BRREG_VERIFY_ON_REGISTER = "true";
      const orgNr = "910000002";
      fixtures.set(orgNr, { status: 200, body: dissolvedAgentBody(orgNr, "Nedlagt Gård AS") });

      const r = await callRegister({
        name: "Nedlagt Gård",
        url: "https://nedlagt-gard.no",
        city: "Bergen",
        vertical_id: "rfb",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case2: dissolved org-nr still registers (201, never blocked)");
      const row = readRow(orgNr);
      assertEq(row?.brreg_verified, 0, "case2: brreg_verified=0 for dissolved");
      assertEq(row?.brreg_flag, "dissolved", "case2: brreg_flag='dissolved'");
    }

    // ── Case 3: flag ON, rfb, Brreg lookup returns not-found (404) ──────────
    {
      process.env.BRREG_VERIFY_ON_REGISTER = "true";
      const orgNr = "910000003";
      // Deliberately no fixture registered → stub falls through to 404.

      const r = await callRegister({
        name: "Ukjent Org",
        url: "https://ukjent-org.no",
        city: "Trondheim",
        vertical_id: "rfb",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case3: not-found org-nr still registers (201, never blocked)");
      const row = readRow(orgNr);
      assertEq(row?.brreg_verified, 0, "case3: brreg_verified=0 for not-found");
      assertEq(row?.brreg_flag, "no_orgnr", "case3: brreg_flag='no_orgnr' (safe-default contract)");
    }

    // ── Case 4: wrong_nace — active+exists but NACE not in allow-list ───────
    {
      process.env.BRREG_VERIFY_ON_REGISTER = "true";
      const orgNr = "910000004";
      fixtures.set(orgNr, { status: 200, body: activeAgentBody(orgNr, "Feil Bransje AS", "62.010") });

      const r = await callRegister({
        name: "Feil Bransje",
        url: "https://feil-bransje.no",
        city: "Stavanger",
        vertical_id: "rfb",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case4: wrong-NACE org still registers (201, never blocked)");
      const row = readRow(orgNr);
      assertEq(row?.brreg_verified, 0, "case4: brreg_verified=0 for non-allow-listed NACE");
      assertEq(row?.brreg_flag, "wrong_nace", "case4: brreg_flag='wrong_nace'");
    }

    // ── Case 5: dental vertical — skips verify entirely, even with a ───────
    //    valid+allow-listed-looking org-nr and the flag ON.
    {
      process.env.BRREG_VERIFY_ON_REGISTER = "true";
      const orgNr = "910000005";
      fixtures.set(orgNr, { status: 200, body: activeAgentBody(orgNr, "Tannlege Test AS", "86.230") });
      const callsBefore = fetchCallCount;

      const r = await callRegister({
        name: "Tannlege Test",
        url: "https://tannlege-test.no",
        city: "Oslo",
        vertical_id: "dental",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case5: dental registers (201)");
      assertEq(fetchCallCount, callsBefore, "case5: dental never calls Brreg (fetch not invoked)");
      const row = readRow(orgNr);
      assertEq(row?.brreg_verified, 0, "case5: dental brreg_verified stays 0 (DB default)");
      assertEq(row?.brreg_flag, null, "case5: dental brreg_flag stays null (DB default)");
      assertEq(row?.brreg_checked_at, null, "case5: dental brreg_checked_at stays null");
    }

    // ── Case 6: feature flag OFF — behaves exactly like pre-slice-1 ─────────
    {
      delete process.env.BRREG_VERIFY_ON_REGISTER;
      const orgNr = "910000006";
      fixtures.set(orgNr, { status: 200, body: activeAgentBody(orgNr, "Flagg Av AS", "47.220") });
      const callsBefore = fetchCallCount;

      const r = await callRegister({
        name: "Flagg Av",
        url: "https://flagg-av.no",
        city: "Tromsø",
        vertical_id: "rfb",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case6: flag-off registers (201)");
      assertEq(fetchCallCount, callsBefore, "case6: flag-off never calls Brreg (fetch not invoked)");
      const row = readRow(orgNr);
      assertEq(row?.org_nr, orgNr, "case6: org_nr still written even with flag off");
      assertEq(row?.brreg_verified, 0, "case6: brreg_verified=0 (pre-slice-1 default)");
      assertEq(row?.brreg_flag, null, "case6: brreg_flag stays null (no verify attempted)");
      assertEq(row?.brreg_checked_at, null, "case6: brreg_checked_at stays null (no verify attempted)");
    }

    // ── Case 7: experiences vertical, active + allow-listed NACE ────────────
    {
      process.env.BRREG_VERIFY_ON_REGISTER = "true";
      const orgNr = "910000007";
      fixtures.set(orgNr, { status: 200, body: activeAgentBody(orgNr, "Opplevelse Test AS", "93.291") });

      const r = await callRegister({
        name: "Opplevelse Test",
        url: "https://opplevelse-test.no",
        city: "Ålesund",
        vertical_id: "experiences",
        org_nr: orgNr,
        source: "test",
      });
      assertEq(r.status, 201, "case7: experiences active+allow-listed NACE → 201 registered");
      const row = readRow(orgNr);
      assertEq(row?.brreg_verified, 1, "case7: experiences brreg_verified=1");
      assertEq(row?.brreg_flag, null, "case7: experiences brreg_flag=null");
    }
  } catch (err) {
    failed++;
    failures.push(`admin-agents-register: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevBrregFlag === undefined) delete process.env.BRREG_VERIFY_ON_REGISTER; else process.env.BRREG_VERIFY_ON_REGISTER = prevBrregFlag;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents.test.ts`
if (require.main === module) {
  console.log("── admin-agents (POST /admin/agents/register brreg-verify wiring) unit tests ──");
  runAdminAgentsRegisterTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-register: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
