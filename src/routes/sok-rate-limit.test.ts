/**
 * sok-rate-limit.test.ts — dev-request follow-up to the 2026-07-26 code
 * review of the reisesok/korridor feature ("egen sak"): `/sok` had NO rate
 * limiter on either host while its sibling route `/reise` did
 * (`app.use("/reise", generalLimiter)` in src/index.ts), even though `/sok`
 * now does live geocoding fan-out (Kartverket calls) when parsing
 * route-intent queries like "oslo til bodø" — a more expensive
 * unauthenticated path than a plain search, with no abuse protection at
 * all. Fixed by wiring the existing, already-exported `generalLimiter`
 * (src/middleware/security.ts) directly onto the two `/sok` route handlers:
 *   - src/routes/seo.ts             (rettfrabonden.com)
 *   - src/routes/experiences-seo.ts (opplevagent.no)
 *
 * This deliberately does NOT drive hundreds of real requests to trigger a
 * real 429 (slow, flaky, and would need its own DB/geocoder stubbing per
 * platform — see sok-search-honesty.test.ts / experiences-seo-sok-geo.test.ts
 * for how heavy that harness already is for these two routers). Instead it
 * asserts, by reference, on each Express Router's own registered route
 * stack for the "/sok" path: the exact SAME technique used to introspect
 * routers elsewhere in this codebase (this suite's own require()-and-poke
 * idiom — see e.g. how sok-search-honesty.test.ts pulls
 * `require("./seo").default` and drives `router.handle` directly). That
 * makes this deterministic, sub-millisecond, and immune to future changes
 * in generalLimiter's own window/max — it only proves the two routes chain
 * through the real, exported `generalLimiter` instance (identity-checked,
 * not a re-implementation), and stays red if either wiring is ever removed
 * or swapped for a different limiter instance.
 *
 * Both router modules are already `require()`d many times elsewhere in this
 * shared-process suite (tests/test.ts) — Node's module cache means this
 * file's own `require()` calls return the exact same router/limiter
 * instances already wired at module load, so this needs no DB, no server,
 * and no teardown.
 *
 * Standalone: npx tsx src/routes/sok-rate-limit.test.ts
 * Wired into the gate: tests/test.ts imports runSokRateLimitTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
}

/** Finds the GET "/sok" route layer(s) on a router's own stack. */
function findSokLayers(router: { stack: RouteLayer[] }): NonNullable<RouteLayer["route"]>[] {
  return router.stack
    .map((l) => l.route)
    .filter((r): r is NonNullable<RouteLayer["route"]> => !!r && r.path === "/sok" && !!r.methods.get);
}

export function runSokRateLimitTests(opts: { log?: boolean } = {}): TestSummary {
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
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");

  // ── RFB (rettfrabonden.com): src/routes/seo.ts ─────────────────────────
  {
    const seoRouter = (require("./seo") as typeof import("./seo")).default as unknown as { stack: RouteLayer[] };
    const sokLayers = findSokLayers(seoRouter);
    assertEq(sokLayers.length, 1, "seo.ts: exactly one GET /sok route is registered");
    const layer = sokLayers[0];
    if (layer) {
      const hasGeneralLimiter = layer.stack.some((s) => s.handle === generalLimiter);
      assertTrue(hasGeneralLimiter, "seo.ts GET /sok: generalLimiter is wired as router-level middleware on this route (by reference, the real exported instance)");
      // Guards against the limiter being wired but placed AFTER the handler
      // (a no-op) instead of before it as router-level middleware.
      const limiterIdx = layer.stack.findIndex((s) => s.handle === generalLimiter);
      assertTrue(limiterIdx >= 0 && limiterIdx < layer.stack.length - 1, "seo.ts GET /sok: generalLimiter runs before the route's final handler, not after");
    }
  }

  // ── OpplevAgent (opplevagent.no): src/routes/experiences-seo.ts ────────
  {
    const expRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as unknown as { stack: RouteLayer[] };
    const sokLayers = findSokLayers(expRouter);
    assertEq(sokLayers.length, 1, "experiences-seo.ts: exactly one GET /sok route is registered");
    const layer = sokLayers[0];
    if (layer) {
      const hasGeneralLimiter = layer.stack.some((s) => s.handle === generalLimiter);
      assertTrue(hasGeneralLimiter, "experiences-seo.ts GET /sok: generalLimiter is wired as router-level middleware on this route (by reference, the real exported instance)");
      const limiterIdx = layer.stack.findIndex((s) => s.handle === generalLimiter);
      assertTrue(limiterIdx >= 0 && limiterIdx < layer.stack.length - 1, "experiences-seo.ts GET /sok: generalLimiter runs before the route's final handler, not after");
    }
  }

  // ── Scope guard: this fix must NOT reach the SEO-critical crawler-facing
  // catch-all surfaces those same routers also serve (sitemap.xml,
  // robots.txt, llms.txt, agent-card.json, openapi.json) — those are
  // deliberately excluded from this limiter per the dev-request's own
  // instructions, so prove they stay untouched. ────────────────────────
  {
    const seoRouter = (require("./seo") as typeof import("./seo")).default as unknown as { stack: RouteLayer[] };
    const expRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as unknown as { stack: RouteLayer[] };
    const guardedPaths = ["/sitemap.xml", "/robots.txt", "/llms.txt", "/agent-card.json", "/openapi.json", "/.well-known/agent-card.json"];
    for (const router of [seoRouter, expRouter]) {
      for (const layer of router.stack) {
        const route = layer.route;
        if (!route || !guardedPaths.includes(route.path)) continue;
        const hasGeneralLimiter = route.stack.some((s) => s.handle === generalLimiter);
        assertTrue(!hasGeneralLimiter, `${route.path}: NOT wired to generalLimiter (crawler-facing surface, deliberately excluded)`);
      }
    }
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  const r = runSokRateLimitTests({ log: true });
  console.log(`\nsok-rate-limit: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
