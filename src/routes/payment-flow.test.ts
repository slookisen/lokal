/**
 * payment-flow.test.ts — A2A dev-request 2026-10-09-rfb-forhandsbetaling-
 * stripe-connect, skive 2 + 3 (AC2, AC3, AC4 against a fake Stripe client).
 *
 * Real HTTP server with the real cart / producer-page / admin-order routers,
 * the real Connect webhook (real HMAC, fake secret), the real order-notify
 * templates (send stubbed). Covers:
 *   F1  payments off → submit response and notifications exactly as before.
 *   F2  submit: payment link only for the producer that takes prepayment
 *       (direct charge on its account, manual capture, øre-exact line items,
 *       no platform fee), the other producer is paid at pickup and notified
 *       at once; the prepay producer is NOT notified yet.
 *   F3  checkout.session.completed + the PaymentIntent → authorized; the
 *       producer is notified once («forhåndsbetalt», amount, deadline).
 *   F4  producer page shows the reservation; confirm → capture, real Stripe
 *       fee (incl. VAT on it) and net shown; buyer order view shows status.
 *   F5  decline → reservation released.
 *   F6  no confirmation before the deadline → order cancelled
 *       (payment_expired) + reservation released by the maintenance job.
 *   F7  link expires unpaid → order continues as pay at pickup, producer
 *       notified with «betalte ikke på forhånd».
 *   F8  link creation fails → pay at pickup, notified at once.
 *   F9  pay_at_pickup / unpriced line / below Stripe minimum → no link.
 *   F10 amount mismatch → never authorized, released.
 *   F11 capture failures: authorization gone → expired + pay at pickup;
 *       transient → stays authorized, maintenance captures later.
 *   F12 refunds (admin partial + full, dashboard charge.refunded), no-show
 *       keeps a captured payment, admin decline of an unpaid link expires it.
 *   F13 maintenance catches a lost checkout.session.completed / .expired.
 *   F14 release-all (rollback), MCP description/schema switch, handleliste
 *       copy switch, return pages.
 *
 * Standalone: npx tsx src/routes/payment-flow.test.ts
 */
import Database from "better-sqlite3";
import * as http from "http";
import express from "express";
import Stripe from "stripe";
import type { PaymentsStripeClient, PaymentIntentLike, CheckoutSessionLike } from "../services/payment-provider";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const FAKE_SECRET = "whsec_" + "fakeflowsecret" + "5".repeat(10);
const ENV_KEYS = [
  "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET",
  "PAYMENTS_LIVE", "PAYMENTS_ORG_NR", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "BASE_URL", "ORDER_NOTIFY_EMAIL_VERSION",
  "PAYMENT_CHECKOUT_MINUTES", "PAYMENT_CONFIRM_HOURS", "PLATFORM_FEE_BPS", "PLATFORM_FEE_FIXED_ORE",
];

function makeFakeStripe() {
  const sessions = new Map<string, CheckoutSessionLike & { stripeAccount: string; amount: number }>();
  const intents = new Map<string, PaymentIntentLike & { stripeAccount: string }>();
  const calls: Array<{ op: string; id?: string; params?: any; opts?: any }> = [];
  let n = 0;
  let failCreate = false;
  let failRefund = false;
  let captureHook: ((piId: string) => void) | null = null;
  let captureMode: "ok" | "gone" | "transient" = "ok";
  const real = new Stripe(FAKE_TEST_KEY);
  const client = {
    accounts: { async create() { throw new Error("not used"); }, async retrieve(id: string) { return { id }; } },
    accountLinks: { async create() { throw new Error("not used"); } },
    checkout: {
      sessions: {
        async create(params: any, opts: any) {
          calls.push({ op: "checkout.create", params, opts });
          if (failCreate) throw new Error("stripe down");
          n++;
          const id = `cs_test_${n}`;
          const amount = params.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0);
          const cs = { id, url: `https://checkout.stripe.test/${id}`, expires_at: params.expires_at, status: "open", payment_intent: null, metadata: params.metadata, stripeAccount: opts.stripeAccount, amount };
          sessions.set(id, cs);
          return cs;
        },
        async retrieve(id: string, opts: any) {
          calls.push({ op: "checkout.retrieve", id, opts });
          const cs = sessions.get(id);
          if (!cs) throw new Error("no such session");
          return cs;
        },
        async expire(id: string, opts: any) {
          calls.push({ op: "checkout.expire", id, opts });
          const cs = sessions.get(id)!;
          if (cs.status === "complete") { const e: any = new Error("session complete"); e.code = "checkout_session_not_open"; throw e; }
          cs.status = "expired";
          return cs;
        },
      },
    },
    paymentIntents: {
      async retrieve(id: string, opts: any) {
        calls.push({ op: "pi.retrieve", id, opts });
        const pi = intents.get(id);
        if (!pi) throw new Error("no such intent");
        return pi;
      },
      async cancel(id: string, opts: any) {
        calls.push({ op: "pi.cancel", id, opts });
        const pi = intents.get(id)!;
        pi.status = "canceled";
        return pi;
      },
      async capture(id: string, opts: any) {
        calls.push({ op: "pi.capture", id, opts });
        const pi = intents.get(id)!;
        if (captureMode === "gone") { pi.status = "canceled"; const e: any = new Error("intent canceled"); e.code = "payment_intent_unexpected_state"; throw e; }
        if (captureMode === "transient") { const e: any = new Error("timeout"); e.type = "StripeConnectionError"; throw e; }
        pi.status = "succeeded";
        if (captureHook) captureHook(id);
        return { ...pi, latest_charge: { id: "ch_" + id, balance_transaction: { fee: 759, fee_details: [{ amount: 607, type: "stripe_fee" }, { amount: 152, type: "tax" }] } } };
      },
    },
    refunds: {
      async create(params: any, opts: any) {
        calls.push({ op: "refund", params, opts });
        if (failRefund) throw new Error("refund timeout");
        return { id: "re_" + calls.length, amount: params.amount ?? intents.get(params.payment_intent)!.amount!, status: "succeeded" };
      },
    },
    webhooks: { constructEvent(payload: any, sig: any, secret: string) { return real.webhooks.constructEvent(payload, sig, secret) as any; } },
  } as unknown as PaymentsStripeClient;

  /** Simulates the buyer completing Checkout: the PI exists, authorized, on the producer's account. */
  function pay(sessionId: string, opts: { amount?: number } = {}): string {
    const cs = sessions.get(sessionId)!;
    const piId = `pi_${sessionId}`;
    intents.set(piId, { id: piId, status: "requires_capture", amount: opts.amount ?? cs.amount, amount_capturable: opts.amount ?? cs.amount, metadata: cs.metadata as any, stripeAccount: cs.stripeAccount });
    cs.status = "complete";
    cs.payment_intent = piId;
    return piId;
  }
  return {
    client, sessions, intents, calls, pay,
    setFailCreate: (v: boolean) => { failCreate = v; },
    setFailRefund: (v: boolean) => { failRefund = v; },
    setCaptureHook: (fn: ((piId: string) => void) | null) => { captureHook = fn; },
    setCaptureMode: (m: "ok" | "gone" | "transient") => { captureMode = m; },
  };
}

export async function runPaymentFlowTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => { if (c) passed++; else { failed++; failures.push("✗ " + label); } if (opts.log) console.log(`  ${c ? "ok" : "✗"} ${label}`); };
  const eq = (a: unknown, b: unknown, label: string) => {
    const c = JSON.stringify(a) === JSON.stringify(b);
    if (c) passed++; else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
    if (opts.log) console.log(`  ${c ? "ok" : "✗"} ${label}`);
  };

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const trustSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const sent: Array<{ to: string; subject: string; textContent: string }> = [];

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => { sent.push({ to: o.to, subject: o.subject, textContent: o.textContent }); return { success: true, messageId: "stub" }; });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "flow-admin-key";
    process.env.BASE_URL = "https://rfb.test";
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_KEY;

    const insA = db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active, is_verified, order_notifications_opt_in)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, 1, 1, 1)`);
    insA.run("ag-pay", "Betal Gård", "betal@example.no", "k-pay");
    insA.run("ag-plain", "Vanlig Gård", "vanlig@example.no", "k-plain");
    for (const id of ["ag-pay", "ag-plain"]) db.prepare(`INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, 'verified')`).run(id);
    const insP = db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability) VALUES (?, ?, ?, ?, ?, ?, 'in_stock')`);
    insP.run("p-egg", "ag-pay", "Egg", "egg", 60, "brett");
    insP.run("p-honning", "ag-pay", "Honning", "honning", 49.5, "glass");
    insP.run("p-nopris", "ag-pay", "Ost", "ost", null, "stk");
    insP.run("p-billig", "ag-pay", "Persille", "persille", 2, "bunt");
    insP.run("p-poteter", "ag-plain", "Poteter", "poteter", 40, "kg");
    db.prepare(`INSERT INTO payment_accounts (id, agent_id, livemode, stripe_account_id, charges_enabled, details_submitted) VALUES ('pa-1', 'ag-pay', 0, 'acct_pay', 1, 1)`).run();

    const fake = makeFakeStripe();
    const cartRoutes = require("./marketplace-cart") as typeof import("./marketplace-cart");
    const paymentsMod = require("./payments") as typeof import("./payments");
    const svc = require("../services/payment-service") as typeof import("../services/payment-service");
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.set("paymentsStripeClient", fake.client);
    app.set("paymentsWebhookSecret", FAKE_SECRET);
    paymentsMod.mountPaymentWebhook(app, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY });
    app.use("/api/marketplace", cartRoutes.cartRouter);
    app.use("/admin/marketplace", cartRoutes.adminOrderRouter);
    app.use("/produsent/ordre", cartRoutes.producerOrderRouter);
    paymentsMod.mountPaymentRoutes(app, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY });
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    function req(method: string, path: string, o: { headers?: Record<string, string>; body?: any; form?: Record<string, string>; raw?: string } = {}):
      Promise<{ status: number; body: any; text: string; location?: string }> {
      initMod.__setDbForTesting(db as any);
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(o.headers || {}) };
        let b: string | undefined;
        if (o.form) { b = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        else if (o.raw !== undefined) { b = o.raw; headers["Content-Type"] = "application/json"; }
        else if (o.body !== undefined) { b = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; }
        if (b !== undefined) headers["Content-Length"] = String(Buffer.byteLength(b));
        const r = http.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: any = null; try { body = JSON.parse(text); } catch { /* html */ }
            resolve({ status: resp.statusCode || 0, body, text, location: resp.headers.location as string | undefined });
          });
        });
        r.on("error", reject);
        if (b !== undefined) r.write(b);
        r.end();
      });
    }
    const settle = () => new Promise((r) => setTimeout(r, 30));
    let evtN = 0;
    const webhook = async (type: string, obj: any, account = "acct_pay") => {
      evtN++;
      const raw = JSON.stringify({ id: `evt_flow_${evtN}`, object: "event", type, livemode: false, created: 1_800_000_000 + evtN, account, data: { object: obj } });
      const sig = new Stripe(FAKE_TEST_KEY).webhooks.generateTestHeaderString({ payload: raw, secret: FAKE_SECRET });
      const r = await req("POST", "/webhooks/stripe-connect", { raw, headers: { "Stripe-Signature": sig } });
      await settle();
      return r;
    };
    async function newCart(items: Array<[string, number]>): Promise<{ cart_id: string; buyer_ref: string }> {
      const c = await req("POST", "/api/marketplace/cart");
      for (const [pid, qty] of items) {
        const r = await req("POST", `/api/marketplace/cart/${c.body.cart_id}/items`, { headers: { "X-Cart-Token": c.body.buyer_ref }, body: { product_id: pid, qty } });
        if (r.status !== 201 && r.status !== 200) throw new Error(`add item ${pid} failed: ${r.status} ${r.text}`);
      }
      return { cart_id: c.body.cart_id, buyer_ref: c.body.buyer_ref };
    }
    const submit = async (cart: { cart_id: string; buyer_ref: string }, extra: any = {}) => {
      const r = await req("POST", `/api/marketplace/cart/${cart.cart_id}/submit`, { body: { buyer_ref: cart.buyer_ref, ...extra } });
      await settle();
      return r;
    };
    const payRow = (orderId: string) => db.prepare(`SELECT * FROM payments WHERE order_id = ?`).get(orderId) as any;
    const orderRow = (orderId: string) => db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as any;
    const tokenOf = (orderId: string) => orderRow(orderId).confirm_token as string;
    const sentTo = (email: string) => sent.filter((m) => m.to === email);
    const count = (op: string) => fake.calls.filter((c) => c.op === op).length;

    // ── F1. payments off ───────────────────────────────────────────────────
    let cart = await newCart([["p-egg", 1], ["p-poteter", 1]]);
    let r = await submit(cart);
    eq(r.status, 201, "F1-01: submit with payments off → 201");
    ok(!("payments" in r.body) && r.body.orders.every((o: any) => !("payment_mode" in o)), "F1-02: response shape unchanged (no payments, no payment_mode)");
    eq(sentTo("betal@example.no").length, 1, "F1-03: producer notified at once as before");
    ok(sent[0]!.textContent.includes("Ingen betaling skjer via plattformen"), "F1-04: notification text unchanged");
    eq(count("checkout.create"), 0, "F1-05: Stripe never called");

    // ── F2. submit with payments on ────────────────────────────────────────
    process.env.PAYMENTS_ENABLED = "1";
    process.env.PAYMENTS_ALLOWED_AGENT_IDS = "ag-pay";
    sent.length = 0;
    cart = await newCart([["p-egg", 2], ["p-honning", 1], ["p-poteter", 3]]);
    r = await submit(cart, { contact_consent: true, buyer_name: "Kari", buyer_email: "kari@example.no" });
    eq(r.status, 201, "F2-01: submit → 201");
    const payOrder = r.body.orders.find((o: any) => o.agent_id === "ag-pay");
    const plainOrder = r.body.orders.find((o: any) => o.agent_id === "ag-plain");
    eq([payOrder?.payment_mode, plainOrder?.payment_mode], ["prepay", "at_pickup"], "F2-02: payment_mode per order");
    eq(r.body.payments?.length, 1, "F2-03: one payment link (prepay producer only)");
    const link = r.body.payments[0];
    eq([link.order_id, link.seller, link.amount_nok, link.currency, link.status, link.capture], [payOrder.order_id, "Betal Gård", 169.5, "NOK", "requires_payment", "on_producer_confirmation"], "F2-04: link fields");
    eq(link.fees, { stripe_fee_payer: "producer", platform_fee_nok: 0 }, "F2-05: fees object — producer pays Stripe, no platform fee");
    ok(link.checkout_url === "https://checkout.stripe.test/cs_test_1" && !!link.expires_at, "F2-06: checkout_url + expires_at");
    ok(typeof r.body.payment_note === "string" && r.body.payment_note.includes("trekkes først når produsenten bekrefter"), "F2-07: payment_note explains reserve/capture");
    const cc = fake.calls.find((c) => c.op === "checkout.create")!;
    eq(cc.opts.stripeAccount, "acct_pay", "F2-08: DIRECT charge on the producer's account (Stripe-Account)");
    ok(/^rfb-checkout-/.test(cc.opts.idempotencyKey || ""), "F2-09: idempotency key");
    eq(cc.params.payment_intent_data.capture_method, "manual", "F2-10: manual capture (reserve now, capture on confirmation)");
    ok(!("application_fee_amount" in cc.params.payment_intent_data), "F2-11: no application fee in the pilot");
    eq(cc.params.line_items.map((l: any) => [l.price_data.unit_amount, l.quantity]), [[6000, 2], [4950, 1]], "F2-12: øre-exact line items");
    eq([cc.params.metadata.order_id, cc.params.payment_intent_data.metadata.payment_id === cc.params.metadata.payment_id], [payOrder.order_id, true], "F2-13: metadata ties session + intent to order/payment");
    ok(cc.params.success_url.startsWith("https://rfb.test/betaling/takk") && cc.params.cancel_url.startsWith("https://rfb.test/betaling/avbrutt"), "F2-14: return URLs");
    const minutes = (cc.params.expires_at * 1000 - Date.now()) / 60000;
    ok(minutes > 55 && minutes <= 61, "F2-15: link valid ~60 minutes");
    eq(payRow(payOrder.order_id)?.status, "requires_payment", "F2-16: payments row requires_payment");
    eq(payRow(payOrder.order_id)?.amount_ore, 16950, "F2-17: amount in øre");
    eq(sentTo("vanlig@example.no").length, 1, "F2-18: pay-at-pickup producer notified at once");
    eq(sentTo("betal@example.no").length, 0, "F2-19: prepay producer NOT notified before payment");
    r = await req("GET", `/api/marketplace/orders/${payOrder.order_id}?buyer_ref=${cart.buyer_ref}`);
    ok(r.body?.payment?.status === "requires_payment" && r.body.payment.checkout_url === link.checkout_url, "F2-20: buyer order view carries the open link");
    r = await req("GET", `/api/marketplace/orders/${plainOrder.order_id}?buyer_ref=${cart.buyer_ref}`);
    ok(r.body?.success && !("payment" in r.body), "F2-21: pay-at-pickup order view has no payment block");

    // ── F3. authorization ──────────────────────────────────────────────────
    const pi1 = fake.pay("cs_test_1");
    r = await webhook("checkout.session.completed", { id: "cs_test_1", object: "checkout.session", payment_intent: pi1, metadata: fake.sessions.get("cs_test_1")!.metadata });
    ok(r.status === 200 && r.body?.handled === true, "F3-01: checkout.session.completed handled");
    let p1 = payRow(payOrder.order_id);
    eq([p1.status, p1.payment_intent_id], ["authorized", pi1], "F3-02: authorized via the PaymentIntent (sync after commit)");
    const hours = (Date.parse(p1.capture_deadline_at) - Date.now()) / 3600000;
    ok(hours > 47 && hours <= 48.1, "F3-03: capture deadline ~48 h");
    let mails = sentTo("betal@example.no");
    eq(mails.length, 1, "F3-04: producer notified once the payment is reserved");
    ok(mails[0]!.subject.startsWith("Ny forhåndsbetalt henteordre") && mails[0]!.textContent.includes("Kunden har betalt 169,50 kr på forhånd")
      && mails[0]!.textContent.includes("trekkes først når du bekrefter") && !mails[0]!.textContent.includes("Ingen betaling skjer"), "F3-05: mail says paid, reserved, captured on confirmation");
    ok(mails[0]!.textContent.includes("Kari"), "F3-06: consented buyer contact still in the mail (rebuilt from the order)");
    r = await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi1) });
    eq(sentTo("betal@example.no").length, 1, "F3-07: second authorization signal → no second mail");

    // ── F4. producer page + confirm → capture ──────────────────────────────
    const tok1 = tokenOf(payOrder.order_id);
    r = await req("GET", `/produsent/ordre/${tok1}`);
    ok(r.text.includes("Kunden har betalt 169,50 kr") && r.text.includes("Bekreft innen") && r.text.includes("Betalingen går via Stripe direkte"), "F4-01: producer page shows the reservation");
    r = await req("POST", `/produsent/ordre/${tok1}`, { form: { action: "confirm" } });
    ok(r.status === 303 && (r.location || "").includes("done=confirmed") && (r.location || "").includes("betaling=trukket"), "F4-02: confirm → capture → banner");
    const cap = fake.calls.find((c) => c.op === "pi.capture")!;
    eq([cap.id, cap.opts.stripeAccount, /^rfb-capture-/.test(cap.opts.idempotencyKey)], [pi1, "acct_pay", true], "F4-03: capture on the producer's account, idempotent");
    p1 = payRow(payOrder.order_id);
    eq([p1.status, p1.stripe_fee_ore], ["captured", 759], "F4-04: captured; Stripe fee incl. VAT from the balance transaction");
    r = await req("GET", `/produsent/ordre/${tok1}?done=confirmed&betaling=trukket`);
    ok(r.text.includes("169,50 kr er trukket") && r.text.includes("Stripe-gebyr: 7,59 kr") && r.text.includes("Netto til deg: 161,91 kr") && r.text.includes("Betalingen er trukket"), "F4-05: gross, fee, net shown");
    r = await req("GET", `/api/marketplace/orders/${payOrder.order_id}?buyer_ref=${cart.buyer_ref}`);
    ok(r.body?.payment?.status === "captured" && !r.body.payment.checkout_url, "F4-06: buyer sees captured, no link");
    r = await req("GET", `/produsent/ordre/${tokenOf(plainOrder.order_id)}`);
    ok(r.text.includes("Ingen betaling skjer via plattformen.") && !r.text.includes("Betaling:"), "F4-07: pay-at-pickup order page unchanged");

    // ── F5. decline → release ──────────────────────────────────────────────
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    let oid = r.body.orders[0].order_id;
    let cs = r.body.payments[0].checkout_url.split("/").pop();
    let pi = fake.pay(cs);
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    eq(payRow(oid).status, "authorized", "F5-01: authorized via amount_capturable_updated alone");
    r = await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "decline" } });
    ok((r.location || "").includes("betaling=frigjort"), "F5-02: decline → banner «frigjort»");
    ok(fake.intents.get(pi)!.status === "canceled" && payRow(oid).status === "canceled", "F5-03: reservation released at Stripe and here");

    // ── F6. deadline → cancelled + released by maintenance ─────────────────
    cart = await newCart([["p-honning", 2]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    let m = await svc.runPaymentMaintenance({ db, stripe: fake.client, now: new Date(Date.now() + 47 * 3600000).toISOString() });
    eq(orderRow(oid).status, "pending", "F6-01: before the deadline nothing happens");
    m = await svc.runPaymentMaintenance({ db, stripe: fake.client, now: new Date(Date.now() + 49 * 3600000).toISOString() });
    ok(m.expired_orders === 1 && m.released === 1, "F6-02: maintenance reports one expired order, one release");
    eq([orderRow(oid).status, orderRow(oid).cancel_reason, payRow(oid).status], ["cancelled", "payment_expired", "canceled"], "F6-03: order cancelled (payment_expired), payment released");
    const plainPending = db.prepare(`SELECT id FROM orders WHERE status = 'pending' LIMIT 1`).get() as any;
    const tr = cartSvc.transitionOrder(plainPending.id, "cancelled", { actor: "test" });
    ok(!tr.success, "F6-04: pending → cancelled stays closed without the payment_expired reason");

    // ── F7. link expires unpaid ────────────────────────────────────────────
    sent.length = 0;
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    cs = r.body.payments[0].checkout_url.split("/").pop();
    fake.sessions.get(cs)!.status = "expired";
    r = await webhook("checkout.session.expired", { id: cs, object: "checkout.session", metadata: fake.sessions.get(cs)!.metadata });
    eq([payRow(oid).status, orderRow(oid).payment_mode, orderRow(oid).status], ["expired", "at_pickup", "pending"], "F7-01: link expired → pay at pickup, order still pending");
    mails = sentTo("betal@example.no");
    ok(mails.length === 1 && mails[0]!.textContent.includes("Kunden betalte ikke på forhånd") && mails[0]!.subject.startsWith("Ny henteordre"), "F7-02: producer notified now, «betalte ikke på forhånd»");

    // ── F8. link creation fails ────────────────────────────────────────────
    sent.length = 0;
    fake.setFailCreate(true);
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    fake.setFailCreate(false);
    oid = r.body.orders[0].order_id;
    ok(r.status === 201 && r.body.payments.length === 0 && r.body.orders[0].payment_mode === "at_pickup", "F8-01: Stripe down → submit still succeeds, pay at pickup");
    ok(sentTo("betal@example.no").length === 1 && sentTo("betal@example.no")[0]!.textContent.includes("Ingen betaling skjer via plattformen"), "F8-02: producer notified at once with the normal text");
    eq((db.prepare(`SELECT COUNT(*) AS n FROM payment_events WHERE type = 'checkout_create_failed'`).get() as any).n, 1, "F8-03: failure logged");

    // ── F9. no link: pay_at_pickup, unpriced line, below minimum ───────────
    const before = count("checkout.create");
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart, { pay_at_pickup: true });
    ok(r.body.payments.length === 0 && r.body.orders[0].payment_mode === "at_pickup", "F9-01: pay_at_pickup=true → no link");
    cart = await newCart([["p-egg", 1], ["p-nopris", 1]]);
    r = await submit(cart);
    ok(r.body.payments.length === 0, "F9-02: a line without price → no link");
    cart = await newCart([["p-billig", 1]]);
    r = await submit(cart);
    ok(r.body.payments.length === 0, "F9-03: below Stripe's 3 kr minimum → no link");
    eq(count("checkout.create"), before, "F9-04: Stripe not called for any of them");

    // ── F10. amount mismatch ───────────────────────────────────────────────
    sent.length = 0;
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop(), { amount: 100 });
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    ok(payRow(oid).status === "canceled" && fake.intents.get(pi)!.status === "canceled", "F10-01: amount we did not ask for → released, never authorized");
    mails = sentTo("betal@example.no");
    ok(orderRow(oid).payment_mode === "at_pickup" && mails.length === 1 && mails[0]!.textContent.includes("Kunden betalte ikke på forhånd"), "F10-02: the order is not left dead — pay at pickup, producer notified");

    // ── F11. capture failures ──────────────────────────────────────────────
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    fake.setCaptureMode("gone");
    r = await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "confirm" } });
    ok((r.location || "").includes("betaling=feilet"), "F11-01: authorization gone → banner «feilet»");
    eq([orderRow(oid).status, payRow(oid).status, orderRow(oid).payment_mode], ["confirmed", "expired", "at_pickup"], "F11-02: order stays confirmed, paid at pickup");

    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    fake.setCaptureMode("transient");
    r = await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "confirm" } });
    ok((r.location || "").includes("betaling=venter") && payRow(oid).status === "authorized", "F11-03: transient error → stays authorized, banner «venter»");
    fake.setCaptureMode("ok");
    m = await svc.runPaymentMaintenance({ db, stripe: fake.client });
    ok(m.captured >= 1 && payRow(oid).status === "captured", "F11-04: maintenance captures it later");

    // ── F12. refunds, no-show, admin decline of an unpaid link ─────────────
    const capOid = oid;
    const capPay = payRow(capOid);
    r = await req("POST", `/admin/payments/${capPay.id}/refund`, { body: { amount_ore: 2000 } });
    eq(r.status, 403, "F12-01: refund needs the admin key");
    r = await req("POST", `/admin/payments/${capPay.id}/refund`, { headers: { "X-Admin-Key": "flow-admin-key" }, body: { amount_ore: 2000 } });
    ok(r.status === 200 && payRow(capOid).refunded_ore === 2000 && payRow(capOid).status === "captured", "F12-02: partial refund");
    const rf = fake.calls.filter((c) => c.op === "refund").pop()!;
    eq([rf.params.amount, rf.opts.stripeAccount], [2000, "acct_pay"], "F12-03: refund on the producer's account");
    r = await req("POST", `/admin/payments/${capPay.id}/refund`, { headers: { "X-Admin-Key": "flow-admin-key" }, body: { amount_ore: 999999 } });
    eq(r.status, 409, "F12-04: refund above the remaining amount → refused");
    r = await req("POST", `/admin/payments/${capPay.id}/refund`, { headers: { "X-Admin-Key": "flow-admin-key" }, body: {} });
    ok(r.status === 200 && payRow(capOid).status === "refunded" && payRow(capOid).refunded_ore === 6000, "F12-05: refund of the rest → refunded");

    // Dashboard refund arrives as charge.refunded.
    const p1Row = payRow(payOrder.order_id);
    await webhook("charge.refunded", { id: "ch_x", object: "charge", payment_intent: p1Row.payment_intent_id, amount_refunded: 5000 });
    eq(payRow(payOrder.order_id).refunded_ore, 5000, "F12-06: refund made in the producer's dashboard is mirrored");

    // no-show after capture keeps the money.
    r = await req("POST", `/produsent/ordre/${tok1}`, { form: { action: "ready" } });
    const refundsBefore = count("refund");
    r = await req("POST", `/produsent/ordre/${tok1}`, { form: { action: "no_show" } });
    ok(orderRow(payOrder.order_id).status === "cancelled" && count("refund") === refundsBefore, "F12-07: no-show after capture → no automatic refund (terms §7)");

    // Admin declines an order whose link is still unpaid → the link is expired.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    cs = r.body.payments[0].checkout_url.split("/").pop();
    r = await req("POST", `/admin/marketplace/orders/${oid}/decline`, { headers: { "X-Admin-Key": "flow-admin-key" } });
    ok(r.status === 200 && r.body.payment_effect === "released" && fake.sessions.get(cs)!.status === "expired" && payRow(oid).status === "canceled", "F12-08: admin decline → unpaid link expired at Stripe");

    // ── F13. maintenance catches lost webhooks ─────────────────────────────
    sent.length = 0;
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    const lostPaid = r.body.orders[0].order_id;
    fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    cart = await newCart([["p-honning", 1]]);
    r = await submit(cart);
    const lostExpired = r.body.orders[0].order_id;
    fake.sessions.get(r.body.payments[0].checkout_url.split("/").pop())!.status = "expired";
    m = await svc.runPaymentMaintenance({ db, stripe: fake.client, now: new Date(Date.now() + 75 * 60000).toISOString() });
    ok(m.intents_synced === 1 && payRow(lostPaid).status === "authorized", "F13-01: completed session without webhook → authorized");
    ok(m.sessions_expired === 1 && payRow(lostExpired).status === "expired" && orderRow(lostExpired).payment_mode === "at_pickup", "F13-02: expired session without webhook → pay at pickup");
    await settle();
    eq(sentTo("betal@example.no").length, 2, "F13-03: both producers' orders notified (authorized + not prepaid)");

    // ── F15. review fixes (skive 2+3 review) ───────────────────────────────
    // payment_expired never applies to a confirmed order.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "confirm" } });
    const tExp = cartSvc.transitionOrder(oid, "cancelled", { actor: "system", cancelReason: "payment_expired" });
    ok(!tExp.success && orderRow(oid).status === "confirmed" && payRow(oid).status === "captured", "F15-01: payment_expired refused for a confirmed (captured) order");
    db.prepare(`UPDATE payments SET capture_deadline_at = ? WHERE order_id = ?`).run(new Date(Date.now() - 3600000).toISOString(), oid);
    m = await svc.runPaymentMaintenance({ db, stripe: fake.client });
    ok(orderRow(oid).status === "confirmed" && payRow(oid).status === "captured", "F15-02: deadline job leaves the confirmed, captured order alone");

    // Producer cancels after capture while Stripe refunds fail → maintenance refunds later.
    fake.setFailRefund(true);
    const tCancel = cartSvc.transitionOrder(oid, "cancelled", { actor: "producer", cancelReason: "producer_cancelled" });
    const effCancel = await svc.onOrderTransitioned({ db, stripe: fake.client, orderId: oid, toStatus: "cancelled", cancelReason: "producer_cancelled" });
    ok(tCancel.success && effCancel !== "refunded" && orderRow(oid).status === "cancelled" && orderRow(oid).cancel_reason === "producer_cancelled" && payRow(oid).refunded_ore === 0, "F15-03: cancel after capture with a failing refund → order cancelled, not refunded yet");
    fake.setFailRefund(false);
    m = await svc.runPaymentMaintenance({ db, stripe: fake.client });
    ok(m.refunded === 1 && payRow(oid).status === "refunded", "F15-04: maintenance refunds a captured payment on an undeliverable order");

    // Orphan: a prepay order with no payment row (process died after the commit).
    sent.length = 0;
    db.prepare(`INSERT INTO orders (id, cart_id, agent_id, buyer_ref, status, fulfilment, total_nok, confirm_token, created_at, updated_at, payment_mode)
      VALUES ('orphan-1', NULL, 'ag-pay', 'bref_orphan', 'pending', 'pickup', 60, 'ctok_orphan1', datetime('now','-1 hour'), datetime('now','-1 hour'), 'prepay')`).run();
    db.prepare(`INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES ('oi-orphan', 'orphan-1', 'p-egg', 'Egg', 1, 60, 60)`).run();
    m = await svc.runPaymentMaintenance({ db, stripe: fake.client });
    await settle();
    ok(m.orphans_notified === 1 && orderRow("orphan-1").payment_mode === "at_pickup" && sentTo("betal@example.no").length === 1, "F15-05: orphaned prepay order → pay at pickup, producer notified");

    // Expired-session webhook after we expired the link ourselves keeps 'canceled'.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    cs = r.body.payments[0].checkout_url.split("/").pop();
    await req("POST", `/admin/marketplace/orders/${oid}/decline`, { headers: { "X-Admin-Key": "flow-admin-key" } });
    await webhook("checkout.session.expired", { id: cs, object: "checkout.session", metadata: fake.sessions.get(cs)!.metadata });
    eq(payRow(oid).status, "canceled", "F15-06: our own expiry stays 'canceled' (history kept)");

    // Fee is kept when payment_intent.succeeded wins the race against the capture response.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    const racedOid = oid;
    fake.setCaptureHook(() => { db.prepare(`UPDATE payments SET status = 'captured', captured_at = datetime('now') WHERE order_id = ?`).run(racedOid); });
    await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "confirm" } });
    fake.setCaptureHook(null);
    eq([payRow(oid).status, payRow(oid).stripe_fee_ore], ["captured", 759], "F15-07: fee recorded even when the webhook captured first");

    // No-show while the payment is still only reserved → captured (terms §7), not released.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    fake.setCaptureMode("transient");
    await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "confirm" } });
    await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "ready" } });
    fake.setCaptureMode("ok");
    await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "no_show" } });
    ok(payRow(oid).status === "captured" && fake.intents.get(pi)!.status === "succeeded", "F15-08: no-show with a reserved payment → captured, producer keeps it");

    // Authorization lost after confirmation → alert event + correction mail.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    fake.setCaptureMode("transient");
    await req("POST", `/produsent/ordre/${tokenOf(oid)}`, { form: { action: "confirm" } });
    fake.setCaptureMode("ok");
    sent.length = 0;
    fake.intents.get(pi)!.status = "canceled";
    await webhook("payment_intent.canceled", { ...fake.intents.get(pi), cancellation_reason: "automatic" });
    const lost = (db.prepare(`SELECT COUNT(*) AS n FROM payment_events WHERE type = 'authorization_lost_after_confirm'`).get() as any).n;
    ok(lost === 1 && orderRow(oid).payment_mode === "at_pickup" && sentTo("betal@example.no").some((m2) => m2.subject.startsWith("Endring i henteordre")), "F15-09: lost authorization after confirm → alert + correction to the producer");

    // Drain (rollback mode): no new links, the lifecycle keeps running.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    const drainOid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    process.env.PAYMENTS_ENABLED = "drain";
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    ok(r.status === 201 && !("payments" in r.body), "F15-10: drain → submit creates no new payment link (response as with payments off)");
    r = await req("POST", `/produsent/ordre/${tokenOf(drainOid)}`, { form: { action: "confirm" } });
    ok((r.location || "").includes("betaling=trukket") && payRow(drainOid).status === "captured", "F15-11: drain → confirm still captures the open reservation");
    r = await webhook("payment_intent.created", { id: "pi_drain_probe" });
    eq(r.status, 200, "F15-12: drain → webhook still mounted");
    process.env.PAYMENTS_ENABLED = "1";

    // Fully off with an open reservation → the producer page never promises a capture.
    cart = await newCart([["p-egg", 1]]);
    r = await submit(cart);
    oid = r.body.orders[0].order_id;
    pi = fake.pay(r.body.payments[0].checkout_url.split("/").pop());
    await webhook("payment_intent.amount_capturable_updated", { ...fake.intents.get(pi) });
    delete process.env.PAYMENTS_ENABLED;
    r = await req("GET", `/produsent/ordre/${tokenOf(oid)}`);
    ok(r.text.includes("midlertidig slått av") && !r.text.includes("trekkes når du bekrefter"), "F15-13: payments fully off → no capture promise on the producer page");
    process.env.PAYMENTS_ENABLED = "1";

    // ── F14. rollback, MCP, handleliste, return pages ──────────────────────
    cart = await newCart([["p-honning", 1]]);
    r = await submit(cart);
    const unpaidAtRollback = r.body.orders[0].order_id;
    sent.length = 0;
    r = await req("POST", "/admin/payments/release-all", { headers: { "X-Admin-Key": "flow-admin-key" } });
    await settle();
    ok(r.status === 200 && r.body.released >= 2 && payRow(lostPaid).status === "canceled" && payRow(unpaidAtRollback).status === "canceled", "F14-01: release-all releases every open link and reservation");
    ok(orderRow(unpaidAtRollback).payment_mode === "at_pickup" && orderRow(lostPaid).payment_mode === "at_pickup", "F14-01b: … both orders continue as pay at pickup");
    ok(sentTo("betal@example.no").some((m2) => m2.subject.startsWith("Endring i henteordre") && m2.textContent.includes("blir ikke trukket"))
      && sentTo("betal@example.no").some((m2) => m2.textContent.includes("Kunden betalte ikke på forhånd")), "F14-01c: producer gets a correction (reserved) and the order (unpaid link)");
    r = await req("POST", "/admin/payments/maintenance", { headers: { "X-Admin-Key": "flow-admin-key" } });
    ok(r.status === 200 && r.body.success === true, "F14-02: maintenance on demand");

    const mcp = require("./mcp") as typeof import("./mcp");
    const tools: Record<string, { def: any }> = {};
    const fakeServer: any = new Proxy({}, { get: (_t, prop) => prop === "registerTool" ? (name: string, def: any) => { tools[name] = { def }; } : () => undefined });
    mcp.registerTools(fakeServer);
    ok(tools["lokal_cart_submit"]?.def.description.includes("payments[]") && "pay_at_pickup" in tools["lokal_cart_submit"]!.def.inputSchema, "F14-03: MCP submit tool describes payment links (payments on)");
    delete process.env.PAYMENTS_ENABLED;
    const toolsOff: Record<string, { def: any }> = {};
    const fakeServerOff: any = new Proxy({}, { get: (_t, prop) => prop === "registerTool" ? (name: string, def: any) => { toolsOff[name] = { def }; } : () => undefined });
    mcp.registerTools(fakeServerOff);
    ok(toolsOff["lokal_cart_submit"]?.def.description.includes("No payment is charged.") && !("pay_at_pickup" in toolsOff["lokal_cart_submit"]!.def.inputSchema), "F14-04: payments off → MCP description and schema as before");

    const hl = require("./handleliste-page") as typeof import("./handleliste-page");
    const off = hl.buildHandelistePage("no" as any).content;
    process.env.PAYMENTS_ENABLED = "1";
    const on = hl.buildHandelistePage("no" as any).content;
    ok(off.includes("Ingen betaling skjer via Rett fra Bonden") && !off.includes("Betal på forhånd"), "F14-05: shopping list copy unchanged with payments off");
    ok(on.includes("betaler du med Stripe direkte til produsenten") && on.includes("Betal på forhånd"), "F14-06: shopping list explains prepayment with payments on");
    const vc = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { vc.getConfig("rfb"); } catch { vc.loadConfigsAtBoot(); }
    r = await req("GET", "/betaling/takk?ordre=x");
    ok(r.status === 200 && r.text.includes("trekkes først når produsenten bekrefter") && r.text.includes("noindex"), "F14-07: thank-you page, noindex, no status claim");
    r = await req("GET", "/betaling/avbrutt?ordre=x");
    ok(r.status === 200 && r.text.includes("betaling ved henting"), "F14-08: cancel page explains the fallback");
  } catch (err: any) {
    failed++;
    failures.push("✗ unexpected error: " + String(err?.stack || err));
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    cartSvc.__setCartTestDb(null);
    trustSvc.__setTrustEventTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runPaymentFlowTests({ log: true }).then((s) => {
    console.log(`\npayment-flow: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) { for (const f of s.failures) console.log(f); process.exit(1); }
    process.exit(0);
  });
}
