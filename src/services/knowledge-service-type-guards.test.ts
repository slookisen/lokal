/**
 * knowledge-service-type-guards.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-F (FUNN
 * rfb-knowledge-service-typesikkerhet, found during I-A / lokal#1107).
 *
 * The agent_knowledge columns are JSON whose shape nothing enforces. Three
 * crashes were seen while I-A was built, each turned into a generic error by
 * I-A's guard but still failing the whole answer:
 *   - parseProductPrice called `(p.price || "").trim()` and threw on a price
 *     stored as a number;
 *   - relabelCertifications called `.trim()` on entries that are not text;
 *   - one knowledge row whose JSON does not parse took down a whole
 *     lokal_search answer (getAgentKnowledgeSummary had no per-row isolation)
 *     and lokal_info for that producer.
 * Now: the price is read as number or text (anything else is no price); the
 * list fields are text entries; getAgentInfo hands each field over in the
 * shape its type declares; a column that does not parse is read as empty and
 * logged as `[knowledge-guard]` with the agent id and the column (never the
 * value); the write path still reads strictly (no data repair); and an error
 * in one row of a lokal_search / lokal_discover answer leaves that row's
 * knowledge out, logged, while the rest of the answer is delivered.
 *
 * Same duck-typed-server harness as mcp-lokal-info-and-category-labels.test.ts
 * against the real production schema in an in-memory DB.
 *
 * Exported runKnowledgeServiceTypeGuardsTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/services/knowledge-service-type-guards.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "./geocoding-service";
import type { ProductInfo } from "./knowledge-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: any;
  handler: (args: any, extra?: any) => Promise<any>;
}

// Trondheim sentrum is 63.4305, 10.3951; the four honey producers are all near it.
const NUMERIC_PRICE = "1f000000-0000-4000-8000-000000000001";
const BAD_JSON_PRODUCTS = "1f000000-0000-4000-8000-000000000002";
const WELL_FORMED = "1f000000-0000-4000-8000-000000000003";
const THROWS = "1f000000-0000-4000-8000-000000000004";
const MANY_BAD_COLUMNS = "1f000000-0000-4000-8000-000000000005";
const WRITE_STRICT = "1f000000-0000-4000-8000-000000000006";
const MERGE_SOURCES = "1f000000-0000-4000-8000-000000000007";

// A value no log line may carry: JSON.parse's own message quotes the start of
// the text it fails on, and the stored text can hold contact details.
const LEAK = "LEAKMARKER";
const BAD_PRODUCTS_TEXT = `${LEAK} Honning 150 kr, ring kari.kjoper@example.no`;

const WELL_FORMED_KNOWLEDGE = {
  products: [{ name: "Lynghonning", category: "honey", price: "150/glass" }, { name: "Bivoks", category: "other" }],
  openingHours: [{ day: "sat", open: "10:00", close: "14:00" }],
  specialties: ["Lynghonning", "Bivokslys"],
  certifications: ["Nyt Norge"],
  paymentMethods: ["Vipps", "Kontant"],
  deliveryOptions: ["Henting på gården"],
  images: ["https://example.no/bigard.jpg"],
  seasonality: [{ product: "Lynghonning", months: [8, 9] }],
  autoSources: ["website", "google_maps"],
};

interface Seed {
  id: string;
  name: string;
  lat: number;
  lng: number;
  city: string;
  categories: string[];
  languages?: string;
  knowledge: Record<string, string>;
}

const SEED: Seed[] = [
  {
    id: NUMERIC_PRICE, name: "Kaldvik Bigård Fixture", lat: 63.4400, lng: 10.4100, city: "Trondheim",
    categories: ["honey"],
    knowledge: {
      products: JSON.stringify([
        { name: "Lynghonning", category: "honey", price: 150 },
        { name: "Løvetannhonning", category: "honey", price: "120/glass" },
        { name: "Sommerhonning – kr 99", category: "honey", price: 0 },
        { name: "Bivoks", category: { kind: "wax" }, price: true },
        { name: "🍯 HONNING", price: { from: 100 } },
        { name: 2024, price: 50 },
        null,
        7,
        "Kremhonning",
      ]),
      certifications: JSON.stringify([7, null, { x: 1 }, " Nyt Norge ", "", "Debio-sertifisert"]),
      specialties: JSON.stringify([1, "Lynghonning", { a: 1 }]),
      payment_methods: JSON.stringify("Vipps"),
      delivery_options: JSON.stringify([{ pickup: true }, "Henting på gården"]),
      images: JSON.stringify(["https://example.no/kaldvik.jpg", 3, null]),
      seasonality: JSON.stringify([{ product: "Lynghonning", months: [8] }, null, 5]),
      opening_hours: JSON.stringify([{ day: "sat", open: "10:00", close: "14:00" }, null, 3]),
      auto_sources: JSON.stringify(["website", 5]),
    },
  },
  {
    // products is not JSON at all: one such row used to fail all of lokal_search.
    id: BAD_JSON_PRODUCTS, name: "Lade Honning Fixture", lat: 63.4450, lng: 10.4300, city: "Trondheim",
    categories: ["honey"],
    knowledge: {
      products: BAD_PRODUCTS_TEXT,
      opening_hours: JSON.stringify([{ day: "fri", open: "12:00", close: "18:00" }]),
      specialties: JSON.stringify(["Lynghonning"]),
    },
  },
  {
    id: WELL_FORMED, name: "Byåsen Birøkt Fixture", lat: 63.4200, lng: 10.3500, city: "Trondheim",
    categories: ["honey"],
    languages: JSON.stringify(["no", "en"]),
    knowledge: {
      products: JSON.stringify(WELL_FORMED_KNOWLEDGE.products),
      opening_hours: JSON.stringify(WELL_FORMED_KNOWLEDGE.openingHours),
      specialties: JSON.stringify(WELL_FORMED_KNOWLEDGE.specialties),
      certifications: JSON.stringify(WELL_FORMED_KNOWLEDGE.certifications),
      payment_methods: JSON.stringify(WELL_FORMED_KNOWLEDGE.paymentMethods),
      delivery_options: JSON.stringify(WELL_FORMED_KNOWLEDGE.deliveryOptions),
      images: JSON.stringify(WELL_FORMED_KNOWLEDGE.images),
      seasonality: JSON.stringify(WELL_FORMED_KNOWLEDGE.seasonality),
      auto_sources: JSON.stringify(WELL_FORMED_KNOWLEDGE.autoSources),
    },
  },
  {
    // Well-formed; the per-row tests make getAgentInfo throw for it.
    id: THROWS, name: "Ranheim Honning Fixture", lat: 63.4300, lng: 10.4500, city: "Trondheim",
    categories: ["honey"],
    knowledge: { products: JSON.stringify([{ name: "Skogshonning", category: "honey", price: "140" }]) },
  },
  {
    // Every JSON column but products is broken, and so is agents.languages.
    id: MANY_BAD_COLUMNS, name: "Alna Grønt Fixture", lat: 59.9300, lng: 10.8500, city: "Oslo",
    categories: ["vegetables"],
    languages: `${LEAK} no`,
    knowledge: {
      products: JSON.stringify([{ name: "Poteter", category: "vegetables", price: 30 }]),
      opening_hours: `${LEAK} man-fre`,
      specialties: `${LEAK} [`,
      certifications: `${LEAK} {`,
      payment_methods: `${LEAK} Vipps`,
      delivery_options: `${LEAK} henting`,
      images: `${LEAK} http`,
      seasonality: `${LEAK} juni`,
      auto_sources: `${LEAK} web`,
      external_reviews: `${LEAK} bra`,
      external_links: `${LEAK} fb`,
      preferences: `${LEAK} {a:1}`,
      curated_fields: `${LEAK} {b:2}`,
    },
  },
  {
    id: WRITE_STRICT, name: "Grorud Gård Fixture", lat: 59.9600, lng: 10.8800, city: "Oslo",
    categories: ["vegetables"],
    knowledge: { products: BAD_PRODUCTS_TEXT, about: "Gammel tekst" },
  },
  {
    id: MERGE_SOURCES, name: "Furuset Gård Fixture", lat: 59.9400, lng: 10.9000, city: "Oslo",
    categories: ["vegetables"],
    knowledge: { auto_sources: JSON.stringify("google_maps"), preferences: JSON.stringify("kort") },
  },
];

const KNOWN_COLUMNS = [
  "opening_hours", "specialties", "certifications", "payment_methods", "delivery_options", "images",
  "seasonality", "auto_sources", "external_reviews", "external_links", "preferences", "curated_fields",
];

function seed(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            ?, ?, ?, ?, '[]', '[]', '{}', ?,
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`,
      `key-${s.id}`, s.lat, s.lng, s.city, JSON.stringify(s.categories), s.languages ?? '["no"]');
    const cols = ["agent_id", "address", "phone", "email", ...Object.keys(s.knowledge)];
    const vals = [s.id, `${s.city}veien 1`, "91234567", `${s.id}@example.no`, ...Object.values(s.knowledge)];
    db.prepare(`INSERT INTO agent_knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }
}

/**
 * parseProductPrice as it was before slice I-F, kept here to show that every
 * product whose name and price are text gives exactly the same result.
 */
function legacyParseProductPrice(
  p: ProductInfo,
  isProductHeader: (n: string) => boolean,
  isProductNoise: (n: string) => boolean,
): { cleanName: string; price: string | null; section: string | null } {
  const name = (p.name || "").trim();
  if (isProductHeader(name)) {
    const headerText = name.replace(/[\p{Emoji_Presentation}\p{Emoji}️]/gu, "").trim();
    const subInfo = p.price && !/^\d/.test(p.price) ? p.price : null;
    return { cleanName: headerText, price: null, section: subInfo || headerText };
  }
  if (isProductNoise(name)) return { cleanName: name, price: null, section: null };
  let price = (p.price || "").trim();
  if (price && !/\d/.test(price)) price = "";
  let cleanName = name;
  if (!price) {
    const m = name.match(/^(.+?)\s*[–\-—]\s*kr\.?\s*([\d,.\s]+(?:\/\w+)?)\s*$/i);
    if (m) { cleanName = m[1].trim(); price = `kr ${m[2].trim()}`; }
  }
  if (!price) {
    const m = name.match(/^(.+?)\s+kr\.?\s*([\d,.\s]+(?:\/\w+)?)\s*$/i);
    if (m) { cleanName = m[1].trim(); price = `kr ${m[2].trim()}`; }
  }
  return { cleanName, price: price || null, section: null };
}

export async function runKnowledgeServiceTypeGuardsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
  marketplaceRegistry._agentsCache = null;
  const ks = require("./knowledge-service") as typeof import("./knowledge-service");
  const { knowledgeService, parseProductPrice, productPriceText, relabelCertifications, isProductHeader, isProductNoise } = ks;

  // getAgentInfo throws for one producer: an error the type guards do not
  // cover (a DB error, a bug), for the per-row isolation. null restores it.
  const realGetAgentInfo = knowledgeService.getAgentInfo;
  const failInfoFor = (failingId: string | null) => {
    knowledgeService.getAgentInfo = failingId === null ? realGetAgentInfo : function (this: typeof knowledgeService, id: string) {
      if (id === failingId) throw new TypeError(`p.price.trim is not a function ${LEAK}\n    at ${LEAK}_FRAME (stored value)`);
      return realGetAgentInfo.call(this, id);
    };
  };

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry chatter */ };
  const prevError = console.error;
  const errorLog: string[] = [];
  console.error = (...args: unknown[]) => { errorLog.push(args.map(String).join(" ")); };
  const logSince = (n: number) => errorLog.slice(n).join("\n");

  try {
    // ══════════════════════════════════════════════════════════════
    // Price: number and text, anything else is no price
    // ══════════════════════════════════════════════════════════════
    assertEq(["275/kg", " 150 ", "", "Spør"].map(productPriceText), ["275/kg", " 150 ", "", "Spør"],
      "productPriceText: text is returned as it is");
    assertEq([150, 12.5].map(productPriceText), ["150", "12.5"], "productPriceText: a positive number is its digits");
    assertEq([0, -5, NaN, Infinity, null, undefined, true, { from: 100 }, [150]].map(productPriceText),
      ["", "", "", "", "", "", "", "", ""],
      "productPriceText: 0, negative and non-finite numbers, null, a boolean, an object and a list are no price");

    assertEq(parseProductPrice({ name: "Lynghonning", price: 150 } as any),
      { cleanName: "Lynghonning", price: "150", section: null },
      "parseProductPrice: a numeric price is the price (used to throw `.trim is not a function`)");
    assertEq(parseProductPrice({ name: "Sommerhonning – kr 99", price: 0 } as any),
      { cleanName: "Sommerhonning", price: "kr 99", section: null },
      "parseProductPrice: price 0 is no price, so the price in the name is used, as before");
    assertEq([{ from: 100 }, [150], true, null].map((price) => parseProductPrice({ name: "Bivoks", price } as any)),
      Array(4).fill({ cleanName: "Bivoks", price: null, section: null }),
      "parseProductPrice: an object, a list, a boolean or null as price is no price");
    assertEq(parseProductPrice({ name: "🍯 HONNING", price: { from: 100 } } as any),
      { cleanName: "HONNING", price: null, section: "HONNING" },
      "parseProductPrice: a section header with an object price falls back to the header text");
    assertEq(parseProductPrice({ name: "🍯 HONNING", price: 150 } as any),
      parseProductPrice({ name: "🍯 HONNING", price: "150" } as ProductInfo),
      "parseProductPrice: a section header with a numeric price reads like the same price as text");
    assertEq([2024, null, { a: 1 }, ["x"]].map((name) => parseProductPrice({ name, price: 50 } as any)),
      Array(4).fill({ cleanName: "", price: null, section: null }),
      "parseProductPrice: a name that is not text is no name (noise), without throwing");
    assertEq([null, undefined, "Honning", 7].map((p) => parseProductPrice(p as any)),
      Array(4).fill({ cleanName: "", price: null, section: null }),
      "parseProductPrice: an entry that is not an object gives an empty result, without throwing");

    {
      // Regression: every product whose name and price are text gives what the old code gave.
      const corpus: ProductInfo[] = [
        "Lammelår – kr 275/kg", "Lammelår — kr. 275", "Egg kr.60", "Egg kr 60/brett", "Honning", "  Honning  ",
        "🐑 LAM", "📋 STYKNINGSDELER", "❌ Tomt for egg", "⸻", "Kr.1000", "Alle unntatt lam", "Poteter - kr 30,50",
        "Ost – kr 1 200/kg", "", "LAM & SAU", "Surdeigsbrød",
      ].flatMap((name) => ["", "275/kg", " 150 ", "150", "Spør om pris", "Bestill før fredag", "kr 99", undefined]
        .map((price) => ({ name, category: "other", seasonal: false, ...(price === undefined ? {} : { price }) })));
      const diffs = corpus.filter((p) =>
        JSON.stringify(parseProductPrice(p)) !== JSON.stringify(legacyParseProductPrice(p, isProductHeader, isProductNoise)));
      assertEq(diffs.map((p) => [p.name, p.price]), [],
        `parseProductPrice: ${corpus.length} text-valued products give exactly the pre-I-F result`);
    }

    // ══════════════════════════════════════════════════════════════
    // Certifications: text entries only
    // ══════════════════════════════════════════════════════════════
    // Økologi S0 (dev-request 2026-10-28-rfb-okologisk-merking-…): no
    // «Hevder økologisk» — an unverified producer gets no organic label.
    assertEq(relabelCertifications([7, null, { x: 1 }, ["Debio"], " Nyt Norge ", "", "Debio-sertifisert"], false),
      ["Nyt Norge"],
      "relabelCertifications: numbers, null, objects and lists are skipped (used to throw on `.trim()`)");
    assertEq(relabelCertifications([7, " Nyt Norge "], true), ["Debio-godkjent", "Nyt Norge"],
      "relabelCertifications: the verified label is still prepended");
    assertEq(relabelCertifications("Debio-sertifisert", false), [],
      "relabelCertifications: a list stored as one string is one entry (it used to be dropped)");
    assertEq([42, { a: "b" }, null, undefined].map((raw) => relabelCertifications(raw, false)), [[], [], [], []],
      "relabelCertifications: a number, an object, null or nothing is no certification");
    assertEq(relabelCertifications(["Debio-sertifisert", "Nyt Norge"], false), ["Nyt Norge"],
      "relabelCertifications: a list of text is relabelled as before (PR-95)");

    // ══════════════════════════════════════════════════════════════
    // getAgentInfo: every field in the shape its type declares
    // ══════════════════════════════════════════════════════════════
    {
      const before = errorLog.length;
      const info = knowledgeService.getAgentInfo(WELL_FORMED)!;
      const k = info.knowledge;
      const W = WELL_FORMED_KNOWLEDGE;
      assertEq(
        [k.products, k.openingHours, k.specialties, k.certifications, k.paymentMethods, k.deliveryOptions, k.images, k.seasonality, info.meta.autoSources, info.agent.languages],
        [W.products, W.openingHours, W.specialties, W.certifications, W.paymentMethods, W.deliveryOptions, W.images, W.seasonality, W.autoSources, ["no", "en"]],
        "getAgentInfo: well-formed fields come through unchanged");
      assertEq(logSince(before), "", "getAgentInfo: a well-formed row logs nothing");
    }
    {
      const info = knowledgeService.getAgentInfo(NUMERIC_PRICE)!;
      const k = info.knowledge;
      assertEq(k.products.map((p: any) => (typeof p === "string" ? p : p.name)),
        ["Lynghonning", "Løvetannhonning", "Sommerhonning – kr 99", "Bivoks", "🍯 HONNING", "Kremhonning"],
        "getAgentInfo products: null, a number and a product without a text name are left out; text entries and named products stay");
      assertEq((k.products[0] as any).price, 150, "getAgentInfo products: a product's own fields are not rewritten (the reader types them)");
      assertEq(k.certifications, ["Nyt Norge"], "getAgentInfo certifications: text entries, relabelled");
      assertEq([k.specialties, k.paymentMethods, k.deliveryOptions, k.images, info.meta.autoSources],
        [["Lynghonning"], ["Vipps"], ["Henting på gården"], ["https://example.no/kaldvik.jpg"], ["website"]],
        "getAgentInfo: list-of-text fields keep their text entries; one string is one entry");
      assertEq([k.openingHours, k.seasonality],
        [[{ day: "sat", open: "10:00", close: "14:00" }], [{ product: "Lynghonning", months: [8] }]],
        "getAgentInfo openingHours/seasonality: null and number entries are left out");
    }
    {
      const hoursOf = (stored: string) => {
        db.prepare("UPDATE agent_knowledge SET opening_hours = ? WHERE agent_id = ?").run(stored, THROWS);
        return knowledgeService.getAgentInfo(THROWS)!.knowledge.openingHours as unknown;
      };
      assertEq(hoursOf(JSON.stringify("Man–fre 10–17")), "Man–fre 10–17",
        "getAgentInfo openingHours: free text stays text (lokal_info and the producer page show it, slice I-A)");
      assertEq([hoursOf(JSON.stringify("  ")), hoursOf(JSON.stringify({ mon: "10-17" })), hoursOf("42"), hoursOf("null")],
        [[], [], [], []], "getAgentInfo openingHours: blank text, an object, a number and null are no opening hours");
      db.prepare("UPDATE agent_knowledge SET opening_hours = '[]' WHERE agent_id = ?").run(THROWS);
    }

    // ══════════════════════════════════════════════════════════════
    // JSON that does not parse: read as empty and logged, never the value
    // ══════════════════════════════════════════════════════════════
    {
      // JSON.parse's own message quotes the start of the text — logging it would leak.
      let parseMessage = "";
      try { JSON.parse(BAD_PRODUCTS_TEXT); } catch (e: any) { parseMessage = String(e?.message); }
      assertTrue(parseMessage.includes(LEAK), `setup: JSON.parse's message quotes the stored text (got: ${parseMessage})`);

      const before = errorLog.length;
      const info = knowledgeService.getAgentInfo(BAD_JSON_PRODUCTS);
      const logged = logSince(before);
      assertTrue(!!info && info.knowledge.products.length === 0 && info.knowledge.phone === "91234567"
        && info.knowledge.specialties[0] === "Lynghonning" && info.knowledge.openingHours.length === 1,
        "getAgentInfo: a products column that is not JSON is read as empty; the rest of the row is returned");
      assertEq(logged, `[knowledge-guard] agent ${BAD_JSON_PRODUCTS}: agent_knowledge.products is not valid JSON, read as empty`,
        "getAgentInfo: the bad column is logged as one [knowledge-guard] line with the agent id and the column");
      assertTrue(!logged.includes(LEAK) && !logged.includes("kari.kjoper"), "getAgentInfo: the log carries no stored value");
    }
    {
      const before = errorLog.length;
      const info = knowledgeService.getAgentInfo(MANY_BAD_COLUMNS)!;
      const logged = logSince(before);
      const k = info.knowledge;
      assertTrue([k.openingHours, k.specialties, k.certifications, k.paymentMethods, k.deliveryOptions, k.images, k.seasonality, info.meta.autoSources]
        .every((v) => Array.isArray(v) && v.length === 0),
        "getAgentInfo: every list column that is not JSON is read as empty");
      assertTrue((k.products[0] as any)?.name === "Poteter" && k.email === `${MANY_BAD_COLUMNS}@example.no` && k.address === "Osloveien 1",
        "getAgentInfo: the readable columns of the same row are returned");
      assertEq(info.agent.languages, ["no"], "getAgentInfo: agents.languages that is not JSON falls back to [\"no\"]");
      assertEq(KNOWN_COLUMNS.filter((c) => !logged.includes(`agent ${MANY_BAD_COLUMNS}: agent_knowledge.${c} is not valid JSON`)), [],
        "getAgentInfo: each bad knowledge column is logged by name");
      assertTrue(logged.includes(`agent ${MANY_BAD_COLUMNS}: agents.languages is not valid JSON`), "getAgentInfo: the bad agents.languages is logged by name");
      assertTrue(!logged.includes(LEAK), "getAgentInfo: none of those log lines carries a stored value");

      const raw = knowledgeService.getKnowledge(MANY_BAD_COLUMNS)!;
      assertEq([raw.preferences, raw.curatedFields, raw.externalReviews, raw.externalLinks], [{}, {}, [], []],
        "getKnowledge: the same columns are read as their empty value, not thrown (llms-full.txt, agent.json)");
    }

    // ══════════════════════════════════════════════════════════════
    // The write path reads strictly — no data repair
    // ══════════════════════════════════════════════════════════════
    {
      let threw = "";
      try { knowledgeService.upsertKnowledge(WRITE_STRICT, { about: "Ny tekst" }); } catch (e: any) { threw = String(e?.name); }
      const row = db.prepare("SELECT products, about FROM agent_knowledge WHERE agent_id = ?").get(WRITE_STRICT) as any;
      assertEq(threw, "SyntaxError", "upsertKnowledge: a row whose column is not JSON still fails the write, as before");
      assertEq([row.products, row.about], [BAD_PRODUCTS_TEXT, "Gammel tekst"],
        "upsertKnowledge: the stored text is left as it was (a lenient merge base would have written [] over it)");
    }
    {
      knowledgeService.upsertKnowledge(MERGE_SOURCES, { autoSources: ["website"], preferences: { lang: "no" } });
      const row = db.prepare("SELECT auto_sources, preferences FROM agent_knowledge WHERE agent_id = ?").get(MERGE_SOURCES) as any;
      assertEq(JSON.parse(row.auto_sources), ["google_maps", "website"],
        "upsertKnowledge: autoSources stored as one string merges as one source (it used to become one per letter)");
      assertEq(JSON.parse(row.preferences), { lang: "no" },
        "upsertKnowledge: preferences stored as a string is not spread into one key per character");
      knowledgeService.upsertKnowledge(MERGE_SOURCES, { autoSources: ["google_maps", "rekonorge.no"] });
      assertEq(JSON.parse((db.prepare("SELECT auto_sources FROM agent_knowledge WHERE agent_id = ?").get(MERGE_SOURCES) as any).auto_sources),
        ["google_maps", "website", "rekonorge.no"], "upsertKnowledge: a list of sources merges as before");
    }

    // ══════════════════════════════════════════════════════════════
    // MCP: lokal_info and lokal_search deliver the rest of the answer
    // ══════════════════════════════════════════════════════════════
    const mcp = require("../routes/mcp") as typeof import("../routes/mcp");
    const { registerTools, formatProductsForMcp, knowledgeRowOrSkip, MCP_INTERNAL_ERROR_TEXT } = mcp;
    const tools = new Map<string, CapturedTool>();
    registerTools({
      registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
    const info = tools.get("lokal_info")!;
    const search = tools.get("lokal_search")!;
    const discover = tools.get("lokal_discover")!;
    const blockOf = (t: string, name: string) => t.split("\n\n").find((b) => new RegExp(`^\\*\\*\\d+\\. ${name}`).test(b)) ?? "";
    const leaksJsError = (t: string) => /is not a function|Cannot read propert|Unexpected token|SyntaxError|TypeError|in JSON|object Object/i.test(t);

    {
      const r = await info.handler({ agentId: NUMERIC_PRICE });
      const t = textOf(r);
      assertTrue(r?.isError !== true && t.startsWith("# Kaldvik Bigård Fixture"),
        `lokal_info: a producer with a numeric price gets its profile (got: ${t.slice(0, 160)})`);
      assertTrue(t.includes("## Produkter (4 stk)\n- Lynghonning [honey] — 150\n- Løvetannhonning [honey] — 120/glass\n- Sommerhonning [honey] — kr 99\n- Bivoks\n\n**HONNING**"),
        `lokal_info: the numeric price is shown; an object category and an object price under a header are left out (got: ${(t.match(/## Produkter[\s\S]*?\*\*HONNING\*\*/) || [""])[0]})`);
      assertTrue(t.includes("\n## Sertifiseringer\n- Nyt Norge\n") && !t.includes("Hevder økologisk") && t.includes("\n## Åpningstider\nLør 10:00–14:00"),
        "lokal_info: certifications with non-text entries and opening hours with null entries are shown");
      assertTrue(!leaksJsError(t), "lokal_info: no JavaScript error text and no [object Object]");
    }
    {
      const before = errorLog.length;
      const r = await info.handler({ agentId: BAD_JSON_PRODUCTS });
      const t = textOf(r);
      assertTrue(r?.isError !== true && t.startsWith("# Lade Honning Fixture") && t !== MCP_INTERNAL_ERROR_TEXT,
        `lokal_info: a producer whose products are not JSON gets its profile, not the generic error (got: ${t.slice(0, 160)})`);
      assertTrue(t.includes("📞 91234567") && t.includes("\n## Åpningstider\nFre 12:00–18:00") && t.includes("\n## Spesialiteter\n- Lynghonning") && !t.includes("## Produkter"),
        "lokal_info: …with contact, opening hours and specialties, and without the unreadable products");
      const logged = logSince(before);
      assertTrue(logged.includes(`[knowledge-guard] agent ${BAD_JSON_PRODUCTS}: agent_knowledge.products is not valid JSON`) && !logged.includes("[mcp] lokal_info failed"),
        "lokal_info: the bad column is logged as [knowledge-guard], and the tool did not fail");
      assertTrue(!logged.includes(LEAK), "lokal_info: the log carries no stored value");
    }
    {
      const t = textOf(await info.handler({ agentId: MANY_BAD_COLUMNS }));
      assertTrue(t.startsWith("# Alna Grønt Fixture") && t.includes("## Produkter (1 stk)\n- Poteter [vegetables] — 30") && !t.includes("Åpningstider") && !leaksJsError(t),
        `lokal_info: a row with every other JSON column broken still gives the profile and the products (got: ${t.slice(0, 200)})`);
    }

    const query = "honning nær Trondheim";
    const honeyIds = [NUMERIC_PRICE, BAD_JSON_PRODUCTS, WELL_FORMED, THROWS];
    {
      const before = errorLog.length;
      const r = await search.handler({ query, limit: 10 });
      const t = textOf(r);
      const headings = [...t.matchAll(/^\*\*\d+\. (.+?)(?: — .*)?\*\*$/gm)].map((m) => m[1]);
      assertTrue(r?.isError !== true && honeyIds.length === headings.length,
        `lokal_search: «${query}» returns all four producers, the one with unreadable products included (got ${headings.length}: ${t.slice(0, 200)})`);
      assertTrue(blockOf(t, "Kaldvik Bigård Fixture").includes("🛒 Lynghonning (150), Løvetannhonning (120/glass), Sommerhonning (kr 99), Bivoks"),
        `lokal_search: the numeric price is in the product summary (got: ${blockOf(t, "Kaldvik Bigård Fixture")})`);
      assertTrue(headings.includes("Kaldvik Bigård Fixture") && !blockOf(t, "Kaldvik Bigård Fixture").includes("Kategoritreff"),
        "lokal_search: a product with a numeric name no longer hides the producer's real product matches (it was a category match)");
      const meta: import("./marketplace-registry").DiscoverMeta = {};
      const parsed = marketplaceRegistry.parseNaturalQuery(query);
      await mcp.enrichParsedWithGeo(parsed, query);
      marketplaceRegistry.discover({ ...parsed, limit: 10, offset: 0 }, meta);
      assertEq(meta.productMatches?.get(NUMERIC_PRICE), ["Lynghonning", "Løvetannhonning", "Sommerhonning – kr 99", "🍯 HONNING", "Kremhonning"],
        "discover(): the text names match; the numeric name, null and a number are skipped");
      const lade = blockOf(t, "Lade Honning Fixture");
      assertTrue(lade.includes("📞 91234567") && !lade.includes("🛒"),
        `lokal_search: the producer with unreadable products keeps its contact line and has no product summary (got: ${lade})`);
      assertTrue(blockOf(t, "Byåsen Birøkt Fixture").includes("🛒 Lynghonning (150/glass), Bivoks"), "lokal_search: a well-formed producer is unchanged");
      assertTrue(!leaksJsError(t) && !logSince(before).includes(LEAK), "lokal_search: no JavaScript error text in the answer and no stored value in the log");
    }

    // ══════════════════════════════════════════════════════════════
    // Per-row isolation: an error the type guards do not cover
    // ══════════════════════════════════════════════════════════════
    {
      const skipLine = `[knowledge-guard] lokal_search: knowledge of agent ${THROWS} skipped (TypeError at `;
      const before = errorLog.length;
      failInfoFor(THROWS);
      const r = await search.handler({ query, limit: 10 }).finally(() => failInfoFor(null));
      const t = textOf(r);
      const ranheim = blockOf(t, "Ranheim Honning Fixture");
      assertTrue(r?.isError !== true && t !== MCP_INTERNAL_ERROR_TEXT && (t.match(/^\*\*\d+\. /gm) || []).length === 4,
        `lokal_search: one row whose knowledge throws does not fail the answer; all four producers are listed (got: ${t.slice(0, 200)})`);
      assertTrue(ranheim.includes("Beskrivelse av Ranheim Honning Fixture") && ranheim.includes("/produsent/ranheim-honning-fixture") && !ranheim.includes("📞") && !ranheim.includes("🛒"),
        `lokal_search: that producer is listed without its knowledge (contact, products) (got: ${ranheim})`);
      assertTrue(blockOf(t, "Kaldvik Bigård Fixture").includes("📞 91234567") && blockOf(t, "Byåsen Birøkt Fixture").includes("🛒 Lynghonning (150/glass)"),
        "lokal_search: the other rows keep their knowledge");
      const logged = logSince(before);
      assertTrue(logged.split("\n").filter((l) => l.startsWith(skipLine)).length === 1,
        `lokal_search: the skipped row is logged once as [knowledge-guard] with the tool, the agent id and the error class and site (got: ${logged})`);
      assertTrue(!logged.includes(LEAK), "lokal_search: the log carries neither the error message nor a line of it that looks like a stack frame");
    }
    {
      failInfoFor(THROWS);
      const before = errorLog.length;
      const r = await discover.handler({ categories: ["honey"], lat: 63.4305, lng: 10.3951, maxDistanceKm: 30, limit: 10 }).finally(() => failInfoFor(null));
      const t = textOf(r);
      assertTrue(r?.isError !== true && (t.match(/^\*\*\d+\. /gm) || []).length === 4 && !blockOf(t, "Ranheim Honning Fixture").includes("📞")
        && blockOf(t, "Kaldvik Bigård Fixture").includes("📞 91234567"),
        `lokal_discover: the same row isolation (got: ${t.slice(0, 200)})`);
      assertTrue(logSince(before).includes(`[knowledge-guard] lokal_discover: knowledge of agent ${THROWS} skipped (TypeError`),
        "lokal_discover: the skipped row is logged under its own tool name");
    }
    {
      // A name search gives the detailed view, which reads the row again for the full product list.
      const name = "Ranheim Honning Fixture";
      const plain = textOf(await search.handler({ query: name, limit: 10 }));
      assertTrue(plain.includes(`**1. ${name}**`) && plain.includes("## Produkter (1 stk)\n- Skogshonning [honey] — 140"),
        `lokal_search detailed view setup: a name search lists the full products (got: ${plain.slice(0, 300)})`);
      failInfoFor(THROWS);
      const before = errorLog.length;
      const r = await search.handler({ query: name, limit: 10 }).finally(() => failInfoFor(null));
      const t = textOf(r);
      assertTrue(r?.isError !== true && t.includes(`**1. ${name}**`) && t.includes("🔗 [Se fullstendig profil]") && !t.includes("## Produkter") && !t.includes("📞"),
        `lokal_search detailed view: a row whose knowledge throws is listed without it (got: ${t.slice(0, 300)})`);
      assertEq(logSince(before).split("\n").filter((l) => l.startsWith(`[knowledge-guard] lokal_search: knowledge of agent ${THROWS} skipped`)).length, 2,
        "lokal_search detailed view: the summary and the details each log their skip");
    }

    // ══════════════════════════════════════════════════════════════
    // knowledgeRowOrSkip and formatProductsForMcp directly
    // ══════════════════════════════════════════════════════════════
    {
      assertEq(knowledgeRowOrSkip("probe", "a-1", "skipped", () => "read"), "read", "knowledgeRowOrSkip: a value is returned as it is");
      const before = errorLog.length;
      assertEq(knowledgeRowOrSkip("probe", "a-2", "skipped", () => { throw `${LEAK} thrown text`; }), "skipped",
        "knowledgeRowOrSkip: a thrown non-Error gives the skipped value");
      assertEq(logSince(before), "[knowledge-guard] probe: knowledge of agent a-2 skipped (string)",
        "knowledgeRowOrSkip: a thrown non-Error is logged by its type, not its value");
      const e = new RangeError(`${LEAK} one\n    at ${LEAK} two`);
      e.stack = `RangeError: ${LEAK} one\n    at ${LEAK} two\n    at realFrame (/app/x.js:1:2)`;
      const mark = errorLog.length;
      knowledgeRowOrSkip("probe", "a-3", null, () => { throw e; });
      assertEq(logSince(mark), "[knowledge-guard] probe: knowledge of agent a-3 skipped (RangeError at realFrame (/app/x.js:1:2))",
        "knowledgeRowOrSkip: the site is the first frame after the message, also when the message spans lines");
      const odd = new Error(`${LEAK} message`);
      odd.stack = `something else\n    at ${LEAK}`;
      const mark2 = errorLog.length;
      knowledgeRowOrSkip("probe", "a-4", null, () => { throw odd; });
      assertEq(logSince(mark2), "[knowledge-guard] probe: knowledge of agent a-4 skipped (Error)",
        "knowledgeRowOrSkip: a stack that does not start with the message gives the class only");
    }
    assertEq(formatProductsForMcp([{ name: "🐑 LAM", price: "Bestill før fredag" }, { name: "Lammelår", category: "meat", price: "275/kg" }]),
      "\n## Produkter (1 stk)\n\n**Bestill før fredag**\n_Bestill før fredag_\n- Lammelår [meat] — 275/kg",
      "formatProductsForMcp: text price under a header and a text category render as before");
    assertEq(formatProductsForMcp([{ name: "🐑 LAM", price: ["x"] }, { name: "Lammelår", category: 7, price: 275 }]),
      "\n## Produkter (1 stk)\n\n**LAM**\n- Lammelår — 275",
      "formatProductsForMcp: a list price under a header and a numeric category are left out, a numeric price is shown");
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
  runKnowledgeServiceTypeGuardsTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
