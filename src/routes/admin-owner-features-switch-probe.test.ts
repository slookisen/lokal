/**
 * admin-owner-features-switch-probe.test.ts — dev-request
 * 2026-10-22-rfb-mine-valg-eierbrytere, slice S2d-3: the switch probe
 * («bryterprobe»), POST /admin/owner-features/switch-probe.
 *
 *   gate      flag off → 404; no / wrong admin key → 403
 *   target    a real producer, an unknown id, a fixture outside the allowlist
 *             → refused, zero writes
 *   dry run   the default: the plan, zero DB writes (total_changes, audit,
 *             settings counted before/after)
 *   run       on the fixture: every row and check PASS, every live key ×
 *             surface covered, the change log written (actor_detail
 *             switch-probe), the fixture's stored choices byte-identical to
 *             the snapshot afterwards, no mail sent (mailer + order-notify
 *             transport spied), the Markdown report with the findings block
 *   flags     OWNER_LOCK_ENFORCE_WRITES / OUTREACH_UNSUBSCRIBE_ENABLED off →
 *             those rows FAIL «flag off in this environment», values reported
 *   observable  the leaderboard reader asks for every row (the fixture outside
 *             the default top 10 still PASSes both ways); a surface that
 *             cannot see the fixture in the visible starting state (no
 *             agent_metrics row, no in-stock product, an injected blind
 *             reader) → NOT_OBSERVABLE both ways with a reason, not ready,
 *             reported apart (PASS / FAIL / IKKE OBSERVERBAR); P1 finding on a
 *             single-object surface, P2 on a list surface; the feed reader
 *             pages past 500 newer items in the fixture's city, the CSV match
 *             ignores a producer whose slug starts with the fixture's, the CSV
 *             alone keeps acp_feed observable; a reader that throws at the
 *             baseline re-check → FAIL «leser feilet»
 *   failure   an effect reader that throws → that row FAIL, still restored;
 *             a throw mid-run (after a flip) → ok:false, still restored
 *   busy      a second concurrent run → 409 already_running
 *
 * Real router + services on the production schema in an in-memory DB.
 * Exported runAdminOwnerFeaturesSwitchProbeTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/routes/admin-owner-features-switch-probe.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const SAVED_ENV = [
  "OWNER_FEATURES_SWITCH_PROBE_ENABLED", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "OWNER_FEATURES_ALLOWED_SUBJECTS",
  "OWNER_FEATURES_ENFORCE", "OWNER_PAUSE_ENABLED", "OWNER_VISIBILITY_ENFORCE_BY_ID", "OWNER_LOCK_ENFORCE_WRITES",
  "OUTREACH_UNSUBSCRIBE_ENABLED", "STOCK_CHECK_EMAIL_ENABLED", "OWNER_ORDERABILITY_PORTAL_ENABLED", "OWNER_ORDER_EMAIL_ENABLED", "RFB_DISABLE_ORDER_FOLLOWUPS", "UNSUBSCRIBE_TOKEN_SECRET",
  "OWNER_AUTO_UPDATES_ENABLED",
];
const KEY = "switch-probe-admin-key-for-tests";
const FIX = "sp-fixture";
const REAL = "sp-real-producer";
const FIX_NAME = "Bryterprobe Gard Fixtur";
const FIX_EMAIL = "eier@sp-fixture.example.no";
const i2s = (id: string) => id.replace(/\D+/g, "");

export async function runAdminOwnerFeaturesSwitchProbeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)?.slice(0, 600)}\n    actual:   ${JSON.stringify(actual)?.slice(0, 600)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  };
  const assertTrue = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.info(`  ✗ ${label}`); }
  };

  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const initMod = require("../database/init") as typeof import("../database/init");
  const prevDb = initMod.__peekDbForTesting();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV) prevEnv[k] = process.env[k];

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = OFF");
  const prevLog = console.log;
  const prevErr = console.error;
  if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; }

  let notifySvc: typeof import("../services/order-notify-service") | null = null;
  let es: any = null;
  let prevSendEmail: any = null;

  try {
    initMod.__setDbForTesting(db as any);
    initMod.__initSchemaForTesting(db as any);
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded by another suite */ }
    for (const k of SAVED_ENV) delete process.env[k];
    for (const m of ["../routes/marketplace", "../routes/marketplace-catalog", "../routes/seo", "../routes/mcp", "../routes/a2a", "../routes/discovery"]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
    }

    // Mail spies: nothing in the probe may reach a mail transport.
    let mailCalls = 0;
    notifySvc = require("../services/order-notify-service") as typeof import("../services/order-notify-service");
    notifySvc.__setOrderNotifyTestDb(db as any);
    notifySvc.__setOrderNotifySendForTesting(async () => { mailCalls++; return { success: true, messageId: "spy" }; });
    es = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
    prevSendEmail = es.sendEmail;
    es.sendEmail = async () => { mailCalls++; return { success: true, messageId: "spy" }; };
    const cartSvc = require("../services/cart-service") as typeof import("../services/cart-service");
    cartSvc.__setCartTestDb(db as any);

    // ── Fixtures ─────────────────────────────────────────────────────────
    const seed = (id: string, name: string, o: { origin: string; hidden: 0 | 1; email: string }) => {
      db.prepare(
        `INSERT INTO agents
           (id, name, description, provider, contact_email, url, role, api_key, lat, lng, city,
            categories, tags, trust_score, is_active, is_verified, is_vetted, origin, vertical_id, catalog_hidden, claimed_at,
            order_notifications_opt_in, created_at)
         VALUES (?, ?, ?, 'test', ?, ?, 'producer', ?, 62.4722, 6.1495, 'Ålesund', '["vegetables"]', '[]', 0.7, 1, 1, 1, ?, 'rfb', ?, '2026-10-01T00:00:00.000Z', 1, '2026-10-01T00:00:00.000Z')`,
      ).run(id, name, "Lokal produsent av poteter og grønnsaker, med gårdsutsalg hver lørdag.", o.email, `https://${id}.example.no`, `key-${id}`, o.origin, o.hidden);
      db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, email, website, phone, address, postal_code, about, products, verification_status, verified_second_line,
            enrichment_status, url_last_status, url_last_probed, last_verified_at)
         VALUES (?, ?, ?, '+47 912 34 567', 'Gardsvegen 12', '6002', ?, ?, 'verified', 0, 'rich', 200, datetime('now'), '2026-01-01T00:00:00.000Z')`,
      ).run(id, o.email, `https://${id}.example.no`,
        "Vi er en liten familiegård som dyrker poteter, gulrøtter og kål, og selger direkte fra gården hele året.",
        JSON.stringify([{ name: "Probepoteter", price: "30 kr/kg", category: "vegetables" }]));
      db.prepare(
        `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url, availability_source, availability_updated_at)
         VALUES (?, ?, 'Probepoteter', 'probepoteter', 'kg', 30, 'in_stock', 'vegetables', 'https://img.example.no/p.jpg', 'admin_producer_confirmed', ?)`,
      ).run(`prod-${id}`, id, new Date().toISOString());
      db.prepare(`INSERT OR REPLACE INTO agent_metrics (agent_id, times_discovered, times_contacted, times_chosen) VALUES (?, 10, 5, 3)`).run(id);
    };
    seed(FIX, FIX_NAME, { origin: "test_fixture", hidden: 1, email: FIX_EMAIL });
    seed(REAL, "Bryterprobe Ekte Gard", { origin: "discovery", hidden: 0, email: "post@sp-real.example.no" });
    // Starting state with explicit choices, so the restore has something to put back.
    db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', ?, 'comms.news', 'true', 'owner', 0, '2026-10-20T10:00:00.000Z')`).run(FIX);
    db.prepare(`INSERT INTO owner_feature_intro (vertical, subject_id, answer, answered_at, actor_detail) VALUES ('rfb', ?, 'yes', '2026-10-20T10:00:00.000Z', ?)`).run(FIX, FIX_EMAIL);
    // A real owner's stored state next to the fixture: the probe must never touch it.
    for (const [k, v] of [["comms.news", "false"], ["visibility.english", "false"]]) {
      db.prepare(`INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at) VALUES ('rfb', ?, ?, ?, 'owner', 0, '2026-10-19T09:00:00.000Z')`).run(REAL, k, v);
    }
    db.prepare(`INSERT INTO owner_profile_pause (agent_id, paused_at, pause_until, set_by) VALUES (?, '2026-10-19T09:00:00.000Z', '2099-01-01', 'owner')`).run(REAL);
    db.prepare(`INSERT INTO owner_feature_level_choice (vertical, subject_id, level, chosen_at, actor_detail, batch_id) VALUES ('rfb', ?, 'bare_synlig', '2026-10-19T09:00:00.000Z', 'post@sp-real.example.no', NULL)`).run(REAL);
    db.prepare(`INSERT INTO owner_feature_intro (vertical, subject_id, answer, answered_at, actor_detail) VALUES ('rfb', ?, 'no', '2026-10-19T09:00:00.000Z', 'post@sp-real.example.no')`).run(REAL);
    db.prepare(`UPDATE agent_knowledge SET curated_fields = ? WHERE agent_id = ?`).run(JSON.stringify({ about: { by: "owner", locked_at: "2026-10-19T09:00:00.000Z" } }), REAL);

    const setBaseEnv = () => {
      for (const k of SAVED_ENV) delete process.env[k];
      process.env.OWNER_FEATURES_SWITCH_PROBE_ENABLED = "1";
      process.env.ADMIN_KEY = KEY;
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${FIX},rfb:${REAL}`;
      process.env.OWNER_FEATURES_ENFORCE = "1";
      process.env.OWNER_LOCK_ENFORCE_WRITES = "1";
      process.env.OUTREACH_UNSUBSCRIBE_ENABLED = "1";
      process.env.STOCK_CHECK_EMAIL_ENABLED = "1";
      process.env.OWNER_ORDERABILITY_PORTAL_ENABLED = "1";
      // dev-request 2026-11-01-rfb-hold-profilen-oppdatert: auto.updates (liveFlag) and the owner refresh.
      process.env.OWNER_AUTO_UPDATES_ENABLED = "1";
    };
    setBaseEnv();

    const routeMod = require("./admin-owner-features-switch-probe") as typeof import("./admin-owner-features-switch-probe");
    const probe = require("../owner-features/switch-probe") as typeof import("../owner-features/switch-probe");
    const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
    const router = routeMod.default as any;
    const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === "/" && l.route.methods?.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as Function;
    const call = (body: any, key: string | null = KEY): Promise<{ status: number; body: any }> =>
      new Promise((resolve) => {
        let status = 200;
        const res: any = {
          status(c: number) { status = c; return res; },
          json(p: any) { resolve({ status, body: p }); return res; },
          send(p: any) { resolve({ status, body: p }); return res; },
          setHeader() { return res; },
        };
        const headers: Record<string, string> = key === null ? {} : { "x-admin-key": key };
        Promise.resolve(handler({ method: "POST", url: "/", path: "/", body, query: {}, headers, get: (n: string) => headers[n.toLowerCase()] }, res, () => resolve({ status: 599, body: null })))
          .catch((e: any) => resolve({ status: 598, body: String(e) }));
      });

    const vis0 = (b: any) => (b.rows ?? []).filter((x: any) => x.key === "visibility.profile");
    const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
    const totalChanges = () => count("SELECT total_changes() AS n");
    const auditRows = () => count("SELECT COUNT(*) AS n FROM owner_feature_audit");
    const settingsRows = () => count("SELECT COUNT(*) AS n FROM owner_feature_settings");
    const rawState = (id: string) => JSON.stringify({
      settings: db.prepare("SELECT * FROM owner_feature_settings WHERE subject_id = ? ORDER BY key").all(id),
      agent: db.prepare("SELECT order_notifications_opt_in, order_notification_email, is_verified, claimed_at, is_active, catalog_hidden, origin FROM agents WHERE id = ?").get(id),
      pause: db.prepare("SELECT * FROM owner_profile_pause WHERE agent_id = ?").all(id),
      level: db.prepare("SELECT * FROM owner_feature_level_choice WHERE subject_id = ?").all(id),
      intro: db.prepare("SELECT * FROM owner_feature_intro WHERE subject_id = ?").all(id),
      knowledge: db.prepare("SELECT about, curated_fields, email FROM agent_knowledge WHERE agent_id = ?").get(id),
    });

    const realBefore = rawState(REAL);
    const realUntouched = (label: string) => assertEq(rawState(REAL), realBefore, `${label}: the real owner's stored state (settings, pause, level, intro, curated_fields) byte-identical`);
    const tableCounts = (): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>) {
        try { out[t.name] = count(`SELECT COUNT(*) AS n FROM "${t.name}"`); } catch { /* virtual table */ }
      }
      return out;
    };
    const grown = (a: Record<string, number>, b: Record<string, number>) =>
      Object.keys(b).filter((k) => b[k] !== a[k]).map((k) => `${k}: ${a[k]} → ${b[k]}`);

    // ═══ Gate ═════════════════════════════════════════════════════════════
    delete process.env.OWNER_FEATURES_SWITCH_PROBE_ENABLED;
    {
      const r = await call({ dry_run: false });
      assertEq([r.status, r.body?.error], [404, "not_found"], "gate-1: flag unset → 404");
      process.env.OWNER_FEATURES_SWITCH_PROBE_ENABLED = "true";
      assertEq((await call({})).status, 404, "gate-2: only the exact value \"1\" turns it on");
      process.env.OWNER_FEATURES_SWITCH_PROBE_ENABLED = "1";
    }
    {
      const c0 = totalChanges();
      assertEq((await call({ dry_run: false }, null)).status, 403, "gate-3: no X-Admin-Key → 403");
      assertEq((await call({ dry_run: false }, KEY + "-wrong")).status, 403, "gate-4: wrong X-Admin-Key → 403");
      assertEq(totalChanges(), c0, "gate-5: refused calls write nothing");
      assertEq((await call({ dry_run: "no" })).status, 400, "gate-6: dry_run must be a boolean");
    }

    // ═══ Target ═══════════════════════════════════════════════════════════
    {
      const c0 = totalChanges();
      const a0 = auditRows();
      const r = await call({ dry_run: false, agent_id: REAL });
      assertEq([r.status, r.body?.error], [409, "not_a_test_fixture"], "target-1: a real (allowlisted) producer → 409 not_a_test_fixture");
      assertEq((await call({ dry_run: false, agent_id: "sp-nobody" })).status, 404, "target-2: unknown agent_id → 404");
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${REAL}`;
      const r3 = await call({ dry_run: false });
      assertEq([r3.status, r3.body?.error], [409, "not_allowlisted"], "target-3: the fixture outside the allowlist → 409 not_allowlisted");
      process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `rfb:${FIX},rfb:${REAL}`;
      assertEq([totalChanges() - c0, auditRows() - a0], [0, 0], "target-4: refused targets → zero writes");
    }

    // ═══ Dry run (default) ════════════════════════════════════════════════
    {
      const before = rawState(FIX);
      const c0 = totalChanges();
      const a0 = auditRows();
      const s0 = settingsRows();
      const r = await call({});
      assertEq([r.status, r.body?.dry_run, r.body?.agent_id], [200, true, FIX], "dry-1: no body → dry run on the single fixture");
      assertTrue(Array.isArray(r.body?.plan?.rows) && r.body.plan.rows.length > 0, "dry-2: the plan lists key × surface × direction rows");
      assertTrue((r.body?.plan?.rows ?? []).every((x: any) => x.reader === true), "dry-3: every planned row has an effect reader");
      assertTrue((r.body?.plan?.baseline ?? []).some((b: any) => b.key === "orders.enabled" && b.value === true), "dry-4: baseline values (orders.enabled on)");
      assertTrue(Array.isArray(r.body?.rows) && r.body.rows.length === 0 && r.body?.pass === 0, "dry-5: no rows run");
      assertEq([totalChanges() - c0, auditRows() - a0, settingsRows() - s0], [0, 0, 0], "dry-6: zero DB writes (total_changes, audit, settings)");
      assertEq(rawState(FIX), before, "dry-7: fixture state byte-identical");
      assertTrue(typeof r.body?.markdown === "string" && r.body.markdown.includes("tørrkjøring"), "dry-8: the plan as Markdown");
      const r2 = await call({ dry_run: true, agent_id: FIX });
      assertEq([r2.status, r2.body?.dry_run, totalChanges() - c0], [200, true, 0], "dry-9: explicit dry_run:true is a dry run too");
    }

    // ═══ Full run ═════════════════════════════════════════════════════════
    {
      const before = rawState(FIX);
      const a0 = auditRows();
      const m0 = mailCalls;
      const t0 = tableCounts();
      const r = await call({ dry_run: false, max_wait_ms: 500 });
      const b = r.body ?? {};
      assertEq([r.status, b.ok, b.dry_run, b.agent_id], [200, true, false, FIX], "run-1: 200 ok on the fixture");
      const failing = [...(b.rows ?? []), ...(b.checks ?? [])].filter((x: any) => x.result !== "PASS");
      assertEq(failing.map((x: any) => `${x.key ?? x.check} ${x.surface ?? ""} ${x.direction ?? ""}: ${x.reason ?? ""} | ${x.observed ?? ""}`), [], "run-2: every row and check PASS");
      assertEq([b.fail, b.restored, b.ready_for_daniel_test], [0, true, true], "run-3: fail 0, restored, ready_for_daniel_test");
      assertTrue(b.pass === (b.rows?.length ?? 0) + (b.checks?.length ?? 0), "run-4: pass counts rows + checks");
      // Coverage: every live key × declared surface has rows in both directions
      // (a choice: one row per offered option).
      const live = reg.OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live");
      for (const e of live) {
        for (const s of e.surfaces) {
          const dirs = (b.rows ?? []).filter((x: any) => x.key === e.key && x.surface === s).map((x: any) => x.direction).sort();
          if (e.type === "choice") {
            const want = reg.visibleOwnerFeatureOptions(e).map((o) => `value:${o.value}`).sort();
            assertEq(dirs, want, `run-5: ${e.key} × ${s} probed with every offered option`);
          } else {
            assertTrue(dirs.includes("off") && dirs.includes("on"), `run-5: ${e.key} × ${s} probed off and on (${dirs.join(",")})`);
          }
        }
      }
      // auto.updates × job:rfb_enrichment_nightly: away from fill_empty and back, each through the write path.
      const au = (b.rows ?? []).filter((x: any) => x.key === "auto.updates");
      assertEq(au.map((x: any) => [x.direction, x.result, x.write_status, x.change_logged, x.discriminating]), [
        ["value:automatic", "PASS", 200, true, true], ["value:never", "PASS", 200, true, true], ["value:fill_empty", "PASS", 200, true, true],
      ], "run-5b: auto.updates — automatic, never, then back to fill_empty: each written (200, logged) and the owner refresh follows it");
      assertTrue((b.rows ?? []).filter((x: any) => x.key === "visibility.profile").length === 24, "run-6: visibility.profile: 12 surfaces × 2 directions");
      assertTrue((b.rows ?? []).filter((x: any) => x.direction === "parent_off" || x.direction === "parent_on").length === 6, "run-7: the locked keys follow orders.enabled off and on (3 surfaces × 2)");
      const vis = (b.rows ?? []).filter((x: any) => x.key === "visibility.profile");
      assertTrue(vis.every((x: any) => typeof x.ms_to_effect === "number" && x.change_logged === true && x.write_status === 200), "run-8: switch rows carry time to effect, 200 and the change-log hit");
      const refusedRows = (b.rows ?? []).filter((x: any) => ["orders.reminder", "notify.order_email"].includes(x.key) && x.direction === "off");
      assertTrue(refusedRows.length === 3 && refusedRows.every((x: any) => x.write_status === 409 && /locked/.test(x.observed)), "run-9: locked choices cannot be turned off (409 locked)");
      const guarantee = (b.rows ?? []).filter((x: any) => x.key === "auto.guarantee" || x.key === "comms.unsubscribe");
      assertTrue(guarantee.length === 6 && guarantee.every((x: any) => x.write_status === 409), "run-10: guarantees refuse every write (409)");
      const email = (b.rows ?? []).filter((x: any) => x.key === "orders.email");
      assertTrue(email.length === 2 && email.every((x: any) => x.write_status === 409 && /confirm_by_email/.test(x.observed)), "run-11: orders.email refuses a direct write (409 confirm_by_email)");
      const checks: any[] = b.checks ?? [];
      const comingSoon = reg.OWNER_FEATURE_REGISTRY.filter((e) => e.status === "coming_soon").map((e) => `coming_soon:${e.key}`);
      assertEq(comingSoon.filter((n) => !checks.some((c) => c.check === n && c.result === "PASS" && /→ 409 coming_soon/.test(c.observed))), [], "run-12: every coming_soon key → 409 coming_soon, no effect");
      assertTrue(checks.some((c) => c.check === "requirement_unmet:orders.enabled" && c.result === "PASS" && /409 requirement_not_met/.test(c.observed)), "run-13: unmet requirement → 409, no effect");
      assertTrue(checks.some((c) => c.check === "level:bare_synlig" && c.result === "PASS") && checks.some((c) => c.check === "level:ta_imot_bestillinger" && c.result === "PASS"), "run-14: both levels = the single switches");
      assertTrue(checks.some((c) => c.check === "undo:level:bare_synlig" && c.result === "PASS"), "run-15: «Angre» on a level restores the effect");
      assertTrue(["orders.enabled", "visibility.profile", "comms.news"].every((k) => checks.some((c) => c.check === `undo:single:${k}` && c.result === "PASS")), "run-16: «Angre» on each live switch restores the effect");
      assertTrue(checks.some((c) => c.check === "no_surface:comms.news" && c.result === "PASS"), "run-17: comms.news (no surface): write + change log");
      assertTrue(checks.some((c) => c.check === "restore" && c.result === "PASS"), "run-18: restore check PASS");
      // S2f: «Bryterproben dekker terskelen med «vis som offentlig»» — the fixture has 0 views:
      // threshold 0 → tiles, threshold 1 → none, the environment's 20 → none.
      const thr = checks.find((c) => c.check === "public_stats_threshold");
      assertTrue(!!thr && thr.result === "PASS" && /terskel 0: fliser vises \(forventet vises\)/.test(thr.observed)
        && /terskel 1: fliser vises ikke \(forventet vises ikke\)/.test(thr.observed) && /PUBLIC_STATS_MIN_VIEWS=20: fliser vises ikke/.test(thr.observed),
        `run-18b: the probe covers the public-stats threshold as-public, both sides (${thr?.observed ?? "missing"})`);
      assertEq(rawState(FIX), before, "run-19: the fixture's stored choices byte-identical to the snapshot afterwards");
      realUntouched("run-19b");
      assertEq(grown(t0, tableCounts()).filter((x) => !/^owner_feature_(audit|change_batch):/.test(x)), [], "run-19c: no table grows except the change log (the readers' own rows are removed)");
      const se: any[] = b.side_effects ?? [];
      assertTrue(se.some((x) => x.table === "tasks" && x.created > 0) && se.every((x) => x.removed === x.created), "run-19d: side effects reported (A2A tasks created by the probe) and removed exactly");
      assertTrue(/## Sideeffekter av lesingene/.test(String(b.markdown)), "run-19e: side effects in the report");
      const refusedAll = (b.rows ?? []).filter((x: any) => x.write_status === 409);
      assertTrue(refusedAll.length > 0 && refusedAll.every((x: any) => x.discriminating === false), "run-19f: refused-write rows are marked non-discriminating");
      assertTrue(vis0(b).every((x: any) => x.discriminating === true), "run-19g: switch rows are discriminating");
      assertTrue(String(b.markdown).includes("| Skiller |") && String(b.markdown).includes("«Skiller» = nei"), "run-19h: the report explains the non-discriminating rows");
      assertTrue(auditRows() > a0, "run-20: the probe's writes are in the change log");
      assertEq(count("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id = ? AND id > ? AND NOT (actor = 'admin' AND actor_detail IN ('switch-probe', 'switch-probe:restore'))", FIX, a0), 0, "run-21: every audit row is the probe's (actor admin, switch-probe)");
      assertEq(count("SELECT COUNT(*) AS n FROM owner_feature_audit WHERE subject_id <> ? AND id > ?", FIX, a0), 0, "run-22: nothing written for any other subject");
      assertEq(mailCalls - m0, 0, "run-23: e-mail surfaces never call a mailer (spied)");
      const md = String(b.markdown || "");
      assertTrue(md.includes("| Nøkkel | Flate | Retning | Resultat | Skiller | Observert | Tid til effekt (ms) | Merknad |"), "run-24: Markdown report table");
      assertTrue(/## FUNN TIL OPPFØLGING\n- \[FUNN\] ingen/.test(md), "run-25: report ends with the findings block (ingen)");
      assertTrue(!md.includes(FIX_EMAIL) && !JSON.stringify(b).includes(FIX_EMAIL), "run-26: no e-mail address in the report or response");
      assertTrue(b.env_flags?.OWNER_LOCK_ENFORCE_WRITES === "1" && b.env_flags?.OUTREACH_UNSUBSCRIBE_ENABLED === "1", "run-27: env flags reported");
      assertTrue(b.not_observable === 0 && md.includes(`**${b.pass} PASS / 0 FAIL / 0 IKKE OBSERVERBAR**`), "run-28: the report counts PASS / FAIL / IKKE OBSERVERBAR");
    }

    // ═══ Observability: list surfaces that can / cannot see the fixture ═══
    {
      const before = rawState(FIX);
      // (a) 12 producers above the fixture on the leaderboard: the default top 10 misses it.
      const crowd = Array.from({ length: 12 }, (_, i) => `sp-lb-${i}`);
      for (const id of crowd) {
        seed(id, `Toppliste Gard ${i2s(id)}`, { origin: "discovery", hidden: 0, email: `post@${id}.example.no` });
        db.prepare(`UPDATE agent_metrics SET times_chosen = 100 WHERE agent_id = ?`).run(id);
      }
      const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
      assertTrue(!conversationService.getLeaderboard(10).some((x: any) => x.agentId === FIX), "obs-1: the fixture is not in the default top 10");
      const a = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      const lb = a.rows.filter((x) => x.key === "visibility.profile" && x.surface === "leaderboard");
      assertTrue(lb.length === 2 && lb.every((x) => x.result === "PASS") && lb.some((x) => x.direction === "on" && /api_leaderboard=ja/.test(x.observed)),
        `obs-2: leaderboard read with a raised limit → PASS both ways (${lb.map((x) => `${x.direction}:${x.result}`).join(",")})`);
      assertEq([a.fail, a.not_observable, a.ready_for_daniel_test], [0, 0, true], "obs-3: fail 0, not observable 0, ready");
      for (const id of crowd) {
        for (const t of ["agent_metrics", "products", "agent_knowledge"]) db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(id);
        db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
      }

      // (b) the fixture structurally absent: no agent_metrics row, no in-stock product.
      const metrics = db.prepare(`SELECT * FROM agent_metrics WHERE agent_id = ?`).get(FIX) as Record<string, unknown>;
      db.prepare(`DELETE FROM agent_metrics WHERE agent_id = ?`).run(FIX);
      db.prepare(`UPDATE products SET availability = 'out_of_stock' WHERE agent_id = ?`).run(FIX);
      const blind: import("../owner-features/switch-probe").SurfaceReaderDef = { observe: "blind", read: () => ({ endpoints: { vcard: false }, requireAll: true }) };
      let n: Awaited<ReturnType<typeof probe.runSwitchProbe>>;
      try {
        n = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0, readers: { "visibility.profile × vcard": blind } });
      } finally {
        const cols = Object.keys(metrics);
        db.prepare(`INSERT INTO agent_metrics (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((k) => metrics[k]));
        db.prepare(`UPDATE products SET availability = 'in_stock' WHERE agent_id = ?`).run(FIX);
      }
      const rowsOf = (s: string) => n!.rows.filter((x) => x.key === "visibility.profile" && x.surface === s);
      const nob = (s: string, re: RegExp, label: string) => {
        const rs = rowsOf(s);
        assertTrue(rs.length === 2 && rs.every((x) => x.result === "NOT_OBSERVABLE" && re.test(x.reason || "") && x.discriminating === false && x.ms_to_effect === null)
          && rs.map((x) => x.direction).sort().join(",") === "off,on",
          `${label} (${rs.map((x) => `${x.direction}:${x.result}:${x.reason}`).join(" | ")})`);
      };
      nob("leaderboard", /ingen rad i agent_metrics/, "obs-4: leaderboard without an agent_metrics row → NOT_OBSERVABLE both ways, with the reason");
      nob("acp_feed", /ingen vare på lager i feeden/, "obs-5: acp_feed without an in-stock product → NOT_OBSERVABLE both ways, with the reason");
      nob("vcard", /vises ikke på vcard i grunntilstanden/, "obs-6: any visibility surface blind in the visible state (injected reader) → NOT_OBSERVABLE, generic reason");
      assertTrue(n!.rows.every((x) => x.result !== "PASS" || !["leaderboard", "acp_feed", "vcard"].includes(x.surface) || x.key !== "visibility.profile"), "obs-7: never PASS on an unobservable surface");
      assertEq([n!.not_observable, n!.fail, n!.ready_for_daniel_test, n!.restored], [6, 0, false, true], "obs-8: 6 not observable, 0 fail, NOT ready, restored");
      const md = n!.markdown;
      assertTrue(md.includes(`**${n!.pass} PASS / 0 FAIL / 6 IKKE OBSERVERBAR**`) && md.includes("«ikke observerbar» teller ikke som PASS"), "obs-9: the report shows the three counts and why it is not ready");
      assertTrue(/\| visibility\.profile \| leaderboard \| (on|off) \| IKKE OBSERVERBAR \|/.test(md), "obs-10: the row table says IKKE OBSERVERBAR");
      assertTrue(/- \[FUNN\] bryterprobe-visibility-profile-acp-feed-(on|off) · P2 · .*ikke observerbar/.test(md) && !md.includes("- [FUNN] ingen"), "obs-11: the not-observable rows land in the findings block (P2)");
      assertEq(rawState(FIX), before, "obs-12: restored byte-identical");
      assertTrue(/- \[FUNN\] bryterprobe-visibility-profile-vcard-(on|off) · P1 · .*ikke observerbar/.test(md) && !/bryterprobe-visibility-profile-vcard-(on|off) · P2/.test(md),
        "obs-13: a single-object surface (vcard) not observable → finding at P1, list surfaces stay P2");

      const dropProducer = (id: string) => {
        for (const t of ["agent_metrics", "products", "agent_knowledge"]) db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(id);
        db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
      };
      const acpRows = (r: Awaited<ReturnType<typeof probe.runSwitchProbe>>) => r.rows.filter((x) => x.key === "visibility.profile" && x.surface === "acp_feed");
      const fmt = (rs: Array<{ direction: string; result: string; observed: string }>) => rs.map((x) => `${x.direction}:${x.result}:${x.observed}`).join(" | ");

      // (d) >500 newer in-stock products ahead of the fixture's, in its city and elsewhere,
      // plus a visible producer whose slug starts with the fixture's slug.
      const feedCrowd = Array.from({ length: 6 }, (_, i) => `sp-feed-${i}`);
      const NORD = "sp-nord";
      const addProducts = (id: string, n: number) => {
        const ins = db.prepare(
          `INSERT INTO products (id, agent_id, name, name_norm, unit, price_nok, availability, category, image_url, availability_source, availability_updated_at, updated_at)
           VALUES (?, ?, ?, ?, 'kg', 40, 'in_stock', 'vegetables', 'https://img.example.no/c.jpg', 'admin_producer_confirmed', ?, '2099-01-01 00:00:00')`);
        for (let k = 0; k < n; k++) ins.run(`p-${id}-${k}`, id, `Feedvare ${k}`, `feedvare ${k}`, new Date().toISOString());
      };
      let d: Awaited<ReturnType<typeof probe.runSwitchProbe>>;
      try {
        feedCrowd.forEach((id, i) => {
          seed(id, `Feedgard ${i2s(id)}`, { origin: "discovery", hidden: 0, email: `post@${id}.example.no` });
          if (i >= 4) db.prepare(`UPDATE agents SET city = 'Bergen' WHERE id = ?`).run(id);
          addProducts(id, i >= 4 ? 30 : 130);
        });
        seed(NORD, `${FIX_NAME} Nord`, { origin: "discovery", hidden: 0, email: "post@sp-nord.example.no" });
        const ahead = count(`SELECT COUNT(*) AS n FROM products p JOIN agents a ON a.id = p.agent_id WHERE p.availability = 'in_stock' AND a.city = 'Ålesund' AND p.agent_id <> ?
          AND p.updated_at > (SELECT MAX(updated_at) FROM products WHERE agent_id = ?)`, FIX, FIX);
        assertTrue(ahead > 500, `obs-14: more than one 500-item feed page ahead of the fixture in its own city (${ahead})`);
        d = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      } finally {
        for (const id of [...feedCrowd, NORD]) dropProducer(id);
      }
      const ad = acpRows(d!);
      assertTrue(ad.length === 2 && ad.every((x) => x.result === "PASS"), `obs-15: acp_feed PASS both ways with the fixture past the first feed page (${fmt(ad)})`);
      assertTrue(ad.some((x) => x.direction === "on" && /feed=ja/.test(x.observed) && /acp_csv=ja/.test(x.observed)), `obs-16: «on»: the paged, city-filtered feed and the CSV both see the fixture (${fmt(ad)})`);
      assertTrue(ad.some((x) => x.direction === "off" && /feed=nei/.test(x.observed) && /acp_csv=nei/.test(x.observed)),
        `obs-17: «off»: a visible producer whose slug starts with the fixture's does not count as the fixture in the CSV (${fmt(ad)})`);
      assertEq(rawState(FIX), before, "obs-18: restored byte-identical");

      // (e) only the CSV can see the fixture (the feed's city filter misses it) → still observable, PASS.
      db.prepare(`UPDATE agents SET city = 'Ålesund ' WHERE id = ?`).run(FIX);
      let e2: Awaited<ReturnType<typeof probe.runSwitchProbe>>;
      try {
        e2 = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      } finally {
        db.prepare(`UPDATE agents SET city = 'Ålesund' WHERE id = ?`).run(FIX);
      }
      const ae = acpRows(e2!);
      assertTrue(ae.length === 2 && ae.every((x) => x.result === "PASS") && ae.some((x) => x.direction === "on" && /feed=nei/.test(x.observed) && /acp_csv=ja/.test(x.observed)),
        `obs-19: only the ACP CSV sees the fixture → acp_feed still observable and PASS both ways (${fmt(ae)})`);

      // (f) the baseline re-check reader throws → FAIL «leser feilet», never NOT_OBSERVABLE.
      let calls = 0;
      const flaky: import("../owner-features/switch-probe").SurfaceReaderDef = {
        observe: "flaky",
        read: () => { if (calls++ === 0) return { endpoints: { api_leaderboard: false } }; throw new Error("injected baseline reader failure"); },
      };
      const f2 = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0, readers: { "visibility.profile × leaderboard": flaky } });
      const lf = f2.rows.filter((x) => x.key === "visibility.profile" && x.surface === "leaderboard");
      assertTrue(lf.length === 2 && lf.every((x) => x.result === "FAIL" && /leser feilet i grunntilstanden: injected baseline reader failure/.test(x.reason || "")),
        `obs-20: a reader that throws at the baseline re-check → FAIL «leser feilet», not NOT_OBSERVABLE (${lf.map((x) => `${x.direction}:${x.result}:${x.reason}`).join(" | ")})`);
      assertEq([f2.not_observable, f2.ready_for_daniel_test, f2.restored], [0, false, true], "obs-21: 0 not observable, not ready, restored");
      assertEq(rawState(FIX), before, "obs-22: restored byte-identical");
    }

    // ═══ Flags off: the rows that depend on them FAIL ═════════════════════
    {
      delete process.env.OWNER_LOCK_ENFORCE_WRITES;
      delete process.env.OUTREACH_UNSUBSCRIBE_ENABLED;
      const before = rawState(FIX);
      const r = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      const kw = r.rows.filter((x) => x.key === "auto.guarantee" && x.surface === "job:knowledge_write");
      const ou = r.rows.filter((x) => x.key === "comms.unsubscribe" && x.surface === "email:outreach");
      assertTrue(kw.length === 2 && kw.every((x) => x.result === "FAIL" && /flag off in this environment \(OWNER_LOCK_ENFORCE_WRITES=unset\)/.test(x.reason || "")), "flags-1: knowledge_write rows FAIL «flag off in this environment»");
      assertTrue(ou.length === 2 && ou.every((x) => x.result === "FAIL" && /flag off in this environment \(OUTREACH_UNSUBSCRIBE_ENABLED=unset\)/.test(x.reason || "")), "flags-2: outreach rows FAIL «flag off in this environment»");
      assertEq([r.env_flags.OWNER_LOCK_ENFORCE_WRITES, r.env_flags.OUTREACH_UNSUBSCRIBE_ENABLED], [null, null], "flags-3: the flag values are reported");
      assertEq([r.ready_for_daniel_test, r.restored], [false, true], "flags-4: not ready, restored");
      assertTrue(/- \[FUNN\] bryterprobe-auto-guarantee-job-knowledge-write-off · P1 · /.test(r.markdown), "flags-5: the FAIL rows land in the findings block");
      assertEq(rawState(FIX), before, "flags-6: restored byte-identical");
      setBaseEnv();
      // B2: products.stock_check without its flags → its rows FAIL «flag off».
      delete process.env.STOCK_CHECK_EMAIL_ENABLED;
      delete process.env.OWNER_ORDERABILITY_PORTAL_ENABLED;
      const sc = (await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 })).rows.filter((x) => x.key === "products.stock_check");
      assertTrue(sc.length === 6 && sc.every((x) => x.result === "FAIL" && /flag off in this environment \((STOCK_CHECK_EMAIL_ENABLED|OWNER_ORDERABILITY_PORTAL_ENABLED)=unset\)/.test(x.reason || "")),
        `flags-6b: stock_check rows FAIL «flag off» without STOCK_CHECK_EMAIL_ENABLED / OWNER_ORDERABILITY_PORTAL_ENABLED (${sc.map((x) => `${x.surface}:${x.direction}:${x.result}`).join(",")})`);
      assertEq(rawState(FIX), before, "flags-6c: restored byte-identical");
      setBaseEnv();
      // Without OWNER_FEATURES_ENFORCE (and the pause flag) visibility.profile has no
      // effect: the probe must see the fixture still shown and FAIL the «off» rows.
      delete process.env.OWNER_FEATURES_ENFORCE;
      const v = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      const off = v.rows.filter((x) => x.key === "visibility.profile" && x.direction === "off");
      assertTrue(off.length === 12 && off.every((x) => x.result === "FAIL" && /OWNER_FEATURES_ENFORCE og OWNER_PAUSE_ENABLED er av/.test(x.reason || "")), "flags-7: enforce off → visibility.profile «off» rows FAIL (the probe discriminates)");
      assertTrue(v.rows.filter((x) => x.key === "visibility.profile" && x.direction === "on").every((x) => x.result === "PASS"), "flags-8: … while «on» still PASSes");
      assertEq([v.restored, rawState(FIX)], [true, before], "flags-9: restored byte-identical");
      setBaseEnv();
      // auto.updates without OWNER_AUTO_UPDATES_ENABLED (between deploy and flag-on): a planned
      // entry like any other — no rows, one coming_soon check that PASSes — so the run reads 100 %.
      delete process.env.OWNER_AUTO_UPDATES_ENABLED;
      const flagOff = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      const cs = flagOff.checks.find((x) => x.check === "coming_soon:auto.updates");
      assertEq([flagOff.rows.filter((x) => x.key === "auto.updates").length, cs?.result, /→ 409 coming_soon/.test(cs?.observed ?? "")], [0, "PASS", true],
        "flags-10: flag off — auto.updates has no rows and its coming_soon check PASSes (409 coming_soon, no effect)");
      assertEq([flagOff.fail, flagOff.not_observable, flagOff.ready_for_daniel_test, flagOff.restored], [0, 0, true, true], "flags-11: flag off — the probe still reads 100 % (ready), restored");
      assertEq(rawState(FIX), before, "flags-12: restored byte-identical");
      setBaseEnv();
    }

    // ═══ Forced failures still restore ════════════════════════════════════
    {
      const before = rawState(FIX);
      const r = await probe.runSwitchProbe(FIX, {
        db, maxWaitMs: 0,
        readers: { "orders.enabled × order_gate": { observe: "throws", read: () => { throw new Error("injected reader failure"); } } },
      });
      const gate = r.rows.filter((x) => x.key === "orders.enabled" && x.surface === "order_gate");
      assertTrue(gate.length === 2 && gate.every((x) => x.result === "FAIL" && /injected reader failure/.test(x.reason || "")), "fail-1: a throwing reader → its rows FAIL with the error");
      assertEq([r.ok, r.restored], [true, true], "fail-2: the run completes and restores");
      assertEq(rawState(FIX), before, "fail-3: byte-identical after a reader failure");
      realUntouched("fail-3b");
    }
    {
      const before = rawState(FIX);
      let flipped = false;
      const r = await probe.runSwitchProbe(FIX, {
        db, maxWaitMs: 0,
        afterFlip: (key, dir) => {
          if (key === "visibility.profile" && dir === "off") {
            flipped = !!db.prepare("SELECT 1 FROM owner_profile_pause WHERE agent_id = ?").get(FIX);
            throw new Error("injected mid-run failure");
          }
        },
      });
      assertTrue(flipped, "fail-4: the abort happened with the profile switched off");
      assertEq([r.ok, r.restored, r.ready_for_daniel_test], [false, true, false], "fail-5: ok:false, restored:true");
      assertTrue(/injected mid-run failure/.test(r.error || "") && /kjøringen ble avbrutt/.test(r.markdown), "fail-6: the error is reported");
      assertEq(rawState(FIX), before, "fail-7: byte-identical after the abort (pause row gone)");
      realUntouched("fail-7b");
      assertTrue(!probe.isSwitchProbeRunning(), "fail-8: the run lock is released");
    }

    // ═══ Side-effect cleanup deletes only the probe's own rows ════════════
    {
      let seq = 0;
      const foreignTasks: string[] = [];
      const foreignViews: number[] = [];
      const addForeign = (tag: string) => {
        const id = `foreign-task-${tag}-${++seq}`;
        db.prepare(`INSERT INTO tasks (id, consumer_agent_id, method, params, status) VALUES (?, NULL, 'message/send', ?, 'submitted')`).run(id, JSON.stringify({ foreign: tag, n: seq }));
        foreignTasks.push(id);
        for (const agent of [FIX, REAL]) {
          const info = db.prepare(`INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source) VALUES (?, ?, 'Ålesund', ?)`).run(agent, `foreign ${tag}`, `foreign-${tag}-${seq}`);
          foreignViews.push(Number(info.lastInsertRowid));
        }
      };
      for (let i = 0; i < 3; i++) addForeign("seed");
      // Other traffic while the probe runs: a timer, and a reader that writes after an await.
      const timer = setInterval(() => addForeign("timer"), 2);
      const defaults = probe.defaultSwitchProbeReaders();
      const wrap = (id: string): import("../owner-features/switch-probe").SurfaceReaderDef => ({
        ...defaults[id],
        read: async (ctx) => {
          const o = await defaults[id].read(ctx);
          await new Promise((r) => setImmediate(r));
          addForeign("after-await");
          return o;
        },
      });
      let r: Awaited<ReturnType<typeof probe.runSwitchProbe>>;
      try {
        r = await probe.runSwitchProbe(FIX, {
          db, maxWaitMs: 0,
          readers: { "visibility.profile × a2a": wrap("visibility.profile × a2a"), "visibility.profile × profile_html": wrap("visibility.profile × profile_html") },
        });
      } finally {
        clearInterval(timer);
      }
      assertTrue(foreignTasks.some((t) => t.includes("timer")) && foreignTasks.some((t) => t.includes("after-await")), "se-1: foreign rows were written during the run (timer + after an await)");
      const tasksLeft = new Set((db.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>).map((x) => x.id));
      assertEq(foreignTasks.filter((t) => !tasksLeft.has(t)), [], "se-2: every foreign tasks row survives (by id)");
      const viewRows = db.prepare(`SELECT id, agent_id, view_source FROM analytics_agent_views`).all() as Array<{ id: number; agent_id: string; view_source: string }>;
      const viewsById = new Map(viewRows.map((v) => [v.id, v]));
      assertEq(foreignViews.filter((id) => !viewsById.get(id)?.view_source?.startsWith("foreign-")), [], "se-3: every foreign view row survives (by id and content), the fixture's own pre-existing ones too");
      const probeTasks = (db.prepare(`SELECT id FROM tasks WHERE params NOT LIKE '%"foreign"%'`).all() as Array<{ id: string }>);
      assertEq(probeTasks, [], "se-4: the probe's own tasks rows are gone");
      const fixtureViews = viewRows.filter((v) => v.agent_id === FIX && !v.view_source.startsWith("foreign-"));
      assertEq(fixtureViews, [], "se-5: the probe's own fixture view rows are gone");
      const seTasks = r!.side_effects.find((x) => x.table === "tasks");
      const seViews = r!.side_effects.find((x) => x.table === "analytics_agent_views");
      assertTrue(!!seTasks && seTasks.created > 0 && seTasks.removed === seTasks.created && seTasks.left_after_run === 0, "se-6: tasks: created = removed, nothing left");
      assertTrue(!!seViews && seViews.created > 0 && seViews.removed === seViews.created, "se-7: views: created = removed");
      assertTrue(!!seViews && (seViews.left_after_run ?? 0) > 0, "se-8: the leak indicator counts fixture rows from the run window that stayed (the foreign ones here)");
      assertEq(r!.restored, true, "se-9: restored");
      // Clean up the foreign rows for the next blocks.
      for (const id of foreignTasks) db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      for (const id of foreignViews) db.prepare(`DELETE FROM analytics_agent_views WHERE id = ?`).run(id);
    }

    // ═══ Vacuous-PASS guards: the checks FAIL when the write path is broken ═══
    {
      const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const before = rawState(FIX);
      // (a) the write is accepted but its audit row is missing → «not in the change log».
      const dropAudit: import("../owner-features/switch-probe").ProbeWriteFn = (v, id, key, val, actor, o) => {
        const out = rs.setOwnerFeatureValue(v, id, key, val, actor, o);
        if (out.kind === "ok" && out.changed) db.prepare(`DELETE FROM owner_feature_audit WHERE id = (SELECT MAX(id) FROM owner_feature_audit WHERE subject_id = ? AND key = ?)`).run(FIX, key);
        return out;
      };
      const a = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0, write: dropAudit });
      const flips = a.rows.filter((x) => x.key === "visibility.profile" || (x.key === "orders.enabled"));
      assertTrue(flips.length > 0 && flips.every((x) => x.result === "FAIL" && x.change_logged === false && /endringsloggen/.test(x.reason || "")), "vac-1: an accepted write without its audit row → the switch rows FAIL");
      assertTrue(a.checks.some((x) => x.check === "no_surface:comms.news" && x.result === "FAIL"), "vac-2: … and the no-surface check FAILs");
      assertEq([a.restored, rawState(FIX)], [true, before], "vac-3: restored");
      // (b) a coming_soon key whose write is accepted → its check FAILs.
      const csKey = "visibility.ai_assistants";
      const regCs = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === csKey ? { ...e, status: "live" as const } : e));
      const acceptCs: import("../owner-features/switch-probe").ProbeWriteFn = (v, id, key, val, actor, o) =>
        rs.setOwnerFeatureValue(v, id, key, val, actor, key === csKey ? { ...o, registry: regCs } : o);
      const b2 = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0, write: acceptCs });
      const cs = b2.checks.find((x) => x.check === `coming_soon:${csKey}`);
      assertTrue(!!cs && cs.result === "FAIL", `vac-4: an accepted write on coming_soon ${csKey} → its check FAILs`);
      assertTrue(b2.checks.filter((x) => x.check.startsWith("coming_soon:") && x.check !== `coming_soon:${csKey}`).every((x) => x.result === "PASS"), "vac-5: … the other coming_soon checks still PASS");
      assertEq([b2.restored, rawState(FIX)], [true, before], "vac-6: restored");
      // (c) the requirement not enforced → the requirement check FAILs.
      const regReq = reg.OWNER_FEATURE_REGISTRY.map((e) => (e.key === "orders.enabled" ? { ...e, requires: [] } : e));
      const noReq: import("../owner-features/switch-probe").ProbeWriteFn = (v, id, key, val, actor, o) =>
        rs.setOwnerFeatureValue(v, id, key, val, actor, key === "orders.enabled" ? { ...o, registry: regReq } : o);
      const c3 = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0, write: noReq });
      const rq = c3.checks.find((x) => x.check === "requirement_unmet:orders.enabled");
      assertTrue(!!rq && rq.result === "FAIL", "vac-7: requirement not enforced → requirement_unmet check FAILs");
      assertEq([c3.restored, rawState(FIX)], [true, before], "vac-8: restored");
      realUntouched("vac-9");
    }

    // ═══ Run lock is released when the setup throws ═══════════════════════
    {
      const badDb = new Proxy(db as any, {
        get(t, p) {
          if (p === "prepare") return (sql: string) => { if (sql.includes("SELECT id, name, city, categories")) throw new Error("injected setup failure"); return t.prepare(sql); };
          const v = t[p];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const r = await probe.runSwitchProbe(FIX, { db: badDb, maxWaitMs: 0 });
      assertTrue(r.ok === false && /injected setup failure/.test(r.error || ""), "lock-1: a failing setup → ok:false with the error");
      assertTrue(!probe.isSwitchProbeRunning(), "lock-2: the run lock is released");
      const again = await probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      assertTrue(again.ok === true, "lock-3: the next run starts");
    }

    // ═══ Concurrency ══════════════════════════════════════════════════════
    {
      const first = call({ dry_run: false, max_wait_ms: 0 });
      const second = await call({ dry_run: false, max_wait_ms: 0 });
      assertEq([second.status, second.body?.error], [409, "already_running"], "busy-1: a second concurrent run → 409");
      const f = await first;
      assertEq([f.status, f.body?.restored], [200, true], "busy-2: the first run completes");
      let threw = false;
      const p = probe.runSwitchProbe(FIX, { db, maxWaitMs: 0 });
      try { await probe.runSwitchProbe(FIX, { db }); } catch (e) { threw = e instanceof probe.SwitchProbeBusyError; }
      await p;
      assertTrue(threw, "busy-3: runSwitchProbe itself refuses a second run");
    }

    // ═══ Helpers ══════════════════════════════════════════════════════════
    {
      const readers = probe.defaultSwitchProbeReaders();
      const missing: string[] = [];
      for (const e of reg.OWNER_FEATURE_REGISTRY.filter((x) => x.status === "live")) {
        for (const s of e.surfaces) if (!readers[`${e.key} × ${s}`]) missing.push(`${e.key} × ${s}`);
      }
      assertEq(missing, [], "gov-1: every live key × surface has a switch-probe effect reader (a new live surface needs one)");
      assertEq(probe.maskEmail("daniel@example.com"), "d***@example.com", "help-1: maskEmail");
      assertEq(probe.maskDeep([{ table: "agents", before: { order_notification_email: "daniel@example.com", n: 1 }, after: { actor_detail: "x@y.no" } }]),
        [{ table: "agents", before: { order_notification_email: "d***@example.com", n: 1 }, after: { actor_detail: "x***@y.no" } }], "help-1b: restore_diff e-mails masked");
      const ev = probe.evaluateObservation;
      assertEq([
        ev({ endpoints: { card: true, info: false }, requireAll: true }, true, null).pass,
        ev({ endpoints: { card: true, info: true }, requireAll: true }, true, null).pass,
        ev({ endpoints: { home: true, city: false } }, true, null).pass,
        ev({ endpoints: { home: false, city: true } }, false, null).pass,
      ], [false, true, true, false], "help-3: single-object surfaces need every endpoint for «on»; list surfaces one; «off» needs none");
      assertEq([
        probe.putStatusFor({ kind: "blocked", block: "locked", reason: { no: "", en: "" } }),
        probe.putStatusFor({ kind: "invalid_value", reason: { no: "", en: "" } }),
        probe.putStatusFor({ kind: "unknown_key" }),
      ], [409, 400, 404], "help-2: write result → PUT status");
    }
  } catch (err: any) {
    failed++;
    failures.push("unexpected error: " + String(err?.stack || err));
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    try { notifySvc?.__setOrderNotifySendForTesting(null); notifySvc?.__setOrderNotifyTestDb(null); } catch { /* ignore */ }
    try { (require("../services/cart-service") as typeof import("../services/cart-service")).__setCartTestDb(null); } catch { /* ignore */ }
    if (es && prevSendEmail) es.sendEmail = prevSendEmail;
    for (const k of SAVED_ENV) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    if (prevDb) initMod.__setDbForTesting(prevDb);
    try { db.close(); } catch { /* ignore */ }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runAdminOwnerFeaturesSwitchProbeTests({ log: process.argv.includes("--log") }).then((r) => {
    console.info(`\nadmin-owner-features-switch-probe: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.info(f);
    process.exit(r.failed ? 1 : 0);
  });
}
