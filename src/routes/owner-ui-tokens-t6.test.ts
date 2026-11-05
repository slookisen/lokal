/**
 * owner-ui-tokens-t6.test.ts — dev-request 2026-10-30-rfb-eierportal-testrunde-1,
 * T6 «felles drakt, lys og mørk»: shared colour tokens on the owner pages.
 *
 *   contrast   every token pair ≥ 4.5:1 (text) / ≥ 3:1 (borders, focus), light
 *              and dark (WCAG relative luminance).
 *   tokens     the token CSS switches with prefers-color-scheme and carries
 *              color-scheme: light dark; every var(--ow-…) used is defined;
 *              «Mine valg»'s CSS has no hard-coded colour left.
 *   rewrite    ownerThemeHtml moves known colour declarations to token classes
 *              and changes nothing else (text, other attributes, other styles).
 *   allowlist  Mine valg, the portal and the owner's «Mine ordrer» list carry
 *              the token CSS with the dark media query and no inline style
 *              that sets a colour.
 *   off-list   the portal and «Mine ordrer» for a subject off the allowlist are
 *              byte-identical to the allowlist unset, with no token CSS/classes.
 *   buyer      the buyer's order card (ordersShell) gets no token CSS/classes.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stack (same harness as owner-features-s2b). Exported
 * runOwnerUiTokensT6Tests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/owner-ui-tokens-t6.test.ts
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

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ENV_KEYS = [ALLOW_ENV, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "ORDER_MESSAGES_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED"];
const ON_ID = "t6-on";
const OFF_ID = "t6-off";
/** The test's colour-style check (dev-request T6 wording). */
const COLOUR_STYLE = /style="[^"]*(color|background|border-color)/;

function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function seedProducer(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for drakt.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 1)`,
  ).run(id, `Draktgard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`);
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

export async function runOwnerUiTokensT6Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const tk = require("../owner-ui/tokens") as typeof import("../owner-ui/tokens");

  // ── Contrast, light and dark ─────────────────────────────────────────────
  const byName = new Map(tk.OWNER_TOKENS.map((t) => [t.name, t]));
  for (const p of tk.OWNER_CONTRAST_PAIRS) {
    for (const theme of ["light", "dark"] as const) {
      const fg = byName.get(p.fg)?.[theme];
      const bg = byName.get(p.bg)?.[theme];
      if (!fg || !bg || !fg.startsWith("#") || !bg.startsWith("#")) {
        assertTrue(false, `contrast ${theme}: ${p.fg} on ${p.bg} has hex values`);
        continue;
      }
      const r = contrastRatio(fg, bg);
      assertTrue(r >= p.min, `contrast ${theme}: ${p.fg} ${fg} on ${p.bg} ${bg} = ${r.toFixed(2)} ≥ ${p.min}`);
    }
  }
  assertTrue(tk.OWNER_CONTRAST_PAIRS.some((p) => p.min === 3 && p.fg === "ow-input-border")
    && tk.OWNER_CONTRAST_PAIRS.some((p) => p.min === 3 && p.fg === "ow-accent-line"), "contrast: input border and focus/accent line are checked at 3:1");

  // ── Token CSS ────────────────────────────────────────────────────────────
  const tokenCss = tk.OWNER_TOKEN_CSS;
  const darkAt = tokenCss.indexOf("@media (prefers-color-scheme: dark)");
  assertTrue(tokenCss.includes("color-scheme: light dark") && darkAt > 0, "tokens: color-scheme light dark + dark media query");
  assertTrue(tk.OWNER_TOKENS.every((t) => tokenCss.slice(0, darkAt).includes(`--${t.name}: ${t.light};`) && tokenCss.slice(darkAt).includes(`--${t.name}: ${t.dark};`)),
    "tokens: every token has its light value at :root and its dark value in the dark block");
  const pg = require("../owner-features/page") as typeof import("../owner-features/page");
  for (const [name, css] of [["OWNER_PAGE_CSS", pg.OWNER_PAGE_CSS], ["OWNER_PORTAL_THEME_CSS", tk.OWNER_PORTAL_THEME_CSS], ["OWNER_ORDERS_THEME_CSS", tk.OWNER_ORDERS_THEME_CSS]] as const) {
    const used = [...css.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]);
    const missing = used.filter((n) => !byName.has(n));
    assertEq(missing, [], `tokens: every var() in ${name} is a defined token`);
    assertTrue(css.includes(tokenCss), `tokens: ${name} carries the token CSS`);
  }
  assertTrue(pg.OWNER_PAGE_CSS.includes("@media (prefers-color-scheme: dark)") && pg.OWNER_PAGE_CSS.includes("color-scheme: light dark"), "Mine valg: AC13 dark-mode strings kept");
  assertEq(pg.OWNER_PAGE_CSS.replace(tokenCss, "").match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], "Mine valg: no hard-coded colour outside the tokens");

  // ── ownerThemeHtml: attributes only ──────────────────────────────────────
  const strip = (h: string) => h.replace(/\s(class|style)="[^"]*"/g, "");
  assertEq(tk.ownerThemeHtml(`<p style="margin-bottom:12px;color:#737373;font-size:0.88rem;">Tekst</p>`),
    `<p class="ow-c-faint" style="margin-bottom:12px;font-size:0.88rem;">Tekst</p>`, "rewrite: colour declaration → class, other declarations kept in order");
  assertEq(tk.ownerThemeHtml(`<span class="mo-count" style="background:#fdf3e7;color:#7a5218;padding:2px 10px;border-radius:999px;">3</span>`),
    `<span class="mo-count ow-bg-pill-warn ow-c-pill-warn" style="padding:2px 10px;border-radius:999px;">3</span>`, "rewrite: merged into an existing class attribute");
  assertEq(tk.ownerThemeHtml(`<li style="background:#eef0ea">x</li>`), `<li class="ow-bg-msg-own">x</li>`, "rewrite: style attribute dropped when nothing else is left");
  const plain = `<div style="display:flex;gap:12px;"><h1 style="margin:0;">Navn</h1></div>`;
  assertEq(tk.ownerThemeHtml(plain), plain, "rewrite: a style without colour is untouched");
  {
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const view = require("./owner-orders-view") as typeof import("./owner-orders-view");
    for (const [name, src] of [
      ["Mine valg entry card", portalMod.ownerFeaturesEntryCardHtml("a1")],
      ["moved card", portalMod.ownerFeaturesMovedCardHtml("a1")],
      ["orders entry card", view.ownerOrdersEntryCardHtml("a1", 3)],
      ["message thread", view.messageThreadHtml([
        { id: "m1", order_id: "o1", author_role: "buyer", body: "Hei", channel: "web", created_at: "2026-10-01T10:00:00Z" } as any,
        { id: "m2", order_id: "o1", author_role: "seller", body: "Hallo", channel: "web", created_at: "2026-10-01T11:00:00Z" } as any,
      ], "seller", "Gard")],
    ] as const) {
      const out = tk.ownerThemeHtml(src);
      assertTrue(!COLOUR_STYLE.test(out), `rewrite: ${name} has no colour inline style left`);
      assertEq(strip(out), strip(src), `rewrite: ${name} — text and other attributes unchanged`);
    }
  }

  // ── Routes ───────────────────────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  const setAllow = (v: string | null) => { if (v === null) delete process.env[ALLOW_ENV]; else process.env[ALLOW_ENV] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(id: string, query: Record<string, string> = {}): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com", authorization: `Bearer tok-${id}` };
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
    seedProducer(db, ON_ID);
    seedProducer(db, OFF_ID);

    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const featuresMod = require("./owner-features") as typeof import("./owner-features");
    const ordersMod = require("./owner-orders") as typeof import("./owner-orders");
    const buyerMod = require("./buyer-order-card") as typeof import("./buyer-order-card");
    const H = {
      portal: findRouteHandler(portalMod.default, "/eier/:agentId/portal", "get"),
      valg: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      orders: findRouteHandler(ordersMod.default, "/eier/:agentId/ordrer", "get"),
    };
    const html = (r: HandlerResult) => String(r.body ?? "");
    // The orders page carries a fresh idempotency key per form; mask it.
    const noIdem = (h: string) => h.replace(/name="idem" value="[^"]*"/g, `name="idem" value="*"`);
    const get = async (h: Function, id: string, query: Record<string, string> = {}) => html(await invoke(h, makeReq(id, query)));
    const noToken = (h: string) => !h.includes("--ow-") && !/class="[^"]*\bow-/.test(h);

    // Off the allowlist: byte-identical to the allowlist unset, no tokens.
    setAllow(null);
    const portalUnset = await get(H.portal, OFF_ID);
    const ordersUnset = noIdem(await get(H.orders, OFF_ID, { tab: "venter" }));
    assertTrue(portalUnset.includes("Draktgard") && ordersUnset.includes("Mine ordrer"), "off-list: portal and orders render");
    setAllow(`rfb:${ON_ID}`);
    const portalOff = await get(H.portal, OFF_ID);
    const ordersOff = noIdem(await get(H.orders, OFF_ID, { tab: "venter" }));
    assertEq(portalOff, portalUnset, "off-list: portal byte-identical to allowlist unset");
    assertEq(ordersOff, ordersUnset, "off-list: Mine ordrer byte-identical to allowlist unset");
    assertTrue(noToken(portalOff) && noToken(ordersOff), "off-list: no token CSS or token classes");
    assertTrue(portalOff.includes(`style="margin-bottom:12px;color:#737373;font-size:0.88rem;"`), "off-list: portal keeps its inline styles");
    assertTrue(ordersOff.includes("background:#eef0ea") || ordersOff.includes("background:#fdf8ef"), "off-list: orders thread keeps its inline styles");

    // On the allowlist: token CSS + dark, no colour inline styles.
    const portalOn = await get(H.portal, ON_ID);
    const valgOn = await get(H.valg, ON_ID);
    const ordersOn = await get(H.orders, ON_ID, { tab: "venter" });
    assertTrue(portalOn.includes(`<style>${tk.OWNER_PORTAL_THEME_CSS}</style>`), "on-list: portal has the theme CSS in the body");
    assertTrue(valgOn.includes(pg.OWNER_PAGE_CSS), "on-list: Mine valg has its CSS (with the tokens)");
    assertTrue(ordersOn.includes(`<style>${tk.OWNER_ORDERS_THEME_CSS}</style>`), "on-list: Mine ordrer has the theme CSS in the body");
    for (const [name, h] of [["portal", portalOn], ["Mine valg", valgOn], ["Mine ordrer", ordersOn]] as const) {
      assertTrue(h.includes("@media (prefers-color-scheme: dark)") && h.includes("color-scheme: light dark") && h.includes("--ow-page-bg"),
        `on-list: ${name} has the token CSS with the dark media query`);
      const m = COLOUR_STYLE.exec(h);
      assertTrue(!m, `on-list: ${name} has no inline style that sets a colour${m ? ` (found: ${h.slice(m.index, m.index + 80)})` : ""}`);
    }
    assertTrue(portalOn.includes("Mine valg") && portalOn.includes("venter på svar") && portalOn.includes("Produkter og åpningstider"), "on-list: portal cards present (rewrite covered them)");
    assertTrue(ordersOn.includes("Kan jeg hente i morgen?") && /class="ow-bg-msg-(own|other)"/.test(ordersOn), "on-list: orders thread bubbles use token classes");

    // The buyer's order card: never themed, even for an allowlisted producer.
    const card = buyerMod.renderBuyerOrderCard(`${ON_ID}-order-1`, `bref_${ON_ID}-order-1`, "", "") || "";
    assertTrue(card.includes("Bestillingen din hos"), "buyer: card renders");
    assertTrue(noToken(card), "buyer: card has no token CSS or token classes");
    assertTrue(card.includes("background:#eef0ea") || card.includes("background:#fdf8ef"), "buyer: card keeps the thread's inline styles");
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
  runOwnerUiTokensT6Tests({ log: true }).then((r) => {
    console.info(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
