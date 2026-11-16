/**
 * mcp-rate-limit.test.ts — dev-requests
 * 2026-09-24-mcp-rate-limit-og-personvern-sannhet (track C1) and
 * 2026-10-16-mcp-rate-limit-dental-opplevagent-per-okt (S1 + S2).
 *
 * Proves middleware/mcp-rate-limit.ts's pieces:
 *   1. mcpPrimaryKey(): Mcp-Session-Id -> recognized consumer key -> IP
 *      priority, and the resulting BEHAVIOR — a session's own burst 429s
 *      while a fresh session (even from the same IP) is unaffected
 *      (acceptance criterion 1).
 *   2. S2 hardening of that key: a non-UUID or 10 KB Mcp-Session-Id, a
 *      well-formed id the router does not hold, and an X-API-Key that
 *      consumerIdentity did not recognize all fall to the IP key — so 10
 *      requests with 10 random fake keys share ONE bucket, while a valid key
 *      keeps its own bucket and its higher ceiling.
 *   3. isCartSideEffectCall() / mcpCartToolKey(): only tools/call on
 *      lokal_cart_create|lokal_cart_add_item|lokal_cart_submit is metered by
 *      the stricter cart quota; every other JSON-RPC call (lokal_search,
 *      lokal_cart_view, tools/list, …) is never touched by it.
 *   4. sendMcpRateLimited(): a 429 always carries a valid JSON-RPC 2.0 error
 *      body (jsonrpc/error.code/error.message/id), never a bare HTTP error
 *      page — including echoing the caller's own request id.
 *   6. G1-2 (dev-request 2026-11-12-g1-google-klar): google-ip-ranges.ts's
 *      CIDR matcher, and MCP_RATE_LIMIT_GOOGLE_RANGES_ENABLED — off: a Google
 *      address is limited per IP exactly as before (AK2); on: every address
 *      in Google's ranges counts in ONE shared bucket, while other addresses
 *      stay per IP (AK3).
 *   5. MCP_RATE_LIMIT_PROFILES / createMcpRateLimiters(): the numbers of all
 *      three profiles, RFB's exported limiters built from the rfb profile, one
 *      chain per call (a dental chain has no side-effect limiter), and an
 *      injected store really being the one counted in.
 *
 * The real exported limiters (mcpPrimaryLimiter: 200/600 per 15min,
 * mcpIpEmergencyBrakeLimiter: 3000 per 15min) are too large to exhaust with
 * real requests in a unit test — their numbers are asserted on the profile
 * object and on the RateLimit-Limit / RateLimit-Policy headers the exported
 * limiters themselves send, while the BEHAVIOR of their key-generation +
 * skip + handler logic is proven here by building small-scale limiters out of
 * the exact same exported functions and factory — same technique
 * consumer-identity-rate-limit.test.ts uses for keyedMax().
 * mcpCartToolLimiter's real numbers (20/min) are small enough to exhaust
 * directly, so that one IS exercised at its real, exported config.
 *
 * The router-level behaviour per vertical (the real routers, their own
 * chains, no bucket shared with /a2a or /api/tannlege, tool-annotation
 * parity) lives in mcp-rate-limit-verticals.test.ts.
 *
 * Standalone: npx tsx src/middleware/mcp-rate-limit.test.ts
 */

import express from "express";
import rateLimit, { MemoryStore } from "express-rate-limit";
import { AddressInfo } from "net";
import http from "http";
import { randomUUID } from "crypto";
import {
  mcpPrimaryKey,
  mcpIpKey,
  isCartSideEffectCall,
  isSideEffectToolCall,
  mcpCartToolKey,
  sendMcpRateLimited,
  jsonRpcIdFromBody,
  mcpIpEmergencyBrakeLimiter,
  mcpPrimaryLimiter,
  mcpCartToolLimiter,
  CART_SIDE_EFFECT_TOOLS,
  MCP_RATE_LIMIT_PROFILES,
  createMcpRateLimiters,
  type McpLimiterName,
  GOOGLE_RANGES_FLAG_ENV,
  GOOGLE_RANGES_BUCKET,
  GOOGLE_RANGES_LIMIT_MULTIPLIER,
  googleRangesEnabled,
  type McpRateLimitProfile,
} from "./mcp-rate-limit";
import {
  ipInCidr,
  isGoogleMcpIp,
  GOOGLE_MCP_CIDRS,
  GOOGLE_CONNECTED_APPS_CIDRS,
  GOOGLE_USER_TRIGGERED_AGENTS_CIDRS,
} from "./google-ip-ranges";

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
// is never monkey-patched by anything in this codebase, so these
// behavioral blocks post through it directly instead of fetch().
function postJson(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
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
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
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

// Stand-in for consumerIdentity (same reason and shape as
// consumer-identity-rate-limit.test.ts: no shared DB singleton during real
// async I/O). Only VALID_TEST_KEY is "recognized" — every other X-API-Key
// value leaves req.consumerKeyId unset, exactly what consumerIdentity does
// for an unknown, made-up or revoked key.
const VALID_TEST_KEY = "rfb_valid_test_key";
const VALID_TEST_KEY_ID = 7;
function fakeConsumerIdentity(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  if (req.header("X-API-Key") === VALID_TEST_KEY) req.consumerKeyId = VALID_TEST_KEY_ID;
  next();
}

const ok = (req: express.Request, res: express.Response) =>
  res.json({ jsonrpc: "2.0", id: req.body?.id ?? null, result: { ok: true } });

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

  // Fake request for the key functions: headers as Node delivers them
  // (lower-case), consumerKeyId as consumerIdentity would set it.
  const fakeReq = (o: { sid?: string | string[]; apiKey?: string; consumerKeyId?: number; ip?: string }) =>
    ({
      headers: {
        ...(o.sid !== undefined ? { "mcp-session-id": o.sid } : {}),
        ...(o.apiKey !== undefined ? { "x-api-key": o.apiKey } : {}),
      },
      header: (n: string) => (n.toLowerCase() === "x-api-key" ? o.apiKey : undefined),
      consumerKeyId: o.consumerKeyId,
      ip: o.ip ?? "1.2.3.4",
    }) as any;

  // ── Unit: mcpPrimaryKey priority order ──────────────────────────────────
  {
    const sidA = randomUUID();
    assertEq(mcpPrimaryKey(fakeReq({ sid: sidA })), `sid:${sidA}`, "mcpPrimaryKey: a UUID session id wins when present");

    assertEq(
      mcpPrimaryKey(fakeReq({ apiKey: VALID_TEST_KEY, consumerKeyId: 42 })),
      "key:42",
      "mcpPrimaryKey: falls back to the RECOGNIZED consumer key id when no session id"
    );

    assertEq(mcpPrimaryKey(fakeReq({ ip: "5.6.7.8" })), "ip:5.6.7.8", "mcpPrimaryKey: falls back to IP when neither session nor key present");

    // Session id wins even when a recognized key is ALSO present — priority order.
    const sidB = randomUUID();
    assertEq(
      mcpPrimaryKey(fakeReq({ sid: sidB, apiKey: VALID_TEST_KEY, consumerKeyId: 42 })),
      `sid:${sidB}`,
      "mcpPrimaryKey: session id takes priority over a recognized key too"
    );

    // A repeated header arrives as an array; the first value is the one used.
    const sidC = randomUUID();
    assertEq(mcpPrimaryKey(fakeReq({ sid: [sidC, randomUUID()] })), `sid:${sidC}`, "mcpPrimaryKey: first value of a repeated Mcp-Session-Id header");
  }

  // ── Unit (S2): a made-up identity never gets its own key ─────────────────
  {
    // Raw X-API-Key header that consumerIdentity did NOT recognize
    // (consumerKeyId unset) -> IP, never `key:<raw header>`.
    const fakeKeys = Array.from({ length: 10 }, () => "rfb_" + randomUUID().replace(/-/g, ""));
    const keys = new Set(fakeKeys.map((k) => mcpPrimaryKey(fakeReq({ apiKey: k, ip: "9.9.9.9" }))));
    assertEq([...keys], ["ip:9.9.9.9"], "mcpPrimaryKey (S2): 10 different unrecognized X-API-Key values all map to the ONE IP key");

    assertEq(mcpPrimaryKey(fakeReq({ sid: "sess-abc", ip: "9.9.9.9" })), "ip:9.9.9.9", "mcpPrimaryKey (S2): a non-UUID session id falls to the IP key");
    const huge = "a".repeat(10 * 1024);
    const hugeKey = mcpPrimaryKey(fakeReq({ sid: huge, ip: "9.9.9.9" }));
    assertEq(hugeKey, "ip:9.9.9.9", "mcpPrimaryKey (S2): a 10 KB session id falls to the IP key (never a 10 KB store key)");
    const uuidPlusJunk = randomUUID() + "x";
    assertEq(mcpPrimaryKey(fakeReq({ sid: uuidPlusJunk, ip: "9.9.9.9" })), "ip:9.9.9.9", "mcpPrimaryKey (S2): a UUID with trailing junk falls to the IP key");
    assertEq(
      mcpPrimaryKey(fakeReq({ sid: randomUUID().toUpperCase(), ip: "9.9.9.9" })),
      "ip:9.9.9.9",
      "mcpPrimaryKey (S2): an upper-case UUID is not a server-minted id (randomUUID is lower-case) -> IP key"
    );
    assertEq(mcpPrimaryKey(fakeReq({ sid: "", ip: "9.9.9.9" })), "ip:9.9.9.9", "mcpPrimaryKey (S2): an empty session header falls to the IP key");

    // A malformed id falls through to a recognized key, not straight to IP.
    assertEq(
      mcpPrimaryKey(fakeReq({ sid: "not-a-session", apiKey: VALID_TEST_KEY, consumerKeyId: 42 })),
      "key:42",
      "mcpPrimaryKey (S2): a malformed session id with a recognized key -> the key bucket"
    );

    // The router's own isKnownSession check: a well-formed id it does not
    // hold falls through; one it holds keeps its own bucket. A malformed id
    // never even reaches the check.
    const live = randomUUID();
    const asked: string[] = [];
    const isKnown = (id: string) => { asked.push(id); return id === live; };
    assertEq(mcpPrimaryKey(fakeReq({ sid: live }), isKnown), `sid:${live}`, "mcpPrimaryKey (S2): a session the router holds keeps its own bucket");
    assertEq(mcpPrimaryKey(fakeReq({ sid: randomUUID(), ip: "9.9.9.9" }), isKnown), "ip:9.9.9.9", "mcpPrimaryKey (S2): a well-formed id the router does not hold -> IP key");
    assertEq(
      mcpPrimaryKey(fakeReq({ sid: randomUUID(), consumerKeyId: 42 }), isKnown),
      "key:42",
      "mcpPrimaryKey (S2): a well-formed unknown id with a recognized key -> the key bucket"
    );
    asked.length = 0;
    mcpPrimaryKey(fakeReq({ sid: huge }), isKnown);
    assertEq(asked.length, 0, "mcpPrimaryKey (S2): a malformed id is rejected on shape, before any session lookup");
  }

  // ── Unit: isCartSideEffectCall / isSideEffectToolCall / mcpCartToolKey ──
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

    // The generic form reads the tool set it is given (a profile's set).
    const bookOnly: ReadonlySet<string> = new Set(["book_gardssalg"]);
    assertTrue(
      isSideEffectToolCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "book_gardssalg", arguments: {} } }, bookOnly),
      "isSideEffectToolCall: true for a tools/call on a tool in the given set"
    );
    assertTrue(
      !isSideEffectToolCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lokal_cart_submit", arguments: {} } }, bookOnly),
      "isSideEffectToolCall: false for a tool outside the given set"
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

    const fakeReq429 = { body: { jsonrpc: "2.0", id: 42, method: "tools/call" } } as any;
    let sentStatus: number | undefined;
    let sentBody: any;
    const fakeRes = {
      status(code: number) { sentStatus = code; return this; },
      json(body: any) { sentBody = body; return this; },
    } as any;
    sendMcpRateLimited(fakeReq429, fakeRes);
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
        keyGenerator: (req) => mcpPrimaryKey(req),
        handler: sendMcpRateLimited,
      })
    );
    app.post("/mcp", ok);

    const { port, close } = await startServer(app);
    try {
      const bodyFor = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "lokal_search", arguments: {} } });
      const headersA = { "Content-Type": "application/json", "Mcp-Session-Id": randomUUID() };
      const headersB = { "Content-Type": "application/json", "Mcp-Session-Id": randomUUID() };

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

  // ── Behavioral (S2): 10 requests with 10 random fake X-API-Key values
  // and no session land in ONE IP bucket (before S2: one bucket per fake
  // key, so rotating keys bypassed the primary quota up to the 3000 brake);
  // a valid key keeps its own bucket and the keyed ceiling. Factory-built
  // rfb chain with a scaled-down primary quota. ─────────────────────────────
  {
    const chain = createMcpRateLimiters({
      ...MCP_RATE_LIMIT_PROFILES.rfb,
      primary: { windowMs: 60_000, anonymousMax: 10, keyedMax: 30 },
    }).chain;
    const app = express();
    app.use(express.json());
    app.use(fakeConsumerIdentity);
    app.use("/mcp", chain);
    app.post("/mcp", ok);

    const { port, close } = await startServer(app);
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const remaining: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await postJson(port, "/mcp", body, { "Content-Type": "application/json", "X-API-Key": "rfb_fake_" + randomUUID() });
        remaining.push(String(r.headers["ratelimit-remaining"]));
      }
      assertEq(remaining, ["9", "8", "7", "6", "5", "4", "3", "2", "1", "0"], "S2: 10 random fake keys count down ONE bucket (RateLimit-Remaining 9..0)");
      const eleventh = await postJson(port, "/mcp", body, { "Content-Type": "application/json", "X-API-Key": "rfb_fake_" + randomUUID() });
      assertEq(eleventh.status, 429, "S2: an 11th fresh fake key does not buy a new bucket -> 429");
      assertEq(eleventh.json?.error?.code, -32000, "S2: … with the JSON-RPC -32000 body");

      const valid = await postJson(port, "/mcp", body, { "Content-Type": "application/json", "X-API-Key": VALID_TEST_KEY });
      assertEq(valid.status, 200, "S2: a valid key is unaffected by the exhausted IP bucket (own key bucket)");
      assertEq(valid.headers["ratelimit-limit"], "30", "S2: … and keeps the keyed ceiling");
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
    app.post("/mcp", ok);

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
      assertEq(otherBuyer.headers["ratelimit-policy"], "20;w=60", "mcpCartToolLimiter: RateLimit-Policy 20;w=60 (real exported numbers)");

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

  // ── Behavioral: Opplevagent's book_gardssalg quota at the experiences
  // profile's REAL numbers (20/min, fresh chain): only book_gardssalg is
  // metered, and a buyer_ref slipped into its arguments (the tool takes none,
  // so the booking would still go through) buys no fresh bucket. ───────────
  {
    const app = express();
    app.use(express.json());
    app.use("/mcp", createMcpRateLimiters(MCP_RATE_LIMIT_PROFILES.experiences).chain);
    app.post("/mcp", ok);

    const { port, close } = await startServer(app);
    try {
      const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
        postJson(port, "/mcp", JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), {
          "Content-Type": "application/json",
        });

      let firstBlockedAt = -1;
      for (let i = 1; i <= 21; i++) {
        const r = await call(i, "book_gardssalg");
        if (r.status === 429 && firstBlockedAt === -1) firstBlockedAt = i;
      }
      assertEq(firstBlockedAt, 21, "experiences side-effect quota: exactly the 21st book_gardssalg in a minute is blocked (max 20)");

      const bypass = await call(22, "book_gardssalg", { buyer_ref: "bref_made_up" });
      assertEq(bypass.status, 429, "experiences side-effect quota: a made-up buyer_ref in the arguments buys no new bucket");
      assertEq(bypass.json?.id, 22, "experiences side-effect quota: 429 echoes the request id");

      let discoverBlocked = false;
      for (let i = 1; i <= 25; i++) {
        if ((await call(100 + i, "discover_experiences")).status === 429) discoverBlocked = true;
      }
      assertTrue(!discoverBlocked, "experiences side-effect quota: a 25-call discover_experiences burst is never blocked by it");
    } finally {
      await close();
    }
  }

  // ── Behavioral: RFB's REAL exported brake + primary limiters carry the
  // rfb profile's numbers — read off the headers they send, so no burst is
  // needed (RateLimit-Limit / RateLimit-Policy do not depend on usage). ────
  {
    const app = express();
    app.use(express.json());
    app.use(fakeConsumerIdentity);
    app.post("/brake", mcpIpEmergencyBrakeLimiter, ok);
    app.post("/primary", mcpPrimaryLimiter, ok);

    const { port, close } = await startServer(app);
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const jsonHeaders = { "Content-Type": "application/json" };
      const brake = await postJson(port, "/brake", body, jsonHeaders);
      assertEq(
        [brake.headers["ratelimit-limit"], brake.headers["ratelimit-policy"]],
        ["3000", "3000;w=900"],
        "mcpIpEmergencyBrakeLimiter: 3000 per 15 minutes (RateLimit-Limit / -Policy)"
      );
      const anon = await postJson(port, "/primary", body, jsonHeaders);
      assertEq(
        [anon.headers["ratelimit-limit"], anon.headers["ratelimit-policy"]],
        ["200", "200;w=900"],
        "mcpPrimaryLimiter: 200 per 15 minutes without a key — unchanged for RFB"
      );
      const fake = await postJson(port, "/primary", body, { ...jsonHeaders, "X-API-Key": "rfb_fake_" + randomUUID() });
      assertEq(fake.headers["ratelimit-limit"], "200", "mcpPrimaryLimiter: an unrecognized key stays at the anonymous 200");
      const keyed = await postJson(port, "/primary", body, { ...jsonHeaders, "X-API-Key": VALID_TEST_KEY });
      assertEq(
        [keyed.headers["ratelimit-limit"], keyed.headers["ratelimit-policy"]],
        ["600", "600;w=900"],
        "mcpPrimaryLimiter: 600 per 15 minutes with a valid key — unchanged for RFB"
      );
    } finally {
      await close();
    }
  }

  // ── Config: the three profiles. "Never stricter than before": rfb is the
  // pre-factory RFB numbers; experiences' primary = jsonRpcLimiter's
  // keyedMax(200, 600); dental's primary = dentalLimiter's flat 1000 (both
  // still asserted on security.ts below). ──────────────────────────────────
  {
    const { rfb, experiences, dental } = MCP_RATE_LIMIT_PROFILES;
    assertEq(rfb.brake, { windowMs: 15 * 60 * 1000, max: 3000 }, "profile rfb: brake 3000 per 15 minutes");
    assertEq(rfb.primary, { windowMs: 15 * 60 * 1000, anonymousMax: 200, keyedMax: 600 }, "profile rfb: primary keyedMax(200, 600) per 15 minutes");
    assertEq([rfb.sideEffect.windowMs, rfb.sideEffect.max], [60 * 1000, 20], "profile rfb: cart quota 20 per minute");
    assertTrue(rfb.sideEffect.tools === CART_SIDE_EFFECT_TOOLS, "profile rfb: cart quota meters CART_SIDE_EFFECT_TOOLS");
    assertTrue(rfb.sideEffect.keyGenerator === mcpCartToolKey, "profile rfb: cart quota keyed by mcpCartToolKey (ip + buyer_ref)");

    assertEq(experiences.brake, { windowMs: 15 * 60 * 1000, max: 3000 }, "profile experiences: brake 3000 per 15 minutes");
    assertEq(experiences.primary, { windowMs: 15 * 60 * 1000, anonymousMax: 200, keyedMax: 600 }, "profile experiences: primary keyedMax(200, 600) per 15 minutes (= jsonRpcLimiter per IP until now)");
    assertEq([experiences.sideEffect.windowMs, experiences.sideEffect.max], [60 * 1000, 20], "profile experiences: book_gardssalg quota 20 per minute");
    assertEq([...experiences.sideEffect.tools], ["book_gardssalg"], "profile experiences: side-effect tools = book_gardssalg");
    assertTrue(experiences.sideEffect.keyGenerator === mcpIpKey, "profile experiences: book_gardssalg quota keyed on the IP only (never a tool argument)");

    assertEq(dental.brake, { windowMs: 15 * 60 * 1000, max: 3000 }, "profile dental: brake 3000 per 15 minutes");
    assertEq(dental.primary, { windowMs: 15 * 60 * 1000, anonymousMax: 1000, keyedMax: 1000 }, "profile dental: primary flat 1000 per 15 minutes (= dentalLimiter per IP until now)");
    assertTrue(!("sideEffect" in dental), "profile dental: no side-effect quota (every dental tool is read-only)");

    for (const [name, p] of Object.entries(MCP_RATE_LIMIT_PROFILES)) {
      assertTrue(!("isKnownSession" in p) && !("createStore" in p), `profile ${name}: carries config only — the session check and stores are wiring, given by the caller`);
    }
  }

  // ── Factory: one chain per call, in mount order; injected stores used ───
  {
    const exp = createMcpRateLimiters(MCP_RATE_LIMIT_PROFILES.experiences);
    assertEq(exp.chain.length, 3, "createMcpRateLimiters(experiences): brake, primary, side-effect");
    assertTrue(exp.chain[0] === exp.brake && exp.chain[1] === exp.primary && exp.chain[2] === exp.sideEffect, "createMcpRateLimiters: chain is brake → primary → sideEffect");
    const den = createMcpRateLimiters(MCP_RATE_LIMIT_PROFILES.dental);
    assertTrue(den.sideEffect === undefined && den.chain.length === 2, "createMcpRateLimiters(dental): no side-effect limiter, chain of 2");
    const exp2 = createMcpRateLimiters(MCP_RATE_LIMIT_PROFILES.experiences);
    assertTrue(exp2.brake !== exp.brake && exp2.primary !== exp.primary, "createMcpRateLimiters: every call builds new limiters (own buckets)");

    const asked: McpLimiterName[] = [];
    const stores: Partial<Record<McpLimiterName, MemoryStore>> = {};
    const withStores = createMcpRateLimiters({
      ...MCP_RATE_LIMIT_PROFILES.experiences,
      createStore: (limiter) => {
        asked.push(limiter);
        return (stores[limiter] = new MemoryStore());
      },
    });
    assertEq(asked, ["brake", "primary", "sideEffect"], "createStore: called once per limiter, with its name");

    const app = express();
    app.use(express.json());
    app.use("/mcp", withStores.chain);
    app.post("/mcp", ok);
    const { port, close } = await startServer(app);
    try {
      const r = await postJson(
        port,
        "/mcp",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "book_gardssalg", arguments: {} } }),
        { "Content-Type": "application/json" }
      );
      assertEq(r.status, 200, "createStore: a request passes the chain built on injected stores");
      const ipKey = mcpIpKey({ ip: "127.0.0.1" } as any);
      assertEq((await stores.brake!.get(ipKey))?.totalHits, 1, "createStore: the brake counted in ITS injected store");
      assertEq((await stores.primary!.get(`ip:${ipKey}`))?.totalHits, 1, "createStore: the primary counted in ITS injected store");
      assertEq((await stores.sideEffect!.get(ipKey))?.totalHits, 1, "createStore: the side-effect quota counted in ITS injected store");
    } finally {
      await close();
    }
  }

  // ── G1-2: CIDR matcher (google-ip-ranges.ts) ──────────────────────────
  {
    const cases: Array<[string, string, boolean]> = [
      ["74.125.232.0", "74.125.232.0/24", true],
      ["74.125.232.255", "74.125.232.0/24", true],
      ["74.125.231.255", "74.125.232.0/24", false],
      ["74.125.233.0", "74.125.232.0/24", false],
      ["108.177.79.255", "108.177.64.0/20", true],
      ["108.177.80.0", "108.177.64.0/20", false],
      ["10.0.0.1", "0.0.0.0/0", true],
      ["10.0.0.1", "10.0.0.1/32", true],
      ["10.0.0.2", "10.0.0.1/32", false],
      ["::ffff:74.125.232.17", "74.125.232.0/24", true],
      ["::FFFF:74.125.232.17", "74.125.232.0/24", true],
      ["::ffff:4a7d:e811", "74.125.232.0/24", true],
      ["::ffff:74.125.233.1", "74.125.232.0/24", false],
      ["2001:4860:c::", "2001:4860:c::/124", true],
      ["2001:4860:c::f", "2001:4860:c::/124", true],
      ["2001:4860:c::10", "2001:4860:c::/124", false],
      ["2001:4860:000c:0000:0000:0000:0000:0007", "2001:4860:c::/124", true],
      ["2001:4860:c::7", "2001:4860::/32", true],
      ["2001:4861::1", "2001:4860::/32", false],
      ["74.125.232.17", "2001:4860::/32", false],
      ["2001:4860:c::7", "74.125.232.0/24", false],
      ["", "74.125.232.0/24", false],
      ["not-an-ip", "74.125.232.0/24", false],
      ["74.125.232", "74.125.232.0/24", false],
      ["74.125.232.300", "74.125.232.0/24", false],
      ["74.125.232.1 ", "74.125.232.0/24", true],
      ["fe80::1%eth0", "fe80::/10", false],
      ["74.125.232.1", "74.125.232.0", false],
      ["74.125.232.1", "74.125.232.0/33", false],
      ["74.125.232.1", "74.125.232.0/x", false],
      ["74.125.232.1", "garbage/24", false],
      ["2001:4860:c::7", "2001:4860:c::/129", false],
    ];
    for (const [ip, cidr, want] of cases) {
      assertEq(ipInCidr(ip, cidr), want, `ipInCidr(${JSON.stringify(ip)}, ${cidr}) → ${want}`);
    }
    assertEq(ipInCidr(undefined as any, "74.125.232.0/24"), false, "ipInCidr: undefined → false");
    assertEq(ipInCidr(123 as any, "74.125.232.0/24"), false, "ipInCidr: a number → false");

    assertEq(GOOGLE_CONNECTED_APPS_CIDRS.length, 7, "google ranges: the 7 connected-apps CIDR blocks Google lists");
    assertEq(GOOGLE_USER_TRIGGERED_AGENTS_CIDRS.length, 20, "google ranges: all 20 prefixes of user-triggered-agents.json");
    assertTrue(GOOGLE_MCP_CIDRS.every((c) => ipInCidr(c.split("/")[0], c)), "google ranges: every listed CIDR parses and contains its own network address");
    assertEq(
      ["74.125.232.5", "::ffff:74.125.232.5", "136.122.1.1", "192.179.15.255", "2001:4860:c::75", "203.0.113.5", "127.0.0.1", "2001:4860:c::80", "", "x"].map((ip) => isGoogleMcpIp(ip)),
      [true, true, true, true, true, false, false, false, false, false],
      "isGoogleMcpIp: in-range IPv4 / mapped / IPv6 → true; outside, loopback, empty and garbage → false"
    );
    assertEq([isGoogleMcpIp(undefined), isGoogleMcpIp(null)], [false, false], "isGoogleMcpIp: undefined / null → false");
  }

  // ── G1-2: MCP_RATE_LIMIT_GOOGLE_RANGES_ENABLED (AK2 off, AK3 on) ───────
  {
    const prevFlag = process.env[GOOGLE_RANGES_FLAG_ENV];
    const setFlag = (v: string | undefined) => {
      if (v === undefined) delete process.env[GOOGLE_RANGES_FLAG_ENV];
      else process.env[GOOGLE_RANGES_FLAG_ENV] = v;
    };
    const GOOGLE_A = "74.125.232.5";
    const GOOGLE_B = "136.122.1.1";
    const GOOGLE_V6 = "2001:4860:c::21";
    const OTHER = "203.0.113.5";

    // Only the exact string "true" turns it on.
    try {
      const seen = [undefined, "", "1", "TRUE", "yes", " true", "true"].map((v) => {
        setFlag(v);
        return googleRangesEnabled();
      });
      assertEq(seen, [false, false, false, false, false, false, true], "google flag: only the exact string \"true\" turns it on (default off)");

      // Keys, flag off: exactly today's per-IP keys.
      setFlag(undefined);
      assertEq(mcpIpKey(fakeReq({ ip: GOOGLE_A })), GOOGLE_A, "AK2 keys: flag off — a Google address keeps its own IP key (brake / book_gardssalg)");
      assertEq(mcpPrimaryKey(fakeReq({ ip: GOOGLE_A })), `ip:${GOOGLE_A}`, "AK2 keys: flag off — primary falls back to the Google address's own IP key");
      assertEq(
        mcpCartToolKey({ ip: GOOGLE_A, body: { method: "tools/call", params: { name: "lokal_cart_submit", arguments: { buyer_ref: "b1" } } } } as any),
        `${GOOGLE_A}:b1`,
        "AK2 keys: flag off — cart key is ip:buyer_ref as before"
      );

      // Keys, flag on.
      setFlag("true");
      assertEq(
        [mcpIpKey(fakeReq({ ip: GOOGLE_A })), mcpIpKey(fakeReq({ ip: GOOGLE_B })), mcpIpKey(fakeReq({ ip: GOOGLE_V6 })), mcpIpKey(fakeReq({ ip: `::ffff:${GOOGLE_A}` }))],
        [GOOGLE_RANGES_BUCKET, GOOGLE_RANGES_BUCKET, GOOGLE_RANGES_BUCKET, GOOGLE_RANGES_BUCKET],
        "AK3 keys: flag on — every Google address (IPv4, IPv6, IPv4-mapped) shares the one Google key"
      );
      assertEq(mcpIpKey(fakeReq({ ip: OTHER })), OTHER, "AK3 keys: flag on — a non-Google address keeps its own IP key");
      assertEq(mcpPrimaryKey(fakeReq({ ip: GOOGLE_B })), `ip:${GOOGLE_RANGES_BUCKET}`, "AK3 keys: flag on — primary's IP fallback is the Google bucket");
      const sid = randomUUID();
      assertEq(mcpPrimaryKey(fakeReq({ ip: GOOGLE_B, sid })), `sid:${sid}`, "AK3 keys: flag on — a session from a Google address still keys on the session");
      assertEq(mcpPrimaryKey(fakeReq({ ip: GOOGLE_B, consumerKeyId: 42 })), "key:42", "AK3 keys: flag on — a recognized key from a Google address still keys on the key");
      assertEq(
        mcpCartToolKey({ ip: GOOGLE_A, body: { method: "tools/call", params: { name: "lokal_cart_submit", arguments: { buyer_ref: "b1" } } } } as any),
        `${GOOGLE_RANGES_BUCKET}:b1`,
        "AK3 keys: flag on — cart key is google-ranges:buyer_ref"
      );
    } finally {
      setFlag(prevFlag);
    }

    // Behavioural: a small profile on injected stores; client IP set via
    // X-Forwarded-For with `trust proxy` on, as in production.
    const smallProfile = (stores: Partial<Record<McpLimiterName, MemoryStore>>): McpRateLimitProfile => ({
      brake: { windowMs: 60_000, max: 1000 },
      primary: { windowMs: 60_000, anonymousMax: 3, keyedMax: 3 },
      sideEffect: { windowMs: 60_000, max: 2, tools: new Set(["book_gardssalg"]), keyGenerator: mcpIpKey },
      createStore: (limiter) => (stores[limiter] = new MemoryStore()),
    });
    const runWith = async (
      flag: string | undefined,
      fn: (call: (ip: string, id: number, tool?: string) => ReturnType<typeof postJson>, stores: Partial<Record<McpLimiterName, MemoryStore>>) => Promise<void>
    ) => {
      setFlag(flag);
      const stores: Partial<Record<McpLimiterName, MemoryStore>> = {};
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json());
      app.use("/mcp", createMcpRateLimiters(smallProfile(stores)).chain);
      app.post("/mcp", ok);
      const { port, close } = await startServer(app);
      try {
        const call = (ip: string, id: number, tool = "discover_experiences") =>
          postJson(port, "/mcp", JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: {} } }), {
            "Content-Type": "application/json",
            "X-Forwarded-For": ip,
          });
        await fn(call, stores);
      } finally {
        await close();
        setFlag(prevFlag);
      }
    };

    // AK2: flag off — a Google address is limited per IP, exactly as today.
    await runWith(undefined, async (call, stores) => {
      const a = [];
      for (let i = 1; i <= 4; i++) a.push((await call(GOOGLE_A, i)).status);
      assertEq(a, [200, 200, 200, 429], "AK2: flag off — the 4th call from one Google address is over ITS per-IP primary quota (3)");
      const b = await call(GOOGLE_B, 5);
      assertEq(b.status, 200, "AK2: flag off — another Google address has its own, fresh per-IP bucket");
      assertEq([b.headers["ratelimit-limit"], b.headers["ratelimit-remaining"]], ["3", "2"], "AK2: flag off — per-IP limit headers unchanged (limit 3)");
      assertEq((await stores.primary!.get(`ip:${GOOGLE_A}`))?.totalHits, 4, "AK2: flag off — counted under the Google address's own ip: key");
      assertEq(await stores.primary!.get(`ip:${GOOGLE_RANGES_BUCKET}`), undefined, "AK2: flag off — the Google bucket is never used");
    });

    // AK3: flag on — Google addresses share one bucket; others stay per IP.
    await runWith("true", async (call, stores) => {
      const sharedLimit = String(3 * GOOGLE_RANGES_LIMIT_MULTIPLIER);
      const a = await call(GOOGLE_A, 1);
      const b = await call(GOOGLE_B, 2);
      const c = await call(GOOGLE_V6, 3);
      assertEq([a.status, b.status, c.status], [200, 200, 200], "AK3: flag on — calls from three Google addresses pass");
      assertEq(
        [a.headers["ratelimit-limit"], a.headers["ratelimit-remaining"], b.headers["ratelimit-remaining"], c.headers["ratelimit-remaining"]],
        [sharedLimit, String(3 * GOOGLE_RANGES_LIMIT_MULTIPLIER - 1), String(3 * GOOGLE_RANGES_LIMIT_MULTIPLIER - 2), String(3 * GOOGLE_RANGES_LIMIT_MULTIPLIER - 3)],
        "AK3: flag on — two different Google IPv4 addresses and one IPv6 count down ONE shared counter, with its own limit (3 × multiplier)"
      );
      assertEq((await stores.primary!.get(`ip:${GOOGLE_RANGES_BUCKET}`))?.totalHits, 3, "AK3: flag on — the primary counted all three in the Google bucket");
      assertEq((await stores.brake!.get(GOOGLE_RANGES_BUCKET))?.totalHits, 3, "AK3: flag on — so did the brake");
      assertEq(
        [await stores.primary!.get(`ip:${GOOGLE_A}`), await stores.primary!.get(`ip:${GOOGLE_B}`), await stores.brake!.get(GOOGLE_A)],
        [undefined, undefined, undefined],
        "AK3: flag on — nothing counted against the Google addresses' per-IP buckets"
      );

      const o = [];
      for (let i = 1; i <= 4; i++) o.push((await call(OTHER, 10 + i)).status);
      assertEq(o, [200, 200, 200, 429], "AK3: flag on — a non-Google address is still limited per IP (3)");
      const g = await call(GOOGLE_A, 20);
      assertEq(g.status, 200, "AK3: flag on — the non-Google burst never touched the Google bucket");

      const se = [];
      for (let i = 1; i <= 3; i++) se.push((await call(GOOGLE_B, 30 + i, "book_gardssalg")).status);
      assertEq(se, [200, 200, 200], "AK3: flag on — the side-effect quota for the Google bucket is 2 × multiplier, not 2");
      assertEq((await stores.sideEffect!.get(GOOGLE_RANGES_BUCKET))?.totalHits, 3, "AK3: flag on — side-effect calls counted in the Google bucket");
    });
  }

  // ── Source guard: the limiters the profiles mirror, and RFB's mount ─────
  {
    const fs = require("fs");
    const path = require("path");
    const secSrc: string = fs.readFileSync(path.join(__dirname, "security.ts"), "utf8");
    assertTrue(
      /export const cartWishesLimiter = rateLimit\(\{[\s\S]{0,300}windowMs:\s*60\s*\*\s*1000[\s\S]{0,100}max:\s*20/.test(secSrc),
      "cartWishesLimiter (security.ts): still windowMs 60*1000 / max 20 — unchanged, confirms the cart quota really mirrors it"
    );
    assertTrue(
      /export const dentalLimiter = rateLimit\(\{[\s\S]{0,400}max:\s*1000/.test(secSrc),
      "dentalLimiter (security.ts): still max 1000 — unchanged (/api/tannlege + dental /a2a keep it)"
    );
    assertTrue(
      /export const jsonRpcLimiter = rateLimit\(\{[\s\S]{0,400}max:\s*keyedMax\(200,\s*600\)/.test(secSrc),
      "jsonRpcLimiter (security.ts): still keyedMax(200, 600) — unchanged (/a2a keeps it)"
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
