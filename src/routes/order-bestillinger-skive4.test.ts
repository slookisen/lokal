/**
 * order-bestillinger-skive4.test.ts — dev-request 2026-10-21-rfb-bestillinger-
 * klar-for-forste-ekte-handel, SKIVE 4 («matinformasjon i piloten»). No
 * network, no real e-mail, no production DB: a fresh in-memory SQLite with the
 * real production schema and the e-mail transport stubbed.
 *
 *   S4-1  only producer-stated rows can be ordered from a producer who passes
 *         isEligibleForRealOrder(): scraped rows are refused at add, wish
 *         choice and submit (no order, no e-mail); producer_dashboard and
 *         admin_producer_confirmed rows are orderable; a producer who does not
 *         pass the gate is unchanged (scraped rows still become handoffs)
 *   S4-2  POST /admin/products/producer-list: 401 without/with a wrong key,
 *         200 with the key, validation errors write nothing, packaged food
 *         needs ingredients + allergens + net weight, idempotent, writes
 *         availability_source='admin_producer_confirmed', and the catalog sync
 *         never overwrites the confirmed price
 *   S4-3  price + food information are shown in the cart view (REST and MCP)
 *   S4-4  the offers answer (REST + lokal_find_offers) carries food_info + producer_confirmed
 *   S4-5  unconfirmedItemError fails closed when the gate cannot be evaluated
 *
 * Standalone: npx tsx src/routes/order-bestillinger-skive4.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderBestillingerSkive4Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const syncSvc = require("../services/product-catalog-sync") as typeof import("../services/product-catalog-sync");

  const ENV_KEYS = ["ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ORDER_CAP_OPEN_PENDING_PER_BUYER", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", "PAYMENTS_ENABLED"];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const ADMIN_KEY = "skive4-test-admin-key";
  const sent: Array<{ to: string; subject: string }> = [];
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject });
      return { success: true, messageId: "stub" };
    });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
    process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";

    // ── Schema: the new columns exist (additive migration) ─────────────────
    const cols = (db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["ingredients", "allergens", "net_weight", "availability_source", "availability_updated_at", "name_norm"]) {
      assertTrue(cols.includes(c), `schema: products.${c} exists`);
    }
    // Running the schema init again is a no-op (idempotent).
    initMod.__initSchemaForTesting(db as any);
    assertEq((db.prepare("PRAGMA table_info(products)").all() as any[]).length, cols.length, "schema: second init adds nothing");

    // ── Seed ────────────────────────────────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')
    `);
    const insKnow = db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, ?)");
    const insProd = db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
      VALUES (?, ?, ?, ?, ?, 'kg', 'in_stock', 'vegetables', ?, ?)
    `);
    const fresh = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);

    // Eligible producer (passes the gate): one scraped row, one dashboard row, one admin-confirmed row.
    insAgent.run("ag-pilot", "Pilot Gård", "pilot@example.no", "k1");
    insKnow.run("ag-pilot", "pilot@example.no", "+47 400 11 111");
    db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = 'ag-pilot'").run();
    insProd.run("p-scraped", "ag-pilot", "Skrapte poteter", "skrapte poteter", 30, "enrichment", null);
    insProd.run("p-dash", "ag-pilot", "Dashbordgulrot", "dashbordgulrot", 25, "producer_dashboard", fresh);
    insProd.run("p-admin", "ag-pilot", "Adminkål", "adminkal", 20, "admin_producer_confirmed", fresh);
    // Out-of-stock scraped row of the eligible producer keeps the stock answer (409).
    db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_source)
                VALUES ('p-scraped-oos', 'ag-pilot', 'Utsolgt skrapet', 'utsolgt skrapet', 10, 'out_of_stock', 'enrichment')`).run();

    // Producer who does NOT pass the gate (verified, but no opt-in): scraped rows keep working as contact lines.
    insAgent.run("ag-plain", "Vanlig Gård", "plain@example.no", "k2");
    insKnow.run("ag-plain", "plain@example.no", null);
    insProd.run("p-plain", "ag-plain", "Vanlig honning", "vanlig honning", 90, "enrichment", null);

    const BUYER = { buyer_name: "Kari Kjøper", buyer_email: "kari.kjoper@example.com", contact_consent: true };
    const ordersCount = () => (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n as number;
    const settle = () => new Promise((r) => setTimeout(r, 40));

    // ════════════════════════════════════════════════════════════════════════
    // S4-1 — only producer-stated rows are orderable from an eligible producer
    // ════════════════════════════════════════════════════════════════════════
    assertTrue(cartSvc.isEligibleForRealOrder("ag-pilot"), "gate: the pilot producer passes isEligibleForRealOrder");
    assertTrue(!cartSvc.isEligibleForRealOrder("ag-plain"), "gate: the plain producer does not");
    {
      const cart = cartSvc.createCart();
      const scraped = cartSvc.addCartItem(cart.cart_id, "p-scraped", 1);
      assertTrue(!scraped.success && scraped.status === 422 && scraped.error.startsWith("not_producer_confirmed"),
        "s4-01: a scraped row of an eligible producer is refused (422 not_producer_confirmed)");
      assertTrue(!scraped.success && /kontakt/i.test(scraped.error) && /contact the producer/i.test(scraped.error),
        "s4-02: the refusal explains why and points to the producer (NO / EN)");
      assertEq(cartSvc.viewCart(cart.cart_id)?.item_count, 0, "s4-03: a refused row leaves no cart line");
      const dash = cartSvc.addCartItem(cart.cart_id, "p-dash", 2);
      assertTrue(dash.success === true, "s4-04: a producer_dashboard row is orderable");
      const adm = cartSvc.addCartItem(cart.cart_id, "p-admin", 1);
      assertTrue(adm.success === true, "s4-05: an admin_producer_confirmed row is orderable");
      const oos = cartSvc.addCartItem(cart.cart_id, "p-scraped-oos", 1);
      assertTrue(!oos.success && oos.status === 409, "s4-06: an out-of-stock scraped row keeps the stock answer (409)");
      // The same service backs REST and MCP: the unchanged contract is exercised below (s4-30..).
      const plain = cartSvc.addCartItem(cart.cart_id, "p-plain", 1);
      assertTrue(plain.success === true, "s4-07: a scraped row of a producer who does not pass the gate is unchanged (still added)");
    }
    {
      // Submit: a scraped line that is already in the cart (added before the rule) stops the submit for an eligible producer.
      const cart = cartSvc.createCart();
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-s4-1', ?, 'p-scraped', 'ag-pilot', 1, 30)").run(cart.cart_id);
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-s4-2', ?, 'p-dash', 'ag-pilot', 1, 25)").run(cart.cart_id);
      const before = ordersCount();
      sent.length = 0;
      const sub = cartSvc.submitCart(cart.cart_id, BUYER);
      assertTrue(!sub.success && sub.status === 422 && sub.error.startsWith("not_producer_confirmed"), "s4-10: submit with a scraped line of an eligible producer -> 422");
      assertEq(!sub.success ? sub.unconfirmed_items?.map((i) => i.product_name) : null, ["Skrapte poteter"], "s4-11: the refusal names the scraped line only");
      assertEq(ordersCount(), before, "s4-12: no order row");
      assertEq((db.prepare("SELECT status FROM carts WHERE id = ?").get(cart.cart_id) as any).status, "open", "s4-13: the cart stays open");
      await settle();
      assertEq(sent.length, 0, "s4-14: no e-mail to the producer");
      // After the buyer removes the scraped line the same cart is sent.
      db.prepare("DELETE FROM cart_items WHERE id = 'ci-s4-1'").run();
      const ok = cartSvc.submitCart(cart.cart_id, BUYER);
      assertTrue(ok.success === true && ok.orders.length === 1, "s4-15: with only producer-stated lines the cart becomes a real order");
      await settle();
      assertEq(sent.filter((m) => m.to === "pilot@example.no").length, 1, "s4-16: the producer is told once");
    }
    {
      // A producer who does not pass the gate: the scraped line is still a contact handoff, no order, no error.
      const cart = cartSvc.createCart();
      cartSvc.addCartItem(cart.cart_id, "p-plain", 1);
      const r = cartSvc.submitCart(cart.cart_id);
      assertTrue(r.success === true && r.orders.length === 0 && r.contact_handoffs.length === 1, "s4-17: non-opt-in producer: handoff exactly as before");
    }
    {
      // Wish: choosing a scraped row is refused before anything is touched; a stated row can be chosen.
      const cart = cartSvc.createCart();
      const w = cartSvc.addCartWish(cart.cart_id, "poteter", 1);
      if (!w.success) throw new Error("setup: wish");
      const refused = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "p-scraped" });
      assertTrue(!refused.success && refused.status === 422 && refused.error.startsWith("not_producer_confirmed"), "s4-20: a wish cannot choose a scraped row of an eligible producer");
      assertEq(cartSvc.viewCart(cart.cart_id)?.item_count, 0, "s4-21: nothing was added");
      const okChoose = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "p-admin" });
      assertTrue(okChoose.success === true, "s4-22: a wish can choose an admin-confirmed row");
      // Re-choosing a scraped row is refused BEFORE the earlier choice is cleaned up.
      const re = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "p-scraped" });
      assertTrue(!re.success && re.status === 422, "s4-23: re-choosing a scraped row is refused");
      assertEq(cartSvc.viewCart(cart.cart_id)?.item_count, 1, "s4-24: the earlier choice and its cart line stay");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S4-2 — admin endpoint
    // ════════════════════════════════════════════════════════════════════════
    {
      const express = require("express");
      const catalog = require("../routes/marketplace-catalog") as typeof import("../routes/marketplace-catalog");
      const cartRoutes = require("../routes/marketplace-cart") as typeof import("../routes/marketplace-cart");
      const app = express();
      app.use(express.json());
      app.use("/admin/products", catalog.adminCatalogRouter);
      app.use("/api/marketplace/catalog", catalog.catalogRouter);
      app.use("/api/marketplace", cartRoutes.cartRouter);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; body?: any } = {}):
      Promise<{ status: number; body: any }> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.body !== undefined) { bodyStr = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(bodyStr)); }
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* html */ }
            resolve({ status: resp.statusCode || 0, body: parsed });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const AUTH = { "X-Admin-Key": ADMIN_KEY };
    const PATH = "/admin/products/producer-list";
    const productsOf = (agent: string) => db.prepare("SELECT * FROM products WHERE agent_id = ? ORDER BY name").all(agent) as any[];
    const goodList = [{ name: "Gårdsegg", price_nok: 60, unit: "brett" }];

    const noKey = await req("POST", PATH, { body: { agent_id: "ag-plain", products: goodList } });
    assertEq(noKey.status, 401, "s4-30: no X-Admin-Key -> 401");
    const badKey = await req("POST", PATH, { headers: { "X-Admin-Key": "wrong" }, body: { agent_id: "ag-plain", products: goodList } });
    assertEq(badKey.status, 401, "s4-31: wrong X-Admin-Key -> 401");
    assertEq(productsOf("ag-plain").length, 1, "s4-32: an unauthorised request writes nothing");

    const errCases: Array<[string, any, number]> = [
      ["missing agent_id", { products: goodList }, 400],
      ["products not an array", { agent_id: "ag-plain", products: "x" }, 400],
      ["empty list", { agent_id: "ag-plain", products: [] }, 400],
      ["too many products", { agent_id: "ag-plain", products: Array.from({ length: 101 }, (_, i) => ({ name: `V${i}`, price_nok: 1 })) }, 400],
      ["no price", { agent_id: "ag-plain", products: [{ name: "Egg" }] }, 400],
      ["price zero", { agent_id: "ag-plain", products: [{ name: "Egg", price_nok: 0 }] }, 400],
      ["price negative", { agent_id: "ag-plain", products: [{ name: "Egg", price_nok: -5 }] }, 400],
      ["price as text", { agent_id: "ag-plain", products: [{ name: "Egg", price_nok: "60 kr" }] }, 400],
      ["no name", { agent_id: "ag-plain", products: [{ price_nok: 60 }] }, 400],
      ["duplicate names", { agent_id: "ag-plain", products: [{ name: "Egg", price_nok: 60 }, { name: " egg ", price_nok: 61 }] }, 400],
      ["bad availability", { agent_id: "ag-plain", products: [{ name: "Egg", price_nok: 60, availability: "kanskje" }] }, 400],
      ["packaged without ingredients", { agent_id: "ag-plain", products: [{ name: "Syltetøy", price_nok: 80, packaged: true, allergens: [], net_weight: "250 g" }] }, 400],
      ["packaged without allergens", { agent_id: "ag-plain", products: [{ name: "Syltetøy", price_nok: 80, packaged: true, ingredients: "Jordbær, sukker", net_weight: "250 g" }] }, 400],
      ["packaged without net weight", { agent_id: "ag-plain", products: [{ name: "Syltetøy", price_nok: 80, packaged: true, ingredients: "Jordbær, sukker", allergens: [] }] }, 400],
      ["bad net weight", { agent_id: "ag-plain", products: [{ name: "Syltetøy", price_nok: 80, packaged: true, ingredients: "Jordbær", allergens: [], net_weight: "mye" }] }, 400],
      ["allergens not a list", { agent_id: "ag-plain", products: [{ name: "Syltetøy", price_nok: 80, allergens: "gluten" }] }, 400],
      ["one bad product among good ones", { agent_id: "ag-plain", products: [{ name: "Egg", price_nok: 60 }, { name: "Dårlig", price_nok: -1 }] }, 400],
      ["unknown producer", { agent_id: "finnes-ikke", products: goodList }, 404],
    ];
    for (const [label, body, status] of errCases) {
      const r = await req("POST", PATH, { headers: AUTH, body });
      assertEq(r.status, status, `s4-33: ${label} -> ${status}`);
    }
    assertTrue((await req("POST", PATH, { headers: AUTH, body: errCases[1]![1] })).body?.success === false, "s4-34: errors say success:false");
    {
      const r = await req("POST", PATH, { headers: AUTH, body: errCases[16]![1] });
      assertTrue(Array.isArray(r.body?.errors) && r.body.errors.some((e: string) => e.startsWith("products[1]")), "s4-35: the error names the failing product index");
    }
    assertEq(productsOf("ag-plain").length, 1, "s4-36: no validation failure wrote anything (one bad product = nothing written)");

    // 200: a plain good and a packaged food.
    const packagedList = [
      { name: "Gårdsegg", price_nok: 60, unit: "brett", description: "Frittgående høner" },
      { name: "Jordbærsyltetøy", price_nok: 85, unit: "glass", packaged: true, ingredients: "Jordbær 60 %, sukker, gelésukker", allergens: [], net_weight: "250 g" },
      { name: "Havrekjeks", price_nok: 45, unit: "pk", packaged: true, ingredients: "Havre, hvete, smør, salt", allergens: ["Gluten", "melk", "gluten"], net_weight: "1,5 kg" },
    ];
    const ok = await req("POST", PATH, { headers: AUTH, body: { agent_id: "ag-plain", products: packagedList } });
    assertTrue(ok.status === 200 && ok.body?.success === true && ok.body.inserted === 3 && ok.body.updated === 0, "s4-40: valid list -> 200, 3 inserted");
    {
      const rows = productsOf("ag-plain");
      assertEq(rows.length, 4, "s4-41: three new rows next to the scraped one");
      const syl = rows.find((r) => r.name === "Jordbærsyltetøy");
      assertEq(syl.availability_source, "admin_producer_confirmed", "s4-42: written with availability_source=admin_producer_confirmed");
      assertTrue(syl.availability === "in_stock" && syl.price_nok === 85 && !!syl.availability_updated_at, "s4-43: in stock, price and timestamp set");
      assertEq([syl.ingredients, syl.allergens, syl.net_weight], ["Jordbær 60 %, sukker, gelésukker", "[]", "250 g"], "s4-44: ingredients, allergens ([] = none stated) and net weight stored");
      const kjeks = rows.find((r) => r.name === "Havrekjeks");
      assertEq(JSON.parse(kjeks.allergens), ["gluten", "melk"], "s4-45: allergens normalised (lower-case, de-duplicated)");
      assertEq(rows.find((r) => r.name === "Gårdsegg").ingredients, null, "s4-46: a non-packaged row has no food info");
    }
    // Idempotent per name: same name again updates, never duplicates.
    const again = await req("POST", PATH, { headers: AUTH, body: { agent_id: "ag-plain", products: [{ name: "gårdsegg", price_nok: 65 }] } });
    assertTrue(again.status === 200 && again.body.inserted === 0 && again.body.updated === 1, "s4-47: the same name again updates (no duplicate)");
    assertEq(productsOf("ag-plain").filter((r) => r.name_norm === "gårdsegg").length, 1, "s4-48: still one row for the name");
    // A scraped row the admin confirms is converted (source + price).
    const conv = await req("POST", PATH, { headers: AUTH, body: { agent_id: "ag-plain", products: [{ name: "Vanlig honning", price_nok: 110 }] } });
    assertTrue(conv.status === 200 && conv.body.updated === 1, "s4-49: confirming a scraped row updates it");
    assertEq((db.prepare("SELECT availability_source AS s, price_nok AS p FROM products WHERE id = 'p-plain'").get() as any), { s: "admin_producer_confirmed", p: 110 }, "s4-50: …to admin_producer_confirmed with the confirmed price");

    // The catalog sync leaves a confirmed price alone (and still updates a scraped row's).
    db.prepare("UPDATE agent_knowledge SET products = ? WHERE agent_id = 'ag-plain'").run(JSON.stringify([
      { name: "Vanlig honning", price: "kr 999", category: "honey" },
      { name: "Nytt skrapet produkt", price: "kr 50", category: "vegetables" },
    ]));
    const syncRes = syncSvc.runProductCatalogSync(db as any);
    assertTrue(syncRes.success === true, "s4-55: the catalog sync runs");
    assertEq((db.prepare("SELECT price_nok AS p, availability_source AS s FROM products WHERE id = 'p-plain'").get() as any), { p: 110, s: "admin_producer_confirmed" }, "s4-56: the sync does not overwrite a confirmed price or source");
    assertEq((db.prepare("SELECT price_nok AS p, availability_source AS s FROM products WHERE agent_id = 'ag-plain' AND name_norm = 'nytt skrapet produkt'").get() as any), { p: 50, s: "enrichment" }, "s4-57: a new scraped row still arrives as enrichment");

    // End to end: after the admin entered the list, an eligible producer sells it; scraped rows stay refused.
    {
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = 'ag-plain'").run();
      assertTrue(cartSvc.isEligibleForRealOrder("ag-plain"), "s4-60: ag-plain now passes the gate (opt-in set for the test)");
      const cart = cartSvc.createCart();
      const syl = productsOf("ag-plain").find((r) => r.name === "Jordbærsyltetøy");
      const scr = productsOf("ag-plain").find((r) => r.name_norm === "nytt skrapet produkt");
      assertTrue(cartSvc.addCartItem(cart.cart_id, syl.id, 2).success === true, "s4-61: the admin-entered row is orderable");
      const r2 = cartSvc.addCartItem(cart.cart_id, scr.id, 1);
      assertTrue(!r2.success && r2.status === 422, "s4-62: the producer's remaining scraped row is refused");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S4-3 — price and food information are shown before submit (REST + MCP)
    // ════════════════════════════════════════════════════════════════════════
    {
      const syl = productsOf("ag-plain").find((r) => r.name === "Jordbærsyltetøy");
      const kjeks = productsOf("ag-plain").find((r) => r.name === "Havrekjeks");
      const egg = productsOf("ag-plain").find((r) => r.name_norm === "gårdsegg");
      const c = await req("POST", "/api/marketplace/cart");
      const H = { "X-Cart-Token": c.body.buyer_ref };
      for (const p of [syl, kjeks, egg]) {
        const a = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: H, body: { product_id: p.id, qty: 1 } });
        assertEq(a.status, 200, `s4-70: REST add of ${p.name} -> 200`);
      }
      const v = await req("GET", `/api/marketplace/cart/${c.body.cart_id}`, { headers: H });
      const items: any[] = v.body?.groups?.[0]?.items ?? [];
      const sItem = items.find((i) => i.product_name === "Jordbærsyltetøy");
      assertEq(sItem?.food_info, { ingredients: "Jordbær 60 %, sukker, gelésukker", allergens: [], net_weight: "250 g" }, "s4-71: REST view shows ingredients, allergens and net weight");
      assertEq(sItem?.unit_price_snapshot, 85, "s4-72: …and the price");
      assertEq(sItem?.producer_confirmed, true, "s4-73: …and that it is producer-confirmed");
      assertEq(items.find((i) => i.product_name === "Havrekjeks")?.food_info?.allergens, ["gluten", "melk"], "s4-74: declared allergens are listed");
      assertEq(items.find((i) => i.product_id === egg.id)?.food_info, null, "s4-75: a non-packaged row has food_info null");

      // MCP: the same service result, with no tool-definition change.
      const mcp = require("./mcp") as typeof import("./mcp");
      const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
      mcp.registerTools({
        registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
        resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
      } as any, () => "test-client", () => undefined);
      const json = async (tool: string, args: any) => JSON.parse(String((await tools.get(tool)!(args))?.content?.[0]?.text ?? "null"));
      const mc = await json("lokal_cart_create", {});
      const mAdd = await json("lokal_cart_add_item", { cart_id: mc.cart_id, buyer_ref: mc.buyer_ref, product_id: syl.id, qty: 1 });
      assertEq(mAdd?.cart?.groups?.[0]?.items?.[0]?.food_info?.net_weight, "250 g", "s4-80: MCP lokal_cart_add_item shows the food information in the cart");
      const mView = await json("lokal_cart_view", { cart_id: mc.cart_id, buyer_ref: mc.buyer_ref });
      assertEq(mView?.groups?.[0]?.items?.[0]?.food_info?.ingredients, "Jordbær 60 %, sukker, gelésukker", "s4-81: MCP lokal_cart_view shows ingredients");
      const mScr = await json("lokal_cart_add_item", { cart_id: mc.cart_id, buyer_ref: mc.buyer_ref, product_id: productsOf("ag-plain").find((r) => r.name_norm === "nytt skrapet produkt").id, qty: 1 });
      assertTrue(mScr?.success === false && String(mScr.error).startsWith("not_producer_confirmed"), "s4-82: MCP lokal_cart_add_item refuses a scraped row of an eligible producer");
      const mScr2 = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: H, body: { product_id: productsOf("ag-plain").find((r) => r.name_norm === "nytt skrapet produkt").id, qty: 1 } });
      assertTrue(mScr2.status === 422 && String(mScr2.body?.error).startsWith("not_producer_confirmed"), "s4-83: REST add of a scraped row -> 422");
      // Malformed stored allergens never break the view.
      db.prepare("UPDATE products SET allergens = '{kaputt' WHERE id = ?").run(syl.id);
      const v2 = await req("GET", `/api/marketplace/cart/${c.body.cart_id}`, { headers: H });
      assertEq(v2.status, 200, "s4-84: a malformed allergens value does not break the cart view");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S4-5 — fail closed when the gate cannot be evaluated (unconfirmedItemError catch)
    // ════════════════════════════════════════════════════════════════════════
    {
      // A producer who does not pass the gate: its scraped row is normally addable (as s4-07).
      insAgent.run("ag-s1", "Failclosed Gård", "s1@example.no", "k-s1");
      insKnow.run("ag-s1", "s1@example.no", null);
      insProd.run("p-s1", "ag-s1", "Skrapt fail-closed", "skrapt fail-closed", 40, "enrichment", null);
      // With the gate's own table unreadable the check throws; the row must then be refused, not sold.
      const cart = cartSvc.createCart();
      db.exec("ALTER TABLE agent_knowledge RENAME TO agent_knowledge_s4_away");
      let r: ReturnType<typeof cartSvc.addCartItem>;
      try { r = cartSvc.addCartItem(cart.cart_id, "p-s1", 1); }
      finally { db.exec("ALTER TABLE agent_knowledge_s4_away RENAME TO agent_knowledge"); }
      assertTrue(!r.success && r.status === 422 && r.error.startsWith("not_producer_confirmed"), "s4-90: gate cannot be evaluated -> scraped row refused (fail closed, 422)");
      assertEq(cartSvc.viewCart(cart.cart_id)?.item_count, 0, "s4-91: …and no cart line was written");
      const again = cartSvc.addCartItem(cart.cart_id, "p-s1", 1);
      assertTrue(again.success === true, "s4-92: with the gate readable again the same row is added (control)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // S4-4 — the offers answer (REST /catalog/offers + lokal_find_offers) carries the food information
    // ════════════════════════════════════════════════════════════════════════
    {
      const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
      const LAT = 59.9, LNG = 10.75;
      const addOffAgent = (id: string, name: string) => {
        db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, lat, lng, city, is_active, is_verified)
                    VALUES (?, ?, 'x', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]', ?, ?, 'Oslo', 1, 1)`)
          .run(id, name, `${id}@example.no`, `k-${id}`, LAT, LNG);
        db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email) VALUES (?, 'verified', ?)").run(id, `${id}@example.no`);
      };
      const addOffProd = (id: string, agent: string, name: string, source: string, extra: { ing?: string | null; all?: string | null; nw?: string | null } = {}) =>
        db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at, ingredients, allergens, net_weight)
                    VALUES (?, ?, ?, ?, 55, 'stk', 'in_stock', 'vegetables', ?, datetime('now'), ?, ?, ?)`)
          .run(id, agent, name, name.toLowerCase(), source, extra.ing ?? null, extra.all ?? null, extra.nw ?? null);
      const XSS = `<img src=x onerror=alert(1)>`;
      addOffAgent("ag-off-food", "Mat Gård"); addOffProd("p-off-food", "ag-off-food", "Fruktgele", "admin_producer_confirmed", { ing: XSS + "Frukt, sukker", all: JSON.stringify(["gluten", XSS]), nw: "200 g" });
      addOffAgent("ag-off-bare", "Bar Gård"); addOffProd("p-off-bare", "ag-off-bare", "Fruktkurv", "producer_dashboard");
      addOffAgent("ag-off-scr", "Skrap Gård"); addOffProd("p-off-scr", "ag-off-scr", "Fruktpai", "enrichment", { nw: "100 g" });
      const res = await findOffers({ q: "frukt", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      const byProd = (id: string) => res.offers.find((o) => o.product_id === id);
      assertEq(byProd("p-off-food")?.food_info, { ingredients: XSS + "Frukt, sukker", allergens: ["gluten", XSS], net_weight: "200 g" }, "s4-100: an offer carries ingredients, allergens and net weight (hostile text stays raw data)");
      assertEq(byProd("p-off-food")?.producer_confirmed, true, "s4-101: …and producer_confirmed");
      assertEq(byProd("p-off-food")?.price_nok, 55, "s4-102: …and the price");
      assertTrue(!!byProd("p-off-bare") && !("food_info" in byProd("p-off-bare")!) && !("producer_confirmed" in byProd("p-off-bare")!), "s4-103: an item without food information carries neither field (the answer is what it was)");
      assertEq(byProd("p-off-scr")?.food_info?.net_weight, "100 g", "s4-104: a scraped row with food information still shows it…");
      assertEq(byProd("p-off-scr")?.producer_confirmed, false, "s4-105: …and is not producer_confirmed");
      db.prepare("UPDATE products SET allergens = '{kaputt' WHERE id = 'p-off-food'").run();
      const res2 = await findOffers({ q: "frukt", lat: LAT, lng: LNG, radiusKm: 50, limit: 5 }, { db });
      assertEq(res2.offers.find((o) => o.product_id === "p-off-food")?.food_info?.allergens, null, "s4-106: malformed stored allergens do not break the offers answer");

      // REST + MCP return the same fields (same findOffers).
      const rest = await req("GET", `/api/marketplace/catalog/offers?q=frukt&lat=${LAT}&lng=${LNG}`);
      assertEq(rest.status, 200, "s4-107: REST offers 200");
      assertEq(rest.body?.offers?.find((o: any) => o.product_id === "p-off-food")?.food_info?.net_weight, "200 g", "s4-108: REST offers carry food_info");
      const mcp = require("./mcp") as typeof import("./mcp");
      const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
      mcp.registerTools({
        registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
        resource() {}, prompt() {}, registerResource() {}, registerPrompt() {},
      } as any, () => "test-client", () => undefined);
      const mo = JSON.parse(String((await tools.get("lokal_find_offers")!({ items: ["frukt"], lat: LAT, lng: LNG }))?.content?.[0]?.text ?? "null"));
      const moOffers: any[] = mo?.[0]?.offers ?? [];
      assertEq(moOffers.find((o) => o.product_id === "p-off-food")?.food_info?.net_weight, "200 g", "s4-109: lokal_find_offers carries food_info");
    }
  } catch (err) {
    failed++;
    failures.push(`order-bestillinger-skive4: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    cartSvc.__setCartTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── order-bestillinger-skive4 tests ──");
  runOrderBestillingerSkive4Tests({ log: true }).then((r) => {
    console.log(`\norder-bestillinger-skive4: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
