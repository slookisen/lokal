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

  // B1b-2: the row is now owner-controlled (producer_dashboard), so its price is kept.
  assertEq(afterSync.price_nok, 30, "guard: owner-controlled price_nok is kept (B1b-2) — conflict path ran, price untouched");
  assertEq(afterSync.availability, "out_of_stock",
    "guard: producer_dashboard-sourced availability is UNCHANGED after the sync re-run — the core safety guarantee");
  assertEq(afterSync.availability_source, "producer_dashboard",
    "guard: availability_source is UNCHANGED after the sync re-run");
  assertEq(afterSync.availability_updated_at, afterProducerSet.availability_updated_at,
    "guard: availability_updated_at timestamp is UNCHANGED after the sync re-run (the sync never touches this column)");

  // Row count stays 1 for pcs-guard — this was an update, not a duplicate insert.
  const guardCount = (db.prepare("SELECT COUNT(*) AS c FROM products WHERE agent_id = 'pcs-guard'").get() as { c: number }).c;
  assertEq(guardCount, 1, `guard: still exactly 1 product row for pcs-guard (got ${guardCount})`);

  // ══════════════════════════════════════════════════════════════════════
  // B1b-2: the sync never overwrites price_nok / category of owner-controlled
  // rows, and updated_at does not move; a plain scraped row still updates.
  // ══════════════════════════════════════════════════════════════════════
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
    VALUES ('pcs-own', 'Eier Gård', 'test', 'test', 'eier@example.com', 'https://example.com', 'producer', 'key-pcs-own', 'Oslo')
  `).run();
  const OLD = "2020-01-01 00:00:00";
  const ownerRow = (id: string, name: string, source: string, avSource: string) =>
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, category, price_nok, currency, availability, source,
                            availability_source, created_at, updated_at)
      VALUES (?, 'pcs-own', ?, ?, 'cat-old', 10, 'NOK', 'in_stock', ?, ?, ?, ?)
    `).run(id, name, name.toLowerCase(), source, avSource, OLD, OLD);
  ownerRow("own-dash", "Honning", "enrichment", "producer_dashboard");
  ownerRow("own-added", "Syltetøy", "owner", "producer_dashboard");
  ownerRow("own-added-nodash", "Saft", "owner", "enrichment");
  ownerRow("own-admin", "Ost", "enrichment", "admin_producer_confirmed");
  ownerRow("own-plain", "Brød", "enrichment", "enrichment");
  db.prepare(`INSERT INTO agent_knowledge (agent_id, products, verification_status) VALUES ('pcs-own', ?, 'verified')`).run(
    JSON.stringify([
      { name: "Honning", category: "new-cat", price: "99 kr" },
      { name: "Syltetøy", category: "new-cat", price: "99 kr" },
      { name: "Saft", category: "new-cat", price: "99 kr" },
      { name: "Ost", category: "new-cat", price: "99 kr" },
      { name: "Brød", category: "new-cat", price: "99 kr" },
    ]));
  const r4 = runProductCatalogSync(db);
  assertTrue(r4.success, "B1b-2: sync succeeded");
  const getRow = (id: string) => db.prepare("SELECT price_nok, category, source, updated_at FROM products WHERE id = ?").get(id) as
    { price_nok: number; category: string; source: string; updated_at: string };
  for (const [id, label] of [["own-dash", "producer_dashboard row"], ["own-added", "owner-added row"],
                             ["own-added-nodash", "owner-added row without producer_dashboard"],
                             ["own-admin", "admin_producer_confirmed row"]] as const) {
    const row = getRow(id);
    assertEq(row.price_nok, 10, `B1b-2: ${label}: price_nok unchanged`);
    assertEq(row.category, "cat-old", `B1b-2: ${label}: category unchanged`);
    assertEq(row.updated_at, OLD, `B1b-2: ${label}: updated_at did not move`);
  }
  assertEq(getRow("own-added").source, "owner", "B1b-2: owner-added row keeps source 'owner'");
  const plain = getRow("own-plain");
  assertEq(plain.price_nok, 99, "B1b-2: plain scraped row: price still updated");
  assertEq(plain.category, "new-cat", "B1b-2: plain scraped row: category still updated");
  assertTrue(plain.updated_at !== OLD, "B1b-2: plain scraped row: updated_at moved");

  assertTrue(r4.success && r4.updated >= 5, "B1b-2: conflict path ran for the guarded rows (updated counter)");

  // ── B1b-2 review fix: owner-SUPPLIED incoming prices still update owner rows ──
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
    VALUES ('pcs-own2', 'Eier Gård 2', 'test', 'test', 'eier2@example.com', 'https://example.com', 'producer', 'key-pcs-own2', 'Oslo')
  `).run();
  const ownerRow2 = (id: string, name: string, source: string, avSource: string, srcUrl: string | null) =>
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, category, price_nok, currency, availability, source, source_url,
                            availability_source, created_at, updated_at)
      VALUES (?, 'pcs-own2', ?, ?, 'cat-old', 10, 'NOK', 'in_stock', ?, ?, ?, ?, ?)
    `).run(id, name, name.toLowerCase(), source, srcUrl, avSource, OLD, OLD);
  ownerRow2("o2-dash-imp", "Epler", "owner_import", "producer_dashboard", "https://old.example/a");
  ownerRow2("o2-dash-scr", "Pærer", "owner_import", "producer_dashboard", "https://old.example/b");
  ownerRow2("o2-owner", "Plommer", "owner", "enrichment", null);
  ownerRow2("o2-admin", "Kirsebær", "enrichment", "admin_producer_confirmed", null);
  ownerRow2("o2-admin-imp", "Bringebær", "enrichment", "admin_producer_confirmed", null);
  db.prepare(`INSERT INTO agent_knowledge (agent_id, products, verification_status) VALUES ('pcs-own2', ?, 'verified')`).run(
    JSON.stringify([
      // (a) owner_import incoming on a producer_dashboard row
      { name: "Epler", category: "new-cat", price: "77 kr", source: "owner_import", sourceUrl: "https://new.example/a", fetchedAt: "2026-10-30" },
      // (e) scraped incoming on a producer_dashboard row
      { name: "Pærer", category: "new-cat", price: "99 kr", source: "enrichment", sourceUrl: "https://scrape.example/b", fetchedAt: "2026-10-30" },
      // (b) owner-sourced incoming on a source='owner' row
      { name: "Plommer", category: "new-cat", price: "55 kr", source: "owner_manual" },
      // (d) admin_producer_confirmed blocks scraped and owner-sourced incoming
      { name: "Kirsebær", category: "new-cat", price: "99 kr", source: "enrichment" },
      { name: "Bringebær", category: "new-cat", price: "99 kr", source: "owner_import", sourceUrl: "https://new.example/c" },
    ]));
  const r5 = runProductCatalogSync(db);
  assertTrue(r5.success && r5.inserted === 0 && r5.updated >= 5, "B1b-2 fix: conflict path ran (no inserts, updated counter covers the five rows)");
  const getRow2 = (id: string) => db.prepare("SELECT price_nok, category, source, source_url, fetched_at, updated_at FROM products WHERE id = ?").get(id) as
    { price_nok: number; category: string; source: string; source_url: string | null; fetched_at: string | null; updated_at: string };
  const a = getRow2("o2-dash-imp");
  assertEq(a.price_nok, 77, "B1b-2 fix (a): owner_import price updates a producer_dashboard row");
  assertEq(a.category, "new-cat", "B1b-2 fix (a): owner_import category updates");
  assertEq([a.source, a.source_url, a.fetched_at], ["owner_import", "https://new.example/a", "2026-10-30"], "B1b-2 fix (a): provenance comes from the import");
  assertTrue(a.updated_at !== OLD, "B1b-2 fix (a): updated_at moved");
  const b = getRow2("o2-owner");
  assertEq(b.price_nok, 55, "B1b-2 fix (b): owner-sourced price updates a source='owner' row");
  assertEq(b.category, "new-cat", "B1b-2 fix (b): category updates");
  assertEq(b.source, "owner", "B1b-2 fix (b): row keeps source 'owner' (written by another writer)");
  assertTrue(b.updated_at !== OLD, "B1b-2 fix (b): updated_at moved");
  const e = getRow2("o2-dash-scr");
  assertEq([e.price_nok, e.category, e.updated_at], [10, "cat-old", OLD], "B1b-2 fix (c): scraped incoming blocked on producer_dashboard row");
  assertEq([e.source, e.source_url, e.fetched_at], ["owner_import", "https://old.example/b", null],
    "B1b-2 fix (e): blocked scrape leaves provenance unchanged (no false price origin)");
  for (const id of ["o2-admin", "o2-admin-imp"]) {
    const d = getRow2(id);
    assertEq([d.price_nok, d.category, d.updated_at, d.source, d.source_url], [10, "cat-old", OLD, "enrichment", null],
      `B1b-2 fix (d): admin_producer_confirmed row ${id} fully protected (price, category, provenance)`);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runProductCatalogSyncTests({ log: true }).then((r) => {
    console.log(`\nproduct-catalog-sync: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) process.exit(1);
  });
}
