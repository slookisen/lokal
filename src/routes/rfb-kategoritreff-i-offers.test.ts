/**
 * rfb-kategoritreff-i-offers.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-S2 (b): `category_matches`
 * in the offers.
 *
 * Since slice I-S findOffers leaves out a row that is only a category label
 * («Honning» at a bakery). The producer behind it is not dropped: when the
 * real offers leave free places on the page, the nearest label producers fill
 * them in the additive field `category_matches`:
 * - one entry per producer, {match:"category", category, orderable:false,
 *   note, producer}, with no product id, name, price, unit or availability;
 * - nearest first (ties by agent id), per producer the label first by name
 *   (nb), whatever order the rows are in; offers + category matches ≤ limit,
 *   never a producer that is already in `offers`; owner-set rows stay offers;
 * - left out when empty, so a response whose offers fill the page is
 *   {term, offers} as before; `offers` itself is unchanged;
 * - GET /api/marketplace/catalog/offers and lokal_find_offers return it,
 *   lokal_find_offers counts its producers as delivered («Med i AI-svar»),
 *   and the shopping list page shows it as a contact row;
 * - a label row's id is still refused by the cart (I-S2 a).
 *
 * Data: the I-S fixtures (seedCategoryLabelOfferFixtures in
 * rfb-kategorietiketter-ikke-tilbud.test.ts) in an in-memory DB with the
 * production schema (restored in finally). Routers driven directly, MCP tools
 * through a duck-typed server, the page script in a vm with a small fake DOM.
 *
 * Exported runRfbKategoritreffIOffersTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-kategoritreff-i-offers.test.ts
 */

import Database from "better-sqlite3";
import { stripAiUtm } from "../../tests/helpers/ai-utm";
import * as vm from "node:vm";
import { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } from "../database/init";
import { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } from "../services/geocoding-service";
import { seedCategoryLabelOfferFixtures, sqliteTimestamp, type Seed } from "./rfb-kategorietiketter-ikke-tilbud.test";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// The I-S fixture ids and places (rfb-kategorietiketter-ikke-tilbud.test.ts).
const T = { lat: 63.4305, lng: 10.3951 };
const S = { lat: 58.97, lng: 5.7331 };
const AARVIK_POS = { lat: 61.2, lng: 6.9 };
const HEVD = "1c000000-0000-4000-8000-000000000001";
const TIRSLAUG = "1c000000-0000-4000-8000-000000000002";
const EIER = "1c000000-0000-4000-8000-000000000003";
const BLANDET = "1c000000-0000-4000-8000-000000000004";
const REINDYRKA = "1c000000-0000-4000-8000-000000000011";
const AARVIK = "1c000000-0000-4000-8000-000000000021";
const LABEL_NAMES = ["Kjøtt", "Meieri", "Grønnsaker", "Bakervarer", "Honning", "Egg", "Fisk", "Urter"];
const MATCH_KEYS = ["match", "category", "orderable", "note", "producer"];

/** A router driven directly; the query is parsed from the url. Exported for I-V (rfb-offers-priser-ordgrense-avstand.test.ts). */
export function callRoute(router: any, method: string, url: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const query: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(url.split("?")[1] || "")) query[k] = v;
    const headers: Record<string, string> = {};
    const req: any = {
      method, url, originalUrl: url, path: url.split("?")[0], query, params: {}, headers, body: body ?? {},
      ip: "198.51.100.213", get: (name: string) => headers[name.toLowerCase()],
    };
    const res: any = {
      statusCode: 200, headersSent: false, _headers: {} as Record<string, string>,
      setHeader(name: string, value: unknown) { this._headers[name] = String(value); return this; },
      getHeader(name: string) { return this._headers[name]; },
      removeHeader() {}, append() {},
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.headersSent = true; resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { this.headersSent = true; resolve({ status: this.statusCode, body: payload }); return this; },
      end() { this.headersSent = true; resolve({ status: this.statusCode, body: undefined }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined }));
  });
}

/** Just enough DOM for the shopping list script (handleliste-page.ts CLIENT_SCRIPT). Exported for I-V. */
export class FakeNode {
  readonly tagName: string;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attrs: Record<string, string> = {};
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  checked = false;
  private text: string;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(tag: string, text = "") { this.tagName = tag.toUpperCase(); this.text = text; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { if (!names().includes(c)) this.className = [...names(), c].join(" "); },
      remove: (c: string) => { this.className = names().filter((n) => n !== c).join(" "); },
      contains: (c: string) => names().includes(c),
    };
  }
  appendChild(n: FakeNode): FakeNode { n.parentNode = this; this.children.push(n); return n; }
  removeChild(n: FakeNode): FakeNode { this.children = this.children.filter((c) => c !== n); n.parentNode = null; return n; }
  setAttribute(k: string, v: unknown): void { this.attrs[k] = String(v); if (k === "value") this.value = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void): void { (this.listeners[type] ||= []).push(fn); }
  dispatch(type: string): void { for (const fn of this.listeners[type] || []) fn({ preventDefault() {} }); }
  scrollIntoView(): void {}
  descendants(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  getElementsByTagName(tag: string): FakeNode[] { return this.descendants().filter((n) => n.tagName === tag.toUpperCase()); }
  querySelectorAll(sel: string): FakeNode[] {
    return sel.startsWith(".") ? this.descendants().filter((n) => n.classList.contains(sel.slice(1))) : this.getElementsByTagName(sel);
  }
}

export async function runRfbKategoritreffIOffersTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevPayments = process.env.PAYMENTS_ENABLED;
  delete process.env.PAYMENTS_ENABLED;
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const deliveries = require("../services/profile-ai-deliveries") as typeof import("../services/profile-ai-deliveries");
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  try {
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async () => ({ success: true, messageId: "stub-kategoritreff" }));
    deliveries.__resetAiDeliveriesForTesting();
    const { findOffers, categoryMatchNote } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const { cartRouter } = require("./marketplace-cart") as typeof import("./marketplace-cart");
    const mcp = require("./mcp") as typeof import("./mcp");

    const offersOf = (r: { offers: any[] }) => r.offers.map((o) => `${o.producer.name}: ${o.product_name}`);
    const matchesOf = (r: { category_matches?: any[] }) => (r.category_matches ?? []).map((m) => `${m.producer.name}: ${m.category}`);

    const searches = {
      honningT: await findOffers({ q: "honning", near: "Trondheim" }),
      eggT: await findOffers({ q: "egg", near: "Trondheim" }),
      honningB: await findOffers({ q: "honning", near: "Bergen" }),
      eggB: await findOffers({ q: "egg", near: "Bergen" }),
      eggS: await findOffers({ q: "egg", lat: S.lat, lng: S.lng }),
      eggS2: await findOffers({ q: "egg", lat: S.lat, lng: S.lng, limit: 2 }),
      eggS1km: await findOffers({ q: "egg", lat: S.lat, lng: S.lng, radiusKm: 1 }),
      eggS1km3: await findOffers({ q: "egg", lat: S.lat, lng: S.lng, radiusKm: 1, limit: 3 }),
      kjottAarvik: await findOffers({ q: "kjøtt", lat: AARVIK_POS.lat, lng: AARVIK_POS.lng }),
      bakervarerT: await findOffers({ q: "bakervarer", near: "Trondheim" }),
      erT: await findOffers({ q: "er", near: "Trondheim" }),
      honningT3: await findOffers({ q: "honning", near: "Trondheim", limit: 3 }),
      honningT2: await findOffers({ q: "honning", near: "Trondheim", limit: 2 }),
    };

    // ══════════════════════════════════════════════════════════════
    // The field: who fills the free places, in what order, with what
    // ══════════════════════════════════════════════════════════════
    // Slice I-V: one offer per producer, so Tirslaugtrøa's priced «Løvetannhonning» stands for its two honeys.
    assertEq([offersOf(searches.honningT), matchesOf(searches.honningT)], [
      ["Eiersatt Honning Fixture: Honning", "Tirslaugtrøa Bigård Fixture: Løvetannhonning"],
      ["Hevd Håndverksbakeri Fixture: Honning", "Blandet Gårdsutsalg Fixture: Honning"],
    ], "«honning» near Trondheim: two offers, one per producer (I-V); the two label producers fill two of the free places, nearest first");
    const m = searches.honningT.category_matches?.[0];
    if (!m) assertTrue(false, "entry: «honning» near Trondheim has a category match");
    else {
      assertEq(Object.keys(m), MATCH_KEYS, "entry: exactly {match, category, orderable, note, producer}");
      assertEq([m.match, m.category, m.orderable, m.producer.agent_id, m.producer.distance_km], ["category", "Honning", false, HEVD, 0.1],
        "entry: match «category», the label's category name, orderable false, the producer and its distance");
      assertEq(m.note, "Kategoritreff — spør produsenten om de har «honning». / Category match only — ask the producer whether they have «honning».",
        "entry: the note (NO / EN) tells the user to ask the producer about the term");
      assertEq(m.note, categoryMatchNote("honning"), "entry: the note is categoryMatchNote(term)");
      assertEq(Object.keys(m.producer), Object.keys(searches.honningT.offers[0]?.producer ?? {}), "entry: the producer has the same fields as an offer's producer");
    }
    {
      const blandetMatch = searches.honningT.category_matches?.find((m) => m.producer.agent_id === BLANDET);
      const blandetOffer = searches.eggT.offers.find((o) => o.producer.agent_id === BLANDET);
      assertEq(blandetMatch?.producer, blandetOffer?.producer,
        "entry: a producer reads the same as a category match and as an offer (one producer shape, same contact and can_order)");
    }
    const all = Object.values(searches);
    assertTrue(all.every((r) => (r.category_matches ?? []).every((m) => JSON.stringify(Object.keys(m)) === JSON.stringify(MATCH_KEYS)
      && !["product_id", "product_name", "price_nok", "unit", "availability"].some((k) => k in m))),
    "entry: no category match carries product_id, product_name, price_nok, unit or availability");
    assertTrue(all.every((r) => r.category_matches === undefined || r.category_matches.length > 0),
      "field: never an empty list (left out instead)");

    assertEq([offersOf(searches.eggT), matchesOf(searches.eggT)],
      [["Blandet Gårdsutsalg Fixture: Frittgående egg"], ["Hevd Håndverksbakeri Fixture: Egg"]],
      "«egg» near Trondheim: Blandet has real eggs and the label «Egg»; it stays an offer and is never also a category match");
    assertTrue(all.every((r) => {
      const offered = new Set(r.offers.map((o) => o.producer.agent_id));
      const matched = (r.category_matches ?? []).map((m) => m.producer.agent_id);
      return matched.every((id) => !offered.has(id)) && new Set(matched).size === matched.length;
    }), "field: never a producer in offers, and one entry per producer, on every search");
    // Slice I-V: one entry of several labels, the first by name, is the Tromsø order test below.
    assertEq([searches.erT.offers, matchesOf(searches.erT)], [[], []],
      "«er» near Trondheim: Hevd's labels have «er» only inside a word (Meieri, Grønnsaker, Bakervarer, Urter), so nothing matches (I-V word rule)");
    assertEq([matchesOf(searches.honningB), matchesOf(searches.eggB)], [["Reindyrka Fixture: Honning"], ["Reindyrka Fixture: Egg"]],
      "Bergen: Reindyrka's labels come back as category matches after the real, priced and owner-set offers");
    assertTrue(!(searches.honningT.category_matches ?? []).some((m) => m.producer.agent_id === EIER) && searches.honningT.offers.some((o) => o.producer.agent_id === EIER),
      "owner-set: the owner-set «Honning» stays an offer (F2), never a category match");

    // Limit: the field only fills free places
    assertTrue(all.every((r) => r.offers.length + (r.category_matches?.length ?? 0) <= 5), "limit: offers + category matches ≤ 5 on every search");
    assertEq([Object.keys(searches.eggS), offersOf(searches.eggS).length, Object.keys(searches.eggS2), offersOf(searches.eggS2).length],
      [["term", "offers"], 5, ["term", "offers"], 2],
      "limit: when the offers fill the page (limit 5 and limit 2), there is no category_matches key, the response is {term, offers}");
    assertEq([matchesOf(searches.honningT3), matchesOf(searches.honningT2)], [["Hevd Håndverksbakeri Fixture: Honning"], []],
      "limit: one free place gives the nearest label producer; no free place gives none");
    assertEq([offersOf(searches.eggS1km), matchesOf(searches.eggS1km)], [[], [0, 1, 2, 3, 4].map((i) => `Stavanger Etikett ${i} Fixture: Egg`)],
      "limit: five label producers and no offer in 1 km fill the five places, nearest first");
    assertEq(matchesOf(searches.eggS1km3), [0, 1, 2].map((i) => `Stavanger Etikett ${i} Fixture: Egg`), "limit: with limit 3, the three nearest");

    // Pages that only had labels get a non-empty field
    for (const [key, who] of [["kjottAarvik", "Aarvik Gård Fixture: Kjøtt"], ["bakervarerT", "Hevd Håndverksbakeri Fixture: Bakervarer"]] as const) {
      assertEq([searches[key].offers, matchesOf(searches[key])], [[], [who]], `label-only page (${key}): no offer, and a non-empty category_matches`);
    }

    // The order does not hang on the rows' order in the table. Three
    // producers with the labels «Bakervarer» and «Bakeri» (both start with
    // the term «bake», I-V): 1 and 2 at one point (as at a city centroid), 0
    // a little farther and with the lowest id. Written in that order, and in
    // the reverse order with each producer's rows reversed too, each in its
    // own DB.
    {
      const P = { lat: 69.6492, lng: 18.9553 }; // Tromsø
      const tieSeed = (i: number, dLat: number): Seed => ({ id: `1c000000-0000-4000-8000-00000000005${i}`, name: `Tromsø Etikett ${i} Fixture`,
        lat: P.lat + dLat, lng: P.lng, city: "Tromsø", categories: ["bakery"],
        products: [{ name: "Bakervarer", category: "bakery", seasonal: false }, { name: "Bakeri", category: "bakery", seasonal: false }],
        catalog: [{ name: "Bakervarer" }, { name: "Bakeri" }] });
      const forward = [tieSeed(0, 0.01), tieSeed(1, 0), tieSeed(2, 0)];
      const reverse = [...forward].reverse().map((s) => ({ ...s, catalog: [...s.catalog].reverse() }));
      const written: string[][] = [];
      const answers: string[][][] = [];
      for (const seeds of [forward, reverse]) {
        const tieDb = new Database(":memory:");
        tieDb.pragma("foreign_keys = ON");
        __setDbForTesting(tieDb as any);
        __initSchemaForTesting(tieDb as any);
        seedCategoryLabelOfferFixtures(tieDb, ownerSetAt, seeds);
        written.push((tieDb.prepare("SELECT agent_id, name FROM products ORDER BY rowid").all() as any[]).map((x) => `${x.agent_id}: ${x.name}`));
        const answer: string[][] = [];
        for (const limit of [1, 2, 5]) answer.push(matchesOf(await findOffers({ q: "bake", lat: P.lat, lng: P.lng, limit })));
        answers.push(answer);
        __setDbForTesting(db as any);
      }
      assertEq(written[1], [...written[0]!].reverse(), "order setup: the second DB has the same rows in the reverse order");
      const expected = [[1], [1, 2], [1, 2, 0]].map((ids) => ids.map((i) => `Tromsø Etikett ${i} Fixture: Bakeri`));
      assertEq(answers, [expected, expected],
        "order: limit 1, 2 and 5 give the same entries in both orders: by distance, then agent id; one entry per producer, the label first by name (Bakeri before Bakervarer)");
    }

    // ══════════════════════════════════════════════════════════════
    // `offers` is what it was after I-S
    // ══════════════════════════════════════════════════════════════
    {
      // The same fixtures without the label rows, in a second DB: no category
      // matches, and the same offers field by field.
      const copy = new Database(":memory:");
      copy.pragma("foreign_keys = ON");
      __setDbForTesting(copy as any);
      __initSchemaForTesting(copy as any);
      seedCategoryLabelOfferFixtures(copy, ownerSetAt);
      const n = copy.prepare(`DELETE FROM products WHERE price_nok IS NULL AND availability_source = 'enrichment' AND name IN (${LABEL_NAMES.map(() => "?").join(", ")})`)
        .run(...LABEL_NAMES).changes;
      assertTrue(n === 23, `byte-like setup: the fixtures' 23 label rows removed (got ${n})`);
      const without = {
        honningT: await findOffers({ q: "honning", near: "Trondheim" }), eggT: await findOffers({ q: "egg", near: "Trondheim" }),
        honningB: await findOffers({ q: "honning", near: "Bergen" }), eggB: await findOffers({ q: "egg", near: "Bergen" }),
        eggS: await findOffers({ q: "egg", lat: S.lat, lng: S.lng }), eggS1km: await findOffers({ q: "egg", lat: S.lat, lng: S.lng, radiusKm: 1 }),
        kjottAarvik: await findOffers({ q: "kjøtt", lat: AARVIK_POS.lat, lng: AARVIK_POS.lng }),
      };
      __setDbForTesting(db as any);
      for (const k of Object.keys(without) as Array<keyof typeof without>) {
        assertEq([Object.keys(without[k]), without[k].offers], [["term", "offers"], searches[k].offers],
          `byte-like (${k}): without the label rows there is no category_matches, and offers[] is the same field by field`);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // The surfaces: GET /catalog/offers, lokal_find_offers, deliveries
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callRoute(catalogRouter, "GET", "/offers?q=honning&near=Trondheim&radius_km=50&limit=5");
      assertEq([r.status, Object.keys(r.body)], [200, ["term", "offers", "category_matches"]], "GET /catalog/offers: {term, offers, category_matches}");
      assertEq(r.body, searches.honningT, "GET /catalog/offers: findOffers' result, category matches included");
      const full = await callRoute(catalogRouter, "GET", `/offers?q=egg&lat=${S.lat}&lng=${S.lng}&radius_km=50&limit=5`);
      assertEq(Object.keys(full.body), ["term", "offers"], "GET /catalog/offers: a full page is {term, offers}, as before");
    }
    {
      const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
      mcp.registerTools({
        server: { getClientVersion: () => ({ name: "claude-ai", version: "1" }) },
        registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
        resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
      } as any, () => "test-client", () => undefined);
      db.prepare("DELETE FROM profile_ai_deliveries").run();
      const r = await tools.get("lokal_find_offers")!({ items: ["honning", "egg"], near: "Trondheim" },
        { sessionId: "i-s2-find-offers", requestInfo: { headers: { "user-agent": "claude-ai/1.0" } } });
      // klikk-fra-ai-svar S3: lokal_find_offers tags profile_url for AI; the rest is findOffers' JSON.
      const parsed = stripAiUtm(JSON.parse(String(r?.content?.[0]?.text ?? "null")));
      assertEq(parsed, [searches.honningT, searches.eggT], "lokal_find_offers: one findOffers result per item, category matches included");
      deliveries.flushAiDeliveries(db as any);
      const counted = (db.prepare("SELECT profile_id FROM profile_ai_deliveries WHERE vertical_id = 'rfb' AND channel = 'mcp' ORDER BY profile_id").all() as any[])
        .map((x) => x.profile_id);
      assertEq(counted, [HEVD, TIRSLAUG, EIER, BLANDET].sort(),
        "lokal_find_offers: the producers of the offers and of the category matches are counted as delivered, once each");
    }

    // ══════════════════════════════════════════════════════════════
    // No cart id: a category match cannot be ordered (I-S2 a)
    // ══════════════════════════════════════════════════════════════
    {
      const hevdLabel = db.prepare("SELECT id FROM products WHERE agent_id = ? AND name = 'Honning'").get(HEVD) as { id: string };
      const { cart_id } = cartSvc.createCart();
      assertEq(cartSvc.addCartItem(cart_id, hevdLabel.id, 1), { success: false, status: 422, error: cartSvc.CATEGORY_LABEL_CART_ERROR },
        "cart: the label row behind Hevd's category match is refused with 422 category_label (its id is still public via /catalog/feed)");
    }

    // ══════════════════════════════════════════════════════════════
    // The shopping list page: category matches are contact rows
    // ══════════════════════════════════════════════════════════════
    {
      const page = require("./handleliste-page") as typeof import("./handleliste-page");
      const copyJson = (page.buildHandelistePage("no").content.match(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/) || [])[1] || "{}";
      const C = JSON.parse(copyJson);
      const nodes = new Map<string, FakeNode>();
      const el = (id: string) => { if (!nodes.has(id)) nodes.set(id, new FakeNode("div")); return nodes.get(id)!; };
      el("hl-copy").textContent = copyJson;
      const requests: Array<{ method: string; path: string; body: any }> = [];
      const fetchStub = (path: string, init: { method: string; body?: string }) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        requests.push({ method: init.method, path, body });
        const done = path.startsWith("/api/marketplace/catalog/")
          ? callRoute(catalogRouter, init.method, path.slice("/api/marketplace/catalog".length))
          : callRoute(cartRouter, init.method, path.slice("/api/marketplace".length), body);
        return done.then((r) => ({ status: r.status, json: async () => r.body }));
      };
      const store = new Map<string, string>();
      const context = vm.createContext({
        document: { getElementById: el, createElement: (tag: string) => new FakeNode(tag), createTextNode: (s: string) => new FakeNode("#text", s) },
        fetch: fetchStub,
        localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
        navigator: {},
      });
      vm.runInContext(page.HANDELISTE_CLIENT_SCRIPT, context);
      const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };

      el("hl-rows").getElementsByTagName("input")[0]!.value = "honning";
      el("hl-place").value = "Trondheim";
      el("hl-find").dispatch("click");
      await settle();
      const rows = el("hl-offers").querySelectorAll(".hl-offer");
      const rowText = rows.map((n) => n.textContent);
      assertEq(rows.length, 4, "page: «honning» shows four rows, two offers (one per producer, I-V) and two category matches");
      const hevdRow = rows.findIndex((n) => n.textContent.startsWith("Hevd Håndverksbakeri Fixture"));
      const eierRow = rows.findIndex((n) => n.textContent.startsWith("Eiersatt Honning Fixture"));
      assertTrue(hevdRow === 2 && rowText[hevdRow]!.includes(C.contact_only) && !rowText[hevdRow]!.includes(C.can_order) && rowText[hevdRow]!.includes(C.category_match),
        `page: Hevd's category match is a contact row with the category note, though its producer has can_order (got ${JSON.stringify(rowText[hevdRow])})`);
      assertTrue(eierRow === 0 && rowText[eierRow]!.includes(C.can_order) && !rowText[eierRow]!.includes(C.category_match),
        "page: an orderable offer is unchanged («Kan bestilles her», no category note)");
      assertEq(rows[hevdRow]?.querySelectorAll(".hl-meta").map((n) => n.textContent), ["Trondheim · 0.1 km", C.category_match],
        "page: a category match shows place and distance and the category note, no product name, price or availability");

      rows[hevdRow]?.getElementsByTagName("input")[0]?.dispatch("change");
      el("hl-next2").dispatch("click");
      const summary = el("hl-summary").textContent;
      assertTrue(summary.includes(C.summary_contact) && summary.includes("Hevd Håndverksbakeri Fixture") && !summary.includes(C.summary_order),
        `page: the chosen category match is summed up as «${C.summary_contact}» (got ${JSON.stringify(summary)})`);
      el("hl-submit").dispatch("click");
      await settle();
      const patch = requests.find((x) => x.method === "PATCH");
      assertEq(patch?.body && { agent_id: patch.body.agent_id, mode: patch.body.mode, product_id: patch.body.product_id }, { agent_id: HEVD, mode: "contact", product_id: undefined },
        "page: the wish is sent as contact with the producer, never with a product id");
      const result = el("hl-result").textContent;
      assertTrue(result.includes(C.contact_h2) && result.includes("Hevd Håndverksbakeri Fixture") && !result.includes(C.sent_h),
        "page: the result is a contact handoff for Hevd, no order");
    }
  } finally {
    console.log = prevLog;
    if (prevBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = prevBaseUrl;
    if (prevPayments === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = prevPayments;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    deliveries.__resetAiDeliveriesForTesting();
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    cartSvc.__setCartTestDb(null);
    if (prevDb) __setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runRfbKategoritreffIOffersTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
