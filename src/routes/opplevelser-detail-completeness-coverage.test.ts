/**
 * opplevelser-detail-completeness-coverage.test.ts — tests for
 * GET /admin/detail-completeness-coverage (src/routes/opplevelser.ts), added
 * for dev-request 2026-07-04-opplevagent-dedup-og-norske-titler, item 3
 * ("detail completeness weave"): a read-only, catalog-wide (not scoped to
 * gårdssalg / rfb-seed) coverage report over booking_url/phone/website field
 * presence across ALL published experiences — the same "published" gate
 * (PUBLISH_GATE_SQL) the detail page and /discover already use.
 *
 * Mirrors opplevelser-gardssalg-contact-coverage.test.ts's setup (in-memory
 * EXPERIENCES_DB_PATH, fresh require of db-factory + experience-store +
 * opplevelser router per run, callRoute() against router.handle() with
 * X-Admin-Key headers — no HTTP server / supertest needed).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key / with a wrong key
 *   (b) happy path — five PUBLISHED rows with different booking_url/phone/
 *       website combinations produce the correct total + per-field
 *       count+pct (distinct values per field: 3/5=60%, 2/5=40%, 1/5=20%),
 *       whitespace-only values treated as absent (trimmed), a provider-less
 *       experience (provider_id NULL → LEFT JOIN NULLs) handled without
 *       fabricating phone/website
 *   (c) four NOT-published rows (pending_verify, confidence='low', provider
 *       brreg_active=0, canonical_id set / dedup-merged-away) are excluded
 *       from total_experiences and all counts, even though each one has
 *       booking_url + phone + website all present — proves the report
 *       follows the publish gate, not raw field presence over the whole table
 *   (d) zero-published-row edge case
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
      url: "/admin/detail-completeness-coverage",
      originalUrl: "/admin/detail-completeness-coverage",
      path: "/admin/detail-completeness-coverage",
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

export function runOpplevelserDetailCompletenessCoverageTests(
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
    const testKey = "detail-completeness-coverage-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, expStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── (b) five PUBLISHED rows, distinct field combinations ───────────
      const providerA = expStore.createProvider({
        navn: "Full Dekning AS", telefon: "11111111", hjemmeside: "https://a.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const providerB = expStore.createProvider({
        navn: "Kun Booking Og Telefon AS", telefon: "22222222", hjemmeside: null,
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const providerD = expStore.createProvider({
        navn: "Ingenting Gård", telefon: null, hjemmeside: null,
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const providerE = expStore.createProvider({
        navn: "Blank Felt AS", telefon: "\t", hjemmeside: "",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // R1: booking_url + phone + website all present.
      expStore.createExperience({
        title: "Full opplevelse", provider_id: providerA, provider_match_status: "matched",
        verification_status: "verified", confidence: "high",
        booking_url: "https://a.no/book",
      });
      // R2: booking_url + phone, no website.
      expStore.createExperience({
        title: "Booking og telefon", provider_id: providerB, provider_match_status: "matched",
        verification_status: "verified", confidence: "medium",
        booking_url: "https://b.no/book",
      });
      // R3: booking_url only, NO provider at all (provider_id NULL) — proves
      // the LEFT JOIN doesn't fabricate phone/website when there's no provider.
      expStore.createExperience({
        title: "Bare booking, ingen tilbyder", provider_match_status: "unmatched",
        verification_status: "verified", confidence: null,
        booking_url: "https://c.no/book",
      });
      // R4: none of the three fields present.
      expStore.createExperience({
        title: "Ingenting", provider_id: providerD, provider_match_status: "matched",
        verification_status: "verified", confidence: "high",
      });
      // R5: whitespace-only booking_url/phone, empty-string website — must
      // all be treated as absent (trimmed presence check).
      expStore.createExperience({
        title: "Blanke felt", provider_id: providerE, provider_match_status: "matched",
        verification_status: "verified", confidence: "high",
        booking_url: "   ",
      });

      // ── (c) NOT-published rows — each has ALL three fields present, to
      // prove exclusion is driven by the publish gate, not field presence ──
      const providerVerifiedActive = expStore.createProvider({
        navn: "Verifisert Aktiv AS", telefon: "99900001", hjemmeside: "https://excl.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const providerInactive = expStore.createProvider({
        navn: "Inaktiv AS", telefon: "99900002", hjemmeside: "https://excl2.no",
        brreg_verified: 1, brreg_active: 0, verification_status: "verified",
      });

      // X1: not verified yet (pending_verify).
      expStore.createExperience({
        title: "Ikke verifisert ennå", provider_id: providerVerifiedActive, provider_match_status: "matched",
        verification_status: "pending_verify", confidence: "high",
        booking_url: "https://excl.no/book",
      });
      // X2: verified but low confidence.
      expStore.createExperience({
        title: "Lav konfidens", provider_id: providerVerifiedActive, provider_match_status: "matched",
        verification_status: "verified", confidence: "low",
        booking_url: "https://excl.no/book",
      });
      // X3: verified + high confidence, but provider is brreg_active = 0.
      expStore.createExperience({
        title: "Tilbyder ikke aktiv", provider_id: providerInactive, provider_match_status: "matched",
        verification_status: "verified", confidence: "high",
        booking_url: "https://excl2.no/book",
      });
      // X4: dedup-merged-away duplicate (canonical_id set) — otherwise a
      // perfectly publishable row.
      const canonicalDupId = expStore.createExperience({
        title: "Duplikat, slått sammen", provider_id: providerVerifiedActive, provider_match_status: "matched",
        verification_status: "verified", confidence: "high",
        booking_url: "https://excl.no/book",
      });
      expDb.prepare("UPDATE experiences SET canonical_id = ? WHERE id = ?").run("some-other-canonical-id", canonicalDupId);

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without / with wrong X-Admin-Key ────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/detail-completeness-coverage without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.total_experiences, "a2: no-key response carries no report payload");

      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a3: GET /admin/detail-completeness-coverage with wrong X-Admin-Key -> 403");

      // ── (b)+(c) happy path ───────────────────────────────────────────────
      const ok = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "b1: GET /admin/detail-completeness-coverage (valid key) -> 200");
      assertEq(ok.body.total_experiences, 5, "b2: total_experiences counts only the 5 PUBLISHED rows (not the 4 excluded ones)");

      assertEq(ok.body.with_booking_url?.count, 3, "b3: with_booking_url.count is 3 (R1, R2, R3 — R4 null, R5 whitespace-only)");
      assertEq(ok.body.with_booking_url?.pct, 60, "b4: with_booking_url.pct is 60 (3/5)");
      assertEq(ok.body.with_phone?.count, 2, "b5: with_phone.count is 2 (R1, R2 — R3 no provider, R4 null, R5 whitespace-only)");
      assertEq(ok.body.with_phone?.pct, 40, "b6: with_phone.pct is 40 (2/5)");
      assertEq(ok.body.with_website?.count, 1, "b7: with_website.count is 1 (R1 only — R5's empty string excluded)");
      assertEq(ok.body.with_website?.pct, 20, "b8: with_website.pct is 20 (1/5)");

      // No raw PII leak beyond aggregate counts — same privacy posture as
      // gardssalg-contact-coverage (booleans/counts only, no raw values).
      const serialized = JSON.stringify(ok.body);
      for (const pii of ["11111111", "22222222", "99900001", "99900002", "https://a.no", "https://excl.no"]) {
        assertTrue(!serialized.includes(pii), `b9: response never includes raw value "${pii}"`);
      }

      // ── (d) zero-published-row edge case ────────────────────────────────
      expDb.prepare("DELETE FROM experiences").run();
      const empty = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(empty.status, 200, "d1: zero-row case still returns 200");
      assertEq(empty.body.total_experiences, 0, "d2: total_experiences is 0");
      assertEq(empty.body.with_booking_url, { count: 0, pct: 0 }, "d3: with_booking_url is {count:0, pct:0}, no divide-by-zero crash");
      assertEq(empty.body.with_phone, { count: 0, pct: 0 }, "d4: with_phone is {count:0, pct:0}");
      assertEq(empty.body.with_website, { count: 0, pct: 0 }, "d5: with_website is {count:0, pct:0}");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-detail-completeness-coverage: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-detail-completeness-coverage.test.ts`
if (require.main === module) {
  runOpplevelserDetailCompletenessCoverageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
