/**
 * opplevagent-mcp-contract-freeze.test.ts — dev-request
 * 2026-10-16-opplevagent-mcp-fritekst-query, S1 (felles regel 1: kontraktfrys).
 *
 * OpenAI is reviewing the Opplevagent ChatGPT app. Its scan stores a snapshot
 * of every tool's name, title, description, input schema, annotations and
 * _meta, the widget resources (HTML, CSP, _meta) and the server
 * `instructions`. A server-side fix that keeps that contract byte-identical
 * needs no new scan; one that changes it does. This test pins the contract as
 * SHA-256 hashes of what a real MCP client gets from the live /mcp router:
 *
 *   - initialize.result.instructions
 *   - initialize.result.serverInfo (dev-request
 *     2026-10-17-integrasjonstest-oppfolging, slice I-A2): the whole object as
 *     canonical JSON. G3-S5 keeps Opplevagent's serverInfo (name, version,
 *     title, description, websiteUrl, icons) as it is until OpenAI has
 *     decided; a change fails with a message that says serverInfo has changed
 *     (tests/helpers/mcp-serverinfo-freeze.ts)
 *   - tools/list (the whole result, plus one hash per tool so a failure names
 *     the tool that changed)
 *   - resources/list
 *   - resources/read for every URI resources/list names (the current widget
 *     URIs WIDGET_LIST_URI / WIDGET_DETAIL_URI and the older ones still served
 *     to clients that cached them)
 *
 * Negative controls apply each serverInfo change the hold is about to the
 * live serverInfo and check that it fails, and that the same fields in
 * another key order do not.
 *
 * The hashes live in tests/fixtures/opplevagent-mcp-contract-freeze.json.
 * Changing them is a deliberate act: only after the review is done, or
 * together with a planned re-submission. Print the current hashes with
 *   npx tsx src/routes/opplevagent-mcp-contract-freeze.test.ts --print
 *
 * Same in-memory-DB + real-MCP-session-over-HTTP pattern as
 * opplevagent-chatgpt-review.test.ts.
 *
 * Standalone: npx tsx src/routes/opplevagent-mcp-contract-freeze.test.ts
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SERVER_INFO_PART, SERVER_INFO_CHANGES, serverInfoHash, serverInfoFreezeFailure, reversedKeys, type LiveContract,
} from "../../tests/helpers/mcp-serverinfo-freeze";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export const CONTRACT_FREEZE_FIXTURE = path.join(__dirname, "../../tests/fixtures/opplevagent-mcp-contract-freeze.json");

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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

// Plain node:http POST — not globalThis.fetch, which other suites stub.
function httpPost(url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** SHA-256 of every frozen part of the contract, and the serverInfo, as served by the live /mcp router. */
export async function currentOpplevagentContract(): Promise<LiveContract> {
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/experience-store"),
    require.resolve("./experiences-mcp"),
  ]);
  let server: http.Server | undefined;
  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const mcpModule = require("./experiences-mcp") as typeof import("./experiences-mcp");
    const app = express();
    app.use(express.json());
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => (mcpModule.default as any)(req, res, next));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const baseHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

    const initRes = await httpPost(url, JSON.stringify({
      jsonrpc: "2.0", method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-freeze-test", version: "1.0.0" } },
      id: "init",
    }), baseHeaders);
    const sessionId = initRes.headers["mcp-session-id"] as string | undefined;
    const init = parseJsonRpcBody(initRes.text, (initRes.headers["content-type"] as string | undefined) ?? null);
    let rpcId = 0;
    const rpc = async (method: string, params: Record<string, unknown>): Promise<any> => {
      const res = await httpPost(
        url,
        JSON.stringify({ jsonrpc: "2.0", method, params, id: String(++rpcId) }),
        { ...baseHeaders, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      );
      const body = parseJsonRpcBody(res.text, (res.headers["content-type"] as string | undefined) ?? null);
      if (body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
      return body.result;
    };

    const toolsList = await rpc("tools/list", {});
    const hashes: Record<string, string> = {
      "initialize.instructions": sha256(init?.result?.instructions ?? null),
      [SERVER_INFO_PART]: serverInfoHash(init?.result?.serverInfo),
      "tools/list": sha256(toolsList),
    };
    for (const tool of toolsList?.tools ?? []) hashes[`tools/list#${tool.name}`] = sha256(tool);
    const resourcesList = await rpc("resources/list", {});
    hashes["resources/list"] = sha256(resourcesList);
    const uris: string[] = (resourcesList?.resources ?? []).map((r: { uri: string }) => r.uri);
    for (const uri of [mcpModule.WIDGET_LIST_URI, mcpModule.WIDGET_DETAIL_URI]) {
      if (!uris.includes(uri)) uris.push(uri);
    }
    for (const uri of uris) {
      hashes[`resources/read#${uri}`] = sha256(await rpc("resources/read", { uri }));
    }
    return { hashes, serverInfo: { [SERVER_INFO_PART]: init?.result?.serverInfo ?? null } };
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }
}

export function runOpplevagentMcpContractFreezeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  /** Passes on a null failure; otherwise records the failure text under the label. */
  function check(failure: string | null, label: string): void {
    if (failure === null) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    ${failure}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  return (async () => {
    try {
      const frozen = JSON.parse(fs.readFileSync(CONTRACT_FREEZE_FIXTURE, "utf8")) as { hashes: Record<string, string> };
      const live = await currentOpplevagentContract();
      assertEq(Object.keys(live.hashes).sort(), Object.keys(frozen.hashes).sort(),
        "cf-0: the frozen contract has the same parts (tools, widget URIs) as the live server");
      for (const [part, hash] of Object.entries(frozen.hashes)) {
        if (Object.hasOwn(live.serverInfo, part)) {
          check(serverInfoFreezeFailure(live.serverInfo[part], hash), `cf-2: ${part} is the serverInfo frozen for the OpenAI review`);
        } else {
          assertEq(live.hashes[part], hash, `cf-1: ${part} is byte-identical to the contract frozen for the OpenAI review`);
        }
      }

      // Negative controls: each change G3-S5 holds back, applied to the live
      // serverInfo, fails with a message that says serverInfo has changed;
      // the same fields in another key order (also inside icons) are the
      // same serverInfo. They compare with the live serverInfo's hash (the
      // frozen one when cf-2 passes), so a real change fails cf-2 only.
      for (const [part, serverInfo] of Object.entries(live.serverInfo)) {
        const liveInfo = (serverInfo ?? {}) as Record<string, unknown>;
        const liveHash = live.hashes[part];
        for (const [change, apply] of SERVER_INFO_CHANGES) {
          const failure = serverInfoFreezeFailure(apply(liveInfo), liveHash);
          assertEq(failure?.startsWith("serverInfo has changed") ?? false, true,
            `cf-3: ${part} with ${change} fails with a message that serverInfo has changed`);
        }
        const withIcons = SERVER_INFO_CHANGES[0][1](liveInfo);
        assertEq({
          keyOrderDiffers: JSON.stringify(reversedKeys(liveInfo)) !== JSON.stringify(liveInfo),
          sameHash: serverInfoHash(reversedKeys(liveInfo)) === liveHash,
          sameHashWithIcons: serverInfoHash(reversedKeys(withIcons)) === serverInfoHash(withIcons),
        }, { keyOrderDiffers: true, sameHash: true, sameHashWithIcons: true },
        `cf-4: ${part} with its keys in reverse order (also inside icons) is the same serverInfo (canonical JSON)`);
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevagent-mcp-contract-freeze: unexpected error: " + String(err?.stack || err?.message || err));
    }
    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevagent-mcp-contract-freeze.test.ts [--print]`
if (require.main === module) {
  if (process.argv.includes("--print")) {
    currentOpplevagentContract().then(({ hashes }) => {
      console.log(JSON.stringify({ hashes }, null, 2));
      process.exit(0);
    });
  } else {
    runOpplevagentMcpContractFreezeTests({ log: true }).then((summary) => {
      console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
      for (const f of summary.failures) console.log(f);
      process.exit(summary.failed > 0 ? 1 : 0);
    });
  }
}
