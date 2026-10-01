/**
 * seo-sitemap-cache.test.ts — dev-request 2026-10-01-prod-sitemap-cache.
 *
 * GET /sitemap.xml used to build ~2.4 MB of XML synchronously on every request.
 * It now serves an in-memory copy for SITEMAP_CACHE_TTL_MS (default 30 min,
 * clamped 10–60 min). This suite guards: (1) first call builds, second serves
 * the cache, (2) rebuild after TTL expiry, (3) a failing rebuild serves the
 * previous version, (4) the refactored build is byte-equal to the pre-change
 * handler output (golden: tests/fixtures/sitemap-golden.xml, <lastmod> of
 * "today" stored as {TODAY}).
 *
 * Exported runSeoSitemapCacheTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/seo-sitemap-cache.test.ts
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function seedSitemapFixture(db: Database.Database): void {
  const ins = db.prepare(
    `INSERT INTO agents (
      id, name, description, provider, contact_email, url, role, api_key,
      categories, tags, skills, capabilities, languages, city,
      trust_score, is_active, is_verified, discovery_count, interaction_count,
      total_interactions, created_at, last_seen_at
    ) VALUES (?, ?, 'Beskrivelse', ?, ?, ?, 'producer', ?,
      '[]', '[]', '[]', '{}', '["no"]', ?,
      0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
  );
  const add = (id: string, name: string, city: string) =>
    ins.run(id, name, name, `${id}@example.no`, `https://${id}.example.no`, `key-${id}`, city);
  add("sm-1", "Åsgård Ysteri", "Ålesund");
  add("sm-2", "Bjørkelund Gård", "Ålesund");
  add("sm-3", "Solbakken", "Trondheim");
  add("sm-4", "Uten Kunnskap", "Bergen"); // no knowledge row, no claim -> WO-17 gate skips it
  const knowledge = db.prepare(
    "INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status) VALUES (?, ?, ?, ?)",
  );
  knowledge.run("sm-1", "2026-03-04 10:00:00", "2026-01-01 00:00:00", "enriched");
  knowledge.run("sm-2", "2026-05-20T08:30:00.000Z", "2026-01-01 00:00:00", "thin");
  knowledge.run("sm-3", null, "2026-02-14 12:00:00", "pending");
}

export async function runSeoSitemapCacheTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const seo = require("./seo") as typeof import("./seo");
  const { marketplaceRegistry } = require("../services/marketplace-registry") as
    typeof import("../services/marketplace-registry");

  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const prevTtl = process.env.SITEMAP_CACHE_TTL_MS;
  const origConsoleError = console.error;
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  function invoke(): { status: number; body: string; headers: Record<string, string> } {
    const layer = ((seo.default as any).stack as any[]).find(
      (l: any) => l.route && l.route.path === "/sitemap.xml" && l.route.methods?.get,
    );
    const out = { status: 200, body: "", headers: {} as Record<string, string> };
    const res: any = {
      status(code: number) { out.status = code; return this; },
      send(b: unknown) { out.body = typeof b === "string" ? b : String(b); return this; },
      header(k: string, v: string) { out.headers[k.toLowerCase()] = v; return this; },
      setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; return this; },
    };
    layer.route.stack[layer.route.stack.length - 1].handle({ headers: {}, query: {}, params: {} }, res, () => {});
    return out;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    seedSitemapFixture(testDb);
    (marketplaceRegistry as any).invalidateCache();
    delete process.env.SITEMAP_CACHE_TTL_MS;

    // ── TTL clamp ──────────────────────────────────────────────────────
    const MIN = 10 * 60_000, DEF = 30 * 60_000, MAX = 60 * 60_000;
    assertEq(seo.resolveSitemapCacheTtlMs(undefined), DEF, "ttl: default 30 min");
    assertEq(seo.resolveSitemapCacheTtlMs("garbage"), DEF, "ttl: unparsable -> default");
    assertEq(seo.resolveSitemapCacheTtlMs("1000"), MIN, "ttl: clamped up to 10 min");
    assertEq(seo.resolveSitemapCacheTtlMs("999999999"), MAX, "ttl: clamped down to 60 min");
    assertEq(seo.resolveSitemapCacheTtlMs("900000"), 900_000, "ttl: in-range value kept");

    // ── (4) byte-equal to the pre-change handler output ────────────────
    const today = new Date().toISOString().split("T")[0];
    const golden = readFileSync(join(__dirname, "..", "..", "tests", "fixtures", "sitemap-golden.xml"), "utf8")
      .split("{TODAY}").join(today);
    seo.__resetSitemapCacheForTesting();
    const built = seo.buildSitemapXml();
    assertTrue(built === golden, "refactor: buildSitemapXml() is byte-equal to the pre-change output");
    assertTrue(built.includes("/produsent/asgard-ysteri") && !built.includes("uten-kunnskap"),
      "fixture sanity: producer present, WO-17-gated producer absent");

    // ── (1) first call builds, second serves cache ─────────────────────
    seo.__resetSitemapCacheForTesting();
    let builds = 0;
    const counting = () => { builds++; return seo.buildSitemapXml(); };
    let now = 1_000_000;
    const first = seo.getSitemapXml(now, counting);
    const second = seo.getSitemapXml(now + 60_000, counting);
    assertEq(builds, 1, "cache: build called once for two calls");
    assertTrue(first === second && first === golden, "cache: second call serves identical bytes");

    // ── (2) after TTL expiry it rebuilds ───────────────────────────────
    seo.getSitemapXml(now + DEF - 1, counting);
    assertEq(builds, 1, "cache: still cached just before TTL");
    seo.getSitemapXml(now + DEF, counting);
    assertEq(builds, 2, "cache: rebuilt at TTL expiry");
    seo.getSitemapXml(now + DEF + 1000, counting);
    assertEq(builds, 2, "cache: fresh again after rebuild");

    // ── (3) build error -> previous version served ─────────────────────
    console.error = () => {};
    const t3 = now + 10 * DEF;
    const fresh = seo.getSitemapXml(t3, () => "<urlset>v1</urlset>");
    const stale = seo.getSitemapXml(t3 + DEF + 1, () => { throw new Error("boom"); });
    assertEq(fresh, "<urlset>v1</urlset>", "error path: setup build served");
    assertEq(stale, "<urlset>v1</urlset>", "error path: previous valid version served when rebuild throws");
    seo.__resetSitemapCacheForTesting();
    let threw = false;
    try { seo.getSitemapXml(t3, () => { throw new Error("boom"); }); } catch { threw = true; }
    assertTrue(threw, "error path: no previous version -> error propagates (handler answers 500 as before)");
    console.error = origConsoleError;

    // ── handler: header + cache wiring ─────────────────────────────────
    seo.__resetSitemapCacheForTesting();
    const r1 = invoke();
    const r2 = invoke();
    assertEq(r1.status, 200, "handler: 200");
    assertTrue(r1.body === golden && r2.body === golden, "handler: body byte-equal on first and cached call");
    assertEq(r1.headers["content-type"], "application/xml", "handler: Content-Type unchanged");
    assertEq(r1.headers["cache-control"], "public, max-age=1800", "handler: Cache-Control public, max-age=<ttl s>");
    process.env.SITEMAP_CACHE_TTL_MS = "600000";
    assertEq(invoke().headers["cache-control"], "public, max-age=600", "handler: Cache-Control follows env TTL");
  } catch (err) {
    failed++;
    failures.push(`sitemap-cache: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.error = origConsoleError;
    if (prevTtl === undefined) delete process.env.SITEMAP_CACHE_TTL_MS; else process.env.SITEMAP_CACHE_TTL_MS = prevTtl;
    try { require("./seo").__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    if (prevDb) __setDbForTesting(prevDb);
    (marketplaceRegistry as any).invalidateCache();
    testDb.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSeoSitemapCacheTests({ log: true }).then((r) => {
    console.log(`\nsitemap-cache: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
