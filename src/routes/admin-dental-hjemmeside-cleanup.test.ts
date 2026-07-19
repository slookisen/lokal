/**
 * admin-dental-hjemmeside-cleanup.test.ts — unit tests for
 * POST /admin/dental/hjemmeside-cleanup-sweep
 * (src/routes/admin-dental-hjemmeside-cleanup.ts), dev-request
 * 2026-07-18-dental-hjemmeside-directory-portal-cleanup.
 *
 * Setup mirrors dental-agents-recently-enriched.test.ts: fresh in-memory
 * dental DB via DENTAL_DB_PATH=":memory:" + db-factory.
 * __resetDbFactoryForTesting() (so initDentalSchema runs the real
 * production dental schema, including the new directory_url column), fresh
 * require of the route module per run, exercised via router.handle()
 * directly (X-Admin-Key passed via headers) — mirrors the request-shaping
 * in admin-domain-coherence.test.ts (this route is the same "standalone
 * router mounted at its own admin path, POST /" shape, so it's exercised
 * with url:"/").
 *
 * Covers (per the build spec):
 *   (a) admin-gate: missing / wrong X-Admin-Key -> 403
 *   (b) dry-run: reports flagged rows, makes ZERO writes
 *   (c) apply (dry_run:false): writes exactly the flagged rows (hjemmeside
 *       -> directory_url, hjemmeside cleared) and leaves clean rows
 *       (a normal clinic homepage) completely untouched
 *   (d) field_provenance is MERGED, not clobbered — an existing unrelated
 *       field's provenance survives the write, and a malformed existing
 *       field_provenance blob doesn't block the write
 *   (e) batch cap: HJEMMESIDE_CLEANUP_BATCH_CAP is respected; remaining_count
 *       reflects the un-scanned backlog
 *   (f) re-verify "skip stale row" branch, unit-tested directly via
 *       applyHjemmesideCleanupToRow: a row whose hjemmeside changed after a
 *       flag snapshot was taken is skipped, not clobbered — and a row
 *       already cleaned by something else (directory_url no longer NULL) is
 *       also skipped
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

export function runAdminDentalHjemmesideCleanupSweepTests(
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
    const testKey = "dental-hjemmeside-cleanup-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const routePath = require.resolve("./admin-dental-hjemmeside-cleanup");
    const cachePaths = [dbFactoryPath, routePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const routeMod = require("./admin-dental-hjemmeside-cleanup") as
        typeof import("./admin-dental-hjemmeside-cleanup");
      const router = routeMod.default as any;

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, field_provenance, created_at)
         VALUES (@id, @navn, @hjemmeside, @field_provenance, @created_at)`,
      );

      // (1) A directory-listing URL — should be flagged + cleaned.
      insertAgent.run({
        id: "clinic-directory", navn: "Directory Tannlege AS",
        hjemmeside: "https://legelisten.no/tannlege/oslo-sentrum",
        field_provenance: JSON.stringify({ phone: { source_url: "https://legelisten.no", value: "12345678" } }),
        created_at: "2026-01-01T00:00:00.000Z",
      });
      // (2) A business.site URL — should be flagged + cleaned. No existing
      // field_provenance (NULL) — must not throw, must still merge cleanly.
      insertAgent.run({
        id: "clinic-bizsite", navn: "Bizsite Tannlege AS",
        hjemmeside: "https://smiletannlege.business.site",
        field_provenance: null,
        created_at: "2026-01-02T00:00:00.000Z",
      });
      // (3) A malformed existing field_provenance blob — must not block the
      // write, and must not throw.
      insertAgent.run({
        id: "clinic-malformed-prov", navn: "Malformed Tannlege AS",
        hjemmeside: "https://tannlegetidende.no/klinikk/123",
        field_provenance: "{not json",
        created_at: "2026-01-03T00:00:00.000Z",
      });
      // (4) A normal clinic's own domain — must NEVER be touched.
      insertAgent.run({
        id: "clinic-clean", navn: "Ekte Tannlege AS",
        hjemmeside: "https://ekte-tannlege-oslo.no",
        field_provenance: JSON.stringify({ epost: { source_url: "https://ekte-tannlege-oslo.no", value: "post@ekte-tannlege-oslo.no" } }),
        created_at: "2026-01-04T00:00:00.000Z",
      });
      // (5) hjemmeside NULL — never a candidate (excluded by the WHERE
      // clause entirely, not just "not bad").
      insertAgent.run({
        id: "clinic-no-website", navn: "Uten Nettside AS",
        hjemmeside: null,
        field_provenance: null,
        created_at: "2026-01-05T00:00:00.000Z",
      });

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", headers, body });
      }

      // ── (a) admin gate ──────────────────────────────────────────────────
      let r = await post({}, false);
      assertEq(r.status, 403, "a1: missing X-Admin-Key -> 403");
      r = await post({}, "wrong-key");
      assertEq(r.status, 403, "a2: wrong X-Admin-Key -> 403");

      // ── (b) dry-run: reports flagged rows, zero writes ──────────────────
      // No dry_run key at all -> defaults to dry-run (STRICT-FALSE parse).
      const dryDefault = await post({});
      assertEq(dryDefault.status, 200, "b1: dry-run (default) -> 200");
      assertEq(dryDefault.body.dry_run, true, "b2: dry_run:true echoed back by default");
      assertEq(dryDefault.body.would_clean_count, 3, "b3: exactly 3 candidates flagged (directory, bizsite, malformed-prov)");
      {
        const ids = (dryDefault.body.would_clean as any[]).map((r) => r.id).sort();
        assertEq(ids, ["clinic-bizsite", "clinic-directory", "clinic-malformed-prov"], "b4: would_clean lists exactly the 3 bad rows");
        const byId = Object.fromEntries((dryDefault.body.would_clean as any[]).map((r) => [r.id, r]));
        assertEq(byId["clinic-directory"].reason, "directory", "b5: directory reason surfaced");
        assertEq(byId["clinic-bizsite"].reason, "business_site", "b6: business_site reason surfaced");
        assertEq(byId["clinic-malformed-prov"].reason, "directory", "b7: tannlegetidende.no classified directory");
      }
      // dry_run:"false" (string, not the JSON boolean) must STILL be dry-run.
      const dryStringFalse = await post({ dry_run: "false" });
      assertEq(dryStringFalse.body.dry_run, true, 'b8: dry_run:"false" (string) is still dry-run (STRICT-FALSE parse)');
      // Confirm ZERO writes happened from any dry-run call above.
      {
        const row = dentalDb.prepare("SELECT hjemmeside, directory_url FROM dental_agents WHERE id = ?").get("clinic-directory") as any;
        assertEq(row.hjemmeside, "https://legelisten.no/tannlege/oslo-sentrum", "b9: dry-run never mutates hjemmeside");
        assertEq(row.directory_url, null, "b10: dry-run never sets directory_url");
      }

      // ── (c) apply: writes exactly the flagged rows, leaves clean rows alone ──
      const applied = await post({ dry_run: false });
      assertEq(applied.status, 200, "c1: apply -> 200");
      assertEq(applied.body.dry_run, false, "c2: dry_run:false echoed back");
      assertEq(applied.body.cleaned_count, 3, "c3: exactly 3 rows cleaned");
      {
        const cleanedIds = (applied.body.cleaned as any[]).map((r) => r.id).sort();
        assertEq(cleanedIds, ["clinic-bizsite", "clinic-directory", "clinic-malformed-prov"], "c4: cleaned lists exactly the 3 bad rows");
      }
      const directoryRow = dentalDb.prepare("SELECT hjemmeside, directory_url FROM dental_agents WHERE id = ?").get("clinic-directory") as any;
      assertEq(directoryRow.hjemmeside, null, "c5: hjemmeside cleared for the directory row");
      assertEq(directoryRow.directory_url, "https://legelisten.no/tannlege/oslo-sentrum", "c6: original value preserved in directory_url");
      const bizsiteRow = dentalDb.prepare("SELECT hjemmeside, directory_url FROM dental_agents WHERE id = ?").get("clinic-bizsite") as any;
      assertEq(bizsiteRow.hjemmeside, null, "c7: hjemmeside cleared for the business.site row");
      assertEq(bizsiteRow.directory_url, "https://smiletannlege.business.site", "c8: original value preserved in directory_url");
      // The clean row must be COMPLETELY untouched.
      const cleanRow = dentalDb.prepare("SELECT hjemmeside, directory_url FROM dental_agents WHERE id = ?").get("clinic-clean") as any;
      assertEq(cleanRow.hjemmeside, "https://ekte-tannlege-oslo.no", "c9: clean clinic's hjemmeside untouched");
      assertEq(cleanRow.directory_url, null, "c10: clean clinic's directory_url stays NULL");

      // Re-running apply now finds nothing left to clean (directory_url IS
      // NOT NULL excludes the 3 just-cleaned rows from the candidate set).
      const secondApply = await post({ dry_run: false });
      assertEq(secondApply.body.cleaned_count, 0, "c11: second apply run cleans nothing (already-cleaned rows excluded from candidate set)");
      // Exactly one candidate remains in scope: clinic-clean (hjemmeside set,
      // directory_url still NULL) — it's scanned (matches the WHERE clause)
      // but never classified bad, so it's never cleaned.
      assertEq(secondApply.body.scanned, 1, "c12: second apply run scans only the still-un-cleaned clean row (clinic-clean)");

      // ── (d) field_provenance merged, not clobbered ───────────────────────
      const directoryProv = JSON.parse(
        (dentalDb.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get("clinic-directory") as any).field_provenance,
      );
      assertTrue(!!directoryProv.phone, "d1: pre-existing 'phone' provenance survives the merge");
      assertEq(directoryProv.phone.value, "12345678", "d2: pre-existing 'phone' provenance value untouched");
      assertTrue(!!directoryProv.hjemmeside, "d3: new 'hjemmeside' provenance entry present");
      assertEq(directoryProv.hjemmeside.cleaned_reason, "directory", "d4: hjemmeside provenance records the classification reason");
      assertEq(directoryProv.hjemmeside.previous_value, "https://legelisten.no/tannlege/oslo-sentrum", "d5: hjemmeside provenance records the previous value");
      assertTrue(typeof directoryProv.hjemmeside.cleaned_at === "string" && directoryProv.hjemmeside.cleaned_at.length > 0, "d6: hjemmeside provenance records cleaned_at");

      const bizsiteProv = JSON.parse(
        (dentalDb.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get("clinic-bizsite") as any).field_provenance,
      );
      assertTrue(!!bizsiteProv.hjemmeside, "d7: NULL starting field_provenance still produces a valid merged blob");

      const malformedProvRow = dentalDb.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get("clinic-malformed-prov") as any;
      const malformedProv = JSON.parse(malformedProvRow.field_provenance);
      assertTrue(!!malformedProv.hjemmeside, "d8: malformed pre-existing field_provenance doesn't block the write");
      assertEq(Object.keys(malformedProv), ["hjemmeside"], "d9: malformed pre-existing JSON is discarded (only the new key survives), not silently merged garbage");

      // ── (e) batch cap ─────────────────────────────────────────────────────
      const cap = routeMod.HJEMMESIDE_CLEANUP_BATCH_CAP;
      const extra = cap + 7;
      const insertBulk = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, created_at) VALUES (@id, @navn, @hjemmeside, @created_at)`,
      );
      for (let i = 0; i < extra; i++) {
        insertBulk.run({
          id: `bulk-${i}`,
          navn: `Bulk Tannlege ${i} AS`,
          hjemmeside: "https://legelisten.no/tannlege/bulk",
          created_at: `2026-02-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        });
      }
      // At this point the only still-un-cleaned candidate besides the bulk
      // rows is clinic-clean (hjemmeside set, directory_url still NULL, but
      // NOT bad) — its created_at (2026-01-04) sorts before every bulk row's
      // (2026-02-01), so it's guaranteed to occupy one slot of the capped
      // batch: scanned == cap, but only (cap - 1) of those are bad.
      const bulkDry = await post({});
      assertEq(bulkDry.body.scanned, cap, "e1: scan is capped at HJEMMESIDE_CLEANUP_BATCH_CAP even though more candidates exist");
      assertEq(bulkDry.body.would_clean_count, cap - 1, "e2: cap-1 bad rows in the capped batch (clinic-clean occupies the 1 non-bad slot)");
      assertEq(bulkDry.body.remaining_count, 8, "e3: remaining_count reports the un-scanned backlog ((1 clean-row candidate + extra bulk rows) - cap)");
      assertTrue((bulkDry.body.would_clean as any[]).length <= routeMod.HJEMMESIDE_CLEANUP_SAMPLE_CAP, "e4: would_clean array itself is capped to the sample cap, not the full batch");

      // ── (f) applyHjemmesideCleanupToRow: stale-row / already-cleaned skip ──
      // Fresh isolated row for this check.
      insertAgent.run({
        id: "clinic-stale", navn: "Stale Tannlege AS",
        hjemmeside: "https://legelisten.no/stale",
        field_provenance: null,
        created_at: "2026-03-01T00:00:00.000Z",
      });
      const staleFlag = { id: "clinic-stale", navn: "Stale Tannlege AS", hjemmeside: "https://legelisten.no/stale", reason: "directory" as const };
      // Mutate the row's hjemmeside directly, simulating "changed since an
      // earlier scan" — the snapshot in staleFlag is now stale.
      dentalDb.prepare("UPDATE dental_agents SET hjemmeside = ? WHERE id = ?").run("https://a-completely-different-real-clinic.no", "clinic-stale");
      const staleOutcome = routeMod.applyHjemmesideCleanupToRow(dentalDb, staleFlag, new Date().toISOString());
      assertEq(staleOutcome.applied, false, "f1: stale snapshot (hjemmeside changed since scan) is skipped, not applied");
      const afterStale = dentalDb.prepare("SELECT hjemmeside, directory_url FROM dental_agents WHERE id = ?").get("clinic-stale") as any;
      assertEq(afterStale.hjemmeside, "https://a-completely-different-real-clinic.no", "f2: the row's mutated hjemmeside is left exactly as-is, not clobbered");
      assertEq(afterStale.directory_url, null, "f3: directory_url is not set by the skipped apply");

      // Already-cleaned row (directory_url no longer NULL) must also be skipped.
      insertAgent.run({
        id: "clinic-already-cleaned", navn: "Allerede Renset AS",
        hjemmeside: "https://legelisten.no/already",
        field_provenance: null,
        created_at: "2026-03-02T00:00:00.000Z",
      });
      const alreadyFlag = { id: "clinic-already-cleaned", navn: "Allerede Renset AS", hjemmeside: "https://legelisten.no/already", reason: "directory" as const };
      dentalDb.prepare("UPDATE dental_agents SET directory_url = ? WHERE id = ?").run("https://legelisten.no/already", "clinic-already-cleaned");
      const alreadyOutcome = routeMod.applyHjemmesideCleanupToRow(dentalDb, alreadyFlag, new Date().toISOString());
      assertEq(alreadyOutcome.applied, false, "f4: a row already cleaned (directory_url set) by something else is skipped, not re-applied");

      // Row gone entirely (never inserted / deleted since scan) must also be a no-op, not a throw.
      const goneOutcome = routeMod.applyHjemmesideCleanupToRow(dentalDb, { id: "does-not-exist", navn: "Ghost AS", hjemmeside: "https://legelisten.no", reason: "directory" }, new Date().toISOString());
      assertEq(goneOutcome.applied, false, "f5: a row that no longer exists is skipped, not a throw");
    } catch (err: any) {
      failed++;
      failures.push("admin-dental-hjemmeside-cleanup: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/admin-dental-hjemmeside-cleanup.test.ts`
if (require.main === module) {
  runAdminDentalHjemmesideCleanupSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
