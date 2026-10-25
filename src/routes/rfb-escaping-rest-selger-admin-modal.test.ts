/**
 * rfb-escaping-rest-selger-admin-modal.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-M (FUNN
 * rfb-html-innsettinger-rest-etter-i-k: the I-K review's F1–F4).
 *
 * On main (3337c814) these places still put values into innerHTML as they
 * came: selger.html's stats tab (the page-view source, the conversation
 * channel and the contact-click kind), its trust breakdown (signal details and
 * tips) and its showAlert messages (the e-mail address the user typed, server
 * errors, err.message); admin.html's login alert (err.message); and the
 * producer modal on app and dashboard looked months up as `monthNames[m] || m`,
 * so the month "constructor" showed the source of Array. Now the stats lists
 * and the trust breakdown send every value through escHtml (a label is read
 * only off its table's own keys), the showAlert callers escape the values
 * they put in, the login alert is built with createElement and textContent,
 * and formatMonth() reads only the table's own months.
 *
 * Covers, with the pages' own inline scripts in node:vm and a small fake DOM
 * (tests/helpers/fake-page.ts), fed by the real GET /api/agents/:id/owner-stats
 * and GET /agents/:id/trust handlers on an in-memory DB where the server sends
 * the data:
 *   (a) stats tab: a channel or click kind stored with "<img …>", "\"><svg …>"
 *       or "<a href=javascript:…" (and a page-view source the server would
 *       pass on) is text; "constructor" is the key, not Object's source;
 *       well-formed stats are byte-identical to main's.
 *   (b) trust breakdown: details and tips with those values are text; the
 *       real breakdown of a well-formed agent is byte-identical to main's.
 *       Since S4-A1b (dev-request 2026-10-16-rfb-strukturerte-data-
 *       tredjepartsrating-og-places-treffvakt) a stored Google rating no
 *       longer reaches the community detail, so the odd values stored there
 *       must not show up at all.
 *   (c) showAlert with the e-mail: an address with those values is text and
 *       is sent as typed; a plain address gives main's HTML.
 *   (d) showAlert with server errors, err.message and the verification code,
 *       one per changed call: the value is text; the fallbacks (also the ones
 *       with entities) give main's HTML.
 *   (e) source scan: every showAlert message in selger.html is built only from
 *       string literals, t('…'), escHtml(…) or the page's own counter.
 *   (f) admin.html login alert: err.message is text, also a JSON parse error
 *       with "<!DOCTYPE"; a plain message gives main's HTML; a second failure
 *       replaces the first.
 *   (g) modal months on app and dashboard: "constructor", "length" and the
 *       like are text, never function source; payloads are text; month
 *       numbers and their text give what `monthNames[m] || m` gave.
 *
 * Exported runRfbEscapingRestSelgerAdminModalTests({log}) -> TestSummary;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/rfb-escaping-rest-selger-admin-modal.test.ts
 */

import Database from "better-sqlite3";
import * as vm from "vm";
import { decode, visibleText, injectionProblems, junk, inlineScript } from "../../tests/helpers/html-injection";
import { serializeText, jsonResponse, settle, runPage, type FetchStub, type Page } from "../../tests/helpers/fake-page";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const XSS = "<img src=x onerror=alert(1)>";
/** trust-score-service's community detail since S4-A1b (no stored Google rating in it). */
const COMMUNITY_DETAIL = "Ingen egne omtaler på Rett fra Bonden ennå – samme nøytrale verdi for alle";
const BREAK_DQ = "\"><svg onload=alert(2)>";
const JS_LINK = "<a href=javascript:alert(3)>klikk</a>";
const JS_OPEN = "<a href=javascript:alert(4) style=position:fixed;inset:0 x";
const BREAK_SQ = "' onmouseover='alert(5)";
const PAYLOADS = [XSS, BREAK_DQ, JS_LINK, JS_OPEN, BREAK_SQ];
/** Object.prototype members a lookup table must not answer for. */
const PROTO_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty"];

const ORIGIN = "https://rettfrabonden.com";
const API = `${ORIGIN}/api/marketplace`;

/** What escHtml gives (the serializer's & < > and no-break space, plus quotes). */
function escHtmlRef(s: string): string {
  return serializeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Runs `code` in the page's realm (its top-level let/const, such as selger's state). */
function inPage(page: Page, code: string): unknown {
  return vm.runInContext(code, page.context);
}

/** A fetch answered by `route` (url, request body parsed); anything it leaves gives 404. */
function stubFetch(route: (url: string, body: any) => unknown | Promise<unknown>): FetchStub {
  return async (url: string, opts?: { method?: string }) => {
    const o = (opts ?? {}) as { body?: string };
    const answer = await route(url, o.body ? JSON.parse(o.body) : undefined);
    return (answer as ReturnType<typeof jsonResponse>) ?? jsonResponse({ success: false }, 404);
  };
}

/** A fetch that rejects with `message` (a network error, or what the stub says). */
function failingFetch(message: string): FetchStub {
  return async () => { throw new Error(message); };
}

export async function runRfbEscapingRestSelgerAdminModalTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
  /** Runs one part; an error there fails that part, and the next part still runs. */
  async function section(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); }
    catch (err: any) {
      failed++;
      failures.push(`✗ ${name}: unexpected error: ${String(err?.stack || err?.message || err)}`);
      if (log) console.log(`  ✗ ${name}: unexpected error: ${String(err?.message || err)}`);
    }
  }

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = __peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  const origError = console.error;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    const { slugify } = require("../utils/slug") as typeof import("../utils/slug");

    // ══ fixture: a well-formed producer and one with odd stored values ══
    function seedAgent(id: string, name: string): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, 'Om oss', 'Produsent', ?, 'https://example.no', 'producer', ?,
          '["vegetables"]', '[]', '[]', '{}', '["no"]', 'Oslo', 59.91, 10.75,
          0.5, 1, 0, 0, 0, 0, 0, datetime('now'), datetime('now'))`,
      ).run(id, name, `${id}@example.no`, `key-${id}`);
      testDb.prepare(`INSERT INTO magic_links (id, email, token, agent_id, used, expires_at) VALUES (?, ?, ?, ?, 1, datetime('now', '+1 day'))`)
        .run(`ml-${id}`, `${id}@example.no`, `tok-${id}`, id);
    }
    const WF = "im-wf";
    const ODD = "im-odd";
    seedAgent(WF, "Gård Vest");
    seedAgent(ODD, "Gård Øst");

    const addConversations = (agentId: string, source: string | null, n: number) => {
      for (let i = 0; i < n; i++) {
        testDb.prepare("INSERT INTO conversations (id, seller_agent_id, source) VALUES (?, ?, ?)").run(`c-${agentId}-${source}-${i}`, agentId, source);
      }
    };
    const addClicks = (agentId: string, kind: string, n: number) => {
      for (let i = 0; i < n; i++) testDb.prepare("INSERT INTO contact_clicks (agent_id, kind, is_bot) VALUES (?, ?, 0)").run(agentId, kind);
    };
    let session = 0;
    const addViews = (agentId: string, name: string, source: string, n: number) => {
      for (let i = 0; i < n; i++) {
        testDb.prepare(
          "INSERT INTO analytics_page_views (path, source, session_id, status_code, client_class, created_at) VALUES (?, ?, ?, 200, 'human', datetime('now'))",
        ).run(`/produsent/${slugify(name)}`, source, `s-${agentId}-${session++}`);
      }
    };
    // Well-formed: every count distinct, so the server's ORDER BY count is the order.
    for (const [source, n] of [["web", 5], ["mcp", 4], ["a2a", 3], [null, 2], ["sms", 1]] as Array<[string | null, number]>) addConversations(WF, source, n);
    for (const [kind, n] of [["email", 4], ["phone", 3], ["website", 2], ["external:instagram", 1]] as Array<[string, number]>) addClicks(WF, kind, n);
    for (const [source, n] of [["direct", 4], ["organic", 3], ["search", 2], ["referral", 1], ["unknown", 1]] as Array<[string, number]>) addViews(WF, "Gård Vest", source, n);
    // Odd: today the code writes only known channels and kinds; these rows are
    // what the page gets if another value is ever stored.
    for (const p of [...PAYLOADS, "constructor", "toString"]) addConversations(ODD, p, 1);
    for (const p of [...PAYLOADS, "constructor"]) { addClicks(ODD, p, 1); addClicks(ODD, `external:${p}`, 1); }
    // A Google rating stored as text (REAL affinity keeps text that is not a number).
    testDb.prepare("INSERT INTO agent_knowledge (agent_id, google_rating, google_review_count) VALUES (?, ?, ?)").run(ODD, XSS, BREAK_DQ);
    testDb.prepare("INSERT INTO agent_knowledge (agent_id, google_rating, google_review_count) VALUES (?, 4.6, 12)").run(WF);
    testDb.prepare("INSERT INTO agent_metrics (agent_id, times_discovered, times_contacted) VALUES (?, 12, 3)").run(WF);

    // ══ the real handlers ════════════════════════════════════════════════
    function handler(router: any, path: string): (req: unknown, res: unknown) => unknown {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${path} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    async function call(h: (req: unknown, res: unknown) => unknown, req: Record<string, unknown>): Promise<{ status: number; body: any }> {
      const res: any = { statusCode: 200, body: undefined, headers: {} };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = (b: unknown) => { res.body = b; return res; };
      res.setHeader = (n: string, v: string) => { res.headers[n] = v; };
      console.log = () => {};
      console.error = () => {};
      try { await h({ query: {}, params: {}, headers: {}, ip: "127.0.0.1", ...req }, res); }
      finally { console.log = origLog; console.error = origError; }
      return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) };
    }
    const marketplace = require("./marketplace") as typeof import("./marketplace");
    const ownerPortal = require("./owner-portal") as typeof import("./owner-portal");
    const trustHandler = handler(marketplace.default as any, "/agents/:id/trust");
    const ownerStatsHandler = handler(ownerPortal.default as any, "/api/agents/:id/owner-stats");
    const ownerStats = (id: string) => call(ownerStatsHandler, { params: { id }, headers: { authorization: `Bearer tok-${id}` } });
    const trust = (id: string) => call(trustHandler, { params: { id } });

    const selgerScript = inlineScript("selger.html", "function escHtml");
    const adminScript = inlineScript("admin.html", "function showAdminAlert");
    const modalPages: Array<[string, string]> = [
      ["app", inlineScript("app.html", "function openAgentModal")],
      ["dashboard", inlineScript("dashboard.html", "function openAgentModal")],
    ];

    /** /selger after its own start-up, logged in as `agentId` (the page's state, no token). */
    async function selgerPage(fetchStub: FetchStub, opts: { agentId?: string; search?: string } = {}): Promise<Page> {
      const page = runPage(selgerScript, fetchStub, { pathname: "/selger", search: opts.search });
      await settle();
      if (opts.agentId) inPage(page, `state.agentId = ${JSON.stringify(opts.agentId)};`);
      return page;
    }
    const alertBox = (type: string, html: string) => `<div class="alert alert-${type}">${html}</div>`;

    // ══ (a) the stats tab ════════════════════════════════════════════════
    async function statsTab(id: string, edit?: (body: any) => void): Promise<{ views: string; channels: string; clicks: string }> {
      const page = await selgerPage(stubFetch(async (url) => {
        if (url === `${ORIGIN}/api/agents/${id}/owner-stats`) {
          const r = await ownerStats(id);
          if (edit) edit(r.body);
          return jsonResponse(r.body, r.status);
        }
        return undefined;
      }), { agentId: id });
      page.context.loadOwnerStats();
      await settle();
      return { views: page.el("statsViewsBySource").innerHTML, channels: page.el("statsChannels").innerHTML, clicks: page.el("statsContactClicks").innerHTML };
    }
    const STATS_TAGS = new Set(["div", "span", "li", "p"]);
    await section("a stats", async () => {
      const real = await ownerStats(ODD);
      assertEq(real.status, 200, "a fixture: the real owner-stats handler answers the owner's session");
      assertTrue(real.body.conversationsByChannel.some((c: any) => c.source === XSS) && real.body.contactClicksByKind.some((c: any) => c.kind === `external:${XSS}`),
        "a fixture: the handler returns the stored channel and kind as they are");

      // A page-view source the server would pass on (today it buckets unknown ones).
      const odd = await statsTab(ODD, (body) => { for (const p of [...PAYLOADS, ...PROTO_KEYS]) body.viewsBySource.totals[p] = 1; });
      for (const [list, html] of [["views by source", odd.views], ["channels", odd.channels], ["contact clicks", odd.clicks]] as const) {
        assertEq(injectionProblems(html, STATS_TAGS, []), [], `a ${list}: only the list's own tags, no on* attribute, no href`);
        for (const p of PAYLOADS) assertTrue(visibleText(html).includes(p), `a ${list}: ${JSON.stringify(p)} is shown as text`);
        assertTrue(!/native code|function \w*\(/.test(html), `a ${list}: no function source for a key such as "constructor"`);
        assertEq(junk(html), [], `a ${list}: no junk text`);
      }
      for (const p of PAYLOADS) assertTrue(visibleText(odd.clicks).includes(`Ekstern lenke (${p})`), `a contact clicks: external:${JSON.stringify(p)} reads «Ekstern lenke (…)» with the value as text`);
      assertTrue(odd.channels.includes("<span class=\"product-name\">constructor</span>") && odd.channels.includes("<span class=\"product-name\">toString</span>"),
        "a channels: \"constructor\" and \"toString\" are shown as the key they are");
      assertTrue(odd.clicks.includes("<span class=\"product-name\">constructor</span>"), "a contact clicks: \"constructor\" is shown as the key it is");
      for (const k of PROTO_KEYS) assertTrue(odd.views.includes(`<span>${k}</span>`), `a views by source: "${k}" is shown as the key it is`);

      // Well-formed: the real stats of WF, byte-identical to main's.
      const wf = await statsTab(WF);
      const viewRow = (label: string, count: number, pct: number) =>
        `<div><div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:2px;"><span>${label}</span><span>${count}</span></div>` +
        `<div class="completion-bar-track"><div class="completion-bar-fill" style="width:${pct}%"></div></div></div>`;
      assertEq(wf.views, viewRow("Direkte", 4, 100) + viewRow("Organisk", 3, 75) + viewRow("Søk", 2, 50) + viewRow("Sosiale medier", 0, 0) +
        viewRow("Henvisning", 1, 25) + viewRow("Ukjent", 1, 25), "a well-formed views by source: byte-identical to main's");
      const item = (label: string, count: number) => `<li class="product-item"><span class="product-name">${label}</span><span class="product-meta">${count}</span></li>`;
      assertEq(wf.channels, item("Nettside", 5) + item("MCP", 4) + item("A2A", 3) + item("API/annet", 2) + item("sms", 1),
        "a well-formed channels: byte-identical to main's (an unknown channel shows its key)");
      assertEq(wf.clicks, item("E-post", 4) + item("Telefon", 3) + item("Nettside", 2) + item("Ekstern lenke (instagram)", 1),
        "a well-formed contact clicks: byte-identical to main's");
      // Empty lists keep main's text.
      const none = await statsTab(WF, (body) => { body.conversationsByChannel = []; body.contactClicksByKind = []; body.viewsBySource.totals = {}; });
      assertEq([none.views, none.channels, none.clicks], [
        "<p style=\"color:var(--gray-500);font-size:0.9rem;\">Ingen visninger registrert enn&aring;.</p>",
        "<li style=\"text-align:center;color:var(--gray-500);padding:1rem;\">Ingen samtaler registrert enn&aring;.</li>",
        "<li style=\"text-align:center;color:var(--gray-500);padding:1rem;\">Ingen kontakt-klikk registrert enn&aring;.</li>",
      ], "a empty stats: main's texts");
      // A kind with no value reads «Ukjent», as before.
      const blank = await statsTab(WF, (body) => { body.contactClicksByKind = [{ kind: "", count: 1 }, { kind: null, count: 2 }]; });
      assertEq(blank.clicks, item("Ukjent", 1) + item("Ukjent", 2), "a contact clicks: an empty kind reads «Ukjent» as before");
    });

    // ══ (b) the trust breakdown ══════════════════════════════════════════
    async function trustBreakdown(id: string, body?: unknown): Promise<{ signals: string; tips: string }> {
      const page = await selgerPage(stubFetch(async (url) => {
        if (url !== `${API}/agents/${id}/trust`) return undefined;
        if (body) return jsonResponse(body);
        const r = await trust(id);
        return jsonResponse(r.body, r.status);
      }), { agentId: id });
      page.context.loadTrustBreakdown();
      await settle();
      return { signals: page.el("trustSignals").innerHTML, tips: page.el("trustTips").innerHTML };
    }
    const KEYS = ["verification", "completeness", "freshness", "interaction", "community"];
    const META: Record<string, [string, string]> = {
      verification: ["🔒", "Verifisering"], completeness: ["📝", "Profil-komplettering"], freshness: ["⚡", "Aktivitet/ferskhet"],
      interaction: ["👥", "Interaksjoner"], community: ["⭐", "Fellesskap"],
    };
    /** Main's markup for the breakdown of `data`, with each detail and tip put in as it is. */
    function mainTrust(data: any): { signals: string; tips: string } {
      const signals = KEYS.map((key) => {
        const s = data.signals[key];
        const pct = Math.round(s.value * 100);
        const bar = pct >= 80 ? "var(--green)" : pct >= 50 ? "var(--orange)" : "var(--red)";
        return "<div style=\"background:var(--gray-50);border-radius:var(--radius);padding:0.75rem;\">" +
          "<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;\">" +
          `<span style="font-weight:500;">${META[key]![0]} ${META[key]![1]} <span style="color:var(--gray-500);font-size:0.8rem;">(${Math.round(s.weight * 100)}% vekt)</span></span>` +
          `<span style="font-weight:700;color:${bar};">${pct}%</span></div>` +
          "<div style=\"background:var(--gray-200);border-radius:99px;height:8px;overflow:hidden;\">" +
          `<div style="background:${bar};height:100%;width:${pct}%;border-radius:99px;transition:width 0.5s;"></div></div>` +
          `<div style="font-size:0.75rem;color:var(--gray-500);margin-top:2px;">${s.detail}</div></div>`;
      }).join("");
      const tips = data.tips.length
        ? "<div style=\"background:var(--blue-light);border:1px solid #bfdbfe;border-radius:var(--radius);padding:0.75rem;\">" +
          "<div style=\"font-weight:600;margin-bottom:0.5rem;\">💡 Tips for å øke din score:</div>" +
          data.tips.map((t: string) => `<div style="font-size:0.85rem;padding:2px 0;">• ${t}</div>`).join("") + "</div>"
        : "<div style=\"background:var(--green-light);border:1px solid #bbf7d0;border-radius:var(--radius);padding:0.75rem;font-weight:500;\">🎉 Flott! Profilen din ser komplett ut.</div>";
      return { signals, tips };
    }
    await section("b trust", async () => {
      const realOdd = await trust(ODD);
      assertEq(realOdd.body.data?.signals?.community?.detail, COMMUNITY_DETAIL, "b fixture: the real breakdown no longer puts the stored rating into the detail (S4-A1b)");
      const odd = await trustBreakdown(ODD);
      assertEq(injectionProblems(odd.signals, new Set(["div", "span"]), []), [], "b stored rating: the signals have only their own tags, no on* attribute");
      assertTrue(visibleText(odd.signals).includes(COMMUNITY_DETAIL) && !visibleText(odd.signals).includes(XSS) && !visibleText(odd.signals).includes(BREAK_DQ),
        "b stored rating: the community detail is the fixed text, without the stored values");

      const real = await trust(WF);
      const crafted = JSON.parse(JSON.stringify(real.body));
      KEYS.forEach((k, i) => { crafted.data.signals[k].detail = `Detalj ${PAYLOADS[i]}`; });
      crafted.data.tips = PAYLOADS.map((p) => `Tips ${p}`);
      const c = await trustBreakdown(WF, crafted);
      assertEq(injectionProblems(c.signals + c.tips, new Set(["div", "span"]), []), [], "b details and tips: only their own tags, no on* attribute, no href");
      for (const p of PAYLOADS) {
        assertTrue(visibleText(c.signals).includes(`Detalj ${p}`), `b details: ${JSON.stringify(p)} is shown as text`);
        assertTrue(visibleText(c.tips).includes(`• Tips ${p}`), `b tips: ${JSON.stringify(p)} is shown as text`);
      }

      // Well-formed: the real breakdown, byte-identical to main's.
      assertTrue(real.body.success === true && real.body.data.tips.length > 0, "b fixture: the real breakdown of WF has tips");
      assertEq(real.body.data.signals.community.detail, COMMUNITY_DETAIL, "b fixture: WF's community detail (no Google 4.6/12 since S4-A1b)");
      assertEq(await trustBreakdown(WF), mainTrust(real.body.data), "b well-formed: the real breakdown is byte-identical to main's (signals and tips)");
      const noTips = JSON.parse(JSON.stringify(real.body));
      noTips.data.tips = [];
      assertEq((await trustBreakdown(WF, noTips)).tips, mainTrust(noTips.data).tips, "b well-formed: no tips gives main's «Flott!» box");
    });

    // ══ (c) showAlert with the e-mail the user typed ═════════════════════
    await section("c magic-link e-mail", async () => {
      for (const email of [...PAYLOADS.map((p) => `ola${p}@example.no`), "ola@example.no", "Ola.Nordmann+gård@example.no"]) {
        const sent: unknown[] = [];
        const page = await selgerPage(stubFetch((url, body) => {
          if (url === `${API}/auth/magic-link`) { sent.push(body); return jsonResponse({ success: true }); }
          return undefined;
        }));
        page.el("loginEmail").value = email;
        page.el("btnMagicLink").click();
        await settle();
        const html = page.el("magicLinkAlert").innerHTML;
        assertEq(sent, [{ email }], `c ${JSON.stringify(email)}: the address is sent as typed`);
        assertEq(html, alertBox("success", `Sjekk innboksen din! Vi har sendt en innloggingslenke til ${escHtmlRef(email)}.`),
          `c ${JSON.stringify(email)}: the address is escaped in the alert`);
        assertEq(injectionProblems(html, new Set(["div"]), []), [], `c ${JSON.stringify(email)}: the alert has only its own div`);
        assertEq(decode(html.replace(/<[^>]*>/g, "")), `Sjekk innboksen din! Vi har sendt en innloggingslenke til ${email}.`, `c ${JSON.stringify(email)}: the alert reads the address as typed`);
      }
      const page = await selgerPage(stubFetch((url) => (url === `${API}/auth/magic-link` ? jsonResponse({ success: true }) : undefined)));
      page.el("loginEmail").value = "ola@example.no";
      page.el("btnMagicLink").click();
      await settle();
      assertEq(page.el("magicLinkAlert").innerHTML, "<div class=\"alert alert-success\">Sjekk innboksen din! Vi har sendt en innloggingslenke til ola@example.no.</div>",
        "c plain address: main's HTML");
    });

    // ══ (d) showAlert with server errors, err.message and the code ═══════
    /**
     * The alert `alertId` after `act` on a /selger page whose fetch is `fetchStub`.
     * Each case is one changed call; `value` is what the server or the error said.
     */
    async function alertAfter(alertId: string, fetchStub: FetchStub, act: (page: Page) => void | Promise<void>, opts: { agentId?: string; search?: string } = {}): Promise<{ html: string; page: Page }> {
      const page = await selgerPage(fetchStub, opts);
      await act(page);
      await settle();
      return { html: page.el(alertId).innerHTML, page };
    }
    const requestClaim = (page: Page) => {
      page.context.startClaim({ id: "im-c", name: "Gård", description: "" });
      page.el("claimName").value = "Ola";
      page.el("claimEmail").value = "ola@example.no";
      page.el("btnRequestClaim").click();
    };
    const verifyClaim = (page: Page) => {
      page.context.startClaim({ id: "im-c", name: "Gård", description: "" });
      page.el("verifyCode").value = "123456";
      page.el("btnVerifyClaim").click();
    };
    const statsMagicLink = (page: Page) => { page.el("statsLoginEmail").value = "ola@example.no"; page.el("btnStatsMagicLink").click(); };
    const ordersMagicLink = (page: Page) => { page.el("ordersLoginEmail").value = "ola@example.no"; page.el("btnOrdersMagicLink").click(); };
    const saveProfile = (page: Page) => { page.el("btnSaveProfile").click(); };
    const saveHours = (page: Page) => { page.el("btnSaveHours").click(); };
    const saveProducts = (page: Page) => { page.context.saveProducts(); };
    const setAvailability = (page: Page) => { page.context.setProductAvailability("p1", "in_stock", null); };
    const register = (page: Page) => {
      page.el("regName").value = "Ny gård";
      page.el("regDescription").value = "Grønnsaker fra gården";
      page.el("regEmail").value = "ola@example.no";
      const doc = page.context.document;
      const qsa = doc.querySelectorAll;
      doc.querySelectorAll = (sel: string) => (sel.includes("regCategories") ? [{ checked: true, value: "vegetables" }] : qsa(sel));
      page.el("btnRegister").click();
    };
    /** Answers `path` (under the API or the origin) with `body`; a POST to /claim/verify fails quietly. */
    const answer = (path: string, body: unknown, status = 200): FetchStub => stubFetch((url) => {
      if (url === `${API}${path}` || url === `${ORIGIN}${path}` || url.startsWith(`${API}${path}?`)) return jsonResponse(body, status);
      if (url.endsWith("/claim/verify")) return jsonResponse({ success: false });
      return undefined;
    });
    interface Case {
      name: string;
      alertId: string;
      act: (page: Page) => void | Promise<void>;
      /** The fetch for a value: the server's error, or a rejected fetch. */
      fetchFor: (value: string) => FetchStub;
      /** The alert for a value, as main built it with the value put in as text. */
      expect: (valueHtml: string) => string;
      agentId?: string;
      search?: string;
      /** A fetch with no value, and main's alert for it (the fallback). */
      fallback?: [FetchStub, string];
    }
    const cases: Case[] = [
      { name: "claim res.error", alertId: "claimAlert", act: requestClaim, fetchFor: (v) => answer("/agents/im-c/claim", { success: false, error: v }),
        expect: (v) => alertBox("error", v), fallback: [answer("/agents/im-c/claim", { success: false }), alertBox("error", "Kunne ikke gjøre krav. Prøv igjen.")] },
      { name: "claim err.message", alertId: "claimAlert", act: requestClaim, fetchFor: failingFetch, expect: (v) => alertBox("error", v) },
      { name: "verification code", alertId: "verifyAlert", act: requestClaim,
        fetchFor: (v) => answer("/agents/im-c/claim", { success: true, data: { claimId: "cl-1", verificationCode: v } }),
        expect: (v) => alertBox("info", `Koden din er: <strong>${v}</strong> (e-post er ikke satt opp ennå)`),
        fallback: [answer("/agents/im-c/claim", { success: true, data: { claimId: "cl-1", verificationCode: "123456" } }),
          alertBox("info", "Koden din er: <strong>123456</strong> (e-post er ikke satt opp ennå)")] },
      { name: "verify res.error", alertId: "verifyAlert", act: verifyClaim, fetchFor: (v) => stubFetch((url) => (url.endsWith("/claim/verify") ? jsonResponse({ success: false, error: v }) : undefined)),
        expect: (v) => alertBox("error", v),
        fallback: [stubFetch((url) => (url.endsWith("/claim/verify") ? jsonResponse({ success: false }) : undefined)), alertBox("error", "Ugyldig kode. Prøv igjen.")] },
      { name: "verify err.message", alertId: "verifyAlert", act: verifyClaim, fetchFor: failingFetch, expect: (v) => alertBox("error", v) },
      { name: "magic-verify data.error", alertId: "magicLinkAlert", act: () => {}, search: "?magic=tok-1",
        fetchFor: (v) => answer("/auth/magic-verify", { success: false, error: v }), expect: (v) => alertBox("error", v),
        fallback: [answer("/auth/magic-verify", { success: false }), alertBox("error", "Innloggingslenken er ugyldig eller utløpt. Be om en ny.")] },
      { name: "availability res.error", alertId: "dashAlert", act: setAvailability, agentId: WF,
        fetchFor: (v) => answer(`/agents/${WF}/products/p1/availability`, { success: false, error: v }), expect: (v) => alertBox("error", v),
        fallback: [answer(`/agents/${WF}/products/p1/availability`, { success: false }), alertBox("error", "Kunne ikke lagre tilgjengelighet")] },
      { name: "stats magic-link message", alertId: "statsLoginAlert", act: statsMagicLink, agentId: WF,
        fetchFor: (v) => answer(`/api/agents/${WF}/request-magic-link`, { success: false, message: v }, 400), expect: (v) => alertBox("error", v),
        fallback: [answer(`/api/agents/${WF}/request-magic-link`, { success: false }, 500), alertBox("error", "Kunne ikke sende lenke. Pr&oslash;v igjen.")] },
      { name: "orders magic-link message", alertId: "ordersLoginAlert", act: ordersMagicLink, agentId: WF,
        fetchFor: (v) => answer(`/api/agents/${WF}/request-magic-link`, { success: false, message: v }, 400), expect: (v) => alertBox("error", v),
        fallback: [answer(`/api/agents/${WF}/request-magic-link`, { success: false }, 500), alertBox("error", "Kunne ikke sende lenke. Pr&oslash;v igjen.")] },
      { name: "profile res.error", alertId: "dashAlert", act: saveProfile, agentId: WF,
        fetchFor: (v) => answer(`/agents/${WF}/knowledge`, { success: false, error: v }), expect: (v) => alertBox("error", v),
        fallback: [answer(`/agents/${WF}/knowledge`, { success: false }), alertBox("error", "Error")] },
      { name: "profile err.message", alertId: "dashAlert", act: saveProfile, agentId: WF, fetchFor: failingFetch, expect: (v) => alertBox("error", v) },
      { name: "products err.message", alertId: "dashAlert", act: saveProducts, agentId: WF, fetchFor: failingFetch, expect: (v) => alertBox("error", v) },
      { name: "hours err.message", alertId: "dashAlert", act: saveHours, agentId: WF, fetchFor: failingFetch, expect: (v) => alertBox("error", v) },
      { name: "register errMsg", alertId: "regAlert", act: register,
        fetchFor: (v) => answer("/register", { success: false, error: v, details: [{ path: ["name"], message: v }] }),
        expect: (v) => alertBox("error", `${v} (name: ${v})`),
        fallback: [answer("/register", { success: false, error: "Valideringsfeil", details: [{ path: ["description"], message: "String must contain at least 10 character(s)" }] }),
          alertBox("error", "Valideringsfeil (description: String must contain at least 10 character(s))")] },
    ];
    await section("d alerts", async () => {
      for (const c of cases) {
        for (const p of PAYLOADS) {
          const { html } = await alertAfter(c.alertId, c.fetchFor(p), c.act, c);
          assertEq(html, c.expect(escHtmlRef(p)), `d ${c.name}: ${JSON.stringify(p)} is escaped in the alert`);
          assertEq(injectionProblems(html, new Set(["div", "strong"]), []), [], `d ${c.name}: ${JSON.stringify(p)} adds no tag or attribute`);
        }
        // A plain value (a server's Norwegian message) gives main's HTML.
        const plain = "Den e-posten er ikke registrert for denne produsenten.";
        assertEq((await alertAfter(c.alertId, c.fetchFor(plain), c.act, c)).html, c.expect(plain), `d ${c.name}: a plain message gives main's HTML`);
        if (c.fallback) {
          assertEq((await alertAfter(c.alertId, c.fallback[0], c.act, c)).html, c.fallback[1], `d ${c.name}: the fallback gives main's HTML`);
        }
      }
      // The verification code still fills the code field as sent (logic unchanged).
      const { page } = await alertAfter("verifyAlert", cases[2]!.fetchFor("654321"), requestClaim);
      assertEq(page.el("verifyCode").value, "654321", "d verification code: the code field gets the code as sent");
      // A JSON parse error (an HTML error page) is text, not markup.
      const htmlPage: FetchStub = async () => ({ ok: false, status: 502, json: async () => JSON.parse("<!DOCTYPE html><title>502</title>") });
      const parsed = await alertAfter("dashAlert", htmlPage, saveProfile, { agentId: WF });
      assertEq(injectionProblems(parsed.html, new Set(["div"]), []), [], "d profile: a JSON parse error of an HTML page adds no tag");
      assertTrue(decode(parsed.html.replace(/<[^>]*>/g, "")).includes("<!DOCTYPE"), "d profile: the parse error is shown as text");
    });

    // ══ (e) source scan: what every showAlert message is built from ══════
    await section("e source scan", async () => {
      const calls = showAlertMessages(selgerScript);
      const total = (selgerScript.match(/\bshowAlert\(/g) ?? []).length - 1; // minus the definition
      assertEq(calls.length, total, `e scan: every showAlert call is read (${total})`);
      const bad = calls.flatMap((c) => c.operands.filter((o) => !safeOperand(o)).map((o) => `line ${c.line}: ${o}`));
      assertEq(bad, [], "e scan: every showAlert message is string literals, t('…'), escHtml(…) or the page's own counter");
      // The scanner itself: it flags what main had.
      assertEq(showAlertMessages("showAlert('a', 'Hei ' + email + '.', 'x'); showAlert('b', (res && res.error) || 'Feil', 'x'); showAlert('c', escHtml(e.message) + x, 'x');")
        .flatMap((c) => c.operands.filter((o) => !safeOperand(o))), ["email", "(res && res.error)", "x"], "e scan: a raw value is flagged (self-check)");
    });

    // ══ (f) admin.html: the login alert ═════════════════════════════════
    await section("f admin login", async () => {
      async function login(page: Page): Promise<string> {
        page.el("adminKey").value = "test-key";
        page.el("btnLogin").click();
        await settle();
        return page.el("loginAlert").innerHTML;
      }
      for (const p of PAYLOADS) {
        const html = await login(runPage(adminScript, failingFetch(p), { pathname: "/admin" }));
        assertEq(html, alertBox("error", `Feil: ${serializeText(p)}`), `f ${JSON.stringify(p)}: the error is text in the login alert`);
        assertEq(injectionProblems(html, new Set(["div"]), []), [], `f ${JSON.stringify(p)}: the login alert has only its own div`);
      }
      assertEq(await login(runPage(adminScript, failingFetch("Failed to fetch"), { pathname: "/admin" })),
        "<div class=\"alert alert-error\">Feil: Failed to fetch</div>", "f plain message: main's HTML");
      {
        const htmlPage: FetchStub = async () => ({ ok: false, status: 502, json: async () => JSON.parse("<!DOCTYPE html><title>502</title>") });
        const html = await login(runPage(adminScript, htmlPage, { pathname: "/admin" }));
        assertEq(injectionProblems(html, new Set(["div"]), []), [], "f JSON parse error of an HTML page: no tag from it");
        assertTrue(decode(html.replace(/<[^>]*>/g, "")).startsWith("Feil: ") && html.includes("&lt;!DOCTYPE"), "f JSON parse error: shown as text");
      }
      {
        let message = "Første feil";
        const page = runPage(adminScript, async () => { throw new Error(message); }, { pathname: "/admin" });
        await login(page);
        message = "Andre feil";
        assertEq(await login(page), "<div class=\"alert alert-error\">Feil: Andre feil</div>", "f a second failure replaces the first (one box, as before)");
      }
      {
        const page = runPage(adminScript, async () => jsonResponse({ success: true, agents: [] }), { pathname: "/admin" });
        assertEq(await login(page), "", "f a working login shows no alert");
      }
    });

    // ══ (g) the modal's months on app and dashboard ═════════════════════
    async function modalBody(script: string, products: unknown[]): Promise<string> {
      const agent = { id: "m", name: "Gård", role: "producer", categories: [], skills: [], isVerified: false, isClaimed: false, location: { city: "Oslo" } };
      const page = runPage(script, stubFetch((url) => (url.endsWith("/info") ? jsonResponse({ success: true, data: { agent: {}, meta: {}, knowledge: { products } } }) : undefined)), { pathname: "/app" });
      page.context.allAgents = [agent];
      await page.context.openAgentModal(agent.id);
      return page.el("modalBody").innerHTML;
    }
    const meta = (text: string) => `<span class="modal-product-meta">${text}</span>`;
    const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Des"];
    await section("g months", async () => {
      for (const [name, script] of modalPages) {
        const keys = ["constructor", "length", "__proto__", "toString", "valueOf", "hasOwnProperty", "map"];
        const proto = await modalBody(script, [{ name: "Epler", seasonal: true, months: keys }]);
        assertTrue(proto.includes(meta(keys.join("-"))), `g ${name}: "constructor", "length" and the like are shown as the text they are`);
        assertTrue(!/native code|function \w*\(/.test(proto), `g ${name}: no function source for a month`);
        assertEq(junk(proto), [], `g ${name}: no junk text`);

        const payloads = await modalBody(script, [{ name: "Epler", seasonal: true, months: [...PAYLOADS, 6] }]);
        const metaHtml = /<span class="modal-product-meta">([^]*?)<\/span>/.exec(payloads)?.[1] ?? "";
        assertEq(injectionProblems(metaHtml, new Set(), []), [], `g ${name}: months with markup add no tag or attribute`);
        assertEq(decode(metaHtml), `${PAYLOADS.join("-")}-Jun`, `g ${name}: months with markup are shown as text`);

        // Month numbers and their text: what `monthNames[m] || m` gave.
        assertTrue((await modalBody(script, [{ name: "Jordbær", seasonal: true, months: [6, 7, 8] }])).includes(meta("Jun-Jul-Aug")), `g ${name}: [6, 7, 8] reads Jun-Jul-Aug`);
        assertTrue((await modalBody(script, [{ name: "Jordbær", seasonal: true, months: ["6", "7"] }])).includes(meta("Jun-Jul")), `g ${name}: ["6", "7"] reads Jun-Jul`);
        assertTrue((await modalBody(script, [{ name: "Epler", seasonal: true, months: [1, "2", 12, 0, 13, "03", -1] }])).includes(meta("Jan-Feb-Des-0-13-03--1")),
          `g ${name}: other numbers and texts are shown as they are, as before`);

        const page = runPage(script, stubFetch(() => undefined), { pathname: "/app" });
        const formatMonth = page.context.formatMonth as (m: unknown) => unknown;
        const values: unknown[] = [];
        for (let i = -1; i <= 13; i++) values.push(i, String(i));
        values.push("01", "1.0", 1.5, "", "Mai", "jun", " 3");
        const mainLookup = (m: any) => (MONTHS as any)[m] || m;
        assertEq(values.map((v) => formatMonth(v)), values.map(mainLookup), `g ${name}: formatMonth() gives what monthNames[m] || m gave for numbers and text`);
        assertEq(keys.map((k) => formatMonth(k)), keys, `g ${name}: formatMonth() maps only the table's own months`);
      }
    });
  } catch (err: any) {
    failed++;
    failures.push("rfb-escaping-rest-selger-admin-modal: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = origLog;
    console.error = origError;
    if (prevDb) __setDbForTesting(prevDb as any);
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    testDb.close();
  }

  return { passed, failed, failures };
}

// ─── Source scan: the message argument of every showAlert call ─────────

interface AlertCall { line: number; operands: string[] }

/**
 * Each showAlert(...) call in `src` (not the definition) with its message
 * (the second argument) split at its top-level + and || into operands. Reads
 * string literals, so a "," "+" or "(" inside one does not count.
 */
function showAlertMessages(src: string): AlertCall[] {
  const calls: AlertCall[] = [];
  const re = /\bshowAlert\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let start = m.index + m[0].length;
    let i = start;
    for (; i < src.length; i++) {
      const ch = src[i]!;
      if (ch === "'" || ch === "\"" || ch === "`") { i = skipString(src, i); continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) { args.push(src.slice(start, i)); break; }
        depth--;
      } else if (ch === "," && depth === 0) { args.push(src.slice(start, i)); start = i + 1; }
    }
    calls.push({ line: src.slice(0, m.index).split("\n").length, operands: splitOperands(args[1] ?? "") });
  }
  return calls;
}

/** The index of the closing quote of the string literal that starts at `i`. */
function skipString(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === q) return j;
  }
  return src.length;
}

/** `expr` split at its top-level + and ||, each part trimmed. */
function splitOperands(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === "'" || ch === "\"" || ch === "`") { i = skipString(expr, i); continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && (ch === "+" || (ch === "|" && expr[i + 1] === "|"))) {
      parts.push(expr.slice(start, i).trim());
      if (ch === "|") i++;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

/**
 * A part a message may be built from: a string literal, t('key'), one whole
 * escHtml(...) call, or `changes` (the number of fields quick-fill set).
 */
function safeOperand(op: string): boolean {
  if (/^'(?:[^'\\]|\\.)*'$/.test(op) || /^"(?:[^"\\]|\\.)*"$/.test(op)) return true;
  if (/^t\('[a-z_]+'\)$/.test(op)) return true;
  if (op === "changes") return true;
  if (!op.startsWith("escHtml(")) return false;
  // The call's own closing parenthesis must end the operand (not escHtml(a).slice(1)).
  let depth = 0;
  for (let i = "escHtml".length; i < op.length; i++) {
    const ch = op[i]!;
    if (ch === "'" || ch === "\"" || ch === "`") { i = skipString(op, i); continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i === op.length - 1;
  }
  return false;
}

if (require.main === module) {
  runRfbEscapingRestSelgerAdminModalTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
