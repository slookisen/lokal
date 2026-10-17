/**
 * indexnow-submit.test.ts — dev-request 2026-10-16-indexnow-alle-verter, slice S1.
 * Covers submitIndexNow (batching, host/keyLocation, status classification, foreign-host filter),
 * the host register and SitemapCache.peek(). No network: fetchImpl is always injected.
 * Exported runIndexNowSubmitTests -> TestSummary; wired into tests/test.ts.
 */
export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runIndexNowSubmitTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const eq = (a: unknown, b: unknown, label: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
  };
  const svc = require("./indexnow-service") as typeof import("./indexnow-service");
  const util = require("../routes/sitemap-cache-util") as typeof import("../routes/sitemap-cache-util");
  const prevDental = process.env.ENABLE_DENTAL, prevExp = process.env.ENABLE_EXPERIENCES;
  const origWarn = console.warn;

  type Call = { url: string; body: any };
  const makeFetch = (status: number | ((i: number) => number), calls: Call[]) =>
    (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const s = typeof status === "function" ? status(calls.length - 1) : status;
      return { status: s, ok: s >= 200 && s < 300 } as Response;
    }) as unknown as typeof fetch;
  const mk = (base: string, prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${base}${prefix}${i}`);

  try {
    console.warn = () => {};

    // 2500 URLs -> 3 POSTs (1000/1000/500), right host + keyLocation
    const calls: Call[] = [];
    const r = await svc.submitIndexNow("rettfrabonden.com", mk("https://rettfrabonden.com", "/produsent/p", 2500), { fetchImpl: makeFetch(200, calls) });
    eq(calls.length, 3, "2500 urls -> 3 POSTs");
    eq(calls.map((c) => c.body.urlList.length), [1000, 1000, 500], "chunk sizes");
    eq(calls[0].url, "https://api.indexnow.org/indexnow", "endpoint");
    eq(calls[0].body.host, "rettfrabonden.com", "rfb host");
    eq(calls[0].body.keyLocation, `https://rettfrabonden.com/${svc.INDEXNOW_KEY}.txt`, "rfb keyLocation");
    eq(calls[0].body.key, svc.INDEXNOW_KEY, "key in body");
    eq(r.sent, 2500, "sent count");
    eq(r.chunks.map((c) => c.result), ["ok", "ok", "ok"], "all chunks ok");

    // per vertical host/keyLocation
    for (const [host, path] of [["finn-tannlege.com", "/klinikk/x"], ["opplevagent.no", "/opplevelse/y"]]) {
      const c: Call[] = [];
      await svc.submitIndexNow(host, [`https://${host}${path}`], { fetchImpl: makeFetch(202, c) });
      eq([c[0].body.host, c[0].body.keyLocation], [host, `https://${host}/${svc.INDEXNOW_KEY}.txt`], `host/keyLocation ${host}`);
    }

    // chunkSize option
    const c2: Call[] = [];
    await svc.submitIndexNow("opplevagent.no", mk("https://opplevagent.no", "/opplevelse/", 5), { fetchImpl: makeFetch(200, c2), chunkSize: 2 });
    eq(c2.length, 3, "custom chunkSize");

    // status classification
    for (const [st, cls] of [[200, "ok"], [202, "ok"], [400, "bad_request"], [403, "key_invalid"], [422, "host_mismatch"], [429, "rate_limited"], [500, "http_error"]] as const) {
      const rr = await svc.submitIndexNow("finn-tannlege.com", ["https://finn-tannlege.com/klinikk/a"], { fetchImpl: makeFetch(st, []) });
      eq(rr.chunks[0].result, cls, `status ${st} -> ${cls}`);
      eq(rr.sent, cls === "ok" ? 1 : 0, `sent for ${st}`);
    }

    // network error / timeout never throws
    const rn = await svc.submitIndexNow("finn-tannlege.com", ["https://finn-tannlege.com/klinikk/a"], {
      fetchImpl: (async () => { throw new Error("boom"); }) as unknown as typeof fetch,
    });
    eq(rn.chunks[0].result, "network_error", "fetch throw -> network_error");

    // foreign host filtered before POST
    const c3: Call[] = [];
    const rf = await svc.submitIndexNow("finn-tannlege.com", [
      "https://finn-tannlege.com/klinikk/a", "https://rettfrabonden.com/produsent/x", "https://finn-tannlege.com.evil.no/klinikk/b",
    ], { fetchImpl: makeFetch(200, c3) });
    eq(rf.dropped_foreign, 2, "dropped_foreign counted");
    eq(c3[0].body.urlList, ["https://finn-tannlege.com/klinikk/a"], "only own urls POSTed");
    const c4: Call[] = [];
    const ra = await svc.submitIndexNow("finn-tannlege.com", ["https://opplevagent.no/opplevelse/z"], { fetchImpl: makeFetch(200, c4) });
    eq([c4.length, ra.dropped_foreign, ra.sent], [0, 1, 0], "all foreign -> no POST");

    // host register
    const hosts = require("./indexnow-hosts") as typeof import("./indexnow-hosts");
    eq(hosts.INDEXNOW_HOSTS.map((h) => [h.vertical, h.host, h.baseUrl]), [
      ["rfb", "rettfrabonden.com", "https://rettfrabonden.com"],
      ["dental", "finn-tannlege.com", "https://finn-tannlege.com"],
      ["experiences", "opplevagent.no", "https://opplevagent.no"],
    ], "register hosts");
    eq(hosts.INDEXNOW_HOSTS.map((h) => h.entityPathPrefixes), [
      ["/produsent/", "/en/produsent/"], ["/klinikk/"], ["/opplevelse/", "/tilbyder/", "/kategori/gardssalg/produsent/"],
    ], "register prefixes");
    eq(hosts.INDEXNOW_HOSTS[0].peekSitemapXml, null, "rfb peekSitemapXml null");

    const loaded = (name: string) => Object.keys(require.cache).some((k) => k.includes(name));
    const dentalLoadedBefore = loaded("dental-seo");
    delete process.env.ENABLE_DENTAL;
    delete process.env.ENABLE_EXPERIENCES;
    eq(hosts.INDEXNOW_HOSTS.filter((h) => h.enabled()).map((h) => h.vertical), ["rfb"], "dental/experiences off -> only rfb");
    eq(loaded("dental-seo"), dentalLoadedBefore, "dental-seo not loaded by register");
    process.env.ENABLE_DENTAL = "1";
    process.env.ENABLE_EXPERIENCES = "1";
    eq(hosts.INDEXNOW_HOSTS.filter((h) => h.enabled()).map((h) => h.vertical), ["rfb", "dental", "experiences"], "flags on -> all three");

    // peek(): null on empty cache, {xml, builtAt} after get(), null after reset(); register lookup
    const cache = util.createSitemapCache("indexnow-peek-test", () => "<urlset/>");
    eq(cache.peek(), null, "peek empty cache -> null");
    cache.get(1234);
    eq(cache.peek(), { xml: "<urlset/>", builtAt: 1234 }, "peek after get -> {xml, builtAt}");
    eq(util.getRegisteredSitemapCache("indexnow-peek-test") === cache, true, "registered cache found");
    cache.reset();
    eq(cache.peek(), null, "peek after reset -> null");
    eq(util.getRegisteredSitemapCache("no-such-vertical"), null, "unknown vertical -> null");
  } catch (err: any) {
    failed++;
    failures.push("indexnow-submit: unexpected error: " + String(err?.stack || err));
  } finally {
    console.warn = origWarn;
    if (prevDental === undefined) delete process.env.ENABLE_DENTAL; else process.env.ENABLE_DENTAL = prevDental;
    if (prevExp === undefined) delete process.env.ENABLE_EXPERIENCES; else process.env.ENABLE_EXPERIENCES = prevExp;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runIndexNowSubmitTests({ log: true }).then((s) => {
    console.log(`indexnow-submit: ${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed ? 1 : 0);
  });
}
