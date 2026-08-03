/**
 * opplevelser-gardssalg-owner-lock-backfill.test.ts — route-level tests for
 * POST /api/opplevelser/admin/gardssalg-owner-lock-backfill (dev-request
 * 2026-07-30-opplevagent-claim-epost-og-perfelt-laas, item 3, scoped-down
 * slice — the one-time catch-up for pre-existing `gardssalg_content_audit`
 * (changed_by='owner') rows that predate updateClaimedProviderProfile's
 * forward owner_locks stamping, see gardssalg-claim.test.ts for that
 * forward-stamping's own coverage).
 *
 * Mirrors opplevelser-gardssalg-website-verification.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * opplevelser router per run, callRoute() exercising router.handle()
 * directly with X-Admin-Key via headers) — no network mocking needed here,
 * this route never fetches.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) dry-run (apply omitted/false): reports the correct scanned/
 *       would_stamp/already_stamped counts and makes ZERO DB writes —
 *       asserted via a fresh read from the DB, not by trusting the response
 *   (c) apply=true: stamps field_provenance.owner_locks.<field> = { locked_at }
 *       using the latest changed_at from gardssalg_content_audit for that
 *       (provider_id, field_name) pair, and preserves pre-existing
 *       field_provenance keys (merge, not overwrite)
 *   (d) a field whose owner_locks entry is already present (e.g. from
 *       updateClaimedProviderProfile's own forward-stamping) is counted
 *       under already_stamped and left untouched
 *   (e) re-running apply after a first apply is a true no-op: identical
 *       already_stamped count, zero further writes, no updated_at bump on
 *       rows it doesn't touch
 *   (f) a stale gardssalg_content_audit row referencing a since-deleted
 *       provider is skipped without crashing the batch
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
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const url = opts.url || "/admin/gardssalg-owner-lock-backfill";
    const [pathOnly, queryString] = url.split("?");
    const query: Record<string, string> = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: pathOnly,
      query,
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgOwnerLockBackfillTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "gardssalg-owner-lock-backfill-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const claimServicePath = require.resolve("../services/gardssalg-claim");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, claimServicePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, content_source, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @content_source, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // prov-a: two owner-changed fields, no pre-existing field_provenance.
      insertProvider.run({
        id: "prov-a", navn: "Klostergården", content_source: "claim", field_provenance: null,
      });
      // prov-b: one owner-changed field, but ALREADY has an owner_locks
      // entry for it (forward-stamped by updateClaimedProviderProfile) —
      // must be counted already_stamped, never re-dated.
      insertProvider.run({
        id: "prov-b", navn: "Sprettgard", content_source: "claim",
        field_provenance: JSON.stringify({
          hjemmeside: { source_url: "https://visitnorway.no/x", fetched_at: "2026-06-01T00:00:00Z" },
          owner_locks: { about_text: { locked_at: "2026-07-15T10:00:00.000Z" } },
        }),
      });

      const auditInsert = expDb.prepare(
        `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES (?, ?, ?, NULL, ?, NULL, 'owner-portal', 'owner', ?)`,
      );
      // prov-a: about_text changed twice (latest changed_at must win),
      // products changed once.
      auditInsert.run("a1", "prov-a", "about_text", "Første versjon", "2026-07-01T09:00:00Z");
      auditInsert.run("a2", "prov-a", "about_text", "Andre versjon", "2026-07-10T09:00:00Z");
      auditInsert.run("a3", "prov-a", "products", "Sider", "2026-07-05T09:00:00Z");
      // prov-b: about_text already stamped (should stay already_stamped),
      // hjemmeside changed and NOT yet stamped.
      auditInsert.run("b1", "prov-b", "about_text", "Endret", "2026-07-12T09:00:00Z");
      auditInsert.run("b2", "prov-b", "hjemmeside", "https://ny.no", "2026-07-20T09:00:00Z");
      // Stale row referencing a provider that was never inserted (simulates
      // a since-deleted provider — gardssalg_content_audit.provider_id has
      // an ON DELETE CASCADE FK, so this shape can only legitimately arise
      // from legacy data written before FK enforcement, hence the pragma
      // toggle here to construct the fixture) — must be skipped, not crash
      // the batch.
      expDb.pragma("foreign_keys = OFF");
      auditInsert.run("c1", "prov-deleted", "about_text", "Slettet gård", "2026-07-01T09:00:00Z");
      expDb.pragma("foreign_keys = ON");
      // A non-owner change must never be scanned at all.
      expDb.prepare(
        `INSERT INTO gardssalg_content_audit (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES ('d1b', 'prov-a', 'epost', NULL, 'system@x.no', NULL, NULL, 'system', '2026-07-01T09:00:00Z')`,
      ).run();

      // ── (a) 403 without X-Admin-Key ──────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { method: "POST", headers: {} });
      assertEq(noKey.status, 403, "a1: POST without X-Admin-Key -> 403");

      const headers = { "x-admin-key": testKey };

      // ── (b) dry-run: correct counts, zero writes ─────────────────────────
      const dry = await callRoute(opplevelserRouter, { method: "POST", headers, body: {} });
      assertEq(dry.status, 200, "b1: dry-run responds 200");
      assertEq(dry.body.dry_run, true, "b2: dry_run:true when apply is omitted");
      // Distinct (provider_id, field_name) owner-changed groups: prov-a
      // about_text, prov-a products, prov-b about_text, prov-b hjemmeside,
      // prov-deleted about_text = 5.
      assertEq(dry.body.scanned, 5, "b3: scanned counts distinct (provider_id, field_name) owner-changed groups, not raw audit rows");
      // Would-stamp: prov-a.about_text, prov-a.products, prov-b.hjemmeside = 3
      // (prov-b.about_text already stamped, prov-deleted missing).
      assertEq(dry.body.would_stamp, 3, "b4: would_stamp counts groups not yet stamped and with an existing provider");
      assertEq(dry.body.already_stamped, 1, "b5: already_stamped counts prov-b.about_text (already has an owner_locks entry)");
      assertEq(dry.body.skipped_missing_provider, 1, "b6: skipped_missing_provider counts the stale prov-deleted row");

      const provAafterDry = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get("prov-a") as any;
      assertEq(provAafterDry.field_provenance, null, "b7: dry-run performed ZERO writes — prov-a.field_provenance is still null (fresh DB read, not the response body)");
      const provBafterDry = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get("prov-b") as any;
      const provBparsedDry = JSON.parse(provBafterDry.field_provenance);
      assertTrue(!("hjemmeside" in (provBparsedDry.owner_locks || {})), "b8: dry-run performed ZERO writes — prov-b's owner_locks.hjemmeside is still absent (fresh DB read)");

      // ── (c) apply: stamps correctly, merges with pre-existing keys ───────
      const apply1 = await callRoute(opplevelserRouter, { method: "POST", headers, body: { apply: true } });
      assertEq(apply1.status, 200, "c1: apply responds 200");
      assertEq(apply1.body.dry_run, false, "c2: dry_run:false when apply:true");
      assertEq(apply1.body.scanned, 5, "c3: apply scanned count matches dry-run's");
      assertEq(apply1.body.stamped, 3, "c4: apply stamped count matches dry-run's would_stamp");
      assertEq(apply1.body.already_stamped, 1, "c5: apply already_stamped count matches dry-run's");
      assertEq(apply1.body.skipped_missing_provider, 1, "c6: apply skipped_missing_provider count matches dry-run's");

      const provAafterApply = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get("prov-a") as any;
      const provAparsed = JSON.parse(provAafterApply.field_provenance);
      assertEq(provAparsed.owner_locks.about_text, { locked_at: "2026-07-10T09:00:00Z" }, "c7: prov-a.owner_locks.about_text stamped with the LATEST changed_at (not the first)");
      assertEq(provAparsed.owner_locks.products, { locked_at: "2026-07-05T09:00:00Z" }, "c8: prov-a.owner_locks.products stamped");
      assertTrue(!("epost" in provAparsed.owner_locks), "c9: prov-a's system-changed epost field was never scanned/stamped");

      const provBafterApply = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get("prov-b") as any;
      const provBparsed = JSON.parse(provBafterApply.field_provenance);
      assertEq(provBparsed.owner_locks.about_text, { locked_at: "2026-07-15T10:00:00.000Z" }, "c10: prov-b's pre-existing owner_locks.about_text is UNCHANGED (not re-dated)");
      assertEq(provBparsed.owner_locks.hjemmeside, { locked_at: "2026-07-20T09:00:00Z" }, "c11: prov-b.owner_locks.hjemmeside newly stamped");
      assertEq(provBparsed.hjemmeside, { source_url: "https://visitnorway.no/x", fetched_at: "2026-06-01T00:00:00Z" }, "c12: prov-b's pre-existing (unrelated) field_provenance.hjemmeside key survives untouched — merge, not overwrite");

      // ── (e) re-run apply: true no-op ──────────────────────────────────────
      const provAupdatedAtBefore = (expDb.prepare("SELECT updated_at FROM experience_providers WHERE id = ?").get("prov-a") as any).updated_at;
      const apply2 = await callRoute(opplevelserRouter, { method: "POST", headers, body: { apply: true } });
      assertEq(apply2.body.stamped, 0, "e1: re-running apply stamps zero NEW groups");
      assertEq(apply2.body.already_stamped, 4, "e2: re-running apply — the 4 groups from the first apply plus prov-b's original are now all already_stamped (prov-deleted stays skipped, not already_stamped)");
      assertEq(apply2.body.skipped_missing_provider, 1, "e3: skipped_missing_provider unchanged on re-run");
      const provAupdatedAtAfter = (expDb.prepare("SELECT updated_at FROM experience_providers WHERE id = ?").get("prov-a") as any).updated_at;
      assertEq(provAupdatedAtAfter, provAupdatedAtBefore, "e4: re-running apply on an already-fully-stamped provider does not bump updated_at (no write happened)");
      const provAafterRerun = expDb.prepare("SELECT field_provenance FROM experience_providers WHERE id = ?").get("prov-a") as any;
      assertEq(provAafterRerun.field_provenance, provAafterApply.field_provenance, "e5: prov-a's field_provenance is byte-for-byte unchanged after the no-op re-run");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-owner-lock-backfill: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-owner-lock-backfill.test.ts`
if (require.main === module) {
  console.log("── opplevelser-gardssalg-owner-lock-backfill route tests ──");
  runOpplevelserGardssalgOwnerLockBackfillTests({ log: true }).then((r) => {
    console.log(`\nopplevelser-gardssalg-owner-lock-backfill: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
