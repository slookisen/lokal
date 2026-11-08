/**
 * admin-orders-close-stale.test.ts — POST /admin/orders/close-stale.
 * Old RFB orders (pending 0-NOK, confirmed test orders) get status
 * 'cancelled' + cancel_reason 'legacy_cleanup' with no e-mail, no trust
 * event and no payment change; the 30-day contact sweep then picks them up.
 * Standalone: npx tsx src/routes/admin-orders-close-stale.test.ts
 */
import Database from "better-sqlite3";
import * as http from "http";
import express from "express";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

export async function runAdminOrdersCloseStaleTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0, failed = 0;
  const failures: string[] = [];
  const ok = (c: boolean, label: string) => { if (c) passed++; else { failed++; failures.push("✗ " + label); } };
  const eq = (a: unknown, b: unknown, label: string) => {
    if (a === b) passed++; else { failed++; failures.push(`✗ ${label}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`); }
  };

  const initMod = require("../database/init") as typeof import("../database/init");
  const adminOrdersMod = require("./admin-orders") as typeof import("./admin-orders");
  const sweepMod = require("../services/cart-contact-sweep") as typeof import("../services/cart-contact-sweep");
  const receiptMod = require("../services/order-receipt-service") as typeof import("../services/order-receipt-service");
  const notifyMod = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const { emailService } = require("../services/email-service") as typeof import("../services/email-service");

  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  // Adopt-ambient admin key (tests/test.ts kriterium 2): never mutate it under the suite.
  const prevAdminKey = process.env.ADMIN_KEY;
  const KEY = process.env.ADMIN_KEY || "close-stale-test-admin-key";
  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const es = emailService as any;
  const origSendEmail = es.sendEmail;
  const origSendRaw = es.sendRaw;
  let mailCalls = 0;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    adminOrdersMod.__setAdminOrdersTestDb(db as any);
    sweepMod.__setCartContactSweepTestDb(db as any);
    process.env.ADMIN_KEY = KEY;
    es.sendEmail = async () => { mailCalls++; return { success: true }; };
    if (typeof origSendRaw === "function") es.sendRaw = async () => { mailCalls++; return { success: true }; };
    receiptMod.__setBuyerReceiptSendForTesting(async () => { mailCalls++; return { success: true } as any; });
    notifyMod.__setOrderNotifySendForTesting(async () => { mailCalls++; return { success: true } as any; });

    db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key)
      VALUES ('cs-a', 'Gard A', 'Testprodusent', 'self', 'a@example.no', 'https://example.no', 'producer', 'k-a')`).run();
    const insOrder = db.prepare(`INSERT INTO orders (id, agent_id, buyer_ref, status, total_nok, created_at, updated_at, buyer_email, buyer_name, cancel_reason)
      VALUES (?, 'cs-a', 'ref', ?, ?, ?, ?, 'kjoper@example.no', 'Kari', ?)`);
    const OLD = "2026-06-14 10:00:00";
    insOrder.run("o-pend", "pending", 0, OLD, OLD, null);
    insOrder.run("o-conf", "confirmed", 120, OLD, OLD, null);
    insOrder.run("o-ready", "ready", 50, OLD, OLD, null);
    insOrder.run("o-done", "completed", 50, OLD, OLD, null);
    insOrder.run("o-new", "pending", 0, "2026-11-06 10:00:00", "2026-11-06 10:00:00", null);
    insOrder.run("o-paid", "pending", 80, OLD, OLD, null);
    insOrder.run("o-paidfinal", "pending", 80, OLD, OLD, null);
    const insPay = db.prepare(`INSERT INTO payments (id, order_id, agent_id, stripe_account_id, amount_ore, status) VALUES (?, ?, 'cs-a', 'acct_x', 8000, ?)`);
    insPay.run("p1", "o-paid", "authorized");
    insPay.run("p2", "o-paidfinal", "expired");

    const app = express();
    app.use(express.json());
    app.use("/admin/orders", adminOrdersMod.default);
    server = http.createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    function post(body: any, headers: Record<string, string> = { "X-Admin-Key": KEY }): Promise<{ status: number; body: any }> {
      initMod.__setDbForTesting(db as any);
      process.env.ADMIN_KEY = KEY;
      return new Promise((resolve, reject) => {
        const b = JSON.stringify(body);
        const r = http.request({ method: "POST", host: "127.0.0.1", port, path: "/admin/orders/close-stale",
          headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(b)) } }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => {
            let parsed: any = null; try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
            resolve({ status: resp.statusCode || 0, body: parsed });
          });
        });
        r.on("error", reject);
        r.write(b);
        r.end();
      });
    }
    const order = (id: string) => db.prepare("SELECT status, cancel_reason, updated_at, buyer_email FROM orders WHERE id = ?").get(id) as any;
    const events = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?").get(id) as any).n as number;
    const trustCount = () => (db.prepare("SELECT COUNT(*) AS n FROM trust_events").get() as any).n as number;
    const payStatus = (id: string) => (db.prepare("SELECT status FROM payments WHERE order_id = ?").get(id) as any).status;
    const byId = (body: any) => Object.fromEntries((body?.results || []).map((r: any) => [r.order_id, r]));
    const ALL = ["o-pend", "o-conf", "o-ready", "o-done", "o-new", "o-paid", "o-paidfinal", "o-missing"];
    const base = { order_ids: ALL, reason: "legacy_cleanup", older_than: "2026-07-01T00:00:00Z" };

    // ── auth + validation ────────────────────────────────────────────────────
    let r = await post(base, {});
    eq(r.status, 403, "auth-01: no admin key -> 403 (requireAdmin)");
    r = await post(base, { "X-Admin-Key": "wrong-key" });
    eq(r.status, 403, "auth-02: wrong admin key -> 403");
    r = await post({ ...base, order_ids: [] });
    eq(r.status, 400, "val-01: empty order_ids -> 400");
    r = await post({ ...base, order_ids: Array.from({ length: 101 }, (_, i) => `x${i}`) });
    eq(r.status, 400, "val-02: more than 100 ids -> 400");
    r = await post({ ...base, reason: "other" });
    eq(r.status, 400, "val-03: reason other than legacy_cleanup -> 400");
    r = await post({ ...base, older_than: "not-a-date" });
    eq(r.status, 400, "val-04: invalid older_than -> 400");
    r = await post({ order_ids: ALL, reason: "legacy_cleanup" });
    eq(r.status, 400, "val-05: missing older_than -> 400");
    r = await post({ ...base, dry_run: "false" });
    eq(r.status, 400, "val-06: non-boolean dry_run -> 400");

    // ── dry run (default) ────────────────────────────────────────────────────
    r = await post(base);
    eq(r.status, 200, "dry-01: 200");
    eq(r.body?.dry_run, true, "dry-02: dry_run defaults to true");
    let m = byId(r.body);
    eq(m["o-pend"]?.result, "would_close", "dry-03: pending old order -> would_close");
    eq(m["o-conf"]?.result, "would_close", "dry-04: confirmed old order -> would_close");
    eq(m["o-paidfinal"]?.result, "would_close", "dry-05: final (expired) payment does not block");
    eq(m["o-ready"]?.reason, "status_not_allowed:ready", "dry-06: ready -> status_not_allowed:ready");
    eq(m["o-done"]?.reason, "status_not_allowed:completed", "dry-07: completed -> status_not_allowed");
    eq(m["o-new"]?.reason, "too_new", "dry-08: created after older_than -> too_new");
    eq(m["o-paid"]?.reason, "has_open_payment", "dry-09: authorized payment -> has_open_payment");
    eq(m["o-missing"]?.reason, "not_found", "dry-10: unknown id -> not_found");
    eq(r.body?.counts?.would_close, 3, "dry-11: counts.would_close = 3");
    eq(r.body?.counts?.skipped, 5, "dry-12: counts.skipped = 5");
    eq(order("o-pend").status, "pending", "dry-13: nothing changed (pending)");
    eq(order("o-conf").status, "confirmed", "dry-14: nothing changed (confirmed)");
    eq(events("o-pend") + events("o-conf"), 0, "dry-15: no timeline rows written");
    ok(!JSON.stringify(r.body).includes("example.no") && !JSON.stringify(r.body).includes("Kari"), "dry-16: no buyer data in the response");

    // ── apply ────────────────────────────────────────────────────────────────
    const trustBefore = trustCount();
    r = await post({ ...base, dry_run: false });
    await new Promise((res) => setTimeout(res, 20)); // let any stray fire-and-forget mail run
    eq(r.status, 200, "apply-01: 200");
    eq(r.body?.dry_run, false, "apply-02: dry_run false");
    m = byId(r.body);
    eq(m["o-pend"]?.result, "closed", "apply-03: pending -> closed");
    eq(m["o-conf"]?.result, "closed", "apply-04: confirmed -> closed");
    eq(r.body?.counts?.closed, 3, "apply-05: counts.closed = 3");
    eq(order("o-pend").status, "cancelled", "apply-06: status cancelled");
    eq(order("o-pend").cancel_reason, "legacy_cleanup", "apply-07: cancel_reason legacy_cleanup");
    eq(order("o-conf").cancel_reason, "legacy_cleanup", "apply-08: confirmed order too");
    ok(order("o-pend").updated_at > OLD, "apply-09: updated_at moved to now");
    eq(events("o-pend"), 1, "apply-10: one timeline row");
    const ev = db.prepare("SELECT from_status, to_status, actor_role, channel, idempotency_key FROM order_events WHERE order_id = 'o-conf'").get() as any;
    eq(ev?.from_status, "confirmed", "apply-11: timeline from_status");
    eq(ev?.to_status, "cancelled", "apply-12: timeline to_status");
    eq(ev?.actor_role, "admin", "apply-13: timeline actor_role admin");
    eq(ev?.idempotency_key, "legacy_cleanup", "apply-14: timeline carries the reason");
    eq(mailCalls, 0, "apply-15: no e-mail sent");
    eq(trustCount(), trustBefore, "apply-16: no trust_events row (trust score unchanged)");
    eq(payStatus("o-paid"), "authorized", "apply-17: open payment untouched");
    eq(order("o-paid").status, "pending", "apply-18: order with open payment untouched");
    eq(payStatus("o-paidfinal"), "expired", "apply-19: final payment untouched");
    eq(order("o-ready").status, "ready", "apply-20: ready order untouched");
    eq(order("o-new").status, "pending", "apply-21: too-new order untouched");

    // ── second apply: idempotent ─────────────────────────────────────────────
    r = await post({ ...base, order_ids: ["o-pend", "o-conf"], dry_run: false });
    m = byId(r.body);
    eq(m["o-pend"]?.reason, "already_closed", "idem-01: second apply -> already_closed");
    eq(r.body?.counts?.closed, 0, "idem-02: counts.closed = 0");
    eq(events("o-pend"), 1, "idem-03: no extra timeline row");
    eq(mailCalls, 0, "idem-04: still no e-mail");

    // ── the 30-day contact sweep picks the closed order up ───────────────────
    const closedAt = new Date(order("o-pend").updated_at.replace(" ", "T") + "Z").getTime();
    const early = sweepMod.sweepExpiredCartContactData(30, new Date(closedAt + 29 * 86400e3), true);
    ok(!early.sweptOrderIds.includes("o-pend"), "sweep-01: not swept before 30 days");
    const late = sweepMod.sweepExpiredCartContactData(30, new Date(closedAt + 31 * 86400e3), false);
    ok(late.sweptOrderIds.includes("o-pend") && late.sweptOrderIds.includes("o-conf"), "sweep-02: swept after 30 days");
    eq(order("o-pend").buyer_email, null, "sweep-03: buyer contact nulled");
    ok(!late.sweptOrderIds.includes("o-paid"), "sweep-04: skipped open-payment order not swept");
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    es.sendEmail = origSendEmail;
    if (typeof origSendRaw === "function") es.sendRaw = origSendRaw;
    receiptMod.__setBuyerReceiptSendForTesting(null);
    notifyMod.__setOrderNotifySendForTesting(null);
    adminOrdersMod.__setAdminOrdersTestDb(null);
    sweepMod.__setCartContactSweepTestDb(null);
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }
  if (opts.log) { console.log(`passed ${passed} failed ${failed}`); for (const f of failures) console.log(f); }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminOrdersCloseStaleTests({ log: true }).then((r) => process.exit(r.failed ? 1 : 0));
}
