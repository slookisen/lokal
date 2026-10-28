/**
 * as-public-view-s2d2.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2d-2 (AC22): «Vis som offentlig» for the hidden test producer.
 *
 * A valid X-Admin-Key + `?as_public=1` on a covered public RFB surface runs the
 * request in the as-public context (middleware/as-public-view.ts →
 * services/agent-visibility.ts): the fixture (origin = 'test_fixture' AND
 * catalog_hidden = 1) is evaluated as public; nothing else changes.
 *
 *   gate      no key / wrong key / key without opt-in / opt-in without key /
 *             as_public≠1 / uncovered path → byte-identical to a plain request.
 *   surfaces  key + opt-in → the fixture shows on every covered surface.
 *   never     a real catalog_hidden row and a real inactive row stay hidden
 *             (list surfaces + gated by-id + profile page), with or without key.
 *   owner     visibility.* switched off on the fixture (enforce + allowlist) →
 *             gone from that key's surfaces under as-public.
 *   headers   no-store, private + noindex on as-public answers, whatever the
 *             handler sets; plain answers keep their own headers.
 *   caches    as-public neither reads nor fills the registry/sitemap caches.
 *   sql       fragments byte-identical outside the context; no leak across
 *             concurrent async flows.
 *
 * Real routers on the production schema in an in-memory DB; handlers pulled
 * off the router stacks and run behind the real middleware (same harness as
 * owner-features-s2c2.test.ts). Exported runAsPublicViewS2d2Tests({log}) ->
 * TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/routes/as-public-view-s2d2.test.ts
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

const ADMIN_ENV = "ADMIN_KEY";
const ANALYTICS_ADMIN_ENV = "ANALYTICS_ADMIN_KEY";
const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const ENFORCE_ENV = "OWNER_FEATURES_ENFORCE";
const PAUSE_ENV = "OWNER_PAUSE_ENABLED";
const BY_ID_ENV = "OWNER_VISIBILITY_ENFORCE_BY_ID";
const KEY = "s2d2-admin-key-for-tests";

const FIX = "s2d2-fixture";
const HID = "s2d2-real-hidden";
const INA = "s2d2-real-inactive";
const PUB = "s2d2-public";
const NAMES: Record<string, string> = {
  [FIX]: "Visningsprove Gard Fixtur",
  [HID]: "Visningsprove Gard Skjult",
  [INA]: "Visningsprove Gard Inaktiv",
  [PUB]: "Visningsprove Gard Offentlig",
};

function seedProducer(
  db: Database.Database,
  id: string,
  o: { origin: string; hidden: 0 | 1; active: 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, is_vetted, claimed_at)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, ?, 1, ?, 'rfb', ?, 1, '2026-10-01T00:00:00.000Z')`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.active, o.origin, o.hidden,
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

type Mode = "plain" | "as_public" | "no_key" | "wrong_key" | "key_no_optin" | "optin_zero";

export async function runAsPublicViewS2d2Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)?.slice(0, 400)}\n    actual:   ${JSON.stringify(actual)?.slice(0, 400)}`;
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
  const ENVS = [ADMIN_ENV, ANALYTICS_ADMIN_ENV, ALLOW_ENV, ENFORCE_ENV, PAUSE_ENV, BY_ID_ENV];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENVS) prevEnv[k] = process.env[k];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  /** An Express-like request for `path` in the given mode. */
  function makeReq(path: string, mode: Mode, o: { method?: "GET" | "POST"; params?: Record<string, string>; query?: Record<string, string>; body?: any; lang?: string } = {}): any {
    const headers: Record<string, string> = {};
    const query: Record<string, string> = { ...(o.query || {}) };
    if (mode === "as_public" || mode === "no_key" || mode === "wrong_key") query.as_public = "1";
    if (mode === "optin_zero") query.as_public = "0";
    if (mode === "as_public" || mode === "key_no_optin" || mode === "optin_zero") headers["x-admin-key"] = KEY;
    if (mode === "wrong_key") headers["x-admin-key"] = KEY + "-wrong";
    const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const url = qs ? `${path}?${qs}` : path;
    return {
      method: o.method ?? "GET", url, path, originalUrl: url,
      params: o.params || {}, body: o.body, query, headers, cookies: {},
      ip: "127.0.0.1", lang: o.lang ?? "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
    };
  }

  const { asPublicViewMiddleware, wantsAsPublicView, AS_PUBLIC_CACHE_CONTROL } =
    require("../middleware/as-public-view") as typeof import("../middleware/as-public-view");

  /** Run the real middleware, then the handler (as Express would). */
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
        setHeader(k: string, v: string) { headers[String(k).toLowerCase()] = String(v); return res; },
        // Express: res.header / res.set go through setHeader.
        header(k: any, v?: any) {
          if (k && typeof k === "object") { for (const [kk, vv] of Object.entries(k)) res.setHeader(kk, vv); } else res.setHeader(k, v);
          return res;
        },
        set(k: any, v?: any) { return res.header(k, v); },
        type(t: string) { return res.setHeader("Content-Type", t); },
        getHeader(k: string) { return headers[String(k).toLowerCase()]; },
        once() { return res; }, on() { return res; },
      };
      const run = () => {
        try {
          const p = handler(req, res, (err?: any) => settle({ __next: true, err: err ? String(err) : undefined }));
          if (p && typeof p.catch === "function") p.catch((err: any) => settle({ __error: String(err) }));
        } catch (err) {
          settle({ __error: String(err) });
        }
      };
      try {
        asPublicViewMiddleware(req, res, run as any);
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
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./a2a", "./discovery"];

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
    for (const k of ENVS) setEnv(k, null);
    setEnv(ADMIN_ENV, KEY);

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
    seoMod.__resetSitemapCacheForTesting();

    const H = {
      search: findRouteHandler(marketplaceRouter, "/search", "get"),
      discover: findRouteHandler(marketplaceRouter, "/discover", "post"),
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      trust: findRouteHandler(marketplaceRouter, "/agents/:id/trust", "get"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      sitemap: findRouteHandler(seoRouter, "/sitemap.xml", "get"),
      llms: findRouteHandler(discoveryRouter, "/llms.txt", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
      a2a: findRouteHandler(a2aRouter, "/a2a", "post"),
      a2aCard: findRouteHandler(a2aRouter, "/agents/:id/agent.json", "get"),
      leaderboard: findRouteHandler(a2aRouter, "/api/leaderboard", "get"),
    };

    seedProducer(db, FIX, { origin: "test_fixture", hidden: 1, active: 1 });
    seedProducer(db, HID, { origin: "discovery", hidden: 1, active: 1 });
    seedProducer(db, INA, { origin: "discovery", hidden: 0, active: 0 });
    seedProducer(db, PUB, { origin: "discovery", hidden: 0, active: 1 });
    for (const id of [FIX, PUB]) {
      db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at) VALUES (?, ?, ?, ?, 'verified', ?, ?)")
        .run(`claim-${id}`, id, `post@${id}.example.no`, "Eier", `tok-${id}`, new Date(Date.now() + 86_400_000).toISOString());
    }

    // ── Surface probes: (id, mode) → is THIS producer there? ──────────────
    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const slug = (id: string) => slugify(NAMES[id]);
    const json = (x: unknown) => JSON.stringify(x ?? null);
    const byIdPath = (id: string, what: string) => `/api/marketplace/agents/${id}/${what}`;
    const R = {
      page: (id: string, m: Mode) => invoke(H.produsent, makeReq(`/produsent/${slug(id)}`, m, { params: { slug: slug(id) } })),
      byId: (id: string, what: "card" | "info" | "vcard" | "trust", m: Mode) =>
        invoke((H as any)[what], makeReq(byIdPath(id, what), m, { params: { id } })),
      search: (id: string, m: Mode) => invoke(H.search, makeReq("/api/marketplace/search", m, { query: { q: NAMES[id], heleNorge: "true" } })),
      discover: (m: Mode) => invoke(H.discover, makeReq("/api/marketplace/discover", m, { method: "POST", body: { categories: ["vegetables"] } })),
      feed: (m: Mode) => invoke(H.feed, makeReq("/api/marketplace/catalog/feed", m)),
      acp: (m: Mode) => invoke(H.acp, makeReq("/api/marketplace/catalog/acp-feed.csv", m)),
      sitemap: (m: Mode) => invoke(H.sitemap, makeReq("/sitemap.xml", m)),
      llms: (m: Mode) => invoke(H.llms, makeReq("/llms.txt", m)),
      llmsFull: (m: Mode) => invoke(H.llmsFull, makeReq("/llms-full.txt", m)),
      leaderboard: (m: Mode) => invoke(H.leaderboard, makeReq("/api/leaderboard", m)),
      a2aInfo: (id: string, m: Mode) => invoke(H.a2a, makeReq("/a2a", m, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "agent/info", params: { agentId: id } } })),
      a2aSearch: (id: string, m: Mode) => invoke(H.a2a, makeReq("/a2a", m, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: NAMES[id] }] } } } })),
      a2aCard: (id: string, m: Mode) => invoke(H.a2aCard, makeReq(`/agents/${id}/agent.json`, m, { params: { id } })),
    };
    const isProfilePage = (html: string, id: string) => html.includes(NAMES[id]) && html.includes("familiegård") && !html.includes("Midlertidig pause");
    const jsonLdOf = (html: string) => [...html.matchAll(LD_RE)].map((x) => x[1]).join("\n");

    // Each probe answers "is `id` present?" for one endpoint.
    type Probe = (id: string, m: Mode) => Promise<boolean>;
    const PROBES: Record<string, { surface: string; probe: Probe; byIdUngated?: boolean }> = {
      profile_html: { surface: "profile_html", probe: async (id, m) => { const r = await R.page(id, m); return r.status === 200 && isProfilePage(String(r.body ?? ""), id); } },
      json_ld: { surface: "json_ld", probe: async (id, m) => jsonLdOf(String((await R.page(id, m)).body ?? "")).includes(`"name":"${NAMES[id]}"`) },
      card: { surface: "rest_card", probe: async (id, m) => (await R.byId(id, "card", m)).status === 200 },
      info: { surface: "rest_card", probe: async (id, m) => (await R.byId(id, "info", m)).status === 200 },
      vcard: { surface: "vcard", probe: async (id, m) => String((await R.byId(id, "vcard", m)).body ?? "").includes("BEGIN:VCARD") },
      trust: { surface: "rest_card", probe: async (id, m) => (await R.byId(id, "trust", m)).status === 200 },
      rest_search: { surface: "mcp_search", probe: async (id, m) => ((await R.search(id, m)).body?.results ?? []).some((r: any) => r.agent?.id === id) },
      rest_discover: { surface: "mcp_search", probe: async (id, m) => ((await R.discover(m)).body?.results ?? []).some((r: any) => r.agent?.id === id) },
      acp_feed: { surface: "acp_feed", probe: async (id, m) => ((await R.feed(m)).body?.items ?? []).some((i: any) => i.seller?.agent_id === id) },
      acp_csv: { surface: "acp_feed", probe: async (id, m) => String((await R.acp(m)).body ?? "").includes(`prod-${id}`) },
      sitemap: { surface: "sitemap", probe: async (id, m) => String((await R.sitemap(m)).body ?? "").includes(`/produsent/${slug(id)}</loc>`) },
      llms_txt: { surface: "llms", probe: async (id, m) => String((await R.llms(m)).body ?? "").includes(slug(id)) },
      llms_full: { surface: "llms", probe: async (id, m) => String((await R.llmsFull(m)).body ?? "").includes(NAMES[id]) },
      a2a_search: { surface: "a2a", probe: async (id, m) => json((await R.a2aSearch(id, m)).body).includes(id) },
      leaderboard: { surface: "leaderboard", probe: async (id, m) => ((await R.leaderboard(m)).body?.data ?? []).some((r: any) => r.agentId === id) },
    };
    // Surfaces that never gated catalog_hidden (serve any active row today):
    // the view cannot change them; they are compared, not asserted absent.
    const NO_CATALOG_GATE_TODAY = new Set(["leaderboard"]);
    // Surfaces that do not gate is_active unless OWNER_VISIBILITY_ENFORCE_BY_ID
    // is on (today's answer): for the inactive row they are compared below.
    const NO_ACTIVE_GATE_TODAY = new Set(["card", "info", "vcard", "trust", "acp_feed", "acp_csv"]);

    // ═══ Baseline: the plain public surfaces ══════════════════════════════
    for (const [ep, p] of Object.entries(PROBES)) {
      clearRegistryCaches();
      assertTrue(await p.probe(PUB, "plain"), `base-1: ${ep} shows the public neighbour`);
      if (!NO_CATALOG_GATE_TODAY.has(ep)) assertTrue(!(await p.probe(FIX, "plain")), `base-2: ${ep} hides the fixture without the view`);
    }

    // ═══ Gate: everything short of key + opt-in is byte-identical ═════════
    const strip = (s: string) => s.replace(/^REV:.*$/gm, "REV:x").replace(/generated-at: [^ \n]+/g, "generated-at: x")
      .replace(/"(timestamp|generated_at|generatedAt|createdAt|updatedAt)":"[^"]+"/g, '"$1":"x"')
      .replace(/"times(Discovered|Contacted)":\d+/g, '"times$1":0')
      .replace(/"(contextId|taskId|messageId|conversationId|id)":"[0-9a-f-]{36}"/g, '"$1":"x"');
    async function snapshot(m: Mode): Promise<Record<string, string>> {
      clearRegistryCaches();
      seoMod.__resetSitemapCacheForTesting();
      const one = (r: HandlerResult) => strip(`${r.status} ${typeof r.body === "string" ? r.body : json(r.body)} ${json(r.headers)}`);
      const out: Record<string, string> = {};
      for (const id of [FIX, PUB]) {
        out[`page_${id}`] = one(await R.page(id, m));
        for (const w of ["card", "info", "vcard"] as const) out[`${w}_${id}`] = one(await R.byId(id, w, m));
        // The trust score drifts with the activity the probes themselves log; its status and headers are compared.
        const t = await R.byId(id, "trust", m);
        out[`trust_${id}`] = `${t.status} ${json(t.headers)}`;
        out[`search_${id}`] = strip(json((await R.search(id, m)).body?.results));
        out[`a2a_card_${id}`] = one(await R.a2aCard(id, m));
        out[`a2a_info_${id}`] = one(await R.a2aInfo(id, m));
      }
      out.discover = strip(json((await R.discover(m)).body?.results));
      out.feed = strip(json((await R.feed(m)).body?.items));
      out.acp = one(await R.acp(m));
      out.sitemap = one(await R.sitemap(m));
      out.llms = one(await R.llms(m));
      out.llms_full = one(await R.llmsFull(m));
      out.leaderboard = one(await R.leaderboard(m));
      return out;
    }
    const sameSnapshot = (a: Record<string, string>, b: Record<string, string>, label: string) => {
      for (const k of Object.keys(a)) {
        if (process.env.S2D2_DEBUG && a[k] !== b[k]) {
          let i = 0; while (i < a[k].length && a[k][i] === b[k][i]) i++;
          console.info(`DIFF ${label} ${k}: ${JSON.stringify(a[k].slice(Math.max(0, i - 80), i + 80))} vs ${JSON.stringify(String(b[k]).slice(Math.max(0, i - 80), i + 80))}`);
        }
        assertTrue(a[k] === b[k], `${label}: ${k} byte-identical`);
      }
    };
    {
      const base = await snapshot("plain");
      sameSnapshot(base, await snapshot("plain"), "gate-0: two plain runs");
      sameSnapshot(base, await snapshot("no_key"), "gate-1: ?as_public=1 without a key");
      sameSnapshot(base, await snapshot("wrong_key"), "gate-2: ?as_public=1 with a wrong key");
      sameSnapshot(base, await snapshot("key_no_optin"), "gate-3: a valid key without the opt-in");
      sameSnapshot(base, await snapshot("optin_zero"), "gate-4: a valid key with ?as_public=0");
      // No admin key configured at all: even the "right" header is no key.
      setEnv(ADMIN_ENV, null);
      sameSnapshot(base, await snapshot("as_public"), "gate-5: ADMIN_KEY unset → key + opt-in do nothing");
      setEnv(ADMIN_ENV, KEY);
    }
    {
      // The middleware's own gate, without any handler.
      const w = (path: string, m: Mode, method: "GET" | "POST" = "GET") => wantsAsPublicView(makeReq(path, m, { method }));
      assertTrue(w("/produsent/x", "as_public"), "mw-1: key + opt-in on a covered path");
      assertTrue(w("/en/produsent/x", "as_public") === false, "mw-2: matched after langMiddleware strips /en (raw /en path is not)");
      assertTrue(!w("/produsent/ordre", "as_public"), "mw-3: the order flow is not covered");
      assertTrue(!w("/produsent/ordre/abc", "as_public"), "mw-4: the order flow token page is not covered");
      assertTrue(!w("/admin/test-producer", "as_public"), "mw-5: admin routes are not covered");
      assertTrue(!w("/api/marketplace/agents/x/claim", "as_public", "POST"), "mw-6: writes are not covered");
      assertTrue(!w("/api/marketplace/search", "as_public", "POST"), "mw-7: POST only where the surface is POST");
      assertTrue(w("/a2a", "as_public", "POST"), "mw-8: A2A JSON-RPC (POST) is covered");
      assertTrue(!w("/produsent/x", "no_key") && !w("/produsent/x", "wrong_key") && !w("/produsent/x", "key_no_optin"), "mw-9: no key / wrong key / no opt-in → off");
      // Fast path: no `as_public=` in the URL → req.query is never read.
      const req = makeReq("/produsent/x", "key_no_optin");
      Object.defineProperty(req, "query", { get() { throw new Error("query read"); } });
      let ok = true;
      try { ok = wantsAsPublicView(req) === false; } catch { ok = false; }
      assertTrue(ok, "mw-10: without the opt-in in the URL the query is not even parsed");
      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        for (const m of ["plain", "no_key", "wrong_key", "key_no_optin", "as_public"] as Mode[]) {
          await new Promise<void>((resolve) => asPublicViewMiddleware(makeReq("/produsent/x", m), { setHeader() { /* */ } } as any, () => resolve()));
        }
      } finally {
        (db as any).prepare = realPrepare;
      }
      assertEq(queries, 0, "mw-11: the middleware itself runs no DB query in any mode");
    }

    // ═══ Surfaces: key + opt-in → the fixture is visible ══════════════════
    for (const [ep, p] of Object.entries(PROBES)) {
      clearRegistryCaches();
      assertTrue(await p.probe(FIX, "as_public"), `surf-1: ${ep} shows the fixture under the view`);
      assertTrue(await p.probe(PUB, "as_public"), `surf-2: ${ep} still shows the public neighbour under the view`);
    }
    // The /en profile page (langMiddleware has stripped the prefix already).
    {
      const r = await invoke(H.produsent, makeReq(`/produsent/${slug(FIX)}`, "as_public", { params: { slug: slug(FIX) }, lang: "en" }));
      assertTrue(r.status === 200 && String(r.body ?? "").includes(NAMES[FIX]), "surf-3: the EN profile page too");
    }

    // ═══ Never: real hidden + real inactive rows ══════════════════════════
    for (const id of [HID, INA]) {
      for (const [ep, p] of Object.entries(PROBES)) {
        if (NO_CATALOG_GATE_TODAY.has(ep)) continue;
        // by-id surfaces that do not gate is_active today (flag off) are compared below.
        if (id === INA && NO_ACTIVE_GATE_TODAY.has(ep)) continue;
        clearRegistryCaches();
        for (const m of ["plain", "as_public", "no_key", "key_no_optin"] as Mode[]) {
          assertTrue(!(await p.probe(id, m)), `never-1: ${id} absent on ${ep} (${m})`);
        }
      }
    }
    {
      // Inactive row on the by-id surfaces: the view changes nothing (today's
      // answer, flag off); with OWNER_VISIBILITY_ENFORCE_BY_ID it is 404 either way.
      const bodyOf = (r: HandlerResult) => `${r.status} ${strip(typeof r.body === "string" ? r.body : json(r.body))}`;
      for (const w of ["card", "info", "vcard"] as const) {
        assertEq(bodyOf(await R.byId(INA, w, "as_public")), bodyOf(await R.byId(INA, w, "plain")), `never-2: inactive row on ${w}: as-public answer = plain answer`);
      }
      assertEq((await R.byId(INA, "trust", "as_public")).status, (await R.byId(INA, "trust", "plain")).status, "never-2: inactive row on trust: as-public status = plain status");
      for (const ep of ["acp_feed", "acp_csv"]) {
        assertEq(await PROBES[ep].probe(INA, "as_public"), await PROBES[ep].probe(INA, "plain"), `never-2: inactive row on ${ep}: as-public = plain (today's answer)`);
      }
      setEnv(BY_ID_ENV, "1");
      for (const w of ["card", "info", "vcard", "trust"] as const) {
        assertEq((await R.byId(INA, w, "as_public")).status, 404, `never-3: inactive row on ${w} 404 under the view (enforce by id)`);
        assertEq((await R.byId(HID, w, "as_public")).status, 404, `never-4: real hidden row on ${w} 404 under the view (enforce by id)`);
      }
      for (const ep of ["acp_feed", "acp_csv"]) {
        assertTrue(!(await PROBES[ep].probe(INA, "as_public")), `never-4: inactive row off ${ep} under the view (enforce by id)`);
      }
      assertEq((await R.byId(FIX, "card", "as_public")).status, 200, "never-5: the fixture stays visible by id with enforce-by-id on");
      setEnv(BY_ID_ENV, null);
      // An inactive fixture is still not on any list (is_active applies).
      db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(FIX);
      for (const ep of ["profile_html", "rest_search", "rest_discover", "sitemap", "llms_txt"]) {
        clearRegistryCaches();
        assertTrue(!(await PROBES[ep].probe(FIX, "as_public")), `never-6: an inactive fixture stays off ${ep} under the view`);
      }
      db.prepare("UPDATE agents SET is_active = 1 WHERE id = ?").run(FIX);
      clearRegistryCaches();
    }

    // ═══ Owner switches on the fixture are observable under the view ══════
    {
      const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e) =>
        e.key.startsWith("visibility.") ? { ...e, status: "live" as const } : e);
      vis.__setVisibilityRegistryForTesting(LIVE);
      setEnv(ENFORCE_ENV, "1");
      setEnv(ALLOW_ENV, `rfb:${FIX}`);
      const setChoice = (key: string, value: unknown) => {
        const r = rs.setOwnerFeatureValue("rfb", FIX, key, value, { actor: "owner" }, { db, registry: LIVE });
        if (r.kind !== "ok") throw new Error(`setOwnerFeatureValue(${key}) → ${r.kind}`);
        clearRegistryCaches();
      };
      const clearChoices = () => {
        db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(FIX);
        db.prepare("DELETE FROM owner_profile_pause WHERE agent_id = ?").run(FIX);
        clearRegistryCaches();
      };
      // key → the endpoints it must hide (from PROBES) and some it must leave.
      const CASES: Array<{ key: string; hides: string[]; keeps: string[] }> = [
        { key: "visibility.profile", hides: Object.keys(PROBES), keeps: [] },
        { key: "visibility.shopping_feeds", hides: ["acp_feed", "acp_csv"], keeps: ["profile_html", "card", "rest_search", "sitemap"] },
        { key: "visibility.ai_assistants", hides: ["rest_search", "rest_discover", "llms_txt", "llms_full", "a2a_search"], keeps: ["profile_html", "card", "acp_feed"] },
        { key: "visibility.search_engines", hides: ["sitemap"], keeps: ["profile_html", "card", "acp_feed", "llms_txt"] },
        { key: "visibility.leaderboard", hides: ["leaderboard"], keeps: ["profile_html", "card", "acp_feed"] },
      ];
      for (const c of CASES) {
        assertTrue(reg.getOwnerFeature(c.key) !== undefined, `owner-0: ${c.key} is a registry key`);
        clearChoices();
        for (const ep of [...c.hides, ...c.keeps]) assertTrue(await PROBES[ep].probe(FIX, "as_public"), `owner-1: ${c.key} default → fixture on ${ep}`);
        setChoice(c.key, false);
        for (const ep of c.hides) assertTrue(!(await PROBES[ep].probe(FIX, "as_public")), `owner-2: ${c.key} off → fixture gone from ${ep} under the view`);
        for (const ep of c.keeps) assertTrue(await PROBES[ep].probe(FIX, "as_public"), `owner-3: ${c.key} off → fixture still on ${ep}`);
        setChoice(c.key, true);
        for (const ep of c.hides) assertTrue(await PROBES[ep].probe(FIX, "as_public"), `owner-4: ${c.key} back on → fixture back on ${ep}`);
      }
      {
        // search_engines also means noindex on the page itself (already the view's header).
        clearChoices();
        setChoice("visibility.search_engines", false);
        const html = String((await R.page(FIX, "as_public")).body ?? "");
        assertTrue(html.includes('<meta name="robots" content="noindex">'), "owner-5: search_engines off → noindex meta on the fixture page");
      }
      clearChoices();
      vis.__setVisibilityRegistryForTesting(null);
      setEnv(ENFORCE_ENV, null);
      setEnv(ALLOW_ENV, null);
    }

    // ═══ Headers: no-store + noindex on every as-public answer ═══════════
    {
      const cases: Array<[string, () => Promise<HandlerResult>, () => Promise<HandlerResult>]> = [
        ["profile", () => R.page(FIX, "as_public"), () => R.page(PUB, "plain")],
        ["card", () => R.byId(FIX, "card", "as_public"), () => R.byId(PUB, "card", "plain")],
        ["search", () => R.search(FIX, "as_public"), () => R.search(PUB, "plain")],
        ["feed", () => R.feed("as_public"), () => R.feed("plain")],
        ["acp_csv", () => R.acp("as_public"), () => R.acp("plain")],
        ["sitemap", () => R.sitemap("as_public"), () => R.sitemap("plain")],
        ["llms", () => R.llms("as_public"), () => R.llms("plain")],
        ["llms_full", () => R.llmsFull("as_public"), () => R.llmsFull("plain")],
        ["leaderboard", () => R.leaderboard("as_public"), () => R.leaderboard("plain")],
        ["a2a", () => R.a2aSearch(FIX, "as_public"), () => R.a2aSearch(PUB, "plain")],
        ["a2a_card", () => R.a2aCard(FIX, "as_public"), () => R.a2aCard(PUB, "plain")],
      ];
      for (const [label, asPub, plain] of cases) {
        clearRegistryCaches();
        const r = await asPub();
        assertEq(r.headers["cache-control"], AS_PUBLIC_CACHE_CONTROL, `hdr-1: ${label} as-public → Cache-Control: no-store, private`);
        assertEq(r.headers["x-robots-tag"], "noindex", `hdr-2: ${label} as-public → X-Robots-Tag: noindex`);
        const p = await plain();
        assertTrue(p.headers["cache-control"] !== AS_PUBLIC_CACHE_CONTROL || label === "never", `hdr-3: ${label} plain → its own Cache-Control (${p.headers["cache-control"] ?? "none"})`);
        assertTrue(p.headers["x-robots-tag"] === undefined, `hdr-4: ${label} plain → no X-Robots-Tag added`);
      }
    }

    // ═══ Caches: the view never reads or fills a shared cache ════════════
    {
      // As-public first, on cold caches: nothing is written.
      clearRegistryCaches();
      seoMod.__resetSitemapCacheForTesting();
      assertTrue(await PROBES.llms_txt.probe(FIX, "as_public"), "cache-1: as-public llms.txt shows the fixture");
      assertTrue(marketplaceRegistry._agentsCache === null, "cache-2: …and leaves the registry agent cache empty");
      assertTrue(await PROBES.sitemap.probe(FIX, "as_public"), "cache-3: as-public sitemap shows the fixture");
      marketplaceRegistry.getStats();
      assertTrue(marketplaceRegistry._statsCache !== null, "cache-4: a plain getStats fills the stats cache (sanity)");
      const statsPlain = marketplaceRegistry.getStats().totalAgents;
      const statsView = await new Promise<number>((resolve) => av.runAsPublicView(() => resolve(marketplaceRegistry.getStats().totalAgents)));
      assertEq(statsView, statsPlain + 1, "cache-5: getStats under the view counts the fixture (not the cached number)");
      assertEq(marketplaceRegistry.getStats().totalAgents, statsPlain, "cache-6: …and leaves the cached stats untouched");
      for (const ep of ["llms_txt", "llms_full", "sitemap", "rest_search", "rest_discover", "acp_feed", "profile_html"]) {
        assertTrue(!(await PROBES[ep].probe(FIX, "plain")), `cache-7: a plain ${ep} right after the view → fixture absent`);
      }
      // Warm caches first, then the view, then plain again.
      clearRegistryCaches();
      seoMod.__resetSitemapCacheForTesting();
      const warm = marketplaceRegistry.getActiveAgents();
      const sitemapPlain = String((await R.sitemap("plain")).body);
      assertTrue(await PROBES.sitemap.probe(FIX, "as_public"), "cache-8: the view does not serve the warm sitemap cache");
      assertTrue(await PROBES.llms_txt.probe(FIX, "as_public"), "cache-9: the view does not serve the warm agent cache");
      assertTrue(marketplaceRegistry._agentsCache === warm, "cache-10: the warm agent cache is the same object afterwards");
      assertEq(String((await R.sitemap("plain")).body), sitemapPlain, "cache-11: the cached sitemap is unchanged afterwards");
      assertTrue(!warm.some((a: any) => a.id === FIX), "cache-12: the cached agent list never holds the fixture");
    }

    // ═══ SQL: byte-identical outside the context, no leak across flows ═══
    {
      const plainSql = av.publicListableSql("a");
      assertEq(plainSql, "COALESCE(a.catalog_hidden, 0) = 0 AND COALESCE(a.vertical_id, 'rfb') = 'rfb'", "sql-1: publicListableSql unchanged outside the view");
      assertEq(av.notCatalogHiddenSql(), "COALESCE(catalog_hidden, 0) = 0", "sql-2: notCatalogHiddenSql unchanged outside the view");
      const inView = av.runAsPublicView(() => ({
        list: av.publicListableSql("a"),
        boot: av.publicListableSql("a", { ownerChoices: false }),
        excl: av.catalogHiddenIdExclusionSql(db as any, "a"),
        listableFix: av.isPubliclyListable({ catalog_hidden: 1, origin: "test_fixture" }),
        listableHid: av.isPubliclyListable({ catalog_hidden: 1, origin: "discovery" }),
        listableNoOrigin: av.isPubliclyListable({ catalog_hidden: 1 }),
      }));
      assertEq(inView.list, "(COALESCE(a.catalog_hidden, 0) = 0 OR COALESCE(a.origin, '') = 'test_fixture') AND COALESCE(a.vertical_id, 'rfb') = 'rfb'", "sql-3: under the view only origin='test_fixture' is let through");
      assertEq(inView.boot, plainSql, "sql-4: SQL that outlives the request (ownerChoices:false, the boot VIEW) never carries the exception");
      assertTrue(inView.excl.includes(`'${FIX}'`) && inView.excl.includes(`'${HID}'`), "sql-5: the verifier's catalogHiddenIdExclusionSql is unaffected by the view");
      assertEq([inView.listableFix, inView.listableHid, inView.listableNoOrigin], [true, false, false], "sql-6: in-memory twin: fixture yes, real hidden no, unknown origin no");
      assertEq(av.isPubliclyListable({ catalog_hidden: 1, origin: "test_fixture" }), false, "sql-7: in-memory twin outside the view: fixture hidden");
      const ids = (db.prepare(av.notPubliclyListableAgentIdsSql()).all() as Array<{ id: string }>).map((r) => r.id).sort();
      const idsView = av.runAsPublicView(() => (db.prepare(av.notPubliclyListableAgentIdsSql()).all() as Array<{ id: string }>).map((r) => r.id).sort());
      assertTrue(ids.includes(FIX) && ids.includes(HID), "sql-8: NOT(listable) holds both hidden rows outside the view");
      assertTrue(!idsView.includes(FIX) && idsView.includes(HID), "sql-9: NOT(listable) under the view: real hidden row still in (two-valued OR)");
      // Concurrency: interleaved async flows each see their own mode.
      const seen: string[] = [];
      const flow = async (name: string) => {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 1));
          seen.push(`${name}:${av.isAsPublicView()}`);
        }
      };
      await Promise.all([av.runAsPublicView(() => flow("view")), flow("plain")]);
      assertTrue(seen.filter((s) => s.startsWith("view:")).every((s) => s === "view:true"), "sql-10: the view flow stays in the view across awaits");
      assertTrue(seen.filter((s) => s.startsWith("plain:")).every((s) => s === "plain:false"), "sql-11: a concurrent plain flow never sees it");
      assertEq(av.isAsPublicView(), false, "sql-12: nothing leaks after the flow ends");
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
    try { (require("./seo") as typeof import("./seo")).__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAsPublicViewS2d2Tests({ log: true }).then((r) => {
    console.info(`\nas-public-view-s2d2: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
