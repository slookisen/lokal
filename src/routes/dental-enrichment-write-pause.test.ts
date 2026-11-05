/**
 * dental-enrichment-write-pause.test.ts — the enrichment write-pause fence on
 * the dental router (src/routes/dental.ts).
 *
 * A2A dev-request 2026-10-27-dental-skrivepause-gjerde-mangler-paa-tannlege-put
 * (P0): the `dental` enrichment_write_pause was enforced only by the SKILL's
 * prose check, and a run on 2026-10-27 got 57 field PUTs through
 * PUT /api/tannlege/agents/:id while the pause was on. This proves the fence:
 *
 *   (a) pause OFF -> PUT /agents/:id writes as before (200, updated:true).
 *   (b) pause ON  -> PUT /agents/:id (field PUT and the "mark enriched" PUT)
 *       answers 423 + the standard block body; the row is byte-identical and
 *       the dental DB saw zero changes (total_changes()).
 *   (c) a pause on ANOTHER vertical (rfb) does not block dental writes.
 *   (d) POST /admin/claim-batch under pause -> 200 empty batch (count 0,
 *       claimed []) carrying the pause reason; no row gets a worker_id.
 *       Pause off -> it claims as before.
 *   (e) POST /admin/stage-v-drift-result under pause -> 423, row unchanged.
 *   (f) POST /admin/google-places-batch (write mode) under pause -> 423 before
 *       any Places call; dry run (write:false) is not fenced.
 *   (g) left open on purpose: release-batch, homepage-fetch-result.
 *   (h) FAIL-CLOSED: the pause table missing -> PUT 423 fail_closed:true and
 *       claim-batch empty with fail_closed:true; a getDb() accessor that
 *       throws -> PUT 423 fail_closed:true, never a 500.
 *
 * Setup mirrors dental-agent-put-field-provenance.test.ts (in-memory dental DB
 * via DENTAL_DB_PATH=":memory:" + __resetDbFactoryForTesting, fresh require
 * of the router, router.handle() with fake req/res) plus a pinned in-memory
 * MAIN db (__pinInMemoryDbForTesting) — the pause row lives on the main DB,
 * not on dental.db.
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
      method: opts.method || "GET",
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

export function runDentalEnrichmentWritePauseTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
    const testKey = process.env.ADMIN_KEY || "dental-write-pause-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./dental"),
      require.resolve("../services/dental-store"),
      require.resolve("../services/dental-claim-service"),
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
      const router = (require("./dental") as { default: any }).default;
      const H = { "x-admin-key": testKey };

      const insert = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, enrichment_state, helfo_agreement)
         VALUES (@id, @navn, @hjemmeside, @telefon, @enrichment_state, @helfo_agreement)`,
      );
      for (const id of ["wp-a", "wp-b", "wp-c"]) {
        insert.run({
          id,
          navn: `Skrivepause ${id} Tannlege AS`,
          hjemmeside: `https://${id}.example.no`,
          telefon: "22334455",
          enrichment_state: "raw",
          helfo_agreement: "unknown",
        });
      }
      const rowOf = (id: string) => dentalDb.prepare(`SELECT * FROM dental_agents WHERE id = ?`).get(id);
      const changes = () => (dentalDb.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
      const pauseOn = (vertical: "dental" | "rfb", reason: string) =>
        svc.setEnrichmentWritePause(mainDb, { vertical, enabled: true, reason }, "test");
      const pauseOff = (vertical: "dental" | "rfb") =>
        svc.setEnrichmentWritePause(mainDb, { vertical, enabled: false, cleared_by: "daniel" }, "test");
      const REASON = "verifier: >10% feil i stikkprøve (test)";

      // ══ (a) pause OFF -> PUT writes as before ══════════════════════════
      {
        const r = await callRoute(router, { method: "PUT", path: "/agents/wp-a", headers: H, body: { om_oss: "Vi er en klinikk." } });
        assertEq(r.status, 200, "a1: pause off -> PUT /agents/:id 200");
        assertEq(r.body, { id: "wp-a", updated: true, fields_updated: ["om_oss"] }, "a2: pause off -> unchanged response body");
        assertEq((rowOf("wp-a") as any).om_oss, "Vi er en klinikk.", "a3: pause off -> field written");
      }

      // ══ (b) pause ON -> PUT 423, nothing changes ═══════════════════════
      pauseOn("dental", REASON);
      {
        const before = JSON.stringify(rowOf("wp-b"));
        const c0 = changes();
        const r = await callRoute(router, { method: "PUT", path: "/agents/wp-b", headers: H, body: { om_oss: "Skal ikke skrives." } });
        assertEq(r.status, svc.ENRICHMENT_WRITE_PAUSE_HTTP_STATUS, "b1: pause on -> PUT /agents/:id 423");
        assertEq(r.body?.paused, true, "b2: block body paused:true");
        assertEq(r.body?.vertical, "dental", "b3: block body vertical dental");
        assertEq(r.body?.reason, REASON, "b4: block body carries the stored reason");
        assertEq(r.body?.fail_closed, false, "b5: block body fail_closed:false for a real pause");
        assertEq(Object.keys(r.body ?? {}).sort(), ["error", "fail_closed", "paused", "reason", "triggered_at", "vertical"], "b6: standard block body shape");

        const r2 = await callRoute(router, {
          method: "PUT",
          path: "/agents/wp-b",
          headers: H,
          body: { enrichment_state: "enriched", telefon: "99887766", field_provenance: { phone: [{ source_type: "homepage", value: "99887766" }] } },
        });
        assertEq(r2.status, 423, "b7: pause on -> 'mark enriched' PUT 423");
        assertEq(JSON.stringify(rowOf("wp-b")), before, "b8: row byte-identical after both rejected PUTs");
        assertEq(changes() - c0, 0, "b9: zero dental DB changes while paused");
      }

      // ══ (c) a pause on another vertical does not block dental ══════════
      pauseOff("dental");
      pauseOn("rfb", "rfb-only pause");
      {
        const r = await callRoute(router, { method: "PUT", path: "/agents/wp-c", headers: H, body: { om_oss: "Dental er ikke pauset." } });
        assertEq(r.status, 200, "c1: rfb pause only -> dental PUT allowed");
      }
      pauseOff("rfb");
      pauseOn("dental", REASON);

      // ══ (d) claim-batch under pause -> empty batch with reason ═════════
      {
        const c0 = changes();
        const r = await callRoute(router, {
          method: "POST",
          path: "/admin/claim-batch",
          headers: H,
          body: { worker_id: "w-test", size: 10, filter: {} },
        });
        assertEq(r.status, 200, "d1: claim-batch under pause -> 200 (empty batch, worker branches on .count)");
        assertEq(r.body?.count, 0, "d2: count 0");
        assertEq(r.body?.claimed, [], "d3: claimed []");
        assertEq(r.body?.paused, true, "d4: paused:true");
        assertEq(r.body?.enrichment_write_pause?.reason, REASON, "d5: says why (pause reason)");
        assertEq(r.body?.enrichment_write_pause?.vertical, "dental", "d6: pause body names dental");
        const claimedRows = (dentalDb.prepare(`SELECT COUNT(*) AS n FROM dental_agents WHERE worker_id IS NOT NULL`).get() as { n: number }).n;
        assertEq(claimedRows, 0, "d7: no row claimed");
        assertEq(changes() - c0, 0, "d8: zero dental DB changes");
      }
      pauseOff("dental");
      {
        const r = await callRoute(router, {
          method: "POST",
          path: "/admin/claim-batch",
          headers: H,
          body: { worker_id: "w-test", size: 10, filter: {} },
        });
        assertEq(r.status, 200, "d9: pause off -> claim-batch 200");
        assertTrue((r.body?.count ?? 0) >= 1, "d10: pause off -> rows claimed as before");
        assertTrue(!("paused" in (r.body ?? {})), "d11: pause off -> response has no pause fields");
        // release so later steps start clean
        const rel = await callRoute(router, {
          method: "POST",
          path: "/admin/release-batch",
          headers: H,
          body: { worker_id: "w-test", ids: (r.body?.claimed ?? []).map((x: any) => x.id) },
        });
        assertEq(rel.status, 200, "d12: release-batch 200");
      }

      // ══ (g) left open: release-batch + homepage-fetch-result under pause ═
      pauseOn("dental", REASON);
      {
        dentalDb.prepare(`UPDATE dental_agents SET worker_id = 'w-stuck', claimed_at = ? WHERE id = 'wp-c'`).run(Date.now());
        const rel = await callRoute(router, {
          method: "POST",
          path: "/admin/release-batch",
          headers: H,
          body: { worker_id: "w-stuck", ids: ["wp-c"] },
        });
        assertEq(rel.status, 200, "g1: release-batch stays allowed under pause");
        assertEq(rel.body?.released, 1, "g2: claim released, nothing stranded");
        const hf = await callRoute(router, {
          method: "POST",
          path: "/admin/homepage-fetch-result",
          headers: H,
          body: { agentId: "wp-c", ok: false },
        });
        assertEq(hf.status, 200, "g3: homepage-fetch-result (bookkeeping) stays allowed under pause");
      }

      // ══ (e) stage-v-drift-result under pause -> 423 ════════════════════
      {
        const before = JSON.stringify(rowOf("wp-b"));
        const c0 = changes();
        const r = await callRoute(router, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: H,
          body: { agentId: "wp-b", field: "helfo_agreement", value: "true" },
        });
        assertEq(r.status, 423, "e1: stage-v-drift-result under pause -> 423");
        assertEq(r.body?.vertical, "dental", "e2: block body vertical dental");
        assertEq(JSON.stringify(rowOf("wp-b")), before, "e3: row unchanged");
        assertEq(changes() - c0, 0, "e4: zero dental DB changes");
      }

      // ══ (f) google-places-batch (write) under pause -> 423 ═════════════
      {
        process.env.GOOGLE_PLACES_API_KEY = "test-not-a-real-key";
        const origFetch = (globalThis as any).fetch;
        let fetchCalls = 0;
        (globalThis as any).fetch = async () => {
          fetchCalls++;
          throw new Error("no network in test");
        };
        try {
          const c0 = changes();
          const r = await callRoute(router, {
            method: "POST",
            path: "/admin/google-places-batch",
            headers: H,
            body: { agentIds: ["wp-b"] },
          });
          assertEq(r.status, 423, "f1: google-places-batch (write) under pause -> 423");
          assertEq(fetchCalls, 0, "f2: no Places call made");
          assertEq(changes() - c0, 0, "f3: zero dental DB changes");
          const dry = await callRoute(router, {
            method: "POST",
            path: "/admin/google-places-batch",
            headers: H,
            body: { agentIds: ["wp-b"], write: false },
          });
          assertTrue(dry.status !== 423, "f4: dry run (write:false) is not fenced");
        } finally {
          (globalThis as any).fetch = origFetch;
        }
      }

      // ══ (h) FAIL-CLOSED ════════════════════════════════════════════════
      pauseOff("dental");
      mainDb.exec(`DROP TABLE enrichment_write_pause`);
      {
        const before = JSON.stringify(rowOf("wp-b"));
        const r = await callRoute(router, { method: "PUT", path: "/agents/wp-b", headers: H, body: { om_oss: "Skal ikke skrives." } });
        assertEq(r.status, 423, "h1: pause table missing -> PUT 423 (fail closed)");
        assertEq(r.body?.fail_closed, true, "h2: fail_closed:true");
        assertEq(r.body?.reason, svc.ENRICHMENT_WRITE_PAUSE_LOOKUP_FAILED_REASON, "h3: lookup-failed reason");
        assertEq(JSON.stringify(rowOf("wp-b")), before, "h4: row unchanged");
        const cb = await callRoute(router, {
          method: "POST",
          path: "/admin/claim-batch",
          headers: H,
          body: { worker_id: "w-test", size: 10, filter: {} },
        });
        assertEq([cb.status, cb.body?.count, cb.body?.enrichment_write_pause?.fail_closed], [200, 0, true], "h5: pause table missing -> claim-batch empty, fail_closed:true");
      }
      initMod.__setDbAccessorFailureForTesting(new Error("simulated: getDb() unavailable"));
      try {
        const r = await callRoute(router, { method: "PUT", path: "/agents/wp-b", headers: H, body: { om_oss: "Skal ikke skrives." } });
        assertEq([r.status, r.body?.fail_closed], [423, true], "h6: throwing getDb() accessor -> 423 fail_closed, never 500");
      } finally {
        initMod.__setDbAccessorFailureForTesting(null);
      }
    } catch (err: any) {
      failed++;
      failures.push("dental-enrichment-write-pause: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      try { initMod.__setDbAccessorFailureForTesting(null); } catch { /* best-effort */ }
      restoreMainDb();
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      if (prevPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = prevPlacesKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/dental-enrichment-write-pause.test.ts`
if (require.main === module) {
  runDentalEnrichmentWritePauseTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
