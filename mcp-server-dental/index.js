#!/usr/bin/env node

/**
 * finn-tannlege-mcp — MCP stdio server for finn-tannlege.com
 *
 * Find Norwegian dental clinics from Claude Desktop, ChatGPT, Cursor, or any
 * MCP-compatible AI assistant.
 *
 * Since 0.2.0 this is a thin stdio bridge to the remote MCP server
 * (https://finn-tannlege.com/mcp): tools, descriptions and instructions always
 * match the live service. The bridge lives in ./stdio-bridge.js (a byte-identical
 * copy of mcp-shared/stdio-bridge.js, synced by scripts/sync-mcp-bridge.mjs).
 *
 * Install / run:
 *   npx finn-tannlege-mcp
 *
 * Environment:
 *   FINN_TANNLEGE_URL  Override the remote base URL (default: https://finn-tannlege.com)
 */

import { readFileSync } from "node:fs";
import { runBridge } from "./stdio-bridge.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

runBridge({
  packageName: "finn-tannlege-mcp",
  version,
  defaultUrl: "https://finn-tannlege.com",
  urlEnv: "FINN_TANNLEGE_URL",
}).catch((err) => {
  console.error("[finn-tannlege-mcp] failed to start:", err?.message || err);
  process.exit(1);
});
