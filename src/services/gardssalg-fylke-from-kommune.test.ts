/**
 * gardssalg-fylke-from-kommune.test.ts — dev-request
 * 2026-10-01-opplevagent-fylke-fra-kommune. In-memory-DB pattern, same as
 * experience-store-lock-split.test.ts.
 *
 * Covers: unambiguous kommune -> correct fylke; unknown/ambiguous ->
 * needs_review and no write; a set fylke is never changed; locked rows are
 * skipped; dry-run writes nothing; one audit row per write; write path
 * (createProvider) is fill-only.
 */
export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgFylkeFromKommuneTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  return (async () => {
    const prev = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./gardssalg-fylke-from-kommune"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("./experience-store") as typeof import("./experience-store");
      const svc = require("./gardssalg-fylke-from-kommune") as typeof import("./gardssalg-fylke-from-kommune");

      const mk = (navn: string, f: { fylke?: string | null; kommune?: string | null; kommunenummer?: string | null }, extra?: { content_source?: string; producer_type?: string | null }) => {
        const id = store.createProvider({ navn, kommune: f.kommune ?? undefined, kommunenummer: f.kommunenummer ?? undefined } as any);
        // Force the exact stored state (createProvider itself fills fylke).
        db.prepare("UPDATE experience_providers SET fylke = ?, producer_type = ?, content_source = ? WHERE id = ?").run(
          f.fylke ?? null,
          extra?.producer_type === undefined ? "bryggeri" : extra.producer_type,
          extra?.content_source ?? null,
          id,
        );
        return id;
      };
      const fylkeOf = (id: string) =>
        (db.prepare("SELECT fylke FROM experience_providers WHERE id = ?").get(id) as { fylke: string | null }).fylke;

      const bergen = mk("Bergen Bryggeri", { kommune: "Bergen" });
      const unknown = mk("Ukjent Bryggeri", { kommune: "Finnesikke" });
      const herøy = mk("Heroy Bryggeri", { kommune: "Herøy" }); // vendored-table name collision
      const preset = mk("Satt Bryggeri", { fylke: "Rogaland", kommune: "Bergen" });
      const locked = mk("Last Bryggeri", { kommune: "Bergen" }, { content_source: "manual" });
      const claimed = mk("Claim Bryggeri", { kommune: "Bergen" }, { content_source: "claim" });
      const noData = mk("Ingen Bryggeri", {});
      const notGs = mk("Ikke Gardssalg", { kommune: "Bergen" }, { producer_type: null });

      // dry-run: report only, zero writes
      const dry = svc.runGardssalgFylkeFromKommune({ apply: false });
      assertEq(dry.dry_run, true, "dry: dry_run flag true");
      assertEq(dry.resolved, 1, "dry: only the unambiguous, unlocked row resolves");
      assertEq(dry.needs_review, 2, "dry: unknown + ambiguous kommune -> needs_review");
      assertEq(dry.skipped_locked, 2, "dry: manual + claim rows skipped_locked");
      assertEq(dry.written, 0, "dry: nothing written");
      assertEq(dry.needs_review_samples.length, 2, "dry: samples listed");
      assertEq(fylkeOf(bergen), null, "dry: bergen still blank");
      assertEq((db.prepare("SELECT COUNT(*) c FROM gardssalg_content_audit").get() as { c: number }).c, 0, "dry: no audit rows");

      // apply
      const ap = svc.runGardssalgFylkeFromKommune({ apply: true, batchId: "t1" });
      assertEq(ap.written, 1, "apply: one row written");
      assertEq(fylkeOf(bergen), "Vestland", "apply: unambiguous kommune -> correct fylke");
      assertEq(fylkeOf(unknown), null, "apply: unknown kommune not written");
      assertEq(fylkeOf(herøy), null, "apply: ambiguous kommune not written");
      assertEq(fylkeOf(preset), "Rogaland", "apply: set fylke never changed");
      assertEq(fylkeOf(locked), null, "apply: manual-locked row untouched");
      assertEq(fylkeOf(claimed), null, "apply: claim-locked row untouched");
      assertEq(fylkeOf(noData), null, "apply: row without kommune untouched");
      assertEq(fylkeOf(notGs), null, "apply: non-gardssalg row untouched");
      const audits = db.prepare("SELECT provider_id, field_name, old_value, new_value, batch_id FROM gardssalg_content_audit").all();
      assertEq(audits, [{ provider_id: bergen, field_name: "fylke", old_value: null, new_value: "Vestland", batch_id: "t1" }], "apply: exactly one audit row per write");

      // idempotent
      const again = svc.runGardssalgFylkeFromKommune({ apply: true });
      assertEq(again.written, 0, "apply twice: second run writes nothing");

      // write path: fill-only
      const wp1 = store.createProvider({ navn: "Ny A", kommune: "Bergen" } as any);
      assertEq(fylkeOf(wp1), "Vestland", "write path: blank fylke + unambiguous kommune -> filled");
      const wp2 = store.createProvider({ navn: "Ny B", kommune: "Bergen", fylke: "Rogaland" } as any);
      assertEq(fylkeOf(wp2), "Rogaland", "write path: set fylke never overwritten");
      const wp3 = store.createProvider({ navn: "Ny C", kommune: "Finnesikke" } as any);
      assertEq(fylkeOf(wp3), null, "write path: unknown kommune stays blank (no guess)");
      const wp4 = store.createProvider({ navn: "Ny D" } as any);
      assertEq(fylkeOf(wp4), null, "write path: no kommune stays blank");
      assertEq(svc.fillFylkeFromKommune({ fylke: "  ", kommunenummer: "4601" }), "Vestland", "helper: kommunenummer lookup");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-fylke-from-kommune: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prev === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prev;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgFylkeFromKommuneTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    if (r.failed > 0) process.exit(1);
  });
}
