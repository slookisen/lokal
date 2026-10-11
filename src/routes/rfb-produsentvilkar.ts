// ─── /produsentvilkar — terms for producers taking prepayment ───────────
// A2A dev-request 2026-10-09-rfb-forhandsbetaling-stripe-connect,
// prerequisite 4. Norwegian only (the owner portal is Norwegian only).
// Every promise here must match the code:
//   - the producer is the seller; the platform never receives or holds the
//     money (direct charges on the producer's own Stripe account,
//     services/payment-provider.ts);
//   - the reservation is captured on confirmation, released on decline and
//     when not confirmed within PAYMENT_CONFIRM_HOURS (default 48), refunded
//     automatically when the producer cancels after capture, captured on
//     a no-show (the producer refunds resalable goods, terms §7), not
//     refunded automatically when the buyer cancels after capture
//     (services/payment-service.ts onOrderTransitioned);
//   - no platform fee today (PLATFORM_FEE_* default 0);
//   - the trader declaration is shown to buyers (payments[] and the order
//     view: seller_trader_status).
// rfb-betaling.test.ts pins these facts.

import { getConfig } from "../config/vertical-config";
import { companyOperatorSentence } from "../services/company-legal";
import { PRODUSENTVILKAR_LAST_UPDATED, PRODUSENTVILKAR_VERSION } from "../config/producer-terms";
import { confirmHours } from "../services/payment-service";

export function renderProdusentvilkarContent(): string {
  const cfg = getConfig();
  const brand = `<span translate="no">${cfg.display_name}</span>`;
  const mail = `kontakt@${cfg.domain}`;
  const mailLink = `<a href="mailto:${mail}">${mail}</a>`;
  const hours = confirmHours();
  return `
  <section class="pv-hero">
    <h1>Vilkår for produsenter</h1>
    <p>Hva som gjelder når du tar imot bestillinger og forhåndsbetaling via ${brand}.</p>
  </section>

  <section class="pv-sec">
    <h2 id="avtalen">1. Hvem avtalen er mellom</h2>
    <p>${brand} drives av ${companyOperatorSentence("nb").replace(/^Operatør: /, "")} Vilkårene gjelder mellom oss og deg som produsent når du tar imot forhåndsbetaling via ${brand}. Du godtar dem i eierportalen før du kobler til Stripe.</p>

    <h2 id="selger">2. Du er selger</h2>
    <p>Du selger varene direkte til kunden, og kjøpsavtalen er mellom deg og kunden. Du er ansvarlig for varene, prisene, opplysningene om varene og at maten er trygg. ${brand} formidler bestillingen og er ikke part i kjøpet. Kunden handler etter <a href="/kjopsvilkar">kjøpsvilkårene</a>, og du må overholde rettighetene kunden har etter forbrukerkjøpsloven og angrerettloven når du selger som næringsdrivende.</p>

    <h2 id="naeringsdrivende">3. Næringsdrivende eller privatperson</h2>
    <p>Du oppgir om du selger som næringsdrivende, for eksempel gjennom et enkeltpersonforetak, et aksjeselskap eller et samvirke, eller som privatperson. Vi viser opplysningen til kunden når kunden betaler, slik angrerettloven § 9 a krever. Selger du som privatperson, gjelder ikke forbrukerkjøpsloven og angrerettloven for kjøpet, men kjøpsloven. Oppgi riktig status og endre den i eierportalen hvis den endrer seg.</p>

    <h2 id="bestillinger">4. Bestillinger</h2>
    <p>Du bekrefter eller avslår bestillinger på siden du får lenke til i e-posten. Når du bekrefter, er kjøpet bindende. Kan du ikke levere en bekreftet bestilling, kansellerer du den på samme side. Gir kunden beskjed om at bestillingen trekkes tilbake eller avbestilles, registrerer du det som «Kunden har avbestilt», ikke som et avslag.</p>

    <h2 id="forhandsbetaling">5. Forhåndsbetaling med Stripe</h2>
    <ul>
      <li>Du oppretter din egen Stripe-konto og godtar Stripes egne vilkår der. Kundens betaling går direkte til din Stripe-konto. ${brand} mottar eller holder aldri pengene.</li>
      <li>Beløpet reserveres når kunden betaler, og trekkes når du bekrefter bestillingen. Først når beløpet er reservert, får du bestillingen på e-post.</li>
      <li>Avslår du, eller bekrefter du ikke innen ${hours} timer, frigjøres reservasjonen. Bestillingen kanselleres da hvis du ikke har bekreftet.</li>
      <li>Kansellerer du etter at beløpet er trukket fordi du ikke kan levere, refunderes kunden automatisk.</li>
      <li>Avbestiller kunden etter at beløpet er trukket, refunderer du selv i Stripe, helt eller delvis. Du kan kreve dekket dokumentert tap (forbrukerkjøpsloven § 41).</li>
      <li>Henter ikke kunden varene, trekkes betalingen. Du kan beholde den for varer som er klargjort og ikke kan selges på nytt. For varer du kan selge på nytt, refunderer du kunden i Stripe (kjøpsvilkårene punkt 7).</li>
      <li>Bruker kunden angreretten, eller har kunden krav etter en reklamasjon, refunderer du selv i Stripe innen fristene i kjøpsvilkårene og loven.</li>
      <li>Stripe trekker sitt gebyr fra hver betaling. Du ser gebyret i Stripe og på ordresiden. Refusjoner og innsigelser (tvister) håndterer du i Stripe, og Stripe belaster deg eventuelle gebyrer for tvister.</li>
    </ul>

    <h2 id="gebyr">6. Gebyr til ${brand}</h2>
    <p>${brand} tar i dag ingen avgift for bestillinger eller forhåndsbetaling. Hvis vi vil innføre en avgift, varsler vi deg minst 30 dager før, og den gjelder bare hvis du godtar den.</p>

    <h2 id="kundeopplysninger">7. Kundeopplysninger</h2>
    <p>Når kunden har samtykket til det, får du kundens navn og kontaktopplysninger for å gjennomføre bestillingen. Du skal bare bruke dem til det, og ikke til markedsføring. Se <a href="/personvern">personvernerklæringen</a>.</p>

    <h2 id="avslutning">8. Avslutning</h2>
    <p>Du kan når som helst slå av bestillinger i eierportalen og koble Stripe-kontoen fra ${brand}. Bestillinger du allerede har bekreftet, må du levere eller kansellere. Vi kan stanse forhåndsbetaling for en produsent ved misbruk, gjentatte klager eller hvis Stripe stenger kontoen.</p>

    <h2 id="ansvar">9. Ansvar</h2>
    <p>${brand} er ikke ansvarlig for varene, for Stripes tjenester eller for tap fordi en bestilling ikke blir gjennomført. Det gjelder ikke ansvar vi har etter ufravikelig lov.</p>

    <h2 id="endringer">10. Endringer</h2>
    <p>Gjør vi vesentlige endringer i vilkårene, varsler vi deg og ber deg godta de nye vilkårene i eierportalen før du kobler til Stripe på nytt eller fortsetter etter at endringen trer i kraft.</p>

    <h2 id="lovvalg">11. Lovvalg og kontakt</h2>
    <p>Vilkårene følger norsk rett. Spørsmål sender du til ${mailLink}.</p>

    <p class="pv-updated">Sist oppdatert: ${PRODUSENTVILKAR_LAST_UPDATED} (versjon ${PRODUSENTVILKAR_VERSION})</p>
  </section>`;
}
