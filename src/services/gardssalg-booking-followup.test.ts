/**
 * gardssalg-booking-followup.test.ts — O1-1 (audit findings R1 and R11).
 *
 * Covers:
 *   (s) AK1: scheduleBookingFollowupsJob() runs the job once 5 min after boot
 *       (fake timers), without waiting a whole hourly interval.
 *   (c) pure clock rules: the clock starts at notify_sent_at, never before
 *       the floor; no registered notification = never due.
 *   (n) AK2: a row with no registered producer notification is never
 *       reminded and never expired, even years overdue; a registered row is
 *       reminded at +24 h and expired at +60 h from notify_sent_at.
 *   (g) B1: a legacy row (created before the floor, every notify_* NULL) is
 *       reminded/expired counting from the floor, never before it.
 *   (r) a failed producer e-mail is stamped, alerts the admin, and is re-sent
 *       exactly once by the job; a failed re-send alerts again and stops.
 *   (k) the retry claim: taken elsewhere -> no send; state changed -> no
 *       claim; gate off -> claim released and retried later; past slot -> skipped.
 *   (l) a producer without an address: "not_live" (send outcome and the
 *       POST /book response), admin alerted, the row never followed up —
 *       also when created before the floor (not legacy, never re-sent).
 *   (a) AK3: GET /admin/booking-followups/dry-run — 403 without the admin
 *       key, 200 with { would_remind, would_expire } matching the job.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/gardssalg-booking-followup.test.ts
 *   2. Wired into the gate: tests/test.ts imports runGardssalgBookingFollowupTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(
  router: any,
  method: "GET" | "POST",
  url: string,
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method, url, originalUrl: url, path: url, query: {}, ip: "127.0.0.1",
      headers: opts.headers || {}, body: opts.body,
      get(name: string) { return (opts.headers || {})[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      setHeader() { /* noop */ },
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: err ? 500 : 404, body: { error: String(err ?? "not handled") } });
    });
  });
}

function osloNakedDaysAhead(days: number, hhmm: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now() + days * 24 * 3600_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${hhmm}`;
}

const H = 3600_000;

export function runGardssalgBookingFollowupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = [
      "EXPERIENCES_DB_PATH", "ADMIN_KEY", "BOOKING_DISPATCH_ENABLED",
      "BOOKING_FOLLOWUP_CLOCK_FLOOR", "BOOKING_PREVISIT_REMINDER_HOURS", "BOOKING_PREVISIT_EXPIRE_HOURS",
    ];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    const testKey = process.env.ADMIN_KEY || "gardssalg-booking-followup-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.BOOKING_FOLLOWUP_CLOCK_FLOOR;
    delete process.env.BOOKING_PREVISIT_REMINDER_HOURS;
    delete process.env.BOOKING_PREVISIT_EXPIRE_HOURS;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-booking-gate"),
      require.resolve("./gardssalg-booking-resolve"),
      require.resolve("../routes/opplevelser"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const emailMod = require("./email-service") as typeof import("./email-service");
    const emailSvc = emailMod.emailService as any;
    const origSend = emailSvc.sendEmail;
    let followup: typeof import("./gardssalg-booking-followup") | null = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }

      followup = require("./gardssalg-booking-followup") as typeof import("./gardssalg-booking-followup");
      const fu = followup;

      // ── (s) AK1: scheduling ─────────────────────────────────────────────
      {
        const timeouts: Array<{ fn: () => void; ms: number }> = [];
        const intervals: Array<{ fn: () => void; ms: number }> = [];
        let ticks = 0;
        fu.scheduleBookingFollowupsJob(() => { ticks++; }, {
          timers: {
            setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 0; },
            setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 0; },
          },
          log: () => { /* quiet */ },
        });
        assertEq(timeouts.length, 1, "s1: one first-run timer is registered at boot");
        assertEq(timeouts[0]?.ms, 5 * 60_000, "s2: the first run is 5 minutes after boot");
        assertEq(intervals.length, 1, "s3: the hourly interval is still registered");
        assertEq(intervals[0]?.ms, 60 * 60_000, "s4: interval stays 60 minutes");
        assertEq(ticks, 0, "s5: nothing runs synchronously at boot");
        timeouts[0]?.fn();
        assertEq(ticks, 1, "s6: the job runs when the 5-minute timer fires, before any interval elapsed");
        intervals[0]?.fn();
        assertEq(ticks, 2, "s7: and again on each interval");
      }

      // ── (c) pure clock rules ────────────────────────────────────────────
      const floorMs = Date.parse(fu.FOLLOWUP_CLOCK_FLOOR);
      assertEq(fu.followupClockStartMs(null), NaN, "c1: no registered notification -> no clock");
      assertEq(fu.followupClockStartMs("2026-10-01T10:00:00.000Z"), floorMs, "c2: a notification before the floor starts at the floor");
      assertEq(fu.followupClockStartMs("2026-12-01 10:00:00"), Date.parse("2026-12-01T10:00:00Z"), "c3: SQLite UTC stamps are read as UTC");
      const baseRow = {
        status: "reserved", pre_status: "awaiting_provider", respond_token: "t",
        respond_token_expires_at: null, reminder_sent_at: null, notify_sent_at: null,
      };
      assertEq(fu.previsitReminderDue(baseRow, Date.parse("2099-01-01T00:00:00Z"), 24), false, "c4: unregistered row never due for a reminder");
      assertEq(fu.awaitingExpiryDueMs(baseRow, 60), NaN, "c5: unregistered row never due for expiry");
      const oldRow = { ...baseRow, notify_sent_at: "2026-09-01T00:00:00Z", respond_token_expires_at: "2026-09-03T12:00:00Z" };
      assertEq(fu.awaitingExpiryDueMs(oldRow, 60), floorMs + 60 * H, "c6: an old row expires 60 h after the floor, not in a back-dated batch");
      // B1: a legacy row (created before the floor, every notify_* NULL) starts at the floor.
      const legacyRow = { ...baseRow, created_at: "2026-10-20T08:00:00.000Z", respond_token_expires_at: "2026-10-22T20:00:00.000Z" };
      assertEq(fu.isLegacyPreFloorRow(legacyRow), true, "c9: pre-floor row with all notify_* NULL is legacy");
      assertEq(fu.awaitingExpiryDueMs(legacyRow, 60), floorMs + 60 * H, "c10: a legacy row expires 60 h after the floor");
      assertEq(fu.previsitReminderDue(legacyRow, floorMs + 23 * H, 24), false, "c11: legacy row not reminded before floor + 24 h");
      assertEq(fu.previsitReminderDue(legacyRow, floorMs + 24 * H, 24), true, "c12: legacy row reminded at floor + 24 h");
      assertEq(fu.isLegacyPreFloorRow({ ...legacyRow, notify_failed_at: "2026-10-20T08:00:01.000Z" }), false, "c13: a recorded failure is not legacy");
      assertEq(fu.isLegacyPreFloorRow({ ...legacyRow, created_at: fu.FOLLOWUP_CLOCK_FLOOR }), false, "c14: a row created at the floor is not legacy");
      assertEq(fu.awaitingExpiryDueMs({ ...legacyRow, created_at: "2026-11-17T08:00:00.000Z" }, 60), NaN, "c15: post-floor unregistered row still never expires");
      assertEq(fu.producerNotifyAddressStatus(" "), "not_live", "c7: blank address -> not_live");
      assertEq(fu.producerNotifyAddressStatus("post@gard.no"), "queued", "c8: an address -> queued");

      // From here the floor is pinned in the past so "now"-based fixtures work.
      process.env.BOOKING_FOLLOWUP_CLOCK_FLOOR = "2020-01-01T00:00:00Z";

      // ── DB fixtures ─────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const bookingStore = require("./booking-store") as typeof import("./booking-store");
      const opplevelserRouter = (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence)
         VALUES (@id, @navn, 'experiences', 'Vestland', 'Voss', 'sideri', @epost, 1, 0,
            @id, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({ id: "fu-live", navn: "Sideri Med Adresse", epost: "post@sideri.no" });
      insertProvider.run({ id: "fu-noaddr", navn: "Sideri Uten Adresse", epost: null });

      const alerts: Array<{ subject: string; text: string }> = [];
      fu.__setBookingNotifyAlertForTesting(async (subject, text) => { alerts.push({ subject, text }); return true; });
      const sends: Array<{ to: string; subject: string }> = [];
      let failNext = 0;
      emailSvc.sendEmail = async (o: { to: string; subject: string }) => {
        sends.push({ to: o.to, subject: o.subject });
        if (failNext > 0) { failNext--; return { success: false, error: "smtp 451 test" }; }
        return { success: true, messageId: "stub" };
      };

      const slot = osloNakedDaysAhead(7, "13:00");
      const mk = (provider_id: string, email: string) => bookingStore.createBooking({
        provider_id, slot_at: slot, party_size: 2, guest_name: "Gjest", guest_email: email,
      });
      const row = (id: string) => bookingStore.getBookingByRef(id);

      // ── (n) AK2: no registered notification -> never reminded/expired ──
      const unreg = mk("fu-live", "uten-varsel@example.no");
      const t0 = Date.parse(unreg.created_at);
      let r = await bookingStore.processBookingFollowups(new Date(t0 + 25 * H));
      assertEq(r.reminders_sent, 0, "n1: no reminder at +25 h without a registered notification");
      r = await bookingStore.processBookingFollowups(new Date(t0 + 24 * 365 * H));
      assertEq(r.expired, 0, "n2: no expiry even a year later without a registered notification");
      assertEq(row(unreg.booking_ref)?.pre_status, "awaiting_provider", "n3: the row stays awaiting_provider");
      assertEq(row(unreg.booking_ref)?.reminder_sent_at, null, "n4: reminder_sent_at never stamped");
      assertTrue(!sends.some((s) => s.to === "uten-varsel@example.no"), "n5: the guest got no expiry e-mail");

      // Registered: the first send succeeds -> notify_sent_at.
      const reg = mk("fu-live", "med-varsel@example.no");
      assertEq(await bookingStore.sendProducerNotification(reg, "post@sideri.no"), "sent", "n6: first producer send -> sent");
      const regRow = row(reg.booking_ref)!;
      assertTrue(!!regRow.notify_sent_at, "n7: notify_sent_at stamped");
      const tn = Date.parse(regRow.notify_sent_at!);
      const dry0 = bookingStore.countBookingFollowupsDue(new Date(tn + 25 * H));
      assertEq([dry0.would_remind, dry0.would_expire], [1, 0], "n8: dry-run at +25 h: one reminder, no expiry");
      assertEq(dry0.without_registered_notification, 1, "n9: dry-run reports the unregistered row separately");
      r = await bookingStore.processBookingFollowups(new Date(tn + 25 * H));
      assertEq(r.reminders_sent, 1, "n10: reminded 24 h after the registered notification");
      const dry1 = bookingStore.countBookingFollowupsDue(new Date(tn + 61 * H));
      assertEq([dry1.would_remind, dry1.would_expire], [0, 1], "n11: dry-run at +61 h: one expiry");
      r = await bookingStore.processBookingFollowups(new Date(tn + 61 * H));
      assertEq(r.expired, 1, "n12: expired 60 h after the registered notification");
      assertEq(row(reg.booking_ref)?.pre_status, "expired", "n13: pre_status -> expired");
      assertEq(row(unreg.booking_ref)?.pre_status, "awaiting_provider", "n14: the unregistered row is still untouched");

      // ── (g) B1: legacy row (pre-floor, notify_* all NULL) counts from the floor ──
      // The floor is pinned at 2020-01-01 here; the row is back-dated to before it,
      // WITHOUT notify_sent_at, with the respond deadline it got at creation.
      const pinnedFloorMs = Date.parse("2020-01-01T00:00:00Z");
      const legacy = mk("fu-live", "legacy@example.no");
      expDb.prepare("UPDATE gardssalg_bookings SET created_at = ?, respond_token_expires_at = ? WHERE booking_id = ?")
        .run("2019-12-01T10:00:00.000Z", "2019-12-03T22:00:00.000Z", legacy.booking_id);
      assertEq(row(legacy.booking_ref)?.notify_sent_at, null, "g1: the legacy row has no notify_sent_at");
      const dryG = bookingStore.countBookingFollowupsDue(new Date(pinnedFloorMs + 23 * H));
      assertEq(dryG.legacy_counted_from_floor, 1, "g2: dry-run counts the legacy row separately");
      assertEq(dryG.without_registered_notification, 1, "g3: without_registered_notification counts only the post-floor row");
      assertEq([dryG.would_remind, dryG.would_expire], [0, 0], "g4: dry-run at floor + 23 h: nothing due yet");
      sends.length = 0;
      r = await bookingStore.processBookingFollowups(new Date(pinnedFloorMs + 23 * H));
      assertEq([r.reminders_sent, r.expired], [0, 0], "g5: not reminded at floor + 23 h although created_at + 24 h passed long ago");
      assertEq(bookingStore.countBookingFollowupsDue(new Date(pinnedFloorMs + 25 * H)).would_remind, 1, "g6: dry-run at floor + 25 h: one reminder");
      r = await bookingStore.processBookingFollowups(new Date(pinnedFloorMs + 25 * H));
      assertEq(r.reminders_sent, 1, "g7: reminded 24 h after the floor");
      assertTrue(!!row(legacy.booking_ref)?.reminder_sent_at, "g8: reminder_sent_at stamped");
      r = await bookingStore.processBookingFollowups(new Date(pinnedFloorMs + 59 * H));
      assertEq(r.expired, 0, "g9: not expired at floor + 59 h (the stale creation deadline is ignored)");
      assertEq(bookingStore.countBookingFollowupsDue(new Date(pinnedFloorMs + 61 * H)).would_expire, 1, "g10: dry-run at floor + 61 h: one expiry");
      r = await bookingStore.processBookingFollowups(new Date(pinnedFloorMs + 61 * H));
      assertEq(r.expired, 1, "g11: expired 60 h after the floor");
      assertEq(row(legacy.booking_ref)?.pre_status, "expired", "g12: legacy row -> expired");
      assertEq(row(unreg.booking_ref)?.pre_status, "awaiting_provider", "g13: the post-floor unregistered row is still untouched");

      // ── (r) failed producer e-mail: alert + exactly one retry ──────────
      alerts.length = 0;
      const fail1 = mk("fu-live", "feil@example.no");
      failNext = 1;
      assertEq(await bookingStore.sendProducerNotification(fail1, "post@sideri.no"), "failed", "r1: a { success:false } send -> failed");
      let f1 = row(fail1.booking_ref)!;
      assertTrue(!!f1.notify_failed_at, "r2: notify_failed_at stamped");
      assertEq(f1.notify_sent_at, null, "r3: notify_sent_at stays NULL");
      assertEq(alerts.length, 1, "r4: the admin is alerted once");
      assertTrue(/feilet/.test(alerts[0]?.subject ?? "") && /prøver én gang til/.test(alerts[0]?.text ?? ""), "r5: the alert says it will retry once");
      sends.length = 0;
      const tRetry = new Date(Date.parse(f1.created_at) + 2 * H);
      r = await bookingStore.processBookingFollowups(tRetry);
      assertEq(r.producer_notify_retried, 1, "r6: the job re-sends once");
      assertEq(sends.filter((s) => s.to === "post@sideri.no" && /Ny reservasjon/.test(s.subject)).length, 1, "r7: the producer e-mail went out again");
      f1 = row(fail1.booking_ref)!;
      assertTrue(!!f1.notify_sent_at && !!f1.notify_retried_at, "r8: notify_sent_at + notify_retried_at stamped after a good retry");
      assertEq(Date.parse(f1.respond_token_expires_at!), tRetry.getTime() + 60 * H, "r9: the deadline in the re-sent e-mail counts from the retry");
      r = await bookingStore.processBookingFollowups(new Date(tRetry.getTime() + H));
      assertEq(r.producer_notify_retried, 0, "r10: never retried a second time");

      alerts.length = 0;
      const fail2 = mk("fu-live", "feil2@example.no");
      failNext = 1;
      await bookingStore.sendProducerNotification(fail2, "post@sideri.no");
      failNext = 1;
      r = await bookingStore.processBookingFollowups(new Date(Date.parse(fail2.created_at) + 2 * H));
      assertEq(r.producer_notify_retried, 1, "r11: the retry is attempted");
      assertEq(alerts.length, 2, "r12: a failed retry alerts the admin again");
      assertTrue(/nytt forsøk/.test(alerts[1]?.subject ?? "") && /Ingen flere forsøk/.test(alerts[1]?.text ?? ""), "r13: the second alert says no more attempts");
      r = await bookingStore.processBookingFollowups(new Date(Date.parse(fail2.created_at) + 3 * H));
      assertEq(r.producer_notify_retried, 0, "r14: no third attempt");
      r = await bookingStore.processBookingFollowups(new Date(Date.parse(fail2.created_at) + 100 * H));
      assertEq(row(fail2.booking_ref)?.pre_status, "awaiting_provider", "r15: a never-delivered request is never expired as «not answered»");

      // Thrown transport errors count as failures too.
      alerts.length = 0;
      const fail3 = mk("fu-live", "feil3@example.no");
      const okSend = emailSvc.sendEmail;
      emailSvc.sendEmail = async () => { throw new Error("connection reset"); };
      assertEq(await bookingStore.sendProducerNotification(fail3, "post@sideri.no"), "failed", "r16: a thrown send -> failed (never rethrown)");
      emailSvc.sendEmail = okSend;
      assertTrue(!!row(fail3.booking_ref)?.notify_failed_at && alerts.length === 1, "r17: stamped and alerted");

      // ── (k) N1/N2: retry claim lock, gate release, state re-check, past slot ──
      const tickAt = () => new Date(Date.now() + 2 * H);
      r = await bookingStore.processBookingFollowups(tickAt()); // drain fail3's retry
      assertEq(r.producer_notify_retried, 1, "k0: fail3 retried (drain)");
      const producerSends = () => sends.filter((s) => s.to === "post@sideri.no" && /Ny reservasjon/.test(s.subject)).length;
      const failFirst = async (email: string) => {
        const b = mk("fu-live", email);
        failNext = 1;
        await bookingStore.sendProducerNotification(b, "post@sideri.no");
        return b;
      };
      // Run one tick with a hook that mutates the row between the retry SELECT and the claim.
      const withHook = async (mutate: () => void) => {
        const origPrepare = expDb.prepare;
        (expDb as any).prepare = function (sql: string) {
          const st = origPrepare.call(expDb, sql);
          if (/^\s*SELECT[\s\S]*notify_failed_at IS NOT NULL AND notify_retried_at IS NULL/.test(sql)) {
            return { all: (...a: unknown[]) => { const rows = (st as any).all(...a); mutate(); return rows; } };
          }
          return st;
        };
        try { return await bookingStore.processBookingFollowups(tickAt()); }
        finally { (expDb as any).prepare = origPrepare; }
      };

      // k1-k3: claim already taken by another worker -> no send.
      const taken = await failFirst("tatt@example.no");
      sends.length = 0;
      r = await withHook(() => {
        expDb.prepare("UPDATE gardssalg_bookings SET notify_retried_at = ? WHERE booking_id = ?")
          .run("2000-01-01T00:00:00.000Z", taken.booking_id);
      });
      assertEq(r.producer_notify_retried, 0, "k1: claim taken elsewhere -> not counted as retried");
      assertEq(producerSends(), 0, "k2: claim taken elsewhere -> no producer send");
      assertEq(row(taken.booking_ref)?.notify_retried_at, "2000-01-01T00:00:00.000Z", "k3: the other worker's claim is left as it was");

      // k4-k5 (N2): state changed between SELECT and claim -> the claim refuses.
      const answered = await failFirst("besvart@example.no");
      sends.length = 0;
      r = await withHook(() => {
        expDb.prepare("UPDATE gardssalg_bookings SET pre_status = 'confirmed' WHERE booking_id = ?").run(answered.booking_id);
      });
      assertEq([r.producer_notify_retried, producerSends()], [0, 0], "k4: a row answered meanwhile is not re-sent");
      assertEq(row(answered.booking_ref)?.notify_retried_at, null, "k5: and not claimed");

      // k6-k9: dispatch gate off -> claim released; retried on the next tick with the gate on.
      const gated = await failFirst("port@example.no");
      sends.length = 0;
      expDb.prepare("UPDATE experience_providers SET booking_live = 0 WHERE id = 'fu-live'").run();
      r = await bookingStore.processBookingFollowups(tickAt());
      assertEq([r.producer_notify_retried, producerSends()], [0, 0], "k6: gate off -> no retry send");
      assertEq(row(gated.booking_ref)?.notify_retried_at, null, "k7: gate off -> claim released");
      expDb.prepare("UPDATE experience_providers SET booking_live = 1 WHERE id = 'fu-live'").run();
      r = await bookingStore.processBookingFollowups(tickAt());
      assertEq([r.producer_notify_retried, producerSends()], [1, 1], "k8: gate on -> retried on the next tick");
      assertTrue(!!row(gated.booking_ref)?.notify_sent_at, "k9: and registered");

      // k10-k12 (N2): visit time already passed -> not re-sent, not claimed.
      const past = await failFirst("passert@example.no");
      expDb.prepare("UPDATE gardssalg_bookings SET slot_at = ? WHERE booking_id = ?")
        .run(new Date(Date.now() - H).toISOString(), past.booking_id);
      sends.length = 0;
      r = await bookingStore.processBookingFollowups(tickAt());
      assertEq(r.producer_notify_retried, 0, "k10: past slot -> no retry");
      assertEq(producerSends(), 0, "k11: past slot -> no producer send");
      assertEq(row(past.booking_ref)?.notify_retried_at, null, "k12: past slot -> not claimed");

      // ── (l) producer without an address ─────────────────────────────────
      alerts.length = 0;
      const noAddr = mk("fu-noaddr", "ingen-adresse@example.no");
      assertEq(await bookingStore.sendProducerNotification(noAddr, null), "not_live", "l1: no address -> not_live");
      assertEq(row(noAddr.booking_ref)?.notify_sent_at, null, "l2: nothing registered");
      assertEq(row(noAddr.booking_ref)?.notify_failed_at, null, "l3: not a failure either, so no retry");
      assertEq(alerts.length, 1, "l4: the admin is alerted");
      assertTrue(/ingen e-postadresse/.test(alerts[0]?.subject ?? ""), "l5: the alert names the missing address");
      assertTrue(!!row(noAddr.booking_ref)?.notify_retried_at, "l5b: not_live stamps notify_retried_at (no further send attempt)");

      // l-pre (round-2 B1): a not_live row created BEFORE the floor is not
      // legacy — never reminded, never expired, never re-sent.
      const preNoAddr = mk("fu-noaddr", "pre-ingen-adresse@example.no");
      assertEq(await bookingStore.sendProducerNotification(preNoAddr, null), "not_live", "lp1: pre-floor no address -> not_live");
      expDb.prepare("UPDATE gardssalg_bookings SET created_at = ?, respond_token_expires_at = ? WHERE booking_id = ?")
        .run("2019-12-01T10:00:00.000Z", "2019-12-03T22:00:00.000Z", preNoAddr.booking_id);
      const preRow = row(preNoAddr.booking_ref)!;
      assertEq(fu.isLegacyPreFloorRow(preRow), false, "lp2: a pre-floor not_live row is not legacy");
      const dryP = bookingStore.countBookingFollowupsDue(new Date(pinnedFloorMs + 25 * H));
      assertEq(dryP.legacy_counted_from_floor, 0, "lp3: dry-run does not count it as legacy");
      assertEq([dryP.would_remind, dryP.would_expire], [0, 0], "lp4: dry-run at floor + 25 h: nothing due");
      assertEq(bookingStore.countBookingFollowupsDue(new Date(Date.now() + 365 * 24 * H)).legacy_counted_from_floor, 0, "lp5: nor a year on");
      const preRetriedAt = preRow.notify_retried_at;
      sends.length = 0;
      r = await bookingStore.processBookingFollowups(new Date(Date.now() + 2 * H));
      assertEq(r.producer_notify_retried, 0, "lp6: the re-send path does not pick the not_live row");
      assertEq(row(preNoAddr.booking_ref)?.notify_retried_at, preRetriedAt, "lp7: notify_retried_at unchanged by the job");
      await bookingStore.processBookingFollowups(new Date(Date.now() + 365 * 24 * H));
      const preAfter = row(preNoAddr.booking_ref)!;
      assertEq(preAfter.pre_status, "awaiting_provider", "lp8: never expired, even a year on");
      assertEq(preAfter.reminder_sent_at, null, "lp9: never reminded");
      assertTrue(!sends.some((s) => s.to === "pre-ingen-adresse@example.no"), "lp10: the guest got no expiry e-mail");

      const bookLayer = (opplevelserRouter.stack as any[]).find((l: any) => l.route?.path === "/book" && l.route.methods?.post);
      const callBook = async (provider_id: string, guest_email: string): Promise<any> => {
        let body: any = null; let status = 200;
        const res: any = {
          status: (c: number) => { status = c; return res; },
          json: (o: unknown) => { body = o; return res; },
          setHeader: () => { /* noop */ },
        };
        const handlers = (bookLayer.route.stack as any[]).filter((s: any) => s.method === "post");
        await handlers[handlers.length - 1].handle(
          { body: { provider_id, slot_at: slot, party_size: 2, guest_name: "Gjest", guest_email }, params: {}, query: {}, headers: {}, ip: "127.0.0.1" },
          res, () => { /* noop */ },
        );
        await new Promise((resolve) => setImmediate(resolve));
        return { status, body };
      };
      const bookNoAddr = await callBook("fu-noaddr", "rest-ingen@example.no");
      assertEq(bookNoAddr.status, 201, "l6: POST /book still registers the request");
      assertEq(bookNoAddr.body?.producer_notification, { status: "not_live" }, "l7: POST /book reports producer_notification.status not_live");
      const bookLive = await callBook("fu-live", "rest-live@example.no");
      assertEq(bookLive.body?.producer_notification, { status: "queued" }, "l8: a producer with an address -> queued");
      assertTrue(!!row(bookLive.body?.booking_ref)?.notify_sent_at, "l9: the route's fire-and-forget send registers notify_sent_at");

      // ── (a) AK3: admin dry-run endpoint ─────────────────────────────────
      const url = "/admin/booking-followups/dry-run";
      const noKey = await callRoute(opplevelserRouter, "GET", url);
      assertEq(noKey.status, 403, "a1: no X-Admin-Key -> 403");
      assertTrue(noKey.body?.would_remind === undefined, "a2: no payload without the key");
      const badKey = await callRoute(opplevelserRouter, "GET", url, { headers: { "x-admin-key": "wrong" } });
      assertEq(badKey.status, 403, "a3: wrong key -> 403");
      const before = expDb.prepare("SELECT COUNT(*) AS n, SUM(reminder_sent_at IS NOT NULL) AS rem FROM gardssalg_bookings").get();
      const ok = await callRoute(opplevelserRouter, "GET", url, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "a4: admin key -> 200");
      assertTrue(typeof ok.body?.would_remind === "number" && typeof ok.body?.would_expire === "number", "a5: carries would_remind and would_expire");
      const expected = bookingStore.countBookingFollowupsDue();
      assertEq([ok.body.would_remind, ok.body.would_expire], [expected.would_remind, expected.would_expire], "a6: same numbers as the shared count");
      const after = expDb.prepare("SELECT COUNT(*) AS n, SUM(reminder_sent_at IS NOT NULL) AS rem FROM gardssalg_bookings").get();
      assertEq(after, before, "a7: read-only — nothing stamped");
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
      try { followup?.__setBookingNotifyAlertForTesting(null); } catch { /* best-effort */ }
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgBookingFollowupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
