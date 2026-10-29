/**
 * order-bestillinger-skive1.test.ts — dev-request 2026-10-21-rfb-bestillinger-
 * klar-for-forste-ekte-handel, SKIVE 1 (F1–F10). No network, no real e-mail,
 * no production DB: a fresh in-memory SQLite with the real production schema,
 * the e-mail transport stubbed, and a fake clock for the follow-ups.
 *
 *   F2/AC2   contact info required for a real order (no order row, no e-mail)
 *   F3/AC3   buyer receipt at submit (flag), producer contact + /kjopsvilkar
 *   F4/AC4   reminder (+ admin alert) at 24 h, auto-cancel at 72 h without an
 *            order_declined trust event, one retry of a failed producer e-mail
 *   F5/AC5   cancel choices for pay-at-pickup orders with PAYMENTS_ENABLED off
 *   F6/AC6   no «0 kr» for lines without a price
 *   F8       Oslo time, no outreach header, per-producer caps -> handoff
 *   F9/AC7   alcohol and services refused (add + submit), eplemost allowed
 *   F10/AC10 GET /admin/orders/pilot-status 401 without key, 200 with
 *   (F1/AC1 and F7 are in owner-order-optin-handoff-stats.test.ts)
 *
 * Standalone: npx tsx src/routes/order-bestillinger-skive1.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderBestillingerSkive1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const receiptSvc = require("../services/order-receipt-service") as typeof import("../services/order-receipt-service");
  const followSvc = require("../services/order-followups") as typeof import("../services/order-followups");
  const trustSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
  const adminOrdersMod = require("../routes/admin-orders") as typeof import("../routes/admin-orders");
  const banSvc = require("../services/cart-item-ban") as typeof import("../services/cart-item-ban");
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");

  const ENV_KEYS = [
    "ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_REMINDER_HOURS",
    "ORDER_AUTOCANCEL_HOURS", "ORDER_CAP_OPEN_PENDING_PER_BUYER", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY",
    "PAYMENTS_ENABLED", "ORDER_NOTIFY_EMAIL_VERSION",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const ADMIN_KEY = "skive1-test-admin-key";
  const ADMIN_MAIL = "admin-varsel@example.test";

  // Captured sends (producer mail, admin alerts) and buyer receipts.
  const sent: Array<{ to: string; subject: string; textContent: string; htmlContent?: string; omitAgentHeader?: boolean }> = [];
  const receipts: Array<{ to: string; subject: string; textContent: string; omitAgentHeader?: boolean }> = [];
  let failSends = 0; // the next N producer/admin sends report failure
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    adminOrdersMod.__setAdminOrdersTestDb(db as any);
    followSvc.__setOrderFollowupsTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject, textContent: o.textContent, htmlContent: o.htmlContent, omitAgentHeader: o.omitAgentHeader });
      if (failSends > 0) { failSends--; return { success: false, error: "smtp down" }; }
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async (o) => {
      receipts.push({ to: o.to, subject: o.subject, textContent: o.textContent, omitAgentHeader: o.omitAgentHeader });
      return { success: true, messageId: "stub" };
    });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_MAIL;
    // The spam caps have their own cases below; keep them out of the way.
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
    process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";

    // ── Seed ────────────────────────────────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, ?)
    `);
    const insKnow = db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, ?)");
    const insProd = db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
      VALUES (?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, 'admin_producer_confirmed')
    `);
    const makeEligible = (id: string) => db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = ?").run(id);

    // Fruit farm: eplemost (allowed), unpriced cheese.
    insAgent.run("ag-eple", "Eple Gård", "eple@example.no", "k1", JSON.stringify(["fruit"]));
    insKnow.run("ag-eple", "eple@example.no", "+47 400 11 111");
    makeEligible("ag-eple");
    insProd.run("p-eplemost", "ag-eple", "Eplemost", "eplemost", 45, "flaske", "beverages", "Presset av egne epler");
    insProd.run("p-ost-uten-pris", "ag-eple", "Spesialost fra gården", "spesialost", null, "stk", "dairy", null);
    insProd.run("p-ost-med-pris", "ag-eple", "Gårdsost", "gardsost", 80, "stk", "dairy", null);

    // Distillery (Atlungstad Akevitt) and meeting-room farm (Røhne).
    insAgent.run("ag-atlungstad", "Atlungstad Brenneri", "brenneri@example.no", "k2", JSON.stringify(["beverages", "destilleri"]));
    insKnow.run("ag-atlungstad", "brenneri@example.no", null);
    makeEligible("ag-atlungstad");
    insProd.run("e6e89b26-0000-4000-8000-00000000a001", "ag-atlungstad", "Atlungstad Akevitt", "atlungstad akevitt", 499, "flaske", "beverages", null);
    insProd.run("p-atl-eplemost", "ag-atlungstad", "Eplemost fra brenneriet", "eplemost fra brenneriet", 40, "flaske", "beverages", "Alkoholfri");
    insAgent.run("ag-rohne", "Røhne Gård", "rohne@example.no", "k3", JSON.stringify(["other"]));
    insKnow.run("ag-rohne", "rohne@example.no", null);
    makeEligible("ag-rohne");
    insProd.run("2a99fc5a-0000-4000-8000-00000000b001", "ag-rohne", "Møterom med dagpakke", "moterom med dagpakke", 1200, "dag", "other", null);

    // Second eligible producer for caps and the 24 h reminder cases.
    insAgent.run("ag-bonde", "Bonde Gård", "bonde@example.no", "k4", JSON.stringify(["vegetables"]));
    insKnow.run("ag-bonde", "bonde@example.no", "+47 400 22 222");
    makeEligible("ag-bonde");
    insProd.run("p-bonde-potet", "ag-bonde", "Poteter", "poteter", 30, "kg", "vegetables", null);

    const BUYER = { buyer_name: "Kari Kjøper", buyer_email: "kari.kjoper@example.com", contact_consent: true };
    const ordersCount = () => (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n as number;
    const cartWith = (items: Array<[string, number]>): string => {
      const c = cartSvc.createCart();
      for (const [pid, qty] of items) {
        const r = cartSvc.addCartItem(c.cart_id, pid, qty);
        if (!r.success) throw new Error(`setup: add ${pid} failed: ${r.error}`);
      }
      return c.cart_id;
    };
    const tokenOf = (orderId: string) => (db.prepare("SELECT confirm_token FROM orders WHERE id = ?").get(orderId) as any).confirm_token as string;
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const SQL_NOW = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const hoursAgo = (h: number, from = new Date()) => SQL_NOW(new Date(from.getTime() - h * 3600_000));

    // ════════════════════════════════════════════════════════════════════════
    // F9 / AC7 — alcohol and services/experiences are refused; eplemost is not
    // ════════════════════════════════════════════════════════════════════════
    {
      const cart = cartSvc.createCart();
      const akevitt = cartSvc.addCartItem(cart.cart_id, "e6e89b26-0000-4000-8000-00000000a001", 1);
      assertTrue(!akevitt.success && akevitt.status === 422 && akevitt.error.startsWith("alcohol_not_orderable"), "ac7-01: Atlungstad Akevitt is refused (422 alcohol_not_orderable)");
      assertTrue(!akevitt.success && /alkohol/i.test(akevitt.error), "ac7-01b: the refusal explains why (alcohol)");
      const rohne = cartSvc.addCartItem(cart.cart_id, "2a99fc5a-0000-4000-8000-00000000b001", 1);
      assertTrue(!rohne.success && rohne.status === 422 && rohne.error.startsWith("service_not_orderable"), "ac7-02: Røhne «Møterom med dagpakke» is refused (422 service_not_orderable)");
      const most = cartSvc.addCartItem(cart.cart_id, "p-eplemost", 2);
      assertTrue(most.success === true, "ac7-03: Eplemost is allowed");
      const mostAtDistillery = cartSvc.addCartItem(cart.cart_id, "p-atl-eplemost", 1);
      assertTrue(mostAtDistillery.success === true, "ac7-04: an alcohol-free must from a distillery is allowed (explicit marker)");
      const view = cartSvc.viewCart(cart.cart_id);
      assertEq(view?.item_count, 2, "ac7-05: only the two allowed lines are in the cart");

      // Over REST too (the MCP tool calls the same service function).
      const express = require("express");
      const cartRoutes = require("../routes/marketplace-cart") as typeof import("../routes/marketplace-cart");
      const app = express();
      app.use(express.json());
      app.use("/api/marketplace", cartRoutes.cartRouter);
      app.use("/admin/marketplace", cartRoutes.adminOrderRouter);
      app.use("/produsent/ordre", cartRoutes.producerOrderRouter);
      app.use("/admin/orders", adminOrdersMod.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; body?: any; form?: Record<string, string> } = {}):
      Promise<{ status: number; body: any; text: string; location: string | undefined }> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) { bodyStr = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        else if (o.body !== undefined) { bodyStr = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* html */ }
            resolve({ status: resp.statusCode || 0, body: parsed, text: raw, location: resp.headers["location"] as string | undefined });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    {
      const c = await req("POST", "/api/marketplace/cart");
      const r1 = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: { "X-Cart-Token": c.body.buyer_ref }, body: { product_id: "e6e89b26-0000-4000-8000-00000000a001", qty: 1 } });
      assertTrue(r1.status === 422 && String(r1.body?.error).startsWith("alcohol_not_orderable"), "ac7-06: REST add of Atlungstad Akevitt -> 422");
      const r2 = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: { "X-Cart-Token": c.body.buyer_ref }, body: { product_id: "2a99fc5a-0000-4000-8000-00000000b001", qty: 1 } });
      assertTrue(r2.status === 422 && String(r2.body?.error).startsWith("service_not_orderable"), "ac7-07: REST add of Møterom med dagpakke -> 422");
      const r3 = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: { "X-Cart-Token": c.body.buyer_ref }, body: { product_id: "p-eplemost", qty: 1 } });
      assertTrue(r3.status === 200 && r3.body?.success === true, "ac7-08: REST add of Eplemost -> 200");
    }
    {
      // A banned row already in a cart (added before the rule, or the catalog row changed) stops the SUBMIT.
      const cart = cartSvc.createCart();
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-ban-1', ?, 'e6e89b26-0000-4000-8000-00000000a001', 'ag-atlungstad', 1, 499)").run(cart.cart_id);
      db.prepare("INSERT INTO cart_items (id, cart_id, product_id, agent_id, qty, unit_price_snapshot) VALUES ('ci-ban-2', ?, 'p-eplemost', 'ag-eple', 1, 45)").run(cart.cart_id);
      const before = ordersCount();
      sent.length = 0;
      const sub = cartSvc.submitCart(cart.cart_id, BUYER);
      assertTrue(!sub.success && sub.status === 422 && sub.error.startsWith("alcohol_not_orderable"), "ac7-09: submit with an alcohol line already in the cart -> 422");
      assertEq(!sub.success ? sub.banned_items?.map((b) => b.product_name) : null, ["Atlungstad Akevitt"], "ac7-10: the refusal names the banned line");
      assertEq(ordersCount(), before, "ac7-11: no order row for any producer in that cart");
      assertEq((db.prepare("SELECT status FROM carts WHERE id = ?").get(cart.cart_id) as any).status, "open", "ac7-12: the cart stays open");
      await settle();
      assertEq(sent.length, 0, "ac7-13: no e-mail");
      // A wish may not pick a banned product either.
      const w = cartSvc.addCartWish(cart.cart_id, "akevitt", 1);
      if (w.success) {
        const ch = cartSvc.chooseCartWishOffer(cart.cart_id, w.wish.id, { productId: "e6e89b26-0000-4000-8000-00000000a001" });
        assertTrue(!ch.success && ch.status === 422, "ac7-14: a wish cannot choose the banned product (refused before its row is touched)");
      }
    }
    {
      // Classifier matrix (pure). Fail-closed deny-list with an explicit alcohol-free way out.
      const c = (name: string, category?: string, producerTypes: string[] = [], description?: string) =>
        banSvc.classifyCartItemBan({ name, category, producerTypes, description })?.kind ?? null;
      for (const n of ["Atlungstad Akevitt", "Gårdsøl", "Rødvin", "Eplesider", "Mjød fra egen bigård", "Gin", "Whisky 12 år", "Hvitvin Solaris", "Juleøl", "Brennevin", "Hardcider", "Pilsner"]) {
        assertEq(c(n), "alcohol", `ban-alcohol: «${n}»`);
      }
      for (const n of ["Møterom med dagpakke", "Omvisning på gården", "Smaking for grupper", "Middag for 8", "Overnatting i stabburet", "Kurs i ostelaging", "Guidet tur", "Gårdsbesøk med lunsj"]) {
        assertEq(c(n), "service", `ban-service: «${n}»`);
      }
      for (const n of ["Eplemost", "Eplesaft", "Solbærsaft", "Egg", "Poteter", "Torskerom", "Rømmegrot", "Honning", "Gårdsost", "Lagret ost", "Alkoholfri øl", "Øl 0,0 %", "Kaffe"]) {
        assertEq(c(n), null, `ban-allowed: «${n}»`);
      }
      assertEq(c("Lokal drikke", "beverages", ["bryggeri"]), "alcohol", "ban-type: a brewery's unlabelled beverage is alcohol (fail-closed)");
      assertEq(c("Eplemost", "beverages", ["bryggeri"]), null, "ban-type: …but a brewery's eplemost is allowed");
      assertEq(c("Eplemost", "beverages"), null, "ban-cat: beverages + eplemost is allowed");
      assertEq(c("Spesialdrikk", "beverages", [], "En sterk drikk med alkohol"), "alcohol", "ban-cat: beverages + an alcohol word in the description");
      assertEq(c("Spesialdrikk", "dairy", [], "En sterk drikk med alkohol"), null, "ban-cat: an alcohol word in the description alone is not enough outside beverages");
      assertEq(c("Opplevelse for to", "experience"), "service", "ban-cat: a service category");
      assertEq(c("Operapub fredag 18. desember", "Arrangement"), "service", "ban-cat: a shop's own «Arrangement» category is a service");
      assertEq(c("Whisky", "alcohol"), "alcohol", "ban-cat: an alcohol category");
      assertEq(c(null as any), null, "ban-edge: null name never throws");
    }

    // ════════════════════════════════════════════════════════════════════════
    // F2 / AC2 — a real order needs contact info (consent + e-mail or phone)
    // ════════════════════════════════════════════════════════════════════════
    {
      sent.length = 0; receipts.length = 0;
      const cartId = cartWith([["p-bonde-potet", 2]]);
      const before = ordersCount();
      const bad: Array<[string, any]> = [
        ["no contact fields at all", undefined],
        ["consent only", { contact_consent: true }],
        ["e-mail without consent", { buyer_email: "kari@example.com", contact_consent: false }],
        ["implausible e-mail + short phone", { contact_consent: true, buyer_email: "kari", buyer_phone: "12" }],
      ];
      for (const [label, contact] of bad) {
        const r = cartSvc.submitCart(cartId, contact);
        assertTrue(!r.success && r.status === 422 && r.error.startsWith("contact_required"), `ac2: ${label} -> 422 contact_required`);
      }
      assertEq(ordersCount(), before, "ac2-05: no order row after the refused submits");
      await settle();
      assertEq(sent.length + receipts.length, 0, "ac2-06: no e-mail (producer or buyer)");
      assertEq((db.prepare("SELECT status FROM carts WHERE id = ?").get(cartId) as any).status, "open", "ac2-07: the cart is still open for a retry");
      // Through the REST route as well.
      const c = await req("POST", "/api/marketplace/cart");
      await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: { "X-Cart-Token": c.body.buyer_ref }, body: { product_id: "p-bonde-potet", qty: 1 } });
      const rr = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/submit`, { body: { buyer_ref: c.body.buyer_ref } });
      assertTrue(rr.status === 422 && String(rr.body?.error).includes("contact_required") && !rr.body?.orders, "ac2-08: REST submit without contact -> 422 with the contact_required message");
      // MCP lokal_cart_submit shares cartSvc.submitCart (paymentsOn=false) — the service result IS the tool result.
      const ok = cartSvc.submitCart(cartId, { buyer_phone: "+47 400 33 333", contact_consent: true });
      assertTrue(ok.success === true && ok.orders.length === 1, "ac2-09: consent + phone only is enough");
      // A cart that is all contact-handoffs needs no buyer contact.
      db.prepare("INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key) VALUES ('ag-plain', 'Vanlig Gård', 'x', 'self', 'plain@example.no', 'https://x.no', 'producer', 'kp')").run();
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status) VALUES ('ag-plain', 'verified')").run();
      insProd.run("p-plain", "ag-plain", "Honning av lynghei", "honning av lynghei", 90, "glass", "honey", null);
      const hand = cartSvc.submitCart(cartWith([["p-plain", 1]]));
      assertTrue(hand.success === true && hand.orders.length === 0 && hand.contact_handoffs.length === 1, "ac2-10: a cart with only a non-opted-in producer still gives a handoff without any contact info");
    }

    // ════════════════════════════════════════════════════════════════════════
    // F3 / AC3 — buyer receipt at submit (flag), with producer contact + terms
    // ════════════════════════════════════════════════════════════════════════
    {
      sent.length = 0; receipts.length = 0;
      // Flag off (default): no receipt.
      const offId = cartWith([["p-bonde-potet", 1]]);
      cartSvc.submitCart(offId, BUYER);
      await settle();
      assertEq(receipts.length, 0, "ac3-01: ORDER_BUYER_RECEIPTS_ENABLED unset -> no receipt at submit");
      assertEq(sent.filter((m) => m.to === "bonde@example.no").length, 1, "ac3-02: the producer is still told");

      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      receipts.length = 0; sent.length = 0;
      const cartId = cartWith([["p-bonde-potet", 3]]);
      const r = cartSvc.submitCart(cartId, BUYER);
      await settle();
      assertTrue(r.success === true && r.orders.length === 1, "ac3-03: order created with the flag on");
      assertEq(receipts.length, 1, "ac3-04: exactly one buyer receipt at submit");
      const m = receipts[0]!;
      assertEq(m.to, "kari.kjoper@example.com", "ac3-05: sent to the buyer's own address");
      assertTrue(m.textContent.includes("Bonde Gård") && m.textContent.includes("bonde@example.no") && m.textContent.includes("+47 400 22 222"), "ac3-06: producer name + contact info (e-mail, phone)");
      assertTrue(m.textContent.includes("/kjopsvilkar"), "ac3-07: link to /kjopsvilkar");
      assertTrue(m.textContent.includes("forespørsel") && m.textContent.includes("bekreftet"), "ac3-08: says the order is a request until the producer confirms");
      assertTrue(m.textContent.includes("betaler Bonde Gård ved henting"), "ac3-09: says payment is at pickup");
      assertTrue(m.textContent.includes("Poteter") && m.textContent.includes("× Poteter"), "ac3-10: lists the items");
      assertEq(m.omitAgentHeader, true, "ac3-11: sent without the outreach header (F8)");
      // A refused submit sends no receipt (covered in ac2); an order for a capped producer neither (below).
      delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════════
    // F6 / AC6 — no «0 kr» for lines without a price
    // ════════════════════════════════════════════════════════════════════════
    {
      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      sent.length = 0; receipts.length = 0;
      const allUnpriced = cartSvc.submitCart(cartWith([["p-ost-uten-pris", 1]]), BUYER);
      await settle();
      assertTrue(allUnpriced.success === true && allUnpriced.orders[0]!.total_is_partial === true, "ac6-01: submit result flags total_is_partial");
      const prod1 = sent.find((m) => m.to === "eple@example.no")!;
      assertTrue(!!prod1 && !/0 kr/.test(prod1.textContent) && !/0 kr/.test(prod1.htmlContent || ""), "ac6-02: producer e-mail has no «0 kr» (all lines unpriced)");
      assertTrue(prod1.textContent.includes("Pris avtales med produsenten") && !/Sum/.test(prod1.textContent), "ac6-03: …says «Pris avtales med produsenten» and shows no sum at all");
      assertTrue(receipts.length === 1 && !/0 kr/.test(receipts[0]!.textContent) && receipts[0]!.textContent.includes("Pris avtales med produsenten"), "ac6-04: buyer receipt has no «0 kr»");

      sent.length = 0; receipts.length = 0;
      const mixed = cartSvc.submitCart(cartWith([["p-ost-uten-pris", 1], ["p-ost-med-pris", 2]]), { ...BUYER, buyer_email: "mix@example.com" });
      await settle();
      assertTrue(mixed.success === true && mixed.orders[0]!.total_nok === 160 && mixed.orders[0]!.total_is_partial === true, "ac6-05: mixed order: total 160 over the priced line, total_is_partial true");
      const prod2 = sent.find((m) => m.to === "eple@example.no")!;
      assertTrue(prod2.textContent.includes("Sum for varer med pris: 160 kr") && prod2.textContent.includes("Pris avtales med produsenten") && !/\b0 kr/.test(prod2.textContent), "ac6-06: producer e-mail: «Sum for varer med pris: 160 kr», unpriced line says so, no «0 kr»");
      assertTrue(receipts[0]!.textContent.includes("Sum for varer med pris: 160 kr") && !/\b0 kr/.test(receipts[0]!.textContent), "ac6-07: receipt: partial sum labelled, no «0 kr»");

      // The producer order page and the API.
      const oid = mixed.success ? mixed.orders[0]!.order_id : "";
      const page = await req("GET", `/produsent/ordre/${tokenOf(oid)}`);
      assertTrue(page.status === 200 && page.text.includes("Pris avtales med produsenten") && page.text.includes("Sum for varer med pris:") && !/\(0 kr\)/.test(page.text), "ac6-08: producer order page: price by agreement + partial-sum label");
      const bref = (db.prepare("SELECT buyer_ref FROM orders WHERE id = ?").get(oid) as any).buyer_ref;
      const api = await req("GET", `/api/marketplace/orders/${oid}`, { headers: { "X-Cart-Token": bref } });
      assertTrue(api.status === 200 && api.body.total_is_partial === true, "ac6-09: GET /orders/:id carries total_is_partial: true");
      const fullyPriced = cartSvc.submitCart(cartWith([["p-ost-med-pris", 1]]), { ...BUYER, buyer_email: "full@example.com" });
      assertTrue(fullyPriced.success === true && fullyPriced.orders[0]!.total_is_partial === false, "ac6-10: a fully priced order is not partial");
      const cartView = cartSvc.viewCart(cartWith([["p-ost-uten-pris", 1]]));
      assertTrue(cartView?.total_is_partial === true, "ac6-11: the cart view carries total_is_partial too");
      delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════════
    // F8 — no outreach header, Oslo time, spam caps
    // ════════════════════════════════════════════════════════════════════════
    {
      // Wire level: the real EmailService with a stub transport.
      const svc: any = emailMod.emailService;
      const prevConfigured = svc.isConfigured;
      const prevTransporter = svc.transporter;
      const wire: any[] = [];
      svc.isConfigured = true;
      svc.transporter = { sendMail: async (o: any) => { wire.push(o); return { messageId: "wire" }; } };
      try {
        try { require("../config/vertical-config").loadConfigsAtBoot(); } catch { /* already loaded */ }
        await svc.sendEmail({ to: "a@example.no", subject: "s", textContent: "t", omitAgentHeader: true });
        await svc.sendEmail({ to: "a@example.no", subject: "s", textContent: "t" });
        assertTrue(wire.length === 2 && !("X-Lokal-Agent" in (wire[0].headers || {})), "f8-01: omitAgentHeader -> no X-Lokal-Agent header on the wire");
        assertEq(wire[1]?.headers?.["X-Lokal-Agent"], "outreach-system/v1", "f8-02: other mail keeps the header (unchanged)");
        // End to end through the real producer-notification and receipt senders.
        notifySvc.__setOrderNotifySendForTesting(null);
        receiptSvc.__setBuyerReceiptSendForTesting(null);
        process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
        wire.length = 0;
        // EMAIL_FORCE_DRY_RUN is irrelevant: the stub transporter is not the env transporter.
        cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "wire@example.com" });
        await settle(); await settle();
        const orderMail = wire.find((w) => w.to === "bonde@example.no");
        const receiptMail = wire.find((w) => w.to === "wire@example.com");
        assertTrue(!!orderMail && !("X-Lokal-Agent" in (orderMail.headers || {})), "f8-03: producer order e-mail has no outreach header");
        assertTrue(!!receiptMail && !("X-Lokal-Agent" in (receiptMail.headers || {})), "f8-04: buyer receipt has no outreach header");
        delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
      } finally {
        svc.isConfigured = prevConfigured;
        svc.transporter = prevTransporter;
        notifySvc.__setOrderNotifySendForTesting(async (o) => {
          sent.push({ to: o.to, subject: o.subject, textContent: o.textContent, htmlContent: o.htmlContent, omitAgentHeader: o.omitAgentHeader });
          if (failSends > 0) { failSends--; return { success: false, error: "smtp down" }; }
          return { success: true, messageId: "stub" };
        });
        receiptSvc.__setBuyerReceiptSendForTesting(async (o) => {
          receipts.push({ to: o.to, subject: o.subject, textContent: o.textContent, omitAgentHeader: o.omitAgentHeader });
          return { success: true, messageId: "stub" };
        });
      }
      sent.length = 0;
      cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "hdr@example.com" });
      await settle();
      assertTrue(sent.length === 1 && sent[0]!.omitAgentHeader === true, "f8-05: order mail requests omitAgentHeader");

      // Oslo time on the producer page: 2026-01-15 12:00:00 UTC is 13:00 in Oslo (CET), 2026-07-15 12:00 UTC is 14:00 (CEST).
      const winter = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "tz@example.com" });
      const wOid = winter.success ? winter.orders[0]!.order_id : "";
      db.prepare("UPDATE orders SET created_at = '2026-01-15 12:00:00' WHERE id = ?").run(wOid);
      let page = await req("GET", `/produsent/ordre/${tokenOf(wOid)}`);
      assertTrue(page.text.includes("15. januar kl. 13:00") && !page.text.includes("2026-01-15 12:00:00"), "f8-06: winter: created_at shown in Oslo time (13:00), not UTC");
      db.prepare("UPDATE orders SET created_at = '2026-07-15 12:00:00' WHERE id = ?").run(wOid);
      page = await req("GET", `/produsent/ordre/${tokenOf(wOid)}`);
      assertTrue(page.text.includes("15. juli kl. 14:00"), "f8-07: summer: shown as 14:00 (CEST)");
    }
    {
      // Caps: N open pending orders per buyer address and producer, M new per producer per 24 h.
      process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "3";
      process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";
      assertEq([cartSvc.orderCapOpenPerBuyer(), cartSvc.orderCapNewPerDay()], [3, 1000], "f8-08: caps read from env");
      delete process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY;
      assertEq([cartSvc.orderCapOpenPerBuyer(), cartSvc.orderCapNewPerDay()], [3, 10], "f8-08b: defaults are N=3, M=10");
      process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";
      sent.length = 0;
      const spam = { buyer_name: "Spam", buyer_email: "Spam@Example.com", contact_consent: true };
      const results: any[] = [];
      for (let i = 0; i < 4; i++) results.push(cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), spam));
      assertEq(results.map((r) => (r.success ? r.orders.length : -1)), [1, 1, 1, 0], "f8-09: the 4th open order from the same address becomes no order");
      assertTrue(results[3].success === true && results[3].contact_handoffs.length === 1 && results[3].contact_handoffs[0].agent_id === "ag-bonde", "f8-10: …a contact handoff instead");
      await settle();
      assertEq(sent.filter((m) => m.to === "bonde@example.no").length, 3, "f8-11: only 3 producer e-mails (the capped one sent none)");
      const other = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "annen@example.com" });
      assertTrue(other.success === true && other.orders.length === 1, "f8-12: another buyer address is not affected");
      const otherProducer = cartSvc.submitCart(cartWith([["p-eplemost", 1]]), spam);
      assertTrue(otherProducer.success === true && otherProducer.orders.length === 1, "f8-13: the same address can still order from another producer");
      // Answering the open orders frees the slot.
      const open = db.prepare("SELECT id FROM orders WHERE agent_id = 'ag-bonde' AND status = 'pending' AND lower(buyer_email) = 'spam@example.com'").all() as Array<{ id: string }>;
      cartSvc.transitionOrder(open[0]!.id, "declined", { actor: "test" });
      const again = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), spam);
      assertTrue(again.success === true && again.orders.length === 1, "f8-14: once an open order is answered the buyer can order again");
      // M per producer per rolling 24 h.
      process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
      process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "2";
      const countToday = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = 'ag-bonde' AND created_at >= datetime('now', '-1 day')").get() as any).n;
      assertTrue(countToday >= 2, "f8-15: setup: the producer already has >= 2 orders in the last 24 h");
      const capped = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "ny@example.com" });
      assertTrue(capped.success === true && capped.orders.length === 0 && capped.contact_handoffs.length === 1, "f8-16: over M new orders per day -> handoff, no order");
      db.prepare("UPDATE orders SET created_at = datetime('now', '-2 days') WHERE agent_id = 'ag-bonde'").run();
      const freed = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "ny2@example.com" });
      assertTrue(freed.success === true && freed.orders.length === 1, "f8-17: orders older than 24 h do not count");
      process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
      process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "1000";
    }

    // ════════════════════════════════════════════════════════════════════════
    // F4 / AC4 — reminder + admin alert at 24 h, auto-cancel at 72 h (fake clock)
    // ════════════════════════════════════════════════════════════════════════
    {
      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      // Isolate: orders from the earlier blocks are answered, so only this block's orders are open.
      db.prepare("UPDATE orders SET status = 'completed' WHERE status = 'pending'").run();
      sent.length = 0; receipts.length = 0;
      const sub = cartSvc.submitCart(cartWith([["p-bonde-potet", 2]]), { ...BUYER, buyer_email: "f4@example.com" });
      const oid = sub.success ? sub.orders[0]!.order_id : "";
      await settle();
      assertTrue(!!(db.prepare("SELECT notify_sent_at FROM orders WHERE id = ?").get(oid) as any).notify_sent_at, "1b-b1-10: a producer e-mail that was sent stamps notify_sent_at");
      const T0 = new Date("2026-03-10T08:00:00Z");
      db.prepare("UPDATE orders SET created_at = ?, notify_sent_at = ? WHERE id = ?").run(SQL_NOW(T0), SQL_NOW(T0), oid);
      const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
      const link = `/produsent/ordre/${tokenOf(oid)}`;
      sent.length = 0;

      let res = await followSvc.processOrderFollowups({ now: at(23) });
      assertEq([res.reminders_sent, res.cancelled], [0, 0], "ac4-01: at 23 h nothing happens");
      assertEq(sent.length, 0, "ac4-02: …no e-mail");
      res = await followSvc.processOrderFollowups({ now: at(25) });
      assertEq(res.reminders_sent, 1, "ac4-03: at 25 h: one reminder");
      const toProducer = sent.filter((m) => m.to === "bonde@example.no");
      const toAdmin = sent.filter((m) => m.to === ADMIN_MAIL);
      assertTrue(toProducer.length === 1 && toProducer[0]!.textContent.includes(link) && /Påminnelse/.test(toProducer[0]!.subject), "ac4-04: the producer gets a reminder with the same link");
      assertEq(toAdmin.length, 1, "ac4-05: the admin gets one alert at the same time");
      assertTrue(!!(db.prepare("SELECT reminder_sent_at FROM orders WHERE id = ?").get(oid) as any).reminder_sent_at, "ac4-06: reminder_sent_at is stamped");
      res = await followSvc.processOrderFollowups({ now: at(30) });
      res = await followSvc.processOrderFollowups({ now: at(60) });
      assertEq(sent.filter((m) => m.to === "bonde@example.no").length, 1, "ac4-07: never a second reminder");
      assertEq(sent.filter((m) => m.to === ADMIN_MAIL).length, 1, "ac4-08: never a second alert");
      assertEq((db.prepare("SELECT status FROM orders WHERE id = ?").get(oid) as any).status, "pending", "ac4-09: still pending before 72 h");

      receipts.length = 0;
      const declinedBefore = (db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE event_type = 'order_declined'").get() as any).n;
      res = await followSvc.processOrderFollowups({ now: at(73) });
      await settle();
      const row = db.prepare("SELECT status, cancel_reason FROM orders WHERE id = ?").get(oid) as any;
      assertEq([row.status, row.cancel_reason], ["cancelled", "producer_no_response"], "ac4-10: at 73 h the order is cancelled / producer_no_response");
      assertEq(res.cancelled, 1, "ac4-11: reported as cancelled");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE event_type = 'order_declined'").get() as any).n, declinedBefore, "ac4-12: no order_declined trust event");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE ref = ?").get(oid) as any).n, 0, "ac4-13: no trust event of any kind for the order");
      assertTrue(!!(db.prepare("SELECT 1 FROM order_events WHERE order_id = ? AND to_status = 'cancelled' AND actor = 'system'").get(oid)), "ac4-14: the timeline records the system cancellation");
      assertTrue(receipts.length === 1 && receipts[0]!.to === "f4@example.com" && receipts[0]!.textContent.includes("bonde@example.no") && receipts[0]!.textContent.includes("ikke svart"), "ac4-15: the buyer is told, with the producer's contact info (receipts on)");
      const again = await followSvc.processOrderFollowups({ now: at(100) });
      assertEq([again.cancelled, again.reminders_sent], [0, 0], "ac4-16: idempotent: nothing more on a cancelled order");

      // Configurable deadlines.
      process.env.ORDER_REMINDER_HOURS = "2";
      process.env.ORDER_AUTOCANCEL_HOURS = "4";
      const s2 = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "f4b@example.com" });
      const oid2 = s2.success ? s2.orders[0]!.order_id : "";
      await settle(); // skive 1b (B1): only an order the producer received gets follow-ups
      db.prepare("UPDATE orders SET created_at = ?, notify_sent_at = ? WHERE id = ?").run(SQL_NOW(T0), SQL_NOW(T0), oid2);
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: at(3) });
      assertEq(res.reminders_sent, 1, "ac4-17: ORDER_REMINDER_HOURS=2 -> reminder at 3 h");
      res = await followSvc.processOrderFollowups({ now: at(5) });
      assertEq((db.prepare("SELECT cancel_reason FROM orders WHERE id = ?").get(oid2) as any).cancel_reason, "producer_no_response", "ac4-18: ORDER_AUTOCANCEL_HOURS=4 -> cancelled at 5 h");
      delete process.env.ORDER_REMINDER_HOURS;
      delete process.env.ORDER_AUTOCANCEL_HOURS;
      assertEq([followSvc.orderReminderHours(), followSvc.orderAutocancelHours()], [24, 72], "ac4-19: defaults are 24 and 72");

      // Failed producer e-mail: admin alert at once, ONE retry later, then no more.
      sent.length = 0;
      failSends = 1; // the producer mail fails; the admin alert after it succeeds
      const s3 = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "f4c@example.com" });
      const oid3 = s3.success ? s3.orders[0]!.order_id : "";
      await settle();
      assertTrue(!!(db.prepare("SELECT notify_failed_at FROM orders WHERE id = ?").get(oid3) as any).notify_failed_at, "ac4-20: a failed producer e-mail is marked on the order");
      assertEq(sent.filter((m) => m.to === ADMIN_MAIL && m.subject.includes("feilet")).length, 1, "ac4-21: the admin is alerted at once");
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: new Date() });
      assertEq(res.retried, 1, "ac4-22: the job retries the producer e-mail once");
      assertEq(sent.filter((m) => m.to === "bonde@example.no").length, 1, "ac4-23: …the producer finally gets the order");
      assertTrue(!!(db.prepare("SELECT notify_sent_at FROM orders WHERE id = ?").get(oid3) as any).notify_sent_at, "1b-b1-11: a retry that succeeds stamps notify_sent_at");
      res = await followSvc.processOrderFollowups({ now: new Date() });
      assertEq(res.retried, 0, "ac4-24: no second retry");
      // A retry that fails too: one more alert, then silence.
      failSends = 1;
      const s4 = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "f4d@example.com" });
      await settle();
      sent.length = 0;
      failSends = 1;
      res = await followSvc.processOrderFollowups({ now: new Date() });
      assertEq(sent.filter((m) => m.to === ADMIN_MAIL && m.subject.includes("nytt forsøk")).length, 1, "ac4-25: a failed retry alerts the admin once more");
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: new Date() });
      assertEq(sent.length, 0, "ac4-26: …and is not retried again");
      void s4;
      delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
    }
    {
      // A prepay order has its own deadline job (payment_expired): the follow-ups leave it alone.
      const sub = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: "pp@example.com" });
      const oid = sub.success ? sub.orders[0]!.order_id : "";
      db.prepare("UPDATE orders SET payment_mode = 'prepay', created_at = '2020-01-01 00:00:00' WHERE id = ?").run(oid);
      sent.length = 0;
      const res = await followSvc.processOrderFollowups({ now: new Date("2026-03-20T00:00:00Z") });
      assertEq((db.prepare("SELECT status FROM orders WHERE id = ?").get(oid) as any).status, "pending", "ac4-27: a prepay order is not touched by the follow-ups");
      void res;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Skive 1b — B1: follow-ups only for orders the producer actually RECEIVED
    // (notify_sent_at); S4: the reminder alert states the outcome; S5: the
    // reminder UPDATE guard on its own; S6: an unreadable payment_mode is
    // fail-closed; S1: the F9 word lists.
    // ════════════════════════════════════════════════════════════════════════
    {
      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      db.prepare("UPDATE orders SET status = 'completed' WHERE status = 'pending'").run();
      const T0 = new Date("2026-03-10T08:00:00Z");
      const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
      const submitOne = async (email: string): Promise<string> => {
        const r = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: email });
        await settle();
        return r.success ? r.orders[0]!.order_id : "";
      };
      const rowOf = (id: string) => db.prepare("SELECT status, cancel_reason, reminder_sent_at, notify_sent_at FROM orders WHERE id = ?").get(id) as any;
      const notAnswered = () => receipts.filter((m) => m.textContent.includes("ikke svart"));

      // (i) The pre-gate backlog: an old pending order no code ever sent to the producer.
      const legacyId = await submitOne("legacy@example.com");
      db.prepare("UPDATE orders SET notify_sent_at = NULL, created_at = ? WHERE id = ?").run(SQL_NOW(T0), legacyId);
      sent.length = 0; receipts.length = 0;
      let res = await followSvc.processOrderFollowups({ now: at(25) });
      res = await followSvc.processOrderFollowups({ now: at(24 * 120) });
      const lrow = rowOf(legacyId);
      assertEq([lrow.status, lrow.cancel_reason, lrow.reminder_sent_at], ["pending", null, null], "1b-b1-01: an old order never sent to the producer is neither reminded about nor cancelled");
      assertEq(sent.length + receipts.length, 0, "1b-b1-02: …and nobody gets an e-mail about it");
      assertEq([res.examined, res.cancelled, res.reminders_sent], [0, 0, 0], "1b-b1-03: the job does not pick it up at all");
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(legacyId);

      // (ii) A SKIPPED send (the producer turned orders off between the submit and the e-mail).
      const skId = await submitOne("skipped@example.com");
      db.prepare("UPDATE orders SET notify_sent_at = NULL, created_at = ? WHERE id = ?").run(SQL_NOW(T0), skId);
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = 'ag-bonde'").run();
      sent.length = 0; receipts.length = 0;
      const outcome = await notifySvc.sendOrderNotificationForOrder(cartSvc.buildOrderNotificationInput(skId)!);
      assertEq(outcome, "skipped", "1b-b1-04: the producer e-mail is skipped");
      assertEq(rowOf(skId).notify_sent_at, null, "1b-b1-05: a skipped send leaves notify_sent_at empty");
      assertEq(sent.filter((m) => m.to === ADMIN_MAIL && m.subject.includes("ble ikke sendt")).length, 1, "1b-b1-06: the admin is told once that the producer e-mail was not sent");
      assertEq(sent.filter((m) => m.to === "bonde@example.no").length, 0, "1b-b1-07: nothing goes to the producer");
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: at(100) });
      const srow = rowOf(skId);
      assertEq([srow.status, srow.cancel_reason], ["pending", null], "1b-b1-08: a skipped order is never cancelled as producer_no_response");
      assertEq(notAnswered().length, 0, "1b-b1-09: the buyer never gets the «har ikke svart» receipt for it");
      assertEq(sent.length, 0, "1b-b1-12: no reminder and no further alert for it");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-bonde'").run();
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(skId);
      // (iii) AC4 for orders that WERE sent is unchanged: ac4-01…ac4-26 above (now with notify_sent_at).

      // S4: the reminder alert says what actually happened to the reminder.
      const s4Id = await submitOne("s4@example.com");
      db.prepare("UPDATE orders SET created_at = ?, notify_sent_at = ? WHERE id = ?").run(SQL_NOW(T0), SQL_NOW(T0), s4Id);
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = 'ag-bonde'").run();
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: at(25) });
      const s4Alert = sent.find((m) => m.to === ADMIN_MAIL && m.subject.includes("ubesvart"));
      assertEq(res.reminders_sent, 0, "1b-s4-01: a reminder that could not be sent is not counted as sent");
      assertTrue(!!s4Alert && s4Alert.textContent.includes("Påminnelsen ble ikke sendt") && !s4Alert.textContent.includes("har fått én påminnelse"), "1b-s4-02: …and the alert says it was not sent");
      assertTrue(!!rowOf(s4Id).reminder_sent_at, "1b-s4-03: the reminder step is still spent (no retry loop)");
      assertEq(sent.filter((m) => m.to === ADMIN_MAIL).length, 1, "1b-s4-05: a skipped reminder gives exactly one admin alert");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-bonde'").run();
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(s4Id);
      const s4bId = await submitOne("s4b@example.com");
      db.prepare("UPDATE orders SET created_at = ?, notify_sent_at = ? WHERE id = ?").run(SQL_NOW(T0), SQL_NOW(T0), s4bId);
      sent.length = 0;
      failSends = 1; // the reminder fails; the alerts after it go through
      res = await followSvc.processOrderFollowups({ now: at(25) });
      const s4bAlert = sent.find((m) => m.to === ADMIN_MAIL && m.subject.includes("ubesvart"));
      assertTrue(!!s4bAlert && s4bAlert.textContent.includes("kunne ikke sendes") && res.reminders_sent === 0, "1b-s4-04: a failed reminder: the alert says it could not be sent");
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(s4bId);

      // S5: the reminder UPDATE guard on its own — a run that read reminder_sent_at as NULL
      // before another run stamped it must not send a second reminder.
      const s5Id = await submitOne("s5@example.com");
      db.prepare("UPDATE orders SET created_at = ?, notify_sent_at = ? WHERE id = ?").run(SQL_NOW(T0), SQL_NOW(T0), s5Id);
      const stale = { id: s5Id, agent_id: "ag-bonde", created_at: SQL_NOW(T0), notify_sent_at: SQL_NOW(T0), reminder_sent_at: null, producer_name: "Bonde Gård" };
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: at(25) });
      assertEq(res.reminders_sent, 1, "1b-s5-01: the first run sends the reminder");
      const staleDb = new Proxy(db as any, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => (/FROM orders o INNER JOIN agents a/.test(sql) ? { all: () => [stale] } : target.prepare(sql));
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      sent.length = 0;
      res = await followSvc.processOrderFollowups({ now: at(26), db: staleDb });
      assertEq([res.reminders_sent, sent.length], [0, 0], "1b-s5-02: a stale read sends no second reminder and no second alert");
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(s5Id);

      // Review round 2 (R1): after the job was down > 72 h, a first send that only now
      // succeeds must not be followed in the same run by a «not answered» cancellation.
      failSends = 1; // the first producer e-mail fails; the admin alert after it goes through
      const r1Id = await submitOne("r1@example.com");
      assertTrue(!!rowOf(r1Id) && rowOf(r1Id).notify_sent_at == null, "1b-r1-01: setup: the first send failed (no notify_sent_at)");
      db.prepare("UPDATE orders SET created_at = ? WHERE id = ?").run(hoursAgo(80), r1Id);
      sent.length = 0; receipts.length = 0;
      res = await followSvc.processOrderFollowups({ now: new Date() });
      const r1row = rowOf(r1Id);
      assertEq([res.retried, r1row.status, r1row.cancel_reason], [1, "pending", null], "1b-r1-02: the retry delivers the order and the same run does not cancel it");
      assertEq(notAnswered().length, 0, "1b-r1-03: …and the buyer gets no «har ikke svart» receipt");
      assertTrue(!!r1row.notify_sent_at, "1b-r1-04: the clock now starts at the successful retry");
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(r1Id);

      // Review round 2 (S4): the skip alert says so when the producer got the order before.
      const sbId = await submitOne("sentbefore@example.com");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = 'ag-bonde'").run();
      sent.length = 0;
      await notifySvc.sendOrderNotificationForOrder(cartSvc.buildOrderNotificationInput(sbId)!);
      const sbAlert = sent.find((m) => m.to === ADMIN_MAIL && m.subject.includes("ble ikke sendt"));
      assertTrue(!!sbAlert && sbAlert.textContent.includes("fikk ordren tidligere") && !sbAlert.textContent.includes("verken påminnelse"), "1b-s4-06: a skip after an earlier send says the order is followed up as usual");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-bonde'").run();
      db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(sbId);

      // S6: an unreadable payment_mode is fail-closed (never a cancellation without refund).
      const busy = { prepare: () => { throw new Error("SQLITE_BUSY: database is locked"); } };
      const noColumn = { prepare: () => { throw new Error("no such column: payment_mode"); } };
      assertEq(cartSvc.orderPaymentMode(busy, "x"), cartSvc.PAYMENT_MODE_UNKNOWN, "1b-s6-01: a read error is «unknown», not pay at pickup");
      assertEq(cartSvc.orderPaymentMode(noColumn, "x"), null, "1b-s6-02: a DB without the column has no prepay orders (null)");
      delete process.env.PAYMENTS_ENABLED;
      const cartRoutes = require("./marketplace-cart") as typeof import("./marketplace-cart");
      assertEq(
        [cartRoutes.cancelActionsEnabled(null), cartRoutes.cancelActionsEnabled("at_pickup"), cartRoutes.cancelActionsEnabled("prepay"), cartRoutes.cancelActionsEnabled(cartSvc.PAYMENT_MODE_UNKNOWN)],
        [true, true, false, false],
        "1b-s6-03: with payments off the cancel choices are closed for prepay AND for an unreadable mode",
      );

      // S1: the F9 word lists — one assertion per row (review probe 2026-10-21).
      const c = (name: string, category?: string, producerTypes: string[] = [], description?: string) =>
        banSvc.classifyCartItemBan({ name, category, producerTypes, description })?.kind ?? null;
      assertEq(c("Julebrygg"), "alcohol", "1b-s1-01: «-brygg» is a brew (Julebrygg)");
      assertEq(c("Julebrygg", "beverages"), "alcohol", "1b-s1-02: …also as a beverage of a non-drink producer");
      assertEq(c("Høstbrygg"), "alcohol", "1b-s1-03: «-brygg» (Høstbrygg)");
      assertEq(c("Bryggekaffe"), null, "1b-s1-04: «brygg-» as the first part is not a brew (Bryggekaffe)");
      assertEq(c("Krydderrom"), "alcohol", "1b-s1-05: a «rom» compound is rum (Krydderrom)");
      assertEq(c("Torskerom"), null, "1b-s1-06: …but a roe compound is food (Torskerom)");
      assertEq(c("Romkaviar"), null, "1b-s1-07: …and so is «Romkaviar»");
      assertEq(c("Selskapsrom"), "service", "1b-s1-08: a room to rent is a service (Selskapsrom)");
      assertEq(c("Rosé"), "alcohol", "1b-s1-09: «Rosé» with its accent is wine");
      assertEq(c("Rose"), null, "1b-s1-10: …plain «Rose» is not");
      assertEq(c("Rosenkål"), null, "1b-s1-11: …nor «Rosenkål»");
      assertEq(c("Spritz"), "alcohol", "1b-s1-12: «Spritz»");
      assertEq(c("Ostesmaking"), "service", "1b-s1-13: «-smaking» as the last part is a tasting (Ostesmaking)");
      assertEq(c("Utvandringshistorier rundtur"), "service", "1b-s1-14: a «rundtur» is a tour");
      assertEq(c("Servering med lokale råvarer"), "service", "1b-s1-15: «servering» is a service");
      assertEq(c("Cidereddik"), null, "1b-s1-16: vinegar is food (Cidereddik)");
      assertEq(c("Sidereddik"), null, "1b-s1-17: (Sidereddik)");
      assertEq(c("Rødvinseddik"), null, "1b-s1-18: (Rødvinseddik)");
      assertEq(c("Sherryeddik"), null, "1b-s1-19: (Sherryeddik)");
      assertEq(c("Middagspakke"), null, "1b-s1-20: «middag» in a compound is goods (Middagspakke)");
      assertEq(c("Middagskasse for 4"), null, "1b-s1-21: (Middagskasse for 4)");
      assertEq(c("To-retters middag"), "service", "1b-s1-22: «middag» as a word of its own is still a service");
      assertEq(c("Frokost egg 12 stk"), null, "1b-s1-23: «frokost» next to a goods noun is goods");
      assertEq(c("Lunsj-baguette"), null, "1b-s1-24: «lunsj» next to a goods noun is goods");
      assertEq(c("Frokost"), "service", "1b-s1-25: «Frokost» on its own is a service");
      assertEq(c("Lunsj på gården"), "service", "1b-s1-26: «Lunsj på gården» is a service");
      assertEq(c("Bitter sjokolade 70 %"), null, "1b-s1-27: «bitter» next to a goods noun is goods");
      assertEq(c("Bitter appelsinmarmelade"), null, "1b-s1-28: (Bitter appelsinmarmelade)");
      assertEq(c("Bitter"), "alcohol", "1b-s1-29: «Bitter» on its own is the drink");
      assertEq(c("Bitter 40 %"), "alcohol", "1b-s1-30: (Bitter 40 %)");
      assertEq(c("Gårdsbitter"), "alcohol", "1b-s1-31: a bitters compound is the drink (Gårdsbitter)");
      assertEq(c("Grillpølser til tur"), null, "1b-s1-32: «tur» after a goods noun is goods");
      assertEq(c("Tur"), "service", "1b-s1-33: «Tur» on its own is a service");
      assertEq(c("Eplejuice", "beverages", ["sideri"]), null, "1b-s1-34: «-juice» is alcohol-free, also from a cidery");
      assertEq(c("Eplejuice", "beverages", ["sideri"], "Ingen tilsatt alkohol"), null, "1b-s1-35: …also when the description mentions «alkohol»");
      // Review round 2, B1(a): «bitter» is the drink unless it stands before a food it describes.
      assertEq(c("Atlungstad Bitter"), "alcohol", "1b-r2-01: «Atlungstad Bitter» (brand + bitter)");
      assertEq(c("Atlungstad Bitter", "beverages"), "alcohol", "1b-r2-02: …also as a beverage of a producer not typed as a distillery");
      assertEq(c("Hval Bitter"), "alcohol", "1b-r2-03: «Hval Bitter»");
      assertEq(c("Bitter fra gården"), "alcohol", "1b-r2-04: «Bitter fra gården»");
      assertEq(c("Bitter fra gården", "beverages"), "alcohol", "1b-r2-05: …also in beverages");
      assertEq(c("Gammel bitter"), "alcohol", "1b-r2-06: «Gammel bitter»");
      assertEq(c("Taffel bitter"), "alcohol", "1b-r2-07: «Taffel bitter»");
      assertEq(c("Bitter Original 70 cl"), "alcohol", "1b-r2-08: «Bitter Original 70 cl»");
      assertEq(c("Halvbitter sjokolade"), null, "1b-r2-09: «Halvbitter sjokolade» is chocolate");
      // B1(b): the juice / «ingen tilsatt alkohol» markers never clear an alcohol word in the name.
      assertEq(c("Eplesider", "beverages", ["sideri"], "Gjæret eplejuice fra egne epler, 6 %"), "alcohol", "1b-r2-10: cider described as fermented apple juice");
      assertEq(c("Sider", undefined, [], "Laget av 100 % eplejuice"), "alcohol", "1b-r2-11: «Sider» made of apple juice");
      assertEq(c("Mjød", undefined, [], "Honning og eplejuice"), "alcohol", "1b-r2-12: «Mjød» with apple juice");
      assertEq(c("Fruktvin", undefined, [], "Laget av solbærjuice"), "alcohol", "1b-r2-13: «Fruktvin» of blackcurrant juice");
      assertEq(c("Rabarbravin", undefined, [], "Vin av rabarbrajuice"), "alcohol", "1b-r2-14: «Rabarbravin»");
      assertEq(c("Eplesider", undefined, [], "Naturlig gjæret, ingen tilsatt alkohol"), "alcohol", "1b-r2-15: «ingen tilsatt alkohol» does not clear «Eplesider»");
      assertEq(c("Sider", undefined, [], "Ingen alkohol tilsatt"), "alcohol", "1b-r2-16: «Ingen alkohol tilsatt» does not clear «Sider»");
      // S1 of round 2: new false positives fixed.
      assertEq(c("Honning fra Bergstrøm gård"), null, "1b-r2-17: «-strøm» names are not rum (Bergstrøm)");
      assertEq(c("Lindstrøm egg"), null, "1b-r2-18: (Lindstrøm egg)");
      assertEq(c("Gjedderom"), null, "1b-r2-19: pike roe");
      assertEq(c("Ørretrom"), null, "1b-r2-20: trout roe");
      assertEq(c("Seirom"), null, "1b-r2-21: saithe roe");
      assertEq(c("Hyserom"), null, "1b-r2-22: haddock roe");
      assertEq(c("Serveringsklar ribbe"), null, "1b-r2-23: «Serveringsklar ribbe» is goods");
      assertEq(c("Serveringsbrett i eik"), null, "1b-r2-24: «Serveringsbrett i eik» is goods");
      assertEq(c("Rosé-pepper"), null, "1b-r2-25: «Rosé-pepper» is a spice");
      assertEq(c("Rosépepper"), null, "1b-r2-26: «Rosépepper» is a spice");
      assertEq(c("Kaffebrygg"), null, "1b-r2-27: «Kaffebrygg» is coffee");
      assertEq(c("Tebrygg"), null, "1b-r2-28: «Tebrygg» is tea");
      assertEq(c("Urtebrygg"), null, "1b-r2-29: «Urtebrygg» is herbal tea");
      assertEq(c("Spritzkaker"), null, "1b-r2-30: «Spritzkaker» are cookies");
      assertEq(c("Spritzer"), "alcohol", "1b-r2-31: «Spritzer» is the drink");
      assertEq(c("Aperolspritz"), "alcohol", "1b-r2-32: «Aperolspritz»");
      // S2 of round 2: services that start with a weak word and a preposition.
      assertEq(c("Tur til seteren"), "service", "1b-r2-33: «Tur til seteren»");
      assertEq(c("Lunsj med utsikt"), "service", "1b-r2-34: «Lunsj med utsikt»");
      assertEq(c("Lunsj for to personer"), "service", "1b-r2-35: «Lunsj for to personer»");
      // Review round 3, B1 rest: the juice / «ingen tilsatt alkohol» markers count from the name only.
      assertEq(c("Eple Brut", "beverages", ["sideri"], "Gjæret eplejuice, 7 %"), "alcohol", "1b-r3-01: a cidery's beverage described as fermented apple juice");
      assertEq(c("Høstgull", "beverages", [], "Gjæret eplejuice med 6 % alkohol"), "alcohol", "1b-r3-02: beverages + «alkohol» in the description");
      assertEq(c("Eple Brut", "cider", [], "Gjæret eplejuice"), "alcohol", "1b-r3-03: an alcohol category is not lifted by «eplejuice» in the description");
      assertEq(c("Gårdens beste", "beverages", [], "Naturlig gjæret til 7 %, ingen tilsatt alkohol"), "alcohol", "1b-r3-04: «ingen tilsatt alkohol» in the description lifts nothing");
      assertEq(c("Honningdrikk", "beverages", ["mjoderi"], "Gjæret honning og eplejuice, 11 %"), "alcohol", "1b-r3-05: a meadery's beverage");
      assertEq(c("Gulrotjuice", "beverages", [], "Inneholder ingen alkohol"), null, "1b-r3-06: a juice named as juice still passes");
      assertEq(c("Tomatjuice", "beverages", ["bryggeri"]), null, "1b-r3-07: …also from a brewery");
      // Round 3, S1: more roe; the roe prefix must match exactly (N14).
      assertEq(c("Røyerom"), null, "1b-r3-08: char roe (Røyerom)");
      assertEq(c("Krepserom"), null, "1b-r3-09: crayfish roe (Krepserom)");
      assertEq(c("Hvitfiskrom"), null, "1b-r3-10: whitefish roe");
      assertEq(c("Breiflabbrom"), null, "1b-r3-11: monkfish roe");
      assertEq(c("Rognkjeksrom"), null, "1b-r3-12: lumpfish roe");
      assertEq(c("Sikkerhetsrom") !== null, true, "1b-r3-13: a word that only STARTS like a fish («sik…rom») is not roe");
      assertEq(c("Spritz-kaker"), null, "1b-r3-14: «Spritz-kaker» are cookies");
      delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════════
    // F5 / AC5 — cancel choices for pay-at-pickup orders, PAYMENTS_ENABLED off
    // ════════════════════════════════════════════════════════════════════════
    {
      delete process.env.PAYMENTS_ENABLED;
      const newOrder = () => {
        const s = cartSvc.submitCart(cartWith([["p-bonde-potet", 1]]), { ...BUYER, buyer_email: `f5-${Math.random().toString(36).slice(2)}@example.com` });
        return s.success ? s.orders[0]!.order_id : "";
      };
      const status = (id: string) => db.prepare("SELECT status, cancel_reason FROM orders WHERE id = ?").get(id) as any;
      const post = (id: string, action: string) => req("POST", `/produsent/ordre/${tokenOf(id)}`, { form: { action } });
      const declinedBefore = (db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE event_type = 'order_declined'").get() as any).n;

      // pending: «Kunden har avbestilt»
      let id = newOrder();
      let page = await req("GET", `/produsent/ordre/${tokenOf(id)}`);
      assertTrue(page.text.includes("Kunden har avbestilt") && !page.text.includes("Jeg kan ikke levere"), "ac5-01: pending: «Kunden har avbestilt» offered, «Jeg kan ikke levere» not");
      let r = await post(id, "cancel_buyer");
      assertTrue((r.location || "").includes("done=cancelled") && status(id).status === "cancelled" && status(id).cancel_reason === "buyer_cancelled", "ac5-02: pending -> buyer_cancelled works");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE event_type = 'order_declined'").get() as any).n, declinedBefore, "ac5-03: a buyer cancellation does not count as a decline");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE ref = ?").get(id) as any).n, 0, "ac5-04: no trust event at all for it");

      // confirmed: both choices
      id = newOrder();
      await post(id, "confirm");
      page = await req("GET", `/produsent/ordre/${tokenOf(id)}`);
      assertTrue(page.text.includes("Kunden har avbestilt") && page.text.includes("Jeg kan ikke levere"), "ac5-05: confirmed: both choices offered");
      r = await post(id, "cancel_producer");
      assertTrue(status(id).status === "cancelled" && status(id).cancel_reason === "producer_cancelled", "ac5-06: confirmed -> «Jeg kan ikke levere» works");
      id = newOrder();
      await post(id, "confirm");
      r = await post(id, "cancel_buyer");
      assertTrue(status(id).status === "cancelled" && status(id).cancel_reason === "buyer_cancelled", "ac5-07: confirmed -> «Kunden har avbestilt» works");

      // ready: both choices
      id = newOrder();
      await post(id, "confirm"); await post(id, "ready");
      page = await req("GET", `/produsent/ordre/${tokenOf(id)}`);
      assertTrue(page.text.includes("Kunden har avbestilt") && page.text.includes("Jeg kan ikke levere"), "ac5-08: ready: both choices offered");
      r = await post(id, "cancel_producer");
      assertEq(status(id).cancel_reason, "producer_cancelled", "ac5-09: ready -> «Jeg kan ikke levere» works");
      id = newOrder();
      await post(id, "confirm"); await post(id, "ready");
      await post(id, "cancel_buyer");
      assertEq(status(id).cancel_reason, "buyer_cancelled", "ac5-10: ready -> «Kunden har avbestilt» works");

      // «Jeg kan ikke levere» is not offered or accepted on a pending order
      id = newOrder();
      r = await post(id, "cancel_producer");
      assertTrue((r.location || "").includes("error=ugyldig") && status(id).status === "pending", "ac5-11: pending -> cancel_producer stays closed (that is a decline)");

      // admin route with a reason
      id = newOrder();
      await post(id, "confirm");
      const admin = { "X-Admin-Key": ADMIN_KEY };
      let a = await req("POST", `/admin/marketplace/orders/${id}/cancel`, { headers: admin, body: { reason: "bogus" } });
      assertEq(a.status, 400, "ac5-12: admin /cancel validates reason");
      a = await req("POST", `/admin/marketplace/orders/${id}/cancel`, { headers: admin, body: { reason: "producer_cancelled" } });
      assertTrue(a.status === 200 && status(id).cancel_reason === "producer_cancelled", "ac5-13: admin /cancel with reason works for a pay-at-pickup order with PAYMENTS_ENABLED off");

      // a prepay order keeps the old rule with payments off
      id = newOrder();
      await post(id, "confirm");
      db.prepare("UPDATE orders SET payment_mode = 'prepay' WHERE id = ?").run(id);
      page = await req("GET", `/produsent/ordre/${tokenOf(id)}`);
      assertTrue(!page.text.includes("Kanseller ordren"), "ac5-14: a prepay order with payments off: no cancellation box");
      r = await post(id, "cancel_producer");
      a = await req("POST", `/admin/marketplace/orders/${id}/cancel`, { headers: admin, body: { reason: "producer_cancelled" } });
      assertTrue(status(id).status === "confirmed" && a.status === 409, "ac5-15: …and both cancel routes refuse it");
    }

    // ════════════════════════════════════════════════════════════════════════
    // F10 / AC10 — GET /admin/orders/pilot-status
    // ════════════════════════════════════════════════════════════════════════
    {
      const noKey = await req("GET", "/admin/orders/pilot-status");
      assertEq(noKey.status, 401, "ac10-01: no key -> 401");
      const badKey = await req("GET", "/admin/orders/pilot-status", { headers: { "X-Admin-Key": "wrong" } });
      assertEq(badKey.status, 401, "ac10-02: wrong key -> 401");
      const ok = await req("GET", "/admin/orders/pilot-status", { headers: { "X-Admin-Key": ADMIN_KEY } });
      assertEq(ok.status, 200, "ac10-03: with key -> 200");
      const b = ok.body;
      assertTrue(b.success === true && b.opt_in.count === 4 && b.opt_in.producers.some((p: any) => p.id === "ag-bonde"), "ac10-04: opt-in count + who");
      assertEq(b.passes_gate.count, 4, "ac10-05: who passes the gate (all four opted-in seeded producers are eligible)");
      db.prepare("UPDATE agent_knowledge SET verification_status = 'pending' WHERE agent_id = 'ag-rohne'").run();
      const b2 = (await req("GET", "/admin/orders/pilot-status", { headers: { "X-Admin-Key": ADMIN_KEY } })).body;
      assertTrue(b2.opt_in.count === 4 && b2.passes_gate.count === 3 && !b2.passes_gate.producers.some((p: any) => p.id === "ag-rohne"), "ac10-06: a producer failing the gate drops out of passes_gate but stays in opt_in");
      assertTrue(b.orders_30d.window_days === 30 && typeof b.orders_30d.by_status.pending === "number" && b.orders_30d.total > 0, "ac10-07: orders per status, last 30 days");
      assertTrue(b.orders_30d.by_status.cancelled > 0 && b.orders_30d.by_status.declined > 0, "ac10-08: statuses are counted");
      // Unanswered over 24 h: age one pending order.
      const p = db.prepare("SELECT id FROM orders WHERE status = 'pending' AND COALESCE(payment_mode, '') <> 'prepay' LIMIT 1").get() as any;
      db.prepare("UPDATE orders SET created_at = datetime('now', '-30 hours') WHERE id = ?").run(p.id);
      const b3 = (await req("GET", "/admin/orders/pilot-status", { headers: { "X-Admin-Key": ADMIN_KEY } })).body;
      assertTrue(b3.unanswered.over_hours === 24 && b3.unanswered.orders.some((o: any) => o.order_id === p.id), "ac10-09: pending orders over 24 h are listed");
      assertTrue(!JSON.stringify(b3).includes("example.com"), "ac10-10: no buyer data in the response");
    }
  } catch (err) {
    failed++;
    failures.push(`order-bestillinger-skive1: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    receiptSvc.__setBuyerReceiptSendForTesting(null);
    receiptSvc.__setBuyerReceiptTestDb(null);
    followSvc.__setOrderFollowupsTestDb(null);
    cartSvc.__setCartTestDb(null);
    trustSvc.__setTrustEventTestDb(null);
    adminOrdersMod.__setAdminOrdersTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── order-bestillinger-skive1 tests ──");
  runOrderBestillingerSkive1Tests({ log: true }).then((r) => {
    console.log(`\norder-bestillinger-skive1: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
