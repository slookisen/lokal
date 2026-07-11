/**
 * admin-agents-brreg-catalog-sweep.test.ts — unit/integration tests for
 * Slice 3 of dev-request 2026-06-30-brreg-verification-gate: the backlog
 * sweep for pre-existing `agents` rows that predate the registration-time
 * BRREG_VERIFY_ON_REGISTER wiring (Slice 2, admin-agents.test.ts).
 *
 * Covers GET/POST /admin/agents/brreg-catalog-sweep (src/routes/admin-agents.ts):
 *   (a) 403 without X-Admin-Key (GET and POST).
 *   (b) GET diagnostic shape + hard batch cap: candidate_count / batch_size /
 *       remaining_count are correct when the backlog exceeds
 *       BRREG_SWEEP_BATCH_CAP, and GET never writes to the DB.
 *   (c) Candidate scoping: rows with no org_nr, an empty-string org_nr,
 *       an already-checked org_nr (brreg_checked_at NOT NULL), or a
 *       "dental" vertical are ALL excluded from the candidate set — dental
 *       stays Legelisten-primary, mirroring POST /register's own gating.
 *   (d) POST dry_run (default and explicit true) makes ZERO DB writes.
 *   (e) POST dry_run:false (apply) writes brreg_verified/brreg_flag/
 *       brreg_checked_at for exactly the capped batch, touches no other
 *       column (name/is_active/trust_score unchanged), never DELETEs, and
 *       a dissolved org-nr is flagged (never de-listed) and reported in
 *       flagged_for_review.
 *   (f) Idempotent re-run: rows already checked by a previous apply are
 *       excluded from the next run's candidates (their brreg_checked_at
 *       stays untouched, no repeat Brreg fetch).
 *   (g) Badge: /produsent/:slug renders "Registrert i Brønnøysund" only
 *       when the looked-up agent's brreg_verified=1.
 *
 * All Brreg I/O is stubbed via a monkey-patched global.fetch (mirrors
 * admin-agents.test.ts exactly — verifyOrgNumber defaults its fetchImpl
 * param to the global `fetch` identifier). ZERO real network calls.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-agents-brreg-catalog-sweep.test.ts
 *   2. Wired into the gate: tests/test.ts imports runBrregCatalogSweepTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type BrregFixture = { status: number; body?: Record<string, unknown> };

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

function activeAgentBody(orgNr: string, name: string, nace1: string): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: null,
    registreringsdatoEnhetsregisteret: "2015-03-01",
    naeringskode1: { kode: nace1 },
  };
}

function dissolvedAgentBody(orgNr: string, name: string): Record<string, unknown> {
  return {
    organisasjonsnummer: orgNr,
    navn: name,
    konkurs: false,
    underAvvikling: false,
    underTvangsavviklingEllerTvangsopplosning: false,
    slettedato: "2022-01-15",
    registreringsdatoEnhetsregisteret: "2010-05-01",
    naeringskode1: { kode: "01.410" },
  };
}

export async function runBrregCatalogSweepTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevFetch = globalThis.fetch;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "brreg-sweep-test-key";

  const fixtures: Map<string, BrregFixture> = new Map();
  let fetchCallCount = 0;
  const fetchedOrgNrs: string[] = [];

  function stubFetch(): typeof fetch {
    return (async (url: string | URL | Request) => {
      fetchCallCount++;
      const urlStr = String(url);
      const orgNr = urlStr.split("/").pop() || "";
      fetchedOrgNrs.push(orgNr);
      const fixture = fixtures.get(orgNr);
      if (!fixture) {
        return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
      }
      return {
        status: fixture.status,
        ok: fixture.status >= 200 && fixture.status < 300,
        json: async () => fixture.body ?? {},
      } as unknown as Response;
    }) as typeof fetch;
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;
    globalThis.fetch = stubFetch();

    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    const adminAgentsModule = require("../routes/admin-agents") as
      typeof import("../routes/admin-agents");
    const routerModule = adminAgentsModule.default;
    const { applyBrregSweepRowUpdate } = adminAgentsModule;

    function getHandler(method: "get" | "post", path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
      );
      assertTrue(!!layer, `setup: ${method.toUpperCase()} ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const getSweep = getHandler("get", "/brreg-catalog-sweep");
    const postSweep = getHandler("post", "/brreg-catalog-sweep");

    async function callGet(headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await getSweep({ headers, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }
    async function callPost(
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-admin-key": ADMIN_KEY },
    ): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await postSweep({ headers, body, query: {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    function insertAgent(opts: {
      id: string; name: string; orgNr?: string | null; verticalId?: string | null;
      checkedAt?: string | null; isActive?: number;
    }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          org_nr, vertical_id, brreg_checked_at, is_active, trust_score
        ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', 'producer', ?, ?, ?, ?, ?, 0.5)`,
      ).run(
        opts.id,
        opts.name,
        `key-${opts.id}`,
        opts.orgNr ?? null,
        opts.verticalId ?? "rfb",
        opts.checkedAt ?? null,
        opts.isActive ?? 1,
      );
    }

    function readRow(id: string): any {
      return testDb.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    }

    // ── (a) 403 without X-Admin-Key ─────────────────────────────────────
    {
      const g = await callGet({});
      assertEq(g.status, 403, "auth: GET without X-Admin-Key -> 403");
      const p = await callPost({}, {});
      assertEq(p.status, 403, "auth: POST without X-Admin-Key -> 403");
    }

    // ── (b) GET diagnostic shape + hard batch cap ───────────────────────
    {
      const CAP = 50;
      for (let i = 0; i < CAP + 5; i++) {
        insertAgent({ id: `cap-${i}`, name: `Cap Gård ${i}`, orgNr: `9300${String(i).padStart(5, "0")}` });
      }

      const beforeUnchecked = testDb
        .prepare("SELECT COUNT(*) AS n FROM agents WHERE brreg_checked_at IS NULL")
        .get() as { n: number };

      const g = await callGet({ "x-admin-key": ADMIN_KEY });
      assertEq(g.status, 200, "cap: GET with valid key -> 200");
      assertEq(g.body?.success, true, "cap: success=true");
      assertEq(g.body?.dry_run, true, "cap: GET reports dry_run=true (read-only diagnostic)");
      assertEq(g.body?.candidate_count, CAP + 5, "cap: candidate_count reports the FULL backlog, not just the batch");
      assertEq(g.body?.batch_size, CAP, "cap: batch_size is capped at BRREG_SWEEP_BATCH_CAP (50)");
      assertEq(g.body?.remaining_count, 5, "cap: remaining_count is backlog minus the capped batch");
      assertTrue(Array.isArray(g.body?.rows) && g.body.rows.length === CAP, "cap: rows array length equals batch_size");

      const afterUnchecked = testDb
        .prepare("SELECT COUNT(*) AS n FROM agents WHERE brreg_checked_at IS NULL")
        .get() as { n: number };
      assertEq(afterUnchecked.n, beforeUnchecked.n, "cap: GET issues zero DB writes (read-only)");
    }

    // ── (c) candidate scoping: no-org_nr / empty org_nr / already-checked /
    //     dental are all excluded ──────────────────────────────────────
    testDb.exec("DELETE FROM agents"); // clear the 55 fixture rows from (b)
    {
      insertAgent({ id: "scope-no-orgnr", name: "No OrgNr", orgNr: null });
      insertAgent({ id: "scope-empty-orgnr", name: "Empty OrgNr", orgNr: "" });
      insertAgent({ id: "scope-already-checked", name: "Already Checked", orgNr: "940000001", checkedAt: "2026-01-01T00:00:00.000Z" });
      insertAgent({ id: "scope-dental", name: "Tannlege Scope", orgNr: "940000002", verticalId: "dental" });
      insertAgent({ id: "scope-eligible", name: "Eligible Gård", orgNr: "940000003", verticalId: "experiences" });

      const g = await callGet({ "x-admin-key": ADMIN_KEY });
      const ids: string[] = (g.body?.rows ?? []).map((r: any) => r.id);
      assertTrue(!ids.includes("scope-no-orgnr"), "scope: row with NULL org_nr excluded from candidates");
      assertTrue(!ids.includes("scope-empty-orgnr"), "scope: row with empty-string org_nr excluded from candidates");
      assertTrue(!ids.includes("scope-already-checked"), "scope: already-checked row (brreg_checked_at set) excluded from candidates");
      assertTrue(!ids.includes("scope-dental"), "scope: dental-vertical row excluded from candidates (mirrors POST /register gating)");
      assertTrue(ids.includes("scope-eligible"), "scope: experiences-vertical row with a fresh org_nr IS a candidate");
    }

    // Wipe the fixture rows from (b)/(c) so the remaining tests work with a
    // clean, small, deterministic candidate set.
    testDb.exec("DELETE FROM agents");

    // ── (d) POST dry_run (default + explicit true) makes ZERO DB writes ──
    {
      insertAgent({ id: "dry-1", name: "Dry Gård", orgNr: "950000001" });
      fixtures.set("950000001", { status: 200, body: activeAgentBody("950000001", "Dry Gård AS", "47.220") });

      const callsBefore = fetchCallCount;
      const dryDefault = await callPost({});
      assertEq(dryDefault.status, 200, "dry-default: POST with empty body -> 200");
      assertEq(dryDefault.body?.dry_run, true, "dry-default: dry_run reported true");
      assertEq(dryDefault.body?.would_update_count, 1, "dry-default: would_update_count is 1");
      assertEq(dryDefault.body?.would_update?.[0]?.id, "dry-1", "dry-default: previews the candidate row");
      assertEq(dryDefault.body?.would_update?.[0]?.brreg_verified, 1, "dry-default: preview shows what WOULD be set (verified=1 for allow-listed active org)");
      assertTrue(fetchCallCount > callsBefore, "dry-default: GET-preview-style call DID call verifyOrgNumber (genuine preview, per spec)");

      const rowAfter = readRow("dry-1");
      assertEq(rowAfter.brreg_checked_at, null, "dry-default: brreg_checked_at is STILL null in the DB (no write)");
      assertEq(rowAfter.brreg_verified, 0, "dry-default: brreg_verified is STILL the DB default (no write)");

      const dryExplicit = await callPost({ dry_run: true });
      assertEq(dryExplicit.body?.dry_run, true, "dry-explicit: dry_run:true honored");
      const rowAfter2 = readRow("dry-1");
      assertEq(rowAfter2.brreg_checked_at, null, "dry-explicit: still no write after a second dry-run call");

      // STRICT-FALSE parse pins: only the literal JSON boolean `false`
      // triggers a real write — a truthy/falsy regression here (e.g.
      // switching to `!body.dry_run` or `Boolean(body.dry_run) === false`)
      // would silently turn "false" (string), 0, or null into real writes.
      const dryStringFalse = await callPost({ dry_run: "false" as any });
      assertEq(dryStringFalse.body?.dry_run, true, 'dry-pin: dry_run:"false" (string) still treated as dry-run');
      const rowAfterStringFalse = readRow("dry-1");
      assertEq(rowAfterStringFalse.brreg_checked_at, null, 'dry-pin: dry_run:"false" (string) makes zero writes');

      const dryZero = await callPost({ dry_run: 0 as any });
      assertEq(dryZero.body?.dry_run, true, "dry-pin: dry_run:0 still treated as dry-run");
      const rowAfterZero = readRow("dry-1");
      assertEq(rowAfterZero.brreg_checked_at, null, "dry-pin: dry_run:0 makes zero writes");

      const dryNull = await callPost({ dry_run: null as any });
      assertEq(dryNull.body?.dry_run, true, "dry-pin: dry_run:null still treated as dry-run");
      const rowAfterNull = readRow("dry-1");
      assertEq(rowAfterNull.brreg_checked_at, null, "dry-pin: dry_run:null makes zero writes");
    }

    testDb.exec("DELETE FROM agents");
    fixtures.clear();

    // ── (e) POST dry_run:false (apply): writes exactly the capped batch,
    //     touches no other column, dissolved org flagged never deleted ────
    {
      insertAgent({ id: "apply-verified", name: "Verifiserbar Gård", orgNr: "960000001" });
      fixtures.set("960000001", { status: 200, body: activeAgentBody("960000001", "Verifiserbar Gård AS", "47.220") });

      insertAgent({ id: "apply-dissolved", name: "Nedlagt Gård", orgNr: "960000002", isActive: 1 });
      fixtures.set("960000002", { status: 200, body: dissolvedAgentBody("960000002", "Nedlagt Gård AS") });

      insertAgent({ id: "apply-notfound", name: "Ukjent Gård", orgNr: "960000003" });
      // No fixture registered for 960000003 -> stub falls through to 404.

      const beforeDissolved = readRow("apply-dissolved");

      const apply = await callPost({ dry_run: false });
      assertEq(apply.status, 200, "apply: POST dry_run:false -> 200");
      assertEq(apply.body?.dry_run, false, "apply: dry_run reported false");
      assertEq(apply.body?.updated_count, 3, "apply: updated_count is 3 (all candidates fit in one batch)");

      const verifiedRow = readRow("apply-verified");
      assertEq(verifiedRow.brreg_verified, 1, "apply: allow-listed active org -> brreg_verified=1");
      assertEq(verifiedRow.brreg_flag, null, "apply: allow-listed active org -> brreg_flag=null");
      assertTrue(typeof verifiedRow.brreg_checked_at === "string" && verifiedRow.brreg_checked_at.length > 0,
        "apply: brreg_checked_at stamped for the verified row");

      const dissolvedRow = readRow("apply-dissolved");
      assertEq(dissolvedRow.brreg_verified, 0, "apply: dissolved org -> brreg_verified=0");
      assertEq(dissolvedRow.brreg_flag, "dissolved", "apply: dissolved org -> brreg_flag='dissolved'");
      assertEq(dissolvedRow.is_active, beforeDissolved.is_active, "apply: dissolved row's is_active is UNCHANGED (never de-listed)");
      assertEq(dissolvedRow.name, beforeDissolved.name, "apply: dissolved row's name is UNCHANGED (only brreg_* columns written)");
      assertEq(dissolvedRow.trust_score, beforeDissolved.trust_score, "apply: dissolved row's trust_score is UNCHANGED");

      const stillExists = testDb.prepare("SELECT COUNT(*) AS n FROM agents WHERE id = ?").get("apply-dissolved") as { n: number };
      assertEq(stillExists.n, 1, "apply: dissolved agent row still EXISTS (never DELETEd)");

      const notFoundRow = readRow("apply-notfound");
      assertEq(notFoundRow.brreg_flag, "no_orgnr", "apply: not-found org -> brreg_flag='no_orgnr'");

      const reviewIds = (apply.body?.flagged_for_review ?? []).map((r: any) => r.id).sort();
      assertEq(reviewIds, ["apply-dissolved"], "apply: flagged_for_review lists exactly the dissolved row (not the no_orgnr row)");
    }

    // ── (f) idempotent re-run: previously-checked rows excluded next time ─
    {
      const callsBefore = fetchCallCount;
      const applyAgain = await callPost({ dry_run: false });
      assertEq(applyAgain.body?.candidate_count, 0, "idempotent: second apply run finds zero candidates left");
      assertEq(applyAgain.body?.updated_count, 0, "idempotent: second apply run updates nothing");
      assertEq(fetchCallCount, callsBefore, "idempotent: second apply run makes zero new Brreg fetch calls (rows already checked, excluded pre-fetch)");

      // A fresh, never-checked row IS still picked up alongside the
      // already-checked ones sitting in the table.
      insertAgent({ id: "apply-fresh-2", name: "Ny Gård", orgNr: "960000004" });
      fixtures.set("960000004", { status: 200, body: activeAgentBody("960000004", "Ny Gård AS", "47.220") });
      const applyFresh = await callPost({ dry_run: false });
      assertEq(applyFresh.body?.updated_count, 1, "idempotent: a genuinely new candidate in the same table IS picked up");
      assertEq(applyFresh.body?.updated?.[0]?.id, "apply-fresh-2", "idempotent: updates exactly the new row, not the already-checked ones");
    }

    // ── batch-cap enforcement on POST apply (real run never exceeds cap) ──
    testDb.exec("DELETE FROM agents");
    fixtures.clear();
    {
      const CAP = 50;
      for (let i = 0; i < CAP + 3; i++) {
        const orgNr = `97${String(i).padStart(7, "0")}`;
        insertAgent({ id: `batch-${i}`, name: `Batch Gård ${i}`, orgNr });
        fixtures.set(orgNr, { status: 200, body: activeAgentBody(orgNr, `Batch Gård ${i} AS`, "47.220") });
      }
      const apply1 = await callPost({ dry_run: false });
      assertEq(apply1.body?.updated_count, CAP, "batch-apply: first apply run updates exactly BRREG_SWEEP_BATCH_CAP rows");
      assertEq(apply1.body?.remaining_count, 3, "batch-apply: remaining_count reports the 3 rows left in the backlog");

      const stillUnchecked = testDb.prepare("SELECT COUNT(*) AS n FROM agents WHERE brreg_checked_at IS NULL").get() as { n: number };
      assertEq(stillUnchecked.n, 3, "batch-apply: exactly 3 rows remain unchecked in the DB after the first capped run");

      const apply2 = await callPost({ dry_run: false });
      assertEq(apply2.body?.updated_count, 3, "batch-apply: a second run picks up exactly the remaining 3 rows");
      assertEq(apply2.body?.candidate_count, 3, "batch-apply: second run's scan-time candidate_count is 3");

      const finalUnchecked = testDb.prepare("SELECT COUNT(*) AS n FROM agents WHERE brreg_checked_at IS NULL").get() as { n: number };
      assertEq(finalUnchecked.n, 0, "batch-apply: zero rows remain unchecked after both capped runs");
    }

    // ── race fix: applyBrregSweepRowUpdate() is an atomic conditional
    //     UPDATE ... WHERE id = ? AND brreg_checked_at IS NULL, not a
    //     separate pre-write SELECT. Proves the atomicity property directly
    //     (no real thread concurrency needed): given a row whose
    //     brreg_checked_at is still NULL, calling the helper twice in a row
    //     with the same outcome payload — simulating two concurrent sweep/
    //     registration callers that both raced past the scan and both
    //     finished their (stubbed) Brreg fetch for the same row — must
    //     write exactly once. The first call "wins" (changes===1, returns
    //     true); the second finds brreg_checked_at no longer NULL and
    //     "loses" (changes===0, returns false) instead of clobbering the
    //     first caller's outcome. ───────────────────────────────────────
    testDb.exec("DELETE FROM agents");
    fixtures.clear();
    {
      insertAgent({ id: "race-row", name: "Race Gård", orgNr: "990000001" });

      const outcomeA = { brreg_verified: 1, brreg_flag: null, brreg_checked_at: "2026-07-11T10:00:00.000Z" };
      const outcomeB = { brreg_verified: 0, brreg_flag: "dissolved", brreg_checked_at: "2026-07-11T10:00:01.000Z" };

      // First "concurrent" caller: row is still unclaimed -> wins the write.
      const wonFirst = applyBrregSweepRowUpdate(testDb as any, "race-row", outcomeA);
      assertTrue(wonFirst === true, "race: first concurrent call to applyBrregSweepRowUpdate wins (changes===1 -> true)");

      // Second "concurrent" caller: same row, same pre-set brreg_checked_at
      // state (NULL) as of when it started its own Brreg fetch, but by the
      // time it writes, the first caller already claimed the row -> loses.
      const wonSecond = applyBrregSweepRowUpdate(testDb as any, "race-row", outcomeB);
      assertTrue(wonSecond === false, "race: second concurrent call to applyBrregSweepRowUpdate loses (changes===0 -> false), does NOT clobber");

      // The row must reflect ONLY the winner's outcome (outcomeA), never
      // the loser's (outcomeB) — this is the "never clobber" guarantee the
      // original comment claimed but the pre-fix code did not actually make.
      const finalRow = readRow("race-row");
      assertEq(finalRow.brreg_verified, outcomeA.brreg_verified, "race: final row has the WINNER's brreg_verified, not the loser's");
      assertEq(finalRow.brreg_flag, outcomeA.brreg_flag, "race: final row has the WINNER's brreg_flag, not the loser's");
      assertEq(finalRow.brreg_checked_at, outcomeA.brreg_checked_at, "race: final row has the WINNER's brreg_checked_at, not the loser's");
    }

    // ── (g) badge: /produsent/:slug renders the Brreg badge only when
    //     brreg_verified=1 ────────────────────────────────────────────────
    testDb.exec("DELETE FROM agents");
    {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          org_nr, vertical_id, brreg_verified, brreg_flag, brreg_checked_at, is_active
        ) VALUES ('badge-verified', 'Brreg Verifisert Gård', 'En fin gård', 'Brreg Verifisert Gård',
          'post@example.com', 'https://example.com', 'producer', 'key-badge-verified',
          '980000001', 'rfb', 1, NULL, '2026-07-01T00:00:00.000Z', 1)`,
      ).run();
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          org_nr, vertical_id, brreg_verified, brreg_flag, brreg_checked_at, is_active
        ) VALUES ('badge-unverified', 'Ikke Verifisert Gård', 'En annen fin gård', 'Ikke Verifisert Gård',
          'post2@example.com', 'https://example.com', 'producer', 'key-badge-unverified',
          '980000002', 'rfb', 0, NULL, NULL, 1)`,
      ).run();

      // The SEO router's shell() calls getConfig(), which throws unless
      // loadConfigsAtBoot() has run first in this process. Safe/idempotent
      // to call again even if some other harness already loaded it.
      const { loadConfigsAtBoot } = require("../config/vertical-config") as
        typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded by another suite, or dir missing in CI — best-effort */ }

      const seoRoutePath = require.resolve("./seo");
      delete require.cache[seoRoutePath];
      const seoRouter = require("./seo").default as any;
      const layer = (seoRouter.stack as any[]).find(
        (l: any) => l.route && l.route.path === "/produsent/:slug" && l.route.methods?.get,
      );
      assertTrue(!!layer, "badge: GET /produsent/:slug layer is registered");
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;

      function invokeProdusent(slug: string): { status: number; body: string } {
        let status = 200;
        let body = "";
        const res: any = {
          status: (c: number) => { status = c; return res; },
          send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
          redirect: (_c: number, _l: string) => { status = 301; return res; },
        };
        const req: any = { params: { slug }, lang: "no", ip: "127.0.0.1" };
        handler(req, res);
        return { status, body };
      }

      const verifiedPage = invokeProdusent("brreg-verifisert-gard");
      assertEq(verifiedPage.status, 200, "badge: verified agent's profile page renders 200");
      assertTrue(
        verifiedPage.body.includes("Registrert i Brønnøysund"),
        "badge: brreg_verified=1 agent's profile page includes the Brreg badge",
      );

      const unverifiedPage = invokeProdusent("ikke-verifisert-gard");
      assertEq(unverifiedPage.status, 200, "badge: unverified agent's profile page renders 200");
      assertTrue(
        !unverifiedPage.body.includes("Registrert i Brønnøysund"),
        "badge: brreg_verified=0 agent's profile page does NOT include the Brreg badge",
      );
    }
  } catch (err) {
    failed++;
    failures.push(`brreg-catalog-sweep: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./seo")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-brreg-catalog-sweep.test.ts`
if (require.main === module) {
  console.log("── admin-agents brreg-catalog-sweep (dev-request 2026-06-30-brreg-verification-gate, Slice 3) unit tests ──");
  runBrregCatalogSweepTests({ log: true }).then((r) => {
    console.log(`\nbrreg-catalog-sweep: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
