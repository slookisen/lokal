/**
 * owner-orders-t12-kansellering.test.ts — dev-request 2026-10-30-rfb-
 * eierportal-testrunde-1, slice T12 (punkt 6: kansellering og oversikt), AC 8.
 *
 * No network, no real e-mail, no production DB: a fresh in-memory SQLite with
 * the real production schema and an in-process server with the real routers
 * («Mine ordrer», the compact page /produsent/ordre/:token/kompakt and the old
 * order page /produsent/ordre/:token).
 *
 *   sql-*      orders.cancel_detail exists (nullable TEXT), the migration is
 *              idempotent, and every new SQL fragment runs on the real schema.
 *   page-*     confirmed: «Hentet» then right under it «Kanseller bestillingen …»
 *              with the four reasons; pending: «Bekreft», «Avslå», «Avslå –
 *              utsolgt», «Kunden har avbestilt» — on all three pages.
 *   act-*      each choice on each page → the right status, cancel_reason and
 *              cancel_detail; «Varen er utsolgt» marks the items out of stock.
 *   pend-*     «Kunden har avbestilt» on pending → buyer_cancelled, never
 *              declined / order_declined.
 *   noshow-*   «Kunden kom ikke» follows noShowEarliestMs (locked with «Kan
 *              registreres fra …», POST refused, then allowed).
 *   text-*     the choose line and the banner follow ORDER_BUYER_RECEIPTS_ENABLED.
 *   off-*      off the allowlist the three pages are byte-identical (with and
 *              without the env set) and the new actions are refused.
 *   rcpt-*     the buyer receipt is unchanged without cancel_detail or with
 *              ORDER_CANCEL_DETAIL_RECEIPT_ENABLED off (pakke C).
 *   ov-*       the overview counts per Oslo month (DST, year end), never another
 *              producer's order, and renders the spec texts.
 *   layer-*    applyOrderAction validates cancelDetail.
 *
 * Standalone: npx tsx src/routes/owner-orders-t12-kansellering.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerOrdersT12Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const actionsSvc = require("../services/order-actions") as typeof import("../services/order-actions");
  const view = require("./owner-orders-view") as typeof import("./owner-orders-view");
  const texts = require("../owner-features/order-texts") as typeof import("../owner-features/order-texts");

  const ENV_KEYS = [
    "OWNER_FEATURES_ALLOWED_SUBJECTS", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_CANCEL_DETAIL_RECEIPT_ENABLED",
    "ORDER_AUTOCOMPLETE_ENABLED", "ORDER_AUTOCOMPLETE_SINCE", "PAYMENTS_ENABLED", "ORDER_NO_SHOW_MIN_HOURS",
    "ORDER_AGENT_ACTIONS_ENABLED", "ORDER_MESSAGES_ENABLED", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "STOCK_SOFT_EXPIRY_ENABLED",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const sent: Array<{ to: string; subject: string; text: string }> = [];

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    actionsSvc.__setOrderActionsTestDb(db as any);
    receiptSvc.__setBuyerReceiptSendForTesting(async (o: any) => {
      sent.push({ to: String(o.to), subject: String(o.subject), text: String(o.textContent) });
      return { success: true, messageId: "stub" };
    });
    for (const k of ENV_KEYS) delete process.env[k];
    const ALLOW = "rfb:ag-t12";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;
    // B2b-1's rule on (the sold-out write's gate); the «rule off» block turns it off.
    process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";

    // ════════════════════════════════════════════════════════════════════════
    // SQL: the column and the migration
    // ════════════════════════════════════════════════════════════════════════
    {
      const cols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
      const c = cols.find((x) => x.name === "cancel_detail");
      assertTrue(!!c, "sql-01: orders.cancel_detail exists after the schema init");
      assertEq(c ? { type: c.type, notnull: c.notnull, dflt: c.dflt_value } : null, { type: "TEXT", notnull: 0, dflt: null }, "sql-02: cancel_detail is a nullable TEXT without default");
      const db2 = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(db2 as any);
        initMod.__initSchemaForTesting(db2 as any);
        const n = (db2.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).filter((x) => x.name === "cancel_detail").length;
        assertEq(n, 1, "sql-03: the migration is idempotent (schema init twice → one column, no error)");
      } finally {
        db2.close();
        initMod.__setDbForTesting(db as any);
      }
      // Every SQL fragment T12 adds, prepared against the real schema.
      for (const [label, sql] of [
        ["transition write", "UPDATE orders SET cancel_detail = ? WHERE id = ?"],
        ["receipt read", "SELECT o.id, o.cancel_reason, o.cancel_detail FROM orders o INNER JOIN agents a ON a.id = o.agent_id LEFT JOIN carts c ON c.id = o.cart_id WHERE o.id = ?"],
        ["overview read", "SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS h FROM orders WHERE agent_id = ? AND datetime(created_at) >= ? AND datetime(created_at) < ?"],
      ] as const) {
        let ok = true;
        try { db.prepare(sql); } catch { ok = false; }
        assertTrue(ok, `sql-04: the ${label} SQL prepares on the production schema`);
      }
    }

    // ── Seed: two producers (one on the allowlist), sessions ───────────────
    for (const [id, name] of [["ag-t12", "Gård T12"], ["ag-t12x", "Gård Utenfor"]] as const) {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories)
                  VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]')`)
        .run(id, name, `${id}@example.no`, `k-${id}`);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, '+47 400 00 000')").run(id, `${id}@example.no`);
    }
    function session(agentId: string, token: string): string {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES (?, ?, ?, ?, 1, datetime('now', '+1 day'))")
        .run(`ml-${token}`, `${agentId}@example.no`, token, agentId);
      return `rfb_owner_session=${token}`;
    }
    const COOKIE_A = session("ag-t12", "sess-token-t12");
    const COOKIE_X = session("ag-t12x", "sess-token-t12x");

    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const ago = (h: number) => new Date(Date.now() - h * 3600_000);
    let seq = 0;
    function seedOrder(o: {
      agent?: string; status: string; pickupInH?: number | null; confirmedAgoH?: number; product?: boolean; createdAt?: string; buyerName?: string;
    }): string {
      const id = `t12-order-${++seq}`;
      const agent = o.agent ?? "ag-t12";
      const created = o.createdAt ?? SQL(ago(30));
      const pickup = o.pickupInH === undefined ? new Date(Date.now() - 3600_000).toISOString()
        : o.pickupInH === null ? null : new Date(Date.now() + o.pickupInH * 3600_000).toISOString();
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                            notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pickup', ?, ?, 90, NULL, ?, ?, ?, ?, ?)
      `).run(id, agent, `bref_${id}`, o.status, `ctok_${id}`, pickup, created, o.buyerName ?? `Kunde ${seq}`, "kari.t12@example.com", created, created);
      let productId: string | null = null;
      if (o.product) {
        productId = `prod-${id}`;
        db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
                    VALUES (?, ?, ?, ?, 45, 'kg', 'in_stock', 'vegetables', 'producer_dashboard', ?)`)
          .run(productId, agent, `Poteter ${seq}`, `poteter ${seq}`, SQL(ago(1)));
      }
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, ?, 'Poteter', 2, 45, 90)")
        .run(`${id}-i1`, id, productId);
      if (o.status !== "pending") {
        db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, created_at)
                    VALUES (?, ?, 'pending', 'confirmed', 'producer', 'seller', 'producer_page', ?)`)
          .run(`${id}-e1`, id, SQL(ago(o.confirmedAgoH ?? 20)));
      }
      return id;
    }
    const row = (id: string) => db.prepare("SELECT status, cancel_reason, cancel_detail FROM orders WHERE id = ?").get(id) as any;
    const availability = (id: string) => (db.prepare("SELECT availability FROM products WHERE id = ?").get(`prod-${id}`) as any)?.availability;
    const trust = (id: string) => (db.prepare("SELECT event_type FROM trust_events WHERE ref = ? ORDER BY rowid").all(id) as any[]).map((r) => r.event_type);
    const events = (id: string) => (db.prepare("SELECT to_status FROM order_events WHERE order_id = ? AND id NOT LIKE '%-e1' ORDER BY created_at, rowid").all(id) as any[]).map((r) => r.to_status);

    // ── In-process server ──────────────────────────────────────────────────
    {
      const express = require("express");
      const ownerOrders = require("./owner-orders") as typeof import("./owner-orders");
      const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
      const cartRoutes = require("./marketplace-cart") as typeof import("./marketplace-cart");
      // A shared limiter (300 per 15 min per client): start from zero, as the other suites share it.
      await ownerOrders.ownerOrdersLimiter.resetKey("127.0.0.1");
      const app = express();
      app.use("/", ownerPortal.default);
      app.use("/", ownerOrders.default);
      app.use("/produsent/ordre", cartRoutes.producerOrderRouter);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; form?: Record<string, string | string[]> } = {}):
      Promise<{ status: number; text: string; location: string | undefined }> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) {
          const sp = new URLSearchParams();
          for (const [k, v] of Object.entries(o.form)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
          bodyStr = sp.toString();
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({
            status: resp.statusCode || 0, text: Buffer.concat(chunks).toString("utf8"),
            location: resp.headers["location"] as string | undefined,
          }));
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const settle = () => new Promise((r) => setTimeout(r, 30));
    function rowHtml(page: string, id: string): string {
      const start = page.indexOf(`<details class="mo-row" id="o-${id}"`);
      if (start < 0) return "";
      const end = page.indexOf("\n</details>", start);
      return page.slice(start, end < 0 ? undefined : end);
    }

    /** The three pages of one order, each as { name, html of the order's actions, post(form) }. */
    type Page = { name: string; get: (id: string) => Promise<string>; post: (id: string, form: Record<string, string | string[]>) => Promise<{ status: number; location: string | undefined }> };
    const PAGES: Page[] = [
      {
        name: "Mine ordrer",
        get: async (id) => {
          const st = row(id).status;
          const tab = st === "pending" ? "venter" : st === "confirmed" || st === "ready" ? "kommende" : "avsluttet";
          return rowHtml((await req("GET", `/eier/ag-t12/ordrer?tab=${tab}`, { headers: { Cookie: COOKIE_A } })).text, id);
        },
        post: (id, form) => req("POST", `/eier/ag-t12/ordrer/${id}`, { headers: { Cookie: COOKIE_A }, form }),
      },
      {
        name: "kompaktsiden",
        get: async (id) => (await req("GET", `/produsent/ordre/ctok_${id}/kompakt`)).text,
        post: (id, form) => req("POST", `/produsent/ordre/ctok_${id}/kompakt`, { form }),
      },
      {
        name: "den gamle ordresiden",
        get: async (id) => (await req("GET", `/produsent/ordre/ctok_${id}`)).text,
        post: (id, form) => req("POST", `/produsent/ordre/ctok_${id}`, { form }),
      },
    ];
    const has = (html: string, action: string, label: string) =>
      new RegExp(`<input type="hidden" name="action" value="${action}">[\\s\\S]*?>${label}</button>`).test(html);

    // ════════════════════════════════════════════════════════════════════════
    // Confirmed: «Hentet», then «Kanseller bestillingen …» with four reasons
    // ════════════════════════════════════════════════════════════════════════
    for (const p of PAGES) {
      const id = seedOrder({ status: "confirmed", product: true });
      const h = await p.get(id);
      assertTrue(has(h, "complete", "Hentet"), `page-01: «Hentet» on a confirmed order (${p.name})`);
      const iHentet = h.indexOf('value="complete"');
      const iSummary = h.indexOf("<summary>Kanseller bestillingen …</summary>");
      assertTrue(iSummary > iHentet && iHentet >= 0, `page-02: «Kanseller bestillingen …» right under «Hentet» (${p.name})`);
      const menu = h.slice(iSummary);
      assertTrue(has(menu, "cancel_sold_out", "Varen er utsolgt") && has(menu, "cancel_cannot_deliver", "Jeg kan ikke levere likevel") &&
        has(menu, "buyer_cancelled", "Kunden har avbestilt") && has(menu, "no_show", "Kunden kom ikke"),
        `page-03: the four reasons inside the disclosure (${p.name})`);
      assertTrue(menu.includes(`name="sold_out" value="prod-${id}" checked`), `page-04: «Varen er utsolgt» lists the order's items, ticked (${p.name})`);
      assertTrue(!h.includes("Flere valg") && !h.includes(">Kan ikke levere<") && !h.includes("Jeg kan ikke levere – kanseller"), `page-05: today's buttons are replaced (${p.name})`);
    }

    // Pending: «Bekreft», «Avslå», «Avslå – utsolgt», «Kunden har avbestilt»
    for (const p of PAGES) {
      const id = seedOrder({ status: "pending", product: true });
      const h = await p.get(id);
      assertTrue(has(h, "confirm", "Bekreft") && has(h, "decline", "Avslå") && has(h, "decline_sold_out", "Avslå – utsolgt") && has(h, "buyer_cancelled", "Kunden har avbestilt"),
        `page-06: pending shows «Bekreft», «Avslå», «Avslå – utsolgt», «Kunden har avbestilt» (${p.name})`);
      assertTrue(!h.includes("Kanseller bestillingen") && !h.includes('value="complete"'), `page-07: no «Hentet» and no «Kanseller bestillingen …» before confirmation (${p.name})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Every choice on every page → status, cancel_reason, cancel_detail
    // ════════════════════════════════════════════════════════════════════════
    const CHOICES: Array<{ action: string; expect: { status: string; cancel_reason: string | null; cancel_detail: string | null }; soldOut: boolean }> = [
      { action: "cancel_sold_out", expect: { status: "cancelled", cancel_reason: "producer_cancelled", cancel_detail: "sold_out" }, soldOut: true },
      { action: "cancel_cannot_deliver", expect: { status: "cancelled", cancel_reason: "producer_cancelled", cancel_detail: "cannot_deliver" }, soldOut: false },
      { action: "buyer_cancelled", expect: { status: "cancelled", cancel_reason: "buyer_cancelled", cancel_detail: null }, soldOut: false },
      { action: "no_show", expect: { status: "cancelled", cancel_reason: "no_show", cancel_detail: null }, soldOut: false },
      { action: "complete", expect: { status: "completed", cancel_reason: null, cancel_detail: null }, soldOut: false },
    ];
    for (const p of PAGES) {
      for (const c of CHOICES) {
        const id = seedOrder({ status: "confirmed", product: true });
        const r = await p.post(id, { action: c.action, idem: `t12-${seq}-abcdef`, ...(c.soldOut ? { sold_out: `prod-${id}` } : {}) });
        await settle();
        assertTrue(r.status === 303 && new RegExp(`done=${c.expect.status}`).test(r.location || ""), `act-01: ${c.action} → 303 done=${c.expect.status} (${p.name})`);
        assertEq(row(id), c.expect, `act-02: ${c.action} → the right status, cancel_reason and cancel_detail (${p.name})`);
        assertEq(availability(id), c.soldOut ? "out_of_stock" : "in_stock", `act-03: items out of stock only for «Varen er utsolgt» (${p.name}, ${c.action})`);
      }
    }
    // «Varen er utsolgt» with no item ticked: cancelled with the detail, nothing marked.
    {
      const id = seedOrder({ status: "confirmed", product: true });
      await PAGES[0]!.post(id, { action: "cancel_sold_out" });
      await settle();
      assertTrue(row(id).cancel_detail === "sold_out" && availability(id) === "in_stock", "act-04: «Varen er utsolgt» with no item ticked → sold_out detail, no stock write");
      const audit = db.prepare("SELECT notes FROM agent_knowledge_audit WHERE notes LIKE '%T12 «Varen er utsolgt»%'").all() as any[];
      assertTrue(audit.length >= 3, "act-05: the stock write has an audit row naming the cancellation");
    }
    // Pending: «Avslå – utsolgt» (soft expiry OFF) and «Avslå»
    for (const p of PAGES) {
      const a = seedOrder({ status: "pending", product: true });
      await p.post(a, { action: "decline_sold_out", sold_out: `prod-${a}` });
      const b = seedOrder({ status: "pending", product: true });
      await p.post(b, { action: "decline" });
      await settle();
      assertEq([row(a), availability(a)], [{ status: "declined", cancel_reason: null, cancel_detail: null }, "out_of_stock"], `act-06: «Avslå – utsolgt» → declined + items out of stock (${p.name})`);
      assertEq([row(b), availability(b)], [{ status: "declined", cancel_reason: null, cancel_detail: null }, "in_stock"], `act-07: «Avslå» → declined, no stock write (${p.name})`);
    }

    // B2b-1's rule off: no «Avslå – utsolgt», «Varen er utsolgt» cancels without a stock write.
    delete process.env.STOCK_SOFT_EXPIRY_ENABLED;
    for (const p of PAGES) {
      const pend = seedOrder({ status: "pending", product: true });
      const ph = await p.get(pend);
      assertTrue(!ph.includes("Avslå – utsolgt") && has(ph, "decline", "Avslå") && has(ph, "buyer_cancelled", "Kunden har avbestilt"),
        `rule-01: rule off → no «Avslå – utsolgt» (as B2b-1), the other pending buttons stay (${p.name})`);
      const r0 = await p.post(pend, { action: "decline_sold_out", sold_out: `prod-${pend}` });
      await settle();
      assertTrue(/error=ugyldig/.test(r0.location || "") && row(pend).status === "pending", `rule-02: rule off → decline_sold_out refused as before (${p.name})`);
      const conf = seedOrder({ status: "confirmed", product: true });
      const ch = await p.get(conf);
      assertTrue(has(ch, "cancel_sold_out", "Varen er utsolgt") && !ch.includes('name="sold_out"'), `rule-03: rule off → «Varen er utsolgt» without item boxes (${p.name})`);
      await p.post(conf, { action: "cancel_sold_out", sold_out: `prod-${conf}` });
      await settle();
      assertEq([row(conf), availability(conf)], [{ status: "cancelled", cancel_reason: "producer_cancelled", cancel_detail: "sold_out" }, "in_stock"],
        `rule-04: rule off → «Varen er utsolgt» cancels with sold_out, items untouched (${p.name})`);
    }
    process.env.STOCK_SOFT_EXPIRY_ENABLED = "1";

    // ════════════════════════════════════════════════════════════════════════
    // «Kunden har avbestilt» on a pending order is not a decline
    // ════════════════════════════════════════════════════════════════════════
    for (const p of PAGES) {
      const id = seedOrder({ status: "pending" });
      const r = await p.post(id, { action: "buyer_cancelled" });
      await settle();
      assertTrue(/done=cancelled/.test(r.location || ""), `pend-01: «Kunden har avbestilt» on pending → done=cancelled (${p.name})`);
      assertEq(row(id), { status: "cancelled", cancel_reason: "buyer_cancelled", cancel_detail: null }, `pend-02: buyer_cancelled, no detail (${p.name})`);
      assertTrue(!trust(id).includes("order_declined") && !events(id).includes("declined"), `pend-03: no order_declined trust event, no declined transition (${p.name})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // «Kunden kom ikke» follows noShowEarliestMs
    // ════════════════════════════════════════════════════════════════════════
    for (const p of PAGES) {
      const future = seedOrder({ status: "confirmed", pickupInH: 5 });
      const h = await p.get(future);
      const menu = h.slice(h.indexOf("<summary>Kanseller bestillingen …</summary>"));
      assertTrue(!has(menu, "no_show", "Kunden kom ikke") && /<button type="button" class="[^"]*" disabled>Kunden kom ikke<\/button>/.test(menu) && menu.includes("Kan registreres fra "),
        `noshow-01: pickup in the future → «Kunden kom ikke» disabled with «Kan registreres fra …» (${p.name})`);
      const r = await p.post(future, { action: "no_show" });
      await settle();
      assertTrue(/error=ugyldig/.test(r.location || "") && row(future).status === "confirmed", `noshow-02: POST before the pickup time → refused, order unchanged (${p.name})`);
      // No pickup time: confirmation + ORDER_NO_SHOW_MIN_HOURS (default 3).
      const early = seedOrder({ status: "confirmed", pickupInH: null, confirmedAgoH: 1 });
      const late = seedOrder({ status: "confirmed", pickupInH: null, confirmedAgoH: 4 });
      assertTrue((await p.get(early)).includes("Kan registreres fra "), `noshow-03: no pickup time, confirmed 1 h ago → locked (${p.name})`);
      assertTrue(has(await p.get(late), "no_show", "Kunden kom ikke"), `noshow-04: no pickup time, confirmed 4 h ago → offered (${p.name})`);
      await p.post(late, { action: "no_show" });
      await settle();
      assertEq(row(late).cancel_reason, "no_show", `noshow-05: …and recorded (${p.name})`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Texts follow ORDER_BUYER_RECEIPTS_ENABLED
    // ════════════════════════════════════════════════════════════════════════
    for (const on of [false, true]) {
      if (on) process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1"; else delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
      const lineOn = "Velg hvorfor. Kunden får beskjed med en gang.";
      const lineOff = "Velg hvorfor. Gi kunden beskjed selv.";
      const bannerOn = "Bestillingen er kansellert. Kunden har fått beskjed.";
      const bannerOff = "Bestillingen er kansellert. Husk å gi kunden beskjed.";
      for (const p of PAGES) {
        const id = seedOrder({ status: "confirmed" });
        const h = await p.get(id);
        assertTrue(h.includes(on ? lineOn : lineOff) && !h.includes(on ? lineOff : lineOn), `text-01: the choose line with receipts ${on ? "on" : "off"} (${p.name})`);
        const r = await p.post(id, { action: "cancel_cannot_deliver" });
        await settle();
        const after = await req("GET", (r.location || "").replace(/#.*/, ""), p.name === "Mine ordrer" ? { headers: { Cookie: COOKIE_A } } : {});
        assertTrue(after.text.includes(on ? bannerOn : bannerOff), `text-02: the banner after a cancellation with receipts ${on ? "on" : "off"} (${p.name})`);
      }
    }
    delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;

    // ════════════════════════════════════════════════════════════════════════
    // Off the allowlist: byte-identical pages, new actions refused
    // ════════════════════════════════════════════════════════════════════════
    {
      // Random form keys and the «now» of the pickup field are the only parts that vary per render.
      const norm = (s: string) => s.replace(/name="idem" value="[^"]+"/g, 'name="idem" value="X"').replace(/min="[0-9T:-]+"/g, 'min="X"');
      const xs = {
        pending: seedOrder({ agent: "ag-t12x", status: "pending", product: true }),
        confirmed: seedOrder({ agent: "ag-t12x", status: "confirmed", product: true }),
        future: seedOrder({ agent: "ag-t12x", status: "confirmed", pickupInH: 5 }),
      };
      const pagesX = async () => {
        const out: string[] = [];
        for (const tab of ["venter", "kommende", "avsluttet"]) out.push((await req("GET", `/eier/ag-t12x/ordrer?tab=${tab}`, { headers: { Cookie: COOKIE_X } })).text);
        for (const id of Object.values(xs)) {
          out.push((await req("GET", `/produsent/ordre/ctok_${id}/kompakt?done=cancelled`)).text);
          out.push((await req("GET", `/produsent/ordre/ctok_${id}?done=cancelled`)).text);
        }
        out.push((await req("GET", `/eier/ag-t12x/ordrer?tab=avsluttet&done=cancelled`, { headers: { Cookie: COOKIE_X } })).text);
        return out.map(norm);
      };
      const withList = await pagesX();
      delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
      const without = await pagesX();
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ALLOW;
      assertEq(withList, without, "off-01: a producer off the allowlist gets byte-identical pages whether or not the allowlist is set");
      const all = withList.join("\n");
      assertTrue(!all.includes("Kanseller bestillingen") && !all.includes("Bestillinger gjennom Rett fra Bonden") && !all.includes("data-t12-actions") &&
        !all.includes("Bestillingen er kansellert."), "off-02: no T12 component, overview or banner text off the list");
      assertTrue(all.includes("Flere valg") && all.includes(">Kan ikke levere<") && all.includes("Kanseller ordren …") && all.includes("Jeg kan ikke levere – kanseller"),
        "off-03: today's buttons stay off the list («Flere valg», «Kan ikke levere», «Kanseller ordren …»)");
      for (const [label, post] of [
        ["Mine ordrer", (id: string, f: Record<string, string>) => req("POST", `/eier/ag-t12x/ordrer/${id}`, { headers: { Cookie: COOKIE_X }, form: f })],
        ["kompaktsiden", (id: string, f: Record<string, string>) => req("POST", `/produsent/ordre/ctok_${id}/kompakt`, { form: f })],
        ["den gamle ordresiden", (id: string, f: Record<string, string>) => req("POST", `/produsent/ordre/ctok_${id}`, { form: f })],
      ] as const) {
        for (const a of ["cancel_sold_out", "cancel_cannot_deliver"]) {
          const id = seedOrder({ agent: "ag-t12x", status: "confirmed", product: true });
          const r = await post(id, { action: a, sold_out: `prod-${id}` });
          await settle();
          assertTrue(/error=ugyldig/.test(r.location || "") && row(id).status === "confirmed" && availability(id) === "in_stock", `off-04: ${a} refused off the list (${label})`);
        }
        const d = seedOrder({ agent: "ag-t12x", status: "pending", product: true });
        const r = await post(d, { action: "decline_sold_out", sold_out: `prod-${d}` });
        await settle();
        assertTrue(/error=ugyldig/.test(r.location || "") && row(d).status === "pending" && availability(d) === "in_stock", `off-05: decline_sold_out stays unknown off the list (${label})`);
      }
      // Today's cancellation off the list writes no cancel_detail.
      const legacy = seedOrder({ agent: "ag-t12x", status: "confirmed" });
      await req("POST", `/produsent/ordre/ctok_${legacy}`, { form: { action: "cancel_producer" } });
      await settle();
      assertEq(row(legacy), { status: "cancelled", cancel_reason: "producer_cancelled", cancel_detail: null }, "off-06: today's «Jeg kan ikke levere – kanseller» → no cancel_detail");
    }

    // ════════════════════════════════════════════════════════════════════════
    // The buyer's cancellation receipt (pakke C behind its own switch)
    // ════════════════════════════════════════════════════════════════════════
    {
      const base: import("../services/order-receipt-service").ReceiptData = {
        orderRef: "abcd1234", producerName: "Gård T12",
        contact: { address: null, phone: null, email: null, profile_url: "https://rettfrabonden.com/p/x" } as any,
        traderStatus: "trader", items: [{ name: "Poteter", qty: 2, line_total: 90 }], totalNok: 90,
        cancelReason: "producer_cancelled", payment: null,
      };
      const legacy = receiptSvc.renderBuyerReceipt("cancelled", base)!;
      assertTrue(legacy.text.includes("Gård T12 har kansellert bestillingen fordi den ikke kan leveres."), "rcpt-01: today's reason sentence without cancel_detail");
      assertEq(receiptSvc.renderBuyerReceipt("cancelled", { ...base, cancelDetail: null }), legacy, "rcpt-02: cancelDetail null → byte-identical receipt");
      assertEq(receiptSvc.renderBuyerReceipt("cancelled", { ...base, cancelDetail: "cannot_deliver" }), legacy, "rcpt-03: cannot_deliver → today's sentence");
      const so = receiptSvc.renderBuyerReceipt("cancelled", { ...base, cancelDetail: "sold_out" })!;
      assertTrue(so.text.includes("Gård T12 har kansellert bestillingen fordi varen er utsolgt.") && so.subject === legacy.subject, "rcpt-04: sold_out → the pakke C sentence (renderer only)");

      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      for (const flag of [false, true]) {
        if (flag) process.env.ORDER_CANCEL_DETAIL_RECEIPT_ENABLED = "1"; else delete process.env.ORDER_CANCEL_DETAIL_RECEIPT_ENABLED;
        sent.length = 0;
        const id = seedOrder({ status: "confirmed" });
        await PAGES[0]!.post(id, { action: "cancel_sold_out" });
        await settle();
        const mail = sent.filter((m) => m.subject.startsWith("Bestillingen er kansellert")).pop();
        assertTrue(!!mail, `rcpt-05: a receipt is sent for the cancellation (detail switch ${flag ? "on" : "off"})`);
        assertEq(!!mail && mail.text.includes("fordi varen er utsolgt."), flag, `rcpt-06: the sold-out sentence only with ORDER_CANCEL_DETAIL_RECEIPT_ENABLED=1 (${flag ? "on" : "off"})`);
        assertEq(!!mail && mail.text.includes("fordi den ikke kan leveres."), !flag, `rcpt-07: switch off → today's sentence byte for byte (${flag ? "on" : "off"})`);
      }
      delete process.env.ORDER_CANCEL_DETAIL_RECEIPT_ENABLED;
      delete process.env.ORDER_BUYER_RECEIPTS_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════════
    // The overview: per Oslo month, this producer only
    // ════════════════════════════════════════════════════════════════════════
    {
      const ovDb = new Database(":memory:");
      try {
        initMod.__initSchemaForTesting(ovDb as any);
        initMod.__setDbForTesting(db as any);
        let n = 0;
        const add = (agent: string, createdAt: string, status = "pending") =>
          ovDb.prepare("INSERT INTO orders (id, agent_id, buyer_ref, status, created_at, updated_at) VALUES (?, ?, 'b', ?, ?, ?)")
            .run(`ov-${++n}`, agent, status, createdAt, createdAt);

        // November 2026 (CET, UTC+1): starts 2026-10-31 23:00 UTC, ends 2026-11-30 23:00 UTC.
        add("p1", "2026-10-31 22:59:59");                // Oslo 31.10 23:59:59 → October
        add("p1", "2026-10-31 23:00:00", "completed");   // Oslo 01.11 00:00 → November
        add("p1", "2026-11-15T10:00:00.000Z");           // ISO format → November
        add("p1", "2026-11-30 22:59:59", "completed");   // Oslo 30.11 23:59:59 → November
        add("p1", "2026-11-30 23:00:00");                // Oslo 01.12 → December
        add("p1", "2026-09-10 10:00:00", "completed");   // earlier
        add("p2", "2026-11-10 10:00:00", "completed");   // another producer
        add("p2", "2026-11-11 10:00:00");
        const nov = view.getOwnerOrderOverview("p1", new Date("2026-11-15T12:00:00Z"), ovDb);
        assertEq(nov, { monthName: "november", month: { received: 3, pickedUp: 2 }, total: { received: 6, pickedUp: 3 } },
          "ov-01: November in Oslo time — boundaries at 23:00 UTC, ISO and SQLite timestamps, total since start");
        const nov1 = view.getOwnerOrderOverview("p1", new Date("2026-10-31T23:30:00Z"), ovDb);
        assertEq(nov1.monthName + ":" + nov1.month.received, "november:3", "ov-02: 31.10 23:30 UTC is already November in Oslo (the November orders count)");
        const oct = view.getOwnerOrderOverview("p1", new Date("2026-10-31T22:30:00Z"), ovDb);
        assertEq([oct.monthName, oct.month.received], ["oktober", 1], "ov-03: 31.10 22:30 UTC is still October in Oslo");
        const p2 = view.getOwnerOrderOverview("p2", new Date("2026-11-15T12:00:00Z"), ovDb);
        assertEq(p2, { monthName: "november", month: { received: 2, pickedUp: 1 }, total: { received: 2, pickedUp: 1 } }, "ov-04: never another producer's orders");
        assertEq(view.getOwnerOrderOverview("nobody", new Date("2026-11-15T12:00:00Z"), ovDb).total, { received: 0, pickedUp: 0 }, "ov-05: a producer without orders → zeros");

        // Summer time (CEST, UTC+2) and the DST month March 2027 (switch 28.03).
        assertEq(view.osloMonthBoundsUtc(new Date("2026-07-10T12:00:00Z")), { start: "2026-06-30 22:00:00", end: "2026-07-31 22:00:00", ym: "2026-07" }, "ov-06: July (CEST) bounds");
        assertEq(view.osloMonthBoundsUtc(new Date("2027-03-15T12:00:00Z")), { start: "2027-02-28 23:00:00", end: "2027-03-31 22:00:00", ym: "2027-03" }, "ov-07: March 2027 starts in CET and ends in CEST");
        assertEq(view.osloMonthBoundsUtc(new Date("2026-10-15T12:00:00Z")), { start: "2026-09-30 22:00:00", end: "2026-10-31 23:00:00", ym: "2026-10" }, "ov-08: October 2026 starts in CEST and ends in CET");
        const ye = view.osloMonthBoundsUtc(new Date("2026-12-31T23:30:00Z"));
        assertEq(ye, { start: "2026-12-31 23:00:00", end: "2027-01-31 23:00:00", ym: "2027-01" }, "ov-09: 31.12 23:30 UTC is January 2027 in Oslo (year rollover)");
        add("p3", "2027-03-31 21:59:59", "completed");
        add("p3", "2027-03-31 22:00:00");
        const mar = view.getOwnerOrderOverview("p3", new Date("2027-03-20T12:00:00Z"), ovDb);
        const apr = view.getOwnerOrderOverview("p3", new Date("2027-04-02T12:00:00Z"), ovDb);
        assertEq([mar.monthName, mar.month, apr.monthName, apr.month], ["mars", { received: 1, pickedUp: 1 }, "april", { received: 1, pickedUp: 0 }],
          "ov-10: the end of March 2027 is 22:00 UTC (summer time)");
      } finally {
        ovDb.close();
      }

      // Texts
      assertEq(texts.ownerOverviewMonthLine("november", 4, 3), "I november: 4 bestillinger, 3 hentet", "ov-11: «I {måned}: {n} bestillinger, {h} hentet»");
      assertEq(texts.ownerOverviewTotalLine(12, 9), "Siden start: 12 bestillinger, 9 hentet", "ov-12: «Siden start: {n} bestillinger, {h} hentet»");
      const html = view.ownerOrderOverviewHtml({ monthName: "november", month: { received: 0, pickedUp: 0 }, total: { received: 0, pickedUp: 0 } });
      assertTrue(html.includes("Bestillinger gjennom Rett fra Bonden") && html.includes("Ingen bestillinger ennå. Når kunder bestiller gjennom Rett fra Bonden, ser du dem her."),
        "ov-13: no orders → the heading and the empty text");

      // On the page: real numbers from this producer at the top of «Mine ordrer».
      const page = (await req("GET", "/eier/ag-t12/ordrer?tab=avsluttet", { headers: { Cookie: COOKIE_A } })).text;
      const ov = view.getOwnerOrderOverview("ag-t12");
      const totalAll = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = 'ag-t12'").get() as any).n;
      const totalDone = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = 'ag-t12' AND status = 'completed'").get() as any).n;
      assertEq(ov.total, { received: totalAll, pickedUp: totalDone }, "ov-14: the page's numbers are the producer's real rows");
      const iOv = page.indexOf("Bestillinger gjennom Rett fra Bonden");
      assertTrue(iOv > 0 && iOv < page.indexOf('aria-label="Ordrer"') && page.includes(texts.ownerOverviewTotalLine(totalAll, totalDone)),
        "ov-15: the overview stands above the tabs with «Siden start: …»");
    }

    // ════════════════════════════════════════════════════════════════════════
    // The layer validates cancelDetail
    // ════════════════════════════════════════════════════════════════════════
    {
      const id = seedOrder({ status: "confirmed" });
      const seller = { role: "seller" as const, channel: "owner_portal" as const };
      const bad = await actionsSvc.applyOrderAction(id, "cannot_deliver", seller, { cancelDetail: "x" as any });
      assertTrue(!bad.success && bad.status === 400 && row(id).status === "confirmed", "layer-01: unknown cancelDetail → 400, nothing written");
      const wrong = await actionsSvc.applyOrderAction(id, "buyer_cancelled", seller, { cancelDetail: "sold_out" });
      assertTrue(!wrong.success && wrong.status === 400 && row(id).status === "confirmed", "layer-02: cancelDetail with another action → 400");
      const so = await actionsSvc.applyOrderAction(id, "cannot_deliver", seller, { soldOut: { productIds: [] } });
      assertTrue(!so.success && so.status === 400, "layer-03: soldOut on cannot_deliver needs cancelDetail sold_out");
      const ok = await actionsSvc.applyOrderAction(id, "cannot_deliver", seller, { cancelDetail: "cannot_deliver" });
      assertTrue(ok.success && row(id).cancel_detail === "cannot_deliver", "layer-04: cannot_deliver + cannotDeliver detail → stored in the same write");
      assertEq(actionsSvc.t12SellerActionFrom({ action: "cannot_deliver" }, "ag-t12"), null, "layer-05: the T12 map knows only the component's values");
      await settle();
    }
  } catch (err) {
    failed++;
    failures.push(`owner-orders-t12: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    try {
      const ownerOrders = require("./owner-orders") as typeof import("./owner-orders");
      await ownerOrders.ownerOrdersLimiter.resetKey("127.0.0.1");
    } catch { /* best-effort */ }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifyTestDb(null);
    receiptSvc.__setBuyerReceiptSendForTesting(null);
    receiptSvc.__setBuyerReceiptTestDb(null);
    actionsSvc.__setOrderActionsTestDb(null);
    cartSvc.__setCartTestDb(null);
    trustSvc.__setTrustEventTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* best-effort */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── owner-orders-t12-kansellering tests ──");
  runOwnerOrdersT12Tests({ log: true }).then((r) => {
    console.log(`\nowner-orders-t12-kansellering: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
