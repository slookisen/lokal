/**
 * owner-features-t9-enhance.test.ts — dev-request 2026-10-30-rfb-eierportal-
 * testrunde-1, slice T9 («lagres der du står», steg 2), AC5 (server side).
 *
 *   f  `?fragment=<region-id>[,…]` on the «Mine valg» GET answers with only
 *      those regions — the same markup as in the full page (same render
 *      functions) — with the fragment header; an id outside the region list
 *      → 404; the same gate (allowlist 404, session 401, verified owner 403);
 *      a fragment GET writes nothing.
 *   p  a page POST sent with `?fragment=` passes it on to its 303 (with the
 *      T5 anchor); without it the Location is unchanged; junk is dropped.
 *   s  the page: one #mv-status (role=status, aria-live=polite), the shared
 *      script exactly once, no inline `on*=` handlers in any state.
 *   j  the script (owner-ui/enhance.ts): compiles, has the spec texts, and —
 *      run against a small fake DOM — never re-submits a form that got an
 *      HTTP answer (FUNN t5-gjeninnsending-ordre-epost), never re-submits a
 *      `data-mv-once` form, falls back to the plain submit only when fetch
 *      itself failed, and ignores a second submit while one runs.
 *   m  FUNN t5-testhull-advopen-catch: «Flere valg» opens when the message is
 *      in one of its rows (advOpen); a POST that throws after the checks
 *      answers 303 «feil» at its anchor (not a 500 page).
 *   d  FUNN t8-uncounted-blocks-utestet: deriveOwnerLevel leaves keys with an
 *      OWNER_LEVEL_UNCOUNTED_BLOCKS block out, and a level with no matching
 *      counted key never applies (matched === 0).
 *   g  gårdssalg «Mine valg»: the same fragment answers over HTTP.
 *
 * Exported runOwnerFeaturesT9EnhanceTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-t9-enhance.test.ts
 */

import Database from "better-sqlite3";
import * as vm from "vm";
import { elementById } from "./owner-features-t5-anchors.test";

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

const RFB_ENV = [
  "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_PAUSE_ENABLED",
  "OWNER_ORDER_EMAIL_ENABLED", "OWNER_FEATURES_ENFORCE",
];
const OWNED_ID = "t9-owned";
const UNVERIFIED_ID = "t9-unverified";
const OUTSIDE_ID = "t9-outside";
const BROKEN_ID = "t9-broken";

function seedProducer(db: Database.Database, id: string, o: { verified?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at,
        order_notifications_opt_in)
     VALUES (?, ?, 'Testprodusent for T9.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z', 0)`,
  ).run(id, `Stedgard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.verified === false ? 0 : 1);
  db.prepare(
    `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
     VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
  ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, price_nok, unit, availability, category, description, availability_source)
     VALUES (?, ?, 'Poteter', 'poteter', 30, 'kg', 'in_stock', 'vegetables', NULL, 'admin_producer_confirmed')`,
  ).run(`p-${id}`, id);
}

/** The «Mine valg» part of a page (from .mv-page to the script). */
function mvPart(html: string): string {
  const at = html.indexOf(`<div class="mv-page">`);
  return at < 0 ? "" : html.slice(at, html.indexOf("<script>", at));
}

// ── A small fake DOM, enough for the script's request/answer paths ─────────

type Sel = { tag?: string; id?: string; classes: string[]; attrs: Array<[string, string | null]>; not: Sel[] };

function parseCompound(s: string): Sel {
  const sel: Sel = { classes: [], attrs: [], not: [] };
  let rest = s.trim();
  const notRe = /:not\(([^)]*)\)/g;
  rest = rest.replace(notRe, (_m, inner) => { sel.not.push(parseCompound(inner)); return ""; });
  rest = rest.replace(/\[([a-z-]+)(?:=([^\]]+))?\]/gi, (_m, a, v) => { sel.attrs.push([a.toLowerCase(), v === undefined ? null : v.replace(/^["']|["']$/g, "")]); return ""; });
  rest = rest.replace(/#([A-Za-z0-9_.-]+)/g, (_m, id) => { sel.id = id; return ""; });
  rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, (_m, c) => { sel.classes.push(c); return ""; });
  if (rest.trim()) sel.tag = rest.trim().toUpperCase();
  return sel;
}

class FakeEl {
  nodeType = 1;
  tagName: string;
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  textContent = "";
  disabled = false;
  value = "";
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  get id(): string { return this.attrs.id || ""; }
  get className(): string { return this.attrs.class || ""; }
  set className(v: string) { this.attrs.class = v; }
  get firstChild(): FakeEl | null { return this.children[0] || null; }
  get action(): string { return this.attrs.action || ""; }
  get href(): string { return this.attrs.href || ""; }
  getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  appendChild(c: FakeEl) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c: FakeEl) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  contains(o: FakeEl | null): boolean { for (let e: FakeEl | null = o; e; e = e.parentNode) if (e === this) return true; return false; }
  getBoundingClientRect() { return { top: 100 }; }
  focus() { /* no-op */ }
  private matchOne(s: Sel): boolean {
    if (s.tag && s.tag !== this.tagName) return false;
    if (s.id && s.id !== this.id) return false;
    const cls = this.className.split(/\s+/);
    if (!s.classes.every((c) => cls.includes(c))) return false;
    if (!s.attrs.every(([a, v]) => this.hasAttribute(a) && (v === null || this.getAttribute(a) === v))) return false;
    if (s.not.some((n) => this.matchOne(n))) return false;
    return true;
  }
  /** Simple selectors with descendant combinators and comma lists. */
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const chain = part.trim().split(/\s+/).map(parseCompound);
      if (!this.matchOne(chain[chain.length - 1])) return false;
      let el: FakeEl | null = this.parentNode;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (el && !el.matchOne(chain[i])) el = el.parentNode;
        if (!el) return false;
        el = el.parentNode;
      }
      return true;
    });
  }
  all(): FakeEl[] { const out: FakeEl[] = []; const walk = (e: FakeEl) => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(s: string): FakeEl[] { return this.all().filter((e) => e.matches(s)); }
  querySelector(s: string): FakeEl | null { return this.querySelectorAll(s)[0] || null; }
  getElementsByTagName(t: string): FakeEl[] { return this.all().filter((e) => e.tagName === t.toUpperCase()); }
}

interface FakeRun {
  submits: number;
  fetches: Array<{ url: string; init: any }>;
  assigns: string[];
  page: FakeEl;
  form: FakeEl;
  status: FakeEl;
  fire: () => void;
  settle: () => Promise<void>;
}

/**
 * The script against a fake page with one row form. `answer` decides what
 * fetch gives: a Response-like object, or "reject" (no answer at all).
 */
function runScript(script: string, answer: (() => any) | "reject" | "pending", o: { once?: boolean; online?: boolean } = {}): FakeRun {
  const root = new FakeEl("html");
  const page = root.appendChild(new FakeEl("div", { class: "mv-page" }));
  const group = page.appendChild(new FakeEl("section", { class: "ep-card mv-group", id: "gruppe-orders" }));
  const ul = group.appendChild(new FakeEl("ul", { class: "mv-list" }));
  const li = ul.appendChild(new FakeEl("li", { class: "mv-item", id: "valg-orders.email" }));
  const text = li.appendChild(new FakeEl("div", { class: "mv-item-text" }));
  text.appendChild(new FakeEl("strong")).textContent = "E-post for bestillinger";
  const ctl = li.appendChild(new FakeEl("div", { class: "mv-item-ctl" }));
  const formAttrs: Record<string, string> = { method: "post", action: "https://rettfrabonden.com/eier/x/valg/ordre-epost", class: "mv-ctl-form", "data-mv-row": "gruppe-orders" };
  if (o.once) formAttrs["data-mv-once"] = "1";
  const form = ctl.appendChild(new FakeEl("form", formAttrs));
  form.appendChild(new FakeEl("input", { type: "email", name: "email", value: "ny@t9.example.no" }));
  form.appendChild(new FakeEl("button", { type: "submit", class: "ep-btn" }));
  const status = page.appendChild(new FakeEl("div", { id: "mv-status", role: "status", "aria-live": "polite" }));

  const listeners: Record<string, Array<(ev: any) => void>> = {};
  (page as any).addEventListener = (t: string, fn: (ev: any) => void) => { (listeners[t] = listeners[t] || []).push(fn); };
  const run: FakeRun = {
    submits: 0, fetches: [], assigns: [], page, form, status,
    fire: () => { for (const fn of listeners.submit || []) fn({ target: form, preventDefault() { /* */ } }); },
    settle: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
  };
  class FakeFormData { constructor(public f: FakeEl) {} }
  class FakeURLSearchParams extends URLSearchParams {
    constructor(init?: any) {
      if (init instanceof FakeFormData) {
        super(Object.fromEntries(init.f.querySelectorAll("input").filter((i) => i.getAttribute("name")).map((i) => [i.getAttribute("name")!, i.value])));
      } else super(init);
    }
  }
  function FormProto() { /* */ }
  (FormProto as any).prototype = { submit() { run.submits++; } };
  const document = {
    querySelector: (s: string) => root.querySelector(s),
    getElementById: (id: string) => root.all().find((e) => e.id === id) || null,
    createElement: (t: string) => new FakeEl(t),
    importNode: (n: any) => n,
    activeElement: null,
    body: root,
  };
  const ctx: any = {
    document,
    navigator: { onLine: o.online !== false },
    location: { assign: (u: string) => { run.assigns.push(u); } },
    HTMLFormElement: FormProto,
    FormData: FakeFormData,
    URLSearchParams: FakeURLSearchParams,
    DOMParser: function () { return { parseFromString: () => ({ getElementById: () => null, querySelector: () => null }) }; },
    fetch: (url: string, init: any) => {
      run.fetches.push({ url, init });
      if (answer === "reject") return Promise.reject(new TypeError("Failed to fetch"));
      if (answer === "pending") return new Promise(() => { /* never */ });
      return Promise.resolve(answer());
    },
  };
  ctx.window = ctx;
  ctx.scrollBy = () => { /* */ };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return run;
}

function fakeResponse(status: number, o: { redirected?: boolean; url?: string; fragment?: boolean; body?: string } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: !!o.redirected,
    url: o.url ?? "https://rettfrabonden.com/eier/x/valg/ordre-epost",
    headers: { get: (k: string) => (o.fragment && k.toLowerCase() === "x-mv-fragment" ? "gruppe-orders" : null) },
    text: () => Promise.resolve(o.body ?? "<p>feil</p>"),
  };
}

export async function runOwnerFeaturesT9EnhanceTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const en = require("../owner-ui/enhance") as typeof import("../owner-ui/enhance");
  const anchors = require("../owner-features/anchors") as typeof import("../owner-features/anchors");

  // ══════════════════════════════════════════════════════════════════════
  // j — the script
  // ══════════════════════════════════════════════════════════════════════
  {
    const S = en.OWNER_ENHANCE_SCRIPT;
    let compiles = true;
    try { new vm.Script(S); } catch { compiles = false; }
    assertTrue(compiles, "j01: the script compiles");
    assertTrue(!S.includes("f.submit()") && !/\.submit\(\)/.test(S), "j02: no form.submit() call anywhere (only the guarded nativeSubmit)");
    assertEq((S.match(/HTMLFormElement\.prototype\.submit/g) || []).length, 1, "j03: one plain-submit path");
    for (const [k, v] of Object.entries(en.OWNER_ENHANCE_TEXTS)) assertTrue(S.includes(JSON.stringify(v).slice(1, -1)), `j04: the script carries the text ${k}`);
    assertEq(en.OWNER_ENHANCE_TEXTS, {
      saving: "Lagrer …",
      switchOn: "Lagret: «{valg}» er slått på.",
      switchOff: "Lagret: «{valg}» er slått av.",
      level: "Du bruker nå «{nivå}».",
      undo: "Angre",
      undone: "Endringen er angret.",
      noChange: "Ingen endring – valget var allerede slik.",
      failed: "Klarte ikke å lagre. Prøv igjen.",
      network: "Fikk ikke kontakt. Sjekk nettet og prøv igjen.",
      tooMany: "For mange endringer. Prøv igjen om litt.",
    }, "j05: the texts are the spec's (punkt 2 «Tekst»)");
    assertTrue(!S.includes("__TEXTS__") && !S.includes("__HEADER__"), "j06: placeholders filled");
    assertTrue(!/\son[a-z]+\s*=/.test(en.OWNER_STATUS_HTML) && /role="status"/.test(en.OWNER_STATUS_HTML) && /aria-live="polite"/.test(en.OWNER_STATUS_HTML), "j07: #mv-status is a polite status region");

    const alerts = (r: FakeRun) => r.page.querySelectorAll("[data-mv-error]");
    for (const [code, text] of [[500, en.OWNER_ENHANCE_TEXTS.failed], [403, en.OWNER_ENHANCE_TEXTS.failed], [401, en.OWNER_ENHANCE_TEXTS.failed], [429, en.OWNER_ENHANCE_TEXTS.tooMany]] as const) {
      const r = runScript(S, () => fakeResponse(code));
      r.fire();
      await r.settle();
      const a = alerts(r);
      assertTrue(r.submits === 0 && r.assigns.length === 0 && r.fetches.length === 1, `j08: HTTP ${code} → the form is not sent again (FUNN t5-gjeninnsending-ordre-epost)`);
      assertTrue(a.length === 1 && a[0].getAttribute("role") === "alert" && a[0].textContent === text && r.form.parentNode!.parentNode!.contains(a[0]),
        `j09: HTTP ${code} → «${text}» next to the row (role=alert)`);
      assertTrue(!r.form.querySelector("button")!.disabled, `j10: HTTP ${code} → the button is usable again`);
    }
    {
      // A followed 303 whose page answer is not a fragment: a plain GET at the anchor, never the POST again.
      const r = runScript(S, () => fakeResponse(200, { redirected: true, url: "https://rettfrabonden.com/eier/x/valg?melding=ordre_epost_sendt&fragment=gruppe-orders&ved=valg-orders.email" }));
      r.fire();
      await r.settle();
      assertTrue(r.submits === 0 && r.assigns.length === 1 && r.assigns[0] === "https://rettfrabonden.com/eier/x/valg?melding=ordre_epost_sendt&ved=valg-orders.email#valg-orders.email",
        `j11: followed 303 without fragment answer → GET of the page at the anchor, fragment dropped (${r.assigns[0]})`);
    }
    {
      const r = runScript(S, () => fakeResponse(500, { redirected: true, url: "https://rettfrabonden.com/eier/x/valg?endret=4&fragment=gruppe-orders" }));
      r.fire();
      await r.settle();
      assertTrue(r.submits === 0 && r.assigns.length === 1 && r.assigns[0].endsWith("/valg?endret=4#valg-orders.email"), "j12: followed 303 whose GET failed → GET of the page, never the POST again");
    }
    {
      const r = runScript(S, "reject");
      r.fire();
      await r.settle();
      assertEq(r.submits, 1, "j13: fetch failed (no answer) → the plain form submission, once");
    }
    {
      const r = runScript(S, "reject", { once: true });
      r.fire();
      await r.settle();
      assertTrue(r.submits === 0 && alerts(r).length === 1 && alerts(r)[0].textContent === en.OWNER_ENHANCE_TEXTS.network,
        "j14: a data-mv-once form (order address) is never re-sent; «Fikk ikke kontakt» next to the row");
    }
    {
      const r = runScript(S, "reject", { online: false });
      r.fire();
      await r.settle();
      assertTrue(r.submits === 0 && alerts(r)[0]?.textContent === en.OWNER_ENHANCE_TEXTS.network, "j15: offline → «Fikk ikke kontakt», no submission");
    }
    {
      const r = runScript(S, "pending");
      r.fire();
      r.fire();
      r.fire();
      await r.settle();
      assertEq(r.fetches.length, 1, "j16: a second submit while one runs is ignored (double click)");
      assertTrue(r.form.querySelector("button")!.disabled && r.status.children[0]?.textContent === en.OWNER_ENHANCE_TEXTS.saving, "j17: while saving: button disabled, #mv-status «Lagrer …»");
      const f = r.fetches[0];
      assertTrue(f.init.method === "POST" && /\/valg\/ordre-epost\?fragment=gruppe-orders$/.test(f.url) && f.init.credentials === "same-origin",
        `j18: the POST asks for the page's regions with ?fragment= (${f.url})`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // d — deriveOwnerLevel (FUNN t8-uncounted-blocks-utestet)
  // ══════════════════════════════════════════════════════════════════════
  {
    try {
      const ch = require("../owner-features/changes") as typeof import("../owner-features/changes");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      const registry = reg.ownerFeatureRegistryFor("rfb");
      // Three live switches and a synthetic level that turns all three on.
      const keys = registry.filter((e) => e.type === "switch" && reg.ownerFeatureStatus(e) === "live").slice(0, 3).map((e) => e.key);
      assertEq(keys.length, 3, "d00: three live switches to build a level from");
      const [k1, k2, k3] = keys;
      const A = { ...ch.OWNER_LEVELS[0], values: [[k1, true], [k2, true], [k3, true]] as Array<[string, any]> };
      const make = (vals: Record<string, boolean>, blocks: Record<string, string> = {}) => {
        const byKey: Record<string, any> = {};
        for (const [k, v] of Object.entries(vals)) byKey[k] = { key: k, value: v, source: "owner", changeable: true, block: blocks[k] ?? null, reason: null };
        return { subject: {} as any, features: Object.values(byKey), byKey } as any;
      };
      const exc = (r: ReturnType<typeof ch.deriveOwnerLevel>) => (r ? r.exceptions.map((x) => x.key) : null);
      const vals = { [k1]: true, [k2]: true, [k3]: false };
      assertEq(exc(ch.deriveOwnerLevel(make(vals), [A], registry)), [k3], "d01: a counted key off the preset is an exception");
      for (const b of Array.from(ch.OWNER_LEVEL_UNCOUNTED_BLOCKS)) {
        assertEq(exc(ch.deriveOwnerLevel(make(vals, { [k3]: b }), [A], registry)), [], `d02: block «${b}» → the key does not count (OWNER_LEVEL_UNCOUNTED_BLOCKS)`);
      }
      assertEq(exc(ch.deriveOwnerLevel(make(vals, { [k3]: "requirement_not_met" }), [A], registry)), [k3], "d03: a counted block (requirement_not_met) still counts");
      assertEq(ch.deriveOwnerLevel(make({ [k1]: false, [k2]: false, [k3]: false }), [A], registry), null, "d04: no matching counted key → the level never applies (matched === 0)");
      assertEq(ch.deriveOwnerLevel(make({ [k1]: true, [k2]: true, [k3]: true }, { [k1]: "killswitch", [k2]: "admin_locked", [k3]: "coming_soon" }), [A], registry), null,
        "d05: every key uncounted → null");
    } catch (err: any) {
      failed++;
      failures.push("d: unexpected error: " + String(err?.stack || err));
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // f / p / s / m — RFB
  // ══════════════════════════════════════════════════════════════════════
  {
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevDb = initMod.__peekDbForTesting();
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of RFB_ENV) prevEnv[k] = process.env[k];
    const db = new Database(":memory:");
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    const prevLog = console.log;
    const prevErr = console.error;
    if (!log) { console.log = () => { /* */ }; console.error = () => { /* */ }; }

    function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
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
          req,
          status(c: number) { status = c; return res; },
          json(p: any) { settle(p); return res; },
          send(p: any) { settle(p); return res; },
          redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
          end() { settle(undefined); return res; },
          header() { return res; }, set() { return res; }, cookie() { return res; },
          type(t: string) { headers["content-type"] = t; return res; },
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

    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      for (const k of RFB_ENV) delete process.env[k];
      for (const m of ["./owner-portal", "./owner-features"]) {
        try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
      }
      const featuresMod = require("./owner-features") as typeof import("./owner-features");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");

      const SEEDED = [OWNED_ID, UNVERIFIED_ID, OUTSIDE_ID, BROKEN_ID];
      for (const id of SEEDED) seedProducer(db, id, { verified: id !== UNVERIFIED_ID });
      const tokens: Record<string, string> = {};
      for (const id of SEEDED) {
        tokens[id] = `tok-${id}`;
        db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
          .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
      }
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = SEEDED.filter((id) => id !== OUTSIDE_ID).map((id) => `rfb:${id}`).join(",");
      process.env.OWNER_ORDER_EMAIL_ENABLED = "1";

      const H = {
        page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
        sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
        niva: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/niva", "post"),
        angre: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/angre", "post"),
        interesse: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/interesse", "post"),
      };
      const page = (id: string, query: Record<string, string> = {}, token: string | null = tokens[id]) =>
        invoke(H.page, makeReq({ params: { agentId: id }, query, token: token ?? undefined }));
      const html = async (id: string, query: Record<string, string> = {}) => String((await page(id, query)).body ?? "");
      const post = (h: Function, id: string, body: any, query: Record<string, string> = {}) => {
        featuresMod.__resetOwnerFeaturesRateLimitForTesting();
        return invoke(h, makeReq({ params: { agentId: id }, body, query, token: tokens[id] }));
      };
      const loc = (r: HandlerResult) => String(r.body?.__redirect ?? "");
      const queryOf = (l: string) => Object.fromEntries(new URLSearchParams(l.split("#")[0].split("?")[1] ?? ""));
      const writes = (id: string) => [
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_change_batch WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_interest WHERE subject_id = ?").get(id) as any).n,
        (db.prepare("SELECT order_notifications_opt_in AS v FROM agents WHERE id = ?").get(id) as any).v,
      ];

      const regionIds = ["statistikk", "niva", ...reg.OWNER_FEATURE_GROUPS.map((g) => `gruppe-${g.key}`), "planlagt", "endringslogg", "mv-toast-slot"];

      // ── f: fragments ──────────────────────────────────────────────────────
      const s1 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      const endret = (/endret=(\d+)/.exec(loc(s1)) || [])[1] || "";
      assertTrue(!!endret, `f00: a saved change to look at (${loc(s1)})`);
      const states: Array<Record<string, string>> = [
        {}, { endret }, { bekreft: "visibility.profile", verdi: "0" }, { niva: "utnytte_mulighetene" }, { melding: "ingen_endring", ved: "valg-orders.enabled" }, { side: "1" },
      ];
      const w0 = writes(OWNED_ID);
      let seen = 0;
      const mismatch: string[] = [];
      for (const q of states) {
        const full = await html(OWNED_ID, q);
        for (const id of regionIds) {
          const want = elementById(full, id);
          const r = await page(OWNED_ID, { ...q, fragment: id });
          const got = String(r.body ?? "");
          if (!want) { if (r.status !== 200 || got !== "") mismatch.push(`${JSON.stringify(q)} ${id}: absent region → ${r.status} ${got.slice(0, 40)}`); continue; }
          seen++;
          if (r.status !== 200 || got !== want || r.headers["x-mv-fragment"] !== id || r.headers["cache-control"] !== "no-store") {
            mismatch.push(`${JSON.stringify(q)} ${id}: ${r.status} same=${got === want} hdr=${r.headers["x-mv-fragment"]}`);
          }
        }
      }
      assertTrue(seen >= states.length * 5, `f01: regions checked (${seen})`);
      assertEq(mismatch, [], "f02: ?fragment=<id> answers with exactly that region's markup from the full page (same render), no-store, X-Mv-Fragment");
      const one = String((await page(OWNED_ID, { fragment: "gruppe-orders" })).body);
      assertTrue(!one.includes("<html") && !one.includes(`class="mv-page"`) && !one.includes("<script") && !one.includes("<style") && !one.includes(`id="niva"`) && !one.includes(`id="mv-status"`),
        "f03: only the region — no shell, no script, no style, no other region");
      const full0 = await html(OWNED_ID, { endret });
      const multi = await page(OWNED_ID, { endret, fragment: "niva,gruppe-orders,mv-toast-slot" });
      assertEq(String(multi.body), elementById(full0, "niva") + elementById(full0, "gruppe-orders") + elementById(full0, "mv-toast-slot"), "f04: several ids → those regions, in page order");
      for (const bad of ["velkommen", "niva,bogus", "__proto__", "valg-orders.enabled", "gruppe-nope", "niva-forhandsvis", `x"><script>`, "niva,,endringslogg"]) {
        const r = await page(OWNED_ID, { fragment: bad });
        assertTrue(r.status === 404 && !String(r.body).includes(`id="niva"`) && !String(r.body).includes(`<script>`), `f05: unknown fragment «${bad}» → 404, no region`);
      }
      const empty = await page(OWNED_ID, { fragment: "" });
      assertTrue(empty.status === 200 && String(empty.body).includes(`class="mv-page"`), "f06: an empty fragment= → the full page");
      assertEq((await page(OUTSIDE_ID, { fragment: "niva" })).status, 404, "f07: outside the allowlist → 404 (as the page)");
      assertEq((await page(OWNED_ID, { fragment: "niva" }, null)).status, 401, "f08: no session → 401");
      const other = await page(OWNED_ID, { fragment: "niva" }, tokens[BROKEN_ID]);
      assertTrue(other.status === 403 && !String(other.body).includes(`id="niva"`), "f10: another owner's session → 403, no region");
      assertEq(writes(OWNED_ID), w0, "f11: fragment GETs (incl. the level preview and confirm panel) write nothing");

      // ── p: the POST passes ?fragment= on to its 303 ─────────────────────
      const FR = "niva,gruppe-orders,endringslogg,mv-toast-slot";
      const p1 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" }, { fragment: FR });
      assertEq(loc(p1), `/eier/${OWNED_ID}/valg?melding=ingen_endring&fragment=${FR}&ved=valg-orders.enabled#valg-orders.enabled`, "p01: no change + fragment → 303 keeps the anchor and passes fragment= on");
      const p1b = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      assertEq(loc(p1b), `/eier/${OWNED_ID}/valg?melding=ingen_endring&ved=valg-orders.enabled#valg-orders.enabled`, "p02: without fragment= the Location is the T5 one, unchanged");
      const p2 = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "false", confirmed: "1" }, { fragment: FR });
      assertTrue(new RegExp(`^/eier/${OWNED_ID}/valg\\?endret=\\d+&fragment=${FR}#valg-orders\\.enabled$`).test(loc(p2)), `p03: saved + fragment → ?endret=<n>&fragment=…#row (${loc(p2)})`);
      const fq = queryOf(loc(p2));
      const fol = await page(OWNED_ID, fq);
      const fullP2 = await html(OWNED_ID, { endret: fq.endret });
      assertEq(String(fol.body), FR.split(",").map((id) => elementById(fullP2, id)).join(""), "p04: following that 303 gives only the asked regions");
      assertTrue(elementById(String(fol.body), "valg-orders.enabled").includes("mv-toast"), "p05: …with the message in the row (the script mirrors it into #mv-status)");
      for (const junk of [`niva"><script>`, "a".repeat(400), "niva,valg-x"]) {
        const pj = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "false", confirmed: "1" }, { fragment: junk });
        assertTrue(!loc(pj).includes("fragment=") && /#valg-orders\.enabled$/.test(loc(pj)), `p06: junk fragment= on a POST is dropped (${loc(pj).slice(0, 80)})`);
      }
      const pc = await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true" }, { fragment: FR });
      assertEq(loc(pc), `/eier/${OWNED_ID}/valg?bekreft=orders.enabled&verdi=1&fragment=${FR}#valg-orders.enabled`, "p07: confirm panel + fragment");
      const pn = await post(H.niva, OWNED_ID, { level: "utnytte_mulighetene" }, { fragment: "niva" });
      assertEq(loc(pn), `/eier/${OWNED_ID}/valg?niva=utnytte_mulighetene&fragment=niva#niva-forhandsvis`, "p08: level preview + fragment");
      const pu = await post(H.angre, OWNED_ID, { batch: "abc" }, { fragment: "endringslogg" });
      assertEq(loc(pu), `/eier/${OWNED_ID}/valg?melding=angre_umulig&fragment=endringslogg&ved=endringslogg#endringslogg`, "p09: undo + fragment");

      // ── s: the page ───────────────────────────────────────────────────────
      const handlerStates: Array<Record<string, string>> = [...states, { bekreft: "orders.enabled", verdi: "1" }, { melding: "feil", ved: "niva" }];
      const inline: string[] = [];
      for (const q of handlerStates) {
        const b = await html(OWNED_ID, q);
        const noScript = b.replace(/<script>[\s\S]*?<\/script>/g, "");
        const hit = /\son[a-z]+\s*=/i.exec(noScript);
        if (hit) inline.push(`${JSON.stringify(q)}: ${noScript.slice(Math.max(0, hit.index - 40), hit.index + 40)}`);
        if ((b.match(/id="mv-status"/g) || []).length !== 1) inline.push(`${JSON.stringify(q)}: #mv-status count`);
        if (b.split(en.OWNER_ENHANCE_SCRIPT).length !== 2) inline.push(`${JSON.stringify(q)}: script count`);
      }
      assertEq(inline, [], "s01: in every state: no on*= attribute, one #mv-status, the shared script exactly once");
      await post(H.sett, OWNED_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      const b0 = await html(OWNED_ID);
      assertTrue(mvPart(b0).includes(en.OWNER_STATUS_HTML), "s02: #mv-status (role=status, aria-live=polite) stands inside .mv-page");
      assertTrue(/<form method="post" action="[^"]+\/valg\/ordre-epost" class="mv-ctl-form" data-mv-row="gruppe-orders" data-mv-once="1">/.test(b0), "s03: the order address form is data-mv-once (never re-sent)");
      const pv = await html(OWNED_ID, { niva: "utnytte_mulighetene" });
      assertTrue(/<a class="ep-btn ep-btn-secondary" href="[^"]+#niva" data-mv-cancel="1">Avbryt<\/a>/.test(elementById(pv, "niva-forhandsvis")), "s04: «Avbryt» in the level preview closes on the client (data-mv-cancel)");
      assertTrue(/<form method="post" action="[^"]+\/valg\/niva" class="mv-ctl-form" data-mv-row="niva">/.test(elementById(pv, "niva-forhandsvis")), "s05: the level confirm form is captured (data-mv-row=niva)");
      const cpv = await html(OWNED_ID, { bekreft: "orders.enabled", verdi: "1" });
      assertTrue(/href="[^"]+#valg-orders\.enabled" data-mv-cancel="1">Avbryt<\/a>/.test(elementById(cpv, "valg-orders.enabled")), "s06: «Avbryt» in the switch panel closes on the client");
      assertTrue(/<a class="ep-btn ep-btn-secondary" href="[^"]+\?niva=[a-z_]+#niva-forhandsvis" data-mv-row="niva">/.test(elementById(b0, "niva")), "s07: the level links fetch #niva in place (data-mv-row=niva)");
      const ub = await html(OWNED_ID, { endret });
      assertTrue(/<form method="post" action="[^"]+\/valg\/angre" class="mv-ctl-form" data-mv="angre">/.test(ub) || !ub.includes("/valg/angre"), "s08: the undo form is captured (data-mv=angre)");

      // ── m: FUNN t5-testhull-advopen-catch ───────────────────────────────
      // No live entry is «advanced» today, so the page is rendered over the real
      // registry with one live switch marked advanced (the same renderer).
      const pg = require("../owner-features/page") as typeof import("../owner-features/page");
      const res = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const advEntry = reg.OWNER_FEATURE_REGISTRY.find((e) => e.type === "switch" && reg.ownerFeatureStatus(e) === "live" && !e.confirmOn && !e.confirmOff && !e.advanced)!;
      const advKey = advEntry.key;
      const advReg = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === advKey ? { ...e, advanced: true } : e));
      const model = (o: Record<string, unknown>) => ({
        agent: { id: OWNED_ID, name: "Stedgard" }, resolved: res.resolveOwnerFeatures("rfb", OWNED_ID), registry: advReg, level: null, showIntro: false,
        notice: null, noticeAt: null, confirm: null, levelPreview: null, log: { rows: [], page: 1, pages: 1, total: 0 }, ...o,
      }) as any;
      const grpOf = (b: string) => elementById(b, `gruppe-${advEntry.group}`);
      assertTrue(/<details class="mv-more"><summary>Flere valg/.test(grpOf(pg.renderOwnerFeaturesPageBody(model({})))), `m01: «Flere valg» (with ${advKey}) is closed without a message`);
      const withMsg = pg.renderOwnerFeaturesPageBody(model({ notice: { ok: true, text: "Lagret." }, noticeAt: `valg-${advKey}` }));
      assertTrue(/<details class="mv-more" open><summary>Flere valg/.test(grpOf(withMsg)) && elementById(withMsg, `valg-${advKey}`).includes("mv-toast"),
        "m02: a message in an advanced row opens «Flere valg» (advOpen)");
      const otherMsg = pg.renderOwnerFeaturesPageBody(model({ notice: { ok: true, text: "Lagret." }, noticeAt: "niva" }));
      assertTrue(/<details class="mv-more"><summary>Flere valg/.test(grpOf(otherMsg)), "m03: a message elsewhere leaves «Flere valg» closed");
      // A POST that throws after the checks → 303 «feil» at its anchor (not a 500 page).
      db.exec("ALTER TABLE owner_feature_change_batch RENAME TO owner_feature_change_batch_t9");
      try {
        const e1 = await post(H.sett, BROKEN_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
        assertEq([e1.status, loc(e1)], [303, `/eier/${BROKEN_ID}/valg?melding=feil&ved=valg-orders.enabled#valg-orders.enabled`], "m04: sett throws → 303 «Klarte ikke å lagre» at the row");
        const e2 = await post(H.niva, BROKEN_ID, { level: "utnytte_mulighetene", confirmed: "1" });
        assertEq([e2.status, loc(e2)], [303, `/eier/${BROKEN_ID}/valg?melding=feil&ved=niva#niva`], "m05: niva throws → 303 «feil» at #niva");
        const e3 = await post(H.angre, BROKEN_ID, { batch: "7" });
        assertTrue(e3.status === 303 && /melding=feil/.test(loc(e3)) && /#[a-z.-]+$/.test(loc(e3)), `m06: angre throws → 303 «feil» at an anchor (${loc(e3)})`);
      } finally {
        db.exec("ALTER TABLE owner_feature_change_batch_t9 RENAME TO owner_feature_change_batch");
      }
      const okAgain = await post(H.sett, BROKEN_ID, { key: "orders.enabled", value: "true", confirmed: "1" });
      assertTrue(/endret=\d+/.test(loc(okAgain)), "m07: (table back) the same POST saves");
    } catch (err: any) {
      failed++;
      failures.push("r: unexpected error: " + String(err?.stack || err));
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      for (const k of RFB_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
      try { (require("./owner-features") as typeof import("./owner-features")).__resetOwnerFeaturesRateLimitForTesting(); } catch { /* ignore */ }
      if (prevDb) initMod.__setDbForTesting(prevDb);
      try { db.close(); } catch { /* ignore */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // g — gårdssalg, over HTTP
  // ══════════════════════════════════════════════════════════════════════
  {
    const ENV_KEYS = ["EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "BOOKING_DISPATCH_ENABLED"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.OA_OWNER_FEATURES_ENABLED = "true";
    process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = "gardssalg:t9-g-test";
    delete process.env.BOOKING_DISPATCH_ENABLED;
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("./gardssalg-claim"),
      require.resolve("./gardssalg-owner-features"),
    ]);
    const servers: any[] = [];
    const { generalLimiter } = require("../middleware/security") as typeof import("../middleware/security");
    const LOOPBACK_KEY = "127.0.0.1";
    await generalLimiter.resetKey(LOOPBACK_KEY);
    const initMod = require("../database/init") as typeof import("../database/init");
    const prevRfbDb = initMod.__peekDbForTesting();
    const prevLog = console.log;
    if (!log) console.log = () => { /* */ };
    try {
      const rfbDb = new Database(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, hjemmeside, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider, claimed_at)
        VALUES ('t9-g-test', 'Stedgård Sideri', 't9-stedgard', 'experiences', '918500009', 1, 1, 'https://t9-stedgard.no', 'post@t9-stedgard.no',
          'claim', '["Eplesider"]', 'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 0, 1, datetime('now'))
      `).run();
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc_t9', 't9-g-test', 'eier@t9-stedgard.no', 'verified_domain_address', 'tok-t9g', 1, datetime('now'), datetime('now','+7 days'))`,
      ).run();
      const expressMod = require("express") as typeof import("express");
      const claimRouter = (require("./gardssalg-claim") as typeof import("./gardssalg-claim")).default;
      const ownerFeaturesRoutes = require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features");
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const app = expressMod();
      app.use("/", claimRouter);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const req = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
        new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
          const r = httpMod.request({ method, host: "127.0.0.1", port, path, headers }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => resolve({ status: resp.statusCode || 0, headers: resp.headers, body: Buffer.concat(chunks).toString("utf8") }));
          });
          r.on("error", reject);
          if (body) r.write(body);
          r.end();
        });
      const SLUG = "t9-stedgard";
      const P = (tail = "") => `/kategori/gardssalg/eier/${SLUG}/valg${tail}`;
      const auth = { Cookie: "oa_owner_session=tok-t9g" };
      const KEY = "booking.enabled";

      const full = (await req("GET", P(), auth)).body;
      assertTrue(full.includes(`class="mv-page"`) && full.split(en.OWNER_ENHANCE_SCRIPT).length === 2 && (full.match(/id="mv-status"/g) || []).length === 1,
        "g01: the gårdssalg page has the shared script once and one #mv-status");
      assertTrue(!/\son[a-z]+\s*=/i.test(full.replace(/<script>[\s\S]*?<\/script>/g, "")), "g02: no on*= attribute on the gårdssalg page");
      const ids = ["niva", ...reg.GARDSSALG_OWNER_FEATURE_GROUPS.map((g) => `gruppe-${g.key}`), "planlagt", "endringslogg", "mv-toast-slot"].filter((id) => elementById(full, id));
      const bad: string[] = [];
      for (const id of ids) {
        const r = await req("GET", P(`?fragment=${id}`), auth);
        if (r.status !== 200 || r.body !== elementById(full, id) || r.headers["x-mv-fragment"] !== id) bad.push(`${id}: ${r.status}`);
      }
      assertTrue(ids.length >= 4, `g03: regions on the gårdssalg page (${ids.length})`);
      assertEq(bad, [], "g04: ?fragment=<id> → exactly that region (same markup as the full page)");
      assertEq((await req("GET", P("?fragment=velkommen"), auth)).status, 404, "g05: unknown fragment → 404");
      assertEq((await req("GET", P("?fragment=niva"))).status, 401, "g06: no session → 401");
      const form = { "Content-Type": "application/x-www-form-urlencoded", ...auth };
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const p1 = await req("POST", P("/sett?fragment=niva,mv-toast-slot"), form, new URLSearchParams({ key: KEY, value: "true" }).toString());
      assertEq([p1.status, String(p1.headers.location)], [303, P(`?bekreft=${KEY}&verdi=1&fragment=niva,mv-toast-slot#valg-${KEY}`)], "g07: a gårdssalg POST passes fragment= on to its 303");
      ownerFeaturesRoutes.__resetGardssalgOwnerFeaturesRateLimitForTesting();
      const p2 = await req("POST", P("/sett"), form, new URLSearchParams({ key: KEY, value: "true" }).toString());
      assertEq(String(p2.headers.location), P(`?bekreft=${KEY}&verdi=1#valg-${KEY}`), "g08: …without it, the T5 Location");
    } catch (err: any) {
      failed++;
      failures.push("g: unexpected error: " + String(err?.stack || err));
    } finally {
      console.log = prevLog;
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      initMod.__setDbForTesting(prevRfbDb);
      try { (require("./gardssalg-owner-features") as typeof import("./gardssalg-owner-features")).__resetGardssalgOwnerFeaturesRateLimitForTesting(); } catch { /* ignore */ }
      try { await generalLimiter.resetKey(LOOPBACK_KEY); } catch { /* ignore */ }
      restoreModuleCache();
      for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    }
  }

  void anchors;
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesT9EnhanceTests({ log: true }).then((r) => {
    console.info(`\nowner-features-t9-enhance: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
