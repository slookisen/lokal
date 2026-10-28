/**
 * seo-sitemap-rollesperre.test.ts — dev-request
 * 2026-10-06-rfb-sitemap-rollesperre-bm-event-og-paraply-canonical (skive A).
 *
 * (a) invariant: every /produsent/<slug> URL in the sitemap answers 200 on the
 *     real route handler (non-producer roles never listed), (b) BM event times
 *     (Oslo local labelled +00:00) get the right +02:00/+01:00 offset, other
 *     values untouched, (c) the two 404 umbrella slugs are not in the sitemap.
 *
 * Exported runSeoSitemapRollesperreTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/seo-sitemap-rollesperre.test.ts
 */

import Database from "better-sqlite3";
import { normalizeBmEventTime } from "../utils/bm-event-time";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runSeoSitemapRollesperreTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`); }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); }
  }

  // ── (b) BM time conversion (pure) ──────────────────────────────────────
  assertEq(normalizeBmEventTime("2026-07-15T10:00:00+00:00"), "2026-07-15T10:00:00+02:00", "bm: summer -> +02:00");
  assertEq(normalizeBmEventTime("2026-01-15T10:00:00+00:00"), "2026-01-15T10:00:00+01:00", "bm: winter -> +01:00");
  assertEq(normalizeBmEventTime("2026-05-16T08:00:00Z"), "2026-05-16T08:00:00+02:00", "bm: Z label -> +02:00");
  assertEq(normalizeBmEventTime("2026-03-28T10:00:00+00:00"), "2026-03-28T10:00:00+01:00", "bm: day before DST start -> +01:00");
  assertEq(normalizeBmEventTime("2026-03-29T10:00:00+00:00"), "2026-03-29T10:00:00+02:00", "bm: DST start day (29 Mar 2026) midday -> +02:00");
  assertEq(normalizeBmEventTime("2026-10-24T10:00:00+00:00"), "2026-10-24T10:00:00+02:00", "bm: day before DST end -> +02:00");
  assertEq(normalizeBmEventTime("2026-10-25T10:00:00+00:00"), "2026-10-25T10:00:00+01:00", "bm: DST end day (25 Oct 2026) midday -> +01:00");
  assertEq(normalizeBmEventTime("2026-07-15T10:00:00+02:00"), "2026-07-15T10:00:00+02:00", "bm: +02:00 unchanged");
  assertEq(normalizeBmEventTime("2026-07-15T10:00:00+01:00"), "2026-07-15T10:00:00+01:00", "bm: +01:00 unchanged");
  assertEq(normalizeBmEventTime("2026-07-15T10:00:00-05:00"), "2026-07-15T10:00:00-05:00", "bm: other offset unchanged");
  assertEq(normalizeBmEventTime("2026-07-15"), "2026-07-15", "bm: date-only unchanged");
  assertEq(normalizeBmEventTime("2026-07-15T10:00:00"), "2026-07-15T10:00:00", "bm: no offset unchanged");
  assertEq(normalizeBmEventTime(null), null, "bm: null passes through");
  assertEq(normalizeBmEventTime(""), "", "bm: empty passes through");

  const { buildBmEventJsonLd } = require("./seo") as typeof import("./seo");
  const ev = buildBmEventJsonLd(
    { event_name: "Torgdag", start_at: "2026-07-15T10:00:00+00:00", end_at: "2026-07-15T15:00:00+00:00", venue_name: "Torget" },
    null, "https://rettfrabonden.com",
  );
  assertEq([ev.startDate, ev.endDate], ["2026-07-15T10:00:00+02:00", "2026-07-15T15:00:00+02:00"], "bm: JSON-LD start/end corrected");

  // ── (a)+(c) sitemap invariant against the real /produsent/:slug route ──
  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const seo = require("./seo") as typeof import("./seo");
  const { marketplaceRegistry } = require("../services/marketplace-registry") as
    typeof import("../services/marketplace-registry");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const ins = testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        categories, tags, skills, capabilities, languages, city,
        trust_score, is_active, is_verified, discovery_count, interaction_count,
        total_interactions, created_at, last_seen_at
      ) VALUES (?, ?, 'Beskrivelse', ?, ?, ?, ?, ?, '[]', '[]', '[]', '{}', '["no"]', 'Oslo',
        0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
    );
    const know = testDb.prepare("INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status) VALUES (?, datetime('now'), datetime('now'), 'enriched')");
    const add = (id: string, name: string, role: string) => {
      ins.run(id, name, name, `${id}@example.no`, `https://${id}.example.no`, role, `key-${id}`);
      know.run(id);
    };
    add("rg-p1", "Ekte Gard En", "producer");
    add("rg-p2", "Ekte Gard To", "producer");
    add("rg-l1", "Logistikk Konto", "logistics");
    add("rg-c1", "Forbruker Konto", "consumer");
    add("rg-q1", "Kvalitet Konto", "quality");
    add("rg-i1", "Prisintel Konto", "price-intel");
    add("rg-u1", "Hanen Bygdeturisme Gardsmat", "producer");
    add("rg-u2", "Debio Sertifisering", "producer");
    // Skive B: a non-empty umbrella (one active member) is in the sitemap
    // now, so the invariant below covers umbrella pages too.
    add("rg-m1", "Rollesperre Marked", "quality");
    testDb.prepare("UPDATE agents SET umbrella_type = 'market_network' WHERE id = ?").run("rg-m1");
    testDb.prepare("INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source) VALUES (?, ?, 'active', 'admin')").run("rg-p1", "rg-m1");
    (marketplaceRegistry as any).invalidateCache();
    seo.__resetSitemapCacheForTesting();

    console.log = () => {};
    const xml = seo.buildSitemapXml();
    console.log = origLog;
    const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]!);
    const prodLocs = locs.filter((l) => /\/produsent\//.test(l));
    assertTrue(prodLocs.length >= 4, "sitemap: real producers are listed (NO + EN)");

    const layer = ((seo.default as any).stack as any[]).find(
      (l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get,
    );
    assertTrue(!!layer, "setup: GET /produsent/:slug layer is registered");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    function status(slug: string): number {
      let st = 200;
      const res: any = { status: (c: number) => { st = c; return res; }, send: () => res, redirect: () => { st = 301; return res; } };
      console.log = () => {};
      try { handler({ params: { slug }, lang: "no", ip: "127.0.0.1" }, res); } finally { console.log = origLog; }
      return st;
    }
    let allOk = true;
    for (const l of prodLocs) {
      const slug = l.split("/produsent/")[1]!;
      if (status(slug) !== 200) { allOk = false; failures.push(`✗ invariant: ${l} does not answer 200`); }
    }
    if (allOk) passed++; else failed++;

    for (const s of ["logistikk-konto", "forbruker-konto", "kvalitet-konto", "prisintel-konto"]) {
      assertEq(status(s), 404, `precondition: /produsent/${s} is 404`);
      assertTrue(!locs.some((l) => l.endsWith(`/produsent/${s}`)), `sitemap: non-producer ${s} excluded`);
    }
    assertTrue(locs.some((l) => l.endsWith("/produsent/ekte-gard-en")), "sitemap: producer ekte-gard-en present");
    assertTrue(locs.some((l) => l.endsWith("/produsent/rollesperre-marked")), "sitemap: non-empty umbrella present (invariant covers it)");

    // ── (c) the two 404 umbrella slugs ───────────────────────────────────
    for (const s of ["hanen-bygdeturisme-gardsmat", "debio-sertifisering"]) {
      assertTrue(!locs.some((l) => l.endsWith(`/produsent/${s}`)), `sitemap: ${s} (NO) excluded`);
      assertTrue(!locs.some((l) => l.endsWith(`/en/produsent/${s}`)), `sitemap: ${s} (EN) excluded`);
    }
  } catch (err) {
    failed++;
    failures.push(`sitemap-rollesperre: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = origLog;
    try { seo.__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    if (prevDb) __setDbForTesting(prevDb);
    (marketplaceRegistry as any).invalidateCache();
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSeoSitemapRollesperreTests({ log: true }).then((r) => {
    console.log(`\nsitemap-rollesperre: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
