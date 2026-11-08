/**
 * owner-shell-t15a.test.ts — dev-request 2026-10-30-rfb-eierportal-testrunde-1,
 * punkt 9, slice T15a «skall og meny»: the shared owner shell around Oversikt
 * (/eier/:id/portal), Mine ordrer (/eier/:id/ordrer) and Mine valg
 * (/eier/:id/valg), behind OWNER_DASHBOARD_ENABLED + the allowlist + a
 * verified owner.
 *
 *   unit        flag parsing, the gate, the texts in one constant, the menu
 *               markup (no on*= handlers, no style attributes, no script).
 *   off         flag unset / "0", a profile off the allowlist and an owner
 *               without verified ownership: all three pages byte-identical to
 *               the flag unset.
 *   on          the three pages: 200, one <nav aria-label="Eierportal"> with
 *               exactly one aria-current="page" on the right item, the skip
 *               link first and before the nav, <main id="innhold">, one <h1>,
 *               no on*= attribute; with the shell markup taken out the page is
 *               the flag-off page (nothing else changed).
 *   gate        no session → 302 (portal, orders) / the 401 login page
 *               (Mine valg) and another producer → 403, unchanged by the flag.
 *   anchors     #bestillinger, #bestillbare-varer, #produkter,
 *               #forhandsbetaling, #mine-valg, #mine-ordrer and the Stripe
 *               return (?status=payments_return) still on the same page.
 *   status      Mine valg keeps the T9 script and #mv-status; the shell lifts
 *               it above the bottom menu below 900 px.
 *   buyer       the buyer's order card (ordersShell) is unchanged.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stack (same harness as owner-ui-tokens-t6). Exported
 * runOwnerShellT15aTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-shell-t15a.test.ts
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
const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const ENV_KEYS = [
  FLAG, ALLOW_ENV, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "ORDER_MESSAGES_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED",
  "OWNER_ORDERABILITY_PORTAL_ENABLED", "PAYMENTS_ENABLED", "PAYMENTS_ALLOWED_AGENT_IDS", "STRIPE_SECRET_KEY",
];
const ON_ID = "t15a-on";
const OFF_ID = "t15a-off";
const OTHER_ID = "t15a-other";
const UNVERIFIED_ID = "t15a-unverified";
const OLD_ANCHORS = ["bestillinger", "bestillbare-varer", "produkter", "forhandsbetaling", "mine-valg", "mine-ordrer"];

function seedProducer(db: Database.Database, id: string, verified = true): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for skallet.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?, 1)`,
  ).run(id, `Skallgard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, verified ? "2026-10-01T00:00:00.000Z" : null);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  const created = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const orderId = `${id}-order-1`;
  db.prepare(`
    INSERT INTO orders (id, agent_id, buyer_ref, status, fulfilment, confirm_token, pickup_time, total_nok, payment_mode,
                        notify_sent_at, buyer_name, buyer_email, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 'pickup', ?, NULL, 90, NULL, ?, 'Kari Nordmann', 'kari@example.com', ?, ?)
  `).run(orderId, id, `bref_${orderId}`, `ctok_${orderId}`, created, created, created);
  db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_snapshot, line_total) VALUES (?, ?, NULL, 'Poteter', 2, 45, 90)")
    .run(`${orderId}-i1`, orderId);
  for (const [n, role] of [[1, "buyer"], [2, "seller"]] as const) {
    db.prepare("INSERT INTO order_messages (id, order_id, author_role, body, channel, created_at) VALUES (?, ?, ?, ?, 'web', ?)")
      .run(`${orderId}-m${n}`, orderId, role, role === "buyer" ? "Kan jeg hente i morgen?" : "Ja, det går fint.", created);
  }
}

function count(h: string, needle: string | RegExp): number {
  if (typeof needle === "string") return h.split(needle).length - 1;
  return (h.match(new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : needle.flags + "g")) || []).length;
}

/** The <nav aria-label="Eierportal"> element's markup ("" when absent). */
function shellNav(h: string): string {
  const at = h.indexOf(`<nav class="ow-nav" aria-label="Eierportal">`);
  if (at < 0) return "";
  return h.slice(at, h.indexOf("</nav>", at) + "</nav>".length);
}

/** The first focusable element's opening tag (a[href], button, input, select, textarea, summary, [tabindex≥0]) in <body>. */
function firstFocusable(h: string): string {
  const body = h.slice(h.indexOf("<body"));
  const m = /<(a\s[^>]*href=|button[\s>]|input\s(?![^>]*type="hidden")|select[\s>]|textarea[\s>]|summary[\s>])[^>]*>/i.exec(body);
  return m ? m[0] : "";
}

export async function runOwnerShellT15aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const sh = require("../owner-ui/shell") as typeof import("../owner-ui/shell");

  // ── Unit: flag, gate, texts, markup ──────────────────────────────────────
  assertEq([undefined, "", "0", "false", "yes", "1", "true"].map((v) => sh.isOwnerDashboardEnabled(v === undefined ? {} : { [FLAG]: v })),
    [false, false, false, false, false, true, true], "unit: OWNER_DASHBOARD_ENABLED is off unless \"1\"/\"true\"");
  const allowEnv = { [FLAG]: "1", [ALLOW_ENV]: `rfb:${ON_ID}` };
  assertTrue(sh.ownerDashboardActiveFor("rfb", ON_ID, true, allowEnv), "unit: gate on = flag + allowlist + verified owner");
  assertTrue(!sh.ownerDashboardActiveFor("rfb", ON_ID, false, allowEnv), "unit: gate off without a verified owner");
  assertTrue(!sh.ownerDashboardActiveFor("rfb", OFF_ID, true, allowEnv), "unit: gate off for a profile off the allowlist");
  assertTrue(!sh.ownerDashboardActiveFor("rfb", ON_ID, true, { [ALLOW_ENV]: `rfb:${ON_ID}` }), "unit: gate off with the flag unset");
  assertTrue(!sh.ownerDashboardActiveFor("gardssalg", ON_ID, true, allowEnv), "unit: gate is per vertical (rfb:… does not open gardssalg)");
  const T = sh.OWNER_SHELL_TEXTS;
  assertEq([T.nav, T.skip, T.overview, T.orders, T.ordersShort, T.items, T.features, T.more, T.publicProfile, T.logout],
    ["Eierportal", "Hopp til innholdet", "Oversikt", "Mine ordrer", "Ordrer", "Varer", "Mine valg", "Mer", "Se profilen din", "Logg ut"],
    "unit: the punkt 9 texts are in OWNER_SHELL_TEXTS");
  const start = sh.renderOwnerShellStart({ agentId: ON_ID, current: "oversikt", profileSlug: "skallgard" });
  const startText = start.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);
  assertTrue(startText.every((s) => (Object.values(T) as string[]).includes(s)), `unit: every visible shell text comes from OWNER_SHELL_TEXTS (${startText.join(" | ")})`);
  assertTrue(!/\son[a-z]+\s*=/i.test(start), "unit: no on*= attribute in the shell");
  assertTrue(!/\sstyle="/.test(start) && !/<script/i.test(start), "unit: no style attribute and no script in the shell");
  const bottomOrder = [...shellNav(start).matchAll(/<li><(?:a class="ow-nav-item"[^>]*>(?:<span class="ow-nav-short">)?([^<]+)|details class="ow-more"><summary>([^<]+))/g)].map((m) => m[1] || m[2]);
  assertEq(bottomOrder, ["Oversikt", "Ordrer", "Varer", "Mine valg", "Mer"], "unit: bottom menu order Oversikt · Ordrer · Varer · Mine valg · Mer");
  const L = sh.ownerShellLinks(ON_ID, "skallgard");
  assertEq([L.oversikt, L.ordrer, L.varer, L.valg, L.profil, L.statistikk, L.publicProfile, L.logout], [
    `/eier/${ON_ID}/portal`, `/eier/${ON_ID}/ordrer`, `/eier/${ON_ID}/portal#bestillbare-varer`, `/eier/${ON_ID}/valg`,
    `/eier/${ON_ID}/portal#profil`, `/selger?agent=${ON_ID}#statistikk`, "/produsent/skallgard", `/eier/${ON_ID}/logout`,
  ], "unit: menu links are existing routes only (no /varer, /statistikk, /mer yet)");
  assertTrue(start.includes(`<form class="ow-more-form" method="post" action="/eier/${ON_ID}/logout">`), "unit: «Logg ut» is the existing POST logout (works without JS)");
  const css = sh.OWNER_SHELL_CSS;
  assertTrue(css.includes("@media (max-width: 899.98px)") && css.includes("@media (min-width: 900px)"), "unit: bottom menu below 900 px, side menu from 900 px");
  const mobile = css.slice(css.indexOf("@media (max-width: 899.98px)"), css.indexOf("@media (min-width: 900px)"));
  assertTrue(/body #mv-status \{ bottom: calc\(60px \+ 12px/.test(mobile) && /\.ow-nav \{ left: 0; right: 0; bottom: 0;/.test(mobile),
    "unit: the T9 status line sits above the 60 px bottom menu");
  assertTrue((css.match(/min-height: 44px/g) || []).length >= 3 && /min-height: var\(--ow-nav-h\)/.test(css), "unit: tap targets ≥ 44 px (bottom items 60 px)");
  assertTrue(/\.ow-nav-list > li \{ flex: 1 1 0; min-width: 0; \}/.test(css) && css.includes("max-width: calc(100vw - 16px)"), "unit: bottom items shrink and the Mer list fits a 375 px screen");
  const tk = require("../owner-ui/tokens") as typeof import("../owner-ui/tokens");
  const tokenNames = new Set(tk.OWNER_TOKENS.map((t) => t.name));
  const usedVars = [...css.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]).filter((n) => n !== "ow-nav-h");
  assertEq(usedVars.filter((n) => !tokenNames.has(n)), [], "unit: every colour in the shell CSS is a T6 token");
  assertEq(css.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "unit: no hard-coded colour in the shell CSS");

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
  function makeReq(id: string, tokenOf: string | null, query: Record<string, string> = {}): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (tokenOf) headers.authorization = `Bearer tok-${tokenOf}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: { agentId: id }, body: undefined, query, headers, cookies: {},
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
    // The old anchors' cards: Varer (T13) and the prepayment card (test-mode pilot).
    process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
    process.env.PAYMENTS_ENABLED = "1";
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_KEY;
    process.env.PAYMENTS_ALLOWED_AGENT_IDS = [ON_ID, OFF_ID].join(",");
    seedProducer(db, ON_ID);
    seedProducer(db, OFF_ID);
    seedProducer(db, OTHER_ID);
    seedProducer(db, UNVERIFIED_ID, false);
    const allowList = [ON_ID, OTHER_ID, UNVERIFIED_ID].map((id) => `rfb:${id}`).join(",");
    setEnv(ALLOW_ENV, allowList);

    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const ordersMod = require("./owner-orders") as typeof import("./owner-orders");
    const buyerMod = require("./buyer-order-card") as typeof import("./buyer-order-card");
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      orders: findRouteHandler(ordersMod.default, "/eier/:agentId/ordrer", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
    };
    type PageKey = keyof typeof H;
    const PAGES: PageKey[] = ["portal", "orders", "valg"];
    const CURRENT: Record<PageKey, { section: string; href: string; label: string }> = {
      portal: { section: "oversikt", href: `/eier/${ON_ID}/portal`, label: "Oversikt" },
      orders: { section: "ordrer", href: `/eier/${ON_ID}/ordrer`, label: "Mine ordrer" },
      valg: { section: "valg", href: `/eier/${ON_ID}/valg`, label: "Mine valg" },
    };
    // The orders page carries a fresh idempotency key per form; mask it.
    const noIdem = (h: string) => h.replace(/name="idem" value="[^"]*"/g, `name="idem" value="*"`);
    const query = (p: PageKey): Record<string, string> => (p === "orders" ? { tab: "venter" } : {});
    const get = async (p: PageKey, id: string, tokenOf: string | null = id, q: Record<string, string> = query(p)) => {
      const r = await invoke(H[p], makeReq(id, tokenOf, q));
      return { status: r.status, html: typeof r.body === "string" ? noIdem(r.body) : JSON.stringify(r.body) };
    };
    const snapshot = async () => {
      const out: Record<string, { status: number; html: string }> = {};
      for (const p of PAGES) {
        for (const id of [ON_ID, OFF_ID, UNVERIFIED_ID]) out[`${p}:${id}`] = await get(p, id);
        out[`${p}:nosession`] = await get(p, ON_ID, null);
        out[`${p}:other`] = await get(p, OTHER_ID, ON_ID);
        out[`${p}:stripe`] = p === "portal" ? await get(p, ON_ID, ON_ID, { status: "payments_return" }) : out[`${p}:${ON_ID}`];
      }
      return out;
    };

    // Flag unset: the baseline («før»).
    setEnv(FLAG, null);
    const before = await snapshot();
    assertTrue(before[`portal:${ON_ID}`].html.includes("Skallgard") && before[`orders:${ON_ID}`].html.includes("Mine ordrer") && before[`valg:${ON_ID}`].html.includes("<h1>Mine valg</h1>"),
      "baseline: the three pages render for the allowlisted owner");
    assertTrue(Object.values(before).every((r) => !r.html.includes("ow-nav") && !r.html.includes(`id="innhold"`)), "baseline: no shell with the flag unset");

    // Flag "0": byte-identical everywhere.
    setEnv(FLAG, "0");
    const zero = await snapshot();
    for (const k of Object.keys(before)) assertEq(zero[k], before[k], `off: ${FLAG}=0 — ${k} byte-identical to the flag unset`);

    // Flag on, allowlist unset: byte-identical to (flag unset, allowlist unset).
    setEnv(FLAG, null);
    setEnv(ALLOW_ENV, null);
    const noListBefore = await snapshot();
    setEnv(FLAG, "1");
    const noListOn = await snapshot();
    for (const k of Object.keys(noListBefore)) assertEq(noListOn[k], noListBefore[k], `off: allowlist unset + flag on — ${k} byte-identical to the flag unset`);
    setEnv(ALLOW_ENV, allowList);

    // Flag on: off-list profile, unverified owner, no session, other producer — unchanged.
    const on = await snapshot();
    for (const p of PAGES) {
      for (const k of [`${p}:${OFF_ID}`, `${p}:${UNVERIFIED_ID}`, `${p}:nosession`, `${p}:other`]) {
        assertEq(on[k], before[k], `off: flag on — ${k} byte-identical to the flag unset`);
      }
    }
    assertTrue(before[`portal:${OFF_ID}`].status === 200 && before[`orders:${OFF_ID}`].status === 200 && before[`valg:${OFF_ID}`].status === 404,
      "off: the off-list profile keeps its pages (portal/orders 200, Mine valg 404)");
    assertTrue(before[`portal:${UNVERIFIED_ID}`].status === 200 && !on[`portal:${UNVERIFIED_ID}`].html.includes("ow-nav") && !on[`orders:${UNVERIFIED_ID}`].html.includes("ow-nav"),
      "gate: a session without verified ownership gets no shell");
    assertEq([on["portal:nosession"].html, on["orders:nosession"].html], [JSON.stringify({ __redirect: `/eier/${ON_ID}` }), JSON.stringify({ __redirect: `/eier/${ON_ID}` })],
      "gate: no session → 302 to the login page (portal, orders)");
    assertEq([on["portal:nosession"].status, on["orders:nosession"].status, on["valg:nosession"].status], [302, 302, 401], "gate: no session status unchanged (302, 302, 401 login page)");
    assertEq(PAGES.map((p) => on[`${p}:other`].status), [403, 403, 403], "gate: another producer's session → 403 on all three");
    assertTrue(PAGES.every((p) => !on[`${p}:other`].html.includes("ow-nav")), "gate: no shell on the 403 pages");

    // Flag on, allowlisted verified owner: the shell.
    for (const p of PAGES) {
      const r = on[`${p}:${ON_ID}`];
      const h = r.html;
      const c = CURRENT[p];
      assertEq(r.status, 200, `on: ${p} 200`);
      assertEq(count(h, `<nav class="ow-nav" aria-label="Eierportal">`), 1, `on: ${p} has one <nav aria-label="Eierportal">`);
      assertEq(count(h, `aria-label="Eierportal"`), 1, `on: ${p} has no second «Eierportal» landmark`);
      const nav = shellNav(h);
      assertEq(count(nav, `aria-current="page"`), 1, `on: ${p} nav has exactly one aria-current="page"`);
      const curTag = /<a class="ow-nav-item" href="([^"]*)" aria-current="page">([\s\S]*?)<\/a>/.exec(nav);
      assertEq(curTag ? [curTag[1], curTag[2].replace(/<[^>]+>/g, " ")] : null,
        [c.href, p === "orders" ? " Ordrer  Mine ordrer " : c.label], `on: ${p} aria-current points to «${c.label}»`);
      assertEq(firstFocusable(h), `<a class="ow-skip" href="#innhold">`, `on: ${p} «Hopp til innholdet» is the first focusable element`);
      assertTrue(h.indexOf(`class="ow-skip"`) < h.indexOf(`<nav class="ow-nav"`), `on: ${p} skip link before the nav`);
      assertTrue(h.includes(`>Hopp til innholdet</a>`), `on: ${p} skip link text`);
      assertEq(count(h, `id="innhold"`), 1, `on: ${p} has one #innhold target`);
      assertTrue(/<main[^>]*\sid="innhold"[^>]*tabindex="-1"/.test(h) && h.indexOf(`id="innhold"`) > h.indexOf("</nav>"), `on: ${p} #innhold is the <main> after the nav`);
      assertEq(count(h, /<h1[\s>]/), 1, `on: ${p} has exactly one <h1>`);
      assertEq(count(h, /<main[\s>]/), 1, `on: ${p} has one <main>`);
      const onAttr = /<[a-zA-Z][^>]*\son[a-z]+\s*=/.exec(h);
      assertTrue(!onAttr, `on: ${p} has no on*= attribute${onAttr ? ` (found: ${onAttr[0].slice(0, 80)})` : ""}`);
      assertTrue(h.includes("--ow-page-bg") && h.includes("@media (prefers-color-scheme: dark)"), `on: ${p} carries the T6 tokens (light + dark)`);
      assertTrue(h.includes(`<style>${sh.OWNER_SHELL_CSS}</style>`), `on: ${p} carries the shell CSS`);
      // Nothing else changed: with the shell taken out the page is the flag-off page.
      const shellStart = sh.renderOwnerShellStart({ agentId: ON_ID, current: c.section as any, profileSlug: `skallgard-${ON_ID}` });
      assertTrue(h.includes(shellStart), `on: ${p} shell markup is renderOwnerShellStart (with the public profile link)`);
      let stripped = h.replace(p === "orders" ? `${shellStart}\n` : `\n  ${shellStart}`, "");
      stripped = p === "orders"
        ? stripped.replace(`<main class="mo-wrap" id="innhold" tabindex="-1">`, `<main class="mo-wrap">`)
        : stripped.replace(sh.OWNER_SHELL_MAIN_OPEN, "").replace(/<\/main>(\s*<\/div>\s*<\/body>)/, "$1");
      if (p === "portal") stripped = stripped.replace(`<div class="ep-card" id="profil">`, `<div class="ep-card">`);
      assertEq(stripped, before[`${p}:${ON_ID}`].html, `on: ${p} without the shell markup is byte-identical to the flag-off page`);
    }

    // Old anchors and the Stripe return: still on the same page.
    const portalOn = on[`portal:${ON_ID}`].html;
    const portalOnAll = portalOn + on[`orders:${ON_ID}`].html + on[`valg:${ON_ID}`].html;
    const idsOf = (h: string) => new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const p of PAGES) {
      const lost = [...idsOf(before[`${p}:${ON_ID}`].html)].filter((id) => !idsOf(on[`${p}:${ON_ID}`].html).has(id));
      assertEq(lost, [], `anchors: every id on ${p} without the shell is still there with it`);
    }
    for (const a of OLD_ANCHORS) {
      const was = before[`portal:${ON_ID}`].html.includes(`id="${a}"`);
      assertTrue(!was || portalOn.includes(`id="${a}"`), `anchors: #${a} stays on the portal`);
    }
    assertTrue(["bestillbare-varer", "produkter", "forhandsbetaling", "mine-valg", "mine-ordrer", "bestillinger"].every((a) => portalOnAll.includes(`id="${a}"`)),
      `anchors: the old anchors are present with the shell on (${OLD_ANCHORS.filter((a) => !portalOnAll.includes(`id="${a}"`)).join(",") || "all"})`);
    assertTrue(portalOn.includes(`id="profil"`) && portalOn.includes(`href="/eier/${ON_ID}/portal#profil"`), "anchors: Mer → Profil lands on the portal's #profil card");
    assertTrue(portalOn.includes(`id="bestillbare-varer"`) && portalOn.includes(`href="/eier/${ON_ID}/portal#bestillbare-varer"`), "anchors: Varer lands on the portal's #bestillbare-varer card");
    const stripe = on["portal:stripe"];
    assertTrue(stripe.status === 200 && stripe.html.includes(`id="forhandsbetaling"`) && stripe.html.includes("Vi venter på bekreftelse fra Stripe") && stripe.html.includes("ow-nav"),
      "anchors: the Stripe return /portal?status=payments_return#forhandsbetaling lands on the portal's card, in the shell");
    const stripeStripped = stripe.html.replace(`\n  ${sh.renderOwnerShellStart({ agentId: ON_ID, current: "oversikt", profileSlug: `skallgard-${ON_ID}` })}`, "")
      .replace(sh.OWNER_SHELL_MAIN_OPEN, "").replace(/<\/main>(\s*<\/div>\s*<\/body>)/, "$1").replace(`<div class="ep-card" id="profil">`, `<div class="ep-card">`);
    assertEq(stripeStripped, before["portal:stripe"].html, "anchors: the Stripe return page is the flag-off page plus the shell");

    // Mine valg: the T9 status line and script are still there, inside the page.
    const valgOn = on[`valg:${ON_ID}`].html;
    assertEq(count(valgOn, `id="mv-status"`), 1, "status: Mine valg keeps one #mv-status");
    assertTrue(valgOn.indexOf(`id="mv-status"`) > valgOn.indexOf(`id="innhold"`) && valgOn.includes(featuresMod.ownerStatsHref(ON_ID)), "status: #mv-status inside <main>; the T9 script is kept");
    const pg = require("../owner-features/page") as typeof import("../owner-features/page");
    assertTrue(valgOn.includes(`<script>${pg.OWNER_PAGE_SCRIPT}</script>`), "status: the T9 script is the page's only script addition (unchanged)");
    assertTrue(valgOn.indexOf(`<style>${sh.OWNER_SHELL_CSS}</style>`) < valgOn.indexOf(pg.OWNER_PAGE_CSS), "status: shell CSS (status line above the menu, body-specific) precedes the page CSS and wins by specificity");
    assertEq(featuresMod.ownerStatsHref(ON_ID), sh.ownerShellStatsHref(ON_ID), "status: Statistikk link is the same target as «Se all statistikk»");

    // Fragment answers (T9) are never wrapped.
    const frag = await invoke(H.valg, makeReq(ON_ID, ON_ID, { fragment: "niva" }));
    assertTrue(frag.status === 200 && typeof frag.body === "string" && !frag.body.includes("ow-nav") && !frag.body.includes("<!DOCTYPE"), "status: T9 fragment answers carry no shell");

    // The buyer's order card: unchanged by the flag.
    setEnv(FLAG, null);
    const cardOff = buyerMod.renderBuyerOrderCard(`${ON_ID}-order-1`, `bref_${ON_ID}-order-1`, "", "") || "";
    setEnv(FLAG, "1");
    const cardOn = buyerMod.renderBuyerOrderCard(`${ON_ID}-order-1`, `bref_${ON_ID}-order-1`, "", "") || "";
    assertTrue(cardOn.includes("Bestillingen din hos") && !cardOn.includes("ow-nav"), "buyer: the order card renders without the shell");
    assertEq(noIdem(cardOn), noIdem(cardOff), "buyer: the order card is byte-identical with the flag on");
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
  runOwnerShellT15aTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
