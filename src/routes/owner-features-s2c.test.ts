/**
 * owner-features-s2c.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S2c-1: the owner's contact / price / stats choices enforced on the
 * public surfaces each key declares in the registry (`surfaces`).
 *
 *   gate      OWNER_FEATURES_ENFORCE off, or the subject not in
 *             OWNER_FEATURES_ALLOWED_SUBJECTS → every surface byte-identical
 *             to the run before any choice was stored (profile HTML, lokal_info,
 *             lokal_search, /card, /vcard, /info, /search, ACP feeds); no DB
 *             query for the lookup. With the real registry (keys still
 *             coming_soon) a stored owner choice has no effect.
 *   matrix    AC12/AC23: per enforced key × declared surface, default → off →
 *             on again, the field present / absent / present. A neighbour
 *             producer outside the allowlist is never affected.
 *   coverage  every enforced key has a matrix probe for each of its surfaces;
 *             a fixture key with an uncovered surface is reported.
 *   batch     list lookups resolve all allowlisted subjects with one query.
 *
 * Real routers/services on the production schema in an in-memory DB; handlers
 * pulled off the router stacks (same harness as owner-pause-s1b6.test.ts).
 * Exported runOwnerFeaturesS2cTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-features-s2c.test.ts
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
const ENF_ID = "s2c-owned";
const TWIN_ID = "s2c-twin";
const NAMES: Record<string, string> = {
  [ENF_ID]: "Bryterprove Gard Eier",
  [TWIN_ID]: "Bryterprove Gard Tvilling",
};
const PHONE = "+47 912 34 567";
const STREET = "Gardsvegen 12";
const PRICE = "30 kr/kg";
const NAME_PRICE = "kr 85";
const TERM = "rabarbrasaft oslo";

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
     VALUES (?, ?, ?, ?, ?, '0150', ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
  ).run(
    id, `post@${id}.example.no`, `https://${id}.example.no`, PHONE, STREET,
    "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
    JSON.stringify([
      { name: "Listepoteter", price: PRICE, category: "vegetables" },
      { name: `Rabarbrasaft – ${NAME_PRICE}`, category: "beverages" },
    ]),
  );
  db.prepare(
    `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url)
     VALUES (?, ?, 'Listepoteter', 'listepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg')`,
  ).run(`prod-${id}`, id);
  const conv = db.prepare(
    `INSERT INTO conversations (id, seller_agent_id, source, query_text, created_at) VALUES (?, ?, 'a2a', ?, datetime('now', '-1 days'))`,
  );
  for (let i = 0; i < 3; i++) conv.run(`conv-${id}-${i}`, id, TERM);
  const pv = db.prepare(
    `INSERT INTO analytics_page_views (path, session_id, is_owner, created_at) VALUES (?, ?, 0, datetime('now', '-2 days'))`,
  );
  for (let i = 0; i < 4; i++) pv.run(`/produsent/${slugify(NAMES[id])}`, `iphash${id}${i}:Mozilla/5.0 (Macintosh) Chrome/120`);
}

/** One probe: the markers of the key's field on a surface for the producer right now. */
type Probe = (id: string) => Promise<boolean[]>;

export async function runOwnerFeaturesS2cTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevAllow = process.env[ALLOW_ENV];
  const prevEnforce = process.env[ENFORCE_ENV];
  const setEnv = (name: string, v: string | null) => { if (v === null) delete process.env[name]; else process.env[name] = v; };

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; query?: Record<string, string>; headers?: Record<string, string> }): any {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: undefined, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
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
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./mcp"];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence registry/seo chatter */ };

  const enforce = require("../owner-features/enforce") as typeof import("../owner-features/enforce");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    clearRegistryCaches();
    setEnv(ALLOW_ENV, null);
    setEnv(ENFORCE_ENV, null);

    for (const m of routeModules) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const marketplaceRouter = require("./marketplace").default as any;
    const { catalogRouter } = require("./marketplace-catalog") as typeof import("./marketplace-catalog");
    const seoRouter = (require("./seo") as typeof import("./seo")).default as any;
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");

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
      card: findRouteHandler(marketplaceRouter, "/agents/:id/card", "get"),
      vcard: findRouteHandler(marketplaceRouter, "/agents/:id/vcard", "get"),
      info: findRouteHandler(marketplaceRouter, "/agents/:id/info", "get"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
    };

    seedProducer(db, ENF_ID);
    seedProducer(db, TWIN_ID);
    const OWNER_CLAIM = "s2c-owner-claim";
    db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at) VALUES (?, ?, ?, ?, 'verified', ?, ?)")
      .run("claim-s2c", ENF_ID, `post@${ENF_ID}.example.no`, "Eier", OWNER_CLAIM, new Date(Date.now() + 86_400_000).toISOString());

    // ── Surface readers ───────────────────────────────────────────────────
    const LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    const page = async (id: string) => String((await invoke(H.produsent, makeReq({ params: { slug: slugify(NAMES[id]) } }))).body ?? "");
    const visibleHtml = async (id: string) => (await page(id)).replace(LD_RE, "");
    const jsonLd = async (id: string) => [...(await page(id)).matchAll(LD_RE)].map((m) => m[1]).join("\n");
    const lokalInfo = (id: string) => toolText("lokal_info", { agentId: id });
    const lokalSearch = (id: string) => toolText("lokal_search", { query: NAMES[id] });
    const card = async (id: string) => (await invoke(H.card, makeReq({ params: { id } }))).body;
    const vcard = async (id: string) => String((await invoke(H.vcard, makeReq({ params: { id } }))).body ?? "");
    const restInfo = async (id: string, claim?: string) =>
      (await invoke(H.info, makeReq({ params: { id }, headers: claim ? { "x-claim-token": claim } : {} }))).body;
    const restSearch = async (id: string) =>
      ((await invoke(H.search, makeReq({ query: { q: NAMES[id], heleNorge: "true" } }))).body?.results ?? []).find((r: any) => r.agent?.id === id);
    const feedItem = async (id: string) =>
      ((await invoke(H.feed, makeReq({}))).body?.items ?? []).find((i: any) => i.seller?.agent_id === id);
    const acpCsv = async () => String((await invoke(H.acp, makeReq({}))).body ?? "");
    // A name query returns that producer only (detailed view).
    const searchBlock = (text: string, id: string) => text.includes(`**1. ${NAMES[id]}**`) ? text : "";

    // ── The matrix: key → surface → probe (true = field shown) ─────────────
    // `today: false` marks a declared surface that does not render the field
    // at all today: the probe must then stay false in every state.
    interface MatrixCase { probe: Probe; today?: boolean }
    const MATRIX: Record<string, { off: unknown; on: unknown; surfaces: Record<string, MatrixCase> }> = {
      "contact.phone": {
        off: false, on: true,
        surfaces: {
          profile_html: { probe: async (id) => { const h = await visibleHtml(id); return [h.includes("912 34 567"), h.includes("tel:+4791234567")]; } },
          json_ld: { probe: async (id) => [(await jsonLd(id)).includes('"telephone"')] },
          mcp_search: { probe: async (id) => [searchBlock(await lokalSearch(id), id).includes("📞"), (await restSearch(id))?.contact?.phone === PHONE] },
          mcp_info: { probe: async (id) => [(await lokalInfo(id)).includes("📞")] },
          rest_card: { probe: async (id) => [(await card(id))?.contact?.phone === PHONE, (await restInfo(id))?.data?.knowledge?.phone === PHONE] },
          vcard: { probe: async (id) => [(await vcard(id)).includes("\r\nTEL;")] },
        },
      },
      "contact.address": {
        off: "place", on: "full",
        surfaces: {
          profile_html: { probe: async (id) => { const h = await visibleHtml(id); return [h.includes(STREET), h.includes("0150")]; } },
          json_ld: { probe: async (id) => { const ld = await jsonLd(id); return [ld.includes('"streetAddress"'), ld.includes('"GeoCoordinates"'), ld.includes(STREET)]; } },
          mcp_search: { probe: async (id) => [searchBlock(await lokalSearch(id), id).includes(STREET), (await restSearch(id))?.contact?.address === STREET] },
          mcp_info: { probe: async (id) => [(await lokalInfo(id)).includes(STREET)] },
          rest_card: {
            probe: async (id) => {
              const c = await card(id);
              const k = (await restInfo(id))?.data?.knowledge;
              return [c?.contact?.address === STREET, c?.contact?.postalCode === "0150", String(c?.links?.googleMaps).includes("Gardsvegen"), k?.address === STREET, k?.postalCode === "0150"];
            },
          },
          vcard: { probe: async (id) => { const v = await vcard(id); return [v.includes(STREET), v.includes("0150")]; } },
        },
      },
      "products.show_prices": {
        off: false, on: true,
        surfaces: {
          profile_html: { probe: async (id) => { const h = await visibleHtml(id); return [h.includes('class="prod-price"'), h.includes(PRICE), h.includes(NAME_PRICE)]; } },
          json_ld: { probe: async (id) => { const ld = await jsonLd(id); return [ld.includes('"price"'), ld.includes('"makesOffer"')]; } },
          mcp_search: {
            probe: async (id) => {
              const t = searchBlock(await lokalSearch(id), id);
              const r = await restSearch(id);
              return [t.includes(PRICE), t.includes(NAME_PRICE), !!r?.products?.some((p: any) => p.price === PRICE)];
            },
          },
          mcp_info: { probe: async (id) => { const t = await lokalInfo(id); return [t.includes(PRICE), t.includes(NAME_PRICE)]; } },
          rest_card: {
            probe: async (id) => {
              const c = JSON.stringify((await card(id))?.products);
              const k = JSON.stringify((await restInfo(id))?.data?.knowledge?.products);
              return [c.includes(PRICE), c.includes(NAME_PRICE), k.includes(PRICE), k.includes(NAME_PRICE)];
            },
          },
          vcard: { probe: async (id) => { const v = await vcard(id); return [v.includes(`(${PRICE})`), v.includes(NAME_PRICE)]; } },
          acp_feed: { probe: async (id) => [(await feedItem(id))?.price?.amount === 30, (await acpCsv()).includes(`prod-${id}`)] },
        },
      },
      "stats.public_counts": {
        off: false, on: true,
        surfaces: {
          profile_html: {
            probe: async (id) => {
              const h = await visibleHtml(id);
              return [h.includes('class="pf-stat" data-stat="human"'), h.includes('class="pf-stat" data-stat="ai"'), h.includes('class="pf-stat" data-stat="aiDeliveries"'), h.includes("Profilvisninger")];
            },
          },
        },
      },
      "stats.public_search_terms": {
        off: false, on: true,
        surfaces: {
          profile_html: { probe: async (id) => { const h = await visibleHtml(id); return [h.includes(TERM), h.includes("Hva folk søker etter")]; } },
        },
      },
      "stats.public_trust": {
        off: false, on: true,
        surfaces: {
          profile_html: { probe: async (id) => [/tillitsscore|trust ?score/i.test((await visibleHtml(id)).replace(/<!--[\s\S]*?-->/g, ""))], today: false },
          rest_card: { probe: async (id) => [typeof (await card(id))?.["x-lokal"]?.trustScore === "number", typeof (await restInfo(id))?.data?.agent?.trustScore === "number"] },
          vcard: { probe: async (id) => [(await vcard(id)).includes("X-LOKAL-TRUST-SCORE")] },
          mcp_info: { probe: async (id) => [/tillit|trust/i.test(await lokalInfo(id))], today: false },
        },
      },
    };
    /** "shown" when every marker is there, "absent" when none is, else "mixed". */
    const state = async (c: MatrixCase, id: string): Promise<string> => {
      const m = await c.probe(id);
      return m.every(Boolean) ? "shown" : m.some(Boolean) ? "mixed" : "absent";
    };

    // ── Coverage (AC23) ───────────────────────────────────────────────────
    const missingMatrixCoverage = (keys: readonly string[], registry: import("../owner-features/registry").OwnerFeatureEntry[]): string[] => {
      const missing: string[] = [];
      for (const key of keys) {
        const e = registry.find((x) => x.key === key);
        if (!e) { missing.push(`${key}: not in registry`); continue; }
        for (const s of e.surfaces) if (!MATRIX[key]?.surfaces[s]) missing.push(`${key} × ${s}`);
      }
      return missing;
    };
    {
      assertEq(missingMatrixCoverage(enforce.ENFORCED_OWNER_FEATURE_KEYS, reg.OWNER_FEATURE_REGISTRY), [],
        "coverage-1: every enforced key has a matrix probe for each declared surface");
      const fixture = reg.OWNER_FEATURE_REGISTRY.map((e) => e.key === "contact.phone" ? { ...e, surfaces: [...e.surfaces, "llms" as const] } : e);
      assertEq(missingMatrixCoverage(enforce.ENFORCED_OWNER_FEATURE_KEYS, fixture), ["contact.phone × llms"],
        "coverage-2: a fixture key with an uncovered surface is reported");
      assertEq(missingMatrixCoverage([...enforce.ENFORCED_OWNER_FEATURE_KEYS, "visibility.leaderboard"], reg.OWNER_FEATURE_REGISTRY), ["visibility.leaderboard × leaderboard"],
        "coverage-3: a newly enforced key without probes is reported");
      for (const key of enforce.ENFORCED_OWNER_FEATURE_KEYS) {
        const e = reg.getOwnerFeature(key);
        assertEq(e.status, "coming_soon", `status-1: ${key} stays coming_soon until the S2d switch probe`);
        assertEq(e.default.owner, MATRIX[key].on, `status-2: ${key} owner default is the shown value`);
      }
    }

    // ── Snapshot of every surface, for the byte-identity checks ────────────
    async function snapshot(id: string): Promise<Record<string, string>> {
      clearRegistryCaches();
      const strip = (s: string) => s.replace(/^REV:.*$/m, "REV:x");
      return {
        profile_html: await page(id),
        lokal_info: await lokalInfo(id),
        lokal_search: await lokalSearch(id),
        lokal_discover: await toolText("lokal_discover", { categories: ["vegetables"] }),
        card: JSON.stringify(await card(id)),
        vcard: strip(await vcard(id)),
        info: JSON.stringify(await restInfo(id)),
        rest_search: JSON.stringify(await restSearch(id)),
        feed: JSON.stringify(await feedItem(id)),
        acp_csv: await acpCsv(),
      };
    }
    const sameSnapshot = (a: Record<string, string>, b: Record<string, string>, label: string) => {
      for (const k of Object.keys(a)) assertTrue(a[k] === b[k], `${label}: ${k} byte-identical`);
    };

    const LIVE = reg.OWNER_FEATURE_REGISTRY.map((e) =>
      (enforce.ENFORCED_OWNER_FEATURE_KEYS as readonly string[]).includes(e.key) ? { ...e, status: "live" as const } : e);
    const setChoice = (key: string, value: unknown) => {
      const r = rs.setOwnerFeatureValue("rfb", ENF_ID, key, value, { actor: "owner" }, { db, registry: LIVE });
      if (r.kind !== "ok") throw new Error(`setOwnerFeatureValue(${key}) → ${r.kind}`);
    };
    const clearChoices = () => db.prepare("DELETE FROM owner_feature_settings WHERE subject_id = ?").run(ENF_ID);
    const hideEverything = () => { for (const [key, m] of Object.entries(MATRIX)) setChoice(key, m.off); };

    const baseline = await snapshot(ENF_ID);
    const baselineTwin = await snapshot(TWIN_ID);
    {
      const again = await snapshot(ENF_ID);
      sameSnapshot(baseline, again, "base-0: two runs without choices");
      for (const [key, m] of Object.entries(MATRIX)) {
        for (const [surface, c] of Object.entries(m.surfaces)) {
          clearRegistryCaches();
          assertEq(await state(c, ENF_ID), c.today === false ? "absent" : "shown", `base-1: ${key} × ${surface} shown today`);
        }
      }
    }

    // ── Gate: byte-identical while not enforced ───────────────────────────
    enforce.__setEnforceRegistryForTesting(LIVE);
    hideEverything();
    {
      setEnv(ENFORCE_ENV, null);
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-1: enforce flag unset, subject allowlisted, everything hidden");
      setEnv(ENFORCE_ENV, "0");
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-2: enforce flag \"0\"");
      setEnv(ENFORCE_ENV, "1");
      setEnv(ALLOW_ENV, null);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-3: enforce on, allowlist empty");
      setEnv(ALLOW_ENV, `rfb:${TWIN_ID}`);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-4: enforce on, another subject allowlisted");
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
      enforce.__setEnforceRegistryForTesting(null);
      sameSnapshot(baseline, await snapshot(ENF_ID), "gate-5: enforce on + allowlisted, real registry (coming_soon) → owner choice has no effect yet");
      enforce.__setEnforceRegistryForTesting(LIVE);
      const hidden = await snapshot(ENF_ID);
      assertTrue(hidden.profile_html !== baseline.profile_html && hidden.lokal_info !== baseline.lokal_info,
        "gate-6: enforce on + allowlisted + live keys → the surfaces change");
      const twin = await snapshot(TWIN_ID);
      for (const k of ["lokal_discover", "acp_csv"]) { delete twin[k]; delete baselineTwin[k]; }
      sameSnapshot(baselineTwin, twin, "gate-7: a neighbour outside the allowlist stays as before");

      // No lookup query at all while not enforced.
      let queries = 0;
      const realPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => { queries++; return realPrepare(sql); };
      try {
        setEnv(ENFORCE_ENV, null);
        enforce.publicFieldChoicesForMany([ENF_ID, TWIN_ID]);
        assertEq(queries, 0, "gate-8: flag off → the lookup runs no query");
        setEnv(ENFORCE_ENV, "1");
        setEnv(ALLOW_ENV, null);
        enforce.publicFieldChoicesForMany([ENF_ID, TWIN_ID]);
        assertEq(queries, 0, "gate-9: allowlist empty → the lookup runs no query");
        setEnv(ALLOW_ENV, `rfb:${ENF_ID},rfb:${TWIN_ID}`);
        queries = 0;
        const many = enforce.publicFieldChoicesForMany([ENF_ID, TWIN_ID, "s2c-unknown", ENF_ID]);
        assertEq(queries, 1, "batch-1: a list of allowlisted subjects resolves with one query");
        assertEq([...many.keys()].sort(), [ENF_ID, TWIN_ID].sort(), "batch-2: one entry per existing allowlisted subject");
        assertEq(many.get(ENF_ID)?.phone, false, "batch-3: the stored choice is read");
        assertEq(many.get(TWIN_ID)?.phone, true, "batch-4: no choice → the default (shown)");
      } finally {
        (db as any).prepare = realPrepare;
      }
      setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    }

    // Admin lock takes effect even while the keys are coming_soon.
    {
      enforce.__setEnforceRegistryForTesting(null);
      clearChoices();
      db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
                  VALUES ('rfb', ?, 'contact.phone', 'false', 'admin', 1, ?)`).run(ENF_ID, new Date().toISOString());
      assertEq(await state(MATRIX["contact.phone"].surfaces.mcp_info, ENF_ID), "absent", "admin-1: an admin lock hides the phone with the real registry");
      clearChoices();
      enforce.__setEnforceRegistryForTesting(LIVE);
    }

    // ── Matrix (AC12/AC23): default → off → on again ──────────────────────
    setEnv(ENFORCE_ENV, "1");
    setEnv(ALLOW_ENV, `rfb:${ENF_ID}`);
    for (const [key, m] of Object.entries(MATRIX)) {
      clearChoices();
      const steps: Array<[string, unknown | undefined, boolean]> = [["default", undefined, true], ["off", m.off, false], ["on", m.on, true]];
      for (const [step, value, shown] of steps) {
        if (value !== undefined) setChoice(key, value);
        for (const [surface, c] of Object.entries(m.surfaces)) {
          clearRegistryCaches();
          const expected = c.today === false || !shown ? "absent" : "shown";
          assertEq(await state(c, ENF_ID), expected, `matrix: ${key} × ${surface} ${step} → ${expected}`);
          if (step === "off") assertEq(await state(c, TWIN_ID), c.today === false ? "absent" : "shown", `matrix: ${key} × ${surface} off leaves the neighbour as before`);
        }
      }
    }
    clearChoices();

    // ── Details of the hidden state ───────────────────────────────────────
    {
      hideEverything();
      clearRegistryCaches();
      const html = await visibleHtml(ENF_ID);
      assertTrue(html.includes("Listepoteter") && html.includes("Rabarbrasaft"), "detail-1: hiding prices keeps the products on the profile");
      assertTrue(html.includes("Oslo"), "detail-2: «Bare sted» keeps the place");
      const ld = await jsonLd(ENF_ID);
      assertTrue(ld.includes('"Listepoteter"') && !ld.includes('"makesOffer"'), "detail-3: JSON-LD lists the products as names only");
      const info = await lokalInfo(ENF_ID);
      assertTrue(info.includes("Listepoteter") && info.includes("Rabarbrasaft") && !info.includes("Kategorier:"),
        "detail-4: lokal_info keeps both products as products (no category-label fallout)");
      assertTrue(info.includes("vCard") && info.includes("✉️"), "detail-5: lokal_info keeps e-mail and vCard link");
      const ownerInfo = await restInfo(ENF_ID, OWNER_CLAIM);
      assertTrue(ownerInfo?.data?.knowledge?.phone === PHONE && ownerInfo?.data?.knowledge?.address === STREET &&
        JSON.stringify(ownerInfo?.data?.knowledge?.products).includes(PRICE),
        "detail-6: the owner's /selger read (X-Claim-Token) still gets the full record");
      const wrongClaim = await restInfo(ENF_ID, "not-a-claim");
      assertTrue(wrongClaim?.data?.knowledge?.phone === undefined, "detail-7: an unknown claim token gets the public read");
      const csv = await acpCsv();
      assertTrue(!csv.includes(`prod-${ENF_ID}`) && csv.includes(`prod-${TWIN_ID}`), "detail-8: ACP CSV leaves out the hidden-price producer's rows only");
      clearChoices();
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    {
      assertEq(enforce.productWithoutPrice({ name: "Lammelår – kr 275/kg", category: "meat" }), { name: "Lammelår", category: "meat" },
        "helper-1: a price in the name is cut");
      assertEq(enforce.productWithoutPrice({ name: "Egg", price: "60 kr/brett", priceUnit: "brett" }), { name: "Egg" },
        "helper-2: price field and unit are dropped");
      assertEq(enforce.productWithoutPrice("Honning kr 120"), "Honning", "helper-3: a text entry is cut too");
      assertEq(enforce.productWithoutPrice({ name: "🥩 KJØTT", price: "fra gården" }), { name: "🥩 KJØTT", price: "fra gården" },
        "helper-4: a section header keeps its descriptor");
      const k = { phone: PHONE, address: STREET, postalCode: "0150", email: "a@b.no" };
      assertTrue(enforce.withoutHiddenFields(k, null) === k, "helper-5: not enforced → the same object");
      assertTrue(enforce.withoutHiddenFields(k, { phone: true, address: true, prices: true, publicCounts: false, publicSearchTerms: false, publicTrust: false }) === k,
        "helper-6: nothing hidden in the knowledge → the same object");
      assertEq(enforce.withoutHiddenContact(k, { phone: false, address: false, prices: true, publicCounts: true, publicSearchTerms: true, publicTrust: true }), { email: "a@b.no" },
        "helper-7: phone, address and postal code removed");
      assertEq(k.phone, PHONE, "helper-8: the input is not mutated");
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    enforce.__setEnforceRegistryForTesting(null);
    setEnv(ALLOW_ENV, prevAllow ?? null);
    setEnv(ENFORCE_ENV, prevEnforce ?? null);
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerFeaturesS2cTests({ log: true }).then((r) => {
    console.info(`\nowner-features-s2c: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
