/**
 * opplevelser-gardssalg-provider-lookup.test.ts — tests for
 * GET /admin/gardssalg-provider-lookup (src/routes/opplevelser.ts).
 *
 * Closes a gap surfaced while targeting /admin/gardssalg-content-refresh at
 * two just-registered+seeded providers (Bringebærlandet, Klostergården
 * Håndbryggeri): /admin/rfb-seed only ever returns candidate NAMES, never the
 * new experience_providers.id it assigns. This endpoint is a narrow,
 * read-only, case-insensitive substring lookup by navn -> id (+
 * rfb_seed_source + created_at), so a single provider can be targeted
 * without a wide auto-select that would also touch unrelated older rows.
 *
 * Mirrors opplevelser-gardssalg-contact-coverage.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle(),
 * X-Admin-Key passed via headers — this repo's convention, no HTTP server /
 * supertest needed).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) substring match found — including a partial substring, and only the
 *       matching row(s) returned
 *   (c) no match -> 200 with an empty matches array (not 404/500)
 *   (d) missing/blank navn param -> 400, no query executed
 *   (e) case-insensitivity
 *   (f) response never carries epost/telefon/hjemmeside/adresse — only
 *       id/navn/rfb_seed_source/created_at
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
  opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const query = opts.query || {};
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method: "GET",
      url: "/admin/gardssalg-provider-lookup" + qs,
      originalUrl: "/admin/gardssalg-provider-lookup" + qs,
      path: "/admin/gardssalg-provider-lookup",
      query,
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

export function runOpplevelserGardssalgProviderLookupTests(
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
    const testKey = "gardssalg-provider-lookup-test-key";
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

      insertProvider.run({
        id: "prov-bringebaerlandet", navn: "Bringebærlandet AS", rfb_seed_source: "rfb-seed",
        epost: "post@bringebaerlandet.no", telefon: "12345678",
        hjemmeside: "https://bringebaerlandet.no", adresse: "Bærveien 1, 1234 Sted",
      });
      insertProvider.run({
        id: "prov-klostergarden", navn: "Klostergården Håndbryggeri", rfb_seed_source: "rfb-seed",
        epost: "post@klostergarden.no", telefon: "87654321",
        hjemmeside: "https://klostergarden.no", adresse: "Klostervegen 2, 4321 Sted",
      });
      // An unrelated older raw provider, not seeded — must never surface in
      // a name-scoped lookup for the two providers above, and proves the
      // substring match doesn't accidentally sweep in unrelated rows.
      insertProvider.run({
        id: "prov-unrelated", navn: "Et Helt Annet Gårdsbryggeri", rfb_seed_source: null,
        epost: null, telefon: null, hjemmeside: null, adresse: null,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, { query: { navn: "Bringebærlandet" } });
      assertEq(noKey.status, 403, "a1: GET /admin/gardssalg-provider-lookup without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.matches, "a2: no-key response carries no matches payload");

      // ── (b) substring match found (exact + partial) ─────────────────────
      const exact = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { navn: "Bringebærlandet" },
      });
      assertEq(exact.status, 200, "b1: exact-name lookup -> 200");
      assertEq(exact.body.matches.length, 1, "b2: exact-name lookup returns exactly one match");
      assertEq(exact.body.matches[0].id, "prov-bringebaerlandet", "b3: exact-name match carries the right id");
      assertEq(exact.body.matches[0].navn, "Bringebærlandet AS", "b4: exact-name match carries navn");

      const partial = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { navn: "Klostergården" },
      });
      assertEq(partial.status, 200, "b5: partial-substring lookup -> 200");
      assertEq(partial.body.matches.length, 1, "b6: partial-substring lookup returns exactly one match");
      assertEq(partial.body.matches[0].id, "prov-klostergarden", "b7: partial-substring match carries the right id");
      assertTrue(
        !partial.body.matches.some((m: any) => m.id === "prov-bringebaerlandet" || m.id === "prov-unrelated"),
        "b8: partial-substring lookup does not sweep in unrelated providers",
      );

      // ── (c) no match -> 200 with empty array ────────────────────────────
      const noMatch = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { navn: "Ingen Slik Gård Finnes" },
      });
      assertEq(noMatch.status, 200, "c1: no-match lookup still returns 200");
      assertEq(noMatch.body.matches, [], "c2: no-match lookup returns an empty matches array");

      // ── (d) missing / blank navn -> 400 ──────────────────────────────────
      const missing = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(missing.status, 400, "d1: missing navn param -> 400");
      assertTrue(typeof missing.body?.error === "string" && missing.body.error.length > 0, "d2: missing navn param carries a clear error message");

      const blank = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { navn: "   " },
      });
      assertEq(blank.status, 400, "d3: blank (whitespace-only) navn param -> 400");

      // ── (e) case-insensitivity ───────────────────────────────────────────
      const upperCase = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { navn: "BRINGEBÆRLANDET" },
      });
      assertEq(upperCase.status, 200, "e1: upper-case navn lookup -> 200");
      assertEq(upperCase.body.matches.length, 1, "e2: upper-case navn lookup still matches");
      assertEq(upperCase.body.matches[0].id, "prov-bringebaerlandet", "e3: upper-case navn lookup matches the right id");

      const lowerCase = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { navn: "klostergården håndbryggeri" },
      });
      assertEq(lowerCase.status, 200, "e4: lower-case navn lookup -> 200");
      assertEq(lowerCase.body.matches.length, 1, "e5: lower-case navn lookup still matches");
      assertEq(lowerCase.body.matches[0].id, "prov-klostergarden", "e6: lower-case navn lookup matches the right id");

      // ── (f) no contact fields ever present in the response ──────────────
      assertEq(
        Object.keys(exact.body.matches[0]).sort(),
        ["created_at", "id", "navn", "rfb_seed_source"].sort(),
        "f1: match object has ONLY id/navn/rfb_seed_source/created_at — no contact fields",
      );
      const serialized = JSON.stringify(exact.body) + JSON.stringify(partial.body);
      for (const pii of [
        "post@bringebaerlandet.no", "12345678", "bringebaerlandet.no", "Bærveien 1",
        "post@klostergarden.no", "87654321", "klostergarden.no", "Klostervegen 2",
      ]) {
        assertTrue(!serialized.includes(pii), `f2: response never includes raw PII value "${pii}"`);
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-provider-lookup: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-provider-lookup.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgProviderLookupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
