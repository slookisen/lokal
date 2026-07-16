/**
 * admin-agents-recently-enriched.test.ts — unit tests for
 * GET /admin/agents/recently-enriched (src/routes/marketplace.ts).
 *
 * Slice 5 of dev-request 2026-07-13-enrichment-metode-maldrevet-evidens:
 * this endpoint feeds the platform-verifier's weekly homepage spot-check
 * with a random sample of recently-enriched agents (id/name/website/
 * last_enriched_at/field_provenance). This test file covers the read-only
 * contract only — the spot-check logic itself lives in a separate SKILL.
 *
 * Mirrors admin-agents.test.ts's setup: a fresh in-memory SQLite DB via
 * __setDbForTesting/__initSchemaForTesting (full production schema +
 * migrations, so field_provenance etc. exist exactly as in prod), the
 * route module re-required fresh, and the handler grabbed straight off
 * the router's internal stack so we can invoke it directly — no real
 * HTTP server / socket round-trip, and no env-var race with the other
 * ~40 largely-independent blocks tests/test.ts runs concurrently.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) 503 when admin key is not configured at all
 *   (c) default `since` (7 days) excludes an agent enriched 10 days ago,
 *       includes one enriched 1 day ago
 *   (d) explicit `since` param widens the window
 *   (e) invalid `since` falls back to the 7-day default rather than 400/500
 *   (f) `limit` default (10), and clamping: 0/negative -> 1, >50 -> 50
 *   (g) shape of a returned row: id/name/website/last_enriched_at/
 *       field_provenance (parsed object, not a JSON string)
 *   (h) malformed field_provenance JSON -> {} (never throws)
 *   (i) is_active = 0 agents are excluded even if recently enriched
 *   (j) an agent_knowledge row with no matching (deleted) agent doesn't
 *       leak in (the JOIN, not a LEFT JOIN, already guarantees this —
 *       asserted for regression safety)
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function runAdminAgentsRecentlyEnrichedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "recently-enriched-test-key";

  function insertAgent(row: {
    id: string;
    name: string;
    url: string;
    is_active?: number;
  }): void {
    testDb
      .prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (@id, @name, 'test agent', 'test-provider', 'test@example.no', @url, 'producer', @api_key, @is_active)`
      )
      .run({
        id: row.id,
        name: row.name,
        url: row.url,
        api_key: `key-${row.id}`,
        is_active: row.is_active ?? 1,
      });
  }

  function insertKnowledge(row: {
    agent_id: string;
    last_enriched_at: string;
    field_provenance?: string | null;
  }): void {
    testDb
      .prepare(
        `INSERT INTO agent_knowledge (agent_id, last_enriched_at, field_provenance)
         VALUES (@agent_id, @last_enriched_at, @field_provenance)`
      )
      .run({
        agent_id: row.agent_id,
        last_enriched_at: row.last_enriched_at,
        field_provenance: row.field_provenance ?? "{}",
      });
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const routePath = require.resolve("../routes/marketplace");
    delete require.cache[routePath];
    const routerModule = require("../routes/marketplace").default;
    const layer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/admin/agents/recently-enriched" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET /admin/agents/recently-enriched handler is registered on the router");
    const handler = layer.route.stack[0].handle;

    async function callEndpoint(opts: {
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: opts.headers || {}, query: opts.query || {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    {
      const r = await callEndpoint({});
      assertEq(r.status, 403, "a1: no X-Admin-Key -> 403");
      assertTrue(!r.body?.agents, "a2: no-key response carries no agents payload");
    }

    // ── (b) 503 when admin key is not configured at all ─────────────────
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const r = await callEndpoint({ headers: { "x-admin-key": "anything" } });
      assertEq(r.status, 503, "b1: admin key not configured -> 503");
      process.env.ADMIN_KEY = ADMIN_KEY;
    }

    // ── Fixtures for (c)-(j) ─────────────────────────────────────────────
    insertAgent({ id: "agent-recent", name: "Nylig Enriched Gård", url: "https://nylig.example.no" });
    insertKnowledge({
      agent_id: "agent-recent",
      last_enriched_at: daysAgoIso(1),
      field_provenance: JSON.stringify({ address: [{ source_url: "https://nylig.example.no", value: "Gata 1", quote: "Gata 1, 1234 By" }] }),
    });

    insertAgent({ id: "agent-old", name: "Gammel Enriched Gård", url: "https://gammel.example.no" });
    insertKnowledge({ agent_id: "agent-old", last_enriched_at: daysAgoIso(10) });

    insertAgent({ id: "agent-inactive", name: "Inaktiv Gård", url: "https://inaktiv.example.no", is_active: 0 });
    insertKnowledge({ agent_id: "agent-inactive", last_enriched_at: daysAgoIso(1) });

    insertAgent({ id: "agent-malformed", name: "Rar Provenance Gård", url: "https://rar.example.no" });
    insertKnowledge({ agent_id: "agent-malformed", last_enriched_at: daysAgoIso(2), field_provenance: "{not json" });

    // agent_knowledge row with no matching agent row (defensive — the inner
    // JOIN should already exclude it; foreign_keys is OFF above so this insert
    // succeeds even without a parent agents row).
    insertKnowledge({ agent_id: "agent-does-not-exist", last_enriched_at: daysAgoIso(1) });

    // ── (c) default since (7d) excludes 10-day-old, includes 1-day-old ──
    {
      const r = await callEndpoint({ headers: { "x-admin-key": ADMIN_KEY }, query: { limit: "50" } });
      assertEq(r.status, 200, "c1: default since/limit -> 200");
      const ids = (r.body.agents as any[]).map((a) => a.id).sort();
      assertTrue(ids.includes("agent-recent"), "c2: default window includes 1-day-old agent");
      assertTrue(!ids.includes("agent-old"), "c3: default window excludes 10-day-old agent");
    }

    // ── (d) explicit since widens the window to include the 10-day-old row ──
    {
      const r = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      assertEq(r.status, 200, "d1: explicit wide since -> 200");
      const ids = (r.body.agents as any[]).map((a) => a.id).sort();
      assertTrue(ids.includes("agent-old"), "d2: wide since includes 10-day-old agent");
    }

    // ── (e) invalid since falls back to the 7-day default (no 400/500) ──
    {
      const r = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: "not-a-date", limit: "50" },
      });
      assertEq(r.status, 200, "e1: invalid since -> 200 (falls back to default), not 400/500");
      const ids = (r.body.agents as any[]).map((a) => a.id).sort();
      assertTrue(ids.includes("agent-recent"), "e2: invalid-since fallback still includes 1-day-old agent");
      assertTrue(!ids.includes("agent-old"), "e3: invalid-since fallback still excludes 10-day-old agent (proves default, not '= everything')");
    }

    // ── (f) limit default + clamping ─────────────────────────────────────
    {
      const rDefault = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30) },
      });
      assertTrue(rDefault.body.agents.length <= 10, "f1: default limit is <= 10");

      const rZero = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "0" },
      });
      assertEq(rZero.body.agents.length, 1, "f2: limit=0 clamps to 1 row returned (of >=3 eligible)");

      const rNeg = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "-5" },
      });
      assertEq(rNeg.body.agents.length, 1, "f3: negative limit clamps to 1");

      const rBig = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "500" },
      });
      assertTrue(rBig.body.agents.length <= 50, "f4: limit=500 clamps to at most 50");
    }

    // ── (g) shape of a returned row ───────────────────────────────────────
    {
      const r = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const row = (r.body.agents as any[]).find((a) => a.id === "agent-recent");
      assertTrue(!!row, "g1: agent-recent row present");
      assertEq(row.name, "Nylig Enriched Gård", "g2: row carries name");
      assertEq(row.website, "https://nylig.example.no", "g3: row carries website (from agents.url)");
      assertTrue(typeof row.last_enriched_at === "string" && row.last_enriched_at.length > 0, "g4: row carries last_enriched_at");
      assertTrue(typeof row.field_provenance === "object" && row.field_provenance !== null && !Array.isArray(row.field_provenance),
        "g5: field_provenance is a parsed object, not a JSON string");
      assertTrue(Array.isArray(row.field_provenance.address), "g6: field_provenance.address survives the round-trip");
      assertEq(
        Object.keys(row).sort(),
        ["field_provenance", "id", "last_enriched_at", "name", "website"].sort(),
        "g7: row has exactly the documented fields",
      );
      assertEq(r.body.success, true, "g8: response carries success:true");
      assertEq(r.body.count, r.body.agents.length, "g9: count matches agents.length");
    }

    // ── (h) malformed field_provenance JSON -> {} (never throws) ─────────
    {
      const r = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      assertEq(r.status, 200, "h1: malformed field_provenance does not 500 the whole endpoint");
      const row = (r.body.agents as any[]).find((a) => a.id === "agent-malformed");
      assertTrue(!!row, "h2: agent-malformed row present");
      assertEq(row.field_provenance, {}, "h3: malformed field_provenance JSON -> {}");
    }

    // ── (i) is_active=0 excluded even if recently enriched ────────────────
    {
      const r = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const ids = (r.body.agents as any[]).map((a) => a.id);
      assertTrue(!ids.includes("agent-inactive"), "i1: is_active=0 agent excluded");
    }

    // ── (j) orphaned agent_knowledge row (no agents parent) never leaks in ──
    {
      const r = await callEndpoint({
        headers: { "x-admin-key": ADMIN_KEY },
        query: { since: daysAgoIso(30), limit: "50" },
      });
      const ids = (r.body.agents as any[]).map((a) => a.id);
      assertTrue(!ids.includes("agent-does-not-exist"), "j1: orphaned agent_knowledge row excluded by the inner JOIN");
    }
  } catch (err) {
    failed++;
    failures.push(`admin-agents-recently-enriched: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/marketplace")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-recently-enriched.test.ts`
if (require.main === module) {
  console.log("── admin-agents-recently-enriched (GET /admin/agents/recently-enriched) unit tests ──");
  runAdminAgentsRecentlyEnrichedTests({ log: true }).then((r) => {
    console.log(`\nadmin-agents-recently-enriched: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
