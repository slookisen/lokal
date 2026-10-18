#!/usr/bin/env node
/**
 * Copies the shared stdio bridge (mcp-shared/stdio-bridge.js) into every npm MCP package
 * that uses it, so each package tarball is self-contained. A new vertical = add its folder
 * to PACKAGES. `--check` writes nothing and exits 1 on drift (src/routes/mcp-stdio-bridge.test.ts
 * asserts byte-equality as well).
 */
import { copyFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGES = ["mcp-server", "mcp-server-dental", "mcp-server-opplevagent"];
export const BRIDGE = "stdio-bridge.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "mcp-shared", BRIDGE);
const check = process.argv.includes("--check");

let drift = 0;
for (const pkg of PACKAGES) {
  const target = join(root, pkg, BRIDGE);
  const same = existsSync(target) && readFileSync(target).equals(readFileSync(source));
  if (same) { console.log(`ok     ${pkg}/${BRIDGE}`); continue; }
  if (check) { drift++; console.error(`DRIFT  ${pkg}/${BRIDGE}`); continue; }
  copyFileSync(source, target);
  console.log(`synced ${pkg}/${BRIDGE}`);
}
process.exit(drift ? 1 : 0);
