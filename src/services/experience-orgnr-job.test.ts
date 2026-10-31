/**
 * experience-orgnr-job.test.ts — the server-side daily job for step 3n
 * (A2A dev-request 2026-10-06-experiences-enrichment-plattformjobb-og-felles-
 * serverjobbramme, «Innsnevring 2026-10-28»), including punkt a
 * (admission_checked_at reset for needs_review rows of a provider resolved
 * brreg_active=1).
 *
 * The two org.nr services are replaced by fake ticks (deps.website /
 * deps.nameKommune) — their own decision rules have their own test files.
 * Everything else is real: in-memory experiences DB (schema from
 * init-experiences), the persisted sweep cursor, the punkt-a reset + audit,
 * the main-db run ledger and boot_job_state.
 */
import type Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceOrgnrJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const jobPath = require.resolve("./experience-orgnr-job");
    for (const p of [dbFactoryPath, experienceStorePath, jobPath]) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDbRaw = dbFactory.getDb("experiences") as unknown as Database.Database;
      require("./experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const mainDb = () => init.getDb() as unknown as Database.Database;
      const expDb = () => expDbRaw;
      const job = require("./experience-orgnr-job") as typeof import("./experience-orgnr-job");
      const sweep = require("./experience-orgnr-sweep-state") as typeof import("./experience-orgnr-sweep-state");

      // ── fixtures ──────────────────────────────────────────────────────
      const insProvider = expDbRaw.prepare(
        `INSERT INTO experience_providers (id, navn, hjemmeside, producer_type) VALUES (?, ?, ?, ?)`,
      );
      const insExp = expDbRaw.prepare(
        `INSERT INTO experiences
           (id, provider_id, title, slug, description, category, price_band, price_from,
            evidence_url, verification_status, confidence, canonical_id, content_source,
            enrichment_state, admission_verdict, admission_checked_at)
         VALUES (@id, @provider_id, @title, @slug, 'd', @category, 'low', 100,
            'https://x.example/', @status, 0.5, @canonical_id, 'scrape', 'enriched',
            @verdict, @checked)`,
      );
      // P1: in scope via cohort (producer_type set)
      insProvider.run("p1", "Bryggeri En", "https://p1.example", "bryggeri");
      // P2: NOT in scope (no producer_type, category not mat_drikke)
      insProvider.run("p2", "Aktivitet To", "https://p2.example", null);
      // P3: in scope only via a mat_drikke experience row
      insProvider.run("p3", "Mat Tre", "https://p3.example", null);
      const exp = (id: string, provider: string, status: string, checked: string | null, extra: Partial<{ category: string; canonical_id: string | null }> = {}) =>
        insExp.run({
          id, provider_id: provider, title: id, slug: id, category: extra.category ?? "aktivitet", status,
          canonical_id: extra.canonical_id ?? null, verdict: checked ? "mismatch: x" : null, checked,
        });
      exp("e1a", "p1", "needs_review", "2026-10-01 10:00:00"); // reset
      exp("e1b", "p1", "needs_review", "2026-10-02 10:00:00"); // reset
      exp("e1c", "p1", "verified", "2026-10-03 10:00:00"); // not needs_review -> untouched
      exp("e1d", "p1", "needs_review", null); // never checked -> untouched (already first)
      exp("e1e", "p1", "needs_review", "2026-10-04 10:00:00", { canonical_id: "e1a" }); // duplicate -> untouched
      exp("e2a", "p2", "needs_review", "2026-10-05 10:00:00"); // out of scope -> untouched
      exp("e3a", "p3", "needs_review", "2026-10-06 10:00:00", { category: "mat_drikke" }); // in scope via category
      const checkedAt = (id: string) => (expDbRaw.prepare(`SELECT admission_checked_at AS c FROM experiences WHERE id = ?`).get(id) as any).c;
      const verdictOf = (id: string) => (expDbRaw.prepare(`SELECT admission_verdict AS v FROM experiences WHERE id = ?`).get(id) as any).v;
      const auditRows = () => expDbRaw.prepare(`SELECT provider_id, field_name, old_value, new_value, batch_id FROM experience_provider_field_write_audit WHERE field_name = ? ORDER BY provider_id`).all(job.EXPERIENCE_ORGNR_ADMISSION_RESET_FIELD) as any[];
      const runsFor = () => mainDb().prepare("SELECT run_id, status, claims, notes, trigger_source FROM runs WHERE agent = ? ORDER BY rowid").all(job.EXPERIENCE_ORGNR_JOB_AGENT) as any[];
      const claimValue = (claims: any[], kind: string) => claims.find((c) => c.meta?.kind === kind)?.value;

      type Call = { lane: string; dryRun: boolean; after: string | undefined };
      const res = (o: Partial<import("./experience-orgnr-job").ExperienceOrgnrTickResult>) => ({
        processed: 0, resolved_active: 0, resolved_inactive: 0, errors: 0, skipped_due_to_time_budget: [], planned: [], next_after: null, ...o,
      });
      function fake(lane: string, script: any[], calls: Call[]) {
        let i = 0;
        return async (o: { dryRun: boolean; after: string | undefined }) => {
          calls.push({ lane, dryRun: o.dryRun, after: o.after });
          const next = script[i++];
          if (next instanceof Error) throw next;
          return res(next ?? {});
        };
      }
      const envOn = { EXPERIENCE_ORGNR_JOB_ENABLED: "true" } as Record<string, string | undefined>;
      const noPause = () => null;

      // (1) pure guards
      {
        const at = (s: string) => new Date(s);
        assertEq(job.shouldRunExperienceOrgnrDaily({ now: at("2026-11-01T04:05:00Z"), lastRunAt: null }), true, "1-1: default 04 UTC window, never run -> run");
        assertEq(job.shouldRunExperienceOrgnrDaily({ now: at("2026-11-01T03:05:00Z"), lastRunAt: null }), false, "1-2: outside window -> no");
        assertEq(job.shouldRunExperienceOrgnrDaily({ now: at("2026-11-01T04:50:00Z"), lastRunAt: at("2026-11-01T04:05:00Z") }), false, "1-3: ran 45 min ago -> no");
        assertEq(job.shouldRunExperienceOrgnrDaily({ now: at("2026-11-02T04:05:00Z"), lastRunAt: at("2026-11-01T04:05:00Z") }), true, "1-4: ran 24 h ago -> run");
        assertEq(job.resolveExperienceOrgnrJobWindowHourUtc({ EXPERIENCE_ORGNR_JOB_WINDOW_HOUR_UTC: "22" }), 22, "1-5: window configurable");
        assertEq(job.resolveExperienceOrgnrJobWindowHourUtc({ EXPERIENCE_ORGNR_JOB_WINDOW_HOUR_UTC: "24" }), 4, "1-6: invalid window -> default");
        assertEq(job.resolveExperienceOrgnrJobWindowHourUtc({ EXPERIENCE_ORGNR_JOB_WINDOW_HOUR_UTC: "3abc" }), 4, "1-7: junk window -> default (not parseInt-prefix)");
        assertEq(job.resolveExperienceOrgnrJobCallsPerLane({ EXPERIENCE_ORGNR_JOB_CALLS_PER_LANE: "99" }), job.EXPERIENCE_ORGNR_JOB_MAX_CALLS_PER_LANE, "1-8: calls capped");
        assertEq(job.resolveExperienceOrgnrJobCallsPerLane({ EXPERIENCE_ORGNR_JOB_CALLS_PER_LANE: "0" }), job.EXPERIENCE_ORGNR_JOB_DEFAULT_CALLS_PER_LANE, "1-9: calls 0 -> default");
        assertEq(job.experienceOrgnrJobEnabled({ EXPERIENCE_ORGNR_JOB_ENABLED: "1" }), false, "1-10: only the literal 'true' enables");
      }

      // (2) disabled cron -> nothing called
      {
        const calls: Call[] = [];
        const r = await job.runExperienceOrgnrDaily({ apply: true, trigger: "cron" }, { website: fake("w", [], calls), nameKommune: fake("n", [], calls), pauseBlock: noPause, env: {}, mainDb, expDb });
        assertEq([r.skipped_reason, calls.length, r.envelope_recorded], ["disabled", 0, false], "2-1: disabled -> skipped, no calls, no envelope");
      }

      // (3) dry-run: reads cursor, never advances it, resets nothing, no ledger, reports would-reset
      {
        sweep.setExperienceOrgnrSweepAfter(expDbRaw, "orgnr_from_website", "c0");
        const calls: Call[] = [];
        const r = await job.runExperienceOrgnrDaily(
          { apply: false, trigger: "manual", now: new Date("2026-11-01T10:00:00Z") },
          {
            website: fake("w", [{ processed: 2, resolved_active: 1, planned: [{ provider_id: "p1", outcome: "resolved_active", org_nr: "999999999" }], next_after: "c1" }, { processed: 1, next_after: null }], calls),
            nameKommune: fake("n", [{ processed: 0, next_after: null }], calls),
            pauseBlock: () => ({ paused: true }), // ignored for dry-run
            env: {}, mainDb, expDb,
          },
        );
        assertEq(r.skipped_reason, null, "3-1: dry-run runs with flag off and even while paused");
        assertTrue(calls.every((c) => c.dryRun === true), "3-2: every tick dryRun:true");
        assertEq(calls.map((c) => [c.lane, c.after ?? null]), [["w", "c0"], ["w", "c1"], ["n", null]], "3-3: website resumes from persisted cursor, then follows next_after; name lane from start");
        assertEq(sweep.getExperienceOrgnrSweepAfter(expDbRaw, "orgnr_from_website"), "c0", "3-4: dry-run never advances the persisted cursor");
        assertEq(r.admission_resets, [{ provider_id: "p1", experience_ids: ["e1a", "e1b"] }], "3-5: would-reset = in-scope, canonical, needs_review, already-checked rows only");
        assertEq([checkedAt("e1a"), checkedAt("e1b")], ["2026-10-01 10:00:00", "2026-10-02 10:00:00"], "3-6: dry-run wrote nothing");
        assertEq(auditRows().length, 0, "3-7: dry-run writes no audit");
        assertEq([r.envelope_recorded, runsFor().length], [false, 0], "3-8: dry-run records no envelope");
        assertEq(r.lanes[0].stop_reason, "backlog_end", "3-9: next_after null -> backlog_end");
      }

      // (4) apply cron: cursor advanced, punkt a reset + audit, envelope claims
      {
        const calls: Call[] = [];
        const now = new Date("2026-11-01T04:02:00Z");
        const r = await job.runExperienceOrgnrDaily(
          { apply: true, trigger: "cron", now },
          {
            website: fake("w", [
              { processed: 3, resolved_active: 1, resolved_inactive: 1, planned: [{ provider_id: "p1", outcome: "resolved_active", org_nr: "1" }, { provider_id: "p2", outcome: "resolved_inactive", org_nr: "2" }, { provider_id: "pX", outcome: "no_orgnr_found", org_nr: null }], next_after: "c5" },
              { processed: 2, resolved_active: 1, planned: [{ provider_id: "p2", outcome: "resolved_active", org_nr: "3" }], next_after: "c9" },
              { processed: 9 }, // never reached: calls_per_lane default 2
            ], calls),
            nameKommune: fake("n", [{ processed: 1, resolved_active: 1, planned: [{ provider_id: "p3", outcome: "resolved_active", org_nr: "4" }, { provider_id: "p1", outcome: "resolved_active", org_nr: "1" }], next_after: null }], calls),
            pauseBlock: noPause, env: envOn, mainDb, expDb,
          },
        );
        assertEq(r.skipped_reason, null, "4-1: ran");
        assertTrue(calls.every((c) => c.dryRun === false), "4-2: apply -> dryRun:false");
        assertEq(calls.map((c) => [c.lane, c.after ?? null]), [["w", "c0"], ["w", "c5"], ["n", null]], "4-3: 2 website calls (max_calls), 1 name call (backlog_end)");
        assertEq([r.lanes[0].stop_reason, r.lanes[1].stop_reason], ["max_calls", "backlog_end"], "4-4: stop reasons");
        assertEq(sweep.getExperienceOrgnrSweepAfter(expDbRaw, "orgnr_from_website"), "c9", "4-5: website cursor advanced to last next_after");
        assertEq(sweep.getExperienceOrgnrSweepAfter(expDbRaw, "orgnr_from_name_kommune"), undefined, "4-6: name cursor persisted as NULL at backlog end");
        assertEq([checkedAt("e1a"), checkedAt("e1b")], [null, null], "4-7: punkt a cleared admission_checked_at for p1's in-scope needs_review rows");
        assertEq([checkedAt("e1c"), checkedAt("e1e")], ["2026-10-03 10:00:00", "2026-10-04 10:00:00"], "4-8: verified row and duplicate untouched");
        assertEq(checkedAt("e2a"), "2026-10-05 10:00:00", "4-9: out-of-scope provider untouched even when resolved active");
        assertEq(checkedAt("e3a"), null, "4-10: provider in scope via mat_drikke row reset");
        assertEq(verdictOf("e1a"), "mismatch: x", "4-11: admission_verdict left as-is");
        const audits = auditRows();
        assertEq(audits.map((a) => a.provider_id), ["p1", "p3"], "4-12: one audit row per provider with resets (p1 counted once though resolved twice)");
        assertEq(JSON.parse(audits[0].old_value), { e1a: "2026-10-01 10:00:00", e1b: "2026-10-02 10:00:00" }, "4-13: audit keeps old values for rollback");
        assertEq([audits[0].new_value, audits[0].batch_id], [null, r.run_id], "4-14: audit new_value NULL, batch_id = run_id");
        assertEq(r.admission_resets.map((x) => x.provider_id), ["p1", "p3"], "4-15: report lists resets");
        const rows = runsFor();
        assertEq(rows.length, 1, "4-16: one ledger row");
        assertEq([rows[0].run_id, rows[0].status, rows[0].trigger_source], [`run-2026-11-01-${job.EXPERIENCE_ORGNR_JOB_AGENT}-experiences`, "completed", "cron"], "4-17: fixed per-day cron run_id, completed");
        const claims = JSON.parse(rows[0].claims);
        assertEq(claimValue(claims, "experience_orgnr_resolved_active"), 3, "4-18: resolved_active summed");
        assertEq(claimValue(claims, "experience_orgnr_resolved_inactive"), 1, "4-19: resolved_inactive");
        assertEq(claimValue(claims, "experience_orgnr_processed"), 6, "4-20: processed");
        assertEq(claimValue(claims, "experience_orgnr_unresolved"), 2, "4-21: unresolved = processed - resolved");
        assertEq(claimValue(claims, "needs_review_admission_reset"), 3, "4-22: reset rows claim");
        assertTrue(String(rows[0].notes).includes("ingen LLM"), "4-23: notes say no LLM");
      }

      // (5) second apply on an already-reset provider -> no new reset, no new audit
      {
        const before = auditRows().length;
        const r = await job.runExperienceOrgnrDaily(
          { apply: true, trigger: "manual", now: new Date("2026-11-01T12:00:00Z") },
          { website: fake("w", [{ processed: 1, resolved_active: 1, planned: [{ provider_id: "p1", outcome: "resolved_active", org_nr: "1" }], next_after: null }], []), nameKommune: fake("n", [{}], []), pauseBlock: noPause, env: {}, mainDb, expDb },
        );
        assertEq([r.totals.admission_reset_rows, auditRows().length], [0, before], "5-1: idempotent — nothing left to reset, no empty audit row");
        assertEq(runsFor().filter((x) => x.trigger_source === "manual").length, 1, "5-2: manual apply gets its own ledger row");
      }

      // (6) write-pause -> paused before any tick; mid-run pause stops the next tick
      {
        const calls: Call[] = [];
        const before = runsFor().length;
        const r = await job.runExperienceOrgnrDaily({ apply: true, trigger: "cron", now: new Date("2026-11-02T04:02:00Z") }, { website: fake("w", [{}], calls), nameKommune: fake("n", [{}], calls), pauseBlock: () => ({ error: "paused" }), env: envOn, mainDb, expDb });
        assertEq([r.skipped_reason, calls.length, runsFor().length - before], ["paused", 0, 0], "6-1: paused at start -> no ticks, no envelope");
        let n = 0;
        const calls2: Call[] = [];
        const r2 = await job.runExperienceOrgnrDaily({ apply: true, trigger: "cron", now: new Date("2026-11-02T04:03:00Z") }, { website: fake("w", [{ processed: 1, next_after: "z1" }, { processed: 1 }], calls2), nameKommune: fake("n", [{}], calls2), pauseBlock: () => (n++ >= 2 ? { error: "paused" } : null), env: envOn, mainDb, expDb });
        assertEq([r2.skipped_reason, calls2.length], ["paused", 1], "6-2: pause between ticks stops the run after the first tick");
      }

      // (7) a throwing tick -> lane stops with error, other lane still runs, status partial / failed
      {
        const calls: Call[] = [];
        const r = await job.runExperienceOrgnrDaily({ apply: true, trigger: "manual", now: new Date("2026-11-03T09:00:00Z") }, { website: fake("w", [new Error("boom")], calls), nameKommune: fake("n", [{ processed: 2, next_after: null }], calls), pauseBlock: noPause, env: {}, mainDb, expDb });
        assertEq([r.lanes[0].stop_reason, r.lanes[1].processed], ["error", 2], "7-1: website error, name lane still ran");
        const last = runsFor().slice(-1)[0];
        assertEq(last.status, "partial", "7-2: one lane failing -> partial");
        const r2 = await job.runExperienceOrgnrDaily({ apply: true, trigger: "manual", now: new Date("2026-11-03T09:05:00Z") }, { website: fake("w", [new Error("a")], []), nameKommune: fake("n", [new Error("b")], []), pauseBlock: noPause, env: {}, mainDb, expDb });
        assertEq([runsFor().slice(-1)[0].status, r2.totals.errors], ["failed", 2], "7-3: both lanes failing with nothing processed -> failed");
      }

      // (8) daily tick: window + stamp
      {
        const deps = { website: fake("w", [{ processed: 1 }], []), nameKommune: fake("n", [{}], []), pauseBlock: noPause, env: envOn, mainDb, expDb };
        const t0 = await job.tickExperienceOrgnrDaily({ now: new Date("2026-11-04T03:30:00Z"), lastRunAt: null }, deps);
        assertEq(t0.report, null, "8-1: outside window -> no run");
        const t1 = await job.tickExperienceOrgnrDaily({ now: new Date("2026-11-04T04:10:00Z"), lastRunAt: null }, deps);
        assertTrue(t1.report !== null && t1.report.skipped_reason === null, "8-2: inside window -> run");
        const t2 = await job.tickExperienceOrgnrDaily({ now: new Date("2026-11-04T04:20:00Z"), lastRunAt: null }, deps);
        assertEq(t2.report, null, "8-3: persisted stamp blocks a second run the same window (in-memory lastRunAt null, e.g. after a deploy)");
        const off = await job.tickExperienceOrgnrDaily({ now: new Date("2026-11-05T04:10:00Z"), lastRunAt: null }, { ...deps, env: {} });
        assertEq(off.report, null, "8-4: flag off -> tick does nothing");
        const st = job.getExperienceOrgnrJobStatus({ env: envOn, mainDb, expDb });
        assertEq([st.enabled, st.llm, st.window_hour_utc, st.last_completed_at], [true, false, 4, "2026-11-04T04:10:00.000Z"], "8-5: status reader");
        assertTrue(st.runs.length >= 1, "8-6: status lists runs");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* ignore */ }
      for (const p of [dbFactoryPath, experienceStorePath, jobPath]) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceOrgnrJobTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
