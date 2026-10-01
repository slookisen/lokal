/**
 * marketplace-registry-slug-lookup.test.ts — dev-request
 * 2026-09-26-rfb-produsentside-synkron-slug-skann.
 *
 * getAgentBySlugIncludingUmbrellas used to scan + slugify every active agent
 * per request (event-loop stalls under crawling). It now uses a slug→id map
 * plus a single-row read. This suite guards that the answers are IDENTICAL to
 * the old algorithm (parity vs. an inline reference), that direct-SQL writes
 * that bypass invalidateCache() are still seen, and that per-lookup cost is low.
 *
 * Exported runMarketplaceRegistrySlugLookupTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/services/marketplace-registry-slug-lookup.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runMarketplaceRegistrySlugLookupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); }
  }

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
  const { slugify } = require("../utils/slug") as typeof import("../utils/slug");

  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function seed(id: string, name: string, extra: { active?: number; umbrella?: string | null; desc?: string } = {}): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at, umbrella_type
      ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
        '[]', '[]', '[]', '{}', '["no"]',
        0.5, ?, 0, 0, 0, 0, datetime('now'), datetime('now'), ?)`,
    ).run(id, name, extra.desc ?? "Beskrivelse", name, `${id}@example.no`, `https://${id}.example.no`,
      `key-${id}`, extra.active ?? 1, extra.umbrella ?? null);
  }
  // The pre-change algorithm, verbatim, as the parity reference.
  function reference(slug: string): string | undefined {
    const rows = testDb.prepare("SELECT * FROM agents WHERE is_active = 1").all() as any[];
    return rows.find((r) => slugify(r.name).toLowerCase() === slug.toLowerCase())?.id;
  }
  const lookup = (slug: string) => marketplaceRegistry.getAgentBySlugIncludingUmbrellas(slug)?.id;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const big = "x".repeat(4000);
    for (let i = 0; i < 3000; i++) seed(`bulk-${i}`, `Bulk Gård ${i}`, { desc: big });
    seed("a-1", "Åsgård Ysteri");
    seed("a-2", "Åsgård  Ysteri!"); // duplicate slug — first scan-order match must win
    // Duplicate slug where rowid order and lat/lng (old scan) order DISAGREE:
    // old query scans idx_agents_geo, so the lower-lat row wins, not the lower rowid.
    seed("geo-1", "Geo Dublett"); seed("geo-2", "Geo Dublett");
    testDb.prepare("UPDATE agents SET lat = 63.4, lng = 10.4 WHERE id = 'geo-1'").run();
    testDb.prepare("UPDATE agents SET lat = 59.9, lng = 10.7 WHERE id = 'geo-2'").run();
    seed("umb-1", "Testlokallag", { umbrella: "lokallag" });
    seed("off-1", "Skjult Gård", { active: 0 });

    // ── parity vs. old algorithm ───────────────────────────────────────
    for (const slug of ["asgard-ysteri", "ASGARD-YSTERI", "testlokallag", "skjult-gard", "bulk-gard-0", "bulk-gard-2999", "finnes-ikke", "geo-dublett"]) {
      assertEq(lookup(slug), reference(slug), `parity: ${slug}`);
    }
    assertEq(lookup("asgard-ysteri"), "a-1", "duplicate slug: first scan-order match wins");
    assertEq(lookup("skjult-gard"), undefined, "inactive agent is not found");

    // ── direct-SQL writes that bypass invalidateCache() ────────────────
    testDb.prepare("UPDATE agents SET is_active = 0 WHERE id = 'a-1'").run();
    assertEq(lookup("asgard-ysteri"), reference("asgard-ysteri"), "direct-SQL deactivate: duplicate falls through to next holder");
    testDb.prepare("UPDATE agents SET is_active = 0 WHERE id = 'bulk-5'").run();
    assertEq(lookup("bulk-gard-5"), undefined, "direct-SQL deactivate: no longer found");
    seed("new-1", "Helt Ny Gård");
    assertEq(lookup("helt-ny-gard"), "new-1", "direct-SQL insert: found immediately");
    testDb.prepare("UPDATE agents SET name = 'Omdøpt Gård' WHERE id = 'bulk-7'").run();
    assertEq(lookup("bulk-gard-7"), undefined, "direct-SQL rename: old slug gone");
    // New slug after a direct rename is visible once the throttled miss-rebuild window opens.
    (marketplaceRegistry as any)._slugIdMapBuiltAt -= 5_000;
    assertEq(lookup("omdopt-gard"), "bulk-7", "direct-SQL rename: new slug found after miss-rebuild window");
    // Registry write path invalidates immediately.
    marketplaceRegistry.updateAgent("bulk-8", { name: "Registrert Omdøpt" });
    assertEq(lookup("registrert-omdopt"), "bulk-8", "updateAgent rename: new slug found immediately");

    // ── DB swap (test harness / failover) must not serve a stale map ───
    const otherDb = new Database(":memory:");
    otherDb.pragma("foreign_keys = OFF");
    __setDbForTesting(otherDb as any);
    __initSchemaForTesting(otherDb as any);
    assertEq(lookup("helt-ny-gard"), undefined, "different DB handle: map is rebuilt, not reused");
    __setDbForTesting(testDb as any);
    otherDb.close();

    // ── cost: AC1 asks < 100 ms per lookup on a prod-like DB ───────────
    lookup("bulk-gard-100"); // warm
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) lookup(`bulk-gard-${i * 10}`);
    const perMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
    if (log) console.log(`  per-lookup ${perMs.toFixed(3)} ms`);
    assertTrue(perMs < 20, `per-lookup main-thread cost ${perMs.toFixed(2)} ms < 20 ms (AC1 bound 100 ms)`);
    const missT0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) lookup(`finnes-ikke-${i}`);
    const missMs = Number(process.hrtime.bigint() - missT0) / 1e6 / 200;
    assertTrue(missMs < 20, `per-lookup MISS cost ${missMs.toFixed(2)} ms < 20 ms (crawler of unknown slugs)`);
  } catch (err) {
    failed++;
    failures.push(`slug-lookup: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
    (marketplaceRegistry as any)._slugIdMap = null;
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runMarketplaceRegistrySlugLookupTests({ log: true }).then((r) => {
    console.log(`\nslug-lookup: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
