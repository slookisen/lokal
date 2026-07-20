/**
 * dental-stage-v-drift-result.test.ts — unit + route tests for the Stage V
 * drift auto-correction slice (dev-request 2026-07-12-dental-enrichment-
 * universe-growth-and-queue-hygiene, slice 4a, 2026-07-20).
 *
 * Covers:
 *   - schema: new additive `stage_v_pending_correction` column present,
 *     existing rows unaffected (NULL default).
 *   - recordStageVFieldObservation() (src/services/dental-store.ts):
 *     (a) unknown agent id -> found:false
 *     (b) first observation of a value differing from the DB -> pending:true,
 *         DB helfo_agreement + field_provenance both unchanged
 *     (c) second observation, SAME differing value -> corrected:true, DB
 *         helfo_agreement updated, field_provenance gains a
 *         stage_v_correction entry WITHOUT clobbering a pre-existing
 *         provenance entry for a different field (om_oss)
 *     (d) an observation matching the current DB value clears any pending
 *         entry — proven by requiring 2 FRESH confirmations afterward
 *         (not 1) to correct the original differing value again
 *     (e) verification_status is never touched by any of the above
 *   - POST /admin/stage-v-drift-result (src/routes/dental.ts):
 *     (f) 403 without X-Admin-Key
 *     (g) 404 for a nonexistent agentId
 *     (h) 400 for field != "helfo_agreement"
 *     (i) 400 for an invalid value (e.g. "maybe")
 *     (j) 200 + correct pending/corrected shape end-to-end through the route
 *
 * Setup mirrors dental-agent-put-field-provenance.test.ts (this repo's
 * convention for testing dental.ts routes + dental-store.ts functions
 * together): fresh in-memory dental DB via DENTAL_DB_PATH=":memory:" +
 * db-factory.__resetDbFactoryForTesting() (real production schema, so the
 * new idempotent ALTER in init-dental.ts actually runs), fresh require of
 * dental-store + the dental router per run, exercised via router.handle()
 * directly (X-Admin-Key via headers) so the requireAdmin middleware chain
 * runs for real.
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

export function runDentalStageVDriftResultTests(
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
    const testKey = "dental-stage-v-drift-result-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const dentalStorePath = require.resolve("../services/dental-store");
    // Same require-cache-busting rationale as dental-agent-put-field-
    // provenance.test.ts: dental-store.ts's own `getDb` binding is resolved
    // at ITS require time, so a stale cached instance (from an earlier
    // block in the shared `npm test` run) would be bound to a DIFFERENT
    // :memory: connection than the one this block creates below.
    const cachePaths = [dbFactoryPath, dentalPath, dentalStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");
      const dstore = require("../services/dental-store") as typeof import("../services/dental-store");

      // ── (schema) new additive column present, existing rows unaffected ──
      const cols = (dentalDb.prepare("PRAGMA table_info(dental_agents)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      assertTrue(cols.includes("stage_v_pending_correction"), "schema-01: stage_v_pending_correction column exists");

      const insertAgent = dentalDb.prepare(
        `INSERT INTO dental_agents (id, navn, helfo_agreement, verification_status, field_provenance)
         VALUES (@id, @navn, @helfo_agreement, @verification_status, @field_provenance)`,
      );

      insertAgent.run({
        id: "clinic-schema-check",
        navn: "Skjema Tannlege AS",
        helfo_agreement: null,
        verification_status: "verified",
        field_provenance: null,
      });
      const schemaRow = dentalDb
        .prepare("SELECT stage_v_pending_correction FROM dental_agents WHERE id = ?")
        .get("clinic-schema-check") as { stage_v_pending_correction: string | null };
      assertEq(schemaRow.stage_v_pending_correction, null, "schema-02: existing/new row defaults stage_v_pending_correction to NULL");

      function getRow(id: string) {
        return dentalDb
          .prepare(
            "SELECT helfo_agreement, verification_status, field_provenance, stage_v_pending_correction FROM dental_agents WHERE id = ?",
          )
          .get(id) as {
          helfo_agreement: string | null;
          verification_status: string | null;
          field_provenance: string | null;
          stage_v_pending_correction: string | null;
        };
      }

      // ── recordStageVFieldObservation() direct tests ─────────────────────

      // (a) unknown agent id -> found:false
      assertEq(
        dstore.recordStageVFieldObservation("no-such-id", "helfo_agreement", "true").found,
        false,
        "sv-01: unknown agent id -> found:false",
      );

      // Subject clinic: DB says helfo_agreement="false", already has
      // field_provenance for a DIFFERENT field (om_oss) that must survive
      // every step below untouched.
      insertAgent.run({
        id: "clinic-drift",
        navn: "Drift Tannlege AS",
        helfo_agreement: "false",
        verification_status: "verified",
        field_provenance: JSON.stringify({
          om_oss: [{ source_type: "own_homepage", value: "Vi er en hyggelig klinikk", fetched_at: "2026-07-01T00:00:00.000Z" }],
        }),
      });

      // (b) first observation of a differing value -> pending:true, DB unchanged
      let r = dstore.recordStageVFieldObservation("clinic-drift", "helfo_agreement", "true");
      assertEq(r, { found: true, corrected: false, pending: true }, "sv-02: first differing observation -> pending:true only");
      let row = getRow("clinic-drift");
      assertEq(row.helfo_agreement, "false", "sv-03: DB helfo_agreement UNCHANGED after first pending observation");
      assertEq(
        row.field_provenance,
        JSON.stringify({
          om_oss: [{ source_type: "own_homepage", value: "Vi er en hyggelig klinikk", fetched_at: "2026-07-01T00:00:00.000Z" }],
        }),
        "sv-04: field_provenance UNCHANGED after first pending observation",
      );
      assertEq(row.verification_status, "verified", "sv-05: verification_status UNTOUCHED after first pending observation");
      assertTrue(!!row.stage_v_pending_correction, "sv-06: pending map is now populated");
      const pendingParsed = JSON.parse(row.stage_v_pending_correction as string);
      assertEq(pendingParsed.helfo_agreement.value, "true", "sv-07: pending entry recorded the observed value");

      // (c) second observation, SAME differing value -> corrected:true
      r = dstore.recordStageVFieldObservation("clinic-drift", "helfo_agreement", "true");
      assertEq(r.found, true, "sv-08: second matching observation -> found:true");
      assertEq(r.corrected, true, "sv-09: second matching observation -> corrected:true");
      assertEq((r as any).previous_value, "false", "sv-10: previous_value reported correctly");
      assertEq((r as any).new_value, "true", "sv-11: new_value reported correctly");
      row = getRow("clinic-drift");
      assertEq(row.helfo_agreement, "true", "sv-12: DB helfo_agreement now updated to the confirmed value");
      assertEq(row.verification_status, "verified", "sv-13: verification_status STILL untouched after correction");
      assertEq(row.stage_v_pending_correction, null, "sv-14: pending entry cleared after correction (map now empty -> NULL)");
      const provAfterCorrect = JSON.parse(row.field_provenance as string);
      assertTrue(
        Array.isArray(provAfterCorrect.om_oss) && provAfterCorrect.om_oss.length === 1 && provAfterCorrect.om_oss[0].value === "Vi er en hyggelig klinikk",
        "sv-15: pre-existing om_oss provenance entry SURVIVES the correction untouched (not clobbered)",
      );
      assertTrue(Array.isArray(provAfterCorrect.helfo_agreement), "sv-16: helfo_agreement provenance is an array");
      const helfoProv = provAfterCorrect.helfo_agreement[0];
      assertEq(helfoProv.source_type, "stage_v_correction", "sv-17: new provenance entry has source_type stage_v_correction");
      assertEq(helfoProv.value, "true", "sv-18: new provenance entry records the corrected value");
      assertTrue(typeof helfoProv.fetched_at === "string" && helfoProv.fetched_at.length > 0, "sv-19: new provenance entry has a fetched_at timestamp");

      // (d) an observation matching the current DB value clears any pending
      // entry — proven via requiring 2 FRESH confirmations afterward.
      // Sequence: pending("false") -> matches-current("true", clears) ->
      // pending("false") again (must NOT immediately correct) -> confirm
      // "false" again (NOW corrects).
      r = dstore.recordStageVFieldObservation("clinic-drift", "helfo_agreement", "false");
      assertEq(r, { found: true, corrected: false, pending: true }, "sv-20: differing observation after correction -> pending again");

      r = dstore.recordStageVFieldObservation("clinic-drift", "helfo_agreement", "true");
      assertEq(r, { found: true, corrected: false, cleared: true, pending: false }, "sv-21: observation matching current DB value ('true') clears the pending entry");
      row = getRow("clinic-drift");
      assertEq(row.helfo_agreement, "true", "sv-22: DB unchanged by the clearing observation");
      assertEq(row.stage_v_pending_correction, null, "sv-23: pending map cleared (empty -> NULL) by the matching observation");

      // The clear must have reset the counter: a fresh "false" observation
      // must be pending, NOT immediately corrected (proves 2 fresh
      // confirmations are required, not 1, after the clear).
      r = dstore.recordStageVFieldObservation("clinic-drift", "helfo_agreement", "false");
      assertEq(r, { found: true, corrected: false, pending: true }, "sv-24: first observation after the clear is pending, NOT immediately corrected");
      row = getRow("clinic-drift");
      assertEq(row.helfo_agreement, "true", "sv-25: DB still unchanged (clear proven — 2 fresh confirmations required)");
      assertEq(row.verification_status, "verified", "sv-26: verification_status untouched throughout the whole clear/re-pending sequence");

      // Second fresh confirmation -> NOW corrects.
      r = dstore.recordStageVFieldObservation("clinic-drift", "helfo_agreement", "false");
      assertEq(r.corrected, true, "sv-27: second fresh confirmation after the clear -> corrected:true");
      row = getRow("clinic-drift");
      assertEq(row.helfo_agreement, "false", "sv-28: DB updated to the re-confirmed value");
      assertEq(row.verification_status, "verified", "sv-29: verification_status untouched even after this second correction");

      // A DIFFERENT value than what's pending resets the pending entry
      // instead of correcting (regression guard for the "same value" branch
      // condition).
      insertAgent.run({
        id: "clinic-different-pending",
        navn: "Ulik Pending Tannlege AS",
        helfo_agreement: "unknown",
        verification_status: "pending_verify",
        field_provenance: null,
      });
      r = dstore.recordStageVFieldObservation("clinic-different-pending", "helfo_agreement", "true");
      assertEq(r, { found: true, corrected: false, pending: true }, "sv-30: first pending observation ('true')");
      r = dstore.recordStageVFieldObservation("clinic-different-pending", "helfo_agreement", "false");
      assertEq(r, { found: true, corrected: false, pending: true }, "sv-31: a DIFFERENT value than pending overwrites the pending entry, does NOT correct");
      row = getRow("clinic-different-pending");
      assertEq(row.helfo_agreement, "unknown", "sv-32: DB unchanged when pending value differs from the new observation");
      const pendingDiffParsed = JSON.parse(row.stage_v_pending_correction as string);
      assertEq(pendingDiffParsed.helfo_agreement.value, "false", "sv-33: pending entry now holds the LATEST observed value");

      // Malformed existing JSON in stage_v_pending_correction is tolerated.
      insertAgent.run({
        id: "clinic-junk-pending",
        navn: "Rar Pending Tannlege AS",
        helfo_agreement: "unknown",
        verification_status: "pending_verify",
        field_provenance: null,
      });
      dentalDb.prepare("UPDATE dental_agents SET stage_v_pending_correction = ? WHERE id = ?").run("{not valid json", "clinic-junk-pending");
      r = dstore.recordStageVFieldObservation("clinic-junk-pending", "helfo_agreement", "true");
      assertEq(r, { found: true, corrected: false, pending: true }, "sv-34: malformed existing pending JSON tolerated (treated as empty, no throw)");

      // ── POST /admin/stage-v-drift-result route tests ────────────────────

      const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;

      // (f) 403 without X-Admin-Key
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          body: { agentId: "clinic-drift", field: "helfo_agreement", value: "true" },
        });
        assertEq(resp.status, 403, "route-01: POST without X-Admin-Key -> 403");
      }

      // (g) 404 for a nonexistent agentId
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: "no-such-agent-id", field: "helfo_agreement", value: "true" },
        });
        assertEq(resp.status, 404, "route-02: POST for a nonexistent agentId -> 404");
      }

      // (h) 400 for field != "helfo_agreement"
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: "clinic-drift", field: "opening_hours", value: "true" },
        });
        assertEq(resp.status, 400, "route-03: POST with field='opening_hours' (not yet supported) -> 400");
      }

      // (i) 400 for an invalid value
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: "clinic-drift", field: "helfo_agreement", value: "maybe" },
        });
        assertEq(resp.status, 400, "route-04: POST with an invalid value ('maybe') -> 400");
      }

      // (j) 200 + correct pending/corrected shape end-to-end through the route
      {
        insertAgent.run({
          id: "clinic-route-e2e",
          navn: "Rute E2E Tannlege AS",
          helfo_agreement: "false",
          verification_status: "needs_review",
          field_provenance: null,
        });
        const resp1 = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: "clinic-route-e2e", field: "helfo_agreement", value: "true" },
        });
        assertEq(resp1.status, 200, "route-05: first route observation -> 200");
        assertEq(resp1.body, { found: true, corrected: false, pending: true }, "route-06: first route observation -> pending:true shape");

        const resp2 = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: "clinic-route-e2e", field: "helfo_agreement", value: "true" },
        });
        assertEq(resp2.status, 200, "route-07: second matching route observation -> 200");
        assertEq(resp2.body.corrected, true, "route-08: second matching route observation -> corrected:true");
        assertEq(resp2.body.previous_value, "false", "route-09: route response reports previous_value");
        assertEq(resp2.body.new_value, "true", "route-10: route response reports new_value");

        const e2eRow = getRow("clinic-route-e2e");
        assertEq(e2eRow.helfo_agreement, "true", "route-11: DB actually updated via the route");
        // needs_review is the OTHER (drift-classification) path's terminal
        // state — this endpoint must never touch it, in either direction.
        assertEq(e2eRow.verification_status, "needs_review", "route-12: verification_status untouched by the route in ANY direction (regression guard)");
      }

      console.log(`  dental-stage-v-drift-result: OK (${passed} assertions this block)`);
    } catch (err: any) {
      failed++;
      failures.push("dental-stage-v-drift-result: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/dental-stage-v-drift-result.test.ts`
if (require.main === module) {
  runDentalStageVDriftResultTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
