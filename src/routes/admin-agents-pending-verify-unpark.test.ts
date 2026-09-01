/**
 * admin-agents-pending-verify-unpark.test.ts — tests for
 * dev-requests/2026-09-01-rfb-pending-verify-unpark-lever.md: POST
 * /admin/agents/pending-verify-unpark, a targeted lever to release individual
 * `pending_verify` rows from the 30-day parking mechanism
 * (pending_verify_parked_since, stamped in applyVerifierOutcome —
 * src/agents/lokal-agent-verifier.ts) early, once they have demonstrably
 * received new data since being parked (agent_knowledge.updated_at >
 * pending_verify_parked_since). Mirrors unparkAgentsGeocode's dry-run-by-
 * default / count-then-write shape (src/services/agents-geocode-worker.ts).
 *
 * Covers (src/routes/admin-agents-pending-verify-unpark.ts):
 *   (a) missing/wrong X-Admin-Key -> 403.
 *   (b) AC1 — dry-run (apply omitted) on a fresh parked row: candidates=1,
 *       unparked=1 (preview), row.applied=false, and the DB row is
 *       UNCHANGED (pending_verify_parked_since still set).
 *   (c) AC2 — apply:true on the same row: pending_verify_parked_since
 *       becomes NULL, pending_verify_no_progress_count becomes 0, row is
 *       reported applied:true, and the row now satisfies
 *       pickPendingVerifyBatch's own selectability clause (NULL
 *       pending_verify_parked_since trivially passes it).
 *   (d) AC3 — cohort mode (no agentIds): a parked row whose updated_at is
 *       NOT newer than pending_verify_parked_since is excluded entirely —
 *       never appears in `rows`, never gets unparked — while a sibling fresh
 *       parked row in the SAME cohort call still gets unparked.
 *   (e) agentIds mode force-unparks a STALE row (updated_at <=
 *       parked_since) but reports freshnessMet:false for it; a fresh row in
 *       the same agentIds call reports freshnessMet:true.
 *   (f) a row that is NOT currently parked (pending_verify_parked_since IS
 *       NULL) is excluded from cohort candidates entirely, and in agentIds
 *       mode is reported wasEligible:false/applied:false and left untouched.
 *   (g) an agentIds entry that doesn't resolve to any agent/agent_knowledge
 *       row is reported wasEligible:false/freshnessMet:false/applied:false,
 *       never thrown.
 *   (h) apply touches ONLY the two parking columns — a sibling column
 *       (email) on the same row is asserted unchanged after apply.
 *   (i) limit + default-limit behaviour in cohort mode (only `limit` fresh
 *       parked rows are returned/unparked even with more eligible rows
 *       present), oldest-parked-first ordering.
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/admin-agents-pending-verify-unpark.test.ts
 *   2. Not wired into `npm test` (tests/test.ts) — same standalone-suite
 *      convention as its closest sibling, admin-rfb-contact-extraction.test.ts.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined, writableEnded: false, destroyed: false };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runAdminAgentsPendingVerifyUnparkTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = process.env.ADMIN_KEY || "pv-unpark-test-key";

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const routePath = require.resolve("../routes/admin-agents-pending-verify-unpark");
    delete require.cache[routePath];
    const routeModule = require("../routes/admin-agents-pending-verify-unpark") as
      typeof import("../routes/admin-agents-pending-verify-unpark");
    const routerModule = routeModule.default;

    function getHandler(method: "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postUnpark = getHandler("post", "/agents/pending-verify-unpark");

    async function callUnpark(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      const req = { headers, body, query: {} } as any;
      await postUnpark(req, res as any);
      return { status: res.statusCode, body: res.body };
    }

    let agentSeq = 0;
    function insertAgent(o: {
      id?: string;
      name?: string;
      email?: string | null;
      parkedSince?: string | null; // pending_verify_parked_since
      updatedAt?: string | null; // agent_knowledge.updated_at
      noProgressCount?: number;
      createdAt?: string;
    }): string {
      const id = o.id ?? `pv-agent-${++agentSeq}`;
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, vertical_id, created_at)
         VALUES (?, ?, 't', 't', '', 'https://example.com', 'producer', ?, 'rfb', ?)`,
      ).run(id, o.name ?? id, `key-${id}`, o.createdAt ?? "2026-01-01 00:00:00");
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, email, verification_status,
           pending_verify_parked_since, pending_verify_no_progress_count, updated_at)
         VALUES (?, ?, 'pending_verify', ?, ?, ?)`,
      ).run(id, o.email ?? null, o.parkedSince ?? null, o.noProgressCount ?? 3, o.updatedAt ?? "2026-01-01 00:00:00");
      return id;
    }

    // SQL-native "now", same format/timezone the app itself stamps
    // pending_verify_parked_since with (datetime('now')) — used instead of a
    // fixed date literal wherever a test needs a parked_since guaranteed to
    // be well within the 30-day pickPendingVerifyBatch window regardless of
    // the real wall-clock date this suite happens to run on.
    function sqlNow(): string {
      return (testDb.prepare(`SELECT datetime('now') AS n`).get() as { n: string }).n;
    }

    function knowledgeRow(id: string): any {
      return testDb.prepare(
        `SELECT pending_verify_parked_since, pending_verify_no_progress_count, email, verification_status
           FROM agent_knowledge WHERE agent_id = ?`,
      ).get(id);
    }

    // pickPendingVerifyBatch's own selectability clause, re-stated here ONLY
    // to prove AC2 without importing the verifier module (keeps this test
    // file's schema dependencies minimal) — same clause as
    // src/agents/lokal-agent-verifier.ts:463.
    function isSelectableByPickPendingVerifyBatch(id: string): boolean {
      const row = testDb.prepare(
        `SELECT 1 AS ok FROM agent_knowledge k
          WHERE k.agent_id = ?
            AND k.verification_status = 'pending_verify'
            AND (k.pending_verify_parked_since IS NULL OR k.pending_verify_parked_since <= datetime('now','-30 days'))`,
      ).get(id) as { ok: number } | undefined;
      return !!row;
    }

    // ── (a) auth ──────────────────────────────────────────────────────────
    {
      const r = await callUnpark({}, {});
      assertEq(r.status, 403, "a1: POST without X-Admin-Key -> 403");
      const r2 = await callUnpark({}, { "x-admin-key": "wrong" });
      assertEq(r2.status, 403, "a2: POST with wrong X-Admin-Key -> 403");
    }

    // ── (b) AC1 — dry-run on a fresh parked row writes nothing ─────────────
    {
      const id = insertAgent({ parkedSince: "2026-08-01 00:00:00", updatedAt: "2026-08-15 00:00:00" });
      const r = await callUnpark({ agentIds: [id] });
      assertEq(r.status, 200, "b1: 200");
      assertEq(r.body.dry_run, true, "b2: dry_run true by default");
      assertEq(r.body.candidates, 1, "b3: candidates=1");
      assertEq(r.body.unparked, 1, "b4: unparked=1 (preview count)");
      const row = r.body.rows.find((x: any) => x.agentId === id);
      assertEq(row?.wasEligible, true, "b5: wasEligible true");
      assertEq(row?.freshnessMet, true, "b6: freshnessMet true");
      assertEq(row?.applied, false, "b7: applied false under dry-run");
      const dbRow = knowledgeRow(id);
      assertEq(dbRow.pending_verify_parked_since, "2026-08-01 00:00:00", "b8: DB row UNCHANGED by dry-run");
      assertEq(dbRow.pending_verify_no_progress_count, 3, "b9: no_progress_count UNCHANGED by dry-run");
    }

    // ── (c) AC2 — apply unparks the same row; it becomes selectable again ──
    {
      // parkedSince is stamped via sqlNow() here (NOT a fixed 2026-08-01
      // literal) so the "still within the 30-day window" sanity check (c0)
      // holds regardless of what the real wall-clock date is when this
      // suite runs.
      const parkedSince = sqlNow();
      const id = insertAgent({ parkedSince, updatedAt: "2026-08-15 00:00:00" });
      assertEq(isSelectableByPickPendingVerifyBatch(id), false, "c0: NOT selectable while parked (sanity check)");

      const r = await callUnpark({ agentIds: [id], apply: true });
      assertEq(r.status, 200, "c1: 200");
      assertEq(r.body.dry_run, false, "c2: dry_run false");
      assertEq(r.body.unparked, 1, "c3: unparked=1");
      const row = r.body.rows.find((x: any) => x.agentId === id);
      assertEq(row?.applied, true, "c4: applied true");

      const dbRow = knowledgeRow(id);
      assertEq(dbRow.pending_verify_parked_since, null, "c5: pending_verify_parked_since NULL after apply");
      assertEq(dbRow.pending_verify_no_progress_count, 0, "c6: pending_verify_no_progress_count reset to 0");
      assertTrue(isSelectableByPickPendingVerifyBatch(id), "c7: AC2 — row now selectable by pickPendingVerifyBatch's own clause");
    }

    // ── (d) AC3 — cohort mode excludes a stale (non-fresh) parked row ──────
    {
      const staleId = insertAgent({ parkedSince: "2026-08-01 00:00:00", updatedAt: "2026-07-01 00:00:00" }); // updated BEFORE parking
      const freshId = insertAgent({ parkedSince: "2026-08-02 00:00:00", updatedAt: "2026-08-20 00:00:00" }); // updated AFTER parking

      const r = await callUnpark({ apply: true }); // cohort mode: no agentIds
      assertEq(r.status, 200, "d1: 200");
      assertEq(r.body.mode, "cohort", "d2: mode reported as cohort");

      const staleRow = r.body.rows.find((x: any) => x.agentId === staleId);
      const freshRow = r.body.rows.find((x: any) => x.agentId === freshId);
      assertEq(staleRow, undefined, "d3: AC3 — stale row is NOT even listed as a cohort candidate");
      assertTrue(!!freshRow, "d4: fresh row IS listed as a cohort candidate");
      assertEq(freshRow?.applied, true, "d5: fresh row applied true");

      assertEq(knowledgeRow(staleId).pending_verify_parked_since, "2026-08-01 00:00:00", "d6: AC3 — stale row's parked_since UNTOUCHED");
      assertEq(knowledgeRow(freshId).pending_verify_parked_since, null, "d7: fresh row's parked_since cleared");
    }

    // ── (d2) Defect-2 regression: updated_at EXACTLY EQUAL to parked_since is
    // NOT fresh (mutation-test guard: flipping the freshness comparison from
    // `>` to `>=` in either selectCohortCandidates or
    // selectAgentIdsCandidates must be caught here — a write racing exactly
    // with the parking stamp is not "genuinely new" evidence; strict `>` is
    // the intended semantics). ──
    {
      const equalId = insertAgent({ parkedSince: "2026-08-05 00:00:00", updatedAt: "2026-08-05 00:00:00" });

      // cohort mode: an exactly-equal row must NOT be a candidate at all.
      const cohortR = await callUnpark({ apply: true, limit: 500 });
      const cohortRow = cohortR.body.rows.find((x: any) => x.agentId === equalId);
      assertEq(cohortRow, undefined, "d2-1: exactly-equal updated_at/parked_since row is NOT a cohort candidate");
      assertEq(
        knowledgeRow(equalId).pending_verify_parked_since,
        "2026-08-05 00:00:00",
        "d2-2: exactly-equal row's parked_since UNTOUCHED by cohort apply",
      );

      // agentIds mode: still eligible (currently parked) but freshnessMet
      // must be false — only a force-unpark, never a freshness-earned one.
      const idsR = await callUnpark({ agentIds: [equalId] }); // dry-run, so no state changes from this call
      const idsRow = idsR.body.rows.find((x: any) => x.agentId === equalId);
      assertEq(idsRow?.wasEligible, true, "d2-3: exactly-equal row still wasEligible (currently parked)");
      assertEq(idsRow?.freshnessMet, false, "d2-4: exactly-equal row reports freshnessMet:false — NOT >=");
    }

    // ── (e) agentIds mode force-unparks a stale row, reports freshnessMet:false ──
    {
      const staleId = insertAgent({ parkedSince: "2026-08-01 00:00:00", updatedAt: "2026-07-01 00:00:00" });
      const freshId = insertAgent({ parkedSince: "2026-08-02 00:00:00", updatedAt: "2026-08-20 00:00:00" });

      const r = await callUnpark({ agentIds: [staleId, freshId], apply: true });
      assertEq(r.body.mode, "agentIds", "e1: mode reported as agentIds");

      const staleRow = r.body.rows.find((x: any) => x.agentId === staleId);
      const freshRow = r.body.rows.find((x: any) => x.agentId === freshId);
      assertEq(staleRow?.wasEligible, true, "e2: stale row still eligible (currently parked)");
      assertEq(staleRow?.freshnessMet, false, "e3: stale row reports freshnessMet:false");
      assertEq(staleRow?.applied, true, "e4: stale row FORCE-unparked despite staleness");
      assertEq(freshRow?.freshnessMet, true, "e5: fresh row in the SAME call reports freshnessMet:true");
      assertEq(freshRow?.applied, true, "e6: fresh row applied true");

      assertEq(knowledgeRow(staleId).pending_verify_parked_since, null, "e7: stale row actually unparked in the DB");
      assertEq(knowledgeRow(freshId).pending_verify_parked_since, null, "e8: fresh row actually unparked in the DB");
    }

    // ── (f) a non-parked row is excluded / left untouched in both modes ────
    {
      const notParkedId = insertAgent({ parkedSince: null, updatedAt: "2026-08-20 00:00:00" });

      // cohort mode: never appears
      const cohortR = await callUnpark({ apply: true, limit: 500 });
      const cohortRow = cohortR.body.rows.find((x: any) => x.agentId === notParkedId);
      assertEq(cohortRow, undefined, "f1: non-parked row never listed as a cohort candidate");

      // agentIds mode: reported but not applied
      const idsR = await callUnpark({ agentIds: [notParkedId], apply: true });
      const idsRow = idsR.body.rows.find((x: any) => x.agentId === notParkedId);
      assertEq(idsRow?.wasEligible, false, "f2: non-parked row wasEligible:false in agentIds mode");
      assertEq(idsRow?.freshnessMet, false, "f3: non-parked row freshnessMet:false in agentIds mode");
      assertEq(idsRow?.applied, false, "f4: non-parked row never applied");
      assertEq(knowledgeRow(notParkedId).pending_verify_parked_since, null, "f5: still NULL (untouched, was already NULL)");
    }

    // ── (g) an agentIds entry that doesn't resolve to any row ──────────────
    {
      const r = await callUnpark({ agentIds: ["does-not-exist-anywhere"], apply: true });
      assertEq(r.status, 200, "g1: 200, not thrown");
      const row = r.body.rows.find((x: any) => x.agentId === "does-not-exist-anywhere");
      assertEq(row?.wasEligible, false, "g2: unknown id wasEligible:false");
      assertEq(row?.freshnessMet, false, "g3: unknown id freshnessMet:false");
      assertEq(row?.applied, false, "g4: unknown id applied:false");
      assertEq(r.body.candidates, 0, "g5: candidates=0");
      assertEq(r.body.unparked, 0, "g6: unparked=0");
    }

    // ── (h) apply touches ONLY the two parking columns ──────────────────────
    {
      const id = insertAgent({ parkedSince: "2026-08-01 00:00:00", updatedAt: "2026-08-15 00:00:00", email: "keep-me@example.com" });
      await callUnpark({ agentIds: [id], apply: true });
      const row = testDb.prepare(`SELECT email, verification_status FROM agent_knowledge WHERE agent_id = ?`).get(id) as any;
      assertEq(row.email, "keep-me@example.com", "h1: sibling column (email) left untouched by apply");
      assertEq(row.verification_status, "pending_verify", "h2: verification_status left untouched by apply");
    }

    // ── (i) limit + oldest-parked-first ordering in cohort mode ────────────
    {
      const older = insertAgent({ parkedSince: "2026-07-01 00:00:00", updatedAt: "2026-07-15 00:00:00" });
      const newer = insertAgent({ parkedSince: "2026-07-10 00:00:00", updatedAt: "2026-07-20 00:00:00" });
      const newest = insertAgent({ parkedSince: "2026-07-20 00:00:00", updatedAt: "2026-07-25 00:00:00" });

      const r = await callUnpark({ limit: 2 }); // dry-run cohort, capped to 2 of the 3 fresh rows just inserted (plus any left over from earlier blocks — filter to just these 3 ids)
      const ids = r.body.rows.map((x: any) => x.agentId).filter((x: string) => [older, newer, newest].includes(x));
      assertEq(ids, [older, newer], "i1: only the 2 oldest-parked of this trio are candidates, oldest-first, respecting limit:2");
      // `newest` must remain untouched — still parked.
      assertEq(knowledgeRow(newest).pending_verify_parked_since, "2026-07-20 00:00:00", "i2: row beyond the limit left untouched");
    }
  } catch (err: any) {
    failed++;
    failures.push("admin-agents-pending-verify-unpark: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
    else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    try {
      if (prevDb) __setDbForTesting(prevDb);
    } catch {
      /* best-effort restore */
    }
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-pending-verify-unpark.test.ts`
if (require.main === module) {
  runAdminAgentsPendingVerifyUnparkTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
