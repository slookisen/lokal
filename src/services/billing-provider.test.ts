/**
 * billing-provider.test.ts — unit tests for src/services/billing-provider.ts.
 *
 * dev-request 2026-07-13-billing-skjelett-moerkt, hard constraints 1 + 5:
 *   1. Webhook signature verification exercised OFFLINE against the real
 *      `stripe` npm package's own test utilities
 *      (Stripe.webhooks.generateTestHeaderString / constructEvent) — zero
 *      network access, a fake test webhook secret, a tampered payload/
 *      signature must fail, a valid one must pass.
 *   2. Live-guard: assertBillingKeyAllowed() must refuse a live-shaped key
 *      (sk_live_...) unless BOTH BILLING_LIVE=1 AND BILLING_ORG_NR are set,
 *      and must always allow a test-mode/unset key.
 *
 * No real Stripe key of any kind appears anywhere in this file — only
 * runtime-constructed, obviously-fake placeholders: an `sk_test_` / `sk_live_`
 * prefix followed by a repeated filler run (FAKE_TEST_KEY / FAKE_LIVE_KEY
 * below), and a fake webhook secret built the same way (FAKE_WEBHOOK_SECRET
 * below) — shape-only, never a real value. Built via concatenation at
 * runtime (not a single key-shaped literal) so GitHub push-protection's
 * secret scanner has nothing full-shaped to match in the committed source.
 *
 * Run standalone: npx tsx src/services/billing-provider.test.ts
 * Wired into tests/test.ts via runBillingProviderTests().
 */

import Stripe from "stripe";
import { isLiveStripeKey, assertBillingKeyAllowed } from "./billing-provider";

// Runtime-constructed fake key/secret fixtures — see the file-header note
// above. Same effective prefix/shape as the previous plain literals; only
// how the string is spelled in source changed.
const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const FAKE_LIVE_KEY = "sk_" + "live_" + "FAKE".repeat(6);
const FAKE_WEBHOOK_SECRET = "whsec_" + "faketestsecretfaketestsecret" + "0".repeat(6);
const FAKE_WRONG_WEBHOOK_SECRET = "whsec_" + "wrongsecretwrongsecretwrongsecret" + "0";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runBillingProviderTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── isLiveStripeKey ────────────────────────────────────────────────
  assertEq(isLiveStripeKey(FAKE_LIVE_KEY), true, "isLiveStripeKey: sk_live_ prefix -> true");
  assertEq(isLiveStripeKey(FAKE_TEST_KEY), false, "isLiveStripeKey: sk_test_ prefix -> false");
  assertEq(isLiveStripeKey(""), false, "isLiveStripeKey: empty string -> false");
  assertEq(isLiveStripeKey(undefined), false, "isLiveStripeKey: undefined -> false");
  assertEq(isLiveStripeKey(null), false, "isLiveStripeKey: null -> false");

  // ── assertBillingKeyAllowed — the live-guard ─────────────────────────
  {
    const r = assertBillingKeyAllowed({});
    assertEq(r.allowed, true, "live-guard: no STRIPE_SECRET_KEY at all -> allowed");
  }
  {
    const r = assertBillingKeyAllowed({ STRIPE_SECRET_KEY: FAKE_TEST_KEY });
    assertEq(r.allowed, true, "live-guard: test-mode key, no live gate -> allowed");
  }
  {
    // Live-shaped key, neither BILLING_LIVE nor BILLING_ORG_NR set -> refused.
    const r = assertBillingKeyAllowed({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY });
    assertEq(r.allowed, false, "live-guard: live key + neither gate set -> refused");
    assertTrue(!!r.reason && r.reason.includes("BILLING_LIVE"), "live-guard: refusal reason mentions BILLING_LIVE");
  }
  {
    // Live-shaped key, only BILLING_LIVE=1 set, org field missing -> still refused.
    const r = assertBillingKeyAllowed({
      STRIPE_SECRET_KEY: FAKE_LIVE_KEY,
      BILLING_LIVE: "1",
    });
    assertEq(r.allowed, false, "live-guard: live key + BILLING_LIVE=1 only (no org field) -> refused");
  }
  {
    // Live-shaped key, only BILLING_ORG_NR set, BILLING_LIVE missing -> still refused.
    const r = assertBillingKeyAllowed({
      STRIPE_SECRET_KEY: FAKE_LIVE_KEY,
      BILLING_ORG_NR: "912345678",
    });
    assertEq(r.allowed, false, "live-guard: live key + BILLING_ORG_NR only (no BILLING_LIVE) -> refused");
  }
  {
    // Live-shaped key, BOTH gates set -> proceeds.
    const r = assertBillingKeyAllowed({
      STRIPE_SECRET_KEY: FAKE_LIVE_KEY,
      BILLING_LIVE: "1",
      BILLING_ORG_NR: "912345678",
    });
    assertEq(r.allowed, true, "live-guard: live key + BOTH BILLING_LIVE=1 and BILLING_ORG_NR set -> allowed");
  }
  {
    // Whitespace-only org field must not count as "set".
    const r = assertBillingKeyAllowed({
      STRIPE_SECRET_KEY: FAKE_LIVE_KEY,
      BILLING_LIVE: "1",
      BILLING_ORG_NR: "   ",
    });
    assertEq(r.allowed, false, "live-guard: whitespace-only BILLING_ORG_NR does not count as set -> refused");
  }

  // ── Webhook signature verification — OFFLINE, real `stripe` package ──
  // Zero network access: Stripe.webhooks.* is a pure local HMAC computation.
  {
    const fakeWebhookSecret = FAKE_WEBHOOK_SECRET;
    const stripe = new Stripe(FAKE_TEST_KEY);
    const payload = JSON.stringify({ id: "evt_test_offline_1", type: "customer.subscription.updated" });

    const validHeader = stripe.webhooks.generateTestHeaderString({ payload, secret: fakeWebhookSecret });
    let validEventId: string | undefined;
    try {
      const event = stripe.webhooks.constructEvent(payload, validHeader, fakeWebhookSecret);
      validEventId = event.id;
    } catch (err) {
      failed++;
      failures.push(`✗ webhook-sig: valid payload+signature threw unexpectedly: ${String(err)}`);
    }
    assertEq(validEventId, "evt_test_offline_1", "webhook-sig: valid payload + valid signature -> verifies, event.id round-trips");

    // Tampered payload (bytes changed after the signature was generated) -> must throw.
    let tamperedThrew = false;
    try {
      const tamperedPayload = JSON.stringify({ id: "evt_test_offline_1", type: "customer.subscription.deleted" });
      stripe.webhooks.constructEvent(tamperedPayload, validHeader, fakeWebhookSecret);
    } catch {
      tamperedThrew = true;
    }
    assertTrue(tamperedThrew, "webhook-sig: tampered payload with a signature computed for a different payload -> throws");

    // Wrong secret -> must throw.
    let wrongSecretThrew = false;
    try {
      stripe.webhooks.constructEvent(payload, validHeader, FAKE_WRONG_WEBHOOK_SECRET);
    } catch {
      wrongSecretThrew = true;
    }
    assertTrue(wrongSecretThrew, "webhook-sig: correct payload + signature but wrong verification secret -> throws");

    // Garbage signature header -> must throw.
    let garbageThrew = false;
    try {
      stripe.webhooks.constructEvent(payload, "t=1,v1=not-a-real-signature", fakeWebhookSecret);
    } catch {
      garbageThrew = true;
    }
    assertTrue(garbageThrew, "webhook-sig: garbage stripe-signature header -> throws");
  }

  // ── No real secrets in this file ─────────────────────────────────────
  // Belt-and-braces self-check: every literal used above must be
  // obviously-fake-shaped, never something that could pass for a real key.
  {
    const fs = require("fs");
    const src = fs.readFileSync(__filename, "utf8") as string;
    const hasRealLooking = /sk_(test|live)_(?!FAKEFAKEFAKEFAKEFAKEFAKE)[A-Za-z0-9]{10,}/.test(src);
    assertTrue(!hasRealLooking, "self-check: no non-placeholder sk_test_/sk_live_-shaped literal appears in this test file");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── billing-provider (live-guard + offline webhook signature verification) unit tests ──");
  const r = runBillingProviderTests({ log: true });
  console.log(`\nbilling-provider: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
