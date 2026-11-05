/**
 * admin-dental-write-pause.test.ts — the dental enrichment write-pause fence on
 * the admin-dental-* apply sweeps and the geocode worker.
 *
 * Follows dental-enrichment-write-pause.test.ts: in-memory dental DB
 * (DENTAL_DB_PATH=":memory:" + __resetDbFactoryForTesting), a pinned in-memory
 * MAIN db that holds the pause row, router.handle() with fake req/res.
 *
 * For each route: pause ON + apply/write -> 423 + standard body, zero dental DB
 * changes (total_changes()); pause ON + dry-run -> not fenced (200); pause OFF
 * + apply -> writes as before (control).
 *   - POST /admin/dental/wrong-entity-retro-sanitize  (write:true)
 *   - POST /admin/dental/schema-probe-sweep           (apply:true)
 *   - POST /admin/dental/hjemmeside-cleanup-sweep     (dry_run:false)
 *   - POST /admin/dental/offentlig-klinikk-...        (dry_run:false)
 *   - POST /admin/dental/brreg-address-sweep          (write:true, correct_mixed apply:true)
 *   - POST /admin/dental/hjemmeside-discovery-approve (apply:true)
 *   - geocodeTick() holds back under pause.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "POST",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: {},
      headers: opts.headers || {},
      body: opts.body,
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      set() {
        return this;
      },
      vary() {
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: { error: String(err ?? "no route") } });
    });
  });
}

export function runAdminDentalWritePauseTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  return (async () => {
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "admin-dental-write-pause-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/dental-store"),
      require.resolve("../services/dental-geocode-worker"),
      require.resolve("../services/dental-enrichment-write-pause"),
      require.resolve("./admin-dental-wrong-entity-retro-sanitize"),
      require.resolve("./admin-dental-schema-probe-sweep"),
      require.resolve("./admin-dental-hjemmeside-cleanup"),
      require.resolve("./admin-dental-offentlig-klinikk-hjemmeside-korrigering"),
      require.resolve("./admin-dental-brreg-address-sweep"),
      require.resolve("./admin-dental-hjemmeside-discovery"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const initMod = require("../database/init") as typeof import("../database/init");
    const restoreMainDb = initMod.__pinInMemoryDbForTesting();

    try {
      const svc = require("../services/enrichment-write-pause") as typeof import("../services/enrichment-write-pause");
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");
      const mainDb = initMod.getDb();
      const H = { "x-admin-key": testKey };
      const REASON = "verifier: >10% feil i stikkprøve (test)";

      const changes = () => (dentalDb.prepare(`SELECT total_changes() AS n FROM (SELECT 1)`).get() as { n: number }).n;
      const pauseOn = () => svc.setEnrichmentWritePause(mainDb, { vertical: "dental", enabled: true, reason: REASON }, "test");
      const pauseOff = () => svc.setEnrichmentWritePause(mainDb, { vertical: "dental", enabled: false, cleared_by: "daniel" }, "test");
      const rowOf = (id: string) => dentalDb.prepare(`SELECT * FROM dental_agents WHERE id = ?`).get(id);

      // ── Fixtures ──────────────────────────────────────────────────────
      const ins = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, naeringskode, om_oss, hjemmeside, enrichment_state, created_at)
         VALUES (@id, @navn, @naeringskode, @om_oss, @hjemmeside, @enrichment_state, @created_at)`,
      );
      const seed = (r: Record<string, unknown>) =>
        ins.run({ naeringskode: null, om_oss: null, hjemmeside: null, enrichment_state: "raw", created_at: "2026-01-01T00:00:00Z", ...r });
      // retro-sanitize candidate: enriched, non-dental NACE, no dental content signal
      seed({ id: "retro-1", navn: "KLINIKK FØRDE AS", naeringskode: "86.221", enrichment_state: "enriched",
        om_oss: "Klinikk Førde tilbyr Restylane, Profhilo, laser- og IPL-behandling, gynekologi og plastikkirurgi." });
      // hjemmeside-cleanup candidate: directory-aggregator hjemmeside
      seed({ id: "clean-1", navn: "Katalog Tannlege AS", hjemmeside: "https://legelisten.no/tannlege/oslo-sentrum" });
      // schema-probe contamination fingerprint (om_oss "test probe")
      seed({ id: "probe-1", navn: "Probe Tannlege AS", om_oss: "test probe" });
      // discovery-approve: blank hjemmeside + a pending queue row
      seed({ id: "disc-1", navn: "Discovery Tannlege AS" });

      const discMod = require("./admin-dental-hjemmeside-discovery") as typeof import("./admin-dental-hjemmeside-discovery");
      discMod.ensureDentalWebsiteReviewQueueTable(dentalDb);
      dentalDb
        .prepare(
          `INSERT INTO dental_website_review_queue (id, agent_id, agent_name, candidate_url, final_url, reason, status)
           VALUES ('q1', 'disc-1', 'Discovery Tannlege AS', 'https://discovery-tannlege.example.no', 'https://discovery-tannlege.example.no', 'brreg_field', 'pending')`,
        )
        .run();

      const retro = (require("./admin-dental-wrong-entity-retro-sanitize") as any).default;
      const probe = (require("./admin-dental-schema-probe-sweep") as any).default;
      const cleanup = (require("./admin-dental-hjemmeside-cleanup") as any).default;
      const korr = (require("./admin-dental-offentlig-klinikk-hjemmeside-korrigering") as any).default;
      const brreg = (require("./admin-dental-brreg-address-sweep") as any).default;
      const disc = discMod.default as any;

      // Any network use under the pause is a bug: the fence precedes it.
      let fetchCalls = 0;
      const countingFetch = (async () => {
        fetchCalls++;
        throw new Error("no network in test");
      }) as unknown as typeof fetch;
      (require("./admin-dental-brreg-address-sweep") as any).__setBrregAddressSweepFetchForTesting(countingFetch);

      const expect423 = (r: RouteResult, label: string) => {
        assertEq(r.status, svc.ENRICHMENT_WRITE_PAUSE_HTTP_STATUS, `${label}: 423`);
        assertEq(r.body?.paused, true, `${label}: paused:true`);
        assertEq(r.body?.vertical, "dental", `${label}: vertical dental`);
        assertEq(r.body?.reason, REASON, `${label}: carries stored reason`);
        assertEq(Object.keys(r.body ?? {}).sort(), ["error", "fail_closed", "paused", "reason", "triggered_at", "vertical"], `${label}: standard body shape`);
      };

      // ══ Pause ON: apply -> 423, nothing changes; dry-run -> not fenced ══
      pauseOn();
      const snapshot = JSON.stringify(dentalDb.prepare(`SELECT * FROM dental_agents ORDER BY id`).all());
      const queueSnapshot = JSON.stringify(dentalDb.prepare(`SELECT * FROM dental_website_review_queue`).all());
      {
        const c0 = changes();
        expect423(await callRoute(retro, { path: "/wrong-entity-retro-sanitize", headers: H, body: { write: true } }), "retro apply");
        expect423(await callRoute(probe, { path: "/", headers: H, body: { apply: true } }), "schema-probe apply");
        expect423(await callRoute(cleanup, { path: "/", headers: H, body: { dry_run: false } }), "cleanup apply");
        expect423(await callRoute(korr, { path: "/", headers: H, body: { dry_run: false } }), "korrigering apply");
        expect423(await callRoute(brreg, { path: "/brreg-address-sweep", headers: H, body: { write: true } }), "brreg sweep write");
        expect423(
          await callRoute(brreg, { path: "/brreg-address-sweep", headers: H, body: { mode: "correct_mixed", apply: true } }),
          "brreg correct_mixed apply",
        );
        expect423(
          await callRoute(disc, {
            path: "/hjemmeside-discovery-approve",
            headers: H,
            body: { apply: true, approvals: [{ agent_id: "disc-1", url: "https://discovery-tannlege.example.no" }] },
          }),
          "discovery-approve apply",
        );
        assertEq(changes() - c0, 0, "paused: zero dental DB changes across all apply attempts");
        assertEq(JSON.stringify(dentalDb.prepare(`SELECT * FROM dental_agents ORDER BY id`).all()), snapshot, "paused: dental_agents byte-identical");
        assertEq(JSON.stringify(dentalDb.prepare(`SELECT * FROM dental_website_review_queue`).all()), queueSnapshot, "paused: review queue unchanged");
        assertEq(fetchCalls, 0, "paused: no outbound call made before the fence");
      }
      {
        // Dry-run / read paths stay open under the pause.
        const c0 = changes();
        const a = await callRoute(retro, { path: "/wrong-entity-retro-sanitize", headers: H, body: {} });
        assertEq(a.status, 200, "retro dry-run under pause: 200");
        assertTrue((a.body?.data?.would_flag ?? 0) >= 1, "retro dry-run under pause: still plans");
        const b = await callRoute(probe, { path: "/", headers: H, body: {} });
        assertEq(b.status, 200, "schema-probe dry-run under pause: 200");
        assertTrue((b.body?.matched_count ?? 0) >= 1, "schema-probe dry-run under pause: still scans");
        const c = await callRoute(cleanup, { path: "/", headers: H, body: {} });
        assertEq(c.status, 200, "cleanup dry-run under pause: 200");
        assertTrue((c.body?.would_clean_count ?? 0) >= 1, "cleanup dry-run under pause: still classifies");
        const d = await callRoute(korr, { path: "/", headers: H, body: {} });
        assertEq(d.status, 200, "korrigering dry-run under pause: 200");
        const e = await callRoute(brreg, { path: "/brreg-address-sweep", headers: H, body: {} });
        assertEq(e.status, 200, "brreg sweep dry-run under pause: 200");
        const f = await callRoute(brreg, { path: "/brreg-address-sweep", headers: H, body: { mode: "correct_mixed" } });
        assertEq(f.status, 200, "brreg correct_mixed dry-run under pause: 200");
        const g = await callRoute(disc, {
          path: "/hjemmeside-discovery-approve",
          headers: H,
          body: { approvals: [{ agent_id: "disc-1", url: "https://discovery-tannlege.example.no" }] },
        });
        assertEq(g.status, 200, "discovery-approve dry-run under pause: 200");
        assertEq(g.body?.would_apply_count, 1, "discovery-approve dry-run under pause: would_apply 1");
        assertEq(changes() - c0, 0, "paused dry-runs: zero dental DB changes");
      }

      // ══ geocode worker: held back under pause ══════════════════════════
      {
        dentalDb
          .prepare(`UPDATE dental_agents SET adresse = 'Storgata 1', postnummer = '0151', poststed = 'OSLO' WHERE id = 'disc-1'`)
          .run();
        const worker = require("../services/dental-geocode-worker") as typeof import("../services/dental-geocode-worker");
        let geoCalls = 0;
        const geoFetch = (async () => {
          geoCalls++;
          return { ok: true, status: 200, json: async () => ({ adresser: [{ representasjonspunkt: { lat: 59.9, lon: 10.7 } }] }) };
        }) as unknown as typeof fetch;
        const noSleep = async () => {};
        const c0 = changes();
        const held = await worker.geocodeTick(50, { fetchImpl: geoFetch, sleep: noSleep });
        assertEq(held.paused, true, "geocode: tick reports paused");
        assertEq(held.processed, 0, "geocode: nothing processed under pause");
        assertEq(geoCalls, 0, "geocode: no Kartverket call under pause");
        assertEq(changes() - c0, 0, "geocode: zero dental DB changes under pause");
        assertEq((rowOf("disc-1") as any).lat, null, "geocode: row still ungeocoded");

        pauseOff();
        const ran = await worker.geocodeTick(50, { fetchImpl: geoFetch, sleep: noSleep });
        assertTrue(!ran.paused, "geocode: pause off -> not paused");
        assertTrue(ran.processed >= 1 && geoCalls >= 1, "geocode: pause off -> processes as before");
        assertEq((rowOf("disc-1") as any).geocode_confidence, "high", "geocode: pause off -> row geocoded");
        pauseOn();
      }

      // ══ Pause OFF: control — same apply calls write as before ══════════
      pauseOff();
      {
        const r1 = await callRoute(retro, { path: "/wrong-entity-retro-sanitize", headers: H, body: { write: true } });
        assertEq(r1.status, 200, "off: retro apply 200");
        assertTrue((r1.body?.data?.written ?? 0) >= 1, "off: retro apply wrote");
        const r2 = await callRoute(probe, { path: "/", headers: H, body: { apply: true } });
        assertEq(r2.status, 200, "off: schema-probe apply 200");
        assertTrue((r2.body?.repaired_count ?? 0) >= 1, "off: schema-probe apply repaired");
        const r3 = await callRoute(cleanup, { path: "/", headers: H, body: { dry_run: false } });
        assertEq(r3.status, 200, "off: cleanup apply 200");
        assertTrue((r3.body?.cleaned_count ?? 0) >= 1, "off: cleanup apply cleaned");
        const r4 = await callRoute(korr, { path: "/", headers: H, body: { dry_run: false } });
        assertEq(r4.status, 200, "off: korrigering apply 200");
        const r5 = await callRoute(brreg, { path: "/brreg-address-sweep", headers: H, body: { write: true } });
        assertEq(r5.status, 200, "off: brreg sweep write 200");
        const r6 = await callRoute(brreg, { path: "/brreg-address-sweep", headers: H, body: { mode: "correct_mixed", apply: true } });
        assertEq(r6.status, 200, "off: brreg correct_mixed apply 200");
        const r7 = await callRoute(disc, {
          path: "/hjemmeside-discovery-approve",
          headers: H,
          body: { apply: true, approvals: [{ agent_id: "disc-1", url: "https://discovery-tannlege.example.no" }] },
        });
        assertEq(r7.status, 200, "off: discovery-approve apply 200");
        assertEq(r7.body?.applied_count, 1, "off: discovery-approve applied 1");
        assertEq((rowOf("disc-1") as any).hjemmeside, "https://discovery-tannlege.example.no", "off: discovery-approve wrote hjemmeside");
      }

      // ══ FAIL-CLOSED: pause table missing -> apply 423 fail_closed ══════
      mainDb.exec(`DROP TABLE enrichment_write_pause`);
      {
        const c0 = changes();
        const r = await callRoute(cleanup, { path: "/", headers: H, body: { dry_run: false } });
        assertEq(r.status, 423, "fail-closed: cleanup apply 423");
        assertEq(r.body?.fail_closed, true, "fail-closed: fail_closed:true");
        const d = await callRoute(cleanup, { path: "/", headers: H, body: {} });
        assertEq(d.status, 200, "fail-closed: dry-run still 200");
        assertEq(changes() - c0, 0, "fail-closed: zero changes");
      }
    } catch (err: any) {
      failed++;
      failures.push("admin-dental-write-pause: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      restoreMainDb();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort cleanup */ }
      restoreModuleCache();
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
      else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey !== undefined) process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-dental-write-pause.test.ts`
if (require.main === module) {
  runAdminDentalWritePauseTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
