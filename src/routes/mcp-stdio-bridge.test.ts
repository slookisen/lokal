/**
 * mcp-stdio-bridge.test.ts — dev-request 2026-10-16-distribusjon-synk, slice G1-S2a.
 *
 * The npm package finn-tannlege-mcp (0.2.0) is a thin stdio bridge to the remote /mcp. This test runs the
 * REAL package entry (`node mcp-server-dental/index.js`) over stdio against the REAL dental MCP router
 * (registerDentalTools behind a local Express /mcp), driven by an SDK Client + StdioClientTransport:
 *
 *   - mcp-shared/stdio-bridge.js == the copy shipped in mcp-server-dental/ (byte-identical, via sync script)
 *   - tools/list names == registeredMcpTools("dental") (5 tools), and equal what the remote itself returns
 *   - tools/call tannlege_search returns the same text as a direct call to the remote
 *   - remote serverInfo is forwarded; clientInfo reaches the remote as "<client> via finn-tannlege-mcp"
 *   - resources/prompts are not advertised (remote has none) and answer method-not-found
 *   - an unknown remote session (404) is re-initialised once; a persistent 404 is not retried forever
 *   - package.json/server.json are 0.2.0 and `files` ships the bridge
 *
 * Exported runMcpStdioBridgeTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-stdio-bridge.test.ts
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * fetch over node:http, so this test never depends on globalThis.fetch (other blocks in
 * tests/test.ts install temporary fetch stubs while they run).
 */
function httpFetch(input: any, init: any = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(String(input instanceof URL ? input.href : input));
    const headers: Record<string, string> = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    const req = http.request(url, { method: init.method || "GET", headers }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
      const noBody = res.statusCode === 202 || res.statusCode === 204;
      resolve(new Response(noBody ? null : (require("stream").Readable.toWeb(res) as any), { status: res.statusCode, headers: h }));
    });
    req.on("error", reject);
    init.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
    if (init.body) req.write(typeof init.body === "string" ? init.body : Buffer.from(init.body));
    req.end();
  });
}

export async function runMcpStdioBridgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = ""): void => {
    if (cond) { passed++; if (log) console.log(`  ok ${name}`); }
    else { failed++; failures.push(`✗ ${name}${detail ? " — " + detail : ""}`); if (log) console.log(`  ✗ ${name} ${detail}`); }
  };
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  // ── static: byte-identical bridge copy, versions, packaged files ──
  const shared = fs.readFileSync(path.join(ROOT, "mcp-shared", "stdio-bridge.js"));
  const copy = fs.readFileSync(path.join(ROOT, "mcp-server-dental", "stdio-bridge.js"));
  check("bridge-1 dental copy is byte-identical to mcp-shared/stdio-bridge.js", shared.equals(copy));
  const pkg = JSON.parse(read("mcp-server-dental/package.json"));
  const sj = JSON.parse(read("mcp-server-dental/server.json"));
  check("bridge-2 package.json 0.2.0 + server.json 0.2.0 (both places)",
    pkg.version === "0.2.0" && sj.version === "0.2.0" && sj.packages[0].version === "0.2.0");
  check("bridge-3 package.json files ships index.js + stdio-bridge.js",
    pkg.files.includes("index.js") && pkg.files.includes("stdio-bridge.js"));
  check("bridge-4 sdk ^1.29 and no zod dependency", /^\^1\.29/.test(pkg.dependencies["@modelcontextprotocol/sdk"]) && !pkg.dependencies.zod);
  check("bridge-5 index.js is config only (<= 40 lines, no tool definitions)",
    read("mcp-server-dental/index.js").split("\n").length <= 40 && !/registerTool/.test(read("mcp-server-dental/index.js")));
  check("bridge-6 no '6,900' claim in dental package text",
    !/6[,. ]?900/.test(read("mcp-server-dental/README.md") + read("mcp-server-dental/index.js") + JSON.stringify(pkg) + JSON.stringify(sj)));

  // ── dynamic: real router + real package over stdio ──
  const { __resetDbFactoryForTesting } = require("../database/db-factory") as typeof import("../database/db-factory");
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("./dental-mcp"),
  ]);

  let httpServer: http.Server | null = null;
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental") as InstanceType<typeof Database>;
    const ins = db.prepare(
      `INSERT INTO dental_agents (id, navn, poststed, fylke, verification_status, is_inactive, catalog_class)
       VALUES (?, ?, ?, ?, 'verified', 0, 'klinikk')`,
    );
    ins.run("b-1", "Bro Tannklinikk", "Oslo", "Oslo");
    ins.run("b-2", "Fjord Tannhelse", "Bergen", "Vestland");

    const express = require("express") as typeof import("express");
    const dentalRouter = (require("./dental-mcp") as typeof import("./dental-mcp")).default;
    const { registeredMcpTools } = require("../services/mcp-tool-manifest") as typeof import("../services/mcp-tool-manifest");

    // Observation + fault injection in front of the real router.
    const seen = { initializeClients: [] as string[], lastSession: "", initializes: 0 };
    let force404 = false;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") seen.lastSession = sid;
      if (req.method === "POST" && req.body?.method === "initialize") {
        seen.initializes++;
        seen.initializeClients.push(String(req.body.params?.clientInfo?.name));
      } else if (force404 && req.method === "POST") {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return;
      }
      next();
    });
    app.use(dentalRouter);
    httpServer = http.createServer(app);
    await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", r));
    const remoteUrl = `http://127.0.0.1:${(httpServer.address() as any).port}`;

    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js") as typeof import("@modelcontextprotocol/sdk/client/stdio.js");
    const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js") as typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    // Direct client against the remote = the reference.
    const direct = new Client({ name: "direct-ref", version: "1.0.0" }, { capabilities: {} });
    await direct.connect(new StreamableHTTPClientTransport(new URL(`${remoteUrl}/mcp`), { fetch: httpFetch as any }));
    cleanups.push(() => direct.close());
    const directTools = (await direct.listTools()).tools;
    const directSearch = await direct.callTool({ name: "tannlege_search", arguments: { query: "Bro", limit: 5 } });

    // The real package over stdio.
    const bridgeClient = new Client({ name: "bridge-test", version: "9.9.9" }, { capabilities: {} });
    const stdio = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "mcp-server-dental", "index.js")],
      env: { ...(process.env as Record<string, string>), FINN_TANNLEGE_URL: remoteUrl },
      stderr: "pipe",
    });
    await bridgeClient.connect(stdio);
    cleanups.push(() => bridgeClient.close());

    const names = (await bridgeClient.listTools()).tools.map((t) => t.name);
    const expected = registeredMcpTools("dental").map((t) => t.name);
    check("bridge-7 tools/list names == registeredMcpTools('dental')", JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
    check("bridge-8 lists exactly 5 tools", names.length === 5);
    check("bridge-9 tools/list equals the remote's own list (descriptions, schemas, annotations)",
      JSON.stringify((await bridgeClient.listTools()).tools) === JSON.stringify(directTools));

    const viaBridge: any = await bridgeClient.callTool({ name: "tannlege_search", arguments: { query: "Bro", limit: 5 } });
    const ref: any = directSearch;
    check("bridge-10 tools/call tannlege_search text == remote text",
      viaBridge.content?.[0]?.text === ref.content?.[0]?.text && /Bro Tannklinikk/.test(String(viaBridge.content?.[0]?.text)),
      String(viaBridge.content?.[0]?.text).slice(0, 120));

    check("bridge-11 remote serverInfo is forwarded",
      bridgeClient.getServerVersion()?.name === direct.getServerVersion()?.name
      && bridgeClient.getServerVersion()?.version === direct.getServerVersion()?.version);
    check("bridge-12 remote instructions are forwarded", bridgeClient.getInstructions() === direct.getInstructions());
    check("bridge-13 clientInfo reaches the remote as '<client> via finn-tannlege-mcp'",
      seen.initializeClients.includes("bridge-test via finn-tannlege-mcp"), seen.initializeClients.join(" | "));
    const caps = bridgeClient.getServerCapabilities() || {};
    check("bridge-14 capabilities advertise tools only (remote has no resources/prompts)", !!caps.tools && !caps.resources && !caps.prompts, JSON.stringify(caps));
    let promptsErr = "";
    try { await bridgeClient.listPrompts(); } catch (e: any) { promptsErr = String(e?.message || e); }
    check("bridge-15 prompts/list not advertised -> method not found", /not found|-32601/i.test(promptsErr), promptsErr);

    // 404 for an unknown session: expire the remote session, then call again.
    const initsBefore = seen.initializes;
    await httpFetch(`${remoteUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": seen.lastSession } });
    // seen.lastSession is the bridge's session only if it was the last one to talk; make sure of it
    const afterExpire: any = await bridgeClient.callTool({ name: "tannlege_search", arguments: { query: "Fjord", limit: 5 } });
    check("bridge-16 expired remote session (404) is re-initialised and the call succeeds",
      /Fjord Tannhelse/.test(String(afterExpire.content?.[0]?.text)) && seen.initializes === initsBefore + 1,
      `initializes ${initsBefore} -> ${seen.initializes}`);
    check("bridge-17 re-initialised session keeps the 'via' clientInfo",
      seen.initializeClients.filter((n) => n === "bridge-test via finn-tannlege-mcp").length >= 2);

    // Persistent 404: one re-initialise, then the error is returned (no loop).
    const initsBefore2 = seen.initializes;
    force404 = true;
    let persistentErr = "";
    try { await bridgeClient.listTools(); } catch (e: any) { persistentErr = String(e?.message || e); }
    force404 = false;
    check("bridge-18 persistent 404 -> error returned after exactly one re-initialise",
      persistentErr !== "" && seen.initializes === initsBefore2 + 1, `err="${persistentErr.slice(0, 80)}" initializes +${seen.initializes - initsBefore2}`);
    const recovered = (await bridgeClient.listTools()).tools.map((t) => t.name);
    check("bridge-19 bridge recovers once the remote is healthy again", recovered.length === 5);
  } catch (err: any) {
    failed++;
    failures.push("mcp-stdio-bridge: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort */ } }
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    try { __resetDbFactoryForTesting(); } catch { /* best-effort */ }
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best-effort */ }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runMcpStdioBridgeTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
