/**
 * owner-features-s2c2.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2c-2: the six «Hvem kan finne deg» keys (visibility.*) enforced through
 * the shared predicate in services/agent-visibility.ts.
 *
 *   gate      OWNER_FEATURES_ENFORCE off, or the profile not in
 *             OWNER_FEATURES_ALLOWED_SUBJECTS → every surface byte-identical to
 *             the run before any choice was stored, the shared SQL fragments
 *             unchanged, and no query for the lookup. With the real registry
 *             (keys still coming_soon) a stored owner choice has no effect; an
 *             admin lock does.
 *   matrix    AC12/AC23: per key × declared surface × endpoint, default → off →
 *             on again: the profile present / gone / present. Every endpoint of
 *             a surface the key does NOT declare stays present (the key does
 *             exactly what it says). A neighbour outside the allowlist with
 *             every key stored off is never affected.
 *   adapter   visibility.profile ↔ owner_profile_pause: one truth.
 *   details   «Midlertidig pause» + noindex, the owner's own /info read, the
 *             EN redirect, noindex meta + header, hreflang.
 *   batch     a list surface pays one lookup per request, whatever its length.
 *
 * Real routers/services on the production schema in an in-memory DB; handlers
 * pulled off the router stacks (same harness as owner-features-s2c.test.ts).
 * Exported runOwnerFeaturesS2c2Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s2c2.test.ts
 */

import Database from "better-sqlite3";
import { slugify } from "../utils/slug";

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

const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ENFORCE_ENV = "OWNER_FEATURES_ENFORCE";
const PAUSE_ENV = "OWNER_PAUSE_ENABLED";
const LANG_REDIRECT_ENV = "LANG_COOKIE_REDIRECT_ENABLED";
const ENF_ID = "s2c2-owned";
const TWIN_ID = "s2c2-twin";
const NAMES: Record<string, string> = {
  [ENF_ID]: "Synlighetsprove Gard Eier",
  [TWIN_ID]: "Synlighetsprove Gard Tvilling",
};
const VIS_KEYS = [
  "visibility.profile",
  "visibility.ai_assistants",
  "visibility.search_engines",
  "visibility.shopping_feeds",
  "visibility.english",
  "visibility.leaderboard",
] as const;

function seedProducer(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, '2026-10-01T00:00:00.000Z')`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, phone, address, postal_code, about, products, verification_status, verified_second_line,
        enrichment_status, url_last_status, url_last_probed, last_verified_at)
     VALUES (?, ?, ?, '+47 912 34 567', 'Gardsvegen 12', '0150', ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([{ name: "Listepoteter", price: "30 kr/kg", category: "vegetables" }]),
  );
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url)
     VALUES (?, ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg')`,
  ).run(`prod-${id}`, id);
  db.prepare(
    `INSERT OR REPLACE INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen) VALUES (?, 10, 5, 3)`,
  ).run(id);
}

type Probe = (id: string) => Promise<boolean[]>;
interface EndpointCase { probe: Probe }

export async function runOwnerFeaturesS2c2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of [ALLOW_ENV, ENFORCE_ENV, PAUSE_ENV, LANG_REDIRECT_ENV]) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string>; body?: any; lang?: string }): any {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }
  function invoke(handler: Function, req: any): Promise<HandlerResult> {
    return new Promise((resolve) => {
      let status = 200;
      let settled = false;
      const headers: Record<string, string> = {};
      const settle = (body: any) => { if (!settled) { settled = true; resolve({ status, body, headers }); } };
      const res: any = {
        status(c: number) { status = c; return res; },
        json(p: any) { settle(p); return res; },
        send(p: any) { settle(p); return res; },
        redirect(c: number, loc: string) { status = c; settle({ __redirect: loc }); return res; },
        end() { settle(undefined); return res; },
        header(k: string, v: string) { headers[String(k).toLowerCase()] = String(v); return res; },
        set() { return res; }, type() { return res; },
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

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./mcp", "./a2a", "./discovery"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  const vis = require("../owner-features/visibility") as typeof import("../owner-features/visibility");
  const av = require("../services/agent-visibility") as typeof import("../services/agent-visibility");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();
    for (const k of [ALLOW_ENV, ENFORCE_ENV, PAUSE_ENV, LANG_REDIRECT_ENV]) setEnv(k, null);

    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const seoMod = require("./seo") as typeof import("./seo");
    const seoRouter = seoMod.default as any;
    const a2aRouter = require("./a2a").default as any;
    const discoveryRouter = require("./discovery").default as any;
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");

    const tools = new Map<string, (args: any) => Promise<any>>();
    const resources = new Map<string, (uri: URL) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource(name: string, _uri: any, _meta: any, handler: any) { resources.set(name, handler); },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");

    const H = {
      search: findRouteHandler(marketplaceRouter, "/search", "get"),
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      home: findRouteHandler(seoRouter, "/", "get"),
      city: findRouteHandler(seoRouter, "/:city", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
      leaderboard: findRouteHandler(a2aRouter, "/api/leaderboard", "get"),
      llms: findRouteHandler(discoveryRouter, "/llms.txt", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
    };

    seedProducer(db, ENF_ID);
    seedProducer(db, TWIN_ID);
    const OWNER_CLAIM = "s2c2-owner-claim";
    for (const [cid, aid, tok] of [["claim-s2c2", ENF_ID, OWNER_CLAIM], ["claim-s2c2-twin", TWIN_ID, "s2c2-twin-claim"]]) {
      db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at) VALUES (?, ?, ?, ?, 'verified', ?, ?)")
        .run(cid, aid, `post@${aid}.example.no`, "Eier", tok, new Date(Date.now() + 86_400_000).toISOString());
    }

    // ── Surface readers ───────────────────────────────────────────────────
    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const slug = (id: string) => slugify(NAMES[id]);
    const pageRes = (id: string, lang = "no") => invoke(H.produsent, makeReq({ params: { slug: slug(id) }, lang }));
    const page = async (id: string, lang = "no") => String((await pageRes(id, lang)).body ?? "");
    const jsonLdOf = (html: string) => [...html.matchAll(LD_RE)].map((m) => m[1]).join("\n");
    const isProfilePage = (html: string, id: string) => html.includes(NAMES[id]) && html.includes("familiegård") && !html.includes("Midlertidig pause");
    const listBlock = (text: string, id: string) => text.split("\n\n").find((b) => b.includes(`. ${NAMES[id]}`)) ?? "";
    const searchBlock = (text: string, id: string) => text.includes(`**1. ${NAMES[id]}**`) ? text : "";
    const home = async () => String((await invoke(H.home, makeReq({}))).body ?? "");
    const cityHtml = async () => String((await invoke(H.city, makeReq({ params: { city: "oslo" } }))).body ?? "");
    const cityNode = async (id: string) => {
      const found: any[] = [];
      const walk = (x: any) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          if (x["@type"] === "LocalBusiness" && x.name === NAMES[id]) found.push(x);
          Object.values(x).forEach(walk);
        }
      };
      for (const m of (await cityHtml()).matchAll(LD_RE)) { try { walk(JSON.parse(m[1])); } catch { /* not JSON */ } }
      return found[0];
    };
    const findOffer = async (id: string) => {
      const t = await toolText("lokal_find_offers", { items: ["listepoteter"], lat: 59.9139, lng: 10.7522 });
      let parsed: any;
      try { parsed = JSON.parse(t); } catch { return undefined; }
      const offers = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((x: any) => x?.offers ?? []);
      return offers.find((o: any) => o?.producer?.agent_id === id);
    };
    const resource = async (id: string) => {
      const r = await resources.get("producer-detail")!(new URL(`lokal://producers/${id}`));
      try { return JSON.parse(String(r?.contents?.[0]?.text ?? "")); } catch { return undefined; }
    };
    const a2aCall = (body: any) => invoke(H.a2a, makeReq({ body: { jsonrpc: "2.0", id: 1, ...body } }));
    const a2aSearch = async (id: string) =>
      JSON.stringify((await a2aCall({ method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: NAMES[id] }] } } })).body ?? "");
    const sitemap = () => seoMod.buildSitemapXml();
    const json = (x: unknown) => JSON.stringify(x ?? null);

    // Every endpoint, grouped by registry surface: a probe → markers of THIS
    // producer being there ("shown" = all true, "absent" = all false).
    const PRESENCE: Record<string, Record<string, EndpointCase>> = {
      profile_html: { produsent: { probe: async (id) => [isProfilePage(await page(id), id)] } },
      json_ld: { produsent: { probe: async (id) => [jsonLdOf(await page(id)).includes(`"name":"${NAMES[id]}"`)] } },
      listing_html: {
        home_cards: { probe: async (id) => [(await home()).includes(`href="/produsent/${slug(id)}"`)] },
        city_jsonld: { probe: async (id) => [!!(await cityNode(id))] },
      },
      mcp_search: {
        lokal_search_detail: { probe: async (id) => [searchBlock(await toolText("lokal_search", { query: NAMES[id] }), id) !== ""] },
        lokal_search_compact: { probe: async (id) => [listBlock(await toolText("lokal_search", { query: "poteter" }), id) !== ""] },
        lokal_discover: { probe: async (id) => [listBlock(await toolText("lokal_discover", { categories: ["vegetables"] }), id) !== ""] },
        rest_search: { probe: async (id) => [((await invoke(H.search, makeReq({ query: { q: NAMES[id], heleNorge: "true" } }))).body?.results ?? []).some((r: any) => r.agent?.id === id)] },
        rest_discover: { probe: async (id) => [((await invoke(H.discover, makeReq({ body: { categories: ["vegetables"] } }))).body?.results ?? []).some((r: any) => r.agent?.id === id)] },
        lokal_find_offers: { probe: async (id) => [!!(await findOffer(id))] },
      },
      mcp_info: {
        lokal_info: { probe: async (id) => [(await toolText("lokal_info", { agentId: id })).includes(`# ${NAMES[id]}`)] },
        mcp_resource: { probe: async (id) => [(await resource(id))?.agent?.id === id] },
      },
      rest_card: {
        card: { probe: async (id) => [(await invoke(H.card, makeReq({ params: { id } }))).status === 200] },
        info: { probe: async (id) => [(await invoke(H.info, makeReq({ params: { id } }))).status === 200] },
      },
      vcard: { vcard: { probe: async (id) => [String((await invoke(H.vcard, makeReq({ params: { id } }))).body ?? "").includes("BEGIN:VCARD")] } },
      acp_feed: {
        feed: { probe: async (id) => [((await invoke(H.feed, makeReq({}))).body?.items ?? []).some((i: any) => i.seller?.agent_id === id)] },
        acp_csv: { probe: async (id) => [String((await invoke(H.acp, makeReq({}))).body ?? "").includes(`prod-${id}`)] },
      },
      sitemap: { sitemap_xml: { probe: async (id) => [sitemap().includes(`/produsent/${slug(id)}</loc>`)] } },
      llms: {
        llms_txt: { probe: async (id) => [String((await invoke(H.llms, makeReq({}))).body ?? "").includes(slug(id))] },
        llms_full: { probe: async (id) => [String((await invoke(H.llmsFull, makeReq({}))).body ?? "").includes(NAMES[id])] },
      },
      a2a: {
        agent_info: { probe: async (id) => [!!(await a2aCall({ method: "agent/info", params: { agentId: id } })).body?.result] },
        a2a_search: { probe: async (id) => [(await a2aSearch(id)).includes(id)] },
      },
      leaderboard: { api_leaderboard: { probe: async (id) => [((await invoke(H.leaderboard, makeReq({}))).body?.data ?? []).some((r: any) => r.agentId === id)] } },
    };

    // Per key: its declared surfaces, probed with the key's own meaning where
    // it differs from "present" (search engines: indexable; english: the EN page).
    const SPECIAL: Record<string, Record<string, Record<string, EndpointCase>>> = {
      "visibility.search_engines": {
        profile_html: {
          produsent: {
            probe: async (id) => {
              const r = await pageRes(id);
              const html = String(r.body ?? "");
              return [!html.includes('<meta name="robots" content="noindex">'), r.headers["x-robots-tag"] === undefined];
            },
          },
        },
      },
      "visibility.english": {
        profile_html: {
          produsent_en: { probe: async (id) => { const r = await pageRes(id, "en"); return [r.status === 200 && isProfilePage(String(r.body ?? ""), id)]; } },
          produsent_hreflang: { probe: async (id) => { const h = await page(id); return [h.includes(`hreflang="en" href="https://rettfrabonden.com/en/produsent/${slug(id)}"`), h.includes(`<a href="https://rettfrabonden.com/en/produsent/${slug(id)}" hreflang="en"`)]; } },
        },
        json_ld: { produsent_en: { probe: async (id) => [jsonLdOf(String((await pageRes(id, "en")).body ?? "")).includes(`"name":"${NAMES[id]}"`)] } },
        sitemap: { sitemap_xml: { probe: async (id) => [sitemap().includes(`/en/produsent/${slug(id)}</loc>`), sitemap().includes(`hreflang="en" href="https://rettfrabonden.com/en/produsent/${slug(id)}"`)] } },
      },
    };
    const casesFor = (key: string): Record<string, Record<string, EndpointCase>> => {
      const e = reg.getOwnerFeature(key);
      const out: Record<string, Record<string, EndpointCase>> = {};
      for (const s of e.surfaces) out[s] = SPECIAL[key]?.[s] ?? PRESENCE[s] ?? {};
      return out;
    };
    const flat = (m: Record<string, Record<string, EndpointCase>>) =>
      Object.entries(m).flatMap(([surface, eps]) => Object.entries(eps).map(([ep, c]) => ({ label: `${surface}/${ep}`, c })));
    const state = async (c: EndpointCase, id: string): Promise<string> => {
      const m = await c.probe(id);
      return m.every(Boolean) ? "shown" : m.some(Boolean) ? "mixed" : "absent";
    };

    // ── Coverage (AC23) ───────────────────────────────────────────────────
    {
      const missing: string[] = [];
      for (const key of VIS_KEYS) {
        for (const s of reg.getOwnerFeature(key).surfaces) {
          const eps = casesFor(key)[s];
          if (!eps || Object.keys(eps).length === 0) missing.push(`${key} × ${s}`);
        }
      }
      assertEq(missing, [], "coverage-1: every visibility key has a probe for each declared surface");
      for (const key of VIS_KEYS) {
        assertEq(reg.getOwnerFeature(key).status, "coming_soon", `status-1: ${key} stays coming_soon until the S2d switch probe`);
        assertEq(reg.getOwnerFeature(key).default, { owner: true, unclaimed: true }, `status-2: ${key} defaults to shown for both segments`);
      }
      assertEq(reg.getOwnerFeature("visibility.profile").storage?.column, "owner_profile_pause", "registry-1: visibility.profile is stored as the owner pause");
      for (const key of VIS_KEYS.slice(1)) {
        assertTrue(reg.getOwnerFeature(key).requires.includes("visibility.profile"), `registry-2: ${key} requires visibility.profile`);
      }
    }

    // ── Snapshot of every endpoint (both producers), for byte identity ─────
    async function snapshot(id: string): Promise<Record<string, string>> {
      clearRegistryCaches();
      const strip = (s: string) => s.replace(/^REV:.*$/m, "REV:x").replace(/generated-at: [^ ]+/, "generated-at: x")
        .replace(/"timestamp":"[^"]+"/g, '"timestamp":"x"').replace(/"times(Discovered|Contacted)":\d+/g, '"times$1":0');
      const out: Record<string, string> = {};
      out.page_no = await page(id);
      const en = await pageRes(id, "en");
      out.page_en = `${en.status} ${String(en.body ?? json(en.body))}`;
      out.page_headers = json((await pageRes(id)).headers);
      out.home = await home();
      out.city = await cityHtml();
      out.lokal_search = await toolText("lokal_search", { query: NAMES[id] });
      out.lokal_search_compact = await toolText("lokal_search", { query: "poteter" });
      out.lokal_discover = await toolText("lokal_discover", { categories: ["vegetables"] });
      out.lokal_find_offers = await toolText("lokal_find_offers", { items: ["listepoteter"], lat: 59.9139, lng: 10.7522 });
      out.lokal_info = await toolText("lokal_info", { agentId: id });
      out.mcp_resource = json(await resource(id));
      out.rest_search = json((await invoke(H.search, makeReq({ query: { q: NAMES[id], heleNorge: "true" } }))).body?.results);
      out.rest_discover = json((await invoke(H.discover, makeReq({ body: { categories: ["vegetables"] } }))).body?.results);
      out.card = json(await invoke(H.card, makeReq({ params: { id } })));
      out.info = json(await invoke(H.info, makeReq({ params: { id } })));
      out.vcard = strip(String((await invoke(H.vcard, makeReq({ params: { id } }))).body ?? ""));
      out.feed = json((await invoke(H.feed, makeReq({}))).body?.items);
      out.acp_csv = String((await invoke(H.acp, makeReq({}))).body ?? "");
      out.sitemap = sitemap();
      out.llms_txt = strip(String((await invoke(H.llms, makeReq({}))).body ?? ""));
      out.llms_full = strip(String((await invoke(H.llmsFull, makeReq({}))).body ?? ""));
      out.a2a_info = strip(json((await a2aCall({ method: "agent/info", params: { agentId: id } })).body?.result));
      out.leaderboard = strip(json((await invoke(H.leaderboard, makeReq({}))).body));
      return out;
    }
    const sameSnapshot = (a: Record<string, string>, b: Record<string, string>, label: string) => {
      for (const k of Object.keys(a)) {
        if (process.env.S2C2_DEBUG && a[k] !== b[k]) {
          let i = 0; while (i < a[k].length && a[k][i] === b[k][i]) i++;
          console.info(`DIFF ${label} ${k}: ${JSON.stringify(a[k].slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(String(b[k]).slice(Math.max(0, i - 60), i + 60))}`);
        }
        assertTrue(a[k] === b[k], `${label}: ${k} byte-identical`);
      }
    };

    const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e) =>
      (VIS_KEYS as readonly string[]).includes(e.key) ? { ...e, status: "live" as const } : e);
    const setChoice = (id: string, key: string, value: unknown) => {
      const r = rs.setOwnerFeatureValue("rfb", id, key, value, { actor: "owner" }, { db, registry: LIVE });
      if (r.kind !== "ok") throw new Error(`setOwnerFeatureValue(${key}) → ${r.kind}`);
    };
    const clearChoices = (id: string) => {
      db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(id);
      db.prepare("DELETE FROM owner_profile_pause WHERE agent_id = ?").run(id);
      clearRegistryCaches(); // a direct DELETE, not the adapter (which clears them itself)
    };
    // Every key off: the stored rows (and the pause row for visibility.profile).
    const hideEverything = (id: string) => {
      for (const key of [...VIS_KEYS].reverse()) setChoice(id, key, false);
    };

    // ═══ Baseline ═════════════════════════════════════════════════════════
    // The probes (A2A search) start conversations the front page shows, so
    // the baseline is taken after them.
    let baseline: Record<string, string> = {};
    let baselineTwin: Record<string, string> = {};
    {
      for (const [surface, eps] of Object.entries(PRESENCE)) {
        for (const [ep, c] of Object.entries(eps)) {
          clearRegistryCaches();
          assertEq(await state(c, ENF_ID), "shown", `base-1: ${surface}/${ep} lists the producer today`);
        }
      }
      for (const key of Object.keys(SPECIAL)) {
        for (const { label, c } of flat(SPECIAL[key])) assertEq(await state(c, ENF_ID), "shown", `base-2: ${key} × ${label} as today`);
      }
      for (const id of [ENF_ID, TWIN_ID]) await a2aSearch(id);
      baseline = await snapshot(ENF_ID);
      baselineTwin = await snapshot(TWIN_ID);
      sameSnapshot(baseline, await snapshot(ENF_ID), "base-0: two runs without choices");
    }

    // ═══ Gate: byte-identical and no query while not enforced ═════════════
    vis.__setVisibilityRegistryForTesting(LIVE);
    hideEverything(ENF_ID);
    hideEverything(TWIN_ID);
    assertTrue(!!db.prepare("SELECT 1 FROM owner_profile_pause WHERE agent_id = ?").get(ENF_ID), "gate-0: the hidden profile has its pause row (adapter)");
    {
      setEnv(ENFORCE_ENV, null);
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-1: enforce flag unset, subject allowlisted, every key off");
      setEnv(ENFORCE_ENV, "0");
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-2: enforce flag \"0\"");
      setEnv(ENFORCE_ENV, "1");
      setEnv(ALLOW_ENV, null);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-3: enforce on, allowlist empty");
      setEnv(ALLOW_ENV, `rfb:${TWIN_ID}x`);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-4: enforce on, another subject allowlisted");
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      vis.__setVisibilityRegistryForTesting(null);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-5: enforce on + allowlisted, real registry (coming_soon) → owner choices have no effect yet");
      vis.__setVisibilityRegistryForTesting(LIVE);
      const hidden = await snapshot(ENF_ID);
      assertTrue(hidden.page_no !== baseline.page_no && hidden.lokal_info !== baseline.lokal_info && hidden.sitemap !== baseline.sitemap,
        "gate-6: enforce on + allowlisted + live keys → the surfaces change");
      // A real (non-allowlisted) profile with every key stored off: as before
      // on every surface (list surfaces compared without the hidden neighbour).
      const twin = await snapshot(TWIN_ID);
      // List surfaces, and the neighbour's own page (its «related producers»
      // block no longer links the hidden profile), are compared without it.
      for (const k of ["page_no", "page_en", "home", "city", "lokal_search_compact", "lokal_discover", "lokal_find_offers", "rest_discover", "feed", "acp_csv", "sitemap", "llms_txt", "llms_full", "leaderboard"]) {
        delete twin[k];
      }
      const twinBase = { ...baselineTwin };
      for (const k of Object.keys(twinBase)) if (!(k in twin)) delete twinBase[k];
      sameSnapshot(twinBase, twin, "gate-7: a profile outside the allowlist (every key stored off) stays as before");
      for (const [surface, eps] of Object.entries(PRESENCE)) {
        for (const [ep, c] of Object.entries(eps)) {
          clearRegistryCaches();
          assertEq(await state(c, TWIN_ID), "shown", `gate-8: neighbour outside the allowlist still on ${surface}/${ep}`);
        }
      }

      // SQL fragments: byte-identical with the gate off, "" with nobody hidden.
      setEnv(ENFORCE_ENV, null);
      const offSql = av.publicListableSql("a");
      assertEq(offSql, "COALESCE(a.catalog_hidden, 0) = 0 AND COALESCE(a.vertical_id, 'rfb') = 'rfb'", "sql-1: gate off → publicListableSql unchanged");
      for (const c of av.OWNER_VISIBILITY_CHOICES) assertEq(av.notOwnerHiddenSql(c, "a"), "", `sql-2: gate off → notOwnerHiddenSql(${c}) is ""`);
      setEnv(ENFORCE_ENV, "1");
      assertEq(av.publicListableSql("a"), `${offSql} AND a.id NOT IN ('${ENF_ID}')`, "sql-3: gate on + hidden → the id list is appended (wrap-safe)");
      assertEq(av.publicListableSql("a", { ownerChoices: false }), offSql, "sql-4: ownerChoices:false (the boot-time VIEW) never carries the list");
      clearChoices(ENF_ID);
      assertEq(av.publicListableSql("a"), offSql, "sql-5: gate on, nobody hidden → publicListableSql unchanged");
      for (const c of av.OWNER_VISIBILITY_CHOICES) assertEq(av.notOwnerHiddenSql(c, "a"), "", `sql-6: nobody hidden → notOwnerHiddenSql(${c}) is ""`);
      hideEverything(ENF_ID);

      // No lookup query at all while not enforced.
      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        setEnv(ENFORCE_ENV, null);
        for (const c of av.OWNER_VISIBILITY_CHOICES) {
          av.ownerHiddenAgentIds(c); av.notOwnerHiddenSql(c, "a"); av.ownerHidesAgent(ENF_ID, c);
        }
        av.publicListableSql("a");
        av.withoutOwnerHidden([{ id: ENF_ID }], "ai_assistants");
        av.isAgentIdPubliclyVisible(db as any, ENF_ID, { surface: "ungated", audience: "ai" });
        av.isProfileOwnerHidden(db as any, ENF_ID);
        assertEq(queries, 0, "gate-9: flag off → no lookup query (list fragments, by-id, profile page)");
        setEnv(ENFORCE_ENV, "1");
        setEnv(ALLOW_ENV, null);
        queries = 0;
        for (const c of av.OWNER_VISIBILITY_CHOICES) { av.ownerHiddenAgentIds(c); av.ownerHidesAgent(ENF_ID, c); }
        av.isAgentIdPubliclyVisible(db as any, ENF_ID, { surface: "ungated", audience: "ai" });
        assertEq(queries, 0, "gate-10: allowlist empty → no lookup query");
        setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
        queries = 0;
        av.ownerHidesAgent(TWIN_ID, "profile");
        assertEq(queries, 0, "gate-11: a profile outside the allowlist → no lookup query");
        // One lookup per call, whatever the surface lists (the allowlist, not the rows, sets the cost).
        vis.__setVisibilityRegistryForTesting(null);
        queries = 0;
        av.notOwnerHiddenSql("shopping_feeds", "a");
        assertEq(queries, 1, "batch-1: a list fragment costs one query (real registry)");
        setEnv(ALLOW_ENV, `rfb:${ENF_ID},rfb:${TWIN_ID}`);
        queries = 0;
        av.notOwnerHiddenSql("shopping_feeds", "a");
        assertEq(queries, 1, "batch-2: two allowlisted profiles → still one query");
        vis.__setVisibilityRegistryForTesting(LIVE);
        queries = 0;
        const ids = av.ownerHiddenAgentIds("profile");
        assertEq(queries, 3, "batch-3: live keys → one query + the pause adapter per allowlisted profile");
        assertEq([...ids].sort(), [ENF_ID, TWIN_ID].sort(), "batch-4: both allowlisted hidden profiles in the set");
        queries = 0;
        await invoke(H.feed, makeReq({}));
        const feedQueries = queries;
        db.prepare("INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url) VALUES ('prod-extra', ?, 'Gulrot', 'gulrot', 'kg', 20, 'in_stock', 'vegetables', 'https://img.example.no/g.jpg')").run(TWIN_ID);
        db.prepare("UPDATE agent_knowledge SET verification_status = 'verified' WHERE agent_id = ?").run(TWIN_ID);
        queries = 0;
        await invoke(H.feed, makeReq({}));
        assertEq(queries, feedQueries, "batch-5: one more feed row costs no extra query (no lookup per row)");
        db.prepare("DELETE FROM products WHERE id = 'prod-extra'").run();
      } finally {
        (db as any).prepare = realPrepare;
      }
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      clearChoices(TWIN_ID);
    }

    // Admin lock takes effect even while the keys are coming_soon.
    {
      vis.__setVisibilityRegistryForTesting(null);
      clearChoices(ENF_ID);
      db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
                  VALUES ('rfb', ?, 'visibility.ai_assistants', 'false', 'admin', 1, ?)`).run(ENF_ID, new Date().toISOString());
      clearRegistryCaches();
      assertEq(await state(PRESENCE.mcp_info.lokal_info, ENF_ID), "absent", "admin-1: an admin lock hides the profile from AI with the real registry");
      assertEq(await state(PRESENCE.profile_html.produsent, ENF_ID), "shown", "admin-2: …and leaves the web page");
      clearChoices(ENF_ID);
      vis.__setVisibilityRegistryForTesting(LIVE);
    }

    // ═══ Matrix (AC12/AC23): per key, default → off → on ══════════════════
    setEnv(ENFORCE_ENV, "1");
    setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    for (const key of VIS_KEYS) {
      clearChoices(ENF_ID);
      const declared = casesFor(key);
      const declaredSurfaces = new Set(Object.keys(declared));
      // Endpoints of surfaces the key does not declare: must stay present.
      const others = Object.entries(PRESENCE).filter(([s]) => !declaredSurfaces.has(s))
        .flatMap(([surface, eps]) => Object.entries(eps).map(([ep, c]) => ({ label: `${surface}/${ep}`, c })));
      const steps: Array<[string, boolean | undefined, boolean]> = [["default", undefined, true], ["off", false, false], ["on", true, true]];
      for (const [step, value, shown] of steps) {
        if (value !== undefined) setChoice(ENF_ID, key, value);
        for (const { label, c } of flat(declared)) {
          clearRegistryCaches();
          seoMod.__resetSitemapCacheForTesting();
          assertEq(await state(c, ENF_ID), shown ? "shown" : "absent", `matrix: ${key} × ${label} ${step} → ${shown ? "shown" : "absent"}`);
          if (step === "off") assertEq(await state(c, TWIN_ID), "shown", `matrix: ${key} × ${label} off leaves the neighbour`);
        }
        if (step === "off") {
          for (const { label, c } of others) {
            clearRegistryCaches();
            assertEq(await state(c, ENF_ID), "shown", `scope: ${key} off leaves ${label}`);
          }
        }
      }
    }
    clearChoices(ENF_ID);

    // ═══ visibility.profile ↔ owner_profile_pause (one truth) ═════════════
    {
      const resolveProfile = () => rs.resolveOwnerFeature("rfb", ENF_ID, "visibility.profile", { db, registry: LIVE });
      assertEq([resolveProfile().value, resolveProfile().source], [true, "default"], "adapter-1: no pause row → visible (default)");
      setChoice(ENF_ID, "visibility.profile", false);
      const row = db.prepare("SELECT pause_until, set_by FROM owner_profile_pause WHERE agent_id = ?").get(ENF_ID) as any;
      assertEq(row, { pause_until: null, set_by: "owner" }, "adapter-2: switching it off writes the pause row (no resume date)");
      assertEq([resolveProfile().value, resolveProfile().source], [false, "owner"], "adapter-3: …and reads back as the owner's choice");
      const audit = db.prepare("SELECT old_json, new_json, actor FROM owner_feature_audit WHERE subject_id = ? AND key = 'visibility.profile' ORDER BY id DESC LIMIT 1").get(ENF_ID);
      assertEq(audit, { old_json: "true", new_json: "false", actor: "owner" }, "adapter-4: one owner_feature_audit row");
      for (const key of VIS_KEYS.slice(1)) {
        assertEq(rs.resolveOwnerFeature("rfb", ENF_ID, key, { db, registry: LIVE }).value, false, `adapter-5: profile off → ${key} resolves off (requires)`);
      }
      setChoice(ENF_ID, "visibility.profile", true);
      assertEq(db.prepare("SELECT COUNT(*) AS c FROM owner_profile_pause WHERE agent_id = ?").get(ENF_ID), { c: 0 }, "adapter-6: switching it on removes the pause row");
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      db.prepare("INSERT INTO owner_profile_pause (agent_id, paused_at, pause_until, set_by) VALUES (?, ?, ?, 'owner')").run(ENF_ID, new Date().toISOString(), tomorrow);
      assertEq(resolveProfile().value, false, "adapter-7: a pause from the /eier card (resume date tomorrow) is the switch off");
      clearRegistryCaches();
      assertEq(await state(PRESENCE.mcp_info.lokal_info, ENF_ID), "absent", "adapter-8: …and is enforced with OWNER_PAUSE_ENABLED off");
      setChoice(ENF_ID, "visibility.profile", false);
      assertEq((db.prepare("SELECT pause_until FROM owner_profile_pause WHERE agent_id = ?").get(ENF_ID) as any).pause_until, tomorrow,
        "adapter-9: switching off an already paused profile keeps its resume date (no-op)");
      db.prepare("UPDATE owner_profile_pause SET pause_until = ? WHERE agent_id = ?").run(new Date().toISOString().slice(0, 10), ENF_ID);
      assertEq(resolveProfile().value, true, "adapter-10: a resume date that has come → visible again, with no job");
      clearChoices(ENF_ID);
    }

    // ═══ Details ══════════════════════════════════════════════════════════
    {
      // visibility.profile off: «Midlertidig pause» with noindex, owner still reads /info.
      setChoice(ENF_ID, "visibility.profile", false);
      clearRegistryCaches();
      const r = await pageRes(ENF_ID);
      const html = String(r.body ?? "");
      assertTrue(r.status === 200 && html.includes("Midlertidig pause") && html.includes('<meta name="robots" content="noindex">') && r.headers["x-robots-tag"] === "noindex",
        "detail-1: profile off → «Midlertidig pause», noindex meta + X-Robots-Tag");
      assertTrue(!html.includes("912 34 567") && !html.includes("Listepoteter"), "detail-2: the pause page shows no contact or products");
      const ownerInfo = await invoke(H.info, makeReq({ params: { id: ENF_ID }, headers: { "x-claim-token": OWNER_CLAIM } }));
      assertEq(ownerInfo.status, 200, "detail-3: the owner's own /info read (X-Claim-Token) still works while hidden");
      const otherInfo = await invoke(H.info, makeReq({ params: { id: ENF_ID }, headers: { "x-claim-token": "s2c2-twin-claim" } }));
      assertEq(otherInfo.status, 404, "detail-4: another profile's claim token gets the public 404");
      assertTrue((await toolText("lokal_info", { agentId: ENF_ID })).startsWith("Fant ingen produsent"), "detail-5: lokal_info reads like an unknown id");
      clearChoices(ENF_ID);

      // visibility.english off.
      setChoice(ENF_ID, "visibility.english", false);
      const en = await pageRes(ENF_ID, "en");
      assertEq([en.status, en.body?.__redirect], [302, `/produsent/${slug(ENF_ID)}`], "detail-6: english off → /en page 302 to the Norwegian page");
      setEnv(LANG_REDIRECT_ENV, "true");
      const enSess = await pageRes(ENF_ID, "en");
      assertEq(enSess.body?.__redirect, `/produsent/${slug(ENF_ID)}?setlang=no`, "detail-7: with the language session on, the redirect clears it (no bounce back to /en)");
      setEnv(LANG_REDIRECT_ENV, null);
      const noHtml = await page(ENF_ID);
      assertTrue(!noHtml.includes('hreflang="en"') && noHtml.includes('hreflang="nb"') && noHtml.includes('hreflang="x-default"'),
        "detail-8: english off → the Norwegian page has no EN alternate or switcher link, nb + x-default stay");
      assertTrue(isProfilePage(noHtml, ENF_ID), "detail-9: …and is otherwise the full profile");
      const sm = sitemap();
      const at = sm.indexOf(`<loc>https://rettfrabonden.com/produsent/${slug(ENF_ID)}</loc>`);
      const entry = sm.slice(at, sm.indexOf("</url>", at));
      assertTrue(at > 0 && !entry.includes("xhtml:link") && !entry.includes("/en/"), "detail-10: english off → sitemap keeps the Norwegian URL without alternates");
      clearChoices(ENF_ID);

      // visibility.search_engines off.
      setChoice(ENF_ID, "visibility.search_engines", false);
      const se = await pageRes(ENF_ID);
      const seHtml = String(se.body ?? "");
      assertTrue(seHtml.includes('<meta name="robots" content="noindex">') && se.headers["x-robots-tag"] === "noindex" && isProfilePage(seHtml, ENF_ID),
        "detail-11: search engines off → the full page with noindex meta + header");
      const seEn = await pageRes(ENF_ID, "en");
      assertTrue(String(seEn.body ?? "").includes('<meta name="robots" content="noindex">'), "detail-12: …on the English page too");
      assertTrue(!sitemap().includes(`/produsent/${slug(ENF_ID)}<`), "detail-13: …and neither URL is in the sitemap");
      clearChoices(ENF_ID);

      // visibility.ai_assistants off: the A2A card gate (audience "ai") vs the web.
      setChoice(ENF_ID, "visibility.ai_assistants", false);
      assertTrue(marketplaceRegistry.isQuarantinedFromPublicView(ENF_ID, { audience: "ai" }) && !marketplaceRegistry.isQuarantinedFromPublicView(ENF_ID),
        "detail-14: ai off → the A2A card gate (/agents/:id/agent.json) hides it, the web gate does not");
      assertEq((await a2aCall({ method: "agent/info", params: { agentId: ENF_ID } })).body?.error?.message, `Agent not found: ${ENF_ID}`,
        "detail-15: ai off → A2A agent/info answers like an unknown id");
      assertTrue((await toolText("lokal_get_producer_affiliations", { producerId: ENF_ID })).startsWith("Fant ingen produsent"),
        "detail-16: ai off → lokal_get_producer_affiliations reads like an unknown id");
      clearChoices(ENF_ID);

      // Fail closed: a lookup that throws hides the allowlisted profile only.
      const prevErr = console.error;
      console.error = () => { /* expected */ };
      try {
        const throwingDb = { prepare() { throw new Error("boom"); } };
        const hidden = vis.ownerHiddenChoicesForMany(null, { db: throwingDb, env: { [ALLOW_ENV]: `rfb:${ENF_ID}` } as NodeJS.ProcessEnv });
        assertEq([...hidden.keys()], [ENF_ID], "fail-1: a failed lookup affects only the allowlisted profile");
        assertEq(hidden.get(ENF_ID)?.size, av.OWNER_VISIBILITY_CHOICES.length, "fail-2: …and hides it on every surface");
      } finally {
        console.error = prevErr;
      }
    }

    // ═══ Source: the surfaces ask the one predicate module ════════════════
    {
      const { readFileSync } = require("fs") as typeof import("fs");
      const { join } = require("path") as typeof import("path");
      const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
      const needs: Array<[string, string[]]> = [
        ["services/marketplace-registry.ts", ['opts.audience === "ai" ? notOwnerHiddenSql("ai_assistants")']],
        ["routes/marketplace-catalog.ts", ['notOwnerHiddenSql("shopping_feeds", "a")']],
        ["services/conversation-service.ts", ['notOwnerHiddenSql("leaderboard", "a")']],
        ["routes/discovery.ts", ['withoutOwnerHidden(marketplaceRegistry.getActiveAgents(), "ai_assistants")']],
        ["routes/seo.ts", ['ownerHiddenAgentIds("search_engines")', 'ownerHiddenAgentIds("english")', "isProfileOwnerHidden(getDb(), agent.id)"]],
        ["routes/a2a.ts", ['ownerHidesAgent(String(agentId), "ai_assistants")', 'audience: "ai"']],
      ];
      for (const [file, snippets] of needs) {
        const src = read(file);
        assertTrue(/from "\.{1,2}\/(services\/)?agent-visibility"/.test(src), `src-1: ${file} imports agent-visibility`);
        for (const sn of snippets) assertTrue(src.includes(sn), `src-2: ${file} uses ${sn.slice(0, 60)}`);
      }
      const routes = ["routes/seo.ts", "routes/mcp.ts", "routes/a2a.ts", "routes/marketplace.ts", "routes/marketplace-catalog.ts", "routes/discovery.ts"];
      for (const f of routes) {
        assertTrue(!/owner-features\/visibility/.test(read(f)), `src-3: ${f} does not bypass the shared predicate`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    vis.__setVisibilityRegistryForTesting(null);
    for (const k of Object.keys(prevEnv)) setEnv(k, prevEnv[k] ?? null);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS2c2Tests({ log: true }).then((r) => {
    console.info(`\nowner-features-s2c2: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
