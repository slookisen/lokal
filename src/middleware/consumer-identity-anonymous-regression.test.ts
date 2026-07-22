/**
 * consumer-identity-anonymous-regression.test.ts — the regression-critical
 * proof for dev-request 2026-07-13-agent-identity-usage-ledger, slice 1.
 *
 * Acceptance criterion 1: "a new test file proving byte-identical responses,
 * headers, and rate-limit behavior for anonymous callers ... across a
 * representative sample of MCP/A2A/REST endpoints ... before vs after this
 * change (i.e. these tests must FAIL if the fallthrough path is ever
 * broken)."
 *
 * For each representative endpoint below we run the exact same request
 * through three scenarios and assert the captured {status, headers, body}
 * is byte-identical (deep-equal) across all three:
 *
 *   (a) "before"        — the route handler alone, consumerIdentity not in
 *                         the middleware chain at all (what every one of
 *                         these routes did prior to this dev-request).
 *   (b) "after, no key" — consumerIdentity(req,res,next) runs first, no
 *                         X-API-Key header present.
 *   (c) "after, bad key"— consumerIdentity(req,res,next) runs first, an
 *                         unknown/invalid X-API-Key header IS present.
 *
 * (b) and (c) must match (a) exactly. If consumerIdentity's fallthrough path
 * ever starts mutating the request, delaying the response, or (for an
 * invalid key) erroring instead of falling through, this file fails.
 *
 * Rate-limit differentiation itself (keyed callers getting a HIGHER
 * ceiling) is intentionally NOT this file's job — that needs a real
 * HTTP server and is covered by
 * middleware/consumer-identity-rate-limit.test.ts. This file only proves
 * the anonymous/invalid-key path is untouched.
 */

import Database from "better-sqlite3";
import { Request, Response, NextFunction } from "express";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";
import { consumerIdentity } from "./consumer-identity";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedResult {
  status: number;
  headers: Record<string, string>;
  body: any;
}

// Same fake-req/res convention used across this codebase's route tests
// (e.g. admin-blocklist-manual-entry.test.ts's callRouteSync), extended
// with `.header()` (consumerIdentity calls req.header(), not req.get())
// and a header-capturing `.set()`/`.setHeader()`/`.on()` so "same headers"
// is actually checked, not just assumed.
function makeReqRes(opts: {
  method?: string;
  url: string;
  body?: any;
  headers?: Record<string, string>;
}): { req: any; res: any; getResult: () => CapturedResult } {
  const headers = opts.headers || {};
  const req: any = {
    method: opts.method || "GET",
    url: opts.url,
    path: opts.url.split("?")[0],
    query: {},
    headers,
    body: opts.body,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  };
  let captured: CapturedResult = { status: 200, headers: {}, body: undefined };
  const resHeaders: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      resHeaders[name] = value;
      return this;
    },
    setHeader(name: string, value: string) {
      resHeaders[name] = value;
      return this;
    },
    json(payload: any) {
      captured = { status: this.statusCode, headers: { ...resHeaders }, body: payload };
      return this;
    },
    send(payload: any) {
      captured = { status: this.statusCode, headers: { ...resHeaders }, body: payload };
      return this;
    },
    on(_event: string, _cb: (...a: any[]) => void) {
      // consumerIdentity only registers res.on("finish", ...) for a VALID
      // key — none of these scenarios present one, so this is never
      // exercised here (see consumer-identity-rate-limit.test.ts /
      // consumer-keys.test.ts for the ledger-write path). Kept as a
      // harmless no-op so the fake res stays a drop-in for real res.
      return res;
    },
  };
  return { req, res, getResult: () => captured };
}

async function runRoute(
  router: any,
  opts: { method?: string; url: string; body?: any; headers?: Record<string, string> },
  withConsumerIdentity: boolean,
): Promise<CapturedResult> {
  const { req, res, getResult } = makeReqRes(opts);
  const finalNext = (err?: any) => {
    if (err) throw err;
  };
  if (withConsumerIdentity) {
    await new Promise<void>((resolve) => {
      consumerIdentity(req as Request, res as Response, (() => {
        router.handle(req, res, finalNext);
        resolve();
      }) as NextFunction);
    });
  } else {
    router.handle(req, res, finalNext);
  }
  // Flush any microtasks the async route handlers schedule before their
  // first synchronous res.json()/res.send() call (none of the endpoints
  // below actually need this, but it costs nothing and guards against a
  // future handler gaining an early await).
  await Promise.resolve();
  return getResult();
}

export async function runConsumerIdentityAnonymousRegressionTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertDeepEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);

  try {
    const mcpRouter = require("../routes/mcp").default;
    const a2aRouter = require("../routes/a2a").default;
    const consumerRouter = require("../routes/consumer").default;

    const INVALID_KEY_HEADERS = { "x-api-key": "rfb_totally-unknown-key-does-not-exist" };

    // ── Representative endpoints ────────────────────────────────────
    const cases: Array<{
      label: string;
      router: any;
      req: { method?: string; url: string; body?: any };
    }> = [
      // MCP: GET /mcp with no session — synchronous, deterministic 400,
      // never touches the SDK Streamable HTTP transport.
      { label: "MCP GET /mcp (no session)", router: mcpRouter, req: { method: "GET", url: "/" } },
      // MCP: DELETE /mcp with an unknown session — synchronous, deterministic 200.
      { label: "MCP DELETE /mcp (unknown session)", router: mcpRouter, req: { method: "DELETE", url: "/" } },
      // A2A: GET /a2a — agent-card / health-check discovery.
      { label: "A2A GET /a2a (agent card)", router: a2aRouter, req: { method: "GET", url: "/a2a" } },
      // A2A: POST /a2a with an unrecognized JSON-RPC method — deterministic
      // "Method not found" branch, no data mutation.
      {
        label: "A2A POST /a2a (unknown method)",
        router: a2aRouter,
        req: {
          method: "POST",
          url: "/a2a",
          body: { jsonrpc: "2.0", method: "totally/unknown", params: {}, id: "regress-1" },
        },
      },
      // REST: POST /api/search — pure in-memory matching engine, no DB dependency.
      {
        label: "REST POST /api/search (empty query)",
        router: consumerRouter,
        req: { method: "POST", url: "/search", body: {} },
      },
    ];

    for (const c of cases) {
      const before = await runRoute(c.router, c.req, false);
      const afterNoKey = await runRoute(c.router, c.req, true);
      const afterBadKey = await runRoute(c.router, { ...c.req, headers: INVALID_KEY_HEADERS } as any, true);

      assertDeepEq(afterNoKey, before, `${c.label}: no X-API-Key header -> byte-identical to pre-existing behavior`);
      assertDeepEq(afterBadKey, before, `${c.label}: unknown/invalid X-API-Key -> byte-identical to pre-existing behavior (falls through, never errors)`);
    }

    // ── Middleware-level invariant, independent of any router ──────────
    // No header at all: consumerIdentity must call next() synchronously
    // and must NOT attach consumerKeyId/consumerRateTier to the request.
    {
      const { req, res } = makeReqRes({ url: "/whatever" });
      let nextCalled = 0;
      consumerIdentity(req as Request, res as Response, (() => {
        nextCalled++;
      }) as NextFunction);
      assertDeepEq(nextCalled, 1, "consumerIdentity: absent header calls next() exactly once");
      assertDeepEq(req.consumerKeyId, undefined, "consumerIdentity: absent header never sets req.consumerKeyId");
      assertDeepEq(req.consumerRateTier, undefined, "consumerIdentity: absent header never sets req.consumerRateTier");
    }

    // Unknown key: same invariant — falls through, no error, no attachment.
    {
      const { req, res } = makeReqRes({ url: "/whatever", headers: INVALID_KEY_HEADERS });
      let nextCalled = 0;
      let threw = false;
      try {
        consumerIdentity(req as Request, res as Response, (() => {
          nextCalled++;
        }) as NextFunction);
      } catch {
        threw = true;
      }
      assertDeepEq(threw, false, "consumerIdentity: unknown key never throws");
      assertDeepEq(nextCalled, 1, "consumerIdentity: unknown key calls next() exactly once (falls through)");
      assertDeepEq(req.consumerKeyId, undefined, "consumerIdentity: unknown key never sets req.consumerKeyId");
    }

    // Revoked key: insert a key, revoke it, confirm it now behaves exactly
    // like an unknown key (falls through, no attachment, no error).
    {
      const { hashApiKey } = require("./consumer-identity") as typeof import("./consumer-identity");
      const plaintextKey = "rfb_revoked-regression-test-key";
      const keyHash = hashApiKey(plaintextKey);
      db.prepare(
        `INSERT INTO consumer_api_keys (key_hash, rate_tier, revoked_at) VALUES (?, 'keyed', datetime('now'))`,
      ).run(keyHash);

      const { req, res } = makeReqRes({ url: "/whatever", headers: { "x-api-key": plaintextKey } });
      let nextCalled = 0;
      consumerIdentity(req as Request, res as Response, (() => {
        nextCalled++;
      }) as NextFunction);
      assertDeepEq(nextCalled, 1, "consumerIdentity: revoked key falls through (next() called, not an error)");
      assertDeepEq(req.consumerKeyId, undefined, "consumerIdentity: revoked key never sets req.consumerKeyId");
    }
  } catch (err) {
    failed++;
    failures.push(
      `consumer-identity-anonymous-regression: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    );
  }

  return { passed, failed, failures };
}

// Standalone runner. Explicit process.exit() in both branches — routes/mcp.ts
// holds an open setInterval (session cleanup) at module scope, which would
// otherwise keep this process alive forever after the async work is done
// (mirrors tests/test.ts's own unconditional process.exit() at the end).
if (require.main === module) {
  runConsumerIdentityAnonymousRegressionTests({ log: true }).then((r) => {
    console.log(`\nconsumer-identity-anonymous-regression: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
