/**
 * rfb-claude-connector-link.test.ts — "Use in Claude" link and current Claude
 * connector guide (A2A dev-request 2026-11-12-rfb-c1-claude-knapp-sporing-gjenkjenning,
 * slice C1-B1).
 *
 * Every Rett fra Bonden "Claude" link reads RFB_CLAUDE_CONNECTOR_URL
 * (config/distribution-channels.ts). Locks:
 *   AK1 (a) no source that renders the RFB pages (seo.ts, discovery.ts, app.html)
 *         carries the retired "Settings → Integrations" path (any arrow form) or
 *         the "Claude Desktop (Pro/Max/Team/Enterprise)" heading;
 *       (b) the Claude link literal (claude.ai/customize/connectors…) appears in no
 *         src/ file except distribution-channels.ts and the static app.html, and
 *         app.html carries exactly the constant (HTML-escaped);
 *   AK2 the front page (no + en), /teknologi (no + en) and /llms.txt answer 200
 *       and contain the link (HTML-escaped on pages, raw in llms.txt);
 *   AK3 no x-distribution entry probes claude.ai (claude.ai answers 403 to robots,
 *       and every probe expects 200);
 *   plus: the link opens Claude's add-custom-connector dialog for
 *       "Rett fra Bonden" at https://rettfrabonden.com/mcp; the guide names
 *       Customize → Connectors → Add custom connector in both languages.
 *
 * Exported runRfbClaudeConnectorLinkTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/config/rfb-claude-connector-link.test.ts
 */
import * as fs from "fs";
import * as path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const SRC = path.resolve(__dirname, "..");
// Split so this file never contains the link literal as one string.
const LINK_MARK = "claude.ai/customize/" + "connectors";

function walk(dir: string, out: string[]): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.(ts|html|js|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): { found: boolean; status: number; body: string } {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "" };
  let status = 200;
  let body = "";
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    json(b: unknown) { body = JSON.stringify(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    set() { return this; },
    type() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang, path: routePath, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { status = 404; });
  return { found: true, status, body };
}

export async function runRfbClaudeConnectorLinkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) { passed++; if (opts.log) console.log(`  ok   ${name}`); }
    else { failed++; failures.push(`${name}${detail ? ` (${detail})` : ""}`); if (opts.log) console.log(`  FAIL ${name} ${detail}`); }
  };

  const cfg = require("./distribution-channels") as typeof import("./distribution-channels");
  const URL_ = cfg.RFB_CLAUDE_CONNECTOR_URL;

  // ── the constant ──
  let parsed: URL | null = null;
  try { parsed = new URL(URL_); } catch { parsed = null; }
  check(
    "claude-link-0: constant opens Claude's add-custom-connector dialog for Rett fra Bonden at /mcp",
    !!parsed && parsed.origin === "https://claude.ai" && parsed.pathname === "/customize/connectors" &&
      parsed.searchParams.get("modal") === "add-custom-connector" &&
      parsed.searchParams.get("connectorName") === "Rett fra Bonden" &&
      parsed.searchParams.get("connectorUrl") === "https://rettfrabonden.com/mcp",
    URL_,
  );

  // ── AK1 (a): no retired setup path ──
  const renderSources = [
    path.join(SRC, "routes", "seo.ts"),
    path.join(SRC, "routes", "discovery.ts"),
    path.join(SRC, "public", "app.html"),
  ];
  const retired = /Settings\s*(?:→|&rarr;|\\u2192|->|&#8594;)\s*(?:<\/?strong>\s*)*Integrations|Settings<\/strong>\s*(?:→|&rarr;)\s*<strong>Integrations/;
  const retiredHits = renderSources.filter((f) => retired.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f));
  check("claude-ak1-a1: no RFB page source says Settings → Integrations", retiredHits.length === 0, retiredHits.join(", "));
  const proHits = renderSources.filter((f) => fs.readFileSync(f, "utf8").includes("Pro/Max/Team/Enterprise")).map((f) => path.relative(SRC, f));
  check("claude-ak1-a2: no RFB page source keeps the Claude Desktop (Pro/Max/Team/Enterprise) heading", proHits.length === 0, proHits.join(", "));

  // ── AK1 (b): one literal ──
  const self = path.resolve(__filename);
  const allowed = new Set([
    path.join(SRC, "config", "distribution-channels.ts"),
    path.join(SRC, "public", "app.html"),
  ]);
  const copies = walk(SRC, [])
    .filter((f) => path.resolve(f) !== self && !allowed.has(path.resolve(f)))
    .filter((f) => fs.readFileSync(f, "utf8").includes(LINK_MARK))
    .map((f) => path.relative(SRC, f));
  check("claude-ak1-b1: the Claude link literal lives only in distribution-channels.ts (+ static app.html)", copies.length === 0, copies.join(", "));
  const cfgSrc = fs.readFileSync(path.join(__dirname, "distribution-channels.ts"), "utf8");
  check("claude-ak1-b2: distribution-channels.ts holds the literal exactly once", cfgSrc.split(LINK_MARK).length - 1 === 1);
  const appHtml = fs.readFileSync(path.join(SRC, "public", "app.html"), "utf8");
  check(
    "claude-ak1-b3: static app.html carries the link once, equal to the constant (HTML-escaped)",
    appHtml.split(LINK_MARK).length - 1 === 1 && appHtml.includes(`href="${escAttr(URL_)}"`),
  );
  const seoSrc = fs.readFileSync(path.join(SRC, "routes", "seo.ts"), "utf8");
  check(
    "claude-ak1-b4: both homepage Claude buttons in seo.ts read RFB_CLAUDE_CONNECTOR_URL",
    (seoSrc.match(/href="\$\{escapeHtml\(RFB_CLAUDE_CONNECTOR_URL\)\}"[^>]*class="ai-(?:btn ai-claude|logo)"[^>]*>[^<]*Claude<\/a>/g) || []).length === 2,
  );
  check("claude-ak1-b5: no homepage link to /teknologi#claude-mcp is left", !/#claude-mcp"/.test(seoSrc));

  // ── AK2: rendered pages ──
  try {
    const { loadConfigsAtBoot } = require("./vertical-config") as typeof import("./vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
  } catch { /* defaults */ }
  const seoRouter = (require("../routes/seo") as any).default;
  const discRouter = (require("../routes/discovery") as any).default;
  const escaped = escAttr(URL_);
  for (const lang of ["no", "en"] as const) {
    const home = invokeGet(seoRouter, "/", lang);
    check(`claude-ak2-home-${lang}: / answers 200 and links the Claude dialog twice`,
      home.found && home.status === 200 && home.body.split(`href="${escaped}"`).length - 1 === 2,
      `status=${home.status}`);
    const tek = invokeGet(seoRouter, "/teknologi", lang);
    check(`claude-ak2-tek-${lang}: /teknologi answers 200, links the dialog in #claude-mcp`,
      tek.found && tek.status === 200 && tek.body.includes(`href="${escaped}"`) && /id="claude-mcp"/.test(tek.body),
      `status=${tek.status}`);
    check(`claude-ak2-tek-${lang}-path: guide names Customize → Connectors → Add custom connector`,
      /<strong>Customize<\/strong> &rarr; <strong>Connectors<\/strong>/.test(tek.body) && tek.body.includes("Add custom connector") &&
        tek.body.includes("<code>Rett fra Bonden</code>") && tek.body.includes("<code>https://rettfrabonden.com/mcp</code>"));
    check(`claude-ak2-tek-${lang}-retired: rendered /teknologi has no Settings → Integrations`,
      !retired.test(tek.body) && !tek.body.includes("Pro/Max/Team/Enterprise"));
    const gma = invokeGet(seoRouter, "/guide-mat-ai", lang);
    check(`claude-ak2-gma-${lang}: /guide-mat-ai answers 200 and links the dialog`,
      gma.found && gma.status === 200 && gma.body.includes(`href="${escaped}"`), `status=${gma.status}`);
  }
  const llms = invokeGet(discRouter, "/llms.txt");
  check("claude-ak2-llms: /llms.txt answers 200 and names the Claude link",
    llms.found && llms.status === 200 && llms.body.includes(URL_), `status=${llms.status}`);

  // ── AK3: no claude.ai probe ──
  const probed: string[] = [];
  for (const v of ["rfb", "dental", "experiences"] as const) {
    for (const c of cfg.distributionFor(v, "https://example.test/.well-known/agent-card.json")) {
      if (/(^|\/\/|\.)claude\.ai\b/.test(c.probe.url) || /(^|\/\/|\.)claude\.ai\b/.test(c.url)) probed.push(`${v}:${c.channel}`);
    }
  }
  check("claude-ak3: no x-distribution entry probes claude.ai (403 to robots, probes expect 200)", probed.length === 0, probed.join(", "));

  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbClaudeConnectorLinkTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
