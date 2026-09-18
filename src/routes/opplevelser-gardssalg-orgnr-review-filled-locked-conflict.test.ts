/**
 * opplevelser-gardssalg-orgnr-review-filled-locked-conflict.test.ts — tests
 * for dev-request 2026-09-16-opplevagent-orgnr-review-godkjent-men-skriving-
 * avvist.
 *
 * Diagnosis this dev-request fixes: 2 of 15 stale gardssalg_orgnr_review_queue
 * rows (Små Vesen Bryggeri, Atlungstad Brenneri) had the LLM judge
 * (POST /admin/gardssalg-orgnr-review-judge) say GODKJENN, but the write step
 * (POST /admin/gardssalg-orgnr-review-approve, called in-process by the
 * judge) refused with ONE generic, undifferentiated reason —
 * `write_refused_filled_locked_or_conflict` — and the row sat in the queue
 * forever with no record of WHICH of the three distinct causes applied. This
 * file proves the fix, using synthetic fixtures shaped like (and flavored
 * with the real provider names of) the two live rows — a fresh sandbox DB
 * has no access to their actual stored data, so the exact filled/locked/
 * conflict split for each REAL row is not reproduced here; instead one
 * fixture per distinct blocking reason is built directly.
 *
 * Covers (POST /admin/gardssalg-orgnr-review-approve, apply:true, unless noted):
 *   f1  "locked" — owner-locked provider (content_source='manual', "Små Vesen
 *       Bryggeri" flavor): rejected with the distinct reason "locked"
 *       (never the old generic string), nothing written, queue row survives.
 *   f2  "conflict" — provider's stored org_nr genuinely DIFFERS from the
 *       approved candidate ("Atlungstad Brenneri" flavor): rejected with
 *       "conflict", BOTH stored_org_nr and candidate_org_nr surfaced, the
 *       provider's stored org_nr is byte-for-byte UNCHANGED afterward (the
 *       regression proof that a genuinely conflicting value is never
 *       auto-overwritten), queue row survives.
 *   f3  "filled" + IDENTICAL — provider's stored org_nr already equals the
 *       approved candidate: the row is marked done and REMOVED from the
 *       queue WITHOUT any write — proven by asserting zero
 *       gardssalg_content_audit rows for that provider's org_nr field (the
 *       one and only place applyGardssalgProviderOrgnr's real UPDATE ever
 *       leaves a trace) — AND the existing Brreg-verify flow fires for the
 *       provider in the same pass (brreg_verified flips 0 -> 1, via the
 *       injectable __setGardssalgBrregVerifyForTesting seam, zero network).
 *   f4  A genuine write (provider's org_nr was blank) ALSO triggers the same
 *       Brreg-verify flow in the same pass — f3's trigger isn't special-cased
 *       to the auto-close path only.
 *   f5  End-to-end via the JUDGE route (POST /admin/gardssalg-orgnr-review-
 *       judge, LLM stubbed GODKJENN): a locked row and a conflict row both
 *       land back in the queue with their reason differentiated (contains
 *       "locked"/"conflict", never the old generic string) — then GET
 *       /admin/gardssalg-review-queues-staleness (AC1) shows each row's
 *       reason as one of filled/locked/conflict plus the candidate/stored
 *       values it needs, and NO row anywhere carries the old undifferentiated
 *       reason string.
 *   f6  GET /admin/gardssalg-orgnr-review-queue (the full listing) carries
 *       the new stored_org_nr field via listGardssalgOrgnrReviewQueue's join.
 *   f7  Independent-review follow-up fix: the two REAL live rows (Små Vesen
 *       Bryggeri, Atlungstad Brenneri) are already stuck with `reason`
 *       overwritten to the OLD generic string by a PRIOR (pre-fix) judge
 *       run, so the judge route's `WHERE reason = 'needs_human_review'`
 *       re-select would never touch them again under the new code alone.
 *       init-experiences.ts's initExperiencesSchema() now resets any row
 *       whose reason still matches the old generic pattern back to
 *       'needs_human_review' on every schema init (== every boot/redeploy,
 *       idempotent, no `migrations`-table guard needed — same idiom as this
 *       table's own CREATE TABLE IF NOT EXISTS). f7 reproduces the exact
 *       stuck string, re-runs initExperiencesSchema() against the
 *       already-populated db handle (redeploy-reboot simulation, twice —
 *       proving idempotency), then runs an actual judge pass and asserts
 *       the row lands on a real, differentiated reason — and finally checks
 *       GET /admin/gardssalg-review-queues-staleness end-to-end for AC1's
 *       literal observable outcome: 0 rows anywhere with the old string.
 *
 * Harness: in-memory "experiences" DB + fresh require-cache purge +
 * Router.handle() dispatch, same convention as every sibling gardssalg-orgnr-
 * review test file.
 *
 * Standalone:
 *   npx tsx src/routes/opplevelser-gardssalg-orgnr-review-filled-locked-conflict.test.ts
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
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: any; query?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method ?? "POST",
      url: path,
      originalUrl: path,
      path,
      query: opts.query ?? {},
      headers,
      body: opts.body ?? {},
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

function anthropicJudgeFetch(text: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (!urlStr.includes("api.anthropic.com")) {
      throw new Error(`unexpected non-Anthropic fetch: ${urlStr}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text }] }),
    } as unknown as Response;
  }) as typeof fetch;
}

export function runOpplevelserGardssalgOrgnrReviewFilledLockedConflictTests(
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
    assertEq(cond, true, label);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    const testKey = process.env.ADMIN_KEY || "gardssalg-orgnr-flc-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("../services/experience-store");
    const judgePath = require.resolve("../services/orgnr-identity-judge");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, storePath, judgePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, content_source, producer_type, brreg_verified, field_provenance, created_at)
         VALUES (@id, @navn, 'experiences', @org_nr, @content_source, @producer_type, @brreg_verified, NULL, '2026-01-01')`,
      );

      const APPROVE_PATH = "/admin/gardssalg-orgnr-review-approve";

      // ═══ f1: "locked" — owner-locked provider, "Små Vesen Bryggeri" flavor ═
      {
        insertProvider.run({
          id: "flc-locked", navn: "Små Vesen Bryggeri (test)", org_nr: null,
          content_source: "manual", producer_type: "bryggeri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-locked",
          provider_name: "Små Vesen Bryggeri (test)",
          candidate_orgnr: "910200001",
          candidate_name: "SMAA VESEN BRYGGERI AS",
          reason: "needs_human_review",
        });

        const r = await callRoute(opplevelserRouter, APPROVE_PATH, {
          headers: { "x-admin-key": testKey },
          body: { approvals: [{ provider_id: "flc-locked", org_nr: "910200001" }], apply: true },
        });
        assertEq(r.status, 200, "f1a: 200");
        assertEq(r.body.approved?.length, 0, "f1b: nothing approved");
        assertEq(r.body.rejected?.[0]?.reason, "locked",
          "f1c: rejected with the distinct 'locked' reason, not the old generic write_refused_filled_locked_or_conflict");
        assertEq(r.body.rejected?.[0]?.candidate_org_nr, "910200001", "f1d: candidate_org_nr surfaced");

        const row = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'flc-locked'`).get() as { org_nr: string | null };
        assertEq(row.org_nr, null, "f1e: nothing written — the owner-lock always wins");

        const queueRow = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-locked'`).get() as { n: number };
        assertEq(queueRow.n, 1, "f1f: queue row survives — a locked row is never auto-removed");

        const auditRows = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'flc-locked'`).get() as { n: number };
        assertEq(auditRows.n, 0, "f1g: no write/UPDATE ever attempted (no audit row)");
      }

      // ═══ f2: "conflict" — stored value genuinely differs, "Atlungstad
      //         Brenneri" flavor. Also the regression proof: a genuinely
      //         conflicting value is NEVER auto-overwritten. ═══════════════
      {
        insertProvider.run({
          id: "flc-conflict", navn: "Atlungstad Brenneri (test)", org_nr: "910200100",
          content_source: "provider_site", producer_type: "destilleri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-conflict",
          provider_name: "Atlungstad Brenneri (test)",
          candidate_orgnr: "910200101",
          candidate_name: "ATLUNGSTAD BRENNERI AS",
          reason: "needs_human_review",
        });

        const r = await callRoute(opplevelserRouter, APPROVE_PATH, {
          headers: { "x-admin-key": testKey },
          body: { approvals: [{ provider_id: "flc-conflict", org_nr: "910200101" }], apply: true },
        });
        assertEq(r.body.approved?.length, 0, "f2a: nothing approved");
        assertEq(r.body.rejected?.[0]?.reason, "conflict",
          "f2b: rejected with the distinct 'conflict' reason (a real disagreement, not just 'already filled')");
        assertEq(r.body.rejected?.[0]?.stored_org_nr, "910200100", "f2c: the STORED value is surfaced");
        assertEq(r.body.rejected?.[0]?.candidate_org_nr, "910200101", "f2d: the CANDIDATE value is surfaced alongside it");

        const row = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'flc-conflict'`).get() as { org_nr: string | null };
        assertEq(row.org_nr, "910200100",
          "f2e: REGRESSION — the stored org_nr is byte-for-byte unchanged; a genuinely conflicting candidate is never auto-written");

        const queueRow = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-conflict'`).get() as { n: number };
        assertEq(queueRow.n, 1, "f2f: queue row survives for human/future review — never silently dropped");

        const auditRows = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'flc-conflict'`).get() as { n: number };
        assertEq(auditRows.n, 0, "f2g: no write/UPDATE ever attempted (no audit row) — proves no UPDATE call happened");
      }

      // ═══ f3: "filled" + IDENTICAL — auto-close WITHOUT a write, plus the
      //         Brreg-verify trigger firing in the same pass ═══════════════
      {
        insertProvider.run({
          id: "flc-identical", navn: "Identisk Gard (test)", org_nr: "910200200",
          content_source: "provider_site", producer_type: "bryggeri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-identical",
          provider_name: "Identisk Gard (test)",
          candidate_orgnr: "910200200", // SAME as the already-stored value
          candidate_name: "IDENTISK GARD AS",
          reason: "needs_human_review",
        });

        const brregCalls: string[] = [];
        expStore.__setGardssalgBrregVerifyForTesting(async (orgNr: string) => {
          brregCalls.push(orgNr);
          return {
            exists: true, active: true, name: "IDENTISK GARD AS",
            nace: ["11.050"], registrertDato: "2015-01-01", slettetDato: null, flag: null,
          };
        });

        const r = await callRoute(opplevelserRouter, APPROVE_PATH, {
          headers: { "x-admin-key": testKey },
          body: { approvals: [{ provider_id: "flc-identical", org_nr: "910200200" }], apply: true },
        });
        assertEq(r.body.rejected?.length, 0, "f3a: nothing rejected");
        assertEq(r.body.approved?.[0]?.provider_id, "flc-identical", "f3b: lands in approved (resolved, just not via a write)");
        assertEq(r.body.approved?.[0]?.already_confirmed, true, "f3c: flagged already_confirmed — no write happened");

        const auditRows = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_content_audit WHERE provider_id = 'flc-identical' AND field_name = 'org_nr'`).get() as { n: number };
        assertEq(auditRows.n, 0,
          "f3d: PROOF no UPDATE/write call happened for org_nr — applyGardssalgProviderOrgnr always leaves an audit row when it actually writes, and there is none");

        const queueRow = expDb.prepare(`SELECT COUNT(*) AS n FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-identical'`).get() as { n: number };
        assertEq(queueRow.n, 0, "f3e: the row IS removed from the queue (marked done) — the one behavior change this dev-request authorizes");

        assertTrue(brregCalls.includes("910200200"), "f3f: the existing Brreg-verify flow was triggered for the provider in the same pass");
        const providerRow = expDb.prepare(`SELECT brreg_verified FROM experience_providers WHERE id = 'flc-identical'`).get() as { brreg_verified: number };
        assertEq(providerRow.brreg_verified, 1, "f3g: brreg_verified actually flipped 0 -> 1 via the triggered flow");

        expStore.__setGardssalgBrregVerifyForTesting(null);
      }

      // ═══ f4: a GENUINE write (blank -> filled) also triggers the SAME
      //         Brreg-verify flow — not special-cased to auto-close only ════
      {
        insertProvider.run({
          id: "flc-write", navn: "Skriver Gard (test)", org_nr: null,
          content_source: "provider_site", producer_type: "bryggeri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-write",
          provider_name: "Skriver Gard (test)",
          candidate_orgnr: "910200300",
          candidate_name: "SKRIVER GARD AS",
          reason: "needs_human_review",
        });

        const brregCalls: string[] = [];
        expStore.__setGardssalgBrregVerifyForTesting(async (orgNr: string) => {
          brregCalls.push(orgNr);
          return {
            exists: true, active: true, name: "SKRIVER GARD AS",
            nace: ["11.050"], registrertDato: "2015-01-01", slettetDato: null, flag: null,
          };
        });

        const r = await callRoute(opplevelserRouter, APPROVE_PATH, {
          headers: { "x-admin-key": testKey },
          body: { approvals: [{ provider_id: "flc-write", org_nr: "910200300" }], apply: true },
        });
        assertEq(r.body.approved?.[0]?.provider_id, "flc-write", "f4a: approved via a genuine write");
        assertTrue(!r.body.approved?.[0]?.already_confirmed, "f4b: NOT already_confirmed — this was a real write");

        const providerRow = expDb.prepare(`SELECT org_nr, brreg_verified FROM experience_providers WHERE id = 'flc-write'`).get() as { org_nr: string | null; brreg_verified: number };
        assertEq(providerRow.org_nr, "910200300", "f4c: org_nr actually written");
        assertTrue(brregCalls.includes("910200300"), "f4d: Brreg-verify triggered for the genuine-write path too");
        assertEq(providerRow.brreg_verified, 1, "f4e: brreg_verified flipped 0 -> 1 in the same pass");

        const auditRows = expDb
          .prepare(`SELECT field_name FROM gardssalg_content_audit WHERE provider_id = 'flc-write' ORDER BY changed_at ASC`)
          .all() as Array<{ field_name: string }>;
        assertTrue(auditRows.some((a) => a.field_name === "org_nr"), "f4f: org_nr write IS audited (unlike f3's no-op)");

        expStore.__setGardssalgBrregVerifyForTesting(null);
      }

      // ═══ f5: end-to-end via the JUDGE route — GODKJENN but write blocked,
      //         staleness endpoint (AC1) shows the differentiated reason +
      //         values, never the old generic string ═══════════════════════
      {
        insertProvider.run({
          id: "flc-judge-locked", navn: "Dommer Låst Gard (test)", org_nr: null,
          content_source: "manual", producer_type: "bryggeri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-judge-locked",
          provider_name: "Dommer Låst Gard (test)",
          candidate_orgnr: "910200400",
          candidate_name: "DOMMER LAST GARD AS",
          candidate_address: "Ein adresse, 5000 Bergen",
          reason: "needs_human_review",
        });
        insertProvider.run({
          id: "flc-judge-conflict", navn: "Dommer Konflikt Gard (test)", org_nr: "910200500",
          content_source: "provider_site", producer_type: "bryggeri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-judge-conflict",
          provider_name: "Dommer Konflikt Gard (test)",
          candidate_orgnr: "910200501",
          candidate_name: "DOMMER KONFLIKT GARD AS",
          candidate_address: "Ein annen adresse, 5000 Bergen",
          reason: "needs_human_review",
        });

        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nSamme produsent — navn og sted stemmer overens.");

        const judgeRes = await callRoute(opplevelserRouter, "/admin/gardssalg-orgnr-review-judge", {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        assertEq(judgeRes.status, 200, "f5a: judge run 200");
        assertTrue((judgeRes.body.rejected as number) >= 2, "f5b: both rows counted rejected — the judge said GODKJENN but the write was blocked for both");

        const staleRes = await callRoute(opplevelserRouter, "/admin/gardssalg-review-queues-staleness", {
          method: "GET",
          headers: { "x-admin-key": testKey },
        });
        assertEq(staleRes.status, 200, "f5c: staleness 200");
        const oldestFirst = (staleRes.body?.orgnr_review_queue?.oldest_first as any[]) ?? [];

        const lockedRow = oldestFirst.find((x) => x.provider_id === "flc-judge-locked");
        assertTrue(!!lockedRow, "f5d: the locked row is present in the staleness report");
        assertTrue(/locked/i.test(lockedRow?.reason ?? ""), "f5e: its reason names 'locked' — not the old generic string");
        assertTrue(!/write_refused_filled_locked_or_conflict/.test(lockedRow?.reason ?? ""),
          "f5f: the OLD undifferentiated reason string is gone");

        const conflictRow = oldestFirst.find((x) => x.provider_id === "flc-judge-conflict");
        assertTrue(!!conflictRow, "f5g: the conflict row is present in the staleness report");
        assertTrue(/conflict/i.test(conflictRow?.reason ?? ""), "f5h: its reason names 'conflict' — not the old generic string");
        assertEq(conflictRow?.stored_org_nr, "910200500", "f5i: AC1 — the staleness row surfaces the STORED value it needs");
        assertEq(conflictRow?.candidate_org_nr, "910200501", "f5j: AC1 — and the CANDIDATE value alongside it");

        // AC1, whole-queue guard: NOT ONE row anywhere still carries the old
        // undifferentiated reason string.
        assertTrue(
          !oldestFirst.some((x) => x.reason === "write_refused_filled_locked_or_conflict" || /write_refused_filled_locked_or_conflict/.test(String(x.reason ?? ""))),
          "f5k: AC1 — no remaining row in the whole orgnr_review_queue report carries the old undifferentiated reason",
        );

        const providerRowLocked = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'flc-judge-locked'`).get() as { org_nr: string | null };
        assertEq(providerRowLocked.org_nr, null, "f5l: locked provider's org_nr still untouched after the judge run");
        const providerRowConflict = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'flc-judge-conflict'`).get() as { org_nr: string | null };
        assertEq(providerRowConflict.org_nr, "910200500", "f5m: conflict provider's stored org_nr still untouched after the judge run");
      }

      // ═══ f6: GET /admin/gardssalg-orgnr-review-queue carries stored_org_nr ═
      {
        const r = await callRoute(opplevelserRouter, "/admin/gardssalg-orgnr-review-queue", {
          method: "GET",
          headers: { "x-admin-key": testKey },
        });
        assertEq(r.status, 200, "f6a: 200");
        const entry = (r.body.entries as any[])?.find((e) => e.provider_id === "flc-judge-conflict");
        assertTrue(!!entry, "f6b: the conflict row is listed");
        assertEq(entry?.stored_org_nr, "910200500", "f6c: the full listing now carries stored_org_nr via the join");
        assertEq(entry?.candidate_orgnr, "910200501", "f6d: candidate_orgnr is still the pre-existing column, unaffected");
      }

      // ═══ f7: the OLD generic-reason backfill/reset migration
      //         (init-experiences.ts) — a row stuck on the pre-fix collapsed
      //         reason string gets reset back to 'needs_human_review' on the
      //         next schema init (== a redeploy reboot), and THEN, on the
      //         next judge pass, is re-processed into a real, differentiated
      //         reason — proving AC1's actual observable outcome (0 rows
      //         anywhere still carrying the old undifferentiated reason
      //         after deploy), not just that the reset UPDATE runs. ═══════
      {
        // Simulate a live row exactly as it was left by a PRE-fix judge run:
        // stuck on the old collapsed string, no stored/candidate detail
        // suffix (the old code never had it), "Små Vesen Bryggeri" flavor —
        // the actual live row this dev-request is about.
        insertProvider.run({
          id: "flc-stale-generic", navn: "Små Vesen Bryggeri (stale, test)", org_nr: null,
          content_source: "manual", producer_type: "bryggeri", brreg_verified: 0,
        });
        expStore.upsertGardssalgOrgnrReviewQueue({
          provider_id: "flc-stale-generic",
          provider_name: "Små Vesen Bryggeri (stale, test)",
          candidate_orgnr: "910200600",
          candidate_name: "SMAA VESEN BRYGGERI AS",
          candidate_address: "Ein tredje adresse, 5000 Bergen",
          reason: "needs_human_review",
        });
        // Overwrite the reason directly to the OLD stuck state — this is
        // what a prior (pre-fix) judge run actually left on disk; nothing in
        // the current diff's normal call paths produces this string anymore,
        // so it must be written directly to reproduce the stuck condition.
        expDb.prepare(
          `UPDATE gardssalg_orgnr_review_queue SET reason = ? WHERE provider_id = ?`,
        ).run("judge GODKJENN but write blocked: write_refused_filled_locked_or_conflict", "flc-stale-generic");

        const beforeReset = expDb
          .prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-stale-generic'`)
          .get() as { reason: string };
        assertEq(
          beforeReset.reason,
          "judge GODKJENN but write blocked: write_refused_filled_locked_or_conflict",
          "f7a: fixture reproduces the real stuck pre-fix reason string",
        );

        // Redeploy reboot == re-running initExperiencesSchema() against the
        // ALREADY-populated db handle (same "re-run on redeploy" pattern as
        // init-dental.test.ts / init-crm-threads-b3-status-migration.test.ts).
        const { initExperiencesSchema } = require("../database/init-experiences") as typeof import("../database/init-experiences");
        initExperiencesSchema(expDb);

        const afterReset = expDb
          .prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-stale-generic'`)
          .get() as { reason: string };
        assertEq(afterReset.reason, "needs_human_review",
          "f7b: the migration resets the stale generic reason back to 'needs_human_review' — the judge route's own re-select condition");

        // Idempotency: a second re-run changes nothing further and doesn't error.
        initExperiencesSchema(expDb);
        const afterSecondRun = expDb
          .prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-stale-generic'`)
          .get() as { reason: string };
        assertEq(afterSecondRun.reason, "needs_human_review", "f7c: idempotent — a second schema re-run is a no-op for this row");

        // Now the NEXT judge pass naturally re-selects and re-processes it
        // (owner-locked provider, so GODKJENN still hits the write guard —
        // but now with the DIFFERENTIATED "locked" reason, never the old
        // generic string).
        process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
        globalThis.fetch = anthropicJudgeFetch("GODKJENN\nSamme produsent — navn og sted stemmer overens.");
        const judgeRes = await callRoute(opplevelserRouter, "/admin/gardssalg-orgnr-review-judge", {
          headers: { "x-admin-key": testKey },
          body: { limit: 30 },
        });
        assertEq(judgeRes.status, 200, "f7d: judge run 200");

        const afterJudge = expDb
          .prepare(`SELECT reason FROM gardssalg_orgnr_review_queue WHERE provider_id = 'flc-stale-generic'`)
          .get() as { reason: string } | undefined;
        assertTrue(!!afterJudge, "f7e: the row still exists (locked, not auto-closed)");
        assertTrue(/locked/i.test(afterJudge?.reason ?? ""),
          "f7f: re-classified into the real, differentiated 'locked' reason on the very next judge pass");
        assertTrue(
          !/write_refused_filled_locked_or_conflict/.test(afterJudge?.reason ?? ""),
          "f7g: the old undifferentiated reason string is gone for this row",
        );

        // AC1's actual observable outcome, end-to-end: the staleness endpoint
        // shows ZERO rows anywhere carrying the old undifferentiated reason.
        const staleRes = await callRoute(opplevelserRouter, "/admin/gardssalg-review-queues-staleness", {
          method: "GET",
          headers: { "x-admin-key": testKey },
        });
        assertEq(staleRes.status, 200, "f7h: staleness 200");
        const allRows = (staleRes.body?.orgnr_review_queue?.oldest_first as any[]) ?? [];
        const staleCount = allRows.filter((x) =>
          /write_refused_filled_locked_or_conflict/.test(String(x.reason ?? "")),
        ).length;
        assertEq(staleCount, 0,
          "f7i: AC1 — 0 rows anywhere in the staleness report still carry the old undifferentiated reason, achieved end-to-end (reset -> re-judge -> differentiated)");

        const providerRow = expDb.prepare(`SELECT org_nr FROM experience_providers WHERE id = 'flc-stale-generic'`).get() as { org_nr: string | null };
        assertEq(providerRow.org_nr, null, "f7j: owner-locked provider's org_nr still untouched — the reset never bypasses the write guard itself");
      }

      return { passed, failed, failures };
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-orgnr-review-filled-locked-conflict: unexpected error: " +
          String(err?.stack || err?.message || err),
      );
      return { passed, failed, failures };
    } finally {
      globalThis.fetch = prevFetch;
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        /* best-effort */
      }
      try {
        const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
        expStore.__setGardssalgBrregVerifyForTesting(null);
      } catch {
        /* best-effort */
      }
      for (const p of cachePaths) delete require.cache[p];
    }
  })();
}

// Standalone runner:
//   npx tsx src/routes/opplevelser-gardssalg-orgnr-review-filled-locked-conflict.test.ts
if (require.main === module) {
  runOpplevelserGardssalgOrgnrReviewFilledLockedConflictTests({ log: true }).then((s) => {
    console.log(`\ngardssalg-orgnr-review-filled-locked-conflict: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0) {
      for (const f of s.failures) console.error(f);
      process.exit(1);
    }
    process.exit(0);
  });
}
