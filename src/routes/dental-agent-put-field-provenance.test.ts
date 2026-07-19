/**
 * dental-agent-put-field-provenance.test.ts — regression tests for
 * PUT /api/tannlege/agents/:id (src/routes/dental.ts).
 *
 * orch-pr-20260719-dental-field-provenance: Stage X (the external
 * enrichment worker, scheduled-agents/dental-agent-enrichment.md in the
 * A2A repo) writes extracted clinic data via a sequence of PER-FIELD PUTs.
 * Before this fix, a field_provenance patch on this route was passed
 * straight through to updateDentalAgent() and JSON.stringify'd over the
 * existing column — so PUT #2's field_provenance clobbered PUT #1's
 * instead of accumulating. The fix merges the incoming field_provenance
 * against what's already on the row via the shared mergeFieldProvenance()
 * helper (src/routes/admin-knowledge.ts), the same idiom already used by
 * the Google Places homepage-backfill block elsewhere in dental.ts.
 *
 * Setup mirrors dental-agents-recently-enriched.test.ts (this repo's
 * convention for testing dental.ts routes): fresh in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting() (so
 * the real production dental schema is created), fresh require of the
 * dental router per run, exercised via router.handle() directly (so the
 * requireAdmin middleware chain runs for real) rather than a live HTTP
 * server.
 *
 * Covers:
 *   (a) PUT field_provenance for a field that already has provenance on
 *       the row -> merge (old AND new source entries both present).
 *   (b) PUT field_provenance when the row had none -> merge against {}
 *       populates the column correctly.
 *   (c) PUT with NO field_provenance key in the body -> the existing
 *       field_provenance column is completely untouched (regression
 *       guard: proves normal non-provenance PUTs are unaffected).
 *   (d) Malformed/junk JSON already in the field_provenance column is
 *       tolerated (no throw, treated as empty) when a provenance PUT
 *       comes in.
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
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: opts.method || "GET",
      url: opts.path,
      originalUrl: opts.path,
      path: opts.path,
      params: {},
      query: {},
      headers: opts.headers || {},
      body: opts.body,
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

export function runDentalAgentPutFieldProvenanceTests(
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
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "dental-put-field-provenance-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const dentalStorePath = require.resolve("../services/dental-store");
    // NOTE: dental-store.ts holds its own `import { getDb } from
    // "../database/db-factory"` binding, resolved at ITS require time. If
    // an earlier test block in the shared `npm test` run already required
    // dental-store (e.g. any of the PR-108/PR-120/etc dental-store tests),
    // it's cached bound to a STALE db-factory module instance whose
    // module-level `handles` Map holds a *different* :memory: connection —
    // so our fresh insertAgent rows below would be invisible to
    // getDentalAgentById/updateDentalAgent (called from dental.ts's PUT
    // handler via that stale dental-store binding), and the PUT would 404.
    // Clearing dental-store here too (mirroring the PR-120 test's
    // cachePaths pattern) forces it to re-bind to the fresh db-factory
    // instance created below.
    const cachePaths = [dbFactoryPath, dentalPath, dentalStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, field_provenance)
         VALUES (@id, @navn, @hjemmeside, @telefon, @field_provenance)`,
      );

      // (a)/(d) subject: already has phone provenance from a prior "google_places" PUT.
      insertAgent.run({
        id: "clinic-existing-prov",
        navn: "Eksisterende Provenance Tannlege AS",
        hjemmeside: "https://eksisterende.example.no",
        telefon: "12345678",
        field_provenance: JSON.stringify({
          phone: [{ source_type: "google_places", value: "12345678", fetched_at: "2026-07-01T00:00:00.000Z" }],
        }),
      });

      // (b) subject: no provenance at all yet.
      insertAgent.run({
        id: "clinic-no-prov",
        navn: "Ingen Provenance Tannlege AS",
        hjemmeside: "https://ingen.example.no",
        telefon: null,
        field_provenance: null,
      });

      // (c) subject: has provenance, PUT will NOT touch field_provenance.
      insertAgent.run({
        id: "clinic-untouched",
        navn: "Uberørt Tannlege AS",
        hjemmeside: "https://uberort.example.no",
        telefon: "99999999",
        field_provenance: JSON.stringify({
          phone: [{ source_type: "google_places", value: "99999999", fetched_at: "2026-07-01T00:00:00.000Z" }],
        }),
      });

      // (d) subject: junk JSON already sitting in the column.
      insertAgent.run({
        id: "clinic-junk-prov",
        navn: "Rar Provenance Tannlege AS",
        hjemmeside: "https://rar.example.no",
        telefon: "11112222",
        field_provenance: "{not valid json",
      });

      const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;

      function getProvColumn(id: string): string | null {
        const row = dentalDb.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get(id) as
          | { field_provenance: string | null }
          | undefined;
        return row?.field_provenance ?? null;
      }

      // ── (a) merge: existing provenance + new provenance both present ──
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-existing-prov",
          headers: { "x-admin-key": testKey },
          body: {
            field_provenance: {
              phone: {
                sources: [
                  { source_type: "hjemmeside_scrape", value: "12345678", fetched_at: "2026-07-19T00:00:00.000Z" },
                ],
              },
            },
          },
        });
        assertEq(resp.status, 200, "a1: PUT field_provenance for a field w/ existing provenance -> 200");

        const raw = getProvColumn("clinic-existing-prov");
        assertTrue(!!raw, "a2: field_provenance column populated after PUT");
        const parsed = raw ? JSON.parse(raw) : {};
        assertTrue(Array.isArray(parsed.phone), "a3: phone provenance is an array");
        const sourceTypes = (parsed.phone || []).map((r: any) => r.source_type).sort();
        assertEq(
          sourceTypes,
          ["google_places", "hjemmeside_scrape"],
          "a4: BOTH old (google_places) and new (hjemmeside_scrape) source entries present — merge, not overwrite",
        );
      }

      // ── (b) merge against {} — no prior provenance ──────────────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-no-prov",
          headers: { "x-admin-key": testKey },
          body: {
            field_provenance: {
              website: {
                sources: [
                  { source_type: "hjemmeside_scrape", value: "https://ingen.example.no", fetched_at: "2026-07-19T00:00:00.000Z" },
                ],
              },
            },
          },
        });
        assertEq(resp.status, 200, "b1: PUT field_provenance for a field w/ no prior provenance -> 200");

        const raw = getProvColumn("clinic-no-prov");
        assertTrue(!!raw, "b2: field_provenance column populated from empty");
        const parsed = raw ? JSON.parse(raw) : {};
        assertTrue(Array.isArray(parsed.website) && parsed.website.length === 1, "b3: new website provenance entry stored");
        assertEq(parsed.website[0].source_type, "hjemmeside_scrape", "b4: new entry has the right source_type");
      }

      // ── (c) NO field_provenance in body -> column completely untouched ──
      {
        const before = getProvColumn("clinic-untouched");
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-untouched",
          headers: { "x-admin-key": testKey },
          body: {
            telefon: "88887777", // some other field, no field_provenance key at all
          },
        });
        assertEq(resp.status, 200, "c1: PUT without field_provenance -> 200");

        const rowAfter = dentalDb
          .prepare("SELECT telefon, field_provenance FROM dental_agents WHERE id = ?")
          .get("clinic-untouched") as { telefon: string; field_provenance: string | null };
        assertEq(rowAfter.telefon, "88887777", "c2: the field that WAS in the body (telefon) was written");
        assertEq(rowAfter.field_provenance, before, "c3: field_provenance column byte-identical to before (regression guard)");
      }

      // ── (d) malformed existing JSON tolerated, doesn't throw ────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "PUT",
          path: "/agents/clinic-junk-prov",
          headers: { "x-admin-key": testKey },
          body: {
            field_provenance: {
              phone: {
                sources: [
                  { source_type: "hjemmeside_scrape", value: "11112222", fetched_at: "2026-07-19T00:00:00.000Z" },
                ],
              },
            },
          },
        });
        assertEq(resp.status, 200, "d1: PUT field_provenance over junk existing JSON -> 200 (no throw)");

        const raw = getProvColumn("clinic-junk-prov");
        assertTrue(!!raw && raw !== "{not valid json", "d2: junk JSON replaced with valid JSON");
        const parsed = raw ? JSON.parse(raw) : {};
        assertTrue(Array.isArray(parsed.phone) && parsed.phone.length === 1, "d3: junk treated as empty — only the new entry present");
        assertEq(parsed.phone[0].source_type, "hjemmeside_scrape", "d4: new entry recorded correctly despite prior junk");
      }
    } catch (err: any) {
      failed++;
      failures.push("dental-agent-put-field-provenance: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

// Standalone runner: `npx tsx src/routes/dental-agent-put-field-provenance.test.ts`
if (require.main === module) {
  runDentalAgentPutFieldProvenanceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
