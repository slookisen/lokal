/**
 * provider-work-queue.test.ts — unit tests for the shared provider_work_queue
 * hand-off table (src/services/provider-work-queue.ts), dev-request
 * 2026-08-17-forsyningskjede-samarbeid-og-kvalitetsoppdatering, Skive 1.
 *
 * Real in-memory better-sqlite3 DB via EXPERIENCES_DB_PATH=":memory:" +
 * db-factory's __resetDbFactoryForTesting(), mirroring the pattern used by
 * experience-og-image.test.ts / experience-dedup.test.ts: a fresh
 * require-cache for every module touched, provider_work_queue's schema
 * created by the real initExperiencesSchema() migration (not hand-rolled),
 * with minimal experience_providers rows seeded so the FOREIGN KEY
 * (provider_id) REFERENCES experience_providers(id) constraint is satisfied
 * (foreign_keys=ON is set by db-factory).
 *
 * Exported runProviderWorkQueueTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/provider-work-queue.test.ts
 *
 * Covers:
 *   (a) enqueue inserts a row (enqueued: true).
 *   (b) enqueue is a no-op (enqueued: false, no new row) on a duplicate
 *       pending item — same provider_id + to_system + reason.
 *   (c) a DIFFERENT reason for the same provider_id + to_system still
 *       inserts (not swallowed by the idempotency check).
 *   (d) resolve marks matching pending rows resolved (resolved_at set,
 *       outcome set) and returns the correct changed-row count, while
 *       leaving another provider's / another to_system's pending rows
 *       untouched.
 *   (e) a resolved row is no longer picked up by a second enqueue call for
 *       the same provider/to_system/reason (idempotency window is per
 *       unresolved row, not global).
 *   (f) listPendingProviderWorkQueue returns oldest-first, filters by
 *       to_system, and respects an optional limit.
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runProviderWorkQueueTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevDb = initMod.getDb();
    const rfbDb = new Database(":memory:");
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const pwqPath = require.resolve("./provider-work-queue");
    for (const p of [dbFactoryPath, pwqPath]) {
      delete require.cache[p];
    }

    try {
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const pwq = require("./provider-work-queue") as typeof import("./provider-work-queue");

      // Seed minimal experience_providers rows so the FK constraint is
      // satisfied for every provider_id used below.
      const seedProvider = (id: string, navn: string) => {
        expDb.prepare(`INSERT INTO experience_providers (id, navn) VALUES (?, ?)`).run(id, navn);
      };
      seedProvider("prov-1", "Nordlys Gård");
      seedProvider("prov-2", "Solbakken Gårdsutsalg");

      // ── (a) enqueue inserts a row ────────────────────────────────────
      const r1 = pwq.enqueueProviderWorkQueueItem({
        provider_id: "prov-1",
        provider_name: "Nordlys Gård",
        from_system: "sweep",
        to_system: "discovery",
        reason: "missing_source",
        batch_id: "batch-1",
      });
      assertEq(r1, { enqueued: true }, "a1: first enqueue returns enqueued: true");
      const rows1 = expDb.prepare(`SELECT * FROM provider_work_queue WHERE provider_id = 'prov-1'`).all() as any[];
      assertEq(rows1.length, 1, "a2: exactly one row inserted");
      assertEq(rows1[0].reason, "missing_source", "a3: reason persisted");
      assertEq(rows1[0].from_system, "sweep", "a4: from_system persisted");
      assertEq(rows1[0].to_system, "discovery", "a5: to_system persisted");
      assertEq(rows1[0].resolved_at, null, "a6: resolved_at is null on insert");
      assertEq(rows1[0].batch_id, "batch-1", "a7: batch_id persisted");

      // ── (b) duplicate pending -> no-op ───────────────────────────────
      const r2 = pwq.enqueueProviderWorkQueueItem({
        provider_id: "prov-1",
        from_system: "sweep",
        to_system: "discovery",
        reason: "missing_source",
      });
      assertEq(r2, { enqueued: false }, "b1: duplicate pending enqueue returns enqueued: false");
      const rows2 = expDb.prepare(`SELECT * FROM provider_work_queue WHERE provider_id = 'prov-1'`).all() as any[];
      assertEq(rows2.length, 1, "b2: still exactly one row (no duplicate inserted)");

      // ── (c) different reason, same provider+to_system -> still inserts ─
      const r3 = pwq.enqueueProviderWorkQueueItem({
        provider_id: "prov-1",
        from_system: "sweep",
        to_system: "discovery",
        reason: "evidence_url_rejected",
        payload: JSON.stringify({ rejected_url: "https://example.com/old" }),
      });
      assertEq(r3, { enqueued: true }, "c1: different reason enqueues a new row");
      const rows3 = expDb.prepare(`SELECT * FROM provider_work_queue WHERE provider_id = 'prov-1'`).all() as any[];
      assertEq(rows3.length, 2, "c2: two rows now exist for prov-1 (one per reason)");
      const rejectedRow = rows3.find((r) => r.reason === "evidence_url_rejected");
      assertTrue(!!rejectedRow, "c3: evidence_url_rejected row exists");
      assertEq(JSON.parse(rejectedRow.payload).rejected_url, "https://example.com/old", "c4: rejected_url payload persisted");

      // Seed a second provider's pending items for the resolve/list isolation checks.
      pwq.enqueueProviderWorkQueueItem({
        provider_id: "prov-2",
        from_system: "berikelse",
        to_system: "discovery",
        reason: "parked_needs_replacement",
      });
      pwq.enqueueProviderWorkQueueItem({
        provider_id: "prov-1",
        from_system: "discovery",
        to_system: "sweep",
        reason: "candidate_ready",
      });

      // ── (d) resolve marks matching pending rows resolved, leaves others ─
      const changed = pwq.resolveProviderWorkQueueItems("prov-1", "discovery", "hjemmeside_written");
      assertEq(changed, 2, "d1: resolve returns count of rows changed (both prov-1 -> discovery rows)");
      const resolvedRows = expDb.prepare(`SELECT * FROM provider_work_queue WHERE provider_id = 'prov-1' AND to_system = 'discovery'`).all() as any[];
      assertTrue(resolvedRows.every((r) => r.resolved_at !== null), "d2: all prov-1 -> discovery rows now have resolved_at set");
      assertTrue(resolvedRows.every((r) => r.outcome === "hjemmeside_written"), "d3: all resolved rows carry the given outcome");
      const prov2Row = expDb.prepare(`SELECT * FROM provider_work_queue WHERE provider_id = 'prov-2'`).get() as any;
      assertEq(prov2Row.resolved_at, null, "d4: prov-2's row (different provider) untouched");
      const prov1SweepRow = expDb.prepare(`SELECT * FROM provider_work_queue WHERE provider_id = 'prov-1' AND to_system = 'sweep'`).get() as any;
      assertEq(prov1SweepRow.resolved_at, null, "d5: prov-1's -> sweep row (different to_system) untouched");
      const changedAgain = pwq.resolveProviderWorkQueueItems("prov-1", "discovery", "hjemmeside_written");
      assertEq(changedAgain, 0, "d6: resolving again with nothing pending returns 0");

      // ── (e) resolved row does not block a fresh enqueue for the same key ─
      const r4 = pwq.enqueueProviderWorkQueueItem({
        provider_id: "prov-1",
        from_system: "sweep",
        to_system: "discovery",
        reason: "missing_source",
      });
      assertEq(r4, { enqueued: true }, "e1: re-enqueue after resolution inserts a fresh row (idempotency is per-unresolved-row)");

      // ── (f) listPendingProviderWorkQueue: order, filter, limit ──────────
      // Reset to a clean, order-controlled slate for this section.
      expDb.prepare(`DELETE FROM provider_work_queue`).run();
      const insertAt = (providerId: string, toSystem: string, reason: string, requestedAt: string) => {
        expDb.prepare(
          `INSERT INTO provider_work_queue (id, provider_id, from_system, to_system, reason, requested_at)
           VALUES (?, ?, 'sweep', ?, ?, ?)`
        ).run(`id-${providerId}-${reason}-${requestedAt}`, providerId, toSystem, reason, requestedAt);
      };
      insertAt("prov-1", "discovery", "missing_source", "2026-08-01 10:00:00");
      insertAt("prov-2", "discovery", "parked_needs_replacement", "2026-08-01 09:00:00");
      insertAt("prov-1", "sweep", "candidate_ready", "2026-08-01 08:00:00");

      const pendingDiscovery = pwq.listPendingProviderWorkQueue("discovery");
      assertEq(pendingDiscovery.length, 2, "f1: two pending items target discovery");
      assertEq(pendingDiscovery[0].provider_id, "prov-2", "f2: oldest-requested (09:00) comes first");
      assertEq(pendingDiscovery[1].provider_id, "prov-1", "f3: newer-requested (10:00) comes second");
      assertTrue(pendingDiscovery.every((r) => r.to_system === "discovery"), "f4: to_system filter excludes the sweep-targeted row");

      const pendingSweep = pwq.listPendingProviderWorkQueue("sweep");
      assertEq(pendingSweep.length, 1, "f5: exactly one pending item targets sweep");

      const limited = pwq.listPendingProviderWorkQueue("discovery", 1);
      assertEq(limited.length, 1, "f6: limit is respected");
      assertEq(limited[0].provider_id, "prov-2", "f7: limited result still returns the oldest first");
    } catch (err: any) {
      failed++;
      failures.push("provider-work-queue: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      initMod.__setDbForTesting(prevDb);
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of [dbFactoryPath, pwqPath]) {
        delete require.cache[p];
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/provider-work-queue.test.ts`
if (require.main === module) {
  runProviderWorkQueueTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
