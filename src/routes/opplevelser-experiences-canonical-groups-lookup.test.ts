/**
 * opplevelser-experiences-canonical-groups-lookup.test.ts — tests for
 * GET /admin/experiences-canonical-groups (src/routes/opplevelser.ts).
 *
 * dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
 * FUNN "experiences-dedup-audit-mangler-navnesok-over-ikke-suspect-grupper".
 * Companion read-only lookup for POST
 * /admin/experiences-canonical-group-merge: resolves a canonical group's id
 * from a business-name substring, covering RAW rows that GET
 * /admin/experiences-dedup-audit (suspect-only) and GET
 * /admin/experiences-provider-dedup-audit (still-duplicated providers only)
 * can never surface. Route wiring + the pure lookup logic in
 * services/experience-dedup-audit.ts (findCanonicalGroupsByTitle) are both
 * covered here.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) missing/blank title_contains -> 400
 *   (c) match on a MERGED (non-canonical) row's title resolves to its FULL
 *       group — canonical anchor + every sibling, not just the matching row
 *   (d) match on the CANONICAL anchor's own title works the same way
 *   (e) a canonical row with zero merged siblings (a lone business) is still
 *       found — the lookup does not require a 'suspect' row to exist
 *   (f) case-insensitive substring match (not exact/whole-word)
 *   (g) no match -> empty groups array, still 200/success
 *   (h) two DISTINCT unrelated groups sharing a common substring both come
 *       back, each with only its own members (no cross-contamination)
 *   (i) zero-write: a lookup call makes no DB changes
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
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const url = opts.url || "/admin/experiences-canonical-groups";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: opts.query || {},
      headers: opts.headers || {},
      body: opts.body ?? {},
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserExperiencesCanonicalGroupsLookupTests(
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
    const testKey = process.env.ADMIN_KEY || "experiences-canonical-groups-lookup-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, kommune, content_source, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @kommune, NULL, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({ id: "prov-ringve", navn: "Ringve Museum", kommune: "Trondheim" });
      insertProvider.run({ id: "prov-other", navn: "Unrelated Museum", kommune: "Trondheim" });
      insertProvider.run({ id: "prov-lone", navn: "Lone Provider", kommune: "Oslo" });

      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, kommune, canonical_id, merged_from, enrichment_state, verification_status)
         VALUES (@id, @provider_id, @title, @kommune, @canonical_id, @merged_from, 'raw', 'pending_verify')`,
      );

      // ── (c)/(d)/(f)/(i) — an internally-consistent group with NO suspect
      // row: the real Ringve shape this lookup exists for. 3 rows, one
      // canonical anchor + two already-merged siblings.
      insertExperience.run({ id: "exp-ringve-anchor", provider_id: "prov-ringve", title: "Omvisning på Ringve Museum", kommune: "Trondheim", canonical_id: null, merged_from: JSON.stringify(["exp-ringve-dupe-1", "exp-ringve-dupe-2"]) });
      insertExperience.run({ id: "exp-ringve-dupe-1", provider_id: "prov-ringve", title: "Konsert på RINGVE museum", kommune: "Trondheim", canonical_id: "exp-ringve-anchor", merged_from: null });
      insertExperience.run({ id: "exp-ringve-dupe-2", provider_id: "prov-ringve", title: "Ringve omvisning kveld", kommune: "Trondheim", canonical_id: "exp-ringve-anchor", merged_from: null });

      // ── (e) a lone canonical row, zero merged siblings.
      insertExperience.run({ id: "exp-lone", provider_id: "prov-lone", title: "Enslig Opplevelse Uten Duplikater", kommune: "Oslo", canonical_id: null, merged_from: null });

      // ── (h) a second, DISTINCT group that shares the substring "museum"
      // with the Ringve group above but must never mix members with it.
      insertExperience.run({ id: "exp-other-anchor", provider_id: "prov-other", title: "Omvisning på Unrelated Museum", kommune: "Trondheim", canonical_id: null, merged_from: JSON.stringify(["exp-other-dupe-1"]) });
      insertExperience.run({ id: "exp-other-dupe-1", provider_id: "prov-other", title: "Unrelated Museum kveldstur", kommune: "Trondheim", canonical_id: "exp-other-anchor", merged_from: null });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { query: { title_contains: "Ringve" } });
      assertEq(noKey.status, 403, "a1: GET .../experiences-canonical-groups without X-Admin-Key -> 403");

      // ── (b) missing/blank title_contains -> 400 ─────────────────────────
      const missing = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: {} });
      assertEq(missing.status, 400, "b1: missing title_contains -> 400");

      const blank = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: { title_contains: "   " } });
      assertEq(blank.status, 400, "b2: blank (whitespace-only) title_contains -> 400");

      const snapshotBefore = expDb
        .prepare(`SELECT id, provider_id, title, canonical_id, merged_from FROM experiences ORDER BY id`)
        .all();

      // ── (c)/(d)/(f) match on a merged sibling's title, case-insensitive,
      // resolves to the FULL group (anchor + both siblings) ───────────────
      const bySibling = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: { title_contains: "ringve" } });
      assertEq(bySibling.status, 200, "c1: lookup by a merged sibling's title (lowercased query) -> 200");
      assertEq(bySibling.body.success, true, "c2: success:true");
      assertEq(bySibling.body.groups_returned, 1, "c3: exactly one group matches 'ringve'");
      const ringveGroup = bySibling.body.groups[0];
      assertEq(ringveGroup.canonical_id, "exp-ringve-anchor", "c4: resolved canonical_id is the group's real anchor, not the matching row's own id");
      assertEq(ringveGroup.canonical_title, "Omvisning på Ringve Museum", "c5: canonical_title is the anchor row's title");
      assertEq(ringveGroup.member_count, 3, "c6: member_count includes anchor + both siblings");
      assertEq(
        ringveGroup.members.map((m: any) => m.id).sort(),
        ["exp-ringve-anchor", "exp-ringve-dupe-1", "exp-ringve-dupe-2"],
        "c7: members lists the full group, not just the row whose title matched",
      );

      // ── (d) match on the CANONICAL anchor's own title works the same way
      const byAnchor = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: { title_contains: "Omvisning på Ringve" } });
      assertEq(byAnchor.status, 200, "d1: lookup by the canonical anchor's own title -> 200");
      assertEq(byAnchor.body.groups[0].canonical_id, "exp-ringve-anchor", "d2: same group resolved via the anchor row");

      // ── (e) lone canonical row with zero merged siblings is still found
      const lone = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: { title_contains: "Enslig" } });
      assertEq(lone.status, 200, "e1: lookup for a lone (never-merged) row -> 200");
      assertEq(lone.body.groups_returned, 1, "e2: the lone row's own single-member group is found");
      assertEq(lone.body.groups[0].member_count, 1, "e3: member_count is 1 (no siblings)");
      assertEq(lone.body.groups[0].members[0].id, "exp-lone", "e4: the sole member is the row itself");

      // ── (g) no match -> empty groups, still 200/success ─────────────────
      const noMatch = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: { title_contains: "Nonexistent Business Xyz" } });
      assertEq(noMatch.status, 200, "g1: no-match query -> 200 (not a 404)");
      assertEq(noMatch.body.success, true, "g2: success:true even with zero matches");
      assertEq(noMatch.body.groups_returned, 0, "g3: groups_returned:0");
      assertEq(noMatch.body.groups, [], "g4: groups is an empty array");

      // ── (h) shared substring across two distinct groups -> both returned,
      // no cross-contamination of members ──────────────────────────────────
      const shared = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, query: { title_contains: "museum" } });
      assertEq(shared.status, 200, "h1: substring shared by two distinct groups -> 200");
      assertEq(shared.body.groups_returned, 2, "h2: both distinct groups come back");
      const byCanonicalId = new Map(shared.body.groups.map((g: any) => [g.canonical_id, g]));
      assertTrue(byCanonicalId.has("exp-ringve-anchor"), "h3: Ringve group present");
      assertTrue(byCanonicalId.has("exp-other-anchor"), "h4: Unrelated Museum group present");
      assertEq(
        (byCanonicalId.get("exp-ringve-anchor") as any).members.map((m: any) => m.id).sort(),
        ["exp-ringve-anchor", "exp-ringve-dupe-1", "exp-ringve-dupe-2"],
        "h5: Ringve group's members are exactly its own three rows",
      );
      assertEq(
        (byCanonicalId.get("exp-other-anchor") as any).members.map((m: any) => m.id).sort(),
        ["exp-other-anchor", "exp-other-dupe-1"],
        "h6: Unrelated Museum group's members are exactly its own two rows — no bleed from the Ringve group",
      );

      // ── (i) zero-write: none of the lookups above changed the DB ────────
      const snapshotAfter = expDb
        .prepare(`SELECT id, provider_id, title, canonical_id, merged_from FROM experiences ORDER BY id`)
        .all();
      assertEq(snapshotAfter, snapshotBefore, "i1: lookup calls made zero DB writes");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-canonical-groups-lookup: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-canonical-groups-lookup.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesCanonicalGroupsLookupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
