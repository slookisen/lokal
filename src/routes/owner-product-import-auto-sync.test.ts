/**
 * owner-product-import-auto-sync.test.ts — dev-request 2026-10-21-rfb-
 * produktimport-fra-egen-nettside, Skive 4-2a (= Skive 4a + visibility, no
 * «Mine valg» switch): the «Hold prisene oppdatert automatisk hver uke» box on
 * the import page, the auto-sync status for the owner and the profile page's
 * «Oppdatert automatisk fra <domene> <dato>».
 *
 *   AC4a   ticked «Publiser valgte» → product_sync_mode 'weekly' + one
 *          agent_knowledge_audit row (products.weekly_sync), in the publish
 *          transaction (a failing extra write rolls the publish back);
 *          unticked → the mode is unchanged (no row; an existing 'weekly'
 *          stays); the box is ticked when the mode already is 'weekly'.
 *   hidden flag PRODUCT_AUTO_SYNC_ENABLED off or is_verified = 0 → no box,
 *          and the server ignores a submitted tick.
 *   status the portal card / import page show the last success + changes,
 *          the lock reason or why it was turned off; nothing with the flag
 *          off.
 *   profile owner_auto_sync products get «Oppdatert automatisk fra …» only
 *          with the flag on; flag off = the line as before.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch injected (no network); fixed clock. Env restored in finally.
 * Exported runOwnerImportAutoSyncTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-product-import-auto-sync.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "PRODUCT_IMPORT_ENABLED", "PRODUCT_AUTO_SYNC_ENABLED", "OWNER_LOCK_ENFORCE_WRITES", "OWNER_VERIFIED_OWNER_GATE_ENABLED",
  "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OWNER_PAUSE_ENABLED",
  "OWNER_ORDER_EMAIL_ENABLED",
];
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 6, 10, 0, 0);

type FakeRoute = { status?: number; body: string; contentType?: string };
const ROBOTS_OPEN: FakeRoute = { body: "User-agent: *\nDisallow:\n", contentType: "text/plain" };

function shopifySite(host: string, products: Array<{ title: string; handle: string; price: string }>): Record<string, FakeRoute> {
  return {
    [`https://${host}/robots.txt`]: ROBOTS_OPEN,
    [`https://${host}/products.json?limit=250`]: {
      contentType: "application/json",
      body: JSON.stringify({
        products: products.map((p) => ({ title: p.title, handle: p.handle, variants: [{ title: "Default Title", price: p.price }] })),
      }),
    },
  };
}

export async function runOwnerImportAutoSyncTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => undefined; console.error = () => undefined; }

  let oi: typeof import("../services/product-import/owner-import") | null = null;
  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    oi = require("../services/product-import/owner-import") as typeof import("../services/product-import/owner-import");
    const as = require("../services/product-import/auto-sync") as typeof import("../services/product-import/auto-sync");
    const robots = require("../services/product-import/robots") as typeof import("../services/product-import/robots");
    const importRouter = (require("./owner-product-import") as any).default;
    const importMod = require("./owner-product-import") as typeof import("./owner-product-import");
    const portalRouter = (require("./owner-portal") as any).default;
    const portalMod = require("./owner-portal") as typeof import("./owner-portal");
    const seo = require("./seo") as typeof import("./seo");
    const ks = require("../services/knowledge-service") as typeof import("../services/knowledge-service");
    robots.__clearRobotsCacheForTesting();
    oi.__forgetOwnerFetchJobsForTesting();

    // ─── Harness ───────────────────────────────────────────────────────────
    const handlerOf = (r: any, path: string, method: "get" | "post"): Function => {
      const layer = (r.stack as any[]).find((l: any) => l.route && l.route.path === path && l.route.methods?.[method]);
      if (!layer) throw new Error(`route not found: ${method} ${path}`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    };
    const H = {
      portal: handlerOf(portalRouter, "/eier/:agentId/portal", "get"),
      hent: handlerOf(importRouter, "/eier/:agentId/produktimport/hent", "post"),
      page: handlerOf(importRouter, "/eier/:agentId/produktimport/:runId", "get"),
      publish: handlerOf(importRouter, "/eier/:agentId/produktimport/:runId/publiser", "post"),
    };
    type Res = { status: number; body: any; location?: string };
    const invoke = (handler: Function, o: { params: Record<string, string>; token?: string; body?: any; query?: Record<string, string> }) =>
      new Promise<Res>((resolve) => {
        const headers: Record<string, string> = { host: "rettfrabonden.com" };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        const req: any = {
          method: "GET", params: o.params, body: o.body, query: o.query || {}, headers, cookies: {}, ip: "127.0.0.1",
          get: (n: string) => headers[n.toLowerCase()],
        };
        let status = 200;
        let settled = false;
        const settle = (r: Res) => { if (!settled) { settled = true; resolve(r); } };
        const res: any = {
          status(c: number) { status = c; return res; },
          json(b: any) { settle({ status, body: b }); return res; },
          send(b: any) { settle({ status, body: b }); return res; },
          redirect(c: number, loc: string) { settle({ status: c, body: "", location: loc }); return res; },
          setHeader() { return res; }, set() { return res; }, header() { return res; }, type() { return res; },
          cookie() { return res; }, clearCookie() { return res; },
        };
        try {
          const p = handler(req, res, () => settle({ status: 0, body: "next" }));
          if (p && typeof p.catch === "function") p.catch((e: any) => settle({ status: -1, body: String(e) }));
        } catch (e) { settle({ status: -1, body: String(e) }); }
      });
    const html = (r: Res) => String(r.body ?? "");

    // ─── Fixture ───────────────────────────────────────────────────────────
    const addAgent = (id: string, o: { verified: number; mode?: "off" | "weekly" }) => {
      db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at, claimed_at, vertical_id)
         VALUES (?, ?, 'En liten gård.', 'p', ?, 'https://example.no', 'producer', ?,
          '["meat"]', '[]', '[]', '{}', '["no"]', 'Testby', 59.91, 10.75, 0.7, 1, ?, 0, 0, 0, datetime('now'), datetime('now'),
          '2026-10-01T00:00:00.000Z', 'rfb')`,
      ).run(id, `Gard ${id}`, `post@${id}.example.no`, `key-${id}`, o.verified);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, products, data_source, verification_status, verified_second_line)
         VALUES (?, ?, ?, ?, 'hybrid', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, `https://${id}.no`, JSON.stringify([
        { name: "Lammelår", category: "meat", seasonal: false, price: "kr 250/kg", priceUnit: "kr", source: "owner_manual", confirmedAt: "2026-10-01T10:00:00.000Z" },
      ]));
      db.prepare(
        `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
         VALUES (?, ?, 'Eier', ?, 'verified', '2026-10-01T00:00:00.000Z')`,
      ).run(`claim-${id}`, id, `post@${id}.example.no`);
      if (o.mode) db.prepare(`INSERT INTO product_auto_sync_state (agent_id, product_sync_mode) VALUES (?, ?)`).run(id, o.mode);
    };
    const tokens: Record<string, string> = {};
    const session = (id: string) => {
      tokens[id] = `tok-${id}`;
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, tokens[id], id, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    };
    const IDS = ["ws-off", "ws-on", "ws-unt", "ws-wk", "ws-tx", "ws-unver"];
    addAgent("ws-off", { verified: 1 });
    addAgent("ws-on", { verified: 1 });
    addAgent("ws-unt", { verified: 1 });
    addAgent("ws-wk", { verified: 1, mode: "weekly" });
    addAgent("ws-tx", { verified: 1 });
    addAgent("ws-unver", { verified: 0 });
    for (const id of IDS) session(id);

    const routes: Record<string, FakeRoute> = {};
    for (const id of IDS) {
      Object.assign(routes, shopifySite(`${id}.no`, [
        { title: "Lammelår", handle: "lammelar", price: "289.00" },
        { title: "Honning", handle: "honning", price: "120.00" },
      ]));
    }
    const fetchImpl = (async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const r = routes[url] ?? { status: 404, body: "<html><body>404</body></html>" };
      return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.contentType ?? "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    oi.__setOwnerImportDepsForTesting({ fetchImpl, llm: async () => ({ text: "[]" }), now: () => T0, sleep: async () => undefined, hostIntervalMs: 0 });

    const portalFor = (id: string) => invoke(H.portal, { params: { agentId: id }, token: tokens[id] });
    const pageFor = (id: string, runId: string) => invoke(H.page, { params: { agentId: id, runId }, token: tokens[id] });
    const publishFor = (id: string, runId: string, body: any) => invoke(H.publish, { params: { agentId: id, runId }, token: tokens[id], body });
    const fetchRun = async (id: string): Promise<string> => {
      const f = await invoke(H.hent, { params: { agentId: id }, token: tokens[id], body: {} });
      const m = new RegExp(`^/eier/${id}/produktimport/([A-Za-z0-9_-]+)$`).exec(f.location ?? "");
      const runId = m ? m[1]! : "";
      if (runId) await oi!.__awaitOwnerFetchForTesting(runId);
      return runId;
    };
    const candIds = (runId: string) =>
      (db.prepare("SELECT id FROM product_import_candidates WHERE run_id = ? ORDER BY position").all(runId) as Array<{ id: string }>).map((r) => r.id);
    const modeOf = (id: string) => as.readAutoSyncState(id)?.product_sync_mode ?? null;
    const syncAudits = (id: string) =>
      (db.prepare("SELECT old_value, new_value, changed_by, changed_by_email FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = 'products.weekly_sync'")
        .all(id) as Array<Record<string, unknown>>);
    const names = (id: string) => ((ks.knowledgeService.getKnowledge(id)?.products || []) as any[]).map((p) => p.name).sort();
    const hasBox = (h: string) => h.includes('data-weekly-sync-box=');
    const TICK = importMod.WEEKLY_SYNC_FIELD;

    process.env.PRODUCT_IMPORT_ENABLED = "1";

    // ─── Flag off: no box, a submitted tick is ignored ──────────────────────
    {
      const run = await fetchRun("ws-off");
      assertTrue(run !== "", "flag off: fetch completed");
      const page = html(await pageFor("ws-off", run));
      assertTrue(page.includes("Publiser valgte") && !hasBox(page) && !page.includes("Hold prisene oppdatert"), "flag off: no weekly box on the import page");
      const r = await publishFor("ws-off", run, { velg: candIds(run), [TICK]: "1" });
      assertTrue(r.status === 303 && (r.location ?? "").includes("produktimport_publisert"), "flag off: publish succeeds");
      assertEq([modeOf("ws-off"), syncAudits("ws-off").length], [null, 0], "flag off: server ignores the tick (no mode, no log row)");
      assertEq(names("ws-off"), ["Honning", "Lammelår"], "flag off: the products were published");
      const portal = html(await portalFor("ws-off"));
      assertTrue(portal.includes('data-product-import-card="1"') && !portal.includes("data-auto-sync-status"), "flag off: no auto-sync status on the card");
    }
    process.env.PRODUCT_AUTO_SYNC_ENABLED = "1";

    // ─── AC4a: ticked publish → weekly + log, in the publish ────────────────
    {
      const run = await fetchRun("ws-on");
      const page = html(await pageFor("ws-on", run));
      assertTrue(hasBox(page) && page.includes("Hold prisene oppdatert automatisk hver uke"), "AC4a: box shown (flag on, is_verified = 1)");
      assertTrue(page.includes(`data-weekly-sync-box="off"`) && !new RegExp(`name="${TICK}" value="1" checked`).test(page), "AC4a: box unticked by default");
      assertTrue(page.includes("får ny pris automatisk") && page.includes("godkjent") && page.includes("stopper oppdateringen"),
        "AC4a: the rules are explained under the box");
      assertTrue(page.indexOf("data-weekly-sync-box") < page.indexOf(">Publiser valgte<"), "AC4a: box sits above «Publiser valgte»");
      const r = await publishFor("ws-on", run, { velg: candIds(run), [TICK]: "1" });
      assertTrue(r.status === 303 && (r.location ?? "").includes("produktimport_publisert"), "AC4a: ticked publish succeeds");
      assertEq(modeOf("ws-on"), "weekly", "AC4a: ticked publish sets product_sync_mode 'weekly'");
      assertEq(syncAudits("ws-on"), [{ old_value: "off", new_value: "weekly", changed_by: "owner", changed_by_email: "post@ws-on.example.no" }],
        "AC4a: one change-log row (products.weekly_sync off → weekly, by the owner)");
      assertEq(names("ws-on"), ["Honning", "Lammelår"], "AC4a: the products were published too");
      const portal = html(await portalFor("ws-on"));
      assertTrue(portal.includes('data-auto-sync-status="waiting"') && portal.includes("oppdateres automatisk hver uke"),
        "status: card says the weekly update is on and the first comes within a week");
    }

    // ─── Unticked → unchanged ───────────────────────────────────────────────
    {
      const run = await fetchRun("ws-unt");
      const r = await publishFor("ws-unt", run, { velg: candIds(run) });
      assertTrue(r.status === 303, "unticked: publish succeeds");
      assertEq([modeOf("ws-unt"), syncAudits("ws-unt").length], [null, 0], "unticked: mode unchanged (no row), no log row");
    }

    // ─── Already weekly → the box is ticked; unticked publish keeps it ──────
    {
      const run = await fetchRun("ws-wk");
      const page = html(await pageFor("ws-wk", run));
      assertTrue(page.includes(`data-weekly-sync-box="weekly"`) && new RegExp(`name="${TICK}" value="1" checked`).test(page),
        "AC4a: box shows ticked when the mode already is 'weekly'");
      const r = await publishFor("ws-wk", run, { velg: candIds(run).slice(0, 1) });
      assertTrue(r.status === 303, "weekly: unticked publish succeeds");
      assertEq([modeOf("ws-wk"), syncAudits("ws-wk").length], ["weekly", 0], "weekly: unticked publish leaves 'weekly' as it is");
      const run2 = candIds(run).slice(1);
      const r2 = await publishFor("ws-wk", run, { velg: run2, [TICK]: "1" });
      assertTrue(r2.status === 303 && syncAudits("ws-wk").length === 0, "weekly: ticking again writes no extra log row");
    }

    // ─── Same transaction: a failing extra write rolls the publish back ─────
    {
      const run = await fetchRun("ws-tx");
      const before = names("ws-tx");
      const r = oi.publishOwnerImport("ws-tx", run, candIds(run).map((id) => ({ id })), [], {
        actorEmail: "post@ws-tx.example.no",
        inTransaction: () => {
          as.enableWeeklySyncFromImport("ws-tx", "post@ws-tx.example.no", run);
          throw new Error("boom");
        },
      });
      assertTrue(!r.ok && r.status === 500, "tx: a throwing extra write fails the publish");
      assertEq([names("ws-tx"), modeOf("ws-tx"), syncAudits("ws-tx").length], [before, null, 0],
        "tx: products, mode and log row all rolled back together");
    }

    // ─── Not verified: no box, the server never sets weekly ─────────────────
    {
      assertEq(as.importPageAutoSyncChoice("ws-unver"), null, "unverified: no box (importPageAutoSyncChoice null)");
      assertEq([as.enableWeeklySyncFromImport("ws-unver", null, "x"), modeOf("ws-unver"), syncAudits("ws-unver").length], [false, null, 0],
        "unverified: enableWeeklySyncFromImport writes nothing");
      assertEq(as.importPageAutoSyncChoice("ws-on", {}), null, "flag off (env): no box");
      assertEq(as.enableWeeklySyncFromImport("ws-unt", null, "x", {}), false, "flag off (env): server ignores the tick");
      assertEq(modeOf("ws-unt"), null, "flag off (env): mode still unchanged");
      const preview = oi.getOwnerImportPreview("ws-on", (db.prepare("SELECT id FROM product_import_runs WHERE agent_id = 'ws-on'").get() as any).id)!;
      assertTrue(!hasBox(importMod.renderImportPreviewPage("ws-on", preview, { claimant: true, autoSync: null })), "render: autoSync null → no box");
    }

    // ─── Status view: success / blocked / disabled ──────────────────────────
    {
      db.prepare(
        `UPDATE product_auto_sync_state SET last_run_at = '2026-11-02T03:15:00.000Z', last_success_at = '2026-11-02T03:16:00.000Z',
           last_change_summary = ? WHERE agent_id = 'ws-wk'`,
      ).run(JSON.stringify({ changed: [{ name: "Lammelår" }, { name: "Honning" }], not_found: ["Egg"], new_pending: 3 }));
      const v = as.autoSyncStatusView("ws-wk");
      assertEq(v, { kind: "success", at: "2026-11-02T03:16:00.000Z", changed: 2, not_found: 1, new_pending: 3 }, "status: last success + change summary");
      const s = portalMod.autoSyncStatusHtml(v);
      assertTrue(s.includes("Sist oppdatert automatisk 02.11.2026") && s.includes("2 varer fikk ny pris") && s.includes("3 nye varer venter på godkjenning"),
        "status: success text with date and changes");
      assertTrue(html(await portalFor("ws-wk")).includes('data-auto-sync-status="success"'), "status: portal card shows the last success");
      db.prepare(`UPDATE product_auto_sync_state SET consecutive_blocks = 1, last_block_reason = 'price_deviation: Honning 120 → 400 (+233 %)' WHERE agent_id = 'ws-wk'`).run();
      const b = portalMod.autoSyncStatusHtml(as.autoSyncStatusView("ws-wk"));
      assertTrue(b.includes('data-auto-sync-status="blocked"') && b.includes("ingenting ble endret") && b.includes("mer enn 50 %"),
        "status: lock reason in plain Norwegian");
      db.prepare(
        `UPDATE product_auto_sync_state SET product_sync_mode = 'off', consecutive_blocks = 3,
           disabled_reason = '3 låste kjøringer på rad; siste: fetch_failed: timeout', disabled_at = '2026-11-03T03:15:00.000Z' WHERE agent_id = 'ws-wk'`,
      ).run();
      const d = portalMod.autoSyncStatusHtml(as.autoSyncStatusView("ws-wk"));
      assertTrue(d.includes('data-auto-sync-status="disabled"') && d.includes("slått av") && d.includes("fikk ikke hentet"),
        "status: turned off with the reason");
      assertEq(as.autoSyncStatusView("ws-wk", {}), null, "status: flag off → nothing");
      assertEq(as.autoSyncStatusView("ws-unt"), null, "status: never on and never run → nothing");
      assertEq(portalMod.autoSyncStatusHtml(null), "", "status: null renders nothing");
    }

    // ─── Profile page: «Oppdatert automatisk fra <domene> <dato>» ───────────
    {
      const prod = (source: string) => [{
        name: "Lammelår", category: "meat", seasonal: false, price: "kr 289", priceUnit: "kr", source,
        sourceUrl: "https://www.gard-x.no/lam", fetchedAt: "2026-11-02T03:16:00.000Z", confirmedAt: "2026-10-01T10:00:00.000Z",
      }];
      const on = seo.productDateLineHtml(prod("owner_auto_sync"), "no");
      assertTrue(on.includes("Oppdatert automatisk fra gard-x.no 2. nov. 2026"), "profile: owner_auto_sync + flag on → «Oppdatert automatisk fra <domene> <dato>»");
      assertTrue(!seo.productDateLineHtml(prod("owner_import"), "no").includes("automatisk"), "profile: owner_import keeps «Priser hentet fra»");
      const offAuto = seo.productDateLineHtml(prod("owner_auto_sync"), "no", {});
      const offImport = seo.productDateLineHtml(prod("owner_import"), "no", {});
      assertTrue(offAuto === offImport && offAuto.includes("Priser hentet fra gard-x.no") && !offAuto.includes("automatisk"),
        "profile: flag off → the same line as before for owner_auto_sync");
      assertTrue(seo.productDateLineHtml(prod("owner_auto_sync"), "en").includes("Updated automatically from gard-x.no"), "profile: English text");
    }
  } catch (err) {
    failed++;
    failures.push(`unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { oi?.__setOwnerImportDepsForTesting(null); oi?.__forgetOwnerFetchJobsForTesting(); } catch { /* ignore */ }
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    db.close();
  }
  if (log) console.info(`\nowner-product-import-auto-sync: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerImportAutoSyncTests({ log: true }).then((r) => {
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
