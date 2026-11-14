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
//   - Two levels only, «Minst mulig» and «Utnytte mulighetene» (T8)
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
//   - Flag-dependent promises follow the flag (ForProdusenterFacts, now in
//     owner-features/today-facts.ts): the automatic close only while
//     ORDER_AUTOCOMPLETE_ENABLED; «kunden får beskjed» on cancellation only
//     while ORDER_BUYER_RECEIPTS_ENABLED; the order limits follow
//     ORDER_CAP_V2_ENABLED (T11 text from order-texts.ts when on, the old
//     daily cap when off); with OWNER_AUTO_UPDATES_ENABLED (auto.updates live,
//     dev-request 2026-11-01-rfb-hold-profilen-oppdatert) the sentences that
//     call the update choice planned, or new information «a suggestion», are
//     left out (no replacement text without Daniel's approval).
//   - F2a (dev-request «Endringer fra Daniel 08.11»): «Mine valg», «Varer» in
//     the owner portal, «Kanseller bestillingen» in «Mine ordrer» (T12), the
//     stock-check e-mail and soft stock expiry each have a state
//     (for_alle / i_pilot / planlagt, today-facts.ts — the flag AND the
//     owner-features allowlist, as the code gates them). What everyone has
//     today (/selger «Produkter», «Flere valg» on the order page, the
//     «Bestillinger» card) is the main path; i_pilot is shown with the
//     «I pilot» badge and note, plus the pilot invitation (mailto with only
//     the subject) in #mine-valg and the closing box.
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
import { OWNER_FEATURE_REGISTRY, ownerFeatureEntryForEnv, ownerFeatureStatus, type OwnerFeatureEntry } from "../owner-features/registry";
import { OWNER_LEVELS } from "../owner-features/changes";
import { ownerOrderLimitLines, type OrderLimitsConfig } from "../owner-features/order-texts";
import { currentForProdusenterFacts, type ForProdusenterFacts, type PilotFeatureKey, type PilotState } from "../owner-features/today-facts";
import { FRONT_PAGE_FAQ_ANCHOR } from "./front-page-faq";

// F2a: the facts module lives in owner-features/today-facts.ts; re-exported
// so existing callers (tests, rfb-owner-refresh) keep importing it from here.
export { currentForProdusenterFacts, type ForProdusenterFacts } from "../owner-features/today-facts";

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

/**
 * Agent-card links to the FAQ pages (A2A dev-request 2026-11-06-faq-fra-
 * forsiden-begge-plattformer): {} while the flag is off, so the card is
 * unchanged; on: `x-faq` with the front-page block and this page.
 */
export function rfbAgentCardFaqLinks(baseUrl: string, env: NodeJS.ProcessEnv = process.env): { "x-faq"?: { frontPage: string; producers: string } } {
  if (!isForProdusenterPageEnabled(env)) return {};
  const base = baseUrl.replace(/\/$/, "");
  return { "x-faq": { frontPage: `${base}/#${FRONT_PAGE_FAQ_ANCHOR}`, producers: `${base}${FOR_PRODUSENTER_PATH}` } };
}

/** The anchors, in menu order. Used by «Les mer» links later — never rename after publishing. */
export const FOR_PRODUSENTER_ANCHORS = [
  "oversikt", "synlighet", "eierskap", "mine-valg", "bestillinger", "betaling",
  "oppdatering", "statistikk", "personvern", "pris", "kontakt",
] as const;
export type ForProdusenterAnchor = (typeof FOR_PRODUSENTER_ANCHORS)[number];

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

/** Live entries whose effect is still planned for everyone (listed as planned instead). */
function flagGatedOff(e: OwnerFeatureEntry, f: ForProdusenterFacts): boolean {
  return e.key === "products.stock_check" && f.pilot.lagerpaminnelse === "planlagt";
}

/**
 * The «Mine valg» entries an RFB owner can use (live/beta), in registry
 * order — minus a live entry whose effect is still planned for everyone
 * (products.stock_check while the stock-check reminder is «planlagt»).
 */
export function liveRfbOwnerChoices(facts?: ForProdusenterFacts, registry: OwnerFeatureEntry[] = OWNER_FEATURE_REGISTRY): OwnerFeatureEntry[] {
  return registry
    .filter((e) => e.verticals.includes("rfb") && ownerFeatureStatus(e) !== "coming_soon" && !(facts && flagGatedOff(e, facts)))
    // The text as it applies now (auto.guarantee follows OWNER_AUTO_UPDATES_ENABLED).
    .map((e) => ownerFeatureEntryForEnv(e));
}

// ─── F2a: «I pilot» / «planlagt» (owner-features/today-facts.ts) ───────────

const PILOT_COPY = {
  no: {
    badge: "I pilot",
    note: "Dette tester vi nå med noen få utvalgte produsenter. Det blir tilgjengelig for alle senere.",
    invite: "Vil du være med i piloten? Send oss en e-post, så tar vi kontakt. Vi tar inn noen få produsenter om gangen.",
    inviteButton: "Send oss en e-post",
  },
  en: {
    badge: "In pilot",
    note: "We are testing this now with a few selected producers. It will become available to everyone later.",
    invite: "Would you like to join the pilot? Send us an e-mail, and we will get in touch. We take in a few producers at a time.",
    inviteButton: "Send us an e-mail",
  },
} as const;

/** The pilot e-mail: only the subject «Pilot – Mine valg» in the link (no personal data). */
export const PILOT_MAILTO = `mailto:kontakt@rettfrabonden.com?subject=${encodeURIComponent("Pilot – Mine valg")}`;

interface FeatureCopy {
  /** Plain text, shown without a badge while the function is «for_alle». */
  forAlle: string;
  /** Plain text, shown with the «I pilot» badge and note. */
  pilot: string;
  /** Plain text, describes the function as planned. */
  planlagt: string;
}

/**
 * One function's block in its state: «for_alle» plain, «i_pilot» with the
 * badge and the note, «planlagt» as planned. `extra` (trusted HTML, our own
 * escaped text) goes inside the block. Every text is escaped.
 */
function featureBlock(key: PilotFeatureKey, state: PilotState, lang: "no" | "en", copy: FeatureCopy, extra = ""): string {
  if (state === "i_pilot") {
    const c = PILOT_COPY[lang];
    return `
      <div class="fp-pilot" data-feature="${key}" data-state="i_pilot">
        <p><span class="fp-badge">${esc(c.badge)}</span> ${esc(copy.pilot)}</p>${extra}
        <p class="fp-pilot-note">${esc(c.note)}</p>
      </div>`;
  }
  const text = state === "for_alle" ? copy.forAlle : copy.planlagt;
  return `
      <div class="fp-feature" data-feature="${key}" data-state="${state}"><p>${esc(text)}</p>${extra}</div>`;
}

function anyInPilot(f: ForProdusenterFacts): boolean {
  return Object.values(f.pilot).some((s) => s === "i_pilot");
}

/** The pilot invitation (#mine-valg and the closing box); only while something is «i pilot». Promises no place. */
function pilotInvite(where: "mine-valg" | "avslutning", lang: "no" | "en", f: ForProdusenterFacts): string {
  if (!anyInPilot(f)) return "";
  const c = PILOT_COPY[lang];
  return `
      <div class="fp-invite" data-pilot-invite="${where}">
        <p>${esc(c.invite)}</p>
        <a class="fp-btn" href="${esc(PILOT_MAILTO)}">${esc(c.inviteButton)}</a>
      </div>`;
}

/** T11 limit sentences in English (the NO lines come from order-texts.ts ownerOrderLimitLines). */
function orderLimitLinesEn(cfg: OrderLimitsConfig): string[] {
  return [
    "Many different customers can order from you on the same day.",
    `One customer can have at most ${cfg.openPerBuyer} unanswered orders with you at a time, and send you at most ${cfg.perBuyerPerDay} new orders per day.`,
    `If you get more than ${cfg.producerCeilingPerDay} orders in one day, we take no more for you for the rest of the day. Customers then get your contact details instead.`,
    "A day runs from midnight to midnight.",
  ];
}

/**
 * The #mine-valg Q/A in the function's state. for_alle = the approved 30.10
 * wording; i_pilot = what the pilot producers have, marked «I pilot»;
 * planlagt = described as planned (AC10: never «you can» for a pilot-only
 * function).
 */
function mineValgQa(lang: "no" | "en", state: PilotState): FaqPair[] {
  const parts = OWNER_LEVELS.map((l) => `«${l.label[lang]}»: ${l.description[lang]}`).join(" ");
  if (lang === "en") {
    if (state === "for_alle") return [
      { q: "Which levels can I choose?", a: levelsAnswer("en") },
      { q: "Can I change my mind?", a: "Yes. You can change level and switch choices on and off whenever you like. Orders you have already received must still be answered." },
      { q: "What does «Planned» mean?", a: "These are choices we have not built yet. They have no effect until they are finished. Press «Gi meg beskjed» (Let me know) if you want to hear when a choice arrives." },
      { q: "What do «Always» and «Locked on» mean?", a: "«Always» means a promise from Rett fra Bonden. It applies all the time and cannot be switched off. «Locked on» means the choice belongs to something you have switched on, for example order notifications by e-mail when you accept orders." },
    ];
    if (state === "i_pilot") return [
      { q: "Which levels are there in «Mine valg» (in pilot)?", a: `In pilot: «Mine valg» (My choices) has two levels. ${parts}` },
      { q: "Can I change my mind?", a: "Yes. You can switch orders on and off whenever you like. Orders you have already received must still be answered. In pilot: the producers in the pilot change level and switch choices on and off in «Mine valg» whenever they like." },
      { q: "What does «Planned» mean?", a: "In pilot: the «Planlagt» (Planned) box in «Mine valg» lists choices we have not built yet. They have no effect until they are finished. The producers in the pilot can press «Gi meg beskjed» (Let me know) on a choice they want." },
      { q: "What do «Always» and «Locked on» mean?", a: "In pilot: in «Mine valg», «Always» means a promise from Rett fra Bonden that applies all the time and cannot be switched off, and «Locked on» means the choice belongs to something the producer in the pilot has switched on, for example order notifications by e-mail." },
    ];
    return [
      { q: "Which levels are planned in «Mine valg»?", a: `«Mine valg» (My choices) is planned, with two levels. ${parts}` },
      { q: "Can I change my mind?", a: "Yes. You can switch orders on and off whenever you like. Orders you have already received must still be answered. Changing level and switching individual choices in «Mine valg» is planned." },
      { q: "What does «Planned» mean?", a: "Planned means something we have not built yet. It has no effect until it is finished." },
      { q: "What do «Always» and «Locked on» mean?", a: "They are labels planned for «Mine valg»: «Always» will mean a promise from Rett fra Bonden that cannot be switched off, and «Locked on» will mean the choice belongs to something you have switched on." },
    ];
  }
  if (state === "for_alle") return [
    { q: "Hvilke nivåer kan jeg velge?", a: levelsAnswer("no") },
    { q: "Kan jeg ombestemme meg?", a: "Ja. Du kan bytte nivå og slå valg av og på når du vil. Bestillinger du allerede har fått, må du likevel svare på." },
    { q: "Hva betyr «Planlagt»?", a: "Det er valg vi ikke har bygget ennå. De virker ikke før de er ferdige. Trykk «Gi meg beskjed» hvis du vil vite når et valg kommer." },
    { q: "Hva betyr «Alltid» og «Låst på»?", a: "«Alltid» betyr et løfte fra Rett fra Bonden. Det gjelder hele tiden og kan ikke slås av. «Låst på» betyr at valget hører til noe du har slått på, for eksempel ordrevarsel på e-post når du tar imot bestillinger." },
  ];
  if (state === "i_pilot") return [
    { q: "Hvilke nivåer finnes i «Mine valg» (i pilot)?", a: `I pilot: «Mine valg» har to nivåer. ${parts}` },
    { q: "Kan jeg ombestemme meg?", a: "Ja. Du kan slå bestillinger av og på når du vil. Bestillinger du allerede har fått, må du likevel svare på. I pilot: produsentene i piloten bytter nivå og slår valg av og på i «Mine valg» når de vil." },
    { q: "Hva betyr «Planlagt»?", a: "I pilot: boksen «Planlagt» i «Mine valg» viser valg vi ikke har bygget ennå. De virker ikke før de er ferdige. Produsentene i piloten kan trykke «Gi meg beskjed» på et valg de vil ha." },
    { q: "Hva betyr «Alltid» og «Låst på»?", a: "I pilot: i «Mine valg» betyr «Alltid» et løfte fra Rett fra Bonden som gjelder hele tiden og ikke kan slås av, og «Låst på» betyr at valget hører til noe produsenten i piloten har slått på, for eksempel ordrevarsel på e-post." },
  ];
  return [
    { q: "Hvilke nivåer er planlagt i «Mine valg»?", a: `«Mine valg» er planlagt, med to nivåer. ${parts}` },
    { q: "Kan jeg ombestemme meg?", a: "Ja. Du kan slå bestillinger av og på når du vil. Bestillinger du allerede har fått, må du likevel svare på. Å bytte nivå og slå enkeltvalg av og på i «Mine valg» er planlagt." },
    { q: "Hva betyr «Planlagt»?", a: "Planlagt betyr noe vi ikke har bygget ennå. Det virker ikke før det er ferdig." },
    { q: "Hva betyr «Alltid» og «Låst på»?", a: "Det er merker som er planlagt i «Mine valg»: «Alltid» skal bety et løfte fra Rett fra Bonden som ikke kan slås av, og «Låst på» skal bety at valget hører til noe du har slått på." },
  ];
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
  const p = f.pilot;
  const mineValgForAlle = p.mine_valg === "for_alle";
  const pauseForAlle = mineValgForAlle || f.ownerPauseOn;
  const choicesLead = p.mine_valg === "for_alle" ? "Dette kan du velge i dag:" : p.mine_valg === "i_pilot" ? "Dette kan produsentene i piloten velge:" : "Dette skal du kunne velge:";
  const choicesHtml = `
        <p>${esc(choicesLead)}</p>
        <ul class="fp-list">${choices}</ul>
        <p>${esc(p.mine_valg === "planlagt" ? "Andre valg er også planlagt." : "Andre valg er planlagt. De står i boksen «Planlagt» i «Mine valg».")}</p>`;
  const capLine = f.orderCapV2On
    ? ownerOrderLimitLines(f.orderLimits).join(" ")
    : `Du kan få inntil ${f.dailyCap} bestillinger per døgn. Kommer det flere, får kunden kontaktinformasjonen din i stedet.`;
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
      intro: `${mineValgForAlle ? "" : `
      <p>Når du har tatt over profilen, slår du bestillinger av og på når du er logget inn, under «Bestillinger».</p>`}${featureBlock("mine_valg", p.mine_valg, "no", {
        forAlle: "Når du har tatt over profilen, finner du «Mine valg» i eierportalen. Der velger du hvor aktiv du vil være, og slår enkeltvalg av og på.",
        pilot: "I «Mine valg» i eierportalen velger produsentene i piloten hvor aktive de vil være, og slår enkeltvalg av og på.",
        planlagt: "«Mine valg» er planlagt. Der skal du kunne velge hvor aktiv du vil være, og slå enkeltvalg av og på.",
      }, choicesHtml)}${pilotInvite("mine-valg", "no", f)}`,
      qa: [
        ...mineValgQa("no", p.mine_valg),
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
        <li>${esc(capLine)}</li>
      </ul>
      <h3>Dette må du gjøre</h3>
      <ul class="fp-list">
        <li>Ta over profilen.</li>
        <li>${mineValgForAlle ? "Slå på «Ta imot bestillinger» i «Mine valg»." : "Slå på bestillinger når du er logget inn, under «Bestillinger»."}</li>
        <li>Merk varene som på lager ${p.varer === "for_alle" ? "under «Varer» i eierportalen" : "under «Tilgjengelighet» i fanen «Produkter» når du er logget inn"}. Lagerstatusen gjelder i ${esc(f.stockValidDays)} dager. Bekreft den igjen, så kan kundene fortsatt bestille varene.</li>
        <li>Svar på hver bestilling: bekreft eller avslå.</li>
      </ul>${featureBlock("varer", p.varer, "no", {
        forAlle: "Under «Varer» i eierportalen ser du hvilke varer kundene kan bestille, og du bekrefter lagerstatusen der.",
        pilot: "Under «Varer» i eierportalen ser produsentene i piloten hvilke varer kundene kan bestille, og de bekrefter lagerstatusen der.",
        planlagt: "En egen oversikt over varene som kan bestilles, «Varer» i eierportalen, er planlagt.",
      })}${featureBlock("lagerpaminnelse", p.lagerpaminnelse, "no", {
        forAlle: "Før lagerstatusen går ut, får du en påminnelse på e-post om å bekrefte den.",
        pilot: "Produsentene i piloten får en påminnelse på e-post før lagerstatusen går ut, og kan bekrefte den fra e-posten.",
        planlagt: "Påminnelse på e-post om å bekrefte lagerstatus er planlagt.",
      })}${featureBlock("myk_utlop", p.myk_utlop, "no", {
        forAlle: `Har du ikke bekreftet lagerstatusen på ${f.stockValidDays} dager, kan kundene likevel bestille varen til det har gått ${f.stockHardDays} dager. De ser da datoen du sist bekreftet den.`,
        pilot: `Hos produsentene i piloten kan kundene bestille en vare til det har gått ${f.stockHardDays} dager siden lagerstatusen sist ble bekreftet. Kundene ser da datoen den sist ble bekreftet.`,
        planlagt: "At en vare kan bestilles en stund til etter at lagerstatusen er gått ut, med datoen du sist bekreftet den, er planlagt.",
      })}${featureBlock("kanseller", p.kanseller, "no", {
        forAlle: "Kan du ikke levere likevel, trykker du «Kanseller bestillingen» i «Mine ordrer» eller på lenken i e-posten, og velger hvorfor.",
        pilot: "Produsentene i piloten kansellerer med «Kanseller bestillingen» i «Mine ordrer» eller på lenken i e-posten, og velger hvorfor.",
        planlagt: "En egen knapp for å kansellere en bekreftet bestilling, «Kanseller bestillingen», er planlagt.",
      })}`,
      qa: [
        { q: "Hva skjer hvis jeg ikke svarer?", a: `Du får en påminnelse etter ${f.reminderHours} timer. Er bestillingen fortsatt ubesvart etter ${f.autocancelHours} timer, blir den kansellert${f.buyerReceiptsOn ? ", og kunden får beskjed" : ""}.` },
        { q: "Hvem kan sende meg bestillinger?", a: "Kunder på nettsiden og AI-assistenter som bestiller for en kunde. Bestillinger går bare til produsenter som har tatt over profilen og slått på bestillinger. Andre produsenter vises med kontaktinformasjon, og kunden tar kontakt selv." },
        { q: "Hvordan avtales hentetiden?", a: "Kunden kan skrive et ønske i bestillingen. Du kan sette en hentetid når du bekrefter, eller avtale den med kunden. Faste hentetider er planlagt." },
        { q: "Kan jeg ta ferie fra bestillinger?", a: `${mineValgForAlle ? "Du kan slå av «Ta imot bestillinger» mens du er borte." : "Du kan slå av bestillinger mens du er borte."} Da får kunden kontaktinformasjonen din i stedet.${pauseForAlle ? " Du kan også sette hele profilen på pause." : ""} En egen ferieknapp for bestillinger er planlagt.` },
        { q: "Hva gjør jeg når kunden har hentet varene?", a: f.autocompleteOn
          ? "Du trenger ikke gjøre noe. Ordren avsluttes av seg selv etter henting. Vil du, kan du trykke «Hentet» på ordresiden."
          : "Trykk «Hentet» på ordresiden." },
        { q: "Hva om jeg ikke kan levere likevel?", a: p.kanseller === "for_alle"
          ? "Trykk «Kanseller bestillingen» i «Mine ordrer» eller på lenken i e-posten, og velg hvorfor. Kom ikke kunden, trykker du «Kunden kom ikke»."
          : `Under «Flere valg» på ordresiden kan du registrere «Kan ikke levere», «Kunden avbestilte» eller «Kunden kom ikke».${p.kanseller === "i_pilot" ? " I pilot: produsentene i piloten bruker «Kanseller bestillingen» i «Mine ordrer» i stedet." : ""}` },
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
        { q: "Hvordan legger jeg inn varene mine?", a: p.varer === "for_alle"
          ? "Logg inn og legg inn varene under «Varer» i eierportalen. Der merker du dem også som på lager, så kundene kan bestille dem."
          : `Logg inn og legg inn varene i fanen «Produkter». Under «Tilgjengelighet» på samme side merker du varene som er på lager. Finner du ikke en vare der, si fra til oss, så hjelper vi deg.${p.varer === "i_pilot" ? " I pilot: produsentene i piloten gjør dette under «Varer» i eierportalen." : ""}` },
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
        { q: "Kan jeg skjule telefon, e-post eller adresse?", a: "Egne valg for å skjule telefonnummer, e-post og adresse er planlagt. Til da kan du rette opplysningene når du er logget inn, eller be oss om hjelp." },
        { q: "Kan jeg ta en pause?", a: mineValgForAlle
          ? "Ja. Slår du av «Profilen er synlig» i «Mine valg», er profilen borte fra søk, lister, AI-assistenter og kart. Profilsiden viser da «Midlertidig pause». Du kan slå den på igjen når du vil."
          : `${f.ownerPauseOn
            ? "Ja. Logg inn og sett profilen på pause under «Pause og sletting». Da er profilen borte fra søk, lister, AI-assistenter og kart, og profilsiden viser «Midlertidig pause». Du kan slå den på igjen når du vil."
            : "Kontakt oss, så hjelper vi deg."}${p.mine_valg === "i_pilot" ? " I pilot: produsentene i piloten slår av «Profilen er synlig» i «Mine valg»." : ""}` },
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
  const p = f.pilot;
  const mineValgForAlle = p.mine_valg === "for_alle";
  const pauseForAlle = mineValgForAlle || f.ownerPauseOn;
  const choicesLead = p.mine_valg === "for_alle" ? "Available today:" : p.mine_valg === "i_pilot" ? "The producers in the pilot can choose:" : "You will be able to choose:";
  const choicesHtml = `
        <p>${esc(choicesLead)}</p>
        <ul class="fp-list">${choices}</ul>
        <p>${esc(p.mine_valg === "planlagt" ? "Other choices are planned too." : "Other choices are planned. They are listed in the «Planlagt» (Planned) box in «Mine valg».")}</p>`;
  const capLine = f.orderCapV2On
    ? orderLimitLinesEn(f.orderLimits).join(" ")
    : `You can receive up to ${f.dailyCap} orders per day. If more come in, the customer gets your contact details instead.`;
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
      intro: `${mineValgForAlle ? "" : `
      <p>Once you have taken over your profile, you switch orders on and off when you are logged in, under «Bestillinger» (orders).</p>`}${featureBlock("mine_valg", p.mine_valg, "en", {
        forAlle: "Once you have taken over your profile, you find «Mine valg» (My choices) in the owner portal. There you choose how active you want to be, and switch individual choices on and off.",
        pilot: "In «Mine valg» (My choices) in the owner portal, the producers in the pilot choose how active they want to be, and switch individual choices on and off.",
        planlagt: "«Mine valg» (My choices) is planned. There you will be able to choose how active you want to be, and switch individual choices on and off.",
      }, choicesHtml)}${pilotInvite("mine-valg", "en", f)}`,
      qa: [
        ...mineValgQa("en", p.mine_valg),
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
        <li>${esc(capLine)}</li>
      </ul>
      <h3>What you need to do</h3>
      <ul class="fp-list">
        <li>Take over your profile.</li>
        <li>${mineValgForAlle ? "Switch on «Accept orders» in «Mine valg»." : "Switch orders on when you are logged in, under «Bestillinger» (orders)."}</li>
        <li>Mark your goods as in stock ${p.varer === "for_alle" ? "under «Varer» (goods) in the owner portal" : "under «Tilgjengelighet» (availability) in the «Produkter» (products) tab when you are logged in"}. The stock status is valid for ${esc(f.stockValidDays)} days. Confirm it again, and customers can keep ordering the goods.</li>
        <li>Answer every order: confirm or decline.</li>
      </ul>${featureBlock("varer", p.varer, "en", {
        forAlle: "Under «Varer» (goods) in the owner portal you see which goods customers can order, and you confirm the stock status there.",
        pilot: "Under «Varer» (goods) in the owner portal the producers in the pilot see which goods customers can order, and they confirm the stock status there.",
        planlagt: "A separate overview of the goods customers can order, «Varer» (goods) in the owner portal, is planned.",
      })}${featureBlock("lagerpaminnelse", p.lagerpaminnelse, "en", {
        forAlle: "Before the stock status runs out, you get an e-mail reminder to confirm it.",
        pilot: "The producers in the pilot get an e-mail reminder before the stock status runs out, and can confirm it from the e-mail.",
        planlagt: "An e-mail reminder to confirm your stock status is planned.",
      })}${featureBlock("myk_utlop", p.myk_utlop, "en", {
        forAlle: `If you have not confirmed the stock status for ${f.stockValidDays} days, customers can still order the item until ${f.stockHardDays} days have passed. They then see the date you last confirmed it.`,
        pilot: `For the producers in the pilot, customers can order an item until ${f.stockHardDays} days have passed since the stock status was last confirmed. Customers then see the date it was last confirmed.`,
        planlagt: "Letting an item stay orderable for a while after the stock status has run out, showing the date you last confirmed it, is planned.",
      })}${featureBlock("kanseller", p.kanseller, "en", {
        forAlle: "If you cannot deliver after all, press «Kanseller bestillingen» (cancel the order) in «Mine ordrer» (my orders) or on the link in the e-mail, and choose why.",
        pilot: "The producers in the pilot cancel with «Kanseller bestillingen» (cancel the order) in «Mine ordrer» (my orders) or on the link in the e-mail, and choose why.",
        planlagt: "A separate button to cancel a confirmed order, «Kanseller bestillingen» (cancel the order), is planned.",
      })}`,
      qa: [
        { q: "What happens if I do not answer?", a: `You get a reminder after ${f.reminderHours} hours. If the order is still unanswered after ${f.autocancelHours} hours, it is cancelled${f.buyerReceiptsOn ? ", and the customer is told" : ""}.` },
        { q: "Who can send me orders?", a: "Customers on the website and AI assistants ordering for a customer. Orders only go to producers who have taken over their profile and switched orders on. Other producers are shown with contact details, and the customer gets in touch directly." },
        { q: "How is the pickup time agreed?", a: "The customer can write a wish in the order. You can set a pickup time when you confirm, or agree it with the customer. Fixed pickup times are planned." },
        { q: "Can I take a holiday from orders?", a: `${mineValgForAlle ? "You can switch off «Accept orders» while you are away." : "You can switch orders off while you are away."} The customer then gets your contact details instead.${pauseForAlle ? " You can also pause your whole profile." : ""} A separate holiday switch for orders is planned.` },
        { q: "What do I do when the customer has picked up the goods?", a: f.autocompleteOn
          ? "Nothing. The order closes by itself after pickup. If you like, you can press «Hentet» (picked up) on the order page."
          : "Press «Hentet» (picked up) on the order page." },
        { q: "What if I cannot deliver after all?", a: p.kanseller === "for_alle"
          ? "Press «Kanseller bestillingen» (cancel the order) in «Mine ordrer» (my orders) or on the link in the e-mail, and choose why. If the customer did not show up, press «Kunden kom ikke» (customer did not show up)."
          : `Under «Flere valg» (more options) on the order page you can record «Kan ikke levere» (cannot deliver), «Kunden avbestilte» (customer cancelled) or «Kunden kom ikke» (customer did not show up).${p.kanseller === "i_pilot" ? " In pilot: the producers in the pilot use «Kanseller bestillingen» (cancel the order) in «Mine ordrer» (my orders) instead." : ""}` },
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
        { q: "How do I add my goods?", a: p.varer === "for_alle"
          ? "Log in and add your goods under «Varer» (goods) in the owner portal. There you also mark them as in stock, so customers can order them."
          : `Log in and add your goods in the «Produkter» (products) tab. Under «Tilgjengelighet» (availability) on the same page you mark which goods are in stock. If a product is missing there, tell us and we will help.${p.varer === "i_pilot" ? " In pilot: the producers in the pilot do this under «Varer» (goods) in the owner portal." : ""}` },
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
        { q: "Can I hide my phone, e-mail or address?", a: "Separate choices to hide your phone number, e-mail and address are planned. Until then you can correct the information when you are logged in, or ask us for help." },
        { q: "Can I take a break?", a: mineValgForAlle
          ? "Yes. If you switch off «Profilen er synlig» (profile is visible) in «Mine valg», your profile disappears from search, lists, AI assistants and maps. The profile page then shows «Midlertidig pause» (temporary pause). You can switch it back on whenever you like."
          : `${f.ownerPauseOn
            ? "Yes. Log in and pause your profile under «Pause og sletting» (pause and deletion). Your profile then disappears from search, lists, AI assistants and maps, and the profile page shows «Midlertidig pause» (temporary pause). You can switch it back on whenever you like."
            : "Contact us, and we will help you."}${p.mine_valg === "i_pilot" ? " In pilot: the producers in the pilot switch off «Profilen er synlig» (profile is visible) in «Mine valg»." : ""}` },
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

// F2b: the section menu follows the reader. The current section is the last
// one whose top has passed a line just under the sticky menu (measured on
// every scroll frame), so a long section stays lit for as long as it is being
// read — the old IntersectionObserver band let an earlier section win while
// «Bestillinger» filled the screen. A menu click / hash jump pins its link
// until the reader scrolls on (the last sections cannot always reach the line
// at the bottom of the page). It also keeps the current link in view inside
// the horizontally scrolling menu and sets data-fade (l / r) for the edge fade
// that shows the menu can scroll.
const MENU_JS = `
<script>
(function(){
  var menu = document.getElementById('fpMenu');
  if (!menu) return;
  var list = menu.querySelector('ul');
  var links = {}, ids = [];
  menu.querySelectorAll('a[href^="#"]').forEach(function(a){ var id = a.getAttribute('href').slice(1); if (document.getElementById(id)) { links[id] = a; ids.push(id); } });
  if (!ids.length) return;
  var current = null, pinned = null, pinnedY = null, queued = false;
  function fade(){
    var max = list.scrollWidth - list.clientWidth;
    var f = [];
    if (max > 2 && list.scrollLeft > 2) f.push('l');
    if (max > 2 && list.scrollLeft < max - 2) f.push('r');
    menu.setAttribute('data-fade', f.join(' '));
  }
  function mark(id){
    if (id === current || !links[id]) return;
    if (current && links[current]) { links[current].classList.remove('is-current'); links[current].removeAttribute('aria-current'); }
    current = id;
    var a = links[id];
    a.classList.add('is-current');
    a.setAttribute('aria-current', 'true');
    if (list.scrollWidth > list.clientWidth) {
      var left = a.offsetLeft - (list.clientWidth - a.offsetWidth) / 2;
      list.scrollLeft = Math.max(0, left);
    }
    fade();
  }
  function update(){
    queued = false;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    if (pinned) {
      if (pinnedY === null || Math.abs(y - pinnedY) < 48) { mark(pinned); return; }
      pinned = null;
    }
    var line = menu.getBoundingClientRect().bottom + 24;
    var cur = ids[0];
    for (var i = 0; i < ids.length; i++) {
      if (document.getElementById(ids[i]).getBoundingClientRect().top <= line) cur = ids[i]; else break;
    }
    mark(cur);
  }
  function queue(){ if (!queued) { queued = true; (window.requestAnimationFrame || setTimeout)(update); } }
  function pin(id){
    if (!links[id]) return;
    pinned = id; pinnedY = null; mark(id);
    setTimeout(function(){ pinnedY = window.pageYOffset || document.documentElement.scrollTop || 0; }, 150);
  }
  menu.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (a) pin(a.getAttribute('href').slice(1));
  });
  window.addEventListener('hashchange', function(){ pin(location.hash.slice(1)); });
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', function(){ fade(); queue(); });
  list.addEventListener('scroll', fade, { passive: true });
  if (location.hash && links[location.hash.slice(1)]) pin(location.hash.slice(1)); else update();
  fade();
})();
</script>`;

// F2b: the site's own palette (seo.ts :root --green-*, --g*) and its system
// font stack; light only (dark mode is out of scope for the whole site).
// Reading width ~68ch; the sticky header (56px) + section menu (~50px) are
// cleared by scroll-margin-top on every section and section heading.
export const FOR_PRODUSENTER_CSS = `
  .fp-hero { background: linear-gradient(135deg, var(--green-50) 0%, #f0f7f4 100%); padding: 56px 16px 44px; text-align: center; border-bottom: 1px solid var(--green-100); }
  .fp-hero h1 { font-size: 2.2rem; font-weight: 800; color: var(--charcoal); letter-spacing: -1px; line-height: 1.2; margin: 0 auto 12px; max-width: 760px; }
  .fp-hero p { font-size: 1.05rem; color: var(--g500); max-width: 620px; margin: 0 auto; line-height: 1.7; }
  .fp-hero-ctas { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 24px; }
  .fp-menu { position: sticky; top: 56px; z-index: 90; background: rgba(255,255,255,0.97); border-bottom: 1px solid var(--g200); max-width: 100%; }
  .fp-menu ul { list-style: none; display: flex; gap: 4px; margin: 0 auto; padding: 8px 16px; max-width: 1100px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; white-space: nowrap; }
  .fp-menu ul::-webkit-scrollbar { display: none; }
  .fp-menu::before, .fp-menu::after { content: ""; position: absolute; top: 0; bottom: 0; width: 32px; pointer-events: none; opacity: 0; transition: opacity 0.2s; }
  .fp-menu::before { left: 0; background: linear-gradient(to right, rgba(255,255,255,1), rgba(255,255,255,0)); }
  .fp-menu::after { right: 0; background: linear-gradient(to left, rgba(255,255,255,1), rgba(255,255,255,0)); }
  .fp-menu[data-fade~="l"]::before, .fp-menu[data-fade~="r"]::after { opacity: 1; }
  .fp-menu li { flex: 0 0 auto; }
  .fp-menu a { display: inline-block; padding: 6px 12px; border-radius: 999px; font-size: 0.85rem; font-weight: 600; color: var(--g700); text-decoration: none; }
  .fp-menu a:hover { background: var(--green-50); color: var(--green-700); text-decoration: none; }
  .fp-menu a:focus-visible { outline: 2px solid var(--green-700); outline-offset: 2px; }
  .fp-menu a.is-current { background: var(--green-700); color: var(--white); }
  .fp-main { max-width: calc(68ch + 32px); margin: 0 auto; padding: 8px 16px 56px; }
  .fp-sec, .fp-sec h2 { scroll-margin-top: 112px; }
  .fp-sec { padding-top: 40px; }
  .fp-sec h2 { font-size: 1.5rem; font-weight: 800; color: var(--charcoal); letter-spacing: -0.3px; margin-bottom: 12px; }
  .fp-sec h3 { font-size: 1.05rem; font-weight: 700; color: var(--charcoal); margin: 20px 0 8px; }
  .fp-sec p, .fp-sec li { font-size: 0.97rem; color: var(--g700); line-height: 1.75; }
  .fp-sec p { margin-bottom: 12px; }
  .fp-list { margin: 8px 0 16px 22px; }
  .fp-list li { margin-bottom: 6px; }
  .fp-steps { list-style: none; counter-reset: fp-step; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; margin: 20px 0; }
  .fp-steps li { counter-increment: fp-step; position: relative; margin: 0; padding: 52px 16px 16px; background: var(--white); border: 1px solid var(--g200); border-radius: var(--r-md); box-shadow: var(--shadow-sm); font-size: 0.93rem; line-height: 1.6; }
  .fp-steps li::before { content: counter(fp-step); position: absolute; top: 14px; left: 16px; width: 28px; height: 28px; border-radius: 50%; background: var(--green-100); color: var(--green-700); font-weight: 800; font-size: 0.9rem; display: flex; align-items: center; justify-content: center; }
  .fp-steps li strong { display: block; color: var(--charcoal); margin-bottom: 4px; }
  .fp-ctas { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 8px; }
  .fp-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 10px 18px; border-radius: var(--r-md); border: 1px solid var(--green-700); background: var(--white); color: var(--green-700); font-weight: 600; font-size: 0.92rem; text-decoration: none; transition: background 0.2s; }
  .fp-btn:hover { background: var(--green-50); text-decoration: none; }
  .fp-btn:focus-visible { outline: 2px solid var(--green-700); outline-offset: 2px; }
  .fp-btn-primary { background: var(--green-700); color: var(--white); font-weight: 700; }
  .fp-btn-primary:hover { background: var(--green-900); }
  .fp-faq { margin-top: 16px; border-top: 1px solid var(--g200); }
  .fp-qa { border-bottom: 1px solid var(--g200); }
  .fp-qa summary { list-style: none; position: relative; cursor: pointer; padding: 14px 40px 14px 4px; font-weight: 700; color: var(--charcoal); font-size: 0.98rem; line-height: 1.5; }
  .fp-qa summary::-webkit-details-marker { display: none; }
  .fp-qa summary::after { content: "+"; position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 26px; height: 26px; border-radius: 50%; background: var(--green-50); color: var(--green-700); font-size: 1.15rem; font-weight: 700; line-height: 26px; text-align: center; }
  .fp-qa[open] summary::after { content: "\\2212"; }
  .fp-qa summary:hover { color: var(--green-700); }
  .fp-qa summary:focus-visible { outline: 2px solid var(--green-700); outline-offset: 2px; }
  .fp-qa p { padding: 0 40px 16px 4px; margin: 0; }
  .fp-pilot { margin: 16px 0; padding: 14px 16px; border: 1px solid var(--g200); border-left: 4px solid var(--green-700); border-radius: var(--r-md); background: var(--green-50); }
  .fp-pilot p { margin-bottom: 8px; }
  .fp-pilot .fp-pilot-note { font-size: 0.9rem; color: var(--g500); margin-bottom: 0; }
  .fp-badge { display: inline-block; padding: 1px 10px; margin-right: 6px; border-radius: 999px; border: 1px solid var(--green-600); background: var(--white); color: var(--green-700); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.2px; line-height: 1.6; vertical-align: 1px; white-space: nowrap; }
  .fp-invite { margin: 16px 0; padding: 14px 16px; border: 1px dashed var(--green-600); border-radius: var(--r-md); background: var(--white); }
  .fp-invite p { margin-bottom: 10px; }
  .fp-closing { margin-top: 48px; padding: 28px 24px; border: 1px solid var(--green-100); border-radius: var(--r-lg); background: var(--green-50); text-align: center; }
  .fp-closing h2 { font-size: 1.4rem; font-weight: 800; color: var(--charcoal); margin-bottom: 4px; }
  .fp-closing .fp-ctas { justify-content: center; }
  .fp-closing .fp-invite { text-align: left; margin-bottom: 0; }
  .fp-closing .fp-invite p { font-size: 0.95rem; color: var(--g700); line-height: 1.7; }
  @media (max-width: 768px) {
    .fp-hero { padding: 40px 16px 32px; }
    .fp-hero h1 { font-size: 1.6rem; }
    .fp-sec h2 { font-size: 1.3rem; }
    .fp-closing { padding: 24px 16px; }
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
  // The closing box (F2a: take over the profile + the pilot invitation; F2b:
  // its look, plus «Logg inn» next to the take-over button as in the hero).
  const closing = `
    <aside class="fp-closing" aria-labelledby="fp-h-closing">
      <h2 id="fp-h-closing">${esc(en ? "Get started" : "Kom i gang")}</h2>
      <div class="fp-ctas">
        <a class="fp-btn fp-btn-primary" href="${SELGER_FIND}">${esc(en ? "Find your profile and take it over" : "Finn profilen din og ta den over")}</a>
        <a class="fp-btn" href="${SELGER_LOGIN}">${esc(en ? "Log in" : "Logg inn")}</a>
      </div>${pilotInvite("avslutning", en ? "en" : "no", facts)}
    </aside>`;
  const content = `
  <section class="fp-hero">
    <h1>${esc(title)}</h1>
    <p>${en
      ? "Your profile, ownership, your choices, orders, payment, statistics and privacy, explained for producers."
      : "Profilen din, eierskap, valgene dine, bestillinger, betaling, statistikk og personvern, forklart for produsenter."}</p>
    <div class="fp-hero-ctas">
      <a class="fp-btn fp-btn-primary" href="${SELGER_FIND}">${esc(en ? "Find your profile and take it over" : "Finn profilen din og ta den over")}</a>
      <a class="fp-btn" href="${SELGER_LOGIN}">${esc(en ? "Log in" : "Logg inn")}</a>
    </div>
  </section>${menu}
  <main class="fp-main">${body}${closing}
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
