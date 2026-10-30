/**
 * bestillinger-b1a.test.ts — dev-request 2026-10-28-rfb-bestillinger-fra-start-
 * til-slutt-for-eier, slice B1a (L3 fix-up): the B1 card «Varer som kan
 * bestilles», its POSTs, the B2 stock-check banner, the B2 e-mail job and its
 * confirm link are behind the owner-features allowlist
 * (OWNER_FEATURES_ALLOWED_SUBJECTS, `rfb:<id>`) as well as their flags, so
 * turning a flag on to test with the test producer is not a rollout.
 *
 *   portal-*  OWNER_ORDERABILITY_PORTAL_ENABLED=1: a verified owner OFF the list
 *             gets portal HTML byte-identical to flag off (no card, no banner,
 *             no B1 alert); the test producer ON the list sees card + banner.
 *   route-*   off the list: every B1/B2 portal POST → 404, nothing written;
 *             on the list: the POST works.
 *   job-*     STOCK_CHECK_EMAIL_ENABLED=1: the job never selects (e-mails or
 *             reserves for) a producer off the list; empty allowlist = no run.
 *   link-*    the /lagerstatus/:token page → 404 (GET and POST) for a producer
 *             off the list, nothing written; works for the one on it.
 *   probe-*   the switch probe's stock_check readers follow the same gating.
 *
 * Fresh in-memory SQLite with the production schema, e-mail transport stubbed.
 * Standalone: npx tsx src/routes/bestillinger-b1a.test.ts
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
  "OWNER_PAUSE_ENABLED", "OWNER_ORDER_EMAIL_ENABLED",
];

const TP = "b1a-test-producer"; // on the allowlist
const REAL = "b1a-real-owner";  // verified owner, NOT on the allowlist

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export async function runBestillingerB1aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const sent: Array<{ to: string; subject: string }> = [];
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }
  let notifySvc: typeof import("../services/order-notify-service") | null = null;
  let cartSvc: typeof import("../services/cart-service") | null = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ADMIN_KEY = "b1a-test-admin-key";
    for (const m of ["./owner-portal", "./stock-check", "../services/stock-check-reminder", "../services/owner-orderability"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
    notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
    const sc = require("../services/stock-check-reminder") as typeof import("../services/stock-check-reminder");
    const oo = require("../services/owner-orderability") as typeof import("../services/owner-orderability");
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const routeMod = require("./stock-check") as typeof import("./stock-check");
    const probe = require("../owner-features/switch-probe") as typeof import("../owner-features/switch-probe");
    cartSvc.__setCartTestDb(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async (o) => {
      sent.push({ to: o.to, subject: o.subject });
      return { success: true, messageId: "stub" };
    });

    // ── Fixture: two eligible, verified owners, each with one row expiring in 2 days ──
    const T = new Date(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
    const ago = (d: number) => sqlTs(new Date(T.getTime() - d * DAY));
    const emailOf = (id: string) => `post@${id}.example.no`;
    const tokens: Record<string, string> = {};
    for (const id of [TP, REAL]) {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in)
         VALUES (?, ?, 'Testprodusent B1a.', 'test', ?, ?, 'producer', ?, 59.91, 10.75, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
      ).run(id, `B1a Gard ${id}`, emailOf(id), `https://${id}.example.no`, `key-${id}`);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten gård.', 'verified', 0)`,
      ).run(id, emailOf(id), `https://${id}.example.no`);
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, emailOf(id), tokens[id], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
      for (const [suffix, name, avail] of [["soon", "Gulrøtter", "in_stock"], ["out", "Purre", "out_of_stock"]] as const) {
        db.prepare(
          `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, availability_source, availability_updated_at)
           VALUES (?, ?, ?, ?, 30, 'kg', ?, 'vegetables', 'producer_dashboard', ?)`,
        ).run(`${id}-${suffix}`, id, name, name.toLowerCase(), avail, ago(12));
      }
    }
    const setAllow = (ids: string[]) => {
      if (ids.length) process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = ids.map((id) => `rfb:${id}`).join(",");
      else delete process.env.OWNER_FEATURES_ALLOWED_SUBJECTS;
    };
    const productsOf = (id: string) => JSON.stringify(db.prepare("SELECT * FROM products WHERE agent_id = ? ORDER BY id").all(id));
    const auditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n as number;
    const noticeRows = (id: string) => db.prepare("SELECT * FROM stock_check_notices WHERE agent_id = ?").all(id) as any[];
    const reminders = (id: string) => sent.filter((m) => m.to === emailOf(id) && m.subject === "Bekreft at varene fortsatt er på lager");

    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      one: findRouteHandler(portalMod.default, "/eier/:agentId/varer/:productId/bekreft", "post"),
      all: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-alle", "post"),
      ny: findRouteHandler(portalMod.default, "/eier/:agentId/varer/ny", "post"),
      banner: findRouteHandler(portalMod.default, "/eier/:agentId/varer/bekreft-lagerpaminnelse", "post"),
      get: findRouteHandler(routeMod.default, "/lagerstatus/:token", "get"),
      post: findRouteHandler(routeMod.default, "/lagerstatus/:token", "post"),
    };
    const portal = async (id: string, query: Record<string, string> = {}) =>
      String((await invoke(H.portal, makeReq({ method: "GET", params: { agentId: id }, query, token: tokens[id] }))).body ?? "");
    const ORIGIN = { origin: "https://rettfrabonden.com" };
    const posts = (id: string): Array<[string, Function, Record<string, string>, any]> => [
      ["bekreft", H.one, { agentId: id, productId: `${id}-out` }, {}],
      ["bekreft-alle", H.all, { agentId: id }, {}],
      ["ny", H.ny, { agentId: id }, { name: "Ny vare B1a", price: "10" }],
      ["bekreft-lagerpaminnelse", H.banner, { agentId: id }, { id: [`${id}-soon`] }],
    ];
    // The portal for REAL is rendered with the same query strings in both states,
    // including a B1 status that would show a B1 alert with the card on.
    const QUERIES: Array<Record<string, string>> = [{}, { status: "vare_bekreftet" }, { status: "varer_bekreftet", uten_pris: "1" }, { status: "lager_bekreftet" }];

    // ═══ the portal: off the list = byte-identical to flag off ═════════════════
    setAllow([TP]);
    {
      const offHtml: string[] = [];
      for (const q of QUERIES) offHtml.push(await portal(REAL, q));
      const offTp = await portal(TP);
      assertTrue(offHtml[0].includes("Profilinformasjon") && !offHtml[0].includes("bestillbare-varer"), "portal-0: flag off → the portal renders without the card");
      assertTrue(!offTp.includes("bestillbare-varer"), "portal-0b: flag off → no card even for the allowlisted test producer");
      process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
      for (let i = 0; i < QUERIES.length; i++) {
        const onHtml = await portal(REAL, QUERIES[i]);
        assertEq(onHtml === offHtml[i], true, `portal-1.${i}: flag on, verified owner off the list → HTML byte-identical to flag off (${JSON.stringify(QUERIES[i])})`);
        assertTrue(!onHtml.includes("Varer som kan bestilles") && !onHtml.includes("data-stock-check-banner") && !onHtml.includes("/varer/"),
          `portal-2.${i}: off the list → no card, no banner, no B1 form`);
      }
      const tp = await portal(TP);
      assertTrue(tp.includes(`id="bestillbare-varer"`) && tp.includes("Varer som kan bestilles"), "portal-3: the test producer on the list sees the card");
      assertTrue(tp.includes('data-stock-check-banner="1"') && tp.includes(`name="id" value="${TP}-soon"`), "portal-4: … and the stock-check banner with its soon-expiring item");
      assertTrue((await portal(TP, { status: "vare_bekreftet" })).includes("Varen er bekreftet på lager."), "portal-5: … and the B1 alert");
      assertEq([oo.ownerOrderabilityPortalEnabledFor(TP), oo.ownerOrderabilityPortalEnabledFor(REAL), oo.ownerOrderabilityPortalEnabledFor("")], [true, false, false],
        "portal-6: ownerOrderabilityPortalEnabledFor = flag AND `rfb:<id>` on the list");
      setAllow([]);
      assertTrue(!(await portal(TP)).includes("bestillbare-varer"), "portal-7: empty allowlist → nobody sees the card, not even the test producer");
      setAllow([TP]);
    }

    // ═══ the routes: off the list → 404, nothing written ═══════════════════════
    {
      const before = productsOf(REAL);
      const a0 = auditCount();
      for (const [name, h, params, body] of posts(REAL)) {
        const r = await invoke(h, makeReq({ params, body, token: tokens[REAL], headers: ORIGIN }));
        assertEq(r.status, 404, `route-1: off the list, flag on → POST ${name} → 404`);
      }
      assertEq([productsOf(REAL), auditCount()], [before, a0], "route-2: off the list → nothing written, no audit row");
      const r = await invoke(H.one, makeReq({ params: { agentId: TP, productId: `${TP}-out` }, token: tokens[TP], headers: ORIGIN }));
      assertEq([r.status, r.body?.__redirect], [303, `/eier/${TP}/portal?status=vare_bekreftet#bestillbare-varer`], "route-3: on the list → POST bekreft works (303 back to the card)");
      assertEq((db.prepare("SELECT availability FROM products WHERE id = ?").get(`${TP}-out`) as any).availability, "in_stock", "route-4: … and writes");
      delete process.env.OWNER_ORDERABILITY_PORTAL_ENABLED;
      const off = await invoke(H.one, makeReq({ params: { agentId: TP, productId: `${TP}-out` }, token: tokens[TP], headers: ORIGIN }));
      assertEq(off.status, 404, "route-5: flag off → 404 even on the list (unchanged)");
    }

    // ═══ the e-mail job: never selects a producer off the list ═════════════════
    process.env.STOCK_CHECK_EMAIL_ENABLED = "1";
    {
      setAllow([]);
      const r0 = await sc.processStockCheckReminders({ now: T, db });
      assertEq([r0.enabled, r0.candidates, r0.sent, sent.length, noticeRows(TP).length + noticeRows(REAL).length], [true, 0, 0, 0, 0],
        "job-1: empty allowlist → no candidate, no e-mail, no reservation");
      setAllow([TP]);
      assertEq(sc.soonExpiringItems(REAL, { db, now: T }).length, 1, "job-2: the off-list producer does have a soon-expiring row (and the feature on)");
      assertTrue(sc.stockCheckOn(REAL, { db }), "job-2b: … products.stock_check is on for it");
      const r1 = await sc.processStockCheckReminders({ now: T, db });
      assertEq([r1.candidates, r1.sent, r1.feature_off], [1, 1, 0], "job-3: one candidate (the test producer), one e-mail");
      assertEq([reminders(TP).length, reminders(REAL).length], [1, 0], "job-4: the test producer gets the e-mail; the owner off the list gets none");
      assertEq([noticeRows(TP).length, noticeRows(REAL).length], [1, 0], "job-5: no reservation row for the producer off the list");
      const r2 = await sc.processStockCheckReminders({ now: new Date(T.getTime() + 3600_000), db });
      assertEq([r2.candidates, reminders(REAL).length, noticeRows(REAL).length], [0, 0, 0], "job-6: a second run still never selects it");
      assertEq([sc.stockCheckAllowlisted(TP), sc.stockCheckAllowlisted(REAL), sc.stockCheckAllowlisted(TP, {})], [true, false, false],
        "job-7: stockCheckAllowlisted reads `rfb:<id>` from the given env");
    }

    // ═══ the confirm link: off the list → 404 ══════════════════════════════════
    {
      const res = sc.reserveStockCheckNotice(REAL, [{ id: `${REAL}-soon`, name: "Gulrøtter", price_nok: 30, unit: "kg", expires_at: T.toISOString() }], { db, now: T });
      const tok = sc.makeStockCheckToken(REAL, res!.nonce, new Date(Date.now() + DAY))!;
      assertEq(sc.verifyStockCheckToken(tok, { db }).state, "valid", "link-0: the off-list producer's token is itself valid");
      const before = productsOf(REAL);
      const g = await invoke(H.get, makeReq({ method: "GET", params: { token: tok } }));
      const p = await invoke(H.post, makeReq({ params: { token: tok }, headers: ORIGIN }));
      assertEq([g.status, p.status, productsOf(REAL)], [404, 404, before], "link-1: off the list → GET and POST 404, nothing written");
      assertTrue(!String(g.body).includes("Gulrøtter"), "link-2: … and the page shows nothing about the items");
      setAllow([TP, REAL]);
      const g2 = await invoke(H.get, makeReq({ method: "GET", params: { token: tok } }));
      assertEq(g2.status, 200, "link-3: the same token works once the producer is on the list");
      setAllow([TP]);
      const own = sc.reserveStockCheckNotice(TP, [{ id: `${TP}-soon`, name: "Gulrøtter", price_nok: 30, unit: "kg", expires_at: T.toISOString() }], { db, now: new Date(T.getTime() + 20 * DAY) });
      const t2 = sc.makeStockCheckToken(TP, own!.nonce, new Date(Date.now() + DAY))!;
      const p2 = await invoke(H.post, makeReq({ params: { token: t2 }, headers: ORIGIN }));
      assertTrue(p2.status === 200 && String(p2.body).includes("Takk! Varene er bekreftet på lager"), "link-4: on the list → POST confirms");
      delete process.env.STOCK_CHECK_EMAIL_ENABLED;
      const g3 = await invoke(H.get, makeReq({ method: "GET", params: { token: t2 } }));
      assertEq(g3.status, 404, "link-5: flag off → 404 even on the list (unchanged)");
    }

    // ═══ the switch probe's readers follow the gating ═════════════════════════
    {
      const readers = probe.defaultSwitchProbeReaders();
      const ctx = (id: string, env: NodeJS.ProcessEnv): any => ({ db, fixture: { id }, env, adminKey: "x", created: new Map() });
      const onEnv = { OWNER_FEATURES_ALLOWED_SUBJECTS: `rfb:${TP}` } as NodeJS.ProcessEnv;
      const job = readers["products.stock_check × job:stock_check"];
      const banner = readers["products.stock_check × owner_portal"];
      assertEq([await job.read(ctx(TP, onEnv)), await job.read(ctx(REAL, onEnv))].map((o: any) => o.endpoints.stock_check_job), [true, false],
        "probe-1: job reader — on the list included, off the list skipped");
      assertEq([await banner.read(ctx(TP, onEnv)), await banner.read(ctx(REAL, onEnv))].map((o: any) => o.endpoints.stock_check_banner), [true, false],
        "probe-2: banner reader — on the list can show, off the list never");
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
  runBestillingerB1aTests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nbestillinger-b1a: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
