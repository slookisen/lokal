/**
 * dental-agent-provenance.test.ts — unit tests for the additive
 * `provenance` summary field on GET /api/tannlege/agents/:id
 * (src/routes/dental.ts).
 *
 * dev-request 2026-07-13-proveniens-transparens-side, slice 2
 * (orch-pr-20260725-proveniens-api-provenance): same additive
 * `provenance: { sources: [...], last_verified: "..." }` rollup as the
 * marketplace/rfb vertical (marketplace-agent-provenance.test.ts), reusing
 * dental_agents.field_provenance (already hydrated onto the DentalAgent
 * object by dental-store.ts's hydrateAgent) + dental_agents.last_verified_at
 * (a column that exists in the schema but was never read/exposed before
 * this slice — read directly in the route, see the comment above the route
 * change in dental.ts).
 *
 * Setup mirrors dental-agent-put-field-provenance.test.ts's convention:
 * DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting() (runs
 * the real production dental schema via initDentalSchema), fresh require of
 * the dental router + dental-store + db-factory (module-cache busted so
 * every module rebinds to the fresh :memory: connection), exercised via
 * router.handle() so the route's own logic (not a hand-picked handler) runs
 * end to end.
 *
 * Covers (acceptance criteria 1, 2, 5 of the dev-request):
 *   (a) presence: a clinic with real field_provenance + last_verified_at
 *       gets `agent.provenance` with deduped sources.
 *   (b) absence: a clinic with no field_provenance never gets the key.
 *   (c) absence: a clinic with field_provenance but no last_verified_at
 *       also omits the key.
 *   (d) additive-regression: every other field of the response for a
 *       clinic without provenance data is unchanged from a direct
 *       getDentalAgentById() read (the same data the route builds from).
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
  opts: { method?: string; path: string; headers?: Record<string, string> },
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

export function runDentalAgentProvenanceTests(
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
    process.env.DENTAL_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const dentalStorePath = require.resolve("../services/dental-store");
    const cachePaths = [dbFactoryPath, dentalPath, dentalStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, hjemmeside, telefon, field_provenance, last_verified_at)
         VALUES (@id, @navn, @hjemmeside, @telefon, @field_provenance, @last_verified_at)`,
      );

      // (a) real, well-sourced field_provenance + a verification timestamp
      insertAgent.run({
        id: "clinic-with-prov",
        navn: "Klinikk Med Proveniens AS",
        hjemmeside: "https://med-proveniens.example.no",
        telefon: "22334455",
        field_provenance: JSON.stringify({
          adresse: [
            { source_type: "brreg", value: "Gata 1, 0150 Oslo", fetched_at: "2026-07-01T00:00:00.000Z" },
            { source_type: "google_places", value: "Gata 1, 0150 Oslo", fetched_at: "2026-07-02T00:00:00.000Z" },
          ],
          telefon: [{ source_type: "brreg", value: "22334455", fetched_at: "2026-07-01T00:00:00.000Z" }], // dup "brreg" -> deduped
        }),
        last_verified_at: "2026-07-18T09:00:00.000Z",
      });

      // (b) no provenance at all
      insertAgent.run({
        id: "clinic-no-prov",
        navn: "Klinikk Uten Proveniens AS",
        hjemmeside: "https://uten-proveniens.example.no",
        telefon: null,
        field_provenance: null,
        last_verified_at: "2026-07-18T09:00:00.000Z",
      });

      // (c) has field_provenance but no last_verified_at
      insertAgent.run({
        id: "clinic-unverified",
        navn: "Klinikk Ikke Verifisert AS",
        hjemmeside: "https://ikke-verifisert.example.no",
        telefon: "99887766",
        field_provenance: JSON.stringify({
          telefon: [{ source_type: "homepage", value: "99887766", fetched_at: "2026-07-01T00:00:00.000Z" }],
        }),
        last_verified_at: null,
      });

      const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;
      const { getDentalAgentById } = require("../services/dental-store") as typeof import("../services/dental-store");

      // ── (a) presence + dedup ─────────────────────────────────────────────
      {
        const r = await callRoute(dentalRouter, { path: "/agents/clinic-with-prov" });
        assertEq(r.status, 200, "a1: clinic-with-prov -> 200");
        assertTrue(!!r.body?.agent?.provenance, "a2: provenance key present when field_provenance + last_verified_at exist");
        assertEq(r.body.agent.provenance.sources, ["brreg", "google_places"], "a3: sources deduped");
        assertEq(r.body.agent.provenance.last_verified, "2026-07-18T09:00:00.000Z", "a4: last_verified matches dental_agents.last_verified_at exactly");
      }

      // ── (b) absence: no field_provenance ─────────────────────────────────
      {
        const r = await callRoute(dentalRouter, { path: "/agents/clinic-no-prov" });
        assertEq(r.status, 200, "b1: clinic-no-prov -> 200");
        assertTrue(!("provenance" in r.body.agent), "b2: provenance key genuinely absent when field_provenance is NULL");
      }

      // ── (c) absence: no last_verified_at ─────────────────────────────────
      {
        const r = await callRoute(dentalRouter, { path: "/agents/clinic-unverified" });
        assertTrue(!("provenance" in r.body.agent), "c1: provenance key absent when last_verified_at is NULL, even with real field_provenance");
      }

      // ── (d) additive-regression: other fields unchanged ──────────────────
      {
        const r = await callRoute(dentalRouter, { path: "/agents/clinic-no-prov" });
        const { provenance, ...rest } = r.body.agent as Record<string, unknown>;
        const direct = getDentalAgentById("clinic-no-prov") as Record<string, unknown>;
        // route additionally normalizes telefon/mobil via isDisplayablePhone —
        // telefon is null in this fixture either way, so direct comparison holds.
        assertTrue(!!direct, "d1: setup — getDentalAgentById returns a value for clinic-no-prov");
        assertEq(rest, direct, "d2: additive regression — every non-provenance field of the route response matches a direct getDentalAgentById() read exactly");
      }
    } catch (err: any) {
      failed++;
      failures.push("dental-agent-provenance: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevDentalPath;
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

// Standalone runner: `npx tsx src/routes/dental-agent-provenance.test.ts`
if (require.main === module) {
  runDentalAgentProvenanceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
