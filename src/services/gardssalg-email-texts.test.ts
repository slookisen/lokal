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
 *        "en" gets exactly the Norwegian e-mails (same golden fixture).
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
      const en = await captureGardssalgEmails({ guest_lang: "en" });
      for (const [name, exp] of Object.entries(golden)) sameMail(en[name], exp, `k:${name} (lang en, flag off)`);
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
