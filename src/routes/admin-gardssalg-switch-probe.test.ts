/**
 * admin-gardssalg-switch-probe.test.ts — dev-request 2026-10-22-opplevagent-
 * mine-valg-gardssalg, «v2 for Opplevagent», slice O2b: the Opplevagent
 * «Mine valg» switch probe («bryterprobe»),
 * POST /admin/gardssalg/owner-features/switch-probe.
 *
 *   gate      flag off → 404; admin key unset → 503, wrong → 403; bad body → 400
 *   target    OA_OWNER_FEATURES_ENABLED off, a real producer, an unknown id,
 *             the fixture outside the allowlist → refused, zero writes
 *   dry run   the default: the plan, zero writes, no surface read
 *   run       on the gårdssalg test producer: 100 % PASS, every live key ×
 *             surface covered, booking channels refused/open without a
 *             booking row or an e-mail, the change log written (actor_detail
 *             switch-probe), the fixture byte-identical afterwards, never
 *             public on a plain read during the run, the side-effect rows
 *             removed, the findings block, no other-platform name
 *   broken    a booking reader that ignores the owner's pause → FAIL
 *   blind     a surface that cannot see the test row → IKKE OBSERVERBAR (both
 *             ways), not ready; the real A2A surface for a fixture without
 *             coordinates or kommune → IKKE OBSERVERBAR with the reason
 *   o2c       the place set via POST /admin/gardssalg/test-provider → every
 *             a2a row PASS; the row stays out of a plain public A2A request
 *   flags     OUTREACH_UNSUBSCRIBE_ENABLED off → that row FAIL «flag off»
 *   failure   a throw mid-run (after a flip) → ok:false, still restored exactly
 *   busy      a second concurrent run → 409 already_running / BusyError
 *
 * Exported runAdminGardssalgSwitchProbeTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/admin-gardssalg-switch-probe.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const KEY = "gs-switch-probe-admin-key-for-tests";
const FIX = "gs-probe-fixture";
const FIX_NAME = "Probegard Sideri Testfixtur";
const FIX_SLUG = "probegard-sideri-testfixtur";
const OWNER = "eier@probegard.example.no";
const SAVED_ENV = [
  "EXPERIENCES_DB_PATH", "OA_OWNER_FEATURES_ENABLED", "OWNER_FEATURES_ALLOWED_SUBJECTS", "OA_OWNER_FEATURES_SWITCH_PROBE_ENABLED",
  "BOOKING_DISPATCH_ENABLED", "ADMIN_KEY", "ANALYTICS_ADMIN_KEY", "OUTREACH_UNSUBSCRIBE_ENABLED", "UNSUBSCRIBE_TOKEN_SECRET",
];

export function runAdminGardssalgSwitchProbeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const assertEq = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)?.slice(0, 800)}\n    actual:   ${JSON.stringify(actual)?.slice(0, 800)}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  };
  const assertTrue = (cond: boolean, label: string, extra?: unknown) => {
    if (cond) { passed++; if (log) console.info(`  ok ${label}`); }
    else {
      failed++;
      const msg = `✗ ${label}${extra !== undefined ? `\n    ${JSON.stringify(extra)?.slice(0, 1500)}` : ""}`;
      failures.push(msg);
      if (log) console.info("  " + msg);
    }
  };

  return (async () => {
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of SAVED_ENV) prevEnv[k] = process.env[k];
    for (const k of SAVED_ENV) delete process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = KEY;

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("../services/gardssalg-claim"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("../services/blocklist-service"),
      require.resolve("../services/gardssalg-booking-resolve"),
      require.resolve("../services/route-corridor-service"),
      require.resolve("./opplevelser"),
      require.resolve("./experiences-mcp"),
      require.resolve("./experiences-a2a"),
      require.resolve("./experiences-seo"),
    ]);
    const prevLog = console.log;
    const prevErr = console.error;
    const prevWarn = console.warn;
    if (!log) { console.log = () => { /* silence */ }; console.error = () => { /* silence */ }; console.warn = () => { /* silence */ }; }
    const servers: any[] = [];
    let initMod: typeof import("../database/init") | null = null;
    let prevRfbDb: any = null;
    let es: any = null;
    let prevSendEmail: any = null;

    try {
      initMod = require("../database/init") as typeof import("../database/init");
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const db = new Database(":memory:");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      // Mail spy: nothing in the probe may reach the mailer.
      let mailCalls = 0;
      es = (require("../services/email-service") as typeof import("../services/email-service")).emailService as any;
      prevSendEmail = es.sendEmail;
      es.sendEmail = async () => { mailCalls++; return { success: true, messageId: "spy" }; };

      // ── Fixtures ─────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(`
        INSERT INTO experience_providers
          (id, navn, slug, vertical, org_nr, brreg_verified, brreg_active, epost, content_source, products,
           producer_type, enrichment_state, verification_status, source, confidence, booking_live, is_test_provider,
           catalog_hidden, catalog_hidden_reason, fylke, kommune, poststed, lat, lon, geocode_confidence, claimed_at, created_at)
        VALUES
          (@id, @navn, @slug, 'experiences', @org_nr, 1, 1, @epost, @content_source, '["Eplesider"]',
           @producer_type, 'raw', 'verified', 'test-fixture', 'medium', @booking_live, @is_test_provider,
           @hidden, @reason, 'Vestland', 'Ullensvang', 'Lofthus', @lat, @lon, 'high', @claimed_at, '2026-10-01 08:00:00')
      `);
      const mk = (id: string, navn: string, slug: string, org: string, extra: Record<string, unknown> = {}) =>
        insertProvider.run({
          id, navn, slug, org_nr: org, epost: `post@${slug}.example.no`, content_source: null, producer_type: "cideri", booking_live: 0,
          is_test_provider: null, hidden: null, reason: null, lat: 60.40, lon: 6.70, claimed_at: null, ...extra,
        });
      // Real, public producers (the sitemap lists gårdssalg only from 5 public producers).
      for (let i = 1; i <= 5; i++) mk(`gs-pub${i}`, `Offentlig Sideri ${i}`, `offentlig-sideri-${i}`, `91830000${i}`);
      // The gårdssalg test producer, as POST /admin/gardssalg/test-provider + owner_email leave it (O2a),
      // with a place so the map / corridor / A2A can reach it.
      mk(FIX, FIX_NAME, FIX_SLUG, "TEST000000", {
        epost: OWNER, content_source: "manual", producer_type: "test-gardssalg", booking_live: 1, is_test_provider: 1,
        hidden: 1, reason: "test_fixture", lat: 60.3201, lon: 6.6502, claimed_at: "2026-10-30 08:00:00",
      });
      // A verified claim (the owner logged in through the magic link).
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, created_at, expires_at)
         VALUES ('gsc-fix', ?, ?, 'stored_epost_verified', 'tok-fix', 1, datetime('now'), datetime('now','+7 days'))`,
      ).run(FIX, OWNER);
      // A second hidden test-flagged row that is NOT the fixture (no TEST000000): never a target.
      mk("gs-other-test", "Annen Testrad", "annen-testrad", "918399999", { is_test_provider: 1, hidden: 1, reason: "test_fixture" });
      // An explicit stored choice so the restore has something to put back.
      db.prepare(
        `INSERT INTO owner_feature_settings (vertical, subject_id, key, value_json, set_by, admin_locked, set_at)
         VALUES ('gardssalg', ?, 'booking.pause', 'false', 'owner', 0, '2026-10-29T10:00:00.000Z')`,
      ).run(FIX);

      const probe = require("../owner-features/gardssalg-switch-probe") as typeof import("../owner-features/gardssalg-switch-probe");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const rs = require("../owner-features/resolve") as typeof import("../owner-features/resolve");
      const reg = require("../owner-features/registry") as typeof import("../owner-features/registry");
      (require("./experiences-seo") as typeof import("./experiences-seo")).__resetExperiencesSitemapCacheForTesting();

      const rawState = () => JSON.stringify(probe.snapshotGardssalgFixture(db, expDb, FIX));
      const count = (d: any, sql: string, ...p: unknown[]) => Number((d.prepare(sql).get(...p) as { n: number }).n);
      const counts = () => ({
        audit: count(db, `SELECT COUNT(*) AS n FROM owner_feature_audit`),
        settings: count(db, `SELECT COUNT(*) AS n FROM owner_feature_settings`),
        conversations: count(db, `SELECT COUNT(*) AS n FROM conversations`),
        analytics_queries: count(db, `SELECT COUNT(*) AS n FROM analytics_queries`),
        content_audit: count(expDb, `SELECT COUNT(*) AS n FROM gardssalg_content_audit`),
        bookings: count(expDb, `SELECT COUNT(*) AS n FROM gardssalg_bookings`),
        providers: JSON.stringify(expDb.prepare(`SELECT * FROM experience_providers ORDER BY id`).all()),
      });
      const realUntouched = (label: string) => {
        const rows = expDb.prepare(`SELECT id, catalog_hidden, catalog_hidden_reason, booking_live FROM experience_providers WHERE id LIKE 'gs-pub%' OR id = 'gs-other-test' ORDER BY id`).all();
        assertEq(rows, [
          { id: "gs-other-test", catalog_hidden: 1, catalog_hidden_reason: "test_fixture", booking_live: 0 },
          ...[1, 2, 3, 4, 5].map((i) => ({ id: `gs-pub${i}`, catalog_hidden: null, catalog_hidden_reason: null, booking_live: 0 })),
        ], `${label}: other producers untouched`);
      };

      // ── HTTP wiring ──────────────────────────────────────────────────
      const expressMod = require("express") as typeof import("express");
      const routeMod = require("./admin-gardssalg-switch-probe") as typeof import("./admin-gardssalg-switch-probe");
      const app = expressMod();
      app.use(expressMod.json());
      app.use("/admin/gardssalg/owner-features/switch-probe", routeMod.default);
      const httpMod = require("http") as typeof import("http");
      const server = httpMod.createServer(app);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const call = (body: unknown, headers: Record<string, string> = { "X-Admin-Key": KEY }) =>
        new Promise<{ status: number; body: any }>((resolve, reject) => {
          const payload = JSON.stringify(body ?? {});
          const r = httpMod.request({ method: "POST", host: "127.0.0.1", port, path: "/admin/gardssalg/owner-features/switch-probe", headers: { "Content-Type": "application/json", ...headers } }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on("data", (c) => chunks.push(c as Buffer));
            resp.on("end", () => {
              const t = Buffer.concat(chunks).toString("utf8");
              let j: any = null;
              try { j = JSON.parse(t); } catch { j = t; }
              resolve({ status: resp.statusCode || 0, body: j });
            });
          });
          r.on("error", reject);
          r.write(payload);
          r.end();
        });

      // ═══ Gate ════════════════════════════════════════════════════════
      {
        const c0 = counts();
        assertEq((await call({})).status, 404, "gate-1: flag off → 404");
        process.env.OA_OWNER_FEATURES_SWITCH_PROBE_ENABLED = "true";
        assertEq((await call({})).status, 404, "gate-2: only the exact value \"1\" turns it on");
        process.env.OA_OWNER_FEATURES_SWITCH_PROBE_ENABLED = "1";
        delete process.env.ADMIN_KEY;
        assertEq((await call({})).status, 503, "gate-3: admin key unset → 503");
        process.env.ADMIN_KEY = KEY;
        assertEq((await call({}, {})).status, 403, "gate-4: no X-Admin-Key → 403");
        assertEq((await call({}, { "X-Admin-Key": "wrong" })).status, 403, "gate-5: wrong X-Admin-Key → 403");
        assertEq((await call({ dry_run: "no" })).status, 400, "gate-6: dry_run not boolean → 400");
        assertEq((await call({ provider_id: "" })).status, 400, "gate-7: empty provider_id → 400");
        assertEq((await call({ max_wait_ms: -1 })).status, 400, "gate-8: negative max_wait_ms → 400");
        assertEq(counts(), c0, "gate-9: zero writes");
      }

      // ═══ Target ══════════════════════════════════════════════════════
      {
        const c0 = counts();
        const off = await call({ dry_run: false });
        assertEq([off.status, off.body?.error], [409, "owner_features_off"], "target-1: OA_OWNER_FEATURES_ENABLED off → 409");
        process.env.OA_OWNER_FEATURES_ENABLED = "1";
        const notAllow = await call({ dry_run: false });
        assertEq([notAllow.status, notAllow.body?.error], [409, "not_allowlisted"], "target-2: fixture outside the allowlist → 409");
        process.env.OWNER_FEATURES_ALLOWED_SUBJECTS = `gardssalg:${FIX},gardssalg:gs-pub1,gardssalg:gs-other-test,rfb:${FIX}`;
        const real = await call({ dry_run: false, provider_id: "gs-pub1" });
        assertEq([real.status, real.body?.error], [409, "not_a_test_fixture"], "target-3: a real (allowlisted) producer → 409");
        const other = await call({ dry_run: false, provider_id: "gs-other-test" });
        assertEq([other.status, other.body?.error], [409, "not_a_test_fixture"], "target-4: a test-flagged row without TEST000000 → 409");
        const unknown = await call({ dry_run: false, provider_id: "nope" });
        assertEq([unknown.status, unknown.body?.error], [404, "provider_not_found"], "target-5: unknown id → 404");
        assertTrue(/Ingenting er endret/.test(String(real.body?.detail)), "target-6: Norwegian reason in the refusal");
        assertEq(counts(), c0, "target-7: refusals wrote nothing");
      }

      // ═══ Dry run ═════════════════════════════════════════════════════
      {
        const c0 = counts();
        const s0 = rawState();
        const d = await call({});
        assertTrue(d.status === 200 && d.body?.dry_run === true && d.body?.provider_id === FIX, "dry-1: default is a dry run on the fixture", d.body?.error);
        assertTrue(Array.isArray(d.body?.plan?.rows) && d.body.plan.rows.length > 0 && d.body.plan.rows.every((r: any) => r.reader), "dry-2: the plan lists every row with a reader");
        assertEq([d.body?.plan?.verified_owner, d.body?.plan?.allowlisted], [true, true], "dry-3: verified owner + allowlisted reported");
        assertTrue("OA_OWNER_FEATURES_ENABLED" in (d.body?.env_flags || {}), "dry-4: env flags in the response");
        assertEq([counts(), rawState()], [c0, s0], "dry-5: zero writes, no surface read (no conversation row)");
        assertTrue(!/rett\s*fra\s*bonden|rettfrabonden/i.test(JSON.stringify(d.body)), "dry-6: no other-platform name");
      }

      // ═══ Full run ════════════════════════════════════════════════════
      {
        process.env.OUTREACH_UNSUBSCRIBE_ENABLED = "1";
        process.env.UNSUBSCRIBE_TOKEN_SECRET = "gs-probe-unsub-secret";
        process.env.BOOKING_DISPATCH_ENABLED = "true";
        const c0 = counts();
        const s0 = rawState();
        const auditBefore = c0.audit;
        let neverPublic = true;
        let flips = 0;
        // Through the module (afterFlip seam) for the «never public» check, and over HTTP below.
        const r = await probe.runGardssalgSwitchProbe(FIX, {
          db, expDb, maxWaitMs: 0,
          afterFlip: () => {
            flips++;
            if (store.listGardssalgProviders(500, 0).some((p: any) => p.id === FIX)) neverPublic = false;
            if (store.searchGardssalgProviders({ q: "Probegard" }, 50, { surface: "mcp" }).some((p: any) => p.id === FIX)) neverPublic = false;
          },
        });
        const bad = [...r.rows.filter((x) => x.result !== "PASS"), ...r.checks.filter((x) => x.result !== "PASS")];
        assertTrue(r.ok && r.fail === 0 && r.not_observable === 0 && r.pass > 0, "run-1: 100 % PASS", { error: r.error, bad: bad.slice(0, 6) });
        assertTrue(r.ready_for_daniel_test === true, "run-2: ready_for_daniel_test");
        assertTrue(r.restored === true && r.restore_diff.length === 0, "run-3: restored exactly", r.restore_diff);
        assertEq(rawState(), s0, "run-4: fixture byte-identical to the snapshot");
        assertTrue(neverPublic && flips > 0, "run-5: the test row was never on a plain public read during the run");
        const live = reg.GARDSSALG_OWNER_FEATURE_REGISTRY.filter((e) => e.status === "live");
        const missing: string[] = [];
        for (const e of live) for (const s of e.surfaces) if (!r.rows.some((x) => x.key === e.key && x.surface === s)) missing.push(`${e.key} × ${s}`);
        assertEq(missing, [], "run-6: every live key × surface has rows");
        const pause = r.rows.filter((x) => x.key === "booking.pause" && x.surface === "booking_gate");
        assertEq(pause.map((x) => [x.direction, x.result]), [["on", "PASS"], ["off", "PASS"]], "run-7: booking.pause × booking_gate on/off PASS");
        assertTrue(/rest_book: «tar ikke imot forespørsler nå»/.test(pause[0]?.observed || "") && /mcp_book: «tar ikke imot/.test(pause[0]?.observed || "") && /form_post: «tar ikke imot/.test(pause[0]?.observed || ""), "run-8: pause on → every channel refuses with the not-taking line", pause[0]?.observed);
        assertTrue(/rest_book: slipper gjennom porten/.test(pause[1]?.observed || ""), "run-9: pause off → the channels let a request through the gate (refused only by the past slot)", pause[1]?.observed);
        const visOff = r.rows.find((x) => x.key === "visibility.profile" && x.surface === "listing_html" && x.direction === "off");
        assertTrue(!!visOff && /kategori=nei/.test(visOff.observed) && /kart=nei/.test(visOff.observed), "run-10: visibility off → gone from the catalogue and the map");
        const visOn = r.rows.find((x) => x.key === "visibility.profile" && x.surface === "listing_html" && x.direction === "on");
        assertTrue(!!visOn && /kategori=ja/.test(visOn.observed) && /sok=ja/.test(visOn.observed) && /reise_korridor=ja/.test(visOn.observed), "run-11: visibility on → back in catalogue, /sok and the corridor", visOn?.observed);
        const locked = r.rows.filter((x) => ["booking.reminder", "booking.attendance", "notify.booking_email"].includes(x.key) && (x.direction === "off" || x.direction === "on"));
        assertTrue(locked.length > 0 && locked.every((x) => x.discriminating === false && x.write_status === 409), "run-12: locked keys: writes refused (409), Skiller = nei");
        const guar = r.rows.filter((x) => x.key === "content.guarantee" || x.key === "comms.unsubscribe");
        assertTrue(guar.length > 0 && guar.every((x) => x.discriminating === false && x.write_status === 409 && x.result === "PASS"), "run-13: promises refused (409) and holding");
        const sw = r.rows.filter((x) => x.discriminating && x.change_logged !== null);
        assertTrue(sw.length > 0 && sw.every((x) => x.change_logged === true), "run-14: every switch write in the change log (exactly one row)");
        const auditNew = db.prepare(`SELECT actor, actor_detail FROM owner_feature_audit WHERE vertical = 'gardssalg' AND id > ?`).all(0) as Array<{ actor: string; actor_detail: string | null }>;
        assertTrue(count(db, `SELECT COUNT(*) AS n FROM owner_feature_audit`) > auditBefore && auditNew.every((a) => a.actor === "admin" && /^switch-probe/.test(a.actor_detail || "")), "run-15: audit rows by admin / switch-probe only");
        assertTrue(r.checks.some((x) => x.check === "coming_soon:booking.ai_booking" && x.result === "PASS"), "run-16: coming_soon check");
        assertTrue(r.checks.some((x) => x.check === "requirement_unmet:booking.enabled" && x.result === "PASS") && r.checks.some((x) => x.check === "requirement_unmet:booking.pause" && x.result === "PASS"), "run-17: requirement checks");
        assertTrue(["level:bare_synlig", "level:ta_imot_besok", "undo:level:bare_synlig"].every((k) => r.checks.some((x) => x.check === k && x.result === "PASS")), "run-18: level + undo checks");
        assertEq([mailCalls, counts().bookings], [0, 0], "run-19: no e-mail sent, no booking row");
        assertEq([counts().conversations, counts().analytics_queries], [c0.conversations, c0.analytics_queries], "run-20: the read paths' log rows (conversations, analytics_queries) are removed again");
        assertTrue(r.side_effects.some((x) => x.table === "conversations" && x.created > 0 && x.removed === x.created), "run-21: side effects captured and removed", r.side_effects);
        assertTrue(r.markdown.includes("## FUNN TIL OPPFØLGING") && r.markdown.includes("- [FUNN] ingen"), "run-22: findings block (none)");
        assertTrue(!/rett\s*fra\s*bonden|rettfrabonden/i.test(JSON.stringify(r)), "run-23: no other-platform name anywhere in the result");
        assertTrue(r.checks.some((x) => x.check === "brand" && x.result === "PASS"), "run-24: brand check PASS");
        assertTrue(r.markdown.includes("IKKE OBSERVERBAR") && r.markdown.includes("| Nøkkel | Flate | Retning | Resultat | Skiller |"), "run-25: report table and counts");
        realUntouched("run-26");
        assertTrue(!probe.isGardssalgSwitchProbeRunning(), "run-27: lock released");

        // Over HTTP too (dry_run:false).
        const h = await call({ dry_run: false, max_wait_ms: 0 });
        assertTrue(h.status === 200 && h.body?.ok === true && h.body?.fail === 0 && h.body?.ready_for_daniel_test === true, "run-28: HTTP run → 200, 100 % PASS", h.body?.error ?? h.body?.fail);
        assertEq(rawState(), s0, "run-29: … and restored exactly");
      }

      // ═══ Broken reader: ignores the owner's pause → FAIL ════════════════
      {
        const s0 = rawState();
        const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
        const ignoresPause: import("../owner-features/gardssalg-switch-probe").GardssalgSurfaceReaderDef = {
          observe: "broken: reads only booking_live",
          read: (ctx) => {
            const row = ctx.expDb.prepare(`SELECT booking_live, catalog_hidden, is_test_provider FROM experience_providers WHERE id = ?`).get(ctx.fixture.id) as any;
            const open = !bookingStore.isBookingPaused(row.booking_live, row.catalog_hidden, row.is_test_provider);
            return { endpoints: { gate: !open ? null : false }, requireAll: true };
          },
        };
        const r = await probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0, readers: { "booking.pause × booking_gate": ignoresPause } });
        const row = r.rows.find((x) => x.key === "booking.pause" && x.surface === "booking_gate" && x.direction === "on");
        assertEq(row?.result, "FAIL", "broken-1: a reader that ignores the pause → FAIL for «on»");
        assertTrue(r.ready_for_daniel_test === false && r.fail > 0, "broken-2: not ready");
        assertTrue(r.markdown.includes("[FUNN] oa-bryterprobe-booking-pause-booking-gate-on"), "broken-3: P1 finding for the row");
        assertEq([r.restored, rawState()], [true, s0], "broken-4: restored");
      }

      // ═══ Blind surface → IKKE OBSERVERBAR ═══════════════════════════════
      {
        const s0 = rawState();
        const blind: import("../owner-features/gardssalg-switch-probe").GardssalgSurfaceReaderDef = {
          observe: "blind", needsVisibleRow: true,
          read: () => ({ endpoints: { discover_gardssalg: false }, requireAll: true }),
        };
        const r = await probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0, readers: { "visibility.profile × mcp_search": blind } });
        const rows = r.rows.filter((x) => x.key === "visibility.profile" && x.surface === "mcp_search");
        assertEq(rows.map((x) => x.result), ["NOT_OBSERVABLE", "NOT_OBSERVABLE"], "blind-1: both directions IKKE OBSERVERBAR, never PASS");
        assertTrue(r.not_observable === 2 && r.ready_for_daniel_test === false, "blind-2: counted apart, not ready", { no: r.not_observable, fail: r.fail });
        assertTrue(/2 IKKE OBSERVERBAR/.test(r.markdown) && rows.every((x) => !!x.reason), "blind-3: reported with a reason");
        assertEq([r.restored, rawState()], [true, s0], "blind-4: restored");

        // The real A2A surface for a fixture with no coordinates and no kommune,
        // behind 20 other producers (the skill returns at most 20, by name).
        for (let i = 10; i < 30; i++) mk(`gs-many${i}`, `Annen Sideri ${i}`, `annen-sideri-${i}`, `9184000${i}`);
        expDb.prepare(`UPDATE experience_providers SET lat = NULL, lon = NULL, kommune = NULL, fylke = NULL, poststed = NULL WHERE id = ?`).run(FIX);
        const r2 = await probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0 });
        const a2a = r2.rows.filter((x) => x.surface === "a2a" && x.key === "visibility.profile");
        assertTrue(a2a.length === 2 && a2a.every((x) => x.result === "NOT_OBSERVABLE" && /verken koordinater eller kommune/.test(x.reason || "")), "blind-5: real A2A without a place → IKKE OBSERVERBAR with the reason", a2a);
        assertTrue(r2.rows.filter((x) => x.surface === "a2a").every((x) => x.result !== "PASS"), "blind-6: no a2a row is PASS");
        assertTrue(r2.ready_for_daniel_test === false && r2.restored, "blind-7: not ready, restored");
        assertTrue(a2a.every((x) => /admin\/gardssalg\/test-provider/.test(x.reason || "")), "blind-8: the reason points the operator at the test-provider route", a2a.map((x) => x.reason));

        // O2c: the place set through POST /admin/gardssalg/test-provider (not a raw
        // UPDATE) makes the real A2A surface observable — the 20 other producers
        // (~9 km away) stay outside the probe's 5 km radius.
        const oppRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
        const tp = await new Promise<{ status: number; body: any }>((resolve) => {
          const url = "/admin/gardssalg/test-provider";
          const req: any = {
            method: "POST", url, originalUrl: url, path: url, query: {}, headers: { "x-admin-key": KEY },
            body: { email: OWNER, name: FIX_NAME, slug: FIX_SLUG, kommune: "Ullensvang", lat: 60.3201, lon: 6.6502 },
            get(n: string) { return (this.headers as Record<string, string>)[n.toLowerCase()]; },
          };
          const res: any = {
            statusCode: 200,
            status(c: number) { this.statusCode = c; return this; },
            json(b: any) { resolve({ status: this.statusCode, body: b }); return this; },
          };
          oppRouter.handle(req, res, (err?: any) => resolve({ status: 500, body: { error: String(err) } }));
        });
        assertEq([tp.status, tp.body?.provider_id, tp.body?.location], [200, FIX, { kommune: "Ullensvang", lat: 60.3201, lon: 6.6502 }], "o2c-1: location set on the fixture via the test-provider route", tp.body);
        expDb.prepare(`UPDATE experience_providers SET fylke = 'Vestland', poststed = 'Lofthus' WHERE id = ?`).run(FIX);
        const r3 = await probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0 });
        const a2a3 = r3.rows.filter((x) => x.surface === "a2a");
        assertTrue(a2a3.length === 6 && a2a3.every((x) => x.result === "PASS"), "o2c-2: with a place, every a2a row (visibility.profile, booking.enabled, booking.pause) is PASS — observed, not IKKE OBSERVERBAR", a2a3.map((x) => [x.key, x.direction, x.result, x.reason]));
        assertTrue(r3.not_observable === 0 && r3.restored, "o2c-3: nothing IKKE OBSERVERBAR, restored", { no: r3.not_observable });
        // The same A2A message the probe sends: reached only inside the as-public view.
        const a2aMod = require("./experiences-a2a") as typeof import("./experiences-a2a");
        const vis = require("../services/agent-visibility") as typeof import("../services/agent-visibility");
        const msg = { message: { role: "user", parts: [{ kind: "text", text: "gårdssalg" }, { kind: "data", data: { lat: 60.3201, lng: 6.6502, radius_km: 5 } }] } };
        const ids = (out: any): string[] => (out?.result?.artifacts ?? []).flatMap((a: any) => (a?.parts ?? []).flatMap((p: any) => (p?.data?.producers ?? []).map((x: any) => x?.id)));
        assertTrue(!ids(a2aMod.handleExperiencesMessageSend(msg, "pub")).includes(FIX), "o2c-4: a normal public A2A request does not return the hidden test row");
        assertTrue(!ids(a2aMod.handleExperiencesMessageSend({ message: { role: "user", parts: [{ kind: "text", text: "gårdssalg i Ullensvang" }] } }, "pub2")).includes(FIX), "o2c-5: … nor a public kommune query");
        assertTrue(ids(vis.runAsPublicView(() => a2aMod.handleExperiencesMessageSend(msg, "asp"))).includes(FIX), "o2c-6: the as-public view (the probe's context) reaches it");
        assertTrue(!store.searchGardssalgProviders({ lat: 60.3201, lng: 6.6502, radius_km: 5 }, 20, { surface: "a2a" }).some((p: any) => p.id === FIX), "o2c-7: still hidden from the plain a2a search after the probe run");
        expDb.prepare(`DELETE FROM experience_providers WHERE id LIKE 'gs-many%'`).run();
      }

      // ═══ Flag dependency ════════════════════════════════════════════════
      {
        delete process.env.BOOKING_DISPATCH_ENABLED;
        const d = await probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0 });
        const notes = d.rows.filter((x) => ["mcp_search", "rest_card", "a2a"].includes(x.surface) && x.key.startsWith("booking."));
        assertTrue(notes.length === 12 && notes.every((x) => x.result === "FAIL" && /BOOKING_DISPATCH_ENABLED=unset/.test(x.reason || "")), "flag-0: dispatch switch off → the discover booking-note rows FAIL «flag off»", notes.map((x) => [x.key, x.surface, x.result, x.reason]));
        assertTrue(d.rows.filter((x) => x.surface === "booking_gate").every((x) => x.result === "PASS"), "flag-0b: … the channels still follow the switches for the test row");
        process.env.BOOKING_DISPATCH_ENABLED = "true";
        delete process.env.OUTREACH_UNSUBSCRIBE_ENABLED;
        const r = await probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0 });
        const rows = r.rows.filter((x) => x.key === "comms.unsubscribe");
        assertTrue(rows.length === 2 && rows.every((x) => x.result === "FAIL" && /flag off in this environment \(OUTREACH_UNSUBSCRIBE_ENABLED=unset\)/.test(x.reason || "")), "flag-1: unsubscribe flag off → FAIL «flag off»", rows);
        assertEq(r.env_flags.OUTREACH_UNSUBSCRIBE_ENABLED, null, "flag-2: flag value reported");
        process.env.OUTREACH_UNSUBSCRIBE_ENABLED = "1";
      }

      // ═══ Failure mid-run → restored ═════════════════════════════════════
      {
        const s0 = rawState();
        const r = await probe.runGardssalgSwitchProbe(FIX, {
          db, expDb, maxWaitMs: 0,
          afterFlip: (key, dir) => { if (key === "booking.enabled" && dir === "off") throw new Error("injected mid-run failure"); },
        });
        assertTrue(r.ok === false && /injected mid-run failure/.test(r.error || ""), "fail-1: a throw after a flip → ok:false with the error");
        assertEq(rs.resolveOwnerFeatures("gardssalg", FIX, { db }).byKey["booking.enabled"].value, true, "fail-2: booking.enabled back on");
        assertEq([r.restored, rawState()], [true, s0], "fail-3: restored exactly");
        assertTrue(r.ready_for_daniel_test === false && r.markdown.includes("kjøringen ble avbrutt"), "fail-4: not ready, abort in the findings");
        assertTrue(!probe.isGardssalgSwitchProbeRunning(), "fail-5: lock released");
        assertEq(mailCalls, 0, "fail-6: still no mail");
      }

      // ═══ Busy ═══════════════════════════════════════════════════════════
      {
        const first = call({ dry_run: false, max_wait_ms: 0 });
        await new Promise((res) => setTimeout(res, 5));
        const second = await call({ dry_run: false, max_wait_ms: 0 });
        assertEq([second.status, second.body?.error], [409, "already_running"], "busy-1: a second concurrent run → 409");
        const f = await first;
        assertEq([f.status, f.body?.restored], [200, true], "busy-2: the first run completes");
        let threw = false;
        const p = probe.runGardssalgSwitchProbe(FIX, { db, expDb, maxWaitMs: 0 });
        try { await probe.runGardssalgSwitchProbe(FIX, { db, expDb }); } catch (e) { threw = e instanceof probe.GardssalgSwitchProbeBusyError; }
        await p;
        assertTrue(threw, "busy-3: runGardssalgSwitchProbe itself refuses a second run");
      }

      // ═══ Helpers ════════════════════════════════════════════════════════
      {
        assertEq(probe.brandSafe("Laget av Rett fra Bonden"), { text: "Laget av [annen plattform]", hit: true }, "help-1: brandSafe masks and flags the other platform");
        assertEq(probe.brandSafe("Opplevagent"), { text: "Opplevagent", hit: false }, "help-2: … and leaves Opplevagent text alone");
        assertEq(probe.evaluateGardssalgObservation({ endpoints: { a: null }, requireAll: true }, false, null).pass, false, "help-3: an unseen endpoint is never evidence for «off»");
        assertEq(mailCalls, 0, "help-4: no mail in the whole suite");
        assertEq(count(expDb, `SELECT COUNT(*) AS n FROM gardssalg_bookings`), 0, "help-5: no booking row in the whole suite");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
      if (es && prevSendEmail) es.sendEmail = prevSendEmail;
      if (initMod) initMod.__setDbForTesting(prevRfbDb);
      restoreModuleCache();
      console.log = prevLog;
      console.error = prevErr;
      console.warn = prevWarn;
      for (const k of SAVED_ENV) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminGardssalgSwitchProbeTests({ log: true }).then((r) => {
    console.log(`\nadmin-gardssalg-switch-probe: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed ? 1 : 0);
  });
}
