/**
 * rfb-betaling.test.ts — the prepayment transparency pages (A2A dev-request
 * 2026-10-09-rfb-forhandsbetaling-stripe-connect, skive 4 / AC6 and
 * prerequisites 4, 7 and 8).
 *
 * Proves:
 *   1. GET /betaling and GET /produsentvilkar exist on the RFB seo router but
 *      are only served while the payment lifecycle is on (PAYMENTS_ENABLED=1
 *      or "drain"); off → next() (the city catch-all 404s, «betaling» and
 *      «produsentvilkar» are reserved slugs).
 *   2. /betaling (NO + EN) states what the code does: the producer is the
 *      seller, the link lifetime and the confirmation deadline come from
 *      PAYMENT_CHECKOUT_MINUTES / PAYMENT_CONFIRM_HOURS, no buyer fee, no
 *      platform fee unless PLATFORM_FEE_* is set, a test-mode notice while
 *      the key is not live — and it prints NO fixed Stripe price
 *      (prerequisite 8: VAT on the fee is not verified yet).
 *   3. /personvern names Stripe as a recipient only while the lifecycle is on
 *      (prerequisite 7), and stays exactly as before otherwise; the facts it
 *      states are pinned against payment-service.ts (onboarding sends e-mail,
 *      name and producer URL; the webhook never stores customer_details).
 *   4. /produsentvilkar states the confirmation deadline from the env, the
 *      current terms version, and no platform fee.
 *
 * Standalone: npx tsx src/routes/rfb-betaling.test.ts
 */

import fs from "fs";
import path from "path";

export interface TestSummary { passed: number; failed: number; failures: string[]; }

function invokeGet(router: any, routePath: string, lang: "no" | "en" = "no"): { found: boolean; status: number; body: string; nextCalled: boolean } {
  const layer = (router.stack as any[]).find((l: any) => {
    if (!l.route || !l.route.methods?.get) return false;
    const p = l.route.path;
    return Array.isArray(p) ? p.includes(routePath) : p === routePath;
  });
  if (!layer) return { found: false, status: 0, body: "", nextCalled: false };
  let status = 200;
  let body = "";
  let nextCalled = false;
  const res: any = {
    status(code: number) { status = code; return this; },
    send(b: unknown) { body = typeof b === "string" ? b : String(b); return this; },
    setHeader() { return this; },
    header() { return this; },
    redirect() { return this; },
  };
  const req: any = { lang, params: {}, query: {}, headers: {}, get() { return undefined; } };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { nextCalled = true; });
  return { found: true, status, body, nextCalled };
}

const ENV_KEYS = ["PAYMENTS_ENABLED", "STRIPE_SECRET_KEY", "PAYMENT_CHECKOUT_MINUTES", "PAYMENT_CONFIRM_HOURS", "PLATFORM_FEE_BPS", "PLATFORM_FEE_FIXED_ORE"];
const FAKE_TEST_KEY = "sk_" + "test_" + "FAKE".repeat(6);
const FAKE_LIVE_KEY = "rk_" + "live_" + "FAKE".repeat(6);

export async function runRfbBetalingTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  const ok = (cond: boolean, label: string) => {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  };

  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
      try { loadConfigsAtBoot(); } catch { /* already loaded */ }
    } catch { /* defaults */ }

    const seoRouter = require("./seo").default as any;
    const { renderBetalingContent, renderPrepaymentPrivacy, STRIPE_PRICING_URL, STRIPE_PRIVACY_URL } = require("./rfb-betaling") as typeof import("./rfb-betaling");
    const { PRODUSENTVILKAR_VERSION } = require("../config/producer-terms") as typeof import("../config/producer-terms");
    const SRC = path.join(__dirname, "..");
    const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

    // ── 1. gating ──────────────────────────────────────────────────────────
    let r = invokeGet(seoRouter, "/betaling");
    ok(r.found, "setup: GET /betaling is registered on the seo router");
    ok(r.nextCalled && r.body === "", "gate-01: payments off → /betaling falls through (404)");
    r = invokeGet(seoRouter, "/produsentvilkar");
    ok(r.found && r.nextCalled && r.body === "", "gate-02: payments off → /produsentvilkar falls through (404)");
    const pvOffNo = invokeGet(seoRouter, "/personvern", "no").body;
    const pvOffEn = invokeGet(seoRouter, "/personvern", "en").body;
    ok(!/Stripe/.test(pvOffNo) && pvOffNo.includes("Vi samler ikke inn betalingsinformasjon"), "privacy-01: payments off → /personvern (NO) unchanged, no Stripe");
    ok(!/Stripe/.test(pvOffEn) && pvOffEn.includes("We do not collect payment information"), "privacy-02: payments off → /personvern (EN) unchanged, no Stripe");

    process.env.PAYMENTS_ENABLED = "1";
    process.env.STRIPE_SECRET_KEY = FAKE_TEST_KEY;
    const no = invokeGet(seoRouter, "/betaling", "no");
    const en = invokeGet(seoRouter, "/betaling", "en");
    ok(no.status === 200 && no.body.includes("<h1>Slik fungerer betaling</h1>"), "gate-03: payments on → /betaling (NO) 200");
    ok(en.status === 200 && en.body.includes("<h1>How payment works</h1>"), "gate-04: payments on → /en/betaling (EN) 200");
    ok(no.body.includes('rel="canonical" href="') && no.body.includes("/betaling\""), "gate-05: canonical URL");
    process.env.PAYMENTS_ENABLED = "drain";
    ok(invokeGet(seoRouter, "/betaling", "no").status === 200 && invokeGet(seoRouter, "/produsentvilkar").body.includes("Vilkår for produsenter"), "gate-06: drain → both pages still served (open orders, accepted terms)");
    process.env.PAYMENTS_ENABLED = "1";

    const seoSrc = read("routes/seo.ts");
    ok(/citySlug === "betaling"/.test(seoSrc) && /citySlug === "produsentvilkar"/.test(seoSrc), "gate-07: /:city guard reserves «betaling» and «produsentvilkar»");

    // ── 2. /betaling content ───────────────────────────────────────────────
    const nb = renderBetalingContent("no", { STRIPE_SECRET_KEY: FAKE_TEST_KEY });
    const enc = renderBetalingContent("en", { STRIPE_SECRET_KEY: FAKE_TEST_KEY });
    ok(nb.includes("Produsenten er selger") && nb.includes("produsentens egen Stripe-konto") && nb.includes("mottar eller oppbevarer aldri pengene"), "content-01: producer is the seller, platform never holds the money (NO)");
    ok(enc.includes("The producer is the seller") && enc.includes("never receives or holds the money"), "content-02: same in EN");
    ok(nb.includes("innen 60 minutter") && nb.includes("innen 48 timer"), "content-03: default link lifetime (60 min) and confirmation deadline (48 h)");
    const custom = renderBetalingContent("no", { STRIPE_SECRET_KEY: FAKE_TEST_KEY, PAYMENT_CHECKOUT_MINUTES: "45", PAYMENT_CONFIRM_HOURS: "24" });
    ok(custom.includes("innen 45 minutter") && custom.includes("innen 24 timer"), "content-04: deadlines follow PAYMENT_CHECKOUT_MINUTES / PAYMENT_CONFIRM_HOURS");
    ok(nb.includes("Du betaler ingen gebyrer") && nb.includes("tar ingen avgift") && !nb.includes("plattformavgift"), "content-05: no buyer fee, no platform fee by default");
    const feeOn = renderBetalingContent("no", { STRIPE_SECRET_KEY: FAKE_TEST_KEY, PLATFORM_FEE_BPS: "100" });
    ok(feeOn.includes("plattformavgift") && !feeOn.includes("tar ingen avgift"), "content-06: a configured platform fee is disclosed");
    ok(!/\d+(?:[.,]\d+)?\s*%/.test(nb) && !/\d+(?:[.,]\d+)?\s*%/.test(enc) && !/\+\s*\d+(?:[.,]\d+)?\s*kr/.test(nb), "content-07: no fixed Stripe price printed (VAT on the fee not verified — prerequisite 8)");
    ok(nb.includes(`href="${STRIPE_PRICING_URL}"`) && nb.includes("faktiske gebyret og nettobeløpet"), "content-08: links Stripe's price list; the actual fee is on the order page");
    ok(nb.includes("Under utprøving") && enc.includes("Being tested"), "content-09: test-mode notice while the key is not live");
    const live = renderBetalingContent("no", { STRIPE_SECRET_KEY: FAKE_LIVE_KEY });
    ok(!live.includes("Under utprøving"), "content-10: no test-mode notice with a live key");
    ok(nb.includes("hele beløpet tilbake automatisk") && nb.includes("forbrukerkjøpsloven § 41") && nb.includes("kan beholde betalingen for varer som ikke kan selges på nytt"), "content-11: cancellation and no-show rules match terms §§ 6–7");
    ok(nb.includes('href="/kjopsvilkar#angrerett"') && enc.includes('href="/en/kjopsvilkar#right-of-cancellation"'), "content-12: links the right of cancellation in the terms, in the page language");
    ok(nb.includes("godkjenner betalingen selv") && nb.includes("kan ikke betale for deg"), "content-13: an AI assistant never pays for the buyer");
    ok(nb.includes("AGENTPLATFORM.NO AS") && !/938\s?635\s?676\s*MVA/.test(nb), "content-14: operator named, no «MVA» after the org.nr.");

    // ── 3. /personvern with payments on ────────────────────────────────────
    const pvNo = invokeGet(seoRouter, "/personvern", "no").body;
    const pvEn = invokeGet(seoRouter, "/personvern", "en").body;
    ok(pvNo.includes("<h3>Forhåndsbetaling med Stripe</h3>") && pvNo.includes(`href="${STRIPE_PRIVACY_URL}"`), "privacy-03: payments on → Stripe section with Stripe's privacy policy (NO)");
    ok(pvEn.includes("<h3>Prepayment with Stripe</h3>") && pvEn.includes(`href="${STRIPE_PRIVACY_URL}"`), "privacy-04: … and EN");
    ok(pvNo.includes("produsenten ser betalingen og e-postadressen din"), "privacy-05: the buyer is told the producer sees the e-mail entered at Stripe (regardless of contact consent)");
    ok(pvNo.includes("Vi samler aldri inn eller lagrer kortopplysninger") && !pvNo.includes("Vi samler ikke inn betalingsinformasjon"), "privacy-06: «no payment information» replaced by «never card details»");
    ok(pvNo.includes("<td>Forhåndsbetaling</td><td>Avtale</td>") && pvEn.includes("<td>Prepayment</td><td>Contract</td>"), "privacy-07: legal basis row");
    ok(pvNo.includes("Forhåndsbetaling behandles av") && pvNo.includes("utenfor EU/EØS"), "privacy-08: transfer outside the EU/EEA disclosed");
    const pp = renderPrepaymentPrivacy("no");
    ok(pp.section.includes("e-postadresse, navn og adressen til produsentsiden"), "privacy-09: states what onboarding sends to Stripe");
    const svcSrc = read("services/payment-service.ts");
    const createBlock = svcSrc.slice(svcSrc.indexOf("async function createProducerAccount("), svcSrc.indexOf("async function createProducerAccount(") + 2500);
    ok(/contact_email/.test(createBlock) && /business_profile:\s*\{\s*name: agent\.name,\s*url:/.test(createBlock) && !/phone|address:/.test(createBlock.slice(0, createBlock.indexOf("metadata"))),
      "privacy-10: pin — onboarding sends only e-mail, name and producer URL");
    ok(!/customer_details|customer_email/.test(svcSrc), "privacy-11: pin — no buyer e-mail from Checkout is read or stored");

    // ── 4. /produsentvilkar ────────────────────────────────────────────────
    const pv = invokeGet(seoRouter, "/produsentvilkar").body;
    ok(pv.includes("Vilkår for produsenter") && pv.includes(`versjon ${PRODUSENTVILKAR_VERSION}`), "terms-01: producer terms with the current version");
    ok(pv.includes("innen 48 timer") && pv.includes("tar i dag ingen avgift"), "terms-02: confirmation deadline from the env, no platform fee");
    ok(pv.includes("angrerettloven § 9 a") && pv.includes("kjøpsloven"), "terms-03: trader declaration and its consequence");
    ok(pv.includes("refunderes kunden automatisk") && pv.includes("forbrukerkjøpsloven § 41"), "terms-04: refund rules match onOrderTransitioned");
    ok(pv.includes("For varer du kan selge på nytt, refunderer du kunden i Stripe") && !pv.includes("beholder du betalingen, med mindre"), "terms-05: no-show rule matches kjøpsvilkår §7 (resalable goods are refunded)");
    ok(pv.includes("«Kunden har avbestilt», ikke som et avslag"), "terms-06: a buyer withdrawal is recorded as such, not as the producer's decline");
  } catch (err: any) {
    failed++;
    failures.push("✗ unexpected error: " + String(err?.stack || err));
  } finally {
    for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runRfbBetalingTests({ log: true }).then((s) => {
    console.log(`\nrfb-betaling: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed) { for (const f of s.failures) console.log(f); process.exit(1); }
    process.exit(0);
  });
}
