/**
 * mcp-product-labels-and-order.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-N (round 2 of the
 * integration test: AI2-02, AI-3a, AI-3b, AI2-08). The RFB MCP says no more
 * about a producer's products than the data supports.
 *
 * AI2-02 (P2): lokal_info for Hevd Håndverksbakeri and Aarvik Gård listed the
 *   enrichment's category labels («Honning», «Kjøtt», «Egg» …) as products,
 *   each with a cart id and «availability: in_stock», while lokal_search
 *   called the same producer a category match. Such an entry is now listed
 *   under «Kategorier:» without id or availability; every other product line
 *   is byte-identical to main (goldens below).
 * AI-3a (P2): «egg i Bergen» marked nothing: «egg» is a category word the
 *   parser never makes a product term (PRODUCT_TERM_EXCLUSIONS), so a
 *   producer resting on the label «Egg» read like Bønes Gårdsmat with its
 *   «Ferske egg fra Fana». The query's category words are now labelled
 *   against too (matching unchanged), and the summary shows the product that
 *   made a listed match.
 * AI-3b (P3): «honning nær Trondheim» showed the explicit match third, behind
 *   two category matches. Explicit matches now come first, discover()'s order
 *   kept within each group.
 * AI2-08 (P3): «… Liamyrane 6<br />5132 Nyborg» reached MCP text; HTML tags
 *   in descriptions are now removed or become line breaks.
 * Slice I-S has since left the labels out of the «🛒 …» summary
 *   (rfb-kategorietiketter-ikke-tilbud.test.ts); the goldens below drop
 *   main's 🛒 lines of label-only producers for that.
 *
 * Same duck-typed-server harness as mcp-lokal-info-and-category-labels.test.ts
 * against the real production schema in an in-memory DB. The frozen MCP
 * contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runMcpProductLabelsAndOrderTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/mcp-product-labels-and-order.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
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

// Trondheim (63.4305, 10.3951): the live «honning nær Trondheim» case, by distance.
const HELIOS = "1b000000-0000-4000-8000-000000000001";
const HEVD = "1b000000-0000-4000-8000-000000000002";
const TIRSLAUG = "1b000000-0000-4000-8000-000000000003";
const MATPERLER = "1b000000-0000-4000-8000-000000000004";
// Bergen (60.3913, 5.3221): the live «egg i Bergen» case.
const REINDYRKA = "1b000000-0000-4000-8000-000000000011";
const STEND = "1b000000-0000-4000-8000-000000000012";
const BONES = "1b000000-0000-4000-8000-000000000013";
const BAKST = "1b000000-0000-4000-8000-000000000014";
const POTET = "1b000000-0000-4000-8000-000000000015";
const EGG_PRICED = "1b000000-0000-4000-8000-000000000016";
const HONEY_PRICED = "1b000000-0000-4000-8000-000000000017";
// Vestland, outside both searches: the live Aarvik case.
const AARVIK = "1b000000-0000-4000-8000-000000000021";

const label = (name: string, category: string) => ({ name, category, seasonal: false });
const HEVD_LABELS = [
  label("Kjøtt", "meat"), label("Meieri", "dairy"), label("Grønnsaker", "vegetables"), label("Bakervarer", "bakery"),
  label("Honning", "honey"), label("Egg", "eggs"), label("Fisk", "fish"), label("Urter", "herbs"),
];
const AARVIK_LABELS = [
  label("Kjøtt", "meat"), label("Meieri", "dairy"), label("Grønnsaker", "vegetables"), label("Bakervarer", "bakery"), label("Egg", "eggs"),
];
// Bønes: eleven products, the eggs seventh — beyond the five the summary shows.
const BONES_PRODUCTS = [
  { name: "Lammekjøtt", category: "meat" }, { name: "Lammepølser", category: "meat" }, { name: "Poteter", category: "vegetables" },
  { name: "Gulrøtter", category: "vegetables" }, { name: "Kålrot", category: "vegetables" }, { name: "Jordbær", category: "berries", seasonal: true },
  { name: "Ferske egg fra Fana", category: "eggs" }, { name: "Rabarbra", category: "vegetables" }, { name: "Plommer", category: "fruit" },
  { name: "Epler", category: "fruit" }, { name: "Syltetøy av solbær", category: "preserves" },
];
const BAKST_DESCRIPTION = "Bakeri og bryggeri i Åsane. Liamyrane 6<br />5132 Nyborg, Åsane.";

interface Seed {
  id: string;
  name: string;
  lat: number;
  lng: number;
  city: string;
  categories: string[];
  products: unknown[];
  description?: string;
  about?: string;
  /** name_norm → products.id: the catalog rows (in_stock) the backfill made from the products. */
  catalog?: Record<string, string>;
}

const SEED: Seed[] = [
  { id: HELIOS, name: "Helios Trondheim Fixture", lat: 63.4310, lng: 10.3960, city: "Trondheim", categories: ["honey", "vegetables"],
    products: [label("Grønnsaker", "vegetables"), label("Honning", "honey"), label("Frukt", "fruit")] },
  { id: HEVD, name: "Hevd Håndverksbakeri Fixture", lat: 63.4340, lng: 10.4000, city: "Trondheim", categories: ["bakery", "honey"],
    products: HEVD_LABELS,
    catalog: Object.fromEntries(HEVD_LABELS.map((p, i) => [p.name.toLowerCase(), `1b0000ca-0000-4000-8000-00000000000${i}`])) },
  { id: TIRSLAUG, name: "Tirslaugtrøa Bigård Fixture", lat: 63.4600, lng: 10.4600, city: "Trondheim", categories: ["honey"],
    products: [{ name: "Løvetannhonning", category: "honey" }, { name: "Lynghonning", category: "honey" }] },
  { id: MATPERLER, name: "Trondheims Matperler Fixture", lat: 63.4700, lng: 10.4900, city: "Trondheim", categories: ["honey", "meat"],
    products: [{ name: "Spekemat", category: "meat" }] },

  { id: REINDYRKA, name: "Reindyrka Fixture", lat: 60.3920, lng: 5.3230, city: "Bergen", categories: ["eggs", "meat", "vegetables"],
    products: [label("Kjøtt", "meat"), label("Grønnsaker", "vegetables"), label("Frukt", "fruit"), label("Bakervarer", "bakery"),
      label("Egg", "eggs"), label("Honning", "honey"), label("Fisk", "fish")] },
  { id: STEND, name: "Stend Gard Fixture", lat: 60.3950, lng: 5.3300, city: "Bergen", categories: ["eggs", "meat"],
    products: [label("Kjøtt", "meat"), label("Grønnsaker", "vegetables")] },
  { id: BONES, name: "Bønes Gårdsmat Fixture", lat: 60.4000, lng: 5.3400, city: "Bergen", categories: ["eggs", "meat", "vegetables"],
    products: BONES_PRODUCTS, catalog: { "ferske egg fra fana": "1b0000ca-0000-4000-8000-0000000000b1", "lammekjøtt": "1b0000ca-0000-4000-8000-0000000000b2" } },
  { id: BAKST, name: "Bakst og Brygghuset Fixture", lat: 60.4100, lng: 5.3500, city: "Bergen", categories: ["eggs", "bakery"],
    products: [label("Bakervarer", "bakery"), label("Egg", "eggs")], description: BAKST_DESCRIPTION, about: BAKST_DESCRIPTION },
  { id: POTET, name: "Fana Potetgard Fixture", lat: 60.4200, lng: 5.3600, city: "Bergen", categories: ["eggs", "vegetables"],
    products: [{ name: "Poteter" }, { name: "Gulrøtter" }] },
  { id: EGG_PRICED, name: "Hordaland Eggsalg Fixture", lat: 60.4300, lng: 5.3700, city: "Bergen", categories: ["eggs"],
    products: [{ name: "Egg", category: "eggs", price: "60 kr/brett" }], catalog: { "egg": "1b0000ca-0000-4000-8000-0000000000e1" } },
  // No eggs category: only «honning i Bergen» finds it.
  { id: HONEY_PRICED, name: "Sandviken Birøkt Fixture", lat: 60.4400, lng: 5.3800, city: "Bergen", categories: ["honey"],
    products: [{ name: "Honning", category: "honey", price: "150 kr/glass" }] },

  { id: AARVIK, name: "Aarvik Gård Fixture", lat: 61.2000, lng: 6.9000, city: "Vestland", categories: ["meat", "dairy", "bakery", "eggs"],
    products: AARVIK_LABELS,
    catalog: Object.fromEntries(AARVIK_LABELS.map((p, i) => [p.name.toLowerCase(), `1b0000ca-0000-4000-8000-0000000000a${i}`])) },
];

/** The fixtures above in `db`; exported so the goldens below can be captured from main's mcp.ts with the same data. */
export function seedProductLabelFixtures(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            ?, ?, ?, ?, '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  const knowledgeStmt = db.prepare("INSERT INTO agent_knowledge (agent_id, address, phone, email, products, about) VALUES (?, ?, '91234567', ?, ?, ?)");
  const catalogStmt = db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, availability) VALUES (?, ?, ?, ?, 'in_stock')`);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, s.description ?? `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`,
      `key-${s.id}`, s.lat, s.lng, s.city, JSON.stringify(s.categories));
    knowledgeStmt.run(s.id, `${s.city}veien 1`, `${s.id}@example.no`, JSON.stringify(s.products), s.about ?? null);
    for (const [norm, id] of Object.entries(s.catalog ?? {})) catalogStmt.run(id, s.id, norm, norm);
  }
}

// ── Goldens: main (eb94b47f) output for well-formed data ──────────────────────
// formatProductsForMcp on main for lists without a category label.
const GOLDEN_REAL_PRODUCTS = [
  { name: "🐑 LAM", category: "meat", price: "Bestilles på forhånd" },
  { name: "Lammelår", category: "meat", price: "275/kg" },
  { name: "Fenalår – kr 450", category: "meat" },
  { name: "Surdeigsbrød", category: "bakery", seasonal: true, price: 89 },
  { name: "❌ Tomt for pølser" },
  { name: "Ferske egg fra Fana", category: "eggs" },
  { name: "Rabarbra", category: "other", seasonal: true },
];
const GOLDEN_IDS = new Map([["lammelår", "p-1"], ["surdeigsbrød", "p-2"], ["egg", "p-3"]]);
const GOLDEN_AVAIL = new Map<string, { availability: string; availabilityUpdatedAt: string | null }>([
  ["lammelår", { availability: "in_stock", availabilityUpdatedAt: null }],
  ["surdeigsbrød", { availability: "unknown", availabilityUpdatedAt: "2026-10-01 10:00:00" }],
  ["egg", { availability: "in_stock", availabilityUpdatedAt: null }],
]);
const GOLDEN_REAL =
  "\n## Produkter (5 stk)\n\n**Bestilles på forhånd**\n_Bestilles på forhånd_\n- Lammelår [meat] — 275/kg  · id: p-1  · availability: in_stock\n" +
  "- Fenalår [meat] — kr 450\n- Surdeigsbrød [bakery] — 89 🌿sesong  · id: p-2  · availability: unknown  · availability_updated_at: 2026-10-01 10:00:00\n" +
  "- Ferske egg fra Fana [eggs]\n- Rabarbra 🌿sesong";
const GOLDEN_REAL_NO_MAPS =
  "\n## Produkter (5 stk)\n\n**Bestilles på forhånd**\n_Bestilles på forhånd_\n- Lammelår [meat] — 275/kg\n- Fenalår [meat] — kr 450\n" +
  "- Surdeigsbrød [bakery] — 89 🌿sesong\n- Ferske egg fra Fana [eggs]\n- Rabarbra 🌿sesong";
const GOLDEN_PRICED_LABEL =
  "\n## Produkter (2 stk)\n- Egg [eggs] — 60 kr/brett  · id: p-3  · availability: in_stock\n- Lynghonning [honey]";
// The whole tool texts main gives for these fixtures, captured by running
// main's src/routes/mcp.ts on seedProductLabelFixtures.
const MAIN_TEXTS_FIXTURE = path.join(__dirname, "../../tests/fixtures/rfb-mcp-product-labels-main.json");
interface MainTexts {
  infoTirslaug: string;
  infoBones: string;
  discoverHoney: string;
  nearTrondheim: string;
  honning: string;
  egg: string;
}

// Slice I-S (F5): the «🛒 …» lines main gives the producers with only category
// labels; the summary shows no labels now, so these producers have none.
const MAIN_LABEL_ONLY_SUMMARIES = [
  "   🛒 Grønnsaker, Honning, Frukt\n", "   🛒 Kjøtt, Meieri, Grønnsaker, Bakervarer, Honning +3 flere\n",
  "   🛒 Kjøtt, Grønnsaker, Frukt, Bakervarer, Egg +2 flere\n", "   🛒 Kjøtt, Grønnsaker\n", "   🛒 Bakervarer, Egg\n",
];
/** Main's text without the 🛒 lines of producers with only category labels (I-S). */
function withoutLabelOnlySummaries(text: string): string {
  return MAIN_LABEL_ONLY_SUMMARIES.reduce((t, line) => t.split(line).join(""), text);
}

/** The result blocks of a search text by producer name, without their number («**3. Navn**» → «**Navn**»). */
function resultBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const part of text.split(/\n\n(?=\*\*\d+\. )/).slice(1)) {
    const block = part.replace(/^\*\*\d+\. /, "**");
    blocks.set(block.slice(2).split(/\*\*| — /)[0], block);
  }
  return blocks;
}

export async function runMcpProductLabelsAndOrderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  seedProductLabelFixtures(db);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404,
    json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const prevBaseUrl = process.env.BASE_URL;
  delete process.env.BASE_URL;

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    const mcp = require("./mcp") as typeof import("./mcp");
    const { registerTools, formatProductsForMcp, isCategoryLabelProduct, isGenericCategoryName, categoryLabelWordsOf,
      categoryWordEvidence, mcpProse, documentsListedProduct, enrichParsedWithGeo, MCP_CATEGORY_LABELS_NOTE } = mcp;
    const { normalizeProse } = require("../services/description-quality") as typeof import("../services/description-quality");

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
    const discoverTool = tools.get("lokal_discover")!;
    const headingsOf = (t: string) => [...t.matchAll(/^\*\*(\d+)\. (.+?)\*\*$/gm)].map((m) => ({ n: Number(m[1]), heading: m[2] }));
    const nameOf = (heading: string) => heading.split(" — ")[0];
    /** The compact result block of one producer: its heading line up to the next result. */
    const blockOf = (t: string, name: string) => {
      const start = t.search(new RegExp(`^\\*\\*\\d+\\. ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
      if (start < 0) return "";
      const next = t.slice(start + 1).search(/^\*\*\d+\. /m);
      return next < 0 ? t.slice(start) : t.slice(start, start + 1 + next);
    };
    /** discover()'s own order for a query, as lokal_search runs it. */
    const discoverOrder = async (query: string, limit = 10) => {
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      await enrichParsedWithGeo(parsed, query);
      return marketplaceRegistry.discover({ ...parsed, limit, offset: 0 }, {}, { trackDiscovery: false }).map((x) => x.agent.name);
    };

    // ══════════════════════════════════════════════════════════════
    // AI2-02 — the category label rule
    // ══════════════════════════════════════════════════════════════
    assertEq(
      [label("Honning", "honey"), { name: " egg " }, { name: "BAKERVARER", category: "bakery" }, { name: "Kjøtt", price: "på forespørsel" },
        { name: "Urter", price: { amount: 50 } }, { name: "Drikke", price: 0 }, { name: "Bakeri" }].map(isCategoryLabelProduct),
      [true, true, true, true, true, true, true],
      "AI2-02 isCategoryLabelProduct: a category name (any case, any spacing) with no numeric price is a label");
    assertEq(
      [{ name: "Egg", category: "eggs", price: "60 kr/brett" }, { name: "Honning", price: 150 }, { name: "Løvetannhonning" },
        { name: "Honning – kr 150" }, { name: "Frittgående egg" }, { name: "Surdeigsbrød" }, "Honning", null, 7, { name: 5 }, {}]
        .map(isCategoryLabelProduct),
      [false, false, false, false, false, false, false, false, false, false, false],
      "AI2-02 isCategoryLabelProduct: a priced category name, a real product, and an entry without a text name are no label");
    assertEq(["Honning", "egg", "Kjøtt", "Syltetøy", "Annet", "Lynghonning", "", "  "].map(isGenericCategoryName),
      [true, true, true, true, true, false, false, false],
      "AI2-02 isGenericCategoryName: I-A's rule per name");
    assertEq([["Egg"], ["Ferske egg fra Fana"]].map((n) => documentsListedProduct(n)), [false, true],
      "AI2-02 documentsListedProduct: unchanged for a name list");

    // ══════════════════════════════════════════════════════════════
    // AI2-02 — formatProductsForMcp: labels as categories, products byte-like
    // ══════════════════════════════════════════════════════════════
    assertEq(formatProductsForMcp(GOLDEN_REAL_PRODUCTS, GOLDEN_IDS, GOLDEN_AVAIL), GOLDEN_REAL,
      "AI2-02 byte-like: a product list without a category label renders as on main (ids, availability, headers, noise, prices)");
    assertEq(formatProductsForMcp(GOLDEN_REAL_PRODUCTS), GOLDEN_REAL_NO_MAPS,
      "AI2-02 byte-like: …and without catalog maps");
    assertEq(formatProductsForMcp([{ name: "Egg", category: "eggs", price: "60 kr/brett" }, { name: "Lynghonning", category: "honey" }], GOLDEN_IDS, GOLDEN_AVAIL),
      GOLDEN_PRICED_LABEL, "AI2-02 byte-like: a priced category name stays a product with its id and availability");
    {
      const ids = new Map(HEVD_LABELS.map((p, i) => [p.name.toLowerCase(), `id-${i}`]));
      const avail = new Map(HEVD_LABELS.map((p) => [p.name.toLowerCase(), { availability: "in_stock", availabilityUpdatedAt: null }]));
      const t = formatProductsForMcp(HEVD_LABELS, ids, avail);
      assertEq(t, `\n**Kategorier:** Kjøtt, Meieri, Grønnsaker, Bakervarer, Honning, Egg, Fisk, Urter\n${MCP_CATEGORY_LABELS_NOTE}`,
        "AI2-02: a list of only category labels is one «Kategorier:» line with the note, no product section");
      assertTrue(!/id-\d|in_stock|availability/.test(t), "AI2-02: the labels get neither a catalog id nor an availability");
    }
    {
      const t = formatProductsForMcp([...GOLDEN_REAL_PRODUCTS, label("Honning", "honey"), { name: "honning " }, { name: " Honning" }, label("Egg", "eggs")],
        GOLDEN_IDS, GOLDEN_AVAIL);
      assertEq(t, `${GOLDEN_REAL}\n\n**Kategorier:** Honning, Egg\n${MCP_CATEGORY_LABELS_NOTE}`,
        "AI2-02: a mixed list keeps every product line and count as on main, then a blank line and the labels once each (first spelling)");
    }
    assertEq(formatProductsForMcp([{ name: "📋 STYKNINGSDELER" }, label("Kjøtt", "meat")]),
      `\n**Kategorier:** Kjøtt\n${MCP_CATEGORY_LABELS_NOTE}`,
      "AI2-02: a section header with only labels under it gives no empty product section (as before for a header alone)");
    assertTrue(MCP_CATEGORY_LABELS_NOTE.includes("kategorinavn") && MCP_CATEGORY_LABELS_NOTE.includes("category names"),
      "AI2-02: the note is Norwegian and English");

    // ══════════════════════════════════════════════════════════════
    // AI2-02 — lokal_info for Hevd and Aarvik (acceptance criterion)
    // ══════════════════════════════════════════════════════════════
    for (const [id, name, labels] of [[HEVD, "Hevd Håndverksbakeri Fixture", HEVD_LABELS], [AARVIK, "Aarvik Gård Fixture", AARVIK_LABELS]] as const) {
      const r = await info.handler({ agentId: id });
      const t = textOf(r);
      assertTrue(r?.isError !== true && t.startsWith(`# ${name}`), `AI2-02 ${name}: lokal_info returns the profile`);
      assertTrue(t.includes(`\n\n**Kategorier:** ${labels.map((p) => p.name).join(", ")}\n${MCP_CATEGORY_LABELS_NOTE}`),
        `AI2-02 ${name}: the labels are shown as categories (got: ${(t.match(/\*\*Kategorier:\*\*.*/) || [""])[0]})`);
      assertTrue(!t.includes("## Produkter") && !t.includes("in_stock") && !t.includes("availability") && !t.includes("· id:"),
        `AI2-02 ${name}: no product section, no in_stock and no cart id`);
    }
    {
      const t = textOf(await info.handler({ agentId: BONES }));
      assertTrue(t.includes("- Ferske egg fra Fana [eggs]  · id: 1b0000ca-0000-4000-8000-0000000000b1  · availability: in_stock")
        && t.includes("- Lammekjøtt [meat]  · id: 1b0000ca-0000-4000-8000-0000000000b2  · availability: in_stock")
        && t.includes("## Produkter (11 stk)") && !t.includes("Kategorier"),
        "AI2-02: a producer with real products keeps every product line with its cart id and availability, and no category line");
      const priced = textOf(await info.handler({ agentId: EGG_PRICED }));
      assertTrue(priced.includes("## Produkter (1 stk)\n- Egg [eggs] — 60 kr/brett  · id: 1b0000ca-0000-4000-8000-0000000000e1  · availability: in_stock"),
        "AI2-02: a priced «Egg» keeps its product line, cart id and availability");
    }

    // ══════════════════════════════════════════════════════════════
    // Byte-like with main for well-formed data (whole tool texts)
    // ══════════════════════════════════════════════════════════════
    const main = JSON.parse(fs.readFileSync(MAIN_TEXTS_FIXTURE, "utf8")) as MainTexts;
    assertEq(textOf(await info.handler({ agentId: TIRSLAUG })), main.infoTirslaug,
      "byte-like: lokal_info for a producer without labels or HTML is main's text");
    assertEq(textOf(await info.handler({ agentId: BONES })), main.infoBones,
      "byte-like: lokal_info for a producer with eleven real products and catalog ids is main's text");
    assertEq(textOf(await discoverTool.handler({ categories: ["honey"], lat: 63.4305, lng: 10.3951, limit: 10 })), withoutLabelOnlySummaries(main.discoverHoney),
      "byte-like: lokal_discover (no search terms) is main's text, without the 🛒 lines of label-only producers (I-S)");
    assertEq(textOf(await search.handler({ query: "", lat: 63.4305, lng: 10.3951, radius_km: 20, limit: 10 })), withoutLabelOnlySummaries(main.nearTrondheim),
      "byte-like: a lokal_search without product terms or category words is main's text, without the 🛒 lines of label-only producers (I-S)");
    {
      // The two searches I-N changes: every result block is main's, apart from
      // the order and what I-N adds (labels, the summary of a listed match).
      const honning = resultBlocks(textOf(await search.handler({ query: "honning nær Trondheim", limit: 5 })));
      const mainHonning = resultBlocks(main.honning);
      assertEq([...honning.keys()].sort(), [...mainHonning.keys()].sort(), "byte-like: «honning nær Trondheim» has main's producers");
      assertTrue([...mainHonning].every(([name, block]) => honning.get(name) === withoutLabelOnlySummaries(block)),
        "byte-like: «honning nær Trondheim» has main's result blocks (I-A labels included), only reordered, without label-only 🛒 lines (I-S)");
      const egg = resultBlocks(textOf(await search.handler({ query: "egg i Bergen", limit: 10 })));
      const mainEgg = resultBlocks(main.egg);
      assertEq([...egg.keys()].sort(), [...mainEgg.keys()].sort(), "byte-like: «egg i Bergen» has main's producers");
      assertEq(["Fana Potetgard Fixture", "Hordaland Eggsalg Fixture"].map((n) => egg.get(n) === mainEgg.get(n)), [true, true],
        "byte-like: in «egg i Bergen» an explicit match whose summary already shows its match is main's block");
      assertEq(egg.get("Bønes Gårdsmat Fixture"), mainEgg.get("Bønes Gårdsmat Fixture")!.replace(
        "🛒 Lammekjøtt, Lammepølser, Poteter, Gulrøtter, Kålrot +6 flere", "🛒 Ferske egg fra Fana, Lammekjøtt, Lammepølser, Poteter, Gulrøtter +6 flere"),
        "byte-like: Bønes' block is main's apart from the summary that now shows its eggs");
    }

    // ══════════════════════════════════════════════════════════════
    // AI-3a — category words of a search
    // ══════════════════════════════════════════════════════════════
    assertEq(categoryLabelWordsOf("egg i Bergen", ["eggs"]), ["egg"], "AI-3a categoryLabelWordsOf: «egg» in «egg i Bergen»");
    assertEq(categoryLabelWordsOf("Egg og KJØTT, fisk! egg", ["eggs", "meat", "fish"]), ["egg", "kjøtt", "fisk"],
      "AI-3a categoryLabelWordsOf: any case, punctuation, once each, in query order");
    assertEq([categoryLabelWordsOf("eggs near Bergen", ["eggs"]), categoryLabelWordsOf("meat", ["meat"]), categoryLabelWordsOf("fish and vegetables", ["fish", "vegetables"])],
      [["egg"], ["kjøtt"], ["fisk", "grønnsaker"]],
      "AI-3a categoryLabelWordsOf: an English word is read as the parser's Norwegian term (product-glossary)");
    assertEq(categoryLabelWordsOf("brød og bakervarer i Oslo", ["bread"]), ["brød", "bakervarer"], "AI-3a categoryLabelWordsOf: «brød» and «bakervarer» are bread");
    assertEq(
      [categoryLabelWordsOf("eggerøre i Bergen", ["eggs"]), categoryLabelWordsOf("honning nær Trondheim", ["honey"]),
        categoryLabelWordsOf("egg i Bergen", ["meat"]), categoryLabelWordsOf("egg i Bergen", undefined),
        categoryLabelWordsOf("øl og drikke i Bergen", ["beverages"]), categoryLabelWordsOf("constructor __proto__ toString", ["eggs"])],
      [[], [], [], [], [], []],
      "AI-3a categoryLabelWordsOf: no word inside another word, none for a product term or a drink word, none without its category, no inherited key");

    {
      const egg = ["egg"];
      assertEq([
        categoryWordEvidence([{ name: "Ferske egg fra Fana" }], egg),
        categoryWordEvidence([label("Kjøtt", "meat"), { name: "Frittgående høner", category: "eggs" }], egg),
        categoryWordEvidence([{ name: "Egg", category: "eggs", price: "60 kr/brett" }], egg),
        categoryWordEvidence([{ name: "Lammelår", category: "meat" }], ["kjøtt"]),
        categoryWordEvidence([{ name: "Croissant", category: "bakery" }], ["brød"]),
      ], ["listed", "listed", "listed", "listed", "listed"],
      "AI-3a categoryWordEvidence: a real product of the word (by name or own category; a priced category name) is a listed match");
      assertEq([
        categoryWordEvidence([label("Kjøtt", "meat"), label("Egg", "eggs")], egg),
        categoryWordEvidence([{ name: "egg" }, { name: "Lammekjøtt", category: "meat" }], egg),
        categoryWordEvidence([label("Bakervarer", "bakery")], ["brød"]),
      ], ["label", "label", "label"],
      "AI-3a categoryWordEvidence: only a category label belongs to the word");
      assertEq([
        categoryWordEvidence([label("Kjøtt", "meat"), label("Grønnsaker", "vegetables")], egg),
        categoryWordEvidence([{ name: "Lammekjøtt", category: "meat" }, { name: "Plommer", category: "fruit" }], egg),
        categoryWordEvidence([], egg),
      ], ["none", "none", "none"],
      "AI-3a categoryWordEvidence: nothing belongs to the word, and every product has a category of its own (or there is none)");
      assertEq([
        categoryWordEvidence([{ name: "Poteter" }], ["grønnsaker"]),
        categoryWordEvidence([{ name: "Kasse", category: "other" }, label("Kjøtt", "meat")], egg),
        categoryWordEvidence([{ name: "Kasse", category: 7 }], egg),
        categoryWordEvidence(undefined, egg),
      ], [null, null, null, null],
      "AI-3a categoryWordEvidence: unknown when a product has no category of its own, or the list could not be read");
    }

    // ══════════════════════════════════════════════════════════════
    // AI-3a/AI-3b — «egg i Bergen» (acceptance criterion)
    // ══════════════════════════════════════════════════════════════
    {
      const query = "egg i Bergen";
      const t = textOf(await search.handler({ query, limit: 10 }));
      const headings = headingsOf(t);
      const headingOf = (name: string) => headings.find((h) => nameOf(h.heading) === name)?.heading ?? "";
      assertTrue(headings.length === 6, `AI-3a: «${query}» finds the six Bergen fixtures (got ${headings.length}: ${t.slice(0, 200)})`);

      const LABEL = " — Kategoritreff / category-only: «egg» bare som kategorinavn / category name only";
      const NOT_LISTED = " — Kategoritreff / category-only: «egg» ikke oppført / not listed";
      assertEq([headingOf("Reindyrka Fixture"), headingOf("Bakst og Brygghuset Fixture")],
        [`Reindyrka Fixture${LABEL}`, `Bakst og Brygghuset Fixture${LABEL}`],
        "AI-3a: producers resting on the label «Egg» are category matches, although «egg» is a category word");
      assertTrue(blockOf(t, "Reindyrka Fixture").includes("⚠️ Kategoritreff: produktlista har «egg» bare som kategorinavn, ikke som et bestemt produkt — spør produsenten. / Category match only: the product list has «egg» only as a category name, not as a specific product; ask the producer."),
        "AI-3a: …with the existing note");
      assertEq(headingOf("Stend Gard Fixture"), `Stend Gard Fixture${NOT_LISTED}`,
        "AI-3a: a producer whose products (all with a category) do not include eggs is «ikke oppført»");
      assertEq([headingOf("Bønes Gårdsmat Fixture"), headingOf("Hordaland Eggsalg Fixture"), headingOf("Fana Potetgard Fixture")],
        ["Bønes Gårdsmat Fixture", "Hordaland Eggsalg Fixture", "Fana Potetgard Fixture"],
        "AI-3a: Bønes (real eggs) and a priced «Egg» are explicit, and products without a category of their own give no label");
      assertTrue(blockOf(t, "Bønes Gårdsmat Fixture").includes("Beskrivelse av Bønes Gårdsmat Fixture"),
        "AI-3a: the explicit match keeps its description");

      // The summary shows the product that made the match.
      assertTrue(blockOf(t, "Bønes Gårdsmat Fixture").includes("   🛒 Ferske egg fra Fana, Lammekjøtt, Lammepølser, Poteter, Gulrøtter +6 flere\n"),
        `AI-3a: Bønes' eggs (7th product) lead its summary (got: ${(blockOf(t, "Bønes Gårdsmat Fixture").match(/🛒.*/) || [""])[0]})`);
      assertTrue(blockOf(t, "Hordaland Eggsalg Fixture").includes("   🛒 Egg (60 kr/brett)\n"),
        "AI-3a: a summary whose match is already shown is unchanged");
      assertTrue(!blockOf(t, "Reindyrka Fixture").includes("🛒") && blockOf(t, "Reindyrka Fixture").includes("_Bruk lokal_info med agentId"),
        "AI-3a/I-S: a category match with only labels has no 🛒 line (I-S, F5), and keeps its lokal_info pointer");

      // AI-3b: explicit first, discover()'s order within each group.
      const order = await discoverOrder(query);
      const explicit = new Set(["Bønes Gårdsmat Fixture", "Hordaland Eggsalg Fixture", "Fana Potetgard Fixture"]);
      assertEq(headings.map((h) => nameOf(h.heading)), [...order.filter((n) => explicit.has(n)), ...order.filter((n) => !explicit.has(n))],
        "AI-3b: explicit matches come first, then the category matches, each group in discover()'s order");
      assertTrue(order.indexOf("Reindyrka Fixture") < order.indexOf("Bønes Gårdsmat Fixture"),
        "AI-3b setup: discover() ranks a category match before Bønes (the repro)");
      assertEq(headings.map((h) => h.n), [1, 2, 3, 4, 5, 6], "AI-3b: the results are numbered 1..n in the new order");
    }
    {
      // The English word, and two category words at once.
      const en = textOf(await search.handler({ query: "eggs near Bergen", limit: 10 }));
      assertTrue(headingsOf(en).some((h) => h.heading === "Reindyrka Fixture — Kategoritreff / category-only: «egg» bare som kategorinavn / category name only"),
        `AI-3a: «eggs near Bergen» labels the same category match (got: ${headingsOf(en).map((h) => h.heading).join(" | ")})`);
      assertTrue(headingsOf(en).some((h) => h.heading === "Bønes Gårdsmat Fixture"),
        "AI-3a: «eggs near Bergen» keeps Bønes explicit (its eggs have the category eggs)");
      const two = textOf(await search.handler({ query: "kjøtt og egg i Bergen", limit: 10 }));
      assertTrue(headingsOf(two).some((h) => h.heading === "Stend Gard Fixture — Kategoritreff / category-only: «kjøtt/egg» bare som kategorinavn / category name only"),
        "AI-3a: with two category words a label for either («Kjøtt») is a category-name match, named with both words");
      assertTrue(headingsOf(two).some((h) => h.heading === "Bønes Gårdsmat Fixture"), "AI-3a: …and a real product for either is explicit");
      // A product term is the more specific evidence: I-A's rule alone, no category word added.
      const term = textOf(await search.handler({ query: "frittgående egg i Bergen", limit: 10 }));
      // I-A's product-term path: a matched «Honning» with a price is a listed product, as lokal_info shows it.
      const honey = textOf(await search.handler({ query: "honning i Bergen", limit: 10 }));
      assertEq(headingsOf(honey).map((h) => h.heading), ["Sandviken Birøkt Fixture"],
        "AI2-02/AI-3: «honning i Bergen» treats a matched «Honning» with a price as an explicit match (I-A would call it a category name)");
      assertTrue(headingsOf(term).length > 0 && headingsOf(term).every((h) => !h.heading.includes("«frittgående/egg»"))
        && headingsOf(term).some((h) => h.heading === "Reindyrka Fixture — Kategoritreff / category-only: «frittgående» ikke oppført / not listed"),
        `AI-3a: with a product term («frittgående») the category word is not labelled against (got: ${headingsOf(term).map((h) => h.heading).join(" | ")})`);
    }

    // ══════════════════════════════════════════════════════════════
    // AI-3b — «honning nær Trondheim» (acceptance criterion)
    // ══════════════════════════════════════════════════════════════
    {
      const query = "honning nær Trondheim";
      const t = textOf(await search.handler({ query, limit: 5 }));
      const headings = headingsOf(t);
      assertEq(headings.map((h) => h.heading), [
        "Tirslaugtrøa Bigård Fixture",
        "Helios Trondheim Fixture — Kategoritreff / category-only: «honning» bare som kategorinavn / category name only",
        "Hevd Håndverksbakeri Fixture — Kategoritreff / category-only: «honning» bare som kategorinavn / category name only",
        "Trondheims Matperler Fixture — Kategoritreff / category-only: «honning» ikke oppført / not listed",
      ], "AI-3b: Tirslaugtrøa comes first; the category matches follow in discover()'s order with I-A's labels");
      assertEq(await discoverOrder(query, 5),
        ["Helios Trondheim Fixture", "Hevd Håndverksbakeri Fixture", "Tirslaugtrøa Bigård Fixture", "Trondheims Matperler Fixture"],
        "AI-3b setup: discover() ranks the two labels before the beekeeper, as live (discover() unchanged)");
      assertTrue(blockOf(t, "Tirslaugtrøa Bigård Fixture").includes("   🛒 Løvetannhonning, Lynghonning\n"),
        "AI-3b: the explicit match's summary is unchanged");
    }
    {
      // No product term and no category word: nothing is labelled, discover()'s order stays.
      const t = textOf(await search.handler({ query: "", lat: 60.3913, lng: 5.3221, radius_km: 20, limit: 10 }));
      const parsed: any = { location: { lat: 60.3913, lng: 5.3221 }, maxDistanceKm: 20 };
      const order = marketplaceRegistry.discover({ ...parsed, limit: 10, offset: 0 }, {}, { trackDiscovery: false }).map((x) => x.agent.name);
      assertEq(headingsOf(t).map((h) => h.heading), order,
        "AI-3b: a search without product terms or category words keeps discover()'s order and labels nothing");
    }
    {
      // lokal_discover has no search terms: unchanged, no label.
      const t = textOf(await discoverTool.handler({ categories: ["honey"], lat: 63.4305, lng: 10.3951, limit: 10 }));
      assertTrue(headingsOf(t).length === 4 && !t.includes("Kategoritreff"), "AI-3b: lokal_discover labels nothing");
    }

    // ══════════════════════════════════════════════════════════════
    // AI2-08 — HTML in descriptions
    // ══════════════════════════════════════════════════════════════
    assertEq(mcpProse(BAKST_DESCRIPTION), "Bakeri og bryggeri i Åsane. Liamyrane 6\n5132 Nyborg, Åsane.",
      "AI2-08 mcpProse: the repro's <br /> becomes a line break");
    assertEq(mcpProse(BAKST_DESCRIPTION, "\n   "), "Bakeri og bryggeri i Åsane. Liamyrane 6\n   5132 Nyborg, Åsane.",
      "AI2-08 mcpProse: …or the given break (the compact view's indent)");
    assertEq([
      mcpProse("<p>Vi er en gård.</p><p>Vi selger egg.</p>"),
      mcpProse("<b>Ost</b> og <i>smør</i> fra <a href=\"https://x.no\">gården</a>"),
      mcpProse("Linje 1<BR>Linje 2<br/>  <br>Linje 3"),
      mcpProse("Åpent &lt;br /&gt; hver lørdag"),
      mcpProse("<div>Torg</div>\n<ul><li>Egg</li><li>Ost</li></ul>"),
      mcpProse("<img src=x onerror=alert(1)>Honning"),
    ], ["Vi er en gård.\nVi selger egg.", "Ost og smør fra gården", "Linje 1\nLinje 2\nLinje 3", "Åpent\nhver lørdag", "Torg\nEgg\nOst", "Honning"],
    "AI2-08 mcpProse: paragraphs and list items become lines, inline tags go, an encoded tag goes too, empty lines are dropped");
    {
      // Slice I-V: «x <y» at the very end is a cut-off tag now (rfb-offers-priser-ordgrense-avstand.test.ts); inside the text it stays.
      const corpus = ["", "Gårdsbutikk med egg & ost.", "a < b og 3 > 2", "<3 honning", "Pris: 50 < 60 kr", "Multi\nlinje\n\ntekst",
        "  innrykk  ", "you&#039;ll find", "Bær &amp; Co", "e-post: post@gard.no, https://gard.no/?a=1&b=2", "x <y og 1 < 2", "5 <= 6"];
      assertEq(corpus.map((s) => mcpProse(s)), corpus.map((s) => normalizeProse(s)),
        "AI2-08 byte-like: text without a tag is exactly normalizeProse's (entities, «<» in text, newlines)");
      assertEq([mcpProse(null), mcpProse(undefined)], ["", ""], "AI2-08 mcpProse: no text gives empty text");
      const t0 = Date.now();
      mcpProse("<a " + "x ".repeat(200_000) + "<br" + " ".repeat(100_000) + "</p".repeat(50_000));
      assertTrue(Date.now() - t0 < 500, `AI2-08 mcpProse: linear on unclosed tags (${Date.now() - t0} ms)`);
    }
    {
      const infoText = textOf(await info.handler({ agentId: BAKST }));
      assertTrue(!infoText.includes("<br") && infoText.includes("\n\nBakeri og bryggeri i Åsane. Liamyrane 6\n5132 Nyborg, Åsane.\n"),
        "AI2-08: lokal_info for Bakst & Brygghuset has no <br /> and keeps the line break");
      const discovered = textOf(await discoverTool.handler({ categories: ["eggs"], lat: 60.3913, lng: 5.3221, limit: 10 }));
      assertTrue(!discovered.includes("<br") && blockOf(discovered, "Bakst og Brygghuset Fixture").includes("\n   Bakeri og bryggeri i Åsane. Liamyrane 6\n   5132 Nyborg, Åsane.\n"),
        "AI2-08: the compact view (lokal_discover) has no <br /> and indents the second line");
      const named = textOf(await search.handler({ query: "Bakst og Brygghuset Fixture", limit: 10 }));
      assertTrue(named.includes("**1. Bakst og Brygghuset Fixture**") && !named.includes("<br"),
        `AI2-08: lokal_search's view of the producer has no <br /> (got: ${named.slice(0, 160)})`);
      const egg = textOf(await search.handler({ query: "egg i Bergen", limit: 10 }));
      assertTrue(!egg.includes("<br"), "AI2-08: «egg i Bergen» has no <br />");
    }
  } finally {
    console.log = prevLog;
    if (prevBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = prevBaseUrl;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    marketplaceRegistry._agentsCache = null;
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runMcpProductLabelsAndOrderTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
