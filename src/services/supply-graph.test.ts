/**
 * supply-graph.test.ts — unit tests for src/services/supply-graph.ts
 * (dev-request 2026-07-13-supply-graph-v1, Slice 1).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/supply-graph.test.ts
 *   2. Wired into the gate: tests/test.ts imports runSupplyGraphTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";
import { computeEffectiveAvailability, setProducerAvailability, getSupplyGraphStaleDays } from "./supply-graph";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runSupplyGraphTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  // ── computeEffectiveAvailability ─────────────────────────────────────
  const now = new Date("2026-07-23T12:00:00Z");

  // Stale producer_dashboard value (>14 days old) → 'unknown'.
  {
    const staleTs = "2026-07-01 12:00:00"; // 22 days before `now`
    const result = computeEffectiveAvailability("in_stock", staleTs, "producer_dashboard", now);
    assertEq(result, "unknown", "stale producer_dashboard (22d old) → 'unknown'");
  }

  // Fresh producer_dashboard value (1 day old) → passes through unchanged.
  {
    const freshTs = "2026-07-22 12:00:00"; // 1 day before `now`
    const result = computeEffectiveAvailability("out_of_stock", freshTs, "producer_dashboard", now);
    assertEq(result, "out_of_stock", "fresh producer_dashboard (1d old) → passes through unchanged");
  }

  // Exactly at the boundary (14 days old, not over it) → still passes through.
  {
    const boundaryTs = "2026-07-09 12:00:00"; // exactly 14 days before `now`
    const result = computeEffectiveAvailability("in_stock", boundaryTs, "producer_dashboard", now);
    assertEq(result, "in_stock", "producer_dashboard exactly at the 14-day boundary → not stale (only STRICTLY over expires)");
  }

  // Just over the boundary (14.5 days old) → stale.
  {
    const overTs = "2026-07-09 00:00:00"; // 14.5 days before `now`
    const result = computeEffectiveAvailability("in_stock", overTs, "producer_dashboard", now);
    assertEq(result, "unknown", "producer_dashboard just over the 14-day boundary → 'unknown'");
  }

  // enrichment-sourced value never auto-expires regardless of age.
  {
    const veryOldTs = "2020-01-01 00:00:00";
    const result = computeEffectiveAvailability("in_stock", veryOldTs, "enrichment", now);
    assertEq(result, "in_stock", "enrichment source never auto-expires, even when very old");
  }
  {
    const result = computeEffectiveAvailability("out_of_stock", null, "enrichment", now);
    assertEq(result, "out_of_stock", "enrichment source with null availability_updated_at passes through unchanged");
  }

  // null availability_updated_at with producer_dashboard source → treated as
  // maximally stale → 'unknown'.
  {
    const result = computeEffectiveAvailability("in_stock", null, "producer_dashboard", now);
    assertEq(result, "unknown", "producer_dashboard with null availability_updated_at → 'unknown' (maximally stale)");
  }

  // Sanity: the default stale-days config is 14 unless overridden by env.
  {
    assertEq(getSupplyGraphStaleDays(), 14, "getSupplyGraphStaleDays() default is 14 (SUPPLY_GRAPH_STALE_DAYS unset)");
  }

  // ── setProducerAvailability ───────────────────────────────────────────
  // Fixture DB: real prod schema via __initSchemaForTesting, so `agents` and
  // `products` (with the new availability_updated_at/availability_source
  // columns) exist.
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db);
  __initSchemaForTesting(db);

  function insertAgent(id: string, name: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test agent', 'test', 'test@example.com', 'https://example.com', 'producer', ?)
    `).run(id, name, `key-${id}`);
  }

  function insertProduct(id: string, agentId: string, name: string, nameNorm: string): void {
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm)
      VALUES (?, ?, ?, ?)
    `).run(id, agentId, name, nameNorm);
  }

  insertAgent("agent-a", "Gård A");
  insertAgent("agent-b", "Gård B");
  insertProduct("prod-a-poteter", "agent-a", "Poteter", "poteter");
  insertProduct("prod-b-poteter", "agent-b", "Poteter", "poteter"); // same name_norm, different agent

  // Updates the correct single row by (agent_id, name_norm).
  {
    const result = setProducerAvailability("agent-a", "poteter", "out_of_stock", db);
    assertTrue(result.success === true, "setProducerAvailability succeeds for a real (agent_id, name_norm) match");
    if (result.success) {
      assertEq(result.productId, "prod-a-poteter", "setProducerAvailability returns the correct productId");
    }

    const row = db.prepare("SELECT availability, availability_source, availability_updated_at FROM products WHERE id = ?").get("prod-a-poteter") as any;
    assertEq(row.availability, "out_of_stock", "agent-a's product row availability was updated");
    assertEq(row.availability_source, "producer_dashboard", "agent-a's product row availability_source set to producer_dashboard");
    assertTrue(!!row.availability_updated_at, "agent-a's product row availability_updated_at was stamped");
  }

  // Does NOT touch a different agent's product with the same name_norm.
  {
    const row = db.prepare("SELECT availability, availability_source, availability_updated_at FROM products WHERE id = ?").get("prod-b-poteter") as any;
    assertEq(row.availability, "in_stock", "agent-b's product (same name_norm) was NOT touched — availability unchanged");
    assertEq(row.availability_source, "enrichment", "agent-b's product (same name_norm) was NOT touched — source unchanged");
    assertTrue(row.availability_updated_at === null, "agent-b's product (same name_norm) was NOT touched — availability_updated_at still null");
  }

  // Returns {success:false, reason:'not_found'} for no matching name_norm — never throws.
  {
    const result = setProducerAvailability("agent-a", "gulrøtter", "in_stock", db);
    assertEq(result, { success: false, reason: "not_found" }, "unknown name_norm → {success:false, reason:'not_found'}");
  }

  // Returns {success:false, reason:'not_found'} for an unknown agent — never throws.
  {
    const result = setProducerAvailability("agent-does-not-exist", "poteter", "in_stock", db);
    assertEq(result, { success: false, reason: "not_found" }, "unknown agent_id → {success:false, reason:'not_found'}");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runSupplyGraphTests({ log: true });
  console.log(`\nsupply-graph: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
