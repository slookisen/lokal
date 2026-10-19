#!/usr/bin/env node

/**
 * Lokal MCP Server — Find local food in Norway via Claude Desktop
 *
 * Since 0.5.0 this is a thin stdio bridge to the remote MCP server
 * (https://rettfrabonden.com/mcp): tools, descriptions and instructions always
 * match the live service. The bridge lives in ./stdio-bridge.js (a byte-identical
 * copy of mcp-shared/stdio-bridge.js, synced by scripts/sync-mcp-bridge.mjs).
 *
 * Install:
 *   npx lokal-mcp
 *
 * Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "lokal": {
 *         "command": "npx",
 *         "args": ["lokal-mcp"]
 *       }
 *     }
 *   }
 *
 * Environment:
 *   LOKAL_URL  Override the remote base URL (default: https://rettfrabonden.com)
 */

import { readFileSync } from "node:fs";
import { runBridge } from "./stdio-bridge.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

runBridge({
  packageName: "lokal-mcp",
  version,
  defaultUrl: "https://rettfrabonden.com",
  urlEnv: "LOKAL_URL",
}).catch((err) => {
  console.error("[lokal-mcp] failed to start:", err?.message || err);
  process.exit(1);
});
