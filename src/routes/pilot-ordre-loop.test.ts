/**
 * pilot-ordre-loop.test.ts — integration/unit tests for dev-request
 * 2026-07-13-pilot-ordre-loop: seller notification (gated), order
 * lifecycle transitions + timeline, producer PRG confirm page,
 * trust-ledger events, admin opt-in + inbox endpoints.
 *
 * Covers:
 *   (a) Opt-in gate NEGATIVE (integration): a default agent (opt_in=0)
 *       receives NO email on cart submit — the never-send default.
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

  const testDb = new Database(":memory:");
  const ADMIN_KEY = "pilot-ordre-loop-test-key";
  const DANIEL_EMAIL = "da.fredriksen@gmail.com";

  // Captured notification sends (stubbed transport).
  const sent: Array<{ to: string; subject: string; htmlContent: string; textContent: string }> = [];

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
      sent.push({ to: o.to, subject: o.subject, htmlContent: o.htmlContent, textContent: o.textContent });
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
    // dev-request 2026-07-23-supplygraph: in_stock rows also need a FRESH
    // availability_updated_at, or effectiveAvailability() degrades them to
    // 'unknown' (never-confirmed) and cart-service's now-hardened checks
    // reject them — mirrors the pid-agent fixture fix in tests/test.ts
    // (see git show f3accba -- tests/test.ts).
    const insertProduct = testDb.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'in_stock', datetime('now'))
    `);

    // Verified producer WITHOUT opt-in (the platform default) — negative case.
    insertAgent.run("ag-optout", "Optout Gård", "optout@example.no", "key-optout");
    insertKnowledge.run("ag-optout", "verified");
    insertProduct.run("prod-optout", "ag-optout", "Poteter", "poteter", 40, "kg");

    // Verified producer WITH opt-in — the happy send path.
    insertAgent.run("ag-optin", "Optin Gård", "optin@example.no", "key-optin");
    insertKnowledge.run("ag-optin", "verified");
    testDb.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'ag-optin'").run();
    insertProduct.run("prod-optin", "ag-optin", "Egg", "egg", 60, "brett");

    // Daniel's test agent: verified (so it's orderable) — the admin endpoint
    // will point its notifications at Daniel's own inbox.
    insertAgent.run("ag-daniel", "Daniels Testgård", "gard@example.no", "key-daniel");
    insertKnowledge.run("ag-daniel", "verified");
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

    async function submitCartFor(productId: string): Promise<{ orderId: string; buyerRef: string }> {
      const c = await req("POST", "/api/marketplace/cart");
      const cartId = c.body.cart_id as string;
      const buyerRef = c.body.buyer_ref as string;
      await req("POST", `/api/marketplace/cart/${cartId}/items`, {
        body: { product_id: productId, qty: 2, buyer_ref: buyerRef },
      });
      const s = await req("POST", `/api/marketplace/cart/${cartId}/submit`, {
        body: { buyer_ref: buyerRef },
      });
      const orderId = s.body?.orders?.[0]?.order_id as string;
      return { orderId, buyerRef };
    }

    // ════════════════════════════════════════════════════════════════════════
    // (a) Opt-in gate NEGATIVE: default agent gets NO notification. Ever.
    // ════════════════════════════════════════════════════════════════════════
    {
      sent.length = 0;
      const { orderId } = await submitCartFor("prod-optout");
      assertTrue(!!orderId, "optin-neg-01: submit against non-opted-in producer still creates the order");
      // Give the fire-and-forget path ample time to (wrongly) send.
      await new Promise((r) => setTimeout(r, 150));
      assertEq(sent.length, 0, "optin-neg-02: NO email sent to a producer with default opt_in=0 (the never-send default)");
      const row = testDb.prepare("SELECT confirm_token FROM orders WHERE id = ?").get(orderId) as any;
      assertTrue(typeof row?.confirm_token === "string" && row.confirm_token.startsWith("ctok_"),
        "optin-neg-03: confirm_token is generated at order creation even when no notification goes out");
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
      await submitCartFor("prod-daniel");
      await new Promise((r) => setTimeout(r, 150));
      assertEq(sent.length, 0, "optin-admin-12: after opt-out no email is sent again");
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
