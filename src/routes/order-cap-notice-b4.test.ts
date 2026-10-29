/**
 * order-cap-notice-b4.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-
 * start-til-slutt-for-eier, slice B4 (dagsgrense-varsel), AC5 and AC8.
 *
 * No network, no real e-mail, no production DB: a fresh in-memory SQLite with
 * the real production schema, the producer e-mail transport stubbed
 * (order-notify-service's send seam) and an injected clock for the digest.
 *
 *   ac5-*    submit #11, #12, #13 the same day → contact handoff + the buyer's
 *            cap text; exactly ONE aggregated producer e-mail for that day
 *            (N = 3), sent the next morning; never a second one.
 *   day-*    the next Oslo day counts on its own (reset); nothing before 07:00.
 *   safe-*   restart / overlapping runs: the order_cap_notices marker holds.
 *   open-*   the per-buyer open cap: buyer text, no producer digest.
 *   chan-*   the same text over REST (the web cart's endpoint), MCP
 *            (cartResultText) and the web cart copy.
 *   flag-*   ORDER_CAP_NOTICE_ENABLED off: no producer e-mail, the response
 *            unchanged (AC8).
 *   admin-*  GET /admin/orders/cap-stats: 401 without the key, counts with it.
 *   mail-*   the template (singular / plural, link to «Mine ordrer», no buyer data).
 *   («Mine valg» names the configured cap: owner-features-s2e.test.ts.)
 *
 * Standalone: npx tsx src/routes/order-cap-notice-b4.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderCapNoticeB4Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const trustSvc = require("../services/trust-event-service") as typeof import("../services/trust-event-service");
  const capSvc = require("../services/order-cap-notice") as typeof import("../services/order-cap-notice");
  const adminOrdersMod = require("../routes/admin-orders") as typeof import("../routes/admin-orders");

  const ENV_KEYS = [
    "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "ORDER_BUYER_RECEIPTS_ENABLED",
    "ORDER_CAP_OPEN_PENDING_PER_BUYER", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", "ORDER_CAP_NOTICE_ENABLED",
    "PAYMENTS_ENABLED", "ORDER_NOTIFY_EMAIL_VERSION",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const ADMIN_KEY = "b4-test-admin-key";
  const sent: Array<{ to: string; subject: string; textContent: string; htmlContent?: string }> = [];
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    capSvc.__setOrderCapNoticeTestDb(db as any);
    adminOrdersMod.__setAdminOrdersTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject, textContent: o.textContent || "", htmlContent: o.htmlContent });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async () => ({ success: true, messageId: "stub" }));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";
    process.env.ORDER_CAP_NEW_PER_PRODUCER_PER_DAY = "10";
    process.env.ORDER_CAP_NOTICE_ENABLED = "1";

    // ── Seed ────────────────────────────────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, ?)
    `);
    const insKnow = db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, ?)");
    const insProd = db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
      VALUES (?, ?, ?, ?, ?, ?, 'in_stock', ?, NULL, 'admin_producer_confirmed')
    `);
    const makeEligible = (id: string) => db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = ?").run(id);
    insAgent.run("ag-bonde", "Bonde Gård", "bonde@example.no", "k1", JSON.stringify(["vegetables"]));
    insKnow.run("ag-bonde", "bonde@example.no", "+47 400 22 222");
    makeEligible("ag-bonde");
    insProd.run("p-potet", "ag-bonde", "Poteter", "poteter", 30, "kg", "vegetables");
    insAgent.run("ag-eple", "Eple Gård", "eple@example.no", "k2", JSON.stringify(["fruit"]));
    insKnow.run("ag-eple", "eple@example.no", "+47 400 11 111");
    makeEligible("ag-eple");
    insProd.run("p-most", "ag-eple", "Eplemost", "eplemost", 45, "flaske", "beverages");

    const buyer = (i: number | string) => ({ buyer_name: "Kari", buyer_email: `kjoper${i}@example.com`, contact_consent: true });
    const cartWith = (pid: string): { cart_id: string; buyer_ref: string } => {
      const c = cartSvc.createCart();
      const r = cartSvc.addCartItem(c.cart_id, pid, 1);
      if (!r.success) throw new Error(`setup: add ${pid} failed: ${r.error}`);
      return c;
    };
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const capMails = () => sent.filter((m) => m.subject.includes("etter grensen din"));
    const today = capSvc.osloDay(new Date());
    const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const tomorrow = nextDay(today);
    const dayAfter = nextDay(tomorrow);
    // 09:00 or 10:00 Oslo time (CET / CEST) on the given day.
    const morningOf = (d: string) => new Date(`${d}T08:00:00Z`);
    const STANDARD_HANDOFF_KEYS = ["agent_id", "name", "phone", "email", "profile_url", "message"];

    // ════════════════════════════════════════════════════════════════════════
    // AC5 — #11, #12, #13 the same day
    // ════════════════════════════════════════════════════════════════════════
    const results: any[] = [];
    for (let i = 1; i <= 13; i++) results.push(cartSvc.submitCart(cartWith("p-potet").cart_id, buyer(i)));
    assertEq(results.map((r) => (r.success ? r.orders.length : -1)), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0], "ac5-01: the first 10 become orders, #11–#13 do not");
    const expectedText = capSvc.orderCapBuyerNotice("producer_daily_cap", 10, "no");
    for (const n of [11, 12, 13]) {
      const r = results[n - 1];
      const h = r.success ? r.contact_handoffs[0] : null;
      assertTrue(!!h && r.contact_handoffs.length === 1 && h.agent_id === "ag-bonde", `ac5-02: #${n} → a contact handoff for the producer`);
      assertEq([h?.cap_reached, h?.cap_reason, h?.cap, h?.cap_notice], [true, "producer_daily_cap", 10, expectedText], `ac5-03: #${n} → the buyer is told about the limit (cap_reached, reason, cap, text)`);
    }
    assertTrue(expectedText.includes("har nådd grensen på 10 bestillinger per døgn") && expectedText.includes("kontaktforespørsel"),
      "ac5-04: the buyer text names the limit and the contact request");
    assertTrue(results.slice(0, 10).every((r) => r.success && r.contact_handoffs.length === 0), "ac5-05: the orders under the cap carry no handoff");
    await settle();
    assertEq(sent.filter((m) => m.to === "bonde@example.no").length, 10, "ac5-06: during the day only the 10 order e-mails reach the producer");
    const evRows = db.prepare("SELECT reason, cap, oslo_day, cart_id FROM order_cap_events WHERE agent_id = 'ag-bonde' ORDER BY rowid").all() as any[];
    assertEq(evRows.map((r) => [r.reason, r.cap, r.oslo_day]), [["producer_daily_cap", 10, today], ["producer_daily_cap", 10, today], ["producer_daily_cap", 10, today]],
      "ac5-07: three over-cap events counted on today's Oslo day");
    const evCols = (db.prepare("PRAGMA table_info(order_cap_events)").all() as any[]).map((c) => c.name);
    assertTrue(!evCols.some((c) => /buyer|email|phone|name/.test(c)), "ac5-08: the event table holds no buyer data");

    // The same day: the digest job sends nothing for today.
    const sameDay = await capSvc.processOrderCapNotices({ now: new Date() });
    assertEq([sameDay.sent, capMails().length], [0, 0], "ac5-09: no digest during the day itself");

    // The next morning: exactly one digest with N = 3.
    const r1 = await capSvc.processOrderCapNotices({ now: morningOf(tomorrow) });
    assertEq([r1.day, r1.candidates, r1.sent], [today, 1, 1], "ac5-10: the next morning the job sends one digest for yesterday");
    assertEq(capMails().map((m) => m.to), ["bonde@example.no"], "ac5-11: exactly one aggregated e-mail to the producer");
    const mail = capMails()[0]!;
    assertTrue(mail.textContent.includes("3 bestillinger kom etter grensen din på 10 bestillinger per døgn i går") && mail.textContent.includes("ble sendt som kontaktforespørsel"),
      "ac5-12: the digest says N = 3, the cap 10 and «sendt som kontaktforespørsel»");
    assertTrue(mail.textContent.includes("Mine ordrer") && mail.textContent.includes("/eier/ag-bonde/ordrer") && (mail.htmlContent || "").includes("/eier/ag-bonde/ordrer\">"),
      "ac5-13: the digest links to «Mine ordrer»");
    assertTrue(!/kjoper\d+@example\.com|Kari/.test(mail.textContent + (mail.htmlContent || "")), "ac5-14: the digest carries no buyer data");

    // ════════════════════════════════════════════════════════════════════════
    // safe — restart and overlapping runs never send twice
    // ════════════════════════════════════════════════════════════════════════
    const r2 = await capSvc.processOrderCapNotices({ now: morningOf(tomorrow) });
    const r3 = await capSvc.processOrderCapNotices({ now: new Date(morningOf(tomorrow).getTime() + 10 * 3600_000) });
    assertEq([r2.sent, r3.sent, capMails().length], [0, 0, 1], "safe-01: later runs the same day (e.g. after a restart) send nothing more");
    const marker = db.prepare("SELECT over_cap_count, cap, status, sent_at FROM order_cap_notices WHERE agent_id = 'ag-bonde' AND oslo_day = ?").get(today) as any;
    assertEq([marker?.over_cap_count, marker?.cap, marker?.status, !!marker?.sent_at], [3, 10, "sent", true], "safe-02: the sent marker is stored (count 3, cap 10, sent)");
    // A late over-cap event for an already-digested day is not mailed again.
    capSvc.recordOrderCapEvent({ agent_id: "ag-bonde", cart_id: null, reason: "producer_daily_cap", cap: 10, now: new Date(`${today}T21:30:00Z`) });
    const r4 = await capSvc.processOrderCapNotices({ now: morningOf(tomorrow) });
    assertEq([r4.sent, capMails().length], [0, 1], "safe-03: a day already digested is never mailed a second time");
    // Overlapping runs (two instances) for a new day.
    capSvc.recordOrderCapEvent({ agent_id: "ag-eple", cart_id: null, reason: "producer_daily_cap", cap: 10, now: morningOf(tomorrow) });
    let slowSends = 0;
    const slow: import("../services/order-cap-notice").OrderCapNoticeSender = async () => { slowSends++; await settle(); return "sent"; };
    const [o1, o2] = await Promise.all([
      capSvc.processOrderCapNotices({ now: morningOf(dayAfter), send: slow }),
      capSvc.processOrderCapNotices({ now: morningOf(dayAfter), send: slow }),
    ]);
    assertEq([o1.sent + o2.sent, slowSends], [1, 1], "safe-04: two overlapping runs send one digest between them");

    // ════════════════════════════════════════════════════════════════════════
    // day — the next day counts on its own; nothing before 07:00 Oslo
    // ════════════════════════════════════════════════════════════════════════
    for (let i = 0; i < 2; i++) capSvc.recordOrderCapEvent({ agent_id: "ag-bonde", cart_id: null, reason: "producer_daily_cap", cap: 10, now: morningOf(tomorrow) });
    const night = await capSvc.processOrderCapNotices({ now: new Date(`${dayAfter}T03:00:00Z`) });
    assertEq([night.day, night.sent], [null, 0], "day-01: before 07:00 Oslo time nothing is sent");
    const before = capMails().length;
    const d2 = await capSvc.processOrderCapNotices({ now: morningOf(dayAfter) });
    assertEq([d2.day, d2.sent, capMails().length - before], [tomorrow, 1, 1], "day-02: the next day gets its own single digest");
    assertTrue(capMails()[capMails().length - 1]!.textContent.includes("2 bestillinger kom etter grensen"), "day-03: …counting only that day (N = 2): the count resets per day");
    const old = await capSvc.processOrderCapNotices({ now: morningOf(nextDay(nextDay(dayAfter))) });
    assertEq(old.candidates, 0, "day-04: only yesterday is looked at — no backlog of older days");

    // ════════════════════════════════════════════════════════════════════════
    // open — the per-buyer open cap: buyer text, no producer digest
    // ════════════════════════════════════════════════════════════════════════
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1";
    const first = cartSvc.submitCart(cartWith("p-most").cart_id, buyer("open"));
    const second = cartSvc.submitCart(cartWith("p-most").cart_id, buyer("open"));
    assertTrue(first.success && first.orders.length === 1, "open-01: setup: the first order from the address goes through");
    const oh = second.success ? second.contact_handoffs[0] : null;
    assertEq([second.success && second.orders.length, oh?.cap_reason, oh?.cap, oh?.cap_notice], [0, "buyer_open_cap", 1, capSvc.orderCapBuyerNotice("buyer_open_cap", 1, "no")],
      "open-02: the second open order from the same address → handoff + the open-cap text");
    assertTrue(String(oh?.cap_notice).includes("Du har allerede 1 ubesvarte bestillinger"), "open-03: the text names the buyer's open orders");
    capSvc.recordOrderCapEvent({ agent_id: "ag-eple", cart_id: null, reason: "buyer_open_cap", cap: 1, now: morningOf(dayAfter) });
    const openRun = await capSvc.processOrderCapNotices({ now: morningOf(nextDay(dayAfter)) });
    assertEq(openRun.candidates, 0, "open-04: the open-per-buyer cap gives no producer digest");
    process.env.ORDER_CAP_OPEN_PENDING_PER_BUYER = "1000";

    // ════════════════════════════════════════════════════════════════════════
    // chan — REST (the web cart's endpoint), MCP, web cart copy
    // ════════════════════════════════════════════════════════════════════════
    const express = require("express");
    const cartRoutes = require("../routes/marketplace-cart") as typeof import("../routes/marketplace-cart");
    const app = express();
    app.use(express.json());
    app.use("/api/marketplace", cartRoutes.cartRouter);
    app.use("/admin/orders", adminOrdersMod.default);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port as number;
    const req = (method: string, path: string, body?: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> =>
      new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const h: Record<string, string> = { ...headers };
        if (data !== undefined) { h["Content-Type"] = "application/json"; h["Content-Length"] = String(Buffer.byteLength(data)); }
        const r = http.request({ method, host: "127.0.0.1", port, path, headers: h }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: any = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
            resolve({ status: resp.statusCode || 0, body: parsed });
          });
        });
        r.on("error", reject);
        if (data !== undefined) r.write(data);
        r.end();
      });
    const restCart = cartWith("p-potet");
    const rest = await req("POST", `/api/marketplace/cart/${restCart.cart_id}/submit`, { ...buyer("rest") }, { "X-Cart-Token": restCart.buyer_ref });
    const rh = rest.body?.contact_handoffs?.[0];
    assertEq([rest.status, rest.body?.orders?.length, rh?.cap_reached, rh?.cap_reason, rh?.cap_notice], [201, 0, true, "producer_daily_cap", expectedText],
      "chan-01: REST submit (the web cart's endpoint) → handoff with the same cap text");
    const mcpMod = require("../routes/mcp") as typeof import("../routes/mcp");
    const mcpResult = cartSvc.submitCart(cartWith("p-potet").cart_id, buyer("mcp"));
    const mcpJson = JSON.parse(mcpMod.cartResultText("lokal_cart_submit", mcpResult));
    assertEq([mcpJson.contact_handoffs?.[0]?.cap_reached, mcpJson.contact_handoffs?.[0]?.cap_notice], [true, expectedText],
      "chan-02: MCP lokal_cart_submit's answer carries cap_reached and the same text");
    const hlMod = require("../routes/handleliste-page") as typeof import("../routes/handleliste-page");
    const pageNo = hlMod.buildHandelistePage("no").content;
    const pageEn = hlMod.buildHandelistePage("en").content;
    assertTrue(pageNo.includes(JSON.stringify(capSvc.orderCapBuyerNotice("producer_daily_cap", "{cap}", "no")).slice(1, 40)) && pageNo.includes('"__cap_open"'),
      "chan-03: the web cart's copy carries the same text (Norwegian), filled in with the response's cap");
    assertTrue(pageEn.includes("has reached the limit of {cap} orders per day"), "chan-04: the English web cart gets the English text");
    assertTrue(pageNo.includes("h.cap_reason === 'producer_daily_cap'"), "chan-05: the web cart renders the text on the handoff card");

    // ════════════════════════════════════════════════════════════════════════
    // admin — GET /admin/orders/cap-stats
    // ════════════════════════════════════════════════════════════════════════
    const noKey = await req("GET", "/admin/orders/cap-stats");
    assertEq(noKey.status, 401, "admin-01: without the admin key → 401");
    const stats = await req("GET", "/admin/orders/cap-stats?days=30", undefined, { "X-Admin-Key": ADMIN_KEY });
    const todayRow = (stats.body?.days || []).find((d: any) => d.agent_id === "ag-bonde" && d.oslo_day === today);
    // 3 (#11–#13) + 1 late event + REST + MCP = 6 over the daily cap today.
    assertEq([stats.status, stats.body?.notice_enabled, stats.body?.caps?.new_per_producer_per_day, todayRow?.producer_daily_cap, todayRow?.name, todayRow?.notice_status],
      [200, true, 10, 6, "Bonde Gård", "sent"], "admin-02: the count per producer per day, with the producer name and the digest status");
    assertTrue(!JSON.stringify(stats.body).includes("@example.com"), "admin-03: no buyer data in the admin answer");

    // ════════════════════════════════════════════════════════════════════════
    // flag — ORDER_CAP_NOTICE_ENABLED off (AC8)
    // ════════════════════════════════════════════════════════════════════════
    process.env.ORDER_CAP_NOTICE_ENABLED = "0";
    const off = cartSvc.submitCart(cartWith("p-potet").cart_id, buyer("off"));
    const offH = off.success ? off.contact_handoffs[0] : null;
    assertEq([off.success && off.orders.length, offH ? Object.keys(offH) : null], [0, STANDARD_HANDOFF_KEYS],
      "flag-01: off → the capped submit is a handoff with exactly today's fields (no cap text)");
    const offPage = hlMod.buildHandelistePage("no").content;
    assertTrue(!offPage.includes('"__cap_daily"') && !offPage.includes("bestillinger per døgn"), "flag-02: off → the web cart copy has no cap text");
    capSvc.recordOrderCapEvent({ agent_id: "ag-eple", cart_id: null, reason: "producer_daily_cap", cap: 10, now: morningOf(nextDay(dayAfter)) });
    const mailsBefore = sent.length;
    const offRun = await capSvc.processOrderCapNotices({ now: morningOf(nextDay(nextDay(dayAfter))) });
    assertEq([offRun.enabled, offRun.sent, sent.length - mailsBefore], [false, 0, 0], "flag-03: off → the job sends no producer e-mail");
    const claimed = (db.prepare("SELECT COUNT(*) AS n FROM order_cap_notices WHERE oslo_day = ?").get(nextDay(dayAfter)) as any).n;
    assertEq(claimed, 0, "flag-04: off → nothing is claimed either, so nothing is lost or marked");
    delete process.env.ORDER_CAP_NOTICE_ENABLED;
    assertEq(capSvc.isOrderCapNoticeEnabled(), false, "flag-05: the flag is off by default");
    process.env.ORDER_CAP_NOTICE_ENABLED = "1";

    // ════════════════════════════════════════════════════════════════════════
    // mail — the template
    // ════════════════════════════════════════════════════════════════════════
    const one = notifySvc.renderOrderCapNoticeEmail({ agent_id: "ag-x", count: 1, cap: 7, oslo_day: "2026-10-28" });
    assertTrue(one.textContent.includes("1 bestilling kom etter grensen din på 7 bestillinger per døgn i går (onsdag 28. oktober)"), "mail-01: singular, the cap and the Oslo day label");
    assertEq(one.subject, "1 bestilling kom etter grensen din i går", "mail-02: the subject");
    const esc = notifySvc.renderOrderCapNoticeEmail({ agent_id: "<x>", count: 2, cap: 10, oslo_day: "2026-10-28" });
    assertTrue(!esc.htmlContent.includes("<x>") && esc.htmlContent.includes("%3Cx%3E"), "mail-03: the agent id is encoded in the link");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    receiptSvc.__setBuyerReceiptSendForTesting(null);
    receiptSvc.__setBuyerReceiptTestDb(null);
    capSvc.__setOrderCapNoticeTestDb(null);
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
  console.log("── order-cap-notice-b4 tests ──");
  runOrderCapNoticeB4Tests({ log: true }).then((r) => {
    console.log(`\norder-cap-notice-b4: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
