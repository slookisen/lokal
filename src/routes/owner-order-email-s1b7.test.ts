/**
 * owner-order-email-s1b7.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S1b punkt 7 «Eieren styrer ordre-e-posten» (flag OWNER_ORDER_EMAIL_ENABLED,
 * default OFF).
 *
 *   off      flag off → all four routes 404, no card section, no rows.
 *   gate     unverified owner / other agent's session → 403, no session → 401.
 *   request  a verified owner asks for a new address → a confirmation mail
 *            goes to the NEW address; the order recipient does NOT change
 *            (resolveOrderNotificationRecipient + a real test order through
 *            sendOrderNotificationForOrder still go to the old address).
 *   confirm  GET changes nothing; POST writes order_notification_email, one
 *            audit row, and the next test order goes to the new address.
 *   reject   expired / consumed / unknown / superseded tokens, blocklisted
 *            address (at request and at confirm time), lost ownership,
 *            cross-site POST, rate limit, failed mail send.
 *
 * Real router + services on the production schema in an in-memory DB; handlers
 * pulled off the router stack (same harness as owner-pause-s1b6.test.ts).
 * Exported runOwnerOrderEmailS1b7Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-order-email-s1b7.test.ts
 */

import Database from "better-sqlite3";
import crypto from "crypto";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
  headers: Record<string, string>;
}

const FLAG = "OWNER_ORDER_EMAIL_ENABLED";
const OWNED_ID = "s1b7-owned";
const UNVERIFIED_ID = "s1b7-unverified";
const OTHER_ID = "s1b7-other";
const OLD_EMAIL = `post@${OWNED_ID}.example.no`;
const NEW_EMAIL = "ny-ordre@s1b7-owned.example.no";

function seedProducer(db: Database.Database, id: string, claimed: boolean): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for ordre-e-post.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?, 1)`,
  ).run(
    id, `Ordreprove Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
    claimed ? "2026-10-01T00:00:00.000Z" : null,
  );
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
}

export async function runOwnerOrderEmailS1b7Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.info(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.info(`  ✗ ${label}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevFlag = process.env[FLAG];
  const setFlag = (on: boolean) => { if (on) process.env[FLAG] = "1"; else delete process.env[FLAG]; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; },
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const es = emailMod.emailService as any;
  const prevSendConfirm = es.sendOwnerOrderEmailConfirm;
  const sentConfirms: Array<{ to: string; confirmUrl: string; agentName: string }> = [];
  let failNextConfirmSend = false;
  es.sendOwnerOrderEmailConfirm = async (o: any) => {
    if (failNextConfirmSend) { failNextConfirmSend = false; return { success: false, error: "smtp down" }; }
    sentConfirms.push({ to: o.to, confirmUrl: o.confirmUrl, agentName: o.agentName });
    return { success: true, messageId: "stub" };
  };
  const notify = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const orderMails: string[] = [];
  notify.__setOrderNotifySendForTesting(async (o) => { orderMails.push(o.to); return { success: true, messageId: "stub" }; });

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    try { delete require.cache[require.resolve("./owner-portal")]; } catch { /* not loaded yet */ }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const ownerRouter = portalMod.default as any;
    const { isEligibleForRealOrder } = require("../services/cart-service") as typeof import("../services/cart-service");
    const blocklist = require("../services/blocklist-service") as typeof import("../services/blocklist-service");

    const H = {
      api: findRouteHandler(ownerRouter, "/api/agents/:id/order-email", "post"),
      form: findRouteHandler(ownerRouter, "/eier/:agentId/order-email", "post"),
      confirmGet: findRouteHandler(ownerRouter, "/eier/ordre-epost/bekreft/:token", "get"),
      confirmPost: findRouteHandler(ownerRouter, "/eier/ordre-epost/bekreft/:token", "post"),
      portal: findRouteHandler(ownerRouter, "/eier/:agentId/portal", "get"),
    };

    seedProducer(db, OWNED_ID, true);
    seedProducer(db, UNVERIFIED_ID, false);
    seedProducer(db, OTHER_ID, true);
    const tokens: Record<string, string> = {};
    for (const id of [OWNED_ID, UNVERIFIED_ID, OTHER_ID]) {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }

    const request = (id: string, email: unknown, token: string | undefined = tokens[id]) =>
      invoke(H.api, makeReq({ params: { id }, body: { email }, token }));
    const confirmGet = (t: string) => invoke(H.confirmGet, makeReq({ params: { token: t } }));
    const confirmPost = (t: string, headers: Record<string, string> = {}) => invoke(H.confirmPost, makeReq({ params: { token: t }, headers }));
    const portalHtml = async (id = OWNED_ID) => String((await invoke(H.portal, makeReq({ params: { agentId: id }, token: tokens[id] }))).body ?? "");
    const overrideCol = (id = OWNED_ID) => (db.prepare("SELECT order_notification_email AS v FROM agents WHERE id = ?").get(id) as { v: string | null }).v;
    const changeRows = (id = OWNED_ID) => db.prepare("SELECT * FROM owner_order_email_change WHERE agent_id = ? ORDER BY requested_at, rowid").all(id) as any[];
    const auditRows = (id = OWNED_ID) =>
      db.prepare("SELECT old_value, new_value, changed_by FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'order_notification_email' ORDER BY changed_at, rowid").all(id) as Array<{ old_value: string; new_value: string; changed_by: string }>;
    const recipient = (id = OWNED_ID) => {
      const r = notify.resolveOrderNotificationRecipient(id);
      return r.eligible ? r.email : `ineligible:${r.reason}`;
    };
    let orderSeq = 0;
    const testOrder = async (id = OWNED_ID) => {
      orderMails.length = 0;
      const outcome = await notify.sendOrderNotificationForOrder({
        order_id: `s1b7-order-${++orderSeq}`, agent_id: id, producer_name: "Ordreprove Gard", buyer_ref: "TEST",
        confirm_token: "x", pickup_time: null, total_nok: 100, items: [{ name: "Poteter", qty: 1, unit: "kg", line_total: 100 }],
      });
      return { outcome, to: [...orderMails] };
    };
    const tokenOf = (url: string) => url.split("/").pop() || "";
    // Lets the rolling-hour rate limit start fresh between sections.
    const ageRequests = () => db.prepare("UPDATE owner_order_email_change SET requested_at = ?").run(new Date(Date.now() - 2 * 3600_000).toISOString());

    // ═══ Flag off: nothing changes ═══════════════════════════════════════
    setFlag(false);
    {
      assertEq(portalMod.ownerOrderEmailEnabled(), false, "off-1: OWNER_ORDER_EMAIL_ENABLED defaults OFF");
      assertEq((await request(OWNED_ID, NEW_EMAIL)).status, 404, "off-2: POST /api/agents/:id/order-email → 404");
      const f = await invoke(H.form, makeReq({ params: { agentId: OWNED_ID }, body: { email: NEW_EMAIL }, token: tokens[OWNED_ID] }));
      assertEq(f.status, 404, "off-3: POST /eier/:id/order-email → 404");
      const fakeToken = crypto.randomBytes(32).toString("hex");
      assertEq((await confirmGet(fakeToken)).status, 404, "off-4: GET confirm → 404");
      assertEq((await confirmPost(fakeToken)).status, 404, "off-5: POST confirm → 404");
      assertEq([changeRows().length, sentConfirms.length, overrideCol()], [0, 0, null], "off-6: no rows, no mail, no write");
      const html = await portalHtml();
      assertTrue(html.includes('id="bestillinger"') && !html.includes("Ordre sendes til") && !html.includes("/order-email"), "off-7: Bestillinger card without the order-e-mail section");
      const agent = { id: OWNED_ID, order_notifications_opt_in: 1, is_verified: 1 };
      assertEq(portalMod.ordersCardHtml(agent, ""), portalMod.ordersCardHtml(agent), "off-8: ordersCardHtml with empty extra is byte-identical");
    }

    setFlag(true);
    // ═══ Gate ═════════════════════════════════════════════════════════════
    {
      const r = await request(UNVERIFIED_ID, "ny@s1b7-unverified.example.no");
      assertEq([r.status, r.body?.error], [403, "ownership_not_verified"], "gate-1: session without verified ownership → 403");
      const cross = await request(OWNED_ID, NEW_EMAIL, tokens[OTHER_ID]);
      assertEq([cross.status, cross.body?.error], [403, "forbidden"], "gate-2: another agent's session → 403");
      const none = await request(OWNED_ID, NEW_EMAIL, "");
      assertEq(none.status, 401, "gate-3: no session → 401");
      assertEq([changeRows(UNVERIFIED_ID).length, changeRows().length, sentConfirms.length], [0, 0, 0], "gate-4: rejected requests write nothing and send nothing");
      const html = await portalHtml(UNVERIFIED_ID);
      assertTrue(!html.includes("Ordre sendes til") && !html.includes("/order-email"), "gate-5: unverified owner gets no change form");
      const bad = await request(OWNED_ID, "ikke-en-adresse");
      assertEq([bad.status, bad.body?.error], [400, "invalid_email"], "gate-6: invalid e-mail → 400");
      const same = await request(OWNED_ID, OLD_EMAIL.toUpperCase());
      assertEq([same.status, same.body?.error], [400, "same_email"], "gate-7: current address → 400 same_email");
      blocklist.add({ email: "sperret@s1b7.example.no", reason: "s1b7 test" });
      const blocked = await request(OWNED_ID, "sperret@s1b7.example.no");
      assertEq([blocked.status, blocked.body?.error], [400, "email_blocked"], "gate-8: blocklisted new address → 400");
      assertEq([changeRows().length, sentConfirms.length], [0, 0], "gate-9: invalid/blocked requests write nothing");
    }

    // ═══ Request: mail to the new address, recipient unchanged ═══════════
    let firstToken = "";
    {
      assertEq(recipient(), OLD_EMAIL, "req-0: baseline recipient is contact_email");
      assertTrue(isEligibleForRealOrder(OWNED_ID), "req-0b: test producer is eligible for a real order");
      const html0 = await portalHtml();
      assertTrue(html0.includes(`Ordre sendes til: <strong>${OLD_EMAIL}</strong>`) && html0.includes(`action="/eier/${OWNED_ID}/order-email"`), "req-1: portal shows the current recipient and the change form");
      const r = await request(OWNED_ID, ` ${NEW_EMAIL.toUpperCase()} `);
      assertEq([r.status, r.body?.pending_email, r.body?.order_email], [200, NEW_EMAIL, OLD_EMAIL], "req-2: request → 200, pending new address, recipient unchanged");
      assertEq(sentConfirms.map((m) => m.to), [NEW_EMAIL], "req-3: confirmation mail goes to the NEW address only");
      const url = sentConfirms[0]?.confirmUrl || "";
      assertTrue(url.startsWith("https://rettfrabonden.com/eier/ordre-epost/bekreft/"), "req-4: mail links to /eier/ordre-epost/bekreft/:token");
      firstToken = tokenOf(url);
      const rows = changeRows();
      assertEq(rows.length, 1, "req-5: one pending row");
      assertTrue(rows[0].token_hash === crypto.createHash("sha256").update(firstToken).digest("hex") && rows[0].token_hash !== firstToken, "req-6: only the sha256 of the token is stored");
      assertEq([rows[0].outcome, rows[0].consumed_at, rows[0].requested_by], [null, null, `owner:${OLD_EMAIL}`], "req-7: row is pending, requested_by the owner session");
      const hours = (Date.parse(rows[0].expires_at) - Date.parse(rows[0].requested_at)) / 3600_000;
      assertEq(hours, 48, "req-8: token valid 48 h (ISO timestamps)");
      assertEq([overrideCol(), recipient()], [null, OLD_EMAIL], "req-9: order_notification_email NOT written before the click");
      const o = await testOrder();
      assertEq([o.outcome, o.to], ["sent", [OLD_EMAIL]], "req-10: a test order before the click goes to the OLD address");
      assertTrue(isEligibleForRealOrder(OWNED_ID), "req-11: real-order eligibility unchanged");
      const html1 = await portalHtml();
      assertTrue(html1.includes(`Ordre sendes til: <strong>${OLD_EMAIL}</strong>`) && html1.includes(`Venter på bekreftelse fra <strong>${NEW_EMAIL}</strong>`), "req-12: portal shows «Venter på bekreftelse fra <ny>»");
    }

    // ═══ Confirm ══════════════════════════════════════════════════════════
    {
      const g = await confirmGet(firstToken);
      assertEq(g.status, 200, "conf-1: GET confirm → 200 confirm page");
      const gh = String(g.body ?? "");
      assertTrue(gh.includes('<form method="post"') && gh.includes("Bekreft adressen") && gh.includes(NEW_EMAIL), "conf-2: page has a POST button and names the new address");
      assertEq(g.headers["cache-control"], "no-store", "conf-3: confirm page is no-store");
      assertEq([overrideCol(), changeRows()[0].outcome, auditRows().length], [null, null, 0], "conf-4: GET changes nothing");
      const xs = await confirmPost(firstToken, { origin: "https://evil.example", host: "rettfrabonden.com" });
      assertEq([xs.status, overrideCol(), auditRows().length], [403, null, 0], "conf-5: cross-site POST confirm → 403, nothing written");
      const p = await confirmPost(firstToken, { origin: "https://rettfrabonden.com", host: "rettfrabonden.com" });
      assertEq(p.status, 200, "conf-6: POST confirm → 200");
      assertTrue(String(p.body ?? "").includes("Adressen er bekreftet"), "conf-7: success page");
      assertEq([overrideCol(), recipient()], [NEW_EMAIL, NEW_EMAIL], "conf-8: order recipient is now the new address");
      const r = notify.resolveOrderNotificationRecipient(OWNED_ID);
      assertEq(r.eligible ? r.via : r.reason, "admin_override", "conf-9: resolved via the override column (gate unchanged)");
      const o = await testOrder();
      assertEq([o.outcome, o.to], ["sent", [NEW_EMAIL]], "conf-10: a test order after the click goes to the NEW address");
      assertTrue(isEligibleForRealOrder(OWNED_ID), "conf-11: still eligible for real orders");
      assertEq(auditRows().map((a) => [a.old_value, a.new_value, a.changed_by]), [[OLD_EMAIL, NEW_EMAIL, "owner"]], "conf-12: one audit row old → new, actor owner");
      assertEq(changeRows()[0].outcome, "confirmed", "conf-13: row marked confirmed");
      const again = await confirmPost(firstToken);
      assertEq([again.status, auditRows().length], [400, 1], "conf-14: a consumed token is rejected, no second audit row");
      assertEq((await confirmGet(firstToken)).status, 400, "conf-15: GET on a consumed token → 400 page");
      const html = await portalHtml();
      assertTrue(html.includes(`Ordre sendes til: <strong>${NEW_EMAIL}</strong>`) && !html.includes("Venter på bekreftelse"), "conf-16: portal shows the new recipient, nothing pending");
    }

    // ═══ Superseded / expired / unknown tokens ════════════════════════════
    {
      ageRequests();
      const A = "a-adresse@s1b7.example.no";
      const B = "b-adresse@s1b7.example.no";
      sentConfirms.length = 0;
      assertEq((await request(OWNED_ID, A)).status, 200, "sup-1: request A");
      assertEq((await request(OWNED_ID, B)).status, 200, "sup-2: request B");
      const [ta, tb] = sentConfirms.map((m) => tokenOf(m.confirmUrl));
      assertEq((await confirmPost(ta)).status, 400, "sup-3: the older token A is invalidated by request B");
      assertEq(overrideCol(), NEW_EMAIL, "sup-4: …nothing written");
      assertEq((await request(OWNED_ID, "c-adresse@s1b7.example.no")).status, 200, "rate-0: third request in the hour is allowed");
      const tc = tokenOf(sentConfirms[2].confirmUrl);
      const rl = await request(OWNED_ID, "d-adresse@s1b7.example.no");
      assertEq([rl.status, rl.body?.error, sentConfirms.length], [429, "rate_limited", 3], "rate-1: fourth request in the hour → 429, no mail");
      // Expire C (the only pending one) and try it.
      db.prepare("UPDATE owner_order_email_change SET expires_at = ? WHERE token_hash = ?")
        .run(new Date(Date.now() - 1000).toISOString(), crypto.createHash("sha256").update(tc).digest("hex"));
      const ex = await confirmPost(tc);
      assertEq(ex.status, 400, "exp-1: expired token rejected");
      assertTrue(String(ex.body ?? "").includes("utløpt"), "exp-2: …with the «utløpt» message");
      assertEq((await confirmPost(tb)).status, 400, "sup-5: B was superseded by C");
      assertEq((await confirmPost(crypto.randomBytes(32).toString("hex"))).status, 400, "tok-1: unknown token rejected");
      assertEq((await confirmPost("not-a-token")).status, 400, "tok-2: malformed token rejected");
      assertEq([overrideCol(), auditRows().length], [NEW_EMAIL, 1], "tok-3: no write from any rejected token");
      assertTrue(!(await portalHtml()).includes("Venter på bekreftelse"), "exp-3: an expired change is not shown as pending");
    }

    // ═══ Confirm-time re-checks: blocklist + ownership ════════════════════
    {
      ageRequests();
      sentConfirms.length = 0;
      const E = "senere-sperret@s1b7.example.no";
      assertEq((await request(OWNED_ID, E)).status, 200, "chk-1: request a new address");
      const te = tokenOf(sentConfirms[0].confirmUrl);
      blocklist.add({ email: E, reason: "s1b7 test, blocked after request" });
      const b = await confirmPost(te);
      assertEq([b.status, overrideCol(), auditRows().length], [400, NEW_EMAIL, 1], "chk-2: address blocklisted before the click → rejected, nothing written");
      const F = "eier-borte@s1b7.example.no";
      assertEq((await request(OWNED_ID, F)).status, 200, "chk-3: request another address");
      const tf = tokenOf(sentConfirms[1].confirmUrl);
      db.prepare("UPDATE agents SET claimed_at = NULL WHERE id = ?").run(OWNED_ID);
      const n = await confirmPost(tf);
      assertEq([n.status, overrideCol()], [400, NEW_EMAIL], "chk-4: profile no longer verified-owned → rejected, nothing written");
      db.prepare("UPDATE agents SET claimed_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", OWNED_ID);
      const ok = await confirmPost(tf);
      assertEq([ok.status, overrideCol()], [200, F], "chk-5: same token works once ownership is back (still unconsumed)");
      assertEq(auditRows().map((a) => [a.old_value, a.new_value]), [[OLD_EMAIL, NEW_EMAIL], [NEW_EMAIL, F]], "chk-6: second audit row old → new");
    }

    // ═══ No-JS form + send failure ════════════════════════════════════════
    {
      ageRequests();
      sentConfirms.length = 0;
      const form = (body: any, headers: Record<string, string> = {}) =>
        invoke(H.form, makeReq({ params: { agentId: OWNED_ID }, body, token: tokens[OWNED_ID], headers }));
      const ok = await form({ email: "skjema@s1b7.example.no" }, { origin: "https://rettfrabonden.com", host: "rettfrabonden.com" });
      assertEq([ok.status, ok.body?.__redirect], [303, `/eier/${OWNED_ID}/portal?status=order_email_sent#bestillinger`], "form-1: form request → 303 back to #bestillinger");
      assertEq(sentConfirms.map((m) => m.to), ["skjema@s1b7.example.no"], "form-2: …and the mail went to the new address");
      const inv = await form({ email: "nei" });
      assertEq(inv.body?.__redirect, `/eier/${OWNED_ID}/portal?status=order_email_invalid#bestillinger`, "form-3: invalid address → error status redirect");
      const xs = await form({ email: "x@s1b7.example.no" }, { origin: "https://evil.example", host: "rettfrabonden.com" });
      assertEq([xs.status, sentConfirms.length], [403, 1], "form-4: cross-site form POST → 403, no mail");
      const noSession = await invoke(H.form, makeReq({ params: { agentId: OWNED_ID }, body: { email: "y@s1b7.example.no" } }));
      assertEq(noSession.body?.__redirect, `/eier/${OWNED_ID}`, "form-5: no session → redirect to login");
      const alertHtml = String((await invoke(H.portal, makeReq({ params: { agentId: OWNED_ID }, token: tokens[OWNED_ID], query: { status: "order_email_sent" } }))).body ?? "");
      assertTrue(alertHtml.includes("Vi har sendt en bekreftelse til den nye adressen"), "form-6: portal shows the «sent» alert");
      ageRequests();
      failNextConfirmSend = true;
      const before = overrideCol();
      const f = await request(OWNED_ID, "feiler@s1b7.example.no");
      assertEq([f.status, f.body?.error], [502, "email_send_failed"], "fail-1: mail send fails → 502");
      const last = changeRows().pop();
      assertEq([last?.new_email, last?.outcome], ["feiler@s1b7.example.no", "send_failed"], "fail-2: row marked send_failed (not pending)");
      assertEq([overrideCol(), portalMod.pendingOrderEmailChange(OWNED_ID)], [before, null], "fail-3: nothing written, nothing pending");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    es.sendOwnerOrderEmailConfirm = prevSendConfirm;
    notify.__setOrderNotifySendForTesting(null);
    if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerOrderEmailS1b7Tests({ log: true }).then((r) => {
    console.info(`\nowner-order-email-s1b7: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
