/**
 * ai-profile-links.test.ts — dev-request 2026-10-14-klikk-fra-ai-svar-per-profil,
 * slice 3 («Merking»): profile links we hand AI clients carry
 * utm_source=<client>&utm_medium=mcp|a2a|api&utm_campaign=ai_search, at the
 * transport boundary only.
 *
 * Covers:
 *   (a) addAiUtmParams: mcp default, a2a / api medium, client → utm_source,
 *       never overwrites an existing utm_source; detectAiClient /
 *       aiClientFromHeaders.
 *   (b) tagAiProfileLinks: profile paths on the three sites (also /en, and
 *       markdown / JSON text / nested fields) are tagged; other URLs (Stripe,
 *       producer websites, vCard, terms, sub-pages, foreign hosts),
 *       canonical* fields and JSON-LD are not; the input is not changed.
 *   (c) withRequestQuery: keeps the query, never builds "//host".
 *   (d) double utm_source (ours + ChatGPT's «chatgpt.com», either order): AI,
 *       attributed to ours.
 *   (e) rfb MCP: lokal_find_offers, lokal_cart_submit and lokal_order_status
 *       return tagged profile links; findOffers / the shared contact builder
 *       stay untagged.
 *   (f) rfb REST: /api/marketplace/catalog/offers is tagged (utm_medium=api)
 *       for ChatGPT-User only; a person / Googlebot get it untagged.
 *   (g) dental: tannlege_search (MCP), /api/tannlege/discover for ChatGPT-User
 *       (REST) and POST /a2a (A2A) are tagged; clinicProfileUrl, the clinic
 *       page's canonical / JSON-LD and the sitemap are not.
 *   (h) experiences: discover_experiences (text + structuredContent, which the
 *       ChatGPT widget reads) and discover_gardssalg (MCP), POST /a2a (A2A) are
 *       tagged.
 *   (i) 301s keep the query: rfb slug alias, experiences /tilbyder/<uuid> and
 *       the dedup /opplevelse/<old>.
 *   (j) mounts: the three A2A routers and the REST mount in index.ts.
 *
 * Exported runAiProfileLinksTests({log}) -> Promise<TestSummary>; wired into
 * tests/test.ts. Standalone: npx tsx src/middleware/ai-profile-links.test.ts
 */

import Database from "better-sqlite3";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const OSLO = { lat: 59.9289, lng: 10.7522 };
const TAG = (source: string, medium: string) => `utm_source=${source}&utm_medium=${medium}&utm_campaign=ai_search`;

export async function runAiProfileLinksTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq<T>(actual: T, expected: T, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const utm = require("../utils/url-utm") as typeof import("../utils/url-utm");

  // ── (a) addAiUtmParams ────────────────────────────────────────────────
  {
    const u = "https://rettfrabonden.com/produsent/aker-gard";
    assertEq(utm.addAiUtmParams(u, "Claude"), `${u}?${TAG("claude", "mcp")}`, "(a) default medium is mcp, Claude → claude");
    assertEq(utm.addAiUtmParams(u, "ChatGPT", "a2a"), `${u}?${TAG("chatgpt", "a2a")}`, "(a) medium a2a");
    assertEq(utm.addAiUtmParams(u, "Perplexity", "api"), `${u}?${TAG("perplexity", "api")}`, "(a) medium api, Perplexity → perplexity");
    assertEq(utm.addAiUtmParams(u, undefined), `${u}?${TAG("ai_assistant", "mcp")}`, "(a) unknown client → ai_assistant");
    assertEq(utm.addAiUtmParams(u, "Some Bot"), `${u}?${TAG("ai_assistant", "mcp")}`, "(a) a client name not in the map → ai_assistant");
    const own = `${u}?utm_source=nyhetsbrev`;
    assertEq(utm.addAiUtmParams(own, "Claude"), own, "(a) an existing utm_source is never overwritten");
    assertEq(utm.addAiUtmParams(`${u}?page=2`, "Claude", "a2a"), `${u}?page=2&${TAG("claude", "a2a")}`, "(a) other query params are kept");
    assertEq(utm.addAiUtmParams("mailto:x@y.no", "Claude"), "mailto:x@y.no", "(a) non-http is unchanged");
    assertEq(utm.detectAiClient("openai-mcp/1.0.0"), "ChatGPT", "(a) detectAiClient: openai-mcp → ChatGPT");
    assertEq(utm.detectAiClient("x", "https://claude.ai"), "Claude", "(a) detectAiClient: origin claude.ai → Claude");
    assertEq(utm.detectAiClient("curl/8"), undefined, "(a) detectAiClient: curl → undefined");
    assertEq(utm.aiClientFromHeaders({ "user-agent": CHATGPT_USER }), "ChatGPT", "(a) aiClientFromHeaders: ChatGPT-User");
    assertEq(utm.aiClientFromHeaders({ "user-agent": "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)" }), "Perplexity", "(a) aiClientFromHeaders: Perplexity-User");
    assertEq(utm.aiClientFromHeaders({ "user-agent": "undici" }, "claude-ai"), "Claude", "(a) aiClientFromHeaders: initialize client name claude-ai");
  }

  // ── (b) tagAiProfileLinks ─────────────────────────────────────────────
  {
    const tag = (v: unknown, client = "Claude", medium: "mcp" | "a2a" | "api" = "mcp") => utm.tagAiProfileLinks(v, client, medium);
    const t = TAG("claude", "mcp");
    for (const p of [
      "https://rettfrabonden.com/produsent/aker-gard",
      "https://rettfrabonden.com/en/produsent/aker-gard",
      "https://finn-tannlege.com/klinikk/sentrum-tannklinikk-as-918800100",
      "https://finn-tannlege.com/klinikk/id/abc-123",
      "https://opplevagent.no/opplevelse/hvalsafari-i-tromso",
      "https://opplevagent.no/tilbyder/nordlys-opplevelser",
      "https://opplevagent.no/kategori/gardssalg/produsent/fossmoen-frukt",
    ]) assertEq(tag(p), `${p}?${t}`, `(b) tagged: ${p.replace(/^https:\/\//, "")}`);
    for (const p of [
      "https://rettfrabonden.com/produsent/aker-gard/vcard",
      "https://rettfrabonden.com/api/marketplace/agents/x/vcard",
      "https://rettfrabonden.com/vilkar",
      "https://rettfrabonden.com/sok?q=ost",
      "https://checkout.stripe.com/c/pay/cs_test_123",
      "https://aker-gard.no/produsent/aker",
      "https://evil-rettfrabonden.com/produsent/x",
      "https://opplevagent.no/kategori/gardssalg",
    ]) assertEq(tag(p), p, `(b) not tagged: ${p.replace(/^https:\/\//, "")}`);
    assertEq(tag("https://www.rettfrabonden.com/produsent/a"), `https://www.rettfrabonden.com/produsent/a?${t}`, "(b) www subdomain is ours");
    assertEq(tag("Se https://rettfrabonden.com/produsent/aker-gard."), `Se https://rettfrabonden.com/produsent/aker-gard?${t}.`, "(b) a sentence's full stop stays outside the link");
    assertEq(tag("🔗 [Profil](https://rettfrabonden.com/produsent/aker-gard)"), `🔗 [Profil](https://rettfrabonden.com/produsent/aker-gard?${t})`, "(b) markdown link");
    const tagged = `https://rettfrabonden.com/produsent/aker-gard?${TAG("chatgpt", "mcp")}`;
    assertEq(tag(`[Profil](${tagged})`), `[Profil](${tagged})`, "(b) an already tagged link is left alone");
    const json = JSON.stringify({ profile_url: "https://opplevagent.no/opplevelse/x", website: "https://x.no" }, null, 2);
    const jt = tag(json) as string;
    assertEq(JSON.parse(jt), { profile_url: `https://opplevagent.no/opplevelse/x?${t}`, website: "https://x.no" }, "(b) JSON text stays valid JSON, profile_url tagged");
    const input = {
      a: [{ profile_url: "https://rettfrabonden.com/produsent/a", n: 1, ok: true, none: null }],
      canonicalUrl: "https://rettfrabonden.com/produsent/a",
      canonical: "https://rettfrabonden.com/produsent/a",
      jsonLd: { "@context": "https://schema.org", "@type": "LocalBusiness", url: "https://rettfrabonden.com/produsent/a" },
      "@id": "https://rettfrabonden.com/produsent/a",
    };
    const before = JSON.stringify(input);
    const out = tag(input, "ChatGPT", "a2a") as typeof input;
    assertEq(out.a[0].profile_url, `https://rettfrabonden.com/produsent/a?${TAG("chatgpt", "a2a")}`, "(b) nested profile_url tagged");
    assertEq([out.a[0].n, out.a[0].ok, out.a[0].none], [1, true, null], "(b) other values unchanged");
    assertEq(out.canonicalUrl, "https://rettfrabonden.com/produsent/a", "(b) canonicalUrl is never tagged");
    assertEq(out.canonical, "https://rettfrabonden.com/produsent/a", "(b) canonical is never tagged");
    assertEq(out.jsonLd.url, "https://rettfrabonden.com/produsent/a", "(b) JSON-LD (@context) is never tagged");
    assertEq(out["@id"], "https://rettfrabonden.com/produsent/a", "(b) @id is never tagged");
    assertEq(JSON.stringify(input), before, "(b) the input object is not changed");
    // A branching cycle (a.b = a, a.c = [a, a]) used to cost 2^40 calls; now linear.
    const cyc: any = { profile_url: "https://rettfrabonden.com/produsent/a" };
    cyc.b = cyc;
    cyc.c = [cyc, cyc];
    const t0 = Date.now();
    const cOut = tag(cyc) as any;
    assertTrue(Date.now() - t0 < 1000, "(b) a branching cycle is walked in linear time");
    assertTrue(cOut.profile_url === `https://rettfrabonden.com/produsent/a?${t}` && cOut.b === cOut && cOut.c[0] === cOut && cOut.c[1] === cOut,
      "(b) the cycle is kept in the copy, profile_url tagged");
    assertEq(cyc.profile_url, "https://rettfrabonden.com/produsent/a", "(b) the cyclic input is not changed");
  }

  // ── (c) withRequestQuery ──────────────────────────────────────────────
  {
    assertEq(utm.withRequestQuery("/produsent/ny", "/produsent/gammel?utm_source=claude&utm_medium=mcp"), "/produsent/ny?utm_source=claude&utm_medium=mcp", "(c) query kept");
    assertEq(utm.withRequestQuery("/produsent/ny", "/produsent/gammel"), "/produsent/ny", "(c) no query → path");
    assertEq(utm.withRequestQuery("/produsent/ny", "/produsent/gammel?"), "/produsent/ny", "(c) empty query → path");
    assertEq(utm.withRequestQuery("//evil.example/x", "/a?b=1"), "//evil.example/x", "(c) a protocol-relative target is never built on");
    assertEq(utm.withRequestQuery("https://evil.example/x", "/a?b=1"), "https://evil.example/x", "(c) only a same-origin path");
  }

  // ── (d) double utm_source ─────────────────────────────────────────────
  {
    const { classifyAiClickSource, classifyReferralSource } = require("../services/human-referrals") as typeof import("../services/human-referrals");
    assertEq(classifyAiClickSource({ utm_source: ["claude", "chatgpt.com"], utm_campaign: "ai_search" }), "claude", "(d) ours first, ChatGPT's second → ours (claude)");
    assertEq(classifyAiClickSource({ utm_source: ["chatgpt.com", "claude"], utm_campaign: "ai_search" }), "claude", "(d) ChatGPT's first, ours second → still ours (claude)");
    assertEq(classifyAiClickSource({ utm_source: ["ai_assistant", "chatgpt.com"], utm_campaign: "ai_search" }), "chatgpt", "(d) our unknown-client mark + chatgpt.com → chatgpt");
    assertEq(classifyAiClickSource({ utm_source: ["perplexity.ai", "claude"] }), "claude", "(d) a domain-shaped value loses to our slug");
    assertEq(classifyAiClickSource({ utm_source: "chatgpt.com" }), "chatgpt", "(d) ChatGPT's mark alone → chatgpt");
    assertEq(classifyReferralSource(null, { utm_source: ["chatgpt.com", "claude"] }).key, "claude", "(d) the referral classifier agrees");
  }

  // ── fixtures for (e)–(i) ──────────────────────────────────────────────
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevWarn = console.warn;
  if (!log) { console.log = () => { /* quiet */ }; console.warn = () => { /* quiet */ }; }
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const prevExpPath = process.env.EXPERIENCES_DB_PATH;
  const prevBase = process.env.BASE_URL;
  delete process.env.BASE_URL;
  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  const cachePaths = [
    "../database/db-factory", "../services/dental-store", "../services/experience-store",
    "../routes/dental-seo", "../routes/dental-mcp", "../routes/dental-a2a", "../routes/dental",
    "../routes/experiences-seo", "../routes/experiences-mcp", "../routes/experiences-a2a",
  ].map((p) => require.resolve(p));
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  const servers: Array<import("http").Server> = [];

  // A real express app on an ephemeral port: the middleware chain as mounted.
  const express = require("express") as typeof import("express");
  async function serve(mount: (app: import("express").Express) => void): Promise<string> {
    const app = express();
    app.use(express.json());
    mount(app);
    const srv = app.listen(0);
    servers.push(srv);
    await new Promise<void>((r) => srv.once("listening", () => r()));
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }
  const fakeServerFor = (clientName?: string) => {
    const tools = new Map<string, any>();
    const server: any = {
      server: { getClientVersion: () => (clientName ? { name: clientName, version: "1" } : undefined) },
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() { /* no-op */ }, prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
    };
    return { tools, server };
  };
  // Calls one route handler of a router with a fake request (seo.ts style).
  function invoke(router: any, url: string, ua: string, extra: { params?: Record<string, string> } = {}): Promise<{ status: number; body: string; location?: string }> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = { "user-agent": ua };
      const req: any = {
        method: "GET", url, originalUrl: url, path: url.split("?")[0], hostname: "example.test",
        query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
        params: extra.params ?? {}, headers, lang: "no", ip: "203.0.113.7",
        get(h: string) { return headers[h.toLowerCase()]; },
      };
      const res: any = new EventEmitter();
      Object.assign(res, {
        statusCode: 200, locals: {},
        status(c: number) { res.statusCode = c; return res; },
        set() { return res; }, header() { return res; }, setHeader() { return res; }, type() { return res; }, vary() { return res; },
        redirect(a: unknown, b?: unknown) {
          const status = typeof a === "number" ? a : 302;
          const location = String(typeof a === "number" ? b : a);
          res.statusCode = status; res.emit("finish"); resolve({ status, body: "", location }); return res;
        },
        send(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b) }); return res; },
        json(b: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: JSON.stringify(b) }); return res; },
        end(b?: unknown) { res.emit("finish"); resolve({ status: res.statusCode, body: String(b ?? "") }); return res; },
      });
      router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, body: err ? String(err?.stack || err) : "" }));
    });
  }

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }

    // rfb: one producer who takes orders (Aker Gard) and one who does not (Berg Gard).
    const seed = (id: string, name: string, product: string, optIn: number) => {
      db.prepare(`
        INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
           lat, lng, city, is_active, is_verified, order_notifications_opt_in)
        VALUES (?, ?, 'test', 'test', ?, 'https://example.com', 'producer', ?, ?, ?, 'Oslo', 1, 1, ?)
      `).run(id, name, `${id}@example.com`, `key-${id}`, OSLO.lat, OSLO.lng, optIn);
      db.prepare("INSERT INTO agent_knowledge (agent_id, verification_status) VALUES (?, 'verified')").run(id);
      db.prepare("INSERT INTO products (id, agent_id, name, name_norm, price_nok, availability, availability_source, availability_updated_at) VALUES (?, ?, ?, ?, 30, 'in_stock', 'producer_dashboard', ?)")
        .run(`prod-${id}`, id, product, product.toLowerCase(), new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19));
    };
    seed("apl-aker", "Aker Gard", "Poteter", 1);
    seed("apl-berg", "Berg Gard", "Honning", 0);
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    // ── (e) rfb MCP ─────────────────────────────────────────────────────
    {
      const { registerTools } = require("../routes/mcp") as typeof import("../routes/mcp");
      const { tools, server } = fakeServerFor();
      registerTools(server, () => "ChatGPT", () => undefined);
      const extra = { sessionId: "apl-1", requestInfo: { headers: { "user-agent": "openai-mcp/1.0.0" } } };
      const t = TAG("chatgpt", "mcp");

      const offersOut = await tools.get("lokal_find_offers")({ items: ["poteter", "honning"], lat: OSLO.lat, lng: OSLO.lng, radius_km: 5 }, extra);
      const offers = JSON.parse(String(offersOut?.content?.[0]?.text ?? "null"));
      const offerUrls: string[] = (offers || []).flatMap((r: any) => r.offers.map((o: any) => o.producer.profile_url));
      assertTrue(offerUrls.length === 2, `(e) lokal_find_offers returns both producers (got ${offerUrls.length})`);
      assertTrue(offerUrls.every((u) => u.startsWith("https://rettfrabonden.com/produsent/") && u.endsWith(`?${t}`)), "(e) lokal_find_offers: every producer.profile_url is tagged (chatgpt, mcp)");
      const { findOffers } = require("../services/catalog-offers") as typeof import("../services/catalog-offers");
      const direct = await findOffers({ q: "poteter", lat: OSLO.lat, lng: OSLO.lng, radiusKm: 5, limit: 5 } as any);
      assertEq(direct.offers[0]?.producer.profile_url, "https://rettfrabonden.com/produsent/aker-gard", "(e) findOffers itself (shared by REST /catalog/offers and the shopping list) stays untagged");

      const created = JSON.parse(String((await tools.get("lokal_cart_create")({}, extra))?.content?.[0]?.text ?? "{}"));
      for (const pid of ["prod-apl-aker", "prod-apl-berg"]) {
        const added = await tools.get("lokal_cart_add_item")({ cart_id: created.cart_id, buyer_ref: created.buyer_ref, product_id: pid, qty: 1 }, extra);
        assertTrue(String(added?.content?.[0]?.text ?? "").includes('"success": true'), `(e) lokal_cart_add_item ${pid} (${String(added?.content?.[0]?.text ?? "").slice(0, 300)})`);
      }
      const submitText = String((await tools.get("lokal_cart_submit")({ cart_id: created.cart_id, buyer_ref: created.buyer_ref, buyer_email: "kjoper@example.no", contact_consent: true }, extra))?.content?.[0]?.text ?? "");
      const submit = JSON.parse(submitText || "{}");
      const submitUrls = [
        ...(submit.orders ?? []).map((o: any) => o.producer_contact?.profile_url),
        ...(submit.contact_handoffs ?? []).map((h: any) => h.profile_url),
      ].filter(Boolean) as string[];
      assertTrue(submit.success === true && submitUrls.length >= 1, `(e) lokal_cart_submit answers with profile links (got ${submitUrls.length}: ${submitText.slice(0, 200)})`);
      assertTrue(submitUrls.every((u) => u.endsWith(`?${t}`)), "(e) lokal_cart_submit: producer_contact / contact_handoffs profile_url tagged");
      const order = (submit.orders ?? [])[0];
      if (order) {
        const status = JSON.parse(String((await tools.get("lokal_order_status")({ order_id: order.order_id ?? order.id, buyer_ref: created.buyer_ref }, extra))?.content?.[0]?.text ?? "{}"));
        const statusText = JSON.stringify(status);
        const urls = statusText.match(/https:\/\/rettfrabonden\.com\/produsent\/[^"]+/g) ?? [];
        assertTrue(urls.length >= 1 && urls.every((u) => u.endsWith(`?${t}`)), `(e) lokal_order_status: profile links tagged (${urls.length})`);
      } else {
        assertTrue(false, `(e) lokal_cart_submit created an order for the opted-in producer (${submitText.slice(0, 600)})`);
      }
      const { producerContact } = require("../services/cart-service") as typeof import("../services/cart-service");
      assertEq(producerContact("apl-aker", "Aker Gard").profile_url, "https://rettfrabonden.com/produsent/aker-gard",
        "(e) producerContact (shared with the order e-mail and the receipt) stays untagged after the MCP calls");
      const searchOut = await tools.get("lokal_search")({ query: "Aker Gard", limit: 5 }, extra);
      const searchText = String(searchOut?.content?.[0]?.text ?? "");
      const searchUrls = searchText.match(/https:\/\/rettfrabonden\.com\/produsent\/[^\s)]+/g) ?? [];
      assertTrue(searchUrls.length >= 1 && searchUrls.every((u) => u.includes(t)), "(e) lokal_search: profile links tagged once (no double tag)");
      assertTrue(searchUrls.every((u) => (u.match(/utm_source/g) ?? []).length === 1), "(e) never two utm_source on one link");
    }

    // ── (f) rfb REST /api/marketplace/catalog/offers ────────────────────
    {
      const { aiProfileLinksForAiSearch } = require("./ai-profile-links") as typeof import("./ai-profile-links");
      const { catalogRouter } = require("../routes/marketplace-catalog") as typeof import("../routes/marketplace-catalog");
      const base = await serve((app) => {
        app.use(["/api/marketplace", "/api/tannlege", "/api/opplevelser"], aiProfileLinksForAiSearch);
        app.use("/api/marketplace/catalog", catalogRouter);
      });
      const get = async (ua: string) => {
        const r = await fetch(`${base}/api/marketplace/catalog/offers?q=poteter&lat=${OSLO.lat}&lng=${OSLO.lng}&radius_km=5`, { headers: { "user-agent": ua } });
        return { vary: r.headers.get("vary") || "", body: await r.text() };
      };
      const ai = await get(CHATGPT_USER);
      assertTrue(ai.body.includes(`"https://rettfrabonden.com/produsent/aker-gard?${TAG("chatgpt", "api")}"`), "(f) REST to ChatGPT-User (custom GPT action): profile_url tagged utm_medium=api");
      assertTrue(/user-agent/i.test(ai.vary), "(f) the tagged answer varies on User-Agent");
      for (const [label, ua] of [["a person", HUMAN], ["Googlebot", GOOGLEBOT], ["curl", "curl/8.5.0"]] as Array<[string, string]>) {
        const r = await get(ua);
        assertTrue(r.body.includes('"https://rettfrabonden.com/produsent/aker-gard"') && !r.body.includes("utm_"), `(f) REST to ${label}: untagged`);
      }
    }

    // ── (i) rfb 301 from an old slug keeps utm_* ────────────────────────
    {
      const { ensureAgentSlugAliasesTable } = regMod as typeof import("../services/marketplace-registry");
      ensureAgentSlugAliasesTable(db as any);
      db.prepare("INSERT INTO agent_slug_aliases (old_slug, agent_id) VALUES ('gammel-aker', 'apl-aker')").run();
      const seoRouter = (require("../routes/seo") as typeof import("../routes/seo")).default as any;
      const q = `?${TAG("claude", "mcp")}`;
      const r = await invoke(seoRouter, `/produsent/gammel-aker${q}`, HUMAN, { params: { slug: "gammel-aker" } });
      assertEq(r.status, 301, "(i) rfb: an old slug answers 301");
      assertEq(r.location, `/produsent/aker-gard${q}`, "(i) rfb: the 301 keeps utm_*");
      const plain = await invoke(seoRouter, "/produsent/gammel-aker", HUMAN, { params: { slug: "gammel-aker" } });
      assertEq(plain.location, "/produsent/aker-gard", "(i) rfb: without a query the target is unchanged");
      const page = await invoke(seoRouter, `/produsent/aker-gard${q}`, HUMAN, { params: { slug: "aker-gard" } });
      assertTrue(page.status === 200 && page.body.includes('<link rel="canonical" href="https://rettfrabonden.com/produsent/aker-gard">'), "(i) rfb: a tagged landing keeps an untagged canonical");
      assertTrue(!/utm_/.test(page.body.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g)?.join("") ?? ""), "(i) rfb: JSON-LD on the page is untagged");
      const sitemap = await invoke(seoRouter, "/sitemap.xml", CHATGPT_USER);
      assertTrue(sitemap.body.includes("/produsent/aker-gard") && !sitemap.body.includes("utm_"), "(i) rfb: the sitemap is untagged, also for an AI");
    }

    // ── (g) dental ──────────────────────────────────────────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");
    const expDb = dbFactory.getDb("experiences");
    const dentalStore = require("../services/dental-store") as typeof import("../services/dental-store");
    const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
    {
      const dentalIds: string[] = [];
      for (const [i, navn] of ["Sentrum Tannklinikk AS", "Nord Tannlegesenter AS"].entries()) {
        const id = dentalStore.createDentalAgent({
          navn, org_nr: `91880010${i}`, poststed: "OSLO", fylke: "Oslo",
          adresse: "Storgata 1", telefon: "2211009" + i, hjemmeside: `https://klinikk${i}.example.no`,
        } as any);
        dentalDb.prepare("UPDATE dental_agents SET catalog_class = 'klinikk' WHERE id = ?").run(id);
        dentalIds.push(id);
      }
      const t = TAG("chatgpt", "mcp");
      const { tools, server } = fakeServerFor();
      (require("../routes/dental-mcp") as typeof import("../routes/dental-mcp")).registerDentalTools(server);
      const out = await tools.get("tannlege_search")({ query: "tann", limit: 10 }, { sessionId: "d-1", requestInfo: { headers: { "user-agent": "openai-mcp/1.0.0" } } });
      const text = String(out?.content?.[0]?.text ?? "");
      const urls = text.match(/https:\/\/finn-tannlege\.com\/klinikk\/[^\s"),]+/g) ?? [];
      assertTrue(urls.length >= 2 && urls.every((u) => u.endsWith(`?${t}`)), `(g) tannlege_search (MCP): every clinic link tagged (${urls.length})`);
      const { tools: tools2, server: server2 } = fakeServerFor("claude-ai");
      (require("../routes/dental-mcp") as typeof import("../routes/dental-mcp")).registerDentalTools(server2);
      const info = String((await tools2.get("tannlege_info")({ id: dentalIds[0] }, { sessionId: "d-2", requestInfo: { headers: { "user-agent": "undici" } } }))?.content?.[0]?.text ?? "");
      assertTrue(info.includes(`?${TAG("claude", "mcp")}`), "(g) tannlege_info (MCP): AI from the initialize client name (claude)");

      const dentalSeo = require("../routes/dental-seo") as typeof import("../routes/dental-seo");
      const agent = dentalStore.getDentalAgentById(dentalIds[0]) as any;
      assertTrue(!dentalSeo.clinicProfileUrl(agent).includes("utm_"), "(g) clinicProfileUrl (canonical, JSON-LD, ItemList) stays untagged");

      const { aiProfileLinksForAiSearch } = require("./ai-profile-links") as typeof import("./ai-profile-links");
      const dentalRoutes = (require("../routes/dental") as typeof import("../routes/dental")).default as any;
      const dentalA2a = (require("../routes/dental-a2a") as typeof import("../routes/dental-a2a")).default as any;
      const base = await serve((app) => {
        app.use(["/api/marketplace", "/api/tannlege", "/api/opplevelser"], aiProfileLinksForAiSearch);
        app.use("/api/tannlege", dentalRoutes);
        app.use(dentalA2a);
      });
      const rest = async (ua: string) => (await fetch(`${base}/api/tannlege/discover?q=tann`, { headers: { "user-agent": ua } })).text();
      const restAi = await rest(CHATGPT_USER);
      const restUrls = restAi.match(/https:\/\/finn-tannlege\.com\/klinikk\/[^"]+/g) ?? [];
      assertTrue(restUrls.length >= 2 && restUrls.every((u) => u.endsWith(`?${TAG("chatgpt", "api")}`)), `(g) REST /api/tannlege/discover to ChatGPT-User: profil_url tagged (${restUrls.length})`);
      const restHuman = await rest(HUMAN);
      assertTrue(restHuman.includes("finn-tannlege.com/klinikk/") && !restHuman.includes("utm_"), "(g) REST /api/tannlege/discover to a person: untagged");

      const a2aRes = await fetch(`${base}/a2a`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "python-requests/2.31" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "tannlege i Oslo" }] } } }),
      });
      const a2aText = await a2aRes.text();
      const a2aUrls = a2aText.match(/https:\/\/finn-tannlege\.com\/klinikk\/[^"\\]+/g) ?? [];
      assertTrue(a2aUrls.length >= 2 && a2aUrls.every((u) => u.endsWith(`?${TAG("python_sdk", "a2a")}`)), `(g) dental POST /a2a: clinic links tagged utm_medium=a2a (${a2aUrls.length}: ${a2aText.slice(0, 160)})`);

      const page = await invoke(dentalSeo.default as any, `/klinikk/id/${dentalIds[0]}?${TAG("chatgpt", "mcp")}`, HUMAN);
      const canonical = page.body.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? "";
      assertTrue(page.status === 200 && canonical.includes("/klinikk/") && !canonical.includes("utm_"), "(g) the clinic page's canonical stays untagged on a tagged landing");
      assertTrue(!/utm_/.test(page.body.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g)?.join("") ?? ""), "(g) the clinic page's JSON-LD stays untagged");
    }

    // ── (h) experiences ─────────────────────────────────────────────────
    {
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES ('gs-fossmoen', 'Fossmoen Frukt', 'experiences', 'Telemark', 'Skien', 'Skien', 'cideri', NULL, NULL, 59.21, 9.61,
            'high', 'fossmoen-frukt', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      const provId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expId = expStore.createExperience({
        title: "Hvalsafari i Tromsø", provider_id: provId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });
      const t = TAG("claude", "mcp");
      const { tools, server } = fakeServerFor();
      (require("../routes/experiences-mcp") as typeof import("../routes/experiences-mcp")).registerExperienceTools(server, () => "Claude");
      const disc = await tools.get("discover_experiences")({ kommune: "Tromsø", limit: 10 }, { sessionId: "e-1", requestInfo: { headers: { "user-agent": "node" } } });
      const sc = disc?.structuredContent;
      const scUrls: string[] = JSON.stringify(sc ?? {}).match(/https:\/\/opplevagent\.no\/opplevelse\/[^"]+/g) ?? [];
      assertTrue(scUrls.length >= 1 && scUrls.every((u) => u.endsWith(`?${t}`)), `(h) discover_experiences: structuredContent profile_url tagged (widget data) (${scUrls.length})`);
      const txtUrls = String(disc?.content?.[0]?.text ?? "").match(/https:\/\/opplevagent\.no\/opplevelse\/[^"]+/g) ?? [];
      assertTrue(txtUrls.length >= 1 && txtUrls.every((u) => u.endsWith(`?${t}`)), "(h) discover_experiences: text part tagged too");
      const gs = await tools.get("discover_gardssalg")({ fylke: "Telemark", limit: 10 }, { sessionId: "e-2", requestInfo: { headers: { "user-agent": "node" } } });
      const gsText = JSON.stringify(gs);
      assertTrue(gsText.includes(`https://opplevagent.no/kategori/gardssalg/produsent/fossmoen-frukt?${TAG("claude", "mcp")}`), "(h) discover_gardssalg: producer profile_url tagged");

      const expA2a = (require("../routes/experiences-a2a") as typeof import("../routes/experiences-a2a")).default as any;
      const base = await serve((app) => { app.use(expA2a); });
      const a2a = await (await fetch(`${base}/a2a`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (compatible; Claude-User/1.0)" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "gårdssalg i Telemark" }] } } }),
      })).text();
      assertTrue(a2a.includes(`https://opplevagent.no/kategori/gardssalg/produsent/fossmoen-frukt?${TAG("claude", "a2a")}`), `(h) experiences POST /a2a: profile_url tagged utm_medium=a2a (${a2a.slice(0, 160)})`);

      // The ChatGPT widget (opplevagent-widgets.ts) still builds its link from the slug: its
      // template is frozen for the OpenAI review (opplevagent-mcp-contract-freeze.test.ts).

      // (i) experiences 301s keep the query
      const expSeo = (require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any;
      const q = `?${TAG("chatgpt", "mcp")}`;
      const prov = await invoke(expSeo, `/tilbyder/${provId}${q}`, HUMAN);
      const provSlug = (expDb.prepare("SELECT slug FROM experience_providers WHERE id = ?").get(provId) as { slug: string | null }).slug;
      assertTrue(prov.status === 301 && prov.location === `/tilbyder/${encodeURIComponent(String(provSlug))}${q}`, `(i) experiences /tilbyder/<uuid> 301 keeps utm_* (${prov.status} ${prov.location})`);
      const expSlug = (expDb.prepare("SELECT slug FROM experiences WHERE id = ?").get(expId) as { slug: string }).slug;
      const dupId = expStore.createExperience({
        title: "Hvalsafari Tromsø duplikat", provider_id: provId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });
      const dupSlug = (expDb.prepare("SELECT slug FROM experiences WHERE id = ?").get(dupId) as { slug: string }).slug;
      const cols = (expDb.prepare("PRAGMA table_info(experiences)").all() as Array<{ name: string }>).map((c) => c.name);
      const dupCol = ["duplicate_of", "canonical_id", "merged_into"].find((c) => cols.includes(c));
      if (dupCol) {
        expDb.prepare(`UPDATE experiences SET ${dupCol} = ?, verification_status = 'rejected' WHERE id = ?`).run(expId, dupId);
        const dup = await invoke(expSeo, `/opplevelse/${dupSlug}${q}`, HUMAN);
        assertTrue(dup.status === 301 && dup.location === `/opplevelse/${encodeURIComponent(expSlug)}${q}`, `(i) experiences dedup /opplevelse/<old> 301 keeps utm_* (${dup.status} ${dup.location})`);
      } else {
        assertTrue(false, `(i) experiences: no dedup column found (${cols.join(",")})`);
      }
    }

    // ── (j) mounts ──────────────────────────────────────────────────────
    {
      for (const f of ["a2a.ts", "dental-a2a.ts", "experiences-a2a.ts"]) {
        const src = fs.readFileSync(path.join(__dirname, "../routes", f), "utf8");
        assertTrue(src.includes('router.post("/a2a", aiProfileLinksJson("a2a"),'), `(j) ${f}: POST /a2a answers go through aiProfileLinksJson("a2a")`);
      }
      const indexSrc = fs.readFileSync(path.join(__dirname, "../index.ts"), "utf8");
      assertTrue(indexSrc.includes('app.use(["/api/marketplace", "/api/tannlege", "/api/opplevelser"], aiProfileLinksForAiSearch);'), "(j) index.ts: the three public APIs tag for ai_search clients");
      const mcpSrc = ["mcp.ts", "dental-mcp.ts", "experiences-mcp.ts"].map((f) => fs.readFileSync(path.join(__dirname, "../routes", f), "utf8"));
      assertTrue(mcpSrc.every((s) => s.includes("tagMcpToolResults(server")), "(j) the three MCP servers tag every tool result");
    }
  } catch (err: any) {
    failed++;
    failures.push(`unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    console.warn = prevWarn;
    for (const s of servers) s.close();
    if (prevBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prevBase;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevExpPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExpPath;
    try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* best effort */ }
    restoreModuleCache();
    initMod.__setDbForTesting(prevDb as any);
    try { db.close(); } catch { /* already closed */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAiProfileLinksTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
