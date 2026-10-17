/**
 * rfb-kurvvakt-kategorietiketter.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-S2 (a): a catalog row that
 * is only a generic category label can never be put in a cart.
 *
 * Since slice I-S findOffers no longer offers such rows («Honning» at a
 * bakery: category inference wrote it, product-catalog-sync copied it into
 * `products` as in_stock), but their ids are still public via GET
 * /catalog/feed and /catalog/agents/:id/products. cart-service refuses them
 * with 422 and CATEGORY_LABEL_CART_ERROR in three places:
 * - addCartItem, before the stock and producer checks;
 * - chooseCartWishOffer, before the wish's own row is touched;
 * - submitCart, for a label line already in a cart (no order, no handoff).
 * A real product, a category name with a price and a row the producer set
 * (availability_source 'producer_dashboard') can still be added. The rule is
 * utils/category-label.ts, the one findOffers and lokal_info use. The 422
 * reaches the buyer through the REST routes and the MCP cart tools unchanged.
 *
 * Production schema in an in-memory DB (restored in finally), cart-service's
 * own test-DB pin, the order e-mail stubbed. Routers driven directly as in
 * marketplace-cart-wishes.test.ts, MCP tools through a duck-typed server.
 *
 * Exported runRfbKurvvaktKategorietiketterTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-kurvvakt-kategorietiketter.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const BAKERI = "1d000000-0000-4000-8000-000000000001";
const EIER = "1d000000-0000-4000-8000-000000000002";

interface Row {
  id: string;
  agent: string;
  name: string;
  priceNok?: number;
  ownerSet?: boolean;
  availability?: string;
}

const ROWS: Row[] = [
  { id: "ks-honning", agent: BAKERI, name: "Honning" },
  { id: "ks-bakervarer", agent: BAKERI, name: "BAKERVARER" },
  { id: "ks-kjott-oos", agent: BAKERI, name: "Kjøtt", availability: "out_of_stock" },
  { id: "ks-brod", agent: BAKERI, name: "Surdeigsbrød" },
  { id: "ks-egg-pris", agent: BAKERI, name: "Egg", priceNok: 60 },
  { id: "ks-egg-eier", agent: EIER, name: "Egg", ownerSet: true },
  { id: "ks-honning-eier", agent: EIER, name: "Honning", ownerSet: true, availability: "out_of_stock" },
];
const LABEL_IDS = ["ks-honning", "ks-bakervarer", "ks-kjott-oos"];

function callRoute(
  router: any,
  opts: { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    const req: any = {
      method: opts.method, url: opts.url, originalUrl: opts.url, path: opts.url.split("?")[0], query: {}, params: {},
      headers, body: opts.body ?? {}, ip: "198.51.100.212", get: (name: string) => headers[name.toLowerCase()],
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

export async function runRfbKurvvaktKategorietiketterTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const prevDb = initMod.__peekDbForTesting();
  const prevPayments = process.env.PAYMENTS_ENABLED;
  delete process.env.PAYMENTS_ENABLED;
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence module chatter */ };

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async () => ({ success: true, messageId: "stub-kurvvakt" }));

    // Both producers are cross-check verified, owner-claimed and opted in, so
    // a cart line of theirs becomes a real order.
    for (const [id, name] of [[BAKERI, "Kurvvakt Bakeri Fixture"], [EIER, "Kurvvakt Eier Fixture"]]) {
      db.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city, is_active, is_verified, order_notifications_opt_in)
        VALUES (?, ?, 'test', 'test', ?, 'https://example.no', 'producer', ?, 63.43, 10.39, 'Trondheim', 1, 1, 1)
      `).run(id, name, `${id}@example.no`, `key-${id}`);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, phone, email) VALUES (?, 'verified', '91234567', ?)").run(id, `${id}@example.no`);
    }
    // A day ago: fresh for the supply graph's staleness window.
    const ownerSetAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
    for (const r of ROWS) {
      db.prepare(`
        INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(r.id, r.agent, r.name, r.name.toLowerCase(), r.priceNok ?? null, r.priceNok ? "brett" : null, r.availability ?? "in_stock",
        r.ownerSet ? "producer_dashboard" : "enrichment", r.ownerSet ? ownerSetAt : null);
    }

    const { CATEGORY_LABEL_CART_ERROR } = cartSvc;
    const refused = { success: false, status: 422, error: CATEGORY_LABEL_CART_ERROR };
    const itemsOf = (cartId: string) =>
      (db.prepare("SELECT product_id, wish_id FROM cart_items WHERE cart_id = ? ORDER BY product_id").all(cartId) as any[]);
    /** A cart line written straight to the table: a label added before the guard existed. */
    const legacyLine = (cartId: string, productId: string, agentId: string) =>
      db.prepare("INSERT OR IGNORE INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot, added_at) VALUES (?, ?, ?, ?, 1, NULL, datetime('now'))")
        .run(`legacy-${cartId}-${productId}`, cartId, productId, agentId);
    const ordersOf = (cartId: string) => (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE cart_id = ?").get(cartId) as { n: number }).n;
    const handoffsOf = (cartId: string) => (db.prepare("SELECT COUNT(*) AS n FROM cart_handoffs WHERE cart_id = ?").get(cartId) as { n: number }).n;

    assertEq(CATEGORY_LABEL_CART_ERROR, "category_label: kategorinavn, ikke et produkt — spør produsenten. / A category name, not a product — ask the producer.",
      "error: the code category_label, then the spec's text for the buyer (NO / EN)");

    // ══════════════════════════════════════════════════════════════
    // addCartItem
    // ══════════════════════════════════════════════════════════════
    {
      const { cart_id } = cartSvc.createCart();
      db.prepare("UPDATE carts SET updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(cart_id);
      assertEq(cartSvc.addCartItem(cart_id, "ks-honning", 1), refused, "addCartItem: the label «Honning» (no price, enrichment) is refused with 422 category_label");
      assertEq(cartSvc.addCartItem(cart_id, "ks-bakervarer", 2), refused, "addCartItem: a label in other case («BAKERVARER») is refused too");
      assertEq(cartSvc.addCartItem(cart_id, "ks-kjott-oos", 1), refused,
        "addCartItem: a label out of stock gets the label answer (422), not the stock answer (409)");
      assertEq(itemsOf(cart_id), [], "addCartItem: a refused label leaves no cart line");
      assertEq((db.prepare("SELECT updated_at FROM carts WHERE id = ?").get(cart_id) as any).updated_at, "2026-01-01 00:00:00",
        "addCartItem: a refused label does not touch the cart");

      for (const [id, what] of [["ks-brod", "a real product without a price"], ["ks-egg-pris", "a category name with a price («Egg», 60 kr)"],
        ["ks-egg-eier", "a row the producer set («Egg», producer_dashboard)"]]) {
        const r = cartSvc.addCartItem(cart_id, id, 1);
        assertTrue(r.success === true && r.item.product_id === id, `addCartItem: ${what} can still be added`);
      }
      assertEq(cartSvc.addCartItem(cart_id, "ks-honning-eier", 1),
        { success: false, status: 409, error: "Product is not in stock (availability: out_of_stock)" },
        "addCartItem: an owner-set «Honning» is a product, so it gets the stock answer (409), not 422");
      assertEq(cartSvc.addCartItem(cart_id, "ks-ukjent", 1), { success: false, status: 404, error: "Product not found" },
        "addCartItem: an unknown id is still 404");
    }

    // ══════════════════════════════════════════════════════════════
    // chooseCartWishOffer
    // ══════════════════════════════════════════════════════════════
    {
      const { cart_id } = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart_id, "honning", 1);
      const wishId = w.success ? w.wish.id : "";
      const wishRow = () => db.prepare("SELECT chosen_product_id, chosen_agent_id, mode FROM cart_wishes WHERE id = ?").get(wishId);
      assertEq(cartSvc.chooseCartWishOffer(cart_id, wishId, { productId: "ks-honning" }), refused,
        "chooseCartWishOffer: choosing the label «Honning» is refused with 422 category_label");
      assertEq([wishRow(), itemsOf(cart_id)], [{ chosen_product_id: null, chosen_agent_id: null, mode: null }, []],
        "chooseCartWishOffer: a refused label leaves the wish unchosen and no cart line");

      const real = cartSvc.chooseCartWishOffer(cart_id, wishId, { productId: "ks-brod" });
      assertTrue(real.success === true && real.wish.chosen_product_id === "ks-brod", "chooseCartWishOffer: a real product can be chosen");
      assertEq(cartSvc.chooseCartWishOffer(cart_id, wishId, { productId: "ks-bakervarer" }), refused,
        "chooseCartWishOffer: switching to a label is refused");
      assertEq([wishRow(), itemsOf(cart_id)],
        [{ chosen_product_id: "ks-brod", chosen_agent_id: null, mode: "order" }, [{ product_id: "ks-brod", wish_id: wishId }]],
        "chooseCartWishOffer: the refusal comes before the clean-up, so the earlier choice and its cart line stay");

      const owner = cartSvc.chooseCartWishOffer(cart_id, wishId, { productId: "ks-egg-eier" });
      assertTrue(owner.success === true && owner.wish.chosen_product_id === "ks-egg-eier", "chooseCartWishOffer: an owner-set row can be chosen");
      const priced = cartSvc.chooseCartWishOffer(cart_id, wishId, { productId: "ks-egg-pris" });
      assertTrue(priced.success === true && priced.wish.chosen_product_id === "ks-egg-pris", "chooseCartWishOffer: a category name with a price can be chosen");
      const contact = cartSvc.chooseCartWishOffer(cart_id, wishId, { agentId: BAKERI, mode: "contact" });
      assertTrue(contact.success === true && contact.wish.mode === "contact" && contact.wish.chosen_agent_id === BAKERI,
        "chooseCartWishOffer: the label's producer can still be chosen to contact (no product, no cart line)");
    }

    // ══════════════════════════════════════════════════════════════
    // submitCart
    // ══════════════════════════════════════════════════════════════
    {
      const { cart_id } = cartSvc.createCart();
      assertTrue(cartSvc.addCartItem(cart_id, "ks-brod", 2).success, "submitCart setup: a real product in the cart");
      legacyLine(cart_id, "ks-honning", BAKERI);
      const w = cartSvc.addCartWish(cart_id, "egg", 1);
      if (w.success) cartSvc.chooseCartWishOffer(cart_id, w.wish.id, { agentId: EIER, mode: "contact" });
      assertEq(cartSvc.submitCart(cart_id, { contact_consent: false }),
        { ...refused, category_labels: [{ product_id: "ks-honning", product_name: "Honning" }] },
        "submitCart: a label line already in the cart refuses the submit (422 category_label) and names the line");
      assertEq([(db.prepare("SELECT status FROM carts WHERE id = ?").get(cart_id) as any).status, ordersOf(cart_id), handoffsOf(cart_id)], ["open", 0, 0],
        "submitCart: a refused submit sends nothing (cart open, no order, no handoff)");

      const line = db.prepare("SELECT id FROM cart_items WHERE cart_id = ? AND product_id = 'ks-honning'").get(cart_id) as { id: string };
      assertTrue(cartSvc.deleteCartItem(cart_id, line.id).success, "submitCart: the buyer removes the label line");
      const ok = cartSvc.submitCart(cart_id, { contact_consent: false });
      assertTrue(ok.success === true && ok.orders.length === 1 && ok.orders[0]!.agent_id === BAKERI && ok.contact_handoffs.length === 1,
        "submitCart: without the label the same cart is sent (one order for the real product, one contact handoff)");

      const owner = cartSvc.createCart();
      assertTrue(cartSvc.addCartItem(owner.cart_id, "ks-egg-eier", 1).success && cartSvc.addCartItem(owner.cart_id, "ks-egg-pris", 1).success,
        "submitCart setup: an owner-set row and a priced category name in a cart");
      const sent = cartSvc.submitCart(owner.cart_id, { contact_consent: false });
      assertTrue(sent.success === true && sent.orders.length === 2, "submitCart: an owner-set row and a priced category name are sent as orders");
    }

    // ══════════════════════════════════════════════════════════════
    // One rule: the cart refuses exactly what utils/category-label.ts calls a label
    // ══════════════════════════════════════════════════════════════
    {
      const { isCategoryLabel } = require("../utils/category-label") as typeof import("../utils/category-label");
      const rows = db.prepare("SELECT id, name, price_nok, availability_source FROM products ORDER BY id").all() as any[];
      const { cart_id } = cartSvc.createCart();
      const refusedIds = rows.filter((r) => {
        const res = cartSvc.addCartItem(cart_id, r.id, 1);
        return !res.success && res.status === 422;
      }).map((r) => r.id);
      const labelIds = rows.filter((r) => isCategoryLabel({ name: r.name, hasPrice: r.price_nok != null, availabilitySource: r.availability_source }))
        .map((r) => r.id);
      assertEq(refusedIds, labelIds, "one rule: the rows addCartItem refuses with 422 are the rows isCategoryLabel calls labels");
      assertEq([...labelIds].sort(), [...LABEL_IDS].sort(), "one rule: the fixture's labels are the three enrichment rows without a price");
    }

    // ══════════════════════════════════════════════════════════════
    // The 422 through the REST routes (marketplace-cart.ts)
    // ══════════════════════════════════════════════════════════════
    {
      const { cartRouter } = require("./marketplace-cart") as typeof import("./marketplace-cart");
      const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
      const { cart_id, buyer_ref } = created.body ?? {};
      assertEq(created.status, 201, "REST: POST /cart 201");
      const add = await callRoute(cartRouter, { method: "POST", url: `/cart/${cart_id}/items`, body: { product_id: "ks-honning", qty: 1, buyer_ref } });
      assertEq([add.status, add.body], [422, { success: false, error: CATEGORY_LABEL_CART_ERROR }], "REST POST /cart/:id/items: a label gives 422 category_label");
      const addOwner = await callRoute(cartRouter, { method: "POST", url: `/cart/${cart_id}/items`, body: { product_id: "ks-egg-eier", qty: 1, buyer_ref } });
      assertTrue(addOwner.status === 200 && addOwner.body?.item?.product_id === "ks-egg-eier", "REST POST /cart/:id/items: an owner-set row is added (200)");
      const wish = await callRoute(cartRouter, { method: "POST", url: `/cart/${cart_id}/wishes`, body: { term: "bakervarer", qty: 1, buyer_ref } });
      const pick = await callRoute(cartRouter, { method: "PATCH", url: `/cart/${cart_id}/wishes/${wish.body?.wish?.id}`, body: { product_id: "ks-bakervarer", buyer_ref } });
      assertEq([wish.status, pick.status, pick.body], [201, 422, { success: false, error: CATEGORY_LABEL_CART_ERROR }],
        "REST PATCH /cart/:id/wishes/:wid: choosing a label gives 422 category_label");
      legacyLine(cart_id, "ks-bakervarer", BAKERI);
      const sub = await callRoute(cartRouter, { method: "POST", url: `/cart/${cart_id}/submit`, body: { buyer_ref, website: "" } });
      assertEq([sub.status, sub.body], [422, { ...refused, category_labels: [{ product_id: "ks-bakervarer", product_name: "BAKERVARER" }] }],
        "REST POST /cart/:id/submit: a label line gives 422 category_label with the line");
    }

    // ══════════════════════════════════════════════════════════════
    // The 422 through the MCP cart tools (mcp.ts)
    // ══════════════════════════════════════════════════════════════
    {
      const mcp = require("./mcp") as typeof import("./mcp");
      const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
      mcp.registerTools({
        registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
        resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
      } as any, () => "test-client", () => undefined);
      const json = async (tool: string, args: any) => JSON.parse(String((await tools.get(tool)!(args))?.content?.[0]?.text ?? "null"));
      const { cart_id, buyer_ref } = await json("lokal_cart_create", {});
      assertEq(await json("lokal_cart_add_item", { cart_id, buyer_ref, product_id: "ks-honning", qty: 1 }), { success: false, error: CATEGORY_LABEL_CART_ERROR },
        "MCP lokal_cart_add_item: a label is refused with the category_label text");
      const real = await json("lokal_cart_add_item", { cart_id, buyer_ref, product_id: "ks-egg-pris", qty: 1 });
      assertTrue(real?.success === true && real.item?.product_id === "ks-egg-pris", "MCP lokal_cart_add_item: a category name with a price is added");
      legacyLine(cart_id, "ks-honning", BAKERI);
      assertEq(await json("lokal_cart_submit", { cart_id, buyer_ref }), { ...refused, category_labels: [{ product_id: "ks-honning", product_name: "Honning" }] },
        "MCP lokal_cart_submit: a label line gives status 422 category_label with the line");
      assertEq(ordersOf(cart_id), 0, "MCP lokal_cart_submit: no order is created");
    }
  } finally {
    console.log = prevLog;
    if (prevPayments === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = prevPayments;
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    cartSvc.__setCartTestDb(null);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runRfbKurvvaktKategorietiketterTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
