/**
 * product-availability-service.test.ts — unit tests for
 * setProductAvailability() (src/services/product-availability-service.ts)
 * and the pure helpers in src/config/supply-graph.ts.
 *
 * dev-request 2026-07-23-supplygraph ("Local Supply Graph v1").
 *
 * Covers:
 *   - setProductAvailability(): happy path, wrong-agent rejection (returns
 *     the SAME 'not_found' reason as a genuinely-missing id — no cross-
 *     agent leak), invalid-enum rejection, unknown-product-id rejection,
 *     field_provenance is written/merged/capped correctly.
 *   - effectiveAvailability()/daysSinceAvailabilityUpdate()/
 *     isValidProductAvailability(): the pure auto-expiry rule in isolation.
 *   - Schema sanity: `products` really has the two new columns after
 *     __initSchemaForTesting (catches the exact "referenced a column that
 *     doesn't exist" class of bug called out in the task brief).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/product-availability-service.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runProductAvailabilityServiceTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";
import { __initSchemaForTesting } from "../database/init";
import {
  setProductAvailability,
  __setProductAvailabilityTestDb,
  type AvailabilityProvenanceRecord,
} from "./product-availability-service";
import {
  effectiveAvailability,
  daysSinceAvailabilityUpdate,
  isValidProductAvailability,
  AVAILABILITY_STALE_DAYS,
} from "../config/supply-graph";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runProductAvailabilityServiceTests(opts: { log?: boolean } = {}): TestSummary {
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
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  // Note: deliberately NOT calling __setDbForTesting() here — this suite
  // never needs the shared getDb() singleton. __initSchemaForTesting(db)
  // builds the schema directly on the injected handle, and
  // __setProductAvailabilityTestDb(db) pins the ONE service function under
  // test to it. This keeps the block "truly independent" (same idiom as
  // dental-claim-service.test.ts / profile-activity-service.test.ts — see
  // tests/test.ts's top-of-file comment) so it's safe to run synchronously
  // without any promise-chain serialization against the other suites.
  __initSchemaForTesting(db);
  __setProductAvailabilityTestDb(db);

  function insertAgent(id: string): void {
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'test producer', 'test', ?, 'https://example.no', 'producer', ?)
    `).run(id, `${id} Gård`, `${id}@example.no`, `key-${id}`);
  }

  function insertProduct(id: string, agentId: string, availability = "in_stock"): void {
    db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability)
      VALUES (?, ?, ?, ?, ?, 'kg', ?)
    `).run(id, agentId, `Produkt ${id}`, `produkt ${id}`, 50, availability);
  }

  // ── Schema sanity: catches "referenced a column that doesn't exist" ──────
  {
    const cols = (db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map(c => c.name);
    assertTrue(cols.includes("availability_updated_at"), "schema: products.availability_updated_at exists");
    assertTrue(cols.includes("field_provenance"), "schema: products.field_provenance exists");
  }

  insertAgent("ag-a");
  insertAgent("ag-b");
  insertProduct("prod-a1", "ag-a");
  insertProduct("prod-b1", "ag-b");

  // ── Happy path ────────────────────────────────────────────────────────────
  {
    const result = setProductAvailability({ agentId: "ag-a", productId: "prod-a1", availability: "sold_out" });
    assertTrue(result.ok, "happy path: setProductAvailability succeeds");
    if (result.ok) {
      assertEq(result.product.availability, "sold_out", "happy path: availability column updated");
      assertTrue(!!result.product.availability_updated_at, "happy path: availability_updated_at is stamped");

      const prov = JSON.parse(result.product.field_provenance) as { availability?: AvailabilityProvenanceRecord[] };
      assertTrue(Array.isArray(prov.availability), "happy path: field_provenance.availability is an array");
      assertEq(prov.availability?.length, 1, "happy path: exactly one provenance record after first write");
      assertEq(prov.availability?.[0]?.value, "sold_out", "happy path: provenance record value matches");
      assertEq(prov.availability?.[0]?.source_type, "owner", "happy path: provenance source_type defaults to 'owner'");
      assertTrue(!!prov.availability?.[0]?.fetched_at, "happy path: provenance record has fetched_at");
    }

    const row = db.prepare("SELECT availability FROM products WHERE id = 'prod-a1'").get() as { availability: string };
    assertEq(row.availability, "sold_out", "happy path: DB row reflects the update");
  }

  // ── Wrong-agent rejection: same 'not_found' as a genuinely missing id ────
  {
    const result = setProductAvailability({ agentId: "ag-b", productId: "prod-a1", availability: "in_stock" });
    assertTrue(!result.ok, "wrong-agent: rejected");
    if (!result.ok) assertEq(result.reason, "not_found", "wrong-agent: reason is 'not_found' (no cross-agent leak)");

    // Confirm the row was NOT mutated by the rejected wrong-agent attempt.
    const row = db.prepare("SELECT availability FROM products WHERE id = 'prod-a1'").get() as { availability: string };
    assertEq(row.availability, "sold_out", "wrong-agent: target row untouched by the rejected write");
  }

  // ── Invalid-enum rejection ────────────────────────────────────────────────
  {
    const result = setProductAvailability({ agentId: "ag-a", productId: "prod-a1", availability: "discontinued" });
    assertTrue(!result.ok, "invalid-enum: rejected");
    if (!result.ok) assertEq(result.reason, "invalid_availability", "invalid-enum: reason is 'invalid_availability'");
  }

  // ── Unknown-product-id rejection ─────────────────────────────────────────
  {
    const result = setProductAvailability({ agentId: "ag-a", productId: "does-not-exist", availability: "in_stock" });
    assertTrue(!result.ok, "unknown-id: rejected");
    if (!result.ok) assertEq(result.reason, "not_found", "unknown-id: reason is 'not_found'");
  }

  // ── field_provenance accumulates across multiple writes, capped ─────────
  {
    insertProduct("prod-a2", "ag-a");
    for (let i = 0; i < 25; i++) {
      const availability = i % 2 === 0 ? "in_stock" : "sold_out";
      setProductAvailability({ agentId: "ag-a", productId: "prod-a2", availability });
    }
    const row = db.prepare("SELECT field_provenance FROM products WHERE id = 'prod-a2'").get() as {
      field_provenance: string;
    };
    const prov = JSON.parse(row.field_provenance) as { availability: AvailabilityProvenanceRecord[] };
    assertTrue(prov.availability.length <= 20, "provenance cap: array never exceeds 20 records");
    assertEq(
      prov.availability[prov.availability.length - 1]?.value,
      "in_stock",
      "provenance cap: most recent write (25th, i=24, even -> in_stock) is preserved at the end",
    );
  }

  // ── Admin source_type is recorded distinctly from owner ──────────────────
  {
    insertProduct("prod-a3", "ag-a");
    const result = setProductAvailability({
      agentId: "ag-a",
      productId: "prod-a3",
      availability: "seasonal",
      sourceType: "admin",
    });
    if (result.ok) {
      const prov = JSON.parse(result.product.field_provenance) as { availability: AvailabilityProvenanceRecord[] };
      assertEq(prov.availability[0]?.source_type, "admin", "admin write: source_type is 'admin' not 'owner'");
    } else {
      assertTrue(false, "admin write: expected success");
    }
  }

  // ── mergeAvailabilityProvenance() malformed-JSON fallback (review round 1
  //    follow-up) — a corrupt/non-object `field_provenance` column (e.g.
  //    hand-edited data, a future format change, legacy garbage) must never
  //    THROW and block a write; it should fall back to a fresh `{}` instead.
  //    mergeAvailabilityProvenance() itself isn't exported, so this drives it
  //    indirectly through setProductAvailability(), the same way every other
  //    test in this file exercises it. ──────────────────────────────────────
  {
    insertProduct("prod-a4", "ag-a");
    // Not valid JSON at all.
    db.prepare("UPDATE products SET field_provenance = ? WHERE id = 'prod-a4'").run("{not valid json!!!");

    let threw: unknown = null;
    let result: ReturnType<typeof setProductAvailability> | null = null;
    try {
      result = setProductAvailability({ agentId: "ag-a", productId: "prod-a4", availability: "sold_out" });
    } catch (err) {
      threw = err;
    }
    assertTrue(threw === null, `malformed-JSON provenance: setProductAvailability does NOT throw (got: ${String(threw)})`);
    assertTrue(!!result && result.ok, "malformed-JSON provenance: write still succeeds");
    if (result && result.ok) {
      const prov = JSON.parse(result.product.field_provenance) as { availability?: AvailabilityProvenanceRecord[] };
      assertTrue(Array.isArray(prov.availability), "malformed-JSON provenance: falls back to {} then rebuilds a valid availability array");
      assertEq(prov.availability?.length, 1, "malformed-JSON provenance: exactly one record (prior garbage discarded, not merged)");
      assertEq(prov.availability?.[0]?.value, "sold_out", "malformed-JSON provenance: new record's value is correct");
    }

    // Also cover valid-JSON-but-wrong-shape (a JSON array, not an object) —
    // same fallback path, different branch of the `typeof === "object" &&
    // !Array.isArray()` guard.
    insertProduct("prod-a5", "ag-a");
    db.prepare("UPDATE products SET field_provenance = ? WHERE id = 'prod-a5'").run("[1,2,3]");
    let threw2: unknown = null;
    let result2: ReturnType<typeof setProductAvailability> | null = null;
    try {
      result2 = setProductAvailability({ agentId: "ag-a", productId: "prod-a5", availability: "seasonal" });
    } catch (err) {
      threw2 = err;
    }
    assertTrue(threw2 === null, `array-shaped provenance: setProductAvailability does NOT throw (got: ${String(threw2)})`);
    if (result2 && result2.ok) {
      const prov = JSON.parse(result2.product.field_provenance) as { availability?: AvailabilityProvenanceRecord[] };
      assertEq(prov.availability?.length, 1, "array-shaped provenance: falls back to {} then rebuilds a valid availability array");
    } else {
      assertTrue(false, "array-shaped provenance: expected success");
    }
  }

  // ── effectiveAvailability() — the pure auto-expiry rule ──────────────────
  {
    const NOW = new Date("2026-07-23T12:00:00Z");

    assertEq(effectiveAvailability("in_stock", null, NOW), "unknown", "effective: never-confirmed (NULL) -> unknown");
    assertEq(effectiveAvailability("in_stock", "", NOW), "unknown", "effective: empty-string timestamp -> unknown");

    const freshTs = new Date(NOW.getTime() - 1 * 86400000).toISOString(); // 1 day ago
    assertEq(effectiveAvailability("sold_out", freshTs, NOW), "sold_out", "effective: fresh (1 day) -> raw value");

    const justUnderStale = new Date(NOW.getTime() - (AVAILABILITY_STALE_DAYS - 1) * 86400000).toISOString();
    assertEq(
      effectiveAvailability("in_stock", justUnderStale, NOW),
      "in_stock",
      `effective: ${AVAILABILITY_STALE_DAYS - 1} days old -> still raw value`,
    );

    const exactlyStale = new Date(NOW.getTime() - AVAILABILITY_STALE_DAYS * 86400000).toISOString();
    assertEq(
      effectiveAvailability("in_stock", exactlyStale, NOW),
      "unknown",
      `effective: EXACTLY ${AVAILABILITY_STALE_DAYS} days old -> unknown (boundary is inclusive)`,
    );

    const wellStale = new Date(NOW.getTime() - (AVAILABILITY_STALE_DAYS + 5) * 86400000).toISOString();
    assertEq(
      effectiveAvailability("in_stock", wellStale, NOW),
      "unknown",
      `effective: well past ${AVAILABILITY_STALE_DAYS} days -> unknown`,
    );

    // SQLite datetime('now') form ("YYYY-MM-DD HH:MM:SS", no 'T'/'Z') must
    // parse identically to ISO — this is the exact string shape
    // setProductAvailability() actually writes.
    const sqliteForm = "2026-07-22 12:00:00"; // 1 day before NOW
    assertEq(effectiveAvailability("seasonal", sqliteForm, NOW), "seasonal", "effective: SQLite datetime() form parses correctly");

    assertEq(effectiveAvailability("not-a-real-value", freshTs, NOW), "unknown", "effective: garbage raw value -> unknown (defensive)");
  }

  // ── daysSinceAvailabilityUpdate() ─────────────────────────────────────────
  {
    const NOW = new Date("2026-07-23T12:00:00Z");
    assertEq(daysSinceAvailabilityUpdate(null, NOW), null, "daysSince: null -> null");
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * 86400000).toISOString();
    assertEq(daysSinceAvailabilityUpdate(fiveDaysAgo, NOW), 5, "daysSince: 5 days ago -> 5");
  }

  // ── isValidProductAvailability() ──────────────────────────────────────────
  {
    assertTrue(isValidProductAvailability("in_stock"), "isValid: in_stock accepted");
    assertTrue(isValidProductAvailability("seasonal"), "isValid: seasonal accepted");
    assertTrue(isValidProductAvailability("sold_out"), "isValid: sold_out accepted");
    assertTrue(!isValidProductAvailability("unknown"), "isValid: 'unknown' rejected (never a producer-settable value)");
    assertTrue(!isValidProductAvailability("discontinued"), "isValid: garbage rejected");
    assertTrue(!isValidProductAvailability(123), "isValid: non-string rejected");
    assertTrue(!isValidProductAvailability(null), "isValid: null rejected");
  }

  // Unpin — this is a MODULE-LEVEL variable in product-availability-service.ts
  // shared by the whole process (tests/test.ts requires every *.test.ts file
  // into ONE process). Leaving it pinned to this throwaway :memory: db would
  // silently hijack every LATER caller of setProductAvailability() in the
  // same process — including the real getDb()-backed integration suite in
  // supply-graph-availability.test.ts — into writing to (and 404ing against)
  // this already-discarded db instead. Same "reset test-DB pin in finally"
  // idiom as cart-service/trust-event-service (see pilot-ordre-loop.test.ts).
  __setProductAvailabilityTestDb(null);

  if (log) console.log(`  product-availability-service: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  const summary = runProductAvailabilityServiceTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
