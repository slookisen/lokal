/**
 * mcp-rate-limit-verticals.test.ts — dev-request
 * 2026-10-16-mcp-rate-limit-dental-opplevagent-per-okt, S1 + S2.
 *
 * Opplevagent's and Finn-tannlege's /mcp routers used to rate-limit per IP
 * with buckets they shared with other surfaces (jsonRpcLimiter: also /a2a;
 * dentalLimiter: also /api/tannlege and dental /a2a). Each router now mounts
 * its own chain from createMcpRateLimiters() (middleware/mcp-rate-limit.ts),
 * keyed per MCP session. This file drives the REAL routers over real HTTP
 * (the SDK's StreamableHTTPServerTransport needs a real Node req/res pair —
 * same approach as mcp-session-404.test.ts) and covers:
 *
 *   (a) a burst on session A gets 429 with the JSON-RPC body
 *       {jsonrpc: "2.0", error: {code: -32000}, id: <id>}, while a new
 *       session B from the same IP gets 200 — through the real router's
 *       session map, with a scaled-down copy of the vertical's profile in
 *       front (the production ceilings are too large to burst in a test).
 *       S2 on the same path: well-formed but made-up session ids share the
 *       IP bucket (404 while it has room, then 429), and live sessions keep
 *       working after it is exhausted.
 *   (d) in process: the router's OWN chain (production profile) answers
 *       initialize with RateLimit-Limit 200 (600 with a valid key) on
 *       Opplevagent and 1000 on Finn-tannlege, and two sessions from one IP
 *       count down independent RateLimit-Remaining.
 *   (b) Opplevagent /mcp calls do not count down /a2a's jsonRpcLimiter (nor
 *       the other way round); Finn-tannlege /mcp calls do not count down
 *       /api/tannlege's dentalLimiter.
 *   RFB: its exported chain (mounted in index.ts) in front of the real RFB
 *       router — initialize/tools/list keep RateLimit-Limit 200 (600 with a
 *       key), a live session has its own bucket, and a made-up session id is
 *       counted in the IP bucket (S2).
 *   (c) annotation parity: every tool a router registers without
 *       readOnlyHint: true is in its profile's side-effect set, and every
 *       name in that set is a registered tool (so a renamed tool or a later
 *       alias cannot escape the quota). Finn-tannlege has no such tool and no
 *       side-effect quota.
 *
 * Isolation: every scenario sends its own random X-Forwarded-For address
 * (from 100.64.0.0/10, which no other suite uses) with `trust proxy` on, and
 * session ids are fresh UUIDs, so the module-level limiters these routers
 * share with the rest of `npm test` start from an empty bucket here and are
 * left with nothing another suite counts on. Node's http client, never the
 * global fetch (tests/test.ts: other blocks stub globalThis.fetch).
 *
 * Standalone: npx tsx src/middleware/mcp-rate-limit-verticals.test.ts
 * Wired into the gate via tests/test.ts (runSerial, tail position).
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface McpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
}

const MCP_ACCEPT = "application/json, text/event-stream";

// A JSON-RPC response body may be plain JSON or an SSE stream
// ("event: message\ndata: {...}") depending on the transport's negotiation —
// same parsing as mcp-session-404.test.ts. A 202 (notification) has no body.
function parseBody(text: string, contentType: string | undefined): any {
  if (!text) return undefined;
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    return dataLine ? JSON.parse(dataLine.slice("data:".length).trim()) : undefined;
  }
  try { return JSON.parse(text); } catch { return undefined; }
}

function request(port: number, method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown): Promise<McpResponse> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...headers, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: parseBody(text, res.headers["content-type"]) });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startServer(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let ipCounter = 0;
// A fresh client address per scenario: 100.64.0.0/10 (shared address space),
// randomised per process and counted within it, so no two scenarios — and no
// other suite — ever share a bucket.
function freshClientIp(): string {
  ipCounter++;
  const r = (n: number) => Math.floor(Math.random() * n);
  return `100.${64 + r(64)}.${ipCounter % 256}.${1 + r(254)}`;
}

// Stand-in for consumerIdentity, DB-free (same reason as
// consumer-identity-rate-limit.test.ts): only VALID_TEST_KEY is recognized.
const VALID_TEST_KEY = "rfb_valid_test_key";
function fakeConsumerIdentity(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  if (req.header("X-API-Key") === VALID_TEST_KEY) req.consumerKeyId = 11;
  next();
}

// One MCP client against one /mcp mount, always from the same address.
function mcpClient(port: number, ip: string, extraHeaders: Record<string, string> = {}) {
  const base = { Accept: MCP_ACCEPT, "X-Forwarded-For": ip, ...extraHeaders };
  let rpcId = 0;
  return {
    async initialize(): Promise<{ res: McpResponse; sessionId: string | undefined }> {
      const res = await request(port, "POST", "/mcp", base, {
        jsonrpc: "2.0",
        id: `init-${++rpcId}`,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-rate-limit-verticals-test", version: "1.0.0" } },
      });
      return { res, sessionId: res.headers["mcp-session-id"] as string | undefined };
    },
    initialized(sessionId: string): Promise<McpResponse> {
      return request(port, "POST", "/mcp", { ...base, "Mcp-Session-Id": sessionId }, { jsonrpc: "2.0", method: "notifications/initialized" });
    },
    toolsList(sessionId: string, id: number): Promise<McpResponse> {
      return request(port, "POST", "/mcp", { ...base, "Mcp-Session-Id": sessionId }, { jsonrpc: "2.0", id, method: "tools/list", params: {} });
    },
  };
}

interface VerticalCase {
  label: string;
  routerPath: string;
  hasSessionExport: string;
  profileKey: "experiences" | "dental";
  anonLimit: string;
  keyedLimit: string;
}

const VERTICALS: VerticalCase[] = [
  { label: "opplevagent", routerPath: "../routes/experiences-mcp", hasSessionExport: "hasExperiencesMcpSession", profileKey: "experiences", anonLimit: "200", keyedLimit: "600" },
  { label: "dental", routerPath: "../routes/dental-mcp", hasSessionExport: "hasDentalMcpSession", profileKey: "dental", anonLimit: "1000", keyedLimit: "1000" },
];

export async function runMcpRateLimitVerticalsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  // Same belt-and-braces DB-path guard as mcp-session-404.test.ts: none of
  // the calls below (initialize, notifications, tools/list) reads a DB, but a
  // standalone run must never open the production DB files if that stops
  // holding. Only effective before database/init.ts is first loaded.
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevDbPath = process.env.DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.DB_PATH = ":memory:";

  try {
    const mrl = require("./mcp-rate-limit") as typeof import("./mcp-rate-limit");
    const sec = require("./security") as typeof import("./security");

    for (const v of VERTICALS) {
      const mod = require(v.routerPath) as { default: express.Router } & Record<string, unknown>;
      const router = mod.default;
      const hasSession = mod[v.hasSessionExport] as (id: string) => boolean;
      assertTrue(typeof hasSession === "function", `${v.label}: router exports ${v.hasSessionExport}()`);

      // ── (a) + S2: scaled-down profile in front of the real router ───────
      {
        const low = mrl.createMcpRateLimiters({
          ...mrl.MCP_RATE_LIMIT_PROFILES[v.profileKey],
          brake: { windowMs: 60_000, max: 100 },
          primary: { windowMs: 60_000, anonymousMax: 3, keyedMax: 3 },
          isKnownSession: hasSession,
        });
        const app = express();
        app.set("trust proxy", true);
        app.use(express.json());
        app.use("/mcp", low.chain, router);
        const { port, close } = await startServer(app);
        try {
          const c = mcpClient(port, freshClientIp());
          const a = await c.initialize(); // IP bucket: 1 of 3
          assertEq(a.res.status, 200, `${v.label} a1: initialize session A -> 200`);
          const sidA = a.sessionId ?? "";
          assertTrue(hasSession(sidA), `${v.label} a2: the router holds session A`);
          const n = await c.initialized(sidA); // A: 1 of 3
          assertEq(n.status, 202, `${v.label} a3: notifications/initialized on A -> 202`);
          const a2 = await c.toolsList(sidA, 2); // A: 2
          const a3 = await c.toolsList(sidA, 3); // A: 3
          assertEq([a2.status, a3.status], [200, 200], `${v.label} a4: session A up to its quota -> 200`);
          const a4 = await c.toolsList(sidA, 4); // A: 4 > 3
          assertEq(a4.status, 429, `${v.label} a5: session A over its quota -> 429`);
          assertEq(
            { jsonrpc: a4.json?.jsonrpc, code: a4.json?.error?.code, id: a4.json?.id },
            { jsonrpc: "2.0", code: -32000, id: 4 },
            `${v.label} a6: 429 body is {jsonrpc: "2.0", error: {code: -32000}, id: <request id>}`
          );

          const b = await c.initialize(); // IP bucket: 2 of 3
          assertEq(b.res.status, 200, `${v.label} a7: a new session B from the same IP initializes -> 200`);
          const sidB = b.sessionId ?? "";
          await c.initialized(sidB); // B: 1
          const b1 = await c.toolsList(sidB, 1); // B: 2
          assertEq(b1.status, 200, `${v.label} a8: session B is unaffected by A's exhausted quota -> 200`);
          assertTrue(Array.isArray(b1.json?.result?.tools) && b1.json.result.tools.length > 0, `${v.label} a9: … and gets the tool list`);

          // S2: a well-formed id the router never minted is no identity — it
          // is counted in the IP bucket, not in a fresh bucket of its own.
          const fake1 = await c.toolsList(randomUUID(), 5); // IP bucket: 3 of 3
          assertEq(fake1.status, 404, `${v.label} s2-1: a made-up session id reaches the router (404) while the IP bucket has room`);
          const fake2 = await c.toolsList(randomUUID(), 6); // IP bucket: 4 > 3
          assertEq(fake2.status, 429, `${v.label} s2-2: the next made-up session id gets no new bucket -> 429 from the shared IP bucket`);
          const b2 = await c.toolsList(sidB, 7); // B: 3
          assertEq(b2.status, 200, `${v.label} s2-3: a live session keeps working once the IP bucket is exhausted`);
        } finally {
          await close();
        }
      }

      // ── (d) in process: the router's own chain, production profile ───────
      {
        const app = express();
        app.set("trust proxy", true);
        app.use(express.json());
        app.use(fakeConsumerIdentity);
        app.use("/mcp", router);
        const { port, close } = await startServer(app);
        try {
          const c = mcpClient(port, freshClientIp());
          const a = await c.initialize(); // IP bucket: 1
          assertEq(
            [a.res.headers["ratelimit-limit"], a.res.headers["ratelimit-policy"]],
            [v.anonLimit, `${v.anonLimit};w=900`],
            `${v.label} d1: initialize -> RateLimit-Limit ${v.anonLimit} per 15 minutes (own chain, not the old shared limiter)`
          );
          const sidA = a.sessionId ?? "";
          const a1 = await c.initialized(sidA);
          const a2 = await c.toolsList(sidA, 1);
          const anon = Number(v.anonLimit);
          assertEq(
            [a1.headers["ratelimit-remaining"], a2.headers["ratelimit-remaining"]],
            [String(anon - 1), String(anon - 2)],
            `${v.label} d2: session A counts down its own bucket`
          );
          const b = await c.initialize(); // IP bucket: 2
          const b1 = await c.initialized(b.sessionId ?? "");
          assertEq(b1.headers["ratelimit-remaining"], String(anon - 1), `${v.label} d3: session B from the same IP has an independent RateLimit-Remaining`);

          // S2 on the production chain: a made-up id lands in the IP bucket.
          const fake = await c.toolsList(randomUUID(), 2); // IP bucket: 3
          assertEq(
            [fake.status, fake.headers["ratelimit-remaining"]],
            [404, String(anon - 3)],
            `${v.label} d4: a made-up session id is counted in the IP bucket (2 initializes + it)`
          );

          const keyed = await mcpClient(port, freshClientIp(), { "X-API-Key": VALID_TEST_KEY }).initialize();
          assertEq(keyed.res.headers["ratelimit-limit"], v.keyedLimit, `${v.label} d5: initialize with a valid key -> RateLimit-Limit ${v.keyedLimit}`);
          const fakeKey = await mcpClient(port, freshClientIp(), { "X-API-Key": "rfb_fake_" + randomUUID() }).initialize();
          assertEq(fakeKey.res.headers["ratelimit-limit"], v.anonLimit, `${v.label} d6: initialize with an unrecognized key -> the anonymous ${v.anonLimit}`);
        } finally {
          await close();
        }
      }
    }

    // ── (b) /mcp and the other surfaces' limiters share no bucket ────────────
    {
      const oaRouter = (require("../routes/experiences-mcp") as { default: express.Router }).default;
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json());
      app.post("/a2a", sec.jsonRpcLimiter, (_req, res) => res.json({ ok: true }));
      app.use("/mcp", oaRouter);
      const { port, close } = await startServer(app);
      try {
        const ip = freshClientIp();
        const c = mcpClient(port, ip);
        const a = await c.initialize();
        await c.initialized(a.sessionId ?? "");
        for (let i = 1; i <= 3; i++) await c.toolsList(a.sessionId ?? "", i);
        assertEq(await sec.jsonRpcLimiter.getKey(mrl.mcpIpKey({ ip } as any)), undefined, "b1: 5 Opplevagent /mcp calls left jsonRpcLimiter's bucket for that IP untouched");
        const a2a = await request(port, "POST", "/a2a", { "X-Forwarded-For": ip }, { jsonrpc: "2.0", id: 1, method: "message/send" });
        assertEq(a2a.headers["ratelimit-remaining"], "199", "b2: the first /a2a call from that IP sees a fresh jsonRpcLimiter bucket (199 left)");
        const again = await c.initialize();
        assertEq(again.res.headers["ratelimit-remaining"], "198", "b3: … and /a2a did not count down Opplevagent's /mcp IP bucket (only its 2 initializes)");
      } finally {
        await close();
      }
    }
    {
      const dentalRouter = (require("../routes/dental-mcp") as { default: express.Router }).default;
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json());
      app.get("/api/tannlege/ping", sec.dentalLimiter, (_req, res) => res.json({ ok: true }));
      app.use("/mcp", dentalRouter);
      const { port, close } = await startServer(app);
      try {
        const ip = freshClientIp();
        const c = mcpClient(port, ip);
        const a = await c.initialize();
        await c.initialized(a.sessionId ?? "");
        for (let i = 1; i <= 3; i++) await c.toolsList(a.sessionId ?? "", i);
        assertEq(await sec.dentalLimiter.getKey(mrl.mcpIpKey({ ip } as any)), undefined, "b4: 5 Finn-tannlege /mcp calls left dentalLimiter's bucket for that IP untouched");
        const rest = await request(port, "GET", "/api/tannlege/ping", { "X-Forwarded-For": ip });
        assertEq(rest.headers["ratelimit-remaining"], "999", "b5: the first /api/tannlege call from that IP sees a fresh dentalLimiter bucket (999 left)");
      } finally {
        await close();
      }
    }

    // ── RFB: the exported chain (index.ts) in front of the real RFB router ───
    {
      const rfbRouter = (require("../routes/mcp") as { default: express.Router }).default;
      const app = express();
      app.set("trust proxy", true);
      app.use(express.json());
      app.use(fakeConsumerIdentity);
      app.use("/mcp", mrl.mcpIpEmergencyBrakeLimiter, mrl.mcpPrimaryLimiter, mrl.mcpCartToolLimiter, rfbRouter);
      const { port, close } = await startServer(app);
      try {
        const ip = freshClientIp();
        const c = mcpClient(port, ip);
        const a = await c.initialize();
        assertEq(
          [a.res.status, a.res.headers["ratelimit-limit"], a.res.headers["ratelimit-policy"]],
          [200, "200", "200;w=900"],
          "rfb r1: initialize unchanged — 200 with RateLimit-Limit 200 per 15 minutes"
        );
        const sidA = a.sessionId ?? "";
        await c.initialized(sidA);
        const list = await c.toolsList(sidA, 1);
        assertEq(
          [list.status, list.headers["ratelimit-limit"], list.headers["ratelimit-remaining"]],
          [200, "200", "198"],
          "rfb r2: tools/list unchanged — 200, RateLimit-Limit 200, counted in session A's own bucket"
        );
        assertEq((await mrl.mcpPrimaryLimiter.getKey(`sid:${sidA}`))?.totalHits, 2, "rfb r3: a live session has its own bucket in mcpPrimaryLimiter");

        const fakeSid = randomUUID();
        const fake = await c.toolsList(fakeSid, 2);
        assertEq(fake.status, 404, "rfb r4: a made-up session id still gets the router's 404");
        assertEq(await mrl.mcpPrimaryLimiter.getKey(`sid:${fakeSid}`), undefined, "rfb r5 (S2): … and no bucket of its own");
        assertEq(
          (await mrl.mcpPrimaryLimiter.getKey(`ip:${mrl.mcpIpKey({ ip } as any)}`))?.totalHits,
          2,
          "rfb r6 (S2): it is counted in the IP bucket (initialize + it)"
        );

        const keyed = await mcpClient(port, freshClientIp(), { "X-API-Key": VALID_TEST_KEY }).initialize();
        assertEq(keyed.res.headers["ratelimit-limit"], "600", "rfb r7: initialize with a valid key -> RateLimit-Limit 600, unchanged");
      } finally {
        await close();
      }
    }

    // ── (c) annotation parity: side-effect sets == non-read-only tools ───────
    {
      type Registered = Record<string, { annotations?: { readOnlyHint?: boolean } }>;
      const nonReadOnlyTools = (register: (s: McpServer) => void): string[] => {
        const server = new McpServer({ name: "rate-limit-parity", version: "0.0.0" });
        register(server);
        const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
        return Object.entries(tools)
          .filter(([, t]) => t.annotations?.readOnlyHint !== true)
          .map(([name]) => name)
          .sort();
      };
      const registeredNames = (register: (s: McpServer) => void): Set<string> => {
        const server = new McpServer({ name: "rate-limit-parity", version: "0.0.0" });
        register(server);
        return new Set(Object.keys((server as unknown as { _registeredTools: Registered })._registeredTools));
      };

      const oa = require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp");
      const oaSet = oa.EXPERIENCES_MCP_SIDE_EFFECT_TOOLS;
      assertTrue(oaSet === mrl.MCP_RATE_LIMIT_PROFILES.experiences.sideEffect.tools, "c1: EXPERIENCES_MCP_SIDE_EFFECT_TOOLS is the set the experiences profile meters");
      const oaWrites = nonReadOnlyTools((s) => oa.registerExperienceTools(s));
      assertTrue(oaWrites.length > 0, "c2: Opplevagent registers at least one tool without readOnlyHint: true (book_gardssalg)");
      for (const name of oaWrites) {
        assertTrue(oaSet.has(name), `c3: Opplevagent tool ${name} (not read-only) is in EXPERIENCES_MCP_SIDE_EFFECT_TOOLS`);
      }
      const oaNames = registeredNames((s) => oa.registerExperienceTools(s));
      for (const name of oaSet) {
        assertTrue(oaNames.has(name), `c4: EXPERIENCES_MCP_SIDE_EFFECT_TOOLS entry ${name} is a registered Opplevagent tool`);
      }

      const rfb = require("../routes/mcp") as typeof import("../routes/mcp");
      assertEq(nonReadOnlyTools((s) => rfb.registerTools(s)), [...mrl.CART_SIDE_EFFECT_TOOLS].sort(), "c5: RFB's non-read-only tools are exactly CART_SIDE_EFFECT_TOOLS");

      const dental = require("../routes/dental-mcp") as typeof import("../routes/dental-mcp");
      assertEq(nonReadOnlyTools((s) => dental.registerDentalTools(s)), [], "c6: Finn-tannlege registers no tool without readOnlyHint: true — matching its profile's missing side-effect quota");
      assertTrue(!("sideEffect" in mrl.MCP_RATE_LIMIT_PROFILES.dental), "c7: the dental profile has no side-effect quota");
    }
  } catch (err: any) {
    failed++;
    failures.push(`mcp-rate-limit-verticals: unexpected error: ${err?.stack || err?.message || String(err)}`);
  } finally {
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMcpRateLimitVerticalsTests({ log: true }).then((r) => {
    console.log(`\nmcp-rate-limit-verticals: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
