/**
 * order-actions-fase-a1.test.ts — dev-request 2026-10-21-rfb-mine-ordrer-ett-
 * klikk-og-kjoperagent, FASE A1 (shared order-action layer + one-click
 * lifecycle). No network, no real e-mail, no production DB: a fresh in-memory
 * SQLite with the real production schema, e-mail transports stubbed, a fake
 * clock for the automatic close.
 *
 *   AC1  after «Bekreft» nothing more is needed: with ORDER_AUTOCOMPLETE_ENABLED
 *        the follow-ups job closes the order (completion_source 'auto') at
 *        pickup_time + grace / confirmed_at + default days; switch off (and
 *        RFB_DISABLE_ORDER_FOLLOWUPS=1) → no close; prepay → no payment events;
 *        completed_auto counted apart in trust + pilot-status.
 *   AC2  no_show / buyer_cancelled / cannot_deliver work until the close and
 *        send the buyer a receipt; a buyer/seller conflict → admin alert, no
 *        status change.
 *   AC5  every order_events row has actor_role + channel; the same
 *        idempotency key twice → one transition (service, admin route, page).
 *
 * Standalone: npx tsx src/routes/order-actions-fase-a1.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderActionsFaseA1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const actionsSvc = require("../services/order-actions") as typeof import("../services/order-actions");
  const lifecycle = require("../services/order-lifecycle") as typeof import("../services/order-lifecycle");
  const adminOrdersMod = require("../routes/admin-orders") as typeof import("../routes/admin-orders");

  const ENV_KEYS = [
    "ADMIN_KEY", "ADMIN_NOTIFICATION_EMAIL", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED",
    "ORDER_AUTOCOMPLETE_GRACE_HOURS", "ORDER_AUTOCOMPLETE_DEFAULT_DAYS", "RFB_DISABLE_ORDER_FOLLOWUPS",
    "PAYMENTS_ENABLED", "ORDER_REMINDER_HOURS", "ORDER_AUTOCANCEL_HOURS", "ORDER_AUTOCOMPLETE_SINCE", "ORDER_NO_SHOW_MIN_HOURS",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const ADMIN_KEY = "a1-test-admin-key";
  const ADMIN_MAIL = "admin-varsel-a1@example.test";
  const BUYER_MAIL = "kari.a1@example.com";

  const adminSent: Array<{ to: string; subject: string; textContent: string }> = [];
  const receipts: Array<{ to: string; subject: string; textContent: string }> = [];
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
    actionsSvc.__setOrderActionsTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      adminSent.push({ to: o.to, subject: o.subject, textContent: o.textContent });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async (o) => {
      receipts.push({ to: o.to, subject: o.subject, textContent: o.textContent });
      return { success: true, messageId: "stub" };
    });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ADMIN_NOTIFICATION_EMAIL = ADMIN_MAIL;
    process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";

    // ── Seed ────────────────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
      VALUES ('ag-a1', 'Fase A1 Gård', 'Testprodusent', 'self', 'gard-a1@example.no', 'https://example.no', 'producer', 'k-a1', '["vegetables"]')
    `).run();
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES ('ag-a1', 'verified', 'gard-a1@example.no', '+47 400 33 333')").run();

    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    let seq = 0;
    /** An order in the given status; for confirmed/ready an order_events row into 'confirmed' at confirmedAt. */
    function seedOrder(o: {
      status: string; pickup?: string | null; confirmedAt?: Date; paymentMode?: string | null; notifySent?: boolean;
      cancelReason?: string | null; completionSource?: string | null; updatedAt?: Date;
    }): string {
      const id = `a1-order-${++seq}`;
      const created = SQL(new Date(Date.now() - 5 * 86_400_000));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                            notify_sent_at, cancel_reason, completion_source, buyer_email, contact_consent_at, created_at, updated_at)
        VALUES (?, 'ag-a1', ?, ?, 'pickup', ?, ?, 90, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, `bref_${id}`, o.status, `ctok_${id}`, o.pickup ?? null, o.paymentMode ?? null,
        o.notifySent ? created : null, o.cancelReason ?? null, o.completionSource ?? null, BUYER_MAIL, created, created,
        SQL(o.updatedAt ?? new Date()));
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 3, 30, 90)")
        .run(`${id}-i1`, id);
      if (o.confirmedAt) {
        db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, created_at)
                    VALUES (?, ?, 'pending', 'confirmed', 'producer', 'seller', 'producer_page', ?)`)
          .run(`${id}-e1`, id, SQL(o.confirmedAt));
      }
      return id;
    }
    const row = (id: string) => db.prepare("SELECT status, cancel_reason, completion_source, pickup_time FROM orders WHERE id = ?").get(id) as any;
    const events = (id: string) => db.prepare("SELECT from_status, to_status, actor_role, channel, idempotency_key FROM order_events WHERE order_id = ? ORDER BY created_at, rowid").all(id) as any[];
    const settle = () => new Promise((r) => setTimeout(r, 40));
    // B2: the tests seed orders confirmed "now"; the real default floor is the A1 deploy, so pin the floor explicitly here.
    const OLD_FLOOR = "2020-01-01T00:00:00Z";
    const envOn = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ORDER_AUTOCOMPLETE_ENABLED: "1", ORDER_AUTOCOMPLETE_SINCE: OLD_FLOOR, ...extra });
    /** B1: a pickup time 3 days ahead at 15:30 Oslo time, computed relative to now (never rots). */
    function futurePickup(): { local: string; utcIso: string; text: string } {
      const d = new Date(Date.now() + 3 * 86_400_000);
      const ymd = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
      const off = /GMT([+-]\d+)/.exec(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Oslo", timeZoneName: "longOffset", hour: "2-digit" }).format(new Date(`${ymd}T12:00:00Z`)))?.[1] ?? "+1";
      const utcIso = new Date(Date.parse(`${ymd}T15:30:00Z`) - Number(off) * 3_600_000).toISOString();
      const day = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long" }).format(d);
      return { local: `${ymd}T15:30`, utcIso, text: `${day} kl. 15:30` };
    }
    const SYS = { role: "system" as const, channel: "system_job" as const, ref: "test" };
    const SELLER = { role: "seller" as const, channel: "producer_page" as const, ref: "test" };
    const BUYER = { role: "buyer" as const, channel: "web" as const, ref: "test" };

    // ════════════════════════════════════════════════════════════════════════
    // Pure helpers (order-lifecycle.ts)
    // ════════════════════════════════════════════════════════════════════════
    {
      assertEq(lifecycle.isOrderAutocompleteEnabled({}), false, "lc-01: automatic close is OFF by default");
      assertEq(lifecycle.isOrderAutocompleteEnabled({ ORDER_AUTOCOMPLETE_ENABLED: "1" }), true, "lc-02: =1 turns it on");
      assertEq(lifecycle.orderAutocompleteGraceHours({}), 24, "lc-03: grace default 24 h");
      assertEq(lifecycle.orderAutocompleteDefaultDays({}), 3, "lc-04: default days 3");
      const floorOld = { ORDER_AUTOCOMPLETE_SINCE: "2020-01-01T00:00:00Z" };
      const due1 = lifecycle.autoCompleteDueMs({ pickup_time: "2026-10-25T12:00:00.000Z", confirmed_at: "2026-10-20 08:00:00" }, floorOld);
      assertEq(due1, Date.parse("2026-10-26T12:00:00.000Z"), "lc-05: with a pickup time: pickup + 24 h");
      const due2 = lifecycle.autoCompleteDueMs({ pickup_time: null, confirmed_at: "2026-10-20 08:00:00" }, floorOld);
      assertEq(due2, Date.parse("2026-10-23T08:00:00.000Z"), "lc-06: without: confirmed_at + 3 days");
      assertEq(lifecycle.autoCompleteDueMs({ pickup_time: null, confirmed_at: null }, floorOld), null, "lc-07: no time known → never");
      const now = new Date("2026-10-22T10:00:00.000Z");
      // 25 October 2026 is the DST switch day; 14:00 Oslo is then UTC+1.
      assertEq(lifecycle.normalizePickupTime("2026-10-25T14:00", now), "2026-10-25T13:00:00.000Z", "lc-08: datetime-local is Oslo time (winter, UTC+1)");
      assertEq(lifecycle.normalizePickupTime("2026-10-23T14:00", now), "2026-10-23T12:00:00.000Z", "lc-09: datetime-local is Oslo time (summer, UTC+2)");
      assertEq(lifecycle.normalizePickupTime("", now), null, "lc-10: empty → no pickup time");
      assertEq(lifecycle.normalizePickupTime("i morgen", now), "invalid", "lc-11: garbage → invalid");
      assertEq(lifecycle.normalizePickupTime("2020-01-01T10:00", now), "invalid", "lc-12: long past → invalid");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC1 — automatic close (fake clock, switch, prepay)
    // ════════════════════════════════════════════════════════════════════════
    {
      const confirmedAt = new Date(Date.now() - 2 * 3600_000);
      const pickup = new Date(Date.now() + 24 * 3600_000); // tomorrow
      const withPickup = seedOrder({ status: "confirmed", pickup: pickup.toISOString(), confirmedAt });
      const noPickup = seedOrder({ status: "confirmed", confirmedAt });
      const legacyReady = seedOrder({ status: "ready", confirmedAt, pickup: pickup.toISOString() });

      // Switch OFF: even far in the future nothing closes.
      const farFuture = new Date(Date.now() + 30 * 86_400_000);
      let r = await followSvc.processOrderFollowups({ now: farFuture, env: {} });
      assertEq(r.auto_completed, 0, "ac1-01: switch off → the job closes nothing");
      assertEq([row(withPickup).status, row(noPickup).status, row(legacyReady).status], ["confirmed", "confirmed", "ready"], "ac1-02: switch off → all orders unchanged");
      const direct = await actionsSvc.applyOrderAction(withPickup, "auto_complete", SYS, { now: farFuture, env: {} });
      assertTrue(!direct.success && direct.status === 409, "ac1-03: switch off → the layer refuses auto_complete too");

      // Switch ON but RFB_DISABLE_ORDER_FOLLOWUPS=1 (Daniel's pre-pilot stop): nothing.
      r = await followSvc.processOrderFollowups({ now: farFuture, env: envOn({ RFB_DISABLE_ORDER_FOLLOWUPS: "1" }) });
      assertEq(r.auto_completed, 0, "ac1-04: RFB_DISABLE_ORDER_FOLLOWUPS=1 stops the automatic close as well");
      assertEq(row(withPickup).status, "confirmed", "ac1-05: …and the order is unchanged");

      // Switch ON, before the deadline (pickup + 23 h): nothing.
      const before = new Date(pickup.getTime() + 23 * 3600_000);
      r = await followSvc.processOrderFollowups({ now: before, env: envOn() });
      assertEq(row(withPickup).status, "confirmed", "ac1-06: pickup + 23 h → still confirmed");
      assertEq(row(noPickup).status, "confirmed", "ac1-07: without a pickup time, after < 3 days → still confirmed");

      // At pickup + 24 h: closed, completion_source 'auto'.
      const at = new Date(pickup.getTime() + 24 * 3600_000 + 1000);
      r = await followSvc.processOrderFollowups({ now: at, env: envOn() });
      assertEq(row(withPickup).status, "completed", "ac1-08: pickup + 24 h → completed");
      assertEq(row(withPickup).completion_source, "auto", "ac1-09: completion_source = 'auto'");
      assertEq(row(legacyReady).status, "completed", "ac1-10: a legacy `ready` order is closed like a confirmed one");
      assertEq(row(noPickup).status, "confirmed", "ac1-11: an order without a pickup time waits for confirmed_at + 3 days");
      assertEq(r.auto_completed, 2, "ac1-12: the job reports two automatic closes");
      const ev = events(withPickup).pop();
      assertTrue(ev?.from_status === "confirmed" && ev?.to_status === "completed" && ev?.actor_role === "system" && ev?.channel === "system_job",
        "ac1-13: the close is one order_events row with actor_role system / channel system_job");

      // Without a pickup time: confirmed_at + 3 days.
      r = await followSvc.processOrderFollowups({ now: new Date(confirmedAt.getTime() + 3 * 86_400_000 - 60_000), env: envOn() });
      assertEq(row(noPickup).status, "confirmed", "ac1-14: confirmed_at + 3 days − 1 min → still confirmed");
      r = await followSvc.processOrderFollowups({ now: new Date(confirmedAt.getTime() + 3 * 86_400_000 + 60_000), env: envOn() });
      assertTrue(row(noPickup).status === "completed" && row(noPickup).completion_source === "auto", "ac1-15: confirmed_at + 3 days → completed (auto)");

      // Idempotent: a second run changes nothing and writes no new rows.
      const evCount = (db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as any).n;
      r = await followSvc.processOrderFollowups({ now: farFuture, env: envOn() });
      assertEq(r.auto_completed, 0, "ac1-16: a second run closes nothing more");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as any).n, evCount, "ac1-17: …and writes no order_events");

      // Configurable grace.
      const p2 = new Date(Date.now() + 3600_000);
      const shortGrace = seedOrder({ status: "confirmed", pickup: p2.toISOString(), confirmedAt });
      await followSvc.processOrderFollowups({ now: new Date(p2.getTime() + 2 * 3600_000 + 1000), env: envOn({ ORDER_AUTOCOMPLETE_GRACE_HOURS: "2" }) });
      assertEq(row(shortGrace).status, "completed", "ac1-18: ORDER_AUTOCOMPLETE_GRACE_HOURS=2 closes at pickup + 2 h");

      // Prepay: closed, but no payment event and the payment row is untouched.
      const prepay = seedOrder({ status: "confirmed", pickup: p2.toISOString(), confirmedAt, paymentMode: "prepay" });
      db.prepare(`INSERT INTO payments (id, order_id, agent_id, stripe_account_id, amount_ore, status, captured_at)
                  VALUES ('pay-a1', ?, 'ag-a1', 'acct_test', 9000, 'captured', datetime('now'))`).run(prepay);
      const payEventsBefore = (db.prepare("SELECT COUNT(*) AS n FROM payment_events").get() as any).n;
      const payBefore = JSON.stringify(db.prepare("SELECT * FROM payments WHERE id = 'pay-a1'").get());
      await followSvc.processOrderFollowups({ now: farFuture, env: envOn() });
      assertTrue(row(prepay).status === "completed" && row(prepay).completion_source === "auto", "ac1-19: a prepay order is closed automatically too");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM payment_events").get() as any).n, payEventsBefore, "ac1-20: prepay auto-close writes no payment event");
      assertEq(JSON.stringify(db.prepare("SELECT * FROM payments WHERE id = 'pay-a1'").get()), payBefore, "ac1-21: …and leaves the payment row untouched");

      // No buyer receipt for an automatic close (nothing new to tell).
      await settle();
      assertTrue(!receipts.some((x) => x.subject.includes(prepay.slice(0, 8))), "ac1-22: no receipt mail for the automatic close");

      // Trust: completed_auto apart; does not score as a confirmed completion.
      const counts = trustSvc.getTrustEventCounts("ag-a1");
      assertEq(counts.completedAuto, 5, "ac1-23: five automatic closes counted as completedAuto");
      assertEq(counts.completed, 0, "ac1-24: …and NOT as confirmed completions");
      const autoRows = (db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE event_type = 'order_completed' AND completion_source = 'auto'").get() as any).n;
      assertEq(autoRows, 5, "ac1-25: trust_events rows carry completion_source 'auto'");
      const { trustScoreService } = require("../services/trust-score-service") as typeof import("../services/trust-score-service");
      const detail = trustScoreService.getBreakdown("ag-a1").signals.interaction.detail as string;
      assertTrue(/5 lukket automatisk/.test(detail) && !/fullført/.test(detail), "ac1-26: the trust detail shows automatic closes apart");

      // A seller «Hentet» is a confirmed completion (counted in `completed`).
      const sellerDone = seedOrder({ status: "confirmed", confirmedAt });
      const sd = await actionsSvc.applyOrderAction(sellerDone, "complete", SELLER);
      assertTrue(sd.success && row(sellerDone).completion_source === "seller", "ac1-27: seller «Hentet» → completed, completion_source 'seller'");
      assertEq(trustSvc.getTrustEventCounts("ag-a1").completed, 1, "ac1-28: the seller completion counts as confirmed");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Routes (producer page, admin) on an in-process server
    // ════════════════════════════════════════════════════════════════════════
    {
      const express = require("express");
      const cartRoutes = require("../routes/marketplace-cart") as typeof import("../routes/marketplace-cart");
      const app = express();
      app.use(express.json());
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
    const tokenOf = (id: string) => `ctok_${id}`;

    // ════════════════════════════════════════════════════════════════════════
    // One click: «Bekreft» with a pickup time, no «Klar for henting» step
    // ════════════════════════════════════════════════════════════════════════
    {
      const id = seedOrder({ status: "pending", notifySent: true });
      let page = await req("GET", `/produsent/ordre/${tokenOf(id)}`);
      assertTrue(page.text.includes('name="pickup_time"') && page.text.includes("Bekreft ordren"), "one-01: the pending page offers «Bekreft» with an optional pickup time");
      receipts.length = 0;
      process.env.ORDER_AUTOCOMPLETE_ENABLED = "1";
      const fp = futurePickup();
      const r = await req("POST", `/produsent/ordre/${tokenOf(id)}`, { form: { action: "confirm", pickup_time: fp.local } });
      assertTrue(r.status === 303 && (r.location || "").includes("done=confirmed"), "one-02: one POST confirms (303, done=confirmed)");
      assertEq(row(id).pickup_time, fp.utcIso, "one-03: the pickup time is stored as UTC (Oslo 15:30)");
      await settle();
      const conf = receipts.find((x) => x.subject.startsWith("Ordrebekreftelse"));
      assertTrue(!!conf && conf.to === BUYER_MAIL, "one-04: the buyer gets the confirmation receipt");
      assertTrue(!!conf && conf.textContent.includes(`Hentetid: ${fp.text}`), "one-05: …with the pickup time in Oslo time");
      assertTrue(!!conf && conf.textContent.includes("ordren avsluttes av seg selv") && conf.textContent.includes("kontakt@rettfrabonden.com"),
        "one-06: …saying the order closes by itself and how to say something is wrong");
      page = await req("GET", `/produsent/ordre/${tokenOf(id)}`);
      assertTrue(!page.text.includes("Klar for henting</button>") && !page.text.includes('value="ready"'), "one-07: no «Klar for henting» button any more");
      assertTrue(page.text.includes("Kunden kom ikke") && page.text.includes("Ordren avsluttes av seg selv"), "one-08: confirmed page: optional «Kunden kom ikke» + the auto-close hint");

      // Switch off → the receipt does not promise an automatic close.
      delete process.env.ORDER_AUTOCOMPLETE_ENABLED;
      const id2 = seedOrder({ status: "pending", notifySent: true });
      receipts.length = 0;
      await req("POST", `/produsent/ordre/${tokenOf(id2)}`, { form: { action: "confirm" } });
      await settle();
      const conf2 = receipts.find((x) => x.subject.startsWith("Ordrebekreftelse"));
      assertTrue(!!conf2 && !conf2.textContent.includes("avsluttes av seg selv") && conf2.textContent.includes("Avtal tid og sted"),
        "one-09: switch off / no pickup time → no auto-close promise, «Avtal tid og sted»");
      const bad = seedOrder({ status: "pending", notifySent: true });
      const rb = await req("POST", `/produsent/ordre/${tokenOf(bad)}`, { form: { action: "confirm", pickup_time: "neste uke" } });
      assertTrue((rb.location || "").includes("error=hentetid") && row(bad).status === "pending", "one-10: an invalid pickup time → error, order unchanged");
      // The legacy «ready» action is still accepted (a page opened before the change).
      const legacy = await req("POST", `/produsent/ordre/${tokenOf(id2)}`, { form: { action: "ready" } });
      assertTrue((legacy.location || "").includes("done=ready") && row(id2).status === "ready", "one-11: legacy action=ready still works");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC2 — no_show / buyer_cancelled / cannot_deliver + receipts; conflict
    // ════════════════════════════════════════════════════════════════════════
    {
      const confirmedAt = new Date(Date.now() - 4 * 3600_000); // > ORDER_NO_SHOW_MIN_HOURS (3)
      // no_show straight from `confirmed` (no «Klar» step) via the page.
      const ns = seedOrder({ status: "confirmed", confirmedAt });
      receipts.length = 0;
      let r = await req("POST", `/produsent/ordre/${tokenOf(ns)}`, { form: { action: "no_show" } });
      assertTrue((r.location || "").includes("done=cancelled") && row(ns).status === "cancelled" && row(ns).cancel_reason === "no_show",
        "ac2-01: «Kunden kom ikke» on a confirmed order → cancelled / no_show");
      await settle();
      const nsMail = receipts.find((x) => x.subject.includes("ikke hentet"));
      assertTrue(!!nsMail && nsMail.to === BUYER_MAIL && nsMail.textContent.includes("kontakt@rettfrabonden.com"), "ac2-02: the buyer gets a no-show receipt with how to object");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE event_type = 'order_no_show' AND ref = ?").get(ns) as any).n, 1, "ac2-03: no-show trust event written (ledger only)");

      const bc = seedOrder({ status: "confirmed", confirmedAt });
      receipts.length = 0;
      r = await req("POST", `/produsent/ordre/${tokenOf(bc)}`, { form: { action: "cancel_buyer" } });
      assertTrue(row(bc).status === "cancelled" && row(bc).cancel_reason === "buyer_cancelled", "ac2-04: «Kunden avbestilte» → cancelled / buyer_cancelled");
      await settle();
      assertTrue(receipts.some((x) => x.textContent.includes("Avbestillingen din er registrert")), "ac2-05: …with a receipt to the buyer");

      const cd = seedOrder({ status: "ready", confirmedAt });
      receipts.length = 0;
      r = await req("POST", `/produsent/ordre/${tokenOf(cd)}`, { form: { action: "cancel_producer" } });
      assertTrue(row(cd).status === "cancelled" && row(cd).cancel_reason === "producer_cancelled", "ac2-06: «Kan ikke levere» → cancelled / producer_cancelled");
      await settle();
      assertTrue(receipts.some((x) => x.textContent.includes("ikke kan leveres")), "ac2-07: …with a receipt to the buyer");

      // «until the close»: after completion no_show is refused (no receipt, no change).
      const closed = seedOrder({ status: "completed", completionSource: "seller" });
      const cl = await actionsSvc.applyOrderAction(closed, "no_show", SELLER);
      assertTrue(!cl.success && cl.status === 409 && !(cl as any).conflict && row(closed).status === "completed", "ac2-08: no_show after the close → 409, unchanged");
      const pend = seedOrder({ status: "pending" });
      const np = await actionsSvc.applyOrderAction(pend, "no_show", SELLER);
      assertTrue(!np.success && np.status === 409 && row(pend).status === "pending", "ac2-09: no_show on a never-confirmed order → 409");

      // Conflict 1: the buyer said «picked up», the seller then says «no_show» within grace.
      const c1 = seedOrder({ status: "confirmed", confirmedAt });
      const pu = await actionsSvc.applyOrderAction(c1, "picked_up", BUYER);
      assertTrue(pu.success && row(c1).status === "completed" && row(c1).completion_source === "buyer", "ac2-10: buyer picked_up → completed, completion_source 'buyer'");
      adminSent.length = 0;
      const conflictEvBefore = events(c1).length;
      const c1r = await actionsSvc.applyOrderAction(c1, "no_show", SELLER);
      assertTrue(!c1r.success && c1r.status === 409 && (c1r as any).conflict === true, "ac2-11: seller no_show after buyer picked_up → 409 conflict");
      assertTrue(row(c1).status === "completed" && row(c1).cancel_reason == null, "ac2-12: …no automatic decision: status unchanged");
      assertEq(events(c1).length, conflictEvBefore, "ac2-13: …no order_events row");
      await settle();
      assertTrue(adminSent.some((m) => m.to === ADMIN_MAIL && m.subject.startsWith("Motstrid på ordre") && m.textContent.includes(c1)), "ac2-14: …admin alert sent");

      // Conflict 2: the seller said «no_show», then the buyer says «picked up».
      const c2 = seedOrder({ status: "confirmed", confirmedAt });
      await actionsSvc.applyOrderAction(c2, "no_show", SELLER);
      adminSent.length = 0;
      const c2r = await actionsSvc.applyOrderAction(c2, "picked_up", BUYER);
      assertTrue(!c2r.success && (c2r as any).conflict === true && row(c2).status === "cancelled" && row(c2).cancel_reason === "no_show",
        "ac2-15: buyer picked_up after a seller no_show → conflict, status unchanged");
      await settle();
      assertTrue(adminSent.some((m) => m.subject.startsWith("Motstrid på ordre") && m.textContent.includes(c2)), "ac2-16: …admin alert sent");

      // Outside the grace window: a plain refusal, no alert.
      adminSent.length = 0;
      const late = await actionsSvc.applyOrderAction(c2, "picked_up", BUYER, { now: new Date(Date.now() + 25 * 3600_000) });
      assertTrue(!late.success && late.status === 409 && !(late as any).conflict, "ac2-17: after the grace window → plain 409, not a conflict");
      await settle();
      assertEq(adminSent.length, 0, "ac2-18: …and no admin alert");

      // The buyer's own withdraw (pending): cancelled without a trust event against the producer.
      const w = seedOrder({ status: "pending" });
      const wr = await actionsSvc.applyOrderAction(w, "withdraw", BUYER);
      assertTrue(wr.success && row(w).cancel_reason === "buyer_cancelled", "ac2-19: buyer withdraw on pending → cancelled / buyer_cancelled");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE ref = ?").get(w) as any).n, 0, "ac2-20: …no trust event against the producer");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Roles and system rules
    // ════════════════════════════════════════════════════════════════════════
    {
      const p = seedOrder({ status: "pending" });
      const b = await actionsSvc.applyOrderAction(p, "confirm", BUYER);
      assertTrue(!b.success && b.status === 403 && row(p).status === "pending", "role-01: the buyer cannot confirm (403)");
      const s = await actionsSvc.applyOrderAction(p, "auto_complete", SELLER);
      assertTrue(!s.success && s.status === 403, "role-02: the seller cannot run auto_complete (403)");
      const u = await actionsSvc.applyOrderAction(p, "explode", SELLER);
      assertTrue(!u.success && u.status === 400, "role-03: unknown action → 400");
      const m = await actionsSvc.applyOrderAction(p, "message", BUYER);
      assertTrue(!m.success && m.status === 501, "role-04: message is not built yet (501)");
      const pnr = await actionsSvc.applyOrderAction(p, "producer_no_response", SYS);
      assertTrue(!pnr.success && pnr.status === 409 && row(p).status === "pending", "role-05: producer_no_response without notify_sent_at → refused");
      const p2 = seedOrder({ status: "pending", notifySent: true });
      const pnr2 = await actionsSvc.applyOrderAction(p2, "producer_no_response", SYS);
      assertTrue(pnr2.success && row(p2).cancel_reason === "producer_no_response", "role-06: producer_no_response with notify_sent_at → cancelled");
      const adm = seedOrder({ status: "confirmed", confirmedAt: new Date() });
      const ar = await req("POST", `/admin/marketplace/orders/${adm}/complete`, { headers: { "X-Admin-Key": ADMIN_KEY } });
      assertTrue(ar.status === 200 && row(adm).status === "completed" && row(adm).completion_source === "admin", "role-07: admin complete → completion_source 'admin'");
      // Legacy caller (payment-service's payment_expired): role/channel derived.
      const pe = seedOrder({ status: "pending" });
      cartSvc.transitionOrder(pe, "cancelled", { actor: "system", cancelReason: "payment_expired" });
      const pev = events(pe).pop();
      assertTrue(pev?.actor_role === "system" && pev?.channel === "system_job", "role-08: a legacy transitionOrder caller still gets actor_role + channel");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC5 — idempotency
    // ════════════════════════════════════════════════════════════════════════
    {
      const id = seedOrder({ status: "pending" });
      receipts.length = 0;
      const a = await actionsSvc.applyOrderAction(id, "confirm", SELLER, { idempotencyKey: "k-123" });
      const b = await actionsSvc.applyOrderAction(id, "confirm", SELLER, { idempotencyKey: "k-123" });
      assertTrue(a.success && !a.replayed, "ac5-01: first call transitions");
      assertTrue(b.success && b.replayed && b.status === "confirmed", "ac5-02: the same key again → same answer (replayed)");
      assertEq(events(id).length, 1, "ac5-03: …and exactly one transition");
      assertEq(events(id)[0]?.idempotency_key, "k-123", "ac5-04: the key is stored on the order_events row");
      await settle();
      assertEq(receipts.length, 1, "ac5-05: the replay sends no second receipt");
      const c = await actionsSvc.applyOrderAction(id, "confirm", SELLER, { idempotencyKey: "k-456" });
      assertTrue(!c.success && c.status === 409, "ac5-06: a NEW key for an impossible action → 409 as usual");
      const bad = await actionsSvc.applyOrderAction(id, "confirm", SELLER, { idempotencyKey: "has spaces" });
      assertTrue(!bad.success && bad.status === 400, "ac5-07: a malformed key → 400");

      // Admin route: Idempotency-Key header.
      const ad = seedOrder({ status: "pending" });
      const h = { "X-Admin-Key": ADMIN_KEY, "Idempotency-Key": "admin-k1" };
      const r1 = await req("POST", `/admin/marketplace/orders/${ad}/confirm`, { headers: h });
      const r2 = await req("POST", `/admin/marketplace/orders/${ad}/confirm`, { headers: h });
      assertTrue(r1.status === 200 && r2.status === 200 && r2.body?.status === "confirmed", "ac5-08: admin route, same key twice → 200 both times");
      assertEq(events(ad).length, 1, "ac5-09: …one transition");
      const r3 = await req("POST", `/admin/marketplace/orders/${ad}/confirm`, { headers: { "X-Admin-Key": ADMIN_KEY } });
      assertEq(r3.status, 409, "ac5-10: without the key a repeat is still a 409");

      // Producer page: the per-form key makes a double submit harmless.
      const pg = seedOrder({ status: "pending" });
      const html = (await req("GET", `/produsent/ordre/${tokenOf(pg)}`)).text;
      const idem = /name="action" value="confirm"><input type="hidden" name="idem" value="([0-9a-f-]+)"/.exec(html)?.[1] || "";
      assertTrue(idem.length >= 8, "ac5-11: the confirm form carries an idempotency key");
      const f1 = await req("POST", `/produsent/ordre/${tokenOf(pg)}`, { form: { action: "confirm", idem } });
      const f2 = await req("POST", `/produsent/ordre/${tokenOf(pg)}`, { form: { action: "confirm", idem } });
      assertTrue((f1.location || "").includes("done=confirmed") && (f2.location || "").includes("done=confirmed"), "ac5-12: double submit → both «done=confirmed», no error");
      assertEq(events(pg).length, 1, "ac5-13: …one transition");
      const pev = events(pg)[0];
      assertTrue(pev?.actor_role === "seller" && pev?.channel === "producer_page", "ac5-14: page transitions: actor_role seller / channel producer_page");
      const aev = events(ad)[0];
      assertTrue(aev?.actor_role === "admin" && aev?.channel === "admin", "ac5-15: admin transitions: actor_role admin / channel admin");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Fix-up A1b — B2 (cutoff + dry run), S2, S4 (M9, M14), S5, S3, S9
    // ════════════════════════════════════════════════════════════════════════
    {
      const far = new Date(Date.now() + 60 * 86_400_000);
      const deploy = Date.parse(lifecycle.A1_DEPLOY_ISO);

      // B2 — default floor = the A1 deploy; no env needed to be safe.
      const preA1 = seedOrder({ status: "confirmed", confirmedAt: new Date(deploy - 10 * 86_400_000) });
      const postA1 = seedOrder({ status: "confirmed", confirmedAt: new Date(deploy + 60_000) });
      const noSince = { ORDER_AUTOCOMPLETE_ENABLED: "1" } as NodeJS.ProcessEnv;
      assertEq(lifecycle.orderAutocompleteSinceMs({}), deploy, "b2-01: default floor is the A1 deploy");
      assertEq(lifecycle.orderAutocompleteSinceMs({ ORDER_AUTOCOMPLETE_SINCE: "2026-11-01T00:00:00Z" }), Date.parse("2026-11-01T00:00:00Z"), "b2-02: ORDER_AUTOCOMPLETE_SINCE overrides");
      assertEq(lifecycle.orderAutocompleteSinceMs({ ORDER_AUTOCOMPLETE_SINCE: "i går" }), deploy, "b2-03: an unparseable value falls back to the default");
      const direct = await actionsSvc.applyOrderAction(preA1, "auto_complete", SYS, { now: far, env: noSince });
      assertTrue(!direct.success && direct.status === 409 && row(preA1).status === "confirmed", "b2-04: the layer refuses to auto-close an order confirmed before the floor");
      const dry = await req("GET", "/admin/orders/pilot-status", { headers: { "X-Admin-Key": ADMIN_KEY } });
      assertEq(dry.body?.auto_complete?.enabled, false, "b2-05: pilot-status reports the switch (off)");
      assertEq(dry.body?.auto_complete?.since, lifecycle.A1_DEPLOY_ISO, "b2-06: …and the floor in use");
      const dueIds = followSvc.listAutoCompleteDue(db as any, far, {}).map((o) => o.id);
      assertTrue(dueIds.includes(postA1) && !dueIds.includes(preA1), "b2-07: the dry-run selection holds post-A1 orders only, with the switch off");
      assertTrue(typeof dry.body?.auto_complete?.would_auto_complete === "number", "b2-08: pilot-status carries would_auto_complete");
      const openNow = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('confirmed','ready')").get() as any).n;
      assertTrue(dry.body.auto_complete.would_auto_complete <= openNow, "b2-09: would_auto_complete counts a subset of the open orders");
      const before = (db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as any).n;
      await followSvc.processOrderFollowups({ now: far, env: noSince });
      assertEq(row(preA1).status, "confirmed", "b2-10: the job leaves the pre-A1 order alone, switch ON and no env floor");
      assertEq(row(postA1).status, "completed", "b2-11: …and closes the post-A1 one");
      const after = (db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as any).n;
      assertTrue(after >= before + 1, "b2-12: the closes wrote order_events");
      await followSvc.processOrderFollowups({ now: far, env: noSince });
      assertEq(row(preA1).status, "confirmed", "b2-13: still untouched on a later run");
      await followSvc.processOrderFollowups({ now: far, env: { ...noSince, ORDER_AUTOCOMPLETE_SINCE: "2020-01-01T00:00:00Z" } });
      assertEq(row(preA1).status, "completed", "b2-14: an explicit older ORDER_AUTOCOMPLETE_SINCE opts the old order in");

      // S2 — no_show only after the pickup time (seller); admin may correct.
      const futurePick = seedOrder({ status: "confirmed", pickup: new Date(Date.now() + 2 * 3600_000).toISOString(), confirmedAt: new Date(Date.now() - 5 * 3600_000) });
      const early = await actionsSvc.applyOrderAction(futurePick, "no_show", SELLER);
      assertTrue(!early.success && early.status === 409 && row(futurePick).status === "confirmed", "s2-01: no_show before the pickup time → 409, unchanged");
      const pageEarly = (await req("GET", `/produsent/ordre/${tokenOf(futurePick)}`)).text;
      assertTrue(!pageEarly.includes('value="no_show"') && pageEarly.includes("Kunden kom ikke» kan registreres fra"), "s2-02: the page hides «Kunden kom ikke» before the pickup time and says when");
      const postEarly = await req("POST", `/produsent/ordre/${tokenOf(futurePick)}`, { form: { action: "no_show" } });
      assertTrue((postEarly.location || "").includes("error=ugyldig") && row(futurePick).status === "confirmed", "s2-03: a forged POST before the pickup time is refused");
      const ok = await actionsSvc.applyOrderAction(futurePick, "no_show", SELLER, { now: new Date(Date.now() + 3 * 3600_000) });
      assertTrue(ok.success && row(futurePick).cancel_reason === "no_show", "s2-04: after the pickup time → allowed");
      const noPickEarly = seedOrder({ status: "confirmed", confirmedAt: new Date(Date.now() - 3600_000) });
      const npe = await actionsSvc.applyOrderAction(noPickEarly, "no_show", SELLER);
      assertTrue(!npe.success && npe.status === 409, "s2-05: without a pickup time: < 3 h after confirmation → 409");
      const adminEarly = seedOrder({ status: "confirmed", pickup: new Date(Date.now() + 5 * 3600_000).toISOString(), confirmedAt: new Date() });
      const ae = await actionsSvc.applyOrderAction(adminEarly, "no_show", { role: "admin", channel: "admin", ref: "t" });
      assertTrue(ae.success, "s2-06: admin may register a no-show at any time");
      assertTrue((await req("GET", `/produsent/ordre/${tokenOf(noPickEarly)}`)).text.includes("Kunden kom ikke» kan registreres fra"), "s2-07: the page shows the time for an order without pickup time too");

      // S5 — min on the pickup field
      const pg = seedOrder({ status: "pending", notifySent: true });
      const pgHtml = (await req("GET", `/produsent/ordre/${tokenOf(pg)}`)).text;
      assertTrue(/name="pickup_time" min="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/.test(pgHtml), "s5-01: the pickup field has a min attribute (now, Oslo time)");

      // S3 — the producer e-mail no longer mentions «klar for henting»
      const notifySrc = require("fs").readFileSync(require("path").join(__dirname, "..", "services", "order-notify-service.ts"), "utf8") as string;
      assertTrue(!/klar for henting/i.test(notifySrc) && !/samme side brukes/.test(notifySrc), "s3-01: no outdated «klar for henting» text in the producer e-mail");

      // S4 / M9 — the automatic close never touches the payment step
      const pm = seedOrder({ status: "confirmed", confirmedAt: new Date(), paymentMode: "prepay" });
      db.prepare(`INSERT INTO payments (id, order_id, agent_id, stripe_account_id, amount_ore, status, captured_at)
                  VALUES ('pay-a1b', ?, 'ag-a1', 'acct_test', 9000, 'captured', datetime('now'))`).run(pm);
      let stripeTouched = 0;
      const spyStripe: any = new Proxy({}, { get() { stripeTouched++; return () => { stripeTouched++; throw new Error("stripe must not be called"); }; } });
      const peBefore = (db.prepare("SELECT COUNT(*) AS n FROM payment_events").get() as any).n;
      const ac = await actionsSvc.applyOrderAction(pm, "auto_complete", SYS, { payments: spyStripe, now: far, env: envOn() });
      assertTrue(ac.success && ac.payment_effect === "none" && stripeTouched === 0, "m9-01: auto_complete with a payments client → payment_effect none, Stripe untouched");
      assertEq((db.prepare("SELECT COUNT(*) AS n FROM payment_events").get() as any).n, peBefore, "m9-02: …no payment_events");
      // …and via the admin route (payments client resolved there)
      const pm2 = seedOrder({ status: "confirmed", confirmedAt: new Date(), paymentMode: "prepay" });
      const ac2 = await actionsSvc.applyOrderAction(pm2, "auto_complete", { role: "admin", channel: "admin", ref: "t" }, { payments: spyStripe, now: far, env: envOn() });
      assertTrue(ac2.success && ac2.payment_effect === "none" && stripeTouched === 0, "m9-03: admin auto_complete with a payments client → same");

      // S4 / M14 — the layer's own cancelGate (prepay + payments off)
      delete process.env.PAYMENTS_ENABLED;
      for (const [act, role, st] of [["buyer_cancelled", "seller", "confirmed"], ["cannot_deliver", "seller", "confirmed"], ["cancel", "buyer", "confirmed"], ["withdraw", "buyer", "pending"]] as const) {
        const o = seedOrder({ status: st, confirmedAt: new Date(), paymentMode: "prepay" });
        const r = await actionsSvc.applyOrderAction(o, act, { role, channel: "web", ref: "t" });
        assertTrue(!r.success && r.status === 409 && row(o).status === st, `m14-${act}: prepay + payments off → the layer itself refuses ${act} (409)`);
      }
      const unknownMode = seedOrder({ status: "confirmed", confirmedAt: new Date() });
      db.prepare("UPDATE orders SET payment_mode = NULL WHERE id = ?").run(unknownMode);
      const pay = seedOrder({ status: "confirmed", confirmedAt: new Date(), paymentMode: "pay_at_pickup" });
      const pr = await actionsSvc.applyOrderAction(pay, "buyer_cancelled", SELLER);
      assertTrue(pr.success, "m14-05: a pay-at-pickup order is still cancellable");
      process.env.PAYMENTS_ENABLED = "1";
      const gp = seedOrder({ status: "confirmed", confirmedAt: new Date(), paymentMode: "prepay" });
      const gr = await actionsSvc.applyOrderAction(gp, "buyer_cancelled", SELLER);
      assertTrue(gr.success, "m14-06: …and a prepay order too once PAYMENTS_ENABLED=1");
      delete process.env.PAYMENTS_ENABLED;

      // S9 — a reused key with a DIFFERENT action is a collision, not a silent success
      const k1 = seedOrder({ status: "pending" });
      const a1 = await actionsSvc.applyOrderAction(k1, "confirm", SELLER, { idempotencyKey: "s9-key" });
      const a2 = await actionsSvc.applyOrderAction(k1, "decline", SELLER, { idempotencyKey: "s9-key" });
      assertTrue(a1.success && !a2.success && a2.status === 409 && /different action/.test((a2 as any).error), "s9-01: same key, other action → 409 (not a replay)");
      assertEq(row(k1).status, "confirmed", "s9-02: …status unchanged");
      const a3 = await actionsSvc.applyOrderAction(k1, "confirm", SELLER, { idempotencyKey: "s9-key" });
      assertTrue(a3.success && a3.replayed, "s9-03: same key, same action → replay");
      const k2 = seedOrder({ status: "confirmed", confirmedAt: new Date(Date.now() - 4 * 3600_000) });
      await actionsSvc.applyOrderAction(k2, "no_show", SELLER, { idempotencyKey: "s9-key2" });
      const b2 = await actionsSvc.applyOrderAction(k2, "buyer_cancelled", SELLER, { idempotencyKey: "s9-key2" });
      assertTrue(!b2.success && b2.status === 409, "s9-04: same key, other cancel reason (no_show vs buyer_cancelled) → 409");
      const k3 = seedOrder({ status: "confirmed", confirmedAt: new Date() });
      await actionsSvc.applyOrderAction(k3, "complete", SELLER, { idempotencyKey: "s9-key3" });
      const c3 = await actionsSvc.applyOrderAction(k3, "picked_up", BUYER, { idempotencyKey: "s9-key3" });
      assertTrue(!c3.success && c3.status === 409, "s9-05: same key, other completion source (seller vs buyer) → 409");
      const k4 = seedOrder({ status: "pending" });
      const form = await req("POST", `/produsent/ordre/${tokenOf(k4)}`, { form: { action: "confirm", idem: "abcdef12-0000" } });
      const form2 = await req("POST", `/produsent/ordre/${tokenOf(k4)}`, { form: { action: "decline", idem: "abcdef12-0000" } });
      assertTrue((form.location || "").includes("done=confirmed") && (form2.location || "").includes("error=ugyldig") && row(k4).status === "confirmed",
        "s9-06: producer page: the same form key with another action is refused");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Statistics + AC5 (every row)
    // ════════════════════════════════════════════════════════════════════════
    {
      const ps = await req("GET", "/admin/orders/pilot-status", { headers: { "X-Admin-Key": ADMIN_KEY } });
      assertEq(ps.body?.orders_30d?.completed_auto, (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE completion_source = 'auto'").get() as any).n, "stat-01: pilot-status counts completed_auto apart");
      assertEq(ps.body?.orders_30d?.completed_confirmed, (ps.body?.orders_30d?.by_status?.completed ?? 0) - ps.body.orders_30d.completed_auto, "stat-02: …and the confirmed completions separately");
      const total = (db.prepare("SELECT COUNT(*) AS n FROM order_events").get() as any).n;
      const missing = (db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE actor_role IS NULL OR channel IS NULL").get() as any).n;
      assertTrue(total > 20, "ac5-16: the run wrote many order_events rows");
      assertEq(missing, 0, "ac5-17: EVERY order_events row has actor_role and channel");
    }
  } catch (err) {
    failed++;
    failures.push(`order-actions-fase-a1: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    receiptSvc.__setBuyerReceiptSendForTesting(null);
    receiptSvc.__setBuyerReceiptTestDb(null);
    followSvc.__setOrderFollowupsTestDb(null);
    actionsSvc.__setOrderActionsTestDb(null);
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
  console.log("── order-actions-fase-a1 tests ──");
  runOrderActionsFaseA1Tests({ log: true }).then((r) => {
    console.log(`\norder-actions-fase-a1: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
