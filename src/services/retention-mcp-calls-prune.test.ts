/**
 * retention-mcp-calls-prune.test.ts — dev-request
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet, track C3.
 *
 * Proves:
 *   1. pruneAnalyticsMcpCalls() (services/retention-service.ts) deletes only
 *      analytics_mcp_calls rows older than the cutoff, leaves newer rows
 *      alone, and its dryRun mode counts without deleting anything.
 *   2. AnalyticsService.runAutoPrune() (services/analytics-service.ts) —
 *      the function the daily scheduler AND both admin prune routes
 *      (/admin/analytics/prune, /admin/analytics/ops/prune) delegate to —
 *      now folds analytics_mcp_calls into the SAME pass, same window as
 *      analytics_page_views, and reports it as deleted.mcpCalls.
 *
 * Standalone: npx tsx src/services/retention-mcp-calls-prune.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRetentionMcpCallsPruneTests(opts: { log?: boolean } = {}): TestSummary {
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

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Bust caches so both services see the injected in-memory DB (same
    // convention as analytics-ops-prune-rollup.test.ts).
    for (const m of ["./retention-service", "./analytics-service"]) {
      delete require.cache[require.resolve(m)];
    }
    const retentionMod = require("./retention-service") as typeof import("./retention-service");
    const analyticsMod = require("./analytics-service") as typeof import("./analytics-service");

    function isoDaysAgo(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }

    const DAYS_TO_KEEP = 60;

    function seedMcpCalls(): { old: number; recent: number } {
      testDb.exec("DELETE FROM analytics_mcp_calls;");
      const insert = testDb.prepare(`
        INSERT INTO analytics_mcp_calls
          (protocol, vertical_id, tool_name, client_name, client_version, user_agent, ip_hash, duration_ms, is_owner, created_at)
        VALUES ('mcp', 'rfb', 'lokal_search', 'ChatGPT', NULL, 'ChatGPT-User/1.0', 'abc123', 42, 0, ?)
      `);
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);
      let old = 0;
      for (let i = 0; i < 7; i++) { insert.run(oldCreated); old++; }
      let recent = 0;
      for (let i = 0; i < 4; i++) { insert.run(newCreated); recent++; }
      return { old, recent };
    }

    const count = () => (testDb.prepare("SELECT COUNT(*) as c FROM analytics_mcp_calls").get() as { c: number }).c;

    // ── pruneAnalyticsMcpCalls: dryRun counts, deletes nothing ───────────
    {
      const seeded = seedMcpCalls();
      const dry = retentionMod.pruneAnalyticsMcpCalls(DAYS_TO_KEEP, true);
      assertEq(dry.rowsDeleted, 0, "pruneAnalyticsMcpCalls dryRun=true: rowsDeleted is 0 (a dry run deletes nothing)");
      assertEq(count(), seeded.old + seeded.recent, "pruneAnalyticsMcpCalls dryRun=true: no rows actually removed");
    }

    // ── pruneAnalyticsMcpCalls: real run deletes only the old rows ───────
    {
      const seeded = seedMcpCalls();
      const real = retentionMod.pruneAnalyticsMcpCalls(DAYS_TO_KEEP, false);
      assertEq(real.rowsDeleted, seeded.old, "pruneAnalyticsMcpCalls: deletes exactly the rows older than the cutoff");
      assertEq(count(), seeded.recent, "pruneAnalyticsMcpCalls: only the newer rows remain");

      // Idempotent: a second run finds nothing left to delete.
      const again = retentionMod.pruneAnalyticsMcpCalls(DAYS_TO_KEEP, false);
      assertEq(again.rowsDeleted, 0, "pruneAnalyticsMcpCalls: re-running is a no-op once nothing is left older than the cutoff");
    }

    // ── AnalyticsService.runAutoPrune() folds this table into the same
    // daily pass and reports it as deleted.mcpCalls ─────────────────────
    {
      // Clear the other 2 analytics tables too so runAutoPrune's own
      // page-view/query/agent-view work doesn't interfere with reading
      // just the mcpCalls count out of its return value.
      testDb.exec("DELETE FROM analytics_page_views; DELETE FROM analytics_queries; DELETE FROM analytics_agent_views;");
      const seeded = seedMcpCalls();
      const result = analyticsMod.analyticsService.runAutoPrune({ daysToKeep: DAYS_TO_KEEP });
      assertTrue(typeof result.deleted.mcpCalls === "number", "runAutoPrune: deleted.mcpCalls is present and numeric");
      assertEq(result.deleted.mcpCalls, seeded.old, "runAutoPrune: deleted.mcpCalls matches the rows older than daysKept");
      assertEq(count(), seeded.recent, "runAutoPrune: only newer analytics_mcp_calls rows remain after the pass");
    }
  } finally {
    __setDbForTesting(prevDb as any);
    for (const m of ["./retention-service", "./analytics-service"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runRetentionMcpCallsPruneTests({ log: true });
  console.log(`\nretention-mcp-calls-prune: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
