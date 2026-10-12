/**
 * payment-provider.test.ts — A2A dev-request 2026-10-09-rfb-forhandsbetaling-
 * stripe-connect, skive 1 (AC5, live half).
 *
 *   1. isLivePaymentsKey(): sk_live_ AND restricted rk_live_ count as live.
 *   2. paymentsLivemode() follows the configured key.
 *   3. assertPaymentsKeyAllowed(): test/no key always allowed; a live key is
 *      refused unless PAYMENTS_LIVE=1, PAYMENTS_ORG_NR = the company org.nr
 *      AND the terms of purchase say prepayment is live
 *      (KJOPSVILKAR_PREPAYMENT_LIVE, false today → always refused today).
 *   4. The producer-account controller properties are the binding ones
 *      (fees.payer=account, losses.payments=stripe, requirement_collection=
 *      stripe, stripe_dashboard.type=full).
 *   5. The real adapter verifies webhook signatures offline (real `stripe`
 *      HMAC, fake secret): valid passes, tampered payload throws.
 *
 * Standalone: npx tsx src/services/payment-provider.test.ts
 */

import {
  assertPaymentsKeyAllowed,
  createRealPaymentsStripeClient,
  isLivePaymentsKey,
  paymentsLivemode,
  PRODUCER_ACCOUNT_CONTROLLER,
} from "./payment-provider";
import { KJOPSVILKAR_PREPAYMENT_LIVE } from "../routes/rfb-kjopsvilkar";
import Stripe from "stripe";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Built by concatenation so no key-shaped literal sits in the source bytes
// (same convention as billing-provider.test.ts).
const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const FAKE_LIVE_KEY = "sk_" + "live_" + "FAKE".repeat(6);
const FAKE_RESTRICTED_LIVE_KEY = "rk_" + "live_" + "FAKE".repeat(6);
const FAKE_RESTRICTED_TEST_KEY = "rk_" + "test_" + "FAKE".repeat(6);
const FAKE_WEBHOOK_SECRET = "whsec_" + "fakeconnectsecret" + "3".repeat(10);

export async function runPaymentProviderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (opts.log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (opts.log) console.log(`  ✗ ${label}`); }
  };

  // 1. live-key detection
  ok(isLivePaymentsKey(FAKE_LIVE_KEY), "1a: sk_live_ is live");
  ok(isLivePaymentsKey(FAKE_RESTRICTED_LIVE_KEY), "1b: restricted rk_live_ is live");
  ok(!isLivePaymentsKey(FAKE_TEST_KEY), "1c: sk_test_ is not live");
  ok(!isLivePaymentsKey(FAKE_RESTRICTED_TEST_KEY), "1d: rk_test_ is not live");
  ok(!isLivePaymentsKey(undefined) && !isLivePaymentsKey(""), "1e: no key is not live");

  // 2. mode
  ok(paymentsLivemode({}) === false, "2a: no key → test mode");
  ok(paymentsLivemode({ STRIPE_SECRET_KEY: FAKE_TEST_KEY }) === false, "2b: test key → test mode");
  ok(paymentsLivemode({ STRIPE_SECRET_KEY: FAKE_RESTRICTED_LIVE_KEY }) === true, "2c: rk_live_ → live mode");

  // 3. guard
  ok(assertPaymentsKeyAllowed({}).allowed, "3a: no key → allowed");
  ok(assertPaymentsKeyAllowed({ STRIPE_SECRET_KEY: FAKE_TEST_KEY }).allowed, "3b: test key → allowed");
  ok(!assertPaymentsKeyAllowed({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY }).allowed, "3c: live key, no gates → refused");
  ok(!assertPaymentsKeyAllowed({ STRIPE_SECRET_KEY: FAKE_RESTRICTED_LIVE_KEY }).allowed, "3d: restricted live key, no gates → refused");
  ok(
    !assertPaymentsKeyAllowed({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_LIVE: "1", PAYMENTS_ORG_NR: "999999999" }).allowed,
    "3e: PAYMENTS_LIVE=1 but wrong org.nr → refused",
  );
  ok(
    !assertPaymentsKeyAllowed({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_ORG_NR: "938635676" }).allowed,
    "3f: right org.nr but PAYMENTS_LIVE unset → refused",
  );
  const allGates = assertPaymentsKeyAllowed({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_LIVE: "1", PAYMENTS_ORG_NR: "938 635 676" });
  ok(KJOPSVILKAR_PREPAYMENT_LIVE === false, "3g: terms still say prepayment is «under innføring»");
  ok(!allGates.allowed, "3h: every env gate set, terms not live → still refused");
  ok(/kjopsvilkar/.test(allGates.reason || ""), "3i: refusal names the terms of purchase");
  ok(!/FAKE/.test(allGates.reason || ""), "3j: refusal never echoes the key");
  const liveEnv = { STRIPE_SECRET_KEY: FAKE_LIVE_KEY, PAYMENTS_LIVE: "1", PAYMENTS_ORG_NR: "938 635 676", ORDER_BUYER_RECEIPTS_ENABLED: "1" };
  const noReceipts = assertPaymentsKeyAllowed({ ...liveEnv, ORDER_BUYER_RECEIPTS_ENABLED: undefined }, true);
  ok(!noReceipts.allowed && /ORDER_BUYER_RECEIPTS_ENABLED/.test(noReceipts.reason || ""), "3k0: live key without buyer receipts (prerequisite 1, § 18) → refused, and the reason says why");
  ok(assertPaymentsKeyAllowed(liveEnv, true).allowed, "3k: every gate set AND terms live → allowed (org.nr compared digits-only)");
  ok(assertPaymentsKeyAllowed({ ...liveEnv, STRIPE_SECRET_KEY: FAKE_RESTRICTED_LIVE_KEY }, true).allowed, "3l: restricted live key with every gate → allowed");
  ok(!assertPaymentsKeyAllowed({ ...liveEnv, PAYMENTS_LIVE: "true" }, true).allowed, "3m: PAYMENTS_LIVE must be exactly \"1\"");
  ok(!assertPaymentsKeyAllowed({ ...liveEnv, PAYMENTS_ORG_NR: "" }, true).allowed, "3n: missing org.nr alone → refused");
  ok(!assertPaymentsKeyAllowed({ ...liveEnv, PAYMENTS_ORG_NR: "938635677" }, true).allowed, "3o: wrong org.nr alone → refused");
  ok(!assertPaymentsKeyAllowed(liveEnv, false).allowed, "3p: terms not live alone → refused");

  // 4. controller properties
  ok(PRODUCER_ACCOUNT_CONTROLLER.fees.payer === "account", "4a: Stripe bills the producer (fees.payer=account)");
  ok(PRODUCER_ACCOUNT_CONTROLLER.losses.payments === "stripe", "4b: Stripe carries losses (losses.payments=stripe)");
  ok(PRODUCER_ACCOUNT_CONTROLLER.requirement_collection === "stripe", "4c: Stripe collects KYC requirements");
  ok(PRODUCER_ACCOUNT_CONTROLLER.stripe_dashboard.type === "full", "4d: producer gets the full Stripe Dashboard");
  ok(Object.isFrozen(PRODUCER_ACCOUNT_CONTROLLER), "4e: controller constant is frozen");

  // 5. offline webhook verification through the real adapter
  const client = createRealPaymentsStripeClient(FAKE_TEST_KEY);
  const payload = JSON.stringify({ id: "evt_test_1", type: "account.updated", livemode: false, account: "acct_x", data: { object: { id: "acct_x" } } });
  const header = new Stripe(FAKE_TEST_KEY).webhooks.generateTestHeaderString({ payload, secret: FAKE_WEBHOOK_SECRET });
  let parsedId = "";
  try { parsedId = client.webhooks.constructEvent(payload, header, FAKE_WEBHOOK_SECRET).id; } catch { parsedId = ""; }
  ok(parsedId === "evt_test_1", "5a: valid signature → event parsed");
  let threw = false;
  try { client.webhooks.constructEvent(payload.replace("acct_x", "acct_y"), header, FAKE_WEBHOOK_SECRET); } catch { threw = true; }
  ok(threw, "5b: tampered payload → signature check throws");

  return { passed, failed, failures };
}

if (require.main === module) {
  runPaymentProviderTests({ log: true }).then((s) => {
    console.log(`\npayment-provider: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) { for (const f of s.failures) console.log(f); process.exit(1); }
  });
}
