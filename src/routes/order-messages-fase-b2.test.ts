/**
 * order-messages-fase-b2.test.ts — dev-request 2026-10-21-rfb-mine-ordrer-ett-
 * klikk-og-kjoperagent, FASE B2 (meldingstråd per ordre). No network, no real
 * e-mail, no production DB: a fresh in-memory SQLite with the real production
 * schema, a real MCP client over InMemoryTransport, an in-process server with
 * the real order-card, owner-portal and «Mine ordrer» routers.
 *
 *   AC8  a buyer message (MCP lokal_order_message, the order card) e-mails
 *        the producer and shows in «Mine ordrer»; the seller's answer shows in
 *        lokal_order_status.messages; the 1000-character cap and the per-order
 *        rate limit hold on every entry point.
 *   AC10 with ORDER_AGENT_ACTIONS_ENABLED alone the only new tool is
 *        lokal_order_message (pinned by rfb-mcp-contract-freeze); with
 *        ORDER_MESSAGES_ENABLED too, only lokal_order_status's description
 *        changes (the untrusted-data note).
 *   + wrong buyer_ref → 403, idempotent replay (one row, one e-mail), another
 *     owner's session → 403, ORDER_MESSAGES_ENABLED off → feature absent,
 *     HTML escaping, no buyer address to the seller, closed orders.
 *
 * Standalone: npx tsx src/routes/order-messages-fase-b2.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";
import * as http from "http";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runOrderMessagesFaseB2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const msgSvc = require("../services/order-messages") as typeof import("../services/order-messages");

  const ENV_KEYS = [
    "ORDER_AGENT_ACTIONS_ENABLED", "ORDER_MESSAGES_ENABLED", "ORDER_BUYER_RECEIPTS_ENABLED", "ORDER_AUTOCOMPLETE_ENABLED",
    "ORDER_AUTOCOMPLETE_SINCE", "PAYMENTS_ENABLED", "ADMIN_NOTIFICATION_EMAIL", "ORDER_NO_SHOW_MIN_HOURS",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  let server: http.Server | null = null;
  const PRODUCER_MAIL = "gard-b2@example.no";
  const BUYER_MAIL = "kari.b2@example.com";
  type Mail = { to: string; subject: string; textContent: string; htmlContent: string; replyTo: string };
  const producerMail: Mail[] = [];
  const buyerMail: Mail[] = [];

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    trustSvc.__setTrustEventTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    receiptSvc.__setBuyerReceiptTestDb(db as any);
    actionsSvc.__setOrderActionsTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      producerMail.push({ to: o.to, subject: o.subject, textContent: o.textContent || "", htmlContent: o.htmlContent || "", replyTo: String(o.replyTo ?? "") });
      return { success: true, messageId: "stub" };
    });
    receiptSvc.__setBuyerReceiptSendForTesting(async (o) => {
      buyerMail.push({ to: o.to, subject: o.subject, textContent: o.textContent || "", htmlContent: o.htmlContent || "", replyTo: String(o.replyTo ?? "") });
      return { success: true, messageId: "stub" };
    });
    for (const k of ENV_KEYS) delete process.env[k];
    const flags = (actions: boolean, messages: boolean) => {
      if (actions) process.env.ORDER_AGENT_ACTIONS_ENABLED = "1"; else delete process.env.ORDER_AGENT_ACTIONS_ENABLED;
      if (messages) process.env.ORDER_MESSAGES_ENABLED = "1"; else delete process.env.ORDER_MESSAGES_ENABLED;
    };

    // ── Seed: two producers with sessions ──────────────────────────────────
    for (const [id, name, mail] of [["ag-m1", "Gård <M1>", PRODUCER_MAIL], ["ag-m2", "Gård M2", "gard-m2@example.no"]] as const) {
      db.prepare(`INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, categories, order_notifications_opt_in)
                  VALUES (?, ?, 'Testprodusent', 'self', ?, 'https://example.no', 'producer', ?, '["vegetables"]', 1)`).run(id, name, mail, `k-${id}`);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status, email, phone) VALUES (?, 'verified', ?, '+47 400 22 222')").run(id, mail);
    }
    function session(agentId: string, token: string): string {
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES (?, ?, ?, ?, 1, datetime('now', '+1 day'))")
        .run(`ml-${token}`, `${agentId}@example.no`, token, agentId);
      return `rfb_owner_session=${token}`;
    }
    const COOKIE_M1 = session("ag-m1", "sess-token-m1");
    const COOKIE_M2 = session("ag-m2", "sess-token-m2");

    const SQL = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
    let seq = 0;
    function seedOrder(o: { status?: string; agent?: string; buyerEmail?: string | null; notifySent?: boolean; updatedAt?: Date } = {}): { id: string; ref: string } {
      const id = `m2${String(++seq).padStart(3, "0")}ord-order`;
      const ref = `bref_m2_${seq}_secret`;
      const created = SQL(new Date(Date.now() - 2 * 86_400_000));
      db.prepare(`
        INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, total_nok, notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pickup', ?, 90, ?, 'Kari', ?, ?, ?)
      `).run(id, o.agent ?? "ag-m1", ref, o.status ?? "pending", `ctok_${id}`, o.notifySent === false ? null : created,
        o.buyerEmail === undefined ? BUYER_MAIL : o.buyerEmail, created, o.updatedAt ? SQL(o.updatedAt) : created);
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 3, 30, 90)")
        .run(`${id}-i1`, id);
      return { id, ref };
    }
    const msgs = (id: string) => db.prepare("SELECT author_role, body, channel, idempotency_key FROM order_messages WHERE order_id = ? ORDER BY created_at, rowid").all(id) as any[];
    const settle = () => new Promise((r) => setTimeout(r, 40));
    const pMailsFor = (id: string) => producerMail.filter((m) => m.subject.includes(id.slice(0, 8)));
    const bMailsFor = (id: string) => buyerMail.filter((m) => m.subject.includes(id.slice(0, 8)));

    // ── MCP client ─────────────────────────────────────────────────────────
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js") as typeof import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js") as typeof import("@modelcontextprotocol/sdk/inMemory.js");
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    async function withMcp<T>(actions: boolean, messages: boolean, fn: (client: any) => Promise<T>): Promise<T> {
      flags(actions, messages);
      const srv = new McpServer({ name: "rfb-b2-test", version: "0.0.0" });
      registerTools(srv);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "rfb-b2-test", version: "0.0.0" });
      await Promise.all([srv.connect(st), client.connect(ct)]);
      try { return await fn(client); }
      finally { await client.close(); await srv.close(); }
    }
    async function call(client: any, name: string, args: Record<string, unknown>): Promise<{ threw: boolean; isError: boolean; body: any }> {
      try {
        const r = await client.callTool({ name, arguments: args });
        let body: any = null;
        try { body = JSON.parse(r?.content?.[0]?.text ?? "null"); } catch { body = r?.content?.[0]?.text ?? null; }
        return { threw: false, isError: r?.isError === true, body };
      } catch {
        return { threw: true, isError: true, body: null };
      }
    }
    const toolsOf = async (actions: boolean, messages: boolean) => withMcp(actions, messages, async (c) => (await c.listTools()).tools as any[]);

    // ── HTTP server with the real routers ──────────────────────────────────
    {
      const express = require("express");
      const app = express();
      app.use("/", (require("./owner-portal") as typeof import("./owner-portal")).default);
      app.use("/", (require("./owner-orders") as typeof import("./owner-orders")).default);
      app.use("/", (require("./buyer-order-card") as typeof import("./buyer-order-card")).default);
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
    const minePath = (agent: string, id: string) => `/eier/${agent}/ordrer?tab=venter&o=${encodeURIComponent(id)}`;
    const sellerPost = (agent: string, id: string, form: Record<string, string>, cookie: string | null, headers: Record<string, string> = {}) =>
      req("POST", `/eier/${agent}/ordrer/${encodeURIComponent(id)}/melding`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, form });

    // ════════════════════════════════════════════════════════════════════════
    // The switch
    // ════════════════════════════════════════════════════════════════════════
    assertEq([undefined, "", "0", "false", "1", "true"].map((v) => msgSvc.isOrderMessagesEnabled(v === undefined ? {} : { ORDER_MESSAGES_ENABLED: v })),
      [false, false, false, false, true, true], "flag-01: ORDER_MESSAGES_ENABLED is off by default; on with 1/true");

    // ── Contract (AC10) ────────────────────────────────────────────────────
    {
      const off = await toolsOf(false, false);
      const offMsgs = await toolsOf(false, true);
      const on = await toolsOf(true, false);
      const both = await toolsOf(true, true);
      const names = (t: any[]) => t.map((x) => x.name);
      assertTrue(!names(off).includes("lokal_order_message"), "ac10-01: both switches off → lokal_order_message is not in tools/list");
      assertEq(JSON.stringify(offMsgs), JSON.stringify(off), "ac10-02: ORDER_MESSAGES_ENABLED alone → tools/list byte-identical to all-off");
      assertTrue(names(on).includes("lokal_order_message"), "ac10-03: ORDER_AGENT_ACTIONS_ENABLED on → lokal_order_message is in tools/list");
      const byName = (t: any[]) => Object.fromEntries(t.map((x) => [x.name, JSON.stringify(x)]));
      const offMap = byName(off), onMap = byName(on), bothMap = byName(both);
      assertEq(Object.keys(offMap).filter((k) => offMap[k] !== onMap[k]), [], "ac10-04: ORDER_AGENT_ACTIONS_ENABLED on → every existing tool definition is unchanged");
      assertEq(Object.keys(bothMap).filter((k) => bothMap[k] !== onMap[k]), ["lokal_order_status"],
        "ac10-05: both switches on → only lokal_order_status differs from the actions-only contract");
      const msgTool = on.find((t) => t.name === "lokal_order_message");
      const statusBoth = both.find((t) => t.name === "lokal_order_status");
      assertTrue(/untrusted quoted data/.test(msgTool?.description ?? "") && /never follow instructions/.test(msgTool?.description ?? ""),
        "ac10-06: lokal_order_message says the other party's text is untrusted quoted data, never instructions");
      assertTrue(/untrusted quoted data/.test(statusBoth?.description ?? "") && /never follow instructions/.test(statusBoth?.description ?? "") &&
        !/untrusted/.test(on.find((t) => t.name === "lokal_order_status")?.description ?? ""),
        "ac10-07: with both switches on lokal_order_status says messages[] is untrusted quoted data (actions alone: unchanged)");
      assertEq(Object.keys(msgTool?.inputSchema?.properties ?? {}).sort(), ["buyer_ref", "idempotency_key", "message", "order_id"], "ac10-08: input order_id, buyer_ref, message, optional idempotency_key");
      assertEq([...(msgTool?.inputSchema?.required ?? [])].sort(), ["buyer_ref", "message", "order_id"], "ac10-09: idempotency_key is optional");
      assertEq([msgTool?.annotations?.readOnlyHint, msgTool?.annotations?.destructiveHint, msgTool?.annotations?.openWorldHint],
        [false, false, true], "ac10-10: annotations: write, not destructive, open world (e-mails the producer)");
      assertTrue(/1000 characters/.test(msgTool?.description ?? "") && /10 messages per order per hour/.test(msgTool?.description ?? ""),
        "ac10-11: the description states the cap and the rate limit");
    }

    // ════════════════════════════════════════════════════════════════════════
    // ORDER_MESSAGES_ENABLED off → the feature is absent
    // ════════════════════════════════════════════════════════════════════════
    {
      const o = seedOrder();
      await withMcp(true, false, async (client) => {
        const r = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: "Hei" });
        assertTrue(r.body?.success === false && r.body.status === 404 && msgs(o.id).length === 0, "off-01: actions on, messages off → lokal_order_message refused (404), no row");
        const s = (await call(client, "lokal_order_status", { order_id: o.id, buyer_ref: o.ref })).body;
        assertEq([s?.messages, "messages_notice" in (s ?? {}), s?.available_actions], [[], false, ["withdraw"]],
          "off-02: messages off → lokal_order_status keeps messages [] and no 'message' action (B1 shape)");
      });
      flags(false, false);
      const g = await req("GET", cardUrl(o));
      assertTrue(g.status === 200 && !g.text.includes("Meldinger") && !g.text.includes('name="message"') && !g.text.includes('value="message"'),
        "off-03: messages off → the order card has no thread and no message form");
      const p = await req("POST", `/ordre/${encodeURIComponent(o.id)}`, { form: { ref: o.ref, action: "message", message: "Hei" } });
      assertEq([p.status, p.headers["location"], msgs(o.id).length], [303, `${cardUrl(o)}&error=ugyldig`, 0], "off-04: messages off → a card message post is an unknown action, no row");
      const mine = await req("GET", minePath("ag-m1", o.id), { headers: { Cookie: COOKIE_M1 } });
      assertTrue(mine.status === 200 && !mine.text.includes("Meldinger") && !mine.text.includes("/melding"), "off-05: messages off → «Mine ordrer» has no thread and no form");
      const sp = await sellerPost("ag-m1", o.id, { message: "Hei" }, COOKIE_M1);
      assertEq([sp.status, msgs(o.id).length], [404, 0], "off-06: messages off → the seller message route does not exist (404)");
      const tok = await req("GET", `/produsent/ordre/ctok_${o.id}/kompakt`);
      assertTrue(tok.status === 200 && !tok.text.includes("Meldinger"), "off-07: messages off → the token view has no thread");
      const svc = await msgSvc.postOrderMessage(o.id, "seller", "Hei", "owner_portal");
      assertTrue(svc.success === false && svc.status === 404 && msgs(o.id).length === 0, "off-08: messages off → the service refuses too");
      await settle();
      assertEq([pMailsFor(o.id).length, bMailsFor(o.id).length], [0, 0], "off-09: messages off → no e-mail");
    }

    // ════════════════════════════════════════════════════════════════════════
    // AC8 — buyer → producer → buyer
    // ════════════════════════════════════════════════════════════════════════
    const XSS = `Kan jeg hente <script>alert("x")</script> & "før" 16?\nTakk`;
    const a = seedOrder();
    await withMcp(true, true, async (client) => {
      const r = await call(client, "lokal_order_message", { order_id: a.id, buyer_ref: a.ref, message: `  ${XSS}  ` });
      await settle();
      assertTrue(r.body?.success === true && r.body.replayed === false && r.body.message?.from === "buyer" && r.body.message.text === XSS,
        `ac8-01: lokal_order_message stores the trimmed text (got ${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq(msgs(a.id).map((m) => [m.author_role, m.channel]), [["buyer", "mcp"]], "ac8-02: one row, author buyer, channel mcp");
      const pm = pMailsFor(a.id);
      assertTrue(pm.length === 1 && pm[0]!.to === PRODUCER_MAIL && /Ny melding fra kunden/.test(pm[0]!.subject) && pm[0]!.textContent.includes("> Takk"),
        `ac8-03: the producer gets one e-mail with the message quoted (got ${JSON.stringify(pm).slice(0, 200)})`);
      assertTrue(pm[0]!.textContent.includes(`/produsent/ordre/ctok_${a.id}/kompakt`) && pm[0]!.textContent.includes(`/eier/ag-m1/ordrer?o=${a.id}`),
        "ac8-04: the producer e-mail links the order (token view) and «Mine ordrer»");
      assertTrue(!pm[0]!.textContent.includes(BUYER_MAIL) && !pm[0]!.htmlContent.includes(BUYER_MAIL) && pm[0]!.replyTo === notifySvc.DEFAULT_ORDER_NOTIFY_REPLY_TO,
        "ac8-05: the producer e-mail carries no buyer address, and the Reply-To is the platform address");
      assertTrue(pm[0]!.htmlContent.includes("&lt;script&gt;") && !pm[0]!.htmlContent.includes("<script>"), "ac8-06: the HTML e-mail escapes the message");
      assertTrue(!pm[0]!.textContent.includes(a.ref), "ac8-07: the producer e-mail never carries the buyer_ref");
      const s1 = (await call(client, "lokal_order_status", { order_id: a.id, buyer_ref: a.ref })).body;
      assertTrue(Array.isArray(s1?.messages) && s1.messages.length === 1 && s1.messages[0].from === "buyer" && s1.available_actions.includes("message") &&
        /untrusted quoted data/.test(s1.messages_notice ?? ""), "ac8-08: lokal_order_status: the thread, 'message' in available_actions, messages_notice");
    });

    // «Mine ordrer» shows it (escaped), and the seller answers there.
    flags(false, true);
    {
      const mine = await req("GET", minePath("ag-m1", a.id), { headers: { Cookie: COOKIE_M1 } });
      assertTrue(mine.status === 200 && mine.text.includes("Meldinger") && mine.text.includes("Kan jeg hente &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;før&quot; 16?"),
        "ac8-09: «Mine ordrer» shows the buyer's message, HTML-escaped");
      assertTrue(!mine.text.includes('<script>alert("x")'), "ac8-10: no raw script tag from the message");
      assertTrue(mine.text.includes(`action="/eier/ag-m1/ordrer/${a.id}/melding"`), "ac8-11: the expanded row has the seller's message form");
      const before = buyerMail.length;
      const sp = await sellerPost("ag-m1", a.id, { message: "Ja, kom kl. 16 <b>!</b>", idem: "22222222-aaaa-bbbb-cccc-000000000001" }, COOKIE_M1);
      await settle();
      assertEq([sp.status, sp.headers["location"]], [303, `/eier/ag-m1/ordrer?tab=venter&o=${a.id}&done=melding#o-${a.id}`], "ac8-12: the seller's post → 303 back to the row (PRG)");
      assertEq(msgs(a.id).map((m) => [m.author_role, m.channel]), [["buyer", "mcp"], ["seller", "owner_portal"]], "ac8-13: the answer is stored, author seller, channel owner_portal");
      const bm = bMailsFor(a.id);
      assertTrue(buyerMail.length - before === 1 && bm.length === 1 && bm[0]!.to === BUYER_MAIL && bm[0]!.textContent.includes(`/ordre/${a.id}?ref=${encodeURIComponent(a.ref)}`) &&
        bm[0]!.textContent.includes("> Ja, kom kl. 16"), "ac8-14: the buyer gets one e-mail with the answer and the order-card link");
      assertTrue(bm[0]!.replyTo === "kontakt@rettfrabonden.com" && !bm[0]!.replyTo.includes(PRODUCER_MAIL), "ac8-15: the buyer e-mail's Reply-To is the platform address");
      const replay = await sellerPost("ag-m1", a.id, { message: "Ja, kom kl. 16 <b>!</b>", idem: "22222222-aaaa-bbbb-cccc-000000000001" }, COOKIE_M1);
      await settle();
      assertTrue(replay.status === 303 && msgs(a.id).length === 2 && bMailsFor(a.id).length === 1, "ac8-16: the same seller form posted twice → one row, one buyer e-mail");
      const after = await req("GET", `${minePath("ag-m1", a.id)}&done=melding`, { headers: { Cookie: COOKIE_M1 } });
      assertTrue(after.text.includes("Meldingen er sendt til kunden.") && after.text.includes("Ja, kom kl. 16 &lt;b&gt;!&lt;/b&gt;"), "ac8-17: after the PRG the row shows the banner and the escaped answer");
    }
    await withMcp(true, true, async (client) => {
      const s2 = (await call(client, "lokal_order_status", { order_id: a.id, buyer_ref: a.ref })).body;
      assertEq(s2?.messages?.map((m: any) => [m.from, m.text, typeof m.created_at]), [["buyer", XSS, "string"], ["seller", "Ja, kom kl. 16 <b>!</b>", "string"]],
        "ac8-18: lokal_order_status.messages carries the seller's answer as quoted data {from, text, created_at}");
      assertEq(Object.keys(s2?.messages?.[1] ?? {}).sort(), ["created_at", "from", "text"], "ac8-19: each message item has exactly from, text, created_at");
      const s3 = (await call(client, "lokal_order_status", { order_id: a.id, buyer_ref: "bref_wrong" })).body;
      assertTrue(s3?.success === false && !("messages" in s3), "ac8-20: wrong buyer_ref → lokal_order_status carries no thread");
    });

    // The order card shows the thread and takes the buyer's message.
    {
      const g = await req("GET", cardUrl(a));
      assertTrue(g.text.includes("Meldinger") && g.text.includes("Ja, kom kl. 16 &lt;b&gt;!&lt;/b&gt;") && !g.text.includes("<b>!</b>") &&
        g.text.includes('value="message"') && g.text.includes('maxlength="1000"'), "card-01: the card shows the escaped thread and the message form");
      const before = pMailsFor(a.id).length;
      const p = await req("POST", `/ordre/${encodeURIComponent(a.id)}`, { form: { ref: a.ref, action: "message", message: "Flott, ses!", idem: "33333333-aaaa-bbbb-cccc-000000000001" } });
      await settle();
      assertEq([p.status, p.headers["location"]], [303, `${cardUrl(a)}&done=melding#meldinger`], "card-02: the card's message post → 303 back to the card (PRG)");
      assertEq(msgs(a.id).slice(-1).map((m) => [m.author_role, m.channel, m.idempotency_key]), [["buyer", "web", "b:web:33333333-aaaa-bbbb-cccc-000000000001"]],
        "card-03: stored as buyer / web with the namespaced key");
      assertEq(pMailsFor(a.id).length - before, 1, "card-04: the producer is e-mailed");
      await req("POST", `/ordre/${encodeURIComponent(a.id)}`, { form: { ref: a.ref, action: "message", message: "Flott, ses!", idem: "33333333-aaaa-bbbb-cccc-000000000001" } });
      await settle();
      assertEq([msgs(a.id).length, pMailsFor(a.id).length - before], [3, 1], "card-05: the same card form twice → one row, one e-mail");
      const shown = await req("GET", `${cardUrl(a)}&done=melding`);
      assertTrue(shown.text.includes("Meldingen er sendt til produsenten."), "card-06: the banner after the PRG");
      const w = await req("POST", `/ordre/${encodeURIComponent(a.id)}`, { form: { ref: "bref_wrong", action: "message", message: "x" } });
      assertEq([w.status, msgs(a.id).length], [404, 3], "card-07: wrong ref on the card → 404 (as B1), no row");
      const x = await req("POST", `/ordre/${encodeURIComponent(a.id)}`, { headers: { Origin: "https://evil.example" }, form: { ref: a.ref, action: "message", message: "x" } });
      assertEq([x.status, msgs(a.id).length], [403, 3], "card-08: a cross-site card post → 403, no row");
      const e = await req("POST", `/ordre/${encodeURIComponent(a.id)}`, { form: { ref: a.ref, action: "message", message: "   " } });
      assertEq([e.headers["location"], msgs(a.id).length], [`${cardUrl(a)}&error=melding-tom#meldinger`, 3], "card-09: an empty card message → error melding-tom, no row");
      const l = await req("POST", `/ordre/${encodeURIComponent(a.id)}`, { form: { ref: a.ref, action: "message", message: "x".repeat(1001) } });
      assertEq([l.headers["location"], msgs(a.id).length], [`${cardUrl(a)}&error=melding-lang#meldinger`, 3], "card-10: a 1001-character card message → error melding-lang, no row");
      const tok = await req("GET", `/produsent/ordre/ctok_${a.id}/kompakt`);
      assertTrue(tok.text.includes("Meldinger") && tok.text.includes("Flott, ses!") && !tok.text.includes("/melding") && tok.text.includes("Svar kunden i Mine ordrer"),
        "card-11: the e-mail token view shows the thread read-only and points to «Mine ordrer»");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Access: wrong buyer_ref, other owner, no session, cross-site
    // ════════════════════════════════════════════════════════════════════════
    await withMcp(true, true, async (client) => {
      const o = seedOrder();
      const rw = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: "bref_wrong", message: "Hei" });
      const ru = await call(client, "lokal_order_message", { order_id: "no-such-order", buyer_ref: "bref_wrong", message: "Hei" });
      await settle();
      assertTrue(rw.body?.success === false && rw.body.status === 403, "acc-01: wrong buyer_ref → 403");
      assertEq(rw.body, ru.body, "acc-02: wrong buyer_ref and an unknown order give the identical answer");
      assertEq([msgs(o.id).length, pMailsFor(o.id).length], [0, 0], "acc-03: wrong buyer_ref → no row, no e-mail");
      const bad = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: "Hei", idempotency_key: "har mellomrom" });
      assertEq([bad.body?.status, msgs(o.id).length], [400, 0], "acc-04: an invalid idempotency_key → 400, no row");
    });
    flags(false, true);
    {
      const o = seedOrder();
      const other = await sellerPost("ag-m1", o.id, { message: "Hei" }, COOKIE_M2);
      assertEq([other.status, msgs(o.id).length], [403, 0], "acc-05: another producer's session → 403, no row");
      const none = await sellerPost("ag-m1", o.id, { message: "Hei" }, null);
      assertEq([none.status, none.headers["location"], msgs(o.id).length], [302, "/eier/ag-m1", 0], "acc-06: no session → login redirect, no row");
      const foreign = seedOrder({ agent: "ag-m2" });
      const cross = await sellerPost("ag-m1", foreign.id, { message: "Hei" }, COOKIE_M1);
      assertEq([cross.status, msgs(foreign.id).length], [404, 0], "acc-07: own session but another producer's order → 404, no row");
      const site = await sellerPost("ag-m1", o.id, { message: "Hei" }, COOKIE_M1, { Origin: "https://evil.example" });
      assertEq([site.status, msgs(o.id).length], [403, 0], "acc-08: a cross-site seller post → 403, no row");
      const otherList = await req("GET", minePath("ag-m1", o.id), { headers: { Cookie: COOKIE_M2 } });
      assertEq(otherList.status, 403, "acc-09: another producer's session cannot read «Mine ordrer» (and so not the thread)");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Cap: 1000 characters, trimmed, empty refused — on every entry point
    // ════════════════════════════════════════════════════════════════════════
    await withMcp(true, true, async (client) => {
      const o = seedOrder();
      const max = "æ".repeat(999) + "🍓"; // 1000 code points (the emoji is 2 UTF-16 units)
      const ok = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: `\n  ${max}  \n` });
      assertTrue(ok.body?.success === true && ok.body.message.text === max, "cap-01: exactly 1000 characters (after trimming, emoji = 1) is accepted");
      const long = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: max + "x" });
      assertTrue(long.body?.success === false && long.body.status === 400 && /1001 characters/.test(long.body.error), "cap-02: 1001 characters → 400, nothing cut silently");
      const empty = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: " \n\t " });
      assertEq([empty.body?.status, empty.body?.code], [400, "empty"], "cap-03: whitespace only → 400 empty");
      assertEq(msgs(o.id).length, 1, "cap-04: only the valid message is stored");
      const sl = await sellerPost("ag-m1", o.id, { message: "y".repeat(1001) }, COOKIE_M1);
      const se = await sellerPost("ag-m1", o.id, { message: "" }, COOKIE_M1);
      assertTrue(String(sl.headers["location"]).includes("error=melding-lang") && String(se.headers["location"]).includes("error=melding-tom") && msgs(o.id).length === 1,
        "cap-05: «Mine ordrer» refuses too long and empty messages");
      const banner = await req("GET", `${minePath("ag-m1", o.id)}&error=melding-lang`, { headers: { Cookie: COOKIE_M1 } });
      assertTrue(banner.text.includes("høyst 1000 tegn"), "cap-06: the banner states the cap");
    });
    assertEq(msgSvc.normalizeMessageText("a\r\nb\u0000c\u0007"), { ok: true, text: "a\nbc" }, "cap-07: CRLF → LF and control characters are dropped");

    // ════════════════════════════════════════════════════════════════════════
    // Rate limit: 10 per order per author role per hour
    // ════════════════════════════════════════════════════════════════════════
    {
      flags(false, true);
      const o = seedOrder();
      const t0 = new Date();
      const results: number[] = [];
      for (let k = 0; k < msgSvc.ORDER_MESSAGE_RATE_LIMIT; k++) {
        const r = await msgSvc.postOrderMessage(o.id, "buyer", `m${k}`, "mcp", { now: new Date(t0.getTime() + k * 1000) });
        results.push(r.success ? 200 : r.status);
      }
      assertEq(results, Array(10).fill(200), "rate-01: ten buyer messages within the hour are accepted");
      const eleventh = await msgSvc.postOrderMessage(o.id, "buyer", "m10", "mcp", { now: new Date(t0.getTime() + 20_000) });
      assertTrue(eleventh.success === false && eleventh.status === 429 && eleventh.code === "rate_limited", "rate-02: the eleventh within the hour → 429");
      const seller = await msgSvc.postOrderMessage(o.id, "seller", "svar", "owner_portal", { now: new Date(t0.getTime() + 21_000) });
      assertTrue(seller.success === true, "rate-03: the seller has a counter of its own");
      const later = await msgSvc.postOrderMessage(o.id, "buyer", "senere", "mcp", { now: new Date(t0.getTime() + msgSvc.ORDER_MESSAGE_RATE_WINDOW_MS + 2000) });
      assertTrue(later.success === true, "rate-04: once the first message is more than an hour old, the buyer may write again");
      const otherOrder = seedOrder();
      const fresh = await msgSvc.postOrderMessage(otherOrder.id, "buyer", "hei", "mcp", { now: new Date(t0.getTime() + 20_000) });
      assertTrue(fresh.success === true, "rate-05: the limit is per order");
      // MCP and the card meet the same limit (they count real now: fill the window at now).
      const m = seedOrder();
      for (let k = 0; k < 10; k++) await msgSvc.postOrderMessage(m.id, "buyer", `f${k}`, "mcp");
      await withMcp(true, true, async (client) => {
        const r = await call(client, "lokal_order_message", { order_id: m.id, buyer_ref: m.ref, message: "en til" });
        assertEq([r.body?.success, r.body?.status], [false, 429], "rate-06: lokal_order_message → 429 once the window is full");
      });
      const c = await req("POST", `/ordre/${encodeURIComponent(m.id)}`, { form: { ref: m.ref, action: "message", message: "en til" } });
      assertEq(c.headers["location"], `${cardUrl(m)}&error=melding-grense#meldinger`, "rate-07: the card → error melding-grense once the window is full");
      for (let k = 0; k < 10; k++) await msgSvc.postOrderMessage(m.id, "seller", `s${k}`, "owner_portal");
      const s = await sellerPost("ag-m1", m.id, { message: "en til" }, COOKIE_M1);
      assertTrue(String(s.headers["location"]).includes("error=melding-grense"), "rate-08: «Mine ordrer» → error melding-grense once the seller's window is full");
      assertEq(msgs(m.id).length, 20, "rate-09: nothing past the limit is stored");
    }

    // ════════════════════════════════════════════════════════════════════════
    // Idempotency
    // ════════════════════════════════════════════════════════════════════════
    await withMcp(true, true, async (client) => {
      const o = seedOrder();
      const a1 = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: "Hei!", idempotency_key: "msg-1" });
      const a2 = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: "Hei!", idempotency_key: "msg-1" });
      await settle();
      assertTrue(a1.body?.replayed === false && a2.body?.success === true && a2.body.replayed === true && a2.body.message.text === "Hei!",
        "idem-01: the same key twice → the second answer is a replay of the stored message");
      assertEq([msgs(o.id).length, pMailsFor(o.id).length], [1, 1], "idem-02: the same key twice → one row and one producer e-mail");
      assertEq(msgs(o.id)[0]?.idempotency_key, "b:msg-1", "idem-03: the buyer's key is stored namespaced");
      const a3 = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: "Noe annet", idempotency_key: "msg-1" });
      assertTrue(a3.body?.success === false && a3.body.status === 409 && msgs(o.id).length === 1, "idem-04: the same key with another text → 409, no row");
      const a4 = await call(client, "lokal_order_message", { order_id: o.id, buyer_ref: o.ref, message: "Hei!" });
      await settle();
      assertEq([a4.body?.success, msgs(o.id).length, pMailsFor(o.id).length], [true, 2, 2], "idem-05: without a key the same text is a new message");
    });

    // ════════════════════════════════════════════════════════════════════════
    // Notifications: no buyer address, the producer never got the order, closed orders
    // ════════════════════════════════════════════════════════════════════════
    {
      flags(false, true);
      const nb = seedOrder({ buyerEmail: null });
      const before = buyerMail.length;
      const r = await sellerPost("ag-m1", nb.id, { message: "Hei" }, COOKIE_M1);
      await settle();
      assertTrue(r.status === 303 && msgs(nb.id).length === 1 && buyerMail.length === before, "note-01: no buyer address on the order → the answer is stored, no e-mail");
      const ns = seedOrder({ notifySent: false });
      await msgSvc.postOrderMessage(ns.id, "buyer", "Hei", "web");
      await settle();
      assertEq([msgs(ns.id).length, pMailsFor(ns.id).length], [1, 0], "note-03: an order whose e-mail never reached the producer → stored, no producer e-mail");
      const recent = seedOrder({ status: "completed", updatedAt: new Date(Date.now() - 5 * 86_400_000) });
      const old = seedOrder({ status: "cancelled", updatedAt: new Date(Date.now() - 40 * 86_400_000) });
      const rr = await msgSvc.postOrderMessage(recent.id, "buyer", "Takk!", "mcp");
      const ro = await msgSvc.postOrderMessage(old.id, "buyer", "Hallo?", "mcp");
      assertTrue(rr.success === true && ro.success === false && ro.status === 409 && ro.code === "closed", "note-04: a closed order takes messages for 30 days, then 409 closed");
      const oldCard = await req("GET", cardUrl(old));
      assertTrue(oldCard.text.includes("Meldinger") && !oldCard.text.includes('value="message"'), "note-05: an order closed long ago shows the thread but no form");
      const html = (await req("GET", `/eier/ag-m1/ordrer?tab=avsluttet&o=${old.id}`, { headers: { Cookie: COOKIE_M1 } })).text;
      assertTrue(!html.includes(`/ordrer/${old.id}/melding`), "note-06: «Mine ordrer» shows no form on an order closed long ago");
      assertTrue(html.includes(`/ordrer/${recent.id}/melding`), "note-07: «Mine ordrer» keeps the form on a recently closed order");
    }
  } catch (err: any) {
    failed++;
    failures.push("order-messages-fase-b2: unexpected error: " + String(err?.stack || err?.message || err));
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
  runOrderMessagesFaseB2Tests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
