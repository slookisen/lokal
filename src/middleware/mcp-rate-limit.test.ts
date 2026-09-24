/**
 * mcp-rate-limit.test.ts — dev-request
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet, track C1.
 *
 * Proves middleware/mcp-rate-limit.ts's three pieces:
 *   1. mcpPrimaryKey(): Mcp-Session-Id -> X-API-Key -> IP priority, and the
 *      resulting BEHAVIOR — a session's own burst 429s while a fresh session
 *      (even from the same IP) is unaffected (acceptance criterion 1).
 *   2. isCartSideEffectCall() / mcpCartToolKey(): only tools/call on
 *      lokal_cart_create|lokal_cart_add_item|lokal_cart_submit is metered by
 *      the stricter cart quota; every other JSON-RPC call (lokal_search,
 *      lokal_cart_view, tools/list, …) is never touched by it.
 *   3. sendMcpRateLimited(): a 429 always carries a valid JSON-RPC 2.0 error
 *      body (jsonrpc/error.code/error.message/id), never a bare HTTP error
 *      page — including echoing the caller's own request id.
 *
 * The real exported limiters (mcpPrimaryLimiter: 200/600 per 15min,
 * mcpIpEmergencyBrakeLimiter: 3000 per 15min) are too large to exhaust with
 * real requests in a unit test — those numeric configs are asserted via a
 * source-text check (mirrors the existing pr106-01/04-style precedent for
 * dentalLimiter/generalLimiter in tests/test.ts), while the BEHAVIOR of
 * their key-generation + skip + handler logic is proven here by building
 * small-scale local rate limiters out of the exact same exported functions
 * — same technique consumer-identity-rate-limit.test.ts uses for keyedMax().
 * mcpCartToolLimiter's real numbers (20/min) are small enough to exhaust
 * directly, so that one IS exercised at its real, exported config.
 *
 * Standalone: npx tsx src/middleware/mcp-rate-limit.test.ts
 */

import express from "express";
import rateLimit from "express-rate-limit";
import { AddressInfo } from "net";
import http from "http";
import {
  mcpPrimaryKey,
  isCartSideEffectCall,
  mcpCartToolKey,
  sendMcpRateLimited,
  jsonRpcIdFromBody,
  mcpCartToolLimiter,
  CART_SIDE_EFFECT_TOOLS,
} from "./mcp-rate-limit";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C1, fix-up:
// this file's behavioral checks used to call the platform's global fetch()
// directly. tests/test.ts's own shared-global-state warning (file header,
// "globalThis.fetch — some blocks overwrite it to stub network calls") is
// exactly what bit this in the FULL `npm test` run — some other,
// independently-running block in that giant suite had globalThis.fetch
// monkey-patched at the moment this block's requests fired, silently
// short-circuiting them to a stubbed 200 instead of hitting the real
// in-process server (confirmed: 100% green standalone via
// `npx tsx src/middleware/mcp-rate-limit.test.ts`, but 5 of these same
// assertions failed only inside the full suite). Node's own `http` module
// is never monkey-patched by anything in this codebase, so these two
// behavioral blocks post through it directly instead of fetch().
function postJson(port: number, path: string, body: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = undefined;
          try { json = JSON.parse(text); } catch { /* non-JSON response */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function startServer(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function runMcpRateLimitTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── Unit: mcpPrimaryKey priority order ──────────────────────────────────
  {
    const reqWithSession = { headers: { "mcp-session-id": "sess-abc" }, header: () => undefined, ip: "1.2.3.4" } as any;
    assertEq(mcpPrimaryKey(reqWithSession), "sid:sess-abc", "mcpPrimaryKey: session id wins when present");

    const reqWithKeyOnly = { headers: {}, header: (n: string) => (n === "X-API-Key" ? "rfb_abc123" : undefined), ip: "1.2.3.4" } as any;
    assertEq(mcpPrimaryKey(reqWithKeyOnly), "key:rfb_abc123", "mcpPrimaryKey: falls back to X-API-Key when no session id");

    const reqWithNeither = { headers: {}, header: () => undefined, ip: "5.6.7.8" } as any;
    assertTrue(mcpPrimaryKey(reqWithNeither).startsWith("ip:"), "mcpPrimaryKey: falls back to IP when neither session nor key present");

    // Session id wins even when an API key is ALSO present — priority order.
    const reqWithBoth = { headers: { "mcp-session-id": "sess-xyz" }, header: (n: string) => (n === "X-API-Key" ? "rfb_zzz" : undefined), ip: "9.9.9.9" } as any;
    assertEq(mcpPrimaryKey(reqWithBoth), "sid:sess-xyz", "mcpPrimaryKey: session id takes priority over a present X-API-Key too");
  }

  // ── Unit: isCartSideEffectCall / mcpCartToolKey ─────────────────────────
  {
    assertEq(CART_SIDE_EFFECT_TOOLS.size, 3, "CART_SIDE_EFFECT_TOOLS: exactly the 3 named tools");
    for (const t of ["lokal_cart_create", "lokal_cart_add_item", "lokal_cart_submit"]) {
      assertTrue(CART_SIDE_EFFECT_TOOLS.has(t), `CART_SIDE_EFFECT_TOOLS: includes ${t}`);
    }

    assertTrue(
      isCartSideEffectCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lokal_cart_submit", arguments: {} } }),
      "isCartSideEffectCall: true for tools/call lokal_cart_submit"
    );
    assertTrue(
      !isCartSideEffectCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lokal_search", arguments: {} } }),
      "isCartSideEffectCall: false for tools/call on a non-cart tool"
    );
    assertTrue(
      !isCartSideEffectCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      "isCartSideEffectCall: false for tools/list"
    );
    assertTrue(
      !isCartSideEffectCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lokal_cart_view", arguments: {} } }),
      "isCartSideEffectCall: false for lokal_cart_view (read-only cart tool, not in the strict set)"
    );
    // Batch body: any matching entry is enough (over-approximation, never under).
    assertTrue(
      isCartSideEffectCall([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lokal_cart_add_item", arguments: {} } },
      ]),
      "isCartSideEffectCall: true when ANY entry in a batch is a cart-side-effect call"
    );

    const reqWithBuyerRef = {
      ip: "1.1.1.1",
      body: { method: "tools/call", params: { name: "lokal_cart_submit", arguments: { buyer_ref: "bref_x" } } },
    } as any;
    const key1 = mcpCartToolKey(reqWithBuyerRef);
    assertTrue(key1.endsWith(":bref_x"), "mcpCartToolKey: keys on ip:buyer_ref when arguments.buyer_ref is present");

    const reqCreateNoBuyerRef = {
      ip: "1.1.1.1",
      body: { method: "tools/call", params: { name: "lokal_cart_create", arguments: {} } },
    } as any;
    const key2 = mcpCartToolKey(reqCreateNoBuyerRef);
    assertTrue(!key2.includes(":bref_"), "mcpCartToolKey: falls back to IP alone for lokal_cart_create (no buyer_ref exists yet)");

    // Different buyer_ref, same IP -> different bucket key.
    const reqOtherBuyer = {
      ip: "1.1.1.1",
      body: { method: "tools/call", params: { name: "lokal_cart_submit", arguments: { buyer_ref: "bref_y" } } },
    } as any;
    assertTrue(mcpCartToolKey(reqOtherBuyer) !== key1, "mcpCartToolKey: different buyer_ref on the same IP produces a different key");
  }

  // ── Unit: JSON-RPC 429 body shape ───────────────────────────────────────
  {
    assertEq(jsonRpcIdFromBody({ jsonrpc: "2.0", id: 7, method: "tools/call" }), 7, "jsonRpcIdFromBody: echoes a numeric id");
    assertEq(jsonRpcIdFromBody({ jsonrpc: "2.0", id: "abc", method: "tools/call" }), "abc", "jsonRpcIdFromBody: echoes a string id");
    assertEq(jsonRpcIdFromBody([{ id: 1 }, { id: 2 }]), null, "jsonRpcIdFromBody: null for a batch array");
    assertEq(jsonRpcIdFromBody({ method: "tools/call" }), null, "jsonRpcIdFromBody: null when body has no id");
    assertEq(jsonRpcIdFromBody(undefined), null, "jsonRpcIdFromBody: null for a missing body");

    const fakeReq = { body: { jsonrpc: "2.0", id: 42, method: "tools/call" } } as any;
    let sentStatus: number | undefined;
    let sentBody: any;
    const fakeRes = {
      status(code: number) { sentStatus = code; return this; },
      json(body: any) { sentBody = body; return this; },
    } as any;
    sendMcpRateLimited(fakeReq, fakeRes);
    assertEq(sentStatus, 429, "sendMcpRateLimited: HTTP 429");
    assertEq(sentBody?.jsonrpc, "2.0", "sendMcpRateLimited: jsonrpc: '2.0'");
    assertTrue(typeof sentBody?.error?.code === "number", "sendMcpRateLimited: error.code is a number");
    assertTrue(typeof sentBody?.error?.message === "string" && sentBody.error.message.length > 0, "sendMcpRateLimited: error.message is a non-empty string");
    assertEq(sentBody?.id, 42, "sendMcpRateLimited: echoes the request's own JSON-RPC id");
  }

  // ── Behavioral: a session's own burst 429s; a NEW session (same IP)
  // is unaffected — the exact acceptance-criteria shape, built from the
  // real mcpPrimaryKey()/sendMcpRateLimited() with a tiny max for speed. ──
  {
    const app = express();
    app.use(express.json());
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: 3,
        standardHeaders: true,
        legacyHeaders: false,
        validate: { trustProxy: false },
        keyGenerator: mcpPrimaryKey,
        handler: sendMcpRateLimited,
      })
    );
    app.post("/mcp", (req, res) => res.json({ jsonrpc: "2.0", id: req.body?.id ?? null, result: { ok: true } }));

    const { port, close } = await startServer(app);
    try {
      const bodyFor = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "lokal_search", arguments: {} } });
      const headersA = { "Content-Type": "application/json", "Mcp-Session-Id": "session-A" };
      const headersB = { "Content-Type": "application/json", "Mcp-Session-Id": "session-B" };

      const a1 = await postJson(port, "/mcp", bodyFor(1), headersA);
      const a2 = await postJson(port, "/mcp", bodyFor(2), headersA);
      const a3 = await postJson(port, "/mcp", bodyFor(3), headersA);
      assertEq([a1.status, a2.status, a3.status], [200, 200, 200], "session A: first 3 calls (at the cap) all succeed");

      const a4 = await postJson(port, "/mcp", bodyFor(4), headersA);
      assertEq(a4.status, 429, "session A: 4th call over its own quota -> 429");
      assertEq(a4.json?.jsonrpc, "2.0", "session A over-quota response: valid JSON-RPC envelope (jsonrpc field)");
      assertTrue(typeof a4.json?.error?.code === "number", "session A over-quota response: has a JSON-RPC error.code");
      assertEq(a4.json?.id, 4, "session A over-quota response: echoes the request's own id");

      // A brand-new session, same client/IP (loopback) — must NOT be
      // blocked by session A's exhausted bucket (acceptance criterion 1).
      const b1 = await postJson(port, "/mcp", bodyFor(1), headersB);
      assertEq(b1.status, 200, "a fresh session (same IP) is unaffected by session A's exhausted quota");
    } finally {
      await close();
    }
  }

  // ── Behavioral: mcpCartToolLimiter (REAL exported limiter, 20/min) only
  // meters the 3 named cart tools; lokal_search bursts straight through it
  // even well past 20 calls, since skip() short-circuits for it. ──────────
  {
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcpCartToolLimiter);
    app.post("/mcp", (req, res) => res.json({ jsonrpc: "2.0", id: req.body?.id ?? null, result: { ok: true } }));

    const { port, close } = await startServer(app);
    try {
      const submitBody = (id: number) =>
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "lokal_cart_submit", arguments: { buyer_ref: "bref_test" } } });
      const jsonHeaders = { "Content-Type": "application/json" };

      let firstBlockedAt = -1;
      for (let i = 1; i <= 25; i++) {
        const r = await postJson(port, "/mcp", submitBody(i), jsonHeaders);
        if (r.status === 429 && firstBlockedAt === -1) firstBlockedAt = i;
      }
      assertEq(firstBlockedAt, 21, "mcpCartToolLimiter: exactly the 21st lokal_cart_submit in a minute is blocked (real max: 20)");

      // A different buyer_ref (different bucket key) is unaffected.
      const otherBuyer = await postJson(
        port,
        "/mcp",
        JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "lokal_cart_submit", arguments: { buyer_ref: "bref_other" } } }),
        jsonHeaders
      );
      assertEq(otherBuyer.status, 200, "mcpCartToolLimiter: a different buyer_ref (different bucket) is unaffected by the first buyer's exhausted quota");

      // lokal_search burst, well past 20 calls, is NEVER touched by this limiter.
      let searchBlocked = false;
      for (let i = 1; i <= 25; i++) {
        const r = await postJson(
          port,
          "/mcp",
          JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "lokal_search", arguments: {} } }),
          jsonHeaders
        );
        if (r.status === 429) searchBlocked = true;
      }
      assertTrue(!searchBlocked, "mcpCartToolLimiter: a 25-call lokal_search burst is never blocked by this limiter (skip() excludes it)");
    } finally {
      await close();
    }
  }

  // ── Source-config guard: the REAL exported limiters carry the numbers
  // documented in the file header (mirrors the existing pr106-01/04-style
  // regex assertions against dentalLimiter/generalLimiter in tests/test.ts).
  {
    const fs = require("fs");
    const path = require("path");
    const src: string = fs.readFileSync(path.join(__dirname, "mcp-rate-limit.ts"), "utf8");

    assertTrue(
      /export const mcpIpEmergencyBrakeLimiter = rateLimit\(\{[\s\S]{0,300}windowMs:\s*15\s*\*\s*60\s*\*\s*1000/.test(src),
      "mcpIpEmergencyBrakeLimiter: 15-minute window"
    );
    assertTrue(
      /export const mcpIpEmergencyBrakeLimiter = rateLimit\(\{[\s\S]{0,300}max:\s*3000/.test(src),
      "mcpIpEmergencyBrakeLimiter: max 3000 (high emergency-brake ceiling)"
    );
    assertTrue(
      /export const mcpPrimaryLimiter = rateLimit\(\{[\s\S]{0,300}max:\s*keyedMax\(200,\s*600\)/.test(src),
      "mcpPrimaryLimiter: max keyedMax(200, 600) — same ceiling as jsonRpcLimiter"
    );
    assertTrue(
      /export const mcpCartToolLimiter = rateLimit\(\{[\s\S]{0,400}windowMs:\s*60\s*\*\s*1000[\s\S]{0,100}max:\s*20/.test(src),
      "mcpCartToolLimiter: 1-minute window, max 20 — same numbers as cartWishesLimiter"
    );

    const secSrc: string = fs.readFileSync(path.join(__dirname, "security.ts"), "utf8");
    assertTrue(
      /export const cartWishesLimiter = rateLimit\(\{[\s\S]{0,300}windowMs:\s*60\s*\*\s*1000[\s\S]{0,100}max:\s*20/.test(secSrc),
      "cartWishesLimiter (security.ts): still windowMs 60*1000 / max 20 — unchanged, confirms mcpCartToolLimiter really mirrors it"
    );
    assertTrue(
      /export const dentalLimiter = rateLimit\(\{[\s\S]{0,400}max:\s*1000/.test(secSrc),
      "dentalLimiter (security.ts): untouched by this PR (out of scope — different vertical)"
    );
    assertTrue(
      /export const jsonRpcLimiter = rateLimit\(\{[\s\S]{0,400}max:\s*keyedMax\(200,\s*600\)/.test(secSrc),
      "jsonRpcLimiter (security.ts): untouched by this PR (out of scope — different vertical/endpoint)"
    );

    const idxSrc: string = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    assertTrue(
      /app\.use\(\s*["']\/mcp["'],\s*mcpIpEmergencyBrakeLimiter,\s*mcpPrimaryLimiter,\s*mcpCartToolLimiter,\s*mcpUsageLogger/.test(idxSrc),
      "index.ts: all three MCP limiters are mounted on /mcp, before mcpUsageLogger/mcpRoutes"
    );
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMcpRateLimitTests({ log: true }).then((r) => {
    console.log(`\nmcp-rate-limit: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
