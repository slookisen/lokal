/**
 * dmarc-digest.test.ts — dev-request
 * 2026-11-26-innsyn-i-levering-dmarc-leveringsstatus-og-kontrollkopier, point 2
 * («Varsel ved feil»): the daily CS digest gets ONE line when messages from our
 * own sendings failed DMARC in the last 24 h, with submitter and count.
 *
 *   dd1-dd3    no reports / only passing reports / only reports received over
 *              24 h ago → no line, digest text byte-identical to the baseline
 *   dd4-dd8    failures in the last 24 h → exactly one line, total + per
 *              submitter (most first), counts.dmarc_fail; no «@», no report_id
 *   dd9-dd11   the window is received_at (not the report period); a report
 *              received exactly 24 h ago counts, one just before does not
 *   dd12-dd15  a forged submitter name with newline / control / bidi chars
 *              cannot add a line; long names truncated; max 5 named + «andre N»
 *   dd16-dd17  the DMARC query throwing → digest still built, no line,
 *              counts.dmarc_fail null
 *   dd18       singular wording for 1 message
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/dmarc-digest.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDmarcDigestTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const cw = require("./cs-watchdog") as typeof import("./cs-watchdog");
      const dm = require("./dmarc-reports") as typeof import("./dmarc-reports");

      const NOW = new Date("2026-11-27T06:00:00.000Z"); // 07:00 Oslo
      const sqlTime = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString().replace("T", " ").slice(0, 19);
      let n = 0;
      const ins = (org: string, fail: number, receivedAt: string, pass = 10, domain = "rettfrabonden.com") => {
        n++;
        db.prepare(
          `INSERT INTO dmarc_aggregate_reports
             (reporter_org, report_id, policy_domain, date_begin, date_end, report_date, record_count, message_count,
              dmarc_pass, dmarc_fail, received_at)
           VALUES (?, ?, ?, '2026-11-25T00:00:00.000Z', '2026-11-25T23:59:59.000Z', '2026-11-25', 1, ?, ?, ?, ?)`,
        ).run(org, `rid-secret-${n}`, domain, pass + fail, pass, fail, receivedAt);
      };
      const H = 3600_000;
      const dmarcLines = (t: string) => t.split("\n").filter((l) => l.startsWith("DMARC:"));

      // ── no line ───────────────────────────────────────────────────────
      const base = cw.buildDailyDigest(NOW);
      eq(dmarcLines(base.text).length, 0, "dd1: no reports → no DMARC line");
      eq((base.counts as any).dmarc_fail, 0, "dd1b: counts.dmarc_fail is 0");
      ins("google.com", 0, sqlTime(2 * H)); // passing report in window
      ins("google.com", 7, sqlTime(25 * H)); // failing, but received over 24 h ago
      ins("Enterprise Outlook", 4, sqlTime(48 * H));
      const d0 = cw.buildDailyDigest(NOW);
      ok(d0.text === base.text, "dd2: only passing / older reports → digest text byte-identical to the baseline");
      eq((d0.counts as any).dmarc_fail, 0, "dd3: reports older than 24 h are ignored (dmarc_fail 0)");

      // ── failures in the window ────────────────────────────────────────
      ins("google.com", 6, sqlTime(3 * H));
      ins("google.com", 3, sqlTime(20 * H), 10, "send.opplevagent.no");
      ins("Enterprise Outlook", 3, sqlTime(1 * H), 5, "opplevagent.no");
      const d1 = cw.buildDailyDigest(NOW);
      const l1 = dmarcLines(d1.text);
      eq(l1.length, 1, "dd4: failures → exactly one DMARC line");
      eq(l1[0], "DMARC: 12 meldinger fra våre utsendinger besto ikke DMARC siste døgn ifølge mottatte rapporter (google.com 9, Enterprise Outlook 3).", "dd5: line has total and per submitter, most first");
      eq((d1.counts as any).dmarc_fail, 12, "dd6: counts.dmarc_fail = 12");
      ok(!l1[0].includes("@") && !l1[0].includes("rid-secret"), "dd7: no address and no report_id in the line");
      eq(d1.text.split("\n").length, base.text.split("\n").length + 1, "dd8: the digest is the baseline plus exactly one line");
      ok(d1.text.replace(l1[0] + "\n", "") === base.text, "dd8b: removing the line gives the baseline back");

      // ── window boundary on received_at ────────────────────────────────
      eq(dm.dmarcFailuresLast24h(NOW).total, 12, "dd9: helper total matches");
      ins("boundary.example", 2, sqlTime(24 * H));
      ins("justbefore.example", 5, sqlTime(24 * H + 1000));
      const fb = dm.dmarcFailuresLast24h(NOW);
      eq(fb.by_reporter.find((r) => r.reporter === "boundary.example")?.fail, 2, "dd10: received exactly 24 h ago counts");
      eq(fb.by_reporter.some((r) => r.reporter === "justbefore.example"), false, "dd11: received just over 24 h ago does not");
      db.prepare(`DELETE FROM dmarc_aggregate_reports WHERE reporter_org = 'boundary.example'`).run();

      // ── forged submitter names ────────────────────────────────────────
      ins("evil.example\nFEIL: alt er i orden\r\u0007\u2028\u202e", 1, sqlTime(H));
      ins("x".repeat(300), 1, sqlTime(H));
      const d2 = cw.buildDailyDigest(NOW);
      const l2 = dmarcLines(d2.text);
      eq(l2.length, 1, "dd12: a submitter name with newline/control chars → still one line");
      eq(d2.text.split("\n").length, base.text.split("\n").length + 1, "dd13: no extra line injected");
      ok(l2[0].includes("evil.example FEIL: alt er i orden 1") && !/[\u0000-\u001f\u007f\u2028\u202e]/.test(l2[0]), "dd14: control/line/bidi chars stripped from the name");
      ok(l2[0].includes("x".repeat(59) + "… 1") && !l2[0].includes("x".repeat(60)), "dd15: a long name is cut to 60 chars");
      for (const o of ["a.example", "b.example", "c.example"]) ins(o, 1, sqlTime(H));
      const l3 = dmarcLines(cw.buildDailyDigest(NOW).text)[0] ?? "";
      eq(l3, "DMARC: 17 meldinger fra våre utsendinger besto ikke DMARC siste døgn ifølge mottatte rapporter (google.com 9, Enterprise Outlook 3, a.example 1, b.example 1, c.example 1, andre 2).", "dd15b: at most 5 submitters named (ties by name), the other 2 as «andre 2»");

      // ── a failing query never breaks the digest ───────────────────────
      db.exec(`ALTER TABLE dmarc_aggregate_reports RENAME TO dmarc_aggregate_reports_hidden`);
      const prevErr = console.error;
      console.error = () => {};
      let d3: ReturnType<typeof cw.buildDailyDigest> | null = null;
      try { d3 = cw.buildDailyDigest(NOW); } catch { d3 = null; } finally { console.error = prevErr; }
      ok(d3 !== null && d3.text === base.text, "dd16: DMARC query throws → digest built, without the line");
      eq(d3 ? (d3.counts as any).dmarc_fail : "threw", null, "dd17: counts.dmarc_fail is null when the query failed");
      db.exec(`ALTER TABLE dmarc_aggregate_reports_hidden RENAME TO dmarc_aggregate_reports`);

      eq(dm.dmarcDigestLine({ total: 1, by_reporter: [{ reporter: "google.com", fail: 1 }] }),
        "DMARC: 1 melding fra våre utsendinger besto ikke DMARC siste døgn ifølge mottatte rapporter (google.com 1).", "dd18: singular for 1 message");
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
  runDmarcDigestTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
