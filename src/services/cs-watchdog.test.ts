/**
 * cs-watchdog.test.ts — dev-request 2026-11-10-cs-paa-serveren (slookisen/A2A),
 * skive S1b: the watcher that does not depend on the CS LLM routine.
 *
 *   cw1-cw9    forward retry: back-off, recovery, exhaustion after 4 tries.
 *   cw10-cw13  alert de-duplication (once per item per 24 h) + log retention.
 *   cw14-cw24  runCsWatchdog: new P0 items alerted once, run-ledger row with
 *              counts, missing admin address → partial + error (never silent).
 *   cw25-cw37  daily digest: 07:00 Europe/Oslo gate, content, send/no-address,
 *              and the tick honours both flags and the hourly gate.
 *   cw38-cw52  review fixes: exhausted forwards are terminal and never starve
 *              newer failures; an item counts as alerted only after the alert
 *              e-mail was accepted; exhausted forwards alerted once; overlapping
 *              ticks skipped; a failed digest retried hourly; a throwing
 *              watchdog does not block the digest; daily purge with flags off.
 *   cw53-cw56  second review: one-time problems are itemized before a thread
 *              backlog and only itemized keys are recorded; a forward stuck in
 *              pending is alerted; a digest retry gets its own ledger row.
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
      eq((db.prepare("SELECT forward_status, forward_attempts FROM inbound_email_log WHERE id='inb-aaaaaaaa4'").get() as any), { forward_status: "exhausted", forward_attempts: 4 }, "cw8: …and becomes terminal (exhausted) with 4 attempts");
      insFail("inb-aaaaaaaa5", 1, 30, "{not json");
      const r3 = await cw.retryFailedForwards({ send, now: T0 });
      ok(r3.exhausted.some((e) => e.id === "inb-aaaaaaaa5" && e.error === "unparseable forward_payload"), "cw9: an unparseable payload is reported as exhausted, not retried forever");

      // ── alert de-dup + retention ────────────────────────────────────
      ok(cw.claimAlert("thread:x", T0) === true, "cw10: first alert for an item is allowed");
      ok(cw.claimAlert("thread:x", new Date(T0.getTime() + 3600_000)) === false, "cw11: the same item within 24 h is not re-alerted");
      ok(cw.claimAlert("thread:x", new Date(T0.getTime() + 25 * 3600_000)) === true, "cw12: …but is again after 24 h");
      db.prepare(`INSERT INTO inbound_email_log (id, from_email, forward_status, received_at) VALUES ('inb-old-ok', 'o@x.no', 'ok', ?)`).run(sqlTime(hoursBefore(T0, 24 * 100)));
      db.prepare(`INSERT INTO inbound_email_log (id, from_email, forward_status, forward_attempts, received_at) VALUES ('inb-old-fail', 'o@x.no', 'failed', 4, ?)`).run(sqlTime(hoursBefore(T0, 24 * 100)));
      db.prepare(`INSERT INTO inbound_email_log (id, from_email, forward_status, forward_attempts, forward_payload, received_at) VALUES ('inb-ex-40d', 'o@x.no', 'exhausted', 4, '{"to":"a"}', ?)`).run(sqlTime(hoursBefore(T0, 24 * 40)));
      const purged = cw.purgeInboundLog(T0);
      eq([purged, !!db.prepare("SELECT 1 FROM inbound_email_log WHERE id='inb-old-fail'").get()], [2, false], "cw13: every row older than 90 days is purged (also an old undelivered one)");
      eq((db.prepare("SELECT forward_payload FROM inbound_email_log WHERE id='inb-ex-40d'").get() as any)?.forward_payload, null, "cw13b: a forward given up on > 30 days ago loses its stored mail body, the row stays");

      // ── watchdog ────────────────────────────────────────────────────
      // Two clocks meet here. Forward retry and alert de-dup take `now`, and the
      // forward-retry rows above are relative to T0, so `now` is T0: on the wall clock
      // those rows became due once real time passed T0, and the retry mail was counted
      // as a watchdog alert (cw14/15/17/18/21 red from 2026-11-11T10:0xZ). Thread ages
      // come from SQL julianday('now') (crm-needs-reply), so the thread fixtures below
      // are relative to the real clock instead.
      const now = new Date(T0.getTime());
      crm.crmService.ingestThread(
        { threadId: "wd-old", subject: "Spørsmål om åpningstider", category: "innkommende",
          messages: [{ messageId: "wd-old-m", direction: "in", fromEmail: "kunde@x.no", sentAt: hoursBefore(new Date(), 30) }] },
        "kunde@x.no", "rfb");
      crm.crmService.ingestThread(
        { threadId: "wd-fresh", subject: "Ny sak", category: "innkommende",
          messages: [{ messageId: "wd-fresh-m", direction: "in", fromEmail: "kunde2@x.no", sentAt: hoursBefore(new Date(), 1) }] },
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
          messages: [{ messageId: "wd-old2-m", direction: "in", fromEmail: "kunde3@x.no", sentAt: hoursBefore(new Date(), 26) }] },
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

      // ── review B2: exhausted rows never starve newer failures ───────
      {
        db.prepare("DELETE FROM inbound_email_log").run();
        const ins = db.prepare(
          `INSERT INTO inbound_email_log (id, email_id, from_email, subject, forward_status, forward_attempts, forward_payload, received_at, updated_at)
           VALUES (?, ?, 'f@x.no', 's', 'failed', ?, '{"to":"a","subject":"s","textContent":"t"}', ?, ?)`,
        );
        for (let i = 0; i < 100; i++) ins.run(`inb-legacy-${String(i).padStart(3, "0")}`, `el-${i}`, 4, sqlTime(hoursBefore(T0, 50 - i * 0.01)), sqlTime(hoursBefore(T0, 2)));
        ins.run("inb-fresh-0001", "ef-1", 1, sqlTime(hoursBefore(T0, 1)), sqlTime(hoursBefore(T0, 1)));
        let sentFresh = 0;
        const r = await cw.retryFailedForwards({ send: async () => { sentFresh++; return { success: true }; }, now: T0 });
        eq([r.retried, r.recovered, sentFresh], [1, 1, 1], "cw38: with 100 legacy exhausted rows, a fresh failure is still retried");
        eq((db.prepare("SELECT COUNT(*) n FROM inbound_email_log WHERE forward_status = 'exhausted'").get() as any).n, 100, "cw39: …and the legacy rows are moved to the terminal status");
      }

      // ── review B3: an item is only recorded as alerted once the alert went out ──
      {
        const t1 = new Date(now.getTime() + 3 * 3600_000);
        // Isolate from the 100 legacy rows above (already handled in their own test):
        // one fresh exhausted forward is the forward this block follows.
        cw.recordAlerts((db.prepare("SELECT id FROM inbound_email_log WHERE forward_status = 'exhausted'").all() as Array<{ id: string }>).map((r) => `forward:${r.id}`), t1);
        db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, forward_status, forward_attempts, received_at) VALUES ('inb-b3-ex', 'b3-ex', 'f@x.no', 'B3 videresending', 'exhausted', 4, ?)`).run(hoursBefore(t1, 1));
        crm.crmService.ingestThread(
          { threadId: "wd-b3", subject: "Varsel må fram", category: "innkommende",
            messages: [{ messageId: "wd-b3-m", direction: "in", fromEmail: "kunde4@x.no", sentAt: hoursBefore(t1, 28) }] },
          "kunde4@x.no", "rfb");
        const refused = await cw.runCsWatchdog({ send: async () => ({ success: false, error: "relay down" }), now: t1, adminEmail: "admin@example.no", trigger: "manual" });
        eq(refused.alert_sent, false, "cw40: relay refuses the alert");
        ok(cw.alertDue("thread:wd-b3", t1) === true, "cw41: …so the item is NOT recorded as alerted");
        const got: any[] = [];
        const t2 = new Date(t1.getTime() + 3600_000);
        await cw.runCsWatchdog({ send: async (o: any) => { got.push(o); return { success: true }; }, now: t2, adminEmail: "admin@example.no", trigger: "manual" });
        ok(got.length === 1 && String(got[0].textContent).includes("Varsel må fram") && String(got[0].textContent).includes("B3 videresending"), "cw42: the next run alerts it");
        ok(cw.alertDue("thread:wd-b3", new Date(t2.getTime() + 3600_000)) === false, "cw43: …and records it after the accepted send");
        // exhausted forwards: alerted once, never again
        const fw = await cw.runCsWatchdog({ send: async (o: any) => { got.push(o); return { success: true }; }, now: new Date(t2.getTime() + 26 * 3600_000), adminEmail: "admin@example.no", trigger: "manual" });
        ok(!got.slice(1).some((o) => String(o.textContent).includes("Videresending feilet")), "cw44: an exhausted forward is alerted once, not every day");
        eq(fw.forward.exhausted.length, 0, "cw44b: nothing new exhausted");
      }

      // ── review #1/#2: tick overlap guard; a failed digest is retried, the watchdog cannot block it ──
      {
        const prevAdmin = process.env.ADMIN_NOTIFICATION_EMAIL;
        process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.no";
        try {
          let release: () => void = () => {};
          const gate = new Promise<void>((r) => { release = r; });
          crm.crmService.ingestThread(
            { threadId: "wd-slow", subject: "Treg relé", category: "innkommende",
              messages: [{ messageId: "wd-slow-m", direction: "in", fromEmail: "kunde5@x.no", sentAt: hoursBefore(new Date(), 40) }] },
            "kunde5@x.no", "rfb");
          const slowSend = async () => { await gate; return { success: true }; };
          const later = new Date(Date.now() + 2 * 3600_000); // past the 55-min gate of the earlier ticks
          const first = cw.tickCsWatchdog({ lastWatchdogAt: null, lastDigestAt: null }, { now: later, send: slowSend, env: { CS_WATCHDOG_ENABLED: "1" } as any });
          await new Promise((r) => setTimeout(r, 20));
          const second = await cw.tickCsWatchdog({ lastWatchdogAt: null, lastDigestAt: null }, { now: later, send: slowSend, env: { CS_WATCHDOG_ENABLED: "1" } as any });
          eq([second.skippedOverlap, second.ranWatchdog], [true, false], "cw45: a tick that starts while one is running is skipped (no double forward)");
          release();
          const f1 = await first;
          eq([f1.skippedOverlap, f1.ranWatchdog, cw.csTickInFlight()], [false, true, false], "cw46: the running tick completes and releases the guard");

          const dNow = new Date("2026-11-12T06:30:00Z"); // 07:30 Oslo
          let dCalls = 0;
          const failSend = async () => { dCalls++; return { success: false, error: "relay down" }; };
          const d1 = await cw.tickCsWatchdog({ lastWatchdogAt: dNow, lastDigestAt: null }, { now: dNow, send: failSend, env: { CS_DAILY_DIGEST_ENABLED: "1" } as any });
          eq([d1.ranDigest, d1.lastDigestAt, !!d1.lastDigestAttemptAt], [true, null, true], "cw47: a digest that did not get through is not marked as sent");
          const d2 = await cw.tickCsWatchdog(d1, { now: new Date(dNow.getTime() + 10 * 60_000), send: failSend, env: { CS_DAILY_DIGEST_ENABLED: "1" } as any });
          eq(d2.ranDigest, false, "cw48: …not retried every 10 min");
          const okSend = async () => { dCalls++; return { success: true }; };
          const d3 = await cw.tickCsWatchdog(d2, { now: new Date(dNow.getTime() + 60 * 60_000), send: okSend, env: { CS_DAILY_DIGEST_ENABLED: "1" } as any });
          ok(d3.ranDigest === true && d3.lastDigestAt !== null, "cw49: …but retried after an hour, and then recorded");
          // The watchdog run of cw45/cw46 was persisted at `later` (real time + 2 h),
          // so this clock must be at least 55 min past it, and at 07:30 Oslo on a
          // later day than the cw47-cw49 digest. A fixed date broke CI on
          // 2026-11-13 between 03:35Z and 04:30Z, when `later` fell within 55 min
          // of it and the watchdog was not due.
          const boomNow = new Date(later.getTime() + 3600_000);
          boomNow.setUTCHours(6, 30, 0, 0);
          if (boomNow.getTime() < later.getTime() + 3600_000) boomNow.setUTCDate(boomNow.getUTCDate() + 1);
          const boom = await cw.tickCsWatchdog(
            { lastWatchdogAt: null, lastDigestAt: null },
            { now: boomNow, send: okSend, env: { CS_WATCHDOG_ENABLED: "1", CS_DAILY_DIGEST_ENABLED: "1" } as any, extraItems: () => { throw new Error("boom"); } },
          );
          eq([boom.ranWatchdog, boom.ranDigest], [true, true], "cw50: a watchdog that throws does not stop the digest");
          ok(!!db.prepare("SELECT 1 FROM runs WHERE agent = 'cs-watchdog' AND status = 'failed' AND errors LIKE '%boom%'").get(), "cw51: …and the failed watchdog run is in the ledger");
          const p1 = await cw.tickCsWatchdog({ lastWatchdogAt: null, lastDigestAt: null, lastPurgeAt: null }, { now: T0, env: {} as any });
          const p2 = await cw.tickCsWatchdog(p1, { now: new Date(T0.getTime() + 3600_000), env: {} as any });
          eq([p1.ranPurge, p2.ranPurge], [true, false], "cw52: with both flags off the log is still purged, once a day");

          // cw53-cw56 (second review)
          // Ages come from SQL 'now' (real time): the threads are 30 h old for real;
          // the run clock is days ahead so no earlier alert is still inside its 24 h.
          const big = new Date(Date.now() + 5 * 86400_000);
          for (let i = 0; i < 45; i++) {
            crm.crmService.ingestThread(
              { threadId: `wd-bk-${i}`, subject: `Backlog ${i}`, category: "innkommende",
                messages: [{ messageId: `wd-bk-${i}-m`, direction: "in", fromEmail: `bk${i}@x.no`, sentAt: new Date(Date.now() - 30 * 3600_000).toISOString() }] },
              `bk${i}@x.no`, "rfb");
          }
          db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, forward_status, forward_attempts, received_at) VALUES ('inb-n1-ex', 'n1-ex', 'f@x.no', 'Tapt videresending', 'exhausted', 4, ?)`).run(new Date(big.getTime() - 3600_000).toISOString());
          db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, crm_status, crm_error, received_at) VALUES ('inb-n1-reg', 'n1-reg', 'f@x.no', 'Ikke registrert', 'error', 'boom', ?)`).run(new Date(big.getTime() - 3600_000).toISOString());
          const n1: any[] = [];
          await cw.runCsWatchdog({ send: async (o: any) => { n1.push(o); return { success: true }; }, now: big, adminEmail: "admin@example.no", trigger: "manual" });
          const n1text = String(n1[0]?.textContent ?? "");
          ok(n1text.includes("Tapt videresending") && n1text.includes("Ikke registrert"), "cw53: with 45 overdue threads, the exhausted forward and the registration error are still itemized");
          const notShown = Array.from({ length: 45 }, (_, i) => `thread:wd-bk-${i}`).filter((k) => cw.alertDue(k, big));
          ok(notShown.length > 0 && n1text.includes("kommer i neste varsel"), "cw54: items beyond the 40 shown stay due for the next alert");
          db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, forward_status, received_at) VALUES ('inb-pend', 'pend', 'f@x.no', 'Henger i pending', 'pending', ?)`).run(new Date(big.getTime() - 2 * 3600_000).toISOString());
          const n2: any[] = [];
          await cw.runCsWatchdog({ send: async (o: any) => { n2.push(o); return { success: true }; }, now: new Date(big.getTime() + 60_000), adminEmail: "admin@example.no", trigger: "manual" });
          ok(String(n2[0]?.textContent ?? "").includes("Videresending uavklart"), "cw55: a forward stuck in pending is alerted");
          for (let i = 0; i < 101; i++) db.prepare(`INSERT INTO inbound_email_log (id, email_id, from_email, subject, forward_status, received_at) VALUES (?, ?, 'f@x.no', ?, 'pending', ?)`).run(`inb-pq-${String(i).padStart(3, "0")}`, `pq-${i}`, `Pending ${i}`, new Date(big.getTime() - (3 + i / 100) * 3600_000).toISOString());
          cw.recordAlerts(Array.from({ length: 100 }, (_, i) => `forward-pending:inb-pq-${String(100 - i).padStart(3, "0")}`), big);
          const n3: any[] = [];
          await cw.runCsWatchdog({ send: async (o: any) => { n3.push(o); return { success: true }; }, now: new Date(big.getTime() + 120_000), adminEmail: "admin@example.no", trigger: "manual" });
          ok(String(n3[0]?.textContent ?? "").includes("Pending 0"), "cw57: already-alerted pending forwards do not take the slots of a new one");
          const dA = await cw.runCsDailyDigest({ send: async () => ({ success: false }), now: new Date("2026-11-21T06:30:00Z"), adminEmail: "admin@example.no", trigger: "manual" });
          const dB = await cw.runCsDailyDigest({ send: async () => ({ success: true }), now: new Date("2026-11-21T07:30:00Z"), adminEmail: "admin@example.no", trigger: "manual" });
          eq([dA.run_id !== dB.run_id, (db.prepare("SELECT status FROM runs WHERE run_id = ?").get(dB.run_id) as any)?.status], [true, "completed"], "cw56: a successful digest retry gets its own ledger row");
        } finally {
          if (prevAdmin === undefined) delete process.env.ADMIN_NOTIFICATION_EMAIL;
          else process.env.ADMIN_NOTIFICATION_EMAIL = prevAdmin;
        }
      }
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
