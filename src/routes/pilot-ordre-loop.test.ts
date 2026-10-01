/**
 * pilot-ordre-loop.test.ts — integration/unit tests for dev-request
 * 2026-07-13-pilot-ordre-loop: seller notification (gated), order
 * lifecycle transitions + timeline, producer PRG confirm page,
 * trust-ledger events, admin opt-in + inbox endpoints.
 *
 * Covers:
 *   (a) Opt-in gate NEGATIVE (integration): a default agent (opt_in=0)
 *       receives NO email on cart submit — the never-send default. Since
 *       skive 2 of dev-request 2026-09-16-handleliste-med-produsentvalg-og-
 *       bestillingsflyt it does not even get an ORDER: submit demotes it to
 *       a contact handoff (cart-service.isEligibleForRealOrder()).
 *   (b) Opt-in gate positive: verified + opt-in producer gets exactly one
 *       email per order, with the tokenized /produsent/ordre/:token link,
 *       WITHOUT the buyer's full capability token, and the
 *       `[order-notify] sent <ms>` latency log line fires.
 *   (c) resolveOrderNotificationRecipient unit matrix: every deny reason
 *       (agent_not_found / not_opted_in / no_email / unverified_contact /
 *       blocklisted) and both allow paths (verified_contact /
 *       admin_override — Daniel's-test-inbox pattern).
 *   (d) POST /admin/orders/notification-optin: auth, validation, opt-in
 *       set/clear, admin email override.
 *   (e) Producer PRG page: GET mutates nothing, POST transitions
 *       (confirm/decline/ready/complete/no_show) with PRG 303 redirects,
 *       illegal actions rejected, cancel_reason='no_show' stored.
 *   (f) Full transition matrix via transitionOrder() — every (from, to)
 *       pair, legal iff in VALID_TRANSITIONS.
 *   (g) order_events timeline exposed in the buyer order view
 *       (lokal_order_status shares svcGetOrder).
 *   (h) trust_events written at terminal states; trust-score interaction
 *       signal: 0 events = unchanged value, completed lifts, no-shows lower.
 *   (i) GET /admin/orders/inbox: auth + open orders listing.
 *   (j) skive 2 — isEligibleForRealOrder() strict matrix: cross-check AND
 *       owner claim (is_verified) AND opt-in AND reachable, every clause
 *       independently false; the admin override never substitutes.
 *   (k) skive 2 — v2 e-mail: «Kunde» block + Reply-To = buyer e-mail when
 *       the buyer consented; the producer PRG page shows the same block.
 *   (l) skive 2 — no consent: no «Kunde» block, default Reply-To, NULL
 *       contact columns on the order, nothing on the PRG page.
 *   (m) skive 2 — ORDER_NOTIFY_EMAIL_VERSION=v1 pins the original template
 *       (no «Kunde» block, default Reply-To) even with consent.
 *   (n) skive 2 — resolveReplyTo() header-injection guard, partial fields,
 *       render dispatcher (unit level).
 *
 * DB is a fresh in-memory SQLite with the real production schema
 * (__initSchemaForTesting). Cart/notify/trust module-local DB handles are
 * pinned (race-proof, same idiom as tests/test.ts's cart block). The email
 * send path is stubbed via __setOrderNotifySendForTesting — no real SMTP.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/pilot-ordre-loop.test.ts
 *   2. Wired into the gate: tests/test.ts imports runPilotOrdreLoopTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runPilotOrdreLoopTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const trustEvtSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
  const adminOrdersMod = require("../routes/admin-orders") as typeof import("../routes/admin-orders");

  const prevDb = (() => {
    try { return initMod.getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevEmailVersion = process.env.ORDER_NOTIFY_EMAIL_VERSION;

  const testDb = new Database(":memory:");
  const ADMIN_KEY = process.env.ADMIN_KEY || "pilot-ordre-loop-test-key";
  const DANIEL_EMAIL = "da.fredriksen@gmail.com";

  // Captured notification sends (stubbed transport).
  const sent: Array<{ to: string; subject: string; htmlContent: string; textContent: string; replyTo?: string }> = [];

  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(testDb as any);
    initMod.__initSchemaForTesting(testDb as any);
    // Race-proof module-local pins (same DB as the global singleton here).
    cartSvc.__setCartTestDb(testDb as any);
    trustEvtSvc.__setTrustEventTestDb(testDb as any);
    notifySvc.__setOrderNotifyTestDb(testDb as any);
    adminOrdersMod.__setAdminOrdersTestDb(testDb as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject, htmlContent: o.htmlContent, textContent: o.textContent, replyTo: o.replyTo });
      return { success: true, messageId: "stub" };
    });
    process.env.ADMIN_KEY = ADMIN_KEY;

    // ── Seed producers ──────────────────────────────────────────────────────
    const insertAgent = testDb.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?)
    `);
    const insertKnowledge = testDb.prepare(
      "INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, ?)"
    );
    const insertProduct = testDb.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability)
      VALUES (?, ?, ?, ?, ?, ?, 'in_stock')
    `);

    // Verified producer WITHOUT opt-in (the platform default) — negative case.
    insertAgent.run("ag-optout", "Optout Gård", "optout@example.no", "key-optout");
    insertKnowledge.run("ag-optout", "verified");
    insertProduct.run("prod-optout", "ag-optout", "Poteter", "poteter", 40, "kg");

    // Verified producer WITH opt-in — the happy send path. skive 2: a REAL
    // order also needs the owner claim (is_verified=1).
    insertAgent.run("ag-optin", "Optin Gård", "optin@example.no", "key-optin");
    insertKnowledge.run("ag-optin", "verified");
    testDb.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = 'ag-optin'").run();
    insertProduct.run("prod-optin", "ag-optin", "Egg", "egg", 60, "brett");

    // Daniel's test agent: verified (so it's orderable) — the admin endpoint
    // will point its notifications at Daniel's own inbox.
    insertAgent.run("ag-daniel", "Daniels Testgård", "gard@example.no", "key-daniel");
    insertKnowledge.run("ag-daniel", "verified");
    // skive 2: owner-claimed too — the admin override only ROUTES the mail,
    // it never substitutes for the cross-check or the claim.
    testDb.prepare("UPDATE agents SET is_verified = 1 WHERE id = 'ag-daniel'").run();
    insertProduct.run("prod-daniel", "ag-daniel", "Honning", "honning", 120, "glass");

    // Gate-matrix-only agents (not orderable through the cart; exercised via
    // resolveOrderNotificationRecipient directly).
    insertAgent.run("ag-unverif", "Uverifisert Gård", "unverif@example.no", "key-unverif");
    insertKnowledge.run("ag-unverif", "unverified");
    testDb.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-unverif'").run();

    insertAgent.run("ag-noemail", "Ingen Epost Gård", "", "key-noemail");
    insertKnowledge.run("ag-noemail", "verified");
    testDb.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-noemail'").run();

    insertAgent.run("ag-blocked", "Blokkert Gård", "blocked@example.no", "key-blocked");
    insertKnowledge.run("ag-blocked", "verified");
    testDb.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-blocked'").run();
    testDb.prepare(`
      INSERT INTO agent_blocklist (identifier_type, identifier_value, reason)
      VALUES ('email', 'blocked@example.no', 'pilot-ordre-loop test suppression')
    `).run();

    // Trust-score agents (h).
    insertAgent.run("ag-trust-a", "Trust A Gård", "trusta@example.no", "key-trust-a");
    insertKnowledge.run("ag-trust-a", "verified");
    insertAgent.run("ag-trust-b", "Trust B Gård", "trustb@example.no", "key-trust-b");
    insertKnowledge.run("ag-trust-b", "verified");
    insertAgent.run("ag-trust-c", "Trust C Etablert Gård", "trustc@example.no", "key-trust-c");
    insertKnowledge.run("ag-trust-c", "verified");

    // ── HTTP app (real routers, real sockets — PRG needs redirects) ─────────
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
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    function req(
      method: string,
      urlPath: string,
      reqOpts: { headers?: Record<string, string>; body?: any; form?: Record<string, string> } = {}
    ): Promise<{ status: number; body: any; text: string; location: string | undefined }> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(reqOpts.headers || {}) };
        if (reqOpts.form) {
          bodyStr = new URLSearchParams(reqOpts.form).toString();
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        } else if (reqOpts.body !== undefined) {
          bodyStr = JSON.stringify(reqOpts.body);
          headers["Content-Type"] = "application/json";
        }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null;
            try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
            resolve({
              status: resp.statusCode || 0,
              body: parsed,
              text: raw,
              location: resp.headers["location"] as string | undefined,
            });
          });
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }

    async function waitFor(cond: () => boolean, ms = 1000): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return cond();
    }

    async function submitCartFor(
      productId: string,
      contact: Record<string, unknown> = {}
    ): Promise<{ orderId: string; buyerRef: string; cartId: string; status: number; orders: any[]; contactHandoffs: any[] }> {
      const c = await req("POST", "/api/marketplace/cart");
      const cartId = c.body.cart_id as string;
      const buyerRef = c.body.buyer_ref as string;
      await req("POST", `/api/marketplace/cart/${cartId}/items`, {
        body: { product_id: productId, qty: 2, buyer_ref: buyerRef },
      });
      const s = await req("POST", `/api/marketplace/cart/${cartId}/submit`, {
        body: { buyer_ref: buyerRef, ...contact },
      });
      const orderId = s.body?.orders?.[0]?.order_id as string;
      return {
        orderId, buyerRef, cartId, status: s.status,
        orders: (s.body?.orders ?? []) as any[],
        contactHandoffs: (s.body?.contact_handoffs ?? []) as any[],
      };
    }

    // ════════════════════════════════════════════════════════════════════════
    // (a) Opt-in gate NEGATIVE: default agent gets NO notification. Ever.
    //     skive 2: …and no ORDER either — a cross-check-verified producer
    //     without owner claim + opt-in is demoted to a contact handoff at
    //     submit (isEligibleForRealOrder), closing the "dead pending order
    //     nobody is told about" gap. The add-to-cart gate is unchanged.
    // ════════════════════════════════════════════════════════════════════════
    {
      sent.length = 0;
      const r = await submitCartFor("prod-optout");
      assertEq(r.status, 201, "optin-neg-01: submit against a non-opted-in producer still succeeds (201) — demoted, not rejected");
      assertEq(r.orders.length, 0, "optin-neg-01b: NO order is created for a producer who has not opted in (skive 2 strict gate)");
      assertEq(r.contactHandoffs.length, 1, "optin-neg-01c: the producer comes back as exactly one contact handoff instead");
      assertEq(r.contactHandoffs[0]?.agent_id, "ag-optout", "optin-neg-01d: the handoff is for the non-opted-in producer");
      // Give the fire-and-forget path ample time to (wrongly) send.
      await new Promise((r2) => setTimeout(r2, 150));
      assertEq(sent.length, 0, "optin-neg-02: NO email sent to a producer with default opt_in=0 (the never-send default)");
      const orderRows = testDb.prepare("SELECT COUNT(*) AS c FROM orders WHERE cart_id = ?").get(r.cartId) as any;
      assertEq(orderRows?.c, 0, "optin-neg-03: no orders row exists for that cart (no dead pending order)");
      const handoffRows = testDb.prepare("SELECT COUNT(*) AS c FROM cart_handoffs WHERE cart_id = ? AND agent_id = 'ag-optout'").get(r.cartId) as any;
      assertEq(handoffRows?.c, 1, "optin-neg-04: one cart_handoffs analytics row written for the demoted producer");
      assertEq(cartSvc.isProducerEligible("ag-optout"), true, "optin-neg-05: the add-to-cart gate (isProducerEligible) is UNCHANGED — still true for the cross-check-verified producer");
      assertEq(cartSvc.isEligibleForRealOrder("ag-optout"), false, "optin-neg-06: isEligibleForRealOrder() is false for it (no owner claim, no opt-in)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (b) Opt-in positive: exactly one gated email, tokenized link, latency log
    // ════════════════════════════════════════════════════════════════════════
    let optinToken = "";
    let optinOrderId = "";
    let optinBuyerRef = "";
    {
      sent.length = 0;
      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => { logLines.push(args.map(String).join(" ")); origLog.apply(console, args); };
      let sub: { orderId: string; buyerRef: string };
      try {
        sub = await submitCartFor("prod-optin");
        await waitFor(() => sent.length >= 1);
        // The latency log line lands right after the awaited send resolves.
        await waitFor(() => logLines.some((l) => l.includes("[order-notify] sent")));
      } finally {
        console.log = origLog;
      }
      optinOrderId = sub.orderId;
      optinBuyerRef = sub.buyerRef;
      assertEq(sent.length, 1, "optin-pos-01: exactly one email per created order");
      const mail = sent[0]!;
      assertEq(mail.to, "optin@example.no", "optin-pos-02: recipient is the producer's verified contact_email");
      assertTrue(mail.subject.includes(optinOrderId.slice(0, 8)), "optin-pos-03: subject carries the order ref");
      assertTrue(mail.textContent.includes("Egg") && mail.textContent.includes("2 brett"),
        "optin-pos-04: email lists item name + qty + unit");
      const m = mail.textContent.match(/\/produsent\/ordre\/(ctok_[a-f0-9]+)/);
      assertTrue(!!m, "optin-pos-05: email contains the tokenized producer confirm link");
      optinToken = m ? m[1]! : "";
      const dbTok = (testDb.prepare("SELECT confirm_token FROM orders WHERE id = ?").get(optinOrderId) as any)?.confirm_token;
      assertEq(optinToken, dbTok, "optin-pos-06: linked token IS the order's confirm_token");
      assertTrue(!mail.textContent.includes(optinBuyerRef) && !mail.htmlContent.includes(optinBuyerRef),
        "optin-pos-07: the buyer's full capability token never appears in the producer email (masked ref only)");
      assertTrue(logLines.some((l) => /\[order-notify\] sent \d+ms/.test(l)),
        "optin-pos-08: '[order-notify] sent <ms>' latency log line emitted (SLA measurable)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (c) Recipient-gate unit matrix
    // ════════════════════════════════════════════════════════════════════════
    {
      const r1 = notifySvc.resolveOrderNotificationRecipient("no-such-agent");
      assertTrue(!r1.eligible && r1.reason === "agent_not_found", "gate-01: unknown agent → agent_not_found");
      const r2 = notifySvc.resolveOrderNotificationRecipient("ag-optout");
      assertTrue(!r2.eligible && r2.reason === "not_opted_in", "gate-02: opt_in=0 → not_opted_in (default deny)");
      const r3 = notifySvc.resolveOrderNotificationRecipient("ag-unverif");
      assertTrue(!r3.eligible && r3.reason === "unverified_contact",
        "gate-03: opt-in but unverified contact and no admin override → unverified_contact");
      const r4 = notifySvc.resolveOrderNotificationRecipient("ag-noemail");
      assertTrue(!r4.eligible && r4.reason === "no_email", "gate-04: opt-in + verified but no email anywhere → no_email");
      const r5 = notifySvc.resolveOrderNotificationRecipient("ag-blocked");
      assertTrue(!r5.eligible && r5.reason === "blocklisted",
        "gate-05: opt-in + verified but blocklisted address → blocklisted (suppression gate)");
      const r6 = notifySvc.resolveOrderNotificationRecipient("ag-optin");
      assertTrue(r6.eligible && r6.email === "optin@example.no" && r6.via === "verified_contact",
        "gate-06: opt-in + verified contact → eligible via verified_contact");
      // Admin override on an UNVERIFIED agent satisfies the verified clause
      // (an admin explicitly chose the recipient — Daniel's-test-inbox rule).
      testDb.prepare("UPDATE agents SET order_notification_email = ? WHERE id = 'ag-unverif'").run(DANIEL_EMAIL);
      const r7 = notifySvc.resolveOrderNotificationRecipient("ag-unverif");
      assertTrue(r7.eligible && r7.email === DANIEL_EMAIL && r7.via === "admin_override",
        "gate-07: admin-set order_notification_email overrides the verified-contact requirement");
      testDb.prepare("UPDATE agents SET order_notification_email = NULL WHERE id = 'ag-unverif'").run();
    }

    // ════════════════════════════════════════════════════════════════════════
    // (d) POST /admin/orders/notification-optin
    // ════════════════════════════════════════════════════════════════════════
    {
      const noKey = await req("POST", "/admin/orders/notification-optin", {
        body: { agent_id: "ag-daniel", opt_in: true },
      });
      assertEq(noKey.status, 403, "optin-admin-01: missing X-Admin-Key → 403");

      const badAgent = await req("POST", "/admin/orders/notification-optin", {
        headers: { "x-admin-key": ADMIN_KEY },
        body: { agent_id: "nope", opt_in: true },
      });
      assertEq(badAgent.status, 404, "optin-admin-02: unknown agent → 404");

      const badEmail = await req("POST", "/admin/orders/notification-optin", {
        headers: { "x-admin-key": ADMIN_KEY },
        body: { agent_id: "ag-daniel", opt_in: true, email: "not-an-email" },
      });
      assertEq(badEmail.status, 400, "optin-admin-03: invalid email → 400");

      // Daniel's pilot setup: opt the test agent in, notifications to HIS inbox.
      const ok = await req("POST", "/admin/orders/notification-optin", {
        headers: { "x-admin-key": ADMIN_KEY },
        body: { agent_id: "ag-daniel", opt_in: true, email: DANIEL_EMAIL },
      });
      assertEq(ok.status, 200, "optin-admin-04: valid opt-in returns 200");
      assertEq(ok.body?.opt_in, true, "optin-admin-05: response reflects opt_in=true");
      assertEq(ok.body?.order_notification_email, DANIEL_EMAIL, "optin-admin-06: response reflects the override email");
      const row = testDb.prepare(
        "SELECT order_notifications_opt_in AS o, order_notification_email AS e FROM agents WHERE id = 'ag-daniel'"
      ).get() as any;
      assertEq(row?.o, 1, "optin-admin-07: DB opt_in persisted");
      assertEq(row?.e, DANIEL_EMAIL, "optin-admin-08: DB override email persisted");

      // Integration: submit an order → email goes to Daniel's inbox, not the
      // agent's own contact_email.
      sent.length = 0;
      await submitCartFor("prod-daniel");
      await waitFor(() => sent.length >= 1);
      assertEq(sent.length, 1, "optin-admin-09: test-agent order sends exactly one email");
      assertEq(sent[0]?.to, DANIEL_EMAIL,
        "optin-admin-10: test notification goes ONLY to Daniel's admin-set inbox (send-vern)");

      // Opt back OUT (no email field → override untouched) → next order silent.
      const off = await req("POST", "/admin/orders/notification-optin", {
        headers: { "x-admin-key": ADMIN_KEY },
        body: { agent_id: "ag-daniel", opt_in: false },
      });
      assertEq(off.status, 200, "optin-admin-11: opt-out returns 200");
      sent.length = 0;
      const afterOptOut = await submitCartFor("prod-daniel");
      await new Promise((r) => setTimeout(r, 150));
      assertEq(sent.length, 0, "optin-admin-12: after opt-out no email is sent again");
      assertEq(afterOptOut.orders.length, 0, "optin-admin-12b: skive 2 — after opt-out the producer gets no ORDER either (contact handoff instead)");
      assertEq(afterOptOut.contactHandoffs.map((h) => h.agent_id).join(","), "ag-daniel", "optin-admin-12c: the opted-out producer is returned as a contact handoff");
      // Re-enable for later sections.
      await req("POST", "/admin/orders/notification-optin", {
        headers: { "x-admin-key": ADMIN_KEY },
        body: { agent_id: "ag-daniel", opt_in: true },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // (e) Producer PRG page — GET mutates nothing; POST transitions
    // ════════════════════════════════════════════════════════════════════════
    {
      const notFound = await req("GET", "/produsent/ordre/ctok_doesnotexist");
      assertEq(notFound.status, 404, "prg-01: unknown token → 404");

      const page = await req("GET", `/produsent/ordre/${optinToken}`);
      assertEq(page.status, 200, "prg-02: valid token → 200 HTML page");
      assertTrue(page.text.includes(optinOrderId.slice(0, 8)), "prg-03: page shows the order ref");
      assertTrue(page.text.includes("Bekreft ordren") && page.text.includes("Avslå"),
        "prg-04: pending order offers Bekreft + Avslå actions");
      const statusAfterGet = (testDb.prepare("SELECT status FROM orders WHERE id = ?").get(optinOrderId) as any)?.status;
      assertEq(statusAfterGet, "pending", "prg-05: GET mutates NOTHING — status still pending");
      const evAfterGet = testDb.prepare("SELECT COUNT(*) AS c FROM order_events WHERE order_id = ?").get(optinOrderId) as any;
      assertEq(evAfterGet?.c, 0, "prg-06: GET writes no order_events");

      // pending → confirmed
      const confirm = await req("POST", `/produsent/ordre/${optinToken}`, { form: { action: "confirm" } });
      assertEq(confirm.status, 303, "prg-07: POST confirm → 303 (PRG)");
      assertTrue((confirm.location || "").includes("done=confirmed"), "prg-08: redirect carries done=confirmed");
      assertEq((testDb.prepare("SELECT status FROM orders WHERE id = ?").get(optinOrderId) as any)?.status,
        "confirmed", "prg-09: order is confirmed");

      // Illegal re-confirm → error redirect, no state change, no event
      const reconfirm = await req("POST", `/produsent/ordre/${optinToken}`, { form: { action: "confirm" } });
      assertEq(reconfirm.status, 303, "prg-10: illegal action still 303 (PRG, no 5xx)");
      assertTrue((reconfirm.location || "").includes("error=ugyldig"), "prg-11: redirect carries error=ugyldig");
      const evCount1 = (testDb.prepare("SELECT COUNT(*) AS c FROM order_events WHERE order_id = ?").get(optinOrderId) as any)?.c;
      assertEq(evCount1, 1, "prg-12: illegal transition writes no order_events row");

      // Unknown action → error redirect
      const bogus = await req("POST", `/produsent/ordre/${optinToken}`, { form: { action: "explode" } });
      assertTrue(bogus.status === 303 && (bogus.location || "").includes("error=ugyldig"),
        "prg-13: unknown action → error redirect");

      // Review fix, finding 3: no_show is NOT reachable from 'confirmed' —
      // an order that was never ready for pickup can't be booked as no-show.
      const earlyNoShow = await req("POST", `/produsent/ordre/${optinToken}`, { form: { action: "no_show" } });
      assertTrue(earlyNoShow.status === 303 && (earlyNoShow.location || "").includes("error=ugyldig"),
        "prg-13b: PRG no_show on a confirmed order → rejected (error=ugyldig)");
      const afterEarly = testDb.prepare("SELECT status, cancel_reason FROM orders WHERE id = ?").get(optinOrderId) as any;
      assertTrue(afterEarly?.status === "confirmed" && afterEarly?.cancel_reason == null,
        "prg-13c: rejected early no_show changes nothing (still confirmed, no cancel_reason)");
      const earlyTrust = testDb.prepare(
        "SELECT COUNT(*) AS c FROM trust_events WHERE event_type = 'order_no_show' AND ref = ?"
      ).get(optinOrderId) as any;
      assertEq(earlyTrust?.c, 0, "prg-13d: rejected early no_show writes no trust event");
      const adminEarlyNoShow = await req("POST", `/admin/marketplace/orders/${optinOrderId}/no-show`, {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      assertEq(adminEarlyNoShow.status, 409, "prg-13e: admin no-show on a confirmed order → 409 (same central guard)");
      // Plain confirmed → cancelled (no reason) stays legal — verified in the
      // 6×6 matrix below; here we only pin that the no_show REASON is gated.

      // confirmed → ready → cancelled (no_show)
      await req("POST", `/produsent/ordre/${optinToken}`, { form: { action: "ready" } });
      assertEq((testDb.prepare("SELECT status FROM orders WHERE id = ?").get(optinOrderId) as any)?.status,
        "ready", "prg-14: Klar for henting → ready");
      const noshow = await req("POST", `/produsent/ordre/${optinToken}`, { form: { action: "no_show" } });
      assertTrue((noshow.location || "").includes("done=cancelled"), "prg-15: no_show redirects with done=cancelled");
      const finalRow = testDb.prepare("SELECT status, cancel_reason FROM orders WHERE id = ?").get(optinOrderId) as any;
      assertEq(finalRow?.status, "cancelled", "prg-16: no_show → cancelled");
      assertEq(finalRow?.cancel_reason, "no_show", "prg-17: cancel_reason='no_show' stored");
      const noshowTrust = testDb.prepare(
        "SELECT COUNT(*) AS c FROM trust_events WHERE agent_id = 'ag-optin' AND event_type = 'order_no_show' AND ref = ?"
      ).get(optinOrderId) as any;
      assertEq(noshowTrust?.c, 1, "prg-18: order_no_show trust event written with order ref");

      // Full happy path on Daniel's agent: confirm → ready → complete
      sent.length = 0;
      const { orderId: dOrder } = await submitCartFor("prod-daniel");
      const dToken = (testDb.prepare("SELECT confirm_token FROM orders WHERE id = ?").get(dOrder) as any)?.confirm_token;
      await req("POST", `/produsent/ordre/${dToken}`, { form: { action: "confirm" } });
      await req("POST", `/produsent/ordre/${dToken}`, { form: { action: "ready" } });
      const complete = await req("POST", `/produsent/ordre/${dToken}`, { form: { action: "complete" } });
      assertTrue((complete.location || "").includes("done=completed"), "prg-19: Hentet redirects with done=completed");
      assertEq((testDb.prepare("SELECT status FROM orders WHERE id = ?").get(dOrder) as any)?.status,
        "completed", "prg-20: order completed");
      const completedTrust = testDb.prepare(
        "SELECT COUNT(*) AS c FROM trust_events WHERE agent_id = 'ag-daniel' AND event_type = 'order_completed' AND ref = ?"
      ).get(dOrder) as any;
      assertEq(completedTrust?.c, 1, "prg-21: order_completed trust event written");

      // Decline path: fresh order → decline → trust event order_declined
      const { orderId: declOrder } = await submitCartFor("prod-optin");
      const declToken = (testDb.prepare("SELECT confirm_token FROM orders WHERE id = ?").get(declOrder) as any)?.confirm_token;
      const decl = await req("POST", `/produsent/ordre/${declToken}`, { form: { action: "decline" } });
      assertTrue((decl.location || "").includes("done=declined"), "prg-22: Avslå redirects with done=declined");
      const declinedTrust = testDb.prepare(
        "SELECT COUNT(*) AS c FROM trust_events WHERE agent_id = 'ag-optin' AND event_type = 'order_declined' AND ref = ?"
      ).get(declOrder) as any;
      assertEq(declinedTrust?.c, 1, "prg-23: order_declined trust event written");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (f) Transition matrix — every (from, to) pair via transitionOrder()
    // ════════════════════════════════════════════════════════════════════════
    {
      const STATUSES = ["pending", "confirmed", "declined", "ready", "completed", "cancelled"] as const;
      const ALLOWED: Record<string, string[]> = {
        pending:   ["confirmed", "declined"],
        confirmed: ["ready", "cancelled"],
        ready:     ["completed", "cancelled"],
        declined:  [],
        completed: [],
        cancelled: [],
      };
      let matrixOk = true;
      const matrixFailures: string[] = [];
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const oid = `matrix-${from}-${to}`;
          testDb.prepare(`
            INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, created_at, updated_at)
            VALUES (?, 'ag-optout', 'bref_matrix', ?, 'pickup', ?, datetime('now'), datetime('now'))
          `).run(oid, from, `ctok_${from}${to}`);
          const res = cartSvc.transitionOrder(oid, to, { actor: "test" });
          const shouldPass = ALLOWED[from]!.includes(to);
          if (res.success !== shouldPass) {
            matrixOk = false;
            matrixFailures.push(`${from}→${to}: expected ${shouldPass ? "ALLOW" : "REJECT"}, got ${res.success ? "ALLOW" : "REJECT"}`);
          }
          if (!shouldPass && res.success === false && res.status !== 409) {
            matrixOk = false;
            matrixFailures.push(`${from}→${to}: rejection should be 409, got ${res.status}`);
          }
        }
      }
      assertTrue(matrixOk, `matrix-01: full 6×6 transition matrix matches VALID_TRANSITIONS${matrixOk ? "" : " — " + matrixFailures.join("; ")}`);
      const unknown = cartSvc.transitionOrder("no-such-order", "confirmed");
      assertTrue(!unknown.success && unknown.status === 404, "matrix-02: unknown order → 404");
      // updated_at is touched by a legal transition.
      testDb.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, created_at, updated_at)
        VALUES ('matrix-upd', 'ag-optout', 'bref_matrix', 'pending', 'pickup', 'ctok_upd', datetime('now','-1 hour'), datetime('now','-1 hour'))
      `).run();
      const before = (testDb.prepare("SELECT updated_at FROM orders WHERE id = 'matrix-upd'").get() as any)?.updated_at;
      cartSvc.transitionOrder("matrix-upd", "confirmed", { actor: "test" });
      const after = (testDb.prepare("SELECT updated_at FROM orders WHERE id = 'matrix-upd'").get() as any)?.updated_at;
      assertTrue(String(after) > String(before), "matrix-03: legal transition bumps updated_at");

      // Review fix, finding 3 (unit level): the no_show REASON is gated on
      // from-status 'ready' even though confirmed → cancelled itself is legal.
      testDb.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, created_at, updated_at)
        VALUES ('matrix-ns-conf', 'ag-optout', 'bref_matrix', 'confirmed', 'pickup', 'ctok_nsconf', datetime('now'), datetime('now'))
      `).run();
      const nsConf = cartSvc.transitionOrder("matrix-ns-conf", "cancelled", { actor: "test", cancelReason: "no_show" });
      assertTrue(!nsConf.success && nsConf.status === 409,
        "matrix-04: cancelled with cancelReason='no_show' from 'confirmed' → 409 (never was ready)");
      const plainCancel = cartSvc.transitionOrder("matrix-ns-conf", "cancelled", { actor: "test" });
      assertTrue(plainCancel.success === true,
        "matrix-05: plain confirmed → cancelled (no reason) remains legal");
      testDb.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, created_at, updated_at)
        VALUES ('matrix-ns-ready', 'ag-optout', 'bref_matrix', 'ready', 'pickup', 'ctok_nsready', datetime('now'), datetime('now'))
      `).run();
      const nsReady = cartSvc.transitionOrder("matrix-ns-ready", "cancelled", { actor: "test", cancelReason: "no_show" });
      assertTrue(nsReady.success === true &&
        (testDb.prepare("SELECT cancel_reason FROM orders WHERE id = 'matrix-ns-ready'").get() as any)?.cancel_reason === "no_show",
        "matrix-06: no_show from 'ready' is legal and persists cancel_reason");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (g) Buyer order view exposes the order_events timeline
    // ════════════════════════════════════════════════════════════════════════
    {
      const r = await req("GET", `/api/marketplace/orders/${optinOrderId}?buyer_ref=${optinBuyerRef}`);
      assertEq(r.status, 200, "timeline-01: buyer order view returns 200");
      assertEq(r.body?.status, "cancelled", "timeline-02: current status is the terminal one");
      assertEq(r.body?.cancel_reason, "no_show", "timeline-03: cancel_reason surfaced to the buyer");
      assertTrue(Array.isArray(r.body?.timeline), "timeline-04: timeline array present (lokal_order_status shares this view)");
      const tl = (r.body?.timeline || []) as Array<{ from_status: string | null; to_status: string; actor: string | null }>;
      assertEq(tl.length, 3, `timeline-05: three transitions recorded (got ${tl.length})`);
      assertTrue(
        tl[0]?.from_status === "pending" && tl[0]?.to_status === "confirmed" &&
        tl[1]?.from_status === "confirmed" && tl[1]?.to_status === "ready" &&
        tl[2]?.from_status === "ready" && tl[2]?.to_status === "cancelled",
        "timeline-06: timeline is ordered pending→confirmed→ready→cancelled"
      );
      assertTrue(tl.every((e) => e.actor === "producer"), "timeline-07: PRG transitions record actor='producer'");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (h) Trust-ledger → trust-score interaction signal
    // ════════════════════════════════════════════════════════════════════════
    {
      const { trustScoreService } = require("../services/trust-score-service") as
        typeof import("../services/trust-score-service");

      // 0 events → exactly today's (pre-ledger) value.
      const baseline = trustScoreService.getBreakdown("ag-trust-a").signals.interaction.value;
      assertEq(baseline, 0, "trust-01: agent with no metrics and no trust events keeps interaction=0 (unchanged)");

      // Completed pickups lift the signal.
      for (let i = 0; i < 5; i++) {
        const ok = trustEvtSvc.recordTrustEvent({ agentId: "ag-trust-a", eventType: "order_completed", ref: `t-${i}` });
        if (i === 0) assertTrue(ok, "trust-02: recordTrustEvent returns true on a valid write");
      }
      const lifted = trustScoreService.getBreakdown("ag-trust-a").signals.interaction.value;
      assertTrue(lifted > baseline, `trust-03: completed orders lift the interaction signal (${baseline} → ${lifted})`);

      // Review fix, finding 1 — monotonicity with a HIGH base: an established
      // producer (base≈0.998 from agent_metrics) must NOT drop after their
      // first completed pickup (the raw 0.6/0.4 blend alone would give ≈0.72).
      testDb.prepare(`
        INSERT INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen)
        VALUES ('ag-trust-c', 100, 30, 10)
      `).run();
      const highBase = trustScoreService.getBreakdown("ag-trust-c").signals.interaction.value;
      assertTrue(highBase > 0.99, `trust-03b: seeded metrics give a high base (got ${highBase})`);
      trustEvtSvc.recordTrustEvent({ agentId: "ag-trust-c", eventType: "order_completed", ref: "c-1" });
      const afterFirst = trustScoreService.getBreakdown("ag-trust-c").signals.interaction.value;
      assertTrue(afterFirst >= highBase,
        `trust-03c: 1 completed order can NEVER lower a high-base producer (${highBase} → ${afterFirst}, max(base,·) floor)`);

      // Review fix, finding 2 — no-shows are ledger-only: they must NOT move
      // the producer's score (buyer's failure, anonymous carts — attribution
      // requires buyer identity; Daniel-level decision to change).
      for (let i = 0; i < 5; i++) {
        trustEvtSvc.recordTrustEvent({ agentId: "ag-trust-a", eventType: "order_no_show", ref: `n-${i}` });
      }
      const afterNoShows = trustScoreService.getBreakdown("ag-trust-a").signals.interaction.value;
      assertEq(afterNoShows, lifted,
        "trust-04: no-show events do NOT change the producer's interaction signal (ledger-only)");
      const ledgerRows = testDb.prepare(
        "SELECT COUNT(*) AS c FROM trust_events WHERE agent_id = 'ag-trust-a' AND event_type = 'order_no_show'"
      ).get() as any;
      assertEq(ledgerRows?.c, 5, "trust-04b: the no-show rows ARE still in the ledger (bookkeeping kept)");

      // Only no-shows: completed=0 → exactly the pre-ledger value (0 here).
      trustEvtSvc.recordTrustEvent({ agentId: "ag-trust-b", eventType: "order_no_show", ref: "b-1" });
      const onlyNoShow = trustScoreService.getBreakdown("ag-trust-b").signals.interaction.value;
      assertEq(onlyNoShow, 0, "trust-05: only-no-show agent keeps its pre-ledger value (0 — no score impact)");

      // booking_* event types are accepted by the ledger (future booking wiring).
      assertTrue(trustEvtSvc.recordTrustEvent({ agentId: "ag-trust-b", eventType: "booking_attended", ref: "bk-1" }),
        "trust-06: booking_attended is a valid ledger event type (booking-resolve hook ready)");
      // Invalid types are rejected without throwing.
      assertEq(trustEvtSvc.recordTrustEvent({ agentId: "ag-trust-b", eventType: "invalid_type" as any }), false,
        "trust-07: invalid event type is rejected (returns false, no throw)");
      // Weight constants untouched — declared drift guard.
      const bd = trustScoreService.getBreakdown("ag-trust-a");
      assertEq(bd.signals.interaction.weight, 0.2, "trust-08: interaction WEIGHT unchanged at 0.20 (scores don't jump)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (i) GET /admin/orders/inbox
    // ════════════════════════════════════════════════════════════════════════
    {
      const noKey = await req("GET", "/admin/orders/inbox?agent_id=ag-optin");
      assertEq(noKey.status, 403, "inbox-01: missing X-Admin-Key → 403");

      // Fresh open order for ag-optin (its earlier ones are terminal now).
      sent.length = 0;
      const { orderId: openOrder } = await submitCartFor("prod-optin");
      const r = await req("GET", "/admin/orders/inbox?agent_id=ag-optin", {
        headers: { "x-admin-key": ADMIN_KEY },
      });
      assertEq(r.status, 200, "inbox-02: inbox returns 200 with key");
      assertEq(r.body?.success, true, "inbox-03: success=true");
      const orders = (r.body?.orders || []) as any[];
      assertTrue(orders.some((o) => o.order_id === openOrder && o.status === "pending"),
        "inbox-04: the fresh pending order is listed for its producer");
      assertTrue(orders.every((o) => ["pending", "confirmed", "ready"].includes(o.status)),
        "inbox-05: only OPEN statuses are listed (terminal orders excluded)");
      assertTrue(orders.every((o) => o.agent_id === "ag-optin"), "inbox-06: agent_id filter respected");
      const first = orders.find((o) => o.order_id === openOrder);
      assertEq(first?.item_count, 1, "inbox-07: item_count included per order");

      const all = await req("GET", "/admin/orders/inbox", { headers: { "x-admin-key": ADMIN_KEY } });
      assertEq(all.status, 200, "inbox-08: inbox without agent_id lists across producers");
      assertTrue(((all.body?.orders || []) as any[]).length >= orders.length,
        "inbox-09: unfiltered listing is a superset of the per-producer one");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (j) skive 2 — isEligibleForRealOrder() strict matrix (no «lempning»):
    //     cross-check AND owner claim AND opt-in AND reachable. Every clause
    //     independently false; the admin override never substitutes for the
    //     cross-check or the owner claim — it only routes the mail.
    // ════════════════════════════════════════════════════════════════════════
    {
      const gate = (id: string) => cartSvc.isEligibleForRealOrder(id);
      assertEq(gate("ag-optin"), true, "strict-01: cross-check + owner claim + opt-in + verified contact → true");
      assertEq(gate("ag-optout"), false, "strict-02: cross-check only (no claim, no opt-in) → false");

      // ag-unverif: opt-in, owner claim added, cross-check 'unverified' →
      // false, and an admin override e-mail does NOT rescue it.
      testDb.prepare("UPDATE agents SET is_verified = 1 WHERE id = 'ag-unverif'").run();
      assertEq(gate("ag-unverif"), false, "strict-03: owner claim + opt-in WITHOUT the cross-check → false (no «OR is_verified» path)");
      testDb.prepare("UPDATE agents SET order_notification_email = ? WHERE id = 'ag-unverif'").run(DANIEL_EMAIL);
      assertEq(gate("ag-unverif"), false, "strict-04: admin override e-mail never substitutes for the missing cross-check");
      testDb.prepare("UPDATE agents SET order_notification_email = NULL, is_verified = 0 WHERE id = 'ag-unverif'").run();

      // Cross-check + opt-in but NO owner claim → false, override or not.
      testDb.prepare("UPDATE agents SET is_verified = 0 WHERE id = 'ag-optin'").run();
      assertEq(gate("ag-optin"), false, "strict-05: cross-check + opt-in WITHOUT the owner claim → false");
      testDb.prepare("UPDATE agents SET order_notification_email = ? WHERE id = 'ag-optin'").run(DANIEL_EMAIL);
      assertEq(gate("ag-optin"), false, "strict-06: admin override e-mail never substitutes for the missing owner claim");
      testDb.prepare("UPDATE agents SET order_notification_email = NULL, is_verified = 1 WHERE id = 'ag-optin'").run();

      // Opt-in flipped off → false.
      testDb.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = 'ag-optin'").run();
      assertEq(gate("ag-optin"), false, "strict-07: opt-in withdrawn → false (explicit, independent, mandatory)");
      testDb.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-optin'").run();

      // Second-line-only verification → false.
      testDb.prepare("UPDATE agent_knowledge SET verified_second_line = 1 WHERE agent_id = 'ag-optin'").run();
      assertEq(gate("ag-optin"), false, "strict-08: verified_second_line=1 (outreach-only bar) → false");
      testDb.prepare("UPDATE agent_knowledge SET verified_second_line = 0 WHERE agent_id = 'ag-optin'").run();

      // Deactivated row → false.
      testDb.prepare("UPDATE agents SET is_active = 0 WHERE id = 'ag-optin'").run();
      assertEq(gate("ag-optin"), false, "strict-09: is_active=0 → false");
      testDb.prepare("UPDATE agents SET is_active = 1 WHERE id = 'ag-optin'").run();

      // No recipient anywhere → false; blocklisted → false.
      testDb.prepare("UPDATE agents SET is_verified = 1 WHERE id IN ('ag-noemail', 'ag-blocked')").run();
      assertEq(gate("ag-noemail"), false, "strict-10: no contact_email and no override → false (nobody to notify)");
      assertEq(gate("ag-blocked"), false, "strict-11: blocklisted recipient → false (same suppression as the notify gate)");
      testDb.prepare("UPDATE agents SET is_verified = 0 WHERE id IN ('ag-noemail', 'ag-blocked')").run();

      assertEq(gate("no-such-agent"), false, "strict-12: unknown agent → false");
      assertEq(gate("ag-optin"), true, "strict-13: reference producer restored → true again");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (k) skive 2 — v2 e-mail (default): «Kunde» block + Reply-To = buyer's
    //     e-mail when the buyer consented; the order carries the contact
    //     copy; the producer PRG page shows the same block.
    // ════════════════════════════════════════════════════════════════════════
    {
      sent.length = 0;
      delete process.env.ORDER_NOTIFY_EMAIL_VERSION;
      assertEq(notifySvc.resolveOrderNotifyEmailVersion(), "v2", "v2-00: default e-mail version is v2 (flag unset)");
      const r = await submitCartFor("prod-optin", {
        buyer_name: "Kari Testkjøper",
        buyer_email: "kari@example.com",
        buyer_phone: "+47 91234567",
        delivery_note: "Henter etter kl 16 <torsdag>",
        contact_consent: true,
      });
      assertEq(r.orders.length, 1, "v2-01: consented submit against the eligible producer creates one order");
      await waitFor(() => sent.length >= 1);
      assertEq(sent.length, 1, "v2-02: exactly one notification sent");
      const mail = sent[0]!;
      assertEq(mail.to, "optin@example.no", "v2-03: recipient is still the producer's verified contact_email");
      assertEq(mail.replyTo, "kari@example.com", "v2-04: Reply-To is the buyer's e-mail (so the producer can answer directly)");
      assertTrue(mail.textContent.includes("Kunde:"), "v2-05: text body has the «Kunde» block");
      assertTrue(mail.textContent.includes("Navn: Kari Testkjøper"), "v2-06: text body lists the buyer's name");
      assertTrue(mail.textContent.includes("Telefon: +47 91234567"), "v2-07: text body lists the buyer's phone");
      assertTrue(mail.textContent.includes("E-post: kari@example.com"), "v2-08: text body lists the buyer's e-mail");
      assertTrue(mail.textContent.includes("Leveringsønske: Henter etter kl 16 <torsdag>"), "v2-09: text body lists the delivery wish verbatim");
      assertTrue(mail.htmlContent.includes("Kunde:") && mail.htmlContent.includes("Kari Testkjøper") && mail.htmlContent.includes("+47 91234567"),
        "v2-10: HTML body has the «Kunde» block with name + phone");
      assertTrue(mail.htmlContent.includes("Henter etter kl 16 &lt;torsdag&gt;") && !mail.htmlContent.includes("<torsdag>"),
        "v2-11: HTML body escapes the buyer-supplied delivery wish (no raw tag injection)");
      assertTrue(mail.textContent.includes("Egg") && mail.textContent.includes("2 brett"), "v2-12: v2 keeps everything v1 had (items)");
      assertTrue(/\/produsent\/ordre\/ctok_[a-f0-9]+/.test(mail.textContent), "v2-13: v2 keeps the tokenized confirm link");
      assertTrue(!mail.textContent.includes(r.buyerRef) && !mail.htmlContent.includes(r.buyerRef),
        "v2-14: the buyer's full capability token still never appears in the producer e-mail");

      const o = testDb.prepare("SELECT buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at, confirm_token FROM orders WHERE id = ?").get(r.orderId) as any;
      assertEq(o?.buyer_name, "Kari Testkjøper", "v2-15: order row carries buyer_name (consented)");
      assertEq(o?.buyer_email, "kari@example.com", "v2-16: order row carries buyer_email (consented)");
      assertEq(o?.buyer_phone, "+47 91234567", "v2-17: order row carries buyer_phone (consented)");
      assertEq(o?.delivery_note, "Henter etter kl 16 <torsdag>", "v2-18: order row carries delivery_note (consented)");
      assertTrue(typeof o?.contact_consent_at === "string" && o.contact_consent_at.length > 0, "v2-19: order row has contact_consent_at stamped");

      const page = await req("GET", `/produsent/ordre/${o.confirm_token}`);
      assertEq(page.status, 200, "v2-20: producer PRG page renders");
      assertTrue(page.text.includes("Kunde:"), "v2-21: PRG page shows the «Kunde» block");
      assertTrue(page.text.includes("Kari Testkjøper") && page.text.includes("+47 91234567") && page.text.includes("kari@example.com"),
        "v2-22: PRG page shows name, phone and e-mail");
      assertTrue(page.text.includes("Henter etter kl 16 &lt;torsdag&gt;") && !page.text.includes("<torsdag>"),
        "v2-23: PRG page escapes the delivery wish (no raw tag injection)");
      assertTrue(!page.text.includes(r.buyerRef), "v2-24: PRG page never shows the buyer's capability token");
      const statusAfterGet = (testDb.prepare("SELECT status FROM orders WHERE id = ?").get(r.orderId) as any)?.status;
      assertEq(statusAfterGet, "pending", "v2-25: rendering the buyer block mutates nothing (still pending)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (l) skive 2 — NO consent: nothing buyer-identifying reaches the producer
    //     (no «Kunde» block, default Reply-To, NULL order columns, PRG page
    //     without the block) even though the fields were typed.
    // ════════════════════════════════════════════════════════════════════════
    {
      sent.length = 0;
      const r = await submitCartFor("prod-optin", {
        buyer_name: "Ola Uten Samtykke",
        buyer_email: "ola@example.com",
        buyer_phone: "+47 99887766",
        delivery_note: "Ring først",
        contact_consent: false,
      });
      assertEq(r.orders.length, 1, "noconsent-01: the real order is still created");
      await waitFor(() => sent.length >= 1);
      assertEq(sent.length, 1, "noconsent-02: exactly one notification sent");
      const mail = sent[0]!;
      assertEq(mail.replyTo, notifySvc.DEFAULT_ORDER_NOTIFY_REPLY_TO, "noconsent-03: Reply-To is the platform default, not the buyer");
      assertTrue(!mail.textContent.includes("Kunde:") && !mail.htmlContent.includes("Kunde:"), "noconsent-04: no «Kunde» block at all (not even empty rows)");
      assertTrue(!mail.textContent.includes("Ola Uten Samtykke") && !mail.textContent.includes("ola@example.com") && !mail.textContent.includes("99887766") && !mail.textContent.includes("Ring først"),
        "noconsent-05: none of the typed contact fields appear in the text body");
      assertTrue(!mail.htmlContent.includes("Ola Uten Samtykke") && !mail.htmlContent.includes("ola@example.com") && !mail.htmlContent.includes("99887766"),
        "noconsent-06: none of the typed contact fields appear in the HTML body");
      const o = testDb.prepare("SELECT buyer_name, buyer_email, buyer_phone, delivery_note, contact_consent_at, confirm_token FROM orders WHERE id = ?").get(r.orderId) as any;
      assertTrue(!!o && o.buyer_name === null && o.buyer_email === null && o.buyer_phone === null && o.delivery_note === null && o.contact_consent_at === null,
        "noconsent-07: all five contact columns on the order are NULL (non-NULL ⇒ consent invariant)");
      const c = testDb.prepare("SELECT buyer_name, contact_consent_at FROM carts WHERE id = ?").get(r.cartId) as any;
      assertEq(c?.buyer_name, "Ola Uten Samtykke", "noconsent-08: the cart still stores the typed name (Slice 1 behaviour unchanged)");
      assertEq(c?.contact_consent_at, null, "noconsent-09: cart contact_consent_at stays NULL");
      const page = await req("GET", `/produsent/ordre/${o.confirm_token}`);
      assertEq(page.status, 200, "noconsent-10: producer PRG page renders");
      assertTrue(!page.text.includes("Kunde:") && !page.text.includes("Ola Uten Samtykke") && !page.text.includes("ola@example.com"),
        "noconsent-11: PRG page shows no buyer block and no contact fields");
    }

    // ════════════════════════════════════════════════════════════════════════
    // (m) skive 2 — ORDER_NOTIFY_EMAIL_VERSION=v1 pins the ORIGINAL template:
    //     no «Kunde» block and the default Reply-To even WITH consent (the
    //     order row still carries the consented copy — only the mail differs).
    // ════════════════════════════════════════════════════════════════════════
    {
      try {
        process.env.ORDER_NOTIFY_EMAIL_VERSION = "v1";
        assertEq(notifySvc.resolveOrderNotifyEmailVersion(), "v1", "v1-00: flag 'v1' selects v1 (read fresh per call, no restart)");
        sent.length = 0;
        const r = await submitCartFor("prod-optin", {
          buyer_name: "Kari Testkjøper",
          buyer_email: "kari@example.com",
          buyer_phone: "+47 91234567",
          contact_consent: true,
        });
        assertEq(r.orders.length, 1, "v1-01: order created under the v1 flag");
        await waitFor(() => sent.length >= 1);
        assertEq(sent.length, 1, "v1-02: exactly one notification sent");
        const mail = sent[0]!;
        assertEq(mail.replyTo, notifySvc.DEFAULT_ORDER_NOTIFY_REPLY_TO, "v1-03: v1 keeps the platform default Reply-To");
        assertTrue(!mail.textContent.includes("Kunde:") && !mail.htmlContent.includes("Kunde:"), "v1-04: v1 has no «Kunde» block");
        assertTrue(!mail.textContent.includes("Kari Testkjøper") && !mail.htmlContent.includes("kari@example.com"), "v1-05: v1 never includes buyer contact fields, consent or not");
        assertTrue(mail.textContent.includes("Egg") && /\/produsent\/ordre\/ctok_[a-f0-9]+/.test(mail.textContent), "v1-06: v1 is the original mail (items + confirm link)");
        const o = testDb.prepare("SELECT buyer_name FROM orders WHERE id = ?").get(r.orderId) as any;
        assertEq(o?.buyer_name, "Kari Testkjøper", "v1-07: the ORDER still carries the consented copy — only the template differs");
        process.env.ORDER_NOTIFY_EMAIL_VERSION = "v3";
        assertEq(notifySvc.resolveOrderNotifyEmailVersion(), "v2", "v1-08: any value other than 'v1' means v2 (fail-safe default)");
      } finally {
        delete process.env.ORDER_NOTIFY_EMAIL_VERSION;
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // (n) skive 2 — resolveReplyTo() header-injection guard, partial fields,
    //     and the render dispatcher (unit level, no DB).
    // ════════════════════════════════════════════════════════════════════════
    {
      const D = notifySvc.DEFAULT_ORDER_NOTIFY_REPLY_TO;
      assertEq(D, "kontakt@rettfrabonden.com", "replyto-00: the named default is the pre-skive-2 platform Reply-To");
      assertEq(notifySvc.resolveReplyTo("kari@example.com"), "kari@example.com", "replyto-01: plain address → used");
      assertEq(notifySvc.resolveReplyTo("  Kari.N@Example.com "), "Kari.N@Example.com", "replyto-02: trimmed, case preserved");
      assertEq(notifySvc.resolveReplyTo(null), D, "replyto-03: null → default");
      assertEq(notifySvc.resolveReplyTo(""), D, "replyto-04: empty → default");
      assertEq(notifySvc.resolveReplyTo("kari@example.com\r\nBcc: x@evil.example"), D, "replyto-05: CRLF header injection → default");
      assertEq(notifySvc.resolveReplyTo("Kari <kari@example.com>"), D, "replyto-06: display-name/angle-bracket form → default");
      assertEq(notifySvc.resolveReplyTo("kari@example.com, x@evil.example"), D, "replyto-07: multiple addresses → default");
      assertEq(notifySvc.resolveReplyTo("not-an-email"), D, "replyto-08: no @/TLD → default");
      assertEq(notifySvc.resolveReplyTo("a".repeat(250) + "@example.com"), D, "replyto-09: over 254 chars → default");

      const base = {
        order_id: "0123456789abcdef", agent_id: "ag-optin", producer_name: "Optin Gård",
        buyer_ref: "bref_unit_0000000000", confirm_token: "ctok_unit", pickup_time: null, total_nok: 120,
        items: [{ name: "Egg", qty: 2, unit: "brett" }],
      };
      const partial = notifySvc.renderOrderNotificationEmailV2({ ...base, buyer_phone: "+47 91234567" });
      assertTrue(partial.textContent.includes("Kunde:") && partial.textContent.includes("Telefon: +47 91234567"), "render-01: v2 with only a phone renders the block with the phone row");
      assertTrue(!partial.textContent.includes("Navn:") && !partial.textContent.includes("E-post:") && !partial.textContent.includes("Leveringsønske:"),
        "render-02: absent fields are omitted, never rendered as blank rows");
      assertEq(partial.replyTo, D, "render-03: no buyer e-mail → default Reply-To");
      const none = notifySvc.renderOrderNotificationEmailV2(base);
      const v1 = notifySvc.renderOrderNotificationEmailV1({ ...base, buyer_name: "Ignored", buyer_email: "ignored@example.com" });
      assertTrue(!none.textContent.includes("Kunde:"), "render-04: v2 with no buyer fields has no «Kunde» block");
      assertEq(none.textContent, v1.textContent, "render-05: v2 without buyer fields renders the identical text body to v1");
      assertEq(none.htmlContent, v1.htmlContent, "render-06: v2 without buyer fields renders the identical HTML body to v1");
      assertTrue(!v1.textContent.includes("Ignored") && !v1.htmlContent.includes("ignored@example.com"), "render-07: v1 ignores buyer fields entirely");
      assertEq(notifySvc.renderOrderNotificationEmail("v1", { ...base, buyer_email: "kari@example.com" }).replyTo, D, "render-08: dispatcher 'v1' → v1 (default Reply-To)");
      assertEq(notifySvc.renderOrderNotificationEmail("v2", { ...base, buyer_email: "kari@example.com" }).replyTo, "kari@example.com", "render-09: dispatcher 'v2' → v2 (buyer Reply-To)");
      const blankish = notifySvc.renderOrderNotificationEmailV2({ ...base, buyer_name: "   ", buyer_email: "", buyer_phone: null, delivery_note: undefined });
      assertTrue(!blankish.textContent.includes("Kunde:"), "render-10: whitespace-only/empty fields count as absent");
    }
  } catch (err) {
    failed++;
    failures.push(`pilot-ordre-loop: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    notifySvc.__setOrderNotifySendForTesting(null);
    cartSvc.__setCartTestDb(null);
    trustEvtSvc.__setTrustEventTestDb(null);
    notifySvc.__setOrderNotifyTestDb(null);
    adminOrdersMod.__setAdminOrdersTestDb(null);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevEmailVersion === undefined) delete process.env.ORDER_NOTIFY_EMAIL_VERSION; else process.env.ORDER_NOTIFY_EMAIL_VERSION = prevEmailVersion;
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { testDb.close(); } catch { /* best-effort */ }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/pilot-ordre-loop.test.ts`
if (require.main === module) {
  console.log("── pilot-ordre-loop (selgervarsling + livssyklus + trust-ledger) tests ──");
  runPilotOrdreLoopTests({ log: true }).then((r) => {
    console.log(`\npilot-ordre-loop: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
