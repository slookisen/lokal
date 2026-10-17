/**
 * mcp-lokal-info-and-category-labels.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-A (AI-1 and AI-3).
 *
 * AI-1 (P1): live `lokal_info` for Hevd Håndverksbakeri answered
 *   `{isError:true, text:"k.openingHours.map is not a function"}`. Its
 *   openingHours is stored as text, `?.length` is true for a string, and the
 *   SDK put the TypeError's message into the tool result. Now: an array is
 *   rendered as before, a string as text, anything else is left out; the
 *   other list-valued JSON fields the handlers read get the same rule; and
 *   an uncaught handler error becomes a generic Norwegian/English message
 *   with the detail in the log (guardToolHandler).
 *
 * AI-3 (P2): «honning nær Trondheim» presented a bakery whose only «product»
 *   is the enrichment's category label «Honning» like a beekeeper listing
 *   «Løvetannhonning». A product reason naming only generic category labels
 *   (productsAreGenericCategoryNames) is now a category match; the order of
 *   the results is unchanged.
 *
 * Same duck-typed-server harness as mcp-umbrella-and-price-reality.test.ts
 * against the real production schema in an in-memory DB, plus a real MCP
 * client over InMemoryTransport for the isError path the SDK serves.
 *
 * Exported runMcpLokalInfoAndCategoryLabelsTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-lokal-info-and-category-labels.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: any;
  handler: (args: any, extra?: any) => Promise<any>;
}

// Trondheim sentrum is 63.4305, 10.3951. The bakery is the nearest, so the
// unchanged distance order puts it first — as Hevd came before the beekeeper live.
const BAKERY = "1a000000-0000-4000-8000-000000000001";
const BEEKEEPER = "1a000000-0000-4000-8000-000000000002";
const MEAT_FARM = "1a000000-0000-4000-8000-000000000003";
const PRODUCTS_TEXT = "1a000000-0000-4000-8000-000000000004";
const OBJECT_HOURS = "1a000000-0000-4000-8000-000000000005";
const MALFORMED = "1a000000-0000-4000-8000-000000000006";
const UMBRELLA = "1a000000-0000-4000-8000-000000000007";

interface Seed {
  id: string;
  name: string;
  lat: number;
  lng: number;
  city: string;
  categories: string[];
  knowledge: Record<string, string>;
}

const SEED: Seed[] = [
  {
    id: BAKERY, name: "Hevd Bakeri Fixture", lat: 63.4320, lng: 10.4000, city: "Trondheim",
    categories: ["bakery", "honey"],
    knowledge: {
      products: JSON.stringify([{ name: "Bakervarer", category: "bakery" }, { name: "Honning", category: "honey" }]),
      // The live repro: openingHours stored as a JSON string, not an array.
      opening_hours: JSON.stringify("Man–fre 10–17, lør 10–15"),
      specialties: JSON.stringify("Surdeigsbrød"),
      payment_methods: JSON.stringify("Vipps"),
      delivery_options: JSON.stringify({ pickup: true }),
      auto_sources: JSON.stringify("google_maps"),
    },
  },
  {
    id: BEEKEEPER, name: "Tirslaug Bigård Fixture", lat: 63.4500, lng: 10.4500, city: "Trondheim",
    categories: ["honey"],
    knowledge: {
      products: JSON.stringify([{ name: "Løvetannhonning", category: "honey" }, { name: "Lynghonning", category: "honey" }]),
      opening_hours: JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }, null, 7]),
    },
  },
  {
    // Honey category, but the product list does not mention honey at all.
    id: MEAT_FARM, name: "Byneset Gård Fixture", lat: 63.4600, lng: 10.4700, city: "Trondheim",
    categories: ["honey", "meat"],
    knowledge: { products: JSON.stringify([{ name: "Lammekjøtt", category: "meat" }]) },
  },
  {
    // products stored as one JSON string: getAgentKnowledgeSummary used to
    // call .filter on it and take the whole search down.
    id: PRODUCTS_TEXT, name: "Strinda Honning Fixture", lat: 63.4700, lng: 10.4900, city: "Trondheim",
    categories: ["honey"],
    knowledge: { products: JSON.stringify("Honning og egg") },
  },
  {
    id: OBJECT_HOURS, name: "Romsås Grønt Fixture", lat: 59.9600, lng: 10.8900, city: "Oslo",
    categories: ["vegetables"],
    knowledge: {
      products: JSON.stringify([{ name: "Poteter", category: "vegetables" }]),
      opening_hours: JSON.stringify({ mon: "10-17" }),
    },
  },
  {
    // A knowledge column that is not JSON at all: getAgentInfo throws a SyntaxError.
    id: MALFORMED, name: "Fana Fisk Fixture", lat: 60.3000, lng: 5.3300, city: "Bergen",
    categories: ["fish"],
    knowledge: { products: "{not json" },
  },
];

function seed(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at, umbrella_type, umbrella_member_count)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            ?, ?, ?, ?, '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?, ?)
  `);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`,
      `key-${s.id}`, s.lat, s.lng, s.city, JSON.stringify(s.categories), null, null);
    const cols = ["agent_id", "address", "phone", "email", ...Object.keys(s.knowledge)];
    const vals = [s.id, `${s.city}veien 1`, "91234567", `${s.id}@example.no`, ...Object.values(s.knowledge)];
    db.prepare(`INSERT INTO agent_knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }
  agentStmt.run(UMBRELLA, "Bondens marked Trøndelag Fixture", "Markedsnettverk", `${UMBRELLA}@example.no`,
    `https://${UMBRELLA}.example.no`, `key-${UMBRELLA}`, 63.43, 10.39, "Trondheim", "[]", "market_network", 1);
  // labels is a JSON column too: one stored as a string must not crash either tool.
  db.prepare(`
    INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source, labels, created_at)
    VALUES (?, ?, 'active', 'admin', ?, datetime('now'))
  `).run(BEEKEEPER, UMBRELLA, JSON.stringify("Fast stand"));
}

export async function runMcpLokalInfoAndCategoryLabelsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const prevDb = __peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seed(db);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404,
    json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  // The guard logs every internal error; collect them so the detail can be
  // asserted and the expected failures stay out of the test output.
  const prevError = console.error;
  const errorLog: string[] = [];
  console.error = (...args: unknown[]) => { errorLog.push(args.map(String).join(" ")); };

  try {
    const mcp = require("./mcp") as typeof import("./mcp");
    const { registerTools, guardToolHandler, textEntries, formatOpeningHoursForMcp,
      isDocumentedProductReason, MCP_INTERNAL_ERROR_TEXT, enrichParsedWithGeo } = mcp;

    const tools = new Map<string, CapturedTool>();
    const fakeServer: any = {
      registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    };
    registerTools(fakeServer, () => "test-client", () => undefined);
    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
    const info = tools.get("lokal_info")!;
    const search = tools.get("lokal_search")!;
    const leaksJsError = (t: string) => /is not a function|Cannot read propert|Unexpected token|SyntaxError|TypeError|in JSON/i.test(t);

    // ══════════════════════════════════════════════════════════════
    // AI-1 — helpers
    // ══════════════════════════════════════════════════════════════
    assertEq(textEntries(["Vipps", " Kontant ", "", 7, null, { x: 1 }]), ["Vipps", "Kontant"],
      "AI-1 textEntries: an array keeps its non-empty string entries");
    assertEq(textEntries("  Vipps "), ["Vipps"], "AI-1 textEntries: a string is one entry");
    assertEq([textEntries(null), textEntries(undefined), textEntries(42), textEntries({ a: "b" }), textEntries("  ")],
      [[], [], [], [], []], "AI-1 textEntries: null, undefined, a number, an object and blank text give no entries");

    assertEq(formatOpeningHoursForMcp([{ day: "mon", open: "10:00", close: "17:00" }, { day: "sat", open: "10:00", close: "14:00" }]),
      "\n## Åpningstider\nMan 10:00–17:00, Lør 10:00–14:00",
      "AI-1 formatOpeningHoursForMcp: today's array format renders exactly as before");
    assertEq(formatOpeningHoursForMcp("  Man–fre 10–17  "), "\n## Åpningstider\nMan–fre 10–17",
      "AI-1 formatOpeningHoursForMcp: a string is shown as text");
    assertEq([formatOpeningHoursForMcp({ mon: "10-17" }), formatOpeningHoursForMcp(42), formatOpeningHoursForMcp(null),
      formatOpeningHoursForMcp(""), formatOpeningHoursForMcp([]), formatOpeningHoursForMcp([null, 3, "x"])],
      ["", "", "", "", "", ""],
      "AI-1 formatOpeningHoursForMcp: an object, a number, null, empty text, an empty array and junk-only entries are left out");

    {
      const thrower = guardToolHandler("probe", async () => { throw new TypeError("k.openingHours.map is not a function"); });
      const before = errorLog.length;
      const r: any = await thrower();
      assertEq(r, { content: [{ type: "text", text: MCP_INTERNAL_ERROR_TEXT }], isError: true },
        "AI-1 guardToolHandler: a thrown error becomes isError with only the generic text");
      assertTrue(errorLog.slice(before).some((l) => l.includes("[mcp] probe failed:") && l.includes("k.openingHours.map is not a function")),
        "AI-1 guardToolHandler: the tool name and the error detail go to the log");
      const ok = { content: [{ type: "text" as const, text: "ok" }] };
      const passthrough = guardToolHandler("probe", async (a: number, b: string) => ({ ...ok, args: [a, b] }));
      assertEq(await passthrough(1, "x"), { ...ok, args: [1, "x"] },
        "AI-1 guardToolHandler: a normal result and the arguments pass through unchanged");
    }
    assertTrue(/Beklager/.test(MCP_INTERNAL_ERROR_TEXT) && /Sorry/.test(MCP_INTERNAL_ERROR_TEXT) && !leaksJsError(MCP_INTERNAL_ERROR_TEXT),
      "AI-1: the generic message is Norwegian and English and carries no error detail");

    // ══════════════════════════════════════════════════════════════
    // AI-1 — lokal_info, regression for the live repro
    // ══════════════════════════════════════════════════════════════
    {
      const r = await info.handler({ agentId: BAKERY });
      const t = textOf(r);
      assertTrue(r?.isError !== true && t.startsWith("# Hevd Bakeri Fixture"),
        `AI-1 repro: lokal_info returns the profile of a producer with openingHours stored as text (got: ${t.slice(0, 120)})`);
      assertTrue(t.includes("\n## Åpningstider\nMan–fre 10–17, lør 10–15"), "AI-1 repro: the text opening hours are shown as text");
      assertTrue(/## Produkter \(2 stk\)/.test(t) && t.includes("- Honning [honey]"), "AI-1 repro: the product list is still there");
      assertTrue(t.includes("\n## Spesialiteter\n- Surdeigsbrød") && t.includes("💳 **Betaling:** Vipps"),
        "AI-1 audit: specialties and paymentMethods stored as text are shown as one entry");
      assertTrue(!t.includes("Levering"), "AI-1 audit: deliveryOptions stored as an object is left out");
      assertTrue(t.includes("(kilder: google_maps)"), "AI-1 audit: autoSources stored as text is shown");
      assertTrue(!leaksJsError(t), "AI-1 repro: no JavaScript error text in the result");
    }
    {
      const t = textOf(await info.handler({ agentId: BEEKEEPER }));
      assertTrue(t.includes("\n## Åpningstider\nLør 10:00–14:00\n"),
        `AI-1: array opening hours render as before, null and non-object entries skipped (got: ${(t.match(/## Åpningstider\n.*\n/) || [""])[0]})`);
    }
    {
      const r = await info.handler({ agentId: OBJECT_HOURS });
      const t = textOf(r);
      assertTrue(r?.isError !== true && t.startsWith("# Romsås Grønt Fixture") && !t.includes("Åpningstider"),
        "AI-1: openingHours of an unknown type (object) is left out and the profile is returned");
      db.prepare("UPDATE agent_knowledge SET opening_hours = '42' WHERE agent_id = ?").run(OBJECT_HOURS);
      const n = textOf(await info.handler({ agentId: OBJECT_HOURS }));
      assertTrue(n.startsWith("# Romsås Grønt Fixture") && !n.includes("Åpningstider"),
        "AI-1: openingHours of an unknown type (number) is left out and the profile is returned");
    }
    {
      const before = errorLog.length;
      const r = await info.handler({ agentId: MALFORMED });
      const t = textOf(r);
      assertTrue(r?.isError === true && t === MCP_INTERNAL_ERROR_TEXT,
        `AI-1: an internal error in lokal_info gives isError with the generic message (got: ${t.slice(0, 120)})`);
      assertTrue(!leaksJsError(t), "AI-1: the SyntaxError text does not reach the tool result");
      assertTrue(errorLog.slice(before).some((l) => l.includes("[mcp] lokal_info failed:") && /JSON/.test(l)),
        "AI-1: the SyntaxError detail is logged under the tool name");
    }

    // The isError result as a real MCP client receives it: the SDK used to
    // put error.message here (McpServer createToolError).
    {
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
      const server = new McpServer({ name: "rfb-ai1-test", version: "0.0.0" });
      registerTools(server);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "rfb-ai1-test", version: "0.0.0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        const bad: any = await client.callTool({ name: "lokal_info", arguments: { agentId: MALFORMED } });
        assertTrue(bad?.isError === true && textOf(bad) === MCP_INTERNAL_ERROR_TEXT && bad.content.length === 1,
          `AI-1 (MCP client): tools/call lokal_info answers an internal error with only the generic message (got: ${JSON.stringify(bad).slice(0, 200)})`);
        const good: any = await client.callTool({ name: "lokal_info", arguments: { agentId: BAKERY } });
        assertTrue(good?.isError !== true && textOf(good).includes("Man–fre 10–17, lør 10–15"),
          "AI-1 (MCP client): tools/call lokal_info returns the profile with text opening hours");
      } finally {
        await client.close();
        await server.close();
      }
    }

    // The same class in the other handlers.
    {
      const t = textOf(await search.handler({ query: "Hevd Bakeri Fixture", limit: 10 }));
      assertTrue(t.includes("**Spesialiteter:** Surdeigsbrød") && t.includes("💳 **Betaling:** Vipps") && !t.includes("Levering"),
        `AI-1 audit: lokal_search's detailed view shows text specialties/paymentMethods and leaves out an object (got: ${t.slice(0, 200)})`);
    }
    {
      const members = textOf(await tools.get("lokal_get_umbrella_members")!.handler({ umbrellaId: UMBRELLA, limit: 100 }));
      assertTrue(members.includes("**Tirslaug Bigård Fixture** — Trondheim _(Fast stand)_"),
        `AI-1 audit: lokal_get_umbrella_members shows labels stored as text (got: ${members.slice(0, 200)})`);
      const affiliations = textOf(await tools.get("lokal_get_producer_affiliations")!.handler({ producerId: BEEKEEPER }));
      assertTrue(affiliations.includes("**Bondens marked Trøndelag Fixture** (Marked-nettverk) _(Fast stand)_"),
        `AI-1 audit: lokal_get_producer_affiliations shows labels stored as text (got: ${affiliations.slice(0, 200)})`);
      db.prepare("UPDATE agent_affiliations SET labels = ? WHERE producer_id = ?").run(JSON.stringify({ stand: 4 }), BEEKEEPER);
      const objLabels = textOf(await tools.get("lokal_get_umbrella_members")!.handler({ umbrellaId: UMBRELLA, limit: 100 }));
      assertTrue(objLabels.includes("**Tirslaug Bigård Fixture** — Trondheim\n"),
        "AI-1 audit: labels stored as an object are left out");
    }

    // ══════════════════════════════════════════════════════════════
    // AI-3 — generic category labels are a category match
    // ══════════════════════════════════════════════════════════════
    assertEq(
      ["Produkter: Honning", "Produkter: Egg", "Produkter: Bakervarer, Honning", "Produkter: HONNING", "Kategorier: honey"].map(isDocumentedProductReason),
      [false, false, false, false, false],
      "AI-3 isDocumentedProductReason: only generic category labels (any case), or no product reason, is no product evidence");
    assertEq(
      ["Produkter: Løvetannhonning", "Produkter: Honning, Lynghonning", "Produkter: Honning, flytende 500 g", "Produkter: Frittgående egg"].map(isDocumentedProductReason),
      [true, true, true, true],
      "AI-3 isDocumentedProductReason: one real product name is enough");

    {
      const query = "honning nær Trondheim";
      const r = await search.handler({ query, limit: 10 });
      const t = textOf(r);
      const headings = [...t.matchAll(/^\*\*(\d+)\. (.+?)\*\*$/gm)].map((m) => ({ n: Number(m[1]), heading: m[2] }));
      const headingOf = (name: string) => headings.find((h) => h.heading.startsWith(name))?.heading ?? "";
      assertTrue(r?.isError !== true && headings.length === 4,
        `AI-3: «${query}» finds the four Trondheim fixtures (got ${headings.length}: ${t.slice(0, 200)})`);

      assertEq(headingOf("Hevd Bakeri Fixture"),
        "Hevd Bakeri Fixture — Kategoritreff / category-only: «honning» bare som kategorinavn / category name only",
        "AI-3: the bakery whose «Honning» is a category label is marked as a category match");
      assertTrue(t.includes("⚠️ Kategoritreff: produktlista har «honning» bare som kategorinavn, ikke som et bestemt produkt — spør produsenten. / Category match only: the product list has «honning» only as a category name, not as a specific product; ask the producer."),
        "AI-3: the note says the product list only has the category name");
      assertTrue(!t.includes("Beskrivelse av Hevd Bakeri Fixture"), "AI-3: the category match hides its description, as other category matches do");
      assertTrue(/Hevd Bakeri Fixture[\s\S]*?91234567/.test(t) && t.includes(`agentId "${BAKERY}"`),
        "AI-3: the category match keeps its contact details and the lokal_info pointer");

      assertEq(headingOf("Tirslaug Bigård Fixture"), "Tirslaug Bigård Fixture",
        "AI-3: the beekeeper with real product names is an explicit match");
      assertTrue(t.includes("Beskrivelse av Tirslaug Bigård Fixture") && t.includes("Løvetannhonning"),
        "AI-3: the explicit match keeps its description and product names");

      assertEq(headingOf("Byneset Gård Fixture"),
        "Byneset Gård Fixture — Kategoritreff / category-only: «honning» ikke oppført / not listed",
        "AI-3: a category match whose products do not mention honey keeps the existing label");
      assertTrue(t.includes("Category match only: the listed products don't mention «honning»; ask the producer."),
        "AI-3: …and the existing note");
      assertEq(headingOf("Strinda Honning Fixture"),
        "Strinda Honning Fixture — Kategoritreff / category-only: «honning» ikke oppført / not listed",
        "AI-1 audit: products stored as text no longer take lokal_search down; the producer is a category match");

      // Order unchanged: the headings follow discover() exactly.
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      await enrichParsedWithGeo(parsed, query);
      const expected = marketplaceRegistry.discover({ ...parsed, limit: 10, offset: 0 }).map((x) => x.agent.name);
      assertEq(headings.map((h) => h.heading.split(" — ")[0]), expected, "AI-3: the order of the results is discover()'s order");
      assertEq(headings.map((h) => h.n), [1, 2, 3, 4], "AI-3: the results stay numbered 1..n");
      assertTrue(headingOf("Hevd Bakeri Fixture") !== "" && expected.indexOf("Hevd Bakeri Fixture") < expected.indexOf("Tirslaug Bigård Fixture"),
        "AI-3: the nearer bakery still comes before the beekeeper (labelling only, no re-ranking)");
    }
  } finally {
    console.log = prevLog;
    console.error = prevError;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    marketplaceRegistry._agentsCache = null;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runMcpLokalInfoAndCategoryLabelsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
