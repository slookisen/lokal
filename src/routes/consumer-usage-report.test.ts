/**
 * consumer-usage-report.test.ts — GET /admin/analytics/consumer-usage
 * (dev-request 2026-07-13-agent-identity-usage-ledger, slice 2 / acceptance
 * criterion 3's second half: "topp konsumenter siste 7/30 dager").
 *
 * Same in-memory-DB + hand-rolled req/res convention as
 * mcp-usage-logger.test.ts's GET /admin/analytics/mcp-usage coverage (item
 * 10 there) — router.handle() directly, real schema via
 * __setDbForTesting/__initSchemaForTesting, no supertest/network calls.
 *
 * Covers:
 *   1. Aggregates total_calls/distinct_tools per key across the window,
 *      ordered by total_calls desc.
 *   2. Respects ?days= (rows outside the window are excluded).
 *   3. Respects ?limit= (top-N truncation).
 *   4. byTool aggregates across all keys.
 *   5. A revoked key's historical usage still appears (revoke != erase != drop).
 *   6. An erased key's usage still appears, surfaced with label:null (erase
 *      nulls PII but the aggregate row/history is preserved by design).
 *   7. totalKeysIssued/activeKeys counts are correct.
 *   8. requireAdminAuth applies to this route (missing X-Admin-Key -> 401).
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { url: string; headers?: Record<string, string>; query?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url.split("?")[0],
      query: opts.query || {},
      headers,
      hostname: "rettfrabonden.com",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export async function runConsumerUsageReportTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevDb = initMod.getDb();
  const db = new Database(":memory:");
  try {
    // Determinisme (2026-08-02): adopter suitens kanoniske nøkkel når den
    // finnes (se SHARED GLOBAL STATE-kontrakten i tests/test.ts).
    // dev-request 2026-07-28-visibility-admin-key-naar-ikke-frem
    // (analytics.ts slice): requireAdminAuth() now checks ADMIN_KEY
    // (primary) before ANALYTICS_ADMIN_KEY (legacy fallback) — GET
    // /admin/analytics/consumer-usage below is gated by it, so this key
    // must adopt ADMIN_KEY first, or the suite-wide ADMIN_KEY value
    // (always set — see tests/test.ts's SUITE_ADMIN_KEY) wins instead.
    const usageKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "test-consumer-usage-key";
    process.env.ADMIN_KEY = usageKey;
    process.env.ANALYTICS_ADMIN_KEY = usageKey;
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);

    const day = (daysAgo: number) => {
      const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    };

    const insertKey = db.prepare(
      `INSERT INTO consumer_api_keys (key_hash, label, rate_tier, revoked_at, deleted_at)
       VALUES (?, ?, 'keyed', ?, ?)`,
    );
    const activeKey = insertKey.run("hash-active", "Active Consumer", null, null).lastInsertRowid as number;
    const revokedKey = insertKey.run("hash-revoked", "Revoked Consumer", "2026-01-01 00:00:00", null)
      .lastInsertRowid as number;
    const erasedKey = insertKey.run("hash-erased", null, "2026-01-01 00:00:00", "2026-01-01 00:00:00")
      .lastInsertRowid as number;
    const quietKey = insertKey.run("hash-quiet", "No Usage Yet", null, null).lastInsertRowid as number;

    const insertLedger = db.prepare(
      `INSERT INTO consumer_usage_ledger (key_id, endpoint_or_tool, day, call_count)
       VALUES (?, ?, ?, ?)`,
    );
    // Active key: heaviest usage, spread across 2 tools, well inside a 7d window.
    insertLedger.run(activeKey, "lokal_search", day(1), 40);
    insertLedger.run(activeKey, "lokal_discover", day(2), 10);
    // Revoked key: usage predates the revoke, but still inside the 7d window —
    // must still count (revoke stops future recognition, not history).
    insertLedger.run(revokedKey, "lokal_search", day(3), 15);
    // Erased key: same — must still count, surfaced with label already null.
    insertLedger.run(erasedKey, "lokal_info", day(1), 5);
    // A row outside the 7-day window entirely (must be excluded by default).
    insertLedger.run(activeKey, "lokal_search", day(20), 999);

    const { default: router } = require("./analytics") as { default: any };

    // ── 1/2/4/7: default ?days=7 aggregation ─────────────────────────────
    const week = await callRoute(router, {
      url: "/consumer-usage",
      headers: { "x-admin-key": usageKey },
    });
    assertEq(week.status, 200, "cur-1: GET /admin/analytics/consumer-usage -> 200");
    assertEq(week.body.timeframe, "last 7 days", "cur-2: default timeframe is 7 days");

    const active = week.body.topConsumers.find((c: any) => c.key_id === activeKey);
    assertEq(active?.total_calls, 50, "cur-3: active key's calls sum across both its ledger rows (40+10), excluding the >7d row");
    assertEq(active?.distinct_tools, 2, "cur-4: active key used 2 distinct tools");
    assertEq(week.body.topConsumers[0]?.key_id, activeKey, "cur-5: topConsumers is ordered by total_calls desc (active key first)");

    assertEq(
      week.body.byTool.find((t: any) => t.endpoint_or_tool === "lokal_search")?.total_calls,
      55,
      "cur-6: byTool sums lokal_search across all keys within the window (40 active + 15 revoked)",
    );

    assertEq(week.body.totalKeysIssued, 4, "cur-7: totalKeysIssued counts every issued key regardless of state");
    assertEq(week.body.activeKeys, 2, "cur-8: activeKeys excludes the revoked and erased keys (active + quiet)");
    assertEq(
      week.body.topConsumers.some((c: any) => c.key_id === quietKey),
      false,
      "cur-9: a key with zero usage in the window never appears in topConsumers",
    );

    // ── 5: revoked key's historical usage still appears ──────────────────
    const revoked = week.body.topConsumers.find((c: any) => c.key_id === revokedKey);
    assertEq(revoked?.total_calls, 15, "cur-10: a revoked key's pre-revoke usage still counts");
    assertEq(revoked?.revoked, 1, "cur-11: revoked flag is surfaced (1/truthy) for a revoked key");

    // ── 6: erased key's usage still appears, label already null ─────────
    const erased = week.body.topConsumers.find((c: any) => c.key_id === erasedKey);
    assertEq(erased?.total_calls, 5, "cur-12: an erased key's pre-erasure usage still counts");
    assertEq(erased?.label, null, "cur-13: an erased key surfaces with label:null (PII already cleared by erasure)");
    assertEq(erased?.erased, 1, "cur-14: erased flag is surfaced (1/truthy) for an erased key");

    // ── 2 (cont.): ?days= widens the window to include the 20-day-old row ─
    const month = await callRoute(router, {
      url: "/consumer-usage",
      query: { days: "30" },
      headers: { "x-admin-key": usageKey },
    });
    assertEq(month.body.timeframe, "last 30 days", "cur-15: ?days=30 reflects in timeframe");
    const activeMonth = month.body.topConsumers.find((c: any) => c.key_id === activeKey);
    assertEq(activeMonth?.total_calls, 1049, "cur-16: ?days=30 widens the window to include the 20-day-old row (40+10+999)");

    // ── 3: ?limit= truncates topConsumers ─────────────────────────────────
    const limited = await callRoute(router, {
      url: "/consumer-usage",
      query: { days: "30", limit: "1" },
      headers: { "x-admin-key": usageKey },
    });
    assertEq(limited.body.topConsumers.length, 1, "cur-17: ?limit=1 returns exactly one consumer");
    assertEq(limited.body.topConsumers[0]?.key_id, activeKey, "cur-18: ?limit=1 keeps the highest-volume consumer");

    // ── 8: auth applies ────────────────────────────────────────────────
    const noKey = await callRoute(router, { url: "/consumer-usage" });
    assertEq(noKey.status, 401, "cur-19: missing X-Admin-Key -> 401 (requireAdminAuth applies to this route)");
  } catch (err) {
    failed++;
    failures.push(`consumer-usage-report: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    initMod.__setDbForTesting(prevDb);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runConsumerUsageReportTests({ log: true }).then((summary) => {
    console.log(`\nconsumer-usage-report: ${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
