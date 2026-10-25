/**
 * rfb-mcp-contract-freeze.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-A (kontraktfrys).
 *
 * OpenAI is reviewing the Rett fra Bonden ChatGPT app. Its scan stores every
 * tool's name, title, description, input schema and annotations, the
 * resources and the server `instructions`. A server-side fix that keeps that
 * contract byte-identical needs no new scan; one that changes it does. This
 * test pins the contract as SHA-256 hashes of what a real MCP client gets
 * from the live /mcp router, once per PAYMENTS_ENABLED value (the submit and
 * order-status tools and the instructions have a prepayment variant):
 *
 *   - initialize.result.instructions
 *   - initialize.result.serverInfo (slice I-A2): the whole object as
 *     canonical JSON. G3-S5 keeps RFB's serverInfo (name, version, title,
 *     websiteUrl, icons) as it is until OpenAI has decided; a change fails
 *     with a message that says serverInfo has changed
 *     (tests/helpers/mcp-serverinfo-freeze.ts)
 *   - tools/list (the whole result, plus one hash per tool so a failure names
 *     the tool that changed)
 *   - resources/list and resources/templates/list
 *
 * resources/read is not pinned: both RFB resources render catalog data.
 * Negative controls apply each serverInfo change the hold is about to the
 * live serverInfo (M8 from the lokal#1186 review added `icons`) and check
 * that it fails, and that the same fields in another key order do not.
 *
 * The hashes live in tests/fixtures/rfb-mcp-contract-freeze.json. Changing
 * them is a deliberate act: only after the review is done, or together with
 * a planned re-submission. Print the current hashes with
 *   npx tsx src/routes/rfb-mcp-contract-freeze.test.ts --print
 *
 * Same real-MCP-session-over-HTTP pattern as
 * opplevagent-mcp-contract-freeze.test.ts, against an empty in-memory DB
 * with the production schema (restored in finally).
 *
 * Standalone: npx tsx src/routes/rfb-mcp-contract-freeze.test.ts
 * Wired into the gate via tests/test.ts.
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import {
  SERVER_INFO_PART, SERVER_INFO_CHANGES, serverInfoHash, serverInfoFreezeFailure, reversedKeys, type LiveContract,
} from "../../tests/helpers/mcp-serverinfo-freeze";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export const RFB_CONTRACT_FREEZE_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-mcp-contract-freeze.json");

/** The PAYMENTS_ENABLED values the contract is pinned for (unset = off, as in production today). */
const PAYMENTS_VARIANTS: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: "PAYMENTS_ENABLED=0", value: undefined },
  { label: "PAYMENTS_ENABLED=1", value: "1" },
];

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

// Plain node:http — not globalThis.fetch, which other suites stub.
function httpRequest(method: string, url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** SHA-256 of every frozen part of the contract, and the serverInfo, for one MCP session on the live /mcp router. */
async function sessionContract(url: string, prefix: string): Promise<LiveContract> {
  const baseHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const initRes = await httpRequest("POST", url, JSON.stringify({
    jsonrpc: "2.0", method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rfb-contract-freeze-test", version: "1.0.0" } },
    id: "init",
  }), baseHeaders);
  const sessionId = initRes.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) throw new Error("initialize returned no mcp-session-id: " + initRes.text.slice(0, 300));
  const sessionHeaders = { ...baseHeaders, "mcp-session-id": sessionId };
  try {
    const init = parseJsonRpcBody(initRes.text, (initRes.headers["content-type"] as string | undefined) ?? null);
    let rpcId = 0;
    const rpc = async (method: string): Promise<any> => {
      const res = await httpRequest("POST", url, JSON.stringify({ jsonrpc: "2.0", method, params: {}, id: String(++rpcId) }), sessionHeaders);
      const body = parseJsonRpcBody(res.text, (res.headers["content-type"] as string | undefined) ?? null);
      if (body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
      return body.result;
    };
    const toolsList = await rpc("tools/list");
    const serverInfoPart = `${prefix} ${SERVER_INFO_PART}`;
    const hashes: Record<string, string> = {
      [`${prefix} initialize.instructions`]: sha256(init?.result?.instructions ?? null),
      [serverInfoPart]: serverInfoHash(init?.result?.serverInfo),
      [`${prefix} tools/list`]: sha256(toolsList),
    };
    for (const tool of toolsList?.tools ?? []) hashes[`${prefix} tools/list#${tool.name}`] = sha256(tool);
    hashes[`${prefix} resources/list`] = sha256(await rpc("resources/list"));
    hashes[`${prefix} resources/templates/list`] = sha256(await rpc("resources/templates/list"));
    return { hashes, serverInfo: { [serverInfoPart]: init?.result?.serverInfo ?? null } };
  } finally {
    // Leave no session behind in the router's module-level map.
    await httpRequest("DELETE", url, "", sessionHeaders);
  }
}

/** SHA-256 of every frozen part of the contract, and the serverInfo, as served by the live /mcp router, per PAYMENTS_ENABLED value. */
export async function currentRfbContract(): Promise<LiveContract> {
  const prevPayments = process.env.PAYMENTS_ENABLED;
  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  let server: http.Server | undefined;
  try {
    const router = (require("./mcp") as typeof import("./mcp")).default;
    const app = express();
    app.use(express.json());
    app.use("/mcp", router);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const contract: LiveContract = { hashes: {}, serverInfo: {} };
    // A session reads PAYMENTS_ENABLED when it is created (registerTools,
    // rfbMcpInstructions), so each variant gets its own session.
    for (const variant of PAYMENTS_VARIANTS) {
      if (variant.value === undefined) delete process.env.PAYMENTS_ENABLED;
      else process.env.PAYMENTS_ENABLED = variant.value;
      const session = await sessionContract(url, variant.label);
      Object.assign(contract.hashes, session.hashes);
      Object.assign(contract.serverInfo, session.serverInfo);
    }
    return contract;
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevPayments === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = prevPayments;
    if (prevDb) __setDbForTesting(prevDb as any);
  }
}

export function runRfbMcpContractFreezeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const frozen = JSON.parse(fs.readFileSync(RFB_CONTRACT_FREEZE_FIXTURE, "utf8")) as { hashes: Record<string, string> };
      const live = await currentRfbContract();
      assertEq(Object.keys(live.hashes).sort(), Object.keys(frozen.hashes).sort(),
        "rfb-cf-0: the frozen contract has the same parts (tools, PAYMENTS_ENABLED variants) as the live server");
      for (const [part, hash] of Object.entries(frozen.hashes)) {
        if (Object.hasOwn(live.serverInfo, part)) {
          check(serverInfoFreezeFailure(live.serverInfo[part], hash), `rfb-cf-2: ${part} is the serverInfo frozen for the OpenAI review`);
        } else {
          assertEq(live.hashes[part], hash, `rfb-cf-1: ${part} is byte-identical to the contract frozen for the OpenAI review`);
        }
      }

      // Negative controls: each change G3-S5 holds back, applied to the live
      // serverInfo, fails with a message that says serverInfo has changed;
      // the same fields in another key order (also inside icons) are the
      // same serverInfo. They compare with the live serverInfo's hash (the
      // frozen one when rfb-cf-2 passes), so a real change fails rfb-cf-2 only.
      for (const [part, serverInfo] of Object.entries(live.serverInfo)) {
        const liveInfo = (serverInfo ?? {}) as Record<string, unknown>;
        const liveHash = live.hashes[part];
        for (const [change, apply] of SERVER_INFO_CHANGES) {
          const failure = serverInfoFreezeFailure(apply(liveInfo), liveHash);
          assertEq(failure?.startsWith("serverInfo has changed") ?? false, true,
            `rfb-cf-3: ${part} with ${change} fails with a message that serverInfo has changed`);
        }
        const withIcons = SERVER_INFO_CHANGES[0][1](liveInfo);
        assertEq({
          keyOrderDiffers: JSON.stringify(reversedKeys(liveInfo)) !== JSON.stringify(liveInfo),
          sameHash: serverInfoHash(reversedKeys(liveInfo)) === liveHash,
          sameHashWithIcons: serverInfoHash(reversedKeys(withIcons)) === serverInfoHash(withIcons),
        }, { keyOrderDiffers: true, sameHash: true, sameHashWithIcons: true },
        `rfb-cf-4: ${part} with its keys in reverse order (also inside icons) is the same serverInfo (canonical JSON)`);
      }
    } catch (err: any) {
      failed++;
      failures.push("rfb-mcp-contract-freeze: unexpected error: " + String(err?.stack || err?.message || err));
    }
    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/rfb-mcp-contract-freeze.test.ts [--print]`
if (require.main === module) {
  if (process.argv.includes("--print")) {
    currentRfbContract().then(({ hashes }) => {
      console.log(JSON.stringify({ hashes }, null, 2));
      // Explicit exit: requiring the route modules leaves background timers open.
      process.exit(0);
    });
  } else {
    runRfbMcpContractFreezeTests({ log: true }).then((summary) => {
      console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
      for (const f of summary.failures) console.log(f);
      process.exit(summary.failed > 0 ? 1 : 0);
    });
  }
}
