/**
 * opplevelser-g1-opprydding.test.ts — dev-request 2026-10-22-opplevagent-mine-
 * valg-gardssalg, G1 point 8 «Opprydding»:
 *
 *   (a) DELETE /admin/rfb-seed never deletes owned rows (claimed_at set,
 *       content_source claim/manual, or an active gardssalg_claims row) and
 *       reports skipped_owned; unowned seed rows are still deleted.
 *   (b) rows with merged_into set are absent from the public gårdssalg
 *       list / count / map / by-slug / search surfaces.
 *   (c) the claim-revoke admin lever resets claimed_at (covered in
 *       opplevelser-gardssalg-claim-revoke.test.ts, e7/j5).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, opts: { method: string; url: string; headers?: Record<string, string>; body?: any }): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method, url: opts.url, originalUrl: opts.url, path: opts.url, query: {},
      headers: opts.headers || {}, body: opts.body ?? {}, get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserG1OppryddingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "g1-opprydding-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const router = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const auth = { "x-admin-key": testKey };

      const ins = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, slug, vertical, producer_type, rfb_seed_source, content_source, claimed_at, merged_into, lat, lon, created_at)
         VALUES (@id, @navn, @slug, 'experiences', 'bryggeri', 'rfb-seed', @content_source, @claimed_at, @merged_into, 60.0, 10.0, '2026-02-01 00:00:00')`,
      );
      const row = (id: string, o: Record<string, unknown> = {}) =>
        ins.run({ id, navn: `Gard ${id}`, slug: `gard-${id}`, content_source: null, claimed_at: null, merged_into: null, ...o });

      // ── (a) DELETE /admin/rfb-seed ──────────────────────────────────────
      row("seed-plain");
      row("seed-claimed-at", { claimed_at: "2026-08-01 10:00:00" });
      row("seed-cs-claim", { content_source: "claim" });
      row("seed-cs-manual", { content_source: "manual" });
      row("seed-active-claim");
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES ('gsc_g1_1', 'seed-active-claim', 'e@x.no', 'stored_epost_verified', 'tok-g1-1', 1, datetime('now'), NULL, datetime('now'), datetime('now', '+7 days'))`,
      ).run();
      row("seed-revoked-claim");
      expDb.prepare(
        `INSERT INTO gardssalg_claims (id, provider_id, email, email_source, token, used, used_at, revoked_at, created_at, expires_at)
         VALUES ('gsc_g1_2', 'seed-revoked-claim', 'e@y.no', 'stored_epost_verified', 'tok-g1-2', 1, datetime('now'), datetime('now'), datetime('now'), datetime('now', '+7 days'))`,
      ).run();

      const noKey = await callRoute(router, { method: "DELETE", url: "/admin/rfb-seed" });
      assertEq(noKey.status, 403, "a1: no admin key -> 403");

      const del = await callRoute(router, { method: "DELETE", url: "/admin/rfb-seed", headers: auth });
      assertEq(del.status, 200, "a2: delete -> 200");
      assertEq(del.body.deleted, 2, "a3: only the unowned seed rows (plain + revoked-claim) are deleted");
      assertEq(del.body.skipped_owned, 4, "a4: skipped_owned counts claimed_at / claim / manual / active-claim rows");
      const left = (expDb.prepare(`SELECT id FROM experience_providers ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
      assertEq(left, ["seed-active-claim", "seed-claimed-at", "seed-cs-claim", "seed-cs-manual"], "a5: all owned rows survive");

      // ── (b) merged_into rows are not public ─────────────────────────────
      expDb.prepare(`DELETE FROM experience_providers`).run();
      row("pub-live");
      row("pub-merged", { merged_into: "pub-live" });
      row("pub-empty-merge", { merged_into: "" });

      const listed = store.listGardssalgProviders(100, 0).map((r) => r.id).sort();
      assertEq(listed, ["pub-empty-merge", "pub-live"], "b1: listGardssalgProviders omits merged_into rows");
      assertEq(store.countGardssalgProviders(), 2, "b2: countGardssalgProviders omits merged_into rows");
      assertEq(store.listGardssalgProviderMapPoints().map((r) => r.slug).sort(), ["gard-pub-empty-merge", "gard-pub-live"], "b3: map points omit merged_into rows");
      assertEq(store.getGardssalgProviderBySlug("gard-pub-merged"), null, "b4: profile by slug is null for a merged row");
      assertEq(store.getGardssalgProviderBySlug("gard-pub-live")?.id, "pub-live", "b5: live row still resolves by slug");
      assertEq(store.searchGardssalgProviders({}, 20).map((r) => r.id).sort(), ["pub-empty-merge", "pub-live"], "b6: searchGardssalgProviders omits merged_into rows");
      assertEq(
        store.searchGardssalgProviders({ include_hidden: true }, 20).map((r) => r.id).sort(),
        ["pub-empty-merge", "pub-live"],
        "b7: ...even with include_hidden",
      );
      assertEq(store.searchGardssalgProvidersByQuery("Gard", 30).map((r: any) => r.id).sort(), ["pub-empty-merge", "pub-live"], "b8: query search omits merged_into rows");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-g1-opprydding: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best effort */ }
      restoreModuleCache();
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runOpplevelserG1OppryddingTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
