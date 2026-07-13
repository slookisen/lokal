/**
 * opplevelser-discover-tags.test.ts — pins the wiring of the derived
 * cross-cutting filter tags (services/experience-tags.ts) into the two
 * response surfaces flagged as the follow-up in
 * dev-requests/2026-07-04-opplevagent-taksonomi-filtre.md's build log
 * (lokal#145 review caveat): REST `GET /api/opplevelser/discover` and the
 * `Experience` OpenAPI schema. `tags` was already present on every hydrated
 * row (hydrateExperience() in experience-store.ts) — this only covers the
 * two places that previously whitelisted-and-dropped it.
 *
 * MCP tool coverage note: `discover_experiences`/`get_experience` (both now
 * also emit `tags`) have no existing direct-unit-test harness in this repo
 * (experiences-mcp.ts registers its tools as closures over an McpServer
 * instance, unlike dental-mcp.ts's exported buildSearchResults) — this test
 * does not add one; it is scoped to the REST + OpenAPI surfaces, which are
 * independently observable and match the existing test-coverage boundary
 * for this router (see admin-db-table-sizes.test.ts / oa-home-counters.test.ts
 * for the router.handle() + EXPERIENCES_DB_PATH=":memory:" pattern reused
 * here).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-discover-tags.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserDiscoverTagsTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : null });
    });
  });
}

export function runOpplevelserDiscoverTagsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const openapiPath = require.resolve("../services/experiences-openapi");
    for (const p of [dbFactoryPath, expStorePath, opplevelserPath, openapiPath]) {
      delete require.cache[p];
    }

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences");

      // Fixture: a free (price_from=0), verified Oslo experience — must
      // derive the "gratis" and "familievennlig" tags (age_suitability
      // = "family" per experience-tags.ts's heuristic).
      const providerId = expStore.createProvider({
        navn: "Oslo Friluft AS", fylke: "Oslo", kommune: "Oslo",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const experienceId = expStore.createExperience({
        title: "Gratis byvandring i Oslo", provider_id: providerId,
        provider_match_status: "matched", kommune: "Oslo", fylke: "Oslo",
        verification_status: "verified", confidence: "high",
        price_from: 0, price_band: "gratis",
        age_suitability: "family", indoor_outdoor: "outdoor",
      });
      // title_no is populated by a separate backfill (createExperience never
      // writes it — see experience-store.ts's INSERT column list), so it's
      // set here the same way orch-pr-titleno-render's fixture does: a raw
      // UPDATE against the real db handle.
      const TITLE_NO = "Gratis byvandring i Oslo sentrum";
      db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run(TITLE_NO, experienceId);

      // ── REST GET /api/opplevelser/discover ──────────────────────────
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const res = await callRoute(opplevelserRouter, "/discover?fylke=Oslo");
      assertTrue(res.handled, "a1: GET /discover is handled");
      assertEq(res.status, 200, "a2: GET /discover returns 200");
      assertEq(res.body.count, 1, "a3: GET /discover finds the 1 fixture row");
      const row = res.body.results[0];
      assertTrue(Array.isArray(row.tags), "a4: result row carries a tags array");
      assertTrue(row.tags.includes("gratis"), "a5: tags includes 'gratis' (price_from=0)");
      assertTrue(row.tags.includes("familievennlig"), "a6: tags includes 'familievennlig' (age_suitability=familie)");
      assertEq(row.title_no, TITLE_NO, "a7: result row carries the backfilled title_no value");

      // ── OpenAPI Experience schema ────────────────────────────────────
      const { getExperiencesOpenapi } = require("../services/experiences-openapi") as typeof import("../services/experiences-openapi");
      const spec: any = getExperiencesOpenapi();
      const experienceSchema = spec.components.schemas.Experience;
      assertTrue(!!experienceSchema.properties.tags, "b1: Experience schema declares a 'tags' property");
      assertEq(experienceSchema.properties.tags.type, "array", "b2: tags property is typed as an array");
      assertTrue(experienceSchema.properties.tags.items.enum.includes("gratis"), "b3: tags enum includes 'gratis'");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-discover-tags: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of [dbFactoryPath, expStorePath, opplevelserPath, openapiPath]) {
        delete require.cache[p];
      }
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-discover-tags.test.ts`
if (require.main === module) {
  runOpplevelserDiscoverTagsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
