/**
 * opplevelser-gardssalg-content-quality-count.test.ts — tests for
 * GET /admin/gardssalg-content-quality-count (src/routes/opplevelser.ts).
 *
 * dev-request 2026-08-18-apningstider-ekstraktor-vindusgrenser, AC7: a
 * repeatable, guaranteed SINGLE-PASS full-catalog count of about_text/
 * visit_text/opening_hours_text defects, unlike POST /admin/gardssalg-
 * content-quality-update (whose selectGardssalgProvidersForQualityUpdate
 * only ever rotates a random/rolling subset per call). This route is
 * read-only (no network, no LLM, no writes) — reuses
 * listGardssalgFieldValuesForQualityUpdate() + classifyGardssalgFieldDefect()
 * exactly as the POST route's own othersFor()-based classification does.
 *
 * Mirrors opplevelser-gardssalg-provider-lookup.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle(),
 * X-Admin-Key passed via headers — this repo's convention, no HTTP server /
 * supertest needed, no fetch mocking needed since this route never touches
 * the network).
 *
 * Covers:
 *   (a) a clean catalog (no defects) -> defective: 0 for every field, clean
 *       matching the non-blank count.
 *   (b) a catalog with one defective value per field (css_js_leakage in
 *       about_text, placeholder in visit_text, too_short in
 *       opening_hours_text) -> correctly counted as defective with the
 *       right type in defect_types.
 *   (c) blank/null field values (incl. whitespace-only) counted as blank,
 *       not defective — matches classifyGardssalgFieldDefect's own contract
 *       (blank -> {defective:false, type:null}).
 *   (d) a catalog_hidden row is excluded from providers_scanned and every
 *       per-field count (same exclusion listGardssalgFieldValuesForQuality-
 *       Update already applies).
 *   (e) requireAdmin gating: GET without a valid X-Admin-Key is rejected
 *       (403), same pattern the sibling test files use for the POST route.
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
    const url = "/admin/gardssalg-content-quality-count";
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url,
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

export function runOpplevelserGardssalgContentQualityCountTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-content-quality-count-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const gqUpdatePath = require.resolve("../services/gardssalg-quality-update");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, gqUpdatePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      let expDb = dbFactory.getDb("experiences");
      let opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      function makeInsertProvider(db: any) {
        const stmt = db.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text,
              producer_type, enrichment_state, verification_status, source, confidence, catalog_hidden)
           VALUES
             (@id, @navn, 'experiences', @hjemmeside, NULL, @about_text, @visit_text, @opening_hours_text,
              'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', @catalog_hidden)`,
        );
        return function insertProvider(params: {
          id: string; navn: string;
          about_text?: string | null; visit_text?: string | null; opening_hours_text?: string | null;
          catalog_hidden?: number;
        }): void {
          stmt.run({
            id: params.id, navn: params.navn, hjemmeside: `https://${params.id}.example.no`,
            about_text: params.about_text ?? null, visit_text: params.visit_text ?? null,
            opening_hours_text: params.opening_hours_text ?? null,
            catalog_hidden: params.catalog_hidden ?? 0,
          });
        };
      }

      // ── (a) clean catalog — no defects anywhere ──────────────────────
      {
        let insertProvider = makeInsertProvider(expDb);
        insertProvider({
          id: "clean-p1", navn: "Clean Gard 1",
          about_text: "Vi driver et lite gårdsbruk i Telemark og produserer syltetøy og saft fra egne bær og frukttrær.",
          visit_text: "Besøkende er velkomne til gårdsbutikken vår hver lørdag, og vi tilbyr gjerne en kort omvisning på forespørsel.",
          opening_hours_text: "Åpent lørdager kl. 10-15, ellers etter avtale.",
        });
        insertProvider({
          id: "clean-p2", navn: "Clean Gard 2",
          about_text: "Gården vår ligger i Hedmark og vi lager honning og syltetøy av bær fra egen hage.",
          visit_text: "Kom gjerne innom butikken vår i sommerhalvåret, book gjerne besøk på forhånd via telefon.",
          opening_hours_text: "Man-fre 09-17, lør 10-14.",
        });

        const res = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
        assertEq(res.status, 200, "a1: GET with valid admin key -> 200");
        assertEq(res.body.providers_scanned, 2, "a2: providers_scanned matches the 2 clean fixtures");
        for (const field of ["about_text", "visit_text", "opening_hours_text"]) {
          const f = res.body.fields[field];
          assertEq(f.total, 2, `a3 (${field}): total === providers_scanned`);
          assertEq(f.blank, 0, `a4 (${field}): blank === 0 (both fixtures non-blank)`);
          assertEq(f.defective, 0, `a5 (${field}): defective === 0 for a fully clean catalog`);
          assertEq(f.clean, f.total - f.blank, `a6 (${field}): clean matches the non-blank count`);
          assertEq(f.defect_types, {}, `a7 (${field}): defect_types is empty when nothing is defective`);
        }
        assertTrue(typeof res.body.scanned_at === "string" && !Number.isNaN(Date.parse(res.body.scanned_at)), "a8: scanned_at is a parseable ISO timestamp");
      }

      // ── (b)/(c)/(d): defects per field, blanks, catalog_hidden exclusion ─
      {
        dbFactory.__resetDbFactoryForTesting();
        expDb = dbFactory.getDb("experiences");
        opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
        const insertProvider = makeInsertProvider(expDb);

        const CSS_LEAK = ".hero{color:#fff;padding:10px;} body{margin:0!important;} .nav{display:flex;}";

        insertProvider({
          id: "p1", navn: "Gard P1",
          about_text: "Vi er en liten gårdsbutikk på Sørlandet som lager most og eplecider fra egen frukthage.",
          visit_text: "Ta gjerne turen innom butikken vår i høstsesongen, vi holder til rett ved fylkesveien.",
          opening_hours_text: "Åpent fre-søn kl. 11-16 i sesong.",
        });
        insertProvider({
          id: "p2", navn: "Gard P2",
          about_text: CSS_LEAK, // defective: css_js_leakage
          visit_text: "Besøkende kan bestille omvisning på forhånd, vi tar imot grupper hele sommeren gjennom.",
          opening_hours_text: "Tirs-tors 12-18, ellers stengt.",
        });
        insertProvider({
          id: "p3", navn: "Gard P3",
          about_text: null, // blank
          visit_text: "under oppbygging", // defective: placeholder
          opening_hours_text: "   ", // blank (whitespace-only)
        });
        insertProvider({
          id: "p4", navn: "Gard P4",
          about_text: "Vi produserer flere typer sider og driver liten gårdsbutikk åpen i helgene gjennom sommeren.",
          visit_text: "Velkommen til å besøke oss i butikken, vi ligger kort vei fra riksveien og har egen parkering.",
          opening_hours_text: "10-14", // defective: too_short (< 8 chars floor is 8; this is 5)
        });
        // (d) catalog_hidden row — must be fully excluded, incl. from
        // providers_scanned and every per-field tally.
        insertProvider({
          id: "p5-hidden", navn: "Gard P5 Hidden",
          about_text: CSS_LEAK,
          visit_text: "under oppbygging",
          opening_hours_text: "10-14",
          catalog_hidden: 1,
        });

        const res = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
        assertEq(res.status, 200, "b1: GET with valid admin key -> 200");
        assertEq(res.body.providers_scanned, 4, "d1 (catalog_hidden): providers_scanned excludes the hidden row (4, not 5)");

        const about = res.body.fields.about_text;
        assertEq(about.total, 4, "b2 (about_text): total excludes the hidden row");
        assertEq(about.blank, 1, "c1 (about_text): p3's null value counted as blank");
        assertEq(about.clean, 2, "b3 (about_text): p1 + p4 counted clean");
        assertEq(about.defective, 1, "b4 (about_text): p2's CSS leakage counted defective");
        assertEq(about.defect_types, { css_js_leakage: 1 }, "b5 (about_text): defect_types attributes the right type");

        const visit = res.body.fields.visit_text;
        assertEq(visit.total, 4, "b6 (visit_text): total excludes the hidden row");
        assertEq(visit.blank, 0, "c2 (visit_text): no blank values among the 4 visible rows");
        assertEq(visit.clean, 3, "b7 (visit_text): p1 + p2 + p4 counted clean");
        assertEq(visit.defective, 1, "b8 (visit_text): p3's placeholder text counted defective");
        assertEq(visit.defect_types, { placeholder: 1 }, "b9 (visit_text): defect_types attributes the right type");

        const hours = res.body.fields.opening_hours_text;
        assertEq(hours.total, 4, "b10 (opening_hours_text): total excludes the hidden row");
        assertEq(hours.blank, 1, "c3 (opening_hours_text): p3's whitespace-only value counted blank, not defective");
        assertEq(hours.clean, 2, "b11 (opening_hours_text): p1 + p2 counted clean");
        assertEq(hours.defective, 1, "b12 (opening_hours_text): p4's too-short value counted defective");
        assertEq(hours.defect_types, { too_short: 1 }, "b13 (opening_hours_text): defect_types attributes the right type");

        // Sanity cross-check: every field's total/blank/clean/defective adds up.
        for (const field of ["about_text", "visit_text", "opening_hours_text"]) {
          const f = res.body.fields[field];
          assertEq(f.blank + f.clean + f.defective, f.total, `b14 (${field}): blank+clean+defective === total`);
        }

        // ── (e) requireAdmin gating ────────────────────────────────────
        const noKey = await callRoute(opplevelserRouter, { headers: {} });
        assertEq(noKey.status, 403, "e1: GET without X-Admin-Key -> 403");
        assertTrue(typeof noKey.body?.error === "string", "e2: 403 response carries an error message");

        const wrongKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
        assertEq(wrongKey.status, 403, "e3: GET with an incorrect X-Admin-Key -> 403");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-content-quality-count: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-content-quality-count.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgContentQualityCountTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
