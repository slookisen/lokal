/**
 * cs-digest-review-queues.test.ts — dev-request
 * 2026-11-15-rfb-nattjobb-hull-kontaktuttrekk-bm-og-koer, skive B4
 * («køene får alder»): the daily CS digest shows the org.nr queue
 * (agents_org_nr_review_queue) and the website queue
 * (agents_website_review_queue) with the count and the age of the oldest open
 * row, and a row older than 2 business days gives a FUNN line.
 *
 *   rq1-rq4    missing tables never throw → "ukjent"; empty queues → 0 åpne.
 *   rq5-rq8    fresh rows: count + age shown, no finding.
 *   rq9-rq14   2-business-day boundary, incl. a weekend (exactly 2 = no
 *              finding, 3 = finding).
 *   rq15-rq18  handled website rows (applied/rejected/superseded) and deleted
 *              org.nr rows are not counted.
 *   rq19-rq22  buildDailyDigest carries the section, the finding and counts.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/cs-digest-review-queues.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCsDigestReviewQueueTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, `${label} (expected ${e}, got ${a})`);
  }

  return (async () => {
    const prevDb = initMod.__peekDbForTesting();
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    __resetDbFactoryForTesting();
    const db = new Database(":memory:");
    try {
      initMod.__setDbForTesting(db as any);
      initMod.__initSchemaForTesting(db as any);
      db.pragma("foreign_keys = OFF"); // queue rows without agents rows
      const cw = require("./cs-watchdog") as typeof import("./cs-watchdog");
      const { ensureRfbWebsiteReviewQueueTable } =
        require("../routes/admin-rfb-website-discovery") as typeof import("../routes/admin-rfb-website-discovery");

      // Wednesday 2026-11-18, 08:00 UTC (09:00 Oslo, after the 07:00 digest gate).
      const WED = new Date("2026-11-18T08:00:00.000Z");
      const TUE = new Date("2026-11-17T08:00:00.000Z");
      const insOrg = (agentId: string, createdAt: string) =>
        db.prepare(
          `INSERT INTO agents_org_nr_review_queue (id, agent_id, agent_name, reason, created_at, updated_at) VALUES (?, ?, ?, 'brreg_contact', ?, ?)`,
        ).run(`oq-${agentId}`, agentId, `Gård ${agentId}`, createdAt, createdAt);
      const insWeb = (agentId: string, createdAt: string, status: string) =>
        db.prepare(
          `INSERT INTO agents_website_review_queue (id, agent_id, agent_name, candidate_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(`wq-${agentId}`, agentId, `Gård ${agentId}`, `https://${agentId}.no`, status, createdAt, createdAt);

      // ── missing tables / empty queues ─────────────────────────────────
      // init.ts does not create agents_website_review_queue (it is lazy).
      let ages = cw.reviewQueueAges(WED);
      eq([ages.org_nr, ages.website], [{ open: 0, oldest_created_at: null, oldest_business_days: null, stale: false }, null], "rq1: org.nr queue empty, website table missing → null (no throw)");
      let dl = cw.reviewQueueDigestLines(ages);
      eq(dl, { lines: ["• Org.nr-køen: 0 åpne", "• Nettstedkøen: ukjent (tabellen finnes ikke)"], findings: [] }, "rq2: empty + missing rendered, no finding");
      db.exec(`ALTER TABLE agents_org_nr_review_queue RENAME TO agents_org_nr_review_queue_hidden`);
      let threw = false;
      try { ages = cw.reviewQueueAges(WED); } catch { threw = true; }
      ok(!threw && ages.org_nr === null && ages.website === null, "rq3: both tables missing → both null, no throw");
      db.exec(`ALTER TABLE agents_org_nr_review_queue_hidden RENAME TO agents_org_nr_review_queue`);
      ensureRfbWebsiteReviewQueueTable(db as any);
      dl = cw.reviewQueueDigestLines(cw.reviewQueueAges(WED));
      eq(dl, { lines: ["• Org.nr-køen: 0 åpne", "• Nettstedkøen: 0 åpne"], findings: [] }, "rq4: both tables present and empty → 0 åpne");

      // ── fresh rows ────────────────────────────────────────────────────
      insOrg("a1", "2026-11-17 09:00:00");
      insOrg("a2", "2026-11-18 07:00:00");
      insWeb("w1", "2026-11-18 06:00:00", "pending");
      ages = cw.reviewQueueAges(WED);
      eq(ages.org_nr, { open: 2, oldest_created_at: "2026-11-17 09:00:00", oldest_business_days: 1, stale: false }, "rq5: org.nr 2 open, oldest yesterday = 1 business day");
      eq(ages.website, { open: 1, oldest_created_at: "2026-11-18 06:00:00", oldest_business_days: 0, stale: false }, "rq6: website 1 open, today = 0 business days");
      dl = cw.reviewQueueDigestLines(ages);
      eq(dl.lines, ["• Org.nr-køen: 2 åpne, eldste 1 virkedag (2026-11-17)", "• Nettstedkøen: 1 åpen, eldste 0 virkedager (2026-11-18)"], "rq7: count + age + date shown");
      eq(dl.findings, [], "rq8: fresh rows → no finding");

      // ── boundary, incl. a weekend ─────────────────────────────────────
      insOrg("a3", "2026-11-16 10:00:00"); // Monday → Wednesday = 2
      ages = cw.reviewQueueAges(WED);
      eq([ages.org_nr?.oldest_business_days, ages.org_nr?.stale], [2, false], "rq9: exactly 2 business days → not stale");
      eq(cw.reviewQueueDigestLines(ages).findings, [], "rq10: exactly 2 business days → no finding");
      insWeb("w2", "2026-11-13 23:30:00", "pending"); // Friday → Tuesday = 2 over a weekend
      ages = cw.reviewQueueAges(TUE);
      eq([ages.website?.oldest_business_days, ages.website?.stale], [2, false], "rq11: Friday → Tuesday (weekend skipped) = 2 → not stale");
      ages = cw.reviewQueueAges(WED);
      eq([ages.website?.open, ages.website?.oldest_business_days, ages.website?.stale], [2, 3, true], "rq12: Friday → Wednesday = 3 → stale");
      dl = cw.reviewQueueDigestLines(ages);
      eq(dl.lines[1], "• Nettstedkøen: 2 åpne, eldste 3 virkedager (2026-11-13) ⚠", "rq13: stale queue line carries the date and ⚠");
      eq(dl.findings, ["FUNN: Nettstedkøen har en rad som har ventet 3 virkedager (over 2) — 2 åpne."], "rq14: one finding for the stale queue only");

      // ── handled rows ignored ──────────────────────────────────────────
      insWeb("w3", "2026-10-01 10:00:00", "applied");
      insWeb("w4", "2026-10-02 10:00:00", "rejected");
      insWeb("w5", "2026-10-03 10:00:00", "superseded");
      ages = cw.reviewQueueAges(WED);
      eq([ages.website?.open, ages.website?.oldest_created_at], [2, "2026-11-13 23:30:00"], "rq15: applied/rejected/superseded website rows not counted or aged");
      db.prepare(`UPDATE agents_website_review_queue SET status = 'applied' WHERE agent_id = 'w2'`).run();
      ages = cw.reviewQueueAges(WED);
      eq([ages.website?.open, ages.website?.stale, cw.reviewQueueDigestLines(ages).findings.length], [1, false, 0], "rq16: handling the stale website row clears the finding");
      insOrg("a4", "2026-11-09 10:00:00"); // Monday a week before → 7 business days
      ages = cw.reviewQueueAges(WED);
      eq([ages.org_nr?.open, ages.org_nr?.oldest_business_days, ages.org_nr?.stale], [4, 7, true], "rq17: org.nr row 7 business days old → stale");
      db.prepare(`DELETE FROM agents_org_nr_review_queue WHERE agent_id = ?`).run("a4"); // the handled path deletes the row
      ages = cw.reviewQueueAges(WED);
      eq([ages.org_nr?.open, ages.org_nr?.oldest_business_days, ages.org_nr?.stale], [3, 2, false], "rq18: deleted (handled) org.nr row no longer counted");

      // ── buildDailyDigest ──────────────────────────────────────────────
      insOrg("a5", "2026-11-12 10:00:00"); // Thursday → Wednesday = 4
      const d = cw.buildDailyDigest(WED);
      ok(d.text.includes("GJENNOMGANGSKØER (nattjobben)\n• Org.nr-køen: 4 åpne, eldste 4 virkedager (2026-11-12) ⚠\n• Nettstedkøen: 1 åpen, eldste 0 virkedager (2026-11-18)\nFUNN: Org.nr-køen har en rad som har ventet 4 virkedager (over 2) — 4 åpne."), "rq19: digest text has both queues with age and the finding");
      const rq = (d.counts as any).review_queues;
      eq([rq?.org_nr?.open, rq?.org_nr?.oldest_business_days, rq?.org_nr?.stale, rq?.website?.open, rq?.website?.oldest_business_days], [4, 4, true, 1, 0], "rq20: counts.review_queues has the numbers");
      eq(rq?.findings?.length, 1, "rq21: counts.review_queues.findings lists the finding");
      db.exec(`DROP TABLE agents_website_review_queue`);
      let d2: ReturnType<typeof cw.buildDailyDigest> | null = null;
      try { d2 = cw.buildDailyDigest(WED); } catch { d2 = null; }
      ok(d2 !== null && d2.text.includes("• Nettstedkøen: ukjent (tabellen finnes ikke)") && (d2.counts as any).review_queues.website === null, "rq22: digest with a missing website table does not throw, shows ukjent");
    } catch (err: any) {
      failed++;
      failures.push("unexpected error: " + String(err?.stack || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
      initMod.__setDbForTesting(prevDb as any);
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      __resetDbFactoryForTesting();
    }
    if (log) console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runCsDigestReviewQueueTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
