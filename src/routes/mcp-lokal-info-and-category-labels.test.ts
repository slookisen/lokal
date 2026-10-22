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
 *   with the detail in the log (guardToolHandler). Fix round 1: a cart-service
 *   5xx result is internal error text too — lokal_cart_submit returned
 *   `Submit failed: <SQLite message>` when its transaction failed. Its error
 *   is now the generic message in the same JSON shape (cartResultText), with
 *   PAYMENTS_ENABLED off and on; 4xx messages stay.
 *
 * AI-3 (P2): «honning nær Trondheim» presented a bakery whose only «product»
 *   is the enrichment's category label «Honning» like a beekeeper listing
 *   «Løvetannhonning». A producer whose matched product names are only
 *   generic category labels (productsAreGenericCategoryNames) is now a
 *   category match; the order of the results was unchanged (slice I-N has
 *   since put explicit matches first, and lists labels as categories in
 *   lokal_info — mcp-product-labels-and-order.test.ts). Fix round 1: the
 *   names come from discover() (DiscoverMeta.productMatches), not from the
 *   «Produkter: …» reason, which names at most three.
 *
 * Same duck-typed-server harness as mcp-umbrella-and-price-reality.test.ts
 * against the real production schema in an in-memory DB, plus a real MCP
 * client over InMemoryTransport for the isError path the SDK serves. The
 * frozen MCP contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runMcpLokalInfoAndCategoryLabelsTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-lokal-info-and-category-labels.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import type { PaymentsStripeClient } from "../services/payment-provider";

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
const MANY_LABELS = "1a000000-0000-4000-8000-000000000008";
const CART_FARM = "1a000000-0000-4000-8000-000000000009";
const CART_PRODUCT = "1a000000-0000-4000-8000-0000000000a1";

// The DB error the reviewer's repro raised inside the submit transaction.
const SUBMIT_DB_ERROR = "SQLITE internal detail: disk I/O error at page 4711";

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
    // A knowledge column that is not JSON at all. Slice I-F reads it as empty
    // (knowledge-service-type-guards.test.ts); the internal-error tests below
    // make getAgentInfo throw for this producer instead (failInfoFor).
    id: MALFORMED, name: "Fana Fisk Fixture", lat: 60.3000, lng: 5.3300, city: "Bergen",
    categories: ["fish"],
    knowledge: { products: "{not json" },
  },
  {
    // Four matched names, the first three of them the category label: the
    // «Produkter: …» reason names only those three.
    id: MANY_LABELS, name: "Saltstraumen Bigård Fixture", lat: 67.2800, lng: 14.4000, city: "Bodø",
    categories: ["honey"],
    knowledge: {
      products: JSON.stringify([{ name: "Honning" }, { name: "honning" }, { name: "HONNING" }, { name: "Lynghonning" }]),
    },
  },
  {
    // Owner-verified and opted in to orders (set in seed()), so a submit
    // creates a real order — the path whose transaction the trigger fails.
    id: CART_FARM, name: "Tromsdalen Eggegård Fixture", lat: 69.6500, lng: 18.9600, city: "Tromsø",
    categories: ["eggs"],
    knowledge: { products: JSON.stringify([{ name: "Gårdsegg", category: "eggs" }]), verification_status: "verified" },
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
  db.prepare("UPDATE agents SET is_verified = 1, order_notifications_opt_in = 1 WHERE id = ?").run(CART_FARM);
  db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source)
    VALUES (?, ?, 'Gårdsegg', 'gardsegg', 60, 'brett', 'in_stock', 'admin_producer_confirmed')`).run(CART_PRODUCT, CART_FARM);
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

  // An internal error in lokal_info: getAgentInfo throws the SyntaxError a
  // knowledge column that is not JSON raised before slice I-F made such a
  // column read as empty. null restores the real method.
  const { knowledgeService } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
  const realGetAgentInfo = knowledgeService.getAgentInfo;
  const failInfoFor = (failingId: string | null) => {
    knowledgeService.getAgentInfo = failingId === null ? realGetAgentInfo : function (this: typeof knowledgeService, id: string) {
      if (id === failingId) throw new SyntaxError("Expected property name or '}' in JSON at position 1 (line 1 column 2)");
      return realGetAgentInfo.call(this, id);
    };
  };

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  // The guard logs every internal error; collect them so the detail can be
  // asserted and the expected failures stay out of the test output.
  const prevError = console.error;
  const errorLog: string[] = [];
  console.error = (...args: unknown[]) => { errorLog.push(args.map(String).join(" ")); };

  try {
    const mcp = require("./mcp") as typeof import("./mcp");
    const { registerTools, guardToolHandler, textEntries, formatOpeningHoursForMcp, cartResultText,
      documentsListedProduct, MCP_INTERNAL_ERROR_TEXT, enrichParsedWithGeo } = mcp;

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
    assertEq(formatOpeningHoursForMcp("  Man–fre 10–17 (sommer)  "), "\n## Åpningstider\nMan–fre 10–17 (sommer)",
      "AI-1 formatOpeningHoursForMcp: a string is shown as text");
    assertEq(formatOpeningHoursForMcp("  Man–fre 10–17  "), "\n## Åpningstider\nMan–Fre 10:00–17:00",
      "AI-1 formatOpeningHoursForMcp: a string in the day-and-time form is read as days and times (slice I-O)");
    assertEq([formatOpeningHoursForMcp({ mon: "10-17" }), formatOpeningHoursForMcp(42), formatOpeningHoursForMcp(null),
      formatOpeningHoursForMcp(""), formatOpeningHoursForMcp([]), formatOpeningHoursForMcp([null, 3, {}, "  "])],
      ["", "", "", "", "", ""],
      "AI-1 formatOpeningHoursForMcp: an object, a number, null, empty text, an empty array and junk-only entries are left out");
    {
      // Fix round 1 (S5): entries without text open/close used to render as
      // "undefined"; a text entry inside the array used to be dropped.
      const mixed = formatOpeningHoursForMcp([
        { day: "mon", open: "10:00", close: "17:00" },
        " Lør etter avtale ",
        { day: "tue" },
        { day: "wed", open: "10:00" },
        { day: "thu", open: 10, close: 17 },
        { day: "fri", open: " ", close: "17:00" },
        { open: "09:00", close: "12:00" },
        { day: "constructor", open: "08:00", close: "09:00" },
      ]);
      // Slice I-H: number times count, as on the producer page ("10 – 17"),
      // since all three readers share utils/opening-hours.ts.
      assertEq(mixed, "\n## Åpningstider\nMan 10:00–17:00, Lør etter avtale, Tor 10–17, 09:00–12:00, constructor 08:00–09:00",
        "AI-1 formatOpeningHoursForMcp: entries without both times are skipped, number times are their digits (I-H), a text entry is shown, a missing day has no label");
      assertTrue(!mixed.includes("undefined") && !mixed.includes("function"),
        "AI-1 formatOpeningHoursForMcp: no 'undefined' and no inherited object property in the text");
    }

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
      assertTrue(t.includes("\n## Åpningstider\nMan–Fre 10:00–17:00, Lør 10:00–15:00"), "AI-1 repro: the text opening hours are shown (slice I-O: as days and times)");
      // Slice I-N (AI2-02): both of the bakery's products are category labels,
      // so lokal_info lists them as categories (mcp-product-labels-and-order.test.ts).
      assertTrue(t.includes("\n**Kategorier:** Bakervarer, Honning\n") && !t.includes("## Produkter"),
        "AI-1 repro: the product list is still there (as categories since I-N)");
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
      failInfoFor(MALFORMED);
      const r = await info.handler({ agentId: MALFORMED }).finally(() => failInfoFor(null));
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
        failInfoFor(MALFORMED);
        const bad: any = await client.callTool({ name: "lokal_info", arguments: { agentId: MALFORMED } })
          .finally(() => failInfoFor(null));
        assertTrue(bad?.isError === true && textOf(bad) === MCP_INTERNAL_ERROR_TEXT && bad.content.length === 1,
          `AI-1 (MCP client): tools/call lokal_info answers an internal error with only the generic message (got: ${JSON.stringify(bad).slice(0, 200)})`);
        const good: any = await client.callTool({ name: "lokal_info", arguments: { agentId: BAKERY } });
        assertTrue(good?.isError !== true && textOf(good).includes("Man–Fre 10:00–17:00, Lør 10:00–15:00"),
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
      [["Honning"], ["Egg"], ["Bakervarer", "Honning"], ["HONNING", " honning "], []].map(documentsListedProduct),
      [false, false, false, false, false],
      "AI-3 documentsListedProduct: only generic category labels (any case), or no matched name, is no product evidence");
    assertEq(
      [["Løvetannhonning"], ["Honning", "Lynghonning"], ["Honning, flytende 500 g"], ["Frittgående egg"], ["Honning", "honning", "HONNING", "Lynghonning"]]
        .map(documentsListedProduct),
      [true, true, true, true, true],
      "AI-3 documentsListedProduct: one real product name is enough, also as the fourth name");

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

      // Slice I-N (AI-3b): the explicit match comes first; discover()'s order
      // is kept within each group (mcp-product-labels-and-order.test.ts).
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      await enrichParsedWithGeo(parsed, query);
      const meta: import("../services/marketplace-registry").DiscoverMeta = {};
      const expected = marketplaceRegistry.discover({ ...parsed, limit: 10, offset: 0 }, meta).map((x) => x.agent.name);
      assertEq(headings.map((h) => h.heading.split(" — ")[0]),
        ["Tirslaug Bigård Fixture", ...expected.filter((n) => n !== "Tirslaug Bigård Fixture")],
        "AI-3: the explicit match comes first, the category matches follow in discover()'s order (I-N)");
      assertEq([BAKERY, BEEKEEPER, MEAT_FARM, PRODUCTS_TEXT].map((id) => meta.productMatches?.get(id) ?? null),
        [["Honning"], ["Løvetannhonning", "Lynghonning"], null, null],
        "AI-3: DiscoverMeta.productMatches holds the matched names of each producer with a product match");
      assertEq(headings.map((h) => h.n), [1, 2, 3, 4], "AI-3: the results stay numbered 1..n");
      assertTrue(headingOf("Hevd Bakeri Fixture") !== "" && expected.indexOf("Hevd Bakeri Fixture") < expected.indexOf("Tirslaug Bigård Fixture"),
        "AI-3: discover() still ranks the nearer bakery before the beekeeper (lokal_search reorders, discover() is unchanged)");
    }

    // Fix round 1 (S2): the «Produkter: …» reason names at most three
    // matched products. A producer whose first three matches are the label
    // and whose fourth is «Lynghonning» lists a real product.
    {
      const query = "honning nær Bodø";
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      await enrichParsedWithGeo(parsed, query);
      const meta: import("../services/marketplace-registry").DiscoverMeta = {};
      const found = marketplaceRegistry.discover({ ...parsed, limit: 10, offset: 0 }, meta).find((x) => x.agent.id === MANY_LABELS);
      assertTrue(!!found && found.matchReasons.includes("Produkter: Honning, honning, HONNING"),
        `AI-3 S2 setup: discover()'s reason names only the three labels (got: ${JSON.stringify(found?.matchReasons)})`);
      assertEq(meta.productMatches?.get(MANY_LABELS), ["Honning", "honning", "HONNING", "Lynghonning"],
        "AI-3 S2: DiscoverMeta.productMatches carries every matched name");

      const t = textOf(await search.handler({ query, limit: 10 }));
      assertTrue(/^\*\*1\. Saltstraumen Bigård Fixture\*\*$/m.test(t) && !/Saltstraumen Bigård Fixture —/.test(t),
        `AI-3 S2: the producer whose fourth match is a real product is an explicit match (got: ${t.slice(0, 300)})`);
      assertTrue(t.includes("Beskrivelse av Saltstraumen Bigård Fixture") && !t.includes("Kategoritreff"),
        "AI-3 S2: …with its description and no category note");
    }
    {
      // A product search with no product term keeps no product signal.
      const meta: import("../services/marketplace-registry").DiscoverMeta = {};
      marketplaceRegistry.discover({ ...marketplaceRegistry.parseNaturalQuery("egg nær Tromsø"), limit: 10, offset: 0 }, meta);
      assertTrue(meta.productMatches === undefined, "AI-3 S2: DiscoverMeta.productMatches is only set when the query has product terms");
    }

    // ══════════════════════════════════════════════════════════════
    // AI-1 audit, fix round 1 — lokal_search detailed view (S3), lokal_stats (S4)
    // ══════════════════════════════════════════════════════════════
    {
      // products stored as text: the detailed view used to push the empty
      // section formatProductsForMcp returns for it.
      const t = textOf(await search.handler({ query: "Strinda Honning Fixture", limit: 10 }));
      assertTrue(t.includes("**1. Strinda Honning Fixture**") && t.includes("\n\n🔗 [Se fullstendig profil]"),
        `AI-3/AI-1 S3 setup: a name search gives the detailed view (got: ${t.slice(0, 300)})`);
      assertTrue(!/\n\n\n/.test(t), "AI-1 S3: products stored as text add no empty section to lokal_search's detailed view");
    }
    {
      const stats = tools.get("lokal_stats")!;
      const categoriesOf = async () => {
        marketplaceRegistry._agentsCache = null;
        const r = await stats.handler({});
        return { r, n: Number((textOf(r).match(/Kategorier: (\d+)/) || [])[1]) };
      };
      const base = await categoriesOf();
      assertTrue(base.r?.isError !== true && base.n > 0, `AI-1 S4 setup: lokal_stats counts categories (got: ${textOf(base.r)})`);
      // Bergen's fish producer is the only one with «fish».
      db.prepare("UPDATE agents SET categories = ? WHERE id = ?").run(JSON.stringify("fish"), MALFORMED);
      const asText = await categoriesOf();
      assertEq(asText.n, base.n, "AI-1 S4: categories stored as text count as one category, not one per letter");
      db.prepare("UPDATE agents SET categories = ? WHERE id = ?").run(JSON.stringify({ fish: true }), MALFORMED);
      const asObject = await categoriesOf();
      assertTrue(asObject.r?.isError !== true && asObject.n === base.n - 1,
        `AI-1 S4: categories stored as an object are left out instead of failing lokal_stats (got: ${textOf(asObject.r)})`);
      db.prepare("UPDATE agents SET categories = ? WHERE id = ?").run(JSON.stringify(["fish"]), MALFORMED);
      marketplaceRegistry._agentsCache = null;
    }

    // ══════════════════════════════════════════════════════════════
    // AI-1, fix round 1 (B1) — a cart-service 5xx result is internal text
    // ══════════════════════════════════════════════════════════════
    {
      const before = errorLog.length;
      const failed503 = cartResultText("probe", { success: false, status: 503, error: "Submit failed: SQLITE_BUSY" });
      assertEq(JSON.parse(failed503), { success: false, status: 503, error: MCP_INTERNAL_ERROR_TEXT },
        "AI-1 B1 cartResultText: a 5xx result keeps its shape and status, its error is the generic text");
      assertTrue(errorLog.slice(before).some((l) => l.includes("[mcp] probe failed: status 503:") && l.includes("SQLITE_BUSY")),
        "AI-1 B1 cartResultText: the 5xx detail is logged under the tool name");
      const kept = [
        { success: false, status: 409, error: "Cart is already submitted" },
        { success: false, status: 400, error: "Cart is empty" },
        { success: true, order_id: "o-1", status: "pending" },
      ];
      assertEq(kept.map((r) => cartResultText("probe", r)), kept.map((r) => JSON.stringify(r, null, 2)),
        "AI-1 B1 cartResultText: 4xx results and a success with a text status are returned as they are");
    }

    const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
    const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
    const paymentSvc = require("../services/payment-service") as typeof import("../services/payment-service");
    const PAYMENT_ENV = ["PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY", "PAYMENTS_LIVE"];
    const prevPaymentEnv = Object.fromEntries(PAYMENT_ENV.map((k) => [k, process.env[k]]));
    const notified: string[] = [];
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => { notified.push(o.to); return { success: true, messageId: "stub" }; });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const failSubmits = (on: boolean) => db.exec(on
      ? `CREATE TRIGGER ia_submit_fails BEFORE UPDATE OF status ON carts WHEN NEW.status = 'submitted'
         BEGIN SELECT RAISE(ABORT, '${SUBMIT_DB_ERROR}'); END`
      : "DROP TRIGGER IF EXISTS ia_submit_fails");
    const buyer = { buyer_name: "Kari Kjøper", buyer_email: "kari.kjoper@example.no", buyer_phone: "98765432", contact_consent: true };
    const leaksDbError = (t: string) => /SQLITE|4711|Submit failed|disk I\/O/.test(t);

    /** The real handler chain lokal_cart_create → lokal_cart_add_item → lokal_cart_submit (submit failing in its transaction). */
    async function failedSubmitThroughHandlers(cartTools: Map<string, CapturedTool>, label: string): Promise<{ cart_id: string; buyer_ref: string }> {
      const cart = JSON.parse(textOf(await cartTools.get("lokal_cart_create")!.handler({})));
      const added = JSON.parse(textOf(await cartTools.get("lokal_cart_add_item")!.handler({ ...cart, product_id: CART_PRODUCT, qty: 2 })));
      assertTrue(cart.success === true && added.success === true, `AI-1 B1 ${label} setup: cart created and item added (got: ${JSON.stringify(added).slice(0, 200)})`);

      failSubmits(true);
      const before = errorLog.length;
      const r = await cartTools.get("lokal_cart_submit")!.handler({ ...cart, ...buyer });
      failSubmits(false);
      const t = textOf(r);
      assertEq(JSON.parse(t), { success: false, status: 500, error: MCP_INTERNAL_ERROR_TEXT },
        `AI-1 B1 ${label}: a failed submit transaction gives the generic message in the same JSON shape`);
      assertTrue(!leaksDbError(t) && r?.isError !== true,
        `AI-1 B1 ${label}: no DB error text in the tool result, and the result is not turned into an isError result`);
      const logged = errorLog.slice(before).join("\n");
      assertTrue(logged.includes("[mcp] lokal_cart_submit failed: status 500:") && logged.includes(`Submit failed: ${SUBMIT_DB_ERROR}`),
        `AI-1 B1 ${label}: the DB error is logged under the tool name`);
      assertTrue(![buyer.buyer_name, buyer.buyer_email, buyer.buyer_phone, cart.buyer_ref, cart.cart_id].some((v) => logged.includes(v)),
        `AI-1 B1 ${label}: the log line carries no arguments and no buyer data`);
      assertEq((db.prepare("SELECT status FROM carts WHERE id = ?").get(cart.cart_id) as any)?.status, "open",
        `AI-1 B1 ${label}: the failed transaction left the cart open`);
      return cart;
    }

    try {
      // ── PAYMENTS_ENABLED off: lokal_cart_submit → submitCart ──
      for (const k of PAYMENT_ENV) delete process.env[k];
      {
        const cart = await failedSubmitThroughHandlers(tools, "PAYMENTS_ENABLED=0");
        const submit = tools.get("lokal_cart_submit")!;

        const ok = JSON.parse(textOf(await submit.handler({ ...cart, ...buyer })));
        await settle();
        assertTrue(ok.success === true && ok.orders?.length === 1 && ok.orders[0].agent_id === CART_FARM && !("payments" in ok),
          `AI-1 B1 PAYMENTS_ENABLED=0: the same cart submits once the DB works, result unchanged (got: ${JSON.stringify(ok).slice(0, 200)})`);
        assertEq(notified, [`${CART_FARM}@example.no`], "AI-1 B1 PAYMENTS_ENABLED=0: the producer is notified of the order as before");

        assertEq(JSON.parse(textOf(await submit.handler({ ...cart, ...buyer }))),
          { success: false, status: 409, error: "Cart is already submitted" },
          "AI-1 B1 PAYMENTS_ENABLED=0: a 4xx message is returned as it is");
        const empty = JSON.parse(textOf(await tools.get("lokal_cart_create")!.handler({})));
        assertEq(JSON.parse(textOf(await submit.handler({ cart_id: empty.cart_id, buyer_ref: empty.buyer_ref }))),
          { success: false, status: 400, error: "Cart is empty" },
          "AI-1 B1 PAYMENTS_ENABLED=0: «Cart is empty» is returned as it is");
        assertEq(JSON.parse(textOf(await submit.handler({ cart_id: cart.cart_id, buyer_ref: "wrong-token" }))),
          { success: false, error: "Invalid buyer token" },
          "AI-1 B1 PAYMENTS_ENABLED=0: a token error is returned as it is");

        const status = tools.get("lokal_order_status")!;
        const order = JSON.parse(textOf(await status.handler({ order_id: ok.orders[0].order_id, buyer_ref: cart.buyer_ref })));
        assertTrue(order.success === true && order.status === "pending" && order.order_id === ok.orders[0].order_id,
          `AI-1 B1: lokal_order_status returns the order as before (a text status is not an error status) (got: ${JSON.stringify(order).slice(0, 200)})`);
        assertEq(JSON.parse(textOf(await status.handler({ order_id: ok.orders[0].order_id, buyer_ref: "wrong-token" }))),
          { success: false, status: 403, error: "Invalid buyer token" },
          "AI-1 B1: lokal_order_status keeps its 4xx message");
      }

      // ── PAYMENTS_ENABLED on: lokal_cart_submit → submitCartWithPayments (prepay path) ──
      process.env.PAYMENTS_ENABLED = "1";
      process.env.PAYMENTS_ALLOWED_AGENT_IDS = CART_FARM;
      db.prepare(`INSERT INTO payment_accounts (id, agent_id, livemode, stripe_account_id, charges_enabled, details_submitted)
        VALUES ('pa-ia-1', ?, 0, 'acct_ia_test', 1, 1)`).run(CART_FARM);
      paymentSvc.recordProducerTermsAcceptance(db, CART_FARM, "trader");
      const checkoutAccounts: string[] = [];
      paymentSvc.__setPaymentsStripeClientForTesting({
        checkout: {
          sessions: {
            async create(params: any, opts: any) {
              checkoutAccounts.push(opts.stripeAccount);
              return { id: "cs_test_ia", url: "https://checkout.stripe.test/cs_test_ia", expires_at: params.expires_at, status: "open", payment_intent: null, metadata: params.metadata };
            },
          },
        },
      } as unknown as PaymentsStripeClient);
      {
        const toolsOn = new Map<string, CapturedTool>();
        registerTools({ ...fakeServer, registerTool(name: string, config: any, handler: any) { toolsOn.set(name, { config, handler }); } },
          () => "test-client", () => undefined);
        assertTrue("pay_at_pickup" in (toolsOn.get("lokal_cart_submit")!.config.inputSchema ?? {}),
          "AI-1 B1 PAYMENTS_ENABLED=1 setup: the tools are registered in their prepayment variant");

        const cart = await failedSubmitThroughHandlers(toolsOn, "PAYMENTS_ENABLED=1");
        assertEq(checkoutAccounts, [], "AI-1 B1 PAYMENTS_ENABLED=1: no payment link was created for the failed submit");

        const ok = JSON.parse(textOf(await toolsOn.get("lokal_cart_submit")!.handler({ ...cart, ...buyer })));
        assertTrue(ok.success === true && ok.orders?.[0]?.payment_mode === "prepay" && ok.payments?.[0]?.checkout_url === "https://checkout.stripe.test/cs_test_ia",
          `AI-1 B1 PAYMENTS_ENABLED=1: the same cart submits through the prepayment path once the DB works, result unchanged (got: ${JSON.stringify(ok).slice(0, 300)})`);
        assertEq(JSON.parse(textOf(await toolsOn.get("lokal_cart_submit")!.handler({ ...cart, ...buyer }))),
          { success: false, status: 409, error: "Cart is already submitted" },
          "AI-1 B1 PAYMENTS_ENABLED=1: a 4xx message is returned as it is");
      }
    } finally {
      failSubmits(false);
      for (const k of PAYMENT_ENV) {
        if (prevPaymentEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevPaymentEnv[k];
      }
      paymentSvc.__setPaymentsStripeClientForTesting(null);
      notifySvc.__setOrderNotifySendForTesting(null);
      cartSvc.__setCartTestDb(null);
    }
  } finally {
    failInfoFor(null);
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
