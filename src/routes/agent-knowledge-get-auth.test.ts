/**
 * agent-knowledge-get-auth.test.ts — tests the auth gate added 2026-07-05 to
 * GET /agents/:id/knowledge (dev-request secure-agent-knowledge-endpoint).
 *
 * DEBUG INSTRUMENTATION (2026-07-06, throwaway diagnostic branch, dev-request
 * ci-test-harness-gh-actions-only-failure): dumps DB identity + row counts +
 * env right before the failing assertions, per the dev-request's "instrument,
 * don't guess" directive. Remove before merge — this branch is diagnosis-only.
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

    // ── DEBUG (2026-07-06) — env + better-sqlite3 diagnostics, once ──
    console.log(
      `[DEBUG-CI] CI=${process.env.CI} NODE_ENV=${process.env.NODE_ENV} ` +
      `platform=${process.platform} node=${process.version}`,
    );
    try {
      const bsq = require("better-sqlite3/package.json");
      console.log(`[DEBUG-CI] better-sqlite3 version=${bsq.version}`);
    } catch (e) {
      console.log(`[DEBUG-CI] better-sqlite3 version lookup failed: ${e}`);
    }

    const db = new Database(":memory:");
    (db as any).__debugTag = `debug-db-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    console.log(`[DEBUG-CI] created test db tag=${(db as any).__debugTag}`);

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ── Seed two agents with contact data on agent_knowledge ──
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', ?, 'producer', ?)`,
      );
      insertAgent.run("agent-a", "Gard A AS", "https://garda.no", "api-key-a");
      insertAgent.run("agent-b", "Gard B AS", "https://gardb.no", "api-key-b");

      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, email, phone, address, postal_code, about, field_provenance)
         VALUES (?, ?, ?, ?, ?, ?, 'A test farm shop', '{}')`,
      );
      insertKnowledge.run("agent-a", "https://garda.no", "post@garda.no", "+4791234567", "Gardsveien 1", "1234");
      insertKnowledge.run("agent-b", "https://gardb.no", "post@gardb.no", "+4799887766", "Gardsveien 2", "5678");

      // ── DEBUG — confirm the seed actually landed on THIS db object ──
      const seedCount = (db.prepare("SELECT COUNT(*) c FROM agent_knowledge").get() as any).c;
      const seedAgentCount = (db.prepare("SELECT COUNT(*) c FROM agents").get() as any).c;
      console.log(
        `[DEBUG-CI] tag=${(db as any).__debugTag} post-seed agent_knowledge.count=${seedCount} agents.count=${seedAgentCount} ` +
        `getDb()===db? ${initMod.getDb() === db}`,
      );

      // ── Seed a verified claim for agent-a ──
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, claim_token, claim_token_expires_at)
         VALUES ('claim-a', 'agent-a', 'Eier A', 'eier-a@example.com', 'verified', 'claim-token-a',
                 datetime('now', '+30 days'))`,
      ).run();

      // Fresh require so the router picks up the just-injected db.
      delete require.cache[require.resolve("./marketplace")];
      const marketplaceMod = require("./marketplace");
      const router = marketplaceMod.default;

      const rePin = () => {
        initMod.__setDbForTesting(db as any);
        process.env.ADMIN_KEY = testAdminKey;
        delete process.env.ANALYTICS_ADMIN_KEY;
      };

      // ── (1) unauthenticated GET -> 403, no data leaked ──
      {
        const r = await callRoute(router, { method: "GET", url: "/agents/agent-a/knowledge" }, rePin);
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
          url: "/agents/agent-a/knowledge",
          headers: { "x-admin-key": "totally-wrong-key" },
        }, rePin);
        assertEq(r.status, 403, "GET with wrong X-Admin-Key -> 403");
      }

      // ── (3) valid X-Admin-Key -> 200, full payload unchanged ──
      {
        // ── DEBUG — right before the historically-failing call ──
        const preCount = (db.prepare("SELECT COUNT(*) c FROM agent_knowledge WHERE agent_id='agent-a'").get() as any).c;
        const liveDb = initMod.getDb();
        console.log(
          `[DEBUG-CI] tag=${(db as any).__debugTag} pre-call(3) agent-a row present=${preCount} ` +
          `getDb()===testDb? ${liveDb === db} ADMIN_KEY=${process.env.ADMIN_KEY === testAdminKey ? "match" : process.env.ADMIN_KEY}`,
        );

        const r = await callRoute(router, {
          method: "GET",
          url: "/agents/agent-a/knowledge",
          headers: { "x-admin-key": testAdminKey },
        }, rePin);

        // ── DEBUG — right after, re-check identity/state ──
        const postDb = initMod.getDb();
        console.log(
          `[DEBUG-CI] tag=${(db as any).__debugTag} post-call(3) status=${r.status} getDb()===testDb? ${postDb === db} ` +
          `body=${JSON.stringify(r.body)}`,
        );

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
          url: "/agents/agent-a/knowledge",
          headers: { "x-claim-token": "claim-token-a" },
        }, rePin);
        assertEq(r.status, 200, "GET with valid X-Claim-Token (own agent) -> 200");
        assertEq(r.body?.data?.email, "post@garda.no", "authenticated GET (claim token) returns full email");
      }

      // ── (5) valid X-Claim-Token but for a DIFFERENT agent -> 403 ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: "/agents/agent-b/knowledge",
          headers: { "x-claim-token": "claim-token-a" },
        }, rePin);
        assertEq(r.status, 403, "GET with claim token belonging to a different agent -> 403 (not just any valid token)");
      }

      // ── (6) valid X-API-Key for THIS agent -> 200, full payload ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: "/agents/agent-b/knowledge",
          headers: { "x-api-key": "api-key-b" },
        }, rePin);
        assertEq(r.status, 200, "GET with valid X-API-Key (own agent) -> 200");
        assertEq(r.body?.data?.email, "post@gardb.no", "authenticated GET (api key) returns full email");
      }

      // ── (6b) API key belonging to a different agent -> 403 ──
      {
        const r = await callRoute(router, {
          method: "GET",
          url: "/agents/agent-a/knowledge",
          headers: { "x-api-key": "api-key-b" },
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
          url: "/agents/agent-a/knowledge",
          body: { about: "should not apply" },
        }, rePin);
        assertEq(rNoAuth.status, 403, "PUT /agents/:id/knowledge without auth still -> 403 (regression guard, untouched by this fix)");

        const rAuth = await callRoute(router, {
          method: "PUT",
          url: "/agents/agent-a/knowledge",
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
