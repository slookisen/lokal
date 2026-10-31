// ─── experiences-for-tilbydere-faq.ts ───────────────────────────────────────
// Opplevagent «For tilbydere» with sections and FAQ (A2A dev-request O4 = G4,
// slice O4a). GET /for-tilbydere in experiences-seo.ts renders this page only
// while FOR_TILBYDERE_FAQ_ENABLED is on; with the flag off the old page is
// served unchanged.
//
// ALL the new Norwegian text of the page is in this one file, as data, so
// Daniel can review it in one place. The flag stays off until he has approved
// the text. experiences-seo.ts renders it and escapes every string.
//
// Rules for the text (dev-request O4):
//   - No text names Rett fra Bonden.
//   - Visits are never confirmed automatically: the owner confirms, declines
//     or proposes a new time for each request.
//   - Opplevagent never takes payment; a gårdssalg visit is paid on arrival.
//   - Legal status (utvidet gårdssalg) only as a proposal, never as adopted law.
//   - The price text is OPPLEVAGENT_PRICE_MESSAGE, imported, never retyped.
//   - Statistics and privacy are described only in general terms.
// Not in O4a: the clickable «Mine valg» demo and the «Les mer» links from
// «Mine valg» (sellerFaq / faqAnchor) — slice O4b.

import { OPPLEVAGENT_PRICE_MESSAGE } from "../owner-features/price-message";
import type { FaqPair } from "../services/faq-section";

/** FOR_TILBYDERE_FAQ_ENABLED: "1" or "true" (any case, trimmed) = on; anything else = off. */
export function isForTilbydereFaqEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FOR_TILBYDERE_FAQ_ENABLED || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** The section anchors, in menu order. Later «Les mer» links point here — never rename after publishing. */
export const FOR_TILBYDERE_ANCHORS = [
  "slik-fungerer-det", "finn-deg", "ta-over", "bestem-selv", "besok",
  "smaking", "statistikk", "personvern", "pris", "sporsmal",
] as const;
export type ForTilbydereAnchor = (typeof FOR_TILBYDERE_ANCHORS)[number];

/** The Opplevagent contact address used on the other Opplevagent pages. */
export const FOR_TILBYDERE_CONTACT_EMAIL = "kontakt@opplevagent.no";

export interface ForTilbydereLink {
  label: string;
  href: string;
}

/** One section. Plain text only; the renderer escapes everything. */
export interface ForTilbydereSection {
  id: ForTilbydereAnchor;
  /** Short label in the top menu. */
  menu: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  /** Links shown under the text, as «Les mer»-style links. */
  links?: ForTilbydereLink[];
}

export const FOR_TILBYDERE_FAQ_META = {
  title: "For tilbydere — slik fungerer Opplevagent for deg | Opplevagent",
  metaDesc: "Driver du gårdssalg, bryggeri, sideri eller et annet besøkssted? Slik finner gjestene deg på Opplevagent, slik tar du over profilen gratis, og dette bestemmer du selv.",
  webPageName: "For tilbydere — slik fungerer Opplevagent for deg",
  h1: "For tilbydere",
  lede: "Driver du gårdssalg, bryggeri, sideri eller et annet besøkssted? Profilen din står trolig allerede på Opplevagent. Her ser du hvordan det fungerer, hva du bestemmer selv og hva det koster.",
  menuLabel: "Innhold på siden",
  faqHeading: "Spørsmål og svar",
};

export const FOR_TILBYDERE_SECTIONS: ForTilbydereSection[] = [
  {
    id: "slik-fungerer-det",
    menu: "Slik fungerer det",
    title: "Slik fungerer det",
    paragraphs: [
      "Opplevagent er en oversikt over opplevelser og gårdssalg i Norge. Hver tilbyder har en egen profilside med informasjon om stedet, hva gjestene kan oppleve og hvordan de kommer i kontakt.",
      "Profilen er laget ut fra offentlig tilgjengelig informasjon, som Brønnøysundregistrene og bedriftens egen nettside. Du trenger ikke gjøre noe for å være med. Tar du over profilen, kan du rette informasjonen og bestemme selv.",
    ],
    links: [{ label: "Les mer om hvordan Opplevagent fungerer", href: "/slik-fungerer-det" }],
  },
  {
    id: "finn-deg",
    menu: "Slik finner gjestene deg",
    title: "Slik finner gjestene deg",
    paragraphs: [
      "Profilen din vises på opplevagent.no, i søket og på sidene for kategori og sted. AI-assistenter kan også lese den når noen spør etter noe å oppleve i nærheten.",
    ],
    bullets: [
      "Gjester finner deg i søket, på kategorisidene og på sidene for fylke og kommune.",
      "AI-assistenter som ChatGPT og Claude kan hente profilen din gjennom åpne grensesnitt.",
      "Ingen tilbyder betaler for å komme høyere opp.",
    ],
    links: [{ label: "Se katalogen over gårdssalg og smaking", href: "/kategori/gardssalg" }],
  },
  {
    id: "ta-over",
    menu: "Ta over profilen",
    title: "Ta over profilen",
    paragraphs: [
      "Det er gratis å ta over profilen. Du trenger verken registrering eller passord, bare tilgang til e-postadressen som er registrert for bedriften.",
    ],
  },
  {
    id: "bestem-selv",
    menu: "Dette bestemmer du selv",
    title: "Dette bestemmer du selv",
    paragraphs: [
      "Når du har tatt over profilen, finner du «Mine valg» i eierportalen. Der velger du hvor aktiv du vil være, og slår enkeltvalg av og på.",
      "Du velger mellom to nivåer, og kan bytte når du vil.",
    ],
    bullets: [
      "«Bare synlig»: profilen vises, og gjestene får kontaktinformasjonen din.",
      "«Ta imot besøk»: gjestene kan sende deg en forespørsel om besøk. Du svarer på hver forespørsel selv.",
      "«Profilen er synlig»: slår du den av, tar profilen en pause og vises ikke i søk, lister, AI-tjenester eller kart.",
      "«Planlagt»: valg vi ikke har bygget ennå, står samlet under «Planlagt». De har ingen virkning før de er ferdige. Trykk «Gi meg beskjed» hvis du vil ha et av dem.",
    ],
  },
  {
    id: "besok",
    menu: "Besøk og booking",
    title: "Besøk og booking",
    paragraphs: [
      "Har du valgt «Ta imot besøk», kan gjester be om et besøk på profilen din eller via en AI-assistent. Et besøk blir aldri bekreftet av seg selv: du bekrefter, avslår eller foreslår et nytt tidspunkt for hver forespørsel.",
    ],
    bullets: [
      "Du får forespørselen på e-post, med en lenke til en svarside. Du trenger ikke logge inn.",
      "Alle forespørslene dine finner du også under «Mine besøk» i eierportalen.",
      "Etter besøket markerer du om gjesten kom.",
      "Gjesten betaler hos deg ved besøket. Opplevagent tar aldri imot betaling.",
      "Vil du ta en pause, kan du slå av besøk eller bruke «Sesongpause». Forespørsler du allerede har fått, må du fortsatt svare på.",
    ],
  },
  {
    id: "smaking",
    menu: "Smaking og regler",
    title: "Smaking og regler",
    paragraphs: [
      "På profilen kan du beskrive hva gjestene kan smake og kjøpe hos deg. Du bestemmer selv hva du tilbyr, og du må selv følge reglene som gjelder for din bevilling.",
      "Regjeringen har sendt på høring et forslag om utvidet gårdssalg av alkohol. Det er et forslag, ikke vedtatte regler. Vi følger prosessen, men er ikke part i den, og dette er ikke juridisk rådgivning.",
    ],
  },
  {
    id: "statistikk",
    menu: "Statistikk",
    title: "Statistikk",
    paragraphs: [
      "Når du er logget inn, kan du se statistikk over hvor mange som har sett profilen din.",
    ],
  },
  {
    id: "personvern",
    menu: "Personvern",
    title: "Personvern og avmelding",
    paragraphs: [
      "Profilen viser informasjon om bedriften din. Hvordan vi behandler opplysninger, står i personvernerklæringen.",
      "Du kan når som helst melde deg av e-poster fra oss som ikke gjelder en konkret forespørsel eller avtale. Vil du at vi skal rette eller fjerne profilen, kan du kontakte oss.",
    ],
    links: [{ label: "Les personvernerklæringen", href: "/personvern" }],
  },
  {
    id: "pris",
    menu: "Hva koster det?",
    title: "Hva koster det?",
    // The price text itself is OPPLEVAGENT_PRICE_MESSAGE, rendered first by
    // experiences-seo.ts; these paragraphs follow it.
    paragraphs: [
      "Opplevagent tar ikke imot betaling fra gjestene. Et besøk betales hos deg.",
    ],
  },
  {
    id: "sporsmal",
    menu: "Spørsmål",
    title: "Spørsmål og svar",
    paragraphs: [],
  },
];

/** The FAQ under #sporsmal. Plain text: goes into the FAQPage JSON-LD and is rendered (escaped) from there. */
export const FOR_TILBYDERE_FAQ: FaqPair[] = [
  {
    q: "Har jeg allerede en profil?",
    a: "Trolig. Vi har laget profiler for mange tilbydere ut fra offentlig tilgjengelig informasjon. Søk etter bedriften din under «Ta over profilen».",
  },
  {
    q: "Hva koster det å være på Opplevagent?",
    a: OPPLEVAGENT_PRICE_MESSAGE,
  },
  {
    q: "Hvordan tar jeg over profilen?",
    a: "Finn profilen din og trykk «Er dette din bedrift?». Vi sender en innloggingslenke til e-postadressen som er registrert for bedriften. Klikk lenken, så er profilen din. Det er gratis.",
  },
  {
    q: "Hvordan logger jeg inn senere?",
    a: "Gå til profilsiden din og bruk «Logg inn». Vi sender deg en ny innloggingslenke på e-post. Du trenger ikke passord.",
  },
  {
    q: "Blir et besøk bekreftet automatisk?",
    a: "Nei. Du bekrefter, avslår eller foreslår et nytt tidspunkt for hver forespørsel. Svarer du ikke, får du en påminnelse, og etter en tid utløper forespørselen og gjesten får beskjed.",
  },
  {
    q: "Tar Opplevagent betalt fra gjestene?",
    a: "Nei. Opplevagent tar aldri imot betaling. Gjesten betaler hos deg ved besøket.",
  },
  {
    q: "Må jeg ta imot besøk?",
    a: "Nei. Du kan velge «Bare synlig». Da vises profilen, og gjestene får kontaktinformasjonen din i stedet for å sende en forespørsel.",
  },
  {
    q: "Kan jeg ta en pause?",
    a: "Ja. Du kan slå av besøk eller bruke «Sesongpause» i «Mine valg». Du kan også sette hele profilen på pause. Forespørsler du allerede har fått, må du fortsatt svare på.",
  },
  {
    q: "Er reglene for gårdssalg av alkohol endret?",
    a: "Nei, ikke foreløpig. Regjeringen har sendt et forslag om utvidet gårdssalg av alkohol på høring, men forslaget er ikke vedtatt. Du må selv følge reglene som gjelder for din bevilling.",
  },
  {
    q: "Kan jeg melde meg av e-postene deres?",
    a: "Ja. Du kan når som helst melde deg av e-poster som ikke gjelder en konkret forespørsel, uten at profilen slettes.",
  },
  {
    q: "Hvem kan jeg kontakte?",
    a: `Send en e-post til ${FOR_TILBYDERE_CONTACT_EMAIL}.`,
  },
];

/** The one FAQPage node for the page; the visible Q/A is rendered from this same object. */
export function buildForTilbydereFaqLd(canonicalUrl: string, faq: readonly FaqPair[] = FOR_TILBYDERE_FAQ): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${canonicalUrl}#sporsmal`,
    url: canonicalUrl,
    inLanguage: "nb",
    mainEntity: faq.map((p) => ({
      "@type": "Question",
      name: p.q,
      acceptedAnswer: { "@type": "Answer", text: p.a },
    })),
  };
}
