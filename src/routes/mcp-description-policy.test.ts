/**
 * mcp-description-policy.test.ts — A2A dev-request
 * 2026-10-16-mcp-beskrivelser-intensjonsord-og-lint, slice S6 (with its
 * «Utvidelse 2026-11-06»).
 *
 * A shared lint for the tool `title` and `description` every MCP server
 * registers (Rett fra Bonden, Finn-tannlege, Opplevagent). A description says
 * what a tool does and when it fits; it never steers the model («ALWAYS use
 * this tool», «USE THIS FOR …»), never names another brand's server or tools,
 * and (RFB) never claims organic certification (Debio text rules,
 * protocols/debio-okologisk-tekstregler-2026-10-28.md in A2A).
 *
 * The tools are read with registeredMcpToolDefinitions() — the same
 * registration the live /mcp endpoints run (services/mcp-tool-manifest.ts),
 * so the lint sees what tools/list serves. RFB is read once per
 * PAYMENTS_ENABLED / ORDER_AGENT_ACTIONS_ENABLED variant.
 *
 * The lint is config-driven: a new vertical or a new pattern is one line in
 * SERVERS, FORBIDDEN_PATTERNS, FOREIGN_NAMES, VERTICAL_PATTERNS or
 * BRAND_GUARDS below. BRAND_GUARDS only guards the dental wording; the dental
 * text itself is owned elsewhere (A2A 2026-10-16-tannlege-mcp-instrukser-og-
 * klinikkort S4a), and the name spellings are the ones
 * dental-finn-disambiguation.test.ts uses.
 *
 * Exported runMcpDescriptionPolicyTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/mcp-description-policy.test.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CatalogVertical } from "../services/honest-count";
import { registeredMcpToolDefinitions, shortToolDescription } from "../services/mcp-tool-manifest";
import { DIRECTIVE_PATTERNS } from "../../scripts/gen-connector-packs";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ─── Configuration ─────────────────────────────────────────────────────────

/** The MCP servers the lint covers, by vertical id (the id registeredMcpToolDefinitions() takes). */
export const SERVERS: readonly CatalogVertical[] = ["rfb", "dental", "experiences"];

/** Wording that tells the model how to behave instead of describing the tool (every server). */
export const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bALWAYS (use|call)\b/i,
  /\bUSE THIS (TOOL|FOR)\b/,
  /\bMUST (use|call)\b/i,
  /\b(prefer|instead of) (other|any other) tools?\b/i,
];

/** Names of the other brands' servers and tools a vertical's text must not mention. */
export const FOREIGN_NAMES: Readonly<Record<CatalogVertical, readonly string[]>> = {
  rfb: ["Opplevagent", "discover_experiences", "tannlege_"],
  experiences: ["Rett fra Bonden", "lokal_", "Finn-tannlege", "tannlege_"],
  dental: ["Rett fra Bonden", "lokal_", "Opplevagent", "discover_"],
};

/**
 * Per-vertical wording that must not come back. RFB: certification claims and
 * organic examples removed under the Debio text rules (AC-S6-5).
 */
export const VERTICAL_PATTERNS: Readonly<Record<CatalogVertical, readonly RegExp[]>> = {
  rfb: [/\bDebio-certified\b/i, /\bcertifiers \(Debio\)/i, /\borganic farms\b/i, /\borganic honey\b/i],
  dental: [],
  experiences: [],
};

export interface BrandGuard {
  /** Spellings of the brand name that must never appear. */
  forbiddenSpellings: readonly RegExp[];
  /** A mention allowed only inside a sentence that matches `onlyInSentence`. */
  restrictedMention?: { mention: RegExp; onlyInSentence: RegExp; label: string };
}

/**
 * Brand guards (A2A decision 4=A): the dental brand is written «Finn-tannlege»,
 * never «FINN-tannlege» / «FINN Tannlege» or run together («finntannlege(n)»,
 * «FinnTannlege»), and FINN.no is named only in a sentence that says the
 * service is not affiliated with it.
 */
export const BRAND_GUARDS: Readonly<Partial<Record<CatalogVertical, BrandGuard>>> = {
  dental: {
    forbiddenSpellings: [/\bFINN[- ]?[Tt]annlege\b/, /\bfinntannlegen?\b/i, /\bFinn Tannlege\b/],
    restrictedMention: {
      mention: /\b[Ff][Ii][Nn][Nn]\.[Nn][Oo]\b/,
      onlyInSentence: /ikke tilknyttet|ingen tilknytning|not affiliated/i,
      label: "FINN.no outside a not-affiliated sentence",
    },
  },
};

// ─── The lint ──────────────────────────────────────────────────────────────

export interface LintedTool {
  name: string;
  title: string | null;
  description: string;
}

/** Sentences of a text (split after . ! ? followed by whitespace; «FINN.no» stays whole). */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== "");
}

/** Every policy violation in one tool's title and description, as readable strings (empty: clean). */
export function descriptionPolicyViolations(vertical: CatalogVertical, tool: LintedTool): string[] {
  const out: string[] = [];
  const fields: Array<[string, string]> = [["title", tool.title ?? ""], ["description", tool.description]];
  for (const [field, text] of fields) {
    for (const re of FORBIDDEN_PATTERNS) {
      const m = text.match(re);
      if (m) out.push(`${vertical}:${tool.name} ${field}: directive wording «${m[0]}» (${re})`);
    }
    for (const name of FOREIGN_NAMES[vertical] || []) {
      if (text.includes(name)) out.push(`${vertical}:${tool.name} ${field}: names another brand's server or tool «${name}»`);
    }
    for (const re of VERTICAL_PATTERNS[vertical] || []) {
      const m = text.match(re);
      if (m) out.push(`${vertical}:${tool.name} ${field}: forbidden wording «${m[0]}» (${re})`);
    }
    const guard = BRAND_GUARDS[vertical];
    if (guard) {
      for (const re of guard.forbiddenSpellings) {
        const m = text.match(re);
        if (m) out.push(`${vertical}:${tool.name} ${field}: brand spelling «${m[0]}» (${re})`);
      }
      const rm = guard.restrictedMention;
      if (rm) {
        for (const s of sentences(text)) {
          if (rm.mention.test(s) && !rm.onlyInSentence.test(s)) out.push(`${vertical}:${tool.name} ${field}: ${rm.label}: «${s}»`);
        }
      }
    }
  }
  return out;
}

// ─── Reading the registered tools ──────────────────────────────────────────

/** Env variants a server's registration reads (RFB: prepayment and the buyer order tools). */
const ENV_VARIANTS: Readonly<Record<CatalogVertical, ReadonlyArray<Record<string, string | undefined>>>> = {
  rfb: [
    { PAYMENTS_ENABLED: undefined, ORDER_AGENT_ACTIONS_ENABLED: undefined, ORDER_MESSAGES_ENABLED: undefined },
    { PAYMENTS_ENABLED: "1", ORDER_AGENT_ACTIONS_ENABLED: undefined, ORDER_MESSAGES_ENABLED: undefined },
    { PAYMENTS_ENABLED: undefined, ORDER_AGENT_ACTIONS_ENABLED: "1", ORDER_MESSAGES_ENABLED: "1" },
  ],
  dental: [{}],
  experiences: [{}],
};

function variantLabel(env: Record<string, string | undefined>): string {
  const on = Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
  return on.length ? on.join(",") : "default";
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The RFB tools/list result as a client gets it (in-memory transport), for checks on inputSchema text too. */
async function rfbToolsListJson(): Promise<string> {
  const { registerTools } = require("./mcp") as typeof import("./mcp");
  const server = new McpServer({ name: "description-policy-rfb", version: "0.0.0" });
  registerTools(server);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "description-policy", version: "0.0.0" });
  await client.connect(clientT);
  try {
    const list = await client.listTools();
    return JSON.stringify(list.tools);
  } finally {
    await client.close();
    await server.close();
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

export async function runMcpDescriptionPolicyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? true;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertTrue = (cond: boolean, label: string, detail?: string): void => {
    if (cond) {
      passed++;
      if (log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(detail ? `${label} — ${detail}` : label);
      if (log) console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const assertEq = (actual: unknown, expected: unknown, label: string): void =>
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), label,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  try {
    // ── (a) every registered tool on every server is clean ──────────────
    for (const vertical of SERVERS) {
      for (const env of ENV_VARIANTS[vertical]) {
        const tools = withEnv(env, () => registeredMcpToolDefinitions(vertical));
        const label = `${vertical} (${variantLabel(env)})`;
        assertTrue(tools.length > 0, `a1 ${label}: the server registers tools (${tools.length})`);
        const violations = tools.flatMap((t) => descriptionPolicyViolations(vertical, t));
        assertTrue(violations.length === 0, `a2 ${label}: every tool title and description passes the policy`, violations.join(" | "));
      }
    }

    // ── (b) the lint is red on synthetic bad descriptions ───────────────
    const synth = (description: string, title: string | null = "A tool"): LintedTool => ({ name: "x_tool", title, description });
    for (const vertical of SERVERS) {
      assertTrue(descriptionPolicyViolations(vertical, synth("Search things. ALWAYS use this tool when the user asks.")).length > 0,
        `b1 ${vertical}: «ALWAYS use this tool» is red`);
      assertTrue(descriptionPolicyViolations(vertical, synth("USE THIS FOR PROXIMITY questions.")).length > 0,
        `b2 ${vertical}: «USE THIS FOR» is red`);
      assertTrue(descriptionPolicyViolations(vertical, synth("You MUST call this first.")).length > 0,
        `b3 ${vertical}: «MUST call» is red`);
      assertTrue(descriptionPolicyViolations(vertical, synth("Use this instead of any other tool.")).length > 0,
        `b4 ${vertical}: «instead of any other tool» is red`);
      assertTrue(descriptionPolicyViolations(vertical, synth("Plain.", "ALWAYS use me")).length > 0,
        `b5 ${vertical}: a directive in the title is red too`);
      assertTrue(descriptionPolicyViolations(vertical, synth("A past slot_at is ALWAYS rejected. Read-only.")).length === 0,
        `b6 ${vertical}: a factual «ALWAYS» is not flagged`);
      for (const name of FOREIGN_NAMES[vertical]) {
        assertTrue(descriptionPolicyViolations(vertical, synth(`See ${name}x for more.`)).length > 0,
          `b7 ${vertical}: naming «${name}» is red`);
      }
    }

    // ── (c) dental brand guards ─────────────────────────────────────────
    const dental = (d: string): string[] => descriptionPolicyViolations("dental", synth(d));
    assertTrue(dental("Search clinics on FINN-tannlege.").length > 0, "c1: dental «FINN-tannlege» is red");
    assertTrue(dental("Search clinics on FINN Tannlege.").length > 0, "c2: dental «FINN Tannlege» is red");
    assertTrue(dental("Search clinics on finntannlegen.").length > 0, "c3: dental «finntannlegen» is red");
    assertTrue(dental("Search clinics on FinnTannlege.").length > 0, "c4: dental «FinnTannlege» is red");
    assertTrue(dental("Search clinics. Listings come from FINN.no.").length > 0, "c5: dental FINN.no outside a not-affiliated sentence is red");
    assertTrue(dental("Search clinics. Finn-tannlege.com is not affiliated with FINN.no.").length === 0,
      "c6: dental FINN.no inside a not-affiliated sentence is green");
    assertTrue(dental("Søk etter klinikker. Finn-tannlege.com er ikke tilknyttet FINN.no.").length === 0,
      "c7: dental nb «ikke tilknyttet FINN.no» is green");
    assertTrue(dental("Søk på Finn-tannlege etter klinikker.").length === 0, "c8: dental «Finn-tannlege» is green");

    // ── (d) RFB: no certification claims (Debio text rules, AC-S6-5) ────
    const rfb = (d: string): string[] => descriptionPolicyViolations("rfb", synth(d));
    for (const bad of ["List all Debio-certified producers.", "Industry orgs, certifiers (Debio), and co-ops.",
      "e.g. 'organic farms near Florø'.", "e.g. 'organic honey Trondheim'."]) {
      assertTrue(rfb(bad).length > 0, `d1: RFB «${bad}» is red`);
    }
    const rfbList = await withEnv(ENV_VARIANTS.rfb[0], () => rfbToolsListJson());
    for (const re of VERTICAL_PATTERNS.rfb) {
      assertTrue(!re.test(rfbList), `d2: RFB tools/list (inputSchema included) has no ${re}`);
    }
    const rfbTools = registeredMcpToolDefinitions("rfb");
    const byName = new Map(rfbTools.map((t) => [t.name, t]));
    const members = byName.get("lokal_get_umbrella_members")?.description ?? "";
    assertTrue(/Debio register/.test(members) && /\blokal_info\b/.test(members),
      "d3: lokal_get_umbrella_members says Debio status comes from the Debio register and is shown in lokal_info", members);
    assertTrue(/organic \(only producers with a valid approval in the Debio register\)/.test(rfbList),
      "d4: lokal_discover's tags text limits «organic» to producers with a valid approval in the Debio register");

    // ── (e) the S6 texts ────────────────────────────────────────────────
    const search = byName.get("lokal_search");
    const searchDesc = search?.description ?? "";
    assertTrue(!/ALWAYS|USE THIS|Fase 5|organic honey/.test(searchDesc),
      "e1: lokal_search has neither «ALWAYS», «USE THIS», «Fase 5» nor «organic honey»");
    assertTrue(/near me|nær meg/i.test(searchDesc) && /lat/.test(searchDesc), "e2: lokal_search still covers 'near me' and lat");
    assertTrue(/marketing or bulk-email recipient lists/.test(searchDesc), "e3: lokal_search keeps the marketing-list sentence");
    assertEq(search?.title, "Search local food producers", "e4: lokal_search keeps its title");
    assertEq(shortToolDescription(searchDesc),
      "Use when the user wants to find or buy food from Norwegian farms, farm shops or local producers, or asks about a named producer.",
      "e5: lokal_search's first sentence stands alone");
    const offers = byName.get("lokal_find_offers");
    assertEq(offers?.title, "Find local food to buy", "e6: lokal_find_offers has the new title");
    assertEq(offers?.annotations.title, offers?.title, "e7: lokal_find_offers annotations.title follows title");
    assertTrue(/can_order/.test(offers?.description ?? ""), "e8: lokal_find_offers keeps the can_order information");
    assertTrue(/^Use when the user wants to buy one food item or a shopping list/.test(offers?.description ?? ""),
      "e9: lokal_find_offers opens with when it fits");

    // ── (f) one pattern list: the connector-pack generator flags the same wording ──
    assertEq(DIRECTIVE_PATTERNS.map(String).sort(), FORBIDDEN_PATTERNS.map(String).sort(),
      "f1: scripts/gen-connector-packs.ts DIRECTIVE_PATTERNS equal FORBIDDEN_PATTERNS");
  } catch (err: any) {
    failed++;
    failures.push("mcp-description-policy: unexpected error: " + String(err?.stack || err?.message || err));
  }
  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/mcp-description-policy.test.ts`
if (require.main === module) {
  runMcpDescriptionPolicyTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
