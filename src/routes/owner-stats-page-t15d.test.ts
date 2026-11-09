/**
 * owner-stats-page-t15d.test.ts — dev-request 2026-10-30-rfb-eierportal-testrunde-1,
 * punkt 9, slice T15d «Statistikk-siden»: GET /eier/:id/statistikk in the
 * owner shell (the /selger Statistikk tab's sections, rendered on the server
 * from getOwnerStats) behind OWNER_DASHBOARD_ENABLED + the allowlist + a
 * verified owner.
 *
 *   unit      the shell's Statistikk link and aria-current; statsPage false =
 *             the T15c shell; the render escapes every text value; a null
 *             payload → «—» and the one line.
 *   off       flag unset / "0" / off the allowlist / unverified / no session /
 *             another producer: /portal, /ordrer, /valg, /varer byte-identical
 *             to the flag unset (snapshot), and GET /statistikk goes on
 *             (next()) exactly as when the route did not exist.
 *   on        /statistikk 200 in the shell: one nav, one aria-current="page"
 *             (on Mer → Statistikk), one <h1> «Statistikk», skip link first,
 *             no on*= attribute, no script beyond the shell's.
 *   parity    every number on the page = the owner-stats JSON field for the
 *             same fixture (same handler, same session).
 *   escape    a search term with <script> and " is shown as text.
 *   gate      no session → 302, another producer → 403.
 *   failure   the stats read throws → 200, «—» and the one line.
 *   links     Mer → Statistikk (all five pages), «Se all statistikk» on Mine
 *             valg and Oversikt's «Statistikk» row → /statistikk only when on.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stack (same harness as owner-items-page-t15c). Exported
 * runOwnerStatsPageT15dTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-stats-page-t15d.test.ts
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
const BUSY = "t15d-busy";
const OFFLIST = "t15d-offlist";
const OTHER = "t15d-other";
const UNVERIFIED = "t15d-unverified";
const DAY = 86_400_000;
const EVIL_TERM = `<script>alert("x")</script> & "egg"`;

function seedProducer(db: Database.Database, id: string, verified = true): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for Statistikk-siden.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?, 1)`,
  ).run(id, `Statgard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, verified ? "2026-10-01T00:00:00.000Z" : null);
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
  db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(`mlsess_tok-${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
}

/** The stats fixture: page views (people by source + AI search), conversations, contact clicks, the discovered counter. */
function seedStats(db: Database.Database, id: string, path: string): void {
  const pv = db.prepare(`INSERT INTO analytics_page_views (path, source, session_id, is_owner, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))`);
  for (let i = 0; i < 3; i++) pv.run(path, "direct", `iphash-d${i}:Mozilla/5.0 (Macintosh) Chrome/120`, 0, `-${i + 1} days`);
  for (let i = 0; i < 2; i++) pv.run(path, "search", `iphash-s${i}:Mozilla/5.0 (Macintosh) Chrome/120`, 0, "-3 days");
  pv.run(path, "organic", "iphash-o0:Mozilla/5.0 (Macintosh) Chrome/120", 0, "-4 days");
  for (let i = 0; i < 4; i++) pv.run(path, "direct", `iphash-gpt-${i}:Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot`, 0, "-2 days");
  for (let i = 0; i < 2; i++) pv.run(path, "direct", `iphash-claude-${i}:Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)`, 0, "-1 days");
  pv.run(path, "direct", "iphash-pplx:Mozilla/5.0 (compatible; Perplexity-User/1.0)", 0, "-1 days");
  pv.run(path, "direct", "iphash-owner:Mozilla/5.0 (Macintosh) Chrome/120", 1, "-1 days");
  const conv = db.prepare(`INSERT INTO conversations (id, seller_agent_id, source, query_text, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))`);
  conv.run(`${id}-c1`, id, "web", "Har du økologiske egg?", "-1 days");
  conv.run(`${id}-c2`, id, "mcp", "Har du økologiske egg?", "-2 days");
  conv.run(`${id}-c3`, id, "a2a", EVIL_TERM, "-3 days");
  conv.run(`${id}-c4`, id, null, "Åpningstider?", "-4 days");
  const click = db.prepare(`INSERT INTO contact_clicks (agent_id, kind, is_bot, created_at) VALUES (?, ?, ?, datetime('now', ?))`);
  for (let i = 0; i < 3; i++) click.run(id, "website", 0, "-1 days");
  for (let i = 0; i < 2; i++) click.run(id, "email", 0, "-2 days");
  click.run(id, "external:<b>x</b>", 0, "-2 days");
  click.run(id, "phone", 1, "-1 days");
  db.prepare(`INSERT INTO agent_metrics (agent_id, times_discovered) VALUES (?, ?)`).run(id, 42);
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

function firstFocusable(h: string): string {
  const body = h.slice(h.indexOf("<body"));
  const m = /<(a\s[^>]*href=|button[\s>]|input\s(?![^>]*type="hidden")|select[\s>]|textarea[\s>]|summary[\s>])[^>]*>/i.exec(body);
  return m ? m[0] : "";
}

function unesc(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" } as Record<string, string>)[k]);
}

/** The number in a stat tile with data-<attr>="<key>" (null when absent). */
function tile(h: string, attr: string, key: string): string | null {
  const m = new RegExp(`<div class="ep-stat" ${attr}="${key}"><div class="ep-stat-num">([^<]*)</div>`).exec(h);
  return m ? m[1] : null;
}

export async function runOwnerStatsPageT15dTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const sp = require("../owner-ui/stats-page") as typeof import("../owner-ui/stats-page");
  assertEq([sp.OWNER_STATS_PAGE_TEXTS.title, sh.OWNER_SHELL_TEXTS.stats], ["Statistikk", "Statistikk"], "unit: the page title is the shell's «Statistikk»");
  assertEq(sh.ownerShellLinks("u 1", "").statistikk, "/selger?agent=u%201#statistikk", "unit: without the Statistikk page the link is as in T15a");
  assertEq(sh.ownerShellLinks("u 1", "", false, true).statistikk, "/eier/u%201/statistikk", "unit: with the Statistikk page the link is /eier/:id/statistikk");
  assertEq(sh.ownerStatsPagePath(`x"><i>`), "/eier/x%22%3E%3Ci%3E/statistikk", "unit: the Statistikk path encodes the agent id");
  const startStats = sh.renderOwnerShellStart({ agentId: "u1", current: "statistikk", statsPage: true });
  assertTrue(startStats.includes(`<a class="ow-more-item" href="/eier/u1/statistikk" aria-current="page">Statistikk</a>`) && count(shellNav(startStats), `aria-current="page"`) === 1,
    "unit: current \"statistikk\" → exactly one aria-current, on Mer → Statistikk");
  const startOv = sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt", statsPage: true });
  assertTrue(startOv.includes(`<a class="ow-more-item" href="/eier/u1/statistikk">Statistikk</a>`) && count(shellNav(startOv), `aria-current="page"`) === 1,
    "unit: on another page Statistikk links to /statistikk without aria-current");
  assertEq(sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt", statsPage: false }), sh.renderOwnerShellStart({ agentId: "u1", current: "oversikt" }), "unit: statsPage false = the T15c shell");
  const failedBody = sp.renderOwnerStatsSections({ stats: null, nowMs: Date.now() });
  assertTrue(failedBody.includes(sp.OWNER_STATS_PAGE_TEXTS.readFailed) && count(failedBody, `<div class="ep-stat-num">—</div>`) === 3, "unit: no payload → «—» and the one line");
  assertTrue(!/<h1[\s>]/.test(failedBody), "unit: the sections carry no <h1>");

  // ── Routes ───────────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const setEnv = (k: string, v: string | null) => { if (v === null) delete process.env[k]; else process.env[k] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; query?: Record<string, string>; token?: string | null }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: undefined, query: o.query || {}, headers, cookies: {},
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
  const prevErr = console.error;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* quiet */ }; console.error = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    cartSvc.__setCartTestDb(db as any);
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ORDER_MESSAGES_ENABLED = "1";
    process.env.OWNER_UNIFIED_SESSION_ENABLED = "1";
    process.env[CARD_FLAG] = "1";

    for (const id of [BUSY, OFFLIST, OTHER]) seedProducer(db, id);
    seedProducer(db, UNVERIFIED, false);
    const pathOf = (id: string) => `/produsent/${slugify(`Statgard ${id}`)}`;
    for (const id of [BUSY, OFFLIST, UNVERIFIED]) seedStats(db, id, pathOf(id));
    const allowList = [BUSY, OTHER, UNVERIFIED].map((id) => `rfb:${id}`).join(",");
    setEnv(ALLOW_ENV, allowList);

    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const ordersMod = require("./owner-orders") as typeof import("./owner-orders");
    const R = portalMod.default;
    const H = {
      portal: findRouteHandler(R, "/eier/:agentId/portal", "get"),
      varer: findRouteHandler(R, "/eier/:agentId/varer", "get"),
      statistikk: findRouteHandler(R, "/eier/:agentId/statistikk", "get"),
      json: findRouteHandler(R, "/api/agents/:id/owner-stats", "get"),
      orders: findRouteHandler(ordersMod.default, "/eier/:agentId/ordrer", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
    };
    type PageKey = "portal" | "orders" | "valg" | "varer" | "statistikk";
    const PAGES: PageKey[] = ["portal", "orders", "valg", "varer"];
    const noIdem = (h: string) => h.replace(/name="idem" value="[^"]*"/g, `name="idem" value="*"`);
    const get = async (p: PageKey, id: string, token: string | null = `tok-${id}`) => {
      const r = await invoke(H[p], makeReq({ params: { agentId: id }, token, query: p === "orders" ? { tab: "venter" } : {} }));
      return { status: r.status, html: typeof r.body === "string" ? noIdem(r.body) : JSON.stringify(r.body) };
    };
    const NEXT = JSON.stringify({ __next: true });
    const snapshot = async () => {
      const out: Record<string, { status: number; html: string }> = {};
      for (const p of [...PAGES, "statistikk" as const]) {
        for (const id of [BUSY, OFFLIST, UNVERIFIED]) out[`${p}:${id}`] = await get(p, id);
        out[`${p}:nosession`] = await get(p, BUSY, null);
        out[`${p}:other`] = await get(p, OTHER, `tok-${BUSY}`);
      }
      return out;
    };
    const STATS_LINK = (id: string) => `/eier/${id}/statistikk"`;

    // ── Off: byte-identical snapshot; /statistikk is not there ──────────────
    setEnv(FLAG, null);
    const before = await snapshot();
    assertTrue(Object.entries(before).filter(([k]) => !k.startsWith("statistikk:")).every(([, r]) => !r.html.includes("/statistikk\"")),
      "off: no link to /statistikk on any page");
    assertTrue(Object.entries(before).filter(([k]) => k.startsWith("statistikk:")).every(([, r]) => r.html === NEXT),
      "off: GET /statistikk goes on to the next handler (as when the route did not exist), for every case");
    const valgOff = before[`valg:${BUSY}`].html;
    assertTrue(valgOff.includes(`href="/selger?agent=${BUSY}#statistikk">Se all statistikk</a>`), "off: «Se all statistikk» on Mine valg → the /selger tab, as before");
    setEnv(FLAG, "0");
    const zero = await snapshot();
    for (const k of Object.keys(before)) assertEq(zero[k], before[k], `off: ${FLAG}=0 — ${k} byte-identical to the flag unset`);
    setEnv(FLAG, "1");
    const on = await snapshot();
    for (const p of [...PAGES, "statistikk" as const]) {
      for (const k of [`${p}:${OFFLIST}`, `${p}:${UNVERIFIED}`]) assertEq(on[k], before[k], `off: flag on — ${k} (off the list / not verified) byte-identical to the flag unset`);
    }
    // /varer's own 302/403 with the flag on is T15c's gate (checked below against /statistikk's).
    for (const p of PAGES.filter((x) => x !== "varer")) {
      for (const k of [`${p}:nosession`, `${p}:other`]) assertEq(on[k], before[k], `off: flag on — ${k} unchanged`);
    }
    setEnv(ALLOW_ENV, null);
    setEnv(FLAG, null);
    const noListOff = await snapshot();
    setEnv(FLAG, "1");
    const noListOn = await snapshot();
    for (const k of Object.keys(noListOff)) assertEq(noListOn[k], noListOff[k], `off: allowlist unset + flag on — ${k} byte-identical`);
    assertTrue(Object.entries(noListOn).filter(([k]) => k.startsWith("statistikk:")).every(([, r]) => r.html === NEXT), "off: allowlist unset → GET /statistikk goes on");
    setEnv(ALLOW_ENV, allowList);

    // ── Gate ────────────────────────────────────────────────────────────────
    assertEq([on["statistikk:nosession"].status, on["statistikk:nosession"].html], [302, JSON.stringify({ __redirect: `/eier/${BUSY}` })], "gate: no session → 302 to the login page, as /varer");
    assertEq([on["varer:nosession"].status, on["varer:nosession"].html], [302, JSON.stringify({ __redirect: `/eier/${BUSY}` })], "gate: /varer's 302 is the same");
    assertEq(on["statistikk:other"].status, 403, "gate: another producer's session → 403");
    assertTrue(on["statistikk:other"].html.includes("Ingen tilgang") && !on["statistikk:other"].html.includes("ow-nav") && !on["statistikk:other"].html.includes(`data-stats=`),
      "gate: the 403 page has no shell and no numbers");

    // ── On: the Statistikk page ─────────────────────────────────────────────
    const page = on[`statistikk:${BUSY}`];
    const sh2 = page.html;
    assertEq(page.status, 200, "on: /statistikk 200");
    const nav = shellNav(sh2);
    assertEq(count(sh2, `<nav class="ow-nav" aria-label="Eierportal">`), 1, "on: one nav");
    assertEq(count(sh2, /<nav[\s>]/), 1, "on: no second <nav>");
    assertEq(count(nav, `aria-current="page"`), 1, "on: exactly one aria-current=\"page\"");
    assertTrue(nav.includes(`<a class="ow-more-item" href="/eier/${BUSY}/statistikk" aria-current="page">Statistikk</a>`), "on: aria-current is on Mer → Statistikk");
    assertEq(count(sh2, /<h1[\s>]/), 1, "on: exactly one <h1>");
    assertTrue(/<h1>Statistikk<\/h1>/.test(sh2), "on: the <h1> is «Statistikk»");
    assertEq(firstFocusable(sh2), `<a class="ow-skip" href="#innhold">`, "on: «Hopp til innholdet» is the first focusable element");
    assertTrue(/<main id="innhold" tabindex="-1">/.test(sh2) && sh2.indexOf(`<main id="innhold"`) > sh2.indexOf("</nav>") && sh2.indexOf("<h1>") > sh2.indexOf(`<main id="innhold"`),
      "on: the page sits in <main id=\"innhold\"> after the nav, the <h1> inside");
    assertTrue(sh2.includes(`<title>Statistikk · Statgard ${BUSY} — Rett fra Bonden</title>`), "on: page title");
    const onAttr = /<[a-zA-Z][^>]*\son[a-z]+\s*=/.exec(sh2);
    assertTrue(!onAttr, `on: no on*= attribute${onAttr ? ` (${onAttr[0].slice(0, 80)})` : ""}`);
    assertTrue(!/<[a-zA-Z][^>]*\sstyle=/.test(sh2.slice(sh2.indexOf(`<main id="innhold"`))), "on: no inline style attribute in the page content");
    assertEq(count(sh2, /<script[\s>]/), count(on[`varer:${BUSY}`].html, /<script[\s>]/), "on: no script beyond what the shell page already has (same count as /varer)");
    assertTrue(sh2.includes("--ow-page-bg") && sh2.includes("@media (prefers-color-scheme: dark)"), "on: the T6 tokens (light + dark)");
    for (const sec of ["funnel", "ai-funnel", "views", "ai", "ai-deliveries", "terms", "channels", "clicks"]) {
      assertEq(count(sh2, `data-stats="${sec}"`), 1, `on: the tab's section «${sec}» is there once`);
    }
    assertTrue(!sh2.includes(`data-stats="empty"`) && !sh2.includes(`data-stats="failed"`), "on: no empty-state banner and no failure line with activity");

    // ── Parity: the page's numbers = the owner-stats JSON ──────────────────
    const jr = await invoke(H.json, makeReq({ params: { id: BUSY }, token: `tok-${BUSY}` }));
    const J = jr.body as any;
    assertTrue(jr.status === 200 && J && J.success === true, "parity: the JSON route answers for the same session");
    assertEq(J.funnel, { discovered: 42, viewed: 6, contactClicked: 6 }, "parity: fixture sanity (funnel)");
    assertEq(tile(sh2, "data-stat", "discovered"), String(J.funnel.discovered), "parity: Oppdaget = funnel.discovered");
    assertEq(tile(sh2, "data-stat", "seen"), String(J.year.humanViews.value), "parity: Sett = year.humanViews.value");
    assertTrue(sh2.includes(`Besøk på profilsiden (${J.year.labels.nb.humanViews})`), "parity: Besøk på profilsiden carries year.labels.nb.humanViews");
    assertEq(tile(sh2, "data-stat", "contactClicked"), String(J.funnel.contactClicked), "parity: Kontakt-klikk = funnel.contactClicked");
    assertTrue(sh2.includes(`Trykk på e-post, telefon eller nettside (siste ${J.windowDays} dager)`), "parity: the window is windowDays");
    assertEq(tile(sh2, "data-stat", "aiAll"), String(J.year.aiViews.value), "parity: Alle AI-assistenter = year.aiViews.value");
    assertEq([tile(sh2, "data-stat", "chatgpt"), tile(sh2, "data-stat", "claude"), tile(sh2, "data-stat", "aiOther")],
      [String(J.aiPlatforms.chatgpt), String(J.aiPlatforms.claude), String(J.aiPlatforms.other)], "parity: ChatGPT / Claude / Andre AI = aiPlatforms");
    assertEq([J.aiPlatforms.chatgpt, J.aiPlatforms.claude, J.aiPlatforms.other], [4, 2, 1], "parity: fixture sanity (AI split)");
    assertEq([tile(sh2, "data-stat", "dlWindow"), tile(sh2, "data-stat", "dlAllTime")], [String(J.aiDeliveries.window.total), String(J.aiDeliveries.allTime.total)],
      "parity: Med i AI-søk = aiDeliveries.window/allTime.total");
    const sources = Object.fromEntries([...sh2.matchAll(/<div class="ow-st-src" data-source="([^"]+)" data-count="(\d+)">/g)].map((m) => [unesc(m[1]), Number(m[2])]));
    // Tekstpakke B punkt 11: «organic» has no name of its own; its count is shown under «direct».
    const wantSources: Record<string, number> = {};
    for (const [k, v] of Object.entries(J.viewsBySource.totals as Record<string, number>)) {
      const into = k === "organic" ? "direct" : k;
      wantSources[into] = (wantSources[into] || 0) + v;
    }
    assertEq(sources, wantSources, "parity: views by source = viewsBySource.totals (organic counted under direct)");
    const terms = [...sh2.matchAll(/<li class="ow-st-row" data-term-count="(\d+)"><span>([^<]*)<\/span>/g)].map((m) => ({ term: unesc(m[2]), count: Number(m[1]) }));
    assertEq(terms, J.matchingSearchQueries, "parity: search terms (text and count, in order) = matchingSearchQueries");
    const channels = [...sh2.matchAll(/<li class="ow-st-row" data-channel="([^"]+)"><span>[^<]*<\/span><span class="ow-st-meta">(\d+)<\/span>/g)].map((m) => ({ source: unesc(m[1]), count: Number(m[2]) }));
    assertEq(channels, J.conversationsByChannel, "parity: conversations per channel = conversationsByChannel");
    const kinds = [...sh2.matchAll(/<li class="ow-st-row" data-kind="([^"]+)"><span>[^<]*<\/span><span class="ow-st-meta">(\d+)<\/span>/g)].map((m) => ({ kind: unesc(m[1]), count: Number(m[2]) }));
    assertEq(kinds, J.contactClicksByKind, "parity: contact clicks by kind = contactClicksByKind");
    const af = J.aiFunnel;
    assertTrue(!!af && !!af.sentToAi && !!af.aiClicks && !!af.contactClicks, "parity: fixture has all three AI-funnel steps");
    if (af) {
      assertEq([tile(sh2, "data-ai-funnel", "sentToAi"), tile(sh2, "data-ai-funnel", "aiClicks"), tile(sh2, "data-ai-funnel", "contactClicks")],
        [String(af.sentToAi.total), String(af.aiClicks.total), String(af.contactClicks.total)], "parity: AI funnel tiles = aiFunnel.*.total");
      const fromAi = /<strong data-ai-funnel-from-ai="1">(\d+)<\/strong>/.exec(sh2);
      assertEq(fromAi ? Number(fromAi[1]) : null, af.contactClicks.fromAi.total, "parity: «hvorav etter klikk fra AI-svar» = aiFunnel.contactClicks.fromAi.total");
    }
    const trendSum = [...sh2.matchAll(/<rect [^>]*data-count="(\d+)"/g)].reduce((s, m) => s + Number(m[1]), 0);
    assertEq(count(sh2, /<rect /), 30, "parity: the trend has 30 days");
    assertEq(trendSum, (J.viewsBySource.daily as any[]).reduce((s, r) => s + r.count, 0), "parity: the trend's 30 days add up to viewsBySource.daily (all inside 30 days)");

    // ── Escaping ────────────────────────────────────────────────────────────
    assertTrue(!sh2.includes(`<script>alert`) && !sh2.includes(EVIL_TERM), "escape: the raw search term is not in the page");
    assertTrue(sh2.includes(`<span>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;egg&quot;</span>`), "escape: the search term with <script> and \" is shown as text");
    assertTrue(sh2.includes(`Lenke til (&lt;b&gt;x&lt;/b&gt;)`) && !sh2.includes("<b>x</b>"), "escape: a contact-click kind is shown as text");

    // ── Failure: the stats read throws → 200, «—», one line ────────────────
    db.exec("ALTER TABLE agent_metrics RENAME TO agent_metrics_t15d_off");
    const broken = await get("statistikk", BUSY);
    db.exec("ALTER TABLE agent_metrics_t15d_off RENAME TO agent_metrics");
    assertEq(broken.status, 200, "failure: a thrown stats read → still 200");
    assertTrue(broken.html.includes(`data-stats="failed"`) && count(broken.html, sp.OWNER_STATS_PAGE_TEXTS.readFailed) === 1 && count(broken.html, `<div class="ep-stat-num">—</div>`) === 3,
      "failure: «—» and the one short line");
    assertTrue(count(broken.html, /<h1[\s>]/) === 1 && shellNav(broken.html).includes(`href="/eier/${BUSY}/statistikk" aria-current="page"`), "failure: still the page in the shell with one <h1>");
    const jBroken = await (async () => { db.exec("ALTER TABLE agent_metrics RENAME TO agent_metrics_t15d_off"); const r = await invoke(H.json, makeReq({ params: { id: BUSY }, token: `tok-${BUSY}` })); db.exec("ALTER TABLE agent_metrics_t15d_off RENAME TO agent_metrics"); return r; })();
    assertEq(jBroken.status, 500, "failure: the JSON route is unchanged (500 on the same failure)");

    // ── Empty state: a producer with no activity → the tab's banner ────────
    const emptyStats = (require("../services/owner-stats-service") as typeof import("../services/owner-stats-service")).getOwnerStats(db as any, "t15d-nobody", "/produsent/t15d-nobody");
    const emptyHtml = sp.renderOwnerStatsSections({ stats: emptyStats, nowMs: Date.now() });
    assertTrue(emptyHtml.includes(`data-stats="empty"`) && emptyHtml.includes(sp.OWNER_STATS_PAGE_TEXTS.emptyTitle), "empty: no activity → the tab's empty-state banner");
    assertTrue(emptyHtml.includes(sp.OWNER_STATS_PAGE_TEXTS.termsNone) && emptyHtml.includes(sp.OWNER_STATS_PAGE_TEXTS.clicksNone) && emptyHtml.includes(sp.OWNER_STATS_PAGE_TEXTS.trendNone),
      "empty: the tab's «ingen … ennå» lines");

    // ── Links: switch only when on ──────────────────────────────────────────
    for (const p of PAGES) {
      const n = shellNav(on[`${p}:${BUSY}`].html);
      assertTrue(n.includes(`<a class="ow-more-item" href="/eier/${BUSY}/statistikk">Statistikk</a>`) && !n.includes("/selger?agent="), `links: ${p} Mer → Statistikk → /eier/:id/statistikk (not current)`);
      assertEq(count(n, `aria-current="page"`), 1, `links: ${p} still has exactly one aria-current`);
      const nOff = shellNav(before[`${p}:${BUSY}`].html);
      assertTrue(!nOff.includes(STATS_LINK(BUSY)), `links: ${p} off → no /statistikk link`);
    }
    const portalOn = on[`portal:${BUSY}`].html;
    assertTrue(new RegExp(`<li data-part="statistikk"><a class="ow-ov-row" href="/eier/${BUSY}/statistikk">`).test(portalOn), "links: Oversikt «Statistikk» row → /eier/:id/statistikk");
    const valgOn = on[`valg:${BUSY}`].html;
    assertTrue(valgOn.includes(`href="/eier/${BUSY}/statistikk">Se all statistikk</a>`) && !valgOn.includes(`/selger?agent=${BUSY}#statistikk`), "links: «Se all statistikk» on Mine valg → /eier/:id/statistikk");
    assertEq(featuresMod.ownerStatsHref(BUSY), `/selger?agent=${BUSY}#statistikk`, "links: ownerStatsHref (the off target) is unchanged");
    // The /varer page's shell also links to /statistikk; and with the Varer card off the stats page still exists.
    setEnv(CARD_FLAG, null);
    const noCard = await get("statistikk", BUSY);
    assertTrue(noCard.status === 200 && shellNav(noCard.html).includes(`href="/eier/${BUSY}/portal#bestillbare-varer"`), "links: Varer card off → /statistikk still there, Varer link as in T15b");
    setEnv(CARD_FLAG, "1");
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    console.warn = prevWarn;
    cartSvc.__setCartTestDb(null);
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerStatsPageT15dTests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
