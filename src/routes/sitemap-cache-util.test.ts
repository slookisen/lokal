/**
 * sitemap-cache-util.test.ts — dev-request 2026-09-29-gsc-strukturerte-data-og-5xx, slice C.
 * Covers the shared per-vertical sitemap cache (dental/experiences) and the slow-log.
 * Exported runSitemapCacheUtilTests -> TestSummary; wired into tests/test.ts.
 */
export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runSitemapCacheUtilTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
  };
  const util = require("./sitemap-cache-util") as typeof import("./sitemap-cache-util");
  const dental = require("./dental-seo") as typeof import("./dental-seo");
  const exp = require("./experiences-seo") as typeof import("./experiences-seo");
  const prevTtl = process.env.SITEMAP_CACHE_TTL_MS;
  const origErr = console.error, origWarn = console.warn;
  const warns: string[] = [];
  try {
    console.error = () => {};
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    delete process.env.SITEMAP_CACHE_TTL_MS;
    eq(util.resolveSitemapCacheTtlMs(undefined), 30 * 60_000, "ttl default 30 min");
    eq(util.resolveSitemapCacheTtlMs("1"), 10 * 60_000, "ttl clamped low");
    eq(util.resolveSitemapCacheTtlMs("99999999"), 60 * 60_000, "ttl clamped high");

    // hit vs. miss within TTL, rebuild after TTL
    const c = util.createSitemapCache("t", () => "default");
    let builds = 0;
    const b = () => `v${++builds}`;
    eq(c.get(1000, b), "v1", "first call builds");
    eq(c.get(1000 + 60_000, b), "v1", "within TTL serves cache");
    eq(builds, 1, "within TTL no rebuild");
    eq(c.get(1000 + 30 * 60_000, b), "v2", "rebuild after TTL");
    c.reset();
    eq(c.get(1000 + 30 * 60_000 + 1, b), "v3", "reset forces rebuild");

    // failed rebuild: keep previous valid; none -> throw; failure not cached
    const f = util.createSitemapCache("t", () => "x");
    let threw = false;
    try { f.get(0, () => { throw new Error("boom"); }); } catch { threw = true; }
    eq(threw, true, "failed first build propagates");
    eq(f.get(1, () => "ok"), "ok", "failure did not poison cache");
    eq(f.get(1 + 31 * 60_000, () => { throw new Error("boom"); }), "ok", "failed rebuild serves previous valid");
    eq(f.get(1 + 31 * 60_000 + 5, () => "new"), "new", "failed rebuild did not refresh builtAt; retried next call");

    // per-vertical isolation (module-level caches)
    dental.__resetDentalSitemapCacheForTesting();
    exp.__resetExperiencesSitemapCacheForTesting();
    eq(dental.getDentalSitemapXml(0, () => "D1"), "D1", "dental builds");
    eq(exp.getExperiencesSitemapXml(0, () => "E1"), "E1", "experiences builds independently");
    eq(dental.getDentalSitemapXml(10, () => "D2"), "D1", "dental cached");
    eq(exp.getExperiencesSitemapXml(10, () => "E2"), "E1", "experiences cached");
    dental.__resetDentalSitemapCacheForTesting();
    eq(dental.getDentalSitemapXml(20, () => "D3"), "D3", "dental reset rebuilds");
    eq(exp.getExperiencesSitemapXml(20, () => "E3"), "E1", "dental reset leaves experiences cache");

    // slow log
    warns.length = 0;
    util.logSlowSitemap("dental", 0, 3000);
    eq(warns.length, 0, "3000 ms not logged");
    util.logSlowSitemap("dental", 0, 3001);
    eq(warns, ["[sitemap-slow] dental 3001ms"], "slow logged as one line, vertical + ms");
  } catch (err) {
    failed++;
    failures.push(`sitemap-cache-util: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.error = origErr; console.warn = origWarn;
    if (prevTtl === undefined) delete process.env.SITEMAP_CACHE_TTL_MS; else process.env.SITEMAP_CACHE_TTL_MS = prevTtl;
    try { dental.__resetDentalSitemapCacheForTesting(); exp.__resetExperiencesSitemapCacheForTesting(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runSitemapCacheUtilTests({ log: true }).then((r) => {
    console.log(`\nsitemap-cache-util: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
