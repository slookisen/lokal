/**
 * health-write-probe.test.ts — dev-request 2026-09-28-health-endepunkt-maaler-
 * ikke-skrivesti (A2A). In-memory DB, injected clock.
 */

import Database from "better-sqlite3";
import { getWritePathHealth, __resetWriteProbeCacheForTesting, WRITE_PROBE_TTL_MS } from "./health-write-probe";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runHealthWriteProbeTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const db = new Database(":memory:");
  try {
    const t0 = Date.parse("2026-09-28T12:00:00Z");
    __resetWriteProbeCacheForTesting();
    const a = getWritePathHealth(db, t0);
    assertTrue(a.ok === true && a.error === undefined, "healthy DB: probe ok");
    const row = db.prepare("SELECT probed_at FROM health_write_probe WHERE id = 1").get() as any;
    assertTrue(row?.probed_at === new Date(t0).toISOString(), "probe wrote its timestamp");

    // Cached: a failure inside the TTL is not seen (no write per HTTP call).
    db.exec("DROP TABLE health_write_probe; CREATE VIEW health_write_probe AS SELECT 1 AS id, 'x' AS probed_at");
    const b = getWritePathHealth(db, t0 + 5_000);
    assertTrue(b.ok === true && b.cachedAgeMs === 5_000, "within TTL: cached result, no new write");

    // After TTL the failing write path is reported.
    const c = getWritePathHealth(db, t0 + WRITE_PROBE_TTL_MS + 1);
    assertTrue(c.ok === false && typeof c.error === "string" && c.error.length > 0, "after TTL: write failure detected");
    assertTrue(c.cachedAgeMs === 0, "fresh failure has cachedAgeMs 0");

    // Recovery.
    db.exec("DROP VIEW health_write_probe");
    const d = getWritePathHealth(db, t0 + 2 * WRITE_PROBE_TTL_MS + 2);
    assertTrue(d.ok === true, "recovers once writes work again");
  } finally {
    db.close();
    __resetWriteProbeCacheForTesting();
  }
  return { passed, failed, failures };
}
