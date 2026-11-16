/**
 * mcp-stale-id-recovery.test.ts — F1-3 (A2A dev-request
 * 2026-11-12-f1-felles-for-ai-kanalene): an assistant that still holds an
 * `mcp-session-id` from before a deploy keeps working.
 *
 * Per vertical (rfb, dental, opplevagent), over a real HTTP server:
 *   AK1  the MCP SDK's own client, given a stale id (`sessionId` option, so it
 *        skips `initialize` exactly as a client resuming after a deploy does),
 *        gets an answer to tools/list, and its next calls (ping, tools/list)
 *        from the same client also succeed. Before F1-3 the first call threw
 *        StreamableHTTPError 404 and the SDK client kept the stale id.
 *   AK2  the tools/list answered without a session is byte-identical to the
 *        tools/list of a fully initialized session.
 *   The stateless answer sends no Mcp-Session-Id header and adopts nothing:
 *   a later `initialize` with the same stale id still mints a fresh id.
 *   A notification or a session-bound request with the stale id still 404s,
 *   and so does any request with an id this process ended itself (DELETE).
 *
 * Run standalone: npx tsx src/routes/mcp-stale-id-recovery.test.ts
 * Wired into `npm test` from tests/test.ts.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isMcpStatelessRequestBody, shouldServeUnknownMcpIdStateless, TerminatedMcpIds } from "../services/mcp-stale-id-recovery";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const VERTICALS = [
  { label: "rfb", routerPath: "./mcp", sampleToolName: "lokal_search" },
  { label: "dental", routerPath: "./dental-mcp", sampleToolName: "tannlege_search" },
  { label: "opplevagent", routerPath: "./experiences-mcp", sampleToolName: "discover_experiences" },
];

function jsonRpcFromBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in " + text.slice(0, 200));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

export function runMcpStaleIdRecoveryTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertTrue = (cond: boolean, label: string): void => {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  };

  return (async () => {
    // ── Unit: which bodies are answered without a session ──────────────
    const known = (id: string) => id === "live";
    const req = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: {} });
    assertTrue(isMcpStatelessRequestBody(req("tools/list")), "u1: tools/list is stateless");
    assertTrue(isMcpStatelessRequestBody(req("tools/call")), "u2: tools/call is stateless");
    assertTrue(isMcpStatelessRequestBody([req("ping"), req("tools/list")]), "u3: a batch of stateless requests is stateless");
    assertTrue(!isMcpStatelessRequestBody(req("initialize")), "u4: initialize is not answered statelessly");
    assertTrue(!isMcpStatelessRequestBody(req("resources/subscribe")), "u5: resources/subscribe is not stateless");
    assertTrue(!isMcpStatelessRequestBody({ jsonrpc: "2.0", method: "notifications/initialized" }), "u6: a notification is not stateless");
    assertTrue(!isMcpStatelessRequestBody([req("tools/list"), req("logging/setLevel")]), "u7: a mixed batch is not stateless");
    assertTrue(!isMcpStatelessRequestBody([]), "u8: an empty batch is not stateless");
    assertTrue(shouldServeUnknownMcpIdStateless("stale", known, req("tools/list")), "u9: unknown id + tools/list is served");
    assertTrue(!shouldServeUnknownMcpIdStateless("live", known, req("tools/list")), "u10: a live id goes to its session");
    assertTrue(!shouldServeUnknownMcpIdStateless(undefined, known, req("tools/list")), "u11: no id at all keeps the existing handling");
    assertTrue(!shouldServeUnknownMcpIdStateless("", known, req("tools/list")), "u12: an empty id keeps the existing handling");

    const ended = new TerminatedMcpIds(2, 1000);
    ended.add("a", 0);
    ended.add("b", 0);
    assertTrue(ended.has("a", 10) && ended.has("b", 10), "u13: an ended id is remembered");
    ended.add("c", 0);
    assertTrue(!ended.has("a", 10) && ended.size === 2, "u14: the oldest id is dropped past maxEntries");
    assertTrue(!ended.has("b", 2000), "u15: an ended id is forgotten after keepMs");

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
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const post = (body: unknown, sessionId?: string) =>
          fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify(body),
          });
        const staleId = `stale-before-deploy-${v.label}`;

        // ── AK1: the SDK client with a stale id recovers without help ────
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { sessionId: staleId });
        const client = new Client({ name: "stale-id-test-client", version: "1.0.0" });
        await client.connect(transport); // sessionId set -> no initialize, as after a deploy
        const first = await client.listTools();
        assertTrue(first.tools.some((t) => t.name === v.sampleToolName), `${v.label} ak1a: first call with a stale id returns the tool list`);
        const pong = await client.ping();
        assertTrue(!!pong && typeof pong === "object", `${v.label} ak1b: the next call (ping) from the same client succeeds`);
        const second = await client.listTools();
        assertTrue(second.tools.length === first.tools.length, `${v.label} ak1c: a third call (tools/list) succeeds with the same tools`);
        assertTrue(transport.sessionId === staleId, `${v.label} ak1d: the server sent no new session id, so the client still holds its own`);
        await transport.close();

        // ── AK2: stateless tools/list == initialized-session tools/list ──
        const init = await post({
          jsonrpc: "2.0", id: "i1", method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stale-id-test-client", version: "1.0.0" } },
        }, staleId);
        assertTrue(init.ok, `${v.label} s1: initialize with the stale id succeeds (got ${init.status})`);
        const liveId = init.headers.get("mcp-session-id");
        assertTrue(!!liveId && liveId !== staleId, `${v.label} s2: initialize mints a fresh id, the stale one was never stored`);
        await init.text();
        await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, liveId!)).text();

        const liveList = await post({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }, liveId!);
        const liveTools = jsonRpcFromBody(await liveList.text(), liveList.headers.get("content-type")).result?.tools;
        const staleList = await post({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }, staleId);
        assertTrue(staleList.status === 200, `${v.label} ak2a: raw tools/list with the stale id returns 200 (got ${staleList.status})`);
        assertTrue(staleList.headers.get("mcp-session-id") === null, `${v.label} ak2b: the stateless answer sends no Mcp-Session-Id header`);
        const staleTools = jsonRpcFromBody(await staleList.text(), staleList.headers.get("content-type")).result?.tools;
        assertTrue(
          Array.isArray(liveTools) && JSON.stringify(staleTools) === JSON.stringify(liveTools),
          `${v.label} ak2c: tools/list without a session is byte-identical to a live session's tools/list`,
        );

        // ── Session-bound messages with the stale id still get the 404 ──
        const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, staleId);
        assertTrue(note.status === 404, `${v.label} n1: a notification with the stale id still returns 404 (got ${note.status})`);
        await note.text();
        const sub = await post({ jsonrpc: "2.0", id: 9, method: "resources/subscribe", params: { uri: "x:/y" } }, staleId);
        const subBody = await sub.json().catch(() => null);
        assertTrue(sub.status === 404 && subBody?.error?.code === -32001, `${v.label} n2: resources/subscribe with the stale id still returns 404 -32001`);

        // ── An id this process ended (DELETE) keeps the spec's 404 ──────
        const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": liveId! } });
        await del.text();
        const afterDelete = await post({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }, liveId!);
        const afterDeleteBody = await afterDelete.json().catch(() => null);
        assertTrue(
          afterDelete.status === 404 && afterDeleteBody?.error?.code === -32001,
          `${v.label} t1: tools/list with an id this process ended returns 404 -32001 (got ${afterDelete.status})`,
        );
      } catch (err: any) {
        failed++;
        failures.push(`✗ ${v.label}: unexpected error — ${err?.stack || err?.message || err}`);
      } finally {
        if (server) {
          server.closeAllConnections?.();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
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
  runMcpStaleIdRecoveryTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
