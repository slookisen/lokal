/**
 * admin-agent-audit-field-provenance-legacy-shape-normalize.test.ts — unit
 * tests for POST /admin/agent-audit/field-provenance-legacy-shape-normalize
 * (src/routes/admin-agent-audit.ts).
 *
 * dev-request 2026-07-27-field-provenance-legacy-shape-normalization: the
 * writer companion to GET /admin/agent-audit/field-provenance-legacy-shape
 * (which found 202 dental_agents rows / 315 fields still in the legacy
 * wrapped `{ sources: [...] }` shape, zero in agent_knowledge). This
 * endpoint normalizes those dental_agents rows to the modern bare-array
 * shape by reusing mergeFieldProvenance() (src/routes/admin-knowledge.ts,
 * unmodified — PR #298) with an empty incoming payload, which unwraps the
 * wrapper and drops individually-malformed nested records without adding
 * anything new. Dry-run by default; apply=1 writes.
 *
 * Setup mirrors admin-agent-audit-field-provenance-legacy-shape.test.ts's
 * dental half: DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting()
 * (fresh production dental schema), fresh require of admin-agent-audit,
 * exercised via router.handle() directly (not a live HTTP server) — with a
 * `body` field added to the fake request/response harness (mirroring
 * dental-agent-put-field-provenance.test.ts) since this endpoint reads
 * `apply` from either the query string or a JSON body.
 *
 * Covers:
 *   1. Dry-run reports, per row, which fields would be RESHAPED (wrapped ->
 *      bare, content preserved) vs which are "dropped" (every nested
 *      record malformed, field becomes empty) — and lists individually
 *      dropped records with a reason, distinct from the field-level status.
 *   2. Dry-run performs zero writes (DB byte-identical before/after).
 *   3. Apply mode writes only the fields that needed reshaping; an
 *      already-bare field on the same row is left byte-for-byte untouched;
 *      a row with no wrapped fields at all is untouched and unreported.
 *   4. Content-preservation: a well-formed record's value/source_type/
 *      fetched_at survive apply unchanged.
 *   5. A malformed nested record (missing value) is dropped, not silently
 *      kept, and is reported as "dropped" (not "reshaped") for that field
 *      in the dry-run response.
 *   6. Apply is idempotent: running it a second time finds zero wrapped
 *      fields, writes zero rows, and leaves the DB byte-identical.
 *   7. After apply, re-running the existing GET
 *      /admin/agent-audit/field-provenance-legacy-shape audit shows
 *      wrapped_shape_count: 0 (dental_agents contributes zero findings).
 *   8. Missing/wrong X-Admin-Key -> 401.
 */

import Database from "better-sqlite3";

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
    query?: Record<string, string>;
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
      query: opts.query || {},
      headers: opts.headers || {},
      body: opts.body,
      get(name: string) {
        return this.headers[name.toLowerCase()];
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

export async function runAdminAgentAuditFieldProvenanceLegacyShapeNormalizeTests(
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

  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevDentalPath = process.env.DENTAL_DB_PATH;
  const testKey = process.env.ADMIN_KEY || "field-provenance-legacy-shape-normalize-test-key";

  process.env.ADMIN_KEY = testKey;
  delete process.env.ANALYTICS_ADMIN_KEY;
  process.env.DENTAL_DB_PATH = ":memory:";

  // Also reset the rfb (agent_knowledge) handle to a fresh in-memory DB so
  // criterion 7's GET-audit re-run has a real, empty rfb table to scan
  // instead of touching whatever the shared process-wide rfb DB currently
  // holds (mirrors the sibling audit test's rfb setup).
  const {
    __setDbForTesting,
    __initSchemaForTesting,
    __peekDbForTesting,
  } = require("../database/init") as typeof import("../database/init");
  const prevRfbDb = __peekDbForTesting();
  const rfbTestDb = new Database(":memory:");
  rfbTestDb.pragma("journal_mode = DELETE");
  rfbTestDb.pragma("foreign_keys = OFF");

  const dbFactoryPath = require.resolve("../database/db-factory");
  const routePath = require.resolve("../routes/admin-agent-audit");
  delete require.cache[dbFactoryPath];
  delete require.cache[routePath];

  try {
    __setDbForTesting(rfbTestDb as any);
    __initSchemaForTesting(rfbTestDb as any);

    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");

    const insertDental = dentalDb.prepare(
      `INSERT INTO dental_agents (id, navn, field_provenance) VALUES (@id, @navn, @field_provenance)`,
    );

    // clinic-reshape: one well-formed record, wrapped -> "reshaped", content preserved.
    insertDental.run({
      id: "clinic-reshape",
      navn: "Reshape Tannlege AS",
      field_provenance: JSON.stringify({
        epost: {
          sources: [
            { source_type: "hjemmeside_scrape", value: "post@example.no", fetched_at: "2026-07-01T00:00:00.000Z" },
          ],
        },
      }),
    });

    // clinic-drop: single malformed record (missing value), wrapped -> "dropped".
    insertDental.run({
      id: "clinic-drop",
      navn: "Drop Tannlege AS",
      field_provenance: JSON.stringify({
        telefon: {
          sources: [{ source_type: "hjemmeside_scrape", fetched_at: "2026-07-01T00:00:00.000Z" }],
        },
      }),
    });

    // clinic-partial: two records, one well-formed (brreg/Gate 1) + one malformed
    // (missing source_type) -> "reshaped" (kept_count=1) with one dropped_record.
    insertDental.run({
      id: "clinic-partial",
      navn: "Partial Tannlege AS",
      field_provenance: JSON.stringify({
        adresse: {
          sources: [
            { source_type: "brreg", value: "Gate 1", fetched_at: "2026-07-01T00:00:00.000Z" },
            { value: "orphan-value", fetched_at: "2026-07-01T00:00:00.000Z" },
          ],
        },
      }),
    });

    // clinic-bare: already bare-array shape -> NOT reported, NOT touched.
    insertDental.run({
      id: "clinic-bare",
      navn: "Bare Tannlege AS",
      field_provenance: JSON.stringify({
        telefon: [{ source_type: "hjemmeside_scrape", value: "12121212", fetched_at: "2026-07-01T00:00:00.000Z" }],
      }),
    });

    // clinic-mixed-row: one wrapped field (epost) + one already-bare field (telefon)
    // on the SAME row -> only epost is reported/reshaped, telefon untouched.
    insertDental.run({
      id: "clinic-mixed-row",
      navn: "Mixed Row Tannlege AS",
      field_provenance: JSON.stringify({
        epost: {
          sources: [{ source_type: "hjemmeside_scrape", value: "a@b.no", fetched_at: "2026-07-01T00:00:00.000Z" }],
        },
        telefon: [{ source_type: "hjemmeside_scrape", value: "99999999", fetched_at: "2026-07-01T00:00:00.000Z" }],
      }),
    });

    const auditRouter = (require("../routes/admin-agent-audit") as typeof import("../routes/admin-agent-audit"))
      .default as any;

    function allDentalRows(): Array<{ id: string; field_provenance: string | null }> {
      return dentalDb
        .prepare("SELECT id, field_provenance FROM dental_agents ORDER BY id")
        .all() as Array<{ id: string; field_provenance: string | null }>;
    }
    function provOf(id: string): any {
      const row = dentalDb.prepare("SELECT field_provenance FROM dental_agents WHERE id = ?").get(id) as
        | { field_provenance: string | null }
        | undefined;
      return row?.field_provenance ? JSON.parse(row.field_provenance) : null;
    }

    // ── (8) auth ─────────────────────────────────────────────────────────
    {
      const noKey = await callRoute(auditRouter, {
        method: "POST",
        path: "/field-provenance-legacy-shape-normalize",
      });
      assertEq(noKey.status, 401, "auth: POST without X-Admin-Key -> 401");
      const wrongKey = await callRoute(auditRouter, {
        method: "POST",
        path: "/field-provenance-legacy-shape-normalize",
        headers: { "x-admin-key": "wrong" },
      });
      assertEq(wrongKey.status, 401, "auth: POST with wrong X-Admin-Key -> 401");
    }

    // ── (1)(2) dry-run ───────────────────────────────────────────────────
    const beforeDryRun = allDentalRows();
    const dry = await callRoute(auditRouter, {
      method: "POST",
      path: "/field-provenance-legacy-shape-normalize",
      headers: { "x-admin-key": testKey },
    });
    assertEq(dry.status, 200, "dry-run: 200");
    assertEq(dry.body?.success, true, "dry-run: success=true");
    assertEq(dry.body?.apply, false, "dry-run: apply=false by default");
    assertEq(dry.body?.rows_updated, 0, "dry-run: rows_updated=0 (nothing written)");

    const dryResults: any[] = dry.body?.results ?? [];
    const byId = (id: string) => dryResults.find((r) => r.id === id);

    assertEq(
      dryResults.length,
      4,
      "dry-run: 4 rows reported (clinic-bare excluded, it has no wrapped field)",
    );
    assertTrue(!byId("clinic-bare"), "dry-run: clinic-bare (already bare) not in results");

    // clinic-reshape: reshaped, content preserved in the report.
    {
      const r = byId("clinic-reshape");
      assertTrue(!!r, "dry-run: clinic-reshape present");
      assertEq(r?.fields?.length, 1, "dry-run: clinic-reshape has exactly 1 field reported");
      assertEq(r?.fields?.[0]?.field, "epost", "dry-run: clinic-reshape reported field = epost");
      assertEq(r?.fields?.[0]?.status, "reshaped", "dry-run: clinic-reshape/epost status = reshaped");
      assertEq(r?.fields?.[0]?.original_count, 1, "dry-run: clinic-reshape/epost original_count = 1");
      assertEq(r?.fields?.[0]?.kept_count, 1, "dry-run: clinic-reshape/epost kept_count = 1");
      assertEq(r?.fields?.[0]?.dropped_records?.length, 0, "dry-run: clinic-reshape/epost dropped_records empty");
    }

    // clinic-drop: single malformed record -> field-level status "dropped", NOT "reshaped".
    {
      const r = byId("clinic-drop");
      assertTrue(!!r, "dry-run: clinic-drop present");
      assertEq(r?.fields?.length, 1, "dry-run: clinic-drop has exactly 1 field reported");
      assertEq(r?.fields?.[0]?.field, "telefon", "dry-run: clinic-drop reported field = telefon");
      assertEq(
        r?.fields?.[0]?.status,
        "dropped",
        "5: clinic-drop/telefon reported as 'dropped' (not 'reshaped') — sole record is malformed",
      );
      assertEq(r?.fields?.[0]?.original_count, 1, "dry-run: clinic-drop/telefon original_count = 1");
      assertEq(r?.fields?.[0]?.kept_count, 0, "dry-run: clinic-drop/telefon kept_count = 0");
      assertEq(r?.fields?.[0]?.dropped_records?.length, 1, "5: clinic-drop/telefon has exactly 1 dropped_record");
      assertEq(
        r?.fields?.[0]?.dropped_records?.[0]?.reason,
        "missing_value",
        "5: clinic-drop/telefon dropped_records[0].reason = missing_value",
      );
    }

    // clinic-partial: mixed field -> "reshaped" overall, but with a distinctly-listed dropped record.
    {
      const r = byId("clinic-partial");
      assertTrue(!!r, "dry-run: clinic-partial present");
      assertEq(r?.fields?.[0]?.field, "adresse", "dry-run: clinic-partial reported field = adresse");
      assertEq(
        r?.fields?.[0]?.status,
        "reshaped",
        "dry-run: clinic-partial/adresse status = reshaped (1 of 2 records survives)",
      );
      assertEq(r?.fields?.[0]?.original_count, 2, "dry-run: clinic-partial/adresse original_count = 2");
      assertEq(r?.fields?.[0]?.kept_count, 1, "dry-run: clinic-partial/adresse kept_count = 1");
      assertEq(
        r?.fields?.[0]?.dropped_records?.length,
        1,
        "dry-run: clinic-partial/adresse still surfaces its 1 dropped record distinctly, despite field-level 'reshaped'",
      );
      assertEq(
        r?.fields?.[0]?.dropped_records?.[0]?.reason,
        "missing_source_type",
        "dry-run: clinic-partial/adresse dropped_records[0].reason = missing_source_type",
      );
    }

    // clinic-mixed-row: only the wrapped field (epost) reported; bare telefon absent from the report.
    {
      const r = byId("clinic-mixed-row");
      assertTrue(!!r, "dry-run: clinic-mixed-row present");
      assertEq(r?.fields?.length, 1, "dry-run: clinic-mixed-row has exactly 1 field reported (bare telefon excluded)");
      assertEq(r?.fields?.[0]?.field, "epost", "dry-run: clinic-mixed-row reported field = epost");
    }

    // (2) dry-run performed zero writes.
    const afterDryRun = allDentalRows();
    assertEq(afterDryRun, beforeDryRun, "2: dry-run leaves dental_agents byte-identical (no writes)");

    // ── (3)(4)(5) apply ──────────────────────────────────────────────────
    const apply1 = await callRoute(auditRouter, {
      method: "POST",
      path: "/field-provenance-legacy-shape-normalize",
      headers: { "x-admin-key": testKey },
      query: { apply: "1" },
    });
    assertEq(apply1.status, 200, "apply#1: 200");
    assertEq(apply1.body?.apply, true, "apply#1: apply=true");
    assertEq(apply1.body?.rows_updated, 4, "apply#1: 4 rows written (clinic-bare excluded)");

    // (4) content-preservation: exact value/source_type/fetched_at triple survives.
    {
      const prov = provOf("clinic-reshape");
      assertTrue(Array.isArray(prov?.epost), "4: clinic-reshape/epost is now a bare array");
      assertEq(prov?.epost?.length, 1, "4: clinic-reshape/epost has exactly 1 surviving record");
      assertEq(
        prov?.epost?.[0],
        { source_type: "hjemmeside_scrape", value: "post@example.no", fetched_at: "2026-07-01T00:00:00.000Z" },
        "4: clinic-reshape/epost's well-formed record is byte-identical after apply",
      );
    }

    // (5) malformed record actually dropped from the written row (not silently kept).
    {
      const prov = provOf("clinic-drop");
      assertTrue(Array.isArray(prov?.telefon), "5: clinic-drop/telefon is now a bare array");
      assertEq(prov?.telefon, [], "5: clinic-drop/telefon is empty — the sole malformed record was dropped");
    }

    // clinic-partial: well-formed record kept, malformed one dropped.
    {
      const prov = provOf("clinic-partial");
      assertEq(
        prov?.adresse,
        [{ source_type: "brreg", value: "Gate 1", fetched_at: "2026-07-01T00:00:00.000Z" }],
        "clinic-partial/adresse: only the well-formed record survives apply",
      );
    }

    // (3) already-bare field/row left byte-for-byte untouched by apply.
    {
      const bareRowAfter = dentalDb
        .prepare("SELECT field_provenance FROM dental_agents WHERE id = ?")
        .get("clinic-bare") as { field_provenance: string };
      assertEq(
        bareRowAfter.field_provenance,
        JSON.stringify({
          telefon: [{ source_type: "hjemmeside_scrape", value: "12121212", fetched_at: "2026-07-01T00:00:00.000Z" }],
        }),
        "3: clinic-bare (no wrapped fields) byte-identical after apply",
      );

      const mixedProv = provOf("clinic-mixed-row");
      assertEq(
        mixedProv?.telefon,
        [{ source_type: "hjemmeside_scrape", value: "99999999", fetched_at: "2026-07-01T00:00:00.000Z" }],
        "3: clinic-mixed-row's already-bare telefon field untouched by apply",
      );
      assertEq(
        mixedProv?.epost,
        [{ source_type: "hjemmeside_scrape", value: "a@b.no", fetched_at: "2026-07-01T00:00:00.000Z" }],
        "clinic-mixed-row's wrapped epost field correctly reshaped",
      );
    }

    // ── (6) idempotency: apply again -> zero further change ────────────────
    const beforeApply2 = allDentalRows();
    const apply2 = await callRoute(auditRouter, {
      method: "POST",
      path: "/field-provenance-legacy-shape-normalize",
      headers: { "x-admin-key": testKey },
      query: { apply: "1" },
    });
    assertEq(apply2.status, 200, "apply#2 (idempotency): 200");
    assertEq(apply2.body?.rows_with_wrapped_fields, 0, "6: apply#2 finds 0 rows with wrapped fields");
    assertEq(apply2.body?.rows_updated, 0, "6: apply#2 writes 0 rows");
    assertEq(apply2.body?.results, [], "6: apply#2 results = []");
    const afterApply2 = allDentalRows();
    assertEq(afterApply2, beforeApply2, "6: apply#2 leaves dental_agents byte-identical (idempotent)");

    // ── (7) GET audit re-run shows wrapped_shape_count: 0 for dental_agents ──
    const auditAfter = await callRoute(auditRouter, {
      path: "/field-provenance-legacy-shape",
      headers: { "x-admin-key": testKey },
    });
    assertEq(auditAfter.status, 200, "7: GET audit after apply -> 200");
    const auditFindings: Array<{ table: string }> = auditAfter.body?.findings ?? [];
    const dentalFindingsAfter = auditFindings.filter((f) => f.table === "dental_agents");
    assertEq(dentalFindingsAfter.length, 0, "7: dental_agents contributes 0 findings to the audit after apply");
    assertEq(auditAfter.body?.wrapped_shape_count, 0, "7: GET audit wrapped_shape_count = 0 after apply");
  } catch (err) {
    failed++;
    failures.push(
      `field-provenance-legacy-shape-normalize: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    );
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    if (prevRfbDb) __setDbForTesting(prevRfbDb);
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      /* ignore */
    }
    try {
      delete require.cache[require.resolve("../routes/admin-agent-audit")];
    } catch {
      /* ignore */
    }
    try {
      delete require.cache[require.resolve("../database/db-factory")];
    } catch {
      /* ignore */
    }
    rfbTestDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agent-audit-field-provenance-legacy-shape-normalize.test.ts`
if (require.main === module) {
  console.log(
    "── admin-agent-audit field-provenance-legacy-shape-normalize (dev-request 2026-07-27-field-provenance-legacy-shape-normalization) unit tests ──",
  );
  runAdminAgentAuditFieldProvenanceLegacyShapeNormalizeTests({ log: true }).then((r) => {
    console.log(`\nfield-provenance-legacy-shape-normalize: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
