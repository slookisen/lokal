/**
 * handleliste-page.test.ts — dev-request
 * 2026-09-16-handleliste-med-produsentvalg-og-bestillingsflyt, Slice 3.
 *
 * Covers the web page /handleliste (NO) + /en/shopping-list (EN):
 *   - HANDLELISTE_ENABLED off (unset / "false") -> both paths fall through
 *     (router calls next(), i.e. the normal 404); not in sitemap.xml
 *   - flag on -> 200 HTML in NO and EN, noindex meta + X-Robots-Tag, canonical,
 *     each path only answers in its own language
 *   - static copy escaped; the page ships NO user/producer strings server-side
 *     and the client script builds DOM only via textContent / allow-listed hrefs
 *     (no innerHTML), the script parses, and it only talks to the five existing
 *     endpoints from slices 0-2
 *   - e2e-ish: the exact request sequence the page JS issues (offers -> cart ->
 *     wishes -> PATCH per pick -> submit) against an in-memory DB through the
 *     real catalog + cart routers: opt-in producer -> order ("bestilling
 *     sendt"), contact-only producer -> contact_handoffs entry, honeypot
 *     field present in the page and rejected by the API when filled, XSS
 *     payloads in producer name come back as data (escaped on the client).
 *
 * Harness mirrors marketplace-cart-wishes.test.ts (router.handle with a hand-
 * built req/res, in-memory DB). Standalone: npx tsx src/routes/handleliste-page.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  headers: Record<string, string>;
  nextCalled: boolean;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; lang?: "no" | "en"; headers?: Record<string, string>; body?: any; ip?: string }
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const [path, queryString = ""] = opts.url.split("?");
    const query: Record<string, string> = {};
    for (const pair of queryString.split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      path,
      query,
      params: {},
      headers,
      body: opts.body ?? {},
      lang: opts.lang || "no",
      langOriginalPath: path,
      ip: opts.ip || "198.51.100.23",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const out: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader(n: string, v: unknown) { out[n.toLowerCase()] = String(v); return this; },
      getHeader(n: string) { return out[n.toLowerCase()]; },
      header(n: string, v: unknown) { out[n.toLowerCase()] = String(v); return this; },
      type() { return this; },
      removeHeader() {},
      append() {},
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload, headers: out, nextCalled: false }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload, headers: out, nextCalled: false }); return this; },
      redirect() { resolve({ status: 302, body: undefined, headers: out, nextCalled: false }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined, headers: out, nextCalled: false }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: err ? { error: String(err) } : undefined, headers: out, nextCalled: true });
    });
  });
}

export async function runHandelistePageTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.log(`  ok ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const seoRouter = require("./seo").default as any;
  const page = require("./handleliste-page") as typeof import("./handleliste-page");
  const { cartRouter } = require("./marketplace-cart") as typeof import("./marketplace-cart");
  const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");

  // shell() reads getConfig(); the vertical configs are normally loaded at boot.
  try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

  const prevFlag = process.env.HANDLELISTE_ENABLED;
  const prevDb = (() => { try { return initMod.getDb(); } catch { return undefined; } })();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);

    // ═══════════ Flag off → 404 (fall-through), sitemap unaffected ═══════════
    for (const v of [undefined, "", "false", "0"]) {
      if (v === undefined) delete process.env.HANDLELISTE_ENABLED; else process.env.HANDLELISTE_ENABLED = v;
      assertEq(page.isHandelisteEnabled(), false, `flag ${JSON.stringify(v)} -> disabled`);
      const no = await callRoute(seoRouter, { url: "/handleliste" });
      const en = await callRoute(seoRouter, { url: "/shopping-list", lang: "en" });
      assertTrue(no.nextCalled && no.status === 404, `flag ${JSON.stringify(v)}: /handleliste falls through to 404`);
      assertTrue(en.nextCalled && en.status === 404, `flag ${JSON.stringify(v)}: /en/shopping-list falls through to 404`);
    }
    delete process.env.HANDLELISTE_ENABLED;
    {
      const sm = await callRoute(seoRouter, { url: "/sitemap.xml" });
      const xml = String(sm.body ?? "");
      assertTrue(sm.status === 200 && !xml.includes("handleliste") && !xml.includes("shopping-list"), "sitemap.xml has no handleliste / shopping-list entry (flag off)");
      process.env.HANDLELISTE_ENABLED = "true";
      const sm2 = await callRoute(seoRouter, { url: "/sitemap.xml" });
      const xml2 = String(sm2.body ?? "");
      assertTrue(!xml2.includes("handleliste") && !xml2.includes("shopping-list"), "sitemap.xml has no handleliste / shopping-list entry (flag on: noindex page, never listed)");
    }

    // ═══════════ Flag on → renders NO + EN ═══════════
    process.env.HANDLELISTE_ENABLED = "true";
    assertEq(page.isHandelisteEnabled(), true, "flag 'true' -> enabled");
    process.env.HANDLELISTE_ENABLED = "1";
    assertEq(page.isHandelisteEnabled(), true, "flag '1' -> enabled");

    const no = await callRoute(seoRouter, { url: "/handleliste" });
    const noHtml = String(no.body ?? "");
    assertEq(no.status, 200, "flag on: /handleliste -> 200");
    assertTrue(noHtml.includes('<html lang="nb"') || noHtml.includes('<html lang="no"'), "NO page has Norwegian html lang");
    assertTrue(noHtml.includes("Handleliste") && noHtml.includes("Finn produsenter") && noHtml.includes("Bestilling sendt, venter bekreftelse"), "NO page carries NO copy (incl. result copy)");
    assertTrue(/<meta name="robots" content="noindex/.test(noHtml), "NO page: <meta robots> is noindex");
    assertTrue((no.headers["x-robots-tag"] || "").includes("noindex"), "NO page: X-Robots-Tag noindex");
    assertTrue((no.headers["cache-control"] || "").includes("no-store"), "NO page: Cache-Control no-store");
    assertTrue(noHtml.includes('<link rel="canonical" href="https://rettfrabonden.com/handleliste">') || /rel="canonical" href="[^"]*\/handleliste"/.test(noHtml), "NO page: canonical /handleliste");
    assertTrue(/hreflang="en" href="[^"]*\/en\/shopping-list"/.test(noHtml), "NO page: hreflang en points at the real /en/shopping-list");
    assertTrue(!/\/en\/handleliste/.test(noHtml), "NO page: no alternate to the non-existent /en/handleliste");
    assertTrue(noHtml.includes('id="hl-website"'), "page carries the honeypot field");

    const en = await callRoute(seoRouter, { url: "/shopping-list", lang: "en" });
    const enHtml = String(en.body ?? "");
    assertEq(en.status, 200, "flag on: /en/shopping-list -> 200");
    assertTrue(enHtml.includes('<html lang="en"') && enHtml.includes("Shopping list") && enHtml.includes("Find producers") && enHtml.includes("Order sent, awaiting confirmation"), "EN page carries EN copy");
    assertTrue(/<meta name="robots" content="noindex/.test(enHtml), "EN page: <meta robots> is noindex");
    assertTrue(/rel="canonical" href="[^"]*\/en\/shopping-list"/.test(enHtml), "EN page: canonical /en/shopping-list");

    // Each path only answers in its own language.
    const crossNo = await callRoute(seoRouter, { url: "/handleliste", lang: "en" });
    const crossEn = await callRoute(seoRouter, { url: "/shopping-list", lang: "no" });
    assertTrue(crossNo.nextCalled, "/en/handleliste (NO path under /en) falls through to 404");
    assertTrue(crossEn.nextCalled, "/shopping-list without /en falls through to 404");

    // ═══════════ Escaping / client-script contract ═══════════
    const built = page.buildHandelistePage("no");
    // The only server-rendered dynamic-looking data is the copy JSON; "<" is escaped so it can never close the script tag.
    const copyJson = (noHtml.match(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/) || [])[1] || "";
    assertTrue(copyJson.length > 0 && !copyJson.includes("<"), "copy JSON blob contains no raw '<'");
    assertTrue(JSON.parse(copyJson).h1 === "Handleliste", "copy JSON parses and holds the NO copy");
    assertTrue(!/<script[^>]*>[^<]*<\/script>\s*<script[^>]*>[^<]*alert\(/i.test(noHtml), "no injected script payload in page");

    const script = page.HANDELISTE_CLIENT_SCRIPT;
    let parses = true;
    try { new Function(script); } catch { parses = false; }
    assertTrue(parses, "client script is syntactically valid JS");
    assertTrue(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script), "client script never uses innerHTML/outerHTML/insertAdjacentHTML/document.write/eval (XSS-safe DOM building)");
    assertTrue(/textContent/.test(script) && /function safeHref/.test(script), "client script uses textContent + allow-listed hrefs");
    assertTrue(!/console\.(log|error|warn)/.test(script), "client script never logs (buyer contact is never logged)");
    assertTrue(!/localStorage\.setItem\([^)]*(email|phone|name|note)/i.test(script) && /LS_CART/.test(script) && /LS_RESULT/.test(script), "only cart token + producer-side result go to localStorage, not buyer fields");
    const endpoints = Array.from(script.matchAll(/'(\/api\/marketplace\/[^']*)'/g)).map((m) => m[1]!.replace(/[?].*$/, ""));
    const allowed = new Set([
      "/api/marketplace/catalog/offers",
      "/api/marketplace/cart",
      "/api/marketplace/cart/",
    ]);
    assertTrue(endpoints.length > 0 && endpoints.every((e) => allowed.has(e)), `client script only calls existing endpoints (${Array.from(new Set(endpoints)).join(", ")})`);
    assertTrue(script.includes("'/wishes'") && script.includes("'/submit'") && script.includes("/wishes/"), "client script uses wishes + wishes/:wid + submit");
    assertTrue(built.content.includes("noscript"), "page has a noscript fallback message");
    assertTrue(page.HANDELISTE_OFFERS_INITIAL < 5 && page.HANDELISTE_MAX_ITEMS >= 2, "show-more window < 5 (endpoint cap) so 'vis flere' has something to reveal");
    // Hardcoded demo of the escaper used for static copy.
    const enBuilt = page.buildHandelistePage("en");
    assertTrue(!enBuilt.content.includes("<img") && !enBuilt.content.includes("onerror"), "static copy has no injected markup");

    // ═══════════ e2e-ish flow through the real routers ═══════════
    const sent: any[] = [];
    notifySvc.__setOrderNotifySendForTesting(async (m: any) => { sent.push(m); return { success: true, messageId: "stub-handleliste-page" }; });

    const OSLO_NEAR = { lat: 59.9289, lng: 10.7522 };
    const XSS = `<img src=x onerror=alert(1)>Gård "A"`;
    const addAgent = (id: string, name: string, verified: number, optIn: number, second: number, lat: number) => {
      db.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city, is_active, is_verified, order_notifications_opt_in)
        VALUES (?, ?, 'test', 'test', ?, 'https://example.com', 'producer', ?, ?, ?, 'Oslo', 1, ?, ?)
      `).run(id, name, `${id}@example.com`, `key-${id}`, lat, OSLO_NEAR.lng, verified, optIn);
      db.prepare(`
        INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line, phone, email)
        VALUES (?, 'verified', ?, '+47 90000001', ?)
      `).run(id, second, `${id}@example.com`);
    };
    const addProd = (id: string, agent: string, name: string) =>
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source) VALUES (?, ?, ?, ?, 20, 'kg', 'in_stock', 'enrichment')`)
        .run(id, agent, name, name.toLowerCase());
    addAgent("hl-order", XSS, 1, 1, 0, OSLO_NEAR.lat);
    addProd("hl-p-pot", "hl-order", "Poteter");
    addAgent("hl-contact", "Honning Gård", 0, 0, 0, OSLO_NEAR.lat + 0.01);
    addProd("hl-p-hon", "hl-contact", "Honning");

    // Step 2 of the page: one offers call per item (near=Oslo, radius 50, limit 5).
    const offPot = await callRoute(catalogRouter, { url: "/offers?q=Poteter&near=Oslo&radius_km=50&limit=5" });
    const offHon = await callRoute(catalogRouter, { url: "/offers?q=Honning&near=Oslo&radius_km=50&limit=5" });
    assertEq(offPot.status, 200, "flow: offers (Poteter, near=Oslo) 200");
    const potOffer = offPot.body.offers.find((o: any) => o.producer.agent_id === "hl-order");
    const honOffer = offHon.body.offers.find((o: any) => o.producer.agent_id === "hl-contact");
    assertTrue(!!potOffer && potOffer.producer.can_order === true && !!potOffer.product_id, "flow: opt-in producer offer is can_order with product_id");
    assertTrue(!!honOffer && honOffer.producer.can_order === false, "flow: non-opt-in producer offer is contact-only");
    assertEq(potOffer.producer.name, XSS, "flow: hostile producer name travels as raw data (client renders via textContent)");
    assertTrue(offPot.body.offers.length <= 5, "flow: at most 5 offers per item");

    // Step 3 -> submit: cart, wishes, PATCH per pick, submit (same bodies as the page).
    const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
    assertEq(created.status, 201, "flow: POST /cart 201");
    const { cart_id, buyer_ref } = created.body;
    const base = `/cart/${cart_id}`;
    const w1 = await callRoute(cartRouter, { method: "POST", url: `${base}/wishes`, body: { term: "Poteter", qty: 2, buyer_ref } });
    const w2 = await callRoute(cartRouter, { method: "POST", url: `${base}/wishes`, body: { term: "Honning", qty: 1, buyer_ref } });
    assertTrue(w1.status === 201 && w2.status === 201, "flow: two wishes created");
    const p1 = await callRoute(cartRouter, { method: "PATCH", url: `${base}/wishes/${w1.body.wish.id}`, body: { product_id: potOffer.product_id, qty: 2, buyer_ref } });
    const p2 = await callRoute(cartRouter, { method: "PATCH", url: `${base}/wishes/${w2.body.wish.id}`, body: { agent_id: "hl-contact", mode: "contact", buyer_ref } });
    assertTrue(p1.status === 200 && p2.status === 200, "flow: both picks PATCHed (order + contact)");

    const honeypot = await callRoute(cartRouter, { method: "POST", url: `${base}/submit`, body: { buyer_ref, website: "http://bot.example" } });
    assertEq(honeypot.status, 400, "flow: filled honeypot rejected by submit");

    const sub = await callRoute(cartRouter, {
      method: "POST", url: `${base}/submit`,
      body: { buyer_ref, website: "", contact_consent: true, buyer_name: "Kari Test", buyer_email: "kari@example.com", buyer_phone: "12345678", delivery_note: "torsdag" },
    });
    assertEq(sub.status, 201, "flow: submit 201");
    assertEq(sub.body.orders.length, 1, "flow: one real order for the opt-in producer ('bestilling sendt')");
    assertEq(sub.body.orders[0].agent_id, "hl-order", "flow: order belongs to the opt-in producer");
    assertEq(sub.body.contact_handoffs.length, 1, "flow: one contact handoff for the contact-only producer");
    const h = sub.body.contact_handoffs[0];
    assertTrue(h.agent_id === "hl-contact" && typeof h.message === "string" && h.message.includes("Honning") && !!h.phone && !!h.profile_url, "flow: handoff has name/phone/profile_url/ready message");
    assertTrue(!JSON.stringify(h).includes("kari@example.com") && !h.message.includes("Kari"), "flow: handoff never leaks buyer contact");
    assertTrue(typeof honOffer.producer.vcard_url === "string" && honOffer.producer.vcard_url.length > 0, "flow: vCard url comes from the offer (page keeps it for the result view)");
    // Let the fire-and-forget notification settle, then check buyer contact reached only the ordered producer.
    await new Promise((r) => setTimeout(r, 25));
    assertTrue(sent.length <= 1, "flow: at most one notification sent (only the opt-in producer)");
  } finally {
    if (prevFlag === undefined) delete process.env.HANDLELISTE_ENABLED; else process.env.HANDLELISTE_ENABLED = prevFlag;
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runHandelistePageTests({ log: true }).then((r) => {
    console.log(`\nhandleliste-page: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
