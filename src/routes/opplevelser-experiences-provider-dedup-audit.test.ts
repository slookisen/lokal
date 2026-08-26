/**
 * opplevelser-experiences-provider-dedup-audit.test.ts — tests for
 * GET /admin/experiences-provider-dedup-audit (src/routes/opplevelser.ts),
 * backed by src/services/experience-provider-canonicalize.ts.
 *
 * dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
 * spec-punkt 2. Pure-function signal coverage lives in
 * experience-provider-canonicalize.test.ts; this file covers the SQL scope
 * (the actual gap this endpoint closes — GET /admin/gardssalg-provider-
 * dedup-audit's own scope excludes every row this endpoint scans) plus the
 * HTTP/DB wiring (auth, zero-writes, response shape).
 *
 * Mirrors opplevelser-gardssalg-provider-dedup-audit.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) real production shape: three "Vitensenteret" spellings (no
 *       producer_type, no rfb_seed_source, no org_nr) -> ONE group, LOW
 *       confidence
 *   (c) a gårdssalg-scoped row (producer_type set) is excluded from the scan
 *       entirely — proves this audit's scope is the COMPLEMENT of the
 *       gårdssalg audit's, not an overlapping second copy of it
 *   (d) an rfb-seed row (rfb_seed_source='rfb-seed') is also excluded
 *   (e) a catalog_hidden row is excluded
 *   (f) a row already carrying merged_into is excluded (already resolved,
 *       doesn't need to keep re-surfacing)
 *   (g) negative control — two genuinely different providers never group
 *   (h) response row shape: only id/navn/org_nr/kommune/fylke/content_source/
 *       has_website — no raw hjemmeside/epost/telefon anywhere
 *   (i) zero net DB writes: row count and every fixture row's raw column
 *       values are byte-identical before vs after calling the endpoint TWICE
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
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/experiences-provider-dedup-audit",
      originalUrl: "/admin/experiences-provider-dedup-audit",
      path: "/admin/experiences-provider-dedup-audit",
      query: {},
      headers: opts.headers || {},
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

export function runOpplevelserExperiencesProviderDedupAuditTests(
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
    const testKey = process.env.ADMIN_KEY || "experiences-provider-dedup-audit-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, fylke, hjemmeside, rfb_seed_source, producer_type,
            epost, telefon, content_source, catalog_hidden, merged_into,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @fylke, @hjemmeside, @rfb_seed_source, @producer_type,
            @epost, @telefon, @content_source, @catalog_hidden, @merged_into,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      type FixtureRow = {
        id: string;
        navn: string;
        org_nr?: string | null;
        kommune?: string | null;
        fylke?: string | null;
        hjemmeside?: string | null;
        rfb_seed_source?: string | null;
        producer_type?: string | null;
        epost?: string | null;
        telefon?: string | null;
        content_source?: string | null;
        catalog_hidden?: number | null;
        merged_into?: string | null;
      };
      function seed(row: FixtureRow): void {
        insertProvider.run({
          org_nr: null,
          kommune: null,
          fylke: null,
          hjemmeside: null,
          rfb_seed_source: null,
          producer_type: null,
          epost: null,
          telefon: null,
          content_source: null,
          catalog_hidden: null,
          merged_into: null,
          ...row,
        });
      }

      // ── (b) real production shape — Vitensenteret 3-way ─────────────────────
      seed({ id: "prov-vit-a", navn: "Vitensenteret i Trondheim", kommune: "Trondheim", fylke: "Trøndelag" });
      seed({ id: "prov-vit-b", navn: "Vitensenteret Trondheim", kommune: "Trondheim", fylke: "Trøndelag" });
      seed({ id: "prov-vit-c", navn: "Vitensenteret", kommune: "Trondheim", fylke: "Trøndelag" });

      // ── (c) gårdssalg-scoped row — must be excluded entirely ────────────────
      seed({ id: "prov-gardssalg-scoped", navn: "Vitensenteret", producer_type: "bryggeri", kommune: "Trondheim" });

      // ── (d) rfb-seed row — must be excluded entirely ────────────────────────
      seed({ id: "prov-rfbseed-scoped", navn: "Vitensenteret", rfb_seed_source: "rfb-seed", kommune: "Trondheim" });

      // ── (e) catalog_hidden row — must be excluded entirely ──────────────────
      seed({ id: "prov-hidden", navn: "Vitensenteret", kommune: "Trondheim", catalog_hidden: 1 });

      // ── (f) already-merged row — must be excluded entirely ──────────────────
      seed({ id: "prov-already-merged", navn: "Vitensenteret", kommune: "Trondheim", merged_into: "prov-vit-c" });

      // ── (g) negative control ─────────────────────────────────────────────────
      seed({ id: "prov-negctrl-a", navn: "Nidarosdomen", kommune: "Trondheim" });
      seed({ id: "prov-negctrl-b", navn: "Bryggen i Bergen", kommune: "Bergen" });

      // ── (h) domain-signal row with raw contact fields, for the PII check ────
      seed({
        id: "prov-dom-a", navn: "Hotel Brosundet", kommune: "Ålesund",
        hjemmeside: "https://www.brosundet.no/hotell", epost: "post@brosundet.no", telefon: "70000000",
      });
      seed({
        id: "prov-dom-b", navn: "Brosundet Restaurant", kommune: "Ålesund",
        hjemmeside: "http://brosundet.no",
      });

      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      const snapshotBefore = expDb
        .prepare(
          `SELECT id, navn, org_nr, kommune, fylke, hjemmeside, rfb_seed_source, producer_type,
                  epost, telefon, content_source, catalog_hidden, merged_into
             FROM experience_providers ORDER BY id`,
        )
        .all();
      const countBefore = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/experiences-provider-dedup-audit without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.groups, "a2: no-key response carries no groups payload");

      const first = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(first.status, 200, "0: happy-path call -> 200");
      const groups: any[] = first.body.groups;
      assertTrue(Array.isArray(groups), "0b: response carries a groups array");

      function groupContaining(id: string): any | undefined {
        return groups.find((g) => g.rows.some((r: any) => r.id === id));
      }

      // ── (b) Vitensenteret group ──────────────────────────────────────────────
      const vit = groupContaining("prov-vit-a");
      assertTrue(!!vit, "b1: Vitensenteret i Trondheim lands in a group");
      assertEq(vit?.rows.length, 3, "b2: Vitensenteret group has exactly 3 rows (the excluded homonyms never appear here)");
      assertTrue(
        !!vit && vit.rows.some((r: any) => r.id === "prov-vit-b") && vit.rows.some((r: any) => r.id === "prov-vit-c"),
        "b3: all three Vitensenteret rows land in the SAME group",
      );
      assertEq(vit?.confidence, "low", "b4: LOW confidence — no identity-bearing signal, just a shared first token + kommune");

      // ── (c)/(d)/(e)/(f) scope exclusions ─────────────────────────────────────
      const allReturnedIds = new Set(groups.flatMap((g) => g.rows.map((r: any) => r.id)));
      assertTrue(!allReturnedIds.has("prov-gardssalg-scoped"), "c1: gårdssalg-scoped row (producer_type set) never appears in any group");
      assertTrue(!allReturnedIds.has("prov-rfbseed-scoped"), "d1: rfb-seed row never appears in any group");
      assertTrue(!allReturnedIds.has("prov-hidden"), "e1: catalog_hidden row never appears in any group");
      assertTrue(!allReturnedIds.has("prov-already-merged"), "f1: already-merged row never appears in any group");
      // 11 fixture rows total, 4 out-of-scope (gårdssalg-scoped, rfb-seed, hidden, already-merged).
      assertEq(first.body.total_providers_scanned, 7, "c2: total_providers_scanned excludes exactly the 4 out-of-scope rows");

      // ── (g) negative control ─────────────────────────────────────────────────
      assertTrue(!groupContaining("prov-negctrl-a"), "g1: Nidarosdomen (negative control) appears in NO group");
      assertTrue(!groupContaining("prov-negctrl-b"), "g2: Bryggen i Bergen (negative control) appears in NO group");

      // ── (h) response row shape / no raw PII ──────────────────────────────────
      const domGroup = groupContaining("prov-dom-a");
      assertTrue(!!domGroup, "h0: Brosundet domain-signal pair lands in a group");
      assertEq(domGroup?.confidence, "high", "h1: domain match is HIGH confidence");
      const sampleRow = domGroup.rows.find((r: any) => r.id === "prov-dom-a");
      assertEq(
        Object.keys(sampleRow).sort(),
        ["content_source", "fylke", "has_website", "id", "kommune", "navn", "org_nr"].sort(),
        "h2: row object carries only the documented fields",
      );
      const serialized = JSON.stringify(first.body);
      for (const pii of ["brosundet.no", "post@brosundet.no", "70000000"]) {
        assertTrue(!serialized.includes(pii), `h3: response never includes raw contact/domain value "${pii}"`);
      }

      // ── (i) zero net DB writes ────────────────────────────────────────────────
      const second = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(second.status, 200, "i1: second call -> 200");
      assertEq(second.body, first.body, "i2: second call returns byte-identical output to the first");

      const countAfter = (expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers`).get() as { n: number }).n;
      assertEq(countAfter, countBefore, "i3: row count unchanged after two calls");

      const snapshotAfter = expDb
        .prepare(
          `SELECT id, navn, org_nr, kommune, fylke, hjemmeside, rfb_seed_source, producer_type,
                  epost, telefon, content_source, catalog_hidden, merged_into
             FROM experience_providers ORDER BY id`,
        )
        .all();
      assertEq(snapshotAfter, snapshotBefore, "i4: every fixture row's raw columns are byte-identical before vs after two calls");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-provider-dedup-audit: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-provider-dedup-audit.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesProviderDedupAuditTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
