/**
 * mcp-stdio-bridge.test.ts — dev-request 2026-10-16-distribusjon-synk, slices G1-S2a (dental), G1-S2b
 * (lokal-mcp 0.5.0 = rfb, opplevagent-mcp 0.4.0 = experiences) and G1-S2c (finn-tannlege-mcp 0.2.1, which ships
 * the shared bridge that exits on stdin EOF; npm already has 0.2.0 with the first bridge).
 *
 * The npm packages finn-tannlege-mcp, lokal-mcp and opplevagent-mcp are thin stdio bridges to their remote /mcp.
 * For each of them this test runs the REAL package entry (`node <package>/index.js`) over stdio against the REAL
 * MCP router of the vertical (registerDentalTools / registerTools / registerExperienceTools behind a local Express
 * /mcp), driven by an SDK Client + StdioClientTransport:
 *
 *   - mcp-shared/stdio-bridge.js == the copy shipped in every package (byte-identical, via the sync script)
 *   - tools/list names == registeredMcpTools(<vertical>) (5 / 15 / 5 tools), and equal what the remote itself returns
 *   - tools/call returns the same text as a direct call to the remote
 *   - remote serverInfo AND instructions are forwarded
 *   - experiences: resources/list and resources/read (the ui:// widgets) equal the remote's
 *   - clientInfo reaches the remote as "<client> via <package>"
 *   - capabilities equal the remote's; unadvertised prompts answer method-not-found
 *   - an unknown remote session (404) is re-initialised once and the call succeeds; after a SUCCESSFUL re-init a
 *     persistent 404 is returned as an error without looping; a failing re-init is not retried forever
 *   - stdout carries only JSON-RPC (logs go to stderr), and the process exits when stdin reaches EOF
 *   - package.json/server.json/manifest versions and `files` shipping the bridge
 *   - `npm pack --dry-run` ships <package>@<version> with exactly the 5 files every bridge package has
 *
 * Exported runMcpStdioBridgeTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-stdio-bridge.test.ts
 */
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { spawn, execFileSync } from "child_process";

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


type Vertical = "dental" | "rfb" | "experiences";

interface Scenario {
  id: Vertical;
  pkgDir: string;
  packageName: string;
  urlEnv: string;
  toolCount: number;
  call: { name: string; args: Record<string, unknown>; expect: RegExp };
  /** The remote sends server `instructions` (all three verticals). */
  hasInstructions: boolean;
  /** The remote advertises resources (the experiences ui:// widgets). */
  hasResources: boolean;
  /** Seeds the vertical's DB and returns how to mount its router plus the cleanup. */
  setup: () => Promise<{ mount: (app: any) => void; teardown: () => void }>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "dental", pkgDir: "mcp-server-dental", packageName: "finn-tannlege-mcp", urlEnv: "FINN_TANNLEGE_URL", toolCount: 5,
    call: { name: "tannlege_search", args: { query: "Bro", limit: 5 }, expect: /Bro Tannklinikk/ },
    hasInstructions: true, hasResources: false,
    async setup() {
      const prev = process.env.DENTAL_DB_PATH;
      process.env.DENTAL_DB_PATH = ":memory:";
      const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
        require.resolve("../database/db-factory"),
        require.resolve("../services/dental-store"),
        require.resolve("./dental-mcp"),
      ]);
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental") as InstanceType<typeof Database>;
      const ins = db.prepare(
        `INSERT INTO dental_agents (id, navn, poststed, fylke, verification_status, is_inactive, catalog_class)
         VALUES (?, ?, ?, ?, 'verified', 0, 'klinikk')`,
      );
      ins.run("b-1", "Bro Tannklinikk", "Oslo", "Oslo");
      ins.run("b-2", "Fjord Tannhelse", "Bergen", "Vestland");
      const dentalRouter = (require("./dental-mcp") as typeof import("./dental-mcp")).default;
      return {
        mount: (app) => app.use(dentalRouter),
        teardown: () => {
          if (prev === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prev;
          try { dbFactory.__resetDbFactoryForTesting(); } catch { /* best-effort */ }
          restoreModuleCache();
        },
      };
    },
  },
  {
    id: "rfb", pkgDir: "mcp-server", packageName: "lokal-mcp", urlEnv: "LOKAL_URL", toolCount: 15,
    call: { name: "lokal_geocode", args: { place: "Oslo" }, expect: /lat: 59\.9139/ },
    hasInstructions: true, hasResources: true,
    async setup() {
      const init = require("../database/init") as typeof import("../database/init");
      const prevDb = init.__peekDbForTesting();
      const db = new Database(":memory:");
      init.__setDbForTesting(db as any);
      init.__initSchemaForTesting(db as any);
      const rfbRouter = (require("./mcp") as typeof import("./mcp")).default;
      return {
        mount: (app) => app.use("/mcp", rfbRouter),
        teardown: () => { if (prevDb) init.__setDbForTesting(prevDb as any); },
      };
    },
  },
  {
    id: "experiences", pkgDir: "mcp-server-opplevagent", packageName: "opplevagent-mcp", urlEnv: "OPPLEVAGENT_URL", toolCount: 5,
    call: { name: "list_experience_categories", args: {}, expect: /gardssalg|categor/i },
    hasInstructions: true, hasResources: true,
    async setup() {
      const prev = process.env.EXPERIENCES_DB_PATH;
      process.env.EXPERIENCES_DB_PATH = ":memory:";
      const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
        require.resolve("../database/db-factory"),
        require.resolve("../services/experience-store"),
        require.resolve("./experiences-mcp"),
      ]);
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const mcpModule = require("./experiences-mcp") as typeof import("./experiences-mcp");
      return {
        mount: (app) => app.use((req: any, res: any, next: any) => (mcpModule.default as any)(req, res, next)),
        teardown: () => {
          if (prev === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prev;
          try { dbFactory.__resetDbFactoryForTesting(); } catch { /* best-effort */ }
          restoreModuleCache();
        },
      };
    },
  },
];

/** What every bridge package ships to npm (finn-tannlege-mcp 0.2.0 on npm has exactly these). */
const PACKED_FILES = ["README.md", "index.js", "package.json", "server.json", "stdio-bridge.js"];

/** What `npm publish` would ship: `npm pack --dry-run --json` (offline, no tarball written, no lifecycle scripts). */
function npmPackDryRun(pkgDir: string): { id: string; files: string[] } {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: path.resolve(ROOT, pkgDir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const [pack] = JSON.parse(out);
  return { id: String(pack.id), files: pack.files.map((f: { path: string }) => f.path).sort() };
}

/** Spawns the real package over raw pipes: stdout must be JSON-RPC only, and EOF on stdin must end the process. */
async function rawStdioSession(entry: string, env: Record<string, string>, beforeCall: () => void) {
  const child = spawn(process.execPath, [entry], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
  const lines = () => stdout.split("\n").filter((l) => l.trim() !== "");
  const waitForId = async (id: number): Promise<any> => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const l of lines()) { try { const m = JSON.parse(l); if (m.id === id) return m; } catch { /* checked later */ } }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no response for id ${id}; stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-stdio", version: "1.0.0" } } });
  await waitForId(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  beforeCall();
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitForId(2);
  const t0 = Date.now();
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  const code = await exited;
  clearTimeout(timer);
  return { lines: lines(), stderr, list, exitCode: code, exitMs: Date.now() - t0 };
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

  // ── static: byte-identical bridge copies, versions, packaged files ──
  const shared = fs.readFileSync(path.join(ROOT, "mcp-shared", "stdio-bridge.js"));
  for (const sc of SCENARIOS) {
    const id = sc.id;
    check(`${id}-bridge-1 ${sc.pkgDir}/stdio-bridge.js is byte-identical to mcp-shared/stdio-bridge.js`,
      shared.equals(fs.readFileSync(path.join(ROOT, sc.pkgDir, "stdio-bridge.js"))));
    const pkg = JSON.parse(read(`${sc.pkgDir}/package.json`));
    const sj = JSON.parse(read(`${sc.pkgDir}/server.json`));
    // dental 0.2.2: the text of G3-S6d (A2A dev-request 2026-10-16-merkevare-entitet-og-connector-pakker); same bridge as 0.2.1.
    const version = { dental: "0.2.2", rfb: "0.5.0", experiences: "0.4.0" }[id];
    check(`${id}-bridge-2 package.json + server.json are ${version} (both places in server.json)`,
      pkg.version === version && sj.version === version && sj.packages[0].version === version, `${pkg.version}/${sj.version}`);
    check(`${id}-bridge-3 package.json files ships index.js + stdio-bridge.js`,
      pkg.files.includes("index.js") && pkg.files.includes("stdio-bridge.js"));
    let packed: { id: string; files: string[] } | null = null;
    let packErr = "";
    try { packed = npmPackDryRun(sc.pkgDir); } catch (e: any) { packErr = String(e?.stderr || e?.message || e).slice(0, 200); }
    check(`${id}-bridge-3b npm pack --dry-run ships ${sc.packageName}@${version} with exactly ${PACKED_FILES.join(", ")}`,
      packed?.id === `${sc.packageName}@${version}` && JSON.stringify(packed.files) === JSON.stringify(PACKED_FILES),
      packed ? `${packed.id}: ${packed.files.join(", ")}` : packErr);
    check(`${id}-bridge-4 sdk ^1.29 and no zod dependency`,
      /^\^1\.29/.test(pkg.dependencies["@modelcontextprotocol/sdk"]) && !pkg.dependencies.zod);
    const entry = read(`${sc.pkgDir}/index.js`);
    check(`${id}-bridge-5 index.js is config only (<= 50 lines, no tool definitions)`,
      entry.split("\n").length <= 50 && !/registerTool/.test(entry) && entry.includes(`"${sc.urlEnv}"`) && entry.includes(`"${sc.packageName}"`));
    check(`${id}-bridge-5b server.json declares ${sc.urlEnv}`,
      (sj.packages[0].environmentVariables || []).some((e: any) => e.name === sc.urlEnv));
  }
  // Control for bridge-3b: npm skips a missing `files` entry without an error, so only the exact list catches it.
  const withoutBridge = PACKED_FILES.filter((f) => f !== "stdio-bridge.js");
  const noBridge = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-bridge-pack-"));
  let controlFiles = "";
  try {
    for (const f of withoutBridge) fs.copyFileSync(path.join(ROOT, "mcp-server-dental", f), path.join(noBridge, f));
    controlFiles = JSON.stringify(npmPackDryRun(noBridge).files);
  } catch (e: any) {
    controlFiles = String(e?.stderr || e?.message || e).slice(0, 200);
  } finally {
    fs.rmSync(noBridge, { recursive: true, force: true });
  }
  check("bridge-3c control: npm packs a package missing stdio-bridge.js without an error (4 files), so only bridge-3b's exact list catches it",
    controlFiles === JSON.stringify(withoutBridge), controlFiles);
  check("bridge-6 no '6,900' claim in dental package text",
    !/6[,. ]?900/.test(read("mcp-server-dental/README.md") + read("mcp-server-dental/index.js")
      + read("mcp-server-dental/package.json") + read("mcp-server-dental/server.json")));
  let syncOk = false;
  try { execFileSync(process.execPath, [path.join(ROOT, "scripts", "sync-mcp-bridge.mjs"), "--check"], { stdio: "pipe" }); syncOk = true; } catch { /* drift */ }
  check("bridge-6b `sync-mcp-bridge.mjs --check` is clean and covers all three packages", syncOk
    && /"mcp-server",\s*"mcp-server-dental",\s*"mcp-server-opplevagent"/.test(read("scripts/sync-mcp-bridge.mjs")));
  const mcpb = JSON.parse(read("mcp-server/manifest.json"));
  check("bridge-6c lokal-mcp manifest.json is 0.5.0", mcpb.version === "0.5.0");

  const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js") as typeof import("@modelcontextprotocol/sdk/client/stdio.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js") as typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { registeredMcpTools } = require("../services/mcp-tool-manifest") as typeof import("../services/mcp-tool-manifest");

  // ── dynamic: real router + real package over stdio, once per vertical ──
  for (const sc of SCENARIOS) {
    const id = sc.id;
    let teardown: (() => void) | null = null;
    let httpServer: http.Server | null = null;
    const cleanups: Array<() => Promise<unknown> | unknown> = [];
    try {
      const env = await sc.setup();
      teardown = env.teardown;
      const express = require("express") as typeof import("express");

      // Observation + fault injection in front of the real router.
      const seen = { initializeClients: [] as string[], lastSession: "", initializes: 0 };
      const ctl = { faultAll: false, faultNext: 0, faulted: 0 };
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        const sid = req.headers["mcp-session-id"];
        if (typeof sid === "string") seen.lastSession = sid;
        if (req.method === "POST") {
          const method = String(req.body?.method);
          if (method === "initialize") {
            seen.initializes++;
            seen.initializeClients.push(String(req.body.params?.clientInfo?.name));
          } else if (ctl.faultAll || (ctl.faultNext > 0 && !method.startsWith("notifications/"))) {
            if (!ctl.faultAll) ctl.faultNext--;
            ctl.faulted++;
            res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
            return;
          }
        }
        next();
      });
      env.mount(app);
      httpServer = http.createServer(app);
      await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", r));
      const remoteUrl = `http://127.0.0.1:${(httpServer.address() as any).port}`;

      // Direct client against the remote = the reference (all direct calls happen before the bridge connects).
      const direct = new Client({ name: "direct-ref", version: "1.0.0" }, { capabilities: {} });
      await direct.connect(new StreamableHTTPClientTransport(new URL(`${remoteUrl}/mcp`), { fetch: httpFetch as any }));
      cleanups.push(() => direct.close());
      const directCaps = direct.getServerCapabilities() || {};
      const directTools = (await direct.listTools()).tools;
      const directCall: any = await direct.callTool({ name: sc.call.name, arguments: sc.call.args });
      const directResources = directCaps.resources ? (await direct.listResources()).resources : [];
      const widgetUri = directResources.find((r) => r.uri.startsWith("ui://"))?.uri;
      const directWidget = widgetUri ? await direct.readResource({ uri: widgetUri }) : null;

      // The real package over stdio.
      const childEnv = { ...(process.env as Record<string, string>), [sc.urlEnv]: remoteUrl };
      const entryPath = path.join(ROOT, sc.pkgDir, "index.js");
      const bridgeClient = new Client({ name: "bridge-test", version: "9.9.9" }, { capabilities: {} });
      await bridgeClient.connect(new StdioClientTransport({ command: process.execPath, args: [entryPath], env: childEnv, stderr: "pipe" }));
      cleanups.push(() => bridgeClient.close());

      const bridgeTools = (await bridgeClient.listTools()).tools;
      const names = bridgeTools.map((t) => t.name);
      const expected = registeredMcpTools(id).map((t) => t.name);
      check(`${id}-bridge-7 tools/list names == registeredMcpTools('${id}')`, JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names));
      check(`${id}-bridge-8 lists exactly ${sc.toolCount} tools`, names.length === sc.toolCount, String(names.length));
      check(`${id}-bridge-9 tools/list equals the remote's own list (descriptions, schemas, annotations)`,
        JSON.stringify(bridgeTools) === JSON.stringify(directTools));
      if (id === "rfb") {
        check("rfb-bridge-9b mcpb manifest tool list == remote tool list",
          JSON.stringify(mcpb.tools.map((t: any) => t.name)) === JSON.stringify(names));
      }

      const viaBridge: any = await bridgeClient.callTool({ name: sc.call.name, arguments: sc.call.args });
      check(`${id}-bridge-10 tools/call ${sc.call.name} text == remote text`,
        viaBridge.content?.[0]?.text === directCall.content?.[0]?.text && sc.call.expect.test(String(viaBridge.content?.[0]?.text)),
        String(viaBridge.content?.[0]?.text).slice(0, 120));

      check(`${id}-bridge-11 remote serverInfo is forwarded`,
        bridgeClient.getServerVersion()?.name === direct.getServerVersion()?.name
        && bridgeClient.getServerVersion()?.version === direct.getServerVersion()?.version);
      const instr = bridgeClient.getInstructions();
      check(`${id}-bridge-12 remote instructions are forwarded (non-empty)`,
        instr === direct.getInstructions() && (sc.hasInstructions ? typeof instr === "string" && instr.length > 50 : instr === undefined),
        String(instr).slice(0, 60));
      check(`${id}-bridge-13 clientInfo reaches the remote as '<client> via ${sc.packageName}'`,
        seen.initializeClients.includes(`bridge-test via ${sc.packageName}`), seen.initializeClients.join(" | "));
      const caps = bridgeClient.getServerCapabilities() || {};
      check(`${id}-bridge-14 capabilities (tools/resources/prompts) equal the remote's`,
        (["tools", "resources", "prompts"] as const).every((k) => !!caps[k] === !!directCaps[k]), JSON.stringify(caps));
      if (!directCaps.prompts) {
        let promptsErr = "";
        try { await bridgeClient.listPrompts(); } catch (e: any) { promptsErr = String(e?.message || e); }
        check(`${id}-bridge-15 prompts/list not advertised -> method not found`, /not found|-32601/i.test(promptsErr), promptsErr);
      }
      if (sc.hasResources) {
        const viaResources = (await bridgeClient.listResources()).resources;
        check(`${id}-bridge-15b resources/list equals the remote's`,
          JSON.stringify(viaResources) === JSON.stringify(directResources) && directResources.length > 0, String(viaResources.length));
        if (id === "experiences") {
          check("experiences-bridge-15c ui:// widget resources are available through the bridge",
            viaResources.some((r) => r.uri.startsWith("ui://opplevagent/")) && !!widgetUri);
        }
        if (widgetUri) {
          const widget = await bridgeClient.readResource({ uri: widgetUri });
          check(`${id}-bridge-15d resources/read ${widgetUri} equals the remote's`,
            JSON.stringify(widget) === JSON.stringify(directWidget));
        }
      }

      // 404 for an unknown session: expire the remote session, then call again.
      const initsBefore = seen.initializes;
      await httpFetch(`${remoteUrl}/mcp`, { method: "DELETE", headers: { "mcp-session-id": seen.lastSession } });
      const afterExpire: any = await bridgeClient.callTool({ name: sc.call.name, arguments: sc.call.args });
      check(`${id}-bridge-16 expired remote session (404) is re-initialised and the call succeeds`,
        sc.call.expect.test(String(afterExpire.content?.[0]?.text)) && seen.initializes === initsBefore + 1,
        `initializes ${initsBefore} -> ${seen.initializes}`);
      check(`${id}-bridge-17 re-initialised session keeps the 'via' clientInfo`,
        seen.initializeClients.filter((n) => n === `bridge-test via ${sc.packageName}`).length >= 2);

      // One 404 for the next request, a healthy re-init: succeeds, exactly one re-init, exactly one 404 served.
      let before = { inits: seen.initializes, faulted: ctl.faulted };
      ctl.faultNext = 1;
      const afterOne = (await bridgeClient.listTools()).tools.length;
      ctl.faultNext = 0;
      check(`${id}-bridge-18 a single 404 + successful re-init -> call succeeds, one re-init, no further 404`,
        afterOne === sc.toolCount && seen.initializes === before.inits + 1 && ctl.faulted === before.faulted + 1,
        `inits +${seen.initializes - before.inits}, 404s +${ctl.faulted - before.faulted}`);

      // Persistent 404 on requests while initialize + notifications/initialized succeed: the re-init is SUCCESSFUL,
      // the retry is 404 again -> error returned after exactly one re-init and exactly two 404s (no loop).
      before = { inits: seen.initializes, faulted: ctl.faulted };
      ctl.faultNext = 1000;
      let persistentErr = "";
      try { await bridgeClient.listTools(); } catch (e: any) { persistentErr = String(e?.message || e); }
      ctl.faultNext = 0;
      check(`${id}-bridge-19 persistent 404 after a successful re-init -> error returned, no loop (1 re-init, 2 x 404)`,
        persistentErr !== "" && seen.initializes === before.inits + 1 && ctl.faulted === before.faulted + 2,
        `err="${persistentErr.slice(0, 80)}" inits +${seen.initializes - before.inits}, 404s +${ctl.faulted - before.faulted}`);

      // Re-init itself failing (404 on every POST except initialize, notifications included): one attempt, an error.
      before = { inits: seen.initializes, faulted: ctl.faulted };
      ctl.faultAll = true;
      let failedReinitErr = "";
      try { await bridgeClient.listTools(); } catch (e: any) { failedReinitErr = String(e?.message || e); }
      ctl.faultAll = false;
      check(`${id}-bridge-20 a failing re-init is returned as an error after exactly one re-init attempt`,
        failedReinitErr !== "" && seen.initializes === before.inits + 1,
        `err="${failedReinitErr.slice(0, 80)}" inits +${seen.initializes - before.inits}`);
      const recovered = (await bridgeClient.listTools()).tools.length;
      check(`${id}-bridge-21 bridge recovers once the remote is healthy again`, recovered === sc.toolCount, String(recovered));

      // Raw stdio: stdout is JSON-RPC only, a 404 re-init logs to stderr, and EOF on stdin ends the process.
      ctl.faultNext = 0;
      const raw = await rawStdioSession(entryPath, childEnv, () => { ctl.faultNext = 1; });
      ctl.faultNext = 0;
      const allJsonRpc = raw.lines.length >= 2 && raw.lines.every((l) => {
        try { const m = JSON.parse(l); return m && m.jsonrpc === "2.0"; } catch { return false; }
      });
      check(`${id}-bridge-22 stdout carries only JSON-RPC messages (even when a re-init is logged)`, allJsonRpc, raw.lines.map((l) => l.slice(0, 60)).join(" | "));
      check(`${id}-bridge-23 the re-init is logged to stderr, not stdout`,
        /re-initialising/.test(raw.stderr) && !raw.lines.some((l) => /re-initialising|\[mcp-bridge\]/.test(l)), raw.stderr.slice(0, 120));
      check(`${id}-bridge-24 tools/list over raw stdio after the 404 has ${sc.toolCount} tools`,
        raw.list?.result?.tools?.length === sc.toolCount);
      check(`${id}-bridge-25 process exits promptly (< 5 s, code 0) when stdin reaches EOF`,
        raw.exitCode === 0 && raw.exitMs < 5000, `code=${raw.exitCode} after ${raw.exitMs} ms`);
    } catch (err: any) {
      failed++;
      failures.push(`mcp-stdio-bridge (${id}): unexpected error: ` + String(err?.stack || err?.message || err));
    } finally {
      for (const c of cleanups.reverse()) { try { await c(); } catch { /* best-effort */ } }
      if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
      try { teardown?.(); } catch { /* best-effort */ }
    }
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
