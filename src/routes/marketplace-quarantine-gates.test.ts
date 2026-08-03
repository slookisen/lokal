/**
 * marketplace-quarantine-gates.test.ts — dev-request
 * 2026-08-03-mikhailo-quarantine-gates.
 *
 * Incident this guards against (2026-07-30): a spam profile ("Mikhailo T",
 * Kyiv) was (1) created via the PUBLIC POST /api/marketplace/register
 * endpoint, (2) same-day self-claimed via the ordinary email-code claim
 * flow — the claimant controls both the registration AND the
 * "verification" inbox — earning a public "Verifisert" trust badge on zero
 * real evidence, and (3) IndexNow-ping'd to Bing/Yandex within seconds of
 * registration, before any human ever saw it.
 *
 * Three additive gates close this, keyed off two new `agents` columns
 * (`origin`, `is_vetted` — see database/init.ts):
 *   Gate 1 (visibility)   — marketplace-registry.ts discover() and
 *                            routes/seo.ts's GET /produsent/:slug exclude
 *                            is_vetted = 0 rows.
 *   Gate 2 (verified badge) — knowledge-service.ts's verifyClaim() skips the
 *                            is_verified UPDATE when origin='self_registered'
 *                            (claim itself still succeeds).
 *   Gate 3 (IndexNow)     — routes/marketplace.ts's POST /register no longer
 *                            pings IndexNow; the ping now fires from
 *                            routes/admin-agents.ts's NEW
 *                            POST /self-registered-review-approve instead.
 *
 * This suite asserts on real production code — the actual router handlers
 * pulled off each router's stack and invoked directly with a fake req/res
 * (no HTTP server, no port; same convention as produsent-role-gate.test.ts,
 * which this harness mirrors), plus the actual marketplaceRegistry /
 * knowledgeService singletons — against its own in-memory DB via
 * __setDbForTesting/__initSchemaForTesting. pingIndexNow is spied by
 * patching the exported function on the (process-cached, shared)
 * indexnow-service module object — every caller in this codebase reaches it
 * via a CommonJS namespace-property access (`indexnow_service_1.pingIndexNow(...)`,
 * standard tsc CommonJS emission, never a destructured local), so the patch
 * is observed regardless of require() ordering.
 *
 * Cases:
 *   (a) Mikhailo-replay: self_registered agent via the REAL POST /register
 *       handler → NOT vetted, absent from discover(), /produsent/:slug
 *       404s (no name leak), pingIndexNow NOT called at registration —
 *       even when the request body tries to spoof origin/isVetted (Zod
 *       strips them; the route hardcodes both anyway). Claim flow (real
 *       /agents/:id/claim + /agents/:id/claim/verify handlers) still
 *       succeeds (claimToken issued) but is_verified stays 0.
 *   (b) Negative control: discovery-origin agent via direct register() with
 *       no origin override (simulates POST /admin/register and every
 *       src/_seeds/*.ts script, and any pre-migration/legacy row — all
 *       collapse to origin='discovery') → vetted, discoverable, profile
 *       page renders, and the SAME claim flow sets is_verified=1 exactly as
 *       it does today (zero new friction for real producers).
 *   (c) Admin release lever: self-registered-review-queue lists ONLY
 *       (self_registered, unvetted) rows, oldest-first, never the
 *       discovery-origin control; self-registered-review-approve flips
 *       is_vetted (auth-gated, exact-match agentId, origin-checked, 404 on
 *       unknown id) and — ONLY then — pings IndexNow for the produsent URL;
 *       after approval the (still self_registered) agent is discoverable
 *       and its page renders, but is_verified is STILL 0 (Gate 2 has no
 *       escape hatch — vetting for visibility is not the same as
 *       ownership evidence for the badge).
 *
 * Each assertion below is commented with which gate's specific line it
 * would catch a regression on, per the mutation-test requirement.
 *
 * Exported runMarketplaceQuarantineGatesTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/marketplace-quarantine-gates.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

export async function runMarketplaceQuarantineGatesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = ON");

  // ── req/res test harness — no HTTP server, no port; invokes the real
  // handler function pulled directly off the router's own stack ──────────
  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  function makeReq(o: {
    params?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      params: o.params || {},
      body: o.body,
      query: o.query || {},
      headers,
      ip: "127.0.0.1",
      lang: "no",
      protocol: "https",
      get(name: string) {
        if (name.toLowerCase() === "host") return "rettfrabonden.com";
        return headers[name.toLowerCase()];
      },
    };
  }

  function invokeHandler(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => {
        if (settled) return;
        settled = true;
        resolve({ status, body });
      };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(payload: any) { settle(payload); return res; },
        send(payload: any) { settle(payload); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
      };
      try {
        const maybePromise = handler(req, res);
        if (maybePromise && typeof maybePromise.catch === "function") {
          maybePromise.catch((err: any) => settle({ __error: String(err) }));
        }
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  // ── pingIndexNow spy ─────────────────────────────────────────────────
  // tsx/esbuild compiles `import { pingIndexNow } from "X"` as a
  // DESTRUCTURED local binding (`const { pingIndexNow } = require("X")`),
  // not a namespace-property access — so patching a property on the
  // already-required module object after the fact does NOT intercept a
  // caller that destructured before the patch (verified: it silently made
  // a real network call to the live IndexNow API in an earlier version of
  // this harness). The reliable seam is one level up: replace the ENTIRE
  // cached module at its resolved path with a fake exports object BEFORE
  // (re-)requiring admin-agents.ts, so ITS OWN `require("../services/
  // indexnow-service")` — which resolves to the exact same absolute path
  // Node's require cache is keyed on — returns the fake object and
  // destructures the stub, not the real network-calling function.
  const indexNowPath = require.resolve("../services/indexnow-service");
  const originalIndexNowCacheEntry = require.cache[indexNowPath];
  let pingCalls: Array<{ urls: string[]; host: string }> = [];
  require.cache[indexNowPath] = {
    id: indexNowPath,
    filename: indexNowPath,
    loaded: true,
    exports: {
      pingIndexNow: (urls: string[], host: string) => { pingCalls.push({ urls, host }); },
    },
  } as any;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // seo.ts's shell() calls getConfig(), which throws unless the vertical
    // configs were cold-loaded — same best-effort load as
    // produsent-role-gate.test.ts / admin-agents-brreg-catalog-sweep.test.ts.
    const { loadConfigsAtBoot } = require("../config/vertical-config") as
      typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI */ }

    // Fresh requires so no stale closures from an earlier suite's DB linger.
    const marketplaceRoutePath = require.resolve("./marketplace");
    const adminAgentsRoutePath = require.resolve("./admin-agents");
    const seoRoutePath = require.resolve("./seo");
    delete require.cache[marketplaceRoutePath];
    delete require.cache[adminAgentsRoutePath];
    delete require.cache[seoRoutePath];
    const marketplaceRouter = require("./marketplace").default as any;
    const adminAgentsRouter = require("./admin-agents").default as any;
    const seoRouter = require("./seo").default as any;

    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    marketplaceRegistry._agentsCache = null;

    const registerHandler = findRouteHandler(marketplaceRouter, "/register", "post");
    const claimHandler = findRouteHandler(marketplaceRouter, "/agents/:id/claim", "post");
    const claimVerifyHandler = findRouteHandler(marketplaceRouter, "/agents/:id/claim/verify", "post");
    const produsentHandler = findRouteHandler(seoRouter, "/produsent/:slug", "get");
    const reviewQueueHandler = findRouteHandler(adminAgentsRouter, "/self-registered-review-queue", "get");
    const reviewApproveHandler = findRouteHandler(adminAgentsRouter, "/self-registered-review-approve", "post");

    const SUITE_ADMIN_KEY_LOCAL = process.env.ADMIN_KEY || "suite-canonical-admin-key-20260730";

    // ── Source-inspection regression guard (Gate 3, belt-and-suspenders) ──
    // Independent of the pingIndexNow spy below: confirms the /register
    // handler's OWN source text never calls pingIndexNow(, catching a
    // regression even if some future refactor breaks the spy's module-
    // identity assumption.
    {
      const fs = require("fs");
      const marketplaceSrc = fs.readFileSync(marketplaceRoutePath.replace(/\.js$/, ".ts"), "utf8");
      const registerBlockMatch = marketplaceSrc.match(/router\.post\("\/register"[\s\S]*?\n\}\);/);
      assertTrue(!!registerBlockMatch, "setup: /register handler source block located for inspection");
      if (registerBlockMatch) {
        assertTrue(
          !registerBlockMatch[0].includes("pingIndexNow("),
          "gate3-source: /register handler source contains NO pingIndexNow( call (Gate 3 — the call was removed, not conditionally skipped)",
        );
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // (a) MIKHAILO-REPLAY: self_registered via the REAL POST /register
    // ══════════════════════════════════════════════════════════════════
    let mikhailoId = "";
    {
      const regBody: any = {
        name: "Mikhailo T",
        description: "En dyktig leverandør av diverse varer til gode priser.",
        provider: "Mikhailo T",
        contactEmail: "mikhailo@example-spam.test",
        url: "https://mikhailo-spam.example.test",
        role: "producer",
        skills: [{
          id: "sell-goods", name: "Selger varer", description: "Selger diverse varer",
          tags: ["diverse"],
        }],
        // Spoofing attempt: AgentRegistrationSchema has no such fields, so
        // Zod strips both before the handler ever sees them — and the
        // handler hardcodes origin/isVetted regardless. If either gate's
        // wiring regressed to trust body input, this fixture would prove it.
        origin: "discovery",
        isVetted: true,
      };

      const r1 = await invokeHandler(registerHandler, makeReq({ body: regBody }));
      assertEq(r1.status, 201, "a1: POST /register succeeds (201) for a self-registration");
      assertTrue(!!r1.body?.data?.id, "a2: response includes the new agent id");
      mikhailoId = r1.body.data.id;

      // Gate 3 (marketplace.ts /register): pingIndexNow must not fire here.
      assertEq(pingCalls.length, 0, "gate3: pingIndexNow NOT called at self-registration (would flip if the removed call were re-added)");

      const row = testDb.prepare("SELECT origin, is_vetted, is_verified FROM agents WHERE id = ?").get(mikhailoId) as any;
      assertEq(row?.origin, "self_registered", "a3: origin='self_registered' written despite body trying to spoof 'discovery' (register()/route hardcode it)");
      assertEq(row?.is_vetted, 0, "gate1-write: is_vetted=0 on insert despite body trying to spoof isVetted:true");
      assertEq(row?.is_verified, 0, "a4: is_verified starts at 0 like any new agent");

      // Gate 1 (discover()): must NOT appear in discovery results.
      marketplaceRegistry._agentsCache = null;
      const discoverBefore = marketplaceRegistry.discover({ role: "producer", limit: 100, offset: 0 });
      assertTrue(
        !discoverBefore.some((r: any) => r.agent.id === mikhailoId),
        "gate1-discover: self_registered/unvetted agent absent from discover() results (would flip if 'AND is_vetted = 1' were dropped from the SQL)",
      );

      // Gate 1 (produsent page): must 404 exactly like an unknown slug, and
      // must never leak the agent's name into the response body.
      const slug = slugify("Mikhailo T");
      const rPage = await invokeHandler(produsentHandler, makeReq({ params: { slug } }));
      assertEq(rPage.status, 404, "gate1-page: /produsent/mikhailo-t 404s before vetting (would flip if the is_vetted read/check were dropped from seo.ts's role-gate block)");
      assertTrue(String(rPage.body).includes("Produsent ikke funnet"), "gate1-page: gets the SAME not-found page an unknown slug gets");
      assertTrue(!String(rPage.body).includes("Mikhailo T"), "gate1-page: the agent's own name never reaches the response body (no exists-but-hidden leak)");

      // Claim flow: request + verify — succeeds, but is_verified stays 0.
      const rClaim = await invokeHandler(claimHandler, makeReq({
        params: { id: mikhailoId },
        body: { name: "Mikhailo T", email: "mikhailo@example-spam.test" },
      }));
      assertEq(rClaim.status, 200, "a5: claim request succeeds for a self_registered agent (no new friction on the claim REQUEST step)");
      const claimId = rClaim.body?.data?.claimId;
      const code = rClaim.body?.data?.verificationCode;
      assertTrue(!!claimId, "a6: claimId issued");
      assertTrue(!!code, "a7: dry-run verification code returned (no SMTP configured in test env)");

      const rVerify = await invokeHandler(claimVerifyHandler, makeReq({
        params: { id: mikhailoId },
        body: { claimId, code },
      }));
      assertEq(rVerify.status, 200, "a8: claim VERIFY succeeds (same code-based flow, same step count as a real producer)");
      assertTrue(!!rVerify.body?.data?.claimToken, "a9: claimToken issued — claimant CAN still manage the listing");

      const claimRow = testDb.prepare("SELECT status FROM agent_claims WHERE id = ?").get(claimId) as any;
      assertEq(claimRow?.status, "verified", "a10: agent_claims.status becomes 'verified' (claim itself is real)");

      const afterClaim = testDb.prepare("SELECT is_verified FROM agents WHERE id = ?").get(mikhailoId) as any;
      assertEq(
        afterClaim?.is_verified, 0,
        "gate2: is_verified STAYS 0 for a self_registered agent even after a fully successful claim (would flip to 1 if the origin check were dropped from verifyClaim())",
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // (b) NEGATIVE CONTROL: discovery-origin agent, no origin override —
    // simulates POST /admin/register / any src/_seeds/*.ts script / a
    // legacy pre-migration row. Zero new friction proof.
    // ══════════════════════════════════════════════════════════════════
    let discoveryAgentId = "";
    {
      const discoveryAgent = marketplaceRegistry.register({
        name: "Ekte Gårdsbutikk",
        description: "En ekte lokal gårdsbutikk med ferske grønnsaker og egg hver dag.",
        provider: "Ekte Gårdsbutikk",
        contactEmail: "post@ekte-gaardsbutikk.example.test",
        url: "https://ekte-gaardsbutikk.example.test",
        version: "1.0.0",
        role: "producer",
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        skills: [{
          id: "sell-veg", name: "Selger grønnsaker", description: "Selger ferske grønnsaker",
          tags: ["grønnsaker"], inputModes: ["application/json"], outputModes: ["application/json"],
        }],
        categories: [], tags: [], languages: ["no"],
        // NOTE: no `origin` / `isVetted` at all — this is the point.
      } as any);
      discoveryAgentId = discoveryAgent.id;

      const row = testDb.prepare("SELECT origin, is_vetted FROM agents WHERE id = ?").get(discoveryAgentId) as any;
      assertEq(row?.origin, "discovery", "b1: register() with no origin override defaults to 'discovery' (admin/seed callers need zero code change)");
      assertEq(row?.is_vetted, 1, "b2: is_vetted defaults to 1 — vetted immediately, no quarantine (zero new friction for real producers)");

      marketplaceRegistry._agentsCache = null;
      const discoverResults = marketplaceRegistry.discover({ role: "producer", limit: 100, offset: 0 });
      assertTrue(
        discoverResults.some((r: any) => r.agent.id === discoveryAgentId),
        "b3: discovery-origin agent DOES appear in discover() results (unaffected by Gate 1)",
      );

      const slug = slugify("Ekte Gårdsbutikk");
      const rPage = await invokeHandler(produsentHandler, makeReq({ params: { slug } }));
      assertEq(rPage.status, 200, "b4: discovery-origin agent's profile page renders 200 (unaffected by Gate 1)");
      assertTrue(String(rPage.body).includes("Ekte Gårdsbutikk"), "b5: profile page includes the agent's real name");

      const rClaim = await invokeHandler(claimHandler, makeReq({
        params: { id: discoveryAgentId },
        body: { name: "Ekte Eier", email: "eier@ekte-gaardsbutikk.example.test" },
      }));
      assertEq(rClaim.status, 200, "b6: claim request succeeds");
      const claimId = rClaim.body?.data?.claimId;
      const code = rClaim.body?.data?.verificationCode;

      const rVerify = await invokeHandler(claimVerifyHandler, makeReq({
        params: { id: discoveryAgentId },
        body: { claimId, code },
      }));
      assertEq(rVerify.status, 200, "b7: claim verify succeeds — SAME two-step flow, same step count as the self_registered case above");
      assertTrue(!!rVerify.body?.data?.claimToken, "b8: claimToken issued");

      const afterClaim = testDb.prepare("SELECT is_verified FROM agents WHERE id = ?").get(discoveryAgentId) as any;
      assertEq(
        afterClaim?.is_verified, 1,
        "gate2-control: is_verified becomes 1 for a discovery-origin agent, EXACTLY as it does today (proves Gate 2 is origin-specific, not a blanket regression)",
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // (c) ADMIN RELEASE LEVER: self-registered-review-queue / -approve
    // ══════════════════════════════════════════════════════════════════
    {
      // Auth gate — same style as org-nr-review-queue/-approve.
      const rNoKey = await invokeHandler(reviewQueueHandler, makeReq({}));
      assertEq(rNoKey.status, 403, "c1: GET self-registered-review-queue rejects a missing/wrong X-Admin-Key");

      const rQueue = await invokeHandler(reviewQueueHandler, makeReq({
        headers: { "x-admin-key": SUITE_ADMIN_KEY_LOCAL },
      }));
      assertEq(rQueue.status, 200, "c2: GET self-registered-review-queue succeeds with a valid key");
      const queueIds = (rQueue.body?.entries || []).map((e: any) => e.id);
      assertTrue(queueIds.includes(mikhailoId), "c3: queue lists the still-unvetted self_registered agent (Mikhailo)");
      assertTrue(!queueIds.includes(discoveryAgentId), "c4: queue does NOT list the discovery-origin agent (origin filter, not just is_vetted)");
      const mikhailoEntry = (rQueue.body.entries as any[]).find((e) => e.id === mikhailoId);
      assertTrue(
        !!mikhailoEntry && "name" in mikhailoEntry && "contact_email" in mikhailoEntry && "url" in mikhailoEntry && "created_at" in mikhailoEntry,
        "c5: queue entry carries id, name, contact_email, url, created_at",
      );

      // Reject: unknown agent id.
      const rApproveUnknown = await invokeHandler(reviewApproveHandler, makeReq({
        headers: { "x-admin-key": SUITE_ADMIN_KEY_LOCAL },
        body: { agentId: "does-not-exist" },
      }));
      assertEq(rApproveUnknown.status, 404, "c6: approve on an unknown agentId 404s");

      // Reject: a discovery-origin agent is not in this queue at all.
      const rApproveWrongOrigin = await invokeHandler(reviewApproveHandler, makeReq({
        headers: { "x-admin-key": SUITE_ADMIN_KEY_LOCAL },
        body: { agentId: discoveryAgentId },
      }));
      assertEq(rApproveWrongOrigin.status, 409, "c7: approve refuses a non-self_registered agent (confirmation surface, not an arbitrary-write lever)");
      assertEq(pingCalls.length, 0, "c8: no IndexNow ping fired from the two rejected approve attempts above");

      // The real approval.
      pingCalls = [];
      const rApprove = await invokeHandler(reviewApproveHandler, makeReq({
        headers: { "x-admin-key": SUITE_ADMIN_KEY_LOCAL },
        body: { agentId: mikhailoId },
      }));
      assertEq(rApprove.status, 200, "c9: approve succeeds for the queued self_registered agent");
      assertEq(rApprove.body?.isVetted, true, "c10: response reports isVetted:true");

      const rowAfter = testDb.prepare("SELECT is_vetted, is_verified, origin FROM agents WHERE id = ?").get(mikhailoId) as any;
      assertEq(rowAfter?.is_vetted, 1, "gate1-approve: is_vetted flipped to 1 by the approve route");
      assertEq(
        rowAfter?.is_verified, 0,
        "gate2-approve: is_verified is STILL 0 after vetting — visibility approval is NOT ownership evidence (no escape hatch for the badge)",
      );
      assertEq(rowAfter?.origin, "self_registered", "c11: origin is untouched by approval (still self_registered, just no longer quarantined)");

      // Gate 3: the ping fires HERE, exactly once, for the produsent URL.
      assertEq(pingCalls.length, 1, "gate3-approve: pingIndexNow called exactly once by the approve route (would flip to 0 if that call were removed)");
      assertTrue(
        pingCalls[0]?.urls?.[0] === `https://rettfrabonden.com/produsent/${slugify("Mikhailo T")}`
          || pingCalls[0]?.urls?.[0]?.endsWith(`/produsent/${slugify("Mikhailo T")}`),
        `gate3-approve: pinged URL targets /produsent/${slugify("Mikhailo T")} (got: ${JSON.stringify(pingCalls[0]?.urls)})`,
      );
      assertEq(pingCalls[0]?.host, "rettfrabonden.com", "gate3-approve: pinged host is rettfrabonden.com (same convention as the old registration-time ping)");

      // Post-approval: now visible, still never gets the badge.
      marketplaceRegistry._agentsCache = null;
      const discoverAfter = marketplaceRegistry.discover({ role: "producer", limit: 100, offset: 0 });
      assertTrue(
        discoverAfter.some((r: any) => r.agent.id === mikhailoId),
        "c12: Mikhailo now appears in discover() after being vetted",
      );
      const rPageAfter = await invokeHandler(produsentHandler, makeReq({ params: { slug: slugify("Mikhailo T") } }));
      assertEq(rPageAfter.status, 200, "c13: /produsent/mikhailo-t now renders 200 after vetting");

      // Approving twice is a no-op, not an error (idempotent lever).
      const rApproveAgain = await invokeHandler(reviewApproveHandler, makeReq({
        headers: { "x-admin-key": SUITE_ADMIN_KEY_LOCAL },
        body: { agentId: mikhailoId },
      }));
      assertEq(rApproveAgain.status, 200, "c14: re-approving an already-vetted agent is a no-op 200, not an error");
      assertEq(rApproveAgain.body?.alreadyVetted, true, "c15: response flags alreadyVetted:true on the no-op path");
    }
  } catch (err) {
    failed++;
    failures.push(`marketplace-quarantine-gates: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    // Restore the real indexnow-service module (or drop the fake entry if
    // it had never been required before this suite ran) BEFORE dropping
    // admin-agents.ts's own cache entry, so any later suite that requires
    // admin-agents.ts fresh gets the real pingIndexNow again.
    if (originalIndexNowCacheEntry) {
      require.cache[indexNowPath] = originalIndexNowCacheEntry;
    } else {
      delete require.cache[indexNowPath];
    }
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./marketplace")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./admin-agents")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/marketplace-quarantine-gates.test.ts`
if (require.main === module) {
  console.log("── dev-request 2026-08-03-mikhailo-quarantine-gates: marketplace quarantine gates ──");
  runMarketplaceQuarantineGatesTests({ log: true }).then((r) => {
    console.log(`\nmarketplace-quarantine-gates: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
