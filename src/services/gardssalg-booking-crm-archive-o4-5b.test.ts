/**
 * gardssalg-booking-crm-archive-o4-5b.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o4-epost-og-tekster, slice O4-5b: the booking e-mails sent TO
 * THE PRODUCER are filed as outbound crm_messages in one CRM thread per
 * booking (`gardssalg-booking-<bookingId>`, vertical 'experiences'), behind
 * GARDSSALG_BOOKING_CRM_ARCHIVE_ENABLED (exactly "true", default off).
 *
 *   AK-a  flag off: sending the producer mails creates no crm_threads /
 *         crm_messages / crm_contacts rows; the mail is byte-identical with
 *         the flag on and off.
 *   AK-b  flag on: one outbound crm_messages row in the booking's thread per
 *         producer mail the mailer accepted (new request, reminder, the
 *         guest's answer, the guest's cancellation), subject / text / HTML as
 *         sent; none for guest mails; none for a failed or throwing send;
 *         none for a test booking; an identical re-send is not filed twice;
 *         no outreach_sent_log row; the thread reads back through
 *         crmService.getThreadDetail (GET /admin/crm/threads/:id).
 *   AK-c  a throw inside the CRM write changes neither the send nor the
 *         return value nor the booking's notify stamp.
 *
 * Fixtures: in-memory main and experiences databases, a test producer,
 * example.no addresses; every e-mail send is stubbed. No real data is touched.
 *
 * Exported runGardssalgBookingCrmArchiveO45bTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone:
 *   npx tsx src/services/gardssalg-booking-crm-archive-o4-5b.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const FLAG = "GARDSSALG_BOOKING_CRM_ARCHIVE_ENABLED";
const H = 3600_000;
const PRODUCER = "gard-o45b@example.no";

export function runGardssalgBookingCrmArchiveO45bTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertEq(!!cond, true, label);
  }

  return (async () => {
    const envKeys = [
      "EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "BOOKING_FOLLOWUP_CLOCK_FLOOR",
      "GARDSSALG_HONEST_RECEIPT_ENABLED", "GARDSSALG_EMAIL_EN_ENABLED", "GARDSSALG_NOTIFY_ADDRESS_ENABLED", FLAG,
    ];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    process.env.BOOKING_FOLLOWUP_CLOCK_FLOOR = "2020-01-01T00:00:00Z";
    for (const k of ["GARDSSALG_HONEST_RECEIPT_ENABLED", "GARDSSALG_EMAIL_EN_ENABLED", "GARDSSALG_NOTIFY_ADDRESS_ENABLED", FLAG]) {
      delete process.env[k];
    }

    const initMod = require("../database/init") as typeof import("../database/init");
    const unpinMainDb = initMod.__pinInMemoryDbForTesting();

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-honest-receipt"),
      require.resolve("./gardssalg-notify-address"),
      require.resolve("./gardssalg-cancel"),
      require.resolve("./crm-service"),
      require.resolve("./gardssalg-booking-crm-archive"),
    ]);

    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    type Mail = { to: string; subject: string; text: string; html: string; replyTo?: string; from: string; isTestSend: boolean };
    const sent: Mail[] = [];
    let nextSend: "ok" | "fail" | "throw" = "ok";
    emailSvc.sendEmail = async (o: any) => {
      const mode = nextSend;
      nextSend = "ok";
      if (mode === "throw") throw new Error("mailer exploded (test)");
      if (mode === "fail") return { success: false, error: "smtp 451 test" };
      sent.push({
        to: o.to, subject: o.subject, text: o.textContent, html: o.htmlContent,
        replyTo: o.replyTo, from: String(o.from || ""), isTestSend: !!o.isTestSend,
      });
      return { success: true, messageId: `<stub-${sent.length}@o45b.example.test>` };
    };

    const crm = (require("./crm-service") as typeof import("./crm-service")).crmService as any;
    const origRecordOutboundReply = crm.recordOutboundReply;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const mainDb = initMod.getDb();
      const bs = require("./booking-store") as typeof import("./booking-store");
      const cancel = require("./gardssalg-cancel") as typeof import("./gardssalg-cancel");
      const archive = require("./gardssalg-booking-crm-archive") as typeof import("./gardssalg-booking-crm-archive");

      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence, adresse, postnummer, poststed)
         VALUES ('o45b-p', 'Testsideri O45b', 'experiences', 'Vestland', 'Voss', 'sideri', ?, 1, 0,
            'o45b-p', 'raw', 'pending_verify', 'test-fixture', 'medium', 'Gardsvegen 1', '5700', 'Voss')`,
      ).run(PRODUCER);

      const SLOT = Date.now() + 30 * 24 * H;
      const mk = (email: string, opt: { isTest?: boolean } = {}) =>
        bs.createBooking(
          { provider_id: "o45b-p", slot_at: new Date(SLOT).toISOString(), party_size: 2, guest_name: "Kari", guest_email: email },
          "opplevagent",
          { isTest: opt.isTest },
        );
      const count = (table: string) => (mainDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const crmCounts = () => [count("crm_contacts"), count("crm_threads"), count("crm_messages")];
      const msgsOf = (bookingId: string) =>
        mainDb.prepare(
          "SELECT id, direction, to_emails, subject, body_text, body_html, delivery_status, vertical_id, raw_metadata FROM crm_messages WHERE thread_id = ? ORDER BY rowid",
        ).all(archive.gardssalgBookingCrmThreadId(bookingId)) as Array<Record<string, any>>;
      const last = () => sent[sent.length - 1];
      const notifyStamp = (id: string) =>
        (expDb.prepare("SELECT notify_sent_at AS s FROM gardssalg_bookings WHERE booking_id = ?").get(id) as { s: string | null }).s;

      // ── AK-a: flag off ─────────────────────────────────────────────────────
      const bOff = mk("gjest-av@example.no");
      let offNew: Mail;
      let offReminder: Mail;
      {
        for (const v of [undefined, "false", "1", "TRUE", " true"]) {
          if (v === undefined) delete process.env[FLAG];
          else process.env[FLAG] = v;
          const before = sent.length;
          assertEq(await bs.sendProducerNotification(bOff, PRODUCER), "sent", `ak-a.1: ${FLAG}=${JSON.stringify(v)}: producer notification sent`);
          assertEq(await bs.sendPrevisitReminderToProducer(bOff), true, `ak-a.2: ${FLAG}=${JSON.stringify(v)}: reminder sent`);
          assertEq(sent.length - before, 2, `ak-a.3: ${FLAG}=${JSON.stringify(v)}: two mails handed to the mailer`);
          assertEq(crmCounts(), [0, 0, 0], `ak-a.4: ${FLAG}=${JSON.stringify(v)}: no crm_contacts / crm_threads / crm_messages rows`);
        }
        delete process.env[FLAG];
        offNew = sent[sent.length - 2];
        offReminder = sent[sent.length - 1];
        assertEq(archive.archiveProducerBookingMail({
          booking: bOff, kind: "producer_new", to: PRODUCER, subject: "s", textContent: "t", htmlContent: "h",
          sendResult: { success: true, messageId: "<x@y>" },
        }), null, "ak-a.5: direct call with the flag off -> null, nothing written");
        assertEq(crmCounts(), [0, 0, 0], "ak-a.6: still no CRM rows");
      }

      // ── AK-a (byte-identical) + AK-b: flag on ──────────────────────────────
      process.env[FLAG] = "true";
      {
        // Same booking, flag on: the mails are byte-identical to the flag-off ones.
        await bs.sendProducerNotification(bOff, PRODUCER);
        assertEq(last(), offNew, "ak-a.7: producer notification byte-identical with the flag on");
        await bs.sendPrevisitReminderToProducer(bOff);
        assertEq(last(), offReminder, "ak-a.8: reminder byte-identical with the flag on");

        const b = mk("gjest-pa@example.no");
        const threadId = archive.gardssalgBookingCrmThreadId(b.booking_id);
        assertEq(threadId, `gardssalg-booking-${b.booking_id}`, "ak-b.0: thread id format gardssalg-booking-<bookingId>");

        // 1. New request.
        assertEq(await bs.sendProducerNotification(b, PRODUCER), "sent", "ak-b.1: new-request mail sent");
        const m1 = last();
        let msgs = msgsOf(b.booking_id);
        assertEq(msgs.length, 1, "ak-b.2: one crm_messages row after the new-request mail");
        assertEq(
          [msgs[0].direction, msgs[0].delivery_status, msgs[0].vertical_id, JSON.parse(msgs[0].to_emails)],
          ["out", "sent", "experiences", [PRODUCER]],
          "ak-b.3: outbound, sent, vertical experiences, to the producer",
        );
        assertEq([msgs[0].subject, msgs[0].body_text, msgs[0].body_html], [m1.subject, m1.text, m1.html], "ak-b.4: subject / text / HTML exactly as sent");
        const meta1 = JSON.parse(msgs[0].raw_metadata);
        assertEq([meta1.source, meta1.kind, meta1.bookingId, meta1.bookingRef, meta1.providerId, meta1.smtpMessageId],
          ["gardssalg-booking", "producer_new", b.booking_id, b.booking_ref, "o45b-p", `<stub-${sent.length}@o45b.example.test>`],
          "ak-b.5: raw_metadata carries source, kind, booking, provider and the SMTP Message-ID");
        const thread = mainDb.prepare("SELECT t.vertical_id, t.category, t.status, t.subject, c.email, c.vertical_id AS cv, c.provider_id FROM crm_threads t JOIN crm_contacts c ON c.id = t.contact_id WHERE t.id = ?")
          .get(threadId) as Record<string, any>;
        assertEq([thread.vertical_id, thread.category, thread.status, thread.subject], ["experiences", "system", "done", m1.subject],
          "ak-b.6: thread on experiences, category system, status done, subject of the first mail");
        assertEq([thread.email, thread.cv, thread.provider_id], [PRODUCER, "experiences", "o45b-p"], "ak-b.7: contact = the producer, linked to the provider");

        // 2. Reminder, 3. guest accepted, 4. guest cancelled: same thread.
        assertEq(await bs.sendPrevisitReminderToProducer(b), true, "ak-b.8: reminder sent");
        const m2 = last();
        assertEq(await bs.sendGuestDecisionToProducer(b, true), true, "ak-b.9: guest-accept mail sent");
        const m3 = last();
        assertEq(await cancel.sendGuestCancelToProducer(b, "cancel"), true, "ak-b.10: guest-cancel mail sent");
        const m4 = last();
        msgs = msgsOf(b.booking_id);
        assertEq(msgs.map((m) => JSON.parse(m.raw_metadata).kind), ["producer_new", "reminder", "guest-accept", "guest-cancel"],
          "ak-b.11: one row per producer mail, in order, in the same thread");
        assertEq(msgs.slice(1).map((m) => [m.subject, m.body_text, m.body_html]),
          [m2, m3, m4].map((m) => [m.subject, m.text, m.html]), "ak-b.12: each stored as sent");
        assertEq(count("crm_threads"), 2, "ak-b.13: two threads: this booking's and the first booking's (re-sent with the flag on)");
        assertEq(msgsOf(bOff.booking_id).length, 2, "ak-b.13b: the first booking's two mails sent with the flag on are filed, the flag-off ones are not");

        // Identical re-send (a retry of the same content): not filed twice.
        await bs.sendGuestDecisionToProducer(b, true);
        assertEq(msgsOf(b.booking_id).length, 4, "ak-b.14: an identical re-send is not filed again");

        // Guest mails: never filed.
        const before = crmCounts();
        const nGuest = sent.length;
        await bs.sendBookingConfirmation(b);
        await bs.sendSuggestionToGuest(b);
        await bs.sendPrevisitDeclinedToGuest(b);
        await bs.sendPrevisitExpiredToGuest(b);
        // (sendSuggestionToGuest sends nothing without a suggested time.)
        assertTrue(sent.length - nGuest >= 3 && sent.slice(nGuest).every((m) => m.to === b.guest_email), "ak-b.15: (control) the guest mails were sent to the guest");
        assertEq(crmCounts(), before, "ak-b.16: no CRM rows for guest mails");
        assertEq((mainDb.prepare("SELECT COUNT(*) AS n FROM crm_contacts WHERE email = ?").get(b.guest_email) as { n: number }).n, 0,
          "ak-b.17: no CRM contact for the guest");

        // Failed and throwing sends: nothing filed.
        const bFail = mk("gjest-feil@example.no");
        nextSend = "fail";
        assertEq(await bs.sendProducerNotification(bFail, PRODUCER), "failed", "ak-b.18: failed send -> 'failed'");
        nextSend = "throw";
        assertEq(await bs.sendProducerNotification(bFail, PRODUCER, null, { retry: true }), "failed", "ak-b.19: throwing send -> 'failed'");
        nextSend = "fail";
        assertEq(await bs.sendPrevisitReminderToProducer(bFail), true, "ak-b.20: (unchanged) gated send returns true after a mailer failure");
        nextSend = "throw";
        let threw = false;
        try { await bs.sendGuestDecisionToProducer(bFail, false); } catch { threw = true; }
        assertTrue(threw, "ak-b.21: (unchanged) a throwing gated send still throws");
        assertEq(msgsOf(bFail.booking_id).length, 0, "ak-b.22: no row for failed or throwing sends");
        assertEq(count("crm_threads"), 2, "ak-b.23: and no new thread");

        // The followup job's retry of a failed first send is filed as such.
        assertEq(await bs.sendProducerNotification(bFail, PRODUCER, null, { retry: true }), "sent", "ak-b.24: retry sent");
        assertEq(msgsOf(bFail.booking_id).map((m) => JSON.parse(m.raw_metadata).kind), ["producer_new_retry"], "ak-b.25: retry filed once, kind producer_new_retry");

        // Test booking: the send guard redirects it, so it is not filed.
        const bTest = mk("gjest-test@example.no", { isTest: true });
        await bs.sendProducerNotification(bTest, PRODUCER);
        assertTrue(last().isTestSend, "ak-b.26: (control) the test booking's mail is a test send");
        assertEq(msgsOf(bTest.booking_id).length, 0, "ak-b.27: no row for a test booking");

        // DRY_RUN reached nobody: not filed.
        assertEq(archive.archiveProducerBookingMail({
          booking: b, kind: "x", to: PRODUCER, subject: "s", textContent: "t", htmlContent: "h",
          sendResult: { success: true, messageId: "DRY_RUN" },
        }), null, "ak-b.28: DRY_RUN -> not filed");

        // No max-touch-vern bookkeeping for these transactional mails.
        const ids = (mainDb.prepare("SELECT id FROM crm_messages").all() as Array<{ id: string }>).map((r) => r.id);
        const inLog = ids.filter((id) => mainDb.prepare("SELECT 1 FROM outreach_sent_log WHERE message_id = ?").get(id)).length;
        assertEq(inLog, 0, "ak-b.29: no outreach_sent_log row for any filed mail");

        // GET /admin/crm/threads/:id reads the thread.
        const detail = crm.getThreadDetail(threadId);
        assertEq((detail?.messages ?? []).length, 4, "ak-b.30: getThreadDetail returns the four messages");
      }

      // ── AK-c: a throw in the CRM write changes nothing for the send ────────
      {
        crm.recordOutboundReply = () => { throw new Error("crm write exploded (test)"); };
        const errs: unknown[] = [];
        const origErr = console.error;
        console.error = (...a: unknown[]) => { errs.push(a); };
        try {
          const bc = mk("gjest-kast@example.no");
          const n = sent.length;
          const before = crmCounts();
          const outcome = await bs.sendProducerNotification(bc, PRODUCER);
          assertEq(outcome, "sent", "ak-c.1: CRM throw -> notification still 'sent'");
          assertEq(sent.length - n, 1, "ak-c.2: the mail was sent once");
          assertTrue(!!notifyStamp(bc.booking_id), "ak-c.3: notify_sent_at stamped as usual");
          assertEq(await bs.sendPrevisitReminderToProducer(bc), true, "ak-c.4: CRM throw -> gated send still true");
          assertEq(crmCounts(), before, "ak-c.5: the failed CRM write left nothing behind (transaction rolled back)");
          assertTrue(errs.some((a) => String((a as unknown[])[0]).includes("[gardssalg-booking-crm-archive]")), "ak-c.6: the failure is logged");
        } finally {
          console.error = origErr;
          crm.recordOutboundReply = origRecordOutboundReply;
        }
      }
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
      crm.recordOutboundReply = origRecordOutboundReply;
      for (const k of envKeys) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
      unpinMainDb();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgBookingCrmArchiveO45bTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
