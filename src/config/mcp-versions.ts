/**
 * Single source of truth for the MCP server version each vertical reports.
 *
 * `initialize.serverInfo.version` and the `/.well-known/mcp/server-card.json`
 * version are read from the package.json of the npm package that is published
 * for that vertical, so `npm version` there flows to both surfaces:
 *   rfb          -> mcp-server/package.json            (lokal-mcp)
 *   dental       -> mcp-server-dental/package.json     (finn-tannlege-mcp)
 *   experiences  -> mcp-server-opplevagent/package.json (opplevagent-mcp)
 *
 * The production image copies these package.json files to /app (see Dockerfile).
 * Never throws: if the file cannot be read the version is MCP_VERSION_UNKNOWN
 * and a warning is logged once.
 */
import * as fs from "fs";
import * as path from "path";

export type McpVersionVertical = "rfb" | "dental" | "experiences";

export const MCP_VERSION_UNKNOWN = "0.0.0-unknown";

const PACKAGE_DIR: Record<McpVersionVertical, string> = {
  rfb: "mcp-server",
  dental: "mcp-server-dental",
  experiences: "mcp-server-opplevagent",
};

const cache = new Map<McpVersionVertical, string>();

function readVersion(dir: string): string | null {
  // src/config and dist/config are both two levels below the repo / image root.
  const roots = [process.cwd(), path.join(__dirname, "..", "..")];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8"));
      if (typeof pkg?.version === "string" && pkg.version) return pkg.version;
    } catch {
      // try the next root
    }
  }
  return null;
}

export function mcpPackageVersion(vertical: McpVersionVertical): string {
  const hit = cache.get(vertical);
  if (hit) return hit;
  const dir = PACKAGE_DIR[vertical];
  let version = readVersion(dir);
  if (!version) {
    console.warn(`[mcp-versions] cannot read ${dir}/package.json; reporting ${MCP_VERSION_UNKNOWN} for ${vertical}`);
    version = MCP_VERSION_UNKNOWN;
  }
  cache.set(vertical, version);
  return version;
}
