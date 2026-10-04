/**
 * rfb-hidden-test-producer.test.ts — dev-request
 * 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt (+ the RFB vertical filter
 * on public RFB surfaces).
 *
 * What it proves, against the REAL routers/services on the production schema
 * in an in-memory DB (router handlers pulled off each router's stack and
 * invoked with a fake req/res — same harness as marketplace-quarantine-
 * gates.test.ts; no HTTP server, no network):
 *
 *   AC3 enumeration — ONE fixture row is checked on every public surface the
 *       dev-request lists (search, /discover, lokal_search, /agents, catalog
 *       feed, acp-feed.csv, catalog offers, lokal_find_offers, llms-full.txt,
 *       sitemap, /produsent/:slug, homepage, /verifisert-av-eier, city page,
 *       find-match, outreach pool VIEW + computeOutreachCandidates, verifier
 *       batch pickers, /reise corridor RFB stops (loadRfbCandidates), the
 *       cached /sitemap.xml, /a2a card + agents.json counts,
 *       /api/stats, top producers, public agent-stats and card/info/vcard/
 *       trust). First as a CONTROL with catalog_hidden=0 (present everywhere,
 *       so no assertion below is vacuous), then hidden via the real POST
 *       /admin/test-producer (adopting the legacy pilot row) → absent
 *       everywhere, while an identical normal row stays present.
 *   Umbrella member lists — /umbrellas/:id/members, lokal_get_umbrella_members
 *       and umbrella-page children (affiliations and parent_umbrella_id):
 *       control with the fixture un-hidden, then hidden.
 *   Vertical filter — an identical row with vertical_id='dental' is absent
 *       from every RFB surface and from the RFB stats counts in BOTH phases
 *       (the verifier pickers are the documented exception: hidden-only).
 *   AC1/AC2 — the direct-id order flow still works for the hidden fixture:
 *       /catalog/agents/:id/products lists «Testpoteter (kun test)» in_stock;
 *       lokal_info by id; lokal_cart_create/add_item/submit with
 *       contact_consent → exactly 1 real order, 0 handoffs, the notification
 *       goes to the override address (send stubbed).
 *   AC4 — a real producer id (and a dental id) → 409 not_a_test_fixture with
 *       zero writes (dry-run AND apply); unknown id 404; no key 403.
 *   AC6 — retire → inactive + out_of_stock; retire again is a no-op; arm
 *       re-arms; arm again is a no-op (audit rows only for real changes).
 *   Create path — with no legacy row a new fixture row is created once and
 *       reused; two fixture rows → 409, nothing written.
 *   Gates byte-identical (as lokal#954 / the dev-request's AC4 require) —
 *       isProducerEligible, isEligibleForRealOrder and
 *       resolveOrderNotificationRecipient are pinned by SHA-256 of their
 *       source text, and additionally compared with origin/main via git when
 *       git is available. If you deliberately change one of these gates,
 *       update the pin AND re-justify the fixture (it must pass the gates
 *       because its data is set, never because a gate exempts it).
 *
 * Exported runRfbHiddenTestProducerTests({log}) -> TestSummary; wired into
 * tests/test.ts (runSerial, tail). Standalone:
 *   npx tsx src/routes/rfb-hidden-test-producer.test.ts
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { slugify } from "../utils/slug";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface HandlerResult {
  status: number;
  body: any;
}

/** Pinned SHA-256 of each gate's source text on main (2026-10-04, f63d051b). */
export const GATE_SOURCE_PINS: Array<{ file: string; fn: string; sha256: string }> = [
  { file: "src/services/cart-service.ts", fn: "isProducerEligible", sha256: "36dd01d70416623ceb8c73d4b0f5e2f28f61e06c546f1d57789def8d8ecad6fc" },
  { file: "src/services/cart-service.ts", fn: "isEligibleForRealOrder", sha256: "ed98b620072b0ab4b7b822569950a3b0c6099fb82569c3feff68e0cb9be534b3" },
  { file: "src/services/order-notify-service.ts", fn: "resolveOrderNotificationRecipient", sha256: "117533c36565dc15ae6dc7204091437a6013b84939d64dbf1469d8bff8668561" },
];

/** `export function NAME(…) { … }` source text (LF-normalised), or null. */
export function extractExportedFunctionSource(src: string, name: string): string | null {
  const text = src.replace(/\r\n/g, "\n");
  const start = text.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  let i = text.indexOf("(", start);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") { depth--; if (depth === 0) break; }
  }
  const open = text.indexOf("{", i);
  depth = 0;
  for (let j = open; j >= 0 && j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  return null;
}

const OSLO = { lat: 59.9139, lng: 10.7522 };
const LEGACY_ID = "dff0c55e-8770-47cb-9e19-bd8099fcd5d5";
const NORMAL_ID = "lh-normal";
const DENTAL_ID = "lh-dental";
const NORMAL_NAME = "Normal Gard Listetest";
const FIXTURE_NAME = "Test Gard Listetest";
const DENTAL_NAME = "Dentix Tannhelse Listetest";
const FIXTURE_EMAIL = "fixture-inbox@example.no";

function seedProducer(
  db: Database.Database,
  o: { id: string; name: string; vertical?: string; origin?: string; trust?: number },
): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id,
        order_notifications_opt_in, order_notification_email)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, ?, ?, 'Oslo', '["vegetables"]', '[]', ?, 1, 1, ?, ?, 1, ?)`,
  ).run(
    o.id, o.name,
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `${o.id}@example.no`, `https://${o.id}.example.no`, `key-${o.id}`, OSLO.lat, OSLO.lng,
    o.trust ?? 0.7, o.origin ?? "discovery", o.vertical ?? "rfb", `${o.id}@example.no`,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, field_provenance, email, website, about, products, verification_status, verified_second_line,
        enrichment_status, url_last_status, url_last_probed, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    o.id,
    // Categories corroborated by the producer's own homepage, so the outreach
    // gate's unrelated categories_not_corroborated suppression stays out of
    // the way and the outreach surface is a real (non-vacuous) check.
    JSON.stringify({ categories: [{ source_type: "website_homepage", source_url: `https://${o.id}.example.no` }] }),
    `${o.id}@example.no`, `https://${o.id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([
      { name: "Listepoteter", price: "30 kr/kg", category: "vegetables" },
      { name: "Gulrøtter", price: "25 kr/kg", category: "vegetables" },
      { name: "Kål", price: "20 kr/stk", category: "vegetables" },
    ]),
  );
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url)
     VALUES (?, ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg')`,
  ).run(`prod-${o.id}`, o.id);
  db.prepare(
    `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at)
     VALUES (?, ?, 'Oslo', 'search', datetime('now'))`,
  ).run(o.id, o.name);
}

export async function runRfbHiddenTestProducerTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; headers?: Record<string, string>; path?: string }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      method: "GET",
      url: o.path || "/",
      path: o.path || "/",
      originalUrl: o.path || "/",
      params: o.params || {},
      body: o.body,
      query: o.query || {},
      headers,
      ip: "127.0.0.1",
      lang: "no",
      protocol: "https",
      hostname: "rettfrabonden.com",
      get(name: string) {
        if (name.toLowerCase() === "host") return "rettfrabonden.com";
        return headers[name.toLowerCase()];
      },
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
        header() { return res; },
        set() { return res; },
        type() { return res; },
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

  const ambientKey = process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
  const setKeyOurselves = ambientKey === "";
  if (setKeyOurselves) process.env.ADMIN_KEY = "rfb-hidden-test-producer-standalone-key";
  const adminKey = () => process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";

  const geo = require("../services/geocoding-service") as typeof import("../services/geocoding-service");
  const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
  const notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./discovery", "./agent-stats", "./a2a", "./admin-test-producer"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  const db2 = new Database(":memory:");
  db2.pragma("journal_mode = DELETE");
  db2.pragma("foreign_keys = ON");

  const sent: Array<{ to: string; subject: string }> = [];
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    geo.__setGeocodingFetchForTesting((async () =>
      ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();
    notifySvc.__setOrderNotifySendForTesting(async (o: any) => {
      sent.push({ to: String(o.to), subject: String(o.subject) });
      return { success: true, messageId: "stub" };
    });
    clearRegistryCaches();

    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const seoMod = require("./seo") as typeof import("./seo");
    const seoRouter = seoMod.default as any;
    const discoveryRouter = require("./discovery").default as any;
    const agentStatsRouter = require("./agent-stats").default as any;
    const a2aRouter = require("./a2a").default as any;
    const tpMod = require("./admin-test-producer") as typeof import("./admin-test-producer");
    const tpRouter = tpMod.default as any;
    const visibility = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    const verifier = require("../agents/lokal-agent-verifier") as typeof import("../agents/lokal-agent-verifier");
    const { computeOutreachCandidates } = require("./admin-outreach-candidates") as typeof import("./admin-outreach-candidates");
    const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");
    const corridor = require("../services/route-corridor-service") as typeof import("../services/route-corridor-service");

    const tools = new Map<string, (args: any) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource() { /* no-op */ },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");

    const H = {
      search: findRouteHandler(marketplaceRouter, "/search", "get"),
      discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
      agents: findRouteHandler(marketplaceRouter, "/agents", "get"),
      findMatch: findRouteHandler(marketplaceRouter, "/find-match", "get"),
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      trust: findRouteHandler(marketplaceRouter, "/agents/:id/trust", "get"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      offers: findRouteHandler(catalogRouter, "/offers", "get"),
      products: findRouteHandler(catalogRouter, "/agents/:id/products", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      home: findRouteHandler(seoRouter, "/", "get"),
      verified: findRouteHandler(seoRouter, "/verifisert-av-eier", "get"),
      city: findRouteHandler(seoRouter, "/:city", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
      agentsJson: findRouteHandler(discoveryRouter, "/.well-known/agents.json", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "get"),
      apiStats: findRouteHandler(a2aRouter, "/api/stats", "get"),
      agentStats: findRouteHandler(agentStatsRouter, "/api/agents/:id/stats", "get"),
      umbMembers: findRouteHandler(marketplaceRouter, "/umbrellas/:id/members", "get"),
      testProducer: findRouteHandler(tpRouter, "/", "post"),
    };
    const postTp = (body: any, key: string | null = adminKey()) =>
      invoke(H.testProducer, makeReq({ body, headers: key === null ? {} : { "x-admin-key": key } }));

    // ── shared predicate unit cases ─────────────────────────────────────────
    assertTrue(visibility.isPubliclyListable({ catalog_hidden: 0, vertical_id: "rfb" }), "pred-1: rfb + not hidden → listable");
    assertTrue(visibility.isPubliclyListable({}), "pred-2: missing columns read as the SQL COALESCE defaults → listable");
    assertTrue(!visibility.isPubliclyListable({ catalog_hidden: 1, vertical_id: "rfb" }), "pred-3: catalog_hidden=1 → not listable");
    assertTrue(!visibility.isPubliclyListable({ catalog_hidden: 0, vertical_id: "dental" }), "pred-4: dental vertical → not listable");
    assertTrue(!visibility.isPubliclyListable({ catalog_hidden: 0, vertical_id: "experiences" }), "pred-5: experiences vertical → not listable");
    assertTrue(!visibility.isPubliclyListable(undefined), "pred-6: no row → not listable");
    assertEq(visibility.publicListableSql("a"), "COALESCE(a.catalog_hidden, 0) = 0 AND COALESCE(a.vertical_id, 'rfb') = 'rfb'", "pred-7: SQL fragment shape");
    {
      const bare = new Database(":memory:");
      bare.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT)");
      assertEq(visibility.catalogHiddenIdExclusionSql(bare, "a"), "", "pred-8: verifier exclusion is \"\" on a DB without the column (old minimal schemas stay byte-identical)");
      bare.exec("ALTER TABLE agents ADD COLUMN catalog_hidden INTEGER NOT NULL DEFAULT 0");
      bare.exec("INSERT INTO agents (id, name) VALUES ('x''1', 'n')");
      assertEq(visibility.catalogHiddenIdExclusionSql(bare, "a"), "", "pred-9: …and \"\" when no row is hidden");
      bare.exec("UPDATE agents SET catalog_hidden = 1");
      assertEq(visibility.catalogHiddenIdExclusionSql(bare, "a"), " AND a.id NOT IN ('x''1')", "pred-10: hidden ids become a quote-escaped NOT IN clause");
      bare.close();
    }

    seedProducer(db, { id: NORMAL_ID, name: NORMAL_NAME });
    seedProducer(db, { id: LEGACY_ID, name: FIXTURE_NAME });
    seedProducer(db, { id: DENTAL_ID, name: DENTAL_NAME, vertical: "dental" });
    const ID_BY_NAME: Array<[string, string]> = [[NORMAL_ID, NORMAL_NAME], [LEGACY_ID, FIXTURE_NAME], [DENTAL_ID, DENTAL_NAME]];
    const idsInText = (text: unknown) => {
      const t = String(typeof text === "string" ? text : JSON.stringify(text ?? ""));
      return ID_BY_NAME.filter(([, name]) => t.includes(name)).map(([id]) => id);
    };
    const idsInSitemap = (xml: string) => ID_BY_NAME.filter(([, name]) => xml.includes(`/produsent/${slugify(name)}<`)).map(([id]) => id);
    const ALL = [NORMAL_ID, LEGACY_ID, DENTAL_ID];
    const ok200 = async (h: Function, id: string, paramsKey = "id") => (await invoke(h, makeReq({ params: { [paramsKey]: id } }))).status === 200;

    /** Which of the three rows each surface shows right now. */
    async function snapshot(): Promise<Record<string, string[]>> {
      clearRegistryCaches();
      const s: Record<string, string[]> = {};
      s.search = ((await invoke(H.search, makeReq({ query: { q: "Listetest", heleNorge: "true" } }))).body?.results ?? []).map((r: any) => r.agent.id);
      s.discover = ((await invoke(H.discover, makeReq({ body: { role: "producer" } }))).body?.results ?? []).map((r: any) => r.agent.id);
      s.lokal_search = idsInText(await toolText("lokal_search", { query: "Listetest" }));
      s.agents = ((await invoke(H.agents, makeReq({}))).body?.agents ?? []).map((a: any) => a.id);
      s.catalog_feed = ((await invoke(H.feed, makeReq({}))).body?.items ?? []).map((i: any) => i.seller.agent_id);
      s.acp_feed_csv = idsInText((await invoke(H.acp, makeReq({}))).body);
      s.catalog_offers = ((await invoke(H.offers, makeReq({ query: { q: "listepoteter", lat: String(OSLO.lat), lng: String(OSLO.lng) } }))).body?.offers ?? [])
        .map((o: any) => o.producer.agent_id);
      const fo = JSON.parse(await toolText("lokal_find_offers", { items: ["listepoteter"], lat: OSLO.lat, lng: OSLO.lng }) || "[]");
      s.lokal_find_offers = (fo[0]?.offers ?? []).map((o: any) => o.producer.agent_id);
      s.llms_full_txt = idsInText((await invoke(H.llmsFull, makeReq({}))).body);
      s.sitemap = idsInSitemap(seoMod.buildSitemapXml());
      // The CACHED sitemap /sitemap.xml serves: primed by the control phase,
      // so the hidden phase only passes if POST /admin/test-producer's apply
      // invalidated it (otherwise it would serve the fixture for one TTL).
      s.sitemap_cached = idsInSitemap(seoMod.getSitemapXml());
      // /reise trip planner (rettfrabonden /reise + opplevagent /reise): its RFB
      // stops come from loadRfbCandidates() over the corridor bbox.
      s.reise_corridor = corridor.loadRfbCandidates(
        { minLat: OSLO.lat - 0.5, maxLat: OSLO.lat + 0.5, minLng: OSLO.lng - 0.5, maxLng: OSLO.lng + 0.5 }, db,
      ).map((c) => c.id);
      s.produsent_page = [];
      for (const [id, name] of ID_BY_NAME) {
        if ((await invoke(H.produsent, makeReq({ params: { slug: slugify(name) } }))).status === 200) s.produsent_page.push(id);
      }
      s.homepage = idsInText((await invoke(H.home, makeReq({}))).body);
      s.verifisert_av_eier = idsInText((await invoke(H.verified, makeReq({}))).body);
      s.city_page = idsInText((await invoke(H.city, makeReq({ params: { city: "oslo" } }))).body);
      s.find_match = ((await invoke(H.findMatch, makeReq({ query: { name: "Listetest" } }))).body?.matches ?? []).map((m: any) => m.id);
      s.outreach_pool_view = (db.prepare("SELECT agent_id FROM outreach_ready_pool").all() as Array<{ agent_id: string }>).map((r) => r.agent_id);
      s.outreach_candidates = (computeOutreachCandidates(initMod.getDb(), { mode: "first", cooldownDays: 60, limit: 100 } as any).candidates ?? [])
        .map((c: any) => c.agent_id);
      s.top_producers = analyticsService.getTopProducers(20, 24 * 365).map((p) => p.agentId);
      for (const [key, h] of [["card", H.card], ["info", H.info], ["vcard", H.vcard], ["trust", H.trust], ["agent_stats", H.agentStats]] as Array<[string, Function]>) {
        s[key] = [];
        for (const id of ALL) if (await ok200(h, id)) s[key].push(id);
      }
      // Count-only surfaces: the A2A card / agents.json / stats report how many
      // listable producers there are — mapped back to "the expected set" below.
      s.__a2a_card_count = [String((await invoke(H.a2a, makeReq({}))).body?.description ?? "")];
      s.__agents_json_count = [String((await invoke(H.agentsJson, makeReq({}))).body?.description ?? "")];
      const reg = (await invoke(H.apiStats, makeReq({}))).body?.data?.registry ?? {};
      s.__api_stats = [`${reg.totalAgents}/${reg.activeProducers}`];
      s.verifier_pickBatch = verifier.pickBatch(db, 100).map((r: any) => r.id);
      s.verifier_pickBatchBiased = verifier.pickBatchBiased(db, 100).map((r: any) => r.id);
      s.verifier_pickByIds = verifier.pickByIds(db, ALL).map((r: any) => r.id);
      return s;
    }
    const VERIFIER_SURFACES = new Set(["verifier_pickBatch", "verifier_pickBatchBiased", "verifier_pickByIds"]);

    // ══ Phase 1 — CONTROL: fixture not hidden yet → present everywhere ══════
    const pre = await snapshot();
    for (const [surface, ids] of Object.entries(pre)) {
      if (surface.startsWith("__")) continue;
      assertTrue(ids.includes(NORMAL_ID), `ac3-control: normal row present on ${surface} (got ${JSON.stringify(ids)})`);
      assertTrue(ids.includes(LEGACY_ID), `ac3-control: not-yet-hidden fixture present on ${surface} — the hidden-phase check below is not vacuous (got ${JSON.stringify(ids)})`);
      if (VERIFIER_SURFACES.has(surface)) {
        assertTrue(ids.includes(DENTAL_ID), `vertical: verifier pickers are hidden-only — dental row still picked by ${surface} (vertical behaviour unchanged)`);
      } else {
        assertTrue(!ids.includes(DENTAL_ID), `vertical: dental-vertical row absent from RFB surface ${surface} (got ${JSON.stringify(ids)})`);
      }
    }
    assertTrue(/\b2\+/.test(pre.__a2a_card_count[0]), `vertical: /a2a card counts the 2 RFB rows, not the dental one (${pre.__a2a_card_count[0]})`);
    assertTrue(/with 2\+ producers/.test(pre.__agents_json_count[0]), `vertical: agents.json counts 2 RFB producers (${pre.__agents_json_count[0]})`);
    assertEq(pre.__api_stats[0], "2/2", "vertical: /api/stats totalAgents/activeProducers exclude the dental row");
    assertEq(marketplaceRegistry.getStats().cities.length, 1, "vertical: stats cities still counted (Oslo)");

    // ══ AC4 — non-fixture rows are refused, with zero writes ═══════════════
    const snapshotRow = (id: string) => JSON.stringify(db.prepare(
      `SELECT a.*, k.verification_status, k.verified_second_line FROM agents a LEFT JOIN agent_knowledge k ON k.agent_id = a.id WHERE a.id = ?`,
    ).get(id));
    const auditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as { n: number }).n;
    {
      const beforeNormal = snapshotRow(NORMAL_ID);
      const beforeDental = snapshotRow(DENTAL_ID);
      const beforeAudit = auditCount();
      let r = await postTp({ agent_id: NORMAL_ID, email: FIXTURE_EMAIL });
      assertEq(r.status, 409, "ac4-1: dry-run against a real producer id → 409");
      assertEq(r.body?.error, "not_a_test_fixture", "ac4-2: error names the refusal");
      r = await postTp({ agent_id: NORMAL_ID, email: FIXTURE_EMAIL, apply: true });
      assertEq(r.status, 409, "ac4-3: apply against a real producer id → 409");
      r = await postTp({ agent_id: NORMAL_ID, mode: "retire", apply: true });
      assertEq(r.status, 409, "ac4-4: retire against a real producer id → 409");
      r = await postTp({ agent_id: NORMAL_ID, apply: true });
      assertEq(r.status, 409, "ac4-5: the fixture guard runs before the email check (no email still → 409, not 400)");
      r = await postTp({ agent_id: DENTAL_ID, email: FIXTURE_EMAIL, apply: true });
      assertEq(r.status, 409, "ac4-6: a dental row is refused too");
      assertEq(snapshotRow(NORMAL_ID), beforeNormal, "ac4-7: the real producer's row is byte-identical after every refused call");
      assertEq(snapshotRow(DENTAL_ID), beforeDental, "ac4-8: the dental row is untouched");
      assertEq(auditCount(), beforeAudit, "ac4-9: no audit row written by refused calls");
      r = await postTp({ agent_id: "no-such-agent", email: FIXTURE_EMAIL });
      assertEq(r.status, 404, "ac4-10: unknown id → 404");
      r = await postTp({ email: FIXTURE_EMAIL }, null);
      assertEq(r.status, 403, "ac4-11: no X-Admin-Key → 403");
      r = await postTp({ email: FIXTURE_EMAIL }, "wrong-key");
      assertEq(r.status, 403, "ac4-12: wrong X-Admin-Key → 403");
      r = await postTp({ mode: "delete", email: FIXTURE_EMAIL });
      assertEq(r.status, 400, "ac4-13: unknown mode → 400");
      r = await postTp({});
      assertEq(r.status, 400, "ac4-14: arm without email → 400");
      r = await postTp({ email: "not-an-email" });
      assertEq(r.status, 400, "ac4-15: arm with a malformed email → 400");
    }

    // ══ AC1 — dry-run then apply: adopt the legacy pilot row as THE fixture ═
    {
      const beforeAudit = auditCount();
      let r = await postTp({ email: FIXTURE_EMAIL });
      assertEq(r.status, 200, "ac1-1: dry-run (default) → 200");
      assertEq(r.body?.dry_run, true, "ac1-2: dry-run is the default");
      assertEq(r.body?.target, "adopt_legacy", "ac1-3: with no fixture row yet, the legacy pilot row is the target");
      assertEq(r.body?.agent_id, LEGACY_ID, "ac1-4: the legacy id is reported");
      assertTrue((r.body?.changes ?? []).some((c: any) => c.field === "catalog_hidden" && c.old === "0" && c.new === "1"), "ac1-5: plan shows catalog_hidden 0 → 1");
      assertEq((db.prepare("SELECT catalog_hidden, origin FROM agents WHERE id = ?").get(LEGACY_ID) as any), { catalog_hidden: 0, origin: "discovery" }, "ac1-6: dry-run wrote nothing");
      assertEq(auditCount(), beforeAudit, "ac1-7: dry-run wrote no audit row");

      r = await postTp({ email: FIXTURE_EMAIL, apply: true });
      assertEq(r.status, 200, "ac1-8: apply → 200");
      assertEq(r.body?.agent_id, LEGACY_ID, "ac1-9: apply returns the fixture id");
      assertEq(r.body?.can_order, true, "ac1-10: the UNCHANGED strict gate now passes for the fixture (data set, not exempted)");
      const row = db.prepare("SELECT origin, catalog_hidden, is_active, is_verified, order_notifications_opt_in, order_notification_email FROM agents WHERE id = ?").get(LEGACY_ID) as any;
      assertEq(row, { origin: "test_fixture", catalog_hidden: 1, is_active: 1, is_verified: 1, order_notifications_opt_in: 1, order_notification_email: FIXTURE_EMAIL }, "ac1-11: fixture row state");
      const auditRows = db.prepare("SELECT field_name, changed_by FROM agent_knowledge_audit WHERE agent_id = ?").all(LEGACY_ID) as any[];
      assertEq(auditRows.length, r.body?.audit_rows, "ac1-12: one audit row per reported change");
      assertTrue(auditRows.every((a) => a.changed_by === "admin") && auditRows.some((a) => a.field_name === "catalog_hidden"), "ac1-13: audit rows are admin-attributed and include catalog_hidden");

      const p = await invoke(H.products, makeReq({ params: { id: LEGACY_ID } }));
      assertEq(p.status, 200, "ac1-14: GET /catalog/agents/<fixture>/products still answers by id");
      const tp = (p.body?.products ?? []).find((x: any) => x.name === "Testpoteter (kun test)");
      assertEq(tp?.availability, "in_stock", "ac1-15: «Testpoteter (kun test)» is listed in_stock");

      assertEq(cartSvc.isProducerEligible(LEGACY_ID), true, "gates-1: isProducerEligible(fixture) true via its data");
      assertEq(cartSvc.isEligibleForRealOrder(LEGACY_ID), true, "gates-2: isEligibleForRealOrder(fixture) true via its data");
      const rec = notifySvc.resolveOrderNotificationRecipient(LEGACY_ID);
      assertEq(rec, { eligible: true, email: FIXTURE_EMAIL, via: "admin_override" }, "gates-3: the notification goes to the override address only");
    }

    // ══ AC3 — hidden: absent from every public surface; normal row stays ════
    const post = await snapshot();
    for (const [surface, ids] of Object.entries(post)) {
      if (surface.startsWith("__")) continue;
      assertTrue(ids.includes(NORMAL_ID), `ac3: normal row still present on ${surface} (got ${JSON.stringify(ids)})`);
      assertTrue(!ids.includes(LEGACY_ID), `ac3: hidden fixture ABSENT from ${surface} (got ${JSON.stringify(ids)})`);
      if (!VERIFIER_SURFACES.has(surface)) {
        assertTrue(!ids.includes(DENTAL_ID), `vertical: dental row still absent from ${surface}`);
      }
    }
    assertTrue(/\b1\+/.test(post.__a2a_card_count[0]), `ac3: /a2a card no longer counts the fixture (${post.__a2a_card_count[0]})`);
    assertTrue(/with 1\+ producers/.test(post.__agents_json_count[0]), `ac3: agents.json no longer counts the fixture (${post.__agents_json_count[0]})`);
    assertEq(post.__api_stats[0], "1/1", "ac3: /api/stats counts exclude the hidden fixture");
    {
      const page = await invoke(H.produsent, makeReq({ params: { slug: slugify(FIXTURE_NAME) } }));
      assertEq(page.status, 404, "ac3: /produsent/<fixture-slug> → 404");
      assertTrue(!String(page.body).includes(FIXTURE_NAME), "ac3: the 404 page never leaks the fixture's name");
    }

    // ══ Umbrella member lists (producer side of the joins) ════════════════
    // /umbrellas/:id/members, lokal_get_umbrella_members and the umbrella
    // /produsent/ page's children (via agent_affiliations AND via
    // parent_umbrella_id). Control first with the fixture briefly un-hidden,
    // then hidden again. (The /agents/:id/card umbrella-members skill got the
    // same predicate but is not reachable here: that block reads
    // info.agent.umbrella_type, which getAgentInfo() never sets.)
    {
      const UMB_AFF = { id: "lh-umb-aff", name: "Paraplynettverket Bondeby" };
      const UMB_DIRECT = { id: "lh-umb-direct", name: "Lokallaget Bondeby" };
      for (const u of [UMB_AFF, UMB_DIRECT]) {
        db.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, categories, tags, trust_score, is_active, umbrella_type)
           VALUES (?, ?, 'Et nettverk av lokale gårder rundt Oslo.', 'test', ?, ?, 'producer', ?, 'Oslo', '[]', '[]', 0.8, 1, 'market_network')`,
        ).run(u.id, u.name, `${u.id}@example.no`, `https://${u.id}.example.no`, `key-${u.id}`);
      }
      const insAff = db.prepare("INSERT INTO agent_affiliations (producer_id, umbrella_id, status, source, labels) VALUES (?, ?, 'active', 'admin', '[]')");
      for (const id of ALL) insAff.run(id, UMB_AFF.id);
      const setParent = db.prepare("UPDATE agents SET parent_umbrella_id = ? WHERE id = ?");
      for (const id of ALL) setParent.run(UMB_DIRECT.id, id);
      const umbrellaSurfaces = async (): Promise<Record<string, string[]>> => {
        clearRegistryCaches();
        const u: Record<string, string[]> = {};
        u.umbrella_members_route = ((await invoke(H.umbMembers, makeReq({ params: { id: UMB_AFF.id } }))).body?.members ?? []).map((m: any) => m.id);
        u.lokal_get_umbrella_members = idsInText(await toolText("lokal_get_umbrella_members", { umbrellaId: UMB_AFF.id, limit: 100 }));
        u.umbrella_page_affiliations = idsInText((await invoke(H.produsent, makeReq({ params: { slug: slugify(UMB_AFF.name) } }))).body);
        u.umbrella_page_direct_children = idsInText((await invoke(H.produsent, makeReq({ params: { slug: slugify(UMB_DIRECT.name) } }))).body);
        return u;
      };
      db.prepare("UPDATE agents SET catalog_hidden = 0 WHERE id = ?").run(LEGACY_ID);
      const ctl = await umbrellaSurfaces();
      db.prepare("UPDATE agents SET catalog_hidden = 1 WHERE id = ?").run(LEGACY_ID);
      const hid = await umbrellaSurfaces();
      for (const [surface, ids] of Object.entries(ctl)) {
        assertTrue(ids.includes(NORMAL_ID) && ids.includes(LEGACY_ID), `umbrella-control: normal + un-hidden fixture present on ${surface} (got ${JSON.stringify(ids)})`);
        assertTrue(!ids.includes(DENTAL_ID), `vertical: dental row absent from ${surface} (got ${JSON.stringify(ids)})`);
      }
      for (const [surface, ids] of Object.entries(hid)) {
        assertTrue(ids.includes(NORMAL_ID), `umbrella: normal row still present on ${surface} (got ${JSON.stringify(ids)})`);
        assertTrue(!ids.includes(LEGACY_ID), `umbrella: hidden fixture ABSENT from ${surface} (got ${JSON.stringify(ids)})`);
        assertTrue(!ids.includes(DENTAL_ID), `vertical: dental row still absent from ${surface}`);
      }
      db.prepare("DELETE FROM agent_affiliations WHERE umbrella_id = ?").run(UMB_AFF.id);
      for (const id of ALL) setParent.run(null, id);
      for (const u of [UMB_AFF, UMB_DIRECT]) db.prepare("DELETE FROM agents WHERE id = ?").run(u.id);
      clearRegistryCaches();
    }

    // ══ AC2 — the direct-id order flow (MCP lokal_info + cart tools) ══════
    {
      const info = await toolText("lokal_info", { agentId: LEGACY_ID });
      assertTrue(info.includes("Testpoteter (kun test)"), "ac2-1: lokal_info by id still describes the hidden fixture's product");
      const productId = (db.prepare("SELECT id FROM products WHERE agent_id = ? AND name_norm = 'testpoteter (kun test)'").get(LEGACY_ID) as any)?.id;
      assertTrue(!!productId, "ac2-2: the fixture product exists in the catalog");
      const created = JSON.parse(await toolText("lokal_cart_create", {}));
      const cartId = String(created?.cart_id ?? "");
      const buyerRef = String(created?.buyer_ref ?? "");
      assertTrue(!!cartId && !!buyerRef, `ac2-3: lokal_cart_create returned a cart + buyer token`);
      const added = JSON.parse(await toolText("lokal_cart_add_item", { cart_id: cartId, buyer_ref: buyerRef, product_id: productId, qty: 2 }));
      assertEq(added?.success, true, `ac2-4: lokal_cart_add_item accepted the hidden fixture's product by id (${JSON.stringify(added?.error ?? "")})`);
      const before = sent.length;
      const submitted = JSON.parse(await toolText("lokal_cart_submit", {
        cart_id: cartId, buyer_ref: buyerRef, buyer_name: "Test Kjøper", buyer_email: "kjoper@example.no", contact_consent: true,
      }));
      assertEq(submitted?.success, true, `ac2-5: lokal_cart_submit succeeded (${JSON.stringify(submitted?.error ?? "")})`);
      assertEq((submitted?.contact_handoffs ?? []).length, 0, "ac2-6: 0 contact handoffs");
      const orders = db.prepare("SELECT agent_id, buyer_name FROM orders WHERE cart_id = ?").all(cartId) as any[];
      assertEq(orders.length, 1, "ac2-7: exactly one REAL order row");
      assertEq(orders[0]?.agent_id, LEGACY_ID, "ac2-8: …for the hidden fixture");
      assertEq(orders[0]?.buyer_name, "Test Kjøper", "ac2-9: consented buyer contact copied onto the order");
      for (let i = 0; i < 20 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      assertEq(sent.slice(before).map((m) => m.to), [FIXTURE_EMAIL], "ac2-10: the order e-mail went ONLY to the override address");
    }

    // ══ AC6 — retire / re-arm, idempotent ═════════════════════════════════
    {
      const state = () => db.prepare(
        `SELECT a.is_active, p.availability FROM agents a JOIN products p ON p.agent_id = a.id AND p.name_norm = 'testpoteter (kun test)' WHERE a.id = ?`,
      ).get(LEGACY_ID) as any;
      let r = await postTp({ mode: "retire", apply: true });
      assertEq(r.status, 200, "ac6-1: retire → 200");
      assertEq(state(), { is_active: 0, availability: "out_of_stock" }, "ac6-2: retired: inactive + out_of_stock");
      assertEq(cartSvc.isEligibleForRealOrder(LEGACY_ID), false, "ac6-3: a retired fixture can no longer receive real orders");
      const auditAfterRetire = auditCount();
      r = await postTp({ mode: "retire", apply: true });
      assertEq(r.status, 200, "ac6-4: retire again → 200");
      assertEq(r.body?.changes, [], "ac6-5: second retire reports no changes");
      assertEq(auditCount(), auditAfterRetire, "ac6-6: second retire writes no audit row");
      r = await postTp({ email: FIXTURE_EMAIL, apply: true });
      assertEq(r.body?.target, "existing", "ac6-7: arm now targets the existing fixture (no second adoption)");
      assertEq(state(), { is_active: 1, availability: "in_stock" }, "ac6-8: re-armed: active + in_stock");
      assertEq(r.body?.can_order, true, "ac6-9: re-armed fixture can order again");
      const auditAfterArm = auditCount();
      r = await postTp({ email: FIXTURE_EMAIL, apply: true });
      assertEq(r.body?.changes, [], "ac6-10: arming an armed fixture changes nothing");
      assertEq(auditCount(), auditAfterArm, "ac6-11: …and writes no audit row");
      r = await postTp({ agent_id: LEGACY_ID, email: FIXTURE_EMAIL });
      assertEq(r.status, 200, "ac6-12: explicit agent_id of the fixture is accepted");
      clearRegistryCaches();
      assertTrue(!marketplaceRegistry.getActiveAgents().some((a) => a.id === LEGACY_ID), "ac6-13: still hidden after re-arm");
    }

    // ══ Create path (no legacy row) + multiple-fixture refusal — own DB ════
    {
      initMod.__setDbForTesting(db2 as any);
      initMod.__initSchemaForTesting(db2 as any);
      seedProducer(db2, { id: NORMAL_ID, name: NORMAL_NAME });
      let r = await postTp({ email: FIXTURE_EMAIL });
      assertEq(r.body?.target, "create", "create-1: no fixture and no legacy row → plan is create");
      assertEq((db2.prepare("SELECT COUNT(*) AS n FROM agents").get() as any).n, 1, "create-2: dry-run created nothing");
      r = await postTp({ mode: "retire", apply: true });
      assertEq(r.status, 404, "create-3: retire with no fixture → 404");
      r = await postTp({ email: FIXTURE_EMAIL, apply: true });
      assertEq(r.status, 200, "create-4: apply creates the fixture");
      const newId = r.body?.agent_id as string;
      const row = db2.prepare("SELECT origin, catalog_hidden, is_active, vertical_id FROM agents WHERE id = ?").get(newId) as any;
      assertEq(row, { origin: "test_fixture", catalog_hidden: 1, is_active: 1, vertical_id: "rfb" }, "create-5: new row is a hidden rfb test fixture");
      assertEq(r.body?.can_order, true, "create-6: the new fixture passes the unchanged strict gate");
      r = await postTp({ email: FIXTURE_EMAIL, apply: true });
      assertEq([r.body?.target, r.body?.agent_id], ["existing", newId], "create-7: second call reuses the same fixture");
      assertEq((db2.prepare("SELECT COUNT(*) AS n FROM agents WHERE origin = 'test_fixture'").get() as any).n, 1, "create-8: still exactly one fixture row");
      clearRegistryCaches();
      assertTrue(!marketplaceRegistry.getActiveAgents().some((a) => a.id === newId), "create-9: the created fixture is hidden from public lists");
      db2.prepare("UPDATE agents SET origin = 'test_fixture', catalog_hidden = 1 WHERE id = ?").run(NORMAL_ID);
      const beforeAudit = (db2.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n;
      r = await postTp({ email: FIXTURE_EMAIL, apply: true });
      assertEq([r.status, r.body?.error], [409, "multiple_test_fixtures"], "create-10: two fixture rows → 409, caller must name one");
      assertEq((db2.prepare("SELECT COUNT(*) AS n FROM agent_knowledge_audit").get() as any).n, beforeAudit, "create-11: …and nothing was written");
      initMod.__setDbForTesting(db as any);
    }

    // ══ Gates byte-identical ═════════════════════════════════════════════
    {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const repoRoot = path.resolve(__dirname, "../..");
      let gitRef: string | null = null;
      const { execFileSync } = require("child_process") as typeof import("child_process");
      for (const ref of ["origin/main", "main"]) {
        try {
          execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
          gitRef = ref;
          break;
        } catch { /* try next */ }
      }
      for (const pin of GATE_SOURCE_PINS) {
        const src = fs.readFileSync(path.join(repoRoot, pin.file), "utf8");
        const body = extractExportedFunctionSource(src, pin.fn);
        assertTrue(!!body, `gates-src: ${pin.fn} located in ${pin.file}`);
        const sha = body ? createHash("sha256").update(body).digest("hex") : "";
        assertEq(sha, pin.sha256, `gates-pin: ${pin.fn} source is byte-identical to the pinned main version`);
        if (gitRef) {
          try {
            const mainSrc = execFileSync("git", ["-C", repoRoot, "show", `${gitRef}:${pin.file}`], { encoding: "utf8" });
            assertEq(body, extractExportedFunctionSource(mainSrc, pin.fn), `gates-git: git diff of ${pin.fn} against ${gitRef} is empty`);
          } catch { /* shallow/partial clone without the blob — the pin above still holds */ }
        }
      }
    }
  } catch (err) {
    failed++;
    failures.push(`rfb-hidden-test-producer: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    try { notifySvc.__setOrderNotifySendForTesting(null); } catch { /* ignore */ }
    try { geo.__setGeocodingFetchForTesting(undefined); geo.__clearGeocodeCacheForTesting(); } catch { /* ignore */ }
    clearRegistryCaches();
    if (prevDb) initMod.__setDbForTesting(prevDb);
    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    try { db.close(); } catch { /* ignore */ }
    try { db2.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── dev-request 2026-10-01-rfb-skjult-testprodusent-for-ordreflyt: hidden test producer + listing honesty ──");
  runRfbHiddenTestProducerTests({ log: true }).then((r) => {
    console.log(`\nrfb-hidden-test-producer: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
