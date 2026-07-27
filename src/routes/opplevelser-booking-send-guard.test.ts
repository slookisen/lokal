/**
 * opplevelser-booking-send-guard.test.ts — tests for the per-transaction
 * test-mode send guard (dev-request 2026-07-26-booking-test-send-guard):
 *
 *   - applyTestSendRedirect() / testSendRedirectAddress() (src/services/send-guard.ts)
 *   - EmailService.sendEmail()'s isTestSend branch (src/services/email-service.ts)
 *   - createBooking(input, source, {isTest}) + GardssalgBooking.is_test
 *     (src/services/booking-store.ts)
 *   - sendBookingConfirmation() / sendProducerNotification() redirect
 *   - issueClaimMagicLink(providerId, brregEmail, {isTest}) (src/services/gardssalg-claim.ts)
 *   - POST /admin/booking-test-send + POST /admin/claim-test-send (src/routes/opplevelser.ts)
 *
 * Two deployed features (the book_gardssalg MCP tool, the gårdssalg owner-claim
 * flow) each sat with one unfinished acceptance criterion — a LIVE end-to-end
 * test — because running it meant emailing a real producer as a test. This
 * guard redirects every email belonging to one flagged transaction to
 * TEST_SEND_REDIRECT_EMAIL instead.
 *
 * The emails are observed at the REAL send boundary: rather than replacing
 * emailService.sendEmail (which would bypass the guard living inside it),
 * these tests inject a fake nodemailer transporter and flip isConfigured, so
 * every assertion is made against the envelope that would actually go out.
 *
 * Covers (mapping to the dev-request's criterion 5):
 *   (a) applyTestSendRedirect: recipient replaced, subject marked, banner
 *       names the intended recipient in BOTH html and text
 *   (b) applyTestSendRedirect: subject marking is idempotent
 *   (c) applyTestSendRedirect: unconfigured redirect THROWS
 *       TestSendNotConfiguredError (never returns the original envelope)
 *   (d) sendEmail(isTestSend) → transporter receives the redirect address,
 *       never the real recipient
 *   (e) 5(c) FAIL-CLOSED: isTestSend with no redirect configured → transporter
 *       NEVER called, {success:false, error:"test_send_redirect_not_configured"}
 *   (f) 5(e) INVARIANT: without the flag the envelope is bit-for-bit unchanged
 *   (g) createBooking: {isTest:true} → is_test=1; default → is_test=0
 *   (h) 5(d) NO SMUGGLING: BookingInputSchema strips is_test/isTest from a
 *       payload, so a public caller cannot reach the flag
 *   (i) 5(a) both booking emails redirect for a test booking
 *   (j) 5(b) THE CRITICAL ONE: the PRODUCER notification — the email carrying
 *       the actionable respond/confirm tokens — is redirected, and the real
 *       producer address appears nowhere in the envelope's `to`
 *   (k) 5(e) a non-test booking still emails the real guest and producer
 *   (l) issueClaimMagicLink: {isTest:true} → claim row is_test=1; default → 0
 *   (m) POST /admin/booking-test-send: unauthenticated → 403
 *   (n) POST /admin/booking-test-send: no redirect configured → 400 AND no
 *       booking row created (fails before touching the DB)
 *   (o) POST /admin/booking-test-send: happy path → is_test row, both sends
 *       redirected, response reports the intended recipients
 *   (p) POST /admin/claim-test-send: unauthenticated → 403; no redirect
 *       configured → 400 and no claim row
 *   (q) the public POST /book path cannot produce a test booking even when the
 *       payload screams for one
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/booking-test-send";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserBookingSendGuardTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevRedirect = process.env.TEST_SEND_REDIRECT_EMAIL;
    const prevDispatch = process.env.BOOKING_DISPATCH_ENABLED;
    const testKey = "booking-send-guard-test-key";
    const REDIRECT = "daniel-test@example.no";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.BOOKING_DISPATCH_ENABLED = "true";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("../services/experience-store");
    const bookingStorePath = require.resolve("../services/booking-store");
    const claimPath = require.resolve("../services/gardssalg-claim");
    const emailPath = require.resolve("../services/email-service");
    const sendGuardPath = require.resolve("../services/send-guard");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [
      dbFactoryPath, experienceStorePath, bookingStorePath,
      claimPath, emailPath, sendGuardPath, opplevelserPath,
    ];
    for (const p of cachePaths) delete require.cache[p];

    let emailSvc: any = null;
    let origConfigured: unknown;
    let origTransporter: unknown;

    try {
      // EmailService.sendEmail() derives its From-address via getConfig(),
      // which insists boot-time config loading has happened. Idempotent.
      try {
        (require("../config/vertical-config") as typeof import("../config/vertical-config")).loadConfigsAtBoot();
      } catch { /* already loaded by an earlier suite in the same process */ }

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const sendGuard = require("../services/send-guard") as typeof import("../services/send-guard");
      const bookingStore = require("../services/booking-store") as typeof import("../services/booking-store");
      const claimSvc = require("../services/gardssalg-claim") as typeof import("../services/gardssalg-claim");
      const emailMod = require("../services/email-service") as typeof import("../services/email-service");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── Fake transport at the REAL send boundary ─────────────────────────
      // The guard lives inside sendEmail(); stubbing sendEmail itself would
      // stub out the thing under test. Injecting a transporter observes the
      // exact envelope that would leave the process.
      emailSvc = emailMod.emailService as any;
      origConfigured = emailSvc.isConfigured;
      origTransporter = emailSvc.transporter;
      let sent: Array<Record<string, any>> = [];
      emailSvc.isConfigured = true;
      emailSvc.transporter = {
        sendMail: async (mailOptions: Record<string, any>) => {
          sent.push(mailOptions);
          return { messageId: `stub-${sent.length}` };
        },
      };

      // ── (a)-(c) send-guard unit coverage ─────────────────────────────────
      process.env.TEST_SEND_REDIRECT_EMAIL = REDIRECT;
      assertEq(sendGuard.testSendRedirectAddress(), REDIRECT, "a0: configured redirect address is read");

      const rewritten = sendGuard.applyTestSendRedirect({
        to: "ekte.produsent@gard.no",
        subject: "Ny reservasjon — GARD-1",
        htmlContent: "<p>innhold</p>",
        textContent: "innhold",
      });
      assertEq(rewritten.to, REDIRECT, "a1: recipient replaced with the redirect address");
      assertTrue(rewritten.subject.startsWith("[TESTSENDING]"), "a2: subject is marked as a test send");
      assertTrue(rewritten.subject.includes("Ny reservasjon — GARD-1"), "a3: original subject preserved after the marker");
      assertTrue(rewritten.htmlContent.includes("ekte.produsent@gard.no"), "a4: html banner names the intended recipient");
      assertTrue(rewritten.textContent.includes("ekte.produsent@gard.no"), "a5: text banner names the intended recipient");
      assertTrue(rewritten.htmlContent.includes("<p>innhold</p>"), "a6: original html body preserved");
      assertTrue(rewritten.textContent.includes("innhold"), "a7: original text body preserved");

      const twice = sendGuard.applyTestSendRedirect({ ...rewritten });
      assertEq(
        (twice.subject.match(/\[TESTSENDING\]/g) || []).length, 1,
        "b: subject marking is idempotent (no stacked prefixes)"
      );

      delete process.env.TEST_SEND_REDIRECT_EMAIL;
      assertEq(sendGuard.testSendRedirectAddress(), null, "c0: unset redirect address reads as null");
      let threw: unknown = null;
      try {
        sendGuard.applyTestSendRedirect({ to: "x@y.no", subject: "s", htmlContent: "h", textContent: "t" });
      } catch (e) { threw = e; }
      assertTrue(threw instanceof sendGuard.TestSendNotConfiguredError, "c1: unconfigured redirect THROWS (never returns the original)");

      process.env.TEST_SEND_REDIRECT_EMAIL = "   ";
      assertEq(sendGuard.testSendRedirectAddress(), null, "c2: whitespace-only redirect counts as unconfigured");

      // ── (d) sendEmail redirects ──────────────────────────────────────────
      process.env.TEST_SEND_REDIRECT_EMAIL = REDIRECT;
      sent = [];
      const okRes = await emailMod.emailService.sendEmail({
        to: "ekte@produsent.no",
        subject: "Ny reservasjon — GARD-2",
        htmlContent: "<p>x</p>",
        textContent: "x",
        isTestSend: true,
      });
      assertEq(okRes.success, true, "d1: a redirected send still reports success");
      assertEq(sent.length, 1, "d2: exactly one email left the boundary");
      assertEq(sent[0].to, REDIRECT, "d3: transporter received the REDIRECT address");
      assertTrue(!JSON.stringify(sent[0].to).includes("ekte@produsent.no"), "d4: the real recipient is NOT in the envelope's `to`");
      assertTrue(String(sent[0].subject).startsWith("[TESTSENDING]"), "d5: envelope subject is marked");

      // ── (e) FAIL-CLOSED ──────────────────────────────────────────────────
      delete process.env.TEST_SEND_REDIRECT_EMAIL;
      sent = [];
      const closed = await emailMod.emailService.sendEmail({
        to: "ekte@produsent.no",
        subject: "Ny reservasjon — GARD-3",
        htmlContent: "<p>x</p>",
        textContent: "x",
        isTestSend: true,
      });
      assertEq(sent.length, 0, "e1: FAIL-CLOSED — transporter was never called");
      assertEq(closed.success, false, "e2: the call reports failure");
      assertEq(closed.error, "test_send_redirect_not_configured", "e3: with an actionable error code");

      // ── (f) INVARIANT: unflagged sends are untouched ─────────────────────
      process.env.TEST_SEND_REDIRECT_EMAIL = REDIRECT;
      sent = [];
      await emailMod.emailService.sendEmail({
        to: "ekte@produsent.no",
        subject: "Ny reservasjon — GARD-4",
        htmlContent: "<p>uendret</p>",
        textContent: "uendret",
      });
      assertEq(sent.length, 1, "f1: an unflagged send goes out");
      assertEq(sent[0].to, "ekte@produsent.no", "f2: to the REAL recipient — redirect config is irrelevant without the flag");
      assertEq(sent[0].subject, "Ny reservasjon — GARD-4", "f3: subject unchanged");
      assertEq(sent[0].html, "<p>uendret</p>", "f4: html unchanged (no banner)");
      assertEq(sent[0].text, "uendret", "f5: text unchanged (no banner)");

      // ── Provider fixtures ────────────────────────────────────────────────
      expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, epost, booking_live, catalog_hidden,
            producer_type, enrichment_state, verification_status, source, confidence, created_at)
         VALUES (@id, @navn, 'experiences', @epost, 1, @catalog_hidden,
                 'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium', datetime('now'))`
      ).run({ id: "prov-live", navn: "Test Gård", epost: "ekte.produsent@gard.no", catalog_hidden: null });

      const bookingInput = {
        provider_id: "prov-live",
        slot_at: "2026-09-01T12:00:00.000Z",
        party_size: 2,
        guest_name: "Kari Nordmann",
        guest_email: "kari@example.no",
      };

      // ── (g) createBooking's flag ─────────────────────────────────────────
      const testBooking = bookingStore.createBooking(bookingInput as any, "mcp", { isTest: true });
      assertEq(testBooking.is_test, 1, "g1: {isTest:true} produces is_test=1");
      const realBooking = bookingStore.createBooking(bookingInput as any, "mcp");
      assertEq(realBooking.is_test, 0, "g2: the default produces is_test=0");
      assertEq(
        (expDb.prepare(`SELECT is_test FROM gardssalg_bookings WHERE booking_id = ?`).get(testBooking.booking_id) as any).is_test,
        1,
        "g3: the flag is persisted on the row (filterable out of stats)"
      );

      // ── (h) NO SMUGGLING through the public schema ───────────────────────
      const smuggled = bookingStore.BookingInputSchema.safeParse({
        ...bookingInput, is_test: true, isTest: true, test: true,
      });
      assertEq(smuggled.success, true, "h1: a payload with extra keys still parses");
      assertTrue(
        smuggled.success && !("is_test" in (smuggled.data as any)) && !("isTest" in (smuggled.data as any)),
        "h2: BookingInputSchema STRIPS is_test/isTest — they never reach createBooking"
      );
      const fromSmuggled = bookingStore.createBooking((smuggled as any).data, "mcp");
      assertEq(fromSmuggled.is_test, 0, "h3: a booking built from a smuggling payload is NOT a test booking");

      // ── (i)+(j) both booking emails redirect; producer email specifically ─
      sent = [];
      await bookingStore.sendBookingConfirmation(testBooking);
      await bookingStore.sendProducerNotification(testBooking, "ekte.produsent@gard.no");
      assertEq(sent.length, 2, "i1: both booking emails were attempted");
      assertEq(sent.map((m) => m.to), [REDIRECT, REDIRECT], "i2: BOTH went to the redirect address");
      assertTrue(sent.every((m) => String(m.subject).startsWith("[TESTSENDING]")), "i3: both are marked as test sends");

      const producerMail = sent[1];
      assertEq(producerMail.to, REDIRECT, "j1: the PRODUCER notification is redirected (the email carrying the actionable tokens)");
      assertTrue(producerMail.to !== "ekte.produsent@gard.no", "j2: the real producer address is not the recipient");
      assertTrue(String(producerMail.text).includes(testBooking.respond_token!), "j3: the redirected copy still carries the real respond link (the test must be genuine)");
      assertTrue(String(producerMail.html).includes("ekte.produsent@gard.no"), "j4: the banner records who it would have gone to");

      // ── (k) a NON-test booking still reaches the real recipients ─────────
      sent = [];
      await bookingStore.sendBookingConfirmation(realBooking);
      await bookingStore.sendProducerNotification(realBooking, "ekte.produsent@gard.no");
      assertEq(sent.map((m) => m.to), ["kari@example.no", "ekte.produsent@gard.no"], "k1: without the flag both emails go to the real recipients");
      assertTrue(sent.every((m) => !String(m.subject).startsWith("[TESTSENDING]")), "k2: and neither is marked");

      // ── (l) claim flag ───────────────────────────────────────────────────
      expDb.prepare(
        `UPDATE experience_providers SET org_nr = '910000111', brreg_verified = 1
         WHERE id = 'prov-live'`
      ).run();
      const claimTest = claimSvc.issueClaimMagicLink("prov-live", "eier@testgard.no", { isTest: true });
      if (claimTest.ok) {
        assertEq(claimTest.claim.isTest, true, "l1: {isTest:true} marks the claim");
        assertEq(
          (expDb.prepare(`SELECT is_test FROM gardssalg_claims WHERE id = ?`).get(claimTest.claim.claimId) as any).is_test,
          1,
          "l2: and is persisted on the claim row"
        );
      } else {
        assertTrue(false, `l1/l2: expected a claim to be issued, got ${claimTest.error}`);
      }
      const claimReal = claimSvc.issueClaimMagicLink("prov-live", "eier@testgard.no");
      if (claimReal.ok) {
        assertEq(claimReal.claim.isTest, false, "l3: the default leaves a claim un-flagged");
      } else {
        assertTrue(false, `l3: expected a claim to be issued, got ${claimReal.error}`);
      }

      // ── (m)-(o) POST /admin/booking-test-send ────────────────────────────
      const unauth = await callRoute(opplevelserRouter, { body: bookingInput });
      assertEq(unauth.status, 403, "m: unauthenticated booking-test-send -> 403");

      const auth = { "x-admin-key": testKey };
      const beforeCount = (expDb.prepare(`SELECT COUNT(*) n FROM gardssalg_bookings`).get() as any).n;
      delete process.env.TEST_SEND_REDIRECT_EMAIL;
      const noRedirect = await callRoute(opplevelserRouter, { headers: auth, body: bookingInput });
      assertEq(noRedirect.status, 400, "n1: no redirect configured -> 400");
      assertEq(noRedirect.body.error, "test_send_redirect_not_configured", "n2: with the actionable error code");
      assertEq(
        (expDb.prepare(`SELECT COUNT(*) n FROM gardssalg_bookings`).get() as any).n, beforeCount,
        "n3: and NO booking row was created (it fails before touching the DB)"
      );

      process.env.TEST_SEND_REDIRECT_EMAIL = REDIRECT;
      sent = [];
      const happy = await callRoute(opplevelserRouter, { headers: auth, body: { ...bookingInput, source: "mcp" } });
      assertEq(happy.status, 200, "o1: happy path -> 200");
      assertEq(happy.body.test_mode, true, "o2: response says it was a test");
      assertEq(happy.body.is_test, 1, "o3: the created booking is flagged");
      assertEq(happy.body.source, "mcp", "o4: the channel under test is stamped (MCP E2E)");
      assertEq(happy.body.redirected_to, REDIRECT, "o5: response names the redirect address");
      assertEq(happy.body.intended_recipients.producer, "ekte.produsent@gard.no", "o6: response names the real producer it did NOT contact");
      assertEq(sent.map((m) => m.to), [REDIRECT, REDIRECT], "o7: both emails went to the redirect address");
      assertEq(happy.body.sends.map((s: any) => s.ok), [true, true], "o8: both sends reported back to the operator");

      // ── (p) POST /admin/claim-test-send ──────────────────────────────────
      const claimUnauth = await callRoute(opplevelserRouter, { url: "/admin/claim-test-send", body: { provider_id: "prov-live" } });
      assertEq(claimUnauth.status, 403, "p1: unauthenticated claim-test-send -> 403");

      const claimsBefore = (expDb.prepare(`SELECT COUNT(*) n FROM gardssalg_claims`).get() as any).n;
      delete process.env.TEST_SEND_REDIRECT_EMAIL;
      const claimNoRedirect = await callRoute(opplevelserRouter, {
        url: "/admin/claim-test-send", headers: auth, body: { provider_id: "prov-live" },
      });
      assertEq(claimNoRedirect.status, 400, "p2: no redirect configured -> 400");
      assertEq(
        (expDb.prepare(`SELECT COUNT(*) n FROM gardssalg_claims`).get() as any).n, claimsBefore,
        "p3: and NO claim row was created"
      );
      process.env.TEST_SEND_REDIRECT_EMAIL = REDIRECT;

      // ── (q) the public booking path can never produce a test booking ─────
      sent = [];
      const publicBooking = await callRoute(opplevelserRouter, {
        url: "/book",
        body: { ...bookingInput, is_test: true, isTest: true },
      });
      assertEq(publicBooking.status, 201, "q1: the public booking route still works (201 Created)");
      const publicRow = expDb.prepare(
        `SELECT is_test FROM gardssalg_bookings ORDER BY rowid DESC LIMIT 1`
      ).get() as any;
      assertEq(publicRow.is_test, 0, "q2: a public booking is NEVER a test booking, whatever the payload claims");
      assertTrue(
        sent.length === 0 || sent.every((m) => !String(m.subject).startsWith("[TESTSENDING]")),
        "q3: and nothing it sent was marked as a test send"
      );
    } finally {
      if (emailSvc) {
        emailSvc.isConfigured = origConfigured;
        emailSvc.transporter = origTransporter;
      }
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("EXPERIENCES_DB_PATH", prevExperiencesDbPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("TEST_SEND_REDIRECT_EMAIL", prevRedirect);
      restore("BOOKING_DISPATCH_ENABLED", prevDispatch);
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-booking-send-guard.test.ts`
if (require.main === module) {
  runOpplevelserBookingSendGuardTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
