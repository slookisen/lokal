/**
 * gardssalg-website-verification-job.test.ts — the server-side daily job for
 * step 3f (the gårdssalg website-verification sweep).
 *
 * The live fetcher is replaced by a fake (deps.fetchFn). Everything else is
 * real: in-memory experiences DB (schema from init-experiences), the shared
 * persisted sweep offset, the real applyGardssalgWebsiteVerification write
 * path, the main-db run ledger and boot_job_state.
 */
import type Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgWebsiteVerificationJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const jobPath = require.resolve("./gardssalg-website-verification-job");
    const svcPath = require.resolve("./gardssalg-website-verification");
    for (const p of [dbFactoryPath, experienceStorePath, jobPath, svcPath]) delete require.cache[p];
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
      const job = require("./gardssalg-website-verification-job") as typeof import("./gardssalg-website-verification-job");
      const svc = require("./gardssalg-website-verification") as typeof import("./gardssalg-website-verification");

      // 75 visible providers with a blank hjemmeside -> missing_source, no fetch
      // needed (so the fake fetcher is only a tripwire). 75 > 5 pages x 12 rows.
      const TOTAL = 75;
      const ins = expDbRaw.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, hjemmeside, catalog_hidden, producer_type,
            enrichment_state, verification_status, source, confidence)
         VALUES (?, ?, 'experiences', NULL, 0, 'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      for (let i = 0; i < TOTAL; i++) ins.run(`gp-${String(i).padStart(3, "0")}`, `Bryggeri ${i}`);

      const auditCount = () => (expDbRaw.prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_verification_audit`).get() as any).n as number;
      const provCount = () => (expDbRaw.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE field_provenance LIKE '%hjemmeside_verification%'`).get() as any).n as number;
      const offsetNow = () => svc.getGardssalgWebsiteVerificationSweepOffset(expDbRaw, "all");
      const hasOffsetRow = () => !!expDbRaw.prepare(`SELECT 1 FROM gardssalg_website_verification_sweep_state WHERE cohort = 'all'`).get();
      const runsFor = () => mainDb().prepare("SELECT run_id, status, claims, notes, trigger_source FROM runs WHERE agent = ? ORDER BY rowid").all(job.GARDSSALG_WV_JOB_AGENT) as any[];
      const fetchFn = async () => ({ ok: false as const, reason: "tripwire" });
      const noPause = () => null;
      const envOn = { GARDSSALG_WEBSITE_VERIFICATION_JOB_ENABLED: "true" } as Record<string, string | undefined>;
      const base = { fetchFn, pauseBlock: noPause, env: envOn, mainDb, expDb };

      // (1) pure guards
      {
        const at = (s: string) => new Date(s);
        assertEq(job.shouldRunGardssalgWebsiteVerificationDaily({ now: at("2026-11-01T05:05:00Z"), lastRunAt: null }), true, "1-1: default 05 UTC window -> run");
        assertEq(job.shouldRunGardssalgWebsiteVerificationDaily({ now: at("2026-11-01T04:05:00Z"), lastRunAt: null }), false, "1-2: outside window -> no");
        assertEq(job.shouldRunGardssalgWebsiteVerificationDaily({ now: at("2026-11-01T05:50:00Z"), lastRunAt: at("2026-11-01T05:05:00Z") }), false, "1-3: ran 45 min ago -> no");
        assertEq(job.resolveGardssalgWebsiteVerificationJobWindowHourUtc({ GARDSSALG_WEBSITE_VERIFICATION_JOB_WINDOW_HOUR_UTC: "22" }), 22, "1-4: window configurable");
        assertEq(job.resolveGardssalgWebsiteVerificationJobWindowHourUtc({ GARDSSALG_WEBSITE_VERIFICATION_JOB_WINDOW_HOUR_UTC: "24" }), 5, "1-5: invalid window -> default");
        assertTrue(job.GARDSSALG_WV_JOB_DEFAULT_WINDOW_HOUR_UTC !== 4 && job.GARDSSALG_WV_JOB_DEFAULT_WINDOW_HOUR_UTC !== 3, "1-6: default window distinct from 3n (4) and content-refresh (3)");
        assertEq(job.gardssalgWebsiteVerificationJobEnabled({ GARDSSALG_WEBSITE_VERIFICATION_JOB_ENABLED: "1" }), false, "1-7: only literal 'true' enables");
        assertEq(job.gardssalgWebsiteVerificationJobEnabled({}), false, "1-8: default OFF");
      }

      // (2) disabled cron -> nothing happens
      {
        const r = await job.runGardssalgWebsiteVerificationJob({ apply: true, trigger: "cron" }, { ...base, env: {} });
        assertEq([r.skipped_reason, r.totals.pages, auditCount(), hasOffsetRow()], ["disabled", 0, 0, false], "2-1: flag off cron run does nothing");
      }

      // (3) dry-run: zero writes, offset NOT advanced, no envelope
      {
        const r = await job.runGardssalgWebsiteVerificationJob({ apply: false, trigger: "manual" }, base);
        assertEq(r.totals.pages, 5, "3-1: dry-run walks 5 pages");
        assertEq(r.totals.scanned, 60, "3-2: dry-run scans 60 rows (12 x 5)");
        assertEq([r.offset_start, r.offset_end, r.stop_reason], [0, 60, "max_pages"], "3-3: dry-run reports local offsets");
        assertEq([auditCount(), provCount(), hasOffsetRow(), offsetNow()], [0, 0, false, 0], "3-4: dry-run wrote nothing and did not persist the offset");
        assertEq([r.envelope_recorded, runsFor().length], [false, 0], "3-5: dry-run records no envelope");
      }

      // (4) apply: writes, advances the shared offset, caps at 5 pages
      {
        const r = await job.runGardssalgWebsiteVerificationJob({ apply: true, trigger: "manual" }, base);
        assertEq(r.pages.map((p) => p.returned), [12, 12, 12, 12, 12], "4-1: pages of at most 12 rows, capped at 5 pages");
        assertEq(r.stop_reason, "max_pages", "4-2: stopped at the page cap");
        assertEq([auditCount(), provCount()], [60, 60], "4-3: apply stamped provenance + audit for the 60 scanned rows");
        assertEq(offsetNow(), 60, "4-4: persisted sweep offset advanced to 60 (shared with the route)");
        assertEq([r.envelope_recorded, runsFor().length, runsFor()[0]?.status], [true, 1, "completed"], "4-5: one completed ledger envelope");
        // the route's helper sees the same state (single state table)
        assertEq(svc.getGardssalgWebsiteVerificationSweepOffset(expDbRaw, "all"), 60, "4-6: route-side reader sees the job's offset");
      }

      // (5) next run resumes from 60, exhausts the cohort, wraps to 0
      {
        const r = await job.runGardssalgWebsiteVerificationJob({ apply: true, trigger: "manual" }, base);
        assertEq([r.offset_start, r.pages.map((p) => p.returned), r.stop_reason], [60, [12, 3], "cohort_end"], "5-1: resumes at 60, last page short, stops at cohort end");
        assertEq(offsetNow(), 0, "5-2: exhausted cohort wraps the persisted offset to 0");
        assertEq(auditCount(), 75, "5-3: second run wrote the remaining 15 rows on top of the first 60");
      }

      // (6) write-pause: apply writes nothing and reports the pause; dry-run unaffected
      {
        const before = [auditCount(), offsetNow(), runsFor().length];
        const paused = () => ({ paused: true });
        const r = await job.runGardssalgWebsiteVerificationJob({ apply: true, trigger: "manual" }, { ...base, pauseBlock: paused });
        assertEq([r.skipped_reason, r.totals.pages, r.envelope_recorded], ["paused", 0, false], "6-1: apply under pause reports paused, scans nothing");
        assertEq([auditCount(), offsetNow(), runsFor().length], before, "6-2: pause wrote nothing (audit, offset, ledger)");
        const d = await job.runGardssalgWebsiteVerificationJob({ apply: false, trigger: "manual" }, { ...base, pauseBlock: paused });
        assertEq([d.skipped_reason, d.totals.pages], [null, 5], "6-3: dry-run is not blocked by the pause");
        // pause appearing mid-run: first page done, then stop
        let n = 0;
        const flip = () => (n++ >= 2 ? { paused: true } : null); // entry check + page-1 check pass, page-2 check pauses
        const m = await job.runGardssalgWebsiteVerificationJob({ apply: true, trigger: "manual" }, { ...base, pauseBlock: flip });
        assertEq([m.skipped_reason, m.stop_reason, m.totals.pages], ["paused", "paused", 1], "6-4: mid-run pause keeps page 1, stops, reports paused");
        assertEq(offsetNow(), 12, "6-5: offset reflects only the page actually written");
        svc.setGardssalgWebsiteVerificationSweepOffset(expDbRaw, "all", null);
      }

      // (7) time budget stops between pages
      {
        let t = 0;
        const r = await job.runGardssalgWebsiteVerificationJob(
          { apply: false, trigger: "manual" },
          { ...base, timeBudgetMs: 1000, nowMs: () => (t += 600) },
        );
        assertEq([r.stop_reason, r.totals.pages], ["time_budget", 2], "7-1: time budget ends the run between pages");
      }

      // (8) tick: flag off does nothing; flag on + window runs once, stamp persisted
      {
        const off = await job.tickGardssalgWebsiteVerificationDaily({ now: new Date("2026-11-05T05:10:00Z"), lastRunAt: null }, { ...base, env: {} });
        assertEq(off.report, null, "8-1: flag-off tick does nothing");
        const outside = await job.tickGardssalgWebsiteVerificationDaily({ now: new Date("2026-11-05T09:10:00Z"), lastRunAt: null }, base);
        assertEq(outside.report, null, "8-2: outside window -> nothing");
        const runsBefore = runsFor().length;
        const on = await job.tickGardssalgWebsiteVerificationDaily({ now: new Date("2026-11-05T05:10:00Z"), lastRunAt: null }, base);
        assertTrue(on.report !== null && on.report.trigger === "cron" && on.report.apply, "8-3: flag on in window runs an apply cron run");
        assertEq(runsFor().length, runsBefore + 1, "8-4: cron run recorded one envelope");
        const again = await job.tickGardssalgWebsiteVerificationDaily({ now: new Date("2026-11-05T05:40:00Z"), lastRunAt: null }, base);
        assertEq(again.report, null, "8-5: persisted stamp blocks a second run in the same window");
        const st = job.getGardssalgWebsiteVerificationJobStatus({ env: envOn, mainDb, expDb });
        assertEq([st.enabled, st.llm, st.window_hour_utc, st.cohort], [true, false, 5, "all"], "8-6: status reader");
      }
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch { /* ignore */ }
      for (const p of [dbFactoryPath, experienceStorePath, jobPath, svcPath]) delete require.cache[p];
    }
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgWebsiteVerificationJobTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
