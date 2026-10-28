/**
 * owner-orders-fase-a2.test.ts — dev-request 2026-10-21-rfb-mine-ordrer-ett-
 * klikk-og-kjoperagent, FASE A2 («Mine ordrer» i eierportalen). No network, no
 * real e-mail, no production DB: a fresh in-memory SQLite with the real
 * production schema, an in-process server with the real routers.
 *
 *   AC3  /eier/:id/ordrer: no session → login redirect, another producer's
 *        session → 403; the tabs count right; actions PRG back to the row.
 *   AC4  the e-mail link opens the ONE order without a login and gives no
 *        access to other orders or to the portal.
 *   + access matrix, XSS escaping, entry card on the front page, the e-mail
 *     texts, the selger.html link.
 *
 * All times are relative to now. Standalone: npx tsx src/routes/owner-orders-fase-a2.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOwnerOrdersFaseA2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const ENV_KEYS = ["ADMIN_KEY", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED", "ORDER_AUTOCOMPLETE_SINCE", "PAYMENTS_ENABLED", "ORDER_NO_SHOW_MIN_HOURS"];
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
    for (const [id, name] of [["ag-a2", "Gård A2"], ["ag-b2", "Gård B2"]] as const) {
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
    const COOKIE_A = session("ag-a2", "sess-token-a2");
    const COOKIE_B = session("ag-b2", "sess-token-b2");

    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    const ago = (h: number) => new Date(Date.now() - h * 3600_000);
    let seq = 0;
    function seedOrder(o: {
      agent?: string; status: string; createdAt?: Date; pickup?: Date | null; confirmedAt?: Date; updatedAt?: Date;
      buyerName?: string | null; itemName?: string; extraItems?: number; note?: string | null; cancelReason?: string | null; completion?: string | null;
    }): string {
      const id = `a2-order-${++seq}`;
      const created = SQL(o.createdAt ?? ago(5));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                            notify_sent_at, cancel_reason, completion_source, buyer_name, buyer_email, delivery_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pickup', ?, ?, 90, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, o.agent ?? "ag-a2", `bref_${id}`, o.status, `ctok_${id}`, o.pickup ? o.pickup.toISOString() : null,
        created, o.cancelReason ?? null, o.completion ?? null,
        o.buyerName === undefined ? "Kari Nordmann" : o.buyerName, "kari.a2@example.com", o.note ?? null, created, SQL(o.updatedAt ?? o.createdAt ?? new Date()));
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, ?, 2, 45, 90)")
        .run(`${id}-i1`, id, o.itemName ?? "Poteter");
      for (let k = 0; k < (o.extraItems ?? 0); k++) {
        db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, ?, 1, 10, 10)")
          .run(`${id}-x${k}`, id, `Annen vare ${k}`);
      }
      if (o.confirmedAt) {
        db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_role, channel, created_at)
                    VALUES (?, ?, 'pending', 'confirmed', 'producer', 'seller', 'producer_page', ?)`)
          .run(`${id}-e1`, id, SQL(o.confirmedAt));
      }
      return id;
    }
    const row = (id: string) => db.prepare("SELECT status, cancel_reason, pickup_time FROM orders WHERE id = ?").get(id) as any;
    const events = (id: string) => db.prepare("SELECT to_status, actor_role, channel FROM order_events WHERE order_id = ? ORDER BY created_at, rowid").all(id) as any[];
    /** datetime-local value (Oslo time) `days` ahead at 15:30 — relative to now. */
    function futureLocal(days: number): string {
      const d = new Date(Date.now() + days * 86_400_000);
      return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) + "T15:30";
    }

    // ── In-process server with the real routers ────────────────────────────
    {
      const express = require("express");
      const ownerOrders = require("./owner-orders") as typeof import("./owner-orders");
      const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
      const app = express();
      app.use("/", ownerPortal.default);
      app.use("/", ownerOrders.default);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    }
    const port = (server!.address() as any).port as number;
    function req(method: string, urlPath: string, o: { headers?: Record<string, string>; form?: Record<string, string> } = {}):
      Promise<{ status: number; text: string; location: string | undefined; setCookie: string | undefined }> {
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
            location: resp.headers["location"] as string | undefined, setCookie: resp.headers["set-cookie"] ? String(resp.headers["set-cookie"]) : undefined,
          }));
        });
        r.on("error", reject);
        if (bodyStr) r.write(bodyStr);
        r.end();
      });
    }
    const A = (p: string) => `/eier/ag-a2/ordrer${p}`;
    const settle = () => new Promise((r) => setTimeout(r, 40));

    // ════════════════════════════════════════════════════════════════════════
    // Tabs: content, ordering, counts
    // ════════════════════════════════════════════════════════════════════════
    const pOld = seedOrder({ status: "pending", createdAt: ago(30), buyerName: "Eldst Kunde" });
    const pNew = seedOrder({ status: "pending", createdAt: ago(2), buyerName: "Nyest Kunde", extraItems: 1 });
    const pMid = seedOrder({ status: "pending", createdAt: ago(10), buyerName: "Midt Kunde", extraItems: 3 });
    const cLate = seedOrder({ status: "confirmed", confirmedAt: ago(3), pickup: new Date(Date.now() + 5 * 86_400_000), buyerName: "Sen Henting" });
    const cSoon = seedOrder({ status: "confirmed", confirmedAt: ago(3), pickup: new Date(Date.now() + 1 * 86_400_000), buyerName: "Tidlig Henting" });
    const cReady = seedOrder({ status: "ready", confirmedAt: ago(3), pickup: new Date(Date.now() + 2 * 86_400_000), buyerName: "Gammel Klar" });
    seedOrder({ status: "completed", completion: "auto", updatedAt: ago(1), buyerName: "Auto Lukket" });
    seedOrder({ status: "declined", updatedAt: ago(2) });
    seedOrder({ status: "cancelled", cancelReason: "no_show", updatedAt: ago(3) });
    // The other producer's orders must never show up.
    const otherOrder = seedOrder({ agent: "ag-b2", status: "pending", buyerName: "Hemmelig Annen Kunde" });

    {
      const r = await req("GET", A("?tab=venter"), { headers: { Cookie: COOKIE_A } });
      assertEq(r.status, 200, "tab-01: list with a session → 200");
      const order = [r.text.indexOf("Eldst Kunde"), r.text.indexOf("Midt Kunde"), r.text.indexOf("Nyest Kunde")];
      assertTrue(order.every((i) => i > 0) && order[0]! < order[1]! && order[1]! < order[2]!, "tab-02: «Venter på svar» is oldest first");
      assertTrue(/Venter på svar<span class="mo-count">3<\/span>/.test(r.text), "tab-03: «Venter på svar» counter = 3");
      assertTrue(/Kommende henting<span class="mo-count">3<\/span>/.test(r.text), "tab-04: «Kommende henting» counter = 3 (confirmed + legacy ready)");
      assertTrue(/Avsluttet<span class="mo-count">3<\/span>/.test(r.text), "tab-05: «Avsluttet» counter = 3");
      assertTrue(!r.text.includes("Hemmelig Annen Kunde"), "tab-06: another producer's order is not listed");
      assertTrue(r.text.includes("2 × Poteter + 1 annen") && r.text.includes("2 × Poteter + 3 andre"), "tab-07: compact items line «2 × Poteter + 1 annen» / «+ 3 andre»");
      assertTrue(r.text.includes('aria-current="page"') && /Venter på svar<span/.test(r.text), "tab-08: current tab marked");
      assertTrue((r.text.match(/class="mo-row"/g) || []).length === 3, "tab-09: three rows in the first tab");
      assertTrue(r.text.includes('<meta name="robots" content="noindex, nofollow">') && r.text.includes('name="viewport"'), "tab-10: noindex + mobile viewport");

      const k = await req("GET", A("?tab=kommende"), { headers: { Cookie: COOKIE_A } });
      const ko = [k.text.indexOf("Tidlig Henting"), k.text.indexOf("Gammel Klar"), k.text.indexOf("Sen Henting")];
      assertTrue(ko.every((i) => i > 0) && ko[0]! < ko[1]! && ko[1]! < ko[2]!, "tab-11: «Kommende henting» sorted by pickup time");
      assertTrue(!k.text.includes("Eldst Kunde"), "tab-12: pending orders are not in «Kommende henting»");
      const a = await req("GET", A("?tab=avsluttet"), { headers: { Cookie: COOKIE_A } });
      assertTrue(a.text.includes("Avsluttet automatisk") && a.text.includes("Avslått") && a.text.includes("Kunden kom ikke"), "tab-13: «Avsluttet» shows auto-close, declined and no-show labels");
      const d = await req("GET", A(""), { headers: { Cookie: COOKIE_A } });
      assertTrue(d.text.includes("Eldst Kunde"), "tab-14: default tab with waiting orders = «Venter på svar»");
      // Buttons: pending → Bekreft/Avslå + optional pickup time; confirmed → menu with the three exceptions.
      assertTrue(/value="confirm"/.test(r.text) && /value="decline"/.test(r.text) && r.text.includes('name="pickup_time"'), "tab-15: pending rows: Bekreft (+ valgfri hentetid) and Avslå");
      assertTrue(!/value="no_show"/.test(r.text), "tab-16: pending rows have no exception menu");
      const tomorrow = await req("GET", A("?tab=kommende"), { headers: { Cookie: COOKIE_A } });
      assertTrue(/value="buyer_cancelled"/.test(tomorrow.text) && /value="cannot_deliver"/.test(tomorrow.text) && tomorrow.text.includes("Flere valg"), "tab-17: confirmed rows: menu with «Kunden avbestilte» / «Kan ikke levere»");
      assertTrue(!/value="no_show"/.test(tomorrow.text) && tomorrow.text.includes("kan registreres fra"), "tab-18: «Kunden kom ikke» is not offered before the pickup time");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC3 — access matrix
    // ════════════════════════════════════════════════════════════════════════
    {
      const noSess = await req("GET", A(""));
      assertTrue(noSess.status === 302 && noSess.location === "/eier/ag-a2" && !noSess.text.includes("Eldst Kunde"), "ac3-01: no session → login page (302), no data");
      const wrong = await req("GET", A(""), { headers: { Cookie: COOKIE_B } });
      assertTrue(wrong.status === 403 && !wrong.text.includes("Eldst Kunde"), "ac3-02: another producer's session → 403, no data");
      const bogus = await req("GET", A(""), { headers: { Cookie: "rfb_owner_session=finnes-ikke" } });
      assertEq(bogus.status, 302, "ac3-03: unknown session cookie → login");
      // The per-order token is NOT a session.
      const tokenAsBearer = await req("GET", A(""), { headers: { Authorization: `Bearer ctok_${pOld}` } });
      assertEq(tokenAsBearer.status, 302, "ac3-04: an order token does not open the portal list");

      const before = row(pOld).status;
      const post0 = await req("POST", A(`/${pOld}`), { form: { action: "confirm" } });
      assertTrue(post0.status === 302 && row(pOld).status === before, "ac3-05: POST without session → login, order unchanged");
      const post1 = await req("POST", A(`/${pOld}`), { headers: { Cookie: COOKIE_B }, form: { action: "confirm" } });
      assertTrue(post1.status === 403 && row(pOld).status === before, "ac3-06: POST with another producer's session → 403, order unchanged");
      const post2 = await req("POST", A(`/${otherOrder}`), { headers: { Cookie: COOKIE_A }, form: { action: "confirm" } });
      assertTrue(post2.status === 404 && row(otherOrder).status === "pending", "ac3-07: own session on ANOTHER producer's order id → 404, order unchanged");
      const post3 = await req("POST", `/eier/ag-b2/ordrer/${otherOrder}`, { headers: { Cookie: COOKIE_A }, form: { action: "confirm" } });
      assertTrue(post3.status === 403 && row(otherOrder).status === "pending", "ac3-08: own session posting under the other producer's URL → 403");
      const cross = await req("POST", A(`/${pOld}`), { headers: { Cookie: COOKIE_A, Origin: "https://evil.example" }, form: { action: "confirm" } });
      assertTrue(cross.status === 403 && row(pOld).status === before, "ac3-09: cross-site form post → 403, order unchanged");
      const bad = await req("POST", A(`/${pOld}`), { headers: { Cookie: COOKIE_A }, form: { action: "withdraw" } });
      assertTrue(bad.status === 303 && /error=ugyldig/.test(bad.location || "") && row(pOld).status === before, "ac3-10: buyer actions / unknown actions are refused");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC3 — actions with PRG back to the right row
    // ════════════════════════════════════════════════════════════════════════
    {
      const local = futureLocal(2);
      const r = await req("POST", A(`/${pOld}`), { headers: { Cookie: COOKIE_A }, form: { action: "confirm", pickup_time: local, idem: "prg-key-0001" } });
      await settle();
      assertEq(r.status, 303, "prg-01: action → 303 (post/redirect/get)");
      assertTrue((r.location || "").startsWith(`/eier/ag-a2/ordrer?tab=kommende&o=${pOld}`) && (r.location || "").endsWith(`#o-${pOld}`) && /done=confirmed/.test(r.location || ""),
        "prg-02: redirects to the tab where the order now lives, with its row id");
      assertEq(row(pOld).status, "confirmed", "prg-03: the order is confirmed");
      assertTrue(!!row(pOld).pickup_time, "prg-04: the optional pickup time was stored");
      const ev = events(pOld);
      assertTrue(ev.length === 1 && ev[0].to_status === "confirmed" && ev[0].actor_role === "seller" && ev[0].channel === "owner_portal", "prg-05: ONE order_events row, role seller, channel owner_portal");
      const page = await req("GET", r.location!.replace(/#.*/, ""), { headers: { Cookie: COOKIE_A } });
      const m = new RegExp(`<details class="mo-row" id="o-${pOld}" open>`).test(page.text);
      assertTrue(m && page.text.includes("Ordren er bekreftet."), "prg-06: the GET after the redirect shows the same row unfolded and a confirmation");
      // Same form key twice → one transition.
      const again = await req("POST", A(`/${pOld}`), { headers: { Cookie: COOKIE_A }, form: { action: "confirm", idem: "prg-key-0001" } });
      await settle();
      assertTrue(/done=confirmed/.test(again.location || "") && events(pOld).length === 1, "prg-07: the same idempotency key twice → still one transition");
      // Counters moved.
      const after = await req("GET", A("?tab=venter"), { headers: { Cookie: COOKIE_A } });
      assertTrue(/Venter på svar<span class="mo-count">2<\/span>/.test(after.text) && /Kommende henting<span class="mo-count">4<\/span>/.test(after.text), "prg-08: counters follow the action (2 waiting, 4 coming)");

      // Decline → the Avsluttet tab.
      const dcl = await req("POST", A(`/${pNew}`), { headers: { Cookie: COOKIE_A }, form: { action: "decline" } });
      await settle();
      assertTrue((dcl.location || "").includes("tab=avsluttet") && row(pNew).status === "declined", "prg-09: «Avslå» → declined, back to the «Avsluttet» tab");

      // Invalid pickup time → error banner on the same row, order unchanged.
      const badPick = await req("POST", A(`/${pMid}`), { headers: { Cookie: COOKIE_A }, form: { action: "confirm", pickup_time: "i morgen" } });
      assertTrue((badPick.location || "").includes("tab=venter") && /error=hentetid/.test(badPick.location || "") && row(pMid).status === "pending", "prg-10: invalid pickup time → back to the row with an error, order unchanged");
      const errPage = await req("GET", badPick.location!.replace(/#.*/, ""), { headers: { Cookie: COOKIE_A } });
      assertTrue(errPage.text.includes("Hentetiden er ikke gyldig") && errPage.text.includes(`id="o-${pMid}" open`), "prg-11: the error page shows the message and the row unfolded");

      // Exceptions on a confirmed order.
      const ca = await req("POST", A(`/${cSoon}`), { headers: { Cookie: COOKIE_A }, form: { action: "cannot_deliver" } });
      await settle();
      assertTrue(row(cSoon).status === "cancelled" && row(cSoon).cancel_reason === "producer_cancelled" && (ca.location || "").includes("tab=avsluttet"), "prg-12: «Kan ikke levere» → cancelled (producer_cancelled)");
      const bc = await req("POST", A(`/${cLate}`), { headers: { Cookie: COOKIE_A }, form: { action: "buyer_cancelled" } });
      await settle();
      assertTrue(row(cLate).status === "cancelled" && row(cLate).cancel_reason === "buyer_cancelled", "prg-13: «Kunden avbestilte» → cancelled (buyer_cancelled)");
      const early = await req("POST", A(`/${cReady}`), { headers: { Cookie: COOKIE_A }, form: { action: "no_show" } });
      assertTrue(/error=ugyldig/.test(early.location || "") && row(cReady).status === "ready", "prg-14: «Kunden kom ikke» before the pickup time is refused by the shared layer");
      const past = seedOrder({ status: "confirmed", confirmedAt: ago(30), pickup: ago(5), buyerName: "Kom Ikke" });
      const pageNs = await req("GET", A("?tab=kommende"), { headers: { Cookie: COOKIE_A } });
      assertTrue(pageNs.text.includes('value="no_show"'), "prg-15: after the pickup time the «Kunden kom ikke» button is offered");
      const ns = await req("POST", A(`/${past}`), { headers: { Cookie: COOKIE_A }, form: { action: "no_show" } });
      await settle();
      assertTrue(row(past).status === "cancelled" && row(past).cancel_reason === "no_show", "prg-16: «Kunden kom ikke» after the pickup time → cancelled (no_show)");
      assertEq(db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE actor_role IS NULL OR channel IS NULL").get() as any, { n: 0 }, "prg-17: every order_events row has actor_role and channel");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC4 — the e-mail link (per-order token)
    // ════════════════════════════════════════════════════════════════════════
    {
      const t1 = seedOrder({ status: "pending", buyerName: "Token Kunde Ett" });
      const t2 = seedOrder({ status: "pending", buyerName: "Token Kunde To" });
      const K = (id: string) => `/produsent/ordre/ctok_${id}/kompakt`;
      const v = await req("GET", K(t1));
      assertEq(v.status, 200, "ac4-01: the e-mail link opens without a login");
      assertTrue(v.text.includes("Token Kunde Ett") && v.text.includes(`id="o-${t1}" open`) && v.text.includes('value="confirm"'), "ac4-02: shows that order, unfolded, with Bekreft/Avslå");
      assertTrue(!v.text.includes("Token Kunde To") && !v.text.includes(t2) && !v.text.includes("Eldst Kunde") && !v.text.includes("Gård B2"), "ac4-03: no data about any other order");
      assertTrue(!v.setCookie, "ac4-04: the token view sets no cookie (no session is created)");
      assertTrue(v.text.includes('href="/eier/ag-a2/ordrer">Se alle ordrene dine'), "ac4-05: «Se alle ordrene dine» links to the login-protected list");
      // The token gives no access to the portal or the list.
      const list = await req("GET", A("?tab=venter"), { headers: { Cookie: `rfb_owner_session=ctok_${t1}` } });
      assertEq(list.status, 302, "ac4-06: the token is no portal session (list → login)");
      const portal = await req("GET", "/eier/ag-a2/portal", { headers: { Cookie: `rfb_owner_session=ctok_${t1}` } });
      assertEq(portal.status, 302, "ac4-07: …nor a portal session (portal → login)");
      assertEq((await req("GET", "/produsent/ordre/ctok_finnes-ikke/kompakt")).status, 404, "ac4-08: an unknown token → 404");
      // A token acts on its own order only; a forged order id in the body is ignored.
      const act = await req("POST", K(t1), { form: { action: "confirm", order_id: t2, orderId: t2, pickup_time: futureLocal(3) } });
      await settle();
      assertTrue(act.status === 303 && (act.location || "") === `${K(t1)}?done=confirmed`, "ac4-09: action by token → 303 back to the same view");
      assertTrue(row(t1).status === "confirmed" && row(t2).status === "pending", "ac4-10: only the token's own order changed");
      const e1 = events(t1);
      assertTrue(e1.length === 1 && e1[0].actor_role === "seller" && e1[0].channel === "producer_page", "ac4-11: event: seller via producer_page");
      const done = await req("GET", `${K(t1)}?done=confirmed`);
      assertTrue(done.text.includes("Ordren er bekreftet.") && done.text.includes("mo-ok\">Bekreftet"), "ac4-12: the view shows the new status after the redirect");
      const tokenOnList = await req("POST", `/eier/ag-a2/ordrer/${t2}`, { headers: { Cookie: `rfb_owner_session=ctok_${t1}` }, form: { action: "confirm" } });
      assertTrue(tokenOnList.status === 302 && row(t2).status === "pending", "ac4-13: the token cannot act on other orders through the portal route");
      const csx = await req("POST", K(t2), { headers: { Origin: "https://evil.example" }, form: { action: "decline" } });
      assertTrue(csx.status === 403 && row(t2).status === "pending", "ac4-14: cross-site post to the token view → 403");
      // Not a mutation on GET (mail scanners prefetch links).
      await req("GET", `${K(t2)}?action=confirm`);
      assertEq(row(t2).status, "pending", "ac4-15: GET never changes an order");
    }

    // ════════════════════════════════════════════════════════════════════════
    // XSS — all user data is escaped
    // ════════════════════════════════════════════════════════════════════════
    {
      const evil = `<script>alert('x')</script>`;
      const x = seedOrder({ status: "pending", buyerName: `${evil}"><img src=x onerror=alert(1)>`, itemName: `<b onmouseover=alert(2)>Vare</b>`, note: `${evil}<svg onload=alert(3)>` });
      const page = await req("GET", A("?tab=venter"), { headers: { Cookie: COOKIE_A } });
      assertTrue(!page.text.includes("<script>alert") && !page.text.includes("<img src=x") && !page.text.includes("<b onmouseover") && !page.text.includes("<svg onload"), "xss-01: the list contains no raw markup from buyer name / item / note");
      assertTrue(page.text.includes("&lt;script&gt;alert(&#039;x&#039;)&lt;/script&gt;") && page.text.includes("&lt;b onmouseover=alert(2)&gt;Vare&lt;/b&gt;"), "xss-02: …but the escaped text is shown");
      const tok = await req("GET", `/produsent/ordre/ctok_${x}/kompakt`);
      assertTrue(!tok.text.includes("<script>alert") && !tok.text.includes("<img src=x") && !tok.text.includes("<svg onload"), "xss-03: the token view escapes as well");
      const inj = await req("GET", A(`?tab=venter&o=${encodeURIComponent('"><script>alert(9)</script>')}&done=${encodeURIComponent("<i>x</i>")}&error=${encodeURIComponent("<u>y</u>")}`), { headers: { Cookie: COOKIE_A } });
      assertTrue(!inj.text.includes("<script>alert(9)") && !inj.text.includes("<i>x</i>") && !inj.text.includes("<u>y</u>"), "xss-04: query parameters are never reflected as markup");
      db.prepare("UPDATE agents SET name = ? WHERE id = 'ag-a2'").run(`Gård <script>alert(5)</script>`);
      const named = await req("GET", A("?tab=venter"), { headers: { Cookie: COOKIE_A } });
      assertTrue(!named.text.includes("<script>alert(5)"), "xss-05: the producer name is escaped");
      db.prepare("UPDATE agents SET name = 'Gård A2' WHERE id = 'ag-a2'").run();
      db.prepare("UPDATE orders SET status = 'declined' WHERE id = ?").run(x); // keep later tab counts stable
    }

    // ════════════════════════════════════════════════════════════════════════
    // Entry from the front page + selger.html + e-mail texts
    // ════════════════════════════════════════════════════════════════════════
    {
      const waiting = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = 'ag-a2' AND status = 'pending'").get() as any).n;
      const portal = await req("GET", "/eier/ag-a2/portal", { headers: { Cookie: COOKIE_A } });
      assertTrue(portal.status === 200 && portal.text.includes('href="/eier/ag-a2/ordrer"') && portal.text.includes(`${waiting} venter på svar`), "entry-01: the portal front page shows «Mine ordrer» with the number waiting");
      const html = fs.readFileSync(path.join(__dirname, "..", "public", "selger.html"), "utf8");
      assertTrue(html.includes('id="ordersMineLink"') && html.includes("'/ordrer'"), "entry-02: the «Bestillinger» tab in selger.html links to Mine ordrer");
      assertTrue(view.ownerOrdersEntryCardHtml("ag-a2", 0).includes("Åpne Mine ordrer") && !view.ownerOrdersEntryCardHtml("ag-a2", 0).includes("venter på svar</span>"), "entry-03: no waiting orders → no counter");

      const input = {
        order_id: "abcd1234-0000-0000-0000-000000000000", agent_id: "ag-a2", producer_name: "Gård A2", buyer_ref: "bref_x", confirm_token: "tok123",
        pickup_time: null, total_nok: 90, items: [{ name: "Poteter", qty: 2, unit: null, line_total: 90 }],
      };
      const off = notifySvc.renderOrderNotificationEmailV2(input);
      assertTrue(off.htmlContent.includes(">Se og bekreft bestillingen</a>") && off.htmlContent.includes("/produsent/ordre/tok123/kompakt"), "mail-01: main button «Se og bekreft bestillingen» → compact per-order view");
      assertTrue(off.htmlContent.includes("/eier/ag-a2/ordrer") && off.textContent.includes("Se alle ordrene dine (krever innlogging)"), "mail-02: «Se alle ordrene dine» → login-protected list");
      assertTrue(!off.textContent.includes("avsluttes av seg selv"), "mail-03: switch off → no promise of an automatic close");
      process.env.ORDER_AUTOCOMPLETE_ENABLED = "1";
      const on = notifySvc.renderOrderNotificationEmailV2(input);
      assertTrue(on.textContent.includes("Du trenger bare å bekrefte eller avslå. Ordren avsluttes av seg selv etter henting.") && on.htmlContent.includes("Ordren avsluttes av seg selv etter henting."), "mail-04: switch on → the sentence is in text and html");
      const rem = notifySvc.renderOrderNotificationEmailV2({ ...input, reminder: true });
      assertTrue(rem.htmlContent.includes("Se og bekreft bestillingen") && rem.htmlContent.includes("/kompakt") && !rem.textContent.includes("avsluttes av seg selv"), "mail-05: the reminder links to the same place, without the sentence");
      const v1 = notifySvc.renderOrderNotificationEmailV1(input);
      assertTrue(!v1.htmlContent.includes("/kompakt") && v1.htmlContent.includes("Bekreft eller avslå ordren her"), "mail-06: v1 stays byte-for-byte the old template");
      delete process.env.ORDER_AUTOCOMPLETE_ENABLED;
    }
  } catch (err) {
    failed++;
    failures.push(`owner-orders-fase-a2: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
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
  console.log("── owner-orders-fase-a2 tests ──");
  runOwnerOrdersFaseA2Tests({ log: true }).then((r) => {
    console.log(`\nowner-orders-fase-a2: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) { console.log(r.failures.join("\n")); process.exit(1); }
    process.exit(0);
  });
}
