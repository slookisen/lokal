/**
 * sw.test.ts — unit tests for src/public/sw.js (the rfb PWA service worker)
 * and src/public/offline.html (its precached offline fallback page).
 *
 * dev-request 2026-07-04-app-strategi-pwa, slice 2 of 3: service worker +
 * offline shell (rfb host only).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/public/sw.test.ts
 *   2. Wired into the gate: tests/test.ts imports runServiceWorkerTests()
 *      (sync, file/source checks) and runServiceWorkerHttpTests() (async,
 *      spins a throwaway express.static server to confirm sw.js/offline.html
 *      are actually served with 200 — same mount config as src/index.ts)
 *      and folds both pass/fail counts into the `npm test` summary.
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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected: ${JSON.stringify(expected)}, actual: ${JSON.stringify(actual)})`
    );
  }
  return { assertTrue, assertEq };
}

// ── Sync: file-content + guard-logic checks (no network) ──────────────────
export function runServiceWorkerTests(opts: { log?: boolean } = {}): TestSummary {
  const log = opts.log ?? false;
  const passed = { n: 0 };
  const failed = { n: 0 };
  const failures: string[] = [];
  const { assertTrue, assertEq } = makeAsserters(passed, failed, failures, log);

  const swPath = join(__dirname, "sw.js");
  const swSrc = readFileSync(swPath, "utf8");

  // sw.js is valid, parseable JS (compiles without executing top-level
  // `self`/`caches` calls — new Function() only parses+compiles the body).
  let compiled = false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(swSrc);
    compiled = true;
  } catch (err) {
    failures.push(`✗ sw.js is valid, parseable JS (${err instanceof Error ? err.message : String(err)})`);
  }
  assertTrue(compiled, "sw.js is valid, parseable JS");

  // sw.js is also require()-able under Node (its self.addEventListener(...)
  // registrations are guarded behind `typeof self !== "undefined"`, so
  // requiring it here — where `self` is not a service-worker global — is a
  // safe no-op that just exports the testable guard logic).
  let mod: any = null;
  try {
    mod = require("./sw.js");
    assertTrue(true, "sw.js can be require()'d under Node without throwing");
  } catch (err) {
    assertTrue(false, `sw.js can be require()'d under Node without throwing (${err instanceof Error ? err.message : String(err)})`);
  }

  if (mod) {
    assertTrue(typeof mod.shouldBypass === "function", "sw.js exports a shouldBypass(request) guard function");
    assertTrue(typeof mod.CACHE_VERSION === "string" && mod.CACHE_VERSION.length > 0, "sw.js exports a non-empty CACHE_VERSION string");
    assertTrue(Array.isArray(mod.APP_SHELL) && mod.APP_SHELL.length > 0, "sw.js exports a non-empty APP_SHELL precache list");

    if (typeof mod.APP_SHELL !== "undefined") {
      assertTrue(mod.APP_SHELL.includes("/manifest.json"), "APP_SHELL precaches /manifest.json");
      assertTrue(mod.APP_SHELL.includes("/logo-200.png"), "APP_SHELL precaches /logo-200.png");
      assertTrue(mod.APP_SHELL.includes("/logo-512.png"), "APP_SHELL precaches /logo-512.png");
      assertTrue(mod.APP_SHELL.includes("/offline.html"), "APP_SHELL precaches /offline.html");
    }

    if (typeof mod.shouldBypass === "function") {
      const origin = "https://rettfrabonden.com";
      const mk = (url: string, method = "GET") => ({ url, method } as any);

      assertTrue(mod.shouldBypass(mk(`${origin}/api/marketplace/agents`), origin), "shouldBypass: GET /api/marketplace/agents is bypassed (never cached)");
      assertTrue(mod.shouldBypass(mk(`${origin}/api/tannlege/ping`), origin), "shouldBypass: any /api/* path is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/admin/dashboard`), origin), "shouldBypass: /admin* path is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/admin`), origin), "shouldBypass: bare /admin path is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/api/marketplace/agents`, "POST")), "shouldBypass: non-GET request is bypassed regardless of path");
      assertTrue(mod.shouldBypass(mk("https://evil.example.com/logo-200.png"), origin), "shouldBypass: cross-origin request is bypassed");

      assertTrue(!mod.shouldBypass(mk(`${origin}/manifest.json`), origin), "shouldBypass: GET /manifest.json (same-origin, not api/admin) is NOT bypassed");
      assertTrue(!mod.shouldBypass(mk(`${origin}/logo-200.png`), origin), "shouldBypass: GET /logo-200.png is NOT bypassed");
      assertTrue(!mod.shouldBypass(mk(`${origin}/`), origin), "shouldBypass: GET / (navigation) is NOT bypassed");
    }
  }

  // Guard is an early-return at the top of the fetch handler, not buried
  // after cache-matching logic — pin the source shape defensively so a
  // future refactor can't silently move it below caches.match(...).
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

  // ── offline.html ──────────────────────────────────────────────────────
  const offlinePath = join(__dirname, "offline.html");
  const offlineExists = existsSync(offlinePath) && statSync(offlinePath).isFile();
  assertTrue(offlineExists, "src/public/offline.html exists as a file");
  if (offlineExists) {
    const offlineSrc = readFileSync(offlinePath, "utf8");
    assertTrue(offlineSrc.includes("Du er offline"), "offline.html contains the 'Du er offline' message");
    assertTrue(/<html[^>]*lang="no"/.test(offlineSrc), "offline.html declares lang=\"no\"");
    assertTrue(/#2[dD]5016/.test(offlineSrc), "offline.html uses the forest-green (#2D5016) brand color");
  }

  return { passed: passed.n, failed: failed.n, failures };
}

// ── Async: confirm sw.js and offline.html are actually served with 200 by
// the same express.static mount src/index.ts uses (src/public, no extra
// route wiring needed). No DB / shared singleton involved — fully isolated.
export async function runServiceWorkerHttpTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  const passed = { n: 0 };
  const failed = { n: 0 };
  const failures: string[] = [];
  const { assertTrue, assertEq } = makeAsserters(passed, failed, failures, log);

  const express = require("express");
  const http = require("http");
  const path = require("path");

  const app = express();
  app.use(express.static(path.join(__dirname), { extensions: ["html"] }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const get = async (p: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      const body = await res.text();
      return { status: res.status, body, contentType: res.headers.get("content-type") || "" };
    };

    const sw = await get("/sw.js");
    assertEq(sw.status, 200, "GET /sw.js -> 200");
    assertTrue(/javascript/.test(sw.contentType), `GET /sw.js content-type is javascript-ish (got "${sw.contentType}")`);

    const offline = await get("/offline.html");
    assertEq(offline.status, 200, "GET /offline.html -> 200");
    assertTrue(offline.body.includes("Du er offline"), "GET /offline.html body contains 'Du er offline'");

    const manifest = await get("/manifest.json");
    assertEq(manifest.status, 200, "GET /manifest.json -> 200 (still served alongside sw.js/offline.html)");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { passed: passed.n, failed: failed.n, failures };
}

if (require.main === module) {
  const result = runServiceWorkerTests({ log: true });
  runServiceWorkerHttpTests({ log: true }).then((httpResult) => {
    const passed = result.passed + httpResult.passed;
    const failed = result.failed + httpResult.failed;
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });
}
