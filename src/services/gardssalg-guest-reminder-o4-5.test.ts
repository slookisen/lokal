/**
 * gardssalg-guest-reminder-o4-5.test.ts — A2A dev-request 2026-11-12-
 * opplevagent-o4-epost-og-tekster, slice O4-5: one reminder e-mail to the
 * guest the day before a confirmed gårdssalg visit
 * (flag GARDSSALG_GUEST_REMINDER_ENABLED).
 *
 *   AK1  flag off: the followup job sends no reminder, stamps nothing, and
 *        its result has no guest_reminders_sent field (old shape).
 *   AK2  flag on: exactly one reminder per confirmed visit the day before (Oslo
 *        date of the visit = the day after the tick's, at most 24 h ahead), also
 *        when the job runs twice (and when two runs overlap); none for
 *        pending / suggested / declined / expired / cancelled / resolved /
 *        past bookings; none for a visit later the same Oslo day, two days ahead
 *        or > 24 h ahead (DST and legacy naked slots included). A booking
 *        cancelled during the run (between SELECT and claim) gets nothing.
 *        A failed send releases the claim and is retried.
 *   AK3  GET /admin/booking-followups/guest-reminders/dry-run: 403 without
 *        the admin key; the count equals what the job then sends; the GET
 *        writes nothing; answers with the flag off too.
 *   AK4  subject and body verbatim against text package OA-2 B, Norwegian and
 *        English; the cancel line follows GARDSSALG_CANCEL_ENABLED; English
 *        only with GARDSSALG_EMAIL_EN_ENABLED AND guest_lang "en".
 *   (x)  a guest / producer name with `<script>` and `$&` is escaped in the
 *        HTML and inserted literally in the text.
 *
 * Fixtures: in-memory experiences database, test producers, example.no
 * guests; every e-mail send is stubbed. No real data is touched.
 *
 * Exported runGardssalgGuestReminderO45Tests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/gardssalg-guest-reminder-o4-5.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const H = 3600_000;
const FLAG = "GARDSSALG_GUEST_REMINDER_ENABLED";

// OA-2 B (A2A marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-2.md),
// copied verbatim from the approved package. Do not "fix" these here.
const PACK_B = {
  subject: { nb: "I morgen: besøk hos {produsent} — {ref}", en: "Tomorrow: your visit to {produsent} — {ref}" },
  body: {
    nb: "Hei {gjest},\n\nDette er en påminnelse om besøket du har avtalt:\n\nSted: {produsent}, {sted}\nTidspunkt: {tid}\nAntall: {antall}\nReferanse: {ref}\n\nKan du ikke komme likevel, er det fint om du avlyser, så produsenten får beskjed: {statusside}\n\nHilsen\nOpplevagent",
    en: "Hi {gjest},\n\nThis is a reminder of the visit you have arranged:\n\nPlace: {produsent}, {sted}\nDate and time: {tid}\nGuests: {antall}\nReference: {ref}\n\nIf you cannot come after all, please cancel so that the producer is told: {statusside}\n\nBest regards,\nOpplevagent",
  },
  cancelLine: {
    nb: "Kan du ikke komme likevel, er det fint om du avlyser, så produsenten får beskjed: {statusside}",
    en: "If you cannot come after all, please cancel so that the producer is told: {statusside}",
  },
  replyLine: {
    nb: "Kan du ikke komme likevel, svarer du på denne e-posten.",
    en: "If you cannot come after all, reply to this email.",
  },
};

const fillPack = (t: string, vars: Record<string, string>) =>
  t.replace(/\{([a-zæøå_-]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

function callRoute(
  router: any,
  method: "GET" | "POST",
  url: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method, url, originalUrl: url, path: url, query: {}, ip: "127.0.0.1",
      headers: opts.headers || {},
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

export function runGardssalgGuestReminderO45Tests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      "EXPERIENCES_DB_PATH", "ADMIN_KEY", "BOOKING_DISPATCH_ENABLED", "BOOKING_FOLLOWUP_CLOCK_FLOOR",
      "GARDSSALG_CANCEL_ENABLED", "GARDSSALG_EMAIL_EN_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED", FLAG,
    ];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    const testKey = process.env.ADMIN_KEY || "gardssalg-guest-reminder-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    process.env.BOOKING_FOLLOWUP_CLOCK_FLOOR = "2020-01-01T00:00:00Z";
    for (const k of ["GARDSSALG_CANCEL_ENABLED", "GARDSSALG_EMAIL_EN_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED", FLAG]) delete process.env[k];

    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-booking-gate"),
      require.resolve("./gardssalg-booking-resolve"),
      // Reads the producer's name/address via getDb(): must see this test's db-factory.
      require.resolve("./gardssalg-honest-receipt"),
      require.resolve("../routes/opplevelser"),
    ]);
    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    type Mail = { to: string; subject: string; text: string; html: string; replyTo?: string; from: string };
    const sent: Mail[] = [];
    let failNext = 0;
    let throwNext = 0;
    let onSend: ((o: any) => void) | null = null;
    emailSvc.sendEmail = async (o: any) => {
      if (onSend) onSend(o);
      if (throwNext > 0) { throwNext--; throw new Error("mailer exploded"); }
      if (failNext > 0) { failNext--; return { success: false, error: "smtp 451 test" }; }
      sent.push({ to: o.to, subject: o.subject, text: o.textContent, html: o.htmlContent, replyTo: o.replyTo, from: String(o.from || "") });
      return { success: true, messageId: "stub" };
    };

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const bs = require("./booking-store") as typeof import("./booking-store");
      const router = (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any;

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence, adresse, postnummer, poststed)
         VALUES (@id, @navn, 'experiences', 'Vestland', 'Voss', 'sideri', 'post@example.no', 1, 0,
            @id, 'raw', 'pending_verify', 'test-fixture', 'medium', @adresse, @postnummer, @poststed)`,
      );
      insertProvider.run({ id: "o45-p", navn: "Testsideri", adresse: "Gardsvegen 1", postnummer: "5700", poststed: "Voss" });
      insertProvider.run({ id: "o45-x", navn: "Sideri <script>alert(1)</script> $& Co", adresse: "Vegen 2 <b>", postnummer: "5700", poststed: "Voss" });
      insertProvider.run({ id: "o45-n", navn: "Sideri Uten Adresse", adresse: null, postnummer: null, poststed: null });

      // Far ahead of the real clock, so the route (which uses the real clock)
      // sees none of these fixtures as due.
      const NOW = Date.parse("2099-06-11T12:00:00.000Z");
      const at = (ms: number) => new Date(ms);
      const iso = (ms: number) => new Date(ms).toISOString();
      const mk = (o: {
        email: string; slotMs: number; pre?: string; status?: string; provider?: string; name?: string; lang?: string;
      }) => {
        const b = bs.createBooking(
          { provider_id: o.provider ?? "o45-p", slot_at: iso(o.slotMs), party_size: 3, guest_name: o.name ?? "Kari", guest_email: o.email },
          "opplevagent",
          { guestLang: o.lang },
        );
        // Neutral for the job's other steps: the answer deadline is far
        // ahead, and an expired row's guest has already been told.
        expDb.prepare(`UPDATE gardssalg_bookings SET pre_status = ?, status = ?, respond_token_expires_at = ?,
                         expired_guest_notified_at = CASE WHEN ? = 'expired' THEN ? ELSE NULL END
                       WHERE booking_id = ?`)
          .run(o.pre ?? "provider_confirmed", o.status ?? "reserved", iso(NOW + 100 * 24 * H), o.pre ?? "", iso(NOW - 48 * H), b.booking_id);
        return bs.getBookingByRef(b.booking_ref)!;
      };
      const stampOf = (ref: string) =>
        (expDb.prepare("SELECT guest_reminder_sent_at AS s FROM gardssalg_bookings WHERE booking_ref = ?").get(ref) as { s: string | null }).s;
      const snapshot = () => JSON.stringify(expDb.prepare("SELECT * FROM gardssalg_bookings ORDER BY booking_id").all());
      const sentTo = (email: string) => sent.filter((m) => m.to === email).length;

      // ── Fixtures: one per case, all relative to NOW ───────────────────────
      const inWindow = mk({ email: "i-vindu@example.no", slotMs: NOW + 23 * H });
      const atEdge = mk({ email: "kant-24@example.no", slotMs: NOW + 24 * H });
      // NOW is 14:00 Oslo (CEST): +3 h is 17:00 the same day — «I morgen» would be false.
      const sameDay = mk({ email: "samme-dag@example.no", slotMs: NOW + 3 * H });
      // +34 h is 00:00 Oslo two days ahead.
      const twoDays = mk({ email: "to-dager@example.no", slotMs: NOW + 34 * H });
      const tooFar = mk({ email: "for-langt@example.no", slotMs: NOW + 24 * H + 60_000 });
      const tooClose = mk({ email: "for-naer@example.no", slotMs: NOW + 2 * H - 60_000 });
      const past = mk({ email: "passert@example.no", slotMs: NOW - 1 * H });
      const pending = mk({ email: "venter@example.no", slotMs: NOW + 20 * H, pre: "awaiting_provider" });
      const suggested = mk({ email: "foreslatt@example.no", slotMs: NOW + 20 * H, pre: "time_suggested" });
      const declined = mk({ email: "avslatt@example.no", slotMs: NOW + 20 * H, pre: "provider_declined" });
      const expired = mk({ email: "utlopt@example.no", slotMs: NOW + 20 * H, pre: "expired" });
      const cancelled = mk({ email: "avlyst@example.no", slotMs: NOW + 20 * H, status: "cancelled" });
      const attended = mk({ email: "motte@example.no", slotMs: NOW + 20 * H, status: "confirmed_attended" });
      const swept = mk({ email: "slettet@example.no", slotMs: NOW + 20 * H });
      expDb.prepare("UPDATE gardssalg_bookings SET guest_email = '' WHERE booking_id = ?").run(swept.booking_id);
      const shouldSend = [inWindow, atEdge].map((b) => b.booking_ref).sort();
      const neverSend = [sameDay, twoDays, tooFar, tooClose, past, pending, suggested, declined, expired, cancelled, attended];

      // ── AK1: flag off ──────────────────────────────────────────────────────
      {
        const before = snapshot();
        const r = await bs.processBookingFollowups(at(NOW));
        assertEq(sent.length, 0, "ak1.1: flag off -> no e-mail sent");
        assertEq(snapshot(), before, "ak1.2: flag off -> nothing written");
        assertTrue(!("guest_reminders_sent" in r), "ak1.3: flag off -> result keeps the old shape (no guest_reminders_sent)");
        for (const v of ["false", "1", "TRUE", " true"]) {
          process.env[FLAG] = v;
          await bs.processBookingFollowups(at(NOW));
          assertEq(sent.length, 0, `ak1.4: ${FLAG}=${JSON.stringify(v)} counts as off`);
        }
        delete process.env[FLAG];
      }

      // ── AK3 (part 1): dry-run with the flag off, admin key, read-only ──────
      const url = "/admin/booking-followups/guest-reminders/dry-run";
      {
        const noKey = await callRoute(router, "GET", url);
        assertEq(noKey.status, 403, "ak3.1: no X-Admin-Key -> 403");
        assertTrue(noKey.body?.would_send === undefined, "ak3.2: no payload without the key");
        const badKey = await callRoute(router, "GET", url, { headers: { "x-admin-key": "wrong" } });
        assertEq(badKey.status, 403, "ak3.3: wrong key -> 403");
        const before = snapshot();
        const ok = await callRoute(router, "GET", url, { headers: { "x-admin-key": testKey } });
        assertEq(ok.status, 200, "ak3.4: admin key -> 200 (flag off too)");
        assertEq(ok.body?.enabled, false, "ak3.5: reports the flag as off");
        assertEq(snapshot(), before, "ak3.6: the GET writes nothing");
        const dry = bs.countGuestRemindersDue(at(NOW));
        assertEq([dry.would_send, dry.booking_refs], [2, shouldSend], "ak3.7: dry-run at NOW: the two confirmed visits tomorrow within 24 h");
        assertEq([dry.window_hours, dry.rule], [24, "oslo_day_before"], "ak3.8: window 24 h, Oslo day-before rule");
        assertEq(snapshot(), before, "ak3.9: the count writes nothing");
      }

      // ── AK2: flag on ───────────────────────────────────────────────────────
      process.env[FLAG] = "true";
      {
        const dryBefore = bs.countGuestRemindersDue(at(NOW));
        assertEq(dryBefore.enabled, true, "ak3.10: dry-run reports the flag as on");
        // Two overlapping runs: the claim decides, never two sends.
        const [r1, r2] = await Promise.all([bs.processBookingFollowups(at(NOW)), bs.processBookingFollowups(at(NOW))]);
        assertEq((r1.guest_reminders_sent ?? 0) + (r2.guest_reminders_sent ?? 0), 2, "ak2.1: two overlapping runs send two reminders in total");
        assertEq(dryBefore.would_send, 2, "ak3.11: the dry-run count equals what the job sent");
        for (const b of [inWindow, atEdge]) {
          assertEq(sentTo(b.guest_email), 1, `ak2.2: exactly one reminder to ${b.guest_email}`);
          assertTrue(!!stampOf(b.booking_ref), `ak2.3: guest_reminder_sent_at stamped for ${b.guest_email}`);
        }
        const r3 = await bs.processBookingFollowups(at(NOW));
        assertEq(r3.guest_reminders_sent, 0, "ak2.4: a later run sends nothing again");
        assertEq(sent.length, 2, "ak2.5: still two e-mails in total");
        for (const b of neverSend) {
          assertEq(sentTo(b.guest_email), 0, `ak2.6: no reminder to ${b.guest_email}`);
          assertEq(stampOf(b.booking_ref), null, `ak2.7: nothing stamped for ${b.guest_email}`);
        }
        assertEq(stampOf(swept.booking_ref), null, "ak2.8: a row with the guest e-mail swept is not reminded");
        assertEq(bs.countGuestRemindersDue(at(NOW)).would_send, 0, "ak3.12: dry-run after the run: nothing left to send");

        // The visit that was > 24 h away enters the window an hour later.
        const later = await bs.processBookingFollowups(at(NOW + 1 * H));
        assertEq(later.guest_reminders_sent, 1, "ak2.9: the visit 24 h + 1 min away is reminded on the next hourly run");
        assertEq(sentTo(tooFar.guest_email), 1, "ak2.10: ... exactly once");
        // A cancelled visit after the guard: no claim.
        const cancelledLate = mk({ email: "avlyst-sent@example.no", slotMs: NOW + 20 * H });
        expDb.prepare("UPDATE gardssalg_bookings SET status = 'cancelled' WHERE booking_id = ?").run(cancelledLate.booking_id);
        await bs.processBookingFollowups(at(NOW));
        assertEq(sentTo("avlyst-sent@example.no"), 0, "ak2.11: cancelled after confirmation -> no reminder");
        assertEq(bs.guestReminderDue({ ...cancelledLate, status: "reserved", guest_reminder_sent_at: null }, NOW), true,
          "ak2.12: (control) the same visit would be due if still reserved");

        // A send that fails releases the claim and is retried; a throw too.
        const flaky = mk({ email: "feiler@example.no", slotMs: NOW + 10 * H });
        failNext = 1;
        const rf = await bs.processBookingFollowups(at(NOW));
        assertEq([rf.guest_reminders_sent, stampOf(flaky.booking_ref)], [0, null], "ak2.13: failed send -> not counted, claim released");
        throwNext = 1;
        const rt = await bs.processBookingFollowups(at(NOW));
        assertEq([rt.guest_reminders_sent, rt.errors > 0, stampOf(flaky.booking_ref)], [0, true, null], "ak2.14: throwing send -> error counted, claim released");
        await bs.processBookingFollowups(at(NOW));
        assertEq(sentTo("feiler@example.no"), 1, "ak2.15: the next run sends it once");
        await bs.processBookingFollowups(at(NOW));
        assertEq(sentTo("feiler@example.no"), 1, "ak2.16: and never again");

        // N1: cancelled between the candidate SELECT and the claim — the
        // claim's state guard stops the send.
        const first = mk({ email: "n1-forst@example.no", slotMs: NOW + 20 * H });
        const second = mk({ email: "n1-andre@example.no", slotMs: NOW + 20 * H + 60_000 });
        onSend = (o: any) => {
          if (o.to === first.guest_email) {
            expDb.prepare("UPDATE gardssalg_bookings SET status = 'cancelled' WHERE booking_id = ?").run(second.booking_id);
          }
        };
        try {
          const rn = await bs.processBookingFollowups(at(NOW));
          assertEq(rn.guest_reminders_sent, 1, "n1.1: only the first is sent");
        } finally {
          onSend = null;
        }
        assertEq([sentTo(first.guest_email), sentTo(second.guest_email)], [1, 0], "n1.2: the one cancelled during the run gets nothing");
        assertEq(stampOf(second.booking_ref), null, "n1.3: and is not stamped");

        // Job level, late evening: a visit at 08:00 Oslo is not reminded at
        // 07:00 Oslo the day before (25 h ahead) but is at 23:30 Oslo.
        const evening = mk({ email: "kveld@example.no", slotMs: Date.parse("2099-06-15T06:00:00.000Z") });
        await bs.processBookingFollowups(at(Date.parse("2099-06-14T05:00:00.000Z")));
        assertEq(sentTo(evening.guest_email), 0, "ak2.17: 07:00 Oslo the day before, 25 h ahead -> not yet");
        await bs.processBookingFollowups(at(Date.parse("2099-06-14T21:30:00.000Z")));
        assertEq(sentTo(evening.guest_email), 1, "ak2.18: 23:30 Oslo the day before -> sent");

        // B1: «dagen før» — the visit's Oslo date is the day after the tick's.
        {
          const base = { ...inWindow, guest_reminder_sent_at: null };
          const due = (slot: string, tickIso: string) => bs.guestReminderDue({ ...base, slot_at: slot }, Date.parse(tickIso));
          assertEq(due("2099-06-11T13:00:00.000Z", "2099-06-11T06:00:00.000Z"), false, "d1: morning tick 08:00, visit 15:00 the same day -> nothing");
          assertEq(due("2099-06-12T06:00:00.000Z", "2099-06-11T21:30:00.000Z"), true, "d2: tick 23:30, visit 08:00 the next day -> sent");
          assertEq(due("2099-06-11T21:00:00.000Z", "2099-06-10T22:30:00.000Z"), false, "d3: tick 00:30, visit 23:00 the same day -> nothing (UTC dates differ, Oslo dates do not)");
          assertEq(due("2099-06-12T22:15:00.000Z", "2099-06-11T21:30:00.000Z"), false, "d4: visit two days ahead in Oslo -> nothing");
          assertEq(due("2099-06-13T08:00:00.000Z", "2099-06-11T12:00:00.000Z"), false, "d5: visit two days ahead (44 h) -> nothing");
          assertEq(due("2099-06-11T11:00:00.000Z", "2099-06-11T12:00:00.000Z"), false, "d6: visit passed -> nothing");
          assertEq(due("2099-10-25T21:00:00.000Z", "2099-10-24T21:30:00.000Z"), true, "d7: DST end: Sat 23:30 CEST, visit Sun 22:00 CET -> sent");
          assertEq(due("2099-06-12T08:00", "2099-06-11T21:30:00.000Z"), true, "d8: legacy naked slot (Oslo wall time) 08:00 next day -> sent");
          assertEq(due("2099-06-12T08:00", "2099-06-11T05:00:00.000Z"), false, "d9: legacy naked slot, 25 h ahead -> not yet");
        }

        // AK3 again through the route with the flag on: count == what the job sends, GET writes nothing.
        // The route uses the real clock: a visit 24 h (less a second) from now is always tomorrow in Oslo.
        const realNow = Date.now();
        const fresh = mk({ email: "ny@example.no", slotMs: realNow + 24 * H - 1000 });
        const before = snapshot();
        const ok = await callRoute(router, "GET", url, { headers: { "x-admin-key": testKey } });
        assertEq(snapshot(), before, "ak3.13: GET with the flag on writes nothing");
        const rr = await bs.processBookingFollowups(at(realNow));
        assertEq([ok.body?.would_send, ok.body?.booking_refs], [rr.guest_reminders_sent, [fresh.booking_ref]], "ak3.14: route count == what the job then sends");
      }

      // ── AK4: texts verbatim, cancel line, language ─────────────────────────
      {
        const nbTid = (ms: number) => new Date(ms).toLocaleString("nb-NO", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Oslo" });
        const hr = require("./gardssalg-honest-receipt") as typeof import("./gardssalg-honest-receipt");
        const statusUrl = (b: { booking_ref: string; guest_status_token: string | null }) =>
          `${process.env.APP_URL || "https://opplevagent.no"}/kategori/gardssalg/status/${encodeURIComponent(b.booking_ref)}/${b.guest_status_token}`;
        const slotMs = NOW + 20 * H;
        const nbB = mk({ email: "tekst-nb@example.no", slotMs, lang: "nb" });
        const enB = mk({ email: "tekst-en@example.no", slotMs, lang: "en" });
        const vars = (b: typeof nbB, tid: string) => ({
          gjest: "Kari", produsent: "Testsideri", sted: "Gardsvegen 1, 5700 Voss", tid, antall: "3", ref: b.booking_ref, statusside: statusUrl(b),
        });

        // Cancel flag on, English flag off: Norwegian for both.
        process.env.GARDSSALG_CANCEL_ENABLED = "true";
        let m = bs.buildGuestReminderEmail(nbB);
        assertEq(m.lang, "nb", "ak4.1: nb guest -> Norwegian");
        assertEq(m.subject, fillPack(PACK_B.subject.nb, vars(nbB, "")), "ak4.2: Norwegian subject verbatim");
        assertEq(m.textContent, fillPack(PACK_B.body.nb, vars(nbB, nbTid(slotMs))), "ak4.3: Norwegian body verbatim with the cancel line (cancel on)");
        assertTrue(m.htmlContent.includes(`<a href="${statusUrl(nbB)}">${statusUrl(nbB)}</a>`), "ak4.4: the status URL is a link in the HTML");
        m = bs.buildGuestReminderEmail(enB);
        assertEq(m.lang, "nb", "ak4.5: en guest with GARDSSALG_EMAIL_EN_ENABLED off -> Norwegian");

        // English flag on.
        process.env.GARDSSALG_EMAIL_EN_ENABLED = "true";
        m = bs.buildGuestReminderEmail(enB);
        const enTid = hr.formatOsloInstant(iso(slotMs), "en");
        assertEq(m.lang, "en", "ak4.6: en guest + flag on -> English");
        assertEq(m.subject, fillPack(PACK_B.subject.en, vars(enB, "")), "ak4.7: English subject verbatim");
        assertEq(m.textContent, fillPack(PACK_B.body.en, vars(enB, enTid)), "ak4.8: English body verbatim with the cancel line (cancel on)");
        assertEq(bs.buildGuestReminderEmail(nbB).lang, "nb", "ak4.9: nb guest + flag on -> Norwegian");

        // Cancel flag off: the reply line instead of the cancel line.
        delete process.env.GARDSSALG_CANCEL_ENABLED;
        m = bs.buildGuestReminderEmail(enB);
        assertEq(m.textContent, fillPack(PACK_B.body.en.split(PACK_B.cancelLine.en).join(PACK_B.replyLine.en), vars(enB, enTid)),
          "ak4.10: English body with the reply line (cancel off)");
        assertTrue(!m.textContent.includes("/kategori/gardssalg/status/"), "ak4.11: no status link with cancel off");
        delete process.env.GARDSSALG_EMAIL_EN_ENABLED;
        m = bs.buildGuestReminderEmail(nbB);
        assertEq(m.textContent, fillPack(PACK_B.body.nb.split(PACK_B.cancelLine.nb).join(PACK_B.replyLine.nb), vars(nbB, nbTid(slotMs))),
          "ak4.12: Norwegian body with the reply line (cancel off)");

        // The register holds the package text.
        const reg = require("./gardssalg-email-texts") as typeof import("./gardssalg-email-texts");
        const R = reg.GARDSSALG_EMAIL_TEXTS;
        assertEq([R["guest.reminder.subject"].nb, R["guest.reminder.subject"].en], [PACK_B.subject.nb, PACK_B.subject.en], "ak4.13: register subject = OA-2 B");
        assertEq([R["guest.reminder.body"].nb, R["guest.reminder.body"].en], [PACK_B.body.nb, PACK_B.body.en], "ak4.14: register body = OA-2 B");
        assertEq([R["guest.reminder.replyLine"].nb, R["guest.reminder.replyLine"].en], [PACK_B.replyLine.nb, PACK_B.replyLine.en], "ak4.15: register reply line = OA-2 B");

        // The sent mail: reply-to and sender like the other guest e-mails.
        const mail = sent.find((x) => x.to === inWindow.guest_email)!;
        assertEq(mail.replyTo, "kontakt@opplevagent.no", "ak4.16: reply-to kontakt@opplevagent.no like the other guest e-mails");
        assertTrue(mail.from === (require("./crm-platform-identity") as typeof import("./crm-platform-identity")).crmFromHeader("experiences"),
          "ak4.17: sender identity like the other guest e-mails");

        // No address on file: no dangling comma.
        const noAddr = mk({ email: "uten-adresse@example.no", slotMs, provider: "o45-n" });
        assertTrue(bs.buildGuestReminderEmail(noAddr).textContent.includes("\nSted: Sideri Uten Adresse\n"), "ak4.18: no address -> «Sted: {produsent}» without a comma");
      }

      // ── (x) escaping and `$&` ──────────────────────────────────────────────
      {
        const evilGuest = "Ola <script>alert('x')</script> $& $1 $$";
        const b = mk({ email: "xss@example.no", slotMs: NOW + 20 * H, provider: "o45-x", name: evilGuest });
        const m = bs.buildGuestReminderEmail(b);
        assertTrue(!m.htmlContent.includes("<script>") && !m.htmlContent.includes("<b>"), "x1: no raw tag from a guest/producer value in the HTML");
        assertTrue(m.htmlContent.includes("Ola &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; $&amp; $1 $$"), "x2: guest name escaped, `$&` and `$1` literal in the HTML");
        assertTrue(m.htmlContent.includes("Sideri &lt;script&gt;alert(1)&lt;/script&gt; $&amp; Co, Vegen 2 &lt;b&gt;, 5700 Voss"), "x3: producer name and address escaped in the HTML");
        assertTrue(m.textContent.startsWith(`Hei ${evilGuest},\n`), "x4: text has the guest name literally (`$&` not expanded)");
        assertEq(m.subject, `I morgen: besøk hos Sideri <script>alert(1)</script> $& Co — ${b.booking_ref}`, "x5: subject has the producer name literally (`$&` not expanded)");
      }
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
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
  runGardssalgGuestReminderO45Tests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
