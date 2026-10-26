/**
 * buyer-order-actions-fase-b1.test.ts — dev-request 2026-10-21-rfb-mine-ordrer-
 * ett-klikk-og-kjoperagent, FASE B1 (kjøperens handlinger via MCP og ordrekort
 * på nett). No network, no real e-mail, no production DB: a fresh in-memory
 * SQLite with the real production schema, a real MCP client over
 * InMemoryTransport, an in-process server with the real order-card router.
 *
 *   AC6  lokal_order_cancel: pending → cancelled / buyer_cancelled, no trust
 *        event against the producer, producer e-mail; after confirmation the
 *        § 41 text; wrong buyer_ref → 403 (same answer as an unknown order).
 *   AC7  lokal_order_picked_up → completed, completion_source 'buyer'.
 *   + idempotency (same key twice → one transition), ORDER_AGENT_ACTIONS_ENABLED
 *     off → tools absent and calls refused, on → present; lokal_order_status
 *     B1 fields only with the switch on; the order card /ordre/:id (404 on a
 *     wrong ref, headers, PRG actions, Origin check); the receipt link.
 *
 * Standalone: npx tsx src/routes/buyer-order-actions-fase-b1.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runBuyerOrderActionsFaseB1Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const buyerSvc = require("../services/buyer-order-actions") as typeof import("../services/buyer-order-actions");

  const ENV_KEYS = [
    "ORDER_AGENT_ACTIONS_ENABLED", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED", "ORDER_AUTOCOMPLETE_SINCE",
    "PAYMENTS_ENABLED", "ADMIN_NOTIFICATION_EMAIL", "ORDER_NO_SHOW_MIN_HOURS",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const PRODUCER_MAIL = "gard-b1@example.no";
  const producerMail: Array<{ to: string; subject: string; textContent: string }> = [];
  const receipts: Array<{ to: string; subject: string; textContent: string }> = [];

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    actionsSvc.__setOrderActionsTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      producerMail.push({ to: o.to, subject: o.subject, textContent: o.textContent || "" });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async (o) => {
      receipts.push({ to: o.to, subject: o.subject, textContent: o.textContent || "" });
      return { success: true, messageId: "stub" };
    });
    for (const k of ENV_KEYS) delete process.env[k];

    // ── Seed ────────────────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, order_notifications_opt_in)
      VALUES ('ag-b1', 'Gård <B1>', 'Testprodusent', 'self', ?, 'https://example.no', 'producer', 'k-b1', '["vegetables"]', 1)
    `).run(PRODUCER_MAIL);
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES ('ag-b1', 'verified', ?, '+47 400 11 111')").run(PRODUCER_MAIL);
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, order_notifications_opt_in)
      VALUES ('ag-b1n', 'Hobbygård B1', 'Testprodusent', 'self', 'hobby-b1@example.no', 'https://example.no', 'producer', 'k-b1n', '["vegetables"]', 1)
    `).run();
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email) VALUES ('ag-b1n', 'verified', 'hobby-b1@example.no')").run();
    db.prepare("INSERT INTO producer_terms_acceptances (id, agent_id, terms_version, trader_status) VALUES ('pta-b1n', 'ag-b1n', 'v1', 'non_trader')").run();

    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    let seq = 0;
    function seedOrder(o: { status: string; agent?: string; notifySent?: boolean; paymentMode?: string | null; pickup?: string | null; completion?: string | null }): { id: string; ref: string } {
      const id = `b1${String(++seq).padStart(3, "0")}ord-order`; // unique 8-char order ref
      const ref = `bref_b1_${seq}_secret`;
      const created = SQL(new Date(Date.now() - 2 * 86_400_000));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                            notify_sent_at, completion_source, buyer_email, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pickup', ?, ?, 90, ?, ?, ?, 'kari.b1@example.com', ?, ?)
      `).run(id, o.agent ?? "ag-b1", ref, o.status, `ctok_${id}`, o.pickup ?? null, o.paymentMode ?? null,
        o.notifySent === false ? null : created, o.completion ?? null, created, created);
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 3, 30, 90)")
        .run(`${id}-i1`, id);
      if (o.status === "confirmed" || o.status === "ready") {
        db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, created_at)
                    VALUES (?, ?, 'pending', 'confirmed', 'producer', 'seller', 'producer_page', ?)`).run(`${id}-e1`, id, created);
      }
      return { id, ref };
    }
    const row = (id: string) => db.prepare("SELECT status, cancel_reason, completion_source FROM orders WHERE id = ?").get(id) as any;
    const buyerEvents = (id: string) => db.prepare("SELECT from_status, to_status, actor_role, channel, idempotency_key FROM order_events WHERE order_id = ? AND actor_role = 'buyer' ORDER BY created_at, rowid").all(id) as any[];
    const trustAgainst = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM trust_events WHERE ref = ? AND event_type IN ('order_declined','order_no_show')").get(id) as any).n as number;
    const trustAll = (id: string) => db.prepare("SELECT event_type FROM trust_events WHERE ref = ?").all(id).map((r: any) => r.event_type);
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const mailsFor = (orderId: string) => producerMail.filter((m) => m.subject.includes(orderId.slice(0, 8)));

    // ── MCP client over InMemoryTransport (registerTools reads the switch per session) ──
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    async function withMcp<T>(flagOn: boolean, fn: (client: any) => Promise<T>): Promise<T> {
      if (flagOn) process.env.ORDER_AGENT_ACTIONS_ENABLED = "1";
      else delete process.env.ORDER_AGENT_ACTIONS_ENABLED;
      const srv = new McpServer({ name: "rfb-b1-test", version: "0.0.0" });
      registerTools(srv);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "rfb-b1-test", version: "0.0.0" });
      await Promise.all([srv.connect(st), client.connect(ct)]);
      try { return await fn(client); }
      finally { await client.close(); await srv.close(); }
    }
    const json = (r: any) => JSON.parse(r?.content?.[0]?.text ?? "null");
    async function call(client: any, name: string, args: Record<string, unknown>): Promise<{ threw: boolean; isError: boolean; body: any }> {
      try {
        const r = await client.callTool({ name, arguments: args });
        let body: any = null;
        try { body = json(r); } catch { body = r?.content?.[0]?.text ?? null; }
        return { threw: false, isError: r?.isError === true, body };
      } catch {
        return { threw: true, isError: true, body: null };
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // The switch
    // ════════════════════════════════════════════════════════════════════════
    assertEq([undefined, "", "0", "false", "1", "true"].map((v) => buyerSvc.isOrderAgentActionsEnabled(v === undefined ? {} : { ORDER_AGENT_ACTIONS_ENABLED: v })),
      [false, false, false, false, true, true], "flag-01: ORDER_AGENT_ACTIONS_ENABLED is off by default; on with 1/true");

    {
      const o = seedOrder({ status: "pending" });
      await withMcp(false, async (client) => {
        const names = ((await client.listTools()).tools as any[]).map((t) => t.name);
        assertTrue(!names.includes("lokal_order_cancel") && !names.includes("lokal_order_picked_up") && names.includes("lokal_order_status"),
          "flag-02: switch off → lokal_order_cancel / lokal_order_picked_up are not in tools/list");
        const c = await call(client, "lokal_order_cancel", { order_id: o.id, buyer_ref: o.ref });
        const p = await call(client, "lokal_order_picked_up", { order_id: o.id, buyer_ref: o.ref });
        assertTrue((c.threw || c.isError) && (p.threw || p.isError), "flag-03: switch off → calling the tools is refused");
        assertEq(row(o.id).status, "pending", "flag-04: switch off → the refused call changed nothing");
        const s = await call(client, "lokal_order_status", { order_id: o.id, buyer_ref: o.ref });
        assertTrue(s.body?.success === true && !("available_actions" in s.body) && !("messages" in s.body) && !("completion_source" in s.body),
          "flag-05: switch off → lokal_order_status output has no B1 fields (unchanged)");
      });
      await withMcp(true, async (client) => {
        const tools = (await client.listTools()).tools as any[];
        const cancel = tools.find((t) => t.name === "lokal_order_cancel");
        const picked = tools.find((t) => t.name === "lokal_order_picked_up");
        assertTrue(!!cancel && !!picked, "flag-06: switch on → both tools are in tools/list");
        assertEq([cancel?.annotations?.readOnlyHint, cancel?.annotations?.destructiveHint, cancel?.annotations?.openWorldHint],
          [false, true, true], "flag-07: lokal_order_cancel annotations: write, destructive, open world (e-mails the producer)");
        assertEq([picked?.annotations?.readOnlyHint, picked?.annotations?.destructiveHint, picked?.annotations?.openWorldHint],
          [false, true, false], "flag-08: lokal_order_picked_up annotations: write, destructive, closed world");
        assertTrue(/explicitly told you to cancel/.test(cancel?.description ?? "") && /§ 41/.test(cancel?.description ?? "") &&
          /explicitly told you that they have picked up/.test(picked?.description ?? ""),
          "flag-09: descriptions require the user's explicit instruction and state the consequence");
        assertEq(Object.keys(cancel?.inputSchema?.properties ?? {}).sort(), ["buyer_ref", "idempotency_key", "order_id"], "flag-10: input order_id, buyer_ref, optional idempotency_key");
        assertEq([...(cancel?.inputSchema?.required ?? [])].sort(), ["buyer_ref", "order_id"], "flag-11: idempotency_key is optional");
        // Same session, switch turned off at run time: calls are refused.
        delete process.env.ORDER_AGENT_ACTIONS_ENABLED;
        const c = await call(client, "lokal_order_cancel", { order_id: o.id, buyer_ref: o.ref });
        assertTrue(c.body?.success === false && row(o.id).status === "pending", "flag-12: a session started with the switch on refuses calls once it is off");
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC6 — lokal_order_cancel
    // ════════════════════════════════════════════════════════════════════════
    await withMcp(true, async (client) => {
      // pending → withdraw
      const p = seedOrder({ status: "pending" });
      const r = await call(client, "lokal_order_cancel", { order_id: p.id, buyer_ref: p.ref });
      await settle();
      assertTrue(r.body?.success === true && r.body.action === "withdraw" && r.body.status === "cancelled" && r.body.cancel_reason === "buyer_cancelled",
        `ac6-01: pending → action withdraw, status cancelled, cancel_reason buyer_cancelled (got ${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq([row(p.id).status, row(p.id).cancel_reason], ["cancelled", "buyer_cancelled"], "ac6-02: the order row is cancelled / buyer_cancelled");
      assertEq(trustAll(p.id), [], "ac6-03: withdraw writes no trust event against the producer");
      assertEq(buyerEvents(p.id).map((e) => [e.from_status, e.to_status, e.actor_role, e.channel]), [["pending", "cancelled", "buyer", "mcp"]],
        "ac6-04: one order_events row, actor_role buyer, channel mcp");
      const pm = mailsFor(p.id);
      assertTrue(pm.length === 1 && pm[0]!.to === PRODUCER_MAIL && /trukket bestillingen/.test(pm[0]!.subject) && /teller ikke mot deg/.test(pm[0]!.textContent),
        `ac6-05: the producer gets one e-mail that the buyer withdrew (got ${JSON.stringify(pm).slice(0, 200)})`);
      assertTrue(!("consumer_law_note" in r.body) && !pm[0]!.textContent.includes("kari.b1@example.com"),
        "ac6-06: a free withdraw carries no § 41 note, and the producer mail carries no buyer address");
      assertTrue(r.body.producer_contact && r.body.producer_contact.email === PRODUCER_MAIL, "ac6-07: the answer carries the producer's contact");

      // confirmed → cancel with the § 41 text
      const c = seedOrder({ status: "confirmed" });
      const rc = await call(client, "lokal_order_cancel", { order_id: c.id, buyer_ref: c.ref });
      await settle();
      assertTrue(rc.body?.success === true && rc.body.action === "cancel" && rc.body.status === "cancelled",
        "ac6-08: confirmed → action cancel, status cancelled");
      assertTrue(typeof rc.body?.consumer_law_note === "string" && rc.body.consumer_law_note.includes(receiptSvc.CONSUMER_CANCEL_LOSS_SENTENCE),
        `ac6-09: after confirmation the answer carries the § 41 text of the receipt (got ${JSON.stringify(rc.body?.consumer_law_note)})`);
      assertTrue(mailsFor(c.id).length === 1 && /avbestilt/.test(mailsFor(c.id)[0]!.subject), "ac6-10: the producer is told of the cancellation");
      assertEq(trustAgainst(c.id), 0, "ac6-11: the buyer's cancel writes no trust event against the producer");

      // confirmed, non-trader → kjøpsloven, not § 41
      const n = seedOrder({ status: "confirmed", agent: "ag-b1n" });
      const rn = await call(client, "lokal_order_cancel", { order_id: n.id, buyer_ref: n.ref });
      assertTrue(rn.body?.success === true && /kjøpsloven/.test(rn.body.consumer_law_note) && !/§ 41/.test(rn.body.consumer_law_note),
        "ac6-12: a producer who declared non-trader → the note names kjøpsloven, not § 41");

      // wrong buyer_ref → 403, and the same answer as an unknown order
      const w = seedOrder({ status: "pending" });
      const before = producerMail.length;
      const rw = await call(client, "lokal_order_cancel", { order_id: w.id, buyer_ref: "bref_wrong" });
      const ru = await call(client, "lokal_order_cancel", { order_id: "no-such-order", buyer_ref: "bref_wrong" });
      await settle();
      assertTrue(rw.body?.success === false && rw.body.status === 403, "ac6-13: wrong buyer_ref → 403");
      assertEq(rw.body, ru.body, "ac6-14: wrong buyer_ref and an unknown order give the identical answer (no information about the order)");
      assertTrue(!JSON.stringify(rw.body).includes("pending") && !JSON.stringify(rw.body).includes("Gård"), "ac6-15: the 403 answer names no status or producer");
      assertEq([row(w.id).status, producerMail.length - before], ["pending", 0], "ac6-16: wrong buyer_ref → no change, no e-mail");
      const rpw = await call(client, "lokal_order_picked_up", { order_id: seedOrder({ status: "confirmed" }).id, buyer_ref: "bref_wrong" });
      assertEq(rpw.body?.status, 403, "ac6-17: lokal_order_picked_up with a wrong buyer_ref → 403");

      // the producer never got the order → no producer e-mail
      const ns = seedOrder({ status: "pending", notifySent: false });
      await call(client, "lokal_order_cancel", { order_id: ns.id, buyer_ref: ns.ref });
      await settle();
      assertEq([row(ns.id).status, mailsFor(ns.id).length], ["cancelled", 0], "ac6-18: an order whose e-mail never reached the producer → cancelled, no producer e-mail");

      // prepay with payments off: the cancel gate of every channel applies
      const pp = seedOrder({ status: "pending", paymentMode: "prepay" });
      const rpp = await call(client, "lokal_order_cancel", { order_id: pp.id, buyer_ref: pp.ref });
      assertTrue(rpp.body?.success === false && rpp.body.status === 409 && row(pp.id).status === "pending", "ac6-19: a prepay order with payments off is not cancelled (shared gate)");

      // ════════════════════════════════════════════════════════════════════
      // AC7 — lokal_order_picked_up
      // ════════════════════════════════════════════════════════════════════
      const k = seedOrder({ status: "confirmed" });
      const rk = await call(client, "lokal_order_picked_up", { order_id: k.id, buyer_ref: k.ref });
      assertTrue(rk.body?.success === true && rk.body.status === "completed" && rk.body.completion_source === "buyer",
        `ac7-01: confirmed → completed, completion_source buyer (got ${JSON.stringify(rk.body).slice(0, 160)})`);
      assertEq([row(k.id).status, row(k.id).completion_source], ["completed", "buyer"], "ac7-02: the order row is completed / buyer");
      assertEq(buyerEvents(k.id).map((e) => [e.to_status, e.channel]), [["completed", "mcp"]], "ac7-03: one buyer event, channel mcp");
      assertEq(trustAll(k.id), ["order_completed"], "ac7-04: the pickup is a completed order in the trust ledger (nothing against the producer)");
      const ready = seedOrder({ status: "ready" });
      assertEq((await call(client, "lokal_order_picked_up", { order_id: ready.id, buyer_ref: ready.ref })).body?.status, "completed", "ac7-05: legacy ready → completed");
      const pend = seedOrder({ status: "pending" });
      const rpend = await call(client, "lokal_order_picked_up", { order_id: pend.id, buyer_ref: pend.ref });
      assertTrue(rpend.body?.success === false && rpend.body.status === 409 && row(pend.id).status === "pending", "ac7-06: pickup of a pending order → 409, no change");

      // ════════════════════════════════════════════════════════════════════
      // Idempotency
      // ════════════════════════════════════════════════════════════════════
      const i1 = seedOrder({ status: "pending" });
      const a1 = await call(client, "lokal_order_cancel", { order_id: i1.id, buyer_ref: i1.ref, idempotency_key: "kjoper-1" });
      const a2 = await call(client, "lokal_order_cancel", { order_id: i1.id, buyer_ref: i1.ref, idempotency_key: "kjoper-1" });
      await settle();
      assertTrue(a1.body?.replayed === false && a2.body?.success === true && a2.body.replayed === true, "idem-01: the same key twice → the second answer is a replay");
      assertEq([a2.body?.action, a2.body?.status], ["withdraw", "cancelled"], "idem-02: the replay answers as the first call (withdraw)");
      assertEq(buyerEvents(i1.id).length, 1, "idem-03: one transition for the same key twice");
      assertEq(mailsFor(i1.id).length, 1, "idem-04: one producer e-mail for the same key twice");
      assertEq(buyerEvents(i1.id)[0]?.idempotency_key, "b:kjoper-1", "idem-05: the buyer's key is stored namespaced");
      const i2 = seedOrder({ status: "confirmed" });
      await call(client, "lokal_order_picked_up", { order_id: i2.id, buyer_ref: i2.ref, idempotency_key: "hent-1" });
      const b2 = await call(client, "lokal_order_picked_up", { order_id: i2.id, buyer_ref: i2.ref, idempotency_key: "hent-1" });
      assertTrue(b2.body?.replayed === true && buyerEvents(i2.id).length === 1 && trustAll(i2.id).length === 1, "idem-06: picked_up with the same key twice → one transition, one trust event");
      const i3 = seedOrder({ status: "confirmed" });
      await call(client, "lokal_order_cancel", { order_id: i3.id, buyer_ref: i3.ref, idempotency_key: "k3" });
      const b3 = await call(client, "lokal_order_cancel", { order_id: i3.id, buyer_ref: i3.ref, idempotency_key: "k3" });
      assertTrue(b3.body?.replayed === true && b3.body.action === "cancel" && b3.body.consumer_law_note, "idem-07: replay of a cancel after confirmation keeps action cancel and the § 41 note");
      const i4 = seedOrder({ status: "pending" });
      await call(client, "lokal_order_cancel", { order_id: i4.id, buyer_ref: i4.ref });
      const b4 = await call(client, "lokal_order_cancel", { order_id: i4.id, buyer_ref: i4.ref });
      assertTrue(b4.body?.success === false && b4.body.status === 409 && buyerEvents(i4.id).length === 1, "idem-08: without a key, a second cancel is refused (409), still one transition");
      const bad = await call(client, "lokal_order_cancel", { order_id: i4.id, buyer_ref: i4.ref, idempotency_key: "har mellomrom" });
      assertEq(bad.body?.status, 400, "idem-09: an invalid idempotency_key → 400");

      // ════════════════════════════════════════════════════════════════════
      // lokal_order_status with the switch on
      // ════════════════════════════════════════════════════════════════════
      const sp = seedOrder({ status: "pending" });
      const s1 = (await call(client, "lokal_order_status", { order_id: sp.id, buyer_ref: sp.ref })).body;
      assertEq([s1?.available_actions, s1?.messages, s1?.completion_source, "pickup_time" in (s1 ?? {})], [["withdraw"], [], null, true],
        "status-01: pending → available_actions [withdraw], messages [], completion_source null, pickup_time present");
      const sc = seedOrder({ status: "confirmed", pickup: "2030-01-01T14:00:00.000Z" });
      const s2 = (await call(client, "lokal_order_status", { order_id: sc.id, buyer_ref: sc.ref })).body;
      assertEq([s2?.available_actions, s2?.pickup_time], [["cancel", "picked_up"], "2030-01-01T14:00:00.000Z"], "status-02: confirmed → [cancel, picked_up] and the pickup time");
      const s3 = (await call(client, "lokal_order_status", { order_id: k.id, buyer_ref: k.ref })).body;
      assertEq([s3?.available_actions, s3?.completion_source], [[], "buyer"], "status-03: completed by the buyer → no actions, completion_source buyer");
      const s4 = (await call(client, "lokal_order_status", { order_id: pp.id, buyer_ref: pp.ref })).body;
      assertEq(s4?.available_actions, [], "status-04: prepay order with payments off → no cancel offered");
      const s5 = (await call(client, "lokal_order_status", { order_id: sp.id, buyer_ref: "bref_wrong" })).body;
      assertTrue(s5?.success === false && !("available_actions" in s5), "status-05: wrong buyer_ref → no B1 fields");
    });

    // ════════════════════════════════════════════════════════════════════════
    // The order card /ordre/:id
    // ════════════════════════════════════════════════════════════════════════
    {
      const express = require("express");
      const card = require("./buyer-order-card") as typeof import("./buyer-order-card");
      const app = express();
      app.use("/", card.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; form?: Record<string, string> } = {}):
      Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) { bodyStr = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
        if (bodyStr !== undefined) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
        const r = http.request({ method, host: "127.0.0.1", port, path: urlPath, headers }, (resp) => {
          const chunks: Buffer[] = [];
          resp.on("data", (c) => chunks.push(c as Buffer));
          resp.on("end", () => resolve({ status: resp.statusCode || 0, text: Buffer.concat(chunks).toString("utf8"), headers: resp.headers }));
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const cardUrl = (o: { id: string; ref: string }) => `/ordre/${encodeURIComponent(o.id)}?ref=${encodeURIComponent(o.ref)}`;
    // The card does not depend on the MCP switch.
    delete process.env.ORDER_AGENT_ACTIONS_ENABLED;

    {
      const p = seedOrder({ status: "pending" });
      for (const [label, path] of [
        ["wrong ref", `/ordre/${p.id}?ref=bref_wrong`], ["missing ref", `/ordre/${p.id}`], ["unknown order", `/ordre/no-such-order?ref=${p.ref}`],
      ] as const) {
        const r = await req("GET", path);
        assertTrue(r.status === 404 && !r.text.includes("Gård") && !r.text.includes("Poteter") && !r.text.includes(p.id.slice(0, 8)),
          `card-01: ${label} → 404 without details`);
      }
      const g = await req("GET", cardUrl(p));
      assertEq(g.status, 200, "card-02: the right ref → 200");
      assertEq([g.headers["cache-control"], g.headers["referrer-policy"], String(g.headers["x-robots-tag"] ?? "").includes("noindex")],
        ["no-store", "no-referrer", true], "card-03: Cache-Control no-store, Referrer-Policy no-referrer, X-Robots-Tag noindex");
      assertTrue(g.text.includes('<meta name="robots" content="noindex, nofollow">'), "card-04: meta robots noindex");
      assertTrue(g.text.includes("Avbestill") && !g.text.includes("Jeg har hentet") && g.text.includes("Venter på svar fra produsenten"),
        "card-05: pending → «Avbestill» only, status shown");
      assertTrue(g.text.includes("Gård &lt;B1&gt;") && !g.text.includes("Gård <B1>"), "card-06: the producer name is HTML-escaped");
      assertTrue(g.text.includes(PRODUCER_MAIL) && g.text.includes("+47 400 11 111") && g.text.includes("<details"), "card-07: producer contact in an expandable part");

      const c = seedOrder({ status: "confirmed", pickup: "2030-01-01T14:00:00.000Z" });
      const gc = await req("GET", cardUrl(c));
      assertTrue(gc.text.includes("Jeg har hentet") && gc.text.includes("Avbestill") && gc.text.includes("forbrukerkjøpsloven § 41") && gc.text.includes("Henting "),
        "card-08: confirmed → «Jeg har hentet», «Avbestill» with the § 41 text, and the pickup time");

      // POST: PRG
      const post = await req("POST", `/ordre/${encodeURIComponent(p.id)}`, { form: { ref: p.ref, action: "cancel", idem: "11111111-aaaa-bbbb-cccc-000000000001" } });
      await settle();
      assertEq([post.status, post.headers["location"]], [303, `${cardUrl(p)}&done=cancelled`], "card-09: «Avbestill» → 303 back to the card (PRG)");
      assertEq([row(p.id).status, row(p.id).cancel_reason], ["cancelled", "buyer_cancelled"], "card-10: the order is withdrawn");
      assertEq(buyerEvents(p.id).map((e) => [e.to_status, e.channel]), [["cancelled", "web"]], "card-11: the event has channel web");
      assertEq(mailsFor(p.id).length, 1, "card-12: the producer is told");
      const again = await req("POST", `/ordre/${encodeURIComponent(p.id)}`, { form: { ref: p.ref, action: "cancel", idem: "11111111-aaaa-bbbb-cccc-000000000001" } });
      assertTrue(again.status === 303 && buyerEvents(p.id).length === 1 && mailsFor(p.id).length === 1, "card-13: a repeated form post (same idem) → one transition");
      const after = await req("GET", `${cardUrl(p)}&done=cancelled`);
      assertTrue(after.text.includes("Bestillingen er avbestilt") && !after.text.includes('value="cancel"'), "card-14: after the PRG the card shows the result and no more buttons");

      const pu = await req("POST", `/ordre/${encodeURIComponent(c.id)}`, { form: { ref: c.ref, action: "picked_up", idem: "11111111-aaaa-bbbb-cccc-000000000002" } });
      assertEq([pu.status, pu.headers["location"], row(c.id).status, row(c.id).completion_source], [303, `${cardUrl(c)}&done=completed`, "completed", "buyer"],
        "card-15: «Jeg har hentet» → 303, completed / buyer");

      const w = seedOrder({ status: "pending" });
      const pw = await req("POST", `/ordre/${encodeURIComponent(w.id)}`, { form: { ref: "bref_wrong", action: "cancel" } });
      assertEq([pw.status, row(w.id).status], [404, "pending"], "card-16: POST with a wrong ref → 404, no change");
      const px = await req("POST", `/ordre/${encodeURIComponent(w.id)}`, { headers: { Origin: "https://evil.example" }, form: { ref: w.ref, action: "cancel" } });
      assertEq([px.status, row(w.id).status], [403, "pending"], "card-17: a cross-site form post (foreign Origin) → 403, no change");
      const pv = await req("POST", `/ordre/${encodeURIComponent(w.id)}`, { form: { ref: w.ref, action: "confirm" } });
      assertEq([pv.status, pv.headers["location"], row(w.id).status], [303, `${cardUrl(w)}&error=ugyldig`, "pending"], "card-18: a seller action from the card → refused (PRG with error)");
      const pp = await req("POST", `/ordre/${encodeURIComponent(w.id)}`, { form: { ref: w.ref, action: "picked_up" } });
      assertEq([pp.headers["location"], row(w.id).status], [`${cardUrl(w)}&error=ugyldig`, "pending"], "card-19: «Jeg har hentet» on a pending order → refused");
      const same = await req("POST", `/ordre/${encodeURIComponent(w.id)}`, { headers: { Origin: `http://127.0.0.1:${port}` }, form: { ref: w.ref, action: "cancel" } });
      assertEq([same.status, row(w.id).status], [303, "cancelled"], "card-20: a same-origin form post is accepted");
    }

    // ════════════════════════════════════════════════════════════════════════
    // The receipt links the card
    // ════════════════════════════════════════════════════════════════════════
    {
      const base = { orderRef: "abcd1234", producerName: "Gård", contact: { phone: null, email: null, address: null, profile_url: "u" }, traderStatus: null,
        items: [{ name: "Egg", qty: 1, line_total: 60 }], totalNok: 60, cancelReason: null, payment: null } as const;
      const without = receiptSvc.renderBuyerReceipt("confirmed", { ...base });
      const withCard = receiptSvc.renderBuyerReceipt("confirmed", { ...base, cardUrl: "https://rfb.test/ordre/x?ref=y" });
      assertTrue(!!without && !without.text.includes("Ordrekort") && without.text.includes(receiptSvc.CONSUMER_CANCEL_LOSS_SENTENCE),
        "rcpt-01: without a card URL the confirmation is as before (with the § 41 sentence)");
      assertEq(withCard?.text.replace("Ordrekort: Se bestillingen, avbestill eller si fra at du har hentet: https://rfb.test/ordre/x?ref=y\n\n", ""), without?.text,
        "rcpt-02: the card link is one added line in the confirmation");
      process.env.ORDER_BUYER_RECEIPTS_ENABLED = "1";
      const o = seedOrder({ status: "pending" });
      const r = await actionsSvc.applyOrderAction(o.id, "confirm", { role: "seller", channel: "producer_page", ref: "test" });
      await settle();
      const rc = receipts.filter((m) => m.subject.includes(o.id.slice(0, 8)));
      assertTrue(r.success && rc.length === 1 && rc[0]!.textContent.includes(`/ordre/${o.id}?ref=${encodeURIComponent(o.ref)}`),
        "rcpt-03: the confirmation receipt links the buyer's order card");
      assertEq(mailsFor(o.id).length, 0, "rcpt-04: a seller action sends no buyer-cancel notice to the producer");
    }
  } catch (err: any) {
    failed++;
    failures.push("buyer-order-actions-fase-b1: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    notifySvc.__setOrderNotifySendForTesting(null);
    receiptSvc.__setBuyerReceiptSendForTesting(null);
    actionsSvc.__setOrderActionsTestDb(null);
    receiptSvc.__setBuyerReceiptTestDb(null);
    notifySvc.__setOrderNotifyTestDb(null);
    trustSvc.__setTrustEventTestDb(null);
    cartSvc.__setCartTestDb(null);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runBuyerOrderActionsFaseB1Tests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
