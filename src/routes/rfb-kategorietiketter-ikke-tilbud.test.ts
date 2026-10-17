/**
 * rfb-kategorietiketter-ikke-tilbud.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-S (FUNN
 * rfb-mcp-oppfolging-etter-i-n, from the I-N review on lokal#1126): a
 * generic category label is no offer on any surface.
 *
 * - Offers: findOffers offered a catalog row whose name is a category label
 *   («Honning» at a bakery: category inference wrote it, product-catalog-sync
 *   copied it into `products` as in_stock) and that has no price_nok, with a
 *   product_id, on lokal_find_offers, GET /api/marketplace/catalog/offers and
 *   the shopping list page. Such a row is now left out, before the limit.
 * - Provenance (F2): a row the producer set (availability_source
 *   'producer_dashboard') is always a product: in the offers, and in
 *   lokal_info, where it keeps its id and availability.
 * - Summary (F5): the «🛒 …» line of lokal_search and lokal_discover shows no
 *   category labels; a producer with only labels has no 🛒 line, and keeps
 *   its lokal_info pointer and I-N's category-match label.
 * - Empty description (F1): a description that is only tags gives no empty line.
 * The rule is one function, utils/category-label.ts.
 *
 * Harnesses as in mcp-product-labels-and-order.test.ts (duck-typed server)
 * and marketplace-catalog-offers.test.ts (router called directly), against
 * the production schema in an in-memory DB (restored in finally). The frozen
 * MCP contract is pinned in rfb-mcp-contract-freeze.test.ts.
 *
 * Exported runRfbKategorietiketterIkkeTilbudTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-kategorietiketter-ikke-tilbud.test.ts
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

const T = { lat: 63.4305, lng: 10.3951 }; // Trondheim (geocoding-service MAJOR_CITIES)
const B = { lat: 60.3913, lng: 5.3221 }; // Bergen
const S = { lat: 58.97, lng: 5.7331 }; // Stavanger: the limit case

const HEVD = "1c000000-0000-4000-8000-000000000001";
const TIRSLAUG = "1c000000-0000-4000-8000-000000000002";
const EIER = "1c000000-0000-4000-8000-000000000003";
const BLANDET = "1c000000-0000-4000-8000-000000000004";
const REINDYRKA = "1c000000-0000-4000-8000-000000000011";
const BONES = "1c000000-0000-4000-8000-000000000012";
const EIER_EGG = "1c000000-0000-4000-8000-000000000013";
const EGGSALG = "1c000000-0000-4000-8000-000000000014";
const SANDVIKEN = "1c000000-0000-4000-8000-000000000015";
const AARVIK = "1c000000-0000-4000-8000-000000000021";

const label = (name: string, category: string) => ({ name, category, seasonal: false });
const HEVD_LABELS = [
  label("Kjøtt", "meat"), label("Meieri", "dairy"), label("Grønnsaker", "vegetables"), label("Bakervarer", "bakery"),
  label("Honning", "honey"), label("Egg", "eggs"), label("Fisk", "fish"), label("Urter", "herbs"),
];
const AARVIK_LABELS = [
  label("Kjøtt", "meat"), label("Meieri", "dairy"), label("Grønnsaker", "vegetables"), label("Bakervarer", "bakery"), label("Egg", "eggs"),
];
// Three labels first, then six products; the eggs are the 7th entry and the 4th product.
const BLANDET_PRODUCTS = [
  label("Honning", "honey"), label("Egg", "eggs"), label("Meieri", "dairy"),
  { name: "Gammelost", category: "dairy", price: "95 kr" }, { name: "Rømme", category: "dairy" }, { name: "Smør", category: "dairy" },
  { name: "Frittgående egg", category: "eggs" }, { name: "Prim", category: "dairy" }, { name: "Brunost", category: "dairy" },
];
/** The label names of the fixtures' enrichment rows (no price, not owner-set). */
const FIXTURE_LABEL_NAMES = ["Kjøtt", "Meieri", "Grønnsaker", "Bakervarer", "Honning", "Egg", "Fisk", "Urter"];

interface CatalogRow {
  name: string;
  priceNok?: number;
  unit?: string;
  /** producer_dashboard: set by the owner (availability_updated_at = ownerSetAt). */
  ownerSet?: boolean;
  availability?: string;
}

interface Seed {
  id: string;
  name: string;
  lat: number;
  lng: number;
  city: string;
  categories: string[];
  /** agent_knowledge.products */
  products: unknown[];
  /** products rows, as product-catalog-sync (or the owner) left them. */
  catalog: CatalogRow[];
  description?: string;
  about?: string;
}

const SEED: Seed[] = [
  { id: HEVD, name: "Hevd Håndverksbakeri Fixture", lat: 63.431, lng: 10.396, city: "Trondheim", categories: ["bakery", "honey", "eggs"],
    products: HEVD_LABELS, catalog: HEVD_LABELS.map((p) => ({ name: p.name })) },
  { id: TIRSLAUG, name: "Tirslaugtrøa Bigård Fixture", lat: 63.46, lng: 10.46, city: "Trondheim", categories: ["honey"],
    products: [{ name: "Løvetannhonning", category: "honey", price: "120 kr/glass" }, { name: "Lynghonning", category: "honey" }],
    catalog: [{ name: "Løvetannhonning", priceNok: 120, unit: "glass" }, { name: "Lynghonning" }] },
  { id: EIER, name: "Eiersatt Honning Fixture", lat: 63.44, lng: 10.42, city: "Trondheim", categories: ["honey"],
    products: [label("Honning", "honey")], catalog: [{ name: "Honning", ownerSet: true }] },
  { id: BLANDET, name: "Blandet Gårdsutsalg Fixture", lat: 63.45, lng: 10.43, city: "Trondheim", categories: ["honey", "eggs", "dairy"],
    products: BLANDET_PRODUCTS, catalog: [{ name: "Honning" }, { name: "Egg" }, { name: "Gammelost", priceNok: 95 }, { name: "Frittgående egg" }],
    description: "<br />", about: "<p></p><br />" },

  { id: REINDYRKA, name: "Reindyrka Fixture", lat: 60.392, lng: 5.323, city: "Bergen", categories: ["eggs", "meat", "honey"],
    products: [label("Kjøtt", "meat"), label("Egg", "eggs"), label("Honning", "honey")],
    catalog: [{ name: "Kjøtt" }, { name: "Egg" }, { name: "Honning" }] },
  { id: BONES, name: "Bønes Gårdsmat Fixture", lat: 60.4, lng: 5.34, city: "Bergen", categories: ["eggs", "meat"],
    products: [{ name: "Ferske egg fra Fana", category: "eggs" }, { name: "Lammekjøtt", category: "meat", price: "300 kr/kg" }],
    catalog: [{ name: "Ferske egg fra Fana" }, { name: "Lammekjøtt", priceNok: 300, unit: "kg" }] },
  { id: EIER_EGG, name: "Eiersatt Egg Fixture", lat: 60.41, lng: 5.35, city: "Bergen", categories: ["eggs"],
    products: [label("Egg", "eggs")], catalog: [{ name: "Egg", ownerSet: true, availability: "out_of_stock" }] },
  { id: EGGSALG, name: "Hordaland Eggsalg Fixture", lat: 60.43, lng: 5.37, city: "Bergen", categories: ["eggs"],
    products: [{ name: "Egg", category: "eggs", price: "60 kr/brett" }], catalog: [{ name: "Egg", priceNok: 60, unit: "brett" }] },
  { id: SANDVIKEN, name: "Sandviken Birøkt Fixture", lat: 60.44, lng: 5.38, city: "Bergen", categories: ["honey"],
    products: [{ name: "Honning", category: "honey", price: "150 kr/glass" }], catalog: [{ name: "Honning", priceNok: 150, unit: "glass" }] },

  { id: AARVIK, name: "Aarvik Gård Fixture", lat: 61.2, lng: 6.9, city: "Vestland", categories: ["meat", "dairy", "bakery", "eggs"],
    products: AARVIK_LABELS, catalog: AARVIK_LABELS.map((p) => ({ name: p.name })) },

  // Stavanger: five producers with only the label «Egg», nearest, then five with real eggs.
  ...[0, 1, 2, 3, 4].map((i): Seed => ({ id: `1c000000-0000-4000-8000-00000000003${i}`, name: `Stavanger Etikett ${i} Fixture`,
    lat: S.lat + i * 0.001, lng: S.lng, city: "Stavanger", categories: ["eggs"], products: [label("Egg", "eggs")], catalog: [{ name: "Egg" }] })),
  ...[0, 1, 2, 3, 4].map((i): Seed => ({ id: `1c000000-0000-4000-8000-00000000004${i}`, name: `Stavanger Egg ${i} Fixture`,
    lat: S.lat + 0.05 + i * 0.001, lng: S.lng, city: "Stavanger", categories: ["eggs"],
    products: [{ name: "Frittgående egg", category: "eggs" }], catalog: [{ name: "Frittgående egg" }] })),
];

/** «YYYY-MM-DD HH:MM:SS» (UTC), the form availability_updated_at is stored in. */
export function sqliteTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * The fixtures in `db`: verified, owner-claimed, opted-in producers (so an
 * offer is orderable), their knowledge and catalog rows. `ownerSetAt` is the
 * availability_updated_at of the owner-set rows. Exported so main's output
 * can be captured with the same data.
 */
export function seedCategoryLabelOfferFixtures(db: Database.Database, ownerSetAt: string): void {
  const agentStmt = db.prepare(`
    INSERT INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, order_notifications_opt_in, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            ?, ?, ?, ?, '[]', '[]', '{}', '["no"]',
            0.5, 1, 1, 1, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  const knowledgeStmt = db.prepare(`
    INSERT INTO agent_knowledge (agent_id, address, phone, email, products, about, verification_status)
    VALUES (?, ?, '91234567', ?, ?, ?, 'verified')
  `);
  const catalogStmt = db.prepare(`
    INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, s.description ?? `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`,
      `key-${s.id}`, s.lat, s.lng, s.city, JSON.stringify(s.categories));
    knowledgeStmt.run(s.id, `${s.city}veien 1`, `${s.id}@example.no`, JSON.stringify(s.products), s.about ?? null);
    s.catalog.forEach((c, i) => {
      catalogStmt.run(`${s.id}-p${i}`, s.id, c.name, c.name.toLowerCase(), c.priceNok ?? null, c.unit ?? null, c.availability ?? "in_stock",
        c.ownerSet ? "producer_dashboard" : "enrichment", c.ownerSet ? ownerSetAt : null);
    });
  }
}

/** Express's router driven directly, as marketplace-catalog-offers.test.ts does. */
function callRoute(router: any, url: string, query: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: "GET", url, originalUrl: url, params: {}, query, headers: {}, ip: "127.0.0.1", get: () => undefined };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined }));
  });
}

export async function runRfbKategorietiketterIkkeTilbudTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  // A day ago: fresh for the supply graph's staleness window.
  const ownerSetAt = sqliteTimestamp(new Date(Date.now() - 24 * 3600 * 1000));
  seedCategoryLabelOfferFixtures(db, ownerSetAt);
  __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
  __clearGeocodeCacheForTesting();
  const prevBaseUrl = process.env.BASE_URL;
  delete process.env.BASE_URL;

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  marketplaceRegistry._agentsCache = null;

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };

  try {
    const { isCategoryLabel, isGenericCategoryName, areGenericCategoryNames } =
      require("../utils/category-label") as typeof import("../utils/category-label");
    const { productsAreGenericCategoryNames } = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
    const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const mcp = require("./mcp") as typeof import("./mcp");

    const tools = new Map<string, CapturedTool>();
    const fakeServer: any = {
      registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    };
    mcp.registerTools(fakeServer, () => "test-client", () => undefined);
    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
    /** The compact result block of one producer: its heading line up to the next result. */
    const blockOf = (t: string, name: string) => {
      const start = t.search(new RegExp(`^\\*\\*\\d+\\. ${name}`, "m"));
      if (start < 0) return "";
      const next = t.slice(start + 1).search(/^\*\*\d+\. /m);
      return next < 0 ? t.slice(start) : t.slice(start, start + 1 + next);
    };
    const summaryOf = (block: string) => (block.match(/^ {3}🛒 .*$/m) || [""])[0];
    const hint = (id: string) => `   _Bruk lokal_info med agentId "${id}" for kontaktinfo, åpningstider og hele produktlista (pris kun der produsenten har oppgitt den)_`;
    const offerRows = (r: { offers: any[] }) => r.offers.map((o) => `${o.producer.name}: ${o.product_name}`);

    // ══════════════════════════════════════════════════════════════
    // The rule (utils/category-label.ts)
    // ══════════════════════════════════════════════════════════════
    assertEq(
      [{ name: "Honning", hasPrice: false }, { name: " egg ", hasPrice: false }, { name: "BAKERVARER", hasPrice: false, availabilitySource: "enrichment" },
        { name: "Kjøtt", hasPrice: false, availabilitySource: null }].map(isCategoryLabel),
      [true, true, true, true],
      "rule: a category name (any case, any spacing) without a price, not set by the owner, is a label");
    assertEq(
      [{ name: "Honning", hasPrice: true }, { name: "Egg", hasPrice: false, availabilitySource: "producer_dashboard" },
        { name: "Lynghonning", hasPrice: false }, { name: "Kjøtt og egg", hasPrice: false }, { name: "", hasPrice: false }, { name: "  ", hasPrice: false }]
        .map(isCategoryLabel),
      [false, false, false, false, false, false],
      "rule: a price, an owner-set row (F2), a real name, a compound name (data quality, out of scope) or no name is no label");
    {
      // «Navnelisten er den samme»: the shared rule is I-A's, name by name.
      const names = ["Honning", "honning ", "EGG", "Kjøtt", "Meieri", "Grønnsaker", "Frukt", "Bær", "Fisk", "Brød", "Urter", "Bakeri", "Bakervarer",
        "Drikke", "Syltetøy", "Annet", "Lynghonning", "Ferske egg fra Fana", "Kjøtt og egg", "Lokal mat", "Honey", "", "  "];
      assertEq(names.map(isGenericCategoryName), names.map((n) => productsAreGenericCategoryNames(JSON.stringify([n]))),
        "rule: isGenericCategoryName is productsAreGenericCategoryNames per name (the same name list)");
      assertEq([areGenericCategoryNames([]), areGenericCategoryNames(["Egg", "Honning"]), areGenericCategoryNames(["Egg", "Lynghonning"])],
        [false, true, false], "rule: areGenericCategoryNames is true only for a non-empty list of category names");
      assertTrue(mcp.isGenericCategoryName === isGenericCategoryName, "rule: mcp.ts uses the shared function (one rule, one place)");
    }

    // ══════════════════════════════════════════════════════════════
    // Offers (findOffers): the acceptance criterion's four searches
    // ══════════════════════════════════════════════════════════════
    const searches = {
      honningT: await findOffers({ q: "honning", near: "Trondheim" }),
      eggT: await findOffers({ q: "egg", near: "Trondheim" }),
      honningB: await findOffers({ q: "honning", near: "Bergen" }),
      eggB: await findOffers({ q: "egg", near: "Bergen" }),
    };
    assertEq(offerRows(searches.honningT), [
      "Eiersatt Honning Fixture: Honning", "Tirslaugtrøa Bigård Fixture: Løvetannhonning", "Tirslaugtrøa Bigård Fixture: Lynghonning",
    ], "offers «honning» near Trondheim: the bakery's and the mixed shop's label rows are gone; the owner-set row and real products stay, nearest first");
    assertEq(offerRows(searches.eggT), ["Blandet Gårdsutsalg Fixture: Frittgående egg"],
      "offers «egg» near Trondheim: the label rows «Egg» are gone, the real eggs stay");
    assertEq(offerRows(searches.honningB), ["Sandviken Birøkt Fixture: Honning"],
      "offers «honning» near Bergen: a «Honning» with a price is an offer, the label without one is not");
    assertEq(offerRows(searches.eggB), ["Bønes Gårdsmat Fixture: Ferske egg fra Fana", "Eiersatt Egg Fixture: Egg", "Hordaland Eggsalg Fixture: Egg"],
      "offers «egg» near Bergen: Reindyrka's label is gone; real eggs, the owner-set «Egg» and a priced «Egg» stay");
    assertTrue(Object.values(searches).every((r) => r.offers.every((o) =>
      !(FIXTURE_LABEL_NAMES.includes(o.product_name) && o.price_nok === null) || o.producer.agent_id === EIER || o.producer.agent_id === EIER_EGG)),
    "offers: no label row without a price on any of the four searches, apart from the owner-set rows");
    {
      const offerOf = (r: { offers: any[] }, agentId: string) => r.offers.find((o) => o.producer.agent_id === agentId);
      const owner = offerOf(searches.honningT, EIER);
      assertEq([owner?.product_id, owner?.price_nok, owner?.availability, owner?.producer.can_order], [`${EIER}-p0`, null, "in_stock", true],
        "F2 offers: the owner-set «Honning» keeps its product_id and availability (orderable)");
      const ownerEgg = offerOf(searches.eggB, EIER_EGG);
      assertEq([ownerEgg?.product_id, ownerEgg?.availability], [`${EIER_EGG}-p0`, "out_of_stock"],
        "F2 offers: an owner-set «Egg» marked out of stock keeps that availability");
      const priced = offerOf(searches.eggB, EGGSALG);
      assertEq([priced?.product_id, priced?.price_nok, priced?.unit], [`${EGGSALG}-p0`, 60, "brett"], "offers: a priced «Egg» keeps id, price and unit");
    }
    {
      // limit after the filter: five labels are nearer than five real eggs.
      const r = await findOffers({ q: "egg", lat: S.lat, lng: S.lng, limit: 5 });
      assertEq(offerRows(r), [0, 1, 2, 3, 4].map((i) => `Stavanger Egg ${i} Fixture: Frittgående egg`),
        "offers limit: applied after the filter, so five nearer labels do not shorten the page (five real offers, nearest first)");
      const two = await findOffers({ q: "egg", lat: S.lat, lng: S.lng, limit: 2 });
      assertEq(offerRows(two), [0, 1].map((i) => `Stavanger Egg ${i} Fixture: Frittgående egg`), "offers limit: a smaller limit cuts the filtered list");
    }

    // ══════════════════════════════════════════════════════════════
    // The three surfaces that read findOffers
    // ══════════════════════════════════════════════════════════════
    {
      // GET /api/marketplace/catalog/offers — also what the shopping list page (handleliste-page.ts) fetches.
      for (const [q, near, key] of [["honning", "Trondheim", "honningT"], ["egg", "Bergen", "eggB"]] as const) {
        const r = await callRoute(catalogRouter, "/offers", { q, near, radius_km: "50", limit: "5" });
        assertEq([r.status, Object.keys(r.body).sort()], [200, ["offers", "term"]], `GET /catalog/offers «${q}» near ${near}: 200, envelope unchanged`);
        assertEq(r.body, searches[key], `GET /catalog/offers «${q}» near ${near}: findOffers' filtered result`);
      }
      const r = await tools.get("lokal_find_offers")!.handler({ items: ["honning", "egg"], near: "Trondheim" });
      assertEq(JSON.parse(textOf(r)), [searches.honningT, searches.eggT], "lokal_find_offers: one filtered findOffers result per item, same JSON");
      const b = await tools.get("lokal_find_offers")!.handler({ items: ["honning", "egg"], lat: B.lat, lng: B.lng });
      assertEq(JSON.parse(textOf(b)), [searches.honningB, searches.eggB], "lokal_find_offers with lat/lng: the same filtered results");
    }

    // ══════════════════════════════════════════════════════════════
    // lokal_info: provenance (F2)
    // ══════════════════════════════════════════════════════════════
    {
      const t = textOf(await tools.get("lokal_info")!.handler({ agentId: EIER }));
      assertTrue(t.includes(`\n## Produkter (1 stk)\n- Honning [honey]  · id: ${EIER}-p0  · availability: in_stock  · availability_updated_at: ${ownerSetAt}`)
        && !t.includes("Kategorier"),
      `F2 lokal_info: an owner-set «Honning» is a product with its id and availability (got: ${t.slice(t.indexOf("## Produkter"), t.indexOf("## Produkter") + 160)})`);
      const egg = textOf(await tools.get("lokal_info")!.handler({ agentId: EIER_EGG }));
      assertTrue(egg.includes(`\n## Produkter (1 stk)\n- Egg [eggs]  · availability: out_of_stock  · availability_updated_at: ${ownerSetAt}`)
        && !egg.includes("· id:") && !egg.includes("Kategorier"),
      "F2 lokal_info: an owner-set «Egg» out of stock keeps its availability (no cart id, as for any product out of stock)");
      const hevd = textOf(await tools.get("lokal_info")!.handler({ agentId: HEVD }));
      assertTrue(hevd.includes(`\n**Kategorier:** ${HEVD_LABELS.map((p) => p.name).join(", ")}\n${mcp.MCP_CATEGORY_LABELS_NOTE}`) && !hevd.includes("· id:"),
        "F2 lokal_info: enrichment labels stay categories without id (I-N)");
      const avail = (availabilitySource: string) => new Map([["honning", { availability: "in_stock", availabilityUpdatedAt: null, availabilitySource }]]);
      assertEq([mcp.formatProductsForMcp([label("Honning", "honey")], new Map([["honning", "p-1"]]), avail("producer_dashboard")),
        mcp.formatProductsForMcp([label("Honning", "honey")], new Map([["honning", "p-1"]]), avail("enrichment"))],
      ["\n## Produkter (1 stk)\n- Honning [honey]  · id: p-1  · availability: in_stock", `\n**Kategorier:** Honning\n${mcp.MCP_CATEGORY_LABELS_NOTE}`],
      "F2 formatProductsForMcp: the catalog row's availabilitySource decides (producer_dashboard: product; enrichment: category)");
      assertEq(mcp.getCatalogAvailabilityMap(EIER).get("honning"), { availability: "in_stock", availabilityUpdatedAt: ownerSetAt, availabilitySource: "producer_dashboard" },
        "F2 getCatalogAvailabilityMap: carries the row's availability_source");
    }

    // ══════════════════════════════════════════════════════════════
    // The 🛒 summary (F5) in lokal_discover and lokal_search
    // ══════════════════════════════════════════════════════════════
    const BLANDET_SUMMARY = "   🛒 Gammelost (95 kr), Rømme, Smør, Frittgående egg, Prim +1 flere";
    {
      const t = textOf(await tools.get("lokal_discover")!.handler({ categories: ["honey"], lat: T.lat, lng: T.lng, limit: 10 }));
      const hevd = blockOf(t, "Hevd Håndverksbakeri Fixture");
      assertTrue(!!hevd && !hevd.includes("🛒") && hevd.includes(`\n${hint(HEVD)}\n`),
        `F5 lokal_discover: Hevd (only labels) has no 🛒 line and keeps its lokal_info pointer (got: ${hevd})`);
      assertEq(summaryOf(blockOf(t, "Blandet Gårdsutsalg Fixture")), BLANDET_SUMMARY,
        "F5 lokal_discover: a mixed list's 🛒 line shows the products only, and «+N flere» counts products");
      assertEq(summaryOf(blockOf(t, "Tirslaugtrøa Bigård Fixture")), "   🛒 Løvetannhonning (120 kr/glass), Lynghonning",
        "F5 lokal_discover: a list without labels keeps its 🛒 line");
      const aarvik = blockOf(textOf(await tools.get("lokal_discover")!.handler({ categories: ["meat"], lat: 61.2, lng: 6.9, limit: 10 })), "Aarvik Gård Fixture");
      assertTrue(!!aarvik && !aarvik.includes("🛒") && aarvik.includes(`\n${hint(AARVIK)}\n`),
        `F5 lokal_discover: Aarvik (only labels) has no 🛒 line and keeps its lokal_info pointer (got: ${aarvik})`);
    }
    {
      const t = textOf(await tools.get("lokal_search")!.handler({ query: "honning nær Trondheim", limit: 10 }));
      const hevd = blockOf(t, "Hevd Håndverksbakeri Fixture");
      assertTrue(hevd.startsWith("**") && hevd.includes(" — Kategoritreff / category-only: «honning» bare som kategorinavn / category name only**")
        && hevd.includes("⚠️ Kategoritreff: produktlista har «honning» bare som kategorinavn") && !hevd.includes("🛒") && hevd.includes(`\n${hint(HEVD)}\n`),
        `F5 lokal_search «honning nær Trondheim»: Hevd keeps I-N's label and its pointer, without a 🛒 line (got: ${hevd})`);
      assertEq(summaryOf(blockOf(t, "Blandet Gårdsutsalg Fixture")), BLANDET_SUMMARY,
        "F5 lokal_search: a category match with products shows those products only");
      const egg = textOf(await tools.get("lokal_search")!.handler({ query: "egg nær Trondheim", limit: 10 }));
      assertEq(summaryOf(blockOf(egg, "Blandet Gårdsutsalg Fixture")), BLANDET_SUMMARY,
        "F5 lokal_search «egg nær Trondheim»: the listed match is the 4th product shown, so the summary is not reordered (I-N's first five are the products shown)");
      assertTrue(!blockOf(egg, "Hevd Håndverksbakeri Fixture").includes("🛒"), "F5 lokal_search «egg nær Trondheim»: Hevd has no 🛒 line");
      const bergen = textOf(await tools.get("lokal_search")!.handler({ query: "egg i Bergen", limit: 10 }));
      assertTrue(!blockOf(bergen, "Reindyrka Fixture").includes("🛒") && summaryOf(blockOf(bergen, "Hordaland Eggsalg Fixture")) === "   🛒 Egg (60 kr/brett)",
        "F5 lokal_search «egg i Bergen»: label-only producers have no 🛒 line, a priced «Egg» keeps it");
    }

    // ══════════════════════════════════════════════════════════════
    // F1 — a description that is only tags
    // ══════════════════════════════════════════════════════════════
    {
      const t = textOf(await tools.get("lokal_info")!.handler({ agentId: BLANDET }));
      assertTrue(t.includes("📍 Trondheim  ·  ✔ Verifisert av eier\n\n## Kontakt") && !t.includes("\n\n\n"),
        `F1 lokal_info: an about of only tags gives no empty lines (got: ${JSON.stringify(t.slice(0, 120))})`);
      const block = blockOf(textOf(await tools.get("lokal_discover")!.handler({ categories: ["honey"], lat: T.lat, lng: T.lng, limit: 10 })),
        "Blandet Gårdsutsalg Fixture");
      assertTrue(block.startsWith("**") && block.split("\n").every((l) => l.trim() !== "" || l === "") && block.split("\n")[1] === "   📍 Trondheim  ·  🏷️ honey, eggs, dairy",
        `F1 compact view: a description of only tags gives no empty indented line (got: ${JSON.stringify(block.slice(0, 120))})`);
      const tirslaug = textOf(await tools.get("lokal_info")!.handler({ agentId: TIRSLAUG }));
      assertTrue(tirslaug.includes("📍 Trondheim  ·  ✔ Verifisert av eier\n\n## Kontakt"),
        "F1 lokal_info: no about gives the same text as before (no section)");
    }

    // ══════════════════════════════════════════════════════════════
    // Byte-like: without the label rows, the offers are the same
    // ══════════════════════════════════════════════════════════════
    {
      const removed = db.prepare(`DELETE FROM products WHERE price_nok IS NULL AND availability_source = 'enrichment' AND name IN (${FIXTURE_LABEL_NAMES.map(() => "?").join(", ")})`)
        .run(...FIXTURE_LABEL_NAMES).changes;
      assertTrue(removed === 23, `byte-like setup: the fixtures' 23 label rows removed (got ${removed})`);
      const again = {
        honningT: await findOffers({ q: "honning", near: "Trondheim" }),
        eggT: await findOffers({ q: "egg", near: "Trondheim" }),
        honningB: await findOffers({ q: "honning", near: "Bergen" }),
        eggB: await findOffers({ q: "egg", near: "Bergen" }),
      };
      assertEq(again, searches, "byte-like: real products and owner-set rows are the same offers, field by field, with or without the label rows");
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
  runRfbKategorietiketterIkkeTilbudTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
