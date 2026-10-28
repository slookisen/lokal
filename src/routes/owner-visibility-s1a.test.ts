/**
 * owner-visibility-s1a.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S1a points 1 and 2.
 *
 * Point 1 — owner lock in the write layer (OWNER_LOCK_ENFORCE_WRITES):
 *   upsertKnowledge() and the admin PUT /agents/:id/knowledge never overwrite a
 *   field with curated_fields.<f>.by = "owner" unless the write comes from the
 *   owner path (ownerUpdate(), the API-key / claim-token lane of the same
 *   route). The response lists such fields as skipped: owner_locked. Both flag
 *   states: off = the write is exactly what it always was.
 *
 * Point 2 — one by-id visibility predicate (OWNER_VISIBILITY_ENFORCE_BY_ID):
 *   lokal_info, the MCP producer-detail resource, /agents/:id/card|info|vcard|
 *   trust, /api/agents/:id/metrics, the ACP feeds (catalog feed + acp-feed.csv),
 *   llms-full.txt and sitemap. A profile with is_active=0 or catalog_hidden=1
 *   is 404/omitted with the flag on; with the flag off every surface answers
 *   as it did before (pinned below, including the surfaces that did NOT check
 *   is_active). A source test pins that all surfaces use agent-visibility.ts.
 *
 * Real routers/services on the production schema in an in-memory DB; handlers
 * pulled off the router stacks (same harness as rfb-hidden-test-producer.test.ts).
 *
 * Exported runOwnerVisibilityS1aTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-visibility-s1a.test.ts
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join } from "path";
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

const LOCK_FLAG = "OWNER_LOCK_ENFORCE_WRITES";
const VIS_FLAG = "OWNER_VISIBILITY_ENFORCE_BY_ID";

const ACTIVE_ID = "s1a-active";
const INACTIVE_ID = "s1a-inactive";
const HIDDEN_ID = "s1a-hidden";
const LOCKED_ID = "s1a-locked";
const NAMES: Record<string, string> = {
  [ACTIVE_ID]: "Aktiv Gard Synlighetstest",
  [INACTIVE_ID]: "Inaktiv Gard Synlighetstest",
  [HIDDEN_ID]: "Skjult Gard Synlighetstest",
  [LOCKED_ID]: "Last Gard Synlighetstest",
};

function seedProducer(db: Database.Database, id: string, o: { active?: number; hidden?: number } = {}): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, ?, 1, 'discovery', 'rfb', ?)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.active ?? 1, o.hidden ?? 0,
  );
  db.prepare(
    `INSERT INTO agent_knowledge
       (agent_id, email, website, about, products, verification_status, verified_second_line,
        enrichment_status, url_last_status, url_last_probed, last_verified_at)
     VALUES (?, ?, ?, ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    id, `post@${id}.example.no`, `https://${id}.example.no`,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([{ name: "Listepoteter", price: "30 kr/kg", category: "vegetables" }]),
  );
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url)
     VALUES (?, ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg')`,
  ).run(`prod-${id}`, id);
}

export async function runOwnerVisibilityS1aTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevLockFlag = process.env[LOCK_FLAG];
  const prevVisFlag = process.env[VIS_FLAG];
  const setFlag = (name: string, on: boolean) => { if (on) process.env[name] = "1"; else delete process.env[name]; };

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = v;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers,
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return name.toLowerCase() === "host" ? "rettfrabonden.com" : headers[name.toLowerCase()]; },
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
        header() { return res; }, set() { return res; }, type() { return res; }, setHeader() { return res; },
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
  if (setKeyOurselves) process.env.ADMIN_KEY = "owner-visibility-s1a-standalone-key";
  const adminKey = () => process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";

  const { marketplaceRegistry } = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
  const clearRegistryCaches = () => {
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
  };
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./discovery", "./a2a"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();

    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const seoMod = require("./seo") as typeof import("./seo");
    const discoveryRouter = require("./discovery").default as any;
    const a2aRouter = require("./a2a").default as any;
    const visibility = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
    const { knowledgeService, ownerLockEnforcedForWrites } = require("../services/knowledge-service") as typeof import("../services/knowledge-service");

    const tools = new Map<string, (args: any) => Promise<any>>();
    const resources = new Map<string, (uri: URL) => Promise<any>>();
    const { registerTools } = require("./mcp") as typeof import("./mcp");
    registerTools({
      registerTool(name: string, _config: any, handler: any) { tools.set(name, handler); },
      resource(name: string, _tpl: any, _meta: any, handler: any) { resources.set(name, handler); },
      prompt() { /* no-op */ },
      registerResource() { /* no-op */ },
      registerPrompt() { /* no-op */ },
    } as any, () => "test-client", () => undefined);
    const toolText = async (name: string, args: any) => String((await tools.get(name)!(args))?.content?.[0]?.text ?? "");

    const H = {
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      trust: findRouteHandler(marketplaceRouter, "/agents/:id/trust", "get"),
      putKnowledge: findRouteHandler(marketplaceRouter, "/agents/:id/knowledge", "put"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
      llms: findRouteHandler(discoveryRouter, "/llms.txt", "get"),
      metrics: findRouteHandler(a2aRouter, "/api/agents/:id/metrics", "get"),
    };

    seedProducer(db, ACTIVE_ID);
    seedProducer(db, INACTIVE_ID, { active: 0 });
    seedProducer(db, HIDDEN_ID, { hidden: 1 });
    seedProducer(db, LOCKED_ID);

    // ═══ Point 2 — predicate unit cases ═══════════════════════════════════
    const row = (o: any) => ({ is_active: 1, is_vetted: 1, catalog_hidden: 0, vertical_id: "rfb", origin: "discovery", ...o });
    setFlag(VIS_FLAG, false);
    assertEq(visibility.byIdVisibilityEnforced(), false, "vis-1: flag defaults OFF");
    assertTrue(!visibility.isAgentPubliclyVisible(null, { surface: "gated" }), "vis-2: no row → not visible");
    assertTrue(visibility.isAgentPubliclyVisible(row({ is_active: 0 }), { surface: "gated" }), "vis-3: flag off, gated surface: is_active=0 still served (today's behaviour)");
    assertTrue(visibility.isAgentPubliclyVisible(row({ is_active: 0, catalog_hidden: 1 }), { surface: "ungated" }), "vis-4: flag off, ungated surface: served whatever the row says");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ catalog_hidden: 1 }), { surface: "gated" }), "vis-5: flag off, gated: catalog_hidden=1 hidden (today)");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ origin: "self_registered", is_vetted: 0 }), { surface: "gated" }), "vis-6: flag off, gated: unvetted self-registered hidden (today)");
    assertEq(visibility.publiclyVisibleSql("a"), visibility.publicListableSql("a"), "vis-7: flag off, feed SQL is exactly publicListableSql");
    setFlag(VIS_FLAG, true);
    assertTrue(visibility.byIdVisibilityEnforced(), "vis-8: flag on");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ is_active: 0 }), { surface: "gated" }), "vis-9: flag on: is_active=0 hidden");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ is_active: 0 }), { surface: "ungated" }), "vis-10: flag on, ungated: is_active=0 hidden");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ catalog_hidden: 1 }), { surface: "ungated" }), "vis-11: flag on, ungated: catalog_hidden=1 hidden");
    assertTrue(visibility.isAgentPubliclyVisible(row({ catalog_hidden: 1 }), { surface: "ungated", allowCatalogHidden: true }), "vis-12: flag on, allowCatalogHidden keeps the test fixture reachable");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ catalog_hidden: 1, is_active: 0 }), { surface: "ungated", allowCatalogHidden: true }), "vis-13: …but not when inactive");
    assertTrue(!visibility.isAgentPubliclyVisible(row({ origin: "self_registered", is_vetted: 0 }), { surface: "ungated" }), "vis-14: flag on, ungated: unvetted self-registered hidden");
    assertTrue(visibility.isAgentPubliclyVisible(row({}), { surface: "ungated" }), "vis-15: flag on: a normal row is visible");
    assertTrue(visibility.publiclyVisibleSql("a").endsWith("AND COALESCE(a.is_active, 1) = 1"), "vis-16: flag on, feed SQL adds is_active");
    assertEq(visibility.activeVettedListableSql(), `is_active = 1 AND is_vetted = 1 AND ${visibility.publicListableSql()}`, "vis-17: list-surface fragment shape");
    setFlag(VIS_FLAG, false);

    // ═══ Point 2 — every by-id surface, both flag states ══════════════════
    const slugIds = (text: string) => [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID].filter((id) => text.includes(NAMES[id]));
    const sitemapIds = (xml: string) => [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID].filter((id) => xml.includes(`/produsent/${slugify(NAMES[id])}<`));

    /** Per surface: which of the three profiles it serves (or lists). */
    async function surfaces(): Promise<Record<string, string[]>> {
      clearRegistryCaches();
      const s: Record<string, string[]> = {};
      const byId = async (call: (id: string) => Promise<boolean>) => {
        const out: string[] = [];
        for (const id of [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID]) if (await call(id)) out.push(id);
        return out;
      };
      const ok = (h: Function) => async (id: string) => (await invoke(h, makeReq({ params: { id } }))).status === 200;
      s.lokal_info = await byId(async (id) => !(await toolText("lokal_info", { agentId: id })).startsWith("Fant ingen produsent"));
      s.mcp_resource = await byId(async (id) => (await resources.get("producer-detail")!(new URL(`lokal://producers/${id}`)))?.contents?.[0]?.mimeType === "application/json");
      s.card = await byId(ok(H.card));
      s.info = await byId(ok(H.info));
      s.vcard = await byId(ok(H.vcard));
      s.trust = await byId(ok(H.trust));
      s.metrics = await byId(ok(H.metrics));
      s.catalog_feed = [...new Set(((await invoke(H.feed, makeReq({}))).body?.items ?? []).map((i: any) => i.seller.agent_id as string))] as string[];
      s.acp_feed_csv = slugIds(String((await invoke(H.acp, makeReq({}))).body));
      s.llms_full_txt = slugIds(String((await invoke(H.llmsFull, makeReq({}))).body));
      s.llms_txt = slugIds(String((await invoke(H.llms, makeReq({}))).body));
      s.sitemap = sitemapIds(seoMod.buildSitemapXml());
      return s;
    }
    const order = (ids: string[]) => [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID].filter((i) => ids.includes(i));

    // Flag off: today. Surfaces that never looked at is_active still serve it.
    setFlag(VIS_FLAG, false);
    const off = await surfaces();
    assertEq(order(off.lokal_info), [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID], "off-1: lokal_info serves any id (unchanged)");
    assertEq(order(off.mcp_resource), [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID], "off-2: MCP resource serves any id (unchanged)");
    for (const k of ["card", "info", "vcard", "trust"]) {
      assertEq(order(off[k]), [ACTIVE_ID, INACTIVE_ID], `off-3: /agents/:id/${k} hides catalog_hidden only (unchanged: no is_active check)`);
    }
    assertEq(order(off.metrics), [ACTIVE_ID, INACTIVE_ID, HIDDEN_ID], "off-4: /metrics serves any id (unchanged)");
    assertEq(order(off.catalog_feed), [ACTIVE_ID, INACTIVE_ID], "off-5: catalog feed hides catalog_hidden only (unchanged)");
    assertEq(order(off.acp_feed_csv), [ACTIVE_ID, INACTIVE_ID], "off-6: acp-feed.csv hides catalog_hidden only (unchanged)");
    assertEq(order(off.llms_full_txt), [ACTIVE_ID], "off-7: llms-full.txt lists only the active, vetted, listable profile");
    assertEq(order(off.llms_txt).filter((i) => i !== ACTIVE_ID), [], "off-7b: llms.txt lists no inactive/hidden profile");
    assertEq(order(off.sitemap), [ACTIVE_ID], "off-8: sitemap lists only the active, vetted, listable profile");

    // Flag on: is_active=0 / catalog_hidden=1 are 404/omitted everywhere.
    setFlag(VIS_FLAG, true);
    const on = await surfaces();
    assertEq(order(on.lokal_info), [ACTIVE_ID, HIDDEN_ID], "on-1: lokal_info: inactive → not found; hidden test fixture stays orderable by id (deliberate)");
    assertEq(order(on.mcp_resource), [ACTIVE_ID], "on-2: MCP resource: inactive and hidden → not found");
    for (const k of ["card", "info", "vcard", "trust", "metrics"]) {
      assertEq(order(on[k]), [ACTIVE_ID], `on-3: /${k}: inactive and hidden → 404`);
    }
    assertEq(order(on.catalog_feed), [ACTIVE_ID], "on-4: catalog feed omits inactive and hidden");
    assertEq(order(on.acp_feed_csv), [ACTIVE_ID], "on-5: acp-feed.csv omits inactive and hidden");
    assertEq(order(on.llms_full_txt), [ACTIVE_ID], "on-6: llms-full.txt omits inactive and hidden");
    assertEq(order(on.sitemap), [ACTIVE_ID], "on-7: sitemap omits inactive and hidden");
    {
      const unknown = await invoke(H.metrics, makeReq({ params: { id: "no-such-agent" } }));
      assertEq(unknown.status, 404, "on-8: /metrics for an unknown id is 404 with the flag on");
      setFlag(VIS_FLAG, false);
      assertEq((await invoke(H.metrics, makeReq({ params: { id: "no-such-agent" } }))).status, 200, "off-9: …and 200 with the flag off (unchanged)");
    }
    setFlag(VIS_FLAG, false);

    // Source test: every surface uses the ONE predicate module.
    {
      const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
      const needs: Array<[string, string, string[]]> = [
        ["lokal_info + MCP resource", "routes/mcp.ts", ['isAgentIdPubliclyVisible(getDb(), agentId, { surface: "ungated", allowCatalogHidden: true, audience: "ai" })', 'isAgentIdPubliclyVisible(getDb(), agentId, { surface: "ungated", audience: "ai" })']],
        ["/metrics", "routes/a2a.ts", ['isAgentIdPubliclyVisible(getDb(), req.params.id as string, { surface: "ungated" })']],
        ["ACP feeds", "routes/marketplace-catalog.ts", ['publiclyVisibleSql("a")']],
        ["card/info/vcard/trust/stats (registry)", "services/marketplace-registry.ts", ['isAgentPubliclyVisible(row, { surface: "gated", ...ownerChoice })', "activeVettedListableSql()"]],
      ];
      for (const [name, file, snippets] of needs) {
        const src = read(file);
        assertTrue(/from "\.{1,2}\/(services\/)?agent-visibility"/.test(src), `src-1: ${name} imports agent-visibility`);
        for (const sn of snippets) assertTrue(src.includes(sn), `src-2: ${name} uses ${sn.slice(0, 48)}`);
      }
      const mp = read("routes/marketplace.ts");
      for (const route of ["vcard", "card", "info", "trust"]) {
        const at = mp.indexOf(`router.get("/agents/:id/${route}"`);
        assertTrue(at > 0 && mp.slice(at, at + 1800).includes("marketplaceRegistry.isQuarantinedFromPublicView(agentId)"), `src-3: /agents/:id/${route} gates through the registry predicate`);
      }
      const disc = read("routes/discovery.ts");
      const seo = read("routes/seo.ts");
      assertTrue(disc.includes("marketplaceRegistry.getActiveAgents()"), "src-4: llms.txt / llms-full.txt read getActiveAgents()");
      assertTrue(seo.includes("getActiveAgents()") || seo.includes("marketplaceRegistry.getActiveAgents"), "src-5: sitemap reads getActiveAgents()");
    }

    // ═══ Point 1 — owner lock in the write layer ══════════════════════════
    const OWNER_ABOUT = "Teksten eieren selv har skrevet.";
    const resetLocked = () => {
      db.prepare("UPDATE agent_knowledge SET about = ?, website = ?, products = ?, curated_fields = ? WHERE agent_id = ?").run(
        OWNER_ABOUT, "https://eier.example.no",
        JSON.stringify([{ name: "Eierens produkt", category: "honey" }]),
        JSON.stringify({
          about: { locked_at: "2026-10-01T00:00:00.000Z", by: "owner" },
          products: { locked_at: "2026-10-01T00:00:00.000Z", by: "owner" },
          website: { locked_at: "2026-10-01T00:00:00.000Z", by: "rfb-customer-service" },
        }),
        LOCKED_ID,
      );
    };
    const lockedRow = () => db.prepare("SELECT about, website, email, products FROM agent_knowledge WHERE agent_id = ?").get(LOCKED_ID) as any;

    setFlag(LOCK_FLAG, false);
    assertEq(ownerLockEnforcedForWrites(), false, "lock-1: flag defaults OFF");
    resetLocked();
    {
      const r = knowledgeService.upsertKnowledge(LOCKED_ID, { about: "Berikelse overskriver", products: [{ name: "Auto-produkt", category: "x", seasonal: false }], dataSource: "auto" });
      assertEq(r.skipped, [], "lock-2: flag off: nothing skipped");
      const k = lockedRow();
      assertEq(k.about, "Berikelse overskriver", "lock-3: flag off: owner-locked about IS overwritten (today's behaviour)");
      assertTrue(String(k.products).includes("Auto-produkt"), "lock-4: flag off: owner-locked products ARE overwritten (today's behaviour)");
    }

    setFlag(LOCK_FLAG, true);
    assertEq(ownerLockEnforcedForWrites(), true, "lock-5: flag on");
    resetLocked();
    {
      const r = knowledgeService.upsertKnowledge(LOCKED_ID, {
        about: "Berikelse overskriver", products: [{ name: "Auto-produkt", category: "x", seasonal: false }],
        website: "https://auto.example.no", email: "ny@example.no", dataSource: "auto",
      });
      assertEq(r.skipped.map((s) => s.field).sort(), ["about", "products"], "lock-6: flag on: owner-locked about + products skipped");
      assertTrue(r.skipped.every((s) => s.reason === "owner_locked"), "lock-7: reason is owner_locked");
      const k = lockedRow();
      assertEq(k.about, OWNER_ABOUT, "lock-8: owner-locked about unchanged");
      assertTrue(String(k.products).includes("Eierens produkt") && !String(k.products).includes("Auto-produkt"), "lock-9: owner-asserted products unchanged");
      assertEq(k.website, "https://auto.example.no", "lock-10: a field locked by customer service (not owner) is still written (only the owner lock is enforced)");
      assertEq(k.email, "ny@example.no", "lock-11: an unlocked field is written");
    }
    resetLocked();
    {
      knowledgeService.ownerUpdate(LOCKED_ID, { about: "Eieren endrer selv" });
      assertEq(lockedRow().about, "Eieren endrer selv", "lock-12: the owner path (ownerUpdate) can still change an owner-locked field");
      resetLocked();
      const r = knowledgeService.upsertKnowledge(LOCKED_ID, { about: "Admin med dataSource owner", dataSource: "owner" });
      assertEq(r.skipped.map((s) => s.field), ["about"], "lock-13: dataSource:'owner' alone is NOT the owner path");
      assertEq(lockedRow().about, OWNER_ABOUT, "lock-14: …and the field is unchanged");
      db.prepare("INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key) VALUES ('s1a-no-row-yet', 'Ny Gard', '', 'test', 'a@b.no', 'https://x.no', 'producer', 'key-new')").run();
      const ins = knowledgeService.upsertKnowledge("s1a-no-row-yet", { about: "Ny rad", dataSource: "auto" });
      assertEq(ins.skipped, [], "lock-15: first insert (no row, no lock) skips nothing");
    }

    // Admin PUT /agents/:id/knowledge
    const put = (headers: Record<string, string>, body: any) =>
      invoke(H.putKnowledge, makeReq({ params: { id: LOCKED_ID }, headers, body }));
    setFlag(LOCK_FLAG, true);
    resetLocked();
    {
      const r = await put({ "x-admin-key": adminKey() }, { about: "Admin skriver", email: "admin@example.no" });
      assertEq(r.status, 200, "put-1: admin PUT answers 200");
      assertEq(r.body?.skipped, [{ field: "about", reason: "owner_locked" }], "put-2: flag on: response lists about as skipped: owner_locked");
      assertEq(lockedRow().about, OWNER_ABOUT, "put-3: owner-locked about unchanged by the admin PUT");
      assertEq(lockedRow().email, "admin@example.no", "put-4: unlocked field in the same PUT is written");
    }
    resetLocked();
    {
      const r = await put({ "x-api-key": `key-${LOCKED_ID}` }, { about: "Eieren via API-nøkkel" });
      assertEq(r.status, 200, "put-5: owner (API key) PUT answers 200");
      assertEq(r.body?.skipped, undefined, "put-6: owner path: no skipped key");
      assertEq(lockedRow().about, "Eieren via API-nøkkel", "put-7: owner path still changes an owner-locked field");
    }
    setFlag(LOCK_FLAG, false);
    resetLocked();
    {
      const r = await put({ "x-admin-key": adminKey() }, { about: "Admin skriver" });
      assertEq(r.status, 200, "put-8: flag off: admin PUT answers 200");
      assertEq(r.body?.skipped, undefined, "put-9: flag off: response has no skipped key (byte-identical)");
      assertEq(lockedRow().about, "Admin skriver", "put-10: flag off: owner-locked about is overwritten (today's behaviour)");
    }
  } catch (err) {
    failed++;
    failures.push(`owner-visibility-s1a: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    if (prevLockFlag === undefined) delete process.env[LOCK_FLAG]; else process.env[LOCK_FLAG] = prevLockFlag;
    if (prevVisFlag === undefined) delete process.env[VIS_FLAG]; else process.env[VIS_FLAG] = prevVisFlag;
    if (setKeyOurselves) delete process.env.ADMIN_KEY;
    clearRegistryCaches();
    if (prevDb) initMod.__setDbForTesting(prevDb);
    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* ignore */ }
    }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── dev-request 2026-10-22-rfb-mine-valg-eierbrytere S1a: owner lock + by-id visibility ──");
  runOwnerVisibilityS1aTests({ log: true }).then((r) => {
    console.log(`\nowner-visibility-s1a: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
