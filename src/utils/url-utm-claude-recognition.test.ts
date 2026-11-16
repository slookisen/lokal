/**
 * url-utm-claude-recognition.test.ts — dev-request
 * 2026-11-12-rfb-c1-claude-knapp-sporing-gjenkjenning, slice C1-B3
 * («gjenkjenn Claude i statistikken»).
 *
 *   (a) AK1: the initialize client names claude-ai, Anthropic/ClaudeAI (and
 *       other Anthropic… names) and claude-code are Claude / utm_source=claude
 *       / source_client "claude"; probes, openai-mcp, codex-mcp-client and a
 *       plain "mcp" are unchanged.
 *   (b) Precedence: a Claude initialize name beats a generic SDK User-Agent
 *       (node / python), never a specific assistant UA (ChatGPT stays ChatGPT).
 *   (c) Telemetry bucket: agentDeliveryVendor puts the three names in "claude".
 *   (d) AK2: over the live /mcp router, a profile link handed to a Claude
 *       session (claude-code / Anthropic/ClaudeAI with a node / python UA)
 *       carries utm_source=claude; controls stay node_sdk / chatgpt.
 *
 * Exported runUrlUtmClaudeRecognitionTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts. Standalone: npx tsx src/utils/url-utm-claude-recognition.test.ts
 */

import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const OSLO = { lat: 59.9289, lng: 10.7522 };

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

// Plain node:http — not globalThis.fetch, which other suites stub.
function httpRequest(url: string, body: string, headers: Record<string, string>): Promise<{ headers: http.IncomingHttpHeaders; text: string }> {
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

/** One MCP session (initialize with `clientName`, every request with `ua`); the text of lokal_search. */
async function searchAs(url: string, clientName: string, ua: string): Promise<string> {
  const base = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": ua };
  const init = await httpRequest(url, JSON.stringify({
    jsonrpc: "2.0", method: "initialize", id: "init",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } },
  }), base);
  const sessionId = init.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) throw new Error("initialize returned no mcp-session-id: " + init.text.slice(0, 300));
  const headers = { ...base, "mcp-session-id": sessionId };
  await httpRequest(url, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), headers);
  const res = await httpRequest(url, JSON.stringify({
    jsonrpc: "2.0", method: "tools/call", id: "1",
    params: { name: "lokal_search", arguments: { query: "Aker Gard", limit: 5 } },
  }), headers);
  const body = parseJsonRpcBody(res.text, (res.headers["content-type"] as string | undefined) ?? null);
  if (body.error) throw new Error("tools/call failed: " + JSON.stringify(body.error));
  return String(body?.result?.content?.[0]?.text ?? "");
}

export async function runUrlUtmClaudeRecognitionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq<T>(actual: T, expected: T, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const utm = require("./url-utm") as typeof import("./url-utm");

  // ── (a) AK1: the three Claude names, and what must not become Claude ──
  const CLAUDE_NAMES = ["claude-ai", "Anthropic/ClaudeAI", "Anthropic/Desktop", "anthropic-mcp-client", "claude-code", "Claude"];
  for (const name of CLAUDE_NAMES) {
    assertEq(utm.aiClientFromClientName(name), "Claude", `(a) aiClientFromClientName(${name}) → Claude`);
    assertEq(utm.aiClientFromHeaders({ "user-agent": "undici" }, name), "Claude", `(a) aiClientFromHeaders(undici, ${name}) → Claude`);
    assertEq(utm.sourceClientLabel(utm.aiClientFromHeaders({}, name)), "claude", `(a) source_client for ${name} → claude`);
    assertEq(utm.aiSourceFromClient(utm.aiClientFromClientName(name)), "claude", `(a) utm_source for ${name} → claude`);
  }
  const NOT_CLAUDE: Array<[string, string | undefined]> = [
    ["glimind-probe", undefined],
    ["smithery-probe", undefined],
    ["Smithery probe", undefined],
    ["mcp", undefined],
    ["codex-mcp-client via lokal-mcp", undefined],
    ["openai-mcp", "ChatGPT"],
    ["cursor-vscode", "Cursor"],
    ["", undefined],
  ];
  for (const [name, want] of NOT_CLAUDE) {
    assertEq(utm.aiClientFromClientName(name), want, `(a) aiClientFromClientName(${JSON.stringify(name)}) unchanged → ${want}`);
    assertEq(utm.aiClientFromHeaders({ "user-agent": "undici" }, name), want, `(a) aiClientFromHeaders(undici, ${JSON.stringify(name)}) → ${want}`);
  }
  // An "anthropic" that does not START the name is not enough (the spec: names starting with Anthropic).
  assertEq(utm.aiClientFromClientName("not-anthropic-probe"), undefined, "(a) 'anthropic' inside a name (not at the start) is not Claude");
  // detectAiClient (the UA rule) is unchanged.
  assertEq(utm.detectAiClient("Anthropic/Desktop"), undefined, "(a) detectAiClient itself is unchanged (UA rule)");

  // ── (b) precedence ────────────────────────────────────────────────────
  const NODE_UA = "node";
  const PY_UA = "python-httpx/0.27.0";
  assertEq(utm.detectAiClient(NODE_UA), "Node SDK", "(b) baseline: node UA alone → Node SDK");
  assertEq(utm.detectAiClient(PY_UA), "Python SDK", "(b) baseline: python UA alone → Python SDK");
  assertEq(utm.aiClientFromHeaders({ "user-agent": NODE_UA }, "claude-code"), "Claude", "(b) node UA + claude-code → Claude");
  assertEq(utm.aiClientFromHeaders({ "user-agent": PY_UA }, "Anthropic/ClaudeAI"), "Claude", "(b) python UA + Anthropic/ClaudeAI → Claude");
  assertEq(utm.aiClientFromHeaders({ "user-agent": NODE_UA }, "claude-ai"), "Claude", "(b) node UA + claude-ai → Claude");
  assertEq(utm.aiClientFromHeaders({ "user-agent": NODE_UA }, "smithery-probe"), "Node SDK", "(b) node UA + probe → Node SDK (unchanged)");
  assertEq(utm.aiClientFromHeaders({ "user-agent": NODE_UA }, "mcp-python-client"), "Node SDK", "(b) node UA + an SDK name stays Node SDK");
  assertEq(utm.aiClientFromHeaders({ "user-agent": "openai-mcp/1.0.0" }, "claude-ai"), "ChatGPT", "(b) ChatGPT UA + claude name → ChatGPT (a specific UA wins)");
  assertEq(utm.aiClientFromHeaders({ "user-agent": "Cursor/1.2" }, "claude-code"), "Cursor", "(b) Cursor UA + claude name → Cursor");
  assertEq(utm.aiClientFromHeaders({ "user-agent": "x", origin: "https://chatgpt.com" }, "Anthropic/ClaudeAI"), "ChatGPT", "(b) ChatGPT origin wins over an Anthropic name");
  assertEq(utm.aiClientFromHeaders({ "user-agent": "Mozilla/5.0 (compatible; Perplexity-User/1.0)" }, "claude-ai"), "Perplexity", "(b) Perplexity-User UA wins over a claude name");
  assertEq(utm.aiClientFromHeaders({ "user-agent": "curl/8" }), undefined, "(b) no UA match, no name → undefined");
  assertEq(utm.preferNamedAssistant("Node SDK", "claude-code"), "Claude", "(b) preferNamedAssistant: Node SDK session + claude-code → Claude");
  assertEq(utm.preferNamedAssistant("ChatGPT", "claude-code"), "ChatGPT", "(b) preferNamedAssistant: ChatGPT session stays ChatGPT");
  assertEq(utm.preferNamedAssistant(undefined, null), undefined, "(b) preferNamedAssistant: nothing known → undefined");

  // ── (c) telemetry bucket («Med i AI-svar» vendor) ───────────────────
  {
    const { agentDeliveryVendor } = require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries");
    for (const name of ["claude-ai", "Anthropic/ClaudeAI", "claude-code", "Claude"]) {
      assertEq(agentDeliveryVendor(name, NODE_UA), "claude", `(c) agentDeliveryVendor(${name}, node) → claude`);
    }
    for (const name of ["glimind-probe", "smithery-probe", "codex-mcp-client via lokal-mcp", "mcp"]) {
      assertEq(agentDeliveryVendor(name, NODE_UA), "unknown", `(c) agentDeliveryVendor(${name}, node) → unknown`);
    }
    assertEq(agentDeliveryVendor("openai-mcp", NODE_UA), "chatgpt", "(c) agentDeliveryVendor(openai-mcp) → chatgpt");
  }

  // ── (d) AK2: live /mcp router, profile link to a Claude session ─────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  let server: http.Server | undefined;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
         lat, lng, city, is_active, is_verified)
      VALUES ('c1b3-aker', 'Aker Gard', 'test', 'test', 'aker@example.com', 'https://example.com', 'producer', 'key-c1b3', ?, ?, 'Oslo', 1, 1)
    `).run(OSLO.lat, OSLO.lng);
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status) VALUES ('c1b3-aker', 'verified')").run();
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    const router = (require("../routes/mcp") as typeof import("../routes/mcp")).default;
    const app = express();
    app.use(express.json());
    app.use("/mcp", router);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const cases: Array<[string, string, string, string]> = [
      ["claude-code", NODE_UA, "claude", "claude-code + node UA"],
      ["Anthropic/ClaudeAI", PY_UA, "claude", "Anthropic/ClaudeAI + python UA"],
      ["claude-ai", "undici", "claude", "claude-ai + unknown UA"],
      ["smithery-probe", NODE_UA, "node_sdk", "probe + node UA (control)"],
      ["claude-ai", "openai-mcp/1.0.0", "chatgpt", "ChatGPT UA + claude name (control)"],
    ];
    for (const [clientName, ua, source, label] of cases) {
      const text = await searchAs(url, clientName, ua);
      const links = text.match(/https:\/\/rettfrabonden\.com\/produsent\/[^\s)]+/g) ?? [];
      assertTrue(links.length >= 1, `(d) lokal_search (${label}): has a profile link (${text.slice(0, 200)})`);
      assertTrue(links.every((l) => l.includes(`utm_source=${source}&utm_medium=mcp`)),
        `(d) lokal_search (${label}): every profile link has utm_source=${source} (${links.join(", ")})`);
      assertTrue(links.every((l) => (l.match(/utm_source/g) ?? []).length === 1), `(d) lokal_search (${label}): one utm_source per link`);
    }
  } catch (err: any) {
    assertTrue(false, `(d) unexpected error: ${String(err?.stack || err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runUrlUtmClaudeRecognitionTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed ? 1 : 0);
  });
}
