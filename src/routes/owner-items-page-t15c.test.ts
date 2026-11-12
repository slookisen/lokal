/**
 * owner-items-page-t15c.test.ts — dev-request 2026-10-30-rfb-eierportal-testrunde-1,
 * punkt 9, slice T15c «Varer-siden»: GET /eier/:id/varer in the owner shell
 * (the T13 «Varer» card, same data, same POST routes) behind
 * OWNER_DASHBOARD_ENABLED + the allowlist + a verified owner (+ the card's
 * own gate, OWNER_ORDERABILITY_PORTAL_ENABLED).
 *
 *   unit      the new texts are in OWNER_SHELL_TEXTS; the shell's Varer link
 *             and aria-current; the card's hidden tilbake=varer field only on
 *             the Varer page (else the card is unchanged).
 *   off       flag unset / "0" / off the allowlist / unverified / no session /
 *             another producer: /portal, /ordrer, /valg byte-identical to the
 *             flag unset (snapshot), and GET /varer goes on (next()) exactly as
 *             when the route did not exist; also with the card's flag off.
 *   on        /varer 200 in the shell: one nav, one aria-current="page" on
 *             Varer, one <h1> «Varer», skip link first, the T13 card with the
 *             same rows as the portal card had; no on*= attribute.
 *   counts    the Varer badge = Oversikt's «varer bør bekreftes» = the rows.
 *   links     the shell's Varer (all four pages), Oversikt's «… varer bør
 *             bekreftes» and «Alt i eierportalen» → /eier/:id/varer.
 *   portal    #bestillbare-varer stays with one line and a link to /varer;
 *             the card (and its forms) is gone from /portal.
 *   post      a POST from the Varer page (tilbake=varer) lands on /varer with
 *             the same status/anchor; without it, as before (/portal); any
 *             other value → /portal (no open redirect); a refused «Legg til
 *             vare» from Varer renders the Varer page with the form open.
 *   gate      GET /varer: no session → 302, another producer → 403; the
 *             POSTs' CSRF/claimant/session checks unchanged with tilbake=varer.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stack (same harness as owner-overview-t15b). Exported
 * runOwnerItemsPageT15cTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-items-page-t15c.test.ts
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
const CARD_FLAG = "OWNER_ORDERABILITY_PORTAL_ENABLED";
const ENV_KEYS = [
  FLAG, ALLOW_ENV, CARD_FLAG, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "ORDER_MESSAGES_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY", "OWNER_PAUSE_ENABLED", "OWNER_FEATURES_ENFORCE",
  "STOCK_SOFT_EXPIRY_ENABLED",
];
const BUSY = "t15c-busy";
const OFFLIST = "t15c-offlist";
const OTHER = "t15c-other";
const UNVERIFIED = "t15c-unverified";
const DAY = 86_400_000;
const ORIGIN = { origin: "https://rettfrabonden.com" };

function sqlTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function seedProducer(db: Database.Database, id: string, verified = true): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for Varer-siden.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?, 1)`,
  ).run(id, `Varegard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, verified ? "2026-10-01T00:00:00.000Z" : null);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  if (verified) {
    db.prepare(
      `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
       VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
    ).run(`claim-${id}`, id, `post@${id}.example.no`);
  }
  addToken(db, `tok-${id}`, id, `post@${id}.example.no`);
}

function addToken(db: Database.Database, token: string, agentId: string, email: string): void {
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_${token}`, email, token, agentId, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
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

function seedProduct(db: Database.Database, agentId: string, pid: string, p: { name: string; source: string; updated: string | null }): void {
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
     VALUES (?, ?, ?, ?, 30, 'stk', 'in_stock', ?, ?)`,
  ).run(pid, agentId, p.name, p.name.toLowerCase(), p.source, p.updated);
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

/** The balanced <div …>…</div> that starts at `marker` ("" when absent). */
function divAt(h: string, marker: string): string {
  const at = h.indexOf(marker);
  if (at < 0) return "";
  const re = /<\/?div[\s>]/g;
  re.lastIndex = at + 4;
  let depth = 1;
  let m: RegExpExecArray | null;
  while (depth > 0 && (m = re.exec(h))) depth += m[0].startsWith("</") ? -1 : 1;
  return h.slice(at, h.indexOf(">", re.lastIndex - 1) + 1);
}

const CARD = `<div class="ep-card" id="bestillbare-varer" data-items-card="t13">`;
const MOVED = `<div class="ep-card" id="bestillbare-varer" data-items-moved="t15c">`;
const BACK_INPUT = `<input type="hidden" name="tilbake" value="varer">`;

/** The badge number after a nav item (null when none). */
function navBadge(nav: string, href: string): number | null {
  const at = nav.indexOf(`href="${href}"`);
  if (at < 0) return null;
  const a = nav.slice(at, nav.indexOf("</a>", at));
  const m = /<span class="ow-nav-badge" aria-hidden="true">(\d+)<\/span>/.exec(a);
  return m ? Number(m[1]) : null;
}

function firstFocusable(h: string): string {
  const body = h.slice(h.indexOf("<body"));
  const m = /<(a\s[^>]*href=|button[\s>]|input\s(?![^>]*type="hidden")|select[\s>]|textarea[\s>]|summary[\s>])[^>]*>/i.exec(body);
  return m ? m[0] : "";
}

export async function runOwnerItemsPageT15cTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ── Unit ─────────────────────────────────────────────────────────────────
  const sh = require("../owner-ui/shell") as typeof import("../owner-ui/shell");
  const card = require("./owner-items-card") as typeof import("./owner-items-card");
  const T = sh.OWNER_SHELL_TEXTS;
  assertEq([T.items, T.itemsMoved, T.itemsMovedLink], ["Varer", "Varene dine finner du under «Varer».", "Gå til Varer"], "unit: the page title and the moved line are in OWNER_SHELL_TEXTS");
  assertEq(sh.ownerShellLinks("u 1", "").varer, "/eier/u%201/portal#bestillbare-varer", "unit: without the Varer page the link is as in T15a");
  assertEq(sh.ownerShellLinks("u 1", "", true).varer, "/eier/u%201/varer", "unit: with the Varer page the link is /eier/:id/varer");
  assertEq(sh.ownerItemsPagePath(`x"><i>`), "/eier/x%22%3E%3Ci%3E/varer", "unit: the Varer path encodes the agent id");
  const startVarer = sh.renderOwnerShellStart({ agentId: "u1", current: "varer", itemsPage: true });
  assertTrue(/<a class="ow-nav-item" href="\/eier\/u1\/varer" aria-current="page">Varer<\/a>/.test(startVarer) && count(shellNav(startVarer), `aria-current="page"`) === 1,
    "unit: current \"varer\" → exactly one aria-current, on Varer");
  const startOv = sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt", itemsPage: true });
  assertTrue(startOv.includes(`<a class="ow-nav-item" href="/eier/u1/varer">Varer</a>`) && count(shellNav(startOv), `aria-current="page"`) === 1, "unit: on another page Varer links to /varer without aria-current");
  assertEq(sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt", itemsPage: false }), sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt" }),
    "unit: itemsPage false = the T15b shell");
  assertEq([card.ownerItemsReturnInput("varer"), card.ownerItemsReturnInput(null), card.ownerItemsReturnInput(undefined), card.ownerItemsReturnInput("x" as any)],
    [BACK_INPUT, "", "", ""], "unit: the hidden tilbake=varer field only for the Varer page");

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
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string | null; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", ...(o.headers || {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: o.body ? "POST" : "GET", url: "/", path: "/", originalUrl: "/",
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
    process.env[CARD_FLAG] = "1";

    const now = new Date();
    const ago = (d: number) => sqlTs(new Date(now.getTime() - d * DAY));
    for (const id of [BUSY, OFFLIST, OTHER]) seedProducer(db, id);
    seedProducer(db, UNVERIFIED, false);
    addToken(db, "tok-busy-helper", BUSY, "medhjelper@t15c.example.no");
    // BUSY: 1 pending order; items: 1 fresh, 3 expired (must be confirmed), 1 from the website.
    seedOrder(db, BUSY, 1, "pending");
    seedOrder(db, BUSY, 2, "confirmed");
    seedProduct(db, BUSY, "c-fresh", { name: "Gulrøtter", source: "producer_dashboard", updated: ago(1) });
    seedProduct(db, BUSY, "c-old1", { name: "Kålrot", source: "producer_dashboard", updated: ago(70) });
    seedProduct(db, BUSY, "c-old2", { name: "Løk", source: "producer_dashboard", updated: ago(80) });
    seedProduct(db, BUSY, "c-old3", { name: "Purre", source: "producer_dashboard", updated: ago(90) });
    seedProduct(db, BUSY, "c-web", { name: "Rødbeter", source: "enrichment", updated: null });
    seedProduct(db, OFFLIST, "o-old", { name: "Purre", source: "producer_dashboard", updated: ago(70) });
    seedProduct(db, UNVERIFIED, "u-old", { name: "Kål", source: "producer_dashboard", updated: ago(70) });
    const allowList = [BUSY, OTHER, UNVERIFIED].map((id) => `rfb:${id}`).join(",");
    setEnv(ALLOW_ENV, allowList);

    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const ordersMod = require("./owner-orders") as typeof import("./owner-orders");
    const ovd = require("../owner-ui/overview-data") as typeof import("../owner-ui/overview-data");
    const R = portalMod.default;
    const H = {
      portal: findRouteHandler(R, "/eier/:agentId/portal", "get"),
      varer: findRouteHandler(R, "/eier/:agentId/varer", "get"),
      orders: findRouteHandler(ordersMod.default, "/eier/:agentId/ordrer", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      one: findRouteHandler(R, "/eier/:agentId/varer/:productId/bekreft", "post"),
      soldOut: findRouteHandler(R, "/eier/:agentId/varer/:productId/utsolgt", "post"),
      all: findRouteHandler(R, "/eier/:agentId/varer/bekreft-alle", "post"),
      add: findRouteHandler(R, "/eier/:agentId/varer/ny", "post"),
      stock: findRouteHandler(R, "/eier/:agentId/varer/bekreft-lagerpaminnelse", "post"),
    };
    type PageKey = "portal" | "orders" | "valg" | "varer";
    const PAGES: PageKey[] = ["portal", "orders", "valg"];
    const noIdem = (h: string) => h.replace(/name="idem" value="[^"]*"/g, `name="idem" value="*"`);
    const get = async (p: PageKey, id: string, token: string | null = `tok-${id}`, query: Record<string, string> = p === "orders" ? { tab: "venter" } : {}) => {
      const r = await invoke(H[p], makeReq({ params: { agentId: id }, token, query }));
      return { status: r.status, html: typeof r.body === "string" ? noIdem(r.body) : JSON.stringify(r.body) };
    };
    const NEXT = JSON.stringify({ __next: true });
    const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
    const snapshot = async () => {
      const out: Record<string, { status: number; html: string }> = {};
      for (const p of [...PAGES, "varer" as const]) {
        for (const id of [BUSY, OFFLIST, UNVERIFIED]) out[`${p}:${id}`] = await get(p, id);
        out[`${p}:nosession`] = await get(p, BUSY, null);
        out[`${p}:other`] = await get(p, OTHER, `tok-${BUSY}`);
      }
      return out;
    };

    // ── Off: byte-identical snapshot; /varer is not there ───────────────────
    setEnv(FLAG, null);
    const before = await snapshot();
    assertTrue(before[`portal:${BUSY}`].html.includes(CARD) && !before[`portal:${BUSY}`].html.includes(MOVED), "off: the portal has the full «Varer» card (baseline)");
    assertTrue(Object.entries(before).filter(([k]) => !k.startsWith("varer:")).every(([, r]) => !r.html.includes("/varer\"") && !r.html.includes(BACK_INPUT)),
      "off: no link to /varer and no tilbake field on any page");
    assertTrue(Object.entries(before).filter(([k]) => k.startsWith("varer:")).every(([, r]) => r.html === NEXT),
      "off: GET /varer goes on to the next handler (as when the route did not exist), for every case");
    setEnv(FLAG, "0");
    const zero = await snapshot();
    for (const k of Object.keys(before)) assertEq(zero[k], before[k], `off: ${FLAG}=0 — ${k} byte-identical to the flag unset`);
    setEnv(FLAG, "1");
    const on = await snapshot();
    for (const p of [...PAGES, "varer" as const]) {
      for (const k of [`${p}:${OFFLIST}`, `${p}:${UNVERIFIED}`]) assertEq(on[k], before[k], `off: flag on — ${k} (off the list / not verified) byte-identical to the flag unset`);
    }
    for (const p of PAGES) {
      for (const k of [`${p}:nosession`, `${p}:other`]) assertEq(on[k], before[k], `off: flag on — ${k} unchanged`);
    }
    setEnv(ALLOW_ENV, null);
    setEnv(FLAG, null);
    const noListOff = await snapshot();
    setEnv(FLAG, "1");
    const noListOn = await snapshot();
    for (const k of Object.keys(noListOff)) assertEq(noListOn[k], noListOff[k], `off: allowlist unset + flag on — ${k} byte-identical`);
    assertTrue(Object.entries(noListOn).filter(([k]) => k.startsWith("varer:")).every(([, r]) => r.html === NEXT), "off: allowlist unset → GET /varer goes on");
    setEnv(ALLOW_ENV, allowList);
    // Dashboard on, but the «Varer» card's own flag off: no Varer page, links as in T15b.
    setEnv(CARD_FLAG, null);
    const noCard = await get("varer", BUSY);
    assertEq(noCard.html, NEXT, "off: card flag off → GET /varer goes on (no page without the card)");
    const noCardPortal = (await get("portal", BUSY)).html;
    assertTrue(noCardPortal.includes("ow-nav") && noCardPortal.includes(`href="/eier/${BUSY}/portal#bestillbare-varer"`) && !noCardPortal.includes(`/eier/${BUSY}/varer"`) && !noCardPortal.includes(MOVED),
      "off: card flag off → the shell's Varer link is as in T15b, no moved line");
    setEnv(CARD_FLAG, "1");

    // ── Gate (GET /varer) ───────────────────────────────────────────────────
    assertEq([on["varer:nosession"].status, on["varer:nosession"].html], [302, JSON.stringify({ __redirect: `/eier/${BUSY}` })], "gate: no session → 302 to the login page, as /portal");
    assertEq([on["portal:nosession"].status, loc({ status: 0, body: JSON.parse(on["portal:nosession"].html) })], [302, `/eier/${BUSY}`], "gate: /portal's 302 is the same");
    assertEq(on["varer:other"].status, 403, "gate: another producer's session → 403");
    assertTrue(on["varer:other"].html.includes("Ingen tilgang") && !on["varer:other"].html.includes("ow-nav") && !on["varer:other"].html.includes(CARD), "gate: the 403 page has no shell and no card");

    // ── On: the Varer page ──────────────────────────────────────────────────
    const varer = on[`varer:${BUSY}`];
    const vh = varer.html;
    assertEq(varer.status, 200, "on: /varer 200");
    const nav = shellNav(vh);
    assertEq(count(vh, `<nav class="ow-nav" aria-label="Eierportal">`), 1, "on: one nav");
    assertEq(count(vh, /<nav[\s>]/), 1, "on: no second <nav>");
    assertEq(count(nav, `aria-current="page"`), 1, "on: exactly one aria-current=\"page\"");
    assertTrue(new RegExp(`<a class="ow-nav-item" href="/eier/${BUSY}/varer" aria-current="page">Varer<span class="ow-nav-badge"`).test(nav), "on: aria-current is on Varer (with its badge)");
    assertEq(count(vh, /<h1[\s>]/), 1, "on: exactly one <h1>");
    assertTrue(/<h1>Varer<\/h1>/.test(vh), "on: the <h1> is «Varer»");
    assertEq(firstFocusable(vh), `<a class="ow-skip" href="#innhold">`, "on: «Hopp til innholdet» is the first focusable element");
    assertTrue(/<main id="innhold" tabindex="-1">/.test(vh) && vh.indexOf(`<main id="innhold"`) > vh.indexOf("</nav>") && vh.indexOf("<h1>") > vh.indexOf(`<main id="innhold"`),
      "on: the page sits in <main id=\"innhold\"> after the nav, the <h1> inside");
    assertTrue(vh.includes("<title>Varer · Varegard t15c-busy — Rett fra Bonden</title>"), "on: page title");
    const onAttr = /<[a-zA-Z][^>]*\son[a-z]+\s*=/.exec(vh);
    assertTrue(!onAttr, `on: no on*= attribute${onAttr ? ` (${onAttr[0].slice(0, 80)})` : ""}`);
    assertTrue(vh.includes("--ow-page-bg") && vh.includes("@media (prefers-color-scheme: dark)"), "on: the T6 tokens (light + dark)");
    const vCard = divAt(vh, CARD);
    assertTrue(vCard.length > 0, "on: the T13 card is on the Varer page");
    const forms = [...vCard.matchAll(/<form method="post" action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)];
    assertTrue(forms.length >= 5 && forms.every((m) => m[2].includes(BACK_INPUT)), `on: every form in the card carries tilbake=varer (${forms.length} forms)`);
    assertTrue(forms.every((m) => m[1].startsWith(`/eier/${BUSY}/varer/`)), "on: the forms post to the same T13 routes");
    assertTrue(vCard.includes(`data-items-add="1"`) && vCard.includes(`data-confirm-all="3"`) && vCard.includes(`action="/eier/${BUSY}/varer/c-old1/utsolgt"`),
      "on: the card's parts — legg til vare, «Bekreft alle (3)», «Merk som utsolgt»");

    // Same rows as the portal card had (flag off), apart from the hidden field.
    const oldCard = divAt(before[`portal:${BUSY}`].html, CARD);
    assertTrue(oldCard.length > 0, "rows: the old portal card is there with the flag off");
    // Tekstpakke B: on the Varer page the card has no second «Varer» heading (the page's <h1> is «Varer»).
    assertEq(vCard.split(BACK_INPUT).join(""), oldCard.replace(`${CARD}\n        <h2>Varer</h2>`, CARD),
      "rows: the Varer page's card = the portal card before (byte-identical without tilbake=varer and the card's own «Varer» heading)");
    const rowIds = (h: string) => [...h.matchAll(/<li class="ep-audit-item" id="vare-([^"]+)"/g)].map((m) => m[1]);
    assertEq(rowIds(vCard), rowIds(oldCard), "rows: same rows in the same order");
    assertEq(rowIds(vCard).length, 5, "rows: all five fixture rows");

    // ── Counts: Varer badge = Oversikt's «varer bør bekreftes» = the rows ──
    const counts = ovd.ownerActionCounts(db, BUSY);
    assertEq(counts, { pendingOrders: 1, itemsToConfirm: 3 }, "counts: fixture — 1 pending order, 3 items to confirm");
    const portalOn = on[`portal:${BUSY}`].html;
    const todoItems = /<li data-todo="items" data-count="(\d+)"><a class="ow-ov-row" href="([^"]*)"><strong>([^<]*)<\/strong>/.exec(portalOn);
    assertEq(todoItems ? [Number(todoItems[1]), todoItems[2], todoItems[3]] : null, [3, `/eier/${BUSY}/varer`, "3 varer bør bekreftes"],
      "counts+links: Oversikt's «3 varer bør bekreftes» → /eier/:id/varer");
    assertEq(navBadge(nav, `/eier/${BUSY}/varer`), 3, "counts: the Varer badge on the Varer page = 3");
    assertEq(count(vCard, `data-group="needs_action"`), 3, "counts: the card shows 3 rows under «Trenger handling»");
    for (const p of PAGES) {
      const n = shellNav(on[`${p}:${BUSY}`].html);
      assertEq(navBadge(n, `/eier/${BUSY}/varer`), 3, `counts+links: ${p} menu Varer → /varer with the same badge`);
      assertTrue(!n.includes(`/portal#bestillbare-varer`) && !/href="\/eier\/t15c-busy\/varer" aria-current/.test(n), `links: ${p} has no old Varer link and Varer is not current there`);
      assertEq(count(n, `aria-current="page"`), 1, `links: ${p} still has exactly one aria-current`);
    }
    assertTrue(new RegExp(`<li data-part="varer"><a class="ow-ov-row" href="/eier/${BUSY}/varer">`).test(portalOn), "links: «Alt i eierportalen» Varer → /eier/:id/varer");

    // ── Portal: the anchor stays, the card is gone ──────────────────────────
    const moved = divAt(portalOn, MOVED);
    assertEq(moved, `${MOVED}
        <h2>Varer</h2>
        <p>Varene dine finner du under «Varer». <a href="/eier/${BUSY}/varer">Gå til Varer</a></p>
      </div>`, "portal: #bestillbare-varer keeps one line and a link to the Varer page");
    assertEq(count(portalOn, `id="bestillbare-varer"`), 1, "portal: one #bestillbare-varer anchor");
    assertTrue(!portalOn.includes(CARD) && !portalOn.includes(`/varer/c-old1/bekreft`) && !portalOn.includes(`/varer/bekreft-alle`) && !portalOn.includes(`/varer/ny"`),
      "portal: no T13 card and none of its forms");
    assertTrue(["mine-ordrer", "profil", "oversikt"].every((a) => portalOn.includes(`id="${a}"`)), "portal: the other cards are still there");
    const portalOnAttr = /<[a-zA-Z][^>]*\son[a-z]+\s*=/.exec(portalOn);
    assertTrue(!portalOnAttr, "portal: no on*= attribute");

    // ── POST from the Varer page → back to /varer ───────────────────────────
    const post = (h: Function, params: Record<string, string>, body: Record<string, unknown>, token: string | null = `tok-${BUSY}`, headers: Record<string, string> = ORIGIN) =>
      invoke(h, makeReq({ params: { agentId: BUSY, ...params }, body, token, headers }));
    const availOf = (pid: string) => db.prepare("SELECT availability, availability_updated_at AS u FROM products WHERE id = ?").get(pid) as any;

    const c1 = await post(H.one, { productId: "c-old1" }, { tilbake: "varer" });
    assertEq([c1.status, loc(c1)], [303, `/eier/${BUSY}/varer?status=vare_bekreftet&ved=vare-c-old1#vare-c-old1`], "post: «Bekreft» from Varer → /varer with the same status and row anchor");
    const afterC1 = (await get("varer", BUSY, `tok-${BUSY}`, { status: "vare_bekreftet", ved: "vare-c-old1" })).html;
    const rowC1 = afterC1.slice(afterC1.indexOf(`id="vare-c-old1"`), afterC1.indexOf("</li>", afterC1.indexOf(`id="vare-c-old1"`)));
    assertTrue(rowC1.includes(`data-items-message="1">Varen er bekreftet på lager.`), "post: the message stands in the row on the Varer page");
    assertEq(navBadge(shellNav(afterC1), `/eier/${BUSY}/varer`), 2, "post: the badge follows (3 → 2)");
    const c2 = await post(H.one, { productId: "c-old2" }, {});
    assertEq(loc(c2), `/eier/${BUSY}/portal?status=vare_bekreftet&ved=vare-c-old2#vare-c-old2`, "post: without tilbake → /portal, as before");
    const c3 = await post(H.soldOut, { productId: "c-fresh" }, { tilbake: "varer" });
    assertEq(loc(c3), `/eier/${BUSY}/varer?status=vare_utsolgt&ved=vare-c-fresh#vare-c-fresh`, "post: «Merk som utsolgt» from Varer → /varer");
    assertEq(availOf("c-fresh").availability, "out_of_stock", "post: «Merk som utsolgt» wrote through the same path");
    for (const evil of ["https://evil.example", "//evil.example", "/eier/x/varer", "Varer", ["varer", "x"]]) {
      const r = await post(H.one, { productId: "c-fresh" }, { tilbake: evil });
      assertTrue(/^\/eier\/t15c-busy\/portal\?status=/.test(loc(r)), `post: tilbake=${JSON.stringify(evil)} → /portal (only fixed paths, no open redirect) (${loc(r)})`);
    }
    const all = await post(H.all, {}, { tilbake: "varer", id: ["c-old3"] });
    assertEq(loc(all), `/eier/${BUSY}/varer?status=varer_bekreftet#bestillbare-varer`, "post: «Bekreft alle» from Varer → /varer#bestillbare-varer");
    const stock = await post(H.stock, {}, { tilbake: "varer", id: ["c-old3"] });
    assertTrue(/^\/eier\/t15c-busy\/varer\?status=(lager_bekreftet|ingen_varer_bekreftet)#bestillbare-varer$/.test(loc(stock)), `post: the stock-check banner's POST from Varer → /varer (${loc(stock)})`);
    const addOk = await post(H.add, {}, { tilbake: "varer", skjema: "v1b", name: "Hvitløk", price: "25", unit: "stk", category: "", paa_lager: "1", ferdigpakket: "nei" });
    assertTrue(new RegExp(`^/eier/${BUSY}/varer\\?status=vare_lagt_til&ved=vare-[^#]+#vare-`).test(loc(addOk)), `post: «Legg til vare» from Varer → /varer, the new row (${loc(addOk)})`);
    const addBad = await post(H.add, {}, { tilbake: "varer", skjema: "v1b", name: "", price: "", unit: "", ferdigpakket: "nei" });
    const addBadHtml = String(addBad.body);
    assertTrue(addBad.status === 422 && /<h1>Varer<\/h1>/.test(addBadHtml) && addBadHtml.includes(`data-items-add-error="1"`) && /<details class="ep-items-add" data-items-add="1"[^>]* open>/.test(addBadHtml)
      && shellNav(addBadHtml).includes(`href="/eier/${BUSY}/varer" aria-current="page"`),
      "post: a refused «Legg til vare» from Varer renders the Varer page (422) with the form open");
    const addBadPortal = await post(H.add, {}, { skjema: "v1b", name: "", price: "", unit: "", ferdigpakket: "nei" });
    assertTrue(addBadPortal.status === 422 && String(addBadPortal.body).includes(`data-ov="overview"`), "post: without tilbake the refusal renders /portal, as before");
    // Gate off: tilbake=varer is ignored (no Varer page) → /portal.
    setEnv(FLAG, null);
    const offPost = await post(H.one, { productId: "c-fresh" }, { tilbake: "varer" });
    assertEq(loc(offPost), `/eier/${BUSY}/portal?status=vare_bekreftet&ved=vare-c-fresh#vare-c-fresh`, "post: flag off → tilbake=varer is ignored (/portal)");
    setEnv(FLAG, "1");

    // ── CSRF / write limits unchanged ───────────────────────────────────────
    const beforeOld = availOf("c-fresh");
    const xs = await post(H.soldOut, { productId: "c-fresh" }, { tilbake: "varer" }, `tok-${BUSY}`, { origin: "https://evil.example" });
    assertEq(xs.status, 403, "csrf: a cross-site POST with tilbake=varer → 403");
    const helper = await post(H.soldOut, { productId: "c-fresh" }, { tilbake: "varer" }, "tok-busy-helper");
    assertTrue(helper.status === 403 && String(helper.body).includes(`data-claimant-login-required="1"`), "csrf: not the claimant's login → 403 (unchanged)");
    const noSess = await post(H.soldOut, { productId: "c-fresh" }, { tilbake: "varer" }, null);
    assertEq([noSess.status, loc(noSess)], [303, `/eier/${BUSY}`], "csrf: no session → 303 to the login page (unchanged)");
    const otherSess = await post(H.soldOut, { productId: "c-fresh" }, { tilbake: "varer" }, `tok-${OTHER}`);
    assertEq([otherSess.status, loc(otherSess)], [303, `/eier/${BUSY}`], "csrf: another producer's session → 303 (unchanged), nothing written");
    assertEq(availOf("c-fresh"), beforeOld, "csrf: none of the refused POSTs wrote anything");
    const notFound = await post(H.one, { productId: "c-nope" }, { tilbake: "varer" });
    assertTrue(notFound.status === 404 && String(notFound.body).includes(`href="/eier/${BUSY}/varer#bestillbare-varer"`), "post: «Fant ikke varen» from Varer links back to /varer");
    // A verified owner on another address sees the Varer page read-only (as the portal card).
    const ro = await get("varer", BUSY, "tok-busy-helper");
    assertTrue(ro.status === 200 && ro.html.includes(`data-items-read-only="1"`) && !divAt(ro.html, CARD).includes("<form"), "gate: not the claimant's login → the Varer page without buttons");
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
  runOwnerItemsPageT15cTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
