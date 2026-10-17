/**
 * knowledge-remaining-readers.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-G (FUNN
 * rfb-knowledge-lesere-utenfor-i-f, found during I-F / lokal#1110).
 *
 * I-F gave getAgentInfo a fixed shape per field, but some readers of the
 * agent_knowledge JSON columns outside knowledge-service.ts still called
 * .map / .slice / .trim / .toLowerCase on a field without checking its type:
 *   - the A2A seller auto-reply (conversation-service.ts) threw on
 *     openingHours stored as text (`k.openingHours.slice(...).map`) and on a
 *     product category that is not text (`(p.category || "").toLowerCase`);
 *   - GET /agents/:id/agent.json threw on products stored as text
 *     (`knowledge.products?.map`) and on a null product;
 *   - GET /ut/:agentId/external:<type> answered 500 instead of 404 when
 *     external_links was stored as text or held a null entry or a non-text type;
 *   - the vCard threw on a product whose name is empty and whose `product`
 *     field is not text, and showed a non-text price as "(true)";
 *   - the daily catalog sync (runProductCatalogSync) failed for every agent
 *     when one product entry was null, had a non-text name, a negative,
 *     boolean or object price, or an object category;
 *   - the knowledge write path (PUT /agents/:id/knowledge → normalizeProducts)
 *     threw a JavaScript TypeError on products stored as text or a product
 *     whose name is not text, and the route answered 400 with that raw text.
 * Now each reader takes the field in getAgentInfo's fixed shape or checks the
 * type itself, and the write path answers 400 with a field-level error before
 * anything is written. Well-formed data gives the same output as before; the
 * goldens below were taken from main before the change.
 *
 * Real production schema in an in-memory DB, real routers through
 * router.handle() (no HTTP server), same harness as I-F's
 * knowledge-service-type-guards.test.ts.
 *
 * Exported runKnowledgeRemainingReadersTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/services/knowledge-remaining-readers.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  headers: Record<string, string>;
  redirectedTo?: string;
}

/** Drives one request through an express Router directly — no HTTP server. */
function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const sent: Record<string, string> = {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader(name: string, value: string) { sent[name.toLowerCase()] = value; return this; },
      header(name: string, value: string) { sent[name.toLowerCase()] = value; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload, headers: sent }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload, headers: sent }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined, headers: sent }); return this; },
      redirect(codeOrUrl: number | string, maybeUrl?: string) {
        const code = typeof codeOrUrl === "number" ? codeOrUrl : 302;
        const url = typeof codeOrUrl === "string" ? codeOrUrl : maybeUrl!;
        resolve({ status: code, body: undefined, headers: sent, redirectedTo: url });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined, headers: sent });
    });
  });
}

// Store producers (agentCardService) need UUIDs; the agents rows use the same ids.
const WELL_FORMED = "1a6a0000-0000-4000-8000-000000000001";
const HOURS_TEXT = "1a6a0000-0000-4000-8000-000000000002";
const PRODUCTS_TEXT = "1a6a0000-0000-4000-8000-000000000003";
const PRODUCTS_ODD = "1a6a0000-0000-4000-8000-000000000004";
const WRITE_TARGET = "1a6a0000-0000-4000-8000-000000000005";
const BULK_OK = "1a6a0000-0000-4000-8000-000000000006";

// A value no log line or error text may carry (stored values can hold contact details).
const LEAK = "LEAKMARKER";

const WELL_FORMED_PRODUCTS = [
  { name: "🐑 LAM", category: "meat", seasonal: false },
  { name: "Lammelår – kr 275/kg", category: "meat", seasonal: true, months: [9, 10] },
  { name: "Lammeskank", category: "meat", seasonal: false, price: "189/kg", priceUnit: "kr" },
  { name: "Honning", category: "honey", seasonal: false, price: "150", organic: true },
  { name: "❌ Tomt for egg", category: "eggs", seasonal: false },
  { name: "Poteter", category: "other", seasonal: false, price: "Spør om pris" },
];

interface Seed {
  id: string;
  name: string;
  city: string;
  knowledge: Record<string, string | number>;
}

const SEED: Seed[] = [
  {
    id: WELL_FORMED, name: "Byneset Gård Fixture", city: "Trondheim",
    knowledge: {
      website: "https://bynesetgard.example.no",
      products: JSON.stringify(WELL_FORMED_PRODUCTS),
      opening_hours: JSON.stringify([
        { day: "mon", open: "10:00", close: "17:00" },
        { day: "saturday", open: "10:00", close: "14:00", note: "Kun i sesong" },
        { day: "Lørdag i sesong", open: "11:00", close: "15:00" },
      ]),
      specialties: JSON.stringify(["Lam", "Honning"]),
      certifications: JSON.stringify(["Nyt Norge"]),
      payment_methods: JSON.stringify(["Vipps", "Kontant"]),
      delivery_options: JSON.stringify(["Henting på gården"]),
      delivery_radius: 20,
      min_order_value: 300,
      images: JSON.stringify(["https://bynesetgard.example.no/lam.jpg"]),
      seasonality: JSON.stringify([{ product: "Lam", months: [9, 10] }]),
      external_links: JSON.stringify([
        { label: "Facebook", url: "https://www.facebook.com/bynesetgard", type: "facebook" },
        { label: "Neste marked", url: "https://bynesetgard.example.no/marked", type: "schedule" },
      ]),
    },
  },
  {
    // The Hevd case from the integration test: opening hours stored as text.
    id: HOURS_TEXT, name: "Hevd Bakeri Fixture", city: "Trondheim",
    knowledge: {
      opening_hours: JSON.stringify("Man–fre 07–17, lør 08–15"),
      products: JSON.stringify([
        { name: "Surdeigsbrød", category: { kind: "bread" }, price: 65 },
        { name: "Kanelbolle", category: 7, price: "35" },
        { name: "Honning", category: "honey" },
      ]),
    },
  },
  {
    id: PRODUCTS_TEXT, name: "Skjetlein Fixture", city: "Trondheim",
    knowledge: {
      products: JSON.stringify(`Honning, egg og poteter ${LEAK}`),
      external_links: JSON.stringify("https://www.facebook.com/skjetlein"),
      opening_hours: JSON.stringify([{ day: "mon", open: "10:00" }, null, 5, "  Etter avtale  "]),
    },
  },
  {
    id: PRODUCTS_ODD, name: "Ranheim Fixture", city: "Trondheim",
    knowledge: {
      products: JSON.stringify([
        null,
        7,
        "Kremhonning",
        { name: 2024, price: 50 },
        { name: "Lynghonning", category: "honey", price: true },
        { name: "", product: 5 },
        { name: "Bivoks", price: { from: 100 } },
        { category: "honey", price: "100" },
        { name: "Skogshonning", category: { kind: "honey" }, price: -5 },
      ]),
      external_links: JSON.stringify([
        null,
        { type: 5, url: "https://five.example.no" },
        { type: "Facebook", url: "https://www.facebook.com/ranheim" },
        { type: "instagram", url: 42 },
      ]),
    },
  },
  {
    id: WRITE_TARGET, name: "Leinstrand Fixture", city: "Trondheim",
    knowledge: { products: JSON.stringify([{ name: "Gulrøtter", category: "vegetables", price: "30 kr" }]) },
  },
  {
    id: BULK_OK, name: "Klett Fixture", city: "Trondheim",
    knowledge: { about: "Gammel tekst" },
  },
];

function seed(db: Database.Database): void {
  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?,
            63.43, 10.39, ?, '["meat"]', '[]', '[]', '{}', '["no"]',
            0.5, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const s of SEED) {
    agentStmt.run(s.id, s.name, `Beskrivelse av ${s.name}`, `${s.id}@example.no`, `https://${s.id}.example.no`,
      `key-${s.id}`, s.city);
    const cols = ["agent_id", "address", "postal_code", "phone", "email", ...Object.keys(s.knowledge)];
    const vals = [s.id, "Bynesvegen 1", "7070", "91234567", `post@${s.id}.example.no`, ...Object.values(s.knowledge)];
    db.prepare(`INSERT INTO agent_knowledge (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }
}

/** The legacy store producer agentCardService.generateCard needs for GET /agents/:id/agent.json. */
function storeProducer(id: string, name: string): any {
  const now = new Date().toISOString();
  return {
    id, name, description: "", type: "farm",
    location: { lat: 63.43, lng: 10.39, city: "Trondheim" },
    openingHours: [], tags: [], certifications: [], deliveryOptions: ["pickup"],
    trustScore: 0.5, totalTransactions: 0, availabilityAccuracy: 0.5,
    registeredAt: now, lastActiveAt: now, isActive: true,
  };
}

export async function runKnowledgeRemainingReadersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  /** Runs one section; an unexpected error fails that section only, so every regression is reported. */
  async function section(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      failed++;
      failures.push(`✗ ${name}: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
  }
  /** Runs fn; a throw is a failed assertion with its message, never an aborted suite. */
  function noThrow<T>(fn: () => T, label: string): T | undefined {
    try {
      const out = fn();
      assertTrue(true, label);
      return out;
    } catch (err) {
      assertTrue(false, `${label} (threw: ${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
  }

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const adminKey = "knowledge-remaining-readers-test-key";
  process.env.ADMIN_KEY = adminKey;
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seed(db);

  // The vCard reads the vertical config (its CATEGORIES line).
  const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
  try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
  const { store } = require("./store") as typeof import("./store");
  for (const s of SEED) store.addProducer(storeProducer(s.id, s.name));

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry / interaction chatter */ };
  const prevError = console.error;
  const errorLog: string[] = [];
  console.error = (...args: unknown[]) => { errorLog.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" ")); };

  try {
    const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
    marketplaceRegistry._agentsCache = null;
    const { conversationService } = require("./conversation-service") as typeof import("./conversation-service");
    const cs = require("./conversation-service") as typeof import("./conversation-service");
    const ks = require("./knowledge-service") as typeof import("./knowledge-service");
    const { knowledgeService } = ks;

    // ══════════════════════════════════════════════════════════════
    // A2A seller auto-reply (conversation-service.ts)
    // ══════════════════════════════════════════════════════════════
    await section("auto-reply: well-formed data", async () => {
      const reply = noThrow(() => conversationService.generateSellerResponse(WELL_FORMED), "auto-reply: well-formed, no query");
      assertEq(reply?.text, [
        "Hei fra Byneset Gård Fixture! 👋",
        "Her er det vi tilbyr (4 produkter):",
        "",
        "**LAM**",
        "• Lammelår — kr 275/kg",
        "• Lammeskank — 189/kg",
        "• Honning — 150",
        "• Poteter",
        "",
        "Spesialiteter: Lam, Honning",
        "",
        "🕐 Åpningstider: Man 10:00–17:00, Lør 10:00–14:00, Lørdag i sesong 11:00–15:00",
        "",
        "Kontakt oss:",
        "📍 Bynesvegen 1, 7070 Trondheim",
        "📞 91234567",
        `✉️ post@${WELL_FORMED}.example.no`,
        "🌐 https://bynesetgard.example.no",
        "🚚 Levering: Henting på gården (inntil 20 km) — min. bestilling 300 kr",
        "💳 Betaling: Vipps, Kontant",
        "✅ Nyt Norge",
        "",
        "🔗 Se profilen vår: https://rettfrabonden.com/produsent/byneset-gard-fixture",
        "",
        "Ta gjerne kontakt for spørsmål eller bestilling!",
      ].join("\n"), "auto-reply: well-formed data gives the same text as before (golden from main)");
      assertEq(reply?.type, "offer", "auto-reply: well-formed products make an offer, as before");

      const matched = noThrow(() => conversationService.generateSellerResponse(WELL_FORMED, "honning og lam"),
        "auto-reply: well-formed, with a query");
      assertEq(matched?.text.split("\n").slice(0, 4), [
        "Hei fra Byneset Gård Fixture! 👋",
        "Vi har det du leter etter:",
        "• Lammelår — kr 275/kg",
        "• Lammeskank — 189/kg",
      ], "auto-reply: a query lists the matching products as before (golden from main)");
      assertEq(matched?.metadata.products.map((p: any) => p.name),
        ["Lammelår – kr 275/kg", "Lammeskank", "Honning"],
        "auto-reply: the matched products in the metadata are the same as before (golden from main)");
    });
    await section("auto-reply: openingHours as text, non-text category", async () => {
      // Repro: «k.openingHours.slice(...).map is not a function».
      const reply = noThrow(() => conversationService.generateSellerResponse(HOURS_TEXT),
        "auto-reply: openingHours stored as text no longer throws (repro of the FUNN)");
      assertTrue(!!reply?.text.includes("\n🕐 Åpningstider: Man–fre 07–17, lør 08–15\n"),
        "auto-reply: openingHours stored as text is shown as text");
      // Repro (I-F review S2): «(p.category || "").toLowerCase is not a function».
      const matched = noThrow(() => conversationService.generateSellerResponse(HOURS_TEXT, "surdeigsbrød og honning"),
        "auto-reply: a query over products with an object or number category no longer throws (I-F review S2)");
      assertEq(matched?.metadata.products.map((p: any) => p.name), ["Surdeigsbrød", "Honning"],
        "auto-reply: products still match by name; a category that is not text matches nothing");
      assertTrue(!!matched?.text.includes("• Surdeigsbrød — 65"), "auto-reply: a numeric price is shown (I-F productPriceText)");
      const byCategory = noThrow(() => conversationService.generateSellerResponse(HOURS_TEXT, "honey"),
        "auto-reply: a query matching a text category, next to non-text categories");
      assertEq(byCategory?.metadata.products.map((p: any) => p.name), ["Honning"],
        "auto-reply: a text category still matches as before");
    });
    await section("auto-reply: products as text, odd entries", async () => {
      const reply = noThrow(() => conversationService.generateSellerResponse(PRODUCTS_TEXT),
        "auto-reply: products stored as text and odd opening-hour entries");
      assertTrue(!!reply && !reply.text.includes("undefined"), "auto-reply: no «undefined» in the text");
      assertTrue(!!reply?.text.includes("\n🕐 Åpningstider: Etter avtale\n"),
        "auto-reply: an opening-hours entry without open/close, null and a number are left out; a text entry is shown");
      assertEq(reply?.type, "text", "auto-reply: no products → a plain text reply");
      assertTrue(!!reply && !reply.text.includes(LEAK), "auto-reply: products stored as one text are not listed");

      const odd = noThrow(() => conversationService.generateSellerResponse(PRODUCTS_ODD, "honning bivoks"),
        "auto-reply: null, numbers and nameless entries among the products");
      assertEq(odd?.metadata.products.map((p: any) => p.name), ["Lynghonning", "Bivoks", "Skogshonning"],
        "auto-reply: only products with a text name are listed");
      assertTrue(!!odd && !odd.text.includes("true") && !odd.text.includes("[object Object]") && !odd.text.includes("-5"),
        "auto-reply: a boolean, object or negative price is no price");
    });
    await section("openingHoursReplyText", async () => {
      const t = cs.openingHoursReplyText;
      assertEq(t([{ day: "mon", open: "10:00", close: "17:00" }, { day: "sunday", open: "12:00", close: "16:00" }]),
        "Man 10:00–17:00, Søn 12:00–16:00", "openingHoursReplyText: short and long day keys, as before");
      // Slice I-H: "Lørdag" is a Norwegian day name (utils/opening-hours.ts), so
      // it gets the short label like "saturday" does; a label that names no
      // weekday is still shown as written.
      assertEq(t([{ day: "Lørdag", open: "10:00", close: "14:00" }, { open: "09:00", close: "15:00" }, { day: "Lørdag i sesong", open: "11:00", close: "15:00" }]),
        "Lør 10:00–14:00, 09:00–15:00, Lørdag i sesong 11:00–15:00",
        "openingHoursReplyText: a Norwegian day name is a day (I-H); an unknown label is shown as written; no day gives just the times");
      assertEq(t("  Man–fre 10–17  "), "Man–fre 10–17", "openingHoursReplyText: text is shown trimmed");
      assertEq([t(""), t("   "), t([]), t(null), t(undefined), t(42), t({ mon: "10-17" }), t([null, 3, {}, "  ", { day: "mon" }])],
        ["", "", "", "", "", "", "", ""], "openingHoursReplyText: nothing usable gives no text");
      assertEq(t([{ day: "constructor", open: "10:00", close: "12:00" }]), "constructor 10:00–12:00",
        "openingHoursReplyText: a day key that names an Object.prototype member is shown as written");
      const nine = Array.from({ length: 9 }, (_, i) => ({ day: "mon", open: `0${i}:00`, close: "17:00" }));
      assertEq(t([null, ...nine]).split(", ").length, 7, "openingHoursReplyText: at most 7 entries, as before; unusable ones do not take a slot");
    });
    await section("startConversation", async () => {
      // End to end: a buyer starts a conversation with the producer whose hours are text.
      const conv = noThrow(() => conversationService.startConversation({ sellerAgentId: HOURS_TEXT, queryText: "brød", source: "a2a" }),
        "startConversation: the seller auto-reply no longer aborts the conversation");
      const sellerMsg = conv && db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND sender_role = 'seller'").get(conv.id) as
        { content: string } | undefined;
      assertTrue(!!sellerMsg?.content.includes("Man–fre 07–17"), "startConversation: the seller's auto-reply is stored");
    });

    // ══════════════════════════════════════════════════════════════
    // GET /agents/:id/agent.json x-knowledge (a2a.ts)
    // ══════════════════════════════════════════════════════════════
    await section("agent.json x-knowledge", async () => {
      const a2aRouter = (require("../routes/a2a") as typeof import("../routes/a2a")).default;
      const card = (id: string) => callRoute(a2aRouter, { url: `/agents/${id}/agent.json` });

      const wf = await card(WELL_FORMED);
      assertEq(wf.status, 200, "agent.json: well-formed knowledge → 200");
      assertEq(wf.body?.["x-knowledge"]?.products, [
        { name: "🐑 LAM", category: "meat", seasonal: false },
        { name: "Lammelår – kr 275/kg", category: "meat", seasonal: true, months: [9, 10] },
        { name: "Lammeskank", category: "meat", seasonal: false, price: "189/kg", priceUnit: "kr" },
        { name: "Honning", category: "honey", seasonal: false, organic: true, price: "150" },
        { name: "❌ Tomt for egg", category: "eggs", seasonal: false },
        { name: "Poteter", category: "other", seasonal: false, price: "Spør om pris" },
      ], "agent.json: well-formed products are the same as before (golden from main)");
      assertEq(Object.keys(wf.body?.["x-knowledge"] ?? {}), [
        "address", "postalCode", "phone", "email", "website", "openingHours", "products", "specialties", "certifications",
        "paymentMethods", "deliveryOptions", "deliveryRadius", "externalLinks", "seasonality", "dataSource",
      ], "agent.json: the x-knowledge keys are the same as before (golden from main)");

      // Repro: «knowledge.products?.map is not a function».
      const text = await card(PRODUCTS_TEXT);
      assertEq(text.status, 200, "agent.json: products stored as text → 200 (threw before)");
      assertEq(text.body?.["x-knowledge"]?.products, [], "agent.json: products stored as text gives no products");
      assertTrue(!JSON.stringify(text.body).includes(LEAK), "agent.json: the stored products text is not passed through");

      const odd = await card(PRODUCTS_ODD);
      assertEq(odd.status, 200, "agent.json: a null product among the products → 200 (threw before)");
      assertEq(odd.body?.["x-knowledge"]?.products, [
        {},
        { name: "Lynghonning", category: "honey", price: true },
        { name: "", },
        { name: "Bivoks", price: { from: 100 } },
        { name: "Skogshonning", category: { kind: "honey" }, price: -5 },
      ].map((p) => JSON.parse(JSON.stringify(p))),
        "agent.json: products in getAgentInfo's fixed shape — text entries and objects with a text name, mapped as before");
    });

    // ══════════════════════════════════════════════════════════════
    // GET /ut/:agentId/external:<type> (contact-tracking.ts)
    // ══════════════════════════════════════════════════════════════
    await section("/ut redirect", async () => {
      const { redirectRouter } = require("../routes/contact-tracking") as typeof import("../routes/contact-tracking");
      const go = (id: string, kind: string) => callRoute(redirectRouter, { url: `/${id}/${kind}` });

      const wf = await go(WELL_FORMED, "external:facebook");
      assertEq([wf.status, wf.redirectedTo], [302, "https://www.facebook.com/bynesetgard"],
        "/ut: a well-formed external link redirects as before");
      assertEq((await go(WELL_FORMED, "external:instagram")).status, 404, "/ut: no such link → 404, as before");

      const errorsBefore = errorLog.length;
      assertEq((await go(PRODUCTS_TEXT, "external:facebook")).status, 404,
        "/ut: external_links stored as text → 404, not 500 (threw `.find is not a function` before)");
      const odd = await go(PRODUCTS_ODD, "external:facebook");
      assertEq([odd.status, odd.redirectedTo], [302, "https://www.facebook.com/ranheim"],
        "/ut: a null entry and a non-text type are skipped; the type still matches case-insensitively, as before");
      assertEq((await go(PRODUCTS_ODD, "external:5")).status, 404, "/ut: a numeric type matches no kind → 404 (threw before)");
      assertEq((await go(PRODUCTS_ODD, "external:instagram")).status, 404, "/ut: a url that is not text → 404, as before");
      assertEq(errorLog.slice(errorsBefore).filter((l) => l.includes("/ut redirect error")), [],
        "/ut: no redirect error is logged for odd external_links");
    });

    // ══════════════════════════════════════════════════════════════
    // vCard (marketplace.ts buildVCard)
    // ══════════════════════════════════════════════════════════════
    delete require.cache[require.resolve("../routes/marketplace")];
    const marketplaceRouter = (require("../routes/marketplace") as typeof import("../routes/marketplace")).default;
    await section("vCard", async () => {
      const vcardNote = async (id: string) => {
        const r = await callRoute(marketplaceRouter, { url: `/agents/${id}/vcard` });
        const note = typeof r.body === "string" ? r.body.split("\r\n").concat(r.body.split("\n")).find((l: string) => l.startsWith("NOTE;")) : undefined;
        return { status: r.status, note };
      };
      assertEq(await vcardNote(WELL_FORMED), {
        status: 200,
        note: "NOTE;CHARSET=UTF-8:Produkter: 🐑 LAM\\, Lammelår – kr 275/kg [sesong]\\, Lammeskank (189/kg)\\, Honning (150)\\, ❌ Tomt for egg\\, Poteter (Spør om pris)",
      }, "vCard: well-formed products give the same NOTE as before (golden from main)");
      const odd = await vcardNote(PRODUCTS_ODD);
      assertEq(odd, {
        status: 200,
        note: "NOTE;CHARSET=UTF-8:Produkter: Kremhonning\\, Lynghonning\\, Bivoks\\, Skogshonning",
      }, "vCard: an empty name with a non-text `product` is skipped (threw before); a boolean, object or negative price is no price (I-F review S3)");
    });

    // ══════════════════════════════════════════════════════════════
    // Knowledge write path: PUT /agents/:id/knowledge → normalizeProducts
    // ══════════════════════════════════════════════════════════════
    await section("productsWriteError", async () => {
      const { productsWriteError, KnowledgeFieldError } = ks;
      const fe = (v: unknown) => {
        const e = productsWriteError(v);
        return e && { field: e.field, error: e.message, isFieldError: e instanceof KnowledgeFieldError };
      };
      assertEq(fe("Honning, egg"), { field: "products", error: "products må være en liste med produkter, ikke tekst.", isFieldError: true },
        "productsWriteError: products as text is a field error");
      assertEq(fe({ length: 2 }), { field: "products", error: "products må være en liste med produkter.", isFieldError: true },
        "productsWriteError: an object with a length is a field error (it reached `.map` too)");
      assertEq(fe([{ name: "Egg" }, null]), { field: "products[1]", error: "products[1] må være et produkt, ikke null.", isFieldError: true },
        "productsWriteError: a null product is a field error with its index");
      assertEq(fe([{ name: "Egg" }, { name: "Ost" }, { name: 2024 }]),
        { field: "products[2].name", error: "products[2].name må være tekst.", isFieldError: true },
        "productsWriteError: a product whose name is not text is a field error with its path");
      assertEq([[], "", undefined, null, 0, {}, true, [{ name: "Egg" }, "Honning", 7, { name: "" }, { name: null }, { name: 0 }, { category: "x" }, ["x"]]]
        .map((v) => fe(v)), [null, null, null, null, null, null, null, null],
        "productsWriteError: every value the write path accepted before is still accepted");
    });

    await section("PUT /agents/:id/knowledge and bulkEnrich", async () => {
      const auth = { admin: { "x-admin-key": adminKey }, owner: { "x-api-key": `key-${WRITE_TARGET}` } };
      const put = (body: any, headers: Record<string, string> = auth.admin) =>
        callRoute(marketplaceRouter, { method: "PUT", url: `/agents/${WRITE_TARGET}/knowledge`, headers, body });
      const stored = () => db.prepare("SELECT products, about, updated_at FROM agent_knowledge WHERE agent_id = ?").get(WRITE_TARGET);
      const version = () => (db.prepare("SELECT agent_version FROM agents WHERE id = ?").get(WRITE_TARGET) as any).agent_version;

      const before = stored();
      const versionBefore = version();
      let r = await put({ products: `Gulrøtter, poteter ${LEAK}`, about: "Ny tekst" });
      assertEq([r.status, r.body], [400, { success: false, error: "products må være en liste med produkter, ikke tekst.", field: "products" }],
        "PUT knowledge: products as text → 400 with a field error (was 400 with «data.products.map is not a function»-style text)");
      r = await put({ products: [{ name: "Gulrøtter" }, { name: 2024, price: "30" }] });
      assertEq([r.status, r.body], [400, { success: false, error: "products[1].name må være tekst.", field: "products[1].name" }],
        "PUT knowledge: a product whose name is not text → 400 with its path");
      r = await put({ products: [null] }, auth.owner);
      assertEq([r.status, r.body], [400, { success: false, error: "products[0] må være et produkt, ikke null.", field: "products[0]" }],
        "PUT knowledge: the owner lane (X-API-Key) gets the same field error");
      assertEq([stored(), version()], [before, versionBefore],
        "PUT knowledge: a refused write leaves the row and agent_version untouched — nothing else in the body is written");

      r = await put({
        products: [
          { name: "Lammelår – kr 275/kg", category: "meat", seasonal: false },
          { name: "Egg", category: "eggs", seasonal: false, price: "kr 55" },
          { name: "🐑 LAM", category: "meat", seasonal: false },
          { name: "Honning kr 120", category: "honey", seasonal: false, price: "Bestill før fredag" },
          "Poteter",
          7,
          { name: "", category: "other" },
        ],
      });
      assertEq(r.status, 200, "PUT knowledge: a well-formed write still succeeds");
      assertEq((stored() as any).products, JSON.stringify([
        { name: "Lammelår", category: "meat", seasonal: false, price: "kr 275/kg", priceUnit: "kr" },
        { name: "Egg", category: "eggs", seasonal: false, price: "kr 55" },
        { name: "🐑 LAM", category: "meat", seasonal: false },
        { name: "Honning", category: "honey", seasonal: false, price: "kr 120", priceUnit: "kr" },
        "Poteter",
        7,
        { name: "", category: "other" },
      ]), "PUT knowledge: the stored products are byte-identical to what main stored (golden from main)");
      assertEq(version(), versionBefore + 1, "PUT knowledge: a successful write bumps agent_version, as before");

      // bulkEnrich: one bad entry is refused with the field error, the rest is written.
      const errorsBefore = errorLog.length;
      const count = noThrow(() => knowledgeService.bulkEnrich([
        { agentId: WRITE_TARGET, data: { products: `Gulrøtter ${LEAK}` as any } },
        { agentId: BULK_OK, data: { about: "Ny tekst fra berikelsen" } },
      ]), "bulkEnrich: a products field error does not abort the batch");
      assertEq(count, 1, "bulkEnrich: the valid entry is written, the refused one is not counted");
      assertEq((db.prepare("SELECT about FROM agent_knowledge WHERE agent_id = ?").get(BULK_OK) as any).about,
        "Ny tekst fra berikelsen", "bulkEnrich: the valid entry's data is stored");
      const bulkLog = errorLog.slice(errorsBefore).join("\n");
      assertTrue(bulkLog.includes("KnowledgeFieldError: products må være en liste med produkter, ikke tekst."),
        "bulkEnrich: the refused entry is logged with the field error, not a TypeError");
      assertTrue(!bulkLog.includes(LEAK), "bulkEnrich: the refused value is not logged");
    });

    // ══════════════════════════════════════════════════════════════
    // Daily catalog sync (product-catalog-sync.ts)
    // ══════════════════════════════════════════════════════════════
    await section("catalog sync", async () => {
      const { runProductCatalogSync } = require("./product-catalog-sync") as typeof import("./product-catalog-sync");
      const syncDb = (rows: Array<[string, unknown]>) => {
        const sdb = new Database(":memory:");
        sdb.pragma("journal_mode = DELETE");
        sdb.pragma("foreign_keys = ON");
        __initSchemaForTesting(sdb as any);
        for (const [id, products] of rows) {
          sdb.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city)
                       VALUES (?, ?, 'test', 'test', ?, 'https://example.no', 'producer', ?, 'Trondheim')`)
            .run(id, `Sync ${id}`, `${id}@example.no`, `key-${id}`);
          sdb.prepare("INSERT INTO agent_knowledge (agent_id, products) VALUES (?, ?)").run(id, JSON.stringify(products));
        }
        return sdb;
      };
      const catalog = (sdb: Database.Database) =>
        sdb.prepare("SELECT agent_id, name, name_norm, category, price_nok, availability, source FROM products ORDER BY agent_id, name_norm").all();

      const wf = syncDb([["sync-wf", WELL_FORMED_PRODUCTS]]);
      assertEq(runProductCatalogSync(wf), { success: true, agents_processed: 1, inserted: 4, updated: 0, skipped: 2 },
        "catalog sync: well-formed products give the same counts as before (golden from main)");
      assertEq(catalog(wf), [
        { agent_id: "sync-wf", name: "Honning", name_norm: "honning", category: "honey", price_nok: 150, availability: "in_stock", source: "enrichment" },
        { agent_id: "sync-wf", name: "Lammelår", name_norm: "lammelår", category: "meat", price_nok: 275, availability: "in_stock", source: "enrichment" },
        { agent_id: "sync-wf", name: "Lammeskank", name_norm: "lammeskank", category: "meat", price_nok: 189, availability: "in_stock", source: "enrichment" },
        { agent_id: "sync-wf", name: "Poteter", name_norm: "poteter", category: null, price_nok: null, availability: "in_stock", source: "enrichment" },
      ], "catalog sync: well-formed products give the same catalog rows as before (golden from main)");

      // Repro (I-F review FUNN rfb-catalog-sync-typesikkerhet): one odd entry failed the sync for every agent.
      const mixed = syncDb([
        ["sync-a-wf", WELL_FORMED_PRODUCTS],
        ["sync-b-odd", [
          null,
          { name: 2024, price: "50" },
          { name: "Lynghonning", category: { kind: "honey" }, price: true },
          { name: "Bivoks", category: true, price: { from: 100 } },
          { name: "Skogshonning", category: "honey", price: -5 },
          { name: "Kremhonning", category: "honey", price: "kr 120" },
          "Sommerhonning",
        ]],
      ]);
      const r = runProductCatalogSync(mixed);
      assertEq(r, { success: true, agents_processed: 2, inserted: 8, updated: 0, skipped: 5 },
        "catalog sync: odd entries are skipped one by one and the sync succeeds (failed for every agent before)");
      assertEq(catalog(mixed).filter((row: any) => row.agent_id === "sync-b-odd"), [
        { agent_id: "sync-b-odd", name: "Bivoks", name_norm: "bivoks", category: null, price_nok: null, availability: "in_stock", source: "enrichment" },
        { agent_id: "sync-b-odd", name: "Kremhonning", name_norm: "kremhonning", category: "honey", price_nok: 120, availability: "in_stock", source: "enrichment" },
        { agent_id: "sync-b-odd", name: "Lynghonning", name_norm: "lynghonning", category: null, price_nok: null, availability: "in_stock", source: "enrichment" },
        { agent_id: "sync-b-odd", name: "Skogshonning", name_norm: "skogshonning", category: "honey", price_nok: null, availability: "in_stock", source: "enrichment" },
      ], "catalog sync: a product with a text name is written; a non-text category or price is left empty");
      assertEq(catalog(mixed).filter((row: any) => row.agent_id === "sync-a-wf"),
        catalog(wf).map((row: any) => ({ ...row, agent_id: "sync-a-wf" })),
        "catalog sync: the well-formed agent next to the odd one gets exactly its own rows");
      wf.close();
      mixed.close();
    });
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevError;
    const producers = (store as unknown as { producers: Map<string, unknown> }).producers;
    for (const s of SEED) producers.delete(s.id);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    __setDbForTesting(prevDb as any);
    db.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runKnowledgeRemainingReadersTests({ log: true }).then((r) => {
    console.log(`\nknowledge-remaining-readers: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed === 0 ? 0 : 1);
  });
}
