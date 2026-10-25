#!/usr/bin/env node

/**
 * opplevagent-mcp — MCP stdio server for opplevagent.no
 *
 * Find Norwegian experiences and activities from Claude Desktop, ChatGPT,
 * Cursor, or any MCP-compatible AI assistant.
 *
 * Since 0.4.0 this is a thin stdio bridge to the remote MCP server
 * (https://opplevagent.no/mcp): tools, descriptions, instructions and UI
 * resources always match the live service. The bridge lives in ./stdio-bridge.js
 * (a byte-identical copy of mcp-shared/stdio-bridge.js, synced by
 * scripts/sync-mcp-bridge.mjs).
 *
 * Install / run:
 *   npx opplevagent-mcp
 *
 * Or add to Claude Desktop config (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "opplevagent": {
 *         "command": "npx",
 *         "args": ["opplevagent-mcp"]
 *       }
 *     }
 *   }
 *
 * Environment:
 *   OPPLEVAGENT_URL  Override the remote base URL (default: https://opplevagent.no)
 */

import { readFileSync } from "node:fs";
import { runBridge } from "./stdio-bridge.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

runBridge({
  packageName: "opplevagent-mcp",
  version,
  defaultUrl: "https://opplevagent.no",
  urlEnv: "OPPLEVAGENT_URL",
}).catch((err) => {
  console.error("[opplevagent-mcp] failed to start:", err?.message || err);
  process.exit(1);
});
