/**
 * dental-mcp-serverinfo-icons.test.ts — A2A dev-request
 * 2026-10-16-merkevare-entitet-og-connector-pakker, G3-S5 for Finn-tannlege.
 *
 * The finn-tannlege /mcp server's serverInfo carries the brand's title,
 * website and PNG icons (the 512 logo, then the 192), read from
 * BRAND_ENTITIES.dental, and the MCP server card shows the 512 (it showed
 * favicon.svg). Groups, by prefix:
 *   H   brandMcpIcons(): one image/png icon per BRAND_PNG_ICONS field the
 *       entry has, at that field's size, logo first, for every entry with a
 *       logo; undefined (no empty list, no lone 192, no SVG) while logoPng is
 *       null; the list, its items and their sizes are frozen;
 *       DENTAL_MCP_SERVER_ICONS is read from it; dental's 192 is the F2-S4
 *       route;
 *   I   a real `initialize` over HTTP (express + the Streamable HTTP
 *       transport): serverInfo has name, version, title, description,
 *       websiteUrl and icons and nothing else; title leads with the brand
 *       name, websiteUrl is the brand URL, icons are the brand's two PNGs;
 *       name, version, instructions and the five tools are unchanged
 *       (non-goals); DELETE /mcp ends the session, so none is left behind;
 *   P   every icon's src answers 200 image/png with a PNG of the size the
 *       icon declares, the bytes of the F2-S4 file (512 and 192), on the
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

/** serverInfo `icons` as G3-S5 sends it for finn-tannlege.com; a change to the icons changes this on purpose. */
const EXPECTED_ICONS = [
  { src: "https://finn-tannlege.com/favicon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  { src: "https://finn-tannlege.com/favicon-192.png", mimeType: "image/png", sizes: ["192x192"] },
];

const SERVER_INFO_KEYS = ["name", "version", "title", "description", "websiteUrl", "icons"];
const DENTAL_TOOLS = ["tannlege_akutt", "tannlege_info", "tannlege_kjeder", "tannlege_search", "tannlege_stats"];
const CARD_PATHS = ["/.well-known/mcp/server-card.json", "/.well-known/mcp.json", "/.well-known/mcp-server.json", "/.well-known/mcp/server-cards.json"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The one square "NxN" an icon declares in `sizes`, or null when it declares anything else. */
function declaredSquareSize(icon: any): string | null {
  const sizes = icon?.sizes;
  if (!Array.isArray(sizes) || sizes.length !== 1) return null;
  const m = /^(\d+)x(\d+)$/.exec(String(sizes[0]));
  return m && m[1] === m[2] ? sizes[0] : null;
}

/**
 * What is wrong with a serverInfo `icons` list for a server at `origin`; empty
 * when nothing is. Each icon is an https .png on `origin`, typed image/png,
 * with one square size; the 512×512 logo leads; no src twice; no SVG.
 */
export function iconListProblems(icons: unknown, origin: string): string[] {
  if (!Array.isArray(icons) || icons.length === 0) return ["no icons"];
  const problems: string[] = [];
  icons.forEach((icon: any, i) => {
    let url: URL | null = null;
    try { url = new URL(String(icon?.src)); } catch { problems.push(`icons[${i}].src is not a URL (${JSON.stringify(icon?.src)})`); }
    if (url && (url.protocol !== "https:" || url.origin !== origin)) problems.push(`icons[${i}].src is not https on ${origin} (${url.href})`);
    if (url && !url.pathname.endsWith(".png")) problems.push(`icons[${i}].src is not a .png (${url.pathname})`);
    if (icon?.mimeType !== "image/png") problems.push(`icons[${i}].mimeType is not image/png (${JSON.stringify(icon?.mimeType)})`);
    if (!declaredSquareSize(icon)) problems.push(`icons[${i}].sizes is not one square "NxN" (${JSON.stringify(icon?.sizes)})`);
  });
  if (JSON.stringify(icons[0]?.sizes) !== JSON.stringify(["512x512"])) problems.push(`icons[0] is not the 512×512 logo (${JSON.stringify(icons[0]?.sizes)})`);
  const srcs = icons.map((i: any) => String(i?.src));
  if (new Set(srcs).size !== srcs.length) problems.push("an icon src appears twice");
  if (icons.some((i: any) => /svg/i.test(`${i?.src ?? ""} ${i?.mimeType ?? ""}`))) problems.push("an icon is an SVG");
  return problems;
}

/** What is wrong with the answer to GET of an icon's src: not 200, not image/png, or not a PNG of `size` ("WxH"). */
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
  let endSession: (() => Promise<void>) | undefined;

  try {
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const seo = require("./dental-seo") as typeof import("./dental-seo");
    const { BRAND_ENTITIES, BRAND_PNG_ICONS, brandMcpIcons } = require("../config/brand-entities") as typeof import("../config/brand-entities");
    const brand = BRAND_ENTITIES.dental;

    // ── H: brandMcpIcons() ───────────────────────────────────────────────
    eq(BRAND_PNG_ICONS, [{ field: "logoPng", size: 512 }, { field: "iconPng192", size: 192 }],
      "H0: BRAND_PNG_ICONS is the 512 logo, then the 192 icon");
    eq(brandMcpIcons(brand), EXPECTED_ICONS, "H1: brandMcpIcons(dental) is the 512×512 logo, then the 192×192 icon, both image/png");
    for (const [key, e] of Object.entries(BRAND_ENTITIES)) {
      if (!e.logoPng) continue;
      const icons = brandMcpIcons(e);
      const want = BRAND_PNG_ICONS.filter(({ field }) => e[field]).map(({ field, size }) => [e[field], `${size}x${size}`]);
      eq(icons?.map((i) => [i.src, ...(i.sizes ?? [])]), want, `H2 ${key}: one icon per PNG field the entry has, at the field's size, logo first`);
      eq(iconListProblems(icons, e.url), [], `H2b ${key}: the icons pass the icon checks on ${e.url}`);
    }
    eq(brandMcpIcons({ logoPng: null, iconPng192: null }), undefined, "H3: no PNG gives no icons (undefined: no empty list, no SVG fallback)");
    eq(brandMcpIcons({ logoPng: null, iconPng192: brand.iconPng192 }), undefined, "H3b: without the logo there are no icons, not a lone 192");
    eq(brandMcpIcons({ logoPng: brand.logoPng, iconPng192: null }), [EXPECTED_ICONS[0]], "H3c: a logo without a 192 gives the 512 alone");
    eq(mcp.DENTAL_MCP_SERVER_ICONS, brandMcpIcons(brand), "H4: DENTAL_MCP_SERVER_ICONS is read from BRAND_ENTITIES.dental");
    {
      const icons = mcp.DENTAL_MCP_SERVER_ICONS ?? [];
      ok(icons.length > 0 && Object.isFrozen(icons) && icons.every((i) => Object.isFrozen(i) && Object.isFrozen(i.sizes)),
        "H5: DENTAL_MCP_SERVER_ICONS, each icon and each sizes list are frozen (every session shares them)");
      // Reflect reports a refused write whether or not the caller runs in strict mode;
      // a write that goes through is undone, so the checks below still see the real icons.
      const src0 = icons[0]?.src;
      const srcRefused = !!icons[0] && !Reflect.set(icons[0], "src", "https://example.invalid/x.png");
      if (!srcRefused && icons[0]) Reflect.set(icons[0], "src", src0);
      const addRefused = !Reflect.defineProperty(icons, "probe", { value: 1, configurable: true });
      if (!addRefused) Reflect.deleteProperty(icons, "probe");
      ok(srcRefused && addRefused && icons[0]?.src === EXPECTED_ICONS[0].src,
        "H5b: changing a shared icon's src, or adding to the shared list, is refused");
    }
    eq(brand.iconPng192, `${brand.url}${seo.DENTAL_ICONS.png192.path}`, "H6: BRAND_ENTITIES.dental.iconPng192 is the 192 route F2-S4 serves");

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
    if (sessionId) {
      endSession = async () => {
        const r = await fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
        await r.text();
      };
    }
    const init = parseJsonRpcBody(await initRes.text(), initRes.headers.get("content-type"));
    ok(initRes.ok && !!sessionId, `I1: initialize answers 2xx with a session id (got ${initRes.status})`);
    const info = init.result?.serverInfo ?? {};
    eq(Object.keys(info), SERVER_INFO_KEYS, "I2: serverInfo has name, version, title, description, websiteUrl and icons, nothing else");
    ok(info.name === "finn-tannlege" && info.version === "0.1.0" && init.result?.instructions === mcp.DENTAL_MCP_INSTRUCTIONS,
      "I3: name, version and instructions unchanged (non-goals of G3-S5)");
    ok(info.title === mcp.DENTAL_MCP_SERVER_TITLE && String(info.title).startsWith(`${brand.name} — `),
      `I4: serverInfo.title leads with the brand name from BRAND_ENTITIES.dental («${info.title}»)`);
    ok(info.websiteUrl === brand.url && info.websiteUrl === "https://finn-tannlege.com", `I5: serverInfo.websiteUrl is the brand URL (${info.websiteUrl})`);
    eq(info.icons, EXPECTED_ICONS, "I6: serverInfo.icons is the brand's 512×512 logo, then its 192×192 icon");
    eq(iconListProblems(info.icons, brand.url), [], "I6b: serverInfo.icons passes the icon checks");

    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    await notified.text();
    const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    const tools: Array<{ name: string }> = parseJsonRpcBody(await listRes.text(), listRes.headers.get("content-type")).result?.tools ?? [];
    eq(tools.map((t) => t.name).sort(), DENTAL_TOOLS, "I7: tools/list on the session still has exactly the five tools (no tool change)");
    {
      const live = !!sessionId && mcp.hasDentalMcpSession(sessionId);
      const end = endSession;
      endSession = undefined;
      if (end) await end();
      ok(live && !mcp.hasDentalMcpSession(sessionId!), "I8: DELETE /mcp ends the session (none is left in the router's map)");
    }

    // ── P: every icon's src answers 200 image/png at its declared size ────
    const icons: any[] = Array.isArray(info.icons) ? info.icons : [];
    ok(icons.length === EXPECTED_ICONS.length, `P0: there are ${EXPECTED_ICONS.length} icons to fetch (got ${icons.length})`);
    const servedBodies = new Map<string, Buffer>();
    for (const [i, icon] of icons.entries()) {
      const iconPath = new URL(String(icon?.src)).pathname;
      const size = declaredSquareSize(icon) ?? "(no size)";
      const served = await get(iconPath);
      servedBodies.set(iconPath, served.body);
      eq(servedIconProblems(served, size), [], `P1 icons[${i}]: GET ${iconPath} is 200 image/png, a ${size} PNG as declared`);
    }
    for (const [label, icon] of [["P2", seo.DENTAL_ICONS.png512], ["P3", seo.DENTAL_ICONS.png192]] as const) {
      const body = servedBodies.get(icon.path);
      ok(!!body && body.equals(fs.readFileSync(path.join(__dirname, "..", "public", icon.file))),
        `${label}: ${icon.path} is an icon and its body is src/public/${icon.file}, the file F2-S4 serves there`);
    }
    const src = String(icons[0]?.src ?? "");

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
    const [big, small] = EXPECTED_ICONS;
    const count = (icons: unknown[]) => iconListProblems(icons, brand.url).length;
    ok(count([{ ...big, src: BRAND_ENTITIES.rfb.logoPng }, small]) === 1
      && count([big, { ...small, src: small.src.replace("https:", "http:") }]) === 1,
      "N3: another brand's logo, or plain http, is caught");
    ok(count([small, big]) === 1 && count([big, { ...small, sizes: ["192x190"] }]) === 1 && count([big, { ...small, sizes: ["192x192", "512x512"] }]) === 1,
      "N4: the 192 leading, a size that is not square and two sizes on one icon are caught");
    ok(count([big, big]) === 1 && count([big, { src: small.src, sizes: small.sizes }]) === 1,
      "N4b: a src twice, or an icon without its mimeType, is caught");
    {
      const svg = await get("/favicon.svg");
      const missing = await get("/favicon-1024.png");
      const png192 = await get(seo.DENTAL_ICONS.png192.path);
      const png512 = await get(seo.DENTAL_ICONS.png512.path);
      ok(servedIconProblems(svg, "512x512").length >= 2 && servedIconProblems(missing, "512x512").length >= 2
        && servedIconProblems(png192, "512x512").length === 1 && servedIconProblems(png512, "192x192").length === 1,
        "N5: the served checks catch the SVG, a 404, and the 192 and 512 PNGs in each other's place");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental mcp serverInfo icons: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    // Leave no session behind in the router's module-level map (I8 ends it unless a check threw first).
    if (endSession) await endSession().catch(() => undefined);
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
