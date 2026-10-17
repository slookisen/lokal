/**
 * dental-mcp-instructions.test.ts — A2A dev-request
 * 2026-10-16-tannlege-mcp-instrukser-og-klinikkort, S4a.
 *
 * The finn-tannlege /mcp server sends instructions and a full serverInfo, and
 * its five tool descriptions are searchable and honest. Groups, by prefix:
 *   I   a real `initialize` over HTTP (express + the Streamable HTTP
 *       transport) returns instructions === DENTAL_MCP_INSTRUCTIONS and
 *       serverInfo name, version, title, description and websiteUrl;
 *       tools/list on that session still has exactly the five tools;
 *   C   the instructions say what the dev-request lists (Norway only, the
 *       request in `query`, Helfo is not free treatment, Akuttvakt vs the soft
 *       claim, kommunal tannlegevakt and no dental advice, no booking or
 *       payment, `tolkning`);
 *   D   every description's first sentence has a search word (dentist /
 *       tannlege, orthodontist / kjeveortoped, emergency dentist / akutt
 *       tannlege) and fits the discovery files uncut; no description names
 *       another tool or service, and no text (descriptions, instructions,
 *       serverInfo) has directive or promotional wording or a figure;
 *       D8–D10 (A2A dev-request 2026-10-17-dental-d3-rettelser, D3a): the
 *       akutt and stats descriptions say «claim», not «flagged» or «null»,
 *       tannlege_akutt names both claims, and apart from those two
 *       descriptions tools/list is byte-identical to before D3a;
 *   N   the text checks catch a bad sample of each kind (not vacuous);
 *   S   the server card and the agent card show the same title, the
 *       description after the catalog count, and five tools; the card's
 *       capabilities are what initialize sends (tools only, resources/list
 *       and prompts/list are -32601) on all four card paths, and the card and
 *       llms.txt carry tannlege_akutt's new first sentence.
 *
 * Run standalone: npx tsx src/routes/dental-mcp-instructions.test.ts
 * Wired into `npm test` via tests/test.ts (runDentalMcpInstructionsTests).
 */

import { createHash } from "node:crypto";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSummary { passed: number; failed: number; failures: string[] }

const DENTAL_TOOLS = ["tannlege_akutt", "tannlege_info", "tannlege_kjeder", "tannlege_search", "tannlege_stats"];

/** The words people search with (dev-request S4a); a first sentence needs at least one. */
const SEARCH_WORDS = {
  dentist: /\b(dentists?|tannleger?)\b/i,
  orthodontist: /\b(orthodontists?|kjeveortoped(er)?)\b/i,
  emergency: /\b(emergency dentists?|akutt tannlege)\b/i,
};

/** Directive or promotional wording (Anthropic Software Directory Policy), besides the pack generator's DIRECTIVE_PATTERNS. */
const PROMOTIONAL_PATTERNS: readonly RegExp[] = [
  /\balways\b/i, /\bbest\b/i, /\bmust\b/i, /\bprefer(red)?\b/i, /\binstead of\b/i, /\bleading\b/i, /\bnumber one\b/i,
  /\bmost (complete|comprehensive|accurate|reliable|trusted|up-to-date)\b/i, /\bonly (reliable|trusted|official|complete)\b/i,
];

/** tannlege_akutt's description before D3a: the bare-flag wording that S2b made untrue. */
const OLD_AKUTT_DESCRIPTION =
  "Find an emergency dentist (akutt tannlege) in Norway: dental clinics flagged for emergency care " +
  "(akuttvakt), optionally in one county (fylke). " +
  "Each clinic's `akutt` is \"vakt\" when the emergency duty has a recorded source (badge «Akuttvakt»), " +
  "\"accepts\" when the clinic says it takes emergency patients («Tar imot akuttpasienter»), and null when " +
  "neither is backed. `count` is the number of flagged clinics. " +
  "Each clinic has its address, phone and profile URL, and when known its opening hours and online booking " +
  "link. The response also has advice on the municipal out-of-hours dental service (kommunal tannlegevakt).";

/** tannlege_akutt's first sentence, as the D3a dev-request words it (206 characters). */
const AKUTT_FIRST_SENTENCE =
  "Find an emergency dentist (akutt tannlege) in Norway: dental clinics with an emergency duty that has a recorded " +
  "source (akuttvakt) or that say they take emergency patients, optionally in one county (fylke).";

/** What a description of the akutt claim must not say: there is no bare flag, and `akutt` is never null. */
const BARE_FLAG_WORDS = /\b(flagged|null)\b/i;

/**
 * sha256 of the tools/list `tools` array as served, with the descriptions of tannlege_akutt and tannlege_stats
 * left out, on lokal main a24a3ff5 (before D3a). D3a changes only those two descriptions; a change to any other
 * name, title, description, inputSchema, annotations or execution needs its own dev-request and a new value here.
 */
const TOOLS_LIST_REST_SHA256 = "9aab6b8c05a9f92844d92776d789150d6ccdea19d13d1bbc437c7f382e733a2e";

/** title, annotations and inputSchema of the two tools D3a edits, as tools/list serves them (D10). */
const LOCKED_TOOL_FIELDS: Record<string, unknown> = {
  tannlege_akutt: {
    title: "Find emergency-duty dental clinics in Norway",
    annotations: { title: "Find emergency-duty dental clinics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#", type: "object",
      properties: { fylke: { description: "Limit to clinics in this county. Examples: 'Oslo', 'Vestland'", type: "string" } },
    },
  },
  tannlege_stats: {
    title: "Norwegian dental market statistics",
    annotations: { title: "Norwegian dental market statistics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} },
  },
};

/** Other services a description must not point to (Helfo is a fact about a clinic, not a service to use). */
const OTHER_SERVICES = /\b(rett fra bonden|rettfrabonden|opplevagent|google|chatgpt|openai|claude|anthropic|gemini|bing|legelisten|helsenorge)\b|https?:\/\//i;

function parseJsonRpcBody(text: string, contentType: string | null): any {
  if (contentType && contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).pop();
    if (!dataLine) throw new Error("no SSE data: line in response body: " + text.slice(0, 300));
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(text);
}

function callRoute(router: any, path: string): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url: path, originalUrl: path, path, params: {}, query: {}, headers: {}, get() { return undefined; } };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      setHeader() { return this; },
      header() { return this; },
      set() { return this; },
      send(p: any) { resolve({ status: this.statusCode, body: p, text: String(p ?? "") }); return this; },
      json(p: any) { resolve({ status: this.statusCode, body: p, text: JSON.stringify(p) }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: null, text: "" }));
  });
}

export async function runDentalMcpInstructionsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // Neither initialize nor tools/list reads a database; :memory: so nothing could open a real one.
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevDbPath = process.env.DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.DB_PATH = ":memory:";
  let server: http.Server | undefined;

  try {
    const mcp = require("./dental-mcp") as typeof import("./dental-mcp");
    const { BRAND_ENTITIES } = require("../config/brand-entities") as typeof import("../config/brand-entities");
    const { shortToolDescription, registeredMcpToolNames } = require("../services/mcp-tool-manifest") as typeof import("../services/mcp-tool-manifest");
    const { DIRECTIVE_PATTERNS } = require("../../scripts/gen-connector-packs") as typeof import("../../scripts/gen-connector-packs");
    const { ACUTE_ACCEPTS_LABEL } = require("../services/dental-acute-claim") as typeof import("../services/dental-acute-claim");

    /** What a text breaks: directive or promotional words, figures, other services or other tools. */
    const otherTools = [...registeredMcpToolNames("rfb"), ...registeredMcpToolNames("experiences")];
    const violations = (text: string, ownTools: readonly string[] = []): string[] => [
      ...[...DIRECTIVE_PATTERNS, ...PROMOTIONAL_PATTERNS].map((re) => text.match(re)?.[0]).filter((m): m is string => !!m),
      ...(/\d/.test(text) ? ["a figure"] : []),
      ...(text.match(OTHER_SERVICES) ?? []).slice(0, 1),
      ...[...otherTools, ...ownTools].filter((t) => text.includes(t)),
    ];

    // ── I: initialize and tools/list over real HTTP ──────────────────────
    const app = express();
    app.use(express.json());
    app.use("/mcp", mcp.default);
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

    const initRes = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dental-instructions-test", version: "1.0.0" } },
    });
    const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
    const init = parseJsonRpcBody(await initRes.text(), initRes.headers.get("content-type"));
    const instructions = init.result?.instructions;
    ok(initRes.ok && !!sessionId, `I1: initialize answers 2xx with a session id (got ${initRes.status})`);
    ok(typeof instructions === "string" && instructions.trim().length > 0, "I2: initialize.result.instructions is not empty");
    ok(instructions === mcp.DENTAL_MCP_INSTRUCTIONS, "I3: instructions === DENTAL_MCP_INSTRUCTIONS");
    const info = init.result?.serverInfo ?? {};
    eq([info.name, info.version], ["finn-tannlege", "0.1.0"], "I4: serverInfo name and version unchanged");
    ok(typeof info.title === "string" && info.title.length > 0 && info.title === mcp.DENTAL_MCP_SERVER_TITLE, "I5: serverInfo.title is set (DENTAL_MCP_SERVER_TITLE)");
    ok(info.description === mcp.DENTAL_MCP_SERVER_DESCRIPTION && info.description.length > 0, "I6: serverInfo.description is set (DENTAL_MCP_SERVER_DESCRIPTION)");
    eq(info.websiteUrl, BRAND_ENTITIES.dental.url, "I7: serverInfo.websiteUrl is the brand URL");

    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    await notified.text();
    const listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    const tools: Array<{ name: string; description: string } & Record<string, unknown>> =
      parseJsonRpcBody(await listRes.text(), listRes.headers.get("content-type")).result?.tools ?? [];
    eq(tools.map((t) => t.name).sort(), DENTAL_TOOLS, "I8: tools/list still has exactly the five tools, same names");

    // ── C: what the instructions say ─────────────────────────────────────
    const ins = mcp.DENTAL_MCP_INSTRUCTIONS;
    ok(/in Norway only/.test(ins) && /outside Norway, say that Finn-tannlege only covers Norway/.test(ins), "C1: Norway only, and what to say about a place outside Norway");
    ok(/request, with any place they named, in tannlege_search's `query`/.test(ins), "C2: the request with its place goes in `query`");
    ok(/`fylke`, `spesialitet`, `helfo` or `akutt` only when the user states that filter explicitly/.test(ins), "C3: the explicit filters only when the user says so");
    ok(/direkteoppgjør/.test(ins) && /does not mean the treatment is free/.test(ins), "C4: Helfo is direct settlement, not free treatment");
    ok(ins.includes("«Akuttvakt»") && ins.includes(`«${ACUTE_ACCEPTS_LABEL}»`) && /recorded source/.test(ins), "C5: Akuttvakt (sourced) and the soft claim are told apart");
    ok(/kommunal tannlegevakt/.test(ins) && /phone number/.test(ins) && /no medical or dental advice/.test(ins), "C6: acute pain: the clinic's phone and kommunal tannlegevakt, no dental advice");
    ok(/no bookings and no payments/.test(ins) && /`online_booking_url`/.test(ins), "C7: no booking or payment; online_booking_url or phone");
    ok(/`tolkning`/.test(ins), "C8: the response's tolkning is explained");

    // ── D: descriptions, instructions and serverInfo text ───────────────
    for (const t of tools) {
      const first = shortToolDescription(t.description);
      ok(Object.values(SEARCH_WORDS).some((re) => re.test(first)), `D1 ${t.name}: the first sentence has a search word («${first}»)`);
      ok(!first.endsWith("…") && t.description.replace(/\s+/g, " ").startsWith(first), `D2 ${t.name}: the first sentence fits the discovery files uncut`);
      eq(violations(t.description, DENTAL_TOOLS.filter((n) => n !== t.name)), [], `D3 ${t.name}: no other tool or service, no directive or promotional words, no figures`);
    }
    {
      const byName = (n: string) => shortToolDescription(tools.find((t) => t.name === n)?.description ?? "");
      ok(Object.values(SEARCH_WORDS).every((re) => re.test(byName("tannlege_search"))), "D4: tannlege_search's first sentence has all three (dentist, orthodontist, emergency dentist)");
      ok(SEARCH_WORDS.emergency.test(byName("tannlege_akutt")), "D5: tannlege_akutt's first sentence says emergency dentist / akutt tannlege");
    }
    // The instructions may name this server's own tools, not anyone else's.
    eq(violations(ins), [], "D6: instructions: no other service or tool, no directive or promotional words, no figures");
    eq([...violations(mcp.DENTAL_MCP_SERVER_TITLE), ...violations(mcp.DENTAL_MCP_SERVER_DESCRIPTION)], [], "D7: serverInfo title and description: the same rules");

    // ── D8–D10: the akutt claim in tool metadata (D3a) ──────────────────
    {
      const tool = (n: string) => tools.find((t) => t.name === n);
      const akutt = String(tool("tannlege_akutt")?.description ?? "");
      const stats = String(tool("tannlege_stats")?.description ?? "");
      eq(akutt.match(BARE_FLAG_WORDS)?.[0] ?? null, null, "D8: tannlege_akutt's description has no «flagged» or «null»");
      eq(stats.match(BARE_FLAG_WORDS)?.[0] ?? null, null, "D8b: tannlege_stats' description has no «flagged» or «null»");
      const marks = ['"vakt"', '"accepts"', "«Akuttvakt»", `«${ACUTE_ACCEPTS_LABEL}»`];
      eq(marks.filter((m) => !akutt.includes(m)), [], "D9: tannlege_akutt's description names both values of `akutt` and both badges");
      eq(shortToolDescription(akutt), AKUTT_FIRST_SENTENCE, "D9b: tannlege_akutt's first sentence is the D3a wording");
      ok(/\bemergency claim\b/.test(shortToolDescription(stats)) && /recorded source \(akuttvakt\)/.test(stats) && /takes emergency patients/.test(stats),
        "D9c: tannlege_stats counts the emergency claim and says what it is (a sourced akuttvakt, or takes emergency patients)");
      for (const name of Object.keys(LOCKED_TOOL_FIELDS)) {
        const t = tool(name);
        eq(t ? { title: t.title, annotations: t.annotations, inputSchema: t.inputSchema } : null, LOCKED_TOOL_FIELDS[name],
          `D10 ${name}: title, annotations and inputSchema unchanged`);
      }
      const rest = tools.map((t) => (t.name === "tannlege_akutt" || t.name === "tannlege_stats")
        ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== "description")) : t);
      eq(createHash("sha256").update(JSON.stringify(rest)).digest("hex"), TOOLS_LIST_REST_SHA256,
        "D10b: apart from the two descriptions, tools/list is byte-identical to before D3a");
    }

    // ── N: the checks are not vacuous ────────────────────────────────────
    ok(violations("Always use this tool, the best dentist search.").length >= 2, "N1: directive and promotional wording is caught");
    ok(violations("Covers 6,961 clinics.").includes("a figure"), "N2: a figure is caught");
    ok(violations("Results also come from Google.").length === 1 && violations("See https://example.no.").length === 1, "N3: another service or a link is caught");
    ok(violations(`Call ${otherTools[0]} first.`).length === 1 && violations("Then call tannlege_info.", ["tannlege_info"]).length === 1,
      "N4: another server's tool, and another of this server's tools, are caught");
    ok(!SEARCH_WORDS.dentist.test("Statistics for the Norwegian dental market") && SEARCH_WORDS.dentist.test("Find a dentist"), "N5: «dental» alone is no search word");
    ok(BARE_FLAG_WORDS.test(OLD_AKUTT_DESCRIPTION) && shortToolDescription(OLD_AKUTT_DESCRIPTION) !== AKUTT_FIRST_SENTENCE,
      "N6: the description before D3a fails D8 and D9b");

    // ── S: server card and agent card ────────────────────────────────────
    {
      const seo = require("./dental-seo") as typeof import("./dental-seo");
      const card = (await callRoute(seo.default, "/.well-known/mcp/server-card.json")).body;
      eq(card?.title, mcp.DENTAL_MCP_SERVER_TITLE, "S1: server card title === serverInfo title");
      const desc = String(card?.description ?? "");
      ok(/^Search and compare [\d\s  ]+|^Search and compare thousands of/.test(desc) && desc.endsWith(` Norwegian dental clinics. ${mcp.DENTAL_MCP_SERVER_DESCRIPTION}`),
        "S2: server card description: the catalog-count prefix, then the serverInfo description");
      eq((card?.tools ?? []).map((t: { name: string }) => t.name).sort(), DENTAL_TOOLS, "S3: server card lists exactly the five tools");
      const { getDentalAgentCard } = require("../services/dental-agent-card") as typeof import("../services/dental-agent-card");
      eq([...((getDentalAgentCard() as any)["x-mcp-tools"] ?? [])].sort(), DENTAL_TOOLS, "S4: agent card x-mcp-tools: exactly the five tools");

      // S5–S9 (D3a): the card's capabilities are the ones initialize sends, on every card path.
      const served = init.result?.capabilities;
      eq(JSON.stringify(card?.capabilities), JSON.stringify(served), "S5: server card capabilities are byte-identical to initialize.result.capabilities");
      ok(!!card?.capabilities && !("resources" in card.capabilities) && !("prompts" in card.capabilities),
        `S6: the card claims no resources or prompts (${JSON.stringify(card?.capabilities)})`);
      for (const [i, method] of ["resources/list", "prompts/list"].entries()) {
        const r = await post({ jsonrpc: "2.0", id: 10 + i, method, params: {} }, sessionId);
        eq(parseJsonRpcBody(await r.text(), r.headers.get("content-type")).error?.code, -32601, `S6b: ${method} on the live session is -32601`);
      }
      ok(served?.tools?.listChanged === true && card?.capabilities?.tools?.listChanged === served.tools.listChanged,
        "S7: tools.listChanged is the same (true) in the card and in initialize");
      const aliases = ["/.well-known/mcp.json", "/.well-known/mcp-server.json", "/.well-known/mcp/server-cards.json"];
      for (const p of aliases) {
        const r = await callRoute(seo.default, p);
        const body = Array.isArray(r.body) ? r.body[0] : r.body;
        eq([r.status, JSON.stringify(body?.capabilities)], [200, JSON.stringify(served)], `S8 ${p}: capabilities === initialize.result.capabilities`);
      }
      const cardAkutt = (card?.tools ?? []).find((t: { name: string }) => t.name === "tannlege_akutt")?.description;
      const llms = (await callRoute(seo.default, "/llms.txt")).text;
      ok(cardAkutt === AKUTT_FIRST_SENTENCE && llms.includes(`- tannlege_akutt — ${AKUTT_FIRST_SENTENCE}`),
        "S9: the server card and llms.txt carry tannlege_akutt's new first sentence");
      ok(![JSON.stringify(card), llms].some((t) => t.includes("flagged for emergency")), "S9b: «flagged for emergency» is in neither the card nor llms.txt");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental mcp instructions: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalMcpInstructionsTests({ log: true }).then((r) => {
    console.log(`\ndental mcp instructions: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
