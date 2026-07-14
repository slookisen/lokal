/**
 * admin-claim-funnel.test.ts — unit/integration tests for GET
 * /admin/claim-funnel (src/routes/marketplace.ts), a read-only
 * invited → opened → started → verified funnel report over the EXISTING
 * outreach_sent_log, agent_claims and analytics_page_views tables (no
 * migration, no new column, no write).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key.
 *   (b) 503 when admin key isn't configured (ADMIN_KEY/ANALYTICS_ADMIN_KEY
 *       both unset).
 *   (c) zero-row case → funnel all zeros, `opened` zero, all conversion
 *       rates `null` (never 0/NaN/Infinity, including the new opened_rate /
 *       invited_to_opened_rate), by_source is an empty array, the stale
 *       "opened stage not yet instrumented" `note` field is gone,
 *       `opened_since_instrumented: true` is present, still 200.
 *   (d) valid key + a hand-seeded fixture (?days=30) → funnel counts,
 *       `opened` (derived from analytics_page_views rows written by the new
 *       GET /selger.html tracking — see src/index.ts / trackSelgerHtmlOpen
 *       in src/middleware/analytics.ts), conversion rates, and by_source
 *       breakdown all match hand-computed expected values (see the comment
 *       block above the fixture below for the arithmetic).
 *   (e) the existing GET /admin/claims endpoint (same file, untouched by
 *       this change) still responds 200 with its known response shape —
 *       a smoke-test regression guard, not a re-test of its own logic.
 *
 * DB is a fresh in-memory SQLite spun up via the real production schema
 * (__initSchemaForTesting) and the router's handler is grabbed straight off
 * router.stack and invoked directly — same convention as
 * admin-agents-delete.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-claim-funnel.test.ts
 *   2. Wired into the gate: tests/test.ts imports runAdminClaimFunnelTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function daysAgoISO(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

export async function runAdminClaimFunnelTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  // FK enforcement off: this fixture only inserts into outreach_sent_log and
  // agent_claims directly (no `agents` rows) — those tables' FK -> agents(id)
  // is irrelevant to what this report computes (plain COUNT(DISTINCT
  // agent_id) over the two tables themselves), same reasoning as
  // admin-agents-delete.test.ts's first (non-FK-ON) block.
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "admin-claim-funnel-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const routePath = require.resolve("../routes/marketplace");
    delete require.cache[routePath];
    const routerModule = require("../routes/marketplace").default;

    const funnelLayer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/admin/claim-funnel" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!funnelLayer, "setup: GET /admin/claim-funnel handler is registered on the router");
    const funnelHandler = funnelLayer.route.stack[0].handle;

    const claimsLayer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/admin/claims" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!claimsLayer, "setup: GET /admin/claims handler is still registered on the router");
    const claimsHandler = claimsLayer.route.stack[0].handle;

    async function callFunnel(
      opts2: { withKey?: boolean; key?: string; days?: number } = {},
    ): Promise<{ status: number; body: any }> {
      const withKey = opts2.withKey ?? true;
      const headers: Record<string, string> = withKey ? { "x-admin-key": opts2.key ?? ADMIN_KEY } : {};
      const query: Record<string, string> = {};
      if (opts2.days !== undefined) query.days = String(opts2.days);
      const res = fakeRes();
      await funnelHandler({ headers, query } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    async function callClaims(): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await claimsHandler({ headers: { "x-admin-key": ADMIN_KEY }, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── (b) admin not configured → 503 ──────────────────────────────────────
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const r = await callFunnel({ withKey: true, key: "whatever" });
      assertEq(r.status, 503, "b1: no ADMIN_KEY/ANALYTICS_ADMIN_KEY configured -> 503");
      assertEq(r.body?.error, "Admin not configured", "b2: 503 body has clear error message");
    }

    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    // ── (a) missing/wrong X-Admin-Key → 403 ─────────────────────────────────
    {
      const noKey = await callFunnel({ withKey: false });
      assertEq(noKey.status, 403, "a1: missing X-Admin-Key -> 403");
      assertEq(noKey.body?.error, "Krever admin-nøkkel", "a2: 403 body has the standard error message");
      assertTrue(noKey.body?.data === undefined, "a3: no-key response carries no report payload");

      const wrongKey = await callFunnel({ withKey: true, key: "wrong-key" });
      assertEq(wrongKey.status, 403, "a4: wrong X-Admin-Key -> 403");
    }

    // ── (c) zero-row case (checked before any fixture rows exist) ──────────
    {
      const empty = await callFunnel({ days: 30 });
      assertEq(empty.status, 200, "c1: zero-row case still returns 200");
      assertEq(empty.body?.success, true, "c2: zero-row response success:true");
      assertEq(empty.body?.data?.window_days, 30, "c3: window_days echoes the ?days= param");
      assertEq(empty.body?.data?.funnel, { invited: 0, started: 0, verified: 0 }, "c4: funnel is all zeros");
      assertEq(empty.body?.data?.opened, 0, "c4b: opened is 0 when no analytics_page_views rows exist");
      assertEq(
        empty.body?.data?.conversion,
        {
          started_rate: null,
          verified_rate: null,
          verified_of_invited_rate: null,
          opened_rate: null,
          invited_to_opened_rate: null,
        },
        "c5: all conversion rates are null (not 0/NaN/Infinity) when denominators are 0, including the new opened-stage rates",
      );
      assertEq(empty.body?.data?.by_source, [], "c6: by_source is an empty array");
      assertEq(empty.body?.data?.opened_since_instrumented, true, "c7: opened_since_instrumented:true is present");
      assertTrue(!("note" in (empty.body?.data ?? {})), "c7b: the stale 'opened stage not yet instrumented' note field is gone");
      // Whole-response JSON round-trip sanity (rules out NaN/Infinity, which
      // JSON.stringify silently turns into `null` too, so also check the
      // literal string form for the tell-tale "NaN"/"Infinity" substrings).
      const serialized = JSON.stringify(empty.body);
      assertTrue(!serialized.includes("NaN") && !serialized.includes("Infinity"), "c8: response never serializes NaN/Infinity");
    }

    // ── (d) populated fixture (?days=30) — hand-computed expected values ───
    //
    // outreach_sent_log (sent_at):
    //   agent-a  5d ago   \
    //   agent-b 10d ago    } within the 30d window
    //   agent-b 12d ago   /  (2nd row, same agent -> tests DISTINCT)
    //   agent-d  8d ago   /
    //   agent-c 40d ago   -- OUTSIDE window, excluded
    //   => invited = DISTINCT agent_id, sent_at>=cutoff = {a,b,d} = 3
    //
    // agent_claims (created_at / status / verified_at / source):
    //   claim-a1 agent-a  4d ago  verified  verified 3d ago  email-apr26
    //   claim-a2 agent-a  3d ago  expired   -               email-apr26 (2nd row, same agent)
    //   claim-b1 agent-b  9d ago  pending   -               email-apr26
    //   claim-e1 agent-e  6d ago  verified  verified 5d ago  organic     (never invited)
    //   claim-d1 agent-d 35d ago  verified  verified 34d ago organic    (OUTSIDE window on both)
    //   claim-f1 agent-f  2d ago  code_sent -               organic
    //   => started  = DISTINCT agent_id, created_at>=cutoff  = {a,b,e,f} = 4
    //   => verified = DISTINCT agent_id, status=verified AND verified_at>=cutoff = {a,e} = 2
    //
    // conversion: started_rate = 4/3 = 1.333, verified_rate = 2/4 = 0.5,
    //             verified_of_invited_rate = 2/3 = 0.667
    //
    // by_source (started/verified computed the same way, grouped by source):
    //   email-apr26: started {a,b}=2, verified {a}=1, verified_rate 0.5
    //   organic:     started {e,f}=2 (d excluded, outside window),
    //                verified {e}=1 (d excluded, verified_at outside window),
    //                verified_rate 0.5
    //
    // analytics_page_views (path / created_at) — feeds "opened":
    //   /selger.html?agent=agent-a&ref=email-apr26   5d ago  \ same agent,
    //   /selger.html?agent=agent-a&ref=email-apr26   4d ago  / different
    //                                                          session -> DISTINCT collapses to 1
    //   /selger.html?agent=agent-g&ref=organic       1d ago  -- new agent, within window
    //   /selger.html                    (no ?agent= at all)  2d ago  -- excluded, no agent param
    //   /selger.html?agent=agent-h                  40d ago  -- OUTSIDE the 30d window, excluded
    //   => opened (30d) = DISTINCT agent extracted from path = {agent-a, agent-g} = 2
    //   => opened_rate = started/opened = 4/2 = 2, invited_to_opened_rate = opened/invited = 2/3 = 0.667
    {
      const insertSent = testDb.prepare(
        `INSERT INTO outreach_sent_log (agent_id, sent_at, channel) VALUES (?, ?, 'email')`,
      );
      insertSent.run("agent-a", daysAgoISO(5));
      insertSent.run("agent-b", daysAgoISO(10));
      insertSent.run("agent-b", daysAgoISO(12));
      insertSent.run("agent-d", daysAgoISO(8));
      insertSent.run("agent-c", daysAgoISO(40));

      const insertClaim = testDb.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, source, created_at, verified_at)
         VALUES (@id, @agent_id, @claimant_name, @claimant_email, @status, @source, @created_at, @verified_at)`,
      );
      insertClaim.run({
        id: "claim-a1", agent_id: "agent-a", claimant_name: "A One", claimant_email: "a1@example.no",
        status: "verified", source: "email-apr26", created_at: daysAgoISO(4), verified_at: daysAgoISO(3),
      });
      insertClaim.run({
        id: "claim-a2", agent_id: "agent-a", claimant_name: "A Two", claimant_email: "a2@example.no",
        status: "expired", source: "email-apr26", created_at: daysAgoISO(3), verified_at: null,
      });
      insertClaim.run({
        id: "claim-b1", agent_id: "agent-b", claimant_name: "B One", claimant_email: "b1@example.no",
        status: "pending", source: "email-apr26", created_at: daysAgoISO(9), verified_at: null,
      });
      insertClaim.run({
        id: "claim-e1", agent_id: "agent-e", claimant_name: "E One", claimant_email: "e1@example.no",
        status: "verified", source: "organic", created_at: daysAgoISO(6), verified_at: daysAgoISO(5),
      });
      insertClaim.run({
        id: "claim-d1", agent_id: "agent-d", claimant_name: "D One", claimant_email: "d1@example.no",
        status: "verified", source: "organic", created_at: daysAgoISO(35), verified_at: daysAgoISO(34),
      });
      insertClaim.run({
        id: "claim-f1", agent_id: "agent-f", claimant_name: "F One", claimant_email: "f1@example.no",
        status: "code_sent", source: "organic", created_at: daysAgoISO(2), verified_at: null,
      });

      // "opened" fixture — analytics_page_views rows as written by the new
      // GET /selger.html tracking (trackSelgerHtmlOpen records
      // req.originalUrl, so ?agent=<id> is preserved in `path`).
      const insertPageView = testDb.prepare(
        `INSERT INTO analytics_page_views (path, session_id, created_at) VALUES (?, ?, ?)`,
      );
      insertPageView.run("/selger.html?agent=agent-a&ref=email-apr26", "sess-1", daysAgoISO(5));
      insertPageView.run("/selger.html?agent=agent-a&ref=email-apr26", "sess-2", daysAgoISO(4)); // same agent, different session -> still 1 distinct
      insertPageView.run("/selger.html?agent=agent-g&ref=organic", "sess-3", daysAgoISO(1));
      insertPageView.run("/selger.html", "sess-4", daysAgoISO(2)); // no ?agent= at all -> excluded
      insertPageView.run("/selger.html?agent=agent-h", "sess-5", daysAgoISO(40)); // outside the 30d window -> excluded

      const r = await callFunnel({ days: 30 });
      assertEq(r.status, 200, "d1: populated fixture -> 200");
      assertEq(r.body?.data?.window_days, 30, "d2: window_days echoes ?days=30");
      assertEq(r.body?.data?.funnel, { invited: 3, started: 4, verified: 2 }, "d3: funnel counts match hand-computed fixture");
      assertEq(r.body?.data?.opened, 2, "d3b: opened counts DISTINCT agent ids from in-window /selger.html?agent= page views (agent-a, agent-g)");
      assertEq(
        r.body?.data?.conversion,
        {
          started_rate: 1.333,
          verified_rate: 0.5,
          verified_of_invited_rate: 0.667,
          opened_rate: 2,
          invited_to_opened_rate: 0.667,
        },
        "d4: conversion rates match hand-computed fixture, rounded to 3dp, including the new opened-stage rates",
      );
      assertEq(r.body?.data?.opened_since_instrumented, true, "d4b: opened_since_instrumented:true still present on the populated fixture");
      const bySource = (r.body?.data?.by_source ?? []) as Array<any>;
      assertEq(bySource.length, 2, "d5: by_source has exactly 2 source groups");
      assertEq(
        bySource.find((s) => s.source === "email-apr26"),
        { source: "email-apr26", started: 2, verified: 1, verified_rate: 0.5 },
        "d6: by_source email-apr26 group matches hand-computed fixture",
      );
      assertEq(
        bySource.find((s) => s.source === "organic"),
        { source: "organic", started: 2, verified: 1, verified_rate: 0.5 },
        "d7: by_source organic group matches hand-computed fixture (agent-d excluded, outside window)",
      );
      assertTrue(!("invited" in (bySource[0] || {})), "d8: by_source entries never fabricate a per-source invited number");

      // ── default window (?days omitted -> 90) picks up agent-c/agent-d too ──
      const r90 = await callFunnel({});
      assertEq(r90.body?.data?.window_days, 90, "d9: omitted ?days defaults to 90");
      assertEq(r90.body?.data?.funnel.invited, 4, "d10: 90-day window also counts agent-c (40d ago)");
      assertEq(r90.body?.data?.funnel.started, 5, "d11: 90-day window also counts agent-d's claim (35d ago)");
      assertEq(r90.body?.data?.opened, 3, "d12: 90-day window also counts agent-h's page view (40d ago) -> {agent-a, agent-g, agent-h}");
    }

    // ── (e) GET /admin/claims is unchanged by this diff (smoke regression) ──
    {
      const claims = await callClaims();
      assertEq(claims.status, 200, "e1: GET /admin/claims still returns 200");
      assertEq(claims.body?.success, true, "e2: GET /admin/claims still returns success:true");
      assertTrue(Array.isArray(claims.body?.data?.claims), "e3: GET /admin/claims still returns a data.claims array");
      assertTrue(Array.isArray(claims.body?.data?.byCampaign), "e4: GET /admin/claims still returns a data.byCampaign array");
      assertEq(claims.body?.data?.total, claims.body?.data?.claims.length, "e5: GET /admin/claims total still matches claims.length");
      // Re-derive the same status==='verified' filter /admin/claims itself
      // uses (3 of the 6 fixture rows above: claim-a1, claim-e1, claim-d1),
      // to prove its own counting logic still works untouched by this diff.
      const expectedVerified = (claims.body?.data?.claims as any[]).filter((c) => c.status === "verified").length;
      assertEq(claims.body?.data?.verified, expectedVerified, "e6: GET /admin/claims verified count still self-consistent");
    }
  } catch (err) {
    failed++;
    failures.push(`admin-claim-funnel: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-claim-funnel.test.ts`
if (require.main === module) {
  console.log("── admin-claim-funnel (GET /admin/claim-funnel) unit tests ──");
  runAdminClaimFunnelTests({ log: true }).then((r) => {
    console.log(`\nadmin-claim-funnel: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
