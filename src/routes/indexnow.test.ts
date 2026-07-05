/**
 * indexnow.test.ts — tests for the IndexNow key file route added to the
 * RFB SEO router (src/routes/seo.ts) as part of dev-request
 * 2026-07-04-sokemotor-indeksering-og-lenker slice 1: "IndexNow key +
 * <key>.txt on all three hosts + ping on new/changed pages".
 *
 * Mirrors admin-db-table-sizes.test.ts's shape (exported run function +
 * standalone runner), but this route touches no DB and has no state to
 * reset, so — unlike that file — there's no getDb() singleton swap here.
 * The router is exercised directly (no HTTP server / supertest — this
 * repo's convention): build a minimal req/res pair and call
 * `router.handle(req, res, next)`.
 *
 * Covers:
 *   (a) GET /<INDEXNOW_KEY>.txt on the RFB seo router -> 200,
 *       Content-Type text/plain, body exactly equal to the key.
 *   (b) GET /<some-other-random>.txt -> not matched/handled by this route
 *       (falls through, same as before the route existed — no regression;
 *       the router's final catch-all "/:city" route explicitly skips any
 *       dotted slug via citySlug.includes("."), so it never renders a
 *       city page for an arbitrary .txt path either).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  handled: boolean; // true if res.send()/res.json() was called
  status: number;
  headers: Record<string, string>;
  body: any;
}

function callRoute(router: any, url: string): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: {},
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      header(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      send(body: any) {
        resolve({ handled: true, status: statusCode, headers, body });
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, headers, body });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      // No layer matched (or explicitly called next() with no error) ->
      // this request was NOT handled by the router.
      resolve({ handled: false, status: statusCode, headers, body: err ? String(err) : undefined });
    });
  });
}

export function runIndexNowTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    // Fresh require so this test doesn't depend on module state left by
    // any earlier block in the suite.
    delete require.cache[require.resolve("./seo")];
    delete require.cache[require.resolve("../services/indexnow-service")];
    const seoMod = require("./seo");
    const router = seoMod.default;
    const { INDEXNOW_KEY } = require("../services/indexnow-service") as
      typeof import("../services/indexnow-service");

    assertTrue(
      typeof INDEXNOW_KEY === "string" && /^[a-f0-9]{32}$/.test(INDEXNOW_KEY),
      "INDEXNOW_KEY is a 32-char lowercase-hex string",
    );

    // ── (a) GET /<INDEXNOW_KEY>.txt -> 200, text/plain, body === key ──
    const keyFile = await callRoute(router, `/${INDEXNOW_KEY}.txt`);
    assertTrue(keyFile.handled, "GET /<key>.txt: request was handled (not a 404 passthrough)");
    assertEq(keyFile.status, 200, "GET /<key>.txt: status 200");
    assertEq(keyFile.headers["content-type"], "text/plain; charset=utf-8", "GET /<key>.txt: Content-Type text/plain; charset=utf-8");
    assertEq(keyFile.body, INDEXNOW_KEY, "GET /<key>.txt: body is exactly the key string");

    // ── (b) GET /<random>.txt -> falls through, same as before (no regression) ──
    const randomFile = await callRoute(router, "/some-totally-random-file-9f3c2a.txt");
    assertTrue(!randomFile.handled, "GET /<random>.txt: not handled by the indexnow route (falls through unchanged)");
    assertTrue(randomFile.body !== INDEXNOW_KEY, "GET /<random>.txt: never returns the IndexNow key");

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/indexnow.test.ts`
if (require.main === module) {
  runIndexNowTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
