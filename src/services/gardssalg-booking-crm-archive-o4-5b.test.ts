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
 *   r1-B1 no booking token value (respond_token, confirm_token, …) is stored
 *         in any crm_messages / crm_threads column (incl. raw_metadata) for
 *         producer_new, producer_new_retry and reminder; the regex safety net
 *         masks foreign token links too.
 *   r1-B2 the guest's name / e-mail / phone / comment are not stored, raw or
 *         HTML-escaped (values with < & ' "), so the 30-day contact sweep
 *         is not outlived by the CRM copy.
 *   r1-N1 the outreach_sent_log row the cold-outreach trigger writes for an
 *         agent-linked producer address is deleted, and only that row.
 *   r1-N2 an existing thread with the same id on another vertical: no row is
 *         written, the send is unaffected.
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
        const mask = (x: string) => archive.maskProducerBookingMail(x, b);
        assertEq([msgs[0].subject, msgs[0].body_text, msgs[0].body_html], [mask(m1.subject), mask(m1.text), mask(m1.html)], "ak-b.4: subject / text / HTML as sent, tokens and guest data masked");
        assertTrue(m1.text !== mask(m1.text) && m1.html !== mask(m1.html), "ak-b.4b: (control) the masking changed the stored text and HTML");
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
          [m2, m3, m4].map((m) => [mask(m.subject), mask(m.text), mask(m.html)]), "ak-b.12: each stored as sent (masked)");
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

      // ── r1-B1 / r1-B2: tokens and guest data never stored ──────────────────
      {
        const MASK = archive.GARDSSALG_BOOKING_CRM_MASK;
        const allRowText = (bookingId: string): string => {
          const rows = mainDb.prepare("SELECT * FROM crm_messages WHERE thread_id = ?")
            .all(archive.gardssalgBookingCrmThreadId(bookingId)) as Array<Record<string, unknown>>;
          const th = mainDb.prepare("SELECT * FROM crm_threads WHERE id = ?").get(archive.gardssalgBookingCrmThreadId(bookingId));
          return JSON.stringify(rows) + "\n" + JSON.stringify(rows.map((r) => Object.values(r))) + "\n" + JSON.stringify(th ?? {});
        };
        const rowsOf = (bookingId: string) => mainDb.prepare("SELECT * FROM crm_messages WHERE thread_id = ? ORDER BY rowid")
          .all(archive.gardssalgBookingCrmThreadId(bookingId)) as Array<Record<string, unknown>>;
        const containsAny = (rows: Array<Record<string, unknown>>, needle: string): string[] =>
          rows.flatMap((r) => Object.entries(r).filter(([, v]) => typeof v === "string" && v.includes(needle)).map(([k]) => k));
        const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

        const GUEST = {
          name: "Åse <O&B> D'Ødegård",
          email: "ase.o-b+tag@example.no",
          phone: "+47 912 34 567",
          notes: "Kommer med hund & 2 barn <3 \"glutenfri\" takk",
        };
        const bp = bs.createBooking(
          {
            provider_id: "o45b-p", slot_at: new Date(SLOT + 2 * H).toISOString(), party_size: 3,
            guest_name: GUEST.name, guest_email: GUEST.email, guest_phone: GUEST.phone, notes: GUEST.notes,
          },
          "opplevagent",
        );
        assertTrue(!!bp.respond_token && !!bp.confirm_token && !!bp.guest_status_token, "r1.0: (control) the booking has respond/confirm/status tokens");

        // producer_new
        assertEq(await bs.sendProducerNotification(bp, PRODUCER), "sent", "r1.1: new-request mail sent");
        const mNew = last();
        assertTrue(mNew.text.includes(bp.respond_token!) && mNew.html.includes(bp.respond_token!), "r1.2: (control) the sent mail carries respond_token");
        assertTrue(mNew.text.includes(bp.confirm_token) && mNew.html.includes(bp.confirm_token), "r1.3: (control) the sent mail carries confirm_token");
        assertTrue(mNew.text.includes(GUEST.notes) && mNew.html.includes(esc(GUEST.notes)) && mNew.html.includes(esc(GUEST.name)),
          "r1.4: (control) the sent mail carries the guest's comment and name (HTML-escaped in the HTML)");
        assertTrue(mNew.text.includes(GUEST.phone) && mNew.text.includes(GUEST.email), "r1.5: (control) the sent mail carries the guest's phone and e-mail");

        // reminder
        assertEq(await bs.sendPrevisitReminderToProducer(bp), true, "r1.6: reminder sent");
        assertTrue(last().text.includes(bp.respond_token!), "r1.7: (control) the reminder carries respond_token");

        // producer_new_retry (a separate booking whose first send failed)
        const br = bs.createBooking(
          {
            provider_id: "o45b-p", slot_at: new Date(SLOT + 3 * H).toISOString(), party_size: 1,
            guest_name: GUEST.name, guest_email: GUEST.email, guest_phone: GUEST.phone, notes: GUEST.notes,
          },
          "opplevagent",
        );
        nextSend = "fail";
        await bs.sendProducerNotification(br, PRODUCER);
        assertEq(await bs.sendProducerNotification(br, PRODUCER, null, { retry: true }), "sent", "r1.8: retry sent");
        assertTrue(last().text.includes(br.confirm_token), "r1.9: (control) the retry carries confirm_token");

        const pRows = rowsOf(bp.booking_id);
        const rRows = rowsOf(br.booking_id);
        assertEq(pRows.map((r) => JSON.parse(String(r.raw_metadata)).kind), ["producer_new", "reminder"], "r1.10: producer_new and reminder filed");
        assertEq(rRows.map((r) => JSON.parse(String(r.raw_metadata)).kind), ["producer_new_retry"], "r1.11: producer_new_retry filed");

        for (const [label, bk, rows] of [["bp", bp, pRows], ["br", br, rRows]] as const) {
          for (const tok of ["respond_token", "confirm_token", "guest_status_token", "guest_decision_token"] as const) {
            const v = (bk as any)[tok] as string | null;
            if (!v) continue;
            assertEq(containsAny(rows, v), [], `r1-B1: ${label}: ${tok} value in no crm_messages column (incl. raw_metadata)`);
            assertTrue(!allRowText(bk.booking_id).includes(v), `r1-B1: ${label}: ${tok} value not in the thread row either`);
          }
          for (const [field, v] of Object.entries(GUEST)) {
            for (const form of new Set([v, esc(v)])) {
              assertEq(containsAny(rows, form), [], `r1-B2: ${label}: guest ${field} ${form === v ? "raw" : "HTML-escaped"} in no crm_messages column`);
              assertTrue(!allRowText(bk.booking_id).includes(form), `r1-B2: ${label}: guest ${field} (${form === v ? "raw" : "escaped"}) not in the thread row`);
            }
          }
          assertTrue(rows.every((r) => String(r.body_text).includes(MASK) && String(r.body_html).includes(MASK)), `r1: ${label}: the stored text and HTML show the mask`);
          assertTrue(rows.every((r) => String(r.body_text).includes("/kategori/gardssalg/svar/" + MASK) || String(r.body_text).includes("/kategori/gardssalg/bekreft/" + MASK)),
            `r1: ${label}: the token link stays readable, value masked`);
        }

        // Exact replacement: the row's own token values are masked wherever they
        // stand, also outside a known link shape (the regexes cover only links).
        const bare = archive.maskProducerBookingMail(`svar=${bp.respond_token} / ${bp.confirm_token} / ${bp.guest_status_token}`, bp);
        assertEq(bare, `svar=${MASK} / ${MASK} / ${MASK}`, "r1-B1: the booking's own token values are masked outside link shapes too");

        // Regex safety net: a token value that is NOT the row's own is masked too.
        const foreign = archive.maskProducerBookingMail(
          "https://x.no/kategori/gardssalg/svar/abc123def\nhttps://x.no/kategori/gardssalg/bekreft/zzz999?x=1\n"
          + "<a href=\"https://x.no/kategori/gardssalg/gjestesvar/qqq777\">x</a> https://x.no/kategori/gardssalg/status/GS-1/sss555 "
          + "https://x.no/p?token=tok111&amp;respond_token=tok222&a=1",
          { booking_id: "x", booking_ref: "x", provider_id: "x" },
        );
        for (const v of ["abc123def", "zzz999", "qqq777", "sss555", "tok111", "tok222"]) {
          assertTrue(!foreign.includes(v), `r1-B1: safety net masks a foreign token (${v})`);
        }
        assertTrue(foreign.includes("?x=1") && foreign.includes("&a=1") && foreign.includes("/status/GS-1/"), "r1-B1: safety net leaves other URL parts alone");
      }

      // ── r1-N1: the trigger's outreach_sent_log row is deleted, only that one ─
      {
        const AGENT_MAIL = "gard-agent-o45b@example.no";
        mainDb.prepare(
          `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, origin)
           VALUES ('o45b-agent', 'Gård O45b', 'Test.', 'test', ?, 'https://o45b.example.test', 'producer', 'key-o45b', 'discovery')`,
        ).run(AGENT_MAIL);
        mainDb.prepare("INSERT INTO agent_knowledge (agent_id, email) VALUES (?, ?)").run("o45b-agent", AGENT_MAIL);
        const seedId = Number(mainDb.prepare(
          `INSERT INTO outreach_sent_log (agent_id, recipient_email, sent_at, channel, message_id, notes, vertical_id)
           VALUES ('o45b-agent', ?, datetime('now', '-3 days'), 'email', 'seed-o45b-cold', 'auto:cold_outreach_v2', 'rfb')`,
        ).run(AGENT_MAIL).lastInsertRowid);
        const bn = mk("gjest-n1@example.no");
        assertEq(await bs.sendProducerNotification(bn, AGENT_MAIL), "sent", "r1-N1.1: mail to the agent-linked address sent");
        const rows = msgsOf(bn.booking_id);
        assertEq(rows.length, 1, "r1-N1.2: filed");
        assertEq((mainDb.prepare("SELECT COUNT(*) AS n FROM outreach_sent_log WHERE message_id = ?").get(rows[0]?.id) as { n: number }).n, 0,
          "r1-N1.3: no outreach_sent_log row for the filed message (the trigger's row was deleted)");
        assertEq(mainDb.prepare("SELECT message_id, notes FROM outreach_sent_log WHERE id = ?").get(seedId),
          { message_id: "seed-o45b-cold", notes: "auto:cold_outreach_v2" }, "r1-N1.4: the unrelated cold-outreach row for the same address is untouched");
      }

      // ── r1-N2: thread id taken by another vertical → nothing written ───────
      {
        const bx = mk("gjest-n2@example.no");
        const tid = archive.gardssalgBookingCrmThreadId(bx.booking_id);
        mainDb.prepare("INSERT INTO crm_contacts (id, type, email, vertical_id) VALUES ('o45b-rfb-contact', 'producer', 'rfb-o45b@example.no', 'rfb')").run();
        mainDb.prepare(
          "INSERT INTO crm_threads (id, contact_id, subject, category, status, vertical_id) VALUES (?, 'o45b-rfb-contact', 'rfb thread', 'system', 'done', 'rfb')",
        ).run(tid);
        const errs: unknown[] = [];
        const origErr = console.error;
        console.error = (...a: unknown[]) => { errs.push(a); };
        const n = sent.length;
        let outcome: string;
        let rem: boolean;
        try {
          outcome = await bs.sendProducerNotification(bx, PRODUCER);
          rem = await bs.sendPrevisitReminderToProducer(bx);
        } finally {
          console.error = origErr;
        }
        assertEq([outcome, rem, sent.length - n], ["sent", true, 2], "r1-N2.1: the sends are unaffected (sent, true, two mails)");
        assertEq(msgsOf(bx.booking_id).length, 0, "r1-N2.2: no crm_messages row in the other vertical's thread");
        assertEq(mainDb.prepare("SELECT vertical_id, subject, contact_id FROM crm_threads WHERE id = ?").get(tid),
          { vertical_id: "rfb", subject: "rfb thread", contact_id: "o45b-rfb-contact" }, "r1-N2.3: the other vertical's thread is unchanged");
        assertTrue(errs.some((a) => String((a as unknown[])[0]).includes("[gardssalg-booking-crm-archive]")), "r1-N2.4: the collision is logged");
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
