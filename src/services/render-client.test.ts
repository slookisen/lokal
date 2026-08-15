/**
 * render-client.test.ts — unit tests for services/render-client.ts.
 *
 * Covers the `final_url` field added for render-page.ts's worker-backed
 * defaultRenderImpl (dev-request 2026-08-14-fetch-vegg-headless-fallback,
 * Slice 4): render-worker's /render response already returns the
 * post-redirect URL as `url` (render-worker/src/index.ts, res.json({...,
 * url: finalUrl, ...})) — this asserts render-client.ts actually threads it
 * through to callers as `final_url`, via a redirect fixture where the mocked
 * response's `url` differs from the requested url.
 *
 * Also covers the `user_agent` field added on top of that same slice
 * (CHANGES-REQUESTED fix-up, Finding 1): `opts` is spread directly into the
 * request body in render-client.ts, so this pins that a caller-supplied
 * `user_agent` actually reaches the request body under that exact key, and
 * that omitting it leaves the key absent from the body entirely (never sent
 * as `undefined` — the worker's own schema treats an absent key and an
 * omitted-optional key the same, but this still pins the observable shape).
 *
 * WORKER_KEY is read from `process.env.RENDER_WORKER_KEY` at MODULE LOAD
 * TIME (a top-level const in render-client.ts, not re-read per call), so
 * this file busts require's module cache and re-requires render-client.ts
 * fresh after setting the env var, rather than depending on whatever copy
 * (if any) another module already loaded.
 *
 * Stubs globalThis.fetch (repo convention — see
 * search-enrich-page-evidence.test.ts) and restores it, the prior
 * RENDER_WORKER_KEY value, and the require cache entry, all in `finally`.
 * No real network call, no real render-worker: `npm test` must never
 * require one (render-page.ts's own docblock states the same constraint for
 * the local-Chromium path; it holds identically here for the worker path).
 *
 * Standalone: npx tsx src/services/render-client.test.ts
 * Wired into the gate: tests/test.ts imports runRenderClientTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runRenderClientTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  const check = (cond: boolean, label: string) => {
    if (cond) {
      passed++;
      if (log) console.log(`    ok  ${label}`);
    } else {
      failed++;
      failures.push(label);
      if (log) console.log(`    FAIL ${label}`);
    }
  };

  const prevFetch = globalThis.fetch;
  const prevKey = process.env.RENDER_WORKER_KEY;
  const modPath = require.resolve("./render-client");

  try {
    // Force a fresh module instance so the fake key below is what
    // render-client.ts's top-level WORKER_KEY const actually captures.
    delete require.cache[modPath];
    process.env.RENDER_WORKER_KEY = "test-key-rc-1";
    const { renderPage: freshRenderPage } = require("./render-client") as typeof import("./render-client");

    // ── final_url reflects the worker's post-redirect url, not the request url ──
    const requestUrl = "https://example.no/gammel-side";
    const redirectedTo = "https://example.no/ny-side";
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          html: "<html><body>Ny side</body></html>",
          status_code: 200,
          duration_ms: 42,
          url: redirectedTo,
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const result = await freshRenderPage(requestUrl, { wait_for: "domcontentloaded" });
    check(capturedBody?.url === requestUrl, "rc-1: the request body carries the ORIGINAL url");
    check(result.final_url === redirectedTo, "rc-2: final_url reflects the worker's post-redirect url");
    check(
      result.final_url !== requestUrl,
      "rc-3: fixture sanity — redirectedTo genuinely differs from the request url",
    );
    check(result.html === "<html><body>Ny side</body></html>", "rc-4: html is threaded through unchanged");
    check(
      result.status_code === 200 && result.duration_ms === 42,
      "rc-5: status_code/duration_ms are unchanged by the final_url addition",
    );
    check(result.source === "render-worker", "rc-6: source is still the literal 'render-worker'");

    // ── final_url equals the request url on a non-redirected render ───────────
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          html: "<html><body>Same side</body></html>",
          status_code: 200,
          duration_ms: 10,
          url: requestUrl,
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const noRedirect = await freshRenderPage(requestUrl);
    check(
      noRedirect.final_url === requestUrl,
      "rc-7: final_url equals the request url when the worker reports no redirect",
    );

    // ── non-2xx response still throws `render-worker <status>: <body>` ────────
    // (render-page.ts's classifyRenderError keys its render_timeout/
    // render_navigation_failed buckets on this exact "render-worker NNN"
    // prefix — this pins the shape it depends on.)
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 504,
        text: async () => "navigation timeout",
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;
    let threw = false;
    let thrownMessage = "";
    try {
      await freshRenderPage(requestUrl);
    } catch (err: any) {
      threw = true;
      thrownMessage = String(err?.message || "");
    }
    check(threw, "rc-8: a non-2xx worker response throws rather than returning ok:false");
    check(
      /^render-worker 504: navigation timeout/.test(thrownMessage),
      "rc-9: the thrown message is 'render-worker <status>: <body>'",
    );

    // ── user_agent forwarded in the request body when supplied ────────────────
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          html: "<html><body>UA test</body></html>",
          status_code: 200,
          duration_ms: 5,
          url: requestUrl,
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const uaSupplied = "Lokal-RFB-Scraper/1.0 (+https://rettfrabonden.com)";
    await freshRenderPage(requestUrl, { wait_for: "domcontentloaded", user_agent: uaSupplied });
    check(
      capturedBody?.user_agent === uaSupplied,
      "rc-10: a caller-supplied user_agent is forwarded in the request body under 'user_agent'",
    );

    // ── user_agent omitted (undefined) when not supplied ───────────────────────
    capturedBody = null;
    await freshRenderPage(requestUrl, { wait_for: "domcontentloaded" });
    check(
      capturedBody !== null && !("user_agent" in capturedBody),
      "rc-11: no user_agent option -> the request body has no 'user_agent' key at all",
    );

    capturedBody = null;
    await freshRenderPage(requestUrl);
    check(
      capturedBody !== null && !("user_agent" in capturedBody),
      "rc-12: no opts at all -> the request body still has no 'user_agent' key",
    );
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.RENDER_WORKER_KEY;
    else process.env.RENDER_WORKER_KEY = prevKey;
    // Force the NEXT require() by anyone (this process is long-lived across
    // the whole test run) to re-evaluate render-client.ts's top-level
    // WORKER_KEY against the just-restored env, rather than leaving this
    // test's fake key cached for a later block or caller to pick up.
    delete require.cache[modPath];
  }

  return { passed, failed, failures };
}

// Standalone runner
if (process.argv[1] && process.argv[1].endsWith("render-client.test.ts")) {
  runRenderClientTests({ log: true }).then((r) => {
    console.log(`\nrender-client: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
