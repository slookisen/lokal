/**
 * owner-pause-s1b6.test.ts — dev-request 2026-10-22-rfb-mine-valg-eierbrytere,
 * slice S1b punkt 6 «Pause som virker» (flag OWNER_PAUSE_ENABLED, default OFF).
 *
 *   pause   a verified owner pauses → the profile is gone from search,
 *           lokal_search, lokal_info, sitemap (built + cached), ACP feeds,
 *           llms-full.txt and the by-id card; /produsent/:slug shows
 *           «Midlertidig pause» with <meta name="robots" content="noindex">.
 *   resume  unpause restores every surface; a resume date in the past
 *           restores with no write.
 *   gate    a session without verified ownership → 403 (card locked with
 *           the reason); another agent's session → 403; no session → 401.
 *   audit   one agent_knowledge_audit row per real change (both ways), none
 *           for a no-op.
 *   off     flag off → routes 404, no card, SQL byte-identical, a row with
 *           pause columns set is served everywhere exactly as before.
 *
 * Real routers/services on the production schema in an in-memory DB; handlers
 * pulled off the router stacks (same harness as owner-visibility-s1a.test.ts).
 * Exported runOwnerPauseS1b6Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-pause-s1b6.test.ts
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

const PAUSE_FLAG = "OWNER_PAUSE_ENABLED";
const OWNED_ID = "s1b6-owned";
const UNVERIFIED_ID = "s1b6-unverified";
const OTHER_ID = "s1b6-other";
const NAMES: Record<string, string> = {
  [OWNED_ID]: "Pauseprove Gard Eier",
  [UNVERIFIED_ID]: "Pauseprove Gard Ubekreftet",
  [OTHER_ID]: "Pauseprove Gard Nabo",
};

function seedProducer(db: Database.Database, id: string, claimed: boolean): void {
  db.prepare(
    `INSERT INTO agents
       (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
        categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
     VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, 1, 'discovery', 'rfb', 0, ?)`,
  ).run(
    id, NAMES[id],
    "Lokal produsent av poteter og grønnsaker i Oslo-området, med gårdsutsalg hver lørdag.",
    `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, claimed ? "2026-10-01T00:00:00.000Z" : null,
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

export async function runOwnerPauseS1b6Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevFlag = process.env[PAUSE_FLAG];
  const setFlag = (on: boolean) => { if (on) process.env[PAUSE_FLAG] = "1"; else delete process.env[PAUSE_FLAG]; };

  function findRouteHandler(router: any, path: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string }): any {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
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
        header() { return res; }, set() { return res; }, type() { return res; },
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
  const routeModules = ["./marketplace", "./marketplace-catalog", "./seo", "./discovery", "./owner-portal"];

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
    const seoRouter = seoMod.default as any;
    const discoveryRouter = require("./discovery").default as any;
    const ownerRouter = require("./owner-portal").default as any;
    const visibility = require("../services/agent-visibility") as typeof import("../services/agent-visibility");

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
      login: findRouteHandler(marketplaceRouter, "/auth/login", "post"),
      feed: findRouteHandler(catalogRouter, "/feed", "get"),
      acp: findRouteHandler(catalogRouter, "/acp-feed.csv", "get"),
      llmsFull: findRouteHandler(discoveryRouter, "/llms-full.txt", "get"),
      produsent: findRouteHandler(seoRouter, "/produsent/:slug", "get"),
      apiPause: findRouteHandler(ownerRouter, "/api/agents/:id/pause", "post"),
      formPause: findRouteHandler(ownerRouter, "/eier/:agentId/pause", "post"),
      portal: findRouteHandler(ownerRouter, "/eier/:agentId/portal", "get"),
    };

    seedProducer(db, OWNED_ID, true);
    seedProducer(db, UNVERIFIED_ID, false);
    seedProducer(db, OTHER_ID, true);
    const tokens: Record<string, string> = {};
    for (const id of [OWNED_ID, UNVERIFIED_ID, OTHER_ID]) {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    }
    const auditRows = (id: string) =>
      db.prepare("SELECT old_value, new_value, changed_by FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'visibility.profile' ORDER BY changed_at, rowid").all(id) as Array<{ old_value: string; new_value: string; changed_by: string }>;
    const pause = (id: string, body: any, token = tokens[id]) => invoke(H.apiPause, makeReq({ params: { id }, body, token }));
    const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

    // ═══ Predicate unit cases ═════════════════════════════════════════════
    setFlag(false);
    assertEq(visibility.ownerPauseEnabled(), false, "pred-1: OWNER_PAUSE_ENABLED defaults OFF");
    const offSql = visibility.publicListableSql("a");
    assertEq(offSql, "COALESCE(a.catalog_hidden, 0) = 0 AND COALESCE(a.vertical_id, 'rfb') = 'rfb'", "pred-2: flag off → publicListableSql byte-identical");
    const pausedRow = { is_active: 1, is_vetted: 1, catalog_hidden: 0, vertical_id: "rfb", origin: "discovery", owner_paused_at: "2026-10-26T00:00:00Z", owner_pause_until: null };
    assertTrue(visibility.isPubliclyListable(pausedRow), "pred-3: flag off → paused row still listable (columns ignored)");
    assertTrue(visibility.isAgentPubliclyVisible(pausedRow, { surface: "gated" }), "pred-4: flag off → paused row visible on by-id surfaces");
    setFlag(true);
    assertEq(visibility.publicListableSql("a"), `${offSql} AND a.id NOT IN (SELECT agent_id FROM owner_profile_pause WHERE COALESCE(pause_until, '9999-12-31') > date('now'))`, "pred-5: flag on → pause clause appended (wrap-safe)");
    assertTrue(!visibility.isPubliclyListable(pausedRow), "pred-6: flag on → paused row not listable");
    assertTrue(!visibility.isAgentPubliclyVisible(pausedRow, { surface: "ungated", allowCatalogHidden: true }), "pred-7: flag on → paused row hidden on ungated by-id surfaces too");
    const now = new Date("2026-10-26T12:00:00Z");
    assertTrue(visibility.isOwnerPaused({ owner_paused_at: "x", owner_pause_until: "2026-10-27" }, now), "pred-8: resume date tomorrow → paused");
    assertTrue(!visibility.isOwnerPaused({ owner_paused_at: "x", owner_pause_until: "2026-10-26" }, now), "pred-9: resume date today → restored");
    assertTrue(!visibility.isOwnerPaused({ owner_paused_at: null, owner_pause_until: "2099-01-01" }, now), "pred-10: not paused when owner_paused_at is NULL");
    setFlag(false);

    // ═══ Surfaces ═════════════════════════════════════════════════════════
    const ALL = [OWNED_ID, UNVERIFIED_ID, OTHER_ID];
    const idsInText = (t: unknown) => ALL.filter((id) => String(typeof t === "string" ? t : JSON.stringify(t ?? "")).includes(NAMES[id]));
    const idsInSitemap = (xml: string) => ALL.filter((id) => xml.includes(`/produsent/${slugify(NAMES[id])}<`));
    async function surfaces(): Promise<Record<string, string[]>> {
      clearRegistryCaches();
      const s: Record<string, string[]> = {};
      s.search = ((await invoke(H.search, makeReq({ query: { q: "Pauseprove", heleNorge: "true" } }))).body?.results ?? []).map((r: any) => r.agent.id);
      s.lokal_search = idsInText(await toolText("lokal_search", { query: "Pauseprove" }));
      s.lokal_info = [];
      for (const id of ALL) if (!(await toolText("lokal_info", { agentId: id })).startsWith("Fant ingen produsent")) s.lokal_info.push(id);
      s.card = [];
      for (const id of ALL) if ((await invoke(H.card, makeReq({ params: { id } }))).status === 200) s.card.push(id);
      s.catalog_feed = [...new Set(((await invoke(H.feed, makeReq({}))).body?.items ?? []).map((i: any) => i.seller.agent_id as string))] as string[];
      s.acp_feed_csv = idsInText((await invoke(H.acp, makeReq({}))).body);
      s.llms_full_txt = idsInText((await invoke(H.llmsFull, makeReq({}))).body);
      s.sitemap = idsInSitemap(seoMod.buildSitemapXml());
      s.sitemap_cached = idsInSitemap(seoMod.getSitemapXml());
      for (const k of Object.keys(s)) s[k] = ALL.filter((id) => s[k].includes(id));
      return s;
    }
    const produsentPage = async (id: string) => {
      const r = await invoke(H.produsent, makeReq({ params: { slug: slugify(NAMES[id]) } }));
      return { status: r.status, html: String(r.body ?? ""), robotsHeader: r.headers["x-robots-tag"] };
    };

    // Baseline with the flag on and nothing paused: everything visible.
    setFlag(true);
    seoMod.__resetSitemapCacheForTesting();
    const base = await surfaces();
    for (const [k, v] of Object.entries(base)) assertEq(v, ALL, `base-1: ${k} lists all three before any pause`);

    // ── Gate ──
    {
      const r = await pause(UNVERIFIED_ID, { paused: true });
      assertEq(r.status, 403, "gate-1: session without verified ownership → 403");
      assertEq(r.body?.error, "ownership_not_verified", "gate-2: …with error ownership_not_verified");
      const cross = await pause(OWNED_ID, { paused: true }, tokens[OTHER_ID]);
      assertEq(cross.status, 403, "gate-3: another agent's session → 403");
      const none = await invoke(H.apiPause, makeReq({ params: { id: OWNED_ID }, body: { paused: true } }));
      assertEq(none.status, 401, "gate-4: no session → 401");
      assertEq(auditRows(UNVERIFIED_ID).length + auditRows(OWNED_ID).length, 0, "gate-5: rejected requests write no audit row");
      const portal = await invoke(H.portal, makeReq({ params: { agentId: UNVERIFIED_ID }, token: tokens[UNVERIFIED_ID] }));
      const html = String(portal.body ?? "");
      assertTrue(html.includes('id="pause"') && html.includes("Pause kan bare brukes når eierskapet"), "gate-6: unverified owner sees the pause card locked with the reason");
      assertTrue(!html.includes(`action="/eier/${UNVERIFIED_ID}/pause"`), "gate-7: …and no pause form");
      assertTrue(html.includes("Be om sletting") && html.includes("mailto:kontakt@rettfrabonden.com"), "gate-8: «Be om sletting» goes to kundeservice");
      const bad = await pause(OWNED_ID, { paused: true, until: isoDay(-1) });
      assertEq(bad.status, 400, "gate-9: resume date in the past → 400");
      const badFmt = await pause(OWNED_ID, { paused: "maybe" });
      assertEq(badFmt.status, 400, "gate-10: paused not a boolean → 400");
    }

    // ── Pause ──
    {
      const portal0 = String((await invoke(H.portal, makeReq({ params: { agentId: OWNED_ID }, token: tokens[OWNED_ID] }))).body ?? "");
      assertTrue(portal0.includes(`action="/eier/${OWNED_ID}/pause"`) && portal0.includes("Sett profilen på pause"), "pause-0: verified owner sees the pause form");
      const r = await pause(OWNED_ID, { paused: true });
      assertEq([r.status, r.body?.paused, r.body?.changed], [200, true, true], "pause-1: verified owner pauses → 200");
      const s = await surfaces();
      const others = [UNVERIFIED_ID, OTHER_ID];
      for (const [k, v] of Object.entries(s)) assertEq(v, others, `pause-2: ${k} drops the paused profile`);
      const page = await produsentPage(OWNED_ID);
      assertEq(page.status, 200, "pause-3: profile page is not a 404");
      assertTrue(page.html.includes("Midlertidig pause"), "pause-4: profile page says «Midlertidig pause»");
      assertTrue(page.html.includes('<meta name="robots" content="noindex">'), "pause-5: profile page has <meta name=\"robots\" content=\"noindex\">");
      assertEq(page.robotsHeader, "noindex", "pause-6: X-Robots-Tag noindex");
      assertTrue(!page.html.includes("Listepoteter"), "pause-7: paused page shows no products");
      const rows = auditRows(OWNED_ID);
      assertEq(rows.map((x) => [x.old_value, x.new_value, x.changed_by]), [["on", "off (pause)", "owner"]], "pause-8: one audit row for the pause");
      const again = await pause(OWNED_ID, { paused: true });
      assertEq([again.status, again.body?.changed, auditRows(OWNED_ID).length], [200, false, 1], "pause-9: pausing again is a no-op, no extra row");
      const portal1 = String((await invoke(H.portal, makeReq({ params: { agentId: OWNED_ID }, token: tokens[OWNED_ID] }))).body ?? "");
      assertTrue(portal1.includes("midlertidig pause") && portal1.includes("Vis profilen igjen"), "pause-10: portal shows the paused state and the resume button");
      const login = await invoke(H.login, makeReq({ body: { token: "no-such-token" } }));
      assertEq(login.status, 401, "pause-11: /auth/login unchanged for bad tokens");
    }

    // ── Resume ──
    {
      const r = await invoke(H.formPause, makeReq({ params: { agentId: OWNED_ID }, body: { paused: "0" }, token: tokens[OWNED_ID] }));
      assertEq([r.status, r.body?.__redirect], [303, `/eier/${OWNED_ID}/portal?status=resumed#pause`], "resume-1: no-JS form resumes → 303 back to the portal");
      const s = await surfaces();
      for (const [k, v] of Object.entries(s)) assertEq(v, ALL, `resume-2: ${k} lists the profile again`);
      const page = await produsentPage(OWNED_ID);
      assertTrue(page.status === 200 && !page.html.includes("Midlertidig pause") && !page.html.includes('content="noindex"'), "resume-3: profile page is the normal, indexable page again");
      const rows = auditRows(OWNED_ID);
      assertEq(rows.map((x) => [x.old_value, x.new_value]), [["on", "off (pause)"], ["off (pause)", "on"]], "resume-4: one audit row each way");
    }

    // ── Resume date ──
    {
      const future = isoDay(10);
      const r = await pause(OWNED_ID, { paused: true, until: future });
      assertEq([r.status, r.body?.until], [200, future], "date-1: pause with a resume date");
      assertEq(auditRows(OWNED_ID).pop()?.new_value, `off (pause til ${future})`, "date-2: audit row carries the resume date");
      assertEq((await surfaces()).lokal_search, [UNVERIFIED_ID, OTHER_ID], "date-3: paused until the date");
      // The date passes (simulated by moving it into the past) → restored with no write.
      db.prepare("UPDATE owner_profile_pause SET pause_until = ? WHERE agent_id = ?").run(isoDay(-1), OWNED_ID);
      const s = await surfaces();
      // The cached sitemap is not invalidated by a passing date; it follows
      // within its TTL (SITEMAP_CACHE_TTL_MS, clamped to at most 60 min — AC 6).
      s.sitemap_cached = idsInSitemap(seoMod.getSitemapXml(Date.now() + 60 * 60 * 1000 + 1000));
      for (const [k, v] of Object.entries(s)) assertEq(ALL.filter((id) => v.includes(id)), ALL, `date-4: ${k} restored once the resume date has passed`);
      assertTrue(!(await produsentPage(OWNED_ID)).html.includes("Midlertidig pause"), "date-5: profile page restored after the resume date");
      const n = auditRows(OWNED_ID).length;
      const portal = String((await invoke(H.portal, makeReq({ params: { agentId: OWNED_ID }, token: tokens[OWNED_ID] }))).body ?? "");
      assertTrue(portal.includes("Sett profilen på pause"), "date-6: portal shows the profile as visible again");
      assertEq(auditRows(OWNED_ID).length, n, "date-7: reading the state writes nothing");
    }

    // ── Flag off: no change ──
    {
      db.prepare("INSERT OR REPLACE INTO owner_profile_pause (agent_id, paused_at, pause_until) VALUES (?, ?, NULL)").run(OWNED_ID, new Date().toISOString());
      setFlag(false);
      seoMod.__resetSitemapCacheForTesting();
      const s = await surfaces();
      for (const [k, v] of Object.entries(s)) assertEq(v, ALL, `off-1: ${k} ignores the pause columns with the flag off`);
      const page = await produsentPage(OWNED_ID);
      assertTrue(page.status === 200 && !page.html.includes("Midlertidig pause"), "off-2: profile page unchanged with the flag off");
      const n = auditRows(OWNED_ID).length;
      const r = await pause(OWNED_ID, { paused: false });
      assertEq(r.status, 404, "off-3: POST /api/agents/:id/pause → 404 with the flag off");
      const f = await invoke(H.formPause, makeReq({ params: { agentId: OWNED_ID }, body: { paused: "1" }, token: tokens[OWNED_ID] }));
      assertEq(f.status, 404, "off-4: POST /eier/:id/pause → 404 with the flag off");
      assertEq(auditRows(OWNED_ID).length, n, "off-5: no audit row with the flag off");
      const portal = String((await invoke(H.portal, makeReq({ params: { agentId: OWNED_ID }, token: tokens[OWNED_ID] }))).body ?? "");
      assertTrue(!portal.includes('id="pause"') && !portal.includes("Be om sletting"), "off-6: no pause card in the portal with the flag off");
      const claimToken = "s1b6-claim-token";
      try {
        db.prepare("INSERT INTO agent_claims (id, agent_id, claimant_email, claimant_name, status, claim_token, claim_token_expires_at) VALUES (?, ?, ?, ?, 'verified', ?, ?)")
          .run("claim-s1b6", OWNED_ID, `post@${OWNED_ID}.example.no`, "Eier", claimToken, new Date(Date.now() + 86_400_000).toISOString());
      } catch { /* schema differs — login check below is then skipped */ }
      const login = await invoke(H.login, makeReq({ body: { token: claimToken } }));
      if (login.status === 200) {
        assertEq(Object.keys(login.body?.data ?? {}), ["agentId", "claimantName"], "off-7: /auth/login body unchanged with the flag off");
        setFlag(true);
        const l2 = await invoke(H.login, makeReq({ body: { token: claimToken } }));
        assertEq(l2.body?.data?.ownerPauseEnabled, true, "on-7: /auth/login tells /selger to swap «Meld nedlagt» with the flag on");
        setFlag(false);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push(`✗ unexpected error: ${String(err?.stack || err)}`);
  } finally {
    console.log = prevLog;
    if (prevFlag === undefined) delete process.env[PAUSE_FLAG]; else process.env[PAUSE_FLAG] = prevFlag;
    if (prevDb) initMod.__setDbForTesting(prevDb as any);
    clearRegistryCaches();
    try { (require("./seo") as typeof import("./seo")).__resetSitemapCacheForTesting(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerPauseS1b6Tests({ log: true }).then((r) => {
    console.info(`\nowner-pause-s1b6: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      for (const f of r.failures) console.info(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
