/**
 * cs-watchdog.test.ts — dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A),
 * skive S1b: the watcher that does not depend on the CS LLM routine.
 *
 *   cw1-cw9    forward retry: back-off, recovery, exhaustion after 4 tries.
 *   cw10-cw13  alert de-duplication (once per item per 24 h) + log retention.
 *   cw14-cw24  runCsWatchdog: new P0 items alerted once, run-ledger row with
 *              counts, missing admin address → partial + error (never silent).
 *   cw25-cw35  daily digest: 07:00 Europe/Oslo gate, content, send/no-address,
 *              and the tick honours both flags and the hourly gate.
 *
 * Standalone:
 *   node node_modules/tsx/dist/cli.mjs src/services/cs-watchdog.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";
import { __resetDbFactoryForTesting } from "../database/db-factory";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runCsWatchdogTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const crm = require("./crm-service") as typeof import("./crm-service");

      const T0 = new Date("2026-11-11T10:00:00.000Z");
      const hoursBefore = (d: Date, h: number) => new Date(d.getTime() - h * 3600_000).toISOString();
      const sqlTime = (iso: string) => iso.replace("T", " ").slice(0, 19);

      // ── forward retry ───────────────────────────────────────────────
      ok(cw.forwardRetryDue(1, sqlTime(hoursBefore(T0, 0.2)), T0) === true, "cw1: 1 failed try, 12 min ago → due (10 min back-off)");
      ok(cw.forwardRetryDue(1, sqlTime(hoursBefore(T0, 0.1)), T0) === false, "cw2: 1 failed try, 6 min ago → not yet");
      ok(cw.forwardRetryDue(2, sqlTime(hoursBefore(T0, 0.25)), T0) === false, "cw3: 2 tries → 20 min back-off, 15 min ago → not yet");
      ok(cw.forwardRetryDue(4, null, T0) === false, "cw4: 4 tries → exhausted, never due");

      const insFail = (id: string, attempts: number, minutesAgo: number, payload: string | null = JSON.stringify({ to: "admin@x.no", subject: "[Innkommende] s", textContent: "t" })) =>
        db.prepare(
          `INSERT INTO inbound_email_log (id, email_id, from_email, subject, forward_status, forward_attempts, forward_payload, received_at, updated_at)
           VALUES (?, ?, 'k@x.no', 'Sak', 'failed', ?, ?, ?, ?)`,
        ).run(id, `e-${id}`, attempts, payload, sqlTime(hoursBefore(T0, 1)), sqlTime(new Date(T0.getTime() - minutesAgo * 60_000).toISOString()));
      insFail("inb-aaaaaaaa1", 1, 30);
      insFail("inb-aaaaaaaa2", 3, 200);
      insFail("inb-aaaaaaaa3", 1, 2);
      const sends: any[] = [];
      let sendOk = true;
      const send = async (o: any) => { sends.push(o); return sendOk ? { success: true } : { success: false, error: "relay down" }; };
      const r1 = await cw.retryFailedForwards({ send, now: T0 });
      eq([r1.retried, r1.recovered], [2, 2], "cw5: the two due rows are retried and recovered (the 2-min-old one waits)");
      const row1 = db.prepare("SELECT * FROM inbound_email_log WHERE id='inb-aaaaaaaa1'").get() as any;
      eq([row1.forward_status, row1.forward_attempts, row1.forward_payload], ["ok", 2, null], "cw6: recovered → ok, attempts counted, payload cleared");
      sendOk = false;
      insFail("inb-aaaaaaaa4", 3, 200);
      const r2 = await cw.retryFailedForwards({ send, now: T0 });
      ok(r2.exhausted.some((e) => e.id === "inb-aaaaaaaa4"), "cw7: a 4th failed try exhausts the row");
      eq((db.prepare("SELECT forward_status, forward_attempts FROM inbound_email_log WHERE id='inb-aaaaaaaa4'").get() as any), { forward_status: "failed", forward_attempts: 4 }, "cw8: …it stays failed with 4 attempts");
      insFail("inb-aaaaaaaa5", 1, 30, "{not json");
      const r3 = await cw.retryFailedForwards({ send, now: T0 });
      ok(r3.exhausted.some((e) => e.id === "inb-aaaaaaaa5" && e.error === "unparseable forward_payload"), "cw9: an unparseable payload is reported as exhausted, not retried forever");

      // ── alert de-dup + retention ────────────────────────────────────
      ok(cw.claimAlert("thread:x", T0) === true, "cw10: first alert for an item is allowed");
      ok(cw.claimAlert("thread:x", new Date(T0.getTime() + 3600_000)) === false, "cw11: the same item within 24 h is not re-alerted");
      ok(cw.claimAlert("thread:x", new Date(T0.getTime() + 25 * 3600_000)) === true, "cw12: …but is again after 24 h");
      db.prepare(`INSERT INTO inbound_email_log (id, from_email, forward_status, received_at) VALUES ('inb-old-ok', 'o@x.no', 'ok', ?)`).run(sqlTime(hoursBefore(T0, 24 * 100)));
      db.prepare(`INSERT INTO inbound_email_log (id, from_email, forward_status, forward_attempts, received_at) VALUES ('inb-old-fail', 'o@x.no', 'failed', 4, ?)`).run(sqlTime(hoursBefore(T0, 24 * 100)));
      const purged = cw.purgeInboundLog(T0);
      eq([purged, !!db.prepare("SELECT 1 FROM inbound_email_log WHERE id='inb-old-fail'").get()], [1, true], "cw13: rows older than 90 days are purged, an undelivered forward is kept");

      // ── watchdog ────────────────────────────────────────────────────
      const now = new Date();
      crm.crmService.ingestThread(
        { threadId: "wd-old", subject: "Spørsmål om åpningstider", category: "innkommende",
          messages: [{ messageId: "wd-old-m", direction: "in", fromEmail: "kunde@x.no", sentAt: hoursBefore(now, 30) }] },
        "kunde@x.no", "rfb");
      crm.crmService.ingestThread(
        { threadId: "wd-fresh", subject: "Ny sak", category: "innkommende",
          messages: [{ messageId: "wd-fresh-m", direction: "in", fromEmail: "kunde2@x.no", sentAt: hoursBefore(now, 1) }] },
        "kunde2@x.no", "rfb");
      const alerts: any[] = [];
      const alertSend = async (o: any) => { alerts.push(o); return { success: true }; };
      const w1 = await cw.runCsWatchdog({ send: alertSend, now, adminEmail: "admin@example.no", trigger: "manual" });
      eq(alerts.length, 1, "cw14: one alert e-mail for the new problems");
      ok(String(alerts[0]?.textContent).includes("Spørsmål om åpningstider") && String(alerts[0]?.textContent).includes("wd-old"), "cw15: the 30-h-old thread is in the alert");
      ok(!String(alerts[0]?.textContent).includes("Ny sak"), "cw16: the 1-h-old thread is not (not yet P0)");
      ok(String(alerts[0]?.textContent).includes("Videresending feilet 4 ganger"), "cw17: the exhausted forward is in the alert");
      eq(alerts[0]?.to, "admin@example.no", "cw18: sent to the admin address");
      const run = db.prepare("SELECT status, claims FROM runs WHERE run_id = ?").get(w1.run_id) as any;
      eq(run?.status, "completed", "cw19: a run-ledger row is recorded (completed)");
      ok(String(run?.claims).includes("cs_needs_reply"), "cw20: …with the needs-reply counts as a claim");
      const w2 = await cw.runCsWatchdog({ send: alertSend, now: new Date(now.getTime() + 60_000), adminEmail: "admin@example.no", trigger: "manual" });
      eq([alerts.length, w2.alerted_items], [1, 0], "cw21: a second run does not re-alert the same items");
      crm.crmService.ingestThread(
        { threadId: "wd-old2", subject: "Annen sak", category: "innkommende",
          messages: [{ messageId: "wd-old2-m", direction: "in", fromEmail: "kunde3@x.no", sentAt: hoursBefore(now, 26) }] },
        "kunde3@x.no", "rfb");
      const w3 = await cw.runCsWatchdog({ send: alertSend, now: new Date(now.getTime() + 2 * 60_000), adminEmail: "", trigger: "manual" });
      eq([w3.alerted_items, w3.alert_sent], [1, false], "cw22: no admin address → the new item is still counted, alert_sent false");
      const run3 = db.prepare("SELECT status, errors FROM runs WHERE run_id = ?").get(w3.run_id) as any;
      ok(run3?.status === "partial" && String(run3?.errors).includes("ADMIN_NOTIFICATION_EMAIL"), "cw23: …and the run is PARTIAL with the reason (never silent)");
      eq(w1.report_counts.p0 >= 1, true, "cw24: report counts carried in the result");

      // ── daily digest ────────────────────────────────────────────────
      ok(cw.digestDue(new Date("2026-11-11T05:59:00Z"), null) === false, "cw25: 06:59 Oslo (winter, UTC+1) → not due");
      ok(cw.digestDue(new Date("2026-11-11T06:00:00Z"), null) === true, "cw26: 07:00 Oslo → due");
      ok(cw.digestDue(new Date("2026-11-11T09:00:00Z"), new Date("2026-11-11T06:05:00Z")) === false, "cw27: already sent this Oslo date → not due");
      ok(cw.digestDue(new Date("2026-11-12T06:10:00Z"), new Date("2026-11-11T06:05:00Z")) === true, "cw28: next Oslo date after 07:00 → due");
      ok(cw.digestDue(new Date("2026-07-01T05:00:00Z"), null) === true, "cw29: summer time (UTC+2): 05:00Z is 07:00 Oslo → due");
      const d = cw.buildDailyDigest(now);
      ok(d.text.includes("INN") && d.text.includes("UT") && d.text.includes("TRENGER SVAR") && d.text.includes("FEIL"), "cw30: the digest has the four sections");
      ok(d.text.includes("Spørsmål om åpningstider"), "cw31: an unanswered thread is listed with æøå intact");
      const digests: any[] = [];
      const dg = await cw.runCsDailyDigest({ send: async (o: any) => { digests.push(o); return { success: true }; }, now, adminEmail: "admin@example.no", trigger: "manual" });
      eq([dg.sent, digests.length, digests[0]?.to], [true, 1, "admin@example.no"], "cw32: the digest is sent to the admin");
      const dg2 = await cw.runCsDailyDigest({ send: async () => ({ success: true }), now: new Date(now.getTime() + 86400_000), adminEmail: "", trigger: "manual" });
      eq([dg2.sent, dg2.reason], [false, "no_admin_email"], "cw33: no admin address → not sent, reason recorded");
      eq((db.prepare("SELECT status FROM runs WHERE run_id = ?").get(dg2.run_id) as any)?.status, "failed", "cw34: …and the digest run is FAILED in the ledger");

      // tick: flags + gates
      const off = await cw.tickCsWatchdog({ lastWatchdogAt: null, lastDigestAt: null }, { now, send: alertSend, env: {} as any });
      eq([off.ranWatchdog, off.ranDigest], [false, false], "cw35: flags off → the tick does nothing");
      const on1 = await cw.tickCsWatchdog({ lastWatchdogAt: null, lastDigestAt: null }, { now, send: alertSend, env: { CS_WATCHDOG_ENABLED: "1" } as any });
      eq(on1.ranWatchdog, true, "cw36: watchdog flag on → runs");
      const on2 = await cw.tickCsWatchdog({ lastWatchdogAt: on1.lastWatchdogAt, lastDigestAt: null }, { now: new Date(now.getTime() + 10 * 60_000), send: alertSend, env: { CS_WATCHDOG_ENABLED: "1" } as any });
      eq(on2.ranWatchdog, false, "cw37: …but not again within 55 min");
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
  runCsWatchdogTests({ log: true }).then((s) => {
    for (const f of s.failures) console.log(f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
