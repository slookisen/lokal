// ─── /betaling — «Slik fungerer betaling» (skive 4, AC6) ────────────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect, skive 4
// «Åpenhet». Norwegian + English (/en/betaling via the language prefix
// middleware). Registered in seo.ts next to /kjopsvilkar, and only served
// while the payment lifecycle is on (PAYMENTS_ENABLED=1 or "drain") — with
// payments off the route falls through to the 404 of the city catch-all.
//
// Every promise here must match the code:
//   - the producer is the seller; the money goes to the producer's own
//     Stripe account (direct charges, services/payment-provider.ts) and the
//     platform never receives or holds it;
//   - the link is valid for PAYMENT_CHECKOUT_MINUTES; unpaid → the order
//     goes to the producer as pay at pickup (applySessionExpired);
//   - reserved on payment, captured on confirmation, released on decline and
//     when not confirmed within PAYMENT_CONFIRM_HOURS (runPaymentMaintenance);
//   - refunded automatically when the producer cancels after capture; kept
//     on a no-show and on a buyer cancellation after capture, where the
//     producer refunds in Stripe (onOrderTransitioned) — terms §§ 6, 7;
//   - no buyer fee; the producer pays Stripe's fee; no platform fee unless
//     PLATFORM_FEE_* is set (isPlatformFeeConfigured);
//   - no fixed Stripe price is printed (prerequisite 8: VAT on the fee is not
//     yet verified) — the producer's order page shows the actual fee.
// rfb-betaling.test.ts pins these facts.

import { getConfig } from "../config/vertical-config";
import { localizedPath, Lang } from "../i18n/t";
import { companyOperatorSentence } from "../services/company-legal";
import { checkoutMinutes, confirmHours, isPlatformFeeConfigured } from "../services/payment-service";
import { paymentsLivemode } from "../services/payment-provider";
import { KJOPSVILKAR_PATH } from "./rfb-kjopsvilkar";

export const BETALING_PATH = "/betaling";
export const STRIPE_PRICING_URL = "https://stripe.com/no/pricing";

export function renderBetalingContent(lang: Lang, env: NodeJS.ProcessEnv = process.env): string {
  const cfg = getConfig();
  const brand = `<span translate="no">${cfg.display_name}</span>`;
  const mail = `kontakt@${cfg.domain}`;
  const mailLink = `<a href="mailto:${mail}">${mail}</a>`;
  const minutes = checkoutMinutes(env);
  const hours = confirmHours(env);
  const feeOn = isPlatformFeeConfigured(env);
  const live = paymentsLivemode(env);
  const drain = env.PAYMENTS_ENABLED === "drain";
  const terms = localizedPath(KJOPSVILKAR_PATH, lang);

  if (lang === "en") {
    return `
  <section class="pv-hero">
    <h1>How payment works</h1>
    <p>Some producers on ${brand} take prepayment. This is how it works.</p>
  </section>

  <section class="pv-sec">
    ${drain ? `<p class="pv-form"><strong>Paused.</strong> Prepayment is paused for now: new orders are paid at pickup. Payments already made are handled as described here.</p>` : ""}
    ${live ? "" : `<p class="pv-form"><strong>Being tested.</strong> Prepayment is currently only running in Stripe's test mode. No real payments are taken.</p>`}
    <h2 id="seller">The producer is the seller</h2>
    <p>You buy directly from the producer. The payment is processed by Stripe and goes straight to the producer's own Stripe account. ${brand} never receives or holds the money and never sees your card details.</p>

    <h2 id="who">Who takes prepayment</h2>
    <p>Only producers who have connected their own Stripe account. With all other producers you pay at pickup, as before. When a producer takes prepayment you get a payment link after sending the order. If you do not pay within ${minutes} minutes, the order goes to the producer as pay at pickup.</p>

    <h2 id="steps">Reserved first, charged when the producer confirms</h2>
    <ol>
      <li>You pay through Stripe. The amount is reserved on your card, not charged.</li>
      <li>The producer confirms the order. Only then is the amount charged.</li>
      <li>If the producer declines, or has not confirmed within ${hours} hours, the order is cancelled and the reservation released. You are not charged. Your bank may take a few days to free a reserved amount.</li>
    </ol>

    <h2 id="cancellation">Cancellation</h2>
    <ul>
      <li><strong>The producer cannot deliver after charging:</strong> you get the full amount back automatically.</li>
      <li><strong>You cancel before the producer confirms:</strong> tell the producer. The reservation is released.</li>
      <li><strong>You cancel after the producer has confirmed:</strong> tell the producer. The producer refunds you, minus any documented loss the cancellation causes (Consumer Purchases Act § 41), for example fresh goods prepared for you that cannot be sold again.</li>
      <li><strong>You do not pick up:</strong> the producer may keep the payment for goods that cannot be sold again, and refunds the rest.</li>
    </ul>
    <p>Refunds go back to the same card, without a fee. It usually takes 5 to 10 business days before the money shows up, depending on your bank.</p>

    <h2 id="right-of-cancellation">Right of cancellation</h2>
    <p>As a rule you have 14 days' right of cancellation from the day you pick up the goods. It does not apply to goods that deteriorate or expire quickly, such as fresh vegetables, meat, fish, eggs, dairy and baked goods, or to sealed goods that are not suitable for return for health or hygiene reasons once the seal has been broken after pickup. Details and the cancellation form are in the <a href="${terms}#right-of-cancellation">terms of purchase</a>. Producers that take prepayment state whether they sell as a trader, and we show it before you pay.</p>

    <h2 id="fees">Fees</h2>
    <p><strong>You pay no fee.</strong> The price you see is the price you pay.</p>
    <p>The producer pays Stripe's fee for the card payment, according to <a href="${STRIPE_PRICING_URL}">Stripe's price list</a>. ${feeOn ? `${brand} also takes a platform fee from the producer, deducted from the producer's payout.` : `${brand} takes no fee.`} The producer sees the actual fee and the net amount for each order on the order page.</p>

    <h2 id="ai">Orders through an AI assistant</h2>
    <p>An AI assistant can send the order for you, but you open the payment link and approve the payment yourself in Stripe. The assistant never sees your card details and cannot pay for you.</p>

    <h2 id="questions">Questions</h2>
    <p>About an order: contact the producer. The contact details are on the producer page. About the service: ${mailLink}. ${companyOperatorSentence("en")}</p>
  </section>`;
  }

  return `
  <section class="pv-hero">
    <h1>Slik fungerer betaling</h1>
    <p>Noen produsenter på ${brand} tar imot forhåndsbetaling. Slik fungerer det.</p>
  </section>

  <section class="pv-sec">
    ${drain ? `<p class="pv-form"><strong>Satt på pause.</strong> Forhåndsbetaling er satt på pause: nye bestillinger betales ved henting. Betalinger som allerede er gjort, behandles som beskrevet her.</p>` : ""}
    ${live ? "" : `<p class="pv-form"><strong>Under utprøving.</strong> Forhåndsbetaling kjører foreløpig bare i Stripes testmodus. Det tas ikke imot ekte betalinger.</p>`}
    <h2 id="selger">Produsenten er selger</h2>
    <p>Du kjøper direkte fra produsenten. Betalingen behandles av Stripe og går rett til produsentens egen Stripe-konto. ${brand} mottar eller oppbevarer aldri pengene og ser aldri kortopplysningene dine.</p>

    <h2 id="hvem">Hvem som tar imot forhåndsbetaling</h2>
    <p>Bare produsenter som har koblet til sin egen Stripe-konto. Hos alle andre produsenter betaler du ved henting, som før. Tar produsenten imot forhåndsbetaling, får du en betalingslenke når du har sendt bestillingen. Betaler du ikke innen ${minutes} minutter, går bestillingen til produsenten med betaling ved henting.</p>

    <h2 id="reservasjon">Først reservert, trukket når produsenten bekrefter</h2>
    <ol>
      <li>Du betaler med Stripe. Beløpet reserveres på kortet ditt, men trekkes ikke.</li>
      <li>Produsenten bekrefter bestillingen. Først da trekkes beløpet.</li>
      <li>Avslår produsenten, eller er bestillingen ikke bekreftet innen ${hours} timer, kanselleres den og reservasjonen oppheves. Du belastes ikke. Banken din kan bruke noen dager på å frigi et reservert beløp.</li>
    </ol>

    <h2 id="avbestilling">Avbestilling</h2>
    <ul>
      <li><strong>Produsenten kan ikke levere etter at beløpet er trukket:</strong> du får hele beløpet tilbake automatisk.</li>
      <li><strong>Du avbestiller før produsenten har bekreftet:</strong> gi produsenten beskjed. Reservasjonen oppheves.</li>
      <li><strong>Du avbestiller etter at produsenten har bekreftet:</strong> gi produsenten beskjed. Produsenten refunderer deg, med fradrag for dokumentert tap avbestillingen påfører produsenten (forbrukerkjøpsloven § 41), for eksempel ferskvarer som er klargjort til deg og ikke kan selges på nytt.</li>
      <li><strong>Du henter ikke:</strong> produsenten kan beholde betalingen for varer som ikke kan selges på nytt, og refunderer resten.</li>
    </ul>
    <p>Refusjon går tilbake til samme kort, uten gebyr. Det tar vanligvis 5 til 10 virkedager før pengene vises hos deg, avhengig av banken.</p>

    <h2 id="angrerett">Angrerett</h2>
    <p>Som hovedregel har du 14 dagers angrerett fra dagen du henter varene. Den gjelder ikke for varer som forringes eller raskt går ut på dato, som ferske grønnsaker, kjøtt, fisk, egg, meieriprodukter og bakevarer, og heller ikke for forseglede varer som av hensyn til helsevern eller hygiene ikke er egnet for retur, når forseglingen er brutt etter henting. Detaljer og angreskjema står i <a href="${terms}#angrerett">kjøpsvilkårene</a>. Produsenter som tar imot forhåndsbetaling, oppgir om de selger som næringsdrivende, og vi viser det før du betaler.</p>

    <h2 id="gebyrer">Gebyrer</h2>
    <p><strong>Du betaler ingen gebyrer.</strong> Prisen du ser, er prisen du betaler.</p>
    <p>Produsenten betaler Stripes gebyr for kortbetalingen, etter <a href="${STRIPE_PRICING_URL}">Stripes prisliste</a>. ${feeOn ? `${brand} tar i tillegg en plattformavgift fra produsenten, som trekkes fra produsentens utbetaling.` : `${brand} tar ingen avgift.`} Produsenten ser det faktiske gebyret og nettobeløpet for hver ordre på ordresiden.</p>

    <h2 id="ai-assistent">Bestilling via AI-assistent</h2>
    <p>En AI-assistent kan sende bestillingen for deg, men du åpner betalingslenken og godkjenner betalingen selv hos Stripe. Assistenten ser aldri kortopplysningene dine og kan ikke betale for deg.</p>

    <h2 id="sporsmal">Spørsmål</h2>
    <p>Om en bestilling: kontakt produsenten. Kontaktinformasjonen står på produsentsiden. Om tjenesten: ${mailLink}. ${companyOperatorSentence("nb")}</p>
  </section>`;
}

// ─── /personvern additions (prerequisite 7) ─────────────────────────────
// Rendered into /personvern by seo.ts only while the payment lifecycle is
// on. Facts: onboarding sends the owner's contact e-mail, the producer name
// and the producer page URL to Stripe (createProducerAccount); Checkout
// collects card details and the buyer's e-mail at Stripe, on the producer's
// own account; our payments/payment_events rows hold amounts, statuses,
// timestamps and Stripe ids — no card data, no buyer contact data (the
// webhook never stores customer_details).
export const STRIPE_PRIVACY_URL = "https://stripe.com/no/privacy";

export function renderPrepaymentPrivacy(lang: Lang): {
  section: string;
  notCollected: string;
  legalBasisRow: string;
  transfer: string;
} {
  if (lang === "en") {
    return {
      section: `
    <h3>Prepayment with Stripe</h3>
    <p>With producers that take prepayment you pay in Stripe Checkout. <span translate="no">Stripe</span> processes your card details and the email address you enter there, and the payment is registered on the producer's own Stripe account, so the producer sees the payment and your email address. We never receive your card details. We only store the payment's amount, status, timestamps and Stripe references, to capture, release and refund the amount. This record holds no contact details and is kept together with the order.</p>
    <p>When a producer connects Stripe from the owner portal, we send the producer's email address, name and the address of the producer page to Stripe to create the account. Stripe collects the rest itself. Stripe is an independent controller for its own processing, see <a href="${STRIPE_PRIVACY_URL}">Stripe's privacy policy</a>.</p>`,
      notCollected: "We never collect or store card details",
      legalBasisRow: `<tr><td>Prepayment</td><td>Contract</td><td>To carry out the payment you approve and to capture, release or refund it.</td></tr>`,
      transfer: `<li>Prepayment is processed by <span translate="no">Stripe</span>, which may process data outside the EU/EEA on its own transfer grounds (see Stripe's privacy policy)</li>`,
    };
  }
  return {
    section: `
    <h3>Forhåndsbetaling med Stripe</h3>
    <p>Hos produsenter som tar imot forhåndsbetaling, betaler du i Stripe Checkout. <span translate="no">Stripe</span> behandler kortopplysningene og e-postadressen du oppgir der, og betalingen registreres på produsentens egen Stripe-konto, slik at produsenten ser betalingen og e-postadressen din. Vi får aldri kortopplysningene dine. Vi lagrer bare betalingens beløp, status, tidspunkter og Stripes referanser, for å trekke, frigjøre og refundere beløpet. Denne posten inneholder ingen kontaktopplysninger og beholdes sammen med ordren.</p>
    <p>Når en produsent kobler til Stripe fra eierportalen, sender vi produsentens e-postadresse, navn og adressen til produsentsiden til Stripe for å opprette kontoen. Stripe innhenter resten selv. Stripe er selvstendig behandlingsansvarlig for sin egen behandling, se <a href="${STRIPE_PRIVACY_URL}">Stripes personvernerklæring</a>.</p>`,
    notCollected: "Vi samler aldri inn eller lagrer kortopplysninger",
    legalBasisRow: `<tr><td>Forhåndsbetaling</td><td>Avtale</td><td>For å gjennomføre betalingen du godkjenner, og for å trekke, frigjøre eller refundere den.</td></tr>`,
    transfer: `<li>Forhåndsbetaling behandles av <span translate="no">Stripe</span>, som kan behandle opplysninger utenfor EU/EØS etter sine egne overføringsgrunnlag (se Stripes personvernerklæring)</li>`,
  };
}
