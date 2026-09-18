/**
 * product-catalog-sync.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 0.
 *
 * Proves runProductCatalogSync() (extracted from POST /admin/products/
 * backfill so the new daily scheduler in src/index.ts can call the exact
 * same logic):
 *   - inserts new product rows from agent_knowledge.products, same
 *     header/noise skipping + in-batch name_norm dedupe as before.
 *   - is idempotent — a second run updates, never duplicates.
 *   - CRITICAL SAFETY: never overwrites `availability` (or
 *     availability_source / availability_updated_at) on ANY row, in
 *     particular a producer_dashboard-sourced row whose availability a
 *     producer set themselves via the owner-portal write path — this is the
 *     "supply-graph" guarantee the dev-request calls out explicitly.
 *
 * Harness: real better-sqlite3 schema in memory (mirrors
 * marketplace-catalog-supply-graph.test.ts), db passed directly into
 * runProductCatalogSync(db) — no need to touch the getDb() singleton at all.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/services/product-catalog-sync.test.ts
 *   2. Wired into tests/test.ts.
 */

import Database from "better-sqlite3";
import { __initSchemaForTesting } from "../database/init";
import { runProductCatalogSync } from "./product-catalog-sync";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runProductCatalogSyncTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __initSchemaForTesting(db as any);

  // ── Fixture agents ────────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
    VALUES ('pcs-agent', 'Sync Gård', 'test', 'test', 'sync@example.com', 'https://example.com', 'producer', 'key-pcs-agent', 'Oslo')
  `).run();

  db.prepare(`
    INSERT INTO agent_knowledge (agent_id, products, verification_status)
    VALUES ('pcs-agent', ?, 'verified')
  `).run(JSON.stringify([
    { name: "Poteter", category: "vegetables", price: "20 kr" },
    { name: "Egg", category: "eggs", price: "kr 55" },
    { name: "GRØNNSAKER", category: "other" },     // header — expect skipped
    { name: "❌ Tomt for poteter", category: "other" }, // noise — expect skipped
  ]));

  // ── Run 1: inserts real products, skips header/noise ────────────────────
  const r1 = runProductCatalogSync(db);
  assertTrue(r1.success, "run1: success");
  if (r1.success) {
    assertEq(r1.agents_processed, 1, "run1: agents_processed=1");
    assertEq(r1.inserted, 2, `run1: inserted=2 (Poteter+Egg, got ${r1.inserted})`);
    assertTrue(r1.skipped >= 1, `run1: skipped >= 1 (noise, got ${r1.skipped})`);
  }
  const countAfterRun1 = (db.prepare("SELECT COUNT(*) AS c FROM products").get() as { c: number }).c;
  assertEq(countAfterRun1, 2, `run1: exactly 2 product rows exist (got ${countAfterRun1})`);

  // ── Run 2: idempotent — no duplicate rows, inserted=0 ───────────────────
  const r2 = runProductCatalogSync(db);
  assertTrue(r2.success, "run2: success");
  if (r2.success) {
    assertEq(r2.inserted, 0, `run2: re-run inserted=0 (got ${r2.inserted})`);
    assertTrue(r2.updated >= 2, `run2: re-run updated>=2 (got ${r2.updated})`);
  }
  const countAfterRun2 = (db.prepare("SELECT COUNT(*) AS c FROM products").get() as { c: number }).c;
  assertEq(countAfterRun2, 2, `run2: row count stable after re-run (got ${countAfterRun2})`);

  // ══════════════════════════════════════════════════════════════════════
  // CRITICAL SAFETY: a producer_dashboard-sourced row's availability must
  // survive a sync run untouched, even when the SAME product name reappears
  // in agent_knowledge.products (i.e. the sync's ON CONFLICT path fires for
  // that exact row).
  // ══════════════════════════════════════════════════════════════════════
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
    VALUES ('pcs-guard', 'Vern Gård', 'test', 'test', 'vern@example.com', 'https://example.com', 'producer', 'key-pcs-guard', 'Bergen')
  `).run();
  db.prepare(`
    INSERT INTO agent_knowledge (agent_id, products, verification_status)
    VALUES ('pcs-guard', ?, 'verified')
  `).run(JSON.stringify([
    { name: "Gulrøtter", category: "vegetables", price: "30 kr" },
  ]));

  // First sync creates the row as 'enrichment'-sourced, in_stock.
  runProductCatalogSync(db);
  const beforeGuardRow = db.prepare(
    "SELECT id, availability, availability_source, availability_updated_at FROM products WHERE agent_id = 'pcs-guard' AND name_norm = 'gulrøtter'"
  ).get() as { id: string; availability: string; availability_source: string; availability_updated_at: string | null };
  assertTrue(!!beforeGuardRow, "guard: row exists after first sync");

  // Simulate the producer setting their own availability via the
  // owner-portal write path (setProducerAvailability's exact UPDATE shape —
  // same as src/services/supply-graph.ts).
  db.prepare(`
    UPDATE products
       SET availability = 'out_of_stock',
           availability_source = 'producer_dashboard',
           availability_updated_at = datetime('now')
     WHERE id = ?
  `).run(beforeGuardRow.id);

  const afterProducerSet = db.prepare(
    "SELECT availability, availability_source, availability_updated_at FROM products WHERE id = ?"
  ).get(beforeGuardRow.id) as { availability: string; availability_source: string; availability_updated_at: string };
  assertEq(afterProducerSet.availability, "out_of_stock", "guard: producer-set availability recorded before sync re-run");
  assertEq(afterProducerSet.availability_source, "producer_dashboard", "guard: availability_source recorded before sync re-run");

  // Re-run the sync — same product name still present in agent_knowledge,
  // AND its price changed, so the ON CONFLICT path definitely fires for
  // this exact row (price_nok is updated).
  db.prepare(`UPDATE agent_knowledge SET products = ? WHERE agent_id = 'pcs-guard'`).run(
    JSON.stringify([{ name: "Gulrøtter", category: "vegetables", price: "45 kr" }])
  );
  const r3 = runProductCatalogSync(db);
  assertTrue(r3.success, "guard: sync re-run succeeded");

  const afterSync = db.prepare(
    "SELECT price_nok, availability, availability_source, availability_updated_at FROM products WHERE id = ?"
  ).get(beforeGuardRow.id) as { price_nok: number; availability: string; availability_source: string; availability_updated_at: string };

  assertEq(afterSync.price_nok, 45, "guard: price_nok WAS updated by the sync (conflict path definitely ran)");
  assertEq(afterSync.availability, "out_of_stock",
    "guard: producer_dashboard-sourced availability is UNCHANGED after the sync re-run — the core safety guarantee");
  assertEq(afterSync.availability_source, "producer_dashboard",
    "guard: availability_source is UNCHANGED after the sync re-run");
  assertEq(afterSync.availability_updated_at, afterProducerSet.availability_updated_at,
    "guard: availability_updated_at timestamp is UNCHANGED after the sync re-run (the sync never touches this column)");

  // Row count stays 1 for pcs-guard — this was an update, not a duplicate insert.
  const guardCount = (db.prepare("SELECT COUNT(*) AS c FROM products WHERE agent_id = 'pcs-guard'").get() as { c: number }).c;
  assertEq(guardCount, 1, `guard: still exactly 1 product row for pcs-guard (got ${guardCount})`);

  return { passed, failed, failures };
}

if (require.main === module) {
  runProductCatalogSyncTests({ log: true }).then((r) => {
    console.log(`\nproduct-catalog-sync: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
