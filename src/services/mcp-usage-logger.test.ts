/**
 * mcp-usage-logger.test.ts — unit tests for src/services/mcp-usage-logger.ts
 * (dev-request 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens,
 * Slice B) and its consumer, GET /admin/analytics/mcp-usage
 * (src/routes/analytics.ts).
 *
 * Setup mirrors admin-run-verifier-drain-observability.test.ts: an
 * in-memory DB running the REAL production schema via
 * __setDbForTesting/__initSchemaForTesting (so `analytics_mcp_calls` is
 * exactly the table that ships), fresh `require()` of the modules under
 * test after DB injection, exercised via a hand-rolled req/res (no
 * supertest, no network calls).
 *
 * Covers (per the build spec / acceptance B1):
 *   1. tools/call logs tool_name = params.name (not the raw "tools/call" method).
 *   2. A non-tools/call method (e.g. "initialize") logs tool_name = method,
 *      and captures clientInfo.name/version when present.
 *   3. A later tools/call in the "same session" (no clientInfo on that
 *      request) falls back to a UA-derived client_name.
 *   4. A batched (array) JSON-RPC body logs one row per request entry.
 *   5. GET requests to the same path are never logged (protocol only
 *      instruments POST).
 *   6. A body with no `method` (malformed/non-RPC POST) logs nothing and
 *      never throws.
 *   7. The downstream handler's response is untouched — logging runs on
 *      res.on("finish"), strictly after the real response is sent.
 *   8. agentCardUsageLogger logs protocol='agent_card' with no tool_name.
 *   9. is_owner is stamped from the existing owner-UA heuristic.
 *   10. GET /admin/analytics/mcp-usage aggregates byProtocol/byTool/byClient/byVertical,
 *       respects ?vertical=, respects ?hours= (excludes older rows), and
 *       excludes owner traffic (existing NOT_OWNER convention).
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ─── Minimal fake Express req/res ────────────────────────────────
// res is an ad-hoc EventEmitter: emit("finish") is called synchronously by
// json()/send()/end(), exactly mirroring how Express fires the real
// "finish" event once headers+body are flushed — good enough to prove the
// logger only runs after (never instead of, never blocking) the real
// response.

function makeReq(opts: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  ip?: string;
}) {
  const headers = opts.headers || {};
  return {
    method: opts.method || "POST",
    body: opts.body,
    query: opts.query || {},
    headers,
    ip: opts.ip || "203.0.113.1",
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as any;
}

function makeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res: any = {
    statusCode: 200,
    sentBody: undefined as any,
    ended: false,
    on(event: string, cb: () => void) {
      (listeners[event] ||= []).push(cb);
      return res;
    },
    header() {
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    _finish() {
      (listeners.finish || []).forEach((cb) => cb());
    },
    json(payload: any) {
      res.sentBody = payload;
      res.ended = true;
      res._finish();
      return res;
    },
    send(data: any) {
      res.sentBody = data;
      res.ended = true;
      res._finish();
      return res;
    },
    end() {
      res.ended = true;
      res._finish();
      return res;
    },
  };
  return res;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; query?: Record<string, string> },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path: opts.url.split("?")[0],
      query: opts.query || {},
      headers,
      hostname: "rettfrabonden.com",
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
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runMcpUsageLoggerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevDb = initMod.getDb();
    const db = new Database(":memory:");
    try {
      process.env.ANALYTICS_ADMIN_KEY = "test-mcp-usage-key";
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const { mcpUsageLogger, agentCardUsageLogger } = require("./mcp-usage-logger") as
        typeof import("./mcp-usage-logger");

      const countRows = () => (db.prepare(`SELECT COUNT(*) as c FROM analytics_mcp_calls`).get() as { c: number }).c;

      // ── 1. tools/call → tool_name = params.name ──────────────────────
      {
        const mw = mcpUsageLogger("mcp", "rfb");
        const req = makeReq({ body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lokal_search", arguments: {} } } });
        const res = makeRes();
        let nextCalled = false;
        mw(req, res, () => {
          nextCalled = true;
          res.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
        });
        assertTrue(nextCalled, "mcp-1: next() was invoked (downstream handler ran)");
        const row = db.prepare(`SELECT * FROM analytics_mcp_calls ORDER BY id DESC LIMIT 1`).get() as any;
        assertEq(row.protocol, "mcp", "mcp-2: protocol='mcp'");
        assertEq(row.vertical_id, "rfb", "mcp-3: vertical_id='rfb'");
        assertEq(row.tool_name, "lokal_search", "mcp-4: tools/call logs params.name, not the literal method");
      }

      // ── 2. initialize captures clientInfo ─────────────────────────────
      {
        const mw = mcpUsageLogger("mcp", "dental");
        const req = makeReq({
          body: {
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: { clientInfo: { name: "Claude", version: "1.2.3" } },
          },
        });
        const res = makeRes();
        mw(req, res, () => res.json({ result: {} }));
        const row = db.prepare(`SELECT * FROM analytics_mcp_calls ORDER BY id DESC LIMIT 1`).get() as any;
        assertEq(row.tool_name, "initialize", "mcp-5: non-tools/call method logged as tool_name=method");
        assertEq(row.client_name, "Claude", "mcp-6: client_name from initialize.clientInfo.name");
        assertEq(row.client_version, "1.2.3", "mcp-7: client_version from initialize.clientInfo.version");
        assertEq(row.vertical_id, "dental", "mcp-8: vertical_id='dental'");
      }

      // ── 3. later tools/call, no clientInfo → falls back to UA ─────────
      {
        const mw = mcpUsageLogger("mcp", "rfb");
        const req = makeReq({
          body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lokal_discover" } },
          headers: { "user-agent": "ChatGPT-User/1.0" },
        });
        const res = makeRes();
        mw(req, res, () => res.json({ result: {} }));
        const row = db.prepare(`SELECT * FROM analytics_mcp_calls ORDER BY id DESC LIMIT 1`).get() as any;
        assertEq(row.tool_name, "lokal_discover", "mcp-9: tool_name from params.name");
        assertTrue(!!row.client_name, "mcp-10: client_name falls back to a UA-derived value when no clientInfo present");
      }

      // ── 4. batched (array) JSON-RPC body → one row per entry ──────────
      {
        const before = countRows();
        const mw = mcpUsageLogger("a2a", "experiences");
        const req = makeReq({
          body: [
            { jsonrpc: "2.0", id: 4, method: "message/send", params: {} },
            { jsonrpc: "2.0", id: 5, method: "tasks/get", params: {} },
          ],
        });
        const res = makeRes();
        mw(req, res, () => res.json([{ result: {} }, { result: {} }]));
        assertEq(countRows() - before, 2, "mcp-11: a JSON-RPC batch logs one row per request entry");
      }

      // ── 5. GET requests are never logged ──────────────────────────────
      {
        const before = countRows();
        const mw = mcpUsageLogger("mcp", "rfb");
        const req = makeReq({ method: "GET", body: undefined });
        const res = makeRes();
        let nextCalled = false;
        mw(req, res, () => {
          nextCalled = true;
        });
        assertTrue(nextCalled, "mcp-12: GET still calls next() (never blocks the request)");
        assertEq(countRows(), before, "mcp-13: GET requests are never logged");
      }

      // ── 6. malformed body (no method) → no row, never throws ──────────
      {
        const before = countRows();
        const mw = mcpUsageLogger("mcp", "rfb");
        const req = makeReq({ body: { not: "jsonrpc" } });
        const res = makeRes();
        let threw = false;
        try {
          mw(req, res, () => res.json({}));
        } catch {
          threw = true;
        }
        assertTrue(!threw, "mcp-14: a malformed/non-RPC body never throws");
        assertEq(countRows(), before, "mcp-15: a malformed/non-RPC body logs nothing");
      }

      // ── 7. downstream response is byte-identical / untouched ─────────
      {
        const mw = mcpUsageLogger("mcp", "rfb");
        const req = makeReq({ body: { jsonrpc: "2.0", id: 7, method: "tools/list" } });
        const res = makeRes();
        const payload = { jsonrpc: "2.0", id: 7, result: { tools: ["a", "b"] } };
        mw(req, res, () => res.json(payload));
        assertEq(res.sentBody, payload, "mcp-16: the real handler's response payload is never mutated by the logger");
      }

      // ── 8. agentCardUsageLogger ────────────────────────────────────────
      {
        const before = countRows();
        const mw = agentCardUsageLogger("experiences");
        const req = makeReq({ method: "GET", headers: { "user-agent": "Claude-User/1.0" } });
        const res = makeRes();
        let nextCalled = false;
        mw(req, res, () => {
          nextCalled = true;
          res.json({ name: "card" });
        });
        assertTrue(nextCalled, "mcp-17: agentCardUsageLogger calls next()");
        assertEq(countRows() - before, 1, "mcp-18: one row logged for the agent-card fetch");
        const row = db.prepare(`SELECT * FROM analytics_mcp_calls ORDER BY id DESC LIMIT 1`).get() as any;
        assertEq(row.protocol, "agent_card", "mcp-19: protocol='agent_card'");
        assertEq(row.tool_name, null, "mcp-20: agent_card rows have no tool_name");
        assertEq(row.vertical_id, "experiences", "mcp-21: vertical_id='experiences'");
      }

      // ── 9. is_owner stamped from the existing owner-UA heuristic ─────
      {
        const mw = mcpUsageLogger("mcp", "rfb");
        const req = makeReq({
          body: { jsonrpc: "2.0", id: 9, method: "tools/list" },
          headers: { "user-agent": "curl/8.0" }, // matches OWNER_UA_MARKERS_LC
        });
        const res = makeRes();
        mw(req, res, () => res.json({}));
        const row = db.prepare(`SELECT * FROM analytics_mcp_calls ORDER BY id DESC LIMIT 1`).get() as any;
        assertEq(row.is_owner, 1, "mcp-22: a known owner UA is stamped is_owner=1");
      }

      // ── 10. GET /admin/analytics/mcp-usage aggregation ────────────────
      {
        db.exec(`DELETE FROM analytics_mcp_calls`);
        const insert = db.prepare(`
          INSERT INTO analytics_mcp_calls
            (protocol, vertical_id, tool_name, client_name, client_version, user_agent, ip_hash, duration_ms, is_owner, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        // Computed relative to the real wall clock (matching how the route's
        // own `cutoff = Date.now() - hours*3600*1000` works) rather than a
        // fixed date literal — a hardcoded past date silently drifts outside
        // the default 24h window as real time passes, making this fixture
        // (and every assertion depending on it) fail on any day but the one
        // it was written on. 1h-ago is safely inside a 24h window; 30h-ago
        // is safely outside it, regardless of what day the suite runs.
        const sqliteDatetime = (date: Date): string => date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
        const now = sqliteDatetime(new Date(Date.now() - 60 * 60 * 1000));
        const old = sqliteDatetime(new Date(Date.now() - 30 * 60 * 60 * 1000)); // > 24h before `now`
        insert.run("mcp", "rfb", "lokal_search", "ChatGPT", "1.0", "ChatGPT-User/1.0", "h1", 12, 0, now);
        insert.run("mcp", "rfb", "lokal_search", "ChatGPT", "1.0", "ChatGPT-User/1.0", "h1", 8, 0, now);
        insert.run("mcp", "dental", "lokal_discover", "Claude", "2.0", "Claude-User/1.0", "h2", 20, 0, now);
        insert.run("agent_card", "rfb", null, "Perplexity", null, "Perplexity-User/1.0", "h3", 5, 0, now);
        insert.run("mcp", "rfb", "lokal_search", "curl", null, "curl/8.0", "h4", 3, 1, now); // owner — excluded
        insert.run("mcp", "rfb", "lokal_search", "ChatGPT", "1.0", "ChatGPT-User/1.0", "h1", 9, 0, old); // outside 24h window

        const { default: router } = require("../routes/analytics") as { default: any };

        const all24h = await callRoute(router, {
          url: "/mcp-usage",
          query: { hours: "24" },
          headers: { "x-admin-key": "test-mcp-usage-key" },
        });
        assertEq(all24h.status, 200, "mcp-23: GET /admin/analytics/mcp-usage → 200");
        assertEq(all24h.body.totalCalls, 4, "mcp-24: totalCalls excludes owner traffic and the >24h-old row");
        const mcpProto = all24h.body.byProtocol.find((p: any) => p.protocol === "mcp");
        assertEq(mcpProto.calls, 3, "mcp-25: byProtocol counts the 3 non-owner, in-window mcp rows");
        const searchTool = all24h.body.byTool.find((t: any) => t.tool_name === "lokal_search");
        assertEq(searchTool.calls, 2, "mcp-26: byTool sums lokal_search calls (owner row excluded)");
        const chatgptClient = all24h.body.byClient.find((c: any) => c.client_name === "ChatGPT");
        assertEq(chatgptClient.calls, 2, "mcp-27: byClient sums per client_name");

        const dentalOnly = await callRoute(router, {
          url: "/mcp-usage",
          query: { hours: "24", vertical: "dental" },
          headers: { "x-admin-key": "test-mcp-usage-key" },
        });
        assertEq(dentalOnly.body.totalCalls, 1, "mcp-28: ?vertical=dental scopes the aggregation");

        const noKey = await callRoute(router, { url: "/mcp-usage", query: { hours: "24" } });
        assertEq(noKey.status, 401, "mcp-29: missing X-Admin-Key → 401 (requireAdminAuth applies to this route)");
      }
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAdminKey;
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMcpUsageLoggerTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
