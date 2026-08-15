/**
 * send-guard.ts — per-transaction test-mode redirect for outgoing email.
 *
 * dev-request 2026-07-26-booking-test-send-guard.
 *
 * Two deployed features (the `book_gardssalg` MCP tool and the gårdssalg
 * owner-claim flow) each have one unfinished acceptance criterion: a LIVE
 * end-to-end test. Running it today means sending real email — a booking
 * request, or a claim magic-link — to a real producer, purely as a test. The
 * fleet correctly refused both to fake it and to send it, so two finished
 * features sat formally unfinished.
 *
 * This module is the third option: a per-transaction test flag that redirects
 * EVERY outgoing email belonging to that one transaction to a single
 * configured address, so the whole chain can be exercised for real without
 * any real producer receiving anything.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. FAIL-CLOSED. If a transaction is flagged as a test but
 *      TEST_SEND_REDIRECT_EMAIL is not configured, NOTHING is sent. There is
 *      deliberately no fallback to the real recipient — that fallback is
 *      precisely the accident this guard exists to prevent.
 *   2. THE PRODUCER EMAIL IS THE ONE THAT MATTERS. In this flow the PRODUCER
 *      receives the actionable `confirm_token`/`respond_token`; the guest only
 *      ever gets a read-only status link. A guard that redirected just the
 *      guest receipt would still hit a real producer with a test. (This is the
 *      exact false assumption an independent review caught in the #372 tool
 *      text — recorded here so the next reader doesn't re-introduce it.)
 *   3. VISIBLY MARKED. A redirected email says so in its subject and at the
 *      top of both bodies, and names the address it WOULD have gone to, so a
 *      future reader can never mistake it for a real booking.
 *
 * Not a staging mode: nothing here is global. Absent the per-transaction flag,
 * the real send path is untouched — `applyTestSendRedirect` is never called.
 */

/** Thrown by applyTestSendRedirect when the redirect address is missing. */
export class TestSendNotConfiguredError extends Error {
  readonly code = "test_send_redirect_not_configured";
  constructor() {
    super(
      "TEST_SEND_REDIRECT_EMAIL is not configured — refusing to send a " +
        "test-flagged email rather than falling back to the real recipient.",
    );
    this.name = "TestSendNotConfiguredError";
  }
}

/**
 * The configured test-send redirect address, or null when unset/blank.
 * Read from the environment on every call (never cached) so the value can be
 * changed without a restart, and so tests can set and unset it freely.
 */
export function testSendRedirectAddress(): string | null {
  const raw = (process.env.TEST_SEND_REDIRECT_EMAIL || "").trim();
  return raw === "" ? null : raw;
}

export interface TestSendEnvelope {
  to: string;
  subject: string;
  /**
   * Optional since dev-request 2026-08-15-outreach-ab-standard-vs-personlig-
   * drikke: absent = a genuinely text-only mail. The redirect preserves that
   * (the banner goes on the text part only) — a test send must not change
   * the wire format of the mail it stands in for.
   */
  htmlContent?: string;
  textContent: string;
}

const SUBJECT_MARKER = "[TESTSENDING]";

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Rewrite an outgoing envelope for a test-flagged transaction: recipient
 * replaced with the configured redirect address, subject prefixed, and a
 * banner naming the intended recipient prepended to both bodies.
 *
 * Throws TestSendNotConfiguredError when no redirect address is configured —
 * the caller must treat that as "send nothing", never as "send as normal".
 * Idempotent on the subject: re-marking an already-marked subject does not
 * stack prefixes.
 */
export function applyTestSendRedirect(envelope: TestSendEnvelope): TestSendEnvelope {
  const redirect = testSendRedirectAddress();
  if (!redirect) throw new TestSendNotConfiguredError();

  const intended = envelope.to;
  const subject = envelope.subject.startsWith(SUBJECT_MARKER)
    ? envelope.subject
    : `${SUBJECT_MARKER} ${envelope.subject}`;

  const bannerHtml =
    `<div style="border:2px solid #b45309;background:#fffbeb;color:#7c2d12;` +
    `padding:12px 16px;margin:0 0 16px;font-family:sans-serif;font-size:14px">` +
    `<strong>TESTSENDING — dette er ikke en ekte booking eller henvendelse.</strong><br>` +
    `E-posten ble omdirigert hit av test-send-vernet. Den ville ellers gått til: ` +
    `<code>${escapeHtml(intended)}</code>.` +
    `</div>`;

  const bannerText =
    `*** TESTSENDING — dette er ikke en ekte booking eller henvendelse. ***\n` +
    `E-posten ble omdirigert hit av test-send-vernet.\n` +
    `Den ville ellers gått til: ${intended}\n` +
    `${"-".repeat(60)}\n\n`;

  return {
    to: redirect,
    subject,
    // See TestSendEnvelope.htmlContent — a text-only mail stays text-only.
    ...(envelope.htmlContent !== undefined ? { htmlContent: bannerHtml + envelope.htmlContent } : {}),
    textContent: bannerText + envelope.textContent,
  };
}
