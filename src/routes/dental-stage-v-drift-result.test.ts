/**
 * dental-stage-v-drift-result.test.ts — unit tests for
 * POST /api/tannlege/admin/stage-v-drift-result (src/routes/dental.ts).
 *
 * dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
 * item 4 / slice 4a (2026-07-20): Stage V (the enrichment routine's §5
 * sample-verify) re-fetches a small sample of clinics each cycle and checks
 * the site's helfo-signal against the DB value; before this slice it could
 * only flag a mismatch ("drift" -> needs_review), never correct it. This
 * route is the reporting surface: Stage V posts the concrete value it found
 * on-site, and the server (recordStageVFieldObservation, dental-store.ts)
 * auto-corrects once the SAME contradicting value is confirmed twice in a
 * row. This file covers the HTTP-layer contract only (auth/validation/
 * wiring) -- the correction-logic itself (2-confirmation window, provenance
 * merge, pending-clear semantics) is covered directly against
 * recordStageVFieldObservation() in tests/test.ts's "slice4a" block.
 *
 * Setup mirrors dental-agent-put-field-provenance.test.ts (this repo's
 * convention for testing dental.ts admin routes): fresh in-memory dental DB
 * via DENTAL_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting()
 * (so the real production dental schema, including stage_v_pending_
 * correction, is created), fresh require of the dental router + dental-store
 * per run (avoids stale db-factory bindings across shared `npm test` runs),
 * exercised via router.handle() directly so the requireAdmin middleware
 * chain runs for real.
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) 404 for a nonexistent agentId
 *   (c) 400 for field != "helfo_agreement" (forward-compat guard -- as of
 *       slice 4b below, "treatments" IS a supported field, but this
 *       particular request still 400s because its value ("false", a bare
 *       string) fails the treatments array-shape validation, so this
 *       assertion keeps passing unmodified)
 *   (d) 400 for an invalid value (not "true"|"false"|"unknown")
 *   (e) 400 for a missing/blank agentId
 *   (f) happy path: first differing observation -> 200, pending:true, DB +
 *       field_provenance unchanged (regression guard against the route
 *       itself accidentally writing on the pending path)
 *   (g) happy path: second matching observation -> 200, corrected:true, DB
 *       value updated, field_provenance carries a stage_v_correction entry
 *   (h) verification_status is NEVER touched by this route, under any of
 *       the above (regression guard -- proves the needs_review/drift path
 *       stays fully independent)
 *
 * dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
 * item 4 / slice 4b (2026-08-07): generalized recordStageVFieldObservation +
 * this route to also accept field:"treatments" and field:"opening_hours".
 * Additional coverage below (sections i-n):
 *   (i) 400 for malformed treatments values (wrong type, empty-string
 *       element, >50 elements)
 *   (j) 400 for malformed opening_hours values (wrong type, invalid day,
 *       invalid HH:MM, >7 elements)
 *   (k) treatments happy path: first differing observation -> pending, DB
 *       unchanged; second observation with the SAME set but a DIFFERENT
 *       element ORDER -> corrected, proving the order-insensitive
 *       canonicalization; DB column holds the canonical (deduped+sorted)
 *       JSON; field_provenance.treatments gains a stage_v_correction entry
 *   (l) opening_hours happy path: same pattern with a day-reordered array
 *   (m) unrelated field_provenance keys survive both corrections untouched
 *   (n) verification_status untouched by the treatments/opening_hours
 *       corrections too
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
    const testKey = process.env.ADMIN_KEY || "dental-stage-v-drift-result-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const dentalStorePath = require.resolve("../services/dental-store");
    const cachePaths = [dbFactoryPath, dentalPath, dentalStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const dentalDb = dbFactory.getDb("dental");
      const dstore = require("../services/dental-store") as typeof import("../services/dental-store");

      const idA = dstore.createDentalAgent({
        navn: "Drift Route Tannlege AS",
        org_nr: "911300111",
        helfo_agreement: "true",
      } as any);

      const dentalRouter = (require("./dental") as typeof import("./dental")).default as any;

      function getRow(id: string) {
        return dentalDb
          .prepare(
            "SELECT helfo_agreement, field_provenance, stage_v_pending_correction, verification_status FROM dental_agents WHERE id = ?",
          )
          .get(id) as any;
      }

      // slice 4b: wider row read (adds treatments/opening_hours) for the new
      // fields' happy-path assertions below.
      function getWideRow(id: string) {
        return dentalDb
          .prepare(
            "SELECT treatments, opening_hours, field_provenance, stage_v_pending_correction, verification_status FROM dental_agents WHERE id = ?",
          )
          .get(id) as any;
      }

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          body: { agentId: idA, field: "helfo_agreement", value: "false" },
        });
        assertEq(resp.status, 403, "a1: no X-Admin-Key -> 403");
      }

      // ── (b) 404 for a nonexistent agentId ───────────────────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: "no-such-agent", field: "helfo_agreement", value: "false" },
        });
        assertEq(resp.status, 404, "b1: nonexistent agentId -> 404");
      }

      // ── (c) 400 for field != "helfo_agreement" ──────────────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idA, field: "treatments", value: "false" },
        });
        assertEq(resp.status, 400, "c1: field=treatments (not yet supported) -> 400");
      }

      // ── (d) 400 for an invalid value ─────────────────────────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idA, field: "helfo_agreement", value: "maybe" },
        });
        assertEq(resp.status, 400, "d1: value=maybe (not true|false|unknown) -> 400");
      }

      // ── (e) 400 for a missing/blank agentId ──────────────────────────
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { field: "helfo_agreement", value: "false" },
        });
        assertEq(resp.status, 400, "e1: missing agentId -> 400");
      }

      // ── (f) happy path: first differing observation -> pending, DB +
      // field_provenance UNCHANGED (regression guard) ──────────────────
      {
        const before = getRow(idA);
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idA, field: "helfo_agreement", value: "false" },
        });
        assertEq(resp.status, 200, "f1: valid first observation -> 200");
        assertEq(resp.body.pending, true, "f2: first differing observation -> pending:true in response");
        assertEq(resp.body.corrected, false, "f3: first differing observation -> corrected:false in response");

        const after = getRow(idA);
        assertEq(after.helfo_agreement, before.helfo_agreement, "f4: DB helfo_agreement UNCHANGED after first observation");
        assertEq(after.field_provenance, before.field_provenance, "f5: field_provenance UNCHANGED after first observation (byte-identical)");
        assertEq(after.verification_status, before.verification_status, "f6: verification_status untouched (regression guard)");
      }

      // ── (g) happy path: second matching observation -> corrected ────
      {
        const resp = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idA, field: "helfo_agreement", value: "false" },
        });
        assertEq(resp.status, 200, "g1: second matching observation -> 200");
        assertEq(resp.body.corrected, true, "g2: second matching observation -> corrected:true");
        assertEq(resp.body.previous_value, "true", "g3: response reports the pre-correction value");
        assertEq(resp.body.new_value, "false", "g4: response reports the corrected value");

        const after = getRow(idA);
        assertEq(after.helfo_agreement, "false", "g5: DB helfo_agreement corrected to the observed value");
        assertTrue(!!after.field_provenance, "g6: field_provenance populated");
        const prov = JSON.parse(after.field_provenance);
        assertTrue(
          Array.isArray(prov.helfo_agreement) &&
            prov.helfo_agreement.some((e: any) => e.source_type === "stage_v_correction" && e.value === "false"),
          "g7: field_provenance.helfo_agreement carries a stage_v_correction entry",
        );

        // ── (h) verification_status STILL untouched after the correction ──
        assertEq(after.verification_status, "pending_verify", "h1: verification_status untouched even by the auto-correction itself");
      }

      // ── slice 4b setup: a fresh agent with an initial treatments +
      // opening_hours value, plus an UNRELATED field_provenance entry (for
      // section m below) that the treatments/opening_hours corrections must
      // never touch. ────────────────────────────────────────────────────
      const idB = dstore.createDentalAgent({
        navn: "Drift Route Tannlege 4b AS",
        org_nr: "911300222",
        treatments: ["rotfylling", "tannregulering"],
      } as any);
      dstore.updateDentalAgent(idB, {
        opening_hours: [{ day: "mon", open: "08:00", close: "16:00" }],
        field_provenance: { adresse: [{ source_type: "manual", value: "Storgata 1", fetched_at: "2026-01-01T00:00:00.000Z" }] },
      } as any);

      // ── (i) 400 for malformed treatments values ─────────────────────
      {
        const wrongType = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "treatments", value: "rotfylling" },
        });
        assertEq(wrongType.status, 400, "i1: treatments value not an array -> 400");

        const emptyElement = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "treatments", value: ["rotfylling", ""] },
        });
        assertEq(emptyElement.status, 400, "i2: treatments array with an empty-string element -> 400");

        const tooLong = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "treatments", value: Array.from({ length: 51 }, (_, i) => `t${i}`) },
        });
        assertEq(tooLong.status, 400, "i3: treatments array with 51 elements (>50) -> 400");
      }

      // ── (j) 400 for malformed opening_hours values ───────────────────
      {
        const wrongType = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "opening_hours", value: "mon 08-16" },
        });
        assertEq(wrongType.status, 400, "j1: opening_hours value not an array -> 400");

        const invalidDay = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "opening_hours", value: [{ day: "someday", open: "08:00", close: "16:00" }] },
        });
        assertEq(invalidDay.status, 400, "j2: opening_hours with an invalid day -> 400");

        const invalidTime = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "opening_hours", value: [{ day: "mon", open: "8am", close: "16:00" }] },
        });
        assertEq(invalidTime.status, 400, "j3: opening_hours with an invalid HH:MM open time -> 400");

        const tooLong = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: {
            agentId: idB,
            field: "opening_hours",
            value: [
              { day: "mon", open: "08:00", close: "16:00" },
              { day: "tue", open: "08:00", close: "16:00" },
              { day: "wed", open: "08:00", close: "16:00" },
              { day: "thu", open: "08:00", close: "16:00" },
              { day: "fri", open: "08:00", close: "16:00" },
              { day: "sat", open: "08:00", close: "16:00" },
              { day: "sun", open: "08:00", close: "16:00" },
              { day: "mon", open: "09:00", close: "17:00" },
            ],
          },
        });
        assertEq(tooLong.status, 400, "j4: opening_hours with 8 entries (>7) -> 400");
      }

      // ── (k) treatments happy path: pending -> corrected, order-insensitive ──
      {
        const before = getWideRow(idB);

        // First differing observation -> pending, DB unchanged.
        const first = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "treatments", value: ["implantat", "rotfylling"] },
        });
        assertEq(first.status, 200, "k1: valid first treatments observation -> 200");
        assertEq(first.body.pending, true, "k2: first differing treatments observation -> pending:true");
        assertEq(first.body.corrected, false, "k3: first differing treatments observation -> corrected:false");
        const afterFirst = getWideRow(idB);
        assertEq(afterFirst.treatments, before.treatments, "k4: DB treatments UNCHANGED after first observation");
        assertEq(afterFirst.field_provenance, before.field_provenance, "k5: field_provenance UNCHANGED after first treatments observation");

        // Second observation: SAME set, DIFFERENT order -> proves the
        // order-insensitive canonicalization still recognizes it as a match.
        const second = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "treatments", value: ["rotfylling", "implantat"] },
        });
        assertEq(second.status, 200, "k6: second (reordered) matching treatments observation -> 200");
        assertEq(second.body.corrected, true, "k7: second (reordered) matching treatments observation -> corrected:true");

        const afterSecond = getWideRow(idB);
        assertEq(afterSecond.treatments, JSON.stringify(["implantat", "rotfylling"]), "k8: DB treatments column now holds the canonical (sorted) JSON");
        const prov = JSON.parse(afterSecond.field_provenance);
        assertTrue(
          Array.isArray(prov.treatments) && prov.treatments.some((e: any) => e.source_type === "stage_v_correction"),
          "k9: field_provenance.treatments gained a stage_v_correction entry",
        );
      }

      // ── (l) opening_hours happy path: pending -> corrected, order-insensitive ──
      {
        const observedOnce = [
          { day: "tue", open: "09:00", close: "17:00" },
          { day: "mon", open: "08:00", close: "16:00" },
        ];
        const observedReordered = [
          { day: "mon", open: "08:00", close: "16:00" },
          { day: "tue", open: "09:00", close: "17:00" },
        ];

        const before = getWideRow(idB);
        const first = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "opening_hours", value: observedOnce },
        });
        assertEq(first.status, 200, "l1: valid first opening_hours observation -> 200");
        assertEq(first.body.pending, true, "l2: first differing opening_hours observation -> pending:true");
        const afterFirst = getWideRow(idB);
        assertEq(afterFirst.opening_hours, before.opening_hours, "l3: DB opening_hours UNCHANGED after first observation");

        const second = await callRoute(dentalRouter, {
          method: "POST",
          path: "/admin/stage-v-drift-result",
          headers: { "x-admin-key": testKey },
          body: { agentId: idB, field: "opening_hours", value: observedReordered },
        });
        assertEq(second.status, 200, "l4: second (reordered) matching opening_hours observation -> 200");
        assertEq(second.body.corrected, true, "l5: second (reordered) matching opening_hours observation -> corrected:true");

        const afterSecond = getWideRow(idB);
        assertEq(
          afterSecond.opening_hours,
          JSON.stringify(observedReordered),
          "l6: DB opening_hours column now holds the canonical (day-sorted) JSON",
        );
        const prov = JSON.parse(afterSecond.field_provenance);
        assertTrue(
          Array.isArray(prov.opening_hours) && prov.opening_hours.some((e: any) => e.source_type === "stage_v_correction"),
          "l7: field_provenance.opening_hours gained a stage_v_correction entry",
        );

        // ── (m) unrelated field_provenance key untouched by either correction ──
        assertTrue(
          Array.isArray(prov.adresse) && prov.adresse.some((e: any) => e.value === "Storgata 1"),
          "m1: unrelated field_provenance.adresse entry survives both corrections untouched",
        );

        // ── (n) verification_status untouched by treatments/opening_hours corrections ──
        assertEq(afterSecond.verification_status, "pending_verify", "n1: verification_status untouched by the treatments/opening_hours corrections");
      }
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
