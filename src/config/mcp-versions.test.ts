/**
 * mcp-versions.test.ts — dev-request 2026-11-01-visibility-mcp-versjonsnummer-spriker.
 *
 * For each vertical, `initialize.serverInfo.version` and the version in
 * /.well-known/mcp/server-card.json (+ the three alias paths) equal the version in the
 * package.json of the npm package that is published (mcp-server, mcp-server-dental,
 * mcp-server-opplevagent). Real routers on a real express server; real initialize.
 * (The dental initialize is also asserted in routes/dental-mcp-serverinfo-icons.test.ts.)
 *
 * Standalone: npx tsx src/config/mcp-versions.test.ts
 */
import * as fs from "fs";
import * as path from "path";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mcpPackageVersion, MCP_VERSION_UNKNOWN } from "./mcp-versions";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const ROOT = path.resolve(__dirname, "..", "..");
const CARD_PATHS = ["/.well-known/mcp/server-card.json", "/.well-known/mcp.json", "/.well-known/mcp-server.json", "/.well-known/mcp/server-cards.json"];
const PKG = { rfb: ["mcp-server", "lokal-mcp"], dental: ["mcp-server-dental", "finn-tannlege-mcp"], experiences: ["mcp-server-opplevagent", "opplevagent-mcp"] } as const;

async function serve(routers: Array<[string | null, any]>): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  for (const [mount, r] of routers) { if (mount) app.use(mount, r); else app.use(r); }
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((res) => server.close(() => res())) };
}

// Real HTTP via node:http, never the global fetch: tests/test.ts stubs globalThis.fetch
// in some blocks, and this suite runs inside that harness.
function httpRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; header: (n: string) => string | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const h = res.headers;
        resolve({
          status: res.statusCode ?? 0,
          header: (n: string) => { const v = h[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v; },
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function initializeVersion(base: string): Promise<string | undefined> {
  const r = await httpRequest(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-versions-test", version: "1.0.0" } } }),
  });
  const sid = r.header("mcp-session-id");
  if (sid) await httpRequest(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
  const line = r.text.split("\n").find((l) => l.startsWith("data:"));
  const body = JSON.parse(line ? line.slice(5) : r.text);
  return body?.result?.serverInfo?.version;
}

export async function runMcpVersionsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); if (log) console.log(`  ✗ ${label}`); }
  };

  const prev = { d: process.env.DENTAL_DB_PATH, b: process.env.DB_PATH, e: process.env.EXPERIENCES_DB_PATH };
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  try {
    const pkgs: Record<string, { name: string; version: string }> = {};
    for (const [v, [dir, name]] of Object.entries(PKG)) {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
      pkgs[v] = j;
      eq(j.name, name, `P ${v}: ${dir}/package.json is the npm package ${name}`);
      eq(mcpPackageVersion(v as any), j.version, `P ${v}: mcpPackageVersion reads ${dir}/package.json`);
      eq(mcpPackageVersion(v as any) !== MCP_VERSION_UNKNOWN, true, `P ${v}: version is not the unknown fallback`);
    }

    // ── server cards, all four paths, on the vertical's own router ──
    const cardRouters: Array<[string, () => any]> = [
      ["rfb", () => require("../routes/agent-readiness").default],
      ["dental", () => require("../routes/dental-seo").default],
      ["experiences", () => require("../routes/experiences-seo").default],
    ];
    for (const [v, get] of cardRouters) {
      const s = await serve([[null, get()]]);
      try {
        for (const p of CARD_PATHS) {
          const body = JSON.parse((await httpRequest(`${s.base}${p}`)).text) as any;
          const card = Array.isArray(body) ? body[0] : body;
          eq(card?.version, pkgs[v].version, `C ${v} ${p}: card version equals package.json`);
        }
      } finally { await s.close(); }
    }

    // ── live initialize.serverInfo.version ──
    const { currentRfbContract } = require("../routes/rfb-mcp-contract-freeze.test") as typeof import("../routes/rfb-mcp-contract-freeze.test");
    const { currentOpplevagentContract } = require("../routes/opplevagent-mcp-contract-freeze.test") as typeof import("../routes/opplevagent-mcp-contract-freeze.test");
    for (const info of Object.values((await currentRfbContract()).serverInfo)) {
      eq((info as any)?.version, pkgs.rfb.version, "I rfb: serverInfo.version equals package.json");
    }
    for (const info of Object.values((await currentOpplevagentContract()).serverInfo)) {
      eq((info as any)?.version, pkgs.experiences.version, "I experiences: serverInfo.version equals package.json");
    }
    const d = await serve([["/mcp", require("../routes/dental-mcp").default]]);
    try { eq(await initializeVersion(d.base), pkgs.dental.version, "I dental: serverInfo.version equals package.json"); }
    finally { await d.close(); }
  } catch (err: any) {
    failed++; failures.push(`✗ unexpected error: ${err?.stack || err}`);
  } finally {
    for (const [k, v] of [["DENTAL_DB_PATH", prev.d], ["DB_PATH", prev.b], ["EXPERIENCES_DB_PATH", prev.e]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runMcpVersionsTests({ log: true }).then((r) => {
    console.log(`\nmcp-versions: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) console.log(r.failures.join("\n"));
    process.exit(r.failed ? 1 : 0);
  });
}
