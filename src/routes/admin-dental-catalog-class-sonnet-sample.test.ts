/**
 * admin-dental-catalog-class-sonnet-sample.test.ts — unit tests for
 * POST /admin/dental/catalog-class-sonnet-sample
 * (src/routes/admin-dental-catalog-class-sonnet-sample.ts), dev-request
 * 2026-09-02-dental-catalog-class-triage, slice 1c.
 *
 * Setup mirrors admin-dental-mark-inactive.test.ts / dental-agent-
 * provenance.test.ts: fresh in-memory dental DB via
 * DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting() (runs
 * the real production dental schema, including catalog_class/
 * catalog_class_source/catalog_class_at and dental_exclusions), fresh
 * require of the route + dental-store per run, exercised via
 * router.handle() directly (X-Admin-Key passed via headers).
 *
 * judgeDentalCatalogClass is MOCKED — the real judge/API is never called.
 * Mirrors marketplace-quarantine-gates.test.ts's module-replacement seam:
 * tsx/esbuild compiles `import { judgeDentalCatalogClass } from "..."` as a
 * destructured `const { judgeDentalCatalogClass } = require(...)`, so
 * patching a property on the already-required module object after the fact
 * would NOT intercept the route's own destructure. Instead the ENTIRE
 * cached module at its resolved path is replaced with a fake exports object
 * BEFORE (re-)requiring the route, so the route's own require resolves to
 * the mock.
 *
 * Covers (per the build spec):
 *   (a) candidate SQL selects exactly the right cohort: ukjent OR
 *       company_dental_nace-klinikk, WITH hjemmeside, NOT already
 *       sonnet%-stamped — rows each violating exactly one condition are
 *       excluded.
 *   (b) dry-run (apply omitted/false) writes nothing at all.
 *   (c) apply:true + not_a_clinic verdict -> a dental_exclusions row appears
 *       AND verification_status becomes 'rejected'.
 *   (d) regression: apply:true + not_a_clinic verdict does NOT overwrite a
 *       pre-existing 'needs_review' row's verification_status (exclusion is
 *       still recorded).
 *   (e) apply:true + valid-class verdict -> catalog_class/
 *       catalog_class_source='sonnet'/catalog_class_at updated.
 *   (f) ukjent verdict -> zero writes for that row.
 *   (g) idempotency: a row already catalog_class_source='sonnet' never
 *       appears in a later call's candidate set even though it still
 *       matches the other conditions.
 *   (h) synthetic regression-test row "HØRSELSLABEN AS" (hearing-aid lab,
 *       naeringskode 86.230, organisasjonsform AS, no dental word so the
 *       rule engine would tag it klinikk/company_dental_nace today) with a
 *       MOCKED judge response of not_a_clinic proves the full pipeline
 *       (selection -> judged -> excluded -> rejected) end to end. Test
 *       fixture only — no hardcoded name check exists in production code.
 *
 * Standalone:
 *   npx tsx src/routes/admin-dental-catalog-class-sonnet-sample.test.ts
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
  opts: { method?: string; headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "POST",
      url: "/catalog-class-sonnet-sample",
      originalUrl: "/catalog-class-sonnet-sample",
      path: "/catalog-class-sonnet-sample",
      query: {},
      headers,
      body: opts.body,
      get(name: string) {
        return headers[name.toLowerCase()];
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

export function runAdminDentalCatalogClassSonnetSampleTests(
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
    const testKey = process.env.ADMIN_KEY || "dental-catalog-class-sonnet-sample-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const judgePath = require.resolve("../services/dental-catalog-class-judge");
    const dentalStorePath = require.resolve("../services/dental-store");
    const routePath = require.resolve("./admin-dental-catalog-class-sonnet-sample");
    const cachePaths = [dbFactoryPath, judgePath, dentalStorePath, routePath];
    for (const p of cachePaths) delete require.cache[p];

    // ── judgeDentalCatalogClass mock ────────────────────────────────────────
    // Keyed by `navn` -> a preset verdict. Every call is recorded (in order)
    // so tests can assert exactly which rows were selected/judged.
    const verdictsByNavn = new Map<string, { verdict_class: string; reason: string }>();
    const judgeCalls: Array<{ navn: string; currentClass: string }> = [];
    const mockJudge = async (params: { navn: string; currentClass: string }) => {
      judgeCalls.push({ navn: params.navn, currentClass: params.currentClass });
      const v = verdictsByNavn.get(params.navn);
      if (!v) throw new Error(`mock judge: no preset verdict for navn '${params.navn}'`);
      return v;
    };
    require.cache[judgePath] = {
      id: judgePath,
      filename: judgePath,
      loaded: true,
      exports: { judgeDentalCatalogClass: mockJudge },
    } as any;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");

      const routeMod = require("./admin-dental-catalog-class-sonnet-sample") as
        typeof import("./admin-dental-catalog-class-sonnet-sample");
      const router = routeMod.default as any;

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents
           (id, navn, naeringskode, organisasjonsform, hjemmeside, org_nr,
            catalog_class, catalog_class_source, catalog_class_at, verification_status, created_at)
         VALUES (@id, @navn, @naeringskode, @organisasjonsform, @hjemmeside, @org_nr,
                 @catalog_class, @catalog_class_source, @catalog_class_at, @verification_status, @created_at)`,
      );

      function seed(row: {
        id: string;
        navn: string;
        naeringskode?: string | null;
        organisasjonsform?: string | null;
        hjemmeside?: string | null;
        org_nr?: string | null;
        catalog_class?: string | null;
        catalog_class_source?: string | null;
        catalog_class_at?: string | null;
        verification_status?: string | null;
      }): void {
        insertAgent.run({
          id: row.id,
          navn: row.navn,
          naeringskode: row.naeringskode ?? null,
          organisasjonsform: row.organisasjonsform ?? null,
          hjemmeside: row.hjemmeside ?? null,
          org_nr: row.org_nr ?? null,
          catalog_class: row.catalog_class ?? null,
          catalog_class_source: row.catalog_class_source ?? null,
          catalog_class_at: row.catalog_class_at ?? null,
          verification_status: row.verification_status ?? null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(router, { method: "POST", headers, body });
      }

      // ═══════════════════════════════════════════════════════════════════
      // (a) candidate SQL — each row violates exactly one condition
      // ═══════════════════════════════════════════════════════════════════
      seed({ id: "a-ukjent-ok", navn: "A UKJENT SELSKAP AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://a-ukjent.no", catalog_class: "ukjent", catalog_class_source: null });
      seed({ id: "b-klinikk-company-nace-ok", navn: "B COMPANY NACE AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://b-company.no", catalog_class: "klinikk", catalog_class_source: "rules_v1:company_dental_nace" });
      seed({ id: "c-klinikk-dental-word-not-candidate", navn: "C TANNKLINIKK AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://c-tannklinikk.no", catalog_class: "klinikk", catalog_class_source: "rules_v1:dental_name_word" });
      seed({ id: "d-holding-not-candidate", navn: "D HOLDING AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://d-holding.no", catalog_class: "holding", catalog_class_source: "rules_v1:holding_name_word" });
      seed({ id: "e-null-hjemmeside-not-candidate", navn: "E NULL URL AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: null, catalog_class: "ukjent", catalog_class_source: null });
      seed({ id: "f-empty-hjemmeside-not-candidate", navn: "F EMPTY URL AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "", catalog_class: "ukjent", catalog_class_source: null });
      seed({ id: "g-already-sonnet-not-candidate", navn: "G ALREADY SONNET AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://g-already.no", catalog_class: "ukjent", catalog_class_source: "sonnet" });
      seed({ id: "h-klinikk-sonnet-source-not-candidate", navn: "H KLINIKK SONNET SOURCE AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://h-sonnet.no", catalog_class: "klinikk", catalog_class_source: "sonnet:some_rule" });

      verdictsByNavn.set("A UKJENT SELSKAP AS", { verdict_class: "ukjent", reason: "usikker" });
      verdictsByNavn.set("B COMPANY NACE AS", { verdict_class: "klinikk", reason: "bekreftet klinikk" });

      const cohortRun = await post({ limit: 50 });
      assertEq(cohortRun.status, 200, "a0: dry-run over the seeded cohort -> 200");
      const cohortNames = judgeCalls.map((c) => c.navn).sort();
      assertEq(
        cohortNames,
        ["A UKJENT SELSKAP AS", "B COMPANY NACE AS"].sort(),
        "a1: candidate SQL selects exactly the ukjent + company_dental_nace-klinikk rows with a hjemmeside and no sonnet% source",
      );
      assertTrue(!cohortNames.includes("C TANNKLINIKK AS"), "a2: klinikk via a DIFFERENT rule (dental_name_word) is excluded");
      assertTrue(!cohortNames.includes("D HOLDING AS"), "a3: holding class is excluded");
      assertTrue(!cohortNames.includes("E NULL URL AS"), "a4: NULL hjemmeside is excluded");
      assertTrue(!cohortNames.includes("F EMPTY URL AS"), "a5: empty-string hjemmeside is excluded");
      assertTrue(!cohortNames.includes("G ALREADY SONNET AS"), "a6: catalog_class_source='sonnet' is excluded");
      assertTrue(!cohortNames.includes("H KLINIKK SONNET SOURCE AS"), "a7: catalog_class_source='sonnet:some_rule' (LIKE 'sonnet%') is excluded");
      assertEq(cohortRun.body.data.scanned, 2, "a8: scanned count matches the true cohort size");

      // ═══════════════════════════════════════════════════════════════════
      // (b) dry-run writes nothing at all
      // ═══════════════════════════════════════════════════════════════════
      {
        const before = dentalDb.prepare("SELECT catalog_class, catalog_class_source, catalog_class_at, verification_status FROM dental_agents WHERE id IN ('a-ukjent-ok','b-klinikk-company-nace-ok')").all();
        assertEq(cohortRun.body.data.dry_run, true, "b1: apply omitted -> dry_run:true");
        const afterRows = dentalDb.prepare("SELECT catalog_class, catalog_class_source, catalog_class_at, verification_status FROM dental_agents WHERE id IN ('a-ukjent-ok','b-klinikk-company-nace-ok')").all();
        assertEq(afterRows, before, "b2: dry-run made zero DB writes to the candidate rows");
        const exclCount = (dentalDb.prepare("SELECT COUNT(*) AS n FROM dental_exclusions").get() as any).n;
        assertEq(exclCount, 0, "b3: dry-run recorded zero exclusions");

        const dryExplicitFalse = await post({ apply: false, limit: 50 });
        assertEq(dryExplicitFalse.body.data.dry_run, true, "b4: apply:false is also dry-run");
        const exclCountAfter = (dentalDb.prepare("SELECT COUNT(*) AS n FROM dental_exclusions").get() as any).n;
        assertEq(exclCountAfter, 0, "b5: apply:false made zero writes");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (c)+(f) apply:true — not_a_clinic excludes+rejects; ukjent writes nothing
      // ═══════════════════════════════════════════════════════════════════
      seed({ id: "i-not-a-clinic", navn: "I NOT A CLINIC AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://i-notaclinic.no", org_nr: "999000111", catalog_class: "klinikk", catalog_class_source: "rules_v1:company_dental_nace" });
      verdictsByNavn.set("I NOT A CLINIC AS", { verdict_class: "not_a_clinic", reason: "Dette er ikke en tannklinikk." });

      seed({ id: "j-ukjent-stays-ukjent", navn: "J STAYS UKJENT AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://j-ukjent.no", catalog_class: "ukjent", catalog_class_source: null });
      verdictsByNavn.set("J STAYS UKJENT AS", { verdict_class: "ukjent", reason: "fortsatt usikker" });

      const applyRun1 = await post({
        apply: true,
        limit: 50,
      });
      assertEq(applyRun1.status, 200, "c0: apply run -> 200");
      assertEq(applyRun1.body.data.dry_run, false, "c1: apply:true -> dry_run:false");

      {
        const exclRow = dentalDb.prepare("SELECT * FROM dental_exclusions WHERE org_nr = ?").get("999000111") as any;
        assertTrue(!!exclRow, "c2: not_a_clinic verdict creates a dental_exclusions row");
        assertEq(exclRow?.reason, "not_a_clinic", "c3: exclusion reason is 'not_a_clinic'");
        assertEq(exclRow?.evidence, "Dette er ikke en tannklinikk.", "c4: exclusion evidence carries the judge's reason");
        assertEq(exclRow?.excluded_by, "dental-catalog-class-sonnet-sample", "c5: excluded_by names this endpoint");

        const agentRow = dentalDb.prepare("SELECT verification_status, catalog_class, catalog_class_source FROM dental_agents WHERE id = ?").get("i-not-a-clinic") as any;
        assertEq(agentRow.verification_status, "rejected", "c6: verification_status becomes 'rejected'");
        assertEq(agentRow.catalog_class, "klinikk", "c7: catalog_class is left untouched on a not_a_clinic row");
        assertEq(agentRow.catalog_class_source, "rules_v1:company_dental_nace", "c8: catalog_class_source is left untouched on a not_a_clinic row");
      }

      {
        const jRow = dentalDb.prepare("SELECT catalog_class, catalog_class_source, catalog_class_at, verification_status FROM dental_agents WHERE id = ?").get("j-ukjent-stays-ukjent") as any;
        assertEq(jRow.catalog_class, "ukjent", "f1: ukjent verdict leaves catalog_class unchanged");
        assertEq(jRow.catalog_class_source, null, "f2: ukjent verdict leaves catalog_class_source unchanged (not stamped sonnet)");
        assertEq(jRow.catalog_class_at, null, "f3: ukjent verdict leaves catalog_class_at unchanged");
        assertEq(jRow.verification_status, null, "f4: ukjent verdict never touches verification_status");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (e) apply:true + valid-class verdict updates catalog_class/_source/_at
      // ═══════════════════════════════════════════════════════════════════
      {
        const bRow = dentalDb.prepare("SELECT catalog_class, catalog_class_source, catalog_class_at FROM dental_agents WHERE id = ?").get("b-klinikk-company-nace-ok") as any;
        assertEq(bRow.catalog_class, "klinikk", "e1: valid-class verdict (klinikk) applied");
        assertEq(bRow.catalog_class_source, "sonnet", "e2: catalog_class_source overwritten to 'sonnet'");
        assertTrue(typeof bRow.catalog_class_at === "string" && bRow.catalog_class_at.length > 0, "e3: catalog_class_at stamped with a timestamp");
      }
      {
        const aRow = dentalDb.prepare("SELECT catalog_class, catalog_class_source FROM dental_agents WHERE id = ?").get("a-ukjent-ok") as any;
        assertEq(aRow.catalog_class, "ukjent", "e4: ukjent verdict on row A leaves catalog_class unchanged (no reclass)");
        assertEq(aRow.catalog_class_source, null, "e5: ukjent verdict on row A leaves catalog_class_source unchanged");
      }

      assertEq(applyRun1.body.data.applied, 1, "e6: response 'applied' counts exactly the one real-class write (row B)");
      assertEq(applyRun1.body.data.excluded_count, 1, "c9: response 'excluded_count' counts exactly the one not_a_clinic row");
      assertEq(applyRun1.body.data.counts_by_verdict, { ukjent: 2, klinikk: 1, not_a_clinic: 1 }, "c10/e7: counts_by_verdict tallies every verdict seen this run");

      // ═══════════════════════════════════════════════════════════════════
      // (d) regression: not_a_clinic never overwrites a pre-existing
      //     needs_review verification_status
      // ═══════════════════════════════════════════════════════════════════
      seed({ id: "k-needs-review-not-a-clinic", navn: "K NEEDS REVIEW NOT CLINIC AS", naeringskode: "86.230", organisasjonsform: "AS", hjemmeside: "https://k-needsreview.no", org_nr: "999000222", catalog_class: "ukjent", catalog_class_source: null, verification_status: "needs_review" });
      verdictsByNavn.set("K NEEDS REVIEW NOT CLINIC AS", { verdict_class: "not_a_clinic", reason: "Ikke tannrelatert." });

      const applyRun2 = await post({ apply: true, limit: 50 });
      assertEq(applyRun2.status, 200, "d0: second apply run -> 200");
      {
        const kRow = dentalDb.prepare("SELECT verification_status FROM dental_agents WHERE id = ?").get("k-needs-review-not-a-clinic") as any;
        assertEq(kRow.verification_status, "needs_review", "d1: pre-existing needs_review status is NEVER overwritten by a not_a_clinic verdict");
        const exclRow = dentalDb.prepare("SELECT * FROM dental_exclusions WHERE org_nr = ?").get("999000222") as any;
        assertTrue(!!exclRow, "d2: the exclusion is still recorded even though the status write was blocked");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (g) idempotency: a row stamped catalog_class_source='sonnet' by
      //     applyRun1 never re-appears in a later call's candidate set
      // ═══════════════════════════════════════════════════════════════════
      {
        const laterCallNames = new Set<string>();
        const preCallJudgeLen = judgeCalls.length;
        // Row B was stamped catalog_class_source='sonnet' by applyRun1 above —
        // confirm it is excluded from a subsequent scan even though it still
        // matches every other original candidate condition.
        const dryAgain = await post({ limit: 50 });
        assertEq(dryAgain.status, 200, "g0: follow-up dry-run scan -> 200");
        for (const c of judgeCalls.slice(preCallJudgeLen)) laterCallNames.add(c.navn);
        assertTrue(!laterCallNames.has("B COMPANY NACE AS"), "g1: a row already stamped catalog_class_source='sonnet' is never re-judged");
      }

      // ═══════════════════════════════════════════════════════════════════
      // (h) synthetic regression fixture: hearing-aid lab miscl. as klinikk
      //     by the rule engine's company_dental_nace rule, end-to-end via a
      //     MOCKED not_a_clinic verdict. Test fixture only — no hardcoded
      //     name check exists anywhere in production source.
      // ═══════════════════════════════════════════════════════════════════
      seed({
        id: "horselslaben",
        navn: "HØRSELSLABEN AS",
        naeringskode: "86.230",
        organisasjonsform: "AS",
        hjemmeside: "https://horselslaben.no",
        org_nr: "999000333",
        catalog_class: "klinikk",
        catalog_class_source: "rules_v1:company_dental_nace",
      });
      verdictsByNavn.set("HØRSELSLABEN AS", { verdict_class: "not_a_clinic", reason: "Høreapparatlaboratorium, ikke en tannklinikk." });

      const horselslabenDry = await post({ limit: 50 });
      const horselslabenCandidateNames = judgeCalls.map((c) => c.navn);
      assertTrue(horselslabenCandidateNames.includes("HØRSELSLABEN AS"), "h1: HØRSELSLABEN AS (klinikk/company_dental_nace, no dental word) is selected as a candidate");
      assertEq(horselslabenDry.body.data.dry_run, true, "h2: dry-run first — no write yet");
      {
        const preRow = dentalDb.prepare("SELECT verification_status FROM dental_agents WHERE id = ?").get("horselslaben") as any;
        assertEq(preRow.verification_status, null, "h3: dry-run made no write to HØRSELSLABEN AS");
      }

      const horselslabenApply = await post({ apply: true, limit: 50 });
      assertEq(horselslabenApply.status, 200, "h4: apply run -> 200");
      {
        const exclRow = dentalDb.prepare("SELECT * FROM dental_exclusions WHERE org_nr = ?").get("999000333") as any;
        assertTrue(!!exclRow, "h5: end-to-end — a dental_exclusions row is created for HØRSELSLABEN AS");
        assertEq(exclRow?.reason, "not_a_clinic", "h6: exclusion reason is not_a_clinic");
        const postRow = dentalDb.prepare("SELECT verification_status, catalog_class FROM dental_agents WHERE id = ?").get("horselslaben") as any;
        assertEq(postRow.verification_status, "rejected", "h7: end-to-end — verification_status becomes rejected");
        assertEq(postRow.catalog_class, "klinikk", "h8: end-to-end — catalog_class enum itself is left untouched (exclusions table is the source of truth)");
      }

      // ── admin gate ───────────────────────────────────────────────────────
      const noKey = await post({ limit: 5 }, false);
      assertEq(noKey.status, 403, "z1: missing X-Admin-Key -> 403");
      const wrongKey = await post({ limit: 5 }, "wrong-key");
      assertEq(wrongKey.status, 403, "z2: wrong X-Admin-Key -> 403");

      // ── limit cap ────────────────────────────────────────────────────────
      assertEq(routeMod.CATALOG_CLASS_SONNET_SAMPLE_LIMIT_CAP, 50, "z3: exported limit cap constant is 50");
      assertEq(routeMod.CATALOG_CLASS_SONNET_SAMPLE_DEFAULT_LIMIT, 20, "z4: exported default limit constant is 20");
      const overCap = await post({ apply: false, limit: 999 });
      assertTrue(overCap.body.data.scanned <= 50, "z5: limit is capped at 50 regardless of a larger requested value");
    } catch (err: any) {
      failed++;
      failures.push("admin-dental-catalog-class-sonnet-sample: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/admin-dental-catalog-class-sonnet-sample.test.ts`
if (require.main === module) {
  runAdminDentalCatalogClassSonnetSampleTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
