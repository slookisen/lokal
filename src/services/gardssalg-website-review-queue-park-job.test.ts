/**
 * gardssalg-website-review-queue-park-job.test.ts — the server-side daily job
 * for step 3m (parking of terminal gardssalg_website_review_queue rows).
 *
 * Everything is real: in-memory experiences DB (schema from init-experiences),
 * the real shared core, the main-db run ledger and boot_job_state.
 */
import type Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgWebsiteReviewQueueParkJobTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const jobPath = require.resolve("./gardssalg-website-review-queue-park-job");
    for (const p of [dbFactoryPath, experienceStorePath, jobPath]) delete require.cache[p];
    let restoreMainDb: (() => void) | null = null;

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDbRaw = dbFactory.getDb("experiences") as unknown as Database.Database;
      const store = require("./experience-store") as typeof import("./experience-store");
      const init = require("../database/init") as typeof import("../database/init");
      restoreMainDb = init.__pinInMemoryDbForTesting();
      const mainDb = () => init.getDb() as unknown as Database.Database;
      const expDb = () => expDbRaw;
      const job = require("./gardssalg-website-review-queue-park-job") as typeof import("./gardssalg-website-review-queue-park-job");

      const insProv = expDbRaw.prepare(
        `INSERT INTO experience_providers (id, navn, vertical, content_source, brreg_verified, created_at)
         VALUES (?, ?, 'experiences', 'provider_site', 0, '2026-01-01')`,
      );
      const seed = (id: string, reason: string, confidence: number | null) => {
        insProv.run(id, `Gard ${id}`);
        store.upsertGardssalgWebsiteReviewQueue({
          provider_id: id,
          provider_name: `Gard ${id}`,
          candidate_url: `https://${id}.no`,
          evidence: JSON.stringify({ id }),
          confidence,
          reason: reason as any,
        });
      };
      seed("p-vf", "verification_failed", null);
      seed("p-cef", "candidate_evidence_failed", null);
      seed("p-wdc", "website_discovery_candidate", 1.0);

      const row = (id: string) => expDbRaw.prepare(`SELECT * FROM gardssalg_website_review_queue WHERE provider_id = ?`).get(id) as any;
      const total = () => (expDbRaw.prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_review_queue`).get() as any).n as number;
      const unparkedTerminal = () =>
        (expDbRaw
          .prepare(`SELECT COUNT(*) AS n FROM gardssalg_website_review_queue WHERE reason IN ('verification_failed','candidate_evidence_failed') AND parked_since IS NULL`)
          .get() as any).n as number;
      const runsFor = () => mainDb().prepare("SELECT run_id, status, trigger_source FROM runs WHERE agent = ? ORDER BY rowid").all(job.GARDSSALG_RQP_JOB_AGENT) as any[];
      const noPause = () => null;
      const paused = () => ({ paused: true });
      const envOn = { GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_ENABLED: "true" } as Record<string, string | undefined>;
      const base = { pauseBlock: noPause, env: envOn, mainDb, expDb };
      const snap = () => JSON.stringify([row("p-vf"), row("p-cef"), row("p-wdc")]);

      // (1) pure guards
      {
        const at = (s: string) => new Date(s);
        assertEq(job.shouldRunGardssalgWebsiteReviewQueueParkDaily({ now: at("2026-11-01T06:05:00Z"), lastRunAt: null }), true, "1-1: default 06 UTC window -> run");
        assertEq(job.shouldRunGardssalgWebsiteReviewQueueParkDaily({ now: at("2026-11-01T05:05:00Z"), lastRunAt: null }), false, "1-2: outside window -> no");
        assertEq(job.shouldRunGardssalgWebsiteReviewQueueParkDaily({ now: at("2026-11-01T06:50:00Z"), lastRunAt: at("2026-11-01T06:05:00Z") }), false, "1-3: ran 45 min ago -> no");
        assertEq(job.resolveGardssalgWebsiteReviewQueueParkJobWindowHourUtc({ GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_WINDOW_HOUR_UTC: "22" }), 22, "1-4: window configurable");
        assertEq(job.resolveGardssalgWebsiteReviewQueueParkJobWindowHourUtc({ GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_WINDOW_HOUR_UTC: "24" }), 6, "1-5: invalid window -> default");
        assertTrue(![3, 4, 5].includes(job.GARDSSALG_RQP_JOB_DEFAULT_WINDOW_HOUR_UTC), "1-6: default window distinct from content-refresh (3), 3n (4) and 3f (5)");
        assertEq(job.gardssalgWebsiteReviewQueueParkJobEnabled({ GARDSSALG_WEBSITE_REVIEW_QUEUE_PARK_JOB_ENABLED: "1" }), false, "1-7: only literal 'true' enables");
        assertEq(job.gardssalgWebsiteReviewQueueParkJobEnabled({}), false, "1-8: default OFF");
      }

      // (2) disabled cron -> nothing happens
      {
        const before = snap();
        const r = await job.runGardssalgWebsiteReviewQueueParkJob({ apply: true, trigger: "cron" }, { ...base, env: {} });
        assertEq([r.skipped_reason, r.parked, snap() === before, runsFor().length], ["disabled", 0, true, 0], "2-1: flag off cron run does nothing");
      }

      // (3) dry-run: zero writes, no envelope
      {
        const before = snap();
        const r = await job.runGardssalgWebsiteReviewQueueParkJob({ apply: false, trigger: "manual" }, base);
        assertEq([r.would_park, r.parked, r.results.map((x) => x.provider_id).sort()], [2, 0, ["p-cef", "p-vf"]], "3-1: dry-run reports the two terminal rows");
        assertEq([snap() === before, r.envelope_recorded, runsFor().length], [true, false, 0], "3-2: dry-run wrote nothing and recorded no envelope");
      }

      // (4) write-pause: apply writes nothing; tick leaves the stamp alone
      {
        const before = snap();
        const r = await job.runGardssalgWebsiteReviewQueueParkJob({ apply: true, trigger: "manual" }, { ...base, pauseBlock: paused });
        assertEq([r.skipped_reason, r.parked, r.envelope_recorded], ["paused", 0, false], "4-1: apply under pause reports paused");
        assertEq([snap() === before, runsFor().length], [true, 0], "4-2: pause wrote nothing (queue, ledger)");
        const t = await job.tickGardssalgWebsiteReviewQueueParkDaily({ now: new Date("2026-11-05T06:10:00Z"), lastRunAt: null }, { ...base, pauseBlock: paused });
        assertEq([t.report?.skipped_reason, t.lastRunAt, snap() === before], ["paused", null, true], "4-3: paused tick writes nothing and leaves the daily stamp alone");
        const d = await job.runGardssalgWebsiteReviewQueueParkJob({ apply: false, trigger: "manual" }, { ...base, pauseBlock: paused });
        assertEq([d.skipped_reason, d.would_park], [null, 2], "4-4: dry-run is not blocked by the pause");
      }

      // (5) tick: flag off does nothing; outside window does nothing
      {
        const before = snap();
        const off = await job.tickGardssalgWebsiteReviewQueueParkDaily({ now: new Date("2026-11-05T06:10:00Z"), lastRunAt: null }, { ...base, env: {} });
        assertEq([off.report, snap() === before], [null, true], "5-1: flag-off tick does nothing");
        const outside = await job.tickGardssalgWebsiteReviewQueueParkDaily({ now: new Date("2026-11-05T09:10:00Z"), lastRunAt: null }, base);
        assertEq([outside.report, snap() === before], [null, true], "5-2: outside window -> nothing");
      }

      // (6) apply: parks only terminal unparked rows, never touches other fields, never deletes
      {
        const bVf = row("p-vf"), bCef = row("p-cef"), bWdc = row("p-wdc");
        const n = total();
        const r = await job.runGardssalgWebsiteReviewQueueParkJob({ apply: true, trigger: "manual" }, base);
        assertEq([r.would_park, r.parked, r.skipped_reason], [2, 2, null], "6-1: apply parks both terminal rows");
        const aVf = row("p-vf"), aCef = row("p-cef");
        assertTrue(typeof aVf.parked_since === "string" && typeof aCef.parked_since === "string", "6-2: parked_since stamped on both");
        assertEq(row("p-wdc"), bWdc, "6-3: website_discovery_candidate row byte-identical");
        assertEq({ ...aVf, parked_since: bVf.parked_since, updated_at: bVf.updated_at }, bVf, "6-4: only parked_since/updated_at changed (verification_failed)");
        assertEq({ ...aCef, parked_since: bCef.parked_since, updated_at: bCef.updated_at }, bCef, "6-5: only parked_since/updated_at changed (candidate_evidence_failed)");
        assertEq([total(), unparkedTerminal()], [n, 0], "6-6: nothing deleted, no unparked terminal rows remain");
        assertEq([r.envelope_recorded, runsFor().length, runsFor()[0]?.status], [true, 1, "completed"], "6-7: one completed ledger envelope");
      }

      // (7) tick: flag on in window runs once; second run same day is a no-op
      {
        // a fresh terminal row so a (wrongly) repeated run would visibly park it
        seed("p-vf2", "verification_failed", null);
        const runsBefore = runsFor().length;
        const on = await job.tickGardssalgWebsiteReviewQueueParkDaily({ now: new Date("2026-11-05T06:10:00Z"), lastRunAt: null }, base);
        assertTrue(on.report !== null && on.report.trigger === "cron" && on.report.apply && on.report.parked === 1, "7-1: flag on in window runs an apply cron run");
        assertEq(runsFor().length, runsBefore + 1, "7-2: cron run recorded one envelope");
        seed("p-cef2", "candidate_evidence_failed", null);
        const again = await job.tickGardssalgWebsiteReviewQueueParkDaily({ now: new Date("2026-11-05T06:40:00Z"), lastRunAt: null }, base);
        assertEq([again.report, unparkedTerminal(), runsFor().length], [null, 1, runsBefore + 1], "7-3: persisted stamp makes the same-day second run a no-op");
        const st = job.getGardssalgWebsiteReviewQueueParkJobStatus({ env: envOn, mainDb, expDb });
        assertEq([st.enabled, st.llm, st.window_hour_utc, st.unparked_terminal_rows], [true, false, 6, 1], "7-4: status reader");
        assertTrue(typeof st.last_completed_at === "string", "7-5: status shows last completed stamp");
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
  runGardssalgWebsiteReviewQueueParkJobTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
