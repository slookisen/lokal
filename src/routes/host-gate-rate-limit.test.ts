/**
 * host-gate-rate-limit.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-T (FUNN
 * `opplevagent-reise-uten-generalLimiter` from the review of lokal#1130).
 *
 * The finn-tannlege.com and opplevagent.no host gates in src/index.ts hand
 * every non-API path to dental-seo / experiences-seo BEFORE any of index.ts's
 * limiter mounts, and both routers end in a 404 catch-all. So
 * `app.use("/reise", generalLimiter)` only ever covered rettfrabonden.com:
 * opplevagent.no/reise — two geocodes, a Mapbox call and a route-cache insert
 * per distinct from/to pair — answered with no ratelimit-* headers at all
 * (verified live 2026-10-17). The slice's revision of every path behind the
 * two gates found three more with the same gap where the RFB/JSON twin has
 * generalLimiter; all four now carry the shared instance on the route:
 *   - experiences-seo.ts  GET  /reise                (RFB /reise: index.ts mount)
 *   - experiences-seo.ts  GET  /for-tilbydere/finn   (same LIKE search as /sok)
 *   - experiences-seo.ts  POST /kategori/gardssalg/book/:providerSlug
 *                              (JS twin /api/opplevelser/book: "/api" mount)
 *   - dental-seo.ts       GET  /sok                  (RFB and OA /sok: route)
 *
 * Sections:
 *   w1-w8   wiring, by reference: the real exported generalLimiter sits on
 *           each route before its final handler; RFB GET /reise stays
 *           route-limiter-free (it is counted once, by the index.ts mount).
 *   g1-g4   scope guard: those are the ONLY generalLimiter routes on the two
 *           routers — none on sitemap/robots/llms.txt/agent-card or any
 *           indexable page, and no router-wide limiter.
 *   a1      every route-level generalLimiter on the three SEO routers is one
 *           ac2LimitersFor (the AC2 shadow gate, client-ip.ts) counts.
 *   i1-i5  index.ts order (source inspection, like PR-106's block in
 *           tests/test.ts): both gates dispatch before the "/reise" mount,
 *           which still precedes the RFB seo router — so every /reise
 *           request is counted exactly once on each host.
 *   b1-b12  behaviour over real HTTP: the real experiences-seo router behind
 *           langMiddleware, the way the gate calls it. /reise answers with
 *           `ratelimit-policy: 300;w=900`, shares one per-client quota with
 *           /en/reise and /sok, is 429 after the limit (so is /sok), and a
 *           second client is unaffected.
 *
 * The behaviour block drives the production limiter (300/15 min), not a
 * scaled-down copy: 300 requests take well under a second here. It uses its
 * own TEST-NET-2 client addresses via X-Forwarded-For with `trust proxy` on
 * (as installClientIp sets it in index.ts), resets those two keys before and
 * after, and so never touches the 127.0.0.1 bucket other suites share. It
 * uses node:http with agent:false rather than the global fetch, which other
 * suites in the shared process stub (see PR-106's block in tests/test.ts).
 * Only /reise without from/to and /sok without q are requested: neither reads
 * a database nor makes an outbound call.
 *
 * Standalone: npx tsx src/routes/host-gate-rate-limit.test.ts
 * Wired into the gate: tests/test.ts imports runHostGateRateLimitTests().
 */

import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import express from "express";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteLayer {
  handle?: unknown;
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown; method?: string }>;
  };
}

type Method = "get" | "post";

/** Every route layer on a router's own stack registered for `method` at `routePath`. */
function routeLayers(router: { stack: RouteLayer[] }, method: Method, routePath: string): NonNullable<RouteLayer["route"]>[] {
  return router.stack
    .map((l) => l.route)
    .filter((r): r is NonNullable<RouteLayer["route"]> => !!r && r.path === routePath && !!r.methods[method]);
}

/** "GET /sok"-style labels for every route on the router that chains `limiter`. */
function limitedRoutes(router: { stack: RouteLayer[] }, limiter: unknown): string[] {
  const out: string[] = [];
  for (const layer of router.stack) {
    const r = layer.route;
    if (!r || !r.stack.some((s) => s.handle === limiter)) continue;
    for (const m of Object.keys(r.methods).filter((k) => r.methods[k])) {
      out.push(`${m.toUpperCase()} ${Array.isArray(r.path) ? r.path.join("|") : r.path}`);
    }
  }
  return out.sort();
}

interface Hit {
  status: number;
  policy: string | undefined;
  limit: string | undefined;
  remaining: string | undefined;
  retryAfter: string | undefined;
  body: string;
}

function get(port: number, urlPath: string, clientIp: string): Promise<Hit> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET", agent: false, headers: { "X-Forwarded-For": clientIp } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { body += c; });
        res.on("end", () => resolve({
          status: res.statusCode || 0,
          policy: res.headers["ratelimit-policy"] as string | undefined,
          limit: res.headers["ratelimit-limit"] as string | undefined,
          remaining: res.headers["ratelimit-remaining"] as string | undefined,
          retryAfter: res.headers["retry-after"] as string | undefined,
          body,
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function runHostGateRateLimitTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
  const { langMiddleware } = require("../i18n/middleware") as typeof import("../i18n/middleware");
  const expRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as unknown as { stack: RouteLayer[] };
  const dentalRouter = (require("./dental-seo") as typeof import("./dental-seo")).default as unknown as { stack: RouteLayer[] };
  const rfbRouter = (require("./seo") as typeof import("./seo")).default as unknown as { stack: RouteLayer[] };

  // ── w1-w8: wiring, by reference ───────────────────────────────────────
  const wired: Array<[string, { stack: RouteLayer[] }, Method, string, string]> = [
    ["w1", expRouter, "get", "/reise", "experiences-seo.ts GET /reise"],
    ["w2", expRouter, "get", "/for-tilbydere/finn", "experiences-seo.ts GET /for-tilbydere/finn"],
    ["w3", expRouter, "post", "/kategori/gardssalg/book/:providerSlug", "experiences-seo.ts POST /kategori/gardssalg/book/:providerSlug"],
    ["w4", dentalRouter, "get", "/sok", "dental-seo.ts GET /sok"],
  ];
  for (const [id, router, method, routePath, label] of wired) {
    const layers = routeLayers(router, method, routePath);
    assertEq(layers.length, 1, `${id}a: ${label} is registered exactly once`);
    const layer = layers[0];
    if (!layer) continue;
    const idx = layer.stack.findIndex((s) => s.handle === generalLimiter);
    assertTrue(idx >= 0, `${id}b: ${label} chains the real exported generalLimiter instance (shared quota, not a copy)`);
    assertTrue(idx >= 0 && idx < layer.stack.length - 1, `${id}c: ${label} runs generalLimiter before its final handler`);
  }
  // The booking form must be refused before its body is even parsed.
  {
    const book = routeLayers(expRouter, "post", "/kategori/gardssalg/book/:providerSlug")[0];
    assertEq(book ? book.stack.findIndex((s) => s.handle === generalLimiter) : -1, 0,
      "w5: POST /kategori/gardssalg/book/:providerSlug runs generalLimiter first, before express.urlencoded()");
  }
  // RFB /reise is unchanged: no route-level limiter in seo.ts, because the
  // index.ts mount (i3/i4) already counts it — a second one would count twice.
  {
    const layers = routeLayers(rfbRouter, "get", "/reise");
    assertEq(layers.length, 1, "w6: seo.ts (RFB) GET /reise is registered exactly once");
    const layer = layers[0];
    assertTrue(!!layer && !layer.stack.some((s) => s.handle === generalLimiter),
      "w7: seo.ts (RFB) GET /reise has NO route-level generalLimiter (counted once, by app.use(\"/reise\", generalLimiter))");
    assertTrue(!!layer && layer.stack.length === 1, "w8: seo.ts (RFB) GET /reise is still a bare handler (unchanged)");
  }

  // ── g1-g4: scope guard ────────────────────────────────────────────────
  assertEq(limitedRoutes(expRouter, generalLimiter),
    ["GET /for-tilbydere/finn", "GET /reise", "GET /sok", "POST /kategori/gardssalg/book/:providerSlug"],
    "g1: experiences-seo.ts — generalLimiter sits on exactly /sok, /reise, /for-tilbydere/finn and the booking form post");
  assertEq(limitedRoutes(dentalRouter, generalLimiter), ["GET /sok"],
    "g2: dental-seo.ts — generalLimiter sits on exactly GET /sok (no sitemap, robots, llms.txt, agent-card or indexable page)");
  assertTrue(!expRouter.stack.some((l) => !l.route && l.handle === generalLimiter),
    "g3: experiences-seo.ts has no router-wide generalLimiter (crawler-facing pages stay unlimited)");
  assertTrue(!dentalRouter.stack.some((l) => !l.route && l.handle === generalLimiter),
    "g4: dental-seo.ts has no router-wide generalLimiter (crawler-facing pages stay unlimited)");

  // ── a1: the AC2 shadow gate counts every one of these routes ──────────
  // ac2LimitersFor (middleware/client-ip.ts) must count a request wherever
  // generalLimiter does, or AC2's fanIn criterion could pass a key at 80 % of
  // it. client-ip-shadow-store.test.ts (H) pins the mounts by source line, and
  // skips a limiter on a line of its own (the booking post); this ties every
  // route-level generalLimiter on the three SEO routers to it by reference.
  {
    const { ac2LimitersFor } = require("../middleware/client-ip") as typeof import("../middleware/client-ip");
    const uncounted: string[] = [];
    let checked = 0;
    for (const router of [expRouter, dentalRouter, rfbRouter]) {
      for (const layer of router.stack) {
        const r = layer.route;
        if (!r || !r.stack.some((s) => s.handle === generalLimiter)) continue;
        for (const p of Array.isArray(r.path) ? r.path : [r.path]) {
          const sample = p.replace(/:[^/]+/g, "x");
          checked++;
          if (!ac2LimitersFor(sample).includes("general")) uncounted.push(sample);
        }
      }
    }
    assertTrue(checked === 6 && uncounted.length === 0,
      `a1: ac2LimitersFor counts all 6 route-level generalLimiter paths on the SEO routers as general (checked ${checked}, uncounted ${JSON.stringify(uncounted)})`);
  }

  // ── i1-i5: index.ts order (source inspection) ────────────────────────
  {
    const idxSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    const reiseMount = 'app.use("/reise", generalLimiter);';
    const reiseIdx = idxSrc.indexOf(reiseMount);
    const expGateIdx = idxSrc.indexOf("return experiencesSeoRouter(req, res, next);");
    const dentalGateIdx = idxSrc.indexOf("return dentalSeoRouter(req, res, next);");
    const seoIdx = idxSrc.indexOf('app.use("/", seoRoutes);');
    const apiIdx = idxSrc.indexOf('app.use("/api", generalLimiter);');
    const opplevelserIdx = idxSrc.indexOf('app.use("/api/opplevelser", opplevelserRoutes);');
    assertEq(idxSrc.split(reiseMount).length - 1, 1, "i1: index.ts still mounts app.use(\"/reise\", generalLimiter) exactly once");
    assertTrue(expGateIdx > -1 && reiseIdx > expGateIdx,
      "i2: the opplevagent.no gate dispatches to experiences-seo before the \"/reise\" mount (why OA /reise needs the route-level limiter, and is counted once)");
    assertTrue(dentalGateIdx > -1 && reiseIdx > dentalGateIdx,
      "i3: the finn-tannlege.com gate dispatches to dental-seo before the \"/reise\" mount too");
    assertTrue(reiseIdx > -1 && seoIdx > reiseIdx,
      "i4: the \"/reise\" mount still precedes the RFB seo router (RFB /reise unchanged)");
    assertTrue(apiIdx > -1 && opplevelserIdx > apiIdx,
      "i5: POST /api/opplevelser/book (the booking form's JS twin) is still behind app.use(\"/api\", generalLimiter)");
  }

  // ── b1-b12: behaviour over real HTTP ─────────────────────────────────
  // TEST-NET-2 (RFC 5737) addresses no other suite uses; keys reset both ways.
  const CLIENT_A = "198.51.100.71";
  const CLIENT_B = "198.51.100.72";
  const LIMIT = 300; // generalLimiter's anonymous ceiling — read, never changed, here
  await generalLimiter.resetKey(CLIENT_A);
  await generalLimiter.resetKey(CLIENT_B);
  const app = express();
  app.set("trust proxy", true);
  app.use(langMiddleware);
  app.use((req, res, next) => (expRouter as unknown as express.RequestHandler)(req, res, next));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const first = await get(port, "/reise", CLIENT_A);
    assertEq(first.status, 200, "b1: GET /reise on the opplevagent router → 200");
    assertEq(first.policy, "300;w=900", "b2: GET /reise carries ratelimit-policy: 300;w=900 (what the live check after deploy reads)");
    assertEq([first.limit, first.remaining], ["300", "299"], "b3: first /reise hit → limit 300, remaining 299 (counted once, not twice)");

    const en = await get(port, "/en/reise", CLIENT_A);
    assertEq([en.status, en.remaining], [200, "298"], "b4: GET /en/reise (langMiddleware → /reise) draws on the same bucket");

    const sok = await get(port, "/sok", CLIENT_A);
    assertEq([sok.status, sok.remaining], [200, "297"], "b5: GET /sok draws on the same bucket (one quota per client across /sok and /reise)");

    const after = await get(port, "/reise", CLIENT_A);
    assertEq(after.remaining, "296", "b6: the next /reise hit sees /sok's request already spent");

    let used = 4;
    let allOk = true;
    let lastRemaining: string | undefined;
    while (used < LIMIT) {
      const r = await get(port, "/reise", CLIENT_A);
      used++;
      if (r.status !== 200) allOk = false;
      lastRemaining = r.remaining;
    }
    assertTrue(allOk, `b7: every request up to the limit (${LIMIT}) → 200`);
    assertEq(lastRemaining, "0", "b8: the 300th request leaves remaining 0");

    const over = await get(port, "/reise", CLIENT_A);
    assertEq(over.status, 429, "b9: request 301 to /reise → 429");
    let overBody: { success?: boolean; error?: string } = {};
    try { overBody = JSON.parse(over.body); } catch { /* asserted below */ }
    assertTrue(overBody.success === false && overBody.error === "For mange forespørsler. Prøv igjen senere." && !!over.retryAfter,
      "b10: the 429 is generalLimiter's own (its Norwegian message + retry-after), not a page");

    const sokOver = await get(port, "/sok", CLIENT_A);
    const enOver = await get(port, "/en/reise", CLIENT_A);
    assertEq([sokOver.status, enOver.status], [429, 429],
      "b11: once /reise has spent the quota, /sok and /en/reise are 429 for that client too (shared quota)");

    const other = await get(port, "/reise", CLIENT_B);
    assertEq([other.status, other.remaining], [200, "299"], "b12: another client is unaffected (per-client bucket, not a global brake)");
  } catch (err) {
    failed++;
    failures.push(`✗ behaviour block crashed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await generalLimiter.resetKey(CLIENT_A);
    await generalLimiter.resetKey(CLIENT_B);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runHostGateRateLimitTests({ log: true }).then((r) => {
    console.log(`\nhost-gate-rate-limit: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
