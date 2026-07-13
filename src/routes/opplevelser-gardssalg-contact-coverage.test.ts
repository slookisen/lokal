/**
 * opplevelser-gardssalg-contact-coverage.test.ts — tests for
 * GET /admin/gardssalg-contact-coverage (src/routes/opplevelser.ts), added
 * as Slice 2 PREP of dev-request
 * 2026-07-12-gardssalg-go-live-gate-dark-launch-og-onboarding: a read-only
 * contact-field coverage report over the seeded gårdssalg providers
 * (rfb_seed_source = 'rfb-seed'), needed before drafting onboarding outreach.
 *
 * Mirrors opplevelser-discover-geo.test.ts's setup (EXPERIENCES_DB_PATH=
 * ":memory:", fresh require of db-factory + opplevelser router per run) and
 * admin-db-table-sizes.test.ts's callRoute() (raw req/res exercised directly
 * against router.handle(), X-Admin-Key passed via headers — this repo's
 * convention, no HTTP server / supertest needed).
 *
 * Fixtures are inserted with a direct SQL INSERT against the in-memory
 * experiences DB (mirroring the raw INSERT the /admin/rfb-seed handler
 * itself uses) rather than through experience-store's createProvider(),
 * since createProvider() doesn't expose rfb_seed_source.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) happy path with mixed coverage — correct per-field counts, correct
 *       reachable count (email OR phone), correct unreachable list (id+navn
 *       only — never raw epost/telefon/hjemmeside/adresse values anywhere in
 *       the response), non-rfb-seed providers excluded, whitespace-only
 *       field values treated as absent (trimmed)
 *   (c) zero-provider edge case — no rfb-seed rows at all
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
      url: "/admin/gardssalg-contact-coverage",
      originalUrl: "/admin/gardssalg-contact-coverage",
      path: "/admin/gardssalg-contact-coverage",
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

export function runOpplevelserGardssalgContactCoverageTests(
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
    const testKey = "gardssalg-contact-coverage-test-key";
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
           (id, navn, vertical, rfb_seed_source, epost, telefon, hjemmeside, adresse,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @rfb_seed_source, @epost, @telefon, @hjemmeside, @adresse,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── (b) mixed-coverage fixtures ─────────────────────────────────────
      // Full coverage: has everything → reachable, contributes to all counts.
      insertProvider.run({
        id: "prov-full", navn: "Fullt Gårdssalg AS", rfb_seed_source: "rfb-seed",
        epost: "post@fulltgardssalg.no", telefon: "12345678",
        hjemmeside: "https://fulltgardssalg.no", adresse: "Gårdsveien 1, 1234 Sted",
      });
      // Website + address only, no email/phone → unreachable, counts toward
      // with_website/with_address but not with_email/with_phone/reachable.
      insertProvider.run({
        id: "prov-website-only", navn: "Nettside Gård", rfb_seed_source: "rfb-seed",
        epost: null, telefon: null,
        hjemmeside: "https://nettsidegard.no", adresse: "Bakkevegen 2",
      });
      // Phone only → reachable via phone, no website/address.
      insertProvider.run({
        id: "prov-phone-only", navn: "Telefon Gård", rfb_seed_source: "rfb-seed",
        epost: null, telefon: "98765432", hjemmeside: null, adresse: null,
      });
      // Whitespace-only email/phone (never legitimately populated that way,
      // but proves the presence check trims rather than treating any
      // non-null string as "has a value") → unreachable, no counts anywhere.
      insertProvider.run({
        id: "prov-blank", navn: "Blank Gård", rfb_seed_source: "rfb-seed",
        epost: "   ", telefon: "\t", hjemmeside: "", adresse: null,
      });
      // Non-rfb-seed provider (e.g. manually claimed/enriched) → must be
      // completely excluded from the report, in both counts and totals.
      insertProvider.run({
        id: "prov-not-seeded", navn: "Ikke Seedet AS", rfb_seed_source: null,
        epost: "post@ikkeseedet.no", telefon: "11223344",
        hjemmeside: "https://ikkeseedet.no", adresse: "Et sted 3",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET /admin/gardssalg-contact-coverage without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.total_providers, "a2: no-key response carries no report payload");

      // Wrong key must also be rejected.
      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a3: GET /admin/gardssalg-contact-coverage with wrong X-Admin-Key -> 403");

      // ── (b) happy path with mixed coverage ──────────────────────────────
      const ok = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "b1: GET /admin/gardssalg-contact-coverage (valid key) -> 200");
      assertEq(ok.body.total_providers, 4, "b2: total_providers counts only rfb-seed rows (4, not 5)");
      assertEq(ok.body.with_email, 1, "b3: with_email counts only prov-full (blank/whitespace excluded)");
      assertEq(ok.body.with_phone, 2, "b4: with_phone counts prov-full + prov-phone-only");
      assertEq(ok.body.with_website, 2, "b5: with_website counts prov-full + prov-website-only (empty string excluded)");
      assertEq(ok.body.with_address, 2, "b6: with_address counts prov-full + prov-website-only");
      assertEq(ok.body.reachable, 2, "b7: reachable counts prov-full (email) + prov-phone-only (phone)");

      assertTrue(Array.isArray(ok.body.unreachable), "b8: unreachable is an array");
      const unreachableIds = ok.body.unreachable.map((r: any) => r.provider_id).sort();
      assertEq(unreachableIds, ["prov-blank", "prov-website-only"], "b9: unreachable lists exactly the no-email-and-no-phone providers");
      const websiteOnlyEntry = ok.body.unreachable.find((r: any) => r.provider_id === "prov-website-only");
      assertEq(websiteOnlyEntry?.navn, "Nettside Gård", "b10: unreachable entry carries navn");
      assertEq(Object.keys(websiteOnlyEntry).sort(), ["navn", "provider_id"], "b11: unreachable entry has ONLY provider_id + navn — no epost/telefon/hjemmeside/adresse keys");

      // No raw PII anywhere in the serialized response — the endpoint must
      // never leak actual contact values, only booleans/counts/id/navn.
      const serialized = JSON.stringify(ok.body);
      for (const pii of [
        "post@fulltgardssalg.no", "12345678", "fulltgardssalg.no", "Gårdsveien 1",
        "nettsidegard.no", "Bakkevegen 2", "98765432",
      ]) {
        assertTrue(!serialized.includes(pii), `b12: response never includes raw PII value "${pii}"`);
      }

      // ── (c) zero-provider edge case ─────────────────────────────────────
      expDb.prepare("DELETE FROM experience_providers").run();
      const empty = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(empty.status, 200, "c1: zero-provider case still returns 200");
      assertEq(empty.body.total_providers, 0, "c2: total_providers is 0");
      assertEq(empty.body.with_email, 0, "c3: with_email is 0");
      assertEq(empty.body.with_phone, 0, "c4: with_phone is 0");
      assertEq(empty.body.with_website, 0, "c5: with_website is 0");
      assertEq(empty.body.with_address, 0, "c6: with_address is 0");
      assertEq(empty.body.reachable, 0, "c7: reachable is 0");
      assertEq(empty.body.unreachable, [], "c8: unreachable is an empty array");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-contact-coverage: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-contact-coverage.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgContactCoverageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
