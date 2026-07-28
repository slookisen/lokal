/**
 * mcp-browser-landing-page.test.ts — dev-request
 * 2026-07-19-opplevagent-forside-seksjoner-design, arbeidspunkt 6.
 *
 * Design review (2026-07-19) found `/mcp` linked from the human-facing footer
 * but returning a raw `400 {"error":"Missing or invalid mcp-session-id
 * header"}` JSON body on a plain browser GET — a real MCP client always
 * carries a session id by the time it issues a GET (it only gets one after
 * a prior POST /initialize), so "GET with no session-id header at all" is
 * exclusively the human-clicked-a-link case. experiences-mcp.ts already
 * special-cased this (Accept: text/html -> 200 branded HTML landing page);
 * this dev-request ports the identical pattern to the RFB (`mcp.ts`) and
 * dental (`dental-mcp.ts`) routers, which were still returning the raw 400
 * to browsers.
 *
 * Covers, per vertical (RFB + dental):
 *   (a) GET /mcp with Accept: text/html, no session header -> 200, HTML,
 *       vertical-branded title, links to agent-card/openapi/llms.txt.
 *   (b) GET /mcp with Accept: application/json (no session header) -> the
 *       ORIGINAL 400 JSON error, completely unchanged — this is the
 *       regression guard: a real MCP client (or any non-browser caller) must
 *       see exactly the same behavior as before this dev-request.
 *   (c) POST /mcp (the actual JSON-RPC handshake) is untouched by this
 *       change — a real initialize call still succeeds and returns a session
 *       id, proving the new branch is GET-only and additive.
 *
 * Same real-HTTP-server-via-express approach as
 * opplevelser-gardssalg-mcp-discoverability.test.ts (the router is mounted
 * directly, no supertest dependency needed).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/mcp-browser-landing-page.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runMcpBrowserLandingPageTests() and folds its pass/fail counts into
 *      the `npm test` summary.
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
  titleFragment: string;
  urlFragment: string;
}

const VERTICALS: VerticalCase[] = [
  { label: "rfb", routerPath: "./mcp", titleFragment: "Rett fra Bonden MCP", urlFragment: "rettfrabonden.com/mcp" },
  { label: "dental", routerPath: "./dental-mcp", titleFragment: "Finn-tannlege MCP", urlFragment: "finn-tannlege.com/mcp" },
];

export function runMcpBrowserLandingPageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

        // (a) Browser GET, no session header, Accept: text/html -> 200 HTML landing page
        const htmlRes = await fetch(`${base}/mcp`, { headers: { Accept: "text/html,application/xhtml+xml" } });
        assertTrue(htmlRes.status === 200, `${v.label} a1: browser GET (no session) returns 200 (got ${htmlRes.status})`);
        assertTrue(
          (htmlRes.headers.get("content-type") || "").includes("text/html"),
          `${v.label} a2: content-type is text/html (got ${htmlRes.headers.get("content-type")})`
        );
        const htmlBody = await htmlRes.text();
        assertTrue(htmlBody.includes(v.titleFragment), `${v.label} a3: body carries the vertical-branded title ("${v.titleFragment}")`);
        assertTrue(htmlBody.includes(v.urlFragment), `${v.label} a4: body links the vertical's own MCP URL ("${v.urlFragment}")`);
        assertTrue(htmlBody.includes("agent-card.json"), `${v.label} a5: body links the Agent Card`);
        assertTrue(htmlBody.includes("openapi.json"), `${v.label} a6: body links the OpenAPI doc`);
        assertTrue(htmlBody.includes("llms.txt"), `${v.label} a7: body links llms.txt`);

        // (b) Non-browser GET, no session header, Accept: application/json -> unchanged 400 JSON
        const jsonRes = await fetch(`${base}/mcp`, { headers: { Accept: "application/json" } });
        assertTrue(jsonRes.status === 400, `${v.label} b1: non-browser GET (no session) still returns 400 (got ${jsonRes.status})`);
        const jsonBody = await jsonRes.json().catch(() => null);
        assertTrue(
          jsonBody && jsonBody.error === "Missing or invalid mcp-session-id header",
          `${v.label} b2: 400 body is the original unchanged error shape (got ${JSON.stringify(jsonBody)})`
        );

        // (b2) A totally bare GET (no Accept header at all, e.g. curl default) must also
        // still fall through to the JSON 400 — only an explicit text/html Accept gets the page.
        const bareRes = await fetch(`${base}/mcp`);
        assertTrue(bareRes.status === 400, `${v.label} b3: GET with no Accept header returns 400 (got ${bareRes.status})`);

        // (c) POST /mcp (real initialize handshake) is completely unaffected
        const initRes = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "landing-page-test-client", version: "1.0.0" } },
            id: "1",
          }),
        });
        assertTrue(initRes.ok, `${v.label} c1: POST /mcp initialize still returns 2xx (got ${initRes.status})`);
        assertTrue(!!initRes.headers.get("mcp-session-id"), `${v.label} c2: POST /mcp initialize still issues a session id`);
        await initRes.text();
      } catch (err: any) {
        failed++;
        failures.push(`✗ ${v.label}: unexpected error — ${err?.message || err}`);
      } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runMcpBrowserLandingPageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
