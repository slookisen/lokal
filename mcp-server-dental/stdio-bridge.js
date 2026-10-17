/**
 * stdio-bridge.js — shared stdio -> remote MCP bridge for the npm MCP packages.
 *
 * SINGLE SOURCE: mcp-shared/stdio-bridge.js. Each package ships a byte-identical copy
 * (scripts/sync-mcp-bridge.mjs; a test fails on drift). Edit only this file, then run
 * `node scripts/sync-mcp-bridge.mjs`.
 *
 * The package is a thin proxy: an SDK `Server` on stdio, and an SDK `Client` with
 * StreamableHTTPClientTransport against the vertical's remote /mcp. The remote stays the
 * single source of tool contracts, so the npm package can never drift from it.
 *
 *  - remote `serverInfo`, `instructions` and capabilities are forwarded in `initialize`
 *  - tools/*, resources/* and prompts/* are forwarded when the remote advertises them
 *  - `clientInfo` toward the remote is "<original client> via <package>", so vendor
 *    attribution on the remote still sees the real client
 *  - an unknown/expired remote session (HTTP 404) is re-initialised ONCE per request,
 *    with a timeout; a second failure is returned as an error (no loops)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema, CallToolResultSchema,
  ListToolsRequestSchema, ListToolsResultSchema,
  ListResourcesRequestSchema, ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema,
  ReadResourceRequestSchema, ReadResourceResultSchema,
  ListPromptsRequestSchema, ListPromptsResultSchema,
  GetPromptRequestSchema, GetPromptResultSchema,
  ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ErrorCode, McpError,
} from "@modelcontextprotocol/sdk/types.js";

const CONNECT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 60000;

const log = (...a) => console.error("[mcp-bridge]", ...a);

/** Resolve the remote /mcp URL from a base URL or a full /mcp URL. */
export function resolveRemoteUrl(raw) {
  const base = String(raw).trim().replace(/\/+$/, "");
  return new URL(/\/mcp$/.test(base) ? base : `${base}/mcp`);
}

function isUnknownSession(err) {
  return Boolean(err) && (err.code === 404 || /\b404\b/.test(String(err.message || "")));
}

/**
 * @param {object} cfg
 * @param {string} cfg.packageName   npm package name, used in clientInfo and User-Agent
 * @param {string} cfg.version       package version
 * @param {string} cfg.defaultUrl    default remote base URL (https://host) or /mcp URL
 * @param {string} [cfg.urlEnv]      env var that overrides the URL
 * @returns {Promise<{server: Server, close: () => Promise<void>}>}
 */
export async function runBridge(cfg, { transport = new StdioServerTransport() } = {}) {
  const url = resolveRemoteUrl((cfg.urlEnv && process.env[cfg.urlEnv]) || cfg.defaultUrl);
  let originalClient = { name: "unknown", version: "0.0.0" };
  let remote = null;
  let reinit = null;

  async function connectRemote() {
    const client = new Client(
      { name: `${originalClient.name} via ${cfg.packageName}`, version: originalClient.version || cfg.version },
      { capabilities: {} },
    );
    const t = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "User-Agent": `${cfg.packageName}/${cfg.version}` } },
    });
    await client.connect(t, { timeout: CONNECT_TIMEOUT_MS });
    const caps = client.getServerCapabilities() || {};
    if (caps.tools?.listChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged().catch(() => {}));
    if (caps.resources?.listChanged) client.setNotificationHandler(ResourceListChangedNotificationSchema, () => server.sendResourceListChanged().catch(() => {}));
    if (caps.prompts?.listChanged) client.setNotificationHandler(PromptListChangedNotificationSchema, () => server.sendPromptListChanged().catch(() => {}));
    return { client, transport: t };
  }

  /** Re-initialise once; concurrent callers share the same attempt. */
  function reconnect(stale) {
    if (!reinit) {
      reinit = (async () => {
        try {
          if (remote === stale) {
            // Connect the new session first: if it fails, `stale` stays in place and the
            // next request simply tries again (no half-closed client left behind).
            remote = await connectRemote();
            stale.client.close().catch(() => {});
          }
        } finally {
          reinit = null;
        }
      })();
    }
    return reinit;
  }

  async function forward(method, params, resultSchema) {
    if (!remote) throw new McpError(ErrorCode.InvalidRequest, "Bridge not initialized");
    const current = remote;
    const send = (r) => r.client.request({ method, params }, resultSchema, { timeout: REQUEST_TIMEOUT_MS });
    try {
      return await send(current);
    } catch (err) {
      if (!isUnknownSession(err)) throw err;
      log("remote session unknown (404), re-initialising once");
      await reconnect(current);
      return send(remote);
    }
  }

  // Declare every forwarded capability so handlers can be registered; the `initialize`
  // reply below narrows it to what the remote actually advertises.
  class BridgeServer extends Server {
    async _oninitialize(request) {
      const base = await super._oninitialize(request);
      originalClient = request.params.clientInfo || originalClient;
      if (!remote) remote = await connectRemote();
      const caps = remote.client.getServerCapabilities() || {};
      const capabilities = {};
      for (const k of ["tools", "resources", "prompts"]) if (caps[k]) capabilities[k] = caps[k];
      const instructions = remote.client.getInstructions();
      const result = { ...base, capabilities, serverInfo: remote.client.getServerVersion() || base.serverInfo };
      delete result.instructions;
      if (instructions) result.instructions = instructions;
      return result;
    }
  }

  const server = new BridgeServer(
    { name: cfg.packageName, version: cfg.version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const advertises = (kind) => Boolean(remote?.client.getServerCapabilities()?.[kind]);
  const guarded = (kind, method, schema) => async (req) => {
    if (!advertises(kind)) throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    return forward(method, req.params, schema);
  };

  server.setRequestHandler(ListToolsRequestSchema, (req) => forward("tools/list", req.params, ListToolsResultSchema));
  server.setRequestHandler(CallToolRequestSchema, (req) => forward("tools/call", req.params, CallToolResultSchema));
  server.setRequestHandler(ListResourcesRequestSchema, guarded("resources", "resources/list", ListResourcesResultSchema));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, guarded("resources", "resources/templates/list", ListResourceTemplatesResultSchema));
  server.setRequestHandler(ReadResourceRequestSchema, guarded("resources", "resources/read", ReadResourceResultSchema));
  server.setRequestHandler(ListPromptsRequestSchema, guarded("prompts", "prompts/list", ListPromptsResultSchema));
  server.setRequestHandler(GetPromptRequestSchema, guarded("prompts", "prompts/get", GetPromptResultSchema));

  async function close() {
    const r = remote;
    remote = null;
    if (r) {
      await r.transport.terminateSession().catch(() => {});
      await r.client.close().catch(() => {});
    }
    await server.close().catch(() => {});
  }
  server.onclose = () => {
    const r = remote;
    remote = null;
    if (r) r.transport.terminateSession().catch(() => {}).finally(() => r.client.close().catch(() => {}));
  };

  await server.connect(transport);
  return { server, close };
}
