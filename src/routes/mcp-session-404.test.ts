/**
 * mcp-session-404.test.ts — bug fix: unknown/expired mcp-session-id must
 * 404, not silently spin up a new uninitialized session.
 *
 * Both `getOrCreateDentalSession()` (src/routes/dental-mcp.ts) and
 * `getOrCreateSession()` (src/routes/mcp.ts) used to do
 * `const id = sessionId || randomUUID();` — so a client sending an
 * `mcp-session-id` header the server no longer recognises (expired, or the
 * in-memory Map wiped by a Fly machine restart on deploy) got a BRAND NEW
 * session created under its own client-supplied id, instead of the 404 the
 * MCP spec requires. That new session's transport was never actually
 * `initialize`d, so the very call that triggered its creation (e.g.
 * `tools/list`) then failed anyway, with a misleading
 * `400 "Server not initialized"` instead of the 404 that tells a
 * well-behaved client to re-run `initialize`. This caused a live external
 * monitoring false-positive (Glama reported finn-tannlege "unhealthy"
 * right after a deploy).
 *
 * Fix: src/services/mcp-session-protocol.ts (shared, side-effect-free
 * helpers) + both route files now:
 *   1. Return 404 (JSON-RPC `-32001 "Session not found"`, same shape the
 *      MCP SDK's own transport uses for this exact case) for a PROVIDED but
 *      unrecognised session id on a non-`initialize` request, WITHOUT
 *      inserting anything into the session map.
 *   2. Always mint the server's OWN session id on `initialize` — a
 *      client-supplied `mcp-session-id` is never adopted, whether or not it
 *      happens to already be in the map.
 *   3. GET /mcp with no valid session and a non-HTML Accept header now also
 *      404s (same premise, same body) instead of 400. The HTML
 *      landing-page branch (browser GET, no session) is unchanged — see
 *      mcp-browser-landing-page.test.ts for that surface.
 *
 * Covers, per vertical (rfb via src/routes/mcp.ts, dental via
 * src/routes/dental-mcp.ts, opplevagent via src/routes/experiences-mcp.ts):
 *   (a) tools/list with an unknown/expired mcp-session-id -> 404, JSON-RPC
 *       `-32001` body, and the session map did NOT grow from that request —
 *       proven behaviorally (no direct access to the module-private Map):
 *       a following `initialize` reusing THAT SAME bogus id must mint a
 *       FRESH server id rather than "finding" a phantom session and
 *       adopting the client's id, which is exactly what the pre-fix
 *       `id = sessionId || randomUUID()` bug would have produced, because
 *       under the bug the phantom session created by (a) would be keyed by
 *       the client's own bogus id, so the SDK transport's own
 *       `sessionIdGenerator: () => id` (`id` closed over the bogus string)
 *       would hand that same bogus id right back out on this initialize.
 *   (b) initialize with no session id at all -> 200 + Mcp-Session-Id
 *       response header present.
 *   (c) initialize WITH a client-supplied (never-before-seen) session id ->
 *       200, and the returned Mcp-Session-Id is NOT the client-supplied one.
 *   (d) full correct handshake (initialize -> notifications/initialized ->
 *       tools/list) -> 200, tool catalog unchanged (same count + known tool
 *       names as before this fix — this change touches session routing
 *       only, never tool registration).
 *   (e) browser GET (Accept: text/html) on /mcp with no session -> still
 *       200 HTML, completely unaffected (fuller coverage of this surface
 *       lives in mcp-browser-landing-page.test.ts; this is a light sanity
 *       check that the fix didn't touch it).
 *
 * Same real-HTTP-server-via-express + real MCP Streamable HTTP transport
 * approach as mcp-browser-landing-page.test.ts and
 * opplevelser-gardssalg-mcp-discoverability.test.ts (a synthetic
 * router.handle() call can't drive the SDK's StreamableHTTPServerTransport,
 * which needs a real Node request/response pair).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/mcp-session-404.test.ts
 *   2. Wired into the gate: tests/test.ts imports runMcpSession404Tests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface VerticalCase {
  label: string;
  routerPath: string;
  // Lower bound, not an exact count: an exact number couples this session-
  // handling test to every unrelated tool addition (lokal#887 adding
  // lokal_find_offers turned main red on d5 twice in one morning).
  toolListMin: number;
  sampleToolName: string;
}

const VERTICALS: VerticalCase[] = [
  { label: "rfb", routerPath: "./mcp", toolListMin: 14, sampleToolName: "lokal_search" },
  { label: "dental", routerPath: "./dental-mcp", toolListMin: 5, sampleToolName: "tannlege_search" },
  { label: "opplevagent", routerPath: "./experiences-mcp", toolListMin: 5, sampleToolName: "discover_experiences" },
];

// Parses a JSON-RPC response body that may be a raw JSON object or an SSE
// stream ("event: message\ndata: {...}\n\n") — same helper as
// opplevelser-gardssalg-mcp-discoverability.test.ts / experiences-llms-
// examples.test.ts, needed because the MCP Streamable HTTP transport can
// reply either way depending on Accept-header negotiation.
function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (!dataLine) throw new Error("no SSE data: line found in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

export function runMcpSession404Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    // Belt-and-suspenders DB-path guard, same as mcp-protocol-version.test.ts:
    // neither router should touch a database at all for tools/list-only
    // traffic (tool handlers only run on tools/call, and registration is
    // lazy), but this is cheap insurance against ever opening the
    // production DB file if that assumption stops holding.
    const prevDentalDbPath = process.env.DENTAL_DB_PATH;
    const prevDbPath = process.env.DB_PATH;
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.DB_PATH = ":memory:";

    for (const v of VERTICALS) {
      let server: http.Server | undefined;
      try {
        const routerPath = require.resolve(v.routerPath);
        delete require.cache[routerPath];
        const mcpRouter = (require(v.routerPath) as { default: express.Router }).default;

        const app = express();
        app.use(express.json());
        app.use("/mcp", mcpRouter);
        server = http.createServer(app);
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}`;

        async function post(body: unknown, sessionId?: string): Promise<Response> {
          return fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify(body),
          });
        }

        // ── (a) tools/list with an unknown/expired session id -> 404 ──────
        const bogusId = `bogus-session-${v.label}-does-not-exist`;
        const unknownRes = await post({ jsonrpc: "2.0", method: "tools/list", params: {}, id: "u1" }, bogusId);
        assertTrue(unknownRes.status === 404, `${v.label} a1: tools/list with unknown session id returns 404 (got ${unknownRes.status})`);
        const unknownBody = await unknownRes.json().catch(() => null);
        assertTrue(
          !!unknownBody && unknownBody.jsonrpc === "2.0" && unknownBody.error?.code === -32001,
          `${v.label} a2: 404 body is JSON-RPC shaped with error.code -32001 (got ${JSON.stringify(unknownBody)})`
        );

        // (a, continued) — the map-did-not-grow proof: re-send `initialize`
        // reusing the EXACT SAME bogus id. Pre-fix, (a) would have inserted
        // a session keyed by that bogus id (because
        // `id = sessionId || randomUUID()` adopts a truthy sessionId even
        // when it was unrecognised), and this initialize would then "find"
        // that phantom session and hand the very same bogus id straight
        // back out as the (fresh, never-initialized) transport's own
        // sessionIdGenerator result. Post-fix, (a) inserted nothing, so this
        // is an ordinary fresh initialize that must mint its own new id.
        const reinitRes = await post(
          { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "session-404-test-client", version: "1.0.0" } }, id: "u2" },
          bogusId
        );
        assertTrue(reinitRes.ok, `${v.label} a3: initialize after the unknown-session 404 still succeeds (got ${reinitRes.status})`);
        const reinitSessionId = reinitRes.headers.get("mcp-session-id");
        assertTrue(!!reinitSessionId, `${v.label} a4: that initialize still returns an Mcp-Session-Id header`);
        assertTrue(
          reinitSessionId !== bogusId,
          `${v.label} a5: the minted id is NOT the bogus client-supplied one — proves (a) inserted nothing into the session map (the pre-fix bug would have echoed the bogus id back here)`
        );
        await reinitRes.text();

        // ── (a2) tools/list with NO mcp-session-id header at all (never
        // sent one), and no prior initialize on this connection -> 404,
        // not a silently-created session. This is the filed dev-request's
        // own AC2 ("tools/list uten sesjon og uten forutgående initialize
        // -> 404 (ikke 400)") — a distinct input from (a) above (which
        // sends an unknown id; this sends none at all), and pre-fix this
        // path fell all the way through to the create branch since the
        // original guard was `sessionId && !isInitialize` (false when
        // sessionId is undefined).
        const noHeaderRes = await post({ jsonrpc: "2.0", method: "tools/list", params: {}, id: "nh1" });
        assertTrue(
          noHeaderRes.status === 404,
          `${v.label} a6: tools/list with NO session header and no prior initialize returns 404 (got ${noHeaderRes.status})`
        );
        const noHeaderBody = await noHeaderRes.json().catch(() => null);
        assertTrue(
          !!noHeaderBody && noHeaderBody.jsonrpc === "2.0" && noHeaderBody.error?.code === -32001,
          `${v.label} a7: that 404 body is JSON-RPC shaped with error.code -32001 (got ${JSON.stringify(noHeaderBody)})`
        );

        // ── (b) initialize with no session id at all -> 200 + header ──────
        const freshInitRes = await post({
          jsonrpc: "2.0", method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "session-404-test-client", version: "1.0.0" } },
          id: "1",
        });
        assertTrue(freshInitRes.ok, `${v.label} b1: initialize with no session id returns 2xx (got ${freshInitRes.status})`);
        const sessionId = freshInitRes.headers.get("mcp-session-id");
        assertTrue(!!sessionId, `${v.label} b2: initialize with no session id returns an Mcp-Session-Id header`);
        await freshInitRes.text();

        // ── (c) initialize WITH a client-supplied session id -> 200, and
        //     the server does NOT adopt it ───────────────────────────────
        const clientChosenId = `client-chosen-${v.label}-id-never-used-before`;
        const adoptRes = await post(
          { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "session-404-test-client", version: "1.0.0" } }, id: "2" },
          clientChosenId
        );
        assertTrue(adoptRes.ok, `${v.label} c1: initialize with a client-supplied session id returns 2xx (got ${adoptRes.status})`);
        const adoptedSessionId = adoptRes.headers.get("mcp-session-id");
        assertTrue(!!adoptedSessionId, `${v.label} c2: response carries an Mcp-Session-Id header`);
        assertTrue(
          adoptedSessionId !== clientChosenId,
          `${v.label} c3: the returned Mcp-Session-Id is NOT the client-supplied id (got ${adoptedSessionId})`
        );
        await adoptRes.text();

        // ── (d) full correct handshake -> tool catalog unchanged ──────────
        const initNotify = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId!);
        assertTrue(initNotify.status === 202, `${v.label} d1: notifications/initialized returns 202 (got ${initNotify.status})`);

        const listRes = await post({ jsonrpc: "2.0", method: "tools/list", params: {}, id: "3" }, sessionId!);
        assertTrue(listRes.ok, `${v.label} d2: tools/list on a valid session returns 2xx (got ${listRes.status})`);
        const listBody = parseJsonRpcBody(await listRes.text(), listRes.headers.get("content-type"));
        assertTrue(!("error" in listBody), `${v.label} d3: tools/list has no top-level JSON-RPC error (got ${JSON.stringify(listBody.error)})`);
        const tools = listBody.result?.tools;
        assertTrue(Array.isArray(tools), `${v.label} d4: tools/list result.tools is an array`);
        assertTrue(
          Array.isArray(tools) && tools.length >= v.toolListMin,
          `${v.label} d5: tool catalog is not truncated by this fix (expected >= ${v.toolListMin}, got ${tools?.length})`
        );
        assertTrue(
          Array.isArray(tools) && tools.some((t: any) => t.name === v.sampleToolName),
          `${v.label} d6: tool catalog still includes ${v.sampleToolName}`
        );

        // ── (e) browser GET, no session, Accept: text/html -> still 200 HTML
        // (full coverage of this surface lives in
        // mcp-browser-landing-page.test.ts; this is a light sanity check
        // that this fix didn't touch it) ───────────────────────────────────
        const htmlRes = await fetch(`${base}/mcp`, { headers: { Accept: "text/html,application/xhtml+xml" } });
        assertTrue(htmlRes.status === 200, `${v.label} e1: browser GET (no session) still returns 200 (got ${htmlRes.status})`);
        assertTrue(
          (htmlRes.headers.get("content-type") || "").includes("text/html"),
          `${v.label} e2: content-type is still text/html (got ${htmlRes.headers.get("content-type")})`
        );
        await htmlRes.text();

        // ── (f) GET with an unknown session id and a non-HTML Accept -> 404
        // (requirement 3: same premise as (a), non-HTML branch only) ───────
        const getUnknownRes = await fetch(`${base}/mcp`, { headers: { "mcp-session-id": bogusId, Accept: "application/json" } });
        assertTrue(getUnknownRes.status === 404, `${v.label} f1: GET with unknown session id (non-HTML Accept) returns 404 (got ${getUnknownRes.status})`);
        const getUnknownBody = await getUnknownRes.json().catch(() => null);
        assertTrue(
          !!getUnknownBody && getUnknownBody.jsonrpc === "2.0" && getUnknownBody.error?.code === -32001,
          `${v.label} f2: GET 404 body is the same JSON-RPC -32001 shape (got ${JSON.stringify(getUnknownBody)})`
        );
      } catch (err: any) {
        failed++;
        failures.push(`✗ ${v.label}: unexpected error — ${err?.stack || err?.message || err}`);
      } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    }

    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMcpSession404Tests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
