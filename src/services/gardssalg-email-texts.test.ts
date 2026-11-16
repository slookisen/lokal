/**
 * gardssalg-email-texts.test.ts — O4-2: the gårdssalg booking e-mails in one
 * text register (gardssalg-email-texts.ts), and the guest's language.
 *
 * Covers:
 *   (g)  AK1 golden: every gårdssalg guest/producer booking e-mail variant
 *        (subject, html, text, attachment) is byte-identical to the fixture
 *        tests/fixtures/gardssalg-email-golden.json, which was captured from
 *        the code BEFORE the texts moved into the register.
 *   (k)  AK2: with GARDSSALG_EMAIL_EN_ENABLED off, a booking with language
 *        "en" gets exactly the Norwegian e-mails (same golden fixture); with
 *        the flag on, a "nb" booking does too.
 *   (t)  AK3: every register key has Norwegian text; every guest key has the
 *        English text of the approved packages (OA-2 A, OA-1 §1/§4, copied
 *        below verbatim) unless it is listed in EN_NOT_IN_PACK; producer
 *        keys have no English.
 *   (e)  flag on + "en": the four status e-mails equal the OA-2 A bodies
 *        verbatim (filled), the honest receipt and the producer's
 *        cancellation use the OA-1 English, the calendar file is English,
 *        producer e-mails and the legacy receipt stay Norwegian.
 *   (l)  the guest's language: flag and value parsing, the column, and the
 *        web form / REST API / MCP default ("nb") when a booking is created.
 *
 * Fixtures: one test producer in an in-memory experiences DB (example.no
 * address); every e-mail send is stubbed. No real data is touched.
 *
 * Regenerate the golden fixture ONLY from pre-change code:
 *   GARDSSALG_EMAIL_GOLDEN_WRITE=1 npx tsx src/services/gardssalg-email-texts.test.ts
 * Standalone: npx tsx src/services/gardssalg-email-texts.test.ts
 * Gate: tests/test.ts imports runGardssalgEmailTextsTests().
 */

import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import type { AddressInfo } from "net";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export interface CapturedMail {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  attachments: Array<{ filename: string; contentType: string; content: string }> | null;
}

const GOLDEN_PATH = path.resolve(__dirname, "../../tests/fixtures/gardssalg-email-golden.json");

const PROVIDER_ID = "et-p1";
const PRODUCER_EMAIL = "post@et-testsideri.example.no";
const GUEST_EMAIL = "kari@example.no";

/** DTSTAMP is the send time; everything else in a calendar file is fixed. */
function normaliseIcs(s: string): string {
  return s.replace(/DTSTAMP:\d{8}T\d{6}Z/g, "DTSTAMP:<now>");
}

/** A fixed booking object (no DB row needed: the senders take the object). */
function fixtureBooking(over: Record<string, unknown> = {}): any {
  return {
    booking_id: "00000000-0000-4000-8000-000000000001",
    experience_id: null,
    provider_id: PROVIDER_ID,
    slot_at: "2026-12-12T12:00:00.000Z",
    party_size: 3,
    guest_name: "Kari <Nordmann> & Co",
    guest_email: GUEST_EMAIL,
    guest_phone: null,
    booking_ref: "GARD-20261212-ABCDE",
    confirm_token: "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
    source: "opplevagent",
    status: "reserved",
    resolved_by: null,
    resolved_at: null,
    commission_rate: null,
    billable: 0,
    notes: null,
    created_at: "2026-12-01T10:00:00.000Z",
    pre_status: "awaiting_provider",
    respond_token: "r0r0r0r0r0r0r0r0r0r0r0r0r0r0r0r0",
    respond_token_expires_at: "2026-12-04T10:00:00.000Z",
    respond_token_used_at: null,
    suggested_slot_at: null,
    guest_decision_token: null,
    guest_status_token: "s0s0s0s0s0s0s0s0s0s0s0s0s0s0s0s0",
    reminder_sent_at: null,
    expired_guest_notified_at: null,
    is_test: 0,
    notify_sent_at: null,
    notify_failed_at: null,
    notify_retried_at: null,
    source_client: null,
    ...over,
  };
}

/**
 * Sends every gårdssalg booking e-mail variant through the real senders /
 * builders with a stubbed mailer and returns them by variant name. `extra`
 * is merged into every guest booking (AK2 passes { guest_lang: "en" }).
 * Must run inside an environment where the modules are freshly loaded with
 * EXPERIENCES_DB_PATH=:memory:, BOOKING_DISPATCH_ENABLED=true and APP_URL unset.
 */
export async function captureGardssalgEmails(extra: Record<string, unknown> = {}): Promise<Record<string, CapturedMail>> {
  const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
  const bs = require("./booking-store") as typeof import("./booking-store");
  const cx = require("./gardssalg-cancel") as typeof import("./gardssalg-cancel");
  const origSend = emailSvc.sendEmail;
  const out: Record<string, CapturedMail> = {};
  let last: CapturedMail | null = null;
  emailSvc.sendEmail = async (o: any) => {
    last = {
      to: o.to,
      subject: o.subject,
      htmlContent: o.htmlContent ?? "",
      textContent: o.textContent ?? "",
      attachments: Array.isArray(o.attachments)
        ? o.attachments.map((a: any) => ({ filename: a.filename, contentType: a.contentType, content: normaliseIcs(String(a.content)) }))
        : null,
    };
    return { success: true, messageId: "stub" };
  };
  const setHonest = (on: boolean) => {
    if (on) process.env.GARDSSALG_HONEST_RECEIPT_ENABLED = "true";
    else delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
  };
  const take = async (name: string, fn: () => Promise<unknown>) => {
    last = null;
    await fn();
    if (!last) throw new Error(`golden capture: ${name} sent nothing`);
    out[name] = last;
  };
  const g = (over: Record<string, unknown> = {}) => fixtureBooking({ ...over, ...extra });
  const full = { notes: "Vi gleder oss <3 & lurer på parkering", guest_phone: "+47 400 00 000" };
  const bare = { notes: null, guest_status_token: null, party_size: 1, respond_token_expires_at: null };
  const suggested = {
    pre_status: "time_suggested",
    suggested_slot_at: "2026-12-13T13:00:00.000Z",
    guest_decision_token: "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
  };

  try {
    // ── Guest: receipt ────────────────────────────────────────────────────
    setHonest(false);
    await take("guest.receipt.legacy.full", () => bs.sendBookingConfirmation(g(full)));
    await take("guest.receipt.legacy.bare", () => bs.sendBookingConfirmation(g(bare)));
    setHonest(true);
    await take("guest.receipt.honest.full", () => bs.sendBookingConfirmation(g(full)));
    await take("guest.receipt.honest.bare", () => bs.sendBookingConfirmation(g(bare)));

    // ── Guest: confirmed (direct / accepted a new time; flag off / on) ────
    const conf = { pre_status: "provider_confirmed" };
    setHonest(false);
    await take("guest.confirmed.legacy.direct", () => bs.sendPrevisitConfirmedToGuest(g(conf), false));
    await take("guest.confirmed.legacy.accepted.bare", () => bs.sendPrevisitConfirmedToGuest(g({ ...conf, ...bare }), true));
    setHonest(true);
    await take("guest.confirmed.honest.direct", () => bs.sendPrevisitConfirmedToGuest(g(conf), false));
    await take("guest.confirmed.honest.accepted", () => bs.sendPrevisitConfirmedToGuest(g(conf), true));
    await take("guest.confirmed.honest.direct.bare", () => bs.sendPrevisitConfirmedToGuest(g({ ...conf, ...bare }), false));
    setHonest(false);

    // ── Guest: declined / suggestion / expired ────────────────────────────
    await take("guest.declined", () => bs.sendPrevisitDeclinedToGuest(g({ pre_status: "provider_declined" })));
    await take("guest.declined.bare", () => bs.sendPrevisitDeclinedToGuest(g({ pre_status: "provider_declined", ...bare })));
    await take("guest.suggestion", () => bs.sendSuggestionToGuest(g(suggested)));
    await take("guest.suggestion.bare", () => bs.sendSuggestionToGuest(g({ ...suggested, ...bare })));
    await take("guest.expired", () => bs.sendPrevisitExpiredToGuest(g({ pre_status: "expired" })));
    await take("guest.expired.suggested.bare", () => bs.sendPrevisitExpiredToGuest(g({ ...suggested, pre_status: "expired", ...bare })));

    // ── Guest: the producer cancelled (O1-5) ──────────────────────────────
    await take("guest.producerCancelled", async () => {
      const m = cx.buildProducerCancelGuestEmail(
        g(conf),
        { producerName: "Testsideri & Søn", profileUrl: "https://opplevagent.no/kategori/gardssalg/produsent/et-testsideri" },
        "Stengt <storm>",
      );
      await emailSvc.sendEmail({ to: GUEST_EMAIL, ...m });
    });
    await take("guest.producerCancelled.noProfile", async () => {
      const m = cx.buildProducerCancelGuestEmail(g(conf), { producerName: "Testsideri & Søn", profileUrl: null }, "Syk");
      await emailSvc.sendEmail({ to: GUEST_EMAIL, ...m });
    });

    // ── Producer: new request ─────────────────────────────────────────────
    const hours = "Lør 12–16 <helg>";
    await take("producer.new.full", () => bs.sendProducerNotification(g(full), PRODUCER_EMAIL, hours));
    await take("producer.new.noDeadline", () => bs.sendProducerNotification(g({ respond_token_expires_at: null }), PRODUCER_EMAIL, null));
    await take("producer.new.legacy", () => bs.sendProducerNotification(g({ ...bare, respond_token: null }), PRODUCER_EMAIL, "  "));

    // ── Producer: reminder / guest decision ───────────────────────────────
    await take("producer.reminder", () => bs.sendPrevisitReminderToProducer(g()));
    await take("producer.reminder.noDeadline", () => bs.sendPrevisitReminderToProducer(g(bare)));
    await take("producer.guestAccepted", () => bs.sendGuestDecisionToProducer(g({ pre_status: "provider_confirmed" }), true));
    await take("producer.guestDeclined", () => bs.sendGuestDecisionToProducer(g({ pre_status: "provider_declined" }), false));

    // ── Producer: the guest cancelled / withdrew (O1-5) ───────────────────
    await take("producer.guestCancelled", () => bs.sendGatedProducerEmail(g(), "t", () => cx.buildGuestCancelProducerEmail(g(full), "cancel", "Syk <barn>")));
    await take("producer.guestWithdrew.noReason", () => bs.sendGatedProducerEmail(g(), "t", () => cx.buildGuestCancelProducerEmail(g(bare), "withdraw", "")));
  } finally {
    emailSvc.sendEmail = origSend;
    delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
  }
  return out;
}

/** Fresh modules + in-memory DB + the test producer; runs `body`, then restores everything. */
export async function withEmailFixture<T>(body: () => Promise<T>): Promise<T> {
  const envKeys = [
    "EXPERIENCES_DB_PATH", "BOOKING_DISPATCH_ENABLED", "GARDSSALG_HONEST_RECEIPT_ENABLED",
    "GARDSSALG_EMAIL_EN_ENABLED", "APP_URL",
  ];
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) prevEnv[k] = process.env[k];
  process.env.EXPERIENCES_DB_PATH = ":memory:";
  process.env.BOOKING_DISPATCH_ENABLED = "true";
  delete process.env.GARDSSALG_HONEST_RECEIPT_ENABLED;
  delete process.env.GARDSSALG_EMAIL_EN_ENABLED;
  delete process.env.APP_URL;
  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./experience-store"),
    require.resolve("./booking-store"),
    require.resolve("./gardssalg-booking-followup"),
    require.resolve("./gardssalg-attendance-guard"),
    require.resolve("./gardssalg-honest-receipt"),
    require.resolve("./gardssalg-cancel"),
    require.resolve("../routes/opplevelser"),
    require.resolve("../routes/experiences-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);
  try {
    try {
      (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
    } catch { /* already loaded */ }
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    dbFactory.getDb("experiences").prepare(
      `INSERT INTO experience_providers
         (id, navn, vertical, fylke, kommune, producer_type, epost, booking_live, catalog_hidden,
          slug, enrichment_state, verification_status, source, confidence, adresse, postnummer, poststed)
       VALUES (?, 'Testsideri & Søn', 'experiences', 'Vestland', 'Voss', 'sideri', ?, 1, 0,
          'et-testsideri', 'raw', 'pending_verify', 'test-fixture', 'medium', 'Gardsvegen 1', '5700', 'Voss')`,
    ).run(PROVIDER_ID, PRODUCER_EMAIL);
    return await body();
  } finally {
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    try {
      (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
    } catch { /* best-effort */ }
    restoreModuleCache();
  }
}

// ─── Approved English texts, copied verbatim from the A2A text packages ─────
// OA-2 A (marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-2.md) and
// OA-1 §1.2/§1.3/§4.2. Do not "fix" these here: a mismatch means the code
// drifted from the approved wording.
const PACK_EN: Record<string, string> = {
  "greeting": "Hi {gjest},",
  "label.ref": "Reference:",
  "label.time": "Date and time:",
  "label.party": "Guests:",
  "label.note": "Your note:",
  "footer.status": "You can check the current status at any time: {statusside}",
  "signoff": "Best regards,\nOpplevagent",
  "guest.confirmed.subject": "Your visit is confirmed — {ref}",
  "guest.confirmed.lead": "{produsent} has confirmed your visit:",
  "guest.confirmed.leadAccepted": "You accepted the new time, and your visit is now confirmed:",
  "confirmed.icsLine": "A calendar file is attached so you can add the visit to your calendar.",
  "confirmed.newTimeIcsLine": "A calendar file with the new time is attached. Please delete the old entry if you added one.",
  "guest.declined.subject": "Your request could not be confirmed — {ref}",
  "guest.declined.body": "We are sorry. {produsent} could not confirm your request ({ref}, {tid}) this time.",
  "guest.alternatives": "Other producers accept visit requests. You can see them here: {oversikt}",
  "guest.suggestion.subject": "The producer suggests another time — {ref}",
  "guest.suggestion.lead": "{produsent} cannot receive you on {tid}, but suggests this time instead:",
  "guest.suggestion.reply": "Reply to the suggestion here: {svarlenke}\nYou can accept the new time or decline it.",
  "guest.suggestion.personal": "The link is personal to this request ({ref}). Please do not share it.",
  "guest.expired.subject": "Your request expired without a reply — {ref}",
  "guest.expired.body": "We are sorry. {produsent} did not reply to your request ({ref}, {tid}) in time, so it has expired.",
  "guest.expired.bodySuggested": "We are sorry. The suggested time for your request ({ref}, {tid}) was not settled in time, so the request has expired.",
  "receipt.email.subject": "We have received your request — {ref}",
  "receipt.email.body": "Hi {gjest},\n\nWe have received your request to visit {produsent}. The visit is not confirmed yet.\n\nReference: {ref}\nTime you asked for: {tid}\nGuests: {antall}\nYour note: {kommentar}\n\nThe producer has received the request and will reply by {frist}. We will email you when the producer has confirmed, suggested another time or declined. If the producer does not reply by then, the request expires and we will let you know.\n\nYou can check the status at any time here: {statusside}\n\nIf you have questions, reply to this email.\n\nBest regards,\nOpplevagent",
  "cancel.toGuest.subject": "{produsent} has cancelled the visit — {ref}",
  "cancel.toGuest.body": "Hi {gjest},\n\nUnfortunately, {produsent} has had to cancel the visit on {tid}. Reference: {ref}.\n\nReason from the producer: {grunn}\n\nIf you added the visit to your calendar, please delete it yourself. If you would like to try another time, you can send a new request from the profile page: {profilside}\n\nBest regards,\nOpplevagent",
};

// OA-2 A1–A4 e-mail bodies, verbatim from the package's code blocks.
const PACK_A1 = "Hi {gjest},\n\n{produsent} has confirmed your visit:\n\nReference: {ref}\nDate and time: {tid}\nGuests: {antall}\n\nA calendar file is attached so you can add the visit to your calendar.\n\nYou can check the current status at any time: {statusside}\n\nBest regards,\nOpplevagent";
const PACK_A2 = "Hi {gjest},\n\nWe are sorry. {produsent} could not confirm your request ({ref}, {tid}) this time.\n\nOther producers accept visit requests. You can see them here: {oversikt}\n\nBest regards,\nOpplevagent";
const PACK_A3 = "Hi {gjest},\n\n{produsent} cannot receive you on {tid}, but suggests this time instead:\n\n{nytt_tidspunkt}\n\nReply to the suggestion here: {svarlenke}\nYou can accept the new time or decline it.\n\nThe link is personal to this request ({ref}). Please do not share it.\n\nYou can check the current status at any time: {statusside}\n\nBest regards,\nOpplevagent";
const PACK_A4 = "Hi {gjest},\n\nWe are sorry. {produsent} did not reply to your request ({ref}, {tid}) in time, so it has expired.\n\nOther producers accept visit requests. You can see them here: {oversikt}\n\nBest regards,\nOpplevagent";

/** Guest keys the packages have no English for (must equal EN_NOT_IN_PACK). */
const EXPECTED_EN_MISSING = [
  "party.one", "party.many", "footer.statusLinkText", "footer.statusText",
  "receipt.legacy.subject", "receipt.legacy.lead", "receipt.legacy.textLead", "receipt.legacy.notified",
  "receipt.legacy.status", "receipt.legacy.statusText", "receipt.legacy.ics", "receipt.legacy.questions",
  "guest.confirmed.textLead", "guest.confirmed.textLeadAccepted", "guest.confirmed.welcome",
  "guest.alternativesLinkText", "guest.alternativesText", "guest.suggestion.replyLinkText", "guest.suggestion.replyText",
];

const fillPack = (t: string, vars: Record<string, string>) =>
  t.replace(/\{([a-zæøå_-]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

/** Oslo wall time `days` ahead as a naked datetime-local string (the form's format). */
function osloNakedDaysAhead(days: number, hhmm: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now() + days * 24 * 3600_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${hhmm}`;
}

export function runGardssalgEmailTextsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string, detail?: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
      if (log) console.log(`  ✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    }
  }
  const bytesEq = (a: string, b: string) => Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"));
  const firstDiff = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `first difference at ${i}: expected ${JSON.stringify(b.slice(i, i + 60))}, got ${JSON.stringify(a.slice(i, i + 60))}`;
  };
  const sameMail = (got: CapturedMail | undefined, exp: CapturedMail, label: string) => {
    if (!got) {
      assertTrue(false, `${label}: sent`);
      return;
    }
    for (const f of ["to", "subject", "htmlContent", "textContent"] as const) {
      assertTrue(bytesEq(got[f], exp[f]), `${label}: ${f} byte-identical`, bytesEq(got[f], exp[f]) ? undefined : firstDiff(got[f], exp[f]));
    }
    assertTrue(JSON.stringify(got.attachments) === JSON.stringify(exp.attachments), `${label}: attachments identical`);
  };

  return (async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as Record<string, CapturedMail>;

    await withEmailFixture(async () => {
      // ── (g) AK1: byte-identical to the pre-move capture ──────────────────
      const now = await captureGardssalgEmails();
      assertTrue(
        JSON.stringify(Object.keys(now).sort()) === JSON.stringify(Object.keys(golden).sort()),
        "g0: the same e-mail variants as the golden fixture",
      );
      for (const [name, exp] of Object.entries(golden)) sameMail(now[name], exp, `g:${name}`);

      // ── (k) AK2: language "en" with the flag off → Norwegian ─────────────
      const enOff = await captureGardssalgEmails({ guest_lang: "en" });
      for (const [name, exp] of Object.entries(golden)) sameMail(enOff[name], exp, `k:${name} (lang en, flag off)`);
      for (const v of ["", "false", "1", "TRUE", "yes"]) {
        process.env.GARDSSALG_EMAIL_EN_ENABLED = v;
        const m = await captureGardssalgEmails({ guest_lang: "en" });
        sameMail(m["guest.confirmed.honest.direct"], golden["guest.confirmed.honest.direct"], `k:flag ${JSON.stringify(v)} is off`);
      }
      process.env.GARDSSALG_EMAIL_EN_ENABLED = "true";
      const nbOn = await captureGardssalgEmails({ guest_lang: "nb" });
      for (const [name, exp] of Object.entries(golden)) sameMail(nbOn[name], exp, `k:${name} (lang nb, flag on)`);

      // ── (e) flag on + "en": the approved English ─────────────────────────
      const en = await captureGardssalgEmails({ guest_lang: "en" });
      delete process.env.GARDSSALG_EMAIL_EN_ENABLED;
      const vars = {
        gjest: "Kari <Nordmann> & Co",
        produsent: "Testsideri & Søn",
        ref: "GARD-20261212-ABCDE",
        tid: "Saturday 12 December 2026 at 13:00",
        antall: "3",
        statusside: "https://opplevagent.no/kategori/gardssalg/status/GARD-20261212-ABCDE/s0s0s0s0s0s0s0s0s0s0s0s0s0s0s0s0",
        oversikt: "https://opplevagent.no/kategori/gardssalg",
        nytt_tidspunkt: "Sunday 13 December 2026 at 14:00",
        svarlenke: "https://opplevagent.no/kategori/gardssalg/gjestesvar/d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
      };
      const textIs = (name: string, exp: string) => {
        const got = en[name]?.textContent ?? "";
        assertTrue(bytesEq(got, exp), `e:${name}: text = package body (filled)`, bytesEq(got, exp) ? undefined : firstDiff(got, exp));
      };
      textIs("guest.confirmed.honest.direct", fillPack(PACK_A1, vars));
      textIs(
        "guest.confirmed.honest.accepted",
        fillPack(PACK_A1, vars)
          .replace("Testsideri & Søn has confirmed your visit:", PACK_EN["guest.confirmed.leadAccepted"])
          .replace(PACK_EN["confirmed.icsLine"], PACK_EN["confirmed.newTimeIcsLine"]),
      );
      textIs(
        "guest.confirmed.legacy.direct",
        fillPack(PACK_A1, vars).replace(`${PACK_EN["confirmed.icsLine"]}\n\n`, ""),
      );
      textIs("guest.declined", fillPack(PACK_A2, vars));
      textIs("guest.suggestion", fillPack(PACK_A3, vars));
      textIs(
        "guest.suggestion.bare",
        fillPack(PACK_A3, { ...vars, antall: "1" }).replace(/\n\nYou can check the current status at any time: [^\n]+/, ""),
      );
      textIs("guest.expired", fillPack(PACK_A4, vars));
      textIs(
        "guest.expired.suggested.bare",
        fillPack(PACK_A4, vars).replace(fillPack(PACK_EN["guest.expired.body"], vars), fillPack(PACK_EN["guest.expired.bodySuggested"], vars)),
      );
      const subj = (name: string, key: string) =>
        assertTrue(en[name]?.subject === fillPack(PACK_EN[key], vars), `e:${name}: subject from the package`);
      subj("guest.confirmed.honest.direct", "guest.confirmed.subject");
      subj("guest.declined", "guest.declined.subject");
      subj("guest.suggestion", "guest.suggestion.subject");
      subj("guest.expired", "guest.expired.subject");
      subj("guest.receipt.honest.full", "receipt.email.subject");
      assertTrue(
        (en["guest.receipt.honest.full"]?.textContent ?? "").startsWith("Hi Kari <Nordmann> & Co,\n\nWe have received your request to visit Testsideri & Søn.")
          && (en["guest.receipt.honest.full"]?.textContent ?? "").includes("Time you asked for: Saturday 12 December 2026 at 13:00"),
        "e:honest receipt in English (OA-1 §1.2)",
      );
      const a1Html = en["guest.confirmed.honest.direct"]?.htmlContent ?? "";
      assertTrue(
        a1Html.startsWith("<p>Hi Kari &lt;Nordmann&gt; &amp; Co,</p>")
          && a1Html.includes(`<a href="${vars.statusside}">${vars.statusside}</a>`)
          && a1Html.includes("<p>Reference: GARD-20261212-ABCDE<br>\nDate and time: Saturday 12 December 2026 at 13:00<br>\nGuests: 3</p>"),
        "e:A1 html: escaped name, status link, table lines",
      );
      assertTrue(/SUMMARY:Visit to Testsideri & Søn/.test(en["guest.confirmed.honest.direct"]?.attachments?.[0]?.content ?? ""), "e:calendar file in English");
      assertTrue((en["guest.suggestion"]?.htmlContent ?? "").includes(`<a href="${vars.svarlenke}">${vars.svarlenke}</a>`), "e:A3 html: reply link");
      const norwegian = /\b(Hei|Hilsen|Bookingref|Dato\/tid|reservasjon|bekreft|Velkommen)\b/;
      for (const n of ["guest.confirmed.honest.direct", "guest.confirmed.honest.accepted", "guest.confirmed.legacy.direct", "guest.declined", "guest.suggestion", "guest.expired", "guest.expired.suggested.bare", "guest.receipt.honest.full"]) {
        const m = en[n];
        assertTrue(!!m && !norwegian.test(m.subject + m.htmlContent + m.textContent), `e:${n}: no Norwegian sentence`);
      }
      // Always Norwegian: the producer e-mails and the legacy receipt.
      for (const [name, exp] of Object.entries(golden)) {
        if (name.startsWith("producer.") || name.startsWith("guest.receipt.legacy.")) sameMail(en[name], exp, `e:${name} stays Norwegian`);
      }
      // The producer's cancellation to the guest: sender picks the language.
      {
        const cx = require("./gardssalg-cancel") as typeof import("./gardssalg-cancel");
        const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
        const origSend = emailSvc.sendEmail;
        const got: Array<{ subject: string; textContent: string }> = [];
        emailSvc.sendEmail = async (o: any) => { got.push(o); return { success: true }; };
        try {
          process.env.GARDSSALG_EMAIL_EN_ENABLED = "true";
          await cx.sendProducerCancelToGuest(fixtureBooking({ guest_lang: "en" }));
          await cx.sendProducerCancelToGuest(fixtureBooking({ guest_lang: "nb" }));
          delete process.env.GARDSSALG_EMAIL_EN_ENABLED;
          await cx.sendProducerCancelToGuest(fixtureBooking({ guest_lang: "en" }));
        } finally {
          emailSvc.sendEmail = origSend;
          delete process.env.GARDSSALG_EMAIL_EN_ENABLED;
        }
        assertTrue(got[0]?.subject === "Testsideri & Søn has cancelled the visit — GARD-20261212-ABCDE"
          && (got[0]?.textContent ?? "").includes("has had to cancel the visit on Saturday 12 December 2026 at 13:00"), "e:producer cancellation to an \"en\" guest in English (OA-1 §4.2)");
        assertTrue(got[1]?.subject === "Testsideri & Søn har avlyst besøket — GARD-20261212-ABCDE", "e:... to an \"nb\" guest in Norwegian");
        assertTrue(got[2]?.subject === "Testsideri & Søn har avlyst besøket — GARD-20261212-ABCDE", "e:... flag off → Norwegian");
      }

      // ── (t) AK3: the register against the packages ───────────────────────
      const reg = require("./gardssalg-email-texts") as typeof import("./gardssalg-email-texts");
      const entries = Object.entries(reg.GARDSSALG_EMAIL_TEXTS) as Array<[string, { nb: string; en: string | null; audience: string }]>;
      for (const [k, e] of entries) {
        assertTrue(typeof e.nb === "string" && e.nb.length > 0, `t:${k} has Norwegian text`);
        if (e.audience === "producer") assertTrue(e.en === null, `t:${k} (producer) has no English`);
        else if (e.en === null) assertTrue(k in reg.EN_NOT_IN_PACK, `t:${k} without English is listed in EN_NOT_IN_PACK`);
        else assertTrue(k in PACK_EN && bytesEq(e.en, PACK_EN[k]), `t:${k} English = the package, verbatim`);
      }
      assertTrue(
        JSON.stringify(Object.keys(reg.EN_NOT_IN_PACK).sort()) === JSON.stringify([...EXPECTED_EN_MISSING].sort()),
        "t:EN_NOT_IN_PACK lists exactly the guest keys without English",
      );
      assertTrue(Object.keys(PACK_EN).every((k) => k in reg.GARDSSALG_EMAIL_TEXTS), "t:every package text used is a register key");
      assertTrue(
        entries.filter(([, e]) => e.audience === "guest" && e.en !== null).length === Object.keys(PACK_EN).length,
        "t:the guest keys with English are exactly the package texts",
      );
      // One register: the OA-1 modules read their e-mail texts from it.
      const hr = require("./gardssalg-honest-receipt") as typeof import("./gardssalg-honest-receipt");
      const cx = require("./gardssalg-cancel") as typeof import("./gardssalg-cancel");
      assertTrue(hr.OA1_RECEIPT_TEXTS["receipt.email.body"].en === reg.GARDSSALG_EMAIL_TEXTS["receipt.email.body"].en, "t:honest receipt body comes from the register");
      assertTrue(cx.OA1_CANCEL_TEXTS["cancel.toProducer.body"].nb === reg.GARDSSALG_EMAIL_TEXTS["cancel.toProducer.body"].nb, "t:cancellation body comes from the register");

      // ── (l) the guest's language ─────────────────────────────────────────
      const cases: Array<[unknown, string]> = [["en", "en"], [" EN ", "en"], ["nb", "nb"], [undefined, "nb"], [null, "nb"], ["sv", "nb"], ["en-GB", "nb"], [1, "nb"]];
      for (const [raw, exp] of cases) assertTrue(reg.normaliseGuestLang(raw) === exp, `l:normaliseGuestLang(${JSON.stringify(raw)}) = ${exp}`);
      process.env.GARDSSALG_EMAIL_EN_ENABLED = "true";
      assertTrue(reg.guestEmailLang({ guest_lang: "en" }) === "en" && reg.guestEmailLang({ guest_lang: null }) === "nb" && reg.guestEmailLang({}) === "nb", "l:guestEmailLang with the flag on");
      delete process.env.GARDSSALG_EMAIL_EN_ENABLED;
      assertTrue(reg.guestEmailLang({ guest_lang: "en" }) === "nb", "l:guestEmailLang with the flag off");

      const bs = require("./booking-store") as typeof import("./booking-store");
      const db = (require("../database/db-factory") as typeof import("../database/db-factory")).getDb("experiences");
      const cols = (db.prepare("PRAGMA table_info(gardssalg_bookings)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
      const col = cols.find((c) => c.name === "guest_lang");
      assertTrue(!!col && col.notnull === 0 && col.dflt_value === null, "l:guest_lang column is nullable without a default");
      const input = { provider_id: PROVIDER_ID, slot_at: osloNakedDaysAhead(10, "13:00"), party_size: 2, guest_name: "Ola", guest_email: "ola@example.no" };
      const stored = (ref: string) => (db.prepare("SELECT guest_lang FROM gardssalg_bookings WHERE booking_ref = ?").get(ref) as { guest_lang: string | null }).guest_lang;
      const bEn = bs.createBooking(input, undefined, { guestLang: "en" });
      const bBad = bs.createBooking(input, undefined, { guestLang: "de" });
      const bNone = bs.createBooking(input, "mcp");
      assertTrue(stored(bEn.booking_ref) === "en" && bs.getBookingByRef(bEn.booking_ref)?.guest_lang === "en", "l:createBooking stores \"en\"");
      assertTrue(stored(bBad.booking_ref) === "nb", "l:an invalid language is stored as \"nb\"");
      assertTrue(stored(bNone.booking_ref) === "nb", "l:no language (the MCP tool) is stored as \"nb\"");
      db.prepare("UPDATE gardssalg_bookings SET guest_lang = NULL WHERE booking_ref = ?").run(bNone.booking_ref);
      assertTrue(bs.getBookingByRef(bNone.booking_ref)?.guest_lang === null, "l:a row from before the column reads as NULL (= nb)");

      // The web form and the REST API set it.
      const emailSvc = (require("./email-service") as typeof import("./email-service")).emailService as any;
      const origSend = emailSvc.sendEmail;
      emailSvc.sendEmail = async () => ({ success: true, messageId: "stub" });
      let server: http.Server | null = null;
      try {
        const app = express();
        app.use(express.json());
        app.use("/api/opplevelser", (require("../routes/opplevelser") as typeof import("../routes/opplevelser")).default as any);
        app.use((require("../routes/experiences-seo") as typeof import("../routes/experiences-seo")).default as any);
        server = http.createServer(app);
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const rest = async (extra: Record<string, unknown>, day: number) => {
          const r = await fetch(`${base}/api/opplevelser/book`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...input, slot_at: osloNakedDaysAhead(day, "13:00"), ...extra }),
          });
          const body: any = await r.json();
          return { status: r.status, lang: body.booking_ref ? stored(body.booking_ref) : undefined };
        };
        const r1 = await rest({ lang: "en" }, 11);
        assertTrue(r1.status === 201 && r1.lang === "en", `l:REST lang "en" stored (${r1.status}, ${r1.lang})`);
        const r2 = await rest({ lang: "fr" }, 12);
        assertTrue(r2.status === 201 && r2.lang === "nb", `l:REST invalid lang → "nb" (${r2.status}, ${r2.lang})`);
        const r3 = await rest({}, 13);
        assertTrue(r3.status === 201 && r3.lang === "nb", `l:REST without lang → "nb" (${r3.status}, ${r3.lang})`);

        const formPage = await (await fetch(`${base}/kategori/gardssalg/book/et-testsideri`)).text();
        assertTrue(formPage.includes('<input type="hidden" name="lang" value="nb">') && formPage.includes('lang: String(fd.get("lang") || "nb")'), "l:the web form sends its language");
        const form = async (lang: string | null, day: number) => {
          const f: Record<string, string> = { provider_id: PROVIDER_ID, slot_at: osloNakedDaysAhead(day, "13:00"), party_size: "2", guest_name: "Ola", guest_email: "ola@example.no" };
          if (lang !== null) f.lang = lang;
          const r = await fetch(`${base}/kategori/gardssalg/book/et-testsideri`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(f).toString(), redirect: "manual",
          });
          const loc = r.headers.get("location") ?? "";
          const ref = decodeURIComponent((loc.match(/\/confirm\/([^?]+)/) ?? [])[1] ?? "");
          return { status: r.status, lang: ref ? stored(ref) : undefined };
        };
        const f1 = await form("nb", 14);
        assertTrue(f1.status === 303 && f1.lang === "nb", `l:no-JS form lang "nb" stored (${f1.status}, ${f1.lang})`);
        const f2 = await form("en", 15);
        assertTrue(f2.status === 303 && f2.lang === "en", `l:no-JS form lang "en" stored (${f2.status}, ${f2.lang})`);
        const f3 = await form(null, 16);
        assertTrue(f3.status === 303 && f3.lang === "nb", `l:no-JS form without lang → "nb" (${f3.status}, ${f3.lang})`);
        await new Promise((r) => setTimeout(r, 30));
      } finally {
        emailSvc.sendEmail = origSend;
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
    });

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  if (process.env.GARDSSALG_EMAIL_GOLDEN_WRITE === "1") {
    withEmailFixture(() => captureGardssalgEmails()).then((mails) => {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(mails, null, 2) + "\n");
      console.log(`wrote ${Object.keys(mails).length} e-mails to ${GOLDEN_PATH}`);
      process.exit(0);
    });
  } else {
    runGardssalgEmailTextsTests({ log: true }).then((summary) => {
      console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
      for (const f of summary.failures) console.log(f);
      process.exit(summary.failed > 0 ? 1 : 0);
    });
  }
}
