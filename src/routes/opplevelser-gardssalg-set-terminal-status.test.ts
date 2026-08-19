/**
 * opplevelser-gardssalg-set-terminal-status.test.ts — tests for the new
 * explicit end-status write path (dev-request
 * 2026-08-19-kursjustering-drikkefunnel-llm-og-supply, Grep 3a — "Ærlig
 * kulling av de 296"):
 *
 *   - applyGardssalgSetTerminalStatus() (src/services/experience-store.ts)
 *   - POST /admin/gardssalg-set-terminal-status (src/routes/opplevelser.ts)
 *   - computeGardssalgReadinessTier's new HIGHEST-precedence terminal_status
 *     short-circuit (src/routes/opplevelser.ts)
 *   - GET /admin/gardssalg-outreach-readiness's krever_eier/dod_kilde summary
 *     buckets (src/routes/opplevelser.ts)
 *
 * Harness copied verbatim from
 * opplevelser-gardssalg-set-contact-phone.test.ts (EXPERIENCES_DB_PATH=
 * ":memory:", fresh require of db-factory + experience-store + opplevelser
 * router per run, callRoute() exercised directly against router.handle())
 * and adapted for this endpoint's three-valued (krever_eier | dod_kilde |
 * null) body shape instead of the phone guard's shape validation.
 *
 * Covers:
 *   (a) happy path: set terminal_status='dod_kilde' on a row that would
 *       otherwise derive 'unreachable' -> 200, DB row updated, one audit
 *       row, tier precedence proven via GET .../gardssalg-outreach-readiness
 *   (b) tier precedence: set terminal_status='krever_eier' on a row that
 *       would otherwise derive 'outreach_ready' (fully content-complete) ->
 *       readiness still reports 'krever_eier', proving terminal_status wins
 *       over EVERY other check, not just the low-precedence ones
 *   (c) rollback path: terminal_status: null clears the column -> row
 *       reappears in its ordinary derived tier on the next GET (acceptance
 *       probe from the dev-request's own spec)
 *   (d) unknown provider_id -> 404 provider_not_found
 *   (e) invalid terminal_status value ("foo") -> 400 invalid_terminal_status
 *   (f) missing provider_id -> 400 provider_id_required
 *   (g) missing/blank reason -> 400 reason_required
 *   (h) missing/wrong X-Admin-Key header -> 403
 *   (i) summary buckets: GET .../gardssalg-outreach-readiness's summary
 *       object carries krever_eier/dod_kilde as their OWN keys (0 when
 *       unused, not omitted), separate from unreachable/no_website
 *   (j) source_url fallback: when source_url is omitted, the audit row's
 *       source_url falls back to the reason text; when given, it is used
 *       verbatim instead
 *   (k) direct service-function coverage (mirrors route-level assertions)
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
    const method = opts.method || "POST";
    const url = opts.url || "/admin/gardssalg-set-terminal-status";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
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

export function runOpplevelserGardssalgSetTerminalStatusTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-set-terminal-status-test-key";
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

      const store = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fixtures ─────────────────────────────────────────────────────────
      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, epost, telefon, hjemmeside,
            about_text, products, brreg_verified, catalog_hidden, slug, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence,
            created_at)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @content_source, @epost, @telefon, @hjemmeside,
            @about_text, @products, @brreg_verified, @catalog_hidden, @slug, @field_provenance,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium',
            @created_at)`,
      );
      function mkProvider(p: Partial<Record<string, any>> & { id: string; navn: string }): void {
        insertProvider.run({
          org_nr: null, content_source: null, epost: null, telefon: null, hjemmeside: null,
          about_text: null, products: null, brreg_verified: 0, catalog_hidden: null, slug: null,
          field_provenance: null,
          created_at: "2026-01-01 00:00:00", ...p,
        });
      }
      function getProviderRow(id: string): any {
        return expDb.prepare(
          `SELECT id, terminal_status FROM experience_providers WHERE id = ?`
        ).get(id);
      }
      function getAuditRows(providerId: string): any[] {
        return expDb.prepare(
          `SELECT * FROM gardssalg_content_audit WHERE provider_id = ? ORDER BY rowid ASC`
        ).all(providerId);
      }
      async function getReadinessTier(providerId: string): Promise<string> {
        const res = await callRoute(opplevelserRouter, {
          method: "GET",
          url: "/admin/gardssalg-outreach-readiness",
          headers: auth,
        });
        const row = (res.body.providers as any[]).find((p) => p.id === providerId);
        return row?.readiness_tier;
      }

      const auth = { "x-admin-key": testKey };

      // ── (h) auth ─────────────────────────────────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: {} });
      assertEq(unauth.status, 403, "h: unauthenticated request -> 403");

      // ── (a) happy path: 'dod_kilde' on an otherwise-'unreachable' row ──────
      mkProvider({
        id: "sts-happy",
        navn: "Happy Path Gard",
        telefon: null,
        epost: null,
        created_at: "2026-01-01 00:00:00",
      });
      assertEq(await getReadinessTier("sts-happy"), "unreachable", "a0: derived tier is 'unreachable' before any terminal-status write");
      const happyRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sts-happy",
          terminal_status: "dod_kilde",
          reason: "domene NXDOMAIN siden 2026-06, verifisert manuelt",
        },
      });
      assertEq(happyRes.status, 200, "a1: happy path returns 200");
      assertEq(happyRes.body, {
        success: true,
        provider_id: "sts-happy",
        field: "terminal_status",
        old_value: null,
        new_value: "dod_kilde",
      }, "a2: response shape matches spec exactly");
      assertEq(getProviderRow("sts-happy").terminal_status, "dod_kilde", "a3: DB row terminal_status actually changed");
      const happyAudit = getAuditRows("sts-happy");
      assertEq(happyAudit.length, 1, "a4: exactly one audit row inserted");
      assertEq(happyAudit[0].field_name, "terminal_status", "a5: audit field_name is terminal_status");
      assertEq(happyAudit[0].old_value, null, "a6: audit old_value is the true pre-write null");
      assertEq(happyAudit[0].new_value, "dod_kilde", "a7: audit new_value is the written status");
      assertEq(happyAudit[0].changed_by, "admin", "a8: audit changed_by is 'admin'");
      assertEq(
        await getReadinessTier("sts-happy"),
        "dod_kilde",
        "a9: GET .../gardssalg-outreach-readiness now reports the row as dod_kilde, not unreachable",
      );

      // ── (b) tier precedence: 'krever_eier' beats a fully content-complete,
      //        otherwise-'outreach_ready' row ───────────────────────────────
      mkProvider({
        id: "sts-precedence",
        navn: "Precedence Gard",
        telefon: "90000002",
        epost: "kontakt@precedence.no",
        hjemmeside: "https://precedence.no",
        about_text: "Om oss...",
        products: "Sider",
        brreg_verified: 1,
        catalog_hidden: 0,
        slug: "precedence-gard",
        field_provenance: JSON.stringify({
          hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-01-02T00:00:00.000Z" },
        }),
        created_at: "2026-01-02 00:00:00",
      });
      assertEq(
        await getReadinessTier("sts-precedence"),
        "outreach_ready",
        "b0: derived tier is 'outreach_ready' before any terminal-status write (sanity check on the fixture)",
      );
      const precedenceRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sts-precedence",
          terminal_status: "krever_eier",
          reason: "eier bedt om pause i outreach",
        },
      });
      assertEq(precedenceRes.status, 200, "b1: terminal-status write on an outreach_ready row returns 200");
      assertEq(
        await getReadinessTier("sts-precedence"),
        "krever_eier",
        "b2: terminal_status wins over EVERY other precedence check, not just the low-precedence ones",
      );

      // ── (c) rollback path: terminal_status: null clears it ─────────────────
      const rollbackRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sts-precedence",
          terminal_status: null,
          reason: "feilaktig markert, angre",
        },
      });
      assertEq(rollbackRes.status, 200, "c1: rollback (terminal_status: null) returns 200");
      assertEq(rollbackRes.body.old_value, "krever_eier", "c2: old_value is the prior terminal_status");
      assertEq(rollbackRes.body.new_value, null, "c3: new_value is null");
      assertEq(getProviderRow("sts-precedence").terminal_status, null, "c4: DB row cleared");
      assertEq(
        await getReadinessTier("sts-precedence"),
        "outreach_ready",
        "c5: row is back to its ordinary derived tier (rollback acceptance probe)",
      );

      // ── (d) unknown provider_id -> 404 ──────────────────────────────────────
      const notFoundRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "does-not-exist",
          terminal_status: "dod_kilde",
          reason: "test",
        },
      });
      assertEq(notFoundRes.status, 404, "d1: unknown provider_id -> 404");
      assertEq(notFoundRes.body.error, "provider_not_found", "d2: error code is provider_not_found");

      // ── (e) invalid terminal_status value -> 400 ────────────────────────────
      const invalidRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sts-happy",
          terminal_status: "foo",
          reason: "test",
        },
      });
      assertEq(invalidRes.status, 400, "e1: invalid terminal_status -> 400");
      assertEq(invalidRes.body.error, "invalid_terminal_status", "e2: error code is invalid_terminal_status");
      assertEq(getProviderRow("sts-happy").terminal_status, "dod_kilde", "e3: DB row UNCHANGED — no write happened");

      // ── (f) missing provider_id -> 400 ──────────────────────────────────────
      const missingProviderIdRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { terminal_status: "dod_kilde", reason: "test" },
      });
      assertEq(missingProviderIdRes.status, 400, "f1: missing provider_id -> 400");
      assertEq(missingProviderIdRes.body.error, "provider_id_required", "f2: error code is provider_id_required");

      // ── (g) missing/blank reason -> 400 ─────────────────────────────────────
      const missingReasonRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sts-happy", terminal_status: "dod_kilde" },
      });
      assertEq(missingReasonRes.status, 400, "g1: missing reason -> 400");
      assertEq(missingReasonRes.body.error, "reason_required", "g2: error code is reason_required");

      const blankReasonRes = await callRoute(opplevelserRouter, {
        headers: auth,
        body: { provider_id: "sts-happy", terminal_status: "dod_kilde", reason: "   " },
      });
      assertEq(blankReasonRes.status, 400, "g3: blank reason -> 400 reason_required");

      // ── (i) summary buckets on GET .../gardssalg-outreach-readiness ────────
      const readinessRes = await callRoute(opplevelserRouter, {
        method: "GET",
        url: "/admin/gardssalg-outreach-readiness",
        headers: auth,
      });
      assertEq(readinessRes.status, 200, "i1: readiness GET returns 200");
      assertTrue(
        typeof readinessRes.body.summary.krever_eier === "number",
        "i2: summary.krever_eier is present as its own numeric key",
      );
      assertTrue(
        typeof readinessRes.body.summary.dod_kilde === "number",
        "i3: summary.dod_kilde is present as its own numeric key",
      );
      assertEq(readinessRes.body.summary.dod_kilde, 1, "i4: summary.dod_kilde counts sts-happy exactly once");
      // sts-precedence was rolled back to null in (c), so it must NOT still
      // count in krever_eier — proves the bucket reflects live state, not a
      // stale write.
      assertEq(readinessRes.body.summary.krever_eier, 0, "i5: summary.krever_eier is 0 after the (c) rollback — not double-counted");
      assertEq(readinessRes.body.summary.outreach_ready >= 1, true, "i6: sts-precedence is counted back under outreach_ready, not lost");

      // ── (j) source_url fallback vs explicit override ────────────────────────
      mkProvider({
        id: "sts-provenance",
        navn: "Provenance Gard",
        created_at: "2026-01-03 00:00:00",
      });
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sts-provenance",
          terminal_status: "dod_kilde",
          reason: "domene NXDOMAIN, ingen kilde-URL å oppgi",
        },
      });
      const fallbackAudit = getAuditRows("sts-provenance");
      assertEq(
        fallbackAudit[0].source_url,
        "domene NXDOMAIN, ingen kilde-URL å oppgi",
        "j1: source_url falls back to reason text when source_url is omitted",
      );

      mkProvider({
        id: "sts-provenance-url",
        navn: "Provenance URL Gard",
        created_at: "2026-01-04 00:00:00",
      });
      await callRoute(opplevelserRouter, {
        headers: auth,
        body: {
          provider_id: "sts-provenance-url",
          terminal_status: "krever_eier",
          reason: "eier tok kontakt, ber om pause",
          source_url: "https://mail.example/thread/abc123",
        },
      });
      const explicitAudit = getAuditRows("sts-provenance-url");
      assertEq(
        explicitAudit[0].source_url,
        "https://mail.example/thread/abc123",
        "j2: source_url is used verbatim when given, NOT overridden by reason",
      );

      // ── (k) direct service-function coverage ────────────────────────────────
      mkProvider({
        id: "sts-service-direct",
        navn: "Service Direct Gard",
        created_at: "2026-01-05 00:00:00",
      });
      const directResult = store.applyGardssalgSetTerminalStatus(
        "sts-service-direct", "dod_kilde", "direktetest", undefined
      );
      assertTrue(directResult.ok === true, "k1: direct service call succeeds");
      if (directResult.ok) {
        assertEq(directResult.old_value, null, "k2: direct call returns correct old_value");
        assertEq(directResult.new_value, "dod_kilde", "k3: direct call returns correct new_value");
      }
      const directNotFound = store.applyGardssalgSetTerminalStatus(
        "does-not-exist", "dod_kilde", "direktetest", undefined
      );
      assertTrue(directNotFound.ok === false, "k4: direct service call reports not-found for unknown id");
      if (!directNotFound.ok) {
        assertEq(directNotFound.reason, "provider_not_found", "k5: direct rejection reports provider_not_found");
      }
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-set-terminal-status.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgSetTerminalStatusTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
