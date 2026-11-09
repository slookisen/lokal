/**
 * opplevelser-bulk-load-catalog-facts.test.ts — katalogfakta slice S3c-i-a.
 *
 * POST /api/opplevelser/admin/bulk-load's BulkRowSchema is a z.object(),
 * which strips unknown keys silently — so a harvest row's min_age,
 * age_suitability, languages, group_min and group_max were dropped at the
 * door and never reached createExperience(). The schema now accepts the
 * five fields leniently, sanitizeBulkRowFacts() validates them, and ONLY
 * the NEW-experience insert path writes them. `facts_dropped` reports how
 * many values were rejected, in dry-run and apply alike.
 *
 * Conventions mirror opplevelser-bulk-load-provider-domain-dedup.test.ts:
 * in-memory experiences DB, fresh requires, router.handle(), Brreg stubbed
 * via __setBrregFetchForTesting, in-memory RFB db pinned for the
 * agent_blocklist gate. No evidence_url on any row, so the admission gate
 * never fires and globalThis.fetch needs no stub.
 */

import { sanitizeBulkRowFacts } from "./opplevelser";

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
  opts: { method?: "GET" | "POST"; url?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/bulk-load";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
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

export function runOpplevelserBulkLoadCatalogFactsTests(
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

  // ── Sanitizer unit cases (pure). ─────────────────────────────────────
  assertEq(
    sanitizeBulkRowFacts({ min_age: 6, age_suitability: "family", languages: ["no", "en"], group_min: 2, group_max: 20 }),
    { facts: { min_age: 6, group_min: 2, group_max: 20, age_suitability: "family", languages: ["no", "en"] }, dropped: [] },
    "cf-u1: all five valid values are kept",
  );
  assertEq(sanitizeBulkRowFacts({}), { facts: {}, dropped: [] }, "cf-u2: absent fields are absent, not dropped");
  assertEq(
    sanitizeBulkRowFacts({ min_age: null, age_suitability: null, languages: null, group_min: null, group_max: null }),
    { facts: {}, dropped: [] },
    "cf-u3: null fields are absent, not dropped",
  );
  assertEq(
    sanitizeBulkRowFacts({ min_age: 100, group_min: 0, group_max: 1001 }),
    { facts: {}, dropped: ["min_age", "group_min", "group_max"] },
    "cf-u4: out-of-range min_age/group_min/group_max are dropped",
  );
  assertEq(
    sanitizeBulkRowFacts({ min_age: 0, group_min: 1, group_max: 1000 }),
    { facts: { min_age: 0, group_min: 1, group_max: 1000 }, dropped: [] },
    "cf-u5: boundary values 0 / 1 / 1000 are kept",
  );
  assertEq(
    sanitizeBulkRowFacts({ min_age: 4.5, group_min: "abc", group_max: -3 }),
    { facts: {}, dropped: ["min_age", "group_min", "group_max"] },
    "cf-u6: non-integer / non-numeric / negative values are dropped",
  );
  assertEq(
    sanitizeBulkRowFacts({ group_min: 30, group_max: 10 }),
    { facts: {}, dropped: ["group_min", "group_max"] },
    "cf-u7: group_min > group_max drops BOTH",
  );
  assertEq(
    sanitizeBulkRowFacts({ min_age: " 12 ", group_min: "2", group_max: "15" }),
    { facts: { min_age: 12, group_min: 2, group_max: 15 }, dropped: [] },
    "cf-u8: digit strings are accepted as integers",
  );
  assertEq(
    sanitizeBulkRowFacts({ age_suitability: "  Adults " }),
    { facts: { age_suitability: "adults" }, dropped: [] },
    "cf-u9: age_suitability is case-insensitive and trimmed",
  );
  assertEq(
    sanitizeBulkRowFacts({ age_suitability: "teens" }),
    { facts: {}, dropped: ["age_suitability"] },
    "cf-u10: unknown age_suitability is dropped",
  );
  assertEq(
    sanitizeBulkRowFacts({ languages: ["nb", "NN", " En ", "no"] }),
    { facts: { languages: ["no", "en"] }, dropped: [] },
    "cf-u11: nb/nn map to no, codes lowercased/trimmed and deduped",
  );
  assertEq(
    sanitizeBulkRowFacts({ languages: ["en", "xx", "klingon"] }),
    { facts: { languages: ["en"] }, dropped: ["languages:xx", "languages:klingon"] },
    "cf-u12: unknown codes are filtered and recorded, valid ones kept",
  );
  assertEq(
    sanitizeBulkRowFacts({ languages: ["xx"] }),
    { facts: {}, dropped: ["languages:xx"] },
    "cf-u13: an all-invalid non-empty array yields no languages and a drop",
  );
  assertEq(
    sanitizeBulkRowFacts({ languages: "no,en" }),
    { facts: {}, dropped: ["languages"] },
    "cf-u14: a non-array languages value is dropped",
  );
  assertEq(
    sanitizeBulkRowFacts({ languages: [] }),
    { facts: {}, dropped: [] },
    "cf-u15: an empty array is neither stored nor dropped",
  );

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "bulk-load-catalog-facts-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const experienceBrregPath = require.resolve("../services/experience-brreg");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, experienceBrregPath, opplevelserPath];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

    let prevRfbDb: unknown = null;
    let expBrreg: typeof import("../services/experience-brreg") | null = null;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      expBrreg = require("../services/experience-brreg") as typeof import("../services/experience-brreg");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const initMod = require("../database/init") as typeof import("../database/init");
      const RfbDatabase = require("better-sqlite3") as typeof import("better-sqlite3");
      prevRfbDb = initMod.__peekDbForTesting();
      const rfbDb = new RfbDatabase(":memory:");
      initMod.__setDbForTesting(rfbDb as any);
      initMod.__initSchemaForTesting(rfbDb as any);

      // Brreg stub: "Faktagården AS" resolves verified_active; anything else
      // returns no hits.
      expBrreg.__setBrregFetchForTesting(async (url: string) => {
        const navn = decodeURIComponent(new URL(url).searchParams.get("navn") || "");
        if (!navn.toLowerCase().includes("faktagården")) {
          return { ok: true, status: 200, json: async () => ({ _embedded: { enheter: [] } }) };
        }
        const enheter = [{
          organisasjonsnummer: "955555555",
          navn: navn.toUpperCase(),
          naeringskode1: { kode: "01.130" },
          konkurs: false,
          underAvvikling: false,
          underTvangsavviklingEllerTvangsopplosning: false,
          slettedato: null,
        }];
        return { ok: true, status: 200, json: async () => ({ _embedded: { enheter } }) };
      });

      type FactRow = {
        id: string;
        min_age: number | null;
        age_suitability: string | null;
        languages: string | null;
        group_min: number | null;
        group_max: number | null;
      };
      const experienceByTitle = (title: string) =>
        expDb
          .prepare("SELECT id, min_age, age_suitability, languages, group_min, group_max FROM experiences WHERE title = ?")
          .get(title) as FactRow | undefined;
      const experienceCount = () =>
        (expDb.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number }).n;

      const base = { provider_name: "Faktagården AS", category: "mat_drikke", kommune: "Lier" };

      // ── Dry-run: facts_dropped reported, nothing written. ──────────────
      const rDry = await callRoute(opplevelserRouter, {
        headers: adminHeaders,
        body: {
          experiences: [
            { ...base, title: "Ostesmaking på gården", min_age: 6, age_suitability: "family", languages: ["nb", "en"], group_min: 2, group_max: 20 },
            { ...base, title: "Epleslang for barn", min_age: 150, languages: ["en", "xx"] },
          ],
        },
      });
      assertEq(rDry.status, 200, "cf-d1: dry-run -> 200");
      assertEq(rDry.body.dry_run, true, "cf-d2: response is a dry-run");
      assertEq(rDry.body.facts_dropped, 2, "cf-d3: dry-run reports facts_dropped (min_age 150 + language xx)");
      assertEq(experienceCount(), 0, "cf-d4: dry-run wrote no experiences");

      // ── Apply: valid facts stored, invalid value -> NULL, row created. ──
      const rApply = await callRoute(opplevelserRouter, {
        headers: adminHeaders,
        body: {
          apply: true,
          experiences: [
            { ...base, title: "Ostesmaking på gården", min_age: "6", age_suitability: "Family", languages: ["nb", "en"], group_min: 2, group_max: 20 },
            { ...base, title: "Epleslang for barn", min_age: 150, age_suitability: "teens", languages: "norsk", group_min: 40, group_max: 10 },
          ],
        },
      });
      assertEq(rApply.status, 200, "cf-a1: apply -> 200");
      assertEq(rApply.body.experiences_inserted, 2, "cf-a2: both rows inserted — invalid facts never reject a row");
      assertEq(rApply.body.facts_dropped, 5, "cf-a3: apply reports facts_dropped (min_age, age_suitability, languages, group_min, group_max)");
      const ost = experienceByTitle("Ostesmaking på gården");
      assertEq(
        ost && { min_age: ost.min_age, age_suitability: ost.age_suitability, languages: JSON.parse(ost.languages ?? "null"), group_min: ost.group_min, group_max: ost.group_max },
        { min_age: 6, age_suitability: "family", languages: ["no", "en"], group_min: 2, group_max: 20 },
        "cf-a4: the new experience stores all five facts (nb mapped to no)",
      );
      const eple = experienceByTitle("Epleslang for barn");
      assertEq(
        eple && { min_age: eple.min_age, age_suitability: eple.age_suitability, languages: eple.languages, group_min: eple.group_min, group_max: eple.group_max },
        { min_age: null, age_suitability: null, languages: null, group_min: null, group_max: null },
        "cf-a5: invalid values are stored as NULL while the row is still created",
      );

      // ── Existing experience re-sent with facts: NOT written. ────────────
      const beforeCount = experienceCount();
      const rResend = await callRoute(opplevelserRouter, {
        headers: adminHeaders,
        body: {
          apply: true,
          experiences: [
            { ...base, title: "Epleslang for barn", min_age: 4, age_suitability: "kids", languages: ["no"], group_min: 1, group_max: 8, price_from: 250, duration_min: 90 },
          ],
        },
      });
      assertEq(rResend.status, 200, "cf-e1: re-send apply -> 200");
      assertEq(rResend.body.experiences_inserted, 0, "cf-e2: no new experience inserted for the existing title");
      assertEq(experienceCount(), beforeCount, "cf-e3: experience count unchanged");
      const epleAfter = experienceByTitle("Epleslang for barn");
      assertEq(
        epleAfter && { min_age: epleAfter.min_age, age_suitability: epleAfter.age_suitability, languages: epleAfter.languages, group_min: epleAfter.group_min, group_max: epleAfter.group_max },
        { min_age: null, age_suitability: null, languages: null, group_min: null, group_max: null },
        "cf-e4: facts are NOT written onto the existing experience",
      );
      assertEq(rResend.body.facts_dropped, 0, "cf-e5: facts_dropped is 0 when every value is valid");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-bulk-load-catalog-facts: unexpected error: " + String(err?.stack || err?.message || err),
      );
    } finally {
      try {
        expBrreg?.__setBrregFetchForTesting(null);
      } catch { /* best-effort */ }
      try {
        if (prevRfbDb) {
          (require("../database/init") as typeof import("../database/init")).__setDbForTesting(prevRfbDb as any);
        }
      } catch { /* best-effort */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-bulk-load-catalog-facts.test.ts`
if (require.main === module) {
  runOpplevelserBulkLoadCatalogFactsTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
