/**
 * stock-check-reminder-b2.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-
 * start-til-slutt-for-eier, slice B2 (lagerpåminnelse, products.stock_check),
 * AC6 and AC8.
 *
 * No network, no real e-mail, no production DB: a fresh in-memory SQLite with
 * the real production schema, the producer e-mail transport stubbed
 * (order-notify-service's send seam) and an injected clock for the job.
 *
 *   flag-*    STOCK_CHECK_EMAIL_ENABLED off: no e-mail, no reservation row,
 *             the link page 404 (AC8).
 *   hour-*    nothing is sent in the night (Oslo time).
 *   ac6-*     an orderable item expiring in 2 days + orders on → banner and
 *             exactly ONE e-mail (two overlapping runs); a second run the same
 *             week → no new e-mail; orders off → none; owner turned
 *             products.stock_check off → none; blocklisted recipient → none.
 *   mail-*    the template: subject, the listed items only, the link, the
 *             14-day promise, no other producer's items.
 *   banner-*  the /eier portal banner (B1 card flag): which items, not for
 *             orders off / owner «av»; its POST confirms only the listed own
 *             soon-expiring rows.
 *   link-*    GET changes nothing; POST confirms only rows still orderable
 *             apart from the expiry and confirmable (not unpriced / label /
 *             alcohol / another producer's); cross-site Origin, tampered,
 *             unknown and expired tokens → no write.
 *   safe-*    the reservation: overlap → one; a failed send is not retried
 *             inside the window; after 14 days a new one may be reserved.
 *
 * Standalone: npx tsx src/routes/stock-check-reminder-b2.test.ts
 * Wired into `npm test` by tests/test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

const DAY = 86_400_000;
const ENV_KEYS = [
  "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "UNSUBSCRIBE_TOKEN_SECRET", "STOCK_CHECK_EMAIL_ENABLED",
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "SUPPLY_GRAPH_STALE_DAYS", "OWNER_FEATURES_ALLOWED_SUBJECTS",
  "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_FEATURES_ENFORCE", "APP_URL",
];

const A = "sc-main";        // eligible, orders on, one row per kind
const B = "sc-second";      // eligible, one soon-expiring row
const OFF = "sc-orders-off"; // orders off (opt-in 0)
const OPT = "sc-owner-off";  // owner switched products.stock_check off
const BLK = "sc-blocked";    // recipient e-mail blocklisted
const FAIL = "sc-fail";      // the send fails (seeded later)

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runStockCheckReminderB2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${e}\n    actual:   ${a}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { method?: string; params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: o.method ?? "POST", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; }, clearCookie() { return res; },
        setHeader() { return res; },
      };
      try {
        const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
        if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
      } catch (err) {
        settle({ __error: String(err) });
      }
    });
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  const sent: Array<{ to: string; subject: string; textContent: string; htmlContent?: string }> = [];
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }
  let notifySvc: typeof import("../services/order-notify-service") | null = null;
  let cartSvc: typeof import("../services/cart-service") | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "b2-test-admin-key";
    for (const m of ["../routes/owner-portal", "../routes/stock-check", "../services/stock-check-reminder", "../services/owner-orderability"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
    notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
    const sc = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const routeMod = require("./stock-check") as typeof import("./stock-check");
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject, textContent: o.textContent || "", htmlContent: o.htmlContent });
      return { success: true, messageId: "stub" };
    });

    // ── Fixture ─────────────────────────────────────────────────────────────
    // T = today 10:00Z (11/12 Oslo): the job runs at T; the routes read the
    // real clock, which is within ±14 h of T, so «expires T + 2 d» is inside
    // the 3-day window for both.
    const T = new Date(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
    const ago = (d: number) => sqlTs(new Date(T.getTime() - d * DAY));
    const emailOf = (id: string) => `post@${id}.example.no`;
    const tokens: Record<string, string> = {};
    const seedProducer = (id: string, o: { optIn?: number; email?: string } = {}) => {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent B2.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', ?)`,
      ).run(id, `B2 Gard ${id}`, o.email ?? emailOf(id), `https://${id}.example.no`, `key-${id}`, o.optIn ?? 1);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten gård.', 'verified', 0)`,
      ).run(id, o.email ?? emailOf(id), `https://${id}.example.no`);
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, emailOf(id), tokens[id], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
      // B1b-1: the portal write POSTs need a session opened by the verified claimant's own e-mail.
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
         VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
      ).run(`claim-${id}`, id, emailOf(id));
    };
    const seedProduct = (agent: string, pid: string, p: { name: string; price?: number | null; source?: string; updated?: string | null; category?: string | null; availability?: string }) => {
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
         VALUES (?, ?, ?, ?, ?, 'kg', ?, ?, ?, ?)`,
      ).run(pid, agent, p.name, p.name.toLowerCase(), p.price === undefined ? 30 : p.price, p.availability ?? "in_stock", p.category ?? "vegetables",
        p.source ?? "producer_dashboard", p.updated === undefined ? ago(12) : p.updated);
    };
    seedProducer(A);
    seedProduct(A, "a-soon", { name: "Gulrøtter" });                                   // expires T + 2 d → trigger
    seedProduct(A, "a-fresh", { name: "Kål", updated: ago(1) });                        // expires T + 13 d
    seedProduct(A, "a-admin", { name: "Poteter", source: "admin_producer_confirmed", updated: null });
    seedProduct(A, "a-noprice", { name: "Rødbeter", price: null });                    // orderable, not confirmable
    seedProduct(A, "a-label", { name: "Honning", price: null, category: null, source: "enrichment" }); // category label (scraped, unpriced, generic name)
    seedProduct(A, "a-alcohol", { name: "Eplesider" });                                // alcohol
    seedProduct(A, "a-stale", { name: "Løk", updated: ago(20) });                       // expired 6 days ago
    seedProduct(A, "a-out", { name: "Spinat", availability: "out_of_stock" });          // the owner said «not in stock»
    seedProducer(B);
    seedProduct(B, "b-soon", { name: "Purre" });
    seedProducer(OFF, { optIn: 0 });
    seedProduct(OFF, "off-soon", { name: "Squash" });
    seedProducer(OPT);
    seedProduct(OPT, "opt-soon", { name: "Selleri" });
    db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', ?, 'products.stock_check', 'false', 'owner', 0, ?)`)
      .run(OPT, new Date().toISOString());
    seedProducer(BLK, { email: "sperret@sc-blocked.example.no" });
    seedProduct(BLK, "blk-soon", { name: "Pastinakk" });
    db.prepare(`INSERT INTO agent_blocklist (identifier_type, identifier_value, reason) VALUES ('email', 'sperret@sc-blocked.example.no', 'test')`).run();

    // B1a: the job, the link and the banner are only for allowlisted subjects.
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = [A, B, OFF, OPT, BLK, FAIL].map((id) => `rfb:${id}`).join(",");

    const mailsTo = (id: string) => sent.filter((m) => m.to === emailOf(id) && m.subject === "Bekreft at varene fortsatt er på lager");
    const allReminders = () => sent.filter((m) => m.subject === "Bekreft at varene fortsatt er på lager");
    const noticeRows = (id?: string) => (id
      ? db.prepare("SELECT * FROM stock_check_notices WHERE agent_id = ? ORDER BY created_at").all(id)
      : db.prepare("SELECT * FROM stock_check_notices").all()) as any[];
    const productsOf = (id: string) => db.prepare("SELECT id, availability, availability_source, availability_updated_at FROM products WHERE agent_id = ? ORDER BY id").all(id);
    const updatedAt = (pid: string) => (db.prepare("SELECT availability_updated_at AS u FROM products WHERE id = ?").get(pid) as any).u as string;
    const linkToken = (m: { textContent: string }) => (m.textContent.match(/\/lagerstatus\/([A-Za-z0-9_.-]+)/) || [])[1] || "";

    const H = {
      get: findRouteHandler(routeMod.default, "/lagerstatus/:token", "get"),
      post: findRouteHandler(routeMod.default, "/lagerstatus/:token", "post"),
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      banner: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-lagerpaminnelse", "post"),
    };
    const portal = async (id: string) => String((await invoke(H.portal, makeReq({ method: "GET", params: { agentId: id }, token: tokens[id] }))).body ?? "");

    // ═══ flag off ═══════════════════════════════════════════════════════════
    {
      const r = await sc.processStockCheckReminders({ now: T, db });
      assertEq([r.enabled, r.sent, allReminders().length, noticeRows().length], [false, 0, 0, 0], "flag-1: flag off → no e-mail, no reservation row");
      const g = await invoke(H.get, makeReq({ method: "GET", params: { token: "s1.x.y" } }));
      const p = await invoke(H.post, makeReq({ params: { token: "s1.x.y" } }));
      assertEq([g.status, p.status], [404, 404], "flag-2: flag off → the link page is 404 (GET and POST)");
    }
    process.env.STOCK_CHECK_EMAIL_ENABLED = "1";

    // ═══ hour gate ══════════════════════════════════════════════════════════
    {
      const night = new Date(T.getTime() - 8 * 3600_000); // 02:00Z = 03/04 Oslo
      const r = await sc.processStockCheckReminders({ now: night, db });
      assertEq([r.enabled, r.sent, allReminders().length, noticeRows().length], [true, 0, 0, 0], "hour-1: in the night nothing is sent or reserved");
    }

    // ═══ AC6: trigger, overlap → one e-mail per producer ════════════════════
    {
      assertEq(sc.soonExpiringItems(A, { db, now: T }).map((i) => i.id), ["a-soon"],
        "ac6-1: only the orderable, priced, producer-stated row expiring in 2 days triggers (not fresh / admin / unpriced / label / alcohol / expired)");
      assertEq([sc.stockCheckOn(A, { db }), sc.stockCheckOn(OFF, { db }), sc.stockCheckOn(OPT, { db })], [true, false, false],
        "ac6-2: products.stock_check — on by default with orders on; off with orders off; off when the owner chose «av»");
      const [r1, r2] = await Promise.all([
        sc.processStockCheckReminders({ now: T, db }),
        sc.processStockCheckReminders({ now: T, db }),
      ]);
      assertEq([mailsTo(A).length, mailsTo(B).length], [1, 1], "ac6-3: two overlapping runs → exactly ONE e-mail to each producer");
      assertEq(r1.sent + r2.sent, 2, "ac6-4: the two runs sent 2 in total");
      assertEq([mailsTo(OFF).length, mailsTo(OPT).length, mailsTo(BLK).length], [0, 0, 0],
        "ac6-5: orders off → no e-mail; owner turned it off → no e-mail; blocklisted recipient → no e-mail");
      assertEq([noticeRows(A).length, noticeRows(B).length, noticeRows(OFF).length, noticeRows(OPT).length, noticeRows(BLK).length], [1, 1, 0, 0, 0],
        "ac6-6: a reservation row only for the producers that got the e-mail");
      assertEq([noticeRows(A)[0]?.status, JSON.parse(noticeRows(A)[0]?.product_ids || "[]")], ["sent", ["a-soon"]], "ac6-7: the row is 'sent' and lists the e-mail's items");
      assertTrue(r1.feature_off + r2.feature_off >= 1, "ac6-8: the owner's «av» is counted as feature_off");

      const later = new Date(T.getTime() + 1 * DAY); // the same week; a-soon still expires within 3 days
      const r3 = await sc.processStockCheckReminders({ now: later, db });
      const r4 = await sc.processStockCheckReminders({ now: T, db });
      assertEq([r3.sent, r4.sent, mailsTo(A).length, mailsTo(B).length, noticeRows().length], [0, 0, 1, 1, 2], "ac6-9: a second run the same week → no new e-mail, no new row");
    }

    // ═══ the template ═══════════════════════════════════════════════════════
    {
      const m = mailsTo(A)[0]!;
      assertEq(m.subject, "Bekreft at varene fortsatt er på lager", "mail-1: subject");
      assertTrue(m.textContent.includes("Lagerstatusen for denne varen går snart ut:") && m.textContent.includes("- Gulrøtter (gjelder til "), "mail-2: names the soon-expiring item with its date");
      assertTrue(!/Kål|Poteter|Rødbeter|Honning|Eplesider|Løk|Purre/.test(m.textContent), "mail-3: lists nothing else (no other rows, no other producer's)");
      assertTrue(/Bekreft at varene fortsatt er på lager: https:\/\/rettfrabonden\.com\/lagerstatus\/s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(m.textContent), "mail-4: carries the signed confirm link");
      assertTrue(m.textContent.includes("Ingenting endres før du trykker «Bekreft»") && m.textContent.includes("høyst én slik e-post hver 14. dag"), "mail-5: explains the link and the 14-day promise");
      assertTrue(!!m.htmlContent && m.htmlContent.includes("<li>Gulrøtter (gjelder til ") && m.htmlContent.includes('href="https://rettfrabonden.com/lagerstatus/s1.'), "mail-6: the HTML part");
      const blkOut = await notifySvc.sendProducerStockCheckReminder({ agent_id: BLK, producer_name: "x", items: [], confirm_url: "https://x", link_expires_at: T.toISOString() });
      assertEq([blkOut, sent.filter((s) => s.to === "sperret@sc-blocked.example.no").length], ["skipped", 0], "mail-7: the sender's recipient gate: a blocklisted address → skipped, no e-mail");
    }

    // ═══ the portal banner ══════════════════════════════════════════════════
    {
      const off = await portal(A);
      assertTrue(!off.includes("data-stock-check-banner"), "banner-1: B1 card flag off → no banner");
      process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
      const html = await portal(B);
      assertTrue(html.includes('data-stock-check-banner="1"') && html.includes("Bekreft at varene fortsatt er på lager") && html.includes("Purre"),
        "banner-2: orders on + an item expiring in 2 days → banner with the item and «Bekreft at varene fortsatt er på lager»");
      assertTrue(html.includes('name="id" value="b-soon"'), "banner-3: the banner's form lists the item");
      assertTrue(!(await portal(OFF)).includes("data-stock-check-banner"), "banner-4: orders off → no banner");
      assertTrue(!(await portal(OPT)).includes("data-stock-check-banner"), "banner-5: owner turned products.stock_check off → no banner");

      const xs = await invoke(H.banner, makeReq({ params: { agentId: B }, body: { id: ["b-soon"] }, token: tokens[B], headers: { origin: "https://evil.example" } }));
      assertEq([xs.status, updatedAt("b-soon")], [403, ago(12)], "banner-6: cross-site POST → 403, nothing written");
      const before = productsOf(A);
      const r = await invoke(H.banner, makeReq({ params: { agentId: B }, body: { id: ["b-soon", "a-stale", "a-soon"] }, token: tokens[B], headers: { origin: "https://rettfrabonden.com" } }));
      assertEq(r.body?.__redirect, `/eier/${B}/portal?status=lager_bekreftet#bestillbare-varer`, "banner-7: POST → 303 back with «Takk! Varene er bekreftet på lager.»");
      assertTrue(updatedAt("b-soon") !== ago(12), "banner-8: the own soon-expiring row is confirmed (fresh timestamp)");
      assertEq(productsOf(A), before, "banner-9: another producer's ids in the form are ignored");
      assertTrue(!(await portal(B)).includes("data-stock-check-banner"), "banner-10: after confirming, the banner is gone");
      delete process.env.OWNER_ORDERABILITY_PORTAL_ENABLED;
    }

    // ═══ the confirm link ═══════════════════════════════════════════════════
    {
      const token = linkToken(mailsTo(A)[0]!);
      assertTrue(token.startsWith("s1."), "link-0: token read from the e-mail");
      const snap = JSON.stringify(productsOf(A));
      const audits0 = (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n;
      const g = await invoke(H.get, makeReq({ method: "GET", params: { token } }));
      assertEq(g.status, 200, "link-1: GET with the e-mail's token → 200");
      assertTrue(String(g.body).includes("Gulrøtter") && String(g.body).includes('<form method="post"'), "link-2: GET shows the item and the confirm form");
      assertTrue(!String(g.body).includes(token), "link-3: the token is not echoed on the page");
      assertEq([JSON.stringify(productsOf(A)), (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n], [snap, audits0], "link-4: GET changes NOTHING (products, audit)");
      await invoke(H.get, makeReq({ method: "GET", params: { token } }));
      assertEq(JSON.stringify(productsOf(A)), snap, "link-5: a second GET (link scanner) changes nothing either");

      const xs = await invoke(H.post, makeReq({ params: { token }, headers: { origin: "https://evil.example" } }));
      assertEq([xs.status, JSON.stringify(productsOf(A))], [403, snap], "link-6: cross-site Origin → 403, nothing written");
      const [v, p, sig] = token.split(".");
      const tampered = `${v}.${p}.${sig!.slice(0, -2)}${sig!.slice(-2) === "AA" ? "AB" : "AA"}`;
      const bad = await invoke(H.post, makeReq({ params: { token: tampered } }));
      const badGet = await invoke(H.get, makeReq({ method: "GET", params: { token: tampered } }));
      assertEq([bad.status, badGet.status, JSON.stringify(productsOf(A))], [400, 400, snap], "link-7: a tampered token → 400, nothing written");
      const forged = sc.makeStockCheckToken(A, "unknown-nonce-0123456789", new Date(Date.now() + DAY))!;
      const unk = await invoke(H.post, makeReq({ params: { token: forged } }));
      assertEq([unk.status, JSON.stringify(productsOf(A))], [400, snap], "link-8: a signed token without its notice row → 400, nothing written");

      const ok = await invoke(H.post, makeReq({ params: { token }, headers: { origin: "https://rettfrabonden.com" } }));
      assertEq(ok.status, 200, "link-9: POST with the e-mail's token → 200");
      assertTrue(String(ok.body).includes("Takk! Varene er bekreftet på lager") && String(ok.body).includes("Gulrøtter"), "link-10: the receipt page names the item");
      const row = db.prepare("SELECT availability, availability_source, availability_updated_at FROM products WHERE id = 'a-soon'").get() as any;
      assertTrue(row.availability === "in_stock" && row.availability_source === "producer_dashboard" && row.availability_updated_at !== ago(12),
        "link-11: the listed row is confirmed: in_stock, producer_dashboard, fresh timestamp");
      assertEq(sc.soonExpiringItems(A, { db }).length, 0, "link-12: nothing is soon-expiring any more");
      const n = noticeRows(A)[0];
      assertTrue(!!n.confirmed_at && n.confirmed_count === 1, "link-13: the notice row records the confirmation");
      const again = await invoke(H.post, makeReq({ params: { token } }));
      assertTrue(again.status === 200 && String(again.body).includes("Ingen varer å bekrefte"), "link-14: a second POST confirms nothing more");

      // A notice listing every kind of row (and another producer's): only the rows
      // still orderable apart from the expiry and confirmable are written.
      const later = new Date(T.getTime() + 15 * DAY);
      const all = ["a-soon", "a-fresh", "a-admin", "a-noprice", "a-label", "a-alcohol", "a-out", "a-stale", "b-soon", "off-soon"]
        .map((id) => ({ id, name: id, price_nok: null, unit: null, expires_at: T.toISOString() }));
      const res = sc.reserveStockCheckNotice(A, all, { db, now: later });
      assertTrue(!!res, "safe-1: after 14 days a new reservation is possible");
      const t2 = sc.makeStockCheckToken(A, res!.nonce, new Date(Date.now() + DAY))!;
      const snapB = JSON.stringify(productsOf(B));
      const snapOff = JSON.stringify(productsOf(OFF));
      const before = Object.fromEntries((productsOf(A) as any[]).map((r) => [r.id, r.availability_updated_at]));
      const g2 = await invoke(H.get, makeReq({ method: "GET", params: { token: t2 } }));
      assertTrue(String(g2.body).includes("Løk") && !/Gulrøtter|Kål|Poteter|Rødbeter|Honning|Eplesider|Spinat|Purre|Squash/.test(String(g2.body)),
        "link-15: GET lists only the confirmable row (the expired one)");
      const p2 = await invoke(H.post, makeReq({ params: { token: t2 } }));
      assertEq(p2.status, 200, "link-16: POST → 200");
      const after = Object.fromEntries((productsOf(A) as any[]).map((r) => [r.id, r.availability_updated_at]));
      const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
      assertEq(changed, ["a-stale"], "link-17: only the expired, priced, producer-stated row is confirmed — not unpriced, label, alcohol, «not in stock», fresh or admin rows");
      assertEq((db.prepare("SELECT availability AS a FROM products WHERE id = 'a-out'").get() as any).a, "out_of_stock", "link-17b: an «out of stock» row stays out of stock");
      {
        const lab = db.prepare("SELECT * FROM products WHERE id = 'a-label'").get() as any;
        const codes = cartSvc!.orderabilityReasons(db, lab).reasons.map((x) => x.code);
        assertTrue(codes.includes("category_label"), "link-17d: the fixture «a-label» really is a category label");
        assertEq([lab.availability_source, lab.availability_updated_at], ["enrichment", ago(12)], "link-17e: … and it was not confirmed (source and timestamp unchanged)");
      }
      // A token signed for another producer with A's notice → invalid, nothing written.
      const cross = sc.makeStockCheckToken(B, res!.nonce, new Date(Date.now() + DAY))!;
      const snapB2 = JSON.stringify(productsOf(B));
      const cx = await invoke(H.post, makeReq({ params: { token: cross } }));
      assertEq([cx.status, JSON.stringify(productsOf(B)), JSON.stringify(productsOf(A))], [400, snapB2, JSON.stringify(productsOf(A))], "link-17c: a token for producer B with A's notice → 400, nothing written");
      assertEq([JSON.stringify(productsOf(B)), JSON.stringify(productsOf(OFF))], [snapB, snapOff], "link-18: another producer's rows are never written through A's link");

      // Expired link.
      const old = sc.reserveStockCheckNotice(B, [{ id: "b-soon", name: "Purre", price_nok: 30, unit: "kg", expires_at: T.toISOString() }], { db, now: new Date(T.getTime() + 30 * DAY) });
      const t3 = sc.makeStockCheckToken(B, old!.nonce, new Date(Date.now() - 1000))!;
      db.prepare("UPDATE products SET availability_updated_at = ? WHERE id = 'b-soon'").run(ago(12));
      const e1 = await invoke(H.get, makeReq({ method: "GET", params: { token: t3 } }));
      const e2 = await invoke(H.post, makeReq({ params: { token: t3 } }));
      assertEq([e1.status, e2.status, updatedAt("b-soon")], [410, 410, ago(12)], "link-19: an expired link → 410, nothing written");
      assertEq(sc.verifyStockCheckToken(t2, { db, now: new Date(Date.now() + 2 * DAY) }).state, "expired", "link-20: verify honours the expiry");
      // Orders switched off after the e-mail: the row is no longer orderable for a
      // profile reason → the link writes nothing.
      const late = sc.reserveStockCheckNotice(B, [{ id: "b-soon", name: "Purre", price_nok: 30, unit: "kg", expires_at: T.toISOString() }], { db, now: new Date(T.getTime() + 60 * DAY) });
      const t4 = sc.makeStockCheckToken(B, late!.nonce, new Date(Date.now() + DAY))!;
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = ?").run(B);
      const o1 = await invoke(H.post, makeReq({ params: { token: t4 } }));
      assertTrue(o1.status === 200 && String(o1.body).includes("Ingen varer å bekrefte") && updatedAt("b-soon") === ago(12), "link-21: orders off since the e-mail → the link confirms nothing");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = ?").run(B);
      const o2 = await invoke(H.post, makeReq({ params: { token: t4 } }));
      assertTrue(o2.status === 200 && updatedAt("b-soon") !== ago(12), "link-22: … and with orders on again, the same link confirms it");
    }

    // ═══ the reservation ════════════════════════════════════════════════════
    {
      seedProducer(FAIL);
      seedProduct(FAIL, "fail-soon", { name: "Brokkoli" });
      const failingSend = async () => "failed" as const;
      const r1 = await sc.processStockCheckReminders({ now: T, db, send: failingSend });
      assertEq([r1.failed, noticeRows(FAIL).map((r) => r.status)], [1, ["failed"]], "safe-2: a failed send is recorded as 'failed'");
      const before = sent.length;
      const r2 = await sc.processStockCheckReminders({ now: new Date(T.getTime() + 2 * 3600_000), db });
      assertEq([r2.sent, sent.length - before, noticeRows(FAIL).length], [0, 0, 1], "safe-3: … and not retried inside the 14-day window");
      const x1 = sc.reserveStockCheckNotice(FAIL, [], { db, now: new Date(T.getTime() + 20 * DAY) });
      const x2 = sc.reserveStockCheckNotice(FAIL, [], { db, now: new Date(T.getTime() + 20 * DAY) });
      assertEq([!!x1, x2], [true, null], "safe-4: two reservations in the same window → only the first lands");
      const cols = (db.prepare("PRAGMA table_info(stock_check_notices)").all() as any[]).map((c) => c.name).sort();
      assertEq(cols, ["agent_id", "confirmed_at", "confirmed_count", "created_at", "id", "item_count", "link_expires_at", "product_ids", "sent_at", "status"].sort(), "safe-5: the schema has every column the module uses");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { notifySvc?.__setOrderNotifySendForTesting(null); notifySvc?.__setOrderNotifyTestDb(null); } catch { /* ignore */ }
    try { cartSvc?.__setCartTestDb(null); } catch { /* ignore */ }
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runStockCheckReminderB2Tests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nstock-check-reminder-b2: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
