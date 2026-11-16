/**
 * gardssalg-honest-receipt.test.ts — O1-2 (audit findings R3, R4, G13),
 * flag GARDSSALG_HONEST_RECEIPT_ENABLED.
 *
 * Covers:
 *   (t) AK3: every O1-2 text is verbatim from text package OA-1 §1.1–1.3,
 *       Norwegian and English (the expected strings below are copied from
 *       A2A marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-1.md).
 *   (f) the flag is on only for the exact string "true".
 *   (o) AK1, flag off: receipt e-mail (subject, text body, .ics attachment),
 *       confirmed e-mail (no attachment, no new line), receipt page, .ics
 *       download and POST /book message are exactly today's; the page is
 *       byte-identical for unset vs "false" vs "1".
 *   (n) AK2, flag on: the receipt says "received" and carries no .ics; no
 *       .ics anywhere (mail, download, page link) before the producer has
 *       confirmed; the producer's confirmation (svar page) sends the .ics
 *       with LOCATION and the OA-1 summary/description; an accepted new time
 *       (gjestesvar page) sends a NEW .ics with the new time.
 *   (i) ics helpers: TEXT escaping and 75-octet folding.
 *
 * Standalone: npx tsx src/services/gardssalg-honest-receipt.test.ts
 * Gate: tests/test.ts imports runGardssalgHonestReceiptTests().
 */

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Text package OA-1 §1, verbatim (AK3). Do not "fix" these in the test: a
// mismatch means the code drifted from the approved wording.
const OA1_EXPECTED: Record<string, { nb: string; en: string }> = {
  "receipt.pageTitle": { nb: "Forespørselen er mottatt | Opplevagent", en: "Request received | Opplevagent" },
  "receipt.heading": { nb: "Vi har mottatt forespørselen", en: "We have received your request" },
  "receipt.lead": {
    nb: "Besøket er ikke bekreftet ennå. {produsent} har fått forespørselen og svarer innen {frist}. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått.",
    en: "Your visit is not confirmed yet. {produsent} has received the request and will reply by {frist}. We will email you when the producer has confirmed, suggested another time or declined.",
  },
  "receipt.statusLink": { nb: "Se status for forespørselen", en: "See the status of your request" },
  "receipt.formMessage": {
    nb: "Forespørselen er sendt. Vi sender en kvittering til {e-post}.",
    en: "Your request has been sent. We are emailing a receipt to {e-post}.",
  },
  "receipt.email.subject": { nb: "Vi har mottatt forespørselen din — {ref}", en: "We have received your request — {ref}" },
  "receipt.email.body": {
    nb: `Hei {gjest},

Vi har mottatt forespørselen din om besøk hos {produsent}. Besøket er ikke bekreftet ennå.

Referanse: {ref}
Tidspunkt du ba om: {tid}
Antall: {antall}
Din kommentar: {kommentar}

Produsenten har fått forespørselen og svarer innen {frist}. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått. Svarer ikke produsenten innen fristen, utløper forespørselen, og du får beskjed.

Du kan se status når som helst her: {statusside}

Har du spørsmål, svarer du på denne e-posten.

Hilsen
Opplevagent`,
    en: `Hi {gjest},

We have received your request to visit {produsent}. The visit is not confirmed yet.

Reference: {ref}
Time you asked for: {tid}
Guests: {antall}
Your note: {kommentar}

The producer has received the request and will reply by {frist}. We will email you when the producer has confirmed, suggested another time or declined. If the producer does not reply by then, the request expires and we will let you know.

You can check the status at any time here: {statusside}

If you have questions, reply to this email.

Best regards,
Opplevagent`,
  },
  "ics.summary": { nb: "Besøk hos {produsent} — {ref}", en: "Visit to {produsent} — {ref}" },
  "ics.description": {
    nb: "Besøk avtalt via opplevagent.no. Referanse: {ref}. Status og avlysning: {statusside}",
    en: "Visit arranged via opplevagent.no. Reference: {ref}. Status and cancellation: {statusside}",
  },
  "ics.location": { nb: "{sted}", en: "{sted}" },
  "confirmed.icsLine": {
    nb: "Kalenderfilen er lagt ved, slik at du kan legge besøket inn i kalenderen din.",
    en: "A calendar file is attached so you can add the visit to your calendar.",
  },
  "confirmed.newTimeIcsLine": {
    nb: "Kalenderfilen med det nye tidspunktet er lagt ved. Slett den gamle avtalen hvis du har lagt den inn.",
    en: "A calendar file with the new time is attached. Please delete the old entry if you added one.",
  },
};

interface Sent {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  attachments?: Array<{ filename: string; content: string; contentType: string }>;
  hasAttachmentsKey: boolean;
}

function osloNakedDaysAhead(days: number, hhmm: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now() + days * 24 * 3600_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${hhmm}`;
}

const nbFull = (iso: string) =>
  new Date(iso).toLocaleString("nb-NO", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Oslo" });

export function runGardssalgHonestReceiptTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const envKeys = ["EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED", "APP_URL"];
    const prevEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) prevEnv[k] = process.env[k];
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.BOOKING_DISPATCH_ENABLED = "true";
    delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
    delete process.env.APP_URL;

    const cachePaths = [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./booking-store"),
      require.resolve("./gardssalg-booking-followup"),
      require.resolve("./gardssalg-honest-receipt"),
      require.resolve("../routes/opplevelser"),
      require.resolve("../routes/experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
    const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
    const origSend = emailSvc.sendEmail;
    let server: http.Server | null = null;
    const setFlag = (v: string | undefined) => {
      if (v === undefined) delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
      else process.env.GARDSSALG_HONEST_RECEIPT_ENABLED = v;
    };

    try {
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded */ }
      const hr = require("./gardssalg-honest-receipt") as typeof import("./gardssalg-honest-receipt");

      // ── (t) AK3: verbatim texts ─────────────────────────────────────────
      assertEq(Object.keys(hr.OA1_RECEIPT_TEXTS).sort(), Object.keys(OA1_EXPECTED).sort(), "t1: exactly the OA-1 §1 keys");
      for (const [key, exp] of Object.entries(OA1_EXPECTED)) {
        const k = key as keyof typeof hr.OA1_RECEIPT_TEXTS;
        assertEq(hr.oa1Text(k, "nb"), exp.nb, `t2: ${key} (nb) verbatim`);
        assertEq(hr.oa1Text(k, "en"), exp.en, `t3: ${key} (en) verbatim`);
      }
      assertEq(hr.receiptFormMessage("a@b.no"), "Forespørselen er sendt. Vi sender en kvittering til a@b.no.", "t4: formMessage filled (nb)");
      assertEq(hr.receiptFormMessage("a@b.no", "en"), "Your request has been sent. We are emailing a receipt to a@b.no.", "t5: formMessage filled (en)");

      // ── (f) flag parsing ────────────────────────────────────────────────
      for (const v of [undefined, "", "false", "1", "TRUE", "yes"]) {
        setFlag(v);
        assertEq(hr.honestReceiptEnabled(), false, `f1: flag ${JSON.stringify(v)} -> off`);
      }
      setFlag("true");
      assertEq(hr.honestReceiptEnabled(), true, "f2: flag \"true\" -> on");
      setFlag(undefined);

      // ── (i) ics helpers ─────────────────────────────────────────────────
      assertEq(hr.icsEscapeText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne", "i1: TEXT escaping");
      const longLine = "DESCRIPTION:" + "æ".repeat(80);
      const folded = hr.icsFold(longLine);
      assertTrue(folded.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75), "i2: folded lines <= 75 octets");
      assertEq(hr.icsUnfold(folded), longLine, "i3: unfold restores the line");
      assertEq(hr.composeSted({ adresse: " Gardsvegen 1 ", postnummer: "5700", poststed: "Voss" }), "Gardsvegen 1, 5700 Voss", "i4: {sted}");
      assertEq(hr.dropFristSentences(OA1_EXPECTED["receipt.lead"].nb), "Besøket er ikke bekreftet ennå. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått.", "i6: dropFristSentences (nb lead)");
      assertEq(hr.dropFristSentences(OA1_EXPECTED["receipt.lead"].en), "Your visit is not confirmed yet. We will email you when the producer has confirmed, suggested another time or declined.", "i7: dropFristSentences (en lead)");
      assertEq(hr.dropFristSentences("Ingen frist her."), "Ingen frist her.", "i8: dropFristSentences leaves other text alone");
      assertEq(hr.composeSted({ adresse: null, postnummer: null, poststed: "Voss" }), "Voss", "i5: {sted} partial");

      // ── fixtures ────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
            slug, enrichment_state, verification_status, source, confidence, adresse, postnummer, poststed)
         VALUES ('hr-p1', 'Testsideri AS', 'experiences', 'Vestland', 'Voss', 'sideri', 'post@testsideri.no', 1, 0,
            'hr-testsideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 'Gardsvegen 1', '5700', 'Voss')`,
      ).run();
      const bookingStore = require("./booking-store") as typeof import("./booking-store");

      const sends: Sent[] = [];
      emailSvc.sendEmail = async (o: any) => {
        sends.push({
          to: o.to, subject: o.subject, htmlContent: o.htmlContent || "", textContent: o.textContent || "",
          attachments: o.attachments, hasAttachmentsKey: Object.prototype.hasOwnProperty.call(o, "attachments"),
        });
        return { success: true, messageId: "stub" };
      };
      const guestMails = (to: string) => sends.filter((s) => s.to === to);
      const settle = () => new Promise((r) => setTimeout(r, 30));

      const app = express();
      app.use(express.json());
      app.use("/api/opplevelser", (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any);
      app.use((require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any);
      server = http.createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const book = async (email: string, notes?: string) => {
        const r = await fetch(`${base}/api/opplevelser/book`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider_id: "hr-p1", slot_at: osloNakedDaysAhead(10, "13:00"), party_size: 3,
            guest_name: "Kari", guest_email: email, ...(notes ? { notes } : {}),
          }),
        });
        const body: any = await r.json();
        await settle();
        return { status: r.status, body, booking: bookingStore.getBookingByRef(body.booking_ref)! };
      };
      // O1-4 (R8): `t` is the guest's token; without it the page and the
      // download carry no guest name/e-mail/note (gardssalg-attendance-guard.test.ts).
      const page = async (ref: string, t?: string | null) =>
        (await fetch(`${base}/kategori/gardssalg/book/hr-testsideri/confirm/${encodeURIComponent(ref)}${t ? `?t=${encodeURIComponent(t)}` : ""}`)).text();
      const icsDownload = async (ref: string, t?: string | null) => {
        const r = await fetch(`${base}/api/opplevelser/book/${encodeURIComponent(ref)}/ics${t ? `?t=${encodeURIComponent(t)}` : ""}`);
        return { status: r.status, text: await r.text() };
      };
      const postForm = async (path: string, form: Record<string, string>) => {
        await fetch(`${base}${path}`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString(), redirect: "manual",
        });
        await settle();
      };
      const statusUrlOf = (b: { booking_ref: string; guest_status_token: string | null }) =>
        `https://opplevagent.no/kategori/gardssalg/status/${encodeURIComponent(b.booking_ref)}/${b.guest_status_token}`;

      // ── (o) AK1: flag off = today ───────────────────────────────────────
      setFlag(undefined);
      {
        const { status, body, booking: b } = await book("off@example.no", "Vi gleder oss");
        assertEq(status, 201, "o1: POST /book 201");
        assertEq(body.message, "Påmelding registrert! Bekreftelse sendes til off@example.no.", "o2: POST /book message unchanged");
        const [m] = guestMails("off@example.no");
        assertEq(m?.subject, `Bekreftelse på påmelding — ${b.booking_ref}`, "o3: receipt subject unchanged");
        assertEq(
          m?.textContent,
          `Hei Kari,\n\nDin påmelding er registrert.\nBookingref: ${b.booking_ref}\nDato/tid: ${nbFull(b.slot_at)}\nAntall: 3\nDin kommentar: Vi gleder oss\n\nProdusenten er varslet om forespørselen og svarer på e-post — du får beskjed så snart reservasjonen er bekreftet eller besvart.\nStatus for reservasjonen: ${statusUrlOf(b)}\n\nHilsen\nOpplevagent`,
          "o4: receipt text body unchanged",
        );
        assertTrue(m?.htmlContent.includes("<p>En kalenderinvitasjon (ICS) er vedlagt denne e-posten.</p>") === true, "o5: receipt html unchanged (ICS sentence)");
        assertEq(m?.attachments?.length, 1, "o6: receipt still carries the .ics");
        assertTrue(/METHOD:REQUEST[\s\S]*SUMMARY:Gårdssalg & smaking — ref /.test(m?.attachments?.[0]?.content ?? ""), "o7: legacy .ics content");

        const pOff = await page(b.booking_ref, b.guest_status_token);
        assertTrue(pOff.includes("<title>Reservasjon bekreftet | Opplevagent</title>"), "o8: page title unchanged");
        assertTrue(pOff.includes("<h1>Reservasjon bekreftet</h1>"), "o9: page heading unchanged");
        assertTrue(pOff.includes(`<p class="hint">En bekreftelse er sendt til off@example.no.</p>\n    <a class="ics-link"`), "o10: page hint + .ics link unchanged");
        assertTrue(!pOff.includes("Besøket er ikke bekreftet"), "o11: no OA-1 lead with the flag off");
        for (const v of ["false", "1"]) {
          setFlag(v);
          assertEq(await page(b.booking_ref, b.guest_status_token), pOff, `o12: page byte-identical with flag ${JSON.stringify(v)}`);
        }
        setFlag(undefined);
        const d = await icsDownload(b.booking_ref, b.guest_status_token);
        assertEq(d.status, 200, "o13: .ics download before confirmation still 200 (unchanged)");
        assertTrue(d.text.includes("ATTENDEE;CN=Kari:mailto:off@example.no"), "o14: legacy download content");

        sends.length = 0;
        await postForm(`/kategori/gardssalg/svar/${b.respond_token}`, { action: "bekreft" });
        const [c] = guestMails("off@example.no");
        assertEq(c?.subject, `Reservasjonen er bekreftet — ${b.booking_ref}`, "o15: confirmed subject unchanged");
        assertEq(c?.hasAttachmentsKey, false, "o16: confirmed mail has no attachment with the flag off");
        assertEq(
          c?.textContent,
          `Hei Kari,\n\nProdusenten har bekreftet reservasjonen din.\nBookingref: ${b.booking_ref}\nDato/tid: ${nbFull(b.slot_at)}\nAntall: 3\nStatus: ${statusUrlOf(b)}\n\nHilsen\nOpplevagent`,
          "o17: confirmed text body unchanged",
        );
        assertTrue(c?.htmlContent.includes("</table>\n<p>Velkommen!") === true, "o18: confirmed html unchanged");
      }

      // ── (n) AK2: flag on ────────────────────────────────────────────────
      setFlag("true");
      {
        const { status, body, booking: b } = await book("on@example.no", "Vi gleder oss");
        assertEq(status, 201, "n1: POST /book 201");
        assertEq(body.message, "Forespørselen er sendt. Vi sender en kvittering til on@example.no.", "n2: POST /book message = receipt.formMessage");
        const frist = nbFull(b.respond_token_expires_at!);
        const [m] = guestMails("on@example.no");
        assertEq(m?.subject, `Vi har mottatt forespørselen din — ${b.booking_ref}`, "n3: receipt subject = receipt.email.subject");
        assertEq(
          m?.textContent,
          `Hei Kari,\n\nVi har mottatt forespørselen din om besøk hos Testsideri AS. Besøket er ikke bekreftet ennå.\n\nReferanse: ${b.booking_ref}\nTidspunkt du ba om: ${nbFull(b.slot_at)}\nAntall: 3\nDin kommentar: Vi gleder oss\n\nProdusenten har fått forespørselen og svarer innen ${frist}. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått. Svarer ikke produsenten innen fristen, utløper forespørselen, og du får beskjed.\n\nDu kan se status når som helst her: ${statusUrlOf(b)}\n\nHar du spørsmål, svarer du på denne e-posten.\n\nHilsen\nOpplevagent`,
          "n4: receipt body = OA-1 §1.2 filled",
        );
        assertTrue(m?.htmlContent.includes(`<a href="${statusUrlOf(b)}">`) === true, "n5: html receipt links the status page");
        assertEq(m?.hasAttachmentsKey, false, "n6: receipt has NO calendar file");
        assertTrue(!sends.some((s) => (s.attachments ?? []).length > 0), "n7: no e-mail carries an .ics before the producer confirmed");

        const pOn = await page(b.booking_ref, b.guest_status_token);
        assertTrue(pOn.includes("<title>Forespørselen er mottatt | Opplevagent</title>"), "n8: page title = receipt.pageTitle");
        assertTrue(pOn.includes("<h1>Vi har mottatt forespørselen</h1>"), "n9: heading = receipt.heading");
        assertTrue(pOn.includes(`<p>Besøket er ikke bekreftet ennå. Testsideri AS har fått forespørselen og svarer innen ${frist}. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått.</p>`), "n10: lead = receipt.lead filled");
        assertTrue(pOn.includes(`<p class="hint">Forespørselen er sendt. Vi sender en kvittering til on@example.no.</p>`), "n11: hint = receipt.formMessage");
        assertTrue(!pOn.includes("ics-link\" href"), "n12: no .ics link before confirmation");
        assertTrue(!pOn.includes("Reservasjon bekreftet"), "n13: page never says confirmed");
        assertEq((await icsDownload(b.booking_ref)).status, 404, "n14: no .ics download before confirmation");

        // Producer suggests a time -> still no .ics.
        sends.length = 0;
        const newSlot = osloNakedDaysAhead(12, "15:00");
        await postForm(`/kategori/gardssalg/svar/${b.respond_token}`, { action: "foresla", suggested_slot: newSlot });
        const sug = bookingStore.getBookingByRef(b.booking_ref)!;
        assertEq(sug.pre_status, "time_suggested", "n15: suggestion stored");
        assertTrue(!sends.some((s) => (s.attachments ?? []).length > 0), "n16: no .ics with a suggestion");
        assertEq((await icsDownload(b.booking_ref)).status, 404, "n17: no .ics download while a suggestion is pending");

        // Guest accepts the new time -> NEW .ics with the new time.
        sends.length = 0;
        await postForm(`/kategori/gardssalg/gjestesvar/${sug.guest_decision_token}`, { action: "aksepter" });
        const acc = bookingStore.getBookingByRef(b.booking_ref)!;
        assertEq(acc.pre_status, "provider_confirmed", "n18: accepted -> provider_confirmed");
        const [a] = guestMails("on@example.no");
        assertEq(a?.attachments?.length, 1, "n19: accepted new time -> .ics attached");
        const icsNew = hr.icsUnfold(a?.attachments?.[0]?.content ?? "");
        const newStart = new Date(acc.slot_at).toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
        assertTrue(icsNew.includes(`DTSTART:${newStart}`), "n20: the new .ics has the new time");
        assertTrue(icsNew.includes("LOCATION:Gardsvegen 1\\, 5700 Voss"), "n21: the .ics has LOCATION");
        assertTrue(a?.textContent.includes("\n\nKalenderfilen med det nye tidspunktet er lagt ved. Slett den gamle avtalen hvis du har lagt den inn.\n") === true, "n22: confirmed.newTimeIcsLine in the text mail");
        assertTrue(a?.htmlContent.includes("<p>Kalenderfilen med det nye tidspunktet er lagt ved. Slett den gamle avtalen hvis du har lagt den inn.</p>") === true, "n23: confirmed.newTimeIcsLine in the html mail");
        assertEq(a?.attachments?.[0]?.contentType, "text/calendar; charset=utf-8; method=PUBLISH", "n24: PUBLISH content type");

        // Direct confirmation on a second request.
        sends.length = 0;
        const { booking: b2 } = await book("on2@example.no");
        const [m2] = guestMails("on2@example.no");
        assertTrue(!m2?.textContent.includes("Din kommentar"), "n25: no «Din kommentar» line without a note");
        sends.length = 0;
        await postForm(`/kategori/gardssalg/svar/${b2.respond_token}`, { action: "bekreft" });
        const [c2] = guestMails("on2@example.no");
        assertEq(c2?.attachments?.length, 1, "n26: producer confirmed -> .ics attached");
        const ics2 = hr.icsUnfold(c2?.attachments?.[0]?.content ?? "");
        assertTrue(ics2.includes(`SUMMARY:Besøk hos Testsideri AS — ${b2.booking_ref}`), "n27: SUMMARY = ics.summary");
        assertTrue(ics2.includes(`DESCRIPTION:Besøk avtalt via opplevagent.no. Referanse: ${b2.booking_ref}. Status og avlysning: ${statusUrlOf(b2)}`), "n28: DESCRIPTION = ics.description");
        assertTrue(!!b2.guest_status_token && ics2.includes(b2.guest_status_token), "n28b: the e-mailed .ics (to the guest) keeps the status link");
        assertTrue(ics2.includes("LOCATION:Gardsvegen 1\\, 5700 Voss"), "n29: LOCATION = {sted}");
        assertTrue(!ics2.includes("on2@example.no") && !ics2.includes("ATTENDEE"), "n30: no guest data in the file");
        const uid2 = /UID:([^\r\n]+)/.exec(ics2)?.[1];
        assertTrue(!!uid2 && uid2 !== /UID:([^\r\n]+)/.exec(icsNew)?.[1], "n31: distinct UIDs per visit/time");
        assertTrue(c2?.textContent.includes("\n\nKalenderfilen er lagt ved, slik at du kan legge besøket inn i kalenderen din.\n") === true, "n32: confirmed.icsLine in the text mail");
        assertEq(c2?.subject, `Reservasjonen er bekreftet — ${b2.booking_ref}`, "n33: confirmed subject unchanged");

        const d2 = await icsDownload(b2.booking_ref);
        assertEq(d2.status, 200, "n34: .ics download after confirmation");
        assertTrue(hr.icsUnfold(d2.text).includes("LOCATION:Gardsvegen 1\\, 5700 Voss"), "n35: downloaded .ics has LOCATION");
        // Review B1: the download needs only the booking reference, so it
        // must never carry the guest's status credential.
        const d2u = hr.icsUnfold(d2.text);
        assertTrue(!d2u.includes(b2.guest_status_token!), "n35b: downloaded .ics has no guest status token");
        assertTrue(!d2u.includes("/status/") && !d2u.includes("DESCRIPTION"), "n35c: downloaded .ics has no status URL (no DESCRIPTION)");
        assertTrue(d2u.includes(`SUMMARY:Besøk hos Testsideri AS — ${b2.booking_ref}`), "n35d: downloaded .ics keeps SUMMARY");
        assertTrue((await page(b2.booking_ref)).includes("ics-link\" href"), "n36: page shows the .ics link once confirmed");

        // Declined request -> never an .ics.
        sends.length = 0;
        const { booking: b3 } = await book("on3@example.no");
        await postForm(`/kategori/gardssalg/svar/${b3.respond_token}`, { action: "avsla" });
        assertTrue(!sends.some((s) => (s.attachments ?? []).length > 0), "n37: declined -> no .ics in any mail");
        assertEq((await icsDownload(b3.booking_ref)).status, 404, "n38: declined -> no .ics download");

        // Review N1: no answer deadline -> still the honest receipt (no
        // legacy subject, no .ics), only the {frist} sentence dropped.
        const { booking: b4 } = await book("on4@example.no");
        expDb.prepare("UPDATE gardssalg_bookings SET respond_token_expires_at = NULL WHERE booking_id = ?").run(b4.booking_id);
        const b4n = bookingStore.getBookingByRef(b4.booking_ref)!;
        sends.length = 0;
        await bookingStore.sendBookingConfirmation(b4n);
        const [m4] = guestMails("on4@example.no");
        assertEq(m4?.subject, `Vi har mottatt forespørselen din — ${b4.booking_ref}`, "n39: null deadline -> honest subject");
        assertEq(m4?.hasAttachmentsKey, false, "n40: null deadline -> no .ics attachment");
        assertTrue(!sends.some((s) => s.subject.startsWith("Bekreftelse på påmelding")), "n41: null deadline -> never the legacy receipt");
        assertTrue(
          m4?.textContent.includes("\n\nDu får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått. Svarer ikke produsenten innen fristen, utløper forespørselen, og du får beskjed.\n\n") === true
            && !m4.textContent.includes("svarer innen") && !m4.textContent.includes("{frist}"),
          "n42: null deadline -> only the {frist} sentence dropped from the body",
        );
        const p4 = await page(b4.booking_ref);
        assertTrue(p4.includes("<p>Besøket er ikke bekreftet ennå. Du får e-post når produsenten har bekreftet, foreslått et annet tidspunkt eller avslått.</p>"), "n43: null deadline -> page lead without the {frist} sentence");
      }
    } catch (err) {
      failed++;
      failures.push(`✗ unexpected throw: ${(err as Error)?.stack || err}`);
    } finally {
      emailSvc.sendEmail = origSend;
      if (server) await new Promise<void>((r) => server!.close(() => r()));
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
  runGardssalgHonestReceiptTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    for (const f of summary.failures) console.log(f);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
