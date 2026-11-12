/**
 * product-weekly-sync.test.ts — dev-request 2026-10-21-rfb-produktimport-fra-
 * egen-nettside, Skive 4-2b: the «Mine valg» switch products.weekly_sync wired
 * to product_auto_sync_state.product_sync_mode (registry adapter, liveFlag
 * PRODUCT_AUTO_SYNC_ENABLED).
 *
 * Covers:
 *   flag off  the «Mine valg» page and GET /api/owner/:id/features are
 *             byte-identical to the pre-4-2b catalog row (coming_soon, the old
 *             text, no requirements); PUT / POST sett → 409 coming_soon, and
 *             nothing is written (no sync row, no audit row of either log).
 *   flag on   a verified owner (is_verified = 1) sees the switch with the
 *             current mode (weekly ⇒ «På», off / no row ⇒ «Av»), also in
 *             «Slik er du nå»; on → product_sync_mode 'weekly' + one
 *             agent_knowledge_audit row (products.weekly_sync off → weekly) +
 *             the owner_feature_audit row; off → 'off' + one audit row, every
 *             other sync-state column kept; turning on runs no sync (no run
 *             row, last_run_at unchanged); an auto-off by the job (mode off +
 *             disabled_reason) reads «Av»; the page POST writes the same.
 *   gates     is_verified = 0 → shown locked off with the reason, PUT on →
 *             409 requirement_not_met, nothing written; not the owner / an
 *             e-mail-match session → 403 as today; off the allowlist → 404.
 *
 * Real router + services on the production schema in an in-memory DB.
 * Exported runProductWeeklySyncSwitchTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/owner-features/product-weekly-sync.test.ts
 */

import Database from "better-sqlite3";

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

const KEY = "products.weekly_sync";
const FLAG = "PRODUCT_AUTO_SYNC_ENABLED";
const ALLOW_ENV = "OWNER_FEATURES_ALLOWED_SUBJECTS";
const SAVED_ENV = [FLAG, ALLOW_ENV, "OWNER_VERIFIED_OWNER_GATE_ENABLED", "OWNER_UNIFIED_SESSION_ENABLED", "OWNER_FEATURES_ENFORCE"];
const OWNED = "s42b-owned";
const UNBADGED = "s42b-unbadged";
const EMAILMATCH = "s42b-emailmatch";
const OTHER = "s42b-other";
const OLD_DESCRIPTION = { no: "Produktene sjekkes mot nettsiden din hver uke.", en: "Your products are checked against your website every week." };

export async function runProductWeeklySyncSwitchTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  }

  function findRouteHandler(router: any, p: string, method: "get" | "post" | "put"): Function {
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === p && l.route.methods?.[method]);
    if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${p}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  function makeReq(o: { params?: Record<string, string>; body?: any; query?: Record<string, string>; token?: string }): any {
    const headers: Record<string, string> = { host: "rettfrabonden.com" };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    return {
      method: "GET", url: "/", path: "/", originalUrl: "/",
      params: o.params || {}, body: o.body, query: o.query || {}, headers, cookies: {},
      ip: "127.0.0.1", lang: "no", protocol: "https", hostname: "rettfrabonden.com",
      get(name: string) { return headers[name.toLowerCase()]; },
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
        header() { return res; }, set() { return res; }, type() { return res; }, cookie() { return res; },
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route chatter */ };

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    for (const k of SAVED_ENV) delete process.env[k];
    for (const m of ["../routes/owner-portal", "../routes/owner-features"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }
    const featuresMod = require("../routes/owner-features") as typeof import("../routes/owner-features");
    const reg = require("./registry") as typeof import("./registry");
    const rs = require("./resolve") as typeof import("./resolve");
    const pws = require("./product-weekly-sync") as typeof import("./product-weekly-sync");
    const autoSync = require("../services/product-import/auto-sync") as typeof import("../services/product-import/auto-sync");

    const seed = (id: string, o: { claimed: boolean; isVerified: boolean }) => {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, origin, vertical_id, catalog_hidden, claimed_at)
         VALUES (?, ?, 'Testprodusent for ukentlig synk.', 'test', ?, ?, 'producer', ?, 59.9139, 10.7522, 'Oslo', '["vegetables"]', '[]', 0.7, 1, ?, 'discovery', 'rfb', 0, ?)`,
      ).run(id, `Synkbryter Gard ${id}`, `post@${id}.example.no`, `https://${id}.example.no`, `key-${id}`, o.isVerified ? 1 : 0,
        o.claimed ? "2026-10-01T00:00:00.000Z" : null);
      db.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, website, about, verification_status, verified_second_line)
         VALUES (?, ?, ?, 'Liten familiegård.', 'verified', 0)`,
      ).run(id, `post@${id}.example.no`, `https://${id}.example.no`);
      db.prepare("INSERT INTO magic_links (id, email, token, agent_id, used, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(`mlsess_${id}`, `post@${id}.example.no`, `tok-${id}`, id, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    };
    seed(OWNED, { claimed: true, isVerified: true });
    seed(UNBADGED, { claimed: true, isVerified: false });
    seed(EMAILMATCH, { claimed: false, isVerified: false });
    seed(OTHER, { claimed: true, isVerified: true });
    process.env[ALLOW_ENV] = [OWNED, UNBADGED, EMAILMATCH, OTHER].map((id) => `rfb:${id}`).join(",");

    const H = {
      api: findRouteHandler(featuresMod.default, "/api/owner/:id/features", "get"),
      put: findRouteHandler(featuresMod.default, "/api/owner/:id/features/:key", "put"),
      page: findRouteHandler(featuresMod.default, "/eier/:agentId/valg", "get"),
      sett: findRouteHandler(featuresMod.default, "/eier/:agentId/valg/sett", "post"),
    };
    const tok = (id: string) => `tok-${id}`;
    const put = (id: string, value: unknown, token = tok(id)) => {
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      return invoke(H.put, makeReq({ params: { id, key: KEY }, body: { value }, token }));
    };
    const sett = (id: string, value: string) => {
      featuresMod.__resetOwnerFeaturesRateLimitForTesting();
      return invoke(H.sett, makeReq({ params: { agentId: id }, body: { key: KEY, value, confirmed: "1" }, token: tok(id) }));
    };
    const pageHtml = async (id: string) => String((await invoke(H.page, makeReq({ params: { agentId: id }, token: tok(id) }))).body ?? "");
    const apiItem = async (id: string) => {
      const r = await invoke(H.api, makeReq({ params: { id }, token: tok(id) }));
      return (r.body?.features ?? []).find((f: any) => f.key === KEY);
    };
    const syncRow = (id: string) => db.prepare("SELECT * FROM product_auto_sync_state WHERE agent_id = ?").get(id) as any;
    const productAudits = (id: string) =>
      db.prepare("SELECT field_name, old_value, new_value, changed_by, changed_by_email FROM agent_knowledge_audit WHERE agent_id = ? AND field_name = ? ORDER BY changed_at, rowid").all(id, KEY) as any[];
    const featureAudits = (id: string) =>
      db.prepare("SELECT key, old_json, new_json, actor FROM owner_feature_audit WHERE subject_id = ? AND key = ? ORDER BY id").all(id, KEY) as any[];
    const settings = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM owner_feature_settings WHERE subject_id = ? AND key = ?").get(id, KEY) as any).n;
    const runRows = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM product_import_runs WHERE agent_id = ?").get(id) as any).n;
    const rowOf = (html: string) => {
      const m = new RegExp(`<li class="mv-item" id="[^"]*" data-key="${KEY.replace(".", "\\.")}">[\\s\\S]*?</li>`).exec(html);
      return m ? m[0] : "";
    };

    // ── Registry wiring ──────────────────────────────────────────────────
    const e = reg.getOwnerFeature(KEY);
    assertEq(pws.PRODUCT_WEEKLY_SYNC_FLAG, autoSync.PRODUCT_AUTO_SYNC_FLAG, "registry: liveFlag is the 4-1 job's flag (PRODUCT_AUTO_SYNC_ENABLED)");
    assertEq([e.status, e.liveFlag, e.storage?.column, e.requires, e.type, e.default],
      ["live", FLAG, "product_auto_sync_state.product_sync_mode", ["verifiedOwner", "isVerifiedBadge"], "switch", { owner: false, unclaimed: false }],
      "registry: live behind the flag, adapter on product_sync_mode, verified owner + is_verified = 1");

    // ── Flag off: byte-identical to the pre-4-2b catalog row ──────────────
    // The pre-4-2b entry, swapped into the registry in place (the route and
    // the page read the same array), is the reference rendering.
    const idx = reg.OWNER_FEATURE_REGISTRY.findIndex((x) => x.key === KEY);
    const legacy: any = { ...e, status: "coming_soon", requires: [], since: "2026-10-27", description: OLD_DESCRIPTION };
    for (const k of ["liveFlag", "whileFlagOff", "storage"]) delete legacy[k];
    const withLegacy = async <T>(fn: () => Promise<T>): Promise<T> => {
      reg.OWNER_FEATURE_REGISTRY[idx] = legacy;
      try { return await fn(); } finally { reg.OWNER_FEATURE_REGISTRY[idx] = e; }
    };
    for (const v of [undefined, "0", "false", "yes"]) {
      if (v === undefined) delete process.env[FLAG]; else process.env[FLAG] = v;
      const label = `flag off (${v ?? "unset"})`;
      const [htmlNow, htmlBefore] = [await pageHtml(OWNED), await withLegacy(() => pageHtml(OWNED))];
      assertTrue(htmlNow.length > 1000 && htmlNow === htmlBefore, `${label}: «Mine valg» page byte-identical to the pre-4-2b row`);
      const [apiNow, apiBefore] = [await apiItem(OWNED), await withLegacy(() => apiItem(OWNED))];
      assertEq(apiNow, apiBefore, `${label}: GET features item identical to the pre-4-2b row`);
      assertEq([apiNow?.status, apiNow?.value, apiNow?.changeable, apiNow?.requires, apiNow?.since, apiNow?.description],
        ["coming_soon", false, false, [], "2026-10-27", OLD_DESCRIPTION], `${label}: coming_soon, the old text, no requirements`);
      assertTrue(htmlNow.includes(`data-planned-key="${KEY}"`) && !htmlNow.includes(`data-key="${KEY}"`) && !htmlNow.includes(`data-status-key="${KEY}"`),
        `${label}: only in the «Planlagt» box — no switch row, not in «Slik er du nå»`);
      const r = await put(OWNED, true);
      const rBefore = await withLegacy(() => put(OWNED, true));
      assertEq([r.status, r.body], [rBefore.status, rBefore.body], `${label}: PUT answers exactly as before`);
      assertEq([r.status, r.body?.error], [409, "coming_soon"], `${label}: PUT on → 409 coming_soon`);
      const s = await sett(OWNED, "true");
      const sBefore = await withLegacy(() => sett(OWNED, "true"));
      assertEq([s.status, s.body?.__redirect], [sBefore.status, sBefore.body?.__redirect], `${label}: page POST answers exactly as before (303, same message)`);
      assertEq([syncRow(OWNED) ?? null, productAudits(OWNED).length, featureAudits(OWNED).length, settings(OWNED)], [null, 0, 0, 0],
        `${label}: nothing written (no sync row, no audit row, no setting)`);
    }
    // A mode set by the import page's box (4a) does not show while the flag is off.
    db.prepare(`INSERT INTO product_auto_sync_state (agent_id, product_sync_mode) VALUES (?, 'weekly')`).run(OTHER);
    delete process.env[FLAG];
    assertEq([(await apiItem(OTHER))?.value, (await apiItem(OTHER))?.status], [false, "coming_soon"], "flag off: a stored 'weekly' is not shown (coming_soon, default value)");
    db.prepare(`DELETE FROM product_auto_sync_state WHERE agent_id = ?`).run(OTHER);

    // ── Flag on: shown with the current value ─────────────────────────────
    for (const v of ["1", "true"]) {
      process.env[FLAG] = v;
      const it = await apiItem(OWNED);
      assertEq([it?.status, it?.value, it?.source, it?.changeable, it?.requires], ["live", false, "default", true, ["verifiedOwner", "isVerifiedBadge"]],
        `flag on (${v}): verified owner, no sync row → live switch, off, changeable`);
    }
    process.env[FLAG] = "1";
    {
      const html = await pageHtml(OWNED);
      const row = rowOf(html);
      assertTrue(!!row && !html.includes(`data-planned-key="${KEY}"`), "flag on: a switch row in «Produkter og priser», not in «Planlagt»");
      assertTrue(row.includes("Vi sjekker nettsiden din hver uke."), "flag on: the row explains the weekly rules");
      assertTrue(/name="value"/.test(row) && row.includes(`value="${KEY}"`), "flag on: the row carries the switch form for the key");
      assertTrue(html.includes(`data-status-key="${KEY}"`) && /data-status-key="products\.weekly_sync"><span>[^<]*<\/span> <strong>Av<\/strong>/.test(html),
        "flag on: «Slik er du nå» shows it as «Av»");
    }
    // A stored 'weekly' (e.g. set by the import page's box) reads «På».
    db.prepare(`INSERT INTO product_auto_sync_state (agent_id, product_sync_mode) VALUES (?, 'weekly')`).run(OTHER);
    assertEq([(await apiItem(OTHER))?.value, (await apiItem(OTHER))?.source], [true, "owner"], "flag on: product_sync_mode 'weekly' → switch on");
    assertTrue(/data-status-key="products\.weekly_sync"><span>[^<]*<\/span> <strong>På<\/strong>/.test(await pageHtml(OTHER)), "flag on: «Slik er du nå» shows «På» for 'weekly'");

    // ── Toggle on: weekly + one product audit row, no sync run ─────────────
    {
      const r = await put(OWNED, true);
      assertEq([r.status, r.body?.changed, r.body?.feature?.value], [200, true, true], "on: PUT true → 200, changed, value true");
      const row = syncRow(OWNED);
      assertEq([row?.product_sync_mode, row?.last_run_at ?? null, runRows(OWNED)], ["weekly", null, 0], "on: product_sync_mode 'weekly'; no sync is run now (no run, last_run_at null)");
      assertEq(productAudits(OWNED), [{ field_name: KEY, old_value: "off", new_value: "weekly", changed_by: "owner", changed_by_email: `post@${OWNED}.example.no` }],
        "on: exactly one agent_knowledge_audit row products.weekly_sync off → weekly (owner, session e-mail)");
      assertEq(featureAudits(OWNED).map((a) => [a.old_json, a.new_json, a.actor]), [["false", "true", "owner"]], "on: one «Mine valg» change-log row (owner_feature_audit)");
      assertEq(settings(OWNED), 0, "on: nothing in owner_feature_settings (the column is the truth)");
      assertTrue(autoSync.dueAutoSyncProfiles(Date.now(), 10_000).includes(OWNED), "on: the weekly job picks the profile up");
      const again = await put(OWNED, true);
      assertEq([again.status, again.body?.changed, productAudits(OWNED).length, featureAudits(OWNED).length], [200, false, 1, 1], "on again: no-op, nothing logged");
    }

    // ── Toggle off: 'off' + audit row, the sync state is kept ──────────────
    {
      db.prepare(
        `UPDATE product_auto_sync_state SET consecutive_blocks = 2, last_run_at = '2026-11-01 03:00:00', last_run_id = 'run-x',
           last_success_at = '2026-10-25 03:00:00', last_change_summary = '{"changed":[]}', last_block_reason = 'price_deviation: x'
         WHERE agent_id = ?`,
      ).run(OWNED);
      const keep = (r: any) => [r.consecutive_blocks, r.last_run_at, r.last_run_id, r.last_success_at, r.last_change_summary, r.last_block_reason];
      const before = keep(syncRow(OWNED));
      const r = await put(OWNED, false);
      assertEq([r.status, r.body?.changed, r.body?.feature?.value], [200, true, false], "off: PUT false → 200, changed, value false");
      assertEq([syncRow(OWNED)?.product_sync_mode, keep(syncRow(OWNED))], ["off", before], "off: product_sync_mode 'off', every other sync-state column kept");
      assertEq(productAudits(OWNED).map((a) => [a.old_value, a.new_value]), [["off", "weekly"], ["weekly", "off"]], "off: one more audit row weekly → off");
      assertTrue(!autoSync.dueAutoSyncProfiles(Date.now(), 10_000).includes(OWNED), "off: the weekly job skips the profile");
    }

    // ── Page POST writes the same field and log ───────────────────────────
    {
      const s = await sett(OWNED, "true");
      assertEq([s.status, syncRow(OWNED)?.product_sync_mode, productAudits(OWNED).length], [303, "weekly", 3], "page POST on → 303, 'weekly', one more audit row");
      assertTrue(/data-status-key="products\.weekly_sync"><span>[^<]*<\/span> <strong>På<\/strong>/.test(await pageHtml(OWNED)), "page: «Slik er du nå» now «På»");
    }

    // ── Auto-off by the job (3 locks in a row) reads off ───────────────────
    {
      db.prepare(`UPDATE product_auto_sync_state SET product_sync_mode = 'off', disabled_reason = '3 låste kjøringer på rad; siste: fetch_failed', disabled_at = '2026-11-05 03:00:00' WHERE agent_id = ?`).run(OWNED);
      const it = await apiItem(OWNED);
      assertEq([it?.value, it?.changeable], [false, true], "auto-off: the switch shows off and can be turned on again");
      const r = await put(OWNED, true);
      const row = syncRow(OWNED);
      assertEq([r.status, row?.product_sync_mode, row?.consecutive_blocks, row?.disabled_reason], [200, "weekly", 0, null],
        "auto-off → on: 'weekly' with the lock count and the auto-off reason reset (as setProductSyncMode)");
    }

    // ── Gates ──────────────────────────────────────────────────────────────
    {
      const it = await apiItem(UNBADGED);
      assertEq([it?.status, it?.value, it?.changeable, it?.reason?.no], ["live", false, false, "Krever at profilen er verifisert av Rett fra Bonden. Bekreft eierskap først."],
        "is_verified = 0: not changeable, off, with the reason");
      const row = rowOf(await pageHtml(UNBADGED));
      assertTrue(!!row && !/name="value"/.test(row), "is_verified = 0: the row has no switch form");
      const r = await put(UNBADGED, true);
      assertEq([r.status, r.body?.error], [409, "requirement_not_met"], "is_verified = 0: PUT on → 409 requirement_not_met");
      assertEq([syncRow(UNBADGED) ?? null, productAudits(UNBADGED).length, featureAudits(UNBADGED).length], [null, 0, 0], "is_verified = 0: nothing written");
      const em = await put(EMAILMATCH, true);
      assertEq([em.status, em.body?.error], [403, "ownership_not_verified"], "e-mail-match session (not a verified owner) → 403 as today");
      const other = await put(OWNED, false, tok(OTHER));
      assertEq([other.status, other.body?.error], [403, "forbidden"], "another owner's session → 403 forbidden");
      assertEq(syncRow(OWNED)?.product_sync_mode, "weekly", "denied writes change nothing");
      process.env[ALLOW_ENV] = `rfb:${OTHER}`;
      const off = await put(OWNED, false);
      assertEq(off.status, 404, "not on the owner-features allowlist → 404 as today");
      process.env[ALLOW_ENV] = [OWNED, UNBADGED, EMAILMATCH, OTHER].map((id) => `rfb:${id}`).join(",");
    }

    // ── Adapter edge: no such profile ──────────────────────────────────────
    assertEq([pws.readProductWeeklySync(db, "nope"), pws.writeProductWeeklySync(db, "nope", true, { actor: "owner" })], [null, false],
      "adapter: unknown profile → read null, write false (nothing written)");
    assertEq(rs.resolveOwnerFeature("rfb", OWNED, KEY as any, { db }).value, true, "resolver reads the column");
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runProductWeeklySyncSwitchTests({ log: true }).then((r) => {
    console.info(`\nproduct-weekly-sync-switch: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
