/**
 * contact-tracking.test.ts — tests for the contact-click intent tracking
 * added 2026-07-03 as slice 1 (work items 1+2) of dev-requests/
 * 2026-07-03-agent-profile-conversations-stats.md:
 *   - POST /api/track/contact-click (trackRouter, mounted at "/api/track")
 *   - GET  /ut/:agentId/:kind        (redirectRouter, mounted at "/ut")
 *
 * Mirrors admin-db-table-sizes.test.ts:
 *   - in-memory better-sqlite3 DB injected via __setDbForTesting +
 *     __initSchemaForTesting (full prod-like schema, including the new
 *     contact_clicks table).
 *   - the previous global db handle is saved/restored so this test never
 *     leaves the module-level singleton swapped for later blocks.
 *   - routers exercised directly (no HTTP server / supertest — this repo's
 *     convention): build a minimal req/res pair and call
 *     `router.handle(req, res, next)`.
 *   - exported runContactTrackingTests({log}) → TestSummary; wired into
 *     tests/test.ts. Standalone: npx tsx src/routes/contact-tracking.test.ts
 *
 * Covers:
 *   (a) POST happy path: valid agentId + kind -> 204, row recorded with
 *       correct agent_id/kind/is_bot=0 for a normal browser UA
 *   (b) POST bot UA -> row recorded with is_bot=1
 *   (c) POST invalid kind ("banana") -> 400, no row written
 *   (d) POST missing agentId -> 400, no row written
 *   (e) POST unknown agentId -> 404, no row written
 *   (f) POST kind="external:facebook" -> 204, row recorded
 *   (g) POST kind containing a URL-like payload -> 400 (never accepted,
 *       proves the beacon can't be used to stuff arbitrary strings in as
 *       "kind" beyond the closed enum)
 *   (h) GET /ut/:agentId/website -> 302 to the agent's stored website,
 *       AND a contact_clicks row is recorded for the click
 *   (i) GET /ut/:agentId/external:facebook -> 302 to the matching
 *       external_links entry
 *   (j) GET /ut/:agentId/external:instagram (no such link stored) -> 404,
 *       no redirect, no row recorded
 *   (k) GET /ut/:unknownAgent/website -> 404
 *   (l) GET /ut/:agentId/email -> 400 (email/phone are not valid redirect
 *       kinds — no URL to resolve them to)
 *   (m) OPEN-REDIRECT GUARD: a query string appended to the request
 *       (?to=https://evil.example) is completely ignored — the redirect
 *       target is still the agent's own stored website, proving the
 *       target is resolved server-side from agent_knowledge only, never
 *       from anything caller-supplied
 *   (n) OPEN-REDIRECT GUARD: a malformed stored website ("javascript:...")
 *       is rejected (404), never handed to res.redirect()
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
  redirectedTo?: string;
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
): Promise<RouteResult> {
  return new Promise((resolve) => {
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
      redirect(codeOrUrl: number | string, maybeUrl?: string) {
        const code = typeof codeOrUrl === "number" ? codeOrUrl : 302;
        const url = typeof codeOrUrl === "string" ? codeOrUrl : maybeUrl!;
        resolve({ status: code, body: undefined, redirectedTo: url, ended: true });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) {
        resolve({ status: 500, body: { error: String(err) }, ended: true });
      } else {
        // No route matched — resolve with a sentinel so callers can assert
        // "this path/kind combination doesn't even route".
        resolve({ status: 0, body: undefined, ended: false });
      }
    });
  });
}

export function runContactTrackingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const db = new Database(":memory:");

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      // ── Fixtures ─────────────────────────────────────────────
      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://example.com', 'producer', ?, 1)`,
      );
      insertAgent.run("agent-1", "Test Gård 1", "key-1");
      insertAgent.run("agent-2", "Test Gård 2 (no knowledge row)", "key-2");

      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website, external_links)
         VALUES (?, ?, ?)`,
      ).run(
        "agent-1",
        "https://example-farm.no",
        JSON.stringify([
          { label: "Facebook", url: "https://facebook.com/examplefarm", type: "facebook" },
        ]),
      );

      // agent-3: has a knowledge row but a malformed/unsafe stored "website"
      // (simulates corrupted legacy data) — must never reach res.redirect().
      insertAgent.run("agent-3", "Test Gård 3 (malformed website)", "key-3");
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, website) VALUES (?, ?)`,
      ).run("agent-3", "javascript:alert(1)");

      // Fresh require for a clean handler binding.
      delete require.cache[require.resolve("./contact-tracking")];
      const mod = require("./contact-tracking");
      const trackRouter = mod.default;
      const redirectRouter = mod.redirectRouter;

      function clickCount(agentId: string, kind: string): number {
        return (
          db
            .prepare("SELECT COUNT(*) as c FROM contact_clicks WHERE agent_id = ? AND kind = ?")
            .get(agentId, kind) as any
        ).c;
      }
      function totalClicks(): number {
        return (db.prepare("SELECT COUNT(*) as c FROM contact_clicks").get() as any).c;
      }

      const BROWSER_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
      const BOT_UA = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://anthropic.com/claudebot)";

      // ── (a) POST happy path ─────────────────────────────────
      const before = totalClicks();
      const okPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BROWSER_UA },
        body: { agentId: "agent-1", kind: "phone" },
      });
      assertEq(okPost.status, 204, "post-happy: valid agentId+kind -> 204");
      assertEq(clickCount("agent-1", "phone"), 1, "post-happy: exactly one 'phone' row recorded for agent-1");
      const recordedRow = db
        .prepare("SELECT is_bot FROM contact_clicks WHERE agent_id = ? AND kind = ?")
        .get("agent-1", "phone") as any;
      assertEq(recordedRow?.is_bot, 0, "post-happy: is_bot=0 for a normal browser UA");
      assertEq(totalClicks(), before + 1, "post-happy: exactly one new row total");

      // ── (b) POST with bot UA -> is_bot=1 ─────────────────────
      const botPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BOT_UA },
        body: { agentId: "agent-1", kind: "email" },
      });
      assertEq(botPost.status, 204, "post-bot: valid request from a bot UA still -> 204 (recorded, not blocked)");
      const botRow = db
        .prepare("SELECT is_bot FROM contact_clicks WHERE agent_id = ? AND kind = ?")
        .get("agent-1", "email") as any;
      assertEq(botRow?.is_bot, 1, "post-bot: is_bot=1 for a known bot UA (ClaudeBot)");

      // ── (c) POST invalid kind ────────────────────────────────
      const beforeInvalidKind = totalClicks();
      const invalidKindPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BROWSER_UA },
        body: { agentId: "agent-1", kind: "banana" },
      });
      assertEq(invalidKindPost.status, 400, "post-invalid-kind: unrecognized kind -> 400");
      assertEq(totalClicks(), beforeInvalidKind, "post-invalid-kind: no row written");

      // ── (d) POST missing agentId ─────────────────────────────
      const missingAgentPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BROWSER_UA },
        body: { kind: "phone" },
      });
      assertEq(missingAgentPost.status, 400, "post-missing-agent: missing agentId -> 400");

      // ── (e) POST unknown agentId ──────────────────────────────
      const beforeUnknownAgent = totalClicks();
      const unknownAgentPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BROWSER_UA },
        body: { agentId: "no-such-agent", kind: "phone" },
      });
      assertEq(unknownAgentPost.status, 404, "post-unknown-agent: nonexistent agentId -> 404");
      assertEq(totalClicks(), beforeUnknownAgent, "post-unknown-agent: no row written");

      // ── (f) POST kind="external:facebook" ────────────────────
      const externalPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BROWSER_UA },
        body: { agentId: "agent-1", kind: "external:facebook" },
      });
      assertEq(externalPost.status, 204, "post-external: kind='external:facebook' -> 204");
      assertEq(clickCount("agent-1", "external:facebook"), 1, "post-external: row recorded with kind='external:facebook'");

      // ── (g) POST kind containing a URL-like payload ──────────
      const beforeUrlKind = totalClicks();
      const urlKindPost = await callRoute(trackRouter, {
        method: "POST",
        url: "/contact-click",
        headers: { "user-agent": BROWSER_UA },
        body: { agentId: "agent-1", kind: "https://evil.example/steal" },
      });
      assertEq(urlKindPost.status, 400, "post-url-kind: a URL-shaped 'kind' value is rejected -> 400");
      assertEq(totalClicks(), beforeUrlKind, "post-url-kind: no row written");

      // ── (h) GET /ut/agent-1/website -> 302 + click recorded ──
      const beforeWebsiteRedirect = clickCount("agent-1", "website");
      const websiteRedirect = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-1/website",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(websiteRedirect.status, 302, "get-website: 302 redirect");
      assertEq(
        websiteRedirect.redirectedTo,
        "https://example-farm.no",
        "get-website: redirects to the agent's own stored website (agent_knowledge.website)",
      );
      assertEq(
        clickCount("agent-1", "website"),
        beforeWebsiteRedirect + 1,
        "get-website: a contact_clicks row was recorded for the redirect",
      );

      // ── (i) GET /ut/agent-1/external:facebook -> 302 ─────────
      const fbRedirect = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-1/external:facebook",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(fbRedirect.status, 302, "get-external: 302 redirect");
      assertEq(
        fbRedirect.redirectedTo,
        "https://facebook.com/examplefarm",
        "get-external: redirects to the matching external_links[].url",
      );

      // ── (j) GET /ut/agent-1/external:instagram (no such link) ─
      const noSuchLink = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-1/external:instagram",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(noSuchLink.status, 404, "get-no-such-link: agent has no 'instagram' external link -> 404");
      assertTrue(!noSuchLink.redirectedTo, "get-no-such-link: no redirect issued");

      // ── (k) GET /ut/<unknown agent>/website -> 404 ───────────
      const unknownAgentGet = await callRoute(redirectRouter, {
        method: "GET",
        url: "/no-such-agent/website",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(unknownAgentGet.status, 404, "get-unknown-agent: nonexistent agentId -> 404");

      // ── (l) GET /ut/agent-1/email -> 400 (not a redirect kind) ─
      const emailKindGet = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-1/email",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(emailKindGet.status, 400, "get-email-kind: 'email' is not a valid redirect kind -> 400");

      // ── (m) OPEN-REDIRECT GUARD: caller-supplied query is ignored ──
      const withEvilQuery = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-1/website?to=https://evil.example&redirect=https://evil.example",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(withEvilQuery.status, 302, "open-redirect-guard: still 302s");
      assertEq(
        withEvilQuery.redirectedTo,
        "https://example-farm.no",
        "open-redirect-guard: query string is completely ignored — target is still the agent's own stored website",
      );

      // ── (n) OPEN-REDIRECT GUARD: malformed stored website rejected ─
      const malformedWebsite = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-3/website",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(
        malformedWebsite.status,
        404,
        "open-redirect-guard: a non-http(s) stored website ('javascript:...') is rejected, not redirected",
      );
      assertTrue(!malformedWebsite.redirectedTo, "open-redirect-guard: no redirect issued for malformed stored URL");

      // ── Bonus: agent-2 has no agent_knowledge row at all -> 404 ──
      const noKnowledgeRow = await callRoute(redirectRouter, {
        method: "GET",
        url: "/agent-2/website",
        headers: { "user-agent": BROWSER_UA },
      });
      assertEq(noKnowledgeRow.status, 404, "no-knowledge-row: agent exists but has no agent_knowledge row -> 404");
    } finally {
      initMod.__setDbForTesting(prevDb);
      db.close();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/contact-tracking.test.ts`
if (require.main === module) {
  runContactTrackingTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
