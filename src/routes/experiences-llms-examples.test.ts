/**
 * experiences-llms-examples.test.ts — dev-request
 * 2026-07-04-opplevagent-nl-parser-og-fylkesnormalisering, item 6.
 *
 * Verifier probe: fetches the REAL `GET /llms.txt` output from the
 * experiences app (in-process, real HTTP server so the MCP Streamable HTTP
 * transport — which needs genuine Node request/response streaming, not the
 * router.handle(fakeReq, fakeRes) shortcut most route tests in this repo
 * use — behaves exactly as it does in production) and then LITERALLY
 * EXECUTES every curl example documented in it against that same server:
 *
 *   1. MCP: the two-step Streamable HTTP handshake — `initialize` (step 1,
 *      captures the real `mcp-session-id` response header), then
 *      `tools/call` (step 2, sends that session id back). Root cause this
 *      guards: `experiences-mcp.ts` runs StreamableHTTPServerTransport in
 *      STATEFUL mode (dev-request 2026-07-10-opplevagent-conversation-logging
 *      needs per-session tracking), so a bare `tools/call` with no prior
 *      `initialize` always throws JSON-RPC -32000 "Server not initialized".
 *      This test does not hardcode the JSON-RPC bodies — it extracts them
 *      straight out of the fetched llms.txt text (the `-d '...'` payload on
 *      each curl example line), so it is pinned to the DOCUMENTED example,
 *      not to a copy of it. It also asserts exactly two MCP payload lines
 *      are documented (initialize + tools/call): the old, broken example had
 *      only one bare `tools/call` line, so this assertion alone already
 *      fails against it — and even if it didn't, executing a lone
 *      `tools/call` with no session id (what the old text described) 400s
 *      with a JSON-RPC `error`, which the 2xx-and-no-error assertions below
 *      also catch.
 *   2. A2A: the `message/send` example (`POST /a2a`).
 *   3. REST: the `discover_experiences`-equivalent example
 *      (`GET /api/opplevelser/discover?...`).
 *
 * Each call must return a 2xx HTTP status; the two JSON-RPC calls (MCP,
 * A2A) must additionally parse to a JSON-RPC envelope with no top-level
 * `error` field.
 *
 * Mirrors opplevelser-discover-relax.test.ts's EXPERIENCES_DB_PATH=":memory:"
 * + require-cache-reset pattern, but adds a real `http.createServer` (via
 * `OPPLEVAGENT_BASE_URL` pointed at 127.0.0.1:<ephemeral port>) because the
 * MCP SDK's StreamableHTTPServerTransport talks to real Node
 * IncomingMessage/ServerResponse streams and cannot be driven through the
 * synthetic req/res objects `callRoute()` helpers elsewhere in this repo use.
 *
 * Run standalone: npx tsx src/routes/experiences-llms-examples.test.ts
 * Wired into the gate via tests/test.ts (see opplevelser-discover-relax.test.ts
 * for the precedent this follows).
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Extracts the JSON body of every `-d '{...}'` curl line inside `section`
// (the JSON payloads in llms.txt are always a double-quoted JSON *object* on
// a single line, so requiring the captured text to start with `{` is enough
// to tell a real JSON-RPC payload apart from other single-quoted `-d '...'`
// curl flags in the same example, e.g. `tr -d '\r'`).
function extractCurlPayloads(section: string): string[] {
  const out: string[] = [];
  const re = /-d '(\{[^']+\})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) out.push(m[1]);
  return out;
}

// Slices the text between a heading and the next "## " heading (or EOF).
function sliceSection(text: string, headingStart: string): string {
  const start = text.indexOf(headingStart);
  if (start === -1) return "";
  const nextHeading = text.indexOf("\n## ", start + headingStart.length);
  return nextHeading === -1 ? text.slice(start) : text.slice(start, nextHeading);
}

// Parses a JSON-RPC response body that may be a raw JSON object (A2A) or an
// SSE stream (MCP Streamable HTTP: "event: message\ndata: {...}\n\n").
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

export function runExperiencesLlmsExamplesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevBaseUrl = process.env.OPPLEVAGENT_BASE_URL;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const mcpPath = require.resolve("./experiences-mcp");
    const a2aPath = require.resolve("./experiences-a2a");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath, mcpPath, a2aPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    let server: http.Server | undefined;

    try {
      const app = express();
      app.use(express.json());

      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      // OPPLEVAGENT_BASE_URL is read once at module-load time by
      // experiences-seo.ts / experiences-mcp.ts / experiences-a2a.ts, so it
      // must be set BEFORE requiring them (require.cache already cleared above).
      process.env.OPPLEVAGENT_BASE_URL = base;
      process.env.EXPERIENCES_DB_PATH = ":memory:";

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      dbFactory.getDb("experiences");

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default;
      const mcpRouter = (require("./experiences-mcp") as typeof import("./experiences-mcp")).default;
      const a2aRouter = (require("./experiences-a2a") as typeof import("./experiences-a2a")).default;
      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default;

      // Mirrors the opplevagent.no host-gate dispatch in src/index.ts:
      // /api/opplevelser/* → REST router, /mcp → MCP router, /a2a → A2A
      // router, everything else (incl. /llms.txt) → the seo router.
      app.use("/api/opplevelser", opplevelserRouter);
      app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
        const p = req.path;
        if (p === "/mcp" || p.startsWith("/mcp/")) return (mcpRouter as any)(req, res, next);
        if (p === "/a2a" || p.startsWith("/a2a/")) return (a2aRouter as any)(req, res, next);
        return (seoRouter as any)(req, res, next);
      });

      // ── Fetch the real /llms.txt output ──────────────────────────
      const llmsRes = await fetch(`${base}/llms.txt`);
      assertTrue(llmsRes.ok, `GET /llms.txt returns 2xx (got ${llmsRes.status})`);
      const llmsText = await llmsRes.text();

      // ── 1. MCP: initialize + tools/call, extracted from the MCP section ──
      const mcpSection = sliceSection(llmsText, "## MCP (Model Context Protocol)");
      assertTrue(mcpSection.length > 0, "1a: llms.txt has an MCP section");
      assertTrue(mcpSection.includes("mcp-session-id"), "1b: MCP section documents capturing mcp-session-id");

      const mcpPayloads = extractCurlPayloads(mcpSection);
      assertTrue(
        mcpPayloads.length === 2,
        `1c: MCP section documents exactly two JSON-RPC payloads (initialize + tools/call) — found ${mcpPayloads.length}` +
          (mcpPayloads.length < 2
            ? " (a bare tools/call with no prior initialize — the old, broken example — only has one)"
            : "")
      );

      if (mcpPayloads.length >= 1) {
        // Step 1: initialize
        const initRes = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: mcpPayloads[0],
        });
        assertTrue(initRes.ok, `1d: MCP initialize returns 2xx (got ${initRes.status})`);
        const sessionId = initRes.headers.get("mcp-session-id");
        assertTrue(!!sessionId, "1e: MCP initialize response carries an mcp-session-id header");
        const initBody = parseJsonRpcBody(await initRes.text(), initRes.headers.get("content-type"));
        assertTrue(!("error" in initBody), `1f: MCP initialize response has no top-level error (got ${JSON.stringify(initBody.error)})`);

        if (mcpPayloads.length >= 2) {
          // Step 2: tools/call, WITH the mcp-session-id header captured above.
          const callRes = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: mcpPayloads[1],
          });
          assertTrue(callRes.ok, `1g: MCP tools/call returns 2xx (got ${callRes.status})`);
          const callBody = parseJsonRpcBody(await callRes.text(), callRes.headers.get("content-type"));
          assertTrue(!("error" in callBody), `1h: MCP tools/call response has no top-level error (got ${JSON.stringify(callBody.error)})`);
        }
      }

      // ── 2. A2A: message/send, extracted from the A2A section ──
      const a2aSection = sliceSection(llmsText, "## A2A AI-discovery");
      assertTrue(a2aSection.length > 0, "2a: llms.txt has an A2A section");
      const a2aPayloads = extractCurlPayloads(a2aSection);
      assertTrue(a2aPayloads.length >= 1, `2b: A2A section documents at least one JSON-RPC payload — found ${a2aPayloads.length}`);

      if (a2aPayloads.length >= 1) {
        const a2aRes = await fetch(`${base}/a2a`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: a2aPayloads[0],
        });
        assertTrue(a2aRes.ok, `2c: A2A message/send returns 2xx (got ${a2aRes.status})`);
        const a2aBody = await a2aRes.json();
        assertTrue(!("error" in a2aBody), `2d: A2A message/send response has no top-level error (got ${JSON.stringify(a2aBody.error)})`);
      }

      // ── 3. REST: GET /api/opplevelser/discover, extracted from the Discovery-API section ──
      const restSection = sliceSection(llmsText, "## Discovery-API (REST)");
      assertTrue(restSection.length > 0, "3a: llms.txt has a Discovery-API (REST) section");
      const getMatch = restSection.match(/GET\s+\S*(\/api\/opplevelser\/discover\?\S*)/);
      assertTrue(!!getMatch, "3b: Discovery-API section documents a GET /api/opplevelser/discover example with query params");

      if (getMatch) {
        const restRes = await fetch(`${base}${getMatch[1]}`);
        assertTrue(restRes.ok, `3c: REST discover example returns 2xx (got ${restRes.status})`);
        // Sanity: it's the discover JSON shape, not a stray 200 from a 404 handler etc.
        const restBody = await restRes.json();
        assertTrue(restBody && restBody.vertical === "experiences", "3d: REST discover response has the expected vertical field");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-llms-examples: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevBaseUrl === undefined) {
        delete process.env.OPPLEVAGENT_BASE_URL;
      } else {
        process.env.OPPLEVAGENT_BASE_URL = prevBaseUrl;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/experiences-llms-examples.test.ts`
if (require.main === module) {
  runExperiencesLlmsExamplesTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
