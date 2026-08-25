/**
 * opplevagent-sw.test.ts — unit tests for src/public/opplevagent-sw.js (the
 * opplevagent.no PWA service worker) and src/public/opplevagent-offline.html
 * (its precached offline fallback page).
 *
 * dev-request 2026-08-24-pwa-ikoner-alle-vertikaler-og-verifisering, extending
 * dev-request 2026-07-04-app-strategi-pwa (previously rfb-only, PRs
 * #225/#245) to opplevagent.no. Mirrors src/public/sw.test.ts's structure/
 * assertions exactly, but for the opplevagent cache name + app shell list.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/public/opplevagent-sw.test.ts
 *   2. Wired into the gate: tests/test.ts imports runOpplevagentServiceWorkerTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function makeAsserters(passed: { n: number }, failed: { n: number }, failures: string[], log: boolean) {
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed.n++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed.n++;
      const msg = `✗ ${label}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  return { assertTrue };
}

export function runOpplevagentServiceWorkerTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  const passed = { n: 0 };
  const failed = { n: 0 };
  const failures: string[] = [];
  const { assertTrue } = makeAsserters(passed, failed, failures, log);

  const swPath = join(__dirname, "opplevagent-sw.js");
  const swSrc = readFileSync(swPath, "utf8");

  // opplevagent-sw.js is valid, parseable JS.
  let compiled = false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(swSrc);
    compiled = true;
  } catch (err) {
    failures.push(`✗ opplevagent-sw.js is valid, parseable JS (${err instanceof Error ? err.message : String(err)})`);
  }
  assertTrue(compiled, "opplevagent-sw.js is valid, parseable JS");

  let mod: any = null;
  try {
    mod = require("./opplevagent-sw.js");
    assertTrue(true, "opplevagent-sw.js can be require()'d under Node without throwing");
  } catch (err) {
    assertTrue(false, `opplevagent-sw.js can be require()'d under Node without throwing (${err instanceof Error ? err.message : String(err)})`);
  }

  if (mod) {
    assertTrue(typeof mod.shouldBypass === "function", "opplevagent-sw.js exports a shouldBypass(request) guard function");
    assertTrue(mod.CACHE_VERSION === "opplevagent-pwa-v1", `opplevagent-sw.js CACHE_VERSION is "opplevagent-pwa-v1" (got "${mod.CACHE_VERSION}")`);
    assertTrue(Array.isArray(mod.APP_SHELL) && mod.APP_SHELL.length > 0, "opplevagent-sw.js exports a non-empty APP_SHELL precache list");

    if (typeof mod.APP_SHELL !== "undefined") {
      assertTrue(mod.APP_SHELL.includes("/manifest.json"), "APP_SHELL precaches /manifest.json");
      assertTrue(mod.APP_SHELL.includes("/favicon-192.png"), "APP_SHELL precaches /favicon-192.png");
      assertTrue(mod.APP_SHELL.includes("/favicon-512.png"), "APP_SHELL precaches /favicon-512.png");
      assertTrue(mod.APP_SHELL.includes("/favicon.svg"), "APP_SHELL precaches /favicon.svg");
      assertTrue(mod.APP_SHELL.includes("/offline.html"), "APP_SHELL precaches /offline.html");
    }

    if (typeof mod.shouldBypass === "function") {
      const origin = "https://opplevagent.no";
      const mk = (url: string, method = "GET") => ({ url, method } as any);

      assertTrue(mod.shouldBypass(mk(`${origin}/api/opplevelser/discover`), origin), "shouldBypass: GET /api/opplevelser/discover is bypassed (never cached)");
      assertTrue(mod.shouldBypass(mk(`${origin}/admin/dashboard`), origin), "shouldBypass: /admin* path is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/admin`), origin), "shouldBypass: bare /admin path is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/api/opplevelser/discover`, "POST")), "shouldBypass: non-GET request is bypassed regardless of path");
      assertTrue(mod.shouldBypass(mk("https://evil.example.com/favicon-192.png"), origin), "shouldBypass: cross-origin request is bypassed");

      assertTrue(!mod.shouldBypass(mk(`${origin}/manifest.json`), origin), "shouldBypass: GET /manifest.json (same-origin, not api/admin) is NOT bypassed");
      assertTrue(!mod.shouldBypass(mk(`${origin}/favicon-192.png`), origin), "shouldBypass: GET /favicon-192.png is NOT bypassed");
      assertTrue(!mod.shouldBypass(mk(`${origin}/`), origin), "shouldBypass: GET / (navigation) is NOT bypassed");
    }
  }

  const fetchHandlerIdx = swSrc.indexOf('addEventListener("fetch"');
  const bypassCallIdx = swSrc.indexOf("shouldBypass(request)");
  const firstCachesMatchIdx = swSrc.indexOf("caches.match(", fetchHandlerIdx === -1 ? 0 : fetchHandlerIdx);
  assertTrue(
    fetchHandlerIdx !== -1 && bypassCallIdx !== -1 && bypassCallIdx > fetchHandlerIdx,
    "fetch handler calls shouldBypass(request)"
  );
  assertTrue(
    firstCachesMatchIdx === -1 || bypassCallIdx < firstCachesMatchIdx,
    "shouldBypass(request) guard runs before any caches.match(...) call in the fetch handler"
  );

  // ── opplevagent-offline.html ────────────────────────────────────────────
  const offlinePath = join(__dirname, "opplevagent-offline.html");
  const offlineExists = existsSync(offlinePath) && statSync(offlinePath).isFile();
  assertTrue(offlineExists, "src/public/opplevagent-offline.html exists as a file");
  if (offlineExists) {
    const offlineSrc = readFileSync(offlinePath, "utf8");
    assertTrue(offlineSrc.includes("Du er offline"), "opplevagent-offline.html contains the 'Du er offline' message");
    assertTrue(/<html[^>]*lang="no"/.test(offlineSrc), 'opplevagent-offline.html declares lang="no"');
    assertTrue(/#ff5d3b/.test(offlineSrc), "opplevagent-offline.html uses the coral (#ff5d3b) brand color");
  }

  return { passed: passed.n, failed: failed.n, failures };
}

export async function runOpplevagentServiceWorkerHttpTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const passed = { n: 0 };
  const failed = { n: 0 };
  const failures: string[] = [];
  const { assertTrue } = makeAsserters(passed, failed, failures, log);

  // Unlike src/public/sw.js (served automatically on rettfrabonden.com via
  // express.static), opplevagent-sw.js/opplevagent-offline.html are NOT
  // reachable through express.static at all — the opplevagent.no host-gate
  // in src/index.ts routes every non-API path into experiencesSeoRouter's
  // explicit GET /sw.js / /offline.html routes instead (see that router's
  // own PWA route block). The HTTP-level "actually served with 200" check
  // for THOSE routes lives in experiences-seo-pwa.test.ts, which drives the
  // real router.handle() rather than a throwaway express.static mount — an
  // express.static server here would only prove the raw file is readable
  // off disk, not that opplevagent.no visitors can reach it.
  const filePath = join(__dirname, "opplevagent-sw.js");
  assertTrue(existsSync(filePath), "opplevagent-sw.js exists on disk (served via GET /sw.js in experiences-seo.ts — see experiences-seo-pwa.test.ts for the HTTP-reachability check)");

  return { passed: passed.n, failed: failed.n, failures };
}

if (require.main === module) {
  const result = runOpplevagentServiceWorkerTests({ log: true });
  runOpplevagentServiceWorkerHttpTests({ log: true }).then((httpResult) => {
    const passed = result.passed + httpResult.passed;
    const failed = result.failed + httpResult.failed;
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });
}
