/**
 * owner-orders-b3-hentet.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-
 * start-til-slutt-for-eier, slice B3 («Hentet» i «Mine ordrer»), AC4.
 *
 * No network, no real e-mail, no production DB: a fresh in-memory SQLite with
 * the real production schema, an in-process server with the real routers
 * («Mine ordrer» AND the producer's order page /produsent/ordre/:token).
 *
 *   hentet-*  «Hentet» on a confirmed / legacy ready order → completed,
 *             completion_source 'seller', through the shared action layer.
 *   same-*    the same resulting row as the producer page's «Hentet» on an
 *             equal fixture (status, completion_source, cancel_reason, the
 *             order_events row, the trust event) — only the channel differs.
 *   btn-*     the button is offered for confirmed/ready only.
 *   state-*   POST refused for pending / declined / cancelled; completed twice
 *             → nothing changes and a clear message.
 *   acc-*     another producer's order, no session, another session, Origin,
 *             the verified-owner gate.
 *   flag-*    «Hentet» is not behind a flag: the same with ORDER_AGENT_ACTIONS_
 *             ENABLED / ORDER_MESSAGES_ENABLED on or off; ORDER_AUTOCOMPLETE_
 *             ENABLED only changes the hint, not the button.
 *
 * Standalone: npx tsx src/routes/owner-orders-b3-hentet.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerOrdersB3HentetTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = [
    "ADMIN_KEY", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED", "ORDER_AUTOCOMPLETE_SINCE", "PAYMENTS_ENABLED",
    "ORDER_NO_SHOW_MIN_HOURS", "ORDER_AGENT_ACTIONS_ENABLED", "ORDER_MESSAGES_ENABLED", "OWNER_VERIFIED_OWNER_GATE_ENABLED",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  let server: http.Server | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    actionsSvc.__setOrderActionsTestDb(db as any);
    receiptSvc.__setBuyerReceiptSendForTesting(async () => ({ success: true, messageId: "stub" }));
    for (const k of ENV_KEYS) delete process.env[k];

    // ── Seed: two producers, two sessions ──────────────────────────────────
    for (const [id, name] of [["ag-b3", "Gård B3"], ["ag-b3x", "Gård B3X"]] as const) {
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
    const COOKIE_A = session("ag-b3", "sess-token-b3");
    const COOKIE_X = session("ag-b3x", "sess-token-b3x");

    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const ago = (h: number) => new Date(Date.now() - h * 3600_000);
    let seq = 0;
    function seedOrder(o: { agent?: string; status: string; cancelReason?: string | null; completion?: string | null; buyerName?: string }): string {
      const id = `b3-order-${++seq}`;
      const created = SQL(ago(30));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                            notify_sent_at, cancel_reason, completion_source, buyer_name, buyer_email, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pickup', ?, ?, 90, NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, o.agent ?? "ag-b3", `bref_${id}`, o.status, `ctok_${id}`, new Date(Date.now() + 86_400_000).toISOString(),
        created, o.cancelReason ?? null, o.completion ?? null, o.buyerName ?? `Kunde ${id}`, "kari.b3@example.com", created, SQL(ago(20)));
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 2, 45, 90)")
        .run(`${id}-i1`, id);
      if (o.status !== "pending") {
        db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, created_at)
                    VALUES (?, ?, 'pending', 'confirmed', 'producer', 'seller', 'producer_page', ?)`)
          .run(`${id}-e1`, id, SQL(ago(20)));
      }
      return id;
    }
    const row = (id: string) => db.prepare("SELECT status, cancel_reason, completion_source FROM orders WHERE id = ?").get(id) as any;
    const newEvents = (id: string) => db.prepare(
      "SELECT from_status, to_status, actor, actor_role, channel FROM order_events WHERE order_id = ? AND id NOT LIKE '%-e1' ORDER BY created_at, rowid",
    ).all(id) as any[];
    const trust = (id: string) => db.prepare("SELECT agent_id, event_type, completion_source FROM trust_events WHERE ref = ? ORDER BY rowid").all(id) as any[];

    // ── In-process server: «Mine ordrer» + the producer's order page ───────
    {
      const express = require("express");
      const ownerOrders = require("./owner-orders") as typeof import("./owner-orders");
      const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
      const cartRoutes = require("./marketplace-cart") as typeof import("./marketplace-cart");
      const app = express();
      app.use("/", ownerPortal.default);
      app.use("/", ownerOrders.default);
      app.use("/produsent/ordre", cartRoutes.producerOrderRouter);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; form?: Record<string, string> } = {}):
      Promise<{ status: number; text: string; location: string | undefined }> {
      return new Promise((resolve, reject) => {
        let bodyStr: string | undefined;
        const headers: Record<string, string> = { ...(o.headers || {}) };
        if (o.form) { bodyStr = new URLSearchParams(o.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
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
    const A = (p: string) => `/eier/ag-b3/ordrer${p}`;
    const settle = () => new Promise((r) => setTimeout(r, 40));
    /** The <details> row of one order in a page (to check per-row buttons). */
    function rowHtml(page: string, id: string): string {
      const start = page.indexOf(`<details class="mo-row" id="o-${id}"`);
      if (start < 0) return "";
      const end = page.indexOf("\n</details>", start);
      return page.slice(start, end < 0 ? undefined : end);
    }
    const HENTET_BTN = /<input type="hidden" name="action" value="complete">[\s\S]*?>Hentet<\/button>/;

    // ════════════════════════════════════════════════════════════════════════
    // «Hentet» on a confirmed order, and the same result as the order page
    // ════════════════════════════════════════════════════════════════════════
    {
      const viaPortal = seedOrder({ status: "confirmed", buyerName: "Portal Kunde" });
      const viaPage = seedOrder({ status: "confirmed", buyerName: "Ordreside Kunde" });

      const list = await req("GET", A("?tab=kommende"), { headers: { Cookie: COOKIE_A } });
      assertTrue(HENTET_BTN.test(rowHtml(list.text, viaPortal)), "hentet-01: a confirmed row in «Kommende henting» offers «Hentet»");
      assertTrue(rowHtml(list.text, viaPortal).includes(`action="/eier/ag-b3/ordrer/${viaPortal}"`), "hentet-02: the form posts to the existing «Mine ordrer» action route of that order");

      const r = await req("POST", A(`/${viaPortal}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete", idem: "b3-hentet-0001" } });
      await settle();
      assertEq(r.status, 303, "hentet-03: «Hentet» → 303 (post/redirect/get)");
      assertTrue((r.location || "").startsWith(`/eier/ag-b3/ordrer?tab=avsluttet&o=${viaPortal}`) && /done=completed/.test(r.location || "") && (r.location || "").endsWith(`#o-${viaPortal}`),
        "hentet-04: redirects to «Avsluttet» with the row anchor and done=completed");
      assertEq(row(viaPortal), { status: "completed", cancel_reason: null, completion_source: "seller" }, "hentet-05: the order is completed, completion_source 'seller' (the producer's own close)");
      assertEq(newEvents(viaPortal), [{ from_status: "confirmed", to_status: "completed", actor: "producer", actor_role: "seller", channel: "owner_portal" }],
        "hentet-06: ONE order_events row, seller via owner_portal");
      const after = await req("GET", r.location!.replace(/#.*/, ""), { headers: { Cookie: COOKIE_A } });
      assertTrue(after.text.includes("Ordren er registrert som hentet.") && rowHtml(after.text, viaPortal).includes(">Hentet</span>"),
        "hentet-07: the page after the redirect confirms it and the row's badge reads «Hentet»");

      // The producer's order page on an equal fixture.
      const p = await req("POST", `/produsent/ordre/ctok_${viaPage}`, { form: { action: "complete" } });
      await settle();
      assertTrue(p.status === 303 && /done=completed/.test(p.location || ""), "same-01: the order page's «Hentet» on the equal fixture → completed");
      assertEq(row(viaPortal), row(viaPage), "same-02: the same order row (status, cancel_reason, completion_source) as via the order page");
      const strip = (e: any[]) => e.map(({ channel: _c, ...rest }) => rest);
      assertEq(strip(newEvents(viaPortal)), strip(newEvents(viaPage)), "same-03: the same order_events row (from/to, actor, role) — only the channel differs");
      assertEq([newEvents(viaPortal)[0]?.channel, newEvents(viaPage)[0]?.channel], ["owner_portal", "producer_page"], "same-04: channels owner_portal vs producer_page");
      const tPortal = trust(viaPortal), tPage = trust(viaPage);
      assertTrue(tPortal.length >= 1 && tPortal.length === tPage.length && JSON.stringify(tPortal) === JSON.stringify(tPage), "same-05: the same trust events (order_completed) for both paths");

      // Second click (a fresh form key) on the completed order: harmless + clear message.
      const twice = await req("POST", A(`/${viaPortal}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete", idem: "b3-hentet-0002" } });
      await settle();
      assertTrue(twice.status === 303 && /error=allerede-hentet/.test(twice.location || "") && (twice.location || "").includes("tab=avsluttet"),
        "state-01: «Hentet» on an already completed order → back to «Avsluttet» with error=allerede-hentet");
      assertTrue(row(viaPortal).status === "completed" && newEvents(viaPortal).length === 1, "state-02: …and nothing changed (still one transition)");
      const msg = await req("GET", twice.location!.replace(/#.*/, ""), { headers: { Cookie: COOKIE_A } });
      assertTrue(msg.text.includes("Ordren er allerede registrert som hentet. Ingenting ble endret."), "state-03: the page says clearly that it was already picked up");
      // The same form key again (double submit) → the stored transition, no new one.
      const replay = await req("POST", A(`/${viaPortal}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete", idem: "b3-hentet-0001" } });
      await settle();
      assertTrue(/done=completed/.test(replay.location || "") && newEvents(viaPortal).length === 1, "state-04: the same form key twice → still one transition");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Legacy `ready`, and which statuses get the button
    // ════════════════════════════════════════════════════════════════════════
    {
      const ready = seedOrder({ status: "ready", buyerName: "Klar Kunde" });
      const pend = seedOrder({ status: "pending", buyerName: "Venter Kunde" });
      const decl = seedOrder({ status: "declined", buyerName: "Avslått Kunde" });
      const canc = seedOrder({ status: "cancelled", cancelReason: "buyer_cancelled", buyerName: "Kansellert Kunde" });
      const comp = seedOrder({ status: "completed", completion: "auto", buyerName: "Lukket Kunde" });

      const k = await req("GET", A("?tab=kommende"), { headers: { Cookie: COOKIE_A } });
      assertTrue(HENTET_BTN.test(rowHtml(k.text, ready)), "btn-01: a legacy `ready` row offers «Hentet»");
      const v = await req("GET", A("?tab=venter"), { headers: { Cookie: COOKIE_A } });
      assertTrue(rowHtml(v.text, pend) !== "" && !rowHtml(v.text, pend).includes('value="complete"'), "btn-02: no «Hentet» for pending");
      const a = await req("GET", A("?tab=avsluttet"), { headers: { Cookie: COOKIE_A } });
      for (const [id, label] of [[decl, "declined"], [canc, "cancelled"], [comp, "completed"]] as const) {
        assertTrue(rowHtml(a.text, id) !== "" && !rowHtml(a.text, id).includes('value="complete"'), `btn-03: no «Hentet» for ${label}`);
      }
      const tok = await req("GET", `/produsent/ordre/ctok_${pend}/kompakt`);
      assertTrue(tok.status === 200 && !tok.text.includes('value="complete"'), "btn-04: the e-mail token view of a pending order has no «Hentet» either");

      for (const [id, st] of [[pend, "pending"], [decl, "declined"], [canc, "cancelled"]] as const) {
        const before = row(id);
        const r = await req("POST", A(`/${id}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
        await settle();
        assertTrue(r.status === 303 && /error=ugyldig/.test(r.location || "") && JSON.stringify(row(id)) === JSON.stringify(before) && newEvents(id).length === 0,
          `state-05: POST «Hentet» on ${st} → refused (error=ugyldig), order unchanged, no event`);
      }
      const rc = await req("POST", A(`/${comp}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
      assertTrue(/error=allerede-hentet/.test(rc.location || "") && row(comp).completion_source === "auto", "state-06: an automatically closed order is not re-closed; completion_source stays 'auto'");

      const r = await req("POST", A(`/${ready}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
      await settle();
      assertTrue(/done=completed/.test(r.location || "") && row(ready).status === "completed" && row(ready).completion_source === "seller", "hentet-08: «Hentet» on legacy ready → completed (seller)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Access: IDOR, session, Origin, verified-owner gate
    // ════════════════════════════════════════════════════════════════════════
    {
      const mine = seedOrder({ status: "confirmed", buyerName: "Min Kunde" });
      const other = seedOrder({ agent: "ag-b3x", status: "confirmed", buyerName: "Annen Kunde" });

      const idor = await req("POST", A(`/${other}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
      assertTrue(idor.status === 404 && row(other).status === "confirmed", "acc-01: own session on another producer's order id → 404, order unchanged");
      const otherUrl = await req("POST", `/eier/ag-b3x/ordrer/${other}`, { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
      assertTrue(otherUrl.status === 403 && row(other).status === "confirmed", "acc-02: own session under the other producer's URL → 403");
      const noSess = await req("POST", A(`/${mine}`), { form: { action: "complete" } });
      assertTrue(noSess.status === 302 && noSess.location === "/eier/ag-b3" && row(mine).status === "confirmed", "acc-03: no session → login redirect, order unchanged");
      const wrongSess = await req("POST", A(`/${mine}`), { headers: { Cookie: COOKIE_X }, form: { action: "complete" } });
      assertTrue(wrongSess.status === 403 && row(mine).status === "confirmed", "acc-04: another producer's session → 403, order unchanged");
      const bogus = await req("POST", A(`/${mine}`), { headers: { Cookie: "rfb_owner_session=finnes-ikke" }, form: { action: "complete" } });
      assertTrue(bogus.status === 302 && row(mine).status === "confirmed", "acc-05: unknown session cookie → login, order unchanged");
      const token = await req("POST", A(`/${mine}`), { headers: { Cookie: `rfb_owner_session=ctok_${mine}` }, form: { action: "complete" } });
      assertTrue(token.status === 302 && row(mine).status === "confirmed", "acc-06: the order's e-mail token is no portal session");
      const cross = await req("POST", A(`/${mine}`), { headers: { Cookie: COOKIE_A, Origin: "https://evil.example" }, form: { action: "complete" } });
      assertTrue(cross.status === 403 && row(mine).status === "confirmed", "acc-07: cross-site Origin → 403, order unchanged");
      const crossTok = await req("POST", `/produsent/ordre/ctok_${mine}/kompakt`, { headers: { Origin: "https://evil.example" }, form: { action: "complete" } });
      assertTrue(crossTok.status === 403 && row(mine).status === "confirmed", "acc-08: cross-site Origin on the token view → 403");
      await req("GET", `${A(`/${mine}`)}?action=complete`, { headers: { Cookie: COOKIE_A } });
      await req("GET", A(`?tab=kommende&action=complete&o=${mine}`), { headers: { Cookie: COOKIE_A } });
      assertEq(row(mine).status, "confirmed", "acc-09: GET never completes an order");

      // S1b punkt 5: with the verified-owner gate on, an unclaimed profile is refused.
      process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED = "1";
      const gated = await req("POST", A(`/${mine}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
      assertTrue(gated.status === 403 && gated.text.includes("Eierskapet er ikke bekreftet") && row(mine).status === "confirmed",
        "acc-10: verified-owner gate on + unclaimed profile → 403, order unchanged");
      db.prepare("UPDATE agents SET claimed_at = datetime('now') WHERE id = 'ag-b3'").run();
      const sameOrigin = await req("POST", A(`/${mine}`), { headers: { Cookie: COOKIE_A, Origin: `http://127.0.0.1:${port}` }, form: { action: "complete" } });
      await settle();
      assertTrue(/done=completed/.test(sameOrigin.location || "") && row(mine).status === "completed" && row(mine).completion_source === "seller",
        "acc-11: gate on + claimed profile + same-origin post → completed (seller)");
      delete process.env.OWNER_VERIFIED_OWNER_GATE_ENABLED;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Flags: «Hentet» follows the other «Mine ordrer» seller actions (no flag)
    // ════════════════════════════════════════════════════════════════════════
    {
      const cases: Array<{ env: Record<string, string>; label: string }> = [
        { env: {}, label: "all order flags off" },
        { env: { ORDER_AGENT_ACTIONS_ENABLED: "1", ORDER_MESSAGES_ENABLED: "1" }, label: "fase B flags on" },
        { env: { ORDER_AUTOCOMPLETE_ENABLED: "1" }, label: "automatic close on" },
      ];
      for (const c of cases) {
        for (const k of ["ORDER_AGENT_ACTIONS_ENABLED", "ORDER_MESSAGES_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED"]) delete process.env[k];
        Object.assign(process.env, c.env);
        const id = seedOrder({ status: "confirmed", buyerName: `Flagg ${c.label}` });
        const page = await req("GET", A("?tab=kommende"), { headers: { Cookie: COOKIE_A } });
        const rh = rowHtml(page.text, id);
        assertTrue(HENTET_BTN.test(rh), `flag-01: «Hentet» is offered (${c.label})`);
        assertEq(rh.includes("Ordren avsluttes av seg selv etter henting."), c.env.ORDER_AUTOCOMPLETE_ENABLED === "1", `flag-02: the automatic-close hint follows ORDER_AUTOCOMPLETE_ENABLED only (${c.label})`);
        const r = await req("POST", A(`/${id}`), { headers: { Cookie: COOKIE_A }, form: { action: "complete" } });
        await settle();
        assertTrue(/done=completed/.test(r.location || "") && row(id).completion_source === "seller", `flag-03: «Hentet» completes the order (${c.label})`);
      }
      for (const k of ["ORDER_AGENT_ACTIONS_ENABLED", "ORDER_MESSAGES_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED"]) delete process.env[k];
    }
  } catch (err) {
    failed++;
    failures.push(`owner-orders-b3-hentet: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
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
  console.log("── owner-orders-b3-hentet tests ──");
  runOwnerOrdersB3HentetTests({ log: true }).then((r) => {
    console.log(`\nowner-orders-b3-hentet: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
