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
import { createSwSim } from "./sw-test-harness";

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
      assertTrue(mod.APP_SHELL.includes("/favicon-192.png"), "APP_SHELL precaches /favicon-192.png");
      assertTrue(mod.APP_SHELL.includes("/favicon-512.png"), "APP_SHELL precaches /favicon-512.png");
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

      assertTrue(mod.shouldBypass(mk(`${origin}/Admin/dashboard`), origin), "shouldBypass: /Admin/dashboard (mixed-case) is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/ADMIN/x`), origin), "shouldBypass: /ADMIN/x (upper-case) is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/API/marketplace/agents`), origin), "shouldBypass: /API/marketplace/agents (upper-case) is bypassed");
      assertTrue(mod.shouldBypass(mk(`${origin}/Api/x`), origin), "shouldBypass: /Api/x (mixed-case) is bypassed");

      assertTrue(!mod.shouldBypass(mk(`${origin}/manifest.json`), origin), "shouldBypass: GET /manifest.json (same-origin, not api/admin) is NOT bypassed");
      assertTrue(!mod.shouldBypass(mk(`${origin}/logo-200.png`), origin), "shouldBypass: GET /logo-200.png is NOT bypassed");
      assertTrue(!mod.shouldBypass(mk(`${origin}/`), origin), "shouldBypass: GET / (navigation) is NOT bypassed");
    }

    // ── F-g: owner pages, query URLs and no-store/private responses are never cached ──
    assertTrue(mod.CACHE_VERSION !== "rfb-pwa-v1", `CACHE_VERSION is bumped past "rfb-pwa-v1" so activate deletes old entries (got "${mod.CACHE_VERSION}")`);
    assertTrue(/^rfb-pwa-v\d+$/.test(mod.CACHE_VERSION), `CACHE_VERSION keeps the rfb-pwa-v<N> shape (got "${mod.CACHE_VERSION}")`);
    assertTrue(typeof mod.isCacheableStatic === "function", "sw.js exports isCacheableStatic(url)");
    assertTrue(typeof mod.isCacheableResponse === "function", "sw.js exports isCacheableResponse(response)");
    assertTrue(typeof mod.isPrivatePath === "function", "sw.js exports isPrivatePath(pathname)");

    if (typeof mod.shouldBypass === "function") {
      const origin = "https://rettfrabonden.com";
      const mk = (url: string, method = "GET") => ({ url, method } as any);
      const bypassed = [
        "/eier/abc/valg?fragment=1",
        "/eier/abc/valg",
        "/eier/abc",
        "/eier/abc/portal",
        "/Eier/abc/varer",
        "/selger.html",
        "/selger",
        "/produsent/ordre/x",
        "/produsent/ordre/x/kompakt",
        "/kategori/frukt/eier",
        "/kategori/gardssalg/eier/slug/portal",
        "/magic-link-verify",
        "/auth/m/tok",
        "/lagerstatus/tok",
        "/avmeld/tok",
        "/sok?q=eple",
        "/?utm_source=x",
        "/logo-200.png?v=2",
      ];
      for (const p of bypassed) {
        assertTrue(mod.shouldBypass(mk(`${origin}${p}`), origin), `shouldBypass: GET ${p} is bypassed (owner path or query URL)`);
      }
      assertTrue(!mod.shouldBypass(mk(`${origin}/kategori/frukt`), origin), "shouldBypass: public /kategori/frukt is NOT bypassed (only /kategori/*/eier is)");
      assertTrue(!mod.shouldBypass(mk(`${origin}/kategori/eier-test`), origin), "shouldBypass: /kategori/eier-test (no owner segment) is NOT bypassed");
    }

    if (typeof mod.isCacheableStatic === "function") {
      const origin = "https://rettfrabonden.com";
      const notCacheable = [
        "/eier/abc/valg?fragment=1",
        "/eier/abc/valg",
        "/eier/abc/app.js",
        "/selger.html",
        "/selger/x",
        "/produsent/ordre/x",
        "/produsent/ordre/x/logo.png",
        "/kategori/frukt/eier",
        "/kategori/frukt/eier/logo.png",
        "/logo-200.png?v=2",
        "/manifest.json?x=1",
        "/leaflet/leaflet.css?x",
        "/",
        "/sok",
        "/produsenter",
        "/openapi.json",
        "/agent-card.json",
        "/llms.txt",
        "/sitemap.xml",
        "/kategori/frukt",
      ];
      for (const p of notCacheable) {
        assertTrue(!mod.isCacheableStatic(`${origin}${p}`), `isCacheableStatic: ${p} is NOT cacheable`);
      }
      const cacheable = [
        "/logo-200.png",
        "/favicon.svg",
        "/favicon.ico",
        "/manifest.json",
        "/offline.html",
        "/leaflet/leaflet.css",
        "/leaflet/leaflet.js",
        "/install-prompt.js",
        "/agentplatform-geist-latin-wght.woff2",
        "/site.webmanifest",
      ];
      for (const p of cacheable) {
        assertTrue(mod.isCacheableStatic(`${origin}${p}`), `isCacheableStatic: ${p} is cacheable`);
      }
      for (const p of mod.APP_SHELL as string[]) {
        assertTrue(mod.isCacheableStatic(`${origin}${p}`), `isCacheableStatic: APP_SHELL entry ${p} is cacheable`);
      }
      assertTrue(!mod.isCacheableStatic("not a url"), "isCacheableStatic: unparsable URL is NOT cacheable");
    }

    if (typeof mod.isCacheableResponse === "function") {
      const res = (cc: string | null, status = 200) =>
        new Response("x", { status, headers: cc === null ? {} : { "Cache-Control": cc } });
      assertTrue(mod.isCacheableResponse(res(null)), "isCacheableResponse: 200 without Cache-Control is stored");
      assertTrue(mod.isCacheableResponse(res("public, max-age=86400")), "isCacheableResponse: 200 public,max-age is stored");
      assertTrue(mod.isCacheableResponse(res("no-cache")), "isCacheableResponse: no-cache (revalidate, not forbid-store) is stored");
      assertTrue(!mod.isCacheableResponse(res("no-store")), "isCacheableResponse: Cache-Control: no-store is NOT stored");
      assertTrue(!mod.isCacheableResponse(res("private")), "isCacheableResponse: Cache-Control: private is NOT stored");
      assertTrue(!mod.isCacheableResponse(res("private, max-age=0")), "isCacheableResponse: private, max-age=0 is NOT stored");
      assertTrue(!mod.isCacheableResponse(res("max-age=0, No-Store")), "isCacheableResponse: max-age=0, No-Store (mixed case) is NOT stored");
      assertTrue(!mod.isCacheableResponse(res(null, 404)), "isCacheableResponse: 404 is NOT stored");
      assertTrue(!mod.isCacheableResponse(res(null, 500)), "isCacheableResponse: 500 is NOT stored");
      assertTrue(!mod.isCacheableResponse(null), "isCacheableResponse: missing response is NOT stored");
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

  // ── offline.html ──────────────────────────────────────────────────────
  const offlinePath = join(__dirname, "offline.html");
  const offlineExists = existsSync(offlinePath) && statSync(offlinePath).isFile();
  assertTrue(offlineExists, "src/public/offline.html exists as a file");
  if (offlineExists) {
    const offlineSrc = readFileSync(offlinePath, "utf8");
    assertTrue(offlineSrc.includes("Du er offline"), "offline.html contains the 'Du er offline' message");
    assertTrue(/<html[^>]*lang="no"/.test(offlineSrc), 'offline.html declares lang="no"');
    assertTrue(/#2[dD]5016/.test(offlineSrc), "offline.html uses the forest-green (#2D5016) brand color");
  }

  return { passed: passed.n, failed: failed.n, failures };
}

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

  // ── F-g: drive the real fetch handler in a sandbox ─────────────────────
  const swSrc = readFileSync(join(__dirname, "sw.js"), "utf8");
  const origin = "https://rettfrabonden.com";
  const sim = createSwSim(swSrc, origin, (url) => {
    if (url.endsWith("/nostore.png")) return new Response("x", { status: 200, headers: { "Cache-Control": "no-store" } });
    if (url.endsWith("/private.css")) return new Response("x", { status: 200, headers: { "Cache-Control": "private, max-age=60" } });
    return new Response("fresh", { status: 200 });
  });

  for (const p of ["/eier/abc/valg?fragment=1", "/eier/abc/valg", "/selger.html", "/produsent/ordre/x", "/kategori/frukt/eier", "/sok?q=1", "/some/page", "/openapi.json"]) {
    const r = await sim.dispatch({ url: `${origin}${p}` });
    assertTrue(!r.intercepted, `fetch handler: non-navigation GET ${p} is NOT intercepted (no respondWith)`);
  }
  const navOwner = await sim.dispatch({ url: `${origin}/eier/abc/valg`, mode: "navigate" });
  assertTrue(!navOwner.intercepted, "fetch handler: navigation to /eier/abc/valg is NOT intercepted");
  const nav = await sim.dispatch({ url: `${origin}/`, mode: "navigate" });
  assertTrue(nav.intercepted, "fetch handler: navigation to / is still intercepted (network-first with offline fallback)");

  const logo = await sim.dispatch({ url: `${origin}/logo-200.png` });
  assertTrue(logo.intercepted, "fetch handler: GET /logo-200.png is intercepted (cache-first)");
  assertTrue(sim.puts.includes(`${origin}/logo-200.png`), "fetch handler: normal static 200 response for /logo-200.png is stored");
  const css = await sim.dispatch({ url: `${origin}/leaflet/leaflet.css` });
  assertTrue(css.intercepted && sim.puts.includes(`${origin}/leaflet/leaflet.css`), "fetch handler: GET /leaflet/leaflet.css is intercepted and stored");
  const fetchesBefore = sim.networkFetches.length;
  const logoAgain = await sim.dispatch({ url: `${origin}/logo-200.png` });
  assertTrue(logoAgain.intercepted && sim.networkFetches.length === fetchesBefore, "fetch handler: repeat GET /logo-200.png is served from cache (no network fetch)");

  const ns = await sim.dispatch({ url: `${origin}/nostore.png` });
  assertTrue(ns.intercepted && !sim.puts.includes(`${origin}/nostore.png`), "fetch handler: static response with Cache-Control: no-store is NOT stored");
  const pv = await sim.dispatch({ url: `${origin}/private.css` });
  assertTrue(pv.intercepted && !sim.puts.includes(`${origin}/private.css`), "fetch handler: static response with Cache-Control: private is NOT stored");

  const allowedPuts = sim.puts.filter((u) => !u.endsWith("/logo-200.png") && !u.endsWith("/leaflet/leaflet.css"));
  assertEq(allowedPuts, [], "fetch handler: nothing but the two static files was ever written to the cache");

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
