/**
 * owner-overview-t15b.test.ts — dev-request 2026-10-30-rfb-eierportal-testrunde-1,
 * punkt 9, slice T15b «Oversikt»: the «Oversikt» block on /eier/:id/portal,
 * the menu badges on the three shell pages and the «Nyheter og tips»
 * question moved from Mine valg to Oversikt — behind OWNER_DASHBOARD_ENABLED
 * + the allowlist + a verified owner.
 *
 *   unit      texts in one constant, singular forms, the pure renderer (the
 *             «—» on a failed stats read, the hidden profile, no badges at 0,
 *             no on*= / style= / script), the placement list.
 *   off       flag unset / "0" / a profile off the allowlist: portal, orders
 *             and Mine valg byte-identical to the flag unset (snapshot), and
 *             the T7 question stays on Mine valg.
 *   on        blocks 1–8 in order under the one <h1>; one nav with exactly one
 *             aria-current="page"; no on*= attribute.
 *   counts    the badge numbers = the «Dette bør du gjøre nå» numbers = the
 *             underlying counts (pending orders; the «Varer» card's «Trenger
 *             handling» rows), on all three pages; the zero case shows «Alt er
 *             i orden…» and no badge.
 *   stats     the three numbers = ownerPortalYearStats() (getOwnerStats().year).
 *   news      «Ja takk» from Oversikt: one audit row with placement
 *             oversikt_question + the text version, 303 back to the portal;
 *             «Ikke nå»: no settings row; «Nei»: owner_feature_prompt; with the
 *             dashboard on the question is not on Mine valg.
 *   gate      no session → 302, another producer → 403 (unchanged).
 *   escape    the producer's name/slug are escaped.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stack (same harness as owner-shell-t15a). Exported
 * runOwnerOverviewT15bTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-overview-t15b.test.ts
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

const FLAG = "OWNER_DASHBOARD_ENABLED";
const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ENV_KEYS = [
  FLAG, ALLOW_ENV, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "ORDER_MESSAGES_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY",
  "OWNER_PAUSE_ENABLED", "OWNER_FEATURES_ENFORCE", "STOCK_SOFT_EXPIRY_ENABLED",
];
const BUSY = "t15b-busy";
const ZERO = "t15b-zero";
const OFFLIST = "t15b-offlist";
const OTHER = "t15b-other";
const LATER = "t15b-later";
const NEVER = "t15b-never";
const ESC = "t15b-esc";
const ESC_NAME = `Gård <b>"Ku"</b> & 'Sau'`;
const DAY = 86_400_000;

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function seedProducer(db: Database.Database, id: string, name = `Oversiktgard ${id}`): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for oversikten.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, name, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  db.prepare(
    `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
     VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
  ).run(`claim-${id}`, id, `post@${id}.example.no`);
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
}

function seedOrder(db: Database.Database, agentId: string, n: number, status: string): void {
  const created = sqlTs(new Date(Date.now() - 3_600_000));
  const orderId = `${agentId}-order-${n}`;
  db.prepare(`
    INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                        notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pickup', ?, NULL, 90, NULL, ?, 'Kari Nordmann', 'kari@example.com', ?, ?)
  `).run(orderId, agentId, `bref_${orderId}`, status, `ctok_${orderId}`, created, created, created);
  db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 2, 45, 90)")
    .run(`${orderId}-i1`, orderId);
}

function seedProduct(db: Database.Database, agentId: string, pid: string, p: { name: string; source: string; updated: string | null; availability?: string }): void {
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
     VALUES (?, ?, ?, ?, 30, 'stk', ?, ?, ?)`,
  ).run(pid, agentId, p.name, p.name.toLowerCase(), p.availability ?? "in_stock", p.source, p.updated);
}

function count(h: string, needle: string | RegExp): number {
  if (typeof needle === "string") return h.split(needle).length - 1;
  return (h.match(new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : needle.flags + "g")) || []).length;
}

function shellNav(h: string): string {
  const at = h.indexOf(`<nav class="ow-nav" aria-label="Eierportal">`);
  if (at < 0) return "";
  return h.slice(at, h.indexOf("</nav>", at) + "</nav>".length);
}

/** The «Oversikt» block's markup (from its <style> to the help line), "" when absent. */
function overviewBlock(h: string): string {
  const at = h.indexOf(`<section class="ep-card" id="oversikt"`);
  if (at < 0) return "";
  const styleAt = h.lastIndexOf("<style>", at);
  const helpAt = h.indexOf(`data-ov="help"`, at);
  return h.slice(styleAt, h.indexOf("</p>", helpAt) + 4);
}

/** The badge number and screen-reader text after a nav item ("" when none). */
function navBadge(nav: string, href: string): { n: number | null; sr: string } {
  const at = nav.indexOf(`href="${href}"`);
  if (at < 0) return { n: null, sr: "" };
  const a = nav.slice(at, nav.indexOf("</a>", at));
  const m = /<span class="ow-nav-badge" aria-hidden="true">(\d+)<\/span><span class="ow-sr">([^<]*)<\/span>/.exec(a);
  return m ? { n: Number(m[1]), sr: m[2] } : { n: null, sr: "" };
}

export async function runOwnerOverviewT15bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      let at = 0;
      while (at < a.length && at < e.length && a[at] === e[at]) at++;
      const msg = `✗ ${label}\n    first difference at ${at}\n    expected: …${e.slice(Math.max(0, at - 60), at + 120)}\n    actual:   …${a.slice(Math.max(0, at - 60), at + 120)}`;
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

  const ovr = require("../owner-ui/overview") as typeof import("../owner-ui/overview");
  const nc = require("../owner-features/news-consent") as typeof import("../owner-features/news-consent");
  const T = ovr.OWNER_OVERVIEW_TEXTS;

  // ── Unit ─────────────────────────────────────────────────────────────────
  assertEq([T.visibility.visible, T.visibility.paused, T.visibility.hidden, T.orders.on, T.orders.off, T.orders.onNoItems],
    ["Synlig for kunder", "På pause", "Skjult for kunder", "Tar imot bestillinger", "Tar ikke imot bestillinger", "Bestillinger er på, men ingen varer kan bestilles"],
    "unit: the status texts are in OWNER_OVERVIEW_TEXTS");
  assertEq([ovr.ownerOverviewOrdersLine(1), ovr.ownerOverviewOrdersLine(3), ovr.ownerOverviewItemsLine(1), ovr.ownerOverviewItemsLine(2)],
    ["1 bestilling venter på svar", "3 bestillinger venter på svar", "1 vare bør bekreftes", "2 varer bør bekreftes"], "unit: singular and plural lines");
  assertEq([T.todoOrdersHint, T.todoItemsHint, T.todoNone], ["Bekreft eller avslå i Mine ordrer.", "Bekreft at de fortsatt er på lager.", "Alt er i orden. Du har ingenting som venter."],
    "unit: «Dette bør du gjøre nå» texts");
  assertTrue((nc.OWNER_NEWS_PLACEMENTS as readonly string[]).includes("oversikt_question") && nc.OWNER_NEWS_PLACEMENT_OVERVIEW === "oversikt_question",
    "unit: oversikt_question is a news placement");
  assertEq(ovr.ownerOverviewNewsBack("a b", "yes"), "/eier/a%20b/portal?nyheter=ja#nyheter", "unit: the answer goes back to the portal's news block");
  assertEq(["ja", "ikke_na", "nei", "feil", "x", undefined].map((v) => ovr.parseOwnerOverviewNewsParam(v)), ["yes", "later", "never", "error", null, null], "unit: ?nyheter= parsing");
  const baseModel = {
    agentId: "u1", profileSlug: "u-gard", visibility: "visible" as const, orders: "on" as const, levelText: "Valgene dine passer med «X».",
    counts: { pendingOrders: 0, itemsToConfirm: 0 }, stats: null, showNewsQuestion: true, newsResult: null,
  };
  const pure = ovr.renderOwnerOverview(baseModel);
  assertTrue(!/\son[a-z]+\s*=/i.test(pure) && !/\sstyle="/.test(pure) && !/<script/i.test(pure), "unit: no on*= attribute, no style attribute, no script in the block");
  assertEq(count(pure, `<div class="ep-stat-num">—</div>`), 3, "unit: a failed stats read shows «—» three times");
  assertTrue(pure.includes(T.todoNone) && !pure.includes(`data-todo="orders"`), "unit: zero counts → «Alt er i orden…»");
  const hidden = ovr.renderOwnerOverview({ ...baseModel, visibility: "hidden" });
  assertTrue(!hidden.includes(`href="/produsent/`) && hidden.includes(`<p class="ow-ov-line" data-ov="profile">Skjult for kunder</p>`), "unit: hidden profile → «Skjult for kunder» without a link");
  const paused = ovr.renderOwnerOverview({ ...baseModel, visibility: "paused", orders: "on_no_items" });
  assertTrue(paused.includes(">På pause<") && paused.includes(`href="/produsent/u-gard"`) && paused.includes(">Bestillinger er på, men ingen varer kan bestilles<"), "unit: paused keeps the profile link; on with no items");
  const withStats = ovr.renderOwnerOverview({ ...baseModel, stats: { humanViews: { value: 12, label: "siste 12 måneder" }, aiViews: { value: 3, label: "siste 12 måneder" }, aiDeliveries: { value: 7, label: "siden 1. okt. 2026" } } });
  assertTrue(withStats.includes(`<div class="ep-stat-num">12</div><div class="ep-stat-label">Sidevisninger fra mennesker (siste 12 måneder)</div>`) && withStats.includes(`>7</div><div class="ep-stat-label">Med i AI-søk (siden 1. okt. 2026)</div>`),
    "unit: stats show the source's numbers and period labels");
  const tk = require("../owner-ui/tokens") as typeof import("../owner-ui/tokens");
  const tokenNames = new Set(tk.OWNER_TOKENS.map((t) => t.name));
  assertEq([...ovr.OWNER_OVERVIEW_CSS.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]).filter((n) => !tokenNames.has(n)), [], "unit: every colour in the block CSS is a T6 token");
  assertEq(ovr.OWNER_OVERVIEW_CSS.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "unit: no hard-coded colour in the block CSS");
  const sh = require("../owner-ui/shell") as typeof import("../owner-ui/shell");
  const noBadge = sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt", counts: { pendingOrders: 0, itemsToConfirm: 0 } });
  assertEq(noBadge, sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt" }), "unit: zero counts → the shell has no badge");
  const twoBadges = sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt", counts: { pendingOrders: 2, itemsToConfirm: 1 } });
  assertEq([navBadge(shellNav(twoBadges), "/eier/u1/ordrer"), navBadge(shellNav(twoBadges), "/eier/u1/portal#bestillbare-varer")],
    [{ n: 2, sr: ", 2 venter på svar" }, { n: 1, sr: ", 1 bør bekreftes" }], "unit: badges carry a number (aria-hidden) and screen-reader text");

  // ── Routes ───────────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const setEnv = (k: string, v: string | null) => { if (v === null) delete process.env[k]; else process.env[k] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(id: string, tokenOf: string | null, query: Record<string, string> = {}, body?: any): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (tokenOf) headers.authorization = `Bearer tok-${tokenOf}`;
    return {
      method: body ? "POST" : "GET", url: "/", path: "/", originalUrl: "/",
      params: { agentId: id }, body, query, headers, cookies: {},
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
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
        setHeader() { return res; },
      };
      res.req = undefined;
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
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ORDER_MESSAGES_ENABLED = "1";
    process.env.OWNER_UNIFIED_SESSION_ENABLED = "1";
    process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";

    const now = new Date();
    const ago = (d: number) => sqlTs(new Date(now.getTime() - d * DAY));
    for (const id of [BUSY, ZERO, OFFLIST, OTHER, LATER, NEVER]) seedProducer(db, id);
    seedProducer(db, ESC, ESC_NAME);
    // BUSY: 2 pending orders + 1 confirmed; items: 1 fresh, 2 expired (must be confirmed), 1 from the website.
    seedOrder(db, BUSY, 1, "pending");
    seedOrder(db, BUSY, 2, "pending");
    seedOrder(db, BUSY, 3, "confirmed");
    seedProduct(db, BUSY, "b-fresh", { name: "Gulrøtter", source: "producer_dashboard", updated: ago(1) });
    seedProduct(db, BUSY, "b-old1", { name: "Kålrot", source: "producer_dashboard", updated: ago(70) });
    seedProduct(db, BUSY, "b-old2", { name: "Løk", source: "producer_dashboard", updated: ago(80) });
    seedProduct(db, BUSY, "b-web", { name: "Rødbeter", source: "enrichment", updated: null });
    // ZERO: nothing waits (one fresh item, a confirmed order).
    seedOrder(db, ZERO, 1, "confirmed");
    seedProduct(db, ZERO, "z-fresh", { name: "Egg", source: "producer_dashboard", updated: ago(1) });
    // OFFLIST: would have badges, but is off the allowlist.
    seedOrder(db, OFFLIST, 1, "pending");
    seedProduct(db, OFFLIST, "o-old", { name: "Purre", source: "producer_dashboard", updated: ago(70) });
    const allowList = [BUSY, ZERO, OTHER, LATER, NEVER, ESC].map((id) => `rfb:${id}`).join(",");
    setEnv(ALLOW_ENV, allowList);

    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const ordersMod = require("./owner-orders") as typeof import("./owner-orders");
    const ovd = require("../owner-ui/overview-data") as typeof import("../owner-ui/overview-data");
    const view = require("../services/owner-items-view") as typeof import("../services/owner-items-view");
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      orders: findRouteHandler(ordersMod.default, "/eier/:agentId/ordrer", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      intro: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/intro", "post"),
    };
    type PageKey = "portal" | "orders" | "valg";
    const PAGES: PageKey[] = ["portal", "orders", "valg"];
    const noIdem = (h: string) => h.replace(/name="idem" value="[^"]*"/g, `name="idem" value="*"`);
    const get = async (p: PageKey, id: string, tokenOf: string | null = id, q: Record<string, string> = p === "orders" ? { tab: "venter" } : {}) => {
      const r = await invoke(H[p], makeReq(id, tokenOf, q));
      return { status: r.status, html: typeof r.body === "string" ? noIdem(r.body) : JSON.stringify(r.body) };
    };
    const post = (id: string, body: Record<string, string>) => invoke(H.intro, makeReq(id, id, {}, body));
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    const snapshot = async () => {
      const out: Record<string, { status: number; html: string }> = {};
      for (const p of PAGES) {
        for (const id of [BUSY, ZERO, OFFLIST, ESC]) out[`${p}:${id}`] = await get(p, id);
        out[`${p}:nosession`] = await get(p, BUSY, null);
        out[`${p}:other`] = await get(p, OTHER, BUSY);
      }
      return out;
    };

    // ── Off: byte-identical snapshot ────────────────────────────────────────
    setEnv(FLAG, null);
    const before = await snapshot();
    assertTrue(before[`valg:${BUSY}`].html.includes(`data-news-question="1"`), "off: the T7 question is on Mine valg (baseline)");
    assertTrue(Object.values(before).every((r) => !r.html.includes("ow-nav") && !r.html.includes(`id="oversikt"`) && !r.html.includes("ow-nav-badge")),
      "off: no shell, no «Oversikt», no badge with the flag unset");
    setEnv(FLAG, "0");
    const zero = await snapshot();
    for (const k of Object.keys(before)) assertEq(zero[k], before[k], `off: ${FLAG}=0 — ${k} byte-identical to the flag unset`);
    setEnv(FLAG, "1");
    const on = await snapshot();
    for (const p of PAGES) {
      for (const k of [`${p}:${OFFLIST}`, `${p}:nosession`, `${p}:other`]) assertEq(on[k], before[k], `off: flag on — ${k} byte-identical to the flag unset`);
    }
    // Allowlist unset + flag on: byte-identical to (flag unset, allowlist unset).
    setEnv(ALLOW_ENV, null);
    setEnv(FLAG, null);
    const noListOff = await snapshot();
    setEnv(FLAG, "1");
    const noListOn = await snapshot();
    for (const k of Object.keys(noListOff)) assertEq(noListOn[k], noListOff[k], `off: allowlist unset + flag on — ${k} byte-identical`);
    setEnv(ALLOW_ENV, allowList);

    // ── Gate (unchanged) ────────────────────────────────────────────────────
    assertEq([on["portal:nosession"].status, on["orders:nosession"].status], [302, 302], "gate: no session → 302 (portal, orders)");
    assertEq(on["portal:nosession"].html, JSON.stringify({ __redirect: `/eier/${BUSY}` }), "gate: no session → the login page");
    assertEq(on["valg:nosession"].status, 401, "gate: no session → Mine valg's 401 login page (unchanged)");
    assertEq(PAGES.map((p) => on[`${p}:other`].status), [403, 403, 403], "gate: another producer's session → 403");
    assertTrue(PAGES.every((p) => !on[`${p}:other`].html.includes(`id="oversikt"`) && !on[`${p}:other`].html.includes(`class="ow-nav-badge"`)), "gate: nothing of T15b on the 403 pages");

    // ── On: blocks 1–8 in order ─────────────────────────────────────────────
    const portal = on[`portal:${BUSY}`].html;
    assertEq(on[`portal:${BUSY}`].status, 200, "on: portal 200");
    assertEq(count(portal, /<h1[\s>]/), 1, "on: exactly one <h1>");
    const nav = shellNav(portal);
    assertEq(count(portal, `<nav class="ow-nav" aria-label="Eierportal">`), 1, "on: one nav");
    assertEq(count(portal, /<nav[\s>]/), 1, "on: no second <nav> landmark (the parts list is a section)");
    assertEq(count(nav, `aria-current="page"`), 1, "on: exactly one aria-current=\"page\"");
    const main = portal.slice(portal.indexOf(`<main id="innhold"`));
    const h1At = main.indexOf("<h1");
    const order = [
      main.indexOf(`data-ov="status"`), main.indexOf(`data-ov="profile"`), main.indexOf(`data-ov="level"`), main.indexOf(`data-ov="todo"`),
      main.indexOf(`data-ov="stats"`), main.indexOf(`data-ov="parts"`), main.indexOf(`data-ov="news"`), main.indexOf(`data-ov="help"`),
    ];
    assertTrue(h1At > 0 && order.every((i) => i > h1At), `on: blocks 1–8 inside <main>, under the <h1> (${order.join(",")})`);
    assertTrue(order.every((i, k) => k === 0 || i > order[k - 1]), "on: blocks 1–8 in order");
    assertTrue(main.indexOf(`data-ov="help"`) < main.indexOf(`id="profil"`), "on: the block stands before the profile card");
    const block = overviewBlock(portal);
    assertTrue(block.length > 0, "on: the «Oversikt» block is there");
    const onAttr = /<[a-zA-Z][^>]*\son[a-z]+\s*=/.exec(portal);
    assertTrue(!onAttr, `on: no on*= attribute on the page${onAttr ? ` (${onAttr[0].slice(0, 80)})` : ""}`);
    assertTrue(!/\sstyle="/.test(block) && !/<script/i.test(block), "on: no style attribute and no script in the block");
    assertTrue(block.includes(`data-visibility="visible">Synlig for kunder<`) && block.includes(`data-orders="on">Tar imot bestillinger<`), "on: status badges (visible, taking orders)");
    assertTrue(block.includes(`<a class="ow-ov-link" href="/produsent/oversiktgard-${BUSY}">Se profilen din</a>`), "on: «Se profilen din» → /produsent/<slug>");
    const pg = require("../owner-features/page") as typeof import("../owner-features/page");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
    const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
    const st = pg.ownerRfbLevelStatus(rs.resolveOwnerFeatures("rfb", BUSY, { db }), ch.readOwnerLevelChoiceFor("rfb", BUSY, { db }));
    const levelText = st ? pg.ownerLevelStatusText(st) : T.levelNone;
    assertTrue(block.includes(`<span>${levelText.replace(/"/g, "&quot;")}</span> <a class="ow-ov-link" href="/eier/${BUSY}/valg#niva">Endre</a>`), `on: the level line is Mine valg's (${levelText}) with «Endre» → #niva`);
    const valgOn = on[`valg:${BUSY}`].html;
    assertTrue(!!st && valgOn.includes(`data-level-status="${st.kind}">${levelText}`), "on: Mine valg shows the same level line");
    assertTrue(valgOn.includes(`id="niva"`), "on: «Endre» lands on Mine valg's level card");
    for (const [key, href] of [["ordrer", `/eier/${BUSY}/ordrer`], ["varer", `/eier/${BUSY}/varer`], ["valg", `/eier/${BUSY}/valg`], ["profil", "#profil"], ["statistikk", `/selger?agent=${BUSY}#statistikk`]]) {
      assertTrue(new RegExp(`<li data-part="${key}"><a class="ow-ov-row" href="${href.replace(/[?#.]/g, "\\$&")}">`).test(block), `on: «Alt i eierportalen» links ${key} → ${href}`);
    }
    assertTrue(portal.includes(`id="bestillbare-varer"`) && portal.includes(`id="profil"`), "on: the in-page targets exist");
    assertTrue(block.includes(`Trenger du hjelp? Skriv til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>.`), "on: help line with mailto");

    // ── Counts: badges = section 4 = the underlying counts ──────────────────
    const pendingSql = (id: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM orders WHERE agent_id = ? AND status = 'pending'").get(id) as any).n);
    const itemsModel = view.readOwnerItems(BUSY, db, new Date());
    const itemsNeeding = itemsModel.rows.filter((row) => view.ownerItemView(row, {
      now: new Date(), softExpiry: itemsModel.softExpiry, ordersOn: itemsModel.ordersOn, profileEligible: itemsModel.profileEligible, canEdit: true,
    }).group === "needs_action").length;
    assertEq([pendingSql(BUSY), itemsNeeding], [2, 2], "counts: fixture — 2 pending orders, 2 items in «Trenger handling»");
    assertEq(ovd.ownerActionCounts(db, BUSY), { pendingOrders: 2, itemsToConfirm: 2 }, "counts: ownerActionCounts = the underlying counts");
    // T15c: the «Varer» card is on /eier/:id/varer now.
    const varerPage = await invoke(findRouteHandler(portalMod.default, "/eier/:agentId/varer", "get"), makeReq(BUSY, BUSY));
    const itemsCard = String(varerPage.body).slice(String(varerPage.body).indexOf(`id="bestillbare-varer"`));
    assertEq(count(itemsCard.slice(0, itemsCard.indexOf(`data-items-group="orderable"`) > 0 ? itemsCard.indexOf(`data-items-group="orderable"`) : itemsCard.length), `data-group="needs_action"`), 2,
      "counts: the «Varer» card shows the same 2 rows under «Trenger handling»");
    const todo = (h: string, key: string) => {
      const m = new RegExp(`<li data-todo="${key}" data-count="(\\d+)"><a class="ow-ov-row" href="([^"]*)"><strong>([^<]*)</strong><span>([^<]*)</span>`).exec(h);
      return m ? { n: Number(m[1]), href: m[2], line: m[3], hint: m[4] } : null;
    };
    assertEq(todo(block, "orders"), { n: 2, href: `/eier/${BUSY}/ordrer`, line: "2 bestillinger venter på svar", hint: "Bekreft eller avslå i Mine ordrer." }, "counts: section 4 orders row");
    assertEq(todo(block, "items"), { n: 2, href: `/eier/${BUSY}/varer`, line: "2 varer bør bekreftes", hint: "Bekreft at de fortsatt er på lager." }, "counts: section 4 items row");
    assertTrue(!block.includes(T.todoNone), "counts: no «Alt er i orden» when something waits");
    for (const p of PAGES) {
      const n = shellNav(on[`${p}:${BUSY}`].html);
      assertEq([navBadge(n, `/eier/${BUSY}/ordrer`), navBadge(n, `/eier/${BUSY}/varer`)],
        [{ n: 2, sr: ", 2 venter på svar" }, { n: 2, sr: ", 2 bør bekreftes" }], `counts: ${p} menu badges = section 4 = the counts`);
      assertEq(count(n, `aria-current="page"`), 1, `counts: ${p} still has exactly one aria-current`);
    }
    // Zero case.
    const zeroPortal = on[`portal:${ZERO}`].html;
    const zeroBlock = overviewBlock(zeroPortal);
    assertTrue(zeroBlock.includes(`<p class="ow-ov-ok" data-todo="none">Alt er i orden. Du har ingenting som venter.</p>`) && !zeroBlock.includes("data-todo=\"orders\"") && !zeroBlock.includes("data-todo=\"items\""),
      "zero: «Alt er i orden. Du har ingenting som venter.» and no rows");
    assertTrue(PAGES.every((p) => !on[`${p}:${ZERO}`].html.includes(`class="ow-nav-badge"`)), "zero: no badge on any of the three pages");
    assertEq(ovd.ownerActionCounts(db, ZERO), { pendingOrders: 0, itemsToConfirm: 0 }, "zero: ownerActionCounts is 0/0");

    // ── Orders status follows orders.enabled and the orderable count ────────
    db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = ?").run(ZERO);
    assertTrue(overviewBlock((await get("portal", ZERO)).html).includes(`data-orders="off">Tar ikke imot bestillinger<`), "status: orders.enabled off → «Tar ikke imot bestillinger»");
    db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = ?").run(ZERO);
    db.prepare("UPDATE products SET availability_updated_at = ? WHERE id = 'z-fresh'").run(ago(70));
    assertTrue(overviewBlock((await get("portal", ZERO)).html).includes(`data-orders="on_no_items">Bestillinger er på, men ingen varer kan bestilles<`), "status: on, nothing orderable → «Bestillinger er på, men …»");
    db.prepare("UPDATE products SET availability_updated_at = ? WHERE id = 'z-fresh'").run(ago(1));
    // Visibility: pause (visibility.profile off) and hidden (catalog_hidden).
    rs.setOwnerFeatureValue("rfb", ZERO, "visibility.profile", false, { actor: "owner", detail: "test" }, { db });
    const pausedBlock = overviewBlock((await get("portal", ZERO)).html);
    assertTrue(pausedBlock.includes(`data-visibility="paused">På pause<`) && pausedBlock.includes(`href="/produsent/oversiktgard-${ZERO}"`), "status: visibility.profile off → «På pause», link kept");
    rs.setOwnerFeatureValue("rfb", ZERO, "visibility.profile", true, { actor: "owner", detail: "test" }, { db });
    db.prepare("UPDATE agents SET catalog_hidden = 1 WHERE id = ?").run(ZERO);
    const hiddenBlock = overviewBlock((await get("portal", ZERO)).html);
    assertTrue(hiddenBlock.includes(`data-visibility="hidden">Skjult for kunder<`) && !hiddenBlock.includes(`href="/produsent/`) && hiddenBlock.includes(`data-ov="profile">Skjult for kunder</p>`),
      "status: profile not served → «Skjult for kunder», no link");
    db.prepare("UPDATE agents SET catalog_hidden = 0 WHERE id = ?").run(ZERO);

    // ── Stats = ownerPortalYearStats ────────────────────────────────────────
    const year = portalMod.ownerPortalYearStats(db, BUSY, `Oversiktgard ${BUSY}`);
    const statOf = (h: string, key: string) => {
      const m = new RegExp(`<div class="ep-stat" data-stat="${key}"><div class="ep-stat-num">([^<]*)</div><div class="ep-stat-label">([^<]*)</div>`).exec(h);
      return m ? [m[1], m[2]] : null;
    };
    assertTrue(!!year, "stats: the year read works in the fixture");
    if (year) {
      assertEq([statOf(block, "humanViews"), statOf(block, "aiViews"), statOf(block, "aiDeliveries")], [
        [String(year.humanViews.value), `Sidevisninger fra mennesker (${year.labels.nb.humanViews})`],
        [String(year.aiViews.value), `AI-søk (${year.labels.nb.aiViews})`],
        [String(year.aiDeliveries.value), `Med i AI-søk (${year.labels.nb.aiDeliveries})`],
      ], "stats: the three numbers are getOwnerStats().year (ownerPortalYearStats)");
      assertTrue(portal.includes(`<div class="ep-stat-num">${year.humanViews.value}</div><div class="ep-stat-label">Sidevisninger fra mennesker (${year.labels.nb.humanViews})</div>`),
        "stats: the portal's own Statistikk card shows the same human page views");
    }

    // ── News: the question on Oversikt, not on Mine valg ────────────────────
    assertTrue(!valgOn.includes(`data-news-question`) && !valgOn.includes("/valg/intro\""), "news: with the dashboard on, the question is not on Mine valg");
    assertTrue(valgOn.includes(`id="valg-comms.news"`), "news: Mine valg keeps the comms.news row");
    assertTrue(before[`valg:${BUSY}`].html.includes(`value="mine_valg_question"`), "news: with the dashboard off, Mine valg keeps its question");
    const forms = [...block.matchAll(/<form method="post" action="([^"]*)"[^>]*><input type="hidden" name="answer" value="([a-z]+)"><input type="hidden" name="placement" value="([^"]*)"><button type="submit" class="([^"]*)">([^<]*)<\/button><\/form>/g)]
      .map((m) => [m[1], m[2], m[3], m[5]]);
    assertEq(forms, [
      [`/eier/${BUSY}/valg/intro`, "yes", "oversikt_question", nc.OWNER_NEWS_CONSENT_TEXT.yes],
      [`/eier/${BUSY}/valg/intro`, "later", "oversikt_question", nc.OWNER_NEWS_CONSENT_TEXT.later],
      [`/eier/${BUSY}/valg/intro`, "never", "oversikt_question", nc.OWNER_NEWS_CONSENT_TEXT.never],
    ], "news: three answers posting to the same route with placement oversikt_question (no JavaScript needed)");
    assertTrue(block.includes(nc.OWNER_NEWS_CONSENT_TEXT.question) && block.includes(nc.OWNER_NEWS_CONSENT_TEXT.body), "news: the versioned consent text");

    featuresMod.__resetOwnerFeaturesRateLimitForTesting();
    const auditOf = (id: string) => db.prepare("SELECT key, new_json, actor, text_version, placement FROM owner_feature_audit WHERE subject_id = ? ORDER BY id").all(id) as any[];
    const settingsOf = (id: string) => Number((db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?").get(id) as any).n);
    const promptOf = (id: string) => db.prepare("SELECT state FROM owner_feature_prompt WHERE subject_id = ? AND key = 'comms.news'").get(id) as any;
    // «Ja takk».
    const yes = await post(BUSY, { answer: "yes", placement: "oversikt_question" });
    assertEq([yes.status, loc(yes)], [303, `/eier/${BUSY}/portal?nyheter=ja#nyheter`], "news: «Ja takk» → 303 back to the portal's news block");
    assertEq(auditOf(BUSY), [{ key: "comms.news", new_json: "true", actor: "owner", text_version: nc.OWNER_NEWS_CONSENT_VERSION, placement: "oversikt_question" }],
      "news: «Ja takk» writes one audit row with placement oversikt_question and the text version");
    const afterYes = overviewBlock((await get("portal", BUSY, BUSY, { nyheter: "ja" })).html);
    assertTrue(afterYes.includes(T.newsAnswer.yes) && !afterYes.includes(`data-news-question="oversikt"`), "news: after «Ja takk» the block says so and the question is gone");
    assertTrue(!overviewBlock((await get("portal", BUSY)).html).includes(`data-ov="news"`), "news: answered → no news block on a plain visit");
    // «Ikke nå».
    const later = await post(LATER, { answer: "later", placement: "oversikt_question" });
    assertEq([later.status, loc(later)], [303, `/eier/${LATER}/portal?nyheter=ikke_na#nyheter`], "news: «Ikke nå» → 303 back to the portal");
    assertEq([settingsOf(LATER), auditOf(LATER).length, promptOf(LATER)?.state], [0, 0, "later"], "news: «Ikke nå» writes no settings row and no audit row");
    // «Nei, ikke spør meg igjen».
    const never = await post(NEVER, { answer: "never", placement: "oversikt_question" });
    assertEq([never.status, loc(never)], [303, `/eier/${NEVER}/portal?nyheter=nei#nyheter`], "news: «Nei» → 303 back to the portal");
    assertEq([promptOf(NEVER)?.state, settingsOf(NEVER)], ["never", 0], "news: «Nei» is stored in owner_feature_prompt");
    // A bad answer from Oversikt → back to the portal with the error text; nothing written.
    const bad = await post(ZERO, { answer: "kanskje", placement: "oversikt_question" });
    assertEq(loc(bad), `/eier/${ZERO}/portal?nyheter=feil#nyheter`, "news: an invalid answer from Oversikt → back to the portal (feil)");
    assertTrue(!promptOf(ZERO), "news: nothing written for an invalid answer");
    assertTrue(overviewBlock((await get("portal", ZERO, ZERO, { nyheter: "feil" })).html).includes(T.newsAnswer.error), "news: the error text stands in the news block");
    // Mine valg's own answers are unchanged (placement mine_valg_question → back to Mine valg).
    const mv = await post(ESC, { answer: "later", placement: "mine_valg_question" });
    assertTrue(/^\/eier\/t15b-esc\/valg\?melding=intro_ikke_na/.test(loc(mv)), `news: a Mine valg answer still goes back to Mine valg (${loc(mv)})`);

    // ── Escaping ────────────────────────────────────────────────────────────
    const escPortal = on[`portal:${ESC}`].html;
    assertTrue(escPortal.includes("Gård &lt;b&gt;&quot;Ku&quot;&lt;/b&gt; &amp; &#039;Sau&#039;") || escPortal.includes("Gård &lt;b&gt;&quot;Ku&quot;&lt;/b&gt; &amp; &#39;Sau&#39;"),
      "escape: the producer's name is escaped in the <h1>");
    const escBlock = overviewBlock(escPortal);
    assertTrue(escBlock.length > 0 && !escBlock.includes("<b>") && /href="\/produsent\/[a-z0-9-]+"/.test(escBlock),
      "escape: no raw markup from the name in the block; the slug link is clean");
    assertTrue(!escPortal.includes(ESC_NAME), "escape: the raw name never appears");
    const unsafe = ovr.renderOwnerOverview({ ...baseModel, agentId: `x"><i>`, profileSlug: `a"<b>` });
    assertTrue(!unsafe.includes(`"><i>`) && !unsafe.includes(`<b>`) && unsafe.includes(`/produsent/a%22%3Cb%3E`), "escape: agent id and slug are encoded/escaped in the pure render");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    cartSvc.__setCartTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerOverviewT15bTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
