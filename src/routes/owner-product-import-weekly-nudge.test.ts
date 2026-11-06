/**
 * owner-product-import-weekly-nudge.test.ts — dev-request 2026-10-21-rfb-
 * produktimport-fra-egen-nettside, Skive 4-2c: after «Publiser valgte» the
 * receipt points to the «Mine valg» row products.weekly_sync (only with
 * PRODUCT_AUTO_SYNC_ENABLED on, is_verified = 1, mode not 'weekly', published
 * >= 1; decided at render time from stored state), the owner's change log
 * names products.weekly_sync with its «Mine valg» label, and the auto-sync
 * status line escapes HTML.
 *
 * Real schema in an in-memory DB swapped in as the getDb() singleton; fake
 * fetch injected (no network). Env restored in finally.
 * Exported runOwnerImportWeeklyNudgeTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/owner-product-import-weekly-nudge.test.ts
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

export async function runOwnerImportWeeklyNudgeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const IDS = ["nu-on", "nu-wk", "nu-unver", "nu-off", "nu-zero", "nu-esc"];
    addAgent("nu-on", { verified: 1 });
    addAgent("nu-wk", { verified: 1, mode: "weekly" });
    addAgent("nu-unver", { verified: 0 });
    addAgent("nu-off", { verified: 1, mode: "off" });
    addAgent("nu-zero", { verified: 1 });
    addAgent("nu-esc", { verified: 1, mode: "weekly" });
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

    const lgMod = require("./owner-audit-log") as typeof import("./owner-audit-log");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const PUB = (n: number) => ({ publisert: String(n), fjernet: "0", avvist: "0" });
    const portalAlert = async (id: string, q: Record<string, string>) =>
      html(await invoke(H.portal, { params: { agentId: id }, token: tokens[id], query: { status: "produktimport_publisert", ...q } }));
    const hasNudge = (h: string) => h.includes('data-weekly-sync-nudge="1"');
    const stock = "STOCK";
    const BASE = "Vil du at vi holder prisene oppdatert hver uke? Slå det på i";

    process.env.PRODUCT_IMPORT_ENABLED = "1";

    // ─── Flag off: byte-identical receipt (pure + portal) ───────────────────
    {
      const offPure = portalMod.productImportPortalAlert("produktimport_publisert", PUB(2), stock, portalMod.weeklySyncNudgeHtml("nu-on"));
      const plain = portalMod.productImportPortalAlert("produktimport_publisert", PUB(2), stock);
      assertEq(offPure, plain, "flag off: receipt identical to the one without a nudge");
      assertEq(portalMod.weeklySyncNudgeHtml("nu-on"), "", "flag off: no nudge html");
      const p = await portalAlert("nu-on", PUB(2));
      assertTrue(p.includes("data-import-published=\"2\"") && !hasNudge(p) && !p.includes("Mine valg»</a>.</span>"), "flag off: portal receipt has no nudge");
    }
    process.env.PRODUCT_AUTO_SYNC_ENABLED = "1";

    // ─── Flag on + verified + mode off + published >= 1 → nudge ─────────────
    {
      const p = await portalAlert("nu-on", PUB(2));
      assertTrue(hasNudge(p), "nudge shown (flag on, verified, no row, published 2)");
      assertTrue(p.includes(BASE), "nudge text");
      assertTrue(p.includes(`<a href="/eier/nu-on/valg#valg-products.weekly_sync">«Mine valg»</a>`), "link goes to the weekly_sync row in Mine valg");
      assertEq("valg-" + "products.weekly_sync", "valg-" + (reg.getOwnerFeature("products.weekly_sync").key), "link anchor = row anchor contract (#valg-<key>)");
      assertTrue(p.indexOf("data-import-published") < p.indexOf("data-weekly-sync-nudge"), "nudge comes after the receipt text");
      assertTrue(hasNudge(await portalAlert("nu-off", PUB(1))), "nudge shown when mode is explicitly 'off'");
    }

    // ─── Not shown ──────────────────────────────────────────────────────────
    {
      assertTrue(!hasNudge(await portalAlert("nu-wk", PUB(2))), "no nudge when mode is weekly");
      assertTrue(!hasNudge(await portalAlert("nu-unver", PUB(2))), "no nudge when is_verified = 0");
      assertTrue(!hasNudge(await portalAlert("nu-zero", PUB(0))), "no nudge with 0 published");
      assertTrue(!hasNudge(await portalAlert("nu-zero", { publisert: "0", fjernet: "3", avvist: "0" })), "no nudge with 0 published and some removed");
      assertTrue(!hasNudge(await portalAlert("nu-on", { ...PUB(2), status: "produktimport_feil" })), "no nudge on other statuses");
      process.env.PRODUCT_AUTO_SYNC_ENABLED = "0";
      assertTrue(!hasNudge(await portalAlert("nu-on", PUB(2))), "no nudge with the flag off (0)");
      process.env.PRODUCT_AUTO_SYNC_ENABLED = "1";
    }

    // ─── Decided from stored state at render time, not a query parameter ────
    {
      const p = await portalAlert("nu-on", { ...PUB(1), uke: "1", weekly: "1", nudge: "0" });
      assertTrue(hasNudge(p), "extra query parameters do not change the decision");
      db.prepare(`INSERT INTO product_auto_sync_state (agent_id, product_sync_mode) VALUES ('nu-on', 'weekly')`).run();
      assertTrue(!hasNudge(await portalAlert("nu-on", PUB(1))), "stored state flips to weekly → nudge gone on the next render");
      db.prepare(`DELETE FROM product_auto_sync_state WHERE agent_id = 'nu-on'`).run();
    }

    // ─── Escaping ───────────────────────────────────────────────────────────
    {
      const n = portalMod.weeklySyncNudgeHtml("nu-on");
      assertTrue(!/<script/i.test(n), "nudge html has no raw script");
      const hostile = portalMod.weeklySyncNudgeHtml('x"><script>alert(1)</script>');
      assertTrue(hostile === "" || (!hostile.includes("<script>") && !hostile.includes('"><')), "hostile agent id is never injected raw");
      const hostile2 = portalMod.productImportPortalAlert("produktimport_publisert", PUB(1), stock, `<span data-weekly-sync-nudge="1">ok</span>`);
      assertTrue(!!hostile2 && hostile2.html.includes("ok</span>"), "nudge html is placed as given (built escaped by weeklySyncNudgeHtml)");
    }

    // ─── Audit log: products.weekly_sync with the «Mine valg» label ─────────
    {
      const f = lgMod.OWNER_AUDIT_FIELDS["products.weekly_sync"];
      assertEq(f?.label, reg.getOwnerFeature("products.weekly_sync").label.no, "audit: products.weekly_sync uses the «Mine valg» label");
      assertEq(
        [lgMod.formatOwnerAuditValue(f!.kind, "off"), lgMod.formatOwnerAuditValue(f!.kind, "weekly")],
        [lgMod.OWNER_AUDIT_NO, lgMod.OWNER_AUDIT_YES], "audit: off/weekly read as Nei/Ja");
      // The row 4-2a writes (publish with the box ticked) shows up in the owner's feed.
      const run = await fetchRun("nu-on");
      await publishFor("nu-on", run, { velg: candIds(run), [importMod.WEEKLY_SYNC_FIELD]: "1" });
      const feed = lgMod.ownerAuditFeedRows(
        (db.prepare("SELECT id, field_name, old_value, new_value, changed_by, changed_at, notes FROM agent_knowledge_audit WHERE agent_id = 'nu-on' AND field_name = 'products.weekly_sync'").all() as any[]));
      assertEq(feed.map((r) => [r.field_name, r.label, r.old_value, r.new_value, r.values_hidden]),
        [["products.weekly_sync", reg.getOwnerFeature("products.weekly_sync").label.no, "Nei", "Ja", false]], "audit: the 4-2a row is shown in the change log with the Mine valg label");
      // The 4-2b writer's row (Mine valg switch) uses the same field name.
      const sw = require("../owner-features/product-weekly-sync") as typeof import("../owner-features/product-weekly-sync");
      assertEq(sw.PRODUCT_WEEKLY_SYNC_KEY in lgMod.OWNER_AUDIT_FIELDS, true, "audit: 4-2b's field name is in the table");
    }

    // ─── Status line escapes HTML ───────────────────────────────────────────
    {
      db.prepare(
        `UPDATE product_auto_sync_state SET consecutive_blocks = 1, last_run_at = '2026-11-02T03:15:00.000Z',
           last_block_reason = 'too_many_missing: <script>alert(1)</script> & "x"' WHERE agent_id = 'nu-esc'`,
      ).run();
      const s = portalMod.autoSyncStatusHtml(as.autoSyncStatusView("nu-esc"));
      assertTrue(s.includes('data-auto-sync-status="blocked"') && !s.includes("<script>") && s.includes("&lt;script&gt;"), "status line: blocked reason is escaped");
      const portal = html(await invoke(H.portal, { params: { agentId: "nu-esc" }, token: tokens["nu-esc"] }));
      assertTrue(portal.includes("data-auto-sync-status") && !portal.includes("<script>alert(1)</script>") && portal.includes("&lt;script&gt;"), "status line: escaped on the portal card");
      db.prepare(
        `UPDATE product_auto_sync_state SET product_sync_mode = 'off', disabled_at = '2026-11-03T03:15:00.000Z',
           disabled_reason = '3 låste kjøringer på rad; siste: too_many_missing: <img src=x onerror=alert(1)>' WHERE agent_id = 'nu-esc'`,
      ).run();
      const d = portalMod.autoSyncStatusHtml(as.autoSyncStatusView("nu-esc"));
      assertTrue(d.includes('data-auto-sync-status="disabled"') && !d.includes("<img") && d.includes("&lt;img"), "status line: disabled reason is escaped");
      const run = await fetchRun("nu-esc");
      db.prepare(`UPDATE product_auto_sync_state SET product_sync_mode = 'weekly', consecutive_blocks = 1, disabled_reason = NULL WHERE agent_id = 'nu-esc'`).run();
      const page = html(await pageFor("nu-esc", run));
      assertTrue(page.includes("data-auto-sync-status") && !page.includes("<script>alert(1)</script>") && page.includes("&lt;script&gt;"), "status line: escaped on the import page");
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
  if (log) console.info(`\nowner-product-import-weekly-nudge: ${passed} passed, ${failed} failed`);
  return { passed, failed, failures };
}

if (require.main === module) {
  runOwnerImportWeeklyNudgeTests({ log: true }).then((r) => {
    for (const f of r.failures) console.info(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
