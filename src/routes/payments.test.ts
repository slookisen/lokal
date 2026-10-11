/**
 * payments.test.ts — A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
 * connect, skive 1 (AC1 against a fake Stripe client, AC5).
 *
 * Real HTTP server, real owner-portal router, real Connect-webhook HMAC (fake
 * secret), injected fake Stripe client for everything that would touch the
 * network. Covers:
 *   1. mountPaymentRoutes()/mountPaymentWebhook(): flag off → nothing; on →
 *      routes; a live key the guard refuses → nothing.
 *   2. Pilot list: closed by default in both modes; "*" opens it only in
 *      live mode; producers off the list or failing isEligibleForRealOrder()
 *      never get a Stripe account.
 *   3. Owner onboarding: session required; account created ONCE with the
 *      binding controller properties (also under concurrent clicks, with a
 *      Stripe idempotency key); repeated clicks reuse it; return/refresh.
 *   4. Portal card states (not_eligible, not_started, onboarding,
 *      restricted, pending, active, deauthorized) and alerts; ?status=
 *      prototype keys never break the portal (payments off and on).
 *   5. Webhook: 503 without secret, 400 without/with bad signature (no state
 *      change); account.updated is only a trigger — the account is re-read
 *      from Stripe (payload ignored); older events never overwrite newer
 *      state; a disconnection is sticky (late retries cannot re-enable);
 *      ANY Stripe error on re-read (outage, 403 from a key missing a
 *      permission) → 500 with nothing recorded or changed; events from the
 *      other Stripe mode are acknowledged without a Stripe call.
 *   6. After a disconnection the owner can connect a NEW account; a 403 on
 *      the onboarding link never retires the stored account (only an admin
 *      can, explicitly).
 *   7. Live-key guard on the request path; admin status/accounts/sync.
 *
 * Standalone: npx tsx src/routes/payments.test.ts
 */
import Database from "better-sqlite3";
import * as http from "http";
import express from "express";
import Stripe from "stripe";
import type {
  ConnectAccountLike,
  CreateAccountLinkParams,
  CreateConnectAccountParams,
  PaymentsStripeClient,
} from "../services/payment-provider";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const FAKE_LIVE_KEY = "sk_" + "live_" + "FAKE".repeat(6);
const FAKE_SECRET = "whsec_" + "fakeconnectsecret" + "4".repeat(10);

const ENV_KEYS = [
  "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET",
  "PAYMENTS_LIVE", "PAYMENTS_ORG_NR", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "BASE_URL",
];

function accessError(): Error {
  const e: any = new Error("The provided key does not have access to account");
  e.type = "StripePermissionError";
  e.statusCode = 403;
  return e;
}

function makeFakeStripe() {
  const created: Array<{ params: CreateConnectAccountParams; idempotencyKey?: string }> = [];
  const links: CreateAccountLinkParams[] = [];
  /** What accounts.retrieve returns — Stripe's "current" state per account. */
  const state = new Map<string, ConnectAccountLike>();
  const noAccess = new Set<string>();
  const retrieved: string[] = [];
  let outage = false;
  let createDelayMs = 0;
  const real = new Stripe(FAKE_TEST_KEY);
  let n = 0;
  const client: PaymentsStripeClient = {
    accounts: {
      async create(params, opts) {
        if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
        created.push({ params, idempotencyKey: opts?.idempotencyKey });
        n++;
        const id = `acct_fake_${n}`;
        state.set(id, { id, charges_enabled: false, details_submitted: false });
        return { id };
      },
      async retrieve(id) {
        retrieved.push(id);
        if (outage) { const e: any = new Error("connection reset"); e.type = "StripeConnectionError"; throw e; }
        if (noAccess.has(id)) throw accessError();
        return state.get(id) ?? { id };
      },
    },
    accountLinks: {
      async create(params) {
        if (noAccess.has(params.account)) throw accessError();
        links.push(params);
        return { url: `https://connect.stripe.test/setup/${params.account}`, expires_at: 0 };
      },
    },
    webhooks: {
      constructEvent(payload, sig, secret) { return real.webhooks.constructEvent(payload, sig, secret) as any; },
    },
  } as PaymentsStripeClient;
  return {
    client, created, links, state, noAccess, retrieved,
    setOutage: (v: boolean) => { outage = v; },
    setCreateDelay: (ms: number) => { createDelayMs = ms; },
  };
}

export async function runPaymentsRouteTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "pay-admin-key";
    process.env.BASE_URL = "https://rfb.test";
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_KEY;

    const paymentsMod = require("./payments") as typeof import("./payments");
    const ownerPortalMod = require("./owner-portal") as typeof import("./owner-portal");
    const svc = require("../services/payment-service") as typeof import("../services/payment-service");

    // ── 1. mounting ─────────────────────────────────────────────────────────
    {
      const a1 = express();
      eq(paymentsMod.mountPaymentRoutes(a1, {}), false, "mount-01: PAYMENTS_ENABLED unset → not mounted");
      eq(paymentsMod.mountPaymentWebhook(a1, {}), false, "mount-02: … webhook not mounted either");
      eq((a1 as any).router?.stack?.length ?? 0, 0, "mount-03: … zero routes");
      const a2 = express();
      eq(paymentsMod.mountPaymentRoutes(a2, { PAYMENTS_ENABLED: "0" }), false, "mount-04: PAYMENTS_ENABLED=0 → not mounted");
      const a3 = express();
      eq(paymentsMod.mountPaymentRoutes(a3, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY }), true, "mount-05: on + test key → mounted");
      const a4 = express();
      const liveEnv = { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_LIVE: "1", PAYMENTS_ORG_NR: "938635676" };
      eq(paymentsMod.mountPaymentRoutes(a4, liveEnv), false, "mount-06: on + live key (terms not live) → refused");
      eq(paymentsMod.mountPaymentWebhook(a4, liveEnv), false, "mount-07: … webhook refused too");
      eq((a4 as any).router?.stack?.length ?? 0, 0, "mount-08: … zero routes");
      eq(paymentsMod.PAYMENTS_WEBHOOK_PATH, "/webhooks/stripe-connect", "mount-09: webhook path outside /api (no /api rate limit)");
    }

    // ── fixtures ────────────────────────────────────────────────────────────
    const insA = db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active, is_verified, order_notifications_opt_in)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, 1, 1, ?)`);
    insA.run("pay-a", "Gard Alfa", "alfa@example.no", "k-pa", 1);
    insA.run("pay-b", "Gard Beta", "beta@example.no", "k-pb", 1);
    insA.run("pay-c", "Gard Charlie", "charlie@example.no", "k-pc", 0);
    insA.run("pay-d", "Gard Delta", "delta@example.no", "k-pd", 1);
    for (const id of ["pay-a", "pay-b", "pay-c", "pay-d"]) {
      db.prepare(`INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, 'verified')`).run(id);
    }
    const future = "datetime('now', '+1 day')";
    db.exec(`INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES
      ('pml-a', 'alfa@example.no', 'ptok-a', 'pay-a', 1, ${future}),
      ('pml-b', 'beta@example.no', 'ptok-b', 'pay-b', 1, ${future}),
      ('pml-c', 'charlie@example.no', 'ptok-c', 'pay-c', 1, ${future}),
      ('pml-d', 'delta@example.no', 'ptok-d', 'pay-d', 1, ${future})`);

    const fake = makeFakeStripe();
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.set("paymentsStripeClient", fake.client);
    app.set("paymentsWebhookSecret", FAKE_SECRET);
    eq(paymentsMod.mountPaymentWebhook(app, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY }), true, "mount-10: webhook mounted early");
    app.use("/", ownerPortalMod.default);
    eq(paymentsMod.mountPaymentRoutes(app, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY }), true, "mount-11: routes mounted");
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    function req(method: string, path: string, o: { headers?: Record<string, string>; form?: Record<string, string>; raw?: string } = {}):
      Promise<{ status: number; body: any; text: string; location?: string }> {
      initMod.__setDbForTesting(db as any);
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...(o.headers || {}) };
        let b: string | undefined;
        if (o.form) { b = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        else if (o.raw !== undefined) { b = o.raw; headers["Content-Type"] = "application/json"; }
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
    const WH = "/webhooks/stripe-connect";
    const cookie = (t: string) => ({ Cookie: `rfb_owner_session=${t}` });
    const activeRow = (id: string) => db.prepare(`SELECT * FROM payment_accounts WHERE agent_id = ? AND deauthorized_at IS NULL`).get(id) as any;
    const rowByAcct = (acct: string) => db.prepare(`SELECT * FROM payment_accounts WHERE stripe_account_id = ?`).get(acct) as any;
    const eventCount = (type: string) => (db.prepare(`SELECT COUNT(*) AS n FROM payment_events WHERE type = ?`).get(type) as any).n;
    const ledgerCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM payment_webhook_events`).get() as any).n;
    let created = 1_800_000_000;
    const send = async (type: string, account: string, obj: any, extra: any = {}) => {
      created += 10;
      const event = { id: `evt_${created}`, object: "event", type, livemode: false, created, account, data: { object: obj }, ...extra };
      const raw = JSON.stringify(event);
      const sig = new Stripe(FAKE_TEST_KEY).webhooks.generateTestHeaderString({ payload: raw, secret: FAKE_SECRET });
      const r = await req("POST", WH, { raw, headers: { "Stripe-Signature": sig } });
      return { ...r, raw, sig, event };
    };

    // ── 4a. portal with payments off ───────────────────────────────────────
    let r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    eq(r.status, 200, "portal-01: portal renders");
    ok(!r.text.includes('id="forhandsbetaling"'), "portal-02: PAYMENTS_ENABLED unset → no prepayment card");
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      r = await req("GET", `/eier/pay-a/portal?status=${k}`, { headers: cookie("ptok-a") });
      eq(r.status, 200, `portal-03: ?status=${k} with payments off → 200`);
    }

    // ── 2. pilot list ──────────────────────────────────────────────────────
    process.env.PAYMENTS_ENABLED = "1";
    eq(svc.isAgentAllowedForPayments("pay-a"), false, "pilot-01: test mode + empty list → nobody");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(!r.text.includes('id="forhandsbetaling"'), "pilot-02: empty list → no card even with PAYMENTS_ENABLED=1");
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("status=payments_unavailable"), "pilot-03: empty list → start refused");
    eq(fake.created.length, 0, "pilot-04: … no Stripe account created");
    eq(svc.isAgentAllowedForPayments("pay-a", { STRIPE_SECRET_KEY: FAKE_LIVE_KEY }), false, "pilot-05: live mode + empty list → nobody (closed by default)");
    eq(svc.isAgentAllowedForPayments("pay-a", { STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_ALLOWED_AGENT_IDS: "*" }), true, "pilot-06: live mode + \"*\" → everyone eligible");
    eq(svc.isAgentAllowedForPayments("pay-a", { STRIPE_SECRET_KEY: FAKE_TEST_KEY, PAYMENTS_ALLOWED_AGENT_IDS: "*" }), false, "pilot-07: test mode + \"*\" → nobody (real producers never get test accounts)");
    eq(svc.isAgentAllowedForPayments("pay-b", { STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_ALLOWED_AGENT_IDS: "pay-a" }), false, "pilot-08: list → list only");

    process.env.PAYMENTS_ALLOWED_AGENT_IDS = "pay-a, pay-c, pay-d";
    ok(svc.isAgentAllowedForPayments("pay-a") && svc.isAgentAllowedForPayments("pay-c") && !svc.isAgentAllowedForPayments("pay-b"), "pilot-09: list parsed (spaces trimmed)");

    // ── 4b. card states before onboarding ──────────────────────────────────
    r = await req("GET", "/eier/pay-b/portal", { headers: cookie("ptok-b") });
    ok(!r.text.includes('id="forhandsbetaling"'), "card-01: producer off the pilot list sees no card");
    r = await req("GET", "/eier/pay-c/portal", { headers: cookie("ptok-c") });
    ok(r.text.includes('id="forhandsbetaling"') && r.text.includes("Slå på «Motta bestillinger på e-post» over først"), "card-02: not eligible → told to switch orders on");
    ok(!r.text.includes("/eier/pay-c/betaling/start"), "card-03: not eligible → no start button");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Kom i gang hos Stripe") && r.text.includes('action="/eier/pay-a/betaling/start"'), "card-04: not started → start button");
    ok(r.text.includes("Testmodus: ingen ekte penger trekkes."), "card-05: test-mode badge");
    ok(r.text.includes("du står som selger") && r.text.includes("Rett fra Bonden tar ingen avgift"), "card-06: seller + no platform fee stated");
    for (const k of ["constructor", "__proto__", "valueOf"]) {
      r = await req("GET", `/eier/pay-a/portal?status=${k}`, { headers: cookie("ptok-a") });
      eq(r.status, 200, `card-07: ?status=${k} with payments on → 200`);
    }

    // ── 3. onboarding ──────────────────────────────────────────────────────
    r = await req("POST", "/eier/pay-a/betaling/start", { form: {} });
    ok(r.status === 302 && r.location === "/eier/pay-a", "onb-01: no session → login redirect");
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-b"), form: {} });
    eq(r.status, 403, "onb-02: another agent's session → 403");
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: { "X-Admin-Key": "pay-admin-key" }, form: {} });
    eq(r.status, 302, "onb-03: admin key is not an owner session");
    r = await req("POST", "/eier/pay-b/betaling/start", { headers: cookie("ptok-b"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("payments_unavailable"), "onb-04: off the pilot list → refused");
    r = await req("POST", "/eier/pay-c/betaling/start", { headers: cookie("ptok-c"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("payments_orders_off"), "onb-05: orders off → refused with reason");
    eq(fake.created.length, 0, "onb-06: no Stripe account for refused producers");

    // Two concurrent clicks → one account.
    fake.setCreateDelay(30);
    const [c1, c2] = await Promise.all([
      req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} }),
      req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} }),
    ]);
    fake.setCreateDelay(0);
    eq([c1.status, c2.status], [303, 303], "onb-07: both concurrent clicks → 303");
    eq(fake.created.length, 1, "onb-08: concurrent clicks → ONE Stripe account");
    eq(c1.location, "https://connect.stripe.test/setup/acct_fake_1", "onb-09: redirected to Stripe-hosted onboarding");
    const p = fake.created[0]!.params;
    eq(p.controller, { fees: { payer: "account" }, losses: { payments: "stripe" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } },
      "onb-10: binding controller properties");
    eq(p.country, "NO", "onb-11: country NO");
    eq(p.metadata?.agent_id, "pay-a", "onb-12: metadata.agent_id");
    eq(p.email, "alfa@example.no", "onb-13: producer's own contact e-mail prefilled");
    eq(p.business_profile?.url, "https://rfb.test/produsent/gard-alfa", "onb-14: business URL is the producer page");
    ok(/^rfb-acct:pay-a:test:0:[0-9a-f]{12}:\d+$/.test(fake.created[0]!.idempotencyKey || ""), "onb-15: Stripe idempotency key per agent, mode, generation, params hash and 10-min window");
    const l = fake.links[0]!;
    eq([l.type, l.return_url, l.refresh_url], ["account_onboarding", "https://rfb.test/eier/pay-a/betaling/retur", "https://rfb.test/eier/pay-a/betaling/fornye"],
      "onb-16: account link return/refresh URLs");
    let acc = activeRow("pay-a");
    ok(acc && acc.stripe_account_id === "acct_fake_1" && acc.livemode === 0 && acc.charges_enabled === 0, "onb-17: account row saved, test mode, charges off");
    eq(eventCount("account_created"), 1, "onb-18: payment_events account_created once");

    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_1", "onb-19: later click → same account");
    eq(fake.created.length, 1, "onb-20: … no second Stripe account");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Fortsett hos Stripe") && r.text.includes("ikke ferdig"), "card-08: onboarding → continue button");
    ok(!svc.canProducerTakePrepayment(db, "pay-a"), "onb-21: return trip alone never enables prepayment");

    r = await req("GET", "/eier/pay-a/betaling/retur", { headers: cookie("ptok-a") });
    ok(r.status === 303 && (r.location || "").includes("status=payments_return"), "ret-01: return → portal");
    r = await req("GET", "/eier/pay-a/portal?status=payments_return", { headers: cookie("ptok-a") });
    ok(r.text.includes("Vi venter på bekreftelse fra Stripe"), "ret-02: return alert shown");
    eq(activeRow("pay-a").charges_enabled, 0, "ret-03: still not enabled after return");
    r = await req("GET", "/eier/pay-a/betaling/retur", { headers: cookie("ptok-b") });
    eq(r.status, 403, "ret-04: return with another agent's session → 403");
    r = await req("GET", "/eier/pay-a/betaling/fornye", { headers: cookie("ptok-a") });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_1", "ret-05: refresh → fresh link for the same account");
    r = await req("GET", "/eier/pay-c/betaling/fornye", { headers: cookie("ptok-c") });
    ok((r.location || "").includes("payments_unavailable"), "ret-06: refresh without an account → portal");

    // ── 5. webhook ─────────────────────────────────────────────────────────
    let w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1", charges_enabled: true });
    const raw0 = w.raw, sig0 = w.sig;
    r = await req("POST", WH, { raw: raw0 });
    eq(r.status, 400, "wh-01: missing signature → 400");
    r = await req("POST", WH, { raw: raw0, headers: { "Stripe-Signature": sig0.replace(/v1=[0-9a-f]+/, "v1=" + "0".repeat(64)) } });
    eq(r.status, 400, "wh-02: bad signature → 400");
    r = await req("POST", WH, { raw: raw0.replace('"charges_enabled":true', '"charges_enabled":false'), headers: { "Stripe-Signature": sig0 } });
    eq(r.status, 400, "wh-03: tampered body → 400");
    ok(w.status === 200 && w.body?.handled === true, "wh-04: valid account.updated → handled");
    eq(activeRow("pay-a").charges_enabled, 0, "wh-05: payload said enabled, Stripe (re-read) says not → stays off");

    fake.state.set("acct_fake_1", { id: "acct_fake_1", charges_enabled: false, details_submitted: true, requirements: { currently_due: ["external_account"], disabled_reason: "requirements.past_due" } });
    w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1" });
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Stripe trenger flere opplysninger"), "card-09: submitted with requirements due → restricted");
    fake.state.set("acct_fake_1", { id: "acct_fake_1", charges_enabled: false, details_submitted: true, requirements: { currently_due: [], pending_verification: ["individual.verification.document"] } });
    w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1" });
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Stripe går gjennom opplysningene dine") && !r.text.includes("/eier/pay-a/betaling/start"), "card-10: under review → pending, no button");

    fake.state.set("acct_fake_1", { id: "acct_fake_1", charges_enabled: true, payouts_enabled: true, details_submitted: true, business_type: "individual", requirements: { disabled_reason: null } });
    w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1" });
    ok(w.status === 200 && w.body?.handled === true && w.body?.duplicate === false, "wh-06: account.updated after Stripe enabled charges → handled");
    acc = activeRow("pay-a");
    ok(acc.charges_enabled === 1 && acc.payouts_enabled === 1 && acc.details_submitted === 1, "wh-07: flags copied from Stripe's current account");
    eq(acc.business_type, "individual", "wh-08: business_type stored (trader-status input)");
    ok(!!acc.charges_enabled_at, "wh-09: charges_enabled_at stamped");
    eq(eventCount("account_charges_enabled_changed"), 1, "wh-10: one state-change event");
    ok(svc.canProducerTakePrepayment(db, "pay-a"), "wh-11: producer can now take prepayment");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Forhåndsbetaling er på") && !r.text.includes("/eier/pay-a/betaling/start"), "card-11: active card, no start button");

    r = await req("POST", WH, { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.duplicate === true, "wh-12: redelivery → duplicate");
    eq(eventCount("account_charges_enabled_changed"), 1, "wh-13: redelivery adds no event");

    // An OLDER event delivered late never overwrites the newer state.
    fake.state.set("acct_fake_1", { id: "acct_fake_1", charges_enabled: false, details_submitted: true });
    const lateRaw = JSON.stringify({ id: "evt_late", object: "event", type: "account.updated", livemode: false, created: 1_700_000_000, account: "acct_fake_1", data: { object: { id: "acct_fake_1" } } });
    const lateSig = new Stripe(FAKE_TEST_KEY).webhooks.generateTestHeaderString({ payload: lateRaw, secret: FAKE_SECRET });
    r = await req("POST", WH, { raw: lateRaw, headers: { "Stripe-Signature": lateSig } });
    ok(r.status === 200 && activeRow("pay-a").charges_enabled === 1, "wh-14: event older than the last applied one → ignored");
    fake.state.set("acct_fake_1", { id: "acct_fake_1", charges_enabled: true, payouts_enabled: true, details_submitted: true });

    const retrievesBefore = fake.retrieved.length;
    w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1" }, { livemode: true });
    ok(w.status === 200 && w.body?.handled === false, "wh-15: live event while running a test key → acknowledged, ignored");
    eq(fake.retrieved.length, retrievesBefore, "wh-15b: … and never read from Stripe with the wrong-mode key");
    w = await send("account.updated", "acct_unknown", { id: "acct_unknown" });
    ok(w.status === 200 && w.body?.handled === false, "wh-16: unknown account → 200, ignored (never fetched)");
    w = await send("payment_intent.created", "acct_fake_1", { id: "pi_x" });
    ok(w.status === 200 && w.body?.handled === false, "wh-17: unhandled event type → 200, recorded, ignored");

    // Stripe outage while re-reading → 500, nothing recorded, retry applies it.
    const ledgerBefore = ledgerCount();
    fake.setOutage(true);
    w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1" });
    eq(w.status, 500, "wh-18: Stripe unreachable on re-read → 500 (Stripe retries)");
    eq(ledgerCount(), ledgerBefore, "wh-19: … event NOT recorded");
    fake.setOutage(false);
    r = await req("POST", WH, { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.duplicate === false, "wh-20: retry of the same event → applied");

    // A disconnection is recorded even when the configured key is in the
    // other mode (signed, no Stripe call needed) — here: a live row, test key.
    db.prepare(`INSERT INTO payment_accounts (id, agent_id, livemode, stripe_account_id, charges_enabled) VALUES ('pa-live-b', 'pay-b', 1, 'acct_live_b', 1)`).run();
    w = await send("account.application.deauthorized", "acct_live_b", { id: "ca_live", object: "application" }, { livemode: true });
    ok(w.body?.handled === true && !!rowByAcct("acct_live_b").deauthorized_at && rowByAcct("acct_live_b").charges_enabled === 0, "wh-20b: live disconnection recorded while running a test key");

    // Disconnection is sticky.
    w = await send("account.application.deauthorized", "acct_fake_1", { id: "ca_x", object: "application" });
    ok(w.body?.handled === true && rowByAcct("acct_fake_1").charges_enabled === 0 && !!rowByAcct("acct_fake_1").deauthorized_at, "wh-21: producer disconnects → prepayment off");
    eq(eventCount("account_deauthorized"), 2, "wh-22: disconnection logged (live row above + this one)");
    w = await send("account.updated", "acct_fake_1", { id: "acct_fake_1", charges_enabled: true });
    ok(rowByAcct("acct_fake_1").charges_enabled === 0 && !svc.canProducerTakePrepayment(db, "pay-a"), "wh-23: late account.updated after disconnection → still off");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("ikke lenger koblet til") && r.text.includes("Koble til Stripe på nytt"), "card-12: disconnected → reconnect button");

    // ── 6. reconnect + unreachable account ─────────────────────────────────
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_2", "rec-01: reconnect → a NEW Stripe account");
    ok(/^rfb-acct:pay-a:test:1:/.test(fake.created[1]?.idempotencyKey || ""), "rec-02: new generation → new idempotency key");
    ok(activeRow("pay-a")?.stripe_account_id === "acct_fake_2" && !!rowByAcct("acct_fake_1").deauthorized_at, "rec-03: new row active, old row kept as history");

    r = await req("POST", "/eier/pay-d/betaling/start", { headers: cookie("ptok-d"), form: {} });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_3", "rec-04: pay-d onboarding starts");
    // A 403 (e.g. a restricted key missing a permission) is NOT a disconnection.
    fake.noAccess.add("acct_fake_3");
    const createdBefore = fake.created.length;
    r = await req("POST", "/eier/pay-d/betaling/start", { headers: cookie("ptok-d"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("payments_error"), "rec-05: 403 on the onboarding link → «prøv igjen», nothing else");
    eq(fake.created.length, createdBefore, "rec-06: … no new Stripe account");
    ok(!rowByAcct("acct_fake_3").deauthorized_at && activeRow("pay-d")?.stripe_account_id === "acct_fake_3", "rec-07: … stored account kept, not retired");

    fake.state.set("acct_fake_3", { id: "acct_fake_3", charges_enabled: true, details_submitted: true });
    const ledgerBefore403 = ledgerCount();
    w = await send("account.updated", "acct_fake_3", { id: "acct_fake_3", charges_enabled: true });
    eq(w.status, 500, "rec-08: 403 on re-read → 500 (Stripe retries; config error stays loud)");
    ok(ledgerCount() === ledgerBefore403 && rowByAcct("acct_fake_3").charges_enabled === 0 && !rowByAcct("acct_fake_3").deauthorized_at, "rec-09: … nothing recorded, nothing changed");

    r = await req("POST", "/admin/payments/accounts/pay-d/retire");
    eq(r.status, 403, "rec-10: admin retire without key → 403");
    r = await req("POST", "/admin/payments/accounts/pay-d/retire", { headers: { "X-Admin-Key": "pay-admin-key" } });
    ok(r.status === 200 && rowByAcct("acct_fake_3").disabled_reason === "retired_by_admin" && !!rowByAcct("acct_fake_3").deauthorized_at, "rec-11: explicit admin retire (e.g. key moved to another sandbox)");
    fake.noAccess.delete("acct_fake_3");
    r = await req("POST", "/eier/pay-d/betaling/start", { headers: cookie("ptok-d"), form: {} });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_4", "rec-12: after retire the owner connects a new account");

    fake.state.set("acct_fake_4", { id: "acct_fake_4", charges_enabled: false, details_submitted: true, requirements: { disabled_reason: "rejected.fraud", currently_due: [] } });
    w = await send("account.updated", "acct_fake_4", { id: "acct_fake_4" });
    r = await req("GET", "/eier/pay-d/portal", { headers: cookie("ptok-d") });
    ok(r.text.includes("Stripe har avvist eller stoppet kontoen") && !r.text.includes("/eier/pay-d/betaling/start"), "card-13: rejected account → own text, no button");

    app.set("paymentsWebhookSecret", undefined);
    r = await req("POST", WH, { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    eq(r.status, 503, "wh-24: no webhook secret configured → 503");
    app.set("paymentsWebhookSecret", FAKE_SECRET);

    // ── 7. live-key guard on the request path ──────────────────────────────
    app.set("paymentsStripeClient", undefined);
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_KEY;
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("payments_unavailable"), "guard-01: live key under a running app → onboarding refused");
    w = await send("account.updated", "acct_fake_2", { id: "acct_fake_2" });
    eq(w.status, 503, "guard-02: live key under a running app → webhook refused");
    eq(svc.getProducerPaymentStatus(db, "pay-a").state, "disabled", "guard-03: producer state disabled while the guard refuses");
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_KEY;
    app.set("paymentsStripeClient", fake.client);

    // ── admin ──────────────────────────────────────────────────────────────
    r = await req("GET", "/admin/payments/status");
    eq(r.status, 403, "adm-01: status without key → 403");
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = FAKE_SECRET;
    r = await req("GET", "/admin/payments/status", { headers: { "X-Admin-Key": "pay-admin-key" } });
    ok(r.status === 200 && r.body?.payments_enabled === true && r.body?.livemode === false, "adm-02: status shows enabled, test mode");
    ok(r.body?.connect_webhook_secret_configured === true && r.body?.pilot_agent_count === 3, "adm-03: secret presence + pilot count");
    ok(!r.text.includes(FAKE_SECRET) && !r.text.includes(FAKE_TEST_KEY), "adm-04: no secret or key in the output");
    r = await req("GET", "/admin/payments/accounts", { headers: { "X-Admin-Key": "pay-admin-key" } });
    const rows = r.body?.accounts || [];
    ok(r.status === 200 && rows.length === 5 && rows.some((x: any) => x.agent_id === "pay-a" && x.agent_name === "Gard Alfa"), "adm-05: accounts list (history included)");
    ok(!r.text.includes("alfa@example.no"), "adm-06: no producer e-mail in the admin list");
    r = await req("GET", "/admin/payments/accounts");
    eq(r.status, 403, "adm-07: accounts without key → 403");
    fake.state.set("acct_fake_2", { id: "acct_fake_2", charges_enabled: true, details_submitted: true });
    r = await req("POST", "/admin/payments/accounts/pay-a/sync", { headers: { "X-Admin-Key": "pay-admin-key" } });
    ok(r.status === 200 && r.body?.synced === 1 && activeRow("pay-a").charges_enabled === 1, "adm-08: admin resync re-reads the account from Stripe");
    r = await req("POST", "/admin/payments/accounts/pay-a/sync");
    eq(r.status, 403, "adm-09: resync without key → 403");
  } catch (err: any) {
    failed++;
    failures.push("✗ unexpected error: " + String(err?.stack || err));
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runPaymentsRouteTests({ log: true }).then((s) => {
    console.log(`\npayments routes: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) { for (const f of s.failures) console.log(f); process.exit(1); }
  });
}
