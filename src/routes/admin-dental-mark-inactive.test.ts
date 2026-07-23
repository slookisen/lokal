/**
 * admin-dental-mark-inactive.test.ts — unit tests for
 * POST /admin/dental/mark-inactive (src/routes/admin-dental-mark-inactive.ts),
 * dev-request 2026-07-16-dental-hjemmeside-url-vask, item 2 (nedlagt-flagging).
 *
 * Setup mirrors admin-dental-hjemmeside-cleanup.test.ts: fresh in-memory
 * dental DB via DENTAL_DB_PATH=":memory:" + db-factory
 * __resetDbFactoryForTesting() (so initDentalSchema runs the real
 * production dental schema, including the new is_inactive/inactive_reason/
 * inactive_since columns), fresh require of the route module per run,
 * exercised via router.handle() directly (X-Admin-Key passed via headers).
 *
 * Covers (per the build spec):
 *   (a) admin-gate: missing / wrong X-Admin-Key -> 403
 *   (b) dry-run reports would_mark, makes ZERO writes
 *   (c) apply sets is_inactive=1, inactive_reason, inactive_since, and
 *       preserves pre-existing unrelated field_provenance keys
 *   (d) repeat apply on an already-inactive row reports already_inactive and
 *       does NOT change the original inactive_reason/inactive_since
 *   (e) unknown id reports not_found
 *   (f) validation: entries must be a non-empty array; each entry needs a
 *       non-empty string id + reason -> 400
 *   (g) more than 100 entries -> 400
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
  opts: { method?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: "/",
      originalUrl: "/",
      path: "/",
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runAdminDentalMarkInactiveTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const testKey = "dental-mark-inactive-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const routePath = require.resolve("./admin-dental-mark-inactive");
    const cachePaths = [dbFactoryPath, routePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const routeMod = require("./admin-dental-mark-inactive") as
        typeof import("./admin-dental-mark-inactive");
      const router = routeMod.default as any;

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, field_provenance, created_at)
         VALUES (@id, @navn, @field_provenance, @created_at)`,
      );

      // (1) A normal active clinic — candidate for marking.
      insertAgent.run({
        id: "clinic-active", navn: "Aktiv Tannlege AS",
        field_provenance: JSON.stringify({ phone: { source_url: "https://aktiv-tannlege.no", value: "12345678" } }),
        created_at: "2026-01-01T00:00:00.000Z",
      });
      // (2) Another normal active clinic, no existing field_provenance.
      insertAgent.run({
        id: "clinic-active-2", navn: "Aktiv Tannlege 2 AS",
        field_provenance: null,
        created_at: "2026-01-02T00:00:00.000Z",
      });
      // (3) Already-inactive clinic — repeat calls must be a no-op.
      insertAgent.run({
        id: "clinic-already-inactive", navn: "Nedlagt Tannlege AS",
        field_provenance: null,
        created_at: "2026-01-03T00:00:00.000Z",
      });
      dentalDb.prepare(
        `UPDATE dental_agents SET is_inactive = 1, inactive_reason = ?, inactive_since = ? WHERE id = ?`,
      ).run("Stengt av fylkeskommunen 2025", "2025-12-01T00:00:00.000Z", "clinic-already-inactive");

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", headers, body });
      }

      // ── (a) admin gate ──────────────────────────────────────────────────
      let r = await post({ entries: [{ id: "clinic-active", reason: "test" }] }, false);
      assertEq(r.status, 403, "a1: missing X-Admin-Key -> 403");
      r = await post({ entries: [{ id: "clinic-active", reason: "test" }] }, "wrong-key");
      assertEq(r.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (f) validation ───────────────────────────────────────────────────
      r = await post({});
      assertEq(r.status, 400, "f1: missing entries -> 400");
      r = await post({ entries: [] });
      assertEq(r.status, 400, "f2: empty entries array -> 400");
      r = await post({ entries: "not-an-array" });
      assertEq(r.status, 400, "f3: non-array entries -> 400");
      r = await post({ entries: [{ id: "", reason: "test" }] });
      assertEq(r.status, 400, "f4: empty id -> 400");
      r = await post({ entries: [{ id: "clinic-active", reason: "" }] });
      assertEq(r.status, 400, "f5: empty reason -> 400");
      r = await post({ entries: [{ id: "clinic-active" }] });
      assertEq(r.status, 400, "f6: missing reason -> 400");
      r = await post({ entries: [{ reason: "test" }] });
      assertEq(r.status, 400, "f7: missing id -> 400");

      // ── (g) batch cap ─────────────────────────────────────────────────────
      const cap = routeMod.MARK_INACTIVE_ENTRIES_CAP;
      assertEq(cap, 100, "g0: MARK_INACTIVE_ENTRIES_CAP is 100");
      const tooMany = Array.from({ length: cap + 1 }, (_, i) => ({ id: `bulk-${i}`, reason: "test" }));
      r = await post({ entries: tooMany });
      assertEq(r.status, 400, "g1: more than 100 entries -> 400");
      const exactlyCap = Array.from({ length: cap }, (_, i) => ({ id: `bulk-${i}`, reason: "test" }));
      r = await post({ entries: exactlyCap });
      assertEq(r.status, 200, "g2: exactly 100 entries is accepted (200)");
      assertEq(r.body.requested, cap, "g3: requested echoes entries.length for exactly-cap batch");

      // ── (b) dry-run: reports would_mark, zero writes ────────────────────
      const dryDefault = await post({ entries: [{ id: "clinic-active", reason: "Stengt, verifisert via fylkeskommunen" }] });
      assertEq(dryDefault.status, 200, "b1: dry-run (default) -> 200");
      assertEq(dryDefault.body.dry_run, true, "b2: dry_run:true echoed back by default");
      assertEq(dryDefault.body.requested, 1, "b3: requested = 1");
      assertEq(dryDefault.body.results.length, 1, "b4: one result per input entry");
      assertEq(dryDefault.body.results[0].status, "would_mark", "b5: dry-run reports would_mark");
      assertEq(dryDefault.body.results[0].navn, "Aktiv Tannlege AS", "b6: would_mark result includes navn");
      assertEq(dryDefault.body.results[0].reason, "Stengt, verifisert via fylkeskommunen", "b7: would_mark result echoes reason");
      {
        const row = dentalDb.prepare("SELECT is_inactive, inactive_reason, inactive_since FROM dental_agents WHERE id = ?").get("clinic-active") as any;
        assertEq(row.is_inactive, 0, "b8: dry-run never sets is_inactive");
        assertEq(row.inactive_reason, null, "b9: dry-run never sets inactive_reason");
        assertEq(row.inactive_since, null, "b10: dry-run never sets inactive_since");
      }
      // dry_run:"false" (string, not the JSON boolean) must STILL be dry-run.
      const dryStringFalse = await post({ dry_run: "false", entries: [{ id: "clinic-active", reason: "test" }] });
      assertEq(dryStringFalse.body.dry_run, true, 'b11: dry_run:"false" (string) is still dry-run (STRICT-FALSE parse)');

      // ── (c) apply: sets is_inactive/reason/since, preserves field_provenance ──
      const applied = await post({ dry_run: false, entries: [{ id: "clinic-active", reason: "Stengt, verifisert via fylkeskommunen" }] });
      assertEq(applied.status, 200, "c1: apply -> 200");
      assertEq(applied.body.dry_run, false, "c2: dry_run:false echoed back");
      assertEq(applied.body.results[0].status, "marked_inactive", "c3: apply reports marked_inactive");
      assertEq(applied.body.results[0].navn, "Aktiv Tannlege AS", "c4: marked_inactive result includes navn");
      assertEq(applied.body.results[0].reason, "Stengt, verifisert via fylkeskommunen", "c5: marked_inactive result echoes reason");
      {
        const row = dentalDb.prepare("SELECT is_inactive, inactive_reason, inactive_since, field_provenance FROM dental_agents WHERE id = ?").get("clinic-active") as any;
        assertEq(row.is_inactive, 1, "c6: is_inactive set to 1");
        assertEq(row.inactive_reason, "Stengt, verifisert via fylkeskommunen", "c7: inactive_reason set");
        assertTrue(typeof row.inactive_since === "string" && row.inactive_since.length > 0, "c8: inactive_since set to an ISO string");
        const prov = JSON.parse(row.field_provenance);
        assertTrue(!!prov.phone, "c9: pre-existing 'phone' provenance survives the merge");
        assertEq(prov.phone.value, "12345678", "c10: pre-existing 'phone' provenance value untouched");
        assertTrue(!!prov.inactive, "c11: new 'inactive' provenance entry present");
        assertEq(prov.inactive.reason, "Stengt, verifisert via fylkeskommunen", "c12: inactive provenance records the reason");
        assertTrue(typeof prov.inactive.marked_inactive_at === "string" && prov.inactive.marked_inactive_at.length > 0, "c13: inactive provenance records marked_inactive_at");
      }

      // NULL starting field_provenance still produces a valid merged blob.
      const appliedNoProv = await post({ dry_run: false, entries: [{ id: "clinic-active-2", reason: "Konkurs" }] });
      assertEq(appliedNoProv.body.results[0].status, "marked_inactive", "c14: apply on a row with NULL field_provenance still marks inactive");
      {
        const row = dentalDb.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get("clinic-active-2") as any;
        const prov = JSON.parse(row.field_provenance);
        assertTrue(!!prov.inactive, "c15: NULL starting field_provenance still produces a valid merged blob");
      }

      // ── (d) repeat apply on an already-inactive row is idempotent ────────
      const repeatOnSeeded = await post({ dry_run: false, entries: [{ id: "clinic-already-inactive", reason: "different reason attempt" }] });
      assertEq(repeatOnSeeded.body.results[0].status, "already_inactive", "d1: repeat apply on already-inactive row reports already_inactive");
      assertEq(repeatOnSeeded.body.results[0].inactive_reason, "Stengt av fylkeskommunen 2025", "d2: original inactive_reason echoed, not overwritten");
      assertEq(repeatOnSeeded.body.results[0].inactive_since, "2025-12-01T00:00:00.000Z", "d3: original inactive_since echoed, not overwritten");
      {
        const row = dentalDb.prepare("SELECT inactive_reason, inactive_since FROM dental_agents WHERE id = ?").get("clinic-already-inactive") as any;
        assertEq(row.inactive_reason, "Stengt av fylkeskommunen 2025", "d4: DB inactive_reason unchanged after repeat apply");
        assertEq(row.inactive_since, "2025-12-01T00:00:00.000Z", "d5: DB inactive_since unchanged after repeat apply");
      }
      // Repeat apply on the row this test-run itself just marked (clinic-active) is also idempotent.
      const repeatOnJustMarked = await post({ dry_run: false, entries: [{ id: "clinic-active", reason: "another attempt" }] });
      assertEq(repeatOnJustMarked.body.results[0].status, "already_inactive", "d6: repeat apply on a row marked earlier THIS run also reports already_inactive");
      {
        const row = dentalDb.prepare("SELECT inactive_reason FROM dental_agents WHERE id = ?").get("clinic-active") as any;
        assertEq(row.inactive_reason, "Stengt, verifisert via fylkeskommunen", "d7: original reason from the first apply is preserved, not overwritten by the second attempt's different reason text");
      }
      // Dry-run against an already-inactive row also reports already_inactive (not would_mark).
      const dryOnAlreadyInactive = await post({ entries: [{ id: "clinic-already-inactive", reason: "test" }] });
      assertEq(dryOnAlreadyInactive.body.results[0].status, "already_inactive", "d8: dry-run against an already-inactive row reports already_inactive, not would_mark");

      // ── (e) unknown id ────────────────────────────────────────────────────
      const unknownResult = await post({ entries: [{ id: "does-not-exist", reason: "test" }] });
      assertEq(unknownResult.body.results[0].status, "not_found", "e1: unknown id reports not_found");
      const unknownApply = await post({ dry_run: false, entries: [{ id: "does-not-exist", reason: "test" }] });
      assertEq(unknownApply.body.results[0].status, "not_found", "e2: unknown id reports not_found on apply too (no throw)");

      // ── mixed batch: multiple entries in input order, one result each ─────
      insertAgent.run({
        id: "clinic-mixed-active", navn: "Mixed Tannlege AS",
        field_provenance: null,
        created_at: "2026-01-10T00:00:00.000Z",
      });
      const mixed = await post({
        dry_run: false,
        entries: [
          { id: "clinic-mixed-active", reason: "Nedlagt" },
          { id: "does-not-exist-2", reason: "test" },
          { id: "clinic-already-inactive", reason: "test" },
        ],
      });
      assertEq(mixed.body.requested, 3, "h1: requested = 3 for mixed batch");
      assertEq(mixed.body.results.length, 3, "h2: 3 results for mixed batch");
      assertEq(mixed.body.results[0].id, "clinic-mixed-active", "h3: result order matches input order (1st)");
      assertEq(mixed.body.results[0].status, "marked_inactive", "h4: 1st entry marked_inactive");
      assertEq(mixed.body.results[1].id, "does-not-exist-2", "h5: result order matches input order (2nd)");
      assertEq(mixed.body.results[1].status, "not_found", "h6: 2nd entry not_found");
      assertEq(mixed.body.results[2].id, "clinic-already-inactive", "h7: result order matches input order (3rd)");
      assertEq(mixed.body.results[2].status, "already_inactive", "h8: 3rd entry already_inactive");
    } catch (err: any) {
      failed++;
      failures.push("admin-dental-mark-inactive: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-dental-mark-inactive.test.ts`
if (require.main === module) {
  runAdminDentalMarkInactiveTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
