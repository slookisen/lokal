/**
 * order-a2a-task-fase-b3.test.ts — dev-request 2026-10-21-rfb-mine-ordrer-
 * ett-klikk-og-kjoperagent, FASE B3 (ordren som A2A-task). No network, no real
 * e-mail, no production DB: a fresh in-memory SQLite with the real production
 * schema and the real RFB, Finn-tannlege and Opplevagent A2A routers through
 * router.handle().
 *
 *   map   order status → A2A TaskState for every status (ready → working).
 *   get   tasks/get on "order:<id>" (and the bare id with metadata.buyer_ref):
 *         Task with status, stateTransitionHistory from order_events, the
 *         order detail artifact; wrong buyer_ref and unknown order → the same
 *         -32001 (data.status 403); missing buyer_ref → -32602.
 *   cancel tasks/cancel: pending → withdraw (buyer_cancelled, no trust event,
 *         producer e-mail, channel a2a); confirmed → § 41 cancel; idempotency
 *         key → one transition; expected_action mismatch → -32002, no change;
 *         wrong ref → -32001; a closed order → -32002.
 *   off   ORDER_AGENT_ACTIONS_ENABLED off: tasks/get answers as before for
 *         order ids, tasks/cancel is "Method not found", both agent cards
 *         have no manage-pickup-order skill and the old method list.
 *   card  on: both cards carry the skill and tasks/cancel; nothing else in
 *         the card differs from the off card.
 *   keep  marketplace tasks answer tasks/get identically with the switch on
 *         and off (also with a buyer_ref in metadata); dental and
 *         experiences A2A answer tasks/get / tasks/cancel as before (-32601).
 *
 * Standalone: npx tsx src/routes/order-a2a-task-fase-b3.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import { EventEmitter } from "node:events";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

let ipSeq = 0;
function callRouter(router: any, method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    ipSeq++;
    const ip = `10.133.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "curl/8.5.0", host: "rettfrabonden.com" };
    const req: any = {
      method, url, originalUrl: url, path: url, query: {}, headers, body, ip,
      hostname: "rettfrabonden.com",
      socket: { remoteAddress: ip },
      get(name: string) { return headers[name.toLowerCase()]; },
      header(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      locals: {} as Record<string, unknown>,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
      header() { return this; },
      set() { return this; },
      append() { return this; },
      json(payload: any) { this.headersSent = true; resolve({ status: this.statusCode, body: JSON.parse(JSON.stringify(payload)) }); return this; },
      send(payload: any) { this.headersSent = true; resolve({ status: this.statusCode, body: payload }); return this; },
    });
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: String(err ?? "no route") }));
  });
}

export async function runOrderA2aTaskFaseB3Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const taskSvc = require("../services/order-a2a-task") as typeof import("../services/order-a2a-task");
  const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");

  const ENV_KEYS = [
    "ORDER_AGENT_ACTIONS_ENABLED", "ORDER_MESSAGES_ENABLED", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED",
    "ORDER_AUTOCOMPLETE_SINCE", "PAYMENTS_ENABLED", "ADMIN_NOTIFICATION_EMAIL",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  const PRODUCER_MAIL = "gard-b3@example.no";
  const producerMail: Array<{ to: string; subject: string; textContent: string }> = [];

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
    receiptSvc.__setBuyerReceiptSendForTesting(async () => ({ success: true, messageId: "stub" }));
    for (const k of ENV_KEYS) delete process.env[k];
    // The registry card reads the vertical config; load it when no earlier suite did.
    const cfgMod = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { cfgMod.getConfig(); } catch { cfgMod.loadConfigsAtBoot({ dir: "./verticals" }); }
    const flag = (on: boolean) => { if (on) process.env.ORDER_AGENT_ACTIONS_ENABLED = "1"; else delete process.env.ORDER_AGENT_ACTIONS_ENABLED; };

    // ── Seed ────────────────────────────────────────────────────────────────
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, order_notifications_opt_in)
      VALUES ('ag-b3', 'Gård B3', 'Testprodusent', 'self', ?, 'https://example.no', 'producer', 'k-b3', '["vegetables"]', 1)
    `).run(PRODUCER_MAIL);
    db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES ('ag-b3', 'verified', ?, '+47 400 33 333')").run(PRODUCER_MAIL);

    let seq = 0;
    const CREATED = "2026-10-20 10:00:00";
    function seedOrder(status: string, events: Array<[string | null, string, string, string, string]> = []): { id: string; ref: string } {
      const id = `b3${String(++seq).padStart(3, "0")}ord-order`; // unique 8-char order ref
      const ref = `bref_b3_${seq}_secret`;
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, total_nok, notify_sent_at, buyer_email, created_at, updated_at)
        VALUES (?, 'ag-b3', ?, ?, 'pickup', ?, 90, ?, 'kari.b3@example.com', ?, ?)
      `).run(id, ref, status, `ctok_${id}`, CREATED, CREATED, CREATED);
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 3, 30, 90)")
        .run(`${id}-i1`, id);
      let n = 0;
      for (const [from, to, role, channel, at] of events) {
        db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`${id}-e${++n}`, id, from, to, role === "seller" ? "producer" : role, role, channel, at);
      }
      return { id, ref };
    }
    const row = (id: string) => db.prepare("SELECT status, cancel_reason FROM orders WHERE id = ?").get(id) as any;
    const buyerEvents = (id: string) => db.prepare("SELECT from_status, to_status, actor_role, channel, idempotency_key FROM order_events WHERE order_id = ? AND actor_role = 'buyer' ORDER BY created_at, rowid").all(id) as any[];
    const trustAll = (id: string) => db.prepare("SELECT event_type FROM trust_events WHERE ref = ?").all(id).map((r: any) => r.event_type);
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const mailsFor = (orderId: string) => producerMail.filter((m) => m.subject.includes(orderId.slice(0, 8)));

    const a2aRouter = require("./a2a").default;
    const rpc = (method: string, params: unknown, router: any = a2aRouter) =>
      callRouter(router, "POST", "/a2a", { jsonrpc: "2.0", method, params, id: "t1" }).then((r) => r.body);

    // ════════════════════════════════════════════════════════════════════════
    // map — every order status
    // ════════════════════════════════════════════════════════════════════════
    assertEq(["pending", "confirmed", "ready", "completed", "declined", "cancelled"].map(taskSvc.orderStatusToTaskState),
      ["submitted", "working", "working", "completed", "canceled", "canceled"], "map-01: pending→submitted, confirmed/ready→working, completed→completed, declined/cancelled→canceled");
    assertEq(taskSvc.sqliteToIso("2026-10-20 10:00:00"), "2026-10-20T10:00:00.000Z", "map-02: SQLite UTC timestamps become ISO 8601");

    // ════════════════════════════════════════════════════════════════════════
    // off — the switch off: everything as before
    // ════════════════════════════════════════════════════════════════════════
    const offOrder = seedOrder("pending");
    flag(false);
    {
      const g1 = await rpc("tasks/get", { id: `order:${offOrder.id}`, metadata: { buyer_ref: offOrder.ref } });
      assertEq(g1, { jsonrpc: "2.0", error: { code: -32602, message: `Task not found: order:${offOrder.id}` }, id: "t1" },
        "off-01: switch off → tasks/get on order:<id> answers 'Task not found' as before");
      const g2 = await rpc("tasks/get", { id: offOrder.id, metadata: { buyer_ref: offOrder.ref } });
      assertEq(g2?.error?.code, -32602, "off-02: switch off → the bare order id with buyer_ref is not found either");
      for (const m of ["tasks/cancel", "CancelTask"]) {
        const c = await rpc(m, { id: `order:${offOrder.id}`, metadata: { buyer_ref: offOrder.ref } });
        assertEq(c, { jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${m}` }, id: "t1" }, `off-03: switch off → ${m} is 'Method not found'`);
      }
      assertEq(row(offOrder.id).status, "pending", "off-04: switch off → the order is untouched");
    }

    // ════════════════════════════════════════════════════════════════════════
    // card — both RFB cards, off vs on
    // ════════════════════════════════════════════════════════════════════════
    {
      const OLD_METHODS = ["message/send", "tasks/get", "tasks/list", "agent/authenticatedExtendedCard"];
      flag(false);
      const offA2a = (await callRouter(a2aRouter, "GET", "/a2a")).body;
      const offReg = JSON.parse(JSON.stringify(regMod.marketplaceRegistry.getRegistryCard("https://rettfrabonden.com")));
      flag(true);
      const onA2a = (await callRouter(a2aRouter, "GET", "/a2a")).body;
      const onReg = JSON.parse(JSON.stringify(regMod.marketplaceRegistry.getRegistryCard("https://rettfrabonden.com")));
      const ids = (c: any) => (c?.skills || []).map((s: any) => s.id);
      assertEq(ids(offA2a), ["discover-local-food-agents", "agent-conversation", "build-shopping-cart"], "card-01: off → GET /a2a card skills as before");
      assertEq(ids(offReg), ["discover-local-food-agents", "register-food-agent", "search-compare-food"], "card-02: off → registry card skills as before");
      assertEq([offA2a.interfaces[0].methods, offReg.interfaces[0].methods], [OLD_METHODS, OLD_METHODS], "card-03: off → method lists as before");
      assertEq([ids(onA2a).includes("manage-pickup-order"), ids(onReg).includes("manage-pickup-order")], [true, true], "card-04: on → both cards carry manage-pickup-order");
      assertTrue(onA2a.interfaces[0].methods.includes("tasks/cancel") && onReg.interfaces[0].methods.includes("tasks/cancel"), "card-05: on → both cards list tasks/cancel");
      assertEq([onA2a.capabilities.pushNotifications, onReg.capabilities.pushNotifications], [false, false], "card-06: pushNotifications stays false");
      const strip = (c: any) => {
        const x = JSON.parse(JSON.stringify(c));
        x.skills = x.skills.filter((s: any) => s.id !== "manage-pickup-order");
        x.interfaces[0].methods = x.interfaces[0].methods.filter((m: string) => m !== "tasks/cancel");
        return JSON.stringify(x);
      };
      assertEq(strip(onA2a), JSON.stringify(offA2a), "card-07: GET /a2a card on = off + the skill + tasks/cancel, nothing else");
      assertEq(strip(onReg), JSON.stringify(offReg), "card-08: registry card on = off + the skill + tasks/cancel, nothing else");
      const skill = onReg.skills.find((s: any) => s.id === "manage-pickup-order");
      assertTrue(/order:<order_id>/.test(skill.description) && /buyer_ref/.test(skill.description) && /§ 41/.test(skill.description) && /explicit instruction/.test(skill.description),
        "card-09: the skill says how to address the order, the buyer_ref, § 41 and the explicit-instruction rule");
      assertEq(Object.keys(skill), ["id", "name", "description", "tags", "inputModes", "outputModes", "examples"], "card-10: the skill has the shape of the other registry skills");
    }

    // ════════════════════════════════════════════════════════════════════════
    // keep — marketplace tasks unchanged with the switch on
    // ════════════════════════════════════════════════════════════════════════
    {
      const mt = regMod.marketplaceRegistry.createTask("message/send", { q: "x" }, "consumer-b3");
      flag(false);
      const off = await rpc("tasks/get", { id: mt.id });
      const offName = await rpc("GetTask", { name: `tasks/${mt.id}` });
      flag(true);
      const on = await rpc("tasks/get", { id: mt.id });
      const onName = await rpc("GetTask", { name: `tasks/${mt.id}` });
      const onRef = await rpc("tasks/get", { id: mt.id, metadata: { buyer_ref: "anything" } });
      assertTrue(off?.result?.task?.id === mt.id, "keep-01: a marketplace task is found (switch off)");
      assertEq([on, onName, onRef], [off, offName, off], "keep-02: switch on → marketplace task answers identically (also by name, also with a buyer_ref)");
      const missOff = (flag(false), await rpc("tasks/get", { id: "no-such-task" }));
      const missOn = (flag(true), await rpc("tasks/get", { id: "no-such-task" }));
      assertEq(missOn, missOff, "keep-03: switch on → an unknown task without buyer_ref answers as before");
      const noId = await rpc("tasks/get", {});
      assertEq(noId?.error?.code, -32602, "keep-04: tasks/get without id → -32602 as before");
      const cm = await rpc("tasks/cancel", { id: mt.id });
      assertEq(cm?.error?.code, taskSvc.A2A_TASK_NOT_CANCELABLE, "keep-05: tasks/cancel on a marketplace task → -32002 not cancelable");
      const cu = await rpc("tasks/cancel", { id: "no-such-task" });
      assertEq(cu?.error?.code, taskSvc.A2A_TASK_NOT_FOUND, "keep-06: tasks/cancel on an unknown id without buyer_ref → -32001");
    }

    // ════════════════════════════════════════════════════════════════════════
    // get — the order as a Task
    // ════════════════════════════════════════════════════════════════════════
    flag(true);
    {
      const expected: Record<string, string> = {
        pending: "submitted", confirmed: "working", ready: "working", completed: "completed", declined: "canceled", cancelled: "canceled",
      };
      for (const [st, state] of Object.entries(expected)) {
        const o = seedOrder(st);
        const r = await rpc("tasks/get", { id: `order:${o.id}`, metadata: { buyer_ref: o.ref } });
        const t = r?.result?.task;
        assertEq([t?.id, t?.kind, t?.status?.state, t?.metadata?.order_status], [`order:${o.id}`, "task", state, st], `get-01-${st}: ${st} → ${state}`);
        assertTrue(!JSON.stringify(r).includes(o.ref), `get-02-${st}: the answer never echoes the buyer_ref`);
      }

      const h = seedOrder("completed", [
        ["pending", "confirmed", "seller", "producer_page", "2026-10-20 11:00:00"],
        ["confirmed", "completed", "buyer", "mcp", "2026-10-21 09:30:00"],
      ]);
      const r = await rpc("tasks/get", { id: `order:${h.id}`, metadata: { buyer_ref: h.ref } });
      const t = r?.result?.task;
      assertEq(t?.stateTransitionHistory, [
        { state: "submitted", order_status: "pending", from_order_status: null, timestamp: "2026-10-20T10:00:00.000Z", actor_role: "buyer", channel: null },
        { state: "working", order_status: "confirmed", from_order_status: "pending", timestamp: "2026-10-20T11:00:00.000Z", actor_role: "seller", channel: "producer_page" },
        { state: "completed", order_status: "completed", from_order_status: "confirmed", timestamp: "2026-10-21T09:30:00.000Z", actor_role: "buyer", channel: "mcp" },
      ], "get-03: stateTransitionHistory = creation + one entry per order_events row, in order");
      assertEq(t?.status?.timestamp, "2026-10-20T10:00:00.000Z", "get-04: status.timestamp is orders.updated_at");
      const art = t?.artifacts?.[0];
      assertTrue(art?.name === "pickup-order" && art?.parts?.[0]?.kind === "data" && art.parts[0].data.order_id === h.id &&
        Array.isArray(art.parts[0].data.items) && art.parts[0].data.timeline.length === 2 && !("success" in art.parts[0].data),
        "get-05: the artifact is the order detail (items, timeline) as a data part");
      assertEq(t?.metadata?.available_actions, [], "get-06: a completed order offers no actions");

      const p = seedOrder("pending");
      const bare = await rpc("tasks/get", { id: p.id, metadata: { buyer_ref: p.ref } });
      const pref = await rpc("tasks/get", { id: `order:${p.id}`, metadata: { buyer_ref: p.ref } });
      const named = await rpc("GetTask", { name: `tasks/order:${p.id}`, metadata: { buyer_ref: p.ref } });
      assertEq([bare, named], [pref, pref], "get-07: the bare order id with buyer_ref and GetTask by name give the same Task");
      assertEq(pref?.result?.task?.metadata?.available_actions, ["withdraw"], "get-08: a pending order offers withdraw (tasks/cancel)");

      const wrong = await rpc("tasks/get", { id: `order:${p.id}`, metadata: { buyer_ref: "bref_wrong" } });
      const unknown = await rpc("tasks/get", { id: "order:no-such-order", metadata: { buyer_ref: "bref_wrong" } });
      const unknownBare = await rpc("tasks/get", { id: "no-such-order", metadata: { buyer_ref: "bref_wrong" } });
      assertEq(wrong, { jsonrpc: "2.0", error: { code: -32001, message: "Order not found or buyer_ref does not match", data: { status: 403 } }, id: "t1" },
        "get-09: wrong buyer_ref → -32001, data.status 403");
      assertEq([unknown, unknownBare], [wrong, wrong], "get-10: an unknown order gives the identical answer (nothing about existence)");
      const other = seedOrder("pending");
      const cross = await rpc("tasks/get", { id: `order:${p.id}`, metadata: { buyer_ref: other.ref } });
      assertEq(cross, wrong, "get-11: another order's buyer_ref → the same -32001");
      const missing = await rpc("tasks/get", { id: `order:${p.id}` });
      const missingMeta = await rpc("tasks/get", { id: `order:${p.id}`, metadata: { buyer_ref: 42 } });
      assertEq([missing?.error?.code, missingMeta?.error?.code], [-32602, -32602], "get-12: missing (or non-string) buyer_ref → -32602");
      assertTrue(!JSON.stringify([wrong, missing]).includes("pending") && !JSON.stringify([wrong, missing]).includes("Gård"), "get-13: the errors name no status or producer");
    }

    // ════════════════════════════════════════════════════════════════════════
    // cancel — tasks/cancel through the shared action layer
    // ════════════════════════════════════════════════════════════════════════
    flag(true);
    {
      // pending → withdraw
      const p = seedOrder("pending");
      const r = await rpc("tasks/cancel", { id: `order:${p.id}`, metadata: { buyer_ref: p.ref } });
      await settle();
      const t = r?.result?.task;
      assertEq([t?.status?.state, t?.metadata?.order_status, t?.metadata?.cancellation?.action, t?.metadata?.cancellation?.cancel_reason, t?.metadata?.cancellation?.replayed],
        ["canceled", "cancelled", "withdraw", "buyer_cancelled", false], "cancel-01: pending → canceled, action withdraw, cancel_reason buyer_cancelled");
      assertEq([row(p.id).status, row(p.id).cancel_reason], ["cancelled", "buyer_cancelled"], "cancel-02: the order row is cancelled / buyer_cancelled");
      assertEq(buyerEvents(p.id).map((e) => [e.from_status, e.to_status, e.actor_role, e.channel]), [["pending", "cancelled", "buyer", "a2a"]],
        "cancel-03: one order_events row, actor_role buyer, channel a2a");
      assertEq(trustAll(p.id), [], "cancel-04: withdraw writes no trust event against the producer");
      const pm = mailsFor(p.id);
      assertTrue(pm.length === 1 && pm[0]!.to === PRODUCER_MAIL && /trukket bestillingen/.test(pm[0]!.subject),
        `cancel-05: the producer gets one e-mail that the buyer withdrew (got ${JSON.stringify(pm).slice(0, 160)})`);
      assertTrue(!("consumer_law_note" in (t?.metadata?.cancellation ?? {})) && t?.metadata?.cancellation?.producer_contact?.email === PRODUCER_MAIL,
        "cancel-06: a free withdraw carries no § 41 note, and the answer carries the producer's contact");
      assertEq(t?.stateTransitionHistory?.map((x: any) => [x.state, x.channel]), [["submitted", null], ["canceled", "a2a"]], "cancel-07: the history shows the a2a cancel");

      // confirmed → § 41 cancel (CancelTask alias, by name)
      const c = seedOrder("confirmed", [["pending", "confirmed", "seller", "producer_page", "2026-10-20 11:00:00"]]);
      const rc = await rpc("CancelTask", { name: `tasks/order:${c.id}`, metadata: { buyer_ref: c.ref, expected_action: "cancel" } });
      await settle();
      const tc = rc?.result?.task;
      assertEq([tc?.status?.state, tc?.metadata?.cancellation?.action], ["canceled", "cancel"], "cancel-08: confirmed → canceled, action cancel");
      assertTrue(typeof tc?.metadata?.cancellation?.consumer_law_note === "string" && tc.metadata.cancellation.consumer_law_note.includes(receiptSvc.CONSUMER_CANCEL_LOSS_SENTENCE),
        "cancel-09: after confirmation the answer carries the same § 41 text as B1");
      assertTrue(mailsFor(c.id).length === 1 && /avbestilt/.test(mailsFor(c.id)[0]!.subject), "cancel-10: the producer is told of the cancellation");
      assertEq(trustAll(c.id), [], "cancel-11: the buyer's cancel writes no trust event against the producer");

      // idempotency
      const i = seedOrder("pending");
      const i1 = await rpc("tasks/cancel", { id: i.id, metadata: { buyer_ref: i.ref, idempotency_key: "a2a-k1" } });
      await settle();
      const i2 = await rpc("tasks/cancel", { id: i.id, metadata: { buyer_ref: i.ref, idempotency_key: "a2a-k1" } });
      await settle();
      assertEq([i1?.result?.task?.metadata?.cancellation?.replayed, i2?.result?.task?.metadata?.cancellation?.replayed, i2?.result?.task?.metadata?.cancellation?.action],
        [false, true, "withdraw"], "cancel-12: the same idempotency_key twice → the second is a replay of the withdraw");
      assertEq([buyerEvents(i.id).length, buyerEvents(i.id)[0]?.idempotency_key, mailsFor(i.id).length], [1, "b:a2a-k1", 1],
        "cancel-13: one transition (key namespaced b:), one producer e-mail");
      const i3 = await rpc("tasks/cancel", { id: i.id, metadata: { buyer_ref: i.ref } });
      assertEq(i3?.error?.code, -32002, "cancel-14: a repeat without the key on the closed order → -32002 not cancelable");

      // expected_action mismatch (stale view: the producer confirmed meanwhile)
      const s = seedOrder("confirmed");
      const rs = await rpc("tasks/cancel", { id: `order:${s.id}`, metadata: { buyer_ref: s.ref, expected_action: "withdraw" } });
      assertTrue(rs?.error?.code === -32002 && rs.error.data?.status === 409 && /expected_action_mismatch/.test(rs.error.message),
        "cancel-15: expected_action withdraw on a confirmed order → -32002 (409), mismatch");
      assertEq([row(s.id).status, buyerEvents(s.id).length, mailsFor(s.id).length], ["confirmed", 0, 0], "cancel-16: mismatch → nothing changed, no e-mail");
      const bad = await rpc("tasks/cancel", { id: `order:${s.id}`, metadata: { buyer_ref: s.ref, expected_action: "nuke" } });
      const badKey = await rpc("tasks/cancel", { id: `order:${s.id}`, metadata: { buyer_ref: s.ref, idempotency_key: "has space" } });
      assertEq([bad?.error?.code, badKey?.error?.code, row(s.id).status], [-32602, -32602, "confirmed"], "cancel-17: invalid expected_action / idempotency_key → -32602, no change");

      // wrong buyer_ref, unknown order, missing ref
      const w = seedOrder("pending");
      const before = producerMail.length;
      const rw = await rpc("tasks/cancel", { id: `order:${w.id}`, metadata: { buyer_ref: "bref_wrong" } });
      const ru = await rpc("tasks/cancel", { id: "order:no-such-order", metadata: { buyer_ref: "bref_wrong" } });
      const rm = await rpc("tasks/cancel", { id: `order:${w.id}` });
      await settle();
      assertEq(rw, { jsonrpc: "2.0", error: { code: -32001, message: "Order not found or buyer_ref does not match", data: { status: 403 } }, id: "t1" },
        "cancel-18: wrong buyer_ref → -32001, data.status 403 (the 403-equivalent)");
      assertEq(ru, rw, "cancel-19: an unknown order gives the identical answer");
      assertEq(rm?.error?.code, -32602, "cancel-20: missing buyer_ref → -32602");
      assertEq([row(w.id).status, producerMail.length - before], ["pending", 0], "cancel-21: no change, no e-mail");

      // closed orders
      for (const st of ["completed", "declined"]) {
        const x = seedOrder(st);
        const rx = await rpc("tasks/cancel", { id: `order:${x.id}`, metadata: { buyer_ref: x.ref } });
        assertTrue(rx?.error?.code === -32002 && row(x.id).status === st, `cancel-22-${st}: a ${st} order → -32002, unchanged`);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // other verticals — dental and experiences A2A unchanged
    // ════════════════════════════════════════════════════════════════════════
    flag(true);
    {
      const o = seedOrder("pending");
      const dental = require("./dental-a2a").default;
      const exp = require("./experiences-a2a").default;
      for (const [name, router] of [["dental", dental], ["experiences", exp]] as const) {
        for (const m of ["tasks/get", "tasks/cancel"]) {
          const r = await rpc(m, { id: `order:${o.id}`, metadata: { buyer_ref: o.ref } }, router);
          assertEq(r?.error, { code: -32601, message: `Method not found: ${m}` }, `vert-${name}-${m}: switch on → ${name} A2A still answers -32601`);
        }
      }
      assertEq(row(o.id).status, "pending", "vert-03: the other verticals never touch the order");
    }
  } catch (err: any) {
    failed++;
    failures.push("order-a2a-task-fase-b3: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
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
  runOrderA2aTaskFaseB3Tests({ log: true }).then((s) => {
    console.log(`\norder-a2a-task-fase-b3: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) for (const f of s.failures) console.log(f);
    // The routers' modules keep timers (rate limits, caches) alive: exit explicitly.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
