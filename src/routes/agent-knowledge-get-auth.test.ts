/**
 * agent-knowledge-get-auth.test.ts — tests the auth gate added 2026-07-05 to
 * GET /agents/:id/knowledge (dev-request secure-agent-knowledge-endpoint).
 *
 * Root cause: GET /agents/:id/knowledge had NO auth check and returned the
 * raw agent_knowledge row (including `email`, since lokal#143 backfilled
 * it) while its sibling PUT already required X-Admin-Key/X-Claim-Token/
 * X-API-Key. Consumer audit (grepped the repo for HTTP callers of this
 * exact GET route) found: (a) the seller dashboard (selger.html) never
 * calls this route unauthenticated — only PUT with X-Claim-Token; (b) the
 * one caller doing an unauthenticated GET was the scheduled
 * lokal-agent-enrichment SKILL script, which already holds ADMIN_KEY for
 * its sibling PUT calls in the same doc and was simply omitting the header
 * on the GET (now fixed in that doc too). No legitimate caller needs this
 * route to stay open, so the remedy is auth-gating (preference (a) in the
 * spec), mirroring PUT /agents/:id/knowledge exactly.
 *
 * Mirrors homepage-provenance-email-backfill.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema).
 *   - the previous global db handle is saved/restored.
 *   - the router is exercised directly (router.handle(req, res, next)),
 *     no HTTP server / supertest.
 *   - exported runAgentKnowledgeGetAuthTests({log}) -> TestSummary; wired
 *     into tests/test.ts.
 *     Standalone: npx tsx src/routes/agent-knowledge-get-auth.test.ts
 *
 * 2026-07-05 CI fix (10 auth-path assertions failing on GH Actions, passing
 * locally): even though this block is chained off
 * _homepageProvenanceEmailBackfillPromise (serializing it against every
 * OTHER chain-coordinated block that also swaps the shared getDb()
 * singleton), tests/test.ts's `orch-pr-20260704: tasks-prune-async` block
 * (near the end of the file) is a bare fire-and-forget top-level IIFE that
 * is NOT part of that coordination chain at all — by its own comment it
 * relies on finishing "well before process.exit" rather than being awaited.
 * It repeatedly calls initMod.__setDbForTesting(tpaDb) inside its req()
 * retry loop while doing REAL async I/O (HTTP round trips, job polling via
 * setTimeout/setImmediate), so its execution window's timing depends on
 * real wall-clock scheduling that differs between a local machine and a
 * GitHub Actions runner. Reproduced by timestamping every
 * __setDbForTesting call across both blocks: locally tasks-prune-async
 * reliably finishes ~7s before this block starts (comfortable margin), but
 * nothing GUARANTEES that margin — on a slower/loaded CI runner it can
 * shrink to zero, in which case this block's ENTIRE run (all 21
 * assertions) executes while the global db is pinned to tpaDb (which has
 * no agent-a/agent-b), producing exactly the observed 404/403/undefined
 * results for the authenticated-path assertions (matches the CI failure
 * log) while auth-only checks (which don't depend on the DB row existing)
 * still passed.
 *
 * Fix: callRoute() re-pins initMod.__setDbForTesting(db) synchronously,
 * immediately before every router.handle() call (mirroring the identical
 * defensive re-pin-before-every-request pattern tasks-prune-async's own
 * req() helper already uses for this exact class of hazard). Since
 * router.handle() for this route is fully synchronous end-to-end (no
 * await between the re-pin and res.json()/res.end()), nothing else in the
 * single-threaded event loop can interleave a competing
 * __setDbForTesting() call between the re-pin and the route reading the
 * db — this holds regardless of what any other suite does concurrently,
 * so it isn't just a smaller chance of the same race.
 *
 * Covers:
 *   (1) unauthenticated GET -> 403, no data leaked at all (not even a
 *       redacted/partial body — this route is now fully auth-gated).
 *   (2) wrong X-Admin-Key -> 403.
 *   (3) valid X-Admin-Key -> 200, full payload including raw email/phone
 *       (unchanged from pre-fix shape for authorized callers).
 *   (4) valid X-Claim-Token for THIS agent -> 200, full payload.
 *   (5) valid X-Claim-Token for a DIFFERENT agent -> 403 (token/agent
 *       mismatch must still be enforced, not just "any token").
 *   (6) valid X-API-Key for THIS agent -> 200, full payload.
 *   (7) unknown agent id with a valid admin key -> 404 (unchanged 404
 *       behavior, auth check happens before the lookup so a stray agent-id
 *       guess doesn't get a different status without a key).
 *   (8) sibling PUT /agents/:id/knowledge behavior is unchanged (still
 *       enforces its own pre-existing auth the same way) — regression
 *       guard so this change didn't accidentally touch the PUT handler.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  },
  rePin?: () => void,
): Promise<RouteResult> {
  return new Promise((resolve) => {
    // Re-pin the global db/env singletons synchronously, right here, right
    // before building the request — see the "2026-07-05 CI fix" note atop
    // this file. Nothing can interleave between this call and
    // router.handle() below (no await in between), so this closes the
    // cross-suite race regardless of what any other unchained test block
    // does concurrently.
    if (rePin) rePin();
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runAgentKnowledgeGetAuthTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const prevDb = initMod.getDb();
    const testAdminKey = "agent-knowledge-get-auth-test-admin-key";
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = testAdminKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ── Seed two agents with contact data on agent_knowledge ──
      // Globally-unique fixture IDs (2026-07-06 CI-fix, Option B, Daniel-approved
      // interim mitigation per protocols/orchestrator-failures/2026-07-06-ci-test-harness-4th-attempt-failed.md):
      // generic literals like "agent-a"/"agent-b" are reused as fixture names across
      // several files in this suite, so if an untracked chain elsewhere in tests/test.ts
      // ever touches "an agent" by one of those common names, it can collide with this
      // block's own rows. A run-unique suffix makes that collision impossible without
      // requiring this file to track down every other suite's fixture usage.
      const fixtureSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const AGENT_A = `agent-test-a-${fixtureSuffix}`;
      const AGENT_B = `agent-test-b-${fixtureSuffix}`;
      const CLAIM_A = `claim-test-a-${fixtureSuffix}`;
      const CLAIM_TOKEN_A = `claim-token-test-a-${fixtureSuffix}`;
      const API_KEY_A = `api-key-test-a-${fixtureSuffix}`;
      const API_KEY_B = `api-key-test-b-${fixtureSuffix}`;

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      insertAgent.run(AGENT_A, "Gard A AS", "https://garda.no", API_KEY_A);
      insertAgent.run(AGENT_B, "Gard B AS", "https://gardb.no", API_KEY_B);

      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, postal_code, about, field_provenance)
         VALUES (?, ?, ?, ?, ?, ?, 'A test farm shop', '{}')`,
      );
      insertKnowledge.run(AGENT_A, "https://garda.no", "post@garda.no", "+4791234567", "Gardsveien 1", "1234");
      insertKnowledge.run(AGENT_B, "https://gardb.no", "post@gardb.no", "+4799887766", "Gardsveien 2", "5678");

      // ── Seed a verified claim for agent-a ──
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
         VALUES (?, ?, 'Eier A', 'eier-a@example.com', 'verified', ?,
                 datetime('now', '+30 days'))`,
      ).run(CLAIM_A, AGENT_A, CLAIM_TOKEN_A);

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      // Re-pin both globals this suite depends on (db + ADMIN_KEY) right
      // before every single route call below — see the "2026-07-05 CI fix"
      // note atop this file.
      const rePin = () => {
        initMod.__setDbForTesting(db as any);
        process.env.ADMIN_KEY = testAdminKey;
        delete process.env.ANALYTICS_ADMIN_KEY;
      };

      // ── (1) unauthenticated GET -> 403, no data leaked ──
      {
        const r = await callRoute(router, { method: "GET", url: `/agents/${AGENT_A}/knowledge` }, rePin);
        assertEq(r.status, 403, "unauthenticated GET /agents/:id/knowledge -> 403");
        assertEq(r.body?.success, false, "unauthenticated GET -> success:false");
        assertTrue(
          !r.body || r.body.data === undefined,
          "unauthenticated GET response body has no `data` field at all (nothing leaked)",
        );
        const asString = JSON.stringify(r.body || {});
        assertTrue(!asString.includes("post@garda.no"), "unauthenticated GET response never contains the agent's email");
        assertTrue(!asString.includes("+4791234567"), "unauthenticated GET response never contains the agent's phone");
      }

      // ── (2) wrong X-Admin-Key -> 403 ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: `/agents/${AGENT_A}/knowledge`,
          headers: { "x-admin-key": "totally-wrong-key" },
        }, rePin);
        assertEq(r.status, 403, "GET with wrong X-Admin-Key -> 403");
      }

      // ── (3) valid X-Admin-Key -> 200, full payload unchanged ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: `/agents/${AGENT_A}/knowledge`,
          headers: { "x-admin-key": testAdminKey },
        }, rePin);
        assertEq(r.status, 200, "GET with valid X-Admin-Key -> 200");
        assertEq(r.body?.success, true, "authenticated GET -> success:true");
        assertEq(r.body?.data?.email, "post@garda.no", "authenticated GET (admin key) returns full email");
        assertEq(r.body?.data?.phone, "+4791234567", "authenticated GET (admin key) returns full phone");
        assertEq(r.body?.data?.address, "Gardsveien 1", "authenticated GET (admin key) returns address");
      }

      // ── (4) valid X-Claim-Token for THIS agent -> 200, full payload ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: `/agents/${AGENT_A}/knowledge`,
          headers: { "x-claim-token": CLAIM_TOKEN_A },
        }, rePin);
        assertEq(r.status, 200, "GET with valid X-Claim-Token (own agent) -> 200");
        assertEq(r.body?.data?.email, "post@garda.no", "authenticated GET (claim token) returns full email");
      }

      // ── (5) valid X-Claim-Token but for a DIFFERENT agent -> 403 ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: `/agents/${AGENT_B}/knowledge`,
          headers: { "x-claim-token": CLAIM_TOKEN_A },
        }, rePin);
        assertEq(r.status, 403, "GET with claim token belonging to a different agent -> 403 (not just any valid token)");
      }

      // ── (6) valid X-API-Key for THIS agent -> 200, full payload ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: `/agents/${AGENT_B}/knowledge`,
          headers: { "x-api-key": API_KEY_B },
        }, rePin);
        assertEq(r.status, 200, "GET with valid X-API-Key (own agent) -> 200");
        assertEq(r.body?.data?.email, "post@gardb.no", "authenticated GET (api key) returns full email");
      }

      // ── (6b) API key belonging to a different agent -> 403 ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: `/agents/${AGENT_A}/knowledge`,
          headers: { "x-api-key": API_KEY_B },
        }, rePin);
        assertEq(r.status, 403, "GET with API key belonging to a different agent -> 403");
      }

      // ── (7) unknown agent id, valid admin key -> 404 (unchanged) ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: "/agents/does-not-exist/knowledge",
          headers: { "x-admin-key": testAdminKey },
        }, rePin);
        assertEq(r.status, 404, "authenticated GET for unknown agent id -> 404");
      }

      // ── (7b) unknown agent id, NO auth -> 403, not 404 (auth checked first) ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: "/agents/does-not-exist/knowledge",
        }, rePin);
        assertEq(r.status, 403, "unauthenticated GET for unknown agent id still -> 403 (auth precedes existence check)");
      }

      // ── (8) sibling PUT /agents/:id/knowledge auth is unchanged ──
      {
        const rNoAuth = await callRoute(router, {
          method: "PUT",
          url: `/agents/${AGENT_A}/knowledge`,
          body: { about: "should not apply" },
        }, rePin);
        assertEq(rNoAuth.status, 403, "PUT /agents/:id/knowledge without auth still -> 403 (regression guard, untouched by this fix)");

        const rAuth = await callRoute(router, {
          method: "PUT",
          url: `/agents/${AGENT_A}/knowledge`,
          headers: { "x-admin-key": testAdminKey },
          body: { about: "Updated via admin" },
        }, rePin);
        assertEq(rAuth.status, 200, "PUT /agents/:id/knowledge with valid admin key still -> 200 (unchanged)");
      }
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAgentKnowledgeGetAuthTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
