/**
 * lokal-agent-verifier-second-line-infra-failure.test.ts — dev-request
 * 2026-11-25-dommerfeil-skal-ikke-nedgradere-verifiserte-profiler (punkt 1–5,
 * AK1–AK6): a second-line judge infrastructure failure (no model verdict)
 * must not take `verified` from a profile the second line already approved.
 *
 * Sections:
 *   AK5 — judgeSecondLineProfile sets infraFailure on every no-verdict path;
 *         a non-2xx reason carries the response body, cut at 300 chars. A
 *         real AVVIS / ambiguous answer is NOT an infra failure.
 *   AK6 — the in-memory health tracker: /health's warning appears after
 *         SECOND_LINE_JUDGE_HEALTH_WARN_AFTER failed calls in a row and is
 *         gone after the next successful call.
 *   AK1 — verified + stored verified_second_line=1 + judge infra failure ->
 *         stays verified, second_line.infra_failure true, stored sources
 *         untouched, no status transition.
 *   AK2 — the same profile with a real AVVIS is demoted as today.
 *   AK3 — a non-verified profile is never approved on an infra failure and
 *         the pending_verify no-progress counter is not bumped.
 *   AK4 — three infra failures in a row stop further judge calls in the run;
 *         later rows are judge_unavailable (untouched status), the envelope
 *         is `partial` with a claim carrying the count + first error text.
 *   Punkt 5 — POST /admin/run-verifier select=second_line_infra_failure
 *         (dry run first, then a real run). The pool-blocker-explain view
 *         (punkt 4) is covered in admin-pool-blocker-explain.test.ts.
 *
 * Wired into tests/test.ts via runSerial().
 * Standalone: npx tsx src/agents/lokal-agent-verifier-second-line-infra-failure.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; headers?: Record<string, string>; query?: Record<string, string>; body?: any },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
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
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 0, body: err ? { error: String(err) } : undefined }));
  });
}

const ADMIN_KEY = "test-admin-key-second-line-infra-failure";
const FB_PROVENANCE = {
  address: [{ value: "x", source_type: "facebook_official_page", source_url: "https://facebook.com/testgard", fetched_at: "2026-08-01T00:00:00Z" }],
};
const INFRA_REASON_1 = "dommer-API svarte status 400 — avvist fail-closed — {\"error\":\"credit balance too low\"}";

export function runLokalAgentVerifierSecondLineInfraFailureTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const judgeMod = require("../services/second-line-profile-judge") as typeof import("../services/second-line-profile-judge");
    const verifier = require("./lokal-agent-verifier") as typeof import("./lokal-agent-verifier");

    // ═══════════════════════════════════════════════════════════════════
    // AK5 + AK6 — the judge module (mocked fetch, no network).
    // ═══════════════════════════════════════════════════════════════════
    {
      const prevKey = process.env.ANTHROPIC_API_KEY;
      const prevFetch = globalThis.fetch;
      const prevConsoleError = console.error;
      const params = {
        businessName: "Testgård AS",
        city: "Lillehammer",
        about: "En liten gård som selger egg.",
        products: ["Egg"],
        email: "kari@testgard.no",
        acceptedSources: ["facebook_official_page"],
      };
      const okText = (text: string) =>
        (async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) })) as unknown as typeof fetch;
      try {
        console.error = () => {};
        judgeMod.__resetSecondLineJudgeHealthForTesting();

        delete process.env.ANTHROPIC_API_KEY;
        let v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, true], "ak5-1: missing API key -> approved:false, infraFailure:true");

        process.env.ANTHROPIC_API_KEY = "test-key";
        globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, true], "ak5-2: network error -> infraFailure:true");

        // AK6: three failures in a row (key, network, next) -> warning.
        assertEq(judgeMod.secondLineJudgeHealthWarning(), null, "ak6-1: 2 failures in a row -> no /health warning yet");

        const longBody = "A".repeat(300) + "TAIL-NOT-SHOWN";
        globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => longBody })) as unknown as typeof fetch;
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, true], "ak5-3: non-2xx -> infraFailure:true");
        assertTrue((v.reason ?? "").includes("status 400"), "ak5-4: non-2xx reason names the status");
        assertTrue((v.reason ?? "").includes("A".repeat(300)), "ak5-5: non-2xx reason carries the response body text");
        assertTrue(!(v.reason ?? "").includes("TAIL"), "ak5-6: response body is cut at 300 chars");
        assertTrue((v.reason ?? "").endsWith("A".repeat(300)), "ak5-7: exactly the first 300 chars, nothing after");

        const warning = judgeMod.secondLineJudgeHealthWarning();
        assertTrue(typeof warning === "string" && /Second-line judge unavailable/.test(warning), "ak6-2: 3 failures in a row -> /health warning present");
        assertTrue(!!warning && !warning.includes("AAAA"), "ak6-3: the public warning carries no API body text");

        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch;
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, true], "ak5-8: unparseable JSON -> infraFailure:true");

        globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ content: [] }) })) as unknown as typeof fetch;
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, true], "ak5-9: unexpected response shape -> infraFailure:true");

        globalThis.fetch = okText("AVVIS\nFor tynt grunnlag.");
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, undefined], "ak5-10: real AVVIS -> NOT an infra failure");
        assertEq(judgeMod.secondLineJudgeHealthWarning(), null, "ak6-4: a call with a model verdict clears the /health warning");

        globalThis.fetch = okText("Kanskje?");
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq([v.approved, v.infraFailure], [false, undefined], "ak5-11: ambiguous model answer -> NOT an infra failure");

        globalThis.fetch = (async () => ({ ok: false, status: 529, text: async () => "overloaded" })) as unknown as typeof fetch;
        for (let i = 0; i < 3; i++) await judgeMod.judgeSecondLineProfile(params);
        assertTrue(judgeMod.secondLineJudgeHealthWarning() !== null, "ak6-5: judge down again -> warning back");
        globalThis.fetch = okText("GODKJENN\nStemmer.");
        v = await judgeMod.judgeSecondLineProfile(params);
        assertEq(v.approved, true, "ak6-6: successful call approves");
        assertEq(judgeMod.secondLineJudgeHealthWarning(), null, "ak6-7: warning gone after a successful call");
        assertEq(judgeMod.getSecondLineJudgeHealth().consecutive_infra_failures, 0, "ak6-8: tracker reset to 0");
      } catch (err: any) {
        failed++;
        failures.push("infra-failure (AK5/AK6): unexpected error: " + String(err?.stack || err?.message || err));
      } finally {
        console.error = prevConsoleError;
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
        globalThis.fetch = prevFetch;
        judgeMod.__resetSecondLineJudgeHealthForTesting();
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // AK1–AK4 + punkt 4/5 — runVerifierBatch on an isolated in-memory DB.
    // ═══════════════════════════════════════════════════════════════════
    const prevDb = initMod.getDb();
    const prevFlag = process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevFetch = globalThis.fetch;
    const prevConsoleError = console.error;
    const prevConsoleLog = console.log;
    const db = new Database(":memory:");
    try {
      if (!log) {
        console.log = () => {};
        console.error = () => {};
      }
      db.pragma("journal_mode = DELETE");
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);

      const insertAgent = db.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, is_verified)
         VALUES (?, ?, 'test agent', 'test', 'x@example.com', 'https://testgard.no', 'producer', ?, 0)`,
      );
      const insertKnowledge = db.prepare(
        `INSERT INTO agent_knowledge
           (agent_id, address, phone, email, website, about, products, field_provenance, verification_status, enrichment_status)
         VALUES (?, 'Testveien 1, 2600 Lillehammer', '91234567', 'kari@testgard.no', NULL,
                 'En liten gård som selger egg og grønnsaker direkte fra tunet. Familiedrevet i tre generasjoner.',
                 ?, ?, ?, 'partial')`,
      );
      function seed(id: string, status: string, storedSecondLine = false): void {
        insertAgent.run(id, "Testgård " + id, "key-" + id);
        insertKnowledge.run(
          id,
          JSON.stringify([{ name: "Egg" }, { name: "Poteter" }, { name: "Honning" }]),
          JSON.stringify(FB_PROVENANCE),
          status,
        );
        if (storedSecondLine) {
          db.prepare(
            `UPDATE agent_knowledge SET verified_second_line = 1, verified_second_line_at = '2026-11-01T00:00:00.000Z',
                    verified_second_line_sources = '["hanen_no"]' WHERE agent_id = ?`,
          ).run(id);
        }
      }
      const row = (id: string): any =>
        db.prepare(
          `SELECT verification_status, verified_second_line, verified_second_line_at, verified_second_line_sources,
                  verification_review_reason, pending_verify_no_progress_count, pending_verify_parked_since
             FROM agent_knowledge WHERE agent_id = ?`,
        ).get(id);
      const pickIds = (ids: string[]) => (dbi: any) => verifier.pickByIds(dbi, ids);

      const infraJudge = (calls: { n: number }) => async () => {
        calls.n++;
        return { approved: false, reason: calls.n === 1 ? INFRA_REASON_1 : `nettverksfeil #${calls.n}`, infraFailure: true as const };
      };
      async function run(ids: string[], judgeFn: any) {
        process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = "true";
        return verifier.runVerifierBatch({ db, pickFn: pickIds(ids), batchSize: ids.length, headProbe: async () => null, brregLookup: null, secondLineJudgeFn: judgeFn });
      }

      // ── AK1 ────────────────────────────────────────────────────────────
      seed("ak1", "verified", true);
      {
        const calls = { n: 0 };
        const out = await run(["ak1"], infraJudge(calls));
        const r = out.results[0];
        assertEq(calls.n, 1, "ak1-0: judge called once");
        assertEq(r.new_verification_status, "verified", "ak1-1: verified + stored second line + infra failure -> stays verified");
        assertEq(r.prior_verification_status, r.new_verification_status, "ak1-2: no status transition");
        const k = row("ak1");
        assertEq(k.verification_status, "verified", "ak1-3: DB status stays verified");
        assertEq(JSON.parse(k.verification_review_reason).second_line.infra_failure, true, "ak1-4: cross_source_reason.second_line.infra_failure = true");
        assertEq(JSON.parse(k.verification_review_reason).second_line.judge_reason, INFRA_REASON_1, "ak1-5: judge_reason keeps the error text");
        assertEq(k.verified_second_line_sources, '["hanen_no"]', "ak1-6: stored second-line sources untouched");
        assertEq(k.verified_second_line_at, "2026-11-01T00:00:00.000Z", "ak1-7: stored verified_second_line_at untouched");
        assertEq(r.second_line_judge_infra_failure, true, "ak1-8: VerifierResult flags the infra failure");
        assertEq(out.second_line_judge?.infra_failures, 1, "ak1-9: run tracker counts 1 infra failure");
        const env: any = verifier.buildRunEnvelope({ run_id: out.run_id, started_at: out.started_at, finished_at: out.finished_at, results: out.results });
        const demoted = env.claims.find((c: any) => c.meta?.kind === "verified_demoted");
        assertEq(demoted.value, 0, "ak1-10: envelope verified_demoted = 0");
      }

      // ── AK2 ────────────────────────────────────────────────────────────
      seed("ak2", "verified", true);
      {
        const out = await run(["ak2"], async () => ({ approved: false, reason: "AVVIS: annen produsent" }));
        const r = out.results[0];
        assertEq(r.new_verification_status, "pending_verify", "ak2-1: real AVVIS still demotes verified -> pending_verify (as today)");
        assertEq(row("ak2").verification_status, "pending_verify", "ak2-2: DB demoted");
        assertEq(JSON.parse(row("ak2").verification_review_reason).second_line.infra_failure, undefined, "ak2-3: no infra_failure mark on a real verdict");
        assertEq(r.second_line_judge_infra_failure, undefined, "ak2-4: VerifierResult has no infra flag");
        const env: any = verifier.buildRunEnvelope({ run_id: out.run_id, started_at: out.started_at, finished_at: out.finished_at, results: out.results });
        assertEq(env.status, "completed", "ak2-5: a run without an infra failure stays completed");
        assertTrue(!env.claims.some((c: any) => c.meta?.kind === verifier.SECOND_LINE_JUDGE_INFRA_FAILURE_CLAIM_KIND), "ak2-6: no outage claim");
        assertEq(row("ak2").pending_verify_no_progress_count, 1, "ak2-7: real verdict -> no-progress counter bumped as today");
      }

      // ── AK3 ────────────────────────────────────────────────────────────
      seed("ak3", "pending_verify");
      seed("ak3-ctl", "pending_verify");
      {
        for (let i = 0; i < 3; i++) {
          const calls = { n: 0 };
          const out = await run(["ak3"], infraJudge(calls));
          assertEq(out.results[0].new_verification_status, "pending_verify", `ak3-1.${i}: non-verified + infra failure -> not approved`);
        }
        const k = row("ak3");
        assertEq(k.verification_status, "pending_verify", "ak3-2: DB not verified");
        assertEq(k.verified_second_line, 0, "ak3-3: no second-line stamp");
        assertEq(JSON.parse(k.verification_review_reason).second_line.infra_failure, true, "ak3-4: marked infra_failure");
        assertEq(k.pending_verify_no_progress_count, 0, "ak3-5: 3 outage runs do not count as no-progress attempts");
        assertEq(k.pending_verify_parked_since, null, "ak3-6: not parked because of the outage");
        for (let i = 0; i < 3; i++) await run(["ak3-ctl"], async () => ({ approved: false, reason: "AVVIS" }));
        assertEq(row("ak3-ctl").pending_verify_no_progress_count, 3, "ak3-7: control — 3 real rejections count as 3 attempts");
        assertTrue(row("ak3-ctl").pending_verify_parked_since !== null, "ak3-8: control — parked after 3 real rejections");
      }

      // ── AK4 ────────────────────────────────────────────────────────────
      // ak4-v (verified + stored second line) sits after the third failure, so
      // it is judge_unavailable: no API call, status untouched.
      for (const id of ["ak4-a", "ak4-b", "ak4-c", "ak4-d"]) seed(id, "pending_verify");
      seed("ak4-v", "verified", true);
      {
        const calls = { n: 0 };
        const ids = ["ak4-a", "ak4-b", "ak4-c", "ak4-v", "ak4-d"];
        const out = await run(ids, infraJudge(calls));
        const byId = new Map(out.results.map((r) => [r.agent_id, r]));
        assertEq(calls.n, 3, "ak4-1: judge called only 3 times for 5 rows that needed it");
        assertEq(out.second_line_judge?.gave_up, true, "ak4-2: run gave up on the judge");
        assertEq(out.second_line_judge?.infra_failures, 3, "ak4-3: tracker infra_failures = 3");
        assertEq(out.second_line_judge?.judge_unavailable, 2, "ak4-4: tracker judge_unavailable = 2");
        assertEq(byId.get("ak4-d")?.second_line_judge_unavailable, true, "ak4-5: later row marked judge_unavailable");
        assertEq(byId.get("ak4-v")?.new_verification_status, "verified", "ak4-6: judge_unavailable verified row keeps verified");
        assertEq(byId.get("ak4-d")?.new_verification_status, "pending_verify", "ak4-7: judge_unavailable non-verified row not approved, status unchanged");
        assertEq(JSON.parse(row("ak4-d").verification_review_reason).second_line.judge_unavailable, true, "ak4-8: judge_unavailable persisted in second_line");
        assertEq(row("ak4-d").pending_verify_no_progress_count, 0, "ak4-9: judge_unavailable not counted as an attempt");
        const env: any = verifier.buildRunEnvelope({ run_id: out.run_id, started_at: out.started_at, finished_at: out.finished_at, results: out.results });
        assertEq(env.status, "partial", "ak4-10: run envelope status = partial");
        const claim = env.claims.find((c: any) => c.meta?.kind === verifier.SECOND_LINE_JUDGE_INFRA_FAILURE_CLAIM_KIND);
        assertTrue(!!claim, "ak4-11: outage claim present");
        assertEq(claim?.value, 3, "ak4-12: claim value = infra failure count");
        assertEq(claim?.meta?.infra_failures, 3, "ak4-13: claim meta.infra_failures = 3");
        assertEq(claim?.meta?.judge_unavailable, 2, "ak4-14: claim meta.judge_unavailable = 2");
        assertEq(claim?.meta?.first_error, INFRA_REASON_1, "ak4-15: claim meta.first_error = the first error text");
      }
      // A model verdict between failures resets the in-a-row count.
      for (const id of ["ak4r-a", "ak4r-b", "ak4r-c", "ak4r-d", "ak4r-e"]) seed(id, "pending_verify");
      {
        let n = 0;
        const out = await run(["ak4r-a", "ak4r-b", "ak4r-c", "ak4r-d", "ak4r-e"], async () => {
          n++;
          return n === 3 ? { approved: false, reason: "AVVIS" } : { approved: false, reason: "nettverksfeil", infraFailure: true as const };
        });
        assertEq(n, 5, "ak4-16: a real verdict in between resets the count — all 5 rows judged");
        assertEq(out.second_line_judge?.gave_up, false, "ak4-17: never gave up (max 2 in a row)");
      }
      // A shared tracker (the nightly re-verify step's single-agent calls).
      for (const id of ["ak4s-a", "ak4s-b", "ak4s-c", "ak4s-d"]) seed(id, "pending_verify");
      {
        const shared = verifier.newSecondLineJudgeRunState();
        const calls = { n: 0 };
        process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = "true";
        for (const id of ["ak4s-a", "ak4s-b", "ak4s-c", "ak4s-d"]) {
          await verifier.runVerifierBatch({
            db, agentIds: [id], batchSize: 1, headProbe: async () => null, brregLookup: null,
            secondLineJudgeFn: infraJudge(calls), secondLineJudgeRunState: shared,
          });
        }
        assertEq(calls.n, 3, "ak4-18: a shared tracker stops the judge across single-agent batches");
        assertEq([shared.infra_failures, shared.judge_unavailable], [3, 1], "ak4-19: shared tracker totals");
      }

      // (Punkt 4's pool-blocker-explain view: admin-pool-blocker-explain.test.ts c5-11..13.)

      // ── Punkt 5: selector + POST /admin/run-verifier ────────────────────
      {
        const selected = verifier.selectSecondLineInfraFailureIds(db);
        for (const id of ["ak1", "ak3", "ak4-a", "ak4-d", "ak4-v"]) {
          assertTrue(selected.includes(id), `p5-1: selector includes ${id}`);
        }
        assertTrue(!selected.includes("ak2") && !selected.includes("ak3-ctl"), "p5-2: selector excludes rows with a real verdict");

        process.env.ADMIN_KEY = ADMIN_KEY;
        delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
        // No network from the route's real Brreg lookup.
        globalThis.fetch = (async () => { throw new Error("no network in test"); }) as unknown as typeof fetch;
        const { default: router } = require("../routes/admin-run-verifier") as { default: any };
        const lastVerified = (id: string) => (db.prepare(`SELECT last_verified_at FROM agent_knowledge WHERE agent_id = ?`).get(id) as any).last_verified_at;
        const before = lastVerified("ak1");

        const dry = await callRoute(router, {
          method: "POST", url: "/", headers: { "x-admin-key": ADMIN_KEY },
          query: {}, body: { select: "second_line_infra_failure" },
        });
        assertEq(dry.status, 200, "p5-3: dry run 200");
        assertEq(dry.body.dry_run, true, "p5-4: dry run is the default");
        assertEq(dry.body.matched, selected.length, "p5-5: dry run count = selector count");
        assertEq(lastVerified("ak1"), before, "p5-6: dry run writes nothing");

        const bad = await callRoute(router, {
          method: "POST", url: "/", headers: { "x-admin-key": ADMIN_KEY }, query: {}, body: { select: "everything" },
        });
        assertEq(bad.status, 400, "p5-7: unknown select -> 400");

        const realRun = await callRoute(router, {
          method: "POST", url: "/", headers: { "x-admin-key": ADMIN_KEY },
          query: { force: "1", skip_tick_lock: "1" }, body: { select: "second_line_infra_failure", dry_run: false, batchSize: 100 },
        });
        assertEq(realRun.status, 200, "p5-8: real run 200");
        assertEq(realRun.body.processed, selected.length, "p5-9: real run processes exactly the selected rows");
        assertEq(realRun.body.selected, selected.length, "p5-10: response echoes the selected count");
        assertTrue(lastVerified("ak1") !== before, "p5-11: selected row re-verified");
      }
    } catch (err: any) {
      failed++;
      failures.push("infra-failure (AK1-AK4/punkt 4-5): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      console.log = prevConsoleLog;
      console.error = prevConsoleError;
      globalThis.fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
      if (prevFlag === undefined) delete process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED;
      else process.env.RFB_SECOND_LINE_VERIFICATION_ENABLED = prevFlag;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try { db.close(); } catch { /* ignore */ }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runLokalAgentVerifierSecondLineInfraFailureTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      for (const f of summary.failures) console.log(f);
      process.exit(1);
    }
  });
}
