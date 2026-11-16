/**
 * gardssalg-cancel.test.ts — O1-5 (audit finding R2), flag GARDSSALG_CANCEL_ENABLED.
 *
 * Covers:
 *   (t)  AK3: text pack OA-1 §4, verbatim (byte-equality), nb and en, and the
 *        two e-mails filled from it.
 *   (u)  pure rules: guestCancelMode / producerMayCancel per state.
 *   (f)  AK2 (flag off): no cancel button or link on the status page or the
 *        svar page; the cancel routes answer 404 and write nothing.
 *   (g)  guest: a wrong token (or the reference alone) cannot cancel; the
 *        right token withdraws a pending request / cancels a confirmed visit;
 *        `Origin: null` form POST accepted; cross-site POST refused (403);
 *        the producer gets exactly one e-mail; a second POST is refused
 *        cleanly; declined / expired rows cannot be cancelled.
 *   (p)  producer: cannot cancel an unconfirmed request; reason required
 *        (cancel.producer.reasonMissing); a confirmed visit is cancelled and
 *        the guest gets exactly one e-mail; a past visit cannot be cancelled.
 *   (a)  AK1: status 'cancelled' with reason, timestamp and who; the followup
 *        job neither reminds nor expires the row afterwards; attendance
 *        («Møtte») is refused on a cancelled row.
 *
 * Fixtures: test producers in an in-memory experiences DB (example.no
 * addresses); every e-mail send is stubbed. No real data is touched.
 *
 * Standalone: npx tsx src/services/gardssalg-cancel.test.ts
 * Gate: tests/test.ts imports runGardssalgCancelTests().
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** A whole UTC hour `days` ahead as an ISO instant. */
function slotAhead(days: number): string {
  const base = new Date(Date.now() + days * 24 * 3600_000);
  base.setUTCHours(11, 0, 0, 0);
  return base.toISOString();
}

interface Sent { to: string; subject: string; textContent: string; htmlContent: string }

export function runGardssalgCancelTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const bytesEq = (a: string, b: string) => Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"));

  return (async () => {
    const envKeys = [
      "EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_BOOKING_CAP_ENABLED",
      "GARDSSALG_HONEST_RECEIPT_ENABLED", "GARDSSALG_CANCEL_ENABLED", "WRITE_GUARD_FETCH_METADATA",
    ];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_BOOKING_CAP_ENABLED;
    delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
    delete process.env.GARDSSALG_CANCEL_ENABLED;
    delete process.env.WRITE_GUARD_FETCH_METADATA;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-attendance-guard"),
      require.resolve("./gardssalg-honest-receipt"),
      require.resolve("./gardssalg-cancel"),
      require.resolve("../routes/gardssalg-cancel"),
      require.resolve("../routes/opplevelser"),
      require.resolve("../routes/experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    let server: http.Server | null = null;

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const c = require("./gardssalg-cancel") as typeof import("./gardssalg-cancel");

      // ── (t) AK3: text pack OA-1 §4, verbatim (approved by Daniel 2026-11-15)
      // Do not "fix" these here: a mismatch means the code drifted.
      const OA1_S4: Record<string, { nb: string; en?: string }> = {
        "cancel.guest.button": { nb: "Avlys", en: "Cancel" },
        "cancel.guest.buttonPending": { nb: "Trekk", en: "Withdraw" },
        "cancel.guest.heading": { nb: "Avlys besøket", en: "Cancel the visit" },
        "cancel.guest.headingPending": { nb: "Trekk forespørselen", en: "Withdraw the request" },
        "cancel.guest.intro": {
          nb: "{produsent} får beskjed med en gang. Du kan ikke angre en avlysning, men du kan sende en ny forespørsel.",
          en: "{produsent} will be told right away. A cancellation cannot be undone, but you can send a new request.",
        },
        "cancel.guest.introPending": {
          nb: "{produsent} får beskjed med en gang. Du kan ikke angre, men du kan sende en ny forespørsel.",
          en: "{produsent} will be told right away. This cannot be undone, but you can send a new request.",
        },
        "cancel.reasonLabel": { nb: "Grunn (valgfritt, sendes til produsenten)", en: "Reason (optional, sent to the producer)" },
        "cancel.guest.submit": { nb: "Ja, avlys", en: "Yes, cancel" },
        "cancel.guest.submitPending": { nb: "Ja, trekk", en: "Yes, withdraw" },
        "cancel.back": { nb: "Nei, behold", en: "No, keep it" },
        "cancel.guest.done.heading": { nb: "Besøket er avlyst", en: "The visit is cancelled" },
        "cancel.guest.done.headingPending": { nb: "Forespørselen er trukket", en: "The request is withdrawn" },
        "cancel.guest.done.body": { nb: "Vi har gitt {produsent} beskjed. Referanse: {ref}.", en: "We have told {produsent}. Reference: {ref}." },
        "status.cancelledByGuest": { nb: "Avlyst av gjesten", en: "Cancelled by the guest" },
        "status.withdrawnByGuest": { nb: "Trukket av gjesten", en: "Withdrawn by the guest" },
        "status.cancelledByProducer": { nb: "Avlyst av produsenten", en: "Cancelled by the producer" },
        "cancel.producer.button": { nb: "Avlys besøket" },
        "cancel.producer.heading": { nb: "Avlys besøket {tid}" },
        "cancel.producer.intro": { nb: "Gjesten får e-post med en gang, med grunnen du skriver. Du kan ikke angre en avlysning." },
        "cancel.producer.reasonLabel": { nb: "Grunn (sendes til gjesten)" },
        "cancel.producer.reasonMissing": { nb: "Skriv en kort grunn, så gjesten vet hvorfor." },
        "cancel.producer.submit": { nb: "Ja, avlys besøket" },
        "cancel.producer.done.heading": { nb: "Besøket er avlyst" },
        "cancel.producer.done.body": { nb: "Vi har gitt {gjest} beskjed. Referanse: {ref}." },
        "cancel.toGuest.subject": { nb: "{produsent} har avlyst besøket — {ref}", en: "{produsent} has cancelled the visit — {ref}" },
        "cancel.toGuest.body": {
          nb: "Hei {gjest},\n\n{produsent} har dessverre måttet avlyse besøket {tid}. Referanse: {ref}.\n\nGrunn fra produsenten: {grunn}\n\nHvis du har lagt besøket inn i kalenderen din, må du slette det selv. Vil du prøve et annet tidspunkt, kan du sende en ny forespørsel fra profilsiden: {profilside}\n\nHilsen\nOpplevagent",
          en: "Hi {gjest},\n\nUnfortunately, {produsent} has had to cancel the visit on {tid}. Reference: {ref}.\n\nReason from the producer: {grunn}\n\nIf you added the visit to your calendar, please delete it yourself. If you would like to try another time, you can send a new request from the profile page: {profilside}\n\nBest regards,\nOpplevagent",
        },
        "cancel.toProducer.subject": { nb: "Gjesten har avlyst — {ref}" },
        "cancel.toProducer.subjectPending": { nb: "Gjesten har trukket forespørselen — {ref}" },
        "cancel.toProducer.body": {
          nb: "Hei,\n\n{gjest} har avlyst besøket {tid} ({antall} personer). Referanse: {ref}.\n\nGrunn fra gjesten: {grunn}\n\nDu trenger ikke gjøre noe. Tidspunktet er ledig igjen.\n\nHilsen\nOpplevagent",
        },
      };
      assertEq(Object.keys(c.OA1_CANCEL_TEXTS).sort(), Object.keys(OA1_S4).sort(), "t1: exactly the OA-1 §4 keys");
      for (const [k, v] of Object.entries(OA1_S4)) {
        const got = (c.OA1_CANCEL_TEXTS as Record<string, { nb: string; en?: string }>)[k];
        assertTrue(bytesEq(got.nb, v.nb), `t2: ${k} (nb) byte-equal`);
        if (v.en !== undefined) assertTrue(!!got.en && bytesEq(got.en, v.en), `t3: ${k} (en) byte-equal`);
        else assertTrue(got.en === undefined, `t3: ${k} has no English text (producer side is Norwegian)`);
      }
      assertEq([c.TO_PRODUCER_CANCELLED_PHRASE, c.TO_PRODUCER_WITHDRAWN_PHRASE], ["har avlyst besøket", "har trukket forespørselen om besøk"], "t4: the package's withdraw substitution");

      const mailBooking = { guest_name: "Kari <Test>", slot_at: "2026-12-12T12:00:00.000Z", party_size: 3, booking_ref: "GARD-20261212-ABCDE" };
      const pm = c.buildGuestCancelProducerEmail(mailBooking, "cancel", "Syk barn");
      assertEq(pm.subject, "Gjesten har avlyst — GARD-20261212-ABCDE", "t5: producer e-mail subject (cancel)");
      assertTrue(bytesEq(pm.textContent, "Hei,\n\nKari <Test> har avlyst besøket lørdag 12. desember 2026 kl. 13:00 (3 personer). Referanse: GARD-20261212-ABCDE.\n\nGrunn fra gjesten: Syk barn\n\nDu trenger ikke gjøre noe. Tidspunktet er ledig igjen.\n\nHilsen\nOpplevagent"), "t6: producer e-mail text = package body filled");
      assertTrue(pm.htmlContent.includes("Kari &lt;Test&gt; har avlyst") && !pm.htmlContent.includes("<Test>"), "t7: guest text escaped in the HTML");
      const pw = c.buildGuestCancelProducerEmail(mailBooking, "withdraw", "");
      assertEq(pw.subject, "Gjesten har trukket forespørselen — GARD-20261212-ABCDE", "t8: producer e-mail subject (withdraw)");
      assertTrue(bytesEq(pw.textContent, "Hei,\n\nKari <Test> har trukket forespørselen om besøk lørdag 12. desember 2026 kl. 13:00 (3 personer). Referanse: GARD-20261212-ABCDE.\n\nDu trenger ikke gjøre noe. Tidspunktet er ledig igjen.\n\nHilsen\nOpplevagent"), "t9: withdraw wording, and no «Grunn fra gjesten» line without a reason");
      const gm = c.buildProducerCancelGuestEmail(mailBooking, { producerName: "Sidergården", profileUrl: "https://opplevagent.no/kategori/gardssalg/produsent/sidergarden" }, "Stengt pga. storm");
      assertEq(gm.subject, "Sidergården har avlyst besøket — GARD-20261212-ABCDE", "t10: guest e-mail subject");
      assertTrue(bytesEq(gm.textContent, "Hei Kari <Test>,\n\nSidergården har dessverre måttet avlyse besøket lørdag 12. desember 2026 kl. 13:00. Referanse: GARD-20261212-ABCDE.\n\nGrunn fra produsenten: Stengt pga. storm\n\nHvis du har lagt besøket inn i kalenderen din, må du slette det selv. Vil du prøve et annet tidspunkt, kan du sende en ny forespørsel fra profilsiden: https://opplevagent.no/kategori/gardssalg/produsent/sidergarden\n\nHilsen\nOpplevagent"), "t11: guest e-mail text = package body filled");
      assertTrue(gm.htmlContent.includes('<a href="https://opplevagent.no/kategori/gardssalg/produsent/sidergarden">'), "t12: profile page is a link in the HTML");
      const gmNoProfile = c.buildProducerCancelGuestEmail(mailBooking, { producerName: "Sidergården", profileUrl: null }, "x");
      assertTrue(gmNoProfile.textContent.includes("må du slette det selv.\n\nHilsen") && !gmNoProfile.textContent.includes("profilsiden"), "t13: without a profile page only that sentence is dropped");
      const gmEn = c.buildProducerCancelGuestEmail(mailBooking, { producerName: "Sidergården", profileUrl: null }, "x", "en");
      assertEq(gmEn.subject, "Sidergården has cancelled the visit — GARD-20261212-ABCDE", "t14: English subject (kept for the language switch)");

      // ── (u) pure rules ──────────────────────────────────────────────────
      const row = (status: string, pre_status: string, slot_at = slotAhead(5), respond_token: string | null = "rt") =>
        ({ status, pre_status, slot_at, respond_token }) as any;
      assertEq(
        ["awaiting_provider", "time_suggested", "provider_confirmed", "provider_declined", "expired"].map((p) => c.guestCancelMode(row("reserved", p))),
        ["withdraw", "withdraw", "cancel", null, null],
        "u1: guest: withdraw before the answer, cancel after confirmation, nothing after decline/expiry",
      );
      assertEq(c.guestCancelMode(row("cancelled", "provider_confirmed")), null, "u2: already cancelled -> nothing");
      assertEq(c.guestCancelMode(row("confirmed_attended", "provider_confirmed")), null, "u3: resolved -> nothing");
      assertEq(c.guestCancelMode(row("reserved", "provider_confirmed", "2020-01-01T10:00:00.000Z")), null, "u4: confirmed visit in the past -> nothing");
      assertEq(c.guestCancelMode(row("reserved", "awaiting_provider", slotAhead(5), null)), null, "u5: legacy row -> nothing");
      assertEq(
        ["awaiting_provider", "time_suggested", "provider_confirmed", "provider_declined", "expired"].map((p) => c.producerMayCancel(row("reserved", p))),
        [false, false, true, false, false],
        "u6: producer: only a confirmed visit",
      );
      assertEq(c.producerMayCancel(row("reserved", "provider_confirmed", "2020-01-01T10:00:00.000Z")), false, "u7: producer: not after the visit time");
      assertEq(c.normaliseCancelReason("  " + "x".repeat(600) + " "), "x".repeat(500), "u8: reason trimmed and capped at 500");
      assertEq(c.normaliseCancelReason(["a"]), "", "u9: non-string reason -> empty");

      // ── fixtures ────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence)
         VALUES ('gc-p1', 'Avlysningstest AS', 'experiences', 'Vestland', 'Voss', 'sideri', 'post@gc-p1.example.no', 1, 0,
            'gc-test-p1', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      ).run();
      const store = require("./booking-store") as typeof import("./booking-store");
      const sent: Sent[] = [];
      emailSvc.sendEmail = async (m: any) => {
        sent.push({ to: m.to, subject: m.subject, textContent: m.textContent, htmlContent: m.htmlContent });
        return { success: true, messageId: "stub" };
      };
      const settle = () => new Promise((res) => setTimeout(res, 30));
      const rowOf = (ref: string) => store.getBookingByRef(ref)!;
      const cancelCols = (ref: string) =>
        db.prepare("SELECT status, cancelled_by, cancel_reason, cancelled_at, resolved_at FROM gardssalg_bookings WHERE booking_ref = ?").get(ref) as any;
      let n = 0;
      const book = (slot = slotAhead(6)) => {
        n++;
        return store.createBooking({
          provider_id: "gc-p1", slot_at: slot, party_size: 2,
          guest_name: `Gjest ${n}`, guest_email: `gjest-${n}@example.no`,
        });
      };

      // ── server ──────────────────────────────────────────────────────────
      const app = express();
      app.use(express.json());
      app.use((require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any);
      server = http.createServer(app);
      await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
      const port = (server.address() as AddressInfo).port;
      const request = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; location: string; text: string }>((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port, method, path, headers: {
            ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
            host: `127.0.0.1:${port}`,
            ...headers,
          } }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (ch) => (data += ch));
            res.on("end", () => resolve({ status: res.statusCode || 0, location: String(res.headers.location || ""), text: data }));
          });
          req.on("error", reject);
          if (body !== undefined) req.write(body);
          req.end();
        });
      const get = (path: string) => request("GET", path);
      const postForm = async (path: string, form: Record<string, string>, headers: Record<string, string> = { origin: "null" }) => {
        const r = await request("POST", path, new URLSearchParams(form).toString(), headers);
        await settle();
        return r;
      };
      const statusPath = (b: { booking_ref: string; guest_status_token: string | null }) =>
        `/kategori/gardssalg/status/${encodeURIComponent(b.booking_ref)}/${b.guest_status_token}`;
      const svarPathOf = (b: { respond_token: string | null }) => `/kategori/gardssalg/svar/${b.respond_token}`;

      // ── (f) AK2: flag off ───────────────────────────────────────────────
      const off = book();
      const offConfirmed = book();
      store.producerRespondConfirm(String(offConfirmed.respond_token));
      for (const [label, b] of [["pending", off], ["confirmed", offConfirmed]] as const) {
        const sp = await get(statusPath(b));
        assertTrue(sp.status === 200 && !sp.text.includes("/avlys") && !sp.text.includes(">Avlys<") && !sp.text.includes(">Trekk<"), `f1: flag off, status page (${label}): no cancel button`);
        const sv = await get(svarPathOf(b));
        assertTrue(sv.status === 200 && !sv.text.includes("/avlys") && !sv.text.includes("Avlys besøket"), `f2: flag off, svar page (${label}): no cancel button`);
      }
      assertEq((await get(`${statusPath(offConfirmed)}/avlys`)).status, 404, "f3: flag off: guest cancel page 404");
      assertEq((await postForm(`${statusPath(offConfirmed)}/avlys`, { reason: "x" })).status, 404, "f4: flag off: guest cancel POST 404");
      assertEq((await get(`${svarPathOf(offConfirmed)}/avlys`)).status, 404, "f5: flag off: producer cancel page 404");
      assertEq((await postForm(`${svarPathOf(offConfirmed)}/avlys`, { reason: "x" })).status, 404, "f6: flag off: producer cancel POST 404");
      assertEq([rowOf(offConfirmed.booking_ref).status, sent.length], ["reserved", 0], "f7: flag off: nothing written, no e-mail");

      process.env.GARDSSALG_CANCEL_ENABLED = "true";

      // ── (g) guest ───────────────────────────────────────────────────────
      const pending = book();
      const pendingStatus = statusPath(pending);
      const sp1 = await get(pendingStatus);
      assertTrue(sp1.text.includes(`<form method="GET" action="${pendingStatus}/avlys"><button type="submit" class="act-btn act-secondary">Trekk</button></form>`), "g1: flag on: status page offers «Trekk» before the producer answers");
      const wrongTok = `/kategori/gardssalg/status/${encodeURIComponent(pending.booking_ref)}/${"0".repeat(32)}/avlys`;
      assertEq((await get(wrongTok)).status, 404, "g2: wrong guest token: cancel page 404");
      assertEq((await postForm(wrongTok, { reason: "x" })).status, 404, "g3: wrong guest token: POST 404");
      assertEq((await postForm(`/kategori/gardssalg/status/${encodeURIComponent(pending.booking_ref)}/avlys`, {})).status, 404, "g4: reference alone: POST 404");
      assertEq([rowOf(pending.booking_ref).status, sent.length], ["reserved", 0], "g5: nothing written, no e-mail without the token");

      const form1 = await get(`${pendingStatus}/avlys`);
      assertTrue(
        form1.text.includes("<h1>Trekk forespørselen</h1>")
        && form1.text.includes("Avlysningstest AS får beskjed med en gang. Du kan ikke angre, men du kan sende en ny forespørsel.")
        && form1.text.includes(">Grunn (valgfritt, sendes til produsenten)</label>")
        && form1.text.includes(">Ja, trekk</button>")
        && form1.text.includes(`href="${pendingStatus}">Nei, behold</a>`)
        && form1.text.includes(`<form method="POST" action="${pendingStatus}/avlys"`)
        && !/<textarea[^>]*required/.test(form1.text),
        "g6: withdraw form: pending texts, optional reason, plain form POST",
      );

      const xs = await postForm(`${pendingStatus}/avlys`, { reason: "x" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
      assertEq([xs.status, rowOf(pending.booking_ref).status, sent.length], [403, "reserved", 0], "g7: cross-site POST refused (403), nothing written");

      const w = await postForm(`${pendingStatus}/avlys`, { reason: "" }, { origin: "null" });
      assertEq([w.status, w.location], [303, `${pendingStatus}?done=avlyst`], "g8: `Origin: null` form POST accepted -> 303 ?done=avlyst");
      const wc = cancelCols(pending.booking_ref);
      assertEq([wc.status, wc.cancelled_by, wc.cancel_reason], ["cancelled", "guest", null], "g9: status cancelled, by guest, no reason");
      assertTrue(!!wc.cancelled_at && wc.cancelled_at === wc.resolved_at, "g10: cancelled_at stamped (resolved_at too, for the 30-day sweep)");
      assertEq(sent.length, 1, "g11: the producer got exactly one e-mail");
      assertEq([sent[0]?.to, sent[0]?.subject], ["post@gc-p1.example.no", `Gjesten har trukket forespørselen — ${pending.booking_ref}`], "g12: withdraw e-mail to the producer");
      assertTrue(!!sent[0] && sent[0].textContent.includes("har trukket forespørselen om besøk") && !sent[0].textContent.includes("Grunn fra gjesten"), "g13: withdraw wording, no reason line");
      const done1 = await get(`${pendingStatus}?done=avlyst`);
      assertTrue(done1.text.includes("Status: <strong>Trukket av gjesten</strong>"), "g14: status page: status.withdrawnByGuest");
      assertTrue(done1.text.includes(`<strong>Forespørselen er trukket</strong><br>Vi har gitt Avlysningstest AS beskjed. Referanse: ${pending.booking_ref}.`), "g15: done heading (pending) + done body");
      assertTrue(!done1.text.includes("/avlys"), "g16: no cancel button on a cancelled row");
      const again = await postForm(`${pendingStatus}/avlys`, { reason: "igjen" });
      assertEq([again.status, again.location, sent.length, cancelCols(pending.booking_ref).cancel_reason], [303, pendingStatus, 1, null], "g17: second POST refused cleanly: no second e-mail, nothing rewritten");
      assertEq((await get(`${pendingStatus}/avlys`)).location, pendingStatus, "g18: cancel page on a cancelled row -> back to the status page");

      // Guest cancels a confirmed visit, with a reason.
      const conf = book();
      store.producerRespondConfirm(String(conf.respond_token));
      const confStatus = statusPath(conf);
      assertTrue((await get(confStatus)).text.includes(">Avlys</button>"), "g19: confirmed visit: status page offers «Avlys»");
      const form2 = await get(`${confStatus}/avlys`);
      assertTrue(form2.text.includes("<h1>Avlys besøket</h1>") && form2.text.includes("Du kan ikke angre en avlysning, men du kan sende en ny forespørsel.") && form2.text.includes(">Ja, avlys</button>"), "g20: cancel form: confirmed texts");
      sent.length = 0;
      await postForm(`${confStatus}/avlys`, { reason: "  Bilen streiket  " });
      assertEq([cancelCols(conf.booking_ref).status, cancelCols(conf.booking_ref).cancel_reason], ["cancelled", "Bilen streiket"], "g21: reason stored (trimmed)");
      assertEq(sent.length, 1, "g22: exactly one e-mail");
      assertEq(sent[0]?.subject, `Gjesten har avlyst — ${conf.booking_ref}`, "g23: cancel subject");
      assertTrue(!!sent[0] && sent[0].textContent.includes("har avlyst besøket") && sent[0].textContent.includes("Grunn fra gjesten: Bilen streiket"), "g24: cancel wording + reason line");
      const done2 = await get(`${confStatus}?done=avlyst`);
      assertTrue(done2.text.includes("Status: <strong>Avlyst av gjesten</strong>") && done2.text.includes("<strong>Besøket er avlyst</strong>") && !done2.text.includes("velkommen!"), "g25: status.cancelledByGuest + done heading, no «bekreftet» note");

      // Declined / expired rows: nothing to cancel.
      const declined = book();
      store.producerRespondDecline(String(declined.respond_token));
      const expired = book();
      db.prepare("UPDATE gardssalg_bookings SET pre_status = 'expired' WHERE booking_ref = ?").run(expired.booking_ref);
      sent.length = 0;
      for (const [label, b] of [["declined", declined], ["expired", expired]] as const) {
        const page = await get(statusPath(b));
        assertTrue(!page.text.includes("/avlys"), `g26: ${label}: no cancel button`);
        const p = await postForm(`${statusPath(b)}/avlys`, { reason: "x" });
        assertEq([p.status, p.location, rowOf(b.booking_ref).status], [303, statusPath(b), "reserved"], `g27: ${label}: POST refused, nothing written`);
      }
      assertEq(sent.length, 0, "g28: no e-mail for refused cancellations");

      // ── (p) producer ────────────────────────────────────────────────────
      const unconf = book();
      const unconfSvar = svarPathOf(unconf);
      assertTrue(!(await get(unconfSvar)).text.includes("/avlys"), "p1: unconfirmed request: no «Avlys besøket» on the svar page");
      assertEq((await get(`${unconfSvar}/avlys`)).location, unconfSvar, "p2: unconfirmed: cancel page -> back to the svar page");
      const pu = await postForm(`${unconfSvar}/avlys`, { reason: "Kan ikke" });
      assertEq([pu.location, rowOf(unconf.booking_ref).status, sent.length], [unconfSvar, "reserved", 0], "p3: producer cannot cancel an unconfirmed request");
      assertEq((await postForm(`/kategori/gardssalg/svar/${"f".repeat(32)}/avlys`, { reason: "x" })).status, 404, "p4: unknown respond token -> 404");

      const pc = book();
      store.producerRespondConfirm(String(pc.respond_token));
      const pcSvar = svarPathOf(pc);
      assertTrue((await get(pcSvar)).text.includes(`<form method="GET" action="${pcSvar}/avlys"><button type="submit" class="act-btn act-secondary">Avlys besøket</button></form>`), "p5: confirmed visit: svar page offers «Avlys besøket»");
      const pform = await get(`${pcSvar}/avlys`);
      const tid = (require("./gardssalg-honest-receipt") as typeof import("./gardssalg-honest-receipt")).formatOsloInstant(pc.slot_at, "nb");
      assertTrue(
        pform.text.includes(`<h1>Avlys besøket ${tid}</h1>`)
        && pform.text.includes("Gjesten får e-post med en gang, med grunnen du skriver. Du kan ikke angre en avlysning.")
        && pform.text.includes(">Grunn (sendes til gjesten)</label>")
        && /<textarea[^>]*required/.test(pform.text)
        && pform.text.includes(">Ja, avlys besøket</button>")
        && pform.text.includes(`href="${pcSvar}">Nei, behold</a>`),
        "p6: producer form: §4.2 texts, reason required",
      );
      const blank = await postForm(`${pcSvar}/avlys`, { reason: "   " });
      assertEq([blank.status, blank.location, rowOf(pc.booking_ref).status, sent.length], [303, `${pcSvar}/avlys?error=grunn`, "reserved", 0], "p7: blank reason -> refused, nothing written, no e-mail");
      assertTrue((await get(`${pcSvar}/avlys?error=grunn`)).text.includes(`<div class="bekreft-banner warn" role="alert">Skriv en kort grunn, så gjesten vet hvorfor.</div>`), "p8: cancel.producer.reasonMissing shown");
      const pok = await postForm(`${pcSvar}/avlys`, { reason: "Stengt pga. storm" }, { origin: "null" });
      assertEq([pok.status, pok.location], [303, `${pcSvar}?done=avlyst`], "p9: `Origin: null` form POST accepted");
      const pcc = cancelCols(pc.booking_ref);
      assertEq([pcc.status, pcc.cancelled_by, pcc.cancel_reason], ["cancelled", "producer", "Stengt pga. storm"], "p10: status cancelled, by producer, with reason");
      assertEq(sent.length, 1, "p11: the guest got exactly one e-mail");
      assertEq([sent[0]?.to, sent[0]?.subject], [pc.guest_email, `Avlysningstest AS har avlyst besøket — ${pc.booking_ref}`], "p12: cancel.toGuest.subject");
      assertTrue(!!sent[0] && sent[0].textContent.includes("Grunn fra produsenten: Stengt pga. storm") && sent[0].textContent.includes("fra profilsiden: https://opplevagent.no/kategori/gardssalg/produsent/gc-test-p1"), "p13: reason and profile page in the guest e-mail");
      const pdone = await get(`${pcSvar}?done=avlyst`);
      assertTrue(pdone.text.includes("Status: <strong>Avlyst av produsenten</strong>") && pdone.text.includes(`<strong>Besøket er avlyst</strong><br>Vi har gitt ${pc.guest_name} beskjed. Referanse: ${pc.booking_ref}.`), "p14: svar page: status.cancelledByProducer + done texts");
      const pagain = await postForm(`${pcSvar}/avlys`, { reason: "igjen" });
      assertEq([pagain.location, sent.length, cancelCols(pc.booking_ref).cancel_reason], [pcSvar, 1, "Stengt pga. storm"], "p15: second POST refused: no second e-mail");
      const gstat = await get(statusPath(pc));
      assertTrue(gstat.text.includes("Status: <strong>Avlyst av produsenten</strong>") && !gstat.text.includes("/avlys"), "p16: guest status page shows status.cancelledByProducer, no button");

      const pastConf = book("2020-01-06T12:00:00.000Z");
      store.producerRespondConfirm(String(pastConf.respond_token));
      db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_confirmed' WHERE booking_ref = ?").run(pastConf.booking_ref);
      const pp = await postForm(`${svarPathOf(pastConf)}/avlys`, { reason: "for sent" });
      assertEq([pp.location, rowOf(pastConf.booking_ref).status], [svarPathOf(pastConf), "reserved"], "p17: a visit whose time has passed cannot be cancelled");

      // ── (a) AK1: the followup job leaves a cancelled row alone ──────────
      const fu = book(slotAhead(20));
      const longAgo = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
      db.prepare("UPDATE gardssalg_bookings SET notify_sent_at = ?, created_at = ? WHERE booking_ref = ?").run(longAgo, longAgo, fu.booking_ref);
      const later = new Date(Date.now() + 5 * 24 * 3600_000); // past the 60 h expiry from the clock floor
      const before = store.countBookingFollowupsDue(later).would_expire;
      assertTrue(before >= 1, "a1: before cancellation the job would expire the row (control)");
      sent.length = 0;
      await postForm(`${statusPath(fu)}/avlys`, { reason: "Ombestemte meg" });
      const fuBefore = cancelCols(fu.booking_ref);
      assertEq([fuBefore.status, fuBefore.cancel_reason, !!fuBefore.cancelled_at], ["cancelled", "Ombestemte meg", true], "a2 (AK1): status cancelled with reason and timestamp");
      assertEq(store.countBookingFollowupsDue(later).would_expire, before - 1, "a3: dry run no longer counts the row");
      sent.length = 0;
      await store.processBookingFollowups(later);
      await store.processBookingFollowups(new Date(Date.now() + 30 * 24 * 3600_000));
      const fuAfter = rowOf(fu.booking_ref);
      assertEq([fuAfter.status, fuAfter.pre_status, fuAfter.reminder_sent_at, fuAfter.expired_guest_notified_at], ["cancelled", "awaiting_provider", null, null], "a4 (AK1): followup job: no reminder, no expiry on the cancelled row");
      assertTrue(!sent.some((m) => m.subject.includes(fu.booking_ref)), "a5: no followup e-mail for the cancelled row");

      // Attendance refused on a cancelled (formerly confirmed) visit.
      const att = book("2020-02-03T12:00:00.000Z");
      store.producerRespondConfirm(String(att.respond_token));
      db.prepare("UPDATE gardssalg_bookings SET pre_status = 'provider_confirmed', status = 'cancelled' WHERE booking_ref = ?").run(att.booking_ref);
      assertEq(store.resolveBooking(att.confirm_token, "confirmed_attended", "gc-test"), null, "a6: resolveBooking refuses «Møtte» on a cancelled row");
      const bk = await postForm(`/kategori/gardssalg/bekreft/${att.confirm_token}`, { action: "attended" });
      assertEq([bk.location.endsWith("?error=ugyldig"), rowOf(att.booking_ref).status, rowOf(att.booking_ref).billable], [true, "cancelled", 0], "a7: bekreft POST attended on a cancelled row refused, billable 0");

      delete process.env.GARDSSALG_CANCEL_ENABLED;
      assertEq((await get(`${statusPath(fu)}/avlys`)).status, 404, "f8: flag switched off again: routes inert");
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
      if (server) await new Promise<void>((res) => server!.close(() => res()));
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
  runGardssalgCancelTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
