/**
 * opplevelser-experiences-needs-review-triage.test.ts — tests for dev-request
 * 2026-09-17-opplevagent-needs-review-terminal-triage.
 *
 * PROBLEM this closes: `needs_review` (~2993 rows) has no terminal state —
 * a canonical duplicate, a provider deleted in Brreg, a row with no
 * evidence_url and no provider website, or a row judged MISMATCH twice on a
 * live page, sits in quarantine forever.
 *
 * THE FIX: POST /admin/experiences-needs-review-triage (src/routes/
 * opplevelser.ts) rejects a `needs_review` row to `verification_status =
 * 'rejected'` when ANY ONE of four independent rules fires — (a)
 * provider.brreg_active=0, (b) canonical_id IS NOT NULL, (c) no evidence_url
 * AND no provider website (hjemmeside empty/null AND not
 * isHjemmesideVerified(provider.field_provenance)), (d) the last TWO judge
 * verdicts were both `mismatch:` on a live page, >=7 days apart — EXCEPT
 * owner-locked rows (content_source IN ('manual','claim')), which no rule
 * ever touches. POST /admin/experiences-needs-review-triage-rollback reverts
 * a batch back to needs_review, mirroring POST /admin/experiences-admission-
 * promotion-rollback's "only if still in the terminal state, only the
 * latest audit row for that experience_id" discipline.
 *
 * Rule (d) additionally needs two NEW additive columns
 * (admission_verdict_prev/admission_checked_at_prev, init-experiences.ts)
 * shifted into by stampExperienceAdmissionVerdict() (experience-store.ts) —
 * this file directly seeds those columns via SQL (rather than driving them
 * through repeated judge-sweep calls) to test rule (d) in isolation, exactly
 * as opplevelser-experiences-requarantine-rejudge.test.ts seeds admission_
 * verdict/admission_checked_at directly for its own fixtures.
 *
 * Own dedicated in-memory-db harness, mirrors opplevelser-experiences-
 * admission-promotion.test.ts's harness shape (in-memory experiences DB,
 * fresh requires per run, router.handle() as the HTTP entry point) — but
 * with NO fetch mocking, since this route makes no network/LLM calls at all.
 *
 * Covers:
 *   - each rule (a)-(d) firing independently, one row each.
 *   - owner-locked rows (content_source in manual/claim) NEVER touched by
 *     ANY rule, tested with each rule's condition true PLUS an owner lock.
 *   - rule (c) negative cases: evidence_url present -> no fire; provider has
 *     a non-empty hjemmeside -> no fire; provider hjemmeside blank but
 *     isHjemmesideVerified -> no fire.
 *   - rule (d) negative cases: only ONE post-migration verdict tracked ->
 *     does not qualify (proves the documented history-gap consequence);
 *     two mismatch verdicts <7 days apart -> does not qualify; a dead/parked
 *     `unresolved:` verdict mixed in -> does not qualify.
 *   - rule (d) positive: two mismatch verdicts >=7 days apart on live pages
 *     -> qualifies.
 *   - a row matching no rule stays untouched.
 *   - dry-run (default, and explicit dry_run:true) reports counts/results,
 *     writes nothing.
 *   - apply (dry_run:false) actually writes verification_status='rejected',
 *     stamps admission_verdict via stampExperienceAdmissionVerdict, and
 *     writes exactly one experience_admission_promotion_audit row per
 *     rejected experience.
 *   - keyset (`after`) pagination converges across a small limit.
 *   - rollback: (a) empty batch_id -> 400; (b) unknown batch_id -> graceful
 *     no-op; (c) real batch reverts its own rows, leaves an unrelated
 *     baseline row untouched; (d) re-running the same rollback is a no-op;
 *     (e) a row that "moved on" (verification_status changed away from
 *     'rejected' by something else after the batch) is never reverted —
 *     mirrors opplevelser-experiences-admission-promotion.test.ts's own
 *     rollback test shapes.
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
  opts: { url: string; headers?: Record<string, string>; body?: any },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = opts.url;
    const query: Record<string, string> = {};
    let path = url;
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) {
      path = url.slice(0, qIdx);
      new URLSearchParams(url.slice(qIdx + 1)).forEach((v, k) => {
        query[k] = v;
      });
    }
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path,
      query,
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

export function runOpplevelserExperiencesNeedsReviewTriageTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  let restoreMainDb: (() => void) | null = null;

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
    const testKey = process.env.ADMIN_KEY || "needs-review-triage-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const TRIAGE_URL = "/admin/experiences-needs-review-triage";
      const ROLLBACK_URL = "/admin/experiences-needs-review-triage-rollback";

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers (id, navn, hjemmeside, brreg_active, field_provenance)
         VALUES (@id, @navn, @hjemmeside, @brreg_active, @field_provenance)`,
      );
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, slug, description, category, price_band, price_from,
            evidence_url, verification_status, confidence, canonical_id, content_source,
            enrichment_state, admission_verdict, admission_checked_at,
            admission_verdict_prev, admission_checked_at_prev)
         VALUES
           (@id, @provider_id, @title, @slug, @description, @category, @price_band, @price_from,
            @evidence_url, @verification_status, @confidence, @canonical_id, @content_source,
            'enriched', @admission_verdict, @admission_checked_at,
            @admission_verdict_prev, @admission_checked_at_prev)`,
      );

      const snapshot = (id: string) =>
        expDb
          .prepare(
            `SELECT verification_status, admission_verdict, admission_checked_at,
                    admission_verdict_prev, admission_checked_at_prev
               FROM experiences WHERE id = ?`,
          )
          .get(id) as
          | {
              verification_status: string;
              admission_verdict: string | null;
              admission_checked_at: string | null;
              admission_verdict_prev: string | null;
              admission_checked_at_prev: string | null;
            }
          | undefined;

      const auditRowsFor = (experienceId: string) =>
        expDb
          .prepare(`SELECT * FROM experience_admission_promotion_audit WHERE experience_id = ?`)
          .all(experienceId) as Array<{
          id: string;
          experience_id: string;
          batch_id: string;
          from_status: string;
          to_status: string;
          reason: string | null;
        }>;

      const daysAgo = (n: number): string => {
        const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
        return d.toISOString().slice(0, 19).replace("T", " ");
      };

      const hjemmesideVerifiedProvenance = JSON.stringify({
        hjemmeside_verification: { verified: true, classification: "verified", checked_at: "2026-08-01T00:00:00.000Z" },
      });

      // ── providers ──────────────────────────────────────────────────────
      insertProvider.run({ id: "prov-active", navn: "Aktiv AS", hjemmeside: "https://aktiv.example.no", brreg_active: 1, field_provenance: null });
      insertProvider.run({ id: "prov-inactive", navn: "Nedlagt AS", hjemmeside: "https://nedlagt.example.no", brreg_active: 0, field_provenance: null });
      insertProvider.run({ id: "prov-no-website", navn: "Uten Nettside AS", hjemmeside: null, brreg_active: 1, field_provenance: null });
      insertProvider.run({ id: "prov-website-verified", navn: "Verifisert AS", hjemmeside: null, brreg_active: 1, field_provenance: hjemmesideVerifiedProvenance });

      function seed(e: {
        id: string;
        provider_id: string | null;
        evidence_url?: string | null;
        canonical_id?: string | null;
        content_source?: string | null;
        admission_verdict?: string | null;
        admission_checked_at?: string | null;
        admission_verdict_prev?: string | null;
        admission_checked_at_prev?: string | null;
        verification_status?: string;
      }): void {
        insertExperience.run({
          id: e.id,
          provider_id: e.provider_id,
          title: e.id,
          slug: e.id,
          description: "d",
          category: "aktivitet",
          price_band: "standard",
          price_from: 300,
          evidence_url: e.evidence_url ?? null,
          verification_status: e.verification_status ?? "needs_review",
          confidence: "high",
          canonical_id: e.canonical_id ?? null,
          content_source: e.content_source ?? "provider_site",
          admission_verdict: e.admission_verdict ?? null,
          admission_checked_at: e.admission_checked_at ?? null,
          admission_verdict_prev: e.admission_verdict_prev ?? null,
          admission_checked_at_prev: e.admission_checked_at_prev ?? null,
        });
      }

      // ── rule (a): provider brreg_active=0 ─────────────────────────────
      seed({ id: "rule-a", provider_id: "prov-inactive", evidence_url: "https://good.no/a" });
      // (a) + owner lock -> NEVER touched.
      seed({ id: "rule-a-locked", provider_id: "prov-inactive", evidence_url: "https://good.no/a2", content_source: "manual" });

      // ── rule (b): canonical duplicate ─────────────────────────────────
      seed({ id: "rule-b", provider_id: "prov-active", evidence_url: "https://good.no/b", canonical_id: "some-canonical-row" });
      seed({ id: "rule-b-locked", provider_id: "prov-active", evidence_url: "https://good.no/b2", canonical_id: "some-canonical-row", content_source: "claim" });

      // ── rule (c): no evidence_url AND no provider website ─────────────
      seed({ id: "rule-c", provider_id: "prov-no-website", evidence_url: null });
      seed({ id: "rule-c-locked", provider_id: "prov-no-website", evidence_url: null, content_source: "manual" });
      // negatives:
      seed({ id: "rule-c-neg-has-evidence", provider_id: "prov-no-website", evidence_url: "https://good.no/c-has-evidence" });
      seed({ id: "rule-c-neg-has-website", provider_id: "prov-active", evidence_url: null }); // prov-active has a hjemmeside
      seed({ id: "rule-c-neg-website-verified", provider_id: "prov-website-verified", evidence_url: null }); // blank hjemmeside but verified

      // ── rule (d): last two verdicts both mismatch:, live page, >=7 days apart
      seed({
        id: "rule-d",
        provider_id: "prov-active",
        evidence_url: "https://good.no/d",
        admission_verdict: "mismatch: siden handler om noe annet",
        admission_checked_at: daysAgo(0),
        admission_verdict_prev: "mismatch: forrige sjekk",
        admission_checked_at_prev: daysAgo(8),
      });
      seed({
        id: "rule-d-locked",
        provider_id: "prov-active",
        evidence_url: "https://good.no/d2",
        content_source: "manual",
        admission_verdict: "mismatch: siden handler om noe annet",
        admission_checked_at: daysAgo(0),
        admission_verdict_prev: "mismatch: forrige sjekk",
        admission_checked_at_prev: daysAgo(8),
      });
      // negative: exactly-boundary at >=7 (7.0 days) also qualifies.
      seed({
        id: "rule-d-boundary-qualifies",
        provider_id: "prov-active",
        evidence_url: "https://good.no/d-boundary",
        admission_verdict: "mismatch: nyeste",
        admission_checked_at: daysAgo(0),
        admission_verdict_prev: "mismatch: eldste",
        admission_checked_at_prev: daysAgo(7),
      });
      // negative: only ONE post-migration verdict tracked (no _prev at all)
      // -> documented history-gap consequence, must NOT qualify.
      seed({
        id: "rule-d-neg-only-one-verdict",
        provider_id: "prov-active",
        evidence_url: "https://good.no/d-neg1",
        admission_verdict: "mismatch: eneste sjekk etter migrasjon",
        admission_checked_at: daysAgo(0),
        admission_verdict_prev: null,
        admission_checked_at_prev: null,
      });
      // negative: two mismatch verdicts <7 days apart.
      seed({
        id: "rule-d-neg-too-close",
        provider_id: "prov-active",
        evidence_url: "https://good.no/d-neg2",
        admission_verdict: "mismatch: nyeste",
        admission_checked_at: daysAgo(0),
        admission_verdict_prev: "mismatch: for to dager siden",
        admission_checked_at_prev: daysAgo(2),
      });
      // negative: a dead/parked unresolved verdict mixed in (prev is
      // unresolved:, not mismatch:) -> must NOT qualify for rule (d).
      seed({
        id: "rule-d-neg-unresolved-mixed-in",
        provider_id: "prov-active",
        evidence_url: "https://good.no/d-neg3",
        admission_verdict: "mismatch: nyeste",
        admission_checked_at: daysAgo(0),
        admission_verdict_prev: "unresolved: evidence_page_dead",
        admission_checked_at_prev: daysAgo(10),
      });

      // ── control: no rule fires -> stays untouched ─────────────────────
      seed({ id: "no-rule-fires", provider_id: "prov-active", evidence_url: "https://good.no/control" });

      // ── control: NOT needs_review going in (already verified) -> never
      //    a candidate at all, even though it meets rule (a)'s condition.
      seed({
        id: "not-needs-review",
        provider_id: "prov-inactive",
        evidence_url: "https://good.no/already-verified",
        verification_status: "verified",
      });

      // ═══ dry-run: reports counts, writes NOTHING ═══════════════════════
      {
        const before = [
          "rule-a", "rule-a-locked", "rule-b", "rule-b-locked", "rule-c", "rule-c-locked",
          "rule-d", "rule-d-locked", "no-rule-fires",
        ].map((id) => [id, snapshot(id)] as const);

        const r = await callRoute(opplevelserRouter, { url: TRIAGE_URL, headers: adminHeaders, body: {} });
        assertEq(r.status, 200, "t1: dry-run (default, no body) -> 200");
        assertEq(r.body.dry_run, true, "t2: dry_run:true by default");
        assertEq(r.body.counts, { a: 1, b: 1, c: 1, d: 2 }, "t3: dry-run counts a=1,b=1,c=1,d=2 (rule-d + rule-d-boundary-qualifies)");
        assertEq(r.body.total, 5, "t4: dry-run total === sum of counts");

        for (const [id, snap] of before) {
          assertEq(snapshot(id), snap, `t5: ${id} byte-for-byte unchanged after dry-run`);
        }
        assertEq(auditRowsFor("rule-a").length, 0, "t6: dry-run writes zero audit rows");

        // explicit dry_run:true is identical to default.
        const r2 = await callRoute(opplevelserRouter, { url: TRIAGE_URL, headers: adminHeaders, body: { dry_run: true } });
        assertEq(r2.body.counts, r.body.counts, "t7: explicit dry_run:true matches default omission");

        // any non-literal-false value is STILL a dry-run (STRICT parse).
        const r3 = await callRoute(opplevelserRouter, { url: TRIAGE_URL, headers: adminHeaders, body: { dry_run: "false" } });
        assertEq(r3.body.dry_run, true, "t8: dry_run:\"false\" (string, not boolean) is STILL a dry-run — STRICT parse");
      }

      // ═══ owner-locked rows: never touched by any rule, even dry-run
      //     reports them as scanned-but-no-rule (never counted). ═════════
      {
        const r = await callRoute(opplevelserRouter, { url: TRIAGE_URL, headers: adminHeaders, body: { dry_run: false, limit: 1000 } });
        // apply already ran above? No — this is the FIRST apply call. Fine.
        const lockedIds = ["rule-a-locked", "rule-b-locked", "rule-c-locked", "rule-d-locked"];
        for (const id of lockedIds) {
          const snap = snapshot(id)!;
          assertEq(snap.verification_status, "needs_review", `t9: ${id} still needs_review after apply — owner lock holds`);
          assertEq(auditRowsFor(id).length, 0, `t10: ${id} has zero audit rows — never touched`);
        }

        // ═══ apply actually rejects the right rows, stamps + audits ═════
        const rejectedIds = ["rule-a", "rule-b", "rule-c", "rule-d", "rule-d-boundary-qualifies"];
        for (const id of rejectedIds) {
          const snap = snapshot(id)!;
          assertEq(snap.verification_status, "rejected", `t11: ${id} verification_status -> 'rejected'`);
          assertTrue(!!snap.admission_verdict && snap.admission_verdict.startsWith("rejected:"), `t12: ${id} admission_verdict starts with 'rejected:'`);
          const audits = auditRowsFor(id);
          assertEq(audits.length, 1, `t13: ${id} has exactly ONE audit row`);
          assertEq(audits[0].from_status, "needs_review", `t14: ${id} audit from_status='needs_review'`);
          assertEq(audits[0].to_status, "rejected", `t15: ${id} audit to_status='rejected'`);
          assertEq(audits[0].batch_id, r.body.batch_id, `t16: ${id} audit batch_id matches the apply call's own batch_id`);
        }

        // negatives stay needs_review, untouched.
        const untouchedIds = [
          "rule-c-neg-has-evidence", "rule-c-neg-has-website", "rule-c-neg-website-verified",
          "rule-d-neg-only-one-verdict", "rule-d-neg-too-close", "rule-d-neg-unresolved-mixed-in",
          "no-rule-fires",
        ];
        for (const id of untouchedIds) {
          const snap = snapshot(id)!;
          assertEq(snap.verification_status, "needs_review", `t17: ${id} stays 'needs_review' — no rule fires`);
          assertEq(auditRowsFor(id).length, 0, `t18: ${id} has zero audit rows`);
        }

        // the pre-existing 'verified' row was never even a candidate.
        assertEq(snapshot("not-needs-review")!.verification_status, "verified", "t19: not-needs-review (already verified) untouched — never a candidate");

        assertEq(r.body.counts, { a: 1, b: 1, c: 1, d: 2 }, "t20: apply counts match dry-run's own preview exactly");
        assertEq(r.body.total, 5, "t21: apply total === 5");
      }

      // ═══ keyset pagination converges across a small limit ═════════════
      {
        // Fresh, isolated scenario: 3 more brreg-inactive rows under a fresh
        // provider, none touched by the apply run above (new ids).
        insertProvider.run({ id: "prov-inactive-2", navn: "Nedlagt To AS", hjemmeside: null, brreg_active: 0, field_provenance: null });
        seed({ id: "page-1", provider_id: "prov-inactive-2", evidence_url: "https://good.no/page1" });
        seed({ id: "page-2", provider_id: "prov-inactive-2", evidence_url: "https://good.no/page2" });
        seed({ id: "page-3", provider_id: "prov-inactive-2", evidence_url: "https://good.no/page3" });

        const seen = new Set<string>();
        let after: string | undefined;
        let calls = 0;
        for (;;) {
          calls++;
          const r: RouteResult = await callRoute(opplevelserRouter, {
            url: TRIAGE_URL,
            headers: adminHeaders,
            body: { dry_run: false, limit: 1, after },
          });
          for (const res of r.body.results as Array<{ id: string; rule: string | null }>) {
            if (["page-1", "page-2", "page-3"].includes(res.id)) seen.add(res.id);
          }
          if (!r.body.next_after || calls > 50) break;
          after = r.body.next_after;
        }
        assertTrue(seen.has("page-1") && seen.has("page-2") && seen.has("page-3"), "t22: keyset pagination (limit:1) eventually visits all 3 rows across repeated calls");
        for (const id of ["page-1", "page-2", "page-3"]) {
          assertEq(snapshot(id)!.verification_status, "rejected", `t23: ${id} rejected via rule (a) across the paginated apply calls`);
        }
      }

      // ═══ rollback ═══════════════════════════════════════════════════
      {
        const batchIdRef = auditRowsFor("rule-a")[0].batch_id;

        // (a) empty batch_id -> 400.
        const rEmpty = await callRoute(opplevelserRouter, { url: ROLLBACK_URL, headers: adminHeaders, body: { batch_id: "" } });
        assertEq(rEmpty.status, 400, "rb1: empty batch_id -> 400");

        // (b) unknown batch_id -> graceful no-op.
        const rUnknown = await callRoute(opplevelserRouter, { url: ROLLBACK_URL, headers: adminHeaders, body: { batch_id: "needs-review-triage-does-not-exist" } });
        assertEq(rUnknown.status, 200, "rb2a: unknown batch_id -> 200");
        assertEq(rUnknown.body.reverted, [], "rb2b: unknown batch_id reverted:[]");

        // Baseline row untouched by this batch, to prove selectivity.
        const baselineBefore = snapshot("no-rule-fires")!;

        // (c) real rollback reverts exactly this batch's own rejected rows.
        const rReal = await callRoute(opplevelserRouter, { url: ROLLBACK_URL, headers: adminHeaders, body: { batch_id: batchIdRef } });
        assertEq(rReal.status, 200, "rb3a: real batch rollback -> 200");
        const revertedIds = new Set((rReal.body.reverted as any[]).map((x) => x.experience_id));
        for (const id of ["rule-a", "rule-b", "rule-c", "rule-d", "rule-d-boundary-qualifies"]) {
          assertTrue(revertedIds.has(id), `rb4: ${id} is in the reverted list`);
          assertEq(snapshot(id)!.verification_status, "needs_review", `rb5: ${id} back to needs_review`);
        }

        const baselineAfter = snapshot("no-rule-fires")!;
        assertEq(baselineAfter, baselineBefore, "rb6: unrelated baseline row byte-for-byte unchanged by the rollback");

        // (d) re-running the same rollback is a no-op (rows no longer 'rejected').
        const rAgain = await callRoute(opplevelserRouter, { url: ROLLBACK_URL, headers: adminHeaders, body: { batch_id: batchIdRef } });
        assertEq(rAgain.body.reverted, [], "rb7: re-running the same rollback reverts nothing");
      }

      // ═══ "moved on" case: a rejected row whose status changed away from
      //     'rejected' by something else after the batch must NOT be
      //     reverted by that batch's rollback ═══════════════════════════
      {
        insertProvider.run({ id: "prov-inactive-3", navn: "Nedlagt Tre AS", hjemmeside: null, brreg_active: 0, field_provenance: null });
        seed({ id: "moved-on", provider_id: "prov-inactive-3", evidence_url: "https://good.no/moved-on" });

        const rApply = await callRoute(opplevelserRouter, {
          url: TRIAGE_URL,
          headers: adminHeaders,
          body: { dry_run: false, limit: 1000 },
        });
        assertEq(snapshot("moved-on")!.verification_status, "rejected", "mo1: moved-on row rejected by its own batch");
        const movedOnBatch = auditRowsFor("moved-on")[0].batch_id;

        // Simulate a later, independent mechanism moving the row on (e.g. a
        // human re-review) BEFORE the rollback runs.
        expDb.prepare(`UPDATE experiences SET verification_status = 'verified' WHERE id = ?`).run("moved-on");

        const rRollback = await callRoute(opplevelserRouter, { url: ROLLBACK_URL, headers: adminHeaders, body: { batch_id: movedOnBatch } });
        assertEq(rRollback.status, 200, "mo2: rollback call itself still succeeds");
        const revertedIds = new Set((rRollback.body.reverted as any[]).map((x) => x.experience_id));
        assertTrue(!revertedIds.has("moved-on"), "mo3: moved-on is NOT in the revert list — it is no longer 'rejected'");
        assertEq(snapshot("moved-on")!.verification_status, "verified", "mo4: moved-on stays 'verified' — the rollback never touched it");
      }

    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-needs-review-triage: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-needs-review-triage.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesNeedsReviewTriageTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
