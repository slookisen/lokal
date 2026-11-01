/**
 * owner-features-s2e.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2e («side v2», Daniel 2026-10-28): the redesigned «Mine valg» page
 * and the /eier portal cards. Acceptance criteria 25–30:
 *
 *   AC25  no coming_soon entry is a switch in the main view; all are in the
 *         closed «Planlagt — si fra hvis du vil ha dette (N)» box; «Gi meg
 *         beskjed» stores ONE interest row per (subject, key) and changes no
 *         effect; admins read the counts (GET /admin/owner-features/interest);
 *         an API call that tries to change a coming_soon key → 409, no effect.
 *   AC26  exactly two levels; a stored «aktiv» / «full_fart» reads as «Ta imot
 *         bestillinger» and changes no switch; a level is marked only after
 *         the owner's own choice (armed test producer: none marked).
 *   AC27  over the whole registry: an unbuilt entry has no value text, in its
 *         row or in «Slik er du nå».
 *   AC28  the orders.enabled row has the explanation and the prerequisite
 *         check: 0 orderable items → «Du har 0 varer som kan bestilles» + the
 *         link to the items; N → N, the same count as
 *         isRowOrderableForRealOrder.
 *   AC29  the portal has no «Bestillinger» card and no pause card for a
 *         profile with «Mine valg»; both choices (and the order address) are
 *         in «Mine valg» with the same effect (the 12-surface pause matrix and
 *         the order-address case live in owner-feature-matrix.test.ts).
 *   AC30  «Ja takk» on the first-login card → the «Nyheter og tips» row shows
 *         «På» at once.
 *   plus  principle 7 wording, principle 9 (foldable cards, jump links,
 *         row-swap forms), escaping of the new parts.
 *
 * Real routers + services on the production schema in an in-memory DB;
 * handlers pulled off the router stacks (same harness as owner-features-s2b).
 * Exported runOwnerFeaturesS2eTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s2e.test.ts
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
  headers: Record<string, string>;
}

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const SAVED_ENV = [
  ALLOW_ENV, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_PAUSE_ENABLED",
  "OWNER_ORDER_EMAIL_ENABLED", "OWNER_FEATURES_ENFORCE", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY",
  "ORDER_REMINDER_HOURS", "ORDER_AUTOCANCEL_HOURS", "ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", "ORDER_CAP_NOTICE_ENABLED",
];
const OWNED_ID = "s2e-owned";
const EMPTY_ID = "s2e-empty";
const TWO_ID = "s2e-two";
const LEGACY_AKTIV_ID = "s2e-legacy-aktiv";
const LEGACY_FULL_ID = "s2e-legacy-full";
const NEWS_NO_ID = "s2e-news-no";
const NEWS_ROW_ID = "s2e-news-row";
const OTHER_ID = "s2e-other";
const XSS_ID = "s2e-xss";
const XSS_NAME = `Gard <b>"x"</b> & 'Sønn'`;
const ADMIN_KEY = "s2e-admin-key";
const OWNER_EMAIL = "eier@s2e-fixture.example.no";

function seedProducer(db: Database.Database, id: string, o: { name?: string; products?: Array<{ availability: string; source: string | null }> } = {}): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for Mine valg v2.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 0)`,
  ).run(id, o.name ?? `Valgside Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  (o.products ?? []).forEach((p, i) => {
    db.prepare(
      `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
       VALUES (?, ?, ?, ?, 30, 'kg', ?, 'vegetables', NULL, ?)`,
    ).run(`p-${id}-${i}`, id, `Vare ${i}`, `vare ${i}`, p.availability, p.source);
  });
}

export async function runOwnerFeaturesS2eTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const emailMod = require("../services/email-service") as typeof import("../services/email-service");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };
  const es = emailMod.emailService as any;
  const prevSendConfirm = es.sendOwnerOrderEmailConfirm;
  const confirms: Array<{ to: string; confirmUrl: string }> = [];

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
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
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
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

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  let tpMod: typeof import("./admin-test-producer") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    process.env.ADMIN_KEY = ADMIN_KEY;
    es.sendOwnerOrderEmailConfirm = async (o: any) => {
      confirms.push({ to: String(o.to), confirmUrl: String(o.confirmUrl) });
      return { success: true, messageId: "stub" };
    };
    for (const m of ["./owner-portal", "./owner-features", "./admin-test-producer", "./admin-owner-features-interest"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const adminInterestRouter = require("./admin-owner-features-interest").default as any;
    tpMod = require("./admin-test-producer") as typeof import("./admin-test-producer");
    tpMod.__setTestProducerDbForTesting(db as any);
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const pg = require("../owner-features/page") as typeof import("../owner-features/page");
    const cart = require("../services/cart-service") as typeof import("../services/cart-service");
    const av = require("../services/agent-visibility") as typeof import("../services/agent-visibility");

    // An orderable row: in stock and producer-confirmed. Not orderable: out of stock, or not producer-stated.
    const OK = { availability: "in_stock", source: "admin_producer_confirmed" };
    seedProducer(db, OWNED_ID, { products: [OK] });
    seedProducer(db, EMPTY_ID);
    seedProducer(db, TWO_ID, { products: [OK, OK, { availability: "out_of_stock", source: "admin_producer_confirmed" }, { availability: "in_stock", source: "enrichment" }] });
    seedProducer(db, LEGACY_AKTIV_ID);
    seedProducer(db, LEGACY_FULL_ID);
    seedProducer(db, NEWS_NO_ID);
    seedProducer(db, NEWS_ROW_ID);
    seedProducer(db, OTHER_ID);
    seedProducer(db, XSS_ID, { name: XSS_NAME });
    const SEEDED = [OWNED_ID, EMPTY_ID, TWO_ID, LEGACY_AKTIV_ID, LEGACY_FULL_ID, NEWS_NO_ID, NEWS_ROW_ID, OTHER_ID, XSS_ID];

    const tokens: Record<string, string> = {};
    const addSession = (id: string, email: string) => {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, email, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    };
    for (const id of SEEDED) addSession(id, `post@${id}.example.no`);

    // The armed hidden test producer (real POST /admin/test-producer, mode arm, with owner_email).
    const TP = findRouteHandler(tpMod.default, "/", "post");
    const arm = await invoke(TP, makeReq({ body: { apply: true, email: "ordre@s2e-fixture.example.no", owner_email: OWNER_EMAIL }, headers: { "x-admin-key": ADMIN_KEY } }));
    const FIX = String(arm.body?.agent_id ?? "");
    assertTrue(arm.status === 200 && !!FIX, "setup: the test producer is armed through the real admin route");
    addSession(FIX, OWNER_EMAIL);
    const ALL = [...SEEDED, FIX];
    setEnv(ALLOW_ENV, ALL.map((id) => `rfb:${id}`).join(","));

    const H = {
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
      niva: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/niva", "post"),
      angre: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/angre", "post"),
      intro: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/intro", "post"),
      interest: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/interesse", "post"),
      orderEmail: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/ordre-epost", "post"),
      put: findRouteHandler(featuresMod.default, "/api/owner/:id/features/:key", "put"),
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      admin: findRouteHandler(adminInterestRouter, "/", "get"),
    };
    const page = (id: string, query: Record<string, string> = {}) => invoke(H.page, makeReq({ params: { agentId: id }, query, token: tokens[id] }));
    const html = (r: HandlerResult) => String(r.body ?? "");
    const pageHtml = async (id: string, query: Record<string, string> = {}) => html(await page(id, query));
    const post = (h: Function, id: string, body: any, token: string | undefined = tokens[id]) => {
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      return invoke(h, makeReq({ params: { agentId: id }, body, token }));
    };
    const put = (id: string, key: string, value: unknown) => {
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      return invoke(H.put, makeReq({ params: { id, key }, body: { value }, token: tokens[id] }));
    };
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as any)?.n ?? 0);
    const optInCol = (id: string) => (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v;
    const writes = (id: string) => [
      count("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?", id),
      count("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ?", id),
      count("SELECT COUNT(*) AS n FROM owner_feature_change_batch WHERE subject_id = ?", id),
    ];
    const row = (b: string, key: string) => {
      const i = b.indexOf(`data-key="${key}"`);
      if (i < 0) return "";
      const ctl = b.indexOf(`<div class="mv-item-ctl">`, i);
      return b.slice(i, b.indexOf("</div>\n        </li>", ctl));
    };
    const plannedBox = (b: string) => {
      const i = b.indexOf(`id="planlagt"`);
      return i < 0 ? "" : b.slice(b.lastIndexOf("<details", i), b.indexOf("</details>", i) + "</details>".length);
    };
    const plannedRow = (b: string, key: string) => {
      const i = b.indexOf(`data-planned-key="${key}"`);
      return i < 0 ? "" : b.slice(i, b.indexOf("</li>", i));
    };
    const mainView = (b: string) => b.slice(0, b.indexOf(`id="planlagt"`) > 0 ? b.indexOf(`id="planlagt"`) : b.length);
    const SOON = reg.OWNER_FEATURE_REGISTRY.filter((e) => e.status === "coming_soon");
    const LIVE = reg.OWNER_FEATURE_REGISTRY.filter((e) => e.status !== "coming_soon");

    // ═══ AC25 — «Planlagt» ═════════════════════════════════════════════════
    {
      const b = await pageHtml(OWNED_ID);
      const main = mainView(b);
      const box = plannedBox(b);
      assertTrue(SOON.length > 0 && box.length > 0, `AC25: the «Planlagt» box is on the page (${SOON.length} planned entries)`);
      assertTrue(/^<details class="ep-card mv-planned" id="planlagt">/.test(box), "AC25: the box is closed by default (<details> without open)");
      assertTrue(box.includes(`${pg.OWNER_PAGE_PLANNED_TITLE} (${SOON.length})`) && pg.OWNER_PAGE_PLANNED_TITLE === "Planlagt — si fra hvis du vil ha dette",
        "AC25: heading «Planlagt — si fra hvis du vil ha dette (N)» with N = the coming_soon count");
      const misplaced = SOON.filter((e) => b.includes(`data-key="${e.key}"`) || main.includes(`data-planned-key="${e.key}"`));
      assertEq(misplaced.map((e) => e.key), [], "AC25: no coming_soon entry is a row (switch) in the main view");
      const missing = SOON.filter((e) => !box.includes(`data-planned-key="${e.key}"`));
      assertEq(missing.map((e) => e.key), [], "AC25: every coming_soon entry is in the «Planlagt» box");
      assertEq((box.match(/data-planned-key="/g) || []).length, SOON.length, "AC25: the box holds exactly the coming_soon entries");
      const liveInBox = LIVE.filter((e) => box.includes(`data-planned-key="${e.key}"`));
      assertEq(liveInBox.map((e) => e.key), [], "AC25: no built entry is in the box");
      assertTrue(SOON.every((e) => plannedRow(b, e.key).includes("Gi meg beskjed") && plannedRow(b, e.key).includes(`action="/eier/${OWNED_ID}/valg/interesse"`)),
        "AC25: every planned row has «Gi meg beskjed» (a plain POST form)");
      assertTrue(!b.includes("Kommer snart") && !/aria-disabled/.test(b), "AC25: no grey «Kommer snart» switch anywhere on the page");
      assertTrue(LIVE.filter((e) => !e.requires.includes("orders.enabled" as any)).every((e) => main.includes(`data-key="${e.key}"`)),
        "AC25: every built entry (not waiting for orders) is a row in the main view");

      // «Gi meg beskjed»: one row per (subject, key), no effect.
      const KEY = "orders.daily_cap";
      const before = JSON.stringify(rs.resolveOwnerFeatures("rfb", OWNED_ID, { db }).features);
      const w0 = writes(OWNED_ID);
      const i1 = await post(H.interest, OWNED_ID, { key: KEY });
      assertEq([i1.status, loc(i1)], [303, `/eier/${OWNED_ID}/valg?melding=interesse&ved=planlagt-${KEY}#planlagt-${KEY}`], "AC25: «Gi meg beskjed» → 303 back to the row");
      const rows1 = db.prepare("SELECT vertical, subject_id, key, registered_at, actor_detail FROM owner_feature_interest").all() as any[];
      assertEq(rows1.map((r) => [r.vertical, r.subject_id, r.key, r.actor_detail]), [["rfb", OWNED_ID, KEY, `post@${OWNED_ID}.example.no`]], "AC25: one interest row (subject, key, who)");
      assertTrue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(rows1[0]?.registered_at)), "AC25: the interest row has its time (ISO)");
      const i2 = await post(H.interest, OWNED_ID, { key: KEY });
      assertEq([loc(i2).includes("melding=interesse_finnes"), count("SELECT COUNT(*) AS n FROM owner_feature_interest")], [true, 1], "AC25: a second click keeps ONE row (idempotent)");
      assertEq(writes(OWNED_ID), w0, "AC25: no setting, audit or batch row written");
      assertEq(JSON.stringify(rs.resolveOwnerFeatures("rfb", OWNED_ID, { db }).features), before, "AC25: every resolved value unchanged (no effect)");
      const after = await pageHtml(OWNED_ID, { melding: "interesse" });
      assertTrue(plannedRow(after, KEY).includes("Du har sagt fra") && !plannedRow(after, KEY).includes("Gi meg beskjed"), "AC25: the row then says «Du har sagt fra»");
      assertTrue(after.includes("Vi har notert at du vil ha dette"), "AC25: message after the click");
      for (const [label, k] of [["a live key", "orders.enabled"], ["an unknown key", "orders.nope"], ["a prototype name", "__proto__"]]) {
        const r = await post(H.interest, OWNED_ID, { key: k });
        assertEq([loc(r).includes("melding=ugyldig"), count("SELECT COUNT(*) AS n FROM owner_feature_interest")], [true, 1], `AC25: «Gi meg beskjed» for ${label} → refused, nothing stored`);
      }
      assertEq((await post(H.interest, OWNED_ID, { key: KEY }, "")).status, 401, "AC25: «Gi meg beskjed» without a session → 401");
      assertEq((await invoke(H.interest, makeReq({ params: { agentId: OWNED_ID }, body: { key: KEY }, token: tokens[OWNED_ID], headers: { origin: "https://evil.example" } }))).status, 403,
        "AC25: «Gi meg beskjed» cross-site → 403");
      await post(H.interest, OTHER_ID, { key: KEY });
      await post(H.interest, OTHER_ID, { key: "notify.report" });

      // Admin read: counts per key.
      const adm = (key?: string) => invoke(H.admin, makeReq({ headers: key === undefined ? {} : { "x-admin-key": key } }));
      assertEq((await adm()).status, 403, "AC25 admin: no X-Admin-Key → 403");
      assertEq((await adm("wrong")).status, 403, "AC25 admin: wrong key → 403");
      const a = await adm(ADMIN_KEY);
      const byKey = Object.fromEntries(((a.body?.keys ?? []) as any[]).map((k) => [k.key, k]));
      assertEq([a.status, a.body?.success, a.body?.vertical, a.body?.total], [200, true, "rfb", 3], "AC25 admin: 200 with the total");
      assertEq([byKey[KEY]?.count, byKey["notify.report"]?.count, byKey["orders.lead_time"]?.count], [2, 1, 0], "AC25 admin: count per key (2 owners, 1, and 0 for an untouched planned key)");
      assertEq(SOON.filter((e) => !byKey[e.key]).map((e) => e.key), [], "AC25 admin: every planned key is listed");
      assertTrue(!JSON.stringify(a.body).includes(OWNED_ID) && !JSON.stringify(a.body).includes("@"), "AC25 admin: counts only — no subject ids, no addresses");
      assertEq((await invoke(H.admin, makeReq({ query: { vertical: "x" }, headers: { "x-admin-key": ADMIN_KEY } }))).status, 400, "AC25 admin: unknown vertical → 400");

      // API: a coming_soon key cannot be changed (409, no effect) — every one of them.
      const w1 = writes(OWNED_ID);
      const bad: string[] = [];
      for (const e of SOON) {
        const r = await put(OWNED_ID, e.key, e.type === "switch" ? !(e.default.owner === true) : e.type === "number" ? 5 : e.options?.[e.options.length - 1]?.value ?? "x");
        if (r.status !== 409 || r.body?.error !== "coming_soon") bad.push(`${e.key}:${r.status}`);
      }
      assertEq(bad, [], "AC25: PUT on every coming_soon key → 409 coming_soon");
      assertEq(writes(OWNED_ID), w1, "AC25: …and nothing written");
      assertEq(JSON.stringify(rs.resolveOwnerFeatures("rfb", OWNED_ID, { db }).features), before, "AC25: …and no effect");
      const ps = await post(H.sett, OWNED_ID, { key: "orders.daily_cap", value: "5", confirmed: "1" });
      assertEq([loc(ps), writes(OWNED_ID)], [`/eier/${OWNED_ID}/valg?melding=sperret&nokkel=orders.daily_cap&ved=valg-orders.daily_cap#valg-orders.daily_cap`, w1], "AC25: the page form for a coming_soon key is refused too, nothing written");
    }

    // ═══ AC26 — two levels ═════════════════════════════════════════════════
    {
      assertEq(ch.OWNER_LEVELS.map((l) => [l.key, l.label.no]), [["bare_synlig", "Bare synlig"], ["ta_imot_bestillinger", "Ta imot bestillinger"]], "AC26: the registry level model has exactly the two levels");
      const b = await pageHtml(OWNED_ID);
      const lv = b.slice(b.indexOf(`id="niva"`), b.indexOf("</section>", b.indexOf(`id="niva"`)));
      assertEq((lv.match(/data-level="/g) || []).length, 2, "AC26: the page shows exactly two levels");
      assertTrue(lv.includes(`data-level="bare_synlig"`) && lv.includes(`data-level="ta_imot_bestillinger"`), "AC26: «Bare synlig» and «Ta imot bestillinger»");
      assertTrue(!/Full fart|data-level="aktiv"|>Aktiv</.test(b), "AC26: no «Aktiv» / «Full fart» on the page");
      assertTrue(!lv.includes(`aria-current="true"`) && lv.includes("Du har ikke valgt nivå ennå"), "AC26: no level marked before the owner chose one");

      // Stored S2b choices «aktiv» / «full_fart» read as «Ta imot bestillinger», nothing changes.
      for (const [id, legacy] of [[LEGACY_AKTIV_ID, "aktiv"], [LEGACY_FULL_ID, "full_fart"]] as const) {
        db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = ?").run(id);
        const audit = db.prepare(
          `INSERT INTO owner_feature_audit (vertical, subject_id, key, old_json, new_json, actor, actor_detail, at)
           VALUES ('rfb', ?, 'orders.enabled', 'false', 'true', 'owner', 'legacy', '2026-10-27T10:00:00.000Z')`,
        ).run(id);
        const aid = Number(audit.lastInsertRowid);
        db.prepare(
          `INSERT INTO owner_feature_change_batch (vertical, subject_id, kind, level, first_audit_id, last_audit_id, actor_detail, created_at, new_row_keys)
           VALUES ('rfb', ?, 'level', ?, ?, ?, 'legacy', '2026-10-27T10:00:00.000Z', '[]')`,
        ).run(id, legacy, aid, aid);
        const w = writes(id);
        const p = await pageHtml(id);
        assertTrue(p.includes(`aria-current="true" data-level="ta_imot_bestillinger"`), `AC26: a stored «${legacy}» shows as «Ta imot bestillinger»`);
        assertEq([optInCol(id), writes(id), count("SELECT COUNT(*) AS n FROM owner_feature_level_choice WHERE subject_id = ?", id)], [1, w, 0],
          `AC26: reading «${legacy}» changes no switch and writes nothing`);
        const resolved = rs.resolveOwnerFeatures("rfb", id, { db });
        assertEq(ch.currentOwnerLevel("rfb", id, resolved, { db }), "ta_imot_bestillinger", `AC26: currentOwnerLevel(«${legacy}») = ta_imot_bestillinger`);
      }
      const pv = await pageHtml(OWNED_ID, { niva: "full_fart" });
      assertTrue(pv.includes("Bytte til «Ta imot bestillinger»?"), "AC26: an old ?niva=full_fart link previews «Ta imot bestillinger»");

      // Armed test producer: orders on by the arming (admin), no level marked.
      const fx = await page(FIX);
      const fb = html(fx);
      assertEq([fx.status, optInCol(FIX)], [200, 1], "AC26: the armed test producer's page (orders switched on by the arming)");
      assertTrue(!fb.includes(`aria-current="true" data-level=`), "AC26: armed test producer — no level marked (the arming is not the owner's choice)");
      assertTrue(row(fb, "orders.enabled").includes(">På<"), "AC26: …while its orders row says «På»");
      const w = writes(FIX);
      const choose = await post(H.niva, FIX, { level: "ta_imot_bestillinger", confirmed: "1" });
      assertEq([loc(choose), writes(FIX)], [`/eier/${FIX}/valg?melding=niva_valgt&ved=niva#niva`, w], "AC26: the owner chooses «Ta imot bestillinger» — nothing to change, nothing in the audit");
      assertTrue((await pageHtml(FIX)).includes(`aria-current="true" data-level="ta_imot_bestillinger"`), "AC26: …and only now is the level marked");
      const choice = db.prepare("SELECT level, actor_detail, batch_id FROM owner_feature_level_choice WHERE subject_id = ?").get(FIX) as any;
      assertEq(choice, { level: "ta_imot_bestillinger", actor_detail: OWNER_EMAIL, batch_id: null }, "AC26: the owner's choice is stored with who");
      // An owner switch afterwards → «Egendefinert», no longer the level.
      await post(H.sett, FIX, { key: "orders.enabled", value: "false", confirmed: "1" });
      assertTrue((await pageHtml(FIX)).includes("Egendefinert") && !(await pageHtml(FIX)).includes(`aria-current="true" data-level=`), "AC26: a switch changed since → «Egendefinert», no level marked");
      // An admin write (not the owner) never marks a level.
      ch.applyOwnerLevel("rfb", OTHER_ID, "ta_imot_bestillinger", { actor: "admin", detail: "admin" }, { db });
      assertEq([optInCol(OTHER_ID), ch.currentOwnerLevel("rfb", OTHER_ID, rs.resolveOwnerFeatures("rfb", OTHER_ID, { db }), { db })], [1, null],
        "AC26: a level applied by an admin switches orders on but marks no level");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = ?").run(OTHER_ID);
    }

    // ═══ AC27 — no fake values ═════════════════════════════════════════════
    {
      const resolved = rs.resolveOwnerFeatures("rfb", OWNED_ID, { db });
      const valued = SOON.filter((e) => pg.ownerFeatureRowValue(e, resolved.byKey[e.key]) !== null);
      assertEq(valued.map((e) => e.key), [], "AC27: over the whole registry, every coming_soon entry has no value text");
      assertTrue(LIVE.every((e) => pg.ownerFeatureRowValue(e, resolved.byKey[e.key]) !== null), "AC27: every built entry has its value");
      const b = await pageHtml(OWNED_ID);
      const box = plannedBox(b);
      const withState = SOON.filter((e) => /class="mv-state"/.test(plannedRow(box, e.key)) && !plannedRow(box, e.key).includes("Du har sagt fra"));
      assertEq(withState.map((e) => e.key), [], "AC27: no planned row shows a value");
      const status = b.slice(b.indexOf(`class="mv-status"`), b.indexOf("</div>", b.indexOf(`class="mv-status"`)));
      const statusKeys = [...status.matchAll(/data-status-key="([^"]+)"/g)].map((m) => m[1]);
      assertEq(statusKeys, pg.OWNER_PAGE_STATUS_KEYS.filter((k) => reg.getOwnerFeature(k).status !== "coming_soon"), "AC27: «Slik er du nå» lists only built entries");
      assertTrue(!statusKeys.includes("notify.report") && !mainView(b).includes("Månedlig"), "AC27: «Rapport: Månedlig» is gone");
      for (const text of ["Milepæler: På", "Si fra når noe endres på profilen min: På", "Minn meg på å bekrefte lagerstatus: På", "Rapport om profilen din:"]) {
        assertTrue(!b.includes(text) && !b.replace(/<[^>]+>/g, "").includes(text), `AC27: no «${text}» on the page`);
      }
      assertTrue(!b.includes("Gjelder ikke"), "AC27 / principle 7: «Gjelder ikke» is never used");
      assertEq(pg.formatOwnerFeatureValue(reg.getOwnerFeature("orders.pickup_times"), null), "Ikke valgt", "principle 7: an empty value reads «Ikke valgt»");
    }

    // ═══ AC28 — orders.enabled: explanation + prerequisite check ═══════════
    {
      const b = await pageHtml(OWNED_ID);
      const r = row(b, "orders.enabled");
      for (const t of ["Slik fungerer det", "Dette må du gjøre", "Slik slår du av", "«Ny henteordre»", "bekrefter eller avslår", "Du trenger ikke logge inn",
        "påminnelse etter 24 timer", "ubesvart etter 72 timer, blir den kansellert", "betaler når varene hentes"]) {
        assertTrue(r.includes(t), `AC28: the explanation says «${t}»`);
      }
      assertTrue(/<details class="mv-explain-box">/.test(r), "AC28: the explanation folds out (<details>, closed)");
      assertTrue(!r.includes("Les mer") && !r.includes("/for-produsenter"), "AC28: no «Les mer» link while the FAQ page is not published (inline text only)");
      assertEq(featuresMod.ORDERS_FAQ_URL, null, "AC28: the FAQ URL is unset (page not published)");
      setEnv("ORDER_REMINDER_HOURS", "12");
      setEnv("ORDER_AUTOCANCEL_HOURS", "48");
      const r2 = row(await pageHtml(OWNED_ID), "orders.enabled");
      assertTrue(r2.includes("påminnelse etter 12 timer") && r2.includes("etter 48 timer"), "AC28: the timings come from the real follow-up config");
      setEnv("ORDER_REMINDER_HOURS", null);
      setEnv("ORDER_AUTOCANCEL_HOURS", null);
      // B4 (dev-request 2026-10-28-rfb-bestillinger-fra-start-til-slutt-for-eier):
      // the explanation names the daily cap, read from the configuration.
      setEnv("ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", null);
      const c10 = row(await pageHtml(OWNED_ID), "orders.enabled");
      assertTrue(c10.includes("Du kan få inntil 10 bestillinger per døgn.") && c10.includes(`data-order-cap="10"`), "B4: the explanation names the default daily cap (10)");
      assertTrue(!c10.includes("én samlet e-post"), "B4: no digest promise while ORDER_CAP_NOTICE_ENABLED is off");
      setEnv("ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", "7");
      setEnv("ORDER_CAP_NOTICE_ENABLED", "1");
      const c7 = row(await pageHtml(OWNED_ID), "orders.enabled");
      assertTrue(c7.includes("Du kan få inntil 7 bestillinger per døgn.") && !c7.includes("inntil 10"), "B4: cap 7 in the configuration → the text says 7");
      assertTrue(c7.includes("kunden får kontaktinformasjonen din i stedet, og du får én samlet e-post om det dagen etter."), "B4: with the notice on, the text names the daily digest");
      setEnv("ORDER_CAP_NEW_PER_PRODUCER_PER_DAY", null);
      setEnv("ORDER_CAP_NOTICE_ENABLED", null);
      const withFaq = pg.renderOwnerFeaturesPageBody({
        agent: { id: OWNED_ID, name: "Gard" }, resolved: rs.resolveOwnerFeatures("rfb", OWNED_ID, { db }), level: null, showIntro: false,
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
        ordersReadMoreUrl: "/for-produsenter#bestillinger",
      });
      assertTrue(row(withFaq, "orders.enabled").includes(`<a href="/for-produsenter#bestillinger">Les mer</a>`), "AC28: with a published FAQ the row links «Les mer» to the anchor");

      // 0 orderable items.
      const e0 = row(await pageHtml(EMPTY_ID), "orders.enabled");
      assertTrue(e0.includes("Du har 0 varer som kan bestilles. Legg inn varer eller hent dem fra nettsiden din.") && e0.includes(`href="/selger?agent=${EMPTY_ID}"`),
        "AC28: 0 items → «Du har 0 varer som kan bestilles …» + the link to the items");
      assertTrue(e0.includes(`name="value" value="true"`) && e0.includes("Slå på"), "AC28: the switch can still be switched on with 0 items");
      assertTrue(e0.indexOf("Du har 0 varer") < e0.indexOf(`<div class="mv-item-ctl">`), "AC28: the check stands above the switch");
      setEnv("OWNER_UNIFIED_SESSION_ENABLED", "1");
      assertTrue(row(await pageHtml(EMPTY_ID), "orders.enabled").includes(`href="/eier/${EMPTY_ID}/portal#produkter"`), "AC28: with the unified session the link goes to the portal's products card");
      setEnv("OWNER_UNIFIED_SESSION_ENABLED", null);

      // N orderable items, = isRowOrderableForRealOrder (orders off: counted as if on, nothing kept).
      const w = writes(TWO_ID);
      const t0 = row(await pageHtml(TWO_ID), "orders.enabled");
      assertTrue(t0.includes("Du har 2 varer som kan bestilles.") && t0.includes(`data-orderable="2"`), "AC28: N items → «Du har 2 varer som kan bestilles»");
      assertEq([optInCol(TWO_ID), writes(TWO_ID)], [0, w], "AC28: counting while orders are off keeps nothing (rolled back)");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = ?").run(TWO_ID);
      const rows = db.prepare("SELECT agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE agent_id = ?").all(TWO_ID) as any[];
      const direct = rows.filter((x) => cart.isRowOrderableForRealOrder(db, x)).length;
      assertEq([direct, featuresMod.countOwnerOrderableItems(TWO_ID, db)], [2, 2], "AC28: the count equals isRowOrderableForRealOrder over the producer's rows (orders on)");
      assertTrue(row(await pageHtml(TWO_ID), "orders.enabled").includes("Du har 2 varer som kan bestilles."), "AC28: same text with orders on");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = ?").run(TWO_ID);
      assertEq(featuresMod.countOwnerOrderableItems(OWNED_ID, db), 1, "AC28: one orderable item → 1");
      assertTrue(row(await pageHtml(OWNED_ID), "orders.enabled").includes("Du har 1 vare som kan bestilles."), "AC28: singular «1 vare»");
      assertEq(featuresMod.countOwnerOrderableItems("s2e-nobody", db), 0, "AC28: unknown producer → 0");
    }

    // ═══ AC29 — one switch, one place ══════════════════════════════════════
    {
      setEnv("OWNER_PAUSE_ENABLED", "1");
      setEnv("OWNER_ORDER_EMAIL_ENABLED", "1");
      const portal = (id: string) => invoke(H.portal, makeReq({ params: { agentId: id }, token: tokens[id] }));
      const p = html(await portal(OWNED_ID));
      assertTrue(!p.includes("Motta bestillinger på e-post") && !p.includes(`action="/eier/${OWNED_ID}/order-notifications"`), "AC29: the portal has no «Bestillinger» card (no orders switch)");
      assertTrue(!p.includes(`id="pause"`) && !p.includes("Pause og sletting") && !p.includes(`action="/eier/${OWNED_ID}/pause"`), "AC29: the portal has no pause card");
      assertTrue(!p.includes(`action="/eier/${OWNED_ID}/order-email"`), "AC29: the portal has no order-address form");
      assertTrue(p.includes(`href="/eier/${OWNED_ID}/valg#gruppe-orders"`) && p.includes(`href="/eier/${OWNED_ID}/valg#gruppe-visibility"`), "AC29: …but links to both in «Mine valg»");
      setEnv(ALLOW_ENV, ALL.filter((id) => id !== OWNED_ID).map((id) => `rfb:${id}`).join(","));
      const old = html(await portal(OWNED_ID));
      assertTrue(old.includes("Motta bestillinger på e-post") && old.includes(`id="pause"`) && old.includes(`action="/eier/${OWNED_ID}/order-email"`) && !old.includes("Bestillinger og pause"),
        "AC29: a profile without «Mine valg» keeps the old cards unchanged");
      setEnv(ALLOW_ENV, ALL.map((id) => `rfb:${id}`).join(","));

      // The pause in «Mine valg»: same row, same effect as the old card.
      const b = await pageHtml(OWNED_ID);
      const pr = row(b, "visibility.profile");
      assertTrue(pr.includes("Slå av") && pr.includes("Be om sletting") && pr.includes("mailto:kontakt@rettfrabonden.com"), "AC29: the pause row (switch + «Be om sletting»)");
      const s1 = await post(H.sett, OWNED_ID, { key: "visibility.profile", value: "false" });
      assertEq(loc(s1), `/eier/${OWNED_ID}/valg?bekreft=visibility.profile&verdi=0#valg-visibility.profile`, "AC29: pausing asks first (confirm panel)");
      const cp = await pageHtml(OWNED_ID, { bekreft: "visibility.profile", verdi: "0" });
      assertTrue(cp.includes(`name="until" type="date"`) && cp.includes("Profilen blir borte fra søk og AI-assistenter"), "AC29: the confirm panel keeps the optional resume date");
      const tooLate = await post(H.sett, OWNED_ID, { key: "visibility.profile", value: "false", confirmed: "1", until: "2001-01-01" });
      assertEq([loc(tooLate), count("SELECT COUNT(*) AS n FROM owner_profile_pause WHERE agent_id = ?", OWNED_ID)], [`/eier/${OWNED_ID}/valg?melding=ugyldig_dato&ved=valg-visibility.profile#valg-visibility.profile`, 0], "AC29: a past resume date → refused, nothing written");
      const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      const s2 = await post(H.sett, OWNED_ID, { key: "visibility.profile", value: "false", confirmed: "1", until });
      const pauseRow = db.prepare("SELECT pause_until, set_by FROM owner_profile_pause WHERE agent_id = ?").get(OWNED_ID) as any;
      assertEq([s2.status, pauseRow], [303, { pause_until: until, set_by: "owner" }], "AC29: pause → the same owner_profile_pause row the old card wrote, with the resume date");
      assertTrue(av.isOwnerPaused(av.readOwnerPauseRow(db as any, OWNED_ID)) && !av.isAgentIdPubliclyVisible(db as any, OWNED_ID, { surface: "ungated", audience: "ai" }),
        "AC29: same effect as the old card (OWNER_PAUSE_ENABLED): the profile is not publicly visible");
      const pp = await pageHtml(OWNED_ID);
      assertTrue(row(pp, "visibility.profile").includes(`til ${until.slice(8, 10)}.${until.slice(5, 7)}.${until.slice(0, 4)}`), "AC29: the row shows the pause and its resume date");
      assertTrue(pp.includes(`data-status-key="visibility.profile"><span>Profilen er synlig:</span> <strong>Av</strong>`), "AC29: «Slik er du nå» shows the profile as not visible");
      const audit = db.prepare("SELECT old_json, new_json, actor FROM owner_feature_audit WHERE subject_id = ? AND key = 'visibility.profile'").all(OWNED_ID);
      assertEq(audit, [{ old_json: "true", new_json: "false", actor: "owner" }], "AC29: one audit row for the pause");
      await post(H.sett, OWNED_ID, { key: "visibility.profile", value: "true", confirmed: "1" });
      assertEq([count("SELECT COUNT(*) AS n FROM owner_profile_pause WHERE agent_id = ?", OWNED_ID), av.isAgentIdPubliclyVisible(db as any, OWNED_ID, { surface: "ungated", audience: "ai" })], [0, true],
        "AC29: «Slå på» resumes: the row is gone, the profile visible again");

      // The order address in «Mine valg» (S1b punkt 7 flow).
      assertTrue(!b.includes(`data-key="orders.email"`), "AC29: the order-address row waits for orders to be on");
      await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      const ob = await pageHtml(OWNED_ID);
      const er = row(ob, "orders.email");
      assertTrue(er.includes(`post@${OWNED_ID}.example.no`) && er.includes(`action="/eier/${OWNED_ID}/valg/ordre-epost"`) && er.includes("Send bekreftelse"),
        "AC29: the orders.email row shows where orders go now and the change form");
      const d = await put(OWNED_ID, "orders.email", "direkte@example.no");
      assertEq([d.status, d.body?.error, (db.prepare("SELECT order_notification_email AS v FROM agents WHERE id = ?").get(OWNED_ID) as any).v], [409, "confirm_by_email", null],
        "AC29: a direct PUT of orders.email → 409 confirm_by_email, column untouched");
      const NEW = "ny@s2e-adresse.example.no";
      const oe = await post(H.orderEmail, OWNED_ID, { email: NEW });
      assertEq([loc(oe), confirms.length, confirms[0]?.to], [`/eier/${OWNED_ID}/valg?melding=ordre_epost_sendt&ved=valg-orders.email#valg-orders.email`, 1, NEW], "AC29: the form mails a confirmation to the NEW address");
      assertEq(portalMod.currentOrderRecipient(OWNED_ID), `post@${OWNED_ID}.example.no`, "AC29: until the click orders still go to the old address");
      assertTrue(row(await pageHtml(OWNED_ID), "orders.email").includes(`Venter på bekreftelse fra <strong>${NEW}</strong>`), "AC29: the row shows the pending change");
      const tok = confirms[0].confirmUrl.split("/").pop() || "";
      assertTrue(portalMod.confirmOwnerOrderEmailChange(tok).ok, "AC29: the confirmation (POST from the link) is accepted");
      assertEq([portalMod.currentOrderRecipient(OWNED_ID), rs.resolveOwnerFeature("rfb", OWNED_ID, "orders.email", { db }).value], [NEW, NEW], "AC29: after the click orders go to the new address (= the row's value)");
      const bad = await post(H.orderEmail, OWNED_ID, { email: "ikke-en-adresse" });
      assertEq(loc(bad).includes("melding=ordre_epost_ugyldig"), true, "AC29: an invalid address → message, nothing sent");
      setEnv("OWNER_ORDER_EMAIL_ENABLED", null);
      const off = row(await pageHtml(OWNED_ID), "orders.email");
      assertTrue(off.includes(NEW) && !off.includes("/valg/ordre-epost"), "AC29: with OWNER_ORDER_EMAIL_ENABLED off the address is shown but not changeable (as the old card)");
      assertEq(loc(await post(H.orderEmail, OWNED_ID, { email: "x@example.no" })).includes("melding=ordre_epost_av"), true, "AC29: …and the form route refuses");
      await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "false", confirmed: "1" });
      setEnv("OWNER_PAUSE_ENABLED", null);
    }

    // ═══ AC30 — the first-login answer is the row's value ══════════════════
    {
      const b0 = await pageHtml(OWNED_ID);
      assertTrue(b0.includes(`id="velkommen"`) && row(b0, "comms.news").includes(">Av<"), "AC30: before the answer: the card, and the row says «Av»");
      const i = await post(H.intro, OWNED_ID, { answer: "yes" });
      const target = loc(i);
      assertTrue(target.startsWith(`/eier/${OWNED_ID}/valg?endret=`), "AC30: «Ja takk» → 303 with the change");
      const bid = String(new URLSearchParams(target.split("?")[1]).get("endret"));
      const b1 = await pageHtml(OWNED_ID, { endret: bid });
      assertTrue(row(b1, "comms.news").includes(">På<") && !b1.includes(`id="velkommen"`), "AC30: the «Nyheter og tips» row shows «På» at once, the card is gone");
      assertTrue(b1.includes("Lagret: «Nyheter og tips» er På.") && b1.includes(">Angre<"), "AC30: the message names the row (and can be undone)");
      assertEq((db.prepare("SELECT value_json, set_by FROM owner_feature_settings WHERE subject_id = ? AND key = 'comms.news'").get(OWNED_ID) as any), { value_json: "true", set_by: "owner" },
        "AC30: stored as the owner's explicit choice");
      assertEq((db.prepare("SELECT answer FROM owner_feature_intro WHERE subject_id = ?").get(OWNED_ID) as any)?.answer, "yes", "AC30: the consent record with its time");
      const n = await post(H.intro, NEWS_NO_ID, { answer: "no" });
      assertEq(loc(n), `/eier/${NEWS_NO_ID}/valg?melding=intro_nei&ved=gruppe-comms#gruppe-comms`, "AC30: «Nei takk» → message");
      const bn = await pageHtml(NEWS_NO_ID);
      assertTrue(row(bn, "comms.news").includes(">Av<") && !bn.includes(`id="velkommen"`), "AC30: «Nei takk» → the row says «Av», no card");
      // Principle 8: set in the row first → the card does not ask again.
      await post(H.sett, NEWS_ROW_ID, { key: "comms.news", value: "true", confirmed: "1" });
      const br = await pageHtml(NEWS_ROW_ID);
      assertTrue(!br.includes(`id="velkommen"`) && row(br, "comms.news").includes(">På<"), "principle 8: answered in the row → the card is not shown");
      assertTrue(!br.includes("Kommer snart") && b0.includes("Svaret ditt blir valget «Nyheter og tips»"), "principle 8: the card promises only what the row does");
    }

    // ═══ Principles 7 + 9 ══════════════════════════════════════════════════
    {
      await post(H.sett, OTHER_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      const b = await pageHtml(OTHER_ID);
      assertEq((b.match(/«Alltid» betyr/g) || []).length, 1, "principle 7: «Alltid» is explained once");
      assertEq((b.match(/«Låst på» betyr/g) || []).length, 1, "principle 7: «Låst på» is explained once");
      const box = plannedBox(b);
      assertTrue(!box.includes("Nytt") && !box.includes("Kommer snart"), "principle 7: no «Nytt» / «Kommer snart» on planned entries");
      const fresh = pg.renderOwnerFeaturesPageBody({
        agent: { id: OTHER_ID, name: "Gard" }, resolved: rs.resolveOwnerFeatures("rfb", OTHER_ID, { db }), level: null, showIntro: false,
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 }, now: new Date("2026-10-29T00:00:00Z"),
      });
      assertTrue(row(fresh, "visibility.profile").includes("Nytt") && !plannedBox(fresh).includes("Nytt"), "principle 7: «Nytt» only on live entries within 30 days");
      assertTrue(b.includes(`<nav class="mv-jump" aria-label="Hopp til">`) && b.includes(`href="#gruppe-orders"`) && b.includes(`href="#planlagt"`) && b.includes(`href="#endringslogg"`),
        "principle 9: jump links at the top");
      assertTrue(pg.OWNER_PAGE_CSS.includes("@media (min-width: 900px) { .mv-jump { display: none; } }"), "principle 9: the jump links are for narrow screens");
      const groups = [...b.matchAll(/<section class="ep-card mv-group" id="(gruppe-[a-z]+)"[^>]*>\s*<details class="mv-fold" open>/g)].map((m) => m[1]);
      assertTrue(groups.length >= 4 && groups.includes("gruppe-orders"), "principle 9: every group card can be folded (<details open>)");
      const rowForms = b.match(/<form method="post" action="\/eier\/[^"]+\/valg\/(sett|interesse|ordre-epost)" class="mv-ctl-form" data-mv-row="[^"]+">/g) || [];
      assertTrue(rowForms.length > 5 && rowForms.every((f) => /data-mv-row="(gruppe-[a-z]+|planlagt)"/.test(f)), "principle 9: row forms name the card the script swaps after a save");
      assertTrue(b.includes(`<div id="mv-toast-slot">`) && !pg.OWNER_PAGE_SCRIPT.includes("window.location") && pg.OWNER_PAGE_SCRIPT.includes("f.submit()"),
        "principle 9: the script swaps the card + message (T5: the confirm panel too, in its row); errors fall back to the plain form POST");
      await post(H.sett, OTHER_ID, { key: "orders.enabled", value: "false", confirmed: "1" });
    }

    // ═══ Escaping (new parts) ══════════════════════════════════════════════
    {
      const x = await pageHtml(XSS_ID, { melding: "interesse" });
      assertTrue(!x.includes(`<b>"x"</b>`) && x.includes("Gard &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#039;Sønn&#039;"), "escaping: agent name escaped");
      assertTrue(x.includes("mailto:kontakt@rettfrabonden.com?subject=") && !/mailto:[^"]*<b>/.test(x), "escaping: the deletion mailto is URL-encoded");
      const body = pg.renderOwnerFeaturesPageBody({
        agent: { id: `<x>"`, name: "n" }, resolved: rs.resolveOwnerFeatures("rfb", XSS_ID, { db }), level: null, showIntro: false,
        notice: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 },
        orderable: { count: 0, itemsHref: `/selger?agent="><script>` },
        orderEmail: { enabled: true, current: `<i>a@b.no</i>`, pending: `"><img src=x>` },
        pauseUntil: "<b>",
      });
      for (const bad of [`"><script>`, "<i>a@b.no", `"><img`, `/eier/<x>`]) assertTrue(!body.includes(bad), `escaping: «${bad}» not emitted raw`);
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    es.sendOwnerOrderEmailConfirm = prevSendConfirm;
    try { tpMod?.__setTestProducerDbForTesting(null as any); } catch { /* ignore */ }
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS2eTests({ log: true }).then((r) => {
    console.info(`\nowner-features-s2e: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
