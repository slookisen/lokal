/**
 * order-cap-v2.test.ts — dev-request 2026-10-30-rfb-eierportal-testrunde-1,
 * T11 (punkt 5, «grensen stopper misbruk per kunde»), acceptance criterion 7.
 *
 * No network, no real e-mail, no production DB: a fresh in-memory SQLite with
 * the real production schema, the e-mail transport stubbed (order-notify-
 * service's send seam, which also carries the admin alert).
 *
 *   off-*     ORDER_CAP_V2_ENABLED off: today's rule and output (producer-wide
 *             10/day, B4 fields, no reason_detail, owner text, web cart, admin).
 *   many-*    30 different buyers the same day → 30 orders.
 *   open-*    a buyer's 4th unanswered → buyer_open_cap, also for the variants
 *             « Ola+x@Example.no », «+47 900 00 000» vs «90000000», a new
 *             e-mail with the same phone.
 *   daily-*   the buyer's 11th new order the same day → buyer_daily_cap.
 *   ceil-*    the 51st order to one producer → contact handoff and exactly one
 *             internal admin alert (plus one pre-warning at 20); never a
 *             producer or buyer e-mail.
 *   day-*     the limits reset at Oslo midnight, also on 2026-10-25 and
 *             2027-03-28 (DST); a read error never blocks.
 *   ev-*      one order_cap_events row per hit with the right reason (CHECK
 *             unchanged) and reason_detail.
 *   text-*    the texts follow the configuration and promise «kunden får
 *             beskjed» only with buyer receipts on; buyer texts.
 *   admin-*   GET /admin/orders/cap-stats reads reason_detail.
 *   mcp-*     the MCP tool definitions are the same with the flag on.
 *
 * Standalone: npx tsx src/services/order-cap-v2.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderCapV2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const cartSvc = require("./cart-service") as typeof import("./cart-service");
  const notifySvc = require("./order-notify-service") as typeof import("./order-notify-service");
  const receiptSvc = require("./order-receipt-service") as typeof import("./order-receipt-service");
  const trustSvc = require("./trust-event-service") as typeof import("./trust-event-service");
  const capSvc = require("./order-cap-notice") as typeof import("./order-cap-notice");
  const texts = require("../owner-features/order-texts") as typeof import("../owner-features/order-texts");
  const adminOrdersMod = require("../routes/admin-orders") as typeof import("../routes/admin-orders");

  const ENV_KEYS = [
    "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "ORDER_BUYER_RECEIPTS_ENABLED",
    "ORDER_CAP_OPEN_PENDING_PER_BUYER", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", "ORDER_CAP_NOTICE_ENABLED",
    "ORDER_CAP_V2_ENABLED", "ORDER_CAP_NEW_PER_BUYER_PER_DAY", "ORDER_CAP_PRODUCER_CEILING_PER_DAY",
    "PAYMENTS_ENABLED", "ORDER_NOTIFY_EMAIL_VERSION",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const ADMIN_KEY = "t11-test-admin-key";
  const ADMIN_TO = "admin-alerts@example.org";
  const sent: Array<{ to: string; subject: string; textContent: string }> = [];
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
      sent.push({ to: o.to, subject: o.subject, textContent: o.textContent || "" });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async () => ({ success: true, messageId: "stub" }));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_TO;

    // ── Seed: one producer per scenario ─────────────────────────────────────
    const insAgent = db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, ?)
    `);
    const insKnow = db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, ?)");
    const insProd = db.prepare(`
      INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
      VALUES (?, ?, ?, ?, ?, ?, 'in_stock', ?, NULL, 'admin_producer_confirmed')
    `);
    const PRODUCERS = ["off", "many", "open", "phone", "daily"];
    PRODUCERS.forEach((p, i) => {
      insAgent.run(`ag-${p}`, `Gård ${p}`, `${p}@farm.example.no`, `k-${p}`, JSON.stringify(["vegetables"]));
      insKnow.run(`ag-${p}`, `${p}@farm.example.no`, `+47 400 00 0${i}0`);
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1, is_verified = 1 WHERE id = ?").run(`ag-${p}`);
      insProd.run(`p-${p}`, `ag-${p}`, "Poteter", "poteter", 30, "kg", "vegetables");
    });
    const cartWith = (pid: string): string => {
      const c = cartSvc.createCart();
      const r = cartSvc.addCartItem(c.cart_id, pid, 1);
      if (!r.success) throw new Error(`setup: add ${pid} failed: ${r.error}`);
      return c.cart_id;
    };
    const byEmail = (e: string) => ({ buyer_name: "Ola", buyer_email: e, contact_consent: true as const });
    const byPhone = (ph: string) => ({ buyer_name: "Ola", buyer_phone: ph, contact_consent: true as const });
    const submit = (p: string, contact: any) => cartSvc.submitCart(cartWith(`p-${p}`), contact);
    const handoff = (r: any) => (r.success && r.orders.length === 0 ? r.contact_handoffs[0] : null);
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const events = (agent: string) => db.prepare("SELECT reason, reason_detail, cap FROM order_cap_events WHERE agent_id = ? ORDER BY rowid").all(agent) as any[];
    const adminMails = () => sent.filter((m) => m.to === ADMIN_TO);
    const STANDARD_HANDOFF_KEYS = ["agent_id", "name", "phone", "email", "profile_url", "message"];

    // ════════════════════════════════════════════════════════════════════════
    // off — ORDER_CAP_V2_ENABLED off: today's rule, byte for byte
    // ════════════════════════════════════════════════════════════════════════
    assertEq(capSvc.isOrderCapV2Enabled(), false, "off-01: the flag is off by default");
    process.env.ORDER_CAP_NOTICE_ENABLED = "1";
    const offRes: any[] = [];
    for (let i = 1; i <= 11; i++) offRes.push(submit("off", byEmail(`off${i}@example.com`)));
    assertEq(offRes.map((r) => (r.success ? r.orders.length : -1)), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0], "off-02: off → the producer-wide 10/day cap still applies (11th distinct buyer is a handoff)");
    const offH = handoff(offRes[10]);
    assertEq([offH?.cap_reason, offH?.cap, offH?.cap_notice], ["producer_daily_cap", 10, capSvc.orderCapBuyerNotice("producer_daily_cap", 10, "no")],
      "off-03: off → the B4 reason, cap and text");
    assertEq(events("ag-off"), [{ reason: "producer_daily_cap", reason_detail: null, cap: 10 }], "off-04: off → the event row has no reason_detail");
    process.env.ORDER_CAP_NOTICE_ENABLED = "0";
    const offPlain = handoff(submit("off", byEmail("off12@example.com")));
    assertEq(offPlain ? Object.keys(offPlain) : null, STANDARD_HANDOFF_KEYS, "off-05: off (both flags) → the handoff has exactly today's fields");
    process.env.ORDER_CAP_NOTICE_ENABLED = "1";
    const hlMod = require("../routes/handleliste-page") as typeof import("../routes/handleliste-page");
    const hlOff = hlMod.buildHandelistePage("no").content;
    assertTrue(hlOff.includes(hlMod.HANDELISTE_CLIENT_SCRIPT) && !hlOff.includes("__cap_v2"), "off-06: off → the web cart serves today's script and copy");
    const pg = require("../owner-features/page") as typeof import("../owner-features/page");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const ownerPage = (orderTimings: any) => pg.renderOwnerFeaturesPageBody({
      agent: { id: "ag-off", name: "Gård off" }, resolved: rs.resolveOwnerFeatures("rfb", "ag-off", { db }), level: null, showIntro: false,
      notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 }, orderTimings,
    } as any);
    const explainOf = (html: string) => { const i = html.indexOf("<summary>Slik fungerer bestillinger</summary>"); return i < 0 ? "" : html.slice(i, html.indexOf("</details>", i)); };
    const LEGACY_EXPLAIN = `<summary>Slik fungerer bestillinger</summary>
            <h3>Slik fungerer det</h3>
            <ul>
              <li>Kunder og AI-assistenter kan sende deg en bestilling på varer du har merket som på lager.</li>
              <li>Du får en e-post med emnet «Ny henteordre» til adressen under «Bestillinger sendes til».</li>
              <li>I e-posten bekrefter eller avslår du bestillingen med ett klikk. Du trenger ikke logge inn.</li>
              <li>Kunden henter varene hos deg og betaler når varene hentes. Rett fra Bonden tar ikke betalt.</li>
              <li data-order-cap="10">Du kan få inntil 10 bestillinger per døgn. Kommer det flere, blir de gjort om til en kontaktforespørsel: kunden får kontaktinformasjonen din i stedet.</li>
            </ul>
            <h3>Dette må du gjøre</h3>
            <ul>
              <li>Svar på hver bestilling: bekreft eller avslå.</li>
              <li>Svarer du ikke, får du en påminnelse etter 24 timer.</li>
              <li>Er bestillingen fortsatt ubesvart etter 72 timer, blir den kansellert, og kunden får beskjed.</li>
              <li>Hold varene oppdatert, så kunden bare kan bestille det du har.</li>
            </ul>
            <h3>Slik slår du av</h3>
            <ul>
              <li>Trykk «Slå av» på denne raden. Da får kunden kontaktinformasjonen din i stedet.</li>
              <li>Bestillinger du allerede har fått, må du fortsatt svare på.</li>
            </ul>
${"            "}
          `;
    const legacyHtml = ownerPage({ reminderHours: 24, autocancelHours: 72, dailyCap: 10, capNotice: false });
    assertEq(explainOf(legacyHtml), LEGACY_EXPLAIN, "off-07: off (no limits passed) → «Slik fungerer bestillinger» is byte-identical to B4");

    // ════════════════════════════════════════════════════════════════════════
    // Flag on from here.
    // ════════════════════════════════════════════════════════════════════════
    process.env.ORDER_CAP_V2_ENABLED = "1";
    assertEq([cartSvc.orderCapOpenPerBuyer(), cartSvc.orderCapNewPerBuyerPerDay(), cartSvc.orderCapProducerCeilingPerDay()], [3, 10, 50],
      "on-01: defaults 3 open / 10 per buyer per day / ceiling 50");

    // many — 30 different buyers the same day → 30 orders
    const manyRes: any[] = [];
    for (let i = 1; i <= 30; i++) manyRes.push(submit("many", byEmail(`kunde${i}@example.com`)));
    assertEq(manyRes.filter((r) => r.success && r.orders.length === 1).length, 30, "many-01: 30 different buyers the same day → 30 orders (no producer-wide 10/day)");
    assertEq(events("ag-many").length, 0, "many-02: no cap event for them");
    await settle();
    const prewarn = adminMails().filter((m) => m.subject.startsWith("Førvarsel bestillingstak"));
    assertEq(prewarn.length, 1, "many-03: exactly one pre-warning to the admin when the producer reaches 20 today");
    assertTrue(!!prewarn[0] && prewarn[0].subject.includes("Gård many") && prewarn[0].textContent.includes("20 nye bestillinger i dag"), "many-04: the pre-warning names the producer and the count 20");

    // open — the 4th unanswered from one buyer, with variants
    for (let i = 0; i < 3; i++) assertEq(submit("open", byEmail("ola@example.no")).orders?.length, 1, `open-0${i + 1}: setup: open order ${i + 1} from ola@example.no`);
    const o4 = handoff(submit("open", byEmail(" Ola+x@Example.no ")));
    assertEq([o4?.cap_reached, o4?.cap_reason, o4?.cap, o4?.cap_notice], [true, "buyer_open_cap", 3, texts.buyerOrderCapNotice("buyer_open_cap", 3, "no")],
      "open-04: « Ola+x@Example.no » (spaces, case, +tag) → the same buyer → buyer_open_cap with the buyer text");
    assertTrue(String(o4?.cap_notice).startsWith("Du har allerede 3 ubesvarte bestillinger hos denne produsenten"), "open-05: the text names the 3 unanswered orders");
    for (let i = 0; i < 3; i++) submit("phone", { ...byPhone("+47 900 00 000"), buyer_email: `p${i}@example.com` });
    const p4 = handoff(submit("phone", byPhone("90000000")));
    assertEq(p4?.cap_reason, "buyer_open_cap", "open-06: «+47 900 00 000» vs «90000000» → the same buyer → buyer_open_cap");
    const p5 = handoff(submit("phone", { ...byPhone("0047 90000000"), buyer_email: "helt-ny@example.com" }));
    assertEq(p5?.cap_reason, "buyer_open_cap", "open-07: a new e-mail with the same phone (0047…) → still the same buyer");
    const other = submit("phone", byPhone("+47 911 11 111"));
    assertEq(other.success && other.orders.length, 1, "open-08: another phone → an order");
    // Answering one order frees a slot.
    db.prepare("UPDATE orders SET status = 'confirmed' WHERE id = (SELECT id FROM orders WHERE agent_id = 'ag-open' ORDER BY rowid LIMIT 1)").run();
    assertEq(submit("open", byEmail("OLA@example.no")).orders?.length, 1, "open-09: after the producer answered one, the buyer can send one more");

    // daily — the 11th new the same day from one buyer
    const dailyRes: any[] = [];
    for (let i = 1; i <= 11; i++) {
      dailyRes.push(submit("daily", byEmail("kari@example.no")));
      db.prepare("UPDATE orders SET status = 'confirmed' WHERE agent_id = 'ag-daily'").run(); // answered → no open cap
    }
    assertEq(dailyRes.map((r) => (r.success ? r.orders.length : -1)), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0], "daily-01: the buyer's first 10 the same day are orders, the 11th is not");
    const d11 = handoff(dailyRes[10]);
    assertEq([d11?.cap_reason, d11?.cap, d11?.cap_notice], ["buyer_daily_cap", 10, texts.buyerOrderCapNotice("buyer_daily_cap", 10, "no")], "daily-02: the 11th → buyer_daily_cap with the buyer text");
    assertTrue(String(d11?.cap_notice).startsWith("Du har sendt 10 bestillinger til denne produsenten i dag"), "daily-03: the text names the 10 today");
    assertEq(submit("daily", byEmail("noen-andre@example.no")).orders?.length, 1, "daily-04: another buyer the same day still gets an order");

    // ceil — the 51st to one producer
    const ceilRes: any[] = [];
    for (let i = 31; i <= 52; i++) ceilRes.push(submit("many", byEmail(`kunde${i}@example.com`)));
    assertEq(ceilRes.map((r) => (r.success ? r.orders.length : -1)).join(""), "1".repeat(20) + "00", "ceil-01: orders 31–50 go through, the 51st and 52nd do not");
    const c51 = handoff(ceilRes[20]);
    assertEq([c51?.agent_id, c51?.cap_reason, c51?.cap, c51?.cap_notice], ["ag-many", "platform_ceiling", 50, texts.buyerOrderCapNotice("platform_ceiling", 50, "no")],
      "ceil-02: the 51st → contact handoff, platform_ceiling, the «dagen full» text");
    assertTrue(!!c51?.phone || !!c51?.email, "ceil-03: the handoff carries the producer's contact details");
    await settle();
    const ceilMails = adminMails().filter((m) => m.subject.startsWith("Bestillingstaket nådd"));
    assertEq(ceilMails.length, 1, "ceil-04: exactly one internal admin alert at the ceiling (51st and 52nd)");
    assertEq(adminMails().length, 2, "ceil-05: the admin got two internal mails in all (pre-warning + ceiling)");
    assertEq(sent.filter((m) => m.to === "many@farm.example.no").length, 50, "ceil-06: the producer got only its 50 order e-mails (no alert)");
    assertTrue(!sent.some((m) => /kunde\d+@example\.com/.test(m.to)), "ceil-07: no buyer e-mail from the caps");
    const alertRows = db.prepare("SELECT kind, order_count, cap, status FROM order_cap_admin_alerts WHERE agent_id = 'ag-many' ORDER BY kind").all();
    assertEq(alertRows, [{ kind: "ceiling", order_count: 50, cap: 50, status: "sent" }, { kind: "prewarn", order_count: 20, cap: 50, status: "sent" }],
      "ceil-08: the durable alert markers (one per kind for the day)");
    assertTrue(!capSvc.claimOrderCapAdminAlert({ agent_id: "ag-many", kind: "ceiling", count: 50, cap: 50 }), "ceil-09: a later claim (restart, another instance) does not alert again");
    const alertCols = (db.prepare("PRAGMA table_info(order_cap_admin_alerts)").all() as any[]).map((c) => c.name);
    assertTrue(!alertCols.some((c) => /buyer|email|phone/.test(c)), "ceil-10: the alert table holds no buyer data");

    // ev — one event row per hit with the right reason/detail (CHECK unchanged)
    assertEq(events("ag-open"), [{ reason: "buyer_open_cap", reason_detail: "buyer_open_cap", cap: 3 }], "ev-01: open cap → reason buyer_open_cap, detail buyer_open_cap");
    assertEq(events("ag-phone"), [{ reason: "buyer_open_cap", reason_detail: "buyer_open_cap", cap: 3 }, { reason: "buyer_open_cap", reason_detail: "buyer_open_cap", cap: 3 }],
      "ev-02: the two phone hits → two rows");
    assertEq(events("ag-daily"), [{ reason: "buyer_open_cap", reason_detail: "buyer_daily_cap", cap: 10 }], "ev-03: per-buyer per-day → reason buyer_open_cap, detail buyer_daily_cap");
    assertEq(events("ag-many"), [{ reason: "producer_daily_cap", reason_detail: "platform_ceiling", cap: 50 }, { reason: "producer_daily_cap", reason_detail: "platform_ceiling", cap: 50 }],
      "ev-04: the ceiling → reason producer_daily_cap, detail platform_ceiling (one row per hit)");
    const ddl = String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'order_cap_events'").get() as any)?.sql);
    assertTrue(ddl.includes("CHECK(reason IN ('producer_daily_cap','buyer_open_cap'))") && /reason_detail TEXT/.test(ddl), "ev-05: the CHECK is not widened; reason_detail is an added nullable column");
    initMod.__initSchemaForTesting(db as any);
    assertTrue(((db.prepare("PRAGMA table_info(order_cap_events)").all() as any[]).filter((c) => c.name === "reason_detail").length) === 1, "ev-06: the migration is idempotent");

    // ════════════════════════════════════════════════════════════════════════
    // day — Oslo midnight, DST days, read errors
    // ════════════════════════════════════════════════════════════════════════
    assertEq([capSvc.osloDayStartUtc(new Date("2026-10-24T23:30:00Z")), capSvc.osloDayStartUtc(new Date("2026-10-25T22:59:00Z")), capSvc.osloDayStartUtc(new Date("2026-10-25T23:00:00Z"))],
      ["2026-10-24 22:00:00", "2026-10-24 22:00:00", "2026-10-25 23:00:00"], "day-01: 2026-10-25 (25 hours) starts 22:00 UTC, the next day 23:00 UTC");
    assertEq([capSvc.osloDayStartUtc(new Date("2027-03-28T00:30:00Z")), capSvc.osloDayStartUtc(new Date("2027-03-28T21:59:00Z")), capSvc.osloDayStartUtc(new Date("2027-03-28T22:00:00Z"))],
      ["2027-03-27 23:00:00", "2027-03-27 23:00:00", "2027-03-28 22:00:00"], "day-02: 2027-03-28 (23 hours) starts 23:00 UTC, the next day 22:00 UTC");
    insAgent.run("ag-dst", "Gård dst", "dst@farm.example.no", "k-dst", "[]");
    const insOrder = db.prepare("INSERT INTO orders (id, agent_id, buyer_ref, status, created_at, buyer_email, buyer_phone) VALUES (?, 'ag-dst', 'r', ?, ?, ?, ?)");
    let oid = 0;
    const seed = (at: string, email: string, status = "confirmed") => insOrder.run(`o-dst-${++oid}`, status, at, email, null);
    const probe = (iso: string, email = "probe@example.no") => cartSvc.orderCapReachedV2(db, "ag-dst", byEmail(email), new Date(iso));
    process.env.ORDER_CAP_PRODUCER_CEILING_PER_DAY = "2";
    process.env.ORDER_CAP_NEW_PER_BUYER_PER_DAY = "1";
    for (const [label, lastOfDay, beforeMid, afterMid] of [
      ["2026-10-25", "2026-10-25 22:30:00", "2026-10-25T22:59:30Z", "2026-10-25T23:00:30Z"],
      ["2027-03-28", "2027-03-28 21:30:00", "2027-03-28T21:59:30Z", "2027-03-28T22:00:30Z"],
      ["2026-10-24→25", "2026-10-24 21:30:00", "2026-10-24T21:59:30Z", "2026-10-24T22:00:30Z"],
    ] as const) {
      db.prepare("DELETE FROM orders WHERE agent_id = 'ag-dst'").run();
      seed(lastOfDay, "a@example.no", "declined");
      seed(lastOfDay, "b@example.no", "completed");
      assertEq(probe(beforeMid)?.detail, "platform_ceiling", `day-03 ${label}: just before Oslo midnight the ceiling (all statuses) is reached`);
      assertEq(probe(afterMid), null, `day-04 ${label}: just after Oslo midnight it is reset`);
      db.prepare("DELETE FROM orders WHERE agent_id = 'ag-dst'").run();
      seed(lastOfDay, "probe+tag@example.no");
      assertEq(probe(beforeMid)?.detail, "buyer_daily_cap", `day-05 ${label}: the buyer's per-day limit holds until Oslo midnight`);
      assertEq(probe(afterMid), null, `day-06 ${label}: and resets after it`);
    }
    // The early hours of 2026-10-25 (00:30 Oslo = 22:30 UTC the day before) belong to the 25th.
    db.prepare("DELETE FROM orders WHERE agent_id = 'ag-dst'").run();
    seed("2026-10-24 22:30:00", "a@example.no");
    seed("2026-10-24 22:40:00", "b@example.no");
    assertEq(probe("2026-10-25T22:59:00Z")?.detail, "platform_ceiling", "day-07: 00:30 Oslo on 2026-10-25 counts on the 25th until its (25-hour) end");
    process.env.ORDER_CAP_PRODUCER_CEILING_PER_DAY = "";
    process.env.ORDER_CAP_NEW_PER_BUYER_PER_DAY = "";
    const brokenDb = { prepare: () => { throw new Error("disk I/O error"); } };
    assertEq(cartSvc.orderCapReachedV2(brokenDb, "ag-dst", byEmail("x@example.no")), null, "day-08: a read error never blocks the buyer");
    assertEq([cartSvc.normalizeBuyerEmailForCap(" Ola+x@Example.no "), cartSvc.normalizeBuyerPhoneForCap("+47 900 00 000"), cartSvc.normalizeBuyerPhoneForCap("0047 900 00 000"),
      cartSvc.normalizeBuyerPhoneForCap("4790000000"), cartSvc.normalizeBuyerPhoneForCap("900 00 000")], ["ola@example.no", "90000000", "90000000", "90000000", "90000000"],
      "day-09: normalisation of e-mail and phone");

    // ════════════════════════════════════════════════════════════════════════
    // text — owner texts follow the configuration; «kunden får beskjed» only with receipts
    // ════════════════════════════════════════════════════════════════════════
    const cfgA = { openPerBuyer: 3, perBuyerPerDay: 10, producerCeilingPerDay: 50 };
    assertEq(texts.ownerOrderLimitLines(cfgA), [
      "Mange ulike kunder kan bestille fra deg samme dag.",
      "For å stoppe misbruk kan én kunde ha høyst 3 ubesvarte bestillinger hos deg om gangen, og sende deg høyst 10 nye bestillinger per dag.",
      "Får du flere enn 50 bestillinger på én dag, tar vi ikke imot flere til deg resten av dagen. Kundene får da kontaktinformasjonen din i stedet.",
      "En dag regnes fra midnatt til midnatt.",
    ], "text-01: the limit sentences with the default numbers");
    const v2Off = explainOf(ownerPage({ reminderHours: 24, autocancelHours: 72, dailyCap: 10, capNotice: true, limits: { openPerBuyer: 2, perBuyerPerDay: 5, producerCeilingPerDay: 40 }, buyerReceipts: false }));
    assertTrue(v2Off.includes("<h3>Hvor mange bestillinger kan du få?</h3>") && v2Off.includes("høyst 2 ubesvarte") && v2Off.includes("høyst 5 nye bestillinger per dag")
      && v2Off.includes("flere enn 40 bestillinger på én dag") && v2Off.includes("En dag regnes fra midnatt til midnatt."), "text-02: the owner page uses the configured numbers (2/5/40)");
    assertTrue(!v2Off.includes("døgn") && !v2Off.includes("data-order-cap=") && !v2Off.includes("inntil 10"), "text-03: no «døgn» and no producer-wide 10/day line");
    assertTrue(v2Off.includes("<li>Er bestillingen fortsatt ubesvart etter 72 timer, blir den kansellert.</li>") && !v2Off.includes("kunden får beskjed"),
      "text-04: receipts off → no promise that the buyer is told");
    const v2On = explainOf(ownerPage({ reminderHours: 24, autocancelHours: 48, limits: cfgA, buyerReceipts: true }));
    assertTrue(v2On.includes("<li>Er bestillingen fortsatt ubesvart etter 48 timer, blir den kansellert, og kunden får beskjed.</li>"), "text-05: receipts on → «, og kunden får beskjed»");
    assertEq([texts.ownerAutocancelLine(72, false), texts.ownerAutocancelLine(72, true)],
      ["Er bestillingen fortsatt ubesvart etter 72 timer, blir den kansellert.", "Er bestillingen fortsatt ubesvart etter 72 timer, blir den kansellert, og kunden får beskjed."],
      "text-06: the auto-cancel sentence");
    assertTrue(texts.buyerOrderCapNotice("platform_ceiling", 50) === "Produsenten tar ikke imot flere bestillinger gjennom Rett fra Bonden i dag, så bestillingen ble ikke sendt. Ta kontakt med produsenten direkte med kontaktinformasjonen og meldingen under, eller prøv igjen i morgen.",
      "text-07: the «dagen full» buyer text verbatim");
    assertTrue(texts.buyerOrderCapNotice("buyer_daily_cap", 10, "en").includes("per day") && !/24 hours|døgn/.test(texts.buyerOrderCapNotice("buyer_daily_cap", 10, "en")), "text-08: English says «per day»");
    // Route config: the env is what the texts read.
    process.env.ORDER_CAP_NEW_PER_BUYER_PER_DAY = "7";
    process.env.ORDER_CAP_PRODUCER_CEILING_PER_DAY = "30";
    assertEq([cartSvc.orderCapNewPerBuyerPerDay(), cartSvc.orderCapProducerCeilingPerDay()], [7, 30], "text-09: the numbers come from ORDER_CAP_NEW_PER_BUYER_PER_DAY / ORDER_CAP_PRODUCER_CEILING_PER_DAY");
    delete process.env.ORDER_CAP_NEW_PER_BUYER_PER_DAY;
    delete process.env.ORDER_CAP_PRODUCER_CEILING_PER_DAY;
    // Buyer text only behind ORDER_CAP_NOTICE_ENABLED.
    process.env.ORDER_CAP_NOTICE_ENABLED = "0";
    const quiet = handoff(submit("open", byEmail("ola@example.no")));
    assertEq(quiet ? Object.keys(quiet) : null, STANDARD_HANDOFF_KEYS, "text-10: v2 on, notice off → the handoff has exactly today's fields (no buyer text)");
    process.env.ORDER_CAP_NOTICE_ENABLED = "1";
    const hlOn = hlMod.buildHandelistePage("no").content;
    assertTrue(hlOn.includes("__cap_v2") && hlOn.includes("C.__cap_v2[h.cap_reason]") && hlOn.includes("Du har sendt {cap} bestillinger til denne produsenten i dag"),
      "text-11: the web cart knows the v2 reasons and texts");
    assertTrue(hlMod.buildHandelistePage("en").content.includes("the limit per day"), "text-12: the English web cart gets the English v2 text");

    // ════════════════════════════════════════════════════════════════════════
    // admin — GET /admin/orders/cap-stats reads reason_detail
    // ════════════════════════════════════════════════════════════════════════
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/admin/orders", adminOrdersMod.default);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as any).port as number;
    const getJson = (path: string): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path, headers: { "X-Admin-Key": ADMIN_KEY } }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c) => chunks.push(c as Buffer));
        resp.on("end", () => { let b: any = null; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ } resolve({ status: resp.statusCode || 0, body: b }); });
      }).on("error", reject);
    });
    const today = capSvc.osloDay(new Date());
    const st = await getJson("/admin/orders/cap-stats");
    const rowOf = (a: string) => (st.body?.days || []).find((d: any) => d.agent_id === a && d.oslo_day === today);
    assertEq([st.status, st.body?.caps?.v2_enabled, st.body?.caps?.producer_ceiling_per_day, st.body?.caps?.new_per_buyer_per_day], [200, true, 50, 10], "admin-01: v2 on → the v2 limits");
    assertEq([rowOf("ag-many")?.platform_ceiling, !!rowOf("ag-many")?.ceiling_alert_at, !!rowOf("ag-many")?.prewarn_alert_at, rowOf("ag-daily")?.buyer_daily_cap, rowOf("ag-open")?.buyer_open_cap_v2],
      [2, true, true, 1, 2], "admin-02: per producer per day the reason_detail counts and the admin alerts");
    assertTrue(st.body?.total_platform_ceiling === 2 && !JSON.stringify(st.body).includes("@example."), "admin-03: totals, and no buyer data");
    process.env.ORDER_CAP_V2_ENABLED = "0";
    const stOff = await getJson("/admin/orders/cap-stats");
    assertEq([Object.keys(stOff.body?.caps || {}), Object.keys((stOff.body?.days || [])[0] || {})],
      [["new_per_producer_per_day", "open_pending_per_buyer"], ["oslo_day", "agent_id", "name", "producer_daily_cap", "buyer_open_cap", "cap", "notice_status", "notice_sent_at"]],
      "admin-04: v2 off → the answer has exactly today's fields");
    assertTrue(!("total_platform_ceiling" in (stOff.body || {})), "admin-05: v2 off → no v2 totals");

    // ════════════════════════════════════════════════════════════════════════
    // mcp — tool definitions unchanged by the flag
    // ════════════════════════════════════════════════════════════════════════
    const manifest = require("./mcp-tool-manifest") as typeof import("./mcp-tool-manifest");
    const defsOff = JSON.stringify(manifest.registeredMcpToolDefinitions("rfb"));
    process.env.ORDER_CAP_V2_ENABLED = "1";
    const defsOn = JSON.stringify(manifest.registeredMcpToolDefinitions("rfb"));
    assertTrue(defsOff.length > 100 && defsOff === defsOn, "mcp-01: the MCP tool definitions are identical with the flag on and off");
    assertTrue(!/platform_ceiling|buyer_daily_cap|reason_detail/.test(defsOn), "mcp-02: no tool description names the new values (output fields are additive only)");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 20));
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
  console.log("── order-cap-v2 tests ──");
  runOrderCapV2Tests({ log: true }).then((r) => {
    console.log(`\norder-cap-v2: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
