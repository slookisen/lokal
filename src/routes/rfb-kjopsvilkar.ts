// ─── rfb-kjopsvilkar.ts ──────────────────────────────────────────────────────
// Kjøpsvilkår og refusjonsregler for rettfrabonden.com (GET /kjopsvilkar,
// /en/kjopsvilkar — the route itself is registered in seo.ts next to
// /personvern so it uses the same shell(), footer and hreflang handling).
//
// Daniel live 2026-10-10: «Lag kjøpsvilkår og refusjonsregler for
// rettfrabonden.com» (A2A daniel-responses/2026-10-10-live-kjopsvilkar-og-
// refusjonsregler.md). Prerequisite for verifying the live Stripe account
// (A2A dev-requests/2026-10-09-rfb-forhandsbetaling-stripe-connect.md).
//
// The text must stay TRUE to what the code does today:
//   - The producer is the seller; the platform (AGENTPLATFORM.NO AS) only
//     forwards the order (cart-service.ts submitCart(), order-notify-service.ts).
//   - A real order exists only after the strict real-order gate; everyone else
//     gets a contact handoff (no agreement through the platform).
//   - Orders are pickup only (orders.fulfilment = 'pickup').
//   - No payment goes through the platform today. Prepayment via Stripe
//     Connect (direct charges to the producer's own Stripe account, reserve on
//     order, capture on producer confirmation) is described as "being
//     introduced" and only for producers who offer it.
//   - There is no buyer-side cancel endpoint, so cancellation is "contact the
//     producer".
//   - Contact data reaches a producer only with consent; retention is NOT
//     restated here (the single source of truth is /personvern).
// rfb-kjopsvilkar.test.ts pins these facts against the code.

import { getConfig } from "../config/vertical-config";
import { localizedPath, Lang } from "../i18n/t";
import { companyOperatorSentence } from "../services/company-legal";

export const KJOPSVILKAR_PATH = "/kjopsvilkar";
export const KJOPSVILKAR_LAST_UPDATED = { no: "10. oktober 2026", en: "10 October 2026" } as const;

const FORBRUKERTILSYNET_URL = "https://www.forbrukertilsynet.no";
const FORBRUKERRADET_URL = "https://www.forbrukerradet.no";
const MATTILSYNET_URL = "https://www.mattilsynet.no";

export function renderKjopsvilkarContent(lang: Lang): string {
  const cfg = getConfig();
  const brand = `<span translate="no">${cfg.display_name}</span>`;
  const mail = `kontakt@${cfg.domain}`;
  const mailLink = `<a href="mailto:${mail}">${mail}</a>`;
  const privacy = localizedPath("/personvern", lang);
  const contact = localizedPath("/kontakt", lang);

  if (lang === "en") {
    return `
  <section class="pv-hero">
    <h1>Terms of purchase</h1>
    <p>What applies when you order from a producer through ${brand}, including cancellation and refunds.</p>
  </section>

  <section class="pv-sec">
    <p>These terms apply when you, as a consumer, order goods from a producer through ${brand}, on the website or through an AI assistant. They do not limit the rights you have under mandatory Norwegian consumer law.</p>

    <h2 id="seller">1. Who you buy from</h2>
    <p>The seller is the producer you order from. The purchase agreement is between you and the producer. The producer's name and contact details are shown on the producer page and in your order.</p>
    <p>${brand} is run by ${companyOperatorSentence("en").replace(/^Operator: /, "")} We forward your order to the producer. We are not the seller, and we do not own or handle the goods.</p>
    <p>The producer is responsible for the goods, prices, labelling and food safety, and for meeting your rights under the Norwegian Consumer Purchases Act and the Cancellation Act.</p>

    <h2 id="ordering">2. How ordering works</h2>
    <p>You choose goods in the cart or shopping list and send the order. Some producers do not take orders through us. For those you instead get the producer's contact details and a ready-made message, and any agreement is made directly with the producer, outside the platform. Consumer law still applies, but the sections below about ordering, payment and refunds through the platform do not.</p>
    <p>Your order is a request to the producer until the producer confirms it. The producer confirms or declines. The agreement is binding once the producer has confirmed. If the producer declines, there is no agreement and you pay nothing.</p>

    <h2 id="prices">3. Prices</h2>
    <p>Prices are set by the producer and shown in Norwegian kroner when you order. The price you saw then applies to your order. If the producer is registered for VAT, VAT is included.</p>
    <p>${brand} charges you no fee as a buyer.</p>
    <p>If a price contains an obvious error, the producer may decline the order.</p>

    <h2 id="payment">4. Payment</h2>
    <p>Today you pay the producer at pickup, with the payment methods the producer accepts. We do not charge your card and we do not receive money for the goods.</p>
    <p><strong>Prepayment</strong> is being introduced and applies only to producers who offer it. The payment is processed by Stripe and goes directly to the producer's own Stripe account. ${brand} never receives or holds the money and never sees your card details. The amount is reserved when you pay and is only charged when the producer confirms the order. If the producer declines, or does not confirm within the deadline shown when you pay, the reservation is cancelled and nothing is charged. Your bank may take a few days to release a reserved amount.</p>

    <h2 id="pickup">5. Pickup</h2>
    <p>All orders are picked up from the producer, or at the place the producer states. We do not offer delivery.</p>
    <p>You agree the pickup time with the producer. You can write a wish in the order, and the producer contacts you if you have shared your contact details. The producer must have the goods ready at the agreed time.</p>

    <h2 id="cancellation">6. Cancellation and changes</h2>
    <p>To cancel or change an order, contact the producer directly as early as possible.</p>
    <p>Before the producer has confirmed the order, you can withdraw it at no cost by telling the producer. If you have prepaid, the reservation is cancelled.</p>
    <p>Once confirmed, the order is binding. For goods that do not deteriorate quickly you still have a right of cancellation, see section 8. For fresh goods the producer decides whether a cancellation can be accepted.</p>
    <p>If the producer cannot deliver after confirming, you get the full amount back.</p>

    <h2 id="no-show">7. If you do not pick up</h2>
    <p>If you do not pick up the goods at the agreed time without letting the producer know, the producer may claim payment for goods that were prepared and cannot be sold again, and may keep a prepayment for such goods. For goods that can be sold again, the producer must refund the prepayment.</p>

    <h2 id="right-of-cancellation">8. Right of cancellation (angrerett)</h2>
    <p>A purchase through ${brand} is a distance sale. Under the Norwegian Cancellation Act you have a 14-day right of cancellation, counted from the day you pick up the goods.</p>
    <p>The right of cancellation does not apply to (Cancellation Act section 22):</p>
    <ul>
      <li>goods that deteriorate or expire quickly, for example fresh vegetables, fruit, berries, meat, fish, eggs, dairy products and baked goods;</li>
      <li>sealed goods that are not suitable for return for health or hygiene reasons once the seal is broken, for example opened honey or jam.</li>
    </ul>
    <p>To use your right of cancellation, give the producer a clear message within the deadline, for example by e-mail. You can use the standard cancellation form from the <a href="${FORBRUKERTILSYNET_URL}">Norwegian Consumer Authority</a>. Return the goods to the producer no later than 14 days after your message; you cover any cost of returning them. The producer refunds what you paid within 14 days of receiving your message, but may wait until the goods have been received.</p>

    <h2 id="complaints">9. Defects (reklamasjon)</h2>
    <p>If there is something wrong with the goods, tell the producer within a reasonable time after you discovered it. For food this should happen as soon as possible. Your complaint is always in time if you give notice within two months of discovering the defect, and at the latest two years after you picked up the goods (Consumer Purchases Act).</p>
    <p>Under the Consumer Purchases Act you can require the defect to be remedied, a replacement, a price reduction, cancellation of the purchase or compensation. The producer is responsible.</p>
    <p>If you suspect that a product is a health risk, you can also report it to the <a href="${MATTILSYNET_URL}">Norwegian Food Safety Authority</a>.</p>

    <h2 id="refund">10. Refunds</h2>
    <p>Refunds come from the producer, not from ${brand}. You are entitled to a refund if you use your right of cancellation, if the purchase is cancelled or the price reduced because of a defect, or if the producer cannot deliver after confirming.</p>
    <ul>
      <li><strong>Paid at pickup:</strong> you agree the refund with the producer, normally using the same payment method.</li>
      <li><strong>Prepaid through Stripe:</strong> the amount is refunded to the same card or payment method. It usually takes 5 to 10 business days before the money shows, depending on your bank.</li>
    </ul>
    <p>An order the producer declines, or does not confirm in time, is never charged, so there is nothing to refund: the reservation is simply cancelled.</p>
    <p>Refunds must be made without undue delay and no later than the deadlines the law sets.</p>

    <h2 id="ai-assistants">11. Ordering through an AI assistant</h2>
    <p>You can order through an AI assistant that uses our open interfaces (MCP, A2A and the API). The assistant acts on your behalf, and orders it sends for you count as your orders. The assistant never receives card details: any prepayment must always be approved by you in the payment page. Your contact details are shared with a producer only when you have consented.</p>

    <h2 id="privacy">12. Personal data</h2>
    <p>Your name, e-mail and phone number are passed to the producers you order from only when you consent when you send the order. How we process personal data, and for how long, is described in the <a href="${privacy}">privacy policy</a>.</p>

    <h2 id="disputes">13. Complaints and disputes</h2>
    <p>Contact the producer first. If you cannot agree, contact us at ${mailLink}, and we will help as far as we can as the intermediary.</p>
    <p>You can also complain to the <a href="${FORBRUKERRADET_URL}">Norwegian Consumer Council</a>, which can mediate. The case can then be brought before the Consumer Complaints Committee (Forbrukerklageutvalget).</p>
    <p>Norwegian law applies.</p>

    <h2 id="contact">14. Contact and changes</h2>
    <p>E-mail: ${mailLink}. ${companyOperatorSentence("en")} Full company details are on the <a href="${contact}">contact page</a>.</p>
    <p>We may change these terms. An order follows the terms that applied when you placed it.</p>

    <p class="pv-updated">Last updated: ${KJOPSVILKAR_LAST_UPDATED.en}</p>
  </section>`;
  }

  return `
  <section class="pv-hero">
    <h1>Kjøpsvilkår</h1>
    <p>Dette gjelder når du bestiller fra en produsent gjennom ${brand}, også avbestilling og refusjon.</p>
  </section>

  <section class="pv-sec">
    <p>Disse vilkårene gjelder når du som forbruker bestiller varer fra en produsent gjennom ${brand}, på nettsiden eller via en AI-assistent. De begrenser ikke rettighetene du har etter ufravikelig forbrukerlovgivning.</p>

    <h2 id="selger">1. Hvem du handler med</h2>
    <p>Selger er produsenten du bestiller fra. Avtalen om kjøpet inngås mellom deg og produsenten. Produsentens navn og kontaktinformasjon vises på produsentsiden og i bestillingen.</p>
    <p>${brand} drives av ${companyOperatorSentence("nb").replace(/^Operatør: /, "")} Vi formidler bestillingen til produsenten. Vi er ikke selger, og vi eier eller håndterer ikke varene.</p>
    <p>Produsenten er ansvarlig for varene, prisene, merking og mattrygghet, og for å oppfylle rettighetene dine etter forbrukerkjøpsloven og angrerettloven.</p>

    <h2 id="bestilling">2. Slik bestiller du</h2>
    <p>Du velger varer i handlekurven eller handlelisten og sender bestillingen. Noen produsenter tar ikke imot bestillinger gjennom oss. Da får du i stedet produsentens kontaktinformasjon og en ferdig melding, og eventuell avtale gjør du direkte med produsenten, utenfor plattformen. Forbrukerlovgivningen gjelder også da, men punktene under om bestilling, betaling og refusjon gjennom plattformen gjør det ikke.</p>
    <p>Bestillingen er en forespørsel til produsenten til produsenten har bekreftet den. Produsenten bekrefter eller avslår. Avtalen er bindende når produsenten har bekreftet. Avslår produsenten, er det ingen avtale, og du betaler ingenting.</p>

    <h2 id="priser">3. Priser</h2>
    <p>Prisene settes av produsenten og vises i norske kroner når du bestiller. Prisen du så da, gjelder for bestillingen. Er produsenten registrert i Merverdiavgiftsregisteret, er MVA inkludert.</p>
    <p>${brand} tar ikke gebyr fra deg som kjøper.</p>
    <p>Inneholder en pris en åpenbar feil, kan produsenten avslå bestillingen.</p>

    <h2 id="betaling">4. Betaling</h2>
    <p>I dag betaler du produsenten ved henting, med betalingsmåtene produsenten tar imot. Vi belaster ikke kortet ditt og tar ikke imot penger for varene.</p>
    <p><strong>Forhåndsbetaling</strong> er under innføring og gjelder bare produsenter som tilbyr det. Betalingen behandles av Stripe og går direkte til produsentens egen Stripe-konto. ${brand} mottar eller oppbevarer aldri pengene og ser aldri kortopplysningene dine. Beløpet reserveres når du betaler, og trekkes først når produsenten bekrefter bestillingen. Avslår produsenten, eller bekrefter ikke innen fristen som vises når du betaler, oppheves reservasjonen, og ingenting trekkes. Banken din kan bruke noen dager på å frigi et reservert beløp.</p>

    <h2 id="henting">5. Henting</h2>
    <p>Alle bestillinger hentes hos produsenten eller på stedet produsenten oppgir. Vi tilbyr ikke levering.</p>
    <p>Hentetid avtaler du med produsenten. Du kan skrive et ønske i bestillingen, og produsenten kontakter deg hvis du har delt kontaktinformasjonen din. Produsenten skal ha varene klare til avtalt tid.</p>

    <h2 id="avbestilling">6. Avbestilling og endring</h2>
    <p>Vil du avbestille eller endre en bestilling, kontakter du produsenten direkte så tidlig som mulig.</p>
    <p>Før produsenten har bekreftet bestillingen, kan du trekke den tilbake uten kostnad ved å gi produsenten beskjed. Har du forhåndsbetalt, oppheves reservasjonen.</p>
    <p>Etter bekreftelse er bestillingen bindende. For varer som ikke raskt forringes, har du likevel angrerett, se punkt 8. For ferskvarer avgjør produsenten om en avbestilling kan godtas.</p>
    <p>Kan produsenten ikke levere etter å ha bekreftet, får du hele beløpet tilbake.</p>

    <h2 id="ikke-hentet">7. Hvis du ikke henter</h2>
    <p>Henter du ikke varene til avtalt tid uten å gi produsenten beskjed, kan produsenten kreve betaling for varer som er klargjort og ikke kan selges på nytt, og beholde en forhåndsbetaling for slike varer. For varer som kan selges på nytt, skal produsenten refundere forhåndsbetalingen.</p>

    <h2 id="angrerett">8. Angrerett</h2>
    <p>Kjøp gjennom ${brand} er fjernsalg. Etter angrerettloven har du 14 dagers angrerett, regnet fra dagen du henter varene.</p>
    <p>Angreretten gjelder ikke for (angrerettloven § 22):</p>
    <ul>
      <li>varer som raskt kan forringes eller bli for gamle, for eksempel ferske grønnsaker, frukt, bær, kjøtt, fisk, egg, meieriprodukter og bakevarer;</li>
      <li>forseglede varer som av helse- eller hygienehensyn ikke egner seg for retur når forseglingen er brutt, for eksempel åpnet honning eller syltetøy.</li>
    </ul>
    <p>Vil du bruke angreretten, gir du produsenten en klar melding innen fristen, for eksempel på e-post. Du kan bruke standard angreskjema fra <a href="${FORBRUKERTILSYNET_URL}">Forbrukertilsynet</a>. Lever varene tilbake til produsenten senest 14 dager etter meldingen. Du dekker eventuelle kostnader ved å returnere dem. Produsenten betaler tilbake det du har betalt innen 14 dager etter å ha mottatt meldingen, men kan vente til varene er mottatt.</p>

    <h2 id="reklamasjon">9. Reklamasjon ved feil</h2>
    <p>Er det feil ved en vare, gir du produsenten beskjed innen rimelig tid etter at du oppdaget feilen. For matvarer bør det skje så raskt som mulig. Du har alltid reklamert i tide hvis du gir beskjed innen to måneder etter at du oppdaget feilen, og senest to år etter at du hentet varen (forbrukerkjøpsloven).</p>
    <p>Etter forbrukerkjøpsloven kan du kreve retting, ny vare, prisavslag, heving eller erstatning. Produsenten er ansvarlig.</p>
    <p>Mistenker du at en vare er helsefarlig, kan du også melde fra til <a href="${MATTILSYNET_URL}">Mattilsynet</a>.</p>

    <h2 id="refusjon">10. Refusjon</h2>
    <p>Refusjon kommer fra produsenten, ikke fra ${brand}. Du har krav på refusjon når du bruker angreretten, når kjøpet heves eller prisen settes ned på grunn av en feil, og når produsenten ikke kan levere etter å ha bekreftet.</p>
    <ul>
      <li><strong>Betalt ved henting:</strong> du avtaler refusjonen med produsenten, normalt med samme betalingsmåte.</li>
      <li><strong>Forhåndsbetalt via Stripe:</strong> beløpet betales tilbake til samme kort eller betalingsmåte. Det tar vanligvis 5 til 10 virkedager før pengene vises hos deg, avhengig av banken.</li>
    </ul>
    <p>En bestilling som produsenten avslår eller ikke bekrefter i tide, blir aldri belastet. Da er det ingenting å refundere, reservasjonen oppheves bare.</p>
    <p>Refusjon skal skje uten unødig opphold og senest innen fristene loven setter.</p>

    <h2 id="ai-assistent">11. Bestilling via AI-assistent</h2>
    <p>Du kan bestille via en AI-assistent som bruker de åpne grensesnittene våre (MCP, A2A og API). Assistenten handler på dine vegne, og bestillinger den sender for deg, regnes som dine. Assistenten får aldri kortopplysninger: en eventuell forhåndsbetaling må alltid godkjennes av deg på betalingssiden. Kontaktinformasjonen din deles med en produsent bare når du har samtykket.</p>

    <h2 id="personopplysninger">12. Personopplysninger</h2>
    <p>Navn, e-post og telefonnummer sendes videre til produsentene du bestiller fra, bare når du samtykker til det når du sender bestillingen. Hvordan vi behandler personopplysninger, og hvor lenge, står i <a href="${privacy}">personvernerklæringen</a>.</p>

    <h2 id="tvister">13. Klager og tvister</h2>
    <p>Ta først kontakt med produsenten. Blir dere ikke enige, kan du kontakte oss på ${mailLink}, så hjelper vi til så langt vi kan som formidler.</p>
    <p>Du kan også klage til <a href="${FORBRUKERRADET_URL}">Forbrukerrådet</a>, som kan mekle. Saken kan deretter bringes inn for Forbrukerklageutvalget.</p>
    <p>Norsk rett gjelder.</p>

    <h2 id="kontakt">14. Kontakt og endringer</h2>
    <p>E-post: ${mailLink}. ${companyOperatorSentence("nb")} Fullstendige selskapsopplysninger står på <a href="${contact}">kontaktsiden</a>.</p>
    <p>Vi kan endre vilkårene. En bestilling følger vilkårene som gjaldt da du bestilte.</p>

    <p class="pv-updated">Sist oppdatert: ${KJOPSVILKAR_LAST_UPDATED.no}</p>
  </section>`;
}
