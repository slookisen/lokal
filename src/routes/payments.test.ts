/**
 * payments.test.ts — A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-
 * connect, skive 1 (AC1 against a fake Stripe client, AC5).
 *
 * Real HTTP server, real owner-portal router, real Connect-webhook HMAC (fake
 * secret), injected fake Stripe client for everything that would touch the
 * network. Covers:
 *   1. mountPaymentRoutes(): flag off → nothing; on → routes; live key the
 *      guard refuses → nothing.
 *   2. Pilot list + gates: test mode needs the list; a producer off the list
 *      or failing isEligibleForRealOrder() never gets a Stripe account.
 *   3. Owner onboarding: session required (401→login redirect, 403 for
 *      another agent); account created ONCE with the binding controller
 *      properties; repeated clicks reuse it; return/refresh URLs.
 *   4. Portal card: hidden when off / not in pilot; states not_eligible,
 *      not_started, onboarding, active; return alert.
 *   5. Webhook: 503 without secret, 400 without/with bad signature (no state
 *      change), account.updated is the ONLY writer of charges_enabled,
 *      redelivery is a no-op, cross-mode events ignored, deauthorization.
 *   6. Live-key guard on the request path (key changed under a running app).
 *   7. Admin status/accounts: X-Admin-Key gated, no secrets in the output.
 *
 * Standalone: npx tsx src/routes/payments.test.ts
 */
import Database from "better-sqlite3";
import * as http from "http";
import express from "express";
import Stripe from "stripe";
import type { PaymentsStripeClient, CreateConnectAccountParams, CreateAccountLinkParams } from "../services/payment-provider";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const FAKE_LIVE_KEY = "sk_" + "live_" + "FAKE".repeat(6);
const FAKE_SECRET = "whsec_" + "fakeconnectsecret" + "4".repeat(10);

const ENV_KEYS = [
  "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET",
  "PAYMENTS_LIVE", "PAYMENTS_ORG_NR", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "BASE_URL",
];

function makeFakeStripe() {
  const created: CreateConnectAccountParams[] = [];
  const links: CreateAccountLinkParams[] = [];
  const real = new Stripe(FAKE_TEST_KEY);
  let n = 0;
  const client: PaymentsStripeClient = {
    accounts: {
      async create(params) { created.push(params); n++; return { id: `acct_fake_${n}` }; },
      async retrieve(id) { return { id }; },
    },
    accountLinks: {
      async create(params) { links.push(params); return { url: `https://connect.stripe.test/setup/${params.account}`, expires_at: 0 }; },
    },
    webhooks: {
      constructEvent(payload, sig, secret) { return real.webhooks.constructEvent(payload, sig, secret) as any; },
    },
  };
  return { client, created, links };
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
      eq((a1 as any).router?.stack?.length ?? 0, 0, "mount-02: … zero routes");
      const a2 = express();
      eq(paymentsMod.mountPaymentRoutes(a2, { PAYMENTS_ENABLED: "0" }), false, "mount-03: PAYMENTS_ENABLED=0 → not mounted");
      const a3 = express();
      eq(paymentsMod.mountPaymentRoutes(a3, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY }), true, "mount-04: on + test key → mounted");
      const a4 = express();
      eq(paymentsMod.mountPaymentRoutes(a4, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_LIVE: "1", PAYMENTS_ORG_NR: "938635676" }), false,
        "mount-05: on + live key (terms not live) → refused");
      eq((a4 as any).router?.stack?.length ?? 0, 0, "mount-06: … zero routes");
    }

    // ── fixtures ────────────────────────────────────────────────────────────
    const insA = db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_active, is_verified, order_notifications_opt_in)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, 1, 1, ?)`);
    insA.run("pay-a", "Gard Alfa", "alfa@example.no", "k-pa", 1);
    insA.run("pay-b", "Gard Beta", "beta@example.no", "k-pb", 1);
    insA.run("pay-c", "Gard Charlie", "charlie@example.no", "k-pc", 0);
    for (const id of ["pay-a", "pay-b", "pay-c"]) {
      db.prepare(`INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, 'verified')`).run(id);
    }
    const future = "datetime('now', '+1 day')";
    db.exec(`INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES
      ('pml-a', 'alfa@example.no', 'ptok-a', 'pay-a', 1, ${future}),
      ('pml-b', 'beta@example.no', 'ptok-b', 'pay-b', 1, ${future}),
      ('pml-c', 'charlie@example.no', 'ptok-c', 'pay-c', 1, ${future})`);

    const fake = makeFakeStripe();
    const app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
    app.set("paymentsStripeClient", fake.client);
    app.set("paymentsWebhookSecret", FAKE_SECRET);
    app.use("/", ownerPortalMod.default);
    eq(paymentsMod.mountPaymentRoutes(app, { PAYMENTS_ENABLED: "1", STRIPE_SECRET_KEY: FAKE_TEST_KEY }), true, "mount-07: test app mounted");
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
    const cookie = (t: string) => ({ Cookie: `rfb_owner_session=${t}` });
    const accountRow = (id: string) => db.prepare(`SELECT * FROM payment_accounts WHERE agent_id = ?`).get(id) as any;
    const eventCount = (type: string) => (db.prepare(`SELECT COUNT(*) AS n FROM payment_events WHERE type = ?`).get(type) as any).n;
    const signed = (event: any) => {
      const raw = JSON.stringify(event);
      const sig = new Stripe(FAKE_TEST_KEY).webhooks.generateTestHeaderString({ payload: raw, secret: FAKE_SECRET });
      return { raw, sig };
    };

    // ── 4a. portal with payments off ───────────────────────────────────────
    let r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    eq(r.status, 200, "portal-01: portal renders");
    ok(!r.text.includes('id="forhandsbetaling"'), "portal-02: PAYMENTS_ENABLED unset → no prepayment card");

    // ── 2. pilot list (test mode) ──────────────────────────────────────────
    process.env.PAYMENTS_ENABLED = "1";
    eq(svc.isAgentAllowedForPayments("pay-a"), false, "pilot-01: test mode + empty list → nobody");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(!r.text.includes('id="forhandsbetaling"'), "pilot-02: empty list → no card even with PAYMENTS_ENABLED=1");
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("status=payments_unavailable"), "pilot-03: empty list → start refused");
    eq(fake.created.length, 0, "pilot-04: … no Stripe account created");
    eq(svc.isAgentAllowedForPayments("pay-a", { STRIPE_SECRET_KEY: FAKE_LIVE_KEY }), true, "pilot-05: live mode + empty list → every eligible producer");
    eq(svc.isAgentAllowedForPayments("pay-b", { STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_ALLOWED_AGENT_IDS: "pay-a" }), false, "pilot-06: live mode + list → list only");

    process.env.PAYMENTS_ALLOWED_AGENT_IDS = "pay-a, pay-c";
    ok(svc.isAgentAllowedForPayments("pay-a") && svc.isAgentAllowedForPayments("pay-c") && !svc.isAgentAllowedForPayments("pay-b"), "pilot-07: list parsed (spaces trimmed)");

    // ── 4b. portal card states ─────────────────────────────────────────────
    r = await req("GET", "/eier/pay-b/portal", { headers: cookie("ptok-b") });
    ok(!r.text.includes('id="forhandsbetaling"'), "card-01: producer off the pilot list sees no card");
    r = await req("GET", "/eier/pay-c/portal", { headers: cookie("ptok-c") });
    ok(r.text.includes('id="forhandsbetaling"') && r.text.includes("Slå på «Motta bestillinger på e-post» over først"), "card-02: not eligible → told to switch orders on");
    ok(!r.text.includes("/eier/pay-c/betaling/start"), "card-03: not eligible → no start button");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Kom i gang hos Stripe") && r.text.includes('action="/eier/pay-a/betaling/start"'), "card-04: not started → start button");
    ok(r.text.includes("Testmodus: ingen ekte penger trekkes."), "card-05: test-mode badge");
    ok(r.text.includes("du står som selger") && r.text.includes("Rett fra Bonden tar ingen avgift"), "card-06: seller + no platform fee stated");

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

    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    eq(r.status, 303, "onb-07: owner → 303");
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_1", "onb-08: redirected to Stripe-hosted onboarding");
    eq(fake.created.length, 1, "onb-09: one Stripe account created");
    const p = fake.created[0]!;
    eq(p.controller, { fees: { payer: "account" }, losses: { payments: "stripe" }, requirement_collection: "stripe", stripe_dashboard: { type: "full" } },
      "onb-10: binding controller properties");
    eq(p.country, "NO", "onb-11: country NO");
    eq(p.metadata?.agent_id, "pay-a", "onb-12: metadata.agent_id");
    eq(p.email, "alfa@example.no", "onb-13: producer's own contact e-mail prefilled");
    eq(p.business_profile?.url, "https://rfb.test/produsent/gard-alfa", "onb-14: business URL is the producer page");
    const l = fake.links[0]!;
    eq([l.type, l.return_url, l.refresh_url], ["account_onboarding", "https://rfb.test/eier/pay-a/betaling/retur", "https://rfb.test/eier/pay-a/betaling/fornye"],
      "onb-15: account link return/refresh URLs");
    let acc = accountRow("pay-a");
    ok(acc && acc.stripe_account_id === "acct_fake_1" && acc.livemode === 0 && acc.charges_enabled === 0, "onb-16: account row saved, test mode, charges off");
    eq(eventCount("account_created"), 1, "onb-17: payment_events account_created");

    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_1", "onb-18: second click → same account");
    eq(fake.created.length, 1, "onb-19: … no second Stripe account");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Fortsett hos Stripe") && r.text.includes("ikke ferdig"), "card-07: onboarding → continue button");
    ok(!svc.canProducerTakePrepayment(db, "pay-a"), "onb-20: return trip alone never enables prepayment");

    r = await req("GET", "/eier/pay-a/betaling/retur", { headers: cookie("ptok-a") });
    ok(r.status === 303 && (r.location || "").includes("status=payments_return"), "ret-01: return → portal");
    r = await req("GET", "/eier/pay-a/portal?status=payments_return", { headers: cookie("ptok-a") });
    ok(r.text.includes("Vi venter på bekreftelse fra Stripe"), "ret-02: return alert shown");
    eq(accountRow("pay-a").charges_enabled, 0, "ret-03: still not enabled after return");
    r = await req("GET", "/eier/pay-a/betaling/retur", { headers: cookie("ptok-b") });
    eq(r.status, 403, "ret-04: return with another agent's session → 403");
    r = await req("GET", "/eier/pay-a/betaling/fornye", { headers: cookie("ptok-a") });
    eq(r.location, "https://connect.stripe.test/setup/acct_fake_1", "ret-05: refresh → fresh link for the same account");
    r = await req("GET", "/eier/pay-c/betaling/fornye", { headers: cookie("ptok-c") });
    ok((r.location || "").includes("payments_unavailable"), "ret-06: refresh without an account → portal");

    // ── 5. webhook ─────────────────────────────────────────────────────────
    const evt = (id: string, obj: any, extra: any = {}) => ({ id, object: "event", type: "account.updated", livemode: false, account: obj.id, data: { object: obj }, ...extra });
    let w = signed(evt("evt_1", { id: "acct_fake_1", charges_enabled: true, payouts_enabled: true, details_submitted: true, business_type: "individual", requirements: { disabled_reason: null } }));
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw });
    eq(r.status, 400, "wh-01: missing signature → 400");
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig.replace(/v1=[0-9a-f]+/, "v1=" + "0".repeat(64)) } });
    eq(r.status, 400, "wh-02: bad signature → 400");
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw.replace('"individual"', '"company"'), headers: { "Stripe-Signature": w.sig } });
    eq(r.status, 400, "wh-03: tampered body → 400");
    eq(accountRow("pay-a").charges_enabled, 0, "wh-04: rejected deliveries change nothing");

    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.handled === true && r.body?.duplicate === false, "wh-05: valid account.updated → handled");
    acc = accountRow("pay-a");
    ok(acc.charges_enabled === 1 && acc.payouts_enabled === 1 && acc.details_submitted === 1, "wh-06: flags copied from Stripe");
    eq(acc.business_type, "individual", "wh-07: business_type stored (trader-status input)");
    ok(!!acc.charges_enabled_at, "wh-08: charges_enabled_at stamped");
    eq(eventCount("account_charges_enabled_changed"), 1, "wh-09: one state-change event");
    ok(svc.canProducerTakePrepayment(db, "pay-a"), "wh-10: producer can now take prepayment");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("klar til å ta imot betaling") && !r.text.includes("/eier/pay-a/betaling/start"), "card-08: active card, no start button");

    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.duplicate === true, "wh-11: redelivery → duplicate");
    eq(eventCount("account_charges_enabled_changed"), 1, "wh-12: redelivery adds no event");

    w = signed(evt("evt_2", { id: "acct_fake_1", charges_enabled: false }, { livemode: true }));
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.handled === false, "wh-13: live event for a test-mode row → ignored");
    eq(accountRow("pay-a").charges_enabled, 1, "wh-14: … row unchanged");

    w = signed(evt("evt_3", { id: "acct_unknown", charges_enabled: true }));
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.handled === false, "wh-15: unknown account → 200, ignored");

    w = signed({ id: "evt_4", object: "event", type: "payment_intent.created", livemode: false, account: "acct_fake_1", data: { object: { id: "pi_x" } } });
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.status === 200 && r.body?.handled === false, "wh-16: unhandled event type → 200, recorded, ignored");

    w = signed(evt("evt_5", { id: "acct_fake_1", charges_enabled: false, details_submitted: true, requirements: { disabled_reason: "requirements.past_due" } }));
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    ok(r.body?.handled === true && accountRow("pay-a").charges_enabled === 0, "wh-17: Stripe disables charges → prepayment off");
    ok(!svc.canProducerTakePrepayment(db, "pay-a"), "wh-18: … canProducerTakePrepayment false");
    r = await req("GET", "/eier/pay-a/portal", { headers: cookie("ptok-a") });
    ok(r.text.includes("Stripe trenger flere opplysninger"), "card-09: restricted card");

    w = signed(evt("evt_6", { id: "acct_fake_1", charges_enabled: true, details_submitted: true }));
    await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    w = signed({ id: "evt_7", object: "event", type: "account.application.deauthorized", livemode: false, account: "acct_fake_1", data: { object: { id: "ca_x" } } });
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    acc = accountRow("pay-a");
    ok(r.body?.handled === true && acc.charges_enabled === 0 && acc.disabled_reason === "deauthorized", "wh-19: producer disconnects → prepayment off");
    eq(eventCount("account_deauthorized"), 1, "wh-20: deauthorization logged");
    const ledger = (db.prepare(`SELECT COUNT(*) AS n FROM payment_webhook_events`).get() as any).n;
    eq(ledger, 7, "wh-21: every distinct verified event recorded once");

    app.set("paymentsWebhookSecret", undefined);
    const prevSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    eq(r.status, 503, "wh-22: no webhook secret configured → 503");
    if (prevSecret !== undefined) process.env.STRIPE_CONNECT_WEBHOOK_SECRET = prevSecret;
    app.set("paymentsWebhookSecret", FAKE_SECRET);

    // ── 6. live-key guard on the request path ──────────────────────────────
    app.set("paymentsStripeClient", undefined);
    process.env.STRIPE_SECRET_KEY = FAKE_LIVE_KEY;
    r = await req("POST", "/eier/pay-a/betaling/start", { headers: cookie("ptok-a"), form: {} });
    ok(r.status === 303 && (r.location || "").includes("payments_unavailable"), "guard-01: live key under a running app → onboarding refused");
    w = signed(evt("evt_8", { id: "acct_fake_1", charges_enabled: true }));
    r = await req("POST", "/api/payments/stripe/webhook", { raw: w.raw, headers: { "Stripe-Signature": w.sig } });
    eq(r.status, 503, "guard-02: live key under a running app → webhook refused");
    eq(svc.getProducerPaymentStatus(db, "pay-a").state, "disabled", "guard-03: producer state disabled while the guard refuses");
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_KEY;
    app.set("paymentsStripeClient", fake.client);

    // ── 7. admin ───────────────────────────────────────────────────────────
    r = await req("GET", "/admin/payments/status");
    eq(r.status, 403, "adm-01: status without key → 403");
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = FAKE_SECRET;
    r = await req("GET", "/admin/payments/status", { headers: { "X-Admin-Key": "pay-admin-key" } });
    ok(r.status === 200 && r.body?.payments_enabled === true && r.body?.livemode === false, "adm-02: status shows enabled, test mode");
    ok(r.body?.connect_webhook_secret_configured === true && r.body?.pilot_agent_count === 2, "adm-03: secret presence + pilot count");
    ok(!r.text.includes(FAKE_SECRET) && !r.text.includes(FAKE_TEST_KEY), "adm-04: no secret or key in the output");
    r = await req("GET", "/admin/payments/accounts", { headers: { "X-Admin-Key": "pay-admin-key" } });
    const rows = r.body?.accounts || [];
    ok(r.status === 200 && rows.length === 1 && rows[0].agent_id === "pay-a" && rows[0].agent_name === "Gard Alfa", "adm-05: accounts list");
    ok(!r.text.includes("alfa@example.no"), "adm-06: no producer e-mail in the admin list");
    r = await req("GET", "/admin/payments/accounts");
    eq(r.status, 403, "adm-07: accounts without key → 403");
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
