/**
 * opplevelser-gardssalg-content-audit-read.test.ts — tests for the read-only
 * GET /admin/gardssalg-content-audit (src/routes/opplevelser.ts): lists
 * gardssalg_content_audit rows for one producer after a point in time so an
 * operator can see which fields were changed by which source before a manual
 * rollback decision.
 *
 * Covers: admin guard, provider_id/since validation, the since filter over
 * BOTH stored changed_at formats (SQLite `YYYY-MM-DD HH:MM:SS` and ISO
 * `...T...Z`) incl. boundary inclusion, field filter, other-provider
 * isolation, limit + truncated, by_changed_by counts, ordering across mixed
 * formats, and that the endpoint never changes the table.
 *
 * Same conventions as the sibling gårdssalg route test files: :memory: DB,
 * fresh requires, router.handle().
 *
 * Wired into the gate: tests/test.ts imports
 * runOpplevelserGardssalgContentAuditReadTests() and folds its pass/fail
 * counts into the `npm test` summary.
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

function callGet(
  router: any,
  query: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(query).toString();
    const url = "/admin/gardssalg-content-audit" + (qs ? `?${qs}` : "");
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: "/admin/gardssalg-content-audit",
      query,
      headers,
      body: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
      else resolve({ status: 404, body: { error: "not_handled" } });
    });
  });
}

export function runOpplevelserGardssalgContentAuditReadTests(log = false): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${e}, got ${a})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-content-audit-read-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache"))
      .swapOutModules([dbFactoryPath, experienceStorePath, opplevelserPath]);

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const admin = { "x-admin-key": testKey };

      // ═══ Fixtures ═══════════════════════════════════════════════════════
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, products, producer_type, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', '["x"]', 'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({ id: "ca-p1", navn: "Revisjon Gard" });
      insertProvider.run({ id: "ca-p2", navn: "Annen Gard" });

      const insertAudit = expDb.prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at, notes)
         VALUES (@id, @provider_id, @field_name, @old_value, @new_value, @source_url, @batch_id, @changed_by, @changed_at, @notes)`,
      );
      const A = (o: Record<string, unknown>) => insertAudit.run({
        provider_id: "ca-p1", old_value: null, new_value: null, source_url: null, batch_id: null, notes: null, ...o,
      });
      // Inserted deliberately out of chronological order, mixed formats.
      A({ id: "a-iso-12", field_name: "beskrivelse", old_value: "gammel", new_value: "ny",
          source_url: "https://revisjon.example.no/", batch_id: "b2", changed_by: "content-refresh",
          changed_at: "2026-11-01T12:00:00.000Z", notes: "auto" });
      A({ id: "a-sql-10", field_name: "telefon", old_value: "1", new_value: "2",
          changed_by: "admin", changed_at: "2026-11-01 10:00:00" });
      A({ id: "a-sql-09", field_name: "beskrivelse", changed_by: "content-refresh", changed_at: "2026-11-01 09:59:59" });
      A({ id: "a-iso-0930", field_name: "epost", changed_by: "owner", changed_at: "2026-11-01T09:30:00Z" });
      A({ id: "a-sql-old", field_name: "telefon", changed_by: "system", changed_at: "2026-10-01 08:00:00" });
      A({ id: "a-iso-13", field_name: "telefon", changed_by: "admin", changed_at: "2026-11-01T13:00:00.000Z" });
      // Other provider — same timestamps, must never leak into ca-p1.
      A({ id: "b-1", provider_id: "ca-p2", field_name: "telefon", changed_by: "admin", changed_at: "2026-11-01 11:00:00" });
      A({ id: "b-2", provider_id: "ca-p2", field_name: "beskrivelse", changed_by: "content-refresh", changed_at: "2026-11-01T12:30:00Z" });

      const countRows = (): number =>
        (expDb.prepare("SELECT COUNT(*) AS n FROM gardssalg_content_audit").get() as { n: number }).n;
      const rowCountBefore = countRows();

      // ── Admin guard ──
      const noKey = await callGet(router, { provider_id: "ca-p1" });
      assertEq(noKey.status, 403, "ca-1: no X-Admin-Key → 403");
      const badKey = await callGet(router, { provider_id: "ca-p1" }, { "x-admin-key": "wrong" });
      assertEq(badKey.status, 403, "ca-2: wrong X-Admin-Key → 403");
      assertTrue(!Array.isArray(noKey.body?.rows), "ca-3: no rows leaked without admin key");

      // ── Validation ──
      const missing = await callGet(router, {}, admin);
      assertEq(missing.status, 400, "ca-4: missing provider_id → 400");
      assertTrue(typeof missing.body?.error === "string", "ca-5: 400 body carries { error }");
      const blank = await callGet(router, { provider_id: "   " }, admin);
      assertEq(blank.status, 400, "ca-6: blank provider_id → 400");
      const tooLong = await callGet(router, { provider_id: "x".repeat(201) }, admin);
      assertEq(tooLong.status, 400, "ca-7: provider_id > 200 chars → 400");
      const badSince = await callGet(router, { provider_id: "ca-p1", since: "not-a-date" }, admin);
      assertEq(badSince.status, 400, "ca-8: unparseable since → 400");
      assertTrue(typeof badSince.body?.error === "string", "ca-9: bad-since body carries { error }");

      // ── No since: all rows for provider, chronological across formats ──
      const all = await callGet(router, { provider_id: "ca-p1" }, admin);
      assertEq(all.status, 200, "ca-10: valid request → 200");
      assertEq(all.body.provider_id, "ca-p1", "ca-11: provider_id echoed");
      assertEq(all.body.since, null, "ca-12: since null when omitted");
      assertEq((all.body.rows as any[]).map((r) => r.id),
        ["a-sql-old", "a-iso-0930", "a-sql-09", "a-sql-10", "a-iso-12", "a-iso-13"],
        "ca-13: rows ordered by real time across mixed stored formats; other provider excluded");
      assertEq(all.body.count, 6, "ca-14: count = returned rows");
      assertEq(all.body.truncated, false, "ca-15: not truncated under default limit");
      assertEq(all.body.by_changed_by, { system: 1, owner: 1, "content-refresh": 2, admin: 2 },
        "ca-16: by_changed_by counts the returned rows");
      const first = (all.body.rows as any[]).find((r) => r.id === "a-iso-12");
      assertEq(first, {
        id: "a-iso-12", field_name: "beskrivelse", old_value: "gammel", new_value: "ny",
        source_url: "https://revisjon.example.no/", batch_id: "b2", changed_by: "content-refresh",
        changed_at: "2026-11-01T12:00:00.000Z", notes: "auto",
      }, "ca-17: row shape carries every documented field, stored changed_at unchanged");
      assertTrue(!(all.body.rows as any[]).some((r) => "provider_id" in r), "ca-18: rows do not repeat provider_id");

      // ── since boundary: exactly-at included, strictly-before excluded (SQL-format row) ──
      const s10 = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01T10:00:00Z" }, admin);
      assertEq(s10.status, 200, "ca-19: since filter → 200");
      assertEq(s10.body.since, "2026-11-01T10:00:00.000Z", "ca-20: since echoed as normalized ISO");
      assertEq((s10.body.rows as any[]).map((r) => r.id), ["a-sql-10", "a-iso-12", "a-iso-13"],
        "ca-21: SQL-format row exactly at since included; 09:59:59 and earlier excluded");
      assertEq(s10.body.by_changed_by, { admin: 2, "content-refresh": 1 }, "ca-22: by_changed_by follows the filter");

      // ── since boundary on an ISO-format row ──
      const s12 = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01T12:00:00.000Z" }, admin);
      assertEq((s12.body.rows as any[]).map((r) => r.id), ["a-iso-12", "a-iso-13"],
        "ca-23: ISO-format row exactly at since included; SQL-format 10:00:00 excluded");
      const s1201 = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01T12:00:01Z" }, admin);
      assertEq((s1201.body.rows as any[]).map((r) => r.id), ["a-iso-13"],
        "ca-24: ISO row one second before since excluded");

      // ── since forms: offset, date-only, zone-less (read as UTC) ──
      const sOffset = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01T11:00:00+01:00" }, admin);
      assertEq(sOffset.body.since, "2026-11-01T10:00:00.000Z", "ca-25: offset since normalized to UTC");
      assertEq((sOffset.body.rows as any[]).map((r) => r.id), ["a-sql-10", "a-iso-12", "a-iso-13"],
        "ca-26: offset since filters at the same instant");
      const sDate = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01" }, admin);
      assertEq(sDate.body.since, "2026-11-01T00:00:00.000Z", "ca-27: date-only since = UTC midnight");
      assertEq(sDate.body.count, 5, "ca-28: date-only since excludes only the October row");
      const sNoZone = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01T10:00:00" }, admin);
      assertEq(sNoZone.body.since, "2026-11-01T10:00:00.000Z", "ca-29: zone-less datetime read as UTC");
      const sSpace = await callGet(router, { provider_id: "ca-p1", since: "2026-11-01 10:00:00" }, admin);
      assertEq((sSpace.body.rows as any[]).map((r) => r.id), ["a-sql-10", "a-iso-12", "a-iso-13"],
        "ca-30: SQLite-style since accepted and read as UTC");

      // ── field filter ──
      const fTel = await callGet(router, { provider_id: "ca-p1", field: "telefon" }, admin);
      assertEq((fTel.body.rows as any[]).map((r) => r.id), ["a-sql-old", "a-sql-10", "a-iso-13"],
        "ca-31: field filter is exact on field_name");
      const fTelSince = await callGet(router, { provider_id: "ca-p1", field: "telefon", since: "2026-11-01T10:00:01Z" }, admin);
      assertEq((fTelSince.body.rows as any[]).map((r) => r.id), ["a-iso-13"], "ca-32: field + since combine (AND)");
      const fPartial = await callGet(router, { provider_id: "ca-p1", field: "tele" }, admin);
      assertEq(fPartial.body.count, 0, "ca-33: field filter is not a prefix/LIKE match");

      // ── other provider isolated ──
      const p2 = await callGet(router, { provider_id: "ca-p2" }, admin);
      assertEq((p2.body.rows as any[]).map((r) => r.id), ["b-1", "b-2"], "ca-34: other provider sees only its own rows");
      const unknown = await callGet(router, { provider_id: "ca-does-not-exist" }, admin);
      assertEq(unknown.status, 200, "ca-35: unknown provider → 200");
      assertEq([unknown.body.count, unknown.body.rows, unknown.body.truncated, unknown.body.by_changed_by],
        [0, [], false, {}], "ca-36: unknown provider → empty result");

      // ── limit + truncated ──
      const l2 = await callGet(router, { provider_id: "ca-p1", limit: "2" }, admin);
      assertEq((l2.body.rows as any[]).map((r) => r.id), ["a-sql-old", "a-iso-0930"], "ca-37: limit keeps the earliest rows");
      assertEq([l2.body.count, l2.body.truncated], [2, true], "ca-38: truncated true when more rows match");
      assertEq(l2.body.by_changed_by, { system: 1, owner: 1 }, "ca-39: by_changed_by counts only returned rows");
      const l6 = await callGet(router, { provider_id: "ca-p1", limit: "6" }, admin);
      assertEq([l6.body.count, l6.body.truncated], [6, false], "ca-40: limit == match count → not truncated");
      const l0 = await callGet(router, { provider_id: "ca-p1", limit: "0" }, admin);
      assertEq([l0.body.count, l0.body.truncated], [1, true], "ca-41: limit 0 clamped to 1");
      const lBig = await callGet(router, { provider_id: "ca-p1", limit: "999999" }, admin);
      assertEq([lBig.body.count, lBig.body.truncated], [6, false], "ca-42: huge limit clamped (to 1000), all rows returned");
      const lNaN = await callGet(router, { provider_id: "ca-p1", limit: "abc" }, admin);
      assertEq([lNaN.status, lNaN.body.count], [200, 6], "ca-43: non-numeric limit → default");

      // ── read-only ──
      assertEq(countRows(), rowCountBefore, "ca-44: endpoint never changes gardssalg_content_audit row count");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-content-audit-read: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserGardssalgContentAuditReadTests(true).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
