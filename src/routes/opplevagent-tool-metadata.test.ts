/**
 * opplevagent-tool-metadata.test.ts — A2A dev-request
 * 2026-10-16-mcp-beskrivelser-intensjonsord-og-lint, slices S7 and S9
 * (AC-S7-2, and the S9 assert behind AC-S9-2).
 *
 * The five Opplevagent tools open with the user's intent, within Daniel's
 * positioning decision 1=B (gårdssalg, smaking og drikke):
 *   - no tool's first sentence has a broad word from alternative A
 *     (BROAD_TERMS_NOT_CHOSEN);
 *   - discover_experiences' first sentence has at least one English and one
 *     Norwegian intent word from the experiences list, and says it searches
 *     Opplevagent's published catalogue;
 *   - discover_gardssalg's first sentence has intent words, names a visit or
 *     tasting, and says the tool does not sell or order products;
 *   - book_gardssalg's first sentence says the same about selling/ordering.
 *
 * OPPLEVAGENT_MCP_INSTRUCTIONS is frozen (contract freeze) and not checked
 * here. The words live in src/config/mcp-intent-terms.ts. The tools are read
 * with registeredMcpToolDefinitions("experiences"), the registration the live
 * /mcp endpoint runs; the first sentence is shortToolDescription(), the one
 * the discovery files (/.well-known/mcp.json, server card, /llms.txt) show.
 *
 * Exported runOpplevagentToolMetadataTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/opplevagent-tool-metadata.test.ts
 */

import { registeredMcpToolDefinitions, shortToolDescription } from "../services/mcp-tool-manifest";
import { MCP_INTENT_TERMS, BROAD_TERMS_NOT_CHOSEN, broadTermsIn, intentTermsIn } from "../config/mcp-intent-terms";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export const OPPLEVAGENT_TOOLS = [
  "discover_experiences", "list_experience_categories", "get_experience", "discover_gardssalg", "book_gardssalg",
] as const;

const DOES_NOT_SELL_OR_ORDER = /\bdoes not sell or order\b|\bselger (ikke|eller bestiller ikke)\b/i;

export function runOpplevagentToolMetadataTests(opts: { log?: boolean } = {}): TestSummary {
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

  try {
    const terms = MCP_INTENT_TERMS.experiences!;
    assertTrue(!!terms && terms.en.length > 0 && terms.no.length > 0, "m0: mcp-intent-terms has an experiences list in English and Norwegian");

    const tools = registeredMcpToolDefinitions("experiences");
    const byName = new Map(tools.map((t) => [t.name, t]));
    assertTrue(JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...OPPLEVAGENT_TOOLS].sort()),
      "m1: the server registers exactly the five Opplevagent tools", tools.map((t) => t.name).join(", "));

    const first = (name: string): string => shortToolDescription(byName.get(name)?.description ?? "");

    // ── (a) no broad intent word from alternative A opens a tool ────────
    for (const name of OPPLEVAGENT_TOOLS) {
      const s = first(name);
      assertTrue(s.length > 0 && !s.endsWith("…"), `m2 ${name}: has a whole first sentence (not cut at the discovery-file cap)`, s);
      const broad = broadTermsIn(s);
      assertTrue(broad.length === 0, `m3 ${name}: first sentence has no word from BROAD_TERMS_NOT_CHOSEN`, `${broad.join(", ")} in «${s}»`);
      const title = byName.get(name)?.title ?? "";
      assertTrue(broadTermsIn(title).length === 0, `m4 ${name}: title has no word from BROAD_TERMS_NOT_CHOSEN`, title);
    }

    // ── (b) discover_experiences: en + no intent words, honest catalogue ─
    const exp = first("discover_experiences");
    const expTerms = intentTermsIn(exp, terms);
    assertTrue(expTerms.en.length >= 1, "m5: discover_experiences' first sentence has an English intent word", exp);
    assertTrue(expTerms.no.length >= 1, "m6: discover_experiences' first sentence has a Norwegian intent word", exp);
    assertTrue(/Opplevagent's published catalogue of experiences in Norway/.test(exp),
      "m7: discover_experiences says it searches Opplevagent's published catalogue of experiences in Norway", exp);
    assertTrue(!/\bonly\b|\bbare\b/i.test(exp),
      "m8: discover_experiences does not claim the catalogue is only farm sales and drinks", exp);

    // ── (c) discover_gardssalg (S9): visit/tasting, does not sell/order ──
    const gs = first("discover_gardssalg");
    const gsTerms = intentTermsIn(gs, terms);
    assertTrue(gsTerms.en.length + gsTerms.no.length >= 1, "m9: discover_gardssalg's first sentence has intent words", gs);
    assertTrue(/\b(visit|tasting)\b|besøk|smaking/i.test(gs), "m10: discover_gardssalg's first sentence names a visit or tasting", gs);
    assertTrue(DOES_NOT_SELL_OR_ORDER.test(gs), "m11: discover_gardssalg's first sentence says it does not sell or order products", gs);

    // ── (d) book_gardssalg (S9): a visit request, does not sell/order ────
    const bk = first("book_gardssalg");
    assertTrue(/visit request|besøksforespørsel/i.test(bk), "m12: book_gardssalg's first sentence says it sends a visit request", bk);
    assertTrue(DOES_NOT_SELL_OR_ORDER.test(bk), "m13: book_gardssalg's first sentence says it does not sell or order products", bk);

    // ── (e) the helpers are red on synthetic text ───────────────────────
    for (const w of BROAD_TERMS_NOT_CHOSEN) {
      assertTrue(broadTermsIn(`Find ${w.toUpperCase()} in Norway.`).length > 0, `m14: «${w}» is caught case-insensitively`);
    }
    assertTrue(intentTermsIn("Search Norwegian experiences.", terms).en.length === 0 &&
      intentTermsIn("Search Norwegian experiences.", terms).no.length === 0,
      "m15: a sentence without intent words has none");
    assertTrue(!DOES_NOT_SELL_OR_ORDER.test("Find drink producers selling directly from the farm."),
      "m16: a selling sentence is not read as «does not sell or order»");
  } catch (err: any) {
    failed++;
    failures.push("opplevagent-tool-metadata: unexpected error: " + String(err?.stack || err?.message || err));
  }
  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/opplevagent-tool-metadata.test.ts`
if (require.main === module) {
  const summary = runOpplevagentToolMetadataTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  for (const f of summary.failures) console.log(f);
  // Explicit exit: requiring the route modules leaves background timers open.
  process.exit(summary.failed > 0 ? 1 : 0);
}
