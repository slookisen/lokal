// ─── rfb-for-produsenter.ts ─────────────────────────────────────────────────
// «Slik fungerer Rett fra Bonden for produsenter» (GET /for-produsenter,
// /en/for-produsenter — registered in seo.ts next to /kjopsvilkar so it uses
// the same shell(), footer and hreflang handling).
//
// A2A dev-request 2026-10-22-rfb-for-produsenter-faq-side, slice F1: the page
// behind FOR_PRODUSENTER_PAGE_ENABLED (default off), one sticky section menu,
// and one FAQPage whose visible Q/A is rendered from the SAME JSON-LD object
// (faqPairsFromJsonLd), so markup and text cannot drift (AC4). The text is a
// draft for Daniel's approval; the flag is turned on only after that approval
// and his rollout GO for «Mine valg» (dev-request «Rekkefølge»).
// Not in F1: the clickable «Mine valg» demo, registry fields sellerFaq /
// faqAnchor, «Les mer» links from «Mine valg», the /teknologi box and the
// profile-banner link.
//
// The text must stay TRUE to what the code does today (rfb-for-produsenter.
// test.ts pins these facts):
//   - Two levels only, «Bare synlig» and «Ta imot bestillinger»
//     (owner-features/changes.ts OWNER_LEVELS); the list of choices available
//     today is read from the registry (status !== coming_soon); everything
//     else is called «planlagt».
//   - Orders: only to an owner-claimed producer with orders on
//     (cart-service isEligibleForRealOrder), e-mail «Ny henteordre», confirm /
//     decline without login, reminder after ORDER_REMINDER_HOURS (24) and
//     cancellation after ORDER_AUTOCANCEL_HOURS (72) (order-followups.ts),
//     pickup only and pay at pickup, daily cap ORDER_CAP_NEW_PER_PRODUCER_PER_DAY
//     (10) → contact details instead, «Hentet» on the order page (B3),
//     producer-stated stock expires after SUPPLY_GRAPH_STALE_DAYS (14).
//   - Flag-dependent promises follow the flag (ForProdusenterFacts): the
//     automatic close only while ORDER_AUTOCOMPLETE_ENABLED; «kunden får
//     beskjed» on cancellation only while ORDER_BUYER_RECEIPTS_ENABLED; stock
//     and products «i eierportalen» only while OWNER_ORDERABILITY_PORTAL_ENABLED
//     (else the /selger «Produkter» tab, «Tilgjengelighet»); the stock-check
//     reminder is listed as available only while STOCK_CHECK_EMAIL_ENABLED;
//     with OWNER_AUTO_UPDATES_ENABLED (auto.updates live, dev-request
//     2026-11-01-rfb-hold-profilen-oppdatert) the sentences that call the
//     update choice planned, or new information «a suggestion», are left out
//     (no replacement text without Daniel's approval).
//   - Every real order needs buyer contact + consent (CONTACT_REQUIRED_ERROR).
//   - «Verifisert av eier» is the only badge that shows owner confirmation
//     (profiles also carry Brreg / Debio badges).
//   - Prepayment via Stripe is «planlagt» (KJOPSVILKAR_PREPAYMENT_LIVE false).
//   - Price: no fee today; at least 30 days' notice and it applies only if the
//     producer accepts (rfb-produsentvilkar.ts §6 «Gebyr»).
//   - Statistics: «Med i AI-søk»; public numbers only from PUBLIC_STATS_MIN_VIEWS
//     (20) human page views over 12 months; the owner always sees their own;
//     no e-mail report yet (notify.report coming_soon).
//   - Product import from the website is «planlagt» (products.import
//     coming_soon).

import { localizedPath, type Lang } from "../i18n/t";
import { faqPairsFromJsonLd, type FaqPair } from "../services/faq-section";
import { OWNER_FEATURE_REGISTRY, ownerAutoUpdatesEnabled, ownerFeatureStatus, type OwnerFeatureEntry } from "../owner-features/registry";
import { OWNER_LEVELS } from "../owner-features/changes";
import { orderReminderHours, orderAutocancelHours } from "../services/order-followups";
import { orderCapNewPerDay } from "../services/cart-service";
import { isOrderAutocompleteEnabled } from "../services/order-lifecycle";
import { publicStatsMinViews } from "../services/public-stats-threshold";
import { getSupplyGraphStaleDays } from "../services/supply-graph";
import { isBuyerReceiptsEnabled } from "../services/order-receipt-service";
import { ownerOrderabilityPortalEnabled } from "../services/owner-orderability";
import { isStockCheckEmailEnabled } from "../services/stock-check-reminder";

export const FOR_PRODUSENTER_PATH = "/for-produsenter";

/** FOR_PRODUSENTER_PAGE_ENABLED: "1" or "true" (any case, trimmed) = on; anything else = off. */
export function isForProdusenterPageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.FOR_PRODUSENTER_PAGE_ENABLED || "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Sitemap paths for this page: [] while the flag is off. */
export function forProdusenterSitemapPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return isForProdusenterPageEnabled(env) ? [FOR_PRODUSENTER_PATH] : [];
}

/** Header «For produsenter» target: /selger (as before) while the flag is off. */
export function forProducersNavHref(lang: Lang, env: NodeJS.ProcessEnv = process.env): string {
  return isForProdusenterPageEnabled(env) ? localizedPath(FOR_PRODUSENTER_PATH, lang) : "/selger";
}

/** The anchors, in menu order. Used by «Les mer» links later — never rename after publishing. */
export const FOR_PRODUSENTER_ANCHORS = [
  "oversikt", "synlighet", "eierskap", "mine-valg", "bestillinger", "betaling",
  "oppdatering", "statistikk", "personvern", "pris", "kontakt",
] as const;
export type ForProdusenterAnchor = (typeof FOR_PRODUSENTER_ANCHORS)[number];

/** Numbers the text quotes, read from the same configuration the code uses. */
export interface ForProdusenterFacts {
  reminderHours: number;
  autocancelHours: number;
  dailyCap: number;
  autocompleteOn: boolean;
  publicStatsMinViews: number;
  stockValidDays: number;
  /** ORDER_BUYER_RECEIPTS_ENABLED: the buyer is told when an order is cancelled. */
  buyerReceiptsOn: boolean;
  /** OWNER_ORDERABILITY_PORTAL_ENABLED: the /eier portal's «Varer som kan bestilles» card (B1). */
  orderabilityPortalOn: boolean;
  /** STOCK_CHECK_EMAIL_ENABLED: the stock-check reminder e-mail (B2). */
  stockCheckEmailOn: boolean;
  /** OWNER_AUTO_UPDATES_ENABLED: auto.updates is a live choice (dev-request 2026-11-01-rfb-hold-profilen-oppdatert). */
  autoUpdatesOn?: boolean;
}

export function currentForProdusenterFacts(): ForProdusenterFacts {
  return {
    reminderHours: orderReminderHours(),
    autocancelHours: orderAutocancelHours(),
    dailyCap: orderCapNewPerDay(),
    autocompleteOn: isOrderAutocompleteEnabled(),
    publicStatsMinViews: publicStatsMinViews(),
    stockValidDays: getSupplyGraphStaleDays(),
    buyerReceiptsOn: isBuyerReceiptsEnabled(),
    orderabilityPortalOn: ownerOrderabilityPortalEnabled(),
    stockCheckEmailOn: isStockCheckEmailEnabled(),
    autoUpdatesOn: ownerAutoUpdatesEnabled(),
  };
}

const SELGER_FIND = "/selger#findSection";
const SELGER_LOGIN = "/selger#loginBanner";
const SELGER_REGISTER = "/selger";

interface Section {
  id: ForProdusenterAnchor;
  menu: string;
  title: string;
  /** Trusted HTML (our own text and links). */
  intro: string;
  /** Plain text — goes into the FAQPage JSON-LD and is rendered (escaped) from there. */
  qa: FaqPair[];
}

function esc(text: string | number): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Live entries whose effect also needs an env flag that is not on (listed as planned instead). */
function flagGatedOff(e: OwnerFeatureEntry, f: ForProdusenterFacts): boolean {
  return e.key === "products.stock_check" && !f.stockCheckEmailOn;
}

/**
 * The «Mine valg» entries an RFB owner can use today (live/beta), in registry
 * order — minus a live entry whose effect is still behind an env flag that is
 * off (products.stock_check without STOCK_CHECK_EMAIL_ENABLED).
 */
export function liveRfbOwnerChoices(facts?: ForProdusenterFacts, registry: OwnerFeatureEntry[] = OWNER_FEATURE_REGISTRY): OwnerFeatureEntry[] {
  return registry.filter((e) => e.verticals.includes("rfb") && ownerFeatureStatus(e) !== "coming_soon" && !(facts && flagGatedOff(e, facts)));
}

function levelsAnswer(lang: "no" | "en"): string {
  const parts = OWNER_LEVELS.map((l) => `«${l.label[lang]}»: ${l.description[lang]}`);
  return lang === "en"
    ? `There are two levels. ${parts.join(" ")}`
    : `Det er to nivåer. ${parts.join(" ")}`;
}

function sectionsNo(f: ForProdusenterFacts): Section[] {
  const tech = localizedPath("/teknologi", "no");
  const owners = localizedPath("/verifisert-av-eier", "no");
  const privacy = localizedPath("/personvern", "no");
  const contact = localizedPath("/kontakt", "no");
  const choices = liveRfbOwnerChoices(f)
    .map((e) => `<li><strong>${esc(e.label.no)}</strong>: ${esc(e.description.no)}</li>`).join("");
  return [
    {
      id: "oversikt", menu: "Oversikt", title: "Slik fungerer det",
      intro: `
      <p>Rett fra Bonden viser lokale matprodusenter i Norge. Folk finner deg på nettsiden, og AI-assistenter som ChatGPT og Claude finner deg når noen spør etter lokal mat.</p>
      <ol class="fp-steps">
        <li><strong>Du har en profil.</strong> Mange produsenter har allerede en profil hos oss.</li>
        <li><strong>Kunder og AI-assistenter finner deg.</strong> De ser hva du selger, og hvordan de får tak i det.</li>
        <li><strong>Du bestemmer hvor aktiv du vil være.</strong> Du kan bare være synlig, eller ta imot bestillinger.</li>
      </ol>
      <div class="fp-ctas">
        <a class="fp-btn fp-btn-primary" href="${SELGER_FIND}">Finn profilen din og ta den over</a>
        <a class="fp-btn" href="${SELGER_LOGIN}">Logg inn</a>
        <a class="fp-btn" href="${SELGER_REGISTER}">Registrer deg</a>
      </div>`,
      qa: [
        { q: "Har jeg allerede en profil?", a: "Det kan godt hende. Vi har laget profiler for mange produsenter ut fra offentlig tilgjengelige opplysninger, for eksempel nettsider og offentlige registre. Trykk «Finn profilen din og ta den over» og søk etter navnet ditt." },
        { q: "Må jeg gjøre noe?", a: "Nei. Profilen er synlig uten at du gjør noe. Tar du over profilen, kan du rette opplysningene og bestemme selv hva som skal skje." },
        { q: "Hva er forskjellen på å ta over en profil og å registrere seg?", a: "Finnes profilen din allerede, tar du den over. Finnes den ikke, kan du registrere en ny profil på samme side." },
      ],
    },
    {
      id: "synlighet", menu: "Synlighet", title: "Slik finner kundene deg",
      intro: `
      <p>Profilen din vises på rettfrabonden.com, i søket og på sidene for stedet ditt. AI-assistenter kan også lese den. De tekniske detaljene står på <a href="${tech}">Hvordan det fungerer</a>.</p>`,
      qa: [
        { q: "Hvordan finner AI-assistenter meg?", a: "Vi har åpne grensesnitt (MCP, A2A og et API) som AI-assistenter som ChatGPT og Claude kan bruke når noen spør etter lokal mat. Profilsiden har også strukturerte data som søkemotorer og AI-tjenester kan lese." },
        { q: "Vises profilen på engelsk?", a: "Ja. Profilsiden finnes også på engelsk, og beskrivelsen kan være oversatt fra norsk." },
        { q: "Kan jeg betale for å komme høyere opp?", a: "Nei. Ingen produsent betaler for plassering hos oss." },
      ],
    },
    {
      id: "eierskap", menu: "Eierskap", title: "Ta over profilen din",
      intro: `
      <p>Når du tar over profilen, bekrefter du at det er din bedrift. Da kan du rette opplysningene, og profilen får merket «Verifisert av eier». Se <a href="${owners}">produsenter som er verifisert av eier</a>.</p>`,
      qa: [
        { q: "Hvordan tar jeg over profilen?", a: "Trykk «Finn profilen din og ta den over», søk opp bedriften din og bekreft at det er din butikk. Normalt sender vi en 6-sifret kode til e-postadressen som står på profilen. Koden gjelder i 24 timer. Skriv den inn, så er du inne. Har profilen ingen e-postadresse, eller har noen allerede tatt den over, går kravet til manuell godkjenning." },
        { q: "Hva om e-postadressen på profilen er feil?", a: "Kryss av for at e-postadressen er feil eller utdatert når du ber om å ta over profilen. Da går kravet til manuell godkjenning, og vi kontakter deg på adressen du oppgir." },
        { q: "Hvordan logger jeg inn senere?", a: "Skriv inn e-postadressen din under «Logg inn», så sender vi deg en innloggingslenke. Du trenger ikke passord." },
        { q: "Hva betyr «Verifisert av eier»?", a: "Det betyr at eieren selv har tatt over profilen. Det er det eneste merket som viser at eieren selv har bekreftet profilen." },
        { q: "Hva skjer med det jeg skriver selv?", a: `Det du skriver selv, overskrives aldri.${f.autoUpdatesOn ? "" : " Finner vi ny informasjon om deg, blir den et forslag."}` },
      ],
    },
    {
      id: "mine-valg", menu: "Mine valg", title: "Dette bestemmer du selv",
      intro: `
      <p>Når du har tatt over profilen, finner du «Mine valg» i eierportalen. Der velger du hvor aktiv du vil være, og slår enkeltvalg av og på.</p>
      <p>Dette kan du velge i dag:</p>
      <ul class="fp-list">${choices}</ul>
      <p>Andre valg er planlagt. De står i boksen «Planlagt» i «Mine valg».${f.stockCheckEmailOn ? "" : " Påminnelse på e-post om å bekrefte lagerstatus er også planlagt."}</p>`,
      qa: [
        { q: "Hvilke nivåer kan jeg velge?", a: levelsAnswer("no") },
        { q: "Kan jeg ombestemme meg?", a: "Ja. Du kan bytte nivå og slå valg av og på når du vil. Bestillinger du allerede har fått, må du likevel svare på." },
        { q: "Hva betyr «Planlagt»?", a: "Det er valg vi ikke har bygget ennå. De virker ikke før de er ferdige. Trykk «Gi meg beskjed» hvis du vil vite når et valg kommer." },
        { q: "Hva betyr «Alltid» og «Låst på»?", a: "«Alltid» betyr et løfte fra Rett fra Bonden. Det gjelder hele tiden og kan ikke slås av. «Låst på» betyr at valget hører til noe du har slått på, for eksempel ordrevarsel på e-post når du tar imot bestillinger." },
      ],
    },
    {
      id: "bestillinger", menu: "Bestillinger", title: "Bestillinger og henting",
      intro: `
      <p>Tar du imot bestillinger, kan kunder bestille varer som de henter hos deg. Du får bestillingen på e-post og svarer med ett klikk.</p>
      <h3>Slik fungerer det</h3>
      <ul class="fp-list">
        <li>Kunder kan bestille på nettsiden eller gjennom en AI-assistent. De kan bare bestille varer du har merket som på lager.</li>
        <li>Du får en e-post med emnet «Ny henteordre». I e-posten bekrefter eller avslår du bestillingen. Du trenger ikke logge inn.</li>
        <li>Kunden må oppgi e-post eller telefon og godta at du får den. Kontaktinformasjonen står i e-posten.</li>
        <li>Kunden henter varene hos deg og betaler når varene hentes. Rett fra Bonden tar ikke betalt.</li>
        <li>Du kan få inntil ${esc(f.dailyCap)} bestillinger per døgn. Kommer det flere, får kunden kontaktinformasjonen din i stedet.</li>
      </ul>
      <h3>Dette må du gjøre</h3>
      <ul class="fp-list">
        <li>Ta over profilen.</li>
        <li>Slå på «Ta imot bestillinger» i «Mine valg».</li>
        <li>Merk varene som på lager ${f.orderabilityPortalOn ? "i eierportalen" : "under «Tilgjengelighet» i fanen «Produkter» når du er logget inn"}. Lagerstatusen gjelder i ${esc(f.stockValidDays)} dager. Bekreft den igjen, så kan kundene fortsatt bestille varene.</li>
        <li>Svar på hver bestilling: bekreft eller avslå.</li>
      </ul>`,
      qa: [
        { q: "Hva skjer hvis jeg ikke svarer?", a: `Du får en påminnelse etter ${f.reminderHours} timer. Er bestillingen fortsatt ubesvart etter ${f.autocancelHours} timer, blir den kansellert${f.buyerReceiptsOn ? ", og kunden får beskjed" : ""}.` },
        { q: "Hvem kan sende meg bestillinger?", a: "Kunder på nettsiden og AI-assistenter som bestiller for en kunde. Bestillinger går bare til produsenter som har tatt over profilen og slått på bestillinger. Andre produsenter vises med kontaktinformasjon, og kunden tar kontakt selv." },
        { q: "Hvordan avtales hentetiden?", a: "Kunden kan skrive et ønske i bestillingen. Du kan sette en hentetid når du bekrefter, eller avtale den med kunden. Faste hentetider er planlagt." },
        { q: "Kan jeg ta ferie fra bestillinger?", a: "Du kan slå av «Ta imot bestillinger» mens du er borte. Da får kunden kontaktinformasjonen din i stedet. Du kan også sette hele profilen på pause. En egen ferieknapp for bestillinger er planlagt." },
        { q: "Hva gjør jeg når kunden har hentet varene?", a: f.autocompleteOn
          ? "Du trenger ikke gjøre noe. Ordren avsluttes av seg selv etter henting. Vil du, kan du trykke «Hentet» på ordresiden."
          : "Trykk «Hentet» på ordresiden." },
        { q: "Hva om jeg ikke kan levere likevel?", a: "Under «Flere valg» på ordresiden kan du registrere «Kan ikke levere», «Kunden avbestilte» eller «Kunden kom ikke»." },
      ],
    },
    {
      id: "betaling", menu: "Betaling", title: "Betaling",
      intro: `
      <p>I dag betaler kunden deg når varene hentes. Rett fra Bonden tar ikke imot penger for varene.</p>`,
      qa: [
        { q: "Hvordan får jeg betalt?", a: "Kunden betaler deg ved henting, med de betalingsmåtene du tar imot." },
        { q: "Kan kunden betale på forhånd?", a: "Ikke ennå. Forhåndsbetaling med kort via Stripe er planlagt. Pengene skal da gå rett til din egen Stripe-konto, og Rett fra Bonden skal aldri holde dem. Du velger selv om du vil ta det i bruk." },
        { q: "Tar Rett fra Bonden en avgift?", a: "Nei. Rett fra Bonden tar i dag ingen avgift for bestillinger. Hvis vi vil innføre eller endre en avgift, varsler vi deg minst 30 dager før, og den gjelder bare hvis du godtar den." },
      ],
    },
    {
      id: "oppdatering", menu: "Oppdatering", title: "Produkter og oppdatering",
      intro: `
      <p>Profilen bygger på offentlige kilder og det du skriver selv. Det du skriver selv, overskrives aldri.</p>`,
      qa: [
        { q: "Hvordan legger jeg inn varene mine?", a: f.orderabilityPortalOn
          ? "Logg inn og legg inn varene i eierportalen. Der merker du dem også som på lager, så kundene kan bestille dem."
          : "Logg inn og legg inn varene i fanen «Produkter». Under «Tilgjengelighet» på samme side merker du varene som er på lager. Finner du ikke en vare der, si fra til oss, så hjelper vi deg." },
        { q: "Kan dere hente produktene fra nettsiden min?", a: "Profilen kan allerede vise produkter vi har funnet på nettsiden din. At du selv kan hente produktene fra nettsiden som forslag du godkjenner, er planlagt." },
        { q: "Oppdaterer dere profilen min automatisk?", a: `Vi sjekker jevnlig offentlige kilder for å holde profilen riktig. Det du har skrevet selv, overskrives aldri.${f.autoUpdatesOn ? "" : " Et valg for hvordan oppdateringene skal skje, er planlagt."}` },
      ],
    },
    {
      id: "statistikk", menu: "Statistikk", title: "Statistikk",
      intro: `
      <p>Når du er logget inn, ser du statistikk for profilen din under «Statistikk».</p>`,
      qa: [
        { q: "Hvilke tall ser jeg?", a: "Hvor mange som har sett profilen din, og «Med i AI-søk»: hvor mange ganger profilen var blant resultatene en AI-assistent hentet." },
        { q: "Er tallene offentlige?", a: `Profilen viser tall først når den har hatt minst ${f.publicStatsMinViews} sidevisninger fra mennesker de siste 12 månedene. Under det viser vi ingen tall. Du ser alltid dine egne tall.` },
        { q: "Kan jeg skjule tallene på profilen?", a: "Et valg for å skjule tallene er planlagt." },
        { q: "Får jeg en rapport på e-post?", a: "Ikke ennå. En rapport på e-post er planlagt." },
      ],
    },
    {
      id: "personvern", menu: "Personvern", title: "Personvern, avmelding og sletting",
      intro: `
      <p>Profilen viser opplysninger om bedriften din. Hvordan vi behandler data, står i <a href="${privacy}">personvernerklæringen</a>.</p>`,
      qa: [
        { q: "Hvilke opplysninger viser dere?", a: "Navnet på gården eller bedriften, adresse, telefon, e-post og nettsted som er publisert for bedriften, produkter, salgskanaler, åpningstider og en kort beskrivelse." },
        { q: "Kan jeg skjule telefon, e-post eller adresse?", a: "Egne valg for å skjule telefonnummer, e-post og adresse er planlagt. Til da kan du rette opplysningene i eierportalen, eller be oss om hjelp." },
        { q: "Kan jeg ta en pause?", a: "Ja. Slår du av «Profilen er synlig» i «Mine valg», er profilen borte fra søk, lister, AI-assistenter og kart. Profilsiden viser da «Midlertidig pause». Du kan slå den på igjen når du vil." },
        { q: "Kan jeg melde meg av e-post fra dere?", a: "Ja. Du kan alltid melde deg av e-post fra oss uten at profilen slettes." },
        { q: "Hvordan sletter jeg profilen?", a: "Kontakt oss, eller svar «fjern» på en e-post fra oss, så sletter vi profilen. Vi beholder noen kjennetegn i en sperreliste, slik at profilen ikke blir laget på nytt." },
      ],
    },
    {
      id: "pris", menu: "Pris", title: "Hva koster det?",
      intro: "",
      qa: [
        { q: "Hva koster det?", a: "Det koster ingenting i dag. Rett fra Bonden tar ingen avgift for profilen eller for bestillinger. Hvis vi vil innføre eller endre en avgift, varsler vi deg minst 30 dager før, og den gjelder bare hvis du godtar den." },
        { q: "Binder jeg meg til noe?", a: "Nei. Du kan slå av bestillinger når som helst, og du kan be oss slette profilen." },
      ],
    },
    {
      id: "kontakt", menu: "Kontakt", title: "Spørsmål?",
      intro: `
      <p>Lurer du på noe? Send e-post til <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>, eller gå til <a href="${contact}">kontaktsiden</a>.</p>`,
      qa: [],
    },
  ];
}

function sectionsEn(f: ForProdusenterFacts): Section[] {
  const tech = localizedPath("/teknologi", "en");
  const owners = localizedPath("/verifisert-av-eier", "en");
  const privacy = localizedPath("/personvern", "en");
  const contact = localizedPath("/kontakt", "en");
  const choices = liveRfbOwnerChoices(f)
    .map((e) => `<li><strong>${esc(e.label.en)}</strong>: ${esc(e.description.en)}</li>`).join("");
  return [
    {
      id: "oversikt", menu: "Overview", title: "How it works",
      intro: `
      <p>Rett fra Bonden shows local food producers in Norway. People find you on the website, and AI assistants such as ChatGPT and Claude find you when someone asks for local food.</p>
      <ol class="fp-steps">
        <li><strong>You have a profile.</strong> Many producers already have a profile with us.</li>
        <li><strong>Customers and AI assistants find you.</strong> They see what you sell and how to get it.</li>
        <li><strong>You decide how active you want to be.</strong> You can just be visible, or accept orders.</li>
      </ol>
      <div class="fp-ctas">
        <a class="fp-btn fp-btn-primary" href="${SELGER_FIND}">Find your profile and take it over</a>
        <a class="fp-btn" href="${SELGER_LOGIN}">Log in</a>
        <a class="fp-btn" href="${SELGER_REGISTER}">Sign up</a>
      </div>`,
      qa: [
        { q: "Do I already have a profile?", a: "Quite possibly. We have made profiles for many producers from publicly available information, such as websites and public registers. Press «Find your profile and take it over» and search for your name." },
        { q: "Do I have to do anything?", a: "No. Your profile is visible without you doing anything. If you take over the profile, you can correct the information and decide for yourself what happens." },
        { q: "What is the difference between taking over a profile and signing up?", a: "If your profile already exists, you take it over. If it does not, you can register a new profile on the same page." },
      ],
    },
    {
      id: "synlighet", menu: "Visibility", title: "How customers find you",
      intro: `
      <p>Your profile is shown on rettfrabonden.com, in search and on the pages for your area. AI assistants can read it too. The technical details are on <a href="${tech}">How it works</a>.</p>`,
      qa: [
        { q: "How do AI assistants find me?", a: "We have open interfaces (MCP, A2A and an API) that AI assistants such as ChatGPT and Claude can use when someone asks for local food. The profile page also has structured data that search engines and AI services can read." },
        { q: "Is my profile shown in English?", a: "Yes. The profile page is also available in English, and the description may be translated from Norwegian." },
        { q: "Can I pay to rank higher?", a: "No. No producer pays for placement with us." },
      ],
    },
    {
      id: "eierskap", menu: "Ownership", title: "Take over your profile",
      intro: `
      <p>When you take over your profile, you confirm that it is your business. You can then correct the information, and the profile gets the «Verified by owner» badge. See <a href="${owners}">producers verified by their owner</a>.</p>`,
      qa: [
        { q: "How do I take over my profile?", a: "Press «Find your profile and take it over», look up your business and confirm that it is yours. Normally we send a 6-digit code to the e-mail address on the profile. The code is valid for 24 hours. Enter it, and you are in. If the profile has no e-mail address, or someone has already taken it over, the request goes to manual approval." },
        { q: "What if the e-mail address on the profile is wrong?", a: "Tick the box saying the e-mail address is wrong or out of date when you ask to take over the profile. The request then goes to manual approval, and we contact you at the address you give." },
        { q: "How do I log in later?", a: "Enter your e-mail address under «Log in», and we send you a login link. You do not need a password." },
        { q: "What does «Verified by owner» mean?", a: "It means the owner has taken over the profile. It is the only badge that shows the owner has confirmed the profile." },
        { q: "What happens to what I write myself?", a: `What you write yourself is never overwritten.${f.autoUpdatesOn ? "" : " If we find new information about you, it becomes a suggestion."}` },
      ],
    },
    {
      id: "mine-valg", menu: "My choices", title: "What you decide",
      intro: `
      <p>Once you have taken over your profile, you find «Mine valg» (My choices) in the owner portal. There you choose how active you want to be, and switch individual choices on and off.</p>
      <p>Available today:</p>
      <ul class="fp-list">${choices}</ul>
      <p>Other choices are planned. They are listed in the «Planlagt» (Planned) box in «Mine valg».${f.stockCheckEmailOn ? "" : " An e-mail reminder to confirm your stock status is planned too."}</p>`,
      qa: [
        { q: "Which levels can I choose?", a: levelsAnswer("en") },
        { q: "Can I change my mind?", a: "Yes. You can change level and switch choices on and off whenever you like. Orders you have already received must still be answered." },
        { q: "What does «Planned» mean?", a: "These are choices we have not built yet. They have no effect until they are finished. Press «Gi meg beskjed» (Let me know) if you want to hear when a choice arrives." },
        { q: "What do «Always» and «Locked on» mean?", a: "«Always» means a promise from Rett fra Bonden. It applies all the time and cannot be switched off. «Locked on» means the choice belongs to something you have switched on, for example order notifications by e-mail when you accept orders." },
      ],
    },
    {
      id: "bestillinger", menu: "Orders", title: "Orders and pickup",
      intro: `
      <p>If you accept orders, customers can order goods that they pick up from you. You get the order by e-mail and answer with one click.</p>
      <h3>How it works</h3>
      <ul class="fp-list">
        <li>Customers can order on the website or through an AI assistant. They can only order goods you have marked as in stock.</li>
        <li>You get an e-mail with the subject «Ny henteordre» (new pickup order). In the e-mail you confirm or decline the order. You do not need to log in.</li>
        <li>The customer must give an e-mail address or phone number and agree that you get it. The contact details are in the e-mail.</li>
        <li>The customer picks up the goods from you and pays at pickup. Rett fra Bonden does not take payment.</li>
        <li>You can receive up to ${esc(f.dailyCap)} orders per day. If more come in, the customer gets your contact details instead.</li>
      </ul>
      <h3>What you need to do</h3>
      <ul class="fp-list">
        <li>Take over your profile.</li>
        <li>Switch on «Accept orders» in «Mine valg».</li>
        <li>Mark your goods as in stock ${f.orderabilityPortalOn ? "in the owner portal" : "under «Tilgjengelighet» (availability) in the «Produkter» (products) tab when you are logged in"}. The stock status is valid for ${esc(f.stockValidDays)} days. Confirm it again, and customers can keep ordering the goods.</li>
        <li>Answer every order: confirm or decline.</li>
      </ul>`,
      qa: [
        { q: "What happens if I do not answer?", a: `You get a reminder after ${f.reminderHours} hours. If the order is still unanswered after ${f.autocancelHours} hours, it is cancelled${f.buyerReceiptsOn ? ", and the customer is told" : ""}.` },
        { q: "Who can send me orders?", a: "Customers on the website and AI assistants ordering for a customer. Orders only go to producers who have taken over their profile and switched orders on. Other producers are shown with contact details, and the customer gets in touch directly." },
        { q: "How is the pickup time agreed?", a: "The customer can write a wish in the order. You can set a pickup time when you confirm, or agree it with the customer. Fixed pickup times are planned." },
        { q: "Can I take a holiday from orders?", a: "You can switch off «Accept orders» while you are away. The customer then gets your contact details instead. You can also pause your whole profile. A separate holiday switch for orders is planned." },
        { q: "What do I do when the customer has picked up the goods?", a: f.autocompleteOn
          ? "Nothing. The order closes by itself after pickup. If you like, you can press «Hentet» (picked up) on the order page."
          : "Press «Hentet» (picked up) on the order page." },
        { q: "What if I cannot deliver after all?", a: "Under «Flere valg» (more options) on the order page you can record «Kan ikke levere» (cannot deliver), «Kunden avbestilte» (customer cancelled) or «Kunden kom ikke» (customer did not show up)." },
      ],
    },
    {
      id: "betaling", menu: "Payment", title: "Payment",
      intro: `
      <p>Today the customer pays you when the goods are picked up. Rett fra Bonden does not receive money for the goods.</p>`,
      qa: [
        { q: "How do I get paid?", a: "The customer pays you at pickup, with the payment methods you accept." },
        { q: "Can the customer pay in advance?", a: "Not yet. Prepayment by card through Stripe is planned. The money will then go straight to your own Stripe account, and Rett fra Bonden will never hold it. You decide whether to use it." },
        { q: "Does Rett fra Bonden charge a fee?", a: "No. Rett fra Bonden charges no fee for orders today. If we want to introduce or change a fee, we will notify you at least 30 days in advance, and it only applies if you accept it." },
      ],
    },
    {
      id: "oppdatering", menu: "Updates", title: "Products and updates",
      intro: `
      <p>Your profile is built from public sources and what you write yourself. What you write yourself is never overwritten.</p>`,
      qa: [
        { q: "How do I add my goods?", a: f.orderabilityPortalOn
          ? "Log in and add your goods in the owner portal. There you also mark them as in stock, so customers can order them."
          : "Log in and add your goods in the «Produkter» (products) tab. Under «Tilgjengelighet» (availability) on the same page you mark which goods are in stock. If a product is missing there, tell us and we will help." },
        { q: "Can you fetch the products from my website?", a: "Your profile may already show products we found on your website. Fetching the products from your website yourself, as suggestions you approve, is planned." },
        { q: "Do you update my profile automatically?", a: `We regularly check public sources to keep your profile correct. What you have written yourself is never overwritten.${f.autoUpdatesOn ? "" : " A choice of how updates should happen is planned."}` },
      ],
    },
    {
      id: "statistikk", menu: "Statistics", title: "Statistics",
      intro: `
      <p>When you are logged in, you see statistics for your profile under «Statistikk» (statistics).</p>`,
      qa: [
        { q: "Which numbers do I see?", a: "How many people have seen your profile, and «Med i AI-søk» (in AI search): how many times your profile was among the results an AI assistant fetched." },
        { q: "Are the numbers public?", a: `Your profile only shows numbers once it has had at least ${f.publicStatsMinViews} page views from people in the last 12 months. Below that we show no numbers. You always see your own numbers.` },
        { q: "Can I hide the numbers on my profile?", a: "A choice to hide the numbers is planned." },
        { q: "Do I get a report by e-mail?", a: "Not yet. A report by e-mail is planned." },
      ],
    },
    {
      id: "personvern", menu: "Privacy", title: "Privacy, unsubscribing and deletion",
      intro: `
      <p>Your profile shows information about your business. How we handle data is described in the <a href="${privacy}">privacy policy</a>.</p>`,
      qa: [
        { q: "What information do you show?", a: "The name of the farm or business, the address, phone, e-mail and website published for the business, products, sales channels, opening hours and a short description." },
        { q: "Can I hide my phone, e-mail or address?", a: "Separate choices to hide your phone number, e-mail and address are planned. Until then you can correct the information in the owner portal, or ask us for help." },
        { q: "Can I take a break?", a: "Yes. If you switch off «Profilen er synlig» (profile is visible) in «Mine valg», your profile disappears from search, lists, AI assistants and maps. The profile page then shows «Midlertidig pause» (temporary pause). You can switch it back on whenever you like." },
        { q: "Can I unsubscribe from your e-mails?", a: "Yes. You can always unsubscribe from our e-mails without your profile being deleted." },
        { q: "How do I delete my profile?", a: "Contact us, or reply «fjern» (remove) to an e-mail from us, and we delete the profile. We keep a few identifiers on a block list so the profile is not created again." },
      ],
    },
    {
      id: "pris", menu: "Price", title: "What does it cost?",
      intro: "",
      qa: [
        { q: "What does it cost?", a: "It costs nothing today. Rett fra Bonden charges no fee for your profile or for orders. If we want to introduce or change a fee, we will notify you at least 30 days in advance, and it only applies if you accept it." },
        { q: "Am I tied to anything?", a: "No. You can switch off orders at any time, and you can ask us to delete your profile." },
      ],
    },
    {
      id: "kontakt", menu: "Contact", title: "Questions?",
      intro: `
      <p>Wondering about something? E-mail <a href="mailto:kontakt@rettfrabonden.com">kontakt@rettfrabonden.com</a>, or go to the <a href="${contact}">contact page</a>.</p>`,
      qa: [],
    },
  ];
}

function sectionsFor(lang: Lang, facts: ForProdusenterFacts): Section[] {
  return lang === "en" ? sectionsEn(facts) : sectionsNo(facts);
}

/** The one FAQPage node for the page: every section's Q/A, in page order. */
export function buildForProdusenterFaqLd(lang: Lang, canonicalUrl: string, facts: ForProdusenterFacts = currentForProdusenterFacts()): object {
  const pairs = sectionsFor(lang, facts).flatMap((s) => s.qa);
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${canonicalUrl}#faq`,
    url: canonicalUrl,
    inLanguage: lang === "en" ? "en" : "nb",
    mainEntity: pairs.map((p) => ({
      "@type": "Question",
      name: p.q,
      acceptedAnswer: { "@type": "Answer", text: p.a },
    })),
  };
}

/** Visible Q/A for one section; every question and answer is escaped. Exported for the escaping test. */
export function renderForProdusenterQa(pairs: FaqPair[]): string {
  if (pairs.length === 0) return "";
  return `<div class="fp-faq">${pairs.map((p) =>
    `<details class="fp-qa"><summary>${esc(p.q)}</summary><p>${esc(p.a)}</p></details>`).join("")}</div>`;
}

const MENU_JS = `
<script>
(function(){
  var menu = document.getElementById('fpMenu');
  if (!menu || !('IntersectionObserver' in window)) return;
  var links = {};
  menu.querySelectorAll('a[href^="#"]').forEach(function(a){ links[a.getAttribute('href').slice(1)] = a; });
  var current = null;
  function mark(id){
    if (id === current || !links[id]) return;
    if (current && links[current]) { links[current].classList.remove('is-current'); links[current].removeAttribute('aria-current'); }
    current = id;
    var a = links[id];
    a.classList.add('is-current');
    a.setAttribute('aria-current', 'true');
    var list = a.parentNode && a.parentNode.parentNode;
    if (list && list.scrollWidth > list.clientWidth) {
      var left = a.offsetLeft - (list.clientWidth - a.offsetWidth) / 2;
      list.scrollLeft = Math.max(0, left);
    }
  }
  var visible = {};
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){ visible[e.target.id] = e.isIntersecting; });
    var ids = Object.keys(links);
    for (var i = 0; i < ids.length; i++) { if (visible[ids[i]]) { mark(ids[i]); return; } }
  }, { rootMargin: '-120px 0px -55% 0px' });
  Object.keys(links).forEach(function(id){ var el = document.getElementById(id); if (el) io.observe(el); });
})();
</script>`;

export const FOR_PRODUSENTER_CSS = `
  .fp-hero { background: linear-gradient(135deg, var(--green-50) 0%, #f0f7f4 100%); padding: 56px 16px 40px; text-align: center; }
  .fp-hero h1 { font-size: 2.2rem; font-weight: 800; color: var(--charcoal); letter-spacing: -1px; margin: 0 auto 12px; max-width: 760px; }
  .fp-hero p { font-size: 1.05rem; color: var(--g500); max-width: 620px; margin: 0 auto; line-height: 1.7; }
  .fp-menu { position: sticky; top: 56px; z-index: 90; background: rgba(255,255,255,0.97); border-bottom: 1px solid var(--g200); max-width: 100%; }
  .fp-menu ul { list-style: none; display: flex; gap: 4px; margin: 0 auto; padding: 8px 16px; max-width: 960px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: thin; white-space: nowrap; }
  .fp-menu li { flex: 0 0 auto; }
  .fp-menu a { display: inline-block; padding: 6px 12px; border-radius: 999px; font-size: 0.85rem; font-weight: 600; color: var(--g700); text-decoration: none; }
  .fp-menu a:hover { background: var(--green-50); color: var(--green-700); text-decoration: none; }
  .fp-menu a:focus-visible { outline: 2px solid var(--green-700); outline-offset: 2px; }
  .fp-menu a.is-current { background: var(--green-700); color: var(--white); }
  .fp-main { max-width: 760px; margin: 0 auto; padding: 8px 16px 48px; }
  .fp-sec { scroll-margin-top: 120px; padding-top: 32px; }
  .fp-sec h2 { font-size: 1.5rem; font-weight: 800; color: var(--charcoal); margin-bottom: 12px; }
  .fp-sec h3 { font-size: 1.05rem; font-weight: 700; color: var(--charcoal); margin: 20px 0 8px; }
  .fp-sec p, .fp-sec li { font-size: 0.97rem; color: var(--g700); line-height: 1.75; }
  .fp-sec p { margin-bottom: 12px; }
  .fp-list, .fp-steps { margin: 8px 0 16px 22px; }
  .fp-list li, .fp-steps li { margin-bottom: 6px; }
  .fp-ctas { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 8px; }
  .fp-btn { display: inline-block; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--green-700); color: var(--green-700); font-weight: 600; font-size: 0.92rem; text-decoration: none; }
  .fp-btn:hover { background: var(--green-50); text-decoration: none; }
  .fp-btn-primary { background: var(--green-700); color: var(--white); }
  .fp-btn-primary:hover { background: var(--green-900); }
  .fp-faq { margin-top: 12px; border-top: 1px solid var(--g200); }
  .fp-qa { border-bottom: 1px solid var(--g200); }
  .fp-qa summary { cursor: pointer; padding: 14px 4px; font-weight: 700; color: var(--charcoal); font-size: 0.98rem; }
  .fp-qa summary:focus-visible { outline: 2px solid var(--green-700); outline-offset: 2px; }
  .fp-qa p { padding: 0 4px 14px; margin: 0; }
  @media (max-width: 768px) {
    .fp-hero h1 { font-size: 1.6rem; }
    .fp-sec h2 { font-size: 1.3rem; }
  }
`;

export interface ForProdusenterPage {
  title: string;
  description: string;
  content: string;
  jsonLd: object;
}

/** Pure render: the page body and its FAQPage JSON-LD (visible Q/A read back from that object). */
export function renderForProdusenterPage(lang: Lang, canonicalUrl: string, facts: ForProdusenterFacts = currentForProdusenterFacts()): ForProdusenterPage {
  const en = lang === "en";
  const sections = sectionsFor(lang, facts);
  const faqLd = buildForProdusenterFaqLd(lang, canonicalUrl, facts);
  // AC4: the visible Q/A come from the JSON-LD object itself, in order.
  const fromLd = faqPairsFromJsonLd(faqLd);
  let at = 0;
  const body = sections.map((s) => {
    const pairs = fromLd.slice(at, at + s.qa.length);
    at += s.qa.length;
    return `
    <section class="fp-sec" id="${s.id}" aria-labelledby="fp-h-${s.id}">
      <h2 id="fp-h-${s.id}">${esc(s.title)}</h2>${s.intro}
      ${renderForProdusenterQa(pairs)}
    </section>`;
  }).join("");
  const menu = `
  <nav class="fp-menu" id="fpMenu" aria-label="${en ? "Sections on this page" : "Deler av siden"}">
    <ul>${sections.map((s) => `<li><a href="#${s.id}">${esc(s.menu)}</a></li>`).join("")}</ul>
  </nav>`;
  const title = en ? "How Rett fra Bonden works for producers" : "Slik fungerer Rett fra Bonden for produsenter";
  const content = `
  <section class="fp-hero">
    <h1>${esc(title)}</h1>
    <p>${en
      ? "Your profile, ownership, your choices, orders, payment, statistics and privacy, explained for producers."
      : "Profilen din, eierskap, valgene dine, bestillinger, betaling, statistikk og personvern, forklart for produsenter."}</p>
  </section>${menu}
  <main class="fp-main">${body}
  </main>
  ${MENU_JS}`;
  return {
    title: `${title} | Rett fra Bonden`,
    description: en
      ? "How Rett fra Bonden works for food producers: take over your profile, choose how active you want to be, accept pickup orders, and what it costs."
      : "Slik fungerer Rett fra Bonden for matprodusenter: ta over profilen, velg hvor aktiv du vil være, ta imot bestillinger på henting, og hva det koster.",
    content,
    jsonLd: faqLd,
  };
}
