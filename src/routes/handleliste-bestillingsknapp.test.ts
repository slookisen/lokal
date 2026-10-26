/**
 * handleliste-bestillingsknapp.test.ts — dev-request
 * 2026-10-21-rfb-bestillinger-klar-for-forste-ekte-handel, skive 3 (AC9).
 *
 * «Bestill for henting» on /produsent/:slug:
 *   - shown only when HANDLELISTE_ENABLED is on AND the producer passes
 *     cart-service.isEligibleForRealOrder(); the contact CTA is unchanged for
 *     everyone else (flag off, ineligible producer, umbrella);
 *   - NO + EN copy and the localized link (/handleliste?produsent=<id>,
 *     /en/shopping-list?produsent=<id>); decided per request (a producer who
 *     stops passing the gate loses the button on the next request).
 * /handleliste?produsent=<agent_id>:
 *   - pre-fills the producer's orderable products (the add/submit row gates:
 *     producer-stated, in stock, no category label, no alcohol), capped at
 *     HANDELISTE_MAX_ITEMS, each with that producer's offer pre-selected;
 *   - a malformed / unknown / ineligible id is ignored: the page is
 *     byte-identical to plain /handleliste and never reflects the value;
 *   - producer strings travel as JSON data only (no raw markup in the page);
 *   - the pre-selected products really become a real order through the
 *     existing cart endpoints;
 *   - the real client script, run on a minimal fake DOM, pre-fills the rows,
 *     goes to step 2 without a place and without any offers fetch, with the
 *     producer's offer checked; an edited row falls back to the search.
 *
 * Standalone: npx tsx src/routes/handleliste-bestillingsknapp.test.ts
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
  opts: { method?: string; url: string; lang?: "no" | "en"; body?: any; query?: Record<string, unknown> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const [path, queryString = ""] = opts.url.split("?");
    const query: Record<string, unknown> = {};
    for (const pair of queryString.split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    Object.assign(query, opts.query || {});
    const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (test)" };
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
      ip: "198.51.100.77",
      protocol: "https",
      hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const out: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader(n: string, v: unknown) { out[n.toLowerCase()] = String(v); return this; },
      getHeader(n: string) { return out[n.toLowerCase()]; },
      header(n: string, v: unknown) { out[n.toLowerCase()] = String(v); return this; },
      set(n: string, v: unknown) { out[String(n).toLowerCase()] = String(v); return this; },
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

// ─── A minimal fake DOM, enough to run the real handleliste client script ───
class FakeNode {
  tag: string;
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  hidden = false;
  value = "";
  checked = false;
  disabled = false;
  className = "";
  hlPre: unknown = undefined;
  private text = "";
  private listeners: Record<string, Array<(e: any) => void>> = {};
  constructor(tag: string, private registry: Map<string, FakeNode>) { this.tag = tag.toLowerCase(); }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c: string) { if (!list().includes(c)) self.className = [...list(), c].join(" "); },
      remove(c: string) { self.className = list().filter((x) => x !== c).join(" "); },
      contains(c: string) { return list().includes(c); },
    };
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
    if (k === "id") this.registry.set(String(v), this);
    if (k === "value") this.value = String(v);
  }
  getAttribute(k: string) { return this.attrs[k]; }
  appendChild(c: FakeNode) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c: FakeNode) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ||= []).push(fn); }
  fire(type: string) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {} }); }
  scrollIntoView() {}
  all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  getElementsByTagName(tag: string) { return this.all().filter((n) => n.tag === tag.toLowerCase()); }
  querySelectorAll(sel: string) {
    if (sel.startsWith(".")) return this.all().filter((n) => n.classList.contains(sel.slice(1)));
    return this.getElementsByTagName(sel);
  }
}

function runClient(script: string, copyJson: string, fetchImpl: (url: string, opts: any) => Promise<any>) {
  const registry = new Map<string, FakeNode>();
  const document = {
    createElement: (tag: string) => new FakeNode(tag, registry),
    createTextNode: (t: string) => { const n = new FakeNode("#text", registry); n.textContent = t; return n; },
    getElementById(id: string) {
      if (!registry.has(id)) {
        // The server-rendered elements; hl-pre is only ever created by the script.
        if (id === "hl-pre") return null;
        const n = new FakeNode("div", registry);
        n.setAttribute("id", id);
      }
      return registry.get(id)!;
    },
  };
  const copyNode = document.getElementById("hl-copy")!;
  copyNode.textContent = copyJson;
  // hl-rows sits inside hl-s1 (insertBefore needs the real parent).
  document.getElementById("hl-s1")!.appendChild(document.getElementById("hl-rows")!);
  const store: Record<string, string> = {};
  const localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  new Function("document", "localStorage", "fetch", "navigator", script)(document, localStorage, fetchImpl, {});
  return { el: (id: string) => document.getElementById(id), store };
}

export async function runHandelisteBestillingsknappTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const seoRouter = require("./seo").default as any;
  const page = require("./handleliste-page") as typeof import("./handleliste-page");
  const offersSvc = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const { cartRouter } = require("./marketplace-cart") as typeof import("./marketplace-cart");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const { slugify } = require("../utils/slug") as typeof import("../utils/slug");
  try { (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot(); } catch { /* already loaded */ }

  const clearRegistryCaches = () => {
    const r = marketplaceRegistry as any;
    r._agentsCache = null; r._statsCache = null; r._agentsCacheTime = 0; r._statsCacheTime = 0;
    r._slugIdMap = null;
  };

  const prevFlag = process.env.HANDLELISTE_ENABLED;
  const prevDb = initMod.__peekDbForTesting();
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence seo/registry chatter */ };
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async () => ({ success: true, messageId: "stub-bestillingsknapp" }));

    const OSLO = { lat: 59.9139, lng: 10.7522 };
    const addAgent = (id: string, name: string, o: { verified?: number; optIn?: number; umbrella?: string | null } = {}) => {
      db.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city, categories, tags,
                            is_active, is_verified, order_notifications_opt_in, umbrella_type)
        VALUES (?, ?, 'Liten gård i Oslo-området som selger grønnsaker direkte fra gården.', 'test', ?, 'https://example.com', 'producer', ?, ?, ?, 'Oslo', '["vegetables"]', '[]', 1, ?, ?, ?)
      `).run(id, name, `${id}@example.com`, `key-${id}`, OSLO.lat, OSLO.lng, o.verified ?? 1, o.optIn ?? 1, o.umbrella ?? null);
      db.prepare(`
        INSERT INTO agent_knowledge (agent_id, verification_status, verified_second_line, phone, email)
        VALUES (?, 'verified', 0, '+47 90000002', ?)
      `).run(id, `${id}@example.com`);
    };
    const addProd = (id: string, agent: string, name: string, o: { price?: number | null; availability?: string; source?: string; updatedAt?: string | null } = {}) =>
      db.prepare(`INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, availability_source, availability_updated_at)
                  VALUES (?, ?, ?, ?, ?, 'kg', ?, ?, ?)`)
        .run(id, agent, name, name.toLowerCase(), o.price === undefined ? 30 : o.price, o.availability ?? "in_stock",
          o.source ?? "admin_producer_confirmed", o.updatedAt === undefined ? new Date().toISOString() : o.updatedAt);

    const XSS = `<img src=x onerror=alert(1)>`;
    addAgent("bk-elig", "Bestillingsgarden");
    addProd("bk-p-pot", "bk-elig", "Poteter");
    addProd("bk-p-gul", "bk-elig", "Gulrøtter", { source: "producer_dashboard" });
    addProd("bk-p-xss", "bk-elig", `Kål ${XSS}`);
    addProd("bk-p-scr", "bk-elig", "Skrapte epler", { source: "enrichment" });
    addProd("bk-p-out", "bk-elig", "Utsolgte løk", { availability: "out_of_stock" });
    addProd("bk-p-old", "bk-elig", "Gammel rabarbra", { source: "producer_dashboard", updatedAt: "2020-01-01T00:00:00.000Z" });
    addProd("bk-p-cid", "bk-elig", "Eplecider");
    // A category label the admin confirmed without a price: still no product (I-S2).
    addProd("bk-p-lab", "bk-elig", "Grønnsaker", { price: null });
    addAgent("bk-noopt", "Kontaktgarden", { optIn: 0 });
    addProd("bk-p-n1", "bk-noopt", "Poteter");
    addAgent("bk-noclaim", "Uverifisertgarden", { verified: 0 });
    addProd("bk-p-n2", "bk-noclaim", "Poteter");
    addAgent("bk-many", "Mangevaregarden");
    for (let i = 0; i < 11; i++) addProd(`bk-m-${String(i).padStart(2, "0")}`, "bk-many", `Vare ${String(i).padStart(2, "0")}`);
    clearRegistryCaches();

    const ELIG_SLUG = slugify("Bestillingsgarden");
    const NOOPT_SLUG = slugify("Kontaktgarden");
    const ctActions = (html: string) => { const m = html.match(/<div class="ct-actions">([\s\S]{0,400})/); return m ? m[1]! : null; };
    const producerPage = async (slug: string, lang: "no" | "en" = "no") => {
      clearRegistryCaches();
      const r = await callRoute(seoRouter, { url: `/produsent/${slug}`, lang });
      return { status: r.status, html: String(r.body ?? ""), headers: r.headers };
    };

    // ═══════════ gate sanity (the fixtures mean what the tests assume) ═══════════
    assertTrue(cartSvc.isEligibleForRealOrder("bk-elig", db), "fixture: bk-elig passes isEligibleForRealOrder");
    assertTrue(!cartSvc.isEligibleForRealOrder("bk-noopt", db), "fixture: bk-noopt (not opted in) fails the gate");
    assertTrue(!cartSvc.isEligibleForRealOrder("bk-noclaim", db), "fixture: bk-noclaim (not owner-claimed) fails the gate");

    // ═══════════ producer page: flag off → no button, CTA unchanged ═══════════
    delete process.env.HANDLELISTE_ENABLED;
    {
      const p = await producerPage(ELIG_SLUG);
      assertEq(p.status, 200, "page/flag-off: eligible producer page renders");
      assertTrue(!p.html.includes("Bestill for henting") && !p.html.includes("?produsent=") && !p.html.includes("data-order-cta"), "page/flag-off: no order button for an eligible producer");
      assertTrue((ctActions(p.html) || "").startsWith("\n"), "page/flag-off: contact CTA block starts exactly as before (no inserted markup)");
      const en = await producerPage(ELIG_SLUG, "en");
      assertTrue(en.status === 200 && !en.html.includes("Order for pickup") && !en.html.includes("shopping-list?produsent="), "page/flag-off: no button on the EN page either");
    }
    process.env.HANDLELISTE_ENABLED = "false";
    {
      const p = await producerPage(ELIG_SLUG);
      assertTrue(!p.html.includes("Bestill for henting") && !p.html.includes("data-order-cta"), "page/flag 'false': no order button");
    }

    // ═══════════ producer page: flag on ═══════════
    process.env.HANDLELISTE_ENABLED = "true";
    {
      const p = await producerPage(ELIG_SLUG);
      assertEq(p.status, 200, "page/flag-on: eligible producer page renders");
      assertTrue(p.html.includes(`href="/handleliste?produsent=bk-elig"`), "page/flag-on: button links to /handleliste?produsent=<id>");
      assertTrue(/data-order-cta="1">[^<]*Bestill for henting<\/a>/.test(p.html), "page/flag-on: NO button copy «Bestill for henting»");
      assertTrue((ctActions(p.html) || "").startsWith(`<a href="/handleliste?produsent=bk-elig"`), "page/flag-on: button sits first in the contact CTA block");
      assertTrue((ctActions(p.html) || "").includes("vcard"), "page/flag-on: the contact CTA (vCard, map) is still there");
      assertTrue(!/cache-control/i.test(Object.keys(p.headers).join(" ")) || !/public/.test(p.headers["cache-control"] || ""), "page/flag-on: no shared-cache header added to the producer page");
      const en = await producerPage(ELIG_SLUG, "en");
      assertTrue(en.html.includes(`href="/en/shopping-list?produsent=bk-elig"`), "page/flag-on EN: button links to /en/shopping-list?produsent=<id>");
      assertTrue(/data-order-cta="1">[^<]*Order for pickup<\/a>/.test(en.html), "page/flag-on EN: EN button copy «Order for pickup»");
      assertTrue(!en.html.includes("Bestill for henting"), "page/flag-on EN: no NO button copy on the EN page");

      for (const [slug, label] of [[NOOPT_SLUG, "not opted in"], [slugify("Uverifisertgarden"), "not owner-claimed"]] as const) {
        const q = await producerPage(slug);
        assertEq(q.status, 200, `page/flag-on: ${label} producer page renders`);
        assertTrue(!q.html.includes("Bestill for henting") && !q.html.includes("?produsent=") && !q.html.includes("data-order-cta"), `page/flag-on: no button for a ${label} producer`);
        assertTrue((ctActions(q.html) || "").startsWith("\n"), `page/flag-on: ${label} producer keeps the unchanged contact CTA`);
      }

      // Per request: the producer leaves the gate → the very next render has no button.
      db.prepare("UPDATE agents SET order_notifications_opt_in = 0 WHERE id = 'bk-elig'").run();
      const after = await producerPage(ELIG_SLUG);
      assertTrue(!after.html.includes("data-order-cta"), "page/per-request: button gone on the next request once the producer opts out");
      db.prepare("UPDATE agents SET order_notifications_opt_in = 1 WHERE id = 'bk-elig'").run();
      const back = await producerPage(ELIG_SLUG);
      assertTrue(back.html.includes("data-order-cta"), "page/per-request: button back once the producer opts in again");
    }

    // ═══════════ findProducerOrderables (server-side, read-only) ═══════════
    {
      const r = offersSvc.findProducerOrderables("bk-elig", { db, limit: page.HANDELISTE_MAX_ITEMS });
      const ids = (r?.offers || []).map((o) => o.product_id);
      assertEq(ids, ["bk-p-gul", "bk-p-xss", "bk-p-pot"], "orderables: only producer-stated, in-stock, non-label, non-alcohol rows, by name (nb)");
      assertTrue(!!r && r.offers.every((o) => o.producer.agent_id === "bk-elig" && o.producer.can_order === true && o.producer_confirmed === true && o.availability === "in_stock"), "orderables: each offer is the producer's, can_order, producer_confirmed, in stock");
      assertTrue(!!r && r.offers.every((o) => o.producer.distance_km === null && !("distance_label" in o.producer)), "orderables: no position → no km figure / distance label");
      assertEq(offersSvc.findProducerOrderables("bk-noopt", { db, limit: 8 }), null, "orderables: ineligible producer → null");
      assertEq(offersSvc.findProducerOrderables("does-not-exist", { db, limit: 8 }), null, "orderables: unknown id → null");
      for (const bad of ["", " bk-elig", "bk-elig'--", "../bk-elig", "<script>", "x".repeat(65), 42, null, ["bk-elig"]]) {
        assertEq(offersSvc.findProducerOrderables(bad as any, { db, limit: 8 }), null, `orderables: malformed id ${JSON.stringify(bad).slice(0, 30)} → null`);
      }
      assertEq((offersSvc.findProducerOrderables("bk-many", { db, limit: page.HANDELISTE_MAX_ITEMS })?.offers || []).length, page.HANDELISTE_MAX_ITEMS, "orderables: capped at HANDELISTE_MAX_ITEMS");
      // Every pre-selected row passes the add-to-cart gate too (one rule, two callers).
      for (const o of r?.offers || []) {
        const row = db.prepare("SELECT agent_id, name, description, category, price_nok, availability, availability_updated_at, availability_source FROM products WHERE id = ?").get(o.product_id) as any;
        assertTrue(cartSvc.isRowOrderableForRealOrder(db, row), `orderables: ${o.product_id} passes isRowOrderableForRealOrder`);
      }
    }

    // ═══════════ /handleliste?produsent= ═══════════
    const hl = async (url: string, lang: "no" | "en" = "no", query?: Record<string, unknown>) => {
      const r = await callRoute(seoRouter, { url, lang, query });
      return { status: r.status, html: String(r.body ?? ""), nextCalled: r.nextCalled };
    };
    const copyOf = (html: string) => JSON.parse((html.match(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/) || [])[1] || "{}");
    {
      const plain = await hl("/handleliste");
      assertEq(plain.status, 200, "hl: plain page 200");
      assertTrue(!("__preselect" in copyOf(plain.html)), "hl: plain page carries no preselect");

      const pre = await hl("/handleliste?produsent=bk-elig");
      assertEq(pre.status, 200, "hl/preselect: 200");
      const c = copyOf(pre.html);
      assertEq((c.__preselect?.offers || []).map((o: any) => o.product_id), ["bk-p-gul", "bk-p-xss", "bk-p-pot"], "hl/preselect: the producer's orderable products are pre-filled");
      assertEq(c.__preselect?.producer_name, "Bestillingsgarden", "hl/preselect: producer name passed as data");
      assertEq(c.__preselect_note, "Bestill for henting fra", "hl/preselect: NO note copy");
      assertTrue(!pre.html.includes(XSS) && !pre.html.includes("<img src=x"), "hl/preselect: hostile product name never appears as raw markup in the page");
      assertTrue((c.__preselect?.offers || []).some((o: any) => o.product_name === `Kål ${XSS}`), "hl/preselect: hostile product name survives as data (rendered via textContent)");

      const many = copyOf((await hl("/handleliste?produsent=bk-many")).html);
      assertEq((many.__preselect?.offers || []).length, page.HANDELISTE_MAX_ITEMS, "hl/preselect: capped at HANDELISTE_MAX_ITEMS");

      const en = await hl("/shopping-list?produsent=bk-elig", "en");
      const ce = copyOf(en.html);
      assertTrue(en.status === 200 && (ce.__preselect?.offers || []).length === 3 && ce.__preselect_note === "Order for pickup from", "hl/preselect EN: works with EN note copy");

      // Ignored silently: page byte-identical to plain /handleliste, value never reflected.
      const garbage: Array<[string, Record<string, unknown> | undefined]> = [
        ["/handleliste?produsent=bk-noopt", undefined],
        ["/handleliste?produsent=bk-noclaim", undefined],
        ["/handleliste?produsent=does-not-exist", undefined],
        ["/handleliste?produsent=", undefined],
        ["/handleliste", { produsent: `"><script>alert(1)</script>` }],
        ["/handleliste", { produsent: "bk-elig' OR 1=1--" }],
        ["/handleliste", { produsent: "x".repeat(500) }],
        ["/handleliste", { produsent: ["bk-elig", "bk-many"] }],
        ["/handleliste", { produsent: { $ne: 1 } }],
      ];
      for (const [url, query] of garbage) {
        const g = await hl(url, "no", query);
        const label = `hl/ignore ${query ? JSON.stringify(query.produsent).slice(0, 30) : url.split("=")[1] || "(empty)"}`;
        assertEq(g.status, 200, `${label}: 200`);
        assertTrue(g.html === plain.html, `${label}: byte-identical to plain /handleliste`);
        if (query && typeof query.produsent === "string") assertTrue(!g.html.includes(query.produsent), `${label}: value not reflected`);
      }

      // Flag off: still the normal 404, with or without the parameter.
      delete process.env.HANDLELISTE_ENABLED;
      const off = await hl("/handleliste?produsent=bk-elig");
      assertTrue(off.nextCalled && off.status === 404, "hl/flag-off: ?produsent= falls through to 404");
      process.env.HANDLELISTE_ENABLED = "true";
    }

    // ═══════════ e2e: the pre-selected products become a real order ═══════════
    {
      const c = copyOf((await hl("/handleliste?produsent=bk-elig")).html);
      const created = await callRoute(cartRouter, { method: "POST", url: "/cart" });
      const { cart_id, buyer_ref } = created.body;
      const base = `/cart/${cart_id}`;
      let allOk = true;
      for (const o of c.__preselect.offers) {
        const w = await callRoute(cartRouter, { method: "POST", url: `${base}/wishes`, body: { term: o.product_name, qty: 1, buyer_ref } });
        const p = await callRoute(cartRouter, { method: "PATCH", url: `${base}/wishes/${w.body.wish.id}`, body: { product_id: o.product_id, qty: 1, buyer_ref } });
        if (w.status !== 201 || p.status !== 200) allOk = false;
      }
      assertTrue(allOk, "e2e: every pre-selected offer is accepted as an order line (no 422/409)");
      const sub = await callRoute(cartRouter, {
        method: "POST", url: `${base}/submit`,
        body: { buyer_ref, website: "", contact_consent: true, buyer_name: "Kari Test", buyer_email: "kari@example.com" },
      });
      assertEq(sub.status, 201, "e2e: submit 201");
      assertTrue(sub.body?.orders?.length === 1 && sub.body.orders[0].agent_id === "bk-elig" && (sub.body.contact_handoffs || []).length === 0, "e2e: one real order to the producer, no contact handoff");
      await new Promise((r) => setTimeout(r, 25));
    }

    // ═══════════ client script on a fake DOM ═══════════
    {
      const script = page.HANDELISTE_CLIENT_SCRIPT;
      let parses = true;
      try { new Function(script); } catch { parses = false; }
      assertTrue(parses, "client: script parses");
      assertTrue(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(script), "client: still no innerHTML & co.");

      const preHtml = (await hl("/handleliste?produsent=bk-elig")).html;
      const copyJson = (preHtml.match(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/) || [])[1] || "";
      const fetches: string[] = [];
      const fetchStub = async (url: string) => { fetches.push(url); return { status: 200, json: async () => ({ offers: [] }) }; };
      const { el } = runClient(script, copyJson, fetchStub);
      const rows = el("hl-rows")!.children;
      assertEq(rows.length, 3, "client/preselect: one row per orderable product");
      assertEq(rows.map((r) => r.getElementsByTagName("input")[0]!.value), ["Gulrøtter", `Kål ${XSS}`, "Poteter"], "client/preselect: rows pre-filled with the product names");
      const note = el("hl-pre");
      assertTrue(!!note && note.textContent === "Bestill for henting fra Bestillingsgarden" && note.children.length === 0, "client/preselect: note shows the producer name as text");
      assertTrue(!el("hl-s1")!.hidden, "client/preselect: starts on step 1 (quantities can be set)");
      el("hl-find")!.fire("click");
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      assertEq(fetches.length, 0, "client/preselect: no offers fetch and no place needed for pre-selected items");
      assertTrue(!el("hl-s2")!.hidden && el("hl-s1")!.hidden, "client/preselect: goes to step 2");
      const radios = el("hl-offers")!.getElementsByTagName("input");
      assertEq(radios.length, 3, "client/preselect: one offer per item (the producer's)");
      assertTrue(radios.every((r) => r.checked), "client/preselect: the producer's offer is pre-selected for each item");
      assertTrue(el("hl-offers")!.querySelectorAll(".sel").length === 3, "client/preselect: selected offers are marked");
      const badge = el("hl-offers")!.querySelectorAll(".hl-badge").map((b) => b.textContent);
      assertTrue(badge.filter((t) => t === "Kan bestilles her").length === 3, "client/preselect: every pre-selected offer is shown as orderable here");

      // Editing a row's term drops its preselection: it is searched again, which needs a place.
      el("hl-back1")!.fire("click");
      const t0 = rows[0]!.getElementsByTagName("input")[0]!;
      t0.value = "Rødbeter";
      t0.fire("input");
      el("hl-find")!.fire("click");
      await new Promise((r) => setTimeout(r, 0));
      assertTrue(!el("hl-msg1")!.hidden && el("hl-msg1")!.textContent === copyOf(preHtml).err_fields, "client/edited: an edited row needs a place again");
      el("hl-place")!.value = "Oslo";
      el("hl-find")!.fire("click");
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      assertTrue(fetches.length === 1 && fetches[0]!.includes("q=R%C3%B8dbeter") && fetches[0]!.includes("near=Oslo"), "client/edited: only the edited row is searched");

      // Without a preselect the client behaves as before: one empty row, no note.
      const plainHtml = (await hl("/handleliste")).html;
      const plainCopy = (plainHtml.match(/<script type="application\/json" id="hl-copy">([\s\S]*?)<\/script>/) || [])[1] || "";
      const plain = runClient(script, plainCopy, fetchStub);
      assertTrue(plain.el("hl-rows")!.children.length === 1 && plain.el("hl-rows")!.children[0]!.getElementsByTagName("input")[0]!.value === "" && plain.el("hl-pre") === null, "client/plain: one empty row, no preselect note (as before)");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    if (prevFlag === undefined) delete process.env.HANDLELISTE_ENABLED; else process.env.HANDLELISTE_ENABLED = prevFlag;
    notifySvc.__setOrderNotifySendForTesting(null);
    notifySvc.__setOrderNotifyTestDb(null);
    clearRegistryCaches();
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runHandelisteBestillingsknappTests({ log: true }).then((r) => {
    console.info(`\nhandleliste-bestillingsknapp: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
