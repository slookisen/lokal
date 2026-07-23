/**
 * mcp-supply-graph.test.ts — additive-regression tests for the product
 * formatting used by the lokal_search / lokal_discover / lokal_info MCP
 * tools (src/routes/mcp.ts: formatProductsForMcp, getCatalogAvailabilityMap)
 * (dev-request 2026-07-13-supply-graph-v1, Slice 1).
 *
 * formatProductsForMcp() renders a markdown text block (the MCP tools return
 * `{content:[{type:"text", text: ...}]}`, not JSON product objects), so
 * "byte-identical for every pre-existing field" here means: calling it
 * WITHOUT an availability map produces the exact same text as before this
 * change, and the new availability annotation is purely an appended suffix
 * that never alters the pre-existing `- name [cat] — price 🌿sesong  · id: X`
 * prefix.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/mcp-supply-graph.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMcpSupplyGraphTests() and folds its pass/fail counts into the
 *      `npm test` summary.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { formatProductsForMcp, getCatalogProductIdMap, getCatalogAvailabilityMap } from "./mcp";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runMcpSupplyGraphTests(opts: { log?: boolean } = {}): TestSummary {
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

  const products = [{ name: "Poteter", category: "vegetables" }];

  // ── Regression guard: calling formatProductsForMcp exactly as pre-change
  // callers did (2-arg form, no availability map) is byte-identical output. ──
  {
    const before = formatProductsForMcp(products, undefined);
    assertEq(before, "\n## Produkter (1 stk)\n- Poteter [vegetables]", "formatProductsForMcp(products, undefined): byte-identical pre-existing output, no availability suffix");
  }
  {
    const idMap = new Map([["poteter", "prod-123"]]);
    const before = formatProductsForMcp(products, idMap);
    assertEq(before, "\n## Produkter (1 stk)\n- Poteter [vegetables]  · id: prod-123", "formatProductsForMcp(products, idMap): pre-existing `· id:` suffix unchanged when no availability map given");
  }

  // ── New: availability annotation is purely additive when a map is given ──
  {
    const idMap = new Map([["poteter", "prod-123"]]);
    const availMap = new Map([["poteter", { availability: "unknown", availabilityUpdatedAt: "2026-07-01 12:00:00" }]]);
    const out = formatProductsForMcp(products, idMap, availMap);
    assertEq(
      out,
      "\n## Produkter (1 stk)\n- Poteter [vegetables]  · id: prod-123  · availability: unknown  · availability_updated_at: 2026-07-01 12:00:00",
      "formatProductsForMcp: pre-existing prefix unchanged, new availability + availability_updated_at appended additively"
    );
  }
  {
    // No matching entry in the availability map (e.g. product not yet in the
    // catalog table) → no suffix at all, same as the `id` behaviour.
    const out = formatProductsForMcp(products, undefined, new Map());
    assertEq(out, "\n## Produkter (1 stk)\n- Poteter [vegetables]", "formatProductsForMcp: no availability-map match → no suffix (mirrors `id` behaviour)");
  }

  // ── getCatalogAvailabilityMap: real DB, stale vs fresh vs enrichment ──
  const prevDb = initMod.getDb();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  (initMod as any).__setDbForTesting(db);
  (initMod as any).__initSchemaForTesting(db);

  try {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('agent-mcp-sg', 'MCP SG Gård', 't', 't', 't@example.com', 'https://example.com', 'producer', 'key-agent-mcp-sg')
    `).run();

    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, availability, availability_updated_at, availability_source)
      VALUES ('p-fresh', 'agent-mcp-sg', 'Ferske Poteter', 'ferske poteter', 'in_stock', datetime('now', '-1 day'), 'producer_dashboard')
    `).run();
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, availability, availability_updated_at, availability_source)
      VALUES ('p-stale', 'agent-mcp-sg', 'Gamle Gulrøtter', 'gamle gulrøtter', 'in_stock', datetime('now', '-20 days'), 'producer_dashboard')
    `).run();
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, availability)
      VALUES ('p-enrich', 'agent-mcp-sg', 'Enrichment Eple', 'enrichment eple', 'out_of_stock')
    `).run();

    const map = getCatalogAvailabilityMap("agent-mcp-sg", db);

    const fresh = map.get("ferske poteter");
    assertTrue(!!fresh, "getCatalogAvailabilityMap: fresh producer_dashboard row present");
    assertEq(fresh?.availability, "in_stock", "getCatalogAvailabilityMap: fresh (1d) producer_dashboard row's effective availability unchanged");
    assertTrue(!!fresh?.availabilityUpdatedAt, "getCatalogAvailabilityMap: fresh row's raw availabilityUpdatedAt populated");

    const stale = map.get("gamle gulrøtter");
    assertEq(stale?.availability, "unknown", "getCatalogAvailabilityMap: stale (20d) producer_dashboard row's effective availability is 'unknown'");
    assertTrue(!!stale?.availabilityUpdatedAt, "getCatalogAvailabilityMap: stale row's raw availabilityUpdatedAt still populated (not hidden)");

    const enrich = map.get("enrichment eple");
    assertEq(enrich?.availability, "out_of_stock", "getCatalogAvailabilityMap: enrichment row's effective availability passes through unchanged");
    assertTrue(enrich?.availabilityUpdatedAt === null, "getCatalogAvailabilityMap: enrichment row's availabilityUpdatedAt is null");

    // getCatalogProductIdMap (pre-existing function) is unaffected by this change.
    const idMap = getCatalogProductIdMap("agent-mcp-sg", db);
    assertEq(idMap.get("ferske poteter"), "p-fresh", "getCatalogProductIdMap: pre-existing id-map behaviour unaffected (in_stock rows included)");
    assertTrue(!idMap.has("enrichment eple"), "getCatalogProductIdMap: pre-existing filter behaviour unaffected (out_of_stock rows excluded)");
  } finally {
    (initMod as any).__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runMcpSupplyGraphTests({ log: true });
  console.log(`\nmcp-supply-graph: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) process.exit(1);
}
