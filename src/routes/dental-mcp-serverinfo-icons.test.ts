/**
 * dental-mcp-serverinfo-icons.test.ts — A2A dev-request
 * 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S5 for Finn-tannlege.
 *
 * The finn-tannlege /mcp server's serverInfo carries the brand's title,
 * website and PNG icon, read from BRAND_ENTITIES.dental, and the MCP server
 * card shows the same icon (it showed favicon.svg). Groups, by prefix:
 *   H   brandMcpIcons(): one 512×512 image/png icon whose src is the entry's
 *       logoPng, for every entry that has one; undefined (no empty list, no
 *       SVG) while logoPng is null; DENTAL_MCP_SERVER_ICONS is read from it;
 *   I   a real `initialize` over HTTP (express + the Streamable HTTP
 *       transport): serverInfo has name, version, title, description,
 *       websiteUrl and icons and nothing else; title leads with the brand
 *       name, websiteUrl is the brand URL, icons is the brand's PNG; name,
 *       version, instructions and the five tools are unchanged (non-goals);
 *   P   icons[0].src answers 200 image/png with the 512×512 file, on the
 *       same app the way the dental host gate dispatches every path but
 *       /mcp, /a2a and /api;
 *   S   the server card's `icon` is serverInfo's icons[0].src on all four
 *       card paths, and no card names an SVG (regression);
 *   N   the checks catch a bad sample of each kind (not vacuous).
 *
 * Same harness as dental-mcp-instructions.test.ts (:memory: databases, the
 * routers on a real express server).
 *
 * Standalone: npx tsx src/routes/dental-mcp-serverinfo-icons.test.ts
 * Wired into tests/test.ts via runDentalMcpServerInfoIconsTests().
 */

import * as fs from "fs";
import * as path from "path";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary { passed: number; failed: number; failures: string[] }

/** serverInfo `icons` as G3-S5 sends it for finn-tannlege.com; a change to the logo changes this on purpose. */
const EXPECTED_ICONS = [{ src: "https://finn-tannlege.com/favicon-512.png", mimeType: "image/png", sizes: ["512x512"] }];

const SERVER_INFO_KEYS = ["name", "version", "title", "description", "websiteUrl", "icons"];
const DENTAL_TOOLS = ["tannlege_akutt", "tannlege_info", "tannlege_kjeder", "tannlege_search", "tannlege_stats"];
const CARD_PATHS = ["/.well-known/mcp/server-card.json", "/.well-known/mcp.json", "/.well-known/mcp-server.json", "/.well-known/mcp/server-cards.json"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What is wrong with a serverInfo `icons` list for a server at `origin`; empty when nothing is. */
export function iconListProblems(icons: unknown, origin: string): string[] {
  if (!Array.isArray(icons) || icons.length === 0) return ["no icons"];
  const problems: string[] = [];
  const first = icons[0] ?? {};
  let url: URL | null = null;
  try { url = new URL(String(first.src)); } catch { problems.push(`icons[0].src is not a URL (${JSON.stringify(first.src)})`); }
  if (url && (url.protocol !== "https:" || url.origin !== origin)) problems.push(`icons[0].src is not https on ${origin} (${url.href})`);
  if (url && !url.pathname.endsWith(".png")) problems.push(`icons[0].src is not a .png (${url.pathname})`);
  if (first.mimeType !== "image/png") problems.push(`icons[0].mimeType is not image/png (${JSON.stringify(first.mimeType)})`);
  if (JSON.stringify(first.sizes) !== JSON.stringify(["512x512"])) problems.push(`icons[0].sizes is not ["512x512"] (${JSON.stringify(first.sizes)})`);
  if (icons.some((i) => /svg/i.test(`${i?.src ?? ""} ${i?.mimeType ?? ""}`))) problems.push("an icon is an SVG");
  return problems;
}

/** What is wrong with the answer to GET icons[0].src: not 200, not image/png, or not a PNG of `size` ("WxH"). */
export function servedIconProblems(r: { status: number; type: string | null; body: Buffer }, size: string): string[] {
  const problems: string[] = [];
  if (r.status !== 200) problems.push(`status ${r.status}`);
  if (r.type !== "image/png") problems.push(`Content-Type ${r.type}`);
  const isPng = r.body.length >= 24 && r.body.subarray(0, 8).equals(PNG_SIGNATURE) && r.body.toString("ascii", 12, 16) === "IHDR";
  if (!isPng) problems.push("the body is not a PNG");
  else if (`${r.body.readUInt32BE(16)}x${r.body.readUInt32BE(20)}` !== size) {
    problems.push(`the PNG is ${r.body.readUInt32BE(16)}x${r.body.readUInt32BE(20)}, not ${size}`);
  }
  return problems;
}

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

export async function runDentalMcpServerInfoIconsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };
  const eq = (actual: unknown, expected: unknown, label: string) =>
    ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

  // initialize, tools/list and the icon route read no database; the server card reads the catalog count.
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevDbPath = process.env.DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.DB_PATH = ":memory:";
  let server: http.Server | undefined;

  try {
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const seo = require("./dental-seo") as typeof import("./dental-seo");
    const { BRAND_ENTITIES, brandMcpIcons } = require("../config/brand-entities") as typeof import("../config/brand-entities");
    const brand = BRAND_ENTITIES.dental;

    // ── H: brandMcpIcons() ───────────────────────────────────────────────
    eq(brandMcpIcons(brand), EXPECTED_ICONS, "H1: brandMcpIcons(dental) is one 512×512 image/png icon at the brand's logoPng");
    for (const [key, e] of Object.entries(BRAND_ENTITIES)) {
      if (!e.logoPng) continue;
      const icons = brandMcpIcons(e);
      ok(icons?.length === 1 && icons[0].src === e.logoPng && iconListProblems(icons, e.url).length === 0,
        `H2 ${key}: one PNG icon whose src is the entry's logoPng, on its own origin (${JSON.stringify(icons)})`);
    }
    eq(brandMcpIcons({ logoPng: null }), undefined, "H3: no logoPng gives no icons (undefined: no empty list, no SVG fallback)");
    eq(mcp.DENTAL_MCP_SERVER_ICONS, brandMcpIcons(brand), "H4: DENTAL_MCP_SERVER_ICONS is read from BRAND_ENTITIES.dental");

    // ── I: initialize over real HTTP ─────────────────────────────────────
    // /mcp as the dental host gate mounts it; every other path goes to dental-seo, as there.
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcp.default);
    app.use(seo.default);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown, sessionId?: string) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const get = async (p: string) => {
      const r = await fetch(`${base}${p}`);
      return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) };
    };

    const initRes = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dental-serverinfo-icons-test", version: "1.0.0" } },
    });
    const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
    const init = parseJsonRpcBody(await initRes.text(), initRes.headers.get("content-type"));
    ok(initRes.ok && !!sessionId, `I1: initialize answers 2xx with a session id (got ${initRes.status})`);
    const info = init.result?.serverInfo ?? {};
    eq(Object.keys(info), SERVER_INFO_KEYS, "I2: serverInfo has name, version, title, description, websiteUrl and icons, nothing else");
    ok(info.name === "finn-tannlege" && info.version === "0.1.0" && init.result?.instructions === mcp.DENTAL_MCP_INSTRUCTIONS,
      "I3: name, version and instructions unchanged (non-goals of G3-S5)");
    ok(info.title === mcp.DENTAL_MCP_SERVER_TITLE && String(info.title).startsWith(`${brand.name} — `),
      `I4: serverInfo.title leads with the brand name from BRAND_ENTITIES.dental («${info.title}»)`);
    ok(info.websiteUrl === brand.url && info.websiteUrl === "https://finn-tannlege.com", `I5: serverInfo.websiteUrl is the brand URL (${info.websiteUrl})`);
    eq(info.icons, EXPECTED_ICONS, "I6: serverInfo.icons is the brand's 512×512 PNG");
    eq(iconListProblems(info.icons, brand.url), [], "I6b: serverInfo.icons passes the icon checks");

    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    await notified.text();
    const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    const tools: Array<{ name: string }> = parseJsonRpcBody(await listRes.text(), listRes.headers.get("content-type")).result?.tools ?? [];
    eq(tools.map((t) => t.name).sort(), DENTAL_TOOLS, "I7: tools/list on the session still has exactly the five tools (no tool change)");

    // ── P: icons[0].src answers 200 image/png ────────────────────────────
    const src = String(info.icons?.[0]?.src ?? "");
    const iconPath = src ? new URL(src).pathname : "/";
    const served = await get(iconPath);
    eq(servedIconProblems(served, "512x512"), [], `P1: GET ${iconPath} (icons[0].src) is 200 image/png, a 512×512 PNG`);
    ok(iconPath === seo.DENTAL_ICONS.png512.path
      && served.body.equals(fs.readFileSync(path.join(__dirname, "..", "public", seo.DENTAL_ICONS.png512.file))),
      `P2: the body is src/public/${seo.DENTAL_ICONS.png512.file}, the file F2-S4 serves at ${seo.DENTAL_ICONS.png512.path}`);

    // ── S: the server card ───────────────────────────────────────────────
    for (const p of CARD_PATHS) {
      const r = await fetch(`${base}${p}`);
      const text = await r.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* reported below */ }
      const card = Array.isArray(body) ? body[0] : body;
      eq([r.status, card?.icon], [200, src], `S1 ${p}: the card's icon is serverInfo's icons[0].src`);
      ok(!/\.svg\b|svg\+xml/i.test(text), `S2 ${p}: the card names no SVG (it had favicon.svg)`);
    }

    // ── N: the checks are not vacuous ────────────────────────────────────
    ok(iconListProblems(undefined, brand.url).length > 0 && iconListProblems([], brand.url).length > 0, "N1: no icons, or an empty list, is caught");
    ok(iconListProblems([{ src: `${brand.url}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }], brand.url).length >= 3,
      "N2: the SVG icon is caught (extension, type, sizes)");
    ok(iconListProblems([{ ...EXPECTED_ICONS[0], src: BRAND_ENTITIES.rfb.logoPng }], brand.url).length === 1
      && iconListProblems([{ ...EXPECTED_ICONS[0], src: EXPECTED_ICONS[0].src.replace("https:", "http:") }], brand.url).length === 1,
      "N3: another brand's logo, or plain http, is caught");
    ok(iconListProblems([{ ...EXPECTED_ICONS[0], sizes: ["192x192"] }], brand.url).length === 1, "N4: a wrong size is caught");
    {
      const svg = await get("/favicon.svg");
      const missing = await get("/favicon-1024.png");
      const small = await get(seo.DENTAL_ICONS.png192.path);
      ok(servedIconProblems(svg, "512x512").length >= 2 && servedIconProblems(missing, "512x512").length >= 2
        && servedIconProblems(small, "512x512").length === 1,
        "N5: the served checks catch the SVG, a 404 and the 192 PNG in the 512's place");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental mcp serverInfo icons: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalMcpServerInfoIconsTests({ log: true }).then((r) => {
    console.log(`\ndental mcp serverInfo icons: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
